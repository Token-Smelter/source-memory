---
name: source-memory
description: Store and recall source-backed project memory with the Source Memory CLI. Use when asked to remember a conversation turn, attach a decision to original evidence, find why a decision changed, inspect earlier supporting context, or search this configured local memory store. Preserves raw turns independently of extraction; combines lexical and optional local semantic retrieval. Does not discover transcripts, grant access, or activate automatic capture.
compatibility: Node.js 22+, configured private Neo4j, and the source-memory CLI. Optional loopback embedding/reranker services.
---

# Source-backed memory

**Use retained original evidence to explain history; do not treat recalled statements as current permission.** The repository root is two directories above this skill's directory. Resolve `../../bin/memory.mjs` relative to this file's directory, not the shell's current directory. Use `node <resolved-cli>` unless `source-memory` is already installed.

## Before use

Obtain the caller's explicit memory configuration path and authorized scope. Do not discover credentials, inspect environment dumps, scan session folders, or guess a database. The utility enforces the configuration's scope allowlists; a scope mentioned in conversation does not grant access. Do not initialize a database unless it is the caller's explicitly designated memory store.

Use `--help` for command syntax. Every invocation requires `--config FILE --scope SCOPE`. JSON payloads enter through stdin or `--input FILE`; stdout contains JSON and stderr contains sanitized failures. See `../../README.md` for exact schemas and limitations. `--config` may be omitted when `SOURCE_MEMORY_CONFIG` is set.

## Recall and inspect

1. Call `recall` with `{"query":"the actual information need","limit":8}`.
2. Inspect `channels`, `retrieval_complete`, `relationship_context_complete`, `budget_omitted`, and each bundle's `gaps`. An unavailable channel is not evidence that history contains nothing. Ready channels do not guarantee all relevant history was retrieved.
3. Read the matched source excerpts, structured-record status/attribution, relationship type/direction, and their supporting evidence. A supersedes edge runs from new to old; a proposal is not an accepted reversal. A changed justification does not itself repeal a decision.
4. If an excerpt omits necessary context, call `show` with `{"kind":"turn","id":"<retained source id>"}`. For a structured record, use `{"kind":"record","id":"<record id>"}`. Parent turn identity is available for a caller-directed follow-up; it is not automatically included.
5. Answer with the specific source/record references and qualifications. Name unresolved conflicts or incomplete context. Do not infer authority, execution success, or corroboration from a retrieval score or duplicate channel match.

Example:

```sh
printf '%s\n' '{"query":"why did we replace the dashboard color?","limit":5}' |
  node <resolved-cli> recall --config <explicit-config> --scope <admitted-scope>
```

## Retain source, then interpret

The host/caller supplies original source bytes. **Do not transcribe a conversation from model memory to create original evidence.** If a source has not been supplied, ask the caller/adapter for it rather than reading arbitrary session JSONL files.

- `ingest` receives `source`, `conversation_id`, `turn_id`, optional parent/time, and ordered `entries` with original `id`, `role`, and exact `text`. Keep stable identity on retries. Save the returned source ID.
- Source is retained even if no structured memory is extracted or embeddings are unavailable. Report the actual `indexing.status`. Use `index` to retry unavailable/pending embeddings, not a fabricated new turn ID.
- `enrich` receives `records` and `relations`. Each has a stable caller ID, attribution, and evidence spans referencing an ingested source ID plus original entry ID and half-open UTF-16 offsets. Let the runtime/caller provide offsets, or locate exact spans in the retained source; do not guess.
- Keep proposals distinct from accepted decisions and observations. Attach an outcome to its concrete action/attempt through `outcome_of`; otherwise retain an attributed observation.
- Add supported corrections as new records and explicit relations. Never overwrite an accepted identity to change its meaning. Identical retries replay; conflicting content refuses.

## Failure and scope

Without configured embedding/reranker services, lexical recall is useful and the absent channels are reported. Do not claim semantic retrieval ran. A configured outage returns degraded results; raw source remains retained. Test fixture vectors prove wiring only, not model quality.

This skill does not implement turn-completion hooks, automatic fork invocation, automatic injection, a remote authentication service, or erasure. A host adapter owns source discovery and binding. Do not work around missing integration by transcribing source or widening scopes.
