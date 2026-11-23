# Validation

What was actually measured, and what is explicitly **not** claimed.

## Verified

### Offline unit tests

The current offline suite contains 471 tests across nine files. Run on Windows with
Node 24.22.1: **467 passed, 0 failed, 4 skipped** for unavailable Windows/POSIX
link/reservation prerequisites.

The former release-order guard required `market-index.json` to list the exact version
`package.json` declares. That made any "bumped but unpublished" worktree red **by
design** — and `tools/market-index.mjs` refuses to run until that version exists on the
registry (`version <x> has no publish time yet`), so the two states could not be
reconciled before a publish. The guard now requires the index not to *lead* the package
version, which is what the index actually means: it describes published history. A
stale index is still caught, by the release checklist in `RELEASING.md` after the
publish, instead of by keeping the close-out signal permanently red. The earlier
225-test suite also passed on Node 20.20.2, 22.23.5 and 24.22.1 on Windows and Linux x64
(Linux through WSL); those earlier matrix runs do not cover the tests added since, and
Node 20 is no longer supported at all — `zlib.zstdDecompressSync` (added in 22.15.0) is
imported at module load for the session-log fallback, so the floor is now 22.15.0.
They run without a harness and without network:

```sh
npm test
```

A test that stays green when its fix is reverted is not a test. Every fix here is checked
by reverting it and re-running the suite; the 2026-11-21 audit added five and recorded the
pairs:

| Reverted one line | Test that must turn red |
| --- | --- |
| `rejectOnRepeat` reads the per-turn reminder key again | `同一 turn 先轻度后严重：reject 不能被「本 turn 已提醒过」压住` |
| The `skip` dedupe key falls back to `outcome.reason` | `自动压缩退避期间「同一原因只解释一次」不能被倒计时打破` |
| `repeatedRow` defaults to `fenceState: 'outside'` | `repeatedRow 默认按窗口语义解析围栏（起点未知）` |
| `check()` passes `fenceState: 'outside'` | `窗口起点落在围栏内部时，行级判据仍然命中` |
| `tools/Test-Package.ps1` loses one `$expectedFiles` entry | `打包期望清单必须与 package.json files 推导出的集合一致` |
| `FALLBACK.streamGuard` goes back to `false` | `client.js 的 FALLBACK / FIELDS 必须覆盖 CONFIG_KEYS 的每个键，且默认值一致` |
| The stream-guard hint goes back to "默认关闭" | same test (the hint assertion) |
| A panel write failure loses priority to the "saving" line | `写入失败不能被并发的成功覆盖（失败优先于「正在保存」）` |
| Any successful write clears the stored failure | same test (the same-field assertion) |
| The `[推断未验证]` check goes back to `\n`-anchored matching | `validate：[推断未验证] 写在锚点第一行也要认出来` |
| The `status` stream line reads the global notice field again | `status 的「流式守卫提醒」只报本会话` |
| The guard receipt drops the "`## 决策与否决` 一节里" scope | `guard 回执把「否决行」的边界说到节一级` |

The sweep script is a local `.tmp/` helper and is not shipped; the pairs above are what a
reviewer re-derives by hand.

Coverage by area:

