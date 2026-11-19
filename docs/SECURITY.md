# Security

Threat model and current mitigations. This document is filled in progressively —
the attack-surface section is complete, and the hardening work is tracked as
outstanding items rather than described as done.

## Trust boundaries

| Boundary | Direction | What crosses it |
| --- | --- | --- |
| Harness → plugin | in | session measurement, surface node ids, committed `session/event` notices, tool-call arguments parsed into a bounded memory-only fact ring, and compaction summary text held in that same in-memory ring |
| Plugin → harness | out | one reminder message per threshold crossing or a failure-only notice; one `compactRegion` call; authenticated same-origin usage response |
| Plugin → host settings | out | one validated key in the plugin's own `stage-handoff` namespace when a person saves the settings form |
| Plugin → filesystem | **read** for anchor tools; **write** on explicit `scaffold` and `guard`, plus the explicitly opted-in pre-step diagnostic | `recall`, `reconcile`, `validate`, `guard`, and scaffold's previous-anchor archive read `anchor.md` through one bounded, link-rejecting layer. `scaffold` atomically creates a skeleton `anchor.md`, empty `detail/`, and `parent-backup/` under `anchorRoot`; `guard` writes `.anchor-guard.json` into the current stage directory (temp file + rename, after a realpath containment check and link rejection); usage/cleanup otherwise read metadata only. `DSH_STAGE_HANDOFF_PRESTEP_LOG` enables one 256 KiB JSONL diagnostic plus `.1`, with link rejection and no message bodies or arbitrary thrown-error text |
| Plugin → OS clipboard | out | only after an explicit **Copy YAML** click; the current Stage Handoff configuration, never credentials or other namespaces |
| Plugin → network | **none outbound** | registers `/api/stage-handoff/usage` on the existing authenticated Host connection; no client/socket is created |
| Agent → filesystem | via the agent's own tools | anchor documents |

The plugin has two anchor write paths (`scaffold`, `guard`), one opt-in diagnostic
write path, and one inbound Host route. Settings edits are delegated to the host, which writes only the
`stage-handoff` entry in `cordis.patch.yml`. The rest of the anchor content is
written by the agent using its ordinary file tools. Clipboard output is limited to
the same settings snapshot and only on a direct user action; the plugin never reads
clipboard contents.

## Status at a glance

| # | Surface | Status |
| --- | --- | --- |
| 1 | Anchor content injection | **Partly mitigated** — labelled as data; not enforceable without taking over file reads |
| 2 | `anchorRoot` path traversal / linked roots | **Mitigated** — `..` and control characters rejected at load; relative roots must realpath-inside the workspace; share/system roots and linked roots are refused for `scaffold`, with one narrow exception: when the workspace itself is a junction, the nearest existing ancestor of a relative root *is* that junction, and the realpath containment check decides instead — a link that leaves the workspace is still refused; absolute paths remain allowed by design |
| 3 | Compaction storm | **Mitigated** — per-session success cooldown plus exponential failure backoff, checked before the engine is touched |
| 4 | Credential leakage into anchors | **Partly mitigated** — `recall`, `validate`, `reconcile` and `guard` read bounded `anchor.md` content and echo lines, fragments or signatures into model-visible tool results. No secret scanning or redaction is performed. Treat an anchor as model-visible data and keep credentials out of it |
| 5 | Forged tool invocation | **Delegated** — inherits the harness's own tool authorization on purpose |
| 6 | Large-directory traversal | **Mitigated** — every `anchorRoot` stage scan is capped at 2,000 total entries and 3,000 ms; usage/cleanup walks carry depth, entry and time limits; linked entries are skipped |

"Mitigated" means code and a test enforce it. "Partly mitigated" and "Accepted"
mean the boundary is structural and is stated rather than pretended away.

