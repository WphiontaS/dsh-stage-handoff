// 探针：面板英译覆盖度。
//
// client.js 的写法是「中文原文当 key」：t('中文') 在英文界面下查 EN 表，
// 查不到就原样返回中文。所以漏译不会报错，只会让英文界面里冒出中文。
// 这个探针把代码里所有 t()/tf() 的字面量 key 抠出来，与 EN 表双向对账。
//
// 逻辑与 test/index.test.mjs 里的回归测试同源；这里用于**手动排查**：
// 它会打印漏译、死条目、字段对数量，比测试的断言信息更全。
//
// 用法：node tools/probes/locale-coverage.mjs
// 退出码：0 = 干净；1 = 有漏译或死条目。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', '..', 'lib', 'client.js'), 'utf8')

const all = source.split('\n')
const start = all.findIndex((line) => line.trim() === 'const EN = {')
if (start < 0) throw new Error('找不到 EN 表')
let end = -1
for (let i = start + 1; i < all.length; i += 1) {
  if (all[i].trim() === '}') {
    end = i
    break
  }
}
if (end < 0) throw new Error('EN 表没有闭合')

// 单引号、双引号都要认：仓库没有引号风格约束，只认单引号时 `t("中文")` 完全
// 不进统计（漏译被报成「✓ 全部命中」），而把已有 key 改成双引号又会把它算成死条目。
const QUOTED = `(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')`

const table = all.slice(start + 1, end).join('\n')
const body = all.slice(0, start).concat(all.slice(end + 1)).join('\n')

const entries = new Set(
  [...table.matchAll(new RegExp(`${QUOTED}\\s*:`, 'g'))].map((match) => match[1] ?? match[2]),
)
const calls = new Map()
for (const match of body.matchAll(new RegExp(`\\btf?\\(\\s*${QUOTED}`, 'g'))) {
  const key = match[1] ?? match[2]
  calls.set(key, (calls.get(key) ?? 0) + 1)
}

const hasChinese = (text) => /[\u4e00-\u9fa5]/.test(text)
const missing = [...calls.entries()]
  .filter(([key]) => hasChinese(key))
  .filter(([key]) => !entries.has(key))
  .map(([key, count]) => ({ key, count }))
const dead = [...entries].filter((key) => !calls.has(key))

const zhPairs = (body.match(/\n\s+(label|hint|group|groupHint|title|fixed): '/g) ?? []).length
const enPairs = (body.match(/\n\s+(label|hint|group|groupHint|title|fixed)En:/g) ?? []).length

console.log(`EN 表条目 ${entries.size}`)
console.log(`t()/tf() 调用点 ${[...calls.values()].reduce((a, b) => a + b, 0)}（去重 ${calls.size}）`)
console.log('')

let failed = false
if (missing.length === 0) {
  console.log('✓ 所有含中文的 t()/tf() key 都能在 EN 表查到')
} else {
  failed = true
  console.log(`✗ 漏译 ${missing.length} 条（英文界面会显示中文）：`)
  for (const row of missing) console.log(`   [${row.count}×] ${JSON.stringify(row.key)}`)
}

if (dead.length === 0) {
  console.log('✓ EN 表没有死条目')
} else {
  failed = true
  console.log(`✗ EN 表死条目 ${dead.length} 条（代码里已无调用）：`)
  for (const key of dead) console.log(`   · ${JSON.stringify(key)}`)
}

console.log('')
console.log(`字段级中文/英文对 ${zhPairs} / ${enPairs}${zhPairs === enPairs ? ' ✓' : ' ✗ 不一致（注意：纯英文值如 UTC 不需要 labelEn）'}`)

process.exit(failed ? 1 : 0)
