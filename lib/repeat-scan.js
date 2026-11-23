// 复读检测：把一段思考压成「形状」，再按 turn 判定是否退化。
//
// 为什么是「形状」而不是原文：会话事件环刻意不保留 assistant 内容
// （见 lib/index.js 的 recentFactFromEvent —— 摘要全文都只留在内存环里，
// 不落第二份磁盘副本）。收尾流程要判复读，只需要几个数字：
// 行数、语气短行数、最高行重复次数、重复字符占比、占位符堆积行数、压缩率。
// 原文在这里没有用武之地，所以这个模块既服务于磁盘日志探针，也服务于内存环，
// 两条路共用同一套阈值。
//
// 退化的三种形态：
//   A. 单块内复读 —— 一条 reasoning 里同一行反复出现（「好。好。好。…」）
//   B. 跨块碎片化 —— 同一 turn 里连续多个 reasoning 块都只有几个字的语气词
//   C. 行内重复 —— 英文常见：整段话塞在一行里，"Let me do it now." 重复十几次。
//      行级判据（A/B）对它完全失效，只有压缩率能看见。
//
// 必须排除代码行：` ``` `、`}`、`})` 在写代码的思考里天然高频。第一版没排除，
// 把一次正常 refactor 判成了复读（turn 里 ` ``` ` 重复 79 次）。

import { deflateSync } from 'node:zlib'

/** 「好。」「执行。」的长度上限。 */
export const SHORT_LINE = 4
/** 同一行出现这么多次才算重复。 */
export const MIN_LINE_REPEAT = 3
/** 碎片块：正文不到这么多字符。 */
export const FRAGMENT_CHARS = 80
/** 连续这么多个碎片块才算可疑。 */
export const FRAGMENT_RUN = 4
/** 碎片块的行数上限：`好。做。好。做。` 这种 4 行形态必须算进来。 */
export const FRAGMENT_ROWS = 6
/** 一个 turn 里语气短行至少这么多条。 */
export const FILLER_MIN = 8
/** 语气短行占非代码行的比例下限。 */
export const FILLER_RATIO = 0.15
/** 单块复读的字符占比下限。 */
export const BLOCK_REPEAT_RATIO = 0.4
/**
 * 占位符堆积：整块非空行里无实词短行的占比下限。
 *
 * 0.4 是实测值而不是拍脑袋：`session-aaa00001` turn 61 step 14 那种
 * 「做。」+「（...）」混合块量出来是 0.487，而一段真正贴了代码的思考是 0.33
 * （`}` 会重复，但旁边总有 `result.push(valueN)` 这种长行）。
 * 设成 0.8 时这条判据在 245 个真实会话里命中 0 次 —— 等于死代码。
 */
export const PLACEHOLDER_SHORT_RATIO = 0.4
/** 占位符堆积：同一短行要重复这么多次才算堆积。 */
export const PLACEHOLDER_REPEAT = 12
/**
 * 占位符行的长度上限。
 *
 * 不能复用 `SHORT_LINE`：`（...）` 是 5 个字符（两个全角括号 + 三个点），
 * 4 字的门槛会把它整个漏掉 —— 而这个形态正是模型"换符号不复读"之后的主力。
 */
export const PLACEHOLDER_LINE = 8

/**
 * 压缩率判据：deflate 后 / 原始字节，低于这个值说明整块几乎在自我重复。
 *
 * 为什么必须是它，而不是继续调行级阈值：行级判据对"交替占位符"会失真 ——
 * `session-aaa00001` turn 61 step 1 是 9,302 字符的复读块（「做。」×973 +「（...）」×604），
 * 压缩率 0.083，但 `repeatRatio` 只有 0.55，因为两种占位符互相稀释了分母。
 * deflate 自适应地找重复片段，与语言、行结构、n 值都无关。
 *
 * 实测分离度（全库 36,637 个 >=200 字符的块）：
 *   重度复读（压缩率 <=0.15）67 块 → repeatRatio p10/p50/p90 = 0.79/0.89/0.96
 *   正常块（>0.45）34,828 块       → repeatRatio p10/p50/p90 = 0.00/0.00/0.07
 * 阈值取 0.2：正常块 p01 是 0.325，留了一倍的余量。
 */
export const COMPRESS_SIGNAL = 0.2
/** 低于这个长度的块不算压缩率：deflate 的固定头部会压垮比例。 */
export const COMPRESS_MIN_CHARS = 200
/**
 * 超过这个长度只压前 N 个字符。
 *
 * 这是在买性能，不是在省内存：`shapeReasoning` 对每个 `assistant/message` 事件都会跑一次
 * （事件环在热路径上），而 65k 字符的块压一遍要 2–4 ms。16 KB 足够容纳复读的证据
 * —— 实测最大的复读块（65,928 字符）其前 16 KB 压缩率同样是 0.0x——而单次开销降到
 * 亚毫秒。压缩率本来就是"局部冗余"的度量，采样不改变判定方向。
 */
export const COMPRESS_MAX_CHARS = 16384
/** 剔除判据更严格：只把"几乎整块在重复"的块从逐字尾部里踢出去。 */
export const COMPRESS_RETAIN = 0.15

// ── 归一化压缩率（目前只支持中文） ──────────────────────────────────────────
//
// 绝对压缩率有个结构性缺陷：**它随块长度漂移**。deflate 的头部是固定开销，
// 摊到几百字符的块上会把比例整体抬高。实测（16,705 个中文块）：
//
//   长度 200-400   p50 = 0.744      长度 3200-6400  p50 = 0.519
//   长度 400-800   p50 = 0.670      长度 6400-12800 p50 = 0.482
//   长度 800-1600  p50 = 0.607
//
// 后果：一个 300 字符的真复读块测得 0.208，被 `compress <= 0.2` 判成正常；
// 而同一个判据在长块上余量很大。所以短块的漏报是结构性的，不是阈值没调好。
//
// 归一化把 "压缩率" 变成 "相对同长度正常中文文本的比值"：1.0 = 与正常持平，
// 0.3 = 只有正常的三分之一。归一化后两个群体**完全不重叠**：
//   正常块 norm p01 = 0.416（16,018 个 compress>0.45 的块里 norm<=0.3 的有 0 个）
//   重度复读块 norm p99 = 0.268
//
// **只支持中文。** 英文与混合块（CJK<0.3）的 `norm` 是 undefined，判定退回绝对
// 阈值 —— 本机 5,748 个英文块里零个重度复读，没有样本可以标定，硬套中文曲线
// 只会制造假信号。调用方看到 `lang !== 'zh'` 就应当按"归一化暂不支持"处理。
/**
 * 归一化曲线：正常中文文本压缩率的中位数 = A + B·ln(字符数)。
 *
 * 用对数而不是幂律（`a + b/len`）：独立复算（240 会话 / 41,348 块）给出的对数拟合
 * R² = 0.985，长端残差从 +0.064 降到 −0.033。实测锚点（deflate L1，中文字节）：
 *   200-400 字符 → 0.733 · 800-1600 → 0.599 · 3200-6400 → 0.514 · 6.4k-12.8k → 0.477
 *   整篇中文维基正文（259 KB）→ 0.486（同法英文 0.424）
 * 中文比英文高，但**差距主要是短块现象**：等字节长度 300 B 时高 +0.153，25 KB 时只高 +0.012。
 */
