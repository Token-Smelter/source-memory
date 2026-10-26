import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Memory } from '../src/memory.mjs';
import { cosine, identity, indexNames, namespace } from '../src/core.mjs';
import { embeddingIdentity } from '../src/models.mjs';

const exec = promisify(execFile);
const contracts = {
  evidence_advice: 'Evidence advice: prioritizes extracted claims that cite user spans; a cited user span may be a question, so this is not user assertion or authority. May return no relevant history. Omitted material may correct shown claims. Disclosures describe retrieval and selection bounds, not detected corrections. No currentness or completeness guarantee.',
  history_search: 'History search: retained conversations in search rank order. Not an answer to what is current. Omitted or later material may correct shown items. Disclosures describe retrieval and selection bounds, not detected corrections. No currentness or completeness guarantee.',
};

const projectedFollowingTurn = turn => ({ id: turn.id, turn_id: turn.turn_id, occurred_at: turn.occurred_at ?? null,
  entries: turn.entries.map(entry => ({ id: entry.id, role: entry.role, text: entry.text })) });
const canonicalBundle = bundle => ({ ...bundle, match: { ...bundle.match,
  channels: [...bundle.match.channels].sort((a, b) => a.channel.localeCompare(b.channel)) } });
const canonicalRecall = reply => ({ ...reply,
  channels: Object.fromEntries(Object.entries(reply.channels).map(([name, state]) => {
    if (state.vector_index !== 'missing') return [name, state];
    const { vector_index: _index, ...legacy } = state;
    return [name, legacy];
  }).sort(([a], [b]) => a.localeCompare(b))),
  bundles: reply.bundles.map(canonicalBundle),
  ...(reply.units ? { units: reply.units.map(unit => ({ ...unit, seeds: unit.seeds.map(canonicalBundle) })) } : {}) });
