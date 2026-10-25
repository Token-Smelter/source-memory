import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Memory } from '../src/memory.mjs';
import { identity, indexNames, namespace } from '../src/core.mjs';
import { embeddingIdentity } from '../src/models.mjs';

const exec = promisify(execFile);
const contracts = {
  evidence_advice: 'Evidence advice: prioritizes extracted claims that cite user spans; a cited user span may be a question, so this is not user assertion or authority. May return no relevant history. Omitted material may correct shown claims. Disclosures describe retrieval and selection bounds, not detected corrections. No currentness or completeness guarantee.',
  history_search: 'History search: retained conversations in search rank order. Not an answer to what is current. Omitted or later material may correct shown items. Disclosures describe retrieval and selection bounds, not detected corrections. No currentness or completeness guarantee.',
};

export async function runIntegration(database, scratch) {
  const results = [];
  async function check(name, fn) {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS ${name}`);
  }
  let modelDown = false;
  const model = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    if (modelDown) { res.writeHead(503).end(); return; }
    const input = JSON.parse(body);
    if (req.url === '/embed') {
      const vector = value => /aubergine|purple/i.test(value) ? [0, 1, 0] : /amber/i.test(value) ? [-1, 0, 0] : /blue/i.test(value) ? [1, 0, 0]
        : /04:00/.test(value) ? [0, -1, 1] : /quartz/i.test(value) ? [0, -1, 0] : [0, 0, 1];
      res.end(JSON.stringify({ model: 'fixture-only', data: input.input.map((value, index) => ({ index, embedding: vector(value) })) }));
    } else {
      const favored = req.url === '/owner-rerank' ? 'B_OWNER_MARKER' : req.url === '/large-rerank' ? 'LARGE_OWNER_MARKER' : null;
      res.end(JSON.stringify({ results: input.documents.map((value, index) => ({ index,
        relevance_score: favored && value.includes(favored) ? 100 : 1 / (index + 1) })) }));
    }
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const url = `http://127.0.0.1:${model.address().port}`;
  const config = { neo4j: database, scopes: { read: ['demo', 'foreign', 'exclusion', 'lexical', 'modes', 'packing'], write: ['demo', 'foreign', 'exclusion', 'lexical', 'modes', 'packing'] },
    embedding: { url: `${url}/embed`, model: 'fixture-only', dimensions: 3 },
    reranker: { url: `${url}/rerank`, model: 'fixture-only' } };
  const memory = new Memory(config);
  const turn = (id, value) => ({ source: 'integration-fixture', conversation_id: 'conversation', turn_id: id,
    entries: [{ id: `u-${id}`, role: 'user', text: value }] });
  const oldInput = turn('old', 'Use blue for the dashboard.');
  const newInput = { ...turn('new', 'Replace that choice with amber.'), parent_turn_id: 'old' };
  let oldSource;
  let newSource;
  const span = (source, input) => ({ turn: source.id, entry_id: input.entries[0].id, start: 0, end: input.entries[0].text.length });
  try {
    await memory.init('demo');
    await memory.init('foreign');
    await memory.init('exclusion');
    await memory.init('modes');
    await memory.init('packing');
    const plain = new Memory({ ...config, embedding: undefined, reranker: undefined }, memory.store);
    const key = embeddingIdentity(config.embedding);
    const fiveChannels = ['turn_lexical', 'record_lexical', 'chunk_lexical', 'chunk_vector', 'record_vector'];
    const modeTurn = (conversation, id, value) => ({ source: 'mode-fixture', conversation_id: conversation, turn_id: id,
      entries: [{ id: `entry-${id}`, role: 'user', text: value }] });
    const chunkUid = input => identity('chunk', 'modes', identity('turn', 'modes', input.source, input.conversation_id, input.turn_id), 0);
    const withPrefix = (prefix, make, uid) => {
      for (let index = 0; index < 10000; index += 1) {
        const value = make(index);
        if (uid(value).split('_')[1].startsWith(prefix)) return value;
      }
      throw new Error('fixture identity prefix unavailable');
    };
    const flood = [];
    for (let index = 0; index < 8; index += 1) {
      const input = withPrefix('0', suffix => modeTurn('flood', `flood-${index}-${suffix}`, `${'admissionneedle '.repeat(12)}quartz question ${index}`), chunkUid);
      flood.push({ input, source: await memory.ingest('modes', input) });
    }
    const otherInput = withPrefix('f', suffix => modeTurn('other', `answer-${suffix}`, `${'context '.repeat(180)}admissionneedle quartz answer`), chunkUid);
    const other = { input: otherInput, source: await memory.ingest('modes', otherInput) };
    const modeClaim = (id, row) => ({ id, kind: 'observation', status: 'observed', attribution: 'fixture',
      text: row.input.entries[0].text, evidence: [span(row.source, row.input)] });
    for (const [index, row] of [...flood, other].entries()) {
      const id = withPrefix(index < 8 ? '0' : 'f', suffix => `claim-${index}-${suffix}`, value => identity('record', 'modes', value));
      row.record = id;
      await memory.enrich('modes', { records: [modeClaim(id, row)], relations: [] });
    }
    const excludedFlood = [{ source: 'mode-fixture', conversation_id: 'flood' }];
    const admittedChannels = async (exclude = [], candidates = 3, per = 2) => {
      const scanned = (await memory.store.vectors('modes', key, 10001, exclude)).slice(0, 10000).map(row => row.uid);
      return Promise.all([
        ...['turn', 'record', 'chunk'].map(kind => memory.store.admittedLexical('modes', kind, 'admissionneedle', candidates, per, exclude)),
        ...['chunk', 'record'].map(kind => memory.store.admittedVectors('modes', kind, key, [0, -1, 0], scanned, candidates, per, exclude)),
      ]);
    };
    await check('conversation admission inside all five channels admits the other conversation past a seed flood', async () => {
      const results = await admittedChannels();
      assert.deepEqual(results.map(result => [result.hits.length, result.admitted_conversations, result.exhausted,
        result.hits.filter(hit => hit.conversations.some(context => context.key.conversation_id === 'flood')).length,
        result.hits.filter(hit => hit.conversations.some(context => context.key.conversation_id === 'other')).length]),
      Array.from({ length: 5 }, () => [3, 2, true, 2, 1]), 'conversation admission must precede channel candidate caps');
    });
    await check('grouped seed truncation counts unique omitted identities and excludes seeds rescued by another channel', async () => {
      const recalled = await memory.recall('modes', { query: 'admissionneedle', group: 'conversation', candidates: 3, per_conversation: 2, limit: 32, max_chars: 200000 });
      const unit = recalled.units.find(unit => unit.key.conversation_id === 'flood');
      const turnSeeds = new Set(unit.seeds.filter(bundle => bundle.match.kind === 'turn').map(bundle => bundle.match.id));
      const recordSeeds = new Set(unit.seeds.filter(bundle => bundle.match.kind === 'record').map(bundle => bundle.match.id));
      assert.deepEqual([unit.seeds_truncated, recalled.bundles, recalled.pool_truncated,
        fiveChannels.map(name => [recalled.channels[name].admitted_conversations, recalled.channels[name].exhausted]),
        Object.hasOwn(recalled.channels.reranker, 'admitted_conversations'), Object.hasOwn(recalled.channels.reranker, 'exhausted')],
      [16 - turnSeeds.size - recordSeeds.size, recalled.units.flatMap(unit => unit.seeds), 0, Array.from({ length: 5 }, () => [2, true]), false, false]);
    });
    await check('grouped exclusion precedes admission and candidate caps in all five channels', async () => {
      const results = await admittedChannels(excludedFlood, 1, 1);
      assert.deepEqual(results.map(result => [result.hits.length, result.admitted_conversations, result.exhausted,
        result.hits.every(hit => hit.conversations.every(context => context.key.conversation_id === 'other'))]),
      Array.from({ length: 5 }, () => [1, 1, false, true]), 'exclusion must precede grouped channel caps');
    });
    await check('grouped vector exclusion precedes the shared scan bound and scan truncation remains partial', async () => {
      const bounded = new Memory({ ...config, vector_scan_limit: 2 }, memory.store);
      const request = { query: 'admissionneedle', group: 'conversation', candidates: 3 };
      const excluded = await bounded.recall('modes', { ...request, exclude_conversations: excludedFlood });
      const full = await bounded.recall('modes', request);
      assert.deepEqual(['chunk_vector', 'record_vector'].map(name => [excluded.channels[name].status,
        excluded.channels[name].scan_truncated, excluded.channels[name].admitted_conversations, full.channels[name].status, full.channels[name].scan_truncated,
        typeof full.channels[name].admitted_conversations, typeof full.channels[name].exhausted]),
      [['ready', false, 1, 'partial', true, 'number', 'boolean'], ['ready', false, 1, 'partial', true, 'number', 'boolean']],
        'vector exclusion must precede the shared scan cap');
    });
    await check('grouped pending counts exclude unindexed text from excluded conversations', async () => {
      const deferred = new Memory({ ...config, index_on_write: false }, memory.store);
      await deferred.ingest('modes', modeTurn('flood', 'deferred', 'admissionneedle quartz still unindexed'));
      const request = { query: 'admissionneedle', group: 'conversation' };
      const excluded = await memory.recall('modes', { ...request, exclude_conversations: excludedFlood });
      const full = await memory.recall('modes', request);
      assert.deepEqual([excluded.channels.chunk_vector.status, excluded.channels.chunk_vector.unindexed,
        full.channels.chunk_vector.status, full.channels.chunk_vector.unindexed > 0], ['ready', 0, 'partial', true], 'pending counts must exclude excluded conversations');
      await memory.index('modes');
    });
    await check('duplicate matching chunks consume one turn seed in conversation admission', async () => {
      await memory.ingest('modes', modeTurn('flood', 'many-chunks', 'admissionneedle quartz '.repeat(1000)));
      const result = await memory.store.admittedLexical('modes', 'chunk', 'admissionneedle', 3, 2);
      assert.deepEqual([result.hits.length, new Set(result.hits.map(hit => hit.id)).size,
        result.hits.filter(hit => hit.conversations[0].key.conversation_id === 'flood').length], [3, 3, 2]);
    });
    await check('grouped vector cosine ties break by node uid regardless of scanned input order', async () => {
      const scanned = (await memory.store.vectors('modes', key, 10001)).map(row => row.uid).reverse();
      const chunks = await memory.store.admittedVectors('modes', 'chunk', key, [0, -1, 0], scanned, 3, 2);
      const records = await memory.store.admittedVectors('modes', 'record', key, [0, -1, 0], scanned, 3, 2);
      const firstRecord = [...flood].sort((a, b) => identity('record', 'modes', a.record).localeCompare(identity('record', 'modes', b.record)))[0];
      const expectedChunk = scanned.filter(uid => uid.startsWith('chunk_')).sort()[0];
      const row = (await memory.store.vectors('modes', key, 10001)).find(row => row.uid === expectedChunk);
      assert.deepEqual([chunks.hits[0].id, records.hits[0].id], [row.turn_uid, firstRecord.record]);
    });
    await check('record exclusion precedes per-key admission even for a retained multi-conversation record', async () => {
      const records = flood.slice(0, 6).map((row, index) => ({ ...modeClaim(`membership-${index}`, row), text: 'membershipneedle '.repeat(20) }));
      records.push({ ...modeClaim('membership-mixed', other), text: `${'context '.repeat(180)}membershipneedle`,
        evidence: [span(flood[0].source, flood[0].input), span(other.source, other.input)] });
      await memory.enrich('modes', { records, relations: [] });
      const result = await memory.store.admittedLexical('modes', 'record', 'membershipneedle', 1, 1, excludedFlood);
      assert.deepEqual([result.hits.map(hit => hit.id), result.admitted_conversations, result.exhausted], [['membership-mixed'], 2, false],
        'exclusion must precede per-key admission for shared records');
    });
    await check('recall validates optional modes grouping and per-conversation bounds before storage access', async () => {
      const denied = new Memory({ scopes: config.scopes }, new Proxy({}, { get: () => { throw new Error('storage touched'); } }));
      for (const input of [{ mode: null }, { mode: 'other' }, { mode: ['history_search'] }, { mode: {} },
        { group: null }, { group: 'turn' }, { group: ['conversation'] },
        ...[0, 5, 1.5, '2', null, true].map(per_conversation => ({ per_conversation }))]) {
        await assert.rejects(denied.recall('modes', { query: 'q', ...input }), { code: 'invalid_input' });
      }
      await assert.rejects(denied.conversationUnits('not-allowed', [], {}, [], 'q', 1, 256, 1, 0), { code: 'scope_denied' });
    });
    await check('absent options remain byte-identical to pinned I1 and mode alone only echoes its exact contract', async () => {
      const [baseline, priorStore] = await Promise.all(['memory', 'store'].map(file =>
        exec('git', ['show', `5e2dab07c60a75d8bba6e05b2456dac0c409b4f4:src/${file}.mjs`])));
      const path = join(scratch, 'i1-memory.mjs');
      const storePath = join(scratch, 'i1-store.mjs');
      const imports = source => source.replaceAll("'./core.mjs'", JSON.stringify(new URL('../src/core.mjs', import.meta.url).href))
        .replaceAll("'./models.mjs'", JSON.stringify(new URL('../src/models.mjs', import.meta.url).href))
        .replaceAll("'neo4j-driver'", JSON.stringify(import.meta.resolve('neo4j-driver')));
      await writeFile(storePath, imports(priorStore.stdout), { mode: 0o600 });
      await writeFile(path, imports(baseline.stdout).replaceAll("'./store.mjs'", JSON.stringify(pathToFileURL(storePath).href)), { mode: 0o600 });
      const { Memory: I1 } = await import(pathToFileURL(path).href);
      const { Neo4jStore: I1Store } = await import(pathToFileURL(storePath).href);
      const cache = store => {
        const results = new Map();
        return new Proxy(store, { get(target, name) {
          const value = target[name];
          if (typeof value !== 'function') return value;
          return (...args) => {
            const token = JSON.stringify([name, args]);
            if (!results.has(token)) results.set(token, value.apply(target, args));
            return results.get(token);
          };
        } });
      };
      const original = new I1Store(database);
      try {
        const old = new I1(config, cache(original));
        const current = new Memory(config, cache(memory.store));
        for (const request of [{ query: 'admissionneedle', limit: 1 }, { query: 'admissionneedle', max_chars: 256 },
          { query: 'admissionneedle', exclude_conversations: excludedFlood }]) {
          // Freeze each implementation's own real-store responses, removing only transaction completion-order noise.
          await old.recall('modes', request);
          await current.recall('modes', request);
          const before = JSON.stringify(await old.recall('modes', request));
          assert.equal(JSON.stringify(await current.recall('modes', request)), before);
          assert.equal(JSON.stringify(await current.recall('modes', { ...request, per_conversation: 4 })), before);
          for (const mode of Object.keys(contracts)) {
            const { mode: echoed, mode_contract, ...rest } = await current.recall('modes', { ...request, mode });
            assert.deepEqual([JSON.stringify(rest), echoed, mode_contract], [before, mode, contracts[mode]]);
          }
        }
      } finally { await original.close(); }
    });
    const packingA = modeTurn('a', 'pack-a', `${'packneedle '.repeat(30)}A_OWNER_MARKER`);
    const packingB = modeTurn('b', 'pack-b', `B_OWNER_MARKER ${'context '.repeat(180)}packneedle`);
    const packedA = await plain.ingest('packing', packingA);
    const packedB = await plain.ingest('packing', packingB);
    await plain.enrich('packing', { records: [{ id: 'shared', kind: 'observation', status: 'observed', attribution: 'fixture',
      text: 'packneedle sharedonlyneedle', evidence: [span(packedB, packingB), span(packedA, packingA)] }], relations: [] });
    await check('conversation units package a multi-conversation record once without splitting evidence', async () => {
      const recalled = await plain.recall('packing', { query: 'packneedle', group: 'conversation', per_conversation: 1, limit: 2 });
      const unit = recalled.units.find(unit => unit.key.conversation_id === 'a');
      const shared = unit.seeds.find(bundle => bundle.match.kind === 'record');
      const modeResults = [];
      const shape = reply => reply.units.map(unit => [unit.key, unit.seeds.map(bundle => bundle.match.id)]);
      for (const mode of Object.keys(contracts)) {
        const reply = await plain.recall('packing', { query: 'packneedle', group: 'conversation', per_conversation: 1, limit: 2, mode });
        modeResults.push([reply.mode, reply.mode_contract, shape(reply)]);
      }
      assert.deepEqual([recalled.units.length, unit.seeds.length, unit.also_cites, recalled.bundles,
        recalled.bundles.filter(bundle => bundle.match.kind === 'record').length, shared.records[0].supporting_evidence.map(span => span.conversation_id), modeResults],
      [2, 2, [{ scope: 'packing', source: 'mode-fixture', conversation_id: 'b' }], recalled.units.flatMap(unit => unit.seeds), 1, ['b', 'a'],
        Object.entries(contracts).map(([mode, contract]) => [mode, contract, shape(recalled)])]);
    });
    await check('shared-record ownership follows final reranked seed priority and qualified-key tie order', async () => {
      const reranked = new Memory({ ...config, embedding: undefined, reranker: { ...config.reranker, url: `${url}/owner-rerank` } }, memory.store);
      const chosen = await reranked.recall('packing', { query: 'packneedle', group: 'conversation', limit: 2 });
      const tied = await plain.recall('packing', { query: 'sharedonlyneedle', group: 'conversation', limit: 2 });
      assert.deepEqual([chosen.units[0].key.conversation_id, chosen.units[0].seeds.some(bundle => bundle.match.kind === 'record'),
        chosen.units[0].also_cites, tied.units.map(unit => unit.key.conversation_id), tied.units[0].seeds.length],
      ['b', true, [{ scope: 'packing', source: 'mode-fixture', conversation_id: 'a' }], ['a'], 1]);
    });
    await check('legacy grouping uses body keys without changing exclusion or crossing scopes with identical source keys', async () => {
      const input = modeTurn('legacy-collision', 'same-turn', 'legacygroupneedle local');
      const local = await plain.ingest('packing', input);
      await plain.ingest('packing', { ...input, turn_id: 'newer', entries: [{ ...input.entries[0], text: 'legacygroupneedle newer' }] });
      const foreign = await plain.ingest('foreign', { ...input, entries: [{ ...input.entries[0], text: 'legacygroupneedle foreign' }] });
      await memory.store.transaction('write', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) REMOVE t.source,t.conversation_id', { uid: local.id }));
      const request = { query: 'legacygroupneedle', group: 'conversation', per_conversation: 1,
        exclude_conversations: [{ source: input.source, conversation_id: input.conversation_id }] };
      const own = await plain.recall('packing', request);
      const otherScope = await plain.recall('foreign', { ...request, exclude_conversations: [] });
      const retained = await memory.store.transaction('read', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) RETURN t.source AS source,t.conversation_id AS conversation', { uid: local.id }));
      assert.deepEqual([own.units.map(unit => [unit.key, unit.legacy, unit.seeds[0].match.id]),
        otherScope.units.map(unit => [unit.key, unit.seeds[0].match.id]), retained.records[0].toObject()],
      [[[{ scope: 'packing', source: input.source, conversation_id: input.conversation_id }, true, local.id]],
        [[{ scope: 'foreign', source: input.source, conversation_id: input.conversation_id }, foreign.id]], { source: null, conversation: null }]);
    });
    const largeInput = modeTurn('large', 'budget-large', `LARGE_OWNER_MARKER budgetneedle budgetneedle ${'🪄'.repeat(700)}`);
    const large = await plain.ingest('packing', largeInput);
    await plain.enrich('packing', { records: [{ ...modeClaim('large-claim', { source: large, input: largeInput }), text: 'budgetneedle claim' }], relations: [] });
    await plain.ingest('packing', modeTurn('small', 'budget-small', 'budgetneedle shorter'));
    await check('grouped budgets use UTF-8 bytes and skip entire multi-seed units while continuing to the next unit', async () => {
      const budgeted = new Memory({ ...config, embedding: undefined, reranker: { ...config.reranker, url: `${url}/large-rerank` } }, memory.store);
      const request = { query: 'budgetneedle', group: 'conversation', limit: 2, max_chars: 200000 };
      const wide = await budgeted.recall('packing', request);
      const first = wide.units[0];
      const bytes = Buffer.byteLength(JSON.stringify(first));
      const exact = await budgeted.recall('packing', { ...request, limit: 1, max_chars: bytes });
      const short = await budgeted.recall('packing', { ...request, limit: 1, max_chars: bytes - 1 });
      const multibyte = await budgeted.recall('packing', { ...request, max_chars: JSON.stringify(first).length });
      assert.deepEqual([first.key.conversation_id, first.seeds.length, exact.units[0].seeds.length, exact.pool_truncated,
        short.units.length, short.bundles.length, short.budget_omitted, short.status, short.relationship_context_complete,
        multibyte.units.map(unit => unit.key.conversation_id), multibyte.bundles, multibyte.budget_omitted, multibyte.pool_truncated, multibyte.budget_unit],
      ['large', 2, 2, 1, 0, 0, 1, 'budget_limited', false, ['small'], multibyte.units.flatMap(unit => unit.seeds), 1, 0, 'utf8_bytes']);
    });
    await check('pending and unavailable grouped channels remain readiness states rather than budget omissions', async () => {
      const status = memory.store.lexicalStatus;
      try {
        for (const state of [{ status: 'pending' }, { status: 'unavailable', reason: 'fixture_unavailable' }]) {
          memory.store.lexicalStatus = (scope, kind) => kind === 'chunk' ? state : status.call(memory.store, scope, kind);
          const recalled = await plain.recall('packing', { query: 'sharedonlyneedle', group: 'conversation' });
          assert.deepEqual([recalled.channels.chunk_lexical, recalled.budget_omitted, recalled.pool_truncated, recalled.retrieval_complete,
            recalled.status === 'degraded'], [state, 0, 0, false, state.status === 'unavailable']);
        }
      } finally { memory.store.lexicalStatus = status; }
    });
    await check('unconfigured grouped vector channels omit admission metadata rather than reporting zero activity', async () => {
      const recalled = await plain.recall('packing', { query: 'sharedonlyneedle', group: 'conversation' });
      assert.deepEqual([recalled.channels.chunk_vector, recalled.channels.record_vector, recalled.channels.reranker],
        [{ status: 'unconfigured' }, { status: 'unconfigured' }, { status: 'unconfigured' }]);
    });
    await check('unavailable grouped vector channels omit admission metadata when their model call fails', async () => {
      modelDown = true;
      try {
        const recalled = await memory.recall('modes', { query: 'admissionneedle', group: 'conversation' });
        assert.deepEqual([recalled.channels.chunk_vector, recalled.channels.record_vector],
          [{ status: 'unavailable', reason: 'model_request_failed' }, { status: 'unavailable', reason: 'model_request_failed' }]);
      } finally { modelDown = false; }
    });
    const lexical = new Memory({ neo4j: database, scopes: config.scopes });
    try {
      const input = { ...turn('long', ''), entries: ['system', 'user', 'tool', 'assistant'].map(role => ({
        id: `${role}-entry`, role,
        text: `${'context '.repeat(600)}${role === 'tool' ? 'lexicalneedle' : `${role}note`} ${'context '.repeat(40)}`,
      })) };
      const source = await lexical.ingest('lexical', input);
      const entry = input.entries.find(row => row.role === 'tool');
      const start = 'context '.repeat(448).length;
      const end = entry.text.trimEnd().length;
      const hit = { kind: 'turn', id: source.id, text: entry.text.slice(start, end),
        match: { turn: source.id, entry_id: entry.id, start, end, role: entry.role },
        conversation: { scope: 'lexical', source: input.source, conversation_id: input.conversation_id } };
      await check('chunk lexical reports a missing index with a safe unavailable reason', async () => {
        const recalled = await lexical.recall('lexical', { query: 'lexicalneedle' });
        assert.deepEqual(recalled.channels.chunk_lexical, { status: 'unavailable', reason: 'chunk_index_missing' });
      });
      await check('init twice creates one scope chunk text index populated from existing chunks', async () => {
        const first = await lexical.init('lexical');
        const second = await lexical.init('lexical');
        const indexes = await lexical.store.transaction('read', tx => tx.run(`SHOW FULLTEXT INDEXES YIELD name,labelsOrTypes,properties
          WHERE name=$name RETURN labelsOrTypes,properties`, { name: indexNames('lexical').chunks }));
        assert.deepEqual([first, second, indexes.records.map(row => row.toObject()),
          await lexical.store.chunkLexicalStatus('lexical'), await lexical.store.chunkLexical('lexical', 'lexicalneedle', 1)],
          [{ initialized: true, scope: 'lexical' }, { initialized: true, scope: 'lexical' },
            [{ labelsOrTypes: [`${namespace('lexical')}Chunk`], properties: ['text'] }], { status: 'ready' }, [hit]]);
      });
      await check('new chunks store the role of every entry', async () => {
        const roles = await lexical.store.transaction('read', tx => tx.run(`MATCH (c:SMChunk {turn_uid:$uid})
          RETURN DISTINCT c.entry_id AS entry_id,c.role AS role ORDER BY entry_id`, { uid: source.id }));
        assert.deepEqual(roles.records.map(row => row.toObject()), input.entries.map(row => ({ entry_id: row.id, role: row.role }))
          .sort((a, b) => a.entry_id.localeCompare(b.entry_id)));
      });
      await check('chunk lexical returns the exact matching entry and span in a long multi-entry turn without embeddings', async () => {
        const recalled = await lexical.recall('lexical', { query: 'lexicalneedle', limit: 1 });
        const bundle = recalled.bundles[0];
        assert.deepEqual([recalled.channels.chunk_lexical, recalled.channels.chunk_vector.status,
          bundle?.match.channels.map(row => row.channel).sort(), bundle?.source.excerpts[0]],
          [{ status: 'ready' }, 'unconfigured', ['chunk_lexical', 'turn_lexical'], { ...hit.match, text: hit.text }]);
      });
      await check('legacy chunk roles resolve from the exact parent entry without backfill writes', async () => {
        await lexical.store.transaction('write', tx => tx.run('MATCH (c:SMChunk {turn_uid:$uid,entry_id:$entry}) REMOVE c.role',
          { uid: source.id, entry: entry.id }));
        const hits = await lexical.store.chunkLexical('lexical', 'lexicalneedle', 1);
        const recalled = await lexical.recall('lexical', { query: 'lexicalneedle', limit: 1 });
        const stored = await lexical.store.transaction('read', tx => tx.run('MATCH (c:SMChunk {turn_uid:$uid,entry_id:$entry}) RETURN count(c.role) AS roles',
          { uid: source.id, entry: entry.id }));
        assert.deepEqual([hits, recalled.bundles[0]?.source.excerpts[0], stored.records[0].get('roles')],
          [[hit], { ...hit.match, text: hit.text }, 0]);
      });
      const stored = await lexical.store.transaction('read', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) RETURN t.body AS body', { uid: source.id }));
      const body = stored.records[0].get('body');
      const original = JSON.parse(body);
      for (const [name, entries] of [['missing', original.entries.filter(row => row.id !== entry.id)],
        ['ambiguous', [...original.entries, { ...entry, role: 'assistant' }]]]) {
        await check(`${name} parent entry joins retain the chunk lexical excerpt with unknown role in public recall`, async () => {
          try {
            await lexical.store.transaction('write', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) SET t.body=$body',
              { uid: source.id, body: JSON.stringify({ ...original, entries }) }));
            const hits = await lexical.store.chunkLexical('lexical', 'lexicalneedle', 1);
            const recalled = await lexical.recall('lexical', { query: 'lexicalneedle', limit: 1 });
            const bundle = recalled.bundles[0];
            assert.deepEqual([hits, recalled.channels.chunk_lexical, bundle?.match.channels.some(row => row.channel === 'chunk_lexical'), bundle?.source.excerpts[0]],
              [[{ ...hit, match: { ...hit.match, role: 'unknown' } }], { status: 'ready' }, true, { ...hit.match, role: 'unknown', text: hit.text }]);
          } finally {
            await lexical.store.transaction('write', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) SET t.body=$body', { uid: source.id, body }));
          }
        });
      }
      await check('legacy chunk conversation keys come from the parent body and remain informational', async () => {
        try {
          await lexical.store.transaction('write', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) REMOVE t.source,t.conversation_id', { uid: source.id }));
          const hits = await lexical.store.chunkLexical('lexical', 'lexicalneedle', 1, [{ source: input.source, conversation_id: input.conversation_id }]);
          const properties = await lexical.store.transaction('read', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) RETURN t.source AS source,t.conversation_id AS conversation',
            { uid: source.id }));
          assert.deepEqual([hits, properties.records[0].toObject()],
            [[{ ...hit, conversation: { ...hit.conversation, legacy: true } }], { source: null, conversation: null }]);
        } finally {
          await lexical.store.transaction('write', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) SET t.source=$source,t.conversation_id=$conversation',
            { uid: source.id, source: input.source, conversation: input.conversation_id }));
        }
      });
      await check('scope chunk indexes isolate identical source conversation and turn keys in both directions', async () => {
        const foreignText = 'lexicalneedle belongs to another scope.';
        const foreign = await lexical.ingest('foreign', { ...input, entries: [{ ...entry, text: foreignText }] });
        const foreignHit = { kind: 'turn', id: foreign.id, text: foreignText,
          match: { turn: foreign.id, entry_id: entry.id, start: 0, end: foreignText.length, role: entry.role },
          conversation: { ...hit.conversation, scope: 'foreign' } };
        assert.deepEqual([await lexical.store.chunkLexical('lexical', 'lexicalneedle', 32),
          await lexical.store.chunkLexical('foreign', 'lexicalneedle', 32)], [[hit], [foreignHit]]);
      });
    } finally { await lexical.close(); }
    // The asker's own conversation outranks everything else in every channel; one other conversation holds the answer.
    const said = (conversation, id, value) => ({ source: 'integration-fixture', conversation_id: conversation, turn_id: id,
      entries: [{ id: `u-${id}`, role: 'user', text: value }] });
    const asked = [];
    for (let index = 0; index < 6; index += 1) {
      const input = said('asker', `q${index}`, `Quartz quartz quartz: when does the quartz backup window start? Question ${index}.`);
      asked.push({ input, source: await memory.ingest('exclusion', input) });
    }
    const answerInput = said('decider', 'd1', `After a long review of the rota, the staffing plan, the storage costs and several unrelated scheduling notes, the decision is that the quartz backup window should start at 04:00 from now on. ${'Other notes follow. '.repeat(12)}`);
    const answer = await memory.ingest('exclusion', answerInput);
    const claim = (id, input, source, extra = []) => ({ id, kind: 'decision', status: 'proposed', attribution: 'fixture', text: input.entries[0].text,
      evidence: [span(source, input), ...extra] });
    await memory.enrich('exclusion', { records: [
      ...asked.map(({ input, source }, index) => claim(`asker-claim-${index}`, input, source)),
      claim('decider-decision', answerInput, answer),
      claim('mixed-claim', asked[0].input, asked[0].source, [span(answer, answerInput)]),
    ], relations: [] });
    await memory.index('exclusion');
    const asker = [{ source: 'integration-fixture', conversation_id: 'asker' }];
    await check('chunk lexical excludes dominating conversations before its candidate limit', async () => {
      const plain = await memory.store.chunkLexical('exclusion', 'quartz backup window start', 1);
      const excluded = await memory.store.chunkLexical('exclusion', 'quartz backup window start', 1, asker);
      const recalled = await memory.recall('exclusion', { query: 'quartz backup window start', candidates: 1, limit: 1, exclude_conversations: asker });
      assert.deepEqual([asked.some(row => row.source.id === plain[0]?.id), excluded.map(row => row.id),
        recalled.bundles[0]?.source?.id, recalled.bundles[0]?.match.channels.some(row => row.channel === 'chunk_lexical')],
        [true, [answer.id], answer.id, true], 'chunk lexical exclusion must precede the candidate limit');
    });
    const conversationsOf = bundle => [...new Set([bundle.source?.conversation_id,
      ...bundle.records.flatMap(row => (row.supporting_evidence ?? []).map(span => span.conversation_id))].filter(Boolean))].sort();
    await check('without exclusion the asker\'s own conversation fills the first four in every channel', async () => {
      const recalled = await memory.recall('exclusion', { query: 'quartz backup window start', limit: 4 });
      assert.deepEqual([recalled.excluded_conversations, recalled.bundles.every(bundle => conversationsOf(bundle).includes('asker'))], [0, true]);
    });
    await check('excluding the asker returns the other conversation\'s eligible matches through every channel', async () => {
      const recalled = await memory.recall('exclusion', { query: 'quartz backup window start', limit: 4, exclude_conversations: asker });
      const seed = bundle => bundle.match.kind === 'turn' ? [bundle.source.conversation_id]
        : bundle.records.find(row => row.id === bundle.match.id).supporting_evidence.map(span => span.conversation_id);
      assert.equal(recalled.bundles.some(bundle => seed(bundle).every(conversation => conversation === 'asker')), false);
      const channels = bundle => bundle?.match.channels.map(row => row.channel).sort();
      const turn = recalled.bundles.find(bundle => bundle.match.kind === 'turn' && bundle.source.conversation_id === 'decider');
      const record = recalled.bundles.find(bundle => bundle.match.kind === 'record' && bundle.match.id === 'decider-decision');
      assert.deepEqual([channels(turn), channels(record), recalled.excluded_conversations],
        [['chunk_lexical', 'chunk_vector', 'turn_lexical'], ['record_lexical', 'record_vector'], 1]);
    });
    await check('a record citing the asker and another conversation is still returned, for the caller to refuse', async () => {
      const recalled = await memory.recall('exclusion', { query: 'quartz backup window start', limit: 32, exclude_conversations: asker });
      assert.ok(recalled.bundles.some(bundle => bundle.records.some(row => row.id === 'mixed-claim')));
    });
    await check('the asker\'s unindexed text does not hold back recall of the others', async () => {
      // As the live pilot runs: the asker's current turn is stored at admission and indexed later.
      const deferred = new Memory({ ...config, index_on_write: false });
      await deferred.ingest('exclusion', said('asker', 'q-new', 'Quartz again: the quartz window?'));
      await deferred.close?.();
      const excluded = await memory.recall('exclusion', { query: 'quartz backup window start', limit: 4, exclude_conversations: asker });
      const plain = await memory.recall('exclusion', { query: 'quartz backup window start', limit: 4 });
      assert.deepEqual([excluded.channels.chunk_vector.status, plain.channels.chunk_vector.status], ['ready', 'partial']);
      await memory.index('exclusion');
    });
    await check('a turn stored without conversation properties is never excluded, nor are its chunks, records or pending text', async () => {
      const legacyInput = said('legacy', 'old1', 'Quartz legacy note about the window.');
      const later = new Memory({ ...config, index_on_write: false });
      const legacy = await later.ingest('exclusion', legacyInput);
      await later.close();
      // As turns stored before lineage properties existed.
      await memory.store.transaction('write', tx => tx.run('MATCH (t:SMTurn {uid:$uid}) REMOVE t.source, t.conversation_id', { uid: legacy.id }));
      const pending = await memory.recall('exclusion', { query: 'quartz legacy note', limit: 32, exclude_conversations: asker });
      await memory.enrich('exclusion', { records: [claim('legacy-claim', legacyInput, legacy),
        claim('asker-legacy-claim', asked[1].input, asked[1].source, [span(legacy, legacyInput)])], relations: [] });
      await memory.index('exclusion');
      const recalled = await memory.recall('exclusion', { query: 'quartz legacy note', limit: 32, exclude_conversations: asker });
      const turn = recalled.bundles.find(bundle => bundle.match.kind === 'turn' && bundle.source.id === legacy.id);
      const records = new Set(recalled.bundles.flatMap(bundle => bundle.records.map(row => row.id)));
      assert.deepEqual([pending.channels.chunk_vector.status, turn?.match.channels.map(row => row.channel).sort(), records.has('legacy-claim'), records.has('asker-legacy-claim')],
        ['partial', ['chunk_lexical', 'chunk_vector', 'turn_lexical'], true, true]);
    });
    await check('exclusion names a source and conversation exactly and is bounded', async () => {
      const otherSource = await memory.recall('exclusion', { query: 'quartz backup window start', limit: 4, exclude_conversations: [{ source: 'other', conversation_id: 'asker' }] });
      assert.equal(otherSource.bundles.every(bundle => conversationsOf(bundle).includes('asker')), true);
      await assert.rejects(memory.recall('exclusion', { query: 'q', exclude_conversations: Array.from({ length: 17 }, () => asker[0]) }), { code: 'invalid_input' });
      await assert.rejects(memory.recall('exclusion', { query: 'q', exclude_conversations: [{ ...asker[0], extra: 1 }] }), { code: 'invalid_input' });
    });
    await check('concurrent source replay produces one retained turn', async () => {
      const inserted = await Promise.all([memory.ingest('demo', oldInput), memory.ingest('demo', oldInput)]);
      oldSource = inserted[0];
      assert.deepEqual([new Set(inserted.map(row => row.id)).size, (await memory.status('demo')).turns], [1, 1]);
    });
    await check('changed bytes cannot overwrite an accepted source identity', async () => {
      await assert.rejects(memory.ingest('demo', { ...oldInput, entries: [{ ...oldInput.entries[0], text: 'Changed' }] }), { code: 'source_identity_conflict' });
    });
    newSource = await memory.ingest('demo', newInput);
    const record = (id, source, input) => ({ id, kind: 'decision', status: 'accepted', attribution: 'fixture operator', text: input.entries[0].text, evidence: [span(source, input)] });
    const enrichment = { records: [record('old-decision', oldSource, oldInput), record('new-decision', newSource, newInput)],
      relations: [{ id: 'replacement', type: 'supersedes', from: 'new-decision', to: 'old-decision', attribution: 'fixture operator', evidence: [span(newSource, newInput)] }] };
    await check('structured enrichment replays without duplicate records or relations', async () => {
      await memory.enrich('demo', enrichment);
      await memory.enrich('demo', enrichment);
      const counts = await memory.status('demo');
      assert.deepEqual([counts.records, counts.relations], [2, 1]);
    });
    await check('an old lexical match includes the semantically dissimilar successor', async () => {
      const recalled = await memory.recall('demo', { query: 'blue', limit: 1 });
      assert.deepEqual(recalled.bundles[0].records.map(row => row.id).sort(), ['new-decision', 'old-decision']);
    });
    await check('source evidence is exact and survives independently of session files', async () => {
      assert.deepEqual((await memory.show('demo', { kind: 'turn', id: oldSource.id })).turn.entries[0], { ...oldInput.entries[0], occurred_at: null });
    });
    await check('a turn without extracted memories is lexically retrievable', async () => {
      const source = await memory.ingest('demo', turn('unextracted', 'The weather vane points east.'));
      const recalled = await memory.recall('demo', { query: 'weather', limit: 8 });
      assert.ok(recalled.bundles.some(bundle => bundle.source?.id === source.id && bundle.match.channels.some(channel => channel.channel === 'turn_lexical')));
    });
    await check('fixture vectors recover a source absent from lexical matches', async () => {
      const source = await memory.ingest('demo', turn('semantic', 'The aubergine release is scheduled.'));
      const recalled = await memory.recall('demo', { query: 'purple', limit: 8 });
      const match = recalled.bundles.find(bundle => bundle.source?.id === source.id);
      assert.deepEqual(match.match.channels.map(channel => channel.channel), ['chunk_vector']);
    });
    let foreign;
    await check('scope-specific indexes and graph expansion exclude foreign source', async () => {
      foreign = await memory.ingest('foreign', turn('private', 'Use blue FORBIDDEN_FIXTURE.'));
      const recalled = await memory.recall('demo', { query: 'blue', limit: 32 });
      assert.equal(JSON.stringify(recalled).includes('FORBIDDEN_FIXTURE'), false);
    });
    await check('foreign evidence is rejected atomically', async () => {
      await assert.rejects(memory.enrich('demo', { records: [
        record('must-not-persist', oldSource, oldInput),
        record('foreign-record', foreign, turn('private', 'Use blue FORBIDDEN_FIXTURE.')),
      ], relations: [] }), { code: 'evidence_unavailable' });
      await assert.rejects(memory.show('demo', { kind: 'record', id: 'must-not-persist' }), { code: 'not_found' });
    });
    await check('a conflict late in enrichment rolls back earlier creates', async () => {
      await assert.rejects(memory.enrich('demo', { records: [
        record('rolled-back', oldSource, oldInput),
        { ...record('old-decision', oldSource, oldInput), text: 'This would overwrite history.' },
      ], relations: [] }), { code: 'record_identity_conflict' });
      await assert.rejects(memory.show('demo', { kind: 'record', id: 'rolled-back' }), { code: 'not_found' });
    });
    await check('bounded expansion reports missing successor context', async () => {
      const recalled = await memory.recall('demo', { query: 'blue', max_nodes: 1, limit: 1 });
      assert.equal(recalled.relationship_context_complete, false);
    });
    await check('a seed bundle read without a query reveals a newly added relationship', async () => {
      const before = await memory.show('demo', { kind: 'bundle', seed: { kind: 'record', id: 'old-decision' }, max_nodes: 8, max_hops: 2 });
      await memory.enrich('demo', { records: [{ ...record('qualifier', newSource, newInput), status: 'proposed' }],
        relations: [{ id: 'qualifies-old', type: 'qualifies', from: 'qualifier', to: 'old-decision', attribution: 'fixture', evidence: [span(newSource, newInput)] }] });
      const after = await memory.show('demo', { kind: 'bundle', seed: { kind: 'record', id: 'old-decision' }, max_nodes: 8, max_hops: 2 });
      assert.deepEqual([before.bundle.relations.length, after.bundle.relations.length, after.bundle.records.some(row => row.id === 'qualifier')], [1, 2, true]);
    });
    const lineageTurn = (id, parent, words) => ({ source: 'integration-fixture', conversation_id: 'lineage', turn_id: id,
      ...(parent ? { parent_turn_id: parent } : { lineage_root: true }), entries: [{ id: `u-${id}`, role: 'user', text: words }] });
    const first = await memory.ingest('demo', lineageTurn('l1', null, 'Use teal.'));
    await memory.ingest('demo', lineageTurn('l2', 'l1', 'Actually use amber.'));
    await memory.ingest('demo', lineageTurn('l3', 'l2', 'No, use violet.'));
    await memory.ingest('demo', lineageTurn('l4', 'l3', 'Final answer: green.'));
    await check('following returns later turns by parent link and reports more beyond the limit', async () => {
      const read = await memory.show('demo', { kind: 'following', turn: first.id, limit: 2 });
      assert.deepEqual([read.turns.map(row => row.turn_id), read.has_more, read.end, read.lineage], [['l2', 'l3'], true, 'limit', 'linked']);
    });
    await check('following to the last recorded turn reports a linked recorded end', async () => {
      const read = await memory.show('demo', { kind: 'following', turn: first.id, limit: 3 });
      assert.deepEqual([read.turns.map(row => row.turn_id), read.has_more, read.end, read.lineage], [['l2', 'l3', 'l4'], false, 'recorded_end', 'linked']);
    });
    await check('two children of one turn are reported as branched, not chosen', async () => {
      await memory.ingest('demo', lineageTurn('l2b', 'l1', 'Regenerated: use amber.'));
      const read = await memory.show('demo', { kind: 'following', turn: first.id, limit: 3 });
      assert.deepEqual([read.turns.length, read.lineage, read.end], [0, 'branched', 'branched']);
    });
    await check('a same-conversation turn stored without lineage makes following unknown', async () => {
      const lone = await memory.ingest('demo', { ...lineageTurn('m1', null, 'Use teal.'), conversation_id: 'legacy-conversation' });
      // A turn written before lineage properties existed: same conversation, no parent recorded.
      await memory.store.transaction('write', tx => tx.run('CREATE (t:SMTurn {uid:$uid, scope:$scope, body:$body})',
        { uid: 'legacy-turn', scope: 'demo', body: JSON.stringify({ ...lineageTurn('m0', null, 'Earlier.'), conversation_id: 'legacy-conversation' }) }));
      const read = await memory.show('demo', { kind: 'following', turn: lone.id });
      assert.deepEqual([read.lineage, read.unlinked_turns], ['unknown', 1]);
    });
    await check('a later turn with an unknown parent makes an earlier turn\'s following unknown', async () => {
      const root = await memory.ingest('demo', { ...lineageTurn('g1', null, 'Use teal.'), conversation_id: 'gap' });
      await memory.ingest('demo', { ...lineageTurn('g3', 'g2-never-captured', 'Use amber.'), conversation_id: 'gap' });
      const { lineage_root: _root, ...unrooted } = lineageTurn('g4', null, 'Use violet.');
      await memory.ingest('demo', { ...unrooted, conversation_id: 'gap' });
      const read = await memory.show('demo', { kind: 'following', turn: root.id });
      assert.deepEqual([read.turns.length, read.end, read.lineage, read.unlinked_turns], [0, 'recorded_end', 'unknown', 2]);
    });
    await check('a declared root with a parent is refused', async () => {
      await assert.rejects(memory.ingest('demo', { ...lineageTurn('bad', 'l1', 'x'), lineage_root: true }), { code: 'invalid_input' });
    });
    await check('turns stored by an older caller replay when a newer caller adds lineage, keeping the first placement', async () => {
      const plainRoot = { source: 'integration-fixture', conversation_id: 'upgrade', turn_id: 'v1', entries: [{ id: 'u-v1', role: 'user', text: 'First.' }] };
      const plainNext = { ...plainRoot, turn_id: 'v2', entries: [{ id: 'u-v2', role: 'user', text: 'Second.' }] };
      const root = await memory.ingest('demo', plainRoot);
      const next = await memory.ingest('demo', plainNext);
      const rootRetry = await memory.ingest('demo', { ...plainRoot, lineage_root: true });
      const nextRetry = await memory.ingest('demo', { ...plainNext, parent_turn_id: 'v1' });
      const read = await memory.show('demo', { kind: 'following', turn: root.id });
      assert.deepEqual([rootRetry.id, rootRetry.replayed, nextRetry.id, nextRetry.replayed, read.turns.length, read.lineage],
        [root.id, true, next.id, true, 0, 'unknown']);
    });
    await check('turn_by_key reports exactly the candidate keys that name stored turns, in this scope only', async () => {
      const read = await memory.show('demo', { kind: 'turn_by_key', source: 'integration-fixture', conversation_id: 'upgrade', turn_ids: ['missing', 'v2', 'v1'] });
      const foreign = await memory.show('foreign', { kind: 'turn_by_key', source: 'integration-fixture', conversation_id: 'upgrade', turn_ids: ['v1'] });
      assert.deepEqual([read.found.map(row => row.turn_id), foreign.found.length], [['v2', 'v1'], 0]);
    });
    await check('a changed source text is still a conflict even with lineage added', async () => {
      await assert.rejects(memory.ingest('demo', { source: 'integration-fixture', conversation_id: 'upgrade', turn_id: 'v1', lineage_root: true,
        entries: [{ id: 'u-v1', role: 'user', text: 'Rewritten.' }] }), { code: 'source_identity_conflict' });
    });
    await check('an envelope without the new lineage field keeps its identity on replay', async () => {
      const plain = { source: 'integration-fixture', conversation_id: 'plain', turn_id: 'p1', entries: [{ id: 'u-p1', role: 'user', text: 'Plain turn.' }] };
      const once = await memory.ingest('demo', plain);
      const again = await memory.ingest('demo', plain);
      assert.deepEqual([again.id, again.replayed], [once.id, true]);
    });
    await check('a cyclic relationship graph terminates', async () => {
      await memory.enrich('demo', { records: [], relations: [{ id: 'cycle', type: 'depends_on', from: 'old-decision', to: 'new-decision', attribution: 'fixture', evidence: [span(oldSource, oldInput)] }] });
      const recalled = await memory.recall('demo', { query: 'blue', limit: 1 });
      assert.equal(recalled.bundles[0].relations.length, 3);
    });
    await check('output budget omission never claims complete relationship context', async () => {
      const recalled = await memory.recall('demo', { query: 'blue', max_chars: 256 });
      assert.deepEqual([recalled.status, recalled.bundles.length, recalled.relationship_context_complete, recalled.budget_omitted > 0], ['budget_limited', 0, false, true]);
    });
    await check('configured model failure preserves lexical recall and reports degradation', async () => {
      modelDown = true;
      const source = await memory.ingest('demo', turn('outage', 'Outage safety keeps this exact source.'));
      const recalled = await memory.recall('demo', { query: 'Outage', limit: 1 });
      assert.deepEqual([source.retained, source.indexing.status, recalled.status, recalled.bundles.length], [true, 'unavailable', 'degraded', 1]);
      modelDown = false;
    });
    await check('index retries complete embeddings without another source occurrence', async () => {
      const before = (await memory.status('demo')).turns;
      const result = await memory.index('demo');
      const after = await memory.status('demo');
      assert.deepEqual([result.status, after.unindexed, after.turns], ['ready', 0, before]);
    });
    const attemptInput = turn('attempt', 'I ran the demonstration check. It passed. Should we run another?');
    const attemptSource = await memory.ingest('demo', attemptInput);
    const attemptEvidence = [span(attemptSource, attemptInput)];
    const typedRecord = (id, kind) => ({ id, kind, text: kind, status: 'observed', attribution: 'fixture', evidence: attemptEvidence });
    const outcomeEdge = (id, from, to) => ({ id, type: 'outcome_of', from, to, attribution: 'fixture', evidence: attemptEvidence });
    await check('new outcome cannot use a new question as its referent', async () => {
      await assert.rejects(memory.enrich('demo', { records: [typedRecord('bad-outcome', 'outcome'), typedRecord('new-question', 'question')],
        relations: [outcomeEdge('bad-new', 'bad-outcome', 'new-question')] }), { code: 'invalid_outcome_relation' });
      await assert.rejects(memory.show('demo', { kind: 'record', id: 'bad-outcome' }), { code: 'not_found' });
    });
    await check('outcome can refer to a new action and replay against its stored referent', async () => {
      const outcome = typedRecord('good-outcome', 'outcome');
      await memory.enrich('demo', { records: [outcome, typedRecord('good-action', 'action'), typedRecord('existing-question', 'question')],
        relations: [outcomeEdge('good-new', 'good-outcome', 'good-action')] });
      const replay = await memory.enrich('demo', { records: [outcome], relations: [] });
      assert.deepEqual(replay.records, ['good-outcome']);
    });
    await check('new outcome cannot use an existing question as its referent', async () => {
      await assert.rejects(memory.enrich('demo', { records: [typedRecord('bad-existing-outcome', 'outcome')],
        relations: [outcomeEdge('bad-existing', 'bad-existing-outcome', 'existing-question')] }), { code: 'invalid_outcome_relation' });
    });
    await check('relation-only enrichment enforces an action target', async () => {
      await assert.rejects(memory.enrich('demo', { records: [],
        relations: [outcomeEdge('bad-target', 'good-outcome', 'existing-question')] }), { code: 'invalid_outcome_relation' });
    });
    await check('relation-only enrichment enforces an outcome source', async () => {
      await assert.rejects(memory.enrich('demo', { records: [],
        relations: [outcomeEdge('bad-source', 'existing-question', 'good-action')] }), { code: 'invalid_outcome_relation' });
    });
    await check('relation-only enrichment accepts existing outcome and action endpoints', async () => {
      const result = await memory.enrich('demo', { records: [], relations: [outcomeEdge('good-existing', 'good-outcome', 'good-action')] });
      assert.deepEqual(result.relations, ['good-existing']);
    });
    await check('CLI init, ingest, enrich, recall and show work across fresh processes', async () => {
      const configPath = join(scratch, 'cli-config.json');
      await writeFile(configPath, JSON.stringify({ neo4j: database, scopes: { read: ['cli'], write: ['cli'] } }), { mode: 0o600 });
      const run = async (command, input) => {
        const args = ['bin/memory.mjs', command, '--config', configPath, '--scope', 'cli'];
        if (input) {
          const path = join(scratch, `${command}.json`);
          await writeFile(path, JSON.stringify(input));
          args.push('--input', path);
        }
        return JSON.parse((await exec(process.execPath, args, { timeout: 30000, maxBuffer: 4_000_000 })).stdout);
      };
      await run('init');
      const input = turn('cli', 'CLI preserves unabridged evidence.');
      const source = await run('ingest', input);
      await run('enrich', { records: [{ ...record('cli-record', source, input), kind: 'observation', status: 'observed' }], relations: [] });
      const recalled = await run('recall', { query: 'unabridged' });
      const grouped = await run('recall', { query: 'unabridged', mode: 'evidence_advice', group: 'conversation' });
      const shown = await run('show', { kind: 'turn', id: source.id });
      assert.deepEqual([recalled.ok, recalled.bundles.length > 0, shown.turn.entries[0].text, grouped.ok, grouped.mode, grouped.mode_contract,
        grouped.units[0].key, grouped.pool_truncated, fiveChannels.map(name => typeof grouped.channels[name].admitted_conversations)],
      [true, true, input.entries[0].text, true, 'evidence_advice', contracts.evidence_advice,
        { scope: 'cli', source: input.source, conversation_id: input.conversation_id }, 0, ['number', 'number', 'number', 'undefined', 'undefined']]);
    });
    if (process.env.SOURCE_MEMORY_REAL_EMBEDDING_URL) {
      await check('a real local embedding endpoint indexes and recalls by meaning', async () => {
        const real = new Memory({ neo4j: database, scopes: { read: ['real'], write: ['real'] },
          embedding: { url: process.env.SOURCE_MEMORY_REAL_EMBEDDING_URL,
            model: process.env.SOURCE_MEMORY_REAL_EMBEDDING_MODEL ?? 'embeddinggemma', dimensions: 768, timeout_ms: 60000 } });
        try {
          await real.init('real');
          const target = await real.ingest('real', turn('real-1', 'We postponed the product launch because the payment provider failed certification.'));
          await real.ingest('real', turn('real-2', 'The office plants need watering on Fridays.'));
          const recalled = await real.recall('real', { query: 'Why was the release delayed?', limit: 2 });
          const vector = recalled.bundles.find(bundle => bundle.match.channels.some(channel => channel.channel === 'chunk_vector'));
          assert.deepEqual([recalled.channels.chunk_vector.status, vector?.source?.id], ['ready', target.id]);
        } finally { await real.close(); }
      });
    }
    return results;
  } finally {
    await memory.close();
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
  }
}
