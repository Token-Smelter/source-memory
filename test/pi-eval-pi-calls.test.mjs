import test from 'node:test';
import assert from 'node:assert/strict';
import { createPiAnswererResponder, createPiScorerJudge, createPiScorerSpecificRepair, ANSWERER_TOOLS_SHA256 } from '../pi-extension/evaluation/pi-calls.mjs';
import { createSingleFlightGate, wrapPiRuntime } from '../pi-extension/evaluation/pi-wrapper.mjs';
import { fictionalModel } from '../pi-extension/evaluation/fictional.mjs';

function fakeMetered(responses) {
  const calls = [], attempts = [];
  const runtime = { streamSimple(model, context, options) {
    calls.push({ model, context: structuredClone(context), options });
    const promise = Promise.resolve(responses.shift());
    return { result: () => promise, async *[Symbol.asyncIterator]() {} };
  } };
  const ledger = { startSlot(_plan, slot) { attempts.push(slot); }, recordResult() {}, recordUnknown() {} };
  const wrapped = wrapPiRuntime({ runtime, ledger, planId: 'fiction', nextSlot: () => `call-${attempts.length}`,
    boundInput: () => ({ tokens: 10, providerBound: true, proofRef: 'fictional-bound', contextFingerprint: 'a'.repeat(64) }) });
  return { wrapped, calls, attempts };
}
const message = (content, stopReason) => ({ role: 'assistant', provider: 'fiction', model: 'one', api: 'example', content, stopReason, timestamp: 1,
  usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1, cost: { total: 0 } } });

test('fixed Pi answerer uses metered SDK calls and only declared retrieval tools', async () => {
  const fake = fakeMetered([message([{ type: 'toolCall', id: 'tc', name: 'memory_search', arguments: { query: 'fiction' } }], 'toolUse'),
    message([{ type: 'toolCall', id: 'submit', name: 'submit_answer', arguments: { answer: 'Fictional answer' } }], 'toolUse')]);
  const respond = createPiAnswererResponder({ runtime: fake.wrapped, model: fictionalModel(), sessionId: 'fiction', expectedToolsSha256: ANSWERER_TOOLS_SHA256 });
  const result = await respond({ request: 'Fictional question', instructions: 'Use only the tools.', route: 'fiction', model: 'one', reasoning: 'low', inputTokens: 100, costNano: '10000', outputTokens: 20, modelCalls: 2,
    tools: { async search() { return [{ id: 'r', text: 'derived item' }]; }, async resolve() {} } });
  assert.deepEqual([result.text, fake.attempts.length, fake.calls[0].context.messages[0].content,
    fake.calls[1].context.messages.at(-1).toolName, fake.calls[0].options.maxRetries], ['Fictional answer', 2, 'Fictional question', 'memory_search', 0]);
});

test('the fixed item limit is returned as a tool result without another retrieval', async () => {
  const fake = fakeMetered([message([{ type: 'toolCall', id: 'one', name: 'memory_search', arguments: { query: 'fiction one' } },
    { type: 'toolCall', id: 'two', name: 'memory_search', arguments: { query: 'fiction two' } }], 'toolUse'),
    message([{ type: 'toolCall', id: 'submit', name: 'submit_answer', arguments: { answer: 'Uncertain.' } }], 'toolUse')]);
  let calls = 0, retrievals = 0;
  const respond = createPiAnswererResponder({ runtime: fake.wrapped, model: fictionalModel(), sessionId: 'fiction', expectedToolsSha256: ANSWERER_TOOLS_SHA256 });
  const result = await respond({ request: 'Fiction?', instructions: 'Use the tools.', route: 'fiction', model: 'one', reasoning: 'low',
    inputTokens: 100, costNano: '10000', outputTokens: 20, modelCalls: 2,
    tools: { async search() { calls++; if (calls === 2) throw Object.assign(new Error('item_limit'), { code: 'item_limit' }); retrievals++; return Array(12).fill({ id: 'fixture' }); }, async resolve() {} } });
  const toolReply = fake.calls[1].context.messages.find(row => row.role === 'toolResult' && row.toolCallId === 'two');
  assert.deepEqual([result.text, retrievals, JSON.parse(toolReply.content[0].text).status], ['Uncertain.', 1, 'item_budget_exhausted']);
});

