import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { MemoryError } from '../src/core.mjs';
import { Memory } from '../src/memory.mjs';
import { Neo4jStore } from '../src/store.mjs';
import { createCoverageJournal } from '../pi-extension/coverage.mjs';
import { createMemoryClient } from '../pi-extension/memory-client.mjs';
import { createMemoryHandlers } from '../pi-extension/memory-process.mjs';
import { createClient, serve } from '../pi-extension/ndjson.mjs';

test('an explicit pre-write server rejection is distinguished from a transport timeout', async () => {
  const inbound = new PassThrough(), outbound = new PassThrough(), stopped = new AbortController();
  const server = serve({ input: inbound, output: outbound, signal: stopped.signal, handlers: {
    async enrich() { throw Object.assign(new Error('refused'), { code: 'outcome_referent_required' }); },
    async recall() { return new Promise(() => {}); },
    async beginLinks() { throw Object.assign(new Error('incomplete'), { code: 'link_retrieval_incomplete' }); },
    async index() { await new Promise(resolve => setTimeout(resolve, 40)); return { status: 'ready' }; },
  } });
  const client = createMemoryClient({ input: outbound, output: inbound, timeoutMs: 20, indexTimeoutMs: 100 });
  try {
    await assert.rejects(client.enrich('fiction', {}, { trigger: 'turn' }), error => error.code === 'outcome_referent_required' && error.effect === 'refused');
    await assert.rejects(client.recall('fiction', { query: 'fiction' }), error => error.code === 'request_timeout' && error.effect === 'none');
    await assert.rejects(client.beginLinks('fiction', 'turn', ['record']), error => error.code === 'link_retrieval_incomplete' && error.effect === 'none');
    assert.equal((await client.index('fiction', { limit: 16 })).status, 'ready');
  } finally { client.close(); stopped.abort(); inbound.end(); outbound.end(); await server; }
});

test('a failure frame carries a valid write stage and is otherwise byte-identical', async () => {
  const inbound = new PassThrough(), outbound = new PassThrough(), stopped = new AbortController();
  const frames = [];
  outbound.on('data', part => frames.push(...String(part).trimEnd().split('\n')));
  const raise = stage => async () => { throw Object.assign(new Error('x'), { code: 'fiction_refused' }, stage === undefined ? {} : { stage }); };
  const server = serve({ input: inbound, output: outbound, signal: stopped.signal, handlers: {
    plain: raise(), before: raise('before_write'), rolled: raise('rolled_back'), unknown: raise('unknown'), bogus: raise('committed') } });
  const client = createClient({ input: outbound, output: inbound, timeoutMs: 1000 });
  try {
    const stages = [];
    for (const method of ['plain', 'before', 'rolled', 'unknown', 'bogus']) {
      await assert.rejects(client.request(method, {}), error => { stages.push(error.stage); return error.code === 'fiction_refused'; });
    }
    assert.deepEqual(stages, [undefined, 'before_write', 'rolled_back', 'unknown', undefined]);
    assert.deepEqual(frames, ['{"id":"1","ok":false,"error":"fiction_refused"}',
      '{"id":"2","ok":false,"error":"fiction_refused","stage":"before_write"}',
      '{"id":"3","ok":false,"error":"fiction_refused","stage":"rolled_back"}',
      '{"id":"4","ok":false,"error":"fiction_refused","stage":"unknown"}',
      '{"id":"5","ok":false,"error":"fiction_refused"}']);
  } finally { client.close(); stopped.abort(); inbound.end(); outbound.end(); await server; }
});

