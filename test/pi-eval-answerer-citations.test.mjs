import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnswerer, CITATION_PROTOCOL, UNKNOWN_ANSWER } from '../pi-extension/evaluation/answerer.mjs';
import { createPiAnswererResponder, ANSWERER_CITED_TOOLS_SHA256, ANSWERER_CITED_REPAIR } from '../pi-extension/evaluation/pi-calls.mjs';
import { sealComparison } from '../pi-extension/evaluation/seal.mjs';
import { fictionalCase, fictionalModel, fictionalSettings, scoringPacket } from '../pi-extension/evaluation/fictional.mjs';
import { createScorer } from '../pi-extension/evaluation/scorer.mjs';
import { wrapPiRuntime } from '../pi-extension/evaluation/pi-wrapper.mjs';

const citation = { item_id: 'item', evidence_id: 'source' };
function settings() {
  const value = fictionalSettings();
  value.answerer.citationProtocol = CITATION_PROTOCOL;
  value.answerer.version = 'answerer-r2-v5';
  return value;
}
function fixture({ rows = [], respond, resolve } = {}) {
  const seal = sealComparison(settings());
  return createAnswerer({ seal, expectedDigest: seal.digest,
    memory: { async search() { return rows; }, async resolve(request) { return resolve ? resolve(request) : { id: request.evidenceId, scope: 'fiction', text: 'Fictional source.' }; } },
    archive: { async search() { return []; } }, respond });
}
const item = { id: 'item', scope: 'fiction', text: 'Fictional memory.', evidence: [{ id: 'source', scope: 'fiction' }] };

test('empty memory replaces unsupported guesses with an explicit unknown and records the guard', async () => {
  const answerer = fixture({ async respond({ tools }) { await tools.search('fiction'); return { text: 'A fabricated answer.', citations: [] }; } });
  const result = await answerer.run({ arm: 'empty', case: fictionalCase() });
  assert.deepEqual([result.answer, result.trace.abstention], [{ text: UNKNOWN_ANSWER, citations: [] }, 'host_enforced_no_citations']);
});

test('irrelevant retrieved items without citations do not become guesses', async () => {
  const answerer = fixture({ rows: [item], async respond({ tools }) { await tools.search('fiction'); return { text: 'A speculative answer.', citations: [] }; } });
  const result = await answerer.run({ arm: 'candidate', case: fictionalCase() });
  assert.deepEqual([result.answer.text, result.trace.returnedItems, result.trace.abstention], [UNKNOWN_ANSWER, 1, 'host_enforced_no_citations']);
});

test('successfully returned evidence supports a machine-readable citation', async () => {
  const answerer = fixture({ rows: [item], async respond({ tools }) {
    await tools.search('fiction'); await tools.resolve('item', 'source');
    return { text: 'A fictional answer.', citations: [citation] };
  } });
  const result = await answerer.run({ arm: 'candidate', case: fictionalCase() });
  assert.deepEqual([result.answer, result.trace.citations, result.trace.returnedEvidence, result.trace.abstention],
    [{ text: 'A fictional answer.', citations: [citation] }, [citation], [citation], 'not_enforced']);
});

for (const [name, run, expected] of [
  ['unresolved', async tools => { await tools.search('fiction'); return [citation]; }, /citation_not_returned/],
  ['wrong-item', async tools => { await tools.search('fiction'); await tools.resolve('item', 'source'); return [{ item_id: 'other', evidence_id: 'source' }]; }, /citation_not_returned/],
  ['duplicate', async tools => { await tools.search('fiction'); await tools.resolve('item', 'source'); return [citation, citation]; }, /citation_not_returned/],
]) test(`${name} evidence cannot be cited`, async () => {
  const answerer = fixture({ rows: [item], async respond({ tools }) { return { text: 'Fiction.', citations: await run(tools) }; } });
  await assert.rejects(answerer.run({ arm: 'candidate', case: fictionalCase() }), expected);
});

test('out-of-scope evidence is never resolved or citable', async () => {
  let resolves = 0;
  const foreign = { ...item, evidence: [{ id: 'source', scope: 'other' }] };
  const answerer = fixture({ rows: [foreign], resolve() { resolves++; }, async respond({ tools }) {
    await tools.search('fiction');
    assert.throws(() => tools.resolve('item', 'source'), /not_offered/);
    return { text: 'Fiction.', citations: [citation] };
  } });
  await assert.rejects(answerer.run({ arm: 'candidate', case: fictionalCase() }), /citation_not_returned/);
  assert.equal(resolves, 0);
});

