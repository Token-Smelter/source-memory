import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnswerer, CITATION_PROTOCOL, UNKNOWN_ANSWER, citationId, rawEvidenceId, textSha256 } from '../pi-extension/evaluation/answerer.mjs';
import { createPiAnswererResponder, createPiScorerJudge, createPiScorerSpecificRepair, ANSWERER_CITED_TOOLS_SHA256, ANSWERER_CITED_REPAIR, CITATION_FEEDBACK,
  SCORER_GROUNDED_TOOLS_SHA256, SCORER_GROUNDED_REPAIR } from '../pi-extension/evaluation/pi-calls.mjs';
import { hash, sealComparison } from '../pi-extension/evaluation/seal.mjs';
import { fictionalCase, fictionalModel, fictionalSettings, scoringPacket } from '../pi-extension/evaluation/fictional.mjs';
import { createScorer, scoreCase } from '../pi-extension/evaluation/scorer.mjs';
import { wrapPiRuntime } from '../pi-extension/evaluation/pi-wrapper.mjs';
import { GROUNDING_PROTOCOL, CITED_RUBRIC_VERSION, CITED_RUBRIC, CITED_WORKED_EXAMPLES } from '../pi-extension/evaluation/rubric.mjs';

const citation = { item_id: 'item', evidence_id: 'source' };
function settings() {
  const value = fictionalSettings();
  value.answerer.citationProtocol = CITATION_PROTOCOL;
  value.answerer.version = 'answerer-r2-v5';
  value.answerer.tools_sha256 = ANSWERER_CITED_TOOLS_SHA256;
  value.answerer.repair_instruction = ANSWERER_CITED_REPAIR;
  value.answerer.limits.formatRepairCalls = 1;
  value.scorer.version = 'scorer-r2-v3-grounded';
  value.scorer.groundingProtocol = GROUNDING_PROTOCOL;
  value.scorer.tools_sha256 = SCORER_GROUNDED_TOOLS_SHA256;
  value.scorer.repair_instruction = SCORER_GROUNDED_REPAIR;
  value.scorer.formatRepairCalls = 1;
  value.rubric = { version: CITED_RUBRIC_VERSION, instructions: CITED_RUBRIC, examples: CITED_WORKED_EXAMPLES };
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
  assert.deepEqual([result.answer, result.trace.citations, result.trace.returnedEvidence, result.trace.citedEvidence, result.trace.abstention],
    [{ text: 'A fictional answer.', citations: [citation] }, [citation],
      [{ ...citation, scope: 'fiction', text_sha256: textSha256('Fictional source.') }],
      [{ citation_id: citationId('item', 'source'), ...citation, scope: 'fiction', text_sha256: textSha256('Fictional source.'), text: 'Fictional source.' }], 'not_enforced']);
});

