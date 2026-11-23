import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm as removePath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Config, collectToolFacts, coverageForRange, isSurfaceRace, noticeText, readLatestSummaryWindow } from '../lib/index.js'
import {
  TIME_ZONE_PATTERN,
  normalizeTimeZone,
  resolveConfig,
  resolveConfigLenient,
} from '../lib/config.js'
import { createBoundedJsonlWriter } from '../lib/prestep-log.js'
import { formatCount, sameIdentity } from '../lib/util.js'
import { formatBytes } from '../lib/usage.js'

const rm = (target) => removePath(target, { recursive: true, force: true })
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * 回归测试。
 *
 * 这里每条都对应一次真实缺陷：修复之后**只有**这条测试能拦住它复发。
 * 教训来自这轮审查 —— `hasGap` 那个 bug 活了很久，因为原测试把原始 state
 * 直接喂给 `coverageForRange`，绕过了归一化函数，正好绕开缺陷所在的那一层。
 * 所以这里的用例一律走**生产调用路径**，不直接调被测函数的下一层。
 */

test('事件环有缺口时必须报 partial-gap，即使经由生产调用路径（hasGap 回归）', () => {
  // `readRecentFactsState` 曾经在归一化时丢掉 hasGap，于是 `coverageForRange`
  // 的 partial-gap 分支在所有生产路径上都不可达：环中间真漏了事件也报「完整」。
  // 关键点：**不要**把 ring 直接喂给 coverageForRange —— 那样测试会绕开缺陷。
  const ring = {
    recent: [
      { seq: 0, type: 'user/message' },
      { seq: 1, type: 'assistant/message' },
      // 2..5 故意缺失：插件停用期或监听器抛错过的窗口
      { seq: 6, type: 'assistant/message' },
      { seq: 7, type: 'assistant/message' },
    ],
    mountSeq: 0,
    firstRetainedSeq: 0,
    lastObservedSeq: 7,
    truncatedByCount: false,
    truncatedByBytes: false,
    hasGap: true,
    bytes: 0,
  }
  const session = { seq: 8 }

  const toolFacts = collectToolFacts(session, 100, () => ring)
  assert.equal(toolFacts.coverage, 'partial-gap', '工具轨迹必须知道中间有洞')

  const summaryWindow = readLatestSummaryWindow(session, 100, () => ring)
  assert.equal(summaryWindow.coverage, 'partial-gap', '摘要窗口必须知道中间有洞')

  // 对照组：同样的环但不带缺口，必须报 complete —— 否则上面两条可能只是
  // 「永远报 partial」。
  const contiguous = { ...ring, hasGap: false }
  assert.equal(collectToolFacts(session, 100, () => contiguous).coverage, 'complete')
})

test('配置里一个坏字段只丢它自己，不能整份回退（enabled:false 必须被尊重）', () => {
  // 真实事故形态：schema 里 dshHome 只是 string，相对路径通过校验、在解析器
  // 抛错、apply() 回退 resolveConfig({}) —— 用户明确关掉的插件照常挂载，
  // 绝对 anchorRoot 也一起丢。
  const raw = {
    enabled: false,
    dshHome: 'relative/not-absolute',
    anchorRoot: 'D:/team/anchors',
    notifyTokens: '900k',
  }
  assert.throws(() => resolveConfig(raw), /绝对路径/, '前提：这份配置整体解析必须失败')

  const lenient = resolveConfigLenient(raw)
  assert.deepEqual(lenient.dropped, ['dshHome'], '只该丢掉坏字段')
  assert.equal(lenient.config.enabled, false, '明确的关闭不能被丢掉')
  assert.equal(lenient.config.anchorRoot, 'D:/team/anchors', '其它合法字段必须保留')
  assert.equal(lenient.config.notifyTokens, 921600)

  // 干净配置不该进降级路径。
  const clean = resolveConfigLenient({ enabled: false })
  assert.deepEqual(clean.dropped, [])
  assert.equal(clean.config.enabled, false)
})

