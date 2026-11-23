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

/**
 * POSIX 下算作「绝对路径起点」的根目录。
 *
 * 单独抽出来是因为它曾经在两个地方各写一份、然后漂移：`ABSOLUTE_PATH` 认
 * `workspace|work|private|Applications|…` 共 16 个，而 `elidePathsIn` 那份只认
 * 8 个 —— 于是容器里 `/workspace/proj/docs/anchors/x` 被 `shortenPath` 缩略，
 * 却在 `elidePathsIn` 里**一个字都不洗**，原样进模型上下文。
 */
const POSIX_ROOTS =
  'Users|home|root|tmp|var|opt|usr|etc|mnt|media|srv|proc|sys|dev|bin|sbin|lib|lib64|boot|run|snap|private|Applications|Volumes|System|Library|workspace|work'

/**
 * 绝对路径。用于在写盘或进模型上下文之前把「哪个工作区」抹掉。
 *
 * 旧版有一条 `|/` 分支，于是任何以斜杠开头的片段都算路径 —— 实测把
 * `g2-file-probe/20261118.3` 这个版本标记洗成了 `g2-file-probe<path>/20261118.3`，
 * 而它正是排查时要 grep 的字段。所以：
 * - Windows 盘符或 UNC 开头必定算（`D:\a`、`\\server\share`）
 * - POSIX 只认已知根目录下的多段路径（`/Users/me/x`、`/home/ci/y`），
 *   单个 `/segment` 不认，`/api/foo` 这种路由也不认
 */
const ABSOLUTE_PATH = new RegExp(
  String.raw`^(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/])` + String.raw`|^/(?:${POSIX_ROOTS})/`,
)

/**
 * 把单个绝对路径缩成 `<path>/末两段`。
 *
 * 保留末两段而不是整段丢弃：「哪个阶段、哪个文件」是诊断价值所在，「哪个工作区」
 * 才是要抹掉的隐私。与 `elidePathsIn` 共用同一口径。
 *
 * @param {string} path
 * @returns {string}
 */
export function shortenPath(path) {
  const text = String(path ?? '')
  if (!ABSOLUTE_PATH.test(text)) return text
  const parts = text.split(/[\\/]+/).filter((part) => part !== '')
  if (parts.length === 0) return '<path>'
  return `<path>/${parts.slice(-2).join('/')}`
}

/**
 * 把一段文本里出现的绝对路径整体缩略（就地替换，不动其他内容）。
 *
 * **中间段允许含空格，末段不允许。** 老版本整条正则都排除空白，于是含空格的
 * 路径会在第一个空格处截断 —— 而截断发生在 `C:` 已经被替换成 `<path>` **之后**，
 * 结果是 `scandir 'C:\Users\John Doe\proj\docs\anchors\x'` 变成
 * `<path>/Users/John Doe\proj\docs\anchors\x`：盘符没了，用户名和项目名全在，
 * 看起来却像已经脱敏了。旧注释把它描述成「原样保留」，那是错的。
 *
 * 现在的规则：以分隔符结尾的段可以含空格（`Users\John Doe\proj\`），
 * 最后一段不行 —— 这样 `C:\a for details` 不会把后面整句话吞进来。
 *
 * @param {string} value
 * @returns {string}
 */
export function elidePathsIn(value) {
  const text = String(value ?? '')
  if (text.length === 0) return text
  // 段内排除引号与中文标点（路径不会含这些），中间段再额外排除反斜杠/斜杠本身。
  const inner = String.raw`[^\\/'"\u0060，,；;：:）)】\]}]+`
  const tail = String.raw`[^\\/\s'"\u0060，,；;：:）)】\]}]*`
  const pattern = new RegExp(
    String.raw`(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/]|\/(?:${POSIX_ROOTS})[\\/])` +
      String.raw`(?:${inner}[\\/])*${tail}`,
    'g',
  )
  return text.replace(pattern, (match) => shortenPath(match))
}

/**
 * 凭据脱敏。**任何**会进入宿主日志、诊断文件或模型上下文的字符串都应先过这里。
 *
 * 原来这份逻辑是 `lib/index.js` 里插件实例内的 `sanitizeDiagnosticText`，只有
 * `driftDetail` 一个出口调用 —— 于是 `status` 回吐的工具命令行
 * （`curl -H "X-Api-Key: ..." "http://internal/API?token=..."`）原样进了会话。
 *
 * 覆盖面（每条都对应一类真实形状）：`Authorization` 头、`key=value` 形式的
 * token/password/secret、`sk-*`、GitHub/Slack token、AWS access key id、
 * PEM 私钥块、裸 JWT、`*PASSWORD=`（含 `PGPASSWORD=` 这种前缀粘连）、
 * URL 内嵌口令（`scheme://user:pass@host`）。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redactSecrets(value) {
  return String(value ?? '')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|cookie)\b\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      '[REDACTED]',
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      '[REDACTED]',
    )
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED]')
    // `aws_secret_access_key = wJalr…` / `PGPASSWORD=hunter2`：关键词可能在标识符
    // **中间**，`\b(secret)\b` 因为下划线是词字符而匹配不到。所以这里两头都允许
    // 词字符。值部分排除引号：`X-Api-Key="…"` 打码后不该吞掉闭合引号。
    .replace(
      /[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]*\s*[:=]\s*[^\s,;&'"]+/gi,
      (match) => `${match.slice(0, match.search(/[:=]/))}=[REDACTED]`,
    )
    // `postgres://admin:S3cr3t@db.internal` —— 口令在 authority 段里。
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[REDACTED]@')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
}
