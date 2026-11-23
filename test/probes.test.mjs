// 探针判据的离线测试。
//
// 这些判据用来抓「思维链退化成 好。做。好。做。」，判错的代价是双向的：
// 漏报会让退化混过去，误报会把正常思考判成复读（本项目第一版判据就把
// 一次正常 refactor 判成复读，因为 ``` 在写代码的思考里天然高频）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BLOCK_REPEAT_RATIO,
  CJK_MIN_SHARE,
  COMPRESS_SIGNAL,
  FRAGMENT_RUN,
  NORM_SIGNAL,
  PLACEHOLDER_REPEAT,
  PLACEHOLDER_SHORT_RATIO,
  assessShapes,
  assessTurn,
  blockRepeat,
  cjkShare,
  compressionRatio,
  fragmentation,
  isCodeish,
  isFiller,
  isLoopBlock,
  isRetentionHazard,
  normalizedCompress,
  placeholderShape,
  proseRows,
  blockPairCompress,
  referenceCompress,
  repeatSeverity,
  scanEventRing,
  severityTier,
  shapeReasoning,
  trailingRepeat,
} from '../tools/probes/lib/repeat-analysis.mjs'

test('语气短行判据：中文语气词算，代码符号不算', () => {
  assert.equal(isFiller('好。'), true)
  assert.equal(isFiller('执行。'), true)
  assert.equal(isFiller('做。'), true)
  assert.equal(isFiller('OK.'), true, '英文语气词同样要抓')
  // 代码/结构行天然高频，必须排除
  assert.equal(isFiller('```'), false)
  assert.equal(isFiller('```js'), false)
  assert.equal(isFiller('}'), false)
  assert.equal(isFiller('})'), false)
  assert.equal(isFiller(');'), false)
  // 纯标点没有实词，不是语气词（真实误报：`...` 曾被算成重复碎片）
  assert.equal(isFiller('...'), false)
  assert.equal(isFiller('——'), false)
  // 太长的不算语气词
  assert.equal(isFiller('这是一句正常的说明文字。'), false)
  assert.equal(isCodeish('```'), true)
  assert.equal(isCodeish('好。'), false)
})

test('跨块复读：相邻两块是同一段话要判出来（单块判据看不见）', () => {
  // 形态：模型把同一段内容再走一遍。两块**各自都不重复**（每句都不同），所以单块
  // 压缩率判据一条都不会响；但第二块几乎是第一块的重述，拼起来压缩率就掉下去了。
  // 实测（239 会话 / 3,971 turn）这种拼接压缩率 < 0.35 出现 512 次，样本块长
  // 1,820–6,237 字符 —— 所以这里也必须用足够长的块，600 字符以下不参与判定。
  const sentences = [
    '超时时间从十秒放宽到三十秒，长任务就不会被误判成卡死。',
    '日志按日期切分，每天一个子目录，单个文件超过二十兆再压缩归档。',
    '重试次数上限设为三次，每次间隔指数退避，避免打爆上游服务。',
    '缓存键里带上构建版本号，升级时旧键自然失效，不用手工清理。',
    '连接池大小跟 CPU 核数挂钩，四核给八个连接，八核给十六个。',
    '健康检查放到独立端口上，主端口只处理正常的业务请求。',
    '配置文件支持环境变量覆盖，容器里不必重新构建镜像。',
    '指标先写进本地环形缓冲，再由后台线程批量上报到服务端。',
    '静态资源加上内容哈希，命中强缓存时可以把过期设成一年。',
    '数据库迁移写成幂等脚本，重复执行不会报错也不会重复插入。',
    '错误信息里带上请求 id，排查问题的时候能直接串起整条链路。',
    '优雅退出给十秒排空期，正在处理的请求先跑完再摘除流量。',
    '依赖锁定到具体的小版本，避免上游补丁悄悄改变运行时行为。',
    '压测基线每个月跑一次，防止性能在不知不觉里慢慢退化。',
    '探针脚本统一放到 tools 目录，跟主程序分开维护和升级。',
    '文档里的命令示例统一用正斜杠，两个平台都能直接粘贴执行。',
    '临时目录用系统提供的那个，跨平台不用自己判断路径分隔符。',
    '测试只跑离线的部分，联网的用例单独标记并按需触发。',
    '发布前先核对 changelog 的条目，跟实际改动逐条对一遍。',
    '回滚方案写在发布步骤里，出问题时不用临时想怎么办。',
    '构建产物打上 commit 短哈希，线上出问题能立刻定位到提交。',
    '接口变更先加新字段再删旧字段，中间留一个版本的过渡期。',
    '超长命令拆成多行，每行一个参数，读起来不容易漏。',
    '脚本里所有路径都加引号，目录名带空格时不会突然失败。',
  ]
  const first = sentences.join('')
  // 第二块 = 全部 24 句原样 + 2 句新的。独立看每句都不同（单块 hazard 为 false），
  // 但它显然是前一块的重述。实测：22/24 句重复时拼接压缩率 0.368（刚过阈值），
  // 全重复时落到 0.2 附近，与真实命中样本的 0.164–0.30 一致。
  const restated = sentences.concat(['发布之后盯一个小时的错误率，异常就立刻回滚。', '版本号按语义化规则递增，破坏性改动单独占一个主版本。']).join('')

  // 前提：两块各自都不算复读（否则用例测的就不是跨块判据）
  assert.equal(isRetentionHazard(shapeReasoning(first)), false, '前提：第一块本身不复读')
  assert.equal(isRetentionHazard(shapeReasoning(restated)), false, '前提：第二块本身不复读')
  assert.ok(first.length > 600, `前提：块要够长，实际 ${first.length}`)

  const verdict = assessTurn([
    { text: first, step: 1 },
    { text: restated, step: 2 },
  ])
  assert.notEqual(verdict.closestPair, null, '够长的块应该给出比值')
  assert.equal(verdict.suspicious, true, '同一段内容再走一遍必须判出来')
  assert.ok(
    verdict.reasons.some((reason) => reason.includes('相邻块')),
    `应该由跨块判据命中：${verdict.reasons.join('；')}`,
  )
  assert.ok(verdict.closestPair.dev >= 3.5, `σ 偏离应该够高，实际 ${verdict.closestPair.dev}`)

  // 两块讲不同的事 → 不能命中
  const different = assessTurn([
    { text: first, step: 1 },
    {
      text: [
        '桌面壁纸要在开机时自动更换，从指定目录里随机挑一张显示。',
        '截图的默认保存位置改到用户目录下的图片文件夹里面去。',
        '任务栏图标合并成始终不显示文字标签的那种形式。',
        '开始菜单里的推荐项目全部关掉，只留下常用程序列表。',
        '系统通知的免打扰时段设成晚上十一点到早上七点之间。',
        '鼠标指针换成高对比度的方案，投影演示的时候更清楚。',
        '文件夹选项里显示隐藏文件以及已知类型的扩展名。',
        '资源管理器的快速访问固定三个最常用的工作目录。',
        '输入法切换热键改成左边的 Ctrl 加上空格键组合。',
        '显示器休眠时间单独设置，接着电源的时候不休眠。',
        '虚拟内存挪到第二块固态盘上，减少系统盘的写入量。',
        '系统还原点每周自动创建一次，占用控制在百分之五。',
        '更新通道设为只接收安全更新，功能性更新手工放行。',
        '备份任务每天凌晨三点跑，保留最近七份就够用了。',
        '电源计划改成平衡模式，插电时再切到高性能档位。',
        '蓝牙耳机连上以后自动切到对应的音频输出设备。',
        '触摸板关掉三指手势，避免和外接鼠标的滚动打架。',
        '登录界面去掉背景模糊，低配机器上的加载更快些。',
        '字体渲染打开亚像素定位，小字号中文看起来清楚。',
        '时区同步开着，出差换地方不用手动改系统时间。',
      ].join(''),
      step: 2,
    },
  ])
  assert.equal(
    different.closestPair === null || different.closestPair.ratio >= 0.35,
    true,
    '讲不同的事不能命中跨块判据',
  )
})

