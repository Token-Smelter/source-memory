import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest, MemoryError } from '../src/core.mjs';
import { embeddingIdentity } from '../src/models.mjs';
import { readGgufTokenizer, RENDER_CONTRACT, sentencePiece } from '../src/tokenizer.mjs';
import { apply, inverse, readSnapshot, REPAIR_CONTRACT, stage, writeOnce } from '../src/one-turn-repair.mjs';
import { fictionalVocabulary, ggufTokenizerFile } from './helpers/gguf-fixture.mjs';

const words = count => Array.from({ length: count }, () => 'abcd').join(' ');
const BUDGET = { max_pieces: 64, max_seconds: 60 };

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
  return { dir, config: { embedding, scopes: { read: ['fixture'], write: ['fixture'] } }, verified, counter: sentencePiece(spec) };
}

// A hand-built frozen record: one target chunk whose text is 2,500 one-token words starting at offset 100 of its entry.
function frozenRecord(key) {
  const text = words(2500);
  const state = { labels: ['SMChunk', 'SMNfixture'], properties: {
    uid: { type: 'STRING', value: 'chunk_old' }, scope: { type: 'STRING', value: 'fixture' }, turn_uid: { type: 'STRING', value: 'turn_1' },
    entry_id: { type: 'STRING', value: 'e1' }, role: { type: 'STRING', value: 'assistant' }, ordinal: { type: 'INTEGER', value: '4' },
    start: { type: 'FLOAT', value: 100 }, end: { type: 'FLOAT', value: 100 + text.length }, text: { type: 'STRING', value: text },
    embedding_oversized_cap: { type: 'INTEGER', value: '8192' } } };
  const frozen = { contract: REPAIR_CONTRACT, store: { system: 'neo4j', database_id: 'fixture', database: 'neo4j' }, scope: 'fixture',
    turn_uid: 'turn_1', embedding_key: key, ordinal_ceiling: 7, preimage: { store: { system: 'neo4j', database_id: 'fixture', database: 'neo4j' },
      turn_digest: 't', targets: [], siblings_digest: 's',
      fingerprint: { turns: 1, chunks: 5, chunks_without_current_vector: 1, records: 0, records_without_current_vector: 0, relations: 0 } },
    targets: [{ uid: 'chunk_old', state }] };
  return { ...frozen, frozen_digest: digest(canonical(frozen)) };
}

const counting = counter => async (endpoint, body) => ({ model: body.model, embeddings: [[1, 2]], prompt_eval_count: counter.count(body.input) });

test('stage re-derives the target to exact coverage under the cap and embeds each piece alone with an exact served count', async t => {
  const { config, verified, counter } = await fixture(t);
  const key = embeddingIdentity(config.embedding);
  const frozen = frozenRecord(key);
  const calls = [];
  const request = async (endpoint, body) => { calls.push({ endpoint, body }); return counting(counter)(endpoint, body); };
  const plan = await stage({ frozen, config, verified, budget: BUDGET, request });
  const pieces = plan.replacements[0].nodes;
  assert.ok(pieces.length >= 3);
  assert.ok(calls.every(call => call.endpoint.endsWith('/api/embed') && call.body.truncate === false && typeof call.body.input === 'string'));
  const text = frozen.targets[0].state.properties.text.value;
  let reached = 100;
  for (const [part, piece] of pieces.entries()) {
    const props = piece.state.properties;
    assert.ok(props.start.value <= reached, 'no hole');
    reached = Math.max(reached, props.end.value);
    assert.equal(text.slice(props.start.value - 100, props.end.value - 100), props.text.value, 'offsets are into the original entry');
    assert.ok(counter.count(props.text.value) <= 1920);
    assert.deepEqual([props.ordinal, props.repair_part.value, props.repair_of.value, props.embedding_key.value],
      [{ type: 'FLOAT', value: 8 + part }, part, 'chunk_old', key], 'new unique integer ordinals above the ceiling');
    assert.equal(props.embedding_oversized_cap, undefined, 'markers of the old row are not copied');
  }
  assert.equal(reached, 100 + text.length, 'the pieces end where the target ended');
  assert.equal(new Set(pieces.map(piece => piece.uid)).size, pieces.length);
  assert.equal(plan.postimage.fingerprint.chunks, 5 - 1 + pieces.length);
  const { plan_digest: planDigest, ...body } = plan;
  assert.equal(planDigest, digest(canonical(body)));
  // A served count that differs from the local count stops the stage; nothing is retried.
  let tries = 0;
  await assert.rejects(stage({ frozen, config, verified, budget: BUDGET,
    request: async (endpoint, b) => { tries++; return { model: b.model, embeddings: [[1, 2]], prompt_eval_count: 1 }; } }), { code: 'repair_count_mismatch' });
  assert.equal(tries, 1);
});

