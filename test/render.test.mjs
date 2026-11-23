// 渲染一致性测试：英文界面下不能出现中文。
//
// 走真实渲染路径（pick / t() / labelOf 全部执行），所以能抓到「表里有英文但
// 代码没用 pick」这种人工审查看不出来的漏译。真实案例：页签按钮写的是
// `entry.label`（中文）而不是 `pick(entry.label, entry.labelEn)`，英文界面下
// 三个页签各冒一个中文词。
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderPanel } from '../tools/probes/render-smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

test('英文界面下渲染出的文本不含中文', () => {
  const result = renderPanel({ clientPath, language: 'en' })
  assert.ok(result.texts.length > 20, `渲染出的文本太少（${result.texts.length}），桩可能失效了`)
  assert.deepEqual(result.chinese, [], `英文界面里还有中文：${result.chinese.join(' / ')}`)
  // 顺手确认英文确实渲染出来了，而不是整块空白
  assert.ok(
    result.texts.some((text) => /[A-Za-z]{3,}/.test(text)),
    '英文界面下没有任何英文文本，渲染可能整体失败',
  )
})

test('中文界面下渲染出的文本确实有中文', () => {
  const result = renderPanel({ clientPath, language: 'zh' })
  assert.ok(result.texts.length > 20, `渲染出的文本太少（${result.texts.length}）`)
  assert.ok(result.chinese.length > 0, '中文界面下居然没有中文，语言判定可能反了')
})

test('两种语言的字段名不同：不是把中文原样吐出来', () => {
  const en = renderPanel({ clientPath, language: 'en' })
  const zh = renderPanel({ clientPath, language: 'zh' })
  // 同一个面板在两种语言下文本集合必须不同，否则说明 pick/t() 根本没生效
  assert.notDeepEqual(en.texts, zh.texts, '两种语言渲染结果完全一样，本地化没有生效')
})

test('hostMaxTokens 旁边渲染出可选 maxTokens 快捷项与警告标识', () => {
  // 这一条守的是「面板拿不到窗口容量、算不出墙」时仍然要有的两样东西：
  // 常见输出上限的快捷填入（免去凭印象填一个数字），以及 ⚠ 警告标识
  // （调大它会让墙后退，提醒线更容易越过）。
  //
  // **必须指定 tab: 'compaction'**：面板默认停在第一个页签，另外两页的行从来
  // 不会被渲染。上一次事故就是「字段加在压缩组里、却只测了提醒页签」。
  const result = renderPanel({ clientPath, language: 'zh', tab: 'compaction' })
  // 128k / 64k 只出现在 hostMaxTokens 的 suggestions 里（预设的标签带中文后缀），
  // 所以这两个标签能证明快捷项真的渲染了，而不是恰好撞上别处的文本。
  for (const label of ['128k', '64k']) {
    assert.ok(result.texts.includes(label), `压缩页签里缺少 ${label} 快捷项`)
  }
  assert.ok(
    result.texts.some((text) => text.includes('调大会让墙后退')),
    'hostMaxTokens 的警告标识没有渲染出来',
  )
  // 顺带确认压缩页签确实渲染出来了（否则上面的断言可能是在空集合上通过）
  assert.ok(
    result.texts.some((text) => text.includes('尾部逐字保留')),
    '压缩页签没有渲染出来，桩可能失效了',
  )
})

test('压缩页签在英文界面下也不含中文', () => {
  // 默认页签之外的本地化从来没被守过：新字段的 hintEn/warningEn 漏翻时，
  // 英文界面会静默显示中文。
  const result = renderPanel({ clientPath, language: 'en', tab: 'compaction' })
  assert.ok(result.texts.length > 30, `压缩页签渲染出的文本太少（${result.texts.length}）`)
  assert.deepEqual(result.chinese, [], `压缩页签的英文界面里还有中文：${result.chinese.join(' / ')}`)
})
