// 探针侧的判据入口：实现只有一份，在 lib/repeat-scan.js。
//
// 这个文件保留下来有两个原因：探针脚本与离线测试都从这里 import（历史路径），
// 而且它顺带保证了「探针与插件用的是同一套阈值」—— 一旦有人只改一边，
// test/probes.test.mjs 会当场发现两边不一致。
export * from '../../../lib/repeat-scan.js'
