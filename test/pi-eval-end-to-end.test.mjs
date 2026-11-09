import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDerivedAdapter } from '../pi-extension/derived-retrieval.mjs';
import { createAnswerer, CITATION_PROTOCOL, citationId } from '../pi-extension/evaluation/answerer.mjs';
import { GROUNDING_PROTOCOL, CITED_RUBRIC_VERSION, CITED_RUBRIC, CITED_WORKED_EXAMPLES } from '../pi-extension/evaluation/rubric.mjs';
import { fictionalBounds, fictionalCase, fictionalModel, fictionalSettings, scoringPacket, clause } from '../pi-extension/evaluation/fictional.mjs';
import { openLedger } from '../pi-extension/evaluation/ledger.mjs';
import { createPiAnswererResponder, createPiScorerJudge, ANSWERER_CITED_TOOLS_SHA256, SCORER_GROUNDED_TOOLS_SHA256 } from '../pi-extension/evaluation/pi-calls.mjs';
import { createSingleFlightGate, wrapPiRuntime } from '../pi-extension/evaluation/pi-wrapper.mjs';
import { pairedReport } from '../pi-extension/evaluation/report.mjs';
import { createScorer, scoreCase } from '../pi-extension/evaluation/scorer.mjs';
import { sealComparison } from '../pi-extension/evaluation/seal.mjs';

const message = (content, stopReason = 'stop') => ({ role: 'assistant', provider: 'fiction', model: 'one', api: 'example', content, stopReason,
  usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1, cost: { total: 0 } }, timestamp: 1 });

test('fictional fixed arms, Pi calls, scorer, shared reservations and paired report compose without raw search', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-eval-composition-'));
  let ledger;
  try {
    const settings = fictionalSettings();
    settings.budget.capNano = '100000';
    settings.budget.maxSlotsPerPlan = 6;
    settings.scorer.model = 'one';
    settings.scorer.groundingProtocol = GROUNDING_PROTOCOL;
    settings.scorer.tools_sha256 = SCORER_GROUNDED_TOOLS_SHA256;
    settings.answerer.citationProtocol = CITATION_PROTOCOL;
    settings.answerer.limits.modelCalls = 3;
    settings.answerer.tools_sha256 = ANSWERER_CITED_TOOLS_SHA256;
    settings.rubric = { version: CITED_RUBRIC_VERSION, instructions: CITED_RUBRIC, examples: CITED_WORKED_EXAMPLES };
    const seal = sealComparison(settings);
    ledger = openLedger({ path: join(dir, 'ledger.sqlite'), seal, expectedDigest: seal.digest });
    const bounds = fictionalBounds();
    ledger.reservePlan({ id: 'fiction', arm: 'all', purpose: 'production', taskVersion: 'fiction-v1', policyVersion: settings.policyVersion,
      requestedRoute: 'fiction/one', checkpoint: 'fiction', sessionKey: 'fiction',
      slots: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, kind: 'initial', parent: null, bounds })) });
    const judgments = { clauses: [{ ...clause('c1', ['r1', 'r2']), citationIds: [citationId('record', 'ev')], abstention: false }] };
    const responses = [message([{ type: 'toolCall', id: 'search', name: 'memory_search', arguments: { query: 'Mira' } }], 'toolUse'),
      message([{ type: 'toolCall', id: 'resolve', name: 'memory_resolve', arguments: { item_id: 'record', evidence_id: 'ev' } }], 'toolUse'),
      message([{ type: 'toolCall', id: 'answer1', name: 'submit_answer', arguments: { answer: 'Mira chose 4 for comet.',
        citations: [{ item_id: 'record', evidence_id: 'ev' }] } }], 'toolUse'),
      message([{ type: 'toolCall', id: 'search2', name: 'memory_search', arguments: { query: 'Mira' } }], 'toolUse'),
      message([{ type: 'toolCall', id: 'answer2', name: 'submit_answer', arguments: { answer: 'I do not know.', citations: [] } }], 'toolUse'),
      message([{ type: 'toolCall', id: 'score', name: 'submit_score', arguments: judgments }], 'toolUse')];
    const host = { streamSimple() { const result = Promise.resolve(responses.shift()); return { result: () => result, async *[Symbol.asyncIterator]() {} }; } };
    let slot = 0;
    const metered = wrapPiRuntime({ runtime: host, ledger, planId: 'fiction', nextSlot: () => `s${slot++}`,
      boundInput: () => ({ tokens: 30, providerBound: true, proofRef: 'fiction-only', contextFingerprint: 'a'.repeat(64) }) });
    const runtime = createSingleFlightGate().wrap(metered);
    const model = fictionalModel();
    const client = { async searchDerived(scope) { return [{ id: 'record', scope, text: 'Mira chose 4 for comet', evidence: [{ id: 'ev', scope }] }]; },
      async resolveDerived(scope) { return { id: 'ev', scope, text: 'Mira chose 4 for comet' }; } };
    const store = { scope: 'fiction', snapshotId: 'snapshot', authorize: async () => true, verifySnapshot: async () => 'snapshot', client };
    const memory = createDerivedAdapter({ stores: { 'candidate-fiction': store, 'baseline-fiction': store, 'reference-fiction': store } });
    const respond = createPiAnswererResponder({ runtime, model, sessionId: 'fiction', expectedToolsSha256: ANSWERER_CITED_TOOLS_SHA256 });
    const answerer = createAnswerer({ seal, expectedDigest: seal.digest, memory, archive: { async search() { throw new Error('raw search forbidden'); } }, respond });
    const candidate = await answerer.run({ arm: 'candidate', case: fictionalCase() });
    const baseline = await answerer.run({ arm: 'baseline', case: fictionalCase() });
    const judge = createPiScorerJudge({ runtime, model, sessionId: 'fiction', outputTokens: 20 });
    const scorer = createScorer({ seal, expectedDigest: seal.digest, judge });
    const candidateScore = (await scorer.score({ packet: scoringPacket(), answer: candidate.answer, trace: candidate.trace })).score;
    const baselineScore = scoreCase({ seal, expectedDigest: seal.digest, packet: scoringPacket(), judgment: { clauses: [] }, trace: baseline.trace });
    const report = pairedReport({ seal, expectedDigest: seal.digest, dependencies: [['s1', 's2']], rows: [{ caseId: 'c1', sessions: ['s1'],
      sealDigest: seal.digest, packetDigest: candidateScore.packetDigest, arms: { candidate: candidateScore, baseline: baselineScore } }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([report.pairedDelta, report.clusters, report.confidence.kind, ledger.summary().attempts, ledger.summary().usageComplete],
      [1, 1, 'descriptive-only', 6, false]);
  } finally { ledger?.close(); rmSync(dir, { recursive: true, force: true }); }
});