test('stage refuses before sending any text when the budget, frozen record, key, tokenizer, transport or cap is wrong', async t => {
  const { config, verified } = await fixture(t);
  const key = embeddingIdentity(config.embedding);
  const request = async () => { throw new Error('must not embed'); };
  const cases = [
    [{ frozen: frozenRecord(key), budget: { max_pieces: 2, max_seconds: 60 } }, 'repair_budget_exceeded'],
    [{ frozen: frozenRecord(key), budget: undefined }, 'invalid_input'],
    [{ frozen: { ...frozenRecord(key), scope: 'other' } }, 'repair_frozen_invalid'],
    [{ frozen: frozenRecord('f'.repeat(64)) }, 'repair_key_mismatch'],
    [{ frozen: frozenRecord(key), verified: {} }, 'repair_tokenizer_unverified'],
    [{ frozen: frozenRecord(key), config: { ...config, embedding: { ...config.embedding, ollama_transport: undefined } } }, 'repair_transport_required'],
    [{ frozen: frozenRecord(key), config: { ...config, embedding: { ...config.embedding, chunk_token_cap: 2000 } } }, 'repair_treatment_mismatch'],
  ];
  for (const [input, code] of cases) {
    await assert.rejects(stage({ config, verified, budget: BUDGET, request, ...input }), { code }, code);
  }
});

test('apply and inverse refuse a tampered plan or another treatment before opening any session', async t => {
  const { config, verified, counter } = await fixture(t);
  const plan = await stage({ frozen: frozenRecord(embeddingIdentity(config.embedding)), config, verified, budget: BUDGET, request: counting(counter) });
  const noWrites = { session: () => { throw new Error('must not open a session'); } };
  for (const step of [apply, inverse]) {
    await assert.rejects(step({ driver: noWrites, database: 'neo4j', config, verified, plan: { ...plan, policy_digest: 'x' } }), { code: 'repair_plan_invalid' });
    await assert.rejects(step({ driver: noWrites, database: 'neo4j', verified, plan,
      config: { ...config, embedding: { ...config.embedding, dimensions: 3 } } }), { code: 'repair_treatment_mismatch' });
  }
});

// A fake driver whose transaction and session can each be made to fail at one point.
function fakeDriver({ work = 'ok', commit = 'ok', rollback = 'ok', close = 'ok' } = {}) {
  const fail = when => async () => { if (when === 'fail') throw new Error('fault'); };
  const tx = { run: async () => { if (work === 'refuse') throw new MemoryError('repair_preimage_changed'); return { records: [] }; },
    commit: fail(commit), rollback: fail(rollback) };
  return { session: () => ({ beginTransaction: () => tx, close: fail(close) }) };
}

test('one write records commit, rollback and cleanup dispositions independently, and never claims an unacknowledged rollback', async () => {
  const work = tx => tx.run('RETURN 1');
  const cases = [
    [{}, { outcome: 'committed', cleanup: 'ok' }],
    [{ close: 'fail' }, { outcome: 'committed', cleanup: 'failed' }],
    [{ commit: 'fail' }, { outcome: 'unknown', cleanup: 'ok' }],
    [{ commit: 'fail', close: 'fail' }, { outcome: 'unknown', cleanup: 'failed' }],
    [{ work: 'refuse' }, { outcome: 'rolled_back', error: 'repair_preimage_changed', cleanup: 'ok' }],
    [{ work: 'refuse', rollback: 'fail' }, { outcome: 'rollback_unconfirmed', error: 'repair_preimage_changed', cleanup: 'ok' }],
  ];
  for (const [faults, expected] of cases) assert.deepEqual(await writeOnce(fakeDriver(faults), 'neo4j', work), expected, JSON.stringify(faults));
});

