# Contributing

Thanks for looking. This is a small plugin with a deliberately narrow job, so most of
the guidance below is about **not** widening it by accident.

## Three hard constraints

These are not preferences. A pull request that breaks one of them will not be merged.

### 1. No build step

Everything under `lib/` runs as-is: plain ESM JavaScript with `// @ts-check` on top.
There is no `dist/`, no bundler, no transpile step, and `npm pack` ships the source
files you wrote.

The client plugin (`lib/client.js`) obeys this too. It is a plain script that calls
`window.__ModuleLoader__.load({ id, factory })` and takes React from the host's module
loader, so it needs no build even though it renders React.

**Why:** a build step means every contributor needs a toolchain and every release can
differ from the source in ways review cannot see. `tsc --noEmit` gives us the type
safety without producing a second copy of the code.

### 2. No runtime dependencies

`dependencies` stays empty. `devDependencies` (`@types/node`, `typescript`) are for
type checking only and never ship.

Node built-ins are fine — `node:path`, `node:fs/promises`, `node:crypto` and friends.

**Why:** installing this plugin takes about 800 ms and pulls exactly one package.
That is the entire installation cost, and it should stay that way.

### 3. Tests run offline, with no harness

`npm test` must pass with no DSH install, no network and no API key. The suite drives
`apply()` against a fake context, so every behaviour worth having is reachable from a
plain Node process.

If a change can only be tested against a live harness, that is a signal the change is
doing too much — or that the fake context needs to grow.

## Before you open a pull request

```sh
npm ci            # then confirm node_modules matches what the lock file says
npm run check     # tsc --noEmit && node --test
npm pack --dry-run
```

All three must be clean. `npm run check` is the same pair of steps CI runs.

If you touch the packaging — `files`, `exports`, `dsh.client`, or anything in `lib/` —
also run the structural check, which `npm run check` does **not** cover:

```powershell
tools\Pack.ps1
tools\Test-Package.ps1
```

That script is PowerShell and Windows-only; CI therefore cannot run it. See
[docs/VALIDATION.md](docs/VALIDATION.md) for what CI does and does not cover.

## What needs a test

Add a test when you change:

- configuration parsing or validation — `test/index.test.mjs`
- the reminder text or when it fires
- range selection, open-turn protection, or anything that decides what gets compacted
- the compaction call, the cooldown, or automatic mode
- the client entry's shape (there are static contract tests for this)
- filesystem behaviour — `test/usage.test.mjs`, `test/cleanup.test.mjs`

Documentation-only changes need no test, except that every relative link must resolve;
`test/links.test.mjs` enforces that.

## Documentation you must update

A behaviour change is not finished until these agree with the code:

| File | Update when |
| --- | --- |
| `CHANGELOG.md` | always, under the unreleased version |
| `README.en.md` and `README.zh-CN.md` | user-visible behaviour, configuration, or the test count |
| `docs/CONFIGURATION.md` | a configuration key is added, removed, or changes meaning |
| `docs/SECURITY.md` | an attack surface changes state — including "we decided not to fix this" |
| `docs/VALIDATION.md` | a new kind of verification exists, or a claim becomes verified |

The two READMEs are meant to say the same things in different languages. A change to
one is a change to both.

## Code style

- Comments explain **why**, not what. A comment restating the code gets deleted.
- Keep Chinese and English as they are per file: `lib/` comments and model-facing
  strings are Chinese, repository documentation is English. Do not translate
  model-facing text without a reason — the reminder is read by a model, and its
  wording has been measured.
- Prefer a small module with one job over a large one with several. `lib/usage.js` and
  `lib/cleanup.js` exist because they touch the filesystem and everything else does
  not; that separation is the point.
- No `any`, no `@ts-ignore`. If the types fight you, the code is usually wrong.

## Things this plugin deliberately does not do

Please do not add them without opening an issue first.

- **Delete files.** `cleanup` reports candidates and stops. Deletion is irreversible
  and this plugin cannot know whether another stage still needs a record.
- **Replace the compaction backend.** It calls `compactRegion` on the engine DSH
  already runs. Forking the backend buys control at the cost of re-verifying every
  DSH upgrade.
- **Read anchor content.** `docs/PRIVACY.md` lists exactly what is read. Reading
  anchors would be a privacy change, not a feature.
- **Write anchors.** The agent writes them with its normal file tools. That boundary
  is why the injection surface is *stated* rather than fixed.

## Reporting a security issue

Do not open a public issue for a vulnerability. See
[docs/SECURITY.md](docs/SECURITY.md) for the attack surfaces this plugin considers and
the current state of each.
