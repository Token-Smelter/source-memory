import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Memory } from '../src/memory.mjs';
import { digest, identity, MemoryError, normalizeEnrichment, RECORD_CONTRACT } from '../src/core.mjs';
import { embeddingIdentity } from '../src/models.mjs';
import { Neo4jStore } from '../src/store.mjs';
import { failureReply } from '../bin/memory.mjs';
import { qualificationCodes, sourceCodes, TRANSPORT_CODES } from './helpers/qualification-codes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function embeddingServer(t, { fail = false } = {}) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    if (fail) { res.writeHead(503).end(); return; }
    const input = JSON.parse(body);
    res.end(JSON.stringify({ model: input.model, data: input.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  return { url: `http://127.0.0.1:${server.address().port}/embed`, model: 'fixture', dimensions: 2 };
}

function fakeStore({ pending = 0, onWrite = () => {} } = {}) {
  return {
    writes: 0,
    async ingest() { this.writes += 1; onWrite(); return { id: 'turn_fixture', replayed: false, retained: true }; },
    async enrich() { this.writes += 1; onWrite(); return { records: ['lighthouse-teal'], relations: [] }; },
    async pendingEmbeddings(_scope, _key, limit) {
      return Array.from({ length: Math.min(pending, limit) }, (_, index) => ({ uid: `chunk_${index}`, text: `fictional ${index}` }));
    },
    async saveEmbeddings() {},
    async close() {},
  };
}

const turn = { source: 'fixture', conversation_id: 'c', turn_id: 't', entries: [{ id: 'u1', role: 'user', text: 'Orla chose teal shutters.' }] };
const enrichment = { records: [{ id: 'lighthouse-teal', kind: 'decision', text: 'Orla chose teal shutters for the fictional lighthouse.',
  attribution: 'fixture', evidence: [{ turn: 'turn_fixture', entry_id: 'u1', start: 0, end: 10 }] }], relations: [] };
const config = extra => ({ scopes: { read: ['fiction'], write: ['fiction'] }, ...extra });

// Byte-for-byte the return values of main before this change; the evaluation harness compares treatments against them.
test('successful ingest and enrich return the unchanged bytes for every indexing outcome', async t => {
  const ready = await embeddingServer(t);
  const down = await embeddingServer(t, { fail: true });
  const key = embeddingIdentity(ready);
  const cases = [
    ['unconfigured', config(), 0, { status: 'unconfigured', indexed: 0 }],
    ['deferred', config({ embedding: ready, index_on_write: false }), 3, { status: 'deferred', indexed: 0 }],
    ['ready', config({ embedding: ready }), 3, { status: 'ready', indexed: 3, embedding_key: key }],
    ['pending', config({ embedding: ready }), 300, { status: 'pending', indexed: 256, embedding_key: key }],
    ['unavailable', config({ embedding: down }), 3, { status: 'unavailable', reason: 'model_request_failed', source_retained: true }],
  ];
  for (const [label, settings, pending, indexing] of cases) {
    const memory = new Memory(settings, fakeStore({ pending }));
    assert.equal(JSON.stringify(await memory.ingest('fiction', turn)),
      JSON.stringify({ id: 'turn_fixture', replayed: false, retained: true, indexing }), `ingest ${label}`);
    assert.equal(JSON.stringify(await memory.enrich('fiction', enrichment)),
      JSON.stringify({ records: ['lighthouse-teal'], relations: [], indexing }), `enrich ${label}`);
  }
});

// Q-SM-6: the configuration changing between the write's authorization and indexing used to throw scope_denied after commit.
test('a committed write never throws, even if the write grant is revoked before indexing', async t => {
  const embedding = await embeddingServer(t);
  for (const method of ['ingest', 'enrich']) {
    const settings = config({ embedding });
    const store = fakeStore({ pending: 1, onWrite: () => { settings.scopes.write = []; } });
    const result = await new Memory(settings, store)[method]('fiction', method === 'ingest' ? turn : enrichment);
    assert.deepEqual([store.writes, result.indexing.status], [1, 'ready'], method);
  }
});

test('a post-commit indexing failure of any kind is reported in indexing, not thrown', async t => {
  const embedding = await embeddingServer(t);
  for (const failure of [new TypeError('driver detail'), new MemoryError('invalid_embedding')]) {
    const store = { ...fakeStore(), async pendingEmbeddings() { throw failure; } };
    const result = await new Memory(config({ embedding }), store).enrich('fiction', enrichment);
    assert.deepEqual(result.indexing, { status: 'unavailable', reason: failure instanceof MemoryError ? failure.code : 'database_unavailable',
      source_retained: true });
  }
});

test('a refusal before the store write is marked before_write and never reaches the store', async () => {
  const store = fakeStore();
  const memory = new Memory(config(), store);
  for (const [method, scope, input, code] of [['enrich', 'other', enrichment, 'scope_denied'], ['ingest', 'other', turn, 'scope_denied'],
    ['enrich', 'fiction', { records: [{ ...enrichment.records[0], kind: 'rumour' }], relations: [] }, 'invalid_kind'],
    ['ingest', 'fiction', { ...turn, entries: [{ ...turn.entries[0], role: 'narrator' }] }, 'invalid_role']]) {
    await assert.rejects(memory[method](scope, input), error => error.code === code && error.stage === 'before_write');
  }
  assert.equal(store.writes, 0);
});

test('a write refusal is rolled_back only on the first transaction attempt', async () => {
  const store = new Neo4jStore({ uri: 'bolt://127.0.0.1:1', auth: 'none' });
  try {
    store.transaction = async (_mode, action) => action({});
    await assert.rejects(store.atomicWrite(() => { throw new MemoryError('record_identity_conflict'); }),
      error => error.stage === 'rolled_back');
    // The driver retried: an earlier attempt may have committed before its reply was lost.
    store.transaction = async (_mode, action) => { try { await action({}); } catch { /* retryable */ } return action({}); };
    let attempt = 0;
    await assert.rejects(store.atomicWrite(() => {
      attempt += 1;
      throw attempt === 1 ? new Error('transient') : new MemoryError('record_identity_conflict');
    }), error => error.code === 'record_identity_conflict' && error.stage === undefined);
    store.transaction = async () => { throw new Error('ServiceUnavailable'); };
    await assert.rejects(store.atomicWrite(() => {}), error => error.stage === undefined);
  } finally { await store.close(); }
});

test('the CLI failure reply carries the write stage for ingest and enrich only', () => {
  const marked = (code, stage) => Object.assign(new MemoryError(code), stage ? { stage } : {});
  assert.deepEqual([
    failureReply('enrich', marked('scope_denied', 'before_write')),
    failureReply('enrich', marked('record_identity_conflict', 'rolled_back')),
    failureReply('ingest', marked('record_identity_conflict')),
    failureReply('ingest', new TypeError('driver detail')),
    failureReply('ingest', Object.assign(new SyntaxError('x'), { stage: 'before_write' })),
    failureReply('recall', marked('scope_denied', 'before_write')),
  ], [
    { ok: false, error: 'scope_denied', stage: 'before_write' },
    { ok: false, error: 'record_identity_conflict', stage: 'rolled_back' },
    { ok: false, error: 'record_identity_conflict', stage: 'unknown' },
    { ok: false, error: 'operation_failed', stage: 'unknown' },
    { ok: false, error: 'invalid_json', stage: 'before_write' },
    { ok: false, error: 'scope_denied' },
  ]);
});

// Q-SM-5: a failure here means the stored uid, body or hash changed for the same input. Bump RECORD_CONTRACT and these pins.
test('record contract version 1 derives the pinned uid, body and digest', () => {
  const input = { records: [{ ...enrichment.records[0], extra: 'dropped by normalization' }],
    relations: [{ id: 'teal-qualifies', type: 'qualifies', from: 'lighthouse-teal', to: 'lighthouse-paint', attribution: 'fixture',
      evidence: [{ turn: 'turn_fixture', entry_id: 'u1', start: 0, end: 4 }] }] };
  const { records: [record], relations: [relation] } = normalizeEnrichment(input);
  assert.deepEqual([RECORD_CONTRACT, JSON.stringify(record), digest(record), identity('record', 'fiction', record.id),
    digest(relation), identity('relation', 'fiction', relation.id)], [
    'source-memory.record/1',
    '{"id":"lighthouse-teal","kind":"decision","text":"Orla chose teal shutters for the fictional lighthouse.","status":"proposed","attribution":"fixture","evidence":[{"turn":"turn_fixture","entry_id":"u1","start":0,"end":10}]}',
    '4411e0302af6284e8d5c89105f852d7350371945e77d1a554d3ef00dd108f88c',
    'record_376a18d7512d7645efb28d5ab756847b2527b3a43f805a5b29e8b65d8c37d5fd',
    '765023c4e853e964f23c7ac5c9d519315ca157351c242d92a3c84e5e4131acaa',
    'relation_425afe898e1b8a85c01a7cd1aa2739379d816b2990256b16c4a6ec17c0bbca31',
  ]);
});

test('status names the store and the record contract', async () => {
  const store = { status: async () => ({ turns: 0 }), vectorIndexStatus: async () => 'missing',
    identity: async () => ({ system: 'neo4j', database_id: 'db-fixture', database: 'neo4j' }) };
  const status = await new Memory(config(), store).status('fiction');
  assert.deepEqual(status.store, { system: 'neo4j', database_id: 'db-fixture', database: 'neo4j', record_contract: 'source-memory.record/1' });
});

// Q-SM-3: refusals the enrich transaction raises before its first MERGE.
test('every enrich check that precedes the first MERGE precedes it in source order', () => {
  const source = Neo4jStore.prototype.enrich.toString();
  const firstMerge = source.indexOf('MERGE');
  for (const marker of ["'evidence_unavailable'", 'sourceExcerpt(', "'relation_endpoint_unavailable'", "'invalid_outcome_relation'",
    "'outcome_referent_required'"]) {
    assert.ok(source.indexOf(marker) > 0 && source.indexOf(marker) < firstMerge, marker);
  }
  for (const marker of ["'record_identity_conflict'", "'relation_identity_conflict'"]) assert.ok(source.indexOf(marker) > firstMerge, marker);
});

test('QUALIFICATION.md classifies exactly the codes the CLI transport can raise', async () => {
  const documented = qualificationCodes(await readFile(join(root, 'QUALIFICATION.md'), 'utf8'));
  const raised = await sourceCodes(join(root, 'bin/memory.mjs'));
  assert.deepEqual([...documented.keys()].sort(), [...new Set([...raised, ...TRANSPORT_CODES])].sort());
});