test('跨块判据要求块足够长，短块不比', () => {
  // 几百字符的两句话高度相似是常态，拼起来压缩率低不代表退化。
  const short = '好。'.repeat(30)
  assert.equal(blockPairCompress(short, short), null, '短块不参与跨块判据')
  assert.equal(blockPairCompress(undefined, undefined), null)
  const long = blockPairCompress('x'.repeat(700), 'y'.repeat(700))
  assert.notEqual(long, null, '够长就返回测量值')
  assert.equal(typeof long.dev, 'number', '返回的是 σ 偏离度，不是裸比值')
})

test('散文行不能是纯标点或裸代码关键字', () => {
  // 校准行级阈值时暴露的两个漏判（239 会话 / 31,563 块，阈 8 下仅有的 3 个
  // 非语气误报里就占 2 个）：`'',` 是引号包裹的代码字面量、`return` 是裸关键字，
  // 两者都没有散文内容，却因为 CODEISH 只查特定标点而混进了散文行集合。
  assert.deepEqual(proseRows("'',"), [], '引号包裹的代码字面量不是散文')
  assert.deepEqual(proseRows("'a'"), [], '字符串字面量不是散文')
  for (const keyword of ['return', 'pass', 'break', 'continue', 'fi', 'done']) {
    assert.deepEqual(proseRows(keyword), [], `\`${keyword}\` 是裸关键字，不是散文`)
  }
  // **纯标点行必须留着**：那是真实退化形态。session-aaa00001 turn 49 里模型为了
  // 不复读把「做。」换成「（...）」，density 反涨到 97%，turn 61 出现 6,372 次。
  assert.deepEqual(proseRows('（...）'), ['（...）'], '全角占位符是退化形态，必须保留')
  // 正常的语气短行与中文散文必须留着 —— 否则行级判据就没东西可数了
  assert.deepEqual(proseRows('好。'), ['好。'])
  assert.deepEqual(proseRows('做。'), ['做。'])
  assert.deepEqual(proseRows('Go.'), ['Go.'])
  assert.deepEqual(proseRows('这是一句正常的说明文字。'), ['这是一句正常的说明文字。'])
  // 关键字出现在句子中间不算裸关键字，中文引号也不算字面量
  assert.deepEqual(proseRows('剩下的 return 语句已经改掉了。'), ['剩下的 return 语句已经改掉了。'])
  assert.deepEqual(proseRows('他说「好」。'), ['他说「好」。'])
  // Markdown 分隔线不是散文。测量工具参数复读时它是主要误报源：
  // `---` 在 write.content 里是表格分隔线，重复十几次完全正常。
  for (const rule of ['---', '***', '___', '===']) {
    assert.deepEqual(proseRows(rule), [], `\`${rule}\` 是分隔线，不是散文`)
  }
  // 但列表项不是分隔线
  assert.deepEqual(proseRows('- 第一项'), [], '列表标记仍按代码行处理')
})

