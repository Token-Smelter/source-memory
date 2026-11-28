import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkPolicy, DEFAULT_TREATMENT } from '../src/chunk-policy.mjs';
import { MemoryError } from '../src/core.mjs';
import { readGgufTokenizer, RENDER_CONTRACT } from '../src/tokenizer.mjs';
import { countCaps, countOverContext, neo4jChunkReader, OVER_CONTEXT_COUNT, runOverContextCount } from '../src/over-context-count.mjs';
import { embeddingIdentity } from '../src/models.mjs';
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

// An in-memory reader over rows sorted by uid. It records the timeouts it is given; `hooks` can fail, stall or change state.
function memoryReader(rows, hooks = {}) {
  const sorted = [...rows].sort((a, b) => a.uid.localeCompare(b.uid));
  const timeouts = [];
  let totals = 0;
  return {
    timeouts,
    async total(timeout) {
      timeouts.push(timeout);
      totals++;
      if (hooks.total) return hooks.total(totals, sorted.length);
      return sorted.length;
    },
    async page(after, limit, timeout) {
      timeouts.push(timeout);
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
  assert.equal(report.transfer_and_database_work, 'not_measured');
  assert.equal(report.contract_binding.context, 41);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('abcd') && !/u0\d/.test(serialized), 'no text or identifier in the report');
});

test('caps hold at their exact edges and refuse one past them', async t => {
  const policy = await fixturePolicy(t);
  const rows = Array.from({ length: 6 }, (_, i) => row(`u${i}`, 2));
  const bytes = rows.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
  const run = caps => countOverContext({ policy, reader: memoryReader(rows), caps: { ...CAPS, ...caps } });
  assert.equal((await run({ max_rows: 6 })).status, 'complete');
  assert.equal((await run({ max_rows: 5 })).reason, 'cap_rows');
  assert.equal((await run({ max_text_bytes: bytes })).status, 'complete');
  assert.equal((await run({ max_text_bytes: bytes - 1 })).reason, 'cap_text_bytes');
  // Six rows in pages of three: two full pages and an empty third.
  assert.equal((await run({ max_pages: 3 })).status, 'complete');
  assert.equal((await run({ max_pages: 2 })).reason, 'cap_pages');
});

test('one monotonic budget covers every read and the processing, and a late result is refused', async t => {
  const policy = await fixturePolicy(t);
  const rows = Array.from({ length: 4 }, (_, i) => row(`u${i}`, 2));
  let now = 0;
  const clock = () => now;
  // Each read takes 10 s of a 60 s budget; every timeout handed out must fit what remains.
  const reader = memoryReader(rows, { total: (call, n) => { now += 10_000; return n; }, page: () => { now += 10_000; } });
  const timeouts = reader.timeouts;
  const report = await countOverContext({ policy, reader, caps: { ...CAPS, page_size: 2, transaction_timeout_ms: 30_000 }, clock });
  assert.equal(report.status, 'complete');
  assert.deepEqual(timeouts, [30_000, 30_000, 30_000, 30_000, 20_000]);
  // The final total returns after the deadline: every read succeeded, yet the pass is refused.
  now = 0;
  const late = memoryReader(rows, { total: (call, n) => { now += call === 2 ? 61_000 : 0; return n; } });
  assert.equal((await countOverContext({ policy, reader: late, caps: CAPS, clock })).reason, 'cap_seconds');
  now = 0;
  const slowPage = memoryReader(rows, { page: () => { now += 61_000; } });
  assert.equal((await countOverContext({ policy, reader: slowPage, caps: CAPS, clock })).reason, 'cap_seconds');
  // A page that arrives just before the deadline is not processed past it: the clock is read between rows.
  let ticks = 0;
  const rowClock = () => (ticks++ > 6 ? 61_000 : 0);
  assert.equal((await countOverContext({ policy, reader: memoryReader(rows), caps: { ...CAPS, page_size: 10 }, clock: rowClock })).reason, 'cap_seconds');
});

