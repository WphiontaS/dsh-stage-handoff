# Architecture

How this plugin reaches a compaction engine that the harness deliberately hides,
and why that is safe enough to ship.

## Module layout

| File | Holds |
| --- | --- |
| `lib/index.js` | plugin contract, `apply()`, tool/command/route registration, compaction orchestration, atomic scaffold, SessionId encoding |
| `lib/config.js` | defaults, validation, human-unit parsing (`300k` / `1m`) |
| `lib/util.js` | `formatCount`, `isPlainObject`, `SUMMARY_LIMIT` |
| `lib/usage.js` | streaming, bounded anchor/session size walks |
| `lib/cleanup.js` | stale-backup **detection** only; it never deletes — read-only by design |
| `lib/prestep-log.js` | opt-in bounded JSONL pre-step diagnostics |
| `lib/repeat-scan.js` | reasoning-shape extraction and the repetition verdict shared by the tool and the offline probe |

`tools/` holds the probes (`tools/probes/*.mjs`, driven by `tools/Probe.ps1`) and the
packaging scripts; `test/` holds the offline suite. Neither is in the npm `files`
list, which is why a probe may read session logs and walk an installed package
without any of that machinery shipping to users.

Filesystem access is split between read-only metadata walks and three explicit
write paths: `scaffold`, `guard`, and the opt-in pre-step diagnostic. `scaffold`
builds a hidden sibling and publishes it without replacing an existing stage;
cleanup/usage never follow linked directory entries or read file contents.

`lib/index.js` re-exports `resolveConfig`, so `lib/index.js` stays the single
import path for the plugin contract — tests and documentation never need to know
how the internals are split.

The split stops here on purpose. Everything left in `index.js` is either the
plugin contract or orchestration that has to run inside `apply()`'s closure
(where the tool and command handlers live); moving it out would mean threading the
context through several layers to gain nothing. A single-file plugin is normal in
this ecosystem — the point of the split was to get configuration and formatting out
of the orchestration code, not to hit a file count.

## Where the plugin mounts

Host plane. A single instance covers every session, because `agent/pre-step` is a
scope-filtered waterfall: a host-level listener receives the event for every
agent.

```js
export const inject = ['tokenMeter']   // tokenMeter is the only hard dependency
```

The remaining capabilities are acquired through sub-plugins, so that a missing
service disables only that capability:

| Sub-plugin | Purpose | Behaviour when absent |
| --- | --- | --- |
| `ctx.inject(['commands'])` | register `/anchor` | command missing, reminder still works |
| `ctx.inject(['tools'])` | register `stage_handoff` | tool missing, reminder still works |
| `ctx.inject(['compaction'])` | diagnostic probe only | never fires; logged as "unreachable" |

`compaction` and `tools` are deliberately **not** in the top-level `inject` list. A top-level
inject is a hard dependency: if the service is not visible in this plugin's
isolate scope, the whole plugin never starts — including the reminder. The probe
is kept only to report the isolation state to the user.

## Why the compaction service cannot be read normally

The shipped profile declares the compaction service inside an explicitly isolated
cordis group:

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
    - id: command-compact
    - id: tool-result-pruner
```

cordis isolation is a prototype-shadowed map, not a hard wall in both directions.
`isolate()` creates `shadow = Object.create(parentMap)` and pins one name to a new
symbol. Anything **inside** the group still resolves the outer scope; anything
**outside** cannot resolve inward.

Three access paths were measured on `0.2.2-rc.1`, and all three fail:

| Attempt | Result |
| --- | --- |
| `ctx.get('compaction')` | `undefined` |
| `agent.ctx.get('compaction')` | `undefined` |
| `ctx.inject(['compaction'], cb)` | callback **never fires** — the sub-plugin does not start |

The third one matters: `ctx.inject` is **not** a穿透 mechanism. It resolves
through `_getImpl`, which is the same lookup as `get`:

```js
_getImpl(name, strict = true) {
  const key = this.ctx[symbols.isolate][name];
  const impl = key && this.store[key];
  ...
}
```

Same key, same store, same answer.

## The path that does work

cordis keeps every provision in two places that are not scoped by isolation:

```js
// ReflectService
/** Service implementations, keyed by isolation label. */
store = Object.create(null)

