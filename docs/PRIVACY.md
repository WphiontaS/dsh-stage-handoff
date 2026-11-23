# Privacy

One sentence: **this plugin makes no outbound network request.** It exposes one
authenticated read-only usage route on DSH's existing local connection, reads
session metadata, and writes a scaffold into a directory you configure.

## What it reads

| Data | Used for | Stored? |
| --- | --- | --- |
| `ctx.tokenMeter.measure(session)` → `totalTokens`, `nodes[].tokens` | deciding whether the threshold is crossed, and picking a compaction range | no — memory only |
| `session.surface.nodes` (a list of sequence numbers) | matching the priced nodes to the current surface | no |
| `agents.turnBoundaryOf(session)` | reading the Host-maintained open-turn projection | no |
| `session/event` committed events | maintaining a bounded in-memory window for pending-tool detection, recent tool paths/commands, the newest summary, and the shape of each reasoning block | no — the derived window is memory-only and disappears with the process |
| `assistant/message` reasoning text | measuring degeneration: the repetition scan reads the reasoning body of each step to count short lines, repeated lines and their character share. Only those integers are kept — no reasoning text enters the ring, and none of it is written to disk | no — extracted, measured, discarded |
| The plugin's own `sessionProjections` unit | remembering surface seq/type/checkpoint structure so compaction can prove the system head and open-turn cut | **host projection cache may persist it**: seq, event type and a checkpoint boolean; no message, tool-argument or summary text |
| `<anchorRoot>/<stage>/anchor.md` and the stage's `.anchor-guard.json` — only for `recall`, `reconcile`, `validate`, `guard`, and scaffold's previous-anchor archive | returning requested anchor lines, checking structure, and comparing guarded signatures | no; each read is bounded to 1 MiB and all links/extra hard links are rejected |
| Directory names and **file sizes** under `<anchorRoot>` — only when the model calls `usage` | reporting anchor-directory size | no |
| Directory names and **file sizes** under `<dshHome>/sessions/` — only when the model calls `usage` with `scope` `sessions` or `all` | reporting per-session disk usage | no |
| Encoded session-directory names and contained file names/sizes — only when the model calls `find-session` | locating one requested session log | no |
| The opt-in pre-step diagnostic file named by `DSH_STAGE_HANDOFF_PRESTEP_LOG` — only for `status` and the plugin's own instance diagnostics | proving whether the hook fired, which instance ran it, and which G2 branch was reached | yes, only when explicitly enabled; bounded to 256 KiB plus one rotated `.1` |

**Never read from disk:** tool results, attachment content, credential files,
environment variables other than `DSH_HOME`, the explicit
`DSH_STAGE_HANDOFF_PRESTEP_LOG` opt-in, `SystemRoot` (read only to refuse creating
a stage inside the Windows system directory), other sessions' log files, or any
unrelated file's contents. Anchor tools read only the selected stage's fixed
`anchor.md` / `.anchor-guard.json` artifacts through the safe-read layer; they do
not recursively read `detail/` or `parent-backup/`. The host-scoped `session/event`
subscription may receive committed events for multiple live sessions and keeps a
separate WeakMap entry for each; a tool result only reads the calling session's
entry. The plugin parses `tool/call` argument strings delivered in that feed to
extract paths and commands, and it reads a summary body only to render
`action="summary"`; both stay in the bounded in-memory window above.

**The one place a log file is opened is described under the next heading** — it is
narrow (the calling session only, one event type, a hard byte cap) but it *is* a
read, and older versions of this document claimed it never happened.

**One disclosure.** `stage_handoff(action="summary")` returns the **body of the most
recent `compaction/summary` event** to the model. That summary is itself derived from
conversation content — a summarizer wrote it from messages the plugin never reads
directly. It is shown on request and never transmitted.

**The log fallback.** The in-memory ring only covers events observed since the plugin
mounted, so after a restart it normally has no summary at all. When — and only when —
the ring's coverage is incomplete or its read errored, `summary` and `reconcile` fall
back to opening **the calling session's own log file**:

