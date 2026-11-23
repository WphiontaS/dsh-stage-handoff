// @ts-check
/**
 * Bounded JSONL transport for explicit pre-step diagnostics.
 *
 * This module is deliberately separate from the anchor reader. It only touches
 * the exact diagnostics file selected by the host environment, keeps the file
 * under 256 KiB, and never includes payload bodies or credentials.
 */

import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { elidePathsIn, readUtf8Bounded, redactSecrets, sameIdentity } from './util.js'

export const PRESTEP_LOG_LIMIT_BYTES = 256 * 1024

/**
 * One queue and byte counter per exact file/limit pair. DSH can mount more than
 * one plugin instance in the same process; without sharing this state, two
 * instances can independently rotate and append the same file past its limit.
 *
 * @type {Map<string, {
 *   queue: Promise<void>,
 *   knownBytes: number | undefined,
 *   lastError: string | undefined,
 *   lastNotice: string | undefined,
 *   maxBytes: number,
 * }>}
 */
const fileStates = new Map()

/**
 * 降级写入的时间戳前缀。
 *
 * `notice()` 没有清空路径（它是历史事实，不该被下一次成功覆盖掉），所以必须自带
 * 时间：否则「既有诊断文件…已重置」会在之后每次 status 里都以「最近一次」的口吻
 * 出现，而那次重置可能已经是几天前的事。
 * @returns {string}
 */
function noticeStamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

const SUMMARY_KEYS = [
  'kind',
  'phase',
  'hookCalled',
  'hasPayload',
  'hasAgent',
  'hasSession',
  'decisionKind',
  'turn',
  'step',
  'signalAborted',
  'enteredDrift',
  'driftOutcome',
  'g2Injected',
  'at',
  'marker',
  'instance',
  'pid',
  'sawOwnPreStep',
  'sawProcessPreStep',
]

/** @param {unknown} value */
function summaryValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') return value.description ?? value.toString()
  return undefined
}

/**
 * Build the smallest useful safe record when the original cannot be serialized
 * or exceeds the whole-file budget. Long strings such as an exception message
 * are deliberately omitted; shape and outcome are what diagnosis needs.
 *
 * @param {unknown} record
 * @param {{ originalBytes?: number, serializationFailed?: boolean }} details
 * @param {number} maxBytes
 * @returns {string | undefined}
 */
function boundedSummary(record, details, maxBytes) {
  let summary = /** @type {Record<string, unknown>} */ ({
    diagnosticTruncated: true,
  })
  if (details.serializationFailed === true) summary.serializationFailed = true
  if (details.originalBytes !== undefined) summary.originalBytes = details.originalBytes
  if (Buffer.byteLength(`${JSON.stringify(summary)}\n`) > maxBytes) return undefined

  if (record !== null && typeof record === 'object') {
    for (const key of SUMMARY_KEYS) {
      let value
      try {
        value = summaryValue(Reflect.get(record, key))
      } catch {
        continue
      }
      if (value === undefined) continue
      const candidate = { ...summary, [key]: value }
      if (Buffer.byteLength(`${JSON.stringify(candidate)}\n`) > maxBytes) continue
      summary = candidate
    }
  }
  return `${JSON.stringify(summary)}\n`
}

/**
 * Serialize appends and rotate the current file to `.1` before it exceeds the
 * byte budget. Diagnostic failures are recorded for `status`, not thrown into
 * the agent loop.
 *
 * @param {string} filePath Absolute diagnostics path; an empty value disables it.
 * @param {number} [maxBytes] File size before rotating the current file to `.1`.
 */
