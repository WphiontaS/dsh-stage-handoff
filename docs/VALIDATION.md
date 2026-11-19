# Validation

What was actually measured, and what is explicitly **not** claimed.

## Verified

### Offline unit tests

The current offline suite contains 365 tests across seven files. The
release-candidate worktree was re-run on Windows with Node 24.22.1: 356 passed,
4 were skipped for unavailable
Windows/POSIX link/reservation prerequisites, and none failed. The earlier 225-test
suite also passed on Node 20.20.2, 22.23.5 and 24.22.1 on Windows and Linux x64
(Linux through WSL); those earlier matrix runs do not cover the tests added since.
They run without a harness and without network:

```sh
npm test
```

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
(a live session in this workspace, 7,919 events, already carrying 4 summaries) to check
the paths that no mock had exercised. The session id is deliberately not reproduced here:
it identifies a log file that stays on the machine that ran it. The log was copied and hashed before the run
(`sha256 1E5455DB…`), the session was left untouched afterwards, and verification was done
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
tests. They were corrected twice against real data: code lines must be excluded
(` ``` ` repeats constantly in code-writing thoughts and was flagged as a loop),
and a fragment block must consist entirely of filler words — a one-sentence
40-character thought is short but not degenerate.

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

## Reproducing the checks

```sh
npm install
npm run check          # typecheck + tests
npm pack --dry-run     # inspect the artifact
```

### Reproducing CI exactly

The workflow defines four steps on Linux and Windows with Node 20, 22 and 24:

```sh
npm ci              # requires package-lock.json to match package.json exactly
npm run typecheck   # tsc --noEmit
npm test            # node --test — 365 tests across seven files
npm pack --dry-run  # file list only
```

`npm ci` deletes `node_modules` first, so it is the one step that can leave a
checkout worse off if it fails. Its inputs are pinned in `package-lock.json`
(lockfileVersion 3, three direct development dependencies), which matches
`package.json` exactly.

**GitHub-hosted verification.** Commit `98f2743` passed
[CI run 44235145212](https://github.com/WphiontaS/dsh-stage-handoff/actions/runs/44235145212)
on all six matrix jobs: Ubuntu and Windows with Node 20, 22 and 24. In every job,
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