function assertStableOrder(reply) {
  assert.deepEqual(Object.keys(reply.channels), Object.keys(reply.channels).sort(), 'availability keys must use stable alphabetical order');
  for (const bundle of reply.bundles) {
    const names = bundle.match.channels.map(trace => trace.channel);
    assert.deepEqual(names, [...names].sort(), 'channel traces must use stable alphabetical order');
  }
}

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
      res.end(JSON.stringify({ model: input.model, data: input.input.map((value, index) => ({ index,
        embedding: input.model === 'native-fixture' ? [1, 0, 0.2] : vector(value) })) }));
    } else {
      const favored = req.url === '/owner-rerank' ? 'B_OWNER_MARKER' : req.url === '/large-rerank' ? 'LARGE_OWNER_MARKER' : null;
      res.end(JSON.stringify({ results: input.documents.map((value, index) => ({ index,
        relevance_score: favored && value.includes(favored) ? 100 : 1 / (index + 1) })) }));
    }
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const url = `http://127.0.0.1:${model.address().port}`;
  const config = { neo4j: database, scopes: { read: ['demo', 'foreign', 'exclusion', 'lexical', 'modes', 'packing', 'follow', 'vector', 'vector-scale', 'no-embedding'], write: ['demo', 'foreign', 'exclusion', 'lexical', 'modes', 'packing', 'follow', 'vector', 'vector-scale', 'no-embedding'] },
    embedding: { url: `${url}/embed`, model: 'fixture-only', dimensions: 3 },
    reranker: { url: `${url}/rerank`, model: 'fixture-only' } };
  const memory = new Memory(config);
  const waitForVectors = async (client, scope) => {
    const deadline = performance.now() + 120000;
    while (performance.now() < deadline) {
      const states = (await client.status(scope)).vector_indexes;
      if (Object.values(states).every(state => state === 'online')) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('private vector indexes did not become online');
  };
  const withoutVectorIndexes = async (scope, action) => {
    const names = indexNames(scope);
    for (const name of [names.vectorChunks, names.vectorRecords]) await memory.store.transaction('write', tx => tx.run(`DROP INDEX ${name} IF EXISTS`));
    try { return await action(); } finally { await memory.init(scope); await waitForVectors(memory, scope); }
  };
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
    await memory.init('follow');
    const nativeConfig = { ...config, embedding: { ...config.embedding, model: 'native-fixture' }, reranker: undefined };
    const native = new Memory(nativeConfig, memory.store);
    const nativeKey = embeddingIdentity(nativeConfig.embedding);
    const queryVector = [1, 0, 0.2];
    const fixtureText = 'Synthetic source.';
    const addVectors = async (scope, category, start, count, vector, modelKey = nativeKey, parents = 200) => {
      const ns = namespace(scope);
      const chunks = [];
      for (let first = start; first < start + count; first += 500) {
        const rows = [];
        for (let index = first; index < Math.min(first + 500, start + count); index += 1) {
          const conversation = `${category}-${index % parents}`;
          const uid = identity('turn', scope, 'vector-fixture', conversation, 'root');
          const body = { source: 'vector-fixture', conversation_id: conversation, turn_id: 'root', parent_turn_id: null,
            lineage_root: true, occurred_at: null, entries: [{ id: 'v', role: 'user', text: fixtureText, occurred_at: null }] };
          const chunk = { uid: identity('chunk', scope, uid, index), scope, turn_uid: uid, ordinal: index,
            entry_id: 'v', role: 'user', start: 0, end: fixtureText.length, text: fixtureText, embedding: vector(index), embedding_key: modelKey };
          chunks.push(chunk);
          rows.push({ parent: { uid, scope, source: body.source, conversation_id: conversation, turn_key: 'root',
            lineage: true, lineage_root: true, chunked: true, body: JSON.stringify(body), text: fixtureText }, chunk });
        }
        await memory.store.transaction('write', tx => tx.run(`UNWIND $rows AS row
          MERGE (t:SMTurn {uid:row.parent.uid}) ON CREATE SET t:${ns}Turn,t += row.parent
          CREATE (c:SMChunk:${ns}Chunk) SET c=row.chunk CREATE (t)-[:SM_HAS_CHUNK]->(c)`, { rows }));
      }
      return chunks;
    };
    await native.init('vector');
    await waitForVectors(native, 'vector');
    const points = await addVectors('vector', 'eligible', 0, 130, index => index >= 128 ? queryVector : [1, index / 8, 0.2]);
    const recordRows = points.map((point, index) => {
      const id = `vector-record-${index}`;
      const body = { id, kind: 'observation', status: 'observed', attribution: 'fixture', text: fixtureText,
        evidence: [{ turn: point.turn_uid, entry_id: 'v', start: 0, end: fixtureText.length }] };
      return { uid: identity('record', 'vector', id), scope: 'vector', record_id: id, text: fixtureText, body: JSON.stringify(body),
        embedding: point.embedding, embedding_key: nativeKey, turn: point.turn_uid };
    });
    await memory.store.transaction('write', tx => tx.run(`UNWIND $rows AS row
      CREATE (r:SMRecord:${namespace('vector')}Record) SET r=row
      WITH r,row MATCH (t:SMTurn {uid:row.turn}) CREATE (r)-[:SM_EVIDENCE]->(t)`, { rows: recordRows }));
    await check('quantization-off native candidate sets and cosine ordering match exact fixture top-k for both kinds', async () => {
      for (const kind of ['chunk', 'record']) {
        const scan = (await memory.store.vectors('vector', nativeKey, 1000, [], kind))
          .map(row => ({ ...row, similarity: cosine(queryVector, row.embedding) }))
          .sort((a, b) => b.similarity - a.similarity || a.uid.localeCompare(b.uid)).slice(0, 4);
        const indexed = await memory.store.indexedVectors('vector', kind, nativeKey, queryVector, 4);
        assert.deepEqual([indexed.nodes.map(row => row.uid), indexed.partial,
          indexed.nodes.every((row, index) => Math.abs(row.similarity - scan[index].similarity) < 0.000001)],
        [scan.map(row => row.uid), false, true]);
      }
    });
    await check('native init is idempotent validates dimensions and creates no vector indexes without embedding configuration', async () => {
      const initialized = await native.init('vector');
      assert.deepEqual(initialized.vector_indexes, { chunk: 'online', record: 'online' });
      const mismatch = new Memory({ ...nativeConfig, embedding: { ...nativeConfig.embedding, dimensions: 4 } }, memory.store);
      await assert.rejects(mismatch.init('vector'), { code: 'vector_index_dimension_mismatch' });
      const unconfigured = new Memory({ ...config, embedding: undefined }, memory.store);
      await unconfigured.init('no-embedding');
      const options = await memory.store.transaction('read', tx => tx.run('SHOW VECTOR INDEXES YIELD name,options WHERE name=$name RETURN options',
        { name: indexNames('vector').vectorChunks }));
      assert.deepEqual([(await native.status('vector')).vector_indexes, (await unconfigured.status('no-embedding')).vector_indexes,
        options.records[0].get('options').indexConfig['vector.quantization.enabled']],
        [{ chunk: 'online', record: 'online' }, { chunk: 'missing', record: 'missing' }, false]);
    });
    await addVectors('vector', 'dominant', 0, 128, () => queryVector, nativeKey, 1);
    await addVectors('vector', 'stale', 0, 64, () => queryVector, 'old-model', 1);
    const vectorExclusion = [{ source: 'vector-fixture', conversation_id: 'dominant-0' }, { source: 'vector-fixture', conversation_id: 'stale-0' }];
    await check('native post-filter rejects other models and excluded neighbours before limit and widens to eligible hits', async () => {
      const result = await memory.store.indexedVectors('vector', 'chunk', nativeKey, queryVector, 4, null, vectorExclusion);
      const grouped = await memory.store.indexedVectors('vector', 'chunk', nativeKey, queryVector, 4, 2, vectorExclusion);
      assert.deepEqual([result.nodes.length, result.nodes.every(row => row.embedding_key === nativeKey && points.some(point => point.uid === row.uid)),
        result.k > 64, result.partial, grouped.hits.length, grouped.admitted_conversations, grouped.exhausted, grouped.partial],
      [4, true, true, false, 4, 4, true, false], 'native vector post-filter and widening must preserve eligible top-k');
    });
    await addVectors('vector', 'blocked', 0, 5000, () => queryVector, nativeKey, 1);
    const cappedExclusion = [...vectorExclusion, { source: 'vector-fixture', conversation_id: 'blocked-0' }];
    await check('native widening cap reports partial rather than claiming an empty complete result', async () => {
      const result = await memory.store.indexedVectors('vector', 'chunk', nativeKey, queryVector, 4, null, cappedExclusion);
      const recalled = await native.recall('vector', { query: 'vectorquery', candidates: 4, exclude_conversations: cappedExclusion });
      assert.deepEqual([result.k, result.partial, result.reason, recalled.channels.chunk_vector.status,
        recalled.channels.chunk_vector.vector_index, recalled.channels.chunk_vector.reason, recalled.channels.chunk_vector.scan_truncated],
      [4096, true, 'vector_overfetch_cap', 'partial', 'online', 'vector_overfetch_cap', false], 'native vector cap must remain partial');
    });
    await check('native scope labels and the in-query scope filter isolate a sibling scope', async () => {
      const foreign = await addVectors('foreign', 'native-sibling', 0, 1, () => queryVector);
      const result = await memory.store.indexedVectors('vector', 'chunk', nativeKey, queryVector, 32);
      assert.deepEqual([result.nodes.length, result.nodes.every(row => row.scope === 'vector' && !foreign.some(point => point.uid === row.uid))], [32, true]);
      const sibling = await memory.store.indexedVectors('foreign', 'chunk', nativeKey, queryVector, 4);
      assert.deepEqual(sibling.nodes.map(row => row.uid), foreign.map(row => row.uid));
    });
    await check('one missing vector index falls back only for that kind and reports its own index state', async () => {
      const names = indexNames('vector');
      await memory.store.transaction('write', tx => tx.run(`DROP INDEX ${names.vectorRecords}`));
      const original = memory.store.vectors;
      const scans = [];
      memory.store.vectors = (...args) => { scans.push(args[4]); return original.apply(memory.store, args); };
      try {
        const reply = await native.recall('vector', { query: 'vectorquery', candidates: 4, exclude_conversations: cappedExclusion });
        assert.deepEqual([scans, reply.channels.chunk_vector.vector_index, reply.channels.record_vector.vector_index,
          reply.channels.record_vector.status, (await native.status('vector')).vector_indexes],
        [['record'], 'online', 'missing', 'ready', { chunk: 'online', record: 'missing' }]);
      } finally { memory.store.vectors = original; await native.init('vector'); await waitForVectors(native, 'vector'); }
    });
    const timings = [];
    const samples = async action => {
      await action();
      const values = [];
      for (let index = 0; index < 5; index += 1) {
        const start = performance.now();
        await action();
        values.push(performance.now() - start);
      }
      return { median_ms: Number([...values].sort((a, b) => a - b)[2].toFixed(3)), samples_ms: values.map(value => Number(value.toFixed(3))) };
    };
    const measure = async count => {
      const scan = await samples(async () => (await memory.store.vectors('vector-scale', nativeKey, count + 1, [], 'chunk'))
        .map(row => ({ ...row, similarity: cosine(queryVector, row.embedding) }))
        .sort((a, b) => b.similarity - a.similarity || a.uid.localeCompare(b.uid)).slice(0, 64));
      const index = await samples(() => memory.store.indexedVectors('vector-scale', 'chunk', nativeKey, queryVector, 64));
      timings.push({ vectors: count, scan, index_quantization_off: index, speedup: Number((scan.median_ms / index.median_ms).toFixed(2)) });
    };
    const scalePoint = index => [Math.cos(index * 0.61803398875), Math.sin(index * 0.61803398875), 0.2];
    const noIndex = new Memory({ ...config, embedding: undefined }, memory.store);
    await noIndex.init('vector-scale');
    await addVectors('vector-scale', 'scale', 0, 10000, scalePoint);
    await native.init('vector-scale');
    await waitForVectors(native, 'vector-scale');
    await measure(10000);
    await memory.store.transaction('write', tx => tx.run(`DROP INDEX ${indexNames('vector-scale').vectorChunks}`));
    await addVectors('vector-scale', 'scale', 10000, 40000, scalePoint);
    await check('a real populating vector index is partial without running native retrieval or fabricating admission fields', async () => {
      const initializing = native.init('vector-scale');
      const original = memory.store.vectorIndexStatus;
      let observed = null;
      try {
        for (let index = 0; index < 300; index += 1) {
          const state = await original.call(memory.store, 'vector-scale', 'chunk', 3);
          if (state === 'populating') { observed = state; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(observed, 'populating');
        // Freeze an actually observed population state so the transition to ONLINE cannot race this assertion.
        memory.store.vectorIndexStatus = (scope, kind, dimensions) => scope === 'vector-scale' && kind === 'chunk'
          ? Promise.resolve(observed) : original.call(memory.store, scope, kind, dimensions);
        const reply = await native.recall('vector-scale', { query: 'scalabilityprobe', group: 'conversation', candidates: 8 });
        assert.deepEqual(reply.channels.chunk_vector, { status: 'partial', vector_index: 'populating', reason: 'vector_index_populating' });
      } finally { memory.store.vectorIndexStatus = original; await initializing; }
    });
    await waitForVectors(native, 'vector-scale');
    await check('more than ten thousand indexed vectors never invoke the scan or become partial from vector_scan_limit', async () => {
      const original = memory.store.vectors;
      memory.store.vectors = () => { throw new Error('online index attempted a brute-force scan'); };
      try {
        const indexed = new Memory({ ...nativeConfig, vector_scan_limit: 2 }, memory.store);
        for (const grouping of [{}, { group: 'conversation' }]) {
          const reply = await indexed.recall('vector-scale', { query: 'scalabilityprobe', candidates: 8, limit: 1, ...grouping });
          assert.deepEqual(['chunk_vector', 'record_vector'].map(name => [reply.channels[name].status, reply.channels[name].vector_index,
            reply.channels[name].scan_truncated]), [['ready', 'online', false], ['ready', 'online', false]]);
          assert.equal(reply.bundles.length > 0, true);
        }
      } finally { memory.store.vectors = original; }
    });
    await measure(50000);
    const scaleIndex = indexNames('vector-scale').vectorChunks;
    await memory.store.transaction('write', tx => tx.run(`DROP INDEX ${scaleIndex}`));
    await memory.store.transaction('write', tx => tx.run(`CREATE VECTOR INDEX ${scaleIndex} FOR (n:${namespace('vector-scale')}Chunk) ON (n.embedding)
      OPTIONS {indexConfig:{\`vector.dimensions\`:3,\`vector.similarity_function\`:'cosine',\`vector.quantization.enabled\`:true}}`));
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (await memory.store.vectorIndexStatus('vector-scale', 'chunk', 3) === 'online') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await memory.store.vectorIndexStatus('vector-scale', 'chunk', 3), 'online');
    timings[1].index_quantization_on = await samples(() => memory.store.indexedVectors('vector-scale', 'chunk', nativeKey, queryVector, 64));
    await memory.store.transaction('write', tx => tx.run(`DROP INDEX ${scaleIndex}`));
    await native.init('vector-scale');
    await waitForVectors(native, 'vector-scale');
    await writeFile('.memory-local/vector-index-latency.json', JSON.stringify({
      fixture: 'private Neo4j 5.26.14; 1536m memory; 2 CPUs; 512m heap; 128m pagecache', dimensions: 3, candidates: 64,
      measurement: 'warm vector retrieval/scoring/top-k only; excludes catalog readiness, corpus counts, fusion and bundle rendering',
      warmups: 1, measured_runs: 5, results: timings,
    }, null, 2));
    console.log(`VECTOR_LATENCY ${JSON.stringify(timings)}`);
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
    await check('missing-index fallback exclusion precedes the shared scan bound and scan truncation remains partial', async () => withoutVectorIndexes('modes', async () => {
      const bounded = new Memory({ ...config, vector_scan_limit: 2 }, memory.store);
      const request = { query: 'admissionneedle', group: 'conversation', candidates: 3 };
      const excluded = await bounded.recall('modes', { ...request, exclude_conversations: excludedFlood });
      const full = await bounded.recall('modes', request);
      assert.deepEqual(['chunk_vector', 'record_vector'].map(name => [excluded.channels[name].status,
        excluded.channels[name].scan_truncated, excluded.channels[name].admitted_conversations, full.channels[name].status, full.channels[name].scan_truncated,
        typeof full.channels[name].admitted_conversations, typeof full.channels[name].exhausted]),
      [['ready', false, 1, 'partial', true, 'number', 'boolean'], ['ready', false, 1, 'partial', true, 'number', 'boolean']],
        'vector exclusion must precede the shared scan cap');
    }));
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
        { group: null }, { group: 'turn' }, { group: ['conversation'] }, { follow: {} }, { mode: 'history_search', follow: {} },
        ...[null, [], false, 'follow', { turns: 0 }, { turns: 17 }, { turns: 1.5 }, { turns: '8' }, { turns: null },
          { bytes: 0 }, { bytes: 65537 }, { bytes: 1.5 }, { bytes: '16384' }, { bytes: null }, { other: true }]
          .map(follow => ({ group: 'conversation', follow })),
        ...[0, 5, 1.5, '2', null, true].map(per_conversation => ({ per_conversation }))]) {
        await assert.rejects(denied.recall('modes', { query: 'q', ...input }), { code: 'invalid_input' });
      }
      await assert.rejects(denied.conversationUnits('not-allowed', [], {}, [], 'q', 1, 256, 1, 0), { code: 'scope_denied' });
    });
    await check('missing-index fallback preserves pinned I1 and PR8 semantics apart from declared ordering and index metadata', async () => withoutVectorIndexes('modes', async () => {
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
      for (const revision of ['5e2dab07c60a75d8bba6e05b2456dac0c409b4f4', 'db13652837284caba2f61489ec73fbaa5a3c6793']) {
        const [baseline, priorStore] = await Promise.all(['memory', 'store'].map(file => exec('git', ['show', `${revision}:src/${file}.mjs`])));
        const path = join(scratch, `${revision}-memory.mjs`);
        const storePath = join(scratch, `${revision}-store.mjs`);
        const imports = source => source.replaceAll("'./core.mjs'", JSON.stringify(new URL('../src/core.mjs', import.meta.url).href))
          .replaceAll("'./models.mjs'", JSON.stringify(new URL('../src/models.mjs', import.meta.url).href))
          .replaceAll("'neo4j-driver'", JSON.stringify(import.meta.resolve('neo4j-driver')));
        await writeFile(storePath, imports(priorStore.stdout), { mode: 0o600 });
        await writeFile(path, imports(baseline.stdout).replaceAll("'./store.mjs'", JSON.stringify(pathToFileURL(storePath).href)), { mode: 0o600 });
        const { Memory: PriorMemory } = await import(pathToFileURL(path).href);
        const { Neo4jStore: PriorStore } = await import(pathToFileURL(storePath).href);
        const original = new PriorStore(database);
        try {
          const old = new PriorMemory(config, cache(original));
          const current = new Memory(config, cache(memory.store));
          const grouping = revision.startsWith('db136') ? { group: 'conversation' } : {};
          for (const request of [{ query: 'admissionneedle', limit: 1, ...grouping }, { query: 'admissionneedle', max_chars: 256, ...grouping },
            { query: 'admissionneedle', exclude_conversations: excludedFlood, ...grouping }]) {
            // Freeze each implementation's own store responses, then normalize only the intentionally changed ordering.
            await old.recall('modes', request);
            await current.recall('modes', request);
            const before = canonicalRecall(await old.recall('modes', request));
            const reply = await current.recall('modes', request);
            assertStableOrder(reply);
            assert.deepEqual(canonicalRecall(reply), before);
            assert.deepEqual([reply.channels.chunk_vector.vector_index, reply.channels.record_vector.vector_index], ['missing', 'missing']);
            for (const unit of reply.units ?? []) assert.equal(Object.hasOwn(unit, 'following'), false);
            if (!request.group) assert.deepEqual(canonicalRecall(await current.recall('modes', { ...request, per_conversation: 4 })), before);
            for (const mode of Object.keys(contracts)) {
              const { mode: echoed, mode_contract, ...rest } = await current.recall('modes', { ...request, mode });
              assert.deepEqual([canonicalRecall(rest), echoed, mode_contract], [before, mode, contracts[mode]]);
            }
          }
        } finally { await original.close(); }
      }
    }));
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
    const followInput = (conversation, id, parent, value) => ({ source: 'follow-fixture', conversation_id: conversation, turn_id: id,
      ...(parent ? { parent_turn_id: parent } : { lineage_root: true }),
      entries: [{ id: `${id}-u`, role: 'user', text: value }] });
    const makeChain = async (conversation, needle, length) => {
      const turns = [];
      for (let index = 0; index <= length; index += 1) {
        const input = { ...followInput(conversation, `${conversation}-${index}`, index ? `${conversation}-${index - 1}` : null,
          index ? `Exact correction ${index}: 🪄 ${conversation}.` : `${needle} retained root`),
          occurred_at: `2026-01-01T00:${String(index).padStart(2, '0')}:00Z` };
        turns.push({ ...input, id: (await plain.ingest('follow', input)).id });
      }
      return turns;
    };
    const within = await makeChain('within', 'withinchainneedle', 4);
    const over = await makeChain('over', 'overchainneedle', 5);
    await plain.enrich('follow', { records: [{ id: 'within-claim', kind: 'observation', text: 'withinchainneedle claim',
      attribution: 'fixture', evidence: [span(within[0], within[0])] }], relations: [] });
    const folded = (query, follow = {}) => plain.recall('follow', { query, group: 'conversation', follow, limit: 4, max_chars: 200000 });
    await check('folded following renders an unrelated long chain through its recorded end with exact projected turns', async () => {
      const reply = await folded('withinchainneedle');
      const standalone = await plain.show('follow', { kind: 'following', turn: within[0].id, limit: 8 });
      const expected = within.slice(1).map(projectedFollowingTurn);
      assert.deepEqual([reply.status, reply.units[0].following, standalone.turns.map(projectedFollowingTurn), standalone.turns[0].parent_turn_id],
        ['ready', [{ after: within[0].id, status: 'recorded_end', bound: null, turns: expected, unlinked_turns: 0 }], expected, within[0].turn_id]);
    });
    await check('folded following reports has_more for an actual over-bound chain and peeks past exact count bounds', async () => {
      const limited = await folded('overchainneedle', { turns: 2, bytes: 65536 });
      const exact = await folded('withinchainneedle', { turns: 4 });
      assert.deepEqual([limited.status, limited.units[0].following, exact.units[0].following[0].status, exact.units[0].following[0].bound],
        ['ready', [{ after: over[0].id, status: 'has_more', bound: 'turns', turns: over.slice(1, 3).map(projectedFollowingTurn), unlinked_turns: 0 }],
          'recorded_end', null], 'folded following must disclose a real turn bound rather than claim recorded_end');
    });
    await check('folded following byte bounds count whole projected UTF-8 turn objects with zero empty-payload overhead', async () => {
      const expected = within.slice(1).map(projectedFollowingTurn);
      const first = Buffer.byteLength(JSON.stringify(expected[0]));
      const all = expected.reduce((bytes, turn) => bytes + Buffer.byteLength(JSON.stringify(turn)), 0);
      const tooSmall = (await folded('withinchainneedle', { bytes: first - 1 })).units[0].following[0];
      const exactFirst = (await folded('withinchainneedle', { bytes: first })).units[0].following[0];
      const tiny = (await folded('withinchainneedle', { bytes: 1 })).units[0].following[0];
      const exactAll = (await folded('withinchainneedle', { turns: 16, bytes: all })).units[0].following[0];
      assert.deepEqual([[tooSmall.status, tooSmall.bound, tooSmall.turns], [exactFirst.status, exactFirst.bound, exactFirst.turns],
        [tiny.status, tiny.bound, tiny.turns], [exactAll.status, exactAll.bound, exactAll.turns]],
      [['has_more', 'bytes', []], ['has_more', 'bytes', expected.slice(0, 1)], ['has_more', 'bytes', []], ['recorded_end', null, expected]],
      'folded following must stop before a whole turn that exceeds its byte bound');
    });
    const branched = await makeChain('branched', 'branchfollowingneedle', 0);
    await plain.ingest('follow', followInput('branched', 'branch-left', branched[0].turn_id, 'First branch.'));
    await plain.ingest('follow', followInput('branched', 'branch-right', branched[0].turn_id, 'Second branch.'));
    const cycleInput = followInput('cycle', 'cycle-a', 'cycle-b', 'cyclefollowingneedle first');
    const cycleA = await plain.ingest('follow', cycleInput);
    const cycleB = await plain.ingest('follow', followInput('cycle', 'cycle-b', 'cycle-a', 'Second cyclic turn.'));
    const unknown = await makeChain('unknown', 'unknownfollowingneedle', 0);
    await plain.ingest('follow', followInput('unknown', 'unknown-gap', 'missing-parent', 'Capture gap.'));
    await check('folded following preserves exact branched cycle and unknown lineage rules with null bounds', async () => {
      const branch = (await folded('branchfollowingneedle')).units[0].following[0];
      const cycle = (await folded('cyclefollowingneedle')).units[0].following[0];
      const gap = (await folded('unknownfollowingneedle')).units[0].following[0];
      assert.deepEqual([[branch.after, branch.status, branch.bound, branch.turns.length, branch.unlinked_turns],
        [cycle.after, cycle.status, cycle.bound, cycle.turns.map(turn => turn.id), cycle.unlinked_turns],
        [gap.after, gap.status, gap.bound, gap.turns.length, gap.unlinked_turns]],
      [[branched[0].id, 'branched', null, 0, 0], [cycleA.id, 'cycle', null, [cycleB.id], 0], [unknown[0].id, 'unknown', null, 0, 1]]);
    });
    await check('following bytes participate in the atomic whole-unit budget without dropping seeds or trimming turns', async () => {
      const wide = await folded('withinchainneedle');
      const unit = wide.units[0];
      const bytes = Buffer.byteLength(JSON.stringify(unit));
      const exact = await plain.recall('follow', { query: 'withinchainneedle', group: 'conversation', follow: {}, max_chars: bytes });
      const short = await plain.recall('follow', { query: 'withinchainneedle', group: 'conversation', follow: {}, max_chars: bytes - 1 });
      const bare = await plain.recall('follow', { query: 'withinchainneedle', group: 'conversation', max_chars: bytes - 1 });
      assert.deepEqual([unit.seeds.length, exact.units[0].seeds.length, exact.units[0].following[0].turns.length,
        short.units.length, short.bundles.length, short.budget_omitted, short.status, short.relationship_context_complete,
        bare.units.length, Object.hasOwn(bare.units[0], 'following')],
      [2, 2, 4, 0, 0, 1, 'budget_limited', false, 1, false], 'unit budgets must include folded following without partial rendering');
    });
    await plain.enrich('follow', { records: [{ id: 'cross-following', kind: 'observation', text: 'Cross-conversation evidence.',
      attribution: 'fixture', evidence: [span(within[0], within[0]), span(over[0], over[0])] }], relations: [] });
    const foreignFollow = await plain.ingest('foreign', followInput('foreign-follow', 'foreign-follow', null, 'Foreign retained root.'));
    const withinKey = { scope: 'follow', source: 'follow-fixture', conversation_id: 'within' };
    const overKey = { ...withinKey, conversation_id: 'over' };
    const batch = { kind: 'units', units: [{ key: overKey, seeds: [
      { kind: 'record', id: 'absent-record-a' }, { kind: 'turn', id: over[0].id }, { kind: 'record', id: 'cross-following' },
      { kind: 'turn', id: 'absent-turn' }, { kind: 'record', id: 'absent-record-z' }, { kind: 'turn', id: foreignFollow.id },
    ] }, { key: withinKey, seeds: [{ kind: 'turn', id: within[0].id }] }], max_nodes: 8, max_hops: 2 };
    await check('show units preserves explicit unit seed and missing order without ranking or adding seeds', async () => {
      const reply = await plain.show('follow', batch);
      const source = await plain.show('follow', { kind: 'bundle', seed: { kind: 'turn', id: over[0].id }, max_nodes: 8, max_hops: 2 });
      assert.deepEqual([reply.kind, reply.units.map(unit => unit.key), reply.units.map(unit => unit.seeds.map(bundle => [bundle.match.kind, bundle.match.id])),
        reply.units.map(unit => unit.missing), reply.units.map(unit => Object.hasOwn(unit, 'following')), reply.units[0].seeds[0]],
      ['units', [overKey, withinKey], [[['turn', over[0].id], ['record', 'cross-following']], [['turn', within[0].id]]],
        [[{ kind: 'record', id: 'absent-record-a' }, { kind: 'turn', id: 'absent-turn' }, { kind: 'record', id: 'absent-record-z' },
          { kind: 'turn', id: foreignFollow.id }], []], [false, false], source.bundle]);
    });
    await check('show units folds every cited root in uid order including cross-conversation record evidence', async () => {
      const reply = await plain.show('follow', { ...batch, follow: {} });
      const roots = [within[0].id, over[0].id].sort();
      assert.deepEqual(reply.units.map(unit => unit.following.map(read => [read.after, read.status, read.bound, read.unlinked_turns])),
        Array.from({ length: 2 }, () => roots.map(after => [after, 'recorded_end', null, 0])));
    });
    await check('show units validates batch caps follow bounds and caller scope before storage access', async () => {
      const denied = new Memory({ scopes: config.scopes }, new Proxy({}, { get: () => { throw new Error('storage touched'); } }));
      const unit = { key: withinKey, seeds: [] };
      for (const input of [{ units: null }, { units: Array(5).fill(unit) },
        { units: [{ ...unit, seeds: Array(21).fill({ kind: 'turn', id: 'missing' }) }] },
        { units: [unit], follow: null }, { units: [unit], follow: { bytes: 0 } }, { units: [unit], follow: { turns: 17 } }]) {
        await assert.rejects(denied.show('follow', { kind: 'units', ...input }), { code: 'invalid_input' });
      }
      await assert.rejects(denied.show('follow', { kind: 'units', units: [
        { ...unit, seeds: [{ kind: 'turn', id: within[0].id }] }, { ...unit, key: { ...withinKey, scope: 'foreign' } },
      ] }), { code: 'scope_denied' });
      const missing = Array.from({ length: 20 }, (_, index) => ({ kind: 'turn', id: `missing-${index}` }));
      const maximum = await plain.show('follow', { kind: 'units', units: [{ key: withinKey, seeds: missing }] });
      assert.deepEqual([maximum.units[0].missing, (await denied.show('follow', { kind: 'units', units: [] })).units], [missing, []]);
    });
    const cacheA = await makeChain('a-cache', 'cache-a-root', 0);
    const cacheB = await makeChain('b-cache', 'cache-b-root', 0);
    const cacheZ = await makeChain('z-cache', 'cache-z-root', 1);
    await plain.enrich('follow', { records: [
      { id: 'cache-a', kind: 'observation', text: 'cachefollowingneedle', attribution: 'fixture', evidence: [span(cacheA[0], cacheA[0]), span(cacheZ[0], cacheZ[0])] },
      { id: 'cache-b', kind: 'observation', text: 'cachefollowingneedle', attribution: 'fixture', evidence: [span(cacheB[0], cacheB[0]), span(cacheZ[0], cacheZ[0])] },
    ], relations: [] });
    await check('folded following is computed once per cited root per request and carried by every unit that cites it', async () => {
      const original = memory.store.unlinkedTurns;
      let reads = 0;
      memory.store.unlinkedTurns = (...args) => {
        if (args[1].id === cacheZ[0].id) reads += 1;
        return original.apply(memory.store, args);
      };
      try {
        const request = { query: 'cachefollowingneedle', group: 'conversation', follow: {}, max_chars: 200000 };
        const reply = await plain.recall('follow', request);
        const first = reads;
        await plain.recall('follow', request);
        const second = reads;
        const units = reply.units.map(unit => ({ key: unit.key, seeds: unit.seeds.map(bundle => ({ kind: bundle.match.kind, id: bundle.match.id })) }));
        reads = 0;
        const recheck = await plain.show('follow', { kind: 'units', units, follow: {} });
        assert.deepEqual([reply.units.length, reply.units.map(unit => unit.following.filter(read => read.after === cacheZ[0].id).length),
          first, second, recheck.units.map(unit => unit.following.filter(read => read.after === cacheZ[0].id).length), reads],
        [2, [1, 1], 1, 2, [1, 1], 1]);
      } finally { memory.store.unlinkedTurns = original; }
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
      const followed = await run('recall', { query: 'unabridged', mode: 'history_search', group: 'conversation', follow: {} });
      const checked = await run('show', { kind: 'units', units: [{ key: followed.units[0].key,
        seeds: followed.units[0].seeds.map(bundle => ({ kind: bundle.match.kind, id: bundle.match.id })) }], follow: {} });
      const shown = await run('show', { kind: 'turn', id: source.id });
      const terminal = [{ after: source.id, status: 'recorded_end', bound: null, turns: [], unlinked_turns: 0 }];
      assert.deepEqual([recalled.ok, recalled.bundles.length > 0, shown.turn.entries[0].text, grouped.ok, grouped.mode, grouped.mode_contract,
        grouped.units[0].key, grouped.pool_truncated, fiveChannels.map(name => typeof grouped.channels[name].admitted_conversations),
        followed.units[0].following, checked.kind, checked.units[0].following, checked.units[0].missing],
      [true, true, input.entries[0].text, true, 'evidence_advice', contracts.evidence_advice,
        { scope: 'cli', source: input.source, conversation_id: input.conversation_id }, 0, ['number', 'number', 'number', 'undefined', 'undefined'],
        terminal, 'units', terminal, []]);
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