test('anchorTimeZone 的 schema 与解析器接受集双向一致', () => {
  // 两边不一致的两种方向里，「schema 放行而解析器拒绝」是危险的：挂载期
  // resolveConfig 抛错，整份配置降级。另一个方向只是报错文案难懂。
  // 穷举 0–16 时 × 0–65 分的各种写法，外加三位分钟数与首尾空白。
  /** @type {Set<string | number>} */
  const values = new Set(['local', 'utc', 'z', 'LOCAL', ' local ', ' +8', '+8 ', 'local '])
  for (let hour = 0; hour <= 16; hour += 1) {
    for (let minute = 0; minute <= 65; minute += 1) {
      const hh = String(hour).padStart(2, '0')
      const mm = String(minute).padStart(2, '0')
      values.add(`+${hour}:${mm}`)
      values.add(`-${hour}:${mm}`)
      values.add(`+${hh}${mm}`)
      values.add(`-${hh}${mm}`)
    }
    values.add(`+${hour}`)
    values.add(`-${hour}`)
  }
  // 三位分钟数：`+053` 唯一可读成 53 分钟，曾经被 schema 拒掉。
  for (const digits of ['000', '001', '053', '099', '100', '300', '720', '840', '841', '900']) {
    values.add(`+${digits}`)
    values.add(`-${digits}`)
  }
  for (const number of [0, 480, -300, 840, -720, 900, -900]) values.add(number)

  // schema 的数字分支是 schema.number().step(1).min(-720).max(840)
  const schemaTakesNumber = (value) => Number.isInteger(value) && value >= -720 && value <= 840
  const danger = []
  const loose = []
  for (const value of values) {
    const bySchema = typeof value === 'number' ? schemaTakesNumber(value) : TIME_ZONE_PATTERN.test(value)
    const byResolver = normalizeTimeZone(value) !== undefined
    if (bySchema && !byResolver) danger.push(value)
    if (byResolver && !bySchema) loose.push(value)
  }
  assert.deepEqual(danger, [], 'schema 放行而解析器拒绝的值会让整份配置在挂载期降级')
  assert.deepEqual(loose, [], '解析器接受而 schema 拒绝的值会让用户拿到无关的报错')
})

test('诊断日志写盘前必须把绝对路径压短（隐私回归）', async () => {
  // 曾经逐字节序列化：driftDetail 带着用户完整工作区路径落盘，而那份文件的
  // 定位是「布尔值和计数器」。
  const root = await mkdtemp(join(tmpdir(), 'stage-handoff-scrub-'))
  try {
    const file = join(root, '.probe.jsonl')
    const writer = createBoundedJsonlWriter(file, 256 * 1024)
    await writer.append({
      kind: 'pre-step',
      phase: 'complete',
      driftOutcome: 'no-baseline',
      driftDetail:
        "D:\\work\\repo\\docs\\anchors\\261116-0444-研究: ENOENT: no such file or directory, lstat 'D:\\work\\repo\\docs\\anchors\\261116-0444-研究\\.anchor-guard.json'",
      nested: { where: '/home/someone/.config/dsh/secrets.yaml' },
    })
    const text = await readFile(file, 'utf8')
    assert.ok(!text.includes('work\\repo'), '工作区根目录不能落盘')
    assert.ok(!text.includes('/home/someone'), '家目录不能落盘')
    // 诊断价值要保住：阶段名与文件名必须还在。
    assert.ok(text.includes('261116-0444-研究'))
    assert.ok(text.includes('.anchor-guard.json'))
    assert.ok(text.includes('<path>/'))
  } finally {
    await rm(root)
  }
})

test('诊断日志遇到循环引用仍走有界摘要，不被脱敏层打断（容错回归）', async () => {
  // 脱敏若把环打断，JSON.stringify 反而会成功，这条容错路径就再也走不到。
  const root = await mkdtemp(join(tmpdir(), 'stage-handoff-scrub-cycle-'))
  try {
    const file = join(root, '.probe.jsonl')
    const writer = createBoundedJsonlWriter(file, 512)
    const record = { kind: 'pre-step', phase: 'error' }
    record.self = record
    await assert.doesNotReject(writer.append(record))
    const row = JSON.parse((await readFile(file, 'utf8')).trim())
    assert.equal(row.kind, 'pre-step')
    assert.equal(row.diagnosticTruncated, true)
    assert.equal(row.serializationFailed, true)
  } finally {
    await rm(root)
  }
})

