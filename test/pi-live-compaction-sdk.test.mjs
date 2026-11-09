import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceInterval } from '../pi-extension/core.mjs';
import { createCoverageJournal, runCoveredInterval } from '../pi-extension/coverage.mjs';
import { createIncrementalSession } from '../pi-extension/incremental.mjs';
import { createLiveController, registerLiveMemory } from '../pi-extension/live.mjs';
import { createCursorStore } from '../pi-extension/cursor-store.mjs';
import { contextMessages, createPiDistiller } from '../pi-extension/pi-runtime.mjs';
import { compactResult } from './helpers/compact-fixture.mjs';

const policy = { summaryPolicy: 'dependency_closure' };
const user = (id, parentId, content) => ({ type: 'message', id, parentId, message: { role: 'user', content } });
const reply = (id, parentId, content) => ({ type: 'message', id, parentId, message: { role: 'assistant', content, stopReason: 'stop' } });
const compaction = (id, parentId, firstKeptEntryId, extra = {}) => ({ type: 'compaction', id, parentId, summary: 'Fictional summary.', firstKeptEntryId, tokensBefore: 10, ...extra });

async function privateDir(action) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-live-compaction-sdk-'));
  chmodSync(directory, 0o700);
  try { await action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('a compaction with any truthy fromHook or a kept entry at or after itself has no proven closure', () => {
  const base = [user('u1', null, 'One.'), reply('a1', 'u1', 'One.'), user('u2', 'a1', 'Two.'), reply('a2', 'u2', 'Two.')];
  const verdict = row => sourceInterval([...base, row, user('u3', row.id, 'Three.'), reply('a3', 'u3', 'Three.')], 'a3', 'a2', 'fiction', policy).omissions.summaries[0].reason;
  assert.deepEqual([verdict(compaction('c', 'a2', 'u2', { fromHook: 'true' })), verdict(compaction('c', 'a2', 'u2', { fromHook: 1 })),
    verdict(compaction('c', 'a2', 'c')), verdict(compaction('c', 'a2', 'u3')), verdict(compaction('c', 'a2', 'u2', { fromHook: false }))],
  ['summary_closure_unproved', 'summary_closure_unproved', 'summary_closure_unproved', 'summary_closure_unproved', null]);
});

test('a compaction inherits an inadmissible previous summary even when that summary sits in its kept region', () => {
  const entries = [user('u1', null, 'One.'), reply('a1', 'u1', 'One.'), compaction('c1', 'a1', undefined, { firstKeptEntryId: undefined }),
    user('u2', 'c1', 'Two.'), reply('a2', 'u2', 'Two.'), compaction('c2', 'a2', 'u2'), user('u3', 'c2', 'Three.'), reply('a3', 'u3', 'Three.')];
  const verdicts = sourceInterval(entries, 'a3', null, 'fiction', policy).omissions.summaries.map(row => [row.entry_id, row.reason]);
  assert.deepEqual(verdicts, [['c1', 'summary_closure_unproved'], ['c2', 'summary_dependency_inadmissible']]);
  assert.throws(() => sourceInterval(entries, 'a3', null, 'fiction', { summaryPolicy: 'dependency-closure' }), /invalid_input/);
});

test('a failed interval across a compaction is retried and covered', () => privateDir(async directory => {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction', effectIds: true, pidLock: true });
  let calls = 0;
  const memory = journal.track({ async ingest() { return { id: 'turn' }; } });
  const controller = createLiveController({ journal, cursorStore: createCursorStore({ directory, sessionKey: 'fiction' }), conversationId: 'fiction',
    open: async () => ({ conversation_id: 'fiction', scopes: ['private'], memory, distiller: { memory, async run() {
      if (++calls === 2) throw Object.assign(new Error('provider'), { code: 'provider_unavailable' });
      return { status: 'complete', disposition: 'abstained' };
    } } }) });
  const entries = [user('u1', null, 'One.'), reply('a1', 'u1', 'One.'), user('u2', 'a1', 'Two.'), reply('a2', 'u2', 'Two.'),
    compaction('c1', 'a2', 'u2'), user('u3', 'c1', 'Three.'), reply('a3', 'u3', 'Three.')];
  await controller.settle({ leafId: 'a2', entries });
  const failed = await controller.settle({ leafId: 'a3', entries });
  const retried = await controller.settle({ leafId: 'a3', entries });
  assert.deepEqual([failed.status, retried.status, retried.results.map(row => row.disposition)], ['stopped', 'current', ['abstained']]);
  journal.close();
}));

test('journal boundaries must be exact summary verdicts and an invalid policy writes no interval', () => privateDir(async directory => {
  const journal = createCoverageJournal({ directory, sessionKey: 'fiction' });
  journal.begin({ cursor: null, through: 'a' });
  for (const boundaries of [[{ entry_id: 'c', type: 'compaction', disposition: 'gap', reason: null }],
    [{ entry_id: 'c', type: 'compaction', disposition: 'admissible', reason: null, summary: 'leaked text' }],
    [{ entry_id: 'c', type: 'custom', disposition: 'admissible', reason: null }]]) assert.throws(() => journal.finish('abstained', null, null, { boundaries }), /boundaries_invalid/);
  journal.finish('failed');
  const memory = journal.track({ async ingest() { return { id: 'turn' }; } });
  const before = readFileSync(journal.path, 'utf8');
  await assert.rejects(runCoveredInterval({ journal, cursor: 'a', through: 'b', summaryPolicy: 'everything',
    session: { entries: [], conversation_id: 'fiction', scopes: ['private'], memory, distiller: { memory, async run() {} } } }), /invalid_input/);
  assert.equal(readFileSync(journal.path, 'utf8'), before);
  journal.close();
}));

test('a settle that ends on a compaction is processed through the message before it', async () => {
  const hooks = new Map();
  const seen = [];
  const entries = [user('u1', null, 'One.'), reply('a1', 'u1', 'One.'), compaction('c', 'a1', 'u1')];
  const { drain } = registerLiveMemory({ on: (name, handler) => hooks.set(name, handler) }, { controllerFor: async snapshot => { seen.push(snapshot.leafId); return null; } });
  hooks.get('agent_settled')({}, { sessionManager: { getSessionId: () => 's', getLeafId: () => 'c', getEntries: () => entries, getSessionFile: () => '/fiction' } });
  await drain();
  assert.deepEqual(seen, ['a1']);
});

const sdkPath = process.env.PI_SDK_MODULE;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const words = (label, count = 40) => `${label} ${Array.from({ length: count }, (_value, index) => `fiction${index}`).join(' ')}`;

function sessionWriter(manager) {
  return {
    say: (role, text) => manager.appendMessage(role === 'user' ? { role, content: text, timestamp: 1 }
      : { role, content: [{ type: 'text', text }], stopReason: 'stop', api: 'anthropic-messages', provider: 'fiction', model: 'model', timestamp: 1, usage }),
    turns(count, label) { for (let index = 0; index < count; index++) { this.say('user', words(`${label}-user-${index}`)); this.say('assistant', words(`${label}-reply-${index}`)); } },
  };
}

test('closure verdicts match what Pi itself summarizes across repeated, kept-region, split-turn and hook compactions', { skip: !sdkPath }, async () => {
  const pi = await import(pathToFileURL(sdkPath).href);
  const { prepareCompaction } = await import(new URL('./core/compaction/compaction.js', pathToFileURL(sdkPath)).href);
  // Oracle: a compaction is tainted when Pi feeds it a branch-summary or tainted text, or it comes from a hook.
  const scenarios = [
    [['turns', 3], ['compact', 60], ['turns', 2], ['compact', 60], ['turns', 1]],
    [['turns', 2], ['branch'], ['turns', 3], ['compact', 60], ['turns', 2], ['compact', 60], ['turns', 1]],
    [['turns', 2], ['branch'], ['turns', 1], ['compact', 400], ['turns', 2], ['compact', 60], ['turns', 1]],
    [['turns', 3], ['branch'], ['compact', 60], ['turns', 1]],
    [['turns', 3], ['compact', 60, true], ['turns', 2], ['compact', 60], ['turns', 1]],
    [['turns', 3], ['compact', 250], ['turns', 1], ['compact', 300], ['turns', 1]],
    [['turns', 3], ['compact', 250, true], ['turns', 1], ['compact', 300], ['turns', 1]],
    [['turns', 1], ['split', false], ['compact', 60], ['turns', 1]],
    [['turns', 1], ['split', true], ['compact', 60], ['turns', 1]],
  ];
  let checked = 0;
  for (const [index, script] of scenarios.entries()) {
    const manager = pi.SessionManager.inMemory('/fiction');
    const writer = sessionWriter(manager);
    const expected = new Map();
    for (const [step, value, flag] of script) {
      if (step === 'turns') writer.turns(value, `s${index}`);
      if (step === 'branch') expected.set(manager.branchWithSummary(manager.getLeafId(), 'BRANCH-MARKER abandoned fiction'), true);
      if (step === 'split') {
        writer.say('user', words('split-user'));
        if (value) expected.set(manager.branchWithSummary(manager.getLeafId(), 'BRANCH-MARKER inside a turn'), true);
        for (let reply = 0; reply < 6; reply++) writer.say('assistant', words(`split-reply-${reply}`));
      }
      if (step === 'compact') {
        const prep = prepareCompaction(manager.getBranch(), { enabled: true, reserveTokens: 16384, keepRecentTokens: value });
        assert.ok(prep, `scenario ${index} compaction was not prepared`);
        const fed = JSON.stringify([...prep.messagesToSummarize, ...prep.turnPrefixMessages]) + (prep.previousSummary ?? '');
        const tainted = flag === true || fed.includes('MARKER');
        expected.set(manager.appendCompaction(tainted ? 'TAINT-MARKER summary' : 'clean summary', prep.firstKeptEntryId, prep.tokensBefore, undefined, flag === true), tainted);
      }
    }
    const result = sourceInterval(manager.getEntries(), manager.getLeafId(), null, 'fiction', policy);
    const excluded = new Set(result.excludedSummaryIds);
    for (const [id, tainted] of expected) { assert.equal(excluded.has(id), tainted, `scenario ${index} entry ${id}`); checked++; }
    assert.deepEqual(contextMessages(pi, manager, []), manager.buildSessionContext().messages);
    assert.deepEqual(contextMessages(pi, manager, ['absent-id']), manager.buildSessionContext().messages);
    // Pi sends compaction and branch summaries to the model as user turns.
    assert.ok(['user', 'compactionSummary', 'branchSummary'].includes(contextMessages(pi, manager, result.excludedSummaryIds)[0]?.role), `scenario ${index}`);
    assert.equal(JSON.stringify(contextMessages(pi, manager, result.excludedSummaryIds)).includes('MARKER'), false, `scenario ${index}`);
  }
  assert.ok(checked >= 14);
});

test('the distiller never sends a withheld summary to the model, and an empty exclusion list is Pi\'s own context', { skip: !sdkPath }, () => privateDir(async directory => {
  const pi = await import(pathToFileURL(sdkPath).href);
  const sessions = join(directory, 'sessions');
  mkdirSync(sessions, { mode: 0o700 });
  const manager = pi.SessionManager.create(directory, sessions);
  const writer = sessionWriter(manager);
  writer.turns(1, 'first');
  manager.branchWithSummary(manager.getLeafId(), 'BRANCH-MARKER-TEXT abandoned fiction');
  writer.say('user', 'Kept fictional request.');
  const cursor = writer.say('assistant', 'Kept fictional reply.');
  const keep = manager.getBranch().find(row => row.message?.content === 'Kept fictional request.').id;
  manager.appendCompaction('HOOK-MARKER-TEXT extension summary', keep, 10, undefined, true);
  writer.say('user', 'Fictional request after compaction.');
  const leaf = writer.say('assistant', 'Fictional reply after compaction.');
  const { excludedSummaryIds } = sourceInterval(manager.getEntries(), leaf, cursor, 'fiction', policy);
  const model = { provider: 'fiction', id: 'model', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', contextWindow: 100000,
    maxTokens: 1000, input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const run = async (exclusions, createOptions = {}) => {
    const contexts = [], whole = [], firstRoles = [];
    let calls = 0;
    const runtime = { hasConfiguredAuth: () => true, streamSimple(_model, context) {
      contexts.push(JSON.stringify(context.messages.slice(0, -1 - calls), (key, value) => key === 'timestamp' ? undefined : value));
      whole.push(JSON.stringify(context));
      firstRoles.push(context.messages[0]?.role);
      const content = calls === 0 ? [{ type: 'toolCall', id: 's', name: 'memory_search', arguments: { query: 'fiction', kinds: [] } }]
        : calls === 1 ? [{ type: 'toolCall', id: 'd', name: 'memory_submit', arguments: { result: 'done_nothing_qualifies', reason: 'Fiction.' } }]
          : [{ type: 'text', text: 'Done.' }];
      const message = { role: 'assistant', provider: 'fiction', model: 'model', api: 'anthropic-messages', timestamp: 1, usage,
        stopReason: calls++ < 2 ? 'toolUse' : 'stop', content };
      return { result: async () => message, async *[Symbol.asyncIterator]() { yield { type: 'start', partial: message }; yield { type: 'done', reason: message.stopReason, message }; } };
    } };
    const work = mkdtempSync(join(directory, 'work-'));
    chmodSync(work, 0o700);
    const incremental = await createIncrementalSession({ source: manager.getSessionFile(), workDir: work });
    const distiller = await createPiDistiller({ pi, incremental, workDir: work, model, modelRuntime: runtime, memory: { async searchCompact() { return compactResult(); } },
      scope: 'fiction', createOptions });
    const result = await distiller.run({ throughEntryId: leaf, turn: { turn_id: 'fiction', entries: [{ id: 'u', role: 'user', text: 'Fictional request after compaction.' }] },
      receipt: { id: 'turn' }, ...(exclusions === undefined ? {} : { excludedSummaryIds: exclusions }) });
    return { result, contexts, whole, firstRoles };
  };
  const withheld = await run(excludedSummaryIds);
  const plain = await run(undefined);
  const empty = await run([]);
  assert.deepEqual([excludedSummaryIds.length, withheld.result.disposition, withheld.whole.some(text => text.includes('MARKER-TEXT')),
    plain.contexts.some(text => text.includes('HOOK-MARKER-TEXT')), empty.contexts[0] === plain.contexts[0], withheld.firstRoles.every(role => role === 'user')],
  [2, 'abstained', false, true, true, true]);
  const loader = new pi.DefaultResourceLoader({ cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  await assert.rejects(run(excludedSummaryIds, { resourceLoader: loader }), /summary_exclusion_unavailable/);
}));
