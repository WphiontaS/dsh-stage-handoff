# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.2] — 2026-11-23

### Fixed — path scrubbing failed on two shapes of input, and four error paths bypassed it

`elidePathsIn` (the function every model-visible error and every diagnostic line goes
through) had two holes, both measured:

- **Paths containing spaces were half-scrubbed.** The character class excluded all
  whitespace, so `scandir 'C:\Users\John Doe\proj\docs\anchors\x'` became
  `<path>/Users/John Doe\proj\docs\anchors\x` — the drive letter was replaced, the
  username and project name stayed, and the result *looked* sanitized. Intermediate
  path segments now allow spaces; the last segment does not, so `C:\a\b for details`
  is still not swallowed.
- **The POSIX root list had drifted from `shortenPath`'s.** `ABSOLUTE_PATH` knew
  `workspace|work|private|Applications|…` (28 roots), `elidePathsIn` knew 8 — so a
  container workspace at `/workspace/proj/docs/anchors/x` passed through untouched
  even though `shortenPath` handles it. Both now share one `POSIX_ROOTS` constant.

Four error paths quoted `error.message` raw into model-visible output:
`usage.js` (root unreadable), `cleanup.js` (parent-backup unreadable),
`prestep-log.js` (`lastError`, which `status` prints, and the serialization notice).
They now go through the same `elidePathsIn` / `redactSecrets` pair as `describeError`.
`measureSessions` also stopped printing the full encoded workspace key
(`--D-Users-me-proj--`) in its `reason` — it shortens it the same way its own summary
already did.

`docs/PRIVACY.md` said "nothing in `lib/` reads a session log file". The log fallback
added earlier does exactly that; the document now describes it (path, whose session,
when, byte cap, what is kept) and lists the drift reminder's quoted anchor lines, the
scaffold skeleton's session ID and absolute paths, and `reconcile`'s summary headings
as disclosures.

470 tests / 466 pass / 0 fail / 4 skip.

### Changed — the default reminder line is now the wall's half, not a lookalike

`DEFAULT_NOTIFY_TOKENS` moved 360,000 → **363,520**, which is exactly
`hostCompactionWall(1_048_576) / 2`. The old number was tuned as 36% of a 1M window and
missed the half-wall by 1%; the presets had already moved to the explicit relationship,
so the design carried two numbers for one thing. Now the default, the `1m` preset and
the docs all say 363,520. Anyone who set `notifyTokens` explicitly is unaffected — a
profile that pins 360000 keeps 360000.

### Fixed — `reconcile` crashed when it had to fall back to the log

The log-fallback path added above had one leftover reference: the summary line still
read `summaryWindow.summary.length`, which is `undefined` exactly on that path. The
result was `Cannot read properties of undefined (reading 'length')` instead of
reconciliation output. Caught by running it on a real host immediately after restart —
the offline suite missed it because no test drove `reconcile` through the fallback.
There is now a static regression test that pins the rule (the reconcile branch may
read `summaryWindow.summary` once, to initialise `summaryText`, and never dereference
it), plus the fallback source is now printed in the output.

### Changed — panel usability, timezone-consistent day math, and one exit for every error message

- **Byte and duration fields are no longer typed by hand.** `guardMaxBytes` and
  `staleReservationTtlMs` asked for `1048576` and `86400000`; they now render as
  `1 MiB` and `1 天` with a unit dropdown (bytes / KiB / MiB / GiB, and days / hours /
  minutes / seconds / ms). Switching the unit converts and saves immediately, the same
  way the token fields already worked.
- **The suggestion chips no longer squeeze the input box.** `hostMaxTokens` has four
  quick-fill buttons; they shared one flex row with the input, so the input was
  compressed to a couple of characters and its value could not be read. The chips now
  wrap onto their own line and the input has a floor width.
- **Tab counts read `3/12` instead of a bare number.** They count *customized* fields,
  not field values, and a bare digit read like "this tab has 4 items". Editing an
  already-customized field still does not change the count — that is correct, the count
  is about which keys were overridden.
- **`validate`'s 30-day staleness check now uses `anchorTimeZone`.** It compared a
  local-time "now" against a local-midnight annotation date, so the same anchor could be
  29 days old on one machine and 30 on another — enough to flip the warning.
- **POSIX no longer accepts Windows-style absolute paths.** `anchorRoot: D:/x` used to
  pass the check and then resolve relative to the working directory, silently creating
  `<workspace>/D:/x`. On POSIX only a leading `/` is absolute now.
- **Every error message goes through one redacting exit.** `describeError` was a local
  helper that only prepended a prefix; 68 call sites (19 of them writing to the log)
  interpolated `error.message` raw. It is now module-level and runs
  `redactSecrets(elidePathsIn(...))` plus a 300-character cap, so exception text cannot
  leak absolute paths or credentials into logs, status output, or the panel.
- **Dropped config fields now say why.** `resolveConfigLenient` reported only key names,
  so "unknown key" and "converted value exceeds the cap" produced the same message. It
  carries a reason per field now.
- **`tools/Sync-Profile.ps1`** installs a build into a DSH profile. `pnpm install`
  cannot: the lockfile records this `file:` dependency as a path with no integrity
  hash, so every install command reports "Already up to date" while `node_modules`
  keeps the old files — which makes a rebuilt plugin look unchanged after a restart.

### Added — `hostMaxTokens` accepts `auto`, resolved from the host instead of guessed

- **`hostMaxTokens` accepts `auto`.** Instead of trusting a hand-written number, the
  plugin asks the host, first hit wins: `agent.options.maxTokens` (the per-request cap
  the host has already settled) → `llm.resolveModelInfo(provider, model).defaultMaxTokens`
  (what the adapter declares, `256e3` for DeepSeek) → the built-in 256,000 with an
  explanatory line. Answers are cached per `provider/model`, so the lookup costs one
  query per model rather than one per pre-step. When neither source is available the
  plugin falls back to 256,000 and `status` names which of the three was used:
  `输出预留 hostMaxTokens 256,000（model deepseek/chat 的 defaultMaxTokens）`.
- **The wall now enforces the harness's second constraint.** `resolveCompactSpec`
  requires `retainTokens < thresholdTokens`, where
  `retainTokens = floor((window − hostMaxTokens) × 0.16)`. On narrow windows that fires
  before the pressure-budget check: at `window = 321,537` the formula yields a wall of
  **1** while the retain is 10,485, so the host throws — and `status` used to print
  "host compaction wall 1 tokens". Such windows now report the wall as non-existent.
  Verified against a reimplementation of the host's own spec at ten window sizes.
- **`hostMaxTokens` no longer needs to be guessed when models change.** The docs now
  spell out that the default is decimal 256K (`256e3`), not 262,144 — mixing a
  power-of-two window with a decimal output cap is what makes 727,040 look wrong when
  checked by hand.

### Fixed — a reachable-reminder regression and two tests that could not fail

- **With an unreadable window, the emergency line fell below the reminder line.** It
  fell back to `compactRetainTokens × 4` (128,000) while the default reminder line is
  360,000, so a session compacted at 128k, the notify quota was cleared, and the
  reminder never arrived — while burning a full summary call every 128k. The fallback
  is gone: when the wall cannot be computed the plugin no longer picks a compaction
  point at all. The host's own automatic compaction is unaffected, and `status` plus
  the mount warning now say the emergency line is disabled instead of silently
  pretending it still protects anything.
- **The cross-turn regression test could not fail.** It fed a verdict at
  turn 1 / step 5 and consumed it at turn 2 / step 1 — where `stepNow > verdict.step`
  is already false, so the pre-fix implementation passed it too. Restoring
  `movedOn` to its old form left the whole suite green (455/455). It now feeds
  turn 1 / step 1 and consumes at turn 2 / step 2, and reverting the fix makes it red
  with the intended assertion (`reject` would end the turn after `inbox.claim()`).
- **The intermittent failure in `压缩进行中热更新配置…` is fixed at its cause.** The
  config snapshot was taken after `await anchorDriftText()` — and `config` is a
  cordis volatile object whose properties are mutated in place, so copying the
  reference snapshotted nothing. The snapshot now happens before the first `await`
  **and** is evaluated (`{ ...config }`), so the reminder text and the threshold it
  compares against always come from the same instant.

### Security — credentials and workspace paths no longer reach the model

A privacy review of every outbound surface found that the scrubbing added for the
diagnostic file was never applied to the paths the **model** sees.

- **`status` echoed tool arguments verbatim.** The tool-loop line joined raw
  `tool/call` signatures (`name|files|commands`), so a command such as
  `curl -H "X-Api-Key: …" "http://internal/API?token=…"` appeared in full inside a tool
  result — which the host persists and re-sends. Both that line and the file list now
  go through `redactSecrets` + `elidePathsIn` before truncation.
- **`usage scope="sessions"` enumerated every workspace path and session id.**
  `cwdKey` is a reversible encoding of the workspace's absolute path, so the report
  doubled as an inventory of the machine's projects. It is now reduced to its last two
  segments.
- **Scaffold now writes a `.gitignore` into the anchor root when the workspace is a git
  repository.** Stage documents necessarily contain absolute host paths and session ids,
  and the default root is `<workspace>/docs/anchors` — inside the user's own repo. This
  repository's own `.gitignore` protected it, but that is a maintainer's local habit,
  not a product guarantee: any user running `git add .` would have published their paths.
  An existing `.gitignore` is never touched.
- **`redactSecrets` is now a shared function in `lib/util.js`** and covers what the old
  inline version missed: AWS access key ids, bare JWTs, PEM private-key blocks, keys
  glued to a prefix (`PGPASSWORD=`), and credentials inside URL authorities
  (`postgres://user:pass@host`).
- **`elidePathsIn` no longer mangles non-paths.** The old pattern treated any
  slash-prefixed token as an absolute path, which rewrote the runtime marker
  `g2-file-probe/20261118.3` into `g2-file-probe<path>/20261118.3` in the diagnostic file.
- **`status` no longer prints the diagnostic file's absolute path** (last two segments
  only).

### Changed — the reminder line now anchors on the harness compaction wall

`dsh-compaction-basic` compacts at `floor(min(W × 0.8, W − maxTokens − 65,536))`. That
is **not** a fixed fraction of the window: 69.3% at 1 MiB, 38.7% at 512 KiB, and
negative (the host throws `TargetPressureConfigError`) below ~314 KiB with a 256k
output reserve. Every threshold in this plugin used to be a window fraction, so each of
them sat on the wrong side of the wall in at least one regime.

- **New key `hostMaxTokens`** (default `256000`) — the model's output reserve, the only
  term in the wall formula that varies. Change it when you change models; the panel
  shows a ⚠ badge next to it and the 256k preset sets it to 131,072 automatically.
- **The emergency line is now `wall × 0.9`, not `0.85W`.** At 1 MiB the old value was
  891,289 — permanently later than the wall at 727,040, so the safety valve never fired
  first. It now fires at 654,336. When the wall does not exist the line is skipped
  entirely instead of charging into a guaranteed host error.
- **The unreachable-reminder warning uses `wall × 0.85`, not `0.6W`.** At 512 KiB the
  old threshold was 314,573 against a 202,752 wall: the warning could not fire even
  though the reminder line was already behind the wall.
- **Presets are recomputed as half the wall**: 1M → `363520` (was 360,000), 512k →
  `101376` (was 184,000, which was above the wall), 256k → `32768` plus
  `hostMaxTokens: 131072` (the window cannot compact at all without it).
- **`status` reports the wall, the distance to it, and the emergency line** — both in
  `/anchor status` and in the tool's `status` action. Previously a reminder line set
  above the wall looked perfectly normal; it merely never fired.
- **`defer` says when the requested line is already past the wall**, in addition to the
  existing "above the emergency line" note.

### Fixed — nine audit findings, six of them behaviour changes

An independent audit (an external report plus this session's cross-check) found
defects the existing suite could not see. Each fix is pinned by a regression test.

- **`defer tokens="off"` silently disabled automatic compaction.** It raised
  `effectiveNotify` to `MAX_SAFE_INTEGER`, so `total < effectiveNotify` was always
  true and every pre-step deleted the notify quota — and `agent/turn-stopping`'s first
  gate is `!lastNotified.has(session) → return`. The 1.0.0-beta.2 entry below claimed
  this was fixed; only the comparison line was. The quota is now kept while `off` is
  registered.
- **The emergency compaction line was unreachable in long turns.** It sat after four
  reminder gates that `return`ed early, and the turn-start gate is precisely what
  fires when `step > 1` — the only situation the safety valve exists for. The gates
  now record `gateBlocked`, and the single early exit moved after the emergency check.
- **Streaming repetition flagged repeated code as degenerate thinking.** The strict
  period branch (`trailingRepeat`) has no structure awareness, while the line branch
  filters fences and code rows. Both now require prose evidence from the repeated
  unit. Verified: 40 identical `print(...)` lines inside an unclosed fence produced
  `period=27 repeats=40` before and `null` after, while Chinese prose repetition still
  fires.
- **Complete fenced code could be evicted from the verbatim tail.** `isRetentionHazard`
  granted a block with `rawRows === 0` a prose share of 1, while `assessShapes` uses 0
  for the same case — the two comments call it "the same gate". A block that is
  entirely fenced code (`chars = rows = rawRows = 0`) now yields `proseShare = 0`; the
  missing-field legacy shape keeps its old behaviour.
- **A cross-turn verdict could reject a fresh turn.** `movedOn` accepted
  `turnNow > streamVerdict.turn`, so the previous turn's last-step verdict was consumed
  by the next turn's step 1. With `rejectOnRepeat` on that returns `{ kind: 'reject' }`
  for a clean turn, and the engine's `inbox.claim()` has already taken the user's
  message. `movedOn` now requires the same turn.
- **A strong `line` verdict could never replace a weak `tail` verdict.** The two
  `repeats` values are different units, so the old `kind === 'tail' → return false`
  made the `line` branch of `rejectOnRepeat` dead code. Line evidence at or above
  `STREAM_LINE_STRONG_RATIO` (0.8, now also the single source for `REJECT_MIN_RATIO`)
  overrides it.
- **An empty retained tail was cancelled by the balance snap.** When the newest node
  is itself the loop, `keepFromIdx === surfaceNodes.length`; the snap probed
  `surfaceNodes[length]` (`undefined`), the host threw, the catch treated it as
  unbalanced and stepped back one node — putting the loop back into the verbatim tail
  while the receipt still said it was excluded. The snap is now skipped for an empty
  tail, in both the compaction path and the `status` preview.
- **`cleanup` swallowed `opendir` failures.** The stage was skipped without
  `markTruncated`, so the report could still print "no stage directories with a
  parent-backup" while unreadable backups sat underneath. It now matches the two
  neighbouring catches.
- **`recall`'s `limit` was silently normalised to 20.** `0`, `-3`, `2.5` and `"5"` all
  produced 20 rows with no notice. Non-positive-integer values are now rejected with a
  message; values above 50 are still clamped (which is honest and already printed).

### Changed — schema/parser alignment and process-level dedup

- **`dshHome`'s schema now matches the parser.** It was a bare `string()`, so
  `dshHome: data` passed validation and was then dropped field-by-field — the last
  remaining "schema accepts, parser refuses" key after `anchorRoot`.
- **Injection dedup tables are process-level.** `postCompactionNotice`,
  `streamNoticeBySession` and `anchorDriftChecked` joined `sharedGates`; with two
  instances in one process the same step used to receive two identical notices.
- **`market-index.json` follows the index's own semantics.** The regression test
  required the index version to equal `package.json`'s, but `tools/market-index.mjs`
  refuses to run until that version exists on the registry — so any "bumped but
  unpublished" commit was red, and `npm test` stopped being a usable close-out signal.
  The test now requires the index not to *lead* the package version.

### Fixed after review — three defects the first pass introduced

The same review that produced the list above found three problems **in the fixes
themselves**. They are listed separately so the first pass is not read as complete.

- **`gateBlocked` stopped the early return but not the reminder body.** When the
  emergency compaction failed or was skipped, `compactionFailure` legitimately skipped
  the early exit — and `noticeText` then produced the full close-out reminder in a step
  the gates had blocked. With a failing engine, one turn received two consecutive
  "time to close out the stage" instructions, bypassing both the cooldown gate and the
  growth gate; the skipped branch also charged the notify quota for a step that never
  sent a reminder. `baseText` now honours `gateBlocked` too, so only the failure
  explanation survives.
- **The prose-evidence filter was too narrow in one direction and too wide in the
  other.** It evaluated `repeat.sample` with `fenceState: 'outside'`, but `sample` is
  the last `period` **characters** of an already-sliced window — its start can be
  inside a fence. Two verified consequences: a repeated unit beginning with a fence
  line made the filter swallow the prose after it (a real `好。`×29 repetition with span
  203 stopped being reported at all — a regression against the pre-fix behaviour), and
  a window entirely inside an unclosed fence never checked whether the window itself
  contained prose. Both criteria now use `fenceState: 'unknown'`, and the strict-period
  branch additionally requires the tail window to contain at least one prose row.
- **`anchorDriftChecked` was shared without the root in its key.** Two instances with
  different `anchorRoot` values then fought over one per-session slot: whichever ran
  first consumed it and the other reported `already-checked`, so a vanished hard
  constraint under the second root stayed silent forever. The key now includes the
  resolved root, the same way `lib/prestep-log.js` buckets its file states by the exact
  file/limit pair.

### Tests

- 463 items across nine files: 461 passed, 4 skipped for platform prerequisites,
  0 failed. Twenty-eight of them are new regressions for the fixes above, including one
  that pins the wall formula (`min(0.8W, W − maxTokens − 65,536)`) at five window
  sizes and one that checks every preset's reminder line really equals half the wall.
  Two render tests now open the **Compaction tab** explicitly — the harness renders
  only the first tab by default, which is how a field could previously be added to a
  group that was never rendered in any test.

### Documented — two judgement limits we chose to leave in place

Two audit findings (P2-4, P2-12) are closed by **documentation plus a pinned test**
instead of a behaviour change, because moving either one would trade a known
under-report for a worse failure mode.

- **Length normalisation stops around 8,192 characters.** `referenceCompress` has no
  clamp, and the ratio is measured over the first 16,384 characters while `L` is the
  whole block length. The direction is under-reporting: the largest real incident on
  this machine (65,928 characters) scores 4.03σ rather than 7.55σ, so it misses the 5σ
  exclusion line and only the absolute ratios catch it. Clamping alone would not make
  the two spans agree, and changing both moves the distribution the 5σ line was fitted
  on, which needs a corpus this machine no longer has. `docs/ARCHITECTURE.md` records
  the gap.
- **A leading-separator `anchorRoot` is absolute on every platform.** On Windows that
  means the current drive root (`D:\docs\anchors`) and no workspace containment check.
  The receipt prints the resolved `stageDir`, so it is visible on first use; rejecting
  it in the resolver would make the schema accept what the parser refuses, which is the
  failure mode this project treats as its worst. `docs/SECURITY.md` and
  `docs/CONFIGURATION.md` now state the resolution, and `test/index.test.mjs` pins it.

### Fixed — four drifts an audit found, three of them in the criteria path

**The release gate could not pass.** `tools/Test-Package.ps1` still listed 26 artifact
files after `lib/stream-guard.js` and `docs/FEEDBACK-injected-messages-cannot-be-removed.md`
shipped, so `tools\Pack.ps1` threw on a clean tree (`FAIL unexpected files in artifact`)
and the only full structural check on the artifact could be bypassed by editing its own
list. Both entries are added, and `test/index.test.mjs` now derives the expected set from
`package.json`'s `files` and compares it with that script's list, so the two cannot drift
apart silently again. `docs/RELEASING.md` and `docs/PRIVACY.md` said 26; the current
artifact is **28**. The `CHANGELOG` entry that says 26 describes the published
`1.0.0-beta.1` tarball — `tar -tzf` on that asset still lists 26 — so it stays as history.

**A code fence in the reasoning tail could hide the whole criterion.** `proseRows` decided
fence open/close by comparing the **first character only**, and assumed the text started
outside a fence. Both assumptions fail on the streaming path: the guard feeds
`slice(-4096)`, so the window may begin inside a fence and its only marker is then a
*closing* one, which the old code treated as opening. Measured: 400 lines of code followed
by 140 repeated rows produced `proseRows = 0` and no verdict at all, while the same text
with the single missing opening fence produced 140 rows at ratio 0.886. Nested
`4-backtick` fences around `3-backtick` ones had the mirror-image defect and could turn 20
lines of code into a false "single-block repetition 93 %".
One shared state machine now carries `{char, length, info}` and closes only on the same
character, at least the opening length, with no info string. Window callers pass
`fenceState: 'unknown'`, which pairs the first marker by looking for a legal closer after
it (if there is none, the window started inside a fence); whole-block callers keep
`'outside'`. `repeatedRow` defaults to the window semantics.

**One turn's reminder suppressed that turn's `reject`.** The reminder and
`rejectOnRepeat` shared a per-turn dedupe key, so a mild verdict that had already produced
a reminder (row ratio 0.5–0.79) blocked the upgrade to an unrivaled one (≥ 0.8) for the
rest of that turn — exactly the "the reminder did not work, it is still looping" case the
option exists for. `reject` now ignores the reminder key; it ends the turn, so it cannot
fire twice.

**The `skip` explanation carried a live countdown inside its dedupe key.** The key was
`outcome.reason`, and a backoff reason reads `还需约 59 秒` — a new "reason" every second,
so the notice told the model "this reason is explained once, it will not repeat every
step" while repeating it every step. The key is now `autoCompact`'s structured
`failureKey`, the same one the `failed` path already used.

Tests: **435 items — 431 passed, 4 skipped for platform prerequisites, 0 failed** (the count is
taken after the publish, when the market-index guard is green again); eight
new tests, and five reversals mutation-verified (reverting each one turns its test red).
`docs/VALIDATION.md` records the sweep. Two stale numbers are corrected alongside:
`lib/index.js`'s comment said "40 %" while the default is 36 %, and the owner's
`docs/anchors/README.md` said `400k / 40 %` in two places (the code and the profile both
use `360000`); that page's `anchor.md` template also lost a duplicated
`## 目标 / ## 当前进度` block and a second `## 下一步`.

### Fixed — three readings that contradicted the data they described

All three were observability bugs: the code did the right thing, the line printed next to
it said something else.

- **`status`'s stream-notice line read a process-global field.** The two lines above it
  say they read *this session's* guard, and the guard is per-session (a `WeakMap`); the
  notice line used `state.streamNoticeSent`, so another conversation's reminder showed up
  as "this session's last notice, turn N". It now reads the same per-session map the
  dedupe uses, and the global field is gone.
- **The `guard` receipt named a range it does not guard.** Signatures come only from
  `## 决策与否决`'s `[否决]` lines, but the receipt said "`[否决]` 行" and the empty-baseline
  message said "也没有 `[否决]` 行" — reading as if any section counted. Both now name that
  section.
- **`validate` could not see a `[推断未验证]` marker on the anchor's first line.** Two
  checks anchored their pattern on `\n`, so a first-line marker matched nothing: the same
  anchor reported "no `[推断未验证]` marker at all" while the age check stayed silent.
  Both patterns accept `^` or `\n` now.

Also: the panel no longer loses a failed write behind another field's success (previous
entry), `docs/ARCHITECTURE.md`'s module table gained `lib/client.js` and
`lib/stream-guard.js`, and the test counts in `docs/VALIDATION.md` are current
(**435 items — 431 passed, 4 skipped**; twelve mutation pairs recorded).

