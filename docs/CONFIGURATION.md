# Configuration

Every key is optional. Defaults are chosen for a 1M-token window; the notes explain
what each one trades off.

```yaml
- id: stage-handoff
  config:
    enabled: true
    notifyTokens: 363520
    notifyRepeatDelta: 25000
    anchorRoot: docs/anchors
    anchorLimitChars: 8000
    compactRetainTokens: 32000
    hostMaxTokens: 256000
    guardMaxBytes: 1048576
    staleReservationTtlMs: 86400000
```

The DSH web settings page exposes the same keys in a **Stage Handoff** section.
Editable fields are saved through the host's config form and update the running
plugin through Cordis's volatile-config event. `enabled` is also volatile so a
profile hot update can disable every entry immediately. The registrations remain
mounted until the profile is remounted; the page therefore shows enabled as a fixed
status rather than a self-unmount control.

The page groups fields into Reminder, Compaction, and Anchors & storage tabs. It
follows the DSH interface language: labels, hints, group titles and validation
messages are bilingual, and switching the language re-renders the panel without a
reload. Customized fields carry a badge and can be reset individually to their inherited
defaults. The 256k/512k/1M presets atomically set `notifyTokens`,
`compactRetainTokens`, and `anchorLimitChars` (the 256k one also lowers
`hostMaxTokens` to 131,072 — without that the window cannot be compacted at all).
Each preset writes **explicit** values rather than unsetting fields, and every
`notifyTokens` it writes equals half of the computed harness wall. **Copy YAML** copies
the current
Stage Handoff section for documentation or manual profile edits.

Set them in the **profile's own** `cordis.patch.yml` (matched by row id), not in
the package's file — the package copy is replaced on upgrade.

Unknown keys are rejected at load time with the list of accepted names, rather thanbeing silently ignored. That is deliberate: a typo in `notifyTokens` that silently
kept the default would look like the plugin ignoring the configuration.

Numeric fields that control token counts, durations, backup counts or anchor length
share a maximum of `1,000,000,000`. For token strings and duration fields, the
ceiling is checked **after** unit conversion. The Host schema and settings panel use
the same bound, so `954m` cannot be accepted by one layer and rejected by the next.

## `enabled`

| | |
| --- | --- |
| Type | boolean |
| Default | `true` |

At initial mount, `false` registers nothing. If a volatile profile update changes
`true` to `false`, the reminder listener, tool execute, `/anchor`, queued compaction
status handler, usage route, and `session/event` observation-cache listener all become
inert immediately. The usage route returns HTTP 503 and explains that the entry is
disabled. A warning records that the input is disabled but the plugin is still mounted.

To remove the registrations themselves, edit the profile and remount/restart DSH.
The settings page is not allowed to unmount its own Host entry.

## `notifyTokens`

| | |
| --- | --- |
| Type | positive integer, or a human string (`300k`, `1m`) |
| Default | `363520` |

The measured context size at which the close-out reminder is injected. The default is
**exactly half the harness compaction wall** on a 1M window: `min(W×0.8, W−256k−65.5k)`
= 727,040, half = 363,520. The presets express the same relationship, so there is one
number in the design rather than two. (It used to be 360,000 — a 36%-of-window figure
that missed the half-wall by 1%, which is why the default and the 1M preset disagreed.)

**The anchor is the harness wall, not the window.** `dsh-compaction-basic` compacts at
`floor(min(W × 0.8, W − maxTokens − 65,536))`. That is not a fixed fraction of the
window: it is 69.3% at 1 MiB, 38.7% at 512 KiB, and *negative* (the host throws
`TargetPressureConfigError`) below ~314 KiB with a 256k output reserve. Any constant
fraction of the window therefore lands on the wrong side of the wall in one of those
regimes — which is exactly what happened with the old emergency line at `0.85W`
(891,289, permanently later than 727,040). The presets set the reminder line to 50% of
the wall, and `status` reports the wall, the distance to it, and the emergency line so
the relationship is visible rather than inferred.

**Why half and not more.** The reminder costs tokens itself, and the close-out is a
real amount of work — writing two documents and rebuilding an anchor. Measured on a
real session, a close-out consumes 12,000–40,000 tokens. Firing it too early
interrupts useful work; firing it too late leaves no room to finish before compaction.
Half the wall leaves the same amount of room again for the close-out, on every window
size.