| Bound | Value |
| --- | --- |
| Path | `<dshHome>/sessions/<encoded-cwd>/<sessionId>/`, the newest `*.jsonl.zstd` in that directory |
| Whose session | the one that called the tool; the ID is taken from the live session object, never from an argument |
| When | the ring reports incomplete coverage **or** a read error — not on every call, and not when coverage is complete yet the session simply never compacted |
| Bytes read | `SESSION_LOG_MAX_BYTES` = 64 MiB, checked by `lstat` before opening and again while reading |
| What is kept | only the lines containing `compaction/summary`, decompressed in memory; the decompressed buffer is not written anywhere |
| What comes back | the summary text, its `shadowedRange`, `shadowedTokenCount`, and the provider/model that wrote it |

Consequences worth stating plainly: decompression is synchronous, so a large log makes
that one tool call slow (measured: 4.8 MiB compressed / 12.9 MB decompressed / ~100 ms
on this machine); the whole decompressed text passes through process memory even though
only one line is kept; and the returned text is the same summary content that the ring
path would have returned, i.e. derived conversation content reaching the model. Paths in
the response are shortened (`<path>/session-<id>/session.v4.jsonl.zstd`) rather than
shown in full. `action="find-session"` is the deliberate exception — it exists to report
a full path.

If the fallback also fails, the response says so and quotes the reason; it does not
silently pretend the session was never compacted.

**Anchor disclosure.** `recall` returns matching lines, `validate` returns structural
findings and short line snippets, `reconcile` returns selected anchor lines **and the
`##` section headings of the summary body it reconciled against** (the headings are
extracted so the reader can see the structure; they are summary text, not anchor text),
and `guard` stores normalized signatures plus source/status tags. These are model-visible
tool results. The plugin does not redact secrets.

**One injection path needs its own disclosure, because it happens without any tool
call.** Once `guard` has stored a baseline, the plugin checks the anchor for missing
guarded lines at every turn start. If it finds any, it injects a reminder that names
**how many** lines are missing and quotes **up to five of them, 80 characters each**.
That text goes through the host's `session.append`, so — like every reminder — it stays
on the surface and becomes input to the next compaction summary. The anchor lines it
quotes are whatever the agent wrote there. Other reminders (repetition, threshold) are
deliberately count-free and never quote the offending text; this one is the exception
because "a constraint disappeared" is only actionable if it says which one.

## What it writes

| Target | When | Content |
| --- | --- | --- |
| The next model request's `messages` array **and, through the host, the session log** | threshold crossed, a repetition verdict, a compaction, or a detected anchor drift | one reminder message, returned as `decision.messages` from `agent/pre-step`. The host appends every such message to the session log itself (`session.append('user/message', …, { surfaceOp: 'append' })`), so the reminder **stays on the surface and enters the summary input** at the next compaction — the plugin cannot replace or remove it. Mitigations: at most one per turn, no counts in the text, and it never quotes the repeated fragment. See [FEEDBACK-injected-messages-cannot-be-removed.md](FEEDBACK-injected-messages-cannot-be-removed.md) |
| `<anchorRoot>/…` | only when the agent calls `action="scaffold"` | atomically publishes one **new** stage directory with a skeleton `anchor.md` and empty `detail/`. It refuses linked/system/root targets, never overwrites an existing stage, and never edits the published file afterwards. **The skeleton is written by the plugin, not the agent**, and it contains the current **session ID** plus up to five **absolute file paths** of files this session touched (taken from `tool/call` arguments). The file lands in the working repository by default, so a plain `git add` can publish it — the same data is shortened to `<path>/two-segments` in `status` but **not** here |
| `<anchorRoot>/…` | when the agent calls its own file tools | whatever the agent decides; the plugin does not participate in those writes |
| The profile's `cordis.patch.yml` | only when a human edits a field in the settings panel | the host persists that one key's new value through `configForms.set`. The panel exposes only the `stage-handoff` namespace |
| OS clipboard | only when a human presses **Copy YAML** | a YAML block containing the current Stage Handoff configuration and no credential or unrelated plugin settings |
| The opt-in pre-step diagnostic file | when `DSH_STAGE_HANDOFF_PRESTEP_LOG` is set to an absolute path or `1` | timestamp, runtime marker, plugin instance, PID, random session reference, hook booleans, decision kind, turn/step, and G2 outcome. No message body, tool output, credential, token, or arbitrary thrown-error text. **Absolute paths are reduced to their last two segments** before writing (`D:\work\repo\docs\anchors\26…\.anchor-guard.json` → `<path>/26…/.anchor-guard.json`), so the workspace root never lands on disk |
| Host logger / fallback stderr | mount, diagnostics, compaction outcome | counts, booleans, absolute paths and status strings. No message body, tool output, or anchored document text. **Every `ctx.logger` site in `lib/index.js` funnels through `describeError`** (`redactSecrets(elidePathsIn(text)).slice(0, 300)`), so a logged error is scrubbed of credentials and of the workspace root. The unscrubbed exception is not the logger — it is the `reason` fields on tool results and the panel response: those quote `error.message` from `fs` calls (`usage.js`, `cleanup.js`) and from the diagnostic writer (`prestep-log.js`). As of this version they pass through the same `elidePathsIn` / `redactSecrets` pair, and `usage` shortens the encoded workspace key (`--D-Users-me-proj--` → `…-me-proj`) exactly as its own summary does |

