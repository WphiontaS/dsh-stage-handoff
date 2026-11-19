import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir as readDir,
  rm as removePath,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { findStaleBackups } from '../lib/cleanup.js'

const rm = (target, options = {}) =>
  removePath(target, { maxRetries: 10, retryDelay: 25, ...options })

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'stage-handoff-cleanup-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function seedBackups(root, names) {
  const dir = join(root, 'parent-backup')
  await mkdir(dir, { recursive: true })
  for (const name of names) {
    await writeFile(join(dir, name), `content of ${name}`)
  }
  return dir
}

test('没有 parent-backup 目录时返回 exists=false 而不是抛错', async () => {
  await withTempDir(async (dir) => {
    const report = await findStaleBackups(dir)
    assert.equal(report.exists, false)
    assert.equal(report.total, 0)
    assert.deepEqual(report.candidates, [])
  })
})

test('备份数不超过 keep 时没有候选', async () => {
  await withTempDir(async (dir) => {
    await seedBackups(dir, ['anchor-261101.md', 'anchor-261102.md'])
    const report = await findStaleBackups(dir, { keep: 3 })
    assert.equal(report.total, 2)
    assert.equal(report.candidates.length, 0)
    assert.equal(report.kept.length, 2)
    assert.equal(report.reclaimableBytes, 0)
  })
})

test('超过 keep 时把更旧的列为候选，保留最新的', async () => {
  await withTempDir(async (dir) => {
    await seedBackups(dir, [
      'anchor-261101.md',
      'anchor-261102.md',
      'anchor-261103.md',
      'anchor-261104.md',
      'anchor-261105.md',
    ])
    const report = await findStaleBackups(dir, { keep: 2 })
    assert.equal(report.total, 5)
    assert.deepEqual(
      report.candidates.map((entry) => entry.name),
      ['anchor-261101.md', 'anchor-261102.md', 'anchor-261103.md'],
    )
    assert.deepEqual(
      report.kept.map((entry) => entry.name),
      ['anchor-261104.md', 'anchor-261105.md'],
    )
    assert.ok(report.reclaimableBytes > 0)
  })
})

test('只认 anchor-*.md，其他文件永不进入候选', async () => {
  await withTempDir(async (dir) => {
    const backupDir = await seedBackups(dir, ['anchor-261101.md', 'anchor-261102.md'])
    // 这些都不该被当成备份：
    await writeFile(join(backupDir, 'notes.txt'), 'x')
    await writeFile(join(backupDir, 'anchor-261103.md.bak'), 'x')
    await writeFile(join(backupDir, 'other-261101.md'), 'x')
    await mkdir(join(backupDir, 'anchor-notafile.md'))

    const report = await findStaleBackups(dir, { keep: 1 })
    assert.equal(report.total, 2, '只应识别两个真正的备份')
    assert.deepEqual(
      report.candidates.map((entry) => entry.name),
      ['anchor-261101.md'],
    )
  })
})

test('keep 为 0 时全部列为候选，但仍不删除任何文件', async () => {
  await withTempDir(async (dir) => {
    const backupDir = await seedBackups(dir, ['anchor-261101.md', 'anchor-261102.md'])
    const report = await findStaleBackups(dir, { keep: 0 })
    assert.equal(report.candidates.length, 2)
    assert.equal(report.kept.length, 0)

    // 关键断言：报告不等于动作。文件必须还在。
    const { readdir: readDir } = await import('node:fs/promises')
    const remaining = await readDir(backupDir)
    assert.deepEqual(remaining.sort(), ['anchor-261101.md', 'anchor-261102.md'])
  })
})

test('无法解析时间戳的备份只列出、永不进入候选', async () => {
  await withTempDir(async (dir) => {
    const backupDir = await seedBackups(dir, ['anchor-261101.md', 'anchor-random.md'])
    const report = await findStaleBackups(dir, { keep: 0 })
    assert.deepEqual(
      report.candidates.map((entry) => entry.name),
      ['anchor-261101.md'],
    )
    assert.deepEqual(
      report.unknown.map((entry) => entry.name),
      ['anchor-random.md'],
    )
    assert.equal(report.total, 2)

    const remaining = await readDir(backupDir)
    assert.deepEqual(remaining.sort(), ['anchor-261101.md', 'anchor-random.md'])
  })
})

