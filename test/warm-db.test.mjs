import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as tcp } from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../bin/memory.mjs';
import { indexNames, MemoryError } from '../src/core.mjs';
import { Neo4jStore } from '../src/store.mjs';
import * as warmModule from '../src/warm-db.mjs';
import { warmDb, WARM_EXCLUDE_SAMPLE, WARM_QUERY, WARM_RUN_CEILING_MS } from '../src/warm-db.mjs';

const BIN = fileURLToPath(new URL('../bin/memory.mjs', import.meta.url));
const SCOPE = 'private-scope-name';
const SECRET = 'SECRET MEMORY TEXT';
const config = (extra = {}) => ({ scopes: { read: [SCOPE], write: ['writer-only'] }, ...extra });
const timers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;

/**
 * The real Neo4jStore over a fake driver: real methods and query text, and every transaction's mode recorded.
 * `answer(query, params)` may return `{ hang }`, throw, or return records; the default is an ONLINE index and no rows.
 */
function fixture({ answer = () => null, secret = false } = {}) {
  const runs = [];
  const modes = [];
  let closed = 0;
  const hit = { get: key => key === 'node' ? { properties: { uid: 'n', scope: SCOPE, record_id: 'r', text: SECRET, entry_id: 'e', start: 0, end: 3 } }
    : { properties: { uid: 't', scope: SCOPE, source: 'x', conversation_id: 'c',
      body: JSON.stringify({ source: 'x', conversation_id: 'c', entries: [{ id: 'e', role: 'user', text: SECRET }] }) } } };
  const session = () => ({
    async executeRead(action) { modes.push('read'); return action(tx('read')); },
    async executeWrite(action) { modes.push('write'); return action(tx('write')); },
    async close() {},
  });
  const tx = mode => ({
    async run(query, params) {
      runs.push({ mode, query, params });
      const custom = answer(query, params);
      if (custom?.hang) return new Promise(() => {});
      if (custom) return custom;
      if (query.includes('SHOW FULLTEXT INDEXES')) return { records: [{ get: () => 'ONLINE' }] };
      const ungrouped = query.includes('db.index.fulltext.queryNodes') && !query.includes('collect({node:node');
      return { records: secret && ungrouped ? [hit] : [] };
    },
  });
  const store = Object.assign(Object.create(Neo4jStore.prototype), { database: 'neo4j',
    driver: { session, async close() { closed += 1; } } });
  return { store, runs, modes, closed: () => closed };
}

const queries = runs => runs.filter(run => run.query.includes('db.index.fulltext.queryNodes'));