test('only cited returned evidence text enters the scorer-side trace', async () => {
  const multi = { ...item, evidence: [{ id: 'source', scope: 'fiction' }, { id: 'uncited', scope: 'fiction' }] };
  const answerer = fixture({ rows: [multi], resolve(request) { return { id: request.evidenceId, scope: 'fiction', text: `Fiction ${request.evidenceId}` }; },
    async respond({ tools }) { await tools.search('fiction'); await tools.resolve('item', 'source'); await tools.resolve('item', 'uncited');
      return { text: 'Fiction.', citations: [citation] }; } });
  const result = await answerer.run({ arm: 'candidate', case: fictionalCase() });
  assert.deepEqual([result.trace.returnedEvidence.length, result.trace.citedEvidence.map(row => row.text),
    result.trace.returnedEvidence.every(row => !Object.hasOwn(row, 'text'))], [2, ['Fiction source'], true]);
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

test('a swallowed retrieval failure cannot become an abstention', async () => {
  const seal = sealComparison(settings());
  const answerer = createAnswerer({ seal, expectedDigest: seal.digest,
    memory: { async search() { throw new Error('transport_failed'); }, async resolve() {} }, archive: { async search() { return []; } },
    async respond({ tools }) { await assert.rejects(tools.search('fiction'), /transport_failed/); return { text: 'Unknown.', citations: [] }; } });
  await assert.rejects(answerer.run({ arm: 'candidate', case: fictionalCase() }), /retrieval_failed/);
});

test('a failed evidence resolution never becomes citable', async () => {
  const answerer = fixture({ rows: [item], resolve() { throw new Error('source_unavailable'); }, async respond({ tools }) {
    await tools.search('fiction'); await assert.rejects(tools.resolve('item', 'source'), /source_unavailable/);
    return { text: 'Fiction.', citations: [citation] };
  } });
  await assert.rejects(answerer.run({ arm: 'candidate', case: fictionalCase() }), /retrieval_failed/);
});

test('an empty resolved source cannot support a citation', async () => {
  const answerer = fixture({ rows: [item], resolve(request) { return { id: request.evidenceId, scope: 'fiction', text: '  ' }; }, async respond({ tools }) {
    await tools.search('fiction'); await assert.rejects(tools.resolve('item', 'source'), /evidence_scope_invalid/);
    return { text: 'Fiction.', citations: [citation] };
  } });
  await assert.rejects(answerer.run({ arm: 'candidate', case: fictionalCase() }), /retrieval_failed/);
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
    async respond({ tools }) { const [row] = await tools.search('fiction');
      return { text: 'Fiction.', citations: [{ item_id: 'raw', evidence_id: row.evidence[0].id }] }; } });
  const result = await answerer.run({ arm: 'raw-only', case: fictionalCase() });
  assert.deepEqual([result.answer.citations, result.diagnostic], [[{ item_id: 'raw', evidence_id: rawEvidenceId('raw', 'Fictional source.') }], true]);
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
  const altered = structuredClone(result.trace); altered.citedEvidence[0].text = 'Different source.';
  await assert.rejects(scorer.score({ packet: scoringPacket(), answer: result.answer, trace: altered }), /citation_trace_invalid/);
  const empty = await fixture({ async respond({ tools }) { await tools.search('fiction'); return { text: 'Unknown.', citations: [] }; } })
    .run({ arm: 'empty', case: fictionalCase() });
  await assert.rejects(scorer.score({ packet: scoringPacket(), answer: { text: 'Forged claim.', citations: [] }, trace: empty.trace }), /citation_trace_invalid/);
});

test('a raw source returned again with query-dependent excerpts keeps each excerpt citable', async () => {
  const seal = sealComparison(settings());
  const run = second => createAnswerer({ seal, expectedDigest: seal.digest,
    memory: { async search() { return []; }, async resolve() {} },
    archive: { async search({ query }) { return [{ id: 'raw', scope: 'fiction', text: query === 'one' ? 'First excerpt.' : second }]; } },
    async respond({ tools }) { const [a] = await tools.search('one'); const [b] = await tools.search('two');
      assert.deepEqual([a.kind, b.kind], ['source_excerpt', 'source_excerpt']);
      return { text: 'Fiction.', citations: [...new Set([a.evidence[0].id, b.evidence[0].id])].map(evidence_id => ({ item_id: 'raw', evidence_id })) }; } })
    .run({ arm: 'raw-only', case: fictionalCase() });
  const same = await run('First excerpt.');
  assert.deepEqual([same.trace.returnedItemIds, same.trace.returnedEvidence.length, same.trace.returnedItems, same.answer.citations.length], [['raw'], 1, 2, 1]);
  const different = await run('Second excerpt.');
  assert.deepEqual([different.trace.returnedItemIds, different.trace.citedEvidence.map(row => row.text)], [['raw'], ['First excerpt.', 'Second excerpt.']]);
});