test('围栏按字符与长度配对：嵌套围栏里外都不会被吞或提前闭合', () => {
  // 外层 4 个反引号里嵌一层 3 个。只比较首字符时，内层会提前「闭合」外层，于是
  // 内层围栏里的散文行被当成正文参与统计（实测：20 行代码因此被判成「单块复读 93%」）。
  const nested = [
    '````md',
    '外层围栏里的说明行',
    '```js',
    '内层围栏里的散文行',
    '```',
    '````',
    '然后继续做。',
  ].join('\n')
  assert.deepEqual(proseRows(nested), ['然后继续做。'], '两层围栏内的行都不是散文')

  // 反方向：围栏内带 info string 的行（`` ```js ``）不是闭合标记。把它当闭合会让
  // 其后的内容漏出围栏、重新参与行级统计。
  const infoInside = ['```js', '一行代码', '```js', '围栏里的第二段', '```'].join('\n')
  assert.deepEqual(proseRows(infoInside), [], '围栏内带 info string 的行不能闭合围栏')

  // 占位符判据必须与 proseRows 共用同一份状态机；此前是复制粘贴的两份实现。
  const placeholder = ['````', '```', '   ', '```', '````'].join('\n')
  assert.equal(placeholderShape(placeholder).rawRows, 0, '围栏标记不能计入原始行数')
})

test('窗口起点落在围栏内部时，围栏外的散文仍然看得见', () => {
  // 流式守卫喂进来的永远是 `slice(-4096)` 的后缀：起点可能落在代码块中间，于是窗口里
  // 唯一的围栏标记是「闭」。按「第一个标记就是开」处理会把它当开，其后所有散文行被吞
  // —— 实测 400 行代码 + 140 行 `好。` 的窗口被判成 0 行散文，守卫一声不响。
  const code = Array.from({ length: 40 }, (_, index) => `const value${index} = compute(${index})`)
  const window = [...code, '```', ...Array.from({ length: 60 }, () => '好。')].join('\n')
  assert.equal(
    proseRows(window, { fenceState: 'unknown' }).length,
    60,
    '起点未知时必须看到闭围栏之后的 60 行',
  )
  // 起点已知在围栏外时语义不变（整块判据仍按第一个标记当开）。
  assert.deepEqual(
    proseRows(window, { fenceState: 'outside' }),
    [],
    '显式 outside 时第一个标记仍是开围栏',
  )
})

test('空的 reasoning 块不算碎片块', () => {
  // 只有工具调用、没有思考的 step 会传进空 text。
  // `[].every(...)` 恒为 true —— 漏掉这个判断，正常会话会被判成大面积复读
  // （真实误报：一个正常会话的 4 个 turn 因此被判可疑）。
  const empty = Array.from({ length: 8 }, (_, index) => ({ text: '', step: index }))
  const measured = fragmentation(empty)
  assert.equal(measured.longestRun, 0)
  assert.equal(measured.fillers, 0)

  const verdict = assessTurn(empty)
  assert.equal(verdict.suspicious, false)
  assert.deepEqual(verdict.reasons, [])
  // 空白字符也算空
  const blanks = Array.from({ length: 6 }, (_, index) => ({ text: '   \n  ', step: index }))
  assert.equal(assessTurn(blanks).suspicious, false)
})

test('单块复读：真复读命中，代码围栏重复不算', () => {
  const loop = ['好。', '好。', '好。', '好。'].join('\n')
  const verbatim = blockRepeat(loop)
  assert.equal(verbatim.maxRepeat, 4)
  assert.equal(verbatim.ratio, 1)

  // 这正是误报场景：写代码的思考里 ``` 出现很多次，但它不是复读。
  const code = ['```js', 'const a = 1', '```', '```js', 'const b = 2', '```', '```js', 'const c = 3', '```'].join('\n')
  const measured = blockRepeat(code)
  assert.equal(measured.maxRepeat, 0)
  assert.equal(measured.ratio, 0)
})

test('跨块碎片化：连续多个只有几个字的块会被记下来', () => {
  const fragments = ['好。', '执行。', '好。', '好。', '做。', '好。'].map((text) => ({ text, step: 0 }))
  const measured = fragmentation(fragments)
  assert.equal(measured.longestRun, fragments.length)
  assert.ok(measured.fillers >= 6)
  assert.equal(measured.topFiller, '好。')
  assert.equal(measured.topFillerCount, 4) // 好。/执行。/好。/好。/做。/好。 → 「好。」四次
})

test('截图那种「好。执行。好。好。做。」要判成可疑', () => {
  const pattern = ['好。', '执行。', '好。', '好。', '做。', '好。', '执行。', '好。', '输出。', '做。']
  const blocks = []
  // 20 个 step，每个 step 一条只有 1-2 行的 reasoning —— GUI 连起来显示就是这样
  for (let i = 0; i < 20; i += 1) {
    blocks.push({ text: pattern[i % pattern.length], step: i })
  }
  const verdict = assessTurn(blocks)
  assert.equal(verdict.suspicious, true)
  assert.ok(verdict.reasons.length >= 2)
  assert.ok(verdict.reasons.some((reason) => reason.includes('碎片块') || reason.includes('语气短行')))
})

test('内容各异的短句不能判成复读（误报回归）', () => {
  // 真实误报：4 步、每步两行、内容完全不重复的短句，因为每行都短，曾经被
  // 算成「连续碎片块 4 个」+「语气短行 8 条」双命中而判成退化。
  // 判据的根子是没有区分「好。做。」（2 个字，语气词）和「先读文件。」（5 个字，
  // 正常短句）—— SHORT_LINE 从 6 收到 4 之后这类块不再是碎片块。
  const blocks = ['先读文件。\n再看测试。', '读完了。\n没问题。', '改这行。\n再跑。', '再确认。\n好了。'].map(
    (text, step) => ({ text, step }),
  )
  const verdict = assessTurn(blocks)
  assert.equal(verdict.suspicious, false, `不该判成复读：${verdict.reasons.join('；')}`)
  assert.deepEqual(verdict.reasons, [])
  // 同时确认这些行里没有任何一行重复过 —— 这正是当时漏掉的证据。
  assert.equal(verdict.frag.topFillerCount, 1)
})