// provide()
this.store[key] = impl
this.ctx.fiber.provisions.add(impl)   // "including isolated provisions"
```

`extend()` builds child contexts with `Object.create(parent)`, so **every** context
shares the same `ReflectService` instance through the prototype chain. Reading
`ctx.reflect.store` therefore exposes every implementation in the process,
including the isolated one. The equivalent second route is
`ctx.registry.values()` → `runtime.fibers[*].provisions`.

This plugin tries `reflect.store` first and falls back to `fiber.provisions` when
the store has no usable `compactRegion` implementation; it reports which route
found what. Both are internal structures, which is why discovery is written
defensively: any missing property or thrown getter is caught and turned into a
diagnostic line rather than an exception.

### Two known limits of this route (not defects, but not free either)

1. **Several isolates make the choice ambiguous.** `reflect.store` is keyed by
   isolation label, and the plugin takes the first candidate whose implementation is
   named `compaction`. A process with more than one such isolate — a second profile, or
   an independent sub-agent tree — can therefore hand back an engine belonging to a
   different isolate, and nothing in the plugin can tell the difference. It degrades to
   the `/compact` shell-out (which discards the verbatim tail) only when *no* candidate
   is found; a wrong-but-present candidate is used. Pinning this down needs a public
   host entry point, not more defensive parsing here.
2. **`ctx.loader.internal.import` is not a public entry point.** It is how the plugin
   loads `createUserMessage` (`@deepseek-ai/dsh-llm`) and `toolPairingBalancedBefore`
   (`@deepseek-ai/dsh-compaction`). When it is unavailable the plugin falls back to
   constructing its own `UserMessage` and to skipping the balance correction — silently,
   apart from one warn line. So a deployment without internals keeps working, but with
   two capabilities quietly degraded; `status` does not currently distinguish that state.

Both are recorded here rather than worked around, because a workaround would depend on
the same internals one level deeper.

## Why the plugin can compact by itself

`BasicCompactionEngine` exposes:

```js
async compactRegion(start, end, agent, signal) {
  return compactSurfaceRegion(this.regionDependencies(), agent.session, start, end, agent, {
    owner: 'current-turn',
    stability: 'whole-surface',
  }, signal)
}
```

`owner: 'current-turn'` requires an **open** turn. Tool calls run inside a turn;
the normal automatic path uses the serial `agent/turn-stopping` boundary, which
runs before `turn/end`. It therefore needs no idle agent, no queue, and no
`agent.runMaintenance`.

Contrast with the built-in `/compact` path:

| | `compactNow` (`/compact`) | `compactRegion` (this plugin) |
| --- | --- | --- |
| Requires | agent idle, no queued work | an open turn (true during a tool call or serial turn-stopping) |
| Wrapper | `agent.runMaintenance` | none |
| Retention | `selectCompactableRange(..., 0)` — nothing kept | chosen by the caller |
| Fails with | `ManualCompactionError('busy')` | propagates the engine error |

The `0` is the whole reason this plugin exists. With a retention of zero the
accumulation loop breaks on its **first** iteration, so the range ends one node
before the tail — the manual path compacts everything down to the last node.
Automatic compaction instead uses `spec.retainTokens`, which on a 1M window with
the local preset is 16% of the message budget: **119,040 tokens**.

## Range selection

`docs/ANCHOR-POLICY.md` describes what the user sees; this is what the code does.
It re-implements the engine's own `selectCompactableRange` so the caller can pick
a different retention:

1. Walk the priced surface nodes from the tail, accumulating `tokens`, until the
   sum reaches `compactRetainTokens`.
2. Never include surface node 0 if it is a `system/message` (the head is
   permanent).
3. Snap `keepFromIdx` forward-off the boundary using the engine's own
   `toolPairingBalancedBefore`, so a tool-call/result pair is never split. The
   helper is loaded lazily from `@deepseek-ai/dsh-compaction`; if it cannot be
   loaded, the engine's own validation still rejects an unbalanced range, so the
   worst case is a retry rather than a corrupt session.
4. Ask `AgentRegistry.turnBoundaryOf(session)` for the maintained turn projection.
   `openTurnStartSeq === null` means no truncation is needed; a numeric seq truncates
   at the first surface node after it. Turn events are log-only and never appear in
   `session.surface.nodes`; if the projection is unavailable or throws, compaction
   fails closed.
5. If nothing is left, report "no compactable range" and change nothing. This is
   the explicit `no-op` outcome right after a compaction; it does not enter failure
   backoff or leave a pending failure notice.

Compaction returns one discriminated outcome: `success | no-op | skipped |
cancelled | failed`. A successful engine transaction is recorded before checking
whether the surrounding turn was later cancelled, because the surface mutation is
already durable. Only `failed` updates exponential failure backoff.

## Sequence

```text
agent/pre-step  (every step)
  ├─ first step of turn? compare anchor.md with .anchor-guard.json
  ├─ if G2 found missing guarded lines, append one drift notice
  ├─ tokenMeter.measure(session) → totalTokens
  ├─ total < notifyTokens ? clear throttle, continue with any G2 notice
  └─ total ≥ notifyTokens and all throttles pass ?
       ├─ build reminder/failure message
       └─ append it after the G2 notice