export const ZH_LOG_A = 1.2118
/** 对数曲线的斜率（负值：越长越好压）。 */
export const ZH_LOG_B = -0.0862
/** 中文块压缩率的标准差，用来把偏离度换算成 σ 分数。 */
export const ZH_SIGMA = 0.051
/**
 * 偏离度阈值：`dev = (期望压缩率 − 实测压缩率) / σ`。
 *
 * 也就是"比同长度正常中文文本还好压多少个标准差"，比裸比值更有统计含义。
 * 实测取舍（同一批复算）：`dev >= 3.5` 检测 → 正常块误报 0.91%、重度复读 100% 命中；
 * `dev >= 5` 剔除 → 误报 0.12%。
 */
export const DEV_SIGNAL = 3.5
/** 剔除用的偏离度阈值，比检测严一档。 */
export const DEV_RETAIN = 5
/** 归一化判据阈值：压缩率低于同长度正常中文文本的 30%。 */
export const NORM_SIGNAL = 0.3
/** 归一化剔除阈值：比检测略松，因为实测重度复读块 norm 的 p99 是 0.268。 */
export const NORM_RETAIN = 0.28
/** 判定"这是中文块"的 CJK 字符占比下限。 */
export const CJK_MIN_SHARE = 0.3
/**
 * 算语言占比时只看前这么多字符。
 *
 * `shapeReasoning` 在事件环热路径上（每个 assistant/message 一次），65k 字符
 * 全量遍历约 1 ms。语言占比是个稳定的宏观量，前 4 KB 与全文的判断一致。
 */
export const LANG_SAMPLE_CHARS = 4096

/**
 * 压缩率。语言无关、无需分词，对"整块都在重复"极其敏感。
 * @param {string} text - any text
 * @returns {number} compressed / raw byte length, 1 for empty input
 */
export function compressionRatio(text) {
  const bytes = Buffer.from(String(text ?? ''), 'utf8')
  if (bytes.length === 0) return 1
  return deflateSync(bytes, { level: 1 }).length / bytes.length
}

/**
 * 汉字在非空白字符里的占比。用于判断"这块是不是中文"。
 * @param {string} text - any text
 * @returns {number} share in [0, 1]
 */
export function cjkShare(text) {
  const body = String(text ?? '')
  const sample = body.length > LANG_SAMPLE_CHARS ? body.slice(0, LANG_SAMPLE_CHARS) : body
  let cjk = 0
  let total = 0
  for (const ch of sample) {
    const code = ch.codePointAt(0)
    if (code === undefined || code <= 32) continue
    total += 1
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1
  }
  return total === 0 ? 0 : cjk / total
}

/**
 * 同长度正常**中文**文本的压缩率中位数。归一化的参照系。
 * @param {number} chars - block length in characters
 * @returns {number} reference compression ratio
 */
export function referenceCompress(chars) {
  const length = typeof chars === 'number' && Number.isFinite(chars) ? chars : 0
  return ZH_LOG_A + ZH_LOG_B * Math.log(Math.max(length, 1))
}

/**
 * 偏离度：比同长度正常中文文本还好压多少个标准差。
 *
 * 这是归一化的"统计版"：比值（`normalizedCompress`）好读，σ 分数好判 ——
 * 3.5σ 和 5σ 这样的阈值有明确含义，而不是"0.28 看起来比较低"。
 * @param {number} compress - raw compression ratio
 * @param {number} chars - block length in characters
 * @returns {number} deviation in sigmas (positive = more repetitive than normal)
 */
export function compressDeviation(compress, chars) {
  return (referenceCompress(chars) - compress) / ZH_SIGMA
}

/**
 * 归一化压缩率 = 实测压缩率 / 同长度中文正常文本的中位数。
 *
 * 1.0 表示"和正常中文文本一样不必重复"，0.3 表示"只有正常水平的三分之一"。
 * @param {number} compress - raw compression ratio
 * @param {number} chars - block length in characters
 * @returns {number} normalized ratio
 */
export function normalizedCompress(compress, chars) {
  const reference = referenceCompress(chars)
  return reference <= 0 ? 1 : compress / reference
}

// ── 结尾重复：DRY 的纯文本移植 ──────────────────────────────────────────────
//
// 压缩率回答「整块有多重复」，但答不了「从哪个字开始重复、重复了多少遍」。
// 后者才是 DRY（llama.cpp 的 Don't Repeat Yourself 采样器）在做的事：它用反向
// Z-algorithm 在 O(S) 内求出"结尾这一段重复了多长"，再按
// `penalty = multiplier · base^(repeat_len − allowed_len)` 指数惩罚。
//
// 纯文本版不能惩罚 logits，但那个"结尾重复长度"本身极有价值：
//   1. 它精确到字符 —— 能把复读块的**边界**指出来；
//   2. 它只看结尾 —— 而真实的复读总是发生在生成末尾（Holtzman 的原始判据就带
//      "位于末尾"这个约束，我们的整块压缩率丢掉了它）；
//   3. 它给出"重复了几遍"这个可解释的数字，比 0.03 这种压缩率好读得多。
//
// 算法：把文本反转后跑标准 Z-array。Z[i] 是「反转串从 i 起与反转串前缀的最长公共
// 长度」，于是「原文结尾 l 个字符 == 再往前 l 个字符」等价于「反转串 Z[n−l] >= l」。
// 取满足条件的**最小** l 就是最短重复单位（最短单位给出最大重复次数）。
/** 结尾重复检测只看末尾这么多个字符，控制热路径开销。 */
export const TAIL_WINDOW = 4096
/** 重复单位的最小长度（DRY 的 allowed_length 思路：2 个字符以内不算复读）。 */
export const TAIL_MIN_PERIOD = 2
/** 至少重复这么多遍才算复读（Holtzman 判据：≥3 次）。 */
export const TAIL_MIN_REPEATS = 3
/** 指数严重度的底数。取自 DRY 的 `dry_base` 默认值 1.75。 */
export const SEVERITY_BASE = 1.75
/** 指数严重度的免罚长度（DRY 的 `dry_allowed_length` 默认 2）。 */
export const SEVERITY_ALLOWED = 2

/** 工具序列循环：周期上限（单位是「几次工具调用」）。 */
export const TOOL_LOOP_MAX_PERIOD = 4
/**
 * 工具序列循环：尾部至少要重复这么多遍。
 *
 * 取 5 而不是 `pi-loop-guard` 的 3，原因是**签名强度不同**。它的签名是
 * `工具名 + stableStringify(全部参数)`，同一签名 3 次基本就是同一个调用；
 * 本插件的事件环只保留 `files` / `commands` 两列（不留内容），于是
 * 「edit 同一个文件」这种正常的多轮修改会和真循环长得一样。
 *
 * 实测（239 个会话）：阈值 3 时命中 2.8%，样本几乎全是 `edit 同一文件 ×3`、
 * `read 同一文件 ×3` —— 那是正常推进，不是退化。提到 5 次后仍会误报的风险由
 * 「只进 status、不注入提醒」兜住：这条判据目前只供观测，不发提醒。
 */
export const TOOL_LOOP_MIN_REPEATS = 5

