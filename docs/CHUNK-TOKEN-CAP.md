# Token-capped chunks for new turns

**New turns can be chunked so that no chunk exceeds the embedder's context, counted exactly by the served model's own tokenizer.** It is off unless `embedding.tokenizer` is set. Existing turns, chunks and vectors are never rewritten, and a replay keeps its first layout.

```mermaid
flowchart LR
  C[embedding.tokenizer + chunk_token_cap] --> P{Verified contract?}
  P -->|digest, model, rendering, serving revision match| T[Exact count ≤ cap and ≤ 8,192 bytes]
  P -->|no| G[Retain source; typed tokenizer_unavailable gap]
  T -->|unit cannot fit| U[Typed unsplittable_unit gap]
  T --> M[Chunks + first-retain manifest, one transaction]
  G --> M
  U --> M
```

## Configuration

| Key | Meaning |
|---|---|
| `embedding.tokenizer` | `{gguf, sha256}`: absolute path to the served model's GGUF and the tokenizer digest `readGgufTokenizer` reports. Unset means the legacy byte chunker and no token claim. |
| `embedding.chunk_token_cap` | Positive integer, at most the verified context. Default 1920 when `embedding.tokenizer` is set. A cap without a tokenizer, or out of range, is refused (`invalid_chunk_token_cap`) before any write. |
| `embedding.ollama_context_revision` | Must equal the verified contract's serving revision. The default is `ollama-0.21.0-embeddinggemma-0800cbac-ctx2048`. |

A tokenizer is trusted only through `VERIFIED_TOKENIZERS` in `src/chunk-policy.mjs`. An entry binds the digest to the served model, the rendering contract (`ollama-spm-raw-input/1`: raw input plus BOS and EOS, with special-token strings split first), the serving revision and the effective context. Only a reviewed parity qualification (`scripts/tokenizer-parity.mjs`) adds one. Any other contract yields `tokenizer_unavailable` gaps with reason `unverified`. The configured GGUF must hash to the entry's `served_blob`. That proves the local file only; that the running endpoint serves that blob and transport is the owner's attestation through `ollama_context_revision`.

Only a policy whose descriptor digest is listed in `QUALIFIED_TREATMENTS` is `qualified`, and only a reviewed evaluation of exactly that descriptor adds it. Every other valid policy is stamped `unqualified` on its turns and chunks. The descriptor includes cap, chunker settings, tokenizer, served blob, rendering, serving revision, endpoint path, transport and dimensions.

| Table | Entry | Evidence |
|---|---|---|
| `VERIFIED_TOKENIZERS` | `2e942f0e…b698`: embeddinggemma, blob `sha256:0800cbac…c515`, Ollama 0.21.0, context 2048 | Parity report `dd421cb8…0de2`: 185 exact counts and 3 exact native refusals on 188 fictional strings |
| `QUALIFIED_TREATMENTS` | `07d6ab7d…d1a0` (`DEFAULT_TREATMENT`: cap 1920, `/v1/embeddings`, `openai_compat`, 768 dimensions) | Sealed `default-v1` run against `legacy-reference-v1`, comparison `8621f250…f8e1`: embedded recall@5 13/13 against 4/13, every gold span fully represented, no query lost |

To use the qualified default, set `embedding.tokenizer` to that blob and digest and `embedding.ollama_context_revision` to `ollama-0.21.0-embeddinggemma-0800cbac-ctx2048`, and leave `chunk_token_cap` unset. The native no-truncate transport, any other cap and any other model are unqualified until they have their own evaluated row.

## What is stored

On a first retain, in the same transaction as the turn:

| On | Properties |
|---|---|
| `SMTurn` | `chunk_policy` (canonical descriptor), `chunk_policy_digest`, `chunk_qualification`, `chunk_count`, `chunk_gap_count`, `chunk_manifest` and its `chunk_manifest_digest`, `chunk_manifest_status` (`complete` or `over_bound`) |
| `SMChunk` (token policy only) | `token_count`, `chunk_token_cap`, `tokenizer_sha256`, `chunk_qualification` |

`chunk_manifest` is `source-memory.chunk-manifest/1`. It contains the scope, turn UID and stored hash, the policy, and per chunk the UID, ordinal, entry, UTF-16 `[start,end)` and text digest. Gaps are listed with their cause. No source text is copied into it. Unconfigured new turns get a `legacy-bytes/1` manifest with a null token count. Turns retained before manifests have none.

## Readers

A gap is source that no chunk represents, not a missing vector row. `status` reports `derived_gaps`. `index` returns `unavailable` with reason `derived_chunk_gaps` rather than `ready`, and the recall `chunk_vector` channel is `partial` with `derived_gaps`.

## Evaluation

`scripts/eval-chunking.mjs` runs one sealed row of a star matrix: the default `default-v1` and the frozen `legacy-reference-v1` reference, plus explicit, unqualified `--experiment` rows. It scores against gold source spans in a fictional corpus and reports two things separately: that the stored chunk was hit, and that the needle was actually embedded. `--compare` applies the predeclared gates.

A remote embedder is an experiment row with `embedder.full_input_witness: "adapter"` over the local token chunker. The manifest pins the only adapter code a run may load: `embedder.adapter = {module, git_blob}`, a module of this repository at its committed blob, loaded only from a clean checkout and recorded in the seal. Its `createAdapter(config)` returns `embed(inputs, {purpose, signal})` and a frozen `identity`, which must equal the sealed one. A self-reported identity is not code provenance; the pinned blob is. Each chunk and query is sent alone, as `document` or `query`. A vector counts as embedded only when the adapter returns `full_input: true` with evidence whose count is within its limit and the sealed context. No local estimate of the remote tokenizer is used. A typed refusal (`embedding_input_too_long`, `embedding_full_input_unverified`) leaves that input unembedded, and the result counts it; any other failure, or a reply without valid evidence (exactly one row of exactly `{vector, full_input, evidence:{kind, transport, token_count, limit}}`, positive counts), ends the run with no result, reporting only the adapter's error code. Each request gets a signal aborted at the run's deadline, and no result is written after it; aborting stops waiting but cannot prove the provider stopped or did not receive the text. The evidence kinds are recorded, so a per-response provider witness and a counted reject-on-overflow basis stay distinguishable. Refused chunks and refused queries are counted apart and each fails the full-coverage gate. Local chunk token counts (`over_context`) stay a local measure; only the adapter's evidence certifies what the remote model received.
