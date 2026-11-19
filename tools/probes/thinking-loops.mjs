// 探针：抓思维链里的复读（「好。做。好。做。」这类）。
//
// 判据与阈值都在 ./lib/repeat-analysis.mjs（纯函数，有离线测试覆盖）。
// 数据来源：DSH 会话日志 session.v4.jsonl.zstd 的 assistant/message →
// data.message.content[] → type === 'reasoning'。
//
// 用法：
//   node tools/probes/thinking-loops.mjs                      # 最近一次会话
//   node tools/probes/thinking-loops.mjs --session a1b2c3d4    # 会话 id 片段
//   node tools/probes/thinking-loops.mjs --all                 # 全部会话
// 退出码：0 = 干净；1 = 发现可疑；2 = 没找到日志。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { assessTurn } from './lib/repeat-analysis.mjs'

// 会话日志根目录：**必须**由 `DSH_SESSIONS_ROOT` 指定，或由 `DSH_HOME` 推导。
// 不写死任何本机路径 —— 这个仓库是公开的，硬编码一个开发机目录等于把机器布局发出去。
const SESSIONS_ROOT =
  process.env.DSH_SESSIONS_ROOT ??
  (process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? join(process.env.DSH_HOME.trim(), 'sessions')
    : undefined)

if (SESSIONS_ROOT === undefined) {
  console.error(
    '请先设置 DSH_SESSIONS_ROOT（会话日志根目录），或设置 DSH_HOME 让我自己推导。\n' +
      '例如：$env:DSH_SESSIONS_ROOT = "<DSH 安装目录>/data/sessions"',
  )
  process.exit(2)
}

function listSessions() {
  const found = []
  let workspaces = []
  try {
    workspaces = readdirSync(SESSIONS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(SESSIONS_ROOT, entry.name))
  } catch {
    return found
  }
  for (const workspace of workspaces) {
    let sessions = []
    try {
      sessions = readdirSync(workspace, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      const file = join(workspace, session.name, 'session.v4.jsonl.zstd')
      try {
        found.push({ file, id: session.name, mtime: statSync(file).mtimeMs })
      } catch {
        // 没有日志文件
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found
}

function readReasoning(file) {
  let raw
  try {
    raw = zstdDecompressSync(readFileSync(file))
  } catch (error) {
    // 正在写入或已损坏的会话不该让整轮扫描崩掉。
    return { blocks: [], error: error instanceof Error ? error.message : String(error) }
  }
  const blocks = []
  for (const line of raw.toString('utf8').split('\n')) {
    if (line.trim().length === 0) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type !== 'assistant/message') continue
    const content = row.data?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.trim().length > 0) {
        blocks.push({ seq: row.seq, turn: row.data?.turn, step: row.data?.step, text: block.text })
      }
    }
  }
  return { blocks, error: null }
}

function preview(text, max = 60) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

const argv = process.argv.slice(2)
const sessionFilter = argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : null
const all = argv.includes('--all')

let targets = listSessions()
if (sessionFilter !== null) targets = targets.filter((target) => target.id.includes(sessionFilter))
else if (!all) targets = targets.slice(0, 1)
if (targets.length === 0) {
  console.log('没有找到会话日志。用 --session <id> 指定，或用 DSH_SESSIONS_ROOT 指定根目录。')
  process.exit(2)
}

let totalBlocks = 0
let totalChars = 0
let scannedSessions = 0
const skipped = []
const findings = []

for (const target of targets) {
  const { blocks, error } = readReasoning(target.file)
  if (error !== null) {
    // 「跳过」不等于「干净」。默认调用只取 mtime 最新的那一个会话，而那正好是
    // 宿主正在追加写的 session.v4.jsonl.zstd —— 尾部 zstd 帧没写完时解压会抛，
    // 于是唯一的目标被跳过、汇总打「可疑 turn 0 个 ✓」并 exit 0，发版闸门在
    // 一条 reasoning 都没扫的情况下变绿。跳过必须被计数，并在最后决定退出码。
    console.log(`=== ${target.id}\n    跳过（日志读不出：${error}）`)
    skipped.push({ id: target.id, reason: String(error) })
    continue
  }
  scannedSessions += 1
  if (blocks.length === 0) continue

  totalBlocks += blocks.length
  totalChars += blocks.reduce((sum, block) => sum + block.text.length, 0)

  const byTurn = new Map()
  for (const block of blocks) {
    if (!byTurn.has(block.turn)) byTurn.set(block.turn, [])
    byTurn.get(block.turn).push(block)
  }

  let sessionFindings = 0
  for (const [turn, list] of byTurn) {
    list.sort((a, b) => (a.step ?? 0) - (b.step ?? 0))
    const verdict = assessTurn(list)
    if (!verdict.suspicious) continue
    sessionFindings += 1
    findings.push({ id: target.id, turn, list, ...verdict })
  }

  console.log(
    `=== ${target.id}\n    reasoning ${blocks.length} 块 · ` +
      `${(blocks.reduce((sum, block) => sum + block.text.length, 0) / 1000).toFixed(1)}k 字符 · ` +
      `turn ${byTurn.size} 个 · 可疑 ${sessionFindings} 个${sessionFindings === 0 ? ' ✓' : ''}`,
  )
}

console.log('\n--- 汇总 ---')
console.log(`reasoning ${totalBlocks} 块，${(totalChars / 1000).toFixed(1)}k 字符`)
if (skipped.length > 0) {
  console.log(`跳过 ${skipped.length} 个会话（读不出日志）：`)
  for (const entry of skipped.slice(0, 5)) console.log(`  ${entry.id}：${entry.reason}`)
}
if (scannedSessions === 0) {
  console.log(`\n✗ 一个会话都没扫到（${skipped.length} 个目标全部跳过），这条检查什么也没证明。`)
  process.exit(2)
}
console.log(`可疑 turn ${findings.length} 个${findings.length === 0 ? ' ✓' : ''}`)

findings.sort((a, b) => b.frag.fillers - a.frag.fillers)
for (const finding of findings.slice(0, 8)) {
  console.log(`\n  ${finding.id} · turn ${finding.turn} · ${finding.list.length} 块 · 语气短行 ${finding.frag.fillers} 条`)
  console.log(`  命中：${finding.reasons.join('；')}`)
  if (finding.frag.topFiller !== null) {
    console.log(`  最高频碎片：${JSON.stringify(finding.frag.topFiller)} × ${finding.frag.topFillerCount}`)
  }
  const shortBlocks = finding.list.filter((block) => block.text.length < 80).slice(0, 5)
  if (shortBlocks.length > 0) {
    console.log('  碎片样例：')
    for (const block of shortBlocks) console.log(`    step ${block.step}: ${JSON.stringify(preview(block.text))}`)
  }
}

process.exit(findings.length > 0 ? 1 : 0)
