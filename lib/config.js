// @ts-check
/**
 * 配置层：默认值、校验、人类单位解析。
 *
 * 纯函数，不碰任何宿主服务。未知键一律拒绝，避免拼写错误静默落回默认值 ——
 * 一个写错的 `notifyTokens` 悄悄用默认值，表现和「插件完全忽略配置」一样难查。
 *
 * @module dsh-stage-handoff/config
 */
/**
 * `dshHome` 的绝对路径判据 —— **平台无关**，必须与 `lib/client.js` 里的
 * `isAbsolutePathInput` 逐字一致（面板闸与解析器同源是硬约束）。
 *
 * 这里刻意不用 `node:path` 的 `isAbsolute`：它是**平台相关**的，而浏览器端
 * 拿不到平台（Web GUI 可能远程连到另一台机器），于是面板只能猜。猜错的后果是
 * 「面板放行、host 拒绝」—— 用户在面板里看到「已保存」，装载时字段被丢。
 * CI 上就是这么暴露的：ubuntu 三个 Node 版本全红、windows 全绿。
 *
 * 只认三种：盘符绝对（`D:\` / `D:/`）、反斜杠开头（`\data`、`\\server\share`）、
 * 斜杠开头（`/data`）。`C:rel` 是**盘符相对**路径，两侧都拒。
 */
export const ABSOLUTE_PATH_INPUT = /^(?:[A-Za-z]:[\\/]|[\\/])/

/**
 * 平台无关的绝对路径判定，供 `resolveConfig` 与面板闸共用同一条判据。
 *
 * 注意 `win32` 与 POSIX **不一样**：在 POSIX 上 `D:/x` 不是绝对路径，它会被
 * `path.resolve` 当相对路径拼到 cwd 后面 —— 于是 `anchorRoot: D:/x` 的配置
 * 会静默落到 `<工作区>/D:/x`，用户看到的是一个莫名其妙的目录。这里按平台
 * 收紧：POSIX 只认以 `/` 开头的路径。
 *
 * 面板自己那份（lib/client.js）保持宽松 —— 浏览器不知道宿主跑在什么平台上，
 * 而最终判据始终是宿主这一侧。
 *
 * @param value - 待判定的输入。
 * @returns 是否形如当前平台上的绝对路径。
 */
export function isAbsolutePathInput(value) {
  const text = String(value).trim()
  if (process.platform !== 'win32') return text.startsWith('/')
  return ABSOLUTE_PATH_INPUT.test(text)
}


import { ANCHOR_FILE_MAX_BYTES, elidePathsIn, isPlainObject } from './util.js'

/**
 * Remove Loader/Schemastery live references from a validated config snapshot.
 *
 * Schemastery's `.volatile()` fields are stable references with a `get()`
 * method, not plain scalars. Cordis intentionally passes those references to
 * `apply()` so settings edits can update the running plugin without remounting
 * it. Normalize them before applying this plugin's stronger semantic checks.
 *
 * @param value - A validated config value or one of its nested values.
 * @returns A detached, ordinary-value tree.
 */
function plainConfig(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((child) => plainConfig(child, seen))
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) {
      // 循环引用的配置会让递归无限展开成 `RangeError: Maximum call stack size
      // exceeded` —— 一条来自 JS 引擎、与本插件无关、也不点名配置键的消息。而且
      // `resolveConfigLenient` 的整个存在理由就是「坏配置不许整体失效」，它自己
      // 在 stack overflow 上抛错就违背了这个契约。
      throw new Error('dsh-stage-handoff: 配置里存在循环引用，无法展开')
    }
    seen.add(value)
    try {
      if (typeof value.get === 'function') return plainConfig(value.get(), seen)
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, plainConfig(child, seen)]),
      )
    } finally {
      // 只在**当前路径**上去重：同一个对象出现在两个兄弟位置是合法的（不是循环）。
      seen.delete(value)
    }
  }
  return value
}

/**
 * 把任意值塞进错误消息时用这个，不要直接用 `JSON.stringify`。
 *
 * `JSON.stringify(10n)` 抛 `TypeError: Do not know how to serialize a BigInt`，
 * 于是「点名哪个配置键坏了」的诊断路径自己先炸了，用户拿到的是一条与本插件无关、
 * 也不含键名的消息。
 *
 * @param value - 未受信任的值。
 * @returns 可用于错误消息的短字符串。
 */
