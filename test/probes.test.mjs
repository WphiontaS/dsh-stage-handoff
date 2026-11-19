// 探针判据的离线测试。
//
// 这些判据用来抓「思维链退化成 好。做。好。做。」，判错的代价是双向的：
// 漏报会让退化混过去，误报会把正常思考判成复读（本项目第一版判据就把
// 一次正常 refactor 判成复读，因为 ``` 在写代码的思考里天然高频）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BLOCK_REPEAT_RATIO,
  FRAGMENT_RUN,
  assessTurn,
  blockRepeat,
  fragmentation,
  isCodeish,
  isFiller,
  scanEventRing,
  shapeReasoning,
} from '../tools/probes/lib/repeat-analysis.mjs'

test('语气短行判据：中文语气词算，代码符号不算', () => {
  assert.equal(isFiller('好。'), true)
  assert.equal(isFiller('执行。'), true)
  assert.equal(isFiller('做。'), true)
  assert.equal(isFiller('OK.'), true, '英文语气词同样要抓')
  // 代码/结构行天然高频，必须排除
  assert.equal(isFiller('```'), false)
  assert.equal(isFiller('```js'), false)
  assert.equal(isFiller('}'), false)
  assert.equal(isFiller('})'), false)
  assert.equal(isFiller(');'), false)
  // 纯标点没有实词，不是语气词（真实误报：`...` 曾被算成重复碎片）
  assert.equal(isFiller('...'), false)
  assert.equal(isFiller('——'), false)
  // 太长的不算语气词
  assert.equal(isFiller('这是一句正常的说明文字。'), false)
  assert.equal(isCodeish('```'), true)
  assert.equal(isCodeish('好。'), false)
})

test('空的 reasoning 块不算碎片块', () => {
  // 只有工具调用、没有思考的 step 会传进空 text。
  // `[].every(...)` 恒为 true —— 漏掉这个判断，正常会话会被判成大面积复读
  // （真实误报：一个正常会话的 4 个 turn 因此被判可疑）。
  const empty = Array.from({ length: 8 }, (_, index) => ({ text: '', step: index }))
  const measured = fragmentation(empty)
  assert.equal(measured.longestRun, 0)
  assert.equal(measured.fillers, 0)

  const verdict = assessTurn(empty)
  assert.equal(verdict.suspicious, false)
  assert.deepEqual(verdict.reasons, [])
  // 空白字符也算空
  const blanks = Array.from({ length: 6 }, (_, index) => ({ text: '   \n  ', step: index }))
  assert.equal(assessTurn(blanks).suspicious, false)
})

test('单块复读：真复读命中，代码围栏重复不算', () => {
  const loop = ['好。', '好。', '好。', '好。'].join('\n')
  const verbatim = blockRepeat(loop)
  assert.equal(verbatim.maxRepeat, 4)
  assert.equal(verbatim.ratio, 1)

  // 这正是误报场景：写代码的思考里 ``` 出现很多次，但它不是复读。
  const code = ['```js', 'const a = 1', '```', '```js', 'const b = 2', '```', '```js', 'const c = 3', '```'].join('\n')
  const measured = blockRepeat(code)
  assert.equal(measured.maxRepeat, 0)
  assert.equal(measured.ratio, 0)
})

test('跨块碎片化：连续多个只有几个字的块会被记下来', () => {
  const fragments = ['好。', '执行。', '好。', '好。', '做。', '好。'].map((text) => ({ text, step: 0 }))
  const measured = fragmentation(fragments)
  assert.equal(measured.longestRun, fragments.length)
  assert.ok(measured.fillers >= 6)
  assert.equal(measured.topFiller, '好。')
  assert.equal(measured.topFillerCount, 4) // 好。/执行。/好。/好。/做。/好。 → 「好。」四次
})

test('截图那种「好。执行。好。好。做。」要判成可疑', () => {
  const pattern = ['好。', '执行。', '好。', '好。', '做。', '好。', '执行。', '好。', '输出。', '做。']
  const blocks = []
  // 20 个 step，每个 step 一条只有 1-2 行的 reasoning —— GUI 连起来显示就是这样
  for (let i = 0; i < 20; i += 1) {
    blocks.push({ text: pattern[i % pattern.length], step: i })
  }
  const verdict = assessTurn(blocks)
  assert.equal(verdict.suspicious, true)
  assert.ok(verdict.reasons.length >= 2)
  assert.ok(verdict.reasons.some((reason) => reason.includes('碎片块') || reason.includes('语气短行')))
})

test('内容各异的短句不能判成复读（误报回归）', () => {
  // 真实误报：4 步、每步两行、内容完全不重复的短句，因为每行都短，曾经被
  // 算成「连续碎片块 4 个」+「语气短行 8 条」双命中而判成退化。
  // 判据的根子是没有区分「好。做。」（2 个字，语气词）和「先读文件。」（5 个字，
  // 正常短句）—— SHORT_LINE 从 6 收到 4 之后这类块不再是碎片块。
  const blocks = ['先读文件。\n再看测试。', '读完了。\n没问题。', '改这行。\n再跑。', '再确认。\n好了。'].map(
    (text, step) => ({ text, step }),
  )
  const verdict = assessTurn(blocks)
  assert.equal(verdict.suspicious, false, `不该判成复读：${verdict.reasons.join('；')}`)
  assert.deepEqual(verdict.reasons, [])
  // 同时确认这些行里没有任何一行重复过 —— 这正是当时漏掉的证据。
  assert.equal(verdict.frag.topFillerCount, 1)
})

