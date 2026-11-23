# dsh-stage-handoff

Close out the stage **before** the context is compacted, and hand the next stage a **file** instead of a summary.

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

| Language | Document |
| --- | --- |
| English | [README.en.md](README.en.md) |
| 简体中文 | [README.zh-CN.md](README.zh-CN.md) |

---

- [Architecture notes](docs/ARCHITECTURE.md) — how the compaction engine is reached
- [Anchor policy](docs/ANCHOR-POLICY.md) — the stage close-out procedure
- [Configuration](docs/CONFIGURATION.md) — every key and its default
- [Privacy](docs/PRIVACY.md) — what this plugin reads and writes
- [Feedback: injected messages cannot be removed](docs/FEEDBACK-injected-messages-cannot-be-removed.md) — why a reminder stays in the log and the summary
- [Security](docs/SECURITY.md) — six attack surfaces and what is actually mitigated
- [Validation](docs/VALIDATION.md) — what is verified, and what is explicitly not
- [Contributing](CONTRIBUTING.md) — three hard constraints before you change anything
- [Releasing](docs/RELEASING.md) — pack, verify, publish

MIT licensed. See [LICENSE](LICENSE).