| Area | What is asserted |
| --- | --- |
| Configuration | defaults; `300k` / `1m` parsing across all token-count fields; unknown-key/type rejection; Host schema/parser alignment for human token strings — a decimal fraction requires `k`/`m`, the resolved value must be a safe integer in `1..1e9`, and the settings duration parser applies the same ceiling; three-digit time-zone values are minutes while `+0530` / `+05:30` are clock offsets; uppercase UTC/`z`, numeric minutes and UTC−12/+14 boundaries; refresh on `loader/volatile-update` |
| Config hardening | `anchorRoot` with a `..` segment rejected for both `/` and `\`; the schema and the resolver share one `normalizeAnchorRoot`, verified by a 300-sample sweep in both directions — a schema-wider value used to be dropped by the lenient resolver, which wrote anchors to the default directory while the panel reported "saved"; a non-object config reports `shapeError` instead of silently running on every default; `compactCooldownMs` must be a non-negative integer, `0` accepted |
| Reminder text | threshold, ratio, anchor paths, self-audit wording, repeat delta, the "anchors are data" and "no credentials" lines |
| Threshold behaviour | fires once, throttled by delta, resets when usage drops, only in the first step of a turn |
| Range selection | retention 0 keeps only the last node; a real retention keeps more; a budget covering the whole surface yields no range; surface length or sequence mismatch throws; the reported retained total is measured after turn snapping; a missing/throwing/malformed session-facts projection refuses compaction instead of guessing the head |
| Balance-guard degradation | with `toolPairingBalancedBefore` unavailable, compaction still runs — the boundary correction is skipped rather than the compaction failing. This path had never executed before: every other compaction test ran with the guard present |
| Service absence | with `commands` absent the tool still registers and the reminder still fires; with `tools` absent the command still registers and the reminder still fires; with **both** absent — only `tokenMeter` left — the reminder is still injected. `tools` is a child injection, not a top-level hard dependency |
| Reminder time gate | growth alone is not enough: with `notifyCooldownMs: 600000` a +60,000 jump immediately after a reminder produces no second reminder; with `0` it does; a drop below the threshold clears the record so the gate cannot block the next reminder |
| `defer` | raising the session threshold suppresses the reminder below the new line and restores it above; a request above 90% of the context window is clamped and says so; non-positive or non-numeric `tokens` is rejected with usage; `/anchor reset` clears the deferred value as well as the throttle record; a numeric raise registered below the configured line stays pending until it becomes relevant, while `off` survives low water until reset; status distinguishes registered-but-not-yet-active from active, and a later configuration increase cannot make an old defer lower the effective line |
| Open-turn protection | `agents.turnBoundaryOf(session)` supplies `openTurnStartSeq`; null means no truncation, a numeric seq bounds the first surface node after it, and an unavailable/throwing projection fails closed |
| Engine discovery | found through `reflect.store`; absent engine yields diagnostics rather than throwing |
| Compaction call | `compactRegion(start, end, agent, signal)` receives the snapped range; the `/compact` path is **not** used when the engine is reachable |
| Compaction storm | a second compaction inside the success cooldown is refused without touching the engine; `0` disables the success cooldown; a failed attempt starts visible exponential backoff; normal automatic compaction runs at `agent/turn-stopping` with a current turn, while a whole-surface race retries through the same exact engine and never silently falls back to zero-retention `/compact` |
| Compaction accounting | a queued `/compact` that compacts nothing (`kind: success` **without** `sourceEventSeq`) does not start the success cooldown, does not clear a pending failure notice, and does not clear the reminder quota; an emergency `no-op` reports once and still charges the quota, so three consecutive turns produce one reminder instead of three; after three surface races the injected message no longer promises an immediate retry (the backoff gate refuses it); a successful emergency compaction clears the previous failure record |
| `defer` vs emergency compaction | occupancy between the emergency line and a deferred line does not inject the close-out reminder even when the emergency attempt fails or no-ops; `defer tokens="off"` also suppresses it and the text never quotes `9,007,199,254,740,991`; a low-water step that is carrying a turn-stopping failure does not mark the defer as activated |
| Anchor read identity | the lstat/fstat `ino`/`dev` comparison is taken with `{ bigint: true }` on both sides, and a static contract test fails if `Number.isSafeInteger` comes back as the guard — on NTFS the guard made the swap-detection branch unreachable (fail-open) |
| Guard baseline | ordered markdown lists (`1.` / `2.`) count as guarded rows, matching the style the scaffold itself uses in `## 下一步`; an untouched scaffold's angle-bracket placeholder is not counted as an executable next step; deleting one of two identical baseline entries does not invent a "tag changed" note |
| Summary readback | summary and tool facts come from a 5,000-event memory ring fed by committed `session/event` values; the checkpointed projection contains surface structure only; exact-type and summary-shaped migration records both match; sparse/non-contiguous returned seqs remain supported; a miss reports returned count, actual seq range, candidate counts and type distribution |
| Event-ring evidence | each session reports mount/first/last sequence and permanent count/byte truncation flags; late mount is `partial-since-mount`; a 2 MiB session budget trims to `partial-truncated`; summary text processes at most 4,096 blocks, is capped at 65,536 UTF-16 code units (the constant counts code units, not bytes) and is marked partial when either bound truncates it; a ring whose object lacks a `hasGap` field derives the gap from seq continuity instead of assuming none; tool-fact derivation scans at most the newest 5,000 events and reports `partial-window` rather than `complete`; hot disable stops new ring updates |
| Fallback | engine unavailable during manual `compact` → diagnostics reported, `/compact` queued, and the caller is told; automatic mode records a visible failure/backoff instead of silently changing retention semantics |
| Tool schema | input/output are standard supported JSON Schema; action/scope enums and integer count fields are declared; invalid `retainTokens` throws instead of silently falling back; `defer` below the configured line and above the window ceiling is rejected |
| Client plugin contract | client entry/late namespace/theme/accessibility/tab contracts; per-field reset and presets; time-zone coercion distinguishes string offsets from numeric minutes, and the time-zone **dropdown** covers local / utc / every whole hour / two half-hours while a value outside the list is kept as `当前值`; token parsing matches the Host for `1.5` / `1.5k` / `.5k` / `0` / `-1` / `1e5` / comma and space forms; rejected writes restore the current snapshot draft and show an inline error; usage UI renders every active workspace returned by the authenticated route |
| Anchor usage walk | depth, entry-count and time limits each truncate with a stated `reason`; a missing root returns `exists: false` rather than throwing; a file root is refused with a reason; nested files are counted; `formatBytes` uses binary units |
| Usage action | the tool reports a missing directory as "not created yet" instead of failing, then reports the real size once the directory exists |
| Session storage walk | streaming `opendir` walk over `session.*` files only; missing/unreadable roots are distinguished; symlinks are skipped; partial trees report `truncated`; results sort by size and cap at 200 sessions |
| Settings registration / enabled | `configure({ auto: false }, fiber)` once; `enabled` remains volatile and true→false disables pre-step, tool execute, `/anchor`, queued status handling, and the usage route with HTTP 503 while warning that registrations remain mounted; missing optional services degrade independently |
| Cleanup scan | per-stage `parent-backup/` lookup; timestamped names are candidates, unknown names are listed but never candidates; missing/unreadable/linked roots are distinguished; streaming entry/time/output caps; `keep: 0` still deletes nothing; suspected incomplete stages are reported for human review |
| Scaffold | atomic hidden-sibling build then publish; a pre-existing empty stage is preserved on POSIX as well as Windows; a stale POSIX reservation sidecar recovers only an owned empty reservation and never removes a non-empty stage; linked/root/system targets are refused |
| G2 pre-step | payload `turn`/`step === 1` drives one check per turn even when `agents` is unavailable; a corrupt v3 guard or unknown v3 source/status tag is `baseline-format` rather than fake drift; G2 and the close-out reminder can coexist; optional JSONL diagnostics stay within 256 KiB, rotate to `.1`, serialize concurrent in-process writers, reject links on every append (not only the first), survive BigInt/circular input, and redact thrown errors |
| Stage clock | `anchorTimeZone` accepts `local` / `utc` / `z` / offsets / numeric minutes, rejects UTC−12/+14 boundary overrun and zone names; UTC scaffold and the panel's string/number coercion are tested |
| Find session | mirrors DSH `~XXXX` SessionId path encoding, supports custom IDs containing spaces/Unicode/separation characters without path traversal, skips links, caps output and reports no match |
| Compaction outcomes | success / no-op / skipped / cancelled / failed are distinct; no compactable range never enters failure backoff; a durable success followed by turn cancellation remains successful; manual compact forwards `exec.signal`; success cooldown is recomputed from live configuration |
| Stage discovery | one bounded scanner counts all directory entries, caps at 2,000 entries / 3,000 ms, reports truncation, and explicit-stage operations bypass enumeration; incomplete scans are never used to guess a latest stage |
| Anchor safety and matching | all anchor content reads go through one link-rejecting, realpath-bounded, 1 MiB layer that consumes at most `maxBytes + 1` from the opened handle; diagnostic reads pre-check size and file type; fenced examples are excluded from every structural regex; guard uses version-3 text/source/status multisets; repeated removals and tag changes are detected; reconcile reports exact vs prefix16 |
| Usage route | reports all distinct active workspaces (max eight) with explicit project paths instead of guessing the currently viewed session |
| Configuration coherence | `status` warns on an unreachable reminder line, oversized repeat/retention budgets, and anchor-limit extremes |
| Reminder safety | the close-out reminder preserves deletion/elevation/deployment/network approval boundaries |
| Documentation links | every relative link in the shipped markdown resolves to a real file; `README.md` links both language versions and both exist; the README release URL names an asset that contains the current `package.json` version (it once said `dsh-stage-handoff.tgz` while the build produces `dsh-stage-handoff-<version>.tgz`, which 404s) |
| README navigation | every document that ships is reachable from `README.md`, not only the two language versions — `CONTRIBUTING.md` in particular, because the three hard constraints live there |

