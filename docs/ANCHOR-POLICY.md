# Anchor policy

The procedure the reminder asks the agent to follow. Written for humans: this is
what "close out the stage" means in practice, and what should end up on disk.

## Why it exists

A context window is a scroll bar. Once something scrolls off, it does not exist
for the model — and the model has no way to know it forgot. Compaction makes that
worse: it replaces a batch of history with a model-written summary, so even the
*shape* of what was lost is gone.

Two habits fix that, and neither is a model capability:

1. **Write down what matters before the window closes**, in a form a human can
   read and correct.
2. **Keep the tail verbatim** so the next stage has something to check the
   summary against.

This plugin provides the trigger for (1) and the mechanism for (2).

## The seven steps

```text
1. threshold reached ──► 2. self-audit ──► 3. write detail docs
                                              │
7. anchor grew too large ◄── 6. continue ◄── 5. compact ◄── 4. rebuild short anchor
        │
        └─► archive into parent-backup/, rewrite shorter, point at the backup
```

### 1. Threshold reached

The reminder appears in the next model request. It is not a question — it is an
instruction to stop expanding scope and start closing out.

### 2. Self-audit

Go back over the stage's conclusions and check each one against evidence:

- Did I actually read that file, or did I assume its contents?
- Did I actually run that command, or did I expect it to work?
- Is that number measured, or remembered?

Anything without evidence gets marked **unverified** or deleted. This step exists
because a summary amplifies whatever it was given: a wrong conclusion written down
confidently becomes load-bearing for the next stage.

### 3. Write the detail document

`<anchorRoot>/<YYMMDD-HHMM-slug>/detail/<topic>.md`.

**Let the tool name the directory.** Call
`stage_handoff(action="scaffold", topic="<slug>")` and it atomically creates the
stage directory plus an `anchor.md` skeleton, using the configured
`anchorTimeZone` at the moment you call it. That matters: a reminder often fires
well before the close-out actually happens, so a timestamp taken at reminder time
would disagree with reality. The stamp never contains a colon because Windows
forbids it in path segments.

Contents that survive contact with a future reader:

- What was completed, and the evidence for it (path, command, output line).
- **Absolute paths** of files changed. Relative paths rot.
- Dead ends and why they failed — this is the highest-value part and the part most
  often skipped.
- Open questions, explicitly marked as open.

### 4. Rebuild the short anchor

`<anchorRoot>/<YYMMDD-HHMM-slug>/anchor.md`.

This file is written for the next stage's **first read**, not for completeness.
If it were complete it would be the detail document, and it would cost the same
context the stage just spent.

Keep: the goal in one or two lines, the constraints that are not obvious from the
code, the decisions already made and why, and the next concrete step. Point at the
detail document in the first line so the reader knows where the rest is.