/**
 * 工具调用序列的尾部循环检测。
 *
 * 为什么需要：本插件原本只看 reasoning 文本。但复读有一种形态完全不写进思考 ——
 * 模型反复发**同一个工具调用**（同一文件读十遍、同一条命令跑十遍），思考内容每轮
 * 都不一样，文本判据一次都不会响。两种现成实现都把它列为独立检测器：
 * `huytd/pi-loop-guard` 的 `ToolLoopDetector`（尾部周期，minRepeats 3 / maxPeriod 4，
 * 用「工具名 + 排序后的参数」当签名），`looplens-mcp` 的 `edit_distance`（非相邻窗口
 * 的序列相似度 ≥0.85，抓 A→B→A→B 的振荡）。
 *
 * 这里取前者的严格周期版本，理由与流式守卫一致：振荡型判据在高相似度下很容易
 * 命中正常的工作节奏（改文件→跑测试→改文件→跑测试），而尾部严格周期几乎不会。
 *
 * @param {readonly string[]} items - 最近的工具调用签名，时间正序
 * @param {{maxPeriod?: number, minRepeats?: number}} [options] - overrides for tests
 * @returns {{period: number, repeats: number, cycle: string[]} | null} measurement
 */
export function trailingSequenceRepeat(items, options = {}) {
  const maxPeriod = options.maxPeriod ?? TOOL_LOOP_MAX_PERIOD
  const minRepeats = options.minRepeats ?? TOOL_LOOP_MIN_REPEATS
  const list = Array.isArray(items) ? items : []
  const n = list.length
  if (n === 0) return null
  for (let period = 1; period <= maxPeriod && period * minRepeats <= n; period += 1) {
    // 尾部是不是恰好以 period 为周期：从倒数第二个位置往回比。
    let length = period
    while (length < n && list[n - 1 - length] === list[n - 1 - length + period]) length += 1
    const repeats = Math.floor(length / period)
    if (repeats >= minRepeats) {
      return { period, repeats, cycle: list.slice(n - period) }
    }
  }
  return null
}

/**
 * 标准 Z-array。`z[i]` = s[i..] 与 s 的最长公共前缀长度（z[0] 记 0）。
 * @param {string} s - input string
 * @returns {number[]} z-array
 */
function zArray(s) {
  const n = s.length
  const z = new Array(n).fill(0)
  let left = 0
  let right = 0
  for (let i = 1; i < n; i += 1) {
    if (i < right) z[i] = Math.min(right - i, z[i - left])
    while (i + z[i] < n && s[z[i]] === s[i + z[i]]) z[i] += 1
    if (i + z[i] > right) {
      left = i
      right = i + z[i]
    }
  }
  return z
}

/**
 * 结尾重复：从末尾往前看，最短的重复单位与它重复了几遍。
 *
 * @param {string} text - reasoning body
 * @param {{window?: number, minPeriod?: number, minRepeats?: number}} [options] - overrides for tests
 * @returns {{period: number, repeats: number, span: number, sample: string} | null} null when the tail does not repeat
 */
export function trailingRepeat(text, options = {}) {
  const window = options.window ?? TAIL_WINDOW
  const minPeriod = options.minPeriod ?? TAIL_MIN_PERIOD
  const minRepeats = options.minRepeats ?? TAIL_MIN_REPEATS
  const body = String(text ?? '')
  if (body.length === 0) return null
  const tail = body.length > window ? body.slice(body.length - window) : body
  const reversed = [...tail].reverse().join('')
  const z = zArray(reversed)
  const n = reversed.length
  // 关键：反转之后，"原文结尾 period 个字符"变成了 R 的**前缀** R[0..period)，
  // 而"再往前 period 个字符"变成了 R[period..2period)。所以判据是 `z[period] >= period`，
  // 不是 `z[n-period]`。
  //
  // 这个差别在"整段都在重复"的文本上看不出来（前后缀相同，两种写法都给对），
  // 但真实场景几乎总是"一段正常内容 + 尾部开始复读" —— 那时只有 `z[period]`
  // 能看见。早期的实现写错过一次，是流式守卫的测试逼出来的。
  //
  // period 从小到大：最短的重复单位给出最大的重复次数（DRY 也取最短周期）。
  for (let period = minPeriod; period <= Math.floor(n / 2); period += 1) {
    if (z[period] < period) continue
    const unit = reversed.slice(0, period)
    // 数一数从尾部连续重复了几遍（在反转串里就是从头部往后吃）
    let repeats = 2
    while ((repeats + 1) * period <= n) {
      const next = reversed.slice(repeats * period, (repeats + 1) * period)
      if (next !== unit) break
      repeats += 1
    }
    if (repeats < minRepeats) continue
    return {
      period,
      repeats,
      span: period * repeats,
      // 只留重复单位本身当证据，不复制整段复读原文
      sample: [...unit].reverse().join(''),
    }
  }
  return null
}

/**
 * 指数严重度：重复得越多，分数增长得越快（DRY 的惩罚形式）。
 *
 * `severity = base^(repeats − allowed)`，base 1.75、allowed 2：
 *   重复 2 遍 → 1.00（免罚线）
 *   重复 3 遍 → 1.75
 *   重复 5 遍 → 5.36
 *   重复 10 遍 → 42.2
 * 用函数代替"再多就算严重"的常数阈值，是 DRY 比"固定 penalty"高明的地方：
 * 它天然把"重复 3 遍"和"重复 3000 遍"拉开数量级，而不是同样记一笔。
 *
 * @param {number} repeats - how many times the unit repeats
 * @param {number} [base] - growth base
 * @param {number} [allowed] - repeats tolerated for free
 * @returns {number} severity score (>= 0)
 */
export function repeatSeverity(repeats, base = SEVERITY_BASE, allowed = SEVERITY_ALLOWED) {
  const count = typeof repeats === 'number' && Number.isFinite(repeats) ? repeats : 0
  // 指数必须钳住：llama.cpp 用 `88.72 / ln(base)` 封顶（让 e^88.72 落在 float64
  // 的安全范围内），否则「做。」×100 会给出 6.6e23 这种没法比较也没法读的数。
  // 钳制的代价是「重复 100 遍」与「重复 160 遍」同分 —— 到这个量级都一样该停。
  const cap = 88.72 / Math.log(base)
  return Math.pow(base, Math.min(Math.max(0, count - allowed), cap))
}

/**
 * 把严重度分档（供提醒文案使用，不再对外暴露裸指数）。
 * @param {number} severity - value from repeatSeverity
 * @returns {'轻微' | '中度' | '严重'} tier
 */
export function severityTier(severity) {
  const value = typeof severity === 'number' && Number.isFinite(severity) ? severity : 0
  if (value >= 20) return '严重'
  if (value >= 3) return '中度'
  return '轻微'
}