Anthropic's
[context-engineering guidance](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
describes recall accuracy degrading as the context fills — a performance gradient,
not a cliff — and recommends curating the smallest high-signal token set. Together
these argue for closing out earlier rather than later, which is why this default is
not pushed up toward the compaction line to "save window".

**Why it moved down from 40%.** The earlier figure assumed the harness reserved
393,216 output tokens, putting its trigger at 541,248. The effective request sends
`maxTokens: 256000`, so the real trigger is
`min(W × 0.8, W − 256000 − 65536) = 678,464` (67.8%). A 40% line left 278,000
tokens of unused budget between the reminder and the compaction.

**Relationship to the harness's own threshold.** DSH's automatic compaction fires
at the smaller of `thresholdRatio × W` and `W − outputReservation − headroomTokens`
— 678,464 tokens on this configuration, not the 541,248 that the declared 393,216
output cap would imply. The reminder line must stay **below** it, with enough room
left to complete the close-out. If it does not, history is compacted first and the
reminder never arrives at all — silently, because nothing errors.
`stage_handoff(action="status")` warns when the line exceeds 85% of that wall (or when
the wall does not exist at all, in which case the host throws instead of compacting),
when `notifyRepeatDelta` or `compactRetainTokens` exceeds the whole window, and when
`anchorLimitChars` is outside a useful operating range. The presets keep every
shipped window size at half the wall, which is well under the warning boundary.

## `notifyRepeatDelta`

| | |
| --- | --- |
| Type | positive integer, or a human string (`25k`, `1m`) |
| Default | `25000` |

After a reminder fires, the context must grow by at least this much before another
one is injected. Prevents a reminder on every single step once the threshold has
been crossed.

Falling back below `notifyTokens` clears the throttle, so the next crossing fires
immediately — which is what you want after a compaction.

## `notifyCooldownMs`

| | |
| --- | --- |
| Type | non-negative integer |
| Default | `300000` (5 minutes) |

Minimum **wall-clock** time between two reminders. Combined with `notifyRepeatDelta` as
an AND: both the growth and the elapsed time must be satisfied.

**Why both gates exist.** `notifyRepeatDelta` measures volume, not pace. A busy stretch —
writing code, reading large files, running tests — can cross 25,000 tokens in a minute or
two. Real use produced two reminders five minutes apart, purely because the agent was
working fast. The delta gate cannot see that; the time gate can.

**Why 5 minutes and not 10.** 10 minutes was the original value, set after that same
observation. But an over-long gate has the opposite failure mode: heavy work can add
100,000+ tokens in ten minutes, stepping straight over the reminder window and into
compaction without ever asking for a close-out. `notifyOnTurnStartOnly` already
throttles to turn boundaries, so the time gate does not need to carry the whole load.

`0` disables the time gate and returns to growth-only behaviour.

A drop below the threshold clears the record entirely, so the time gate never blocks the
first reminder after a compaction.

## `notifyOnTurnStartOnly`

| | |
| --- | --- |
| Type | boolean |
| Default | `true` |

Only consider the reminder on the **first step of a turn** (`payload.step === 1`),
instead of on every step.

**Why this is the default.** `agent/pre-step` fires on every step, and
`notifyRepeatDelta` alone is not enough of a gate: in a long session, reading two
files and running one command can add 25k tokens. Measured on a real session, the
reminder fired twice within five minutes at 60% context. A turn boundary is a
natural throttle, and closing out at the end of a turn is easier to act on than
closing out halfway through one.

If `payload.step` is unreadable, the plugin falls back to the per-step behaviour
rather than never reminding.

Set it to `false` to restore the per-step gate, guarded only by
`notifyRepeatDelta`.

## `notifySkipWhenToolPending`

| | |
| --- | --- |
| Type | boolean |
| Default | `true` |

Skip the reminder while a tool call is still waiting for its result.

**Why.** A reminder inserted while the agent is mid-call either lands on the next
step (too late to change what it is doing) or interrupts half an action. Neither
helps. Skipping does **not** consume the reminder quota: `lastNotified` is only
written when a reminder is actually injected, so once the turn completes and the
session is still over the line, the reminder fires as usual.

## `notifyAfterCompaction`

| | |
| --- | --- |
| Type | boolean |
| Default | `true` |

Inject one notice at the first `pre-step` after a **successful** compaction,
telling the model to read the current stage's `anchor.md` and detail document
before continuing, and to confirm that a summarised `Next Step` was not already
completed.

**Why.** The summarizer never receives the verbatim tail that compaction keeps; it
is shown only the span it replaces, yet it is asked to write `Current Work` and
`Next Step`. After a compaction the model therefore holds two conflicting accounts
of the same moment — the summary's next step, and the retained history in which
that step already ran. Measured on a real session, this produced a 16,269-token
output of repeated "do it" with a single tool call at the end. The full evidence is
in the repository's internal measurement notes (not shipped in the package).

The notice is gated by `compaction/end` **without** an `error`, so a failed
compaction — which produced nothing that could mislead the model — does not fire
it. It does not consume the reminder quota and does not write `lastNotified`: it is
bound to the moment a compaction happened, not to context pressure. A non-`enter`
decision leaves the flag set, so the notice lands on the next entering step instead
of being silently dropped.

Set it to `false` if you drive compactions yourself and always follow them with an
explicit instruction.

## `anchorRoot`

| | |
| --- | --- |
| Type | non-empty string |
| Default | `docs/anchors` |

Where stage folders live. A **relative** path is resolved against the *calling
agent's workspace* (`agent.session.header.cwd`), not the host process's working
directory — the two differ under `dsh web`, where the host cwd is a `workspace`
subdirectory while the agent's project root is the session cwd. Using the host cwd
would silently point the anchor directory at a path that does not exist. An
absolute path is taken as-is, which is what you want if several projects should
share one anchor directory.

A root that **starts with a bare separator** (`/docs/anchors`) counts as absolute. On
POSIX that is what it looks like; on Windows it resolves to the current **drive root**
(`D:\docs\anchors`) rather than the workspace, and it skips the workspace containment
check because absolute roots are allowed by design. `scaffold`'s receipt shows the
resolved `stageDir`, so the first use makes it visible. For a workspace-relative root
write `docs/anchors`; for a shared one write a full `D:\...` path. The resolution is
pinned by `test/index.test.mjs` and described in `docs/SECURITY.md`.

`scaffold` refuses a filesystem/UNC-share root, the Windows system directory, or
an `anchorRoot` that is itself a symlink/junction. One narrow exception: when the
**workspace** is a junction, the nearest existing ancestor of a relative root *is* that
junction, and the realpath containment check below decides whether the target stays
inside the workspace — refusing it would make the first `scaffold` fail in an otherwise
valid setup. A relative root must remain inside the calling workspace after realpath
resolution. Usage/cleanup/find-session reads also use `lstat` and skip linked directory
entries.

Leading and trailing whitespace is trimmed, and the schema performs that trim too: both
boundaries call the same `normalizeAnchorRoot`, so no value can be accepted by one and
rejected by the other. Before this was shared, `"docs/.. "` passed validation and was
then dropped by the resolver — anchors silently went to the default directory.

The anchor files themselves are created by `action="scaffold"` (once, for a new
stage directory) and edited afterwards by the agent's own file tools. `recall`,
`reconcile`, `validate`, `guard`, and scaffold's previous-anchor archive all share
one bounded read layer: root/stage/file links are rejected, the leaf must be a
regular file with link count one, real paths must stay inside the canonical root,
and a single read is capped at 1 MiB.

## `anchorTimeZone`

| | |
| --- | --- |
| Type | `local` / `utc` / `z` / a UTC offset such as `+8`, `-5`, `+05:30`, `+0530`, or integer minutes in `-720..840` written as `-300` |
| Default | `local` |

Which clock `action="scaffold"` uses when naming a stage directory.

`local` is the machine's own time — the same clock you see in your file manager, so
a directory listing and your calendar agree. `utc` suits cross-timezone
collaboration and people who change timezones often: with `local`, two directories
created in different timezones can sort out of order, and a DST jump can repeat an
hour.

The timestamp is always taken **when `scaffold` is called**, never when the
reminder fired — a close-out routinely happens well after the reminder, so a
reminder-time stamp would disagree with the directory's actual creation time.

Offsets accept `+8`, `-5`, `+0530` and `+05:30`, bounded to UTC-12..UTC+14.
Boundary zones cannot carry nonzero minutes: `+14:01` and `-12:01` are invalid.
The length carries the meaning, so the two spellings cannot collide: one or two
digits (`+8`, `-5`) are hours, `+05:30` and `+0530` are clock offsets, and a bare
three-digit value (`-300`, `-720`) is minutes. IANA zone names are deliberately
not supported: a fixed offset has no DST ambiguity and needs no timezone
database. The settings panel presents this as a **dropdown**: `local`, `utc`,
every whole-hour offset from UTC−12 to UTC+14, plus UTC+05:30 and UTC+09:30. A
selection is stored as **minutes**, never re-read as `-3:00`; a YAML value outside
the list (for example `+00:20`) shows up as `当前值` and is left untouched rather
than being replaced by the first option. The text forms above remain valid in
`cordis.patch.yml`.

## `anchorLimitChars`

| | |
| --- | --- |
| Type | positive integer |
| Default | `8000` |

Soft limit, mentioned in the reminder, for `anchor.md`. Above it the policy says to
archive the current anchor into `parent-backup/` and rewrite a shorter one.

Nothing enforces this. It is a line in the reminder text precisely because a
truncated anchor is worse than a large one.

## `compactRetainTokens`

| | |
| --- | --- |
| Type | positive integer, or a human string (`100k`, `1m`) |
| Default | `32000` |

Tail budget kept **verbatim** during compaction.

The completion message reports both the requested budget and the actual retained
tail; node boundaries are indivisible, so the actual amount can exceed the budget.
It is an **upper bound on what is available to retain, not a guarantee** of what is
retained: reasoning blocks judged degenerate are dropped from the tail entirely (see
"Degenerate reasoning is dropped" below), so the actual amount can also come in well
under budget.

**Where the default comes from.** It is a measured value, not a ratio copied from the
backend. The earlier default of 97,085 was `0.16 × 606,784`, derived from a 393,216
output reservation. The effective request sends `maxTokens: 256000`, so the
automatic path actually keeps `0.16 × 744,000 = 119,040` — the two were never equal,
and the "keeps as much as automatic compaction would" premise did not hold.

The larger issue is that 97,085 was too big on its own. Both figures are heuristic
prices: the meter bills four characters per token, while Chinese text runs closer to
1.5–1.8, so a nominal 97,085 retained roughly 160,000 real tokens. On a real session
that produced a 179,155-token post-compaction context in which 53% of the retained
tail was raw `tool/result` output; two turns later the model emitted a 16,269-token
loop of repeated "do it". A manual `/compact` — which keeps nothing verbatim — landed
at 24,376 tokens and recovered immediately.

CompactionBench's retention sweep points the same way: a 40K summary cap with a 20K
verbatim tail scored 85.81, while a 60K tail scored 68.36. **Keeping more tail is
worse**, because the summary's stale `Next Step` has more retained history to
contradict. 32,000 lands around 50,000 real tokens in mixed Chinese content, inside
the 20K–40K band that sweep favours.

Tuning guidance:

| Value | Effect |
| --- | --- |
| per-call `retainTokens: 0` | Reproduces the manual `/compact` behaviour for that one action — the least retained, and the least contradiction. The persistent configuration must be positive. |
| `8000`–`16000` | Small windows (under 256k), or stages that are mostly summarized anyway. |
| `32000` (default) | Roughly one stage of recent work; matches the presets at every window size. |
| `80000`–`97085` | The old default. Retains enough raw tool output that a stale summary step often contradicts it. |
| above the message budget | No compaction happens; the plugin reports "no compactable range" rather than failing. |

The value is capped by what is actually compactable: if the whole surface fits in
the retention budget, there is nothing to compact and the plugin says so instead of
doing something surprising. That result is an explicit `no-op`, not a failed
attempt: it does not create a pending failure notice and does not enter exponential
backoff.

### Degenerate reasoning is dropped

A retained loop is a self-reinforcing example. Measured on one session: a `/compact` that
stopped a 19,211-character repetition left that block outside its shadowed range, the
post-compaction context was more than half repetition, and six turns later a single block
reached 65,928 characters.

So a block that is degenerate **on its own** — and whose turn is already judged suspicious —
is pushed into the shadowed range instead of being retained. The summarizer still reads it
there; only the verbatim copy disappears. If the newest node is itself the loop, the retained
tail becomes empty, which is deliberate: a summary alone is better than keeping tens of
thousands of characters of filler as the newest example.

Both the completion message and `status` report how many blocks were dropped, so a retained
count that comes in low is never mistaken for a setting that did not apply. Measured over
245 session logs / 41,316 reasoning blocks: 2.31 % are degenerate on their own, and 826 of
the 2,592 blocks inside the 137 suspicious turns are dropped (31.9 %).

## `hostMaxTokens`

| | |
| --- | --- |
| Type | positive integer, a human string (`256k`, `1m`), or `auto` |
| Default | `256000` |

Tokens the host model reserves for one turn's output. It is **not** this plugin's
budget — it is the input to the harness compaction wall:

```
wall = floor(min(window × 0.8, window − hostMaxTokens − 65,536))
        ← but only if retainTokens < wall, see below
```

**`256,000` is decimal 256K, not 262,144.** That is the part that looks wrong when you
try to check the arithmetic by hand: the context window is a power of two
(1,048,576) while the output cap is decimal (`256e3`, from `DEFAULT_MAX_TOKENS` in the
DeepSeek adapter). Subtracting them is what produces a wall of 727,040 rather than a
round number. Nothing is mistyped.

**There is a second constraint on the same wall.** `resolveCompactSpec` also requires
`retainTokens < thresholdTokens`, where `retainTokens = floor((window − hostMaxTokens) × 0.16)`.
On narrow windows that check fires *before* the pressure-budget check: at
`window = 321,537` the pressure budget is exactly 1, so the formula yields a wall of 1,
while `retainTokens` is 10,485 — the harness throws. `status` reports such a
configuration as "wall does not exist" rather than printing `1 tokens`.

**`auto` asks the host instead of trusting this number.** Resolution order, first hit
wins:

1. `agent.options.maxTokens` — the per-request output cap the host has already settled
   on (route fallback and explicit overrides land here);
2. `llm.resolveModelInfo(provider, model).defaultMaxTokens` — what the adapter declares
   for that model (`dsh-llm-deepseek` declares `256e3`);
3. `256000` — the built-in default, used with an explanatory `status` line when neither
   of the above is available.

Answers are cached per `provider/model`, so the lookup runs once per model rather than
on every pre-step. **The plugin still needs `provider` and `model` from the agent** —
when they are missing (or the host exposes no `llm` service) it falls back to 256,000
and `status` says which of the three sources was used:

```
输出预留 hostMaxTokens 256,000（model deepseek/chat 的 defaultMaxTokens）
输出预留 hostMaxTokens 256,000（default（llm 服务不可用））
```

`0.8`, `65,536` and `0.16` are the harness defaults for `thresholdRatio`,
`headroomTokens` and `retainRatio`; all three can be overridden by the compaction
plugin's own config or by `modelPolicies` per provider/model, and this plugin cannot
see those. So the wall computed here is exact only while the host uses the defaults —
when the reserve varies, only that term does, which is why it is the one exposed as a
key. The reserve itself comes from the request header's `maxTokens` (the output cap the
adapter or connection configures for that model), **not** from the model's
`policies.maxTokens`.

