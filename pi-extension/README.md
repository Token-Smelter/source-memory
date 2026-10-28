# Pi Memory extension — experimental core

**This is source-only scaffolding, not an installable or production-ready Pi extension.** It provides a cursor-bounded turn function, an incremental private-session copy, a Pi SDK adapter, and a long-lived Memory NDJSON process for fictional tests. The standalone Pi bootstrap, durable cursor recovery and isolated bridge/relay harness remain unimplemented.

## Interfaces

| Module | Role |
|---|---|
| `core.mjs` | `distillThrough(session, throughEntryId, cursor)` ingests one `pi-memory` turn and invokes the injected distiller; a single scope is required. `createTurnTools` resolves current-turn evidence labels and exact link-offer handles. |
| `incremental.mjs` | Copies complete source JSONL entry lines into a private Pi-session file, preserving entry IDs. Prefix rewrites rebuild the private copy if old entry identities remain equal; changed identities and collisions refuse. State is in memory and does not recover after process restart. |
| `pi-runtime.mjs` | Reopens that private session, branches to the target leaf and runs an injected Pi SDK session. Anthropic history breakpoint logic is included. |
| `ndjson.mjs`, `memory-client.mjs`, `memory-process.mjs`, `serve.mjs` | Correlated, cancellable requests to one Memory process; link proposal objects remain in that process for validated reviewed apply. |
| `index.mjs`, `replay.mjs` | Injectable nonblocking settled-event registration and replay over the same core. |

The host must provide trusted configuration, an isolated source snapshot, durable cursor storage, model routing and a reviewer. Errors and unconfirmed writes must not advance a cursor. Separate review and self-review are labelled distinctly; a model proposal is not operator acceptance. No network isolation or bridge embedding relay is implemented here.
