// 探针：用最小桩执行 lib/client.js 的 factory。
//
// 宿主是**懒执行** factory 的：文件顶层只调 window.__ModuleLoader__.load(...)
// 注册工厂，等设置页真正渲染时才调 factory(require)。所以「模块顶层引用了
// 不存在的变量」不会在 node --check 或任何静态检查里暴露，只会表现为
// 设置页静默空白（本项目真的发生过：顶层写了 ctx?.locale）。
//
// 用法：node tools/probes/client-boot.mjs [--installed <dir>]
//   --installed 指向已装进 profile 的包目录时，会去验「真正会被加载的那份」
//   而不是仓库里的源码。
// 退出码：0 = 能启动；1 = 抛错。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const installed = argv.includes('--installed') ? argv[argv.indexOf('--installed') + 1] : null
const clientPath = installed === null ? join(here, '..', '..', 'lib', 'client.js') : join(installed, 'lib', 'client.js')

const code = readFileSync(clientPath, 'utf8')
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
const loaded = []
const windowStub = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } }
const documentStub = {
  head: { appendChild: () => {} },
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
  querySelector: () => null,
}

const run = (label, fn) => {
  try {
    fn()
    console.log(`  ✓ ${label}`)
    return true
  } catch (error) {
    console.log(`  ✗ ${label}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    return false
  }
}

console.log(`检查 ${clientPath}`)
console.log('1) 文件顶层（只应注册工厂）')
const topOk = run('顶层执行', () => {
  new Function('window', 'document', 'navigator', code)(windowStub, documentStub, { language: 'en-US' })
})
console.log(`   注册的工厂数：${loaded.length}`)
if (!topOk || loaded.length === 0) process.exit(1)

console.log('2) factory(require)（宿主渲染时真正走这一步）')
const definition = loaded[0]
const requireStub = (id) => {
  if (id === 'react') return reactStub
  throw new Error(`client 不应 require 其它模块，却 require 了 ${id}`)
}
if (!run('factory 顶层', () => definition.factory(requireStub))) process.exit(1)

const surface = definition.factory(requireStub)
console.log(`   inject = ${JSON.stringify(surface.inject)}`)
if (!surface.inject.includes('locale')) {
  console.log('   ✗ inject 里没有 locale：面板拿不到 DSH 的界面语言，会退回浏览器语言')
  process.exit(1)
}

console.log('3) apply（无 locale / 无 configForms 时的降级路径）')
const ctxStub = {
  effect: (fn) => {
    fn()
    return () => {}
  },
  configForms: { whileServed: () => () => {}, get: () => null },
  slots: { inject: () => {}, register: () => () => {} },
  // cordis 的 reflect 接口：读服务不需要 inject。插件用 ctx.get('locale')
  // 拿语言，所以桩里必须有它 —— 否则探针测的不是真实路径。
  get: () => undefined,
}
if (!run('apply', () => surface.apply(ctxStub))) process.exit(1)

// 有 locale 服务时必须能读到，且语言判定跟随它（而不是 navigator）。
console.log('4) apply（有 locale 服务 → 走 ctx.get）')
const zhLocale = {
  getLocale: () => ({ active: 'zh', revision: 1 }),
  getSnapshot: () => ({ active: 'zh', revision: 1 }),
  subscribe: () => () => {},
}
const ctxWithLocale = { ...ctxStub, get: (name) => (name === 'locale' ? zhLocale : undefined) }
if (!run('apply + locale', () => surface.apply(ctxWithLocale))) process.exit(1)

console.log('\n✓ 客户端能启动')
process.exit(0)
