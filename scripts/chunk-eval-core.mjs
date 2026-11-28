import { canonical, chunkEntries, chunkEntriesTokenCapped, cosine, digest, normalizeTurn } from '../src/core.mjs';
import { DEFAULT_TREATMENT, LEGACY_POLICY, TOKEN_POLICY } from '../src/chunk-policy.mjs';

// Names the scoring contract: gold spans, exact-cosine ranking with index tie-break, the metrics and the gates below.
export const EVAL_VERSION = 'source-memory.chunk-eval/1';
export const KS = [1, 5, 10];
export const GATE_K = 5;
export const ROLES = ['default', 'reference', 'experiment'];
// An embedder whose own service proves, per input, that it embedded the whole text: the chunker's local cap is then checked
// against that proof, not against a local oracle of the server's tokenizer.
export const ADAPTER_WITNESS = 'adapter';
// Typed refusals an adapter raises instead of returning a vector it cannot prove full; anything else ends the run.
export const WITNESS_REFUSALS = ['embedding_full_input_unverified', 'embedding_input_too_long'];
// The only adapter failure codes a run reports; any other is `unclassified`, so no adapter-chosen text is printed.
export const ADAPTER_FAILURES = ['model_request_failed', 'model_timeout', 'invalid_embedding_response', 'embedding_model_mismatch'];
// The full-input bases the eval accepts, each as its transport and evidence kind. They stay distinct in every result.
export const WITNESS_BASES = Object.freeze({ vertex_predict: 'vertex_statistics', gemini_embed_content: 'verified_precount_and_boundary' });

/**
 * A treatment manifest is valid only in one of three roles. The default must carry exactly DEFAULT_TREATMENT, the reference
 * the legacy byte policy; anything else is a named experiment and is reported as unqualified.
 */
export function validateManifest(manifest) {
  const fail = reason => { throw new Error(`invalid treatment manifest: ${reason}`); };
  if (!manifest || typeof manifest !== 'object') fail('not an object');
  if (typeof manifest.name !== 'string' || !/^[a-z0-9-]{1,64}$/u.test(manifest.name)) fail('name');
  if (!ROLES.includes(manifest.role)) fail('role');
  const { chunker, embedder, budget } = manifest;
  if (!chunker || ![LEGACY_POLICY, TOKEN_POLICY].includes(chunker.policy)) fail('chunker.policy');
  const witnessed = embedder?.full_input_witness === ADAPTER_WITNESS;
  if (!embedder || typeof embedder.model !== 'string' || !Number.isSafeInteger(embedder.context)
      || (!witnessed && typeof embedder.tokenizer_sha256 !== 'string')) fail('embedder');
  if (witnessed) {
    // A remote embedder is an experiment over a local token chunker, identified exactly as its adapter names itself.
    if (manifest.role !== 'experiment' || chunker.policy !== TOKEN_POLICY) fail('an adapter-witnessed embedder is an experiment over a token chunker');
    const { identity } = embedder;
    if (!identity || typeof identity !== 'object' || identity.model !== embedder.model || identity.dimensions !== embedder.dimensions
        || identity.auto_truncate !== false || typeof identity.provider !== 'string') fail('embedder.identity');
    // The only adapter code a run may load: a module of this repository, pinned to its committed git blob.
    const { adapter } = embedder;
    if (!adapter || !/^src\/[a-z0-9-]{1,64}\.mjs$/u.test(adapter.module) || !/^[0-9a-f]{40}$/u.test(adapter.git_blob)) fail('embedder.adapter');
    if (!Number.isSafeInteger(embedder.dimensions) || embedder.dimensions < 1 || embedder.context < 1) fail('embedder');
  }
  if (!budget || !Number.isSafeInteger(budget.max_inputs) || budget.max_inputs < 1 || !Number.isSafeInteger(budget.max_seconds) || budget.max_seconds < 1) fail('budget');
  if (manifest.role === 'default' && canonical(chunker) !== canonical(DEFAULT_TREATMENT)) fail('the default row must be exactly DEFAULT_TREATMENT');
  if (manifest.role === 'reference' && chunker.policy !== LEGACY_POLICY) fail('the reference row is the legacy byte policy');
  if (!witnessed && chunker.policy === TOKEN_POLICY && ['tokenizer_sha256', 'served_blob', 'context', 'model', 'endpoint_path', 'transport', 'dimensions', 'provider']
    .some(key => chunker[key] !== embedder[key])) {
    fail('a token policy must name exactly the evaluated embedder deployment');
  }
  return { ...manifest, digest: digest(manifest), qualification: manifest.role === 'experiment' ? 'unqualified' : manifest.role };
}

const corpusTurn = turn => normalizeTurn({ source: 'chunk-eval', conversation_id: 'corpus', turn_id: turn.key, entries: turn.entries });

