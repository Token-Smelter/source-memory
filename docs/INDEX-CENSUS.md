# Owner-only index census

**Read numeric aggregates for one explicitly granted flat scope.** This standalone command is not a Fork route. It requires the owner to supply the existing approved config and credential context. It does not prepare schema, index content, call an embedder, or return text, IDs, query text or plan details.

```bash
node /path/to/library/bin/index-census.mjs --scope sorcerer-dashboard
```

`SOURCE_MEMORY_CONFIG` names the existing authorized config. Share only the numeric stdout on success; if there is no result, do not share the config, environment, or connection diagnostics.

The command requires existing range indexes on `SMChunk(scope)` and `SMRecord(scope)` and a unique lookup on `SMTurn(uid)`. A fixed query per label must explain as a bounded exact seek or the command stops. Read committed counts are observations, not an atomic snapshot across the two label reads or the independent index-health reads. The 4,096 total row cap refuses the entire reply on overflow; the read transaction has a 15-second server timeout. Do not raise the cap or add indexes solely to make the command run without a separate decision.

A chunk counts as indexed only with a vector and the current key. Byte terminal counts include matching witnesses or strings whose character count alone proves they exceed the byte cap; ambiguous multibyte text without a witness stays unclassified. Context terminal counts require the current opted-in context witness, after excluding those already counted as byte terminal. Retry markers, active cooling and same-key missing vectors are observations, not a diagnosis. Affected turns count distinct exact-scope turns resolved by missing chunks' stored parent keys; unresolved keys are counted separately. Missing record vectors are a separate population, not added to affected turns. Health codes: 1 online, 2 populating, 3 missing, 4 failed, 5 incompatible, 6 unavailable, 0 unknown.
