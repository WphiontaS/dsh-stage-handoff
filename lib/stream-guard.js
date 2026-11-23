// 流式增量检测：在模型还在生成时就看 reasoning 的尾部有没有开始原地打转。
//
// 为什么需要它，而不是等 turn 结束再扫日志：
//   现有的检测发生在**事件环**里 —— 一个 step 的 assistant/message 落盘之后才能看。
//   复读一旦开始，这个 step 剩下的几千个字符就白烧了（实测 session-aaa00001 的
//   最大单块 65,928 字符，压缩率 0.018）。流式检测把这个窗口从"下一个 turn"
//   提前到"下一个 step"。
//
// **它只报告，不截断。** 这是刻意的：PREWARN 作者实测 windowed repetition score
// 在「法官确认非退化」的长答案上仍触发 79.5–100%（`deployed_repetition_rules.md`），
// 直接拿这类规则当停止条件会掐断几乎所有合法的长任务回答。所以本模块产出的结论
// 只用于"下一个 step 开始时提醒一句"，绝不 return / abort / 丢 chunk。
//
// 判据用的是 `trailingRepeat`（反向 Z，DRY 的纯文本移植）而不是整块压缩率：
// 流式场景下没有"整块"，只有"到目前为止的尾部"；而且反复出现的正常词（`Windows1`
// 在一段正常研究里出现 14 次）不会被尾部重复判据误伤 —— 它要求的是**连续重现**。

import { proseRows, trailingRepeat } from './repeat-scan.js'

/** 每隔多少个 reasoning-delta 检查一次。 */
export const STREAM_CHECK_EVERY = 24
/** 只看尾部这么多字符（与 repeat-scan 的 TAIL_WINDOW 一致）。 */
export const STREAM_WINDOW = 4096
/**
 * 流式阶段的判据比离线更严：`repeats` 要 5 次起（离线是 3 次）。
 *
 * 理由是这里的误报代价不同 —— 离线判错只是报告里多一条，流式判错会往上下文里
 * 塞一句错误的"你在复读"。而且生成到一半时"尾部重复 3 遍"可能只是排比句。
 */
export const STREAM_MIN_REPEATS = 5
/** 重复覆盖的字符数下限：太短的重复（`。。。`）没有信息量。 */
export const STREAM_MIN_SPAN = 200
/**
 * 同一条散文行在尾部窗口里重复多少次算复读。
 *
 * 这条判据是**补 `trailingRepeat` 的洞**，不是重复劳动。严格周期匹配只能看见
 * 「A A A A」这种等距重现；真实复读大量是**主周期被周期性插入打断**的形态：
 *
 *     好。 好。 好。 好。 （输出） 好。 好。 好。 好。 （好） 好。 好。 好。
 *
 * 实测 `session-bbb00002` turn 60 的十个块全部是这种形状：单行重复 108–176 次、
 * 压缩率掉到 12–34%、偏离 5.2–10.1σ（**离线判据全部命中**），而 `trailingRepeat`
 * 十个全返回 null（守卫一声没响）。插入项把严格周期打断了，可重复的行数完全看得见。
 *
 * **取 10 而不是原来的 30。** 30 是凭"真实样本 100+ 次，留三倍余量"定的，但那是
 * 拿最严重的样本当基线。跑真实语料校准后（239 个会话，取尾部窗口跑行级判据）：
 *
 *   | 阈值 | 命中块数 | 「最高频行」都是些什么 |
 *   | 8    | 704      | 语气短行 972/990（98.2%），误报 3 个 |
 *   | 30   | 499      | ——                                     |
 *
 * 8 与 30 的差集有 205 个块，抽看全是 `Go.` ×16、`好。` ×23 这种**已经在打转**
 * 的块，只是没到 30 次。原阈值把这一段整体漏掉了。取 10 而非 8，是为了和边缘留
 * 一格余量；真正的误报防线是下面的行数下限与比例判据，不是次数。
 *
 * `proseRows` 已经剔掉代码行与围栏块，所以 `}`、`);` 这类高频符号不会走到这里。
 */