test('scorer uses a structured metered Pi SDK judgment submission', async () => {
  const fake = fakeMetered([message([{ type: 'toolCall', id: 'score', name: 'submit_score', arguments: { clauses: [] } }], 'toolUse')]);
  const judge = createPiScorerJudge({ runtime: fake.wrapped, model: fictionalModel(), sessionId: 'fiction', outputTokens: 20 });
  const result = await judge({ packet: { caseId: 'fiction' }, answer: { text: 'answer' }, trace: {},
    scorer: { route: 'fiction', model: 'one', reasoning: 'low', instructions: 'Grade the packet.' }, rubric: {}, packetSchema: {} });
  assert.deepEqual([result, fake.calls[0].context.tools.map(tool => tool.name)], [{ clauses: [] }, ['submit_score']]);
});

test('answerer preserves raw outputs and makes exactly one repair after an invalid submission', async () => {
  const fake = fakeMetered([message([{ type: 'text', text: 'Fictional answer' }], 'stop'),
    message([{ type: 'toolCall', id: 'submit', name: 'submit_answer', arguments: { answer: 'Fictional answer' } }], 'toolUse')]);
  const captured = [];
  const respond = createPiAnswererResponder({ runtime: fake.wrapped, model: fictionalModel(), sessionId: 'fiction',
    expectedToolsSha256: ANSWERER_TOOLS_SHA256, async onRaw(value) { captured.push(value); } });
  const result = await respond({ request: 'Fiction?', instructions: 'Use the tools.', route: 'fiction', model: 'one', reasoning: 'low',
    inputTokens: 100, costNano: '10000', outputTokens: 20, modelCalls: 1, tools: { async search() {}, async resolve() {} } });
  assert.deepEqual([result.text, captured.length, fake.calls.length], ['Fictional answer', 2, 2]);
});

test('scorer repairs one truncated judgment and records both outputs', async () => {
  const fake = fakeMetered([message([{ type: 'text', text: 'invalid' }], 'length'),
    message([{ type: 'toolCall', id: 'score', name: 'submit_score', arguments: { clauses: [] } }], 'toolUse')]);
  const captured = [];
  const judge = createPiScorerJudge({ runtime: fake.wrapped, model: fictionalModel(), sessionId: 'fiction', outputTokens: 20,
    async onRaw(value) { captured.push(value); } });
  const result = await judge({ packet: { caseId: 'fiction' }, answer: { text: 'answer' }, trace: {},
    scorer: { route: 'fiction', model: 'one', reasoning: 'low', instructions: 'Grade.' }, rubric: {}, packetSchema: {} });
  assert.deepEqual([result, captured.length, fake.calls.length], [{ clauses: [] }, 2, 2]);
});

test('scorer refuses a second invalid judgment rather than fabricating a score', async () => {
  const fake = fakeMetered([message([{ type: 'text', text: 'invalid' }], 'stop'), message([{ type: 'text', text: 'still invalid' }], 'stop')]);
  const judge = createPiScorerJudge({ runtime: fake.wrapped, model: fictionalModel(), sessionId: 'fiction', outputTokens: 20 });
  await assert.rejects(judge({ packet: { caseId: 'fiction' }, answer: { text: 'answer' }, trace: {},
    scorer: { route: 'fiction', model: 'one', reasoning: 'low', instructions: 'Grade.' }, rubric: {}, packetSchema: {} }), /scorer_output_invalid/);
});

test('specific scorer repair makes one call bound to the offending clause', async () => {
  const clause = { id: 'fiction-clause', text: 'fiction', requirementIds: [], sourceIds: [], action: true,
    judgments: { support: 'pass', authority: 'pass', scope: 'pass', time: 'pass', uncertainty: 'pass' }, alternative: null, relation: null };
  const previousMessage = message([{ type: 'toolCall', id: 'old', name: 'submit_score', arguments: { clauses: [clause] } }], 'toolUse');
  const repaired = structuredClone(clause); repaired.judgments.support = 'uncertain';
  const fake = fakeMetered([message([{ type: 'toolCall', id: 'new', name: 'submit_score', arguments: { clauses: [repaired] } }], 'toolUse')]);
  const judge = createPiScorerSpecificRepair({ runtime: fake.wrapped, model: fictionalModel(), sessionId: 'fiction', outputTokens: 20 });
  const result = await judge({ packet: {}, answer: { text: 'fiction' }, trace: {}, scorer: { route: 'fiction', model: 'one', instructions: 'Grade.' },
    rubric: {}, packetSchema: {}, previousMessage, clauseId: clause.id, validate() {} });
  assert.deepEqual([result.clauses[0].judgments.support, fake.calls.length, fake.calls[0].context.messages.at(-1).content.includes('fiction-clause')],
    ['uncertain', 1, true]);
});