const CODEISH = /[`{}()[\];=<>|\\]|^\s*[-*+]\s|^\s*#|^\s*\d+[.)]\s/
/** 有实词（字母或汉字）吗。语气词与纯标点占位符的分界线就是它。 */
const WORDY = /[A-Za-z\u4e00-\u9fa5]/

/**
 * 裸代码关键字：整行就是这个词，没有别的。
 *
 * `CODEISH` 是**逐行标点正则**，只认特定符号，所以 `return`、`pass`、`fi` 这种
 * 「一个词自成一行」的代码会原样通过 —— 它们既不含 `{}()[];=<>|\` 也不含列表标记。
 * 校准行级阈值时这一点直接造成了误报：`return` 在一个 14 行的短窗口里重复 8 次就被
 * 算成「语气短行复读」（见 `STREAM_LINE_MIN_ROWS`）。
 *
 * 只匹配**整行**（`^...$`），所以「剩下的 return 语句已经改掉了」不受影响。
 * 语气短行（`好。`、`做。`、`Go.`）也不在其中。
 */
const BARE_KEYWORD =
  /^(?:return|pass|break|continue|yield|await|else|try|except|finally|raise|import|from|export|default|const|let|var|def|class|lambda|function|end|endif|fi|done|esac|then|do)$/i

/**
 * 引号包裹的代码字面量：`''`、`'',`、`'a'`、`", "`。
 *
 * `CODEISH` 的字符类里没有单双引号，所以这些行原本会原样进入散文行集合并参与行级
 * 复读统计（真实误报：`'',` 在 38 行窗口里重复 20 次）。只匹配「整行被引号包住」，
 * 带说明文字的行（`剩下的 return 语句...`）与中文引号「」不受影响。
 */
const QUOTED_LITERAL = /^['"][^'"]*['"]\s*[,;]?$/

/**
 * Markdown 分隔线：整行只有同一类符号，三个以上（`---`、`***`、`___`、`===`）。
 *
 * `CODEISH` 的列表标记分支要求符号后面有空格（`^\s*[-*+]\s`），所以 `---` 这种
 * 纯符号行会原样通过。测量工具参数复读时它是最主要的误报来源：`---` 在
 * `write.content` 里是表格分隔线，重复十几次完全正常（真实样本里 23 个命中
 * 全部是这类，`---` 占了大半）。
 */
const RULE_LINE = /^(?:-{3,}|\*{3,}|_{3,}|={3,})$/

/**
 * 是代码/结构行而不是语气词。
 * @param {string} line - one trimmed line
 * @returns {boolean} true when the line looks like code or list markup
 */
export const isCodeish = (line) =>
  CODEISH.test(line) || BARE_KEYWORD.test(line) || QUOTED_LITERAL.test(line) || RULE_LINE.test(line)

/**
 * 语气短行：短、非代码，而且**得有实词**。
 * 只按长度判会把 `...`、`———` 这类纯标点算成语气词（真实误报：某会话的
 * turn 里 `...` 出现 8 次就被当成了复读信号）。
 * @param {string} line - one trimmed line
 * @returns {boolean} true when the line reads as filler
 */
export const isFiller = (line) =>
  line.length > 0 && line.length <= SHORT_LINE && !isCodeish(line) && WORDY.test(line)

/**
 * Split one reasoning text into trimmed non-empty rows.
 * @param {string} text - reasoning body
 * @returns {string[]} rows
 */
export const splitRows = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

/**
 * 一行是不是围栏标记，以及它的三个必要属性。
 *
 * 只比首字符是不够的。`char` 之外还要 `length` 与 `info`：外层 ```` 里嵌一层 ``` 时，
 * 只比字符会让内层提前「闭合」外层，其后整段代码又被当围栏外内容；反过来，
 * `` ```js `` 这种带 info string 的行在围栏内会被当成合法闭合标记。两者都是实测到的
 * 误判方向（20 行代码因此被判成「单块复读 93%」）。
 *
 * @param {string} line - 已 trim 的行。
 * @returns {{char: string, length: number, info: string} | undefined}
 */
function fenceLine(line) {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(line)
  if (match === null) return undefined
  return { char: match[1][0], length: match[1].length, info: match[2].trim() }
}

/**
 * 闭围栏：同字符、不短于开启它的那个、且不带 info string。
 * @param {{char: string, length: number}} open - 开启标记
 * @param {{char: string, length: number, info: string}} marker - 候选闭合标记
 * @returns {boolean} 是否闭合
 */
function closesFence(open, marker) {
  return marker.char === open.char && marker.length >= open.length && marker.info === ''
}

/**
 * 起点未知时，判断第一个围栏标记是「开」还是「闭」。
 *
 * 流式守卫拿到的是 `slice(-4096)` 的后缀，窗口起点可能落在围栏**内部**。那时窗口里
 * 唯一的标记是「闭」，按「第一个就是开」处理会把它当开，于是其后所有散文行被吞掉，
 * 行级判据一声不响地失效 —— 实测 140 行真实复读被判成 0 行、`peek()` 返回 null。
 *
 * 判据：第一个标记之后若存在一个能**合法闭合**它的标记，它就是开；否则只能当闭。
 * 判反的代价不对称：把开当闭只是少报（尾巴上未闭合的代码块不参与行级判据），
 * 把闭当开会整段漏报。本仓库既定的取舍是「误报代价高于漏报」，所以选少报。
 *
 * @param {(ReturnType<typeof fenceLine>)[]} markers - 每行的围栏标记（非围栏行为 undefined）
 * @returns {boolean} 起点是否已在围栏内
 */
function startsInsideFence(markers) {
  const first = markers.findIndex((marker) => marker !== undefined)
  if (first < 0) return false
  const head = markers[first]
  if (head === undefined) return false
  for (let index = first + 1; index < markers.length; index += 1) {
    const marker = markers[index]
    if (marker === undefined) continue
    if (closesFence(head, marker)) return false
  }
  return true
}

/**
 * 逐行产出「围栏外、非空」的行（已 trim）。
 *
 * 两处围栏逻辑（`proseRows` 与 `placeholderShape`）共用这一份，此前是复制粘贴，
 * 于是同一个「只比首字符」的缺陷要修两遍、也容易只修一处。
 *
 * `fenceState` 两种取值：
 * - `'outside'`（默认）— 调用方拿到的是完整文本或一整块 reasoning，第一行必定在围栏外。
 *   整块判据（`shapeReasoning` / `placeholderShape`）用它。
 * - `'unknown'` — 调用方拿到的是被 `slice()` 截出来的窗口，起点可能在围栏内部，见
 *   `startsInsideFence`。流式守卫用它。
 *
 * @param {string} text
 * @param {'outside' | 'unknown'} fenceState
 * @returns {Generator<string, void, undefined>} 围栏外的行
 */
function* unfencedLines(text, fenceState) {
  const lines = String(text ?? '').split('\n')
  const markers = lines.map((raw) => fenceLine(raw.trim()))
  let inside = fenceState === 'unknown' ? startsInsideFence(markers) : false
  /** @type {{char: string, length: number, info: string} | undefined} */
  let open
  if (inside) {
    // 起点在围栏内时，「一个长度 0、字符与第一个标记相同的未闭合围栏」正好等价于
    // 「窗口外还有一个没闭合的围栏」：窗口内第一个同字符标记就会把它闭合。长度写 0
    // 是为了让那个标记无论多长都算合法闭合（我们看不到开启它的那一行）。
    const head = markers.find((marker) => marker !== undefined)
    if (head !== undefined) open = { char: head.char, length: 0, info: '' }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line.length === 0) continue
    const marker = markers[index]
    if (marker !== undefined) {
      if (!inside) {
        inside = true
        open = marker
      } else if (open !== undefined && closesFence(open, marker)) {
        inside = false
        open = undefined
      }
      continue
    }
    if (inside) continue
    yield line
  }
}

/**
 * 取散文行：去掉代码行，并整段跳过围栏代码块。
 *
 * `isCodeish` 是逐行正则，没有状态：围栏里只要有一行不含 ASCII 标点（`return value`、
 * `pass`、`git status`、`a,b`），那一行就会被当成散文行参与复读统计 —— 于是一段
 * 纯代码引用既能污染「单块复读」百分比，也能在块足够小时独立触发复读告警。
 * 模块头把「排除代码行」列成既定要求，这里把围栏也算进去。
 *
 * 另外要排掉**引号包裹的代码字面量**（`''`、`'',`、`'a'`）：它们是代码标点，
 * 但 `CODEISH` 的字符类里没有单双引号，于是整行原样通过。校准行级阈值时这一点
 * 造成了误报 —— `'',` 在 38 行的窗口里重复 20 次就被算成「散文行复读」。
 *
 * 注意**不要**顺手排掉纯标点行（`...`、`———`、`（...）`）：那是真实的退化形态。
 * `session-aaa00001` 的 turn 49 里模型为了不再复读，把「做。」换成了「（...）」，
 * density 反而从 57% 涨到 97%，turn 61 出现 6,372 次。它们必须留在散文行里。
 * 这也是这里不能改用 `WORDY`（须有实词）过滤的原因 —— 那会把这一整类漏掉。
 *
 * @param {string} text - reasoning body，或流式守卫的尾部窗口
 * @param {{ fenceState?: 'outside' | 'unknown' }} [options] - 见 `unfencedLines`
 * @returns {string[]} prose rows
 */
export function proseRows(text, options = {}) {
  const rows = []
  for (const line of unfencedLines(text, options.fenceState ?? 'outside')) {
    if (isCodeish(line)) continue
    rows.push(line)
  }
  return rows
}

/**
 * 占位符堆积的形状：短行的重复规模，以及短行在整块里的占比。
 *
 * 为什么这条判据必须存在：`isFiller` 要求"有实词"，`tiny` 要求"每一行都是语气词"，
 * 于是模型一旦把「做。」换成纯标点的「（...）」或「…」，两条形态信号**同时**失效，
 * 只剩 `repeatRatio` 一条 —— 而 `assessShapes` 要求两条才定罪，真实退化会被漏判。
 * 这不是假想：`session-aaa00001` 的 turn 49 里，模型为了不再复读，把「做。」
 * 换成了「（...）」，密度反而从 57% 涨到 97%。
 *
 * 为什么按**原始行**而不是散文行统计：半角 `(...)` 含 `(`，会被 `isCodeish` 整行排除，
 * 那一块的 `rows` 直接变成 0，连 `repeatRatio` 都算不出来。代价是这条判据可能看见
 * 代码行里的 `}`，所以用两道闸门限制：只认**不含实词**的行（`}`、`…`、`（...）` 都算，
 * `做。`、`先读文件。` 不算），并且要求这种行在块里占到足够大的比例 —— 这个比例
 * 是量出来的，不是拍的，见 `PLACEHOLDER_SHORT_RATIO`。
 *
 * @param {string} text - reasoning body
 * @returns {{dupShort: number, shortRatio: number, rawRows: number}} placeholder shape
 */
export function placeholderShape(text) {
  const counts = new Map()
  let rows = 0
  let short = 0
  // 围栏必须和 proseRows 一样跳过，而且**必须用同一份状态机**：一段改代码的思考里
  // `` ``` `` 天然出现十几次，它无实词、长度 3。真实误报：一个「备份哈希一致 ✓…现在改
  // ps1」的块里 12 个围栏标记，不设这道闸门时 dupShort 正好 12、shortRatio 0.41，
  // 整块被判成堆积。这里传 `'outside'`（整块，起点已知在围栏外）。
  for (const line of unfencedLines(text, 'outside')) {
    rows += 1
    if (line.length > PLACEHOLDER_LINE || WORDY.test(line)) continue
    short += 1
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  let dupShort = 0
  for (const count of counts.values()) {
    if (count < PLACEHOLDER_REPEAT) continue
    dupShort += count
  }
  return { dupShort, shortRatio: rows === 0 ? 0 : short / rows, rawRows: rows }
}