The client contract tests are static on purpose. A broken client entry fails in the
**browser**, not in Node, with `loaded without registering "<id>" via
__ModuleLoader__.load` — so the shape is pinned here instead.

### DSH 0.2.2-rc.1 source-contract audit — 2026-11-16

This pass did **not** execute a real compaction or restart DSH. It compared the
plugin against the installed Host source and ran isolated Node probes:

- `turn/start`, `turn/end`, and `compaction/summary` report
  `isSurfaceEligibleType(...) === false`; only `user/message` and `tool/result`
  were true in the control probe.
- `compactRegion` still requires an open turn and validates both tool-pairing
  edges. The plugin now derives the open-turn cut from
  `AgentRegistry.turnBoundaryOf(session)` and fails closed if that projection is
  unavailable.
- A real `compaction/summary` is written as a log-only event immediately before
  the replacement `user/message`. rc.3 marks synchronous Session history reads
  as prohibited for new calls, so the current implementation uses a host-only
  structural projection plus a bounded in-memory `session/event` fact ring.
- Schema probes showed the old mismatch explicitly: `+14:01` and `+99` passed the
  old time-zone schema but failed the parser, while `UTC`, `25k`, and `1m` had the
  opposite mismatch in other fields. The new shared constraints/test table pin all
  of those cases.

