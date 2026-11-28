import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_MAX_BYTES } from '../src/core.mjs';
import { DEFAULT_TREATMENT } from '../src/chunk-policy.mjs';
import { readGgufTokenizer, sentencePiece } from '../src/tokenizer.mjs';
import { compareRuns, deriveCorpus, embedWitnessed, EVAL_VERSION, rank, scoreRun, validateManifest } from '../scripts/chunk-eval-core.mjs';
import { chunkEvalCorpus } from './fixtures/chunk-eval/corpus.mjs';
import { fictionalVocabulary, ggufTokenizerFile } from './helpers/gguf-fixture.mjs';

const manifest = async name => JSON.parse(await readFile(new URL(`./fixtures/chunk-eval/treatments/${name}.json`, import.meta.url), 'utf8'));

async function fictionalCounter(t) {
  const dir = await mkdtemp(join(tmpdir(), 'source-memory-chunk-eval-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'fiction.gguf');
  await writeFile(path, ggufTokenizerFile(fictionalVocabulary()));
  return sentencePiece(await readGgufTokenizer(path));
}

// Hashed bag of lowercase words: a deterministic stand-in embedder for scoring structure, not a quality claim.
const fakeVector = text => {
  const vector = new Array(64).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) vector[createHash('sha256').update(word).digest()[0] % 64] += 1;
  vector[63] += 1e-6;
  return vector;
};

test('the star matrix admits exactly one default, one legacy reference, and otherwise unqualified experiments', async () => {
  const fixed = validateManifest(await manifest('default-v1'));
  assert.deepEqual([fixed.role, fixed.qualification], ['default', 'default']);
  assert.deepEqual(fixed.chunker, { ...DEFAULT_TREATMENT });
  const reference = validateManifest(await manifest('legacy-reference-v1'));
  assert.equal(reference.chunker.policy, 'legacy-bytes/1');
  const altered = await manifest('default-v1');
  altered.chunker.token_cap = 1536;
  assert.throws(() => validateManifest(altered), /exactly DEFAULT_TREATMENT/);
  const experiment = validateManifest({ ...altered, name: 'cap-1536', role: 'experiment' });
  assert.equal(experiment.qualification, 'unqualified');
  assert.notEqual(experiment.digest, fixed.digest);
  assert.throws(() => validateManifest({ ...reference, role: 'reference', chunker: fixed.chunker }), /legacy byte policy/);
  assert.throws(() => validateManifest({ ...experiment, budget: { max_inputs: 0, max_seconds: 1 } }), /budget/);
});

test('every gold span is an exact needle inside one unchanged entry', () => {
  const corpus = chunkEvalCorpus();
  const turns = new Map(corpus.turns.map(turn => [turn.key, turn]));
  assert.equal(new Set(corpus.queries.map(query => query.id)).size, corpus.queries.length);
  assert.equal(new Set(corpus.queries.map(query => query.text)).size, corpus.queries.length, 'one gold span per question');
  for (const { gold, text } of corpus.queries) {
    const needle = turns.get(gold.turn).entries.find(entry => entry.id === gold.entry_id).text.slice(gold.start, gold.end);
    assert.match(needle, /repainted the .* after the winter storm\.$/u);
    assert.ok(text.includes(needle.split(' ')[0]));
  }
  assert.deepEqual([...new Set(corpus.queries.map(query => query.subset))].sort(), ['dense', 'ordinary']);
});

test('the legacy reference emits byte-bounded chunks over the context with the needle beyond it; the default emits none', async t => {
  const counter = await fictionalCounter(t);
  const corpus = chunkEvalCorpus();
  const legacy = deriveCorpus(corpus, (await manifest('legacy-reference-v1')).chunker, counter);
  const capped = deriveCorpus(corpus, { ...DEFAULT_TREATMENT }, counter);
  assert.ok(legacy.chunks.every(chunk => Buffer.byteLength(chunk.text) <= CHUNK_MAX_BYTES));
  assert.ok(legacy.chunks.some(chunk => chunk.tokens > 2048));
  assert.ok(capped.chunks.every(chunk => chunk.tokens <= DEFAULT_TREATMENT.token_cap && Buffer.byteLength(chunk.text) <= CHUNK_MAX_BYTES));
  assert.deepEqual(capped.gaps, []);
  const score = scoreRun({ corpus, derived: legacy, rankings: corpus.queries.map(() => []), context: 2048, counter });
  assert.ok(score.coverage.over_context > 0);
  assert.ok(score.coverage.gold_fully_represented < score.coverage.queries, 'some legacy gold spans were never fully embedded');
});

test('scoring separates a hit on the stored chunk from evidence that the embedder saw the needle', async t => {
  const counter = await fictionalCounter(t);
  const corpus = chunkEvalCorpus();
  const runFor = async name => {
    const chunker = (await manifest(name)).chunker;
    const derived = deriveCorpus(corpus, chunker, counter);
    const rankings = rank(corpus.queries.map(query => fakeVector(query.text)), derived.chunks.map(chunk => fakeVector(chunk.text)));
    return { eval_version: EVAL_VERSION, corpus_digest: 'c', manifest_digest: name,
      score: scoreRun({ corpus, derived, rankings, context: 2048, counter }) };
  };
  const reference = await runFor('legacy-reference-v1');
  const candidate = await runFor('default-v1');
  const dense = reference.score.per_query.filter(row => row.subset === 'dense');
  assert.ok(dense.some(row => row.stored_rank !== null && row.embedded_rank === null), 'a stored hit whose needle was truncated away');
  for (const row of candidate.score.per_query) assert.equal(row.gold_fully_represented, true);
  const comparison = compareRuns(reference, candidate);
  assert.equal(comparison.gates.full_coverage, true);
  assert.deepEqual(Object.keys(comparison.gates).sort(), ['dense_not_worse', 'full_coverage', 'overall_losses_at_most_one']);
  assert.equal(comparison.pass, Object.values(comparison.gates).every(Boolean));
  assert.throws(() => compareRuns(reference, { ...candidate, corpus_digest: 'other' }), /cannot be compared/);
});

test('a gold span counts as fully represented only when one fully embedded chunk contains all of it', () => {
  const corpus = { queries: [{ id: 'q', subset: 'dense', gold: { turn: 't', entry_id: 'e', start: 10, end: 20 } }] };
  const counter = { count: text => text.length };
  const score = chunks => scoreRun({ corpus, derived: { chunks, gaps: [] }, rankings: [[0]], context: 100, counter }).per_query[0];
  const chunk = (start, end) => ({ turn: 't', entry_id: 'e', start, end, text: 'x'.repeat(end - start), tokens: end - start });
  assert.equal(score([chunk(0, 11), chunk(19, 30)]).gold_fully_represented, false, 'two partial overlaps');
  assert.equal(score([chunk(0, 20)]).gold_fully_represented, true);
  assert.equal(score([chunk(0, 11)]).gold_covered, true);
});

test('ranking is exact cosine with a deterministic index tie-break', () => {
  assert.deepEqual(rank([[1, 0]], [[0, 1], [1, 0], [2, 0], [1, 1]], 3), [[1, 2, 3]]);
  // A refused chunk takes no place, and a refused query ranks nothing.
  assert.deepEqual(rank([[1, 0], null], [[0, 1], null, [2, 0]], 3), [[2, 0], []]);
});

// A remote embedder over the default local chunker, named exactly as its adapter names itself.
const remoteRow = async () => {
  const base = await manifest('default-v1');
  const identity = { provider: 'vertex', model: 'gemini-embedding-001', destination: 'fixture-location', dimensions: 64,
    task_pair: ['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY'], auto_truncate: false, representation: 'fixture' };
  return { ...base, name: 'vertex-fixture', role: 'experiment', embedder: { provider: 'vertex', model: 'gemini-embedding-001', dimensions: 64,
    context: 2048, full_input_witness: 'adapter', identity, adapter: { module: 'src/vertex-embedding.mjs', git_blob: 'a'.repeat(40) } } };
};

test('an adapter-witnessed embedder is only an experiment over a token chunker, with an exact non-truncating identity', async () => {
  const row = await remoteRow();
  assert.equal(validateManifest(row).qualification, 'unqualified');
  assert.throws(() => validateManifest({ ...row, role: 'default' }), /experiment over a token chunker|exactly DEFAULT_TREATMENT/);
  assert.throws(() => validateManifest({ ...row, embedder: { ...row.embedder, identity: { ...row.embedder.identity, auto_truncate: true } } }), /identity/);
  assert.throws(() => validateManifest({ ...row, embedder: { ...row.embedder, identity: { ...row.embedder.identity, dimensions: 768 } } }), /identity/);
  const legacy = (await manifest('legacy-reference-v1')).chunker;
  assert.throws(() => validateManifest({ ...row, chunker: legacy }), /token chunker/);
  // The adapter code is pinned: a module of this repository at a committed blob, nothing else.
  for (const adapter of [undefined, { module: '../elsewhere.mjs', git_blob: 'a'.repeat(40) }, { module: 'src/vertex-embedding.mjs', git_blob: 'short' }]) {
    assert.throws(() => validateManifest({ ...row, embedder: { ...row.embedder, adapter } }), /embedder.adapter/, JSON.stringify(adapter));
  }
  // Without the witness mode the old rule holds: a token policy must name the embedder deployment exactly.
  assert.throws(() => validateManifest({ ...row, embedder: { ...row.embedder, full_input_witness: undefined, tokenizer_sha256: 'x' } }), /exactly the evaluated embedder/);
});

// A fake adapter in the agreed shape: one input per call, a full-input row with evidence, or a typed refusal.
const fakeAdapter = (decide = () => 'ok') => {
  const calls = [];
  return { calls, async embed(inputs, { purpose }) {
    calls.push({ inputs, purpose });
    const outcome = decide(inputs[0], purpose);
    if (outcome !== 'ok' && typeof outcome === 'string') throw Object.assign(new Error(outcome), { code: outcome });
    return outcome === 'ok' ? { rows: [{ vector: fakeVector(inputs[0]), full_input: true,
      evidence: { kind: 'vertex_statistics', transport: 'vertex_predict', token_count: 10, limit: 2048 } }] } : outcome;
  } };
};

test('witnessed embedding sends one input per call with its purpose, credits only proven full input and counts typed refusals', async () => {
  const items = [{ text: 'alpha', purpose: 'document' }, { text: 'too long', purpose: 'document' }, { text: 'unproven', purpose: 'document' },
    { text: 'question', purpose: 'query' }];
  const adapter = fakeAdapter(text => (text === 'too long' ? 'embedding_input_too_long' : text === 'unproven' ? 'embedding_full_input_unverified' : 'ok'));
  const out = await embedWitnessed(adapter, items, { dimensions: 64, context: 2048 });
  assert.deepEqual(adapter.calls.map(call => [call.inputs.length, call.purpose]), [[1, 'document'], [1, 'document'], [1, 'document'], [1, 'query']]);
  assert.deepEqual(out.vectors.map(vector => vector !== null), [true, false, false, true]);
  assert.deepEqual([out.refusals, out.evidence_kinds], [{ embedding_full_input_unverified: 1, embedding_input_too_long: 1 }, ['vertex_predict/vertex_statistics']]);
  // A provider failure ends the run with only its code; a vector without a valid witness ends it too.
  await assert.rejects(embedWitnessed(fakeAdapter(() => 'model_request_failed'), [{ text: 'x', purpose: 'document' }], { dimensions: 64, context: 2048 }),
    { message: 'adapter failure: model_request_failed' });
  const leaky = { async embed() { throw new Error('Bearer secret-token at https://example.invalid/?key=1'); } };
  await assert.rejects(embedWitnessed(leaky, [{ text: 'x', purpose: 'document' }], { dimensions: 64, context: 2048 }), { message: 'adapter failure: unclassified' });
  // A code shaped like a code but not in the closed list is not printed either.
  const coded = { async embed() { throw Object.assign(new Error('x'), { code: 'secret_project_name' }); } };
  await assert.rejects(embedWitnessed(coded, [{ text: 'x', purpose: 'document' }], { dimensions: 64, context: 2048 }), { message: 'adapter failure: unclassified' });
  const row = { vector: fakeVector('x'), full_input: true, evidence: { kind: 'vertex_statistics', transport: 'vertex_predict', token_count: 10, limit: 2048 } };
  // Both closed bases are accepted, and only as their own pair.
  const gemini = { ...row, evidence: { ...row.evidence, transport: 'gemini_embed_content', kind: 'verified_precount_and_boundary' } };
  assert.deepEqual((await embedWitnessed(fakeAdapter(() => ({ rows: [gemini] })), [{ text: 'x', purpose: 'document' }], { dimensions: 64, context: 2048 })).evidence_kinds,
    ['gemini_embed_content/verified_precount_and_boundary']);
  for (const bad of [{ rows: [{ ...row, full_input: false }] }, { rows: [{ ...row, evidence: undefined }] },
    { rows: [{ ...row, evidence: { ...row.evidence, token_count: 2049 } }] }, { rows: [{ ...row, evidence: { ...row.evidence, limit: 4096, token_count: 3000 } }] },
    { rows: [{ ...row, evidence: { ...row.evidence, token_count: 0 } }] }, { rows: [{ ...row, evidence: { ...row.evidence, token_count: -5, limit: -1 } }] },
    { rows: [{ ...row, evidence: { ...row.evidence, extra: 1 } }] }, { rows: [{ ...row, extra: 1 }] }, { rows: { length: 1, 0: row } },
    { rows: [row], extra: 1 }, { rows: [row, row] }, { rows: [{ ...row, vector: [1, 2] }] },
    { rows: [{ ...row, evidence: { ...row.evidence, kind: 'verified_precount_and_boundary' } }] }, { rows: [{ ...row, evidence: { ...row.evidence, transport: 'other' } }] },
    { rows: [{ ...row, evidence: { ...row.evidence, kind: ['vertex_statistics'] } }] }]) {
    await assert.rejects(embedWitnessed(fakeAdapter(() => bad), [{ text: 'x', purpose: 'document' }], { dimensions: 64, context: 2048 }),
      /without a valid full-input witness/u, JSON.stringify(bad).slice(0, 80));
  }
  await assert.rejects(embedWitnessed(fakeAdapter(), items, { dimensions: 0, context: 2048 }), /positive dimensions/);
  // The admission hook's per-request signal reaches the adapter.
  const signals = [];
  const signalled = { async embed(inputs, { signal }) { signals.push(signal); return fakeAdapter().embed(inputs, { purpose: 'document' }); } };
  const signal = AbortSignal.timeout(60_000);
  await embedWitnessed(signalled, items.slice(0, 1), { dimensions: 64, context: 2048, admit: async () => ({ signal }) });
  assert.deepEqual(signals, [signal]);
  // The admission hook runs before every request and can stop the run.
  let admitted = 0;
  await assert.rejects(embedWitnessed(fakeAdapter(), items, { dimensions: 64, context: 2048, admit: async () => { if (++admitted > 2) throw new Error('budget'); } }), /budget/);
});

test('a chunk the adapter refused is never represented, and its row fails the full-coverage gate', async t => {
  const counter = await fictionalCounter(t);
  const corpus = chunkEvalCorpus();
  const derived = deriveCorpus(corpus, { ...DEFAULT_TREATMENT }, counter);
  // Every chunk that contains the first gold span; overlapping chunks can each hold it.
  const { gold } = corpus.queries[0];
  const goldChunks = derived.chunks.flatMap((chunk, index) => (chunk.turn === gold.turn && chunk.entry_id === gold.entry_id
    && chunk.start <= gold.start && gold.end <= chunk.end ? [index] : []));
  const runWith = refused => {
    const chunks = derived.chunks.map((chunk, index) => ({ ...chunk, witnessed: !refused.includes(index) }));
    const chunkVectors = chunks.map(chunk => (chunk.witnessed ? fakeVector(chunk.text) : null));
    const rankings = rank(corpus.queries.map(query => fakeVector(query.text)), chunkVectors);
    return { eval_version: EVAL_VERSION, corpus_digest: 'c', manifest_digest: `r${refused.length}`,
      score: scoreRun({ corpus, derived: { chunks, gaps: [] }, rankings, context: 2048, counter }) };
  };
  const full = runWith([]);
  const partial = runWith(goldChunks);
  assert.ok(goldChunks.length >= 1);
  assert.equal(full.score.coverage.unwitnessed, 0);
  assert.equal(partial.score.coverage.unwitnessed, goldChunks.length);
  assert.equal(partial.score.per_query[0].gold_fully_represented, false);
  assert.equal(compareRuns(full, partial).gates.full_coverage, false);
  assert.equal(compareRuns(partial, full).gates.full_coverage, true);
});

test('a refused query fails the full-coverage gate even when the scores would pass', async t => {
  const counter = await fictionalCounter(t);
  const corpus = chunkEvalCorpus();
  const derived = deriveCorpus(corpus, { ...DEFAULT_TREATMENT }, counter);
  const chunks = derived.chunks.map(chunk => ({ ...chunk, witnessed: true }));
  const chunkVectors = chunks.map(chunk => fakeVector(chunk.text));
  const runWith = refused => {
    const queryVectors = corpus.queries.map((query, index) => (refused.includes(index) ? null : fakeVector(query.text)));
    return { eval_version: EVAL_VERSION, corpus_digest: 'c', manifest_digest: `q${refused.length}`,
      score: scoreRun({ corpus, derived: { chunks, gaps: [] }, rankings: rank(queryVectors, chunkVectors), context: 2048, counter,
        queryEmbedded: queryVectors.map(vector => vector !== null) }) };
  };
  const full = runWith([]);
  // Refuse a query the reference already missed at rank 5, so the losses and dense gates alone would still pass.
  const missed = full.score.per_query.findIndex(row => row.embedded_rank === null || row.embedded_rank > 5);
  const refused = runWith([missed >= 0 ? missed : 0]);
  const comparison = compareRuns(full, refused);
  assert.equal(refused.score.coverage.queries_unembedded, 1);
  assert.equal(comparison.gates.full_coverage, false);
  assert.equal(comparison.pass, false);
  assert.equal(full.score.coverage.queries_unembedded, 0);
});