export function createBoundedJsonlWriter(
  filePath,
  maxBytes = PRESTEP_LOG_LIMIT_BYTES,
) {
  const effectiveMaxBytes =
    Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : PRESTEP_LOG_LIMIT_BYTES
  const stateKey = `${effectiveMaxBytes}\u0000${filePath}`
  let state = fileStates.get(stateKey)
  if (state === undefined) {
    state = {
      queue: Promise.resolve(),
      knownBytes: undefined,
      lastError: undefined,
      lastNotice: undefined,
      maxBytes: effectiveMaxBytes,
    }
    fileStates.set(stateKey, state)
  }

  /**
   * Return the size of a regular, single-link diagnostics file. ENOENT is the
   * only absence treated as benign; links and non-files fail closed on both
   * read and write so status cannot follow a file planted outside the intended
   * diagnostics path.
   *
   * @param {string} candidatePath
   * @returns {Promise<{size: number, ino: bigint, dev: bigint} | undefined>}
   */
  const inspectDiagnostic = async (candidatePath) => {
    let info
    try {
      // bigint 是正确性要求：NTFS 的 64 位文件索引超出 Number 的安全整数，
      // number 版 ino 会丢精度，让调用方的 `Number.isSafeInteger(ino)` 门在
      // Windows 上恒为假 —— 「检查与打开是同一个对象」的比较于是永不执行。
      info = await lstat(candidatePath, { bigint: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    if (info.isSymbolicLink()) {
      throw new Error(`诊断文件是符号链接，拒绝跟随：${candidatePath}`)
    }
    if (!info.isFile()) {
      throw new Error(`诊断路径不是普通文件，拒绝读取或写入：${candidatePath}`)
    }
    if (info.nlink > 1n) {
      throw new Error(
        `诊断文件有 ${Number(info.nlink)} 个硬链接，拒绝读取或写入：${candidatePath}`,
      )
    }
    // 把 ino/dev 一起带出去：lstat 与随后的 open 之间仍有一个窗口，
    // 只有比对「检查到的对象」与「打开到的对象」是同一个 inode 才能关掉它。
    // 该上限最多 256 KiB，Number() 转换不丢信息。
    return { size: Number(info.size), ino: info.ino, dev: info.dev }
  }

  /**
   * @param {unknown} record JSON-safe diagnostic record.
   */
/**
 * Scrubbing applied to every string before it reaches disk.
 *
 * The writer used to serialize the record verbatim. `driftDetail` carries the
 * message of whatever exception the drift check hit, so a stage without a guard
 * file wrote `... ENOENT: ... lstat 'D:\\work\\repo\\docs\\anchors\\2611..\\.anchor-guard.json'`
 * into the diagnostic file — the user's absolute workspace path, in a file
 * meant to hold booleans and counters. `SUMMARY_KEYS` (the fallback path) never
 * included `driftDetail`, which says the intent was to keep it out.
 *
 * Keep the last two segments instead of dropping the string: "which stage,
 * which file" is the diagnostic value, "which workspace" is the leak.
 *
 * The pattern itself used to live here as `/(?:[A-Za-z]:[\\/]|\/)[^\s…]+/g`.
 * Its `/` branch treated **any** slash-prefixed token as a path, so the runtime
 * marker `g2-file-probe/20261118.3` was written as `g2-file-probe<path>/20261118.3`
 * — corrupting the one field a future grep would search for. The judgement now
 * lives in `lib/util.js` (shared with the `status` output) and requires either a
 * drive/UNC prefix or a known POSIX root as the first segment.
 *
 * Credentials are scrubbed too, not just paths: an exception message can quote a
 * request body, and this file is the one the plugin owns end to end.
 *
 * @param {string} value
 * @returns {string}
 */
function scrubText(value) {
  return redactSecrets(elidePathsIn(value))
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @param {WeakSet<object>} seen - cycle guard
 * @returns {unknown}
 */
function scrubRecord(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return scrubText(value)
  if (value === null || typeof value !== 'object') return value
  // 循环引用原样返回，让 `JSON.stringify` 照旧抛出 → 上层写有界摘要。若在这里
  // 把环打断，序列化反而会成功，那条「无法序列化」的容错路径就再也不会被走到。
  if (seen.has(value)) return value
  seen.add(value)
  if (depth > 6) return value
  if (Array.isArray(value)) {
    return value
      .map((item) => scrubRecord(item, depth + 1, seen))
      .filter((item) => item !== undefined)
  }
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const scrubbed = scrubRecord(item, depth + 1, seen)
    if (scrubbed !== undefined) out[key] = scrubbed
  }
  return out
}

/**
 * @param {unknown} record JSON-safe diagnostic record.
 */
const append = (record) => {
    if (filePath.length === 0) return Promise.resolve()
    let text
    let entryBytes
    try {
      const serialized = JSON.stringify(scrubRecord(record))
      if (typeof serialized !== 'string') {
        throw new TypeError('diagnostic record did not serialize to JSON text')
      }
      text = `${serialized}\n`
      entryBytes = Buffer.byteLength(text)
    } catch (error) {
      state.lastNotice = `${noticeStamp()} 诊断记录无法序列化：${redactSecrets(elidePathsIn(error instanceof Error ? error.message : String(error)))}`
      text = boundedSummary(record, { serializationFailed: true }, state.maxBytes)
      if (text === undefined) return Promise.resolve()
      entryBytes = Buffer.byteLength(text)
    }
    if (entryBytes > state.maxBytes) {
      const originalBytes = entryBytes
      state.lastNotice = `${noticeStamp()} 诊断单条记录 ${originalBytes} 字节，超过 ${state.maxBytes} 字节上限；已写入有界摘要`
      text = boundedSummary(record, { originalBytes }, state.maxBytes)
      if (text === undefined) return Promise.resolve()
      entryBytes = Buffer.byteLength(text)
    }

    state.queue = state.queue
      .then(async () => {
        await mkdir(dirname(filePath), { recursive: true })
        // Re-check on every append instead of trusting the first one. A file
        // swapped for a link after it exists must still be refused, and an
        // externally truncated or rotated file must not leave the byte budget
        // stale (a stale budget either rotates early or writes past the limit).
        let checked = await inspectDiagnostic(filePath)
        state.knownBytes = checked?.size ?? 0
        if (state.knownBytes > state.maxBytes) {
          // A file written by an older version or another process can already
          // be oversized. Rotating it would preserve the violation in `.1`, so
          // discard this explicitly opt-in diagnostic instead.
          state.lastNotice = `${noticeStamp()} 既有诊断文件 ${state.knownBytes} 字节，超过 ${state.maxBytes} 字节上限；已重置`
          await rm(filePath, { force: true })
          state.knownBytes = 0
          checked = undefined
        }
        if (state.knownBytes + entryBytes > state.maxBytes) {
          await rm(`${filePath}.1`, { force: true })
          try {
            await rename(filePath, `${filePath}.1`)
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error
          }
          state.knownBytes = 0
          checked = undefined
        }
        // Write through one handle and re-check the opened file, so the
        // kind/link checks describe the exact file that receives the bytes
        // instead of a path that could be swapped between check and write.
        const handle = await open(filePath, 'a')
        try {
          const info = await handle.stat({ bigint: true })
          if (!info.isFile()) {
            throw new Error(`诊断路径不是普通文件，拒绝写入：${filePath}`)
          }
          if (info.nlink > 1n) {
            throw new Error(`诊断文件有 ${Number(info.nlink)} 个硬链接，拒绝写入：${filePath}`)
          }
          // lstat 与 open 之间被换成指向别处的链接时，句柄看到的会是链接目标；
          // 只有 ino/dev 相同才说明「要写的」就是「刚检查过的」那一个。
          // 两边都是 bigint，所以这条比较在 Windows/NTFS 上真的会执行。
          if (
            checked !== undefined &&
            (checked.ino !== info.ino || checked.dev !== info.dev)
          ) {
            throw new Error(`诊断文件在检查与打开之间被替换，拒绝写入：${filePath}`)
          }
          await handle.writeFile(text)
          state.knownBytes = Number(info.size) + entryBytes
          // 写成功即清掉上一次的写入失败：错误是瞬时状态，不是历史结论。
          // 不清的话 status 会永久停在「探针写入失败」，而真正有用的「最近一次
          // pre-step」行会被它一直挡住。
          state.lastError = undefined
        } finally {
          await handle.close()
        }
      })
      .catch((error) => {
        // 这条会经 `status` 回给模型（lib/index.js 的 diagnostic 段），是整条诊断
        // 链上唯一还可能含原始异常的字段 —— fs 错误里带完整路径，序列化错误可能
        // 带值本身。和 describeError 走同一道：先缩路径，再打码凭据。
        state.lastError = redactSecrets(elidePathsIn(error instanceof Error ? error.message : String(error)))
        state.knownBytes = undefined
      })
    return state.queue
  }

  /**
   * Read the newest JSONL row matching `predicate`, including the single
   * rotated archive when the current file has no match.
   *
   * @param {(row: any) => boolean} predicate
   * @returns {Promise<any | undefined>}
   */
  const readLatest = async (predicate) => {
    if (filePath.length === 0) return undefined
    await state.queue
    for (const candidatePath of [filePath, `${filePath}.1`]) {
      const checked = await inspectDiagnostic(candidatePath)
      if (checked === undefined) continue
      if (checked.size > state.maxBytes) {
        throw new Error(
          `诊断文件 ${checked.size} 字节，超过 ${state.maxBytes} 字节读取上限：${candidatePath}`,
        )
      }
      // 用已打开的句柄读取：先 stat 再按路径 readFile 会让「检查」与「使用」
      // 分属两个时刻，中间被换成符号链接就会读到根外文件（审计 P2）。
      let handle
      try {
        handle = await open(candidatePath, 'r')
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      let content
      try {
        const opened = await handle.stat({ bigint: true })
        // 句柄描述的就是将要读取的那个文件。与写入侧同一个立场：链接一律拒绝，
        // 而不是悄悄跳过 —— 否则「只读」也会变成跟随链接读到根外内容。
        if (!opened.isFile()) {
          throw new Error(`诊断文件不是普通文件，拒绝读取：${candidatePath}`)
        }
        if (opened.nlink > 1n) {
          throw new Error(
            `诊断文件有 ${Number(opened.nlink)} 个硬链接，拒绝读取或写入：${candidatePath}`,
          )
        }
        if (opened.size > BigInt(state.maxBytes)) {
          throw new Error(
            `诊断文件 ${Number(opened.size)} 字节，超过 ${state.maxBytes} 字节读取上限：${candidatePath}`,
          )
        }
        // 与写入侧同一立场：lstat 看到的与句柄打开到的必须是同一个 inode，
        // 否则中间那段时间被人把文件换成了别的（例如指向根外的链接）。
        // 比较走 `sameIdentity`（bigint 逐位），在 Windows/NTFS 上真的会执行。
        if (!sameIdentity(opened, checked)) {
          throw new Error(`诊断文件在检查与打开之间被替换，拒绝读取：${candidatePath}`)
        }
        content = await readUtf8Bounded(handle, state.maxBytes, '诊断文件')
      } finally {
        await handle.close()
      }
      const lines = content.split(/\r?\n/)
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim()
        if (line.length === 0) continue
        let row
        try {
          row = JSON.parse(line)
        } catch {
          // A torn old line must not hide an earlier complete record.
          continue
        }
        // 谓词异常必须冒出来：与「行撕裂」共用一个 catch 会把它吞成 undefined，
        // 调用方于是把「我的谓词写错了」报成「hook 从未被调用」。
        if (predicate(row)) return row
      }
    }
    return undefined
  }

  return {
    path: filePath,
    append,
    readLatest,
    /** 当前是否处于写入失败状态（成功写入后自动清空）。 */
    error: () => state.lastError,
    /** 最近一次「记录被降级写入」的事实（有界摘要/重置），不阻塞其它诊断行。 */
    notice: () => state.lastNotice,
  }
}