function safeFormat(value) {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * 配置映射的判据：真的是映射，而不是 `Date` / `Map` / `Set` / `RegExp` /
 * TypedArray / `Promise` 这些同为 `typeof 'object'` 的内建类型。
 *
 * 为什么不能只用 `isPlainObject`：那条判据只排除 null 与数组，是给宿主事件与
 * JSON 形状用的宽松口径。用在这里时，`resolveConfig(new Date(0))` 会进入
 * `plainConfig`，而 `Object.entries(new Date(0))` 是空数组 —— 配置被**静默**换成
 * 全部默认值，一个字段的提示都没有。这正是 `shapeError` 这条判据存在的理由。
 *
 * 自定义类实例（含 schemastery `.volatile()` 的引用包装）仍然放行：它们的 toStringTag
 * 就是 `Object`，交给 `plainConfig` 解包 —— 那才是热更新的正常形态。
 *
 * @param value - 未受信任的配置。
 * @returns 是否是配置映射。
 */
function isConfigMapping(value) {
  if (!isPlainObject(value)) return false
  const tag = Object.prototype.toString.call(value)
  return tag === '[object Object]' || tag === '[object Arguments]'
}

/**
 * 描述一个值的形状，用于「配置必须是一个映射」这类消息。
 * @param value - 未受信任的值。
 * @returns `null` / `数组` / 内建类型名 / `typeof` 结果。
 */
function describeShape(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  // 基本类型直接用 `typeof`：「收到 string」比「收到 String」更直白，也保持这条消息
  // 原来的措辞（旧实现就是 `typeof source`）。
  if (typeof value !== 'object') return typeof value
  const tag = Object.prototype.toString.call(value)
  if (tag !== '[object Object]') return tag.slice(8, -1)
  return typeof value
}

/**
 * 提醒线的默认值：363,520，也就是**宿主压缩墙的一半**。
 *
 * 1 MiB 窗口（1,048,576）上墙是 `min(W×0.8, W−256k−65.5k) = 727,040`（69.3%），
 * 一半即 363,520。
 *
 * 为什么是「墙的一半」而不更高：提醒不是压缩，是**让 agent 停手写交接文档**。
 * 收尾实测只花 12–40k tokens，一半的墙留给收尾足够宽裕；再高就会在墙前留不出
 * 收尾空间。
 *
 * 这个值曾经是 360,000 —— 按「1M 窗口的 36%」调出来的整数，与真正的半墙差 1%。
 * 于是出现过一个别扭的局面：预设档用 363,520（显式半墙），默认键用 360,000，
 * 同一份设计在代码里有两个数。现在两处同源：默认就是半墙，预设也取半墙。
 *
 * 提醒线必须**低于宿主压缩墙**，否则历史先被压掉、提醒永远发不出来。
 * `stage_handoff(action="status")` 会把墙、距墙与兜底线一起报出来。
 */
export const DEFAULT_NOTIFY_TOKENS = 363520
export const DEFAULT_NOTIFY_REPEAT_DELTA = 25000
/**
 * 两次提醒之间的**时间**下限，默认 5 分钟。与 `notifyRepeatDelta` 是「与」的关系：
 * 两个条件都满足才会再次提醒。
 *
 * 这道闸需要存在，因为 `notifyRepeatDelta` 量的是**增长量**，而忙碌的一轮（连续
 * 读大文件、跑测试）能在一两分钟内顶过 25k。但不能设太长：10 分钟的闸在高强度
 * 工作下可能整段跳过提醒窗口，让上下文直接冲过宿主的压缩线，一次都没提醒到。
 *
 * 5 分钟是折中 —— `notifyOnTurnStartOnly` 默认开启，轮次边界本身已经是一道节流，
 * 时间闸不必再那么严。`0` 关闭这道闸。
 */
export const DEFAULT_NOTIFY_COOLDOWN_MS = 300000
/**
 * 是否只在轮次的第一步考虑提醒。默认开。
 *
 * `agent/pre-step` 每一步都触发，光靠 25k 的增量闸挡不住：长上下文里读两个
 * 文件、跑一条命令就能涨 25k，实测在 60% 水位下五分钟内会连弹两条。轮次边界
 * 本身是一道天然节流，而且「一轮结束时收尾」比「一步中间收尾」更容易执行。
 */
export const DEFAULT_NOTIFY_ON_TURN_START_ONLY = true
export const DEFAULT_ANCHOR_ROOT = 'docs/anchors'
export const DEFAULT_ANCHOR_LIMIT_CHARS = 8000
/**
 * 阶段目录命名使用的时区。默认 `local` = 这台机器的本地时间。
 *
 * 为什么需要可配：锚点目录名里的时间戳是给人看的，而人可能换时区（出差、夏令时）
 * 或与别人协作。固定成本地时间的话，同一个人在不同时区建的两个目录会看起来
 * 倒序；固定成 UTC 又会让目录名与自己看到的钟差好几小时。所以三档都给：
 * `local` / `utc` / 显式偏移（`+8`、`-5`、`+05:30`）。
 */
export const DEFAULT_ANCHOR_TIME_ZONE = 'local'
/**
 * 主动压缩时逐字保留的尾部预算，默认 32,000。
 *
 * 为什么不是「对齐 auto 的 retainTokens」：那个数字曾经是 97,085 —— 按
 * W=1,000,000、O=393,216 推算的 `0.16 × 606,784`。实测请求的 `maxTokens` 是
 * 256,000，auto 的真实保留量因此是 `0.16 × 744,000 = 119,040`，两者本来就不相等；
 * 「插件压缩保留得和自动压缩一样多」这个前提在真实配置下不成立。
 *
 * 更重要的是 97,085 本身就太大。CompactionBench 的保留量消融里，摘要上限 40K +
 * 尾部 20K 得分最好（85.81），尾部 60K 最差（68.36）——**尾部留得越多，摘要里
 * 过期的 `Next Step` 与尾部原文冲突的面积越大**。实测 `session-ccc00003`：
 * 工具压缩按 97,085 保留（中英混排下实际约 160k）后上下文 179,155，两个 turn
 * 后模型陷入 16,269 tokens 的复读；人工手动 `/compact`（保留 0）后 24,376，
 * 立刻恢复。
 *
 * 32,000 在中文内容下实际保留约 50k，落在「尾部 20K–40K」这个最优区间内。
 */
export const DEFAULT_COMPACT_RETAIN_TOKENS = 32000
/**
 * 宿主压缩插件为「本回合输出」预留的 token 数，默认 256,000。
 *
 * 它不是本插件的预算，而是**推导宿主压缩墙**的输入。`dsh-compaction-basic` 的公式是：
 *
 *   wall = floor(min(W × 0.8, W − maxTokens − headroomTokens))
 *
 * 其中 `maxTokens` 来自请求 header 的 `maxTokens` —— 也就是适配器/连接为这个模型配的
 * 输出上限（`dsh-llm-deepseek` 的 `connection.maxTokens ?? 256e3` 会把它写进去）。
 * 注意它**不是**模型 `policies.maxTokens`：那个值在 compaction 里缺省等于
 * `headroomTokens`（65,536），按它算会让 1 MiB 窗口得到 838,860 而不是 727,040。
 * `headroomTokens` 默认 65,536，`thresholdRatio` 默认 0.8。所以**压缩墙不是窗口的
 * 固定比例**：1 MiB 窗口下它是 69.3%，512 KiB 下只有 38.7%，而 256 KiB 下压力预算
 * 为负、宿主会直接抛 `TargetPressureConfigError`。
 *
 * 默认取宿主当前默认值。换模型（输出预算不同）时应把它改成该模型的 `maxTokens`，
 * 否则本插件算出的墙会偏 —— 提醒线与兜底线都跟着偏。面板上给这个字段配了警告标识。
 */
export const DEFAULT_HOST_MAX_TOKENS = 256000
/**
 * `hostMaxTokens: 'auto'` —— 由插件在运行时向宿主查询，而不是写死一个数。
 *
 * 解析顺序（先命中的赢）：
 *   1. `agent.options.maxTokens` —— 宿主已确定的单请求输出上限（显式覆盖优先）
 *   2. `ctx.llm.resolveModelInfo(provider, model).defaultMaxTokens` —— 适配器为该模型
 *      声明的默认上限（`dsh-llm-deepseek` 是 `256e3`）
 *   3. {@link DEFAULT_HOST_MAX_TOKENS} —— 都拿不到时退回
 *
 * 拿不到就退回默认值，不抛 —— 这条路径在 pre-step 里跑，宁可算偏也不能让提醒挂掉。
 */
export const AUTO_HOST_MAX_TOKENS = 'auto'
/**
 * 宿主 `headroomTokens` 的**默认**值，65,536。
 *
 * 宿主读 `config.headroomTokens ?? 65536`，并且允许 `modelPolicies` 逐 provider/model
 * 覆盖 —— 也就是说它并不总是 65,536。这里写死默认值是因为本插件看不到宿主的
 * compaction 配置；宿主若改过这一项，本插件算出的墙会偏（偏大 → 线落在墙后）。
 * 判据是「只在宿主使用默认值时才准」，不是「宿主硬编码」。
 */
export const HOST_HEADROOM_TOKENS = 65536
/**
 * 宿主 `thresholdRatio` 的**默认**值，0.8（`DEFAULT_THRESHOLD_RATIO`）。
 *
 * 墙取 `min(W × ratio, W − reserved − headroom)`，所以只有**小窗口**才会被这个
 * 比例钳住（大窗口上压力预算总是更小）。与 `headroomTokens` 一样可被宿主的
 * `config.thresholdRatio` 和 `modelPolicies` 覆盖：实测宿主把它设成 0.5 时，
 * 1 MiB 窗口的真墙是 524,288，而本插件仍会算 727,040。
 */
export const HOST_THRESHOLD_RATIO = 0.8
/**
 * 宿主 `retainRatio` 的默认值，0.16（`DEFAULT_RETAIN_RATIO`）。
 *
 * 它不是墙的一部分，而是墙的**下限约束**：`resolveCompactSpec` 先算
 * `retainTokens = floor((W − reserved) × retainRatio)`，然后要求
 * `retainTokens < thresholdTokens`，否则抛 `TargetPressureConfigError`。
 *
 * 这条约束在窄窗口上比「压力预算 ≤ 0」更早触发：`W = 321,537`、reserved = 256,000
 * 时压力预算恰好是 1，墙算出 1，而 retain 是 10,485 —— 宿主必然抛错。旧实现漏了
 * 这条，于是 status 会报一个「宿主压缩墙 1 tokens」的荒唐读数。
 */
export const HOST_RETAIN_RATIO = 0.16
/**
 * 两次压缩之间的最小间隔（毫秒）。`0` 关闭冷却。
 *
 * 防的是压缩风暴：一个循环里反复调 compact，每次都触发一次摘要模型调用、反复
 * 重写历史，既烧额度又可能把会话压到没法干活。冷却按会话计，不是全局。
 */
export const DEFAULT_COMPACT_COOLDOWN_MS = 60000
/**
 * 是否由 agent 自己决定何时压缩。默认 `true`。
 *
 * `true`：插件只提醒，压缩由 agent 收尾完成后主动调用 `compact`。
 * `false`：到线时插件自动压一次，不等 agent 决定。提醒仍然照发 —— 压缩腾出的是
 * 空间，不是结论；把这一阶段学到的东西写进锚点仍然得由 agent 做。
 */
export const DEFAULT_AGENT_DECIDES_COMPACTION = true
/**
 * 流式复读守卫（试验性）。默认 `true`。
 *
 * `true`：在模型生成过程中观察 reasoning 尾部，发现原地重复就在**下一个 step**
 * 开始时提醒一句 —— 比等 turn 结束再扫日志早一整轮。
 *
 * 它**只提醒、从不截断**：PREWARN 实测窗口化重复判据在「法官确认非退化」的长答案
 * 上仍会触发 79.5–100%，拿它当停止条件会掐断合法长回答，所以没有"检测到就停"这个选项。
 * 判据本身偏保守（尾部连续重复 5 遍、覆盖 ≥200 字符，比离线更严），成本也低
 * （每 24 个 delta 才查一次尾部窗口），所以默认开着；面板上可以随时关掉。
 */
export const DEFAULT_STREAM_GUARD = true
/**
 * 检测到「一行占满整个思考窗口」时，是否直接 `reject` 掉这个 step 所在 turn。
 *
 * **默认关闭，而且它是破坏性动作。** `reject` 在 DSH 引擎里是
 * `turnEnds = { kind: 'blocked' }` —— 整个 turn 当场结束，用户看到的是被中断的回合，
 * 不是「这一步跳过」。所以它只在复读无可争议时才该开：行级占比 ≥ 0.8。
 *
 * 开它的理由：实测单纯提醒的效果只有约 20%（65 个样本里 13 变干净 / 34 没变 /
 * 18 更差，见 `docs/VALIDATION.md`）。关它的理由：判据还不够准，误判一次就中断一次。
 */
export const DEFAULT_REJECT_ON_REPEAT = false
/**
 * `action="cleanup"` 在 `parent-backup/` 里保留多少个最新备份。默认 3。
 *
 * 只影响**清单**：插件不删除任何文件，这个数字决定「几个算旧」。
 */
export const DEFAULT_KEEP_ANCHOR_BACKUPS = 3

/**
 * `.anchor-guard.json` 的大小上限，默认 1 MiB（与锚点文件的安全读上限一致）。
 * 写入与读取必须用同一个值：写入不设限、读取设限会导致「基线写得出、读不回」的自锁。
 * 调大它是允许的，但会放宽有界读取的保证，面板上给警告。
 */
export const DEFAULT_GUARD_MAX_BYTES = ANCHOR_FILE_MAX_BYTES
export const MIN_GUARD_MAX_BYTES = 64 * 1024
export const MAX_GUARD_BYTES = 16 * 1024 * 1024

/**
 * 阶段目录预留 sidecar 的有效期，默认 1 天。
 *
 * sidecar 记的是「某个 pid 正在发布这个阶段」。进程死在 mkdir 与 rename 之间时，
 * 单看 pid 存活无法区分「真的还在跑」和「pid 已被复用」；超过这个时长就按过期处理，
 * 允许下一次 scaffold 回收，避免同一分钟同一 topic 的阶段永远建不出来。
 * 默认 1 天足够覆盖任何正常 scaffold；调小会让长任务更容易被误回收。
 */
export const DEFAULT_STALE_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000
export const MIN_STALE_RESERVATION_TTL_MS = 60 * 1000
// 上限不能超过 MAX_CONFIG_INTEGER（1e9 毫秒 ≈ 11.5 天），否则 schema 接受、
// parsePositiveInteger 拒绝，又变成两套边界。7 天足够覆盖任何正常场景。
export const MAX_STALE_RESERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * DSH 数据根目录，用来定位 `sessions/` 以便统计各会话的落盘占用。
 * 留空表示读环境变量 `DSH_HOME`；两者都没有时，会话占用那一项会报「无法定位」。
 */
export const DEFAULT_DSH_HOME = ''

/**
 * 是否从 `tool/call` 事件里**机械推导**「本会话碰过哪些文件、跑过哪些命令」，
 * 并在 `status` 与提醒里报告。默认开。
 *
 * 依据是 Cline 的做法：能从工具调用推导的字段别交给模型叙述 —— 模型会漏，代码不会。
 * 它的摘要 `## Files` 段由代码从工具调用提取，模型漏写会被补上。
 *
 * 关掉它的唯一理由是你觉得多出来的那几行吵。推导本身是只读、确定、零模型调用的。
 */
export const DEFAULT_REPORT_TOOL_FACTS = true

/**
 * 是否在「还有工具调用没拿到结果」时跳过提醒。默认开。
 *
 * 提醒的价值在于让 agent 停手写交接；而 agent 正等一个工具返回时插提醒，
 * 它要么在下一步才看见，要么被打断在半个动作里 —— 那时候提醒是噪声。
 * 跳过**不消耗**提醒配额：这一轮走完、仍然过线，还会照常提醒。
 */
export const DEFAULT_NOTIFY_SKIP_WHEN_TOOL_PENDING = true

/**
 * 是否在压缩成功后的第一次 pre-step 注入「先读锚点」提醒。默认开。
 *
 * 为什么需要它：DSH 的摘要器只读取**被压掉的区间**，看不到被保留的尾部，却被
 * 要求写 `Current Work` 与 `Next Step`。压缩后的上下文于是同时包含「摘要说下一步
 * 做 X」和「尾部原文显示 X 已完成」——实测会让模型陷入重做循环（一次 16,269
 * tokens 的空转输出）。这条提醒在压缩后的第一个 enter 决策前插一句话，把模型的
 * 注意力从过期的 `Next Step` 拉回锚点文件。
 *
 * 它**不消耗**提醒配额，也不改写 `lastNotified`：修的是「压缩刚发生」这一个时刻，
 * 与上下文水位无关。详见仓库内的内部测量笔记（不随包发布）。
 */
export const DEFAULT_NOTIFY_AFTER_COMPACTION = true

/**
 * Human-readable token counts shared by the Host schema and semantic parser.
 * The schema must accept exactly the forms `parseTokenCount` can normalize.
 *
 * That is why a decimal fraction is only legal when it carries `k`/`m`: the
 * schema cannot multiply, so it cannot tell `1.5k` (an exact 1536) from `1.3k`
 * (1331.2, which used to make `parseTokenCount` throw). Accepting bare `1.5`
 * would let the schema bless a value the parser rejects — and a rejected value
 * in the loader path means the whole plugin never mounts. `parseTokenCount`
 * therefore rounds a fractional product instead of throwing.
 */
export const HUMAN_TOKEN_PATTERN =
  /^\s*(?:([1-9]\d*)\s*([kKmM]?)|([1-9]\d*\.\d+|0?\.[1-9]\d*)\s*([kKmM]))\s*$/

/**
 * Canonical time-zone spellings accepted by every boundary.
 *
 * Positive offsets are bounded by UTC+14:00 and negative offsets by UTC-12:00.
 * Minute suffixes must be 00..59, and boundaries cannot carry extra minutes.
 *
 * The pattern only pins the shape. Which length means what is decided by
 * `normalizeTimeZone`: a bare three-digit value is minutes (`-300`), while
 * `+05:30` / `+0530` are clock offsets and `+8` / `-5` are hours.
 */
/**
 * `anchorTimeZone` 在 schema 层接受的形状，必须与 `normalizeTimeZone` 的接受集
 * **逐值一致**：schema 放行而解析器拒绝时，`resolveConfig` 会抛错，挂载期就是
 * 整个插件不工作。旧版用 `(?::?[0-5]\d)?` 让三位数字既被读成「时:分」又被读成
 * 「分钟」，`-745` / `+900` 于是穿过 schema 再被解析器拒掉。
 *
 * 现在每种写法只有一个分支，数值范围写进正则（分钟：正 0–840、负 0–720；
 * 小时：正 0–14、负 0–12；`H:MM` 与 `HHMM` 的上界同样按分钟界收紧）。
 *
 * 两处曾经比解析器**严**（解析器接受而 schema 拒绝，穷举比对抓到 203 个值）：
 * 三位分钟数漏了 `0\d\d` 这一段（`+053` 唯一可读成 53 分钟），以及整体不认首尾
 * 空白（`'local '`、`' +8'` —— 解析器第一件事就是 trim）。schema 更严不危险，
 * 但用户会拿到一句与真实原因无关的 schema 报错。
 */
export const TIME_ZONE_PATTERN =
  /^\s*(?:local|utc|z|[+](?:(?:0?[0-9]|1[0-3]):[0-5]\d|14:00)|[-](?:(?:0?[0-9]|1[01]):[0-5]\d|12:00)|[+](?:0\d[0-5]\d|1[0-3][0-5]\d|1400)|[-](?:0\d[0-5]\d|1[01][0-5]\d|1200)|[+](?:0\d\d|[1-7]\d\d|8[0-3]\d|840)|[-](?:0\d\d|[1-6]\d\d|7[01]\d|720)|[+](?:0?[0-9]|1[0-4])|[-](?:0?[0-9]|1[0-2]))\s*$/i

export const CONFIG_KEYS = new Set([
  'notifyTokens',
  'notifyRepeatDelta',
  'notifyCooldownMs',
  'notifyOnTurnStartOnly',
  'anchorRoot',
  'anchorLimitChars',
  'anchorTimeZone',
  'compactRetainTokens',
  'compactCooldownMs',
  'hostMaxTokens',
  'agentDecidesCompaction',
  'streamGuard',
  'rejectOnRepeat',
  'keepAnchorBackups',
  'guardMaxBytes',
  'staleReservationTtlMs',
  'dshHome',
  'reportToolFacts',
  'notifySkipWhenToolPending',
  'notifyAfterCompaction',
  'enabled',
])

/**
 * 整数类配置的上界。安全整数（2^53−1）本身是硬边界，但这里再收紧一层：
 * 十亿以上的 token 预算或冷却毫秒没有实际含义，却会让提醒线 / 冷却事实上永不结束
 * （`notifyTokens: 2**53` 等于把功能关掉）。schema（lib/index.js）必须用同一个上界，
 * 否则会重现「schema 接受、装载抛错」。
 */
export const MAX_CONFIG_INTEGER = 1_000_000_000

/**
 * 接受正整数，或 `"300k"` / `"1m"` 这样的人类单位（1024 进制）。
 * @param value - 未受信任的配置值。
 * @param fallback - 缺省值。
 * @param label - 报错时点名的配置键。
 * @returns 解析后的正整数。
 */
export function parseTokenCount(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CONFIG_INTEGER) {
      throw new Error(
        `dsh-stage-handoff: ${label} 必须是 1..${MAX_CONFIG_INTEGER} 的安全整数，收到 ${String(value)}`,
      )
    }
    return value
  }
  if (typeof value === 'string') {
    const match = HUMAN_TOKEN_PATTERN.exec(value)
    if (match !== null) {
      // 第一分支给整数（单位可选），第二分支给「必须带单位」的小数。
      const amount = Number(match[1] ?? match[3])
      const unit = (/** @type {string} */ (match[2] ?? match[4])).toLowerCase()
      const multiplier = unit === 'k' ? 1024 : unit === 'm' ? 1048576 : 1
      // 带单位的小数不一定是整数倍（"1.3k" = 1331.2）。这里四舍五入而不是抛错：
      // schema 已经接受这种写法，parser 再拒绝就会让「schema 通、装载失败」重现。
      const resolved = Math.round(amount * multiplier)
      if (Number.isSafeInteger(resolved) && resolved > 0 && resolved <= MAX_CONFIG_INTEGER) {
        return resolved
      }
    }
    throw new Error(
      `dsh-stage-handoff: ${label} 必须是 1..${MAX_CONFIG_INTEGER} 的正整数，或 "300k" / "1m" 这类写法，收到 ${JSON.stringify(value)}`,
    )
  }
  throw new Error(
    `dsh-stage-handoff: ${label} 必须是 1..${MAX_CONFIG_INTEGER} 的正整数或人类单位字符串，收到 ${String(value)}`,
  )
}

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_CONFIG_INTEGER) {
    throw new Error(
      `dsh-stage-handoff: ${label} 必须是 1..${MAX_CONFIG_INTEGER} 的安全整数，收到 ${String(value)}`,
    )
  }
  return value
}