(agent reads the reminder, writes anchor files, then calls the tool)

agent/turn-stopping  (serial, before turn/end)
  ├─ only when agent-decides-compaction is false
  ├─ only after a reminder has reached the model
  └─ await compactWithRetain(agent, signal)

stage_handoff('compact')
  ├─ findIsolatedService('compaction')  → engine | diagnostic
  ├─ check per-session success/failure gate
  ├─ tokenMeter.measure(session)        → priced nodes
  ├─ selectRetainedRange(...)           → { start, end } | null
  ├─ snap to balanced boundary
  ├─ derive open-turn cut from agents.turnBoundaryOf(session)
  └─ engine.compactRegion(start, end, agent, signal)
```

Manual compaction forwards `exec.signal` through `AbortSignal.any([exec.signal,
timeout])`. The Host does not hard-kill same-process plugin code, so forwarding and
checking that signal before entering the engine are the plugin's responsibility.

## Summary readback

`compaction/summary` is a log-only event. It cannot appear on the model surface;
the only surface mutation is the replacement `user/message`. The Host marks its
synchronous Session history readers as prohibited for new calls, so the plugin
consumes the committed `session/event` feed and keeps a 5,000-event in-memory
fact ring (summary text plus tool paths/commands) for readback. The ring tracks
`mountSeq`, `firstRetainedSeq`, `lastObservedSeq`, count/byte truncation, total
bytes, and `hasGap` — which records that an event was **missed in the middle**
(disabled window, listener throw, or a seq jump) rather than pruned at the edge.
Summary/tool/status readers derive one of `complete`, `partial-since-mount`,
`partial-truncated`, `partial-gap`, `partial-window`, `empty`, or `unavailable`; only
`complete` can be described as the whole log, and `partial-window` says the
tool-trajectory scan covered only the newest 5,000 events instead of the whole
session. The ring has a 2 MiB per-session byte budget and caps retained
summary text at 65,536 UTF-16 code units (the constant counts code units, not bytes —
about 192 KiB of CJK text) after processing at most 4,096 blocks. It never copies those content-derived values into a
projection checkpoint. If the plugin mounted after the last compaction, the response
says that pre-mount history is not available rather than claiming compaction never
happened. A miss reports the in-memory event count, actual first/last seq, summary
candidate counts, and the top event-type distribution.

The checkpointed host-only projection is separate and stores only current
surface `seq`/event-type/checkpoint flags. Compression requires that projected
surface to match `session.surface.nodes` exactly; a missing, throwing, malformed
or mismatched projection is a hard refusal.

## Measured decay, and why the anchor is a file

One deliberate destructive compaction was run against a live session on 2026-11-20
(details and the full check table in `VALIDATION.md`). Three numbers from it explain a
design choice that was previously argued only from reasoning.

**The log does not shrink.** 7,264,398 → 7,356,216 bytes. The host appends the summary
and keeps every shadowed event; a sampled 40/40 of them were still readable afterwards.
Compaction is *logical*. Two consequences: the session log grows without bound on a
long-lived conversation, and "restore from a copy of the log" stays possible — but it was
only ever possible once per copy, so take a fresh one before each attempt.

**Summaries decay with every round.** Measured against the entity set of the summary they
replaced, the 5th-generation summary of that session retained: versions 2/2, file paths
13/22, quoted human requests 2/12, **commit hashes 1/15**, **anchor paths 0/1**. Trunk and
structure survived completely (8/8 sections, including `Next Step`); identifiers did not.

That is the empirical argument for the anchor being a **file on disk** rather than a
paragraph in the context. A summary is rewritten by a model each time it is folded into a
new one, so anything it holds is one rewrite away from being gone; a file is not touched by
compaction at all. It is also why the reminder tells the next stage to read the anchor and
*then* verify it, instead of trusting either artifact alone.

**Detail loss is not a defect in this plugin.** The plugin selects the range, keeps the
tail verbatim, and writes the anchor; the summary text is produced by the host's summariser.
Beyond that, the first version of the verification metric demanded ≥50 % entity retention
across two **non-overlapping** ranges after four prior summaries — it failed a healthy
system. The metric was wrong, not the compaction.

## Settings usage route

The settings page is root-scoped and receives no session id. A host HTTP request
therefore cannot know which conversation the person is viewing. The authenticated
`GET /api/stage-handoff/usage` route returns anchor rows for every distinct active
workspace (up to eight) and labels each path, instead of guessing from
`agents.list()[0]` or one process-global last-seen value. Session-storage totals
remain global to `DSH_HOME`.

## Scaffold transaction

`scaffold` resolves the configured root, rejects filesystem/share roots, the
Windows system directory, linked roots, and relative roots escaping the workspace
after realpath. The one linked-root exception is a relative root whose nearest
existing ancestor is the workspace itself: when the workspace is a junction, that
ancestor *is* the junction, so it is followed with `stat` and the realpath
containment check decides — a link that leaves the workspace is still refused.
It then writes `anchor.md` and `detail/` in a hidden sibling.
Before publishing, it checks the final name and, on POSIX, atomically reserves it
with `mkdir()`; POSIX `rename()` may replace an existing empty directory, so
relying on `EEXIST` there would violate no-overwrite. The complete sibling
replaces only the plugin's own empty reservation. A short-lived sidecar records
stage name, PID and random ownership token; if the process dies between `mkdir`
and `rename`, the next invocation removes only that proven empty reservation.
A non-empty stage is never auto-cleaned (at most its stale sidecar is removed), and
an empty one is reclaimed only when the sidecar proves ownership and its PID is gone
or the sidecar is past `staleReservationTtlMs`; expiry reclaims even a live PID,
because PID reuse would otherwise make one stage name permanently uncreatable.
A failure removes the sibling and reservation it created; pre-existing stages are
never overwritten.

All anchor content reads (`recall`, `reconcile`, `validate`, `guard`, and scaffold's
previous anchor) go through one safe-read layer. It rejects linked roots, stages and
files, requires a regular single-link file, proves both stage and file real paths
stay inside the canonical anchor root, and caps one file at 1 MiB. The bounded reader
consumes at most that limit plus one byte from the opened handle.

Stage discovery counts all directory entries and stops at 2,000 entries or 3,000 ms.
An incomplete scan is never sorted into a guessed latest stage; callers must supply
an explicit stage or ask the operator to reduce the directory. Explicit-stage
operations skip discovery and go directly to the safe-read layer.

## Degradation

| Failure | Behaviour |
| --- | --- |
| Engine not found during manual `compact` | report the diagnostic lines, then fall back to queueing `/compact` (which keeps nothing) and say so |
| Engine found but has no `compactRegion` | same as above |
| Engine not found during automatic mode | do not silently switch to zero-retention `/compact`; record a visible failure/backoff |
| No compactable range | report it, change nothing — the normal state after a recent compaction |
| Range would cover the open turn | refuse this round, keep the verbatim history |
| Turn boundary cannot be proved from the log | fail closed; do not call the engine |
| Compaction failed | visible exponential per-session backoff; `status` reports the reason |
| `tokenMeter.measure` throws | that step is skipped, the reminder is not injected |
| `createUserMessage` cannot be loaded | fall back to a locally constructed message with the same shape |

Every one of these is a report, never a silent no-op and never a半成 state.