test('好。做。的四行形态必须算碎片块（漏报回归）', () => {
  // 碎片块的行数上限原来是 3，于是 `好。做。好。做。` 这种 4 行的最典型退化
  // 形态反而不算碎片块，longestRun 判据永远命中不了它。
  const blocks = Array.from({ length: 8 }, (_, index) => ({ text: '好。\n做。\n好。\n做。', step: index }))
  const verdict = assessTurn(blocks)
  assert.equal(verdict.suspicious, true, '8 个连续 4 行碎片块应该判成复读')
  assert.ok(verdict.frag.longestRun >= FRAGMENT_RUN)
})

test('正常的长思考不能被判成可疑', () => {
  const normal = [
    '先确认 API：`ctx.locale.getLocale()` 返回 snapshot，`getSnapshot()` 是 uSES 安全的。',
    '如果模块顶层读 `ctx`，factory 只拿到 `require`，会在渲染时抛 ReferenceError。',
    '修法是把取值移进 `apply`，并用 try 包住，因为不声明 inject 时访问该服务可能抛错。',
    '验证方式：用 `new Function` 执行文件、取工厂、真的调 `factory(require)`。',
  ]
  const blocks = normal.map((text, step) => ({ text, step }))
  const verdict = assessTurn(blocks)
  assert.equal(verdict.suspicious, false)
  assert.deepEqual(verdict.reasons, [])
})

test('判据需要两条同时命中，单条不足以定罪', () => {
  // 一块里某行重复 3 次，但只有这一块：不该判成可疑
  const blocks = [{ text: ['改：', 'x', '改：', 'y', '改：', 'z'].join('\n'), step: 0 }]
  const verdict = assessTurn(blocks)
  assert.equal(verdict.suspicious, false)
  assert.ok(verdict.worstBlock.repeat.maxRepeat >= 3)
  assert.ok(verdict.worstBlock.repeat.ratio < BLOCK_REPEAT_RATIO || verdict.reasons.length < 2)
})

test('连续 3 个碎片块还不到阈值，4 个才到', () => {
  const make = (count) =>
    Array.from({ length: count }, (_, index) => ({ text: `好。${index === 0 ? '' : ''}`, step: index }))
  const three = fragmentation(make(3))
  assert.ok(three.longestRun < FRAGMENT_RUN)
  const four = fragmentation(make(4))
  assert.ok(four.longestRun >= FRAGMENT_RUN)
})

test('shapeReasoning 只留形状，不留原文', () => {
  // 收尾流程要在内存事件环里判复读，而那个环刻意不存 assistant 内容。
  // 形状里混进一个字的原文，就等于悄悄破了这条约定。
  const loop = ['好。', '好。', '好。'].join('\n')
  const shape = shapeReasoning(loop)
  assert.equal(shape.rows, 3)
  assert.equal(shape.fillers, 3)
  assert.equal(shape.maxRepeat, 3)
  assert.equal(shape.repeatRatio, 1)
  assert.equal(shape.tiny, true)
  assert.ok(!JSON.stringify(shape).includes('好'), '形状里不能带原文')
})

test('scanEventRing 从事件环判定：同一 turn 的碎片累积起来才定罪', () => {
  // 6 个碎片块只满足「连续碎片块」，语气短行数还没到 FILLER_MIN(8)，
  // 单条信号不足以定罪 —— 所以这里用 8 个，两条信号同时成立。
  const facts = Array.from({ length: 8 }, (_, index) => ({
    type: 'assistant/message',
    seq: 100 + index,
    turn: 7,
    reasoning: shapeReasoning('好。'),
  }))
  const report = scanEventRing(facts)
  assert.equal(report.scanned, 8)
  assert.equal(report.verdicts.length, 1)
  assert.equal(report.verdicts[0].turn, 7)
  assert.ok(report.verdicts[0].suspicious)
  assert.ok(report.verdicts[0].reasons.length >= 2)

  // 分散在不同 turn 的单片语气词不该被连成一片
  const scattered = Array.from({ length: 8 }, (_, index) => ({
    type: 'assistant/message',
    seq: 200 + index,
    turn: index,
    reasoning: shapeReasoning('好。'),
  }))
  const scatteredReport = scanEventRing(scattered)
  assert.equal(scatteredReport.verdicts.length, 0, '散落在不同 turn 的碎片不足以定罪')
})

test('scanEventRing 跳过没有 reasoning 形状的事件', () => {
  const report = scanEventRing([
    { type: 'assistant/message', seq: 1, turn: 1 },
    { type: 'tool/call', seq: 2 },
    null,
  ])
  assert.equal(report.scanned, 0)
  assert.deepEqual(report.verdicts, [])
})

