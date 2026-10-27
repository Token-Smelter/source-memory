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
    assert.equal(channel.status, 'ready', kind);
    assert.deepEqual(Object.keys(channel.steps), ['status', ...(kind === 'chunk' ? ['chunk_status'] : []),
      'lexical_empty', 'lexical_sample', 'grouped_empty', 'grouped_sample']);
  }
  assert.equal(warm.db.bundle.status, 'ready');
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
    assert.equal(Object.values(warm.db.channels).filter(channel => channel.status === 'ready').length, 0);
  });
}

test('one failing step makes the whole run unavailable and hides the error text', async () => {
  const chunks = indexNames(SCOPE).chunks;
  const { store } = fixture({ answer: (query, params) => {
    if (params?.index === chunks && query.includes('collect({node:node')) throw new Error('bolt://10.0.0.9 password=hunter2');
    return null;
  } });
  const { warm } = await warmDb(config(), SCOPE, store);
  assert.equal(warm.db.status, 'unavailable');
  assert.equal(warm.db.reason, 'database_unavailable');
  assert.equal(warm.db.channels.turn.status, 'ready');
  assert.equal(warm.db.channels.record.status, 'ready');
  assert.deepEqual([warm.db.channels.chunk.status, warm.db.channels.chunk.reason], ['unavailable', 'database_unavailable']);
  assert.doesNotMatch(JSON.stringify(warm), /hunter2|10\.0\.0\.9/);
});

test('a bundle-read failure alone makes the run unavailable', async () => {
  const { store } = fixture({ answer: query => {
    if (query.includes('SM_EVIDENCE]->(t:SMTurn {uid:$uid')) throw new MemoryError('fixture_failure');
    return null;
  } });
  const { warm } = await warmDb(config(), SCOPE, store);
  assert.deepEqual([warm.db.status, warm.db.reason, warm.db.bundle.status], ['unavailable', 'fixture_failure', 'unavailable']);
  assert.equal(warm.db.channels.turn.status, 'ready');
});

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

test('reaching the ceiling is unavailable with reason ceiling, and the timer is cleared', async () => {
  const records = indexNames(SCOPE).records;
  const { store } = fixture({ answer: (query, params) => params?.index === records && !query.includes('collect({node:node') ? { hang: true } : null });
  const before = timers();
  const started = performance.now();
  const { warm } = await warmDb(config(), SCOPE, store, { ceilingMs: 100 });
  assert.ok(performance.now() - started < 5000);
  assert.equal(warm.db.status, 'unavailable');
  assert.equal(warm.db.reason, 'ceiling');
  assert.equal(warm.db.ceiling_ms, 100);
  assert.deepEqual([warm.db.channels.record.status, warm.db.channels.record.reason], ['unavailable', 'ceiling']);
  assert.equal(warm.db.channels.turn.status, 'ready');
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
  assert.deepEqual(new Set(modes), new Set(['read']));
  assert.equal(closed(), 1);
  assert.equal(requests.length, 0);
});

test('CLI closes the store when the run is unavailable and still reports ok', async t => {
  const { path, out, io } = await cli(t);
  const { store, closed } = fixture({ answer: query => { if (query.includes('SHOW FULLTEXT')) throw new Error('down'); return null; } });
  await main(['warm', '--db', 'v1', '--config', path, '--scope', SCOPE], io(store));
  const reply = JSON.parse(out[0]);
  assert.deepEqual([reply.ok, reply.warm.db.status, reply.warm.db.reason], [true, 'unavailable', 'database_unavailable']);
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
