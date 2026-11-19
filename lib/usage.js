// @ts-check
/**
 * 锚点目录体积统计。
 *
 * 这是本插件**唯一**读文件系统的模块，所以四条限制写在最前面：限深、限条目、
 * 限时、不跟随符号链接。任何一条触发都立刻停下并标记 `truncated`，绝不"再扫
 * 一层看看"。一个符号链接环或几十万文件的目录不应该能把插件卡死 —— 这是
 * `docs/SECURITY.md` 第 6 条攻击面的实现。
 *
 * 只读目录项与文件大小，**不读文件内容**。
 *
 * @module dsh-stage-handoff/usage
 */
import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_MAX_DEPTH = 4
export const DEFAULT_MAX_ENTRIES = 2000
export const DEFAULT_BUDGET_MS = 3000

/**
 * @typedef {object} Usage
 * @property {boolean} exists - 根路径是否存在（不存在与空目录要能区分开）
 * @property {number} files - 计入的文件数
 * @property {number} bytes - 计入的字节数
 * @property {number} entries - 实际遍历过的目录项数
 * @property {boolean} truncated - 是否因某个限制提前停下
 * @property {string} [reason] - 提前停下的原因
 * @property {number} ms - 耗时
 */

/**
 * 统计一个目录的体积。
 * @param {string} root - 绝对路径。
 * @param {{ maxDepth?: number, maxEntries?: number, budgetMs?: number }} [options] - 限制覆盖。
 * @returns {Promise<Usage>} 统计结果；根不存在时 `exists` 为 false 且计数为 0。
 */
export async function measureUsage(root, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS
  const startedAt = Date.now()

  /** @type {Usage} */
  const result = { exists: false, files: 0, bytes: 0, entries: 0, truncated: false, ms: 0 }

  try {
    const rootInfo = await lstat(root)
    if (rootInfo.isSymbolicLink()) {
      result.exists = false
      result.truncated = true
      result.reason = '根路径是符号链接，为避免跟随链接已停止'
      result.ms = Date.now() - startedAt
      return result
    }
    if (!rootInfo.isDirectory()) {
      result.exists = true
      result.truncated = true
      result.reason = '根路径不是一个目录'
      result.ms = Date.now() - startedAt
      return result
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      result.truncated = true
      result.reason = `根路径不可读（${error?.code ?? 'ERROR'}）：${error instanceof Error ? error.message : String(error)}`
    }
    result.ms = Date.now() - startedAt
    return result
  }
  result.exists = true

  /** 停下的唯一入口：设 truncated 与原因，之后所有循环都会看到。 */
  const stop = (reason) => {
    if (result.truncated) return
    result.truncated = true
    result.reason = reason
  }

  /**
   * @param {string} dir
   * @param {number} depth
   */
  async function walk(dir, depth) {
    if (result.truncated) return
    if (depth > maxDepth) {
      stop(`超过最大深度 ${maxDepth}`)
      return
    }
    if (Date.now() - startedAt >= budgetMs) {
      stop(`超过时间预算 ${budgetMs}ms`)
      return
    }

    let handle
    try {
      handle = await opendir(dir)
    } catch (error) {
      // 目录在 readdir 快照之后、opendir 之前被删掉，和上面文件那条同一个道理：
      // 它不在了就是不计入，计数依然精确。原来这里一律判 truncated，面板于是
      // 宣称「数字是下限」，而实际数字是准的 —— 与同文件对文件 ENOENT 的既定
      // 策略正好相反。
      if (error?.code === 'ENOENT') return
      stop(`子目录不可读（${error?.code ?? 'ERROR'}）：${dir}`)
      return
    }

    for await (const item of handle) {
      if (result.truncated) return
      if (Date.now() - startedAt >= budgetMs) {
        stop(`超过时间预算 ${budgetMs}ms`)
        return
      }
      result.entries += 1
      if (result.entries > maxEntries) {
        stop(`超过最大条目数 ${maxEntries}`)
        return
      }
      // 符号链接一律跳过：不跟随，避免链接环与跳出根目录。
      if (item.isSymbolicLink()) continue
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        await walk(full, depth + 1)
      } else if (item.isFile()) {
        try {
          const info = await lstat(full)
          result.files += 1
          result.bytes += info.size
        } catch (error) {
          // 文件在 lstat 之前刚被删除/轮转不是「统计不可信」，只是它不再计入。
          // 把它当成截断原因会让面板显示「统计提前停止」，而实际上数字是准的。
          if (error?.code === 'ENOENT') continue
          stop(`文件不可读（${error?.code ?? 'ERROR'}）：${full}`)
          return
        }
      }
    }
  }

  await walk(root, 0)
  result.ms = Date.now() - startedAt
  return result
}

/**
 * 人类可读的字节数。用于面板与工具输出。
 * @param {number} bytes - 字节数。
 * @returns {string} 形如 `12.3 kB`。
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  // 判断晋级要用**显示精度**上的值：1,048,570 字节除以 1024 是 1023.99…，`toFixed(1)`
  // 会把它四舍五入成「1024.0 kB」—— 数值没错，但单位本该是 MB。旧实现先判后取整，
  // 于是 1 MiB 下方那 6 个字节显示成「1024.0 kB」，MB 档同理显示「1024.0 MB」。
  while (Number(value.toFixed(1)) >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(1)} ${units[index]}`
}

/**
 * @typedef {object} SessionUsageEntry
 * @property {string} cwdKey - 工作目录键（会话存储的第一层）。
 * @property {string} sessionId - 会话 id。
 * @property {number} bytes - 该会话落盘字节数。
 * @property {number} files - 该会话的文件数。
 */