test('纯标点占位符堆积要判成可疑（漏报回归）', () => {
  // 真实案例 `session-aaa00001` 的 turn 49：模型为了不再复读，把「做。」换成「（...）」，
  // 密度反而从 57% 涨到 97%，turn 52 里出现 1,198 次、turn 61 里 6,372 次。
  // 「（...）」不含实词 → isFiller=false；fillers 为 0 → tiny 也恒为 false，
  // 于是只剩 repeatSignal 一条，够不到 `reasons.length >= 2`。整块静默漏过。
  const dots = Array.from({ length: 200 }, () => '（...）').join('\n')
  const verdict = assessTurn([{ text: dots, step: 1 }])
  assert.equal(verdict.suspicious, true)
  assert.ok(
    verdict.reasons.some((reason) => reason.includes('占位符堆积')),
    `应该由占位符判据命中：${verdict.reasons.join('；')}`,
  )
  assert.ok(verdict.reasons.length >= 2)
})

test('半角 (...) 被 codeish 整块排掉时仍要判出来', () => {
  // `(` 在 CODEISH 的字符类里，所以这种块的 proseRows 是 0：rows、chars、
  // repeatRatio 全是 0，原判据一条信号都拿不到 —— 这正是 GUI 里显示成
  // `(...)` 的那种形态。占位符判据按原始行统计，才看得见它。
  const text = Array.from({ length: 200 }, () => '(...)').join('\n')
  const shape = shapeReasoning(text)
  assert.equal(shape.rows, 0, '前提：散文行确实被代码判据吃掉')
  assert.equal(shape.repeatRatio, 0, '前提：重复占比拿不到任何证据')
  assert.ok(shape.dupShort >= 200)
  assert.equal(shape.shortRatio, 1)
  assert.equal(assessTurn([{ text, step: 1 }]).suspicious, true)
})

test('零散几行 ... 不能算占位符堆积（误报回归）', () => {
  // `...` 曾经在 8 次重复时被判成复读，所以 isFiller 加了实词要求。
  // 新判据必须继承那条边界：dupShort 要 PLACEHOLDER_REPEAT 行起跳，
  // 而不是把 isFiller 的实词要求改回去。
  const few = Array.from({ length: PLACEHOLDER_REPEAT - 4 }, () => '...').join('\n')
  const verdict = assessTurn([{ text: few, step: 1 }])
  assert.equal(verdict.worstDupShort, 0)
  assert.equal(verdict.suspicious, false, `不该判：${verdict.reasons.join('；')}`)
})

test('贴了代码的思考不算占位符堆积', () => {
  // 短行占比 0.8 的闸门就是为这个设的：代码块里 `}` 会重复几十次，
  // 但整块里同时有长行，占比到不了 0.8。没有这道闸门，占位符判据会
  // 把每一次写代码的思考都判成复读。
  const lines = []
  for (let index = 0; index < 40; index += 1) {
    lines.push(`  if (flag${index}) {`, `    result.push(value${index})`, '  }')
  }
  const text = lines.join('\n')
  const shape = shapeReasoning(text)
  assert.ok(shape.dupShort >= PLACEHOLDER_REPEAT, `前提：右花括号确实重复很多：${shape.dupShort}`)
  assert.ok(shape.shortRatio < PLACEHOLDER_SHORT_RATIO, `短行占比应该低：${shape.shortRatio}`)
  assert.equal(assessTurn([{ text, step: 1 }]).suspicious, false)
})

test('两块各 6 行占位符不算堆积：阈值必须由同一块满足', () => {
  // 短行占比低的块重复多、短行多的块各写各的，各取最大值凑不出堆积。
  const block = Array.from({ length: PLACEHOLDER_REPEAT / 2 }, () => '（...）').join('\n')
  const verdict = assessTurn([
    { text: block, step: 1 },
    { text: block, step: 2 },
  ])
  assert.ok(verdict.worstDupShort < PLACEHOLDER_REPEAT)
})

test('真实同构样本：「做。」+「（...）」交替必须判成复读', () => {
  // 结构直接取自 `session-aaa00001` 的 turn 61 step 14（单块 65,928 字符）：
  // 开头 4 行正常思考，然后「做。」与「（...）」各占一半。
  // 这种交替块由「语气短行 + 单块复读」两条老信号命中（「做。」有实词），
  // 占位符判据不需要参与 —— 它的 0.8 闸门是留给**纯**标点块的。
  const lines = ['**PR 创建成功！**', '- PR #777', '**现在验证**：', '1. 检查自动检查是否通过']
  for (let index = 0; index < 300; index += 1) lines.push(index % 2 === 0 ? '做。' : '（...）')
  const verdict = assessTurn([{ text: lines.join('\n'), step: 1 }])
  assert.equal(verdict.suspicious, true)
  assert.ok(verdict.reasons.length >= 2, verdict.reasons.join('；'))
  assert.ok(verdict.reasons.some((reason) => reason.includes('单块复读')))
})

test('placeholderShape 只认无实词的短行，且不保留原文', () => {
  const shape = placeholderShape(
    ['（...）', '（...）', '这是一句很长的正常思考。', '做。', '先读文件。', ''].join('\n'),
  )
  assert.equal(shape.dupShort, 0, '两次重复不到阈值')
  // 5 行非空里 `（...）` 占 2 行；`做。`/`先读文件。`/长句都有实词，都不算占位符行
  assert.equal(shape.shortRatio, 2 / 5)
  assert.ok(!JSON.stringify(shape).includes('（'), '形状里不能带原文')
})