/**
 * 单块的形状是否**自己就已经退化**（而不是"所在 turn 被别的块带坏"）。
 *
 * 压缩要剔的是这一块，不是整个 turn：一个 40 步的 turn 里可能只有最后一步退化成
 * 几万字符的复读，其余 39 步都是有用历史，按 turn 剔除会把它们一起扔掉。
 *
 * 判据与 `assessShapes` 里那两条**必须同源**（`test/probes.test.mjs` 有一条用例
 * 直接对比两边），否则会出现"turn 被判可疑、却挑不出任何一块可剔"的死角。
 *
 * @param {{repeatRatio?: number, maxRepeat?: number, dupShort?: number, shortRatio?: number}} shape - one block's shape
 * @returns {boolean} true when this block alone is degenerate
 */
export function isLoopBlock(shape) {
  if (shape === undefined || shape === null) return false
  const repeated =
    (shape.repeatRatio ?? 0) >= BLOCK_REPEAT_RATIO && (shape.maxRepeat ?? 0) >= MIN_LINE_REPEAT
  const placeholders =
    (shape.dupShort ?? 0) >= PLACEHOLDER_REPEAT &&
    (shape.shortRatio ?? 0) >= PLACEHOLDER_SHORT_RATIO
  return repeated || placeholders
}

/**
 * 是否值得从压缩的逐字尾部里剔除。
 *
 * 比 `isLoopBlock` 严格得多，因为两者代价不对称：检测多报一次只是多一条提醒；
 * 剔除多报一次会把**有用思考**从上下文里删掉。
 *
 * 实测（全库 36,637 个 >=200 字符的块）：`isLoopBlock` 命中 941 块，其中 660 块
 * 压缩率 > 0.3 —— 那些是"一段真重复 + 大量正常内容"的混合块（典型样本：135 行
 * 「（输出。）」夹在技术分析里，占 45%，另外 55% 是有效信息）。按块剔除会把
 * 那 55% 一起删掉。压缩率 <= 0.15 才是"几乎整块在重复"。
 *
 * 老形状没有 `compress` 字段时（事件环是 mixed-version 的）退回行重复率 0.8：
 * 实测该阈值对重度复读的召回是 57/67，且只误伤 11 个混合块。
 *
 * @param {{compress?: number, norm?: number, dev?: number, repeatRatio?: number, rows?: number, rawRows?: number}} shape - one block's shape
 * @returns {boolean} true when this block should not survive compaction verbatim
 */
