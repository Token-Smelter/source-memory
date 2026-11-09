import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Memory } from '../src/memory.mjs';
import { canonical, digest, identity, indexNames, namespace, scopeTerm, scopeTerms, treeLayout } from '../src/core.mjs';
import { embeddingIdentity } from '../src/models.mjs';
import { exportScope } from '../pi-extension/export-scope.mjs';
import { goldenFixtures, goldenIdentities, readGoldenCorpus, writeGoldenCorpus } from './flat-golden.mjs';

const exec = promisify(execFile);

// The commit before nested scopes. Its Memory writes and reads the golden corpus first; this checkout must read it identically.
export const BASE_COMMIT = '589658daca0ba7797bef633cb1baf775b0269db4';
export const FLAT_GOLDEN_SHA256 = '6f976787826aaa6ff7c85eb2e4f288c38a903aaadcd5494451c417afd4390a71';

const FIVE = ['chunk_lexical', 'chunk_vector', 'record_lexical', 'record_vector', 'turn_lexical'];
const FIVE_READY = Object.fromEntries(FIVE.map(name => [name, 'ready']));
const retrievalStates = reply => Object.fromEntries(FIVE.map(name => [name, reply.channels[name].status]));
const turn = (conversation, id, text) => ({ source: 'nested-fixture', conversation_id: conversation, turn_id: id, lineage_root: true,
  entries: [{ id: `${id}-u`, role: 'user', text }] });

/** An export-scope snapshot with its scope's name, labels and identities replaced by fixed tokens and `created_at` dropped. */
function canonicalSnapshot(snapshot, scope) {
  // A record or relation hash covers its evidence turn ids, which name the scope; check it, then compare the body instead.
  for (const node of snapshot.nodes) if (node.labels.includes('SMRecord') || node.labels.includes('SMRelation')) {
    assert.equal(node.properties.hash, digest(JSON.parse(node.properties.body)));
    node.properties.hash = '<body digest>';
  }
  let bytes = JSON.stringify(snapshot);
  for (const [index, uid] of goldenIdentities(scope).entries()) bytes = bytes.replaceAll(uid, `id-${String(index).padStart(3, '0')}`);
  const value = JSON.parse(bytes.replaceAll(namespace(scope), 'SMN<scope>').replaceAll(JSON.stringify(scope), '"<scope>"'));
  value.nodes = value.nodes.map(({ properties: { created_at: _at, ...properties }, ...node }) => ({ ...node, properties, labels: [...node.labels].sort() }))
    .sort((a, b) => a.uid.localeCompare(b.uid));
  value.relationships.sort((a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to));
  // Neo4j returns property maps in no fixed key order.
  return canonical(value);
}

/** The base commit's src/, freshly extracted under the git-ignored .memory-local so it resolves this checkout's node_modules. */
async function baseMemoryClass() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  await mkdir(join(root, '.memory-local'), { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, '.memory-local', 'base-'));
  await exec('git', ['-C', root, 'archive', '--format=tar', '-o', join(dir, 'src.tar'), BASE_COMMIT, 'src'], { timeout: 30000 });
  await exec('tar', ['-xf', join(dir, 'src.tar'), '-C', dir], { timeout: 30000 });
  return (await import(pathToFileURL(join(dir, 'src', 'memory.mjs')).href)).Memory;
}

