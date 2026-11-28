import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkPolicy } from '../src/chunk-policy.mjs';
import { readGgufTokenizer, RENDER_CONTRACT } from '../src/tokenizer.mjs';
import { countCaps, countOverContext, OVER_CONTEXT_COUNT } from '../src/over-context-count.mjs';
import { fictionalVocabulary, ggufTokenizerFile } from './helpers/gguf-fixture.mjs';

// Fictional tokenizer: "abcd" is one token and each space one token, so n words render to 2n + 1 tokens with BOS and EOS.
const words = count => Array.from({ length: count }, () => 'abcd').join(' ');
const CAPS = { max_rows: 1000, max_text_bytes: 1_000_000, max_pages: 100, page_size: 3, max_seconds: 60, transaction_timeout_ms: 1000 };

async function fixturePolicy(t, { cap = 21, context = 41 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'source-memory-over-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gguf = join(dir, 'fiction.gguf');
  await writeFile(gguf, ggufTokenizerFile(fictionalVocabulary(), { context: 64 }));
  const { sha256 } = await readGgufTokenizer(gguf);
  const blob = `sha256:${createHash('sha256').update(await readFile(gguf)).digest('hex')}`;
  const verified = { [sha256]: { model: 'embeddinggemma', served_blob: blob, render: RENDER_CONTRACT, serving_revision: 'fiction-rev-1',
    context, parity_evidence_sha256: 'e'.repeat(64) } };
  const embedding = { url: 'http://127.0.0.1:9/v1/embeddings', model: 'embeddinggemma', dimensions: 2, ollama_context_revision: 'fiction-rev-1',
    chunk_token_cap: cap, tokenizer: { gguf, sha256 } };
  return chunkPolicy({ embedding }, verified);
}

// An in-memory reader over rows sorted by uid; `hooks` can fail or change the store between reads.
function memoryReader(rows, hooks = {}) {
  const sorted = [...rows].sort((a, b) => a.uid.localeCompare(b.uid));
  let totals = 0;
  return {
    async total() { totals++; if (hooks.total) return hooks.total(totals, sorted.length); return sorted.length; },
    async page(after, limit) {
      if (hooks.page) await hooks.page(after);
      return sorted.filter(row => after === null || row.uid > after).slice(0, limit).map(row => ({ ...row }));
    },
  };
}

const row = (uid, count, current_vector = true) => ({ uid, text: words(count), current_vector });

test('a complete pass classifies every chunk against the cap and the context, and emits counts only', async t => {
  const policy = await fixturePolicy(t);
  // 2n+1 tokens: 2 words = 5 (9 bytes, bound 11: skipped), 10 = 21 (at cap), 11 = 23, 20 = 41 (at context), 21 = 43, 40 = 81, 70 = 141.
  const rows = [row('u01', 2), row('u02', 10), row('u03', 11), row('u04', 20), row('u05', 21), row('u06', 40, false), row('u07', 70), row('u08', 21, false)];
  const report = await countOverContext({ policy, reader: memoryReader(rows), caps: CAPS });
  assert.equal(report.contract, OVER_CONTEXT_COUNT);
  assert.equal(report.status, 'complete');
  assert.equal(report.cut, 'separate_pages');
  assert.deepEqual([report.chunks, report.within_cap, report.over_cap_within_context, report.over_context_with_current_vector,
    report.over_context_without_current_vector], [8, 2, 2, 2, 2]);
  assert.equal(report.exactly_counted, 7, 'only text whose bound exceeds the cap is counted exactly');
  assert.deepEqual(report.excess_tokens, { sum: (43 - 41) * 2 + (81 - 41) + (141 - 41), denominator_tokens: 43 * 2 + 81 + 141 });
  assert.deepEqual(report.over_context_histogram.map(bucket => [bucket.low, bucket.high, bucket.chunks]),
    [[42, 61, 2], [62, 82, 1], [83, 123, 0], [124, null, 1]]);
  assert.deepEqual(report.totals, { before: 8, after: 8 });
  assert.equal(report.pages, 3);
  assert.equal(report.contract_binding.context, 41);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('abcd') && !/u0\d/.test(serialized), 'no text or identifier in the report');
});

test('every cap and failure yields incomplete with no totals', async t => {
  const policy = await fixturePolicy(t);
  const rows = Array.from({ length: 7 }, (_, i) => row(`u${i}`, 30));
  const run = (reader, caps = {}, clock) => countOverContext({ policy, reader, caps: { ...CAPS, ...caps }, ...(clock ? { clock } : {}) });
  const cases = [
    [await run(memoryReader(rows), { max_rows: 6 }), 'cap_rows'],
    [await run(memoryReader(rows), { max_text_bytes: 200 }), 'cap_text_bytes'],
    [await run(memoryReader(rows), { max_pages: 2 }), 'cap_pages'],
    [await run(memoryReader(rows), {}, (() => { let now = 0; return () => (now += 30_000); })()), 'cap_seconds'],
    [await run(memoryReader(rows, { total: () => { throw new Error('down'); } })), 'read_failed'],
    [await run(memoryReader(rows, { page: () => { throw new Error('down'); } })), 'read_failed'],
    [await run(memoryReader(rows, { total: (call, n) => call === 1 ? n : n + 1 })), 'total_changed'],
    [await run({ total: async () => 2, page: async () => [{ uid: 'b', text: 'x', current_vector: true }, { uid: 'a', text: 'x', current_vector: true }] }), 'read_failed'],
    [await run({ total: async () => 1, page: async () => [{ uid: 'a', text: 'x' }] }), 'read_failed'],
  ];
  for (const [report, reason] of cases) {
    assert.equal(report.status, 'incomplete', reason);
    assert.equal(report.reason, reason);
    assert.deepEqual(Object.keys(report).sort(), ['contract', 'progress', 'reason', 'status']);
  }
});

test('an unverified tokenizer contract yields incomplete without reading the store', async t => {
  const policy = chunkPolicy({ embedding: { url: 'http://127.0.0.1:9/v1/embeddings', model: 'embeddinggemma', dimensions: 2,
    ollama_context_revision: 'fiction-rev-1', tokenizer: { gguf: '/nonexistent.gguf', sha256: 'a'.repeat(64) } } }, {});
  let reads = 0;
  const report = await countOverContext({ policy, reader: { total: async () => { reads++; return 0; }, page: async () => { reads++; return []; } }, caps: CAPS });
  assert.deepEqual([report.status, report.reason, reads], ['incomplete', 'tokenizer_unavailable', 0]);
  const legacy = await countOverContext({ policy: chunkPolicy({}), reader: memoryReader([]), caps: CAPS });
  assert.equal(legacy.reason, 'tokenizer_unavailable');
});

test('caps are finite, absolute and all required', () => {
  assert.deepEqual(countCaps(CAPS), CAPS);
  for (const key of Object.keys(CAPS)) {
    const { [key]: _missing, ...rest } = CAPS;
    assert.throws(() => countCaps(rest), { code: 'invalid_input' }, key);
  }
  assert.throws(() => countCaps({ ...CAPS, page_size: 501 }), { code: 'invalid_input' });
  assert.throws(() => countCaps({ ...CAPS, max_seconds: Infinity }), { code: 'invalid_input' });
});
