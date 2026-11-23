// 设置面板的渲染覆盖：三个 tab × 两种语言 × 真实/异常数据形状。
//
// 为什么需要这个文件：面板整片空白那次，所有测试都是绿的。原因有三层，逐层补上：
//   1. `render.test.mjs` 只渲染**默认 tab**（提醒），字段加在「压缩」组就等于从没被渲染过；
//   2. `configForms.get()` 返回 null 时走的是 StaticPanel（FALLBACK 驱动的只读预览），
//      LivePanel —— 也就是真实宿主里那条路 —— 一次都没跑过；
//   3. 键覆盖测试用正则读文本，只数 `key:`，结构写错、少写 label、type 拼错都发现不了。
//
// 这里用 `tools/probes/render-smoke.mjs` 走真实渲染路径，把上面三条都堵住。
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPanel } from '../tools/probes/render-smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

/** 一个形状正常的 Host config form。 */
function fakeForm(overrides = {}) {
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 1,
    value: { notifyTokens: 363520, compactRetainTokens: 32000, streamGuard: false },
    base: { notifyTokens: 363520, compactRetainTokens: 32000, streamGuard: false },
    user: {},
    ...overrides,
  }
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    set: () => Promise.resolve(true),
    unset: () => Promise.resolve(true),
    mutate: () => Promise.resolve(true),
  }
}

const TABS = ['reminder', 'compaction', 'files']

test('字段正在保存时渲染不能崩（真实事故：整片面板空白）', () => {
  // 现场：点一下开关 → 该字段进入 pending → FieldRow 走 busy 分支 →
  // `tf(' 保存中')` 少传第二个参数 → `Object.entries(undefined)` 抛
  // "Cannot convert undefined or null to object" → React 卸掉整棵子树 → 右侧全白。
  // 渲染测试以前全都传 pending=空 Map，所以这条分支一次都没跑过。
  for (const tab of TABS) {
    for (const language of ['zh', 'en']) {
      const result = renderPanel({
        clientPath,
        language,
        form: fakeForm(),
        tab,
        // 把每一组的第一个字段都标成「正在保存」，确保至少命中一次 busy 分支
        pending: new Map([['notifyTokens', 1], ['compactRetainTokens', 2], ['anchorRoot', 3], ['dshHome', 4]]),
      })
      assert.ok(
        result.texts.length > 20,
        `${tab}/${language} 在保存中状态下只剩 ${result.texts.length} 条文本，面板可能已经白了`,
      )
    }
  }
})

