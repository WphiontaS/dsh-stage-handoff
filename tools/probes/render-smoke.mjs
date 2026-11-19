// 探针：在指定语言下真正渲染一次设置面板，把树里的文本全抓出来。
//
// 这比人工读 EN 表强的地方在于：它走真实渲染路径（pick / t() / labelOf 全都
// 跑一遍），所以「表里有英文但代码没走 pick」「某个字符串根本没进表」这类问题
// 都会掉出来。人工审查只能看表里有什么，看不到表外遗漏的。
//
// 实际抓到的 bug：页签按钮直接用了 `entry.label`（中文）而不是
// `pick(entry.label, entry.labelEn)`，于是英文界面下三个页签各冒一个中文词。
//
// 用法：
//   node tools/probes/render-smoke.mjs                  # 仓库源码，英文
//   node tools/probes/render-smoke.mjs --lang zh        # 中文
//   node tools/probes/render-smoke.mjs --installed <dir>   # 装进 profile 的那份
// 退出码：英文下出现中文 → 1。
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 渲染一次设置面板并收集所有文本节点。
 * @param {{clientPath?: string, language?: string}} options - overrides for tests
 * @returns {{language: string, texts: string[], chinese: string[], clientPath: string}} result
 */
export function renderPanel(options = {}) {
  const clientPath = options.clientPath ?? join(here, '..', '..', 'lib', 'client.js')
  const language = options.language ?? 'en'

  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  }

  const snapshot = { active: language, locales: [], revision: 1 }
  const localeService = {
    getLocale: () => snapshot,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  }

  let panel = null
  const slots = {
    inject: (name, register) => register(),
    register: (definition, component) => {
      if (definition?.name === 'settings.section') panel = component
      return () => {}
    },
  }
  const configForms = { whileServed: (namespaces, callback) => {
    callback([])
    return () => {}
  }, get: () => null }
  const ctx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    get: (name) => {
      if (name === 'locale') return localeService
      if (name === 'configForms') return configForms
      if (name === 'slots') return slots
      return undefined
    },
    configForms,
    slots,
  }

  const loaded = []
  const windowStub = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } }
  const documentStub = {
    head: { appendChild: () => {} },
    createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
    querySelector: () => null,
  }

  const code = readFileSync(clientPath, 'utf8')
  new Function('window', 'document', 'navigator', code)(windowStub, documentStub, { language: 'en-US' })
  const surface = loaded[0].factory((id) => {
    if (id === 'react') return ReactStub
    throw new Error(`unexpected require: ${id}`)
  })
  surface.apply(ctx)
  const component = panel
  if (component === null) throw new Error('没有捕获到 settings.section 组件')

  const texts = []
  // h() 只创建元素，不会调用函数组件 —— 这里手动展开，否则树里全是元素对象、
  // 一个文本节点都抓不到（第一版就踩了这个坑，报了「0 个文本节点 ✓ 干净」）。
  const walk = (node, depth = 0) => {
    if (depth > 40) throw new Error('渲染深度超限，可能是组件自递归')
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') {
      texts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1)
      return
    }
    if (typeof node.type === 'function') {
      walk(node.type(node.props ?? {}), depth + 1)
      return
    }
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  walk(component({}))

  return {
    language,
    clientPath,
    texts,
    chinese: texts.filter((text) => /[\u4e00-\u9fa5]/.test(text)),
  }
}

// 路径比较必须走 realpath：node 对主模块取 realpath 生成 import.meta.url，而
// `process.argv[1]` 保留调用时的路径。经目录联接（mklink /J）或符号链接访问
// 仓库时两者不相等，整个探针会一条不跑却 exit 0 —— 假绿，正是它要防的东西。
const invokedDirectly = (() => {
  if (process.argv[1] === undefined) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
})()
if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const installed = argv.includes('--installed') ? argv[argv.indexOf('--installed') + 1] : null
  const language = argv.includes('--lang') ? argv[argv.indexOf('--lang') + 1] : 'en'
  const clientPath = installed === null ? undefined : join(installed, 'lib', 'client.js')
  const result = renderPanel({ clientPath, language })
  console.log(`渲染语言 ${result.language} · 文本节点 ${result.texts.length} 个 · 含中文 ${result.chinese.length} 个`)
  for (const text of result.chinese) console.log(`  ${JSON.stringify(text.slice(0, 120))}`)
  if (language === 'en' && result.chinese.length > 0) {
    console.log('\n✗ 英文界面下出现了中文（技术日志不在渲染树里，不算）')
    process.exit(1)
  }
  console.log(`\n✓ ${language} 渲染干净`)
  process.exit(0)
}
