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
