# Feedback：插件无法注销自己注入的消息，提醒会永久进摘要

## 现象

插件通过 `agent/pre-step` 返回 `decision.messages` 注入提醒（`source.kind` 是插件自定义值）。
这些消息一旦落盘就永久留在 surface 上，压缩时按 `SummarizationInput.messages` 原样进入摘要输入。

提醒属于元信息（"你在原地打转"），说一次就够。进了摘要就是永久污染：它占用摘要预算，
而且下一阶段毫无用处。实测一个 turn 内连续注入 3 条，全部进摘要。

## 根因（两处，各断一半）

**1. 引擎固定写死 append** — `dsh-agent-loop/src/agent.ts:477`

```ts
this.session.append('user/message', message, { surfaceOp: 'append' })
```

插件无法为 `decision.messages` 指定 `{ op: 'replace', startSeq, endSeq }`。

**2. 插件自己 append 的消息进不了当前请求** — 同一文件 `agent.ts:448-452`

`assembly` 在 `agent/pre-step` 之前就已经构建完成。插件在 pre-step 里直接
`session.append(...)` 虽然能带 replace，但那条消息不会被放进本次请求，模型看不到。

结果：**插件既不能"让消息进请求且可替换"，也不能"自己 append 且被模型看到"**。

## 影响面（不只是本插件）

`dsh-compaction-basic` 的 `SummarizationInput.messages` 定义是
"the derived system head, followed by **the shadowed region in surface order**"，
**没有任何按 `source.kind` 的过滤**。

所以**任何**通过 `decision.messages` 注入提醒的插件，其注入内容都会进摘要并占用保留预算。
`dsh-output-loop-guard` 这类插件都落在同一模式上。

## 建议（最小改动，任选其一）

1. 处理 `decision.messages` 时尊重消息自带的 surface 意图，例如允许
   `decision.surfaceOps` 或 `UserMessage.surface` 覆盖默认的 `'append'`；
2. 或给消息增加一个"一次性/不参与摘要"标记，由 `buildSummarizationInput` 过滤掉。

只要满足其中一条，插件就能让提醒"被模型看到一次，然后从 surface 上消失"。

## 当前只能做到的缓解

- 限流：同一 turn 最多一条提醒（原来是每个 step 一条）；
- 文案去数字：注入文本不含次数，避免被模型抄进自己的交接文档；
- 文案不复述被重复的原文。

这些都只是把污染压小，无法避免注入内容进入摘要。