**Change this when you change models.** The value drives three things: the emergency
compaction line (`wall × 0.9`), the warning threshold for an unreachable reminder line
(`wall × 0.85`), and the numbers `status` reports. If the model reserves a different
amount and this key still says 256,000, every derived line drifts by the difference.

**Below roughly 314 KiB the window cannot be compacted at all** with the default
reserve, because the pressure budget goes negative and the harness throws
`TargetPressureConfigError`. Lowering this key is how you make such a window usable:
a 256k window needs it below 196,608 (`262,144 − 65,536`), which puts the wall at
65,536 and the preset reminder line at 32,768 when you use the model's actual output
cap of 131,072. `status` says so explicitly instead of reporting a reminder line that
can never fire.

The settings panel shows this key with three one-click fills (256k / 128k / 64k) and a
⚠ badge next to the description — the badge is the only place a wrong value is called
out, because the panel cannot see the window size and therefore cannot compute the
wall itself.

## `compactCooldownMs`

| | |
| --- | --- |
| Type | non-negative integer (milliseconds) |
| Default | `60000` |

Minimum interval between two successful compactions **in the same session**. `0`
disables the success cooldown.

**Why it exists.** Every compaction costs one summarizer call and rewrites history.
A loop that calls `compact` repeatedly — a retry storm, a misconfigured agent — both
burns quota and can leave the session compacted into uselessness. The cooldown
refuses the second call *before* the engine is touched, so a storm costs nothing.