test('条目或时间预算耗尽时报告 truncated，而不是假装完整', async () => {
  await withTempDir(async (dir) => {
    await seedBackups(dir, ['anchor-261101.md', 'anchor-261102.md'])
    const report = await findStaleBackups(dir, { maxEntries: 1 })
    assert.equal(report.truncated, true)
    assert.match(String(report.reason), /最大条目数/)
  })
})

test('混合命名格式按解析后的时间排序，不把较新的备份列为候选', async () => {
  await withTempDir(async (dir) => {
    // 同一天同一小时：带连字符的是 00:30（更新），无连字符的是 00:01（更旧）。
    // localeCompare 把 `-` 排在数字前，会把 00:30 判成更旧、列进候选。
    await seedBackups(dir, ['anchor-261116-0030.md', 'anchor-2611160001.md'])
    const report = await findStaleBackups(dir, { keep: 1 })
    assert.equal(report.total, 2)
    assert.deepEqual(report.kept.map((entry) => entry.name), ['anchor-261116-0030.md'])
    assert.deepEqual(report.candidates.map((entry) => entry.name), ['anchor-2611160001.md'])
  })
})

test('6 位日期与 10 位时间混排时按真实时间比较，而不是按字符串或位数', async () => {
  await withTempDir(async (dir) => {
    // 11-30 00:00（6 位）晚于 11-01 12:00（10 位）。
    await seedBackups(dir, ['anchor-261130.md', 'anchor-261101-1200.md'])
    const report = await findStaleBackups(dir, { keep: 1 })
    assert.deepEqual(report.kept.map((entry) => entry.name), ['anchor-261130.md'])
    assert.deepEqual(report.candidates.map((entry) => entry.name), ['anchor-261101-1200.md'])
  })
})

test('日历上不存在的日期不会被顺延成下个月，而是归入 unknown', async () => {
  await withTempDir(async (dir) => {
    // Date.UTC 会把 2 月 31 日顺延到 3 月 3 日、把非闰年的 2 月 29 日顺延到 3 月 1 日。
    // 顺延后 rank 比真实的下一天更大，于是真正更新的 3 月 1 日会被列成可清理。
    for (const bad of ['anchor-260231-1200.md', 'anchor-260229-1200.md', 'anchor-260431-1200.md']) {
      await rm(join(dir, 'parent-backup'), { recursive: true, force: true })
      await seedBackups(dir, [bad, 'anchor-260301-0900.md'])
      const report = await findStaleBackups(dir, { keep: 1 })
      assert.deepEqual(report.kept.map((entry) => entry.name), ['anchor-260301-0900.md'], bad)
      assert.deepEqual(report.candidates, [], bad)
      assert.deepEqual(report.unknown.map((entry) => entry.name), [bad], bad)
    }
  })
})

test('12 位时间戳没有唯一读法，归入 unknown 而不是按猜测排序', async () => {
  await withTempDir(async (dir) => {
    await seedBackups(dir, ['anchor-200112161458.md', 'anchor-261115-0900.md'])
    const report = await findStaleBackups(dir, { keep: 0 })
    assert.deepEqual(report.unknown.map((entry) => entry.name), ['anchor-200112161458.md'])
    assert.deepEqual(report.candidates.map((entry) => entry.name), ['anchor-261115-0900.md'])
  })
})

test('YYMMDD-HHMMSS 的连字符写法是唯一可读的，必须能排序', async () => {
  // 上面那条钉的是「12 位无连字符没有唯一读法」。但原文写成 6+6 带连字符时读法
  // 只有一个，而兜底提醒恰好指示模型自己把旧锚点归档成
  // `parent-backup/anchor-<时间戳>.md`，格式由模型决定 —— 这种写法真实存在。
  // 原来一律归 unknown，于是唯一可读的备份永远进不了候选，报告还说
  // 「命名无法按时间排序、不会列为候选」。
  await withTempDir(async (dir) => {
    await seedBackups(dir, [
      'anchor-261108-091500.md',
      'anchor-261109-101500.md',
      'anchor-261110-111500.md',
    ])
    const report = await findStaleBackups(dir, { keep: 1 })
    assert.equal(report.total, 3)
    assert.deepEqual(report.unknown, [])
    // keep=1 保留最新（11 日那一个），更早的两个列候选。
    assert.deepEqual(report.kept.map((entry) => entry.name), ['anchor-261110-111500.md'])
    assert.deepEqual(report.candidates.map((entry) => entry.name), [
      'anchor-261108-091500.md',
      'anchor-261109-101500.md',
    ])
  })
})
