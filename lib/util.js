// @ts-check
/**
 * 纯函数小工具。没有宿主依赖，可以单独测试。
 *
 * @module dsh-stage-handoff/util
 */

/** 提示消息里 summary 的截断长度（`form: 'notice'` 的单行摘要）。 */
export const SUMMARY_LIMIT = 160

/**
 * 单个锚点文件的安全读取上限（1 MiB）。
 *
 * 安全读层对根内任何文件都强制同一上限；`guardMaxBytes` 的默认值与它对齐，
 * 否则 guard 写入不设限、读取设限时会重现「基线写得出、读不回」的自锁。
 * 两个数字只在这里定义一次：改一处就是改全部。
 */
export const ANCHOR_FILE_MAX_BYTES = 1024 * 1024

/**
 * 判断是不是普通对象（排除 null 与数组）。
 * @param value - 任意值。
 * @returns 是否为普通对象。
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 所有面向人的数字都走这里：1032 → "1,032"。
 * @param value - 数字。
 * @returns 带千分位的字符串。
 */
export function formatCount(value) {
  // `Intl.NumberFormat('en-US').format(-0)` 是 `"-0"`，而 `formatCount(0)` 是 `"0"`。
  // 唯一的来源是 `anchorTimeZone: '-00'`（`normalizeTimeZone` 走 `-1 * 0 * 60` 得 -0）
  // 和 `keepAnchorBackups: -0`；显示成 "-0" 会让用户以为配置坏了。
  return new Intl.NumberFormat('en-US').format(Object.is(value, -0) ? 0 : value)
}

/**
 * 判断两次 stat 结果是否指向同一个文件：`ino` 与 `dev` 同时逐位相等。
 *
 * 单独抽成函数是为了让它**能被直接测试**。之前的回归测试只能扫描源码里有没有
 * `bigint: true` 字样，于是把比较改回 `Number(a) !== Number(b)` 也照样绿 —— 而那
 * 正是原始缺陷的形状：NTFS 的 inode 超过 `Number.MAX_SAFE_INTEGER`（实测
 * 10,696,049,116,493,804），`Number()` 会把相邻两个 inode 舍成同一个值，比较恒
 * 相等，于是「读到的还是刚才检查的那个文件吗」永远答「是」。
 *
 * 一律用 `BigInt` 比较：number 与 bigint 混用时 `===` 恒假（`1 === 1n` 为 false），
 * 直接比较会把「一个用 lstat、一个用 fstat」误报成文件被替换。转不成 bigint 的值
 * 一律判不等（保守方向：宁可拒绝读，也不放行来路不明的句柄）。
 *
 * @param {{ ino: number | bigint, dev: number | bigint }} left - 通常是 lstat 的结果。
 * @param {{ ino: number | bigint, dev: number | bigint }} right - 通常是 fstat 的结果。
 * @returns 是否指向同一个文件。
 */
export function sameIdentity(left, right) {
  try {
    return BigInt(left.ino) === BigInt(right.ino) && BigInt(left.dev) === BigInt(right.dev)
  } catch {
    return false
  }
}

/**
 * Read UTF-8 text from an already-open file handle without ever allocating or
 * consuming more than `maxBytes + 1` bytes. Reading `readFile()` and checking
 * the decoded length afterwards still lets a concurrently growing file exceed
 * the intended memory bound, so callers that provide a hard byte budget use
 * this helper instead.
 *
 * The caller remains responsible for checking that the handle is a regular,
 * single-link file.
 *
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {number} maxBytes
 * @param {string} label
 * @returns {Promise<string>}
 */
export async function readUtf8Bounded(handle, maxBytes, label = '文件') {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`无效的读取上限：${String(maxBytes)}`)
  }
  const buffer = Buffer.alloc(maxBytes + 1)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    )
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset > maxBytes) {
    throw new Error(`${label}超过 ${maxBytes} 字节读取上限`)
  }
  return buffer.toString('utf8', 0, offset)
}