export function isRetentionHazard(shape) {
  if (shape === undefined || shape === null) return false
  // 与 assessShapes 同一条闸门：结构规整的重复代码也能被压到 0.13 以下，但它的
  // 散文行是 0（全是代码行），删掉它就是删掉有用历史。实测 `40×{ if / push / }`
  // 压缩率 0.130、`- ✓ 已检查` 清单 0.065，两者都会被裸压缩率判据误剔。
  // `rawRows` **明确为 0** 不是「未知」，是「这一块没有任何围栏外的行」—— 典型是
  // 整块都是围栏代码（`chars/rows/rawRows` 全为 0）。那时散文证据是 0，必须与
  // 「缺字段的旧形状」（mixed-version 事件环）分开：混为一谈时，一块纯代码会拿到
  // proseShare=1 的散文资格，再被它自己的低压缩率剔出逐字尾部 —— 正是这条闸门
  // 上面那段注释（40×`if` 实测）想挡的事。判据与 `assessShapes` 的
  // `rawRows === 0 ? 0 : rows / rawRows` 对齐，两处不再是「同名不同义」。
  const proseShare =
    typeof shape.rawRows === 'number'
      ? shape.rawRows > 0
        ? (shape.rows ?? 0) / shape.rawRows
        : 0
      : 1
  if (proseShare < 0.5) return false
  if (typeof shape.compress === 'number' && shape.compress <= COMPRESS_RETAIN) return true
  // 归一化走同一条并集逻辑：短复读块的绝对压缩率压不到 0.15，但相对同长度中文
  // 正常文本只有 0.2x。判据用 **σ 分数**（`dev >= 5`）而不是比值：比值的等价阈值
  // 随长度漂移（norm 0.28 在 357 字符块上等于 dev 9.95），那等于换条路又埋回一条
  // 隐形长度曲线。实测 dev>=5 的误报率 0.12%。
  if (typeof shape.dev === 'number' && shape.dev >= DEV_RETAIN) return true
  if (typeof shape.compress === 'number' || typeof shape.dev === 'number') return false
  return (shape.repeatRatio ?? 0) >= 0.8
}

/** 跨块判据生效所需的最小块长。 */
export const BLOCK_PAIR_MIN_CHARS = 600
/**
 * 跨块判据的偏离度阈值（σ 分数），与单块的 `DEV_SIGNAL` 同一条线。
 *
 * **不能用裸压缩率。** deflate 在短文本上有固定的头部开销，所以「同样重复」的
 * 1,384 字符拼接体压缩率 0.356，而 6,237 字符的实测样本是 0.164 —— 用固定的
 * 比值阈值等于埋了一条隐形长度曲线。换算成 σ 分数就对齐了：前者
 * `(0.589 − 0.356) / 0.051 = 4.6`，后者 `(0.458 − 0.164) / 0.051 = 5.8`。
 *
 * 这条也解释了为什么真实命中样本（0.164–0.30）和「几乎全重复的构造样本」（0.356）
 * 看起来差那么远却都是同一个现象。
 */
export const BLOCK_PAIR_DEV = 3.5

/**
 * 跨块复读：相邻两个 reasoning 块是不是**同一段内容**。
 *
 * 这是单块压缩率（`isRetentionHazard`）看不见的形态。单块判据问的是「这一块本身在不在
 * 重复」；跨块问的是「这两块是不是一回事情」—— 而两块各自都可以完全不重复，也就是模型
 * **把同一段内容再走一遍**。
 *
 * 实测（239 个会话、3,971 个 turn）这种拼接体 σ 偏离 ≥3.5 出现 512 次，样本集中在已知
 * 复读会话 `session-ddd00004`（裸压缩率 0.164–0.30，块长 1,820–6,237 字符）。
 *
 * **它抓的是字面相似，不是语义复述。** 拼接压缩率只认字面重合，措辞改动大一点就压不下去
 * （实测同一批句子改写 8 处措辞，拼接压缩率从 0.356 只掉到 0.368）。
 *
 * **只在离线分析里可用**：事件环刻意只留形状不留原文（`recentFactFromEvent`），
 * 所以生产的 `scanEventRing` 拿不到能比较的文本，跨块判据进不了运行时路径。
 *
 * @param {string} previous - 前一块正文
 * @param {string} current - 当前块正文
 * @param {{minChars?: number}} [options] - overrides for tests
 * @returns {{ratio: number, dev: number, chars: number} | null} measurement, or null when too short
 */
export function blockPairCompress(previous, current, options = {}) {
  const minChars = options.minChars ?? BLOCK_PAIR_MIN_CHARS
  const a = String(previous ?? '')
  const b = String(current ?? '')
  // 太短的块拼起来的压缩率没有可比性：几百字符的两句话高度相似是常态。
  if (a.length < minChars || b.length < minChars) return null
  const joined = `${a}\n${b}`
  const ratio = compressionRatio(joined)
  return { ratio, dev: compressDeviation(ratio, joined.length), chars: joined.length }
}

/**
 * 把一段思考压成形状。不保留任何原文。
 * @param {string} text - reasoning body
 * @returns {{chars: number, rows: number, fillers: number, maxRepeat: number, repeatRatio: number, tiny: boolean, dupShort: number, shortRatio: number, rawRows: number, compress: number | undefined, lang: 'zh' | 'other', norm: number | undefined, dev: number | undefined}} shape
 */
export function shapeReasoning(text) {
  const rows = proseRows(text ?? '')
  const counts = new Map()
  for (const row of rows) counts.set(row, (counts.get(row) ?? 0) + 1)
  let maxRepeat = 0
  let dupChars = 0
  for (const [row, count] of counts) {
    if (count < MIN_LINE_REPEAT) continue
    dupChars += count * row.length
    maxRepeat = Math.max(maxRepeat, count)
  }
  const chars = rows.reduce((sum, row) => sum + row.length, 0)
  const fillers = rows.filter((row) => isFiller(row)).length
  // 碎片块 = 非空、短、行少、而且**每一行都是语气词**。
  // 只按长度判会把「一句 40 字的正常思考」误判成碎片，那种块并不退化。
  // 行数为 0 的块（只有工具调用、没有思考的 step）必须排除：
  // `[].every(...)` 恒为 true，漏了这个条件正常会话会被判满。
  //
  // 行数上限原来是 3，于是最典型的退化形态 `好。做。好。做。`（4 行）反而不算
  // 碎片块，靠 `longestRun` 那条判据永远命中不了它。放宽到 6：每行都必须是
  // ≤SHORT_LINE 字的语气词且整块 <80 字符，这个组合已经足够严格。
  const tiny =
    rows.length > 0 &&
    (text ?? '').length < FRAGMENT_CHARS &&
    rows.length <= FRAGMENT_ROWS &&
    fillers === rows.length
  const placeholder = placeholderShape(text)
  const body = String(text ?? '')
  // 压缩率是唯一不受语言与行结构影响的判据：英文的"行内重复"只有它能看见。
  // 长度门槛是必须的 —— 短文本的 deflate 头部固定开销会把比例推到 1 附近；
  // 上限是为了热路径开销，见 COMPRESS_MAX_CHARS。
  const compress =
    body.length >= COMPRESS_MIN_CHARS
      ? compressionRatio(body.length > COMPRESS_MAX_CHARS ? body.slice(0, COMPRESS_MAX_CHARS) : body)
      : undefined
  // 归一化只对中文成立（见 CJK_MIN_SHARE 上方的说明）：英文/混合块没有可信的
  // 参照曲线，`norm` 留 undefined，判定退回绝对阈值，而不是借中文曲线凑一个数。
  const lang = cjkShare(body) >= CJK_MIN_SHARE ? 'zh' : 'other'
  const norm = typeof compress === 'number' && lang === 'zh' ? normalizedCompress(compress, body.length) : undefined
  // `dev` 才是判定用的那个：σ 分数与长度无关，而比值 `norm` 的等价阈值**随长度漂移**
  // （norm 0.28 在 357 字符块上等于 dev 9.95，在 7000 字符块上等于 dev 6.0）。
  // 用比值定阈值 = 又埋了一条隐形长度曲线，这正是归一化要修掉的东西。
  const dev =
    typeof compress === 'number' && lang === 'zh' ? compressDeviation(compress, body.length) : undefined
  return {
    chars,
    rows: rows.length,
    fillers,
    maxRepeat,
    repeatRatio: chars === 0 ? 0 : dupChars / chars,
    tiny,
    dupShort: placeholder.dupShort,
    shortRatio: placeholder.shortRatio,
    rawRows: placeholder.rawRows,
    compress,
    lang,
    norm,
    dev,
  }
}