test('constants are fixed and the freshness window is not defined here', async () => {
  assert.equal(WARM_RUN_CEILING_MS, 20000);
  assert.equal(WARM_QUERY, 'source memory warm');
  assert.deepEqual(WARM_EXCLUDE_SAMPLE, [{ source: 'source-memory-warm', conversation_id: 'absent' }]);
  assert.equal('WARM_FRESHNESS_WINDOW_MS' in warmModule, false);
  const source = await readFile(new URL('../src/warm-db.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/^import .* from '(.+)';$/gm)].map(match => match[1]), ['./core.mjs']);
});

test('a full run is ready, reads only, and runs every recall query shape once', async () => {
  const { store, runs, modes } = fixture();
  const before = timers();
  const { warm } = await warmDb(config(), SCOPE, store);
  assert.equal(warm.db.status, 'ready');
  assert.equal(warm.db.reason, undefined);
  assert.equal(warm.db.ceiling_ms, 20000);
  assert.ok(Number.isInteger(warm.db.ms) && warm.db.ms >= 0);
  assert.deepEqual(Object.keys(warm.db.channels), ['turn', 'record', 'chunk']);
  for (const [kind, channel] of Object.entries(warm.db.channels)) {
    assert.equal(channel.result, 'completed', kind);
    assert.equal(channel.status, undefined, kind);
    assert.deepEqual(Object.keys(channel.steps), ['status', ...(kind === 'chunk' ? ['chunk_status'] : []),
      'lexical_empty', 'lexical_sample', 'grouped_empty', 'grouped_sample']);
  }
  assert.equal(warm.db.bundle.result, 'completed');
  assert.deepEqual(new Set(modes), new Set(['read']));
  assert.deepEqual(new Set(runs.map(run => run.mode)), new Set(['read']));
  const search = queries(runs);
  assert.equal(search.length, 12);
  assert.deepEqual(search.map(run => run.params.exclude.length).sort(), [...Array(6).fill(0), ...Array(6).fill(1)]);
  for (const run of search) {
    assert.equal(run.params.query, '"source" OR "memory" OR "warm"');
    if (run.params.exclude.length) assert.deepEqual(run.params.exclude, WARM_EXCLUDE_SAMPLE);
  }
  const names = indexNames(SCOPE);
  for (const [kind, index] of [['turn', names.turns], ['record', names.records], ['chunk', names.chunks]]) {
    const own = search.filter(run => run.params.index === index);
    assert.equal(own.length, 4, kind);
    assert.equal(own.filter(run => run.query.includes('collect({node:node')).length, 2, kind);
  }
  assert.equal(runs.filter(run => run.query.includes('t.source IS NULL OR t.conversation_id IS NULL')).length, 6);
  assert.equal(runs.filter(run => run.query.includes('SHOW FULLTEXT INDEXES')).length, 4);
  assert.ok(runs.filter(run => run.params.uid === 'source-memory-warm-absent').length >= 2);
  assert.equal(timers(), before);
});

test('the reply carries no memory text and no scope content', async () => {
  const { store } = fixture({ secret: true });
  const reply = JSON.stringify(await warmDb(config(), SCOPE, store));
  assert.doesNotMatch(reply, new RegExp(`${SECRET}|${SCOPE}|neo4j`));
  assert.match(reply, /"status":"ready"/);
});

for (const [name, state, reason] of [['populating', 'POPULATING', 'index_not_ready'], ['missing', null, 'index_not_ready'],
  ['failed', 'FAILED', 'index_not_ready']]) {
  test(`an index that is ${name} is unavailable, never ready`, async () => {
    const { store } = fixture({ answer: query => query.includes('SHOW FULLTEXT INDEXES')
      ? { records: state ? [{ get: () => state }] : [] } : null });
    const { warm } = await warmDb(config(), SCOPE, store);
    assert.equal(warm.db.status, 'unavailable');
    assert.equal(warm.db.reason, reason);
    assert.equal(Object.values(warm.db.channels).filter(channel => channel.result === 'completed').length, 0);
  });
}

test('one failing step makes the whole run unavailable, hides the error text, and still only reads', async () => {
  const chunks = indexNames(SCOPE).chunks;
  const { store, runs, modes } = fixture({ answer: (query, params) => {
    if (params?.index === chunks && query.includes('collect({node:node')) throw new Error('bolt://10.0.0.9 password=hunter2');
    return null;
  } });
  const { warm } = await warmDb(config(), SCOPE, store);
  assert.equal(warm.db.status, 'unavailable');
  assert.equal(warm.db.reason, 'database_unavailable');
  assert.equal(warm.db.channels.turn.result, 'completed');
  assert.equal(warm.db.channels.record.result, 'completed');
  assert.deepEqual([warm.db.channels.chunk.result, warm.db.channels.chunk.reason], ['failed', 'database_unavailable']);
  assert.doesNotMatch(JSON.stringify(warm), /hunter2|10\.0\.0\.9/);
  assert.deepEqual(new Set(modes), new Set(['read']));
  assert.deepEqual(new Set(runs.map(run => run.mode)), new Set(['read']));
});

test('a bundle-read failure alone makes the run unavailable', async () => {
  const { store } = fixture({ answer: query => {
    if (query.includes('SM_EVIDENCE]->(t:SMTurn {uid:$uid')) throw new MemoryError('fixture_failure');
    return null;
  } });
  const { warm } = await warmDb(config(), SCOPE, store);
  assert.deepEqual([warm.db.status, warm.db.reason, warm.db.bundle.result], ['unavailable', 'fixture_failure', 'failed']);
  assert.equal(warm.db.channels.turn.result, 'completed');
});

for (const [label, code] of [['undefined', undefined], ['empty', ''], ['absent', 'absent']]) {
  const failure = () => label === 'absent' ? new MemoryError() : new MemoryError(code);
  test(`a codeless MemoryError (${label}) thrown asynchronously is unavailable, not ready`, async () => {
    const { store } = fixture();
    store.lexicalStatus = async () => { throw failure(); };
    const { warm } = await warmDb(config(), SCOPE, store);
    assert.deepEqual([warm.db.status, warm.db.reason], ['unavailable', 'database_unavailable']);
    for (const channel of Object.values(warm.db.channels)) assert.deepEqual([channel.result, channel.reason], ['failed', 'database_unavailable']);
  });

  test(`a codeless MemoryError (${label}) thrown synchronously is unavailable, not ready`, async () => {
    const { store } = fixture();
    store.lexical = () => { throw failure(); };
    const { warm } = await warmDb(config(), SCOPE, store);
    assert.deepEqual([warm.db.status, warm.db.reason], ['unavailable', 'database_unavailable']);
    assert.deepEqual([warm.db.channels.turn.result, warm.db.channels.turn.reason], ['failed', 'database_unavailable']);
    assert.equal(warm.db.channels.chunk.result, 'completed');
  });
}

test('a malformed answer is unavailable', async () => {
  for (const patch of [store => { store.lexicalStatus = async () => ({}); },
    store => { store.lexical = async () => ({ rows: [] }); },
    store => { store.admittedLexical = async () => ({ hits: [] }); },
    store => { store.getTurn = async () => ({ id: 'something' }); }]) {
    const { store } = fixture();
    patch(store);
    const { warm } = await warmDb(config(), SCOPE, store);
    assert.deepEqual([warm.db.status, warm.db.reason], ['unavailable', 'malformed_reply']);
  }
});

// Each reply has the wrong shape and carries text that must never reach the output.
for (const [method, wrong, owner] of [
  ['chunkLexical', { rows: [{ text: SECRET }] }, 'chunk'],
  ['chunkLexicalStatus', { state: SECRET }, 'chunk'],
  ['recordsForTurn', null, 'bundle'],
  ['neighbors', SECRET, 'bundle'],
  ['getRecord', { id: 'r', text: SECRET }, 'bundle']]) {
  test(`a wrong-shape ${method} answer is unavailable as malformed_reply and shows no text`, async () => {
    const { store } = fixture();
    store[method] = async () => wrong;
    const { warm } = await warmDb(config(), SCOPE, store);
    assert.deepEqual([warm.db.status, warm.db.reason], ['unavailable', 'malformed_reply']);
    const record = owner === 'bundle' ? warm.db.bundle : warm.db.channels[owner];
    assert.deepEqual([record.result, record.reason], ['failed', 'malformed_reply']);
    assert.doesNotMatch(JSON.stringify(warm), new RegExp(SECRET));
  });
}

test('reaching the ceiling fails all four records with reason ceiling, and the timer is cleared', async () => {
  const { store, modes } = fixture({ answer: () => ({ hang: true }) });
  const before = timers();
  const started = performance.now();
  const { warm } = await warmDb(config(), SCOPE, store, { ceilingMs: 100 });
  assert.ok(performance.now() - started < 5000);
  assert.equal(warm.db.status, 'unavailable');
  assert.equal(warm.db.reason, 'ceiling');
  assert.equal(warm.db.ceiling_ms, 100);
  for (const record of [...Object.values(warm.db.channels), warm.db.bundle]) assert.deepEqual([record.result, record.reason], ['failed', 'ceiling']);
  assert.deepEqual(new Set(modes), new Set(['read']));
  assert.equal(timers(), before);
});

test('a ceiling that stops one channel leaves the finished ones completed', async () => {
  const records = indexNames(SCOPE).records;
  const { store } = fixture({ answer: (query, params) => params?.index === records && !query.includes('collect({node:node') ? { hang: true } : null });
  const { warm } = await warmDb(config(), SCOPE, store, { ceilingMs: 100 });
  assert.deepEqual([warm.db.status, warm.db.reason], ['unavailable', 'ceiling']);
  assert.deepEqual([warm.db.channels.record.result, warm.db.channels.record.reason], ['failed', 'ceiling']);
  assert.equal(warm.db.channels.turn.result, 'completed');
});

function deepFreeze(value) {
  if (value && typeof value === 'object') for (const inner of Object.values(value)) deepFreeze(inner);
  return Object.freeze(value);
}

test('a step that resolves after the ceiling cannot change the returned result', async () => {
  const { store } = fixture();
  store.admittedLexical = async (_scope, kind) => {
    if (kind === 'record') await new Promise(resolve => setTimeout(resolve, 100));
    return { hits: [], omitted: [] };
  };
  const { warm } = await warmDb(config(), SCOPE, store, { ceilingMs: 40 });
  assert.deepEqual([warm.db.status, warm.db.reason], ['unavailable', 'ceiling']);
  const result = { warm };
  const snapshot = deepFreeze(structuredClone(result));
  // The record's two delayed steps finish about 200 ms after the start.
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(result, snapshot);
  assert.deepEqual([warm.db.channels.record.result, warm.db.channels.record.reason], ['failed', 'ceiling']);
});

test('work that finishes synchronously past the ceiling is unavailable with reason ceiling', async () => {
  const { store } = fixture();
  let spun = false;
  store.admittedLexical = async () => {
    if (!spun) { spun = true; for (const end = performance.now() + 200; performance.now() < end;); }
    return { hits: [], omitted: [] };
  };
  const before = timers();
  const { warm } = await warmDb(config(), SCOPE, store, { ceilingMs: 50 });
  assert.ok(warm.db.ms > 50);
  assert.deepEqual([warm.db.status, warm.db.reason, warm.db.ceiling_ms], ['unavailable', 'ceiling', 50]);
  assert.equal(JSON.stringify(warm).includes('"status":"ready"'), false);
  assert.equal(timers(), before);
});

test('the product ceiling is the default', async () => {
  const { store } = fixture();
  assert.equal((await warmDb(config(), SCOPE, store)).warm.db.ceiling_ms, WARM_RUN_CEILING_MS);
});

test('a scope without read authorization is refused before any query', async () => {
  const { store, runs } = fixture();
  await assert.rejects(warmDb(config(), 'writer-only', store), { code: 'scope_denied' });
  await assert.rejects(warmDb(config(), 'unlisted', store), { code: 'scope_denied' });
  assert.equal(runs.length, 0);
});

async function cli(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'warm-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(config(extra)));
  const out = [];
  return { path, out, io: store => ({ store, stdout: { write: chunk => out.push(chunk) }, stderr: { write() {} } }) };
}

test('CLI warm --db v1 prints the reply, closes the store, and never calls a model endpoint', async t => {
  const requests = [];
  const server = createServer((req, res) => { requests.push(req.url); res.end('{}'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const { path, out, io } = await cli(t, { embedding: { url: `${url}/v1/embeddings`, model: 'fixture', dimensions: 2 },
    reranker: { url: `${url}/rerank`, model: 'fixture' } });
  const { store, modes, closed } = fixture();
  await main(['warm', '--db', 'v1', '--config', path, '--scope', SCOPE], io(store));
  assert.equal(out.length, 1);
  assert.ok(out[0].endsWith('\n'));
  const reply = JSON.parse(out[0]);
  assert.equal(reply.ok, true);
  assert.equal(reply.warm.db.status, 'ready');
  assert.equal(out[0].split('"status":"ready"').length - 1, 1);
  assert.deepEqual(new Set(modes), new Set(['read']));
  assert.equal(closed(), 1);
  assert.equal(requests.length, 0);
});

test('CLI closes the store when the run is unavailable and still reports ok', async t => {
  const { path, out, io } = await cli(t);
  // Only the chunk index fails, so the other channels and the bundle complete: a caller must not read them as ready.
  const chunks = indexNames(SCOPE).chunks;
  const { store, closed, modes } = fixture({ answer: (query, params) => {
    if (query.includes('SHOW FULLTEXT') && params.name === chunks) throw new Error('down');
    return null;
  } });
  await main(['warm', '--db', 'v1', '--config', path, '--scope', SCOPE], io(store));
  const reply = JSON.parse(out[0]);
  assert.deepEqual([reply.ok, reply.warm.db.status, reply.warm.db.reason], [true, 'unavailable', 'database_unavailable']);
  assert.equal(reply.warm.db.channels.turn.result, 'completed');
  assert.equal(out[0].includes('"status":"ready"'), false);
  assert.deepEqual(new Set(modes), new Set(['read']));
  assert.equal(closed(), 1);
});

test('CLI warm --db v1 keeps the scope error path', async t => {
  const { path, out, io } = await cli(t);
  const { store, runs, closed } = fixture();
  await assert.rejects(main(['warm', '--db', 'v1', '--config', path, '--scope', 'unlisted'], io(store)), { code: 'scope_denied' });
  assert.equal(runs.length, 0);
  assert.equal(out.length, 0);
  assert.equal(closed(), 1);
});

test('--db accepts only v1 and only on warm', async t => {
  const { path, out, io } = await cli(t);
  const { store, runs } = fixture();
  for (const argv of [['warm', '--db', 'v2'], ['warm', '--db', ''], ['warm', '--db'], ['recall', '--db', 'v1'], ['status', '--db', 'v1'],
    ['warm', '--db', 'v1', '--db', 'v1']]) {
    await assert.rejects(main([...argv, '--config', path, '--scope', SCOPE], io(store)), { code: 'invalid_arguments' }, argv.join(' '));
  }
  assert.equal(runs.length, 0);
  assert.equal(out.length, 0);
});

test('warm without --db is unchanged: one embedding request and no database connection', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url);
    for await (const _chunk of req);
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let connections = 0;
  const db = tcp(socket => { connections += 1; socket.destroy(); });
  db.listen(0, '127.0.0.1');
  await once(db, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  t.after(() => new Promise(resolve => db.close(resolve)));
  const dir = await mkdtemp(join(tmpdir(), 'warm-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(config({ neo4j: { uri: `bolt://127.0.0.1:${db.address().port}`, auth: 'none' },
    embedding: { url: `http://127.0.0.1:${server.address().port}/v1/embeddings`, model: 'fixture', dimensions: 2 } })));
  const stdout = await new Promise((resolve, reject) => execFile(process.execPath, [BIN, 'warm', '--config', path, '--scope', SCOPE],
    { timeout: 15000 }, (error, out) => error ? reject(error) : resolve(out)));
  const reply = JSON.parse(stdout);
  assert.equal(reply.ok, true);
  assert.equal(reply.warm.model, 'fixture');
  assert.equal(reply.warm.db, undefined);
  assert.equal(requests.length, 1);
  assert.equal(connections, 0);
});
