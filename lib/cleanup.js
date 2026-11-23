// @ts-check
/**
 * 锚点备份的可清理性判定。
 *
 * **这个模块只读，不删任何东西。** 它回答的是「哪些 parent-backup 里的旧备份
 * 已经可以被清掉」，把决定权留给人和 agent。
 *
 * 为什么刻意不提供删除：
 * 1. 删除是不可逆的，而这个插件的全部价值建立在「锚点是安全的记录」之上；
 * 2. 备份是上一个阶段的原始记录，插件没有任何办法判断它还有没有用；
 * 3. 工作区规则要求删除前必须由人确认 —— 一个按阈值自动删文件的插件会绕过这条。
 *
 * 判定条件写得很窄：只看 `parent-backup/` 下一层、只认 `anchor-*.md`、只按文件名
 * 排序、只把「最新的 N 个之外」的列为候选。`anchor.md` 与 `detail/` 永不进入候选。
 *
 * @module dsh-stage-handoff/cleanup
 */
import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'

import { elidePathsIn } from './util.js'

export const DEFAULT_KEEP_BACKUPS = 3
export const DEFAULT_MAX_ENTRIES = 2000
export const DEFAULT_BUDGET_MS = 3000

/** 只认 parent-backup 里的 `anchor-*.md`，且名字里不许出现路径分隔符。 */
const BACKUP_PATTERN = /^anchor-[\w.-]+\.md$/i
const TIMESTAMPED_BACKUP_PATTERN = /^anchor-(\d{6,14}(?:-\d{2,6})?)\.md$/i

/**
 * 数值排序键；`undefined` 表示无法解析成时间，归入 unknown。
 *
 * 先去掉连字符，再按长度解释成时间：6 位 YYMMDD（当天 00:00）、8 位 YYYYMMDD、
 * 10 位 YYMMDDHHMM（scaffold 的正式格式）、14 位 YYYYMMDDHHMMSS。**不同精度统一
 * 到 UTC 毫秒**再比较 —— 直接比字符串会让 `-` 与数字的 ICU 次序把带连字符的
 * （更新的）判成更旧，直接比数字又会让 6 位（11-30）输给 10 位（11-01）。
 * 12 位没有唯一读法（YYMMDDHHMMSS 与 YYYYMMDDHHMM 同形），归入 unknown；
 * 日历上不存在的日期同样归入 unknown。
 * @param {{ timestamp: string }} entry
 * @returns {number | undefined}
 */
function rankOf(entry) {
  const digits = entry.timestamp.replace(/-/g, '')
  if (!/^\d+$/.test(digits)) return undefined
  const part = (from, to) => Number(digits.slice(from, to))
  let year
  let month
  let day
  let hour = 0
  let minute = 0
  let second = 0
  switch (digits.length) {
    case 6:
      year = 2000 + part(0, 2)
      month = part(2, 4)
      day = part(4, 6)
      break
    case 8:
      year = part(0, 4)
      month = part(4, 6)
      day = part(6, 8)
      break
    case 10:
      year = 2000 + part(0, 2)
      month = part(2, 4)
      day = part(4, 6)
      hour = part(6, 8)
      minute = part(8, 10)
      break
    case 12:
      // 12 位**无连字符**时没有唯一读法：既可能是 YYMMDDHHMMSS，也可能是
      // YYYYMMDDHHMM。按前者解析会把 200112161458 读成 2020 年，方向虽然保守
      // （排序错），但报告会把它当作「可清理候选」；归入 unknown 更符合
      // 「证明不了就不删」。
      //
      // 但原文写成 `YYMMDD-HHMMSS` 时读法是唯一的 —— 而 2018 行恰好指示模型
      // 自己把旧锚点归档成 `parent-backup/anchor-<时间戳>.md`，格式由模型决定，
      // 这种写法在真实锚点里会出现。原来一律 return undefined，于是这类**唯一
      // 可读**的备份永远进不了候选，报告还说「命名无法按时间排序」。
      if (!/^\d{6}-\d{6}$/.test(entry.timestamp)) return undefined
      year = 2000 + part(0, 2)
      month = part(2, 4)
      day = part(4, 6)
      hour = part(6, 8)
      minute = part(8, 10)
      second = part(10, 12)
      break
    case 14:
      year = part(0, 4)
      month = part(4, 6)
      day = part(6, 8)
      hour = part(8, 10)
      minute = part(10, 12)
      second = part(12, 14)
      break
    default:
      return undefined
  }
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return undefined
  }
  // Date.UTC 会把 2 月 31 日顺延到 3 月 3 日、把非闰年的 2 月 29 日顺延到 3 月 1 日。
  // 不先按当月天数校验，一个「看起来更新」的垃圾名字就会算进 kept，把真正的
  // 上一天列成可清理候选 —— 与「只把最新的 N 个之外列为候选」正好相反。
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day > daysInMonth) return undefined
  return Date.UTC(year, month - 1, day, hour, minute, second)
}

