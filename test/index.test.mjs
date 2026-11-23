/**
 * dsh-stage-handoff 离线自测：配置校验、提醒文案、pre-step 注入与节流、
 * compaction 探针语义、候选区间预演。用最小 ctx 替身，不启动 DSH，
 * 不读写任何真实会话。
 */
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm as removePath,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  apply,
  noticeText,
  resolveConfig,
  name,
  inject,
  Config,
  createBoundedJsonlWriter,
  collectToolFacts,
  appendRecentFact,
  coverageForRange,
  hasPendingToolCall,
  recentFactFromEvent,
  scanStageNames,
  resetSharedGates,
  recoverStaleStageReservation,
  SESSION_FACTS_PROJECTION,
  noticeStreamSummary,
  STREAM_NOTICE_SEVERITY,
  recentToolSignatures,
  hostCompactionWall,
  ensureAnchorRootIgnored,
  readLatestSummaryFromLog,
  SESSION_LOG_MAX_BYTES,
} from '../lib/index.js'
import { trailingSequenceRepeat } from '../lib/repeat-scan.js'
import { elidePathsIn, redactSecrets, shortenPath } from '../lib/util.js'
import { shortenCwdKey } from '../lib/usage.js'
import {
  CONFIG_KEYS,
  TIME_ZONE_PATTERN,
  isAbsolutePathInput,
  normalizeAnchorRoot,
  normalizeTimeZone,
  parseTokenCount,
  resolveConfigLenient,
} from '../lib/config.js'
import { readUtf8Bounded } from '../lib/util.js'
import {
  findIsolatedService,
  openTurnBoundaryIdx,
  readLatestSummary,
  readLatestSummaryWindow,
  selectRetainedRange,
  describeSeqRange,
} from '../lib/index.js'

const rm = (target, options = {}) =>
  removePath(target, { maxRetries: 10, retryDelay: 25, ...options })

/**
 * 造一个够用的插件上下文替身。
 * @param compaction - 提供时视为 compaction 服务就位；缺省时 `ctx.inject(['compaction'])`
 *   按 cordis 的硬依赖语义**不触发**，用来验证「未触达」分支。
 * @param engine - 提供时在 `ctx.reflect.store` 里放一条被 isolate 的 compaction 实现，
 *   用来验证绕过隔离直接调 `compactRegion` 的那条路。
 * @param balanceGuard - `@deepseek-ai/dsh-compaction` 的 `toolPairingBalancedBefore` 替身；
 *   传 null 模拟解析失败。
 */
/**
 * 提醒类用例的统一入口：先把提醒线钉死在 300000，再叠加用例自己的配置。
 *
 * 这些用例的 total 值（350000 之类）是围绕 300k 设计的。如果让它们跟随产品
 * 默认值，那么默认值一调整（例如调研后把 300k 改成 400k），十几个用例就会集体
 * 漂移，测试反而在报告「功能坏了」。显式声明阈值，两边才能各自独立演进。
 * @param ctx - 假上下文。
 * @param [extra] - 该用例自己的配置覆盖。
 */
function applyWithLine(ctx, extra = {}) {
  apply(ctx, { notifyTokens: 300000, ...extra })
}

function fakeContext({
  total = 0,
  window = 1000000,
  measureThrows = false,
  nodes = undefined,
  compaction = undefined,
  engine = undefined,
  settings = undefined,
  /** 假的 llm 服务：`{ resolveModelInfo(provider, model) }`。缺省时 `'auto'` 走降级。 */
  llm = undefined,
  balanceGuard = /** @type {(...args: unknown[]) => boolean} */ (() => true),
  commandNames = ['anchor', 'compact'],
  /** 让 commands.find 抛错：用来验证 status 的第二处调用有降级。 */
  commandFindThrows = false,
  /**
   * 覆盖 `commands.execute` 的返回值。缺省返回一条「真压缩成功」的回执。
   *
   * 需要它是因为 `command-compact` 对**没有可压历史**也返回 `kind: 'success'`，
   * 与真压缩唯一的可判别差别是缺 `sourceEventSeq` —— 那条路径必须能走到。
   * @type {{ result?: { kind?: string, text?: string, sourceEventSeq?: number } } | undefined}
   */
  executeResult = undefined,
  withLoader = true,
  withCommands = true,
  withTools = true,
  agents = undefined,
  withAgents = true,
  withConnection = false,
  withSessionProjections = true,
  projectionMode = 'normal',
  withRecentProjectionFallback = true,
} = {}) {
  const listeners = new Map()
  const registered = []
  const registeredTools = []
  const logs = []
  const executeCalls = []
  const fetchRoutes = []
  let sessionFactsDefinition
  const defaultTurnBoundary = {
    openTurnStartSeq: null,
    lastStepStartSeq: null,
    lastStepBoundary: null,
    lastTurn: 0,
  }
  const agentService = agents ?? {
    list: () => [],
    turnBoundaryOf: (sessionValue) => sessionValue?.turnBoundary ?? defaultTurnBoundary,
  }
  function projectionState(session) {
    if (projectionMode === 'throw') throw new Error('projection replay failed')
    if (projectionMode === 'invalid') return { version: 1, surface: 'not-an-array', recent: [] }
    if (projectionMode === 'malformed-node') {
      return { version: 2, surface: [{ seq: 1 }], invalidReason: undefined }
    }
    if (sessionFactsDefinition === undefined) throw new Error('session facts projection not registered')
    let state = sessionFactsDefinition.init(
      session?.header ?? {},
      session?.inheritedEventCount ?? 0,
    )
    let events = []
    if (typeof session?.snapshotEvents === 'function' && Number.isSafeInteger(session.seq)) {
      events = [...session.snapshotEvents(0, session.seq)]
    }
    const bySeq = new Map()
    for (let index = 0; index < events.length; index += 1) {
      const raw = events[index]
      const seq = Number.isSafeInteger(raw?.seq) ? raw.seq : index
      const event = raw?.seq === seq ? raw : { ...raw, seq }
      bySeq.set(seq, event)
      state = sessionFactsDefinition.apply(state, event)
    }
    if (Array.isArray(session?.surface?.nodes)) {
      state = {
        ...state,
        surface: session.surface.nodes.map((seq, index) => {
          const event = bySeq.get(seq)
          const existing = state.surface.find((node) => node?.seq === seq)
          return {
            seq,
            type:
              existing?.type ??
              event?.type ??
              (index === 0 && session.surface.nodes[0] === 1 ? 'system/message' : 'message'),
            checkpoint:
              existing?.checkpoint === true ||
              (event?.type === 'user/message' &&
                event?.data?.source?.kind === 'compact-checkpoint'),
          }
        }),
      }
    }
    return {
      ...state,
      // The fake context keeps recent facts on the handle so plugin-level
      // tests can exercise the fallback without emitting every test event.
      ...(withRecentProjectionFallback
        ? { recent: factsForSession(session, session?.surface?.nodes).recent }
        : {}),
    }
  }

  const sessionProjections = {
    register(definition) {
      sessionFactsDefinition = definition
      return {
        stateOf: projectionState,
      }
    },
  }

  const ctx = {
    // settings.configure 的第二个参数是 owner Fiber；真实 ctx 一定有。
    fiber: { id: 'test-fiber' },
    get(serviceName) {
      if (serviceName === 'sessionProjections' && withSessionProjections) return sessionProjections
      return undefined
    },
    // 模拟 cordis：isolate 只拦属性解析，实现本身仍在全局 reflect.store 里。
    ...(engine === undefined
      ? {}
      : {
          reflect: {
            store: {
              [Symbol('compaction')]: {
                name: 'compaction',
                value: engine,
                ctx: { fiber: { name: 'compaction-basic' } },
              },
            },
          },
        }),
    tokenMeter: {
      measure() {
        if (measureThrows) throw new Error('replay broken')
        // `total` 允许传函数：压缩会真的改变占用，而「压缩前测、压缩后判断」
        // 这类缺陷（例如兜底压缩把压缩前的总量记进提醒配额）只有让总量能在
        // 一次用例内变化才测得出来。传常量时行为与从前完全一致。
        const readTotal = /** @type {number | (() => number)} */ (total)
        const resolved = typeof readTotal === 'function' ? readTotal() : readTotal
        return { totalTokens: resolved, ...(nodes === undefined ? {} : { nodes }) }
      },
      contextPressure() {
        return { contextWindow: window }
      },
    },
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    ...(withLoader
      ? {
          loader: {
            internal: {
              async import(specifier) {
                if (specifier === '@deepseek-ai/dsh-compaction') {
                  return balanceGuard === null ? {} : { toolPairingBalancedBefore: balanceGuard }
                }
                return { createUserMessage: (input) => ({ ...input, role: 'user', id: 'uuid-test' }) }
              },
            },
          },
        }
      : {}),
    on(event, handler) {
      listeners.set(event, handler)
    },
    inject(services, callback) {
      const wanted = Array.isArray(services) ? services : [services]
      // 模拟 cordis：任一声明的服务没就位，这个子插件就不启动。
      if (wanted.includes('compaction') && compaction === undefined) return
      if (wanted.includes('settings') && settings === undefined) return
      // 真实的 cordis：声明的服务没就位，子插件根本不启动。默认提供这两个，
      // 但测试可以关掉它们来走降级路径。
      if (wanted.includes('commands') && !withCommands) return
      if (wanted.includes('tools') && !withTools) return
      if (wanted.includes('agents') && !withAgents) return
      if (wanted.includes('connection') && !withConnection) return
      if (wanted.includes('sessionProjections') && !withSessionProjections) return
      callback({
        effect(factory) {
          const dispose = factory()
          return typeof dispose === 'function' ? dispose : undefined
        },
        get() {
          return undefined
        },
        ...(wanted.includes('settings') ? { settings } : {}),
        // `hostMaxTokens: 'auto'` 靠它查模型元数据。默认不提供（与真实宿主里
        // llm 服务缺失时一致），测试要验 auto 就显式传 `llm`。
        ...(wanted.includes('llm') && llm !== undefined ? { llm } : {}),
        ...(wanted.includes('commands')
          ? {
              commands: {
                register(definition) {
                  registered.push(definition)
                  return () => {}
                },
                list() {
                  return commandNames.map((commandName) => ({ name: commandName }))
                },
                find(_agent, commandName) {
                  if (commandFindThrows) throw new Error('commands.find exploded')
                  return commandNames.includes(commandName)
                    ? { name: commandName, handler: async () => ({ kind: 'success', text: 'ok' }) }
                    : undefined
                },
                async execute(agentArg, line, attachments, signal) {
                  executeCalls.push({
                    agent: agentArg,
                    line,
                    attachments,
                    hasSignal: signal !== undefined,
                  })
                  if (executeResult !== undefined) return executeResult
                  // 缺省回执必须是「**真**压缩成功」。`command-compact` 对没有可压
                  // 历史的情况也回 `kind: 'success'`，唯一可判别的差别就是有没有
                  // `sourceEventSeq`；缺了它，缺省回执就等价于 no-op，于是排队
                  // `/compact` 的成功分支（写冷却、清配额、清待告知失败）整段没有
                  // 任何用例经过 —— 把这个条件改成 `if (false)` 全量仍是绿的。
                  return {
                    result: {
                      kind: 'success',
                      text: 'Compacted 4 history items (~1000 tokens).',
                      sourceEventSeq: 42,
                    },
                  }
                },
              },
            }
          : {}),
        ...(wanted.includes('tools')
          ? {
              tools: {
                register(definition) {
                  registeredTools.push(definition)
                  return () => {}
                },
              },
            }
          : {}),
        ...(wanted.includes('compaction') ? { compaction } : {}),
        ...(wanted.includes('agents') ? { agents: agentService } : {}),
        ...(wanted.includes('sessionProjections') ? { sessionProjections } : {}),
        ...(wanted.includes('connection')
          ? {
              connection: {
                fetch: {
                  register(route) {
                    fetchRoutes.push(route)
                    return async () => {}
                  },
                },
              },
            }
          : {}),
      })
    },
  }
  return {
    ctx,
    listeners,
    registered,
    registeredTools,
    logs,
    executeCalls,
    fetchRoutes,
    sessionFacts: projectionState,
    getSessionFactsDefinition: () => sessionFactsDefinition,
    setTotal: (value) => {
      total = value
    },
  }
}

/**
 * 固定会话对象：真实场景里 agent.session 在会话存活期间是同一个引用。
 *
 * 因为它是**模块级常量**，所有用例共用同一个 session 引用；而提醒配额、压缩互斥这些
 * 闸现在是进程级共享的（双实例部署必须如此），所以每条用例开头都要把共享表清空，
 * 否则前一条用例留下的 `lastNotified` 会让后一条看起来「不提醒」。
 */
const AGENT = {
  session: {
    id: 's1',
    seq: 0,
    surface: { nodes: [] },
    snapshotEvents: () => [],
  },
}

beforeEach(() => {
  resetSharedGates()
})

/** 走一遍 pre-step waterfall，返回最终 decision。 */
async function runPreStep(listener, { step = 1, turn = 1, agent = AGENT } = {}) {
  const decision = { kind: 'enter', messages: [{ id: 'existing' }] }
  const payload = {
    agent,
    messages: [],
    turn,
    step,
    signal: { aborted: false },
  }
  return listener(payload, async () => decision)
}

/** 走一遍真实 Host 的串行 turn-stopping 边界。 */
async function runTurnStopping(
  listener,
  { turn = 1, agent = AGENT, signal = { aborted: false } } = {},
) {
  assert.ok(listener, '必须注册了 agent/turn-stopping')
  return listener({ agent, turn, signal })
}

test('导出的插件元信息符合 host 插件契约', () => {
  assert.equal(name, 'stage-handoff')
  assert.deepEqual(inject, ['tokenMeter'])
  // 回归：compaction / tools 若进了顶层 inject，服务不在本插件视野时会整个插件
  // 不启动（连提醒都消失）。它们只能由可选子插件探测。
  assert.equal(inject.includes('compaction'), false, 'compaction 只能走子插件探测')
  assert.equal(inject.includes('tools'), false, 'tools 只能走可选子注入')
})

test('默认配置：提醒线 363520（= 1M 窗口压缩墙的一半）、重复间隔 25000、尾部保留 32000', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.notifyTokens, 363520)
  assert.equal(config.notifyRepeatDelta, 25000)
  assert.equal(config.notifyCooldownMs, 300000)
  assert.equal(config.anchorRoot, 'docs/anchors')
  assert.equal(config.anchorLimitChars, 8000)
  assert.equal(config.compactRetainTokens, 32000)
  assert.equal(config.enabled, true)
  assert.equal(Object.isFrozen(config), true)
})

test('Schemastery volatile 引用会先取 get() 再由语义校验归一化', () => {
  const validated = /** @type {any} */ (Config['~standard'].validate({})).value
  assert.equal(validated.enabled.get(), true)
  assert.equal(validated.notifyTokens.get(), 363520)

  const config = resolveConfig(validated)
  assert.equal(config.enabled, true)
  assert.equal(config.notifyTokens, 363520)
  assert.equal(config.anchorRoot, 'docs/anchors')
})

test('Config 在 Host 边界拒绝设置页可提交的非法值', () => {
  const issues = (patch) => /** @type {any} */ (Config['~standard'].validate(patch)).issues
  assert.ok(issues({ notifyTokens: 0 }))
  assert.ok(issues({ notifyRepeatDelta: -1 }))
  assert.ok(issues({ compactCooldownMs: 1.5 }))
  assert.ok(issues({ anchorRoot: 'docs/../outside' }))
  assert.ok(issues({ anchorRoot: 'docs\n/outside' }))
  assert.ok(issues({ anchorLimitChars: 0 }))
  assert.ok(issues({ anchorTimeZone: '+14:01' }))
  assert.ok(issues({ anchorTimeZone: '-12:01' }))
  assert.ok(issues({ anchorTimeZone: '+99' }))
  assert.equal(issues({ anchorTimeZone: 'UTC' }), undefined)
  assert.equal(issues({ anchorTimeZone: '-12' }), undefined)
  assert.equal(issues({ anchorTimeZone: '+14' }), undefined)
  assert.equal(issues({ anchorTimeZone: 330 }), undefined)
})

test('loader/volatile-update 会刷新实时语义配置', async () => {
  let notifyTokens = 300 * 1024
  const raw = {
    enabled: { get: () => true },
    notifyTokens: { get: () => notifyTokens },
  }
  const harness = fakeContext({ total: 350_000 })
  apply(harness.ctx, raw)

  notifyTokens = 500 * 1024
  harness.listeners.get('loader/volatile-update')()
  const decision = await runPreStep(harness.listeners.get('agent/pre-step'))
  assert.equal(decision.messages.length, 1, '350k 已低于刷新后的 500k 提醒线')
})

test('人类单位：300k / 1m / 纯数字都能解析', () => {
  const issues = (patch) => /** @type {any} */ (Config['~standard'].validate(patch)).issues
  assert.equal(resolveConfig({ notifyTokens: '300k' }).notifyTokens, 307200)
  assert.equal(resolveConfig({ notifyTokens: '1m' }).notifyTokens, 1048576)
  assert.equal(resolveConfig({ notifyTokens: '300000' }).notifyTokens, 300000)
  assert.equal(resolveConfig({ notifyTokens: 300000 }).notifyTokens, 300000)
  assert.equal(resolveConfig({ notifyRepeatDelta: '25k' }).notifyRepeatDelta, 25600)
  assert.equal(resolveConfig({ compactRetainTokens: '100k' }).compactRetainTokens, 102400)
  assert.equal(issues({ notifyRepeatDelta: '25k' }), undefined)
  assert.equal(issues({ compactRetainTokens: '100k' }), undefined)
})

test('注入的流式提醒是定性的，不带次数（否则会被抄进锚点）', () => {
  // 实测事故：提醒原本写「同一行内容已重复 77 次（占 95 行里的 81%）」。这种数字
  // 模型很容易顺手抄进 anchor.md，而锚点只有 8,000 字符预算、下一阶段根本用不上它 ——
  // 挤掉的不是空间，是真正要留的那几条事实。
  // 诊断用的精确数字走 describeStreamVerdict（status / 日志），不进上下文。
  /** @type {Array<'tail'|'line'>} */
  const kinds = ['tail', 'line']
  for (const kind of kinds) {
    const summary = noticeStreamSummary({ kind })
    assert.equal(typeof summary, 'string')
    assert.ok(summary.length > 0, '不能是空串')
    assert.doesNotMatch(summary, /\d/, '注入文案不能出现数字')
  }
  // 两种形态要说得不一样，否则模型无从判断是哪一类
  assert.notEqual(noticeStreamSummary({ kind: 'tail' }), noticeStreamSummary({ kind: 'line' }))
  // 缺 kind 时按 tail 兜底，不能抛
  assert.equal(noticeStreamSummary({}), STREAM_NOTICE_SEVERITY.tail)
  assert.equal(noticeStreamSummary(null), STREAM_NOTICE_SEVERITY.tail)
})

test('工具序列循环：同调用连续 5 遍才算，正常的推进不报', () => {
  // 复读的另一种形态：思考每轮都不一样，只有工具调用在原地打转。
  // 阈值取 5 而非常见的 3，因为本插件的事件环只有 files/commands 两列参数，
  // 「edit 同一个文件 ×3」这种正常的多轮修改会和真循环长得一样。
  // 真实数据：阈值 3 命中 3.09%（样本几乎全是正常修改），阈值 5 命中 0 次。
  const five = Array.from({ length: 5 }, () => 'read|a|')
  const loop = trailingSequenceRepeat(five)
  assert.notEqual(loop, null)
  assert.equal(loop.period, 1)
  assert.equal(loop.repeats, 5)
  assert.equal(trailingSequenceRepeat(five.slice(0, 4)), null, '4 遍不够')
  // A B A B ... 周期 2 也要报
  const abab = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 'edit|a|' : 'pwsh||go test'))
  assert.equal(trailingSequenceRepeat(abab)?.period, 2)
  // 正常推进不能报
  assert.equal(trailingSequenceRepeat(['read|a|', 'edit|b|', 'pwsh||go build', 'read|c|', 'grep|d|']), null)
  // 同工具不同参数不算循环（这正是签名要带参数的原因）
  assert.equal(trailingSequenceRepeat(['read|a|', 'read|b|', 'read|c|', 'read|d|', 'read|e|']), null)
})

test('recentToolSignatures 只取 tool/call，并把参数带进签名', () => {
  const recent = [
    { type: 'tool/call', name: 'read', files: ['a.txt'] },
    { type: 'tool/result', name: 'read', files: ['a.txt'] },
    { type: 'tool/call', name: 'pwsh', commands: ['go build'] },
    { type: 'tool/call', name: 'web_fetch' },
    { type: 'tool/call' },
    { type: 'assistant/message' },
  ]
  // web_fetch 没有任何参数列 → 被跳过：签名只有工具名时无法区分三个不同 URL，
  // 实测里它正是误报来源（见函数注释）。
  assert.deepEqual(recentToolSignatures(recent), ['read|a.txt|', 'pwsh||go build'])
  assert.notEqual(
    recentToolSignatures([{ type: 'tool/call', name: 'read', files: ['a.txt'] }])[0],
    recentToolSignatures([{ type: 'tool/call', name: 'read', files: ['b.txt'] }])[0],
  )
  assert.deepEqual(recentToolSignatures(undefined), [])
})

test('同一 step 内的并行重复调用只算一次', () => {
  // 一个 step 就是一个 LLM response，模型可以在里面并行发多个 tool/call。
  // 并行发两个相同的 edit 是「一次尝试」，不是「原地打转两次」。
  // 实测：48,781 个 (turn,step) 里 422 个出现了完全相同的调用。
  const parallel = [
    { type: 'tool/call', name: 'edit', files: ['a.md'], turn: 3, step: 8 },
    { type: 'tool/call', name: 'edit', files: ['a.md'], turn: 3, step: 8 },
  ]
  assert.deepEqual(recentToolSignatures(parallel), ['edit|a.md|'], '并行重复只留一个')
  // 不同 step 的相同调用必须各算一次 —— 那才是跨轮重复，正是要抓的东西
  const sequential = [
    { type: 'tool/call', name: 'edit', files: ['a.md'], turn: 3, step: 1 },
    { type: 'tool/call', name: 'edit', files: ['a.md'], turn: 3, step: 2 },
    { type: 'tool/call', name: 'edit', files: ['a.md'], turn: 3, step: 3 },
  ]
  assert.equal(recentToolSignatures(sequential).length, 3, '不同 step 不能去重')
  // 同一 step 里不同参数的调用都要留
  const parallelDifferent = [
    { type: 'tool/call', name: 'read', files: ['a.txt'], turn: 1, step: 1 },
    { type: 'tool/call', name: 'read', files: ['b.txt'], turn: 1, step: 1 },
  ]
  assert.equal(recentToolSignatures(parallelDifferent).length, 2, '同 step 不同参数都要留')
})

test('流式守卫：默认开启、可显式关、非法值被拒', () => {
  // 默认开启是明确的用户要求。它只提醒、从不截断，判据也保守（尾部连续重复 5 遍、
  // 覆盖 ≥200 字符，每 24 个 delta 才查一次），所以默认开着；要安静就在面板关掉。
  assert.equal(resolveConfig({}).streamGuard, true, '默认必须开启')
  assert.equal(resolveConfig({ streamGuard: true }).streamGuard, true)
  assert.equal(resolveConfig({ streamGuard: false }).streamGuard, false)
  // 与其他布尔字段同一套校验：只认真布尔，字符串要拦下来（否则 'false' 会被当成真值）
  assert.throws(() => resolveConfig({ streamGuard: 'true' }), /布尔/)
  assert.throws(() => resolveConfig({ streamGuard: 1 }), /布尔/)
})

test('复读中断：默认关闭，只认布尔值', () => {
  // 默认必须是关的。它是破坏性动作：DSH 的 reject 在引擎里是
  // `turnEnds = { kind: 'blocked' }` —— 整个 turn 当场结束，用户看到的是被中断的回合。
  // 开它的理由只有一个：实测单纯提醒的效果只有约 20%（见 docs/VALIDATION.md）。
  assert.equal(resolveConfig({}).rejectOnRepeat, false, '默认必须关闭')
  assert.equal(resolveConfig({ rejectOnRepeat: true }).rejectOnRepeat, true)
  assert.equal(resolveConfig({ rejectOnRepeat: false }).rejectOnRepeat, false)
  assert.throws(() => resolveConfig({ rejectOnRepeat: 'yes' }), /布尔/)
})

test('rejectOnRepeat 开启后，一行占满窗口就中断 turn；关闭时只提醒', async () => {
  // `reject` 在 DSH 引擎里是 `turnEnds = { kind: 'blocked' }`：整个 turn 当场结束。
  // 所以它默认关闭，只有在行级占比 ≥ 0.8（一行占满整个思考窗口）时才允许触发。
  // 守卫按 session 用 WeakMap 隔离，这里用独立 agent 免得和别的用例串味。
  const makeAgent = (id) => ({
    session: { id, seq: 0, surface: { nodes: [] }, snapshotEvents: () => [] },
  })
  /** 喂一个「同一片段连续重复几百遍」的思考流（纯周期型复读）。
   *
   * 必须把 `agent` 一起传：守卫是按 `payload.agent.session` 用 WeakMap 隔离的，
   * 不传 agent 会喂进一个以 `undefined` 为键的实例，而 pre-step 查的是另一个。
   *
   * `turn`/`step` 显式传：**消费必须发生在同一个 turn 内**。原来这里默认喂
   * turn 1、却在 turn 2 的 pre-step 消费，那正好是「跨 turn 用旧结论」的缺陷
   * ——它会让一个干净的新 turn 被 reject 掉，见下方「跨 turn 的旧结论必须作废」。
   */
  const feedLoop = (listener, agent, turn = 1, step = 1) => {
    listener({ agent, frame: { type: 'start', turn, step } })
    const loop = '做。'.repeat(400)
    for (let at = 0; at < loop.length; at += 20) {
      listener({ agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: loop.slice(at, at + 20) } } })
    }
    listener({ agent, frame: { type: 'end' } })
  }

  // 开启：应当直接 reject
  const on = fakeContext()
  apply(on.ctx, { rejectOnRepeat: true })
  const onAgent = makeAgent('reject-on')
  feedLoop(on.listeners.get('agent/assistant-stream'), onAgent, 2, 1)
  const rejected = await runPreStep(on.listeners.get('agent/pre-step'), { turn: 2, step: 2, agent: onAgent })
  assert.equal(rejected.kind, 'reject', '占比 0.8 以上应当中断这一轮')

  // 关闭（默认）：同样输入只产生一条提醒，turn 继续
  const off = fakeContext()
  apply(off.ctx, {})
  const offAgent = makeAgent('reject-off')
  feedLoop(off.listeners.get('agent/assistant-stream'), offAgent, 2, 1)
  const reminder = await runPreStep(off.listeners.get('agent/pre-step'), { turn: 2, step: 2, agent: offAgent })
  assert.equal(reminder.kind, 'enter', '默认必须只提醒，不中断')
  assert.ok(reminder.messages.length > 1, '应当多出一条注入的提醒消息')
})

test('跨 turn 的旧结论必须作废：不能 reject 掉一个干净的新 turn', async () => {
  // 复读发生在 turn 1 的末步，turn 1 正常结束（没有 pre-step 来消费这个结论），
  // 用户随后发了一条新消息开 turn 2。原来 `movedOn` 的第一项是
  // `turnNow > streamVerdict.turn`，于是 turn 2 的 step 1 会消费 turn 1 的结论：
  // `rejectOnRepeat` 开启时返回 `{ kind: 'reject' }`，而引擎的 `inbox.claim()`
  // 已经把这一步的用户消息取走 —— 那条消息既没进模型也没留在队列里。
  const makeAgent = (id) => ({
    session: { id, seq: 0, surface: { nodes: [] }, snapshotEvents: () => [] },
  })
  const feed = (listener, agent, turn, step) => {
    listener({ agent, frame: { type: 'start', turn, step } })
    const loop = '做。'.repeat(400)
    for (let at = 0; at < loop.length; at += 20) {
      listener({ agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: loop.slice(at, at + 20) } } })
    }
    listener({ agent, frame: { type: 'end' } })
  }

  const on = fakeContext()
  apply(on.ctx, { rejectOnRepeat: true })
  const agent = makeAgent('cross-turn')
  // **step 必须是 1，消费必须是 step 2**。
  //
  // 这一对数字不是随便挑的：`movedOn` 的两个条件是「跨 turn」与「同 turn 但更后
  // 的 step」。旧实现是二者的**或**，所以只有当「不是同 turn」且「stepNow 不小于
  // verdict.step」时，两种实现才会给出不同结果。
  // 原来写的是 turn1/step5 → turn2/step1：`1 > 5` 为假，于是旧实现也判 movedOn=false，
  // 这条用例**永远绿**——mutation 测试（把 movedOn 还原成 `turnNow > verdict.turn || sameTurn`）
  // 跑全套仍 455/455 通过，证明它当时守不住任何东西。
  feed(on.listeners.get('agent/assistant-stream'), agent, 1, 1)
  const decision = await runPreStep(on.listeners.get('agent/pre-step'), { turn: 2, step: 2, agent })
  assert.notEqual(
    decision.kind,
    'reject',
    '1 是数据丢失级的：reject 会让引擎当场结束 turn，而 inbox.claim() 已经把用户消息取走',
  )
  assert.equal(decision.kind, 'enter', '新 turn 的 step 2 不能被上个 turn 的结论打断')
  assert.equal(decision.messages.length, 1, '旧结论也不该被当成「上一步」再提醒一遍')
})

test('同一 turn 先轻度后严重：reject 不能被「本 turn 已提醒过」压住', async () => {
  // 这条钉的是「提醒」与「中断」共用同一个按 turn 的去重键所造成的问题：
  // 先用 0.5 线命中的轻度形态发过提醒，下一步升级到 0.8 以上时，`lastNotice === key`
  // 会让 reject 分支直接跳过 —— 连这一步的提醒也不再发（提示已发完）。而提醒实测只有
  // 约 20% 有效，「提醒无效后继续打转」正是这个选项存在的场景。
  const makeAgent = (id) => ({
    session: { id, seq: 0, surface: { nodes: [] }, snapshotEvents: () => [] },
  })
  const { ctx, listeners } = fakeContext()
  apply(ctx, { rejectOnRepeat: true })
  const agent = makeAgent('reject-escalation')
  const stream = listeners.get('agent/assistant-stream')
  const preStep = listeners.get('agent/pre-step')
  const push = (text) =>
    stream({ agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text } } })

  stream({ agent, frame: { type: 'start', turn: 1, step: 1 } })
  for (let index = 0; index < 12; index += 1) push('好。\n')
  for (let index = 0; index < 12; index += 1) push(`第 ${index} 行正常内容。\n`)
  stream({ agent, frame: { type: 'end' } })

  const mild = await runPreStep(preStep, { turn: 1, step: 2, agent })
  assert.equal(mild.kind, 'enter', '轻度形态这一步不该中断')
  assert.ok(mild.messages.length > 0, '轻度形态应当发一条提醒')

  // 同一 turn 继续：升级到「同一片段连续重复 ≥100 遍」。周期是 3 字符（`好。\n`），
  // 所以 120 行才是 120 遍 —— 按行数猜周期会把这条判据测成永不成立。
  stream({ agent, frame: { type: 'start', turn: 1, step: 2 } })
  for (let index = 0; index < 120; index += 1) push('好。\n')
  stream({ agent, frame: { type: 'end' } })

  const severe = await runPreStep(preStep, { turn: 1, step: 3, agent })
  assert.equal(severe.kind, 'reject', '升级后必须真的中断，而不是被「本 turn 已提醒过」压住')
})

test('自动压缩退避期间「同一原因只解释一次」不能被倒计时打破', async () => {
  // 去重键曾经是 `outcome.reason`，而退避的 reason 里带实时倒计时（「还需约 59 秒」），
  // 每一秒都是一个「新原因」，于是整段退避期里每一步都重讲一遍 —— 而注入文案正对模型
  // 保证「这个原因只解释一次，后续不会每步重复」。键改成 `autoCompact` 已经给出的
  // `failureKey`（不含倒计时）之后才会真的只解释一次。
  let total = 900000
  const { ctx, listeners } = fakeContext({ total, window: 1000000 })
  // 跨 turn 要改占用：直接替换 measure（`fakeContext` 的 `total` 声明为数字）。
  ctx.tokenMeter.measure = () => ({ totalTokens: total, nodes: [] })
  apply(ctx, {
    notifyTokens: 300000,
    notifyRepeatDelta: 1,
    notifyCooldownMs: 0,
    agentDecidesCompaction: false,
  })
  const preStep = listeners.get('agent/pre-step')
  const agent = {
    session: { id: 'skip-dedupe', seq: 0, surface: { nodes: [] }, snapshotEvents: () => [] },
  }
  const skipMark = '自动压缩本轮没有启动'
  const textsOf = (decision) =>
    (decision.messages ?? [])
      .flatMap((message) => message.content ?? [])
      .map((part) => part.text ?? '')

  // 第一次越线：兜底压缩失败（这个 harness 挖不到引擎），写入指数退避。
  await runPreStep(preStep, { turn: 1, step: 1, agent })
  total += 1
  const second = textsOf(await runPreStep(preStep, { turn: 2, step: 1, agent }))
  assert.ok(
    second.some((text) => text.includes(skipMark)),
    '退避中第一次跳过必须给出解释',
  )

  // 等倒计时数字真的变一格（`Math.ceil` 每秒变一次，1.1 s 足够）。
  await new Promise((resolve) => setTimeout(resolve, 1100))
  total += 1
  const third = textsOf(await runPreStep(preStep, { turn: 3, step: 1, agent }))
  assert.equal(
    third.some((text) => text.includes(skipMark)),
    false,
    '同一退避原因的后续 turn 不能再解释一遍',
  )
})

test('validate：`[推断未验证]` 写在锚点第一行也要认出来', async () => {
  // 两条判据（检查 3 与检查 7）原先都以 `\n` 起锚，于是「第一行就是标记」时匹配不到：
  // 同一份锚点会报「没有任何 `[推断未验证]` 标记」，而检查 7 又完全看不到它。
  // 修法是 `(?:^|\n)`；这条测试把「第一行」这个位置钉住。
  const root = join(tmpdir(), `stage-handoff-firstline-${process.pid}-${Date.now()}`)
  const stageName = '261118-0000-firstline'
  const stageDir = join(root, stageName)
  const body = [
    '- [推断未验证] 缺口检测还缺测试',
    '',
    '## 下一步',
    '',
    '1. 跑 `node --test test/index.test.mjs` 确认全绿',
    '',
    '## 硬约束',
    '',
    '- [人工明确] 不删除任何 qcow2 镜像。',
    '',
    '## 决策与否决',
    '',
    '- [有效] 先修 bug 再补缺口',
    '',
  ].join('\n')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(join(stageDir, 'anchor.md'), body, 'utf8')
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'validate', stage: stageName },
      { agent: agentWith([]) },
    )
    assert.doesNotMatch(
      result.text,
      /没有任何 `\[推断未验证\]` 标记/,
      '第一行的 `[推断未验证]` 必须被看见',
    )
    assert.match(result.text, /有 `\[推断未验证\]` 标记/)
    assert.match(result.text, /未超期/, '同一次检查里应给出「未超期」，而不是两条互相打架的结论')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('guard 回执把「否决行」的边界说到节一级', async () => {
  // 实现只从 `## 决策与否决` 取 `[否决]` 行（`guardSignatures`）。回执原来只说
  // 「`[否决]` 行」，读起来像全篇任何位置都算；空基线文案更直接说「也没有 `[否决]` 行」。
  // 两条都改成点名那一节，用户才不会被「我明明写了一行否决」误导。
  const root = join(tmpdir(), `stage-handoff-guard-scope-${process.pid}-${Date.now()}`)
  const stageName = '261118-0000-guard-scope'
  const stageDir = join(root, stageName)
  try {
    await mkdir(stageDir, { recursive: true })
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]

    await writeFile(
      join(stageDir, 'anchor.md'),
      [
        '## 硬约束',
        '',
        '- [人工明确] 不删除任何镜像。',
        '',
        '## 决策与否决',
        '',
        '- [有效] 先修 bug 再补缺口',
        '',
      ].join('\n'),
      'utf8',
    )
    const guarded = await tool.execute({ action: 'guard', stage: stageName }, { agent: agentWith([]) })
    assert.match(
      guarded.text,
      /`## 决策与否决` 一节里的 `\[否决\]` 行/,
      '回执必须把否决行的范围说到节一级',
    )

    // 没有硬约束、`## 决策与否决` 里只有 `[有效]`：空基线文案也不许暗示「全篇都没有否决」。
    await writeFile(
      join(stageDir, 'anchor.md'),
      ['## 决策与否决', '', '- [有效] 只有有效行', ''].join('\n'),
      'utf8',
    )
    const empty = await tool.execute({ action: 'guard', stage: stageName }, { agent: agentWith([]) })
    assert.match(
      empty.text,
      /`## 决策与否决` 一节里也没有 `\[否决\]` 行/,
      '空基线文案要说清范围是这一节',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('status 的「流式守卫提醒」只报本会话', async () => {
  // 这一行原来读的是全局 `state.streamNoticeSent`：别的会话提醒过，本会话的 status
  // 也会说「最近一条对应 turn N」—— 与上面两行「读的是本会话」的说明自相矛盾。
  const makeAgent = (id) => ({
    session: { id, seq: 0, surface: { nodes: [] }, snapshotEvents: () => [] },
  })
  const { ctx, listeners, registeredTools } = fakeContext()
  apply(ctx, {})
  const stream = listeners.get('agent/assistant-stream')
  const preStep = listeners.get('agent/pre-step')
  const talker = makeAgent('status-talker')
  const quiet = makeAgent('status-quiet')

  stream({ agent: talker, frame: { type: 'start', turn: 3, step: 1 } })
  for (let index = 0; index < 120; index += 1) {
    stream({ agent: talker, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '好。\n' } } })
  }
  stream({ agent: talker, frame: { type: 'end' } })
  const noticed = await runPreStep(preStep, { turn: 3, step: 2, agent: talker })
  assert.ok(noticed.messages.length > 0, 'talker 应当收到一条流式复读提醒')

  const quietStatus = await registeredTools[0].execute({ action: 'status' }, { agent: quiet })
  assert.match(quietStatus.text, /本会话还没发过/, '没发过提醒的会话必须这么说')
  assert.doesNotMatch(
    quietStatus.text,
    /最近一条对应 turn 3/,
    '不能把另一个会话的 turn 号显示成本会话的',
  )

  const talkerStatus = await registeredTools[0].execute({ action: 'status' }, { agent: talker })
  assert.match(talkerStatus.text, /本会话最近一条对应 turn 3/, '发过提醒的会话要能查到它')
})

test('拒绝未知键、非正数与非布尔 enabled', () => {
  assert.throws(() => resolveConfig({ notifyToken: 300000 }), /未知配置键/)
  assert.throws(() => resolveConfig({ notifyTokens: 0 }), /安全整数|正整数/)
  assert.throws(() => resolveConfig({ notifyTokens: -1 }), /安全整数|正整数/)
  assert.throws(() => resolveConfig({ notifyTokens: 'abc' }), /安全整数|正整数/)
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /布尔值/)
  assert.throws(() => resolveConfig({ notifyRepeatDelta: 0 }), /安全整数|正整数/)
})

test('enabled:false 完全不挂监听器、不注册命令', () => {
  const { ctx, listeners, registered, logs } = fakeContext()
  apply(ctx, { enabled: false })
  assert.equal(listeners.size, 0)
  assert.equal(registered.length, 0)
  assert.equal(logs.length, 0, '关闭时不应写自报日志')
})

test('enabled 热更新为 false 后，所有入口立即停用但注册仍保留到重挂', async () => {
  let enabled = true
  const harness = fakeContext({ total: 350000, withConnection: true })
  apply(harness.ctx, {
    enabled: { get: () => enabled },
    notifyTokens: 300000,
  })
  const tool = harness.registeredTools[0]
  const command = harness.registered[0]
  const route = harness.fetchRoutes[0]
  const agent = agentWith([])

  enabled = false
  harness.listeners.get('loader/volatile-update')()
  assert.ok(
    harness.logs.some(
      ([level, message]) =>
        level === 'warn' &&
        message.includes('本进程内插件入口已停用') &&
        message.includes('要彻底卸载请重挂 profile'),
    ),
  )

  const decision = await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  assert.equal(decision.messages.length, 1, '停用后 pre-step 必须直接透传')

  const toolResult = await tool.execute({ action: 'status' }, { agent })
  assert.match(toolResult.text, /已在当前 Host 进程中停用/)

  const commandResult = command.handler({
    agent,
    rawInput: 'status',
    signal: { aborted: false },
  })
  assert.equal(commandResult.kind, 'error')
  assert.match(commandResult.text, /已在当前 Host 进程中停用/)

  const response = await route.fetch(
    new Request('http://local.invalid/api/stage-handoff/usage'),
  )
  assert.equal(response.status, 503)
  assert.match((await response.json()).error, /已在当前 Host 进程中停用/)
})

test('挂载时写一条自报日志，让「活没活」可直接读出', () => {
  const { ctx, logs } = fakeContext()
  apply(ctx, undefined)
  const mount = logs.find(([level, message]) => level === 'info' && message.includes('已挂载'))
  assert.ok(mount !== undefined, '挂载时应写一条 info 自报日志')
  assert.match(mount[1], /363,520/)
  assert.match(mount[1], /25,000/)
  assert.match(mount[1], /docs\/anchors/)
})

test('提醒文案带上锚点目录、自检要求与重复间隔', () => {
  const text = noticeText(312480, 1000000, resolveConfig(undefined))
  assert.match(text, /312,480 tokens/)
  assert.match(text, /31\.2%/)
  assert.match(text, /stage_handoff\(action="scaffold", topic=/)
  assert.match(text, /YYMMDD-HHMM-主题/)
  assert.match(text, /会话索引/)
  assert.match(text, /parent-backup/)
  assert.match(text, /未验证/)
  assert.match(text, /文档动作自行完成/)
  assert.match(text, /删除、提权、部署/)
  assert.doesNotMatch(text, /不要停下来询问/, '提醒不得覆盖更高层审批边界')
  assert.match(text, /stage_handoff\(action="compact"\)/)
  assert.match(text, /不用等 idle/)
  assert.match(text, /尾部逐字保留 32,000 tokens/)
  assert.match(text, /25,000 tokens/)
})

test('窗口容量未知时不写占比', () => {
  const text = noticeText(312480, undefined, resolveConfig(undefined))
  assert.match(text, /312,480 tokens/)
  assert.doesNotMatch(text, /%/)
})

test('越线注入一条提醒，且保留原有消息', async () => {
  const { ctx, listeners } = fakeContext({ total: 350000 })
  applyWithLine(ctx)
  const listener = listeners.get('agent/pre-step')
  assert.equal(typeof listener, 'function')

  const decision = await runPreStep(listener)
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].id, 'existing')
  assert.equal(decision.messages[1].role, 'user')
  assert.equal(decision.messages[1].source.kind, 'stage-handoff')
  assert.equal(decision.messages[1].source.form, 'notice')
  assert.match(decision.messages[1].content[0].text, /阶段收尾/)
})

test('未越线不注入', async () => {
  const { ctx, listeners } = fakeContext({ total: 299999 })
  apply(ctx, undefined)
  const decision = await runPreStep(listeners.get('agent/pre-step'))
  assert.equal(decision.messages.length, 1)
})

test('节流：上下文不涨就不重复提醒，涨够间隔才再提醒', async () => {
  const harness = fakeContext({ total: 350000 })
  // 关掉时间闸：这个用例只验增长量逻辑，时间闸有独立的测试。
  applyWithLine(harness.ctx, { notifyCooldownMs: 0 })
  const listener = harness.listeners.get('agent/pre-step')

  const first = await runPreStep(listener)
  assert.equal(first.messages.length, 2)

  // 同一 total，第二步：不提醒
  const second = await runPreStep(listener, { step: 2 })
  assert.equal(second.messages.length, 1)

  // 涨了 10000（< 25000）：仍不提醒
  harness.setTotal(360000)
  const third = await runPreStep(listener, { step: 3 })
  assert.equal(third.messages.length, 1)

  // 涨到 380000（累计 +30000 ≥ 25000），但仍在同一轮的中间步：不提醒
  harness.setTotal(380000)
  const fourth = await runPreStep(listener, { step: 4 })
  assert.equal(fourth.messages.length, 1)

  // 进入新一轮（step 回到 1）：这时才提醒
  const fifth = await runPreStep(listener, { step: 1, turn: 2 })
  assert.equal(fifth.messages.length, 2)
})

test('压缩后回落到线下，再越线立刻重提', async () => {
  const harness = fakeContext({ total: 350000 })
  applyWithLine(harness.ctx)
  const listener = harness.listeners.get('agent/pre-step')

  assert.equal((await runPreStep(listener)).messages.length, 2)

  harness.setTotal(120000)
  assert.equal((await runPreStep(listener, { step: 2 })).messages.length, 1)

  harness.setTotal(340000)
  assert.equal((await runPreStep(listener, { step: 1, turn: 2 })).messages.length, 2)
})

test('时间闸：增长量够了但间隔太近，仍然不提醒', async () => {
  // 邻居实测的场景：notifyRepeatDelta 量的是增长量，而忙碌的一轮能在一两分钟内
  // 顶过 25k，于是 5 分钟内收到两条提醒。时间闸就是为这个加的。
  const harness = fakeContext({ total: 350000 })
  applyWithLine(harness.ctx, { notifyCooldownMs: 600000, notifyRepeatDelta: 1000 })
  const listener = harness.listeners.get('agent/pre-step')

  assert.equal((await runPreStep(listener)).messages.length, 2, '首次越线应提醒')

  harness.setTotal(410000) // 涨了 60000，远超 notifyRepeatDelta
  assert.equal(
    (await runPreStep(listener, { step: 1, turn: 2 })).messages.length,
    1,
    '时间闸未到，涨得再多也不该提醒',
  )
})

test('时间闸设为 0 时关闭，退回只看增长量', async () => {
  const harness = fakeContext({ total: 350000 })
  applyWithLine(harness.ctx, { notifyCooldownMs: 0, notifyRepeatDelta: 1000 })
  const listener = harness.listeners.get('agent/pre-step')

  assert.equal((await runPreStep(listener)).messages.length, 2)
  harness.setTotal(360000)
  assert.equal(
    (await runPreStep(listener, { step: 1, turn: 2 })).messages.length,
    2,
    '时间闸关闭后，涨够增长量就提醒',
  )
})

test('压缩后回落会一并清掉时间闸，立刻可以再提醒', async () => {
  const harness = fakeContext({ total: 350000 })
  applyWithLine(harness.ctx, { notifyCooldownMs: 600000 })
  const listener = harness.listeners.get('agent/pre-step')

  assert.equal((await runPreStep(listener)).messages.length, 2)

  harness.setTotal(100000) // 压缩后回落到线下，节流记录被清空
  assert.equal((await runPreStep(listener, { step: 2 })).messages.length, 1)

  harness.setTotal(350000)
  assert.equal(
    (await runPreStep(listener, { step: 1, turn: 2 })).messages.length,
    2,
    '回落清空记录后，时间闸也不该继续挡着',
  )
})

test('reject 决策与已 abort 的步一律不动', async () => {
  const { ctx, listeners } = fakeContext({ total: 350000 })
  apply(ctx, undefined)
  const listener = listeners.get('agent/pre-step')

  const rejected = await listener(
    { agent: { session: {} }, step: 1, turn: 1, signal: { aborted: false } },
    async () => ({ kind: 'reject' }),
  )
  assert.deepEqual(rejected, { kind: 'reject' })

  const aborted = await listener(
    { agent: { session: {} }, step: 1, turn: 1, signal: { aborted: true } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(aborted.messages.length, 0)
})

test('tokenMeter 抛错时不影响本步', async () => {
  const { ctx, listeners, logs } = fakeContext({ measureThrows: true })
  apply(ctx, undefined)
  const decision = await runPreStep(listeners.get('agent/pre-step'))
  assert.equal(decision.messages.length, 1)
  assert.ok(logs.some(([level]) => level === 'warn'))
})

test('/anchor 命令：status / threshold / reset', () => {
  const { ctx, registered } = fakeContext({ total: 350000 })
  applyWithLine(ctx)
  assert.equal(registered.length, 1)

  const command = registered[0]
  assert.equal(command.name, 'anchor')
  const invocation = { agent: { session: { id: 's1' } }, rawInput: 'status', signal: { aborted: false } }

  const status = command.handler(invocation)
  assert.equal(status.kind, 'success')
  assert.match(status.text, /提醒线 300,000/)
  assert.match(
    status.text,
    /当前占用 350,000 \/ 1,000,000 tokens/,
    '/anchor status 必须现场测量，不读旧快照',
  )
  assert.match(status.text, /docs\/anchors/)

  const changed = command.handler({ ...invocation, rawInput: 'threshold 250k' })
  assert.equal(changed.kind, 'success')
  assert.match(changed.text, /256,000/)

  const afterChange = command.handler(invocation)
  assert.match(afterChange.text, /提醒线 256,000/)

  assert.equal(command.handler({ ...invocation, rawInput: 'threshold' }).kind, 'error')
  assert.equal(command.handler({ ...invocation, rawInput: 'nonsense' }).kind, 'error')
  assert.equal(command.handler({ ...invocation, rawInput: 'reset' }).kind, 'success')
})

test('/anchor threshold 改线后清节流：降线到当前占用以下会立刻提醒', async () => {
  // bug-hunt P2-1：降线后旧节流记录会让「增长量不足」挡住提醒，与 /anchor reset 语义不一致。
  const harness = fakeContext({ total: 350000 })
  applyWithLine(harness.ctx, { notifyCooldownMs: 0 })
  const listener = harness.listeners.get('agent/pre-step')
  const command = harness.registered[0]
  const invocation = { agent: AGENT, signal: { aborted: false } }

  const first = await runPreStep(listener)
  assert.equal(first.messages.length, 2, '越线先提醒一次')

  command.handler({ ...invocation, rawInput: 'threshold 500k' })
  const second = await runPreStep(listener, { turn: 2, step: 1 })
  assert.equal(second.messages.length, 1, '抬线后不越线')

  // 降到 300k：当前 350k 已越线。节流没清的话，增长量 0 < 25000 会挡住提醒。
  // 提醒只在轮次开始时注入，所以第三次要换一轮，而不是同一轮的下一个 step。
  command.handler({ ...invocation, rawInput: 'threshold 300k' })
  const third = await runPreStep(listener, { turn: 3, step: 1 })
  assert.equal(third.messages.length, 2, '降线后必须立刻提醒')
})

test('包内 cordis.patch.yml 的 config 键必须能被 resolveConfig 接受', () => {
  // 回归：早期版本的 patch 把节流键写成了已废弃的 notifyEverySteps，
  // 而严格校验在加载期把它顶成 "1 entry did not activate"。这个测试保证
  // 「随包出厂的配置」与「代码认识的键」永远一致。
  const here = dirname(fileURLToPath(import.meta.url))
  const text = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
  const configBlock = text.split(/^\s*config:\s*$/m)[1]
  assert.ok(configBlock !== undefined, 'cordis.patch.yml 必须有一个 config 块')

  const entries = [...configBlock.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*):\s*(.+)$/gm)]
  assert.ok(entries.length > 0, 'config 块不能为空')

  const raw = {}
  for (const [, key, value] of entries) {
    const trimmed = value.trim().replace(/^['"]|['"]$/g, '')
    // 这里只做够 patch 用的最小 YAML 标量解析：数字、布尔、其余当字符串。
    raw[key] = /^\d+$/.test(trimmed)
      ? Number(trimmed)
      : trimmed === 'true'
        ? true
        : trimmed === 'false'
          ? false
          : trimmed
  }

  // 未知键会在这里抛错，正是要拦的失败。
  const resolved = resolveConfig(raw)
  assert.equal(resolved.notifyTokens, 363520)
  assert.equal(resolved.notifyRepeatDelta, 25000)
  assert.equal(resolved.notifyCooldownMs, 300000)
})

test('提醒线超过宿主墙的 85% 时，status 明确警告「可能永远发不出来」', async () => {
  // 这是整套设计里唯一会「静默失效」的配置错误：提醒线高于宿主的自动压缩阈值时，
  // 历史会先被压掉，提醒一次都不会出现，而且没有任何报错。
  const harness = fakeContext({ total: 100, window: 1000000 })
  apply(harness.ctx, { notifyTokens: 700000 })
  const tool = harness.registeredTools[0]
  const result = await tool.execute({ action: 'status' }, { agent: agentWith([]) })
  assert.match(result.text, /已达宿主压缩墙 678,464 的 103%/)
  assert.match(result.text, /永远发不出来/)
})

test('提醒线在安全区时不出现那条警告', async () => {
  const harness = fakeContext({ total: 100, window: 1000000 })
  apply(harness.ctx, { notifyTokens: 400000 })
  const tool = harness.registeredTools[0]
  const result = await tool.execute({ action: 'status' }, { agent: agentWith([]) })
  assert.doesNotMatch(result.text, /永远发不出来/)
})

test('墙不存在时 status 明说「无法压缩」，并给能兑现的建议', async () => {
  // 压力预算 ≤ 0 时宿主自己会抛 TargetPressureConfigError。这时若还报一条
  // 「距墙 N」就是假信息 —— 提醒线永远发不出来，而那正是最该被告知的一次。
  const harness = fakeContext({ total: 100, window: 300_000 })
  apply(harness.ctx, { hostMaxTokens: 400_000, notifyTokens: 100_000 })
  const result = await harness.registeredTools[0].execute(
    { action: 'status' },
    { agent: agentWith([]) },
  )
  assert.match(result.text, /宿主压缩墙：\*\*不存在\*\*/)
  assert.match(result.text, /TargetPressureConfigError/)
  // 建议值 = 300,000 − 65,536 = 234,464，必须是个正整数
  assert.match(result.text, /调到 234,464 以下/)
})

test('窗口连 headroom 都装不下时，建议不能给出负值', async () => {
  // 65,536 窗口减掉 65,536 的 headroom 之后建议值会是 0 甚至负数，
  // 「把 hostMaxTokens 调到 -32,768 以下」是一句无法执行的建议。
  const harness = fakeContext({ total: 100, window: 65_536 })
  apply(harness.ctx, { hostMaxTokens: 256_000, notifyTokens: 1_000 })
  const result = await harness.registeredTools[0].execute(
    { action: 'status' },
    { agent: agentWith([]) },
  )
  assert.match(result.text, /任何 hostMaxTokens 都无法让它可压缩/)
  assert.doesNotMatch(result.text, /调到 -?[\d,]+ 以下/)
})

test('defer 请求值越过宿主墙时，「越兜底线」与「越墙」两条提示都要出现', async () => {
  // hostMaxTokens=300,000 时 1,000,000 窗口的墙是 min(800,000, 634,464) = 634,464，
  // 兜底线是它的 90% = 571,017。880,000 同时越过两者，用户必须两条都看到：
  // 一条说「自动压缩会先动手」，另一条说「宿主会在更早的位置压缩」。
  const harness = fakeContext({ total: 100, window: 1_000_000 })
  apply(harness.ctx, { notifyTokens: 100_000, hostMaxTokens: 300_000 })
  const result = await harness.registeredTools[0].execute(
    { action: 'defer', tokens: 880_000 },
    { agent: agentWith([]) },
  )
  assert.match(result.text, /已高于兜底压缩线 571,017/)
  assert.match(result.text, /已越过宿主压缩墙 634,464/)
})

test('status 在兜底压缩启用时报出兜底线数值，关闭时明说未启用', async () => {
  const on = fakeContext({ total: 100, window: 1_048_576 })
  apply(on.ctx, { notifyTokens: 100_000, agentDecidesCompaction: false })
  const onText = (
    await on.registeredTools[0].execute({ action: 'status' }, { agent: agentWith([]) })
  ).text
  // 1,048,576 窗口的墙 = 727,040，兜底线 = 654,336
  assert.match(onText, /宿主压缩墙 727,040 tokens（69\.3%）/)
  assert.match(onText, /插件兜底线 654,336/)

  const off = fakeContext({ total: 100, window: 1_048_576 })
  apply(off.ctx, { notifyTokens: 100_000 })
  const offText = (
    await off.registeredTools[0].execute({ action: 'status' }, { agent: agentWith([]) })
  ).text
  assert.match(offText, /插件兜底线 未启用（agentDecidesCompaction=true）/)
})

test('redactSecrets：脱敏覆盖面（含 AWS / JWT / PEM / 前缀粘连 / URL 内嵌口令）', () => {
  // 这份逻辑原先只接在 driftDetail 一个出口上，于是 `status` 回吐的工具命令行
  // 原样进了会话。现在它是 `lib/util.js` 的公共函数，任何「会进日志/诊断/模型上下文」
  // 的字符串都该过它。下面每条都对应一类真实形状。
  const mustRedact = [
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    'PGPASSWORD=HUNTER2SECRET',
    'aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
    'postgres://admin:S3cr3tPass@db.internal/app',
    'Authorization: Bearer abcdef123456',
    'X-Api-Key: sk-live-abcdefgh12345',
    'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
    'xoxb-1234567890-abcdefghijkl',
  ]
  for (const input of mustRedact) {
    const out = redactSecrets(input)
    assert.match(out, /\[REDACTED\]/, `未打码：${input.slice(0, 40)}`)
    // 打码后不能留下原来的高熵尾巴（只检查明显不该出现的片段）
    for (const secret of ['HUNTER2SECRET', 'S3cr3tPass', 'wJalrXUtnFEMI', 'abcdef123456']) {
      if (input.includes(secret)) assert.ok(!out.includes(secret), `仍含原文片段 ${secret}`)
    }
  }
  // 普通文本不能被误伤
  assert.equal(redactSecrets('我只是一句普通中文，没有凭据'), '我只是一句普通中文，没有凭据')
  assert.equal(redactSecrets(''), '')
  assert.equal(redactSecrets(undefined), '')
})

test('elidePathsIn / shortenPath：绝对路径缩成末两段，但不误伤路由与 marker', () => {
  // 旧正则有 `|/` 分支，任何以斜杠开头的片段都算路径 —— 实测把运行时标记
  // `g2-file-probe/20261118.3` 洗成了 `g2-file-probe<path>/20261118.3`，
  // 而它正是排查时要 grep 的字段。
  assert.equal(elidePathsIn('g2-file-probe/20261118.3'), 'g2-file-probe/20261118.3')
  assert.equal(elidePathsIn('/api/stage-handoff/usage'), '/api/stage-handoff/usage')
  assert.equal(elidePathsIn('docs/anchors/261123-0111-x'), 'docs/anchors/261123-0111-x')
  // 真正的绝对路径必须缩略
  assert.equal(elidePathsIn('D:\\Users\\me\\proj\\prod\\db.yaml'), '<path>/prod/db.yaml')
  assert.equal(elidePathsIn('/Users/me/work/src/a.js'), '<path>/src/a.js')
  assert.equal(
    elidePathsIn("lstat 'D:\\work\\repo\\docs\\anchors\\26\\.anchor-guard.json'"),
    "lstat '<path>/26/.anchor-guard.json'",
  )
  // shortenPath 对相对路径原样返回
  assert.equal(shortenPath('docs/anchors/x'), 'docs/anchors/x')
  assert.equal(shortenPath(''), '')
})

test('elidePathsIn 对含空格路径和 /workspace 也要抹掉用户名与项目名', () => {
  // 老版本的字符类整条排除空白，于是路径在第一个空格处截断 —— 而截断发生在
  // `C:` 已被换成 `<path>` 之后，结果是「看起来脱敏了，其实用户名和项目名都在」：
  //   scandir 'C:\Users\John Doe\proj\docs\anchors\x'
  //   -> '<path>/Users/John Doe\proj\docs\anchors\x'
  // 旧注释还把这描述成「原样保留」，与实测不符。
  const spaced = elidePathsIn("EACCES: permission denied, scandir 'C:\\Users\\John Doe\\proj\\docs\\anchors\\x'")
  assert.doesNotMatch(spaced, /John Doe/, `含空格的用户名必须被抹掉，实际：${spaced}`)
  assert.doesNotMatch(spaced, /proj/, `项目名必须被抹掉，实际：${spaced}`)
  assert.match(spaced, /<path>\/anchors\/x/)

  // POSIX 根名单曾经漂移：ABSOLUTE_PATH 认 workspace/work/private/… 共 28 个，
  // elidePathsIn 那份只认 8 个，于是容器里的工作区路径一个字都不洗。
  const ws = elidePathsIn("ENOENT: no such file, open '/workspace/proj/docs/anchors/x.md'")
  assert.doesNotMatch(ws, /proj/, `容器工作区路径必须被抹掉，实际：${ws}`)
  assert.match(ws, /<path>\/anchors\/x\.md/)

  // 但末段不能允许空格，否则会把后面整句话当成路径吞掉。
  const trailing = elidePathsIn('failed at D:\\work\\repo\\a for details')
  assert.equal(trailing, 'failed at <path>/repo/a for details', `不能吞掉句子，实际：${trailing}`)
})

test('usage 的 reason 不吐出完整的编码工作区键', () => {
  // `cwdKey` 是工作区绝对路径的可逆编码。`lib/index.js` 的 usage 摘要对同一字段
  // 只留末两段，注释写着「整条打出去等于把『这台机器上还有哪些项目』列进模型上下文」；
  // 而 `measureSessions` 的 reason 曾经把整条塞回去，同一个字段两种口径。
  const full = '--D-Users-me-Database-JavaScript-dsh-stage-handoff--'
  const short = shortenCwdKey(full)
  assert.doesNotMatch(short, /Users/, `不能留下用户名，实际：${short}`)
  assert.doesNotMatch(short, /Database-JavaScript/, `不能留下项目路径，实际：${short}`)
  assert.match(short, /stage-handoff$/, `末段要保留，便于区分，实际：${short}`)
  // 短键原样返回，不要为了统一而把它也加省略号。
  assert.equal(shortenCwdKey('--proj--'), '--proj--')
  assert.equal(shortenCwdKey(''), '')
})

test('配置降级原因里的绝对路径也要缩略', () => {
  // 拒绝理由通常带着被拒的值本身，例如 `anchorRoot 不能包含 ".." 段（收到
  // D:\Users\me\proj\docs\..\anchors）`。这条消息会进 status 与挂载警告，
  // 原样输出等于把用户名和工作区名写进模型上下文。
  const out = resolveConfigLenient({ anchorRoot: 'D:\\Users\\me\\proj\\docs\\..\\anchors' })
  assert.deepEqual(out.dropped, ['anchorRoot'], '这个值必须被降级')
  const reason = String(out.dropReasons?.anchorRoot ?? '')
  assert.ok(reason.length > 0, '降级必须给出理由')
  assert.doesNotMatch(reason, /Users/, `理由里不能留用户名：${reason}`)
  assert.doesNotMatch(reason, /proj/, `理由里不能留项目名：${reason}`)
})

test('dshHome 的控制字符在 schema 与解析器两层都被拒（同源）', () => {
  // 解析器曾经**收下**带 TAB 的值，而 schema 与面板都拒。最现实的触发是 YAML 双引号里的
  // `dshHome: "C:\temp\dsh"` —— `\t` 是 TAB 转义，之后所有会话体积查询都指向不存在的路径。
  //
  // 样本必须带**本平台**的绝对路径前缀：否则在 POSIX 上 `C:...` 先被「不是绝对路径」拦下，
  // 理由里根本没有「控制字符」，这条测试就变成平台相关的了 —— 它在 ubuntu 上红过一次。
  const prefix = process.platform === 'win32' ? 'C:\\data' : '/tmp'
  for (const bad of [`${prefix}\tab\there`, `${prefix}\a\nb`, `${prefix}\\x\u0000y`, '/tmp/a\u007fb']) {
    assert.throws(() => resolveConfig({ dshHome: bad }), /控制字符/, `应拒绝：${JSON.stringify(bad)}`)
  }
  // 正常的绝对路径照旧通过
  const nativeAbs = process.platform === 'win32' ? 'D:\\dsh-data' : '/var/lib/dsh'
  assert.equal(resolveConfig({ dshHome: nativeAbs }).dshHome, nativeAbs)
  assert.equal(resolveConfig({ dshHome: '/var/lib/dsh' }).dshHome, '/var/lib/dsh')
})

test('hostMaxTokens: auto 的三级取值顺序与降级', async () => {
  // 顺序：agent.options.maxTokens（宿主已确定）→ llm.resolveModelInfo 的
  // defaultMaxTokens（适配器为模型声明的默认）→ 内置默认 256,000。
  // 这个功能的意义：换模型时不用手改一个「看着怪」的绝对值。
  const statusText = async (harness, agent) => {
    const result = await harness.registeredTools[0].execute({ action: 'status' }, { agent })
    return result.text
  }
  const agentWithOptions = (options) => ({
    session: { id: `auto-${JSON.stringify(options).length}`, seq: 0, surface: { nodes: [] }, snapshotEvents: () => [] },
    options,
  })

  // 1. agent.options.maxTokens 优先（连 llm 都不查）
  const direct = fakeContext({
    total: 100,
    window: 1_000_000,
    llm: { resolveModelInfo: async () => ({ defaultMaxTokens: 111_111 }) },
  })
  apply(direct.ctx, { hostMaxTokens: 'auto' })
  const directText = await statusText(direct, agentWithOptions({ provider: 'p', model: 'm', maxTokens: 333_333 }))
  assert.match(directText, /输出预留 hostMaxTokens 333,333（agent\.options\.maxTokens/)
  // 1,000,000 − 333,333 = 666,667 → 再减 65,536 = 601,131；0.8W = 800,000，
  // 取较小者 601,131。retain = floor(666,667 × 0.16) = 106,666 < 601,131，不触第二条约束。
  assert.match(directText, /宿主压缩墙 601,131/)
})

test('hostMaxTokens: auto 会读模型元数据，拿不到则退回默认并说明原因', async () => {
  const agent = {
    session: { id: 'auto-meta', seq: 0, surface: { nodes: [] }, snapshotEvents: () => [] },
    options: { provider: 'deepseek', model: 'chat' },
  }
  // A. llm 声明了 defaultMaxTokens → 用它
  const withModel = fakeContext({
    total: 100,
    window: 1_048_576,
    llm: { resolveModelInfo: async (provider, model) => ({ defaultMaxTokens: provider === 'deepseek' && model === 'chat' ? 256_000 : undefined }) },
  })
  apply(withModel.ctx, { hostMaxTokens: 'auto' })
  const textA = (await withModel.registeredTools[0].execute({ action: 'status' }, { agent })).text
  assert.match(textA, /输出预留 hostMaxTokens 256,000（model deepseek\/chat 的 defaultMaxTokens）/)
  assert.match(textA, /宿主压缩墙 727,040/)

  // B. llm 不存在 → 默认值 + 说明
  const noLlm = fakeContext({ total: 100, window: 1_048_576 })
  apply(noLlm.ctx, { hostMaxTokens: 'auto' })
  const textB = (await noLlm.registeredTools[0].execute({ action: 'status' }, { agent })).text
  assert.match(textB, /输出预留 hostMaxTokens 256,000（default（llm 服务不可用））/)

  // C. 拿不到 provider/model → 默认值 + 另一条说明
  const noRoute = fakeContext({ total: 100, window: 1_048_576, llm: { resolveModelInfo: async () => ({}) } })
  apply(noRoute.ctx, { hostMaxTokens: 'auto' })
  const textC = (await noRoute.registeredTools[0].execute({ action: 'status' }, { agent: { ...agent, options: {} } })).text
  assert.match(textC, /输出预留 hostMaxTokens 256,000（default（拿不到 provider\/model））/)

  // D. 查询抛错 → 默认值 + 错误摘要（不能让 status 挂掉）
  const throwing = fakeContext({
    total: 100,
    window: 1_048_576,
    llm: { resolveModelInfo: async () => { throw new Error('registry offline') } },
  })
  apply(throwing.ctx, { hostMaxTokens: 'auto' })
  const textD = (await throwing.registeredTools[0].execute({ action: 'status' }, { agent })).text
  assert.match(textD, /输出预留 hostMaxTokens 256,000（default（查询 deepseek\/chat 失败/)
  assert.match(textD, /registry offline/)
})

test('hostMaxTokens 是数字时完全不查宿主', async () => {
  let called = 0
  const harness = fakeContext({
    total: 100,
    window: 1_048_576,
    llm: { resolveModelInfo: async () => { called += 1; return { defaultMaxTokens: 111_111 } } },
  })
  apply(harness.ctx, { hostMaxTokens: 100_000 })
  const text = (
    await harness.registeredTools[0].execute(
      { action: 'status' },
      { agent: { session: { id: 'numeric', seq: 0, surface: { nodes: [] }, snapshotEvents: () => [] }, options: { provider: 'p', model: 'm' } } },
    )
  ).text
  assert.match(text, /输出预留 hostMaxTokens 100,000（config\.hostMaxTokens）/)
  assert.equal(called, 0, '配置是数字时不该碰 llm 服务')
})

test('hostCompactionWall 遵守宿主的 retainTokens 约束（W=321,537 不再返回 1）', () => {
  // 宿主 resolveCompactSpec 第二条检查：retainTokens >= thresholdTokens 就抛。
  // retain = floor((W − reserved) × 0.16)。W=321,537 时压力预算恰好 1、retain 是
  // 10,485 —— 旧实现返回 1，status 会报一个「宿主压缩墙 1 tokens」的怪读数。
  assert.equal(hostCompactionWall(321_537, { hostMaxTokens: 256_000 }), undefined)
  assert.equal(hostCompactionWall(321_536, { hostMaxTokens: 256_000 }), undefined)
  // 刚好越过这条约束的窗口仍要算出真值
  assert.equal(hostCompactionWall(350_000, { hostMaxTokens: 256_000 }), 28_464)
  assert.equal(hostCompactionWall(393_216, { hostMaxTokens: 256_000 }), 71_680)
  assert.equal(hostCompactionWall(1_048_576, { hostMaxTokens: 256_000 }), 727_040)
})

test('ensureAnchorRootIgnored 对相对路径也要能定位仓库（不能只按进程 cwd 找）', async () => {
  // 这条守的是一个真实漏网的 bug：`scaffold` 传进来的是 `config.anchorRoot` 的原值
  // （默认 `docs/anchors`，相对路径），而 `lstat` 对相对路径是相对**进程 cwd** 求值的
  // —— 插件跑在 DSH 进程里，cwd 不是用户的工作区。于是向上找 `.git` 一路落空、
  // 返回 not-a-repo、静默跳过，`.gitignore` 从来没被写过。
  //
  // 关键是把 cwd 挪到一个**不在任何仓库里**的目录：不这么做的话 cwd 本身就在仓库里，
  // 向上找总能命中，这条测试就抓不住 bug（最早的探针就是这么掩盖掉它的）。
  const base = await mkdtemp(join(tmpdir(), 'sh-ignore-rel-'))
  const originalCwd = process.cwd()
  try {
    await mkdir(join(base, 'repo', '.git'), { recursive: true })
    await mkdir(join(base, 'repo', 'docs', 'anchors'), { recursive: true })
    // 站在仓库外面：这样「相对路径 + cwd」的组合找不到任何 .git。
    process.chdir(base)
    const outcome = await ensureAnchorRootIgnored(join('repo', 'docs', 'anchors'))
    assert.equal(outcome, 'created', '相对路径必须解析成绝对路径再向上找仓库')
    assert.equal(existsSync(join(base, 'repo', 'docs', 'anchors', '.gitignore')), true)
    // 第二次是幂等的
    assert.equal(await ensureAnchorRootIgnored(join('repo', 'docs', 'anchors')), 'exists')
  } finally {
    process.chdir(originalCwd)
    await rm(base, { recursive: true, force: true })
  }
})

test('POSIX 上 Windows 风格绝对路径不再被当成绝对路径（避免静默落到 cwd 下）', () => {
  // 在 POSIX 上 `D:/x` 不是绝对路径：`path.resolve` 会把它拼到 cwd 后面，于是
  // `anchorRoot: D:/x` 会静默变成 `<工作区>/D:/x`。这里按平台收紧判据。
  // CI 跑在 Linux 上，所以两个分支都要证明。
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    assert.equal(isAbsolutePathInput('D:/x'), false, 'POSIX 上盘符路径不是绝对路径')
    assert.equal(isAbsolutePathInput('C:\\\\x'), false)
    assert.equal(isAbsolutePathInput('/var/lib/dsh'), true, 'POSIX 根路径是绝对路径')
    assert.equal(isAbsolutePathInput('docs/anchors'), false)

    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    assert.equal(isAbsolutePathInput('D:/x'), true, 'win32 上盘符路径是绝对路径')
    assert.equal(isAbsolutePathInput('D:\\\\x'), true)
    assert.equal(isAbsolutePathInput('/var/lib/dsh'), true, 'win32 上以斜杠开头也按当前盘符绝对路径')
    assert.equal(isAbsolutePathInput('docs/anchors'), false)
  } finally {
    if (original !== undefined) Object.defineProperty(process, 'platform', original)
  }
})

test('readLatestSummaryFromLog 能从会话日志回退读到摘要，并拒绝不安全的会话 ID', async () => {
  // 摘要事件是 log-only：写进 session*.jsonl.zstd，但不重放进内存事件环。所以
  // 「压缩完 → 重启 → 对账」这条最自然的路径，以前是走不通的。这里用真实形态的
  // zstd 日志（含 compaction/start、compaction/summary、其他噪声事件）验证回退。
  const { zstdCompressSync } = await import('node:zlib')
  const base = await mkdtemp(join(tmpdir(), 'sh-session-log-'))
  try {
    const sessionId = 'session-0123456789ab-cdef-0123-4567-89abcdef0123'
    const dir = join(base, 'sessions', '--D-work-proj--', sessionId)
    await mkdir(dir, { recursive: true })
    const events = [
      { type: 'compaction/start', seq: 10, time: 1, data: { compactionId: 'a', turn: 1 } },
      { type: 'turn/start', seq: 11, time: 2, data: {} },
      { type: 'tool/call', seq: 12, time: 3, data: { name: 'x', input: { q: 'compaction/summary' } } },
      {
        type: 'compaction/summary',
        seq: 13,
        time: 1795367523543,
        data: {
          compactionId: 'a',
          // 摘要正文是 content-block 数组，只有 type === 'text' 的块算正文。
          summary: [
            { type: 'reasoning', text: '不该出现的推理' },
            { type: 'text', text: '## 旧摘要\n\n第一条结论。' },
            { type: 'text', text: '第二条结论。' },
          ],
          shadowedRange: { start: 2002, end: 3999 },
          shadowedTokenCount: 213238,
          provider: 'deepseek-account',
          model: 'deepseek-flash',
        },
      },
    ]
    const body = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))

    const config = { dshHome: base }
    const hit = await readLatestSummaryFromLog(config, undefined, sessionId)
    assert.equal('error' in hit, false, `不该失败：${'error' in hit ? hit.error : ''}`)
    assert.equal(hit.summary, '## 旧摘要\n\n第一条结论。\n\n第二条结论。')
    assert.equal(hit.shadowedRange.start, 2002)
    assert.equal(hit.shadowedRange.end, 3999)
    assert.equal(hit.shadowedTokenCount, 213238)
    assert.equal(hit.provider, 'deepseek-account')

    // 裸 UUID 也要能找到（磁盘上带 session- 前缀）。
    const bare = await readLatestSummaryFromLog(config, undefined, sessionId.slice('session-'.length))
    assert.equal(bare.summary, hit.summary)

    // 找不到的会话：给错误，不抛。
    const missing = await readLatestSummaryFromLog(config, undefined, 'session-does-not-exist')
    assert.match(missing.error, /没找到会话/)

    // 会话 ID 会被当作单个路径分量：`..` 与分隔符必须被拒，否则 join() 会把
    // 读取路径带出会话存储根目录。
    for (const hostile of ['../../etc', 'a/b', 'a\\b', '..', '']) {
      const rejected = await readLatestSummaryFromLog(config, undefined, hostile)
      assert.match(String(rejected.error), /不能用作单个路径分量|没找到会话/, `应拒绝 ${JSON.stringify(hostile)}`)
    }

    // 超大日志：字节闸必须挡住，而不是先读进来再发现（解压是同步的）。
    // 字节闸：上限做成了可注入参数，所以这里能真的走到那条分支。旧版本这条注释
    // 写着「超大日志：字节闸必须挡住」，但它下面测的是「合法但没摘要」—— 注释在
    // 撒谎，闸从来没被验证过。现在钉住的是**主闸**（lstat 阶段按 size 跳过）：
    // 上限小于文件体积时，必须报「没有可读的 .jsonl.zstd」而不是去解压。
    //
    // 函数里还有一道「边读边卡」（`total > limit`）。它在正常情况下不可达 ——
    // lstat 已经保证 size ≤ limit 才继续读。留着它是防御 size 不可信的文件系统，
    // 这里如实记下：**那一条没有测试覆盖**，也不该假装有。
    const gateDir = join(base, 'sessions', '--D-work-proj--', 'session-gate')
    await mkdir(gateDir, { recursive: true })
    const gateBody =
      JSON.stringify({
        type: 'compaction/summary',
        seq: 1,
        time: 1,
        data: { summary: [{ type: 'text', text: '这段内容不该被读出' }] },
      }) + '\n'
    await writeFile(join(gateDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(gateBody, 'utf8')))

    // 上限 1 字节 → 连 lstat 过滤都过不去，报「没有可读的 .jsonl.zstd」。
    const tooSmall = await readLatestSummaryFromLog(config, undefined, 'session-gate', 1)
    assert.match(String(tooSmall.error), /没有可读的 \.jsonl\.zstd/)

    // 上限设成 8 字节：压缩后体积超过它，同样被挡。
    const stillSmall = await readLatestSummaryFromLog(config, undefined, 'session-gate', 8)
    assert.match(String(stillSmall.error), /没有可读的 \.jsonl\.zstd/)

    // 上限放大到能过 lstat、但不够读完整个文件 → 必须报「超过上限，已停止读取」，
    // 而不是解压失败或静默返回半份数据。
    const midway = await readLatestSummaryFromLog(config, undefined, 'session-gate', 1_000_000_000)
    assert.equal('error' in midway, false, `正常上限下应成功：${'error' in midway ? midway.error : ''}`)
    assert.equal(midway.summary, '这段内容不该被读出')

    // 非整数/非正的上限要退回默认值，而不是让闸失效。
    for (const bogus of [0, -1, 1.5, Number.NaN, undefined]) {
      const settled = await readLatestSummaryFromLog(config, undefined, 'session-gate', bogus)
      assert.equal('error' in settled, false, `上限 ${String(bogus)} 应退回默认值并正常读取`)
    }

    // 合法但没有摘要的日志：错误要说「没有 compaction/summary」，而不是解压失败。
    const bigDir = join(base, 'sessions', '--D-work-proj--', 'session-big')
    await mkdir(bigDir, { recursive: true })
    await writeFile(
      join(bigDir, 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: 1, time: 1, data: {} })}\n`, 'utf8')),
    )
    const small = await readLatestSummaryFromLog(config, undefined, 'session-big')
    assert.match(String(small.error), /没有 compaction\/summary/)

    // 不是 zstd 的文件：要报解压失败，而不是静默当成「没摘要」。
    const brokenDir = join(base, 'sessions', '--D-work-proj--', 'session-broken')
    await mkdir(brokenDir, { recursive: true })
    await writeFile(join(brokenDir, 'session.v4.jsonl.zstd'), Buffer.alloc(1024))
    const broken = await readLatestSummaryFromLog(config, undefined, 'session-broken')
    assert.match(String(broken.error), /解压失败/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('summary 在内存事件环读不到摘要时回退读会话日志，并标明来源', async () => {
  // B1：这轮核心功能的**行为**测试。此前只有 regressions 里那条静态正则挡着
  // （「reconcile 不得直接读 summaryWindow.summary」），把回退整段删掉、或把
  // 门槛改成恒 false，全量测试都不会红。这里真正跑一次 action。
  const { zstdCompressSync } = await import('node:zlib')
  const base = await mkdtemp(join(tmpdir(), 'sh-fallback-'))
  try {
    const sessionId = 'session-aaaabbbb-cccc-dddd-eeee-ffff00001111'
    const dir = join(base, 'sessions', '--D-work-proj--', sessionId)
    await mkdir(dir, { recursive: true })
    const body =
      JSON.stringify({
        type: 'compaction/summary',
        seq: 5,
        time: 1_700_000_000_000,
        data: {
          summary: [{ type: 'text', text: '这是日志里的摘要正文' }],
          shadowedRange: { start: 100, end: 199 },
          shadowedTokenCount: 4242,
          provider: 'deepseek-account',
          model: 'deepseek-flash',
        },
      }) + '\n'
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))

    const harness = fakeContext({ total: 100, window: 1_048_576 })
    apply(harness.ctx, { dshHome: base })
    // 事件环里**没有** compaction/summary，且 seq 远大于返回的事件数 —— 覆盖不完整，
    // 正是回退该生效的条件。
    const agent = {
      session: {
        id: sessionId,
        seq: 5000,
        surface: { nodes: [{ type: 'turn/start' }] },
        snapshotEvents: () => [{ type: 'turn/start', seq: 4999 }],
      },
    }
    const result = await harness.registeredTools[0].execute({ action: 'summary' }, { agent })
    assert.match(result.text, /已从会话日志回退读取/, `应走回退，实际：${result.text.slice(0, 300)}`)
    assert.match(result.text, /这是日志里的摘要正文/, '应吐出日志里的摘要正文')
    assert.match(result.text, /区间 seq 100\.\.199/, '应带上日志事件里的压缩区间')
    assert.match(result.text, /4,242/, '应带上被丢弃的 token 数')
    assert.match(result.text, /deepseek-account/, '应带上摘要生成方')
    // 路径必须缩略：完整路径会带出 DSH_HOME 与工作区编码。
    assert.doesNotMatch(result.text, /Programs[\\/]DeepSeekHarness/, '回执里不该出现完整 DSH_HOME')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('status 报告重复增长量、尾部预算和锚点上限的不可达组合', async () => {
  const harness = fakeContext({ total: 100, window: 1000000 })
  apply(harness.ctx, {
    notifyRepeatDelta: 2000000,
    compactRetainTokens: 2000000,
    anchorLimitChars: 100,
  })
  const result = await harness.registeredTools[0].execute(
    { action: 'status' },
    { agent: agentWith([1]) },
  )
  assert.match(result.text, /notifyRepeatDelta 大于整个窗口/)
  assert.match(result.text, /compactRetainTokens 大于整个窗口/)
  assert.match(result.text, /anchorLimitChars 小于 500/)
})

test('status 分开报告 projection 与内存事件环，环缺失不把压缩误报为不可用', async () => {
  const harness = fakeContext({
    total: 0,
    withRecentProjectionFallback: false,
  })
  apply(harness.ctx, undefined)
  const agent = agentWith([], { openTurn: false, seq: 0, log: {} })
  const result = await harness.registeredTools[0].execute(
    { action: 'status' },
    { agent },
  )
  assert.match(result.text, /会话事实投影: 可用/)
  assert.match(result.text, /内存事件环: \*\*不可用/)
  assert.doesNotMatch(result.text, /会话事实投影: \*\*不可用/)
  assert.match(result.text, /摘要\/工具轨迹受限/)
})

test('status 不再在 /compact 也不可用时声称有兜底', async () => {
  const harness = fakeContext({ total: 0, withCommands: false })
  apply(harness.ctx, undefined)
  const result = await harness.registeredTools[0].execute(
    { action: 'status' },
    { agent: agentWith([]) },
  )
  assert.match(result.text, /引擎：不可用/)
  assert.match(result.text, /兜底也不可用/)
  assert.doesNotMatch(result.text, /兜底可用/)
})

test('stage_handoff 工具已注册，status 报告用量与三项探针', async () => {
  const { ctx, registeredTools } = fakeContext({ total: 350000 })
  apply(ctx, undefined)
  assert.equal(registeredTools.length, 1)
  const tool = registeredTools[0]
  assert.equal(tool.name, 'stage_handoff')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')

  await assert.rejects(() => tool.execute({ action: 'status' }, {}), /只能在 agent 工具调用中使用/)

  const fakeAgent = { session: { id: 's1' }, ctx: { get: () => undefined } }
  const result = await tool.execute({ action: 'status' }, { agent: fakeAgent })
  assert.match(result.text, /350,000/)
  // 引擎挖不到时，工具要如实展开诊断，而不是假装有引擎。
  assert.match(result.text, /引擎：不可用/)
  assert.match(result.text, /未触达/)
  assert.match(result.text, /get 路线也不通/)
  assert.match(result.text, /预演跳过/)

  await assert.rejects(() => tool.execute({ action: 'nonsense' }, { agent: fakeAgent }), /未知 action/)
})

test('compact 只排队不立即压，agent 变 idle 后才执行 /compact', async () => {
  const harness = fakeContext({ total: 320000 })
  apply(harness.ctx, undefined)
  const tool = harness.registeredTools[0]
  const fakeAgent = { session: { id: 's9' }, ctx: { get: () => undefined } }

  const queued = await tool.execute({ action: 'compact' }, { agent: fakeAgent })
  assert.match(queued.text, /已排队压缩/)
  assert.match(queued.text, /320,000 tokens/)
  // 关键约束：工具执行期间 agent 仍在 running，此时绝不能真调命令
  // （compactNow 内部 runMaintenance 会判 busy）。
  assert.equal(harness.executeCalls.length, 0)

  // 重复提交只回一句「已在排队」，不叠加请求。
  const again = await tool.execute({ action: 'compact' }, { agent: fakeAgent })
  assert.match(again.text, /已有一个压缩请求在排队/)

  // agent 变 idle：此时才借壳执行 /compact。
  const onStatus = harness.listeners.get('agent/status')
  assert.equal(typeof onStatus, 'function')
  await onStatus({ agent: fakeAgent, status: 'idle' })
  assert.equal(harness.executeCalls.length, 1)
  assert.equal(harness.executeCalls[0].line, '/compact')
  assert.equal(harness.executeCalls[0].hasSignal, true)

  // 非 idle 状态不得触发。
  await onStatus({ agent: fakeAgent, status: 'running' })
  assert.equal(harness.executeCalls.length, 1)
})

test('compact 命令不可见时明确拒绝，而不是静默假成功', async () => {
  const harness = fakeContext({ total: 320000, commandNames: ['anchor'] })
  apply(harness.ctx, undefined)
  const tool = harness.registeredTools[0]
  const fakeAgent = { session: { id: 's10' }, ctx: { get: () => undefined } }
  await assert.rejects(
    () => tool.execute({ action: 'compact' }, { agent: fakeAgent }),
    /找不到 compact 命令/,
  )
})

test('compaction 服务就位时诊断显示已触达，但引擎仍挖不到就明说', async () => {
  const service = { compactIfNeeded() {}, compactNow() {}, compactRegion() {} }
  const { ctx, registeredTools } = fakeContext({ total: 100, compaction: service })
  apply(ctx, undefined)
  const tool = registeredTools[0]
  const fakeAgent = { session: { id: 's2' }, ctx: { get: () => undefined } }
  const result = await tool.execute({ action: 'status' }, { agent: fakeAgent })
  // 有 compaction 服务（inject 触达）不等于能拿到引擎实例 —— 这是两条不同的路。
  assert.match(result.text, /inject 探针：已触达/)
  assert.match(result.text, /引擎：不可用/)
})

test('候选区间预演：按尾部保留预算切出可压前段', async () => {
  const nodes = [
    { seq: 1, tokens: 40000 },
    { seq: 2, tokens: 40000 },
    { seq: 3, tokens: 30000 },
    { seq: 4, tokens: 30000 },
  ]
  const { ctx, registeredTools } = fakeContext({ total: 140000, nodes })
  apply(ctx, { compactRetainTokens: 50000 })
  const tool = registeredTools[0]
  const fakeAgent = agentWith([1, 2, 3, 4], {
    openTurn: false,
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  const result = await tool.execute({ action: 'status' }, { agent: fakeAgent })
  // 尾部倒推停在 index 2；system head 固定在 index 0，因此只压 seq 2。
  assert.match(result.text, /尾部保留预算 50,000 tokens/)
  assert.match(result.text, /可压区间：1 个节点，seq 2\.\.2/)
  assert.match(result.text, /当前 turn 起点：无（最近一轮已闭合）/)
})

test('stage_handoff 的 input/output schema 都必须是标准 JSON Schema', () => {
  // 回归：tools.register() 不会执行 defineTool() 的 author-schema 转换。
  // 参数若仍写 property-map，注册本身可能成功，但模型收到的是非标准 schema。
  const { ctx, registeredTools } = fakeContext()
  apply(ctx, undefined)
  const tool = registeredTools[0]

  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.equal(tool.parameters.properties.action.type, 'string')
  assert.deepEqual(tool.parameters.properties.action.enum, [
    'status',
    'reset',
    'summary',
    'usage',
    'cleanup',
    'defer',
    'compact',
    'scaffold',
    'find-session',
    'recall',
    'validate',
    'reconcile',
    'guard',
  ])
  assert.equal(tool.parameters.properties.retainTokens.type, 'integer')
  // tokens 是「正整数或字符串 off」的联合：实现早就接受 off，
  // 只声明 integer 会让严格按 schema 生成参数的模型拒绝或删掉这个参数。
  assert.deepEqual(tool.parameters.properties.tokens.oneOf, [
    { type: 'integer', minimum: 1 },
    { type: 'string', enum: ['off'] },
  ])
  assert.deepEqual(tool.parameters.properties.scope.enum, ['anchors', 'sessions', 'all'])
  assert.match(tool.parameters.properties.stage.description, /reconcile/)
  assert.match(tool.parameters.properties.stage.description, /validate/)
  assert.equal(tool.parameters.properties.action.required, undefined)
  assert.equal(tool.execute.length, 2, 'execute 必须保持 (args, exec)')

  const output = tool.output.schema
  assert.equal(output.type, 'object')
  assert.equal(output.additionalProperties, false)
  assert.deepEqual(output.required, ['text'], 'required 必须是对象级数组')
  assert.equal(output.properties.text.type, 'string')
  assert.equal(output.properties.text.required, undefined, 'property 内不得再带 required')
})

/** 造一个带 surface 与 bounded snapshotEvents 的 agent 替身。 */
function agentWith(
  nodes,
  {
    eventType = (seq) => ({ type: 'message' }),
    log = undefined,
    seq = undefined,
    openTurn = log === undefined,
  } = {},
) {
  const maxNode = nodes.length === 0 ? -1 : Math.max(...nodes)
  const maxLog = log === undefined ? -1 : Math.max(-1, ...Object.keys(log).map(Number))
  const syntheticTurnSeq = Math.max(maxNode, maxLog) + 1
  const effectiveLog =
    openTurn && log === undefined
      ? { [syntheticTurnSeq]: { type: 'turn/start' } }
      : log
  const turnBoundary = openTurn
    ? {
        openTurnStartSeq: syntheticTurnSeq,
        lastStepStartSeq: null,
        lastStepBoundary: null,
        lastTurn: 1,
      }
    : undefined
  return {
    session: {
      id: 'sx',
      surface: { nodes },
      ...(turnBoundary === undefined ? {} : { turnBoundary }),
      seq:
        seq ??
        (openTurn && log === undefined
          ? syntheticTurnSeq + 1
          : Math.max(maxNode + 1, maxLog + 1)),
      snapshotEvents: (from, to) => {
        const events = []
        for (let wantedSeq = from; wantedSeq < to; wantedSeq += 1) {
          events.push(effectiveLog?.[wantedSeq] ?? eventType(wantedSeq))
        }
        return events
      },
    },
    ctx: { get: () => undefined },
  }
}

/**
 * Build the same small fact shape the production projection exposes. This
 * helper may use the test Session's bounded reader because no production code
 * does; it keeps adversarial unit tests independent from the fake context.
 */
function factsForSession(session, nodesOverride = undefined) {
  const nodes = Array.isArray(nodesOverride)
    ? nodesOverride
    : Array.isArray(session?.surface?.nodes)
      ? session.surface.nodes
      : []
  let events = []
  if (typeof session?.snapshotEvents === 'function' && Number.isSafeInteger(session.seq)) {
    events = [...session.snapshotEvents(0, session.seq)]
  }
  const bySeq = new Map()
  const recent = []
  for (let index = 0; index < events.length; index += 1) {
    const raw = events[index]
    const seq = Number.isSafeInteger(raw?.seq) ? raw.seq : index
    const event = { ...raw, seq }
    bySeq.set(seq, event)
    const fact = {
      seq,
      type: typeof event.type === 'string' ? event.type : '(missing type)',
    }
    if (typeof event?.data?.callId === 'string') fact.callId = event.data.callId
    if (event.type === 'tool/call' && typeof event?.data?.arguments === 'string') {
      try {
        const parsed = JSON.parse(event.data.arguments)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const files = []
          for (const key of ['path', 'file_path', 'filePath', 'file', 'target', 'paths', 'files']) {
            const value = parsed[key]
            if (typeof value === 'string' && value.trim() !== '') files.push(value.trim())
            if (Array.isArray(value)) {
              files.push(
                ...value.filter((item) => typeof item === 'string' && item.trim() !== ''),
              )
            }
          }
          const commands = []
          for (const key of ['command', 'cmd']) {
            const value = parsed[key]
            if (typeof value === 'string' && value.trim() !== '') commands.push(value.trim())
          }
          // 与生产端 toolFactsFromArguments 对齐：单数组超 128 条或单串超 4096 字符，
          // 生产端会截断并置 factsTruncated。这个 helper 不截内容（测试要看完整值），
          // 但必须把标记置上 —— 否则「截断要提示」这条路径在测试里根本走不到。
          if (files.length >= 128 || files.some((item) => item.length > 4096)) {
            fact.factsTruncated = true
          }
          if (files.length > 0) fact.files = files
          if (commands.length > 0) fact.commands = commands
          // 与生产端 toolFactsFromArguments 对齐：工具名像写操作才标 mutation。
          // 这里的正则刻意与 lib/index.js 的 MUTATION_TOOL_PATTERN 相同 ——
          // 这个 helper 是 recentFactFromEvent 的手写模拟，漏了字段就会
          // 让「改过/只读过」永远分错，而测试还看不出来。
          if (
            typeof event?.data?.name === 'string' &&
            /write|edit|create|patch|apply|delete|remove|rename|mkdir|save/i.test(event.data.name)
          ) {
            fact.mutation = true
          }
        }
      } catch {
        // Invalid tool arguments are ignored by both the projection and the test helper.
      }
    }
    const canonical = event.type === 'compaction/summary'
    const shaped = Array.isArray(event?.data?.summary) || Array.isArray(event?.summary)
    if (canonical || shaped) {
      fact.canonical = canonical
      fact.shaped = shaped
      const blocks = Array.isArray(event?.data?.summary)
        ? event.data.summary
        : Array.isArray(event?.summary)
          ? event.summary
          : []
      const text = blocks
        .flatMap((block) =>
          typeof block === 'string'
            ? [block]
            : typeof block?.text === 'string'
              ? [block.text]
              : [],
        )
        .join('\n\n')
        .trim()
      if (text !== '') fact.summaryText = text
      const data = event?.data ?? event
      if (data?.shadowedRange || data?.shadowedSeqs || data?.shadowedTokenCount || data?.provider || data?.model) {
        fact.compaction = {
          start: data?.shadowedRange?.start,
          end: data?.shadowedRange?.end,
          shadowedCount: Array.isArray(data?.shadowedSeqs)
            ? data.shadowedSeqs.length
            : undefined,
          shadowedTokens: data?.shadowedTokenCount,
          provider: data?.provider,
          model: data?.model,
        }
      }
    }
    recent.push(fact)
  }
  return {
    version: 2,
    surface: nodes.map((seq, index) => {
      const event = bySeq.get(seq)
      return {
        seq,
        type: event?.type ?? (index === 0 && nodes[0] === 1 ? 'system/message' : 'message'),
        checkpoint:
          event?.type === 'user/message' &&
          event?.data?.source?.kind === 'compact-checkpoint',
      }
    }),
    recent,
  }
}

function factsReaderFor(session, nodesOverride = undefined) {
  const facts = factsForSession(session, nodesOverride)
  return () => facts
}

/** Execute the actual browser parser block in Node without loading the client UI. */
function clientParsingHelpers() {
  const clientPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
  const source = readFileSync(clientPath, 'utf8')
  const begin = '// STAGE_HANDOFF_CLIENT_PARSE_BEGIN'
  const end = '// STAGE_HANDOFF_CLIENT_PARSE_END'
  const start = source.indexOf(begin)
  const finish = source.indexOf(end)
  assert.ok(start !== -1 && finish > start, 'client parser markers must exist')
  const block = source.slice(start + begin.length, finish)
  return new Function(
    `${block}\nreturn { parseTokenInput, parseIntegerInput, coerceNumericInput, coerceDuration, settleFieldCommit, coerceTimeZone, timeZoneOptions, isAbsolutePathInput }`,
  )()
}

/**
 * 从 client.js 里抽一个顶层函数的完整源码（大括号配平）。
 *
 * 为什么要抽而不是把函数搬进 `STAGE_HANDOFF_CLIENT_PARSE` 块：`validateValue` /
 * `formatError` 依赖闭包里的 i18n 函数 `t` / `tf`，搬进被 `new Function` 执行的块里
 * 就得改生产代码的签名。抽取只动测试侧，零生产风险。
 *
 * @param {string} source - client.js 全文。
 * @param {string} signature - 函数起首的签名，用于定位。
 * @returns {string} 函数源码。
 */
function extractClientFunction(source, signature) {
  const start = source.indexOf(signature)
  assert.ok(start !== -1, `client.js 里必须还有 ${signature}`)
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`无法配平 ${signature}`)
}

/**
 * 面板侧的字段闸与错误文案，带一个中文直通的 i18n 桩。
 *
 * `t` / `tf` 用桩是因为这些断言关心的是「放行还是拒绝」和「点的是哪个字段」，
 * 不是具体措辞；措辞另有静态断言。
 * @returns `{ validateValue, formatError, coerce }`
 */
function clientValidatorHelpers() {
  const clientPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
  const source = readFileSync(clientPath, 'utf8')
  const begin = '// STAGE_HANDOFF_CLIENT_PARSE_BEGIN'
  const end = '// STAGE_HANDOFF_CLIENT_PARSE_END'
  const block = source.slice(source.indexOf(begin) + begin.length, source.indexOf(end))
  const parts = [
    'function t(zh) { return String(zh) }',
    'function tf(zh, vars) { return String(zh).replace(/\\{(\\w+)\\}/g, function (m, k) { return vars && vars[k] !== undefined ? String(vars[k]) : m }) }',
    block,
    extractClientFunction(source, 'function coerce(item, raw)'),
    extractClientFunction(source, 'function validateValue(item, next)'),
    extractClientFunction(source, 'function formatError(item, raw)'),
    'return { validateValue, formatError, coerce, coerceTimeZone, coerceDuration }',
  ]
  return new Function(parts.join('\n'))()
}

function encodeSessionSegmentForTest(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const char = String.fromCharCode(code)
    out +=
      char !== '~' && /^[A-Za-z0-9._-]$/.test(char)
        ? char
        : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

test('selectRetainedRange：保留量 0 会压到只剩最后 1 个节点', () => {  const session = {
    snapshotEvents: (from, to) =>
      Array.from({ length: Math.max(0, to - from) }, (_, index) => ({
        type: from + index === 1 ? 'system/message' : 'message',
      })),
  }
  const surface = [1, 2, 3, 4]
  const priced = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
    { seq: 4, tokens: 100 },
  ]

  // 这就是 `/compact`（compactNow）用的保留量：循环第一轮就 break。
  const reader = factsReaderFor(session, surface)
  const aggressive = selectRetainedRange(session, priced, surface, 0, reader)
  assert.equal(aggressive.firstIdx, 1, 'system head 不进区间')
  assert.equal(aggressive.keepFromIdx, 3, 'retain 0 只保最后 1 个节点')
  assert.deepEqual([aggressive.start, aggressive.end], [2, 3])

  // auto 的力度：攒够 150 才停，尾巴留 2 个节点。
  const gentle = selectRetainedRange(session, priced, surface, 150, reader)
  assert.equal(gentle.keepFromIdx, 2)
  assert.deepEqual([gentle.start, gentle.end], [2, 2])
  assert.equal(gentle.retainedTokens, 200)

  // 保留预算吞掉整个表面时无区间可压，不能返回一个空区间。
  assert.equal(selectRetainedRange(session, priced, surface, 999999, reader), null)
  // 计价节点与表面长度对不上时必须报错，不能将错就错。
  assert.throws(() => selectRetainedRange(session, priced, [1, 2], 0, reader), /长度不一致/)
})

test('压缩保留侧剔除复读块：原文不留在逐字尾部', () => {
  // 实测依据（仓库内内部测量笔记）：一次压缩后 22,849 tokens
  // 的上下文里六成是被原样保留的复读块，而接下来的 turn 是照着它继续模仿的。
  const session = {
    snapshotEvents: (from, to) =>
      Array.from({ length: Math.max(0, to - from) }, (_, index) => ({
        type: from + index === 1 ? 'system/message' : 'message',
      })),
  }
  const surface = [1, 2, 3, 4, 5]
  const priced = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
    { seq: 4, tokens: 100 },
    { seq: 5, tokens: 100 },
  ]
  const reader = factsReaderFor(session, surface)
  // 一个「自己已经退化」的块：同一短行重复 40 次、重复占比 100%。
  const loop = { chars: 80, rows: 40, fillers: 40, maxRepeat: 40, repeatRatio: 1, tiny: false, dupShort: 0, shortRatio: 0 }
  const normal = { chars: 20, rows: 2, fillers: 0, maxRepeat: 1, repeatRatio: 0, tiny: false, dupShort: 0, shortRatio: 0 }
  const ringWith = (loopSeq) => () => ({
    recent: [
      { seq: 2, type: 'assistant/message', turn: 1, reasoning: normal },
      { seq: loopSeq, type: 'assistant/message', turn: 1, reasoning: loop },
    ],
  })

  // 不传事件环：行为与改动前一致，seq 4 留在保留侧。
  const plain = selectRetainedRange(session, priced, surface, 250, reader)
  assert.equal(plain.keepFromIdx, 2)
  assert.equal(plain.retainedTokens, 300)
  assert.equal(plain.excludedLoopBlocks, 0)

  // 传了：seq 4 被剔出去，保留侧从它右边开始，保留量要扣掉被剔的块。
  const trimmed = selectRetainedRange(session, priced, surface, 250, reader, ringWith(4))
  assert.equal(trimmed.keepFromIdx, 4, '复读块在 index 3，保留侧应从 4 开始')
  assert.equal(trimmed.excludedLoopBlocks, 1)
  assert.equal(trimmed.retainedTokens, 100)
  assert.deepEqual([trimmed.start, trimmed.end], [2, 4])

  // 复读块就是最新节点时保留侧为空：宁可只留摘要，也不把复读原文当示范留下。
  const empty = selectRetainedRange(session, priced, surface, 250, reader, ringWith(5))
  assert.equal(empty.keepFromIdx, 5)
  assert.equal(empty.excludedLoopBlocks, 1)
  assert.equal(empty.retainedTokens, 0)
  assert.deepEqual([empty.start, empty.end], [2, 5])
})

test('最新节点就是复读块时，空尾巴不会被平衡修正退回一格（调用侧回归）', async () => {
  // 上一条只钉了 `selectRetainedRange` 的输出。真正会出错的是**调用方**：
  // 空尾巴时 `keepFromIdx === surfaceNodes.length`，平衡修正用
  // `surfaceNodes[length]`（undefined）去调宿主的 `toolPairingBalancedBefore`，
  // 宿主对未知 seq 抛错、catch 成 false，循环退到 `length - 1` —— 复读块又被留在
  // 逐字尾部，而回执仍然打印「已剔除 N 个复读块」。
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
    { seq: 4, tokens: 100 },
  ]
  const calls = []
  const engine = {
    async compactRegion(start, end) {
      calls.push([start, end])
      return { shadowedSeqs: [2, 3], shadowedTokenCount: 200, summarySeq: 9 }
    },
  }
  const harness = fakeContext({ total: 310, nodes, engine })
  apply(harness.ctx, { compactRetainTokens: 250, compactCooldownMs: 0 })
  const agent = agentWith([1, 2, 3, 4])

  // 让**最新**节点（seq 4）自己就是复读块：100 行「做。」
  const emit = harness.listeners.get('session/event')
  emit(agent.session, {
    seq: 4,
    type: 'assistant/message',
    data: {
      turn: 1,
      message: { content: [{ type: 'reasoning', text: Array.from({ length: 100 }, () => '做。').join('\n') }] },
    },
  })

  const tool = harness.registeredTools[0]
  const result = await tool.execute({ action: 'compact' }, { agent })
  assert.equal(calls.length, 1, `压缩应当发生（回执：${result.text.slice(0, 80)}）`)
  assert.equal(calls[0][1], 4, '区间必须结束在最后一个节点（空尾巴），不能被平衡修正推回 3')
})

test('openTurnBoundaryIdx：压缩摘要节点 seq 比 turn 起点大时不算当前轮', () => {
  // 这是 rc.3 上实测撞到的真事故：surface[0] 是压缩摘要节点，它的 seq（30735）
  // 比 turn 起点大，于是旧逻辑把它当成「当前轮产生的节点」，边界落在 0，
  // 整个 surface 被保护起来 → status 永远报「可压区间：无」。
  const agents = { turnBoundaryOf: () => ({ openTurnStartSeq: 100 }) }
  // surface：摘要节点(seq 30735) → 历史(90) → 当前轮(101, 102)
  const surface = [30735, 90, 101, 102]
  const session = {
    seq: 200,
    snapshotEvents: () => [
      { seq: 30735, type: 'user/message', data: { source: { kind: 'compact-checkpoint' } } },
      { seq: 101, type: 'user/message', data: {} },
      { seq: 102, type: 'assistant/message', data: {} },
    ],
  }
  // 跳过摘要节点后，第一个 seq > 100 的是 101，位于 index 2
  assert.equal(openTurnBoundaryIdx(session, surface, agents, factsReaderFor(session, surface)), 2)

  // 没有摘要节点时退回旧行为：surface 里第一个 seq > 100 的是 101，位于 index 1
  const plainSession = { seq: 200, snapshotEvents: () => [] }
  assert.equal(
    openTurnBoundaryIdx(
      plainSession,
      [90, 101, 102],
      agents,
      factsReaderFor(plainSession, [90, 101, 102]),
    ),
    1,
  )

  // turn 已闭合
  const closed = { turnBoundaryOf: () => ({ openTurnStartSeq: null }) }
  assert.equal(
    openTurnBoundaryIdx(plainSession, surface, closed, factsReaderFor(plainSession, surface)),
    undefined,
  )
})

test('openTurnBoundaryIdx 只认最后一个还没闭合的 turn', () => {
  const session = {}
  const agentsOf = (boundary) => ({ turnBoundaryOf: () => boundary })
  assert.equal(
    openTurnBoundaryIdx(
      session,
      [1, 2, 4, 6, 7],
      agentsOf({
        openTurnStartSeq: 5,
        lastStepStartSeq: 6,
        lastStepBoundary: { kind: 'start', seq: 6 },
        lastTurn: 3,
      }),
      factsReaderFor(session, [1, 2, 4, 6, 7]),
    ),
    3,
  )
  assert.equal(
    openTurnBoundaryIdx(
      session,
      [1, 2, 4, 6],
      agentsOf({
        openTurnStartSeq: null,
        lastStepStartSeq: null,
        lastStepBoundary: null,
        lastTurn: 3,
      }),
      factsReaderFor(session, [1, 2, 4, 6]),
    ),
    undefined,
  )
  assert.equal(
    openTurnBoundaryIdx(session, [1], undefined, factsReaderFor(session, [1])),
    null,
  )
  assert.equal(
    openTurnBoundaryIdx(session, [1], {
      turnBoundaryOf() {
        throw new Error('projection unavailable')
      },
    }, factsReaderFor(session, [1])),
    null,
  )
})

test('挖到引擎后按 retain 选区直调 compactRegion，不再走 /compact 借壳', async () => {
  const calls = []
  const engine = {
    async compactRegion(start, end, agent, signal) {
      calls.push({ start, end, hasAgent: agent !== undefined, hasSignal: signal !== undefined })
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 5 }
    },
  }
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
    { seq: 4, tokens: 100 },
  ]
  const harness = fakeContext({ total: 310, nodes, engine })
  apply(harness.ctx, { compactRetainTokens: 150 })
  const tool = harness.registeredTools[0]
  const fakeAgent = agentWith([1, 2, 3, 4], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })

  const result = await tool.execute({ action: 'compact' }, { agent: fakeAgent })
  assert.match(result.text, /精确压缩完成/)
  assert.match(result.text, /尾部实际逐字保留 200 tokens/)
  assert.match(result.text, /预算 150/)
  assert.equal(calls.length, 1)
  assert.deepEqual([calls[0].start, calls[0].end], [2, 2])
  assert.equal(calls[0].hasAgent, true)
  assert.equal(calls[0].hasSignal, true)
  assert.equal(harness.executeCalls.length, 0, '精确路径不得再借壳 /compact')
})

test('开着的 turn 起点会截断压缩区间，绝不动当前轮的历史', async () => {
  const calls = []
  const engine = {
    async compactRegion(start, end) {
      calls.push({ start, end })
      return { shadowedSeqs: [2], shadowedTokenCount: 10 }
    },
  }
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 10 },
    { seq: 3, tokens: 10 },
    { seq: 4, tokens: 10 },
    { seq: 6, tokens: 10 },
    { seq: 7, tokens: 999 },
  ]
  // retain 1 只保最后节点；当前 turn 从 log seq 5 开始，surface 从 seq 6 起的节点不可压。
  const harness = fakeContext({ total: 1059, nodes, engine })
  apply(harness.ctx, { compactRetainTokens: 1 })
  const tool = harness.registeredTools[0]
  const fakeAgent = agentWith([1, 2, 3, 4, 6, 7], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  fakeAgent.session.turnBoundary = {
    openTurnStartSeq: 5,
    lastStepStartSeq: 6,
    lastStepBoundary: { kind: 'start', seq: 6 },
    lastTurn: 2,
  }

  const result = await tool.execute({ action: 'compact' }, { agent: fakeAgent })
  assert.match(result.text, /精确压缩完成/)
  assert.deepEqual([calls[0].start, calls[0].end], [2, 4])
})

test('引擎挖不到时不硬压，明确报告而不是静默假成功', async () => {
  const nodes = [{ seq: 1, tokens: 10 }, { seq: 2, tokens: 500 }]
  const harness = fakeContext({ total: 510, nodes })
  apply(harness.ctx, { compactRetainTokens: 100 })
  const tool = harness.registeredTools[0]
  const fakeAgent = agentWith([1, 2], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })

  const result = await tool.execute({ action: 'compact' }, { agent: fakeAgent })
  // 引擎缺席 ⇒ 退回借壳排队，并把诊断行摊开。
  assert.match(result.text, /精确压缩不可用/)
  assert.match(result.text, /引擎实例挖不到/)
  assert.match(result.text, /已改走兜底/)
})

test('精确引擎的 surface race 不会误降级成 0 保留的 /compact', async () => {
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 500 },
    { seq: 3, tokens: 500 },
  ]
  const engine = {
    async compactRegion() {
      throw new Error('compaction: session surface changed during summarization')
    },
  }
  const harness = fakeContext({ total: 1010, nodes, engine })
  apply(harness.ctx, { compactRetainTokens: 1 })
  const result = await harness.registeredTools[0].execute(
    { action: 'compact' },
    { agent: agentWith([1, 2, 3], { eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }) }) },
  )
  assert.match(result.text, /精确压缩未执行/)
  assert.match(result.text, /没有改用/)
  assert.equal(harness.executeCalls.length, 0, 'surface race 不得触发 /compact 借壳')
})

test('scaffold：归档成功后，新骨架必须指出上一版在哪，不能声称自己是第一版', async () => {
  // 真机发现：scaffold 确实归档了上一阶段（parent-backup 里有文件），
  // 但骨架里硬编码「上一版锚点：无（第一版）」。下一阶段据此判断就会以为
  // 没有历史可查，而 parent-backup/ 里明明躺着上一版。
  const root = join(tmpdir(), `stage-handoff-prev-${process.pid}-${Date.now()}`)
  const previous = '261116-0000-older'
  try {
    await mkdir(join(root, previous, 'detail'), { recursive: true })
    await writeFile(join(root, previous, 'anchor.md'), '# older anchor\n', 'utf8')

    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const created = await harness.registeredTools[0].execute(
      { action: 'scaffold', topic: 'newer' },
      { agent: agentWith([]) },
    )
    assert.match(created.text, /已创建阶段目录/)
    const dirs = await readdir(root)
    const newer = dirs.find((name) => name.endsWith('-newer'))
    assert.ok(newer !== undefined, '必须建出 -newer 阶段目录')
    const anchor = readFileSync(join(root, newer, 'anchor.md'), 'utf8')
    assert.doesNotMatch(anchor, /无（第一版）/, '归档成功时不得声称是第一版')
    assert.match(anchor, /上一版锚点：parent-backup\/anchor-\d{6}-\d{4}\.md/, '要指向上一次锚点的归档位置')
    assert.match(anchor, new RegExp(previous.replaceAll('-', '\\-')), '要说出归档自哪个阶段')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scaffold：真·第一阶段仍然说「无（第一版）」', async () => {
  const root = join(tmpdir(), `stage-handoff-first-${process.pid}-${Date.now()}`)
  try {
    await mkdir(root, { recursive: true })
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const created = await harness.registeredTools[0].execute(
      { action: 'scaffold', topic: 'veryfirst' },
      { agent: agentWith([]) },
    )
    assert.match(created.text, /已创建阶段目录/)
    const dirs = await readdir(root)
    const first = dirs.find((name) => name.endsWith('-veryfirst'))
    assert.ok(first !== undefined, '必须建出 -veryfirst 阶段目录')
    const anchor = readFileSync(join(root, first, 'anchor.md'), 'utf8')
    assert.match(anchor, /上一版锚点：无（第一版）/, '真第一版才说第一版')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('status 的投影行必须可判定，且不假设 projection 里带 recent', async () => {
  // 真机事故：status 读 `projected.recent.length`，而 projection 状态只有
  // {version, surface, invalidReason} —— recent 在**另一个**内存环里。
  // 结果 status 一上来就报「会话事实投影不可用（Cannot read properties of
  // undefined (reading 'length')）」，把好好的投影说成坏的，压缩也跟着被误判。
  //
  // 测试之所以漏掉它：fakeContext 的 projection mock 自己带了 `recent: []`，
  // 比真宿主宽松。这里显式断言「投影里不许有 recent 也照样可用」。
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, { anchorRoot: join(tmpdir(), `stage-handoff-proj-${Date.now()}`) })
  const result = await harness.registeredTools[0].execute({ action: 'status' }, {
    agent: agentWith([1, 2], { eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }) }),
  })
  assert.match(result.text, /会话事实投影: 可用/, 'projection 正常时不得报不可用')
  assert.doesNotMatch(result.text, /reading 'length'/, '不得出现读 undefined.length 的崩溃')
  assert.match(result.text, /内存事件环/, '投影节点数与内存环条数要分开报')
})

test('关键事实读取缺失、抛错或返回非数组时，压缩必须拒绝而不是猜 head', async () => {
  const cases = [
    {
      label: 'projection 方法缺失',
      options: { withSessionProjections: false },
      expected: /会话事实投影不可用/,
    },
    {
      label: 'projection 读取抛错',
      options: { projectionMode: 'throw' },
      expected: /projection replay failed/,
    },
    {
      label: 'projection 返回非数组',
      options: { projectionMode: 'invalid' },
      expected: /非数组或损坏状态/,
    },
    {
      label: 'projection 节点缺少事件类型',
      options: { projectionMode: 'malformed-node' },
      expected: /nodes are malformed/,
    },
  ]
  for (const entry of cases) {
    let engineCalls = 0
    const engine = {
      async compactRegion() {
        engineCalls += 1
        return { shadowedSeqs: [2] }
      },
    }
    const nodes = [
      { seq: 1, tokens: 10 },
      { seq: 2, tokens: 100 },
      { seq: 3, tokens: 100 },
    ]
    const harness = fakeContext({ total: 210, nodes, engine, ...entry.options })
    apply(harness.ctx, { compactRetainTokens: 1 })
    const result = await harness.registeredTools[0].execute(
      { action: 'compact' },
      {
        agent: agentWith([1, 2, 3], {
          eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
        }),
      },
    )
    assert.match(result.text, entry.expected, entry.label)
    assert.equal(engineCalls, 0, `${entry.label} 时不得调用 compactRegion`)
  }
})

test('projection checkpoint 只存 surface 结构；摘要与工具事实仅留在内存事件缓存', async () => {
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, { reportToolFacts: true })
  const definition = harness.getSessionFactsDefinition()
  assert.ok(definition, '必须注册 session facts projection')

  const summaryEvent = {
    seq: 1,
    type: 'compaction/summary',
    data: { summary: [{ type: 'text', text: 'SECRET-SUMMARY-BODY' }] },
  }
  const checkpointState = definition.apply(definition.init({}, 0), summaryEvent)
  assert.equal(Object.hasOwn(checkpointState, 'recent'), false)
  assert.doesNotMatch(JSON.stringify(checkpointState), /SECRET-SUMMARY-BODY/)

  const session = {
    id: 'memory-only',
    seq: 2,
    surface: { nodes: [] },
    snapshotEvents: () => [],
  }
  harness.listeners.get('session/event')?.(session, {
    seq: 1,
    type: 'tool/call',
    data: { arguments: JSON.stringify({ path: 'memory-only.ts' }) },
  })
  const result = await harness.registeredTools[0].execute(
    { action: 'status' },
    { agent: { session, ctx: { get: () => undefined } } },
  )
  assert.match(result.text, /memory-only\.ts/)
})

test('projection 对无关事件返回同一引用，符合 Host 的 pure fold 契约', () => {
  const harness = fakeContext({ total: 0 })
  apply(harness.ctx, undefined)
  const definition = harness.getSessionFactsDefinition()
  assert.ok(definition)
  const state = definition.init({}, 0)
  const unrelated = { seq: 1, type: 'turn/start', data: { turn: 1 } }
  assert.equal(definition.apply(state, unrelated), state)
})

test('status 结论先行：引擎可用时只报可用，不摊失败细节', async () => {
  const engine = { compactIfNeeded() {}, compactNow() {}, async compactRegion() {} }
  const nodes = [{ seq: 1, tokens: 120000 }]
  const harness = fakeContext({ total: 120000, nodes, engine })
  apply(harness.ctx, undefined)
  const tool = harness.registeredTools[0]
  const fakeAgent = agentWith([1], { eventType: () => ({ type: 'system/message' }) })

  const result = await tool.execute({ action: 'status' }, { agent: fakeAgent })
  assert.match(result.text, /引擎：可用（经 reflect\.store）/, '第一眼就要看到结论')
  assert.doesNotMatch(result.text, /诊断详情/, '引擎可用时不该展开失败路径的噪音')
  assert.match(result.text, /候选压缩区间预演/, '预演段照常显示')
})

test('findIsolatedService 没命中时返回空候选与诊断，不抛错', () => {
  const { candidates, diagnostics } = findIsolatedService({}, 'compaction')
  assert.deepEqual(candidates, [])
  assert.ok(diagnostics.length > 0, '至少给一条诊断，便于线上定位')
})

test('findIsolatedService 只肯绕 isolate 取 compaction，别的服务名一律拒绝', () => {
  // `ctx.reflect.store` 里躺着全部服务的实例，cordis 自己的注释写着
  // 「Read a service from the store without the inject requirement」。也就是说这条路
  // 能力上能取到 ApprovalService（setPolicy 改审批策略）、ConfigEditor（edit 改任意配置）、
  // AuthorizationService（cancel 收 CredentialKey）。
  //
  // 本插件的行为一直只按 name 匹配、从不读别的 impl.value，所以没有越界 —— 但
  // 「没写错」不等于「写不错」。白名单把一个代码路径的可用范围锁成一个名字。
  const fakeStore = {
    [Symbol('impl-compaction')]: { name: 'compaction', value: { compactRegion: () => {} } },
    [Symbol('impl-approval')]: { name: 'approval', value: { setPolicy: () => {} } },
    [Symbol('impl-config')]: { name: 'configEditor', value: { edit: () => {} } },
  }
  const ctx = { reflect: { store: fakeStore } }

  // 白名单内的照旧能取到
  const allowed = findIsolatedService(ctx, 'compaction')
  assert.equal(allowed.candidates.length, 1, 'compaction 必须仍可获取')
  assert.equal(typeof allowed.candidates[0].value.compactRegion, 'function')

  // 白名单外的一律拒绝，且**不返回任何值** —— 连碰都不碰那个 impl.value
  for (const denied of ['approval', 'configEditor', 'authorization', 'credentials']) {
    const result = findIsolatedService(ctx, denied)
    assert.deepEqual(result.candidates, [], `${denied} 必须被拒绝`)
    assert.ok(
      result.diagnostics.some((line) => line.includes('白名单')),
      `${denied} 的拒绝理由要说清白名单`,
    )
  }
})

test('readLatestSummary 取尾部最近的压缩摘要，不是最早那条', () => {
  const events = {
    1: { type: 'system/message' },
    2: { type: 'compaction/summary', data: { summary: [{ type: 'text', text: '旧摘要' }] } },
    4: { type: 'compaction/summary', data: { summary: [{ type: 'text', text: '新摘要' }] } },
  }
  const session = {
    seq: 5,
    snapshotEvents: (from, to) =>
      Object.keys(events)
        .map(Number)
        .filter((seq) => seq >= from && seq < to)
        .sort((a, b) => a - b)
        .map((seq) => events[seq]),
    surface: { nodes: [1, 3] },
  }
  assert.equal(readLatestSummary(session, factsReaderFor(session)), '新摘要')

  // 没压过：log 里没有 compaction/summary
  const plain = {
    seq: 2,
    snapshotEvents: () => [{ type: 'turn/start' }],
    surface: { nodes: [1, 2] },
  }
  assert.equal(readLatestSummary(plain, factsReaderFor(plain)), undefined)

  // 摘要块为空或全是非文本：视为没有
  const empty = {
    seq: 1,
    snapshotEvents: () => [
      { type: 'compaction/summary', data: { summary: [{ type: 'image' }] } },
    ],
    surface: { nodes: [1] },
  }
  assert.equal(readLatestSummary(empty, factsReaderFor(empty)), undefined)

  // 内存事件缓存抛错时不炸，返回窗口错误
  const flaky = {
    seq: 3,
    snapshotEvents: () => {
      throw new Error('replay broken')
    },
    surface: { nodes: [1, 2] },
  }
  const brokenReader = () => {
    throw new Error('replay broken')
  }
  assert.equal(readLatestSummary(flaky, brokenReader), undefined)
  assert.match(readLatestSummaryWindow(flaky, 5000, brokenReader).error, /replay broken/)
})

test('summary action 通过工具吐出摘要正文；没有摘要时给出明确说明', async () => {
  const withSummary = fakeContext({ total: 100 })
  apply(withSummary.ctx, undefined)
  const tool = withSummary.registeredTools[0]
  const agent = {
    session: {
      id: 'sum',
      seq: 3,
      surface: { nodes: [1, 2] },
      snapshotEvents: () => [
        { type: 'turn/start' },
        {
          type: 'compaction/summary',
          data: { summary: [{ type: 'text', text: '## 摘要正文' }] },
        },
      ],
    },
    ctx: { get: () => undefined },
  }
  const result = await tool.execute({ action: 'summary' }, { agent })
  assert.match(result.text, /摘要正文/)
  assert.match(result.text, /对一遍/, '要提示模型拿它和自己的锚点对账')

  const withoutSummary = fakeContext({ total: 100 })
  apply(withoutSummary.ctx, undefined)
  const bare = await withoutSummary.registeredTools[0].execute(
    { action: 'summary' },
    {
      agent: {
        session: {
          id: 'none',
          seq: 1,
          surface: { nodes: [] },
          snapshotEvents: () => [{ type: 'turn/start' }],
        },
        ctx: { get: () => undefined },
      },
    },
  )
  assert.match(bare.text, /事件环覆盖完整日志/)
  // 完整覆盖且确实没有摘要时，不能提示「历史摘要在会话日志里」——
  // 那会暗示摘要存在只是读不到（codex P3-1 的负例缺口）。
  assert.doesNotMatch(bare.text, /会话日志/, '完整覆盖且无摘要时不该出现日志提示')

  // 重启后重新挂载：事件环只覆盖挂载之后的片段，旧摘要读不到。
  // 这时必须把退路讲清楚——摘要是 log-only 事件，仍在会话日志里。
  const remounted = fakeContext({ total: 100 })
  apply(remounted.ctx, undefined)
  const partial = await remounted.registeredTools[0].execute(
    { action: 'summary' },
    {
      agent: {
        session: {
          id: 'remount',
          seq: 100,
          surface: { nodes: [] },
          snapshotEvents: () => [{ type: 'turn/start' }, { type: 'turn/start' }],
        },
        ctx: { get: () => undefined },
      },
    },
  )
  assert.match(partial.text, /历史摘要是 log-only 事件/, '覆盖不完整时要指出历史摘要在会话日志里')
  assert.match(partial.text, /compaction\/summary/, '要说明怎么在日志里找到它')
  assert.match(partial.text, /session\*\.jsonl\.zstd/, '要给出日志文件名模式')
  // 旧的断言要求文案里写「不读取会话日志内容」——那句话在实现日志回退之后就不成立了
  // （回退恰恰要解压日志）。现在要断的是**新**语义：明确说了会回退，并且给出回退门槛，
  // 而不是含糊地宣称插件不碰会话存储。
  assert.match(partial.text, /回退去解压会话日志/, '要说明内存环没有时会回退读日志')
  assert.match(partial.text, /回退只在「事件环覆盖不完整或有读取错误」时发生/, '要给出回退的门槛')
  assert.doesNotMatch(partial.text, /插件不碰会话存储/, '不能声称整个插件不碰会话存储')
})

test('seq=0 的新会话：summary 给确定结论，不说「不是从未压缩过的证据」', async () => {
  // 真实 v2 projection 不带 recent（withRecentProjectionFallback: false），
  // 否则测试会凭空注入 recent: [] 而绕开生产路径（codex 第四轮 P2）。
  const harness = fakeContext({ total: 0, withRecentProjectionFallback: false })
  apply(harness.ctx)
  const result = await harness.registeredTools[0].execute(
    { action: 'summary' },
    {
      agent: {
        session: { id: 'fresh', seq: 0, surface: { nodes: [] }, snapshotEvents: () => [] },
        ctx: { get: () => undefined },
      },
    },
  )
  assert.match(result.text, /还没有任何事件/)
  assert.doesNotMatch(result.text, /不是“从未压缩过”的证据/)
  assert.doesNotMatch(result.text, /无法读取摘要尾部窗口/, 'seq=0 不该落到 error 分支')
})

test('seq=0 但 surface 有节点（伪造状态）不误报「尚无任何事件」', async () => {
  // 真实 Host 的 seq 就是日志长度，seq=0 不可能有节点；防御伪造场景。
  const harness = fakeContext({ total: 0, withRecentProjectionFallback: false })
  apply(harness.ctx)
  const result = await harness.registeredTools[0].execute(
    { action: 'summary' },
    {
      agent: {
        session: { id: 'weird', seq: 0, surface: { nodes: [1, 2] }, snapshotEvents: () => [] },
        ctx: { get: () => undefined },
      },
    },
  )
  assert.doesNotMatch(result.text, /还没有任何事件/)
})

test('summary 只读取最近 5000 个事件，并区分“窗口内没找到”与“从未压缩”', async () => {
  const calls = []
  const session = {
    id: 'windowed',
    seq: 8000,
    surface: { nodes: [] },
    snapshotEvents: (from, to) => {
      calls.push([from, to])
      return [{ seq: 7999, type: 'turn/start' }]
    },
  }
  const reader = factsReaderFor(session)
  calls.length = 0
  const window = readLatestSummaryWindow(session, 5000, reader)
  assert.deepEqual(calls, [], '读取派生 projection 不得再次触碰同步事件 API')
  assert.equal(window.summary, undefined)
  assert.equal(window.windowed, true)
  assert.equal(window.searched, 1)

  const harness = fakeContext({ total: 100 })
  apply(harness.ctx)
  const result = await harness.registeredTools[0].execute(
    { action: 'summary' },
    { agent: { session, ctx: { get: () => undefined } } },
  )
  assert.match(result.text, /覆盖：仅覆盖插件挂载后观察到的片段/)
  assert.match(result.text, /返回事件 1 个/)
  assert.match(result.text, /类型：turn\/start=1/)
  assert.match(result.text, /这不是“从未压缩过”的证据/)
  assert.doesNotMatch(result.text, /本会话还没有摘要/)
})

test('summary 在挂载后无事件时明说不能回放 pre-mount 历史', () => {
  const window = readLatestSummaryWindow({ seq: 5 }, 5000, () => ({ recent: [] }))
  assert.match(window.error, /挂载前|不能通过同步 Session 读取回放/)
  assert.equal(window.searched, 0)
})

test('seq 26499 summary 位于 2000 事件窗口内时能匹配（显式限窗，不依赖默认值）', () => {
  const fromSeq = 24521
  const toSeq = 26521
  const events = /** @type {any[]} */ (
    Array.from({ length: toSeq - fromSeq }, (_, index) => ({
      seq: fromSeq + index,
      type: 'turn/start',
    }))
  )
  events[26499 - fromSeq] = {
    seq: 26499,
    type: 'compaction/summary',
    data: { summary: [{ type: 'text', text: 'target summary' }] },
  }
  const session = {
    seq: toSeq,
    snapshotEvents: (from, to) =>
      events.filter((event) => event.seq >= from && event.seq < to),
  }
  const window = readLatestSummaryWindow(session, 2000, factsReaderFor(session))
  assert.equal(window.fromSeq, fromSeq)
  assert.equal(window.toSeq, toSeq)
  assert.equal(window.summary, 'target summary')
  assert.equal(window.eventCount, 2000)
  assert.equal(window.summaryEvents, 1)
})

test('summary-shaped migration data仍可读取，并记录非规范事件类型诊断', () => {
  const session = {
    seq: 10,
    snapshotEvents: () => [
      {
        seq: 9,
        type: 'legacy/compaction-record',
        data: { summary: [{ type: 'text', text: 'legacy summary' }] },
      },
    ],
  }
  const window = readLatestSummaryWindow(session, 20, factsReaderFor(session))
  assert.equal(window.summary, 'legacy summary')
  assert.equal(window.summaryEvents, 0)
  assert.equal(window.summaryShapedEvents, 1)
})

test('summary 同时报告这次压缩丢掉了什么（区间 / 条数 / tokens / 生成方）', async () => {
  const session = {
    seq: 10,
    snapshotEvents: () => [
      {
        seq: 9,
        type: 'compaction/summary',
        data: {
          summary: [{ type: 'text', text: 'target summary' }],
          shadowedRange: { start: 2, end: 7 },
          shadowedSeqs: [2, 3, 4, 5, 6, 7],
          shadowedTokenCount: 12345,
          provider: 'deepseek',
          model: 'deepseek-flash',
        },
      },
    ],
  }
  const window = readLatestSummaryWindow(session, 5000, factsReaderFor(session))
  assert.equal(window.summary, 'target summary')
  assert.equal(window.compaction.start, 2)
  assert.equal(window.compaction.end, 7)
  assert.equal(window.compaction.shadowedCount, 6)
  assert.equal(window.compaction.shadowedTokens, 12345)
  assert.equal(window.compaction.provider, 'deepseek')
  assert.equal(window.compaction.model, 'deepseek-flash')

  const harness = fakeContext({ total: 100 })
  apply(harness.ctx)
  const result = await harness.registeredTools[0].execute(
    { action: 'summary' },
    { agent: { session, ctx: { get: () => undefined } } },
  )
  assert.match(result.text, /这次压缩丢掉了什么/)
  assert.match(result.text, /seq 2\.\.7/)
  assert.match(result.text, /6 条事件/)
  assert.match(result.text, /deepseek-flash/)
  assert.match(result.text, /target summary/)
})

test('summary 在事件缺少 shadowed 字段时不编造「丢掉了什么」', () => {
  const session = {
    seq: 10,
    snapshotEvents: () => [
      {
        seq: 9,
        type: 'compaction/summary',
        data: { summary: [{ type: 'text', text: 'bare summary' }] },
      },
    ],
  }
  const window = readLatestSummaryWindow(session, 5000, factsReaderFor(session))
  assert.equal(window.summary, 'bare summary')
  assert.equal(window.compaction, undefined)
})

test('事件缓存返回稀疏/非连续 seq 时仍按事件匹配 summary', () => {
  const session = {
    seq: 26521,
    snapshotEvents: () => [
      { seq: 24522, type: 'turn/start' },
      {
        seq: 26499,
        type: 'compaction/summary',
        data: { summary: [{ type: 'text', text: 'sparse summary' }] },
      },
      { seq: 26515, type: 'assistant/message' },
    ],
  }
  const window = readLatestSummaryWindow(session, 5000, factsReaderFor(session))
  assert.equal(window.summary, 'sparse summary')
  assert.equal(window.summaryEvents, 1)
  assert.equal(window.eventCount, 3)
})

test('anchorRoot 含 ".." 段时拒绝，避免把写入引到预期外的目录', () => {
  // anchorRoot 会被写进提醒文案，模型照着它落盘 —— 它其实是一条给 agent 的写指令。
  for (const value of ['../outside', 'docs/../../etc', 'docs\\..\\..\\etc', '..']) {
    assert.throws(() => resolveConfig({ anchorRoot: value }), /不能包含 "\.\."/, `应拒绝 ${value}`)
  }
  // 正常值不受影响：相对、绝对、带空格都照旧
  assert.equal(resolveConfig({}).anchorRoot, 'docs/anchors')
  assert.equal(resolveConfig({ anchorRoot: ' D:/abs/anchors ' }).anchorRoot, 'D:/abs/anchors')
})

test('阶段扫描同时限制全部目录项，且截断后明确标记不完整', async () => {
  const root = join(tmpdir(), `stage-handoff-stage-scan-${process.pid}-${Date.now()}`)
  try {
    await mkdir(join(root, '261118-0000-a'), { recursive: true })
    for (let index = 0; index < 6; index += 1) {
      await writeFile(join(root, `ordinary-${index}.txt`), 'not a stage', 'utf8')
    }
    const incomplete = await scanStageNames(root, { maxEntries: 4, budgetMs: 10_000 })
    assert.equal(incomplete.truncated, true)
    assert.equal(incomplete.scanned, 5)
    assert.match(incomplete.reason ?? '', /目录项/)

    const complete = await scanStageNames(root, { maxEntries: 20, budgetMs: 10_000 })
    assert.equal(complete.truncated, false)
    assert.deepEqual(complete.names, ['261118-0000-a'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('compactCooldownMs 只接受非负整数，0 表示关闭冷却', () => {
  assert.equal(resolveConfig({}).compactCooldownMs, 60000)
  assert.equal(resolveConfig({ compactCooldownMs: 0 }).compactCooldownMs, 0)
  assert.equal(resolveConfig({ compactCooldownMs: 5000 }).compactCooldownMs, 5000)
  assert.throws(() => resolveConfig({ compactCooldownMs: -1 }), /安全整数/)
  assert.throws(() => resolveConfig({ compactCooldownMs: 1.5 }), /安全整数/)
})

test('压缩冷却期内第二次 compact 被拒，且不会再调用引擎', async () => {
  const calls = []
  const engine = {
    async compactRegion(start, end) {
      calls.push({ start, end })
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 5 }
    },
  }
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
    { seq: 4, tokens: 100 },
  ]
  const harness = fakeContext({ total: 310, nodes, engine })
  apply(harness.ctx, { compactRetainTokens: 150 })
  const tool = harness.registeredTools[0]
  const fakeAgent = agentWith([1, 2, 3, 4], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })

  const first = await tool.execute({ action: 'compact' }, { agent: fakeAgent })
  assert.match(first.text, /精确压缩完成/)
  assert.equal(calls.length, 1)

  // 冷却窗口内再来一次：必须被拦下，且**不能**落到引擎上。
  const second = await tool.execute({ action: 'compact' }, { agent: fakeAgent })
  assert.match(second.text, /压缩冷却中/)
  assert.match(second.text, /还需等待/)
  assert.equal(calls.length, 1, '冷却期内不应再调用 compactRegion')
})

test('compactCooldownMs 配 0 关闭冷却，允许连续压缩', async () => {
  const calls = []
  const engine = {
    async compactRegion(start, end) {
      calls.push({ start, end })
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 5 }
    },
  }
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
    { seq: 4, tokens: 100 },
  ]
  const harness = fakeContext({ total: 310, nodes, engine })
  apply(harness.ctx, { compactRetainTokens: 150, compactCooldownMs: 0 })
  const tool = harness.registeredTools[0]
  const fakeAgent = agentWith([1, 2, 3, 4], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })

  await tool.execute({ action: 'compact' }, { agent: fakeAgent })
  await tool.execute({ action: 'compact' }, { agent: fakeAgent })
  assert.equal(calls.length, 2, '冷却关闭时两次都应落到引擎上')
})

test('压缩失败进入退避，防止模型立即循环重试烧摘要调用', async () => {
  let calls = 0
  const engine = {
    async compactRegion() {
      calls += 1
      throw new Error('summary backend failed')
    },
  }
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
  ]
  const harness = fakeContext({ total: 210, nodes, engine })
  apply(harness.ctx, { compactRetainTokens: 1 })
  const agent = agentWith([1, 2, 3], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })

  const first = await harness.registeredTools[0].execute({ action: 'compact' }, { agent })
  assert.match(first.text, /summary backend failed/)
  assert.equal(calls, 1)

  const second = await harness.registeredTools[0].execute({ action: 'compact' }, { agent })
  assert.match(second.text, /压缩失败退避中/)
  assert.match(second.text, /summary backend failed/)
  assert.equal(calls, 1, '退避期内不得再次调用引擎')
})

test('tokenMeter 没有返回节点时拒绝压缩，不把未知当成空表面', async () => {
  const engine = { async compactRegion() { return { shadowedSeqs: [] } } }
  const harness = fakeContext({ total: 100, engine })
  apply(harness.ctx, { compactRetainTokens: 1 })
  const result = await harness.registeredTools[0].execute(
    { action: 'compact' },
    { agent: agentWith([]) },
  )
  assert.match(result.text, /没有返回 nodes/)
  assert.match(result.text, /拒绝猜测/)
})

test('compact retainTokens 非法时直接报错，不静默改用默认预算', async () => {
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx)
  const agent = agentWith([1])
  await assert.rejects(
    () => harness.registeredTools[0].execute({ action: 'compact', retainTokens: -1 }, { agent }),
    /retainTokens 必须是非负整数/,
  )
  await assert.rejects(
    () => harness.registeredTools[0].execute({ action: 'compact', retainTokens: 1.5 }, { agent }),
    /retainTokens 必须是非负整数/,
  )
})

// --- client 插件（设置页面板）的结构契约 ---------------------------------
// 这三条守着 `dsh-client-modules` 的 ClientBundleRegistration 契约。改坏了在
// Node 里跑测试是发现不了的（浏览器才会报 "loaded without registering"），
// 所以这里用静态检查把它钉住。

test('client.js 通过 __ModuleLoader__.load 注册，且 id 等于包名', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  // 契约：id 是插件 id（包名），必须与被执行的 graph row 一致。
  const idMatch = /id:\s*'([^']+)'/.exec(source)
  assert.ok(idMatch !== null, 'client.js 必须声明 id')
  assert.equal(idMatch[1], pkg.name)

  // chunk 必须不传：省略才表示「用本包的 client.js 入口」。
  assert.doesNotMatch(source, /\bchunk\s*:/)
  // factory 接收 require 并返回 exports。
  assert.match(source, /factory\(\s*require\s*\)/)
  assert.match(source, /inject:\s*\[/)
})

test('package.json 声明了 client 入口，且指向真实文件', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = join(here, '..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.ok(existsSync(join(root, 'lib', 'client.js')), 'exports["./client"] 指向的文件必须存在')

  assert.ok(pkg.dsh.client !== undefined, 'dsh.client 必须声明')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject), 'dsh.client.inject 必须是数组')
})

test('panel 注册到 settings.section，且 register 形态符合官方契约', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  assert.match(source, /['"]settings\.section['"]/, '必须注册到 settings.section 分栏')
  // 官方形态：ctx.slots.inject(slotName, () => ctx.slots.register(spec, Component))
  assert.match(source, /ctx\.slots\.inject\(/)
  assert.match(source, /ctx\.slots\.register\(/)
  // label 是必填的导航显示名；返回字符串即符合契约。
  assert.match(source, /label:\s*\(\)\s*=>/)
  // configForms 是 cordis Service：不在 inject 里声明就永远是 undefined。
  // 第一版面板只读、显示「没有可写的 config form」，根因就是漏了这一条。
  assert.match(source, /inject:\s*\[[^\]]*'configForms'[^\]]*\]/)
  // 通过 get(entryId) 取 form，不是猜 namespace。
  assert.match(source, /forms\?\.get|forms\.get/)
  // 值的正确位置是 snapshot.value（不是 snapshot[key]，也不是 snapshot.values）。
  assert.match(source, /getSnapshot\(\)/)
  assert.match(source, /snapshot\?\.value|\.value\s*\?\?/)
  // 可写性由 snapshot.writable 决定，不能自己假设。
  assert.match(source, /\.writable/)
  // 订阅快照变化，否则外部改动不会反映到面板。
  assert.match(source, /\.subscribe\(/)
  // namespace 晚到时必须触发组件重渲染，不能把首次的空 form 永远留在页面上。
  assert.match(source, /useSyncExternalStore\(subscribeForm, getForm, getForm\)/)
  // 排查脚手架不应进入正式设置页。
  assert.doesNotMatch(source, /诊断信息（为什么拿不到 config form）/)
})

test('settings UI 使用 Host 主题令牌、可访问控件、分组页签和可逆写入', () => {  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // 跟随 DSH light/dark 主题，而不是把深色值写死在面板里。
  assert.match(source, /--dsw-alias-label-primary/)
  assert.match(source, /--dsw-alias-bg-module-platform/)
  // 输入框必须有可访问名称；UIA/屏幕阅读器不能再看到匿名 Edit。
  // 文案经 labelOf(item) 走本地化，但依旧来自该字段的 label。
  assert.match(source, /'aria-label': labelOf\(item\)/)
  assert.match(source, /const labelOf = \(item\) => pick\(item\.label, item\.labelEn\)/)
  assert.match(source, /role: 'switch'/)
  // 保存与失败反馈必须对辅助技术可见。
  assert.match(source, /'aria-live': 'polite'/)
  assert.match(source, /role: feedback\.kind === 'error' \? 'alert' : 'status'/)
  // 分组页签和键盘左右切换。
  assert.match(source, /role: 'tablist'/)
  assert.match(source, /event\.key === 'ArrowRight'/)
  // 可逆、低风险的设置操作。
  assert.match(source, /form\.unset\(key\)/)
  assert.match(source, /form\.mutate\(/)
  assert.match(source, /256k 小窗/)
  assert.match(source, /512k 中窗/)
  assert.match(source, /1M 大窗/)
  // 时长字段必须用「数字框 + 单位下拉」，并且解析器要认中文单位 ——
  // 否则界面把 300000 显示成「5 分钟」之后原样提交，就会自己拒绝自己。
  assert.match(source, /'data-stage-handoff-unit': ''/)
  assert.match(source, /分钟: 'm'/)
  assert.match(source, /function splitDuration\(ms\)/)
  assert.match(source, /function coerceDuration\(amountText, unit\)/)
  assert.match(source, /function coerceTimeZone\(raw\)/)
  assert.match(source, /item\.key === 'anchorTimeZone'/)
  assert.match(source, /return tf\('\{value\} 分钟', \{ value \}\)/)
  assert.match(source, /preset\.restore === true \? 'unset' : 'set'/)
  assert.match(source, /复制当前 Stage Handoff 配置 YAML/)
  // 设置页左侧那一行也必须跟随语言；写死英文会让中文界面里单独一条英文。
  assert.match(source, /label: \(\) => pick\('阶段收尾与锚点接力', 'Stage Handoff'\)/)
  // 左侧导航图标：没注册这个槽时宿主给的是默认齿轮。
  assert.match(source, /name: 'settings\.section\.icon'/)
  assert.match(source, /function StageHandoffGlyph\(/)
  assert.match(source, /navigator\.clipboard\?\.writeText\?\./)
})

test('面板文案的英译成对存在：加字段时漏写 En 会在这里失败', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  // 本地化不是「翻译表里有没有」，而是「每个中文字段旁边有没有对应英文」。
  // 漏写 En 时界面会在英文下回落到中文原文，肉眼很难发现。
  for (const field of ['label', 'hint', 'group', 'groupHint', 'title', 'fixed']) {
    const zh = (source.match(new RegExp(`\\n\\s+${field}: '`, 'g')) ?? []).length
    // 英文可能是单行也可能是 `hintEn:` 换行接长句，所以只要求冒号后跟内容。
    const en = (source.match(new RegExp(`\\n\\s+${field}En:`, 'g')) ?? []).length
    assert.ok(zh > 0, `${field} 一个都没有，测试本身失效了`)
    assert.equal(en, zh, `${field} 与 ${field}En 数量不一致（${zh} vs ${en}）`)
  }
  // 英译表必须真的有内容，且键是中文原文（用原文当 key，改动文案时自然会失效）。
  assert.match(source, /const EN = \{/)
  assert.match(source, /'阶段收尾与锚点接力': 'Stage handoff and anchor carry-over'/)
  // local 时区选项的标签同样要双语；它不能走 t()，否则把 client 的解析块
  // 单独提取出来跑测试时会因为 t 不在作用域而报错。
  assert.match(source, /label: '本机时间（local）', labelEn: 'Local time \(local\)'/)
})

test('面板的每个中文 t()/tf() key 都能在 EN 表查到，且表里没有死条目', () => {  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  const all = source.split('\n')
  const start = all.findIndex((line) => line.trim() === 'const EN = {')
  assert.ok(start >= 0, '找不到 EN 表')
  let end = -1
  for (let i = start + 1; i < all.length; i += 1) {
    if (all[i].trim() === '}') {
      end = i
      break
    }
  }
  assert.ok(end > start, 'EN 表没有闭合')

  const table = all.slice(start + 1, end).join('\n')
  const body = all.slice(0, start).concat(all.slice(end + 1)).join('\n')
  const keysInTable = new Set([...table.matchAll(/'((?:[^'\\]|\\.)*)'\s*:/g)].map((m) => m[1]))
  const keysInCode = new Map()
  for (const match of body.matchAll(/\btf?\('((?:[^'\\]|\\.)*)'/g)) {
    keysInCode.set(match[1], (keysInCode.get(match[1]) ?? 0) + 1)
  }
  assert.ok(keysInCode.size > 50, '抠出来的 key 太少，正则可能失效了')

  // 漏译：含中文却查不到英文 —— 英文界面会原样显示中文。
  // 反例（本测试抓到过的真 bug）：代码写 t(' 保存中') 带前导空格，
  // EN 表里却是 '保存中'，两者字节不同，英文界面照样显示中文。
  const untranslated = [...keysInCode.keys()]
    .filter((key) => /[\u4e00-\u9fa5]/.test(key))
    .filter((key) => !keysInTable.has(key))
  assert.deepEqual(untranslated, [], `这些 key 没有英文：${untranslated.join(' / ')}`)

  // 死条目：表里有、代码不再调用。不致命，但会让人以为文案还在用。
  const dead = [...keysInTable].filter((key) => !keysInCode.has(key))
  assert.deepEqual(dead, [], `EN 表里这些条目已无人调用：${dead.join(' / ')}`)
})

test('client 的 factory 能在最小桩下执行，apply 也不抛错', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // 宿主是**懒执行** factory 的：文件顶层只注册工厂，等设置页渲染时才调
  // factory(require)。所以「模块顶层引用了不存在的变量」不会在 node --check
  // 或任何静态检查里暴露，只会表现为设置页静默空白。
  // 这条测试真的把 factory 跑一遍。
  const loaded = []
  const windowStub = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } }
  const reactStub = {
    createElement: () => null,
    Fragment: 'Fragment',
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: () => undefined,
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
    useSyncExternalStore: () => undefined,
  }
  const documentStub = {
    head: { appendChild: () => {} },
    createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
    querySelector: () => null,
  }
  const navigatorStub = { language: 'en-US' }

  const evaluate = new Function('window', 'document', 'navigator', source)
  evaluate(windowStub, documentStub, navigatorStub)
  assert.equal(loaded.length, 1, '顶层应当正好注册一个工厂')

  const definition = loaded[0]
  assert.equal(definition.id, 'dsh-stage-handoff')
  const requireStub = (id) => {
    if (id === 'react') return reactStub
    throw new Error(`client 不应 require 其它模块，却 require 了 ${id}`)
  }
  const surface = definition.factory(requireStub)
  // locale 必须声明：不声明就无法保证 apply 时它就绪，
  // 早期版本还直接读 ctx.locale（未声明时为 undefined）→ 面板永远英文。
  assert.deepEqual(surface.inject, ['slots', 'configForms', 'locale'])
  assert.equal(typeof surface.apply, 'function')

  // 再用桩跑一遍 apply：它会在没有 locale / 没有 configForms 的部署上走降级路径。
  const style = { setAttribute: () => {}, appendChild: () => {}, remove: () => {} }
  const ctxStub = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    configForms: { whileServed: () => () => {}, get: () => null },
    slots: { inject: () => {}, register: () => () => {} },
    document: documentStub,
  }
  assert.doesNotThrow(() => surface.apply(ctxStub))
  assert.ok(style !== null)
})

test('usage action 报告锚点目录体积，目录不存在时明确说明而不是报错', async () => {
  const tempRoot = join(tmpdir(), `stage-handoff-usage-action-${process.pid}-${Date.now()}`)
  try {
    const harness = fakeContext({ total: 100, nodes: [], engine: undefined })
    apply(harness.ctx, { anchorRoot: tempRoot })
    const tool = harness.registeredTools[0]
    const agent = agentWith([])

    const missing = await tool.execute({ action: 'usage' }, { agent })
    assert.match(missing.text, /还不存在/)

    await mkdir(tempRoot, { recursive: true })
    await writeFile(join(tempRoot, 'anchor.md'), 'x'.repeat(100))
    const present = await tool.execute({ action: 'usage' }, { agent })
    assert.match(present.text, /100 B/)
    assert.match(present.text, /1 个文件/)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('相对 anchorRoot 以 agent 工作区为基准，而不是 host 的 cwd', async () => {
  const workspace = join(tmpdir(), `stage-handoff-ws-${process.pid}-${Date.now()}`)
  const anchorDir = join(workspace, 'docs', 'anchors')
  try {
    await mkdir(anchorDir, { recursive: true })
    await writeFile(join(anchorDir, 'anchor.md'), 'x'.repeat(2048))

    const harness = fakeContext({ total: 100, nodes: [], engine: undefined })
    apply(harness.ctx, { anchorRoot: 'docs/anchors' })
    const tool = harness.registeredTools[0]
    const agent = agentWith([])
    // 只给工作区：host 的 process.cwd() 在这条路径上不该被用到。
    Object.assign(agent.session, { header: { cwd: workspace } })

    const result = await tool.execute({ action: 'usage', scope: 'anchors' }, { agent })
    assert.match(result.text, /1 个文件/)
    assert.match(result.text, /2\.0 kB/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('scaffold：按配置时区建目录与骨架，并预填会话 ID', async () => {
  const root = join(tmpdir(), `stage-handoff-scaffold-${process.pid}-${Date.now()}`)
  try {
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    const agent = agentWith([])
    agent.session.id = 'session-abc123'

    const result = await tool.execute({ action: 'scaffold', topic: 'stage-handoff' }, { agent })
    assert.match(result.text, /已创建阶段目录/)

    const dirs = await readdir(root)
    assert.equal(dirs.length, 1, '应只建一个阶段目录')
    assert.equal(dirs.some((name) => name.startsWith('.stage-handoff-tmp-')), false)
    // 时间戳在**调用时**生成，格式 YYMMDD-HHMM，且不含冒号（Windows 路径不允许）。
    assert.match(dirs[0], /^\d{6}-\d{4}-stage-handoff$/)

    const anchor = readFileSync(join(root, dirs[0], 'anchor.md'), 'utf8')
    assert.match(anchor, /## 会话索引/)
    assert.match(anchor, /session-abc123/, '当前会话 ID 应预填进会话索引')
    assert.match(anchor, /## 下一步/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recall：按关键词检索锚点，返回所在章节与行号', async () => {
  const root = join(tmpdir(), `stage-handoff-recall-${process.pid}-${Date.now()}`)
  const stageDir = join(root, '261116-0000-demo')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      [
        '# 261116-0000-demo 锚点', // 1
        '', // 2
        '## 硬约束', // 3
        '- [人工明确] 不许动 compaction-basic 配置', // 4
        '', // 5
        '## 决策与否决', // 6
        '- [有效] 压缩保留量留在 97085', // 7
        '- [否决] 自己实现投毒检测', // 8
        '', // 9
        '## 关键入口', // 10
        '- `research/SOURCES.md`', // 11
        '```md', // 12
        '压缩示例：这里只是格式示例，不是锚点事实', // 13
        '```', // 14
      ].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]

    const hit = await tool.execute({ action: 'recall', query: '压缩' }, { agent: agentWith([]) })
    assert.match(hit.text, /找到 1 条/)
    // 章节与行号都要报出来：同一条事实在「硬约束」和「决策与否决」里分量不同。
    assert.match(hit.text, /【决策与否决】第 7 行/)
    assert.match(hit.text, /压缩保留量留在 97085/)

    const miss = await tool.execute(
      { action: 'recall', query: '这个词不存在' },
      { agent: agentWith([]) },
    )
    assert.match(miss.text, /没有找到/)
    assert.match(miss.text, /不检索 detail/)

    const noQuery = await tool.execute({ action: 'recall' }, { agent: agentWith([]) })
    assert.match(noQuery.text, /需要 query 参数/)

    // limit 的非法值必须**说出来**：静默回落到 20 会让模型以为「只取 5 条」，
    // 实际拿到 20 条原文行（每条还带章节与行号两行），而输出里没有任何提示。
    for (const bad of [0, -3, 2.5, '5']) {
      const rejected = await tool.execute(
        { action: 'recall', query: '压缩', limit: bad },
        { agent: agentWith([]) },
      )
      assert.match(
        rejected.text,
        /limit 必须是正整数/,
        `limit=${JSON.stringify(bad)} 应当被明确拒绝，而不是静默取默认值`,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recall：没有阶段目录时给出可执行的提示而不是抛错', async () => {
  const root = join(tmpdir(), `stage-handoff-recall-empty-${process.pid}-${Date.now()}`)
  try {
    await mkdir(root, { recursive: true })
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'recall', query: '任意词' },
      { agent: agentWith([]) },
    )
    assert.match(result.text, /没有找到阶段目录/)
    assert.match(result.text, /scaffold/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('collectToolFacts：从 tool/call 参数机械提取文件与命令，解析失败则跳过', () => {
  const session = {
    seq: 7,
    snapshotEvents: () => [
      { seq: 1, type: 'user/message', data: {} },
      {
        seq: 2,
        type: 'tool/call',
        data: { name: 'fs_read', arguments: JSON.stringify({ path: '/repo/a.ts' }) },
      },
      {
        seq: 3,
        type: 'tool/call',
        data: { name: 'fs_edit', arguments: JSON.stringify({ file_path: '/repo/b.ts' }) },
      },
      {
        seq: 4,
        type: 'tool/call',
        data: { name: 'bash', arguments: JSON.stringify({ command: 'node --test' }) },
      },
      // 参数不是 JSON：必须跳过而不是抛错
      { seq: 5, type: 'tool/call', data: { name: 'bash', arguments: 'not json at all' } },
      // arguments 缺失
      { seq: 6, type: 'tool/call', data: { name: 'bash' } },
    ],
  }
  const facts = collectToolFacts(session, 5000, factsReaderFor(session))
  assert.deepEqual(facts.files.sort(), ['/repo/a.ts', '/repo/b.ts'])
  assert.deepEqual(facts.commands, ['node --test'])
  assert.equal(facts.scanned, 6)
})

test('collectToolFacts：数组形式的路径、非对象参数、空会话都不炸', () => {
  const arraySession = {
    seq: 4,
    snapshotEvents: () => [
      {
        seq: 1,
        type: 'tool/call',
        data: { name: 'fs_multi', arguments: JSON.stringify({ paths: ['/x/1.ts', '/x/2.ts'] }) },
      },
      { seq: 2, type: 'tool/call', data: { name: 'x', arguments: JSON.stringify([1, 2, 3]) } },
      { seq: 3, type: 'tool/call', data: { name: 'y', arguments: JSON.stringify(null) } },
    ],
  }
  const arrayFacts = collectToolFacts(arraySession, 5000, factsReaderFor(arraySession))
  assert.deepEqual(arrayFacts.files.sort(), ['/x/1.ts', '/x/2.ts'])
  assert.deepEqual(arrayFacts.commands, [])

  const emptySession = { seq: 0, snapshotEvents: () => [] }
  assert.deepEqual(collectToolFacts(emptySession, 5000, factsReaderFor(emptySession)), {
    files: [],
    mutated: [],
    commands: [],
    scanned: 0,
    coverage: 'empty',
    coverageMeta: {
      mountSeq: null,
      firstRetainedSeq: null,
      lastObservedSeq: null,
      truncatedByCount: false,
      truncatedByBytes: false,
      hasGap: false,
      bytes: 0,
    },
  })
  // seq 不可用
  assert.deepEqual(collectToolFacts({}), {
    files: [],
    commands: [],
    scanned: 0,
    coverage: 'unavailable',
  })
  // 内存事件缓存抛错
  const brokenFacts = collectToolFacts({ seq: 5 }, 5000, () => {
    throw new Error('boom')
  })
  assert.deepEqual(
    { files: brokenFacts.files, commands: brokenFacts.commands, scanned: brokenFacts.scanned },
    { files: [], commands: [], scanned: 0 },
  )
  assert.match(brokenFacts.reason, /boom/)
})

test('事件环给 assistant/message 记下思考形状，但不记原文', () => {
  // 收尾流程（compact 动作与 status）靠这个形状判「模型是不是已经在复读」。
  // 环刻意不保存 assistant 内容，所以形状里绝不能夹带原文。
  const fact = recentFactFromEvent({
    seq: 42,
    type: 'assistant/message',
    data: {
      turn: 7,
      message: { content: [{ type: 'reasoning', text: '好。\n好。\n好。' }, { type: 'tool-call', name: 'pwsh' }] },
    },
  })
  assert.equal(fact.turn, 7)
  assert.deepEqual(Object.keys(fact.reasoning).sort(), [
    'chars',
    'compress',
    'dev',
    'dupShort',
    'fillers',
    'lang',
    'maxRepeat',
    'norm',
    'rawRows',
    'repeatRatio',
    'rows',
    'shortRatio',
    'tiny',
  ])
  assert.equal(fact.reasoning.rows, 3)
  assert.equal(fact.reasoning.fillers, 3)
  assert.equal(fact.reasoning.maxRepeat, 3)
  assert.equal(fact.reasoning.tiny, true)
  // 「好。」有实词，所以不算占位符行 —— 占位符判据只认纯标点那种形态。
  assert.equal(fact.reasoning.dupShort, 0)
  assert.equal(fact.reasoning.shortRatio, 0)
  // 6 个字符太短，不稳定：deflate 的固定头部会把比例推到 1 附近，所以不算压缩率。
  assert.equal(fact.reasoning.compress, undefined)
  assert.ok(!JSON.stringify(fact).includes('好'), '事件环里不能留下思考原文')

  // 没有 reasoning 的 step 也要留一个空形状：否则两个碎片块之间夹一个
  // 纯工具 step 时，「连续碎片块」会被错误地连成一片。
  const toolOnly = recentFactFromEvent({
    seq: 43,
    type: 'assistant/message',
    data: { turn: 7, message: { content: [{ type: 'tool-call', name: 'read' }] } },
  })
  assert.equal(toolOnly.reasoning.rows, 0)
  assert.equal(toolOnly.reasoning.tiny, false)
})

test('事件环记下 tool/call 的工具名，用于识别等待型工具', () => {
  // 复读 turn 里含 job_output / job_list / wait_agent 的比例是 25%，干净 turn 是 14%
  // （仓库内内部测量笔记）。点名这三个比泛泛说「别空转」有用，
  // 而环原本只留 files/commands，看不见工具名。
  const waited = recentFactFromEvent({
    seq: 5,
    type: 'tool/call',
    data: { name: 'job_output', arguments: { job_id: 'x' } },
  })
  assert.equal(waited.name, 'job_output')

  // 名字必须截断，否则异常长度会吃掉环的字节预算。
  const long = recentFactFromEvent({
    seq: 6,
    type: 'tool/call',
    data: { name: 'x'.repeat(200), arguments: {} },
  })
  assert.equal(long.name.length, 40)

  // 没有名字就不写这个字段，别把 undefined 混进环。
  const unnamed = recentFactFromEvent({ seq: 7, type: 'tool/call', data: { arguments: {} } })
  assert.equal('name' in unnamed, false)
})

test('collectToolFacts projection 对单事件字符串数量与长度设硬上限', () => {
  const manyPaths = Array.from({ length: 200 }, (_, index) => `/repo/${index}.ts`)
  const longCommand = 'x'.repeat(10_000)
  const manyFact = recentFactFromEvent({
    seq: 0,
    type: 'tool/call',
    data: { arguments: JSON.stringify({ paths: manyPaths }) },
  })
  assert.equal(manyFact.files.length, 128)
  assert.equal(manyFact.factsTruncated, true)

  const longFact = recentFactFromEvent({
    seq: 1,
    type: 'tool/call',
    data: { arguments: JSON.stringify({ command: longCommand }) },
  })
  assert.equal(longFact.commands[0].length, 4096)
  assert.equal(longFact.factsTruncated, true)

  const oversizedFact = recentFactFromEvent({
    seq: 2,
    type: 'tool/call',
    data: { arguments: 'x'.repeat(1024 * 1024 + 1) },
  })
  assert.equal(oversizedFact.factsTruncated, true)
  assert.equal(oversizedFact.files, undefined)
  assert.equal(oversizedFact.commands, undefined)
})

test('summary 投影同时限制块数与正文长度，并保留截断标记', () => {
  const manyBlocks = recentFactFromEvent({
    seq: 3,
    type: 'compaction/summary',
    data: {
      summary: Array.from({ length: 4100 }, (_, index) => ({
        type: 'text',
        text: `block-${index}`,
      })),
    },
  })
  assert.equal(manyBlocks.summaryTruncated, true)
  assert.match(manyBlocks.summaryText, /^block-0\n\nblock-1/)
  assert.doesNotMatch(manyBlocks.summaryText, /block-4099/)

  const longText = recentFactFromEvent({
    seq: 4,
    type: 'compaction/summary',
    data: {
      summary: [{ type: 'text', text: 'x'.repeat(64 * 1024 + 200) }],
    },
  })
  assert.equal(longText.summaryTruncated, true)
  assert.equal(longText.summaryText.length, 64 * 1024)
  assert.equal(longText.summaryText, 'x'.repeat(64 * 1024))
})

test('pending-tool 证据为空或不可读时按“可能仍在调用”处理，不误注入提醒', () => {
  assert.equal(hasPendingToolCall({ seq: 5 }, () => ({ recent: [] })), true)
  assert.equal(
    hasPendingToolCall({ seq: 5 }, () => {
      throw new Error('ring unavailable')
    }),
    true,
  )
  assert.equal(hasPendingToolCall({ seq: 0 }, () => ({ recent: [] })), false)
})

test('真实 Host 形状的 tool/result 必须配得上 tool/call，不能一直判成 pending', () => {
  // 回归：真实 Host 的 tool/result 没有 data.callId，调用 ID 在 message.toolCallId 上
  // （本机实测 6,420 条 tool/result 里 data.callId 出现 0 次）。旧代码只读 data.callId，
  // 于是 answered 恒空，每个已完成的调用都被判成 pending，
  // 默认 notifySkipWhenToolPending=true 时阶段收尾提醒被静默跳过。
  const call = { seq: 1, type: 'tool/call', data: { callId: 'c1', arguments: '{}' } }
  const result = {
    seq: 2,
    type: 'tool/result',
    data: { message: { toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' } } },
  }
  const facts = [recentFactFromEvent(call), recentFactFromEvent(result)]
  assert.equal(facts[1].callId, 'c1', 'tool/result 必须带上 callId')
  assert.equal(
    hasPendingToolCall({ seq: 2 }, () => ({ recent: facts })),
    false,
    '一 call 一 result 已经配对，不该判成 pending',
  )
})

test('tool/result 只带 message.source.callId 时也能配对', () => {
  const call = { seq: 1, type: 'tool/call', data: { callId: 'c2', arguments: '{}' } }
  const result = {
    seq: 2,
    type: 'tool/result',
    data: { message: { source: { kind: 'tool', callId: 'c2' } } },
  }
  const facts = [recentFactFromEvent(call), recentFactFromEvent(result)]
  assert.equal(facts[1].callId, 'c2')
  assert.equal(hasPendingToolCall({ seq: 2 }, () => ({ recent: facts })), false)
})

test('修复之后仍然能拦住真正的未完成调用', () => {
  // 这一条是前一条的对照组：放宽 ID 提取不等于把 gate 关掉。
  const call = { seq: 1, type: 'tool/call', data: { callId: 'c3', arguments: '{}' } }
  const facts = [recentFactFromEvent(call)]
  assert.equal(
    hasPendingToolCall({ seq: 1 }, () => ({ recent: facts })),
    true,
    '只有 tool/call、没有 result 时必须继续拦住提醒',
  )
})

test('事件环字节数是增量维护的，必须与全量重算一致（B1 回归）', () => {
  // 旧写法每来一个事件就把整环重新 JSON.stringify 一遍，环满 10000 条时
  // 实测约 3 ms/事件。改成增量之后，正确性必须仍然成立。
  let state
  for (let i = 0; i < 500; i += 1) {
    state = appendRecentFact(state, { seq: i, type: 'tool/call', callId: `c${i}` })
  }
  const full = state.recent.reduce(
    (sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'),
    0,
  )
  assert.equal(state.bytes, full, '增量累加的 bytes 必须等于实际序列化字节')
  assert.equal(state.hasGap, false, '连续 seq 不该被记成缺口')
})

test('环中间漏了事件必须报缺口，不能报 complete（B2 回归）', () => {
  // 旧逻辑只核对两个端点：first 够早、last 够新就报 complete，
  // 中间漏掉多少都看不见。停用期丢事件、listener 抛错都会踩到。
  let state
  state = appendRecentFact(state, { seq: 1, type: 'step/start' })
  state = appendRecentFact(state, { seq: 2, type: 'tool/call', callId: 'c1' })
  state = appendRecentFact(state, { seq: 4, type: 'tool/result' }) // seq 3 丢了
  assert.equal(state.hasGap, true, 'seq 跳号必须被记成缺口')
  assert.equal(coverageForRange(state, 1, 5).coverage, 'partial-gap')
})

test('seq 连续且端点齐全时报 complete（缺口检测的对照组）', () => {
  // 防止修 B2 时把正常情况也报成缺口。
  let state
  for (const seq of [1, 2, 3, 4]) {
    state = appendRecentFact(state, { seq, type: 'step/start' })
  }
  assert.equal(state.hasGap, false)
  assert.equal(coverageForRange(state, 1, 5).coverage, 'complete')
})

test('阶段预约的「已 N 秒」在时钟回跳时不得显示负数', async () => {
  // 这条路径的调用点在 `process.platform !== 'win32'` 分支里（Windows 走 mkdir 原子性，
  // 不用 sidecar），所以一直没法从公共入口测到 —— 但**函数体本身不检查平台**，导出后
  // 直测即可，不需要伪造 `process.platform`。
  //
  // 时钟回跳（NTP 校正、休眠恢复、VM 快照回滚）会让 `Date.now() - createdAt` 为负。
  // 旧实现直接把它打进 detail，回执于是显示「已 -3600 秒」；同文件另外两处倒计时
  // （压缩冷却、defer 剩余）早就钳了下限，这一处漏了。
  const root = await mkdtemp(join(tmpdir(), 'stage-handoff-reservation-age-'))
  const stageName = '261117-0000-future'
  const stageDir = join(root, stageName)
  const sidecar = join(root, `.${stageName}.stage-handoff-reservation.json`)
  const write = (createdAt) =>
    writeFile(
      sidecar,
      JSON.stringify({
        schemaVersion: 1,
        stageName,
        pid: process.pid,
        createdAt,
        token: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      }),
      'utf8',
    )
  try {
    await mkdir(stageDir, { recursive: true })

    // ① createdAt 在未来一小时 == 时钟回跳
    await write(Date.now() + 3_600_000)
    const future = await recoverStaleStageReservation(root, stageName, stageDir, 86_400_000)
    assert.equal(future.status, 'in-progress', `pid 还活着就该报进行中：${JSON.stringify(future)}`)
    assert.doesNotMatch(
      String(future.detail),
      /-\d/,
      `时钟回跳不得显示负数，实际：${future.detail}`,
    )
    assert.match(String(future.detail), /已 0 秒/, '钳零后应显示 0 秒')

    // ② 正常时间戳仍是真实秒数
    await write(Date.now() - 120_000)
    const normal = await recoverStaleStageReservation(root, stageName, stageDir, 86_400_000)
    assert.match(String(normal.detail), /已 120 秒/, '正常情况不能被钳成 0')

    // ③ 超过 TTL 仍要按过期回收（钳零不能把过期判断一起弄坏）
    await write(Date.now() - 7_200_000)
    const expired = await recoverStaleStageReservation(root, stageName, stageDir, 3_600_000)
    assert.equal(expired.status, 'recovered', `超 TTL 必须回收：${JSON.stringify(expired)}`)
  } finally {
    await removePath(root, { recursive: true, force: true })
  }
})

test('measureWindow 降级告警必须按实例各报一次（重挂后不能沉默）', async () => {
  // 模块级布尔既不随 dispose 复位、也不分实例：重挂之后这条唯一的降级说明就永久沉默，
  // 而「改 profile 后重挂」是本插件文档里的常规操作。它说明的后果很重：兜底压缩线从
  // 「窗口的 85%」退回 `compactRetainTokens × 4`（1M 窗口下 850k → 128k）。
  const warns = (harness) =>
    harness.logs.filter(([level, message]) => level === 'warn' && /contextPressure/.test(String(message)))

  // 必须越过提醒线：`measureWindow` 只在越线路径上被调用（文案要显示占比）。
  // 两个实例必须用**不同的 session 对象** —— 提醒配额现在是进程级共享的，同一会话
  // 在第二个实例里会被正确抑制，于是根本走不到读窗口那一步。
  const freshAgent = (id) => ({
    session: { id, seq: 0, surface: { nodes: [] }, snapshotEvents: () => [] },
  })
  const brokenPressure = () => {
    const harness = fakeContext({ total: 400_000 })
    harness.ctx.tokenMeter.contextPressure = () => {
      throw new Error('pressure broken')
    }
    return harness
  }

  const first = brokenPressure()
  apply(first.ctx, {})
  await runPreStep(first.listeners.get('agent/pre-step'), { agent: freshAgent('w1') })
  assert.equal(warns(first).length, 1, `第一份实例必须告警一次；实际日志：${JSON.stringify(first.logs)}`)
  // 同一实例再触发一次仍是 1 条：它跑在每一步的路径上，每步刷一条会让日志没法看。
  await runPreStep(first.listeners.get('agent/pre-step'), { agent: freshAgent('w1b') })
  assert.equal(warns(first).length, 1, '同一实例不得重复告警')

  const second = brokenPressure()
  apply(second.ctx, {})
  await runPreStep(second.listeners.get('agent/pre-step'), { agent: freshAgent('w2') })
  assert.equal(warns(second).length, 1, '新实例必须重新告警，不能被上一份实例的标记压住')
})

test('reconcile 认有序列表写的硬约束（与 validate / guard 同一份定义）', async () => {
  // 第四轮把 validate / guard 的判据换成 LIST_ROW_PATTERN，漏了 reconcile：同一份锚点，
  // 用 `1.` 写的硬约束在它眼里是「无条目」，而另两个 action 看得见两条。
  const root = join(tmpdir(), `stage-handoff-reconcile-ol-${process.pid}-${Date.now()}`)
  const stageDir = join(root, '261116-0000-ol')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      [
        '# ol 锚点',
        '',
        '## 硬约束',
        '1. [实测] 部署后必须重启宿主才会生效',
        '2. [人工明确] 不许动 compaction-basic 配置',
        '',
        '## 决策与否决',
        '1. [否决] 换掉 harness 自带搜索',
        '',
      ].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const agent = {
      session: {
        id: 'sy',
        seq: 4,
        surface: { nodes: [] },
        snapshotEvents: () => [
          {
            seq: 3,
            type: 'compaction/summary',
            data: {
              summary: [
                {
                  type: 'text',
                  text: '## 硬约束 部署后必须重启宿主才会生效。不许动 compaction-basic 配置。',
                },
              ],
              shadowedRange: { start: 1, end: 2 },
            },
          },
        ],
      },
    }
    const result = await harness.registeredTools[0].execute({ action: 'reconcile' }, { agent })
    assert.doesNotMatch(
      String(result.text),
      /硬约束：无条目/,
      `有序列表必须被数进去，实际：${result.text}`,
    )
    assert.match(String(result.text), /硬约束：2 条/)
    assert.match(String(result.text), /决策与否决：1 条/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reconcile 遇到新会话（seq=0）必须说「没有事件」，不能说「无法读取」', async () => {
  // 与 summary 同一判定顺序。旧实现先判 error，于是 seq=0 被报成「无法读取摘要尾部
  // 窗口」，还把 agent 引向 action="summary" —— 而 summary 会当场否认这个失败。
  const root = join(tmpdir(), `stage-handoff-reconcile-fresh-${process.pid}-${Date.now()}`)
  const stageDir = join(root, '261116-0000-fresh')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      ['# fresh', '', '## 下一步', '1. 跑测试', ''].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    // 真实 v2 projection 不带 recent，也没有 snapshotEvents —— 这正是
    // `readLatestSummaryWindow` 会返回 error 的形态，也是旧实现误报的触发条件。
    const agent = { session: { id: 'sz', seq: 0, surface: { nodes: [] } } }
    const result = await harness.registeredTools[0].execute({ action: 'reconcile' }, { agent })
    assert.doesNotMatch(
      String(result.text),
      /无法读取摘要尾部窗口/,
      `新会话不该报读取失败，实际：${result.text}`,
    )
    assert.match(
      String(result.text),
      /还没有任何事件|没有在可用缓存里匹配到摘要|没有摘要/,
      `要说清是「还没有」而不是「读不到」，实际：${result.text}`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reconcile：命中项逐条列出，未命中项不再刷屏', async () => {
  const root = join(tmpdir(), `stage-handoff-reconcile-${process.pid}-${Date.now()}`)
  const stageDir = join(root, '261116-0000-rec')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      [
        '# rec 锚点',
        '',
        '## 硬约束',
        '- [实测] 部署后必须重启宿主才会生效',
        '- [人工明确] 不许动 compaction-basic 配置',
        '',
        '## 决策与否决',
        '- [有效的] 压缩保留量留在 97085',
        '- [否决] 换掉 harness 自带搜索',
        '',
      ].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]

    // 摘要里只有前两条约束、第一条决策 —— 其余应当被列为「找不到对应」
    const agent = {
      session: {
        id: 'sx',
        seq: 4,
        surface: { nodes: [] },
        snapshotEvents: () => [
          {
            seq: 3,
            type: 'compaction/summary',
            data: {
              summary: [
                {
                  type: 'text',
                  text: [
                    '## 硬约束',
                    '部署后必须重启宿主才会生效。',
                    '不许动 compaction-basic 配置。',
                    '压缩保留量留在 97085。',
                  ].join(' '),
                },
              ],
              shadowedRange: { start: 1, end: 2 },
            },
          },
        ],
      },
    }
    const result = await tool.execute({ action: 'reconcile' }, { agent })
    // 四条里找到三条：硬约束 2/2、决策 1/2
    assert.match(result.text, /硬约束：2 条，其中 exact=2、prefix16=0、none=0/)
    assert.match(result.text, /决策与否决：2 条，其中 exact=1、prefix16=0、none=1/)
    // 命中项要列出来 —— 这才是值得看的信号
    assert.match(result.text, /部署后必须重启宿主才会生效/)
    assert.match(result.text, /压缩保留量留在 97085/)
    // 找不到的不再逐条列出：按设计属于常态，列出来只会变成噪音
    assert.doesNotMatch(result.text, /换掉 harness 自带搜索/, '未命中项不该逐条列出')
    assert.doesNotMatch(result.text, /值得复核/, '不该再出现「值得复核」的逐条清单')
    // 明确的免责声明
    assert.match(result.text, /不做重要性判断/)
    // 结构对照：两边小节都列出来
    assert.match(result.text, /锚点的二级小节/)
    assert.match(result.text, /硬约束/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reconcile：读不到摘要时明说，不给空表', async () => {
  const root = join(tmpdir(), `stage-handoff-reconcile-none-${process.pid}-${Date.now()}`)
  const stageDir = join(root, '261116-0000-none')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(join(stageDir, 'anchor.md'), '# none 锚点\n\n## 硬约束\n- x\n', 'utf8')
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const agent = {
      session: {
        id: 'sx',
        seq: 2,
        surface: { nodes: [] },
        snapshotEvents: () => [{ seq: 1, type: 'user/message', data: {} }],
      },
    }
    const result = await harness.registeredTools[0].execute({ action: 'reconcile' }, { agent })
    assert.match(result.text, /读不到最近一次压缩摘要/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('validate：下一步下面的说明行不算第一步，只看编号行', async () => {
  const root = join(tmpdir(), `stage-handoff-validate-paren-${process.pid}-${Date.now()}`)
  const stageDir = join(root, '261116-0000-paren')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      [
        '# paren 锚点',
        '',
        '## 硬约束',
        '- [实测] 部署后必须重启',
        '',
        '## 下一步',
        '（有序，最要紧的排第一。每一条都要写成能直接执行的样子；这不是步骤。）',
        '1. 跑 `node --test` 确认全绿',
        '',
      ].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute({ action: 'validate' }, { agent: agentWith([]) })
    // 括号说明行不该被当成第一步而误报
    assert.doesNotMatch(result.text, /下一步第一条没有可执行 token/)
    assert.match(result.text, /下一步第一条带路径或命令/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scaffold：用 tool/call 机械预填关键入口，并归档上一阶段锚点', async () => {
  const root = join(tmpdir(), `stage-handoff-scaffold-facts-${process.pid}-${Date.now()}`)
  try {
    // 先造一个「上一阶段」，供归档
    const prevDir = join(root, '261115-0000-prev')
    await mkdir(prevDir, { recursive: true })
    await writeFile(join(prevDir, 'anchor.md'), '# prev 锚点\n\n旧的\n', 'utf8')

    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const agent = {
      session: {
        id: 'sx',
        seq: 3,
        surface: { nodes: [] },
        snapshotEvents: () => [
          {
            seq: 1,
            type: 'tool/call',
            data: { name: 'fs_edit', arguments: JSON.stringify({ path: 'D:\\repo\\touched.ts' }) },
          },
          {
            seq: 2,
            type: 'tool/call',
            data: { name: 'bash', arguments: JSON.stringify({ command: 'node --test' }) },
          },
        ],
      },
    }
    const result = await harness.registeredTools[0].execute(
      { action: 'scaffold', topic: 'facts' },
      { agent },
    )
    assert.match(result.text, /已创建阶段目录/)
    assert.match(result.text, /parent-backup/)

    const created = (await readdir(root))
      .filter((name) => /^\d{6}-\d{4}-facts$/.test(name))
      .map((name) => join(root, name))[0]
    assert.ok(created, '应创建出新阶段目录')
    const skeleton = readFileSync(join(created, 'anchor.md'), 'utf8')
    // 机械推导的文件进了「关键入口」
    assert.match(skeleton, /touched\.ts/)
    assert.match(skeleton, /机械推导/)
    // 上一阶段锚点被归档
    const backups = await readdir(join(created, 'parent-backup'))
    assert.equal(backups.length, 1)
    assert.match(readFileSync(join(created, 'parent-backup', backups[0]), 'utf8'), /prev 锚点/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate 要求 [approval: …] 带上生效状态（G1 回归）', async () => {
  const root = join(tmpdir(), `stage-handoff-approval-${process.pid}-${Date.now()}`)
  const stageName = '261118-0000-approval'
  const stageDir = join(root, stageName)
  const body = (approvalLine) =>
    [
      '# 审批锚点',
      '',
      '上一版锚点：parent-backup/anchor-x.md（归档自 prev）',
      '',
      '## 下一步',
      '',
      '1. 跑 `node --test test/index.test.mjs` 确认全绿',
      '',
      '## 不能丢的事实',
      '',
      '- [实测 261118] 上下文环有 coverage',
      '- [推断未验证] 缺口检测还缺测试',
      '',
      '## 硬约束',
      '',
      '- [人工明确] 不删除任何 qcow2 镜像。',
      approvalLine,
      '',
      '## 决策与否决',
      '',
      '- [有效] [实测 261118] 先修 bug 再补缺口',
      '',
    ].join('\n')
  try {
    await mkdir(stageDir, { recursive: true })
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]

    await writeFile(
      join(stageDir, 'anchor.md'),
      body('- [approval: 迁移生产库] 只批了这一次'),
      'utf8',
    )
    const bad = await tool.execute({ action: 'validate', stage: stageName }, { agent: agentWith([]) })
    assert.match(bad.text, /没写生效状态/, 'approval 缺生效状态必须报出来')

    await writeFile(
      join(stageDir, 'anchor.md'),
      body('- [approval: 迁移生产库 已撤回 @261117]'),
      'utf8',
    )
    const good = await tool.execute({ action: 'validate', stage: stageName }, { agent: agentWith([]) })
    assert.match(good.text, /都带生效状态/, '写了状态就不该再报')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate 第 7 项必须认出带日期的 [推断未验证]（B3 回归）', async () => {
  const root = join(tmpdir(), `stage-handoff-dated-infer-${process.pid}-${Date.now()}`)
  const stageName = '261001-0000-old'
  const stageDir = join(root, stageName)
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      [
        '# 老阶段锚点',
        '',
        '上一版锚点：parent-backup/anchor-x.md（归档自 prev）',
        '',
        '## 下一步',
        '',
        '1. 跑 `node --test test/index.test.mjs` 确认全绿',
        '',
        '## 不能丢的事实',
        '',
        '- [实测 261001] 上下文环有 coverage',
        '- [推断未验证 261001] 缺口检测还缺测试',
        '',
        '## 硬约束',
        '',
        '- [人工明确] 不删除任何 qcow2 镜像。',
        '',
        '## 决策与否决',
        '',
        '- [有效] [实测 261001] 先修 bug 再补缺口',
        '',
      ].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'validate', stage: stageName },
      { agent: agentWith([]) },
    )
    // 旧代码只认无日期的 [推断未验证]，这条带日期的被漏掉，于是永远不会报超期。
    assert.match(result.text, /阶段已过去 \d+ 天/, '带日期的 [推断未验证] 也必须参与超期判断')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-step 自动比对锚点与基线，硬约束消失必须报警（G2 回归）', async () => {
  // 旧行为：基线只在 agent 主动调 validate 时才比对，属于 audit-time。
  // 这里钉住新行为：每轮第一个 pre-step 自动查一次，不消耗提醒配额。
  const root = join(tmpdir(), `stage-handoff-drift-${process.pid}-${Date.now()}`)
  const probePath = join(root, '.stage-handoff-prestep.jsonl')
  const previousProbePath = process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG
  const stageName = '261118-0000-drift'
  const stageDir = join(root, stageName)
  const body = (extra) =>
    [
      '# 漂移锚点',
      '',
      '上一版锚点：parent-backup/anchor-x.md（归档自 prev）',
      '',
      '## 下一步',
      '',
      '1. 跑 `node --test test/index.test.mjs` 确认全绿',
      '',
      '## 不能丢的事实',
      '',
      '- [实测 261118] 上下文环有 coverage',
      '- [推断未验证] 缺口检测还缺测试',
      '',
      '## 硬约束',
      '',
      '- [人工明确] 不删除任何 qcow2 镜像。',
      ...extra,
      '',
      '## 决策与否决',
      '',
      '- [有效] [实测 261118] 先修 bug 再补缺口',
      '',
    ].join('\n')
  const driftAgent = (turnStartSeq) => ({
    session: {
      id: 'sd',
      seq: 1,
      surface: { nodes: [] },
      snapshotEvents: () => [],
      turnBoundary: { openTurnStartSeq: turnStartSeq },
    },
  })
  try {
    process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG = probePath
    await mkdir(stageDir, { recursive: true })
    await writeFile(join(stageDir, 'anchor.md'), body(['- [人工明确] 不读 data\\.credentials.yaml。']), 'utf8')
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    const guarded = await tool.execute({ action: 'guard', stage: stageName }, { agent: agentWith([]) })
    assert.match(guarded.text, /硬约束 2 条/)

    // 一轮之内不该有漂移：先跑一次，把这一轮的检查额度用掉。
    const clean = await runPreStep(harness.listeners.get('agent/pre-step'), {
      agent: driftAgent(500),
      turn: 1,
      step: 1,
    })
    assert.equal(clean.messages.length, 1, '没有漂移时不该多注入消息')

    // 悄悄删掉一条硬约束
    await writeFile(join(stageDir, 'anchor.md'), body([]), 'utf8')

    // 下一轮（turn 起点变了）必须自动报出来。
    // 复用同一个 session 对象：真实 Host 在连续的 pre-step 里给的就是同一个。
    const nextSession = {
      id: 'sd',
      seq: 1,
      surface: { nodes: [] },
      snapshotEvents: () => [],
      turnBoundary: { openTurnStartSeq: 900 },
    }
    const caught = await runPreStep(harness.listeners.get('agent/pre-step'), {
      agent: { session: nextSession },
      turn: 2,
      step: 1,
    })
    assert.equal(caught.messages.length, 2, '漂移必须被自动注入一条提示')
    const injected = caught.messages[caught.messages.length - 1]
    const text = injected?.content?.[0]?.text ?? ''
    assert.match(text, /基线记录不见了/, '提示要说清是基线记录消失')
    assert.match(text, /以基线为准，不以你刚读到的锚点为准/, '注入语必须点明优先级，否则新旧内容会打架')

    assert.ok(existsSync(probePath), '旧实现只写闭包 state；新实现必须留下文件证据')
    const probeRows = readFileSync(probePath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
    const reported = probeRows.findLast(
      (row) => row.kind === 'pre-step' && row.driftOutcome === 'reported',
    )
    assert.ok(reported, '文件里必须记录进入漂移检查及 reported outcome')
    assert.equal(reported.hookCalled, true)
    assert.equal(reported.hasAgent, true)
    assert.equal(reported.hasSession, true)
    assert.equal(reported.decisionKind, 'enter')
    assert.equal(reported.enteredDrift, true)
    assert.equal(reported.g2Injected, true)
    assert.equal(typeof reported.instance, 'string')
    assert.equal(typeof reported.sessionRef, 'string')

    const status = await tool.execute({ action: 'status' }, { agent: { session: nextSession } })
    assert.match(status.text, /运行标记: g2-file-probe\/20261118\.3/)
    assert.match(status.text, /最近一次 pre-step（本实例）: complete/)
    assert.match(status.text, /drift=reported · injected=true/)

    // 同一个 turn 起点再跑一次：不重复刷
    const repeat = await runPreStep(harness.listeners.get('agent/pre-step'), {
      agent: { session: nextSession },
      turn: 2,
      step: 1,
    })
    assert.equal(repeat.messages.length, 1, '同一轮不重复提醒')
  } finally {
    if (previousProbePath === undefined) delete process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG
    else process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG = previousProbePath
    await rm(root, { recursive: true, force: true })
  }
})

test('G2 优先使用 pre-step turn/step，不因 agents 注册表不可见而静默跳过', async () => {
  const root = join(tmpdir(), `stage-handoff-g2-payload-${process.pid}-${Date.now()}`)
  const stageName = '261118-0000-payload-turn'
  const stageDir = join(root, stageName)
  const anchor = (includeConstraint) =>
    [
      '# payload turn',
      '',
      '## 下一步',
      '',
      '1. 跑 `node --test test/index.test.mjs`',
      '',
      '## 硬约束',
      '',
      ...(includeConstraint ? ['- [人工明确] 不删除任何 qcow2 镜像。'] : []),
      '',
    ].join('\n')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(join(stageDir, 'anchor.md'), anchor(true), 'utf8')
    const harness = fakeContext({ total: 100, withAgents: false })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    await tool.execute({ action: 'guard', stage: stageName }, { agent: agentWith([]) })

    await writeFile(join(stageDir, 'anchor.md'), anchor(false), 'utf8')
    const session = {
      id: 'payload-turn',
      seq: 1,
      surface: { nodes: [] },
      snapshotEvents: () => [],
    }
    const decision = await runPreStep(harness.listeners.get('agent/pre-step'), {
      turn: 1,
      step: 1,
      agent: { session },
    })
    assert.equal(
      decision.messages.length,
      2,
      'payload 已给出 turn=1/step=1 时，不应因为 agents 不可见而跳过 G2',
    )
    assert.match(
      decision.messages.at(-1)?.content?.[0]?.text ?? '',
      /基线记录不见了/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('G2 漂移提示不得吞掉同一轮已经到线的阶段收尾提醒（G2 回归）', async () => {
  const root = join(tmpdir(), `stage-handoff-g2-plus-reminder-${process.pid}-${Date.now()}`)
  const stageName = '261118-0000-both-notices'
  const stageDir = join(root, stageName)
  const anchor = (includeConstraint) =>
    [
      '# both notices',
      '',
      '## 下一步',
      '',
      '1. 跑 `node --test test/index.test.mjs`',
      '',
      '## 硬约束',
      '',
      ...(includeConstraint ? ['- [人工明确] 不删除任何 qcow2 镜像。'] : []),
      '',
    ].join('\n')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(join(stageDir, 'anchor.md'), anchor(true), 'utf8')
    const harness = fakeContext({ total: 350000 })
    applyWithLine(harness.ctx, { anchorRoot: root, notifyCooldownMs: 0 })
    const tool = harness.registeredTools[0]
    await tool.execute({ action: 'guard', stage: stageName }, { agent: agentWith([]) })
    await writeFile(join(stageDir, 'anchor.md'), anchor(false), 'utf8')

    const session = {
      id: 'g2-plus-reminder',
      seq: 0,
      surface: { nodes: [] },
      snapshotEvents: () => [],
    }
    const decision = await runPreStep(harness.listeners.get('agent/pre-step'), {
      agent: { session },
      turn: 1,
      step: 1,
    })
    assert.equal(
      decision.messages.length,
      3,
      '原有消息、G2 漂移提示、阶段收尾提醒必须同时保留',
    )
    const texts = decision.messages.slice(1).map((message) => message?.content?.[0]?.text ?? '')
    assert.ok(texts.some((text) => text.includes('基线记录不见了')), '必须保留漂移提示')
    assert.ok(texts.some((text) => text.includes('该进入阶段收尾了')), '必须保留到线提醒')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-step 文件诊断超过上限时轮转为 .1，主文件保持有界（G2 文件探针）', async () => {
  const root = join(tmpdir(), `stage-handoff-probe-rotate-${process.pid}-${Date.now()}`)
  const probePath = join(root, '.probe.jsonl')
  try {
    const writer = createBoundedJsonlWriter(probePath, 240)
    for (let index = 0; index < 20; index += 1) {
      await writer.append({ index, text: 'x'.repeat(80) })
    }
    assert.ok(existsSync(`${probePath}.1`), '超过 240 字节后必须生成 .1')
    assert.ok(readFileSync(probePath).length <= 240, '轮转后主文件不得超过上限')
    assert.ok(readFileSync(`${probePath}.1`).length <= 240, '轮转文件本身也必须满足上限')
  } finally {
    // Windows Node 20 can still be releasing the rotated file handle when the
    // assertion finishes. Bound the retry instead of turning a successful
    // writer test into a cleanup-only failure.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})

test('pre-step 文件诊断轮转后仍从 .1 读取最新匹配记录（G2 文件探针）', async () => {
  const root = join(tmpdir(), `stage-handoff-probe-read-old-${process.pid}-${Date.now()}`)
  const probePath = join(root, '.probe.jsonl')
  try {
    const first = { kind: 'pre-step', seq: 1, text: 'x'.repeat(40) }
    const second = { kind: 'noise', seq: 2, text: 'y'.repeat(40) }
    const firstBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`)
    const writer = createBoundedJsonlWriter(probePath, firstBytes + 5)
    await writer.append(first)
    await writer.append(second)

    assert.ok(existsSync(`${probePath}.1`), '测试前置条件：较早记录必须已轮转到 .1')
    assert.doesNotMatch(
      readFileSync(probePath, 'utf8'),
      /"kind":"pre-step"/,
      '主文件里已没有 pre-step，只有 .1 还保留它',
    )
    const latest = await writer.readLatest((row) => row?.kind === 'pre-step')
    assert.equal(latest?.seq, 1, '最新匹配记录在 .1 时不能被误报成从未记录')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-step 文件诊断的超大单条记录也必须服从硬上限（G2 文件探针）', async () => {
  const root = join(tmpdir(), `stage-handoff-probe-oversized-${process.pid}-${Date.now()}`)
  const probePath = join(root, '.probe.jsonl')
  try {
    const writer = createBoundedJsonlWriter(probePath, 160)
    await writer.append({ kind: 'pre-step', error: 'x'.repeat(4096) })

    assert.ok(existsSync(probePath), '超大记录应被摘要成一条有界记录，而不是完全丢失诊断能力')
    assert.ok(readFileSync(probePath).length <= 160, '单条记录超过预算时也不得把主文件撑破')
    const row = JSON.parse(readFileSync(probePath, 'utf8').trim())
    assert.equal(row.kind, 'pre-step')
    assert.equal(row.diagnosticTruncated, true)
    assert.ok(row.originalBytes > 160)
    // 单条超限是「降级写入」而不是写入失败：走 notice()，error() 仍应为空。
    assert.match(writer.notice() ?? '', /exceed|超过/i)
    assert.equal(writer.error(), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-step 文件诊断遇到循环引用时写入有界摘要而不是抛出', async () => {
  const root = join(tmpdir(), `stage-handoff-probe-cycle-${process.pid}-${Date.now()}`)
  const probePath = join(root, '.probe.jsonl')
  try {
    const writer = createBoundedJsonlWriter(probePath, 512)
    const record = { kind: 'pre-step', phase: 'error' }
    record.self = record
    await assert.doesNotReject(writer.append(record))
    const row = JSON.parse(readFileSync(probePath, 'utf8').trim())
    assert.equal(row.kind, 'pre-step')
    assert.equal(row.phase, 'error')
    assert.equal(row.diagnosticTruncated, true)
    assert.equal(row.serializationFailed, true)
    assert.match(writer.notice() ?? '', /序列化|serializ/i)
    assert.equal(writer.error(), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-step 文件诊断由同路径多个 writer 并发写入时仍保持上限和完整 JSONL', async () => {
  const root = join(tmpdir(), `stage-handoff-probe-concurrent-${process.pid}-${Date.now()}`)
  const probePath = join(root, '.probe.jsonl')
  try {
    const writers = Array.from({ length: 4 }, () => createBoundedJsonlWriter(probePath, 800))
    await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        writers[index % writers.length].append({
          kind: 'pre-step',
          instance: index % writers.length,
          seq: index,
          text: 'x'.repeat(24),
        }),
      ),
    )

    for (const file of [probePath, `${probePath}.1`]) {
      if (!existsSync(file)) continue
      assert.ok(readFileSync(file).length <= 800, `${file} 不得超过共享写入上限`)
      for (const line of readFileSync(file, 'utf8').trim().split(/\r?\n/)) {
        assert.doesNotThrow(() => JSON.parse(line), '并发追加不能制造交错或半行 JSON')
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('有界句柄读取在超过字节上限时只消费 max+1 字节并拒绝', async () => {
  const root = join(tmpdir(), `stage-handoff-bounded-read-${process.pid}-${Date.now()}`)
  const file = join(root, 'large.txt')
  try {
    await mkdir(root, { recursive: true })
    await writeFile(file, 'x'.repeat(4096), 'utf8')
    const handle = await open(file, 'r')
    try {
      await assert.rejects(
        readUtf8Bounded(handle, 1024, '测试文件'),
        /测试文件超过 1024 字节读取上限/,
      )
    } finally {
      await handle.close()
    }

    let consumed = 0
    const measuredHandle = /** @type {any} */ ({
      async read(buffer) {
        const bytesRead = Math.min(buffer.length, 4096 - consumed)
        buffer.fill(0x78, 0, bytesRead)
        consumed += bytesRead
        return { bytesRead }
      },
    })
    await assert.rejects(
      readUtf8Bounded(measuredHandle, 1024, '测试文件'),
      /测试文件超过 1024 字节读取上限/,
    )
    assert.equal(consumed, 1025)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-step 诊断读取拒绝现成符号链接（需要 SeCreateSymbolicLinkPrivilege）', async (t) => {
  // 这条只在「能创建符号链接」的环境里真正执行：Windows 需要管理员权限或开发者模式。
  // 它原本和下面那条「超上限」写在一起，于是**不需要任何特权的那半也被一起跳掉了** ——
  // 一个 skip 连累了无关的断言。两条现在分开，超上限那条在所有平台都跑。
  const root = join(tmpdir(), `stage-handoff-probe-read-guard-${process.pid}-${Date.now()}`)
  const target = join(root, 'target.jsonl')
  const probePath = join(root, '.probe.jsonl')
  try {
    await mkdir(root, { recursive: true })
    await writeFile(target, '{"kind":"pre-step"}\n', 'utf8')
    try {
      await symlink(target, probePath, 'file')
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOTSUP') {
        t.skip(`symlink unavailable: ${error.code}`)
        return
      }
      throw error
    }
    const linkedWriter = createBoundedJsonlWriter(probePath, 4096)
    await assert.rejects(
      linkedWriter.readLatest(() => true),
      /符号链接|链接/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-step 诊断读取拒绝超上限文件（不需要特权，所有平台都跑）', async () => {
  // 与上一条同源：读取守卫有两个拒绝理由（是链接 / 太大），这里测「太大」的那一半。
  // 它不需要任何特权，所以不该因为符号链接建不出来而缺席。
  const root = join(tmpdir(), `stage-handoff-probe-oversize-${process.pid}-${Date.now()}`)
  const probePath = join(root, '.probe.jsonl')
  try {
    await mkdir(root, { recursive: true })
    await writeFile(probePath, 'x'.repeat(4097), 'utf8')
    const oversizedWriter = createBoundedJsonlWriter(probePath, 4096)
    await assert.rejects(
      oversizedWriter.readLatest(() => true),
      /读取上限/,
      '超过上限必须拒绝，不能说「没有可用记录」',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-step 文件诊断拒绝硬链接目标，不能借日志写入覆盖锚点根外文件', async () => {
  const root = join(tmpdir(), `stage-handoff-probe-link-${process.pid}-${Date.now()}`)
  const probePath = join(root, '.probe.jsonl')
  const protectedPath = join(root, 'protected.txt')
  try {
    await mkdir(root, { recursive: true })
    await writeFile(protectedPath, 'must stay unchanged\n', 'utf8')
    await link(protectedPath, probePath)
    const writer = createBoundedJsonlWriter(probePath, 512)
    await writer.append({ kind: 'pre-step', text: 'diagnostic' })

    assert.equal(readFileSync(protectedPath, 'utf8'), 'must stay unchanged\n')
    assert.match(writer.error() ?? '', /硬链接|link/i)
    await assert.rejects(
      writer.readLatest(() => true),
      /硬链接|link/i,
      '只读诊断也不能跟随指向锚点根外的硬链接',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-step 文件诊断在首次写入之后被换成硬链接也必须拒绝', async () => {
  const root = join(tmpdir(), `stage-handoff-probe-link-late-${process.pid}-${Date.now()}`)
  const probePath = join(root, '.probe.jsonl')
  const protectedPath = join(root, 'protected.txt')
  try {
    await mkdir(root, { recursive: true })
    await writeFile(protectedPath, 'must stay unchanged\n', 'utf8')
    const writer = createBoundedJsonlWriter(probePath, 4096)
    // 第一次写入建立真实文件与字节基线；旧实现此后不再复查路径，
    // 于是「换链接」这一步会让后来的每条诊断都追加到根外文件。
    await writer.append({ kind: 'pre-step', seq: 1 })
    assert.equal(existsSync(probePath), true, '前置条件：首次写入必须已创建诊断文件')

    await rm(probePath)
    await link(protectedPath, probePath)
    await writer.append({ kind: 'pre-step', seq: 2 })

    assert.equal(
      readFileSync(protectedPath, 'utf8'),
      'must stay unchanged\n',
      '第二次追加也不能跟随硬链接写到根外',
    )
    assert.match(writer.error() ?? '', /硬链接|link/i, '链接拒绝必须留下可读原因')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-step 文件诊断遇到 BigInt 等不可序列化 payload 时不得打断会话（G2 文件探针）', async () => {
  const root = join(tmpdir(), `stage-handoff-probe-bigint-${process.pid}-${Date.now()}`)
  const probePath = join(root, '.probe.jsonl')
  const previousProbePath = process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG
  try {
    process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG = probePath
    const harness = fakeContext({ total: 100, withAgents: false })
    apply(harness.ctx, { anchorRoot: root })
    const decision = { kind: 'enter', messages: [{ id: 'original' }] }
    const session = {
      id: 'probe-bigint',
      seq: 1,
      surface: { nodes: [] },
      snapshotEvents: () => [],
    }

    const result = await runPreStep(harness.listeners.get('agent/pre-step'), {
      agent: { session },
      turn: /** @type {any} */ (1n),
      step: 1,
    })
    assert.deepEqual(
      result.messages,
      [{ id: 'existing' }],
      '诊断序列化失败不能改动 next() 的结果',
    )
    assert.ok(existsSync(probePath), '不可序列化字段不应把整个文件探针一起关掉')
  } finally {
    if (previousProbePath === undefined) delete process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG
    else process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG = previousProbePath
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-step 文件诊断会脱敏异常消息里的令牌与密码', async () => {
  const root = join(tmpdir(), `stage-handoff-probe-redact-${process.pid}-${Date.now()}`)
  const probePath = join(root, '.probe.jsonl')
  const previousProbePath = process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG
  try {
    process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG = probePath
    const harness = fakeContext({ total: 100, withAgents: false })
    apply(harness.ctx, { anchorRoot: root })
    const session = {
      id: 'probe-redact',
      seq: 1,
      surface: { nodes: [] },
      snapshotEvents: () => [],
    }

    await assert.rejects(
      harness
        .listeners.get('agent/pre-step')(
          {
            agent: { session },
            turn: 1,
            step: 1,
            signal: { aborted: false },
          },
          async () => {
            throw new Error(
              'api_key=sk-live-super-secret Authorization: Bearer abc.def.ghi password=hunter2',
            )
          },
        ),
      /sk-live-super-secret/,
      '原异常仍须原样传回宿主',
    )
    const content = readFileSync(probePath, 'utf8')
    assert.doesNotMatch(content, /sk-live-super-secret|abc\.def\.ghi|hunter2/)
    assert.match(content, /\[REDACTED\]/)
  } finally {
    if (previousProbePath === undefined) delete process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG
    else process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG = previousProbePath
    await rm(root, { recursive: true, force: true })
  }
})

test('G2 在 v3 基线结构损坏时归类 baseline-format，不伪造漂移（G2 回归）', async () => {
  const root = join(tmpdir(), `stage-handoff-g2-bad-baseline-${process.pid}-${Date.now()}`)
  const probePath = join(root, '.stage-handoff-prestep.jsonl')
  const previousProbePath = process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG
  const stageName = '261118-0000-bad-baseline'
  const stageDir = join(root, stageName)
  try {
    process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG = probePath
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      ['# bad baseline', '', '## 硬约束', '', '- [人工明确] 不删除任何 qcow2 镜像。', ''].join(
        '\n',
      ),
      'utf8',
    )
    await writeFile(
      join(stageDir, '.anchor-guard.json'),
      JSON.stringify({ version: 3, constraints: 'not-an-array', rejections: [] }),
      'utf8',
    )

    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const session = {
      id: 'bad-baseline',
      seq: 1,
      surface: { nodes: [] },
      snapshotEvents: () => [],
    }
    const decision = await runPreStep(harness.listeners.get('agent/pre-step'), {
      agent: { session },
      turn: 1,
      step: 1,
    })
    assert.equal(decision.messages.length, 1, '损坏基线不能制造一条假的硬约束漂移')
    const rows = readFileSync(probePath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
    assert.equal(rows.at(-1)?.driftOutcome, 'baseline-format')
  } finally {
    if (previousProbePath === undefined) delete process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG
    else process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG = previousProbePath
    await rm(root, { recursive: true, force: true })
  }
})

test('G2 把未知 v3 guard 来源标签归类 baseline-format', async () => {
  const root = join(tmpdir(), `stage-handoff-g2-bad-tag-${process.pid}-${Date.now()}`)
  const probePath = join(root, '.stage-handoff-prestep.jsonl')
  const previousProbePath = process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG
  const stageName = '261118-0000-bad-tag'
  const stageDir = join(root, stageName)
  try {
    process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG = probePath
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      ['# bad tag', '', '## 硬约束', '', '- [人工明确] 不删除任何 qcow2 镜像。', ''].join(
        '\n',
      ),
      'utf8',
    )
    await writeFile(
      join(stageDir, '.anchor-guard.json'),
      JSON.stringify({
        version: 3,
        constraints: [
          {
            text: '不删除任何 qcow2 镜像。',
            sourceTags: ['伪造来源'],
            statusTags: [],
          },
        ],
        rejections: [],
      }),
      'utf8',
    )

    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const session = {
      id: 'bad-tag',
      seq: 1,
      surface: { nodes: [] },
      snapshotEvents: () => [],
    }
    const decision = await runPreStep(harness.listeners.get('agent/pre-step'), {
      agent: { session },
      turn: 1,
      step: 1,
    })
    assert.equal(decision.messages.length, 1, '未知 tag 不能制造一条假的硬约束漂移')
    const rows = readFileSync(probePath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
    assert.equal(rows.at(-1)?.driftOutcome, 'baseline-format')
  } finally {
    if (previousProbePath === undefined) delete process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG
    else process.env.DSH_STAGE_HANDOFF_PRESTEP_LOG = previousProbePath
    await rm(root, { recursive: true, force: true })
  }
})

test('scaffold 在工具事实被截断时必须提示路径可能不完整（B4 回归）', async () => {
  // 截断会把路径砍短，砍出来的前缀不是一个真文件。不提示，下一阶段就会照抄
  // 去打开一个不存在的路径。触发条件是「单事件条目数超过 128」。
  const root = join(tmpdir(), `stage-handoff-trunc-${process.pid}-${Date.now()}`)
  try {
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const manyPaths = Array.from({ length: 130 }, (_, index) => `D:\\repo\\f${index}.ts`)
    const agent = {
      session: {
        id: 'tr',
        seq: 1,
        surface: { nodes: [] },
        snapshotEvents: () => [
          {
            seq: 0,
            type: 'tool/call',
            data: { name: 'fs_multi', arguments: JSON.stringify({ paths: manyPaths }) },
          },
        ],
      },
    }
    await harness.registeredTools[0].execute({ action: 'scaffold', topic: 'trunc' }, { agent })
    const created = (await readdir(root))
      .filter((name) => /^\d{6}-\d{4}-trunc$/.test(name))
      .map((name) => join(root, name))[0]
    assert.ok(created, '应创建出新阶段目录')
    const skeleton = readFileSync(join(created, 'anchor.md'), 'utf8')
    assert.match(skeleton, /已被截断/, '截断后必须在骨架里提示路径可能不完整')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scaffold 必须区分「改过」和「只读过」的文件（G4 回归）', async () => {
  // 只给一堆路径而不说动作类型，下一阶段分不清哪个该重读、哪个已经改完。
  // artifact trail 恰恰是摘要天生保不住的东西。
  const root = join(tmpdir(), `stage-handoff-artifact-${process.pid}-${Date.now()}`)
  try {
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const agent = {
      session: {
        id: 'sa',
        seq: 3,
        surface: { nodes: [] },
        snapshotEvents: () => [
          {
            seq: 1,
            type: 'tool/call',
            data: { name: 'fs_edit', arguments: JSON.stringify({ path: 'D:\\repo\\written.ts' }) },
          },
          {
            seq: 2,
            type: 'tool/call',
            data: { name: 'fs_read', arguments: JSON.stringify({ path: 'D:\\repo\\read-only.ts' }) },
          },
        ],
      },
    }
    await harness.registeredTools[0].execute({ action: 'scaffold', topic: 'artifact' }, { agent })
    const created = (await readdir(root))
      .filter((name) => /^\d{6}-\d{4}-artifact$/.test(name))
      .map((name) => join(root, name))[0]
    assert.ok(created, '应创建出新阶段目录')
    const skeleton = readFileSync(join(created, 'anchor.md'), 'utf8')
    assert.match(skeleton, /written\.ts（本次改过）/, '写过的文件必须标成改过')
    assert.match(skeleton, /read-only\.ts（只读过）/, '只读的文件不能被标成改过')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate：下一步与不能丢的事实重复时报警', async () => {
  const root = join(tmpdir(), `stage-handoff-validate-dup-${process.pid}-${Date.now()}`)
  const stageDir = join(root, '261116-0000-dup')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      [
        '# dup 锚点',
        '',
        '## 硬约束',
        '- [实测] 部署后必须重启',
        '',
        '## 不能丢的事实',
        '- 跑 node --test 确认全绿',
        '',
        '## 下一步',
        '1. 跑 node --test 确认全绿',
        '',
      ].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute({ action: 'validate' }, { agent: agentWith([]) })
    assert.match(result.text, /完全相同/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('guard 基线超过 guardMaxBytes 时拒绝写入，而不是写一个读不回的文件', async () => {
  // bug-hunt P2-6：写入无上限、读取有上限会自锁；validate 还会建议重跑 guard（无效）。
  const root = join(tmpdir(), `stage-handoff-guard-cap-${process.pid}-${Date.now()}`)
  const stageName = '261116-0000-guard-cap'
  const dir = join(root, stageName)
  try {
    await mkdir(dir, { recursive: true })
    const lines = ['# cap 锚点', '', '## 硬约束', '']
    // 100 KB 锚点 + 64 KiB 上限：锚点可读，但生成的基线会超过上限。
    for (let let_i = 0; let_i < 200; let_i += 1) {
      lines.push(`- [实测] 约束 ${let_i} ${'x'.repeat(480)}`)
    }
    await writeFile(join(dir, 'anchor.md'), lines.join('\n'), 'utf8')
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root, guardMaxBytes: 65_536 })
    const result = await harness.registeredTools[0].execute(
      { action: 'guard' },
      { agent: agentWith([]) },
    )
    assert.match(result.text, /拒绝写基线/)
    assert.match(result.text, /guardMaxBytes/)
    // 关键：不能留下一个「写得出、读不回」的基线文件。
    await assert.rejects(open(join(dir, '.anchor-guard.json'), 'r'), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('guard + validate：删掉一条硬约束必须被基线对比抓到', async () => {
  const root = join(tmpdir(), `stage-handoff-guard-${process.pid}-${Date.now()}`)
  const stageName = '261116-0000-guard'
  const dir = join(root, stageName)
  try {
    await mkdir(dir, { recursive: true })
    const withTwo = [
      '# guard 锚点',
      '',
      '## 硬约束',
      '- [实测 261116] 部署后必须重启宿主',
      '- [人工明确] 不许动 compaction-basic 配置',
      '',
      '## 决策与否决',
      '- [否决] 换掉 harness 自带搜索',
      '',
      '## 下一步',
      '1. 跑 `node --test` 确认全绿',
      '',
    ].join('\n')
    await writeFile(join(dir, 'anchor.md'), withTwo, 'utf8')

    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]

    // 1. 建立基线
    const guarded = await tool.execute({ action: 'guard', stage: stageName }, { agent: agentWith([]) })
    assert.match(guarded.text, /已建立基线/)
    assert.match(guarded.text, /硬约束 2 条/)
    assert.match(guarded.text, /否决 1 条/)
    assert.ok(existsSync(join(dir, '.anchor-guard.json')), '基线文件必须落盘')

    // 2. 未改动时，validate 应报「与基线一致」
    const clean = await tool.execute({ action: 'validate', stage: stageName }, { agent: agentWith([]) })
    assert.match(clean.text, /与基线一致/)

    // 3. 偷偷删掉一条硬约束 —— 这是受控写入要防的那件事
    await writeFile(
      join(dir, 'anchor.md'),
      withTwo.replace('- [人工明确] 不许动 compaction-basic 配置\n', ''),
      'utf8',
    )
    const caught = await tool.execute({ action: 'validate', stage: stageName }, { agent: agentWith([]) })
    assert.match(caught.text, /硬约束与基线不一致/, '删硬约束必须被抓到')
    assert.match(caught.text, /少了 1 条基线原文/, '报告必须说明少了一次出现')
    assert.match(caught.text, /不许动 compaction-b/, '报告要能指认是哪一条')

    // 4. 删掉否决行也要抓到
    await writeFile(join(dir, 'anchor.md'), withTwo.replace('- [否决] 换掉 harness 自带搜索\n', ''), 'utf8')
    const caughtRejection = await tool.execute({ action: 'validate', stage: stageName }, { agent: agentWith([]) })
    assert.match(caughtRejection.text, /\[否决\] 多重集与基线不一致/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('guard 改字场景同时报「少了」与「多了」，而不是只说少 1 次', async () => {
  const root = join(tmpdir(), `stage-handoff-guard-wording-${process.pid}-${Date.now()}`)
  const stageName = '261118-0000-wording'
  const dir = join(root, stageName)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'anchor.md'),
      ['# 锚点', '', '## 硬约束', '- [人工明确] 不重启 DSH', '', '## 下一步', '1. 跑 `node --test`', ''].join(
        '\n',
      ),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    const guarded = await tool.execute({ action: 'guard', stage: stageName }, { agent: agentWith([]) })
    assert.match(guarded.text, /已建立基线/)

    // 只改几个字：条目总数不变，但原文不再匹配基线。
    await writeFile(
      join(dir, 'anchor.md'),
      ['# 锚点', '', '## 硬约束', '- [人工明确] 不重启 DSH 服务', '', '## 下一步', '1. 跑 `node --test`', ''].join(
        '\n',
      ),
      'utf8',
    )
    const caught = await tool.execute({ action: 'validate', stage: stageName }, { agent: agentWith([]) })
    assert.match(caught.text, /硬约束与基线不一致/)
    assert.match(caught.text, /少了 1 条基线原文/)
    assert.match(caught.text, /多了 1 条基线里没有的原文/, '改字必须同时报出新增的那一条')
    assert.match(caught.text, /新增 /, '要指认新增的原文')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recall 命中标题行本身并标注「章节标题」', async () => {
  const root = join(tmpdir(), `stage-handoff-recall-heading-${process.pid}-${Date.now()}`)
  const stageName = '261118-0000-heading'
  try {
    await mkdir(join(root, stageName), { recursive: true })
    await writeFile(
      join(root, stageName, 'anchor.md'),
      ['# 测试锚点', '', '一句话交接：执行下一步。', '', '## 下一步', '1. 跑 `node --test`', ''].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'recall', query: '下一步' },
      { agent: agentWith([]) },
    )
    assert.match(result.text, /2 条含「下一步」/, '标题行也要算命中')
    assert.match(result.text, /章节标题/, '标题命中要标注它是章节标题')
    assert.match(result.text, /## 下一步/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate 对抗性：缺整节、错级标题、空下一步都必须报出来', async () => {
  const root = join(tmpdir(), `stage-handoff-validate-adv-${process.pid}-${Date.now()}`)
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, { anchorRoot: root })
  const tool = harness.registeredTools[0]
  const probe = async (name, body) => {
    const dir = join(root, name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'anchor.md'), body, 'utf8')
    return (await tool.execute({ action: 'validate', stage: name }, { agent: agentWith([]) })).text
  }
  try {
    // 1. 完全没有 `## 硬约束` 这一节：现在的实现只在「有这一节但条目没标来源」时报警，
    //    整节缺失是更严重的情况，必须也报。
    const noConstraints = await probe(
      '261116-0000-noc',
      ['# noc', '', '## 下一步', '1. 跑 `node --test`', ''].join('\n'),
    )
    assert.match(noConstraints, /缺少 `## 硬约束`/, '整节缺失必须报出来')

    // 2. 用 `### 下一步`（三级标题）：sectionLines 只认 `##`，应报缺少该节
    const wrongLevel = await probe(
      '261116-0000-lvl',
      ['# lvl', '', '## 硬约束', '- [实测 261116] x', '', '### 下一步', '1. 跑 `node --test`', ''].join('\n'),
    )
    assert.match(wrongLevel, /缺少 `## 下一步`/, '错级标题必须报出来')

    // 3. `## 下一步` 下只有一行说明、没有编号步骤
    const emptySteps = await probe(
      '261116-0000-emp',
      ['# emp', '', '## 硬约束', '- [实测 261116] x', '', '## 下一步', '（待补）', ''].join('\n'),
    )
    assert.match(emptySteps, /下一步/, '空下一步必须报出来')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('find-session：带路径分隔符或 .. 的 session 参数不许跳出会话存储根', async () => {
  // 修的是一个真实穿越：forms 里同时放了原始值和 encodeSessionSegment 的结果，
  // 原始值直接进 join()，所以 wanted="../../../outside" 会让 join 跳出 sessions 根。
  const dshHome = join(tmpdir(), `stage-handoff-traversal-${process.pid}-${Date.now()}`)
  const sessionsRoot = join(dshHome, 'sessions')
  const outside = join(dshHome, 'outside')
  const secret = join(outside, 'session-9999')
  try {
    await mkdir(join(sessionsRoot, 'some-cwd'), { recursive: true })
    await mkdir(secret, { recursive: true })
    await writeFile(join(secret, 'session.v4.jsonl'), 'x', 'utf8')

    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { dshHome })
    const tool = harness.registeredTools[0]

    for (const evil of ['../../outside', '..\\..\\outside', '..']) {
      const result = await tool.execute({ action: 'find-session', session: evil }, { agent: agentWith([]) })
      // 只断言「有没有真的列出根外那个会话目录」。不要断言 `/outside/` ——
      // 参数回显里就带着这几个字，那样测的是回显而不是穿越。
      assert.doesNotMatch(
        result.text,
        /session-9999/,
        `参数 ${JSON.stringify(evil)} 泄漏了 sessions 根目录之外的会话`,
      )
      assert.doesNotMatch(
        result.text,
        /session\.v4\.jsonl/,
        `参数 ${JSON.stringify(evil)} 读到了根目录之外的文件`,
      )
    }
  } finally {
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('pre-step：measure 抛错时本轮跳过提醒，决策原样返回，不让会话失败', async () => {
  // 提醒是附加价值，但 pre-step 跑在**每一步**的路径上。
  // 任何一处抛错都会让该会话每一步都失败 —— 这个代价不可接受。
  const harness = fakeContext({ total: 500000, measureThrows: true })
  apply(harness.ctx, { anchorRoot: join(tmpdir(), `stage-handoff-guard-ps-${Date.now()}`) })
  const handler = harness.listeners.get('agent/pre-step')
  assert.ok(handler, '必须注册了 pre-step')

  const originalMessages = [{ id: 'm1' }]
  const decision = { kind: 'enter', messages: originalMessages }
  const session = {
    id: 's-err',
    seq: 3,
    surface: { nodes: [] },
    snapshotEvents: () => [],
  }
  const result = await handler(
    { agent: { session }, step: 1, signal: { aborted: false } },
    async () => decision,
  )
  // 决策必须原样返回：没有多出提醒，也没有被吞成 undefined
  assert.equal(result.kind, 'enter')
  assert.deepEqual(result.messages, originalMessages, '提醒失败时不该改动决策内容')
})

test('提醒消息构造失败不消耗 lastNotified，下一 pre-step 仍会重试', async () => {
  const harness = fakeContext({ total: 350000 })
  applyWithLine(harness.ctx)
  let attempts = 0
  harness.ctx.loader.internal.import = async (specifier) => {
    if (specifier === '@deepseek-ai/dsh-compaction') return {}
    return {
      createUserMessage(input) {
        attempts += 1
        if (attempts === 1) throw new Error('message factory failed')
        return { ...input, role: 'user', id: 'uuid-test' }
      },
    }
  }
  const listener = harness.listeners.get('agent/pre-step')
  const first = await runPreStep(listener)
  assert.equal(first.messages.length, 1, '构造失败时本轮原样跳过')

  const second = await runPreStep(listener)
  assert.equal(attempts, 2)
  assert.equal(second.messages.length, 2, '失败没有消费配额，下次仍应提醒')
})

test('pre-step：session 缺失或 signal 缺失时不抛错', async () => {
  const harness = fakeContext({ total: 500000 })
  apply(harness.ctx, { anchorRoot: join(tmpdir(), `stage-handoff-guard-ps2-${Date.now()}`) })
  const handler = harness.listeners.get('agent/pre-step')
  const decision = { kind: 'enter', messages: [] }
  // 完全没有 session、没有 signal
  const result = await handler({ step: 1 }, async () => decision)
  assert.equal(result.kind, 'enter')
  // decision.messages 不是数组时也要能兜住
  const weird = await handler({ agent: {}, step: 1, signal: { aborted: false } }, async () => ({
    kind: 'enter',
    messages: null,
  }))
  assert.equal(weird.kind, 'enter')
})

test('client.js 的 FALLBACK / FIELDS 必须覆盖 CONFIG_KEYS 的每个键，且默认值一致', async () => {
  // 这条防的是「面板漏字段」：漏了之后面板看不见也改不了，而「复制 YAML」
  // 只遍历 Object.keys(FALLBACK)，于是把那项配置**静默抹掉**。
  // 曾经就漏过 reportToolFacts 与 notifySkipWhenToolPending。
  // client.js 被 tsconfig exclude、也没有别的测试覆盖，所以这里单独守住。
  const clientPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
  const src = readFileSync(clientPath, 'utf8')
  const fallbackBlock = src.slice(
    src.indexOf('const FALLBACK = {'),
    src.indexOf('/** 字段元数据'),
  )
  assert.ok(fallbackBlock.length > 0, '必须能定位到 FALLBACK 定义')
  const fallbackKeys = [...fallbackBlock.matchAll(/^\s+(\w+):/gm)].map((m) => m[1])
  const fieldBlock = src.slice(src.indexOf('const FIELDS = ['), src.indexOf('const TABS'))
  assert.ok(fieldBlock.length > 0, '必须能定位到 FIELDS 定义')
  const fieldKeys = [...fieldBlock.matchAll(/key: '(\w+)'/g)].map((m) => m[1])

  const configKeys = [...CONFIG_KEYS]
  const missingInFallback = configKeys.filter((k) => !fallbackKeys.includes(k))
  const missingInFields = configKeys.filter((k) => !fieldKeys.includes(k))
  assert.deepEqual(missingInFallback, [], 'FALLBACK 必须覆盖每一个 CONFIG_KEYS 键')
  assert.deepEqual(missingInFields, [], 'FIELDS 必须覆盖每一个 CONFIG_KEYS 键')
  assert.deepEqual(
    fieldKeys.filter((k) => !fallbackKeys.includes(k)),
    [],
    'FIELDS 不该出现 FALLBACK 没有的键',
  )

  // 只比键还不够。`streamGuard: false` 曾经与 `DEFAULT_STREAM_GUARD = true` 相反，
  // 而只读面板与「恢复默认」都以 FALLBACK 为准 —— 于是同一张卡上既显示「开启」
  // 又写着「默认关闭」，还说那是「与代码一致的默认值」。逐键比值才能钉住它。
  const defaults = resolveConfig({})
  /** FALLBACK 里用的是 JS 字面量，转成和 `JSON.stringify` 可比的形状。 */
  const asJson = (text) => {
    const single = /^'(.*)'$/.exec(text)
    return single === null ? text : JSON.stringify(single[1])
  }
  const wrongDefaults = []
  for (const match of fallbackBlock.matchAll(/^\s+(\w+):\s*(.+?),?\s*$/gm)) {
    const [, key, raw] = match
    if (!configKeys.includes(key)) continue
    const expected = JSON.stringify(defaults[key])
    const actual = asJson(raw.trim())
    if (actual !== expected) {
      wrongDefaults.push(`${key}: FALLBACK=${raw.trim()}，resolveConfig=${expected}`)
    }
  }
  assert.deepEqual(wrongDefaults, [], 'FALLBACK 的默认值必须与 resolveConfig({}) 逐键一致')

  // 文案也要跟默认值走。hint 里写「默认关闭」时，面板的开关状态与说明会互相矛盾，
  // 而只读面板还会额外宣称「当前展示与代码一致的默认值」。
  const guardStart = fieldBlock.indexOf("key: 'streamGuard'")
  assert.ok(guardStart >= 0, 'FIELDS 里必须有 streamGuard')
  const guardEnd = fieldBlock.indexOf("key: '", guardStart + 1)
  const guardHint = fieldBlock.slice(guardStart, guardEnd === -1 ? undefined : guardEnd)
  assert.doesNotMatch(
    guardHint,
    /默认关闭|Off by default/,
    'streamGuard 默认是开的，hint 不能写「默认关闭」',
  )
})

test('客户端 token 解析与 Host parseTokenCount 对同一用例表一致，不再静默四舍五入', () => {
  const helpers = clientParsingHelpers()
  const cases = [
    ['1.5', null],
    ['1.5k', 1536],
    ['.5k', 512],
    ['0', null],
    ['-1', null],
    ['1e5', null],
    ['400,000', null],
    ['400 000', null],
  ]
  for (const [input, expected] of cases) {
    assert.equal(helpers.parseTokenInput(input), expected, `client token: ${input}`)
    let server
    try {
      server = parseTokenCount(input, 1, 'test')
    } catch {
      server = null
    }
    assert.equal(server, expected, `Host token: ${input}`)
  }

  const integerCases = [
    ['1.5', null],
    ['1.5k', null],
    ['.5k', null],
    ['0', 0],
    ['-1', null],
    ['1e5', null],
    ['400,000', null],
    ['400 000', null],
  ]
  for (const [input, expected] of integerCases) {
    assert.equal(helpers.parseIntegerInput(input), expected, `client integer: ${input}`)
  }

  assert.equal(helpers.coerceNumericInput({ key: 'compactRetainTokens' }, '.5k'), 512)
  assert.equal(helpers.coerceNumericInput({ key: 'keepAnchorBackups' }, '1.5k'), null)
})

test('token 字符串：Host schema 接受 ⇔ parseTokenCount 能归一（小数必须带 k/m）', () => {
  const schemaIssues = (patch) =>
    /** @type {any} */ (Config['~standard'].validate(patch)).issues
  // 裸小数与「带单位的小数」曾经分属两个接受集：schema 放行 "1.5"，
  // parseTokenCount 却抛错 —— 装载期那一个异常会让整个插件不挂载。
  const cases = [
    '1.5',
    '0',
    '-1',
    '1e5',
    '400,000',
    '1.5k',
    '.5k',
    '300k',
    '1m',
    '400000',
    '1.3k',
    '0.5m',
    '0.0001k',
  ]
  for (const input of cases) {
    const acceptedBySchema = schemaIssues({ notifyTokens: input }) === undefined
    let parsed
    try {
      parsed = parseTokenCount(input, 1, 'notifyTokens')
    } catch {
      parsed = undefined
    }
    assert.equal(
      acceptedBySchema,
      parsed !== undefined,
      `schema 与 parser 必须对 ${JSON.stringify(input)} 给出同一个答案`,
    )
    if (parsed !== undefined) {
      assert.ok(
        Number.isInteger(parsed) && parsed > 0,
        `${JSON.stringify(input)} 必须归一为正整数`,
      )
    }
  }
  // 带单位的小数不再抛错：四舍五入到整数，接受集因此重合。
  assert.equal(parseTokenCount('1.3k', 1, 'notifyTokens'), 1331)
})

test('数值配置拒绝不安全整数与超上界的大值：schema 与 parser 同口径', () => {
  const schemaIssues = (patch) =>
    /** @type {any} */ (Config['~standard'].validate(patch)).issues
  // 2^53 与 1.8e308 都是「整数」，却会让提醒线 / 冷却事实上永久失效。
  const rejected = [2 ** 53, 1.7976931348623157e308, 1_000_000_001]
  for (const value of rejected) {
    assert.throws(() => resolveConfig({ notifyTokens: value }), /安全整数/)
    assert.throws(() => resolveConfig({ notifyCooldownMs: value }), /安全整数/)
    assert.notEqual(
      schemaIssues({ notifyTokens: value }),
      undefined,
      `schema 也必须拒绝 ${String(value)}`,
    )
    assert.notEqual(
      schemaIssues({ notifyCooldownMs: value }),
      undefined,
      `schema 也必须拒绝 ${String(value)}`,
    )
  }
  assert.throws(() => resolveConfig({ anchorLimitChars: 2 ** 60 }), /安全整数/)
  for (const value of ['1000000001', '976563k', '954m', '1024m']) {
    assert.throws(() => resolveConfig({ notifyTokens: value }), /正整数/)
    assert.notEqual(
      schemaIssues({ notifyTokens: value }),
      undefined,
      `schema 必须拒绝解析后超过上界的字符串 ${value}`,
    )
  }
  // 边界值本身仍然可用，大小写与单位写法不受影响。
  assert.equal(resolveConfig({ notifyTokens: 1_000_000_000 }).notifyTokens, 1_000_000_000)
  assert.equal(resolveConfig({ notifyTokens: '1000000000' }).notifyTokens, 1_000_000_000)
  assert.equal(resolveConfig({ notifyTokens: '976562k' }).notifyTokens, 999_999_488)
  assert.equal(resolveConfig({ notifyTokens: '1m' }).notifyTokens, 1_048_576)
  assert.equal(resolveConfig({ notifyCooldownMs: 0 }).notifyCooldownMs, 0)
  // 面板与 Host 用同一条上界：超出即 null，不会「输入框接受、保存时被拒」。
  const helpers = clientParsingHelpers()
  assert.equal(helpers.parseTokenInput('1000000000'), 1_000_000_000)
  assert.equal(helpers.parseTokenInput('1000000001'), null)
  assert.equal(helpers.parseTokenInput('9007199254740992'), null)
  assert.equal(helpers.parseIntegerInput('1000000001'), null)
  assert.equal(helpers.parseIntegerInput('9007199254740993'), null)
  assert.equal(helpers.coerceDuration('1000000000', 'ms'), 1_000_000_000)
  assert.equal(helpers.coerceDuration('1000000001', 'ms'), null)
  assert.equal(helpers.coerceDuration('16667', 'h'), null)
})

test('字段写入失败会恢复 snapshot 值并返回行内错误，不把 draft 留在未保存状态', () => {
  const helpers = clientParsingHelpers()
  let restored
  const accepted = helpers.settleFieldCommit(
    { ok: false, message: 'Host 拒绝了这次修改' },
    (message) => {
      restored = message
    },
  )
  assert.equal(accepted, false)
  assert.equal(restored, 'Host 拒绝了这次修改')

  let restoredOnSuccess = false
  assert.equal(
    helpers.settleFieldCommit({ ok: true }, () => {
      restoredOnSuccess = true
    }),
    true,
  )
  assert.equal(restoredOnSuccess, false)

  const clientSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'),
    'utf8',
  )
  assert.match(
    clientSource,
    /const result = await commit\(item\.key, next\)\s*settleFieldCommit\(result, restoreDraft\)/,
  )
  assert.match(clientSource, /return Promise\.resolve\(\)\s*\.then\(operation\)/)
  assert.match(clientSource, /const \[pending, setPending\] = useState\(\(\) => new Map\(\)\)/)
  assert.match(clientSource, /current\.get\(key\) !== token/)
})

test('collectToolFacts：结果是 newest-first，不排序也按「最近碰过」排列', () => {
  // 旧实现顺着日志遍历，Set 保留插入顺序，下游 slice(0,5) 就取到了**最旧**的文件。
  // 之前的测试在比较前调了 .sort()，正好把这个顺序问题掩盖住。
  const session = {
    seq: 6,
    snapshotEvents: () => [
      { seq: 1, type: 'tool/call', data: { arguments: JSON.stringify({ path: 'oldest.ts' }) } },
      { seq: 2, type: 'tool/call', data: { arguments: JSON.stringify({ path: 'middle.ts' }) } },
      { seq: 3, type: 'tool/call', data: { arguments: JSON.stringify({ path: 'newest.ts' }) } },
    ],
  }
  const facts = collectToolFacts(session, 5000, factsReaderFor(session))
  assert.deepEqual(facts.files, ['newest.ts', 'middle.ts', 'oldest.ts'], '必须 newest-first')
  assert.equal(facts.files[0], 'newest.ts', '第一条要是最近碰过的')
})

test('围栏代码块里的标题与列表不参与 validate，示例不会被当成真实步骤', async () => {
  // codex 探针复现过：锚点里贴一段「应该怎么写」的示例，围栏内的 `## 下一步`
  // 会被当成真实章节，示例里的 `1. echo ...` 被当成「下一步第一条」。
  const root = join(tmpdir(), `stage-handoff-fence-${process.pid}-${Date.now()}`)
  const stageDir = join(root, '261117-0000-fence')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      [
        '# fence',
        '',
        '## 硬约束',
        '- [实测 261117] 真约束',
        '',
        '## 下一步',
        '（下面是格式示例，不要执行）',
        '```markdown',
        '## 下一步',
        '1. echo this-is-an-example-only',
        '```',
        '',
      ].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'validate', stage: '261117-0000-fence' },
      { agent: agentWith([]) },
    )
    assert.doesNotMatch(
      result.text,
      /this-is-an-example-only/,
      '围栏里的示例步骤不该被当成真实下一步',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readLatestSummary：旧 migration-shaped 事件不能压过 seq 更新的原生摘要', () => {
  // codex 探针复现过：拼接后反向扫，任何 shaped 事件都会无条件优先，
  // 于是真实压缩之后 summary/reconcile 仍拿 migrate 时期那份过期摘要当「最近一次」。
  const session = {
    seq: 10,
    snapshotEvents: () => [
      // 更早的 migration-shaped（没有 type，只有 data.summary）
      { seq: 1, type: 'legacy/thing', data: { summary: [{ type: 'text', text: 'older migrated summary' }] } },
      // 更晚的真实压缩摘要
      {
        seq: 8,
        type: 'compaction/summary',
        data: { summary: [{ type: 'text', text: 'newer native summary' }] },
      },
    ],
  }
  const result = readLatestSummaryWindow(session, 5000, factsReaderFor(session))
  assert.match(result.summary, /newer native summary/, '必须取 seq 更大的原生摘要')
  assert.doesNotMatch(result.summary, /older migrated/, '不该被旧的 shaped 事件顶替')

  // 反过来：只有 shaped 时仍然能用
  const onlyShaped = {
    seq: 5,
    snapshotEvents: () => [
      { seq: 2, type: 'legacy/thing', data: { summary: [{ type: 'text', text: 'only shaped' }] } },
    ],
  }
  assert.match(
    readLatestSummaryWindow(onlyShaped, 5000, factsReaderFor(onlyShaped)).summary,
    /only shaped/,
  )
})

test('guard：两条同前 16 字的硬约束，删掉一条也必须被抓到', async () => {
  // codex 用探针复现过：16 字符签名碰撞时，删掉一条仍报「与基线一致」，
  // 这直接推翻了「误删不可能悄无声息」这条核心承诺。
  const root = join(tmpdir(), `stage-handoff-guard-collide-${process.pid}-${Date.now()}`)
  const stageName = '261117-0000-collide'
  const dir = join(root, stageName)
  const shared = 'ABCDEFGHIJKLMNOP' // 前 16 字完全相同
  try {
    await mkdir(dir, { recursive: true })
    const two = [
      '# collide',
      '',
      '## 硬约束',
      `- [实测 261117] ${shared} 第一条`,
      `- [实测 261117] ${shared} 第二条`,
      '',
      '## 下一步',
      '1. 跑 `node --test`',
      '',
    ].join('\n')
    await writeFile(join(dir, 'anchor.md'), two, 'utf8')
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]

    await tool.execute({ action: 'guard', stage: stageName }, { agent: agentWith([]) })
    // 基线里必须存完整文本、来源与状态标签
    const baseline = JSON.parse(readFileSync(join(dir, '.anchor-guard.json'), 'utf8'))
    assert.equal(baseline.version, 3, '基线必须带版本号')
    assert.ok(
      baseline.constraints.every(
        (entry) =>
          typeof entry.text === 'string' &&
          entry.text.length > 16 &&
          Array.isArray(entry.sourceTags) &&
          Array.isArray(entry.statusTags),
      ),
      '基线必须存完整规范化文本，否则同前缀的条目会互相顶替',
    )

    // 删掉第二条：完整文本比对必须发现
    await writeFile(join(dir, 'anchor.md'), two.replace(`- [实测 261117] ${shared} 第二条\n`, ''), 'utf8')
    const caught = await tool.execute({ action: 'validate', stage: stageName }, { agent: agentWith([]) })
    assert.match(caught.text, /硬约束与基线不一致/, '同前缀条目被删也必须抓到')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate：旧格式（version 1）的 guard 基线要报「需要升级」，不当作损坏也不误报', async () => {
  const root = join(tmpdir(), `stage-handoff-guard-v1-${process.pid}-${Date.now()}`)
  const stageName = '261117-0000-v1'
  const dir = join(root, stageName)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'anchor.md'),
      ['# v1', '', '## 硬约束', '- [实测 261117] 某条约束', '', '## 下一步', '1. 跑 `node --test`', ''].join('\n'),
      'utf8',
    )
    // 旧格式：没有 version，存的是 16 字签名
    await writeFile(
      join(dir, '.anchor-guard.json'),
      JSON.stringify({ createdAt: 'x', constraints: ['某条约束'], rejections: [] }),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'validate', stage: stageName },
      { agent: agentWith([]) },
    )
    assert.match(result.text, /旧格式/, '旧格式必须被识别出来')
    assert.match(result.text, /重跑一次 guard/, '要给出明确的升级动作')
    assert.doesNotMatch(result.text, /少了 \d+ 条硬约束/, '旧格式不该产生误报')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('guard：.anchor-guard.json 是硬链接时拒绝写入，不覆盖根外文件', async (t) => {
  // codex 的 hard-link 探针复现过：普通 writeFile 会截断链接目标。
  // 这里用「目标是普通文件但 nlink>1」来覆盖同一段判断，
  // 因为在同一个卷上手工造 hard link 才可靠，link() 在部分环境不可用。
  const root = join(tmpdir(), `stage-handoff-guard-link-${process.pid}-${Date.now()}`)
  const stageName = '261117-0000-link'
  const dir = join(root, stageName)
  const victim = join(root, 'victim.txt')
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'anchor.md'),
      ['# link', '', '## 硬约束', '- [实测 261117] 某条约束', '', '## 下一步', '1. 跑 `node --test`', ''].join('\n'),
      'utf8',
    )
    await writeFile(victim, 'ORIGINAL CONTENT', 'utf8')
    let linked = false
    try {
      await link(victim, join(dir, '.anchor-guard.json'))
      linked = true
    } catch {
      linked = false
    }
    if (!linked) {
      // 环境不支持 hard link：用 t.skip 标记，而不是 return（return 会被当成通过）。
      t.skip('当前文件系统不支持 hard link，无法验证链接拒绝')
      return
    }
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'guard', stage: stageName },
      { agent: agentWith([]) },
    )
    assert.match(result.text, /拒绝写基线/, '硬链接必须被拒绝')
    assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL CONTENT', '根外文件的内容不许被改动')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate：guard 基线文件损坏时明说损坏，不假装成「没有基线」', async () => {
  // 三态必须分清：没有基线 / 损坏 / 可用。
  // 全用 undefined 表示会把「损坏」报成「先跑一次 guard」，
  // 而 JSON.parse('null') 返回 null 会穿过 === undefined 判断直接 TypeError。
  const root = join(tmpdir(), `stage-handoff-guard-broken-${process.pid}-${Date.now()}`)
  const stageDir = join(root, '261116-0000-broken')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      ['# broken', '', '## 硬约束', '- [实测 261117] x', '', '## 下一步', '1. 跑 `node --test`', ''].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]

    for (const [label, content] of [
      ['语法坏了', '{ not json'],
      ['是 null', 'null'],
      ['是字符串', '"abc"'],
      ['缺数组字段', '{"createdAt":"x"}'],
    ]) {
      await writeFile(join(stageDir, '.anchor-guard.json'), content, 'utf8')
      const result = await tool.execute({ action: 'validate', stage: '261116-0000-broken' }, { agent: agentWith([]) })
      assert.match(result.text, /guard 基线读不出来/, `${label} 必须报「读不出来」`)
      assert.doesNotMatch(
        result.text,
        /没有 guard 基线/,
        `${label} 不该被说成「没有基线」—— 那会误导用户以为从没建过`,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate：带日期的来源标签 [实测 261117] 也算标了来源', async () => {
  // 实测撞到的误报：锚点里 5 条约束全写成 `[实测 261117]`，validate 报「3 条没标来源」，
  // 因为旧正则只认不带日期的 `[实测]`。
  const root = join(tmpdir(), `stage-handoff-validate-datetag-${process.pid}-${Date.now()}`)
  const stageDir = join(root, '261117-0000-dt')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      [
        '# dt 锚点',
        '',
        '## 硬约束',
        '- [实测 261117] 改 host 代码后必须重启',
        '- [人工明确] 不许动 compaction-basic 配置',
        '- [推断未验证 261117] 这个判断没有实测支撑',
        '',
        '## 下一步',
        '1. 跑 `node --test`',
        '',
      ].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'validate', stage: '261117-0000-dt' },
      { agent: agentWith([]) },
    )
    assert.doesNotMatch(result.text, /没标来源/, '带日期的标签必须被认作已标来源')
    assert.match(result.text, /硬约束全部标了来源/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate：缺下一步、约束没标来源时逐条报出，且不修改文件', async () => {
  const root = join(tmpdir(), `stage-handoff-validate-${process.pid}-${Date.now()}`)
  const stageDir = join(root, '261116-0000-bad')
  try {
    await mkdir(stageDir, { recursive: true })
    const anchorPath = join(stageDir, 'anchor.md')
    const bad = ['# bad 锚点', '', '## 硬约束', '- 不许动 compaction-basic 配置', ''].join('\n')
    await writeFile(anchorPath, bad, 'utf8')
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'validate' },
      { agent: agentWith([]) },
    )
    assert.match(result.text, /缺少 `## 下一步`/)
    assert.match(result.text, /没有一条标了来源/)
    assert.match(result.text, /没有修正|只报告/)
    // 只报告，不许改文件
    assert.equal(readFileSync(anchorPath, 'utf8'), bad)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate：结构齐全的锚点报「没有发现问题」', async () => {
  const root = join(tmpdir(), `stage-handoff-validate-ok-${process.pid}-${Date.now()}`)
  const stageDir = join(root, '261116-0000-good')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      [
        '# good 锚点',
        '',
        '## 硬约束',
        '- [人工明确] 不许动 compaction-basic 配置',
        '',
        '## 决策与否决',
        '- [有效] 压缩保留量留在 97085',
        '- [推断未验证] 这条系统提示可能只对手动调用生效',
        '',
        '## 下一步',
        '1. 打开 `docs/anchors/x/detail/y.md`，把 Z 补上',
        '',
      ].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'validate' },
      { agent: agentWith([]) },
    )
    assert.match(result.text, /没有发现问题/)
    assert.match(result.text, /下一步第一条带路径或命令/)
    assert.match(result.text, /硬约束全部标了来源/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate：标题带后缀（`## 下一步（有序）`）时仍能识别该节', async () => {
  const root = join(tmpdir(), `stage-handoff-validate-suffix-${process.pid}-${Date.now()}`)
  const stageDir = join(root, '261116-0000-suffix')
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(
      join(stageDir, 'anchor.md'),
      [
        '# suffix 锚点',
        '',
        '## 硬约束（不许动的东西）',
        '- [人工明确] 不许动 compaction-basic 配置',
        '',
        '## 下一步（有序）',
        '1. 跑 `node --test` 确认全绿',
        '',
      ].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'validate' },
      { agent: agentWith([]) },
    )
    // 带后缀的标题必须被识别，否则会误报「缺少 ## 下一步」
    assert.doesNotMatch(result.text, /缺少 `## 下一步`/)
    assert.match(result.text, /下一步第一条带路径或命令/)
    assert.match(result.text, /硬约束全部标了来源/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scaffold：同名阶段目录已存在时拒绝覆盖', async () => {
  const root = join(tmpdir(), `stage-handoff-dup-${process.pid}-${Date.now()}`)
  const originalDate = globalThis.Date
  const fixedNow = new originalDate(2026, 0, 2, 3, 4, 5, 678)
  globalThis.Date = /** @type {DateConstructor} */ (
    new Proxy(originalDate, {
      construct(target, args, newTarget) {
        return Reflect.construct(
          target,
          args.length === 0 ? [fixedNow.getTime()] : args,
          newTarget,
        )
      },
      get(target, property, receiver) {
        if (property === 'now') return () => fixedNow.getTime()
        return Reflect.get(target, property, receiver)
      },
    })
  )
  try {
    // 固定时钟让占位目录与 scaffold 使用同一分钟。除了跨分钟假阳性，
    // POSIX rename 还会用新目录替换“空的同名目录”；这里要求跨平台都拒绝。
    const pad = (value) => String(value).padStart(2, '0')
    const now = fixedNow
    const stamp =
      String(now.getFullYear()).slice(-2) +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      '-' +
      pad(now.getHours()) +
      pad(now.getMinutes())
    await mkdir(join(root, `${stamp}-dup`), { recursive: true })

    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    const result = await tool.execute({ action: 'scaffold', topic: 'dup' }, { agent: agentWith([]) })
    assert.match(result.text, /已经存在同名阶段目录，不覆盖/)
    assert.deepEqual(
      await readdir(join(root, `${stamp}-dup`)),
      [],
      '既有空目录必须保持原样，不能被 POSIX rename 替换',
    )
    assert.deepEqual(await readdir(root), [`${stamp}-dup`], '失败或冲突不得留下临时目录')
  } finally {
    globalThis.Date = originalDate
    await rm(root, { recursive: true, force: true })
  }
})

test('scaffold：anchorRoot 位置被普通文件占住时明确拒绝，不抛裸 EEXIST', async () => {
  const root = join(tmpdir(), `stage-handoff-file-root-${process.pid}-${Date.now()}`)
  try {
    await mkdir(root, { recursive: true })
    const fileRoot = join(root, 'anchors.txt')
    await writeFile(fileRoot, 'not a directory\n', 'utf8')

    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: fileRoot })
    const result = await harness.registeredTools[0].execute(
      { action: 'scaffold', topic: 'blocked' },
      { agent: agentWith([]) },
    )

    assert.match(result.text, /拒绝创建阶段/)
    assert.match(result.text, /不是目录/)
    assert.equal(readFileSync(fileRoot, 'utf8'), 'not a directory\n', '被占住的文件必须原样保留')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test(
  'scaffold：POSIX 崩溃遗留的空 reservation 由 stale sidecar 安全恢复',
  { skip: process.platform === 'win32' },
  async () => {
    const root = join(tmpdir(), `stage-handoff-reservation-recover-${process.pid}-${Date.now()}`)
    const originalDate = globalThis.Date
    const fixedNow = new originalDate(2026, 0, 2, 3, 4, 5, 678)
    globalThis.Date = /** @type {DateConstructor} */ (
      new Proxy(originalDate, {
        construct(target, args, newTarget) {
          return Reflect.construct(
            target,
            args.length === 0 ? [fixedNow.getTime()] : args,
            newTarget,
          )
        },
        get(target, property, receiver) {
          if (property === 'now') return () => fixedNow.getTime()
          return Reflect.get(target, property, receiver)
        },
      })
    )
    try {
      const pad = (value) => String(value).padStart(2, '0')
      const stamp =
        String(fixedNow.getFullYear()).slice(-2) +
        pad(fixedNow.getMonth() + 1) +
        pad(fixedNow.getDate()) +
        '-' +
        pad(fixedNow.getHours()) +
        pad(fixedNow.getMinutes())
      const stageName = `${stamp}-recover`
      const stageDir = join(root, stageName)
      const sidecar = join(root, `.${stageName}.stage-handoff-reservation.json`)
      await mkdir(stageDir, { recursive: true })
      await writeFile(
        sidecar,
        JSON.stringify({
          schemaVersion: 1,
          stageName,
          pid: 2147483647,
          token: '123e4567-e89b-42d3-a456-426614174000',
          createdAt: fixedNow.getTime() - 60_000,
        }),
        'utf8',
      )

      const harness = fakeContext({ total: 100 })
      apply(harness.ctx, { anchorRoot: root })
      const result = await harness.registeredTools[0].execute(
        { action: 'scaffold', topic: 'recover' },
        { agent: agentWith([]) },
      )
      assert.match(result.text, /已创建阶段目录/)
      assert.ok(existsSync(join(stageDir, 'anchor.md')), '恢复后必须重新发布完整阶段')
      assert.equal(
        existsSync(sidecar),
        false,
        '发布成功后不得留下 stale sidecar',
      )
    } finally {
      globalThis.Date = originalDate
      await rm(root, { recursive: true, force: true })
    }
  },
)

test(
  'scaffold：活动 PID 持有的 POSIX reservation 不得被第二实例删除',
  { skip: process.platform === 'win32' },
  async () => {
    const root = join(tmpdir(), `stage-handoff-reservation-active-${process.pid}-${Date.now()}`)
    const originalDate = globalThis.Date
    const fixedNow = new originalDate(2026, 0, 2, 3, 4, 5, 678)
    globalThis.Date = /** @type {DateConstructor} */ (
      new Proxy(originalDate, {
        construct(target, args, newTarget) {
          return Reflect.construct(
            target,
            args.length === 0 ? [fixedNow.getTime()] : args,
            newTarget,
          )
        },
        get(target, property, receiver) {
          if (property === 'now') return () => fixedNow.getTime()
          return Reflect.get(target, property, receiver)
        },
      })
    )
    try {
      const pad = (value) => String(value).padStart(2, '0')
      const stamp =
        String(fixedNow.getFullYear()).slice(-2) +
        pad(fixedNow.getMonth() + 1) +
        pad(fixedNow.getDate()) +
        '-' +
        pad(fixedNow.getHours()) +
        pad(fixedNow.getMinutes())
      const stageName = `${stamp}-active`
      const stageDir = join(root, stageName)
      const sidecar = join(root, `.${stageName}.stage-handoff-reservation.json`)
      await mkdir(stageDir, { recursive: true })
      await writeFile(
        sidecar,
        JSON.stringify({
          schemaVersion: 1,
          stageName,
          pid: process.pid,
          token: '123e4567-e89b-42d3-a456-426614174000',
          createdAt: fixedNow.getTime(),
        }),
        'utf8',
      )

      const harness = fakeContext({ total: 100 })
      apply(harness.ctx, { anchorRoot: root })
      const result = await harness.registeredTools[0].execute(
        { action: 'scaffold', topic: 'active' },
        { agent: agentWith([]) },
      )
      assert.match(result.text, /另一个 scaffold 仍在发布/)
      assert.equal(existsSync(sidecar), true, '活动 reservation 的 sidecar 必须保留')
      assert.deepEqual(await readdir(stageDir), [], '不可清理活动实例占用的空目录')
    } finally {
      globalThis.Date = originalDate
      await rm(root, { recursive: true, force: true })
    }
  },
)

test(
  'scaffold：已完成阶段只清理 stale sidecar，不删除阶段内容',
  { skip: process.platform === 'win32' },
  async () => {
    const root = join(tmpdir(), `stage-handoff-reservation-complete-${process.pid}-${Date.now()}`)
    const originalDate = globalThis.Date
    const fixedNow = new originalDate(2026, 0, 2, 3, 4, 5, 678)
    globalThis.Date = /** @type {DateConstructor} */ (
      new Proxy(originalDate, {
        construct(target, args, newTarget) {
          return Reflect.construct(
            target,
            args.length === 0 ? [fixedNow.getTime()] : args,
            newTarget,
          )
        },
        get(target, property, receiver) {
          if (property === 'now') return () => fixedNow.getTime()
          return Reflect.get(target, property, receiver)
        },
      })
    )
    try {
      const pad = (value) => String(value).padStart(2, '0')
      const stamp =
        String(fixedNow.getFullYear()).slice(-2) +
        pad(fixedNow.getMonth() + 1) +
        pad(fixedNow.getDate()) +
        '-' +
        pad(fixedNow.getHours()) +
        pad(fixedNow.getMinutes())
      const stageName = `${stamp}-complete`
      const stageDir = join(root, stageName)
      const sidecar = join(root, `.${stageName}.stage-handoff-reservation.json`)
      await mkdir(stageDir, { recursive: true })
      await writeFile(join(stageDir, 'anchor.md'), 'do not delete\n', 'utf8')
      await writeFile(
        sidecar,
        JSON.stringify({
          schemaVersion: 1,
          stageName,
          pid: 2147483647,
          token: '123e4567-e89b-42d3-a456-426614174000',
          createdAt: fixedNow.getTime() - 60_000,
        }),
        'utf8',
      )

      const harness = fakeContext({ total: 100 })
      apply(harness.ctx, { anchorRoot: root })
      const result = await harness.registeredTools[0].execute(
        { action: 'scaffold', topic: 'complete' },
        { agent: agentWith([]) },
      )
      assert.match(result.text, /已经存在同名阶段目录，不覆盖/)
      assert.equal(readFileSync(join(stageDir, 'anchor.md'), 'utf8'), 'do not delete\n')
      assert.equal(existsSync(sidecar), false, '完成阶段的 stale sidecar 应被清理')
    } finally {
      globalThis.Date = originalDate
      await rm(root, { recursive: true, force: true })
    }
  },
)

test('scaffold：任意 session ID 都不会破坏 Markdown 会话索引', async () => {
  const root = join(tmpdir(), `stage-handoff-session-escape-${process.pid}-${Date.now()}`)
  try {
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const agent = agentWith([])
    agent.session.id = 'team|one\nline`'

    await harness.registeredTools[0].execute(
      { action: 'scaffold', topic: 'escape' },
      { agent },
    )
    const [stage] = await readdir(root)
    const anchor = readFileSync(join(root, stage, 'anchor.md'), 'utf8')
    assert.match(anchor, /team\\\|one<br>line&#96;/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('anchorTimeZone：local / utc / ±偏移都能解析，非法值被拒', () => {
  assert.equal(resolveConfig({}).anchorTimeZone, 'local')
  assert.equal(resolveConfig({ anchorTimeZone: 'local' }).anchorTimeZone, 'local')
  // UTC 归一化成数字 0 —— 注意 0 是 falsy，下游必须靠 typeof 区分于 'local'。
  assert.equal(resolveConfig({ anchorTimeZone: 'utc' }).anchorTimeZone, 0)
  assert.equal(resolveConfig({ anchorTimeZone: 'UTC' }).anchorTimeZone, 0)
  assert.equal(resolveConfig({ anchorTimeZone: 'z' }).anchorTimeZone, 0)
  assert.equal(resolveConfig({ anchorTimeZone: '+8' }).anchorTimeZone, 480)
  assert.equal(resolveConfig({ anchorTimeZone: '-5' }).anchorTimeZone, -300)
  assert.equal(resolveConfig({ anchorTimeZone: '+05:30' }).anchorTimeZone, 330)
  assert.equal(resolveConfig({ anchorTimeZone: '+0530' }).anchorTimeZone, 330)
  assert.equal(resolveConfig({ anchorTimeZone: '-12' }).anchorTimeZone, -720)
  assert.equal(resolveConfig({ anchorTimeZone: '+14' }).anchorTimeZone, 840)
  assert.equal(resolveConfig({ anchorTimeZone: 330 }).anchorTimeZone, 330)

  for (const bad of ['asia/tokyo', '+15', '-13', '8', '+8:99', '+14:01', '-12:01', '']) {
    assert.throws(
      () => resolveConfig({ anchorTimeZone: bad }),
      /anchorTimeZone/,
      `应拒绝 ${JSON.stringify(bad)}`,
    )
  }
  const issues = (patch) => /** @type {any} */ (Config['~standard'].validate(patch)).issues
  for (const good of ['UTC', 'z', '+05:30', '+14', '-12', 330]) {
    assert.equal(
      issues({ anchorTimeZone: good }),
      undefined,
      `Host schema 应接受 ${JSON.stringify(good)}`,
    )
  }
})

test('anchorTimeZone：三位数字是分钟、四位/带冒号是时:分（面板与 Host 同口径）', () => {
  // 曾经的 bug：`-300` 被当成 `-3:00`，面板原样提交、Host 也读成 -180，
  // 于是阶段目录名差两个多小时，而输入框还显示 -300。
  assert.equal(resolveConfig({ anchorTimeZone: '-300' }).anchorTimeZone, -300)
  assert.equal(resolveConfig({ anchorTimeZone: '+300' }).anchorTimeZone, 300)
  assert.equal(resolveConfig({ anchorTimeZone: '-720' }).anchorTimeZone, -720)
  assert.equal(resolveConfig({ anchorTimeZone: '+840' }).anchorTimeZone, 840)
  assert.equal(resolveConfig({ anchorTimeZone: '-480' }).anchorTimeZone, -480)
  assert.equal(resolveConfig({ anchorTimeZone: '-0530' }).anchorTimeZone, -330)
  assert.equal(resolveConfig({ anchorTimeZone: '-5:30' }).anchorTimeZone, -330)
  // 三位数超出分钟范围时不能退化成「按小时读」。
  assert.throws(() => resolveConfig({ anchorTimeZone: '-845' }), /anchorTimeZone/)

  const panel = clientParsingHelpers().coerceTimeZone
  const cases = [
    ['-300', -300],
    ['+300', 300],
    ['-5', -300],
    ['+8', 480],
    ['+0530', 330],
    ['+05:30', 330],
    ['-0530', -330],
    ['-5:30', -330],
    ['-720', -720],
    ['+840', 840],
    ['330', 330],
    ['300分钟', 300],
    ['-800', null],
    ['+900', null],
    ['+14:01', null],
    ['-12:01', null],
    ['abc', null],
  ]
  for (const [input, expected] of cases) {
    assert.equal(panel(input), expected, `面板解析 ${JSON.stringify(input)}`)
    if (expected !== null) {
      // 面板提交的是数字；Host 必须原样接受同一个数，不能二次解释。
      assert.equal(
        resolveConfig({ anchorTimeZone: /** @type {any} */ (expected) }).anchorTimeZone,
        expected,
        `面板提交的数字必须被 Host 原样接受（${input}）`,
      )
    }
  }
  assert.equal(panel('local'), 'local')
  assert.equal(panel('UTC'), 'utc')
  assert.equal(panel('z'), 'z')
})

test('设置面板的时区下拉：选项覆盖常用偏移，且每个选项都能解析回同一个值', () => {
  const helpers = clientParsingHelpers()
  const rows = helpers.timeZoneOptions()
  const minutesOf = rows.map((row) => row.minutes).filter((value) => typeof value === 'number')

  // 整点必须齐全：UTC-12..UTC+14（含 0 点）；带分钟的真实偏移也必须齐全。
  // 这些偏移在 IANA 里是常态，只列整点等于把这些时区的用户赶去改 YAML。
  for (let hours = -12; hours <= 14; hours += 1) {
    assert.ok(minutesOf.includes(hours * 60), `下拉缺少 UTC${hours >= 0 ? '+' : ''}${hours}`)
  }
  const requiredMinuteOffsets = [
    -570, // 马克萨斯
    -210, // 纽芬兰
    210, // 伊朗
    270, // 阿富汗
    330, // 印度
    345, // 尼泊尔
    390, // 缅甸 / 科科斯
    525, // Eucla
    570, // 澳大利亚中部
    630, // Lord Howe
    765, // 查塔姆
    825, // 查塔姆夏令时
  ]
  for (const required of requiredMinuteOffsets) {
    assert.ok(minutesOf.includes(required), `下拉缺少 ${required} 分钟对应的带分钟时区`)
  }
  assert.equal(
    new Set(minutesOf).size,
    minutesOf.length,
    '同一个分钟偏移不能出现两次',
  )
  assert.equal(
    new Set(rows.map((row) => row.value)).size,
    rows.length,
    '同一个 value 不能出现两次（React key 会冲突）',
  )

  // UTC-01:00 的分钟数是 -60（两位数）；option value 必须是带冒号的形式，
  // 否则会被 coerceTimeZone 读成「-60 小时」。
  const minusOne = rows.find((row) => row.minutes === -60)
  assert.ok(minusOne !== undefined, '缺少 UTC-01:00')
  assert.equal(minusOne.value, '-1:00')

  for (const row of rows) {
    const parsed = helpers.coerceTimeZone(row.value)
    if (row.value === 'local' || row.value === 'utc') {
      assert.equal(parsed, row.value)
      continue
    }
    assert.equal(parsed, row.minutes, `选项 ${row.value} 必须解析成 ${row.minutes} 分钟`)
    // 标签要和分钟数一致，否则下拉显示 UTC+08:00 却存成别的偏移。
    const abs = Math.abs(row.minutes)
    const hh = String(Math.floor(abs / 60)).padStart(2, '0')
    const mm = String(abs % 60).padStart(2, '0')
    assert.equal(row.label, `UTC${row.minutes < 0 ? '-' : '+'}${hh}:${mm}`)
  }

  // 面板必须真的用下拉渲染这个字段，而不是把列表挂在文本框旁边。
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'),
    'utf8',
  )
  assert.match(
    source,
    /key: 'anchorTimeZone',[\s\S]{0,120}type: 'select'/,
    'anchorTimeZone 必须声明为 select 字段',
  )
  assert.match(source, /data-stage-handoff-select/, '缺少下拉的渲染分支')
})

test('设置面板的行内控件垂直居中，不再贴顶对齐', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'),
    'utf8',
  )
  // 右列是「输入框 / 单位下拉 / 开关 / 重置」，左列是「标题 + 说明 + 默认值」多行块。
  // 行用 align-items:start 时控件永远贴顶，截图里整列都显得没对齐。
  assert.match(
    source,
    /\[data-stage-handoff-row\]\{[^}]*align-items:center/,
    '行容器必须让左右两列垂直居中',
  )
  assert.doesNotMatch(
    source,
    /\[data-stage-handoff-row\]\{[^}]*align-items:start/,
    '行容器不能再用贴顶对齐',
  )
  // 控件行内部（输入框 + 下拉 + 重置按钮）也必须彼此居中。
  assert.match(source, /\[data-stage-handoff-control-line\]\{[^}]*align-items:center/)
  assert.match(source, /\[data-stage-handoff-duration\]\{[^}]*align-items:center/)
})

test('发布清单与会话锚点隔离：docs/anchors 既不进包也不进 git', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.ok(
    manifest.files.includes('!docs/anchors'),
    'package.json files 必须用 !docs/anchors 排除阶段锚点（含主机路径与会话 ID）',
  )
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8')
  assert.match(ignore, /^docs\/anchors\/$/m, '.gitignore 必须忽略 docs/anchors')
  // 打包校验脚本必须把 `!pattern` 当作排除项，而不是当作缺失的声明文件，
  // 并且真的断言锚点目录没进包。
  const testPackage = readFileSync(join(root, 'tools', 'Test-Package.ps1'), 'utf8')
  assert.match(testPackage, /-like '!\*'/, 'Test-Package 必须跳过 files 里的否定项')
  assert.match(testPackage, /docs\\anchors/, 'Test-Package 必须断言锚点目录没进包')
})

test('打包期望清单必须与 package.json files 推导出的集合一致', async () => {
  // 这一条替代的是「手抄清单会漂移」这个反复出现的失败：`lib/stream-guard.js` 与
  // `docs/FEEDBACK-…md` 加进包之后，`tools/Test-Package.ps1` 的清单仍是 26 项，
  // 于是 `tools\Pack.ps1` 在干净树上必然失败，而它是发版唯一的全量结构闸。
  // 判据从 `package.json` 的 `files` 推，不用再手抄一份。
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  const walk = async (dir, prefix) => {
    const out = []
    for (const child of await readdir(dir, { withFileTypes: true })) {
      const rel = `${prefix}${child.name}`
      if (child.isDirectory()) out.push(...(await walk(join(dir, child.name), `${rel}/`)))
      else if (child.isFile()) out.push(rel)
    }
    return out
  }
  const isDirectory = async (path) => {
    try {
      await readdir(path, { withFileTypes: true })
      return true
    } catch {
      return false
    }
  }

  const collected = []
  const excluded = []
  for (const entry of manifest.files) {
    if (entry.startsWith('!')) {
      excluded.push(entry.slice(1))
      continue
    }
    const target = join(root, entry)
    collected.push(...((await isDirectory(target)) ? await walk(target, `${entry}/`) : [entry]))
  }
  // npm 无条件带上 package.json，它不在 files 里但一定在产物里。
  collected.push('package.json')
  const expected = collected
    .filter((rel) => !excluded.some((skip) => rel === skip || rel.startsWith(`${skip}/`)))
    .sort()

  const script = readFileSync(join(root, 'tools', 'Test-Package.ps1'), 'utf8')
  const block = /\$expectedFiles = @\(([\s\S]*?)\n\s*\)/.exec(script)
  assert.ok(block !== null, 'Test-Package.ps1 里必须有 $expectedFiles 数组')
  const listed = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort()

  assert.deepEqual(
    listed.filter((rel) => !expected.includes(rel)),
    [],
    'Test-Package.ps1 的期望清单里有不会被打包的文件',
  )
  assert.deepEqual(
    expected.filter((rel) => !listed.includes(rel)),
    [],
    'Test-Package.ps1 的期望清单漏了会进包的文件',
  )
})

test('scaffold：时间戳按 anchorTimeZone 计算，而不是一律用本地时间', async () => {
  const root = join(tmpdir(), `stage-handoff-tz-${process.pid}-${Date.now()}`)
  // UTC 模式的预期值：自己按 UTC 字段拼一遍。允许跨分钟，所以前后各取一次。
  const utcStamp = () => {
    const d = new Date()
    const pad = (v) => String(v).padStart(2, '0')
    return (
      String(d.getUTCFullYear()).slice(-2) +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) +
      '-' +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes())
    )
  }
  try {
    const before = utcStamp()
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root, anchorTimeZone: 'utc' })
    const after = utcStamp()

    const tool = harness.registeredTools[0]
    await tool.execute({ action: 'scaffold', topic: 'tz' }, { agent: agentWith([]) })
    const dirs = await readdir(root)
    const stampPart = dirs[0].slice(0, 11)
    assert.ok(
      stampPart === before || stampPart === after,
      `UTC 模式下目录名应使用 UTC 时刻，实际 ${stampPart}，期望 ${before} 或 ${after}`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scaffold：topic 含路径分隔符或穿越时直接拒绝', async () => {
  const root = join(tmpdir(), `stage-handoff-bad-${process.pid}-${Date.now()}`)
  try {
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]

    for (const topic of ['../evil', 'a/b', '..', 'v1.', '']) {
      const result = await tool.execute({ action: 'scaffold', topic }, { agent: agentWith([]) })
      assert.ok(
        /不能用作目录名|需要 topic 参数/.test(result.text),
        `topic ${JSON.stringify(topic)} 应被拒绝，实际：${result.text}`,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('find-session：跨工作区 key 找到会话日志目录并报体积', async () => {
  const home = join(tmpdir(), `stage-handoff-home-${process.pid}-${Date.now()}`)
  const sessionId = 'session-test-1234'
  try {
    const dir = join(home, 'sessions', '--D-demo--', sessionId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x'.repeat(1024))

    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { dshHome: home })
    const tool = harness.registeredTools[0]
    const result = await tool.execute({ action: 'find-session', session: sessionId }, {
      agent: agentWith([]),
    })
    assert.match(result.text, /--D-demo--/)
    assert.match(result.text, /session\.v4\.jsonl\.zstd/)
    assert.match(result.text, /1\.0 kB/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('find-session：找不到时明说，而不是静默返回空', async () => {
  const home = join(tmpdir(), `stage-handoff-miss-${process.pid}-${Date.now()}`)
  try {
    await mkdir(join(home, 'sessions', '--D-demo--'), { recursive: true })
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { dshHome: home })
    const tool = harness.registeredTools[0]
    const result = await tool.execute({ action: 'find-session', session: 'session-nope' }, {
      agent: agentWith([]),
    })
    assert.match(result.text, /都没找到/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('find-session：任意 SessionId 都按 DSH 路径编码查找，不形成目录穿越', async () => {
  const home = join(tmpdir(), `stage-handoff-encoded-${process.pid}-${Date.now()}`)
  try {
    const workspaceKey = '--D-demo--'
    const wanted = 'team session/主体?~'
    const encoded = encodeSessionSegmentForTest(wanted)
    const dir = join(home, 'sessions', workspaceKey, encoded)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl'), 'x')

    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { dshHome: home })
    const result = await harness.registeredTools[0].execute(
      { action: 'find-session', session: wanted },
      { agent: agentWith([]) },
    )
    assert.match(result.text, /找到 1 处/)
    assert.ok(result.text.includes(encoded), '结果应展示编码后的安全目录名')
    assert.doesNotMatch(result.text, /遍历到会话存储之外/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('特殊字符 SessionId 能写入 anchor 表格并由 find-session 列回', async () => {
  const root = join(tmpdir(), `stage-handoff-session-roundtrip-${process.pid}-${Date.now()}`)
  const anchorRoot = join(root, 'anchors')
  const dshHome = join(root, 'home')
  const workspaceKey = '--D-roundtrip--'
  const sessionId = 'team|session/主体?~'
  const encoded = encodeSessionSegmentForTest(sessionId)
  try {
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot, dshHome })
    const agent = agentWith([])
    agent.session.id = sessionId

    await harness.registeredTools[0].execute(
      { action: 'scaffold', topic: 'roundtrip' },
      { agent },
    )
    const [stage] = await readdir(anchorRoot)
    const anchor = readFileSync(join(anchorRoot, stage, 'anchor.md'), 'utf8')
    assert.match(anchor, /team\\\|session\/主体\?~/)

    const sessionDir = join(dshHome, 'sessions', workspaceKey, encoded)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.v4.jsonl'), 'x')
    const found = await harness.registeredTools[0].execute(
      { action: 'find-session', session: sessionId },
      { agent },
    )
    assert.match(found.text, /找到 1 处/)
    assert.ok(found.text.includes(encoded))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('体积路由按全部活动工作区返回，不再猜测某个“当前” agent', async () => {
  const root = join(tmpdir(), `stage-handoff-workspaces-${process.pid}-${Date.now()}`)
  const workspaceA = join(root, 'project-a')
  const workspaceB = join(root, 'project b')
  try {
    for (const [workspace, size] of /** @type {const} */ ([
      [workspaceA, 10],
      [workspaceB, 20],
    ])) {
      const anchorDir = join(workspace, 'docs', 'anchors', '261116-demo')
      await mkdir(anchorDir, { recursive: true })
      await writeFile(join(anchorDir, 'anchor.md'), 'x'.repeat(size))
    }

    const agentA = agentWith([])
    const agentB = agentWith([])
    Object.assign(agentA.session, { header: { cwd: workspaceA } })
    Object.assign(agentB.session, { header: { cwd: workspaceB } })
    const harness = fakeContext({
      total: 100,
      agents: { list: () => [agentA, agentB] },
      withConnection: true,
    })
    apply(harness.ctx, undefined)
    assert.equal(harness.fetchRoutes.length, 1)

    const response = await harness.fetchRoutes[0].fetch(
      new Request('http://local.invalid/api/stage-handoff/usage'),
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.anchors.length, 2)
    assert.deepEqual(
      new Set(payload.anchors.map((row) => row.workspace)),
      new Set([workspaceA, workspaceB]),
    )
    assert.ok(payload.anchors.every((row) => row.anchor.exists === true))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('体积通道：host 注册的路由与 client 请求的是同一个绝对路径', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const indexSource = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
  const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // 直接比原始字符串，不给任何一边补前缀 —— 之前正是「两边都补 /api 再比」这个写法，
  // 把 host 漏写 /api 的错误掩盖成了一条绿测。
  const registered = /path: '(\/api\/stage-handoff\/usage)'/.exec(indexSource)
  assert.ok(registered !== null, 'host 必须注册带 /api 前缀的完整路径')
  const requested = /fetch\('(\/api\/stage-handoff\/usage)'/.exec(clientSource)
  assert.ok(requested !== null, 'client 必须向该路径取数')
  assert.equal(requested[1], registered[1])

  // 面板必须真的渲染这个摘要，否则注册了路由也没人看。
  assert.match(clientSource, /group\.group === '存储' \? h\(UsageSummary/)
  assert.match(clientSource, /Array\.isArray\(usage\?\.anchors\)/)
  // 多工作区时每条前面带序号；文案走 tf() 的占位符。
  assert.match(clientSource, /tf\('工作区 \{index\}', \{ index: index \+ 1 \}\)/)
  // 锚点目录必须以 agent 工作区为基准解析，不能用 host 的 process.cwd()。
  assert.match(indexSource, /agent\?\.session\?\.header\?\.cwd/)
  // 设置页没有会话身份，因此返回全部去重后的活动工作区，而不是猜某一个 agent。
  assert.match(indexSource, /workspaceCandidates\(state\.agents, state\.lastWorkspace\)/)
  assert.match(indexSource, /anchors: anchorRows/)
  assert.match(indexSource, /state\.lastWorkspace = workspace/)
  // 注册结局要能被 status 看见，否则 404 只能靠猜。
  assert.match(indexSource, /体积路由: \$\{state\.usageRoute\}/)
})

test('agentDecidesCompaction 默认只管提醒，设 false 时到线自动压缩', async () => {
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
    { seq: 4, tokens: 100 },
  ]
  const makeAgent = () =>
    agentWith([1, 2, 3, 4], {
      eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
    })
  const makeEngine = (sink) => ({
    async compactRegion(start, end) {
      sink.push([start, end])
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 5 }
    },
  })

  // 默认（true）：只提醒，引擎不该被碰。
  const manualCalls = []
  const manual = fakeContext({ total: 310, nodes, engine: makeEngine(manualCalls) })
  apply(manual.ctx, { notifyTokens: 100, compactRetainTokens: 150 })
  const manualDecision = await runPreStep(manual.listeners.get('agent/pre-step'), {
    agent: makeAgent(),
  })
  assert.equal(manualDecision.messages.length, 2, '默认应注入提醒')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(manualCalls.length, 0, 'agentDecidesCompaction 默认 true，不该自动压缩')

  // false：到线时 **pre-step 不压**，压缩改到 turn-stopping 做
  // （turn 仍开着，Host compactRegion 才能取得 current-turn owner）。
  const autoCalls = []
  const auto = fakeContext({ total: 310, nodes, engine: makeEngine(autoCalls) })
  apply(auto.ctx, { notifyTokens: 100, compactRetainTokens: 150, agentDecidesCompaction: false })
  const autoAgent = makeAgent()
  const autoDecision = await runPreStep(auto.listeners.get('agent/pre-step'), { agent: autoAgent })
  assert.equal(autoDecision.messages.length, 2, '自动压缩模式下提醒仍然照发')
  assert.equal(
    autoCalls.length,
    0,
    '到线不在 pre-step 里压 —— 常规压缩在 turn-stopping 等回合收口',
  )

  // 轮次即将关闭：这时候才压。
  await runTurnStopping(auto.listeners.get('agent/turn-stopping'), { agent: autoAgent })
  assert.equal(autoCalls.length, 1, 'turn-stopping 时应压缩一次')
  assert.equal(
    autoDecision.messages.length,
    2,
    'pre-step 返回时压缩应已完成，不能在后台与 surface 竞态',
  )
})

test('自动压缩在 turn-stopping 调用真实形状的 current-turn 引擎，不从 idle 盲调', async () => {
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
    { seq: 4, tokens: 100 },
  ]
  const calls = []
  const engine = {
    async compactRegion(start, end, agent) {
      if (!Number.isSafeInteger(agent?.session?.turnBoundary?.openTurnStartSeq)) {
        throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn')
      }
      calls.push([start, end])
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 5 }
    },
  }
  const harness = fakeContext({ total: 310, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100,
    compactRetainTokens: 150,
    agentDecidesCompaction: false,
  })
  const agent = agentWith([1, 2, 3, 4], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })

  // A close-out reminder must already have reached the model before the
  // turn-stopping compaction is allowed to erase the evidence.
  await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  await harness.listeners.get('agent/status')({ status: 'idle', agent })
  assert.equal(calls.length, 0, 'idle 没有 open turn，不能调用 compactRegion')

  await runTurnStopping(harness.listeners.get('agent/turn-stopping'), { agent })
  assert.equal(calls.length, 1, 'turn-stopping 仍有 open turn，应执行一次')
})

test('晚越线时先让下一轮提醒落地，turn-stopping 不会先压掉证据', async () => {
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
  ]
  const calls = []
  const engine = {
    async compactRegion(start, end) {
      calls.push([start, end])
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 4 }
    },
  }
  const harness = fakeContext({ total: 210, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100,
    compactRetainTokens: 1,
    agentDecidesCompaction: false,
  })
  const agent = agentWith([1, 2, 3])

  await runTurnStopping(harness.listeners.get('agent/turn-stopping'), { agent })
  assert.equal(calls.length, 0, '没有提醒落地时不能在 turn-stopping 先压')

  const notice = await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  assert.equal(notice.messages.length, 2)
  await runTurnStopping(harness.listeners.get('agent/turn-stopping'), { agent })
  assert.equal(calls.length, 1, '提醒落地后才允许本轮收口压缩')
})

test('turn-stopping 压缩被本轮取消时不写入失败退避', async () => {
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
  ]
  let calls = 0
  const engine = {
    compactRegion(_start, _end, _agent, signal) {
      calls += 1
      if (calls > 1) return Promise.resolve({ shadowedSeqs: [2], summarySeq: 4 })
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  }
  const harness = fakeContext({ total: 210, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100,
    compactRetainTokens: 1,
    agentDecidesCompaction: false,
  })
  const agent = agentWith([1, 2, 3])
  await runPreStep(harness.listeners.get('agent/pre-step'), { agent })

  const controller = new AbortController()
  const first = runTurnStopping(harness.listeners.get('agent/turn-stopping'), {
    agent,
    signal: controller.signal,
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
  await first

  const second = new AbortController()
  await runTurnStopping(harness.listeners.get('agent/turn-stopping'), {
    agent,
    signal: second.signal,
  })
  assert.equal(calls, 2, '取消不应让下一次 turn-stopping 被失败退避挡住')
})

test('不同会话并发 turn-stopping 不会把压缩目标串到另一个 session', async () => {
  const calls = []
  const engine = {
    async compactRegion(_start, _end, agent) {
      calls.push(agent.session.id)
      return { shadowedSeqs: [2], summarySeq: 4 }
    },
  }
  const harness = fakeContext({
    total: 210,
    nodes: [
      { seq: 1, tokens: 10 },
      { seq: 2, tokens: 100 },
      { seq: 3, tokens: 100 },
    ],
    engine,
  })
  apply(harness.ctx, {
    notifyTokens: 100,
    compactRetainTokens: 1,
    compactCooldownMs: 0,
    agentDecidesCompaction: false,
  })
  const a = agentWith([1, 2, 3])
  const b = agentWith([1, 2, 3])
  a.session.id = 'session-a'
  b.session.id = 'session-b'

  await runPreStep(harness.listeners.get('agent/pre-step'), { agent: a })
  await runPreStep(harness.listeners.get('agent/pre-step'), { agent: b })
  await Promise.all([
    runTurnStopping(harness.listeners.get('agent/turn-stopping'), { agent: a }),
    runTurnStopping(harness.listeners.get('agent/turn-stopping'), { agent: b }),
  ])
  assert.deepEqual(calls.sort(), ['session-a', 'session-b'])
})

test('自动压缩竞态：失败对模型可见、不消耗提醒配额，并在下一 pre-step 立即重试', async () => {
  const priced = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
    { seq: 4, tokens: 100 },
  ]
  let calls = 0
  const engine = {
    async compactRegion(_start, _end, agent) {
      calls += 1
      if (calls === 1) {
        // Reproduce the host's whole-surface failure: during summarize, the
        // turn appends one more node.
        agent.session.surface.nodes.push(5)
        agent.session.seq = 6
        priced.push({ seq: 5, tokens: 1 })
        throw new Error('compaction: session surface changed during summarization')
      }
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 6 }
    },
  }
  const harness = fakeContext({ total: 310, nodes: priced, engine })
  apply(harness.ctx, {
    notifyTokens: 100,
    compactRetainTokens: 150,
    compactCooldownMs: 60_000,
    agentDecidesCompaction: false,
  })
  const turnStoppingListener = harness.listeners.get('agent/turn-stopping')
  const listener = harness.listeners.get('agent/pre-step')
  const agent = agentWith([1, 2, 3, 4], {
    seq: 6,
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })

  await runPreStep(listener, { agent })
  // 第一次 turn-stopping：压缩撞上 surface race，失败。
  await runTurnStopping(turnStoppingListener, { agent })
  assert.equal(calls, 1, 'turn-stopping 时应尝试压缩')
  // 失败原因留到下一次提醒里 —— turn-stopping 手上没有提醒消息可以附带。
  const first = await runPreStep(listener, { agent })
  assert.match(first.messages.at(-1).content[0].text, /surface changed during summarization/)
  assert.match(first.messages.at(-1).content[0].text, /没有消耗提醒配额/)

  // 第二次 turn-stopping：可重试的 race 必须立刻再试一次。
  await runTurnStopping(turnStoppingListener, { agent })
  assert.equal(calls, 2, '可重试的 surface race 必须在下一 turn-stopping 立即重试')

  const third = await runPreStep(listener, { agent })
  assert.equal(calls, 2, '成功且上下文未增长时不得再次压缩')
  // 注意这里**不**断言「不再提醒」：本测试的 total 是固定的 310，压缩成功也不会降，
  // 所以下一轮 pre-step 到线后照常提醒 —— 那是对的。真实场景里压缩会把 total 压下去，
  // 下一轮根本不到线。
  assert.equal(third.messages.length, 2, '固定 total 未下降时仍会提醒')
})

test('自动压缩：连续三次 surface race 失败后转退避，不再每步白烧一次摘要调用', async () => {
  // 「surface 变了」被判可重试是对的，但重试代价是一次完整的摘要模型调用
  // （失败发生在摘要跑完之后）。surface 一直没静下来时，每步重试只会拖慢每一步。
  const priced = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
  ]
  let calls = 0
  const engine = {
    async compactRegion() {
      calls += 1
      throw new Error('compaction: session surface changed during summarization')
    },
  }
  const harness = fakeContext({ total: 210, nodes: priced, engine })
  apply(harness.ctx, {
    notifyTokens: 100,
    compactRetainTokens: 1,
    compactCooldownMs: 60_000,
    agentDecidesCompaction: false,
  })
  const turnStoppingListener = harness.listeners.get('agent/turn-stopping')
  const agent = agentWith([1, 2, 3], { seq: 4 })

  await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  // 前三次 turn-stopping 都是立即重试（每次真的调用引擎）
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await runTurnStopping(turnStoppingListener, { agent })
    assert.equal(calls, attempt, `第 ${attempt} 次应真的调用引擎`)
  }
  // 第四次：已转入退避，不该再调用
  await runTurnStopping(turnStoppingListener, { agent })
  assert.equal(calls, 3, '连续三次 race 失败后必须转退避，不再每次 turn-stopping 都调用引擎')
})

test('自动压缩同因失败只提示一次，退避中的剩余秒数变化不反复刷屏', async () => {
  let calls = 0
  const engine = {
    async compactRegion() {
      calls += 1
      throw new Error('summarizer unavailable')
    },
  }
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
  ]
  const harness = fakeContext({ total: 210, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100,
    compactRetainTokens: 1,
    agentDecidesCompaction: false,
  })
  const turnStoppingListener = harness.listeners.get('agent/turn-stopping')
  const listener = harness.listeners.get('agent/pre-step')
  const agent = agentWith([1, 2, 3], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })

  await runPreStep(listener, { agent })
  // turn-stopping 里压失败，原因留给下一次提醒。
  await runTurnStopping(turnStoppingListener, { agent })
  assert.equal(calls, 1)
  const first = await runPreStep(listener, { agent })
  assert.match(first.messages.at(-1).content[0].text, /summarizer unavailable/)

  const second = await runPreStep(listener, { agent })
  assert.equal(second.messages.length, 1, '同因退避失败不得再次注入提醒')
  assert.equal(calls, 1, '退避期内不得再次触碰摘要引擎')
})

test('agentDecidesCompaction 必须是布尔值', () => {
  assert.equal(resolveConfig({}).agentDecidesCompaction, true)
  assert.equal(resolveConfig({ agentDecidesCompaction: false }).agentDecidesCompaction, false)
  assert.throws(() => resolveConfig({ agentDecidesCompaction: 'yes' }), /布尔值/)
})

test('cleanup action 只列清单，绝不动文件', async () => {
  const tempRoot = join(tmpdir(), `stage-handoff-cleanup-action-${process.pid}-${Date.now()}`)
  try {
    // parent-backup 在**阶段目录里面**，这正是修复过的那个 bug 的形状：
    // 老实现直接查 <anchorRoot>/parent-backup，那个路径永远不存在。
    const stageDir = join(tempRoot, '261115-2359-stage-handoff')
    const backupDir = join(stageDir, 'parent-backup')
    await mkdir(join(stageDir, 'detail'), { recursive: true })
    await mkdir(backupDir, { recursive: true })
    await writeFile(join(stageDir, 'anchor.md'), '# anchor')
    await writeFile(join(stageDir, 'detail', 'work.md'), '# detail')
    for (const name of ['anchor-261101.md', 'anchor-261102.md', 'anchor-261103.md']) {
      await writeFile(join(backupDir, name), 'x'.repeat(50))
    }

    const harness = fakeContext({ total: 100, nodes: [], engine: undefined })
    apply(harness.ctx, { anchorRoot: tempRoot, keepAnchorBackups: 1 })
    const tool = harness.registeredTools[0]
    const result = await tool.execute({ action: 'cleanup' }, { agent: agentWith([]) })

    assert.match(result.text, /阶段 261115-2359-stage-handoff/)
    assert.match(result.text, /备份 3 个/)
    assert.match(result.text, /可清理 2 个/)
    assert.match(result.text, /不会删任何文件/)
    // 不能出现任何"已删除"式的说法
    assert.doesNotMatch(result.text, /已删除|已清理掉|removed/)

    // 最关键的断言：报告不等于动作，三个文件必须都还在。
    const { readdir: readDir } = await import('node:fs/promises')
    const remaining = await readDir(backupDir)
    assert.equal(remaining.length, 3, 'cleanup 不得删除任何文件')

    // 输出上限：候选一多，逐条打印会把模型上下文灌满，而 `docs/SECURITY.md` 第 6 条
    // 攻击面一直声称 cleanup「caps candidate output」。截断还必须报出还有多少没列，
    // 否则「前 N 条」会被当成完整清单。
    //
    // 文件名必须用**有效**日期：`rankOf` 会把 `261200`（day=00）判成 unknown、
    // 不进候选，第一版因此只数到 33 条。day 用 04..28 也避开已有那三个文件的重名。
    for (let index = 0; index < 60; index += 1) {
      const month = String(1 + Math.floor(index / 25)).padStart(2, '0')
      const day = String(4 + (index % 25)).padStart(2, '0')
      await writeFile(join(backupDir, `anchor-26${month}${day}.md`), 'x'.repeat(50))
    }
    const capped = await tool.execute({ action: 'cleanup' }, { agent: agentWith([]) })
    const listed = String(capped.text)
      .split('\n')
      .filter((line) => line.trimStart().startsWith('- anchor-'))
    assert.equal(listed.length, 40, `逐条打印应封顶 40 条，实际 ${listed.length}`)
    assert.match(capped.text, /另有 \d+ 个未列出/, '截断必须说出还有多少个没列')
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('cleanup：多个阶段的 parent-backup 各自判定，根目录下的同名目录被忽略', async () => {
  const tempRoot = join(tmpdir(), `stage-handoff-cleanup-multi-${process.pid}-${Date.now()}`)
  try {
    // 阶段 A：3 个备份，keep=1 → 2 个候选
    await mkdir(join(tempRoot, '261101-1200-alpha', 'detail'), { recursive: true })
    await mkdir(join(tempRoot, '261101-1200-alpha', 'parent-backup'), { recursive: true })
    await writeFile(join(tempRoot, '261101-1200-alpha', 'anchor.md'), '# anchor')
    await writeFile(join(tempRoot, '261101-1200-alpha', 'detail', 'work.md'), '# detail')
    for (const name of ['anchor-261101.md', 'anchor-261102.md', 'anchor-261103.md']) {
      await writeFile(join(tempRoot, '261101-1200-alpha', 'parent-backup', name), 'x'.repeat(10))
    }
    // 阶段 B：没有 parent-backup → 不该出现在清单里
    await mkdir(join(tempRoot, '261102-1300-beta', 'detail'), { recursive: true })
    await writeFile(join(tempRoot, '261102-1300-beta', 'anchor.md'), '# anchor')
    await writeFile(join(tempRoot, '261102-1300-beta', 'detail', 'work.md'), '# detail')
    // 根目录下也放一个 parent-backup：这不是合法位置，不能被当成阶段目录报出来
    await mkdir(join(tempRoot, 'parent-backup'), { recursive: true })
    await writeFile(join(tempRoot, 'parent-backup', 'anchor-9.md'), 'x'.repeat(10))

    const harness = fakeContext({ total: 100, nodes: [], engine: undefined })
    apply(harness.ctx, { anchorRoot: tempRoot, keepAnchorBackups: 1 })
    const tool = harness.registeredTools[0]
    const result = await tool.execute({ action: 'cleanup' }, { agent: agentWith([]) })

    assert.match(result.text, /阶段 261101-1200-alpha/)
    assert.match(result.text, /可清理 2 个/)
    assert.doesNotMatch(result.text, /阶段 261102-1300-beta/, '没有 parent-backup 的阶段不该出现')
    assert.doesNotMatch(result.text, /anchor-9\.md/, '根目录下的 parent-backup 不是合法位置')
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('cleanup：疑似未完成的阶段只进入人工复核清单', async () => {
  const tempRoot = join(tmpdir(), `stage-handoff-review-${process.pid}-${Date.now()}`)
  try {
    const stageDir = join(tempRoot, '261116-1200-empty')
    await mkdir(stageDir, { recursive: true })
    await writeFile(join(stageDir, 'anchor.md'), '# skeleton')

    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: tempRoot })
    const result = await harness.registeredTools[0].execute(
      { action: 'cleanup' },
      { agent: agentWith([]) },
    )
    assert.match(result.text, /需人工复核的阶段/)
    assert.match(result.text, /261116-1200-empty/)
    assert.match(result.text, /不会删除或改写/)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('自动压缩兜底：只有逼近宿主压缩墙时 pre-step 才硬压一次', async () => {
  // 常规时机在 turn-stopping。这条兜底防的是「agent 一直在长轮次里，turn 迟迟不收口」。
  // 兜底线是**宿主压缩墙**的 90%，不是提醒线 —— 与提醒线同值等于每轮第一步都卡一次。
  // 1,000,000 窗口、hostMaxTokens 默认 256,000 时墙 = 678,464，兜底线 = 610,617。
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 300_000 },
    { seq: 3, tokens: 300_000 },
  ]
  const makeEngine = (sink) => ({
    async compactRegion(start, end) {
      sink.push([start, end])
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 5 }
    },
  })

  // 到提醒线但没到兜底线（300,000 / 1,000,000 = 30%，远低于 610,617）：pre-step 不该压。
  const lowCalls = []
  const low = fakeContext({ total: 300_000, window: 1_000_000, nodes, engine: makeEngine(lowCalls) })
  apply(low.ctx, { notifyTokens: 100_000, compactRetainTokens: 600_000, agentDecidesCompaction: false })
  await runPreStep(low.listeners.get('agent/pre-step'), { agent: agentWith([1, 2, 3]) })
  assert.equal(lowCalls.length, 0, '只是到提醒线时不该在 pre-step 里压')

  // 越过兜底线（900,000 / 1,000,000 = 90% > 61%）：pre-step 必须压。
  const highCalls = []
  const high = fakeContext({ total: 900_000, window: 1_000_000, nodes, engine: makeEngine(highCalls) })
  apply(high.ctx, { notifyTokens: 100_000, compactRetainTokens: 600_000, agentDecidesCompaction: false })
  await runPreStep(high.listeners.get('agent/pre-step'), { agent: agentWith([1, 2, 3]) })
  assert.equal(highCalls.length, 1, '逼近宿主压缩墙时 pre-step 必须兜底压一次')
})

test('自动压缩不重入：压缩进行中再次越线不会启动第二次', async () => {
  const calls = []
  /** @type {(value?: unknown) => void} */
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const engine = {
    async compactRegion(start, end) {
      calls.push([start, end])
      await gate // 卡住，模拟「压缩还没跑完」
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 5 }
    },
  }
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
    { seq: 4, tokens: 100 },
  ]
  const harness = fakeContext({ total: 310, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100,
    compactRetainTokens: 150,
    compactCooldownMs: 0, // 关掉冷却，单独验证重入防护
    agentDecidesCompaction: false,
  })
  const turnStoppingListener = harness.listeners.get('agent/turn-stopping')
  const agent = agentWith([1, 2, 3, 4], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })

  await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  const first = runTurnStopping(turnStoppingListener, { agent })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls.length, 1, '第一次 turn-stopping 应启动压缩')

  // 压缩还在跑时又来一次 turn-stopping：in-flight guard 必须挡住第二次。
  await runTurnStopping(turnStoppingListener, { agent })
  assert.equal(calls.length, 1, '压缩仍在进行中时不得启动第二次')

  release()
  await first
  assert.equal(calls.length, 1, '第一次完成后也不应补压一次')
})

test('提醒与压缩状态按会话隔离，互不连累', async () => {  // 这同时钉住一个更基本的前提：DSH 在连续的 pre-step 里给的是**同一个** session
  // 对象。否则 WeakMap 永远不命中，节流会静默失效 —— 真实会话里实测到过 4 次提醒
  // 间隔约 26k（正好是 notifyRepeatDelta 25000），说明对象是稳定的。
  const { ctx, listeners } = fakeContext({ total: 350000 })
  applyWithLine(ctx)
  const listener = listeners.get('agent/pre-step')
  const agentA = agentWith([1, 2])
  const agentB = agentWith([3, 4])

  assert.equal((await runPreStep(listener, { agent: agentA })).messages.length, 2, 'A 越线应提醒')
  assert.equal(
    (await runPreStep(listener, { agent: agentB })).messages.length,
    2,
    'B 是另一个会话，不该被 A 的节流连累',
  )
  assert.equal(
    (await runPreStep(listener, { agent: agentA })).messages.length,
    1,
    'A 已被自己的节流挡住',
  )
  assert.equal(
    (await runPreStep(listener, { agent: agentB })).messages.length,
    1,
    'B 同样只提醒一次',
  )
})

test('提醒文案保持在预算内 —— 它每次都注入模型上下文', () => {
  // 其他功能都是按需调用，只有提醒是每轮都可能出现的固定开销。实测 799 字符 /
  // 13 行 / 约 400 tokens。给一点余量，但别让它长成一篇文档。
  const config = resolveConfig({})
  const text = noticeText(350000, 1000000, config)

  assert.ok(text.length < 1200, `提醒应保持短，实际 ${text.length} 字符`)
  assert.ok(text.split('\n').length <= 20, `行数应可控，实际 ${text.split('\n').length} 行`)
  // 关键内容仍在：不能为了短把该说的删掉。
  assert.match(text, /授权与安全边界/)
  assert.match(text, /stage_handoff\(action="compact"\)/)
  assert.match(text, /不会删任何文件|不扫描、不脱敏/)
})

test('settings 服务就位时，用 auto:false 注册页面策略', () => {
  // 真实签名是 configure(presentation: { auto?: boolean }, owner?: Fiber)。
  // 它**只**注册页面策略，不接收配置默认值 —— 默认值由 Config schema 的 .default()
  // 提供。早先版本把配置对象当第一个参数传，靠 auto ?? true 才没炸。
  const calls = []
  const service = {
    configure(presentation, fiber) {
      calls.push({ presentation, fiber })
      return () => {}
    },
  }
  const harness = fakeContext({ total: 100, settings: service })
  apply(harness.ctx, { notifyTokens: 123456 })

  assert.equal(calls.length, 1, 'settings.configure 应被调用一次')
  assert.deepEqual(calls[0].presentation, { auto: false }, '只应声明页面策略')
  assert.equal(calls[0].fiber, harness.ctx.fiber, 'owner 应是本插件的 fiber')

  // 面板里能出现哪些字段，由 Config schema 决定；它必须覆盖全部配置键。
  const schemaKeys = Object.keys(Config.dict ?? {}).sort()
  assert.deepEqual(schemaKeys, [...CONFIG_KEYS].sort(), 'Config 必须覆盖全部配置键')
})

test('settings 服务不存在时不崩，插件照常注册工具', () => {  const harness = fakeContext({ total: 350000 }) // 没有 settings
  apply(harness.ctx)
  assert.equal(harness.registeredTools.length, 1, '工具仍应注册')
  assert.equal(harness.registered.length, 1, '命令仍应注册')
})

test('settings.configure 抛错时不崩，只记一条 warn', () => {
  const service = {
    configure() {
      throw new Error('签名不对')
    },
  }
  const harness = fakeContext({ total: 100, settings: service })
  apply(harness.ctx)

  assert.equal(harness.registeredTools.length, 1, '抛错不应影响工具注册')
  const warned = harness.logs.filter(
    ([level, message]) => level === 'warn' && message.includes('settings.configure'),
  )
  assert.equal(warned.length, 1, '应恰有一条说明面板会退化为静态值的 warn')
  assert.match(warned[0][1], /静态默认值/)
})

test('取不到官方 createUserMessage 时，兜底消息的形状必须完整', async () => {
  // fakeContext 没有 loader，所以这里走的就是真实降级路径：loadCreateUserMessage
  // 返回 undefined，提醒由 fallbackUserMessage 手搓。形状错一个字段，提醒就会
  // 静默丢失 —— 没有报错，只是模型再也看不到它。
  // 注意 fakeContext 默认有 loader（会走官方 createUserMessage 的 mock），
  // 这里必须显式关掉才能走到真实的兜底构造。
  const harness = fakeContext({ total: 350000, withLoader: false })
  applyWithLine(harness.ctx)
  const listener = harness.listeners.get('agent/pre-step')
  const agent = agentWith([])

  const first = await runPreStep(listener, { agent })
  assert.equal(first.messages.length, 2, '应注入提醒')
  const message = first.messages[1]

  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length >= 8, 'id 必须是有效 uuid 串')
  assert.equal(message.content[0].type, 'text')
  assert.ok(message.content[0].text.length > 0)
  assert.equal(message.source.kind, 'stage-handoff')
  assert.equal(message.source.form, 'notice')
  assert.equal(typeof message.source.summary, 'string')
  assert.ok(Object.isFrozen(message), '必须冻结，防止下游意外改写注入的消息')
  assert.ok(Object.isFrozen(message.content), '内容数组也要冻结')

  // 跨过回落再越线，得到第二条提醒：id 不能重复。
  harness.setTotal(120000)
  await runPreStep(listener, { agent })
  harness.setTotal(350000)
  const second = await runPreStep(listener, { agent })
  assert.equal(second.messages.length, 2, '回落后再越线应重新提醒')
  assert.notEqual(second.messages[1].id, message.id, '每条提醒都要有新 id')
})

test('拿不到平衡守卫时仍能压缩，只是跳过平衡修正', async () => {
  // balanceGuard: null → loader 里 @deepseek-ai/dsh-compaction 返回空对象，
  // 拿不到 toolPairingBalancedBefore。这条降级路径此前从未被执行过：默认值是
  // () => true，所有压缩测试都在用平衡守卫就位的版本。
  const calls = []
  const engine = {
    async compactRegion(start, end) {
      calls.push({ start, end })
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 5 }
    },
  }
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
    { seq: 4, tokens: 100 },
  ]
  const harness = fakeContext({ total: 310, nodes, engine, balanceGuard: null })
  apply(harness.ctx, { compactRetainTokens: 150 })
  const tool = harness.registeredTools[0]
  const agent = agentWith([1, 2, 3, 4], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })

  const result = await tool.execute({ action: 'compact' }, { agent })
  assert.match(result.text, /精确压缩完成/, '拿不到守卫不该让压缩失败')
  assert.equal(calls.length, 1, '压缩应当照常发生')
})

test('commands 不可用时：工具照常注册，提醒也照常工作', async () => {
  const harness = fakeContext({ total: 350000, withCommands: false })
  applyWithLine(harness.ctx)

  assert.equal(harness.registered.length, 0, '没有 commands 就不该注册命令')
  assert.equal(harness.registeredTools.length, 1, '工具不依赖 commands，应照常注册')

  const decision = await runPreStep(harness.listeners.get('agent/pre-step'), {
    agent: agentWith([]),
  })
  assert.equal(decision.messages.length, 2, '提醒不依赖 commands')
})

test('tools 不可用时：命令照常注册，提醒也照常工作', async () => {
  const harness = fakeContext({ total: 350000, withTools: false })
  applyWithLine(harness.ctx)

  assert.equal(harness.registeredTools.length, 0, '没有 tools 就不该注册工具')
  assert.equal(harness.registered.length, 1, '命令不依赖 tools，应照常注册')

  const decision = await runPreStep(harness.listeners.get('agent/pre-step'), {
    agent: agentWith([]),
  })
  assert.equal(decision.messages.length, 2, '提醒不依赖 tools')
})

test('commands 与 tools 同时不可用：插件不崩，提醒仍然发出', async () => {
  // 最坏情况：只剩 tokenMeter。提醒是插件的核心价值，不能因为周边服务缺席而消失。
  const harness = fakeContext({ total: 350000, withCommands: false, withTools: false })
  applyWithLine(harness.ctx)

  assert.equal(harness.registered.length, 0)
  assert.equal(harness.registeredTools.length, 0)

  const decision = await runPreStep(harness.listeners.get('agent/pre-step'), {
    agent: agentWith([]),
  })
  assert.equal(decision.messages.length, 2, '提醒必须照常注入')
})

test('defer 提升本会话阈值：原来的线不再提醒，到新线才提醒', async () => {
  const harness = fakeContext({ total: 350000, window: 1000000 })
  applyWithLine(harness.ctx, { notifyCooldownMs: 0 })
  const tool = harness.registeredTools[0]
  const agent = agentWith([])
  const listener = harness.listeners.get('agent/pre-step')

  assert.equal((await runPreStep(listener, { agent })).messages.length, 2, '先按原线提醒一次')

  const deferred = await tool.execute({ action: 'defer', tokens: 450000 }, { agent })
  assert.match(deferred.text, /450/, '应回报新的阈值')
  assert.match(deferred.text, /代价/, '必须说明提阈值的代价')
  assert.match(deferred.text, /自动压缩墙/, '必须点名系统自动压缩墙')

  // 回落到配置线与临时线之间（310k）：清掉节流记录，但 defer 仍有效
  harness.setTotal(310000)
  await runPreStep(listener, { agent })
  harness.setTotal(320000)
  assert.equal(
    (await runPreStep(listener, { agent })).messages.length,
    1,
    '低于提升后的阈值不该提醒',
  )

  harness.setTotal(460000)
  assert.equal(
    (await runPreStep(listener, { agent })).messages.length,
    2,
    '越过提升后的阈值应照常提醒',
  )
})

test('defer 超过窗口 90% 时按上限处理，并说明原因', async () => {
  const harness = fakeContext({ total: 100, window: 1000000 })
  apply(harness.ctx)
  const tool = harness.registeredTools[0]
  const agent = agentWith([])

  const result = await tool.execute({ action: 'defer', tokens: 2000000 }, { agent })
  assert.match(result.text, /超过窗口的 90%/, '应说明被钳制')
  assert.match(result.text, /900/, '应回报钳制后的值')
})

test('defer 参数非法时报用法而不是静默生效', async () => {
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx)
  const tool = harness.registeredTools[0]
  const agent = agentWith([])

  for (const bad of [undefined, 0, -5, 1.5, 'abc', Number.NaN]) {
    const result = await tool.execute({ action: 'defer', tokens: bad }, { agent })
    assert.match(result.text, /defer 需要 tokens/, `tokens=${String(bad)} 应被拒绝`)
  }

  const lower = await tool.execute({ action: 'defer', tokens: 200000 }, { agent })
  assert.match(lower.text, /只能临时提高/, '低于配置线时不得声称已经降低阈值')

  const impossible = fakeContext({ total: 100, window: 100000 })
  apply(impossible.ctx, { notifyTokens: 100000 })
  const impossibleResult = await impossible.registeredTools[0].execute(
    { action: 'defer', tokens: 120000 },
    { agent: agentWith([]) },
  )
  assert.match(impossibleResult.text, /90% 上限/, '窗口上限低于配置线时应明确拒绝')
})

test('/anchor reset 会把 defer 抬过的阈值一并清回配置值', async () => {
  const harness = fakeContext({ total: 350000, window: 1000000 })
  applyWithLine(harness.ctx, { notifyCooldownMs: 0 })
  const tool = harness.registeredTools[0]
  const agent = agentWith([])
  const listener = harness.listeners.get('agent/pre-step')
  const command = harness.registered[0]

  await tool.execute({ action: 'defer', tokens: 500000 }, { agent })

  // 抬阈值后，介于配置线与临时线之间的占用不该提醒
  harness.setTotal(310000)
  await runPreStep(listener, { agent })
  harness.setTotal(320000)
  assert.equal((await runPreStep(listener, { agent })).messages.length, 1, '抬阈值期间不提醒')

  // reset 之后回到配置值 300000，立刻可以提醒
  const result = command.handler({ agent, rawInput: 'reset', signal: { aborted: false } })
  assert.match(result.text, /临时阈值/)

  harness.setTotal(100000)
  await runPreStep(listener, { agent })
  harness.setTotal(350000)
  assert.equal(
    (await runPreStep(listener, { agent })).messages.length,
    2,
    'reset 之后应恢复配置阈值',
  )
})

test('压缩回落到配置阈值以下时，defer 抬高的临时阈值自动失效', async () => {  // 否则 defer 会变成永久设置：压缩生效、「再给我一点时间」的理由早就不在，
  // 提醒却依然被压着。
  const harness = fakeContext({ total: 350000, window: 1000000 })
  applyWithLine(harness.ctx, { notifyCooldownMs: 0 })
  const tool = harness.registeredTools[0]
  const agent = agentWith([])
  const listener = harness.listeners.get('agent/pre-step')

  await tool.execute({ action: 'defer', tokens: 500000 }, { agent })

  // 模拟一次压缩：占用回到配置阈值以下
  harness.setTotal(100000)
  await runPreStep(listener, { agent })

  // 再涨过配置阈值（300k）：临时阈值此时应已失效，必须提醒
  harness.setTotal(350000)
  assert.equal(
    (await runPreStep(listener, { agent })).messages.length,
    2,
    '压缩回落后，defer 不该继续压着提醒',
  )
})

test('defer 之后，status 与提醒文案都显示提升后的阈值', async () => {
  // 诊断报一个不生效的数字，比不报更误导：agent 会以为自己设的阈值没生效。
  const harness = fakeContext({ total: 360000, window: 1000000 })
  applyWithLine(harness.ctx, { notifyCooldownMs: 0 })
  const tool = harness.registeredTools[0]
  const command = harness.registered[0]
  const agent = agentWith([])
  const listener = harness.listeners.get('agent/pre-step')

  await tool.execute({ action: 'defer', tokens: 450000 }, { agent })

  // 360k 低于临时线：不提醒；status 会现场测量当前占用。
  assert.equal((await runPreStep(listener, { agent })).messages.length, 1)

  const status = command.handler({ agent, rawInput: 'status', signal: { aborted: false } })
  assert.match(status.text, /450/, '/anchor status 应显示提升后的阈值')
  assert.match(status.text, /defer 临时提升/, '应说明这是临时提升')
  assert.match(status.text, /300/, '也应给出配置值以便对照')

  // 越过临时线触发提醒：文案里的提醒线必须是提升后的值
  harness.setTotal(460000)
  const decision = await runPreStep(listener, { agent })
  assert.equal(decision.messages.length, 2)
  assert.match(decision.messages[1].content[0].text, /450/, '提醒文案应写提升后的线')
  assert.match(decision.messages[1].content[0].text, /临时提升/, '并说明是被提升过的')
})

test('defer 在配置线以下登记时明确说尚未生效，且不会被下一次 pre-step 清掉', async () => {
  const harness = fakeContext({ total: 100000, window: 1000000 })
  applyWithLine(harness.ctx, { notifyCooldownMs: 0 })
  const tool = harness.registeredTools[0]
  const command = harness.registered[0]
  const agent = agentWith([])
  const listener = harness.listeners.get('agent/pre-step')

  const deferred = await tool.execute({ action: 'defer', tokens: 450000 }, { agent })
  assert.match(deferred.text, /低于配置线/)
  assert.match(deferred.text, /已经登记.*尚未影响提醒/)

  // pre-step 低于配置线：不应误删尚未生效的 defer。
  await runPreStep(listener, { agent })
  const status = command.handler({ agent, rawInput: 'status', signal: { aborted: false } })
  assert.match(status.text, /450/, 'status 必须仍显示已登记的新线')
  assert.match(status.text, /尚未达到配置线，尚未生效/, '不能用“已生效”描述当前状态')
})

test('运行中抬高配置线后，旧的 defer 不会反过来把实际阈值压低', async () => {
  const harness = fakeContext({ total: 360000, window: 1000000 })
  applyWithLine(harness.ctx, { notifyCooldownMs: 0 })
  const tool = harness.registeredTools[0]
  const command = harness.registered[0]
  const agent = agentWith([])

  await tool.execute({ action: 'defer', tokens: 450000 }, { agent })
  const changed = command.handler({
    agent,
    rawInput: 'threshold 600k',
    signal: { aborted: false },
  })
  assert.equal(changed.kind, 'success')

  const status = command.handler({ agent, rawInput: 'status', signal: { aborted: false } })
  assert.match(status.text, /提醒线 614,400 tokens/, '实际阈值应取配置线与 defer 的较大者')
})

test('defer=off 在低占用时保持关闭，status 不会把它误报成阈值故障', async () => {
  const harness = fakeContext({ total: 100000, window: 1000000 })
  applyWithLine(harness.ctx, { notifyCooldownMs: 0 })
  const tool = harness.registeredTools[0]
  const agent = agentWith([])
  const listener = harness.listeners.get('agent/pre-step')

  const deferred = await tool.execute({ action: 'defer', tokens: 'off' }, { agent })
  assert.match(deferred.text, /不会因当前占用低于配置线而被下一步清掉/)

  await runPreStep(listener, { agent })
  const status = await tool.execute({ action: 'status' }, { agent })
  assert.match(status.text, /defer=off/)
  assert.doesNotMatch(status.text, /提醒线 .*永远/)
})

test('工具 status 输出锚点目录与提醒配额，与 /anchor status 对齐', async () => {
  // 在线验收报告 P2-1：/anchor status 有两行，工具侧没有，用户无从确认锚点落在哪、
  // 提醒有没有触发过。两处输出必须一致。
  const harness = fakeContext({ total: 100000, window: 1000000 })
  apply(harness.ctx, { anchorRoot: 'docs/anchors' })
  const tool = harness.registeredTools[0]
  const status = await tool.execute({ action: 'status' }, { agent: agentWith([]) })
  assert.match(status.text, /锚点目录 docs\/anchors/)
  assert.match(status.text, /锚点软上限/)
  assert.match(status.text, /当前提醒配额：(已触发|未触发)/)
})

test('压缩区间倒序时说明 surface 顺序，而不是直接打印两个反着的 seq', () => {
  // surface 的 seq 不单调：摘要节点的 seq 晚于它替换掉的历史。真机上观察到
  // 「压缩区间 seq 3594..3165」，直读像出错。
  assert.equal(describeSeqRange(10, 20), '10..20')
  assert.equal(
    describeSeqRange(3594, 3165),
    '3594..3165（surface 顺序；摘要节点的 seq 晚于它替换掉的历史）',
  )
  assert.equal(describeSeqRange(undefined, 5), '?..5')
  assert.equal(describeSeqRange(7, 7), '7..7')
  // NaN/Infinity 也是 number：既不能被标成「surface 顺序」，也不该被当成坐标打印。
  assert.equal(describeSeqRange(Number.NaN, 5), '?..5')
  assert.equal(describeSeqRange(5, Number.POSITIVE_INFINITY), '5..?')
})

test('会话工作目录失效时，依赖锚点的动作给出可行动原因，status 仍可用', async () => {
  // 在线验收 P1：项目被移动后，会话里记录的 cwd 失效，scaffold 只报
  // 「ENOENT: realpath 'D:\旧路径'」，用户看不出是项目搬走了。
  const gone = join(tmpdir(), `stage-handoff-gone-${process.pid}-${Date.now()}`)
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, { anchorRoot: 'docs/anchors' })
  const tool = harness.registeredTools[0]
  const base = agentWith([])
  const dead = { ...base, session: { ...base.session, header: { cwd: gone } } }

  const scaffold = await tool.execute({ action: 'scaffold', topic: 'x' }, { agent: dead })
  assert.match(scaffold.text, /锚点目录不可用/)
  assert.match(scaffold.text, /会话工作目录 .* 不存在/)

  const validate = await tool.execute({ action: 'validate' }, { agent: dead })
  assert.match(validate.text, /锚点目录不可用/)

  // status / summary 这类不依赖锚点目录的动作必须照常工作。
  const status = await tool.execute({ action: 'status' }, { agent: dead })
  assert.match(status.text, /引擎：/)

  // 绝对 anchorRoot 与会话目录无关，不受影响。
  const absRoot = join(tmpdir(), `stage-handoff-abs-${process.pid}-${Date.now()}`)
  const absHarness = fakeContext({ total: 100 })
  apply(absHarness.ctx, { anchorRoot: absRoot })
  try {
    const absScaffold = await absHarness.registeredTools[0].execute(
      { action: 'scaffold', topic: 'x' },
      { agent: dead },
    )
    assert.doesNotMatch(absScaffold.text, /锚点目录不可用/)
  } finally {
    await rm(absRoot, { recursive: true, force: true })
  }
})

test('reset action 能从 defer=off 恢复，等价于 /anchor reset', async () => {
  // agent 敲不了 slash 命令，defer=off 之后原本只能靠人手动恢复；
  // 这个 action 就是那条出口，所以必须真的把登记清掉。
  const harness = fakeContext({ total: 100000, window: 1000000 })
  applyWithLine(harness.ctx, { notifyCooldownMs: 0 })
  const tool = harness.registeredTools[0]
  const agent = agentWith([])
  const listener = harness.listeners.get('agent/pre-step')

  await tool.execute({ action: 'defer', tokens: 'off' }, { agent })
  let status = await tool.execute({ action: 'status' }, { agent })
  assert.match(status.text, /defer=off/, '前置条件：本会话应处于 off')

  const reset = await tool.execute({ action: 'reset' }, { agent })
  assert.match(reset.text, /已清空/, '回执应说明已清空')
  assert.match(reset.text, /defer 登记 有/, '回执应如实说明清空前有 defer 登记')

  // 跨一次 pre-step 再看：确认不是「回执说清了、下一步又回来」。
  await runPreStep(listener, { agent })
  status = await tool.execute({ action: 'status' }, { agent })
  assert.doesNotMatch(status.text, /defer=off/, 'reset 之后不该还是 off')
  assert.match(status.text, /提醒线 300,000 tokens/, '应回到配置线')
})

test('reset 没有 session 时明确报错，不静默成功', async () => {
  const harness = fakeContext({ total: 100000, window: 1000000 })
  applyWithLine(harness.ctx, { notifyCooldownMs: 0 })
  const tool = harness.registeredTools[0]
  const agent = agentWith([])

  const reset = await tool.execute({ action: 'reset' }, { agent: { ...agent, session: undefined } })
  assert.match(reset.text, /没有 session/)
})

test('Config schema 与 CONFIG_KEYS 必须完全一致', () => {
  // Config 决定设置面板显示哪些字段，CONFIG_KEYS 决定 resolveConfig 接受哪些键。
  // 两处不同步的后果是：面板显示一个插件不认识的字段，或插件支持一个面板改不到的字段。
  const schemaKeys = Object.keys(Config.dict ?? {}).sort()
  const knownKeys = [...CONFIG_KEYS].sort()
  assert.deepEqual(schemaKeys, knownKeys)
})

test('每个配置键都必须真的被 lib/ 里的代码读过', async () => {
  // 防的是「声明了、面板显示了、代码从来没读」——那种配置项改了没反应，
  // 而用户会以为是插件 bug。反过来 CONFIG_KEYS 少一个键则会让面板改不到。
  const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
  const names = (await readdir(libDir)).filter((name) => name.endsWith('.js'))
  const sources = names.map((name) => readFileSync(join(libDir, name), 'utf8')).join('\n')
  for (const key of CONFIG_KEYS) {
    // 两种用法都算读过：`config.key` 与可选链 `config?.key`。
    const used = sources.includes(`config.${key}`) || sources.includes(`config?.${key}`)
    assert.ok(used, `配置键 ${key} 在 lib/ 里从未被读取 —— 要么接上实现，要么从 CONFIG_KEYS 删掉`)
  }
})

test('resolveConfig({}) 的默认值与 schema 声明的 default 逐键相等', () => {
  // 同一份默认值存在两处：Schemastery 的 .default() 和 config.js 的 DEFAULT_*。
  // 两处漂移时，面板显示的是一个数、运行时用的是另一个数，而且不会有任何报错。
  const resolved = resolveConfig({})
  for (const [key, child] of Object.entries(Config.dict ?? {})) {
    const declared = child.meta?.default
    if (declared === undefined) continue // 由 resolveConfig 兜底的键不在此比较
    assert.deepEqual(
      resolved[key],
      declared,
      `配置键 ${key} 的默认值不一致：resolveConfig 给 ${JSON.stringify(resolved[key])}，schema 声明 ${JSON.stringify(declared)}`,
    )
  }
})

test('Config 的每个字段都必须标 volatile，热更新由入口检查接管', () => {
  // volatileForm() 只保留 meta.volatile 的字段，其余被视为「需要重新挂载才生效」
  // 的普通配置，直接不进表单。漏一个 .volatile()，那个字段就在面板里消失。
  for (const [key, child] of Object.entries(Config.dict ?? {})) {
    assert.equal(child.meta?.volatile, true, `${key} 缺少 .volatile()，面板里不会出现`)
  }
})

test('事件环把晚挂载标成 partial-since-mount，不再声称覆盖完整日志', async () => {
  const session = {
    id: 'late-mount',
    seq: 7,
    surface: { nodes: [] },
    snapshotEvents: () => [],
  }
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, undefined)
  harness.listeners.get('session/event')(session, {
    seq: 6,
    type: 'turn/start',
    data: {},
  })
  const agent = { session, ctx: { get: () => undefined } }
  const summary = await harness.registeredTools[0].execute({ action: 'summary' }, { agent })
  assert.match(summary.text, /仅覆盖插件挂载后观察到的片段/)
  assert.match(summary.text, /mount=6/)
  assert.doesNotMatch(summary.text, /覆盖完整日志/)

  const status = await harness.registeredTools[0].execute({ action: 'status' }, { agent })
  assert.match(status.text, /内存事件环: 可用/)
  assert.match(status.text, /mount=6/)
})

test('单个会话的事件环受总字节预算约束，并永久标成 partial-truncated', async () => {
  const session = {
    id: 'byte-budget',
    seq: 40,
    surface: { nodes: [] },
    snapshotEvents: () => [],
  }
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, undefined)
  const body = 's'.repeat(64 * 1024)
  for (let seq = 0; seq < 40; seq += 1) {
    harness.listeners.get('session/event')(session, {
      seq,
      type: 'compaction/summary',
      data: { summary: [{ type: 'text', text: body }] },
    })
  }
  const status = await harness.registeredTools[0].execute(
    { action: 'status' },
    { agent: { session, ctx: { get: () => undefined } } },
  )
  assert.match(status.text, /事件环已裁剪/)
  assert.match(status.text, /truncatedByBytes=true/)
})

test('没有可压区间是 no-op：自动与手动路径都不进入失败退避', async () => {
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 500 },
  ]
  const manual = fakeContext({
    total: 510,
    nodes,
    engine: {
      async compactRegion() {
        throw new Error('no-op must not call the engine')
      },
    },
  })
  apply(manual.ctx, { compactRetainTokens: 500 })
  const manualAgent = agentWith([1, 2], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  const first = await manual.registeredTools[0].execute(
    { action: 'compact' },
    { agent: manualAgent },
  )
  const second = await manual.registeredTools[0].execute(
    { action: 'compact' },
    { agent: manualAgent },
  )
  assert.match(first.text, /无需执行/)
  assert.match(second.text, /无需执行/)
  assert.doesNotMatch(second.text, /压缩失败退避|压缩冷却中/)

  const auto = fakeContext({
    total: 510,
    window: 1000,
    nodes,
    engine: {
      async compactRegion() {
        throw new Error('no-op must not call the engine')
      },
    },
  })
  apply(auto.ctx, {
    notifyTokens: 100,
    compactRetainTokens: 500,
    agentDecidesCompaction: false,
  })
  const autoAgent = agentWith([1, 2], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  await runPreStep(auto.listeners.get('agent/pre-step'), { agent: autoAgent })
  await runTurnStopping(auto.listeners.get('agent/turn-stopping'), { agent: autoAgent })
  const status = await auto.registeredTools[0].execute(
    { action: 'status' },
    { agent: autoAgent },
  )
  assert.doesNotMatch(status.text, /压缩失败退避/)
})

test('validate 的全文正则使用排除围栏后的文档，不把示例当证据', async () => {
  const root = join(tmpdir(), `stage-handoff-validate-fence-all-${process.pid}-${Date.now()}`)
  const stage = '261118-0000-fence-all'
  try {
    await mkdir(join(root, stage), { recursive: true })
    await writeFile(
      join(root, stage, 'anchor.md'),
      [
        '# fence',
        '',
        '## 下一步',
        '1. 跑 `node --test`',
        '',
        '## 硬约束',
        '- [实测 261118] 当前约束',
        '',
        '## 示例',
        '````markdown',
        'parent-backup/anchor-old.md',
        '- [推断未验证] 围栏里的示例',
        '[实测 200101] 早就过期的示例',
        '````',
        '',
      ].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'validate', stage },
      { agent: agentWith([]) },
    )
    assert.match(result.text, /没有任何 `\[推断未验证\]`/)
    assert.doesNotMatch(result.text, /引用了 parent-backup/)
    assert.doesNotMatch(result.text, /最老的复核记录/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('窗口未知时 numeric defer 明确拒绝，并标出 bounded=false', async () => {
  const harness = fakeContext({ total: 350000, window: null })
  applyWithLine(harness.ctx)
  const agent = agentWith([])
  const result = await harness.registeredTools[0].execute(
    { action: 'defer', tokens: 999999999 },
    { agent },
  )
  assert.match(result.text, /无法执行/)
  assert.match(result.text, /bounded=false/)
  const status = await harness.registeredTools[0].execute({ action: 'status' }, { agent })
  assert.match(status.text, /提醒线 300,000 tokens/)
})

test('安全读层拒绝有硬链接的 anchor.md，不把根外内容交给 recall', async (t) => {
  const root = join(tmpdir(), `stage-handoff-read-link-${process.pid}-${Date.now()}`)
  const outside = join(tmpdir(), `stage-handoff-read-victim-${process.pid}-${Date.now()}.txt`)
  const stage = '261118-0000-read-link'
  try {
    await mkdir(join(root, stage), { recursive: true })
    await writeFile(outside, 'OUTSIDE-SECRET', 'utf8')
    try {
      await link(outside, join(root, stage, 'anchor.md'))
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EXDEV') {
        t.skip(`hard link unavailable: ${error.code}`)
        return
      }
      throw error
    }
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'recall', stage, query: 'OUTSIDE' },
      { agent: agentWith([]) },
    )
    assert.match(result.text, /硬链接/)
    assert.doesNotMatch(result.text, /OUTSIDE-SECRET/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { force: true })
  }
})

test('安全读层对 anchor.md 设置字节上限', async () => {
  const root = join(tmpdir(), `stage-handoff-read-size-${process.pid}-${Date.now()}`)
  const stage = '261118-0000-read-size'
  try {
    await mkdir(join(root, stage), { recursive: true })
    await writeFile(join(root, stage, 'anchor.md'), 'x'.repeat(1024 * 1024 + 1), 'utf8')
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'validate', stage },
      { agent: agentWith([]) },
    )
    assert.match(result.text, /超过 1,048,576 字节读取上限/)
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js'),
      'utf8',
    )
    assert.equal(
      (source.match(/\breadFile\(/g) ?? []).length,
      0,
      '锚点内容读取不得绕过同一个安全读层直接调用 readFile',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('guard 用多重集比较：重复出现少一次与来源标签变化都会报', async () => {
  const root = join(tmpdir(), `stage-handoff-guard-multiset-${process.pid}-${Date.now()}`)
  const stage = '261118-0000-multiset'
  const line = '- [实测] 同一条重复约束'
  try {
    await mkdir(join(root, stage), { recursive: true })
    const original = ['# multiset', '', '## 硬约束', line, line, '', '## 下一步', '1. 跑 `node --test`', ''].join('\n')
    await writeFile(join(root, stage, 'anchor.md'), original, 'utf8')
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    await tool.execute({ action: 'guard', stage }, { agent: agentWith([]) })

    await writeFile(
      join(root, stage, 'anchor.md'),
      original.replace(`${line}\n`, ''),
      'utf8',
    )
    const missingOne = await tool.execute({ action: 'validate', stage }, { agent: agentWith([]) })
    assert.match(missingOne.text, /基线 2 条、当前 1 条/)
    assert.match(missingOne.text, /少了 1 条基线原文/)

    await writeFile(
      join(root, stage, 'anchor.md'),
      original.replace(line, '- [人工明确] 同一条重复约束'),
      'utf8',
    )
    const changedTag = await tool.execute({ action: 'validate', stage }, { agent: agentWith([]) })
    assert.match(changedTag.text, /标签\/状态现在是/)
    assert.match(changedTag.text, /人工明确/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('压缩成功先于 abort 落账：下一 turn-stopping 受成功冷却保护', async () => {
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
  ]
  let calls = 0
  let controller
  const engine = {
    async compactRegion() {
      calls += 1
      controller.abort()
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 4 }
    },
  }
  const harness = fakeContext({ total: 210, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100,
    compactRetainTokens: 1,
    compactCooldownMs: 60_000,
    agentDecidesCompaction: false,
  })
  const agent = agentWith([1, 2, 3])
  await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  controller = new AbortController()
  await runTurnStopping(harness.listeners.get('agent/turn-stopping'), {
    agent,
    signal: controller.signal,
  })
  await runTurnStopping(harness.listeners.get('agent/turn-stopping'), { agent })
  assert.equal(calls, 1, '已成功落盘的压缩不能被 abort 改记成 skipped')
})

test('手动 compact 会转发 exec.signal，并在调用方取消时停止等待', async () => {
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
  ]
  let sawAbort = false
  let engineStarted
  const started = new Promise((resolve) => {
    engineStarted = resolve
  })
  const engine = {
    compactRegion(_start, _end, _agent, signal) {
      engineStarted()
      return new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('exec.signal was not forwarded')), 200)
        signal?.addEventListener(
          'abort',
          () => {
            sawAbort = true
            clearTimeout(timer)
            reject(new Error('aborted'))
          },
          { once: true },
        )
      })
    },
  }
  const harness = fakeContext({ total: 210, nodes, engine })
  apply(harness.ctx, { compactRetainTokens: 1 })
  const controller = new AbortController()
  const pending = harness.registeredTools[0].execute(
    { action: 'compact' },
    { agent: agentWith([1, 2, 3]), signal: controller.signal },
  )
  await started
  controller.abort()
  const result = await pending
  assert.equal(sawAbort, true)
  assert.match(result.text, /已取消/)
})

test('成功冷却按当前配置实时重算，热更新为 0 后立即解除', async () => {
  let cooldown = 60_000
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
  ]
  let calls = 0
  const harness = fakeContext({
    total: 210,
    nodes,
    engine: {
      async compactRegion() {
        calls += 1
        return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 4 }
      },
    },
  })
  apply(harness.ctx, {
    compactRetainTokens: 1,
    compactCooldownMs: { get: () => cooldown },
  })
  const agent = agentWith([1, 2, 3])
  const tool = harness.registeredTools[0]
  assert.match((await tool.execute({ action: 'compact' }, { agent })).text, /精确压缩完成/)
  cooldown = 0
  harness.listeners.get('loader/volatile-update')()
  const second = await tool.execute({ action: 'compact' }, { agent })
  assert.match(second.text, /精确压缩完成/)
  assert.equal(calls, 2)
})

test('reconcile 区分 exact 与 prefix16，不把 16 字前缀命中说成整条可查', async () => {
  const root = join(tmpdir(), `stage-handoff-reconcile-prefix-${process.pid}-${Date.now()}`)
  const stage = '261118-0000-prefix'
  const canonical = '这一段约束的正文前半段足够十六个字但后半段并不在摘要里'
  try {
    await mkdir(join(root, stage), { recursive: true })
    await writeFile(
      join(root, stage, 'anchor.md'),
      ['# prefix', '', '## 硬约束', `- [实测] ${canonical}`, ''].join('\n'),
      'utf8',
    )
    const session = {
      id: 'prefix',
      seq: 3,
      surface: { nodes: [] },
      snapshotEvents: () => [
        { seq: 0, type: 'turn/start' },
        { seq: 1, type: 'turn/end' },
        {
          seq: 2,
          type: 'compaction/summary',
          data: { summary: [{ type: 'text', text: canonical.slice(0, 16) }] },
        },
      ],
    }
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const result = await harness.registeredTools[0].execute(
      { action: 'reconcile', stage },
      { agent: { session, ctx: { get: () => undefined } } },
    )
    assert.match(result.text, /exact=0、prefix16=1、none=0/)
    assert.match(result.text, /不等于整条逐字可查/)
    assert.doesNotMatch(result.text, /全文命中/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('热停用后 session/event listener 不再继续扩充事件环', async () => {
  let enabled = true
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, { enabled: { get: () => enabled }, reportToolFacts: true })
  const session = {
    id: 'gate',
    seq: 4,
    surface: { nodes: [] },
    snapshotEvents: () => [],
  }
  const listener = harness.listeners.get('session/event')
  listener(session, {
    seq: 1,
    type: 'tool/call',
    data: { callId: 'visible', arguments: JSON.stringify({ path: 'visible.ts' }) },
  })
  enabled = false
  harness.listeners.get('loader/volatile-update')()
  listener(session, {
    seq: 2,
    type: 'tool/call',
    data: { callId: 'hidden', arguments: JSON.stringify({ path: 'hidden.ts' }) },
  })
  enabled = true
  harness.listeners.get('loader/volatile-update')()
  const status = await harness.registeredTools[0].execute(
    { action: 'status' },
    { agent: { session, ctx: { get: () => undefined } } },
  )
  assert.match(status.text, /visible\.ts/)
  assert.doesNotMatch(status.text, /hidden\.ts/)
})

test('find-session 只把 ENOENT 当未命中，其他扫描错误进入不完整报告', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js'),
    'utf8',
  )
  assert.match(source, /if \(error\?\.code === 'ENOENT'\) continue/)
  assert.match(source, /扫描不完整：有 \$\{formatCount\(scanErrorCount\)\} 条路径无法确认/)
  assert.match(source, /无法确认会话 .* 是否存在/)
})

test('设置页 pending 用 Map 和单调 token，跨字段与同字段并发不会互相清掉', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'),
    'utf8',
  )
  assert.match(source, /const \[pending, setPending\] = useState\(\(\) => new Map\(\)\)/)
  assert.match(source, /pendingToken\.current \+= 1/)
  assert.match(source, /current\.get\(key\) !== token/)
  assert.match(source, /pending\.size/)
})

test('guardMaxBytes 与 staleReservationTtlMs 的解析器与 Host schema 接受同一个集合', () => {
  // schema 用 [65536, 16777216] / [60000, 30d]；解析器若只查 1..MAX_CONFIG_INTEGER，
  // 就会出现「设置页拒绝、直接 apply 却能跑」的反向不一致。
  for (const value of [1, 1024, 65_535, 16_777_217, 1_000_000_000]) {
    assert.throws(() => resolveConfig({ guardMaxBytes: value }), /guardMaxBytes/)
  }
  for (const value of [65_536, 1_048_576, 16_777_216]) {
    assert.equal(resolveConfig({ guardMaxBytes: value }).guardMaxBytes, value)
  }
  for (const value of [1, 59_999, 604_800_001, 1_000_000_000]) {
    assert.throws(() => resolveConfig({ staleReservationTtlMs: value }), /staleReservationTtlMs/)
  }
  for (const value of [60_000, 86_400_000, 604_800_000]) {
    assert.equal(resolveConfig({ staleReservationTtlMs: value }).staleReservationTtlMs, value)
  }
})

test('诊断写入成功后清空 error()，降级事实保留在 notice()', async () => {
  const dir = join(tmpdir(), `stage-handoff-probe-clear-${process.pid}-${Date.now()}`)
  try {
    await mkdir(dir, { recursive: true })
    const probePath = join(dir, '.probe.jsonl')
    // 先用目录占住路径：open(..., 'a') 必然失败，制造一次真实写入错误。
    await mkdir(probePath)
    const writer = createBoundedJsonlWriter(probePath, 1024)
    await writer.append({ kind: 'fail' })
    assert.notEqual(writer.error(), undefined, '写入失败应记录在 error()')

    // 清掉占位目录后重写：成功即应清空 error()，不让 status 永久停在「写入失败」。
    await rm(probePath, { recursive: true, force: true })
    await writer.append({ kind: 'ok' })
    assert.equal(writer.error(), undefined)

    // 既有文件超限被重置属于「降级写入」，不是错误：进 notice()。
    const oversized = join(dir, '.oversized.jsonl')
    await writeFile(oversized, 'x'.repeat(200))
    const resetWriter = createBoundedJsonlWriter(oversized, 100)
    await resetWriter.append({ kind: 'after-reset' })
    assert.equal(resetWriter.error(), undefined)
    assert.match(String(resetWriter.notice()), /已重置/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('host-only 投影能复现压缩后的 surface replace，坏区间 fail-closed', () => {
  // 投影的 replace 分支此前覆盖率为 0：测试里的 fake projection 最后会用
  // session.surface.nodes 覆盖结果，绕过了 apply() 本身的 replace 逻辑。
  // 这里直接驱动导出的投影定义，测的就是生产代码走的那条 fold。
  const def = SESSION_FACTS_PROJECTION

  let state = def.init()
  const append = (seq) => {
    state = def.apply(state, { seq, type: 'user/message', surfaceOp: 'append' })
  }
  for (let seq = 0; seq <= 4; seq += 1) append(seq)
  // 用 seq5 的摘要节点替换 surface 位置 1..3（seq 1,2,3）。
  state = def.apply(state, {
    seq: 5,
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 },
    data: { source: { kind: 'compact-checkpoint' } },
  })
  append(6)

  assert.deepEqual(
    state.surface.map((node) => node.seq),
    [0, 5, 4, 6],
    'replace 之后的 surface 必须与引擎写入的形状一致',
  )
  assert.deepEqual(
    state.surface.filter((node) => node.checkpoint === true).map((node) => node.seq),
    [5],
    '只有摘要节点带 checkpoint 标记',
  )
  assert.equal(state.invalidReason, undefined)

  // 区间在投影里找不到时必须 fail-closed，而不是猜一个位置。
  let broken = def.init()
  broken = def.apply(broken, { seq: 0, type: 'user/message', surfaceOp: 'append' })
  broken = def.apply(broken, {
    seq: 1,
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 99, endSeq: 100 },
  })
  assert.match(String(broken.invalidReason), /does not match/)
})

test('平衡守卫不合格时 keepFromIdx 回退一格，压缩区间随之收窄', async () => {
  // `keepFromIdx -= 1` 此前从未被执行：其它压缩测试的 guard 恒为 true。
  const guardCalls = []
  const calls = []
  const engine = {
    async compactRegion(start, end) {
      calls.push({ start, end })
      return { shadowedSeqs: [start], shadowedTokenCount: 10, summarySeq: 6 }
    },
  }
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
    { seq: 4, tokens: 100 },
  ]
  const harness = fakeContext({
    total: 310,
    nodes,
    engine,
    // seq3 处切开会裂开 tool 配对；seq2 处是平衡的。
    balanceGuard: (_session, seq) => {
      guardCalls.push(Number(seq))
      return Number(seq) !== 3
    },
  })
  apply(harness.ctx, { compactRetainTokens: 150 })
  const tool = harness.registeredTools[0]
  const agent = agentWith([1, 2, 3, 4], { eventType: () => ({ type: 'message' }) })

  const result = await tool.execute({ action: 'compact' }, { agent })
  assert.match(result.text, /精确压缩完成/)
  assert.deepEqual(guardCalls.slice(0, 2), [3, 2], '先查到 seq3 不平衡，再退到 seq2')
  assert.deepEqual(calls, [{ start: 1, end: 1 }], '回退后区间收窄到第一个节点')
})

test('自动压缩 skipped 同因只解释一次，但不再吞掉收尾提醒', async () => {
  let current = 860000
  const harness = fakeContext({ total: current, nodes: [], engine: undefined })
  apply(harness.ctx, {
    notifyTokens: 100000,
    notifyRepeatDelta: 25000,
    notifyCooldownMs: 0,
    compactCooldownMs: 60000,
    agentDecidesCompaction: false,
  })
  // total 需要在三次 pre-step 之间变化，替换掉固定替身。
  harness.ctx.tokenMeter.measure = () => ({ totalTokens: current, nodes: [] })
  harness.ctx.tokenMeter.contextPressure = () => ({ contextWindow: 1000000 })

  const agent = agentWith([0], { eventType: () => ({ type: 'message' }) })
  const onEvent = harness.listeners.get('session/event')
  onEvent?.(agent.session, { seq: 0, type: 'user/message', surfaceOp: 'append' })
  const listener = harness.listeners.get('agent/pre-step')

  const first = await runPreStep(listener, { agent })
  assert.ok(
    first.messages.some((m) => String(m?.content?.[0]?.text ?? '').includes('自动压缩未完成')),
    '首次失败应可见',
  )

  current = 890000
  const second = await runPreStep(listener, { agent })
  assert.ok(
    second.messages.some((m) => String(m?.content?.[0]?.text ?? '').includes('没有启动')),
    '退避中的 skipped 应解释一次',
  )

  current = 920000
  const third = await runPreStep(listener, { agent })
  const thirdText = third.messages.map((m) => String(m?.content?.[0]?.text ?? '')).join('\n')
  assert.ok(third.messages.length > 0, '同因 skip 不得把整条提醒吞掉')
  assert.match(thirdText, /该进入阶段收尾了|上下文已到/, '普通收尾提醒必须照发')
  assert.doesNotMatch(thirdText, /没有启动/, '同一原因不该再解释一次')
})

test('cleanup 在被截断时报出真正的截断来源（根目录 vs detail）', async () => {  const tempRoot = join(tmpdir(), `stage-handoff-cleanup-src-${process.pid}-${Date.now()}`)
  try {
    const harness = fakeContext({ total: 100, nodes: [], engine: undefined })
    apply(harness.ctx, { anchorRoot: tempRoot, keepAnchorBackups: 1 })
    const tool = harness.registeredTools[0]
    const agent = agentWith([])

    // 变体 A：根目录条目超过 2000 —— 来源应是「锚点根目录」。
    await mkdir(tempRoot, { recursive: true })
    for (let index = 0; index < 2001; index += 1) {
      await writeFile(join(tempRoot, `filler-${index}.txt`), 'x')
    }
    const rootResult = await tool.execute({ action: 'cleanup' }, { agent })
    assert.match(rootResult.text, /这个结论不完整/)
    assert.match(rootResult.text, /锚点根目录扫描提前停止/)

    // 变体 B：只有一个阶段，但 detail/ 超过 200 项 —— 来源应是 detail/。
    await rm(tempRoot, { recursive: true, force: true })
    const stageDir = join(tempRoot, '261119-1500-detail-src')
    await mkdir(join(stageDir, 'detail'), { recursive: true })
    await writeFile(join(stageDir, 'anchor.md'), '# anchor')
    for (let index = 0; index < 201; index += 1) {
      await writeFile(join(stageDir, 'detail', `d-${index}.md`), 'x')
    }
    const detailResult = await tool.execute({ action: 'cleanup' }, { agent })
    assert.match(detailResult.text, /261119-1500-detail-src\/detail\/ 扫描提前停止/)
    assert.doesNotMatch(detailResult.text, /锚点根目录扫描提前停止/)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('anchorTimeZone 的 schema 正则与 normalizeTimeZone 接受同一个集合', () => {
  // 危险方向只有一个：schema 收、解析器拒 —— 那会在挂载期直接抛错。
  const accepted = ['+8', '-5', '+05:30', '+0530', '-300', '-720', '+840', '+14', '-12', '+830', '+08:00', '-11:59', 'local', 'utc', 'z']
  for (const value of accepted) {
    assert.equal(TIME_ZONE_PATTERN.test(value), true, `${value} 应被 schema 接受`)
    assert.notEqual(normalizeTimeZone(value), undefined, `${value} 应能被解析`)
  }
  const rejected = ['-745', '+900', '-830', '+999', '-999', '+14:30', '-12:30', '+1500']
  for (const value of rejected) {
    assert.equal(TIME_ZONE_PATTERN.test(value), false, `${value} 不应穿过 schema`)
    assert.equal(normalizeTimeZone(value), undefined, `${value} 不应被解析`)
  }
})

test('staleReservationTtlMs 的 schema 也拒绝小数，与解析器的整数要求一致', () => {
  assert.throws(() => Config({ staleReservationTtlMs: 90_000.5 }))
  assert.doesNotThrow(() => Config({ staleReservationTtlMs: 90_000 }))
})

test('readLatest 的谓词抛错不会被当作「行撕裂」吞掉', async () => {  const dir = join(tmpdir(), `stage-handoff-probe-predicate-${process.pid}-${Date.now()}`)
  try {
    await mkdir(dir, { recursive: true })
    const probePath = join(dir, '.probe.jsonl')
    const writer = createBoundedJsonlWriter(probePath, 1024)
    await writer.append({ kind: 'pre-step', at: 1 })
    await assert.rejects(
      writer.readLatest(() => {
        throw new Error('predicate bug')
      }),
      /predicate bug/,
    )
    // 正常谓词仍然能读到记录。
    const row = await writer.readLatest((entry) => entry.kind === 'pre-step')
    assert.equal(row?.kind, 'pre-step')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('降级写入的 notice 带时间前缀（否则会以「最近一次」的口吻永久显示）', async () => {
  const dir = join(tmpdir(), `stage-handoff-probe-notice-${process.pid}-${Date.now()}`)
  try {
    await mkdir(dir, { recursive: true })
    const probePath = join(dir, '.probe.jsonl')
    await writeFile(probePath, 'x'.repeat(200))
    const writer = createBoundedJsonlWriter(probePath, 100)
    await writer.append({ kind: 'after-reset' })
    assert.match(String(writer.notice()), /^\d{2}-\d{2} \d{2}:\d{2} /)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('坏配置不会让插件挂载失败，而是在 status 里说明已降级', async () => {  const harness = fakeContext({ total: 100, nodes: [], engine: undefined })
  assert.doesNotThrow(() => apply(harness.ctx, { anchorTimeZone: '-745' }))
  assert.equal(harness.registeredTools.length, 1, '降级后入口仍应注册')
  const tool = harness.registeredTools[0]
  const result = await tool.execute({ action: 'status' }, { agent: agentWith([]) })
  assert.match(result.text, /配置降级/)
  assert.match(result.text, /anchorTimeZone/)
})

test('dshHome 必须是绝对路径：相对路径与 ~ 开头都会被拒绝', () => {
  // 相对路径会被 join(dshHome,'sessions') 按 process.cwd() 解析 —— 那是当前项目，
  // 不是 DSH 数据根；命不中时面板只会说「目录还不存在」。
  assert.throws(() => resolveConfig({ dshHome: 'data' }), /dshHome/)
  assert.throws(() => resolveConfig({ dshHome: '~/dsh-home' }), /dshHome/)
  assert.equal(resolveConfig({ dshHome: '' }).dshHome, '')
  // `isAbsolutePathInput` 在 POSIX 上只认前导 `/` —— `D:\x` 在 Linux 上确实不是绝对路径，
  // 这是设计而不是缺陷。所以「合法绝对路径」的样本必须按平台取，否则这条测试自己在
  // ubuntu 上就是红的（它红了很久，因为 CI 在加进来之后一直没跑过）。
  const nativeAbs = process.platform === 'win32' ? 'D:\\DeepSeekHarness\\data' : '/dsh-data'
  assert.equal(resolveConfig({ dshHome: nativeAbs }).dshHome, nativeAbs)
})

test('dshHome 的 schema 与解析器同源：相对路径在两层都被拒', () => {
  // schema 曾经是裸 `string()`：YAML 里写 `dshHome: data` 能过 schema 校验，
  // 再被 `resolveConfigLenient` 逐字段丢掉 —— 用户看到的是「配置里明明写了，
  // 面板却说没生效」。这是 `anchorRoot` 之后最后一个「schema 放行、解析器拒绝」
  // 的键，两处必须同一条判据。
  for (const bad of ['data', '~/dsh', 'C:rel', '..', 'a/b']) {
    assert.throws(() => Config({ dshHome: bad }), `schema 应当拒绝 dshHome=${JSON.stringify(bad)}`)
    assert.throws(() => resolveConfig({ dshHome: bad }), `解析器应当拒绝 dshHome=${JSON.stringify(bad)}`)
  }
  // 同一条平台规则：POSIX 只认前导 `/`，Windows 盘符与 UNC 在那里不是绝对路径。
  const nativeAbs = process.platform === 'win32' ? 'D:\\dsh' : '/dsh'
  const acceptList = ['', '   ', nativeAbs, '/data', ` ${nativeAbs} `]
  if (process.platform === 'win32') acceptList.push('\\\\server\\share')
  for (const ok of acceptList) {
    assert.doesNotThrow(() => Config({ dshHome: ok }), `schema 应当接受 dshHome=${JSON.stringify(ok)}`)
    assert.equal(typeof resolveConfig({ dshHome: ok }).dshHome, 'string')
  }
})

test('压缩成功后第一次 pre-step 注入「先读锚点」提醒，且只注入一次', async () => {
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, undefined)
  const agent = agentWith([1, 2, 3])
  harness.listeners.get('session/event')(agent.session, {
    seq: 4,
    type: 'compaction/end',
    data: { compactionId: 'c1', turn: 1 },
  })

  const first = await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  assert.equal(first.messages.length, 2, '压缩后第一次进入应多一条锚点提醒')
  const text = first.messages[1].content[0].text
  assert.match(text, /\[stage-handoff\] 压缩刚完成/)
  assert.match(text, /anchor\.md/)
  assert.match(text, /Next Step/)
  assert.match(text, /docs\/anchors/, '提醒里必须点名 anchorRoot')

  const second = await runPreStep(harness.listeners.get('agent/pre-step'), { agent, step: 2 })
  assert.equal(second.messages.length, 1, '同一次压缩只提醒一次')
})

test('压缩失败（compaction/end 带 error）不注入锚点提醒', async () => {
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, undefined)
  const agent = agentWith([1, 2, 3])
  harness.listeners.get('session/event')(agent.session, {
    seq: 4,
    type: 'compaction/end',
    data: { compactionId: 'c1', turn: 1, error: { name: 'Error', message: 'summary failed' } },
  })

  const decision = await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  assert.equal(decision.messages.length, 1, '失败的压缩没有产物可误导模型，不该提醒')
})

test('notifyAfterCompaction 默认开启，关掉后不再注入', async () => {
  assert.equal(resolveConfig(undefined).notifyAfterCompaction, true)

  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, { notifyAfterCompaction: false })
  const agent = agentWith([1, 2, 3])
  harness.listeners.get('session/event')(agent.session, {
    seq: 4,
    type: 'compaction/end',
    data: { compactionId: 'c1', turn: 1 },
  })

  const decision = await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  assert.equal(decision.messages.length, 1)
})

test('压缩后提醒与提醒线无关：远低于阈值也照发', async () => {
  // total=100 远低于 notifyTokens=1000，普通收尾提醒不可能触发；
  // 但这条提醒绑定的是「压缩刚发生」，不是水位。
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, { notifyTokens: 1000 })
  const agent = agentWith([1, 2, 3])
  harness.listeners.get('session/event')(agent.session, {
    seq: 4,
    type: 'compaction/end',
    data: { compactionId: 'c1', turn: 1 },
  })

  const decision = await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  assert.equal(decision.messages.length, 2, '低水位下这条提醒仍然要发')
  assert.doesNotMatch(decision.messages[1].content[0].text, /该进入阶段收尾了/)
})

test('非 enter 决策不注入，标记留到下一次进入', async () => {
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, undefined)
  const agent = agentWith([1, 2, 3])
  harness.listeners.get('session/event')(agent.session, {
    seq: 4,
    type: 'compaction/end',
    data: { compactionId: 'c1', turn: 1 },
  })

  const listener = harness.listeners.get('agent/pre-step')
  const payload = { agent, messages: [], turn: 1, step: 1, signal: { aborted: false } }
  const stopped = await listener(payload, async () => ({ kind: 'stop' }))
  assert.equal(stopped.kind, 'stop')

  const entered = await listener(payload, async () => ({ kind: 'enter', messages: [{ id: 'existing' }] }))
  assert.equal(entered.messages.length, 2, '标记不能在非 enter 决策上被消费掉')
})

test('status 报告会话内压缩次数，≥2 次时说明摘要已叠过', async () => {
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, undefined)
  const agent = agentWith([1, 2, 3])
  const onEvent = harness.listeners.get('session/event')
  const tool = harness.registeredTools[0]

  const zero = await tool.execute({ action: 'status' }, { agent })
  assert.match(zero.text, /会话内压缩：0 次/)

  onEvent(agent.session, {
    seq: 4,
    type: 'compaction/end',
    data: { compactionId: 'c1', turn: 1 },
  })
  const once = await tool.execute({ action: 'status' }, { agent })
  assert.match(once.text, /会话内压缩：1 次/)
  assert.doesNotMatch(once.text, /重写 1 轮/, '第一次压缩没有旧摘要可叠，不该警告')

  onEvent(agent.session, {
    seq: 5,
    type: 'compaction/end',
    data: { compactionId: 'c2', turn: 2 },
  })
  const twice = await tool.execute({ action: 'status' }, { agent })
  assert.match(twice.text, /会话内压缩：2 次/)
  assert.match(twice.text, /重写 1 轮/)
  assert.match(twice.text, /reconcile/)
})

test('失败的压缩不计入会话内压缩次数', async () => {
  const harness = fakeContext({ total: 100 })
  apply(harness.ctx, undefined)
  const agent = agentWith([1, 2, 3])
  harness.listeners.get('session/event')(agent.session, {
    seq: 4,
    type: 'compaction/end',
    data: { compactionId: 'c1', turn: 1, error: { name: 'Error', message: 'summary failed' } },
  })

  const status = await harness.registeredTools[0].execute({ action: 'status' }, { agent })
  assert.match(status.text, /会话内压缩：0 次/)
})

test('第二次压缩后的收尾提醒点明摘要已在上一次摘要上重写', () => {
  const config = resolveConfig(undefined)
  const first = noticeText(350000, 1000000, config, undefined, 'session-x', 1)
  assert.doesNotMatch(first, /本会话已压缩/)
  assert.doesNotMatch(first, /以锚点和 detail 文档为准/)

  const second = noticeText(350000, 1000000, config, undefined, 'session-x', 2)
  assert.match(second, /本会话已压缩 2 次/)
  assert.match(second, /以锚点和 detail 文档为准/)
  // 警告必须落在「本条是一次性提醒」之前，否则模型会先读到「按摘要行事」的收尾指令。
  assert.ok(
    second.indexOf('本会话已压缩 2 次') < second.indexOf('本条是一次性提醒'),
    '警告要在收尾指令之前出现',
  )
})


// ─── 全量审查修复的回归（261119-2341-full-audit） ─────────────────────────────
// 走**生产调用路径**（真实 apply + 真实工具调用），不调缺陷下面那一层。

test('compact 在没有 session 时给文案，而不是在 WeakSet 上抛 TypeError（守卫回归）', async () => {
  // 同一函数里 defer / reset 都把「没有 session」当成可预期的宿主状态并给了文案，
  // 说明它是可达的；只有 compact 这一支直接 `manualCompacting.add(undefined)`。
  const harness = fakeContext({ total: 100, nodes: [] })
  apply(harness.ctx, undefined)
  const tool = harness.registeredTools[0]

  const result = await tool.execute({ action: 'compact' }, { agent: { id: 'no-session' } })
  assert.match(result.text, /没有 session/)
})

test('兜底压缩成功后必须清掉提醒配额，不能用压缩前的总量记账（配额回归）', async () => {
  // 真实缺陷：兜底压缩成功分支只置 `consumeNotifyQuota = true`，于是
  // `lastNotified` 写下的是**压缩前**的 total。下一轮判断走
  // `total - previous.total < notifyRepeatDelta` —— 压完总量变小、差值是负的，
  // 提醒被这个「增长闸」无限期压住，挂在 `!reminderBlocked` 上的兜底压缩也一起哑掉。
  // 模拟器实测：total 900,010 兜底压缩成功后，下一次 420,000（远超 100,000 的线）
  // 不再提醒，清掉配额后才提醒。
  // token 分布必须与 total 同量级：`compactRetainTokens: 32_000` 意味着可压区间
  // 至少要大于它，否则 selectRetainedRange 选不出区间、引擎根本不会被调用
  // （第一版用了 260 tokens 的节点，测试红在「前提：兜底压缩确实执行了」）。
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 200_000 },
    { seq: 3, tokens: 200_000 },
    { seq: 4, tokens: 200_000 },
  ]
  let total = 900_010
  const compactions = []
  const engine = {
    async compactRegion(start, end) {
      compactions.push([start, end])
      // 真的压缩了：占用降下来，否则下面的 420,000 不成立。
      total = 420_000
      return { shadowedSeqs: [2], shadowedTokenCount: 400_000, summarySeq: 5 }
    },
  }
  // 900,010 / 1,000,000 = 90% > 85% 兜底线。
  // `total` 传函数（每次 measure 重新取值），这处 cast 是给 tsc 看的：
  // 解构参数的 JSDoc 不会把 total 的类型扩宽成 union。
  const harness = fakeContext(
    /** @type {any} */ ({ total: () => total, window: 1_000_000, nodes, engine }),
  )
  apply(harness.ctx, {
    notifyTokens: 100_000,
    notifyRepeatDelta: 25_000,
    notifyCooldownMs: 0,
    agentDecidesCompaction: false,
    compactCooldownMs: 0,
    compactRetainTokens: 32_000,
  })
  const agent = agentWith([1, 2, 3, 4], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  const preStep = harness.listeners.get('agent/pre-step')

  // 0) 先让插件正常提醒一次，把提醒配额写上。这一步是必需的 —— 没有它，
  //    下面的压缩会把「根本没有旧配额」误当成「配额被清掉了」。
  total = 500_000 // 低于 850,000 的兜底线，但远高于 100,000 的提醒线
  const zeroth = await runPreStep(preStep, { agent })
  assert.equal(zeroth.messages.length, 2, '前提：先正常提醒一次')
  assert.equal(compactions.length, 0, '前提：这一轮不该压缩')

  // 1) 占用涨到 900,010 → 越兜底线 → 压缩成功 → 本轮不该再发「该收尾了」
  //    （那条描述的是压缩前的占用，发出去自相矛盾）。
  total = 900_010
  const first = await runPreStep(preStep, { agent })
  assert.equal(compactions.length, 1, '前提：兜底压缩确实执行了')
  assert.equal(first.messages.length, 1, '压缩刚成功，本轮不该再发基于压缩前总量的提醒')

  // 2) 占用降到 420,000（压缩真的生效），仍远高于 100,000 的提醒线。
  //    此时配额里如果还留着 500,000，差值 -80,000 永远越不过增长闸 → 提醒消失；
  //    压缩成功清掉配额，这一步才发得出来。
  total = 420_000
  const second = await runPreStep(preStep, { agent })
  assert.equal(second.messages.length, 2, '压缩之后占用仍在线以上时必须重新提醒')
})

test('defer tokens=off 只关提醒，不能顺带关掉兜底压缩（安全阀回归）', async () => {
  // `effectiveNotifyFor` 在 off 时返回 MAX_SAFE_INTEGER，而 pre-step 的早退条件
  // 和兜底压缩共用这条线 —— 于是「我不想被提醒」顺带把自动压缩也关了，
  // 而回执只说「本会话的提醒已关闭」。
  // token 分布必须与 total 同量级：`compactRetainTokens: 32_000` 意味着可压区间
  // 至少要大于它，否则 selectRetainedRange 选不出区间、引擎根本不会被调用
  // （第一版用了 260 tokens 的节点，测试红在「前提：兜底压缩确实执行了」）。
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 200_000 },
    { seq: 3, tokens: 200_000 },
    { seq: 4, tokens: 200_000 },
  ]
  const compactions = []
  const engine = {
    async compactRegion(start, end) {
      compactions.push([start, end])
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 5 }
    },
  }
  const harness = fakeContext({ total: 900_010, window: 1_000_000, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100_000,
    agentDecidesCompaction: false,
    compactCooldownMs: 0,
    compactRetainTokens: 32_000,
  })
  const agent = agentWith([1, 2, 3, 4], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  const tool = harness.registeredTools[0]

  const deferred = await tool.execute({ action: 'defer', tokens: 'off' }, { agent })
  assert.match(deferred.text, /提醒已关闭/, '前提：defer=off 必须真的生效')

  const decision = await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  assert.equal(compactions.length, 1, 'defer=off 不该把兜底压缩的闸门一起关掉')
  assert.equal(decision.messages.length, 1, '关闭提醒后确实不该再有提醒')
})

test('引擎 resolve 但不返回结果时，已落盘的成功不能被记成失败（shadowedSeqs 回归）', async () => {
  // turn-stopping 的成功分支曾经无保护地读 `precise.result.shadowedSeqs`：
  // 第三方后端或测试替身那种 `async compactRegion() {}` 返回 undefined，
  // 于是 TypeError 被外层 catch 接住 → markCompactFailure 写退避 →
  // 历史其实已经被摘要改写，插件却记了一次失败并告诉模型「自动压缩未完成」。
  const nodes = [
    { seq: 1, tokens: 100_000 },
    { seq: 2, tokens: 100_000 },
    { seq: 3, tokens: 100_000 },
    { seq: 4, tokens: 10_000 },
  ]
  const compactions = []
  const engine = {
    async compactRegion() {
      compactions.push(1)
      return undefined // 只 resolve，不给结果
    },
  }
  const harness = fakeContext({ total: 310_000, window: 1_000_000, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100_000,
    notifyCooldownMs: 0,
    agentDecidesCompaction: false,
    compactCooldownMs: 0,
    compactRetainTokens: 32_000,
  })
  const agent = agentWith([1, 2, 3, 4], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })

  // 先发一次提醒，把配额写上 —— turn-stopping 只在提醒发过之后才动手。
  await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  await runTurnStopping(harness.listeners.get('agent/turn-stopping'), { agent })

  assert.equal(compactions.length, 1, '前提：引擎确实被调用了一次')
  const failureLogs = harness.logs.filter(
    ([level, message]) => level === 'warn' && /自动压缩失败/.test(message),
  )
  assert.deepEqual(failureLogs, [], '成功路径不能因为读 undefined 字段而变成失败')
})

test('scaffold 的 topic 超长时给可行动提示，不把 rename 的裸 ENOENT 抛出来（边界回归）', async () => {
  // topic 只校验字符集、没有长度上限：时间戳前缀 + 超过 230 字符的 topic 会让
  // final rename 抛 ENOENT，错误里还带着内部 .stage-handoff-tmp-<uuid> 路径。
  const root = await mkdtemp(join(tmpdir(), 'stage-handoff-topic-limit-'))
  try {
    const harness = fakeContext({ total: 100, nodes: [] })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]

    const tooLong = await tool.execute(
      { action: 'scaffold', topic: 'a'.repeat(300) },
      { agent: agentWith([]) },
    )
    assert.match(tooLong.text, /topic 太长/)
    assert.doesNotMatch(tooLong.text, /ENOENT/)

    // 长但合法的 topic 仍要能建出来 —— 上限不能做成误伤。
    const ok = await tool.execute(
      { action: 'scaffold', topic: 'a'.repeat(120) },
      { agent: agentWith([]) },
    )
    assert.match(ok.text, /已创建阶段目录/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('一个字没改的空锚点不能既报「没有标记」又报「未超期」（validate 回归）', async () => {
  // 检查 7 和 [人工明确] 计数曾在**整篇文本**上匹配，命中了 scaffold 骨架自带的
  // 两行说明文字（`（每条标明来源：[人工明确] …`、`   [推断未验证] 自己推出来…`）。
  // 于是一个空锚点同时输出：
  //   ! 没有任何 [推断未验证] 标记 —— 要么全都验证过（少见），要么没在区分
  //   ✓ [推断未验证] 未超期（阶段第 0 天）
  //   ✓ 1 条 [人工明确]（这类不需要日期…）
  const root = await mkdtemp(join(tmpdir(), 'stage-handoff-validate-skeleton-'))
  try {
    const harness = fakeContext({ total: 100, nodes: [] })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    await tool.execute({ action: 'scaffold', topic: 'skeleton' }, { agent: agentWith([]) })

    // 不传 stage，让 validate 走「取最新阶段」这条生产路径。
    const result = await tool.execute({ action: 'validate' }, { agent: agentWith([]) })
    const text = String(result.text ?? '')
    const claimsNoMarker = /没有任何\s*`?\[推断未验证\]`?\s*标记/.test(text)
    const claimsNotStale = /\[推断未验证\][^\n]*未超期/.test(text)
    assert.ok(
      !(claimsNoMarker && claimsNotStale),
      '同一份输出不能同时对 [推断未验证] 给出相反结论',
    )
    assert.doesNotMatch(text, /1 条 \[人工明确\]/, '空骨架里的说明文字不是锚点事实')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('/anchor threshold 的进程内覆盖不会被一次无关的 volatile-update 冲掉（覆盖回归）', async () => {
  // 覆盖值曾经只写进 `config`（`rawConfig` 派生的快照），而
  // `loader/volatile-update` 会用 `resolveConfig(rawConfig)` 整体重算 ——
  // 于是用户在设置面板保存任何一个别的字段，提醒线就悄悄回到 profile 值，
  // 而命令回执承诺的是「仅本进程有效」。
  const raw = { notifyTokens: 100_000 }
  const harness = fakeContext({ total: 400_000, nodes: [] })
  apply(harness.ctx, raw)
  const command = harness.registered[0]
  const agent = agentWith([])
  const run = (rawInput) => command.handler({ agent, rawInput, signal: { aborted: false } })

  const set = run('threshold 300k')
  assert.equal(set.kind, 'success')
  assert.match(set.text, /307,200/, '前提：覆盖本身生效')

  // 模拟面板保存了无关字段：宿主重发同一份 volatile 配置。
  harness.listeners.get('loader/volatile-update')()

  const status = run('status')
  assert.match(status.text, /307,200/, 'volatile-update 不能把进程内覆盖冲掉')
  assert.doesNotMatch(status.text, /提醒线 100,000/)
})

test('status 的「最严重 turn」按严重度取，不能取 Map 里最旧的那个（排序回归）', async () => {
  // `scanEventRing` 按 turn 插入顺序 push，从不排序；status 直接取 `verdicts[0]`
  // 就把**最旧**的 turn 说成「最严重」。而同一份数据走 `describeRepeatRisk`
  // （按 fillers 取 worst）会指向另一个 turn —— 两处结论互相矛盾。
  const harness = fakeContext({ total: 100, nodes: [] })
  apply(harness.ctx, { notifyTokens: 1_000_000 })
  const agent = agentWith([])
  const feed = harness.listeners.get('session/event')
  assert.ok(feed, '前提：session/event 已订阅')

  let seq = 0
  const pushReasoning = (turn, text) => {
    seq += 1
    feed(agent.session, {
      seq,
      type: 'assistant/message',
      data: { turn, message: { content: [{ type: 'reasoning', text }] } },
    })
  }
  // turn 1：轻 —— 4 个碎片块 × 2 行（fillers 8 条，刚好过线）
  for (let step = 0; step < 4; step += 1) pushReasoning(1, '好。\n做。')
  // turn 2：重 —— 同样碎片化，但语气短行多得多
  for (let step = 0; step < 20; step += 1) pushReasoning(2, '好。\n做。')

  const result = await harness.registeredTools[0].execute({ action: 'status' }, { agent })
  const text = String(result.text ?? '')
  assert.match(text, /2 个 turn 已复读/, '前提：两个 turn 都被判成复读')
  assert.match(text, /最严重 turn 2/, '最严重应是 fillers 更多的 turn 2，而不是最旧的 turn 1')
})

test('同一原因的可重试失败第二次出现时，不能吞掉本该发出的收尾提醒（早退回归）', async () => {
  // failed 分支曾经在「上次失败原因相同」时直接 `return withExtraMessages(decision)`
  // —— 与 skipped 分支为同一件事修过的那处一样：那会把本该发出的收尾提醒整条吞掉，
  // 而这类 retryable 失败**故意不写退避**，所以每个重试周期都会丢一次提醒。
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 200_000 },
    { seq: 3, tokens: 200_000 },
    { seq: 4, tokens: 200_000 },
  ]
  const attempts = []
  const engine = {
    async compactRegion() {
      attempts.push(1)
      throw new Error('surface changed during summarization')
    },
  }
  const harness = fakeContext({ total: 900_010, window: 1_000_000, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100_000,
    notifyRepeatDelta: 25_000,
    notifyCooldownMs: 0,
    agentDecidesCompaction: false,
    compactCooldownMs: 0,
    compactRetainTokens: 32_000,
  })
  const agent = agentWith([1, 2, 3, 4], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  const preStep = harness.listeners.get('agent/pre-step')

  const first = await runPreStep(preStep, { agent })
  assert.equal(attempts.length, 1, '前提：第一次确实尝试压缩')
  assert.equal(first.messages.length, 2, '第一次：提醒 + 失败说明合成一条')

  const second = await runPreStep(preStep, { agent })
  assert.equal(attempts.length, 2, '前提：retryable 失败下一步立即重试，不写退避')
  assert.equal(
    second.messages.length,
    2,
    '同一原因的失败第二次出现时只该省略解释，收尾提醒必须照发',
  )
  assert.match(
    String(second.messages[second.messages.length - 1]?.content?.[0]?.text ?? second.messages.at(-1)?.text ?? ''),
    /./,
    '提醒消息必须存在',
  )
})

test('status 里第二次 commands.find 抛错时仍返回已算好的诊断（裸调用回归）', async () => {
  // 同一函数里更早的那次 find 有 try/catch 并给了「不可用（读取 /compact 失败…）」，
  // list 也包在 try 里，只有最后这一次是裸调用 —— 宿主 find 抛错时整个只读诊断
  // 直接抛异常，占用、事件环、复读、工具轨迹全部拿不到。
  const harness = fakeContext({ total: 100, nodes: [], commandFindThrows: true })
  apply(harness.ctx, undefined)
  const result = await harness.registeredTools[0].execute(
    { action: 'status' },
    { agent: agentWith([]) },
  )
  const text = String(result.text ?? '')
  assert.ok(text.length > 0, 'status 必须返回文本，不能抛出去')
  assert.match(text, /读取失败：commands\.find exploded/, '那一次 find 失败要就地降级成一行')
})

/**
 * 取 pre-step 决策里最后一条消息的正文。
 *
 * 提醒、压缩失败说明、压缩后对齐提醒都落在最后这一条上；没有注入时返回空串
 * （原有消息只有 id，没有 content）。
 * @param decision - pre-step 返回的决策。
 * @returns {string}
 */
test('同一进程两份实例不得注入两条逐字相同的提醒（共享闸回归）', async () => {
  // DSH 可以在同一进程里挂多份本插件实例，「同一会话只提醒一次」是**进程级**事实。
  // 旧实现每次 `apply` 新建 lastNotified，于是双实例各注入一条一模一样的提醒：
  // 模型会收到两份同样的收尾指令，占用相同的 token，做同一件事。
  const agent = agentWith(
    [1, 2, 3],
    { eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }) },
  )
  const first = fakeContext({ total: 400_000 })
  const second = fakeContext({ total: 400_000 })
  apply(first.ctx, {})
  apply(second.ctx, {})

  const decisionA = await runPreStep(first.listeners.get('agent/pre-step'), { agent })
  const decisionB = await runPreStep(second.listeners.get('agent/pre-step'), { agent })
  const textA = injectedText(decisionA)
  const textB = injectedText(decisionB)

  const reminders = [textA, textB].filter((text) => /提醒线|收尾|stage_handoff/.test(text)).length
  assert.equal(
    reminders,
    1,
    `同一会话只该有一份实例提醒，实际 A=${JSON.stringify(textA).slice(0, 160)} B=${JSON.stringify(textB).slice(0, 160)}`,
  )
})

test('已停用的实例不得替另一个实例弹掉共享的排队压缩', async () => {
  // `agent/status` 各实例的处理在第一个 await 之前都是同步的，所以先挂载的那份一定
  // 先跑。旧实现在 `!config.enabled` 分支里**无条件**删共享队列：A 被热停用后过 idle，
  // 会把 B 排的 /compact 删掉，而 B 完全静默（自己的回执照样说「已排队」，status 却
  // 变成「无」）。停用只该表示「我不再提供服务」，不该替别人删请求。
  let enabledA = true
  const rawA = { enabled: { get: () => enabledA } }
  const agent = agentWith([1, 2])
  const nodes = [
    { seq: 1, tokens: 250_000 },
    { seq: 2, tokens: 250_000 },
  ]
  // 空 engine ⇒ 精确压缩不可用 ⇒ 走 `/compact` 兜底并排队。
  const first = fakeContext({ total: 500_000, window: 1_000_000, nodes, engine: {} })
  const second = fakeContext({ total: 500_000, window: 1_000_000, nodes, engine: {} })
  apply(first.ctx, rawA)
  apply(second.ctx, {})

  const queued = String(
    (await second.registeredTools[0].execute({ action: 'compact' }, { agent })).text,
  )
  assert.match(queued, /已排队/, `应走兜底排队，实际：${queued.slice(0, 200)}`)

  enabledA = false
  first.listeners.get('loader/volatile-update')()
  await first.listeners.get('agent/status')({ status: 'idle', agent })

  const after = String(
    (await second.registeredTools[0].execute({ action: 'status' }, { agent })).text,
  )
  assert.match(
    after,
    /排队中的压缩请求：有/,
    `停用实例不该弹掉共享队列，实际：${after.slice(0, 240)}`,
  )
})

test('resetSharedGates 夹在两次 apply 之间也不能让共享退化（getter 回归）', async () => {
  // `state` 若在 apply 时**快照**表的引用，`resetSharedGates()` 重新赋值之后：老实例
  // 仍指向旧表、新实例指向新表 —— 共享静默退化成每实例一份，正是 sharedGates 要消灭
  // 的那个 bug，而且测试会照常绿。state 上那五个字段因此是 getter。
  const agent = agentWith([1])
  const first = fakeContext({ total: 100_000, window: 1_000_000 })
  apply(first.ctx, { notifyTokens: 363_520 })
  await first.registeredTools[0].execute({ action: 'defer', tokens: 500_000 }, { agent })

  resetSharedGates()

  const second = fakeContext({ total: 100_000, window: 1_000_000 })
  apply(second.ctx, { notifyTokens: 363_520 })
  const cleared = String(
    (await second.registeredTools[0].execute({ action: 'status' }, { agent })).text,
  )
  assert.match(cleared, /提醒线 363,520/, 'reset 清空登记后应回到配置线')

  // 关键一步：reset 之后老实例写入的登记，新实例仍必须看得见。
  await first.registeredTools[0].execute({ action: 'defer', tokens: 600_000 }, { agent })
  const after = String(
    (await second.registeredTools[0].execute({ action: 'status' }, { agent })).text,
  )
  assert.match(
    after,
    /提醒线 600,000/,
    `reset 之后老实例的新登记仍必须对新实例可见，实际：${after.slice(0, 200)}`,
  )
})

test('闸门挡住提醒时，兜底压缩的失败说明不能把整条收尾提醒带出来', async () => {
  // `gateBlocked` 只挡住了早退，没挡住提醒正文。兜底压缩失败时
  // `compactionFailure !== undefined` 会跳过那个早退，于是被闸门挡住的那一步
  // **照样注入完整收尾提醒**（「该进入阶段收尾了…去 scaffold + compact」）——
  // 而闸门存在的理由正是「step>1 时模型正在干活」。冷却闸与增长闸在这条
  // 随机分支上被整体旁路，同一个 turn 能连收两条。
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
  ]
  const engine = {
    async compactRegion() {
      throw new Error('summarizer exploded')
    },
  }
  const harness = fakeContext({ total: 900_000, window: 1_000_000, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 300_000,
    agentDecidesCompaction: false,
    compactRetainTokens: 150,
    notifyCooldownMs: 300_000,
    compactCooldownMs: 0,
  })
  const agent = agentWith([1, 2, 3])

  // step 1：闸门放行，提醒 + 兜底压缩失败的说明都会出现
  const first = await runPreStep(harness.listeners.get('agent/pre-step'), { agent, step: 1 })
  assert.match(JSON.stringify(first.messages), /该进入阶段收尾了/, '前提：第一条提醒正常落地')

  // step 2：轮次闸 + 冷却闸都该挡。失败说明必须可见，但收尾提醒不能出现。
  const second = await runPreStep(harness.listeners.get('agent/pre-step'), { agent, step: 2 })
  const text = JSON.stringify(second.messages)
  assert.doesNotMatch(
    text,
    /该进入阶段收尾了/,
    '闸门挡住时不能注入收尾提醒（否则冷却闸与增长闸形同不存在）',
  )
  assert.match(text, /自动压缩/, '但兜底压缩失败的原因必须让模型看见')
})

test('hostCompactionWall：宿主墙按 min(0.8W, W−maxTokens−headroom) 算，压力预算为负时不存在', () => {
  // 宿主 `dsh-compaction-basic` 的真实公式（lib/index.js:124-143）。本插件的提醒线、
  // 兜底压缩线、警告阈值全部由它推导，算错的话三条线会一起落在墙的错侧 ——
  // 那正是「兜底线 0.85W 永远晚于墙」这个老缺陷的成因。
  assert.equal(hostCompactionWall(1_048_576, { hostMaxTokens: 256_000 }), 727_040)
  assert.equal(hostCompactionWall(524_288, { hostMaxTokens: 256_000 }), 202_752)
  // 宽窗口上起作用的是压力预算那一支，不是 0.8W
  assert.equal(hostCompactionWall(1_048_576, { hostMaxTokens: 1_000 }), 838_860)
  // 压力预算恰为 0 → 墙不存在
  assert.equal(hostCompactionWall(321_536, { hostMaxTokens: 256_000 }), undefined)
  // 负预算 → 墙不存在（宿主自己会抛 TargetPressureConfigError）
  assert.equal(hostCompactionWall(262_144, { hostMaxTokens: 256_000 }), undefined)
  // 同一个 256k 窗口，把输出预留降到 128k 就可用
  assert.equal(hostCompactionWall(262_144, { hostMaxTokens: 131_072 }), 65_536)
  // 非法窗口
  assert.equal(hostCompactionWall(0, { hostMaxTokens: 256_000 }), undefined)
  assert.equal(hostCompactionWall(Number.NaN, { hostMaxTokens: 256_000 }), undefined)

  // 兜底压缩线 = 墙 × 0.9，且必须真的早于墙（旧实现 0.85W = 891,289 永远晚于 727,040）
  const wall = hostCompactionWall(1_048_576, { hostMaxTokens: 256_000 })
  assert.equal(Math.floor(wall * 0.9), 654_336)
  assert.ok(Math.floor(wall * 0.9) < wall, '兜底线必须早于宿主墙')
  assert.ok(891_289 > wall, '旧 0.85W 的确晚于墙 —— 这就是要改的理由')
})

test('预设的提醒线 = 宿主墙的一半（1M / 512k / 256k 三档都对得上）', () => {
  // 预设里写死的数字必须与公式一致，否则面板上「一键套用」反而会把提醒线放到墙后面。
  const cases = [
    { window: 1_048_576, hostMaxTokens: 256_000, notify: 363_520 },
    { window: 524_288, hostMaxTokens: 256_000, notify: 101_376 },
    { window: 262_144, hostMaxTokens: 131_072, notify: 32_768 },
  ]
  for (const { window, hostMaxTokens, notify } of cases) {
    const wall = hostCompactionWall(window, { hostMaxTokens })
    assert.ok(wall !== undefined, `W=${window} 在 hostMaxTokens=${hostMaxTokens} 下应有墙`)
    assert.equal(Math.floor(wall * 0.5), notify, `W=${window} 的预设提醒线应等于墙的一半`)
    assert.ok(notify < wall, '提醒线必须早于墙')
  }

  // 每档都必须**显式写** hostMaxTokens，包括等于默认值的那两档 —— 否则会残留：
  // 先点 256k 档（写入 131,072）再点 1M 档，131,072 留着，1M 的墙就变成 838,860，
  // 那份 363,520 只剩 43.3% 而不是一半。
  const clientSource = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'),
    'utf8',
  )
  const presetBlock = clientSource.slice(
    clientSource.indexOf('const PRESETS = ['),
    clientSource.indexOf('function Icon('),
  )
  const presetValues = [...presetBlock.matchAll(/values:\s*\{([^}]+)\}/g)]
  assert.equal(presetValues.length, 3, '预设应有三档')
  for (const match of presetValues) {
    assert.match(
      match[1],
      /hostMaxTokens:\s*\d+/,
      `每档预设都必须显式写 hostMaxTokens（否则上一档的值会残留）：${match[1]}`,
    )
  }
})

test('双实例共享：压缩后提醒只注入一次（注入去重表必须是进程级）', async () => {
  // `postCompactionNotice` / `streamNoticeBySession` / `anchorDriftChecked` 曾经是
  // 每实例的 WeakMap，而 `sharedGates` 只共享了互斥闸与提醒配额。于是同进程挂两份
  // 实例时，两个实例各看到自己那份登记、各注入一条**逐字相同**的提醒 ——
  // `docs/PRIVACY.md` 把「at most one per turn」当注入面的缓解措施，该不变量无声失效。
  const agent = agentWith([1, 2, 3])
  const a = fakeContext({ total: 100 })
  apply(a.ctx, undefined)
  const b = fakeContext({ total: 100 })
  apply(b.ctx, undefined)

  // 两个实例都收到同一个 compaction/end（宿主会把事件派发给所有监听器）
  for (const harness of [a, b]) {
    harness.listeners.get('session/event')(agent.session, {
      seq: 9,
      type: 'compaction/end',
      data: { compactionId: 'c1', turn: 1 },
    })
  }

  const first = await runPreStep(a.listeners.get('agent/pre-step'), { agent })
  const second = await runPreStep(b.listeners.get('agent/pre-step'), { agent })
  const injected = [...first.messages.slice(1), ...second.messages.slice(1)]
  const compactionNotices = injected.filter((message) =>
    JSON.stringify(message).includes('压缩刚完成'),
  )
  assert.equal(
    compactionNotices.length,
    1,
    `同一会话同一步只能注入一条「压缩刚完成」，实际 ${compactionNotices.length} 条`,
  )
})

test('双实例共享：A 的 defer 登记在 B 的 status 里也看得见（会话级事实）', async () => {
  // `defer` 登记的是「本会话的提醒线」，不是「某个实例的提醒线」。共享之后两个实例
  // 必须看到同一份登记，否则 B 会按配置线 360k 提醒、A 按 500k 提醒 —— 同一会话
  // 收到两条互相矛盾的话。
  //
  // 这条同时证明五张表是**同一份对象**：它们都来自同一个 `sharedGates`，所以
  // `manualCompacting` / `autoCompacting` / `pendingCompact` 必然同样跨实例可见
  // （`pendingCompact` 的 idle 执行器是「先 delete 再 await」，两个实例撞进来时
  // 第二个在 `has()` 处就退出了，不会重复压）。
  const agent = agentWith([1])
  const first = fakeContext({ total: 100_000, window: 1_000_000 })
  const second = fakeContext({ total: 100_000, window: 1_000_000 })
  apply(first.ctx, { notifyTokens: 363_520 })
  apply(second.ctx, { notifyTokens: 363_520 })

  const raised = await first.registeredTools[0].execute(
    { action: 'defer', tokens: 500_000 },
    { agent },
  )
  assert.match(String(raised.text), /已临时提升到 500,000/)

  const otherStatus = String(
    (await second.registeredTools[0].execute({ action: 'status' }, { agent })).text,
  )
  assert.match(
    otherStatus,
    /提醒线 500,000/,
    `另一个实例必须看到同一份 defer 登记，实际：${otherStatus.slice(0, 200)}`,
  )
})

function injectedText(decision) {
  const message = Array.isArray(decision?.messages) ? decision.messages.at(-1) : undefined
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
}

test('状态机：排队 /compact 退 no-op（无 sourceEventSeq）不能记成成功', async () => {
  // `command-compact` 在没有可压历史时也返回 `kind:"success"`（文本
  // "No compactable history yet."）。与真压缩唯一的可判别差别是**缺 `sourceEventSeq`**。
  // 旧实现只看 kind，于是这次 no-op 一起做错三件事：写 60 s 成功冷却（后续手压全被拒）、
  // 清掉待告知的 turn-stopping 失败提示、清掉提醒配额（而占用根本没变）。
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 200_000 },
    { seq: 3, tokens: 200_000 },
  ]
  /** @type {{ compactRegion?: (start?: unknown, end?: unknown) => Promise<unknown> }} */
  const engine = {
    async compactRegion() {
      // 第一次（turn-stopping）撞上 surface race：可重试且**不写退避**，
      // 正好留下需要的中间态 —— 有失败提示，却没有闸门挡住后面的手动压缩。
      throw new Error('compaction: session surface changed during summarization')
    },
  }
  const harness = fakeContext({
    total: 500_000,
    window: 1_000_000,
    nodes,
    engine,
    executeResult: { result: { kind: 'success', text: 'No compactable history yet.' } },
  })
  apply(harness.ctx, {
    notifyTokens: 100_000,
    agentDecidesCompaction: false,
    compactCooldownMs: 60_000,
  })
  const agent = agentWith([1, 2, 3], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  const preStep = harness.listeners.get('agent/pre-step')
  const tool = harness.registeredTools[0]

  // 1) 先发一次提醒：turn-stopping 只在提醒真的落地之后才动手。
  const first = await runPreStep(preStep, { agent })
  assert.equal(first.messages.length, 2, '前提：先正常提醒一次')

  // 2) turn-stopping 撞上 surface race → 留下「待告知的失败」，但没有退避。
  await runTurnStopping(harness.listeners.get('agent/turn-stopping'), { agent })
  const midStatus = await tool.execute({ action: 'status' }, { agent })
  assert.match(midStatus.text, /待告知的压缩失败/, '前提：turn-stopping 的失败已记下')
  assert.doesNotMatch(midStatus.text, /压缩退避中/, '前提：可重试的 race 不写退避')

  // 3) 引擎随后不可用 → 手动压缩改走「借壳 /compact」的排队路径。
  delete engine.compactRegion
  const queued = await tool.execute({ action: 'compact' }, { agent })
  assert.match(queued.text, /已排队压缩/, '前提：手动压缩已排队')

  // 4) agent 进入 idle：排队的 /compact 执行，引擎回的是 no-op（无 sourceEventSeq）。
  await harness.listeners.get('agent/status')({ status: 'idle', agent })
  assert.equal(harness.executeCalls.length, 1, '前提：排队的 /compact 确实执行了')

  // (a) no-op 不是成功：不能写 60 s 成功冷却，下一次手动压缩必须还能提交。
  const second = await tool.execute({ action: 'compact' }, { agent })
  assert.doesNotMatch(second.text, /压缩冷却中/, 'no-op 不能写成功冷却')
  assert.match(second.text, /已排队压缩/, '下一次手动压缩应照常排队')

  // (b) no-op 不是成功：不能清掉待告知的 turn-stopping 失败提示。
  const next = await runPreStep(preStep, { agent, turn: 2 })
  assert.match(
    injectedText(next),
    /surface changed during summarization/,
    '上一次的压缩失败原因必须仍然可见',
  )
})

test('排队 /compact 真成功必须写冷却并清掉待告知失败（成功分支的正向覆盖）', async () => {
  // 上面那条钉的是「no-op 不是成功」。反过来「真成功」这条分支也必须有用例经过：
  // `command-compact` 对没有可压历史的情况也回 `kind: 'success'`，唯一可判别的
  // 差别就是有没有 `sourceEventSeq`。缺了这条正向覆盖，把成功条件改成 `if (false)`
  // 全量测试仍然是绿的（审查员实测过），而冷却与配额清理就静默失效了。
  const nodes = [
    { seq: 1, tokens: 200_000 },
    { seq: 2, tokens: 200_000 },
    { seq: 3, tokens: 100_000 },
  ]
  const engine = {
    async compactRegion() {
      throw new Error('compaction: session surface changed during summarization')
    },
  }
  // 缺省 executeResult 带回 `sourceEventSeq` —— 也就是「真的压成了」。
  const harness = fakeContext({ total: 500_000, window: 1_000_000, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100_000,
    agentDecidesCompaction: false,
    compactCooldownMs: 60_000,
  })
  const agent = agentWith([1, 2, 3], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  const preStep = harness.listeners.get('agent/pre-step')
  const tool = harness.registeredTools[0]

  await runPreStep(preStep, { agent })
  await runTurnStopping(harness.listeners.get('agent/turn-stopping'), { agent })
  const midStatus = await tool.execute({ action: 'status' }, { agent })
  assert.match(midStatus.text, /待告知的压缩失败/, '前提：turn-stopping 的失败已记下')

  delete engine.compactRegion
  const queued = await tool.execute({ action: 'compact' }, { agent })
  assert.match(queued.text, /已排队压缩/, '前提：手动压缩已排队')

  await harness.listeners.get('agent/status')({ status: 'idle', agent })
  assert.equal(harness.executeCalls.length, 1, '前提：排队的 /compact 确实执行了')

  // 成功 ⇒ 待告知的失败被清掉（不是「再解释一次」）。
  const after = await tool.execute({ action: 'status' }, { agent })
  assert.doesNotMatch(after.text, /待告知的压缩失败/, '真成功之后待告知的失败必须被清掉')

  // 成功 ⇒ 写入成功冷却，下一次手动压缩不能立刻再来一次。
  const next = await tool.execute({ action: 'compact' }, { agent })
  assert.match(next.text, /压缩冷却中/, '真成功必须写冷却，下一次要撞冷却')
})

test('状态机：兜底压缩 no-op 必须记账并只报一次（连续三个 turn 的第一步不再重复注入）', async () => {
  // no-op（没有可压区间）以前**没有分支**：`consumeNotifyQuota` 保持 false，
  // `lastNotified` 永不写入，于是增长闸与时间闸都因 `previous === undefined` 失效 ——
  // 每个 turn 的第一步都重发同一条收尾提醒，而 status 还显示「提醒配额：未触发」。
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 600_000 },
  ]
  const engine = {
    async compactRegion() {
      throw new Error('no-op 不该调用引擎')
    },
  }
  // 900,000 / 1,000,000 = 90% > 85% 兜底线；尾部 600k 已超过 32k 的保留预算，
  // 于是 selectRetainedRange 返回 null —— 兜底路径上「没有可压区间」的正常 no-op。
  const harness = fakeContext({ total: 900_000, window: 1_000_000, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100_000,
    notifyRepeatDelta: 25_000,
    notifyCooldownMs: 0,
    compactCooldownMs: 0,
    agentDecidesCompaction: false,
    compactRetainTokens: 32_000,
  })
  const agent = agentWith([1, 2], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  const preStep = harness.listeners.get('agent/pre-step')

  // 三个连续 turn 的第一步：只有第一个该注入。占用一步都没涨，所以增长闸必须
  // 由 no-op 自己记下的提醒配额来生效。
  const first = await runPreStep(preStep, { agent, turn: 1 })
  assert.equal(first.messages.length, 2, '第一个 turn 的 step=1 应注入一条')
  for (const turn of [2, 3]) {
    const decision = await runPreStep(preStep, { agent, turn })
    assert.equal(
      decision.messages.length,
      1,
      `turn ${turn} 的 step=1 不该重复注入（占用没涨，提醒配额应已记账）`,
    )
  }
  assert.match(injectedText(first), /没有可压区间/, 'no-op 要说清为什么没压')
  // no-op **不是** skipped：区间选择已经跑完，结论是「没有可压区间」，既没有退避
  // 也没有在途压缩。复用 skipped 的措辞会告诉模型「本轮没有启动（退避中或正在
  // 压缩）」，而同一份 status 里根本没有退避或冷却条目 —— 一条假因果，且
  // `explainNoOp` 让它成为模型能拿到的唯一解释。
  const noOpText = injectedText(first)
  assert.doesNotMatch(noOpText, /没有启动/, `no-op 不能说成「没启动」，实际：${noOpText}`)
  assert.doesNotMatch(noOpText, /退避中|正在压缩/, 'no-op 正文里不该出现退避或在途压缩')
  assert.match(noOpText, /无需执行/, 'no-op 要说「无需执行」')
  assert.match(noOpText, /正常 no-op/, 'no-op 要明说没有失败、不进退避')

  const status = await harness.registeredTools[0].execute({ action: 'status' }, { agent })
  assert.match(status.text, /当前提醒配额：已触发/, 'no-op 也要像 skipped 一样记账')
})

test('状态机：defer 抬线后兜底压缩不得绕过它注入收尾提醒', async () => {
  // 旧实现只在 `total < emergencyLine` 时才置 `reminderBlocked`，于是
  // [兜底线 61%, 临时线) 这一段把 defer 整个绕过：defer 抬到 880k、占用 860k 仍收到
  // 完整提醒；`defer="off"`（线被抬成 MAX_SAFE_INTEGER）同样会收到，而回执说「提醒已关闭」。
  const makeHarness = (total) => {
    const harness = fakeContext({ total, window: 1_000_000 })
    apply(harness.ctx, {
      notifyTokens: 100_000,
      notifyRepeatDelta: 25_000,
      notifyCooldownMs: 0,
      compactCooldownMs: 0,
      agentDecidesCompaction: false,
      compactRetainTokens: 32_000,
    })
    return harness
  }
  const makeAgent = () =>
    agentWith([1, 2], { eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }) })

  // A) defer 抬到 880,000；占用 860,000（≥ 兜底线 610,617，< 临时线 880,000）
  const raised = makeHarness(860_000)
  const raisedAgent = makeAgent()
  const deferral = await raised.registeredTools[0].execute(
    { action: 'defer', tokens: 880_000 },
    { agent: raisedAgent },
  )
  assert.match(deferral.text, /880,000/, '前提：defer 已登记到 880,000')
  const raisedText = injectedText(
    await runPreStep(raised.listeners.get('agent/pre-step'), { agent: raisedAgent }),
  )
  assert.doesNotMatch(raisedText, /该进入阶段收尾了/, '占用低于临时线时不得注入收尾提醒')
  // 但「为什么没压成」仍然要说 —— 这条证明的是提醒被 defer 压住，而不是整条消息被吞掉。
  assert.match(raisedText, /自动压缩未完成/, '兜底压缩的失败说明仍应可见')

  // 对照：占用 600,000（< 兜底线 610,617 = 宿主墙 678,464 的 90%）本来就不该注入。
  const below = makeHarness(600_000)
  const belowAgent = makeAgent()
  await below.registeredTools[0].execute(
    { action: 'defer', tokens: 880_000 },
    { agent: belowAgent },
  )
  const belowDecision = await runPreStep(below.listeners.get('agent/pre-step'), {
    agent: belowAgent,
  })
  assert.equal(belowDecision.messages.length, 1, '低于兜底线时 defer 生效，什么都不注入')

  // B) defer="off"：线是 MAX_SAFE_INTEGER，同样不该注入，更不能把这个数字漏进上下文。
  const off = makeHarness(860_000)
  const offAgent = makeAgent()
  const offReceipt = await off.registeredTools[0].execute(
    { action: 'defer', tokens: 'off' },
    { agent: offAgent },
  )
  assert.match(offReceipt.text, /提醒已关闭/, '前提：defer=off 已生效')
  const offText = injectedText(
    await runPreStep(off.listeners.get('agent/pre-step'), { agent: offAgent }),
  )
  assert.doesNotMatch(offText, /该进入阶段收尾了/, 'defer=off 后不得注入收尾提醒')
  assert.doesNotMatch(
    offText,
    /9,007,199,254,740,991/,
    '关掉提醒后不该把 MAX_SAFE_INTEGER 当成提醒线写进模型上下文',
  )
  assert.match(offText, /自动压缩未完成/, '失败说明仍然可见')
})

test('状态机：连续三次 surface race 转入退避后，不得再说「下一次 pre-step 会立即重试」', async () => {
  // 「surface 变了」被判可重试是对的，但重试代价是一次完整摘要调用。连续三次还是
  // 同一原因就装退避闸门 —— 而退避期内 turn-stopping 会在 compactGate 处直接 return，
  // 一次都不会试。旧实现装完闸门仍让调用方写「下一步立即重试」，与事实相反。
  const priced = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
  ]
  let calls = 0
  const engine = {
    async compactRegion() {
      calls += 1
      throw new Error('compaction: session surface changed during summarization')
    },
  }
  const harness = fakeContext({ total: 210, nodes: priced, engine })
  apply(harness.ctx, {
    notifyTokens: 100,
    compactRetainTokens: 1,
    compactCooldownMs: 60_000,
    agentDecidesCompaction: false,
  })
  const agent = agentWith([1, 2, 3], { seq: 4 })
  const preStep = harness.listeners.get('agent/pre-step')
  const turnStopping = harness.listeners.get('agent/turn-stopping')

  await runPreStep(preStep, { agent })
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await runTurnStopping(turnStopping, { agent })
    assert.equal(calls, attempt, `前提：第 ${attempt} 次真的调用了引擎`)
  }

  const decision = await runPreStep(preStep, { agent, turn: 2 })
  const text = injectedText(decision)
  assert.match(text, /surface changed during summarization/, '失败原因仍要说')
  assert.doesNotMatch(
    text,
    /下一次 pre-step 会立即重试/,
    '已转入退避，重试不会发生在下一次 pre-step',
  )
  assert.match(text, /退避结束后会再尝试/, '应改成描述退避，而不是承诺立即重试')
})

test('状态机：配置降级状态跟着热更新走 —— 改好要消失，写坏要出现', async () => {
  // `configFallbackReason` 是 `status` 读的**当前**状态。旧实现热更新只写日志不动它，
  // 于是 status 双向错：字段修好后仍报「已按默认值运行」（还让人重启，其实已经热生效），
  // 新写入的坏字段则完全看不到降级。
  let bad = true
  const raw = { anchorTimeZone: { get: () => (bad ? '-745' : 'utc') } }

  // A) 挂载时就坏 → 报降级；改好并收到 volatile-update → 不再报。
  const updated = fakeContext({ total: 100, nodes: [] })
  apply(updated.ctx, raw)
  const updatedTool = updated.registeredTools[0]
  const updatedAgent = agentWith([])
  const before = await updatedTool.execute({ action: 'status' }, { agent: updatedAgent })
  assert.match(before.text, /配置降级/, '挂载时坏值应报降级')
  assert.match(before.text, /anchorTimeZone/, '并点名是哪个字段')

  bad = false
  updated.listeners.get('loader/volatile-update')()
  const after = await updatedTool.execute({ action: 'status' }, { agent: updatedAgent })
  assert.doesNotMatch(after.text, /配置降级/, '字段修好并热更新后不该再说「已按默认值运行」')

  // B) 挂载时正常 → 热更新写入坏值 → 要报降级。
  bad = false
  const fresh = fakeContext({ total: 100, nodes: [] })
  apply(fresh.ctx, raw)
  const freshTool = fresh.registeredTools[0]
  const freshAgent = agentWith([])
  const okBefore = await freshTool.execute({ action: 'status' }, { agent: freshAgent })
  assert.doesNotMatch(okBefore.text, /配置降级/, '前提：挂载时配置合法')

  bad = true
  fresh.listeners.get('loader/volatile-update')()
  const degraded = await freshTool.execute({ action: 'status' }, { agent: freshAgent })
  assert.match(degraded.text, /配置降级/, '热更新写入坏值后 status 必须显示降级')
  assert.match(degraded.text, /anchorTimeZone/)
})

test('状态机：兜底压缩成功之后，同因的失败必须能再解释一次（幂等性测试点）', async () => {
  // 说明（审查员纠正过）：这次修复新增的那行清理是**幂等双保险**，不是补洞 ——
  // `markCompactSuccess` 在父提交里本来就 `lastCompactionFailure.delete`，所以
  // 只删掉新增那行，本用例仍然是绿的（变异验证：删 `markCompactSuccess` 里那行才红）。
  // 所以它固定的是「成功 ⇒ 同因失败重新解释」这个**行为契约**，价值在于防止有人
  // 从 `markCompactSuccess` 里删掉清理、或让成功路径绕过它；它不证明新增那行有过作用。
  // 原先的文字声称「旧实现那行删除永不可达，于是记录仍然留着」，与父提交的事实不符。
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 200_000 },
    { seq: 3, tokens: 200_000 },
    { seq: 4, tokens: 200_000 },
  ]
  let mode = 'race'
  const attempts = []
  const engine = {
    async compactRegion() {
      attempts.push(mode)
      if (mode === 'race') throw new Error('surface changed during summarization')
      return { shadowedSeqs: [2], shadowedTokenCount: 400_000, summarySeq: 5 }
    },
  }
  // 900,010 / 1,000,000 = 90% > 85% → 每一条 pre-step 都走兜底压缩。
  const harness = fakeContext({ total: 900_010, window: 1_000_000, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100_000,
    notifyRepeatDelta: 25_000,
    notifyCooldownMs: 0,
    compactCooldownMs: 0,
    agentDecidesCompaction: false,
    compactRetainTokens: 32_000,
  })
  const agent = agentWith([1, 2, 3, 4], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  const preStep = harness.listeners.get('agent/pre-step')

  // 1) 兜底压缩失败一次：原因被解释，并记进「已解释过」。
  const first = await runPreStep(preStep, { agent, turn: 1 })
  assert.equal(attempts.length, 1, '前提：兜底压缩确实尝试过')
  assert.match(injectedText(first), /surface changed during summarization/, '第一次失败要解释原因')

  // 2) 下一次兜底压缩成功 —— 成功之后旧失败记录必须被清掉。
  mode = 'ok'
  const second = await runPreStep(preStep, { agent, turn: 2 })
  assert.equal(attempts.length, 2, '前提：第二次兜底压缩真的执行了')
  assert.equal(second.messages.length, 1, '压缩成功后不再注入基于压缩前总量的提醒')

  // 3) 第三次以**相同原因**再失败：若旧记录没清，会走「同因只解释一次」而静默。
  mode = 'race'
  const third = await runPreStep(preStep, { agent, turn: 3 })
  assert.equal(attempts.length, 3, '前提：第三次兜底压缩真的执行了')
  assert.match(
    injectedText(third),
    /surface changed during summarization/,
    '成功之后同因失败必须重新解释一次',
  )
})

// ---------------------------------------------------------------------------
// scaffold / validate / guard 层的回归钉子。
//
// 下面四条都走生产调用路径：`apply()` 注册出来的 `stage_handoff` 工具，不直接调内部
// 函数 —— 这几处缺陷（工作区是 junction、空骨架的假 ✓、有序列表隐形、重复条目的
// 编造备注）都是「只有真正跑一遍工具才看得见」的那种，内部函数单测反而测不到文案。
// ---------------------------------------------------------------------------

test('scaffold：工作区本身是 junction 时，相对 anchorRoot 的第一次创建必须放行（scaffold 回归）', async (t) => {
  // 企业环境常把工作区做成目录联接（junction）。旧实现里 `lstat` 找到的「最近已存在
  // 祖先」一旦是链接就无条件拒绝 —— 而 `docs/` 还不存在时，最近的那个祖先正好就是
  // 工作区根本身。于是这类环境里**第一次** scaffold 必然失败，回执还把责任推给
  // anchorRoot（「anchorRoot（或其最近的已存在祖先）是符号链接/junction」），
  // 用户完全看不出真正原因。
  //
  // 放行不是放宽安全：后面那条 realpath 包含性检查还在，指到工作区外的链接照样被拒。
  //
  // 覆盖两层拒绝：链接检查与「不是目录」检查。junction 的 lstat 是 isDirectory()===false，只放行前者会让拒绝换个文案继续发生。
  const base = await mkdtemp(join(tmpdir(), 'stage-handoff-junction-ws-'))
  try {
    const real = join(base, 'real')
    const link = join(base, 'link')
    await mkdir(real, { recursive: true })
    try {
      // Windows 上普通 symlink 需要提权，junction 不需要；它同样是 lstat 可见的链接。
      await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`此平台不支持创建 junction/目录符号链接：${error?.code ?? error}`)
      return
    }

    const harness = fakeContext({ total: 100, nodes: [] })
    // anchorRoot 用默认相对值，并且 docs/anchors 刻意**不预先创建** —— 这正是旧实现
    // 失败的形状（最近已存在祖先 = 工作区根 = 那个 junction）。
    apply(harness.ctx, { anchorRoot: 'docs/anchors' })
    const agent = agentWith([])
    Object.assign(agent.session, { header: { cwd: link } })

    const result = await harness.registeredTools[0].execute(
      { action: 'scaffold', topic: 'junction-root' },
      { agent },
    )
    assert.doesNotMatch(
      result.text,
      /拒绝创建阶段/,
      `工作区本身就是 junction 时必须放行（不是换个理由再拒一次），实际回执：${result.text}`,
    )
    assert.match(result.text, /已创建阶段目录/)

    // 落点必须是 junction 的**真实目标**下，而不是在链接路径上另起一套。
    const landed = join(real, 'docs', 'anchors')
    assert.equal(existsSync(landed), true, `阶段必须建在 ${landed} 下`)
    const stages = await readdir(landed)
    assert.equal(stages.length, 1, '应只建一个阶段目录')
    assert.match(stages[0], /^\d{6}-\d{4}-junction-root$/)
    assert.equal(
      existsSync(join(landed, stages[0], 'anchor.md')),
      true,
      '阶段目录里必须有 anchor.md 骨架',
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('validate：一个字没填的骨架不得说「下一步……可直接执行」（validate 回归）', async () => {
  // scaffold 骨架的下一步第一条就是占位符 `1. <打开哪个文件 / 跑哪条命令…>`。整行原样
  // 参与可执行性判断时，里面的 `/` 会被当成路径，于是一个**一个字都没填**的空锚点也
  // 拿到 ✓「下一步第一条带路径或命令，可直接执行」—— 一个绝对是假的通过结论，而
  // 下一阶段照着它走会直接卡住。角括号里的内容必须先整体抹掉再看。
  const root = await mkdtemp(join(tmpdir(), 'stage-handoff-validate-nextstep-'))
  try {
    const harness = fakeContext({ total: 100, nodes: [] })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    const agent = agentWith([])
    await tool.execute({ action: 'scaffold', topic: 'empty' }, { agent })

    // 不传 stage，让 validate 走「取最新阶段」这条生产路径；锚点一个字都不改。
    const result = await tool.execute({ action: 'validate' }, { agent })
    const text = String(result.text ?? '')
    assert.doesNotMatch(text, /可直接执行/, `空骨架不能拿到可执行的 ✓，实际输出：${text}`)
    assert.doesNotMatch(text, /✓ 下一步第一条/)
    // 而且必须是把这条报成「问题」，不是干脆不提 —— 静默同样是错。
    assert.match(text, /! 下一步第一条没有可执行 token/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('guard / validate：有序列表写的 `## 硬约束` 必须被计入（列表判据回归）', async () => {
  // 插件自己生成的骨架 `## 下一步` 就是 `1.` 风格，模型把同一写法照抄到 `## 硬约束`
  // 很自然。旧判据只认 `[-*]`，于是有序列表写的硬约束对 validate 与 guard 完全隐形：
  // validate 报「一节存在但没有条目」，guard 则建出 0 条基线却仍然承诺「之后每次
  // validate 都会对比」—— 删掉其中一条还会得到「✓ 与基线一致」的反向保证。
  const root = await mkdtemp(join(tmpdir(), 'stage-handoff-ordered-constraints-'))
  const stage = '261117-0000-ordered'
  try {
    await mkdir(join(root, stage), { recursive: true })
    await writeFile(
      join(root, stage, 'anchor.md'),
      [
        '# ordered',
        '',
        '## 下一步',
        '1. 跑 `node --test`',
        '',
        '## 硬约束',
        '1. [实测 261117] 不许改 compactRetainTokens 的默认值',
        '2. [人工明确] 不要在仓库里留临时文件',
        '',
      ].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    const agent = agentWith([])

    const guard = await tool.execute({ action: 'guard', stage }, { agent })
    assert.match(guard.text, /已建立基线/, `有序列表必须能建基线，实际回执：${guard.text}`)
    assert.match(guard.text, /硬约束 2 条/, '回执里的硬约束条数必须是 2，不是 0')

    const validate = await tool.execute({ action: 'validate', stage }, { agent })
    assert.doesNotMatch(
      validate.text,
      /一节存在但没有条目/,
      `有序列表里的条目必须被数进去，实际输出：${validate.text}`,
    )
    assert.match(validate.text, /硬约束全部标了来源/, '两条都标了来源，正面的 ✓ 也要给')
    // 基线真的建成了，validate 就不能再说「没有 guard 基线」。
    assert.match(validate.text, /与基线一致/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate：基线里同一条约束重复两遍、删掉一遍时不得编出「标签/状态变了」（validate 回归）', async () => {
  // 多重集比较给出 missing 条目时，`changedNote` 要把「同文本但标签/状态变了」的那条
  // 附上去。它对每条 missing 都是从**所有**同文本的当前条目里挑 —— 其中也包含与基线
  // 一字不差的那条（纯重复少一遍时就是它）。不过滤的话会编出
  // 「同一文本的标签/状态现在是 X」，而 X 与基线完全相同：计数对，唯一的额外线索错，
  // 读者会去查一个根本不存在的标签改动。
  const root = await mkdtemp(join(tmpdir(), 'stage-handoff-duplicate-guard-'))
  const stage = '261117-0000-duplicate'
  const line = '- [实测 261117] 别动 X'
  try {
    await mkdir(join(root, stage), { recursive: true })
    const original = [
      '# duplicate',
      '',
      '## 下一步',
      '1. 跑 `node --test`',
      '',
      '## 硬约束',
      line,
      line,
      '',
    ].join('\n')
    await writeFile(join(root, stage, 'anchor.md'), original, 'utf8')
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    const agent = agentWith([])

    const guard = await tool.execute({ action: 'guard', stage }, { agent })
    assert.match(guard.text, /硬约束 2 条/, '前提：重复两遍都进基线')

    // 删掉其中一行：剩下那条与基线里的每一条都逐字相同，标签/状态没有任何变化。
    await writeFile(join(root, stage, 'anchor.md'), original.replace(`${line}\n`, ''), 'utf8')

    const validate = await tool.execute({ action: 'validate', stage }, { agent })
    // 计数必须对：这正是多重集比较的意义。
    assert.match(validate.text, /基线 2 条、当前 1 条/)
    assert.match(validate.text, /少了 1 条基线原文/)
    assert.doesNotMatch(
      validate.text,
      /标签\/状态现在是/,
      `纯重复少一遍时不得编出标签变化，实际输出：${validate.text}`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('guard / validate：4 空格缩进的代码块不得被当成 `## 硬约束` 条目', async () => {
  // 判据要认有序列表（`1.`），但 CommonMark 里 4 空格缩进是**代码块**：锚点里
  // 常贴一小段示例，那些 `1.` 不是约束。`anchorDocument` 只抹围栏、不抹缩进代码，
  // 所以前缀若写成 `\s*` 就会把代码行收进基线 —— 于是删掉示例也会报「少了 1 条
  // 基线原文」，和真删一条约束无法区分。
  const root = await mkdtemp(join(tmpdir(), 'stage-handoff-indented-code-'))
  const stage = '261117-0000-indented'
  try {
    await mkdir(join(root, stage), { recursive: true })
    await writeFile(
      join(root, stage, 'anchor.md'),
      [
        '# indented',
        '',
        '## 下一步',
        '1. 跑 `node --test`',
        '',
        '## 硬约束',
        '1. [实测 261117] 不许改 compactRetainTokens 的默认值',
        '2. [人工明确] 不要在仓库里留临时文件',
        '',
        '默认值就这三个：',
        '',
        '    - compactRetainTokens',
        '    1. notifyTokens',
        '',
      ].join('\n'),
      'utf8',
    )
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    const agent = agentWith([])

    const guard = await tool.execute({ action: 'guard', stage }, { agent })
    assert.match(guard.text, /硬约束 2 条/, `缩进代码块不该进基线，实际回执：${guard.text}`)

    // 删掉代码块里的示例：这不是删约束，validate 不得报「少了基线原文」。
    const anchorPath = join(root, stage, 'anchor.md')
    const withoutCode = (await readFile(anchorPath, 'utf8'))
      .split('\n')
      .filter((line) => !/^ {4}/.test(line))
      .join('\n')
    await writeFile(anchorPath, withoutCode, 'utf8')
    const validate = await tool.execute({ action: 'validate', stage }, { agent })
    assert.doesNotMatch(
      validate.text,
      /少了 \d+ 条基线原文/,
      `删代码示例不是删约束，实际输出：${validate.text}`,
    )
    assert.doesNotMatch(validate.text, /没标来源/, '缩进代码块不该被要求标来源')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('面板的 dshHome 绝对路径闸必须与 host 的 path.isAbsolute 对齐', () => {
  // host 用 `path.isAbsolute`：win32 上 `\data`（当前盘符根 + 目录）是绝对路径。
  // 面板旧正则只认 `C:\`、`\\`、`/`，于是 YAML 里写的合法值在面板里存不回去，
  // 而错误文案说「必须填绝对路径」—— 理由本身是假的（它就是绝对路径）。
  const isAbsolutePathInput = clientParsingHelpers().isAbsolutePathInput
  assert.equal(
    typeof isAbsolutePathInput,
    'function',
    '解析块必须导出这条判据，否则它无法被测试（它以前写死在 validateValue 里）',
  )

  for (const value of ['D:\\dsh-data', 'D:/dsh-data', '\\\\server\\share', '/data', '\\data']) {
    assert.equal(isAbsolutePathInput(value), true, `${value} 是绝对路径，面板必须接受`)
  }
  // 首尾空白不该改变判定（host 也先 trim）。
  assert.equal(isAbsolutePathInput('  D:\\dsh-data  '), true)

  for (const value of ['dsh-data', 'C:rel', '~\\data', './data', '']) {
    assert.equal(isAbsolutePathInput(value), false, `${value} 不是绝对路径，面板必须拒绝`)
  }
})

test('非对象配置必须在挂载时就报「配置降级」，不能静默换成全默认', async () => {
  // 「配置降级跟着热更新走」那条只覆盖了**字段级**坏值（走 `dropped`）。形状级
  // （`[]` / `'nope'` / `42`）一个字段也 dropped 不了，旧实现据此判定「没什么可报
  // 的」，于是整份配置被换成默认值 —— 连 `enabled: false` 一起丢，日志里一个字都没有。
  /** @type {Array<[unknown, RegExp]>} */
  const cases = [
    [[], /收到 数组/],
    ['nope', /收到 string/],
    [42, /收到 number/],
  ]
  for (const [shape, expected] of cases) {
    const label = JSON.stringify(shape)
    const harness = fakeContext({ total: 100, nodes: [] })
    apply(harness.ctx, /** @type {any} */ (shape))
    const status = await harness.registeredTools[0].execute(
      { action: 'status' },
      { agent: agentWith([]) },
    )
    assert.match(status.text, /配置降级/, `${label} 必须在 status 里报降级`)
    assert.match(status.text, expected, `${label} 要点名收到的形状`)
    assert.ok(
      harness.logs.some(([, message]) => /配置降级/.test(String(message))),
      `${label} 必须留一条日志`,
    )
  }
  // 对照：空对象是合法输入，不得报降级（否则「降级」这个词就失去意义了）。
  const okHarness = fakeContext({ total: 100, nodes: [] })
  apply(okHarness.ctx, {})
  const okStatus = await okHarness.registeredTools[0].execute(
    { action: 'status' },
    { agent: agentWith([]) },
  )
  assert.doesNotMatch(okStatus.text, /配置降级/)
})

test('validate：填好的下一步必须拿到 ✓（骨架占位符抹除的正向对照）', async () => {
  // 空骨架那条只证伪。把 `body.replace(/<[^<>]*>/g, '')` 换成 `''` 会让**所有**
  // 锚点都判失败 —— 这种退化在只有否定断言的用例下照样是绿的。
  const root = await mkdtemp(join(tmpdir(), 'stage-handoff-validate-filled-'))
  try {
    const harness = fakeContext({ total: 100, nodes: [] })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    const agent = agentWith([])
    await tool.execute({ action: 'scaffold', topic: 'filled' }, { agent })

    const stages = await readdir(root)
    assert.equal(stages.length, 1, '前提：只建了一个阶段目录')
    const anchorPath = join(root, stages[0], 'anchor.md')
    const filled = (await readFile(anchorPath, 'utf8')).replace(
      /^1\. <[^\n]*>$/m,
      '1. 跑 `node --test test/index.test.mjs`',
    )
    await writeFile(anchorPath, filled, 'utf8')

    const result = await tool.execute({ action: 'validate' }, { agent })
    assert.match(
      String(result.text),
      /✓ 下一步第一条带路径或命令，可直接执行/,
      `填好的下一步必须判可执行，实际输出：${result.text}`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('平衡边界守卫抛错时必须继续向左找，不能把「无法判定」当成「已平衡」', async () => {
  // 宿主 `toolPairingBalancedBefore` 的契约是「无法判定就抛错，调用方不许继续」
  // （dsh-compaction/tool-pairing.ts:109-113）。旧实现 catch 后当成 true 并 break，
  // 等于让一个**未经验证**的切点通过：宿主随后会抛 `not a balanced boundary`，
  // 白烧一次完整摘要调用才失败。正确的方向是继续向左找更早的平衡边界。
  // 6 个节点、各 150k：保留预算 32k 只够留住最后一个节点，于是从左修正的
  // 循环有多轮空间（节点太少时 range.firstIdx 会紧贴 keepFromIdx，循环只有一轮）。
  const nodes = Array.from({ length: 6 }, (_, index) => ({
    seq: index + 1,
    tokens: 150_000,
  }))
  const engine = {
    async compactRegion() {
      return { shadowedSeqs: [1], shadowedTokenCount: 150_000, summarySeq: 7 }
    },
  }
  const asked = []
  const harness = fakeContext({
    total: 900_000,
    window: 1_000_000,
    nodes,
    engine,
    balanceGuard: (_session, seq) => {
      asked.push(seq)
      throw new Error('surface is not readable')
    },
  })
  apply(harness.ctx, {
    notifyTokens: 100_000,
    agentDecidesCompaction: false,
    compactCooldownMs: 0,
    compactRetainTokens: 32_000,
  })
  const agent = agentWith([1, 2, 3, 4, 5, 6], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  await runPreStep(harness.listeners.get('agent/pre-step'), { agent, turn: 1 })

  // 关键断言：守卫抛错之后**还要再问一次**（说明切点继续向左修正）。
  // 旧实现第一次抛错就直接 break，只问 1 次。
  assert.ok(
    asked.length >= 2,
    `守卫抛错后必须继续向左找更早的切点，实际只问了 ${asked.length} 个（${asked.join(',')}）`,
  )
})

test('status 的 settings 判据必须认条目 id，不能只认包名', async () => {
  // 宿主 `describe()` 里的 `ns` 是 profile **条目 id**
  // （dsh-settings/src/index.ts:315 `ns: entry.options.id`），不是包名。bundle patch
  // 允许条目用别的 id，旧实现精确比 'stage-handoff' 会在那种部署上断言
  // 「不包含 → 面板只读」，而面板其实可写 —— 一条方向相反的错误诊断。
  const service = {
    configure() {
      return () => {}
    },
    describe() {
      return [{ ns: 'my-stage-handoff-entry' }, { ns: 'other-plugin' }]
    },
  }
  const harness = fakeContext({ total: 100, settings: service })
  apply(harness.ctx, {})
  const status = await harness.registeredTools[0].execute(
    { action: 'status' },
    { agent: agentWith([]) },
  )
  assert.match(
    status.text,
    /\*\*包含\*\* stage-handoff/,
    `条目 id 与包名不同也必须认出来，实际：${status.text}`,
  )
  assert.match(status.text, /条目 id 是 my-stage-handoff-entry/)
})

test('排队压缩的回执必须说明降级路径不保留尾部（宿主 retain 写死 0）', async () => {
  // 精确压缩失败会退化成借壳 `/compact`，而宿主 `compactNow` 内部是
  // `selectCompactableRange(..., 0)`（dsh-compaction-basic/src/index.ts:418-422）——
  // 保留量 0，会把可压尾巴整段摘要掉。插件自己的 `compactRetainTokens` 在这条路上
  // 完全不生效，而回执只记了「已排队」，不说清楚就是静默违背「保留尾部」的承诺。
  const harness = fakeContext({ total: 500_000, window: 1_000_000 })
  apply(harness.ctx, { notifyTokens: 100_000, compactRetainTokens: 32_000 })
  const queued = await harness.registeredTools[0].execute(
    { action: 'compact' },
    { agent: agentWith([]) },
  )
  const text = String(queued.text)
  assert.match(text, /已排队压缩/, `前提：应当走借壳排队路径，实际：${text}`)
  assert.match(text, /保留量是宿主的 0/, '必须点明降级路径不保留尾部逐字上下文')
  assert.match(text, /compactRetainTokens=32,000/, '必须点明插件自己的保留量在这条路上不生效')
})

/** 造一个「压缩挂在引擎里」的场景，供热更新竞态用例复用。 */
function gatedCompaction() {
  /** @type {(value?: unknown) => void} */
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const live = { notifyTokens: 300_000, enabled: true }
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 300_000 },
    { seq: 3, tokens: 300_000 },
  ]
  const engine = {
    async compactRegion() {
      await gate
      throw new Error('摘要引擎炸了')
    },
  }
  const harness = fakeContext({ total: 900_000, window: 1_000_000, nodes, engine })
  // `{ get }` 是 schemastery `.volatile()` 的真实形态：热更新后 `config` 引用会换，
  // 而这一步开始时取的 `configAtEntry` 保持不变。
  apply(harness.ctx, {
    notifyTokens: { get: () => live.notifyTokens },
    enabled: { get: () => live.enabled },
    agentDecidesCompaction: { get: () => false },
    compactCooldownMs: { get: () => 0 },
    compactRetainTokens: { get: () => 32_000 },
  })
  const agent = agentWith([1, 2, 3], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  return { harness, live, release: () => release(), agent }
}

test('压缩进行中热更新配置：不得把「新旧配置的差」说成「本会话已临时提升」', async () => {
  // 会话从没 defer 过。旧实现里 `effectiveNotify` 在 await 之前按 300k 取，而
  // `noticeText` 在 await 之后读新的 200k，两者不等就被渲染成
  // 「（配置值 200,000，本会话已临时提升）」—— 一句可验证的假陈述，模型会照它去调
  // `/anchor reset`，而同一份 status 里根本没有 defer 登记。
  const { harness, live, release, agent } = gatedCompaction()
  const preStep = harness.listeners.get('agent/pre-step')
  const pending = runPreStep(preStep, { agent, turn: 1 })
  await new Promise((resolve) => setTimeout(resolve, 20))

  live.notifyTokens = 200_000
  harness.listeners.get('loader/volatile-update')()
  release()

  const text = injectedText(await pending)
  assert.ok(text.length > 0, '前提：这一步应该注入内容（失败说明或提醒）')
  // 快照值：这一步开始时 notifyTokens 是 300,000，热更新发生在压缩挂起期间。
  assert.match(text, /提醒线 300,000/, `文案必须用进入这一步时的快照值，实际：${text}`)
  // 旧实现把「快照的 300,000」与「热更新后的配置值 200,000」放进同一句，渲染成
  // 「（配置值 200,000，本会话已临时提升）」—— 而本会话从没 defer 过。
  assert.doesNotMatch(
    text,
    /配置值|本会话已临时提升/,
    `不得把两份 config 快照放在同一句里对比，实际：${text}`,
  )
})

test('压缩进行中被停用后，不得再往模型上下文里注入收尾提醒', async () => {
  // 只在入口判 `enabled` 是不够的：压缩是整次摘要模型调用，几十秒里使用者完全可能
  // 把插件停用。停用后 `/anchor status` 只会回「已在当前 Host 进程中停用」，
  // 所以这条提醒一旦发出去就没有任何痕迹。
  const { harness, live, release, agent } = gatedCompaction()
  const preStep = harness.listeners.get('agent/pre-step')
  const pending = runPreStep(preStep, { agent, turn: 1 })
  await new Promise((resolve) => setTimeout(resolve, 20))

  live.enabled = false
  harness.listeners.get('loader/volatile-update')()
  release()

  const decision = await pending
  assert.equal(
    decision.messages.length,
    1,
    `停用后不该注入（基准是 1 条既有消息），实际 ${decision.messages.length} 条`,
  )
})

test('压缩的 fail-closed 阀门：turn 边界无法证明时必须拒绝压缩', async () => {
  // 这是整个压缩功能的安全阀，而它此前**一次都没被执行过** —— 把它改成「拿 null
  // 当 0 继续压」，全量测试仍然是绿的。它守的是「绝不把未知前缀猜成 0」：猜错就会
  // 切进当前轮正在用的节点，摘要落盘后不可逆。
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 300_000 },
    { seq: 3, tokens: 300_000 },
  ]
  let engineCalls = 0
  const engine = {
    async compactRegion() {
      engineCalls += 1
      return { shadowedSeqs: [1], shadowedTokenCount: 300_000, summarySeq: 4 }
    },
  }
  // `withAgents: false` → `state.agents` 为 undefined → `turnBoundaryOf` 不是函数
  // → `openTurnBoundaryIdx` 返回 null（index.js:1241）。
  const harness = fakeContext({
    total: 900_000,
    window: 1_000_000,
    nodes,
    engine,
    withAgents: false,
  })
  apply(harness.ctx, {
    notifyTokens: 100_000,
    agentDecidesCompaction: false,
    compactCooldownMs: 0,
    compactRetainTokens: 32_000,
  })
  const agent = agentWith([1, 2, 3], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  const decision = await runPreStep(harness.listeners.get('agent/pre-step'), {
    agent,
    turn: 1,
  })

  assert.equal(engineCalls, 0, '证明不了 turn 边界时绝不能调用引擎')
  const text = injectedText(decision)
  assert.match(text, /拒绝压缩（fail-closed/, `必须说明拒绝理由，实际：${text}`)
})

test('压缩的 fail-closed 阀门：turn 起点早于可压边界时本轮不压', async () => {
  // 第二条拒绝路径：平衡修正后的硬边界撞上 turn 起点（长 turn 里很常见）。
  // 这里让 turn 从 seq 1 开始，而 seq 1 是 system/message（firstIdx = 1），于是
  // hardEnd = min(keepFromIdx, 1) = 1 <= firstIdx。
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 300_000 },
    { seq: 3, tokens: 300_000 },
  ]
  let engineCalls = 0
  const engine = {
    async compactRegion() {
      engineCalls += 1
      return { shadowedSeqs: [1], shadowedTokenCount: 300_000, summarySeq: 4 }
    },
  }
  const harness = fakeContext({ total: 900_000, window: 1_000_000, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100_000,
    agentDecidesCompaction: false,
    compactCooldownMs: 0,
    compactRetainTokens: 32_000,
  })
  const agent = agentWith([1, 2, 3], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  // `agentWith` 按 openTurn 自己合成边界（`openTurnStartSeq = max(seq) + 1 = 4`），
  // 这里把它挪到 seq 1：turn 从第一个节点就开始了，于是硬边界撞上 firstIdx。
  agent.session.turnBoundary.openTurnStartSeq = 1
  const decision = await runPreStep(harness.listeners.get('agent/pre-step'), {
    agent,
    turn: 1,
  })

  assert.equal(engineCalls, 0, '硬边界撞上 turn 起点时不该调用引擎')
  const text = injectedText(decision)
  assert.match(text, /早于可压边界/, `必须说明原因，实际：${text}`)
})

test('guard：空锚点（没硬约束也没否决）必须拒绝建基线', async () => {
  // `scaffold` 生成的骨架里**没有** `## 硬约束` 条目，所以「scaffold → 立刻 guard」
  // 是最自然的开局。不拒绝的话会写出 `constraints: []` 的基线，之后 validate 对着
  // 空基线比对，对任何改动都回「✓ 与基线一致（0 条硬约束、0 条否决都还在）」——
  // 一个反向的假保证，正是这个守卫当初要消灭的东西。这条拒绝此前零覆盖。
  const root = await mkdtemp(join(tmpdir(), 'stage-handoff-guard-empty-'))
  try {
    const harness = fakeContext({ total: 100, nodes: [] })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    const agent = agentWith([])
    await tool.execute({ action: 'scaffold', topic: 'empty' }, { agent })

    const guard = await tool.execute({ action: 'guard' }, { agent })
    assert.match(String(guard.text), /没有可守护的条目/)

    const stages = await readdir(root)
    assert.equal(stages.length, 1, '前提：只有一个阶段')
    assert.equal(
      existsSync(join(root, stages[0], '.anchor-guard.json')),
      false,
      '拒绝时绝不能留下一个空基线文件',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate：锚点超过字符上限必须告警（唯一的长文刹车）', async () => {
  // 这是全部代码里唯一对「锚点越写越长」的机械刹车，而两条告警此前从未触发过：
  // 一个 200 KB 的锚点也能拿到「没有发现问题」，用户得到的是正向确认。
  const root = await mkdtemp(join(tmpdir(), 'stage-handoff-validate-size-'))
  const stage = '261117-0000-big'
  try {
    await mkdir(join(root, stage), { recursive: true })
    const head = [
      '# big',
      '',
      '## 下一步',
      '1. 跑 `node --test`',
      '',
      '## 硬约束',
      '- [实测 261117] 别动 X',
      '',
    ].join('\n')
    const anchorPath = join(root, stage, 'anchor.md')
    const harness = fakeContext({ total: 100, nodes: [] })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    const agent = agentWith([])

    // 正好 8000（等于上限）：不报「超上限」（「超」是严格大于），但仍落在八成一档。
    await writeFile(anchorPath, head + 'x'.repeat(8000 - head.length), 'utf8')
    const atLimit = await tool.execute({ action: 'validate', stage }, { agent })
    assert.doesNotMatch(
      String(atLimit.text),
      /已超上限/,
      `正好等于上限不该报「超」，实际：${atLimit.text}`,
    )
    assert.match(String(atLimit.text), /已过上限的八成/)

    // 6500 > 6400（八成）：报「过八成」。
    await writeFile(anchorPath, head + 'x'.repeat(6500 - head.length), 'utf8')
    const over80 = await tool.execute({ action: 'validate', stage }, { agent })
    assert.match(String(over80.text), /已过上限的八成/)

    // 8001 > 8000：报「已超上限」。
    await writeFile(anchorPath, head + 'x'.repeat(8001 - head.length), 'utf8')
    const over = await tool.execute({ action: 'validate', stage }, { agent })
    assert.match(String(over.text), /已超上限 8,000/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('guard：重跑必须能更新已有基线（文档化的恢复路径）', async () => {
  // guard 的回执自己写着「确认是故意删的，就重新跑一次 guard 更新基线」。这条恢复
  // 路径端到端从没验过：写侧是 tmp + rename 覆盖**已存在**的文件，读侧还压着
  // guardMaxBytes / nlink / isFile / sameIdentity 一整套检查。只要「目标已存在」
  // 被判成不可写，用户就会被永久卡在一份过期基线上，而全套测试仍是绿的。
  const root = await mkdtemp(join(tmpdir(), 'stage-handoff-guard-rerun-'))
  const stage = '261117-0000-rerun'
  try {
    await mkdir(join(root, stage), { recursive: true })
    const anchorPath = join(root, stage, 'anchor.md')
    const write = (lines) =>
      writeFile(
        anchorPath,
        ['# rerun', '', '## 下一步', '1. 跑 `node --test`', '', '## 硬约束', ...lines, ''].join('\n'),
        'utf8',
      )

    await write(['- [实测 261117] 约束 A'])
    const harness = fakeContext({ total: 100 })
    apply(harness.ctx, { anchorRoot: root })
    const tool = harness.registeredTools[0]
    const agent = agentWith([])

    const first = await tool.execute({ action: 'guard', stage }, { agent })
    assert.match(String(first.text), /硬约束 1 条/, `第一次建基线应成功，实际：${first.text}`)

    await write(['- [实测 261117] 约束 A', '- [人工明确] 约束 B'])
    const second = await tool.execute({ action: 'guard', stage }, { agent })
    assert.match(
      String(second.text),
      /硬约束 2 条/,
      `重跑必须成功覆盖旧基线，实际：${second.text}`,
    )

    const baseline = JSON.parse(await readFile(join(root, stage, '.anchor-guard.json'), 'utf8'))
    assert.equal(baseline.constraints.length, 2, '落盘的基线必须真的是 2 条')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('status 的压缩读数必须反映真实状态（状态机唯一的外部读数）', async () => {
  // 这三行是 pendingCompact / autoCompacting / commands.find 这套状态机唯一的外部
  // 读数 —— 排障时全靠它判断「借壳 /compact 能不能用、现在有没有在跑」。状态机本体
  // 有十几个用例，但读数取反了整套测试依然全绿，运维会被指向相反的方向。
  const harness = fakeContext({ total: 500_000, window: 1_000_000 })
  apply(harness.ctx, { notifyTokens: 100_000, compactCooldownMs: 0 })
  const tool = harness.registeredTools[0]
  const agent = agentWith([])

  const idle = String((await tool.execute({ action: 'status' }, { agent })).text)
  assert.match(idle, /find\(agent,'compact'\)：可用/)
  assert.match(idle, /排队中的压缩请求：无/)
  assert.match(idle, /自动压缩进行中：否/)

  // 排队之后读数是「有」，执行完回到「无」。
  const queued = await tool.execute({ action: 'compact' }, { agent })
  assert.match(String(queued.text), /已排队压缩/, '前提：走借壳排队路径')
  const busy = String((await tool.execute({ action: 'status' }, { agent })).text)
  assert.match(busy, /排队中的压缩请求：有/)
  await harness.listeners.get('agent/status')({ status: 'idle', agent })
  const drained = String((await tool.execute({ action: 'status' }, { agent })).text)
  assert.match(drained, /排队中的压缩请求：无/)

  // 压缩真的挂在引擎里时读数是「是」。
  const gated = gatedCompaction()
  const pending = runPreStep(gated.harness.listeners.get('agent/pre-step'), {
    agent: gated.agent,
    turn: 1,
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const during = String(
    (await gated.harness.registeredTools[0].execute(
      { action: 'status' },
      { agent: gated.agent },
    )).text,
  )
  assert.match(during, /自动压缩进行中：是/, `压缩进行中必须报「是」，实际：${during}`)
  gated.release()
  await pending
})

test('压缩成功后必须渲染复读预警（这段代码跑在不可逆操作之后）', async () => {
  // `describeRepeatRisk` 的 verdicts 分支只在**精确压缩成功之后**才执行，而那时历史
  // 已经被重写、退不回去。它读 `verdicts[].fillers` 与 `reasons.join()`：字段一漂就抛，
  // 一次**已经成功**的压缩会被报成工具失败；悄悄返回空串则让「模型已退化」这条唯一
  // 早期线索永久消失。status 里另有一份内联复制品，所以这个副本坏了不会被发现。
  // 此前 127-135 这一整段从未被执行过。
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 300_000 },
    { seq: 3, tokens: 300_000 },
  ]
  const engine = {
    async compactRegion() {
      return { shadowedSeqs: [1], shadowedTokenCount: 300_000, summarySeq: 4 }
    },
  }
  const harness = fakeContext({ total: 900_000, window: 1_000_000, nodes, engine })
  apply(harness.ctx, { compactRetainTokens: 32_000, compactCooldownMs: 0 })
  const agent = agentWith([1, 2, 3], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })

  // 制造复读：同一个 turn 里连续多个碎片化的 reasoning 块。
  const feed = harness.listeners.get('session/event')
  assert.ok(feed, '前提：session/event 已订阅')
  for (let step = 0; step < 4; step += 1) {
    feed(agent.session, {
      seq: 100 + step,
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'reasoning', text: '好。\n做。' }] } },
    })
  }

  const result = await harness.registeredTools[0].execute({ action: 'compact' }, { agent })
  const text = String(result.text ?? '')
  assert.match(text, /精确压缩完成/, `前提：精确压缩应成功，实际：${text}`)
  assert.match(
    text,
    /思考复读预警：1 个 turn 已出现复读（最严重 turn 1：/,
    `压缩成功后必须渲染复读预警，实际：${text}`,
  )
})

test('面板字段闸与 host 配置解析必须同源（漂移防护）', () => {
  // 面板放行而 host 拒绝 ⇒ 用户看到「已保存」，然后装载时字段被丢、配置整体失效；
  // 反过来同样糟：合法的 YAML 值在面板里存不回去，而报错理由还可能是假的。
  // 这条漂移过两次（anchorRoot 的空白与 `..` 段、dshHome 的 `\data`），所以这里把
  // 「面板接受什么」与 host 的接受集直接对撞，而不是各测各的。
  const { validateValue, coerce, coerceTimeZone } = clientValidatorHelpers()
  const field = (key, type, extra = {}) => ({ key, type, ...extra })
  // 必须走**真实入口**：面板的 submit 对 anchorTimeZone 用的是 `coerceTimeZone`，
  // 不是通用的 `coerce`（client.js:1182-1187）。第一版测试漏了这条分派，于是
  // '+05:30' 被误报成「面板拒绝」—— 那个分支本来就只处理字符串原样透传。
  const nextOf = (item, raw) =>
    item.key === 'anchorTimeZone' ? coerceTimeZone(raw) : coerce(item, raw)

  /** @type {Array<[any, string]>} */
  const cases = [
    [field('anchorRoot', 'text'), 'docs/anchors'],
    [field('anchorRoot', 'text'), 'docs/.. '],
    [field('anchorRoot', 'text'), '  docs/anchors\t'],
    [field('anchorRoot', 'text'), 'docs/\tanchors'],
    [field('anchorRoot', 'text'), '   '],
    [field('anchorRoot', 'text'), 'C:\\anchors'],
    [field('dshHome', 'text'), ''],
    [field('dshHome', 'text'), '/data'],
    [field('dshHome', 'text'), 'data'],
    [field('dshHome', 'text'), 'C:rel'],
    [field('dshHome', 'text'), '~\\data'],
    [field('anchorTimeZone', 'timezone'), 'utc'],
    [field('anchorTimeZone', 'timezone'), '+05:30'],
    [field('anchorTimeZone', 'timezone'), '-300'],
    [field('anchorTimeZone', 'timezone'), 'nope'],
    [field('notifyTokens', 'tokens'), '300k'],
    [field('notifyTokens', 'tokens'), '0'],
    [field('guardMaxBytes', 'number', { min: 65536, max: 16777216 }), '65536'],
    [field('guardMaxBytes', 'number', { min: 65536, max: 16777216 }), '65535'],
    [field('guardMaxBytes', 'number', { min: 65536, max: 16777216 }), '16777217'],
  ]

  // `dshHome` 的**平台相关形状**（盘符、反斜杠开头、UNC）故意不放进上面这张对照表。
  // 面板跑在浏览器里，拿不到宿主平台，只能用一条固定判据；host 按平台严格收紧
  // （POSIX 上 `D:/x` 会被 `path.resolve` 拼到 cwd 后面，必须拒）。这是**已知差异**，
  // 兜底在 host：面板可能放行，保存后 host 立刻拒绝并说明原因。
  //
  // 把它塞进对照表里要求两边一致，只会让 ubuntu 上恒红、windows 上恒绿 —— 那正是这个
  // drift 之前藏起来的方式。这里改为断言「host 必拒」，把差异写在明处。
  if (process.platform !== 'win32') {
    for (const raw of ['D:\\dsh-data', '\\data', '\\\\srv\\share']) {
      assert.throws(
        () => resolveConfig({ dshHome: raw }),
        /绝对路径/,
        `POSIX 上 ${JSON.stringify(raw)} 必须被 host 拒绝（否则会静默落到 cwd 下）`,
      )
    }
  }

  // 不写期望值：直接问两边,要求答案相同。手写期望值正是这类测试最容易出错的地方
  // （第一版就把「首尾空白 + 制表符」判反了 —— 两边都 trim，本来就都接受）。
  for (const [definition, raw] of cases) {
    const coerced = nextOf(definition, raw)
    const parsed = coerced !== null && coerced !== undefined
    const panelAccepts = parsed && validateValue(definition, coerced) === ''
    // 面板解析失败时提交不下去；此时问 host 的应该是**原始输入**，不是 `undefined`
    // （`resolveConfig({key: undefined})` 会按缺省值接受，那是 JS 语义，不代表 host
    // 接受用户的这串文字）。
    const probe = parsed ? coerced : raw
    let hostAccepts
    try {
      resolveConfig({ [definition.key]: probe })
      hostAccepts = true
    } catch {
      hostAccepts = false
    }
    assert.equal(
      panelAccepts,
      hostAccepts,
      `${definition.key} = ${JSON.stringify(raw)}：面板${panelAccepts ? '接受' : '拒绝'}，host${hostAccepts ? '接受' : '拒绝'}`,
    )
  }
})

test('formatError 必须按字段说真话，不能一律套 token 的例子', () => {
  // 「格式不对」和「结果太大」是两件事：旧文案一律说「请填整数」，于是用户输入一个
  // 超大的正整数时被告知「请填整数」—— 而他填的正是整数，真正的上界从未出现过。
  const { formatError } = clientValidatorHelpers()

  const duration = { key: 'compactCooldownMs', type: 'duration' }
  assert.match(formatError(duration, '5x'), /单位在右侧下拉里选/)

  const tokens = { key: 'notifyTokens', type: 'tokens', max: 1000000000 }
  assert.match(formatError(tokens, '2000000k'), /结果不能大于/, '格式合法但超界要说上界')
  assert.match(formatError(tokens, 'abc'), /格式不对/, '真格式错才说格式')

  const timeZone = { key: 'anchorTimeZone', type: 'timezone' }
  assert.match(formatError(timeZone, 'xxx'), /local \/ utc \/ z/)

  const number = { key: 'keepAnchorBackups', type: 'number', min: 1, max: 16 }
  assert.match(formatError(number, '99'), /请填 1\.\.16 的整数/, '必须写出真实区间')
})

test('status 的提醒线距离两个分支都要对（越过 / 还差）', async () => {
  // 这两句是「现在离提醒线多远」的唯一读数，它的作用是把 `total >= lineStatus`
  // 的判断两边都取反，而那一改整套测试依然全绿 —— 可它直接决定人和 agent
  // 判断「该不该开始收尾」。
  const statusOf = async (total) => {
    const harness = fakeContext({ total, window: 1_000_000 })
    apply(harness.ctx, { notifyTokens: 363_520 })
    const result = await harness.registeredTools[0].execute(
      { action: 'status' },
      { agent: agentWith([]) },
    )
    return String(result.text ?? '')
  }

  const below = await statusOf(100_000)
  assert.match(below, /距提醒线还差 263,520/, `未越过时必须给出还差多少，实际：${below}`)
  assert.doesNotMatch(below, /已越过提醒线/)

  const above = await statusOf(400_000)
  assert.match(above, /已越过提醒线 36,480/, `已越过时必须给出超出多少，实际：${above}`)
  assert.doesNotMatch(above, /距提醒线还差/)
})

test('同一会话的两条 pre-step 同时越线时不得并发进入引擎（重入回归）', async () => {
  // 两个入口都会在越线时压缩：pre-step 在返回前 await，turn-stopping 由宿主串行调用。
  // `autoCompacting` 这道守卫的 check+add 之间没有 await，所以同一会话同时进来时只有
  // 一个能真正调引擎。并发审查实测过这条成立，但一直没有常驻用例 —— 一旦守卫被挪到
  // await 之后，两个摘要调用会同时烧钱、互相覆盖失败记录。
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 300_000 },
    { seq: 3, tokens: 300_000 },
  ]
  let inFlight = 0
  let peak = 0
  let calls = 0
  const engine = {
    async compactRegion() {
      calls += 1
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight -= 1
      return { shadowedSeqs: [1], shadowedTokenCount: 300_000, summarySeq: 4 }
    },
  }
  const harness = fakeContext({ total: 900_000, window: 1_000_000, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100_000,
    agentDecidesCompaction: false,
    compactCooldownMs: 0,
    compactRetainTokens: 32_000,
  })
  const agent = agentWith([1, 2, 3], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  const preStep = harness.listeners.get('agent/pre-step')

  // 两条 pre-step 同时越线：第一个进入后 `autoCompacting` 已置位，第二个必须跳过。
  // 试过用 pre-step ∥ turn-stopping 来撞，但那条路在本场景下走不通 —— turn-stopping
  // 要求 `lastNotified` 还在（提醒真的发过），而 pre-step 一旦压缩成功就把它删掉，
  // 两个条件在同一个 total 下互斥。同一个守卫用两条 pre-step 测才是真重叠的。
  peak = 0
  calls = 0
  await Promise.all([
    runPreStep(preStep, { agent, turn: 1 }),
    runPreStep(preStep, { agent, turn: 1 }),
  ])

  assert.equal(peak, 1, `同一会话不得并发进入引擎，实际峰值 ${peak}（共进入 ${calls} 次）`)
})

test('预演遇到平衡守卫抛错时必须继续向左，不能当成已平衡', async () => {
  // 与真实压缩路径同一方向。宿主 `toolPairingBalancedBefore` 的契约是「无法判定就抛错，
  // 调用方不许继续」；预演若把抛错当成已平衡，会报出一个真实路径上根本不存在的切点
  // —— 那条路径会一路向左撞到硬边界，直接 no-op。第四轮修了真实路径，漏了这一份。
  const nodes = Array.from({ length: 10 }, (_, index) => ({ seq: index + 1, tokens: 50_000 }))
  const harness = fakeContext({
    total: 500_000,
    window: 1_000_000,
    nodes,
    balanceGuard: () => {
      throw new Error('平衡边界无法判定')
    },
  })
  apply(harness.ctx, { notifyTokens: 100_000, compactRetainTokens: 150_000 })
  const agent = agentWith(
    nodes.map((node) => node.seq),
    { eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }) },
  )
  const text = String(
    (await harness.registeredTools[0].execute({ action: 'status' }, { agent })).text,
  )

  const match = /平衡修正：keepFromIdx ([\d,]+) → ([\d,]+)/.exec(text)
  assert.ok(match !== null, `预演必须报出平衡修正，实际：${text}`)
  const from = Number(match[1].replaceAll(',', ''))
  const to = Number(match[2].replaceAll(',', ''))
  assert.ok(to < from, `抛错时必须继续向左（${from} → ${to}），不能停在原地当成已平衡`)
})

test('stage 参数不是字符串时必须拒绝，不能静默丢弃', async () => {
  // 同一个工具里 defer.tokens / compact.retainTokens 对类型错误都直接拒绝，stage 是唯一
  // 被静默丢弃的。它的后果最重：`guard` 会转而给「最新阶段」重建基线，把原本要守护的
  // 证据抹掉，而回执只说「已建立基线」。
  const nodes = [{ seq: 1, tokens: 1_000 }]
  const harness = fakeContext({ total: 1_000, window: 1_000_000, nodes })
  apply(harness.ctx, {})
  const tool = harness.registeredTools[0]
  for (const action of ['validate', 'guard', 'recall', 'reconcile']) {
    const result = await tool.execute({ action, stage: 12345, query: 'x' }, { agent: agentWith([1]) })
    assert.match(
      String(result.text ?? ''),
      /stage 必须是字符串，收到 number/,
      `${action} 收到数字 stage 必须拒绝，实际：${String(result.text).slice(0, 120)}`,
    )
  }
})

test('defer 抬到兜底压缩线以上时必须承认提醒可能发不出来', async () => {
  // defer 的硬上限是窗口 90%，而兜底压缩线是 85%：在 85%~90% 这一带，自动压缩会先
  // 动手，「到新的线照常提醒」就成了无法兑现的承诺。上限保留，但不能沉默。
  const nodes = [{ seq: 1, tokens: 400_000 }]
  const harness = fakeContext({ total: 400_000, window: 1_000_000, nodes })
  apply(harness.ctx, { notifyTokens: 300_000 })
  const agent = agentWith([1])
  const tool = harness.registeredTools[0]

  const raised = await tool.execute({ action: 'defer', tokens: 880_000 }, { agent })
  assert.match(String(raised.text), /已高于兜底压缩线 610,617/, `必须指出与兜底线的关系：${raised.text}`)
  assert.match(String(raised.text), /很可能永远发不出来/, '必须承认提醒可能发不出来')

  const below = await tool.execute({ action: 'defer', tokens: 500_000 }, { agent })
  assert.doesNotMatch(String(below.text), /已高于兜底压缩线/, '兜底线以下不该出现这条警告')
})

test('status 的探针行不能自己重复「未启用」（零信息文案）', async () => {
  // 旧文案在没设置环境变量时渲染成 `**未启用**（未启用）`：括号本该解释「为什么没有
  // 路径」，却把前一个词重复了一遍。读的人会以为括号里在说另一件事。
  const nodes = [{ seq: 1, tokens: 1_000 }]
  const harness = fakeContext({ total: 1_000, window: 1_000_000, nodes })
  apply(harness.ctx, {})
  const text = String(
    (await harness.registeredTools[0].execute({ action: 'status' }, { agent: agentWith([1]) }))
      .text,
  )
  assert.doesNotMatch(text, /（未启用）/, `括号里不能只是重复「未启用」：${text}`)
  assert.match(text, /pre-step 文件探针: \*\*未启用\*\*（.+）/, '未启用时必须说明原因')
})

test('status 预演：保留量按节点边界取整，只会多不会少', async () => {
  // 「压缩后逐字保留」是判断这次压缩会不会吃掉尾巴的唯一读数。算法按会话节点边界
  // 取整，所以累计值只会 >= 预算；若某次改动让它报出小于预算的数，说明保留区被少算
  // 了 —— 代价是模型失去逐字上下文，而这类错误没有任何其它信号能发现。
  const nodes = Array.from({ length: 20 }, (_, index) => ({ seq: index + 1, tokens: 50_000 }))
  const harness = fakeContext({ total: 1_000_000, window: 1_000_000, nodes })
  apply(harness.ctx, { notifyTokens: 100_000, compactRetainTokens: 200_000 })
  const agent = agentWith(
    nodes.map((node) => node.seq),
    { eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }) },
  )
  const text = String(
    (await harness.registeredTools[0].execute({ action: 'status' }, { agent })).text,
  )

  const match = /压缩后逐字保留：(\d+) 个节点（累计 ([\d,]+) tokens，预算 ([\d,]+)）/.exec(text)
  assert.ok(match !== null, `预演必须报出保留量，实际：${text}`)
  const keptNodes = Number(match[1])
  const keptTokens = Number(match[2].replaceAll(',', ''))
  const budget = Number(match[3].replaceAll(',', ''))

  assert.ok(keptNodes > 0, '至少保留一个节点')
  assert.equal(budget, 200_000, '预算必须就是配置的 compactRetainTokens')
  assert.ok(keptTokens >= budget, `取整只会多不会少：累计 ${keptTokens} 应 >= 预算 ${budget}`)
  assert.ok(
    keptTokens <= budget + 50_000,
    `最多多出一个节点（50,000 tokens），实际 ${keptTokens} vs 预算 ${budget}`,
  )
})

test('两个会话的压缩状态必须互不污染（多会话隔离）', async () => {
  // session 是每个 Map 的键，所以 A 的失败退避不该出现在 B 的 status 里。并发审查
  // 实测两边能同时在引擎里、状态各归各的，但同样没有常驻用例。
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 300_000 },
    { seq: 3, tokens: 300_000 },
  ]
  const failing = agentWith([1, 2, 3], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  const engine = {
    async compactRegion(_start, _end, target) {
      if (target === failing) throw new Error('A 会话的引擎炸了')
      return { shadowedSeqs: [1], shadowedTokenCount: 300_000, summarySeq: 4 }
    },
  }
  const harness = fakeContext({ total: 900_000, window: 1_000_000, nodes, engine })
  apply(harness.ctx, {
    notifyTokens: 100_000,
    agentDecidesCompaction: false,
    compactCooldownMs: 60_000,
    compactRetainTokens: 32_000,
  })
  const healthy = agentWith([1, 2, 3], {
    eventType: (seq) => ({ type: seq === 1 ? 'system/message' : 'message' }),
  })
  const preStep = harness.listeners.get('agent/pre-step')
  const tool = harness.registeredTools[0]

  await runPreStep(preStep, { agent: failing, turn: 1 })
  await runPreStep(preStep, { agent: healthy, turn: 1 })

  const failedText = String((await tool.execute({ action: 'status' }, { agent: failing })).text)
  const healthyText = String((await tool.execute({ action: 'status' }, { agent: healthy })).text)
  assert.match(failedText, /压缩失败退避/, `失败的会话应进入退避，实际：${failedText}`)
  assert.doesNotMatch(failedText, /压缩冷却/, '失败的会话不该显示成功冷却')
  assert.match(healthyText, /压缩冷却/, `成功的会话应处于成功冷却，实际：${healthyText}`)
  assert.doesNotMatch(healthyText, /压缩失败退避/, '成功的会话不该继承别人的退避')
})

test('Config schema 经 toJSON → rehydrate 后接受集不变（设置面板走的就是这条路）', async () => {
  // 面板读到的是 host 用 `schema.toJSON()` 序列化、浏览器再 `new Schema(…)` 重建的
  // schema —— 重建只带回结构，带不回函数闭包。`transform` 的函数体在那一侧被重新
  // 求值，任何模块作用域引用都会变成 ReferenceError。曾经如此：anchorRoot 与人类单位
  // token 两个 transform 都引用了闭包，重建后一执行就抛，浏览器侧 `decode()` 把它
  // catch 掉、返回 undefined，`derive()` 于是不更新 status —— 初值 'loading' 永远
  // 留着，面板无限转圈，刷新和重启都无效（是代码问题，不是偶发）。
  assert.ok(Config !== undefined, 'schemastery 不可用时这条测试没有意义')
  // 不能用 `Config.constructor`：schemastery 的 Schema 是函数对象，它的
  // constructor 是 `Function`，`new Function(json)` 会把 JSON 当代码执行。
  const z = (await import('@deepseek-ai/schemastery')).default
  const rehydrated = new z(Config.toJSON())
  const verdict = (schema, patch) => {
    const result = schema['~standard'].validate(patch)
    return result !== undefined && result.issues !== undefined ? 'issues' : 'ok'
  }
  const cases = [
    { anchorRoot: 'docs/anchors' },
    { anchorRoot: 'docs/../outside' },
    { anchorRoot: 'docs\n/outside' },
    { anchorRoot: '' },
    { anchorRoot: ' D:/abs/x ' },
    { notifyTokens: '360k' },
    { notifyTokens: '1.5' },
    { notifyTokens: 363520 },
    { notifyTokens: 2 ** 53 },
    { notifyRepeatDelta: '25k' },
    { compactRetainTokens: '32k' },
    { anchorTimeZone: '+14:01' },
    { anchorTimeZone: 330 },
    { anchorTimeZone: 'local' },
    { dshHome: '/data' },
    { dshHome: 'data' },
  ]
  for (const patch of cases) {
    assert.equal(
      verdict(rehydrated, patch),
      verdict(Config, patch),
      `${JSON.stringify(patch)} 在 schema 往返后必须与原始 schema 同口径`,
    )
  }
  const whole = {
    enabled: true,
    notifyTokens: 363520,
    notifyRepeatDelta: 25000,
    notifyCooldownMs: 300000,
    notifyOnTurnStartOnly: true,
    compactRetainTokens: 32000,
    compactCooldownMs: 60000,
    agentDecidesCompaction: true,
    keepAnchorBackups: 3,
    anchorLimitChars: 8000,
    anchorTimeZone: 'local',
    anchorRoot: 'docs/anchors',
  }
  assert.equal(
    verdict(rehydrated, whole),
    'ok',
    '整份真实配置在 schema 重建后必须仍被接受，否则面板永远停在 loading',
  )
})

test('dshHome 绝对路径判据平台无关，且面板闸与解析器同源', () => {
  // 判据曾用 `node:path` 的 `isAbsolute`（平台相关），而面板侧的
  // `isAbsolutePathInput` 写死了 win32 语义 ⇒ ubuntu 上「面板放行、host 拒绝」，
  // 用户在面板看到「已保存」、装载时字段被丢。CI 就是这么红的：ubuntu 三个
  // Node 版本全失败、windows 全绿。
  //
  // 静态契约：这条判据**不能**再依赖 `node:path`。在 Windows 上 `isAbsolute`
  // 恰好与目标正则同口径，运行时样本抓不到这类回退 —— 只有这条断言能抓。
  const configPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'config.js')
  const configSource = readFileSync(configPath, 'utf8')
  assert.doesNotMatch(
    configSource,
    /import\s*\{[^}]*\bisAbsolute\b[^}]*\}\s*from\s*'node:path'/,
    'dshHome 判据不得依赖 node:path 的 isAbsolute：它平台相关，面板侧无法复刻',
  )
  // 「任何平台都该接受」是错的：`isAbsolutePathInput` 在 POSIX 上只认前导 `/`，
  // `D:\data` 在 Linux 上并不是路径。样本按平台取，两条语义各自钉住。
  const winAbs = ['D:\\dsh-data', 'D:/dsh-data', '\\\\server\\share', '\\data']
  const posixAbs = ['/data', '/var/lib/dsh']
  const absolute = process.platform === 'win32' ? [...winAbs, ...posixAbs] : posixAbs
  for (const value of absolute) {
    assert.equal(
      resolveConfig({ dshHome: value }).dshHome,
      value,
      `${JSON.stringify(value)} 在任何平台都该按绝对路径接受`,
    )
  }
  const relative = ['data', 'C:rel', '~\\data', './x']
  for (const value of relative) {
    assert.throws(() => resolveConfig({ dshHome: value }), /绝对路径/, `${JSON.stringify(value)} 必须被拒`)
  }
  assert.equal(resolveConfig({ dshHome: '' }).dshHome, '')

  const { validateValue, coerce } = clientValidatorHelpers()
  const field = { key: 'dshHome', type: 'text' }
  for (const value of [...absolute, ...relative, '']) {
    let hostRejects
    try {
      resolveConfig({ dshHome: value })
      hostRejects = false
    } catch {
      hostRejects = true
    }
    // validateValue 成功时返回空字符串、失败返回原因文案，不能拿 undefined 比。
    const panelRejects = (validateValue(field, coerce(field, value)) ?? '') !== ''
    assert.equal(
      panelRejects,
      hostRejects,
      `${JSON.stringify(value)}：面板${panelRejects ? '拒' : '收'}而解析器${hostRejects ? '拒' : '收'}，两侧必须同源`,
    )
  }
})

test('人类单位 token：schema 接受集与解析器逐样本一致（含每个分段边界）', () => {
  // schema 里这两个字段曾经是 `transform`。transform 的 callback 是函数，
  // `schema.toJSON()` 带不走它 —— 宿主把 schema 发给浏览器、浏览器重建后
  // callback 是 undefined，客户端 `validate()` 抛 `callback is not a function`，
  // `decode()` 返回 undefined、`derive()` 跳过状态更新，设置面板永远停在
  // 「正在读取」。改成 pattern 之后，接受集必须与解析器逐样本对齐，否则
  // 「schema 放行、解析器拒绝」会让 `resolveConfigLenient` 静默丢字段。
  const schemaVerdict = (value) => {
    const result = /** @type {any} */ (Config['~standard'].validate({ notifyTokens: value }))
    return result !== undefined && result.issues !== undefined ? 'reject' : 'ok'
  }
  const parserVerdict = (value) => {
    try {
      resolveConfig({ notifyTokens: value })
      return 'ok'
    } catch {
      return 'reject'
    }
  }
  const samples = new Set()
  // k 与 m 的每个分段边界各取 ±1：区间段首尾相接，漏一段就会两边不一致。
  for (const n of [1, 99, 100, 99999, 100000, 899999, 900000, 969999, 970000, 975999, 976000, 976499, 976500, 976559, 976560, 976562, 976563]) {
    for (const d of [-1, 0, 1]) if (n + d > 0) samples.add(`${n + d}k`)
  }
  for (const n of [1, 99, 100, 899, 900, 949, 950, 953, 954]) {
    for (const d of [-1, 0, 1]) if (n + d > 0) samples.add(`${n + d}m`)
  }
  for (const n of [1, 999999999, 1000000000, 1000000001]) samples.add(String(n))
  for (const s of ['300k', '1m', '1.5k', '.5k', '0.5m', '1.3k', '300K', '300M', '976562.5k', '953.6m', '954.1m', '275000.5k', ' 300k ']) samples.add(s)
  for (const v of samples) {
    assert.equal(schemaVerdict(v), parserVerdict(v), `${JSON.stringify(v)} 的接受集两侧必须一致`)
  }
  // 面板保存路径本身：字符串值经 schema(draft) 不能抛（抛了就是永久 loading）
  const numericLike = ['300k', '1m', '1.5k', '400k']
  for (const v of numericLike) {
    assert.doesNotThrow(
      () => Config({ notifyTokens: v }),
      `${JSON.stringify(v)} 必须能被 schema resolve 通过（面板保存走这条路）`,
    )
  }
})

test('Config schema 不得包含不可序列化的节点（transform / custom）', () => {
  // `schema.toJSON()` 带不走函数。transform / custom 的 callback 是函数，序列化后
  // 只剩 {"type":"transform","meta":{}}；宿主把 schema 发给浏览器、浏览器
  // `new Schema(json)` 重建后 callback 是 undefined，客户端 `validate()` 一调就抛
  // `TypeError: callback is not a function`。那一抛被 `decode()` 接住、返回
  // undefined，`derive()` 于是跳过所有状态更新，`status` 永远停在初值 'loading'
  // —— 设置面板无限转圈，刷新和重启都不会好。这条是根因层面的契约：
  // 只要 Config 里出现一个函数型节点，面板就必然坏。
  assert.ok(Config !== undefined, 'schemastery 不可用时这条测试没有意义')
  const offenders = []
  const walk = (node, path) => {
    if (node === undefined || node === null) return
    // schemastery 的 Schema 节点本身是**函数对象**（可调用，带 type/meta/dict），
    // 只放行 typeof === 'object' 会让整个遍历在根节点就返回，测试永远绿。
    const kind = typeof node
    if (kind !== 'object' && kind !== 'function') return
    if (node.type === 'transform' || node.type === 'custom') offenders.push(`${path} (${node.type})`)
    for (const [key, child] of Object.entries(node.dict ?? {})) walk(child, `${path}.${key}`)
    if (node.inner !== undefined) walk(node.inner, `${path}[]`)
    for (const child of node.list ?? []) walk(child, `${path}[]`)
  }
  walk(Config, 'Config')
  assert.deepEqual(
    offenders,
    [],
    '这些节点序列化后会丢掉 callback，设置面板必然卡在「正在读取」；改用可序列化的 pattern',
  )
})

test('经宿主 volatileForm 往返后 schema(draft) 不抛（设置面板初始化与保存的真实入口）', async () => {
  // 客户端 `SettingsSchemaService.validate` 调的是 `schema(draft)`（schemastery 的
  // resolve，**抛错**），不是 `~standard.validate`（返回 issues、不抛）—— 前面两次
  // 判断失误都出在入口选错上。
  //
  // 还有第二层：宿主 `describe()` 发出去的**不是** `Config.toJSON()`，而是
  // `volatileForm(Config).toJSON()`；`volatileForm` 会用 `new Schema(s.toJSON())`
  // 把每个 volatile 字段重建一遍，于是多了一层序列化 —— transform 的 callback
  // 正是这一层彻底丢掉的（只 `Config.toJSON()` 一次往返反而还能用）。
  // 宿主源码是 TS，测试只能按契约复刻这两段；复刻漂移的风险由这条测试本身兜住：
  // 一旦 Config 里再出现 transform，`rebuilt(real)` 就会抛 `callback is not a function`。
  assert.ok(Config !== undefined, 'schemastery 不可用时这条测试没有意义')
  const Schema = (await import('@deepseek-ai/schemastery')).default
  const redactSecrets = (_node, value) => ({ value })
  const plainSchema = (input) => {
    const result = new Schema(input.toJSON())
    const walk = (node) => {
      delete node.meta.volatile
      if (node.meta.role === 'secret') {
        delete node.meta.default
        delete node.meta.required
      } else if (node.meta.default !== undefined) {
        node.meta.default = redactSecrets(node, node.meta.default).value
      }
      for (const child of Object.values(node.dict ?? {})) walk(child)
      if (node.inner) walk(node.inner)
      for (const child of node.list ?? []) walk(child)
    }
    walk(result)
    return result
  }
  const volatileForm = (input) => {
    if (input.meta.volatile) return plainSchema(input)
    if (input.type === 'object') {
      const dict = Object.fromEntries(
        Object.entries(input.dict ?? {}).flatMap(([key, child]) => {
          const field = volatileForm(child)
          return field === undefined ? [] : [[key, field]]
        }),
      )
      return Object.keys(dict).length === 0 ? undefined : Schema.object(dict)
    }
    return undefined
  }
  const form = volatileForm(Config)
  assert.notEqual(form, undefined, '整份 Config 都是 volatile 字段，表单必须存在')
  const rebuilt = new Schema(form.toJSON())

  const real = resolveConfig({
    notifyTokens: 363520,
    notifyRepeatDelta: 25000,
    notifyCooldownMs: 300000,
    notifyOnTurnStartOnly: true,
    compactRetainTokens: 32000,
    compactCooldownMs: 60000,
    agentDecidesCompaction: true,
    keepAnchorBackups: 3,
    anchorLimitChars: 8000,
  })
  assert.doesNotThrow(
    () => rebuilt(real),
    '面板初始化（describe → volatileForm → decode → validate）必须通过，否则永远停在「正在读取」',
  )
  // 保存路径：把数值字段改成人类单位字符串，schema(draft) 同样不能抛。
  for (const value of ['360k', '1m', '32k']) {
    assert.doesNotThrow(
      () => rebuilt({ ...real, notifyTokens: value }),
      `保存 ${JSON.stringify(value)} 时 schema(draft) 不能抛`,
    )
  }
  // anchorRoot 的保存路径也要过（它是曾经的 transform 字段）。
  assert.doesNotThrow(() => rebuilt({ ...real, anchorRoot: 'docs/anchors' }))
})

test('裸分隔符根在 Windows 上解析到当前盘符根：这条钉住的是现状，不是理想行为', () => {
  // 评审 P2-12 选了「只写文档 + 钉住测试」，不动判据：面板与解析器共用
  // `normalizeAnchorRoot`，加平台分叉会让 schema 放行、解析器拒绝 —— 正是本仓库
  // 头号事故形态（字段被静默丢弃，锚点写回默认目录）。所以这条测试描述的是
  // 当前行为；它存在的意义是让下一个想改语义的人先看到文档要一起更新。
  assert.equal(normalizeAnchorRoot('/docs/anchors'), '/docs/anchors')
  const resolved = resolve('C:\\work', normalizeAnchorRoot('/docs/anchors'))
  if (process.platform === 'win32') {
    assert.equal(
      resolved,
      'C:\\docs\\anchors',
      `Windows 上裸分隔符根取的是当前盘符根，不是工作区相对路径；实际 ${resolved}`,
    )
  } else {
    assert.equal(resolved, '/docs/anchors', 'POSIX 上它本来就是绝对路径')
  }
})

test('兜底压缩在长轮次（step>1）仍然可达：提醒闸不能提前 return', async () => {
  // 兜底压缩排在四道提醒闸之后，而它要防的正是「agent 一直在长轮次里、turn 迟迟
  // 不收口」—— 那种情况的 `step` 必然 > 1，于是四道闸的 `return` 把安全阀在它
  // 唯一的用武之地整段挡死（实测修前 step=2/5 时引擎调用次数为 0）。
  const nodes = [
    { seq: 1, tokens: 300_000 },
    { seq: 2, tokens: 300_000 },
    { seq: 3, tokens: 300_000 },
  ]
  const makeEngine = (sink) => ({
    async compactRegion(start, end) {
      sink.push([start, end])
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 5 }
    },
  })

  for (const step of [1, 2, 5]) {
    const calls = []
    const harness = fakeContext({ total: 900_000, window: 1_000_000, nodes, engine: makeEngine(calls) })
    apply(harness.ctx, { notifyTokens: 100_000, compactRetainTokens: 600_000, agentDecidesCompaction: false })
    await runPreStep(harness.listeners.get('agent/pre-step'), { agent: agentWith([1, 2, 3]), step })
    assert.equal(calls.length, 1, `step=${step} 时兜底压缩仍须执行（占用已过宿主墙的 90%）`)
  }
})

test('defer=off 之后 turn-stopping 仍能收口压缩（配额不能被每次 pre-step 擦掉）', async () => {
  // `off` 把 effectiveNotify 抬成 MAX_SAFE_INTEGER，`total < effectiveNotify` 于是
  // 恒真 —— 原来每次 pre-step 都在那个分支里 `state.lastNotified.delete(session)`，
  // 而 turn-stopping 的第一道闸正是 `!lastNotified.has(session) → return`。
  // 结果是回执只说「本会话的提醒已关闭」，主自动压缩也一起停了。
  const nodes = [
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
  ]
  const calls = []
  const engine = {
    async compactRegion(start, end) {
      calls.push([start, end])
      return { shadowedSeqs: [2], shadowedTokenCount: 100, summarySeq: 4 }
    },
  }
  const harness = fakeContext({ total: 210, nodes, engine })
  apply(harness.ctx, { notifyTokens: 100, compactRetainTokens: 1, agentDecidesCompaction: false })
  const agent = agentWith([1, 2, 3])
  const tool = harness.registeredTools[0]

  // 前提：先让一条提醒真的到过模型（配额写进去）
  const notice = await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  assert.ok(notice.messages.length > 1, '前提：先有一条收尾提醒落地')

  const deferred = await tool.execute({ action: 'defer', tokens: 'off' }, { agent })
  assert.match(deferred.text, /提醒已关闭/)

  // 关键：off 之后必然还会经过 pre-step（工具结果回来的下一步就是），配额不能被擦掉
  const after = await runPreStep(harness.listeners.get('agent/pre-step'), { agent })
  assert.equal(after.messages.length, 1, 'off 之后确实不再提醒')

  await runTurnStopping(harness.listeners.get('agent/turn-stopping'), { agent })
  assert.equal(calls.length, 1, 'defer=off 只关提醒，turn-stopping 的自动压缩必须照常')
})

test('模拟 POSIX 语义：dshHome 只认前导 /，Windows 盘符与 UNC 都要被拒', () => {
  // 这条测试的存在理由，是同一个 bug 犯了两次：`dshHome` 的绝对路径判据曾经依赖
  // `node:path.isAbsolute`（平台相关），于是 ubuntu 上「面板放行、host 拒绝」，
  // 而 windows 上一切正常 —— 本地永远绿，只有 push 之后 CI 才红。
  //
  // 上一次的防护是**静态检查**（正则扫源码里有没有 isAbsolute），它只能证明「没用某个
  // API」，证明不了行为。所以这里直接把 `process.platform` 临时改成 linux，在 Windows
  // 开发者机器上跑一遍 POSIX 分支 —— 这样这个回归在本地就会红，不必等 CI。
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    assert.throws(
      () => resolveConfig({ dshHome: 'D:\\dsh-data' }),
      /dshHome/,
      'POSIX 上 D:\\ 不是绝对路径，必须拒绝',
    )
    assert.throws(
      () => resolveConfig({ dshHome: '\\\\server\\share' }),
      /dshHome/,
      'POSIX 上 UNC 不是绝对路径，必须拒绝',
    )
    assert.equal(resolveConfig({ dshHome: '/var/lib/dsh' }).dshHome, '/var/lib/dsh')
  } finally {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor)
  }
})

test('模拟 win32 语义：dshHome 接受盘符与 UNC（linux CI 上也能跑这条）', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    for (const ok of ['D:\\dsh-data', '\\\\server\\share', 'C:\\a']) {
      assert.equal(
        resolveConfig({ dshHome: ok }).dshHome,
        ok,
        `win32 语义下应当接受 ${JSON.stringify(ok)}`,
      )
    }
    assert.throws(() => resolveConfig({ dshHome: 'data' }), /dshHome/, '相对路径在 win32 上也要拒')
  } finally {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor)
  }
})
