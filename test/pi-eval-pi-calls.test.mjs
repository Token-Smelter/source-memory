import test from 'node:test';
import assert from 'node:assert/strict';
import { createPiAnswererResponder, createPiScorerJudge, ANSWERER_TOOLS_SHA256 } from '../pi-extension/evaluation/pi-calls.mjs';
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
const message = (content, stopReason) => ({ role: 'assistant', provider: 'fiction', model: 'one', api: 'example', content, stopReason, timestamp: 1 });

test('fixed Pi answerer uses metered SDK calls and only declared retrieval tools', async () => {
  const fake = fakeMetered([message([{ type: 'toolCall', id: 'tc', name: 'memory_search', arguments: { query: 'fiction' } }], 'toolUse'),
    message([{ type: 'text', text: 'Fictional answer' }], 'stop')]);
  const respond = createPiAnswererResponder({ runtime: fake.wrapped, model: fictionalModel(), sessionId: 'fiction', expectedToolsSha256: ANSWERER_TOOLS_SHA256 });
  const result = await respond({ request: 'Fictional question', instructions: 'Use only the tools.', route: 'fiction', model: 'one', reasoning: 'low', outputTokens: 20, modelCalls: 2,
    tools: { async search() { return [{ id: 'r', text: 'derived item' }]; }, async resolve() {} } });
  assert.deepEqual([result.text, fake.attempts.length, fake.calls[0].context.messages[0].content,
    fake.calls[1].context.messages.at(-1).toolName, fake.calls[0].options.maxRetries], ['Fictional answer', 2, 'Fictional question', 'memory_search', 0]);
});

test('scorer makes a tool-free metered Pi SDK call and parses its JSON judgment', async () => {
  const fake = fakeMetered([message([{ type: 'text', text: '{"clauses":[]}' }], 'stop')]);
  const judge = createPiScorerJudge({ runtime: fake.wrapped, model: fictionalModel(), sessionId: 'fiction', outputTokens: 20 });
  const result = await judge({ packet: { caseId: 'fiction' }, answer: { text: 'answer' }, trace: {},
    scorer: { route: 'fiction', model: 'one', reasoning: 'low', instructions: 'Grade the packet.' }, rubric: {}, packetSchema: {} });
  assert.deepEqual([result, fake.calls[0].context.tools], [{ clauses: [] }, []]);
});

test('shared Pi gate prevents parallel calls and remains closed on unknown usage', async () => {
  let finish;
  const fake = fakeMetered([new Promise(resolve => { finish = resolve; })]);
  const gate = createSingleFlightGate();
  const first = gate.wrap(fake.wrapped);
  const second = gate.wrap(fake.wrapped);
  const stream = first.streamSimple(fictionalModel(), {}, { maxTokens: 20 });
  assert.throws(() => second.streamSimple(fictionalModel(), {}, { maxTokens: 20 }), /model_call_in_flight/);
  finish(message([{ type: 'text', text: 'fiction' }], 'stop'));
  await stream.result();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gate.busy(), true);
});

test('evaluation model calls reject an unmetered runtime', () => {
  assert.throws(() => createPiAnswererResponder({ runtime: { streamSimple() {} }, model: fictionalModel(), sessionId: 'fiction',
    expectedToolsSha256: ANSWERER_TOOLS_SHA256 }), /metered_pi_runtime_required/);
});
