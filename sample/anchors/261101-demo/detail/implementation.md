# Demo stage — implementation detail

The companion to `../anchor.md`. This is where evidence lives; the anchor only
points here.

## Completed

| Item | Evidence |
| --- | --- |
| Event source adapter | `src/events/adapter.js`; 12 tests in `test/events/adapter.test.js`, all passing |
| Fallback path | `test/events/fallback.test.js` — three cases: source down, source slow, source returns a malformed payload |
| Flag plumbing | `config/default.yaml` line 14, read in `src/polling/loop.js` line 41 |

## Dead ends

- **Tried the source's batch API first.** It delivers at most one batch per 30
  seconds, which is slower than the current poll interval — abandoned.
- **Tried running both paths without a flag.** Two code paths reading the same
  state produced a duplicate-delivery bug under test. The flag makes the switch
  explicit and reviewable.

## Open questions

- The source's reconnect backoff is undocumented. The implementation uses
  exponential backoff starting at 250 ms, capped at 30 s — **unverified** against
  the provider's expectations.
- Whether to delete `src/polling/loop.js` or keep it as the fallback implementation.

## Not verified

- Load behaviour above 1,000 events/second. Only tested at 50/second.
- Behaviour when the process is killed mid-batch. No test covers it.
