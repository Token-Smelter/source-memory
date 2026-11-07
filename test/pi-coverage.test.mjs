import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoverageJournal, runCoveredInterval } from '../pi-extension/coverage.mjs';
import { fictionalCoverage } from '../pi-extension/policy.mjs';

async function privateJournal(action) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-coverage-'));
  try { await action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
const entries = [{ type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'fiction' } },
  { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: 'done', stopReason: 'stop' } }];

test('uncertain-write fixture blocks dependent progress and retry across journal reopen', () => privateJournal(async directory => {
  const fixture = fictionalCoverage().value.cases.find(row => row.id === 'uncertain-write');
  let journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  const memory = journal.track({ async enrich() { throw Object.assign(new Error('timeout'), { code: 'request_timeout' }); } });
  const id = journal.begin({ cursor: null, through: 'a' });
  await assert.rejects(memory.enrich('fiction', {}), /write_uncertain/);
  await assert.rejects(memory.enrich('fiction', { different: true }), /write_reconciliation_required/);
  assert.equal(journal.finish('failed'), fixture.disposition);
  journal.close();
  journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  assert.throws(() => journal.begin({ cursor: 'a', through: 'b' }), /reconciliation_required/);
  assert.throws(() => journal.begin({ cursor: null, through: 'a', retry: true }), /reconciliation_required/);
  assert.deepEqual([journal.state().id, journal.state().cursor], [id, null]);
  journal.close();
}));

test('a confirmed pre-write refusal permits a corrected write in the same interval', () => privateJournal(async directory => {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  let calls = 0;
  const memory = journal.track({ async enrich() { calls++; if (calls === 1) throw Object.assign(new Error('refused'), { effect: 'refused' }); return { records: ['fiction'] }; } });
  journal.begin({ cursor: null, through: 'a' });
  await assert.rejects(memory.enrich('fiction', { first: true }), /refused/);
  await memory.enrich('fiction', { second: true });
  assert.deepEqual([journal.finish('committed'), calls], ['committed', 2]);
  journal.close();
}));

test('reconciliation requires explicit proof and failed outcome before a retry', () => privateJournal(async directory => {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  const id = journal.begin({ cursor: null, through: 'a' });
  const memory = journal.track({ async enrich() { throw new Error('uncertain'); } });
  await assert.rejects(memory.enrich('fiction', {}));
  journal.finish('failed');
  assert.throws(() => journal.reconcile({ id, disposition: 'failed', evidenceRef: '' }), /reconciliation_invalid/);
  journal.reconcile({ id, disposition: 'failed', evidenceRef: 'fictional-proof-of-no-effect' });
  assert.throws(() => journal.begin({ cursor: null, through: 'a' }), /coverage_gap/);
  assert.equal(journal.begin({ cursor: null, through: 'a', retry: true }), id);
  journal.finish('failed');
  journal.close();
}));

test('an unfinished interval remains uncertain after restart', () => privateJournal(async directory => {
  let journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  const id = journal.begin({ cursor: null, through: 'a' });
  journal.close();
  journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  assert.deepEqual([journal.state().status, journal.state().id], ['uncertain', id]);
  assert.throws(() => journal.begin({ cursor: null, through: 'a', retry: true }), /reconciliation_required/);
  journal.close();
}));

test('a model failure after a confirmed derived write is uncertain, not failed or abstained', () => privateJournal(async directory => {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  const memory = journal.track({ async ingest() { return { id: 'turn' }; }, async enrich() { return { ok: true }; } });
  const session = { entries, conversation_id: 'fiction', scopes: ['private'], memory,
    distiller: { memory, async run() { await memory.enrich('private', { records: [] }); throw new Error('model failed'); } } };
  const result = await runCoveredInterval({ journal, session, through: 'a', cursor: null });
  assert.deepEqual([result.disposition, result.cursor, journal.state().status], ['uncertain', null, 'uncertain']);
  journal.close();
}));

test('a failure after confirmed archive only stays a failed scheduled gap', () => privateJournal(async directory => {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  const memory = journal.track({ async ingest() { return { id: 'turn' }; } });
  const session = { entries, conversation_id: 'fiction', scopes: ['private'], memory,
    distiller: { memory, async run() { throw new Error('model failed'); } } };
  const result = await runCoveredInterval({ journal, session, through: 'a', cursor: null });
  assert.deepEqual([result.disposition, journal.state().status], ['failed', 'failed']);
  journal.close();
}));

test('successful silence advances the cursor without inventing a derived record', () => privateJournal(async directory => {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  const memory = journal.track({ async ingest() { return { id: 'turn' }; } });
  const session = { entries, conversation_id: 'fiction', scopes: ['private'], memory,
    distiller: { memory, async run() { return { status: 'complete', disposition: 'abstained' }; } } };
  const result = await runCoveredInterval({ journal, session, through: 'a', cursor: null });
  assert.deepEqual([result.disposition, result.cursor, journal.state().status], ['abstained', 'a', 'ready']);
  assert.throws(() => journal.begin({ cursor: null, through: 'a' }), /interval_already_covered/);
  journal.close();
}));

test('untracked candidate and archive paths cannot enter the coverage runner', () => privateJournal(async directory => {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  const memory = journal.track({ async ingest() { return { id: 'turn' }; } });
  const session = { entries, conversation_id: 'fiction', scopes: ['private'], memory,
    distiller: { memory: {}, async run() { return { status: 'complete', disposition: 'abstained' }; } } };
  await assert.rejects(runCoveredInterval({ journal, session, through: 'a', cursor: null }), /tracking_required/);
  assert.equal(journal.state().status, 'ready');
  journal.close();
}));