/**
 * @typedef {object} SessionUsageReport
 * @property {string} dir - 被扫描的 sessions 根目录。
 * @property {boolean} exists - 该目录是否存在。
 * @property {SessionUsageEntry[]} sessions - 各会话，按字节降序。
 * @property {number} total - 会话数。
 * @property {number} bytes - 合计字节。
 * @property {boolean} truncated - 是否因限制提前停下。
 * @property {string} [reason] - 提前停下的原因。
 * @property {number} ms - 耗时。
 */

/**
 * 统计 DSH 会话存储的占用。
 *
 * 布局是 `<dshHome>/sessions/<cwd-key>/<session-id>/session.*.jsonl*`。和
 * `measureUsage` 一样有界：最多扫 maxSessions 个会话、最多花 budgetMs 毫秒，
 * 只读文件大小不读内容，不跟随符号链接。
 * @param {string} dshHome - DSH 数据根目录（通常是 DSH_HOME）。
 * @param {{ maxSessions?: number, budgetMs?: number }} [options] - 限制覆盖。
 * @returns {Promise<SessionUsageReport>} 报告。
 */
export async function measureSessions(dshHome, options = {}) {
  const maxSessions = options.maxSessions ?? 200
  const budgetMs = options.budgetMs ?? 3000
  const startedAt = Date.now()
  const dir = join(dshHome, 'sessions')

  /** @type {SessionUsageReport} */
  const report = {
    dir,
    exists: false,
    sessions: [],
    total: 0,
    bytes: 0,
    truncated: false,
    ms: 0,
  }

  const stop = (reason) => {
    if (report.truncated) return
    report.truncated = true
    report.reason = reason
  }

  let rootHandle
  try {
    const info = await lstat(dir)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      report.exists = info.isDirectory()
      stop('sessions 根路径不是普通目录；为避免跟随链接已停止')
      report.ms = Date.now() - startedAt
      return report
    }
    rootHandle = await opendir(dir)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      stop(`sessions 根目录不可读（${error?.code ?? 'ERROR'}）：${dir}`)
    }
    report.ms = Date.now() - startedAt
    return report
  }
  report.exists = true

  outer: for await (const cwdEntry of rootHandle) {
    // 任何一条 stop() 都必须真的让扫描立刻结束：否则用户会同时看到
    // 「工作区目录不可读：X」和一大串数字，无法判断数字是否完整。
    if (report.truncated) break
    if (report.sessions.length >= maxSessions) {
      stop(`超过最大会话数 ${maxSessions}`)
      break
    }
    if (Date.now() - startedAt >= budgetMs) {
      stop(`超过时间预算 ${budgetMs}ms`)
      break
    }
    if (!cwdEntry.isDirectory() || cwdEntry.isSymbolicLink()) continue
    const cwdKey = cwdEntry.name

    let cwdHandle
    try {
      cwdHandle = await opendir(join(dir, cwdKey))
    } catch (error) {
      // 工作区目录被 DSH 的清理并发删掉：跳过它，不把整份统计标成 truncated。
      if (error?.code === 'ENOENT') continue
      stop(`工作区目录不可读（${error?.code ?? 'ERROR'}）：${cwdKey}`)
      break outer
    }

    for await (const sessionEntry of cwdHandle) {
      if (report.truncated) break outer
      if (report.sessions.length >= maxSessions) {
        stop(`超过最大会话数 ${maxSessions}`)
        break outer
      }
      if (Date.now() - startedAt >= budgetMs) {
        stop(`超过时间预算 ${budgetMs}ms`)
        break outer
      }
      if (!sessionEntry.isDirectory() || sessionEntry.isSymbolicLink()) continue
      const sessionId = sessionEntry.name

      const sessionDir = join(dir, cwdKey, sessionId)
      let sessionHandle
      try {
        sessionHandle = await opendir(sessionDir)
      } catch (error) {
        stop(`会话目录不可读（${error?.code ?? 'ERROR'}）：${cwdKey}/${sessionId}`)
        break outer
      }

      let bytes = 0
      let files = 0
      for await (const file of sessionHandle) {
        if (report.truncated) break outer
        if (Date.now() - startedAt >= budgetMs) {
          stop(`超过时间预算 ${budgetMs}ms`)
          break outer
        }
        // 只认 session.*（session.v4.jsonl.zstd 之类），其他文件不计。
        if (!file.name.startsWith('session.') || file.isSymbolicLink()) continue
        try {
          const info = await lstat(join(sessionDir, file.name))
          if (!info.isFile()) continue
          bytes += info.size
          files += 1
        } catch (error) {
          // 同 measureUsage：会话文件被轮转掉是正常现象，不该让整份统计变成「下限」。
          if (error?.code === 'ENOENT') continue
          stop(`会话文件不可读（${error?.code ?? 'ERROR'}）：${cwdKey}/${sessionId}/${file.name}`)
          break outer
        }
      }
      if (files === 0) continue

      report.sessions.push({ cwdKey, sessionId, bytes, files })
      report.total += 1
      report.bytes += bytes
    }
  }

  report.sessions.sort((a, b) => b.bytes - a.bytes)
  report.ms = Date.now() - startedAt
  return report
}