test('a derived item returned by a later search is accepted unless its evidence changed or it repeats in one response', async () => {
  const seal = sealComparison(settings());
  const run = rowsFor => createAnswerer({ seal, expectedDigest: seal.digest,
    memory: { async search({ query }) { return rowsFor(query); }, async resolve(request) { return { id: request.evidenceId, scope: 'fiction', text: 'Fictional source.' }; } },
    archive: { async search() { return []; } },
    async respond({ tools }) { await tools.search('one'); await tools.search('two'); await tools.resolve('item', 'source');
      return { text: 'Fiction.', citations: [citation] }; } }).run({ arm: 'candidate', case: fictionalCase() });
  const repeated = await run(() => [item]);
  assert.deepEqual([repeated.trace.returnedItemIds, repeated.answer.citations], [['item'], [citation]]);
  const changed = { ...item, evidence: [{ id: 'other', scope: 'fiction' }] };
  await assert.rejects(run(query => [query === 'one' ? item : changed]), /retrieval_failed|duplicate_item/);
  await assert.rejects(run(() => [item, item]), /retrieval_failed|duplicate_item/);
});

test('legacy uncited answerers cannot execute through the fixed answerer', () => {
  const value = fictionalSettings(); delete value.answerer.citationProtocol;
  const seal = sealComparison(value);
  assert.throws(() => createAnswerer({ seal, expectedDigest: seal.digest,
    memory: { async search() {}, async resolve() {} }, archive: { async search() {} }, async respond() {} }), /citation_protocol_required/);
});

test('uncited, ungrounded or modified-rubric v5 configurations cannot be sealed', () => {
  const bad = settings(); bad.answerer.citationProtocol = 'unverified';
  const missing = settings(); delete missing.answerer.citationProtocol;
  const ungrounded = settings(); delete ungrounded.scorer.groundingProtocol;
  const changedRubric = settings(); changedRubric.rubric.instructions = 'Credit guesses.';
  for (const value of [bad, missing, ungrounded, changedRubric]) assert.throws(() => sealComparison(value), /settings_invalid/);
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
  assert.deepEqual([result.answer.text, result.trace.abstention, result.trace.host_replaced_text, result.trace.model_text_sha256,
    raw.at(-1).message.content[0].arguments.answer],
    [UNKNOWN_ANSWER, 'host_enforced_no_citations', true, textSha256('A fabricated answer.'), 'A fabricated answer.']);
});

test('a bounded retrieval refusal is distinguished from genuinely empty memory', async () => {
  const fake = metered([tool('search', 'memory_search', { query: 'fiction' }),
    tool('submit', 'submit_answer', { answer: 'Unknown.', citations: [] })]);
  const value = settings(); value.answerer.limits.retrievalBytes = 1;
  value.answerer.tools_sha256 = ANSWERER_CITED_TOOLS_SHA256; value.answerer.repair_instruction = ANSWERER_CITED_REPAIR;
  const seal = sealComparison(value);
  const respond = createPiAnswererResponder({ runtime: fake.runtime, model: fictionalModel(), sessionId: 'fiction', expectedToolsSha256: ANSWERER_CITED_TOOLS_SHA256 });
  const answerer = createAnswerer({ seal, expectedDigest: seal.digest, memory: { async search() { return [item]; }, async resolve() {} },
    archive: { async search() { return []; } }, respond });
  const result = await answerer.run({ arm: 'candidate', case: fictionalCase() });
  assert.deepEqual([result.answer.text, result.trace.abstention, result.trace.budgetRefusals],
    [UNKNOWN_ANSWER, 'host_enforced_after_budget_refusal', [{ tool: 'search', code: 'retrieval_bytes_limit' }]]);
  assert.throws(() => scoreCase({ seal, expectedDigest: seal.digest, packet: scoringPacket(), judgment: { clauses: [] },
    trace: { ...result.trace, budgetRefusals: [] } }), /citation_trace_invalid/);
});

