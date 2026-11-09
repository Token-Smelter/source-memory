import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { distillThrough, sourceInterval } from '../pi-extension/core.mjs';
import { createCoverageJournal, runCoveredInterval } from '../pi-extension/coverage.mjs';
import { createCursorStore } from '../pi-extension/cursor-store.mjs';
import { createIncrementalSession } from '../pi-extension/incremental.mjs';
import { createLiveController, registerLiveMemory } from '../pi-extension/live.mjs';
import { contextMessages, createPiDistiller, WITHHELD_SUMMARY } from '../pi-extension/pi-runtime.mjs';
import { compactResult } from './helpers/compact-fixture.mjs';
import { fictionalCoverage } from '../pi-extension/policy.mjs';

const policy = { summaryPolicy: 'dependency_closure' };
const user = (id, parentId, content) => ({ type: 'message', id, parentId, message: { role: 'user', content } });
const reply = (id, parentId, content) => ({ type: 'message', id, parentId, message: { role: 'assistant', content, stopReason: 'stop' } });
const compaction = (id, parentId, firstKeptEntryId, extra = {}) => ({ type: 'compaction', id, parentId, summary: 'Fictional summary.', firstKeptEntryId, tokensBefore: 10, ...extra });
const compacted = [user('u1', null, 'Fictional start.'), reply('a1', 'u1', 'Noted.'), user('u2', 'a1', 'Fictional middle.'), reply('a2', 'u2', 'Kept.'),
  compaction('c1', 'a2', 'u2'), user('u3', 'c1', 'After compaction.'), reply('a3', 'u3', 'Continued.')];
const ids = result => result.turn.entries.map(row => row.id);