### Fixed — the panel's own copy of the defaults disagreed with the code

`lib/client.js`'s `FALLBACK` said `streamGuard: false` while `DEFAULT_STREAM_GUARD` is
`true`. That map feeds the read-only panel (shown when the Host does not expose
`configForms`) and the per-field **restore default** button, so the same card could display
the guard as on and its hint as "off by default", while claiming to show "the defaults,
matching the code". Both hints and the Host schema description now say on-by-default, and
`test/index.test.mjs` compares every `FALLBACK` value against `resolveConfig({})` instead of
only checking that the key exists — a key-only check is what let the two drift apart.

Documentation, same pass:

- `docs/PRIVACY.md` said a reminder "exists only in that request; it is not appended to the
  session log". The Host appends every `decision.messages` entry itself
  (`session.append('user/message', …, { surfaceOp: 'append' })`), so a reminder stays on the
  surface and enters the summary input; the plugin cannot replace or remove it. The page now
  says so and links `docs/FEEDBACK-injected-messages-cannot-be-removed.md`, which the
  top-level `README.md` navigation now also lists.
- Both READMEs' configuration tables were missing five keys: `notifyOnTurnStartOnly`,
  `notifySkipWhenToolPending`, `reportToolFacts`, `streamGuard`, `rejectOnRepeat`. They are
  listed now, with their real defaults.
- The two READMEs disagreed about the stream guard's default (one said on, one said off in
  the `status` description). Both now say on, which is what `DEFAULT_STREAM_GUARD` has
  always been.

### Security — the isolate-bypass path is now pinned to one service name

Fetching `compaction` requires `ctx.reflect.store`, because the profile's cordis group
isolates it and all three normal routes (`ctx.get`, `ctx.inject`, `agent.ctx.get`) fail.
Cordis documents that store as *"Read a service from the store without the inject
requirement"* — and the same `Dict<Impl>` holds all **55** services with their
instances. In reach: `ApprovalService.setPolicy`, `ConfigEditor.edit`,
`AuthorizationService.cancel(CredentialKey)`.

None of it was ever accessed — `findIsolatedService` matches on `impl.name` and never
reads another `impl.value` — but an audit found no guard against a future mistake.
`ISOLATED_SERVICE_ALLOWLIST` pins the path to `compaction`; the test asserts that
`approval`, `configEditor`, `authorization`, and `credentials` are refused without their
`value` being touched.

`docs/SECURITY.md` now carries the full reach audit: that path, the usage route
returning absolute paths, the session store being measured but not read, zero network
egress, zero credential access, and the event ring keeping shapes rather than content.

### Added — `rejectOnRepeat`, the lever above a reminder (off by default)

A reminder measured at ~20 % effective leaves one question: is there anything stronger? `pre-step`
offers exactly two levers, and the plugin was using one of them.

Reading the DSH source settled the boundaries:

- **`agent/assistant-stream` is `(payload: { agent, frame }): void`** — intervening *inside* a step
  is structurally impossible. Detection sees the loop; it can only speak at the next `pre-step`.
- **`PreStepDecision` has two shapes**: `{ kind: 'enter', messages }` (what the plugin does) and
  **`{ kind: 'reject' }`**.
- **`reject` means the whole turn ends.** In `dsh-agent-loop`, `decision.kind === 'reject'` sets
  `turnEnds = { kind: 'blocked' }` — it does not skip the step.
- **`startsRequestSeries` cannot strengthen a reminder.** It only reaches
  `systemPrompt.project({ startsSeries })` and the `request/header` marker, i.e. series boundaries
  for caching and billing. It never changes the text the model sees.

`rejectOnRepeat` therefore exists as an **off-by-default** option that fires only on an **unrivaled**
verdict — either the row criterion at ratio ≥ **0.8** (real incidents 0.77–0.97), or the strict
period at **≥ 100 repeats** (real incidents 108–176). The period side is on repeat **count, not
span**, and the test forced that: filler units are two characters, so a 400-repeat `做。` loop covers
only 800 characters, and any span threshold high enough to be safe would have missed the typical
incident completely.

On, it ends the turn instead of describing it. Off, nothing changes. The behaviour path now has a
test: with the option on the same loop yields `kind: 'reject'`, with it off the same input yields
`kind: 'enter'` plus one reminder.

Tests: default is `false`, only real booleans accepted, and the client panel / schema / config-key
contract tests all cover the new key.

### Measured — notices help a little, and much less than assumed

The whole stream guard rests on *"say one sentence and the model straightens out"*. That had never
been measured. It has now: all injected notices with reasoning blocks on both sides (**65 samples**),
comparing the 3 blocks before against the 3 after.

| | Before | After |
| --- | --- | --- |
| σ deviation (`dev`) | 1.60 | **1.44** |
| Row repeat ratio | 0.22 | **0.18** |
| Block length | 722 chars | 523 chars |

**Averages improve; the per-sample picture is the real answer: 13 improved · 34 unchanged · 18 got
worse** (change of 0.5 σ or more). So the effective rate is about **20 %**, more than half of notices
change nothing measurable, and **18 of 65 cases got worse after the notice**.

That last number is worth sitting with: it is consistent with the reason `describeStreamVerdict`
never quotes the repeated text — restating a loop can reinforce it. The current copy avoids
restating, yet a quarter of cases still degraded.

Caveats, stated because they bound the claim: the sample is defined by how often notices fired, not
by session count; a notice is often followed by compaction, which shortens blocks (though `dev` is
already length-normalised); and "unchanged" may mean the notice arrived after that block was already
being generated.

The honest summary is that a single short notice is a weak intervention. Making this stronger is a
design problem (timing, or acting on it rather than describing it), not a threshold problem, and it
is not solved here.

### Added — the same content walked through twice, in adjacent blocks

The one signal no existing criterion covered. Single-block compression asks *"is this block
repeating itself"*; cross-block asks *"are these two blocks the same content"* — and **both blocks
can be perfectly non-repetitive on their own**. Measured over 239 sessions and 3,971 turns: **456
adjacent pairs at 3.5 σ or beyond**, concentrated in the known repetition session `session-ddd00004`
(blocks 1,820–6,237 chars, raw ratios 0.152–0.281).

Two things the tests forced out:

- **The criterion had to be σ, not raw ratio.** A fully-restated 1,384-char pair compresses to
  **0.356**, while a measured 6,237-char sample reaches **0.164** — so any fixed ratio threshold
  bakes in a hidden length curve, because deflate has fixed overhead on short input. As σ scores they
  agree: **4.6 vs 5.8**. That is `blockPairCompress` returning `{ratio, dev, chars}`.
- **It catches literal overlap, not paraphrase** — a real limitation, stated rather than implied.
  Rewording 8 phrases of the same 24 sentences moved the pair ratio from 0.356 to only 0.368, i.e.
  detection stops. Semantic restatement is out of reach for a compression-based measure.

**Offline only.** The event ring deliberately keeps shapes and not text, so `scanEventRing` cannot
compute this and it never reaches the runtime path; `assessTurn` is the only caller.

### Fixed — parallel tool calls count as one attempt (and a wrong measurement corrected)

Two things, and the second matters more.

**Parallel calls.** One step is one LLM response, so a model can emit several `tool/call` entries
inside it. Measured **3,179** cases where the same signature repeats within a single step (same
`edit` with the same args, same `pwsh` with the same command). Those are **one attempt**, not
spinning. DSH's `tool/call` carries no `llm_response_id`, but it does carry `step`, which is the same
thing — OpenHands guards this with `_invalid_calls_share_response`, and Roo-Code disables parallel
tool calls outright under the native protocol ([Roo-Code #9433](https://github.com/RooCodeInc/Roo-Code/pull/9433)).
`fact` now records `turn`/`step`, and `recentToolSignatures` collapses same-step identical
signatures. Hits drop **423 → 166**.

**The correction.** The earlier claim that *"threshold 5 measures zero hits, so the criterion finds
nothing"* was **wrong, and it was my measurement bug**: that script tested thresholds 3 and 5 over
the same accumulating array and cleared the array whenever threshold 3 matched — even when 5 did
not — so it could never reach five. Re-measured properly: **423 hits without dedupe, 166 with it
(0.29 %)**.

**The criterion still stays out of reminders, but for a better reason.** All 166 sampled hits are
`edit`/`write`/`read_image` against one path, ×5. Editing one file five times is ordinary
iteration; reading one image five times is suspicious — and the signature cannot tell them apart,
because the event ring keeps paths and not results. OpenHands separates them by matching action
**and** observation; we only ever see the action. Reporting this as degeneration would be guessing.

### Fixed — markdown rule lines are not prose (and `scanToolArgs` is not worth building)

Measuring repetition inside tool arguments (62,047 calls; 4,814 with arguments over 2,000 chars)
surfaced a third `proseRows` leak. `CODEISH`'s list-markup branch requires a space after the bullet,
so a **pure symbol line** like `---` passes through. In `write.content` that is a markdown table
separator and repeating it a dozen times is entirely normal — it accounted for most of the 23 hits.
`RULE_LINE` now covers `---`, `***`, `___`, `===`.

Tool-argument hits drop 23 → 14; reasoning-block hits are unchanged at **657 (2.08 %)** with the same
seven filler openers, so the stream criterion is unaffected.

**`scanToolArgs` is dropped, with the measurement as the reason.** The remaining 14 hits are all
PowerShell snippets (`A ''`, `Add-Line ''`, `W ""`) — the argument body *is* code, and a row
criterion cannot tell repeated code from repetition. `pi-loop-guard` can afford this because it scans
the *streaming* argument with 4× relaxed thresholds; our event ring only ever sees the parsed body.
Shipping it would mean reporting PowerShell scripts as degeneration.

### Fixed — prose rows were letting code literals and bare keywords through

Found while calibrating the row threshold. At threshold 8 the only three non-filler "most frequent
rows" across 31,563 blocks were `INFO ok` (12 rows), `return` (14 rows) and `'',` (38 rows). Two of
those were `proseRows` bugs, not threshold problems: `CODEISH` is a per-line **punctuation** regex —
it contains no quote character and no shape test — so `'',` and `return` both passed as prose.

`isCodeish` gained two whole-line rules: `BARE_KEYWORD` (`return`, `pass`, `fi`, `done`, …) and
`QUOTED_LITERAL` (`''`, `'',`, `'a'`). Both anchored to the full line, so `剩下的 return 语句…` and
CJK quotation marks are unaffected.

**The obvious fix was wrong and the existing tests caught it.** Requiring `WORDY` (a letter or CJK
character) broke `纯标点占位符堆积要判成可疑` — the regression test for `session-aaa00001` turn 49,
where the model replaced `做。` with `（...）` *to avoid* repeating, pushing density from 57 % to 97 %
(6,372 occurrences by turn 61). Pure-punctuation rows are a real degeneration shape and must stay
countable; the test now pins that explicitly.

After the fix: **657 blocks (2.1 %)**, and the full distribution of most-frequent rows is 7 entries,
all filler openers — `做。`, `好。`, `（输出。）`, `Go.`, `**做**。`, `执行。`, `**执行**。`. No technical
rows at all.

### Changed — the row criterion was 3× too blunt, and now it is measured

The line-level stream criterion required a prose row to repeat **30** times. That number came from
"real samples repeat 100+ times, leave a 3× margin" — i.e. it was calibrated against the *worst*
cases. Calibrated against the corpus instead (239 sessions, 31,563 reasoning blocks, tail-window
scope), with a new minimum-row guard:

| Threshold | Hits | Most frequent row, top 5 |
| --- | --- | --- |
| 30 + ratio 0.5 | 499 (1.6 %) | `好。`×253 `做。`×162 `（输出。）`×61 `Go.`×18 `**做**。`×3 |
| 8 + ratio 0.5 | 704 (2.2 %) | `做。`×315 `好。`×275 `（输出。）`×67 `Go.`×20 `**做**。`×9 |
| **10 + ratio 0.5 + rows ≥ 20** | **658 (2.1 %)** | `做。`×278 `好。`×274 `（输出。）`×67 `Go.`×20 `**做**。`×9 |

The 205 blocks in the 8-vs-30 difference set sample as `Go.` ×16 and `好。` ×23 — **already
spinning**, just not yet 30 times. The old threshold missed that whole band: dropping to 10 catches
**32 % more real repetition** with no new false positives (`STREAM_LINE_MIN_REPEATS`).

`STREAM_LINE_MIN_ROWS = 20` is what makes the drop safe. At threshold 8 the only three non-filler
"top rows" were `INFO ok` (12 rows), `return` (14 rows) and `'',` (38 rows) — all **short windows**,
where 8 of 12 identical rows is 67 % and sails past the 0.5 ratio check. Real repetition samples had
80 / 112 / 229 rows. The row floor cuts the false-positive side and stays far from the true side
(`repeatedRow(text, minRepeats, minRatio, minRows)`).

### Added — tool-call sequence loops, reported but never alerted

The one detection shape this plugin had nothing for: a model can loop by re-issuing the same tool
call while every reasoning block looks different, so no text criterion fires. Two implementations
studied treat it as a separate detector — `huytd/pi-loop-guard`'s `ToolLoopDetector` (tail period,
`minRepeats` 3, `maxPeriod` 4) and `looplens-mcp`'s `edit_distance` (non-adjacent window similarity
≥ 0.85, catching A→B→A→B oscillation). This adds the stricter tail-period version, for the same
reason the stream guard uses strict periods: oscillation criteria at high similarity match ordinary
work rhythms.

**It is reported in `status` and never injected as a reminder.** Over 239 sessions and 56,641 valid
signatures, with parallel calls collapsed to one attempt:

| Threshold | Hits | What the samples are |
| --- | --- | --- |
| 3 (no dedupe) | 1,745 (3.09 %) | `edit` the same file ×3, `read` the same file ×3 — ordinary iteration |
| 5 (no dedupe) | 423 | mostly `edit` one path ×5 |
| 5 (parallel deduped) | **166 (0.29 %)** | still mostly `edit`/`write`/`read_image` one path ×5 |

An earlier revision of this file said threshold 5 measured **zero** — that was wrong, and it was a
measurement bug (the script cleared its accumulating array whenever threshold 3 matched, even when 5
did not, so the array could never reach five). Corrected above.

The reason it still stays out of reminders is a limitation, not a measurement: **all 166 sampled
hits are one path operated on ×5, and the signature cannot tell "edited it five times" from "could
not write it and retried five times"** — the event ring keeps paths, not results. OpenHands
separates those by matching action **and** observation
([`stuck_detector.py`](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/stuck_detector.py));
we only ever see the action, so alerting on it would be guessing.

Three design details came out of the same measurements:

- Signature is tool name **plus parameters** (as in `pi-loop-guard`); comparing names alone would
  call `read a.txt / read b.txt` a loop.
- Calls whose event-ring facts carry neither `files` nor `commands` are **skipped entirely**. With a
  name-only signature, `web_fetch` fired three times in a row — which is three different URLs. An
  alarm known to be noise stops being read.
- Same-step identical calls **collapse to one**. A step is one LLM response and can contain several
  parallel calls; 3,179 measured cases were one attempt, not repetition. DSH has no
  `llm_response_id`, but `step` is the same thing.

### Verified — exclusion actually runs, with a real receipt

The one link that had never been executed. On `session-bbb00002`, calling
`stage_handoff(action="compact")` produced a genuine engine-side compaction (no `sourceCommandId`)
with this receipt:

```
精确压缩完成：尾部实际逐字保留 86 tokens（预算 32,000）。
压缩区间 seq 1951..2893 · 摘要掉 290 条历史 · 约 160,407 tokens
已剔除 3 个复读块：它们的原文不留在尾部，已随区间一起压进摘要。
```

