import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnTools } from '../pi-extension/core.mjs';

const turn = { turn_id: 't', entries: [{ id: 'u', role: 'user', text: 'Fictional open question and fictional choice.' }] };
const toolsFor = (enrich, maxQuestions = 1) => createTurnTools({ scope: 'fiction', turn, receipt: { id: 'turn' }, maxQuestions, memory: { enrich } });

test('a capped turn rejects a second distinct question before any write and leaves other kinds unlimited', async () => {
  const writes = [];
  const tools = toolsFor(async (_scope, payload) => { writes.push(payload.records[0].kind); return {}; });
  await tools.record('question', 'First fictional question?', ['ref-000001']);
  await tools.record('question', 'First fictional question?', ['ref-000001']);
  await assert.rejects(tools.record('question', 'Second fictional question?', ['ref-000001']), /memory_question_cap/);
  await tools.record('decision', 'Fictional choice.', ['ref-000001']);
  await tools.record('observation', 'Fictional fact.', ['ref-000001']);
  assert.deepEqual(writes, ['question', 'question', 'decision', 'observation']);
});

test('a known failed question write releases its slot; an unknown write outcome keeps it held', async () => {
  let mode = 'known';
  const tools = toolsFor(async () => {
    if (mode === 'known') { mode = 'ok'; throw Object.assign(new Error('fictional_refusal'), { code: 'fictional_refusal' }); }
    if (mode === 'unknown') throw Object.assign(new Error('fictional_unknown'), { write_outcome_unknown: true });
    return {};
  });
  await assert.rejects(tools.record('question', 'Refused fictional question?', ['ref-000001']), /fictional_refusal/);
  await tools.record('question', 'Written fictional question?', ['ref-000001']);
  const held = toolsFor(async () => { throw Object.assign(new Error('fictional_unknown'), { write_outcome_unknown: true }); });
  await assert.rejects(held.record('question', 'Uncertain fictional question?', ['ref-000001']), /fictional_unknown/);
  await assert.rejects(held.record('question', 'Another fictional question?', ['ref-000001']), /memory_question_cap/);
});

test('a completed question write keeps its slot even when indexing then fails', async () => {
  const tools = createTurnTools({ scope: 'fiction', turn, receipt: { id: 'turn' }, maxQuestions: 1, memory: { async enrich() { return { indexing: { status: 'pending' } }; } },
    async ensureIndexed() { throw Object.assign(new Error('fictional_index_failure'), { code: 'fictional_index_failure' }); } });
  await assert.rejects(tools.record('question', 'Written fictional question?', ['ref-000001']), /fictional_index_failure/);
  await assert.rejects(tools.record('question', 'Later fictional question?', ['ref-000001']), /memory_question_cap/);
});

test('a zero cap refuses every new question; an absent cap leaves the default path uncapped', async () => {
  await assert.rejects(toolsFor(async () => ({}), 0).record('question', 'Fictional question?', ['ref-000001']), /memory_question_cap/);
  const open = toolsFor(async () => ({}), null);
  for (const text of ['One?', 'Two?', 'Three?']) await open.record('question', text, ['ref-000001']);
  assert.throws(() => toolsFor(async () => ({}), 17), /invalid_input/);
});