test('a failed evidence resolution never becomes citable', async () => {
  const answerer = fixture({ rows: [item], resolve() { throw new Error('source_unavailable'); }, async respond({ tools }) {
    await tools.search('fiction'); await assert.rejects(tools.resolve('item', 'source'), /source_unavailable/);
    return { text: 'Fiction.', citations: [citation] };
  } });
  await assert.rejects(answerer.run({ arm: 'candidate', case: fictionalCase() }), /citation_not_returned/);
});

test('an empty resolved source cannot support a citation', async () => {
  const answerer = fixture({ rows: [item], resolve(request) { return { id: request.evidenceId, scope: 'fiction', text: '  ' }; }, async respond({ tools }) {
    await tools.search('fiction'); await assert.rejects(tools.resolve('item', 'source'), /evidence_scope_invalid/);
    return { text: 'Fiction.', citations: [citation] };
  } });
  await assert.rejects(answerer.run({ arm: 'candidate', case: fictionalCase() }), /citation_not_returned/);
});

test('a citation-bound answer requires an actual search', async () => {
  const answerer = fixture({ async respond() { return { text: 'Unknown.', citations: [] }; } });
  await assert.rejects(answerer.run({ arm: 'candidate', case: fictionalCase() }), /answer_invalid/);
});

test('raw-only diagnostics cite a directly returned source using its returned id', async () => {
  const seal = sealComparison(settings());
  const answerer = createAnswerer({ seal, expectedDigest: seal.digest,
    memory: { async search() { throw new Error('derived_forbidden'); }, async resolve() { throw new Error('resolve_forbidden'); } },
    archive: { async search() { return [{ id: 'raw', scope: 'fiction', text: 'Fictional source.' }]; } },
    async respond({ tools }) { await tools.search('fiction'); return { text: 'Fiction.', citations: [{ item_id: 'raw', evidence_id: 'raw' }] }; } });
  const result = await answerer.run({ arm: 'raw-only', case: fictionalCase() });
  assert.deepEqual([result.answer.citations, result.diagnostic], [[{ item_id: 'raw', evidence_id: 'raw' }], true]);
});

test('scoring refuses citations or unknown text altered after answer generation', async () => {
  const seal = sealComparison(settings());
  const answerer = createAnswerer({ seal, expectedDigest: seal.digest, memory: { async search() { return [item]; },
    async resolve(request) { return { id: request.evidenceId, scope: 'fiction', text: 'Fictional source.' }; } },
    archive: { async search() { return []; } }, async respond({ tools }) {
      await tools.search('fiction'); await tools.resolve('item', 'source'); return { text: 'Fiction.', citations: [citation] };
    } });
  const result = await answerer.run({ arm: 'candidate', case: fictionalCase() });
  const scorer = createScorer({ seal, expectedDigest: seal.digest, async judge() { return { clauses: [] }; } });
  const changed = { ...result.answer, citations: [] };
  await assert.rejects(scorer.score({ packet: scoringPacket(), answer: changed, trace: result.trace }), /citation_trace_invalid/);
  const trace = { ...result.trace, returnedEvidence: [] };
  await assert.rejects(scorer.score({ packet: scoringPacket(), answer: result.answer, trace }), /citation_trace_invalid/);
  const empty = await fixture({ async respond({ tools }) { await tools.search('fiction'); return { text: 'Unknown.', citations: [] }; } })
    .run({ arm: 'empty', case: fictionalCase() });
  await assert.rejects(scorer.score({ packet: scoringPacket(), answer: { text: 'Forged claim.', citations: [] }, trace: empty.trace }), /citation_trace_invalid/);
});

test('raw-only repeated ids are rejected before citation identity becomes ambiguous', async () => {
  const seal = sealComparison(settings());
  const answerer = createAnswerer({ seal, expectedDigest: seal.digest,
    memory: { async search() { return []; }, async resolve() {} },
    archive: { async search() { return [{ id: 'raw', scope: 'fiction', text: 'Fiction.' }]; } },
    async respond({ tools }) { await tools.search('one'); await tools.search('two'); return { text: 'Fiction.', citations: [] }; } });
  await assert.rejects(answerer.run({ arm: 'raw-only', case: fictionalCase() }), /duplicate_item/);
});

test('legacy uncited answerers cannot execute through the fixed answerer', () => {
  const value = fictionalSettings(); delete value.answerer.citationProtocol;
  const seal = sealComparison(value);
  assert.throws(() => createAnswerer({ seal, expectedDigest: seal.digest,
    memory: { async search() {}, async resolve() {} }, archive: { async search() {} }, async respond() {} }), /citation_protocol_required/);
});

test('unknown citation protocol or an unbound v5 answerer cannot be sealed', () => {
  const bad = settings(); bad.answerer.citationProtocol = 'unverified';
  const missing = settings(); delete missing.answerer.citationProtocol;
  assert.throws(() => sealComparison(bad), /settings_invalid/);
  assert.throws(() => sealComparison(missing), /settings_invalid/);
});

