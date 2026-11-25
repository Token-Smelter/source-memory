import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import v8 from 'node:v8';
import vm from 'node:vm';
import { CHUNK_MAX_BYTES } from '../src/core.mjs';
import { Memory } from '../src/memory.mjs';
import { EMBEDDING_UNIT_MAX, Neo4jStore } from '../src/store.mjs';
import { embeddingIdentity } from '../src/models.mjs';

// Only used to show that a hydrated witness becomes unreachable once its unit is done.
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

const KEY = 'selection-key';
const base = { text: 'alpha', embedding_key: null, embedding: null, retry_key: null, retry_after: null, retry_single: null,
  oversized_key: null, oversized_cap: null, oversized_text: null };

// A Neo4jStore whose statements are answered by `answer(query, params, index)`; every statement and its parameters is kept.
const instrumented = answer => {
  const store = new Neo4jStore({ uri: 'bolt://127.0.0.1:1', auth: 'none' });
  const statements = [];
  store.transaction = async (_mode, action) => action({
    async run(query, params) {
      statements.push({ query, params });
      return answer(query, params, statements.length - 1);
    },
  });
  return { store, statements };
};
const records = (rows, asked) => ({ records: rows.map(row => ({ get: name => { asked?.add(name); return row[name]; } })) });

async function embedder(t) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const { input } = JSON.parse(body);
    calls.push(input);
    res.end(JSON.stringify({ data: input.map((value, index) => ({ index, embedding: [value.length, 1] })) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const embedding = { url: `http://127.0.0.1:${server.address().port}/embed`, model: 'fixture', dimensions: 2 };
  return { calls, embedding, key: embeddingIdentity(embedding) };
}

test('discovery returns identity and order hints only, never text or a vector witness', async t => {
  const asked = new Set();
  const { store, statements } = instrumented(() => records([
    { uid: 'a', chunk: true, isolated: false, cooling: false, single: false, embedding: [1, 2], text: 'leak', observed: { embedding: [1, 2] } },
  ], asked));
  t.after(() => store.close());
  const rows = await store.pendingEmbeddings('test', KEY, 2049);
  assert.deepEqual(rows, [{ uid: 'a', chunk: true, isolated: false, cooling: false, single: false }]);
  assert.deepEqual([...asked].sort(), ['chunk', 'cooling', 'isolated', 'single', 'uid']);
  assert.equal(statements.length, 1, 'discovery sends no second, witness-carrying statement');
  const projection = statements[0].query.slice(statements[0].query.lastIndexOf('RETURN'));
  assert.doesNotMatch(projection, /embedding|text|valueType|observed/, 'the projection names no state value');
  assert.equal(statements[0].params.limit.toNumber(), 2049, 'the public maximum page and its look-ahead row are kept');
});

test('hydration derives every decision from one observed map and judges eligibility without vector values', async t => {
  const prior = ['LIST<FLOAT NOT NULL> NOT NULL', ...Array.from({ length: 4096 }, (_, i) => `${i}.5`)];
  const rows = [
    { uid: 'a', chunk: true, observed: { ...base, text: 'alpha', embedding_key: 'prior-key', embedding: prior } },
    { uid: 'b', chunk: true, observed: { ...base, retry_key: KEY, retry_after: ['ZONED DATETIME NOT NULL', 'later'], retry_single: true } },
    { uid: 'c', chunk: false, observed: { ...base, retry_key: KEY, retry_after: ['ZONED DATETIME NOT NULL', 'earlier'], retry_single: true } },
    { uid: 'd', chunk: true, observed: { ...base, embedding_key: KEY, embedding: ['LIST<FLOAT NOT NULL> NOT NULL', '1.0'] } },
    { uid: 'e', chunk: true, observed: { ...base, oversized_key: KEY, oversized_cap: ['INTEGER NOT NULL', String(CHUNK_MAX_BYTES)], oversized_text: 'alpha' } },
  ];
  const verdicts = { a: [true, false], b: [true, true], c: [true, false], d: [false, false], e: [false, false] };
  const { store, statements } = instrumented((query, params, index) => (index === 0 ? records(rows)
    : { records: [{ get: () => params.rows.map((_, i) => ({ eligible: verdicts[rows[i].uid][0], cooling: verdicts[rows[i].uid][1] })) }] }));
  t.after(() => store.close());
  const observed = await store.observeEmbeddings('test', KEY, ['a', 'b', 'c', 'd', 'e', 'gone']);
  assert.deepEqual(statements[0].params.uids, ['a', 'b', 'c', 'd', 'e', 'gone']);
  assert.match(statements[1].query, /^RETURN/, 'the judgement reads parameters only, never the node again');
  assert.deepEqual(statements[1].params.rows.map(row => row.observed.embedding), [true, null, null, true, null],
    'the judgement carries vector presence, not the 4096 values');
  assert.deepEqual(observed.map(({ uid, text, eligible, isolated, cooling, single }) => [uid, text, eligible, isolated, cooling, single]), [
    ['a', 'alpha', true, false, false, false],
    ['b', null, true, true, true, true],
    ['c', 'alpha', true, true, false, true],
    ['d', 'alpha', false, false, false, false],
    ['e', 'alpha', false, false, false, false],
  ]);
  assert.equal(observed[0].observed.embedding, prior, 'the exact typed witness is what the write guard will compare');
});

test('hydration and guarded writes refuse more than one work unit before touching the database', async t => {
  const { store, statements } = instrumented(() => assert.fail('no statement'));
  t.after(() => store.close());
  const uids = Array.from({ length: EMBEDDING_UNIT_MAX + 1 }, (_, i) => `u${i}`);
  await assert.rejects(store.observeEmbeddings('test', KEY, uids), { code: 'embedding_accounting_invalid' });
  const rows = uids.map(uid => ({ uid, observed: base, vector: [1, 0] }));
  await assert.rejects(store.saveEmbeddings('test', KEY, rows), { code: 'embedding_accounting_invalid' });
  await assert.rejects(store.deferEmbeddings('test', KEY, rows, 60), { code: 'embedding_accounting_invalid' });
  assert.equal(statements.length, 0);
});

// An in-memory store with the Neo4jStore contract that records every hydration and write and tracks each issued witness.
function fixtureStore(count, { dimensions = 8 } = {}) {
  const rows = new Map(Array.from({ length: count }, (_, i) => {
    const uid = `u${String(i).padStart(4, '0')}`;
    return [uid, { text: `fictional note ${i}`, key: 'prior-key', vector: Array.from({ length: dimensions }, (_, d) => i + d / 10) }];
  }));
  const log = { discovered: [], observed: [], written: [], witnesses: [], hydratedWhileWriting: 0, collectedLate: [] };
  let writing = 0;
  const eligible = row => row.key !== log.key && !row.cooling;
  const store = {
    rows, log,
    async pendingEmbeddings(_scope, key, limit) {
      log.key = key;
      const page = [...rows].filter(([, row]) => row.key !== key)
        .map(([uid, row]) => ({ uid, chunk: true, isolated: Boolean(row.cooling), cooling: Boolean(row.cooling), single: false }))
        .sort((a, b) => a.cooling - b.cooling || (a.uid < b.uid ? -1 : 1)).slice(0, limit);
      log.discovered.push({ limit, rows: page });
      await log.afterDiscovery?.();
      return page;
    },
    async observeEmbeddings(_scope, key, uids) {
      assert.ok(uids.length <= EMBEDDING_UNIT_MAX);
      if (writing) log.hydratedWhileWriting += 1;
      // Witnesses from two units back are no longer referenced by the indexer once this unit is requested.
      gc();
      const unit = log.observed.length;
      log.collectedLate.push(...log.witnesses.filter(w => w.unit <= unit - 2 && w.ref.deref()).map(w => w.uid));
      log.observed.push(uids.length);
      return uids.filter(uid => rows.has(uid)).map(uid => {
        const row = rows.get(uid);
        const observed = { text: row.text, embedding_key: row.key, embedding: ['LIST<FLOAT NOT NULL> NOT NULL', ...row.vector.map(String)] };
        log.witnesses.push({ unit, uid, ref: new WeakRef(observed) });
        return { uid, chunk: true, observed, eligible: row.key !== key, text: row.cooling ? null : row.text,
          isolated: Boolean(row.cooling), cooling: Boolean(row.cooling), single: false };
      });
    },
    async saveEmbeddings(_scope, key, batch) {
      writing += 1;
      try {
        assert.ok(batch.length <= EMBEDDING_UNIT_MAX);
        log.written.push(batch.length);
        log.leak?.push(...batch);
        let applied = 0;
        for (const { uid, observed, vector } of batch) {
          const row = rows.get(uid);
          if (!row || !eligible(row) || row.text !== observed.text) continue;
          Object.assign(row, { key, vector });
          applied += 1;
        }
        return { applied, refused: batch.length - applied, uncertain: false };
      } finally { writing -= 1; }
    },
    async markOversizedChunks() { assert.fail('no oversized fixture rows'); },
    async status(_scope, key) { return { unindexed: [...rows.values()].filter(row => row.key !== key).length, unembeddable: 0 }; },
  };
  return store;
}

test('exact witnesses stay within one work unit whatever the caller\'s limit, and are released as units progress', async t => {
  const { calls, embedding, key } = await embedder(t);
  const count = 40;
  for (const limit of [1, 5, 16, 17, 33, 40, 2048]) {
    const store = fixtureStore(count);
    const before = calls.length;
    const reply = await new Memory({ scopes: { write: ['test'] }, embedding }, store).index('test', { limit });
    const expected = Math.min(limit, count);
    const units = Math.ceil(expected / EMBEDDING_UNIT_MAX);
    assert.deepEqual(reply, { status: limit >= count ? 'ready' : 'pending', indexed: expected, embedding_key: key }, `limit ${limit}`);
    assert.equal(store.log.discovered[0].limit, limit + 1, `limit ${limit}: one look-ahead row`);
    assert.ok(store.log.discovered[0].rows.every(row => Object.keys(row).join() === 'uid,chunk,isolated,cooling,single'),
      `limit ${limit}: discovery carries no prior vector`);
    assert.deepEqual(store.log.observed, Array.from({ length: units }, (_, i) => Math.min(EMBEDDING_UNIT_MAX, expected - i * EMBEDDING_UNIT_MAX)),
      `limit ${limit}: hydration is one unit at a time`);
    assert.equal(Math.max(...store.log.observed, ...store.log.written), Math.min(EMBEDDING_UNIT_MAX, expected), `limit ${limit}: max witnesses per operation`);
    assert.deepEqual(store.log.written, store.log.observed, `limit ${limit}: each unit is written before the next is hydrated`);
    assert.equal(store.log.hydratedWhileWriting, 0);
    assert.equal(calls.length - before, units, `limit ${limit}: one model request per unit`);
    assert.deepEqual(store.log.collectedLate, [], `limit ${limit}: no witness outlives the unit after its own`);
    assert.equal([...store.rows.values()].filter(row => row.key === key).length, expected, `limit ${limit}: stored progress matches indexed`);
  }
  // Control: the same run with every written witness kept alive is caught by the release check.
  const leaky = fixtureStore(count);
  leaky.log.leak = [];
  await new Memory({ scopes: { write: ['test'] }, embedding }, leaky).index('test', { limit: count });
  assert.equal(leaky.log.collectedLate.length, EMBEDDING_UNIT_MAX, 'a retained unit is detected');
});

test('changes between discovery and hydration are judged on the hydrated state and counted stale, never indexed', async t => {
  const { calls, embedding, key } = await embedder(t);
  const store = fixtureStore(20);
  const uid = i => `u${String(i).padStart(4, '0')}`;
  store.log.afterDiscovery = () => {
    Object.assign(store.rows.get(uid(1)), { key, vector: [9, 9] });
    store.rows.delete(uid(2));
    store.rows.get(uid(3)).cooling = true;
    store.rows.get(uid(4)).text = 'a changed fictional note';
    store.rows.get(uid(17)).cooling = true;
  };
  const reply = await new Memory({ scopes: { write: ['test'] }, embedding }, store).index('test', { limit: 20 });
  assert.deepEqual(reply, { status: 'pending', indexed: 16, embedding_key: key, stale: 4 });
  assert.equal(calls.at(-2).length, 13, 'the first unit embeds only its still-eligible, same-class rows');
  assert.ok(calls.at(-2).includes('a changed fictional note'), 'model input is the hydrated text');
  assert.deepEqual(store.rows.get(uid(1)).vector, [9, 9], 'the competing repair is not clobbered');
  assert.deepEqual(store.log.observed, [16, 4]);
});

test('a failure in a later unit keeps the confirmed and refused counts of earlier units and never claims ready', async t => {
  const { embedding, key } = await embedder(t);
  const run = async (store, limit = 17) => new Memory({ scopes: { write: ['test'] }, embedding }, store).index('test', { limit });
  const storedProgress = store => [...store.rows.values()].filter(row => row.key === key).length;
  const failSecond = (store, method) => {
    const original = store[method].bind(store);
    let calls = 0;
    store[method] = async (...args) => (++calls === 2 ? Promise.reject(new Error('connection lost')) : original(...args));
  };

  // The second hydration rejects after the first unit's 16 writes committed.
  const hydration = fixtureStore(17);
  failSecond(hydration, 'observeEmbeddings');
  assert.deepEqual(await run(hydration), { status: 'unavailable', reason: 'database_unavailable', source_retained: true, indexed: 16 });
  assert.equal(storedProgress(hydration), 16);
  assert.deepEqual(hydration.log.written, [16]);

  // A stale refusal tallied in the first unit survives the later failure.
  const staleFirst = fixtureStore(17);
  const originalSave = staleFirst.saveEmbeddings.bind(staleFirst);
  staleFirst.saveEmbeddings = async (scope, k, batch) => {
    staleFirst.rows.get(batch[0].uid).text = 'changed under the write';
    return originalSave(scope, k, batch);
  };
  failSecond(staleFirst, 'observeEmbeddings');
  assert.deepEqual(await run(staleFirst), { status: 'unavailable', reason: 'database_unavailable', source_retained: true,
    indexed: 15, stale: 1 });
  assert.equal(storedProgress(staleFirst), 15);

  // An uncertain first save is reported as unknown; the second save rejects and contributes nothing.
  const uncertain = fixtureStore(20);
  const save = uncertain.saveEmbeddings.bind(uncertain);
  let saves = 0;
  uncertain.saveEmbeddings = async (scope, k, batch) => {
    if (++saves === 2) throw new Error('connection lost');
    const outcome = await save(scope, k, batch.slice(0, 14));
    return { applied: outcome.applied, refused: batch.length - outcome.applied, uncertain: true };
  };
  assert.deepEqual(await run(uncertain, 20), { status: 'unavailable', reason: 'database_unavailable', source_retained: true,
    indexed: 14, unknown: 2 });
  assert.equal(storedProgress(uncertain), 14);

  // Invalid accounting from a later unit is refused without discarding the earlier unit.
  const invalid = fixtureStore(17);
  const valid = invalid.saveEmbeddings.bind(invalid);
  let writes = 0;
  invalid.saveEmbeddings = async (...args) => (++writes === 2 ? { applied: 2, refused: 0, uncertain: false } : valid(...args));
  assert.deepEqual(await run(invalid), { status: 'unavailable', reason: 'embedding_accounting_invalid', source_retained: true,
    indexed: 16 });

  // The drain check fails after every selected row was written: progress is kept and the call is not ready.
  const drain = fixtureStore(17);
  drain.status = async () => { throw new Error('connection lost'); };
  assert.deepEqual(await run(drain), { status: 'unavailable', reason: 'database_unavailable', source_retained: true, indexed: 17 });
  assert.equal(storedProgress(drain), 17);

  // Control: a failure before any unit reports no progress.
  const early = fixtureStore(17);
  early.observeEmbeddings = async () => { throw new Error('connection lost'); };
  assert.deepEqual(await run(early), { status: 'unavailable', reason: 'database_unavailable', source_retained: true });
  assert.equal(storedProgress(early), 0);
});

test('a cooling hint is confirmed on hydrated state before the call reports a retry deferral', async t => {
  const { calls, embedding, key } = await embedder(t);
  const store = fixtureStore(3);
  for (const row of store.rows.values()) row.cooling = true;
  store.log.afterDiscovery = () => { store.rows.get('u0000').cooling = false; };
  const memory = new Memory({ scopes: { write: ['test'] }, embedding }, store);
  assert.deepEqual(await memory.index('test'), { status: 'unavailable', reason: 'embedding_retry_deferred', source_retained: true,
    indexed: 0, embedding_key: key, stale: 1 }, 'the expired row is reselected next time, not embedded out of order');
  assert.deepEqual([store.log.observed, calls.length], [[1, 1], 0]);
  delete store.log.afterDiscovery;
  const next = await memory.index('test');
  assert.deepEqual([next.reason, next.indexed], ['embedding_retry_deferred', 1]);
});

test('the public limit bounds are kept: 2048 is accepted and 2049 is refused before storage', async t => {
  const { embedding } = await embedder(t);
  const store = fixtureStore(2);
  const memory = new Memory({ scopes: { write: ['test'] }, embedding }, store);
  assert.equal((await memory.index('test', { limit: 2048 })).status, 'ready');
  assert.equal(store.log.discovered.at(-1).limit, 2049);
  const refused = await memory.index('test', { limit: 2049 });
  assert.equal(refused.status, 'unavailable');
  assert.equal(store.log.discovered.length, 1);
});
