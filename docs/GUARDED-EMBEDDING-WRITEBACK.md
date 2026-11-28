# Guard embedding writeback on the F1 maintenance line

**Count only confirmed vector saves.** Discovery carries identity and retry hints; at most 16 rows at a time carry the exact observed state for an embedding request or marker write. No node lock is held during model I/O.

```mermaid
flowchart LR
  D[Discover pending identities] --> W[Observe one bounded unit]
  W --> E[Embed outside write lock]
  E --> R[Lock and recheck observed state]
  R --> A[Apply vector or marker]
  R --> S[Refuse changed rows]
```

The write rechecks text, key, prior vector, retry state, and both terminal witnesses after acquiring the node lock. A context refusal can mark only the exact, previously isolated singleton chunk under the current rejection contract. A successful save clears both kinds of terminal witness. A refused row is stale, or unknown when a managed transaction retry may have lost a reply; it does not count as applied progress. Earlier confirmed vectors remain counted if a later unit fails.

Terminal witnesses do not count as indexed vectors, and a terminal-only scope is not ready. Neither this guard nor a successful fixture proves safety with concurrent older writers that do not use it, a same-state restore, or a serving-context change during a request.