/**
 * @typedef {object} BackupEntry
 * @property {string} name - 文件名。
 * @property {string} path - 绝对路径。
 * @property {number} bytes - 大小。
 * @property {number} mtimeMs - 修改时间。
 */

/**
 * @typedef {object} StaleReport
 * @property {string} dir - 被检查的 parent-backup 目录。
 * @property {boolean} exists - 该目录是否存在。
 * @property {number} total - 识别到的备份总数。
 * @property {BackupEntry[]} kept - 会保留的（最新的 keep 个）。
 * @property {BackupEntry[]} candidates - 可清理的（更旧的）。
 * @property {BackupEntry[]} unknown - 命名无法按时间排序的备份，永不列为候选。
 * @property {number} reclaimableBytes - 候选合计大小。
 * @property {boolean} truncated - 是否因限制或读取错误未完成。
 * @property {string} [reason] - 未完成原因。
 */

/**
 * 列出可以清理的旧备份。**不删除任何文件。**
 * @param {string} root - 锚点根目录（绝对路径）。
 * @param {{ keep?: number, maxEntries?: number, budgetMs?: number }} [options]
 * @returns {Promise<StaleReport>} 报告。
 */
export async function findStaleBackups(root, options = {}) {
  const keep = Math.max(0, Math.trunc(options.keep ?? DEFAULT_KEEP_BACKUPS))
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS
  const startedAt = Date.now()
  const dir = join(root, 'parent-backup')

  /** @type {StaleReport} */
  const report = {
    dir,
    exists: false,
    total: 0,
    kept: [],
    candidates: [],
    unknown: [],
    reclaimableBytes: 0,
    truncated: false,
  }

  let handle
  try {
    const info = await lstat(dir)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      report.exists = info.isDirectory()
      report.truncated = true
      report.reason = 'parent-backup 不是普通目录；为避免跟随链接已停止'
      return report
    }
    handle = await opendir(dir)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      report.truncated = true
      // 同 usage.js：这条 reason 回给模型，fs 错误消息里带完整路径。
      report.reason = `parent-backup 不可读（${error?.code ?? 'ERROR'}）：${elidePathsIn(error instanceof Error ? error.message : String(error))}`
    }
    return report
  }
  report.exists = true

  /** @type {(BackupEntry & { timestamp: string, recognized: boolean })[]} */
  const entries = []
  let scanned = 0
  for await (const item of handle) {
    scanned += 1
    if (scanned > maxEntries || Date.now() - startedAt >= budgetMs) {
      report.truncated = true
      report.reason =
        scanned > maxEntries
          ? `超过最大条目数 ${maxEntries}`
          : `超过时间预算 ${budgetMs}ms`
      break
    }
    if (item.isSymbolicLink() || !BACKUP_PATTERN.test(item.name)) continue
    const path = join(dir, item.name)
    try {
      const info = await lstat(path)
      if (!info.isFile()) continue
      const timestampMatch = TIMESTAMPED_BACKUP_PATTERN.exec(item.name)
      entries.push({
        name: item.name,
        path,
        bytes: info.size,
        mtimeMs: info.mtimeMs,
        timestamp: timestampMatch?.[1] ?? '',
        recognized: timestampMatch !== null,
      })
    } catch (error) {
      report.truncated = true
      report.reason ??= `备份不可读（${error?.code ?? 'ERROR'}）：${item.name}`
    }
  }

  const recognized = entries.filter((entry) => entry.recognized && rankOf(entry) !== undefined)
  const recognizedSet = new Set(recognized)
  report.unknown = entries.filter((entry) => !recognizedSet.has(entry))

  // Only names with a parseable numeric timestamp can be ordered safely.
  // 数值比较而不是 localeCompare：`'261116-0030'` 与 `'2611160030'` 在 ICU
  // 排序里 `-` 排在数字前，会把带连字符（scaffold 的正式格式）判成更旧，
  // 于是更新的备份可能被列进「可清理」。同一 parent-backup 里混用命名格式时
  // 只有 10 位 YYMMDDHHMM 能安全比较，其余一律归入 unknown、永不作为候选。
  recognized.sort((a, b) => rankOf(a) - rankOf(b) || a.name.localeCompare(b.name))

  report.total = entries.length
  report.kept = recognized.slice(Math.max(0, recognized.length - keep))
  report.candidates = recognized.slice(0, Math.max(0, recognized.length - keep))
  report.reclaimableBytes = report.candidates.reduce((sum, entry) => sum + entry.bytes, 0)
  return report
}
