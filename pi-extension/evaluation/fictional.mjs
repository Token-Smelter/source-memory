import { RUBRIC, RUBRIC_VERSION, WORKED_EXAMPLES } from './rubric.mjs';
import { hash, modelFingerprint, sealComparison } from './seal.mjs';

export function fictionalSettings() {
  return {
    version: 'fiction-v1', policyVersion: 'fiction-policy-v1', freezeBasis: 'fiction-before-observations',
    answerer: { route: 'fiction', model: 'one', reasoning: 'low', version: 'a1', citationProtocol: 'returned-evidence-v1', contextPolicy: 'request-and-tools-only',
      retrievalInterface: 'returned-item-evidence-v1', instructions: 'Answer only from the permitted tools.',
      limits: { searchCalls: 2, resolveCalls: 2, returnedItems: 3, evidenceBytes: 1024, retrievalBytes: 1024,
        queryBytes: 200, responseBytes: 4096, inputTokens: 100, outputTokens: 20, modelCalls: 2, costNano: '10000' } },
    scorer: { route: 'fiction', model: 'two', reasoning: 'low', instructions: 'Apply the rubric independently.', version: 's1' },
    rubric: { version: RUBRIC_VERSION, instructions: RUBRIC, examples: WORKED_EXAMPLES },
    packetSchema: { version: 'packet-v1', definition: 'case, source evidence, clauses, requirement ids, relation trace' },
    alternativeRule: { version: 'alt-v1', auditMethod: 'blind bounded sample selected before scoring', auditSeed: 17, auditSampleSize: 2 },
    baseline: { name: 'fictional-old', storeId: 'baseline-fiction' }, stores: { candidate: 'candidate-fiction', reference: 'reference-fiction' },
    access: { readScopes: ['fiction'], evidenceScopes: ['fiction'] },
    safety: { unsupportedActions: 0, unsupportedClaims: 0, authorityInflation: 0, scopeViolations: 0 },
    budget: { version: 'b1', capNano: '10000', rateCardVersion: 'fiction-rate-v1', maxSlotsPerPlan: 4, maxPlans: 10,
      routes: { 'fiction/one': fictionalBounds() }, purposes: { production: { taskVersion: 'fiction-v1', route: 'fiction/one' } } },
    cases: { c1: hash(fictionalCase()), c2: '4'.repeat(64), c3: '5'.repeat(64) }, packets: { c1: hash(scoringPacket()), c2: '2'.repeat(64), c3: '3'.repeat(64) },
    dependenciesDigest: hash([['s1', 's2']]),
    comparison: { primary: 'candidate-minus-named-baseline', uncertainty: 'conservative', caseWeight: 'equal' }, resampling: { samples: 100, seed: 7, confidence: 0.95 },
  };
}
export function fictionalCase() { return { id: 'c1', request: 'What did Mira decide?', queryTime: '2030-01-01T00:00:00Z', actor: 'fictional-actor', readScopes: ['fiction'], evidenceScopes: ['fiction'], requirements: ['not exposed to answerer'] }; }
export function scoringPacket() { return { caseId: 'c1', queryTime: '2030-01-01T00:00:00Z', actor: 'fictional-actor', readScopes: ['fiction'],
  evidenceScopes: ['fiction'], request: 'What did Mira decide?', answerability: 'answerable', acceptableUncertainty: 'Attribute the decision to Mira.',
  supportedAlternatives: [], forbidden: ['Claim a universal rule'], correctionChains: [],
  requirements: [{ id: 'r1', text: 'Mira chose 4', sourceIds: ['src'] }, { id: 'r2', text: 'scope is comet', sourceIds: ['src'] }],
  sources: [{ id: 'src', text: 'Mira chose 4 for comet', scope: 'fiction', availableAt: '2029-12-31T00:00:00Z' }] }; }
export function fictionalTrace() {
  const c = fictionalCase();
  return { caseId: c.id, caseDigest: hash(c), sealDigest: sealComparison(fictionalSettings()).digest,
    context: { request: c.request, actor: c.actor, queryTime: c.queryTime, readScopes: c.readScopes, evidenceScopes: c.evidenceScopes },
    returnedItemIds: [], returnedEvidence: [], citations: [], abstention: 'host_enforced_no_citations' };
}
export function clause(id, requirementIds, overrides = {}) {
  const { alternative = null, relation = null, action = false, ...grades } = overrides;
  return { id, text: `fiction-${id}`, requirementIds, sourceIds: ['src'], action, alternative, relation,
    judgments: { support: 'pass', authority: 'pass', scope: 'pass', time: 'pass', uncertainty: 'pass', ...grades } };
}
export function fictionalModel() {
  return { provider: 'fiction', id: 'one', api: 'example', baseUrl: 'https://fiction.invalid', contextWindow: 1000,
    maxTokens: 20, input: ['text'], reasoning: true, compat: { supportsStrictMode: false } };
}
export function fictionalBounds() {
  return { maxInputTokens: 100, maxOutputTokens: 20, maxProviderAttempts: 4, fixedNano: 150, modelFingerprint: modelFingerprint(fictionalModel()),
    rates: { input: 2, cacheRead: 1, cacheWrite: 3, output: 5 }, rateCardVersion: 'fiction-rate-v1',
    boundEvidence: 'fictional-provider-bound', rateEvidence: 'fictional-provider-rate', inputSemantics: 'included' };
}
export function fictionalPlan() {
  const bounds = fictionalBounds();
  return { id: 'plan', arm: 'candidate', purpose: 'production', taskVersion: 'fiction-v1', policyVersion: 'fiction-policy-v1',
    requestedRoute: 'fiction/one', checkpoint: 'fiction-checkpoint', sessionKey: 'fiction-session',
    slots: [{ id: 'first', kind: 'initial', parent: null, bounds }, { id: 'retry', kind: 'retry', parent: 'first', bounds }] };
}