test('memory-process stages its write handlers as the CLI does', async () => {
  const memory = { show: async () => ({ turn: { source: 'pi-memory' } }),
    ingest: async () => { throw new TypeError('driver detail'); },
    enrich: async () => { throw Object.assign(new MemoryError('record_identity_conflict'), { stage: 'rolled_back' }); } };
  const handlers = createMemoryHandlers({ memory, scopes: ['fiction'] });
  const record = { id: 'r', kind: 'decision', text: 'Teal shutters.', attribution: 'fiction', evidence: [{ turn: 't', entry_id: 'u', start: 0, end: 4 }] };
  const stageOf = promise => promise.then(() => 'resolved', error => `${error.code ?? error.name}:${error.stage}`);
  try {
    assert.deepEqual(await Promise.all([
      stageOf(handlers.ingest({ scope: 'other', turn: { source: 'pi-memory' } })),
      stageOf(handlers.ingest({ scope: 'fiction', turn: { source: 'elsewhere' } })),
      stageOf(handlers.ingest({ scope: 'fiction', turn: { source: 'pi-memory' } })),
      stageOf(handlers.enrich({ scope: 'fiction', input: { records: [record], relations: [] }, trigger: 'other-turn' })),
      stageOf(handlers.enrich({ scope: 'fiction', input: { records: [record], relations: [] }, trigger: 't' })),
    ]), ['scope_denied:before_write', 'source_invalid:before_write', 'TypeError:unknown', 'record_not_from_trigger:before_write',
      'record_identity_conflict:rolled_back']);
  } finally { handlers.close(); }
});

// Coverage journal -> memory client -> NDJSON -> memory-process -> Memory -> Neo4jStore.atomicWrite, with only the driver
// transaction replaced. The referent check runs inside the write transaction, so a first-attempt refusal is rolled_back.
test('a referent-missing enrich through memory-process is refused with no reconcile; after a driver retry it is uncertain', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-memory-refusal-'));
  const store = new Neo4jStore({ uri: 'bolt://127.0.0.1:1', auth: 'none' });
  try {
    const outcome = { records: [{ id: 'harbour-outcome', kind: 'outcome', text: 'The fictional harbour reopened.', attribution: 'fiction',
      evidence: [{ turn: 'turn-fiction', entry_id: 'u1', start: 0, end: 4 }] }], relations: [] };
    const results = [];
    for (const [label, transaction] of [
      ['first attempt', async (_mode, action) => action({})],
      ['driver retry', async (_mode, action) => { try { await action({}); } catch { /* retryable */ } return action({}); }]]) {
      store.transaction = transaction;
      store.enrich = () => store.atomicWrite(() => { throw new MemoryError('outcome_referent_required'); });
      const memory = Object.assign(new Memory({ scopes: { read: ['fiction'], write: ['fiction'] } }, store),
        { show: async () => ({ turn: { id: 'turn-fiction', source: 'pi-memory' } }) });
      const inbound = new PassThrough(), outbound = new PassThrough(), stopped = new AbortController();
      const handlers = createMemoryHandlers({ memory, scopes: ['fiction'] });
      const server = serve({ input: inbound, output: outbound, signal: stopped.signal, handlers });
      const journal = createCoverageJournal({ directory, sessionKey: label });
      const client = journal.track(createMemoryClient({ input: outbound, output: inbound, timeoutMs: 1000 }));
      try {
        journal.begin({ cursor: null, through: 'a' });
        const error = await client.enrich('fiction', outcome, { trigger: 'turn-fiction' }).then(() => null, problem => problem);
        const ends = readFileSync(journal.path, 'utf8').trimEnd().split('\n').map(JSON.parse).filter(row => row.type === 'effect_end');
        results.push([label, error.code, error.stage, error.effect, ends.map(row => row.outcome), journal.finish('abstained')]);
      } finally { client.close(); journal.close(); handlers.close(); stopped.abort(); inbound.end(); outbound.end(); await server; }
    }
    assert.deepEqual(results, [
      ['first attempt', 'outcome_referent_required', 'rolled_back', 'refused', ['refused'], 'abstained'],
      ['driver retry', 'write_uncertain', undefined, undefined, ['unknown'], 'uncertain'],
    ]);
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
});