So the chain is real end to end: the predicate identifies blocks, range selection excludes them, and
the receipt reports the count.

The retained tail came out at **86 tokens against a 32,000 budget** — far below the budget, and
initially written up here as a defect. It is not one. Long reasoning degradation in DSH can trigger
a **known harness issue** where the turn completes from the model's side (`turn/end` reports
`completed`, the `text` block is whole) while the user sees a truncated reply; `maxTokens` is not
the limiter (393,216) and the failure is not in this plugin's path — `agent/assistant-stream` is a
`void` notification hook and cannot cut a stream. The effective remedy is a **hard compaction that
discards the degraded content**, so a small retained tail is the exclusion doing its job rather than
a bug. Recorded as first-hand guidance from the maintainer.

### Fixed — the stream guard never saw a single frame

The reason the guard produced no reminders on real data, after three rounds of testing. Call
recording, offline replay and config all looked right; the feature was simply dead.

`agent/assistant-stream` is declared with `this: Scoped<Agent>`, so a listener registered on a
plain plugin ctx only fires inside that scope — and a plugin ctx is no agent scope. Without
`{ global: true }` the callback is **never invoked**: no frames, no verdict, no reminder, and
**no error anywhere**. DSH's own two subscriptions pass the flag explicitly
(`session-controller/history/assistant-stream.ts:24` and `:77`). Now it does too.

Because `global` means every agent's frames arrive at one callback, the guard is isolated per
session through a `WeakMap`. A shared instance would let two concurrent sessions pollute each
other's tail window.

Two source-level contract tests guard this, since nothing else can — unit tests pass no matter how
the hook is registered. Verified by actually removing the flag: the test goes red with
"missing `{ global: true }`". That is the only class of failure here that is completely silent, so
it gets the blunt instrument.

### Added — the guard is observable from `status`

When the guard's internals are invisible, "never detected a loop" and "detected it but the notice
never went out" look **identical**: `status` says on, the log has zero notices, and the two need
opposite fixes. Three readings now separate them:

- `流式守卫收帧：N 个 reasoning-delta` — `0` means the listener is not wired, non-zero means the
  frames arrive. `totalDeltas` never resets.
- `流式守卫最近结论` — `lastVerdict` survives the per-step `start` reset (only `reset()` clears it),
  so a detection stays visible afterwards.
- `流式守卫提醒` — which turn the last notice was emitted for.

### Changed — one notice per turn, deduped per session

Dedupe was keyed on `turn:step`, so a turn that kept looping emitted one notice per step — real
output shows **three in one turn**, each entering the surface and eventually the summary. A notice
is meta-information: "you are looping" needs saying once, and repeating it is itself feeding
repetition into the context, which is what this feature exists to reduce. Keyed on turn now.

The dedupe slot also lived on global state while turn numbers restart at 1 in every session, so two
sessions could silently suppress each other. Now a `WeakMap` keyed by session.

### Changed — the injected notice no longer carries counts

It read `思考流尾部有一行内容已重复 77 次（占 95 行里的 81%）`. Those numbers are useless to the next
stage and easy for the model to copy into its own `anchor.md`, which has an 8,000-character budget —
so they crowd out the facts that need to survive. Split by audience: `describeStreamVerdict` keeps
the exact numbers for `status` and logs, `noticeStreamSummary` is what enters the context and is
purely qualitative (`上一步的思考在同一行上反复打转了`). A test asserts it contains no digits.

The scaffold skeleton gained a matching line telling the writer not to copy process noise (repeat
counts, retry counts, tool-call tallies) into the anchor, and to put numbers in the detail document
instead.

### Known limitation — injected notices end up in the summary

DSH gives a plugin no way to remove its own injected messages. The engine appends
`decision.messages` with a hardcoded `{ surfaceOp: 'append' }` (`agent.ts:477`), and
`Session.append` with a `replace` op only affects messages the plugin appends itself — which then
never reach the current request, because `assembly` is built before `pre-step` runs. So notices are
part of `SummarizationInput`, which is the shadowed region in surface order with no `source.kind`
filtering. Throttling to one per turn, dropping the numbers and never quoting the repeated text is
everything available at this layer. Filed upstream — see
`docs/FEEDBACK-injected-messages-cannot-be-removed.md`.

### Distribution — a plugin market index, because DSH ships none

DSH's Discover tab reads **user-configured** plugin indexes; the app ships with no index
of its own, and the official Plugins list is a hardcoded `@deepseek-ai/*` catalog with no
submission path — `dsh-plugin-manager` computes `official = OPTIONAL_BUNDLES.includes(name)
|| OFFICIAL_ON_DEMAND_CATALOG.has(name)`, both constants inside
`@deepseek-ai/dsh-official-bundles`. So there is nothing to be accepted into, and also
nothing to wait for.

`market-index.json` is a format-1 index listing this one plugin, generated by
`tools/market-index.mjs` from `package.json` and the registry's recorded publish time. It
was checked with DSH's own `parseMarketIndex` rather than by eye; that call also produced
the exact spec Discover installs with, `dsh-stage-handoff@1.0.0-beta.1`.

A regression test pins the file to `package.json`, because the version inside it is
generated: a forgotten regeneration would keep Discover listing the previous release while
every command still succeeded. Mutation-verified — setting the index to `0.9.0-stale`
fails it with a message naming `tools/market-index.mjs`.

### Distribution — also on npm, byte-identical to the release asset

The 26-file artifact attached to the GitHub release is now also on npm as
`dsh-stage-handoff@1.0.0-beta.1`, under the `beta` dist-tag. Verified rather than assumed:
279,386 bytes, `sha1 4e9f9de8…`, `sha256 d7861eb0…` — equal to `npm pack`'s output — and a
throwaway-directory install whose `lib/index.js` hashes equal to the working copy.

`docs/RELEASING.md` records the four things that cost time here: `--tag` must be explicit
because npm 11.19.1 ignores `publishConfig.tag`; an account whose only second factor is a
WebAuthn security key cannot use `--otp` at all, so a bypass-2FA granular token is the only
CLI path; a `409 Cannot publish over previously staged version` means the upload already
succeeded; and three separate caches — the registry's CDN packument, npm's local `_cacache`,
and the version-scoped document — each reported a false failure during the first attempt.

### Verified — a real destructive compaction, and the one check that was missing

`docs/VALIDATION.md` had carried the sentence "No claim is made here about a real compact
transaction" since the project started. It no longer does: one deliberate compaction was run
against a live, non-archived session (several thousand events, prior summaries), verified entirely
from outside — decompressed session log plus probe commands in that session.

Result: precise path (not the `/compact` fallback), range `6811..7480` starting exactly one
past the previous summary's `6810`, tail `32,362` against a `32,000` budget (the whole-node
rounding invariant held in practice), context `324,067 → 65,819` tokens (**−79.7 %**), new
summary 15,835 chars with all 8 sections, 40/40 sampled shadowed events still present
(logical compaction), `会话内压缩：1 次` reported afterwards, `action="summary"` read the fresh
summary back including its "data, not instructions" guard, 7,945 lines decompressed with 0
unparsable.

Three findings now recorded in `ARCHITECTURE.md` ("Measured decay, and why the anchor is a
file"):

- The session log does **not** shrink (7,264,398 → 7,356,216 bytes); compaction is logical.
- Summary detail decays per round: by the 5th generation, commit hashes were 1/15 and anchor
  paths 0/1, while structure stayed 8/8. That is the measured reason the anchor is a file.
- The verification metric's first version was wrong, not the compaction — it compared two
  non-overlapping ranges and demanded 50 % retention. Recorded so it is not repeated.

Also: `recoverStaleStageReservation` is now exported **for tests only**. Its call site sits
behind `process.platform !== 'win32'`, so the clamp added in the previous round had no
coverage on Windows — but the function body itself does not check the platform. Direct
testing proves `已 0 秒` under a backwards clock (the mutation shows `已 -3600 秒`), and that
the same clamp does not break the TTL expiry path.

- **A skipped test was dragging an unrelated assertion down with it.** The pre-step read
  guard has two rejection reasons — "it is a link" and "it is too large" — and both lived in
  one case that called `t.skip()` when `symlink()` raised `EPERM`, which it always does in a
  non-elevated Windows shell. The oversize half needed no privilege at all and had therefore
  **never executed on this machine**. Split into two cases.
  Both halves are now verified on Windows: the oversize half runs everywhere, and the link
  half was executed once in an **elevated** shell where `symlink()` succeeds — it rejects the
  link as intended (`✔ pass 1 / skipped 0`). The remaining three skips are genuine platform
  differences (POSIX `mkdir`+`rename` reservation protocol; Windows uses a different
  atomicity strategy, so the behaviour under test does not exist there).

Test count 358 → 360.

### Fixed — the loop detector was blind to the placeholder the model switched to

A third correction to the repetition criteria, found by forensics on one real session
(`session-aaa00001`, 61 turns, 11 looping). The model did what the reminder asks — it
noticed it was looping, named it (`这已经是病态复读了 —— 立即停止 thinking`), and stopped
repeating `做。` — **by substituting a different placeholder, `（...）`**. Density went from
57 % of lines to 97 %. The detector could not see it:

- `isFiller` requires a word character, so pure punctuation is never a 语气短行;
- `tiny` requires `fillers === rows.length`, which is impossible when every line is
  punctuation;
- both original signals therefore fail, leaving only `repeatRatio` — and `assessShapes`
  requires two reasons to convict.

Measured on that session's turn 61 step 14 (65,928 chars, 11,853 lines, `做。`×5,916 +
`（...）`×5,768): the block was caught only because `做。` was still mixed in. A block of
pure `（...）` scored **one** reason and would have passed silently. Both full-width and
half-width forms leak: `（...）` is 5 characters, past the 4-character filler ceiling, and
`(...)` contains `(` so `isCodeish` deletes the whole line and `repeatRatio` becomes 0.

`placeholderShape` therefore counts repeated **wordless** short lines from the raw text,
under two gates: at least `PLACEHOLDER_REPEAT` (12) lines of the same placeholder, and
those lines making up at least 40 % of the block. 0.4 is measured, not guessed — the real
mixed block is 0.487, a thought that quotes code is 0.33. Because the condition is
composite (share × repeat count), it convicts on its own; half-width `(...)` can never
produce a second reason, since `proseRows` is empty and `repeatRatio` is exactly 0.

Two false positives were caught before commit, both by running the new criteria over
every log on the machine:

