# Pi Memory extension — experimental core

**This is source-only scaffolding, not an installable or production-ready Pi extension.** It provides a cursor-bounded turn function, an incremental private-session copy, a Pi SDK adapter, a long-lived Memory NDJSON process and a fake-tested Docker/relay adapter. The standalone Pi bootstrap, durable cursor recovery, reviewed vertical-slice run script and real end-to-end qualification remain unimplemented. No fake test establishes actual container isolation.

## Interfaces

| Module | Role |
|---|---|
| `core.mjs` | `distillThrough(session, throughEntryId, cursor)` ingests one `pi-memory` turn and invokes the injected distiller; a single scope is required. `createTurnTools` resolves current-turn evidence labels and exact link-offer handles. |
| `incremental.mjs` | Copies complete source JSONL entry lines into a private Pi-session file, preserving entry IDs. Prefix rewrites rebuild the private copy if old entry identities remain equal; changed identities and collisions refuse. State is in memory and does not recover after process restart. |
| `pi-runtime.mjs` | Reopens that private session, branches to the target leaf and runs an injected Pi SDK session. Anthropic history breakpoint logic is included. |
| `ndjson.mjs`, `memory-client.mjs`, `memory-process.mjs`, `serve.mjs` | Correlated, cancellable requests to one Memory process; link proposal objects remain in that process for validated reviewed apply. |
| `index.mjs`, `replay.mjs` | Injectable nonblocking settled-event registration and replay over the same core. |
| `bridge-harness.mjs`, `docker-adapter.mjs`, `docker-memory.mjs` | Fake-tested bridge/relay orchestration, exact-ID Docker and process adapters. No concrete end-to-end run has qualified their isolation, cleanup or endpoint identity. |

The host must provide trusted configuration, an isolated source snapshot, durable cursor storage, model routing and a reviewer. Errors and unconfirmed writes must not advance a cursor. Separate review and self-review are labelled distinctly; a model proposal is not operator acceptance. Docker, gateway, `docker exec`, Pi SDK and Memory integration have only fake tests; no real container, model or Memory process has qualified them. The input-token cap is checked between reported model calls; one already-started call may overshoot the 20M ceiling. Missing usage stops further calls rather than assuming zero.
