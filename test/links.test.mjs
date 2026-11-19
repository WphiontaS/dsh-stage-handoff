import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 仓库里所有会被发布的 markdown。 */
function collectMarkdownFiles() {
  const files = []
  for (const name of readdirSync(root)) {
    if (name.endsWith('.md')) files.push(join(root, name))
  }
  const docsDir = join(root, 'docs')
  for (const name of readdirSync(docsDir)) {
    if (name.endsWith('.md')) files.push(join(docsDir, name))
  }
  return files
}

/** 取出所有 `](target)` 形式的链接目标。 */
function extractLinks(text) {
  const links = []
  const pattern = /\]\(([^)]+)\)/g
  let match
  while ((match = pattern.exec(text)) !== null) links.push(match[1].trim())
  return links
}

test('文档里的相对链接都指向真实文件', () => {
  const files = collectMarkdownFiles()
  assert.ok(files.length >= 10, `应扫描到全部文档，实际 ${files.length} 个`)

  const broken = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const raw of extractLinks(text)) {
      let target = raw
      // Markdown 允许用尖括号包住含空格的路径。
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
      // 外部地址与页内锚点不检查。
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue
      const hashIndex = target.indexOf('#')
      if (hashIndex !== -1) target = target.slice(0, hashIndex)
      if (target.length === 0) continue
      // 去掉 query 之类的尾巴，只留路径。
      const pathPart = target.split('?')[0]
      if (pathPart.length === 0) continue
      const resolved = resolve(dirname(file), pathPart)
      if (!existsSync(resolved)) {
        broken.push(`${relative(root, file)} → ${raw}`)
      }
    }
  }

  assert.deepEqual(broken, [], `发现断链：\n${broken.join('\n')}`)
})

test('README 导航文件指向两个语言版本，且两者都存在', () => {
  const nav = readFileSync(join(root, 'README.md'), 'utf8')
  for (const name of ['README.zh-CN.md', 'README.en.md']) {
    assert.ok(nav.includes(name), `README.md 应该链接到 ${name}`)
    assert.ok(existsSync(join(root, name)), `${name} 必须存在`)
  }
})

test('README 导航覆盖全部随包发布的文档', () => {
  // 导航漏一篇，读者就找不到它。CONTRIBUTING 尤其重要 —— 三条硬约束在那里。
  const nav = readFileSync(join(root, 'README.md'), 'utf8')
  const required = [
    'docs/ARCHITECTURE.md',
    'docs/ANCHOR-POLICY.md',
    'docs/CONFIGURATION.md',
    'docs/PRIVACY.md',
    'docs/SECURITY.md',
    'docs/VALIDATION.md',
    'docs/RELEASING.md',
    'CONTRIBUTING.md',
    'LICENSE',
  ]
  for (const entry of required) {
    assert.ok(nav.includes(entry), `README.md 导航里缺少 ${entry}`)
  }
})

test('README 的 release 安装 URL 指向带当前版本号的资产名', () => {
  // 回归：README 曾经写成 dsh-stage-handoff.tgz（不带版本），而 Pack.ps1 产出的是
  // dsh-stage-handoff-<version>.tgz —— 用户照 README 装会直接 404。
  // 预发布（1.0.0-alpha）不能用 releases/latest，因为 latest 永远指向非预发布版本，
  // 所以两种形式都要接受，但资产名必须含当前版本。
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  for (const name of ['README.en.md', 'README.zh-CN.md']) {
    const text = readFileSync(join(root, name), 'utf8')
    const match = /releases\/(?:latest\/download|download\/[^/\s]+\/)([\w.@-]+\.tgz)/.exec(text)
    assert.ok(match !== null, `${name} 应该包含 release 安装 URL`)
    assert.ok(
      match[1].includes(version),
      `${name} 的资产名应含版本 ${version}，实际是 ${match[1]}`,
    )
  }
})