function parseBoolean(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new Error(`dsh-stage-handoff: ${label} 必须是布尔值，收到 ${String(value)}`)
  }
  return value
}

function parseNonNegativeInteger(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_CONFIG_INTEGER) {
    throw new Error(
      `dsh-stage-handoff: ${label} 必须是 0..${MAX_CONFIG_INTEGER} 的安全整数，收到 ${String(value)}`,
    )
  }
  return value
}

/**
 * 带上下界的整数解析。上下界必须与 `Config` schema 完全一致：schema 用
 * 64 KiB..16 MiB 之类的区间，解析器若只查 1..MAX_CONFIG_INTEGER，就会出现
 * 「schema 接受、装载抛错」的反向版本——YAML 里写 1024 时设置页拒绝、
 * 直接 apply 却能跑，而所有依赖该值的写入都会被一个不可能的上限拒掉。
 * 同一个集合，两处都写。
 */
function parseBoundedInteger(value, fallback, label, min, max) {
  if (value === undefined || value === null) return fallback
  // 先判整数类型再报区间：交给 parsePositiveInteger 的话，1.5 会得到
  // 「必须是 1..1000000000 的安全整数」—— 而这两个键的合法区间根本不是那个，
  // 用户照提示改成 1 仍然会被拒。
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(
      `dsh-stage-handoff: ${label} 必须是 ${min}..${max} 的整数，收到 ${String(value)}`,
    )
  }
  return value
}