- **Fenced code.** A normal "backup hash matches, now edit ps1" block contains twelve
  ` ``` ` markers. They are wordless, three characters, and repeated twelve times —
  exactly the shape being detected. `placeholderShape` now skips fences with the same
  state machine as `proseRows` (the marker lines and everything inside them).
- **A threshold that never fired.** At the first value (0.8), the criteria hit **0 of
  41,265 reasoning blocks across 245 sessions** — dead code. 0.4 is where the real block
  lives.

Final measurement over the same 245 sessions / 41,269 blocks: 1 block hits the new
criteria (the turn 61 step 14 mixed block), **0 turns change verdict** (137 → 137
suspicious turns), so this is purely additive coverage for a form that has not yet
occurred unmixed. `isFiller`'s word requirement was **not** relaxed — that tightening
fixed a real `...`×8 false positive, and the new criterion respects it by starting at 12.

Test count 362 → 369.

### Changed — the verbatim tail no longer keeps the loop itself

Compaction preserves the most recent history word for word. If the most recent history
**is** the loop, that retention feeds it back: measured on `session-aaa00001`, the `/compact`
that stopped a 19,211-character repetition kept that block outside the shadowed range, and
the resulting 22,849-token context was more than half repetition — the next six turns looped
again, ending at 65,928 characters in one block.

`selectRetainedRange` now takes the event ring and drops degenerate reasoning from the
retained tail. Two gates keep it from throwing away real history:

- the block's turn must already be judged suspicious (`assessShapes`);
- the block itself must be degenerate (`isLoopBlock`, the same thresholds as the turn-level
  signals, asserted equal by a test).

Retention is what changes, not compaction: the excluded nodes simply fall inside the
shadowed range, so the summarizer still sees them. When the newest node is itself the loop,
the retained tail becomes empty — deliberate, since a summary alone is better than keeping
several tens of thousands of characters of `做。` as the newest example. The tool output and
`status` now report how many blocks were excluded, because retention coming in under budget
otherwise reads as "the setting did not take effect".

Measured across 245 session logs / 41,316 reasoning blocks: 2.31 % of blocks are degenerate
on their own; of the 2,592 blocks in the 137 suspicious turns, 826 (31.9 %) are excluded, and
12 turns are degenerate end to end (their reasoning disappears entirely, their tool calls and
their results stay paired). With no ring available the function behaves exactly as before.

### Changed — the loop advice names the tools that produce it

The repetition warning used to end with "shorten the turn or use a stronger model", which is
true and not actionable. Two of the three measured correlates are specific: looping turns
contain `job_output` / `job_list` / `wait_agent` 25 % of the time versus 14 % for clean ones,
and the loop grows in the gap between *deciding to wait* and *sending the wait*. The ring now
records `tool/call` names (truncated to 40 characters — a name is not content, so this does not
widen the privacy surface), and the warning says to send the wait first and end the turn, then
names the wait tools this session actually used.

Test count 369 → 372.

### Changed — repetition detection is language-independent, and exclusion got much stricter

Two problems, both found by measuring the whole corpus (246 sessions, 3,827 turns, 41,408
reasoning blocks) instead of one session.

**The detector was structurally blind to English.** Both original form signals are built on
*lines*: `isFiller` requires a word character and `tiny` requires every line to be filler.
English loops arrive *inside* one line — `Let me do it now. Let me do it now. …` — so a 359-character
repeated block scored 1 prose row, 0 fillers, and 0 % line repetition: every signal dead at once.
Chinese happens to work because the model emits filler one-per-line. That was luck, not design.

The fix is `compress` in the shape: deflate length / raw byte length. LZ77 encodes a repeated
substring as a back-reference, so mechanical repetition collapses the compressed size while
verbose-but-varied prose barely moves — and it needs no tokeniser, no language test, no line
structure. Synthetic check: English in-line loop **0.089** vs normal English **0.72**; the same
repetition in Chinese **0.034**. It is the fifth signal and convicts alone, because 0.2 means
five-fold self-repetition and no normal technical thought reaches it (corpus p01 = 0.325).

**A gate was required, and it is the interesting part.** Compression alone flags structured,
repetitive *code*: `40 × { if (flagN) { result.push(valueN) } }` compresses to **0.130**, and a
`- ✓ done` checklist to **0.065** — the same band as real loops (0.018–0.038). So the signal
requires prose rows to be the majority of non-empty rows. Pure code has zero prose rows, mixed
blocks few, loops almost all. Fifteen offline cases pin it: nine loop shapes (Chinese, English
in-line, punctuation-only, mixed) all convict, six normal shapes (including regular code,
code-plus-prose, and a Markdown checklist) all stay clean.

**Exclusion was doing real damage.** The previous round excluded any block passing `isLoopBlock`
(≥40 % line repetition or placeholder pile-up). Measured against compression ratio, 955 blocks
hit that bar but **660 of them compress above 0.3** — they are *mixed* blocks, a real repeat
embedded in substantial normal content (the standing example: 135 lines of 「（输出。）」 inside a
technical analysis, 45 % of the block). Excluding them deletes the other 55 %.

`isRetentionHazard` replaces it: compression ratio ≤ 0.15 **and** prose rows in the majority.
Across the corpus that is **67 blocks instead of 955 (−93 %)**, and those 67 are the ones that
actually drown a context (largest: 65,928 characters, compression 0.018).

**Control-variable result (same logs, HEAD criteria vs these):** 137 suspicious turns → 143,
**137 of them identical**, six new, **zero regressions**. All six new turns were already
"single-block repetition 88–97 %" — they simply lacked a second reason; compression supplied it.
That is the honest description of what this buys: not a new class of finding, but a second
independent witness for blocks where heavy repetition squeezes out the filler words.

Measured scale, for the record: 143 of 3,827 turns loop (3.7 %), but only **67 blocks / 397k
characters are severe** — 0.58 % of the 68.5 M reasoning characters on this machine. The English
bucket contains zero severe blocks: this machine has never produced an English loop, so the
English path is verified on synthetic samples only.

### Changed — compression is normalized per length for Chinese, and the tail is measured directly

Two more defects, both only visible once compression ratio was plotted *against length*.

**An absolute threshold on compression ratio is secretly a length filter.** deflate's header is
fixed overhead, so short blocks compress worse no matter what they contain: measured medians over
16,705 Chinese blocks are 0.733 at 200–400 characters and 0.477 at 6.4k–12.8k. The consequence is
a real miss — a 323-character loop measures 0.208, passes `compress <= 0.2`, and the loop survives.
The threshold was never wrong, it was *length-dependent*: `0.2` fires on 53.85 % of Chinese blocks
above 12.8k and on 0.03 % of blocks at 200–400.

So the shape now carries `norm = compress / expected(length)` and `dev = (expected − compress) / σ`,
with `expected = 1.2118 − 0.0862·ln(L)` and σ = 0.051 (log fit, R² = 0.985 over 41,348 blocks).
Detection uses `dev >= 3.5` (0.91 % false positives, 100 % recall on severe loops); exclusion uses
`dev >= 5` (0.12 %). **It is a union with the absolute threshold, not a replacement**: normalization
actually catches *fewer* blocks in the 800–3200 bucket, because long blocks have a low reference.
Across the corpus the union adds 3 blocks in the 200–800 bucket, all genuine loops, zero false
positives — including a truncated `做。好。执行。` run that the absolute rule had been letting through.

**The verdict must use the σ score, not the ratio.** The first version set the exclusion bar at
`norm <= 0.28` ("a quarter of normal"), which reads well and is equivalent to `dev >= 9.95` —
**twice as strict as intended**. Replaying a real looping session showed the cost: turn 14 of
`session-ccc00003` contains a run of pure `做。好。执行。` blocks at 9.2σ that were being kept, because
a ratio threshold's equivalent σ bar drifts with length (`norm 0.28` equals `dev 9.95` at 357
characters but `dev 6.0` at 7,000). Switching to `dev` took exclusions from 67 to 362 blocks
corpus-wide.

That five-fold jump is the risky part, so it was audited rather than assumed: of the 362 excluded
blocks, 67 come from the absolute threshold and 295 from `dev`; only **2** have compression above
0.45 (both genuine: one is a `做。好。执行。` run at 58 % line repetition), and none are excluded
without meeting one of the two. One sample nearly fooled the audit — a block that opens with a
clean `- github.com: 200 ✓` list and reads like a templated false positive turned out to hold
`好。`×150, `Go.`×87 and `（输出）`×61 further down. Repetition sits in the middle, not the opening;
`trailingRepeat` returns null for it because the *tail* is the clean part.

**Chinese only, and the code says so.** `lang` is `zh` when CJK ≥ 30 % of non-whitespace
characters; otherwise `norm`/`dev` are `undefined` and the verdict falls back to the absolute
threshold rather than borrowing a curve fitted on another language. This machine has 5,748
English blocks and zero severe English loops, so there is nothing to calibrate against — an
English curve exists in the research notes but is unverified and deliberately not shipped.

**The tail is now measured directly, not inferred.** `trailingRepeat()` is the pure-text port of
llama.cpp's DRY sampler: reverse the text, run a standard Z-array, and find the shortest period
that repeats at the end. The check is `z[period] >= period` — *not* `z[n − period]`. Both agree on
text that repeats end to end, which is why the wrong one survived the first round of tests; they
disagree on the real case (normal content followed by a looping tail), and only the former sees
it. A feedback-loop test caught it. Output is `{period, repeats, span}`, which is what compression
ratio cannot answer: *from which character, and how many times*. It also restores the
"at the end of the generation" constraint that Holtzman's original criterion had and that our
whole-block compression ratio dropped.

`repeatSeverity(repeats) = 1.75^(repeats − 2)` gives DRY's exponential shape, capped at
`88.72 / ln(base)` so 100 repetitions does not report 6.6e23. Severity tiers (轻微/中度/严重) are
what the notice text uses; the raw score is for ordering.

### Added — stream-time detection, which reports and never truncates

`lib/stream-guard.js` watches `agent/assistant-stream`: frames carry
`{type:'reasoning-delta', index, text}`, so reasoning is observable **while it is being generated**,
not only after the step lands. Every 24 deltas it runs the tail check over the last 4,096
characters, with a stricter bar than offline (5 repetitions vs 3, span ≥ 200) because "repeated
three times" mid-generation is often just parallelism.

**It never stops the stream.** PREWARN measured windowed repetition scores firing on 79.5–100 % of
long answers that judges called non-degenerate; using such a rule as a stop condition would cut off
essentially every legitimate long task. vLLM is the only inference framework that implements
"stop on detected repetition", and its detector is exact-period matching — it cannot see
`做。做。做。`, which drifts. So the guard only produces a verdict, and `pre-step` turns it into one
notice: once per step, only after the step has ended, with numbers but **never the repeated text**
(later revised to one notice per turn and no counts — see *one notice per turn, deduped per session*);
kept as written because it records what this release changed
(writing the snippet back into context feeds the loop it describes).

Measured on 254 session directories: 14 contain severe loops. The best test subject is
`session-ccc00003` (18 turns, 16 loop blocks over 6 turns, compression 0.038) because it repeats
the same tic as the session that started this investigation — `做。` / `好。` / `执行。` — and also
contains 549–2,033 character blocks small enough to verify by hand.

Test count 377 → 389.

### Added — a settings switch for the experimental stream guard

`streamGuard` (boolean, **default `false`**) appears in the plugin's settings panel and
turns the stream-time detector on or off at runtime. It is volatile, so no reload is
needed. `status` prints one line saying whether it is on — "off" and "on but never
triggered" have to stay distinguishable, otherwise there is no way to tell a switch
problem from a criterion that simply never fired.

Off by default because it is the only part of this feature that has not run against a
real session, and because a false stream verdict writes bad advice into the context
rather than just making a report line wrong. It has no "stop on repetition" mode at
any setting: PREWARN measured windowed repetition criteria firing on 79.5–100 % of long
answers judges called non-degenerate, so that switch must not exist.

Test count 389 → 390.

### Fixed — the stream guard was blind to the most common loop shape

Found by the user actually running it: a turn produced ten reasoning blocks that were all
textbook loops — a single row repeated **108–176 times**, compression down to 12–34%, deviation
**5.2–10.1σ**, every one of them caught by the offline criteria — and the guard said nothing.
Zero reminders.

The cause is a shape the guard could not see. `trailingRepeat` matches a **strict** period, so it
only recognises `A A A A`. Real reasoning loops look like this:

```
好。 好。 好。 好。 （输出） 好。 好。 好。 好。 （好） 好。 好。 好。
```

A main period with **periodic insertions** interrupting it. Each insertion resets the strict match,
so `trailingRepeat` returned `null` for all ten blocks; the row's repetition count was plainly
visible the whole time.

The guard now also counts rows (`repeatedRow`): if one prose row repeats ≥30 times **and** covers
≥50% of the window's rows, that is a loop (this first cut was later recalibrated to ≥10 repeats plus a
≥20-row floor and length-normalised ratios — see *the row criterion was 3× too blunt*, above; both
numbers are kept here because each records what its own release changed). `proseRows` already strips code lines and fenced
blocks, so `}`, `);` and similar never reach it. Verdicts carry a `kind` (`tail` for a strict
period, `line` for row repetition) and the reminder reads `思考流尾部有一行内容已重复 141 次（占 160
行里的 88%）` — still never quoting the repeated text, since feeding it back reinforces the loop.

Also fixed: `end` now runs a closing check. A 703-character block at 40 characters/delta is only
18 deltas, so with `checkEvery=24` it never entered a checkpoint at all — and short blocks are the
most typical degenerate form. Replaying the ten real blocks now fires on **10/10**, at delta
18–43.

Two of the new tests were initially passing for the wrong reason: they fed `textDelta` (a
`text-delta` frame, deliberately ignored) instead of `delta` (a `reasoning-delta` frame), so
nothing was being streamed to the guard. Fixed, which is what turned the "offline says loop,
stream says nothing" reproduction into a red test.

Test count 398 → 402.

### Fixed — saving any field blanked the whole settings panel

`tf(zh, vars)` does `Object.entries(vars)`; one call site passed no second argument:

```js
? h('span', ..., h(Spinner), tf(' 保存中'))   // ← Object.entries(undefined) throws
```

That line is the `busy` branch of `FieldRow`, and `busy = pending.has(item.key)`. So the crash
needed an actual edit: the moment any field entered the pending state, React hit
`Cannot convert undefined or null to object`, tore down the subtree, and the section went **blank**
— no message, nothing in the toolbar. Reading the panel without changing anything was always fine,
which is why it survived: every render test passed `pending` as an empty `Map`, so the `busy`
branch had never once executed.

`tf` now defaults `vars` to `{}` so a missing argument can no longer take out a whole page, the
call site uses plain `t()` (the template has no placeholders anyway), and two tests pin it: one
renders all three tabs in both languages *with* fields in the pending state, the other rejects any
`tf('literal')` call that omits the second argument.

The panel had three separate coverage gaps that let this through, all now closed:
`render.test.mjs` only rendered the default tab; `configForms.get()` returned `null`, so every
render test took the read-only `StaticPanel` path and `LivePanel` had never executed;
`tools/probes/render-smoke.mjs` now accepts `form`, `tab` and `pending` and drives the real path.

Also: a stalled config read used to spin forever — `ensure()` reuses an already-stuck `inFlight`
and nothing retries, which the code comment itself warned about. It now says so after 5 seconds.

Test count 390 → 398.

## [1.0.0-beta.1] — 2026-11-20

### Two defects fixed before this release

Two defects that only a real Host and a real CI could expose. Both were introduced by
1.0.0-beta.1's own validation round, and both were invisible on Windows.

### The settings panel could never load — on any platform

`schema.toJSON()` cannot serialize a `transform`: the callback is a **function**, so what
reaches the browser is only `{"type":"transform","meta":{}}`. The client rebuilds it with
`new Schema(json)` and `validate()` calls `schema(draft)` — the rebuilt node then throws
`TypeError: callback is not a function`. `decode()` catches that and returns `undefined`,
and `derive()` **skips every state update**, so `status` keeps its initial `'loading'`
forever. No timeout, no error, no retry; refreshing and restarting DSH change nothing
because it is a code defect, not a stuck request.

First attempt at a fix made the callbacks self-contained (argument and true globals only),
which defeats the `ReferenceError` but **not the missing callback** — a transform is
unserializable by construction. Both fields now use plain `pattern`s:

- `anchorRoot` — four negative lookaheads reject `..` path segments (exactly, after trim)
  while the body requires one non-space character and no control characters. Its
  acceptance set is pinned against `normalizeAnchorRoot` by a sample matrix.
- `notifyTokens` / `notifyRepeatDelta` / `compactRetainTokens` — the human-unit branch is a
  pattern whose numeric ranges are split per unit, because the parser multiplies by
  **1024** and **1048576** (not 1000/1000000), so the integer ceilings are 976562 for `k`
  and 953 for `m`. The segment boundaries are asserted against `resolveConfig` (±1 each),
  since a gap there is exactly how "schema accepts, parser rejects" reappears.

Both were also silently breaking writes: the `"300k"` / `"1m"` union branches rejected
every string after a round-trip.

### CI was red on ubuntu and green on windows

`dshHome` was validated with `node:path`'s `isAbsolute`, which is **platform-dependent**,
while the panel's `isAbsolutePathInput` hard-coded win32 semantics. On Linux that pair
disagrees: the panel accepts `D:\…` and the resolver rejects it — "saved" in the UI, field
dropped at mount. All three Node versions failed on ubuntu, all three passed on windows.
The rule is now one platform-independent regex shared by both sides.

### Tests

Three regressions, all mutation-verified — reintroducing a `transform` turns the first two
red, and the second reports the shipped symptom verbatim (`callback is not a function`):

- `Config schema 不得包含不可序列化的节点（transform / custom）` — walks the schema tree and
  refuses function-backed nodes. The first version of this test was useless: schemastery
  nodes *are* functions, and the walk skipped anything that was not `typeof 'object'`, so it
  never visited a single child.
- `经宿主 volatileForm 往返后 schema(draft) 不抛` — reproduces the real path. `describe()`
  sends `volatileForm(Config).toJSON()`, and `volatileForm` re-serializes every volatile
  field through `new Schema(s.toJSON())`; that second round-trip is where the callback dies.
  A single `Config.toJSON()` round-trip still works, which is exactly why an earlier test
  was green while the panel was broken.
- `dshHome 绝对路径判据平台无关，且面板闸与解析器同源` — plus a **static contract** that the
  rule must not import `node:path`, because on Windows `isAbsolute` agrees with the target
  regex and runtime samples cannot catch the regression there.
- `人类单位 token：schema 接受集与解析器逐样本一致（含每个分段边界）` — the per-unit pattern
  ranges are asserted against `resolveConfig` at every segment boundary ±1; a gap between
  segments is precisely how "schema accepts, parser rejects" comes back.

Test count 360 → 365.

### Changed — the anchor source tag is now `[人工明确]`

The third source tag was renamed to `[人工明确]` ("human-stated") ahead of making this
repository public. The label it replaces named a *relationship* rather than a *source of
evidence*, which reads wrong to anyone outside the project and should not ship.

The trio now reads symmetrically: `[实测 YYMMDD]` means measured, `[推断未验证]` means inferred,
`[人工明确]` means a person stated it in that round.

**This is a contract change, not just wording.** `guard` builds its signature only from the
three known tags, and `validate` counts `[人工明确]` rows when checking the hard-constraints
section. An anchor that still carries the old label keeps its text but stops contributing to
either check. Anchors written before this release should replace the label; `guard` will report
the constraint as dropped otherwise, which is the intended fail-loud behaviour.

### Fixed — sixth pass: two regressions from the previous round

A reviewer went over the fifth-hunt diff with one question: does this change break anything
that used to work? Twice, yes.

- **A disabled instance deleted another instance's queued compaction.** Sharing
  `pendingCompact` made the queue process-wide, but the `!config.enabled` branch still ran
  `pendingCompact.delete(agent)` unconditionally. Each instance's `agent/status` handler is
  synchronous up to its first `await`, so the instance mounted first always runs first: if it
  had been hot-disabled, it silently deleted the other instance's queued `/compact` while
  that instance's receipt had already said "queued" and `status` promptly went back to
  "none". Disabling now means "I stop serving", not "I clean up after you". The same
  reasoning applies to the missing-`commands` branch: it no longer deletes the entry either
  (a live instance may be able to run it), and `status` keeps reporting "queued" so the
  problem stays visible instead of silent.
- **`state` snapshotted the shared tables, so `resetSharedGates()` could quietly undo the
  sharing.** Those five fields are getters now, so every access reads the current table. With
  the snapshot version, resetting between two `apply` calls left the older instance pointing
  at the old table — sharing silently degraded to per-instance, which is exactly the bug the
  previous round set out to remove, and the suite would still have been green.

Both are covered by tests (a disabled instance must not drain the queue; a reset between two
`apply` calls must not break sharing) and both mutations turn the suite red.

Test count 354 → 358.

### Fixed — fifth defect hunt: five angles nobody had reviewed

The first four passes covered AI-wrapper behaviour, product design, config write-back,
Windows depth, user journeys, code quality, security, permissions, concurrency, host
contracts, coverage, fuzzing and races. This one went after the slash-command layer, the
tool's fourteen actions, apply/dispose lifecycle, documentation-vs-code drift, and
numeric/formatting edges. Five parallel reviewers produced 24 findings; 19 held up under
verification and are fixed below.

- **The preview readout treated "cannot decide" as "balanced".** `status` walks a balance
  guard to predict where a compaction would cut. Round four fixed the *real* path to
  treat a thrown guard as unbalanced (`balanced = false`) but missed the copy inside the
  preview, which still caught and continued as if the boundary were fine. The preview
  therefore announced a cut point that the real path never produces — that path walks all
  the way left into its hard boundary and turns into a no-op. Both copies now agree.
- **`reconcile` counted only `[-*]` bullets.** Round four replaced that pattern with
  `LIST_ROW_PATTERN` for `validate` and `guard`; `reconcile` kept the old filter, so a
  `## 硬约束` written as `1.` / `2.` reported `硬约束：无条目` while the other two actions
  saw two entries. All three now share one definition.
- **`reconcile` re-introduced a bug `summary` had already fixed.** On a fresh session
  (`seq=0`) it reported "cannot read the summary tail window" and then pointed the agent
  at `action="summary"` — which answers "this session has no events yet" and denies the
  failure. The fresh-session check now runs before the error branch, as it does in
  `summary`.
- **A non-string `stage` argument was silently dropped.** `defer.tokens` and
  `compact.retainTokens` reject type errors outright; `stage` was the one argument that
  fell back to "not provided". The consequence is severe for `guard`: it re-baselines the
  *latest* stage instead, erasing the evidence it was asked to protect, while the receipt
  only says "baseline established". All four stage-taking actions now reject it.
- **A queued `/compact` got 300 s where the same work gets 900 s elsewhere.** The host
  reports an aborted compaction as an error result, so the plugin's own timeout was
  recorded as a *failure*: 60 s base backoff, doubling to 15 minutes, plus a "compaction
  failed" injection on the next pre-step. Same budget on all three paths now.
- **`/anchor status` never reported a degraded config.** The tool side has printed
  `配置降级: …` since round two; the slash command — which the README calls the human's
  only entry point — did not. With a broken config it showed default values as if the user
  had set them. Parity restored.
- **`defer` could raise the line above its own emergency floor and still promise a
  reminder.** The hard ceiling is 90 % of the window while the emergency auto-compaction
  line is 85 %; between them automatic compaction runs first, so "到新的线照常提醒" is
  unkeepable. The 90 % ceiling stays (someone may genuinely want "as late as possible"),
  but the receipt now says so instead of promising.
- **`usage` said "directory exists but has no files" while also saying the numbers were a
  lower bound.** A truncated scan means "nothing found *in the part scanned*", never
  "nothing exists". `cleanup` already had this guard; `usage` was missing it.
- **`formatBytes` printed `1024.0 kB`.** The unit promotion was decided before
  `toFixed(1)`, so 1,048,570 bytes rendered as `1024.0 kB` (and the MB rung as
  `1024.0 MB`). Both copies (`lib/usage.js` and the panel's) now round first.
- **`validate` put a check it never ran under "✓ 已满足".** With no guard baseline it
  printed `✓ 没有 guard 基线（先跑一次 action="guard" …）` — a precondition, ticked as
  satisfied. There is now a separate `本轮未执行：` section.
- **`notifyTokens` reported "must be a positive integer" for values that are positive
  integers.** Anything above `1,000,000,000` (including `954m`, which the same message
  advertises as valid) got a message that named no bound. It now states the range.
- **The `defer` receipts only named `/anchor reset`.** The `reset` action exists precisely
  because an agent cannot type a slash command — its own comment says so — yet the receipt
  never mentioned it.

Documentation corrected against the code: the Chinese README listed presets
`128k/200k/1M` while the code has `256k/512k/1M` (the English README was right);
`VALIDATION.md` claimed 320 tests and a 128k preset that uses `unset` (it is 349 tests and
no preset unsets); `ARCHITECTURE.md` still quoted the old 97,085-token retain figure
(119,040); `CONFIGURATION.md` gave `+05:45` as an example of a value *outside* the
dropdown when `+05:45` is in it, and documented `dshHome` as a bare `string` although a
relative path is dropped; `PRIVACY.md` promised only two environment variables are read
while `SystemRoot` is read too.

Tests: five new cases (balance-guard throw inside the preview, non-string `stage`,
`defer` above the emergency floor, `formatBytes` promotion, the token ceiling message).
Test count 344 → 350. **Not covered by a test:** the `reconcile` bullet pattern and its
fresh-session branch — both verified by code reading and the reviewers' probes, and both
tracked as follow-up work rather than left silently unverified.

### Fixed — multi-instance duplicate reminders, plus the two untested follow-ups

- **Two plugin instances in one process injected two byte-identical reminders.** DSH can
  mount more than one instance — `lib/prestep-log.js` shares its queue process-wide for
  exactly this reason — but `lastNotified`, `autoCompacting`, `manualCompacting`,
  `pendingCompact` and `deferredNotify` were rebuilt on every `apply`. "Remind this
  session once", "one compaction at a time" and "one queued `/compact`" are **process-level**
  facts, not per-instance ones, so both instances injected the same closing reminder (the
  model pays for it twice and does the work twice). Those five tables now live in module
  scope (`sharedGates`), the same sharing model as the pre-step log. `resetSharedGates()`
  exists for tests only: the suite drives dozens of cases through one fixed session object,
  so it has to start each case clean.
- **`windowProbeWarned` is now verified per instance.** The test drives two contexts and
  asserts each warns exactly once, and that a second trigger on the same instance stays at
  one. Writing it also confirmed the shared gate works: the second instance correctly
  suppressed a same-session reminder and therefore never reached the window read — the
  test had to give each instance its own session object.
- **The clock-rollback clamp has no test, and cannot have one here.** That path is
  POSIX-only, the function is internal (`recoverStaleStageReservation`), and the stage name
  is derived from the call instant, so no public entry point can construct a colliding
  reservation on Windows. Recorded rather than faked — the fix is a one-line clamp whose
  behaviour is visible in the code.

Test count 352 → 354.

### Fixed — follow-up to the fifth hunt

- **`reconcile`'s fresh-session check was in the wrong place, and fixing it exposed a
  third path.** Writing the test showed the check only ran inside the `error` branch; the
  "coverage empty" branch still told a brand-new session "cannot read the last summary —
  first confirm this session was compacted", which is a tautology for a session that has
  no events. The check now runs before both branches. Both `reconcile` cases are covered
  by tests now, so the "not covered" note above no longer applies.
- **`ANCHOR-POLICY.md`'s template block swallowed two prose sections.** Three paragraphs
  of explanation (the "say where each constraint came from" argument and the
  "verifying before you act" section) sat *inside* the ```` ```markdown ```` fence, so
  copying the template would have written them into the anchor. The block is split back
  into template / prose, a duplicate `## Next step` heading is removed, and the headings
  now match what `action="scaffold"` actually writes (`## 目标`, `## 当前进度`,
  `## 关键入口`, `## 会话索引`).
- **A backwards clock printed "已 -3600 秒".** The stage-reservation age used
  `Date.now() - createdAt` without clamping, unlike the two other countdown sites in the
  same file. (POSIX-only path; unreachable on Windows.)
- **`windowProbeWarned` was a module-level boolean.** It neither reset on dispose nor
  distinguished instances, so after a remount the single warning about
  `tokenMeter.contextPressure` throwing — the one signal that the emergency compaction
  line silently fell back from 85 % of the window to `compactRetainTokens × 4` — never
  appeared again. It is now a `WeakSet` keyed by context.

Test count 350 → 352.

### Fixed — fourth defect hunt: host-contract assumptions, config shape, hot-update races

A fourth pass went where the first three had not: the host's own source (what the plugin
*assumes* it does), `node --test --experimental-test-coverage`, randomized property tests,
and concurrency.