test('anchorRoot 的 schema 与解析器接受集双向一致（空白/`..` 顺序回归）', () => {
  // 旧 schema 用一条正则同时判「非空 / 无 .. 段 / 无控制字符」，解析器却先 trim 再判。
  // 于是两边都漂：`"docs/.. "` 通过 schema 被解析器拒（该字段被 lenient 丢掉，
  // 锚点静默写回默认目录），`"docs/anchors\t"` 反过来。一份判据两边共用才不会再分叉。
  const prefixes = ['', ' ', '\t', '\u00a0', '  ']
  const bodies = [
    'docs/anchors',
    '..',
    'a/..',
    'a/../b',
    'a/..b',
    'a\\..\\b',
    '..\\a',
    'a\\..',
    '/..',
    'C:\\x',
    '/etc/x',
    '\\\\srv\\share',
    '...',
    '.',
    'a/./b',
  ]
  const suffixes = ['', ' ', '\t', '\u00a0']
  const bySchema = (value) => {
    try {
      Config({ anchorRoot: value })
      return true
    } catch {
      return false
    }
  }
  const byResolver = (value) => {
    try {
      resolveConfig({ anchorRoot: value })
      return true
    } catch {
      return false
    }
  }
  const wider = []
  const stricter = []
  for (const prefix of prefixes) {
    for (const body of bodies) {
      for (const suffix of suffixes) {
        const value = prefix + body + suffix
        const schemaOk = bySchema(value)
        const resolverOk = byResolver(value)
        if (schemaOk && !resolverOk) wider.push(value)
        if (!schemaOk && resolverOk) stricter.push(value)
      }
    }
  }
  assert.deepEqual(wider, [], 'schema 放行而解析器拒绝 → anchorRoot 会被静默丢弃')
  assert.deepEqual(stricter, [], '解析器接受而 schema 拒绝 → 用户会拿到与原因无关的报错')
  // 规范化只发生一次：两边都必须给出同一个 trim 后的值。
  assert.equal(resolveConfig({ anchorRoot: '  docs/anchors  ' }).anchorRoot, 'docs/anchors')
})

test('整份配置形状错误必须报告，不能静默换成全默认（lenient 回归）', () => {
  // 调用方用 `dropped.length > 0` 决定是否报告；形状错误没有任何字段可点名，
  // 旧实现因此让 dropped 停在空数组 —— `enabled:false` 被静默换成 true。
  for (const raw of [[], 'nope', 42]) {
    const lenient = resolveConfigLenient(raw)
    assert.equal(
      typeof lenient.shapeError,
      'string',
      `${JSON.stringify(raw)} 必须产生 shapeError`,
    )
    assert.deepEqual(lenient.dropped, [], '形状错误没有字段可点名')
    assert.equal(lenient.config.enabled, true)
  }
  // 对照组：null 与空对象都是合法配置，不该报形状错误。
  assert.equal(resolveConfigLenient(null).shapeError, undefined)
  assert.equal(resolveConfigLenient({}).shapeError, undefined)
})

test('工具轨迹扫描被事件窗口截断时必须报 partial-window（不让「完整」说谎）', () => {
  // `coverageForRange` 判的是**请求区间**是否完整，而请求区间本身被
  // `fromSeq = seqCount - limit` 截成尾部。旧实现因此对长会话报「覆盖：完整」，
  // 而早期的 tool/call 一条都没扫。
  const recent = []
  for (let seq = 1000; seq < 9000; seq += 1) recent.push({ seq, type: 'user/message' })
  const ring = {
    recent,
    mountSeq: 1000,
    firstRetainedSeq: 1000,
    lastObservedSeq: 8999,
    truncatedByCount: false,
    truncatedByBytes: false,
    hasGap: false,
    bytes: 0,
  }
  const long = collectToolFacts({ seq: 9000 }, 5000, () => ring)
  assert.equal(long.coverage, 'partial-window', '窗口截断不能报完整')
  assert.equal(long.windowed, true)

  // 对照组：短会话没有窗口截断，仍必须报 complete —— 否则上面那条可能只是
  // 「永远报 partial」。（这里必须连 mountSeq 一起对齐：mountSeq 大于 fromSeq
  // 本身就会报 partial-since-mount。）
  const shortRing = {
    recent: Array.from({ length: 10 }, (_, seq) => ({ seq, type: 'user/message' })),
    mountSeq: 0,
    firstRetainedSeq: 0,
    lastObservedSeq: 9,
    truncatedByCount: false,
    truncatedByBytes: false,
    hasGap: false,
    bytes: 0,
  }
  assert.equal(collectToolFacts({ seq: 10 }, 5000, () => shortRing).coverage, 'complete')
})