test('isLoopBlock 与 assessShapes 的块级判据必须同源', () => {
  // 压缩的保留侧剔除是按**块**挑的（一个 40 步的 turn 里可能只有最后一步退化，
  // 整轮剔除会把有用历史一起扔掉），而 turn 级定罪是按 assessShapes 聚合。
  // 两边阈值一旦漂移，就会出现「turn 被判可疑、却挑不出任何一块可剔」的死角。
  const cases = [
    ['「做。」×40', Array.from({ length: 40 }, () => '做。').join('\n')],
    ['「（...）」×200', Array.from({ length: 200 }, () => '（...）').join('\n')],
    ['「(...)」×200', Array.from({ length: 200 }, () => '(...)').join('\n')],
    ['`...`×8（历史误报）', Array.from({ length: 8 }, () => '...').join('\n')],
    ['正常短句', ['先读文件。', '再看测试。', '改这行。'].join('\n')],
    ['贴了代码', ['```js', 'const a = flag && value', '```', '```js', 'const b = other', '```'].join('\n')],
  ]
  for (const [label, text] of cases) {
    const shape = shapeReasoning(text)
    const verdict = assessShapes([shape])
    assert.equal(
      isLoopBlock(shape),
      verdict.repeatSignal || verdict.placeholderSignal,
      `${label}：块级判定与 turn 级信号不一致：${JSON.stringify(shape)}`,
    )
  }
})

test('英文行内复读必须被压缩率抓到（漏报回归）', () => {
  // 两个原形态信号都建立在「行」上，而英文复读整段塞在一行里：
  // `Let me do it now. Let me do it now. …` 只有 1 行、fillers 0、行重复 0%。
  // 全库 5,748 个英文块在任何行级阈值下都抓不到这种形态（本机历史上没发生过，
  // 所以这条只能靠合成样本守）。
  const text = 'Let me do it now. '.repeat(20)
  const shape = shapeReasoning(text)
  assert.equal(shape.rows, 1, '前提：整块只有一行，行级判据无从下手')
  assert.equal(shape.fillers, 0, '前提：没有语气短行')
  assert.equal(shape.repeatRatio, 0, '前提：行重复率为 0')
  assert.ok(shape.compress !== undefined && shape.compress < COMPRESS_SIGNAL)
  const verdict = assessTurn([{ text, step: 1 }])
  assert.equal(verdict.suspicious, true, `应该判复读：${verdict.reasons.join('；')}`)
  assert.equal(verdict.compressSignal, true)
  assert.ok(verdict.reasons.some((reason) => reason.includes('压缩率')))
})

test('结构规整的重复代码不能被压缩率误报', () => {
  // 实测这段合成代码压缩率 0.130，落在真复读（0.018~0.038）与正常（0.6）之间。
  // 闸门是"散文行占非空行多数"：纯代码块 proseRows 是 0。
  const lines = []
  for (let index = 0; index < 40; index += 1) {
    lines.push(`  if (flag${index}) {`, `    result.push(value${index})`, '  }')
  }
  const text = lines.join('\n')
  const shape = shapeReasoning(text)
  assert.ok(shape.compress < COMPRESS_SIGNAL, `前提：压缩率确实很低：${shape.compress}`)
  assert.equal(shape.rows, 0, '前提：没有散文行')
  assert.equal(assessTurn([{ text, step: 1 }]).suspicious, false)
  assert.equal(isRetentionHazard(shape), false, '压缩时也不能剔掉它')
})

test('markdown 清单不能被压缩率误判', () => {
  // `- ✓ 已检查` × 30 压缩率 0.065 —— 比真复读还低，但它不是复读。
  const text = Array.from({ length: 30 }, () => '- ✓ 已检查').join('\n')
  const shape = shapeReasoning(text)
  assert.ok(shape.compress < COMPRESS_SIGNAL, `前提：压缩率确实很低：${shape.compress}`)
  assert.equal(assessTurn([{ text, step: 1 }]).suspicious, false)
  assert.equal(isRetentionHazard(shape), false)
})

test('isRetentionHazard 比检测更严格：混合块不剔，纯复读才剔', () => {
  // 检测多报一条只是多一条提醒；剔除多报一次会删掉有用思考。
  // 全库实测：宽松判据命中 955 块，其中 660 块压缩率 >0.3（一段真重复 + 大量正常内容）。
  const pureLoop = shapeReasoning(Array.from({ length: 100 }, () => '做。').join('\n'))
  assert.equal(isRetentionHazard(pureLoop), true, '几乎整块在重复 → 剔')
  assert.ok(pureLoop.compress <= 0.15)

  // 同一件事在「检测」层是宽松的：这两者都该判复读，但不该被剔。
  //
  // 注意取样：216 字符里塞 40 行「（输出。）」不算混合块 —— 那 92.6% 的字符都在
  // 重复，本来就应该剔（归一化正是靠这一点发现了它）。真正的混合块是"正常内容
  // 占多数、复读只占一小段"。
  const mixed = shapeReasoning(
    [
      '先读 lib/index.js 的 readRepeatRisk，确认它返回的 waits 字段在 status 里有没有被用上。',
      '再看 describeRepeatRisk 的文案：它需要在等待型工具没发出去时给出"先发 pending 再问"的建议。',
      '然后检查 collectLoopingSeqs 的签名，它是 (session, priced, surface, retain, factsReader, recentReader)。',
      '最后确认 selectRetainedRange 返回的 excludedLoopBlocks 会被 compact 的回执读走。',
      '另外 token 预算那段用的是 priced 里的 tokens，不是字符数，别搞混。',
      '还有一点：surface 节点数与计价节点数在 auto 力度下可能不同，平衡修正会调整 keepFromIdx。',
    ].join('\n')
      + '\n' + Array.from({ length: 6 }, () => '（输出。）').join('\n'),
  )
  assert.equal(isRetentionHazard(mixed), false, '混合块还有正常内容，不能整块删')
})

