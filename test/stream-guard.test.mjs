// 流式增量检测的离线测试。
//
// 这个模块只跑在内存里（帧来自 `agent/assistant-stream`），所以测试就是把帧序列
// 喂给它 —— 不需要模型、不需要引擎。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  ReasonStreamGuard,
  STREAM_LINE_STRONG_RATIO,
  STREAM_MIN_REPEATS,
  STREAM_MIN_SPAN,
  describeStreamVerdict,
  repeatedRow,
} from '../lib/stream-guard.js'

/** 一帧 `agent/assistant-stream` 的 payload。 */
const frame = (body) => ({ frame: body })
/** 一个 reasoning 增量帧。 */
const delta = (text) => frame({ type: 'chunk', chunk: { type: 'reasoning-delta', text } })
/** 一个正文增量帧（应被忽略）。 */
const textDelta = (text) => frame({ type: 'chunk', chunk: { type: 'text-delta', text } })
/** attempt 开始帧。 */
const start = (turn = 1, step = 1) => frame({ type: 'start', turn, step })
/** attempt 结束帧。 */
const end = () => frame({ type: 'end' })

test('正常思考流不会触发', () => {
  const guard = new ReasonStreamGuard()
  guard.onFrame(start())
  const lines = [
    '先确认 ctx.locale.getLocale() 返回的是 snapshot，getSnapshot() 才安全。',
    '如果模块顶层读 ctx，factory 只拿到 require，会在渲染时抛 ReferenceError。',
    '修法是把取值移进 apply，并用 try 包住，因为不声明 inject 时可能抛错。',
    '验证方式是用 new Function 执行文件、取工厂、真的调用 factory。',
    '另外 schema 是惰性取得的，静态 import 会在模块解析阶段就失败。',
  ]
  for (const line of lines) guard.onFrame(delta(`${line}\n`))
  assert.equal(guard.peek(), null, '正常内容不能产生复读结论')
  assert.equal(guard.current(), null)
})

test('思考流尾部原地重复必须被抓到', () => {
  const guard = new ReasonStreamGuard({ checkEvery: 8 })
  guard.onFrame(start(7, 3))
  // 先给一段正常内容，再开始复读：复读必须被识别为"尾部重复"
  guard.onFrame(delta('先看 status，然后提交。\n'))
  let hits = 0
  for (let index = 0; index < 120; index += 1) {
    if (guard.onFrame(delta(['做。', '好。', '执行。'][index % 3]))) hits += 1
  }
  const verdict = guard.peek()
  assert.notEqual(verdict, null, '反复读必须产生结论')
  assert.equal(verdict.turn, 7)
  assert.equal(verdict.step, 3)
  assert.equal(verdict.period, 7, '「做。好。执行。」是一个 7 字符的重复单位')
  assert.ok(verdict.repeats >= STREAM_MIN_REPEATS)
  assert.ok(verdict.span >= STREAM_MIN_SPAN, `重复覆盖要够长：${verdict.span}`)
  assert.ok(hits >= 1, '至少要报告一次')
})

test('流式判据比离线更严：尾部只重复 3 遍不算', () => {
  // 离线使用 TAIL_MIN_REPEATS = 3，流式要 5 —— 生成到一半时"重复 3 遍"可能只是排比句，
  // 而流式误报会往上下文里塞一句错误的"你在复读"。
  assert.equal(STREAM_MIN_REPEATS, 5)
  const guard = new ReasonStreamGuard({ checkEvery: 2 })
  guard.onFrame(start())
  guard.onFrame(delta('这一段的结论很明确。'.repeat(3)))
  assert.equal(guard.peek(), null, '重复 3 遍不能触发流式判据')
  // 同样的内容在离线判据下是成立的（对照组）
})

test('只报告，不截断：模块不动帧、也不消费内容', () => {
  // PREWARN 实测 windowed repetition score 在"非退化长答案"上触发 79.5–100%，
  // 所以这个模块**绝不能**成为停止条件。它只产出一句结论，由调用方决定要不要提醒。
  const guard = new ReasonStreamGuard({ checkEvery: 4 })
  guard.onFrame(start())
  const seen = []
  for (let index = 0; index < 120; index += 1) {
    const payload = delta('做。')
    seen.push(payload)
    guard.onFrame(payload)
  }
  // 帧对象原样保留（没有被删改），这说明它没有"吃掉"流
  assert.equal(seen.length, 120)
  for (const payload of seen) assert.equal(payload.frame.chunk.text, '做。')
  assert.notEqual(guard.peek(), null)
})

