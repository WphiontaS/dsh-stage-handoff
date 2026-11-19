# dsh-stage-handoff

> 在上下文被压缩**之前**收好这一阶段，然后交给下一阶段一个**文件**，而不是一份摘要。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，补上 DSH 自己压缩时留下的两个空档：**压缩之前**发生什么，**下一阶段从什么开始**。

[English](README.en.md) · [导航](README.md)

## 问题

DSH 在上下文窗口填满时压缩历史。默认做法是摘要：旧消息被替换成模型写的摘要。这一步会丢两样东西。

1. **没人要求 agent 收尾。** 压缩由 token 数触发，不在自然的边界上。进行中的工作会在中途被摘要掉，agent 从来没机会把学到的东西记成下一阶段能用的形式。
2. **没有任何东西留下来当参照。** 压缩后，agent 依据「自己过去的摘要」继续工作。它没有一个文件可以回头核对当初到底决定了什么，人也没法审阅或纠正这份记录。

## 这个插件做什么

```text
        提醒线（默认 360,000）
                 │
                 ▼
   ┌──────────────────────────────────┐
   │ 1. 提醒 agent 收尾               │  在下一步模型请求前注入
   │    · 自检，排掉臆测              │
   │    · 写详细文档                  │
   │    · 重建一份精简锚点            │
   └──────────────────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────┐
   │ 2. 压缩，但把尾巴逐字留着        │  尾部有上限地逐字保留
   │                                  │  （默认 32,000 tokens）
   └──────────────────────────────────┘
                 │
                 ▼
   下一阶段从 docs/anchors/<阶段>/anchor.md 开工
```

有两点必须说准：

- **保留预算是有意设上限的，而且比后端更小。** DSH 的自动压缩保留 `retainTokens` = 消息预算的 16%；手动 `/compact` 内部传的是 **0**，一直压到只剩最后一个节点。本插件用第三个值调同一个引擎：有限的逐字尾部，默认 32,000 tokens。这不是随便定的——它一开始是 97,085（想对齐自动路径），但自动路径按「4 字符 = 1 token」计价，而中文实际是 1.5–1.8 字符/token，所以 97,085 实际保留了约 160,000 个真实 token。大尾巴是有害的：摘要看不到它，于是摘要里的 `Next Step` 会和尾部原文里「已经做完」的事实相矛盾。详见 `research/261119-compaction-degradation.md`。
- **它不替换压缩后端。** 它在当前轮内调用已有引擎的 `compactRegion(start, end, agent, signal)`。`compaction-basic` 保持启用，`tool-result-pruner` 也保持启用。那些"替换后端"的插件每跟一次 DSH 升级都要重新验证，这个插件不用。

## 和其他 DSH 压缩插件的区别

已经有好几个插件在改善**一次压缩怎么发生**——保留策略、摘要格式、可搜索的历史。这个插件管的是压缩**周围**的空间。

| | 其他压缩插件 | dsh-stage-handoff |
| --- | --- | --- |
| 交接物在哪 | checkpoint 里（会话日志） | `docs/anchors/` 下的 markdown 文件 |
| 什么时候产生 | 压缩那一刻，由做摘要的模型顺手产出 | **压缩之前**，独立的一步 |
| 生命周期 | 被下一次压缩覆盖 | detail → anchor → parent-backup，会简化、会归档 |
| 人能不能改 | 不能 | 能——改了文件，下一阶段读到的就是你的改动 |
| 压缩后端 | 常常被替换 | **完全不动** |

两种做法都合理，解决的是同一个问题的两半。这个插件设计成能和它们并存。

## 安装

```sh
dsh plugin --profile web add https://github.com/WphiontaS/dsh-stage-handoff/releases/download/v1.0.0-beta.1/dsh-stage-handoff-1.0.0-beta.1.tgz
```

保留文件名里的版本号 —— release 资产叫 `dsh-stage-handoff-<version>.tgz`，不是
`dsh-stage-handoff.tgz`。如果你 fork 或自建，把 URL 里的账号换掉。装完重启 profile。

包是纯 ESM：无构建步骤、无运行时依赖、无 `prepare` 脚本。需要 Node.js 20 以上。

## 配置