/**
 * Normalize an untrusted time-zone value without applying a default.
 * @param value - Untrusted value.
 * @returns `'local'`, a UTC-offset minute count, or `undefined`.
 */
export function normalizeTimeZone(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < -720 || value > 840) return undefined
    return value
  }
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (text === 'local') return 'local'
  if (text === 'utc' || text === 'z') return 0
  // 带冒号的 `+05:30` 与四位数字的 `+0530` 表示「时:分」。
  const clock =
    /^([+-])(\d{1,2}):(\d{2})$/.exec(text) ?? /^([+-])(\d{2})(\d{2})$/.exec(text)
  if (clock !== null) {
    const minutes = Number(clock[3])
    if (minutes >= 60) return undefined
    const total = (clock[1] === '-' ? -1 : 1) * (Number(clock[2]) * 60 + minutes)
    return total >= -720 && total <= 840 ? total : undefined
  }
  // 三位纯数字只可能是分钟数：`-300` 是 UTC−5:00，不是 `-3:00`。
  // 少了这一条，`-300` 会被当成 `-3:00` 静默落盘，面板与 YAML 的实际时区
  // 都偏离用户输入一个量级。
  const threeDigitMinutes = /^([+-])(\d{3})$/.exec(text)
  if (threeDigitMinutes !== null) {
    const total = (threeDigitMinutes[1] === '-' ? -1 : 1) * Number(threeDigitMinutes[2])
    return total >= -720 && total <= 840 ? total : undefined
  }
  // 一到两位的 `+8` / `-5` 是**小时**偏移 —— 与上一分支合起来，正好对应
  // 文档同时承诺的「`-5` 小时」与「`-300` 分钟」两种写法。
  const hourOffset = /^([+-])(\d{1,2})$/.exec(text)
  if (hourOffset !== null) {
    const total = (hourOffset[1] === '-' ? -1 : 1) * Number(hourOffset[2]) * 60
    return total >= -720 && total <= 840 ? total : undefined
  }
  return undefined
}