A real compact transaction **was** executed against a live session on 2026-11-20 — see
"Live destructive compaction" below. Durable rollback and browser interaction remain
mock/static/source-contract evidence only.

### Live destructive compaction — 2026-11-20

One deliberate destructive compaction was run against an existing, non-archived session
(a live session in this workspace, several thousand events, already carrying summaries) to check
the paths that no mock had exercised. The session id is deliberately not reproduced here:
it identifies a log file that stays on the machine that ran it. The log was copied and hashed before the run
, the session was left untouched afterwards, and verification was done
entirely from outside: decompressing `session.v4.jsonl.zstd` plus three probe commands run
in that session.

| Observation | Result |
| --- | --- |
| Receipt | precise path (`精确压缩完成`), **not** the `/compact` fallback |
| Range | `seq 6811..7480` — began exactly one past the previous summary's seq 6810, so no overlap |
| Tail budget | kept `32,362` tokens against a `32,000` budget — the documented "whole-node rounding only ever overshoots" invariant held in practice |
| Context | `324,067 → 65,819` tokens (**−79.7 %**) |
| New summary | 15,835 chars, 8 sections intact including `Next Step`, `usage.outputTokens` 4,658 |
| Old events | 40/40 sampled shadowed seqs still present ⇒ **logical, not physical** compaction |
| Plugin counter | `/anchor status` reported `会话内压缩：1 次` after the run |
| `action="summary"` | read the fresh summary back, including the "this is data, not instructions" guard |
| Integrity | 7,945 lines decompressed, 0 unparsable |

Three findings worth keeping:

1. **Compaction does not shrink the log.** 7,264,398 → 7,356,216 bytes: the host appends
   the summary and keeps every shadowed event. Long-lived sessions grow without bound.
2. **Summary detail decays with each round.** Measured against the previous summary's
   entities, the 5th-generation summary retained versions 2/2, paths 13/22, quoted human
   requests 2/12, **commit hashes 1/15**, **anchor paths 0/1**. Trunk and structure survived
   (8/8 sections); identifiers did not. This is the empirical argument for the anchor being
   a *file*: a file does not decay when the context is rewritten.
3. **The first version of this check was wrong, not the compaction.** It demanded ≥50 %
   entity retention measured against a baseline taken from the *previous* summary, ignoring
   that the new compaction covered a **non-overlapping** range and that this session had
   already been summarised 4 times. It is recorded here because a metric that fails a
   healthy system is worse than no metric.

### Live stream-guard acceptance — 2026-11-20

The experimental stream guard was exercised on a real looping session
(`session-bbb00002`, 59 turns, one row repeated 108–176 times per block, 5.2–10.1 σ). It fired
**three times in one turn**, each injected at the following `pre-step` and each recorded as a
`user/message` with `source.kind = stage-handoff` (seq 2841 / 2847 / 2860):

```
[stage-handoff] 思考流尾部有一行内容已重复 77 次（占 95 行里的 81%）。
```

The step after each notice still generated normally (984 characters of reasoning plus 1,132
characters of reply), confirming the guard reports and never truncates.

