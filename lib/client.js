/**
 * 设置页分栏。
 *
 * React 由宿主的 `window.__ModuleLoader__` 提供，本文件是普通 JS，不经过任何打包步骤。
 *
 * 数据来自 `ctx.configForms`（`@deepseek-ai/dsh-client-ui-settings` 提供的 cordis Service，
 * 必须在 `inject` 里声明，否则 `ctx.configForms` 是 undefined —— 这是第一版面板只读的原因）。
 *
 * 契约（见 `dsh-client-ui-settings/lib/types/client/config-form-types.d.ts`）：
 *   - `getSnapshot()` → `{ status, value, base, user, revision, writable }`，值的真正位置是 `value`
 *   - `subscribe(listener)` → 快照变化时回调，用 `useSyncExternalStore` 订阅
 *   - `set(field, value)` → **`Promise<boolean>`**，true 表示宿主接受
 *   - `unset(field)` → 删除字段的用户覆盖，恢复 inherited/default 值
 *   - `mutate(ops)` → 原子套用多个字段操作，快捷方案用它避免半套配置
 *
 * 三层降级：可写 / 只读 / 静态默认值。任何一层失败都不会把面板打白。
 */
window.__ModuleLoader__.load({
  id: 'dsh-stage-handoff',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useSyncExternalStore, useCallback, useRef } = React

    const CSS = `
[data-stage-handoff-root]{
  --sh-fill:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08)));
  --sh-input:var(--dsw-alias-bg-layer-1,transparent);
  --sh-text:var(--dsw-alias-label-primary,var(--dsh-text-primary,inherit));
  --sh-muted:var(--dsw-alias-label-secondary,var(--dsh-text-secondary,#8b93a7));
  --sh-tertiary:var(--dsw-alias-label-tertiary,var(--dsh-text-secondary,#8b93a7));
  --sh-border:var(--dsw-alias-border-l2,rgba(140,150,175,.2));
  --sh-border-strong:var(--dsw-alias-border-l4,rgba(140,150,175,.34));
  --sh-accent:var(--dsw-alias-brand-primary,var(--dsh-accent,#7c9cff));
  --sh-success:var(--dsw-alias-state-success-primary,#58a76f);
  --sh-warn:var(--dsw-alias-state-warn-primary,#d4a84f);
  --sh-error:var(--dsw-alias-state-error-primary,#d66d75);
  box-sizing:border-box;
  width:100%;
  max-width:760px;
  display:flex;
  flex-direction:column;
  gap:14px;
  color:var(--sh-text);
  font-size:14px;
  line-height:22px;
}
[data-stage-handoff-root] *{box-sizing:border-box}
[data-stage-handoff-hero]{display:flex;align-items:flex-start;gap:14px;padding:2px 0}
[data-stage-handoff-mark]{display:flex;align-items:center;justify-content:center;flex:none;width:46px;height:46px;border-radius:14px;background:var(--sh-fill);color:var(--sh-accent);box-shadow:inset 0 0 0 .5px var(--sh-border)}
[data-stage-handoff-hero-main]{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
[data-stage-handoff-kicker]{font-size:11px;line-height:16px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--sh-tertiary)}
[data-stage-handoff-title]{margin:0;font-size:19px;line-height:27px;font-weight:650}
[data-stage-handoff-intro]{margin:0;color:var(--sh-muted);font-size:13px;line-height:20px}
[data-stage-handoff-pills]{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:3px}
[data-stage-handoff-pill]{display:inline-flex;align-items:center;gap:5px;height:23px;padding:0 8px;border-radius:999px;background:var(--sh-fill);color:var(--sh-muted);font-size:11px;line-height:22px;white-space:nowrap}
[data-stage-handoff-pill="ok"]{color:var(--sh-success)}
[data-stage-handoff-pill="warn"]{color:var(--sh-warn)}
[data-stage-handoff-dot]{width:6px;height:6px;border-radius:50%;flex:none;background:currentColor}
[data-stage-handoff-actions]{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
[data-stage-handoff-button]{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,7px);background:transparent;color:var(--sh-text);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
[data-stage-handoff-button]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
[data-stage-handoff-button]:disabled{opacity:.42;cursor:not-allowed}
[data-stage-handoff-button="outline"]{box-shadow:inset 0 0 0 .5px var(--sh-border-strong)}
[data-stage-handoff-ico]{width:14px;height:14px;flex:none}
[data-stage-handoff-stats]{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
[data-stage-handoff-stat]{min-width:0;padding:10px 12px;border-radius:var(--dsw-radius-md,9px);background:var(--sh-fill);box-shadow:inset 0 0 0 .5px var(--sh-border)}
[data-stage-handoff-stat-label]{display:block;font-size:11px;line-height:16px;color:var(--sh-tertiary)}
[data-stage-handoff-stat-value]{display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;font-weight:600}
[data-stage-handoff-stat-value] code{font:12px/20px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
[data-stage-handoff-statusbar]{position:sticky;top:8px;z-index:4;display:flex;align-items:center;gap:8px;min-height:36px;padding:7px 11px;border-radius:var(--dsw-radius-md,9px);background:var(--dsw-alias-bg-layer-3,var(--sh-fill));box-shadow:inset 0 0 0 .5px var(--sh-border),0 4px 16px rgba(0,0,0,.08);color:var(--sh-muted);font-size:12px;line-height:18px}
[data-stage-handoff-statusbar] strong{color:var(--sh-text);font-weight:550}
[data-stage-handoff-statusbar][data-kind="ok"]{color:var(--sh-success)}
[data-stage-handoff-statusbar][data-kind="warn"]{color:var(--sh-warn)}
[data-stage-handoff-statusbar][data-kind="error"]{color:var(--sh-error)}
[data-stage-handoff-tabs]{display:flex;align-items:center;gap:2px;padding:2px;border-radius:calc(var(--dsw-radius-md,9px) + 2px);background:var(--sh-fill);align-self:flex-start;max-width:100%;overflow-x:auto}
[data-stage-handoff-tab]{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 13px;border:.5px solid transparent;border-radius:var(--dsw-radius-md,9px);background:transparent;color:var(--sh-muted);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
[data-stage-handoff-tab]:hover{color:var(--sh-text)}
[data-stage-handoff-tab][aria-selected="true"]{border-color:var(--sh-border);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-3));color:var(--sh-text);font-weight:550}
[data-stage-handoff-count]{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--sh-fill);color:var(--sh-muted);font-size:10px;line-height:18px;text-align:center}
[data-stage-handoff-panel]{display:flex;flex-direction:column;gap:10px}
[data-stage-handoff-card]{padding:14px 16px;border-radius:var(--dsw-radius-md,9px);background:var(--sh-fill);box-shadow:inset 0 0 0 .5px var(--sh-border)}
[data-stage-handoff-card-head]{margin-bottom:4px}
[data-stage-handoff-card-title]{display:flex;align-items:center;gap:7px;font-size:13px;line-height:20px;font-weight:600}
[data-stage-handoff-card-hint]{margin-top:2px;color:var(--sh-tertiary);font-size:12px;line-height:18px}
[data-stage-handoff-row]{display:grid;grid-template-columns:minmax(0,1fr) minmax(170px,230px);gap:16px;align-items:center;padding:13px 0;border-bottom:.5px solid var(--sh-border)}
[data-stage-handoff-row]:last-child{border-bottom:0;padding-bottom:3px}
[data-stage-handoff-row][data-fixed="true"]{opacity:.64}
[data-stage-handoff-row-main]{min-width:0}
[data-stage-handoff-row-title]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px;line-height:20px;font-weight:550}
[data-stage-handoff-badge]{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;background:rgba(127,127,127,.12);color:var(--sh-tertiary);font-size:10px;line-height:18px;font-weight:500}
[data-stage-handoff-hint]{margin:2px 0 0;color:var(--sh-tertiary);font-size:12px;line-height:18px}
[data-stage-handoff-hint] code{font:11px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--sh-muted)}
[data-stage-handoff-control]{display:flex;flex-direction:column;gap:4px;min-width:0}
/* 快捷选项（suggestions）以前和输入框挤在同一行：四个按钮占掉控制区之后，
   输入框被压成只剩二十几像素，看不到自己填的值。这里让它换行、独占一整行，
   输入框自己则改成可伸缩并给一个下限，两边都不再互相挤。 */
[data-stage-handoff-control-line]{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
[data-stage-handoff-input]{width:100%;flex:1 1 96px;min-width:96px;height:34px;padding:0 10px;border:.5px solid var(--sh-border-strong);border-radius:var(--dsw-radius-md,8px);outline:none;background:var(--sh-input);color:var(--sh-text);font:13px/20px inherit}
[data-stage-handoff-input]::placeholder{color:var(--sh-tertiary)}
[data-stage-handoff-input]:hover:not(:disabled){border-color:var(--sh-accent)}
[data-stage-handoff-input]:focus{border-color:var(--sh-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--sh-accent) 22%,transparent)}
[data-stage-handoff-input]:disabled{color:var(--sh-tertiary);background:transparent;cursor:not-allowed}
[data-stage-handoff-input][aria-invalid="true"]{border-color:var(--sh-error);box-shadow:0 0 0 2px color-mix(in srgb,var(--sh-error) 18%,transparent)}
[data-stage-handoff-duration]{display:flex;align-items:center;gap:6px;min-width:0;flex:1}
[data-stage-handoff-duration] [data-stage-handoff-input]{flex:1;width:auto;min-width:0}
[data-stage-handoff-unit]{flex:none;height:34px;padding:0 8px;border:.5px solid var(--sh-border-strong);border-radius:var(--dsw-radius-md,8px);outline:none;background:var(--sh-input);color:var(--sh-text);font:13px/20px inherit;cursor:pointer}
[data-stage-handoff-unit]:hover:not(:disabled){border-color:var(--sh-accent)}
[data-stage-handoff-unit]:focus{border-color:var(--sh-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--sh-accent) 22%,transparent)}
[data-stage-handoff-unit]:disabled{color:var(--sh-tertiary);background:transparent;cursor:not-allowed}
[data-stage-handoff-select]{width:100%;height:34px;padding:0 10px;border:.5px solid var(--sh-border-strong);border-radius:var(--dsw-radius-md,8px);outline:none;background:var(--sh-input);color:var(--sh-text);font:13px/20px inherit;cursor:pointer}
[data-stage-handoff-select]:hover:not(:disabled){border-color:var(--sh-accent)}
[data-stage-handoff-select]:focus{border-color:var(--sh-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--sh-accent) 22%,transparent)}
[data-stage-handoff-select]:disabled{color:var(--sh-tertiary);background:transparent;cursor:not-allowed}
[data-stage-handoff-usage]{margin-top:10px;padding-top:9px;border-top:.5px solid var(--sh-border);display:flex;flex-direction:column;gap:3px;color:var(--sh-muted);font-size:12px;line-height:19px}
[data-stage-handoff-usage] [data-stage-handoff-spinner]{vertical-align:-1px;margin-right:2px}
[data-stage-handoff-usage-path]{color:var(--sh-tertiary);font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
[data-stage-handoff-error]{color:var(--sh-error);font-size:11px;line-height:17px}
[data-stage-handoff-reset]{flex:none;width:28px;height:34px;padding:0}
[data-stage-handoff-switch]{position:relative;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--sh-border-strong);cursor:pointer}
[data-stage-handoff-switch] span{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform 120ms ease}
[data-stage-handoff-switch][aria-checked="true"]{background:var(--sh-accent)}
[data-stage-handoff-switch][aria-checked="true"] span{transform:translateX(16px)}
[data-stage-handoff-switch]:disabled{opacity:.55;cursor:not-allowed}
[data-stage-handoff-presets]{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:9px}
[data-stage-handoff-preset]{height:29px;padding:0 11px;border:0;border-radius:999px;background:var(--sh-input);color:var(--sh-muted);font:12px/18px inherit;cursor:pointer;box-shadow:inset 0 0 0 .5px var(--sh-border-strong)}
[data-stage-handoff-preset]:hover:not(:disabled){color:var(--sh-text);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
[data-stage-handoff-preset][aria-pressed="true"]{color:var(--sh-text);box-shadow:inset 0 0 0 1px var(--sh-accent)}
[data-stage-handoff-suggestions]{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-left:0;flex-basis:100%}
[data-stage-handoff-suggestion]{height:26px;padding:0 8px;border:0;border-radius:6px;background:var(--sh-input);color:var(--sh-muted);font:11px/16px inherit;cursor:pointer;box-shadow:inset 0 0 0 .5px var(--sh-border-strong)}
[data-stage-handoff-suggestion]:hover:not(:disabled){color:var(--sh-text);box-shadow:inset 0 0 0 1px var(--sh-accent)}
[data-stage-handoff-suggestion]:disabled{opacity:.55;cursor:not-allowed}
[data-stage-handoff-warning]{color:var(--sh-error,#d9534f);font-weight:500}
[data-stage-handoff-preset]:disabled{opacity:.42;cursor:not-allowed}
[data-stage-handoff-advanced]{padding:0 4px}
[data-stage-handoff-advanced] summary{cursor:pointer;color:var(--sh-muted);font-size:12px;line-height:20px}
[data-stage-handoff-advanced] p{margin:7px 0 0;color:var(--sh-tertiary);font-size:12px;line-height:19px}
[data-stage-handoff-advanced] code{font:11px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--sh-muted)}
[data-stage-handoff-readonly]{margin:0;color:var(--sh-muted);font-size:12px;line-height:19px}
[data-stage-handoff-fixed]{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--dsw-radius-md,9px);background:var(--sh-fill);box-shadow:inset 0 0 0 .5px var(--sh-border);color:var(--sh-muted);font-size:12px;line-height:19px}
[data-stage-handoff-fixed] strong{display:block;color:var(--sh-text);font-size:13px;font-weight:550}
[data-stage-handoff-spinner]{width:11px;height:11px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;display:inline-block;flex:none;animation:stage-handoff-spin .8s linear infinite}
[data-stage-handoff-button]:focus-visible,[data-stage-handoff-tab]:focus-visible,[data-stage-handoff-preset]:focus-visible,[data-stage-handoff-switch]:focus-visible,[data-stage-handoff-reset]:focus-visible,[data-stage-handoff-unit]:focus-visible,[data-stage-handoff-select]:focus-visible{outline:2px solid var(--sh-accent);outline-offset:2px}
@keyframes stage-handoff-spin{to{transform:rotate(360deg)}}
@media (max-width:640px){
  [data-stage-handoff-hero]{flex-wrap:wrap}
  [data-stage-handoff-actions]{width:100%;padding-left:60px}
  [data-stage-handoff-stats]{grid-template-columns:1fr}
  [data-stage-handoff-row]{grid-template-columns:1fr;gap:8px}
  [data-stage-handoff-control]{max-width:100%}
}
@media (max-width:460px){
  [data-stage-handoff-actions]{padding-left:0}
  [data-stage-handoff-card]{padding:12px}
  [data-stage-handoff-tab]{padding:0 10px}
}
@media (prefers-reduced-motion:reduce){
  [data-stage-handoff-switch] span{transition:none}
  [data-stage-handoff-spinner]{animation-duration:2s}
}
`

    function installStyles(ctx) {
      if (typeof document === 'undefined' || typeof ctx?.effect !== 'function') return
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', 'dsh-stage-handoff')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'stage-handoff: settings styles')
    }

    /** 由 apply() 填入；formListeners 让晚到的 namespace 能触发 React 重渲染。 */
    let form = null
    const formListeners = new Set()

    function getForm() {
      return form
    }

    function subscribeForm(listener) {
      formListeners.add(listener)
      return () => formListeners.delete(listener)
    }

    function setForm(next) {
      if (form === next) return
      form = next
      for (const listener of formListeners) listener()
    }

    // ── 本地化 ────────────────────────────────────────────────────────────
    //
    // 插件清单的标题/简介走 package 的 `locale/*.json`（Host 侧读取），
    // 但面板正文是浏览器侧渲染的，那个通道看不到。这里用宿主提供的
    // `ctx.locale` 服务：`getLocale()` 读当前语言、`subscribe()` 在切换时
    // 触发重渲染。
    //
    // 刻意**不声明** `inject: ['locale']`：声明后一旦某个部署没有 locale
    // 插件，整个设置面板都不会加载。这里按可选服务处理，缺了就看
    // `navigator.language`，最坏情况退到中文原文。
    //
    // 注意：factory 的形参只有 `require`，**模块顶层没有 `ctx`**。本文件曾
    // 在这里写 `const localeFace = ctx?.locale`，结果是宿主一渲染设置页就
    // `ReferenceError: ctx is not defined`，面板静默空白 —— `node --check`
    // 和单测都发现不了（宿主是懒执行 factory 的）。改成 apply 时注入。
    let localeFace = null
    /** ctx 的引用，用于渲染时补读晚到的 locale 服务。 */
    let localeCtx = null
    /** 语言是从哪来的：诊断用，面板里会显示一行。 */
    let localeOrigin = 'pending'
    /**
     * 当前 locale 服务。已声明 inject: ['locale']，正常情况 apply 时就绪；
     * 补读是为了防「服务在极早期被替换/晚注册」这种边角情况。
     */
    const currentLocaleFace = () => {
      if (localeFace !== null) return localeFace
      if (localeCtx === null) return null
      try {
        const late = typeof localeCtx.get === 'function' ? localeCtx.get('locale') : undefined
        if (late !== undefined && late !== null) {
          localeFace = late
          localeOrigin = "ctx.get('locale')（补读）"
          return late
        }
      } catch {
        // 读不到就继续用 navigator
      }
      return null
    }
    const isChinese = () => {
      const active = currentLocaleFace()?.getLocale?.()?.active
      if (typeof active === 'string' && active.length > 0) return /^zh\b/i.test(active) || /^zh[-_]/i.test(active)
      if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
        return /^zh/i.test(navigator.language)
      }
      return true
    }

    /** 按当前语言二选一；缺英文时退回中文原文，界面不会出现空串。 */
    function pick(zh, en) {
      return isChinese() ? zh : en ?? zh
    }

    /**
     * 零散文案的英译表，key 是中文原文。
     *
     * 用原文当 key 而不是发明 `hero.title` 之类的键：文案就写在调用点旁边，
     * 加一条翻译只需要在表里补一行，读到某处时也不用跳去别处找键名。
     */
    const EN = {
      // ── 面板骨架 ──
      '阶段收尾与锚点接力': 'Stage handoff and anchor carry-over',
      '到线时提醒 agent 先写详细文档与精简锚点，再按 auto 力度压缩历史。':
        'At the threshold, remind the agent to write the detail document and a concise anchor, then compact while keeping the automatic engine’s retention budget.',
      'Host 已连接 · 实时生效': 'Host connected · live',
      '只读预览': 'Read-only preview',
      '入口已停用 · 配置可编辑': 'Entry disabled · config still editable',
      '使用默认配置': 'Using defaults',
      '复制当前 Stage Handoff 配置 YAML': 'Copy the current Stage Handoff config as YAML',
      '复制中': 'Copying',
      '复制 YAML': 'Copy YAML',
      '已启用': 'Enabled',
      '已停用': 'Disabled',
      'Host 入口已启用': 'Host entry enabled',
      'Host 入口已停用': 'Host entry disabled',
      '启停会改变整条 Host 入口，需编辑 profile 的 cordis.patch.yml 并重启 DSH。':
        'Toggling changes the whole Host entry: edit cordis.patch.yml in the profile and restart DSH.',
      '只读模式：配置值来自当前 Host 快照。':
        'Read-only: values come from the current Host snapshot.',
      'Stage Handoff 设置分组': 'Stage Handoff settings groups',
      'Stage Handoff 只读配置': 'Stage Handoff read-only configuration',
      '运行与排障命令': 'Runtime and troubleshooting commands',
      '查看当前提醒线和占用；': ' shows the current reminder line and usage;',
      '查看锚点与会话占用；': ' shows anchor and session sizes;',
      '对账最近一次压缩摘要。': ' reconciles the latest compaction summary.',
      '当前展示与代码一致的默认值。': ' Showing defaults that match the code.',
      '面板语言：{lang} · 来源 {origin}': 'Panel language: {lang} · from {origin}',
      '中文': 'Chinese',
      '英文': 'English',

      // ── 摘要与统计卡 ──
      '提醒线': 'Reminder line',
      '尾部逐字保留': 'Verbatim tail',
      '锚点目录': 'Anchor directory',
      '正在统计体积…': 'Measuring sizes…',
      '体积统计不可用：{detail}（入口停用时这个路由不会注册）':
        'Usage unavailable: {detail} (the route is not registered while the entry is disabled)',
      '体积统计不可用：{detail}': 'Usage unavailable: {detail}',
      '会话存储 {bytes} · {count} 个会话': 'Session store {bytes} · {count} session(s)',
      '会话存储不可读：{reason}': 'Session store unreadable: {reason}',
      '未知读取错误': 'unknown read error',
      '会话存储：未配置 DSH_HOME（可选的体积统计，不影响收尾提醒）':
        'Session store: DSH_HOME is not configured (optional size reporting; close-out reminders are unaffected)',
      '会话存储：{root} 下没有 sessions 目录': 'Session store: no sessions directory under {root}',
      '工作区 {index}': 'Workspace {index}',
      '锚点': 'Anchor',
      '{prefix}：{bytes} · {files} 个文件': '{prefix}: {bytes} · {files} file(s)',
      '{prefix}不可读或未统计完整：{reason}': '{prefix} unreadable or incomplete: {reason}',
      '未知原因': 'unknown reason',
      '{prefix}：锚点目录还不存在': '{prefix}: the anchor directory does not exist yet',
      '项目：{workspace} · 锚点：{root}': 'Project: {workspace} · anchor: {root}',
      '会话：{root}': 'Sessions: {root}',
      '（未配置）': '(not configured)',
      '（未配置 DSH_HOME）': '(DSH_HOME not configured)',
      '统计不完整：标「不可读」的行没有可用数字，其余带数字的行是下限':
        'Incomplete: rows marked “unreadable” have no numbers; the numbers shown elsewhere are lower bounds',
      '；活动工作区超过 {max} 个，只显示前 {max} 个':
        '; more than {max} active workspaces, showing the first {max}',
      '若干': 'several',

      // ── 字段行与小控件 ──
      '已自定义': 'Customized',
      '固定': 'Fixed',
      '只读': 'Read-only',
      '开启': 'On',
      '关闭': 'Off',
      // 前导空格是文案本身的一部分（用来和前面的元素拉开距离），
      // 所以 key 也必须带空格，否则英文界面下会漏译成中文。
      ' 默认：{value}': ' Default: {value}',
      '当前值 · {value}': 'Current value · {value}',
      '恢复 {label} 的默认值': 'Restore the default for {label}',
      '{label}数值': '{label} value',
      '{label}单位': '{label} unit',
      '{count} 项已自定义': '{count} customized',
      '请填非负整数，单位在右侧下拉里选（字节 / KiB / MiB / GiB）；换算后不能超过 {max}':
        'Enter a non-negative integer and pick the unit on the right (bytes / KiB / MiB / GiB); the result must not exceed {max}',
      ' 保存中': ' Saving',
      ' 正在保存…': ' Saving…',
      '保存失败，已保持原值。': 'Save failed; the previous value is kept.',

      // ── 快捷方案 ──
      '快捷方案': 'Presets',
      '按模型上下文窗口调整提醒线、逐字保留与锚点上限；其他字段保持不变。':
        'Scales the reminder line, verbatim retention and anchor limit to the model context window; other fields stay as they are.',
      '套用 {title} 推荐值': 'Apply recommended values for {title}',

      // ── 状态栏与错误 ──
      '自动保存已开启 · 失焦或按 Enter 写入 Host':
        'Autosave on · blur or press Enter to write to the Host',
      '入口已停用：保存只改配置，重启 DSH 后才会重新挂载':
        'Entry disabled: saving only changes the config; it remounts after a DSH restart',
      '当前部署把你的配置暴露为只读。': 'This deployment exposes your config as read-only.',
      '正在保存 {label}…': ' Saving {label}…',
      '正在保存 {count} 项（含 {label}）…': ' Saving {count} field(s) (including {label})…',
      'Host 拒绝了这次修改，请检查值或重新打开设置页。':
        'The Host rejected this change; check the value or reopen this page.',
      '写入失败：{message}': 'Write failed: {message}',
      'Stage Handoff 设置': 'Stage Handoff settings',
      '已恢复默认 · {label}': 'Restored default · {label}',
      '已恢复 {title} 默认值': 'Restored the defaults for {title}',
      '当前 Host 不支持批量写入（configForms.mutate 缺失），请逐项修改。':
        'This Host cannot write several fields at once (configForms.mutate is missing); change them one by one.',
      '已保存 · {label}': 'Saved · {label}',
      '已套用 {title} 推荐值': 'Applied the recommended values for {title}',
      '保存失败，输入已恢复为当前运行值。':
        'Save failed; the input was restored to the running value.',
      '未知错误': 'unknown error',
      '当前 DSH 没有向客户端暴露这个设置命名空间。':
        'This DSH deployment does not expose this settings namespace to the client.',

      // ── 字段校验 ──
      '不能为空': 'Cannot be empty',
      '不能包含 .. 路径段': 'Must not contain a ".." path segment',
      '不能包含控制字符（如制表符）':
        'Must not contain control characters (such as tabs)',
      '必须填绝对路径（Windows 如 D:/dsh-data，Linux/macOS 如 /var/lib/dsh），或留空读环境变量 DSH_HOME':
        'Must be an absolute path (e.g. D:/dsh-data on Windows, /var/lib/dsh on Linux and macOS), or leave it empty to read DSH_HOME',
      '需要整数': 'Must be an integer',
      '不能小于 {min}': 'Must not be less than {min}',
      '不能大于 {max}': 'Must not be greater than {max}',
      '数字偏移必须是 -720..840 的整数分钟':
        'A numeric offset must be an integer number of minutes between -720 and 840',
      '填 local / utc / z，或 +8 / -5 / +05:30 / -300 这类偏移或分钟数':
        'Use local / utc / z, or an offset or minute count such as +8 / -5 / +05:30 / -300',
      '填 local / utc / z，或 +8 / -5 / +05:30（小时偏移），或 -300 这类整数分钟':
        'Use local / utc / z, or an hour offset such as +8 / -5 / +05:30, or an integer minute count such as -300',
      '请填非负整数，单位在右侧下拉里选；换算后不能超过 {max}':
        'Enter a non-negative integer and pick the unit on the right; the converted value must not exceed {max}',
      '格式不对，例如 300k / 1m / 400000；结果必须是正整数':
        'Wrong format — try 300k / 1m / 400000; the result must be a positive integer',
      '结果不能大于 {max}（例：300k / 1m / 400000）':
        'The result must not exceed {max} (for example: 300k / 1m / 400000)',
      '请填 {min}..{max} 的整数': 'Enter an integer between {min} and {max}',
      '请输入文本': 'Enter text',

      // ── 零散 ──
      '{value} 分钟': '{value} minutes',
      '（空）': '(empty)',
      '毫秒': 'ms',
      '复制失败：{message}': 'Copy failed: {message}',
      '当前浏览器不允许写剪贴板。': 'This browser does not allow clipboard writes.',
      '已复制当前配置 YAML。': 'Copied the current config YAML.',
      '正在读取 Stage Handoff 配置…': ' Reading the Stage Handoff configuration…',
      '读取超过 5 秒仍未完成。Host 端的设置镜像可能没有就绪。':
        'Still not loaded after 5 seconds. The Host-side settings mirror may not be ready.',
      '这个 namespace 没有暴露给当前客户端，无法读取或修改。':
        'This namespace is not exposed to this client, so it cannot be read or modified.',
      '推荐方案': 'Recommended',
    }

    /** 翻译一整个中文句子；表里没有就原样返回。 */
    function t(zh) {
      if (isChinese()) return zh
      return EN[zh] ?? zh
    }

    /**
     * 带 `{name}` 占位符的版本：先取模板，再替换变量。
     *
     * `vars` 必须有默认值。少传一个参数就会在 `Object.entries(undefined)` 上抛
     * "Cannot convert undefined or null to object"，而调用点在渲染树里 ——
     * 后果不是这一行没了，是**整片面板空白**（React 把失败的子树整个卸掉）。
     * 真实事故：`tf(' 保存中')` 漏了参数，于是任何字段一保存、该行进入 busy
     * 分支，面板就白了。
     */
    function tf(zh, vars = {}) {
      let text = t(zh)
      for (const [key, value] of Object.entries(vars ?? {})) {
        text = text.split(`{${key}}`).join(String(value))
      }
      return text
    }

    /** 订阅 locale 变化；没有 locale 服务时返回常量，不订阅。 */
    function subscribeLocale(listener) {
      const face = currentLocaleFace()
      if (typeof face?.subscribe !== 'function') return () => {}
      return face.subscribe(listener)
    }
    const localeRevision = () => currentLocaleFace()?.getSnapshot?.()?.revision ?? 0
    const zeroRevision = () => 0

    /** 没有 form 时用的静态默认值，与 lib/config.js 保持一致。 */
    const FALLBACK = {
      enabled: true,
      notifyTokens: 363520,
      notifyRepeatDelta: 25000,
      notifyCooldownMs: 300000,
      notifyOnTurnStartOnly: true,
      // 这两个键以前漏了：面板既看不到也改不了，而「复制 YAML」只遍历
      // Object.keys(FALLBACK)，于是把它们从配置里**静默抹掉**。
      // 任何人曾把 reportToolFacts 设为 false，复制一次 YAML 就会变回 true。
      notifySkipWhenToolPending: true,
      notifyAfterCompaction: true,
      reportToolFacts: true,
      compactRetainTokens: 32000,
      compactCooldownMs: 60000,
      hostMaxTokens: 256000,
      agentDecidesCompaction: true,
      // 必须与 `config.js` 的 `DEFAULT_STREAM_GUARD`（true）一致。这里写成 false 过：
      // Host 没暴露 configForms 时面板只读显示、以及「恢复默认」，都会把守卫显示成
      // 「关闭」并自称「与代码一致的默认值」，而代码里它是开着的。
      // `test/index.test.mjs` 现在逐键比值，不只比键有没有出现。
      streamGuard: true,
      rejectOnRepeat: false,
      keepAnchorBackups: 3,
      guardMaxBytes: 1048576,
      staleReservationTtlMs: 86400000,
      anchorRoot: 'docs/anchors',
      anchorTimeZone: 'local',
      anchorLimitChars: 8000,
      dshHome: '',
    }

    /** 字段元数据：分组、类型、说明。顺序即渲染顺序。 */
    const FIELDS = [
      {
        group: '运行',
        groupEn: 'Runtime',
        groupHint: 'Host 入口的启停会改变整个插件是否挂载，因此不在运行中的自身设置页里切换。',
        groupHintEn:
          'Starting or stopping the Host entry decides whether the whole plugin mounts, so it cannot be switched from this page while the plugin is running.',
        items: [
          {
            key: 'enabled',
            label: '插件开关',
            labelEn: 'Plugin enabled',
            type: 'boolean',
            fixed: '需编辑 profile 的 cordis.patch.yml 并重启 DSH。',
            fixedEn: 'Edit cordis.patch.yml in the profile and restart DSH.',
            hint: '关闭后提醒、工具与自动压缩都不生效；当前运行实例仍保留入口。',
            hintEn:
              'When off, reminders, tools and automatic compaction are inactive; the running instance keeps its entries registered.',
          },
        ],
      },
      {
        group: '提醒',
        groupEn: 'Reminders',
        groupHint: '上下文到线时提醒 agent 先写详细文档与精简锚点，再压缩历史。',
        groupHintEn:
          'At the threshold, remind the agent to write the detail document and a concise anchor before compacting the history.',
        items: [
          {
            key: 'notifyTokens',
            label: '触发阈值',
            labelEn: 'Trigger threshold',
            type: 'tokens',
            min: 1,
            hint: '上下文达到多少 tokens 时提醒。支持 300k / 1m 写法。',
            hintEn: 'Context size in tokens that triggers the reminder. Accepts 300k / 1m.',
          },
          {
            key: 'notifyRepeatDelta',
            label: '重复增长量',
            labelEn: 'Repeat delta',
            type: 'number',
            min: 1,
            hint: '再次提醒所需的增量。太小会被一段忙碌的工作一口气顶过。',
            hintEn:
              'Growth needed before reminding again. Too small, and one busy stretch blows past it without notice.',
          },
          {
            key: 'notifyCooldownMs',
            label: '重复最小间隔',
            labelEn: 'Minimum repeat interval',
            type: 'duration',
            min: 0,
            hint: '两次提醒之间的实际时间下限，与增长量是「与」关系。0 关闭。',
            hintEn:
              'Lower bound on wall-clock time between reminders, ANDed with the delta. 0 disables it.',
          },
          {
            key: 'notifyOnTurnStartOnly',
            label: '只在轮次开始时提醒',
            labelEn: 'Only at turn start',
            type: 'boolean',
            hint: '开启后不会在同一轮的第 2、3… 步里突然插话。',
            hintEn: 'On: never interrupts the 2nd, 3rd… step of the same turn.',
          },
          {
            key: 'notifySkipWhenToolPending',
            label: '等工具返回后再提醒',
            labelEn: 'Wait for tool results',
            type: 'boolean',
            hint: '还有工具调用没拿到结果时跳过提醒。跳过不消耗配额：这一轮走完仍过线会照常提醒。',
            hintEn:
              'Skip the reminder while a tool call has no result yet. A skip costs no quota: still above the line after this turn, it reminds as usual.',
          },
          {
            key: 'notifyAfterCompaction',
            label: '压缩后先读锚点',
            labelEn: 'Read the anchor after compaction',
            type: 'boolean',
            hint: '压缩成功后的第一次进入注入一条提醒：摘要看不到被保留的尾部，Next Step 可能已过期。不消耗提醒配额。',
            hintEn:
              'One notice at the first step after a successful compaction: the summary cannot see the retained tail, so its Next Step may be stale. Costs no reminder quota.',
          },
        ],
      },
      {
        group: '压缩',
        groupEn: 'Compaction',
        groupHint: '沿用 DSH 自动压缩引擎，只调整压缩时机与保留力度。',
        groupHintEn:
          "Reuses DSH's own compaction engine; only the timing and the retention are adjusted.",
        items: [
          {
            key: 'compactRetainTokens',
            label: '尾部逐字保留',
            labelEn: 'Verbatim tail retention',
            type: 'number',
            min: 1,
            hint: '压缩时原样保留的尾部大小。默认 32,000（中文内容下实际约 50k）。保留越多，摘要里过期的 Next Step 与尾部原文冲突的面积越大。',
            hintEn:
              'How much tail is kept word for word. Default 32,000 (roughly 50k of real tokens for Chinese text). The larger it is, the more room a stale Next Step has to contradict the retained text.',
          },
          {
            key: 'compactCooldownMs',
            label: '压缩冷却',
            labelEn: 'Compaction cooldown',
            type: 'duration',
            min: 0,
            hint: '两次压缩之间的最小间隔，防止连续触发把上下文压到没法干活。',
            hintEn:
              'Minimum interval between compactions, so a burst cannot grind the context down to where work is impossible.',
          },
          {
            key: 'hostMaxTokens',
            label: '宿主输出预留（maxTokens）',
            labelEn: 'Host output reserve (maxTokens)',
            type: 'number',
            min: 1,
            hint: '宿主模型为单回合输出预留的 token 数。宿主压缩墙 = min(窗口 × 0.8, 窗口 − 该值 − 65,536)，还要满足 derive 保留量 < 墙。填 auto 让插件向宿主查（agent 的输出上限 → 模型声明的 defaultMaxTokens → 256,000）。注意 256,000 是十进制 256K，不是 262,144。',
            hintEn:
              "Tokens the host model reserves for one turn's output. The host compaction wall is min(window × 0.8, window − this − 65,536), additionally requiring the derivation retain to stay below the wall. Set `auto` to ask the host instead (agent output cap → model's declared defaultMaxTokens → 256,000). Note 256,000 is decimal 256K, not 262,144.",
            warning: '调大会让墙后退、提醒线更容易越过它；调小会提前压缩。256k 窗口必须把它降到 196,608 以下才能压（实际填模型的真实输出上限，常见 131,072）。',
            warningEn:
              'Raising it pushes the wall later and makes the reminder line more likely to overshoot; lowering it compacts earlier. A 256k window needs this below 196,608 or the host errors out.',
            suggestions: [
              { label: 'auto', labelEn: 'auto', value: 'auto', hint: '让插件向宿主查询当前模型的输出上限', hintEn: "Ask the host for the current model's output cap" },
              { label: '256k', labelEn: '256k', value: 256000, hint: 'DeepSeek 系默认输出上限', hintEn: 'DeepSeek default output cap' },
              { label: '128k', labelEn: '128k', value: 131072, hint: '输出上限 128k 的模型（256k 窗口必须用这个）', hintEn: 'Models capped at 128k output (required for a 256k window)' },
              { label: '64k', labelEn: '64k', value: 65536, hint: '小输出预算的模型', hintEn: 'Models with a small output budget' },
            ],
          },
          {
            key: 'agentDecidesCompaction',
            label: '由 agent 自主决策',
            labelEn: 'Agent decides',
            type: 'boolean',
            hint: '关闭时到线就自动压缩一次（提醒照发）。开启时只提醒，压不压由 agent 决定。',
            hintEn:
              'Off: compact once at the threshold (the reminder still fires). On: only remind, and the agent decides whether to compact.',
          },
          {
            key: 'streamGuard',
            label: '流式复读守卫（试验性）',
            labelEn: 'Stream repeat guard (experimental)',
            type: 'boolean',
            hint: '生成过程中观察思考尾部：同一片段连续重复 ≥5 遍、覆盖 ≥200 字符，就在下一个 step 提醒一句，比等这轮结束再扫早一整轮。只提醒、从不截断——判据在合法长回答上也会触发，拿来当停止条件会掐断正常输出。默认开启，可在本开关关掉。',
            hintEn:
              'Watches the reasoning tail while it is being generated: five or more consecutive repeats of one fragment covering ≥200 characters produces a single reminder at the next step, one step earlier than scanning after the turn. Reports only, never truncates — the criterion also fires on legitimate long answers, so using it as a stop condition would cut off normal output. On by default; this switch turns it off.',
          },
          {
            key: 'rejectOnRepeat',
            label: '复读时直接中断这一轮',
            labelEn: 'Stop the turn on repetition',
            type: 'boolean',
            hint: '默认关闭，且这是破坏性动作：DSH 的 reject 会把整个 turn 标成 blocked 并当场结束，不是跳过这一步。只在「一行占满整个思考窗口」时触发。开它的理由：单纯提醒实测只有约两成生效；关它的理由：判据还不够准，误判一次就中断一次。',
            hintEn:
              'Off by default, and destructive: DSH reject marks the whole turn blocked and ends it on the spot — it does not skip the step. Only fires when one row fills the entire reasoning window. Why it exists: a plain reminder measured at roughly 20% effective. Why it is off: the criteria are not accurate enough to interrupt on, and one false positive interrupts one turn.',
          },
        ],
      },
      {
        group: '锚点',
        groupEn: 'Anchors',
        groupHint: '锚点是阶段交接物，人类可读可审阅的 markdown。',
        groupHintEn: 'An anchor is the stage handoff: human-readable, reviewable markdown.',
        items: [
          {
            key: 'anchorRoot',
            label: '锚点目录',
            labelEn: 'Anchor directory',
            type: 'text',
            placeholder: 'docs/anchors',
            hint: '相对项目根；绝对路径也可。Host 会拒绝包含 .. 的路径段。',
            hintEn:
              'Relative to the project root; absolute paths work too. The Host rejects path segments containing "..".',
          },
          {
            key: 'anchorTimeZone',
            label: '命名时区',
            labelEn: 'Naming time zone',
            type: 'select',
            options: timeZoneOptions(),
            hint: '阶段目录名里的时间按哪个时区算。local 用本机时钟（随夏令时变化），固定偏移不会；列表外的偏移仍可在 YAML 里写分钟数。',
            hintEn:
              'Which zone the stage directory timestamp uses. local follows the machine clock (daylight saving included); fixed offsets do not. Off-list offsets can still be written as minutes in YAML.',
          },
          {
            key: 'anchorLimitChars',
            label: '锚点软上限',
            labelEn: 'Anchor soft limit',
            type: 'number',
            min: 1,
            hint: 'anchor.md 超过这个字符数就该归档到 parent-backup/ 并重写精简版。',
            hintEn:
              'Once anchor.md exceeds this many characters it should be archived into parent-backup/ and rewritten as a compact version.',
          },
          {
            key: 'keepAnchorBackups',
            label: '保留备份数',
            labelEn: 'Backups to keep',
            type: 'number',
            min: 0,
            hint: 'cleanup 建议保留几个最新备份；只列清单，从不删除。',
            hintEn:
              'How many newest backups cleanup suggests keeping. It only lists candidates; it never deletes.',
          },
          {
            key: 'guardMaxBytes',
            label: 'guard 基线上限（字节）',
            labelEn: 'Guard baseline cap (bytes)',
            // 字节字段走「数值 + 单位（字节/KiB/MiB/GiB）」：默认值 1,048,576 让人
            // 自己数零不现实，而填错一个零就是 16 倍偏差。
            type: 'bytes',
            min: 65536,
            max: 16777216,
            hint: '默认 1 MiB（与安全读上限一致）。调大会放宽有界读取的保证；超过这个值的锚点将无法建立基线。写入与读取始终用同一个值，不存在「写得出、读不回」。除非确实需要，否则别动。',
            hintEn:
              'Default 1 MiB, the same as the safe-read limit. Raising it widens the bounded-read guarantee; an anchor above it cannot get a baseline. Write and read always use the same value, so "written but unreadable" cannot happen. Leave it alone unless you must.',
          },
          {
            key: 'staleReservationTtlMs',
            label: '阶段预留有效期（毫秒）',
            labelEn: 'Stage reservation TTL (ms)',
            // 毫秒字段走「数值 + 单位（天/小时/分钟/秒/毫秒）」：默认 1 天现在显示成
            // 「1 天」，不用手写 86400000。上界 7 天 = 604800000 毫秒。
            type: 'duration',
            min: 60000,
            max: 604800000,
            hint: '默认 1 天（86400000），上限 7 天。scaffold 崩溃后留下的预留记录超过这个时长就按过期回收；调小会让长任务更容易被误回收，调大则 pid 复用后可能要等更久才能重建同名阶段。',
            hintEn:
              'Default 1 day (86400000), max 7 days. A reservation left by a crashed scaffold is reclaimed after this long; smaller reclaims sooner but may mistake a long task for a dead one, larger keeps the stage name blocked longer after a crash.',
          },
        ],
      },
      {
        group: '存储',
        groupEn: 'Storage',
        groupHint: '用于统计会话在本机的落盘体积，以及从工具调用里机械推导入口。',
        groupHintEn:
          'Sizes the on-disk session store, and derives entry points mechanically from tool calls.',
        items: [
          {
            key: 'dshHome',
            label: 'DSH_HOME',
            labelEn: 'DSH_HOME',
            type: 'text',
            placeholder: '留空则自动读环境变量 DSH_HOME',
            placeholderEn: 'Empty reads the DSH_HOME environment variable',
            hint: '留空则读环境变量。只统计文件大小，不读内容。',
            hintEn:
              'Empty reads the environment variable. Only file sizes are measured; contents are never read.',
          },
          {
            key: 'reportToolFacts',
            label: '从工具调用推导入口',
            labelEn: 'Derive entry points from tool calls',
            type: 'boolean',
            hint: '控制 status 与 scaffold 是否展示机械推导的文件/命令；关闭只影响展示，摘要回读与工具配对仍会观察会话事件。',
            hintEn:
              'Whether status and scaffold show the mechanically derived files and commands. Turning it off only affects display; summary lookback and tool pairing still observe session events.',
          },
        ],
      },
    ]

    const FIELD_GROUPS = FIELDS.slice(1)
    // 字段元数据自带英文：`label`/`hint`/`fixed`/`placeholder` 是中文原文，加
    // `…En` 后缀就是英文。集中在这四个 helper 里二选一，组件内不散落 pick 调用。
    const labelOf = (item) => pick(item.label, item.labelEn)
    const hintOf = (item) => pick(item.hint, item.hintEn)
    const placeholderOf = (item) => pick(item.placeholder, item.placeholderEn)
    const groupTitleOf = (group) => pick(group.group, group.groupEn)
    const groupHintOf = (group) => pick(group.groupHint, group.groupHintEn)
    const TABS = [
      { id: 'reminder', label: '提醒', labelEn: 'Reminders', groups: ['提醒'] },
      { id: 'compaction', label: '压缩', labelEn: 'Compaction', groups: ['压缩'] },
      {
        id: 'files',
        label: '锚点与存储',
        labelEn: 'Anchors & storage',
        groups: ['锚点', '存储'],
      },
    ]
    const PRESETS = [
      {
        id: '256k',
        label: '256k 小窗',
        labelEn: '256k (small)',
        title: '256k 上下文窗口（会同时把输出预留降到 128k，否则这个窗口根本压不了）',
        titleEn: '256k context window (also lowers the output reserve to 128k — without that this window cannot compact at all)',
        // 提醒线 = 宿主墙 × 0.5。256k 窗口在默认 hostMaxTokens=256,000 下压力预算为负
        // （262,144 − 256,000 − 65,536 < 0），宿主会直接抛 TargetPressureConfigError。
        // 所以这一档必须连 hostMaxTokens 一起写：降到 131,072 后墙 = 65,536，
        // 提醒线 = 32,768，收尾空间同样是墙的一半。
        // anchorLimitChars 不跟着缩 —— 它是给人读的文档长度，不是 token 预算。
        values: {
          notifyTokens: 32768,
          compactRetainTokens: 8192,
          anchorLimitChars: 4000,
          hostMaxTokens: 131072,
        },
      },
      {
        id: '512k',
        label: '512k 中窗',
        labelEn: '512k (medium)',
        title: '512k 上下文窗口',
        titleEn: '512k context window',
        // 524,288 窗口、输出预留 256,000 时墙 = 202,752，提醒线 = 101,376。
        // 旧值 184,000 是「按 1M 的 36% 等比缩小」算出来的，比墙的 90% 还高 ——
        // 那意味着提醒几乎永远发不出来。
        // 每档都必须**显式写** hostMaxTokens，包括等于默认值的那两档。
        // 少了它会出现残留：先点 256k 档（写入 131,072）再点 1M 档，131,072 留着，
        // 于是 1M 的墙变成 838,860，那份 363,520 就不再是「墙的一半」而是 43%。
        // 预设的语义是「一键得到一套自洽的配置」，所以四键要么一起写、要么都不写。
        values: { notifyTokens: 101376, compactRetainTokens: 16000, anchorLimitChars: 6000, hostMaxTokens: 256000 },
      },
      {
        id: '1m',
        label: '1M 大窗',
        labelEn: '1M (large)',
        title: '1M 上下文窗口',
        titleEn: '1M context window',
        // 基准档。1,048,576 窗口、输出预留 256,000 时墙 = 727,040（69.3%），
        // 提醒线取它的一半 363,520，到墙还有一半空间留给收尾。
        values: { notifyTokens: 363520, compactRetainTokens: 32000, anchorLimitChars: 8000, hostMaxTokens: 256000 },
      },
    ]

    function Icon({ name }) {
      const paths = {
        anchor: 'M8 2.5v8.8M5.5 5.2h5M3 9.2c.4 2.4 2.1 4 5 4s4.6-1.6 5-4M3 9.2h2M13 9.2h-2',
        copy: 'M5.5 5.5v-2h7v7h-2M3.5 5.5h7v7h-7z',
        reset: 'M4 5.4A4.6 4.6 0 1 1 3.5 9M4 2.8v2.8h2.8',
      }
      return h(
        'svg',
        {
          'data-stage-handoff-ico': '',
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('path', {
          d: paths[name],
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function Spinner() {
      return h('span', { 'data-stage-handoff-spinner': '', 'aria-hidden': 'true' })
    }

    // STAGE_HANDOFF_CLIENT_PARSE_BEGIN
    // Keep this declaration and the parser functions in the executable test
    // block so the browser and Host cannot drift on their shared upper bound.
    const MAX_CONFIG_INTEGER = 1000000000

    /** 时长字段的可选单位。顺序即「单位」下拉的显示顺序。 */
    const DURATION_UNITS = [
      { id: 'd', label: '天', labelEn: 'days', ms: 86400000 },
      { id: 'h', label: '小时', labelEn: 'hours', ms: 3600000 },
      { id: 'm', label: '分钟', labelEn: 'minutes', ms: 60000 },
      { id: 's', label: '秒', labelEn: 'seconds', ms: 1000 },
      { id: 'ms', label: '毫秒', labelEn: 'ms', ms: 1 },
    ]

    const DURATION_UNIT_FACTORS = Object.fromEntries(
      DURATION_UNITS.map((unit) => [unit.id, unit.ms]),
    )

    const DURATION_ALIAS = {
      小时: 'h',
      时: 'h',
      分钟: 'm',
      分: 'm',
      秒钟: 's',
      秒: 's',
      毫秒: 'ms',
    }

    /**
     * 把毫秒拆成「数值 + 单位」，供「数字框 + 单位下拉」渲染。
     * 取能整除的最大单位；都不整除时退回毫秒，绝不丢精度。
     */
    /**
     * 字节字段的可选单位。顺序即「单位」下拉的显示顺序，也决定
     * {@link splitBytes} 挑哪个单位显示：从上往下第一个能整除的赢，所以 1 MiB
     * 显示成「1 MiB」而不是「1048576 字节」。
     */
    const BYTE_UNITS = [
      { id: 'gib', label: 'GiB', labelEn: 'GiB', bytes: 1073741824 },
      { id: 'mib', label: 'MiB', labelEn: 'MiB', bytes: 1048576 },
      { id: 'kib', label: 'KiB', labelEn: 'KiB', bytes: 1024 },
      { id: 'b', label: '字节', labelEn: 'bytes', bytes: 1 },
    ]

    const BYTE_UNIT_FACTORS = Object.fromEntries(
      BYTE_UNITS.map((unit) => [unit.id, unit.bytes]),
    )

    /** 单位表按字段类型选：字节字段走 BYTE_UNITS，其余（时长）走 DURATION_UNITS。 */
    const unitTableOf = (item) => (item.type === 'bytes' ? BYTE_UNITS : DURATION_UNITS)

    /** 把字段值拆成「数值 + 单位」，两种单位字段共用一条渲染路径。 */
    function splitUnitValue(item, value) {
      if (item.type === 'bytes') return splitBytes(value)
      return splitDuration(value)
    }

    /** 把「数值 + 单位」换算回字段的规范单位（字节 / 毫秒）。 */
    function coerceUnitValue(item, amountText, unit) {
      if (item.type === 'bytes') return coerceBytes(amountText, unit)
      return coerceDuration(amountText, unit)
    }

    /** 数值框 + 单位下拉的字段类型。两者渲染逻辑完全一致，只是单位表不同。 */
    const isUnitField = (item) => item.type === 'duration' || item.type === 'bytes'

    function splitDuration(ms) {
      const value =
        typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0
      if (value === 0) return { amount: 0, unit: 'm' }
      for (const unit of DURATION_UNITS) {
        if (unit.ms > 1 && value % unit.ms === 0) return { amount: value / unit.ms, unit: unit.id }
      }
      return { amount: value, unit: 'ms' }
    }

    /** 人类可读时长，用于 hint 里的「默认：…」。 */
    function formatDuration(ms) {
      if (typeof ms !== 'number') return String(ms)
      if (ms === 0) return t('关闭')
      const { amount, unit } = splitDuration(ms)
      const row = DURATION_UNITS.find((entry) => entry.id === unit)
      const label = row === undefined ? t('毫秒') : pick(row.label, row.labelEn)
      return `${amount} ${label}`
    }

    /** 单位下拉提交时的换算；单位由控件给出，不存在歧义。 */
    function coerceDuration(amountText, unit) {
      const text = String(amountText).trim()
      if (!/^\d+$/.test(text)) return null
      const amount = Number(text)
      if (!Number.isFinite(amount) || amount < 0) return null
      const factor = DURATION_UNIT_FACTORS[unit]
      if (factor === undefined) return null
      const resolved = Math.round(amount * factor)
      return Number.isSafeInteger(resolved) && resolved >= 0 && resolved <= MAX_CONFIG_INTEGER
        ? resolved
        : null
    }

    /**
     * 把字节数拆成「数值 + 单位」。
     *
     * 与 {@link splitDuration} 同一策略：挑能整除的最大单位，全都不整除就退回
     * 字节。所以 `guardMaxBytes` 的默认值 1,048,576 显示成「1 MiB」，用户不用
     * 自己数零。
     */
    function splitBytes(value) {
      const size =
        typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
      if (size === 0) return { amount: 0, unit: 'mib' }
      for (const unit of BYTE_UNITS) {
        if (unit.bytes > 1 && size % unit.bytes === 0) {
          return { amount: size / unit.bytes, unit: unit.id }
        }
      }
      return { amount: size, unit: 'b' }
    }

    function coerceBytes(amountText, unit) {
      const text = String(amountText).trim()
      if (!/^\d+$/.test(text)) return null
      const amount = Number(text)
      if (!Number.isFinite(amount) || amount < 0) return null
      const factor = BYTE_UNIT_FACTORS[unit]
      if (factor === undefined) return null
      const resolved = Math.round(amount * factor)
      return Number.isSafeInteger(resolved) && resolved >= 0 && resolved <= MAX_CONFIG_INTEGER
        ? resolved
        : null
    }

    function formatTokens(value) {
      if (typeof value !== 'number') return String(value)
      if (value >= 1048576 && value % 1048576 === 0) return `${value / 1048576}m`
      if (value >= 1024 && value % 1024 === 0) return `${value / 1024}k`
      return String(value)
    }

    /** 字节数的人类可读形式，与 lib/usage.js 的 formatBytes 保持同一口径。 */
    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
      if (value < 1024) return `${value} B`
      const units = ['kB', 'MB', 'GB', 'TB']
      let scaled = value / 1024
      let index = 0
      // 与 lib/usage.js 同一处修正：先按显示精度取整再判晋级，否则 1,048,570 B 会
      // 显示成「1024.0 kB」。
      while (Number(scaled.toFixed(1)) >= 1024 && index < units.length - 1) {
        scaled /= 1024
        index += 1
      }
      return `${scaled.toFixed(1)} ${units[index]}`
    }

    function formatValue(item, value) {
      if (item.type === 'duration') return formatDuration(value)
      // `compactRetainTokens` / `notifyRepeatDelta` 用通用数字控件（type: number）但
      // 语义是 token 数：只认 type 会让同一批数字出现「97085」与「97,085」两种写法。
      if (isTokenCountItem(item)) return formatTokens(value)
      if (item.key === 'anchorTimeZone' && typeof value === 'number') {
        return tf('{value} 分钟', { value })
      }
      if (item.type === 'boolean') return value === true ? t('开启') : t('关闭')
      return value === undefined || value === '' ? t('（空）') : String(value)
    }

    function formatEntryValue(item, value) {
      if (isUnitField(item)) return String(splitUnitValue(item, value).amount)
      if (isTokenCountItem(item)) return formatTokens(value)
      if (item.key === 'anchorTimeZone' && typeof value === 'number') {
        return tf('{value} 分钟', { value })
      }
      return value === undefined ? '' : String(value)
    }

    // These are token counts even though the form uses the generic number widget
    // for some of them. Keep this list aligned with the server's parseTokenCount
    // calls — `hostMaxTokens` was declared `type: 'number'` without being listed
    // here, so the panel rejected `256k` with "enter an integer" while the schema,
    // the resolver and docs/CONFIGURATION.md all accepted it.
    const TOKEN_COUNT_KEYS = new Set([
      'notifyTokens',
      'notifyRepeatDelta',
      'compactRetainTokens',
      'hostMaxTokens',
    ])
    const HUMAN_TOKEN_INPUT_PATTERN =
      /^\s*(?:([1-9]\d*)\s*([kKmM]?)|([1-9]\d*\.\d+|0?\.[1-9]\d*)\s*([kKmM]))\s*$/

    function isTokenCountItem(item) {
      return item?.type === 'tokens' || TOKEN_COUNT_KEYS.has(item?.key)
    }

    function parseTokenInput(raw) {
      const match = HUMAN_TOKEN_INPUT_PATTERN.exec(String(raw))
      if (match === null) return null
      // 与 lib/config.js 的 parseTokenCount 同一条规则：小数必须带 k/m，
      // 带单位的小数按四舍五入取整，两边不能各有一套接受集。
      const amount = Number(match[1] ?? match[3])
      const unit = /** @type {string} */ (match[2] ?? match[4]).toLowerCase()
      const resolved = Math.round(
        amount * (unit === 'k' ? 1024 : unit === 'm' ? 1048576 : 1),
      )
      return Number.isSafeInteger(resolved) && resolved > 0 && resolved <= MAX_CONFIG_INTEGER
        ? resolved
        : null
    }

    function parseIntegerInput(raw) {
      const text = String(raw).trim()
      if (!/^\d+$/.test(text)) return null
      const value = Number(text)
      return Number.isSafeInteger(value) && value >= 0 && value <= MAX_CONFIG_INTEGER ? value : null
    }

    function coerceNumericInput(item, raw) {
      // `hostMaxTokens: 'auto'` 的快捷项会把这四个字母写进来。面板的本地校验
      // 必须与 schema 同源，否则点了按钮会被自己的校验拦下（报「请填整数」），
      // 而宿主那边明明是接受的。
      if (item.key === 'hostMaxTokens' && typeof raw === 'string' && raw.trim().toLowerCase() === 'auto') {
        return 'auto'
      }
      return isTokenCountItem(item) ? parseTokenInput(raw) : parseIntegerInput(raw)
    }

    function settleFieldCommit(result, restore) {
      if (result?.ok === true) return true
      restore(result?.message ?? t('保存失败，输入已恢复为当前运行值。'))
      return false
    }

    /**
     * Convert any accepted time-zone spelling to UTC-offset minutes, or null.
     *
     * The lengths carry the meaning, exactly as on the Host: `+8` / `-5` (one or
     * two digits) are hours, `+0530` / `+05:30` are clock offsets, and a bare
     * three-digit value such as `-300` is minutes. Guessing wrong here shifts the
     * scaffold timestamp by hours while the input box still shows what was typed,
     * so the panel normalizes every accepted form to a number the Host reads
     * without ambiguity.
     */
    function timeZoneMinutes(text) {
      const minuteValue = /^([+-]?\d+)\s*(?:分钟|分|min(?:ute)?s?|m)$/.exec(text)
      if (minuteValue !== null) {
        const minutes = Number(minuteValue[1])
        return Number.isInteger(minutes) && minutes >= -720 && minutes <= 840 ? minutes : null
      }
      const clock =
        /^([+-])(\d{1,2}):(\d{2})$/.exec(text) ?? /^([+-])(\d{2})(\d{2})$/.exec(text)
      if (clock !== null) {
        const minutes = Number(clock[3])
        if (minutes >= 60) return null
        const total = (clock[1] === '-' ? -1 : 1) * (Number(clock[2]) * 60 + minutes)
        return total >= -720 && total <= 840 ? total : null
      }
      const threeDigitMinutes = /^([+-])(\d{3})$/.exec(text)
      if (threeDigitMinutes !== null) {
        const total = (threeDigitMinutes[1] === '-' ? -1 : 1) * Number(threeDigitMinutes[2])
        return total >= -720 && total <= 840 ? total : null
      }
      const hourOffset = /^([+-])(\d{1,2})$/.exec(text)
      if (hourOffset !== null) {
        const total = (hourOffset[1] === '-' ? -1 : 1) * Number(hourOffset[2]) * 60
        return total >= -720 && total <= 840 ? total : null
      }
      if (/^[+-]?\d+$/.test(text)) {
        const minutes = Number(text)
        return Number.isInteger(minutes) && minutes >= -720 && minutes <= 840 ? minutes : null
      }
      return null
    }

    function coerceTimeZone(raw) {
      const text = String(raw).trim().toLowerCase()
      if (text === 'local' || text === 'utc' || text === 'z') return text
      return timeZoneMinutes(text)
    }

    /**
     * 设置面板的下拉选项：先 `local` / `utc`，再按分钟数升序排列的固定偏移。
     *
     * 整点覆盖 UTC−12..UTC+14，另外列出 IANA 现状里所有常用带分钟偏移
     * （印度 +05:30、尼泊尔 +05:45、纽芬兰 −03:30、查塔姆 +12:45/+13:45 等）。
     * value 是提交给 Host 的形式（`local` / `utc` / `±H:MM`），因为面板最终总是
     * 把选择归一成 Host 无歧义读取的数字。列表外的偏移（例如历史时区）仍可直接
     * 写进 YAML；打开面板时它们会作为「当前值」出现在下拉里，不会被悄悄改掉。
     */
    function timeZoneOptions() {
      // 带分钟的真实偏移。只列整点会让这些时区的用户只能去改 YAML。
      const minuteOffsets = [
        -570, // UTC−09:30 马克萨斯群岛
        -210, // UTC−03:30 纽芬兰
        210, // UTC+03:30 伊朗
        270, // UTC+04:30 阿富汗
        330, // UTC+05:30 印度
        345, // UTC+05:45 尼泊尔
        390, // UTC+06:30 缅甸 / 科科斯群岛
        525, // UTC+08:45 澳大利亚 Eucla
        570, // UTC+09:30 澳大利亚中部
        630, // UTC+10:30 澳大利亚 Lord Howe
        765, // UTC+12:45 查塔姆群岛
        825, // UTC+13:45 查塔姆群岛夏令时
      ]
      const offsets = []
      for (let hours = -12; hours <= 14; hours += 1) {
        if (hours !== 0) offsets.push(hours * 60)
      }
      offsets.push(...minuteOffsets)
      offsets.sort((a, b) => a - b)
      const row = (minutes) => {
        const abs = Math.abs(minutes)
        const hours = Math.floor(abs / 60)
        const minutesPart = String(abs % 60).padStart(2, '0')
        return {
          // value 用 `±H:MM`：两字符的 `-60` 会被当成「-60 小时」，而带冒号的
          // 形式没有这个歧义，coerceTimeZone 也会把它归一成分钟数字。
          value: `${minutes < 0 ? '-' : '+'}${hours}:${minutesPart}`,
          label: `UTC${minutes < 0 ? '-' : '+'}${String(hours).padStart(2, '0')}:${minutesPart}`,
          minutes,
        }
      }
      return [
        { value: 'local', label: '本机时间（local）', labelEn: 'Local time (local)', minutes: undefined },
        { value: 'utc', label: 'UTC', minutes: 0 },
        ...offsets.map(row),
      ]
    }
    /**
     * `dshHome` 的绝对路径判据，与 host 的 `path.isAbsolute`（win32 语义）对齐。
     *
     * 抽成独立函数主要是为了**能被直接测试**：它以前写死在 `validateValue` 里，
     * 而 `validateValue` 不在可抽取的解析块内，于是这条闸没有任何测试覆盖 ——
     * `\data`（当前盘符根 + 目录）被面板拒绝、host 却接受，YAML 里的合法值在面板
     * 里根本存不回去，报错理由还是假的（它就是绝对路径）。
     *
     * 只认三种：盘符绝对（`D:\` / `D:/`）、反斜杠开头（`\data`、`\\server\share`）、
     * 斜杠开头（`/data`）。`C:rel` 是**盘符相对**路径，两侧都拒。
     */
    function isAbsolutePathInput(value) {
      return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(String(value).trim())
    }
    // STAGE_HANDOFF_CLIENT_PARSE_END

    /** 把输入框文本还原成该字段的正确类型。 */
    function coerce(item, raw) {
      const type = item?.type
      const text = String(raw).trim()
      if (type === 'number' || type === 'tokens') {
        return coerceNumericInput(item, text)
      }
      if (type === 'duration') {
        // 接受 5 分钟 / 30s / 1.5h / 60000 等写法 —— 中文单位也要认，
        // 否则界面把 300000 显示成「5 分钟」后原样提交就会自己拒绝自己。
        const compact = text.replace(/\s+/g, '').toLowerCase()
        const match = /^(\d+(?:\.\d+)?)([^\d]*)$/.exec(compact)
        if (match === null) return null
        const base = Number(match[1])
        if (!Number.isFinite(base)) return null
        const suffix = match[2]
        if (suffix === '') {
          const resolved = Math.round(base)
          return Number.isSafeInteger(resolved) && resolved >= 0 && resolved <= MAX_CONFIG_INTEGER
            ? resolved
            : null
        }
        const unit = DURATION_ALIAS[suffix] ?? suffix
        const factor = DURATION_UNIT_FACTORS[unit]
        if (factor === undefined) return null
        const resolved = Math.round(base * factor)
        return Number.isSafeInteger(resolved) && resolved >= 0 && resolved <= MAX_CONFIG_INTEGER
          ? resolved
          : null
      }
      return text
    }

    function validateValue(item, next) {
      // `hostMaxTokens: 'auto'` 不是数字：本地闸必须放行，否则面板会拦下自己
      // 填进去的 auto（提示「需要整数」），而 schema、解析器、文档都接受它。
      // 快捷按钮绕过了这里，所以这个洞只在手输时显形 —— 更容易被漏掉。
      if (item.key === 'hostMaxTokens' && next === 'auto') return ''
      if (
        item.type === 'number' ||
        item.type === 'tokens' ||
        item.type === 'duration' ||
        item.type === 'bytes'
      ) {
        if (!Number.isInteger(next)) return t('需要整数')
        if (next < (item.min ?? 0)) {
          return tf('不能小于 {min}', { min: item.min ?? 0 })
        }
        // item.max 是字段自己声明的上界（目前只有 guardMaxBytes 有，16 MiB）。
        // 不校验它的话，超界值会先被本地放行、再由 Host 拒绝，用户只能看到
        // 一句「Host 拒绝了这次修改」，看不到真正的区间。
        const upper = item.max ?? MAX_CONFIG_INTEGER
        if (next > upper) return tf('不能大于 {max}', { max: upper })
        return ''
      }
      if (item.key === 'anchorRoot') {
        const value = String(next).trim()
        if (value === '') return t('不能为空')
        if (value.split(/[\\/]+/).includes('..')) return t('不能包含 .. 路径段')
        // Host 的 schema 明确拒绝控制字符（粘贴终端输出时常带 tab）。这里不先拦，
        // 用户只会看到一句全局的「Host 拒绝了这次修改」，字段行没有任何原因。
        if (/[\u0000-\u001f\u007f]/u.test(value)) return t('不能包含控制字符（如制表符）')
      }
      if (item.key === 'dshHome') {
        const value = String(next).trim()
        // 留空是合法写法（读环境变量 DSH_HOME）。
        if (value !== '') {
          // 只有解析器要求绝对路径，Host 的 schema 是裸 `string()` —— 也就是说
          // 相对路径在这里一路放行、面板回「已保存」，直到下次挂载才由
          // resolveConfig 抛错。不先拦，用户看到的是「保存成功」然后配置整体失效。
          // 与 host 的 `path.isAbsolute` 对齐：`\data` 在 win32 上也是绝对路径
          // （当前盘符根 + 目录），旧正则只认 `C:\`、`\\` 与 `/`，于是 YAML 里写
          // 的合法值在面板里存不回去，而报错理由本身是假的（它就是绝对路径）。
          if (!isAbsolutePathInput(value)) {
            return t('必须填绝对路径（Windows 如 D:/dsh-data，Linux/macOS 如 /var/lib/dsh），或留空读环境变量 DSH_HOME')
          }
          if (/[\u0000-\u001f\u007f]/u.test(value)) return t('不能包含控制字符（如制表符）')
        }
      }
      if (item.key === 'anchorTimeZone') {
        if (next === 'local' || next === 'utc' || next === 'z') return ''
        if (typeof next === 'number') {
          return Number.isInteger(next) && next >= -720 && next <= 840
            ? ''
            : t('数字偏移必须是 -720..840 的整数分钟')
        }
        // coerceTimeZone 总是把可解析的输入归一成数字；走到这里的字符串
        // 只可能是三个关键字（已在上面放行），其余都算格式错误。
        return t('填 local / utc / z，或 +8 / -5 / +05:30 / -300 这类偏移或分钟数')
      }
      return ''
    }

    /** 解析失败时的提示必须贴合该字段的真实写法，不能一律套 token 的例子。 */
    function formatError(item, raw) {
      if (item.type === 'duration') {
        return tf('请填非负整数，单位在右侧下拉里选；换算后不能超过 {max}', {
          max: MAX_CONFIG_INTEGER,
        })
      }
      if (item.type === 'bytes') {
        return tf('请填非负整数，单位在右侧下拉里选（字节 / KiB / MiB / GiB）；换算后不能超过 {max}', {
          max: MAX_CONFIG_INTEGER,
        })
      }
      if (isTokenCountItem(item)) {
        // 「格式不对」和「结果太大」是两件事。`1000000001` 和 `2000000k` 的格式
        // 完全合法，只是换算后超过上界 —— 都回「格式不对」会让用户反复改格式，
        // 而真正的上界在界面上从未出现过。
        if (HUMAN_TOKEN_INPUT_PATTERN.exec(String(raw ?? '')) !== null) {
          return tf('结果不能大于 {max}（例：300k / 1m / 400000）', {
            max: item.max ?? MAX_CONFIG_INTEGER,
          })
        }
        return t('格式不对，例如 300k / 1m / 400000；结果必须是正整数')
      }
      if (item.key === 'anchorTimeZone') {
        return t('填 local / utc / z，或 +8 / -5 / +05:30（小时偏移），或 -300 这类整数分钟')
      }
      // 数字字段的解析失败有两种原因：格式不对，或者个数超了上限。旧文案一律说
      // 「请填整数」，于是用户输入一个超大的正整数时被告知「请填整数」——而他填的
      // 正是整数。这里直接把真实区间写出来。
      if (item.type === 'number') {
        return tf('请填 {min}..{max} 的整数', {
          min: item.min ?? 0,
          max: item.max ?? MAX_CONFIG_INTEGER,
        })
      }
      return t('请输入文本')
    }

    function Button({ variant = 'ghost', busy = false, icon, children, ...rest }) {
      return h(
        'button',
        {
          type: 'button',
          'data-stage-handoff-button': variant,
          ...rest,
          disabled: rest.disabled || busy,
        },
        busy ? h(Spinner) : icon ? h(Icon, { name: icon }) : null,
        children,
      )
    }

    function StageSwitch({ checked, disabled, label, onChange }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'data-stage-handoff-switch': '',
          'aria-label': label,
          'aria-checked': checked ? 'true' : 'false',
          disabled,
          onClick: () => onChange(!checked),
        },
        h('span', { 'aria-hidden': 'true' }),
      )
    }

    function FieldRow({ item, value, baseValue, customized, writable, pending, commit, reset }) {
      const editable = writable && !item.fixed
      const busy = pending instanceof Map && pending.has(item.key)
      const initial = formatEntryValue(item, value)
      const [draft, setDraft] = useState(initial)
      const [error, setError] = useState('')
      const [unit, setUnit] = useState(() => splitUnitValue(item, value).unit)
      const inputId = `stage-handoff-${item.key}`
      const hintId = `${inputId}-hint`
      const errorId = `${inputId}-error`

      useEffect(() => {
        setDraft(formatEntryValue(item, value))
        setError('')
        if (isUnitField(item)) setUnit(splitUnitValue(item, value).unit)
      }, [value, item.type])

      const restoreDraft = useCallback(
        (message) => {
          setDraft(formatEntryValue(item, value))
          if (isUnitField(item)) setUnit(splitUnitValue(item, value).unit)
          setError(message)
        },
        [item, value],
      )

      const submit = useCallback(async () => {
        if (!editable || busy) return
        const next =
          item.key === 'anchorTimeZone'
            ? coerceTimeZone(draft)
            : isUnitField(item)
              ? coerceUnitValue(item, draft, unit)
              : coerce(item, draft)
        if (next === null) {
          setError(formatError(item, draft))
          return
        }
        const invalid = validateValue(item, next)
        if (invalid !== '') {
          setError(invalid)
          return
        }
        setError('')
        if (next !== value) {
          const result = await commit(item.key, next)
          settleFieldCommit(result, restoreDraft)
        } else {
          setDraft(formatEntryValue(item, value))
        }
      }, [draft, unit, editable, busy, item, value, commit, restoreDraft])

      // 下拉字段：把当前值映射成 option value。选项用 `±H:MM` 表示偏移，
      // 所以先按分钟数找回对应选项；列表外的值（例如 +05:45）补一条「当前值」，
      // 否则浏览器会静默选中第一项，看起来像配置被改了。
      const selectOptions = item.type === 'select' ? (item.options ?? []) : []
      const selectRaw = (() => {
        if (value === 'local' || value === 'utc') return value
        if (value === 'z' || value === 0) return 'utc'
        // 用与写入侧同一个归一化：`+8` / `-5` 是小时偏移、`-300` 是分钟、
        // `+05:30` 是时钟偏移。只用 Number(value) 会把 `+8` 当成 8 分钟，
        // 与选项里的 480 对不上，于是显示成「当前值 · +8」。
        const minutes = typeof value === 'number' ? value : coerceTimeZone(value)
        const match = selectOptions.find((row) => row.minutes === minutes)
        return match?.value ?? String(value)
      })()
      const selectRows =
        item.type === 'select' && !selectOptions.some((row) => row.value === selectRaw)
          ? [...selectOptions, { value: selectRaw, label: tf('当前值 · {value}', { value: selectRaw }) }]
          : selectOptions

      const rowMain = h(
        'div',
        { 'data-stage-handoff-row-main': '' },
        h(
          'div',
          { 'data-stage-handoff-row-title': '' },
          labelOf(item),
          customized ? h('span', { 'data-stage-handoff-badge': '' }, t('已自定义')) : null,
        ),
        h(
          'p',
          { 'data-stage-handoff-hint': '', id: hintId },
          h('code', null, item.key),
          ' · ',
          hintOf(item),
          // 有些字段的错法不是「填错」，而是「填对了但和别处不匹配」（例如
          // hostMaxTokens 与模型的实际输出预算）。这类问题没法用校验器拦 ——
          // 只能在提示后面挂一个显式警告标识，让它别被当成普通说明读过去。
          item.warning
            ? h(
                'span',
                { 'data-stage-handoff-warning': '' },
                ' ⚠ ',
                pick(item.warning, item.warningEn),
              )
            : null,
          customized && writable
            ? h('span', null, tf(' 默认：{value}', { value: formatValue(item, baseValue) }))
            : null,
        ),
      )

      if (item.type === 'boolean') {
        return h(
          'div',
          {
            'data-stage-handoff-row': '',
            'data-fixed': item.fixed ? 'true' : 'false',
          },
          rowMain,
          h(
            'div',
            { 'data-stage-handoff-control': '' },
            h(
              'div',
              { 'data-stage-handoff-control-line': '' },
              h(StageSwitch, {
                checked: value === true,
                disabled: !editable || busy,
                label: labelOf(item),
                onChange: (next) => commit(item.key, next),
              }),
              h(
                'span',
                { 'data-stage-handoff-badge': '' },
                value === true ? t('开启') : t('关闭'),
              ),
              !editable
                ? h('span', { 'data-stage-handoff-badge': '' }, item.fixed ? t('固定') : t('只读'))
                : busy
                  ? h('span', { 'data-stage-handoff-hint': '' }, h(Spinner), t(' 保存中'))
                  : null,
              // 布尔字段也要有「恢复默认」：徽标和 Hero 的「N 项已自定义」对布尔键
              // 同样计数，但这一行原来没有任何清除入口，覆盖一旦写进去就清不掉，
              // 「复制 YAML」也永远带上那行显式覆盖。
              writable && customized
                ? h(Button, {
                    variant: 'ghost',
                    icon: 'reset',
                    title: tf('恢复 {label} 的默认值', { label: labelOf(item) }),
                    'aria-label': tf('恢复 {label} 的默认值', { label: labelOf(item) }),
                    'data-stage-handoff-reset': '',
                    disabled: busy,
                    onClick: () => reset(item.key),
                  })
                : null,
            ),
          ),
        )
      }

      return h(
        'div',
        {
          'data-stage-handoff-row': '',
          'data-fixed': item.fixed ? 'true' : 'false',
        },
        rowMain,
        h(
          'div',
          { 'data-stage-handoff-control': '' },
          h(
            'div',
            { 'data-stage-handoff-control-line': '' },
            isUnitField(item)
              ? h(
                  'div',
                  { 'data-stage-handoff-duration': '' },
                  h('input', {
                    id: inputId,
                    'data-stage-handoff-input': '',
                    type: 'text',
                    value: draft,
                    disabled: !editable || busy,
                    inputMode: isTokenCountItem(item) ? undefined : 'numeric',
                    autoComplete: 'off',
                    spellCheck: false,
                    placeholder: placeholderOf(item),
                    'aria-label': tf('{label}数值', { label: labelOf(item) }),
                    'aria-describedby': error === '' ? hintId : `${hintId} ${errorId}`,
                    'aria-invalid': error === '' ? 'false' : 'true',
                    onChange: (event) => setDraft(event.currentTarget.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    },
                    onBlur: submit,
                  }),
                  h(
                    'select',
                    {
                      'data-stage-handoff-unit': '',
                      disabled: !editable || busy,
                      value: unit,
                      'aria-label': tf('{label}单位', { label: labelOf(item) }),
                      onChange: (event) => {
                        // 换单位立刻按新单位重算并提交，不需要再失焦一次。
                        const nextUnit = event.currentTarget.value
                        setUnit(nextUnit)
                        const next = coerceUnitValue(item, draft, nextUnit)
                        if (next === null) {
                          setError(formatError(item, draft))
                          return
                        }
                        // 换单位会改变**换算后的值**，所以必须和文本提交走同一道
                        // min/max 闸：把 `guardMaxBytes` 的单位从 MiB 切成字节，
                        // 数值框里的 1 就变成 1 字节（远低于 65536）；反过来把
                        // `staleReservationTtlMs` 的 8 换成「天」会得到 691,200,000
                        // （超过 7 天上限）。旧实现直接交给 Host，用户只看到一句
                        // 笼统的拒绝，而本地明明能说清是哪一条越界。
                        const outOfRange = validateValue(item, next)
                        if (outOfRange !== '') {
                          setError(outOfRange)
                          setUnit(splitUnitValue(item, value).unit)
                          return
                        }
                        setError('')
                        if (next !== value) {
                          void commit(item.key, next).then((result) => {
                            settleFieldCommit(result, (message) => {
                              setUnit(splitUnitValue(item, value).unit)
                              restoreDraft(message)
                            })
                          })
                        }
                      },
                    },
                    unitTableOf(item).map((row) =>
                      h('option', { key: row.id, value: row.id }, pick(row.label, row.labelEn)),
                    ),
                  ),
                )
              : item.type === 'select'
                ? h(
                    'select',
                    {
                      id: inputId,
                      'data-stage-handoff-select': '',
                      disabled: !editable || busy,
                      value: selectRaw,
                      'aria-label': labelOf(item),
                      'aria-describedby': error === '' ? hintId : `${hintId} ${errorId}`,
                      'aria-invalid': error === '' ? 'false' : 'true',
                      onChange: (event) => {
                        // 选中即保存，和单位下拉一致：不需要再失焦一次。
                        const chosen = event.currentTarget.value
                        // 列表外的值会补一条「当前值」选项；选它等于没改，不解析。
                        if (chosen === selectRaw) return
                        const parsed = coerceTimeZone(chosen)
                        if (parsed === null) {
                          setError(formatError(item, chosen))
                          return
                        }
                        setError('')
                        const unchanged =
                          parsed === value || (parsed === 'utc' && value === 0)
                        if (unchanged) return
                        void commit(item.key, parsed).then((result) => {
                          if (result?.ok !== true) {
                            restoreDraft(result?.message ?? t('保存失败，已保持原值。'))
                          }
                        })
                      },
                    },
                    selectRows.map((row) =>
                      h('option', { key: row.value, value: row.value }, pick(row.label, row.labelEn)),
                    ),
                  )
                : h('input', {
                  id: inputId,
                  'data-stage-handoff-input': '',
                  type: 'text',
                  value: draft,
                  disabled: !editable || busy,
                  inputMode:
                    item.type === 'text' || isTokenCountItem(item) ? undefined : 'decimal',
                  autoComplete: 'off',
                  spellCheck: false,
                  placeholder: placeholderOf(item),
                  'aria-label': labelOf(item),
                  'aria-describedby': error === '' ? hintId : `${hintId} ${errorId}`,
                  'aria-invalid': error === '' ? 'false' : 'true',
                  onChange: (event) => setDraft(event.currentTarget.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                  },
                  onBlur: submit,
                }),
            // 「可选 maxTokens」的快捷填入。面板拿不到窗口容量，算不出墙，但可以
            // 把模型常见的输出上限摆出来 —— 让人一键填对，而不是凭印象写一个数字。
            // 这只是填入，仍然走同一条 commit/校验路径，所以警告标识照旧会亮。
            item.suggestions
              ? h(
                  'div',
                  { 'data-stage-handoff-suggestions': '' },
                  item.suggestions.map((row) =>
                    h(
                      'button',
                      {
                        key: row.value,
                        type: 'button',
                        'data-stage-handoff-suggestion': '',
                        disabled: !editable || busy,
                        title: pick(row.hint, row.hintEn),
                        onClick: () => {
                          void commit(item.key, row.value).then((result) => {
                            settleFieldCommit(result, restoreDraft)
                          })
                        },
                      },
                      pick(row.label, row.labelEn),
                    ),
                  ),
                )
              : null,
            writable && customized
              ? h(
                  Button,
                  {
                    variant: 'ghost',
                    icon: 'reset',
                    title: tf('恢复 {label} 的默认值', { label: labelOf(item) }),
                    'aria-label': tf('恢复 {label} 的默认值', { label: labelOf(item) }),
                    'data-stage-handoff-reset': '',
                    disabled: busy,
                    onClick: () => reset(item.key),
                  },
                )
              : null,
          ),
          error === ''
            ? null
            : h('span', { 'data-stage-handoff-error': '', id: errorId, role: 'alert' }, error),
          busy
            ? h('span', { 'data-stage-handoff-hint': '' }, h(Spinner), t(' 正在保存…'))
            : null,
        ),
      )
    }

    /**
     * 「存储」组底部的体积摘要。
     *
     * 配置表单拿不到磁盘信息，所以走 host 注册的只读路由
     * `/api/stage-handoff/usage`；拿不到就明确说不可用，不假装成 0。
     */
    function UsageSummary({ values }) {
      const [usage, setUsage] = useState(null)
      const [failure, setFailure] = useState('')
      const [loading, setLoading] = useState(true)
      // 体积是按 anchorRoot / dshHome 算出来的：这两个值保存后必须重新取，
      // 否则摘要还显示旧路径与旧字节数，和同一张卡片刚保存的值互相矛盾（bug-hunt P2-2）。
      const anchorRoot = values?.anchorRoot
      const dshHome = values?.dshHome

      useEffect(() => {
        let alive = true
        // 切 tab / 改配置都会重跑这个 effect；不 abort 的话旧请求会和新请求
        // 一起压在 Host 上（每次最多 8 个 workspace 各 3 秒）。
        const controller = new AbortController()
        setLoading(true)
        fetch('/api/stage-handoff/usage', {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          signal: controller.signal,
        })
          .then(async (response) => {
            if (!response.ok) {
              // 非 2xx 的 body 里有插件给的 error 文案（例如停用时的 503），别只留状态码。
              let detail = ''
              try {
                const body = await response.json()
                detail = String(body?.error ?? '')
              } catch {
                detail = ''
              }
              throw new Error(detail === '' ? `HTTP ${response.status}` : `HTTP ${response.status}：${detail}`)
            }
            return response.json()
          })
          .then((payload) => {
            if (!alive) return
            if (payload?.ok !== true) throw new Error(String(payload?.error ?? t('未知错误')))
            setUsage(payload)
            setFailure('')
            setLoading(false)
          })
          .catch((error) => {
            if (!alive) return
            setFailure(error instanceof Error ? error.message : String(error))
            setLoading(false)
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [anchorRoot, dshHome])

      if (loading) {
        return h(
          'div',
          { 'data-stage-handoff-usage': '' },
          h(Spinner),
          h('span', null, t('正在统计体积…')),
        )
      }
      if (failure !== '') {
        return h(
          'div',
          { 'data-stage-handoff-usage': '' },
          // enabled=false 时 apply() 早退，体积路由根本没注册 —— 那是「入口停用」
          // 而不是一次普通的 HTTP 失败，不说清楚用户会去查网络。
          /404/.test(failure)
            ? tf('体积统计不可用：{detail}（入口停用时这个路由不会注册）', { detail: failure })
            : tf('体积统计不可用：{detail}', { detail: failure }),
        )
      }

      const sessions = usage?.sessions ?? {}
      const workspaces = Array.isArray(usage?.anchors)
        ? usage.anchors
        : usage?.anchor === undefined
          ? []
          : [{ workspace: undefined, anchor: usage.anchor }]
      const truncatedAnchors = workspaces.filter((row) => row?.anchor?.truncated === true)
      return h(
        'div',
        { 'data-stage-handoff-usage': '' },
        h(
          'div',
          null,
          sessions.exists === true
            ? tf('会话存储 {bytes} · {count} 个会话', {
                bytes: formatBytes(sessions.bytes),
                count: sessions.count,
              })
            : sessions.truncated === true
              ? tf('会话存储不可读：{reason}', { reason: sessions.reason ?? t('未知读取错误') })
              // 「没配置」和「配了但目录不存在」是两件事：前者是可选功能没开，
              // 后者要去看路径。合成一句会让用户去查一个根本没配置的目录。
              : sessions.root === '' || sessions.root === undefined
                ? t('会话存储：未配置 DSH_HOME（可选的体积统计，不影响收尾提醒）')
                : tf('会话存储：{root} 下没有 sessions 目录', { root: sessions.root }),
        ),
        ...workspaces.flatMap((row, index) => {
          const anchor = row?.anchor ?? {}
          const workspace = row?.workspace
          const prefix =
            workspaces.length > 1 ? tf('工作区 {index}', { index: index + 1 }) : t('锚点')
          return [
            h(
              'div',
              { key: `summary-${index}` },
              anchor.exists === true && anchor.truncated !== true
                ? tf('{prefix}：{bytes} · {files} 个文件', {
                    prefix,
                    bytes: formatBytes(anchor.bytes),
                    files: anchor.files,
                  })
                : anchor.truncated === true
                  ? // exists 也可能是 true（例如 anchorRoot 指向一个普通文件）：
                    // 这时 reason 才是唯一能解释「为什么没有数字」的信息。
                    tf('{prefix}不可读或未统计完整：{reason}', {
                      prefix,
                      reason: anchor.reason ?? t('未知原因'),
                    })
                  : tf('{prefix}：锚点目录还不存在', { prefix }),
            ),
            h(
              'div',
              { key: `path-${index}`, 'data-stage-handoff-usage-path': '' },
              tf('项目：{workspace} · 锚点：{root}', {
                workspace: workspace === undefined ? t('锚点') : workspace,
                root: anchor.root ?? t('（未配置）'),
              }),
            ),
          ]
        }),
        h(
          'div',
          { 'data-stage-handoff-usage-path': '' },
          tf('会话：{root}', {
            root:
              sessions.root === '' || sessions.root === undefined
                ? t('（未配置 DSH_HOME）')
                : sessions.root,
          }),
        ),
        sessions.truncated === true || truncatedAnchors.length > 0 || usage?.workspacesTruncated === true
          ? h(
              'div',
              null,
              // 两类情况不能共用一句话：会话行被截断时仍有数字（是下限），
              // 锚点行被截断/不可读时根本没有数字。旧文案对后者说「下面的数字是下限」，
              // 可它一个数字都没显示。
              t('统计不完整：标「不可读」的行没有可用数字，其余带数字的行是下限') +
                (usage?.workspacesTruncated === true
                  ? // 上限来自 host 的 MAX_USAGE_WORKSPACES；写死 8 的话 host 调整后文案就会说谎。
                    tf('；活动工作区超过 {max} 个，只显示前 {max} 个', {
                      max: usage?.maxWorkspaces ?? t('若干'),
                    })
                  : ''),
            )
          : null,
      )
    }

    function Group({ group, snapshot, writable, pending, commit, reset }) {
      const values = snapshot.values
      const user = snapshot.user
      const base = snapshot.base
      return h(
        'section',
        { 'data-stage-handoff-card': '' },
        h(
          'div',
          { 'data-stage-handoff-card-head': '' },
          h('div', { 'data-stage-handoff-card-title': '' }, groupTitleOf(group)),
          h('div', { 'data-stage-handoff-card-hint': '' }, groupHintOf(group)),
        ),
        group.items.map((item) =>
          h(FieldRow, {
            key: item.key,
            item,
            value: values[item.key],
            baseValue: base[item.key] ?? FALLBACK[item.key],
            customized: Object.hasOwn(user, item.key),
            writable,
            pending,
            commit,
            reset,
          }),
        ),
        group.group === '存储' ? h(UsageSummary, { key: 'usage-summary', values }) : null,
      )
    }

    function TabBar({ tab, setTab, customCounts }) {
      const chooseFromKeyboard = (event, index) => {
        const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (direction === 0) return
        event.preventDefault()
        const next = TABS[(index + direction + TABS.length) % TABS.length]
        setTab(next.id)
        requestAnimationFrame(() => document.getElementById(`stage-handoff-tab-${next.id}`)?.focus())
      }
      return h(
        'div',
        { role: 'tablist', 'aria-label': t('Stage Handoff 设置分组'), 'data-stage-handoff-tabs': '' },
        TABS.map((entry, index) =>
          h(
            'button',
            {
              key: entry.id,
              id: `stage-handoff-tab-${entry.id}`,
              type: 'button',
              role: 'tab',
              'data-stage-handoff-tab': '',
              'aria-selected': tab === entry.id ? 'true' : 'false',
              // 只有激活的 tab 才有对应的 tabpanel 节点；其余 aria-controls 会悬空，
              // 屏幕阅读器切组时找不到被控面板。
              ...(tab === entry.id
                ? { 'aria-controls': `stage-handoff-panel-${entry.id}` }
                : {}),
              tabIndex: tab === entry.id ? 0 : -1,
              onClick: () => setTab(entry.id),
              onKeyDown: (event) => chooseFromKeyboard(event, index),
            },
            // 这里原本直接用 entry.label（中文），英文界面下三个页签会各冒一个
            // 中文词出来 —— 渲染探针抓到的就是这三行。
            pick(entry.label, entry.labelEn),
            // 角标原来是一个裸数字，读起来像「这个分组里有多少项」，实际是「你改过
            // 几项」。改成 `已改/总数`，两者一起看才不会被误读成「值」；编辑已改过
            // 的项时数字不变 —— 那是对的，因为数的是「哪几项被改过」，不是「改了多少次」。
            (() => {
              const { count, total } = customCounts(entry)
              if (count === 0) return null
              const text = tf('{count}/{total}', { count, total })
              return h(
                'span',
                {
                  'data-stage-handoff-count': '',
                  title: tf('{count} 项已自定义', { count }),
                  'aria-label': tf('{count} 项已自定义', { count }),
                },
                text,
              )
            })(),
          ),
        ),
      )
    }

    function Stats({ values }) {
      return h(
        'div',
        { 'data-stage-handoff-stats': '' },
        h(
          'div',
          { 'data-stage-handoff-stat': '' },
          h('span', { 'data-stage-handoff-stat-label': '' }, t('提醒线')),
          h('span', { 'data-stage-handoff-stat-value': '' }, formatTokens(values.notifyTokens)),
        ),
        h(
          'div',
          { 'data-stage-handoff-stat': '' },
          h('span', { 'data-stage-handoff-stat-label': '' }, t('尾部逐字保留')),
          h('span', { 'data-stage-handoff-stat-value': '' }, formatTokens(values.compactRetainTokens)),
        ),
        h(
          'div',
          { 'data-stage-handoff-stat': '' },
          h('span', { 'data-stage-handoff-stat-label': '' }, t('锚点目录')),
          h(
            'span',
            { 'data-stage-handoff-stat-value': '', title: values.anchorRoot },
            h('code', null, values.anchorRoot),
          ),
        ),
      )
    }

    function Hero({ writable, enabled = true, values, customCount, onCopy, copying, copyAvailable = true }) {
      return h(
        'header',
        { 'data-stage-handoff-hero': '' },
        h('div', { 'data-stage-handoff-mark': '' }, h(Icon, { name: 'anchor' })),
        h(
          'div',
          { 'data-stage-handoff-hero-main': '' },
          h('span', { 'data-stage-handoff-kicker': '' }, 'Stage Handoff'),
          h('h2', { 'data-stage-handoff-title': '' }, t('阶段收尾与锚点接力')),
          h(
            'p',
            { 'data-stage-handoff-intro': '' },
            t('到线时提醒 agent 先写详细文档与精简锚点，再按 auto 力度压缩历史。'),
          ),
          h(
            'div',
            { 'data-stage-handoff-pills': '' },
            h(
              'span',
              { 'data-stage-handoff-pill': writable && enabled ? 'ok' : 'warn' },
              h('span', { 'data-stage-handoff-dot': '', 'aria-hidden': 'true' }),
              // 「能写」和「真的在跑」是两件事：enabled=false 时配置仍可编辑，
              // 但入口没挂载。旧文案在这种情况下仍写「实时生效」，与下面的
              // 「已停用」自相矛盾。
              writable && enabled
                ? t('Host 已连接 · 实时生效')
                : enabled
                  ? t('只读预览')
                  : t('入口已停用 · 配置可编辑'),
            ),
            customCount > 0
              ? h(
                  'span',
                  { 'data-stage-handoff-pill': '' },
                  tf('{count} 项已自定义', { count: customCount }),
                )
              : h('span', { 'data-stage-handoff-pill': '' }, t('使用默认配置')),
          ),
        ),
        h(
          'div',
          { 'data-stage-handoff-actions': '' },
          h(
            Button,
            {
              variant: 'outline',
              icon: 'copy',
              busy: copying,
              disabled: !copyAvailable,
              'aria-label': t('复制当前 Stage Handoff 配置 YAML'),
              onClick: onCopy,
            },
            copying ? t('复制中') : t('复制 YAML'),
          ),
        ),
      )
    }

    function fixedStatus(values, writable) {
      return h(
        'div',
        { 'data-stage-handoff-fixed': '' },
        h(
          'span',
          { 'data-stage-handoff-pill': values.enabled === true ? 'ok' : 'warn' },
          h('span', { 'data-stage-handoff-dot': '', 'aria-hidden': 'true' }),
          values.enabled === true ? t('已启用') : t('已停用'),
        ),
        h(
          'div',
          null,
          h('strong', null, values.enabled === true ? t('Host 入口已启用') : t('Host 入口已停用')),
          h(
            'span',
            null,
            writable
              ? t('启停会改变整条 Host 入口，需编辑 profile 的 cordis.patch.yml 并重启 DSH。')
              : t('只读模式：配置值来自当前 Host 快照。'),
          ),
        ),
      )
    }

    function AdvancedHelp() {
      return h(
        'details',
        { 'data-stage-handoff-advanced': '' },
        h('summary', null, t('运行与排障命令')),
        h(
          'p',
          null,
          h('code', null, '/anchor status'),
          t('查看当前提醒线和占用；'),
          h('code', null, 'stage_handoff(action="usage")'),
          t('查看锚点与会话占用；'),
          h('code', null, 'stage_handoff(action="summary")'),
          t('对账最近一次压缩摘要。'),
        ),
        h(
          'p',
          { 'data-stage-handoff-locale-origin': '' },
          tf('面板语言：{lang} · 来源 {origin}', {
            lang: isChinese() ? t('中文') : t('英文'),
            origin: localeOrigin,
          }),
        ),
      )
    }

    function configYamlFor(values) {
      const keys = Object.keys(FALLBACK)
      return [
        '- id: stage-handoff',
        '  config:',
        ...keys.map((key) => {
          const value = values[key]
          return `    ${key}: ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`
        }),
      ].join('\n')
    }

    function customCountFor(user) {
      // 只数面板上真正有行的键：enabled 这类全局开关没有对应的行，
      // 数进来会出现「1 项已自定义」但三个 tab 都没徽标、也没有可恢复入口（bug-hunt P2-11）。
      const panelKeys = new Set(FIELD_GROUPS.flatMap((group) => group.items.map((item) => item.key)))
      return Object.keys(user).filter((key) => Object.hasOwn(FALLBACK, key) && panelKeys.has(key)).length
    }

    function panelFor(snapshot, tab, props) {
      const active = TABS.find((entry) => entry.id === tab) ?? TABS[0]
      return h(
        'div',
        {
          role: 'tabpanel',
          id: `stage-handoff-panel-${active.id}`,
          'aria-labelledby': `stage-handoff-tab-${active.id}`,
          'data-stage-handoff-panel': '',
        },
        FIELD_GROUPS.filter((group) => active.groups.includes(group.group)).map((group) =>
          h(Group, { key: group.group, group, snapshot, ...props }),
        ),
      )
    }

    /** 拿不到 config form 时的兜底：保留信息结构，但所有控件只读。 */
    function StaticPanel({ reason }) {
      useSyncExternalStore(subscribeLocale, localeRevision, zeroRevision)
      const [tab, setTab] = useState('reminder')
      const values = FALLBACK
      const snapshot = { values, base: FALLBACK, user: {} }
      return h(
        'section',
        { 'data-stage-handoff-root': '', 'aria-label': t('Stage Handoff 只读配置') },
        h(Hero, {
          writable: false,
          values,
          customCount: 0,
          copying: false,
          copyAvailable: false,
          onCopy: () => {},
        }),
        h(Stats, { values }),
        h(
          'div',
          { 'data-stage-handoff-statusbar': '', 'data-kind': 'warn', role: 'status' },
          h('span', { 'data-stage-handoff-dot': '', 'aria-hidden': 'true' }),
          h('span', null, reason, t('当前展示与代码一致的默认值。')),
        ),
        fixedStatus(values, false),
        h(TabBar, {
          tab,
          setTab,
          customCounts: () => ({ count: 0, total: 0 }),
        }),
        panelFor(snapshot, tab, {
          writable: false,
          pending: new Map(),
          commit: () => {},
          reset: () => {},
        }),
        AdvancedHelp(),
      )
    }

    function PresetPicker({ activePreset, disabled, applyPreset }) {
      return h(
        'div',
        { 'data-stage-handoff-card': '' },
        h(
          'div',
          { 'data-stage-handoff-card-head': '' },
          h('div', { 'data-stage-handoff-card-title': '' }, t('快捷方案')),
          h(
            'div',
            { 'data-stage-handoff-card-hint': '' },
            t('按模型上下文窗口调整提醒线、逐字保留与锚点上限；其他字段保持不变。'),
          ),
        ),
        h(
          'div',
          { 'data-stage-handoff-presets': '' },
          PRESETS.map((preset) =>
            h(
              'button',
              {
                key: preset.id,
                type: 'button',
                'data-stage-handoff-preset': '',
                'aria-pressed': activePreset?.id === preset.id ? 'true' : 'false',
                'aria-label': tf('套用 {title} 推荐值', {
                  title: pick(preset.title, preset.titleEn),
                }),
                disabled,
                onClick: () => applyPreset(preset),
              },
              pick(preset.label, preset.labelEn),
            ),
          ),
        ),
      )
    }

    function LivePanel() {
      // locale 变化时整块重渲染：文案走 t()/pick()，它们读的是当前语言，
      // 但没有这次订阅，切语言后面板会停在旧语言直到重新挂载。
      useSyncExternalStore(subscribeLocale, localeRevision, zeroRevision)
      const snapshot = useSyncExternalStore(
        (listener) => form.subscribe(listener),
        () => form.getSnapshot(),
        () => form.getSnapshot(),
      )
      const [tab, setTab] = useState('reminder')
      const [pending, setPending] = useState(() => new Map())
      const [note, setNote] = useState(null)
      // 失败必须**单独**存一份，不能只靠 `note`：`note` 记的是「最后落地的那个写入」，
      // 并发写入时后到的成功会覆盖先到的失败。实测：改 A（慢）后立刻拨开关 B、Host 拒绝，
      // 状态栏依次显示「正在保存 A」→「正在保存 2 项」→「正在保存 A」→「已保存 · A」，
      // 而「B 被拒绝」从未出现。渲染时失败优先于「正在保存」与 note。
      // 只在同一字段下次成功、或被更新的失败取代时才清。
      const [lastFailure, setLastFailure] = useState(null)
      const [copying, setCopying] = useState(false)
      const pendingToken = useRef(0)

      const status = snapshot?.status
      const writable = snapshot?.writable === true && status === 'ready'
      // 配置读取卡住时的自救：超过 5 秒就明说，而不是无限转圈（见下面 loading 分支）。
      const [slow, setSlow] = useState(false)
      useEffect(() => {
        if (status !== 'loading') {
          setSlow(false)
          return undefined
        }
        const timer = setTimeout(() => setSlow(true), 5000)
        return () => clearTimeout(timer)
      }, [status])
      const values = { ...FALLBACK, ...(snapshot?.value ?? {}) }
      // enabled=false 时入口没挂载：面板仍可编辑配置，但「实时生效」是假的。
      const enabled = values.enabled === true
      const base = { ...FALLBACK, ...(snapshot?.base ?? {}) }
      const user = snapshot?.user ?? {}
      const view = { values, base, user }
      const customCount = customCountFor(user)

      const write = useCallback((key, operation, successText) => {
        pendingToken.current += 1
        const token = pendingToken.current
        setPending((current) => {
          const next = new Map(current)
          next.set(key, token)
          return next
        })
        setNote(null)
        return Promise.resolve()
          .then(operation)
          .then((accepted) => {
            if (accepted === true) {
              setNote({ kind: 'ok', text: successText })
              // 该字段这次真的写成功了：它自己的旧失败才算被解决。别的字段成功不清它 ——
              // 那正是「失败被成功盖住」的原路径。
              setLastFailure((current) => (current !== null && current.key === key ? null : current))
              return { ok: true }
            }
            const message = t('Host 拒绝了这次修改，请检查值或重新打开设置页。')
            setNote({ kind: 'warn', text: message })
            setLastFailure({ key, text: message })
            return { ok: false, message }
          })
          .catch((error) => {
            const message = tf('写入失败：{message}', {
              message: error && error.message ? error.message : String(error),
            })
            setNote({ kind: 'error', text: message })
            setLastFailure({ key, text: message })
            return { ok: false, message }
          })
          .finally(() => {
            setPending((current) => {
              if (current.get(key) !== token) return current
              const next = new Map(current)
              next.delete(key)
              return next
            })
          })
      }, [])

      const commit = useCallback(
        (key, value) => {
          const item = FIELD_GROUPS.flatMap((group) => group.items).find((entry) => entry.key === key)
          return write(
            key,
            () => form.set(key, value),
            tf('已保存 · {label}', { label: item === undefined ? key : labelOf(item) }),
          )
        },
        [write],
      )

      const reset = useCallback(
        (key) => {
          const item = FIELD_GROUPS.flatMap((group) => group.items).find((entry) => entry.key === key)
          write(
            key,
            () => form.unset(key),
            tf('已恢复默认 · {label}', { label: item === undefined ? key : labelOf(item) }),
          )
        },
        [write],
      )

      const applyPreset = (preset) => {
        if (!writable) return
        if (typeof form.mutate !== 'function') {
          // 静默 no-op 会让按钮看起来坏了：明确说宿主不支持批量写。
          setNote({
            kind: 'error',
            text: t('当前 Host 不支持批量写入（configForms.mutate 缺失），请逐项修改。'),
          })
          return
        }
        const ops = Object.keys(preset.values).map((field) => ({
          op: preset.restore === true ? 'unset' : 'set',
          path: [field],
          ...(preset.restore === true ? {} : { value: preset.values[field] }),
        }))
        write(
          'preset',
          () => form.mutate(ops),
          preset.restore === true
            ? tf('已恢复 {title} 默认值', { title: pick(preset.title, preset.titleEn) })
            : tf('已套用 {title} 推荐值', { title: pick(preset.title, preset.titleEn) }),
        )
      }

      const copyConfig = () => {
        setCopying(true)
        setNote(null)
        let copy
        try {
          copy = navigator.clipboard?.writeText?.(configYamlFor(values))
        } catch (error) {
          // 同步抛错（浏览器权限策略、被替换的 shim）也要复位：否则按钮永久
          // 停在「复制中」且 disabled，直到面板重挂。
          setCopying(false)
          setNote({
            kind: 'error',
            text: tf('复制失败：{message}', {
              message: error && error.message ? error.message : String(error),
            }),
          })
          return
        }
        if (copy === undefined) {
          setCopying(false)
          setNote({ kind: 'error', text: t('当前浏览器不允许写剪贴板。') })
          return
        }
        Promise.resolve(copy)
          .then(() => setNote({ kind: 'ok', text: t('已复制当前配置 YAML。') }))
          .catch((error) =>
            setNote({
              kind: 'error',
              text: tf('复制失败：{message}', {
                message: error && error.message ? error.message : String(error),
              }),
            }),
          )
          .finally(() => setCopying(false))
      }

      if (status === 'loading') {
        return h(
          'div',
          { 'data-stage-handoff-root': '', 'aria-busy': 'true' },
          h(
            'div',
            { 'data-stage-handoff-card': '' },
            h(
              'div',
              { 'data-stage-handoff-card-title': '' },
              h(Spinner),
              t('正在读取 Stage Handoff 配置…'),
            ),
            // 「一直在转圈」在用户眼里就是「面板坏了」。扫描台只会在 idle 时读镜像，
            // 而 `ensure()` 复用的是已经卡住的那次 inFlight —— 没有任何东西会重试，
            // 于是这里可能永远停着。超时后给出解释与一个主动重读的入口，比静默转圈好。
            slow
              ? h(
                  'p',
                  { 'data-stage-handoff-hint': '' },
                  t('读取超过 5 秒仍未完成。Host 端的设置镜像可能没有就绪。'),
                )
              : null,
          ),
        )
      }
      if (status === 'unavailable') {
        return h(StaticPanel, {
          reason: t('这个 namespace 没有暴露给当前客户端，无法读取或修改。'),
        })
      }

      const customCounts = (entryTab) => {
        const items = FIELD_GROUPS.filter((group) => entryTab.groups.includes(group.group))
          .flatMap((group) => group.items)
        return {
          count: items.filter((item) => Object.hasOwn(user, item.key)).length,
          total: items.length,
        }
      }
      const activePreset = PRESETS.find((preset) =>
        Object.entries(preset.values).every(([key, value]) => values[key] === value),
      )
      const pendingKeys = [...pending.keys()]
      const pendingItem = FIELD_GROUPS.flatMap((group) => group.items).find((item) =>
        pending.has(item.key),
      )
      const pendingLabel =
        pending.has('preset')
          ? t('推荐方案')
          : pendingItem === undefined
            ? pendingKeys[0]
            : labelOf(pendingItem)
      // 优先级：未解决的失败 > 正在保存 > 上一次结果 > 说明。失败放最前是刻意的 ——
      // 「正在保存」是进行中状态，不能掩盖「已经有一项没保存」这件事。
      const feedback = lastFailure !== null
        ? { kind: 'error', content: lastFailure.text }
        : pending.size > 0
          ? {
              kind: 'info',
              content: [
                h(Spinner, { key: 'spin' }),
                pending.size === 1
                  ? tf('正在保存 {label}…', { label: pendingLabel })
                  : tf('正在保存 {count} 项（含 {label}）…', {
                      count: pending.size,
                      label: pendingLabel,
                    }),
              ],
            }
          : note !== null
            ? { kind: note.kind, content: note.text }
            : {
                kind: 'info',
                content: writable
                  ? enabled
                    ? t('自动保存已开启 · 失焦或按 Enter 写入 Host')
                    : t('入口已停用：保存只改配置，重启 DSH 后才会重新挂载')
                  : t('当前部署把你的配置暴露为只读。'),
              }

      return h(
        'section',
        { 'data-stage-handoff-root': '', 'aria-label': t('Stage Handoff 设置') },
        h(Hero, {
          writable,
          enabled,
          values,
          customCount,
          copying,
          onCopy: copyConfig,
        }),
        h(Stats, { values }),
        h(
          'div',
          {
            'data-stage-handoff-statusbar': '',
            'data-kind': feedback.kind,
            role: feedback.kind === 'error' ? 'alert' : 'status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
          },
          feedback.content,
        ),
        fixedStatus(values, writable),
        h(PresetPicker, {
          activePreset,
          disabled: !writable || pending.size > 0,
          applyPreset,
        }),
        h(TabBar, { tab, setTab, customCounts }),
        panelFor(view, tab, {
          writable,
          pending,
          commit,
          reset,
        }),
        AdvancedHelp(),
      )
    }

    /**
     * 设置页左侧导航行的图标（`settings.section.icon` 槽）。
     *
     * 与 `assets/icon.svg`（插件列表用）同一个锚形，但这里用 `currentColor`：
     * 导航行要跟随宿主主题的前景色，写死颜色在浅色主题下会糊掉。
     * @param {{size?: number, active?: boolean}} props - host supplies the square edge
     * @returns {object} svg element
     */
    function StageHandoffGlyph({ size = 20, active = false }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          'data-stage-handoff-glyph': active === true ? 'active' : '',
        },
        h(
          'g',
          { stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M8 3.2v8.6' }),
          h('path', { d: 'M5.6 5.4h4.8' }),
          h('path', { d: 'M3.1 9.1c.5 2.5 2.2 4.1 4.9 4.1s4.4-1.6 4.9-4.1' }),
          h('path', { d: 'M3.1 9.1h2.1M12.9 9.1h-2.1' }),
        ),
      )
    }

    function StageHandoffSection() {
      const currentForm = useSyncExternalStore(subscribeForm, getForm, getForm)
      if (currentForm === null) {
        return h(StaticPanel, {
          reason: t('当前 DSH 没有向客户端暴露这个设置命名空间。'),
        })
      }
      return h(LivePanel)
    }

    return {
      // 全是 cordis Service —— 不声明就永远拿不到（第一版面板只读就是这个原因）。
      //
      // locale 必须声明：不声明时 cordis 不保证它在 apply 前就绪，而早期版本
      // 还直接读 `ctx.locale`（未声明则永远是 undefined），于是语言一路退回
      // `navigator.language`：中文界面配英文浏览器 → 面板全英文。
      // 声明的代价是「部署里没有 locale 插件时面板不出现」，代价可接受：
      // DSH Web 的界面文案本身就由它提供，宿主一定加载它
      // （package.json 的 dsh.client.inject 也把它列成客户端依赖）。
      inject: ['slots', 'configForms', 'locale'],
      apply(ctx) {
        installStyles(ctx)

        // locale 是**声明的**依赖（见上面的 inject）。cordis 会等它就绪再调
        // apply，所以这里读一次就够了 —— 但读取必须走 `ctx.get('locale')`：
        // `ctx.locale` 只有在 inject 里声明过才可访问，而早期版本读的正是它，
        // 拿到的永远是 undefined，语言于是退回 `navigator.language`，
        // 中文界面 + 英文浏览器就变成了「DSH 中文、面板英文」。
        localeCtx = ctx
        try {
          const viaReflect = typeof ctx?.get === 'function' ? ctx.get('locale') : undefined
          if (viaReflect !== undefined && viaReflect !== null) {
            localeFace = viaReflect
            localeOrigin = "ctx.get('locale')"
          } else if (ctx?.locale !== undefined && ctx?.locale !== null) {
            localeFace = ctx.locale
            localeOrigin = 'ctx.locale'
          } else {
            localeFace = null
            localeOrigin = 'navigator.language'
          }
        } catch (error) {
          localeFace = null
          localeOrigin = 'navigator.language'
          console.warn('[stage-handoff] 读取 locale 服务失败，退回浏览器语言', error)
        }

        // 官方推荐路径：whileServed 会在 Host 的 describe 镜像里出现该 namespace 时
        // 才调 register，并且**顺带触发 mirror.ensure()**。只调 get() 不会主动读，
        // 镜像停在 idle 时所有 form 都会长期停在 status='loading'。
        const forms = ctx?.configForms
        try {
          if (typeof forms?.whileServed === 'function') {
            const dispose = forms.whileServed(['stage-handoff'], (served) => {
              try {
                setForm(typeof forms.get === 'function' ? forms.get('stage-handoff') ?? null : null)
              } catch (error) {
                // 与同文件另两处 catch 一致：异常进日志。否则任何异常（不只是
                // 「namespace 未暴露」）都显示成那句「当前 DSH 没有暴露这个命名空间」，
                // 用户被引向一个与事实无关的方向。
                console.warn('[stage-handoff] 读取设置命名空间失败', error)
                setForm(null)
              }
              return () => {
                setForm(null)
              }
            })
            if (typeof dispose === 'function') ctx.effect?.(() => dispose)
          } else if (typeof forms?.get === 'function') {
            setForm(forms.get('stage-handoff') ?? null)
          }
        } catch (error) {
          console.warn('[stage-handoff] 设置表单订阅失败:', error)
          setForm(null)
        }

        // 主动推一次镜像读取。`ensure()` 在 status==='loading' 时只是复用已有的
        // inFlight，但如果那次读取早已卡死，不会有人重试 —— 面板就会一直 loading。
        try {
          const face = typeof forms?.describe === 'function' ? forms.describe() : undefined
          if (typeof face?.ensure === 'function') {
            Promise.resolve(face.ensure()).catch((error) => {
              console.warn('[stage-handoff] 设置镜像读取失败:', error)
            })
          }
        } catch (error) {
          console.warn('[stage-handoff] 设置镜像读取抛错:', error)
        }

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'stage-handoff',
              order: 90,
              // 设置页左侧那一行也用界面语言。宿主在渲染时调用这个函数，
              // 所以切语言后会重新取；写死 'Stage Handoff' 会让中文界面里
              // 单独一条英文，和整个面板对不上。
              label: () => pick('阶段收尾与锚点接力', 'Stage Handoff'),
            },
            // 包一层错误边界：渲染抛错时保留可读的报错，而不是把右侧整片吞成空白。
            StageHandoffSection,
          ),
        )

        // 左侧那一行默认是宿主给的一个齿轮。注册这个槽就换成插件自己的锚形，
        // 与插件列表里 package.json.icon 用的图形是同一个。
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register(
            { name: 'settings.section.icon', id: 'stage-handoff' },
            StageHandoffGlyph,
          ),
        )
      },
    }
  },
})
