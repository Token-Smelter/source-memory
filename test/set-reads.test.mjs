import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeSelection, fuseGroups, SCOPE_SET_MAX } from '../src/core.mjs';
import { selection } from '../src/store.mjs';
import { Memory } from '../src/memory.mjs';
import { failureReply, main } from '../bin/memory.mjs';
import { BATTERY, runBattery, SCOPE } from './fixtures/digest-store.mjs';

const BASELINE = JSON.parse(readFileSync(new URL('./fixtures/digest-baseline.json', import.meta.url), 'utf8'));
const settings = (read, write = read) => ({ scopes: { read, write } });
const untouched = () => new Proxy({}, { get: () => { throw new Error('storage touched'); } });

test('a set is 1 to 4 distinct exact scopes, each granted on its own, sorted in UTF-16 code-unit order', () => {
  const config = settings(['acme/**', 'beta', 'Zed']);
  assert.equal(SCOPE_SET_MAX, 4);
  assert.deepEqual(authorizeSelection(config, ['beta', 'acme/x', 'Zed', 'acme']), { scopes: ['Zed', 'acme', 'acme/x', 'beta'] });
  assert.equal(authorizeSelection(config, ['acme/x']), 'acme/x', 'one element is that exact scope');
  for (const value of [[], ['acme', 'beta', 'Zed', 'acme/x', 'acme/y'], ['beta', 'beta'], ['beta', 7], ['beta', 'x'.repeat(257)]]) {
    assert.throws(() => authorizeSelection(config, value), { code: 'invalid_input' }, JSON.stringify(value));
  }
  assert.throws(() => authorizeSelection(config, ['beta', 'acme/**']), { code: 'scope_denied' }, 'a selector is never an element');
  assert.throws(() => authorizeSelection(config, ['beta', 'gamma']), { code: 'scope_denied' }, 'one ungranted element refuses the read');
  assert.throws(() => authorizeSelection(settings(['acme/x', 'acme/y']), ['acme/x', 'acme/y', 'acme/z']), { code: 'scope_denied' });
});

test('a one-element set gives the bytes and store calls of the exact read, for every pinned read a set may make', async () => {
  const exactOnly = BATTERY.filter(([, method, input]) => method === 'show' && !['bundle', 'units', 'following'].includes(input.kind)).map(([name]) => name);
  assert.deepEqual(exactOnly, ['show_record', 'show_record_unhashed', 'show_turn', 'show_turn_by_key']);
  const names = Object.keys(BASELINE).filter(name => !exactOnly.includes(name));
  const current = await runBattery(Memory, {}, [SCOPE], names);
  assert.deepEqual(Object.keys(current), names);
  for (const [name, { reply, calls }] of Object.entries(BASELINE).filter(([key]) => names.includes(key))) {
    assert.equal(current[name].reply, reply, `${name} reply`);
    assert.equal(current[name].calls, calls, `${name} store calls`);
  }
});

test('every operation outside recall, list and show bundle/units/following refuses a set, before storage', async () => {
  const memory = new Memory(settings(['a', 'b']), untouched());
  const set = ['a', 'b'];
  for (const [method, args] of [['status', []], ['init', []], ['index', [{}]], ['sourceChunks', ['t']], ['turnVectorStatus', ['t']],
    ['recordPresence', [['r']]], ['recordVectorStatus', [['r']]], ['show', [{ kind: 'record', id: 'r' }]], ['show', [{ kind: 'turn', id: 't' }]],
    ['show', [{ kind: 'turn_by_key', source: 's', conversation_id: 'c', turn_ids: ['x'] }]], ['status', [{ capabilities: true }]]]) {
    await assert.rejects(memory[method](set, ...args), { code: 'scope_denied' }, method);
    await assert.rejects(memory[method](['a'], ...args), { code: 'scope_denied' }, `${method} with one element`);
  }
  for (const method of ['ingest', 'enrich']) {
    await assert.rejects(memory[method](set, {}), error => error.code === 'scope_denied' && error.stage === 'before_write', method);
  }
});

test('a set read with an ungranted element or a selector is refused before any storage call', async () => {
  const memory = new Memory(settings(['a/**', 'b']), untouched());
  for (const scope of [['a/x', 'c'], ['a/x', 'a/**'], ['a/x', 'b', 'a/y', 'a/z', 'b/q']]) {
    for (const call of [() => memory.recall(scope, { query: 'q' }), () => memory.list(scope, {}),
      () => memory.show(scope, { kind: 'bundle', seed: { kind: 'record', id: 'r', scope: 'b' } })]) {
      await assert.rejects(call(), { code: scope.length > 4 ? 'invalid_input' : 'scope_denied' }, JSON.stringify(scope));
    }
  }
});