test('环对象缺 hasGap 字段时按 seq 连续性推导，不当成确证无缺口（mixed-version 回归）', () => {
  // projection 回退会注入只有 recent 的环。旧实现 `state.hasGap === true` 于是
  // 端点齐全但中间跳号的环报 complete，summary 于是说「事件环覆盖完整日志」。
  const holey = { recent: [{ seq: 0, type: 'x' }, { seq: 9, type: 'y' }] }
  assert.equal(collectToolFacts({ seq: 10 }, 100, () => holey).coverage, 'partial-gap')
  const contiguous = { recent: Array.from({ length: 10 }, (_, seq) => ({ seq, type: 'x' })) }
  assert.equal(collectToolFacts({ seq: 10 }, 100, () => contiguous).coverage, 'complete')
})

test('安全读层的 inode 比较必须用 bigint（Windows 上 Number 化会让它失效）', async () => {
  // 本机 NTFS 的 ino 超过 Number.MAX_SAFE_INTEGER（实测 10,696,049,116,493,804）。
  // 先 `Number()` 再比较会把相邻两个 inode 舍成同一个值 —— 那正是原始缺陷的形状：
  // 「读到的还是刚才检查的那个文件吗」永远答「是」（fail-open），而注释与
  // docs/SECURITY.md 都宣称这条窗口已关闭。
  //
  // 这条以前只扫源码里有没有 `bigint: true` 字样：把比较改回
  // `Number(a) !== Number(b)` 照样是绿的，等价改写（抽常量）却会误报。现在钉的是
  // **行为**：相邻 inode 必须判不等，相同 inode 必须判相等。
  const real = 10696049116493804n
  // 采样点必须是 `+1n` 而不是 `+2n`：2^53 以上 double 的精度间隔正好是 2，`+2` 能被
  // 精确表示，那样对照组不成立。`+1` 落在两个可表示值之间，ties-to-even 会舍回偶数。
  assert.equal(sameIdentity({ ino: real, dev: 1n }, { ino: real + 1n, dev: 1n }), false)
  assert.equal(sameIdentity({ ino: real, dev: 1n }, { ino: real, dev: 1n }), true)
  assert.equal(sameIdentity({ ino: real, dev: 1n }, { ino: real, dev: 2n }), false)
  // 反向对照：`Number()` 化确实分不开这两个值 —— 证明上一行不是靠运气过的。
  assert.equal(Number(real) === Number(real + 1n), true)
  // number/bigint 混用：`1 === 1n` 为 false，直接 `===` 会把同一文件误报成被替换。
  assert.equal(sameIdentity({ ino: 1, dev: 0 }, { ino: 1n, dev: 0n }), true)
  // 转换不了的值一律判不等（保守方向：宁可拒绝读，也不放行来路不明的句柄）。
  assert.equal(sameIdentity({ ino: 1.5, dev: 0 }, { ino: 1.5, dev: 0 }), false)
  // 静态扫描降为次要手段：证明两处调用点真的走同一个判据，而不是各写一份。
  const source = await readFile(join(repoRoot, 'lib', 'index.js'), 'utf8')
  assert.match(source, /lstat\(targetPath, \{ bigint: true \}\)/)
  assert.match(source, /!sameIdentity\(opened, targetInfo\)/)
  assert.ok(!/Number\.isSafeInteger\(targetInfo\.ino\)/.test(source))
  const logSource = await readFile(join(repoRoot, 'lib', 'prestep-log.js'), 'utf8')
  assert.match(logSource, /!sameIdentity\(opened, checked\)/)
})

test('提醒文案不能让模型去敲 slash 命令（agent 敲不了，工具自己也知道）', () => {
  // 同一份代码在 reset 分支写着「agent 敲不了 slash 命令」，却在提醒正文里
  // 指 `/anchor status`。提醒是给模型读的，那条路走不通。
  const text = noticeText(500000, 1000000, resolveConfig({}), undefined, 'session-x', 1)
  assert.ok(!text.includes('/anchor status'), '提醒里不能出现 slash 命令')
  assert.ok(text.includes('stage_handoff(action="status")'), '必须给出模型真的能调用的入口')
})