test('start 帧重置状态，end 帧后 current 让位给 peek', () => {
  const guard = new ReasonStreamGuard({ checkEvery: 4 })
  guard.onFrame(start(2, 1))
  for (let index = 0; index < 120; index += 1) guard.onFrame(delta('做。'))
  assert.notEqual(guard.peek(), null)
  // 还在生成时 current() 返回 null：结论要等这一步落定才对外可见
  assert.equal(guard.current(), null)
  guard.onFrame(end())
  assert.notEqual(guard.current(), null, '落定之后 current() 才给结论')
  // 新 attempt 开新账
  guard.onFrame(start(3, 1))
  assert.equal(guard.peek(), null, 'start 必须清掉上一轮的结论')
})

test('正文增量不参与判定', () => {
  const guard = new ReasonStreamGuard({ checkEvery: 2 })
  guard.onFrame(start())
  for (let index = 0; index < 200; index += 1) guard.onFrame(textDelta('做。'))
  assert.equal(guard.peek(), null, '只统计 reasoning-delta')
})

test('结论文案只给数字，不复述重复原文', () => {
  // 把重复片段写进上下文等于再喂一次重复（正反馈），所以文案里不能出现原文。
  const summary = describeStreamVerdict({ period: 7, repeats: 120, span: 840 })
  assert.match(summary, /7 字符/)
  assert.match(summary, /120 遍/)
  assert.match(summary, /840 字符/)
  assert.equal(summary.includes('做。'), false)
})

/**
 * 真实复读的形态：主周期被**周期性插入**打断。
 *
 * 取自成品数据 `session-bbb00002` turn 60 的十个块 —— 那里「好。」重复 108–176 次，
 * 中间每十来行插一条「（输出）」或「（好，输出）」。这种文本的 `trailingRepeat`
 * 返回 null（严格周期被插入打断），但行级计数一目了然。
 */
function brokenPeriodLoop(count = 100) {
  const rows = []
  for (let index = 0; index < count; index += 1) {
    rows.push('好。')
    if (index % 12 === 11) rows.push('（输出）')
    if (index % 20 === 19) rows.push('（好，输出）')
  }
  return rows.join('\n\n')
}

/** 一段长度相当、行内容各不相同的正常思考。 */
function variedProse(rows = 120) {
  const out = []
  for (let index = 0; index < rows; index += 1) {
    out.push(`第 ${index} 条的结论是读取 config 文件里第 ${index * 7} 行的字段，然后核对它的默认值。`)
  }
  return out.join('\n\n')
}

test('repeatedRow 默认按窗口语义解析围栏（起点未知）', () => {
  // 这个默认值本身是一条契约：`repeatedRow` 的输入永远是窗口后缀，不是完整文本。
  // 把它退回 `'outside'` 会让「起点落在围栏内」的窗口整段失效，而调用点在深层，
  // 只靠端到端用例容易漏 —— 所以这里直接钉默认值。
  const code = Array.from({ length: 40 }, (_, index) => `const value${index} = compute(${index})`)
  const window = [...code, '```', ...Array.from({ length: 60 }, () => '好。')].join('\n')
  const measured = repeatedRow(window, 10, 0.5, 20)
  assert.notEqual(measured, null, '默认必须按「起点未知」处理')
  assert.equal(measured.repeats, 60)
  assert.equal(
    repeatedRow(window, 10, 0.5, 20, { fenceState: 'outside' }),
    null,
    '显式 outside 时第一个标记仍是开围栏，行为与整块判据一致',
  )
})

test('窗口起点落在围栏内部时，行级判据仍然命中', () => {
  // 守卫拿到的是 `slice(-4096)` 的后缀。起点可能落在代码块中间，此时窗口里唯一的
  // 围栏标记是「闭」。按「第一个标记就是开」处理会把它当开，其后所有散文行被吞，
  // 行级判据整段失效 —— 实测 140 行真实复读被判成 0 行、`peek()` 返回 null。
  const guard = new ReasonStreamGuard({ checkEvery: 8 })
  guard.onFrame(start(4, 2))
  // 前 40 个 delta 是围栏内的代码，第 41 个 delta 是闭围栏，之后才是复读。
  for (let index = 0; index < 40; index += 1) {
    guard.onFrame(delta(`const value${index} = compute(${index})\n`))
  }
  guard.onFrame(delta('```\n'))
  for (let index = 0; index < 60; index += 1) guard.onFrame(delta('好。\n'))
  const verdict = guard.peek()
  assert.notEqual(verdict, null, '闭围栏之后的复读必须被看见')
  assert.equal(verdict.kind, 'line', '这是行级形态，不是严格周期')
  assert.ok(verdict.repeats >= 10, `行重复次数：${verdict.repeats}`)
})