Three defects were only findable this way, and all three are now covered by tests:

1. **The listener never fired.** `agent/assistant-stream` is `this: Scoped<Agent>`; without
   `{ global: true }` the callback is never invoked and nothing errors. Before the fix the delta
   counter read `0` across entire turns; after it, `988`.
2. **The criteria missed the dominant loop shape.** A main period interrupted by periodic
   insertions (`好。 好。 好。 （输出） 好。 好。`) defeats strict-period matching — all ten blocks
   returned `null` while repeating 108–176 times. Row counting now catches it; replaying the real
   blocks fires 10/10.
3. **Notices accumulated.** Dedupe keyed on `turn:step` emitted one notice per step. Now one per
   turn, and the dedupe slot is per session (turn numbers restart at 1 in every session).

Caveat on how this was measured: the plugin's own session-log observer initially reported zero
notices because it read `data.message.content` for `user/message` events, whose payload is
`data.content` (only `assistant/message` nests under `.message`). The three notices were always
there. Recorded because "the feature is broken" and "my instrument is broken" look identical from
the outside.

### Does a notice actually help? — 2026-11-21

The acceptance above only showed that notices **fire** and do not truncate. It never showed they
**work**. Measured across every injected notice that has reasoning blocks on both sides — **65
samples**, comparing the 3 blocks before against the 3 after:

| | Before | After |
| --- | --- | --- |
| σ deviation (`dev`) | 1.60 | **1.44** |
| Row repeat ratio | 0.22 | **0.18** |
| Block length | 722 chars | 523 chars |

Averages improve, which is the number that would go in a README. The per-sample picture is the real
answer:

| Direction (Δσ ≥ 0.5) | Samples |
| --- | --- |
| Got cleaner | **13** |
| Unchanged | **34** |
| Got worse | **18** |

So the effective rate is roughly **20 %**; more than half of all notices change nothing measurable;
and **18 of 65 cases got worse after the notice**.

The 18 regressions are consistent with why `describeStreamVerdict` never quotes the repeated
fragment — restating a loop can reinforce it (the positive-feedback mechanism in Holtzman et al.).
The current copy already avoids restating, and a quarter still degraded.

Caveats that bound the claim: the sample is defined by how often notices fired, not by session
count; a notice is often followed by compaction, which shortens blocks (though `dev` is already
length-normalised against same-length Chinese text); and "unchanged" may mean the notice arrived
while that block was already being generated.

**Conclusion recorded as a limitation, not a defect**: one short sentence is a weak intervention.
Strengthening it is a design question (timing, or acting rather than describing), and it is not
solved here.

### Live DSH settings acceptance

The installed plugin was also exercised against DSH `0.2.2-rc.1` in the local web
profile on Windows using Node 24.22.1:

- DSH started with empty plugin stderr/stdout logs; the previous
  `enabled 必须是布尔值` activation failure did not recur.
- The authenticated PWA showed a dedicated **Stage Handoff** settings section.
- The redesigned panel rendered with DSH theme tokens: summary hero, three metric
  cards, sticky save status, a fixed `enabled` status pill, and Reminder /
  Compaction / Anchors-and-storage tabs.
- UI Automation saw non-empty accessible names for the visible text fields; the
  Reminder, Compaction, and Anchors-and-storage tabs all selected and exposed their
  expected controls. The boolean control reported `role=switch` with state `On`.
- Temporary startup probes confirmed that `tools.register()` returned normally and
  that `get`, `definitions()` and `schemas()` all contained `stage_handoff`, both
  globally and in two live agent scopes. The model-facing parameter schema was then
  corrected from an author property-map to standard JSON Schema
  `{ type: "object", properties, required: ["action"] }`. All temporary
  `console.error` and agent probes were removed before final packaging.
- `notifyTokens` was changed from `300000` to `250000`. The host wrote
  `notifyTokens: 250000` to the profile's `cordis.patch.yml`, the panel eventually
  showed **已保存**, and leaving/reopening the section still showed `250000`.
- The value was then changed back to `300000`; because that equals the inherited
  default, the host removed the temporary profile row and the form still rendered.
- The **256k preset** atomically wrote `notifyTokens: 92000`,
  `compactRetainTokens: 8000`, and `anchorLimitChars: 5000`, exposed its active
  state, and showed the preset confirmation. All three presets (256k / 512k / 1M)
  write **explicit** values — none of them uses `unset`.
