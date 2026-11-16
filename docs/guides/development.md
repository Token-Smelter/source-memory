# Development and testing

These tests exercise the implementation with fixtures, not model quality. Integration tests start a disposable Docker database.

## Development

```sh
npm ci
npm test                 # unit and HTTP-boundary tests
npm run check            # syntax and JSON checks
npm run test:integration # disposable loopback Neo4j container; needs Docker
```

`npm run test:integration` starts a throwaway `neo4j:5.26.14-community` container with no published credentials, runs transaction, search, scope, graph, outage, and CLI checks with fictional data and deterministic model fixtures, then the Q-SM-1…6 write qualification ([QUALIFICATION.md](../../QUALIFICATION.md); `-- --suite qualification` runs only that), and stops the container. Set `SOURCE_MEMORY_REAL_EMBEDDING_URL` (and optionally `SOURCE_MEMORY_REAL_EMBEDDING_MODEL`, default `embeddinggemma`) to additionally exercise a real local embedding endpoint. Fixture results test plumbing, not retrieval quality. `node scripts/vector-benchmark.mjs` runs the isolated 768-dimensional 10k/50k scan-versus-index benchmark under the same disposable resource limits; any 50k resource/timeout failure is reported explicitly.

### Vector-stage benchmark

Warm medians in milliseconds: one warmup, five measured samples, 64 candidates; private Neo4j 5.26.14, 1536m memory, 2 CPUs, 512m heap, 128m pagecache. These measure vector retrieval/scoring/top-k including the native eligible census, **not** catalog readiness, model calls, fusion, rendering, or full-CLI latency. Synthetic data is not a retrieval-quality benchmark.

| Dimensions | Vectors | Exact scan | Native, quantization off | Native, quantization on |
|---:|---:|---:|---:|---:|
| 3 | 10,000 | 157.539 | 79.424 | — |
| 3 | 50,000 | 755.527 | 188.061 | 183.268 |
| 768 | 10,000 | 1257.761 | 143.452 | — |
| 768 | 50,000 | Timed out at the existing 15s transaction bound | 264.636 | — |

The 768-d container held all 50,000 vectors and stopped cleanly; only the exact scan failed its original transaction deadline, so no scan median/speedup is invented for that row. Quantization remains off for fidelity; the 50k off/on sample ranges overlap, with a small median difference. Both paths retain bounded exact cosine rescoring.

Worst-case widening at 768d/10k: 9999 excluded nearest vectors plus one eligible far vector, one candidate, all 7 ANN rounds through 4096, ending truthfully partial. Ordinary median: 618.143 ms. Grouped median: 630.483 ms, including 7 legacy-parent reads. These are vector-stage costs, not whole-CLI latency guarantees.
