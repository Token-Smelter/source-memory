import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Memory } from '../src/memory.mjs';
import { digest, identity, MemoryError, normalizeEnrichment, RECORD_CONTRACT } from '../src/core.mjs';
import { embeddingIdentity } from '../src/models.mjs';
import { Neo4jStore } from '../src/store.mjs';
import { failureReply, main } from '../bin/memory.mjs';
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

// Runs bin/memory.mjs main in process with a supplied store; returns the reply line the CLI would print.
async function cliReply(t, command, settings, input, store) {
  const scratch = await mkdtemp(join(tmpdir(), 'source-memory-qualification-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await writeFile(join(scratch, 'config.json'), JSON.stringify(settings));
  await writeFile(join(scratch, 'input.json'), JSON.stringify(input));
  let stdout = '';
  try {
    await main([command, '--config', join(scratch, 'config.json'), '--scope', 'fiction', '--input', join(scratch, 'input.json')],
      { store, stdout: { write: line => { stdout += line; } }, stderr: { write() {} } });
  } catch (error) { return failureReply(command, error); }
  return JSON.parse(stdout);
}

const listed = async kind => [...qualificationCodes(await readFile(join(root, 'QUALIFICATION.md'), 'utf8'))]
  .filter(([, value]) => value === kind).map(([code]) => code).sort();

// Each post-commit code comes from a real indexing failure after the write and reaches the caller only as indexing.reason
// in an ok:true reply. Moving a code into or out of post-commit in QUALIFICATION.md fails this test.
test('every post-commit code is reported inside an ok:true CLI reply after the write', async t => {
  const hung = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const { model, input } = JSON.parse(body);
    const vectors = embedding => res.end(JSON.stringify({ model, data: input.map((_, index) => ({ index, embedding })) }));
    if (req.url === '/down') res.writeHead(503).end();
    else if (req.url === '/hang') hung.push(res);
    else if (req.url === '/large') res.end('x'.repeat(8_000_001));
    else if (req.url === '/other-model') res.end(JSON.stringify({ model: 'other', data: [] }));
    else if (req.url === '/short') res.end(JSON.stringify({ model, data: [] }));
    else if (req.url === '/bad-vector') vectors([1]);
    else vectors([1, 0]);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => { for (const res of hung) res.destroy(); server.closeAllConnections(); server.close(done); }));
  const embedding = (path, extra) => ({ url: `http://127.0.0.1:${server.address().port}${path}`, model: 'fixture', dimensions: 2, ...extra });
  const cases = [
    ['model_request_failed', embedding('/down')],
    ['model_timeout', embedding('/hang', { timeout_ms: 50 })],
    ['model_response_too_large', embedding('/large')],
    ['invalid_model_endpoint', embedding('/ok', { url: 'ftp://127.0.0.1/embed' })],
    ['model_endpoint_must_be_loopback', embedding('/ok', { url: 'http://embedding.example.invalid/embed' })],
    ['embedding_model_mismatch', embedding('/other-model')],
    ['invalid_embedding_response', embedding('/short')],
    ['invalid_embedding', embedding('/bad-vector')],
    ['database_unavailable', embedding('/ok'), { async saveEmbeddings() { throw new TypeError('driver detail'); } }],
  ];
  const exercised = new Set();
  for (const command of ['ingest', 'enrich']) {
    for (const [code, settings, override] of cases) {
      const store = Object.assign(fakeStore({ pending: 1 }), override);
      const reply = await cliReply(t, command, config({ embedding: settings }), command === 'ingest' ? turn : enrichment, store);
      assert.deepEqual([reply.ok, reply.indexing, store.writes], [true, { status: 'unavailable', reason: code, source_retained: true }, 1],
        `${command} ${code}`);
      exercised.add(code);
    }
  }
  assert.deepEqual([...exercised].sort(), await listed('post-commit'));
});

// Neither ingest nor enrich raises these; they belong to read commands, init and warm. Pinned so a code cannot move between
// this class and another without this test changing with it.
test('QUALIFICATION.md lists exactly the pinned not-on-write-path and stage-dependent codes', async () => {
  assert.deepEqual(await listed('not-on-write-path'), ['conversation_unavailable', 'embedding_unconfigured', 'index_not_ready',
    'index_scope_mismatch', 'invalid_rerank_response', 'malformed_reply', 'not_found', 'output_envelope_exceeded',
    'reranker_model_mismatch', 'source_unavailable', 'vector_index_dimension_mismatch', 'vector_index_quantization_mismatch',
    'vector_index_schema_mismatch']);
  assert.deepEqual(await listed('stage-dependent'), ['operation_failed']);
});

// The outcome is decided before close: a committed write must not become a failure reply because close() rejected.
test('a close failure after a successful write still gives an ok:true CLI reply', async t => {
  const indexing = { status: 'unconfigured', indexed: 0 };
  for (const [command, input, expected] of [
    ['ingest', turn, { ok: true, id: 'turn_fixture', replayed: false, retained: true, indexing }],
    ['enrich', enrichment, { ok: true, records: ['lighthouse-teal'], relations: [], indexing }]]) {
    let closed = 0;
    const store = Object.assign(fakeStore(), { async close() { closed += 1; throw new Error('driver close failed'); } });
    assert.deepEqual([await cliReply(t, command, config(), input, store), closed], [expected, 1], command);
  }
});