- **"Retryable" was decided by matching one wording of the host's error.** The engine
  throws `SurfaceChangedError` from five places with five different messages, and only one
  reads `surface changed during summarization`; the other four were treated as permanent
  failures, so a transient surface race charged the full backoff and stalled automatic
  compaction. The check matches the error class first (the host class sets no `name`, so it
  compares the constructor name) and falls back to a pattern covering every known wording.
- **"Cannot tell" was treated as "balanced".** The host's `toolPairingBalancedBefore`
  contract is "throw when undecidable, callers must not continue"; the caller caught the
  throw and treated the cut as balanced, letting an unverified boundary through — the host
  then rejected it, after a full summarization call had already been paid for.
- **`Date` / `Map` / `Set` / `RegExp` were silently accepted as configuration.** The shape
  guard ran *after* the live-reference flattening step, which turns any object into `{}`
  when it has no enumerable own properties, so `resolveConfig(new Date(0))` produced a
  full default config with no warning — exactly what the shape check exists to prevent. The
  guard now runs first and rejects built-in non-mapping types, while still accepting class
  instances and `.volatile()` references.
- **A cyclic or BigInt config escaped the error contract.** `JSON.stringify(10n)` threw a
  `TypeError` from inside the diagnostic path (so the message named neither the key nor the
  plugin), and a cyclic config recursed into `RangeError: Maximum call stack size
  exceeded` — including from `resolveConfigLenient`, whose whole purpose is not to throw.
- **A hot update during a suspended compaction produced a provably false sentence.** The
  reminder compared a threshold captured before the `await` with the *new* config's value
  and rendered the difference as `（配置值 200,000，本会话已临时提升）`, telling the model a
  `defer` registration existed that the session never made and that `status` did not show.
  One snapshot per step now feeds the whole sentence.
- **Disabling the plugin mid-compaction still injected a full closing reminder.** The
  `enabled` check only ran at the entry, so a setting saved during the (tens of seconds
  long) summarization call was ignored; it is now re-checked against the current value
  before anything is injected.
- **The `/compact` fallback receipt did not say it discards the verbatim tail.** That path
  runs the host's `compactNow`, whose retain budget is hard-coded to `0`, so it summarizes
  the tail away and the plugin's own `compactRetainTokens` never applies; the receipt now
  says so instead of implying the two paths are equivalent.
- **`status`'s settings probe compared a package name against a profile entry id.** The
  host reports `ns: entry.options.id`, so a bundle naming its entry differently got a
  confident "panel is read-only" — the opposite of the truth.
- Corrected a stale docstring: `selectRetainedRange` with `retainTokens = 0` keeps the last
  node **on purpose** (discarding it would leave the model with no verbatim context at
  all), contradicting the comment that claimed it compacted the tail completely.

Nine new regression tests cover the above; every repair was mutation-verified. Coverage was
also measured for the first time (87.9% lines / 76.3% branches across `lib/`); the
uncovered production paths are classified as follow-up work rather than claimed as fixed.

### Tests — the preview readout

`status` prints what a compaction would do before it happens ("compactable range: N nodes",
"kept verbatim: M nodes, X tokens, budget Y"), and that readout is the only way to tell
whether the tail will survive. The budget is applied by whole session nodes, so the kept
total is always *at least* the budget; the test pins that direction. If a change ever makes
it report less than the budget, the retained range was undercounted — and the cost is the
model silently losing verbatim context, with no other signal.

Test count 343 → 344.

### Tests — property tests promoted from the audit, plus two defects they surfaced

The fourth-hunt reviews ran roughly 114,000 randomized calls from throwaway scripts in
`.tmp`. Three of those properties are now permanent, and two of the defects they found are
fixed.

- **Time-zone acceptance is now exhaustive over a small alphabet**: all 7,380 strings of
  length 1–4 over `+ - 0 1 5 8 9 :` and space are checked against both the schema pattern
  and `normalizeTimeZone`, asserting the two agree on every one. The earlier test
  hand-listed candidates, so it could only cover shapes someone thought of.
- **`formatCount(-0)` returned `"-0"`.** Reachable through `anchorTimeZone: '-00'`
  (`normalizeTimeZone` computes `-1 * 0 * 60`) and `keepAnchorBackups: -0`; it displayed as
  `-0`, which reads like a broken config rather than "zero".
- **`coverageForRange` treated a missing `hasGap` as "proven no gap".** A ring with a hole
  in the middle reported `complete`, whose contract is "safe to cite as the whole log". It
  now derives the flag from seq continuity exactly as `readRecentFactsState` does, and an
  explicitly present flag still wins. The derivation also had to reach the *decision*
  branch — changing only the reported field left the decision reading the raw input, which
  is why the first version of the test failed.
- **`status`'s "distance to the reminder line"** had no assertion at all; inverting
  `total >= lineStatus` kept the suite green while flipping the answer to "should I start
  wrapping up", the question that readout exists to answer.

Test count 337 → 341.

### Tests — the settings panel's field gate finally meets a test

`lib/client.js` (2,300 lines) had only static regex assertions: nothing exercised the gate
that decides whether a value may be saved. Two cases now run it, extracted from the bundle
by brace matching so no production code moves.

- **Panel acceptance vs host acceptance**, checked against each other for 23 inputs across
  `anchorRoot`, `dshHome`, `anchorTimeZone`, `notifyTokens` and `guardMaxBytes`. The test
  asserts *equality* rather than hand-written expectations — the first draft hand-wrote
  them and got two wrong (`"  docs/anchors\t"` is trimmed by both sides and therefore
  accepted; `coerceTimeZone` returning `undefined` does not mean the host rejects). It also
  has to route `anchorTimeZone` through `coerceTimeZone`, because that is what the real
  submit path does; using the generic `coerce` reported a drift that did not exist.
- **`formatError` per-field branches**: a well-formed value that exceeds the ceiling must
  say "the result may not exceed N", not "bad format" — the old text told users to fix a
  format that was already correct.

Test count 335 → 337.

### Tests — coverage gaps closed for the paths that had none

`node --test --experimental-test-coverage` reported 87.9% lines / 76.3% branches and
exposed six production paths that no test had ever executed: mutating each one left the
whole suite green, which is how they were found. All six now have regression tests, and
every one of the seven new cases was mutation-verified.

- **The compaction fail-closed valve.** When the open turn boundary cannot be proven (no
  `agents` service, a throwing projection, a non-integer seq) or when the balanced cut
  lands before the turn start, compaction must refuse — guessing a boundary would
  summarize history the current turn is still using, irreversibly. Both refusal paths
  were unexecuted.
- **`guard` accepting an empty anchor.** `scaffold` produces no `## 硬约束` rows, so
  "scaffold, then guard" is the most natural start; the guard now refuses to write a
  baseline with zero entries instead of promising a comparison that protects nothing.
- **Re-running `guard` over an existing baseline.** The receipt tells the user to re-run
  it to update a baseline; that overwrite path (tmp file plus rename over an existing
  file, behind the inode/link checks) had never run end to end.
- **The anchor character cap.** The only mechanical brake against anchors growing without
  bound: a 200 KB anchor used to get "no problems found".
- **The repeat-risk render after a successful compaction.** It runs *after* history has
  been rewritten, and a field drift there turns a completed compaction into a reported
  tool failure.
- **`status`'s queued-compaction readout.** The only external view of the
  `pendingCompact` / `autoCompacting` state machine; inverted readings kept the suite
  green while pointing whoever debugs it in the wrong direction.

Test count 328 → 335. The two limits of the compaction-discovery route (multiple isolates
making the engine choice ambiguous, and `ctx.loader.internal.import` not being a public
entry point) are now documented in `docs/ARCHITECTURE.md` instead of being silently
assumed.

### Fixed — third defect hunt: no-op wording, list-row evidence, panel parity, stale docs

A third pass read the shipped strings, the settings panel, the release script and the
documentation against the code that produces them. Every finding has the same shape: a
sentence that was true when it was written and had quietly stopped being true.

- **A normal automatic `no-op` was explained with the `skipped` sentence.** The model
  was told `自动压缩本轮没有启动（退避中或正在压缩）` while the same `status` held no
  backoff entry and no in-flight compaction — range selection had already finished and
  concluded there was nothing to compact; the `no-op` text now says the round needed no
  work, that nothing failed, and that no backoff is involved.
- **`guard` and `validate` counted a 4-space-indented code block as constraint rows.**
  CommonMark reads four leading spaces as an indented code block, so a quoted or
  commented-out `- item` inside one entered the baseline and was then reported as a
  deleted constraint the moment the example changed; a list row now requires at most
  three leading spaces.
- **The settings panel rejected an absolute `dshHome` the host accepts.** `\data`
  (current drive root plus a directory) is an absolute path on Windows, but the panel's
  test only allowed `C:\`, `\\` and `/`, so a value written in YAML could not be saved
  back and the error message insisted it was not absolute, although it was; the panel
  now uses the same win32 absolute-path rule as the host.
- **`tools/Pack.ps1` claimed a packaged-file-list check it never ran.** Its help header
  promised the artifact's file list would be verified before success, but the script
  only ran `npm pack`, so a `files` entry missing from `package.json` still exited 0;
  success now requires `Test-Package.ps1` — the one place that holds the expected
  release manifest — to run and pass.
- **This batch's documentation described the code as it used to be.** `docs/RELEASING.md`
  listed 25 artifact files while `npm pack` ships 26 (`lib/repeat-scan.js` was missing);
  `docs/SECURITY.md` and `docs/ARCHITECTURE.md` still described linked roots as
  unconditionally refused, without the workspace-junction exception that now decides
  them; `docs/ARCHITECTURE.md` claimed an active PID is never auto-cleaned after the
  sidecar TTL was added; and its coverage list omitted `partial-window`. All of it now
  matches the code.

### Fixed — second defect hunt: state machines, coverage honesty, config parity

A second full sweep (17 reviewers over every file plus cross-cutting angles) found a
class of defects the first hunt missed: places where the plugin **reported more
certainty than it had**, plus two state machines that had escaped because no test
ever reached the branch.

**`anchorRoot` had two different acceptance sets.** The schema checked the raw string
with one regex while `resolveConfig` trimmed first and checked the trimmed value, so
the two disagreed in *both* directions: `"docs/.. "` (a `..` segment followed by
whitespace) passed the schema and was rejected by the resolver — `resolveConfigLenient`
then dropped the field and anchors were written to the default directory after the
panel had reported "saved"; `"docs/anchors\t"` was refused by the schema and accepted by
the resolver. An exploratory 400-sample sweep found 44 schema-wider and 88
schema-stricter cases; the regression test that pins the repair runs a fixed 300-sample
grid (5 prefixes × 15 bodies × 4 suffixes). Both boundaries now call one
`normalizeAnchorRoot`, so the acceptance sets cannot drift apart again.

**Inode identity was never compared on Windows.** `readAnchorFile` and both
`prestep-log` paths guarded the lstat/fstat identity check with
`Number.isSafeInteger(ino)`. NTFS returns a 64-bit file index as a `Number`, so on this
platform that guard was always false — the swap-detection branch was unreachable and
the reader fell back to "the opened file is a regular single-link file", which cannot
prove *which* file it is. The code comment and `docs/SECURITY.md` both claimed the
window was closed. All three sites now `lstat`/`stat` with `{ bigint: true }` and
compare unconditionally.

**A queued `/compact` that compacted nothing was recorded as a success.**
`dsh-command-compact` returns `kind: "success"` with the text
"No compactable history yet." when there is no compactable history; only a real
compaction carries `sourceEventSeq`. Treating that as success charged the 60-second
success cooldown, cleared the pending turn-stopping failure notice, and cleared the
reminder quota even though the context size had not changed. The success branch now
requires `sourceEventSeq`.

**Tool-fact coverage said "complete" for a tail-only scan.** `collectToolFacts` requests
`[seqCount - 5000, seqCount)` and `coverageForRange` judges *that range*; a session with
more than 5,000 events therefore reported "覆盖：完整" while tool calls before the window
had never been read. A truncated scan now reports the new `partial-window` status and
names the window size, so the anchor and `status` cannot claim a whole-session scan.

**Emergency compaction had no `no-op` branch, and reminder throttling went silent.**
With `agentDecidesCompaction: false` and occupancy past the emergency line, a `no-op`
outcome matched none of the success/skipped/failed branches, so the reminder quota was
never written: `lastNotified` stayed empty, the growth and time gates could not fire,
and the same close-out reminder was re-injected on the first step of *every* turn while
`status` still said "配额：未触发". `no-op` now reports once (like `skipped`) and is
charged to the quota.

**`defer` was bypassed whenever occupancy sat between the emergency line and the
deferred line.** The reminder gate only blocked when `total < emergencyLine`, so a
session at 860k with the line deferred to 880k still received the full 13-line
close-out reminder, and `defer tokens="off"` received one quoting
`9,007,199,254,740,991` as its reminder line. Any non-successful emergency path now
re-applies the deferred line, and an empty reminder body is no longer turned into an
empty user message.

**After three consecutive surface races the model was still told to retry
immediately.** The `raced >= 3` branch installs the failure backoff and then returned
`retryable: true`, so the pre-step text promised "下一次 pre-step 会立即重试" while the
next turn-stopping exited at the cooldown gate without trying. The branch now returns
`retryable: false`, matching what the sibling engine-missing branch already did.

**The reported config degradation did not follow a live settings update.**
`configFallbackReason` was written once at mount. After the user fixed the offending
field through a `loader/volatile-update`, `status` still claimed the values were running
as defaults and advised a restart that was no longer needed; a bad field introduced by a
later update was invisible. The handler now sets and clears it.

**`npm run check` ran 292 tests while the release checklist promised 297.**
`test/regressions.test.mjs` was missing from the `check` script, so the five regression
tests that pin the first hunt's fixes were never run locally and `docs/RELEASING.md`
could never be satisfied. Added.

**A non-object config was silently replaced by all defaults.**
`resolveConfigLenient` reports what it dropped via `dropped`, and callers report only
when that array is non-empty. An array, string or number has no field names to list, so
the array stayed empty and the plugin mounted with every default — including
`enabled: true` when the user had turned it off. It now returns a `shapeError` that is
reported the same way.

Also fixed:

- **`raceFailures` was never reset by a no-op/skipped/cancelled attempt**, so two stale
  races plus one new failure immediately wrote the failure backoff while the log claimed
  "连续 3 次".
- **The reminder told the model to run `/anchor status`.** The same file documents in
  its `reset` action that the agent cannot run slash commands; the reminder now points at
  `stage_handoff(action="status")`.
- **The summary cap was described as "64 KiB" in two model-facing strings and four
  documents.** The constant counts UTF-16 code units: 65,536 of them are ~192 KiB of
  Chinese text. The wording now says code units.
- **`configurationWarnings` returned early when the window was unknown**, swallowing the
  two `anchorLimitChars` warnings, which have nothing to do with the window.
- **`clearCompactionFailure` was dead code.** It was only set on the emergency-success
  path, which returns before the only place that reads it. The branch now deletes the
  failure record directly instead of routing through a flag that could never be read.
  `markCompactSuccess` already cleared it on this path, so no visible behaviour changed —
  this removes a trap rather than fixing a live bug, and a regression test pins the
  outcome either way.
- **A low-water pre-step could mark a `defer` as activated without crossing the
  configured line** (the branch cannot return early when it is carrying a turn-stopping
  failure), and the next step then deleted the registration — the defer silently
  expired.
- **The summary slice could cut a surrogate pair in half**, leaving a lone high surrogate
  that becomes U+FFFD on the way out (`recall` already walks code points).
- **`scaffold` refused a workspace that was itself a junction.** With a relative
  `anchorRoot` whose directory did not exist yet, the nearest existing ancestor *is* the
  workspace root, so the link check failed on the user's environment and blamed
  `anchorRoot`. The realpath containment check below already handles that case.
- **`validate` reported a guard "tag change" that had not happened.** When a baseline
  held the same constraint twice and one copy was deleted, the extra note printed the
  remaining text as the "current" form even though it was identical to the baseline.
- **`status` presented the in-process compaction count as fact.** It only counts
  `compaction/end` events seen since mount, so a restarted session showed `0 次` with no
  coverage note; the line now says it is process-scoped.
- **`status` turned "cannot read the diagnostic file" into "the hook never ran."** It
  printed both claims in the same output.
- **Ordered markdown lists were invisible to `validate` and `guard`.** The filters only
  accepted `-`/`*`, so `## 硬约束` written as `1.`/`2.` produced "一节存在但没有条目",
  a zero-entry guard baseline that still promised comparison, and a green
  "✓ 与基线一致" after one of the entries was deleted. The plugin's own scaffold uses the
  ordered style in `## 下一步`, so this was easy to hit. All list-row filters now share
  one pattern.
- **An untouched scaffold reported "下一步……可直接执行".** The placeholder
  `1. <打开哪个文件 / 跑哪条命令…>` contains a `/`; the check now strips angle-bracket
  placeholders before looking for an executable token.
- **The event ring trusted a missing `hasGap` as "no gap".** A mixed-version projection
  fallback can inject a ring without that field; continuity of `seq` is now derived when
  the flag is absent.

### Fixed — full-repository defect hunt

Fourteen reviewers covered every file plus five cross-cutting angles (concurrency,
error handling, boundaries, resources, trust boundaries) and reported 43 findings;
24 reproduced and are fixed here.

**`dshHome` could silently disable the whole configuration.** The Config schema
declares it as a plain `string`, but the resolver requires an absolute path. A
relative value therefore passed validation, threw in `resolveConfig`, and the
mount path fell back to `resolveConfig({})` — restoring *every* field to its
default. The worst case was `{ enabled: false, dshHome: "data" }`: the user's
explicit "off" was discarded and the plugin mounted with reminders, tools and
listeners registered, while an absolute `anchorRoot` was thrown away in the same
move. `resolveConfigLenient` now degrades field by field and reports what it
dropped; the settings panel rejects a relative `dshHome` before it can be saved.

**Event-ring coverage claimed completeness it did not have.** `readRecentFactsState`
normalized the ring and dropped `hasGap` on the way, so `coverageForRange`'s
`partial-gap` branch was unreachable from every production call site: a ring with
a real hole reported "complete". The existing test fed the raw state straight to
`coverageForRange` and walked around the normalizer.

**Two checks disagreed on the same evidence.** The per-turn anchor-drift check
compared a `Set` while `validate` compared a multiset, so deleting one of two
identical constraints was reported by `validate` and silently passed by pre-step.
The baseline deliberately stores duplicate occurrences (v3); the drift check now
uses the same multiset comparison.

**Automatic compaction could swallow the reminder it was carrying.** The `failed`
branch returned early when a repeated failure reason matched the previous one —
the same early-return the `skipped` branch had already been fixed for. Every retry
cycle therefore dropped one reminder. Separately, the emergency-compaction path
charged the **pre**-compaction total to the notify quota; because the growth gate
compares against that number, a shrinking context could never clear it and both
the reminder and the emergency compaction behind it went quiet permanently.

**`defer tokens="off"` also turned off automatic compaction.** It raised
`effectiveNotify` to `MAX_SAFE_INTEGER`, and both compaction gates used that same
line — so the receipt said only that reminders were off while two safety valves
closed silently.