**Spend the characters where the summary cannot follow.** Measured on 69 real
compactions at an equal character budget, a native compaction summary retains
absolute filesystem paths at **72.2%** but confidence-marked reasoning claims at
only **8.2%**; bare numbers in prose fare even worse at 7.3%
([Calibration-Density Law](https://zenodo.org/records/21921441), §Measurement B).
**Those figures come from comparing a native summary against a structured brief
after a single compaction — not from anyone writing a stage handoff by hand.** Treat
them as direction, not as an expected value for this plugin: the direction is that a
summary keeps paths far better than it keeps reasoning, and that is all the decision
below relies on.
The practical consequence is counter-intuitive: **listing paths in the anchor
duplicates what the summary already keeps**, while decisions, rejected
alternatives and the reasons behind them are exactly what gets smoothed away.
So the anchor carries the reasoning and only the handful of entry points the
summary would not mention.

**Tag every decision with its status.** The single most expensive failure in a
multi-stage archive is not losing a decision — it is keeping two contradictory
ones and being unable to tell which is current. The machine-readable labels are
the Chinese canonical forms below; the English glosses are explanatory only.
A benchmark of seven
representative memory systems (long-context LLMs, RAG, memory frameworks) averaged
**27.9%** accuracy under multi-target interference, and the authors name the
bottleneck explicitly: *"interference from change over time — facts revised or
updated by later context"*
([The Horizon Gap](https://ar5iv.labs.arxiv.org/html/2608.06663), §4). **That 27.9%
is the average over seven memory systems on a purpose-built interference probe; it is
not a measurement of this plugin or of hand-written anchors.** It is cited here only
because it names the failure mode this section exists to prevent. So a superseded
decision is marked **in place**, never silently replaced:

- `[有效]` (“active”) — this is the current answer
- `[已推翻 by <stage>]` (“overturned”) — used to be the answer; say what replaced it in the same line
- `[否决]` (“rejected”) — never adopted; keep the reason, because the next stage will
  otherwise propose it again

**One-line handoff.** The anchor opens with a single sentence naming the file and
one immediately startable action — `Read <this file> and do <action>`. The
[Handoff Skill](https://github.com/dsifry/metaswarm/blob/4bbb10abd301b9ec9d63371e296049cbc6043baa/skills/handoff/SKILL.md)
makes this the entire deliverable contract, and the reason is sound: a vague
"continue the work" costs the next reader a full re-orientation, which is exactly
the cost the anchor exists to remove.

Structure the scaffold actually produces (`action="scaffold"` writes these headings; the
reminder text itself does not list them):

```markdown
# <stage> anchor

Detail: detail/<topic>.md
Previous anchor: parent-backup/anchor-<timestamp>.md   (or "none, first version")
One-line handoff: Read <this file> and do <the next concrete action>

## 下一步
   (ordered, most important first. Each line executable — which file, which command.
    No "keep going". A handoff is worth more as forward instructions than as a backward snapshot;
    `stage_handoff(action="validate")` checks this mechanically.)
## 不能丢的事实
   (one per line: what is gone for good if it is not written here)
## 目标

## 当前进度

   (buckets: done / in progress / blocked)
## 硬约束
   (tag where each came from: [人工明确] / [实测 YYMMDD] / [推断未验证])
## 决策与否决
   (tag each status: [有效] / [已推翻 by <stage>] / [否决];
    and say where the reason came from — a person, a measurement, or inference)
```

**Say where each constraint came from.** An agent writing its own handoff text can smuggle in
permissions and requirements the record does not support: on synthetic tasks, unsupported
restrictions appeared in **1.2–2.4%** of handoff summaries and unsupported authorizations in
**0.1–1.3%**, and the invented restrictions mostly traced back to the agent's own earlier
reasoning that some ordinary action needed approval
([When Do Summaries Become Instructions?](https://arxiv.org/html/2611.06545)).
Replacing a system-prompt line like "some actions need approval" with a scoped sentence that says
**where requirements come from** cut unsupported restrictions from **5.0% to 1.8%** on development
summaries and from **1.8% to 0.3%** on held-out templates (both p<10⁻⁹, same paper).
**That study used small open-weight models on synthetic keep-a-ledger tasks — it is not a
measurement of this plugin or of hand-written anchors.** The mechanism is what transfers:
**the next stage cannot tell "a person decided this" from "the previous stage guessed this"
unless you write it down.** So tag each hard constraint:

- `[人工明确]` (“human-stated”) — a person said it this round
- `[实测 YYMMDD]` (“measured”) — verified by running a command or reading host code
- `[推断未验证]` (“inferred, unverified”) — reasoned out, never confirmed by anyone

## Verifying before you act

An anchor records what the previous stage **claimed**. Reading it is not the same as
confirming it, and the two failures this plugin worries about most both look like a
perfectly normal anchor:

- If the first next step names a file, open that file instead of trusting the anchor's
  description of it.
- If a next step says something was already changed, check that it still holds. The
  common failure is not tampering but **staleness**.
- The plugin compares the anchor against `.anchor-guard.json` at the start of every turn
  and injects a notice when a guarded line disappears. When that notice appears, **the
  baseline wins over the file you just read**.

Why bother: state drift persists even when every local reasoning step is coherent, so an
agent has no internal signal that its picture has gone stale. See `research/SOURCES.md`
§B3 and the State Drift entry.

```markdown
## 关键入口
   (only the few the summary will not carry; paths are the summary's strength)

## 会话索引

| Session ID | When | What it produced |
| --- | --- | --- |
| `session-…` | 2026-11-15 23:59 | … |
```

**Why a session table.** A stage routinely spans more than one session — you
restart DSH, open a fresh conversation, or come back the next morning. The anchor
is the only artifact that survives all of those, so it should say *which sessions*
produced what. Given a session ID you can still find the session log and read the
raw history; without it, "written during the stage" is the only provenance you get.

The reminder text carries the current session ID so it can be copied rather than
recalled. Session IDs are locators, not conversation content — writing them down
does not violate the "no conversation transcripts in anchors" rule.

### 5. Compact

Call the tool with `action: "compact"`.

The plugin selects a range, snaps it to a balanced boundary, keeps the configured
tail verbatim, and compacts the rest. This happens **inside the current turn**, so
there is nothing to wait for. The current turn is located from the log-only
`turn/start`; no surface node created after that marker is included in the range.

What the compaction keeps:

| Part | Kept how |
| --- | --- |
| The recent tail | verbatim, up to `compactRetainTokens` (32,000 by default) |
| Everything older | replaced by a model-written summary |
| The head message | never compacted |
| The current turn | never compacted; if its boundary cannot be proved, compaction is refused |

### 6. Continue

Resume from `anchor.md`. Do not re-read the whole detail document unless the
anchor points at something you need — that is the point of having two files.

### 7. Grow by editing; shrink only as a last resort

**Edit the anchor in place. Do not rewrite it.** ACE documents a failure mode it calls
*context collapse*: asking a model to rewrite an accumulated context wholesale makes it
collapse into a much shorter, less informative summary. On AppWorld an 18,282-token
context at 66.7 accuracy collapsed to **122 tokens at 57.1** on the very next rewrite —
**below the 63.7 baseline of no adaptation at all**
([ACE, arXiv 2510.04618](https://arxiv.org/abs/2510.04618), §2.2).

So the habit is:

- **Append** new decisions, constraints and entry points.
- **Annotate in place** when something changes — flip `[有效]` to
  `[已推翻 by <stage>]` and say what replaced it on the same line.
- **Never regenerate the whole file** merely to make it read more cleanly.

**Recall first, precision second.** Anthropic's guidance for compaction is to
*"start by maximizing recall… then iterate to improve precision"*, warning that
*"overly aggressive compaction can result in the loss of subtle but critical context
whose importance only becomes apparent later"*
([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
The order matters here: **write down what you know before you consider trimming it.**

When the anchor really does outgrow `anchorLimitChars` (8,000 characters by default):

1. Move it into `parent-backup/anchor-<timestamp>.md` — move, never delete.
2. Write a shorter version, but **cut in this order**: resolved sub-tasks and their
   outcomes first; then entry points that no longer matter; then — only if still too
   long — the oldest decision rationale. **Never cut hard constraints, and never cut the
   reason on a `[否决]` line**: those are exactly what a summary cannot reconstruct.
3. Point the new anchor at the backup.

The chain of backups is the stage's own history: each one is what the next stage
believed at the time.

## Directory layout

```text
docs/anchors/
├── <YYMMDD-HHMM-slug>/
│   ├── anchor.md                  # current anchor, start here
│   ├── detail/
│   │   └── <topic>.md             # evidence and dead ends
│   └── parent-backup/
│       └── anchor-<timestamp>.md  # superseded anchors
└── <YYMMDD-HHMM-slug>/ …
```

### Stage directory naming

`YYMMDD-HHMM-slug` — for example `261115-2359-stage-handoff`.

- **Timestamp first**, so lexicographic order equals chronological order: a plain
  directory listing is a timeline and the newest stage sorts last.
- **One clock, chosen explicitly.** `anchorTimeZone` decides whether the stamp is
  local time, UTC, or a fixed offset (`+8`, `-5`, `+05:30`, or numeric minutes).
  Whichever you pick, the stamp is taken when `scaffold` runs, never when the
  reminder fired. `local` keeps DST ambiguity by design; use UTC or a fixed offset
  when repeat/backward clock jumps would confuse ordering.
- **Minutes, not just the date.** Closing out twice in one day is normal during
  long sessions. Two calls with the same topic in the same minute still collide;
  the second call refuses to overwrite rather than silently inventing a stage.
- **No colons.** Windows reserves `:` in path segments, so `23:59` can never be
  part of a directory name. `2359` stays sortable and portable.
- **The slug is short and readable** — `stage-handoff`, not a sentence.
- **The name never changes mid-stage.** Other anchors, backups and tool output all
  point at it, so a rename silently breaks every reference.

## Failure modes worth naming

| Symptom | What actually happened |
| --- | --- |
| The anchor reads like a summary of the conversation | It was written for completeness. Rewrite it as instructions for one reader who knows nothing. |
| The next stage re-does work | The anchor listed what was done but not **why** the alternatives were rejected. |
| The anchor is confident about something wrong | Step 2 was skipped. Unverified conclusions propagate. |
| The anchor is huge | Step 7 was skipped for several stages in a row. |
| Nothing was written at all | Either the threshold is too high for the size of the work, or the reminder is being treated as a suggestion. |
