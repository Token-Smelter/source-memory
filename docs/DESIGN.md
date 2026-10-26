# Design

**Keep every source turn, index it two ways, and attach interpretation to exact spans; never let an extractor decide what future questions can recover.** This document records the choices behind the implementation and their known limits.

## Principles

| Choice | Reason |
|---|---|
| Retain full turns before any extraction | A summary decides what matters before the question exists. Raw-history retrieval stays competitive largely because it keeps sufficient evidence ([Bao et al., 2026](https://arxiv.org/abs/2610.30755)). |
| Whole-turn full-text, within-entry chunk vectors | Lexical search can combine words spread across a turn; small chunks give embeddings a focused target. Both point to the same retained turn. |
| Scope-local native vector indexes | Neo4j HNSW retrieves a bounded candidate window instead of transferring and scoring the corpus; quantization is disabled and surviving candidates are rescored with cosine. |
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

Each scope gets hashed labels and its own full-text indexes. When embeddings are configured, it also gets Chunk/Record vector indexes on `embedding` (`smvc_` / `smvr_` plus the scope digest), with cosine similarity, configured dimensions, and quantization disabled. `init` uses `IF NOT EXISTS`; conflicting dimensions, schema or quantization fail explicitly rather than silently reusing an incompatible index. No vector indexes are created without embedding configuration. `init` waits for only the scope's full-text indexes, creates/checks native schemas and returns their `online`/`populating` states without waiting for native population; poll `status` until online. Writes remain single Neo4j transactions; replays compare content hashes, and conflicts roll back the whole call.

## Native vector retrieval

1. Query the scope's native vector index with `k=max(candidates*4,64)`.
2. Inside that query, reject wrong scope/model and excluded conversations, then rescore only surviving candidates with exact cosine. Apply conversation admission and the channel limit after filtering; ties break by UID within the candidate window.
3. Count eligible scope/kind/model nodes independently. Complete only when survivors cover `min(limit, eligible_count)`, or the filtered window considered every eligible node before quota/dedup. Never infer exhaustion from a short ANN return. Otherwise double `k` through 4096 and report unresolved results as `partial` / `vector_overfetch_cap`. ANN selection is not an exact global-neighbour guarantee.
4. A populating index reports partial without querying or fabricating admission counters. Failed/incompatible indexes are unavailable. Grouped `exhausted` remains based on a count-only eligible census, with no corpus vector transfer or scoring.
5. Only a missing index enables the legacy scan, explicitly labeled `vector_index:missing`. Both missing indexes retain the old shared scan bound; one missing index scans only its kind. Catalog validation/fallback failures affect only their own kind, never a healthy sibling. The scan limit can still make that fallback partial, but never caps a healthy native index.
6. Cap application widening at 7 rounds per kind and 14 per recall using a shared backstop. Grouped rounds also perform legacy-parent reads; census/catalog work and existing driver retries remain additional. This bound is not an end-to-end 4s guarantee.

Readiness is reported per kind in `status.vector_indexes` and each vector channel's `vector_index`. Existing indexes are not automatically dropped or rebuilt. Following, evidence, source identities, exclusions, and authority rules do not change.

## Integration boundary

A host adapter (for example, an agent harness) owns knowing when a turn completes, locating its transcript, choosing the active branch, assigning stable source IDs and binding the caller to a scope. It copies exact entries into `ingest` before asynchronous interpretation can lose them, and it resolves a model's cited entry IDs to spans for `enrich`. Interpretation models need no database access or tools; the host performs writes and recalls on their behalf. `index_on_write: false` keeps those calls off the latency path.

## Known limits

- Native ANN candidate selection can miss exact neighbours, and heavy post-filtering may exhaust the widening budget. These bounds are disclosed; a ready channel is not a currentness or retrieval-quality guarantee.
- Scope enforcement trusts the local configuration file. A multi-tenant deployment needs authenticated, host-issued scope binding.
- There is no erasure command; deliberate deletion must also remove derived chunks, embeddings and dependent records.
- Integration tests use deterministic model fixtures; they verify mechanics, not retrieval quality. An optional real-embedding check is available.
