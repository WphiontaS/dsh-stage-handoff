// One-off generator for market-index.json (plugin market index format 1).
// Re-run after a release so the newest version and its publish time appear.
import { readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const icon = readFileSync('assets/icon.svg', 'utf8')
const registryUrl = `https://registry.npmjs.org/${pkg.name}`

const res = await fetch(registryUrl)
if (!res.ok) throw new Error(`registry answered ${res.status}`)
const doc = await res.json()
const published = doc.time?.[pkg.version]
if (published === undefined) throw new Error(`version ${pkg.version} has no publish time yet`)

const index = {
  format: 1,
  title: { en: 'dsh-stage-handoff', zh: 'dsh-stage-handoff' },
  description: {
    en: 'Stage-handoff anchors for DeepSeek Harness.',
    zh: 'DeepSeek Harness 的阶段交接锚点。',
  },
  metadata: {
    categories: {
      context: { title: { en: 'Context management', zh: '上下文管理' } },
    },
    labels: {
      compaction: { title: { en: 'Compaction', zh: '压缩' } },
    },
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: {
        en: 'Stage handoff',
        zh: '阶段交接',
      },
      description: {
        en: 'Close out the stage before the context is compacted and hand the next stage a file instead of a summary: a token-threshold reminder, a human-readable anchor under docs/anchors/, then the same compaction engine with its own retention budget.',
        zh: '在上下文被压缩之前收尾当前阶段，把一份文件而不是一份摘要交给下一阶段：到阈值提醒，在 docs/anchors/ 下写人类可读的锚点，再用同一个压缩引擎按自己的保留预算压实。',
      },
      icon: `data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}`,
      author: pkg.repository.url.replace(/^git\+/, '').split('/')[3],
      homepage: pkg.homepage,
      repository: { url: pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') },
      metadata: {
        category: 'context',
        keywords: pkg.keywords,
        labels: ['compaction'],
        sortKeys: {},
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.parse(published) / 1000),
          source: { type: 'npm' },
          // Absent means "any DSH version": the plugin only calls compactRegion, which every
          // release it has been tested against provides.
          engines: {},
        },
      ],
    },
  ],
}

writeFileSync('market-index.json', `${JSON.stringify(index, null, 2)}\n`)
console.log(`wrote market-index.json for ${pkg.name}@${pkg.version} (${published})`)
