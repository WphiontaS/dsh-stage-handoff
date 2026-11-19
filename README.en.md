# dsh-stage-handoff

> Close out the stage **before** the context is compacted, then hand the next stage a **file** instead of a summary.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that fills the two gaps DSH's own compaction leaves open: **what happens before** history is compacted, and **what the next stage starts from**.

[简体中文](README.zh-CN.md) · [Navigation](README.md)

## The problem

DSH compacts history when the context window fills. By default that is a summarization: older messages are replaced by a model-written summary. Two things are lost.

1. **Nothing asks the agent to finish.** Compaction fires on a token count, not at a natural boundary. Work in progress gets summarized mid-task, and the agent never gets a chance to record what it learned in a form the next stage can use.
2. **Nothing survives as a reference.** After compaction the agent works from a summary of its own past. There is no file it can re-read to check what was actually decided, and no way for a human to review or correct that record.

## What this plugin does

```text
        threshold (360,000 by default)
                 │
                 ▼
   ┌──────────────────────────────────┐
   │ 1. remind the agent to close out │  injected before the next model request
   │    · self-audit for hallucinations│
   │    · write the detail documents  │
   │    · rebuild a short anchor      │
   └──────────────────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────┐
   │ 2. compact, keeping the tail     │  keeps a bounded verbatim tail
   │    verbatim                      │  (32,000 tokens by default)
   └──────────────────────────────────┘
                 │
                 ▼
   next stage starts from docs/anchors/<stage>/anchor.md
```

Two points worth being precise about:

- **The retention budget is bounded on purpose, and smaller than the backend's.** DSH's automatic compaction keeps `retainTokens` = 16% of the message budget; the manual `/compact` command passes **0** and compacts down to the last node. This plugin calls the same engine with a third value: a limited verbatim tail, 32,000 tokens by default. That is not arbitrary — it started as 97,085 to mirror the automatic path, but the automatic path is priced at four characters per token while Chinese text runs at 1.5–1.8, so 97,085 retained roughly 160,000 real tokens. A large verbatim tail is actively harmful: the summary cannot see it, so its `Next Step` contradicts what the tail already shows as done. See `research/261119-compaction-degradation.md`.
- **It does not replace the compaction backend.** It calls `compactRegion(start, end, agent, signal)` on the existing engine, inside the current turn. `compaction-basic` stays enabled, `tool-result-pruner` stays enabled, so the plugin keeps working across DSH upgrades that backend-replacement plugins have to re-verify.

## How it differs from other DSH compaction plugins

Several plugins already improve **how one compaction happens** — retention policy, summary formatting, searchable history. This one is about the space **around** compaction.

| | other compaction plugins | dsh-stage-handoff |
| --- | --- | --- |
| Where the handoff lives | inside the checkpoint (session log) | a markdown file under `docs/anchors/` |
| When it is produced | at compaction, by the summarizing model | **before** compaction, as its own step |
| Lifecycle | overwritten by the next compaction | detail → anchor → parent-backup; simplified and archived as it grows |
| Human-editable | no | yes — edit the file and the next stage reads your edit |
| Compaction backend | often replaced | **untouched** |

Both approaches are reasonable; they solve different halves of the same problem. This plugin is designed to sit alongside them.

## Install

```sh
dsh plugin --profile web add https://github.com/WphiontaS/dsh-stage-handoff/releases/download/v1.0.0-beta.1/dsh-stage-handoff-1.0.0-beta.1.tgz
```

Keep the version in the file name — the release asset is named
`dsh-stage-handoff-<version>.tgz`, not `dsh-stage-handoff.tgz`. If you fork or vendor this
repo, replace the account in that URL. Restart the profile afterwards.

The package ships plain ESM: no build step, no runtime dependencies, no `prepare` script. Node.js 20 or newer.

## Configuration

