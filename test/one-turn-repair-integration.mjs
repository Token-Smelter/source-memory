import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Memory } from '../src/memory.mjs';
import { embeddingIdentity } from '../src/models.mjs';
import { readGgufTokenizer, RENDER_CONTRACT, sentencePiece } from '../src/tokenizer.mjs';
import { apply, classify, freeze, inverse, readSnapshot, reconcile, stage } from '../src/one-turn-repair.mjs';
import { fictionalVocabulary, ggufTokenizerFile } from './helpers/gguf-fixture.mjs';

// Disposable rehearsal of the one-turn repair in both directions. Every text, tokenizer and vector is fictional. The three
// targets imitate rows an earlier chunker wrote: over 8,192 bytes, marked oversized, with no vector.
const SCOPE = 'repair-fixture';
const OTHER = 'repair-other';
const words = (count, word = 'abcd') => Array.from({ length: count }, () => word).join(' ');

async function embeddingServer(counter, { miscount = () => false } = {}) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const request = JSON.parse(body);
    const vector = text => [1 + (text.length % 7), 1 + (text.length % 3)];
    if (req.url === '/api/embed') {
      const inputs = Array.isArray(request.input) ? request.input : [request.input];
      const count = inputs.reduce((sum, text) => sum + counter.count(text) + (miscount(inputs[0]) ? 1 : 0), 0);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ model: request.model, embeddings: inputs.map(vector), prompt_eval_count: count }));
    }
    res.end(JSON.stringify({ model: request.model, data: request.input.map((text, index) => ({ index, embedding: vector(text) })) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/embeddings`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function run(driver, query, params = {}) {
  const session = driver.session();
  try { return (await session.run(query, params)).records; } finally { await session.close(); }
}

// Replaces one entry's chunks with three oversized, vectorless rows covering the same spans, as an older chunker left them.
async function plantOversized(driver, turnUid, entryId, text, key) {
  const first = text.indexOf(' ', Math.floor(text.length / 3));
  const second = text.indexOf(' ', Math.floor((2 * text.length) / 3));
  const spans = [[0, first], [first + 1, second], [second + 1, text.length]];
  const [template] = await run(driver, `MATCH (t:SMTurn {uid:$turn})-[:SM_HAS_CHUNK]->(c:SMChunk {entry_id:$entry})
    RETURN labels(c) AS labels, c.role AS role, c.ordinal AS ordinal ORDER BY c.ordinal LIMIT 1`, { turn: turnUid, entry: entryId });
  await run(driver, 'MATCH (t:SMTurn {uid:$turn})-[:SM_HAS_CHUNK]->(c:SMChunk {entry_id:$entry}) DETACH DELETE c', { turn: turnUid, entry: entryId });
  const labels = template.get('labels').map(label => `\`${label}\``).join(':');
  for (const [index, [start, end]] of spans.entries()) {
    assert.ok(Buffer.byteLength(text.slice(start, end)) > 8192, 'each planted target is byte-oversized');
    await run(driver, `MATCH (t:SMTurn {uid:$turn}) CREATE (c:${labels}) SET c.uid=$uid, c.scope=$scope, c.turn_uid=$turn, c.entry_id=$entry,
      c.role=$role, c.ordinal=$ordinal, c.start=$start, c.end=$end, c.text=$text, c.embedding_oversized_key=$key,
      c.embedding_oversized_cap=8192, c.embedding_oversized_text=$text, c.embedding_retry_after=datetime('2026-11-20T10:00:00.123456789Z')
      CREATE (t)-[:SM_HAS_CHUNK]->(c)`, { turn: turnUid, uid: `chunk_planted_${index}`, scope: SCOPE, entry: entryId, role: template.get('role'),
      ordinal: template.get('ordinal') + index, start, end, text: text.slice(start, end), key });
  }
}

export async function runOneTurnRepair(database, scratch) {
  const results = [];
  const check = async (name, fn) => { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); };
  const gguf = join(scratch, 'repair-fiction.gguf');
  await writeFile(gguf, ggufTokenizerFile(fictionalVocabulary(), { context: 4096 }));
  const spec = await readGgufTokenizer(gguf);
  const counter = sentencePiece(spec);
  const blob = `sha256:${createHash('sha256').update(await readFile(gguf)).digest('hex')}`;
  const verified = { [spec.sha256]: { model: 'embeddinggemma', served_blob: blob, render: RENDER_CONTRACT, serving_revision: 'repair-rev-1',
    context: 2048, parity_evidence_sha256: 'e'.repeat(64) } };
  let miscounting = false;
  const server = await embeddingServer(counter, { miscount: () => miscounting });
  const embedding = { url: server.url, model: 'embeddinggemma', dimensions: 2, ollama_context_revision: 'repair-rev-1',
    ollama_transport: 'native_no_truncate', tokenizer: { gguf, sha256: spec.sha256 } };
  const config = { neo4j: database, scopes: { read: [SCOPE, OTHER], write: [SCOPE, OTHER] }, index_on_write: false,
    embedding: { url: server.url, model: 'embeddinggemma', dimensions: 2 } };
  const memory = new Memory(config);
  const driver = memory.store.driver;
  const key = embeddingIdentity(embedding);
  assert.equal(key, embeddingIdentity(config.embedding), 'the repair writes in the scope\'s existing vector space');
  const handles = { driver, database: database.database, store: memory.store };
  const big = `${words(4000)} ${words(2500, 'cd')}`;
  try {
    await memory.init(SCOPE);
    await memory.init(OTHER);
    const ingested = await memory.ingest(SCOPE, { source: 'repair-fixture', conversation_id: 'c', turn_id: 't1', lineage_root: true,
      entries: [{ id: 'e0', role: 'user', text: 'A short fictional preface.' }, { id: 'e1', role: 'assistant', text: big },
        { id: 'e2', role: 'user', text: 'A short fictional postscript about the harbor lantern.' }] });
    const turnUid = ingested.id;
    await memory.enrich(SCOPE, { records: [{ id: 'r1', kind: 'observation', text: 'The postscript mentions a lantern.', attribution: 'fixture',
      evidence: [{ turn: turnUid, entry_id: 'e2', start: 2, end: 30 }] }, { id: 'r2', kind: 'observation', text: 'The long entry repeats.',
      attribution: 'fixture', evidence: [{ turn: turnUid, entry_id: 'e1', start: 0, end: 40 }] }], relations: [] });
    await memory.index(SCOPE, { limit: 2048 });
    await plantOversized(driver, turnUid, 'e1', big, key);
    const recordBefore = await memory.show(SCOPE, { kind: 'record', id: 'r2' });
    let frozen;
    let plan;

    await check('R1 freeze binds exactly the three vectorless oversized rows and refuses any other expectation', async () => {
      await assert.rejects(freeze({ ...handles, scope: SCOPE, turnUid, embeddingKey: key, expectedTargets: 2 }), { code: 'repair_target_changed' });
      frozen = await freeze({ ...handles, scope: SCOPE, turnUid, embeddingKey: key, expectedTargets: 3 });
      assert.equal(frozen.targets.length, 3);
      assert.equal(frozen.preimage.fingerprint.chunks_without_current_vector, 3);
      assert.ok(frozen.targets.every(target => target.state.properties.embedding_retry_after.type === 'ZONED DATETIME'));
    });

    await check('R2 stage splits each target under the cap and embeds each piece alone with an exact served count', async () => {
      miscounting = true;
      await assert.rejects(stage({ frozen, config: { ...config, embedding }, verified }), { code: 'repair_count_mismatch' });
      miscounting = false;
      await assert.rejects(stage({ frozen, config: { ...config, embedding: { ...embedding, ollama_transport: undefined } }, verified }),
        { code: 'repair_transport_required' });
      await assert.rejects(stage({ frozen: { ...frozen, scope: 'tampered' }, config: { ...config, embedding }, verified }), { code: 'repair_frozen_invalid' });
      plan = await stage({ frozen, config: { ...config, embedding }, verified });
      const pieces = plan.replacements.flatMap(item => item.nodes);
      assert.ok(pieces.length > 3);
      for (const piece of pieces) {
        assert.ok(Buffer.byteLength(piece.state.properties.text.value) <= 8192 && counter.count(piece.state.properties.text.value) <= 1920);
        assert.equal(big.slice(piece.state.properties.start.value, piece.state.properties.end.value), piece.state.properties.text.value);
      }
    });

    await check('R3 apply refuses a changed scope, then swaps only the targets and leaves the turn, siblings and citations exact', async () => {
      await memory.ingest(OTHER, { source: 'repair-fixture', conversation_id: 'c', turn_id: 'other', lineage_root: true,
        entries: [{ id: 'x', role: 'user', text: 'Another scope is not part of this fingerprint.' }] });
      await memory.ingest(SCOPE, { source: 'repair-fixture', conversation_id: 'c', turn_id: 't2', lineage_root: true,
        entries: [{ id: 'y', role: 'user', text: 'A concurrent fictional retain.' }] });
      assert.deepEqual(await apply({ ...handles, plan }), { contract: 'source-memory.one-turn-repair/1', step: 'apply', plan_digest: plan.plan_digest,
        outcome: 'rolled_back', error: 'repair_preimage_changed' });
      // The owner restores quiescence and freezes again: the concurrent turn is part of the new preimage.
      await memory.index(SCOPE, { limit: 2048 });
      frozen = await freeze({ ...handles, scope: SCOPE, turnUid, embeddingKey: key, expectedTargets: 3 });
      plan = await stage({ frozen, config: { ...config, embedding }, verified });
      const before = await readSnapshotFor(driver, database, frozen);
      assert.equal((await apply({ ...handles, plan })).outcome, 'committed');
      assert.equal((await reconcile({ ...handles, plan })).state, 'postimage');
      const after = await readSnapshotFor(driver, database, frozen);
      assert.equal(JSON.stringify(after.turn), JSON.stringify(before.turn), 'the turn is byte-identical');
      const kept = chunks => chunks.filter(chunk => !chunk.uid.startsWith('chunk_planted_') && chunk.state.properties.repair_of === undefined);
      assert.equal(JSON.stringify(kept(after.chunks)), JSON.stringify(kept(before.chunks)), 'siblings are byte-identical');
      assert.equal(after.fingerprint.chunks_without_current_vector, 0);
      assert.deepEqual(await memory.show(SCOPE, { kind: 'record', id: 'r2' }), recordBefore, 'citations resolve unchanged');
      const status = await memory.status(SCOPE);
      assert.equal(status.unindexed, 0);
      const recall = await memory.recall(SCOPE, { query: 'cd cd cd', limit: 4 });
      assert.equal(recall.channels.chunk_vector.status, 'ready');
      assert.equal((await apply({ ...handles, plan })).error, 'repair_preimage_changed', 'a second apply is refused, not repeated');
    });

    await check('R4 inverse restores the exact frozen preimage, typed properties included, and refuses when not at the postimage', async () => {
      assert.equal((await inverse({ ...handles, plan })).outcome, 'committed');
      assert.equal((await reconcile({ ...handles, plan })).state, 'preimage');
      const restored = await readSnapshotFor(driver, database, frozen);
      const targets = restored.chunks.filter(chunk => chunk.uid.startsWith('chunk_planted_'));
      assert.deepEqual(targets.map(chunk => chunk.state), frozen.targets.map(target => target.state));
      const types = await run(driver, `MATCH (c:SMChunk {uid:'chunk_planted_0'}) RETURN valueType(c.embedding_retry_after) AS t,
        valueType(c.ordinal) AS o`);
      assert.match(types[0].get('t'), /^ZONED DATETIME/);
      assert.deepEqual(await memory.show(SCOPE, { kind: 'record', id: 'r2' }), recordBefore);
      assert.equal((await inverse({ ...handles, plan })).error, 'repair_postimage_changed');
      // Apply again from the restored preimage works: the inverse is exact enough to replay the same plan.
      assert.equal((await apply({ ...handles, plan })).outcome, 'committed');
      assert.equal((await inverse({ ...handles, plan })).outcome, 'committed');
      assert.equal((await classifyFor(driver, database, plan)), 'preimage');
    });
  } finally {
    await memory.close();
    await server.close();
  }
  return results;
}

async function readSnapshotFor(driver, database, frozen) {
  const session = driver.session({ database: database.database });
  try {
    const tx = session.beginTransaction();
    try { return await readSnapshot(tx, frozen.scope, frozen.turn_uid, frozen.embedding_key); } finally { await tx.rollback(); }
  } finally { await session.close(); }
}

async function classifyFor(driver, database, plan) {
  const session = driver.session({ database: database.database });
  try {
    const tx = session.beginTransaction();
    try { return await classify(tx, plan); } finally { await tx.rollback(); }
  } finally { await session.close(); }
}