/**
 * 解析阶段目录命名使用的时区。
 *
 * 接受 `local`、`utc`、以及 `+8` / `-5` / `+05:30` 这类 UTC 偏移。
 * 返回值只有两种形态：字符串 `'local'`，或**UTC 偏移分钟数**（UTC 本身是 0）。
 * 注意 0 是 falsy —— 调用方必须用 `typeof zone === 'number'` 判断，不能靠真值。
 *
 * @param value - 未受信任的配置值。
 * @param fallback - 缺省值。
 * @param label - 报错时点名的配置键。
 * @returns `'local'` 或 -720..840 之间的偏移分钟数。
 */
function parseTimeZone(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  const normalized = normalizeTimeZone(value)
  if (normalized !== undefined) return normalized
  throw new Error(
    `dsh-stage-handoff: ${label} 无法解析（收到 ${safeFormat(value)}）。` +
      "可用：'local' / 'utc' / '+8' / '-5' / '+05:30' / '-300'（整数分钟），偏移范围 UTC-12..UTC+14。",
  )
}

/**
 * Normalize `anchorRoot` exactly once, for both the schema and the resolver.
 *
 * The schema and `resolveConfig` used to disagree in **both** directions, because
 * the schema checked the raw string with one regex while the resolver trimmed
 * first and then checked the trimmed value:
 *
 * - `"docs/.. "` (a `..` segment followed by whitespace) passed the schema, then
 *   the resolver rejected it — `resolveConfigLenient` dropped the field and
 *   anchors were written to the default directory while the panel had said
 *   "saved".
 * - `"docs/anchors\t"` was refused by the schema (control-character check ran
 *   before the trim) yet the resolver accepted it.
 *
 * An exploratory 400-sample sweep found 44 schema-wider and 88 schema-stricter
 * cases. Sharing one function is the only wording that cannot drift again: the
 * schema transform and the resolver both call this. The regression test pins a
 * smaller 300-sample matrix (5 lengths x 15 shapes x 4 hostile suffixes) that
 * covers the same disagreement classes; the two numbers are not interchangeable.
 *
 * @param value - Untrusted `anchorRoot`.
 * @returns The trimmed, validated root.
 */