test('同一 turn 里先轻度后严重时，reject 不能被「已提醒过」压住', () => {
  // 判据本身在 lib/index.js 的 pre-step 里，这条只钉住 guard 这一侧的输入：
  // 先给一个「过 0.5 检测线但不过 0.8 reject 线」的结论，再升级成 0.8 以上。
  // 两个结论必须都拿得到，否则 reject 永远等不到它自己的证据。
  const guard = new ReasonStreamGuard({ checkEvery: 4, lineMinRepeats: 10, lineMinRatio: 0.5 })
  guard.onFrame(start(9, 1))
  for (let index = 0; index < 12; index += 1) guard.onFrame(delta('好。\n'))
  for (let index = 0; index < 12; index += 1) guard.onFrame(delta(`第 ${index} 行正常内容。\n`))
  const mild = guard.peek()
  assert.notEqual(mild, null, '0.5 线以上的形态要能被看见')
  assert.ok(mild.ratio < 0.8 || mild.kind === 'tail', '这一步还不该到 reject 线')
  for (let index = 0; index < 80; index += 1) guard.onFrame(delta('好。\n'))
  const severe = guard.peek()
  assert.notEqual(severe, null, '升级后的结论必须更新')
  assert.ok(
    severe.repeats > mild.repeats,
    `严重形态的读数必须更大：${severe.repeats} vs ${mild.repeats}`,
  )
})

test('主周期被打断的复读也要抓到（严格周期看不见它）', () => {
  // 事故现场：这类块离线判据全部命中（单行重复 108–176 次、5.2–10.1σ），
  // 而旧守卫只看 trailingRepeat，十个块一个都没响。
  const text = brokenPeriodLoop(100)
  const guard = new ReasonStreamGuard({ checkEvery: 8 })
  guard.onFrame(start())
  for (let at = 0; at < text.length; at += 40) guard.onFrame(delta(text.slice(at, at + 40)))
  guard.onFrame(end())
  const verdict = guard.current()
  assert.notEqual(verdict, null, '这种形态必须被抓到')
  assert.equal(verdict.kind, 'line')
  assert.ok(verdict.repeats >= 30, `单行重复应不少于 30 次，实际 ${verdict.repeats}`)
  assert.ok(verdict.ratio >= 0.5, `重复行应占行数一半以上，实际 ${verdict.ratio}`)
})

test('行级判据不误伤正常长答案', () => {
  // 正常的清单/步骤每行都不同，同一行重复 10 次不该出现。
  const guard = new ReasonStreamGuard({ checkEvery: 8 })
  guard.onFrame(start())
  const text = variedProse(120)
  for (let at = 0; at < text.length; at += 40) guard.onFrame(delta(text.slice(at, at + 40)))
  guard.onFrame(end())
  assert.equal(guard.peek(), null)
})

test('行级阈值 10：中度复读要抓到，不必等到 30 次', () => {
  // 校准依据（239 个会话、31,563 个真实 reasoning 块）：
  //   阈值 30 → 命中 499 块；阈值 10 + 行数>=20 → 命中 658 块（+32%）。
  // 差集那一段抽看全是 `Go.` ×16、`好。` ×23 这种已经在打转的块，
  // 原阈值整段漏掉。这里用 14 次重复构造：旧阈值(30)抓不到，新阈值(10)必须抓到。
  const guard = new ReasonStreamGuard({ checkEvery: 8 })
  guard.onFrame(start())
  const lines = []
  for (let index = 0; index < 26; index += 1) {
    lines.push(index % 2 === 0 ? '好。' : `第 ${index} 步的结论是核对默认值再写下去，这一行不重复。`)
  }
  // 26 行里 13 行是「好。」= 50%，重复 13 次
  const text = lines.join('\n\n')
  for (let at = 0; at < text.length; at += 40) guard.onFrame(delta(text.slice(at, at + 40)))
  guard.onFrame(end())
  const verdict = guard.current()
  assert.notEqual(verdict, null, '13 次重复 + 50% 占比必须命中')
  assert.equal(verdict.kind, 'line')
  assert.equal(verdict.repeats, 13)
})