test('a citation miss lists citable pairs, and a second miss becomes a marked abstention', async () => {
  const wrong = { item_id: 'source', evidence_id: 'source' };
  const fake = metered([tool('search', 'memory_search', { query: 'fiction' }), tool('submit', 'submit_answer', { answer: 'Fiction.', citations: [wrong] }),
    tool('resolve', 'memory_resolve', { item_id: 'item', evidence_id: 'source' }), tool('again', 'submit_answer', { answer: 'Fiction.', citations: [wrong] })]);
  const value = settings(); value.answerer.limits.modelCalls = 4;
  const seal = sealComparison(value);
  const respond = createPiAnswererResponder({ runtime: fake.runtime, model: fictionalModel(), sessionId: 'fiction', expectedToolsSha256: ANSWERER_CITED_TOOLS_SHA256 });
  const answerer = createAnswerer({ seal, expectedDigest: seal.digest, memory: { async search() { return [item]; },
    async resolve(request) { return { id: request.evidenceId, scope: 'fiction', text: 'Fictional source.' }; } }, archive: { async search() { return []; } }, respond });
  const result = await answerer.run({ arm: 'candidate', case: fictionalCase() });
  const feedback = JSON.parse(fake.calls[2].messages.at(-2).content[0].text);
  assert.deepEqual([feedback, result.answer, result.trace.abstention, result.trace.citation_repair_failed],
    [{ error: 'citation_not_returned', citable: [], instruction: CITATION_FEEDBACK }, { text: UNKNOWN_ANSWER, citations: [] }, 'host_enforced_invalid_citations', true]);
  assert.throws(() => scoreCase({ seal, expectedDigest: seal.digest, packet: scoringPacket(), judgment: { clauses: [] },
    trace: { ...result.trace, abstention: 'host_enforced_no_citations' } }), /citation_trace_invalid/);
});

test('grounded scorer receives exact cited text and rejects support without a cited ID', async () => {
  const value = settings(); value.scorer.model = 'one'; value.scorer.tools_sha256 = SCORER_GROUNDED_TOOLS_SHA256;
  value.scorer.repair_instruction = SCORER_GROUNDED_REPAIR;
  const seal = sealComparison(value);
  const answerer = createAnswerer({ seal, expectedDigest: seal.digest, memory: { async search() { return [item]; },
    async resolve(request) { return { id: request.evidenceId, scope: 'fiction', text: 'The weather was mild.' }; } },
    archive: { async search() { return []; } }, async respond({ tools }) {
      const rows = await tools.search('fiction');
      if (!rows.length) return { text: 'Mira chose 4.', citations: [] };
      await tools.resolve('item', 'source');
      return { text: 'Mira chose 4.', citations: [citation] };
    } });
  const result = await answerer.run({ arm: 'candidate', case: fictionalCase() });
  const empty = await answerer.run({ arm: 'empty', case: fictionalCase() });
  const clause = { id: 'claim', text: 'Mira chose 4.', requirementIds: ['r1'], sourceIds: ['src'], citationIds: [citationId('item', 'source')],
    abstention: false, action: false, judgments: { support: 'fail', authority: 'pass', scope: 'pass', time: 'pass', uncertainty: 'pass' }, alternative: null, relation: null };
  const fake = metered([tool('score', 'submit_score', { clauses: [clause] })]);
  const judge = createPiScorerJudge({ runtime: fake.runtime, model: fictionalModel(), sessionId: 'fiction', outputTokens: 20 });
  const scorer = createScorer({ seal, expectedDigest: seal.digest, judge });
  const scored = await scorer.score({ packet: scoringPacket(), answer: result.answer, trace: result.trace });
  const payload = JSON.parse(fake.calls[0].messages[0].content);
  const emptyScore = scoreCase({ seal, expectedDigest: seal.digest, packet: scoringPacket(), trace: empty.trace, judgment: { clauses: [] } });
  assert.deepEqual([scored.score.usefulness.credited, emptyScore.usefulness.credited, empty.answer.text,
    scored.score.safety.unsupportedClaims, payload.trace.citedEvidence[0].text], [0, 0, UNKNOWN_ANSWER, 1, 'The weather was mild.']);
  for (const support of ['pass', 'uncertain']) {
    const bad = structuredClone(clause); bad.judgments.support = support; bad.citationIds = [];
    assert.throws(() => scoreCase({ seal, expectedDigest: seal.digest, packet: scoringPacket(), trace: result.trace, judgment: { clauses: [bad] } }), /judgment_invalid/);
  }
});