test('好。做。的四行形态必须算碎片块（漏报回归）', () => {
  // 碎片块的行数上限原来是 3，于是 `好。做。好。做。` 这种 4 行的最典型退化
  // 形态反而不算碎片块，longestRun 判据永远命中不了它。
  const blocks = Array.from({ length: 8 }, (_, index) => ({ text: '好。\n做。\n好。\n做。', step: index }))
  const verdict = assessTurn(blocks)
  assert.equal(verdict.suspicious, true, '8 个连续 4 行碎片块应该判成复读')
  assert.ok(verdict.frag.longestRun >= FRAGMENT_RUN)
})

test('正常的长思考不能被判成可疑', () => {
  const normal = [
    '先确认 API：`ctx.locale.getLocale()` 返回 snapshot，`getSnapshot()` 是 uSES 安全的。',
    '如果模块顶层读 `ctx`，factory 只拿到 `require`，会在渲染时抛 ReferenceError。',
    '修法是把取值移进 `apply`，并用 try 包住，因为不声明 inject 时访问该服务可能抛错。',
    '验证方式：用 `new Function` 执行文件、取工厂、真的调 `factory(require)`。',
  ]
  const blocks = normal.map((text, step) => ({ text, step }))
  const verdict = assessTurn(blocks)
  assert.equal(verdict.suspicious, false)
  assert.deepEqual(verdict.reasons, [])
})

test('判据需要两条同时命中，单条不足以定罪', () => {
  // 一块里某行重复 3 次，但只有这一块：不该判成可疑
  const blocks = [{ text: ['改：', 'x', '改：', 'y', '改：', 'z'].join('\n'), step: 0 }]
  const verdict = assessTurn(blocks)
  assert.equal(verdict.suspicious, false)
  assert.ok(verdict.worstBlock.repeat.maxRepeat >= 3)
  assert.ok(verdict.worstBlock.repeat.ratio < BLOCK_REPEAT_RATIO || verdict.reasons.length < 2)
})

test('连续 3 个碎片块还不到阈值，4 个才到', () => {
  const make = (count) =>
    Array.from({ length: count }, (_, index) => ({ text: `好。${index === 0 ? '' : ''}`, step: index }))
  const three = fragmentation(make(3))
  assert.ok(three.longestRun < FRAGMENT_RUN)
  const four = fragmentation(make(4))
  assert.ok(four.longestRun >= FRAGMENT_RUN)
})

test('shapeReasoning 只留形状，不留原文', () => {
  // 收尾流程要在内存事件环里判复读，而那个环刻意不存 assistant 内容。
  // 形状里混进一个字的原文，就等于悄悄破了这条约定。
  const loop = ['好。', '好。', '好。'].join('\n')
  const shape = shapeReasoning(loop)
  assert.equal(shape.rows, 3)
  assert.equal(shape.fillers, 3)
  assert.equal(shape.maxRepeat, 3)
  assert.equal(shape.repeatRatio, 1)
  assert.equal(shape.tiny, true)
  assert.ok(!JSON.stringify(shape).includes('好'), '形状里不能带原文')
})

test('scanEventRing 从事件环判定：同一 turn 的碎片累积起来才定罪', () => {
  // 6 个碎片块只满足「连续碎片块」，语气短行数还没到 FILLER_MIN(8)，
  // 单条信号不足以定罪 —— 所以这里用 8 个，两条信号同时成立。
  const facts = Array.from({ length: 8 }, (_, index) => ({
    type: 'assistant/message',
    seq: 100 + index,
    turn: 7,
    reasoning: shapeReasoning('好。'),
  }))
  const report = scanEventRing(facts)
  assert.equal(report.scanned, 8)
  assert.equal(report.verdicts.length, 1)
  assert.equal(report.verdicts[0].turn, 7)
  assert.ok(report.verdicts[0].suspicious)
  assert.ok(report.verdicts[0].reasons.length >= 2)

  // 分散在不同 turn 的单片语气词不该被连成一片
  const scattered = Array.from({ length: 8 }, (_, index) => ({
    type: 'assistant/message',
    seq: 200 + index,
    turn: index,
    reasoning: shapeReasoning('好。'),
  }))
  const scatteredReport = scanEventRing(scattered)
  assert.equal(scatteredReport.verdicts.length, 0, '散落在不同 turn 的碎片不足以定罪')
})

test('scanEventRing 跳过没有 reasoning 形状的事件', () => {
  const report = scanEventRing([
    { type: 'assistant/message', seq: 1, turn: 1 },
    { type: 'tool/call', seq: 2 },
    null,
  ])
  assert.equal(report.scanned, 0)
  assert.deepEqual(report.verdicts, [])
})