test('摘要上限的文案必须按码元说话，不能自称 64 KiB', async () => {
  // 常量名是 CHARS：65,536 个 UTF-16 码元在中文下约 192 KiB。文案与四处文档
  // 都说 64 KiB，把真实上限说小了 3 倍。
  const source = await readFile(join(repoRoot, 'lib', 'index.js'), 'utf8')
  assert.ok(!source.includes('按 64 KiB 上限截断'), '不能再用 KiB 描述码元上限')
  assert.ok(source.includes('UTF-16 码元'), '文案要说明是码元')
})

test('npm run check 必须跑 test/ 下每一个测试文件（否则本地全绿 ≠ CI 全绿）', async () => {
  // 旧断言是「两个脚本里列的文件彼此相等」+ 数量 >= 7，近似同义反复：往 test/
  // 里新加一个用例文件却忘了接线时照样绿（`--test` 只跑显式列出的文件）。数量
  // 下限也证明不了「完整」—— 正是本仓自己那条「有界扫描必须报下限」的反面教材。
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  const pattern = /test\/[\w.-]+\.test\.mjs/g
  const testFiles = (pkg.scripts.test.match(pattern) ?? []).sort()
  const checkFiles = (pkg.scripts.check.match(pattern) ?? []).sort()
  const onDisk = (await readdir(join(repoRoot, 'test')))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `test/${name}`)
    .sort()
  assert.deepEqual(checkFiles, testFiles, 'check 与 test 必须跑同一批文件')
  assert.deepEqual(testFiles, onDisk, '脚本列出的文件必须与 test/ 目录里的完全一致')
})

test('surface 竞态必须按错误**类**判定，不能按宿主某一处文案（retryable 回归）', () => {
  // 宿主的 `SurfaceChangedError` 是 `class SurfaceChangedError extends Error {}`
  // （dsh-compaction-basic/src/region.ts:77）—— 没设 `name`，而且一共 5 处抛出、
  // 措辞各不相同。旧实现只匹配其中一处（'session surface changed during
  // summarization'），另外几种**真的**竞态被判成不可重试 → 进永久退避，自动压缩
  // 整段停摆。文案匹配本身也是「宿主改一个词就静默失效」的耦合。
  class SurfaceChangedError extends Error {}
  const wordings = [
    'compaction: selected surface changed before summarization began',
    'compaction: session surface changed during summarization',
    'compaction: the selected span changed during summarization',
    'compaction: the selected span was rewritten during summarization',
    'compaction: the surface changed while the summary was running',
  ]
  for (const message of wordings) {
    assert.equal(
      isSurfaceRace(new SurfaceChangedError(message)),
      true,
      `按类应判可重试：${message}`,
    )
    // 文案兜底也要成立：跨 realm、被包装、或宿主改名时构造函数名拿不到。
    assert.equal(isSurfaceRace(new Error(message)), true, `按文案应判可重试：${message}`)
  }
  // 反例：这些是硬失败，判成竞态会导致无限重试，每次都白烧一次摘要调用。
  const hardFailures = [
    "compactRegion: start seq 3 is not a balanced boundary (would split a step's tool-call/result pair)",
    'compactRegion: end seq 9 is not a balanced boundary (would split a step, or the step is still open)',
    'compaction: token-meter surface does not match the current session surface',
    'compactRegion: start seq 3 not found in surface',
    'compactRegion: no open turn — automatic compaction events must be enclosed in a turn',
  ]
  for (const message of hardFailures) {
    assert.equal(isSurfaceRace(new Error(message)), false, `硬失败不能判可重试：${message}`)
  }
  // 非 Error 输入不该抛（`String(undefined)` 之类都要能安全比较）。
  assert.equal(isSurfaceRace(undefined), false)
  assert.equal(isSurfaceRace('plain string'), false)
})