test('纯围栏代码没有散文证据：rawRows 明确为 0 不能剔，缺字段的旧形状保持兼容', () => {
  // 散文占比闸门在两处各写了一份，方向相反：
  //   assessShapes  `rawRows === 0 ? 0 : rows / rawRows`   → 拒绝散文资格
  //   isRetentionHazard  `rawRows > 0 ? rows / rawRows : 1` → 授予散文资格
  // 于是「整块都是围栏代码」（chars/rows/rawRows 全为 0）拿到散文资格 1，再被自己的
  // 低压缩率剔出逐字尾部 —— 而这正是这条闸门存在的理由（见上面 40×`if` 的实测）。
  const fence = ['```python', ...Array.from({ length: 40 }, () => 'print("processing record")'), '```'].join('\n')
  const shape = shapeReasoning(fence)
  assert.equal(shape.rawRows, 0, '前提：完整围栏被整段排除')
  assert.equal(shape.chars, 0, '前提：排除后没有剩余字符')
  assert.ok(typeof shape.compress === 'number' && shape.compress <= 0.15, '前提：它确实高度可压')
  assert.equal(isRetentionHazard(shape), false, '纯代码块没有散文证据，不能剔')

  // 缺字段的旧形状（mixed-version 事件环）必须保持原行为：升级不能让历史块
  // 统统不再被剔，那是另一个方向的错。
  assert.equal(isRetentionHazard({ compress: 0.05 }), true, '缺 rawRows 时按旧逻辑走压缩率')
  assert.equal(
    isRetentionHazard({ compress: 0.05, rows: 0, rawRows: 0 }),
    false,
    '明确 0 与缺字段必须分开：前者是「没有散文行」，后者是「不知道」',
  )
  // 有散文行的块语义不变。
  assert.equal(isRetentionHazard({ compress: 0.05, rows: 40, rawRows: 40 }), true)
})

test('compress 只在够长的块上计算', () => {
  // deflate 的固定头部会把短文本的比例推到 1 附近，阈值就失去意义。
  assert.equal(shapeReasoning('好。做。好。').compress, undefined)
  // 样本必须**真的多样**：40 行「第 N 行：检查文件 N」只是模板重复，压缩率 0.123，
  // 和复读分不开 —— 这正是"压缩率不区分模板与复读"的证据，不能拿它当正常文本。
  const varied = [
    '先确认 API：`ctx.locale.getLocale()` 返回 snapshot，`getSnapshot()` 是 uSES 安全的。',
    '如果模块顶层读 `ctx`，factory 只拿到 `require`，会在渲染时抛 ReferenceError。',
    '修法是把取值移进 `apply`，并用 try 包住，因为不声明 inject 时访问该服务可能抛错。',
    '验证方式：用 `new Function` 执行文件、取工厂、真的调 `factory(require)`。',
    '另外要注意：schema 是惰性取得的，静态 import 会在模块解析阶段抛 ERR_MODULE_NOT_FOUND。',
  ].join('\n')
  assert.ok(varied.length >= 200, '前提：够长')
  assert.ok(typeof shapeReasoning(varied).compress === 'number')
  // 压缩率本身：复读极低、真实多样的文字明显更高
  assert.ok(compressionRatio('做。'.repeat(100)) < 0.1)
  assert.ok(
    compressionRatio(varied) > 0.4,
    `真实多样文字的压缩率应明显更高：${compressionRatio(varied)}`,
  )
})

test('中文归一化：参照曲线随长度下降，短块不再被绝对阈值放过', () => {
  // 绝对压缩率随长度漂移是结构性的（deflate 头部固定开销摊不开）：
  // 全库实测 200-400 字符中文块 p50 = 0.744，6400-12800 只有 0.482。
  assert.ok(referenceCompress(300) > referenceCompress(3000))
  assert.ok(referenceCompress(3000) > referenceCompress(16000))
  // 曲线两端要对得上实测分位。长端容差要放宽：拟合是加权的，6400-12800 桶
  // 实测 p50 = 0.482 而曲线给 0.546（残差 +0.064，该桶只有 267 个块）。这是已知
  // 的系统性偏差 —— 所以判定时**从不单靠 norm 收紧长块**，长块走绝对阈值那条。
  assert.ok(Math.abs(referenceCompress(300) - 0.75) < 0.04, `300 字参照应约 0.75：${referenceCompress(300)}`)
  assert.ok(
    Math.abs(referenceCompress(7000) - 0.48) < 0.09,
    `7000 字参照应约 0.48（容差 0.09）：${referenceCompress(7000)}`,
  )

  // 关键场景：一个 323 字符的复读块，绝对压缩率 0.208（`<=0.2` 判据放过），
  // 但相对同长度正常中文文本只有 28% —— 这正是全库那 3 个漏报块的形态。
  assert.ok(normalizedCompress(0.208, 323) <= NORM_SIGNAL)
  // 同一压缩率放在长块上就不算异常（长块参照本来就低）—— 说明归一化不是简单缩放。
  assert.ok(normalizedCompress(0.208, 7000) < 0.5)
  // 正常短块：压缩率贴着参照，norm 接近 1
  assert.equal(normalizedCompress(referenceCompress(300), 300), 1)
})

