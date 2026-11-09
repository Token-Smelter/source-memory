import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, MemoryError, normalizeEnrichment, RECORD_CONTRACT } from '../src/core.mjs';
import { Neo4jStore } from '../src/store.mjs';
import { failureReply, main } from '../bin/memory.mjs';
import { qualificationCodes } from './helpers/qualification-codes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPES = ['q1', 'q2', 'q3', 'q4', 'q5', 'q5-other', 'q6', 'q7'];

// A loopback TCP relay to the disposable store whose open connections can be severed, as a network failure would.
async function severableRelay(uri) {
  const { hostname, port } = new URL(uri);
  const sockets = new Set();
  const server = createTcpServer(client => {
    const upstream = connect(Number(port), hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream).pipe(client);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    uri: `bolt://127.0.0.1:${server.address().port}`,
    sever() { for (const socket of sockets) socket.destroy(); },
    close() { this.sever(); return new Promise(done => server.close(done)); },
  };
}

/**
 * Q-SM-1…6 through the real CLI transport: each call is a fresh `node bin/memory.mjs` process against the disposable store,
 * except the driver-retry check, which runs `main` in process to instrument the store.
 * Fictional content only. Returns one result per qualification with the evidence it observed.
 */
export async function runQualification(database, scratch) {
  const results = [];
  const check = async (name, fn) => {
    const evidence = await fn();
    results.push({ name, pass: true, ...(evidence ? { evidence } : {}) });
    console.log(`PASS ${name}`);
  };

  let embedRequests = [];
  const model = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    if (req.url === '/down') { res.writeHead(503).end(); return; }
    // /hang answers only after the test has killed the writer, so the process dies after its commit and before any reply.
    embedRequests.push({ res, input: JSON.parse(body) });
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const modelUrl = path => `http://127.0.0.1:${model.address().port}${path}`;
  const closed = createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const closedPort = closed.address().port;
  await new Promise(done => closed.close(done));

  let files = 0;
  const file = async (content, raw = false) => {
    const path = join(scratch, `qualification-${files++}.json`);
    await writeFile(path, raw ? content : JSON.stringify(content), { mode: 0o600 });
    return path;
  };
  const base = { neo4j: database, scopes: { read: SCOPES, write: SCOPES } };
  const configs = {
    base: await file(base),
    denied: await file({ ...base, scopes: { read: SCOPES, write: SCOPES.filter(scope => scope !== 'q6' && scope !== 'q3') } }),
    down: await file({ ...base, embedding: { url: modelUrl('/down'), model: 'fixture', dimensions: 2 } }),
    hang: await file({ ...base, embedding: { url: modelUrl('/hang'), model: 'fixture', dimensions: 2, timeout_ms: 120000 } }),
    unreachable: await file({ ...base, neo4j: { ...database, uri: `bolt://127.0.0.1:${closedPort}` } }),
    noDatabase: await file({ scopes: base.scopes }),
    userInUri: await file({ ...base, neo4j: { ...database, uri: 'bolt://user@127.0.0.1:7687' } }),
    remote: await file({ ...base, neo4j: { ...database, uri: 'bolt://db.example.invalid:7687' } }),
    noPassword: await file({ ...base, neo4j: { ...database, auth: 'basic', password_env: 'SOURCE_MEMORY_QUALIFICATION_UNSET' } }),
    nullConfig: await file('null', true),
  };

  // Spawns one CLI process; `whileRunning` may kill it. reply is the stdout success line or the stderr failure line.
  const cli = async (args, { input, rawInput, whileRunning } = {}) => {
    const argv = [...args];
    if (input !== undefined || rawInput !== undefined) argv.push('--input', await file(rawInput ?? input, rawInput !== undefined));
    const env = { ...process.env };
    delete env.SOURCE_MEMORY_QUALIFICATION_UNSET;
    delete env.SOURCE_MEMORY_CONFIG;
    const child = spawn(process.execPath, [join(root, 'bin/memory.mjs'), ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    const exit = once(child, 'close');
    if (whileRunning) await whileRunning(child);
    const [code, signal] = await exit;
    const line = (stdout.trim() || stderr.trim().split('\n').at(-1) || '').trim();
    let reply = null;
    try { reply = line ? JSON.parse(line) : null; } catch { reply = null; }
    return { code, signal, stdout, stderr, reply };
  };
  const run = (config, command, scope, input) => cli([command, '--config', configs[config], '--scope', scope], { input });
  const ok = async (...args) => {
    const result = await run(...args);
    assert.equal(result.reply?.ok, true, `${args[1]} failed: ${result.stderr}`);
    return result.reply;
  };
  const counts = async scope => {
    const status = await ok('base', 'status', scope);
    return { turns: status.turns, chunks: status.chunks, records: status.records, relations: status.relations };
  };
  const show = (scope, kind, id) => run('base', 'show', scope, { kind, id });
  const storedDigest = record => {
    const { uid: _uid, scope: _scope, ...body } = record;
    return digest(body);
  };

  const fixtureTurn = (text = 'Orla, the fictional harbour master, picked teal shutters for the lighthouse.') => ({
    source: 'qualification-fixture', conversation_id: 'harbour', turn_id: 't1',
    entries: [{ id: 'u1', role: 'user', text }, { id: 'd1', role: 'derived', text: 'Summary: teal shutters.' }] });
  const record = (id, turn, extra = {}) => ({ id, kind: 'decision', text: 'Teal shutters for the fictional lighthouse.',
    attribution: 'qualification fixture', evidence: [{ turn, entry_id: 'u1', start: 0, end: 20 }], ...extra });
  const relation = (id, from, to, turn, extra = {}) => ({ id, type: 'qualifies', from, to, attribution: 'qualification fixture',
    evidence: [{ turn, entry_id: 'u1', start: 0, end: 4 }], ...extra });

  const staged = [];
  const stageOf = result => { if (result.reply?.ok === false && 'stage' in result.reply) staged.push(result.reply.stage); return result; };
  const documented = qualificationCodes(await readFile(join(root, 'QUALIFICATION.md'), 'utf8'));
  const sources = {};

  try {
    for (const scope of SCOPES) await ok('base', 'init', scope);
    for (const scope of ['q1', 'q2', 'q3', 'q4', 'q6', 'q7']) sources[scope] = (await ok('base', 'ingest', scope, fixtureTurn())).id;

    await check('Q-SM-1 the same record id and normalized record twice give one record and success both times', async () => {
      const turn = sources.q1;
      const replayedTurn = await ok('base', 'ingest', 'q1', fixtureTurn());
      const first = await ok('base', 'enrich', 'q1', { records: [record('q1-decision', turn)], relations: [] });
      // Same normalized record: other key order, the default status written out, an unknown field normalization drops.
      const { kind, text, attribution, evidence, id } = record('q1-decision', turn);
      const second = await ok('base', 'enrich', 'q1', { relations: [],
        records: [{ evidence, attribution, status: 'proposed', text, kind, id, note: 'dropped by normalization' }] });
      const stored = (await show('q1', 'record', 'q1-decision')).reply.record;
      const expected = normalizeEnrichment({ records: [record('q1-decision', turn)], relations: [] }).records[0];
      assert.deepEqual([replayedTurn.replayed, first.records, second.records, storedDigest(stored), await counts('q1')],
        [true, ['q1-decision'], ['q1-decision'], digest(expected), { turns: 1, chunks: 2, records: 1, relations: 0 }]);
      return { first: { ok: first.ok, records: first.records }, second: { ok: second.ok, records: second.records }, records_in_scope: 1 };
    });

    await check('Q-SM-2 the same id with other bytes gives record_identity_conflict and leaves the record unchanged', async () => {
      const turn = sources.q2;
      await ok('base', 'enrich', 'q2', { records: [record('q2-decision', turn)], relations: [] });
      const before = (await show('q2', 'record', 'q2-decision')).reply.record;
      const conflict = stageOf(await run('base', 'enrich', 'q2',
        { records: [record('q2-decision', turn, { text: 'Amber shutters for the fictional lighthouse.' })], relations: [] }));
      const after = (await show('q2', 'record', 'q2-decision')).reply.record;
      assert.deepEqual([conflict.code, conflict.reply, after, await counts('q2')],
        [1, { ok: false, error: 'record_identity_conflict', stage: 'rolled_back' }, before, { turns: 1, chunks: 2, records: 1, relations: 0 }]);
      return { reply: conflict.reply, record_unchanged: true };
    });

    await check('Q-SM-3 every no_write code is raised before the write and every in-transaction code rolls back', async () => {
      const turn = sources.q3;
      await ok('base', 'enrich', 'q3', { records: [record('anchor', turn), record('anchor-two', turn)],
        relations: [relation('anchor-link', 'anchor', 'anchor-two', turn)] });
      const baseline = await counts('q3');
      const companion = code => record(`companion-${code}`, turn);
      const enrich = (code, records, relations = []) => ({ command: 'enrich', code, input: { records: [companion(code), ...records], relations } });
      const valid = { records: [companion('cli')], relations: [] };
      const large = JSON.stringify({ ...valid, pad: 'x'.repeat(4_000_001) });
      const before = [
        { code: 'config_and_scope_required', args: ['enrich', '--config', configs.base], input: valid },
        { code: 'invalid_arguments', args: ['enrich', '--config', configs.base, '--scope', 'q3', '--verbose', 'yes'], input: valid },
        { code: 'input_file_unavailable', args: ['enrich', '--config', configs.base, '--scope', 'q3', '--input', join(scratch, 'absent.json')] },
        { code: 'invalid_json', command: 'enrich', rawInput: '{"records": [' },
        { code: 'input_too_large', command: 'enrich', rawInput: large },
        { code: 'database_config_required', command: 'enrich', config: 'noDatabase', input: valid },
        { code: 'invalid_database_uri', command: 'enrich', config: 'userInUri', input: valid },
        { code: 'database_must_be_loopback', command: 'enrich', config: 'remote', input: valid },
        { code: 'database_credentials_unavailable', command: 'enrich', config: 'noPassword', input: valid },
        { code: 'operation_failed', command: 'enrich', config: 'nullConfig', input: valid },
        { code: 'scope_denied', command: 'enrich', config: 'denied', input: valid },
        { code: 'scope_denied', command: 'ingest', config: 'denied', input: fixtureTurn('A denied fictional turn.') },
        { code: 'invalid_input', command: 'enrich', input: { records: 'none', relations: [] } },
        { code: 'invalid_input', command: 'ingest', input: { ...fixtureTurn(), turn_id: '' } },
        { code: 'duplicate_entry', command: 'ingest', input: { ...fixtureTurn(), turn_id: 't2', entries: [fixtureTurn().entries[0], fixtureTurn().entries[0]] } },
        { code: 'invalid_role', command: 'ingest', input: { ...fixtureTurn(), turn_id: 't2', entries: [{ id: 'u1', role: 'narrator', text: 'x' }] } },
        { code: 'invalid_timestamp', command: 'ingest', input: { ...fixtureTurn(), turn_id: 't2', occurred_at: 'the day after the storm' } },
        { code: 'source_too_large', command: 'ingest', input: { ...fixtureTurn(), turn_id: 't2',
          entries: [{ id: 'a', role: 'user', text: 'a'.repeat(1_000_001) }, { id: 'b', role: 'user', text: 'b'.repeat(1_000_001) }] } },
        { code: 'enrichment_too_large', command: 'enrich', input: { records: Array.from({ length: 129 }, (_, i) => record(`many-${i}`, turn)), relations: [] } },
        enrich('duplicate_record', [record('twice', turn), record('twice', turn)]),
        enrich('invalid_kind', [record('rumour', turn, { kind: 'rumour' })]),
        enrich('invalid_status', [record('rejected', turn, { status: 'rejected' })]),
        enrich('evidence_required', [record('unsupported', turn, { evidence: [] })]),
        enrich('evidence_too_large', [record('long', turn, { evidence: [{ turn, entry_id: 'u1', start: 0, end: 16001 }] })]),
        enrich('duplicate_relation', [], [relation('dup', 'anchor', 'anchor-two', turn), relation('dup', 'anchor', 'anchor-two', turn)]),
        enrich('invalid_relation', [], [relation('friends', 'anchor', 'anchor-two', turn, { type: 'befriends' })]),
        enrich('self_relation', [], [relation('loop', 'anchor', 'anchor', turn)]),
      ];
      const inTransaction = [
        enrich('evidence_unavailable', [record('ghost-evidence', `turn_${'0'.repeat(64)}`)]),
        enrich('invalid_evidence_span', [record('past-end', turn, { evidence: [{ turn, entry_id: 'u1', start: 0, end: 9999 }] })]),
        enrich('derived_is_not_original_evidence', [record('from-summary', turn, { evidence: [{ turn, entry_id: 'd1', start: 0, end: 8 }] })]),
        enrich('relation_endpoint_unavailable', [], [relation('to-ghost', 'anchor', 'ghost-record', turn)]),
        enrich('invalid_outcome_relation', [], [relation('not-outcome', 'anchor', 'anchor-two', turn, { type: 'outcome_of' })]),
        enrich('outcome_referent_required', [record('orphan-outcome', turn, { kind: 'outcome' })]),
        // The companion's MERGE runs before the conflicting one, so these also show an executed write rolling back.
        enrich('record_identity_conflict', [record('anchor', turn, { text: 'Amber shutters.' })]),
        enrich('relation_identity_conflict', [], [relation('anchor-link', 'anchor', 'anchor-two', turn, { type: 'contradicts' })]),
        { code: 'source_identity_conflict', command: 'ingest', input: fixtureTurn('Orla picked amber shutters instead.') },
      ];
      const exercised = { before_write: new Set(), rolled_back: new Set() };
      const replies = {};
      for (const [stage, cases] of [['before_write', before], ['rolled_back', inTransaction]]) {
        for (const item of cases) {
          const args = item.args ?? [item.command, '--config', configs[item.config ?? 'base'], '--scope', 'q3'];
          const result = stageOf(await cli(args, { input: item.input, rawInput: item.rawInput }));
          assert.deepEqual([result.code, result.reply], [1, { ok: false, error: item.code, stage }], `${item.code}: ${result.stderr}`);
          if (item.input?.records?.[0]?.id?.startsWith('companion-')) {
            assert.equal((await show('q3', 'record', item.input.records[0].id)).reply?.error, 'not_found', `${item.code} companion written`);
          }
          exercised[stage].add(item.code);
          replies[item.code] = result.reply;
        }
      }
      assert.deepEqual(await counts('q3'), baseline);
      const anchor = (await show('q3', 'record', 'anchor')).reply.record;
      assert.equal(anchor.text, 'Teal shutters for the fictional lighthouse.');
      const unknownCommand = await cli(['remember', '--config', configs.base, '--scope', 'q3']);
      assert.deepEqual(unknownCommand.reply, { ok: false, error: 'unknown_command' });
      exercised.before_write.add('unknown_command');
      // Every code the table classifies pre-commit-only or in-transaction-rolled-back was raised through the transport here.
      const listed = kind => [...documented].filter(([, value]) => value === kind).map(([code]) => code).sort();
      assert.deepEqual([...exercised.before_write].filter(code => code !== 'operation_failed').sort(), listed('pre-commit-only'));
      assert.deepEqual([...exercised.rolled_back].sort(), listed('in-transaction-rolled-back'));
      const unreachable = stageOf(await run('unreachable', 'enrich', 'q3', valid));
      assert.deepEqual(unreachable.reply, { ok: false, error: 'operation_failed', stage: 'unknown' });
      return { before_write: [...exercised.before_write].sort(), rolled_back: [...exercised.rolled_back].sort(),
        unreachable_database: unreachable.reply, store_unchanged: baseline };
    });

    await check('Q-SM-4 a failure after commit gives unknown or a receipt, and an exact read then finds one record', async () => {
      const turn = sources.q4;
      // Indexing fails after the commit: the reply is still the committed result.
      const indexed = await run('down', 'enrich', 'q4', { records: [record('q4-indexing', turn)], relations: [] });
      assert.deepEqual([indexed.code, indexed.reply.ok, indexed.reply.records, indexed.reply.indexing],
        [0, true, ['q4-indexing'], { status: 'unavailable', reason: 'model_request_failed', source_retained: true }]);
      // The process dies after the commit, during indexing, before it can reply: the caller sees no reply (unknown).
      const killWhenIndexing = async child => {
        while (!embedRequests.length) await new Promise(done => setTimeout(done, 10));
        child.kill('SIGKILL');
      };
      const killed = {};
      const payload = { records: [record('q4-killed', turn)], relations: [] };
      for (const [command, input] of [['ingest', { ...fixtureTurn('A fictional turn written before the writer died.'), turn_id: 't-killed' }],
        ['enrich', payload]]) {
        embedRequests = [];
        const result = await cli([command, '--config', configs.hang, '--scope', 'q4'], { input, whileRunning: killWhenIndexing });
        for (const pending of embedRequests) pending.res.destroy();
        assert.deepEqual([result.signal, result.stdout, result.reply], ['SIGKILL', '', null], command);
        killed[command] = { signal: result.signal, reply: result.reply };
      }
      const shownTurn = (await run('base', 'show', 'q4', { kind: 'turn_by_key', source: 'qualification-fixture', conversation_id: 'harbour',
        turn_ids: ['t-killed'] })).reply;
      const stored = (await show('q4', 'record', 'q4-killed')).reply.record;
      const expected = normalizeEnrichment(payload).records[0];
      assert.deepEqual([shownTurn.found.length, storedDigest(stored), (await counts('q4')).records], [1, digest(expected), 2]);
      // A later identical send converges on the same single record.
      const resent = await ok('base', 'enrich', 'q4', payload);
      assert.deepEqual([resent.records, (await counts('q4')).records], [['q4-killed'], 2]);
      return { indexing_failure_reply: { ok: true, indexing: indexed.reply.indexing }, killed,
        exact_read: { turn_found: 1, record_digest_match: true, records_in_scope: 2 } };
    });

    await check('Q-SM-5 status names the store and the record contract so a new store or contract is detectable', async () => {
      const first = (await ok('base', 'status', 'q5')).store;
      const second = (await ok('base', 'status', 'q5')).store;
      const other = (await ok('base', 'status', 'q5-other')).store;
      assert.match(first.database_id, /\S/);
      assert.deepEqual([first, second, other], Array(3).fill({ system: 'neo4j', database_id: first.database_id, database: 'neo4j',
        record_contract: RECORD_CONTRACT }));
      return { store: first };
    });

    await check('Q-SM-6 the CLI reply separates a pre-commit refusal, a rolled-back refusal and a post-commit outcome', async () => {
      const turn = sources.q6;
      const before = await counts('q6');
      const deniedEnrich = stageOf(await run('denied', 'enrich', 'q6', { records: [record('q6-denied', turn)], relations: [] }));
      const deniedIngest = stageOf(await run('denied', 'ingest', 'q6', { ...fixtureTurn('A fictional turn the grant refuses.'), turn_id: 't2' }));
      await ok('base', 'enrich', 'q6', { records: [record('q6-decision', turn)], relations: [] });
      const rolledBack = stageOf(await run('base', 'enrich', 'q6', { records: [record('q6-decision', turn, { text: 'Other.' })], relations: [] }));
      const committed = await run('down', 'enrich', 'q6', { records: [record('q6-after', turn)], relations: [] });
      assert.deepEqual([deniedEnrich.reply, deniedIngest.reply, rolledBack.reply, committed.reply.ok, committed.reply.indexing.status],
        [{ ok: false, error: 'scope_denied', stage: 'before_write' }, { ok: false, error: 'scope_denied', stage: 'before_write' },
          { ok: false, error: 'record_identity_conflict', stage: 'rolled_back' }, true, 'unavailable']);
      assert.deepEqual(await counts('q6'), { ...before, records: before.records + 2 });
      assert.ok(staged.every(stage => ['before_write', 'rolled_back', 'unknown'].includes(stage)) && staged.length > 0);
      return { pre_commit: deniedEnrich.reply, rolled_back: rolledBack.reply,
        post_commit: { ok: true, indexing: committed.reply.indexing }, staged_failures: staged.length };
    });

    await check('Q-SM-6 a refusal raised after a real driver retry carries stage unknown', async () => {
      const turn = sources.q7;
      const relay = await severableRelay(database.uri);
      const store = new Neo4jStore({ ...database, uri: relay.uri });
      // The real executeWrite runs every attempt. Attempt 1 runs its first statement, then loses its connection before
      // commit; between attempts another writer commits the same record id with other bytes, so only the retry conflicts.
      const realTransaction = store.transaction.bind(store);
      const attempts = [];
      store.transaction = (mode, action) => realTransaction(mode, async tx => {
        attempts.push({ attempt: attempts.length + 1 });
        if (attempts.length > 1) {
          await ok('base', 'enrich', 'q7', { records: [record('q7-retried', turn)], relations: [] });
          return action(tx);
        }
        let severed = false;
        const runThenSever = async (...args) => {
          const result = await tx.run(...args);
          if (!severed) { severed = true; relay.sever(); }
          return result;
        };
        try { return await action({ run: runThenSever }); }
        catch (error) { attempts[0].error = { memory_error: error instanceof MemoryError, code: error.code, retryable: error.retryable }; throw error; }
      });
      const input = await file({ records: [record('q7-companion', turn),
        record('q7-retried', turn, { text: 'Amber shutters for the fictional lighthouse.' })], relations: [] });
      let reply;
      try {
        await main(['enrich', '--config', configs.base, '--scope', 'q7', '--input', input],
          { store, stdout: { write: line => { reply = JSON.parse(line); } }, stderr: { write() {} } });
      } catch (error) { reply = failureReply('enrich', error); } finally { await relay.close(); }
      const companion = (await show('q7', 'record', 'q7-companion')).reply;
      const stored = (await show('q7', 'record', 'q7-retried')).reply.record;
      assert.deepEqual([attempts.length, attempts[0].error?.memory_error, attempts[0].error?.retryable, reply],
        [2, false, true, { ok: false, error: 'record_identity_conflict', stage: 'unknown' }]);
      assert.deepEqual([companion.error, stored.text, (await counts('q7')).records],
        ['not_found', 'Teal shutters for the fictional lighthouse.', 1]);
      return { attempts, reply, retry_rolled_back: true };
    });
    return results;
  } finally {
    for (const pending of embedRequests) pending.res.destroy();
    model.closeAllConnections();
    await new Promise(done => model.close(done));
  }
}