test('配置形状闸必须拒绝内建非映射类型（Date/Map/Set/RegExp 曾被静默换成全默认）', () => {
  // `plainConfig` 用 `Object.entries` 摊平任意对象，而 `Date` / `Map` / `Set` /
  // `RegExp` 的可枚举自有属性全是空的 —— 它们会变成 `{}`，整个配置被**静默**换成
  // 默认值（连 `enabled: false` 一起丢），日志里一个字都没有。形状闸必须在
  // `plainConfig` **之前**才拦得住。
  const builtins = [
    ['Date', new Date(0)],
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1])],
    ['RegExp', /x/],
  ]
  for (const [label, value] of builtins) {
    assert.throws(
      () => resolveConfig(value),
      new RegExp(`必须是一个映射，收到 ${label}`),
      `${label} 必须被拒绝`,
    )
    const lenient = resolveConfigLenient(value)
    assert.match(String(lenient.shapeError), new RegExp(`收到 ${label}`))
    assert.deepEqual(lenient.dropped, [], `${label} 没有「哪个字段」可点名`)
  }
  // 对照：数组 / 字符串 / 数字仍按原来的措辞报告（改判据不能改变这几条）。
  assert.match(String(resolveConfigLenient('nope').shapeError), /收到 string/)
  assert.match(String(resolveConfigLenient([{}]).shapeError), /收到 数组/)
  assert.match(String(resolveConfigLenient(42).shapeError), /收到 number/)
  // 必须继续放行：自定义类实例（宿主可能用类承载配置）与 `.volatile()` 引用。
  class Wrapper {
    constructor() {
      this.notifyTokens = 111111
    }
  }
  assert.equal(resolveConfig(new Wrapper()).notifyTokens, 111111)
  assert.equal(resolveConfig({ get: () => ({ notifyTokens: 222222 }) }).notifyTokens, 222222)
})

test('配置诊断路径不得抛出与插件无关的错（BigInt / 循环引用）', () => {
  // `JSON.stringify(10n)` 抛 `TypeError: Do not know how to serialize a BigInt`，
  // 于是「点名哪个配置键坏了」的诊断路径自己先炸了，用户拿到的消息既不含键名、
  // 也来自 JS 引擎。错误消息同样是契约。
  assert.throws(
    () => resolveConfig({ anchorTimeZone: 10n }),
    /anchorTimeZone 无法解析（收到 10）/,
  )
  // `plainConfig` 递归没有 seen 集时，循环配置会炸成 `RangeError: Maximum call
  // stack size exceeded`；而 `resolveConfigLenient` 的整个存在理由就是「坏配置不许
  // 整体失效」，它在栈溢出上抛错就违背了那个契约。
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => resolveConfig(cyclic), /循环引用/)
  const lenient = resolveConfigLenient(cyclic)
  assert.match(String(lenient.shapeError), /循环引用/)
  assert.equal(lenient.config.notifyTokens, 363520, '降级后必须回落到默认值')
  // `seen` 只在**递归路径**上去重，所以同一个对象被同一个 ref 反复解包不该误报。
  const sharedConfig = { notifyTokens: 111111 }
  const ref = { get: () => sharedConfig }
  assert.equal(resolveConfig(ref).notifyTokens, 111111)
})

test('formatBytes / formatCount 对 NaN 与 Infinity 不得抛错', () => {
  // 这两个函数跑在渲染路径上，一个异常就会让整条 status 变成 "Error: ..."。
  // 只要求「不抛、返回字符串」——NaN 显示成什么由实现决定，不该在这里钉死。
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(typeof formatBytes(value), 'string')
    assert.equal(typeof formatCount(value), 'string')
  }
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatCount(-0), '0')
})

test('formatBytes 在 1 MiB 下方不能显示「1024.0 kB」', () => {
  // 旧实现先判晋级、后用 toFixed(1)：1,048,570 除以 1024 是 1023.99…，四舍五入成
  // 「1024.0 kB」—— 数值没错，但单位本该晋级。锚点目录体积落在 1 MiB 附近就会读到它。
  assert.equal(formatBytes(1_048_570), '1.0 MB')
  assert.equal(formatBytes(1_048_575), '1.0 MB')
  assert.equal(formatBytes(1_048_576), '1.0 MB')
  assert.equal(formatBytes(1_073_741_823), '1.0 GB')
  // 不该误伤的边界：刚好不到晋级点的那一侧仍是上一个单位。
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 kB')
  assert.equal(formatBytes(1_048_000), '1023.4 kB')
})

test('notifyTokens 超上界时，报错必须说出上界（不能只喊「必须是正整数」）', () => {
  // 对一个本来就是正整数的输入说「必须是正整数」是假话，而用户想「把线设得足够高、
  // 基本等于关掉提醒」时正好会撞上它。上界 1,000,000,000 在 docs 里写着，报错里却没有。
  assert.throws(() => resolveConfig({ notifyTokens: '954m' }), /1\.\.1000000000/)
  assert.throws(() => resolveConfig({ notifyTokens: 2_000_000_000 }), /1\.\.1000000000/)
})