The same per-session gate also covers the queued `/compact` fallback. Failed
attempts use exponential backoff starting at five seconds (up to 15 minutes), even
when the success cooldown is `0`; `status` reports the remaining delay and last
failure reason. A failed attempt does not permanently lock the plugin, though the
Host can still report an unmatched compaction lock if its own closing event could
not be persisted.

The success gate stores the timestamp of the successful compaction, not a frozen
deadline. Changing `compactCooldownMs` updates the remaining interval immediately;
setting it to `0` clears an existing success cooldown without waiting for the old
value to expire. Failure backoff remains independent.

Set it to `0` only if you are driving compactions from your own scheduler and have a
reason to compact twice within a minute.

## `agentDecidesCompaction`

| | |
| --- | --- |
| Type | boolean |
| Default | `true` |

Whether the **agent** decides when to compact, or the plugin does it on its own.

- `true` — the plugin reminds, and compaction happens when the agent calls
  `stage_handoff(action="compact")` after closing out the stage.
- `false` — once usage crosses `notifyTokens` and a close-out reminder has reached
  the model, the plugin compacts at the serial `agent/turn-stopping` boundary
  before `turn/end`. This keeps the Host's required current-turn owner while
  preventing the next step from appending surface nodes during summarization.

**The reminder is sent either way.** Compaction frees space; it does not produce
conclusions. Writing the anchor is still the agent's job, and on `false` the agent
gets the reminder and the freed space at the same time.