/** Every chunk and gap the treatment derives for the corpus, with its exact local rendered count. */
export function deriveCorpus(corpus, chunker, counter) {
  const chunks = [];
  const gaps = [];
  for (const turn of corpus.turns) {
    const normalized = corpusTurn(turn);
    const derived = chunker.policy === LEGACY_POLICY
      ? { chunks: chunkEntries(normalized, chunker.words, chunker.overlap), gaps: [] }
      : chunkEntriesTokenCapped(normalized, chunker.words, chunker.overlap, counter, chunker.token_cap);
    for (const chunk of derived.chunks) {
      chunks.push({ turn: turn.key, entry_id: chunk.entry_id, start: chunk.start, end: chunk.end, text: chunk.text, tokens: counter.count(chunk.text) });
    }
    for (const gap of derived.gaps) gaps.push({ turn: turn.key, ...gap });
  }
  return { chunks, gaps };
}

/**
 * Top-k chunk indices per query by exact cosine; ties go to the lower index. A chunk or query without a vector (refused by a
 * witnessing adapter) takes no place in any ranking.
 */
export function rank(queryVectors, chunkVectors, k = Math.max(...KS)) {
  return queryVectors.map(query => (query === null ? [] : chunkVectors.flatMap((vector, index) => (vector === null ? [] : [{ index, score: cosine(query, vector) }]))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, k).map(row => row.index)));
}

/**
 * Embeds each item alone through a witnessing adapter (`embed(inputs, {purpose, signal}) -> {rows:[{vector, full_input,
 * evidence}]}`). A vector counts only with `full_input === true` and evidence whose count is within its limit and the sealed
 * context; a typed refusal leaves the item without a vector and is counted. Any other failure or a malformed reply ends the run.
 * `admit()` runs before every request and may throw to stop.
 */
export async function embedWitnessed(adapter, items, { dimensions, context, admit = async () => ({}), signal } = {}) {
  const positive = n => Number.isSafeInteger(n) && n > 0;
  if (!positive(dimensions) || !positive(context)) throw new Error('witnessed embedding needs positive dimensions and context');
  const vectors = [];
  const refusals = Object.fromEntries(WITNESS_REFUSALS.map(code => [code, 0]));
  const kinds = new Set();
  const keys = value => (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join() : null);
  for (const { text, purpose } of items) {
    // The admission hook may stop the run, and may give a per-request signal bounded by the time remaining.
    const admitted = await admit();
    let reply;
    try { reply = await adapter.embed([text], { purpose, signal: admitted?.signal ?? signal }); } catch (error) {
      // Only a code leaves the adapter: a message could carry request or credential detail.
      if (!WITNESS_REFUSALS.includes(error?.code)) throw new Error(`adapter failure: ${ADAPTER_FAILURES.includes(error?.code) ? error.code : 'unclassified'}`);
      refusals[error.code]++;
      vectors.push(null);
      continue;
    }
    // Exactly one row of exactly the agreed fields, with positive counts: anything else is not a witness.
    const row = keys(reply) === 'rows' && Array.isArray(reply.rows) && reply.rows.length === 1 ? reply.rows[0] : null;
    const evidence = row?.evidence;
    if (keys(row) !== 'evidence,full_input,vector' || row.full_input !== true || keys(evidence) !== 'kind,limit,token_count,transport'
        || !Array.isArray(row.vector) || row.vector.length !== dimensions || !row.vector.every(Number.isFinite) || !row.vector.some(x => x !== 0)
        || typeof evidence.transport !== 'string' || typeof evidence.kind !== 'string' || !Object.hasOwn(WITNESS_BASES, evidence.transport)
        || WITNESS_BASES[evidence.transport] !== evidence.kind
        || !positive(evidence.token_count) || !positive(evidence.limit) || evidence.token_count > evidence.limit || evidence.limit > context) {
      throw new Error('the adapter returned a vector without a valid full-input witness');
    }
    kinds.add(`${evidence.transport}/${evidence.kind}`);
    vectors.push(row.vector);
  }
  return { vectors, refusals, evidence_kinds: [...kinds].sort() };
}

const overlaps = (chunk, gold) => chunk.turn === gold.turn && chunk.entry_id === gold.entry_id && chunk.start < gold.end && gold.start < chunk.end;
const contains = (chunk, gold) => chunk.turn === gold.turn && chunk.entry_id === gold.entry_id && chunk.start <= gold.start && gold.end <= chunk.end;

/**
 * Whether the embedder saw the gold text in this chunk: the whole chunk fits the context, or the local oracle counts the chunk
 * prefix through the gold span within it. The second case is an estimate of the server's truncation, labelled as such.
 */