/**
 * 从一组形状判定一个 turn。
 * @param {Array<{chars?: number, rows?: number, fillers?: number, maxRepeat?: number, repeatRatio?: number, tiny?: boolean, dupShort?: number, shortRatio?: number, compress?: number, norm?: number, dev?: number, rawRows?: number}>} shapes - per-block shapes in step order
 * @returns {{suspicious: boolean, reasons: string[], repeatSignal: boolean, placeholderSignal: boolean, compressSignal: boolean, normSignal: boolean, longestRun: number, fillers: number, fillerRatio: number, worstRepeatRatio: number, worstDupShort: number, worstCompress?: number, worstNorm?: number, worstDev?: number}} verdict
 */
export function assessShapes(shapes) {
  const list = Array.isArray(shapes) ? shapes : []
  let run = 0
  let longestRun = 0
  let fillers = 0
  let rows = 0
  let worstRepeatRatio = 0
  let worstMaxRepeat = 0
  let worstDupShort = 0
  let worstShortRatio = 0
  let rawRows = 0
  /** @type {number | undefined} */
  let worstCompress
  /** @type {number | undefined} */
  let worstNorm
  /** @type {number | undefined} */
  let worstDev
  for (const shape of list) {
    if (shape?.tiny === true) {
      run += 1
      longestRun = Math.max(longestRun, run)
    } else {
      run = 0
    }
    fillers += shape?.fillers ?? 0
    rows += shape?.rows ?? 0
    rawRows += shape?.rawRows ?? shape?.rows ?? 0
    if ((shape?.repeatRatio ?? 0) > worstRepeatRatio) {
      worstRepeatRatio = shape?.repeatRatio ?? 0
      worstMaxRepeat = shape?.maxRepeat ?? 0
    }
    const compress = shape?.compress
    if (typeof compress === 'number' && (worstCompress === undefined || compress < worstCompress)) {
      worstCompress = compress
    }
    // 归一化只能在同一块内比较：不同长度的块有不同的参照系，跨块取最小值没有意义，
    // 所以这里和 worstCompress 一样取最小值（都表示"最像复读的那一块"）。
    const norm = shape?.norm
    if (typeof norm === 'number' && (worstNorm === undefined || norm < worstNorm)) {
      worstNorm = norm
    }
    // dev 取**最大值**（偏离越大越异常），方向与 compress/norm 相反。
    const dev = shape?.dev
    if (typeof dev === 'number' && (worstDev === undefined || dev > worstDev)) {
      worstDev = dev
    }
    // 两个阈值必须由**同一块**同时满足：短行占比低的块重复多、短行多的块各写各的，
    // 各取一个最大值凑出来的组合不是占位符堆积。
    const dupShort = shape?.dupShort ?? 0
    const shortRatio = shape?.shortRatio ?? 0
    if (dupShort >= PLACEHOLDER_REPEAT && shortRatio >= PLACEHOLDER_SHORT_RATIO && dupShort > worstDupShort) {
      worstDupShort = dupShort
      worstShortRatio = shortRatio
    }
  }
  const fillerRatio = rows === 0 ? 0 : fillers / rows
  const reasons = []
  if (longestRun >= FRAGMENT_RUN) reasons.push(`连续碎片块 ${longestRun} 个`)
  if (fillers >= FILLER_MIN && fillerRatio >= FILLER_RATIO) {
    reasons.push(`语气短行 ${fillers} 条（占 ${(fillerRatio * 100).toFixed(0)}%）`)
  }
  // 复读的本质是**重复**，而「碎片块多」「短行占比高」只是形态。
  //
  // 真实误报：一个 turn 的 4 步各写两行内容完全不同的短句（『先读文件。』
  // 『再看测试。』…），每行都短，于是全被算成语气短行 —— 两个形态信号一起
  // 命中，判成复读，而 topFillerCount 是 1（没有任何一行出现过第二次）。
  //
  // 误报的根子在 SHORT_LINE：退化的行是 `好。`/`做。` 这种 2 个字，而正常
  // 短句是四五个字。把门槛收紧到 4 之后，『先读文件。』不再算语气词，那 4 步
  // 也就不是碎片块了。这里保留 repeat 作为**第三条**独立信号。
  const repeatSignal =
    worstRepeatRatio >= BLOCK_REPEAT_RATIO && worstMaxRepeat >= MIN_LINE_REPEAT
  if (repeatSignal) {
    reasons.push(`单块复读 ${(worstRepeatRatio * 100).toFixed(0)}%（最高一行 ×${worstMaxRepeat}）`)
  }
  // 第四条：纯标点占位符堆积。上面三条都靠"有实词的短行"，而模型换符号之后
  // 一行实词都没有了，于是三条一起失效、只剩 repeatSignal 单条，够不到两条的定罪线。
  // 阈值故意远高于 `...`×8 那次真实误报（dupShort 要 12 起跳），所以不是把
  // `isFiller` 的实词要求放宽 —— 那条收紧是为了修误报，不能回退。
  //
  // 它是**复合**条件（整块无实词行占比 + 同一行重复次数，两个维度必须同时满足），
  // 所以单独成立就够定罪：半角 `(...)` 会把散文行全部喂给 codeish，`repeatRatio`
  // 恒为 0，那种块永远拿不到第二条信号。
  const placeholderSignal =
    worstDupShort >= PLACEHOLDER_REPEAT && worstShortRatio >= PLACEHOLDER_SHORT_RATIO
  if (placeholderSignal) {
    reasons.push(
      `占位符堆积 ${worstDupShort} 行（短行占 ${(worstShortRatio * 100).toFixed(0)}%）`,
    )
  }
  // 第五条：压缩率。前四条都依赖"行"这个单位，而英文复读经常整段挤在一行里
  // （"Let me do it now. Let me do it now. …"），行级判据全部失效。deflate 自适应
  // 找重复片段，与语言、行结构无关。
  //
  // 但压缩率有个必须堵的误报：**结构规整的重复代码也会被压到很低**。实测一段
  // 40 次 `if (flagN) { result.push(valueN) }` 的合成代码，压缩率 0.130 —— 比
  // 已知的复读块（0.018~0.038）只高一点。所以要求"散文行占非空行多数"：纯代码
  // 块 `proseRows` 是 0、混排块占比也很低，而英文/中文的复读块几乎全是散文行。
  const proseShare = rawRows === 0 ? 0 : rows / rawRows
  const compressSignal =
    worstCompress !== undefined && worstCompress <= COMPRESS_SIGNAL && proseShare >= 0.5
  // 第六条：**归一化**压缩率，只对中文块成立，且必须与绝对判据取并集。
  //
  // 绝对压缩率随长度漂移（短块因 deflate 头部开销整体偏高），所以一个 300 字符的
  // 真复读块测得 0.208，会被 `compress <= 0.2` 放过。归一化把它换算成"同长度正常
  // 中文文本的几分之几"（0.283），就能看见。实测全库：归一化在 200-800 字符桶里
  // 多抓 3 块，**全部是真复读**（「做。好。执行。」×28~72，行重复 67%），零误报。
  //
  // 为什么是并集而不是替换：归一化在 800-3200 字符桶里反而**少抓** 2 块 ——
  // 长块 p50 低，同样的 compress 换算出的 norm 偏高。两个判据各自补对方的洞，
  // 所以 `compressSignal` 的名字保持不变，语义是"压缩率类信号成立（绝对或归一化）"。
  const normSignal =
    typeof worstDev === 'number' && worstDev >= DEV_SIGNAL && proseShare >= 0.5
  const compressionSignal = compressSignal || normSignal
  if (compressionSignal) {
    if (normSignal && !compressSignal) {
      reasons.push(`压缩率仅为同长度中文正常水平的 ${(worstNorm * 100).toFixed(0)}%（${worstDev.toFixed(1)}σ）`)
    } else if (normSignal) {
      reasons.push(
        `压缩率 ${(worstCompress * 100).toFixed(0)}%（同长度中文正常水平的 ${(worstNorm * 100).toFixed(0)}%，${worstDev.toFixed(1)}σ）`,
      )
    } else {
      reasons.push(`压缩率 ${(worstCompress * 100).toFixed(0)}%（整块高度自我重复）`)
    }
  }
  return {
    suspicious: reasons.length >= 2 || placeholderSignal || compressionSignal,
    reasons,
    repeatSignal,
    placeholderSignal,
    compressSignal: compressionSignal,
    normSignal,
    longestRun,
    fillers,
    fillerRatio,
    worstRepeatRatio,
    worstDupShort,
    worstCompress,
    worstNorm,
  }
}