test('a supported claim can receive credit only with a returned cited evidence ID', async () => {
  const seal = sealComparison(settings());
  const answerer = createAnswerer({ seal, expectedDigest: seal.digest, memory: { async search() { return [item]; },
    async resolve(request) { return { id: request.evidenceId, scope: 'fiction', text: 'Mira chose 4 for comet.' }; } },
    archive: { async search() { return []; } }, async respond({ tools }) {
      await tools.search('fiction'); await tools.resolve('item', 'source');
      return { text: 'Mira chose 4 for comet.', citations: [citation] };
    } });
  const result = await answerer.run({ arm: 'candidate', case: fictionalCase() });
  const clause = { id: 'claim', text: 'Mira chose 4 for comet.', requirementIds: ['r1'], sourceIds: ['src'],
    citationIds: [citationId('item', 'source')], abstention: false, action: false,
    judgments: { support: 'pass', authority: 'pass', scope: 'pass', time: 'pass', uncertainty: 'pass' }, alternative: null, relation: null };
  assert.equal(scoreCase({ seal, expectedDigest: seal.digest, packet: scoringPacket(), trace: result.trace, judgment: { clauses: [clause] } }).usefulness.credited, 1);
});

test('a canonical unknown can satisfy an explicit uncertainty requirement without licensing a factual guess', async () => {
  const packet = scoringPacket();
  packet.answerability = 'unanswerable';
  packet.requirements[0].text = 'State that the fictional decision is unknown.';
  packet.sources[0].text = 'The fictional decision is not established.';
  const value = settings(); value.packets.c1 = hash(packet);
  const seal = sealComparison(value);
  const answerer = createAnswerer({ seal, expectedDigest: seal.digest, memory: { async search() { return []; }, async resolve() {} },
    archive: { async search() { return []; } }, async respond({ tools }) { await tools.search('fiction'); return { text: 'Unknown.', citations: [] }; } });
  const result = await answerer.run({ arm: 'empty', case: fictionalCase() });
  const clause = { id: 'unknown', text: UNKNOWN_ANSWER, requirementIds: ['r1'], sourceIds: ['src'], citationIds: [], abstention: true,
    action: false, judgments: { support: 'pass', authority: 'pass', scope: 'pass', time: 'pass', uncertainty: 'pass' }, alternative: null, relation: null };
  assert.equal(scoreCase({ seal, expectedDigest: seal.digest, packet, trace: result.trace, judgment: { clauses: [clause] } }).usefulness.credited, 1);
  assert.throws(() => scoreCase({ seal, expectedDigest: seal.digest, packet, trace: result.trace,
    judgment: { clauses: [{ ...clause, text: 'Mira chose 4.' }] } }), /judgment_invalid/);
  const answerableSeal = sealComparison(settings());
  const answerable = await fixture({ async respond({ tools }) { await tools.search('fiction'); return { text: 'Unknown.', citations: [] }; } })
    .run({ arm: 'empty', case: fictionalCase() });
  assert.throws(() => scoreCase({ seal: answerableSeal, expectedDigest: answerableSeal.digest, packet: scoringPacket(),
    trace: answerable.trace, judgment: { clauses: [clause] } }), /judgment_invalid/);
  const unmet = { ...clause, requirementIds: [], judgments: { ...clause.judgments, support: 'fail' } };
  const score = scoreCase({ seal: answerableSeal, expectedDigest: answerableSeal.digest, packet: scoringPacket(),
    trace: answerable.trace, judgment: { clauses: [unmet] } });
  assert.deepEqual([score.usefulness.credited, score.safety.unsupportedClaims], [0, 0]);
});

test('legacy specific scorer repair cannot dispatch against the grounded protocol', async () => {
  const fake = metered([]);
  const repair = createPiScorerSpecificRepair({ runtime: fake.runtime, model: fictionalModel(), sessionId: 'fiction', outputTokens: 20 });
  await assert.rejects(repair({ scorer: { route: 'fiction', model: 'one', instructions: 'fiction', groundingProtocol: GROUNDING_PROTOCOL },
    clauseIds: ['clause'], previousMessage: { content: [] } }), /scorer_invalid/);
  assert.equal(fake.calls.length, 0);
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