export async function runNestedScopes(database, scratch = null) {
  const results = [];
  const check = async (name, fn) => { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const input = JSON.parse(body);
    const vector = value => /quartz/i.test(value) ? [1, 0, 0, 0] : /cobalt/i.test(value) ? [0, 1, 0, 0] : [0, 0, 1, 0];
    res.end(JSON.stringify({ model: input.model, data: input.input.map((value, index) => ({ index, embedding: vector(value) })) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const embedding = { url: `http://127.0.0.1:${server.address().port}/embed`, model: 'nested-fixture', dimensions: 4 };
  const grants = ['acme/**', 'other/**', 'acme/odd name', 'team/**', 'vec/**', 'bf/**'];
  const config = { neo4j: database, scopes: { read: grants, write: grants }, embedding };
  const memory = new Memory(config);
  const narrow = new Memory({ ...config, scopes: { read: ['acme/proj-1/actor-a', 'acme/proj-1'], write: ['acme/proj-1/actor-a'] } }, memory.store);
  const waitOnline = async scope => {
    for (let attempt = 0; attempt < 2400; attempt += 1) {
      const status = await memory.status(scope);
      if (status.unindexed === 0 && Object.values(status.vector_indexes).every(state => state === 'online')
        && Object.values(status.scope_tree?.indexes ?? {}).every(state => state === 'online')) return status;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`indexes of ${scope} did not become online`);
  };
  const seed = async (scope, conversation, id, text, records = []) => {
    const { id: uid } = await memory.ingest(scope, turn(conversation, id, text));
    if (records.length) {
      await memory.enrich(scope, { records: records.map(([recordId, recordText]) => ({ id: recordId, kind: 'decision',
        text: recordText, attribution: 'fixture', status: 'accepted', evidence: [{ turn: uid, entry_id: `${id}-u`, start: 0, end: text.length }] })), relations: [] });
    }
    return uid;
  };
  const labelsOf = async uids => Object.fromEntries((await memory.store.transaction('read', tx => tx.run(`MATCH (n) WHERE n.uid IN $uids
    RETURN n.uid AS uid, labels(n) AS labels, n.scope_terms AS terms`, { uids }))).records.map(row => [row.get('uid'), row.toObject()]));
  try {
    await check(`flat reads of a corpus written by ${BASE_COMMIT} are byte-identical after opt-in, nested writes and a replay`, async () => {
      const fixtures = await goldenFixtures(database, ['golden', 'golden/**', 'snapshot-base', 'snapshot-r1']);
      const digests = {};
      try {
        const BaseMemory = await baseMemoryClass();
        const base = new BaseMemory(fixtures.config);
        try {
          await writeGoldenCorpus(base);
          digests.base = await readGoldenCorpus(base, fixtures.config);
          await writeGoldenCorpus(base, 'snapshot-base');
        } finally { await base.close(); }
        const upgraded = new Memory(fixtures.config);
        try {
          await writeGoldenCorpus(upgraded, 'snapshot-r1');
          if (scratch) {
            const snapshots = [];
            for (const scope of ['snapshot-base', 'snapshot-r1']) {
              const output = join(scratch, `${scope}.json`);
              await exportScope({ driver: upgraded.store.driver, scope, output, allowedDir: scratch });
              snapshots.push(canonicalSnapshot(JSON.parse(await readFile(output, 'utf8')), scope));
            }
            const at = [...snapshots[0]].findIndex((char, index) => char !== snapshots[1][index]);
            assert.ok(snapshots[0] === snapshots[1], `a flat scope written by r1 stores what the base commit stores; first difference: ${
              snapshots[0].slice(Math.max(0, at - 200), at + 80)} || ${snapshots[1].slice(Math.max(0, at - 200), at + 80)}`);
          }
          digests.upgraded = await readGoldenCorpus(upgraded, fixtures.config);
          const optIn = await upgraded.init('golden/**');
          assert.ok(optIn.scope_tree.labelled > 0, 'opt-in labels the corpus written before it');
          await upgraded.ingest('golden/team', { source: 'golden-fixture', conversation_id: 'north', turn_id: 'n1', lineage_root: true,
            entries: [{ id: 'n1-u', role: 'user', text: 'The keeper wants the lighthouse lantern painted teal before the ferry season.' }] });
          await upgraded.ingest('golden/team/ops', { source: 'golden-fixture', conversation_id: 'ops', turn_id: 'o1', lineage_root: true,
            entries: [{ id: 'o1-u', role: 'user', text: 'Harbor beacon lantern tide keeper ferry fog.' }] });
          digests.opted = await readGoldenCorpus(upgraded, fixtures.config);
          await writeGoldenCorpus(upgraded);
          digests.replayed = await readGoldenCorpus(upgraded, fixtures.config);
          const subtree = await upgraded.recall('golden/**', { query: 'lantern keeper ferry', limit: 32 });
          assert.ok(new Set(subtree.bundles.map(bundle => bundle.scope)).has('golden'), 'the opted-in root is in its own subtree');
          assert.deepEqual(subtree.scope_tree.pending, { turn: 0, chunk: 0, record: 0 });
        } finally { await upgraded.close(); }
      } finally { await fixtures.close(); }
      if (scratch && new Set(Object.values(digests).map(row => row.sha256)).size > 1) {
        for (const [name, row] of Object.entries(digests)) await writeFile(join(scratch, `flat-golden-${name}.json`), row.bytes, { mode: 0o600 });
      }
      assert.deepEqual(Object.fromEntries(Object.entries(digests).map(([name, row]) => [name, row.sha256])),
        { base: FLAT_GOLDEN_SHA256, upgraded: FLAT_GOLDEN_SHA256, opted: FLAT_GOLDEN_SHA256, replayed: FLAT_GOLDEN_SHA256 });
    });

    await check('nested init creates its root tree without waiting and reports nothing pending', async () => {
      const reply = await memory.init('acme/proj-1');
      assert.deepEqual([reply.initialized, reply.scope, reply.scope_tree.pending, reply.legacy_flat_index],
        [true, 'acme/proj-1', { turn: 0, chunk: 0, record: 0 }, undefined]);
      assert.deepEqual(Object.keys(reply.scope_tree.indexes).sort(), ['chunk', 'record', 'turn']);
      const second = await memory.init('acme/proj-1');
      assert.equal(second.scope_tree.labelled, 0);
    });

    const uids = {};
    await check('nested writes carry their root tree label and terms; a root not opted in and an opaque name keep their stored shape', async () => {
      await memory.init('acme');
      uids.root = await seed('acme', 'c-root', 't-root', 'Quartz plan for the whole acme project.', [['decision-1', 'Root quartz decision.']]);
      uids.a = await seed('acme/proj-1/actor-a', 'c-shared', 't1', 'Actor A prefers quartz tiles for the lobby.', [['decision-1', 'Use quartz tiles in the lobby.']]);
      uids.b = await seed('acme/proj-1/actor-b', 'c-shared', 't1', 'Actor B prefers cobalt tiles for the lobby.', [['decision-1', 'Use cobalt tiles in the lobby.']]);
      uids.p1 = await seed('acme/proj-1', 'c-p1', 't1', 'Project one schedules the quartz lobby work.');
      uids.p2 = await seed('acme/proj-2', 'c-p2', 't1', 'Project two also mentions quartz tiles.', [['decision-1', 'Project two quartz decision.']]);
      await memory.init('other/x');
      uids.other = await seed('other/x', 'c-o', 't1', 'Another tenant mentions quartz tiles.');
      await memory.init('acme/odd name');
      uids.odd = await seed('acme/odd name', 'c-odd', 't1', 'An opaque name under the prefix mentions quartz tiles.', [['decision-1', 'Opaque quartz decision.']]);
      assert.notEqual(uids.a, uids.b, 'identity hashes the full scope');
      const rows = await labelsOf(Object.values(uids));
      const tree = treeLayout('acme').labels;
      assert.deepEqual([rows[uids.a].labels.sort(), rows[uids.a].terms], [['SMTurn', tree.turn].sort(), scopeTerms('acme/proj-1/actor-a')]);
      assert.deepEqual([rows[uids.root].labels.sort(), rows[uids.root].terms], [['SMTurn', `${namespace('acme')}Turn`].sort(), null]);
      assert.deepEqual([rows[uids.odd].labels.sort(), rows[uids.odd].terms], [['SMTurn', `${namespace('acme/odd name')}Turn`].sort(), null]);
      assert.ok(rows[uids.other].labels.includes(treeLayout('other').labels.turn) && !rows[uids.other].labels.includes(tree.turn), 'roots are separate trees');
      await waitOnline('acme/proj-1');
    });

    await check('an exact nested read sees only its own scope through every channel', async () => {
      const reply = await narrow.recall('acme/proj-1/actor-a', { query: 'quartz tiles lobby' });
      assert.deepEqual(retrievalStates(reply), FIVE_READY, JSON.stringify(reply.channels));
      assert.ok(reply.bundles.length > 0);
      for (const bundle of reply.bundles) {
        assert.equal(bundle.scope, undefined);
        for (const row of bundle.records) assert.equal(row.scope, 'acme/proj-1/actor-a');
        if (bundle.source) assert.equal(bundle.source.id, uids.a);
      }
      assert.deepEqual(reply.scope_tree, { pending: { turn: 0, chunk: 0, record: 0 } });
    });

    await check('a subtree read covers its root and descendants through all five channels, keeping same-id records apart', async () => {
      const reply = await memory.recall('acme/proj-1/**', { query: 'quartz cobalt tiles lobby', limit: 32 });
      assert.equal(reply.scope, 'acme/proj-1/**');
      assert.deepEqual(retrievalStates(reply), FIVE_READY, JSON.stringify(reply.channels));
      assert.deepEqual([...new Set(reply.bundles.map(bundle => bundle.scope))].sort(), ['acme/proj-1', 'acme/proj-1/actor-a', 'acme/proj-1/actor-b']);
      const decisions = reply.bundles.filter(bundle => bundle.match.kind === 'record' && bundle.match.id === 'decision-1');
      assert.deepEqual(decisions.map(bundle => bundle.scope).sort(), ['acme/proj-1/actor-a', 'acme/proj-1/actor-b']);
      for (const bundle of reply.bundles) for (const row of bundle.records) assert.equal(row.scope, bundle.scope);
      const seeds = await memory.recall('acme/proj-1/**', { query: 'quartz cobalt' }, { seedsOnly: true });
      assert.ok(seeds.ranked.every(item => item.scope.startsWith('acme/proj-1')));
      assert.deepEqual(seeds.scope_tree, { pending: { turn: 0, chunk: 0, record: 0 } });
      const excluded = await memory.recall('acme/proj-1/**', { query: 'quartz cobalt tiles lobby', limit: 32,
        exclude_conversations: [{ source: 'nested-fixture', conversation_id: 'c-shared' }] });
      assert.deepEqual([...new Set(excluded.bundles.map(bundle => bundle.scope))], ['acme/proj-1'], 'an exclusion applies in every scope of the subtree');
    });

    await check('a root that has not opted in is reported pending in its subtree until init on the root labels it', async () => {
      const before = await memory.recall('acme/**', { query: 'quartz plan' });
      assert.deepEqual([before.retrieval_complete, before.channels.turn_lexical.status, before.channels.turn_lexical.reason,
        before.scope_tree.pending], [false, 'partial', 'scope_tree_pending', { turn: 1, chunk: 1, record: 1 }]);
      assert.ok(!before.bundles.some(bundle => bundle.scope === 'acme'));
      await assert.rejects(narrow.init('acme/**'), { code: 'scope_denied' });
      const init = await memory.init('acme/**');
      assert.deepEqual([init.scope, init.scope_tree.labelled, init.scope_tree.pending], ['acme/**', 3, { turn: 0, chunk: 0, record: 0 }]);
      uids.root2 = await seed('acme', 'c-root', 't-root-2', 'A later quartz note on the root.');
      assert.ok((await labelsOf([uids.root2]))[uids.root2].labels.includes(treeLayout('acme').labels.turn), 'an opted-in root labels its writes');
      await waitOnline('acme/**');
      const after = await memory.recall('acme/**', { query: 'quartz plan', limit: 32 });
      assert.deepEqual(retrievalStates(after), FIVE_READY, JSON.stringify(after.channels));
      assert.ok(after.bundles.some(bundle => bundle.scope === 'acme'));
    });

    await check('grouped subtree units key on each seed\'s own scope and follow inside it', async () => {
      const reply = await memory.recall('acme/**', { query: 'quartz tiles', group: 'conversation', mode: 'evidence_advice', follow: {}, limit: 12 });
      const keys = reply.units.map(unit => unit.key.scope);
      assert.ok(keys.includes('acme') && keys.includes('acme/proj-2') && keys.includes('acme/proj-1/actor-a'), JSON.stringify(keys));
      assert.ok(!keys.includes('acme/odd name') && !keys.includes('other/x'));
      for (const unit of reply.units) for (const bundle of unit.seeds) assert.equal(bundle.scope, unit.key.scope);
      assert.equal(reply.units.filter(unit => unit.key.conversation_id === 'c-shared').length, 2, 'one conversation key in two scopes is two units');
    });

    await check('an opaque name under the prefix and every other root stay out of the subtree in recall and status', async () => {
      const reply = await memory.recall('acme/**', { query: 'quartz', limit: 32 });
      const scopes = new Set(reply.bundles.map(bundle => bundle.scope));
      assert.ok(!scopes.has('acme/odd name') && !scopes.has('other/x'));
      const status = await memory.status('acme/**');
      assert.deepEqual([status.turns, status.records], [6, 4]);
      assert.deepEqual(status.scope_tree.pending, { turn: 0, chunk: 0, record: 0 });
    });

    await check('the root vector index filters a subtree after its top-k and the census decides completeness', async () => {
      const key = embeddingIdentity(embedding);
      const result = await memory.store.indexedVectors({ scope: 'acme/proj-1', subtree: true }, 'record', key, [1, 0, 0, 0], 4);
      assert.equal(result.partial, false);
      assert.ok(result.nodes.length >= 1 && result.nodes.every(node => node.scope.startsWith('acme/proj-1/')));
    });

    await check('above the scan limit a selection is read through its root ANN index with the census passed in', async () => {
      const calls = [];
      const original = memory.store.indexedVectors;
      memory.store.indexedVectors = function (...args) { calls.push(args); return original.apply(this, args); };
      memory.treeScanLimit = 1;
      try {
        const reply = await memory.recall('acme/proj-1/**', { query: 'quartz tiles', limit: 32 });
        assert.deepEqual([reply.channels.chunk_vector.status, reply.channels.record_vector.status], ['ready', 'ready']);
        assert.ok(reply.bundles.some(bundle => bundle.match.channels.some(trace => trace.channel === 'record_vector')));
        assert.equal(calls.length, 2);
        assert.ok(calls.every(args => args[8] && Number.isInteger(args[8].total)), 'the census is not run twice');
      } finally { memory.treeScanLimit = 4096; memory.store.indexedVectors = original; }
    });

    await check('a root whose tree vector indexes are missing still scans its vectors and finds them', async () => {
      const bare = new Memory({ ...config, embedding: undefined }, memory.store);
      await bare.init('vec/a');
      const uid = (await bare.ingest('vec/a', turn('c-vec', 'v1', 'A quartz lantern note.'))).id;
      await bare.ingest('vec/a/b', turn('c-vec2', 'v2', 'A cobalt lantern note.'));
      assert.equal((await memory.index('vec/a')).status, 'ready');
      assert.equal((await memory.index('vec/a/b')).status, 'ready');
      for (const scope of ['vec/a', 'vec/a/**']) {
        const reply = await memory.recall(scope, { query: 'quartz' });
        assert.equal(reply.channels.chunk_vector.status, 'ready', scope);
        assert.ok(reply.bundles.some(bundle => bundle.source?.id === uid
          && bundle.match.channels.some(trace => trace.channel === 'chunk_vector')), `${scope} finds the vector hit`);
      }
      assert.equal((await memory.status('vec/a')).vector_indexes.chunk, 'missing');
    });

    await check('init labels a selection in bounded batches and reports what is left until a rerun finishes', async () => {
      await memory.init('bf');
      await seed('bf', 'c-bf', 'b1', 'First batch fixture.', [['bf-1', 'One.'], ['bf-2', 'Two.']]);
      await seed('bf', 'c-bf', 'b2', 'Second batch fixture.');
      memory.store.backfill = { batch: 1, batches: 1 };
      try {
        const first = await memory.init('bf/**');
        assert.deepEqual([first.scope_tree.labelled, first.scope_tree.pending], [3, { turn: 1, chunk: 1, record: 1 }]);
        const second = await memory.init('bf/**');
        assert.deepEqual([second.scope_tree.labelled, second.scope_tree.pending], [3, { turn: 0, chunk: 0, record: 0 }]);
      } finally { memory.store.backfill = { batch: 1000, batches: 50 }; }
    });

    await check('grants: an exact grant never reads a subtree or a sibling, and a selector is never written or shown', async () => {
      await assert.rejects(narrow.recall('acme/proj-1/**', { query: 'quartz' }), { code: 'scope_denied' });
      await assert.rejects(narrow.recall('acme/proj-1/actor-b', { query: 'quartz' }), { code: 'scope_denied' });
      await assert.rejects(memory.ingest('acme/**', turn('c', 'x', 'text')), error => error.code === 'scope_denied' && error.stage === 'before_write');
      await assert.rejects(memory.show('acme/**', { kind: 'record', id: 'decision-1' }), { code: 'scope_denied' });
      await assert.rejects(memory.sourceChunks('acme/**', uids.a), { code: 'scope_denied' });
    });

    await check('a nested node written without its tree label is pending until init labels it', async () => {
      const uid = identity('turn', 'acme/proj-2', 'nested-fixture', 'c-legacy', 't1');
      const body = { source: 'nested-fixture', conversation_id: 'c-legacy', turn_id: 't1', parent_turn_id: null, occurred_at: null,
        entries: [{ id: 'u', role: 'user', text: 'Legacy quartz turn.', occurred_at: null }] };
      await memory.store.transaction('write', tx => tx.run(`CREATE (t:SMTurn {uid:$uid, scope:'acme/proj-2', hash:'h', body:$body,
        text:'[user] Legacy quartz turn.', lineage:true, source:'nested-fixture', conversation_id:'c-legacy', turn_key:'t1', chunked:true})`,
      { uid, body: JSON.stringify(body) }));
      const before = await memory.recall('acme/proj-2', { query: 'legacy quartz' });
      assert.deepEqual([before.channels.turn_lexical.status, before.channels.turn_lexical.scope_tree_pending, before.scope_tree.pending.turn], ['partial', 1, 1]);
      const init = await memory.init('acme/proj-2');
      assert.deepEqual([init.scope_tree.labelled, init.scope_tree.pending.turn], [1, 0]);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const after = await memory.recall('acme/proj-2', { query: 'legacy quartz' });
        if (after.bundles.some(bundle => bundle.source?.id === uid)) { assert.equal(after.channels.turn_lexical.status, 'ready'); return; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail('the labelled turn never became visible');
    });

    await check('a nested name with a pre-r1 per-scope index is flagged by init and status', async () => {
      const names = indexNames('team/alpha');
      await memory.store.transaction('write', tx => tx.run(`CREATE FULLTEXT INDEX ${names.turns} IF NOT EXISTS FOR (n:${namespace('team/alpha')}Turn) ON EACH [n.text]`));
      assert.equal((await memory.init('team/alpha')).legacy_flat_index, true);
      assert.equal((await memory.status('team/alpha')).legacy_flat_index, true);
      assert.equal((await memory.status('team/beta')).legacy_flat_index, undefined);
    });

    await check('the root full-text index holds only its tree and its scope filter does not change scores', async () => {
      const index = treeLayout('acme').indexes.turns;
      const rows = await memory.store.transaction('read', tx => tx.run(`CALL db.index.fulltext.queryNodes($index, $plain) YIELD node, score
        WITH collect({uid:node.uid, scope:node.scope, score:score}) AS plain
        CALL db.index.fulltext.queryNodes($index, $filtered) YIELD node, score
        RETURN plain, collect({uid:node.uid, score:score}) AS filtered`, { index, plain: 'text:("quartz")',
        filtered: `text:("quartz") AND scope_terms:${scopeTerm('acme/proj-1', false)}^0` }));
      const { plain, filtered } = rows.records[0].toObject();
      assert.ok(plain.every(hit => hit.scope === 'acme' || hit.scope.startsWith('acme/')));
      assert.ok(filtered.length > 0 && filtered.length < plain.length);
      for (const hit of filtered) assert.equal(hit.score, plain.find(row => row.uid === hit.uid).score);
    });
  } finally {
    await memory.close();
    server.close();
  }
  return results;
}