Every key is optional. Defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Initial mount state; a volatile change to false disables every public entry and the `session/event` observation cache immediately, while complete unload still needs a profile remount |
| `notifyTokens` | `360000` | Context size that triggers the close-out reminder (36% of a 1M window) |
| `notifyRepeatDelta` | `25000` | Growth required before the reminder fires again |
| `notifyCooldownMs` | `300000` | Minimum wall-clock gap between reminders (5 minutes); combined with the delta gate as an AND. `0` disables |
| `notifyAfterCompaction` | `true` | After a successful compaction, the next `pre-step` injects one notice to read the current stage's anchor before continuing. Independent of `notifyTokens`, at most once per compaction, no reminder quota |
| `anchorRoot` | `docs/anchors` | Where anchor folders live |
| `anchorLimitChars` | `8000` | Soft limit for `anchor.md` before it should be archived and rewritten |
| `anchorTimeZone` | `local` | Clock used to name stage directories: `local` / `utc` / `z` / `+8` / `-5` / `+05:30`, or integer minutes in `-720..840` |
| `compactRetainTokens` | `32000` | Tail budget kept verbatim during compaction; accepts `100k` / `1m` |
| `compactCooldownMs` | `60000` | Minimum interval between compactions in one session; `0` disables |
| `agentDecidesCompaction` | `true` | `true`: the agent decides when to compact; `false`: the plugin compacts on its own at the threshold |
| `keepAnchorBackups` | `3` | How many newest backups `cleanup` keeps out of its candidate list; `0` lists all — deleting is never done either way |
| `guardMaxBytes` | `1048576` | Size ceiling for `.anchor-guard.json`, applied to both write and read; 1 MiB by default, up to 16 MiB, and raising it widens the bounded-read guarantee |
| `staleReservationTtlMs` | `86400000` | How long a scaffold reservation sidecar stays authoritative (1 day by default); older ones are reclaimed so a reused PID cannot block a stage name forever |
| `dshHome` | `''` | DSH data root for `usage`'s session sizes; empty means read `DSH_HOME` |

The DSH web settings page includes a **Stage Handoff** section. The panel follows
DSH's light/dark theme, summarizes the reminder threshold, retained tail, and
anchor directory, and groups fields under **Reminder**, **Compaction**, and
**Anchors & storage** tabs. Every field except `enabled` is editable; blurring a
field or pressing Enter asks the host to update the profile's
`cordis.patch.yml`, with a sticky save-status bar. It also supports per-field
reset, 256k/512k/1M presets, and copying the current config as YAML. `enabled`
controls both initial mounting and live entry gating. The page cannot safely
unmount its own Host entry, so it remains fixed there. A volatile profile change
to false disables the listener, tool, command, usage route, and event-ring updates
immediately; a profile remount is still required to remove the registrations
themselves.

Override them in the profile's own `cordis.patch.yml`, matched by row id:

```yaml
- id: stage-handoff
  config:
    notifyTokens: 250000
    compactRetainTokens: 60000
```

## What it exposes

**A reminder** injected into the next model request once the threshold is crossed. It asks the agent to self-audit, write detail documents, rebuild a short anchor, and then compact. Deletion, elevation, deployment, network exposure, and system changes still follow the existing approval and safety boundaries.

**A tool**, `stage_handoff(action)`:

- `status` — context usage, how many times the session has been compacted (and a warning once the summary has been rewritten over a previous one), whether the compaction engine could be reached, a dry run of the range that would be compacted, and a `思考复读:` line reporting whether the session's own reasoning has started looping
- `summary` — read the newest log-only `compaction/summary` event so the agent can check its own anchor against what the summarizer actually kept. Output distinguishes `complete` / `partial-since-mount` / `partial-truncated` / `partial-gap` / `empty` / `unavailable`; `partial-gap` means events were **missed in the middle** (disabled window, listener throw, seq jump), so an intact pair of endpoints never claims to be the complete log
- `usage` — report size and file count. `scope: "anchors"` (the default) walks the anchor directory; `"sessions"` sums each session's on-disk files; `"all"` does both. Both walks are bounded — depth 4 / 2000 entries / 3 s for anchors, at most 200 sessions for storage — and say so when truncated instead of reporting a total
- `cleanup` — list old `parent-backup/` anchors per stage directory, keeping the newest timestamped entries. Unparseable names are reported as unknown rather than treated as old; stages missing `anchor.md`, `detail/`, or detail files are listed for human review. **It only lists them**: deleting is irreversible and this plugin never does it
- `defer` — let the agent temporarily raise this session's reminder line. Clamped to 90% when the window is known; when it is unknown the receipt says `bounded=false` instead of pretending there is a ceiling
- `reset` — let the agent undo its own `defer` (`off` and raised thresholds alike) and clear the throttle

