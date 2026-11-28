import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest } from '../src/core.mjs';
import { embeddingIdentity } from '../src/models.mjs';
import { readGgufTokenizer, RENDER_CONTRACT, sentencePiece } from '../src/tokenizer.mjs';
import { apply, inverse, readSnapshot, REPAIR_CONTRACT, stage } from '../src/one-turn-repair.mjs';
import { fictionalVocabulary, ggufTokenizerFile } from './helpers/gguf-fixture.mjs';

const words = count => Array.from({ length: count }, () => 'abcd').join(' ');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'source-memory-repair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gguf = join(dir, 'fiction.gguf');
  await writeFile(gguf, ggufTokenizerFile(fictionalVocabulary(), { context: 4096 }));
  const spec = await readGgufTokenizer(gguf);
  const blob = `sha256:${createHash('sha256').update(await readFile(gguf)).digest('hex')}`;
  const verified = { [spec.sha256]: { model: 'embeddinggemma', served_blob: blob, render: RENDER_CONTRACT, serving_revision: 'rev-1',
    context: 2048, parity_evidence_sha256: 'e'.repeat(64) } };
  const embedding = { url: 'http://127.0.0.1:9/v1/embeddings', model: 'embeddinggemma', dimensions: 2, ollama_context_revision: 'rev-1',
    ollama_transport: 'native_no_truncate', tokenizer: { gguf, sha256: spec.sha256 } };
  return { config: { embedding }, verified, counter: sentencePiece(spec) };
}

// A hand-built frozen record: one target chunk whose text is 2,500 one-token words starting at offset 100 of its entry.
function frozenRecord(key) {
  const text = words(2500);
  const state = { labels: ['SMChunk', 'SMNfixture'], properties: {
    uid: { type: 'STRING', value: 'chunk_old' }, scope: { type: 'STRING', value: 'fixture' }, turn_uid: { type: 'STRING', value: 'turn_1' },
    entry_id: { type: 'STRING', value: 'e1' }, role: { type: 'STRING', value: 'assistant' }, ordinal: { type: 'INTEGER', value: 4 },
    start: { type: 'FLOAT', value: 100 }, end: { type: 'FLOAT', value: 100 + text.length }, text: { type: 'STRING', value: text },
    embedding_oversized_cap: { type: 'INTEGER', value: 8192 } } };
  const frozen = { contract: REPAIR_CONTRACT, store: { system: 'neo4j', database_id: 'fixture', database: 'neo4j' }, scope: 'fixture',
    turn_uid: 'turn_1', embedding_key: key, preimage: { turn_digest: 't', targets: [], siblings_digest: 's',
      fingerprint: { turns: 1, chunks: 5, chunks_without_current_vector: 1, records: 0, records_without_current_vector: 0, relations: 0 } },
    targets: [{ uid: 'chunk_old', state }] };
  return { ...frozen, frozen_digest: digest(canonical(frozen)) };
}

test('stage re-derives the target under the cap, embeds each piece alone, and requires the served count to match', async t => {
  const { config, verified, counter } = await fixture(t);
  const key = embeddingIdentity(config.embedding);
  const frozen = frozenRecord(key);
  const calls = [];
  const request = async (endpoint, body) => {
    calls.push({ endpoint, body });
    return { model: body.model, embeddings: [[1, 2]], prompt_eval_count: counter.count(body.input) };
  };
  const plan = await stage({ frozen, config, verified, request });
  const pieces = plan.replacements[0].nodes;
  assert.ok(pieces.length >= 3);
  assert.ok(calls.every(call => call.endpoint.endsWith('/api/embed') && call.body.truncate === false && typeof call.body.input === 'string'));
  const text = frozen.targets[0].state.properties.text.value;
  for (const [part, piece] of pieces.entries()) {
    const props = piece.state.properties;
    assert.equal(text.slice(props.start.value - 100, props.end.value - 100), props.text.value, 'offsets are into the original entry');
    assert.ok(counter.count(props.text.value) <= 1920);
    assert.deepEqual([props.ordinal, props.repair_part.value, props.repair_of.value, props.embedding_key.value],
      [{ type: 'INTEGER', value: 4 }, part, 'chunk_old', key]);
    assert.notEqual(piece.uid, 'chunk_old');
    assert.equal(props.embedding_oversized_cap, undefined, 'markers of the old row are not copied');
  }
  assert.equal(new Set(pieces.map(piece => piece.uid)).size, pieces.length);
  assert.equal(plan.postimage.fingerprint.chunks, 5 - 1 + pieces.length);
  assert.equal(plan.postimage.fingerprint.chunks_without_current_vector, 0);
  const { plan_digest: planDigest, ...body } = plan;
  assert.equal(planDigest, digest(canonical(body)));
  // A served count that differs from the local count stops the stage; nothing is retried.
  let tries = 0;
  await assert.rejects(stage({ frozen, config, verified, request: async (endpoint, body) => { tries++; return { model: body.model, embeddings: [[1, 2]], prompt_eval_count: 1 }; } }),
    { code: 'repair_count_mismatch' });
  assert.equal(tries, 1);
});