export const STREAM_LINE_MIN_REPEATS = 10
/**
 * 尾部窗口至少要这么多**散文行**才允许行级判据下结论。
 *
 * 比例判据在短窗口上不牢靠：12 行里 8 行相同就是 67%，轻松越过 0.5，但那更可能是
 * 「一段长行思考里反复提到同一个词」。实测阈 8 的 3 个误报（`INFO ok` 12 行、
 * `return` 14 行、`'',` 38 行）全部落在短窗口里，而真复读样本的行数是 80 / 112 /
 * 229。20 行这条线把误报那一侧切掉，又离真样本远得多。
 */
export const STREAM_LINE_MIN_ROWS = 20
/**
 * 重复行至少占尾部窗口行数的这个比例才算复读。
 *
 * 只有次数没有比例会误伤「一段长正常思考里碰巧反复提到同一行」。真实样本里
 * 这个比例是 0.77–0.97（语气短行占 94%），所以 0.5 是宽松但安全的线。
 */
export const STREAM_LINE_MIN_RATIO = 0.5
/**
 * 「强行级证据」的占比门槛：达到它的 `line` 结论可以覆盖已有的 `tail` 结论。
 *
 * 两种判据的 `repeats` **不同量纲**（`tail` 是同一片段连续重复的遍数，`line` 是
 * 顶行在窗口里出现的次数），所以「谁更严重」不能靠比较 `repeats` 决定。原来
 * `check()` 里一句 `verdict.kind === 'tail' → return false` 直接让 `line` 在本
 * step 永久失声：先中一个弱的 `tail`（400 字单位重复 5 遍）之后，即使模型升级成
 * 占比 0.89 的行级洪泛，结论仍停在那个 `tail` 上 —— 而 `rejectOnRepeat` 的
 * `kind === 'line'` 分支正是按这个占比判定的，于是它永远走不到。
 *
 * 0.8 与 `lib/index.js` 的 `REJECT_MIN_RATIO` 是**同一个值、同一条理由**：
 * 低于它的行级证据本来也进不了 reject，换过去只是把文案变得更吓人。那里现在
 * 直接引用这个常量，两处不会再各写一份。
 */
export const STREAM_LINE_STRONG_RATIO = 0.8

/**
 * 一次流式判定的结论。
 *
 * `kind` 区分两条判据：`tail` 来自严格周期（有精确 period/span），
 * `line` 来自行级重复（只有 repeats/rows/ratio，period/span 为 0）。
 *
 * @typedef {{turn: number|null, step: number|null, kind: 'tail'|'line', period: number, repeats: number, span: number, rows: number, ratio: number, atDelta: number}} StreamVerdict
 */

/**
 * 尾部窗口里有没有某一条散文行在反复重现。
 *
 * 与 `trailingRepeat` 互补：那个要求相邻片段严格相等，这个只要求**同一行**反复出现，
 * 中间可以夹杂别的行。真实复读常常是这样 —— 主周期被周期性插入打断，严格周期失配，
 * 但行级计数一目了然。
 *
 * `fenceState` 必须是 `'unknown'`：调用方传进来的永远是 `slice(-window)` 的后缀，
 * 起点可能落在围栏**内部**。那里唯一的围栏标记是「闭」，按「第一个就是开」处理会
 * 把它其后所有散文行吞掉 —— 实测 140 行真实复读被判成 0 行。见 `unfencedLines`。
 *
 * @param {string} text - 尾部窗口
 * @param {number} minRepeats - 同一条行至少重复多少次
 * @param {number} minRatio - 它至少占窗口行数的多少
 * @param {number} [minRows] - 窗口至少多少行才允许下结论
 * @param {{ fenceState?: 'outside' | 'unknown' }} [options] - 见 `proseRows`
 * @returns {{repeats: number, rows: number, ratio: number} | null} measurement
 */