**Link rejection is best-effort against concurrent writers.** Reads and diagnostic
writes open the file first, then `fstat` that open handle and compare `ino`/`dev`
against the `lstat` result, so a swap that happens after the `lstat` check cannot
redirect what is read or appended. Both sides are taken with `{ bigint: true }`:
NTFS file ids exceed `Number.MAX_SAFE_INTEGER`, and the earlier
`Number.isSafeInteger` guard made this comparison unreachable on Windows — the
detection was fail-open there while this document claimed the window was closed. The
remaining window is `open` itself following a symlink: Node's `fs` cannot refuse that
portably (Windows has no `O_NOFOLLOW`). The guarantee is "no link is ever knowingly
followed", not "a racing writer cannot win".

## What `scaffold` may write

`action="scaffold"` and `action="guard"` are the only paths where this plugin creates files. Its
boundary is deliberately narrow:

- It writes **only** under `<anchorRoot>`, resolved from the calling agent's
  workspace. `..` is rejected at load; a relative root must resolve inside that
  workspace; filesystem/share roots, the Windows system directory, and linked
  roots are refused. One narrow exception covers the workspace that is itself a
  junction: the nearest existing ancestor of a relative root is then that junction,
  and refusing it would fail the first `scaffold` in an otherwise valid setup. That
  ancestor is followed with `stat` and the realpath containment check below decides,
  so a link pointing outside the workspace is still refused. The exception never
  applies to an absolute `anchorRoot`, which is not resolved against the workspace.
- `topic` starts with an alphanumeric character, contains no path separators, and
  cannot end in a dot, avoiding Windows trailing-dot normalization.
- It creates a **new** directory and fails with `EEXIST` instead of writing into an
  existing one, so it can never clobber a stage in progress or overwrite an anchor.
- It writes a complete hidden sibling before publishing. On POSIX, it first
  atomically reserves the final name with `mkdir()` so the following `rename()`
  can replace only that empty reservation; without this step, POSIX rename would
  silently replace a pre-existing empty stage. Windows retains its native
  no-replace rename behaviour. A failure removes only the reservation and hidden
  sibling it created.
- The POSIX reservation has an ownership sidecar containing stage name, PID,
  random token and timestamp. Automatic recovery for a dead PID removes only an
  empty reservation; an active owner, malformed sidecar or non-empty stage is
  preserved and reported. The single exception is `staleReservationTtlMs` (default one
  day, minimum one minute): a sidecar older than that is reclaimed **even when the PID
  is still alive**, because PID reuse would otherwise make one stage name permanently
  uncreatable. An ordinary empty stage without this proof remains a conflict and is
  never treated as disposable.

Everything else stays read-only, and `cleanup` still only lists.

## Why this plugin never deletes files

`action="cleanup"` reports stale `parent-backup/` anchors, and that is where it stops.
There is no `apply`, no `--force`, no threshold that turns reporting into deleting.

Three reasons, in order of weight:

1. **The plugin cannot know what is still needed.** A backup is another stage's
   original record. Nothing in this plugin can tell a finished stage from one that
   will be reopened next week.
2. **Deletion is irreversible and the value proposition is durability.** The whole
   point of writing anchors is that they survive compaction. A component that
   sometimes removes them undermines the reason to trust the rest of it.
3. **A threshold is not a decision.** "Delete backups older than N" is exactly the
   kind of rule that quietly destroys something important. The list plus a human
   decision is slower and safer.

Tests enforce this the only way that means anything: `cleanup` runs, and then the
files are re-read from disk and asserted to still be there — including with
`keepAnchorBackups: 0`, which lists everything as a candidate.

## Attack surface

Documented here so each item can be closed or explicitly accepted.

### 1. Anchor content injection (self-poisoning)

**Scenario.** The agent writes an anchor, later reads it back, and treats text in
it as instructions. A malicious or merely confused instruction in an anchor —
`ignore the constraint above`, `delete the tests`, `the token is …` — then acquires
authority in a later stage.

**Why it matters here.** Anchors are read early in the next stage, before the model
has other context to compare against.

**Current state (partly mitigated; not fully fixable here).** The plugin creates
the initial skeleton and edits no anchor content afterwards; the agent writes the
content with its ordinary file tools. Read-only actions (`recall`, `validate`,
`reconcile`, `guard`) still read the anchor, so this plugin cannot enforce
anything about the content. Exactly three mitigations exist:

1. The reminder requires anchors to contain **facts and constraints, not imperative
   sentences**, and says a passage does not become an order by being copied into an
   anchor.
2. `stage_handoff(action="summary")` labels the summary body as **data**, with an
   explicit warning that directive-looking text inside it is old text that got
   summarised in.
3. `docs/ANCHOR-POLICY.md` tells the reader to treat anchors as notes.

**Why it is not fixed.** Enforcing it would mean taking over every anchor read and
controlling all future consumers, not just the five tool actions above. The plugin's
safe-read layer bounds which file is opened, but it cannot establish semantic trust
in the content. Anything stronger belongs in the harness or the agent's tool policy.

**Still open.** No structural isolation of anchor content, no detection of
directive-looking lines, no diff against the previous anchor.

### 2. `anchorRoot` path traversal

**Scenario.** `anchorRoot` is set to a path containing `..` or control characters,
or to an absolute path
outside the project, and the agent is steered into writing there.

**Current state (mitigated for scaffold).** `anchorRoot` is validated at load: any
`..` segment or control character is rejected with an error naming the offending
value, for both `/` and `\` separators. Before writing, `scaffold` rejects filesystem/UNC-share roots,
the Windows system directory, and an `anchorRoot` that is itself a link — with one
narrow exception: when the workspace itself is a junction and the nearest existing
ancestor of a *relative* root is that same junction, it is followed with `stat` and
the containment check below decides. A relative
root must remain inside the calling workspace after `realpath`; this catches a
junction/symlink inserted below the workspace. Absolute paths are still allowed on
purpose — a user may want one shared anchor directory outside the project.

**Still open.** Absolute roots intentionally are not confined to the workspace.
Other tools may create a link below a shared absolute root after configuration;
scaffold refuses a linked root itself (apart from the workspace-junction exception
above), but cannot make a shared mutable directory
equivalent to a security boundary.

### 3. Compaction storm

**Scenario.** Something drives repeated compactions — a loop calling the tool, or a
mis-set retention that leaves a tiny range each time. Each compaction costs an LLM
call and rewrites history; a storm can leave the session unable to do work.

**Current state (mitigated).** Per-session cooldown, `compactCooldownMs` (default
60,000 ms; `0` disables). A second compaction inside the window is refused
**before the engine is touched**, with a message that states plainly it is not a
fault. The normal automatic path is awaited inside the serial
`agent/turn-stopping` boundary before `turn/end`; the pre-step high-water path
remains a fallback for a turn that does not close. A host-reported whole-surface
race is treated as retryable through the same engine; it does not inherit the
failure backoff or consume the reminder quota. There is a second structural guard:
after a successful compaction there is usually no compactable range left, so the
next call reports that and changes nothing.

**Still open.** No cross-session rate limit, and no projected-gain check that would
refuse a compaction which would save very little.

### 4. Credential leakage into anchors

**Scenario.** A secret that appeared in the conversation gets summarized into an
anchor, the anchor is committed to a git repository.

**Current state (accepted, with one reminder).** The bounded anchor read layer can
surface content to the model, but performs no scanning, redaction, or secret detection.
The reminder states that anchors stay on disk and must not contain credentials, tokens
or keys. The default
location (`docs/anchors/`) is inside the working directory, so in a git repository
anchors can be committed by accident.

**Why it is not fixed.** Same semantic boundary as item 1. A reliable redactor would
have to distinguish secrets from identifiers and paths, and a scanner that cries wolf
trains users to ignore it.

**Mitigation available to the user.** Put `docs/anchors/` in `.gitignore` when the
working repository is public, or point `anchorRoot` outside the repository.

### 5. Forged tool invocation

**Scenario.** Another process or plugin calls the compaction path with a crafted
agent, bypassing the reminder and compacting at a moment the user did not intend.

**Current state.** The tool is registered through the harness's own tool registry,
so it inherits the harness's authorization. The plugin adds no token or call-site
check of its own.

**Candidate fixes.** None planned — this is delegated to the harness on purpose.
Worth stating so nobody assumes extra protection exists.

### 6. Large-directory traversal

**Scenario.** Reading a configured anchor directory to report its size walks into a
huge tree, hanging the host.

**Current state (mitigated).** `stage_handoff(action="usage")` walks the anchor
directory with streaming `opendir()` handles, so a single huge directory is not
materialized before limits apply. The walk is bounded on four axes:

| Limit | Default | Behaviour when hit |
| --- | --- | --- |
| depth | 4 | stop, report `truncated` |
| directory entries | 2000 | stop, report `truncated` |
| wall clock | 3000 ms | stop, report `truncated` |
| symbolic links | never followed | skipped entirely |

A truncated walk is **reported as truncated**: the output says the number is a lower
bound, not a total. That distinction matters, because a silently truncated size reads
as "the directory is small", which is the opposite of the truth. Only sizes are read;
file contents never are.

Session-storage and `cleanup` scans use the same streaming/lstat approach. Cleanup
caps the anchor root and review inventory, caps candidate output, and reports
unreadable roots instead of converting them to “nothing to clean”.

The event-feed tool-fact ring also refuses to parse a raw argument string
above 1 MiB, and caps extracted values at 128 strings per event and 4,096
characters per value. One oversized `tool/call` therefore cannot become an
unbounded parsing or in-memory payload.

Stage discovery is a separate bounded scan. It counts every directory entry,
including files whose names do not match the stage pattern, and stops at 2,000
entries or 3,000 ms. A truncated scan is returned as incomplete: `recall`,
`reconcile`, `guard`, `validate` and `scaffold` refuse to select a latest stage
from it. Passing an explicit `stage` bypasses enumeration. Summary extraction is
also bounded to 4,096 blocks and 65,536 UTF-16 code units (the constant counts code
units, not bytes; 65,536 CJK characters are about 192 KiB) before text is joined.

Anchor and diagnostic readers first reject linked or out-of-policy file types,
then check size through the opened handle and consume at most the configured byte
budget plus one byte. This prevents a file that grows after the metadata check
from being loaded in full before the size error is raised.

**Still open.** No caching, so repeated calls re-walk. The three limits are constants,
not configuration — a deliberately huge anchor tree will always report a lower bound.

## What `guard` does and does not protect

`guard` records the anchor's hard constraints and rejected options in
`.anchor-guard.json`, and the plugin compares the anchor against that baseline at the
start of every turn (see `anchorDriftText`). It reports lines that were in the baseline
and are no longer in the anchor.

**It protects against accidental loss and staleness.** A constraint that gets deleted, or
a decision that quietly stops being recorded, surfaces on the next turn instead of
silently disappearing. That is the common failure: anchors go stale far more often than
they get attacked.

**It does not protect against tampering.** Anyone who can rewrite `anchor.md` can rewrite
`.anchor-guard.json` in the same breath — nothing secret sits behind the comparison, so
this is accident evidence, not tamper evidence.

That limitation is deliberate. Real tamper evidence needs a key the attacker does not
hold, and this plugin runs for one person on one machine. Adding a key would make
"update the baseline" a ritual, which mainly lowers the chance that anyone maintains the
baseline at all. If you do need tamper evidence, keep `.anchor-guard.json` under version
control outside the agent's reach: that gives you a history the session cannot rewrite.

## What this plugin deliberately does not do

- It does not disable `compaction-basic` or `tool-result-pruner`, so the harness's
  own safety behaviour stays in place if this plugin misbehaves.
- It does not write to the session log except through the engine's own API.
- Its only HTTP surface is the owner-authenticated, read-only
  `/api/stage-handoff/usage` route on the existing DSH connection; it opens no
  listener and makes no outbound request.
- It does not read credentials.

## Reporting

Open an issue on the repository. For anything that looks exploitable, please
include the version, the configuration, and the smallest reproduction you can.