**`/anchor threshold` did not survive an unrelated settings save.** The override
was written into the derived config snapshot; any `loader/volatile-update` rebuilt
from `rawConfig` and reverted it, while the receipt promised "this process only".

**Recall answered "not found" for code blocks.** It searched the structure view
that blanks fenced regions (correct for `validate`, which must not treat examples
as facts). Fenced content is still not counted as anchor facts — the test pins
that — but a zero-hit answer now reports how many lines matched *inside* a fence.

**The repetition criteria fired on ordinary short sentences.** `SHORT_LINE` was 6,
so four steps of unrelated five-character sentences ('先读文件。' '再看测试。') all
counted as filler and the turn was called degenerate — with no line repeating
even once. Tightened to 4 (degenerate lines are two characters), raised the
fragment row cap from 3 to 6 so the canonical `好。做。好。做。` block is counted at
all, and kept repetition as an independent third signal. A real degraded session
(`好。` × 4268) is still detected.

**The diagnostic file wrote absolute paths to disk.** Records were serialized
verbatim, so `driftDetail` carried the user's full workspace path into a file
meant to hold booleans and counters. Absolute paths now collapse to their last two
segments — stage and file name survive, the workspace root does not.

**Three probes could report success without checking anything.**
`thinking-loops` skipped its only target when the session being appended to had a
half-written zstd frame, then printed a clean result and exited 0.
`render-smoke` decided "invoked directly" by comparing `argv[1]` to a realpath'd
`import.meta.url`, so reaching the repository through a junction made it run
nothing and exit 0. `Pack.ps1` ignored `DSH_NODE_EXECUTABLE` and demanded an
explicit `-NpmPath` in exactly the managed install where node is not on PATH.

Also fixed: `status` called `precise.result.shadowedSeqs` unguarded on the success
path (recording a completed compaction as a failure when the engine resolves
without a result); `status` picked `verdicts[0]` as "worst turn" without sorting,
contradicting `describeRepeatRisk` on the same data; `status` called
`commands.find` outside a try/catch, losing every diagnostic it had already
computed; `compact` called `manualCompacting.add(undefined)` in a `WeakSet` when
the call carried no session; a `scaffold` topic over 200 characters reached
`rename` and surfaced a bare `ENOENT` with an internal temp path.

### Fixed — the rest of the audit findings

The eight items left open by the first batch, plus a full pass over every `catch`
block.

- **`cleanup` treated "cannot read" as "not there".** A stage directory whose
  `lstat` failed with `EACCES`/`EPERM` was dropped without setting
  `scanTruncated`, so the report could still print the absolute conclusion
  "no stage directories with `parent-backup` found". Same for an unreadable
  `detail/`. Both now distinguish `ENOENT` (normal) from "cannot see it"
  (truncated), matching what the same function already did for budget cuts.
- **`anchor-261116-145800.md` could never be cleaned up.** `rankOf` rejected every
  12-digit timestamp as ambiguous — correct for the unseparated form, but
  `YYMMDD-HHMMSS` with a hyphen has exactly one reading, and the close-out
  reminder itself tells the model to archive old anchors as
  `parent-backup/anchor-<timestamp>.md` with whatever format it likes. Those
  backups sat in `unknown` forever while the report claimed the names could not
  be ordered.
- **`usage` marked exact numbers as a lower bound.** A subdirectory or workspace
  directory deleted between the `readdir` snapshot and its own `opendir`
  truncated the whole measurement. The same file already exempted files for
  exactly this reason.
- **Boolean rows had no reset button.** The "customized" badge and the "N
  customized" counter both count boolean keys, but only non-boolean fields had
  any way to clear the override — so the count never went down and Copy YAML kept
  a stale override forever.
- **Token fields blamed the format for an out-of-range value.** `1000000001` and
  `2000000k` are well-formed; they only exceed the cap. The real bound now
  appears in the message (and in the English one).
- **`validate` read the scaffold skeleton as evidence.** Checks 7 and the
  `[人工明确]` count matched the whole document, so the skeleton's own
  explanatory lines counted. An untouched anchor reported "no `[推断未验证]`
  marker at all" and "`[推断未验证]` not stale" in the same output, plus
  "✓ 1 `[人工明确]`" for an empty file. Both now require a list row, as check 3
  already did.
- **A pure code quotation could trigger the repetition alarm.** `isCodeish` is a
  per-line regex with no state, so fenced lines carrying no ASCII punctuation
  (`return value`, `pass`, `git status`, eight `TODO`s) fed the counters.
  `proseRows` now tracks the fence and skips its body.
- **`anchorTimeZone`: the schema was stricter than the resolver.** An exhaustive
  comparison over 4,567 samples found 203 values the resolver accepted and the
  schema rejected — three-digit minutes below 100 (`+053` is unambiguously 53
  minutes) and any leading/trailing whitespace (the resolver trims first).
  Widened the schema; both directions are now zero.
- **All 136 `catch` blocks were reviewed** for empty handlers. Nine are
  deliberate and documented (fallbacks, cleanup retries, a logger that may itself
  throw); one was a real `ENOENT`/`EACCES` conflation in `cleanup` (fixed above).

### Added — compaction boundary

- `status` (both the tool and `/anchor status`) now reports how many times the
  session has been compacted successfully, and from the second compaction on warns
  that the summary has already been rewritten over a previous summary. The host
  keeps no structural protection against summary-of-summary: the checkpoint lands
  at surface index 1 and the next range selection starts there too, so the old
  summary is always condensed again; the only guard is the summarizer instruction's
  "drop stale ones", which permits losing information. A failed compaction is not
  counted. The close-out reminder carries the same warning once the count reaches
  two, placed before the "one-time reminder" line so it is read first.

- `notifyAfterCompaction` (default `true`): the first `pre-step` after a
  **successful** `compaction/end` injects one notice telling the model to read the
  current stage's `anchor.md` and detail document before continuing, and to confirm
  that a summarised `Next Step` was not already completed. The notice is
  independent of `notifyTokens`, does not consume the reminder quota, fires at most
  once per compaction, and is skipped entirely when `compaction/end` carries an
  `error`. It addresses the loop documented in
  an internal measurement note: the summarizer never sees the
  verbatim tail it keeps, so its `Current Work` / `Next Step` can describe work the
  retained history already finished — measured on a real session as a 16,269-token
  output of repeated "do it" with no tool call. A non-`enter` decision leaves the
  flag set so the notice lands on the next entering step instead of being dropped.

Two read-only bug-hunt rounds (35 tracked items) were fixed in place. No behaviour
was removed; the notable semantic changes are marked below.

### Changed — defaults now follow the measurements

- `notifyTokens` default moved from `400000` (40% of a 1M window) to `360000` (36%).
  The old line assumed a 541,248 trigger, which only holds if the request reserves
  393,216 output tokens. The effective request sends `maxTokens: 256000`, so the
  harness trigger is `min(1M × 0.8, 1M − 256k − 65.5k) = 678,464` (67.8%) and the old
  line left 278,000 unused tokens of buffer between the reminder and the compaction.
- `compactRetainTokens` default moved from `97085` to `32000`. 97,085 was
  `0.16 × 606,784` under that same outdated reservation; the automatic path actually
  keeps 119,040, so the "matches automatic compaction" claim was never true. Both
  figures are heuristic prices and Chinese text runs at 1.5–1.8 characters per token,
  so a nominal 97,085 retained roughly 160,000 real tokens — measured on
  `session-ccc00003` as a 179,155-token post-compaction context whose retained tail
  was 53% raw tool output, followed two turns later by a 16,269-token loop. A manual
  `/compact`, which keeps nothing verbatim, landed at 24,376 and recovered.
- The settings-panel presets now scale from the same 1M baseline (36% reminder,
  3.2% tail) instead of restoring `400000` / `97085`: 256k → `92000` / `8000`,
  512k → `184000` / `16000`, 1M → `360000` / `32000`. Before this change, clicking
  "1M 大窗" silently undid the tuning. `anchorLimitChars` deliberately does not
  scale — it is a document-length limit, not a token budget.

### Fixed — reminder and compaction

- A configuration value that the Host schema accepts but the resolver rejects no
  longer prevents the plugin from mounting: `apply()` falls back to defaults, logs
  a warning, and `status` reports the degraded state.
- `/anchor threshold` clears the session's reminder throttle, so lowering the
  threshold below the current usage reminds immediately instead of waiting for
  another 25k of growth.
- An automatic-compaction `skipped` outcome (backoff or in flight) is explained
  once per reason and no longer **swallows the close-out reminder**; the reason
  record is cleared by a successful compaction, `/anchor reset`, and
  `/anchor threshold`.
- A turn-stopping failure notice is no longer dropped by an early abort return.

### Fixed — anchors and guard

- `guard` refuses to write a `.anchor-guard.json` above `guardMaxBytes` instead of
  writing a baseline the safe reader then rejects (the old self-lock).
- `.anchor-guard.json` reads in `validate` and the per-turn drift check use the same
  `guardMaxBytes`; the 1 MiB safe-read constant now has one definition.
- `cleanup` no longer prints an absolute "no backups" verdict after a truncated
  scan, and names the layer that truncated (root, stage, or `detail/`).
- `cleanup` orders backups by a parsed date instead of `localeCompare`, so mixed
  naming styles cannot present a newer backup as a deletion candidate. Names whose
  date does not exist on the calendar (Feb 31, Feb 29 outside a leap year) and
  12-digit names (no unique reading) fall into `unknown` instead of being sorted
  by a shifted guess.
- `anchorTimeZone`'s schema pattern accepts exactly the values `normalizeTimeZone`
  accepts; a three-digit offset such as `-745` used to pass the schema and then
  throw during mount.
- `anchorTimeZone` in the panel now renders with the same height, border, focus
  ring and disabled state as the other inputs.
- `recall` truncates long hits by code point and reports the original length.
- `describeSeqRange` prints `?` for non-integer bounds instead of `NaN..5`.
- `readAnchorFile` rejects a file whose inode/device changed between `lstat` and
  `open`, closing the replacement window.
- Scaffold rejects a target under a Windows system directory when that directory
  cannot be resolved (fail-closed).
- Stage discovery failures now name the source layer, and a stale reservation is
  reclaimed after `staleReservationTtlMs` even if its PID was reused.
- `realpath` comparison helper only treats `..` and `..\` as escaping; `..foo` is a
  legal child name again.

### Fixed — status, diagnostics, docs

- `status` no longer reports a transient diagnostic write failure forever: the
  writer clears it on the next successful write and keeps degraded writes in a
  separate `notice()`, so "latest pre-step" always stays visible.
- A predicate that throws inside `readLatest` now surfaces instead of being
  swallowed as a torn JSON line and reported as "the hook was never called".
- The diagnostic writer compares inode/device between `lstat` and the opened
  handle on both write and read, closing the last replacement window; degraded
  writes carry a timestamp so "latest notice" cannot pose as a fresh event days
  later.
- A file that a concurrent rotation removed mid-scan no longer marks the whole
  usage report truncated: `ENOENT` skips that file and the counts stay exact.
- `dshHome` must be an absolute path; a relative value (or `~`) would be resolved
  against the current project and silently point at the wrong directory.
- Non-integer input for `guardMaxBytes` / `staleReservationTtlMs` reports the real
  range instead of the global `1..1,000,000,000`; their schemas also reject
  fractions, so the panel, the parser and the Host schema agree.
- `/anchor status` distinguishes "no session" from "cannot measure".
- `/anchor` verbs are case-insensitive and extra arguments are rejected instead of
  silently ignored.
- `usage` (tool and HTTP route) reports a moved/deleted workspace instead of
  claiming the anchor directory simply does not exist yet.
- The settings panel refreshes the usage summary when `anchorRoot`/`dshHome`
  change, reads the error body on non-2xx responses, counts only fields that
  actually have a row, shows the truncation `reason`, normalises `+8`-style time
  zones, validates the declared `max`, aborts superseded usage requests, and no
  longer leaves "copying" stuck after a synchronous clipboard error. It also
  distinguishes "DSH_HOME not configured" from "sessions directory missing",
  validates `anchorRoot` for control characters like the Host schema does, and
  no longer claims "the numbers below are a lower bound" when a row shows none.
  With `enabled: false` it now says the entry is not mounted instead of "live",
  reports why the usage route answers 404, shares the workspace cap with the Host
  instead of hard-coding 8, formats token counts and time-zone defaults the same
  way everywhere, and logs a namespace read failure instead of blaming the Host.

### Added

- The settings panel follows the DSH interface language. Field labels, hints,
  group titles, tab names, buttons, status messages, validation errors and the
  usage card are all bilingual: each field carries `labelEn`/`hintEn` next to its
  Chinese source, and free-standing copy goes through an English table keyed by
  the Chinese original. The panel reads `ctx.locale` when the Host provides it
  (falling back to `navigator.language`) and re-renders when the language changes.
  A regression test fails if a field grows Chinese text without the matching
  English.
- A manifest icon (`assets/icon.svg`, declared as `package.json.icon`) so the plugin
  list shows the anchor mark instead of the host's generic placeholder.
- `locale/en.json` and `locale/zh.json` provide a localized title and description;
  the plugin list now follows the DSH interface language instead of showing the
  English `package.json` description.
- `guardMaxBytes` (default 1 MiB, 64 KiB–16 MiB) bounds the guard baseline on both
  write and read.
- `staleReservationTtlMs` (default 1 day, 1 minute–7 days) controls when a scaffold
  reservation sidecar is considered abandoned. The ceiling stays under the global
  `1,000,000,000` numeric bound so the schema and the parser accept one set.

### Changed — the diagnostic writer separates transient failures from degradation

- `prestep-log` separates `error()` (transient write failure, cleared on success)
  from `notice()` (degraded write: bounded summary or reset).

### Added — probing tools

- `tools/Probe.ps1` runs three diagnostic probes for the failures that no static
  check can see. `locale` extracts every Chinese `t()`/`tf()` literal from the
  panel and requires a matching English entry (and no dead entries). `boot`
  executes the real client factory in a minimal stub, which catches module-scope
  `ReferenceError`s that would otherwise blank the settings page silently.
  `thinking` scans session logs for reasoning that degenerated into
  `好。做。好。做。` repetition.
- The repetition criteria (`tools/probes/lib/repeat-analysis.mjs`) are pure
  functions with offline tests. They exclude code lines — an early version
  flagged a normal refactor because ` ``` ` appears constantly in code-writing
  thoughts — and require two independent signals before calling a turn
  suspicious. Verified against a real degenerate session (one turn had `好。`
  6,670 times across 98% of its non-code lines) and against a clean 543k-character
  session (zero findings).
- `render` probe (also a unit test): renders the panel in a chosen language and
  collects every text node, so "English mode still shows Chinese" is caught
  mechanically instead of by reading the translation table. Text-node collection
  requires calling function components by hand — `createElement` alone produces a
  tree of element objects and reports zero text (which a first version did,
  cheerfully declaring the panel clean).

### Added — thinking repetition scan

- The `compact` action now snapshots the session's reasoning shape before it
  compacts, and reports whether the model was already looping. Compaction is the
  last moment this is observable: afterwards those reasoning blocks are replaced
  by a summary.
- `status` gained a `思考复读:` line with the same verdict.
- The event ring stores only a shape per assistant message (`chars`, `rows`,
  `fillers`, `maxRepeat`, `repeatRatio`, `tiny`) — never the reasoning text,
  preserving the existing rule that the ring keeps no second copy of assistant
  content. Thresholds live in `lib/repeat-scan.js`, shared by the ring scan and
  the offline session-log probe so both judge identically.

### Fixed — release tooling

- `tools/Pack.ps1` failed on managed Node installs. `npm` writes progress and its
  `npm notice` lines to stderr, and the script's `$ErrorActionPreference = 'Stop'`
  turned the first notice into a terminating `NativeCommandError` even though npm
  exited successfully; it also assumed `node` was on `PATH` even when `-NpmPath`
  pointed at an explicit `npm-cli.js`. The script now disables the native-command
  stderr conversion, judges success by exit code, and resolves `node.exe` from the
  npm CLI location (`<runtime>\node-vX\node_modules\npm\bin\npm-cli.js` →
  `<runtime>\node-vX\node.exe`). Verified end to end: `exit=0`, 25 files,
  `sha256 94CC2514…`.

### Fixed — settings panel

- The three tab buttons rendered their Chinese labels in English mode: the code
  passed `entry.label` instead of `pick(entry.label, entry.labelEn)`. Found by a new
  render probe that executes the real panel and collects every text node, which is
  the only way to see "the table has English but the code never asked for it".
- The settings-section label was hard-coded to `Stage Handoff`, so a Chinese
  interface showed one English row pointing at an otherwise Chinese panel. It now
  resolves through the active locale like every other string.
- The settings navigation row showed the Host's default glyph. The plugin now
  registers `settings.section.icon` with the same anchor mark used for the package
  icon, drawn in `currentColor` so it follows the active theme.
- The panel rendered in English while the DSH interface was Chinese. The client
  decides its language from `ctx.locale`, but a cordis service is only readable
  that way when it is declared in `inject`; without the declaration the read
  silently produced nothing and the panel fell back to `navigator.language`
  (an English browser). `locale` is now a declared dependency — it is also listed
  in `dsh.client.inject`, so the Host loads the locale client plugin first — the
  read goes through the reflect interface `ctx.get('locale')`, and the advanced
  section shows a diagnostic line naming the active language and where it came
  from. Verified against a real cordis fiber: `ctx.get('locale')` returns the
  service from a plugin that does not declare it in `inject`.
- The panel's module factory threw `ReferenceError: ctx is not defined` and the
  settings page rendered nothing. The localized copy read `ctx?.locale` at module
  scope, but a client factory only receives `require`; `ctx` arrives later in
  `apply`. The lookup now happens in `apply`, and a regression test actually
  executes the factory in a minimal stub — the kind of failure neither `tsc` nor
  `node --check` can see.
- Four translation keys never matched their English: the code passed
  `' 保存中'` (leading space, part of the copy) while the table carried
  `'保存中'`, so English mode still showed Chinese for the saving indicator, the
  default-value suffix, and the customized-count pill. Keys now include the
  leading space, and a regression test extracts every Chinese `t()`/`tf()` literal
  and requires a matching entry (and no dead entries).

## [1.0.0-alpha] — 2026-11-18

First pre-release. It is published as a GitHub pre-release, not a stable release,
because several paths have not been exercised against a live model yet. It *has*
been run against a live harness: the settings panel, `stage_handoff(action="status")`,
the `/anchor` slash command, and one real precise compaction. A separate online
acceptance run drove `scaffold`, `validate`, `guard` and `recall` end to end and
found the three issues fixed below.

- **`recall` now matches heading lines.** Searching `下一步` skipped the `## 下一步`
  heading itself and returned only body lines, and nothing marked which hits were
  headings, so the most obvious hit was invisible. Heading hits are returned now and
  labelled `（章节标题）`.
- **Tool `status` prints the anchor directory and the reminder quota**, matching
  `/anchor status`. Previously only the slash command exposed them, so a user could
  not tell where anchors land or whether a reminder had already fired.
- **`guard` tamper text reports both directions.** Rewording one constraint used to
  read “baseline 4, current 4, missing 1 time”, which sounds like nothing is wrong;
  it now states how many baseline lines disappeared *and* which new lines appeared.
- **A stale session working directory now says so.** A relative `anchorRoot` resolves
  against the session's recorded cwd; after a project is moved or renamed, `scaffold`
  used to fail with a bare `ENOENT: realpath 'D:\old\path'`. Anchor-dependent actions
  now report 「会话工作目录 … 不存在（项目可能被移动、改名或删除）」 and point at the
  two ways out (absolute `anchorRoot`, or a new session). `status` / `summary` keep
  working because they do not touch the anchor directory.
