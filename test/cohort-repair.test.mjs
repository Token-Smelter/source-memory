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
import { apply, classify, freeze, inverse, readTurn, REPAIR_CONTRACT, repairTreatment, stage, writeOnce } from '../src/cohort-repair.mjs';
import { fictionalVocabulary, ggufTokenizerFile } from './helpers/gguf-fixture.mjs';

// One fictional token per word and one per space: n words are 2n + 1 tokens with BOS and EOS, and 5n - 1 bytes.
const words = count => Array.from({ length: count }, () => 'abcd').join(' ');
const BUDGET = { max_pieces: 64, max_seconds: 60 };
const CAPS = { max_rows: 100, max_text_bytes: 1_000_000, max_pages: 10, page_size: 2, max_seconds: 60, transaction_timeout_ms: 5000,
  max_turns: 5, max_targets: 10, max_target_bytes: 100_000 };
const STORE = { system: 'neo4j', database_id: 'fixture', database: 'neo4j' };

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
  const config = { embedding, scopes: { read: ['fixture'], write: ['fixture'] } };
  return { dir, config, verified, counter: sentencePiece(spec), policyDigest: repairTreatment(config, verified).policy.digest };
}

// A hand-built frozen record: two turns, one target each. The first target's text is 2,500 words starting at offset 100.
function frozenRecord(key, policyDigest) {
  const target = (turn, uid, count) => {
    const text = words(count);
    return { uid, tokens: 2 * count + 1, bytes: Buffer.byteLength(text), vector: 'absent', state: { labels: ['SMChunk', 'SMNfixture'], properties: {
      uid: { type: 'STRING', value: uid }, scope: { type: 'STRING', value: 'fixture' }, turn_uid: { type: 'STRING', value: turn },
      entry_id: { type: 'STRING', value: 'e1' }, role: { type: 'STRING', value: 'assistant' }, ordinal: { type: 'INTEGER', value: '4' },
      start: { type: 'FLOAT', value: 100 }, end: { type: 'FLOAT', value: 100 + text.length }, text: { type: 'STRING', value: text },
      embedding_oversized_cap: { type: 'INTEGER', value: '8192' } } } };
  };
  const turn = (uid, ceiling, targets) => ({ turn_uid: uid, ordinal_ceiling: ceiling,
    preimage: { turn_digest: `t-${uid}`, chunks: [], siblings_digest: `s-${uid}` }, targets });
  const frozen = { contract: REPAIR_CONTRACT, store: STORE, scope: 'fixture', embedding_key: key,
    selection: { over_tokens: 2048, byte_cap: 8192, policy_digest: policyDigest, tokenizer_sha256: 'x' }, caps: CAPS,
    discovery: { rows: 6, turns: 2, targets: 2, targets_by_vector: { absent: 2, stale: 0, current: 0 }, vectorless_within_limits: { absent: 0, stale: 0 } },
    fingerprint: { turns: 2, chunks: 6, chunks_without_current_vector: 2, records: 0, records_without_current_vector: 0, relations: 0 },
    turns: [turn('turn_1', 7, [target('turn_1', 'chunk_old', 2500)]), turn('turn_2', 2, [target('turn_2', 'chunk_two', 1100)])] };
  return { ...frozen, frozen_digest: digest(canonical(frozen)) };
}

// The owner approves exactly the frozen record staged; tests that need another approval pass `approvedFrozen` themselves.
const staged = input => stage({ approvedFrozen: input.frozen?.frozen_digest, ...input });

const counting = counter => async (endpoint, body) => ({ model: body.model, embeddings: [[1, 2]], prompt_eval_count: counter.count(body.input) });