test('时区接受集：schema 与解析器在小字母表上必须逐值一致（穷举回归）', () => {
  // 手工枚举候选值只覆盖「想到的」那些写法。这里用 9 个字符穷举长度 1–4 的全部
  // 7,380 种串，逐值对撞 schema 的 pattern 与 normalizeTimeZone —— 任何一边改了
  // 正则或解析，都会立刻在某个长度上裂开。
  const alphabet = ['+', '-', '0', '1', '5', '8', '9', ':', ' ']
  const dangerous = []
  const loose = []
  let checked = 0
  const walk = (prefix) => {
    if (prefix.length > 0) {
      checked += 1
      const bySchema = TIME_ZONE_PATTERN.test(prefix)
      const byResolver = normalizeTimeZone(prefix) !== undefined
      if (bySchema && !byResolver) dangerous.push(prefix)
      if (byResolver && !bySchema) loose.push(prefix)
    }
    if (prefix.length === 4) return
    for (const char of alphabet) walk(prefix + char)
  }
  walk('')

  assert.equal(checked, 9 + 81 + 729 + 6561, `应检查 7,380 种写法，实际 ${checked}`)
  assert.deepEqual(dangerous.slice(0, 5), [], 'schema 放行而解析器拒绝会让整份配置在挂载期降级')
  assert.deepEqual(loose.slice(0, 5), [], '解析器接受而 schema 拒绝会让用户拿到无关的报错')
})

test('formatCount 不能把 -0 显示成「-0」', () => {
  // `Intl.NumberFormat('en-US').format(-0)` 是 "-0"。唯一的来源是
  // `anchorTimeZone: '-00'`（normalizeTimeZone 走 `-1 * 0 * 60`）与 `keepAnchorBackups: -0`；
  // 显示成 "-0" 会让用户以为配置坏了。
  assert.equal(formatCount(-0), '0')
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount(-1), '-1')
  assert.equal(formatCount(1032), '1,032')
})

test('coverageForRange：hasGap 缺失时必须按 seq 连续性推导，不能当「已证明无缺口」', () => {
  // `complete` 的语义是「可以当作完整日志引用」。旧实现只认 `state.hasGap === true`，
  // 于是「字段缺失」被当成「已证明无缺口」：中间跳号的环也拿到 complete。三个生产
  // 调用点都会先过 readRecentFactsState（那里会推导），所以这是纵深防御。
  const holey = {
    recent: [
      { seq: 1, type: 'x' },
      { seq: 3, type: 'y' },
    ],
    mountSeq: 1,
    firstRetainedSeq: 1,
    lastObservedSeq: 3,
    truncatedByCount: false,
    truncatedByBytes: false,
    bytes: 10,
  }
  assert.equal(
    coverageForRange(holey, 1, 4).coverage,
    'partial-gap',
    '缺 hasGap 也要能看出跳号',
  )

  const contiguous = {
    ...holey,
    recent: [
      { seq: 1, type: 'x' },
      { seq: 2, type: 'y' },
    ],
    lastObservedSeq: 2,
  }
  assert.equal(coverageForRange(contiguous, 1, 3).coverage, 'complete', '连续环仍要报 complete')
  // 显式标记必须被尊重：`true` 生效，`false` 也不能被推导覆盖。
  assert.equal(coverageForRange({ ...contiguous, hasGap: true }, 1, 3).coverage, 'partial-gap')
  assert.equal(coverageForRange({ ...holey, hasGap: false }, 1, 4).coverage, 'complete')
})

/**
 * 索引文件是 Discover 的唯一入口，而它里面的版本号是**手抄的**（由 tools/market-index.mjs 生成）。
 * 发版时最容易漏的一步就是改了 `package.json` 的 version 却忘了重跑生成器 ——
 * 那时 Discover 会继续列出上一个版本，界面上一切正常，装下来的却是旧代码。
 * 这条断言专门拦它，顺便把校验器（dsh-plugin-market-index）会拒的两种形状也钉住。
 */