**The tradeoff in one line:** `false` makes compaction happen without waiting for
the agent to call `compact`, but can summarise details the agent had not written
down yet; `true` leaves that decision — and that risk — with the agent.
`compactCooldownMs` applies to both paths, so automatic mode cannot compact twice
in a row. A threshold crossed after the last pre-step waits for the next turn's
reminder instead of compacting first.

If the host still reports `surface changed during summarization`, the failure is
shown in the next reminder/failure-only notice, the reminder quota is not consumed,
and the next turn-stopping retries immediately. Other failures enter the normal
visible backoff.

## `streamGuard`

| | |
| --- | --- |
| Type | boolean |
| Default | `true` |

**Experimental.** Watches the reasoning tail while it is still being generated,
instead of waiting for the step to land.

When on, the plugin subscribes to `agent/assistant-stream`, accumulates
`{type:'reasoning-delta'}` text for the current step, and runs two criteria over the
last 4,096 characters every 24 deltas (plus once more when the step ends):

1. **Strict period** — the same fragment repeats consecutively **5 or more times**
   covering **at least 200 characters**. This gives an exact period and span.
2. **Row repetition** — one prose row repeats **10 or more times** and covers **at
   least half** of the window's rows, in a window of **at least 20 prose rows**. This
   catches the far more common shape where a main period is interrupted by periodic
   insertions:

   ```
   好。 好。 好。 好。 （输出） 好。 好。 好。 好。 （好） 好。 好。 好。
   ```

   Criterion 1 returns `null` on that text — each insertion resets the strict match —
   while the row count is plainly visible. Measured on `session-bbb00002` turn 60: ten
   blocks, rows repeated 108–176 times, 5.2–10.1σ, and criterion 1 alone fired on
   **none** of them.

   Both numbers are calibrated, not guessed. Over 239 sessions and 31,563 reasoning
   blocks, threshold 30 hit 499 blocks (1.6 %); threshold 10 with the row floor hits
   658 (2.1 %) — **32 % more real repetition**. The extra blocks sample as `Go.` ×16
   and `好。` ×23: already spinning, just not yet 30 times. The row floor of 20 is what
   makes the lower threshold safe: at threshold 8 the only non-filler top rows were
   `INFO ok` (12 rows), `return` (14 rows) and `'',` (38 rows), all short windows where
   8 of 12 identical rows is 67 %. True samples had 80 / 112 / 229 rows.