export function repeatedRow(text, minRepeats, minRatio, minRows = STREAM_LINE_MIN_ROWS, options = {}) {
  const rows = proseRows(text ?? '', { fenceState: options.fenceState ?? 'unknown' })
  if (rows.length === 0) return null
  // 行数太少时比例没有意义：12 行里 8 行相同就是 67%。见 STREAM_LINE_MIN_ROWS。
  if (rows.length < minRows) return null
  const counts = new Map()
  for (const row of rows) counts.set(row, (counts.get(row) ?? 0) + 1)
  let top = 0
  for (const count of counts.values()) {
    if (count > top) top = count
  }
  // 先看次数：正常散文里最高重复通常是个位数。
  if (top < minRepeats) return null
  const ratio = top / rows.length
  if (ratio < minRatio) return null
  return { repeats: top, rows: rows.length, ratio }
}

/**
 * 这段文本里有没有「散文证据」—— 也就是围栏外、且不像代码的行。
 *
 * 存在的理由：流式侧有两条判据，只有行级那条会过滤围栏与代码行；严格周期是纯
 * 文本判据，看不见结构。把这条资格做成两条判据共用的**同一个**问题（而不是
 * 各写一份过滤），是它们不再次发生分歧的唯一写法 —— 离线侧的
 * `isRetentionHazard` 与 `assessShapes` 就是同名闸门各写一份后漂成了相反方向。
 *
 * `fenceState: 'unknown'` 是**必须的**，不能用 `'outside'`：传进来的是重复单位
 * 的最后 `period` 个**字符**（`sample`），它既不对齐行边界，起点也可能落在窗口
 * 内某个未闭合围栏里面 —— 而 `this.text` 本身已经是 `slice(-window)` 的后缀。
 * 用 `'outside'` 会把「以围栏行开头」的样本当成开围栏，继发地把其后所有散文行
 * 吞掉：实测 ```` ``` ````+`好。`×29（span 203）在 `outside` 下判假、整体漏检，
 * 而它修前本来是能报 `tail` 的。`'unknown'` 与行级判据同一口径。
 *
 * @param {string | undefined} text - 重复单位原文
 * @returns {boolean} 是否至少有一行散文证据
 */
function hasProseEvidence(text) {
  return proseRows(String(text ?? ''), { fenceState: 'unknown' }).length > 0
}

/**
 * 一个 attempt 的流式重复守卫。一个会话一个实例即可。
 */
export class ReasonStreamGuard {
  /**
   * @param {{checkEvery?: number, window?: number, minRepeats?: number, minSpan?: number, lineMinRepeats?: number, lineMinRatio?: number, lineMinRows?: number}} [options] - overrides for tests
   */
  constructor(options = {}) {
    this.checkEvery = options.checkEvery ?? STREAM_CHECK_EVERY
    this.window = options.window ?? STREAM_WINDOW
    this.minRepeats = options.minRepeats ?? STREAM_MIN_REPEATS
    this.minSpan = options.minSpan ?? STREAM_MIN_SPAN
    this.lineMinRepeats = options.lineMinRepeats ?? STREAM_LINE_MIN_REPEATS
    this.lineMinRatio = options.lineMinRatio ?? STREAM_LINE_MIN_RATIO
    this.lineMinRows = options.lineMinRows ?? STREAM_LINE_MIN_ROWS
    /** @type {'idle' | 'streaming'} */
    this.phase = 'idle'
    /** @type {number | null} */
    this.turn = null
    /** @type {number | null} */
    this.step = null
    /** 只保留尾部 window 个字符。 */
    this.text = ''
    this.deltas = 0
    /**
     * 累计收到过多少个 `reasoning-delta` 帧，**永不重置**。
     *
     * 这是「监听到底通不通」的唯一直接证据。`deltas` 每个 step 归零、`verdict` 每个
     * step 被清，于是"帧没到"与"帧到了但判据没命中"在外部读数上完全一样。有了这个
     * 计数，`0` 就是监听问题，非 `0` 就是判据或注入问题 —— 两条路的修法毫无交集。
     */
    this.totalDeltas = 0
    /** @type {StreamVerdict | null} 当前 step 的结论，`start` 会清空它。 */
    this.verdict = null
    /**
     * 最近一次结论，**不会被 `start` 清空**，只有 `reset()` 才清。
     *
     * 存在的理由是可观测性：`verdict` 每个 step 开始时就被清掉，于是"守卫从来没检测到"
     * 和"检测到了但提醒没发出去"在外部看起来完全一样 —— `status` 说"开"，日志里 0 条提醒，
     * 而两种情况的修法完全不同。这个字段让第一种情况能被证伪。
     * @type {(StreamVerdict & {at: number}) | null}
     */
    this.lastVerdict = null
  }