test('market-index.json 与 package.json 保持同步', async () => {
  const index = JSON.parse(await readFile(join(repoRoot, 'market-index.json'), 'utf8'))
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))

  assert.equal(index.format, 1, '索引格式版本必须是 1')
  assert.equal(index.plugins.length, 1, '这个索引只列本插件')

  const plugin = index.plugins[0]
  assert.equal(plugin.name, pkg.name, '索引里的包名必须与 package.json 一致')
  // 索引描述的是**已发布**状态，`package.json` 描述的是**工作区**状态。
  // 两者在「已 bump、未发布」的中间态必然不同 —— 而 `tools/market-index.mjs`
  // 硬要求该版本已在 registry 上有发布时间（`version <x> has no publish time yet`），
  // 所以发布前**无法**让它们相等。原来这里要求严格相等，结果是任何 bump 提交的
  // CI 都红、`npm test` 不再是可用的收口信号；而它本意防的「索引列了一个不存在的
  // 版本」只要「不领先于包版本」就成立。
  //
  // 比较按数字段做（beta 阶段够用：`1.0.0-beta.2` → [1,0,0,0,2]）。正式版号
  // 与预发布号混排的完整 semver 比较在这里没有收益，反而要引依赖。
  const numeric = (version) => String(version).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const latestRank = numeric(plugin.versions[0].version)
  const packageRank = numeric(pkg.version)
  const cmp = (() => {
    for (let i = 0; i < Math.max(latestRank.length, packageRank.length); i += 1) {
      const diff = (latestRank[i] ?? 0) - (packageRank[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  })()
  assert.ok(
    cmp <= 0,
    `索引版本 ${plugin.versions[0].version} 不能领先于 package.json 的 ${pkg.version}：` +
      '索引只能列已经发布过的版本',
  )

  const [latest] = plugin.versions
  assert.equal(latest.source.type, 'npm', '本插件从 npm 发布')
  assert.ok(
    Number.isInteger(latest.publishTimestamp) && latest.publishTimestamp > 0,
    'publishTimestamp 必须是 Unix 秒（不是毫秒，也不能是 ISO 字符串）',
  )
  // 毫秒时间戳会被当成"很久以后"而排到前面，是这类文件最常见的单位错误。
  assert.ok(latest.publishTimestamp < 10_000_000_000, 'publishTimestamp 看起来是毫秒')

  // 校验器只认索引里声明过的 category / label，未声明的 id 会让那个筛选条件永远匹配不到。
  assert.ok(
    index.metadata.categories[plugin.metadata.category] !== undefined,
    `category ${plugin.metadata.category} 必须在 metadata.categories 里声明`,
  )
  for (const label of plugin.metadata.labels) {
    assert.ok(index.metadata.labels[label] !== undefined, `label ${label} 必须在 metadata.labels 里声明`)
  }

  assert.match(plugin.icon, /^data:image\/svg\+xml;base64,/, '图标用内联 data: URL，不依赖外部托管')
  const iconBytes = Buffer.from(plugin.icon.slice(plugin.icon.indexOf(',') + 1), 'base64').length
  assert.ok(iconBytes <= 32 * 1024, `内联图标 ${iconBytes} 字节，超过校验器的 32 KiB 上限`)
})

test('reconcile 的摘要引用必须走 summaryText，不能再直接读 summaryWindow.summary', async () => {
  // 真机 bug（261123）：reconcile 走会话日志回退时，输出组装里还留着
  // `summaryWindow.summary.length`，而那条路径下它是 undefined —— 整个 action
  // 崩成 Cannot read properties of undefined (reading 'length')。
  // 离线测试当时没覆盖回退路径，所以没红。这条用静态检查盯住它：
  // 回退引入之后，reconcile 作用域内不允许再直接解引用 summaryWindow.summary。
  const source = await readFile(join(repoRoot, 'lib/index.js'), 'utf8')
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.includes("if (action === 'reconcile')"))
  assert.ok(start >= 0, '找不到 reconcile 分支')
  // 分支到下一个 action 之前
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s{12}if \(action === '/.test(lines[index])) {
      end = index
      break
    }
  }
  const offenders = []
  for (let index = start; index < end; index += 1) {
    const line = lines[index]
    // 注释里提到是允许的（就是上面那段说明）。
    if (/^\s*(\/\/|\*)/.test(line)) continue
    if (/summaryWindow\.summary\s*[.\[]/.test(line)) {
      offenders.push(`${index + 1}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `reconcile 里不得直接读 summaryWindow.summary：\n${offenders.join('\n')}`)
})