test('行数下限 20：短窗口里的比例不算数', () => {
  // 实测阈 8 的 3 个误报（INFO ok 12 行、return 14 行、'', 38 行）全落在短窗口里，
  // 而真复读样本是 80 / 112 / 229 行。12 行里 8 行相同就是 67%，比例判据在短窗口
  // 上没有意义，所以行数不足时直接不下结论。
  const short = Array.from({ length: 8 }, () => 'INFO ok').join('\n\n')
  assert.equal(repeatedRow(short, 10, 0.5), null, '8 行不足 20 行下限')
  // 同一形态补足行数就应当命中（证明挡住它的是行数，不是次数或比例）
  const long = Array.from({ length: 10 }, () => 'INFO ok')
    .concat(Array.from({ length: 14 }, (_, index) => `第 ${index} 行是别的正常内容，写得长一些。`))
    .join('\n\n')
  assert.equal(repeatedRow(long, 10, 0.5), null, '24 行里 10 行 = 42%，不到 0.5')
  const denser = Array.from({ length: 22 }, (_, index) => (index % 2 === 0 ? 'INFO ok' : `第 ${index} 行别的内容。`)).join('\n\n')
  assert.notEqual(repeatedRow(denser, 10, 0.5), null, '22 行里 11 行 = 50%，该命中')
})

test('短块在收尾时补检查（delta 数可能不到一个检查周期）', () => {
  // 实测有 703 字符的块：40 字符/delta 只有 18 个 delta，checkEvery=24 时
  // 一次都不会进检查点。而短块恰恰是最典型的退化形态。
  const text = brokenPeriodLoop(40)
  const short = text.slice(0, 700)
  const guard = new ReasonStreamGuard({ checkEvery: 24 })
  guard.onFrame(start())
  for (let at = 0; at < short.length; at += 40) guard.onFrame(delta(short.slice(at, at + 40)))
  assert.equal(guard.peek(), null, 'delta 数不足时循环里不该有结论')
  guard.onFrame(end())
  assert.notEqual(guard.peek(), null, 'end 必须补一次检查')
})

test('行级结论的文案同样不复述原文', () => {
  const summary = describeStreamVerdict({ kind: 'line', repeats: 141, rows: 160, ratio: 0.88 })
  assert.match(summary, /141 次/)
  assert.match(summary, /88%/)
  assert.equal(summary.includes('好。'), false)
  assert.equal(summary.includes('输出'), false)
})

test('totalDeltas 只增不减，是监听是否接上的唯一证据', () => {
  // lastVerdict 只能回答"检测到过没有"；监听根本没接上时它同样是 null。
  // 这个计数把两者分开：0 = 帧没到，非 0 = 到了但判据没命中或提醒没发出去。
  const guard = new ReasonStreamGuard({ checkEvery: 4 })
  assert.equal(guard.totalDeltas, 0, '初始为 0')
  guard.onFrame(start(1, 1))
  for (let index = 0; index < 5; index += 1) guard.onFrame(delta('普通思考。\n'))
  assert.equal(guard.totalDeltas, 5)
  guard.onFrame(end())
  // 新 step 的 start 会清 deltas 和 verdict，但 totalDeltas 必须留着
  const before = guard.totalDeltas
  guard.onFrame(start(1, 2))
  assert.equal(guard.deltas, 0, 'deltas 每步归零')
  assert.equal(guard.totalDeltas, before, 'totalDeltas 不能被 start 清掉')
  guard.onFrame(delta('又一段。\n'))
  assert.equal(guard.totalDeltas, before + 1)
  // 正文帧不计入
  guard.onFrame(textDelta('正文增量'))
  assert.equal(guard.totalDeltas, before + 1, '只统计 reasoning-delta')
})

test('lastVerdict 扛过 start，只有 reset 才清', () => {
  // 「检测到了」这件事必须能跨 step 留存 —— 否则 status 永远看不出守卫工作过。
  const guard = new ReasonStreamGuard({ checkEvery: 2 })
  guard.onFrame(start(7, 3))
  const text = brokenPeriodLoop(40)
  for (let at = 0; at < text.length; at += 40) guard.onFrame(delta(text.slice(at, at + 40)))
  guard.onFrame(end())
  assert.notEqual(guard.lastVerdict, null, '检测到之后必须留下记录')
  const recorded = guard.lastVerdict
  assert.equal(recorded.turn, 7)
  assert.equal(recorded.step, 3)
  // 下一步开始
  guard.onFrame(start(7, 4))
  assert.equal(guard.peek(), null, '每步的结论仍按设计清空')
  assert.deepEqual(guard.lastVerdict, recorded, 'lastVerdict 不该被 start 清掉')
  guard.reset()
  assert.equal(guard.lastVerdict, null, 'reset 才清')
})