test('every failure and malformed row yields incomplete with neither totals nor progress', async t => {
  const policy = await fixturePolicy(t);
  const rows = Array.from({ length: 7 }, (_, i) => row(`u${i}`, 30));
  const run = reader => countOverContext({ policy, reader, caps: CAPS });
  const page = rowsOut => ({ total: async () => rowsOut.length, page: async () => rowsOut });
  const cases = [
    [await run(memoryReader(rows, { total: () => { throw new Error('down'); } })), 'read_failed'],
    [await run(memoryReader(rows, { page: () => { throw new Error('down'); } })), 'read_failed'],
    [await run(memoryReader(rows, { total: (call, n) => call === 1 ? n : n + 1 })), 'total_changed'],
    [await run(page([{ uid: 'b', text: 'x', current_vector: true }, { uid: 'a', text: 'x', current_vector: true }])), 'read_failed'],
    [await run(page([{ uid: 'a', text: 'x' }])), 'read_failed'],
    [await run(page([{ uid: 'a', text: 'x', current_vector: null }])), 'read_failed'],
    [await run(page([{ uid: 'a', text: 'x', current_vector: 'yes' }])), 'read_failed'],
  ];
  for (const [report, reason] of cases) {
    assert.deepEqual(report, { contract: OVER_CONTEXT_COUNT, status: 'incomplete', reason });
  }
});

test('the store reader refuses an unreadable or ambiguous vector state instead of calling it absent', async () => {
  const fakeDriver = records => ({
    session: () => ({ beginTransaction: () => ({ run: async () => ({ records: records.map(fields => ({ get: name => fields[name] })) }),
      commit: async () => {}, isOpen: () => false, rollback: async () => {} }), close: async () => {} }),
  });
  const reader = records => neo4jChunkReader(fakeDriver(records), 'neo4j', 'fiction', 'key-1', 2);
  const read = records => reader(records).page(null, 10, 1000);
  assert.deepEqual((await read([{ uid: 'a', text: 'x', kind: 'current', key: 'key-1' }, { uid: 'b', text: 'y', kind: 'stale', key: 'old' },
    { uid: 'c', text: 'z', kind: 'none', key: null }, { uid: 'd', text: 'w', kind: 'none', key: 'key-1' }])).map(item => item.current_vector),
  [true, false, false, false]);
  // An invalid vector (wrong type, empty, or wrong shape at the current key), a keyless list or an ill-typed key is refused.
  for (const bad of [{ kind: 'invalid', key: 'key-1' }, { kind: 'stale', key: null }, { kind: 'current', key: null }, { kind: 'none', key: 7 }, { kind: 'list', key: 'key-1' }]) {
    await assert.rejects(read([{ uid: 'a', text: 'x', ...bad }]), { code: 'count_failed' }, JSON.stringify(bad));
  }
  await assert.rejects(reader([]).total(0), { code: 'count_failed' });
  // The total is exactly one numeric count row; a missing, null or extra row is refused rather than read as zero.
  for (const records of [[], [{ n: null }], [{ n: 3 }, { n: 3 }], [{ n: -1 }], [{ n: '3' }]]) {
    await assert.rejects(reader(records).total(1000), { code: 'count_failed' }, JSON.stringify(records));
  }
  assert.equal(await reader([{ n: 3 }]).total(1000), 3);
  assert.throws(() => neo4jChunkReader(fakeDriver([]), 'neo4j', 'fiction', 'key-1', 0), { code: 'count_failed' });
});

test('an unverified tokenizer contract yields incomplete without reading the store', async t => {
  const policy = chunkPolicy({ embedding: { url: 'http://127.0.0.1:9/v1/embeddings', model: 'embeddinggemma', dimensions: 2,
    ollama_context_revision: 'fiction-rev-1', tokenizer: { gguf: '/nonexistent.gguf', sha256: 'a'.repeat(64) } } }, {});
  let reads = 0;
  const report = await countOverContext({ policy, reader: { total: async () => { reads++; return 0; }, page: async () => { reads++; return []; } }, caps: CAPS });
  assert.deepEqual([report.status, report.reason, reads], ['incomplete', 'tokenizer_unavailable', 0]);
});