Then the next `pre-step` adds one notice — once per step, and only after that step has
ended. The notice never quotes the repeated text: writing it back into the context
re-feeds the loop.

The bar is stricter than the offline one (5 repetitions vs 3): mid-generation,
"repeated three times" is often just parallelism, and a wrong stream verdict writes
a false "you are looping" into the context.

**It reports and never truncates.** There is deliberately no "stop on detected
repetition" option. PREWARN measured windowed repetition scores firing on
79.5–100 % of long answers that human judges called non-degenerate; the only
inference framework that implements stop-on-repetition (vLLM) uses exact-period
matching, which cannot see a drifting `做。做。做。` loop in the first place.
Truncating on this criterion would cut off legitimate long tasks.

**On by default.** It only ever produces one reminder and never touches the stream, the criteria
are deliberately conservative, and a false negative costs nothing. Turn it off in the settings
panel when you want quiet.

`action="status"` prints one line saying whether the guard is on, so "off" and "on but never
triggered" stay distinguishable.

## `rejectOnRepeat`

| | |
| --- | --- |
| Type | boolean |
| Default | `false` |

**Destructive, and off by default.** When either criterion has fired with an **unrivaled** verdict,
return `{ kind: 'reject' }` from `agent/pre-step` instead of adding a reminder. Unrivaled means
either:

