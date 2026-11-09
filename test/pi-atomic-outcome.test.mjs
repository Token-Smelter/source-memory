import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnTools } from '../pi-extension/core.mjs';
import { createMemoryHandlers } from '../pi-extension/memory-process.mjs';
import { compactResult } from './helpers/compact-fixture.mjs';

function fixture({ approve = true, priorKind = 'action' } = {}) {
  const calls = [], writes = [], reviews = [];
  const prior = { id: `prior-${priorKind}`, kind: priorKind, text: `A fictional ${priorKind}`, status: 'proposed', attribution: 'fiction',
    evidence: [{ turn: 'prior-turn', entry_id: 'p', start: 0, end: 7 }] };
  const memory = { async recall() { return { status: 'ready', budget_omitted: 0, bundles: [{ records: [prior] }] }; },
    async show(_scope, input) { return input.kind === 'turn' ? { turn: { id: 'turn', source: 'pi-memory', entries: [] } } : { record: prior }; },
    async evidence(_scope, spans) { return spans.map(() => ({ role: 'user', text: 'fiction' })); },
    async enrich(_scope, payload) { calls.push('write'); writes.push(payload); return { records: payload.records.map(row => row.id), relations: payload.relations.map(row => row.id), indexing: { status: 'ready' } }; } };
  const handlers = createMemoryHandlers({ memory, scopes: ['fiction'], beforeAppend: async plan => { calls.push('intent');
    return { accepted: true, operation_id: plan.operation_id, append_sha256: plan.append_sha256 }; } });
  const client = { async searchCompact(scope, input, trigger) {
    const found = await handlers.recall({ scope, input, trigger });
    return compactResult({ records: found.bundles.flatMap(row => row.records) });
  },
    beginOutcome: (scope, trigger, outcome, new_action, action_handle) => handlers.beginOutcome({ scope, trigger, outcome, new_action, action_handle }),
    applyOutcome: (scope, token, review) => handlers.applyOutcome({ scope, token, review }),
    cancelOutcome: token => handlers.cancelOutcome({ token }) };
  const reviewer = { async review(input) { calls.push('review'); reviews.push(input); return { reviewer: 'fiction', decision_ref: 'review', approved: approve ? [0] : [] }; } };
  const tools = createTurnTools({ scope: 'fiction', turn: { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'fictional evidence' }] },
    receipt: { id: 'turn' }, memory: client, reviewer, requireSearch: true });
  return { tools, calls, writes, reviews, handlers };
}

test('a new action and its outcome commit together in one atomic write', async () => {
  const f = fixture();
  try {
    await f.tools.search('fiction', []);
    const result = await f.tools.record('outcome', 'fictional result', ['ref-000001'],
      { new_action: { text: 'fictional action', evidence_labels: ['ref-000001'] } });
    assert.deepEqual([result.status, f.calls, f.writes[0].records.map(row => row.kind), f.writes[0].relations[0].type],
      ['proposed', ['intent', 'write'], ['action', 'outcome'], 'outcome_of']);
  } finally { f.handlers.close(); }
});

test('an outcome to an offered prior action is reviewed before the atomic commit', async () => {
  const f = fixture();
  try {
    const search = await f.tools.search('fiction', []);
    await f.tools.record('outcome', 'fictional result', ['ref-000001'], { action_handle: search.records[0].action_handle });
    assert.deepEqual([f.calls, f.writes[0].records.map(row => row.kind), f.writes[0].relations[0].to],
      [['review', 'intent', 'write'], ['outcome'], 'prior-action']);
  } finally { f.handlers.close(); }
});

for (const priorKind of ['decision', 'intention']) {
  test(`an outcome to an offered prior ${priorKind} is reviewed as that kind before the atomic commit`, async () => {
    const f = fixture({ priorKind });
    try {
      const search = await f.tools.search('fiction', []);
      await f.tools.record('outcome', 'fictional result', ['ref-000001'], { action_handle: search.records[0].action_handle });
      assert.deepEqual([f.calls, f.reviews[0].proposal.packet.records.map(row => row.kind), f.writes[0].records.map(row => row.kind),
        f.writes[0].relations[0].to], [['review', 'intent', 'write'], ['outcome', priorKind], ['outcome'], `prior-${priorKind}`]);
    } finally { f.handlers.close(); }
  });
}

test('a prior question is offered no outcome referent handle', async () => {
  const f = fixture({ priorKind: 'question' });
  try {
    const search = await f.tools.search('fiction', []);
    assert.equal(search.records[0].action_handle, undefined);
  } finally { f.handlers.close(); }
});

test('a rejected prior-action outcome review performs no write', async () => {
  const f = fixture({ approve: false });
  try {
    const search = await f.tools.search('fiction', []);
    const result = await f.tools.record('outcome', 'fictional result', ['ref-000001'], { action_handle: search.records[0].action_handle });
    assert.deepEqual([result.status, f.calls, f.writes.length], ['refused', ['review'], 0]);
  } finally { f.handlers.close(); }
});

test('an outcome without an offered or new action is refused before a write', async () => {
  const f = fixture();
  try {
    await f.tools.search('fiction', []);
    await assert.rejects(f.tools.record('outcome', 'fictional result', ['ref-000001']), /outcome_referent_required/);
    assert.equal(f.writes.length, 0);
  } finally { f.handlers.close(); }
});