test('a set over one root is one tree selection filtered by exact terms; any other set serves list only', () => {
  const tree = selection({ scopes: ['acme/x', 'acme/y/z'] });
  assert.deepEqual([tree.tree, tree.named, tree.where('n'), tree.params, tree.owns('acme/x'), tree.owns('acme')],
    [true, true, 'n.scope IN $scopes', { scopes: ['acme/x', 'acme/y/z'] }, true, false]);
  assert.deepEqual(tree.names, selection('acme/x').names);
  assert.match(tree.lucene('"q"'), /^text:\("q"\) AND scope_terms:\(x[0-9a-f]{64} OR x[0-9a-f]{64}\)\^0$/u);
  for (const scopes of [['acme', 'acme/x'], ['acme/x', 'beta/y'], ['a b/c', 'acme/x']]) {
    const other = selection({ scopes });
    assert.deepEqual([other.tree, other.where('n'), other.names], [false, 'n.scope IN $scopes', undefined], JSON.stringify(scopes));
  }
});

test('fusion ranks each item within its own group and keys it by scope', () => {
  const fused = fuseGroups([
    { record_lexical: [{ kind: 'record', id: 'd', scope: 'a' }, { kind: 'record', id: 'e', scope: 'a' }] },
    { record_lexical: [{ kind: 'record', id: 'd', scope: 'b' }] },
  ]);
  assert.deepEqual(fused.map(hit => [hit.scope, hit.id, hit.channels[0].rank]), [['a', 'd', 1], ['b', 'd', 1], ['a', 'e', 2]]);
});

// Two flat scopes, each its own group; `fb` can be told to fail its record channel.
function twoScopeStore(log, { failing = null } = {}) {
  const records = { fa: [['a1', 'Lantern teal for the fictional harbor.']], fb: [['b1', 'Lantern amber.'], ['b2', 'Lantern fog.']] };
  const record = (scope, [id, text]) => ({ uid: `record_${scope}_${id}`, scope, id, kind: 'decision', text, status: 'proposed', attribution: 'fixture', evidence: [] });
  const call = (name, impl) => async (...args) => { log.push([name, ...args.filter(arg => typeof arg !== 'function')]); return impl(...args); };
  return {
    chunkLexicalStatus: call('chunkLexicalStatus', () => ({ status: 'ready' })),
    chunkLexical: call('chunkLexical', () => []),
    lexical: call('lexical', (scope, kind) => {
      if (kind === 'record' && scope === failing) throw new Error('driver detail');
      return kind === 'turn' ? [] : records[scope].map(([id, text]) => ({ kind, id, text }));
    }),
    getRecord: call('getRecord', (scope, id) => { const row = records[scope]?.find(([key]) => key === id); return row ? record(scope, row) : null; }),
    neighbors: call('neighbors', () => []),
    lexicalStatus: call('lexicalStatus', () => ({ status: 'ready' })),
    admittedLexical: call('admittedLexical', () => ({ hits: [], omitted: [], admitted_conversations: 0, exhausted: false })),
    vectorIndexStatus: call('vectorIndexStatus', () => 'online'),
    indexedVectors: call('indexedVectors', () => ({ nodes: [], partial: false, unindexed: 0, ran: true })),
  };
}

