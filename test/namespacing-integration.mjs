import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Memory } from '../src/memory.mjs';
import { digest, identity, normalizeEnrichment } from '../src/core.mjs';
import { main } from '../bin/memory.mjs';
import { canonicalRun, goldenFixtures, writeGoldenCorpus } from './flat-golden.mjs';
import { baseMemoryClass } from './nested-scopes.mjs';

// The commit before namespacing (nested scopes and list built). Its Memory writes and reads the nested corpus first.
export const NESTED_BASE_COMMIT = 'f5b49e322fd741d6596cbac43d7e70f64f98fe58';
export const NESTED_GOLDEN_SCOPES = ['ngolden/team', 'ngolden/team/ops'];
const SUBTREE = 'ngolden/**';
const SOUTH = [{ source: 'golden-fixture', conversation_id: 'south' }];
const SET_GRANTS = ['fan/**', 'fan2/**', 'fa', 'fb', 'fc', 'fd', 'ova/**', 'ovb/**', 'rep/**', 'repf', 'fan/odd name'];

async function waitReady(memory, scope) {
  for (let attempt = 0; attempt < 2400; attempt += 1) {
    const status = await memory.status(scope);
    if (status.unindexed === 0 && Object.values(status.vector_indexes).every(state => state === 'online')
      && Object.values(status.scope_tree?.indexes ?? {}).every(state => state === 'online')
      && Object.values(status.scope_tree?.pending ?? {}).every(count => count === 0)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${scope} never became ready; refusing to pin a partial read`);
}

async function walk(memory, scope, input) {
  const pages = [];
  let cursor;
  do {
    const page = await memory.list(scope, { ...input, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    cursor = page.next_cursor;
  } while (cursor);
  return pages;
}

/**
 * The reads a host makes of one exact nested scope or one subtree, using only the API of NESTED_BASE_COMMIT. `wrap` maps the
 * scope argument, so the same reads can be repeated through another request form that must give the same bytes.
 */
export async function nestedReads(memory, selection, { exact, wrap = scope => scope, extra = {} } = {}) {
  const scope = wrap(selection);
  const replies = [];
  const recall = (input, options) => memory.recall(scope, { ...input, ...extra }, ...(options ? [options] : []));
  replies.push(await recall({ query: 'lantern colour teal' }));
  replies.push(await recall({ query: 'harbor beacon tide', limit: 4, candidates: 8 }));
  replies.push(await recall({ query: 'ferry fog keeper', mode: 'evidence_advice', group: 'conversation', follow: {} }));
  replies.push(await recall({ query: 'lighthouse lantern', mode: 'history_search', group: 'conversation', per_conversation: 1,
    exclude_conversations: SOUTH }));
  replies.push(await recall({ query: 'lantern teal amber' }, { seedsOnly: true }));
  for (const input of [{ limit: 4 }, { relations: true, limit: 3 }, { kind: 'decision', relations: true }, { kind: 'turn', limit: 5 }]) {
    replies.push(await walk(memory, scope, { ...input, ...extra }));
  }
  if (exact) {
    const show = input => memory.show(scope, { ...input, ...extra });
    const keys = await memory.show(selection, { kind: 'turn_by_key', source: 'golden-fixture', conversation_id: 'north', turn_ids: ['n1', 'n2'] });
    const [n1, n2] = ['n1', 'n2'].map(id => keys.found.find(row => row.turn_id === id).id);
    // A record is shown by its exact scope only; a set may not name one.
    replies.push(await memory.show(selection, { kind: 'record', id: 'teal', ...extra }));
    replies.push(await show({ kind: 'bundle', seed: { kind: 'record', id: 'teal' } }));
    replies.push(await show({ kind: 'bundle', seed: { kind: 'turn', id: n2 }, max_nodes: 2 }));
    replies.push(await show({ kind: 'units', follow: {}, units: [{ key: { scope: selection, source: 'golden-fixture', conversation_id: 'north' },
      seeds: [{ kind: 'turn', id: n2 }, { kind: 'record', id: 'delay' }, { kind: 'record', id: 'missing' }] }] }));
    replies.push(await show({ kind: 'following', turn: n1, limit: 4 }));
  }
  return replies;
}

const pinned = replies => {
  const bytes = JSON.stringify(canonicalRun(replies));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
};

// A record object in a reply: a decoded record (uid and evidence), a list item or stub, or a ranked record seed.
function recordObjects(value, found = []) {
  if (Array.isArray(value)) value.forEach(item => recordObjects(item, found));
  else if (value && typeof value === 'object') {
    if ((value.uid?.startsWith('record_') && value.evidence) || value.record_kind
      || (value.kind === 'record' && (value.content_omitted || (value.channels && value.text !== undefined)))) found.push(value);
    Object.values(value).forEach(item => recordObjects(item, found));
  }
  return found;
}

const withoutDigests = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'record_digest' || key === 'store_identity' ? undefined : item));

export async function runNamespacing(database, scratch = null) {
  const results = [];
  const check = async (name, fn) => { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); };
  const fixtures = await goldenFixtures(database, ['ngolden/**', 'dg', 'dg/**', ...SET_GRANTS]);
  const memory = new Memory(fixtures.config);
  const BaseMemory = await baseMemoryClass(NESTED_BASE_COMMIT);
  const base = new BaseMemory(fixtures.config);
  try {
    await check(`exact nested and subtree reads of a corpus written by ${NESTED_BASE_COMMIT.slice(0, 7)} are byte-identical, cursors included`, async () => {
      for (const scope of NESTED_GOLDEN_SCOPES) await writeGoldenCorpus(base, scope);
      for (const scope of NESTED_GOLDEN_SCOPES) await waitReady(base, scope);
      const reads = async reader => {
        const out = {};
        for (const scope of NESTED_GOLDEN_SCOPES) out[scope] = pinned(await nestedReads(reader, scope, { exact: true }));
        out[SUBTREE] = pinned(await nestedReads(reader, SUBTREE, { exact: false }));
        return out;
      };
      const before = await reads(base);
      const after = await reads(memory);
      const digestsFalse = {};
      for (const scope of NESTED_GOLDEN_SCOPES) digestsFalse[scope] = pinned(await nestedReads(memory, scope, { exact: true, extra: { digests: false } }));
      const oneElement = {};
      for (const scope of NESTED_GOLDEN_SCOPES) oneElement[scope] = pinned(await nestedReads(memory, scope, { exact: true, wrap: name => [name] }));
      for (const [scope, row] of Object.entries(before)) {
        if (scratch && row.sha256 !== after[scope].sha256) {
          await writeFile(join(scratch, `nested-golden-${scope.replaceAll('/', '_')}-base.json`), row.bytes, { mode: 0o600 });
          await writeFile(join(scratch, `nested-golden-${scope.replaceAll('/', '_')}-new.json`), after[scope].bytes, { mode: 0o600 });
        }
        assert.equal(after[scope].sha256, row.sha256, scope);
        if (digestsFalse[scope]) assert.equal(digestsFalse[scope].sha256, row.sha256, `${scope} with digests:false`);
        if (oneElement[scope]) assert.equal(oneElement[scope].sha256, row.sha256, `${scope} as a one-element set`);
      }
      const statusBefore = await base.status(SUBTREE);
      assert.equal(JSON.stringify(await memory.status(SUBTREE)), JSON.stringify(statusBefore), 'status is unchanged');
    });

    const input = () => ({ records: [
      { id: 'teal', kind: 'decision', status: 'accepted', text: 'Paint the lantern teal.', attribution: 'keeper', evidence: [] },
      { id: 'amber', kind: 'decision', text: 'Paint the lantern amber after the fog trial.', attribution: 'keeper', evidence: [] },
    ], relations: [{ id: 'amber-over-teal', type: 'supersedes', from: 'amber', to: 'teal', attribution: 'keeper', evidence: [] }] });
    const expected = {};
    await check('with digests every record carries the stored hash, equal to the digest of the normalized submission', async () => {
      for (const scope of ['dg', 'dg/a']) {
        await memory.init(scope);
        const text = 'The keeper wants the lighthouse lantern teal, then amber after the fog trial.';
        const { id } = await memory.ingest(scope, { source: 'dg-fixture', conversation_id: 'north', turn_id: 'n1', lineage_root: true,
          entries: [{ id: 'u', role: 'user', text }] });
        const enrichment = input();
        for (const row of [...enrichment.records, ...enrichment.relations]) row.evidence = [{ turn: id, entry_id: 'u', start: 0, end: text.length }];
        await memory.enrich(scope, enrichment);
        expected[scope] = Object.fromEntries(normalizeEnrichment(enrichment).records.map(record => [record.id, digest(record)]));
        await waitReady(memory, scope);
      }
      const stored = Object.fromEntries((await memory.store.transaction('read', tx => tx.run(`MATCH (r:SMRecord) WHERE r.scope IN ['dg', 'dg/a']
        RETURN r.scope AS scope, r.record_id AS id, r.hash AS hash`))).records.map(row => [`${row.get('scope')}:${row.get('id')}`, row.get('hash')]));
      const status = await memory.status('dg');
      const replies = [];
      for (const scope of ['dg', 'dg/a', 'dg/**']) {
        replies.push([scope, await memory.recall(scope, { query: 'lantern teal amber', digests: true })]);
        replies.push([scope, await memory.recall(scope, { query: 'lantern amber', group: 'conversation', mode: 'evidence_advice', follow: {}, digests: true })]);
        replies.push([scope, await memory.recall(scope, { query: 'lantern teal amber', digests: true }, { seedsOnly: true })]);
        replies.push([scope, await memory.list(scope, { relations: true, digests: true })]);
        replies.push([scope, await memory.list(scope, { max_bytes: 4096, digests: true })]);
      }
      for (const scope of ['dg', 'dg/a']) {
        replies.push([scope, await memory.show(scope, { kind: 'record', id: 'teal', digests: true })]);
        replies.push([scope, await memory.show(scope, { kind: 'bundle', seed: { kind: 'record', id: 'teal' }, digests: true })]);
        replies.push([scope, await memory.show(scope, { kind: 'units', digests: true, units: [{ key: { scope, source: 'dg-fixture', conversation_id: 'north' },
          seeds: [{ kind: 'record', id: 'amber' }] }] })]);
      }
      let checked = 0;
      const seedChannels = new Set();
      for (const [scope, reply] of replies) {
        assert.deepEqual(reply.store_identity, status.store, scope);
        for (const row of recordObjects(reply)) {
          const owner = row.scope ?? scope;
          assert.equal(row.record_digest, stored[`${owner}:${row.id}`], `${owner}:${row.id}`);
          assert.equal(row.record_digest, expected[owner][row.id], `${owner}:${row.id} matches the submission`);
          checked += 1;
          if (row.channels && !row.supporting_evidence) for (const trace of row.channels) seedChannels.add(`${owner}:${trace.channel}`);
        }
      }
      assert.ok(checked > 40, `${checked} record objects checked`);
      for (const channel of ['dg:record_lexical', 'dg:record_vector', 'dg/a:record_lexical', 'dg/a:record_vector']) {
        assert.ok(seedChannels.has(channel), `a record seed found by ${channel} carries its digest`);
      }
      const plain = await memory.recall('dg/a', { query: 'lantern teal amber' });
      assert.deepEqual(withoutDigests(await memory.recall('dg/a', { query: 'lantern teal amber', digests: true })), JSON.parse(JSON.stringify(plain)));
    });

    await check('a record node without a string hash reports record_digest null; the base build refuses digests on list', async () => {
      const uid = identity('record', 'dg', 'raw');
      await memory.store.transaction('write', tx => tx.run(`CREATE (r:SMRecord {uid:$uid, scope:'dg', record_id:'raw', hash:42, body:$body,
        text:'Raw fictional note.', created_at:datetime()})`, { uid, body: JSON.stringify({ id: 'raw', kind: 'observation', text: 'Raw fictional note.',
        status: 'observed', attribution: 'other writer', evidence: [] }) }));
      assert.equal((await memory.show('dg', { kind: 'record', id: 'raw', digests: true })).record.record_digest, null);
      const page = await memory.list('dg', { kind: 'observation', digests: true });
      assert.deepEqual(page.items.map(item => [item.id, item.record_digest]), [['raw', null]]);
      await assert.rejects(base.list('dg', { digests: true }), { code: 'invalid_input' });
      assert.equal((await base.recall('dg', { query: 'lantern', digests: true })).store_identity, undefined, 'an older build ignores it on recall');
    });

    await check('status reports capabilities only when asked, and the CLI carries digests and capabilities', async () => {
      const plain = await memory.status('dg');
      assert.equal(JSON.stringify(plain), JSON.stringify(await base.status('dg')));
      assert.deepEqual((await memory.status('dg', { capabilities: true })).capabilities, { scope_set_max: 4, record_digests: true, cross_scope_relations: true, link_uid_lock: true });
      assert.equal((await base.status('dg', { capabilities: true })).capabilities, undefined, 'absent means unsupported');
      const dir = await mkdtemp(join(scratch ?? tmpdir(), 'namespacing-cli-'));
      await writeFile(join(dir, 'config.json'), JSON.stringify(fixtures.config));
      const cli = async (command, body) => {
        await writeFile(join(dir, 'input.json'), JSON.stringify(body));
        let out = '';
        await main([command, '--config', join(dir, 'config.json'), '--scope', 'dg', '--input', join(dir, 'input.json')],
          { stdout: { write: line => { out += line; } }, stderr: { write() {} } });
        return JSON.parse(out);
      };
      assert.deepEqual((await cli('status', { capabilities: true })).capabilities, { scope_set_max: 4, record_digests: true, cross_scope_relations: true, link_uid_lock: true });
      const listed = await cli('list', { kind: 'decision', digests: true });
      assert.deepEqual(listed.items.map(item => item.record_digest).sort(), Object.values(expected.dg).sort());
      assert.deepEqual(listed.store_identity, plain.store);
    });
    const seedScope = async (scope, conversation, body, records = []) => {
      await memory.init(scope);
      const { id } = await memory.ingest(scope, { source: 'set-fixture', conversation_id: conversation, turn_id: `${conversation}-1`, lineage_root: true,
        entries: [{ id: 'u', role: 'user', text: body }] });
      const evidence = [{ turn: id, entry_id: 'u', start: 0, end: body.length }];
      if (records.length) await memory.enrich(scope, { records: records.map(([recordId, text]) => ({ id: recordId, kind: 'decision', text,
        attribution: 'fixture', evidence })), relations: [] });
      return id;
    };
    const counting = () => {
      const counts = {};
      const store = new Proxy(memory.store, { get(target, name) {
        const value = target[name];
        if (typeof value !== 'function') return value;
        return (...args) => { counts[name] = (counts[name] ?? 0) + 1; return value.apply(target, args); };
      } });
      return { counts, memory: new Memory(fixtures.config, store) };
    };
    const NESTED = ['fan/a', 'fan/b', 'fan/c', 'fan/d'];
    const FLAT = ['fa', 'fb', 'fc', 'fd'];

    await check('a set read makes one query per index group per channel: 4 nested under one root use 1, 2 roots 2, 4 flat scopes 4', async () => {
      for (const scope of [...NESTED, 'fan2/a', ...FLAT]) {
        await seedScope(scope, `c-${scope.replace('/', '-')}`, `The harbor lantern note of ${scope}.`, [['d1', `Lantern decision of ${scope}.`]]);
        await waitReady(memory, scope);
      }
      const runs = [[NESTED, 1], [['fan/a', 'fan/b', 'fan2/a'], 2], [FLAT, 4]];
      for (const [scopes, groups] of runs) {
        for (const input of [{ query: 'harbor lantern' }, { query: 'harbor lantern', group: 'conversation', mode: 'evidence_advice' }]) {
          const { counts, memory: counted } = counting();
          const reply = await counted.recall(scopes, input);
          assert.deepEqual(Object.keys(reply.by_scope), [...scopes].sort());
          assert.equal(reply.retrieval_complete, true, JSON.stringify(reply.channels));
          const lexical = (counts.lexical ?? 0) + (counts.admittedLexical ?? 0);
          const vector = ['treeVectorScan', 'indexedVectors', 'vectors'].reduce((sum, name) => sum + (counts[name] ?? 0), 0);
          assert.equal(lexical, 3 * groups - (input.group ? 0 : groups), `${scopes}: lexical queries ${JSON.stringify(counts)}`);
          assert.equal(counts.chunkLexical ?? 0, input.group ? 0 : groups);
          assert.equal(vector, 2 * groups, `${scopes}: vector queries ${JSON.stringify(counts)}`);
          // Status, census and pending reads: each group makes those of an exact read of one of its elements, once.
          const exact = {};
          for (const first of [...new Set(scopes.map(scope => scope.startsWith('fan/') ? 'fan/a' : scope))]) {
            const single = counting();
            await single.memory.recall(first, input);
            for (const [name, count] of Object.entries(single.counts)) exact[name] = (exact[name] ?? 0) + count;
          }
          for (const name of ['lexicalStatus', 'chunkLexicalStatus', 'vectorIndexStatus', 'vectorCounts']) {
            assert.equal(counts[name] ?? 0, exact[name] ?? 0, `${scopes}: ${name}`);
          }
          assert.equal((counts.treePending ?? 0) + (counts.treePendingByScope ?? 0), exact.treePending ?? 0, `${scopes}: pending reads`);
          assert.ok(new Set(reply.bundles.map(bundle => bundle.scope)).size >= Math.min(scopes.length, 2), 'hits come from several elements');
          for (const bundle of reply.bundles) assert.ok(scopes.includes(bundle.scope));
        }
      }
    });

    await check('a set over one root filters its tree with a grouped zero-boost clause that leaves every score unchanged', async () => {
      const { indexes } = (await import('../src/core.mjs')).treeLayout('fan');
      const { scopeTerm } = await import('../src/core.mjs');
      const rows = await memory.store.transaction('read', tx => tx.run(`CALL db.index.fulltext.queryNodes($index, $a) YIELD node, score
        WITH collect({uid:node.uid, score:score}) AS a
        CALL db.index.fulltext.queryNodes($index, $b) YIELD node, score
        WITH a, collect({uid:node.uid, score:score}) AS b
        CALL db.index.fulltext.queryNodes($index, $set) YIELD node, score
        RETURN a, b, collect({uid:node.uid, scope:node.scope, score:score}) AS set`, { index: indexes.turns,
        a: `text:("harbor") AND scope_terms:${scopeTerm('fan/a', true)}^0`, b: `text:("harbor") AND scope_terms:${scopeTerm('fan/b', true)}^0`,
        set: `text:("harbor") AND scope_terms:(${scopeTerm('fan/a', true)} OR ${scopeTerm('fan/b', true)})^0` }));
      const { a, b, set } = rows.records[0].toObject();
      assert.equal(set.length, a.length + b.length);
      assert.ok(a.length > 0 && b.length > 0);
      for (const hit of set) assert.equal(hit.score, [...a, ...b].find(row => row.uid === hit.uid).score, hit.scope);
    });

    await check('a one-element set reads exactly as its scope; a set names its scopes, every hit and an aggregate of its elements', async () => {
      for (const [one, input] of [['fa', { query: 'harbor lantern' }], ['fan/a', { query: 'harbor lantern', group: 'conversation', follow: {} }]]) {
        assert.equal(JSON.stringify(await memory.recall([one], input)), JSON.stringify(await memory.recall(one, input)), one);
      }
      const seeds = await memory.recall(['fan/b', 'fa', 'fan2/a'], { query: 'harbor lantern' }, { seedsOnly: true });
      assert.deepEqual([seeds.scopes, seeds.scope, seeds.scope_tree], [['fa', 'fan/b', 'fan2/a'], undefined, undefined]);
      assert.ok(seeds.ranked.length > 0 && seeds.ranked.every(item => seeds.scopes.includes(item.scope)));
      assert.deepEqual(Object.fromEntries(Object.entries(seeds.by_scope).map(([scope, row]) => [scope, [row.group, Boolean(row.scope_tree)]])),
        { fa: ['fa', false], 'fan/b': ['fan', true], 'fan2/a': ['fan2', true] });
      for (const [name, state] of Object.entries(seeds.channels)) {
        if (name === 'reranker') continue;
        assert.deepEqual(state, { status: 'ready' }, name);
        for (const row of Object.values(seeds.by_scope)) assert.equal(typeof row.channels[name].candidate_limit_reached, 'boolean');
      }
      const grouped = await memory.recall(['fan/b', 'fa'], { query: 'harbor lantern', group: 'conversation', mode: 'history_search', per_conversation: 1 });
      for (const unit of grouped.units) {
        assert.ok(['fa', 'fan/b'].includes(unit.key.scope));
        for (const bundle of unit.seeds) assert.equal(bundle.scope, unit.key.scope);
        for (const key of unit.also_cites) assert.equal(key.scope, unit.key.scope);
      }
      for (const scope of ['fa', 'fan/b']) {
        const state = grouped.by_scope[scope].channels.record_lexical;
        assert.deepEqual([typeof state.admitted_conversations, typeof state.exhausted], ['number', 'boolean'], scope);
      }
      assert.deepEqual(Object.keys(grouped.channels.record_lexical), ['status']);
    });

    await check('vectors per group: an exact scan at or below the scan limit, the root ANN above it, each group with its own query budget', async () => {
      const { embeddingIdentity } = await import('../src/models.mjs');
      const { treeLayout } = await import('../src/core.mjs');
      const key = embeddingIdentity(fixtures.config.embedding);
      for (const root of ['ova', 'ovb']) {
        await seedScope(`${root}/s`, `c-${root}`, 'A tide note.', [['d1', 'A tide decision.']]);
        await waitReady(memory, `${root}/s`);
        // Many nodes elsewhere in the same root, nearer the query than the selection, fill every ANN window.
        const labels = treeLayout(root).labels;
        for (const [base, label] of [['SMChunk', labels.chunk], ['SMRecord', labels.record]]) {
          await memory.store.transaction('write', tx => tx.run(`UNWIND range(1, 4200) AS i CREATE (n:${base}:${label} {uid: $prefix + toString(i),
            scope: $scope, text: 'harbor', embedding: [toFloat(i % 61) / 1000.0, 1.0, toFloat(i % 67) / 1000.0, 0.0], embedding_key: $key, record_id: 'x' + toString(i), turn_uid: 'none'})`,
          { prefix: `${root}-${base}-`, scope: `${root}/outside`, key }));
        }
        // Wait until the root's vector indexes return the new nodes, so the ANN window is really full of them.
        for (const index of [treeLayout(root).indexes.vectorChunks, treeLayout(root).indexes.vectorRecords]) {
          let seen = 0;
          for (let attempt = 0; attempt < 600 && seen < 4000; attempt += 1) {
            seen = (await memory.store.transaction('read', tx => tx.run(`CALL db.index.vector.queryNodes($index, 4096, [0.0, 1.0, 0.0, 0.0])
              YIELD node WHERE node.scope = $scope RETURN count(node) AS count`, { index, scope: `${root}/outside` }))).records[0].get('count');
            if (seen < 4000) await new Promise(resolve => setTimeout(resolve, 100));
          }
          assert.ok(seen >= 4000, `${index} returns the outside nodes (${seen})`);
        }
      }
      const exact = await memory.recall(['ova/s', 'ovb/s'], { query: 'harbor' }, { seedsOnly: true });
      for (const scope of ['ova/s', 'ovb/s']) {
        for (const name of ['chunk_vector', 'record_vector']) assert.equal(exact.by_scope[scope].channels[name].status, 'ready', `${scope} ${name} scanned`);
      }
      memory.treeScanLimit = 0;
      try {
        const reply = await memory.recall(['ova/s', 'ovb/s'], { query: 'harbor' }, { seedsOnly: true });
        for (const scope of ['ova/s', 'ovb/s']) {
          for (const name of ['chunk_vector', 'record_vector']) {
            const state = reply.by_scope[scope].channels[name];
            assert.deepEqual([state.status, state.reason], ['partial', 'vector_overfetch_cap'], `${scope} ${name}: ${JSON.stringify(state)}`);
          }
        }
        assert.deepEqual(reply.channels.chunk_vector, { status: 'partial' });
      } finally { memory.treeScanLimit = 4096; }
    });

    await check('each element reports its own scope_tree_pending while a sibling in its group stays ready', async () => {
      await seedScope('rep/a', 'c-rep-a', 'A beacon note for rep a.');
      await seedScope('rep/b', 'c-rep-b', 'A beacon note for rep b.');
      await seedScope('repf', 'c-repf', 'A beacon note for the flat scope.');
      for (const scope of ['rep/a', 'rep/b', 'repf']) await waitReady(memory, scope);
      const uid = identity('turn', 'rep/b', 'set-fixture', 'c-legacy', 't1');
      await memory.store.transaction('write', tx => tx.run(`CREATE (t:SMTurn {uid:$uid, scope:'rep/b', hash:'h', body:$body, text:'[user] Beacon legacy.',
        lineage:true, source:'set-fixture', conversation_id:'c-legacy', turn_key:'t1', chunked:true, created_at:datetime()})`,
      { uid, body: JSON.stringify({ source: 'set-fixture', conversation_id: 'c-legacy', turn_id: 't1', parent_turn_id: null, occurred_at: null,
        entries: [{ id: 'u', role: 'user', text: 'Beacon legacy.', occurred_at: null }] }) }));
      const reply = await memory.recall(['rep/b', 'repf', 'rep/a'], { query: 'beacon note' });
      assert.deepEqual(reply.by_scope['rep/b'].channels.turn_lexical, { status: 'partial', scope_tree_pending: 1, reason: 'scope_tree_pending' });
      assert.deepEqual(reply.by_scope['rep/b'].scope_tree, { pending: { turn: 1, chunk: 0, record: 0 } });
      assert.deepEqual(reply.by_scope['rep/a'].channels.turn_lexical, { status: 'ready' });
      assert.deepEqual(reply.by_scope['rep/a'].scope_tree, { pending: { turn: 0, chunk: 0, record: 0 } });
      assert.equal(reply.by_scope.repf.scope_tree, undefined);
      assert.deepEqual(reply.channels.turn_lexical, { status: 'partial', scopes: ['rep/b'] });
      assert.equal(reply.retrieval_complete, false);
      assert.equal(reply.scope_tree, undefined);
    });

    await check('a set read with an ungranted element, a selector or five scopes is refused before any storage call', async () => {
      const { counts, memory: counted } = counting();
      const narrow = new Memory({ ...fixtures.config, scopes: { read: ['fa', 'fb'], write: [] } }, counted.store);
      await assert.rejects(narrow.recall(['fa', 'fc'], { query: 'harbor' }), { code: 'scope_denied' });
      await assert.rejects(narrow.list(['fa', 'fc'], {}), { code: 'scope_denied' });
      await assert.rejects(counted.recall(['fa', 'fan/**'], { query: 'harbor' }), { code: 'scope_denied' });
      await assert.rejects(counted.recall([...FLAT, 'fan/a'], { query: 'harbor' }), { code: 'invalid_input' });
      assert.deepEqual(counts, {});
    });

    await check('sets with an opted-in root, an ancestor and its descendant, an opaque name, and digests group and report as specified', async () => {
      // An opted-in depth-1 root stays its own flat group beside its nested scopes, and ranks as its exact read ranks.
      await memory.init('fan/**');
      await seedScope('fan', 'c-fan', 'The harbor lantern note of the fan root.', [['d1', 'Lantern decision of the fan root.']]);
      await seedScope('fan/a/b', 'c-fan-a-b', 'The harbor lantern note of fan a b.', [['d1', 'Lantern decision of fan a b.']]);
      await memory.init('fan/odd name');
      await seedScope('fan/odd name', 'c-odd', 'The harbor lantern note of an opaque name.', [['d1', 'Lantern decision of the opaque name.']]);
      for (const scope of ['fan', 'fan/a/b', 'fan/odd name']) await waitReady(memory, scope);
      const query = { query: 'harbor lantern note' };
      const rootSet = counting();
      const mixed = await rootSet.memory.recall(['fan/a', 'fan'], query, { seedsOnly: true });
      assert.deepEqual([mixed.by_scope.fan.group, mixed.by_scope.fan.scope_tree, mixed.by_scope['fan/a'].group, Boolean(mixed.by_scope['fan/a'].scope_tree)],
        ['fan', undefined, 'fan', true]);
      assert.equal(rootSet.counts.lexical, 4, 'the root and its nested scope are two groups');
      const alone = await memory.recall('fan', query, { seedsOnly: true });
      const ranks = items => Object.fromEntries(items.filter(item => (item.scope ?? 'fan') === 'fan').map(item => [`${item.kind}:${item.id}`,
        [...item.channels].sort((a, b) => a.channel.localeCompare(b.channel))]));
      assert.deepEqual(ranks(mixed.ranked), ranks(alone.ranked), 'the root\'s per-channel ranks equal its exact read\'s');
      // An ancestor and its descendant are one group of exact elements, never a subtree.
      const pair = counting();
      const nested = await pair.memory.recall(['fan/a', 'fan/a/b'], query, { seedsOnly: true });
      assert.equal(pair.counts.lexical, 2, 'one group');
      assert.deepEqual([...new Set(nested.ranked.map(item => item.scope))].sort(), ['fan/a', 'fan/a/b']);
      // An opaque name containing '/' is its own flat group, and list reads it with any other element.
      const opaque = counting();
      const odd = await opaque.memory.recall(['fa', 'fan/odd name'], query, { seedsOnly: true });
      assert.deepEqual([opaque.counts.lexical, odd.by_scope['fan/odd name'].group, odd.by_scope['fan/odd name'].scope_tree], [4, 'fan/odd name', undefined]);
      assert.ok((await memory.list(['fa', 'fan/odd name'], {})).items.some(item => item.scope === 'fan/odd name'));
      // Digests over a set: one store identity, and every record's stored hash.
      const opted = await memory.recall(['fa', 'fan/a'], { query: 'harbor lantern decision', digests: true });
      const status = await memory.status('fa');
      assert.deepEqual(opted.store_identity, status.store);
      assert.equal(JSON.stringify(opted).split('"store_identity"').length, 2);
      const hashes = Object.fromEntries((await memory.store.transaction('read', tx => tx.run(`MATCH (r:SMRecord) WHERE r.scope IN ['fa', 'fan/a']
        RETURN r.scope + ':' + r.record_id AS key, r.hash AS hash`))).records.map(row => [row.get('key'), row.get('hash')]));
      const records = opted.bundles.flatMap(bundle => bundle.records);
      assert.ok(records.length > 0 && records.every(row => row.record_digest === hashes[`${row.scope}:${row.id}`]));
      const seeds = await memory.recall(['fa', 'fan/a'], { query: 'harbor lantern decision', digests: true }, { seedsOnly: true });
      const seededRecords = seeds.ranked.filter(item => item.kind === 'record');
      assert.ok(seededRecords.length > 0 && seededRecords.every(item => item.record_digest === hashes[`${item.scope}:${item.id}`]));
    });

    await check('list over a set walks the union of its elements exactly once, newest first, with a cursor bound to the set', async () => {
      const set = ['fan/a', 'fa', 'fan2/a'];
      const faTurn = (await memory.list('fa', { kind: 'turn', limit: 1 })).items[0];
      const faText = 'The harbor lantern note of fa.';
      await memory.enrich('fa', { records: [{ id: 'd2', kind: 'decision', text: 'A second fa decision.', attribution: 'fixture',
        evidence: [{ turn: faTurn.id, entry_id: 'u', start: 0, end: faText.length }] }],
      relations: [{ id: 'd2-over-d1', type: 'supersedes', from: 'd2', to: 'd1', attribution: 'fixture', evidence: [{ turn: faTurn.id, entry_id: 'u', start: 0, end: faText.length }] }] });
      const { counts, memory: counted } = counting();
      const all = await walk(counted, set, { limit: 2, relations: true });
      assert.equal(counts.listPage, all.length, 'one query per page');
      const items = all.flatMap(page => page.items);
      const singles = [];
      for (const scope of set) singles.push(...(await walk(memory, scope, { limit: 64 })).flatMap(page => page.items));
      const key = item => `${item.scope}:${item.id}`;
      assert.deepEqual(items.map(key).sort(), singles.map(key).sort());
      assert.equal(new Set(items.map(key)).size, items.length);
      assert.deepEqual(all.map(page => page.scopes), all.map(() => ['fa', 'fan/a', 'fan2/a']));
      const keyed = items.map(item => [item.stored_at, item.kind === 'turn' ? item.id : identity('record', item.scope, item.id)]);
      for (let index = 1; index < keyed.length; index += 1) {
        const [[at, uid], [next, nextUid]] = [keyed[index - 1], keyed[index]];
        assert.ok(Date.parse(at) > Date.parse(next) || (at === next && uid > nextUid), `order at ${index}`);
      }
      const first = await memory.list(set, { limit: 2 });
      assert.ok(first.next_cursor);
      const reordered = await memory.list(['fan2/a', 'fan/a', 'fa'], { limit: 2, cursor: first.next_cursor });
      assert.ok(reordered.items.length > 0, 'the set is canonical, so its order does not matter');
      await assert.rejects(memory.list('fa', { limit: 2, cursor: first.next_cursor }), { code: 'invalid_input' });
      const single = await memory.list('fa', { limit: 1 });
      await assert.rejects(memory.list(['fa', 'fb'], { limit: 1, cursor: single.next_cursor }), { code: 'invalid_input' });
      assert.equal(JSON.stringify(await memory.list(['fa'], { limit: 1 })), JSON.stringify(single));
      const relations = all.flatMap(page => page.relations);
      assert.ok(relations.some(relation => relation.id === 'd2-over-d1' && relation.scope === 'fa'));
      assert.ok(relations.every(relation => set.includes(relation.scope)));
      const other = await memory.list(['fa', 'fb'], { limit: 2 });
      await assert.rejects(memory.list(set, { limit: 2, cursor: other.next_cursor }), { code: 'invalid_input' }, 'a cursor of another set');
    });

    await check('show units and grouped recall over a set follow each root in its own scope', async () => {
      const turnOf = async scope => (await memory.list(scope, { kind: 'turn', limit: 1 })).items[0];
      const [a, f] = [await turnOf('fan/a'), await turnOf('fa')];
      await memory.ingest('fan/a', { source: 'set-fixture', conversation_id: a.conversation_id, turn_id: `${a.conversation_id}-2`,
        parent_turn_id: a.turn_id, entries: [{ id: 'u', role: 'user', text: 'A later harbor note in fan a.' }] });
      const units = await memory.show(['fa', 'fan/a'], { kind: 'units', follow: {}, units: [
        { key: { scope: 'fan/a', source: 'set-fixture', conversation_id: a.conversation_id }, seeds: [{ kind: 'turn', id: a.id }] },
        { key: { scope: 'fa', source: 'set-fixture', conversation_id: f.conversation_id }, seeds: [{ kind: 'turn', id: f.id }] }] });
      const [inA, inF] = units.units;
      assert.deepEqual([inA.seeds[0].scope, inF.seeds[0].scope], ['fan/a', 'fa']);
      assert.deepEqual(inA.following.map(entry => [entry.after, entry.scope, entry.turns.map(row => row.turn_id)]), [[a.id, undefined, [`${a.conversation_id}-2`]]]);
      assert.deepEqual(inF.following.map(entry => [entry.after, entry.scope, entry.turns.length]), [[f.id, undefined, 0]]);
      const following = await memory.show(['fa', 'fan/a'], { kind: 'following', scope: 'fan/a', turn: a.id });
      assert.equal(JSON.stringify(following), JSON.stringify(await memory.show('fan/a', { kind: 'following', turn: a.id })));
      await assert.rejects(memory.show(['fa', 'fan/a'], { kind: 'following', turn: a.id }), { code: 'invalid_input' });
      const bundle = await memory.show(['fa', 'fan/a'], { kind: 'bundle', seed: { kind: 'record', id: 'd1', scope: 'fan/a' } });
      assert.deepEqual([bundle.bundle.scope, bundle.bundle.records.map(row => row.scope)], ['fan/a', ['fan/a']]);
      const grouped = await memory.recall(['fa', 'fan/a'], { query: 'harbor lantern note', group: 'conversation', mode: 'evidence_advice', follow: {} });
      for (const unit of grouped.units) for (const entry of unit.following) {
        assert.equal(entry.scope, undefined, 'every root is in its unit\'s own scope');
        for (const row of entry.turns) assert.ok(typeof row.id === 'string');
      }
      assert.ok(grouped.units.some(unit => unit.key.scope === 'fan/a' && unit.following.some(entry => entry.turns.length === 1)));
    });

  } finally {
    await base.close();
    await memory.close();
    await fixtures.close();
  }
  return results;
}