- the **row** criterion at a repeat ratio of **0.8 or more** — one prose row filling the entire
  reasoning window (real incidents: 0.77–0.97), or
- the **strict period** at **100 or more repeats** — real incidents ran 108–176.

Both thresholds are on the same principle: pick the point where no ordinary output explains the
shape. Note that the period criterion uses **repeat count, not span**: filler units are two
characters (`做。`, `好。`), so a genuine 108-repeat incident covers only 216 characters — a span
threshold would have missed the most typical loop entirely.

`reject` is not "skip this step". In the engine (`dsh-agent-loop/lib/index.js`) it sets
`turnEnds = { kind: 'blocked' }`: **the whole turn ends on the spot** and the user sees a blocked
turn. That is the entire reason this is off by default.

**Why it exists at all.** A reminder measured at roughly **20 % effective** — across 65 samples,
13 got cleaner, 34 were unchanged and **18 got worse** (see `docs/VALIDATION.md`). One short
sentence is a weak intervention, and `pre-step` offers exactly two levers: add messages, or reject.

**Why 0.8 and not the 0.5 detection line.** At 0.5 the samples include plenty of ordinary text.
0.8 means the window is filled by one row, which is the shape the real incidents had (0.77–0.97).

**What it cannot do.** Intervening *inside* a step is structurally impossible:
`agent/assistant-stream` is `(payload: { agent, frame }): void`. `startsRequestSeries` does not
help either — it only marks series boundaries for caching and billing, and never changes the text
the model sees.

## `keepAnchorBackups`

| | |
| --- | --- |
| Type | non-negative integer |
| Default | `3` |

How many of the newest `parent-backup/anchor-*.md` files `action="cleanup"` treats as
"keep". It only affects the **candidate list**; the plugin never deletes anything.

Ordering is by the numeric timestamp in the file name, not modification time. A
name survives a disk copy or restore while `mtime` does not. Names such as
`anchor-random.md` remain visible under “unknown naming” but are never candidates,
because the plugin cannot prove which one is newest.

Set it to `0` to list every timestamped backup as a candidate. The files still stay
on disk, and unknown names remain outside the candidate list.

## `guardMaxBytes`

| | |
| --- | --- |
| Type | integer, 65,536–16,777,216 |
| Default | `1048576` (1 MiB) |

The size ceiling for `.anchor-guard.json`, checked on **both** write and read. The
default equals the safe-read limit for anchor files, so a baseline can never be
written that the reader then refuses — an earlier version had no write-side check
and a 1 MiB read cap, which turned into a self-lock: `validate` reported “baseline
unreadable” and told the user to re-run `guard`, and re-running only wrote another
oversized file.

Raise it only if a legitimately large anchor must be guarded. A larger baseline
widens the bounded-read guarantee, and the settings field says so. The usual signal
is that the anchor should be trimmed instead.

## `staleReservationTtlMs`

| | |
| --- | --- |
| Type | integer, 60,000–604,800,000 |
| Default | `86400000` (1 day) |

How long a scaffold reservation sidecar stays authoritative. The sidecar records the
PID publishing a stage directory; when the process dies between `mkdir` and `rename`,
the PID alone cannot prove ownership (PIDs are reused quickly on Windows/WSL), so a
reservation older than this is treated as stale and reclaimed by the next `scaffold`.
Without it, the same minute-and-topic stage could never be rebuilt.

A shorter value reclaims abandoned stages sooner but can mistake a genuinely running
long task for a dead one; a longer value keeps the stage name blocked longer after a
crash.

## `dshHome`

| | |
| --- | --- |
| Type | string (**absolute** path, or empty) |
| Default | `''` (empty) |

DSH data root, used only to locate `sessions/` for `action="usage", scope="sessions"`.
Leave it empty to read the `DSH_HOME` environment variable; if neither is set, that
scope reports "cannot locate" rather than guessing a path. A **relative** path is
rejected: the field falls back to the default and is reported as a degraded field,
because a relative root would silently resolve against an unpredictable cwd. Both the
Host schema and the parser enforce that, so a relative value is refused at the form
layer too instead of being accepted by the schema and then dropped field-by-field.

The plugin reads only file **sizes** under `<dshHome>/sessions/<cwd-key>/<session-id>/`,
never session contents. See [PRIVACY.md](PRIVACY.md).

## `reportToolFacts`

| | |
| --- | --- |
| Type | boolean |
| Default | `true` |

