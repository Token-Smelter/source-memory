import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureIndexed } from '../pi-extension/index-readiness.mjs';
import { distillThrough, createTurnTools } from '../pi-extension/core.mjs';

test('pending indexing completes and waits until both vector indexes are online', async () => {
  let indexCalls = 0, polls = 0;
  const memory = { async index() { indexCalls++; return { status: 'ready' }; }, async status() {
    polls++; return { unindexed: 0, vector_indexes: { chunk: polls === 1 ? 'populating' : 'online', record: 'online' } };
  } };
  const result = await ensureIndexed(memory, 'fiction', { status: 'pending' }, { waitForVectors: true, pollMs: 0 });
  assert.deepEqual([result.status, indexCalls, polls], ['ready', 1, 2]);
});

test('newly written record vectors must be query-visible before link retrieval', async () => {
  const observed = [];
  const memory = { async status() { return { unindexed: 0, vector_indexes: { chunk: 'online', record: 'online' } }; },
    async recordVectorStatus(scope, ids) { observed.push({ scope, ids }); return { visible: observed.length >= 2 }; } };
  const result = await ensureIndexed(memory, 'fiction', { status: 'ready' },
    { waitForVectors: true, recordIds: ['new-record'], maxPolls: 3, pollMs: 0 });
  assert.deepEqual([result.status, observed], ['ready', [{ scope: 'fiction', ids: ['new-record'] }, { scope: 'fiction', ids: ['new-record'] }]]);
});

test('an invisible new record vector times out rather than permitting a link search', async () => {
  const memory = { async status() { return { unindexed: 0, vector_indexes: { chunk: 'online', record: 'online' } }; },
    async recordVectorStatus() { return { visible: false }; } };
  await assert.rejects(ensureIndexed(memory, 'fiction', { status: 'ready' },
    { waitForVectors: true, recordIds: ['new-record'], maxPolls: 2, pollMs: 0 }), /indexing_wait_timeout/);
});

test('unavailable embedding indexing reports its exact safe reason without retrying', async () => {
  let calls = 0;
  const memory = { async index() { calls++; } };
  await assert.rejects(ensureIndexed(memory, 'fiction', { status: 'unavailable', reason: 'model_request_failed' }), /indexing_model_request_failed/);
  assert.equal(calls, 0);
});

test('a checkpoint waits for indexing before its distiller may search', async () => {
  const calls = [];
  const memory = { async ingest() { calls.push('ingest'); return { id: 'turn', indexing: { status: 'pending' } }; },
    async index() { calls.push('index'); return { status: 'ready' }; } };
  const session = { scopes: ['fiction'], conversation_id: 'fiction', memory,
    entries: [{ type: 'message', id: 'a', parentId: null, message: { role: 'assistant', content: 'fiction', stopReason: 'stop' } }],
    ensureIndexed, distiller: { async run() { calls.push('distill'); return { status: 'complete' }; } } };
  await distillThrough(session, 'a', null);
  assert.deepEqual(calls, ['ingest', 'index', 'distill']);
});

test('a committed record waits for its indexing before returning to the model', async () => {
  const calls = [];
  const memory = { async enrich() { calls.push('write'); return { indexing: { status: 'pending' } }; },
    async index() { calls.push('index'); return { status: 'ready' }; } };
  const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'fiction' }] },
    receipt: { id: 'turn' }, memory, ensureIndexed });
  await tools.record('observation', 'fiction', ['ref-000001']);
  assert.deepEqual(calls, ['write', 'index']);
});

test('unindexed vectors are not reported as ready', async () => {
  const memory = { async status() { return { unindexed: 1, vector_indexes: { chunk: 'online', record: 'online' } }; } };
  await assert.rejects(ensureIndexed(memory, 'fiction', { status: 'ready' }, { waitForVectors: true, pollMs: 0 }), /indexing_incomplete/);
});
