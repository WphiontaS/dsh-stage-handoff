# 261101 demo anchor

Detail: detail/implementation.md
Previous anchor: none (first version)

## Goal

Replace the demo service's polling loop with an event source, without changing the
public API.

## Current state

- Event source adapter written and unit-tested (12 tests).
- Polling loop still active behind a flag `USE_POLLING`, default `true`.
- Production config not yet updated.

## Hard constraints

- The public API must not change: three endpoints, same request shapes.
- The adapter must keep working when the event source is unavailable — fall back to
  polling, do not throw.
- Node 20 compatibility is required.

## Decisions

- Chose an adapter over rewriting the consumer, because the consumer is shared with
  a second service.
- Rejected a message queue: the operational cost is not justified at this volume.

## Paths that matter

- `src/events/adapter.js` — the new adapter
- `src/polling/loop.js` — the old loop, still referenced behind the flag
- `config/default.yaml` — where `USE_POLLING` is read

## Next step

Flip `USE_POLLING` to `false` in the default config, run the integration suite, and
delete the polling loop in a follow-up change.
