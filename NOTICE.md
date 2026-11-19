# Third-party notices

`dsh-stage-handoff` ships **no third-party runtime dependencies**. The published
tarball contains only its own JavaScript plus the licence and readme files.

At runtime it uses the Node.js standard library and the services DeepSeek
Harness already provides. Two host packages are loaded **lazily** through the
harness loader, and only when present:

| Package | Symbol used | Purpose | Licence |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-llm` | `createUserMessage` | Builds the reminder message in the shape the harness expects | BSD-3-Clause |
| `@deepseek-ai/dsh-compaction` | `toolPairingBalancedBefore` | Snaps the compaction range to a boundary that does not split a tool-call / result pair | BSD-3-Clause |

Neither package is bundled, vendored, copied or modified by this project. They
are part of DeepSeek Harness and are loaded from the user's own installation.
If either loader call fails, the plugin degrades: the reminder falls back to a
locally constructed message, and range snapping is left to the engine's own
validation.

## Development dependencies

`typescript` and `@types/node` are development-only. They are used for
`npm run check` and are **not** included in the published artifact.

Both are distributed under the Apache-2.0 licence terms of their respective
projects (TypeScript: Apache-2.0; `@types/node`: MIT).
