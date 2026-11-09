import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { MemoryError } from '../src/core.mjs';
import { Memory } from '../src/memory.mjs';
import { Neo4jStore } from '../src/store.mjs';
import { createCoverageJournal } from '../pi-extension/coverage.mjs';
import { createMemoryClient } from '../pi-extension/memory-client.mjs';
import { createMemoryHandlers, STAGED_METHODS } from '../pi-extension/memory-process.mjs';
import { createClient, serve } from '../pi-extension/ndjson.mjs';
import { main as serveMain } from '../pi-extension/serve.mjs';

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

test('only a staged method carries a write stage on its failure frame; other frames are byte-identical', async () => {
  const inbound = new PassThrough(), outbound = new PassThrough(), stopped = new AbortController();
  const frames = [];
  outbound.on('data', part => frames.push(...String(part).trimEnd().split('\n')));
  const raise = stage => async () => { throw Object.assign(new Error('x'), { code: 'fiction_refused' }, stage === undefined ? {} : { stage }); };
  const server = serve({ input: inbound, output: outbound, signal: stopped.signal, staged: ['before', 'rolled', 'bogus', 'bare'],
    handlers: { plain: raise('rolled_back'), before: raise('before_write'), rolled: raise('rolled_back'), bogus: raise('committed'), bare: raise() } });
  const client = createClient({ input: outbound, output: inbound, timeoutMs: 1000 });
  try {
    const stages = [];
    for (const method of ['plain', 'before', 'rolled', 'bogus', 'bare']) {
      await assert.rejects(client.request(method, {}), error => { stages.push(error.stage); return error.code === 'fiction_refused'; });
    }
    assert.deepEqual(stages, [undefined, 'before_write', 'rolled_back', 'unknown', 'unknown']);
    assert.deepEqual(frames, ['{"id":"1","ok":false,"error":"fiction_refused"}',
      '{"id":"2","ok":false,"error":"fiction_refused","stage":"before_write"}',
      '{"id":"3","ok":false,"error":"fiction_refused","stage":"rolled_back"}',
      '{"id":"4","ok":false,"error":"fiction_refused","stage":"unknown"}',
      '{"id":"5","ok":false,"error":"fiction_refused","stage":"unknown"}']);
  } finally { client.close(); stopped.abort(); inbound.end(); outbound.end(); await server; }
});

test('the memory process stages its ingest and enrich failure frames and no others', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-memory-serve-'));
  const inbound = new PassThrough(), outbound = new PassThrough();
  const frames = [];
  outbound.on('data', part => frames.push(...String(part).trimEnd().split('\n').map(JSON.parse)));
  const rolledBack = code => Object.assign(new MemoryError(code), { stage: 'rolled_back' });
  const store = { async getTurn() { return { id: 'turn-fiction', source: 'pi-memory', entries: [] }; },
    async ingest() { throw new TypeError('driver detail'); },
    async enrich() { throw rolledBack('outcome_referent_required'); },
    async status() { throw rolledBack('fiction_status_refused'); },
    async close() {} };
  const config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ scopes: { read: ['fiction'], write: ['fiction'] } }));
  mkdirSync(join(directory, 'intents'), { mode: 0o700 });
  const served = serveMain(['--config', config, '--scope', 'fiction', '--intent-dir', join(directory, 'intents')],
    { input: inbound, output: outbound, store });
  try {
    const turn = { source: 'pi-memory', conversation_id: 'harbour', turn_id: 't1', entries: [{ id: 'u1', role: 'user', text: 'Orla reopened the harbour.' }] };
    const outcome = { records: [{ id: 'harbour-outcome', kind: 'outcome', text: 'The fictional harbour reopened.', attribution: 'fiction',
      evidence: [{ turn: 'turn-fiction', entry_id: 'u1', start: 0, end: 4 }] }], relations: [] };
    for (const [id, method, args] of [['1', 'ingest', { scope: 'fiction', turn }],
      ['2', 'enrich', { scope: 'fiction', input: outcome, trigger: 'turn-fiction' }], ['3', 'status', { scope: 'fiction' }]]) {
      inbound.write(`${JSON.stringify({ id, method, args })}\n`);
    }
    while (frames.length < 3) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(frames.sort((a, b) => a.id.localeCompare(b.id)), [
      { id: '1', ok: false, error: 'request_failed', stage: 'unknown' },
      { id: '2', ok: false, error: 'outcome_referent_required', stage: 'rolled_back' },
      { id: '3', ok: false, error: 'fiction_status_refused' }]);
  } finally { inbound.end(); await served; outbound.end(); rmSync(directory, { recursive: true, force: true }); }
});

test('the client keeps only a known stage from a failure frame', async () => {
  const inbound = new PassThrough(), outbound = new PassThrough();
  const client = createClient({ input: inbound, output: outbound, timeoutMs: 1000 });
  try {
    const pending = client.request('enrich', {});
    inbound.write('{"id":"1","ok":false,"error":"outcome_referent_required","stage":"committed"}\n');
    await assert.rejects(pending, error => error.code === 'outcome_referent_required' && !('stage' in error));
  } finally { client.close(); inbound.end(); outbound.end(); }
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

// Coverage journal -> memory client -> NDJSON -> memory-process -> Memory -> Neo4jStore.atomicWrite. The driver transaction,
// the trigger read and the body of the store's enrich are replaced; the real referent query runs through the CLI in Q-SM-3.
// The referent check runs inside the write transaction, so a first-attempt refusal is rolled_back.
test('a referent-missing enrich through memory-process is refused with no reconcile; after a driver retry it is uncertain', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-memory-refusal-'));
  const store = new Neo4jStore({ uri: 'bolt://127.0.0.1:1', auth: 'none' });
  try {
    const outcome = { records: [{ id: 'harbour-outcome', kind: 'outcome', text: 'The fictional harbour reopened.', attribution: 'fiction',
      evidence: [{ turn: 'turn-fiction', entry_id: 'u1', start: 0, end: 4 }] }], relations: [] };
    const results = [];
    // The driver retries only a transient Neo4jError, here a stand-in, then the retry raises the refusal.
    const retried = async (_mode, action) => { try { await action({}); } catch { /* transient */ } return action({}); };
    for (const [label, transaction, transient] of [
      ['first attempt', async (_mode, action) => action({}), false], ['driver retry', retried, true]]) {
      let attempt = 0;
      store.transaction = transaction;
      store.enrich = () => store.atomicWrite(() => {
        attempt += 1;
        throw transient && attempt === 1 ? Object.assign(new Error('transient'), { code: 'ServiceUnavailable' })
          : new MemoryError('outcome_referent_required');
      });
      const memory = Object.assign(new Memory({ scopes: { read: ['fiction'], write: ['fiction'] } }, store),
        { show: async () => ({ turn: { id: 'turn-fiction', source: 'pi-memory' } }) });
      const inbound = new PassThrough(), outbound = new PassThrough(), stopped = new AbortController();
      const handlers = createMemoryHandlers({ memory, scopes: ['fiction'] });
      const server = serve({ input: inbound, output: outbound, signal: stopped.signal, handlers, staged: STAGED_METHODS });
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