- A direct `275000` threshold edit exposed the field-level reset button; invoking
  it restored the default, showed **已恢复默认 · 触发阈值**, and removed the
  profile override row.
- **Copy YAML** displayed its confirmation. The test did not read clipboard
  contents back.

The local handoff evidence directory retains screenshots from this run. The
authenticated browser cookie and credential files were not read, copied, or logged.

### Type checking

```sh
npm run typecheck   # tsc --noEmit
```

Zero errors across `lib/` and `test/` with `allowJs` + `checkJs`. Note that
`strict` is off: the goal is catching structural mistakes in a JavaScript file that
talks to an untyped host API, not full type safety.

### Probes

Four failures kept escaping every static check, so each got an executable probe
(`pwsh -NoProfile -File tools\Probe.ps1`, or `npm run probe`). They print
diagnostics rather than asserting, and exit non-zero so they can gate a release.

| Probe | Catches |
| --- | --- |
| `locale-coverage` | a Chinese `t()`/`tf()` literal with no English entry, or a dead entry in the table |
| `render-smoke` | text rendered in the wrong language. It executes the real panel with stub hooks and collects every text node, which is the only way to see "the table has English but the code never asked for it" — the three tab buttons passed `entry.label` instead of `pick(entry.label, entry.labelEn)` and stayed Chinese in English mode |
| `client-boot` | the client factory throwing at module scope — the failure that renders an empty settings page. The host evaluates factories lazily, so neither `tsc` nor `node --check` sees it |
| `thinking-loops` | reasoning that degenerated into `好。做。好。做。` repetition, read from session logs |

`client-boot --installed <dir>` and `render-smoke --installed <dir>` point the
check at the package actually installed in a profile instead of the repository
source. That is the check to run after an install, because it exercises the same
file the host will load.

`test/regressions.test.mjs` holds the cases that only exist because a fixed defect
once came back. Each one runs through the **production** call path rather than the
function underneath it: the event-ring `hasGap` bug survived because its test fed
the raw ring straight to `coverageForRange` and stepped around the normalizer that
was dropping the flag.

Two things make `render-smoke` non-obvious. `createElement` only produces element
objects, so the walker has to call function components by hand — a first version
did not, and cheerfully reported zero text nodes and a clean panel. And the text
collection is asserted in `test/render.test.mjs` for both languages, so the
failure cannot quietly return.