// ── 集成约束：这类问题单元测试一条都抓不到 ──────────────────────────────────
//
// 这一组用源码断言守着「框架契约」。它们丑，但每一个都对应一次**零报错**的失效：
// 钩子注册少一个选项，功能就整段不工作，而类型、测试、日志全都说没问题。

const indexSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js'), 'utf8')

test("agent/assistant-stream 必须带 { global: true } 注册", () => {
  // 这个 hook 的签名是 `this: Scoped<Agent>`，默认只在注册者 scope 内触发。
  // 插件自己的 ctx 不是任何 agent 的 scope —— 不带 global 就**一帧都收不到**，
  // 而且完全不报错。DSH 内部两处订阅都显式带了它。
  const call = /ctx\.on\(\s*'agent\/assistant-stream'[\s\S]{0,900}?\n\s*\)/.exec(indexSrc)
  assert.notEqual(call, null, '必须能找到这个注册')
  assert.match(
    call[0],
    /\{\s*global:\s*true\s*\}/,
    '缺 { global: true }：守卫会静默地收不到任何流式帧',
  )
})

test('守卫按会话隔离，不能全局共用一份', () => {
  // 带上 global 之后所有 agent 的帧都进同一个回调，共用一个实例会让两个会话
  // 互相污染尾部窗口。隔离键必须是 session。
  assert.match(indexSrc, /new WeakMap\(\s*\)/, '需要 WeakMap 做按会话隔离')
  assert.match(
    indexSrc,
    /const streamGuardFor = \(session\)/,
    '必须有 streamGuardFor(session) 这类按会话取守卫的入口',
  )
  // 三个用点都必须走隔离入口，直接碰全局实例就会漏隔离
  const directUses = [...indexSrc.matchAll(/\bglobalStreamGuard\b/g)].length
  assert.ok(
    directUses <= 3,
    `globalStreamGuard 应只在创建与兜底处出现（当前 ${directUses} 次），多了说明有地方绕过了隔离`,
  )
})

test('整窗都在未闭合围栏里时，词行代码的重复也不命中', () => {
  // `isCodeish` 是逐行正则，认不出 `git status` / `TODO` / `pass` 这类**没有 ASCII
  // 标点**的词行。只在 sample 上判散文资格不够：未闭合围栏里 200 行 `git status`
  // 的 sample 本身看起来就是散文行。所以 tail 分支还要求**整个尾窗**里真有散文行。
  //
  // 文本带引导语（真实 reasoning 几乎总是「看代码：」这类引子在前），否则整段
  // reasoning 以围栏开头时，`fenceState: 'unknown'` 会把开围栏当闭合围栏 —— 那是
  // 另一个已知的极端形态，见审计报告里的残留记录。
  for (const line of ['git status', 'TODO', 'pass']) {
    const text = '我跑几条命令看看：\n```bash\n' + Array.from({ length: 200 }, () => line).join('\n')
    const guarded = new ReasonStreamGuard()
    guarded.onFrame(start())
    guarded.onFrame(delta(text))
    guarded.onFrame(frame({ type: 'end', outcome: { kind: 'abandoned' } }))
    assert.equal(guarded.peek(), null, `未闭合围栏内的 「${line}」 重复不算思考复读`)
  }

  // 对照：同一段围栏代码之后接正常散文复读，仍必须命中（窗口里有散文行）。
  const withProse = '我跑几条命令看看：\n```bash\n'
    + Array.from({ length: 40 }, () => 'git status').join('\n') + '\n```\n'
    + Array.from({ length: 20 }, () => '我需要再确认一下这条路能不能走通。').join('\n')
  const mixed = new ReasonStreamGuard()
  mixed.onFrame(start())
  mixed.onFrame(delta(withProse))
  mixed.onFrame(frame({ type: 'end', outcome: { kind: 'abandoned' } }))
  assert.notEqual(mixed.peek(), null, '窗口里有散文行时，尾部复读仍要报')
})