async function privateDir(action) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-live-compaction-'));
  chmodSync(directory, 0o700);
  try { await action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('without the policy every sealed coverage fixture keeps its frozen result', () => {
  for (const fixture of fictionalCoverage().value.cases.filter(row => Array.isArray(row.entries))) {
    for (const checkpoint of fixture.checkpoints) {
      const run = () => sourceInterval(fixture.entries, checkpoint.through, checkpoint.cursor, 'fiction', { allowInterrupted: checkpoint.interrupted === true });
      if (checkpoint.error) assert.throws(run, { code: checkpoint.error }, fixture.id);
      else assert.deepEqual(ids(run()), checkpoint.entries, fixture.id);
    }
  }
});

test('the default distiller input and journal rows are unchanged when the policy is absent', () => privateDir(async directory => {
  const inputs = [];
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  const memory = journal.track({ async ingest() { return { id: 'turn' }; } });
  const entries = [user('u', null, 'Fiction.'), reply('a', 'u', 'Done.')];
  await runCoveredInterval({ journal, cursor: null, through: 'a', session: { entries, conversation_id: 'fiction', scopes: ['private'], memory,
    distiller: { memory, async run(input) { inputs.push(Object.keys(input).sort()); return { status: 'complete', disposition: 'abstained' }; } } } });
  const finish = readFileSync(journal.path, 'utf8').trim().split('\n').map(JSON.parse).find(row => row.type === 'finish');
  assert.deepEqual([inputs[0], Object.keys(finish).sort()], [['cursor', 'receipt', 'scope', 'throughEntryId', 'turn'],
    ['code', 'disposition', 'hash', 'id', 'previous', 'seq', 'type', 'version']]);
  journal.close();
}));

test('a standard Pi compaction has a proven closure and the post-compaction entries are processed', () => {
  const crossing = sourceInterval(compacted, 'a3', 'a2', 'fiction', policy);
  const whole = sourceInterval(compacted, 'a3', null, 'fiction', policy);
  assert.deepEqual([ids(crossing), crossing.omissions.summaries, crossing.excludedSummaryIds, ids(whole)],
    [['u3', 'a3'], [{ entry_id: 'c1', type: 'compaction', disposition: 'admissible', reason: null }], [], ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']]);
});

test('an unproved compaction is an explicit gap and the later interval continues', () => {
  const fixture = fictionalCoverage().value.cases.find(row => row.id === 'unproved-compaction');
  const entries = [...fixture.entries, user('u2', 'z', 'Later fictional request.'), reply('z2', 'u2', 'Later reply.')];
  const first = sourceInterval(entries, 'z', null, 'fiction', policy);
  const later = sourceInterval(entries, 'z2', 'z', 'fiction', policy);
  assert.deepEqual([ids(first), first.omissions.summaries, first.excludedSummaryIds, ids(later), later.omissions.summaries, later.excludedSummaryIds],
    [['u', 'z'], [{ entry_id: 'c', type: 'compaction', disposition: 'gap', reason: 'summary_closure_unproved' }], ['c'], ['u2', 'z2'], undefined, ['c']]);
});

test('branch, extension and dependent summaries are gaps while a clean later compaction stays admissible', () => {
  const entries = [user('u1', null, 'Root.'), reply('a1', 'u1', 'Root reply.'),
    { type: 'branch_summary', id: 'b1', parentId: 'a1', summary: 'Abandoned fiction.', fromId: 'gone' },
    user('u2', 'b1', 'Back on branch.'), reply('a2', 'u2', 'Reply.'),
    compaction('c1', 'a2', 'u2'), user('u3', 'c1', 'Next.'), reply('a3', 'u3', 'Reply.'),
    compaction('c2', 'a3', 'u3'), user('u4', 'c2', 'Later.'), reply('a4', 'u4', 'Reply.'),
    compaction('c3', 'a4', 'u4', { fromHook: true }), user('u5', 'c3', 'Last.'), reply('a5', 'u5', 'Reply.')];
  const result = sourceInterval(entries, 'a5', 'a1', 'fiction', policy);
  assert.deepEqual([result.omissions.summaries.map(row => [row.entry_id, row.reason]), result.excludedSummaryIds, ids(result)],
    [[['b1', 'summary_source_off_branch'], ['c1', 'summary_dependency_inadmissible'], ['c2', 'summary_dependency_inadmissible'], ['c3', 'summary_closure_unproved']],
      ['b1', 'c1', 'c2', 'c3'], ['u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']]);
  const clean = [...compacted, user('u4', 'a3', 'More.'), reply('a4', 'u4', 'Reply.'), compaction('c2', 'a4', 'u4'), user('u5', 'c2', 'Last.'), reply('a5', 'u5', 'Reply.')];
  assert.deepEqual(sourceInterval(clean, 'a5', 'a3', 'fiction', policy).omissions.summaries.map(row => row.disposition), ['admissible']);
});

test('the distiller receives exclusions and its context drops only inadmissible summaries', async () => {
  const inputs = [];
  const entries = [user('u', null, 'Fiction.'), { type: 'branch_summary', id: 'b', parentId: 'u', summary: 'Elsewhere.', fromId: 'gone' }, reply('a', 'b', 'Done.')];
  await distillThrough({ entries, conversation_id: 'fiction', scopes: ['private'], memory: { async ingest() { return { id: 'turn' }; } },
    distiller: { async run(input) { inputs.push(input.excludedSummaryIds); return { status: 'complete' }; } } }, 'a', null, policy);
  const manager = { buildSessionContext: () => ({ messages: ['all'] }), buildContextEntries: () => entries };
  const pi = { sessionEntryToContextMessages: entry => [entry.id] };
  assert.deepEqual([inputs[0], contextMessages(pi, manager, undefined), contextMessages(pi, manager, ['b']), contextMessages(pi, manager, [])],
    [['b'], ['all'], ['u', { role: 'user', content: [{ type: 'text', text: WITHHELD_SUMMARY }], timestamp: 0 }, 'a'], ['all']]);
  assert.throws(() => contextMessages({}, manager, ['b']), /summary_exclusion_unavailable/);
});

test('the live controller covers intervals across a compaction and journals its boundary', () => privateDir(async directory => {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction', effectIds: true, pidLock: true });
  const ingested = [];
  const memory = journal.track({ async ingest(_scope, turn) { ingested.push(turn.entries.map(row => row.id)); return { id: `turn-${turn.turn_id}` }; } });
  const controller = createLiveController({ journal, cursorStore: createCursorStore({ directory, sessionKey: 'fiction' }), conversationId: 'fiction',
    open: async () => ({ conversation_id: 'fiction', scopes: ['private'], memory,
      distiller: { memory, async run() { return { status: 'complete', disposition: 'abstained' }; } } }) });
  const before = await controller.settle({ leafId: 'a2', entries: compacted.slice(0, 4) });
  const after = await controller.settle({ leafId: 'a3', entries: compacted });
  const finishes = readFileSync(journal.path, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.type === 'finish');
  assert.deepEqual([before.status, after.status, ingested, finishes.map(row => row.boundaries ?? null)],
    ['covered', 'covered', [['u1', 'a1', 'u2', 'a2'], ['u3', 'a3']], [null, [{ entry_id: 'c1', type: 'compaction', disposition: 'admissible', reason: null }]]]);
  journal.close();
}));