The settings panel is the only path where this plugin changes host configuration, and
it requires a person to type a value and then leave the field. The host writes only
the `stage-handoff` entry in the profile patch. The schema validates values before
they are persisted, and the plugin refreshes its semantic config from the live
references after the write. Copying YAML writes only that same configuration block
to the local clipboard after an explicit button press; it does not read the
clipboard back.

## What it never does

- No outbound HTTP or socket requests and no listener of its own.
- No reading of `data/.credentials.yaml`, tokens, cookies, or API keys.
- The only route registration is the owner-authenticated, read-only
  `/api/stage-handoff/usage` endpoint on DSH's existing connection.
- No spawning of external processes or shell commands.
- No modification of `compaction-basic` configuration, `tool-result-pruner`
  configuration, or the profile manifest.
- No telemetry, no analytics, no crash reporting endpoint.

## Sensitivity of the anchor files

The anchor files are written by the agent, not by the plugin, so their content is
whatever the agent put there. In practice that means: project paths, file names,
decisions, open questions, and dead ends it tried. It can also include anything
else that appeared in the conversation.

**That is your data and your responsibility:**

- The default location is `docs/anchors/` inside the working directory.
- If that directory is inside a git repository, the anchor files will show up in
  `git status`. Consider adding `docs/anchors/` to `.gitignore` if your sessions
  touch anything you would not publish.
- The plugin performs **no content filtering, no redaction, and no secret
  scanning**. It cannot tell a file path from an API key.

A reasonable habit: keep anchors in the working repository when they describe the
work, and keep secrets out of the conversation in the first place.

## Development-only tools read more, and never ship

`tools/probes/*.mjs` exist to *check* this plugin, not to run it. One of them
(`thinking-loops`) decompresses session logs under `DSH_HOME` and reads their
reasoning text to feed the repetition scan, because that is the only way to test
the criteria against real degraded sessions. Two things bound that:

- `tools/` and `test/` are not in the npm `files` list, so an installed copy of
  this plugin contains neither. `tar -tzf` on the current artifact lists 28
  files, all of them `lib/`, `docs/`, `locale/`, `assets/` and the top-level metadata.
- The probe prints line counts, filler frequencies and character totals; the
  reasoning text itself stays in the probe's process.

Apart from the bounded fallback described above, nothing in `lib/` opens a session log
file. Everything else the running plugin knows about a session arrives through the
host's `session/event` feed.

## Retention

- The bounded recent-event window is in memory only and disappears with the process.
- The opt-in pre-step diagnostic file is bounded to 256 KiB and one rotated `.1`
  file. It is disabled unless the environment variable is explicitly set. Symlinks
  and hard links are rejected, and a tool result can only read the configured
  diagnostics path through that same link check.
- The structural surface projection may be checkpointed by DSH's normal projection
  cache. It contains only sequence numbers, event type names, and checkpoint flags.
- Per-session reminder throttling is an in-memory `WeakMap` keyed by the session
  object; it disappears when the process exits.
- `/anchor reset` clears that throttle for the current session.
