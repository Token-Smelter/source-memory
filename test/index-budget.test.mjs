import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { INDEX_ADMISSION_FLOOR_MS, Memory } from '../src/memory.mjs';
import { embeddingIdentity } from '../src/models.mjs';

// A loopback embedder. `plan(index, input)` may return { delay } in real milliseconds and { advance } for the fake clock,
// which moves when the request arrives, as if the model had taken that long.
async function embedder(t, plan = () => ({})) {
  const calls = [];
  const clock = { now: 0 };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const { input } = JSON.parse(body);
    const index = calls.length;
    calls.push(input);
    const { delay = 0, advance = 0 } = plan(index, input);
    clock.now += advance;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (!res.destroyed) res.end(JSON.stringify({ data: input.map((value, i) => ({ index: i, embedding: [value.length, 1] })) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  return { calls, clock, url: `http://127.0.0.1:${server.address().port}/embed` };
}

// A store of chunk rows that answers the index step's calls and logs them in order. Saves and deferrals are confirmed in full
// unless `saveOutcome` says otherwise; `onStatus` and `onSave` run inside those calls.
function fakeStore(rows, { saveOutcome, onSave = () => {}, onStatus = () => {}, onSelect = () => {}, gaps = 0 } = {}) {
  const log = [];
  const find = uid => rows.find(row => row.uid === uid);
  const hint = row => ({ uid: row.uid, chunk: true, isolated: Boolean(row.isolated), cooling: false, single: Boolean(row.single) });
  return {
    log,
    async pendingEmbeddings(_scope, _key, limit) {
      log.push(['select']);
      await onSelect();
      return rows.filter(row => !row.vector && !row.deferred).slice(0, limit).map(hint);
    },
    async observeEmbeddings(_scope, _key, uids) {
      log.push(['observe', uids]);
      return uids.map(find).filter(row => row && !row.vector).map(row => ({ ...hint(row), text: row.text, observed: { text: row.text }, eligible: true }));
    },
    async saveEmbeddings(_scope, _key, items) {
      log.push(['save', items.map(item => item.uid)]);
      await onSave(items);
      const outcome = saveOutcome?.(items) ?? { applied: items.length, refused: 0 };
      if (!outcome.uncertain) for (const item of items.slice(0, outcome.applied)) find(item.uid).vector = item.vector;
      return outcome;
    },
    async deferEmbeddings(_scope, _key, items, delay, single) {
      log.push(['defer', items.map(item => item.uid), delay, single]);
      for (const item of items) find(item.uid).deferred = true;
      return { applied: items.length, refused: 0 };
    },
    async markOversizedChunks(_scope, _key, items) { log.push(['oversized']); return { applied: items.length, refused: 0 }; },
    async status() {
      log.push(['status']);
      await onStatus();
      return { unindexed: rows.filter(row => !row.vector).length, unembeddable: 0 };
    },
    async derivedGaps() { return gaps; },
    async close() {},
  };
}

const rowsOf = (count, extra = {}) => Array.from({ length: count }, (_, index) => ({ uid: `c${String(index).padStart(2, '0')}`, text: `text ${index}`, ...extra }));

function memoryWith(fixture, store, embedding = {}) {
  const memory = new Memory({ embedding: { url: fixture.url, model: 'fixture', dimensions: 2, ...embedding }, scopes: { read: ['s'], write: ['s'] } }, store);
  memory.clock = () => fixture.clock.now;
  return memory;
}

test('with neither key the step is unchanged: groups of 16, one isolated group per call, no deadline and no partial', async t => {
  const fixture = await embedder(t, () => ({ advance: 1_000_000 }));
  const store = fakeStore(rowsOf(20));
  const memory = memoryWith(fixture, store);
  const key = embeddingIdentity(memory.config.embedding);
  assert.deepEqual(await memory.index('s'), { status: 'ready', indexed: 20, embedding_key: key });
  assert.deepEqual(fixture.calls.map(input => input.length), [16, 4]);
  // An isolated group still ends the call after one request.
  const isolated = fakeStore(rowsOf(6, { isolated: true }));
  const second = await memoryWith(fixture, isolated).index('s');
  assert.deepEqual([second.status, second.indexed, second.partial], ['pending', 4, undefined]);
});

test('index_batch alone caps every group and keeps isolation pacing, with no deadline', async t => {
  const fixture = await embedder(t, () => ({ advance: 1_000_000 }));
  const memory = memoryWith(fixture, fakeStore(rowsOf(7)), { index_batch: 3 });
  assert.equal((await memory.index('s')).status, 'ready');
  assert.deepEqual(fixture.calls.map(input => input.length), [3, 3, 1]);
  const isolated = await memoryWith(fixture, fakeStore(rowsOf(6, { isolated: true })), { index_batch: 3 }).index('s');
  assert.deepEqual([isolated.status, isolated.indexed], ['pending', 3]);
});

test('a budget admits calls while the floor remains, saves each group before the next, and continues on the next step', async t => {
  // Each request takes 2,000 ms of the budget: admitted at 5,000, 3,000 and 1,000 ms left; refused at -1,000.
  const fixture = await embedder(t, () => ({ advance: 2000 }));
  const store = fakeStore(rowsOf(10));
  const memory = memoryWith(fixture, store, { index_budget_ms: 5000, index_batch: 2 });
  const first = await memory.index('s');
  assert.deepEqual(first, { status: 'pending', indexed: 6, embedding_key: first.embedding_key,
    partial: { reason: 'index_budget_exhausted', budget_ms: 5000 } });
  assert.equal(INDEX_ADMISSION_FLOOR_MS, 1000);
  assert.deepEqual(store.log.filter(([kind]) => kind !== 'select').map(([kind]) => kind),
    ['observe', 'save', 'observe', 'save', 'observe', 'save'], 'each success is saved before the next group is observed');
  assert.ok(!store.log.some(([kind]) => kind === 'defer' || kind === 'status'), 'no cooldown and no drain check after the deadline');
  // The next step has its own deadline, selects only what is still pending, and starts from there.
  const second = await memory.index('s');
  assert.deepEqual([second.status, second.indexed], ['ready', 4], JSON.stringify(second));
  assert.deepEqual(fixture.calls.slice(3).flat(), ['text 6', 'text 7', 'text 8', 'text 9']);
});

test('a request the budget shortened and that timed out is not the text\'s fault: no cooldown, isolation or mark, earlier saves kept', async t => {
  // The first request leaves 1,150 ms; the second is admitted with that as its timeout and outlasts it in real time.
  const fixture = await embedder(t, index => (index === 0 ? { advance: 850 } : { delay: 2500 }));
  const store = fakeStore(rowsOf(4));
  const memory = memoryWith(fixture, store, { index_budget_ms: 2000, index_batch: 2, timeout_ms: 10_000 });
  const reply = await memory.index('s');
  assert.deepEqual([reply.status, reply.indexed, reply.partial?.reason], ['pending', 2, 'index_budget_exhausted']);
  assert.ok(!store.log.some(([kind]) => kind === 'defer'), 'no deferral, cooldown or isolation');
  assert.equal(fixture.calls.length, 2);
});

test('a failure within the full configured timeout keeps today\'s deferral, budget or not', async t => {
  const fixture = await embedder(t, () => ({ delay: 600 }));
  const store = fakeStore(rowsOf(2));
  const memory = memoryWith(fixture, store, { index_budget_ms: 100_000, timeout_ms: 200 });
  const reply = await memory.index('s');
  assert.deepEqual([reply.status, reply.reason], ['unavailable', 'model_timeout']);
  assert.deepEqual(store.log.find(([kind]) => kind === 'defer'), ['defer', ['c00', 'c01'], 60, false]);
});

test('an admitted save is awaited past the deadline and credited, but no readiness is claimed after it', async t => {
  const fixture = await embedder(t, () => ({ advance: 1000 }));
  const later = { now: null };
  const store = fakeStore(rowsOf(2), { onSave: () => { fixture.clock.now += 5000; later.now = fixture.clock.now; } });
  const memory = memoryWith(fixture, store, { index_budget_ms: 3000 });
  const reply = await memory.index('s');
  assert.deepEqual([reply.status, reply.indexed, reply.partial?.reason], ['pending', 2, 'index_budget_exhausted']);
  assert.ok(later.now > 3000 && !store.log.some(([kind]) => kind === 'status'), 'the save finished after the deadline; no drain check began');
  // A drain check that itself ends after the deadline cannot earn ready either.
  const slowStatus = fakeStore(rowsOf(2), { onStatus: () => { fixture.clock.now += 10_000; } });
  fixture.clock.now = 0;
  const second = await memoryWith(fixture, slowStatus, { index_budget_ms: 3000 }).index('s');
  assert.deepEqual([second.status, second.indexed, second.partial?.reason], ['pending', 2, 'index_budget_exhausted']);
});

test('an uncertain save is never credited and a refused row stays for the next selection, under a budget', async t => {
  const fixture = await embedder(t);
  const store = fakeStore(rowsOf(2), { saveOutcome: items => ({ applied: 0, refused: items.length, uncertain: true }) });
  const reply = await memoryWith(fixture, store, { index_budget_ms: 10_000 }).index('s');
  assert.deepEqual([reply.status, reply.indexed, reply.unknown, reply.partial], ['pending', 0, 2, undefined]);
});

test('with no usable request time left after selection, nothing is sent', async t => {
  const fixture = await embedder(t);
  const store = fakeStore(rowsOf(3), { onSelect: () => { fixture.clock.now += 2500; } });
  const reply = await memoryWith(fixture, store, { index_budget_ms: 3000 }).index('s');
  assert.deepEqual([reply.status, reply.indexed, reply.partial?.reason], ['pending', 0, 'index_budget_exhausted']);
  assert.deepEqual([fixture.calls.length, store.log.map(([kind]) => kind)], [0, ['select']]);
});

test('under a budget a refused save is stale, not credited, and a saved step with a derived gap keeps its progress but is not ready', async t => {
  const fixture = await embedder(t);
  const stale = fakeStore(rowsOf(2), { saveOutcome: items => ({ applied: items.length - 1, refused: 1 }) });
  const reply = await memoryWith(fixture, stale, { index_budget_ms: 10_000 }).index('s');
  assert.deepEqual([reply.status, reply.indexed, reply.stale, reply.partial], ['pending', 1, 1, undefined]);
  const gapped = await memoryWith(fixture, fakeStore(rowsOf(2), { gaps: 1 }), { index_budget_ms: 10_000 }).index('s');
  assert.deepEqual([gapped.status, gapped.reason, gapped.indexed, gapped.derived_gaps], ['unavailable', 'derived_chunk_gaps', 2, 1]);
});

test('an isolated group still ends the step after one request under a budget', async t => {
  const fixture = await embedder(t);
  const reply = await memoryWith(fixture, fakeStore(rowsOf(8, { isolated: true })), { index_budget_ms: 60_000, index_batch: 2 }).index('s');
  assert.deepEqual([reply.status, reply.indexed, fixture.calls.length], ['pending', 2, 1]);
});

test('a budget that cannot admit a call, a batch out of range or an invalid timeout is refused before any model call', async t => {
  const fixture = await embedder(t);
  for (const [embedding, reason] of [[{ index_budget_ms: 1999 }, 'invalid_index_budget'], [{ index_budget_ms: 600_001 }, 'invalid_index_budget'],
    [{ index_budget_ms: '3000' }, 'invalid_index_budget'], [{ index_batch: 0 }, 'invalid_index_batch'], [{ index_batch: 17 }, 'invalid_index_batch'],
    [{ index_budget_ms: 3000, timeout_ms: 0 }, 'invalid_model_timeout'], [{ index_budget_ms: 3000, timeout_ms: 120_001 }, 'invalid_model_timeout']]) {
    const reply = await memoryWith(fixture, fakeStore(rowsOf(2)), embedding).index('s');
    assert.deepEqual([reply.status, reply.reason], ['unavailable', reason], JSON.stringify(embedding));
  }
  assert.equal(fixture.calls.length, 0);
});