function metered(responses, mutate = null) {
  const calls = [];
  const runtime = { streamSimple(_model, context) {
    calls.push(structuredClone(context));
    mutate?.(context);
    const promise = Promise.resolve(responses.shift());
    return { result: () => promise, async *[Symbol.asyncIterator]() {} };
  } };
  const ledger = { startSlot() {}, recordResult() {}, recordUnknown() {} };
  return { calls, runtime: wrapPiRuntime({ runtime, ledger, planId: 'fiction', nextSlot: () => `slot-${calls.length}`,
    boundInput: () => ({ tokens: 10, providerBound: true, proofRef: 'fiction', contextFingerprint: 'a'.repeat(64) }) }) };
}
const message = content => ({ role: 'assistant', provider: 'fiction', model: 'one', api: 'example', content, stopReason: 'toolUse', timestamp: 1,
  usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1, cost: { total: 0 } } });
const tool = (id, name, args) => message([{ type: 'toolCall', id, name, arguments: args }]);

test('Pi answerer keeps the raw guess while the host returns an explicit unknown', async () => {
  const fake = metered([tool('search', 'memory_search', { query: 'fiction' }),
    tool('submit', 'submit_answer', { answer: 'A fabricated answer.', citations: [] })]);
  const value = settings(); value.answerer.tools_sha256 = ANSWERER_CITED_TOOLS_SHA256; value.answerer.repair_instruction = ANSWERER_CITED_REPAIR;
  const seal = sealComparison(value), raw = [];
  const respond = createPiAnswererResponder({ runtime: fake.runtime, model: fictionalModel(), sessionId: 'fiction',
    expectedToolsSha256: ANSWERER_CITED_TOOLS_SHA256, async onRaw(value) { raw.push(value); } });
  const answerer = createAnswerer({ seal, expectedDigest: seal.digest, memory: { async search() { return []; }, async resolve() {} },
    archive: { async search() { return []; } }, respond });
  const result = await answerer.run({ arm: 'empty', case: fictionalCase() });
  assert.deepEqual([result.answer.text, result.trace.abstention, raw.at(-1).message.content[0].arguments.answer],
    [UNKNOWN_ANSWER, 'host_enforced_no_citations', 'A fabricated answer.']);
});

test('answerer refuses a mutated tool schema before the next model call', async () => {
  const fake = metered([tool('search', 'memory_search', { query: 'fiction' })], context => { context.tools[0].description = 'changed'; });
  const respond = createPiAnswererResponder({ runtime: fake.runtime, model: fictionalModel(), sessionId: 'fiction', expectedToolsSha256: ANSWERER_CITED_TOOLS_SHA256 });
  await assert.rejects(respond({ request: 'Fiction?', instructions: 'Use the tools.', route: 'fiction', model: 'one', reasoning: 'low',
    inputTokens: 100, costNano: '10000', outputTokens: 20, modelCalls: 2,
    tools: { async search() { return []; }, async resolve() {} }, validateAnswer() {} }), /answerer_tools_mismatch/);
  assert.equal(fake.calls.length, 1);
});

test('Pi answerer repairs an unreturned citation once using the same bounded tools', async () => {
  const fake = metered([tool('search', 'memory_search', { query: 'fiction' }), tool('resolve', 'memory_resolve', { item_id: 'item', evidence_id: 'source' }),
    tool('bad', 'submit_answer', { answer: 'Fiction.', citations: [{ item_id: 'item', evidence_id: 'invented' }] }),
    tool('good', 'submit_answer', { answer: 'Fiction.', citations: [citation] })]);
  const value = settings(); value.answerer.limits.modelCalls = 4; value.answerer.limits.inputTokens = 1000;
  value.answerer.tools_sha256 = ANSWERER_CITED_TOOLS_SHA256; value.answerer.repair_instruction = ANSWERER_CITED_REPAIR;
  const seal = sealComparison(value);
  const respond = createPiAnswererResponder({ runtime: fake.runtime, model: fictionalModel(), sessionId: 'fiction', expectedToolsSha256: ANSWERER_CITED_TOOLS_SHA256 });
  const answerer = createAnswerer({ seal, expectedDigest: seal.digest, memory: { async search() { return [item]; },
    async resolve(request) { return { id: request.evidenceId, scope: 'fiction', text: 'Fictional source.' }; } },
    archive: { async search() { throw new Error('raw_forbidden'); } }, respond });
  const result = await answerer.run({ arm: 'candidate', case: fictionalCase() });
  assert.deepEqual([result.answer.citations, fake.calls.length, fake.calls[3].messages.at(-1).content], [[citation], 4, ANSWERER_CITED_REPAIR]);
});