export function normalizeAnchorRoot(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('dsh-stage-handoff: anchorRoot 必须是非空字符串')
  }
  const trimmed = value.trim()
  // 拒绝路径穿越。anchorRoot 会被写进提醒文案，模型照着它落盘 —— 所以它本质上
  // 是一条给 agent 的写入指令。允许绝对路径（用户可能想把锚点放在项目外），
  // 但不允许 `..` 段，避免配置值把写入引到预期之外的目录。
  if (trimmed.split(/[\\/]+/).includes('..')) {
    throw new Error(`dsh-stage-handoff: anchorRoot 不能包含 ".." 段（收到 ${trimmed}）`)
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error('dsh-stage-handoff: anchorRoot 不能包含控制字符或换行')
  }
  return trimmed
}

/**
 * 校验并冻结一行组合配置。
 * @param raw - Loader 归一化后的未受信任配置。
 * @returns 冻结后的配置快照。
 */
export function resolveConfig(raw) {
  // 形状闸必须在 `plainConfig` **之前**：`plainConfig` 用 `Object.entries` 把任意
  // 对象摊成普通对象，而 `Date` / `Map` / `Set` / `RegExp` 的可枚举自有属性是空的
  // —— 它们会变成 `{}`，一路走成「全部默认值」，一个字的提示都没有。
  if (raw !== undefined && raw !== null && !isConfigMapping(raw)) {
    throw new Error(`dsh-stage-handoff: config 必须是一个映射，收到 ${describeShape(raw)}`)
  }
  raw = plainConfig(raw)
  if (raw === undefined || raw === null) raw = {}
  if (!isPlainObject(raw)) throw new Error('dsh-stage-handoff: config 必须是一个映射')
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `dsh-stage-handoff: 未知配置键 "${key}"（可用：${[...CONFIG_KEYS].join(' / ')}）`,
      )
    }
  }
  const enabled = raw.enabled ?? true
  if (typeof enabled !== 'boolean') {
    throw new Error(`dsh-stage-handoff: enabled 必须是布尔值，收到 ${String(enabled)}`)
  }
  const trimmedAnchorRoot = normalizeAnchorRoot(raw.anchorRoot ?? DEFAULT_ANCHOR_ROOT)
  return Object.freeze({
    notifyTokens: parseTokenCount(raw.notifyTokens, DEFAULT_NOTIFY_TOKENS, 'notifyTokens'),
    notifyRepeatDelta: parseTokenCount(
      raw.notifyRepeatDelta,
      DEFAULT_NOTIFY_REPEAT_DELTA,
      'notifyRepeatDelta',
    ),
    notifyCooldownMs: parseNonNegativeInteger(
      raw.notifyCooldownMs,
      DEFAULT_NOTIFY_COOLDOWN_MS,
      'notifyCooldownMs',
    ),
    notifyOnTurnStartOnly: parseBoolean(
      raw.notifyOnTurnStartOnly,
      DEFAULT_NOTIFY_ON_TURN_START_ONLY,
      'notifyOnTurnStartOnly',
    ),
    anchorRoot: trimmedAnchorRoot,
    anchorLimitChars: parsePositiveInteger(
      raw.anchorLimitChars,
      DEFAULT_ANCHOR_LIMIT_CHARS,
      'anchorLimitChars',
    ),
    anchorTimeZone: parseTimeZone(
      raw.anchorTimeZone,
      DEFAULT_ANCHOR_TIME_ZONE,
      'anchorTimeZone',
    ),
    compactRetainTokens: parseTokenCount(
      raw.compactRetainTokens,
      DEFAULT_COMPACT_RETAIN_TOKENS,
      'compactRetainTokens',
    ),
    compactCooldownMs: parseNonNegativeInteger(
      raw.compactCooldownMs,
      DEFAULT_COMPACT_COOLDOWN_MS,
      'compactCooldownMs',
    ),
    hostMaxTokens: (() => {
      const configured = raw.hostMaxTokens
      // `'auto'` 要在 `parseTokenCount` 之前拦下：后者只认数字与人类单位，
      // `"auto"` 会被当成坏值抛错。
      if (typeof configured === 'string' && configured.trim().toLowerCase() === AUTO_HOST_MAX_TOKENS) {
        return AUTO_HOST_MAX_TOKENS
      }
      return parseTokenCount(configured, DEFAULT_HOST_MAX_TOKENS, 'hostMaxTokens')
    })(),
    agentDecidesCompaction: parseBoolean(
      raw.agentDecidesCompaction,
      DEFAULT_AGENT_DECIDES_COMPACTION,
      'agentDecidesCompaction',
    ),
    streamGuard: parseBoolean(raw.streamGuard, DEFAULT_STREAM_GUARD, 'streamGuard'),
    rejectOnRepeat: parseBoolean(raw.rejectOnRepeat, DEFAULT_REJECT_ON_REPEAT, 'rejectOnRepeat'),
    keepAnchorBackups: parseNonNegativeInteger(
      raw.keepAnchorBackups,
      DEFAULT_KEEP_ANCHOR_BACKUPS,
      'keepAnchorBackups',
    ),
    guardMaxBytes: parseBoundedInteger(
      raw.guardMaxBytes,
      DEFAULT_GUARD_MAX_BYTES,
      'guardMaxBytes',
      MIN_GUARD_MAX_BYTES,
      MAX_GUARD_BYTES,
    ),
    staleReservationTtlMs: parseBoundedInteger(
      raw.staleReservationTtlMs,
      DEFAULT_STALE_RESERVATION_TTL_MS,
      'staleReservationTtlMs',
      MIN_STALE_RESERVATION_TTL_MS,
      MAX_STALE_RESERVATION_TTL_MS,
    ),
    dshHome: (() => {
      const value = raw.dshHome ?? DEFAULT_DSH_HOME
      if (typeof value !== 'string') {
        throw new Error(`dsh-stage-handoff: dshHome 必须是字符串，收到 ${String(value)}`)
      }
      const trimmed = value.trim()
      // 相对路径会被 `join(dshHome, 'sessions')` 按 process.cwd() 解析 —— 而 cwd
      // 属于「当前打开的项目」，不是 DSH 的数据根。命不中时面板只会说「目录还不
      // 存在」，用户会去查一个以自己项目为基准的路径。`~` 同理会变成一个
      // 名为 `~` 的目录。
      if (trimmed !== '' && !isAbsolutePathInput(trimmed)) {
        throw new Error(
          `dsh-stage-handoff: dshHome 必须是绝对路径（或留空读 DSH_HOME），收到 ${JSON.stringify(trimmed)}`,
        )
      }
      // 控制字符必须在这里也拒一次。schema（`lib/index.js` 的 `DSH_HOME_PATTERN`）与
      // 面板都拒了，只有解析器收 —— 而 `resolveConfig` 是 schema 缺失时唯一的防线
      // （`Config === undefined` 的部署）。最现实的触发是 YAML 双引号里的
      // `dshHome: "C:\temp\dsh"`：`\t` 是 TAB 转义，路径里于是夹了一个制表符，
      // 之后所有会话体积查询都指向一个不存在的路径，而报错只说「目录还不存在」。
      if (trimmed !== '' && /[\u0000-\u001f\u007f]/.test(trimmed)) {
        throw new Error(
          `dsh-stage-handoff: dshHome 不能包含控制字符（制表符/换行等），收到 ${JSON.stringify(trimmed)}`,
        )
      }
      return trimmed
    })(),
    reportToolFacts: parseBoolean(
      raw.reportToolFacts,
      DEFAULT_REPORT_TOOL_FACTS,
      'reportToolFacts',
    ),
    notifySkipWhenToolPending: parseBoolean(
      raw.notifySkipWhenToolPending,
      DEFAULT_NOTIFY_SKIP_WHEN_TOOL_PENDING,
      'notifySkipWhenToolPending',
    ),
    notifyAfterCompaction: parseBoolean(
      raw.notifyAfterCompaction,
      DEFAULT_NOTIFY_AFTER_COMPACTION,
      'notifyAfterCompaction',
    ),
    enabled,
  })
}