所有键都是可选的。默认值：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 初始是否挂载；volatile 热更新为 false 时所有公开入口与 `session/event` 观察缓存立即停用，彻底卸载仍需重挂 profile |
| `notifyTokens` | `360000` | 触发收尾提醒的上下文大小（1M 窗口的 36%） |
| `notifyRepeatDelta` | `25000` | 再次提醒所需的最小增长量 |
| `notifyCooldownMs` | `300000` | 两次提醒之间的最小实际时长（5 分钟）；与增长量闸是「与」关系。`0` 关闭 |
| `notifyAfterCompaction` | `true` | 压缩成功后第一次进入注入一条「先读锚点」提醒；与提醒线无关，每次压缩最多一次，不消耗配额 |
| `anchorRoot` | `docs/anchors` | 锚点目录的根 |
| `anchorLimitChars` | `8000` | `anchor.md` 的软上限，超过就应该归档重写 |
| `anchorTimeZone` | `local` | 阶段目录名的时间标准：`local` / `utc` / `z` / `+8` / `-5` / `+05:30`，或 `-720..840` 的整数分钟 |
| `compactRetainTokens` | `32000` | 压缩时逐字保留的尾部预算；支持 `100k` / `1m` 写法 |
| `compactCooldownMs` | `60000` | 同一会话内两次压缩的最小间隔；`0` 关闭冷却 |
| `agentDecidesCompaction` | `true` | `true`：由 agent 决定何时压缩；`false`：到线时插件自己压 |
| `keepAnchorBackups` | `3` | `cleanup` 的候选清单里保留几个最新备份；`0` 表示全部列为候选 —— 两种情况都不会删文件 |
| `guardMaxBytes` | `1048576` | `.anchor-guard.json` 的大小上限（写入与读取用同一个值）；默认 1 MiB，可调到 16 MiB，调大会放宽有界读取的保证 |
| `staleReservationTtlMs` | `86400000` | 阶段目录预留 sidecar 的有效期（默认 1 天）；超过就按过期回收，避免 pid 复用后同名阶段永远建不出来 |
| `dshHome` | `''` | `usage` 统计会话体积用的 DSH 数据根目录；留空表示读 `DSH_HOME` |

DSH Web 的设置页里有一个 **Stage Handoff** 分栏。面板跟随 DSH 明暗主题，顶部给出提醒线/保留量/锚点目录摘要，并用“提醒 / 压缩 / 锚点与存储”三个页签组织字段。除 `enabled` 外，字段都可直接编辑；失焦或按 Enter 后由 Host 写入 profile 的 `cordis.patch.yml`，粘性状态栏会持续显示保存结果。支持字段级“恢复默认”、256k/512k/1M 快捷方案，以及复制当前配置 YAML。`enabled` 控制 Host 是否挂载及入口是否启用；面板不能在运行中安全卸载自己，因此仍显示为不可编辑状态。profile 热更新为 false 会立即停用 listener、工具、命令、体积路由和事件环更新，但移除注册本身仍需重挂 profile。

在 profile 自己的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: stage-handoff
  config:
    notifyTokens: 250000
    compactRetainTokens: 60000
```

## 它提供什么

**一条提醒**，越过阈值后注入到下一步模型请求里。它要求 agent 自检、写详细文档、重建精简锚点，然后压缩。删除、提权、部署、网络暴露和系统修改仍须遵守原有授权边界。

**一个工具**，`stage_handoff(action)`：

- `status` —— 上下文占用、本会话已压缩几次（第二次起警告摘要已在上一次摘要上重写）、能否触达压缩引擎、将要被压缩区间的预演，以及一行 `思考复读:` 报告本会话的思考是否已经开始打转
- `summary` —— 从 log-only 的 `compaction/summary` 事件读取最近一次摘要**正文**，让模型拿自己的锚点和摘要真正记住的东西对一遍。输出明确区分 `complete` / `partial-since-mount` / `partial-truncated` / `partial-gap` / `empty` / `unavailable`；`partial-gap` 指事件环**中间漏过**事件（停用期、listener 抛错、seq 跳号），端点条件再漂亮也不会冒充完整日志，晚挂载或事件环裁剪后同样不会
- `usage` —— 报告体积与文件数。`scope: "anchors"`（默认）扫锚点目录；`"sessions"` 统计各会话的落盘文件；`"all"` 两者都报。两条路径都有界（锚点限深 4 / 2000 条目 / 3 秒，会话最多 200 个），被截断时**明说是下限**
- `cleanup` —— 逐个阶段目录列出 `parent-backup/` 里可以清掉的旧锚点，保留最新几个；无法解析时间戳的名字只列“未知命名”，另报告疑似缺 `anchor.md`/`detail/` 的阶段。**只列清单**：删除不可逆，本插件不做这件事
- `defer` —— 由 agent 自己临时抬高本会话的提醒线，争取收尾时间。窗口已知时钳到 90%，窗口未知时回执明确标 `bounded=false`，不假装有上限
- `reset` —— 让 agent 撤销自己设过的 `defer`（`off` 和抬高过的阈值都解除），并清空提醒节流记录

**压缩之后回来时，先读锚点。** 写下 `docs/anchors/<阶段>/anchor.md` 的意义就在于它**就是**交接物 —— 从摘要里去重建上下文，正是这个插件想替你省掉的事。`action="summary"` 仍然能读出最近一次摘要的正文，当你怀疑锚点漏了什么时，拿它做个交叉核对是值得的；但它是辅助，不是事实来源：摘要天生有损，而且它不知道你判断过什么重要。
- `compact` —— 立刻压缩，按配置逐字保留尾部；`success` / `no-op` / `skipped` / `cancelled` / `failed` 分开处理，只有 `failed` 进入退避。压缩**之前**它会给本会话的思考形状拍一张快照并报告模型是否已经在复读——压缩会用摘要替换掉这段证据，所以这是唯一可观察的时刻。事件环只存形状（行数、语气短行数、最高重复行），不存思考原文
- `scaffold` —— 按 `anchorTimeZone` 和调用当时的时间原子创建 `<YYMMDD-HHMM>-<topic>/` 与 `anchor.md`（预填当前会话 ID）。失败不会留下半成品，同名目录已存在时拒绝覆盖
- `find-session` —— 任意 SessionId 按 DSH JSONL 的 `~XXXX` 规则编码后反查日志目录、文件清单与体积。只有 `ENOENT` 算未命中；权限/路径读取失败会标成“扫描不完整”，不伪装成“没找到”
- `recall` —— 在当前阶段锚点里按关键词检索，返回**命中原文 + 所在章节 + 行号**。报章节是有意为之：同一条事实在「硬约束」和「决策与否决」里分量完全不同。精确子串匹配，不做别名展开
- `validate` / `guard` —— 先把 Markdown 围栏内容排除，再做所有结构检查与正则检查。`guard` 保存版本 3 基线：正文、来源标签、状态标签分开，按多重集计数；重复项少一次或标签变化都会报。所有锚点内容读取统一拒绝链接/硬链接、非普通文件与超过 1 MiB 的文件
- `reconcile` —— 把最近一次压缩摘要与当前锚点并排对账，并明确标出 `matchKind=exact | prefix16 | none`：只有整条规范化文本出现才算 exact；16 字前缀命中只说明前缀出现，不叫“逐字可查”。未命中仍收敛成统计。**只列事实，不判对错**。**只能对当前会话运行**（读 `agent.session`）

**一个命令**，`/anchor`：

- `/anchor status` —— 提醒线、当前占用、锚点设置
- `/anchor threshold 250k` —— 本进程内修改提醒线
- `/anchor reset` —— 清空本会话的提醒节流记录**与临时阈值**（`defer` 抬高的和 `off` 都一并解除）

## 锚点格式

完整规程见 [docs/ANCHOR-POLICY.md](docs/ANCHOR-POLICY.md)。简版：

```text
docs/anchors/<阶段>/
├── anchor.md            # 开工先读：目标、约束、决策、下一步
├── detail/
│   └── <主题>.md        # 证据、绝对路径、走过的死路、未决问题
└── parent-backup/
    └── anchor-<时间戳>.md   # 历史锚点，anchor.md 长得太大时归档到这里