The repetition criteria live in `lib/repeat-scan.js` and are covered by offline
tests. They were corrected three times against real data: code lines must be excluded
(` ``` ` repeats constantly in code-writing thoughts and was flagged as a loop),
a fragment block must consist entirely of filler words — a one-sentence
40-character thought is short but not degenerate — and wordless placeholders must be
counted even though they are not filler words. The third correction came from a session
where the model, having noticed it was looping, stopped writing `做。` and substituted
`（...）`: both original signals keyed on word-bearing filler lines, so the swap made the
density *worse* (57 % → 97 % of lines) while making it **invisible**. `placeholderShape`
now counts repeated wordless short lines under two measured gates (12+ occurrences, and
those lines making up ≥ 40 % of the block), skipping fenced code with the same state
machine as `proseRows` — without that, twelve ` ``` ` markers in an ordinary "now edit
this file" thought produced a false positive. Half-width `(...)` is the extreme case: it
contains `(`, so `isCodeish` deletes the line and `repeatRatio` is exactly 0.

Re-measured over every session log on the machine (245 sessions, 41,269 reasoning
blocks): the new criterion hits one block and changes no turn verdict (137 suspicious
turns before and after). It is therefore additive coverage for a form that has not yet
appeared unmixed, not a reclassification of existing results.

### The verbatim tail no longer keeps the loop

Retention is what changed, not compaction. `selectRetainedRange` now takes the event ring
and drops degenerate reasoning from the retained tail under two gates: the block's turn must
already be judged suspicious, and the block itself must be degenerate with the *same*
thresholds as the turn-level signals — a test asserts the two agree, because a drift between
them produces the worst outcome (a turn called suspicious with nothing selectable to drop).

Measured over 245 session logs / 41,316 reasoning blocks: 2.31 % of blocks are degenerate on
their own; of the 2,592 blocks inside the 137 suspicious turns, 826 (31.9 %) are excluded, and
12 turns are degenerate end to end — their reasoning disappears entirely while their tool
calls and results stay paired, which the host's balance guard enforces regardless. With no
ring available the selection behaves exactly as before, so missing evidence degrades to
keeping history, never to deleting it.

The case that motivated it: a `/compact` that stopped a 19,211-character repetition kept
that block outside its shadowed range, the resulting 22,849-token context was more than half
repetition, and six turns later one block reached 65,928 characters. Excluding means the
block falls *inside* the shadowed range, so the summarizer still reads it.

### Detection is language-independent

Both form signals are built on *lines* (`isFiller` needs a word character, `tiny` needs every
line to be filler), so an English loop — which repeats **inside** one line — scores 1 prose row,
0 fillers and 0 % line repetition: every signal dead at once. A 359-character synthetic sample
(`Let me do it now.` ×20) confirmed it: the old criteria reported nothing at any threshold.

The shape now carries `compress` (deflate length / raw byte length). LZ77 encodes a repeated
substring as a back-reference, so mechanical repetition collapses the compressed size while
varied prose does not move; it needs no tokeniser and no language test. Measured separation over
36,631 blocks ≥200 characters: severe loops 0.018–0.038, normal blocks p01 = 0.325, p50 = 0.599.
Threshold 0.2 for detection, 0.15 for exclusion.

**The gate is the non-obvious part.** Compression alone flags structured code: `40 × { if (flagN)
{ result.push(valueN) } }` compresses to 0.130 and a `- ✓ done` checklist to 0.065 — the same band
as real loops. So the signal requires prose rows to be the majority of non-empty rows. Fifteen
offline cases in `test/probes.test.mjs` pin both directions.

Exclusion was tightened with the same measurement: the previous bar (`isLoopBlock`) hit 955 blocks
corpus-wide, but **660 of them compress above 0.3** — mixed blocks where a real repeat sits inside
substantive content. `isRetentionHazard` (compression ≤0.15 **and** prose-majority) selects **67
blocks instead of 955**. Control-variable run on identical logs: 137 suspicious turns → 143,
137 identical, six new, **zero regressions**; all six were already "single-block repetition
88–97 %" and merely lacked a second reason.

Scale, measured: 3,827 turns, 41,408 blocks, 68.5 M characters; 143 turns loop (3.7 %), but only
**67 blocks / 397 k characters are severe (0.58 %)**. The English bucket holds zero severe blocks
— this machine has never produced one, so that path is verified synthetically only.

Per PREWARN (arXiv:2611.16803), text repetition metrics detect a loop only after its first cycle
completes; this plugin claims detection, **not early warning**, and the statistics above are
reported per turn and per block so a length confound stays visible.

### Real-session measurement

One real long-running session compacted through this plugin:

| | |
| --- | --- |
| Before | 637,733 tokens |
| After | 149,146 tokens |
| `compaction/start` seq | 3957 |
| `turn` field | `97` (a number) |
| `sourceCommandId` | absent |

The last two lines are the evidence that this went through `compactRegion` and not
`/compact`: the command path always writes a `sourceCommandId` and a `null` turn,
because `compactNow` runs outside any turn.

### Repetition and context size are independent

Measured across 40 sessions and 1,704 turns with `tools\probes\thinking-loops.mjs`
over `data/sessions/**/session.v4.jsonl.zstd`:

| Window | Turns | Looping turns | Rate |
| --- | --- | --- | --- |
| before a session's first compaction | 369 | 3 | 0.8% |
| after it | 1,335 | 109 | 8.2% |

Compaction raises the rate tenfold, but the loop does **not** track context size.
One session ran 452k tokens with clean reasoning; another looped at 114k. Across
turns, 74% of looping turns sat under 5k tokens versus 73% of clean ones — no
signal at all. The correlates that do hold are long turns (46% of looping turns had
15+ steps versus 30% of clean ones) and waiting on background jobs (25% versus 14%).

This is why retuning `notifyTokens` or `compactRetainTokens` cannot fix a loop. What
does help: a stronger model (one `deepseek-v4-pro` session ran 26 compactions over
390 turns at 1%), shorter turns, and not spinning on `job_output` while a task
finishes.

Because compaction is the last moment the reasoning is observable — afterwards it is
replaced by a summary — the `compact` action snapshots the reasoning shape first and
reports the verdict, and `status` carries the same line.

### Package contents

```sh
npm pack --dry-run
```

The artifact contains only the declared runtime and documentation files; tests,
tools, lockfiles, and `node_modules` are excluded. The exact size and hash are
printed by `tools\Pack.ps1` on every run; the release attachment name must stay
`dsh-stage-handoff-<version>.tgz`.

## Not verified

Being precise here matters more than the list above.

| Not claimed | Why |
| --- | --- |
| Multi-version compatibility | Only DSH `0.2.2-rc.1` was exercised. `ctx.reflect.store` and `fiber.provisions` are internal structures; another harness version could rename them. |
| macOS | Windows and Linux x64 were exercised, but no macOS filesystem/browser run was performed. |
| Third-party benchmark | No comparison against other compaction plugins, and no measurement of task quality with or without verbatim retention. |
| Better outcomes than plain summarization | The only measured claim is the size of the retained tail, not whether keeping it improves results. |
| Long-run stability | One compaction was measured end to end. Repeated compactions, anchor archiving chains, and multi-day sessions were not. |
| Settings-panel behavior outside the local PWA | The form was rendered, edited, saved, reopened, and restored in the local authenticated DSH `0.2.2-rc.1` PWA. Remote-authority, mobile, and non-Chrome browser layouts were not exercised. |
| Concurrent sessions across processes | Per-session isolation, two different sessions in one process, and automatic-mode reentrancy are tested. Two DSH processes compacting the same durable session are not exercised. |
| Exclusion during a real compaction | **Verified 2026-11-20** on `session-bbb00002`: `stage_handoff(action="compact")` produced an engine-side compaction and the receipt read `已剔除 3 个复读块`, with `compaction/start` carrying no `sourceCommandId`. The retained tail came out at 86 tokens against a 32,000 budget — that is exclusion working as intended, not a defect: long reasoning degradation can trigger a known harness-level truncation (the turn reports `completed` while the user sees an unfinished reply), and the remedy is a hard compaction that discards the degraded content. Still untested: repeated exclusion across many compactions, and exclusion on an English or mixed-language loop. |
| The stream guard on a non-Chinese loop | Every real loop observed so far is Chinese. The row-counting criterion is language-independent by construction, but no English or mixed-language loop has been fed to it live. |
| `rejectOnRepeat` interrupting a real turn | Unit-tested only: the same loop yields `kind: 'reject'` with the option on and `kind: 'enter'` plus one reminder with it off. The option ships **off**, so no live session has been interrupted by it, and the cost of a false positive — one real turn ended — has not been observed in practice. Turning it on is an operator decision, not a tuning step. |
| The cross-block criterion in the status readout | It runs in `assessTurn` (offline analysis and probes) and was measured over 239 sessions, but `scanEventRing` cannot use it: the event ring deliberately keeps shapes rather than text. Wiring it into `action="status"` would mean changing that byte budget. |

## Reproducing the checks

```sh
npm install
npm run check          # typecheck + tests
npm pack --dry-run     # inspect the artifact
```

### Reproducing CI exactly

The workflow defines four steps on Linux and Windows with Node 22 and 24:

```sh
npm ci              # requires package-lock.json to match package.json exactly
npm run typecheck   # tsc --noEmit
npm test            # node --test — 471 tests across nine files
npm pack --dry-run  # file list only
```

`npm ci` deletes `node_modules` first, so it is the one step that can leave a
checkout worse off if it fails. Its inputs are pinned in `package-lock.json`
(lockfileVersion 3, three direct development dependencies), which matches
`package.json` exactly.

**GitHub-hosted verification.** Commit `98f2743` passed
[CI run 44235145212](https://github.com/WphiontaS/dsh-stage-handoff/actions/runs/44235145212)
on all six matrix jobs: Ubuntu and Windows with Node 22 and 24. In every job,
`npm ci`, Type check, Unit tests and Package contents completed successfully.

**Scope of that evidence.** Local pre-release builds (`0.1.0-local.N`) are cut from
a working tree that is committed locally but not pushed — this machine has no
network access to GitHub — so the CI link above always names an earlier commit than
the one being built. Treat the six-platform run as evidence for the commit it names,
and re-run CI after the next push.

**What CI does not cover.**

- **The structural tarball check.** `tools\Test-Package.ps1` is PowerShell and runs
  on Windows only. CI's `npm pack --dry-run` prints the file list but asserts nothing
  about the client entry, the declared `files` entries, or the absence of development
  files. Run that script before a release.
- **macOS-hosted runner execution.** Linux and Windows are covered by GitHub
  Actions and the local six-way matrix; macOS remains unverified.

To test the compaction path against a real harness, install the package into a
throwaway profile rather than the one in use — see [RELEASING.md](RELEASING.md).
