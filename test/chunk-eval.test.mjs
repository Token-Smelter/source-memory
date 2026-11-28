import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_MAX_BYTES } from '../src/core.mjs';
import { DEFAULT_TREATMENT } from '../src/chunk-policy.mjs';
import { readGgufTokenizer, sentencePiece } from '../src/tokenizer.mjs';
import { compareRuns, deriveCorpus, EVAL_VERSION, rank, scoreRun, validateManifest } from '../scripts/chunk-eval-core.mjs';
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

test('the native-transport row is a named, unqualified experiment of the default chunker', async () => {
  const native = validateManifest(await manifest('native-r1-v1'));
  const fixed = validateManifest(await manifest('default-v1'));
  assert.deepEqual([native.role, native.qualification, native.chunker.transport], ['experiment', 'unqualified', 'native_no_truncate']);
  const { transport: _native, ...nativeRest } = native.chunker;
  const { transport: _compat, ...defaultRest } = fixed.chunker;
  assert.deepEqual(nativeRest, defaultRest, 'only the transport differs from the default row');
  assert.notEqual(native.digest, fixed.digest);
  const asDefault = { ...await manifest('native-r1-v1'), role: 'default' };
  assert.throws(() => validateManifest(asDefault), /exactly DEFAULT_TREATMENT/);
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
  assert.deepEqual(compareRuns(candidate, candidate).rank_changes, [], 'a row compared with itself moves no query');
  assert.ok(comparison.rank_changes.length > 0);
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
});
