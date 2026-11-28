import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Memory } from '../src/memory.mjs';
import { canonical, chunkEntries, digest, indexNames, normalizeTurn } from '../src/core.mjs';
import { evidenceSpansForEntry } from '../src/evidence-spans.mjs';
import { embeddingIdentity } from '../src/models.mjs';
import { readGgufTokenizer, RENDER_CONTRACT, sentencePiece } from '../src/tokenizer.mjs';
import { apply, classify, freeze, inverse, readTurn, reconcile, stage } from '../src/cohort-repair.mjs';
import { fictionalVocabulary, ggufTokenizerFile } from './helpers/gguf-fixture.mjs';

// Disposable rehearsal of the cohort repair in both directions. Every text, tokenizer and vector is fictional. The turns are
// retained without first-retain manifests, as turns were before manifests, and their targets imitate rows an earlier chunker
// wrote: three over 8,192 bytes with no vector in one turn, one over the 2,048-token context with a vector in a second, and
// one between the 1,920-token cap and the context with a vector in a third.
const SCOPE = 'repair-fixture';
const OTHER = 'repair-other';
const BUDGET = { max_pieces: 256, max_seconds: 60 };
const CAPS = { max_rows: 1000, max_text_bytes: 10_000_000, max_pages: 100, page_size: 50, max_seconds: 120, transaction_timeout_ms: 30_000,
  max_turns: 10, max_targets: 20, max_target_bytes: 1_000_000 };
// One fictional token per word and one per space: n words are 2n + 1 tokens and 5n - 1 bytes.
const words = (count, word = 'abcd') => Array.from({ length: count }, () => word).join(' ');

async function embeddingServer(counter, faults) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const request = JSON.parse(body);
    const vector = text => [1 + (text.length % 7), 1 + (text.length % 3)];
    if (req.url === '/api/embed') {
      const input = request.input;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ model: request.model, embeddings: [vector(input)], prompt_eval_count: counter.count(input) + (faults.miscount ? 1 : 0) }));
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

// Replaces one entry's chunks with rows covering the given spans exactly, as an older chunker left them. Without a vector a
// row carries the oversized markers, a large integer and a datetime, so the inverse is tested on values a lossy decoder breaks.
async function plant(driver, scope, turnUid, entryId, text, spans, { prefix, key, vector = null }) {
  const [template] = await run(driver, `MATCH (t:SMTurn {uid:$turn})-[:SM_HAS_CHUNK]->(c:SMChunk {entry_id:$entry})
    RETURN labels(c) AS labels, c.role AS role, c.ordinal AS ordinal ORDER BY c.ordinal LIMIT 1`, { turn: turnUid, entry: entryId });
  await run(driver, 'MATCH (t:SMTurn {uid:$turn})-[:SM_HAS_CHUNK]->(c:SMChunk {entry_id:$entry}) DETACH DELETE c', { turn: turnUid, entry: entryId });
  const labels = template.get('labels').map(label => `\`${label}\``).join(':');
  const extra = vector ? 'c.embedding=$vector, c.embedding_key=$key' : `c.embedding_oversized_key=$key, c.embedding_oversized_cap=8192,
    c.embedding_retry_after=datetime('2026-11-20T10:00:00.123456789Z'), c.legacy_counter=9007199254740993`;
  for (const [index, [start, end]] of spans.entries()) {
    await run(driver, `MATCH (t:SMTurn {uid:$turn}) CREATE (c:${labels}) SET c.uid=$uid, c.scope=$scope, c.turn_uid=$turn, c.entry_id=$entry,
      c.role=$role, c.ordinal=$ordinal, c.start=$start, c.end=$end, c.text=$text, ${extra} CREATE (t)-[:SM_HAS_CHUNK]->(c)`,
    { turn: turnUid, uid: `${prefix}_${index}`, scope, entry: entryId, role: template.get('role'), ordinal: template.get('ordinal') + index,
      start, end, text: text.slice(start, end), key, vector });
  }
}

const readOnlyTx = async (driver, database, work) => {
  const session = driver.session({ database: database.database });
  try {
    const tx = session.beginTransaction();
    try { return await work(tx); } finally { await tx.rollback(); }
  } finally { await session.close(); }
};
const turnsOf = (driver, database, frozen) => readOnlyTx(driver, database, async tx => {
  const out = [];
  for (const turn of frozen.turns) out.push(await readTurn(tx, frozen.scope, turn.turn_uid));
  return out;
});

