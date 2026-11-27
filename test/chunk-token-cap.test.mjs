import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_MAX_BYTES, chunkEntries, chunkEntriesTokenCapped, digest, normalizeTurn } from '../src/core.mjs';
import { readGgufTokenizer, RENDER_CONTRACT, sentencePiece, TokenizerError } from '../src/tokenizer.mjs';
import {
  chunkManifest, chunkPolicy, DEFAULT_TREATMENT, deriveChunks, LEGACY_POLICY, MANIFEST_CONTRACT, QUALIFIED_TREATMENTS, TOKEN_POLICY,
} from '../src/chunk-policy.mjs';
import { Memory } from '../src/memory.mjs';
import { fictionalVocabulary, ggufTokenizerFile } from './helpers/gguf-fixture.mjs';

async function fixtureFile(t, buffer = ggufTokenizerFile(fictionalVocabulary())) {
  const dir = await mkdtemp(join(tmpdir(), 'source-memory-tokenizer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'fiction.gguf');
  await writeFile(path, buffer);
  return path;
}

async function fixtureCounter(t, options) {
  const spec = await readGgufTokenizer(await fixtureFile(t, ggufTokenizerFile(fictionalVocabulary(), options)));
  return sentencePiece(spec);
}

const turnOf = (...texts) => normalizeTurn({ source: 'fiction', conversation_id: 'c', turn_id: 't',
  entries: texts.map((text, index) => ({ id: `e${index}`, role: 'user', text })) });

test('the GGUF reader returns tokenizer metadata and a digest over exactly the encoder keys', async t => {
  const vocabulary = fictionalVocabulary();
  const spec = await readGgufTokenizer(await fixtureFile(t, ggufTokenizerFile(vocabulary)));
  assert.deepEqual([spec.model, spec.architecture, spec.context_length, spec.bos, spec.eos, spec.add_bos, spec.add_eos],
    ['llama', 'fiction', 64, 2, 1, true, true]);
  assert.equal(spec.tokens.length, vocabulary.tokens.length);
  assert.match(spec.sha256, /^[0-9a-f]{64}$/);
  const unrelated = await readGgufTokenizer(await fixtureFile(t, ggufTokenizerFile(vocabulary, { context: 128 })));
  assert.equal(unrelated.sha256, spec.sha256, 'a non-tokenizer key does not change the tokenizer digest');
  const rescored = { ...vocabulary, scores: vocabulary.scores.map((score, id) => vocabulary.tokens[id] === 'cd' ? -0.1 : score) };
  assert.notEqual((await readGgufTokenizer(await fixtureFile(t, ggufTokenizerFile(rescored)))).sha256, spec.sha256);
  assert.notEqual((await readGgufTokenizer(await fixtureFile(t, ggufTokenizerFile(vocabulary, { addEos: false })))).sha256, spec.sha256);
});

test('an unreadable or malformed tokenizer fails with a typed reason, not a transport code', async t => {
  await assert.rejects(readGgufTokenizer('/nonexistent/fiction.gguf'), error => error instanceof TokenizerError && error.reason === 'missing');
  await assert.rejects(readGgufTokenizer(await fixtureFile(t, Buffer.from('NOPE0000'))), error => error instanceof TokenizerError && error.reason === 'invalid');
  const truncated = ggufTokenizerFile(fictionalVocabulary()).subarray(0, 300);
  await assert.rejects(readGgufTokenizer(await fixtureFile(t, truncated)), error => error instanceof TokenizerError && error.reason === 'invalid');
});

test('counts reproduce the server encoder: specials first, highest-score merges, byte fallback, BOS and EOS', async t => {
  const counter = await fixtureCounter(t);
  assert.equal(counter.overhead, 2);
  const cases = {
    '': 2,
    abcd: 3, // whole fragment in the vocabulary
    abcdx: 4, // cd, then ab, then abcd; x stays
    'a b': 5, // the space is a special and splits the text
    'a\n\nb': 6, // each newline is its own special
    '\u00e9': 4, // two byte-fallback tokens
    '<start_of_turn>a': 4,
    '\uD800': 5, // an unpaired surrogate reaches the server as U+FFFD, three bytes
    xyxy: 6,
  };
  for (const [text, expected] of Object.entries(cases)) assert.equal(counter.count(text), expected, JSON.stringify(text));
  const noEos = await fixtureCounter(t, { addEos: false });
  assert.equal(noEos.count('abcd'), 2);
});

test('the byte bound never undercounts', async t => {
  const counter = await fixtureCounter(t);
  const alphabet = ['a', 'b', 'c', 'd', ' ', '\n', '\u00e9', '\u65e5', '\u{1F600}', 'x', '<start_of_turn>', '\u0301'];
  let seed = 7;
  for (let i = 0; i < 300; i++) {
    let text = '';
    for (let j = 0; j < 40; j++) { seed = (seed * 1103515245 + 12345) % 2 ** 31; text += alphabet[seed % alphabet.length]; }
    assert.ok(counter.count(text) <= counter.bound(text), JSON.stringify(text));
  }
});

function assertChunkInvariants(turn, { chunks, gaps }, counter, cap) {
  chunks.forEach((chunk, ordinal) => {
    const entry = turn.entries.find(row => row.id === chunk.entry_id);
    assert.equal(chunk.ordinal, ordinal);
    assert.equal(chunk.text, entry.text.slice(chunk.start, chunk.end));
    assert.equal(chunk.token_count, counter.count(chunk.text));
    assert.ok(chunk.token_count <= cap, `chunk ${ordinal} has ${chunk.token_count} > ${cap}`);
    assert.ok(Buffer.byteLength(chunk.text) <= CHUNK_MAX_BYTES);
    assert.ok(!/[\uDC00-\uDFFF]/u.test(entry.text[chunk.start] ?? '') || chunk.start === 0, 'no split surrogate at start');
  });
  for (const entry of turn.entries) {
    // Every non-space character is covered by a chunk or a gap.
    const covered = new Uint8Array(entry.text.length);
    for (const span of [...chunks, ...gaps].filter(row => row.entry_id === entry.id)) covered.fill(1, span.start, span.end);
    for (let at = 0; at < entry.text.length; at++) if (/\S/u.test(entry.text[at])) assert.equal(covered[at], 1, `${entry.id}@${at} uncovered`);
  }
}

test('token-capped chunks fit the exact rendered count at, below and above the boundary', async t => {
  const counter = await fixtureCounter(t);
  const text = Array.from({ length: 40 }, () => 'abcd').join(' ');
  for (const cap of [20, 21, 22, 81, 200]) {
    const turn = turnOf(text);
    const result = chunkEntriesTokenCapped(turn, 256, 0, counter, cap);
    assertChunkInvariants(turn, result, counter, cap);
    assert.deepEqual(result.gaps, []);
    // n words and n-1 spaces plus BOS/EOS: the largest window is floor((cap - 1) / 2) words.
    const words = Math.min(40, Math.floor((cap - 1) / 2));
    assert.equal(result.chunks[0].token_count, 2 * words + 1, `cap ${cap}`);
    if (words < 40) assert.equal(counter.count(text.split(' ').slice(0, words + 1).join(' ')), 2 * words + 3);
  }
});

test('overlap is recounted with the final text and never exceeds half the previous window', async t => {
  const counter = await fixtureCounter(t);
  const turn = turnOf(Array.from({ length: 100 }, () => 'abcd').join(' '));
  const result = chunkEntriesTokenCapped(turn, 256, 32, counter, 21);
  assertChunkInvariants(turn, result, counter, 21);
  for (let i = 1; i < result.chunks.length; i++) {
    const previous = result.chunks[i - 1], chunk = result.chunks[i];
    assert.ok(chunk.start > previous.start, 'positive progress');
    const shared = turn.entries[0].text.slice(chunk.start, previous.end).split(' ').filter(Boolean).length;
    const window = previous.text.split(' ').length;
    assert.ok(shared <= Math.floor(window / 2), `chunk ${i} shares ${shared} of ${window}`);
  }
  assert.ok(result.chunks.length < 25, `${result.chunks.length} chunks`);
});

test('long units split on grapheme boundaries and keep combining marks and emoji whole', async t => {
  const counter = await fixtureCounter(t);
  const unit = 'e\u0301'.repeat(30) + '\u{1F469}\u200D\u{1F4BB}'.repeat(5) + '\u65e5\u672c'.repeat(20);
  const turn = turnOf(`x ${unit} y`);
  // 14 tokens fit the 11-byte ZWJ sequence on byte fallback, so no grapheme needs a code-point split.
  const result = chunkEntriesTokenCapped(turn, 256, 4, counter, 14);
  assertChunkInvariants(turn, result, counter, 14);
  assert.deepEqual(result.gaps, []);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const boundaries = new Set([...segmenter.segment(turn.entries[0].text)].map(part => part.index));
  boundaries.add(turn.entries[0].text.length);
  for (const chunk of result.chunks) assert.ok(boundaries.has(chunk.start) && boundaries.has(chunk.end), `${chunk.start}-${chunk.end}`);
});

test('a unit that cannot fit even alone becomes a typed gap, and windows never span it', async t => {
  const counter = await fixtureCounter(t);
  // With cap 3 a two-byte character needs 2 + 2 tokens; single letters and the space fit.
  const turn = turnOf('ab \u00e9\u00e9 cd', 'abcd');
  const result = chunkEntriesTokenCapped(turn, 256, 0, counter, 3);
  assertChunkInvariants(turn, result, counter, 3);
  assert.deepEqual(result.gaps, [{ entry_id: 'e0', start: 3, end: 5, cause: 'unsplittable_unit' }]);
  for (const chunk of result.chunks.filter(row => row.entry_id === 'e0')) assert.ok(chunk.end <= 3 || chunk.start >= 5);
  assert.deepEqual(result.chunks.filter(chunk => chunk.entry_id === 'e1').map(chunk => chunk.text), ['abcd']);
});

test('a derivation over the row bound is one whole-entry gap per nonblank entry, never a clipped manifest', async t => {
  const counter = await fixtureCounter(t);
  const turn = turnOf(Array.from({ length: 50 }, () => 'abcd').join(' '), '   ');
  const result = chunkEntriesTokenCapped(turn, 8, 0, counter, 3, 10);
  assert.deepEqual(result, { chunks: [], gaps: [{ entry_id: 'e0', start: 0, end: turn.entries[0].text.length, cause: 'derivation_bound_exceeded' }] });
});

test('the byte cap still applies under a token cap', async t => {
  const counter = await fixtureCounter(t);
  const turn = turnOf(Array.from({ length: 3000 }, () => 'abcd').join(' '));
  const result = chunkEntriesTokenCapped(turn, 4096, 0, counter, 100_000);
  assertChunkInvariants(turn, result, counter, 100_000);
  assert.ok(result.chunks.length >= 2 && result.chunks.every(chunk => Buffer.byteLength(chunk.text) <= CHUNK_MAX_BYTES));
});

test('legacy byte chunking is unchanged by the token path', () => {
  const turn = turnOf(`${'w'.repeat(9000)} tail`, 'one two three four five six seven eight nine ten');
  assert.deepEqual(chunkEntries(turn, 8, 2).map(({ start, end, ordinal }) => [ordinal, start, end]),
    [[0, 0, 8192], [1, 8192, 9005], [2, 0, 39], [3, 28, 48]]);
});

const SERVED = { model: 'fixture', ollama_context_revision: 'fiction-rev-1' };
const VERIFIED = (sha256, blob = `sha256:${'f'.repeat(64)}`) => ({ [sha256]: { model: 'fixture', served_blob: blob, render: RENDER_CONTRACT,
  serving_revision: 'fiction-rev-1', context: 64, parity_evidence_sha256: 'e'.repeat(64) } });
const blobOf = async path => `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
const served = (tokenizer, extra = {}) => ({ embedding: { ...SERVED, tokenizer, ...extra } });

test('chunk policy: legacy without a tokenizer contract, refusal of a stray or invalid cap, 1920 by default', async t => {
  assert.deepEqual(chunkPolicy({}).descriptor, { policy: LEGACY_POLICY, words: 256, overlap: 32, byte_cap: CHUNK_MAX_BYTES });
  assert.equal(chunkPolicy({}).qualification, null);
  assert.throws(() => chunkPolicy({ embedding: { chunk_token_cap: 1920 } }), { code: 'invalid_chunk_token_cap' });
  for (const tokenizer of [null, 'x', { gguf: 'relative', sha256: 'a'.repeat(64) }, { gguf: '/abs', sha256: 'A'.repeat(64) }]) {
    assert.throws(() => chunkPolicy({ embedding: { tokenizer } }), { code: 'invalid_chunk_tokenizer' });
  }
  const sha256 = 'b'.repeat(64);
  const configured = chunkPolicy({ embedding: { model: 'embeddinggemma:latest', tokenizer: { gguf: '/fiction.gguf', sha256 } } });
  assert.equal(configured.descriptor.token_cap, 1920);
  assert.equal(configured.descriptor.policy, TOKEN_POLICY);
  assert.equal(configured.descriptor.model, 'embeddinggemma');
  assert.equal(configured.qualification, 'unqualified');
  for (const cap of [0, -1, 1.5, '1920', 65]) {
    assert.throws(() => chunkPolicy(served({ gguf: '/f', sha256 }, { chunk_token_cap: cap }), VERIFIED(sha256)),
      { code: 'invalid_chunk_token_cap' }, String(cap));
  }
  assert.equal(chunkPolicy(served({ gguf: '/f', sha256 }, { chunk_token_cap: 64 }), VERIFIED(sha256)).descriptor.context, 64);
});

test('a tokenizer digest verifies nothing unless the served model, rendering and serving revision also match', () => {
  const sha256 = 'b'.repeat(64);
  const entry = VERIFIED(sha256)[sha256];
  const context = (verified, extra) => chunkPolicy(served({ gguf: '/f', sha256 }, { chunk_token_cap: 16, ...extra }), verified).descriptor.context;
  assert.equal(context(VERIFIED(sha256)), 64);
  assert.equal(context({ [sha256]: { context: 64 } }), null, 'digest and context alone');
  assert.equal(context({ [sha256]: { ...entry, render: 'other/1' } }), null);
  assert.equal(context(VERIFIED(sha256), { model: 'other' }), null);
  assert.equal(context(VERIFIED(sha256), { ollama_context_revision: 'fiction-rev-2' }), null);
  assert.equal(context(VERIFIED(sha256), { ollama_context_revision: undefined }), null);
});

test('no treatment is qualified until a reviewed evaluation lists its digest', () => {
  assert.deepEqual(QUALIFIED_TREATMENTS, {});
  const revision = DEFAULT_TREATMENT.serving_revision;
  const entry = { model: 'embeddinggemma', served_blob: DEFAULT_TREATMENT.served_blob, render: RENDER_CONTRACT, serving_revision: revision,
    context: 2048, parity_evidence_sha256: 'e'.repeat(64) };
  const verified = { [DEFAULT_TREATMENT.tokenizer_sha256]: entry };
  const embedding = { url: 'http://127.0.0.1:11434/v1/embeddings', model: 'embeddinggemma', dimensions: 768, ollama_context_revision: revision,
    tokenizer: { gguf: '/f', sha256: DEFAULT_TREATMENT.tokenizer_sha256 } };
  const policy = chunkPolicy({ embedding }, verified);
  assert.deepEqual(policy.descriptor, DEFAULT_TREATMENT);
  assert.equal(policy.qualification, 'unqualified');
  // Another serving revision, endpoint, transport or vector shape is another treatment, never sharing a qualification.
  const variants = [
    [{ ...embedding, ollama_context_revision: 'other-rev' }, { [DEFAULT_TREATMENT.tokenizer_sha256]: { ...entry, serving_revision: 'other-rev' } }],
    [{ ...embedding, url: 'http://127.0.0.1:11434/api/embed' }, verified],
    [{ ...embedding, ollama_transport: 'native_no_truncate' }, verified],
    [{ ...embedding, dimensions: 256 }, verified],
  ];
  for (const [variant, trusted] of variants) {
    const other = chunkPolicy({ embedding: variant }, trusted);
    assert.equal(other.descriptor.context, 2048);
    assert.notEqual(other.digest, policy.digest, JSON.stringify(variant));
  }
  assert.equal(chunkPolicy({ embedding }, { [DEFAULT_TREATMENT.tokenizer_sha256]: { ...entry, parity_evidence_sha256: undefined } })
    .descriptor.context, null, 'a verified entry names its parity evidence');
});

test('an unusable tokenizer keeps the source and records a typed gap per nonblank entry', async t => {
  const path = await fixtureFile(t);
  const { sha256 } = await readGgufTokenizer(path);
  const blob = await blobOf(path);
  const turn = turnOf('abcd abcd', '  ', 'cd');
  const cases = [
    [{ gguf: '/nonexistent/fiction.gguf', sha256 }, VERIFIED(sha256, blob), 'missing'],
    [{ gguf: path, sha256: 'c'.repeat(64) }, VERIFIED('c'.repeat(64), blob), 'digest_mismatch'],
    // The tokenizer matches, but the file is not the verified served artifact.
    [{ gguf: path, sha256 }, VERIFIED(sha256), 'digest_mismatch'],
    [{ gguf: path, sha256 }, {}, 'unverified'],
  ];
  for (const [tokenizer, verified, reason] of cases) {
    const derived = await deriveChunks(turn, chunkPolicy(served(tokenizer, { chunk_token_cap: 21 }), verified));
    assert.deepEqual(derived, { chunks: [], gaps: [
      { entry_id: 'e0', start: 0, end: 9, cause: 'tokenizer_unavailable', reason },
      { entry_id: 'e2', start: 0, end: 2, cause: 'tokenizer_unavailable', reason },
    ] }, reason);
  }
  const ready = await deriveChunks(turn, chunkPolicy(served({ gguf: path, sha256 }, { chunk_token_cap: 21 }), VERIFIED(sha256, blob)));
  assert.deepEqual(ready.chunks.map(chunk => [chunk.entry_id, chunk.text, chunk.token_count]), [['e0', 'abcd abcd', 5], ['e2', 'cd', 3]]);
  const legacy = await deriveChunks(turn, chunkPolicy({}));
  assert.deepEqual(legacy.chunks.map(chunk => [chunk.text, chunk.token_count]), [['abcd abcd', null], ['cd', null]]);
});

test('the manifest binds scope, turn and policy and records spans and digests, not text', async t => {
  const turn = turnOf('abcd \u00e9 cd');
  const policy = chunkPolicy({});
  const chunks = [{ uid: 'chunk_1', ordinal: 0, entry_id: 'e0', start: 0, end: 4, text: 'abcd', token_count: null }];
  const gaps = [{ entry_id: 'e0', start: 5, end: 6, cause: 'unsplittable_unit' }];
  const manifest = chunkManifest({ scope: 'fiction', turnUid: 'turn_1', turnHash: 'h', turn, policy, chunks, gaps });
  const body = JSON.parse(manifest.body);
  assert.equal(manifest.digest, digest(manifest.body));
  assert.deepEqual(body, { contract: MANIFEST_CONTRACT, scope: 'fiction', turn_uid: 'turn_1', turn_hash: 'h', policy: policy.descriptor,
    policy_digest: policy.digest, qualification: null,
    chunks: [{ uid: 'chunk_1', ordinal: 0, entry_id: 'e0', start: 0, end: 4, text_sha256: digest('abcd'), token_count: null }],
    gaps: [{ entry_id: 'e0', start: 5, end: 6, cause: 'unsplittable_unit', text_sha256: digest('\u00e9') }] });
  assert.ok(!manifest.body.includes('abcd'));
  assert.equal(chunkManifest({ scope: 'fiction', turnUid: 'turn_1', turnHash: 'h', turn, policy,
    chunks: Array.from({ length: 8193 }, () => chunks[0]), gaps: [] }), null);
});

test('Memory.ingest derives only when the store calls back, so a replay never loads the tokenizer', async t => {
  const calls = [];
  const store = {
    async ingest(scope, turn, derive, policy) {
      calls.push(policy.descriptor.policy);
      if (scope === 'replay') return { id: 'turn_1', replayed: true, retained: true };
      const derived = await derive();
      return { id: 'turn_1', replayed: false, retained: true, chunks: derived.chunks.length, gaps: derived.gaps.length };
    },
    async status() { return { unindexed: 0 }; },
  };
  const config = { scopes: { write: ['replay', 'first'], read: [] },
    embedding: { tokenizer: { gguf: '/nonexistent/fiction.gguf', sha256: 'd'.repeat(64) } }, index_on_write: false };
  const memory = new Memory(config, store);
  const input = { source: 'fiction', conversation_id: 'c', turn_id: 't', entries: [{ id: 'e', role: 'user', text: 'abcd' }] };
  const replay = await memory.ingest('replay', input);
  assert.equal(replay.replayed, true);
  const first = await memory.ingest('first', input);
  assert.deepEqual([first.chunks, first.gaps], [0, 1]);
  assert.deepEqual(calls, [TOKEN_POLICY, TOKEN_POLICY]);
  await assert.rejects(new Memory({ ...config, embedding: { chunk_token_cap: 10 } }, store).ingest('first', input),
    error => error.code === 'invalid_chunk_token_cap' && error.stage === 'before_write');
});

test('index never reports ready while derived gaps exist, and does not count them as missing vector rows', async () => {
  const store = {
    async pendingEmbeddings() { return []; },
    async markOversizedChunks() {},
    async status() { return { unindexed: 0 }; },
    gaps: 2,
    async derivedGaps() { return this.gaps; },
  };
  const config = { scopes: { write: ['fiction'], read: ['fiction'] },
    embedding: { url: 'http://127.0.0.1:9/v1/embeddings', model: 'fixture', dimensions: 2 } };
  const memory = new Memory(config, store);
  const reply = await memory.index('fiction');
  assert.deepEqual([reply.status, reply.reason, reply.derived_gaps, reply.source_retained], ['unavailable', 'derived_chunk_gaps', 2, true]);
  store.gaps = 0;
  assert.equal((await memory.index('fiction')).status, 'ready');
});