/**
 * 单块复读：同一行出现 ≥MIN_LINE_REPEAT 次的字符占比（排除代码行）。
 * @param {string} text - reasoning body
 * @returns {{ratio: number, maxRepeat: number, rows: number}} measurement
 */
export function blockRepeat(text) {
  const shape = shapeReasoning(text)
  return { ratio: shape.repeatRatio, maxRepeat: shape.maxRepeat, rows: shape.rows }
}

/**
 * 跨块碎片化：一个 turn 内的连续碎片块与语气短行密度。
 * @param {Array<{text: string}>} blocks - reasoning blocks in step order
 * @returns {{longestRun: number, fillers: number, fillerRatio: number, topFiller: string|null, topFillerCount: number}} measurement
 */
export function fragmentation(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const verdict = assessShapes(list.map((block) => shapeReasoning(block?.text ?? '')))
  const counts = new Map()
  for (const block of list) {
    for (const row of proseRows(block?.text ?? '')) {
      if (!isFiller(row)) continue
      counts.set(row, (counts.get(row) ?? 0) + 1)
    }
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0]
  return {
    longestRun: verdict.longestRun,
    fillers: verdict.fillers,
    fillerRatio: verdict.fillerRatio,
    topFiller: top[0],
    topFillerCount: top[1],
  }
}

/**
 * 综合判定一个 turn（探针用；与内存环里的 assessShapes 同一套阈值）。
 * @param {Array<{text: string, step?: number}>} blocks - reasoning blocks in step order
 * @returns {{suspicious: boolean, reasons: string[], frag: object, worstBlock: object|null, worstDupShort: number, compressSignal: boolean, closestPair: {index: number, ratio: number, dev: number, chars: number}|null}} verdict
 */
export function assessTurn(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const shapes = list.map((block) => shapeReasoning(block?.text ?? ''))
  const verdict = assessShapes(shapes)
  // 跨块复读：单块压缩率看不见「换个说法再说一遍」。
  // 只在有原文的离线路径上可用（事件环只留形状，见 blockPairCompress）。
  let closestPair = null
  for (let index = 1; index < list.length; index += 1) {
    const pair = blockPairCompress(list[index - 1]?.text, list[index]?.text)
    if (pair === null) continue
    if (closestPair === null || pair.dev > closestPair.dev) closestPair = { index, ...pair }
  }
  if (closestPair !== null && closestPair.dev >= BLOCK_PAIR_DEV) {
    verdict.reasons.push(
      `相邻块像同一段内容（第 ${closestPair.index} 与第 ${closestPair.index + 1} 块拼接偏离 ${closestPair.dev.toFixed(1)}σ）`,
    )
    verdict.suspicious = true
  }
  let worstIndex = -1
  for (let index = 0; index < shapes.length; index += 1) {
    if (worstIndex < 0 || shapes[index].repeatRatio > shapes[worstIndex].repeatRatio) worstIndex = index
  }
  return {
    suspicious: verdict.suspicious,
    reasons: verdict.reasons,
    worstDupShort: verdict.worstDupShort,
    compressSignal: verdict.compressSignal,
    frag: fragmentation(list),
    closestPair,
    worstBlock:
      worstIndex < 0
        ? null
        : {
            block: list[worstIndex],
            repeat: { ratio: shapes[worstIndex].repeatRatio, maxRepeat: shapes[worstIndex].maxRepeat, rows: shapes[worstIndex].rows },
          },
  }
}

/**
 * 从会话事件环里挑出 reasoning 形状，按 turn 聚合判定。
 *
 * 事件环里的每条形如 `{ seq, type, turn, reasoning: shape }`（形状由
 * lib/index.js 的 recentFactFromEvent 附着，不含原文）。
 * @param {Array<object>} facts - ring events
 * @returns {{verdicts: Array<{turn: unknown, seq: number, shapes: object[], suspicious: boolean, reasons: string[], fillers: number, longestRun: number}>, scanned: number}} report
 */
export function scanEventRing(facts) {
  /** @type {Map<unknown, {seq: number, shapes: object[]}>} */
  const byTurn = new Map()
  let scanned = 0
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (fact?.type !== 'assistant/message') continue
    const shape = fact.reasoning
    if (shape === undefined || shape === null) continue
    scanned += 1
    const turn = fact.turn ?? `seq:${fact.seq}`
    if (!byTurn.has(turn)) byTurn.set(turn, { seq: fact.seq, shapes: [] })
    byTurn.get(turn).shapes.push(shape)
  }
  const verdicts = []
  for (const [turn, group] of byTurn) {
    const verdict = assessShapes(group.shapes)
    if (!verdict.suspicious) continue
    verdicts.push({
      turn,
      seq: group.seq,
      shapes: group.shapes,
      suspicious: true,
      reasons: verdict.reasons,
      fillers: verdict.fillers,
      longestRun: verdict.longestRun,
    })
  }
  return { verdicts, scanned }
}