test('stage re-derives every target to exact coverage under the cap and embeds each piece alone with an exact served count', async t => {
  const { config, verified, counter, policyDigest } = await fixture(t);
  const key = embeddingIdentity(config.embedding);
  const frozen = frozenRecord(key, policyDigest);
  const calls = [];
  const request = async (endpoint, body) => { calls.push({ endpoint, body }); return counting(counter)(endpoint, body); };
  const plan = await staged({ frozen, config, verified, budget: BUDGET, request });
  assert.deepEqual(plan.replacements.map(item => [item.turn_uid, item.old_uid]), [['turn_1', 'chunk_old'], ['turn_2', 'chunk_two']]);
  const pieces = plan.replacements[0].nodes;
  assert.ok(pieces.length >= 3);
  assert.ok(calls.every(call => call.endpoint.endsWith('/api/embed') && call.body.truncate === false && typeof call.body.input === 'string'));
  const text = frozen.turns[0].targets[0].state.properties.text.value;
  let reached = 100;
  for (const [part, piece] of pieces.entries()) {
    const props = piece.state.properties;
    assert.ok(props.start.value <= reached, 'no hole');
    reached = Math.max(reached, props.end.value);
    assert.equal(text.slice(props.start.value - 100, props.end.value - 100), props.text.value, 'offsets are into the original entry');
    assert.ok(counter.count(props.text.value) <= 1920);
    assert.deepEqual([props.ordinal, props.repair_part.value, props.repair_of.value, props.embedding_key.value],
      [{ type: 'FLOAT', value: 8 + part }, part, 'chunk_old', key], 'new unique integer ordinals above the turn ceiling');
    assert.equal(props.embedding_oversized_cap, undefined, 'markers of the old row are not copied');
  }
  assert.equal(reached, 100 + text.length, 'the pieces end where the target ended');
  assert.equal(plan.replacements[1].nodes[0].state.properties.ordinal.value, 3, 'each turn numbers above its own ceiling');
  const created = plan.replacements.flatMap(item => item.nodes);
  assert.equal(new Set(created.map(piece => piece.uid)).size, created.length);
  assert.deepEqual([plan.postimage.fingerprint.chunks, plan.postimage.fingerprint.chunks_without_current_vector], [6 - 2 + created.length, 0]);
  const { plan_digest: planDigest, ...body } = plan;
  assert.equal(planDigest, digest(canonical(body)));
  // A served count that differs from the local count stops the stage; nothing is retried.
  let tries = 0;
  await assert.rejects(staged({ frozen, config, verified, budget: BUDGET,
    request: async (endpoint, b) => { tries++; return { model: b.model, embeddings: [[1, 2]], prompt_eval_count: 1 }; } }), { code: 'repair_count_mismatch' });
  assert.equal(tries, 1);
});

test('stage refuses before sending any text when the budget, frozen record, key, tokenizer, transport or cap is wrong', async t => {
  const { config, verified, policyDigest } = await fixture(t);
  const key = embeddingIdentity(config.embedding);
  const request = async () => { throw new Error('must not embed'); };
  const cases = [
    [{ frozen: frozenRecord(key, policyDigest), budget: { max_pieces: 2, max_seconds: 60 } }, 'repair_piece_cap_exceeded'],
    [{ frozen: frozenRecord(key, policyDigest), approvedFrozen: 'f'.repeat(64) }, 'repair_frozen_not_approved'],
    [{ frozen: frozenRecord(key, policyDigest), budget: undefined }, 'invalid_input'],
    [{ frozen: { ...frozenRecord(key, policyDigest), scope: 'other' } }, 'repair_frozen_invalid'],
    [{ frozen: frozenRecord('f'.repeat(64), policyDigest) }, 'repair_key_mismatch'],
    [{ frozen: frozenRecord(key, 'other-policy') }, 'repair_treatment_mismatch'],
    [{ frozen: frozenRecord(key, policyDigest), verified: {} }, 'repair_tokenizer_unverified'],
    [{ frozen: frozenRecord(key, policyDigest), config: { ...config, embedding: { ...config.embedding, ollama_transport: undefined } } }, 'repair_transport_required'],
    [{ frozen: frozenRecord(key, policyDigest), config: { ...config, embedding: { ...config.embedding, chunk_token_cap: 2000 } } }, 'repair_treatment_mismatch'],
  ];
  for (const [input, code] of cases) {
    await assert.rejects(staged({ config, verified, budget: BUDGET, request, ...input }), { code }, code);
  }
});