When on, `action="status"` and `action="scaffold"` derive, from the session's own
`tool/call` events, which files were touched and which shell commands were run, and
print the file facts:

```
工具轨迹: 碰过 12 个文件、跑过 7 条命令（机械推导，供锚点'关键入口'参考）
```

**Why derive instead of asking the model:** Cline's `extractFileOps` does the same for its
`## Files` section — fields that can be mechanically derived from tool calls should not be
left to the model to narrate, because **the model forgets and the code does not**. The
anchor's `## Entry points` section has the same problem: rather than trusting the agent to
remember which files it edited, the plugin shows it the facts and lets it choose.

**What it does and does not do:** it only *reports*. It reads `tool/call` event arguments
(a JSON string), extracts paths from `path` / `file_path` / `filePath` / `file` / `target` /
`paths` / `files` and commands from `command` / `cmd`, de-duplicates, and stops at the newest
5,000 events. Unparseable arguments are skipped, never guessed at. Nothing is written, no
model is called, and the derived list is never injected into the conversation — it appears
only in `status` / `scaffold` output.

Turn it off if the extra lines are noise. Derivation itself is read-only and deterministic.
The flag controls **display**, not event observation: summary readback, tool-pending
gating, coverage accounting, and the bounded in-memory ring continue to work so those
features do not silently degrade when the display option is off.

The ring keeps at most 5,000 compact facts after its 10,000-event compaction point,
caps summary text at 65,536 UTF-16 code units (the constant counts code units, not
bytes — roughly 192 KiB of CJK text), and trims the oldest facts until the entire
per-session ring fits a 2 MiB byte budget. Once either count or byte trimming occurs,
every reader reports `partial-truncated` permanently for that session. A plugin mounted
into an existing session reports `partial-since-mount`; it never calls that window the
complete log. Tool-fact derivation scans the newest 5,000 events, so a longer session
reports `partial-window` instead of claiming a whole-session scan.

The walk is streaming and bounded to 200 sessions / three seconds. Missing roots,
permission errors, linked directories, and partial results are reported distinctly;
an unreadable tree is never presented as an exact total.

## Choosing values together

A worked example for a 200k-token model window. Note that a 200k window **cannot** be
compacted with the default 256k output reserve at all (`200,000 − 256,000 − 65,536 < 0`),
so this example lowers `hostMaxTokens` first — that is the whole point of the key:

```yaml
- id: stage-handoff
  config:
    hostMaxTokens: 65536        # wall = 200,000 − 65,536 − 65,536 = 68,928
    notifyTokens: 34000         # half of that wall
    compactRetainTokens: 6400   # ~3.2% of the window kept verbatim ≈ 10k real tokens in Chinese
    anchorLimitChars: 5000      # anchors must be tighter
```

The reminder leaves half the wall — about 34,900 tokens here — for the close-out and
the next steps, and the compaction leaves a verbatim tail worth roughly one stage of
recent work, plus the system prompt and tool definitions.

The tail does not scale below usefulness in practice: 6,400 heuristic tokens is about
10,000 real tokens of mixed Chinese content, which is still more than one recent
exchange with its tool output. If a stage is unusually tool-heavy, raise it rather
than raising the reminder line — a bigger tail is cheaper than a bigger window.

## If the model starts looping

A session can degenerate into `好。做。好。做。` reasoning. Measured across 40
sessions and 1,704 turns, this happens in 0.8% of turns before a session's first
compaction and 8.2% after — but it does **not** track context size. One session ran
452k tokens with clean reasoning while another looped at 114k, and 74% of looping
turns sat under 5k tokens (73% of clean turns did too).

So `notifyTokens` and `compactRetainTokens` are not the levers: they decide when to
compact and how much tail to keep, and the loop is indifferent to both. What does
move it:

- **A stronger model.** One `deepseek-v4-pro` session ran 26 compactions across 390
  turns with 1% looping turns; a `deepseek-flash` session hit 56%.
- **Shorter turns.** 46% of looping turns had 15+ steps versus 30% of clean ones.
  Handing control back between stages is cheaper than any config change.
- **Not spinning while a task finishes.** Turns that polled `job_output` were 25%
  of looping turns versus 14% of clean ones. End the turn and let the completion
  event wake you.

The plugin can only warn: `stage_handoff(action="compact")` snapshots the reasoning
shape before compacting and reports it, and `stage_handoff(action="status")` carries
the same `思考复读:` line. See `docs/VALIDATION.md` for the measurements.