test('one specific repair names all unsupported pass clauses without choosing their verdicts', async () => {
  const make = id => ({ id, text: 'fiction', requirementIds: [], sourceIds: [], action: false,
    judgments: { support: 'pass', authority: 'pass', scope: 'pass', time: 'pass', uncertainty: 'pass' }, alternative: null, relation: null });
  const previousMessage = message([{ type: 'toolCall', id: 'old', name: 'submit_score', arguments: { clauses: [make('a'), make('b')] } }], 'toolUse');
  const fake = fakeMetered([message([{ type: 'toolCall', id: 'new', name: 'submit_score', arguments: { clauses: [] } }], 'toolUse')]);
  const judge = createPiScorerSpecificRepair({ runtime: fake.wrapped, model: fictionalModel(), sessionId: 'fiction', outputTokens: 20 });
  const result = await judge({ packet: {}, answer: { text: 'fiction' }, trace: {}, scorer: { route: 'fiction', model: 'one', instructions: 'Grade.' },
    rubric: {}, packetSchema: {}, previousMessage, clauseIds: ['a', 'b'], validate() {} });
  const instruction = fake.calls[0].context.messages.at(-1).content;
  assert.deepEqual([result.clauses.length, fake.calls.length, instruction.includes('["a","b"]'), instruction.includes('fail or uncertain')], [0, 1, true, true]);
});

test('specific scorer repair does not silently correct a still-invalid judgment', async () => {
  const clause = { id: 'fiction-clause', text: 'fiction', requirementIds: [], sourceIds: [], action: true,
    judgments: { support: 'pass', authority: 'pass', scope: 'pass', time: 'pass', uncertainty: 'pass' }, alternative: null, relation: null };
  const previousMessage = message([{ type: 'toolCall', id: 'old', name: 'submit_score', arguments: { clauses: [clause] } }], 'toolUse');
  const fake = fakeMetered([message([{ type: 'toolCall', id: 'new', name: 'submit_score', arguments: { clauses: [clause] } }], 'toolUse')]);
  const judge = createPiScorerSpecificRepair({ runtime: fake.wrapped, model: fictionalModel(), sessionId: 'fiction', outputTokens: 20 });
  await assert.rejects(judge({ packet: {}, answer: { text: 'fiction' }, trace: {}, scorer: { route: 'fiction', model: 'one', instructions: 'Grade.' },
    rubric: {}, packetSchema: {}, previousMessage, clauseId: clause.id,
    validate() { throw Object.assign(new Error('judgment_invalid'), { code: 'judgment_invalid' }); } }), /scorer_output_invalid/);
  assert.equal(fake.calls.length, 1);
});

test('shared Pi gate prevents parallel calls and remains closed on unknown usage', async () => {
  let finish;
  const fake = fakeMetered([new Promise(resolve => { finish = resolve; })]);
  const gate = createSingleFlightGate();
  const first = gate.wrap(fake.wrapped);
  const second = gate.wrap(fake.wrapped);
  const stream = first.streamSimple(fictionalModel(), {}, { maxTokens: 20 });
  assert.throws(() => second.streamSimple(fictionalModel(), {}, { maxTokens: 20 }), /model_call_in_flight/);
  finish({ ...message([{ type: 'text', text: 'fiction' }], 'stop'), usage: null });
  await stream.result();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gate.busy(), true);
});

test('evaluation model calls reject an unmetered runtime', () => {
  assert.throws(() => createPiAnswererResponder({ runtime: { streamSimple() {} }, model: fictionalModel(), sessionId: 'fiction',
    expectedToolsSha256: ANSWERER_TOOLS_SHA256 }), /metered_pi_runtime_required/);
});