  /**
   * 喂一帧 `agent/assistant-stream` 的 payload（`{ frame }`）。
   *
   * @param {{frame?: {type?: string, turn?: number, step?: number, chunk?: {type?: string, text?: string}}}} payload - hook payload
   * @returns {boolean} true when a fresh repetition verdict was produced by this frame
   */
  onFrame(payload) {
    const frame = payload?.frame
    if (frame === undefined || frame === null) return false
    if (frame.type === 'start') {
      this.phase = 'streaming'
      this.turn = typeof frame.turn === 'number' ? frame.turn : null
      this.step = typeof frame.step === 'number' ? frame.step : null
      this.text = ''
      this.deltas = 0
      this.verdict = null
      return false
    }
    if (frame.type === 'end') {
      this.phase = 'idle'
      // 收尾补一次检查。块可能短到 delta 数不足 checkEvery（实测有 703 字符的块
      // 在 40 字符/delta 下只有 18 个 delta），那样一次都不会进检查点，短块复读
      // 就永远不响 —— 而短块恰恰是最典型的退化形态。
      this.check()
      return false
    }
    if (frame.type !== 'chunk') return false
    const chunk = frame.chunk
    // 只关心思考增量。正文（text-delta）不参与：复读发生在推理里更常见，
    // 而且正文的"重复"有一大半是正常的代码缩进与列表符号。
    if (chunk?.type !== 'reasoning-delta' || typeof chunk.text !== 'string') return false
    this.totalDeltas += 1
    this.deltas += 1
    this.text += chunk.text
    if (this.text.length > this.window) this.text = this.text.slice(-this.window)
    if (this.deltas % this.checkEvery !== 0) return false
    return this.check()
  }