**When you come back after a compaction, read the anchor first.** The point of writing
`docs/anchors/<stage>/anchor.md` is that it *is* the hand-off artefact — reconstructed
from a summary is exactly the situation this plugin exists to replace. `action="summary"`
can still read the newest summary body, and it is worth using as a cross-check when you
suspect the anchor is missing something. But it is an aid, not the source of truth: a
summary is lossy by construction, and it does not know what you decided was important.
- `compact` — compact now, keeping the configured tail verbatim; `success` / `no-op` / `skipped` / `cancelled` / `failed` are distinct, and only `failed` enters backoff. Before compacting it snapshots the session's reasoning shape and reports whether the model was already looping — compaction replaces that evidence with a summary, so this is the last moment it is observable. The event ring stores only the shape (row counts, filler counts, the largest repeated row), never the reasoning text
- `scaffold` — atomically create `<YYMMDD-HHMM>-<topic>/` using `anchorTimeZone`, with an `anchor.md` skeleton containing the current session ID. Failures do not leave a half-stage, and an existing directory is never overwritten
- `find-session` — encode any SessionId with DSH JSONL's `~XXXX` path rule and report the matching log directory, files, and size. Only `ENOENT` means a miss; permission/path errors produce an explicitly incomplete scan instead of a false “not found”
- `recall` — search the current stage's anchor for a keyword and return **the matching line, the section it sits in, and its line number**. Reporting the section is deliberate: the same fact carries very different weight under "hard constraints" than under "decisions and rejected options". Exact substring matching, no alias expansion
- `validate` / `guard` — exclude fenced Markdown first, then run every structural and regex check against that shared view. A `guard` baseline is version 3 and keeps text, source tags, and status tags separately as a multiset; losing one duplicate occurrence or changing a tag is reported. Every anchor read rejects links/hard links, non-regular files, and files over 1 MiB through one shared safe-read layer
- `reconcile` — set the latest compaction summary beside the current anchor and report `matchKind=exact | prefix16 | none`. Only the complete normalised line counts as exact; a 16-character prefix hit does not mean the whole entry is verbatim. Misses still collapse into a count. **Facts only, no grading**. **Only works on the current session** (it reads `agent.session`)

**A command**, `/anchor`:

- `/anchor status` — threshold, current usage, anchor settings
- `/anchor threshold 250k` — change the reminder threshold for this process
- `/anchor reset` — clear the per-session reminder throttle **and any temporary threshold** (`defer` raises and `off` alike)

## The anchor format

Full procedure in [docs/ANCHOR-POLICY.md](docs/ANCHOR-POLICY.md). Short version:

```text
docs/anchors/<stage>/
├── anchor.md            # start-here: goal, constraints, decisions, next step
├── detail/
│   └── <topic>.md       # evidence, absolute paths, dead ends, open questions
└── parent-backup/
    └── anchor-<ts>.md   # previous anchors, archived when anchor.md grows too large
```

`anchor.md` is written for the next stage's **first read**, not for completeness. If it grows past `anchorLimitChars`, it gets archived and rewritten shorter, pointing at the backup.

## Verified behaviour

- The engine-discovery path and the compaction call were measured on a real session: **637,733 → 149,146 tokens in one compaction**. The `compaction/start` event carried a turn id and no source-command id — the signature of a `compactRegion` call rather than `/compact`.
- 365 offline unit tests cover schema/parser alignment (including the token and
  time-zone spellings both boundaries must agree on, plus a two-directional sweep over
  `anchorRoot` spellings), the fail-closed surface projection, event-ring
  coverage/pruning metadata plus `hasGap` gap detection and seq-continuity inference,
  its
  2 MiB per-session budget, live enabled gating, the multi-workspace usage route,
  turn-stopping automatic compaction with unified outcomes, success-before-abort
  ordering, failure backoff, the emergency-compaction quota accounting, `defer`
  outranking the emergency line, cross-platform atomic scaffold plus POSIX
  reservation-sidecar recovery, a special-SessionId end-to-end round trip,
  concurrent settings writes, safe anchor reads with a bigint inode-identity contract,
  guard multisets with strict v3 tags, ordered-list constraints, fenced-document
  exclusion, window-unknown `defer` rejection, the per-turn
  automatic anchor-drift comparison, bounded/rotated/redacted pre-step diagnostics,
  `[approval: …]` state validation, bounded walks, `partial-window` tool-fact coverage,
  read-only cleanup (asserting
  nothing is deleted), documentation links, bilingual panel rendering (English must
  contain no Chinese, asserted by executing the panel and collecting text nodes),
  and the no-engine fallback. A real
  `compact` was still not executed; this run uses host-source contract checks and
  mocks.

**Not claimed:** no third-party benchmark, no multi-version compatibility matrix, and no claim that this improves task quality over plain summarization. The only measured claim is the retention amount.

## Development

```sh
npm install     # devDependencies only (TypeScript, for type checking)
npm run check   # tsc --noEmit + node --test
```

Plain ESM JavaScript with `// @ts-check`; no build step. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the cordis isolation detail that makes the compaction call possible.

Before changing anything, read [CONTRIBUTING.md](CONTRIBUTING.md) — it lists the three constraints (no build step, no runtime dependencies, tests run offline) and the things this plugin deliberately does not do.

## License

MIT — see [LICENSE](LICENSE).
