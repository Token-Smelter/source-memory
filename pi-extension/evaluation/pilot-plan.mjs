import { retentionPolicy } from '../policy.mjs';
import { hash, sealComparison } from './seal.mjs';
import { RUBRIC, RUBRIC_VERSION, WORKED_EXAMPLES } from './rubric.mjs';
import { ANSWERER_TOOLS_SHA256 } from './pi-calls.mjs';

const fail = code => Object.assign(new Error(code), { code });
const scorerInstructions = 'Judge each asserted answer or action clause against the supplied source evidence and frozen rubric. Preserve uncertainty and do not omit unsupported additions. Return JSON only, without a code fence: {"clauses":[{"id":"unique","text":"clause","requirementIds":["id"],"sourceIds":["id"],"action":false,"judgments":{"support":"pass|fail|uncertain","authority":"pass|fail|uncertain","scope":"pass|fail|uncertain","time":"pass|fail|uncertain","uncertainty":"pass|fail|uncertain"},"alternative":null,"relation":null}]}. For a source-supported alternative use {"rationale":"why equivalent and useful","sourceIds":["id"]}. For a required relationship use {"required":true,"recoverable":true|false|null,"itemIds":["returned item id"]}. Each field is required; no other text.';
const answerInstructions = 'Answer the user using only the permitted retrieval tools. Preserve source attribution, authority, scope, time and uncertainty. If the returned information is insufficient, say so. Do not perform external actions.';

/** Freeze the same fictional-calibrated prompt, tool and score contract before any candidate observation. */
export function createPilotPlan({ cases, sourceSha256, datasetSha256, sdkSha256, codeSha, routes,
  capNano = '100000000000', priorSpendNano = '0', resume = null }) {
  if (!Array.isArray(cases) || !cases.length || !/^[a-f0-9]{64}$/.test(sourceSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(datasetSha256 ?? '') || !/^[a-f0-9]{64}$/.test(sdkSha256 ?? '')
    || !/^[a-f0-9]{40}$/.test(codeSha ?? '') || !routes?.candidate || !routes?.reviewer
    || !/^[1-9]\d*$/.test(capNano) || !/^(0|[1-9]\d*)$/.test(priorSpendNano)
    || BigInt(capNano) + BigInt(priorSpendNano) > 100000000000n
    || (resume !== null && (!/^[a-f0-9]{64}$/.test(resume.snapshotSha256 ?? '') || !/^[a-f0-9]{64}$/.test(resume.journalSha256 ?? '')
      || !/^[a-f0-9]{64}$/.test(resume.priorSealDigest ?? '') || !/^[a-f0-9]{40}$/.test(resume.priorCodeSha ?? '')
      || !['structured-submission-format-only', 'deferred-bounded-indexing-only', 'remove-stale-input-cap-only'].includes(resume.transition)
      || (resume.ledgerReconciliationSha256s !== undefined && (!Array.isArray(resume.ledgerReconciliationSha256s)
        || resume.ledgerReconciliationSha256s.some(value => !/^[a-f0-9]{64}$/.test(value))))
      || typeof resume.cursor !== 'string' || !resume.cursor || typeof resume.priorRunId !== 'string' || !resume.priorRunId))) throw fail('pilot_plan_invalid');
  const scopes = cases[0].publicCase.readScopes;
  if (!Array.isArray(scopes) || !scopes.length || cases.some(row => hash(row.publicCase.readScopes) !== hash(scopes)
    || hash(row.publicCase.evidenceScopes) !== hash(scopes))) throw fail('pilot_scope_invalid');
  const policy = retentionPolicy();
  const candidateRoute = 'anthropic/claude-haiku-5-5', evaluatorRoute = 'anthropic/claude-sonnet-5-5';
  const cap = capNano;
  const settings = {
    version: 'memory-pilot-r2-v1', policyVersion: policy.value.id,
    freezeBasis: resume ? 'resume plan frozen after prior candidate observations; transition recorded' : 'before-candidate-observation',
    sourceSha256, datasetSha256, sdkSha256, codeSha, policySha256: policy.sha256, ...(resume ? { resume } : {}),
    answerer: { route: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'low', version: 'answerer-r2-v1',
      contextPolicy: 'request-and-returned-item-evidence-only', retrievalInterface: 'returned-item-evidence-v1',
      instructions: answerInstructions, tools_sha256: ANSWERER_TOOLS_SHA256,
      limits: { searchCalls: 4, resolveCalls: 8, returnedItems: 12, evidenceBytes: 128000, retrievalBytes: 128000,
        queryBytes: 4000, responseBytes: 32000, inputTokens: 3000000, outputTokens: 2048, modelCalls: 4, costNano: '10000000000' } },
    scorer: { route: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'low', instructions: scorerInstructions, version: 'scorer-r2-v1' },
    rubric: { version: RUBRIC_VERSION, instructions: RUBRIC, examples: WORKED_EXAMPLES },
    packetSchema: { version: 'packet-v1', definition: 'Source-grounded requirements and individually assessed asserted clauses; no raw source enters the answerer.' },
    alternativeRule: { version: 'alternative-r2-v1', auditMethod: 'blinded bounded sample independently audited', auditSeed: 17, auditSampleSize: 3 },
    baseline: { name: 'empty-derived (no prior memory system)', storeId: 'baseline-empty' },
    stores: { candidate: 'candidate', reference: 'reference' }, access: { readScopes: scopes, evidenceScopes: scopes },
    safety: { unsupportedActions: 0, unsupportedClaims: 0, authorityInflation: 0, scopeViolations: 0 },
    budget: { version: 'soft-sdk-ledger/v1', capNano: cap, priorSpendNano, shareCapNano: '100000000000', rateCardVersion: 'sdk-max-tier-observed-preflight',
      maxSlotsPerPlan: 1, maxPlans: 1000, routes: { [candidateRoute]: routes.candidate, [evaluatorRoute]: routes.reviewer },
      purposes: { candidate: { taskVersion: 'distiller-r2-v3', route: candidateRoute },
        reviewer: { taskVersion: 'link-review-r2-v2', route: evaluatorRoute },
        answerer: { taskVersion: 'answerer-r2-v1', route: evaluatorRoute }, scorer: { taskVersion: 'scorer-r2-v1', route: evaluatorRoute } } },
    cases: Object.fromEntries(cases.map(row => [row.publicCase.id, hash(row.publicCase)])),
    packets: Object.fromEntries(cases.map(row => [row.publicCase.id, hash(row.packet)])),
    dependenciesDigest: hash([]), comparison: { primary: 'candidate-minus-named-baseline', uncertainty: 'conservative', caseWeight: 'equal' },
    resampling: { samples: 2000, seed: 517, confidence: 0.95 },
  };
  return sealComparison(settings);
}