  /**
   * 在当前尾部窗口上跑一次判据。两条判据并行看，先命中的那条更早给出证据。
   *
   * 严格周期（trailingRepeat）能给出精确的 period/span，是更强的证据；
   * 行级重复（repeatedRow）补的是"主周期被插入打断"那种形态 —— 实测里
   * 它才是中文思考复读的主流样子（见 STREAM_LINE_MIN_REPEATS 上方）。
   *
   * @returns {boolean} true when this call produced a fresh verdict
   */
  check() {
    const repeat = trailingRepeat(this.text, {
      window: this.window,
      minRepeats: this.minRepeats,
    })
    // 严格周期是纯文本判据，它**不认识围栏**：模型在思考里输出一段重复代码
    // （生成数组字面量、40 行相同测试、批量 print）会被原样算成「连续重现」。
    // 行级分支没有这个问题，因为它走 `proseRows`（跳过围栏内与代码行）。两条
    // 判据必须共享同一份「证据是不是散文」的结构资格，否则强判据反而更宽松 ——
    // 实测未闭合 python 围栏内 40 行 `print(...)`：本分支 `period=27 repeats=40`，
    // 行级分支 `null`。
    //
    // 判据用**重复单位本身**（`repeat.sample`）而不是整个窗口：窗口里既有散文又有
    // 尾部代码时，用窗口会漏掉「重复的正是那段代码」这种情况。
    //
    // 但只看 sample 不够：`isCodeish` 是逐行正则，认不出 `git status`、`TODO`、
    // `pass` 这类**没有 ASCII 标点**的词行。未闭合围栏里 200 行 `git status` 的
    // sample 会被判成散文，于是整段窗口都在代码里的复读照样命中（实测 repeats=200，
    // 越过 `REJECT_MIN_REPEATS` 就能在 `rejectOnRepeat` 下走到破坏性的 reject）。
    // 所以再加一道**窗口级**闸：整个尾窗里必须真有散文行。两条件一起成立才算数。
    const windowProse = repeat === null ? 0 : proseRows(this.text, { fenceState: 'unknown' }).length
    if (
      repeat !== null &&
      repeat.span >= this.minSpan &&
      windowProse > 0 &&
      hasProseEvidence(repeat.sample)
    ) {
      // 已有结论且更严重时不覆盖：第一次发现才是"从哪开始"的证据。
      if (this.verdict === null || repeat.repeats > this.verdict.repeats) {
        this.verdict = {
          turn: this.turn,
          step: this.step,
          kind: 'tail',
          period: repeat.period,
          repeats: repeat.repeats,
          span: repeat.span,
          rows: 0,
          ratio: 0,
          atDelta: this.deltas,
        }
        this.lastVerdict = { ...this.verdict, at: Date.now() }
        return true
      }
      return false
    }
    // 显式传 `'unknown'`：`this.text` 是 `slice(-window)` 的后缀，起点可能在围栏内。
    // 依赖 `repeatedRow` 的默认值也行，写出来是为了这条契约不被悄悄改回去。
    const row = repeatedRow(this.text, this.lineMinRepeats, this.lineMinRatio, this.lineMinRows, {
      fenceState: 'unknown',
    })
    if (row === null) return false
    if (this.verdict !== null && this.verdict.kind === 'tail') {
      // 弱于「强行级证据」的行级结论不覆盖 tail（保持原来那层保护：tail 有精确的
      // period/span，文案更具体）。达到门槛的才换 —— 否则 reject 的 line 分支
      // 永远不可达，见 STREAM_LINE_STRONG_RATIO 的说明。
      if (row.ratio < STREAM_LINE_STRONG_RATIO) return false
    } else if (this.verdict !== null && row.repeats <= this.verdict.repeats) {
      // 同为 line 时量纲相同，次数不涨就不覆盖。
      return false
    }
    this.verdict = {
      turn: this.turn,
      step: this.step,
      kind: 'line',
      period: 0,
      repeats: row.repeats,
      span: 0,
      rows: row.rows,
      ratio: row.ratio,
      atDelta: this.deltas,
    }
    this.lastVerdict = { ...this.verdict, at: Date.now() }
    return true
  }

  /**
   * 当前结论。返回副本，避免调用方改到内部状态。
   * @returns {StreamVerdict | null} verdict
   */
  current() {
    if (this.verdict === null) return null
    if (this.phase === 'streaming') return null
    return { ...this.verdict }
  }

  /**
   * 只看结论、不管是否还在生成。供"下一个 step 开始时"读取。
   * @returns {StreamVerdict | null} verdict
   */
  peek() {
    return this.verdict === null ? null : { ...this.verdict }
  }

  /** 清空（压缩或新 turn 时用）。 */
  reset() {
    this.phase = 'idle'
    this.turn = null
    this.step = null
    this.text = ''
    this.deltas = 0
    this.verdict = null
    this.lastVerdict = null
  }
}

/**
 * 把流式结论写成一句给人看的话。**不复述原文** —— 把重复片段写进上下文等于
 * 再喂一次重复（mitigation 调研的结论：没有实证支持"复述后模型会停止"，而
 * 正反馈机制（Holtzman Fig.4）恰恰说复述会强化它）。所以这里只给数字。
 *
 * @param {{kind?: 'tail'|'line', period?: number, repeats?: number, span?: number, rows?: number, ratio?: number}} verdict - from the guard
 * @returns {string} one-line summary
 */
export function describeStreamVerdict(verdict) {
  const repeats = verdict?.repeats ?? 0
  if (verdict?.kind === 'line') {
    const rows = verdict?.rows ?? 0
    const ratio = Math.round((verdict?.ratio ?? 0) * 100)
    return `思考流尾部有一行内容已重复 ${repeats} 次（占 ${rows} 行里的 ${ratio}%）`
  }
  const period = verdict?.period ?? 0
  const span = verdict?.span ?? 0
  return `思考流尾部同一 ${period} 字符片段已连续重复 ${repeats} 遍（合计 ${span} 字符）`
}