- **`compact` explains a retained count above the budget.** Retention snaps to
  surface-node boundaries, so a 5,000 budget can land at 14,084; the reply now says
  the count is rounded up to a node boundary instead of looking like the override was
  ignored.
- **`cleanup` names the actual reason first.** An empty `detail/` is the common
  trigger, yet the review list said 「缺少 anchor.md/detail/详细文件」; it now reads
  「detail/ 为空、缺 anchor.md 或缺详细文件、或目录不可读」.
- **`summary` and `reconcile` now read the session log when the ring is empty.** The
  event ring starts at the current mount, so after a restart the previous compaction is
  invisible — and the summary event is log-only, so it is *still there*, just not in
  memory. Both actions now decompress `session*.jsonl.zstd` (measured: 94-105 ms for a
  4.8 MiB / 12.9 MB / 5,528-line log), scan for the last `compaction/summary`, and report
  it with the source file named. `reconcile` also picks up `shadowedRange` /
  `shadowedTokenCount` from the log, so it keeps its "what was discarded" half.
  The fallback is gated on *coverage being incomplete or the read erroring* — when the
  ring covers the whole log, "no summary" is a fact and searching the disk would only
  disprove it twice. Reads are bounded (64 MiB, checked while reading rather than after)
  and a hostile session ID is refused before it reaches `join()`. Note the earlier entry
  below, which said the message merely *pointed* at the log; that was half a fix.
- **`summary` says where a historical summary went.** The event ring starts at the
  current mount, so after a restart the previous compaction is invisible. The miss
  message now states that the summary is a log-only event still present in the
  session log, and scopes the claim to `summary` alone — `usage` and `find-session` do
  read session metadata, so the plugin never claimed to be blind to session storage
  as a whole.

Known limits:

- No live model has driven `guard`, `scaffold`, `recall` or `validate` end to end;
  those paths are covered by offline tests only.
- macOS is untested. CI covers Ubuntu and Windows on Node 22 and 24.

The settings panel lists every whole-hour UTC offset plus the current IANA minute
offsets — `−09:30` (Marquesas), `−03:30` (Newfoundland), `+03:30` (Iran), `+04:30`
(Afghanistan), `+05:30` (India), `+05:45` (Nepal), `+06:30` (Myanmar / Cocos),
`+08:45` (Eucla), `+09:30` (Central Australia), `+10:30` (Lord Howe), `+12:45` and
`+13:45` (Chatham) — so a real minute offset no longer needs a YAML edit.

Everything below accumulated while the version was still `0.1.0-local.N`. The
behaviour is unchanged by this release; only the version and packaging metadata moved.

### Release-candidate hardening — 2026-11-18

- **Human-unit token strings now share the numeric ceiling.** `notifyTokens`,
  `notifyRepeatDelta` and `compactRetainTokens` accept `k` / `m` strings only when
  the resolved value is a safe integer in `1..1,000,000,000`. The Host schema, YAML
  resolver and settings panel apply the same rule, so a value such as `954m`
  cannot pass validation and then fail during mount. The settings duration fields
  apply the same ceiling after unit conversion.
- **Stage discovery is bounded on total entries and wall clock.** Every
  `anchorRoot` enumeration now counts ordinary files as well as matching stage
  names, stops at 2,000 entries or 3,000 ms, and treats a truncated result as
  incomplete. Callers that need a latest stage refuse to guess from a partial
  listing; an explicit `stage` argument skips enumeration entirely.
- **Anchor and diagnostic reads cap consumption before allocation can grow.**
  `anchor.md` and opt-in diagnostic files are checked through `lstat`/the opened
  handle, then read through one helper that consumes at most `maxBytes + 1`.
  Existing links and over-limit files fail before their contents are loaded.
- **Summary extraction is bounded before joining.** The event projection accepts
  at most 4,096 summary blocks and 64 KiB of text, marks either limit as truncated,
  and avoids flattening an adversarially large block array.
- **Release packaging checks the exact artifact.** `Pack.ps1` no longer substitutes
  an older tarball when the versioned name is missing, and `Test-Package.ps1`
  compares the final file set against the exact 22-file release manifest.
- The offline suite now contains 229 tests; the current Windows/Node 24 run passes
  225 with four platform-specific skips and zero failures.

### G2 live-host diagnostics — 2026-11-18

- **G2 uses the pre-step payload as its turn boundary.** `turn` plus
  `step === 1` now decides when the per-turn anchor check runs. The previous
  implementation depended solely on `agents.turnBoundaryOf(session).openTurnStartSeq`;
  if that registry was unavailable in the mounted instance, G2 silently
  returned `no-turn-start`. The registry remains only as a fallback for callers
  that omit the payload fields.
- **Pre-step diagnostics are file-backed and bounded.** Setting
  `DSH_STAGE_HANDOFF_PRESTEP_LOG` to an absolute path (or `1` to use
  `DSH_HOME/.stage-handoff-prestep.jsonl`) records hook shape, decision,
  turn/step, session identity reference, and the exact G2 outcome. The file is
  capped at 256 KiB and rotates to `.1`. Records never include message bodies,
  credentials, or tokens.
- **`status` reads the same file instead of closure-only probe state.** It shows
  the runtime marker, PID, plugin instance, latest own-instance pre-step, and a
  different in-process instance when one exists. This distinguishes “hook not
  called” from “tool and hook are different plugin instances”.

### G2 follow-up and cross-platform scaffold repair — 2026-11-18

- **G2 no longer suppresses the normal close-out reminder.** The drift notice and
  threshold reminder are independent, so both are appended when both apply in the
  same first pre-step. Previously G2 returned immediately and the default
  turn-start-only gate delayed the close-out warning until another user turn.
- **The diagnostic file now has a real hard bound under adverse input.** An
  oversized single record is replaced by a bounded shape-only summary;
  unserializable payloads cannot throw into `agent/pre-step`; in-process plugin
  instances share one write queue; and `status` searches the rotated `.1` file.
- **Diagnostics fail closed around links and arbitrary error text.** Symlinks and
  hard links are rejected for both read and write. Thrown errors retain only
  error name/code plus `[REDACTED]`, while free-text drift detail is redacted and
  length-bounded before it reaches disk.
- **Malformed v3 guard baselines are classified, not turned into fake drift.** The
  same structural validator now guards both `validate` and automatic G2, so a
  corrupt `constraints` value cannot be iterated as characters or explode into
  hundreds of invented missing entries.
- **Scaffold no longer relies on Windows rename semantics for no-overwrite.** POSIX
  `rename()` may atomically replace an existing empty directory, so Ubuntu could
  silently replace a same-name empty stage. On POSIX the plugin now atomically
  reserves the final name with `mkdir()` and replaces only that reservation;
  Windows keeps its native no-replace rename. The regression also checks that a
  pre-existing empty directory remains empty.

### Audit hardening — 2026-11-18

- **Numeric config rejects unsafe or oversized integers.** `notifyTokens`,
  `notifyRepeatDelta`, `compactRetainTokens`, both cooldowns, `keepAnchorBackups` and
  `anchorLimitChars` now require `Number.isSafeInteger` with a 1..1e9 bound in the
  schema *and* the parser, so `2**53` can no longer turn the reminder line into a
  permanent no-op. The settings panel applies the same bound.
- **Stage-directory scans are bounded.** Every `anchorRoot` enumeration counts all
  entries, not only matching stage names. The final entry/time limits and
  incomplete-scan policy are recorded in the release-candidate entry above and in
  `SECURITY.md`.
- **Read-side link rejection is handle-based.** `readAnchorFile` and the diagnostic
  reader open the file first and `fstat` the open handle instead of trusting a
  check-then-read pair. `SECURITY.md` now states the remaining `open` window as
  best-effort rather than claiming atomic rejection.
- `tools/Test-Package.ps1` now fails on any missing or extra file in the artifact,
  including stray files below `lib/` or `docs/`.
- The hard-link test uses `t.skip()` when the filesystem cannot create links
  instead of returning early (Node counted that as a pass).

### Packaging privacy — 2026-11-18

- **Stage anchors can no longer be committed or packed.** The default `anchorRoot`
  is `docs/anchors` and the package ships all of `docs`, so a release built from a
  workspace that had actually run the plugin would have included `anchor.md` files
  carrying absolute host paths and session ids. `package.json` now excludes the
  directory with `files: ["!docs/anchors"]`, `.gitignore` ignores it, and
  `tools/Test-Package.ps1` fails the artifact if it ever shows up.
- `tools/Test-Package.ps1` treats a `!pattern` entry in `files` as an exclusion
  instead of reporting it as a missing declared path.
- **Selecting the current value in the time-zone dropdown is a no-op.** A YAML offset
  outside the option list appears as `当前值`; picking it used to re-parse the
  fallback string and could report an error for a value that was already valid.

### Row alignment — 2026-11-18

- **Settings rows center their controls vertically.** `[data-stage-handoff-row]` used
  `align-items:start`, so every input, unit dropdown, switch and reset button hugged
  the top of the row while the label column (title + hint + default) ran several
  lines — the whole control column read as misaligned. Both columns now center; the
  control line and the duration group keep centering their own children, and a
  regression pins all three rules. Regression:
  `设置面板的行内控件垂直居中，不再贴顶对齐`.

### Time-zone dropdown — 2026-11-18

- **`anchorTimeZone` is chosen from a list in the settings panel, not typed.**
  The dropdown offers `local`, `utc`, every whole-hour offset from UTC−12 to
  UTC+14, and UTC+05:30 / UTC+09:30. Option values use `±H:MM` because a bare
  `-60` (UTC−01:00) would be read back as 「−60 hours」; the selection is still
  stored as minutes, so the Host reads one unambiguous form. A YAML value outside
  the list (for example `+05:45`) appears as `当前值` and is left untouched instead
  of being silently replaced by the first option. The text parsers remain for
  `cordis.patch.yml`. Regression:
  `设置面板的时区下拉：选项覆盖常用偏移，且每个选项都能解析回同一个值`.

### Time-zone and token parsing contracts — 2026-11-18

- **A bare three-digit time-zone value is minutes, not `H:MM`.** `normalizeTimeZone`
  matched `-300` with an hours form that reads `-3` hours plus `:00`, so both the
  YAML value and the settings panel silently resolved to −180 minutes while the
  input box still showed `-300`. One or two digits (`+8`, `-5`) stay hours, `+0530`
  and `+05:30` stay clock offsets, and only a bare three-digit value means minutes
  (`-300`, `-720`). The panel now submits the resolved offset in minutes, so the
  Host cannot reinterpret it, and `docs/CONFIGURATION.md` states the rule.
- **The token schema and `parseTokenCount` accept the same strings.** The schema
  allowed a bare `1.5` that the parser rejected: a value the settings page could
  have normalized would instead stop the plugin from mounting, with no path to see
  why. A decimal fraction now requires `k`/`m`, and a fractional product is rounded
  (`1.3k` is 1331), so "schema accepts" implies "parser normalizes". Regression:
  `token 字符串：Host schema 接受 ⇔ parseTokenCount 能归一（小数必须带 k/m）`.

### Scaffold root kind check — 2026-11-18

- **`scaffold` refuses a non-directory `anchorRoot` with a readable reason.** A
  path occupied by a regular file used to slip past root validation and reach
  `mkdir(root, { recursive: true })` outside the rejection path, surfacing a bare
  `EEXIST` to the model. The nearest existing ancestor must now prove it is a
  directory, so the tool answers with `拒绝创建阶段：… 不是目录 …` and leaves the
  occupying file untouched. Regression:
  `scaffold：anchorRoot 位置被普通文件占住时明确拒绝，不抛裸 EEXIST`.

### Diagnostic write-path link revalidation — 2026-11-18

- **Every diagnostic append re-validates its target, not just the first one.**
  `createBoundedJsonlWriter` used to call the link/kind check only while its byte
  baseline was still unknown, so a diagnostics file replaced with a hard link (or
  symlink) after the first successful write received every later record at the
  linked target. The writer now re-checks on each append, opens the file once, and
  re-verifies kind and link count through the handle it writes with; the opened
  file's real size also replaces the cached byte count, so an externally truncated
  or rotated file can no longer skew rotation. Regression:
  `pre-step 文件诊断在首次写入之后被换成硬链接也必须拒绝`.

### Reservation recovery and canonical v3 tags — 2026-11-18

- **A stale POSIX scaffold reservation is recoverable without weakening
  no-overwrite.** The mkdir-to-rename window now has an ownership sidecar with
  schema, stage name, PID, random token and timestamp. A later invocation removes
  only a dead process's empty reservation; an active PID, malformed sidecar or
  non-empty stage is preserved and reported.
- **v3 guard tags are now strict and canonical.** `validate` and automatic G2
  share validation of source/status tag vocabularies, so arbitrary tag strings
  cannot be treated as a trustworthy baseline. `ANCHOR-POLICY.md` now uses the
  machine-readable Chinese headings and tags that the implementation actually
  recognizes, with English glosses only.

### Fourth-audit follow-up fixes — 2026-11-18

- **Compaction has one explicit outcome vocabulary.** `success`, `no-op`,
  `skipped`, `cancelled`, and `failed` are now distinct. “No compactable range”
  is a successful no-op instead of a failure that enters exponential backoff;
  only `failed` writes failure state. A transaction that completes immediately
  before turn cancellation is recorded as successful, because the summary has
  already been persisted.
- **Manual compaction forwards `exec.signal`.** The engine receives
  `AbortSignal.any([exec.signal, timeout])`, and the signal is checked again
  immediately before the engine call and in the rejection path.
- **The event ring now reports coverage.** Each session records `mountSeq`,
  `firstRetainedSeq`, `lastObservedSeq`, and permanent count/byte truncation
  flags. Summary, tool-fact, and status readers use `complete`,
  `partial-since-mount`, `partial-truncated`, `empty`, or `unavailable`; a late
  mount can no longer be described as the complete log.
- **The event ring has a total per-session byte budget.** It is capped at 2 MiB,
  summary text is capped at 64 KiB, and a truncated summary is explicitly marked
  as partial. `reportToolFacts` controls display only; the ring still observes
  events for pending-tool checks, summaries, and coverage.
- **All anchor content reads share one safe layer.** `recall`, `reconcile`,
  `validate`, `guard`, and scaffold's previous-anchor archive reject linked
  roots/stages/files, non-regular files, extra hard links, paths that resolve
  outside the root, and files over 1 MiB.
- **`guard` baselines are version 3 multisets.** Entries store canonical text,
  source tags, and status tags separately. Removing one duplicate occurrence or
  changing a source/status tag is now visible instead of being collapsed by set
  membership.
- **Markdown fence handling is shared.** A single anchor-document view removes
  fenced examples before `validate` regexes, section checks, guard signatures,
  reconcile matching, and recall scanning.
- **Numeric `defer` fails closed when the context window is unknown.** It reports
  `bounded=false` and directs an explicit `tokens="off"` request instead of
  accepting a number that could silently disable reminders.
- **Reconcile distinguishes exact from prefix matching.** Results carry
  `matchKind=exact | prefix16 | none`; only a complete normalised line is called
  verbatim, while a 16-character hit is labelled as a prefix only.
- **Settings writes use a `Map<key, token>`.** Concurrent field writes remain
  independently visible, and an older write cannot clear a newer write's pending
  state for the same key.
- **`find-session` reports incomplete scans.** Only `ENOENT` means “not found”;
  permission and other path errors are surfaced and prevent a false definitive
  miss.
- **Success cooldown follows the current configuration.** The plugin stores the
  success timestamp and computes the deadline from the live
  `compactCooldownMs`, so hot-changing it to `0` takes effect immediately.
- **Hot disable also stops `session/event` ring updates.** Existing cached data is
  retained, but a disabled plugin no longer grows the observation cache.
- **`/anchor status` measures current usage directly.** It no longer reports the
  last pre-step snapshot, which could be stale after compaction or a long turn.

### Third review fixes — 2026-11-17

- **`reset` is now a tool action, so an agent can undo its own `defer`.**
  `/anchor reset` is a UI slash command and an agent cannot issue one, so
  `defer tokens="off"` used to be a switch the agent could flip but never flip
  back. `stage_handoff(action="reset")` clears the reminder quota and any `defer`
  registration — both `raise` and `off` — and reports the pre-clear state rather
  than asserting success unconditionally.
- **Automatic compaction now runs at the Host's serial `agent/turn-stopping`
  boundary.** `compaction-basic.compactRegion()` requires an open current turn;
  calling it from `agent/status === idle` always failed. The idle handler now
  executes only explicitly queued `/compact` work, while pre-step keeps the
  high-water fallback for long turns.
- **Late threshold crossings are not compacted before their reminder.** Automatic
  turn-stopping compaction waits until a close-out reminder has actually been
  constructed for the session. Cancellation of a turn during compaction is
  treated as a skip, not a failure/backoff.
- **Automatic-engine failures are visible even when reminder throttling is active.**
  A turn-stopping failure is carried across the start of the next pre-step as a
  failure-only notice; it does not consume the reminder quota. Failure fingerprints
  are committed only after message construction succeeds.
- **`defer` now reports whether it is actually in force.** A defer set below the
  configured line remains registered for a later crossing, `off` survives low
  water until `/anchor reset`, and status distinguishes “registered but not yet
  active” from “raised and active.” A later settings change cannot make an old
  defer lower the effective threshold.
- **Read-only status no longer conflates projection and memory-ring availability.**
  A projection failure fails compaction closed; a missing recent-event ring only
  marks summary/tool evidence unavailable. Engine diagnostics also report whether
  `/compact` fallback is actually available.
- **Engine fallback and failure classes are separated.** A surface race retries the
  same retention-preserving engine and never silently switches to the zero-retention
  `/compact` path. Only a missing/incompatible engine is eligible for that fallback.
- **Projection state is validated as evidence, not just as an array.** Every surface
  node must have a safe seq and non-empty type; unrelated events return the same
  state reference, as required by the pure-fold contract.
- **`tools` is an optional child injection instead of a top-level hard dependency.**
  Deployments without the tool service still mount the reminder path.
- **`recall` skips fenced examples, tool facts are normalized before rendering, and
  `anchorRoot` rejects control characters.** This prevents examples or injected
  whitespace from being mistaken for real anchor content.

### Remaining review fixes — 2026-11-17

- **Automatic compaction now finishes before `pre-step` returns.** The old
  fire-and-forget call let the current turn append surface nodes while the host
  summarized, producing `surface changed during summarization`. The awaited
  stable cut removes that race. `lastNotified` is written only after a successful
  compaction; failures are appended to the model-visible reminder and do not
  consume the reminder quota. A host-reported whole-surface race is retryable at
  the next `pre-step` without failure backoff.
- **Deprecated synchronous Session history reads are gone.** Surface
  `seq`/type/checkpoint structure comes from a host-only `sessionProjections`
  unit. Tool facts and summary text come from a bounded in-memory
  `session/event` ring, so content-derived values do not enter the checkpoint.
  Missing, throwing, malformed or mismatched projection evidence makes
  compaction fail closed instead of treating an unknown head as index zero.
- **Settings writes return their outcome.** `false`, non-boolean, and rejected
  writes restore the current snapshot draft and show a field-level error. A
  concurrent-write `finally` can no longer clear another field's pending state.
- **Client numeric parsing matches the Host.** Token-like fields use the same
  grammar as `parseTokenCount`; `1.5` is rejected instead of rounded, while
  `1.5k` and `.5k` resolve deterministically. Plain integer fields use a separate
  non-negative integer parser.
