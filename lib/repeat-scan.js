// 复读检测：把一段思考压成「形状」，再按 turn 判定是否退化。
//
// 为什么是「形状」而不是原文：会话事件环刻意不保留 assistant 内容
// （见 lib/index.js 的 recentFactFromEvent —— 摘要全文都只留在内存环里，
// 不落第二份磁盘副本）。收尾流程要判复读，只需要几个整数：
// 行数、语气短行数、最高行重复次数、重复字符占比。原文在这里没有用武之地，
// 所以这个模块既服务于磁盘日志探针，也服务于内存环，两条路共用同一套阈值。
//
// 退化的两种形态：
//   A. 单块内复读 —— 一条 reasoning 里同一行反复出现（「好。好。好。…」）
//   B. 跨块碎片化 —— 同一 turn 里连续多个 reasoning 块都只有几个字的语气词
//
// 必须排除代码行：` ``` `、`}`、`})` 在写代码的思考里天然高频。第一版没排除，
// 把一次正常 refactor 判成了复读（turn 里 ` ``` ` 重复 79 次）。

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

const CODEISH = /[`{}()[\];=<>|\\]|^\s*[-*+]\s|^\s*#|^\s*\d+[.)]\s/

/**
 * 是代码/结构行而不是语气词。
 * @param {string} line - one trimmed line
 * @returns {boolean} true when the line looks like code or list markup
 */
export const isCodeish = (line) => CODEISH.test(line)

/**
 * 语气短行：短、非代码，而且**得有实词**。
 * 只按长度判会把 `...`、`———` 这类纯标点算成语气词（真实误报：某会话的
 * turn 里 `...` 出现 8 次就被当成了复读信号）。
 * @param {string} line - one trimmed line
 * @returns {boolean} true when the line reads as filler
 */
export const isFiller = (line) =>
  line.length > 0 && line.length <= SHORT_LINE && !isCodeish(line) && /[A-Za-z\u4e00-\u9fa5]/.test(line)

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
 * 取散文行：去掉代码行，并整段跳过围栏代码块。
 *
 * `isCodeish` 是逐行正则，没有状态：围栏里只要有一行不含 ASCII 标点（`return value`、
 * `pass`、`git status`、`a,b`），那一行就会被当成散文行参与复读统计 —— 于是一段
 * 纯代码引用既能污染「单块复读」百分比，也能在块足够小时独立触发复读告警。
 * 模块头把「排除代码行」列成既定要求，这里把围栏也算进去。
 *
 * @param {string} text - reasoning body
 * @returns {string[]} prose rows
 */
export function proseRows(text) {
  const rows = []
  /** @type {string | undefined} */
  let fence
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    const marker = /^(`{3,}|~{3,})/.exec(line)
    if (marker !== null) {
      if (fence === undefined) fence = marker[1]
      else if (marker[1][0] === fence[0]) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    if (isCodeish(line)) continue
    rows.push(line)
  }
  return rows
}

/**
 * 把一段思考压成形状。不保留任何原文。
 * @param {string} text - reasoning body
 * @returns {{chars: number, rows: number, fillers: number, maxRepeat: number, repeatRatio: number, tiny: boolean}} shape
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
  return {
    chars,
    rows: rows.length,
    fillers,
    maxRepeat,
    repeatRatio: chars === 0 ? 0 : dupChars / chars,
    tiny,
  }
}

/**
 * 从一组形状判定一个 turn。
 * @param {Array<{chars?: number, rows?: number, fillers?: number, maxRepeat?: number, repeatRatio?: number, tiny?: boolean}>} shapes - per-block shapes in step order
 * @returns {{suspicious: boolean, reasons: string[], repeatSignal: boolean, longestRun: number, fillers: number, fillerRatio: number, worstRepeatRatio: number}} verdict
 */
export function assessShapes(shapes) {
  const list = Array.isArray(shapes) ? shapes : []
  let run = 0
  let longestRun = 0
  let fillers = 0
  let rows = 0
  let worstRepeatRatio = 0
  let worstMaxRepeat = 0
  for (const shape of list) {
    if (shape?.tiny === true) {
      run += 1
      longestRun = Math.max(longestRun, run)
    } else {
      run = 0
    }
    fillers += shape?.fillers ?? 0
    rows += shape?.rows ?? 0
    if ((shape?.repeatRatio ?? 0) > worstRepeatRatio) {
      worstRepeatRatio = shape?.repeatRatio ?? 0
      worstMaxRepeat = shape?.maxRepeat ?? 0
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
  return {
    suspicious: reasons.length >= 2,
    reasons,
    repeatSignal,
    longestRun,
    fillers,
    fillerRatio,
    worstRepeatRatio,
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
 * @returns {{suspicious: boolean, reasons: string[], frag: object, worstBlock: object|null}} verdict
 */
export function assessTurn(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const shapes = list.map((block) => shapeReasoning(block?.text ?? ''))
  const verdict = assessShapes(shapes)
  let worstIndex = -1
  for (let index = 0; index < shapes.length; index += 1) {
    if (worstIndex < 0 || shapes[index].repeatRatio > shapes[worstIndex].repeatRatio) worstIndex = index
  }
  return {
    suspicious: verdict.suspicious,
    reasons: verdict.reasons,
    frag: fragmentation(list),
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