function represented(chunk, gold, context, counter) {
  // Under a witnessing adapter only its proof counts: no local estimate of what a remote tokenizer kept.
  if (chunk.witnessed !== undefined) return chunk.witnessed ? 'full' : 'truncated_away';
  if (chunk.tokens <= context) return 'full';
  const through = Math.min(gold.end, chunk.end) - chunk.start;
  return counter.count(chunk.text.slice(0, through)) <= context ? 'prefix_estimate' : 'truncated_away';
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

/** Per-query observations and aggregates. Denominators are every query of a subset, including ones with no hit. */
export function scoreRun({ corpus, derived, rankings, context, counter, queryEmbedded }) {
  const perQuery = corpus.queries.map((query, q) => {
    const ranked = rankings[q];
    const stored = ranked.findIndex(index => overlaps(derived.chunks[index], query.gold));
    const embedded = ranked.findIndex(index => overlaps(derived.chunks[index], query.gold)
      && represented(derived.chunks[index], query.gold, context, counter) !== 'truncated_away');
    const covering = derived.chunks.filter(chunk => overlaps(chunk, query.gold));
    return {
      id: query.id, subset: query.subset,
      stored_rank: stored < 0 ? null : stored + 1,
      embedded_rank: embedded < 0 ? null : embedded + 1,
      gold_covered: covering.length > 0,
      // The whole gold span inside one chunk the embedder saw in full; touching it with one character is not enough.
      gold_fully_represented: covering.some(chunk => contains(chunk, query.gold) && represented(chunk, query.gold, context, counter) === 'full'),
      gold_in_gap: derived.gaps.some(gap => overlaps(gap, query.gold)),
    };
  });
  const subsets = ['all', ...new Set(corpus.queries.map(query => query.subset))];
  const aggregate = {};
  for (const subset of subsets) {
    const rows = perQuery.filter(row => subset === 'all' || row.subset === subset);
    const recall = field => Object.fromEntries(KS.map(k => [k, rows.filter(row => row[field] !== null && row[field] <= k).length]));
    aggregate[subset] = { queries: rows.length, stored_recall: recall('stored_rank'), embedded_recall: recall('embedded_rank'),
      stored_mrr10: rows.reduce((sum, row) => sum + (row.stored_rank ? 1 / row.stored_rank : 0), 0) / rows.length };
  }
  const tokens = derived.chunks.map(chunk => chunk.tokens);
  return {
    per_query: perQuery,
    aggregate,
    coverage: { chunks: derived.chunks.length, over_context: tokens.filter(count => count > context).length, gaps: derived.gaps.length,
      // Under a witnessing adapter, refused chunks and refused queries are both coverage failures, counted apart.
      ...(derived.chunks.some(chunk => chunk.witnessed !== undefined) ? { unwitnessed: derived.chunks.filter(chunk => chunk.witnessed === false).length } : {}),
      ...(queryEmbedded ? { queries_unembedded: queryEmbedded.filter(embedded => !embedded).length } : {}),
      gold_covered: perQuery.filter(row => row.gold_covered).length, gold_fully_represented: perQuery.filter(row => row.gold_fully_represented).length,
      queries: perQuery.length },
    cost: { chunks: tokens.length, mean_tokens: tokens.reduce((a, b) => a + b, 0) / Math.max(1, tokens.length),
      p95_tokens: percentile(tokens, 0.95), max_tokens: tokens.length ? Math.max(...tokens) : null },
  };
}

/**
 * Paired comparison of a candidate against its reference on the same corpus and evaluator. Gates (predeclared):
 * full coverage with no over-context chunk or gap; dense embedded recall@5 not below the reference; at most one query lost
 * overall at embedded rank 5. Every lost query is listed.
 */
export function compareRuns(reference, candidate) {
  if (reference.corpus_digest !== candidate.corpus_digest || reference.eval_version !== candidate.eval_version) {
    throw new Error('runs differ in corpus or evaluator and cannot be compared');
  }
  const hit = row => row.embedded_rank !== null && row.embedded_rank <= GATE_K;
  const before = new Map(reference.score.per_query.map(row => [row.id, row]));
  const lost = [], won = [];
  for (const row of candidate.score.per_query) {
    const old = before.get(row.id);
    if (hit(old) && !hit(row)) lost.push(row.id);
    if (!hit(old) && hit(row)) won.push(row.id);
  }
  const coverage = candidate.score.coverage;
  const denseReference = reference.score.aggregate.dense?.embedded_recall[GATE_K] ?? 0;
  const denseCandidate = candidate.score.aggregate.dense?.embedded_recall[GATE_K] ?? 0;
  const gates = {
    full_coverage: coverage.over_context === 0 && coverage.gaps === 0 && (coverage.unwitnessed ?? 0) === 0
      && (coverage.queries_unembedded ?? 0) === 0 && coverage.gold_fully_represented === coverage.queries,
    dense_not_worse: denseCandidate >= denseReference,
    overall_losses_at_most_one: lost.length <= 1,
  };
  return { reference: reference.manifest_digest, candidate: candidate.manifest_digest, k: GATE_K, lost, won,
    dense_embedded_recall: { reference: denseReference, candidate: denseCandidate }, gates, pass: Object.values(gates).every(Boolean) };
}