test('apply and inverse refuse a tampered plan or another treatment before opening any session', async t => {
  const { config, verified, counter, policyDigest } = await fixture(t);
  const plan = await staged({ frozen: frozenRecord(embeddingIdentity(config.embedding), policyDigest), config, verified, budget: BUDGET, request: counting(counter) });
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

test('a turn read refuses a property it could not restore exactly, before reading chunk content', async () => {
  const record = fields => ({ get: name => fields[name] });
  const tx = turn => ({ run: async query => {
    if (query.includes('SMTurn {uid') && !query.includes('SM_HAS_CHUNK')) return { records: [record({ labels: ['SMTurn'], typed: [turn] })] };
    throw new Error('must not read further');
  } });
  await assert.rejects(readTurn(tx({ k: 'span', t: 'DURATION NOT NULL', v: 'P1D' }), 'fixture', 'turn_1'), { code: 'repair_unsupported_property' });
  await assert.rejects(readTurn(tx({ k: 'weight', t: 'FLOAT NOT NULL', v: Number.NaN }), 'fixture', 'turn_1'), { code: 'repair_unsupported_property' });
});

// A fake store of chunk rows for discovery. Any turn read throws, so a refusal shows no turn content was read.
function discoveryDriver(rows, { total = rows.length } = {}) {
  const queries = [];
  const record = fields => ({ get: name => fields[name] });
  const tx = { run: async (query, params) => {
    queries.push(query);
    if (query.includes('db.info')) return { records: [record({ id: 'fixture', name: 'neo4j' })] };
    if (query.includes('RETURN count(c) AS n')) return { records: [record({ n: total })] };
    if (query.includes('ORDER BY c.uid LIMIT')) {
      const page = rows.filter(row => params.after === null || row.uid > params.after).slice(0, Number(params.limit));
      return { records: page.map(record) };
    }
    throw new Error('must not read a turn');
  }, isOpen: () => false, rollback: async () => {} };
  return { queries, driver: { session: () => ({ beginTransaction: () => tx, close: async () => {} }) } };
}

test('freeze discovers targets by an explicit threshold and refuses every cap before reading any turn', async t => {
  const { config, verified } = await fixture(t);
  const row = (uid, turn, count, vector = 'absent') => ({ uid, turn_uid: turn, text: words(count), vector });
  // 1,000 words: 2,001 tokens and 4,999 bytes, over the cap but within the context and the byte limit.
  const rows = [row('c1', 't1', 1000), row('c2', 't1', 10), row('c3', 't2', 1100, 'current'), row('c4', 't3', 2500, 'stale'), row('c5', 't3', 10, 'stale')];
  const run = (overTokens, caps = CAPS, data = rows, options) => {
    const fake = discoveryDriver(data, options);
    return { fake, promise: freeze({ driver: fake.driver, database: 'neo4j', expectedStore: { database_id: 'fixture', database: 'neo4j' }, scope: 'fixture',
      embedding: config.embedding, overTokens, caps, verified }) };
  };
  // A threshold is required, and only the two named ones are accepted.
  for (const over of [undefined, 2000, '2048']) await assert.rejects(run(over).promise, { code: 'repair_threshold_required' }, String(over));
  // Under 2,048: c3 (2,201 tokens, current vector) and c4 (over the bytes too, stale) in t2 and t3; c1 is within the context.
  // Under 1,920: c1 joins in t1. Discovery reached the turn reads in both cases, so the refusal is the turn read itself.
  for (const [over, turns] of [[2048, 2], [1920, 3]]) {
    const { fake, promise } = run(over);
    await assert.rejects(promise, /must not read a turn/u);
    assert.equal(fake.queries.filter(query => query.includes('ORDER BY c.uid LIMIT')).length, 3, `paged in threes of two (${over})`);
    assert.ok(turns);
  }
  const caps = [
    [{ ...CAPS, max_rows: 4 }, 'repair_cap_rows'], [{ ...CAPS, max_pages: 2 }, 'repair_cap_pages'],
    [{ ...CAPS, max_text_bytes: 5000 }, 'repair_cap_text_bytes'], [{ ...CAPS, max_targets: 1 }, 'repair_cap_targets'],
    [{ ...CAPS, max_turns: 1 }, 'repair_cap_turns'], [{ ...CAPS, max_target_bytes: 6000 }, 'repair_cap_target_bytes'],
  ];
  for (const [input, code] of caps) {
    const { fake, promise } = run(2048, input);
    await assert.rejects(promise, { code }, code);
    assert.ok(fake.queries.every(query => !query.includes('SMTurn')), `no turn read (${code})`);
  }
  // A row whose parent turn is missing, a vector that is neither absent, stale nor current, or a total that moved refuses.
  for (const [data, options, code] of [[[{ ...rows[0], turn_uid: null }], {}, 'repair_target_misbound'],
    [[{ ...rows[0], vector: 'invalid' }], {}, 'repair_unsupported_vector'], [rows, { total: 6 }, 'repair_target_changed'],
    [[row('c2', 't1', 10)], {}, 'repair_no_targets']]) {
    await assert.rejects(run(2048, CAPS, data, options).promise, { code }, code);
  }
});

const script = new URL('../scripts/cohort-repair.mjs', import.meta.url).pathname;
const invoke = argv => new Promise(resolve => execFile(process.execPath, [script, ...argv], (error, stdout, stderr) =>
  resolve({ code: error?.code ?? 0, stdout, stderr })));

test('the command refuses an unknown step or a duplicate, missing or unknown option before reading anything', async () => {
  for (const argv of [['repair'], ['apply', '--config', 'c', '--plan', 'p'], ['reconcile', '--config', 'c', '--plan', 'p', '--plan', 'q'],
    ['reconcile', '--config', 'c', '--plan', 'p', '--force', 'yes'], ['freeze', '--config', 'c', '--scope', 's', '--out'],
    ['freeze', '--config', 'c', '--store-id', 'i', '--scope', 's', '--caps', 'k', '--out', 'o'],
    // A person does not name turns; the freeze selects them.
    ['freeze', '--config', 'c', '--store-id', 'i', '--scope', 's', '--over', '2048', '--caps', 'k', '--turn', 't', '--out', 'o']]) {
    const result = await invoke(argv);
    assert.deepEqual([result.code, result.stdout, JSON.parse(result.stderr)], [1, '', { ok: false, error: 'invalid_input' }], argv.join(' '));
  }
});

test('the plan-bound journal admits one attempt at a time and holds every write until an unsettled attempt is disposed', async t => {
  const { dir, config, verified, counter, policyDigest } = await fixture(t);
  const plan = await staged({ frozen: frozenRecord(embeddingIdentity(config.embedding), policyDigest), config, verified, budget: BUDGET, request: counting(counter) });
  const journalDir = join(dir, 'journal');
  const paths = { config: join(dir, 'config.json'), plan: join(dir, 'plan.json'), copy: join(dir, 'copy-of-plan.json') };
  const journal = join(journalDir, plan.plan_digest);
  // The built-in trust table does not verify the fictional tokenizer, so each attempt is refused before any write.
  await writeFile(paths.config, JSON.stringify({ ...config, repair_journal_dir: journalDir, neo4j: { uri: 'bolt://127.0.0.1:1', auth: 'none' } }));
  await writeFile(paths.plan, JSON.stringify(plan));
  await writeFile(paths.copy, JSON.stringify(plan));
  const step = (approved, planPath = paths.plan) => invoke(['apply', '--config', paths.config, '--plan', planPath, '--approved-plan', approved,
    '--custody-ref', 'owner-custody-1', '--quiescence-ref', 'owner-quiet-1']);
  const dispose = attempt => invoke(['dispose', '--config', paths.config, '--plan', paths.plan, '--attempt', String(attempt),
    '--state', 'preimage', '--ref', 'owner-ref-2']);
  assert.deepEqual(JSON.parse((await step('f'.repeat(64))).stderr), { ok: false, error: 'repair_plan_not_approved' });
  assert.deepEqual(JSON.parse((await step(plan.plan_digest)).stderr), { ok: false, error: 'repair_tokenizer_unverified' });
  const settled = JSON.parse(await readFile(join(journal, 'attempt-1.outcome.json'), 'utf8'));
  assert.equal(settled.outcome, 'refused', 'a refusal before any write settles its attempt');
  // A crash after an attempt started leaves it without an outcome; it holds every later write, from any copy of the plan.
  await writeFile(join(journal, 'attempt-2.json'), '{}');
  assert.deepEqual(JSON.parse((await step(plan.plan_digest)).stderr), { ok: false, error: 'repair_disposition_required' });
  assert.deepEqual(JSON.parse((await step(plan.plan_digest, paths.copy)).stderr), { ok: false, error: 'repair_disposition_required' },
    'the journal is keyed by the plan, not the file path');
  assert.deepEqual(JSON.parse((await dispose(1)).stderr), { ok: false, error: 'repair_attempt_not_unsettled' }, 'a settled attempt');
  assert.deepEqual(JSON.parse((await dispose(9)).stderr), { ok: false, error: 'repair_attempt_not_unsettled' }, 'no such attempt');
  assert.equal(JSON.parse((await dispose(2)).stdout).attempt, 2);
  assert.deepEqual(JSON.parse((await dispose(2)).stderr), { ok: false, error: 'repair_attempt_not_unsettled' }, 'disposed only once');
  await step(plan.plan_digest);
  assert.ok(JSON.parse(await readFile(join(journal, 'attempt-3.json'), 'utf8')).attempt === 3, 'the next attempt starts after the disposition');
  // Records that are malformed, or bound to another attempt or plan, settle nothing: each of these holds the next write.
  const other = 'e'.repeat(64);
  const holds = [
    { 'attempt-4.json': '{}', 'attempt-4.disposed.json': '{}' },
    { 'attempt-4.json': '{}', 'attempt-4.disposed.json': JSON.stringify({ plan_digest: plan.plan_digest, attempt: 3, state: 'preimage', ref: 'r' }) },
    { 'attempt-4.json': '{}', 'attempt-4.disposed.json': JSON.stringify({ plan_digest: other, attempt: 4, state: 'preimage', ref: 'r' }) },
    { 'attempt-4.json': '{}', 'attempt-4.disposed.json': JSON.stringify({ plan_digest: plan.plan_digest, attempt: 4, state: 'gone', ref: 'r' }) },
    { 'attempt-4.json': JSON.stringify({ plan_digest: plan.plan_digest, attempt: 4, step: 'apply' }),
      'attempt-4.outcome.json': JSON.stringify({ plan_digest: plan.plan_digest, attempt: 3, outcome: 'committed' }) },
    { 'attempt-4.json': JSON.stringify({ plan_digest: other, attempt: 4, step: 'apply' }),
      'attempt-4.outcome.json': JSON.stringify({ plan_digest: plan.plan_digest, attempt: 4, outcome: 'committed' }) },
    { 'attempt-4.json': JSON.stringify({ plan_digest: plan.plan_digest, attempt: 4, step: 'apply' }), 'attempt-4.outcome.json': 'not json' },
  ];
  for (const files of holds) {
    for (const name of ['attempt-4.json', 'attempt-4.outcome.json', 'attempt-4.disposed.json']) await rm(join(journal, name), { force: true });
    for (const [name, content] of Object.entries(files)) await writeFile(join(journal, name), content);
    assert.deepEqual(JSON.parse((await step(plan.plan_digest)).stderr), { ok: false, error: 'repair_disposition_required' }, JSON.stringify(files));
  }
  // A start naming another plan or attempt is foreign: a valid disposition does not settle it, and dispose refuses it.
  for (const foreign of [{ plan_digest: other, attempt: 4, step: 'apply' }, { plan_digest: plan.plan_digest, attempt: 7, step: 'apply' }]) {
    for (const name of ['attempt-4.json', 'attempt-4.outcome.json', 'attempt-4.disposed.json']) await rm(join(journal, name), { force: true });
    await writeFile(join(journal, 'attempt-4.json'), JSON.stringify(foreign));
    assert.deepEqual(JSON.parse((await dispose(4)).stderr), { ok: false, error: 'repair_attempt_foreign' }, JSON.stringify(foreign));
    await writeFile(join(journal, 'attempt-4.disposed.json'), JSON.stringify({ plan_digest: plan.plan_digest, attempt: 4, state: 'preimage', ref: 'r' }));
    assert.deepEqual(JSON.parse((await step(plan.plan_digest)).stderr), { ok: false, error: 'repair_disposition_required' }, JSON.stringify(foreign));
  }
  // A well-formed start and its own outcome settle the attempt.
  for (const name of ['attempt-4.json', 'attempt-4.outcome.json', 'attempt-4.disposed.json']) await rm(join(journal, name), { force: true });
  await writeFile(join(journal, 'attempt-4.json'), JSON.stringify({ plan_digest: plan.plan_digest, attempt: 4, step: 'inverse' }));
  await writeFile(join(journal, 'attempt-4.outcome.json'), JSON.stringify({ plan_digest: plan.plan_digest, attempt: 4, outcome: 'rolled_back' }));
  await step(plan.plan_digest);
  assert.equal(JSON.parse(await readFile(join(journal, 'attempt-5.json'), 'utf8')).attempt, 5);
});

test('freeze refuses a configuration that grants only write, before opening any store', async t => {
  const { dir, config } = await fixture(t);
  const path = join(dir, 'write-only.json');
  await writeFile(path, JSON.stringify({ ...config, scopes: { read: [], write: ['fixture'] }, neo4j: { uri: 'bolt://127.0.0.1:1', auth: 'none' } }));
  const result = await invoke(['freeze', '--config', path, '--store-id', 'store-1', '--scope', 'fixture', '--over', '2048', '--caps', join(dir, 'none.json'),
    '--out', join(dir, 'f.json')]);
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, error: 'scope_denied' });
});