test('the command refuses a duplicate, missing or unknown option before reading any input', async () => {
  const { execFile } = await import('node:child_process');
  const script = new URL('../scripts/over-context-count.mjs', import.meta.url).pathname;
  const invoke = argv => new Promise(resolve => execFile(process.execPath, [script, ...argv], (error, stdout, stderr) =>
    resolve({ code: error?.code ?? 0, stdout, stderr })));
  const full = ['--config', '/nonexistent/owner.json', '--scope', 'a', '--embedding-key', 'k', '--caps', '/nonexistent/caps.json'];
  for (const argv of [[...full.slice(0, 6), '--scope', 'b'], full.slice(0, 6), [...full, '--verbose', 'yes'], [...full.slice(0, 6), '--cap', '/x']]) {
    const result = await invoke(argv);
    assert.deepEqual([result.code, result.stdout, JSON.parse(result.stderr)], [1, '', { ok: false, error: 'invalid_input' }], argv.join(' '));
  }
  // Well-formed options get as far as reading the (missing) files, which fails closed without a message.
  const missing = await invoke(full);
  assert.deepEqual([missing.code, JSON.parse(missing.stderr)], [1, { ok: false, error: 'count_failed' }]);
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

const DEFAULT_CONFIG = { scopes: { read: ['fiction'], write: [] }, neo4j: { uri: 'bolt://127.0.0.1:7687', auth: 'none' },
  embedding: { url: 'http://127.0.0.1:11434/v1/embeddings', model: 'embeddinggemma', dimensions: 768,
    ollama_context_revision: DEFAULT_TREATMENT.serving_revision, tokenizer: { gguf: '/nonexistent.gguf', sha256: DEFAULT_TREATMENT.tokenizer_sha256 } } };
const emptyStore = (close = async () => {}) => ({ database: 'neo4j', close, driver: { session: () => ({
  beginTransaction: () => ({ run: async () => ({ records: [] }), commit: async () => {}, isOpen: () => false, rollback: async () => {} }),
  close: async () => {} }) } });

test('the owner run requires the exact default treatment and pinned key, closes the store first, and emits no scope', async () => {
  const key = embeddingIdentity(DEFAULT_CONFIG.embedding);
  const run = (overrides = {}) => runOverContextCount({ config: DEFAULT_CONFIG, scope: 'fiction', embeddingKey: key, caps: CAPS,
    openStore: async () => { throw new Error('must not open'); }, ...overrides });
  const embeddingWith = extra => ({ ...DEFAULT_CONFIG, embedding: { ...DEFAULT_CONFIG.embedding, ...extra } });
  const events = [];
  const done = await run({ openStore: async () => { events.push('opened'); return emptyStore(async () => { events.push('closed'); }); } });
  // The served blob is absent here, so the count is incomplete, but the run itself completes and closed the store first.
  assert.deepEqual([done.ok, done.report.status, done.report.reason, events], [true, 'incomplete', 'tokenizer_unavailable', ['opened', 'closed']]);
  assert.deepEqual(Object.keys(done.report).sort(), ['caps', 'contract', 'invocation_sha256', 'reason', 'status']);
  assert.ok(!JSON.stringify(done.report).includes('fiction') && !JSON.stringify(done.report).includes('11434'), 'no scope or URL is emitted');
  assert.deepEqual(await run({ openStore: async () => emptyStore(async () => { throw new Error('close failed with stored text abcd'); }) }),
    { ok: false, error: 'count_failed' });
  assert.deepEqual(await run({ openStore: async () => { throw Object.assign(new MemoryError('text: abcd'), { code: 'text: abcd' }); } }),
    { ok: false, error: 'count_failed' }, 'an unknown code is never forwarded');
  // Anything but the complete default descriptor, or a configured key other than the pinned one, refuses before opening.
  for (const config of [embeddingWith({ chunk_token_cap: 1536 }), embeddingWith({ dimensions: 256 }), embeddingWith({ ollama_transport: 'native_no_truncate' })]) {
    assert.deepEqual(await run({ config }), { ok: false, error: 'count_contract_mismatch' }, JSON.stringify(config.embedding));
  }
  assert.deepEqual(await run({ embeddingKey: 'f'.repeat(64) }), { ok: false, error: 'count_contract_mismatch' });
  assert.deepEqual(await run({ config: embeddingWith({ url: 'http://127.0.0.1:11435/v1/embeddings' }) }), { ok: false, error: 'count_contract_mismatch' },
    'another port is another key');
  // A close that finishes after the cutoff leaves the run incomplete, whatever the count said.
  let now = 0;
  const slowClose = await run({ clock: () => now, openStore: async () => emptyStore(async () => { now += 61_000; }) });
  assert.deepEqual([slowClose.ok, slowClose.report.status, slowClose.report.reason], [true, 'incomplete', 'cap_seconds']);
  assert.deepEqual(await run({ scope: 'other' }), { ok: false, error: 'scope_denied' });
  // A subtree grant covering the scope is not an express grant of it.
  assert.deepEqual(await run({ config: { ...DEFAULT_CONFIG, scopes: { read: ['team/**'], write: [] } }, scope: 'team/fiction' }),
    { ok: false, error: 'scope_denied' });
  assert.deepEqual(await run({ caps: { ...CAPS, max_rows: undefined } }), { ok: false, error: 'invalid_input' });
});