test('所有 tf() 调用都必须传第二个参数', () => {
  // `tf` 现在有默认值兜底，但漏传仍然是错的：模板里的 {name} 会原样留在界面上。
  // 这条守住调用点，避免「兜底把 bug 变成静默显示错误文案」。
  const src = readFileSync(clientPath, 'utf8')
  const offenders = []
  for (const line of src.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.includes('tf(')) continue
    // 注释里会引用这个坏例子本身（包括 `tf(' 保存中')` 这段文字），跳过。
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
    // 只认「tf(字符串字面量)」就结束的形式：缺第二个参数
    if (/\btf\((?:\x27[^\x27]*\x27|"[^"]*"|`[^`$]*`)\s*\)/.test(trimmed)) offenders.push(trimmed)
  }
  assert.deepEqual(offenders, [], `这些 tf() 调用少了参数：\n${offenders.join('\n')}`)
})

test('三个 tab 在两种语言下都能渲染，且不是空白', () => {
  for (const tab of TABS) {
    for (const language of ['zh', 'en']) {
      const result = renderPanel({ clientPath, language, form: fakeForm(), tab })
      assert.equal(result.live, true, `${tab}/${language}: 应走 LivePanel`)
      assert.ok(
        result.texts.length > 20,
        `${tab}/${language} 只渲染出 ${result.texts.length} 条文本，面板可能是空的`,
      )
    }
  }
})

test('每个 tab 的英文界面都不残留中文', () => {
  // 这条比 render.test.mjs 严格：那个只测默认 tab，一个字段漏了 pick 也能过。
  for (const tab of TABS) {
    const result = renderPanel({ clientPath, language: 'en', form: fakeForm(), tab })
    assert.deepEqual(result.chinese, [], `${tab} 的英文界面里还有中文：${result.chinese.join(' / ')}`)
  }
})

test('异常的数据形状不能让面板崩掉', () => {
  // 真实宿主里 value 来自 volatile 字段的镜像，可能是 getter 残留、缺键、null。
  // 渲染器每一处都必须有兜底 —— 一处没有就是整片空白。
  const shapes = {
    'volatile getter 残留成空对象': { value: { streamGuard: {} }, base: { streamGuard: {} } },
    'value 完全缺新字段': { value: { notifyTokens: 363520 }, base: { notifyTokens: 363520 } },
    '新字段是 null': { value: { streamGuard: null }, base: { streamGuard: null } },
    'user 里带新字段': { user: { streamGuard: true } },
    'value/base/user 全 undefined': {
      value: undefined,
      base: undefined,
      user: undefined,
    },
    'status 是 loading': { status: 'loading' },
    'status 是 unavailable': { status: 'unavailable' },
  }
  for (const [label, overrides] of Object.entries(shapes)) {
    for (const tab of TABS) {
      assert.doesNotThrow(
        () => renderPanel({ clientPath, language: 'zh', form: fakeForm(overrides), tab }),
        `${label} / ${tab}: 渲染抛错就会让整片面板空白`,
      )
    }
  }
})

test('试验性开关在「压缩」tab 里可见，且中英文不一样', () => {
  // 开关放在压缩组，所以它只可能出现在 compaction 这一页。默认 tab 里看不见是正常的。
  const zh = renderPanel({ clientPath, language: 'zh', form: fakeForm({ value: { streamGuard: true } }), tab: 'compaction' })
  const en = renderPanel({ clientPath, language: 'en', form: fakeForm({ value: { streamGuard: true } }), tab: 'compaction' })
  assert.ok(zh.texts.some((text) => text.includes('流式复读守卫')), '中文界面应显示开关的标签')
  assert.ok(en.texts.some((text) => text.includes('Stream repeat guard')), '英文界面应显示开关的标签')
  // 其他 tab 里不该出现它
  for (const tab of ['reminder', 'files']) {
    const result = renderPanel({ clientPath, language: 'zh', form: fakeForm(), tab })
    assert.equal(
      result.texts.some((text) => text.includes('流式复读守卫')),
      false,
      `${tab} 里不该出现这个字段`,
    )
  }
})

test('字段元数据的结构与渲染器期望一致', () => {
  // 渲染器读 labelOf/hintOf/formatValue 与 item.type 分支；任何一项缺失都会让整块
  // 子树抛错，而 React 错误边界把右侧吞成空白 —— 键覆盖测试对此完全无感。
  const src = readFileSync(clientPath, 'utf8')
  const fieldBlock = src.slice(src.indexOf('const FIELDS = ['), src.indexOf('const FIELD_GROUPS'))
  assert.ok(fieldBlock.length > 0, '必须能定位 FIELDS')
  // 支持的 type 从渲染器的 `item.type === '...'` 分支里提取，不靠猜：
  // `tokens` 是猜漏过的那个（notifyTokens 用它）。
  const allowed = new Set([...src.matchAll(/item\.type === '(\w+)'/g)].map((match) => match[1]))
  assert.ok(allowed.size >= 5, `渲染器的 type 分支至少解析出 5 个，实际 ${allowed.size}`)
  const marks = [...fieldBlock.matchAll(/key: '(\w+)'/g)]
  assert.ok(marks.length >= 15, `FIELDS 至少 15 项，实际 ${marks.length}`)
  for (let index = 0; index < marks.length; index += 1) {
    const key = marks[index][1]
    const from = fieldBlock.lastIndexOf('{', marks[index].index)
    const to =
      index + 1 < marks.length ? fieldBlock.lastIndexOf('{', marks[index + 1].index) : fieldBlock.length
    const block = fieldBlock.slice(from, to)
    // 只要求键存在：hint/hintEn 常写成「键名换行 + 缩进字符串」，要求同一行有引号会误判。
    for (const name of ['label', 'labelEn', 'hint', 'hintEn']) {
      assert.match(block, new RegExp(`\\b${name}\\s*:`), `${key}: 缺 ${name}`)
    }
    const type = /\btype: '(\w+)'/.exec(block)?.[1]
    assert.ok(type !== undefined, `${key}: 缺 type`)
    assert.ok(allowed.has(type), `${key}: type '${type}' 不在渲染器分支里（${[...allowed].join(' / ')}）`)
  }
})

test('每个字段分组都必须挂在一个 tab 上，否则整组永不渲染', () => {
  const src = readFileSync(clientPath, 'utf8')
  const fieldBlock = src.slice(src.indexOf('const FIELDS = ['), src.indexOf('const FIELD_GROUPS'))
  const groups = [...fieldBlock.matchAll(/^\s+group: '([^']+)'/gm)].map((match) => match[1])
  assert.ok(groups.length >= 5, `至少 5 个分组，实际 ${groups.length}`)
  const tabsSrc = src.slice(src.indexOf('const TABS = ['), src.indexOf('const PRESETS = ['))
  const listed = new Set([...tabsSrc.matchAll(/'([^']+)'/g)].map((match) => match[1]))
  // 第一个分组「运行」刻意不在 tab 里：enabled 固定，不在此页切换。
  assert.equal(groups[0], '运行', '第一个分组应仍是固定项“运行”')
  for (const group of groups.slice(1)) {
    assert.ok(listed.has(group), `分组「${group}」不在任何 TABS 的 groups 里，这一组永远不会渲染`)
  }
})

test('写入失败不能被并发的成功覆盖（失败优先于「正在保存」）', () => {
  // 面板的反馈原本是「单槽 + pending 优先」，于是并发写入时后到的成功会盖住先到的失败：
  // 实测「改 A（慢）→ 立刻拨开关 B 且 Host 拒绝」的最后一条是「已保存 · A」，
  // B 的拒绝从未出现。修法是给失败单独一个 state，并让它在渲染时排在 pending 之前。
  const src = readFileSync(clientPath, 'utf8')
  assert.match(
    src,
    /const \[lastFailure, setLastFailure\] = useState\(null\)/,
    '失败必须单独存一份 state，不能只靠 note',
  )
  const feedbackAt = src.indexOf('const feedback =')
  assert.ok(feedbackAt > 0, '必须能定位 feedback 的构造')
  const chunk = src.slice(feedbackAt, feedbackAt + 400)
  assert.match(
    chunk,
    /lastFailure !== null\s*\n?\s*\?\s*\{ kind: 'error'/,
    'feedback 的第一优先级必须是未解决的失败',
  )
  // 只有「同一字段」的成功才能清掉失败。别的字段成功也清，就回到「失败被成功盖住」。
  assert.match(
    src,
    /setLastFailure\(\(current\) => \(current !== null && current\.key === key \? null : current\)\)/,
    '只有同一字段的成功才能清掉它自己的失败',
  )
})