test('stage refuses a tampered frozen record, another vector key, an unverified tokenizer or the compatible transport', async t => {
  const { config, verified } = await fixture(t);
  const key = embeddingIdentity(config.embedding);
  const request = async () => { throw new Error('must not embed'); };
  await assert.rejects(stage({ frozen: { ...frozenRecord(key), scope: 'other' }, config, verified, request }), { code: 'repair_frozen_invalid' });
  await assert.rejects(stage({ frozen: frozenRecord('f'.repeat(64)), config, verified, request }), { code: 'repair_key_mismatch' });
  await assert.rejects(stage({ frozen: frozenRecord(key), config, verified: {}, request }), { code: 'repair_tokenizer_unverified' });
  const compat = { embedding: { ...config.embedding, ollama_transport: undefined } };
  await assert.rejects(stage({ frozen: frozenRecord(embeddingIdentity(compat.embedding)), config: compat, verified, request }),
    { code: 'repair_transport_required' });
});

test('apply and inverse refuse a tampered plan or another store before any write', async t => {
  const { config, verified, counter } = await fixture(t);
  const key = embeddingIdentity(config.embedding);
  const request = async (endpoint, body) => ({ model: body.model, embeddings: [[1, 2]], prompt_eval_count: counter.count(body.input) });
  const plan = await stage({ frozen: frozenRecord(key), config, verified, request });
  const noWrites = { session: () => { throw new Error('must not open a session'); } };
  const store = { identity: async () => plan.frozen.store };
  for (const step of [apply, inverse]) {
    await assert.rejects(step({ driver: noWrites, database: 'neo4j', store, plan: { ...plan, policy_digest: 'x' } }), { code: 'repair_plan_invalid' });
    await assert.rejects(step({ driver: noWrites, database: 'neo4j', store: { identity: async () => ({ ...plan.frozen.store, database_id: 'other' }) }, plan }),
      { code: 'repair_store_mismatch' });
  }
});

test('the snapshot refuses a property type it could not restore exactly', async () => {
  const record = fields => ({ get: name => fields[name] });
  const tx = { run: async query => ({ records: query.includes('SMTurn {uid') && !query.includes('SM_HAS_CHUNK')
    ? [record({ labels: ['SMTurn'], typed: [{ k: 'span', t: 'DURATION NOT NULL', v: 'P1D' }] })] : [] }) };
  await assert.rejects(readSnapshot(tx, 'fixture', 'turn_1', 'key'), { code: 'repair_unsupported_property' });
});

test('the command refuses an unknown step or a duplicate, missing or unknown option before reading anything', async () => {
  const script = new URL('../scripts/one-turn-repair.mjs', import.meta.url).pathname;
  const invoke = argv => new Promise(resolve => execFile(process.execPath, [script, ...argv], (error, stdout, stderr) =>
    resolve({ code: error?.code ?? 0, stdout, stderr })));
  for (const argv of [['repair'], ['apply', '--config', 'c', '--plan', 'p'], ['apply', '--config', 'c', '--plan', 'p', '--plan', 'q'],
    ['reconcile', '--config', 'c', '--plan', 'p', '--force', 'yes'], ['freeze', '--config', 'c', '--scope', 's', '--turn', 't', '--expected', '3', '--out']]) {
    const result = await invoke(argv);
    assert.deepEqual([result.code, result.stdout, JSON.parse(result.stderr)], [1, '', { ok: false, error: 'invalid_input' }], argv.join(' '));
  }
});