// A loopback model endpoint: embeds every text as [1, 0] (or fails), reranks by input order (or fails), and counts requests.
async function models(t, { failEmbed = false, failRerank = false } = {}) {
  const requests = { embed: 0, rerank: 0 };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const input = JSON.parse(body);
    if (req.url === '/embed') {
      requests.embed += 1;
      if (failEmbed) { res.writeHead(503).end(); return; }
      res.end(JSON.stringify({ model: input.model, data: input.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
    } else {
      requests.rerank += 1;
      if (failRerank) { res.writeHead(503).end(); return; }
      res.end(JSON.stringify({ results: input.documents.map((_, index) => ({ index, relevance_score: 1 - index / 100 })) }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { requests, embedding: { url: `${url}/embed`, model: 'fixture', dimensions: 2 }, reranker: { url: `${url}/rerank`, model: 'fixture' } };
}

test('recallSet and retrieve, called directly, authorize every element before any storage call', async () => {
  const memory = new Memory(settings(['fa']), untouched());
  await assert.rejects(memory.recallSet(['fa', 'secret'], { query: 'q' }, { seedsOnly: true }), { code: 'scope_denied' });
  await assert.rejects(memory.retrieve('secret', {}, async (_name, run) => run(), () => []), { code: 'scope_denied' });
  await assert.rejects(memory.retrieve({ scopes: ['fa', 'secret'] }, {}, async (_name, run) => run(), () => []), { code: 'scope_denied' });
  await assert.rejects(memory.retrieve({ scope: 'fa', subtree: true }, {}, async (_name, run) => run(), () => []), { code: 'scope_denied' });
});

test('a hole in a sparse set is an element like undefined: invalid_input before any storage call', async () => {
  const memory = new Memory(settings(['fa', 'fb']), untouched());
  for (const value of [['fa', , ], [, 'fa'], ['fa', undefined]]) {
    assert.throws(() => authorizeSelection(settings(['fa']), value), { code: 'invalid_input' });
    await assert.rejects(memory.list(value, {}), { code: 'invalid_input' });
    await assert.rejects(memory.recall(value, { query: 'q' }), { code: 'invalid_input' });
  }
});

test('a set embeds the query once for all its groups; an embedding or rerank failure degrades every element, not the call', async t => {
  const ok = await models(t);
  const memory = new Memory({ ...settings(['fa', 'fb']), embedding: ok.embedding }, twoScopeStore([]));
  const reply = await memory.recall(['fa', 'fb'], { query: 'lantern' });
  assert.equal(ok.requests.embed, 1);
  assert.deepEqual([reply.by_scope.fa.channels.record_vector.status, reply.by_scope.fb.channels.record_vector.status], ['ready', 'ready']);
  const down = await models(t, { failEmbed: true, failRerank: true });
  const failing = new Memory({ ...settings(['fa', 'fb']), embedding: down.embedding, reranker: down.reranker }, twoScopeStore([]));
  const degraded = await failing.recall(['fa', 'fb'], { query: 'lantern' });
  assert.equal(down.requests.embed, 1);
  for (const scope of ['fa', 'fb']) {
    assert.deepEqual(degraded.by_scope[scope].channels.chunk_vector, { status: 'unavailable', reason: 'model_request_failed' });
  }
  assert.deepEqual([degraded.status, degraded.channels.reranker, degraded.channels.record_vector, degraded.retrieval_complete],
    ['degraded', { status: 'unavailable', reason: 'model_request_failed' }, { status: 'unavailable' }, false]);
  assert.ok(degraded.bundles.length > 0, 'lexical hits still reach the caller');
});

test('ranking only and grouped together are refused for a set as for one scope', async () => {
  const memory = new Memory(settings(['fa', 'fb']), twoScopeStore([]));
  await assert.rejects(memory.recall(['fa', 'fb'], { query: 'lantern', group: 'conversation' }, { seedsOnly: true }), { code: 'invalid_input' });
});

test('a set recall runs each flat element as its own group and reports every element in by_scope', async () => {
  const log = [];
  const memory = new Memory(settings(['fa', 'fb']), twoScopeStore(log));
  const seeds = await memory.recall(['fb', 'fa'], { query: 'lantern' }, { seedsOnly: true });
  assert.deepEqual(seeds.scopes, ['fa', 'fb']);
  assert.equal(seeds.scope, undefined);
  assert.deepEqual(seeds.ranked.map(hit => [hit.scope, hit.id, hit.channels]), [
    ['fa', 'a1', [{ channel: 'record_lexical', rank: 1 }]], ['fb', 'b1', [{ channel: 'record_lexical', rank: 1 }]],
    ['fb', 'b2', [{ channel: 'record_lexical', rank: 2 }]]]);
  assert.deepEqual(log.filter(([name]) => name === 'lexical').map(([, scope, kind]) => `${scope}:${kind}`).sort(), ['fa:record', 'fa:turn', 'fb:record', 'fb:turn']);
  assert.deepEqual(seeds.channels, { chunk_lexical: { status: 'ready' }, chunk_vector: { status: 'unconfigured' }, record_lexical: { status: 'ready' },
    record_vector: { status: 'unconfigured' }, reranker: { status: 'unconfigured' }, turn_lexical: { status: 'ready' } });
  assert.deepEqual(Object.keys(seeds.by_scope), ['fa', 'fb']);
  assert.deepEqual(seeds.by_scope.fb, { group: 'fb', channels: { chunk_lexical: { status: 'ready', candidate_limit_reached: false },
    chunk_vector: { status: 'unconfigured', candidate_limit_reached: false }, record_lexical: { status: 'ready', candidate_limit_reached: false },
    record_vector: { status: 'unconfigured', candidate_limit_reached: false }, turn_lexical: { status: 'ready', candidate_limit_reached: false } } });
  const full = await memory.recall(['fa', 'fb'], { query: 'lantern' });
  assert.deepEqual(full.bundles.map(bundle => [bundle.scope, bundle.match.id, bundle.records[0].scope]), [['fa', 'a1', 'fa'], ['fb', 'b1', 'fb'], ['fb', 'b2', 'fb']]);
  assert.deepEqual([full.scopes, full.scope, full.scope_tree, Object.keys(full.by_scope)], [['fa', 'fb'], undefined, undefined, ['fa', 'fb']]);
  assert.equal(full.by_scope.fa.channels.record_lexical.candidate_limit_reached, undefined);
});

test('an element whose channel fails makes that channel worst for the set, naming only that element', async () => {
  const memory = new Memory(settings(['fa', 'fb']), twoScopeStore([], { failing: 'fb' }));
  const reply = await memory.recall(['fa', 'fb'], { query: 'lantern' });
  assert.deepEqual(reply.channels.record_lexical, { status: 'unavailable', scopes: ['fb'] });
  assert.deepEqual(reply.by_scope.fb.channels.record_lexical, { status: 'unavailable', reason: 'database_unavailable' });
  assert.deepEqual(reply.by_scope.fa.channels.record_lexical, { status: 'ready' });
  assert.deepEqual([reply.status, reply.retrieval_complete, reply.bundles.map(bundle => bundle.scope)], ['degraded', false, ['fa']]);
});

test('show bundle over a set needs the seed scope, an element of the set', async () => {
  const memory = new Memory(settings(['fa', 'fb']), twoScopeStore([]));
  const reply = await memory.show(['fa', 'fb'], { kind: 'bundle', seed: { kind: 'record', id: 'b1', scope: 'fb' } });
  assert.deepEqual([reply.bundle.scope, reply.bundle.records.map(row => row.scope)], ['fb', ['fb']]);
  await assert.rejects(memory.show(['fa', 'fb'], { kind: 'bundle', seed: { kind: 'record', id: 'b1' } }), { code: 'invalid_input' });
  await assert.rejects(memory.show(['fa', 'fb'], { kind: 'bundle', seed: { kind: 'record', id: 'b1', scope: 'fc' } }), { code: 'scope_denied' });
  await assert.rejects(memory.show(['fa', 'fb'], { kind: 'units', units: [{ key: { scope: 'fc', source: 's', conversation_id: 'c' }, seeds: [] }] }),
    { code: 'scope_denied' });
  const units = await memory.show(['fa', 'fb'], { kind: 'units', units: [{ key: { scope: 'fb', source: 's', conversation_id: 'c' }, seeds: [{ kind: 'record', id: 'b2' }] },
    { key: { scope: 'fa', source: 's', conversation_id: 'c' }, seeds: [{ kind: 'record', id: 'a1' }] }] });
  assert.deepEqual(units.units.map(unit => unit.seeds.map(bundle => [bundle.scope, bundle.match.id])), [[['fb', 'b2']], [['fa', 'a1']]]);
});

test('status reports the set bound among its capabilities', async () => {
  const store = { status: async () => ({ turns: 0 }), vectorIndexStatus: async () => 'missing',
    identity: async () => ({ system: 'neo4j', database_id: 'db-fixture', database: 'neo4j' }) };
  const reply = await new Memory(settings(['fa']), store).status('fa', { capabilities: true });
  assert.deepEqual(reply.capabilities, { scope_set_max: 4, record_digests: true });
});

async function cli(t, args, store) {
  const scratch = await mkdtemp(join(tmpdir(), 'source-memory-set-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await writeFile(join(scratch, 'config.json'), JSON.stringify(settings(['fa', 'fb'])));
  await writeFile(join(scratch, 'input.json'), JSON.stringify({ query: 'lantern' }));
  let stdout = '';
  try {
    await main([...args, '--config', join(scratch, 'config.json'), '--input', join(scratch, 'input.json')],
      { store, stdout: { write: line => { stdout += line; } }, stderr: { write() {} } });
  } catch (error) { return failureReply(args[0], error); }
  return JSON.parse(stdout);
}

test('the CLI reads a repeated --scope as a set; one --scope stays one exact scope', async t => {
  const store = { ...twoScopeStore([]), close: async () => {} };
  assert.deepEqual((await cli(t, ['recall', '--scope', 'fb', '--scope', 'fa'], store)).scopes, ['fa', 'fb']);
  assert.equal((await cli(t, ['recall', '--scope', 'fa'], store)).scope, 'fa');
  assert.deepEqual(await cli(t, ['status', '--scope', 'fa', '--scope', 'fb'], store), { ok: false, error: 'scope_denied' });
  assert.deepEqual(await cli(t, ['ingest', '--scope', 'fa', '--scope', 'fb'], store), { ok: false, error: 'scope_denied', stage: 'before_write' });
  assert.deepEqual(await cli(t, ['recall', '--scope', 'fa', '--config', 'x'], store), { ok: false, error: 'invalid_arguments' });
  assert.deepEqual(await cli(t, ['recall', '--scope', 'fa', '--scope', 'fa'], store), { ok: false, error: 'invalid_input' });
  assert.deepEqual(await cli(t, ['recall', ...['fa', 'fb', 'fc', 'fd', 'fe'].flatMap(scope => ['--scope', scope])], store), { ok: false, error: 'invalid_input' });
});