test('the snapshot refuses a property it could not restore exactly, before reading chunk content', async () => {
  const record = fields => ({ get: name => fields[name] });
  const tx = turn => ({ run: async query => {
    if (query.includes('db.info')) return { records: [record({ id: 'store', name: 'neo4j' })] };
    if (query.includes('SMTurn {uid') && !query.includes('SM_HAS_CHUNK')) return { records: [record({ labels: ['SMTurn'], typed: [turn] })] };
    throw new Error('must not read further');
  } });
  await assert.rejects(readSnapshot(tx({ k: 'span', t: 'DURATION NOT NULL', v: 'P1D' }), 'fixture', 'turn_1', 'key'), { code: 'repair_unsupported_property' });
  await assert.rejects(readSnapshot(tx({ k: 'weight', t: 'FLOAT NOT NULL', v: Number.NaN }), 'fixture', 'turn_1', 'key'), { code: 'repair_unsupported_property' });
});

const script = new URL('../scripts/one-turn-repair.mjs', import.meta.url).pathname;
const invoke = argv => new Promise(resolve => execFile(process.execPath, [script, ...argv], (error, stdout, stderr) =>
  resolve({ code: error?.code ?? 0, stdout, stderr })));

test('the command refuses an unknown step or a duplicate, missing or unknown option before reading anything', async () => {
  for (const argv of [['repair'], ['apply', '--config', 'c', '--plan', 'p'], ['reconcile', '--config', 'c', '--plan', 'p', '--plan', 'q'],
    ['reconcile', '--config', 'c', '--plan', 'p', '--force', 'yes'], ['freeze', '--config', 'c', '--scope', 's', '--turn', 't', '--out'],
    ['freeze', '--config', 'c', '--scope', 's', '--turn', 't', '--expected', '4', '--out', 'o']]) {
    const result = await invoke(argv);
    assert.deepEqual([result.code, result.stdout, JSON.parse(result.stderr)], [1, '', { ok: false, error: 'invalid_input' }], argv.join(' '));
  }
});

test('the command refuses an unapproved plan, and any write while an earlier attempt is unsettled, before touching a store', async t => {
  const { dir, config, verified, counter } = await fixture(t);
  const plan = await stage({ frozen: frozenRecord(embeddingIdentity(config.embedding)), config, verified, budget: BUDGET, request: counting(counter) });
  const paths = { config: join(dir, 'config.json'), plan: join(dir, 'plan.json'), log: join(dir, 'attempts.jsonl') };
  // No database is configured: reaching the store would fail differently.
  await writeFile(paths.config, JSON.stringify({ ...config, neo4j: { uri: 'bolt://127.0.0.1:1', auth: 'none' } }));
  await writeFile(paths.plan, JSON.stringify(plan));
  const step = (approved, log = paths.log) => invoke(['apply', '--config', paths.config, '--plan', paths.plan, '--approved-plan', approved,
    '--quiescence-ref', 'owner-ref-1', '--attempt-log', log]);
  assert.deepEqual(JSON.parse((await step('f'.repeat(64))).stderr), { ok: false, error: 'repair_plan_not_approved' });
  await writeFile(paths.log, `${JSON.stringify({ plan_digest: plan.plan_digest, step: 'apply', outcome: 'started' })}\n`);
  assert.deepEqual(JSON.parse((await step(plan.plan_digest)).stderr), { ok: false, error: 'repair_disposition_required' });
  await writeFile(paths.log, `${JSON.stringify({ plan_digest: plan.plan_digest, step: 'apply', outcome: 'unknown' })}\n`);
  assert.deepEqual(JSON.parse((await step(plan.plan_digest)).stderr), { ok: false, error: 'repair_disposition_required' });
  const disposed = await invoke(['dispose', '--plan', paths.plan, '--attempt-log', paths.log, '--state', 'postimage', '--ref', 'owner-ref-2']);
  assert.equal(JSON.parse(disposed.stdout).state, 'postimage');
  const log = (await readFile(paths.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(entry => entry.outcome), ['unknown', 'disposed']);
});