```

`anchor.md` 是写给下一阶段**第一次读**的，不是写给完整性的。超过 `anchorLimitChars` 就归档、重写一份更短的，并指向备份。

## 已验证行为

- 引擎挖取路径和压缩调用在真实会话上量过：**一次压缩从 637,733 降到 149,146 tokens**。`compaction/start` 事件带着 turn id、没有 source-command id——这是 `compactRegion` 调用的特征，而不是 `/compact`。
- 365 个离线单元测试覆盖：schema/解析器同源（含 `anchorRoot` 写法的双向穷举）、fail-closed surface projection、事件环覆盖/裁剪元数据与 `hasGap` 缺口检测及 seq 连续性推导、2 MiB 会话预算、enabled 热停用、工作区体积路由、turn-stopping 自动压缩与统一 outcome、成功先于 abort 落账、失败退避、兜底压缩的配额记账与 `defer` 优先于兜底线、排队 `/compact` 的 no-op 不记成成功、`partial-window` 工具轨迹覆盖、跨平台原子 scaffold、POSIX reservation sidecar 恢复、特殊 SessionId 端到端回环、主题与面板并发写入、安全锚点读取（含 bigint inode 同一性静态契约）、guard 多重集与严格 v3 标签、有序列表约束、围栏排除、`defer` 窗口未知时拒绝、每轮首个 pre-step 的锚点漂移自动比对、诊断文件并发/轮转/脱敏、`[approval: …]` 生效状态校验、限界扫描、只读 cleanup（断言不删任何文件）、文档链接、面板双语渲染（英文界面不得出现中文，靠真渲染收集文本节点断言），以及引擎缺席时的兜底路径。真实 `compact` 于 2026-11-20 做过一次破坏性实压（详见 `docs/VALIDATION.md`）。

**不作声称的部分**：没有第三方基准，没有多版本兼容矩阵，也不声称这个方案在任务质量上胜过普通摘要。唯一有测量支撑的结论是保留量。

## 开发

```sh
npm install     # 只装 devDependencies（TypeScript，用于类型检查）
npm run check   # tsc --noEmit + node --test
```

纯 ESM JavaScript，加 `// @ts-check`，无构建步骤。引擎为什么能被调用、cordis 的隔离到底拦住了什么，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

动手改之前先读 [CONTRIBUTING.md](CONTRIBUTING.md) —— 里面列了三条硬约束（无构建、零运行时依赖、测试离线跑）以及这个插件刻意不做的事。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