test('两条判据共享散文资格：围栏内的重复代码不算思考复读', () => {
  // 行级分支走 `proseRows`（跳过围栏与代码行），严格周期是纯文本判据 —— 它看不见结构。
  // 于是同一个窗口：弱判据放过、强判据报警。实测未闭合 python 围栏内 40 行相同 print，
  // 严格周期给出 period=27 repeats=40 span=1080，行级分支给 null。
  const code = '```python\n' + 'print("processing record")\n'.repeat(40)
  const guarded = new ReasonStreamGuard()
  guarded.onFrame(start())
  guarded.onFrame(delta(code))
  guarded.onFrame(frame({ type: 'end', outcome: { kind: 'abandoned' } }))
  assert.equal(guarded.peek(), null, '围栏内重复代码不构成思考复读')

  // 对照：同量级的**散文**复读必须仍然命中，否则这条修复就变成了漏报。
  const prose = '我先确认一下这条路能不能走通，然后再决定要不要改实现。'.repeat(8)
  const proseGuard = new ReasonStreamGuard()
  proseGuard.onFrame(start())
  proseGuard.onFrame(delta(prose))
  proseGuard.onFrame(frame({ type: 'end', outcome: { kind: 'abandoned' } }))
  assert.notEqual(proseGuard.peek(), null, '中文散文复读必须仍然命中')
  assert.equal(proseGuard.peek().kind, 'tail', '散文复读走严格周期分支')
})

test('无围栏的裸代码重复同样不命中（散文资格不依赖围栏标记）', () => {
  // 判据问的是「重复单位里有没有散文行」，不是「有没有 ``` 」。模型不写围栏、
  // 直接吐 40 行相同调用，同样是代码而不是思考打转。
  const bare = 'print("processing record")\n'.repeat(40)
  const guarded = new ReasonStreamGuard()
  guarded.onFrame(start())
  guarded.onFrame(delta(bare))
  guarded.onFrame(frame({ type: 'end', outcome: { kind: 'abandoned' } }))
  assert.equal(guarded.peek(), null, '裸代码重复也不算思考复读')
})

test('强行级证据可以覆盖已有 tail 结论（tail 锁死 line 会让 reject 静默失效）', () => {
  // 两种判据的 `repeats` **不同量纲**：tail 是同一片段连续重复的遍数，line 是顶行
  // 在窗口里出现的次数。所以「谁更严重」不能比次数。原来 `check()` 里一句
  // `verdict.kind === 'tail' → return false` 让 line 在本 step 永久失声：先中一个
  // 弱 tail，之后模型升级成占满窗口的行级洪泛，结论仍停在 tail 上 —— 而
  // `rejectOnRepeat` 的 `kind === 'line'` 分支正是按占比判定的，于是永远走不到。
  const guarded = new ReasonStreamGuard()
  guarded.onFrame(start())

  // 阶段 A：24 个 delta 全是同一字符 → 第 24 个 delta 触发检查，尾部纯周期重复。
  for (let i = 0; i < 24; i += 1) guarded.onFrame(delta('x'.repeat(84)))
  const afterTail = guarded.peek()
  assert.equal(afterTail?.kind, 'tail', '阶段 A 应当先给出 tail 结论')

  // 阶段 B：改成行级洪泛（同一行占满窗口）。再 24 个 delta，第 48 个触发检查。
  for (let i = 0; i < 24; i += 1) guarded.onFrame(delta('好。\n'))
  const afterLine = guarded.peek()
  assert.equal(afterLine?.kind, 'line', '强行级证据必须覆盖弱的 tail 结论')
  assert.ok(
    afterLine.ratio >= STREAM_LINE_STRONG_RATIO,
    `覆盖门槛是强行级占比（当前 ${afterLine.ratio}）`,
  )
})

test('弱于强行级的行级证据不覆盖 tail（保持原来的保护）', () => {
  // 反向保护：只比检测线略高的行级结论不该把带 period/span 的 tail 文案冲掉。
  const guarded = new ReasonStreamGuard()
  guarded.onFrame(start())
  for (let i = 0; i < 24; i += 1) guarded.onFrame(delta('x'.repeat(84)))
  assert.equal(guarded.peek()?.kind, 'tail', '前提：先有 tail 结论')

  // 21 行里 11 行相同 = 0.52，越过检测线 0.5 但远低于 0.8。
  const weak = [...Array.from({ length: 10 }, (_, i) => `第 ${i} 行是不同的正常内容`), ...Array.from({ length: 11 }, () => '好。')].join('\n')
  for (let i = 0; i < 24; i += 1) guarded.onFrame(delta(i === 0 ? weak : ''))
  assert.equal(guarded.peek()?.kind, 'tail', '弱的行级证据不能覆盖 tail')
})