test('中文归一化只在中文块上生效，非中文显式标注不支持', () => {
  // 英文块：lang = 'other'，norm 必须是 undefined。本机 5,748 个英文块里零个重度
  // 复读，没有样本能标定，借中文曲线只会制造假信号。
  const english = 'Let me check the configuration file first and then run the tests. '.repeat(8)
  const en = shapeReasoning(english)
  assert.equal(en.lang, 'other')
  assert.equal(en.norm, undefined, '非中文块不能有归一化值')
  assert.ok(typeof en.compress === 'number', '绝对压缩率仍然可用')

  // 中文块：lang = 'zh'，norm 有值
  const chinese = '先读 lib/index.js 的 readRepeatRisk，确认它返回的 waits 字段有没有被用上。'.repeat(8)
  const zh = shapeReasoning(chinese)
  assert.equal(zh.lang, 'zh')
  assert.ok(typeof zh.norm === 'number')

  // 中文占比在 0.3 边界附近的分流。注意标点不算汉字：`做。好。执行。` 里
  // 7 个非空白字符中有 3 个是句号，CJK 只有 0.57，所以纯中文样本要挑不带标点的。
  assert.ok(cjkShare('这是纯中文的一句话没有任何英文字母') > 0.9)
  assert.equal(cjkShare('hello world this is plain english text'), 0)
  // 中英各半的块**不算**中文块（6/25 = 0.24 < 0.3）：归一化曲线是中文标定的，
  // 套到这种块上等于借别人的基线，所以宁可不给 norm。
  assert.ok(cjkShare('mixed 中文 and english 混合内容 here') < CJK_MIN_SHARE)
  assert.ok(cjkShare('这块是中文内容，只有 mixed 三个字是英文') >= CJK_MIN_SHARE)
})

test('结尾重复：反向 Z 给出重复单位与次数，正常文本不触发', () => {
  // 「做。」×100：单位 2 字符、100 遍
  const dense = Array.from({ length: 100 }, () => '做。').join('')
  const denseRepeat = trailingRepeat(dense)
  assert.equal(denseRepeat?.period, 2)
  assert.equal(denseRepeat?.repeats, 100)
  assert.equal(denseRepeat?.span, 200)
  assert.equal(denseRepeat?.sample, '做。', '只留重复单位当证据，不复制整段原文')

  // 「做。好。执行。」×10：单位 7 字符（做。好。执行。= 3+2+2）、10 遍
  const varied = trailingRepeat('做。好。执行。'.repeat(10))
  assert.equal(varied?.period, 7)
  assert.equal(varied?.repeats, 10)

  // 英文行内重复：单位 18 字符、20 遍 —— 这是行级判据永远看不见的形态
  const english = trailingRepeat('Let me do it now. '.repeat(20))
  assert.equal(english?.period, 18)
  assert.equal(english?.repeats, 20)

  // 正常文本必须 null：反复出现同一个词不算复读，只有**尾部连续重现**才算
  assert.equal(
    trailingRepeat('先确认 API 返回的是 snapshot，这样 uSES 才安全。if 模块顶层读 ctx 会抛错。修法是把取值移进 apply。'),
    null,
  )
  assert.equal(trailingRepeat('我们需要确认这个函数的返回值，然后检查这个函数的参数，最后测试这个函数的边界。'), null)
  assert.equal(trailingRepeat('结论：这个方案可行，但要注意三点。'), null)
  // 只重复 2 遍不算（Holtzman 判据要求 ≥3 次）
  assert.equal(trailingRepeat('做。做。'), null)
})

test('指数严重度：DRY 的 base^len 形态，且必须钳住防溢出', () => {
  // 免罚线：重复 2 遍是 1.0，之后每多一遍乘 1.75
  assert.equal(repeatSeverity(2), 1)
  assert.ok(Math.abs(repeatSeverity(3) - 1.75) < 1e-9)
  assert.ok(Math.abs(repeatSeverity(5) - 1.75 ** 3) < 1e-9)
  assert.ok(repeatSeverity(10) > repeatSeverity(5))
  // 钳制：100 遍已经大到没意义，200 遍以上一律同分（DRY 用 88.72/ln(base) 封顶）
  assert.ok(repeatSeverity(100) < 1e39, `指数必须被钳住：${repeatSeverity(100)}`)
  assert.equal(repeatSeverity(200), repeatSeverity(1000), '到量级后同分')
  // 分档供文案用
  assert.equal(severityTier(repeatSeverity(3)), '轻微')
  assert.equal(severityTier(repeatSeverity(6)), '中度')
  assert.equal(severityTier(repeatSeverity(20)), '严重')
})

test('中文归一化：短复读块可剔除，正常短块不动', () => {
  // 332 字符的纯中文复读：绝对压缩率 0.045、归一化 0.062，两个判据一致同意。
  const loop = Array.from({ length: 100 }, (_, index) => ['做。', '好。', '执行。'][index % 3]).join('\n')
  const loopShape = shapeReasoning(loop)
  assert.equal(loopShape.lang, 'zh')
  assert.ok(loopShape.compress <= COMPRESS_SIGNAL)
  assert.ok(loopShape.norm <= NORM_SIGNAL)
  assert.equal(isRetentionHazard(loopShape), true)

  // 同长度的正常中文技术思考：两个判据都放过。
  const normal = [
    '先确认 API：`ctx.locale.getLocale()` 返回 snapshot，`getSnapshot()` 是 uSES 安全的。',
    '如果模块顶层读 `ctx`，factory 只拿到 `require`，会在渲染时抛 ReferenceError。',
    '修法是把取值移进 `apply`，并用 try 包住，因为不声明 inject 时访问该服务可能抛错。',
    '验证方式：用 new Function 执行文件、取工厂、真的调 factory(require)。',
  ].join('\n')
  const normalShape = shapeReasoning(normal)
  assert.equal(normalShape.lang, 'zh')
  assert.ok(normalShape.norm > NORM_SIGNAL, `正常短块不该被判异常：${normalShape.norm}`)
  assert.equal(isRetentionHazard(normalShape), false)
})