test('a stage that would finish after its deadline is refused, and the deadline starts at entry', async t => {
  const { config, verified, counter, policyDigest } = await fixture(t);
  let now = 0;
  const slow = async (endpoint, body) => { now += 25_000; return counting(counter)(endpoint, body); };
  await assert.rejects(staged({ frozen: frozenRecord(embeddingIdentity(config.embedding), policyDigest), config, verified, budget: { max_pieces: 64, max_seconds: 60 },
    request: slow, clock: () => now }), { code: 'repair_budget_exceeded' });
});

test('a plan for another store is refused before any lock or content read, and classified without reading content', async t => {
  const { config, verified, counter, policyDigest } = await fixture(t);
  const plan = await staged({ frozen: frozenRecord(embeddingIdentity(config.embedding), policyDigest), config, verified, budget: BUDGET, request: counting(counter) });
  const record = fields => ({ get: name => fields[name] });
  const queries = [];
  const tx = { run: async query => { queries.push(query); return { records: [record({ id: 'another-store', name: 'neo4j' })] }; },
    commit: async () => {}, rollback: async () => {} };
  const driver = { session: () => ({ beginTransaction: () => tx, close: async () => {} }) };
  for (const step of [apply, inverse]) {
    queries.length = 0;
    const result = await step({ driver, database: 'neo4j', config, verified, plan });
    assert.deepEqual([result.outcome, result.error], ['rolled_back', 'repair_store_mismatch']);
    assert.deepEqual(queries, ['CALL db.info() YIELD id, name RETURN id, name'], 'only the store identity was read');
  }
  queries.length = 0;
  assert.equal(await classify(tx, plan), 'other_store');
  assert.equal(queries.length, 1);
});