- **Projection-adjacent resource bounds were rechecked.** Recent tool facts are
  capped at 128 values per event and 4,096 characters per value. Failure notices
  use a stable key, so changing cooldown seconds cannot turn one failure into a
  stream of repeated reminders.

### Security and correctness hardening — 2026-11-17

Driven by an independent code review that reproduced each item with a probe.

- **`guard` no longer writes through links.** Plain `writeFile` follows symlinks
  and junctions, and on Windows a hard link shares an inode with its target, so
  writing `.anchor-guard.json` could truncate a file outside `anchorRoot` — a
  hard-link probe overwrote a victim file. Writes now go through
  `assertWritableInRoot` (realpath containment plus `lstat` rejection of links
  and any link count above one) and land via temp file + `rename`.
- **`guard` baselines store full text, not 16-character signatures.** Two
  constraints sharing a prefix produced the same signature, so deleting either
  one still reported "matches baseline" — which voided the whole feature.
  Baselines are version 2; version 1 files report that they need re-running
  rather than producing a wall of false deletions.
- **Baseline validation is strict.** A stored side that is not a string array
  is reported as damaged instead of being silently treated as empty. An empty
  array stays valid: constraints-only anchors are normal.
- **`scaffold` validates before it creates.** It used to call `mkdir` first, so
  a junctioned ancestor had already been created outside the workspace by the
  time validation refused. It now walks up to the nearest existing ancestor,
  checks that, and returns the canonical root it then creates.
- **Summary candidates sort by seq.** They were concatenated as "all canonical,
  then all migration-shaped" and scanned backwards, so a stale migration-shaped
  event beat a newer real summary. `summary` and `reconcile` were reading the
  wrong basis.
- **Fenced code blocks are not sections.** An anchor documenting the expected
  format contains an example, and the example's `## Next steps` with a numbered
  list was being read as real content. `sectionLines` now skips fenced regions
  entirely — markers and contents both.
- **`loadBalanceGuard` caches its promise**, not a `null` written before the
  await. A concurrent caller used to see `null` and skip the tool-pairing
  correction.
- **`find-session` has a real scan budget.** 200 was an output cap, not a scan
  cap: every entry still got an `lstat`, and each hit restarted the timer.
- **Tool facts are newest-first.** Walking forward made `slice(0, 5)` pick the
  oldest files in the window.
- **`tokens` accepts `"off"` in the schema**, matching what the implementation
  already did. A strict model would otherwise drop the parameter.
- **`pre-step` can no longer break a turn.** The handler is wrapped: any throw
  logs a warning and returns the decision untouched.

### Tool facts, validate and reconcile — 2026-11-16

- **`status` derives tool facts instead of asking the model.** New
  `collectToolFacts()` walks the newest `tool/call` events, parses their
  `data.arguments` JSON string, and extracts paths (`path` / `file_path` /
  `filePath` / `file` / `target` / `paths` / `files`) and shell commands
  (`command` / `cmd`). `status` reports how many files and commands were touched.
  The rationale is Cline's `extractFileOps`: fields that can be mechanically
  derived from tool calls should not be left to the model to narrate, because the
  model forgets and the code does not. Behind `reportToolFacts`, default on.
- **`action="validate"` checks whether an anchor is actionable.** It reports
  whether `## Next steps` exists, whether its first line carries a path or
  command, how many hard constraints lack a source tag, whether any
  `[inferred, unverified]` marker is present, and how close the file is to
  `anchorLimitChars`. It never writes: the anchor belongs to the agent.
- **`action="reconcile"` sets the compaction summary beside the anchor.** Both
  sides are scanned for absolute paths and 3+ digit numbers, and two difference
  sets are printed. It deliberately does not extract decision sentences — that
  needs semantic judgement, and mechanical extraction of them is mostly noise —
  and it states outright that a missing path is not lost information, because the
  anchor is designed not to copy path lists.
- **`action="recall"` searches the anchor and reports the section.** Each hit
  carries the section heading and line number, because the same fact carries very
  different weight under "hard constraints" than under "decisions and rejected
  options". Exact substring matching; no alias expansion.
- **The anchor scaffold leads with forward instructions.** `## Next steps` and
  `## Facts not to lose` now come before the goal and progress sections, and
  `## Current progress` gained an explicit "blocked" bucket. A handoff is worth
  more as reconstruction conditions than as a state snapshot.
- **The reminder states that it is one-shot.** An injected reminder otherwise
  lingers in context forever; it now says it expires once handled and must not be
  read as a new user instruction.
- **Fixed a real bug the new tests caught:** the section splitter used
  `(?=\Z)`, which does not exist in JavaScript regex — it matches a literal `Z`,
  so the lookahead never fired and whole sections silently read as empty.
  Replaced with a line scan that matches headings by prefix, so
  `## Next steps (ordered)` still counts.

### Follow-up review fixes — 2026-11-16

- **Turn boundaries now use `AgentRegistry.turnBoundaryOf(session)`.** The plugin
  no longer calls the deprecated `session.eventAt()` or scans the full log.
  `openTurnStartSeq === null` means no truncation; a numeric sequence truncates at
  the first later surface node; missing/throwing projection fails closed.
- **Summary readback is windowed.** `action="summary"` reads at most the newest
  2,000 events through `snapshotEvents()`. If that partial window has no summary,
  the response says older history was not scanned instead of claiming the session
  was never compacted.
- **Volatile `enabled:false` now stops every live entry.** The pre-step listener,
  tool execute, `/anchor`, queued-compaction status handling, and usage route all
  gate on the live config. The route returns HTTP 503; a warning says the entry is
  disabled but still mounted until the profile is remounted.
- **SessionId round-trip coverage.** A special-character SessionId is written into
  an escaped Markdown anchor row and then located through the DSH `~XXXX` path
  encoding by `find-session`.
- **Summary misses are diagnosable.** `summary` now recognizes canonical
  `compaction/summary` events plus migration-shaped records carrying
  `data.summary`. A miss reports returned event count, actual seq range,
  summary-candidate counts and top event types; sparse/non-contiguous returned seq
  sequences are handled by matching event objects rather than array positions.

### Review fixes — 2026-11-16

- **Real turn boundaries are now read from the session log.** `turn/start` and
  `turn/end` are log-only events and cannot appear in `session.surface.nodes`;
  the previous surface scan therefore never protected the open turn. Compaction
  now derives the current turn's first surface cut from the log and fails closed
  when the boundary cannot be proved.
- **Summary readback now scans `compaction/summary` in the log.** That event is
  also log-only, so the previous surface scan always returned “no summary”.
- **Host schema, semantic parser, and settings panel now share token/time-zone
  constraints.** Human token strings are accepted consistently, invalid offsets
  such as `+14:01` are rejected, and uppercase UTC/`z` normalize deterministically.
- **The settings-page usage route reports every active workspace.** A settings
  section has no session identity; the plugin no longer guesses from
  `agents.list()[0]` or one process-global `lastWorkspace`.
- **Compaction failures get visible exponential backoff.** The fallback
  `/compact` path now participates in the same per-session gate, and status
  reports the current cooldown or failure reason.
- **Filesystem reads fail visibly and stay bounded.** Usage/session/cleanup scans
  use streaming directory handles, distinguish missing from unreadable roots, mark
  partial results, skip links, and cap cleanup review work and output.
- **`scaffold` is atomic.** It builds a hidden sibling stage and publishes it with
  one rename, preventing a failed write from blocking retries with a half-stage.
- **`find-session` follows DSH's `~XXXX` SessionId encoding.** Arbitrary branded
  session IDs remain path-safe and searchable; Markdown session rows are escaped.
- **Reminder policy no longer overrides approval boundaries.** “Do not stop to
  ask” was replaced with a narrow instruction to perform the documentation work
  while preserving deletion/elevation/deployment/network safety rules.

### Added

- **Stage close-out reminder** injected into the next model request once the
  measured context crosses a configurable threshold (400,000 tokens by default).
  Repeat notifications are throttled by a growth delta, and the throttle resets
  when usage falls back below the threshold.
- **`stage_handoff` tool** with status/summary/usage/cleanup/defer/compact/
  scaffold/find-session actions. It exposes context usage, log-backed summary
  readback, scoped storage accounting, read-only cleanup reports, bounded defer,
  compaction, atomic scaffold, and encoded session lookup.
- **Turn-boundary throttling** (`notifyOnTurnStartOnly`, default `true`): the
  reminder is only considered on the first step of a turn. Reported from real use:
  a 25k-token delta alone let the reminder fire twice within five minutes at 60%
  context.
- **`status` leads with the conclusion.** The engine's reachability is the first
  line; the isolation-probe details are collapsed into a trailing diagnostic
  section that only appears when the engine is actually unreachable. Previously the
  output reported the three failed access paths before reporting the successful
  one, which read as a defect.
- **`/anchor` command** with `status`, `threshold <n>`, and `reset`.
- **Editable settings page section** (`lib/client.js`, client plugin, no build
  step): a **Stage Handoff** panel under the DSH settings page exposes every
  configuration key. Editable values are saved through `ctx.configForms` and apply
  live without a restart; `enabled` is visibly disabled because changing whether
  the host mounts this plugin requires a profile edit and restart. React is taken
  from the host's `window.__ModuleLoader__`, so the plugin still has no build step.
- **`tools\Test-Package.ps1` now verifies the client entry.** It asserts
  `dsh.client.platform === 'web'`, that `exports["./client"]` points at a file that
  exists in the artifact, that the file calls `__ModuleLoader__.load(`, and that the
  registration `id` equals the package name — the three things whose failure only
  shows up in a browser as `loaded without registering "<id>"`.
- **`agentDecidesCompaction`** (default `true`). Set it to `false` and the plugin
  compacts by itself once usage crosses the threshold, inside the current turn,
  instead of waiting for the agent to call `compact`. The reminder is sent either
  way: compaction frees space, it does not produce conclusions. The cooldown applies
  to both paths, so automatic mode cannot compact twice in a row.
- **Fixed: the settings panel could not become editable even after the client API
  was wired correctly.** Schemastery's `.volatile()` fields validate to stable
  `{ get() }` references; the plugin's semantic validator treated those objects as
  ordinary values, so `apply()` threw during startup and `settings.describe()`
  skipped the failed fiber. `resolveConfig()` now unwraps live references, and a
  `loader/volatile-update` listener refreshes the semantic snapshot when the form
  saves without remounting the plugin.
- **Fixed: `stage_handoff` could be present in the global registry but absent from
  the model-facing tool list.** The raw `tools.register()` API takes standard JSON
  Schema, unlike `defineTool()`, which converts an author property-map first. The
  input contract now uses `{ type: "object", properties, required: ["action"] }`;
  `output.schema` remains standard JSON Schema and `execute(args, exec)` is
  unchanged.
- **Settings panel UI rework.** The panel now follows DSH's `--dsw-alias-*`
  light/dark theme tokens, uses a responsive 760px layout, a summary hero with
  current threshold/retention/anchor values, a sticky save-status bar, and three
  keyboard-accessible tabs. Text fields have explicit accessible names, boolean
  controls use a switch role, and errors use alert semantics. The fixed `enabled`
  state is shown as a status pill rather than an ambiguous disabled checkbox.
- **The settings panel is editable, not just a readout.** Each key renders as an
  input; committing calls `configForms.get('stage-handoff').set(key, value)`. Write
  capability and field values come from the host snapshot. The panel reacts when
  the namespace arrives after first render, keeps a clear focus treatment on input
  fields, and shows `enabled` as a distinct fixed field with the reason. The
  schema now carries the same numeric and path constraints used by `resolveConfig`,
  so invalid values are rejected at the host boundary instead of being stored and
  ignored by the running plugin.
- **Settings usability additions.** Fields track whether they are customized and
  offer a one-click reset to inherited/default values. Three presets cover
  128k/200k/1M windows with one atomic `configForms.mutate`; the 1M preset unsets
  its three sizing fields instead of writing an explicit default row. The current
  full Stage Handoff config can be copied as YAML, and every save/reset/copy action
  reports through the sticky status bar.
- **Removed leftover startup diagnostics.** `apply()` used to `console.error` several
  `inject callback FIRED`, `tool REGISTERED` and `queued compaction settled` lines —
  debugging residue that fired on every start and duplicated the `ctx.logger` calls
  already next to them. The genuine degradations (balance-guard unavailable, compaction
  dropped, registration failed) still report through `ctx.logger`.
- **`stage_handoff(action="usage", scope=…)`** now covers both storage locations the
  plugin cares about: `"anchors"` (default) walks the anchor directory, `"sessions"`
  sums each session's on-disk files under `<dshHome>/sessions/`, and `"all"` does
  both. Session sizes come from file metadata only — contents are never read.
- **`dshHome`** configuration locates the DSH data root for session sizes. Empty
  (default) means read `DSH_HOME`; if neither is set the scope says so instead of
  guessing.
- **`notifyCooldownMs`** (default `300000` — 5 minutes). The reminder now needs both
  enough growth **and** enough elapsed time. Reported from real use: `notifyRepeatDelta`
  alone is a volume gate, and a busy stretch can cross 25k in a couple of minutes — two
  reminders arrived within five minutes of each other. Set `0` to disable the time gate
  and go back to growth-only.
- **`stage_handoff(action="defer", tokens=…)`** lets the working agent raise its own
  reminder threshold for the session, so a load-bearing piece of work can be finished
  before handing off. The reply states the cost explicitly: DSH's own automatic
  compaction wall is outside this plugin's control, and hitting it loses more than a
  deliberate close-out does. Capped at 90% of the context window — a threshold above the
  window would mean never reminding at all. The raised threshold also **expires on its
  own**: once usage drops back below the configured value (a compaction landed, or the
  stretch of work finished), the deferral is cleared. Otherwise it would quietly become a
  permanent setting. `/anchor reset` clears it immediately.
- **`status` and the reminder text report the threshold that is actually in force.**
  After `defer`, both used to print the configured value while the real threshold was
  higher — the reminder would fire at 450k and announce "threshold 300,000". They now
  show the effective line and say it was raised, with the configured value alongside for
  comparison.
- **README guidance on where to resume from.** Both READMEs now say plainly that after a
  compaction you read the anchor; `action="summary"` is a cross-check, not the source of
  truth.
- **`stage_handoff(action="cleanup")`** lists old `parent-backup/` anchors that could
  be removed, keeping the newest `keepAnchorBackups` (default 3). **It never deletes
  anything** — it reports a candidate list and says so in the output. Deleting is
  irreversible, and the plugin has no way to know whether a past stage's record is
  still needed; that decision stays with the human or the agent.
- **`stage_handoff(action="usage")`** reports the anchor directory's size, file count
  and traversal cost. The walk is bounded four ways — depth 4, 2000 directory entries,
  3000 ms, and symbolic links are never followed — and a truncated walk says so
  instead of reporting a total. This is the only module in the plugin that touches
  the filesystem, and it reads sizes, never contents.
- **Compaction through the host engine's own retention budget.** The plugin
  calls `compactRegion(start, end, agent, signal)` on the engine the harness
  already runs, keeping the automatic engine's tail budget (97,085 tokens by
  default) instead of the zero retention that the manual `/compact` path uses
  internally.
- **Engine discovery through the global cordis service store**, so the
  explicitly isolated `compaction` service can be reached without replacing the
  compaction backend. `compaction-basic` and `tool-result-pruner` stay enabled.
- **Open-turn protection.** A compaction range never covers the start of the
  running turn, and the range end is snapped to a tool-call/result balanced
  boundary.
- **Fallback path.** If the engine cannot be reached at all, the plugin reports
  what it found and falls back to queueing `/compact` rather than pretending to
  have compacted.

### Fixed

- **`cleanup` never found anything.** It looked for `<anchorRoot>/parent-backup`, but
  the policy puts `parent-backup/` *inside* each stage directory
  (`<anchorRoot>/<stage>/parent-backup`). That path never exists, so `cleanup` always
  answered "nothing to clean" with a path that looked plausible. It now walks stage
  directories and reports per stage. The old test used the wrong shape too, which is
  why it stayed green.
- **`defer` was unusable in practice.** It reads `args.tokens`, but `tokens` was never
  declared in the tool's `parameters`, so the model could not discover it — the only
  way to find it was to trigger the error message. Now declared.
- **`find-session` rejected bare UUIDs** while its own hint suggested one. Session
  directories are always `session-<uuid>`, so both forms are tried now.
- **The settings panel reported another project's anchors.** The usage route has no
  agent context and resolved the workspace through `agents.list()`, whose first entry
  is not necessarily the session being viewed — in practice it pointed at a
  character-chat project, so the panel showed `10.9 kB / 4 files` for a directory that
  was not the user's. The workspace recorded at `agent/pre-step` now takes priority.
- **Unknown-action errors listed 3 of 9 actions.**
- **`anchorTimeZone` schema disagreed with its parser**: the parser accepted a numeric
  minute offset, the schema rejected it.
- **Automatic mode could compact twice concurrently.** The cooldown is written only
  *after* a compaction finishes, so two `agent/pre-step` calls that both crossed the
  threshold before the first one finished would each start a compaction. A per-session
  in-flight guard now refuses the second. The test holds the engine open with a gate
  and asserts exactly one call, then releases it and asserts no second call follows.
- **`pendingCompact` leaked disposed agents.** It was a `Map` keyed by the agent
  object, so an agent that went away stayed referenced for the life of the plugin. It
  is a `WeakMap` now; nothing iterates it.

### Hardened

- **`anchorRoot` path-traversal guard.** A `..` segment is rejected at load, for
  both `/` and `\` separators. The reminder text names `anchorRoot` and the agent
  follows that name, so the config value is effectively a write instruction;
  traversal by configuration is now refused while absolute paths stay allowed.
- **Compaction storm cooldown.** `compactCooldownMs` (default 60,000 ms, `0`
  disables) refuses a second compaction in the same session **before the engine is
  touched**. The refusal message states that it is not a fault.
- **Injection surface reduced at the edges.** Anchors and compaction summaries are
  labelled as **data** — in the reminder and in `summary` output respectively — so
  directive-looking text that was summarised or copied into either is not read as an
  order. The plugin still cannot enforce anything about anchor content, because it
  never reads or writes anchor files; `SECURITY.md` states that limitation instead of
  implying the problem is solved.
- **Credential reminder.** The close-out text now says anchors stay on disk and must
  not contain credentials, tokens or keys. No scanning or redaction is performed —
  the plugin cannot scan files it never reads.

  > **Superseded (2026-11).** The two entries above describe the state at that time.
  > `recall`, `reconcile`, `validate`, and `guard` now do read `anchor.md`, and `guard`
  > writes `.anchor-guard.json`. `docs/SECURITY.md` states the current boundary: anchor
  > content is handed to the model as data, but it is never scanned or redacted.

### Known limitations

- The engine is discovered by inspecting cordis internals
  (`ctx.reflect.store`, `runtime.fibers[*].provisions`). If the harness changes
  those structures, discovery fails closed and the plugin falls back rather than
  misbehaving.
- Setting `compactRetainTokens` higher than the engine's own threshold is
  rejected at compaction time with a message, not silently clamped.
- No multi-version compatibility matrix yet: only DSH `0.2.2-rc.1` was exercised.
- Summary/tool-fact readback starts at plugin mount. rc.3 prohibits new calls to
  the synchronous Session history readers, and the plugin deliberately does not
  copy summary text or tool arguments into a checkpointed projection; pre-mount
  history is therefore reported as unavailable instead of guessed.