/**
 * Resolve one config, degrading bad fields individually instead of discarding them all.
 *
 * `resolveConfig` is all-or-nothing: one bad value throws, and the caller used to
 * fall back to `resolveConfig({})` — which silently restored *every* field to its
 * default. That made a single typo far more destructive than it looks. The worst
 * case was `{ enabled: false, dshHome: "data" }`: the user explicitly turned the
 * plugin off, the relative path made the resolver throw, and the plugin mounted
 * anyway with reminders, tools and listeners all registered. An absolute
 * `anchorRoot` was thrown away in the same move.
 *
 * @param raw - raw config from the loader or a YAML patch.
 * @returns The resolved config plus the keys that could not be resolved.
 */
export function resolveConfigLenient(raw) {
  try {
    return { config: resolveConfig(raw), dropped: [], dropReasons: {}, shapeError: undefined }
  } catch {
    // Fall through: re-test each key on its own.
  }
  // 形状闸同样放在 `plainConfig` 之前，理由见 `isConfigMapping`。
  if (raw !== undefined && raw !== null && !isConfigMapping(raw)) {
    return {
      config: resolveConfig({}),
      dropped: [],
      dropReasons: {},
      shapeError: `配置必须是一个映射，收到 ${describeShape(raw)}`,
    }
  }
  let source
  try {
    source = plainConfig(raw)
  } catch (error) {
    // 循环引用：`resolveConfigLenient` 的职责是**不抛**，所以这里也必须降级。
    return {
      config: resolveConfig({}),
      dropped: [],
      dropReasons: {},
      shapeError: `配置无法展开（${error instanceof Error ? error.message : String(error)}）`,
    }
  }
  const kept = {}
  const dropped = []
  /**
   * `dropped` 的补充：键 → 被丢的原因。
   *
   * 只有键名时，「`hostMaxTokens` 已退回默认值」和「`hostMaxTokens` 因为算出
   * 1,073,741,824 超过上限被退回默认值」在用户眼里是同一条消息 —— 而前者可能
   * 只是拼错，后者要改数值。schema 与解析器的接受集不完全重合（例如
   * `"953.9m"` 格式合法、换算后越界），差异会落到这里，所以原因必须带出来。
   * @type {Record<string, string>}
   */
  const dropReasons = {}
  /** @type {string | undefined} */
  let shapeError
  if (isPlainObject(source)) {
    for (const key of Object.keys(source)) {
      if (!CONFIG_KEYS.has(key)) {
        dropped.push(key)
        dropReasons[key] = '未知配置键'
        continue
      }
      try {
        // Every other key falls back to its default, so this isolates one field.
        resolveConfig({ [key]: source[key] })
        kept[key] = source[key]
      } catch (error) {
        dropped.push(key)
        // 截断：schema 的拒绝理由可能带整段 schema 描述，而这条消息要进
        // status 与挂载警告，太长会被后面的内容挤掉。
        const reason = error instanceof Error ? error.message : String(error)
        // 拒绝理由里常带被拒的**值本身**（`anchorRoot 不能包含 ".." 段（收到
        // D:\Users\me\proj\docs\..\anchors）`），而这条消息要进 status 与挂载警告。
        // 配置原文里的绝对路径同样是「哪个工作区」——走同一道缩略。
        dropReasons[key] = elidePathsIn(String(reason)).replace(/\s+/g, ' ').slice(0, 120)
      }
    }
  } else {
    // 整份配置形状错误（数组 / 字符串 / 数字）时没有「哪个字段」可点名。旧实现
    // 让 dropped 停在空数组，而调用方正是用 `dropped.length > 0` 决定要不要报告
    // —— 于是「配置根本不是映射」被静默换成了全部默认值，连 `enabled: false`
    // 都一起丢了。这与逐字段降级要消灭的是同一类无声降级，只是粒度更粗。
    shapeError = `配置必须是一个映射，收到 ${describeShape(source)}`
  }
  return { config: resolveConfig(kept), dropped, dropReasons, shapeError }
}