// A driver whose commit applies and then reports failure, or whose session close fails: lost replies, for real.
function faultyDriver(driver, { loseCommitReply = false, failClose = false }) {
  return {
    session: options => {
      const session = driver.session(options);
      return {
        beginTransaction: config => {
          const tx = session.beginTransaction(config);
          if (!loseCommitReply) return tx;
          return new Proxy(tx, { get: (target, name) => name === 'commit'
            ? async () => { await target.commit(); throw new Error('reply lost'); }
            : typeof target[name] === 'function' ? target[name].bind(target) : target[name] });
        },
        close: async () => { await session.close(); if (failClose) throw new Error('close failed'); },
      };
    },
  };
}

const staged = input => stage({ approvedFrozen: input.frozen?.frozen_digest, ...input });

const replan = (plan, change) => {
  const { frozen_digest: _f, ...frozenBody } = change(structuredClone(plan.frozen));
  const frozen = { ...frozenBody, frozen_digest: digest(canonical(frozenBody)) };
  const { plan_digest: _p, ...body } = { ...plan, frozen, frozen_digest: frozen.frozen_digest };
  return { ...body, plan_digest: digest(canonical(body)) };
};

export async function runCohortRepair(database, scratch) {
  const results = [];
  const check = async (name, fn) => { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); };
  const gguf = join(scratch, 'repair-fiction.gguf');
  await writeFile(gguf, ggufTokenizerFile(fictionalVocabulary(), { context: 4096 }));
  const spec = await readGgufTokenizer(gguf);
  const counter = sentencePiece(spec);
  const blob = `sha256:${createHash('sha256').update(await readFile(gguf)).digest('hex')}`;
  const verified = { [spec.sha256]: { model: 'embeddinggemma', served_blob: blob, render: RENDER_CONTRACT, serving_revision: 'repair-rev-1',
    context: 2048, parity_evidence_sha256: 'e'.repeat(64) } };
  const faults = { miscount: false };
  const server = await embeddingServer(counter, faults);
  const embedding = { url: server.url, model: 'embeddinggemma', dimensions: 2, ollama_context_revision: 'repair-rev-1',
    ollama_transport: 'native_no_truncate', tokenizer: { gguf, sha256: spec.sha256 } };
  const config = { neo4j: database, scopes: { read: [SCOPE, OTHER], write: [SCOPE, OTHER] }, index_on_write: false,
    embedding: { url: server.url, model: 'embeddinggemma', dimensions: 2 } };
  const repairConfig = { ...config, embedding };
  const memory = new Memory(config);
  const driver = memory.store.driver;
  const key = embeddingIdentity(embedding);
  assert.equal(key, embeddingIdentity(config.embedding), 'the repair writes in the scope\'s existing vector space');
  const handles = { driver, database: database.database, expectedStore: await memory.store.identity() };
  const using = { ...handles, config: repairConfig, verified };
  const freezing = (over, input = {}) => freeze({ ...handles, scope: SCOPE, embedding, overTokens: over, caps: CAPS, verified, ...input });
  // Awkward boundaries: combining marks, emoji and CJK inside the long entry.
  const big = `${words(2600)} e\u0301e\u0301 \u{1F469}\u200D\u{1F4BB} ${words(1400)} \u65e5\u672c\u8a9e ${words(2350, 'cd')} quartzlantern ${words(50, 'cd')}`;
  const overContext = `${words(1090)} harborbeacon ${words(9)}`;
  const overCap = words(1000);
  const entries = new Map([['e1', big], ['b1', overContext], ['c1', overCap]]);
  try {
    await memory.init(SCOPE);
    await memory.init(OTHER);
    const legacy = normalizeTurn({ source: 'repair-fixture', conversation_id: 'c', turn_id: 't1', lineage_root: true,
      entries: [{ id: 'e0', role: 'user', text: 'A short fictional preface.' }, { id: 'e1', role: 'assistant', text: big },
        { id: 'e2', role: 'user', text: 'A short fictional postscript about the harbor lantern.' }] });
    const second = normalizeTurn({ source: 'repair-fixture', conversation_id: 'c', turn_id: 't3', lineage_root: true,
      entries: [{ id: 'b1', role: 'assistant', text: overContext }] });
    const third = normalizeTurn({ source: 'repair-fixture', conversation_id: 'c', turn_id: 't4', lineage_root: true,
      entries: [{ id: 'c1', role: 'assistant', text: overCap }] });
    // The store's legacy path: chunks without a policy, so no manifest, as turns retained before manifests.
    const turnUid = (await memory.store.ingest(SCOPE, legacy, chunkEntries(legacy))).id;
    const secondUid = (await memory.store.ingest(SCOPE, second, chunkEntries(second))).id;
    const thirdUid = (await memory.store.ingest(SCOPE, third, chunkEntries(third))).id;
    await memory.enrich(SCOPE, { records: [{ id: 'r1', kind: 'observation', text: 'The postscript mentions a lantern.', attribution: 'fixture',
      evidence: [{ turn: turnUid, entry_id: 'e2', start: 2, end: 30 }] }, { id: 'r2', kind: 'observation', text: 'The long entry repeats.',
      attribution: 'fixture', evidence: [{ turn: turnUid, entry_id: 'e1', start: 0, end: 40 }] }], relations: [] });
    await memory.ingest(SCOPE, { source: 'repair-fixture', conversation_id: 'c', turn_id: 't0', lineage_root: true,
      entries: [{ id: 'z', role: 'user', text: 'An earlier fictional note in the same scope.' }] });
    const manifested = await memory.ingest(OTHER, { source: 'repair-fixture', conversation_id: 'c', turn_id: 'm1', lineage_root: true,
      entries: [{ id: 'x', role: 'user', text: words(1100) }] });
    await memory.index(SCOPE, { limit: 2048 });
    await memory.index(OTHER, { limit: 2048 });
    const first = big.indexOf(' ', Math.floor(big.length / 3));
    const cut = big.indexOf(' ', Math.floor((2 * big.length) / 3));
    await plant(driver, SCOPE, turnUid, 'e1', big, [[0, first], [first + 1, cut], [cut + 1, big.length]], { prefix: 'chunk_planted', key });
    await plant(driver, SCOPE, secondUid, 'b1', overContext, [[0, overContext.length]], { prefix: 'chunk_context', key, vector: [1.0, 2.0] });
    await plant(driver, SCOPE, thirdUid, 'c1', overCap, [[0, overCap.length]], { prefix: 'chunk_cap', key, vector: [2.0, 1.0] });
    const manifestedText = words(1100);
    await plant(driver, OTHER, manifested.id, 'x', manifestedText, [[0, manifestedText.length]], { prefix: 'chunk_other', key, vector: [1.0, 1.0] });
    const recordBefore = await memory.show(SCOPE, { kind: 'record', id: 'r2' });
    let frozen;
    let plan;

    await check('R1 freeze selects by an explicit threshold under caps, binds every target of pre-manifest turns and refuses anything else', async () => {
      await assert.rejects(freezing(2000), { code: 'repair_threshold_required' });
      await assert.rejects(freezing(2048, { expectedStore: { ...handles.expectedStore, database_id: 'another-store' } }), { code: 'repair_store_mismatch' });
      await assert.rejects(freezing(2048, { caps: { ...CAPS, max_turns: 1 } }), { code: 'repair_cap_turns' });
      await assert.rejects(freezing(2048, { caps: { ...CAPS, max_targets: 3 } }), { code: 'repair_cap_targets' });
      await assert.rejects(freezing(2048, { caps: { ...CAPS, max_rows: 5 } }), { code: 'repair_cap_rows' });
      // A stale vector inside both limits is not a target; it is counted for ordinary indexing, apart from absent ones.
      await run(driver, "MATCH (t:SMTurn {turn_key:'t0', scope:$scope})-[:SM_HAS_CHUNK]->(c) SET c.kept_key = c.embedding_key, c.embedding_key = 'stale'", { scope: SCOPE });
      const counted = await freezing(2048);
      assert.deepEqual([counted.discovery.turns, counted.discovery.targets, counted.discovery.targets_by_vector, counted.discovery.vectorless_within_limits],
        [2, 4, { absent: 3, stale: 0, current: 1 }, { absent: 0, stale: 1 }]);
      await run(driver, 'MATCH (c:SMChunk {scope:$scope}) WHERE c.kept_key IS NOT NULL SET c.embedding_key = c.kept_key REMOVE c.kept_key', { scope: SCOPE });
      // A partial layout witness is not a pre-manifest turn.
      await run(driver, 'MATCH (t:SMTurn {uid:$turn}) SET t.chunk_count = 3', { turn: secondUid });
      await assert.rejects(freezing(2048), { code: 'repair_turn_has_manifest' });
      await run(driver, 'MATCH (t:SMTurn {uid:$turn}) REMOVE t.chunk_count', { turn: secondUid });
      // A stated end past the entry would be clamped by a slice; it is refused.
      await run(driver, "MATCH (c:SMChunk {uid:'chunk_planted_2'}) SET c.end = c.end + 5");
      await assert.rejects(freezing(2048), { code: 'repair_target_changed' });
      await run(driver, "MATCH (c:SMChunk {uid:'chunk_planted_2'}) SET c.end = c.end - 5");
      // Negative zero cannot survive the JSON inverse, so a target carrying it is refused.
      await run(driver, "MATCH (c:SMChunk {uid:'chunk_planted_1'}) SET c.weight = -0.0");
      await assert.rejects(freezing(2048), { code: 'repair_unsupported_property' });
      await run(driver, "MATCH (c:SMChunk {uid:'chunk_planted_1'}) REMOVE c.weight");
      // An over-context chunk of a turn retained with a manifest is refused.
      await assert.rejects(freezing(2048, { scope: OTHER }), { code: 'repair_turn_has_manifest' });
      // A chunk linked from a target turn but bound to another scope is refused before its content is read.
      await run(driver, `MATCH (t:SMTurn {uid:$turn}) CREATE (c:SMChunk {uid:'chunk_foreign', scope:$other, turn_uid:$turn, text:'foreign'})
        CREATE (t)-[:SM_HAS_CHUNK]->(c)`, { turn: turnUid, other: OTHER });
      await assert.rejects(freezing(2048), { code: 'repair_target_misbound' });
      await run(driver, "MATCH (c:SMChunk {uid:'chunk_foreign'}) DETACH DELETE c");
      // An edge property could not be restored by the inverse, so a target carrying one is refused.
      await run(driver, "MATCH (:SMTurn)-[r:SM_HAS_CHUNK]->(:SMChunk {uid:'chunk_planted_1'}) SET r.note = 'kept'");
      await assert.rejects(freezing(2048), { code: 'repair_unsupported_link' });
      await run(driver, "MATCH (:SMTurn)-[r:SM_HAS_CHUNK]->(:SMChunk {uid:'chunk_planted_1'}) REMOVE r.note");
      // Under 1,920 the chunk of 2,001 tokens joins: three turns, five targets.
      frozen = await freezing(1920);
      assert.deepEqual([frozen.discovery.turns, frozen.discovery.targets, frozen.discovery.targets_by_vector], [3, 5, { absent: 3, stale: 0, current: 2 }]);
      assert.deepEqual(frozen.turns.map(turn => turn.turn_uid).sort(), [turnUid, secondUid, thirdUid].sort());
      assert.equal(frozen.store.database_id, handles.expectedStore.database_id);
      const target = frozen.turns.find(turn => turn.turn_uid === turnUid).targets[0].state.properties;
      assert.deepEqual([target.legacy_counter, target.embedding_retry_after.type], [{ type: 'INTEGER', value: '9007199254740993' }, 'ZONED DATETIME']);
    });

    await check('R2 stage covers each target exactly under the cap, within budget, with an exact served count per singleton', async () => {
      faults.miscount = true;
      await assert.rejects(staged({ frozen, config: repairConfig, verified, budget: BUDGET }), { code: 'repair_count_mismatch' });
      faults.miscount = false;
      await assert.rejects(staged({ frozen, config: repairConfig, verified, budget: { ...BUDGET, max_pieces: 2 } }), { code: 'repair_piece_cap_exceeded' });
      await assert.rejects(staged({ frozen, config: { ...repairConfig, embedding: { ...embedding, ollama_transport: undefined } }, verified, budget: BUDGET }),
        { code: 'repair_transport_required' });
      await assert.rejects(staged({ frozen, config: { ...repairConfig, embedding: { ...embedding, chunk_token_cap: 2000 } }, verified, budget: BUDGET }),
        { code: 'repair_treatment_mismatch' });
      await assert.rejects(staged({ frozen: { ...frozen, scope: 'tampered' }, config: repairConfig, verified, budget: BUDGET }), { code: 'repair_frozen_invalid' });
      plan = await staged({ frozen, config: repairConfig, verified, budget: BUDGET });
      const targets = frozen.turns.flatMap(turn => turn.targets);
      assert.equal(plan.replacements.length, 5);
      for (const { old_uid: oldUid, nodes } of plan.replacements) {
        const target = targets.find(item => item.uid === oldUid).state.properties;
        const source = entries.get(target.entry_id.value);
        let reached = Number(target.start.value);
        for (const node of nodes) {
          const props = node.state.properties;
          assert.ok(props.start.value <= reached, 'no hole between pieces');
          reached = Math.max(reached, props.end.value);
          assert.equal(source.slice(props.start.value, props.end.value), props.text.value);
          assert.ok(Buffer.byteLength(props.text.value) <= 8192 && counter.count(props.text.value) <= 1920);
        }
        assert.equal(reached, Number(target.end.value));
      }
    });

    await check('R3 apply refuses drift, another store or another treatment, then swaps only the targets with source, citations and retrieval intact', async () => {
      await memory.ingest(SCOPE, { source: 'repair-fixture', conversation_id: 'c', turn_id: 't2', lineage_root: true,
        entries: [{ id: 'y', role: 'user', text: 'A concurrent fictional retain.' }] });
      assert.equal((await apply({ ...using, plan })).error, 'repair_preimage_changed');
      await memory.index(SCOPE, { limit: 2048 });
      frozen = await freezing(1920);
      plan = await staged({ frozen, config: repairConfig, verified, budget: BUDGET });
      const elsewhere = replan(plan, copy => ({ ...copy, store: { ...copy.store, database_id: 'another-store' } }));
      assert.equal((await apply({ ...using, plan: elsewhere })).error, 'repair_store_mismatch');
      assert.equal((await reconcile({ ...handles, plan: elsewhere })).state, 'other_store');
      await assert.rejects(apply({ ...using, plan, config: { ...repairConfig, embedding: { ...embedding, dimensions: 3 } } }), { code: 'repair_treatment_mismatch' });
      // The boundary of the drift check: a same-count change elsewhere in the scope is not detected. Exclusion is external.
      await run(driver, "MATCH (t:SMTurn {turn_key:'t0', scope:$scope})-[:SM_HAS_CHUNK]->(c) SET c.embedding = [9.0, 9.0]", { scope: SCOPE });
      const before = await turnsOf(driver, database, frozen);
      const applied = await apply({ ...using, plan });
      assert.deepEqual([applied.outcome, applied.cleanup], ['committed', 'ok'], JSON.stringify(applied));
      assert.equal((await reconcile({ ...handles, plan })).state, 'postimage');
      const after = await turnsOf(driver, database, frozen);
      const kept = chunks => chunks.filter(chunk => !/^chunk_(planted|context|cap)_/u.test(chunk.uid) && chunk.state.properties.repair_of === undefined);
      for (const [index, turn] of after.entries()) {
        assert.equal(canonical(turn.turn), canonical(before[index].turn), 'each turn is byte-identical');
        assert.equal(canonical(kept(turn.chunks)), canonical(kept(before[index].chunks)), 'siblings are byte-identical');
      }
      assert.equal((await memory.status(SCOPE)).unindexed, 0);
      assert.deepEqual(await memory.show(SCOPE, { kind: 'record', id: 'r2' }), recordBefore, 'citations resolve unchanged');
      // The evidence-span reader accepts the repaired layout: unique integer ordinals and valid offsets for each entry.
      for (const [turn, entry] of [[turnUid, legacy.entries[1]], [secondUid, second.entries[0]], [thirdUid, third.entries[0]]]) {
        const offered = evidenceSpansForEntry(entry, await memory.sourceChunks(SCOPE, turn));
        assert.ok(offered.spans.length > 1 && offered.spans.every(span => entry.text.slice(span.start, span.end).length > 0));
        assert.deepEqual(offered.omissions, []);
      }
      const names = indexNames(SCOPE);
      const states = await run(driver, 'SHOW INDEXES YIELD name, state WHERE name IN $names RETURN name, state', { names: [names.chunks, names.vectorChunks] });
      assert.deepEqual(states.map(row => row.get('state')).sort(), ['ONLINE', 'ONLINE']);
      const recall = await memory.recall(SCOPE, { query: 'quartzlantern harborbeacon', limit: 8 });
      assert.deepEqual([recall.channels.chunk_vector.status, recall.channels.chunk_lexical.status], ['ready', 'ready']);
      // Both indexes return the repaired rows themselves: the lexical index finds the words, the vector index the vector.
      for (const word of ['quartzlantern', 'harborbeacon']) {
        const lexical = await run(driver, 'CALL db.index.fulltext.queryNodes($index, $query) YIELD node RETURN node.repair_of AS of',
          { index: names.chunks, query: word });
        assert.ok(lexical.length > 0 && lexical.every(row => typeof row.get('of') === 'string'), `${word} is found in a repaired row`);
      }
      const piece = plan.replacements.at(-1).nodes.at(-1);
      const vector = await run(driver, `CALL db.index.vector.queryNodes($index, 64, $vector) YIELD node
        WHERE node.uid = $uid RETURN count(node) AS n`, { index: names.vectorChunks, vector: piece.state.properties.embedding.value, uid: piece.uid });
      assert.equal(Number(vector[0].get('n')), 1, 'a repaired vector is in the vector index');
      assert.equal((await apply({ ...using, plan })).error, 'repair_preimage_changed', 'a second apply is refused, not repeated');
    });

    await check('R4 inverse restores the exact preimage, old vectors, large integers and datetimes included, and refuses when not at the postimage', async () => {
      const restored = await inverse({ ...using, plan });
      assert.equal(restored.outcome, 'committed', JSON.stringify(restored));
      assert.equal((await reconcile({ ...handles, plan })).state, 'preimage');
      const native = await run(driver, `MATCH (c:SMChunk {uid:'chunk_planted_0'}) RETURN toString(c.legacy_counter) AS counter,
        toString(c.embedding_retry_after) AS retry, valueType(c.legacy_counter) AS type, COUNT { (c)--() } AS links`);
      assert.deepEqual([native[0].get('counter'), native[0].get('retry'), native[0].get('type'), Number(native[0].get('links'))],
        ['9007199254740993', '2026-11-20T10:00:00.123456789Z', 'INTEGER NOT NULL', 1]);
      const vectors = await run(driver, "MATCH (c:SMChunk {uid:'chunk_context_0'}) RETURN c.embedding AS v, c.embedding_key AS k");
      assert.deepEqual([vectors[0].get('v'), vectors[0].get('k')], [[1, 2], key], 'an old vector comes back exactly');
      const back = await turnsOf(driver, database, frozen);
      for (const [index, turn] of frozen.turns.entries()) {
        const uids = turn.targets.map(target => target.uid);
        assert.deepEqual(back[index].chunks.filter(chunk => uids.includes(chunk.uid)).map(chunk => chunk.state), turn.targets.map(target => target.state));
      }
      assert.deepEqual(await memory.show(SCOPE, { kind: 'record', id: 'r2' }), recordBefore);
      assert.equal((await inverse({ ...using, plan })).error, 'repair_postimage_changed');
    });

    await check('R5 a lost commit reply or a failed cleanup keeps its disposition; reconcile names the side without replaying', async () => {
      const lost = await apply({ ...using, plan, driver: faultyDriver(driver, { loseCommitReply: true }) });
      assert.deepEqual([lost.outcome, lost.cleanup], ['unknown', 'ok']);
      assert.equal((await reconcile({ ...handles, plan })).state, 'postimage', 'the lost commit did apply');
      assert.equal(await readOnlyTx(driver, database, tx => classify(tx, plan)), 'postimage');
      const closing = await inverse({ ...using, plan, driver: faultyDriver(driver, { failClose: true }) });
      assert.deepEqual([closing.outcome, closing.cleanup], ['committed', 'failed'], 'a failed close does not erase a commit');
      assert.equal((await reconcile({ ...handles, plan })).state, 'preimage');
    });
  } finally {
    await memory.close();
    await server.close();
  }
  return results;
}
