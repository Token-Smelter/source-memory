# Design

**Keep every source turn, index it two ways, and attach interpretation to exact spans; never let an extractor decide what future questions can recover.** This document records the choices behind the implementation and their known limits.

## Principles

| Choice | Reason |
|---|---|
| Retain full turns before any extraction | A summary decides what matters before the question exists. Raw-history retrieval stays competitive largely because it keeps sufficient evidence ([Bao et al., 2026](https://arxiv.org/abs/2610.30755)). |
| Whole-turn full-text, within-entry chunk vectors | Lexical search can combine words spread across a turn; small chunks give embeddings a focused target. Both point to the same retained turn. |
| Records and relations are separate from source | Decisions, outcomes and corrections are interpretations. They cite exact spans and can be wrong without corrupting the evidence. |
| Explicit relationships only | Supersession, qualification and dependency are asserted with evidence; recency and similarity never create them. |
| Relationship expansion after ranking | A known successor travels with a matched older decision even when it scores poorly for the query. |
| Independent channels, then fusion | Concatenating summaries and raw text into one representation can crowd out better candidates; separate channels keep each signal intact. |
| Honest completeness | Every channel, limit and budget cut is reported. An outage or a truncated graph never looks like "nothing remembered". |

## Data model

| Node | Identity | Content |
|---|---|---|
| `SMTurn` | hash(scope, source, conversation, turn) | Exact entries (id, role, text, time), parent turn, content hash |
| `SMChunk` | hash(scope, turn, ordinal) | Word window inside one entry with UTF-16 offsets; optional embedding and embedding identity |
| `SMRecord` | hash(scope, record id) | Kind, status, text, attribution, evidence spans; optional embedding |
| `SMRelation` | hash(scope, relation id) | Type, endpoints, attribution, evidence spans |

Each scope also gets hashed per-scope labels and its own full-text indexes, so lexical candidates are drawn only from that scope rather than filtered after global ranking. Writes are single Neo4j transactions; replays compare content hashes, and conflicts roll back the whole call.

## Integration boundary

A host adapter (for example, an agent harness) owns knowing when a turn completes, locating its transcript, choosing the active branch, assigning stable source IDs and binding the caller to a scope. It copies exact entries into `ingest` before asynchronous interpretation can lose them, and it resolves a model's cited entry IDs to spans for `enrich`. Interpretation models need no database access or tools; the host performs writes and recalls on their behalf. `index_on_write: false` keeps those calls off the latency path.

## Known limits

- The cosine channels scan a bounded set of scope-filtered vectors; replace with a vector index when histories outgrow it.
- Scope enforcement trusts the local configuration file. A multi-tenant deployment needs authenticated, host-issued scope binding.
- There is no erasure command; deliberate deletion must also remove derived chunks, embeddings and dependent records.
- Integration tests use deterministic model fixtures; they verify mechanics, not retrieval quality. An optional real-embedding check is available.
