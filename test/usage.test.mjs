import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm as removePath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { formatBytes, measureSessions, measureUsage } from '../lib/usage.js'

const rm = (target, options = {}) =>
  removePath(target, { maxRetries: 10, retryDelay: 25, ...options })

/** 每个用例在自己的临时目录里跑，结束后一定删掉。 */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'stage-handoff-usage-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('不存在的目录返回 exists=false，而不是抛错', async () => {
  const missing = join(tmpdir(), `stage-handoff-missing-${process.pid}-${Date.now()}`)
  const result = await measureUsage(missing)
  assert.equal(result.exists, false)
  assert.equal(result.files, 0)
  assert.equal(result.bytes, 0)
})

test('空目录 exists=true 且计数为 0', async () => {
  await withTempDir(async (dir) => {
    const result = await measureUsage(dir)
    assert.equal(result.exists, true)
    assert.equal(result.files, 0)
    assert.equal(result.bytes, 0)
    assert.equal(result.truncated, false)
  })
})

test('统计嵌套目录里的文件数与字节数', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'a.md'), 'x'.repeat(100))
    await mkdir(join(dir, 'detail'))
    await writeFile(join(dir, 'detail', 'b.md'), 'y'.repeat(250))
    const result = await measureUsage(dir)
    assert.equal(result.files, 2)
    assert.equal(result.bytes, 350)
    assert.equal(result.truncated, false)
  })
})

test('超过最大深度时标记 truncated 并说明原因', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'l1/l2/l3/l4/l5'), { recursive: true })
    await writeFile(join(dir, 'l1/l2/l3/l4/l5/deep.md'), 'z')
    const result = await measureUsage(dir, { maxDepth: 2 })
    assert.equal(result.truncated, true)
    assert.match(String(result.reason), /最大深度/)
  })
})

test('超过最大条目数时标记 truncated', async () => {
  await withTempDir(async (dir) => {
    for (let i = 0; i < 20; i += 1) await writeFile(join(dir, `f${i}.md`), 'x')
    const result = await measureUsage(dir, { maxEntries: 5 })
    assert.equal(result.truncated, true)
    assert.match(String(result.reason), /最大条目数/)
  })
})

test('时间预算耗尽时标记 truncated', async () => {
  await withTempDir(async (dir) => {
    for (let i = 0; i < 30; i += 1) await writeFile(join(dir, `f${i}.md`), 'x')
    // budgetMs 为 0 表示一开始就判定超时，用来验证这条路径存在。
    const result = await measureUsage(dir, { budgetMs: 0 })
    assert.equal(result.truncated, true)
    assert.match(String(result.reason), /时间预算/)
  })
})

test('根路径是文件而非目录时给出明确原因', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'not-a-dir.md')
    await writeFile(file, 'x')
    const result = await measureUsage(file)
    assert.equal(result.exists, true)
    assert.equal(result.truncated, true)
    assert.match(String(result.reason), /不是一个目录/)
  })
})

test('formatBytes 用二进制单位并保留一位小数', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.0 kB')
  assert.equal(formatBytes(1536), '1.5 kB')
  assert.equal(formatBytes(1048576), '1.0 MB')
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.0 GB')
})

// --- 会话存储统计 ---------------------------------------------------------

test('measureSessions 统计各会话的 session.* 文件，按大小降序', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'sessions', '--proj--')
    await mkdir(join(root, 'session-a'), { recursive: true })
    await mkdir(join(root, 'session-b'), { recursive: true })
    await writeFile(join(root, 'session-a', 'session.v4.jsonl.zstd'), 'x'.repeat(100))
    await writeFile(join(root, 'session-b', 'session.v4.jsonl.zstd'), 'y'.repeat(300))
    // 干扰项：不属于 session.* 的文件不能计入
    await writeFile(join(root, 'session-a', 'notes.txt'), 'z'.repeat(999))

    const report = await measureSessions(dir)
    assert.equal(report.exists, true)
    assert.equal(report.total, 2)
    assert.equal(report.bytes, 400, '只应统计 session.* 文件')
    assert.equal(report.sessions[0].sessionId, 'session-b', '应按大小降序')
    assert.equal(report.truncated, false)
  })
})

test('measureSessions：没有 sessions 目录时 exists=false 而不是抛错', async () => {
  await withTempDir(async (dir) => {
    const report = await measureSessions(dir)
    assert.equal(report.exists, false)
    assert.equal(report.total, 0)
    assert.equal(report.bytes, 0)
  })
})

test('measureSessions 超过最大会话数时截断并说明原因', async () => {
  await withTempDir(async (dir) => {
    for (let i = 0; i < 5; i += 1) {
      const sessionDir = join(dir, 'sessions', '--p--', `session-${i}`)
      await mkdir(sessionDir, { recursive: true })
      await writeFile(join(sessionDir, 'session.v4.jsonl'), 'x')
    }
    const report = await measureSessions(dir, { maxSessions: 2 })
    assert.equal(report.total, 2)
    assert.equal(report.truncated, true)
    assert.match(String(report.reason), /最大会话数/)
  })
})
