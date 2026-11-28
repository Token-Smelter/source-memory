import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import neo4j from 'neo4j-driver';
import { Memory } from '../src/memory.mjs';
import { chunkEntries, digest, identity, normalizeTurn } from '../src/core.mjs';
import { chunkPolicy, LEGACY_POLICY, MANIFEST_CONTRACT, TOKEN_POLICY } from '../src/chunk-policy.mjs';
import { embeddingIdentity } from '../src/models.mjs';
import { countOverContext, neo4jChunkReader } from '../src/over-context-count.mjs';
import { readGgufTokenizer, RENDER_CONTRACT } from '../src/tokenizer.mjs';
import { fictionalVocabulary, ggufTokenizerFile } from './helpers/gguf-fixture.mjs';

// Disposable-store checks for token-capped first retains. Every text, tokenizer and vector here is fictional.
const SCOPES = ['cap', 'cap-gap', 'cap-race', 'cap-legacy', 'cap-history'];
const turn = (id, ...texts) => ({ source: 'cap-fixture', conversation_id: 'c', turn_id: id, lineage_root: true,
  entries: texts.map((text, index) => ({ id: `${id}-${index}`, role: 'user', text })) });
const words = count => Array.from({ length: count }, () => 'abcd').join(' ');

async function embeddingServer() {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const { model, input } = JSON.parse(body);
    res.end(JSON.stringify({ model, data: input.map((text, index) => ({ index, embedding: [1 + text.length % 7, 1] })) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/embeddings`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function turnProperties(driver, uid) {
  const session = driver.session();
  try {
    const result = await session.run(`MATCH (t:SMTurn {uid:$uid}) OPTIONAL MATCH (t)-[:SM_HAS_CHUNK]->(c:SMChunk)
      WITH t, c ORDER BY c.ordinal RETURN properties(t) AS turn, collect(properties(c)) AS chunks`, { uid });
    return { turn: result.records[0].get('turn'), chunks: result.records[0].get('chunks') };
  } finally { await session.close(); }
}

// The manifest is the independent expected set: every row it names exists with its spans and text digest, and nothing else.
function assertManifestMatchesRows(scope, input, stored) {
  const manifest = JSON.parse(stored.turn.chunk_manifest);
  assert.equal(digest(stored.turn.chunk_manifest), stored.turn.chunk_manifest_digest);
  assert.deepEqual([manifest.contract, manifest.scope, manifest.turn_uid, manifest.turn_hash],
    [MANIFEST_CONTRACT, scope, stored.turn.uid, stored.turn.hash]);
  assert.equal(manifest.policy_digest, stored.turn.chunk_policy_digest);
  assert.deepEqual(manifest.chunks.map(row => row.uid), stored.chunks.map(row => row.uid));
  const entries = new Map(normalizeTurn(input).entries.map(entry => [entry.id, entry.text]));
  for (const [index, row] of manifest.chunks.entries()) {
    const chunk = stored.chunks[index];
    assert.deepEqual([row.ordinal, row.entry_id, row.start, row.end], [chunk.ordinal, chunk.entry_id, chunk.start, chunk.end]);
    assert.equal(row.text_sha256, digest(chunk.text));
    assert.equal(chunk.text, entries.get(row.entry_id).slice(row.start, row.end));
    assert.equal(chunk.uid, identity('chunk', scope, stored.turn.uid, row.ordinal));
  }
  assert.equal(stored.turn.chunk_count, manifest.chunks.length);
  assert.equal(stored.turn.chunk_gap_count, manifest.gaps.length);
  return manifest;
}

export async function runChunkCap(database, scratch) {
  const results = [];
  const check = async (name, fn) => { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); };
  const gguf = join(scratch, 'cap-fiction.gguf');
  await writeFile(gguf, ggufTokenizerFile(fictionalVocabulary()));
  const { sha256 } = await readGgufTokenizer(gguf);
  const blob = `sha256:${createHash('sha256').update(await readFile(gguf)).digest('hex')}`;
  const verified = { [sha256]: { model: 'embeddinggemma', served_blob: blob, render: RENDER_CONTRACT, serving_revision: 'cap-rev-1', context: 64,
    parity_evidence_sha256: 'e'.repeat(64) } };
  const server = await embeddingServer();
  const base = { neo4j: database, scopes: { read: SCOPES, write: SCOPES }, index_on_write: false };
  const embedding = { url: server.url, model: 'embeddinggemma', dimensions: 2, ollama_context_revision: 'cap-rev-1' };
  const open = (extra = {}, trusted = verified) => {
    const memory = new Memory({ ...base, embedding: { ...embedding, tokenizer: { gguf, sha256 }, ...extra } });
    memory.verifiedTokenizers = trusted;
    return memory;
  };
  const capped = open({ chunk_token_cap: 21 });
  const driver = capped.store.driver;
  try {
    for (const scope of SCOPES) await capped.init(scope);

    await check('C1 a token-capped first retain writes rows, provenance and a manifest that match exactly', async () => {
      const input = turn('t1', words(40), 'cd');
      const reply = await capped.ingest('cap', input);
      assert.equal(reply.replayed, false);
      const stored = await turnProperties(driver, reply.id);
      const manifest = assertManifestMatchesRows('cap', input, stored);
      assert.equal(JSON.parse(stored.turn.chunk_policy).policy, TOKEN_POLICY);
      assert.equal(stored.turn.chunk_qualification, 'unqualified');
      assert.ok(stored.chunks.length > 1 && stored.chunks.every(chunk => chunk.token_count <= 21 && chunk.chunk_token_cap === 21
        && chunk.tokenizer_sha256 === sha256 && chunk.chunk_qualification === 'unqualified'));
      assert.deepEqual(reply.chunking, { policy_digest: stored.turn.chunk_policy_digest, qualification: 'unqualified',
        chunks: manifest.chunks.length, gaps: 0 });
    });

    await check('C2 a replay under a changed cap and a missing tokenizer returns the first layout and writes nothing', async () => {
      const input = turn('t1', words(40), 'cd');
      const before = await turnProperties(driver, identity('turn', 'cap', 'cap-fixture', 'c', 't1'));
      const moved = join(scratch, 'moved.gguf');
      const elsewhere = open({ chunk_token_cap: 9, tokenizer: { gguf: moved, sha256 } });
      try {
        const reply = await elsewhere.ingest('cap', input);
        assert.equal(reply.replayed, true);
        assert.deepEqual(reply.chunking, { policy_digest: before.turn.chunk_policy_digest, qualification: 'unqualified',
          chunks: before.chunks.length, gaps: 0 });
      } finally { await elsewhere.close(); }
      const after = await turnProperties(driver, before.turn.uid);
      assert.deepEqual(after, before);
    });

    await check('C3 an unusable tokenizer retains the raw turn with typed gaps, and no reader calls the scope ready', async () => {
      const unverified = open({ chunk_token_cap: 21 }, {});
      try {
        const input = turn('g1', 'abcd abcd', '   ', 'cd');
        const reply = await unverified.ingest('cap-gap', input);
        assert.deepEqual(reply.chunking.gaps, 2);
        const stored = await turnProperties(driver, reply.id);
        assert.deepEqual(stored.chunks, []);
        const manifest = assertManifestMatchesRows('cap-gap', input, stored);
        assert.deepEqual(manifest.gaps.map(gap => [gap.entry_id, gap.cause, gap.reason]),
          [['g1-0', 'tokenizer_unavailable', 'unverified'], ['g1-2', 'tokenizer_unavailable', 'unverified']]);
        const index = await capped.index('cap-gap');
        assert.deepEqual([index.status, index.reason, index.derived_gaps], ['unavailable', 'derived_chunk_gaps', 2]);
        const status = await capped.status('cap-gap');
        assert.deepEqual([status.turns, status.chunks, status.unindexed, status.derived_gaps], [1, 0, 0, 2]);
        assert.equal(status.chunking.tokenizer_verified, true);
        const recall = await capped.recall('cap-gap', { query: 'abcd', limit: 4 });
        assert.equal(recall.channels.chunk_vector.status, 'partial');
        assert.equal(recall.channels.chunk_vector.derived_gaps, 2);
      } finally { await unverified.close(); }
    });

    await check('C4 concurrent first writers with different caps leave exactly one layout', async () => {
      const writers = [open({ chunk_token_cap: 21 }), open({ chunk_token_cap: 11 })];
      try {
        const input = turn('r1', words(30));
        const replies = await Promise.all(writers.map(writer => writer.ingest('cap-race', input)));
        assert.deepEqual(replies.map(reply => reply.replayed).sort(), [false, true]);
        assert.equal(replies[0].chunking.policy_digest, replies[1].chunking.policy_digest);
        const stored = await turnProperties(driver, replies[0].id);
        const manifest = assertManifestMatchesRows('cap-race', input, stored);
        assert.equal(new Set(stored.chunks.map(chunk => chunk.chunk_token_cap)).size, 1);
        assert.equal(manifest.policy.token_cap, stored.chunks[0].chunk_token_cap);
      } finally { await Promise.all(writers.map(writer => writer.close())); }
    });

    await check('C5 an unconfigured new turn keeps byte chunking and its reply, and gains only a legacy manifest', async () => {
      const legacy = new Memory({ ...base, embedding });
      try {
        const input = turn('l1', words(300));
        const reply = await legacy.ingest('cap-legacy', input);
        assert.deepEqual(Object.keys(reply).sort(), ['id', 'indexing', 'replayed', 'retained']);
        const stored = await turnProperties(driver, reply.id);
        const manifest = assertManifestMatchesRows('cap-legacy', input, stored);
        assert.equal(manifest.policy.policy, LEGACY_POLICY);
        assert.equal(stored.turn.chunk_qualification, undefined);
        assert.ok(manifest.chunks.every(row => row.token_count === null));
        assert.deepEqual(stored.chunks.map(({ start, end }) => [start, end]),
          chunkEntries(normalizeTurn(input)).map(({ start, end }) => [start, end]));
        assert.ok(stored.chunks.every(chunk => !('token_count' in chunk)));
      } finally { await legacy.close(); }
    });

    await check('C6 a turn retained before manifests stays without one after a token-policy replay', async () => {
      const input = turn('h1', words(20));
      const normalized = normalizeTurn(input);
      await capped.store.ingest('cap-history', normalized, chunkEntries(normalized));
      const uid = identity('turn', 'cap-history', 'cap-fixture', 'c', 'h1');
      const before = await turnProperties(driver, uid);
      assert.equal(before.turn.chunk_manifest, undefined);
      const reply = await capped.ingest('cap-history', input);
      assert.deepEqual([reply.replayed, reply.chunking], [true, undefined]);
      assert.deepEqual(await turnProperties(driver, uid), before);
      const session = driver.session();
      try {
        const count = await session.run('MATCH (t:SMTurn {scope:$scope}) WHERE t.chunk_manifest IS NOT NULL RETURN count(t) AS n', { scope: 'cap-history' });
        assert.equal(neo4j.isInt(count.records[0].get('n')) ? count.records[0].get('n').toNumber() : count.records[0].get('n'), 0);
      } finally { await session.close(); }
    });

    await check('C7 the owner count reads one scope through the store and classifies vectors without exposing rows', async () => {
      const policy = chunkPolicy(capped.config, verified);
      const key = embeddingIdentity(embedding);
      const caps = { max_rows: 100, max_text_bytes: 1_000_000, max_pages: 20, page_size: 2, max_seconds: 60, transaction_timeout_ms: 10_000 };
      const reader = scope => neo4jChunkReader(driver, database.database, scope, key, embedding.dimensions);
      const capped21 = await countOverContext({ policy, reader: reader('cap'), caps });
      assert.equal(capped21.status, 'complete');
      assert.equal(capped21.chunks, capped21.within_cap, 'chunks derived under cap 21 all fit it');
      const before = await countOverContext({ policy, reader: reader('cap-legacy'), caps });
      assert.equal(before.status, 'complete');
      assert.ok(before.chunks > 0 && before.over_context_without_current_vector === before.chunks, 'legacy 256-word chunks exceed context 64');
      await capped.index('cap-legacy');
      const after = await countOverContext({ policy, reader: reader('cap-legacy'), caps });
      assert.deepEqual([after.over_context_with_current_vector, after.over_context_without_current_vector], [before.chunks, 0]);
      assert.ok(!JSON.stringify(after).includes('abcd') && !JSON.stringify(after).includes('chunk_'), 'no text or identifier in the report');
      assert.equal((await countOverContext({ policy, reader: reader('cap-legacy'), caps: { ...caps, max_pages: 1 } })).reason, 'cap_pages');
      const session = driver.session();
      try {
        // A numeric vector under another key is stale, whatever its dimensions.
        await session.run(`MATCH (c:SMChunk {scope:'cap-legacy'}) WITH c ORDER BY c.uid LIMIT 1 SET c.embedding=[1.0, 2.0, 3.0], c.embedding_key='stale-key'`);
        const stale = await countOverContext({ policy, reader: reader('cap-legacy'), caps });
        assert.deepEqual([stale.status, stale.over_context_with_current_vector, stale.over_context_without_current_vector], ['complete', before.chunks - 1, 1]);
        // A wrong-dimension vector at the current key is refused, not counted as current.
        await session.run(`MATCH (c:SMChunk {scope:'cap-legacy'}) WITH c ORDER BY c.uid LIMIT 1 SET c.embedding_key=$key`, { key });
      } finally { await session.close(); }
      assert.deepEqual(await countOverContext({ policy, reader: reader('cap-legacy'), caps }),
        { contract: 'source-memory.over-context-count/1', status: 'incomplete', reason: 'read_failed' });
      // The database classifier itself: the largest finite double is a current vector, as the writer accepts it; NaN and
      // infinities are refused. Values are bound as parameters so the floats are exact.
      const setFirst = vector => {
        const write = driver.session();
        return write.run(`MATCH (c:SMChunk {scope:'cap-legacy'}) WITH c ORDER BY c.uid LIMIT 1 SET c.embedding=$vector, c.embedding_key=$key`,
          { vector, key }).finally(() => write.close());
      };
      await setFirst([Number.MAX_VALUE, 0]);
      const extreme = await countOverContext({ policy, reader: reader('cap-legacy'), caps });
      assert.deepEqual([extreme.status, extreme.over_context_with_current_vector], ['complete', before.chunks]);
      await setFirst([-Number.MAX_VALUE, 0]);
      assert.equal((await countOverContext({ policy, reader: reader('cap-legacy'), caps })).status, 'complete');
      for (const vector of [[Number.POSITIVE_INFINITY, 0], [Number.NEGATIVE_INFINITY, 1], [Number.NaN, 1], [0, 0]]) {
        await setFirst(vector);
        assert.equal((await countOverContext({ policy, reader: reader('cap-legacy'), caps })).reason, 'read_failed', String(vector));
      }
    });
  } finally {
    await capped.close();
    await server.close();
    await rm(gguf, { force: true });
  }
  return results;
}
