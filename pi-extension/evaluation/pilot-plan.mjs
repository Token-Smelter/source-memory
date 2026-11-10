import { retentionPolicy } from '../policy.mjs';
import { hash, sealComparison } from './seal.mjs';
import { RUBRIC, RUBRIC_VERSION, WORKED_EXAMPLES, GROUNDING_PROTOCOL, CITED_RUBRIC, CITED_RUBRIC_VERSION, CITED_WORKED_EXAMPLES } from './rubric.mjs';
import { ANSWERER_TOOLS_SHA256, ANSWERER_CITED_TOOLS_SHA256, SCORER_TOOLS_SHA256, SCORER_GROUNDED_TOOLS_SHA256, ANSWERER_FORMAT_SUFFIX,
  ANSWERER_BUDGET_SUFFIX, ANSWERER_CITATION_SUFFIX, SCORER_FORMAT_SUFFIX, ANSWERER_REPAIR, ANSWERER_CITED_REPAIR,
  SCORER_REPAIR, SCORER_GROUNDED_REPAIR, SCORER_SPECIFIC_REPAIR, SCORER_MULTI_REPAIR } from './pi-calls.mjs';
import { CITATION_PROTOCOL } from './answerer.mjs';
import { BLOCK_EVIDENCE_CONTRACT } from './dev-dataset.mjs';
import { WORKER_SHARE_NANO } from './prior-spend.mjs';
import { DISTILLER_GUIDANCE } from '../pi-runtime.mjs';
import { createHash } from 'node:crypto';
// T1 v1 (action-only outcomes) is historical; T1 now seals v2, written for outcome_of targets widened to decisions and intentions.
const GUIDANCE_SHA256 = createHash('sha256').update(DISTILLER_GUIDANCE['typed-records-and-links-v2']).digest('hex');
// T1b = T1 v2 plus a narrow question-retention rule (T1 was policy-suspect for over-retained open questions).
const GUIDANCE_T1B_SHA256 = createHash('sha256').update(DISTILLER_GUIDANCE['typed-records-and-links-v3']).digest('hex');

const fail = code => Object.assign(new Error(code), { code });
export const INTERPRETATION_02_SHA256 = 'a55c16e3ccba00a60892db5c9b7604d96ca1e8d6998bf89b667cd1fdff42313c';
export const DESIGN_SHA256 = '5b0c1fc1d3a94117c9518b8180b7587551514460ec0c9e47a35275063c5eaa6e';
const scorerInstructions = 'Judge each asserted answer or action clause against the supplied source evidence and frozen rubric. Preserve uncertainty and do not omit unsupported additions. Return JSON only, without a code fence: {"clauses":[{"id":"unique","text":"clause","requirementIds":["id"],"sourceIds":["id"],"action":false,"judgments":{"support":"pass|fail|uncertain","authority":"pass|fail|uncertain","scope":"pass|fail|uncertain","time":"pass|fail|uncertain","uncertainty":"pass|fail|uncertain"},"alternative":null,"relation":null}]}. For a source-supported alternative use {"rationale":"why equivalent and useful","sourceIds":["id"]}. For a required relationship use {"required":true,"recoverable":true|false|null,"itemIds":["returned item id"]}. Each field is required; no other text.';
const answerInstructions = 'Answer the user using only the permitted retrieval tools. Preserve source attribution, authority, scope, time and uncertainty. If the returned information is insufficient, say so. Do not perform external actions.';
const groundedScorerInstructions = 'Judge each asserted answer or action clause against the supplied reference packet and the answerer’s own cited evidence using the frozen rubric. Support passes only when both support a factual clause; a correct guess with irrelevant cited evidence fails. Factual support graded pass or uncertain requires citationIds containing supplied citation_id values. Preserve uncertainty and do not omit unsupported additions. Submit clauses with id, text, requirementIds, sourceIds, citationIds, abstention, action, judgments for support/authority/scope/time/uncertainty, alternative and relation. For the exact canonical unknown with no citations, an abstention clause may have abstention=true, the exact answer text, action=false, no relation and empty citationIds; use reference sourceIds to judge any explicit uncertainty requirement. Do not assign an abstention to any requirement when the packet is answerable. All factual clauses have abstention=false. For an alternative use a reference-source-linked rationale. For a required relationship use required, recoverable and returned itemIds.' + SCORER_FORMAT_SUFFIX;

// Haiku and Sonnet 5.5 use Pi's adaptive thinking (compat.forceAdaptiveThinking): there is no separate thinking budget,
// so thinking and the answer share max_tokens. At 4,096 a distiller turn could spend the whole ceiling thinking and stop
// with "length", failing the checkpoint; 16,384 is the declared distiller ceiling for every arm (baseline v2.1 onward).
export const DISTILLER_MAX_OUTPUT_TOKENS = 16384, EVALUATOR_MAX_OUTPUT_TOKENS = 4096;

export const BASELINE_CANDIDATE_ROUTE = 'anthropic/claude-haiku-5-5';
/**
 * Arms a re-answer run may evaluate against a completed run's per-case snapshots: product recall with and without record
 * seeds, plus the original arms as same-snapshot, same-code controls.
 */
export const REANSWER_ARMS = Object.freeze(['combined', 'recall-chunks', 'raw-only', 'candidate']);

/** Sealed treatment surfaces; a run without one is the baseline. */
export const TREATMENTS = Object.freeze({
  // D0's oracle is the candidate's own earlier store in the run's scope, not the reference catalog.
  D0: Object.freeze({ id: 'D0', surface: 'distiller retrieval', retrieval: 'oracle-catalog', catalog: 'candidate-store-in-scope', product: false }),
  // A model arm changes only the candidate distiller route; the reviewer, answerer and scorer stay Sonnet. Rates are the
  // provider's published peak tier (off-peak is half), so API-equivalent spend is conservative.
  'M-DS': Object.freeze({ id: 'M-DS', surface: 'candidate distiller model', candidateRoute: 'deepseek/deepseek-v4-flash', candidateOrigin: 'https://api.deepseek.com',
    servedVersion: 'DeepSeek-V4.1-Flash-1017 (provider docs: the legacy deepseek-v4-flash name is served by it)', imageInput: false,
    // Declared arm differences from the Haiku baseline beyond the model itself.
    armDifferences: Object.freeze(['candidate route and provider origin', 'sealed provider rate card', 'images reach the candidate as Pi text placeholders (text-only route)']),
    rateCard: Object.freeze({ source: 'https://api-docs.deepseek.com/quick_start/pricing (read 2026-11-09)', tier: 'peak',
      usdPerMillion: Object.freeze({ cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }), offPeakUsdPerMillion: Object.freeze({ cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }) }),
    product: true }),
  T1b: Object.freeze({ id: 'T1b', surface: 'distiller instructions', guidance: 'typed-records-and-links-v3', guidanceSha256: GUIDANCE_T1B_SHA256, product: true }),
  T1: Object.freeze({ id: 'T1', surface: 'distiller instructions', guidance: 'typed-records-and-links-v2', guidanceSha256: GUIDANCE_SHA256, product: true }),
  // Calibration of the Sourcerer integration candidate's question cap over unchanged T1 v2 guidance. Its other prompt parts
  // (job task and agent prompts, dynamic inputs) are not reproduced, so this is not full-integration prompt equivalence.
  T1c: Object.freeze({ id: 'T1c', surface: 'distiller instructions and per-turn question cap', guidance: 'typed-records-and-links-v2', guidanceSha256: GUIDANCE_SHA256,
    maxQuestions: 1, capSource: Object.freeze({ repository: 'sourcerer', commit: 'ed9c0345862bfbe555e6342e363b820357039a21',
      semantics: 'at most N distinct question record ids per source turn, rejected on the host before write with memory_question_cap; no ranking, dropping, truncation or retyping' }),
    product: true }),
});
export const CITED_RESUME_TRANSITIONS = ['same-treatment-resume', 'default-path-code-transition'];
/** Runtime paths whose change can alter candidate behavior; each changed one must be named as reviewed. */
export const RUNTIME_PATH = /^(?:(?:src|pi-extension|config|scripts)\/|package(?:-lock)?\.json$)/;
/**
 * A code change may resume a run only when it is declared to leave every completed interval unchanged: the prior run must
 * have stopped at the first interval after the cursor with the named failure the change addresses, and every changed
 * runtime path (recomputed by the driver from git) must be listed as reviewed for default-path identity.
 */
export function validCodeTransition(value, from, to) {
  const changed = value?.changedPaths;
  return Boolean(value) && Object.keys(value).sort().join(',') === 'changedPaths,evidence,failedCheckpoint,failureCode,from,reason,reviewedPaths,to'
    && Array.isArray(changed) && changed.length > 0 && changed.every((row, i) => row && Object.keys(row).sort().join(',') === 'blob,path'
      && typeof row.path === 'string' && row.path.length > 0 && (row.blob === null || /^[a-f0-9]{40}$/.test(row.blob))
      && (i === 0 || changed[i - 1].path < row.path))
    && Array.isArray(value.reviewedPaths) && changed.filter(row => RUNTIME_PATH.test(row.path)).every(row => value.reviewedPaths.includes(row.path))
    && value.from === from && value.to === to && from !== to && /^[a-z][a-z0-9_]{2,63}$/.test(value.failureCode ?? '')
    && typeof value.failedCheckpoint === 'string' && value.failedCheckpoint.length > 0
    && typeof value.reason === 'string' && value.reason.trim().length > 0 && value.reason.length <= 2000
    && Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every(row => typeof row === 'string' && row.length > 0 && row.length <= 500);
}

/** Freeze the same fictional-calibrated prompt, tool and score contract before any candidate observation. */
export function createPilotPlan({ cases, sourceSha256, datasetSha256, sdkSha256, codeSha, routes,
  capNano = '100000000000', priorSpendNano = '0', resume = null, interpretationSha256 = INTERPRETATION_02_SHA256, candidateRoute = BASELINE_CANDIDATE_ROUTE }) {
  if (!Array.isArray(cases) || !cases.length || !/^[a-f0-9]{64}$/.test(sourceSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(datasetSha256 ?? '') || !/^[a-f0-9]{64}$/.test(sdkSha256 ?? '')
    || !/^[a-f0-9]{40}$/.test(codeSha ?? '') || interpretationSha256 !== INTERPRETATION_02_SHA256 || !routes?.candidate || !routes?.reviewer
    || ![BASELINE_CANDIDATE_ROUTE, ...Object.values(TREATMENTS).map(row => row.candidateRoute).filter(Boolean)].includes(candidateRoute)
    || !/^[1-9]\d*$/.test(capNano) || !/^(0|[1-9]\d*)$/.test(priorSpendNano)
    || BigInt(capNano) + BigInt(priorSpendNano) > WORKER_SHARE_NANO
    || (resume !== null && (!/^[a-f0-9]{64}$/.test(resume.snapshotSha256 ?? '') || !/^[a-f0-9]{64}$/.test(resume.journalSha256 ?? '')
      || !/^[a-f0-9]{64}$/.test(resume.priorSealDigest ?? '') || !/^[a-f0-9]{40}$/.test(resume.priorCodeSha ?? '')
      || !['same-treatment-resume', 'structured-submission-format-only', 'deferred-bounded-indexing-only', 'remove-stale-input-cap-only', 'structured-evaluator-submission-only', 'retained-chunk-labels-and-case-handback', 'interpretation-02-abstention-clarification', 'answerer-item-budget-result-only', 'specific-scorer-repair-and-arm-handback', 'specific-scorer-repair-continuation', 'default-path-code-transition'].includes(resume.transition)
      || (resume.sourceTreeDriftSha256 !== undefined && !/^[a-f0-9]{64}$/.test(resume.sourceTreeDriftSha256))
      || (resume.checkpointSnapshotSha256 !== undefined && !/^[a-f0-9]{64}$/.test(resume.checkpointSnapshotSha256))
      || (resume.partialCaseHandback !== undefined && (!resume.partialCaseHandback || resume.partialCaseHandback.repairFormat !== 'scorer-r2-v3-specific-repair'
        || !['sourceReportSha256', 'sourceSealDigest', 'snapshotSha256', 'resultsSha256', 'outputsSha256', 'ledgerSha256', 'candidateScoreSha256',
          'baselineAnswerSha256', 'previousMessageSha256', 'offendingClauseIdSha256'].every(key => /^[a-f0-9]{64}$/.test(resume.partialCaseHandback[key] ?? ''))
        || resume.specificScorerRepair?.instruction !== SCORER_SPECIFIC_REPAIR || resume.specificScorerRepair?.maxCalls !== 1
        || (resume.transition === 'specific-scorer-repair-continuation' && (resume.specificScorerRepair?.multiInstruction !== SCORER_MULTI_REPAIR
          || resume.specificScorerRepair?.scope !== 'per-arm' || JSON.stringify(resume.specificScorerRepair?.allowedArms) !== JSON.stringify(['empty', 'raw-only'])
          || !['baselineScoreSha256', 'emptyAnswerSha256', 'originalCaseSealDigest'].every(key => /^[a-f0-9]{64}$/.test(resume.partialCaseHandback[key] ?? ''))
          || !/^[a-f0-9]{40}$/.test(resume.partialCaseHandback.originalCaseCodeSha ?? '')
          || resume.partialCaseHandback.armOrigins?.candidate !== resume.partialCaseHandback.originalCaseSealDigest
          || resume.partialCaseHandback.armOrigins?.baseline !== resume.partialCaseHandback.originalCaseSealDigest
          || resume.partialCaseHandback.armOrigins?.empty !== resume.partialCaseHandback.sourceSealDigest))))
      || (resume.ledgerReconciliationSha256s !== undefined && (!Array.isArray(resume.ledgerReconciliationSha256s)
        || resume.ledgerReconciliationSha256s.some(value => !/^[a-f0-9]{64}$/.test(value))))
      || (resume.caseHandbacks !== undefined && (!Array.isArray(resume.caseHandbacks) || resume.caseHandbacks.some(row =>
        typeof row?.caseId !== 'string' || !row.caseId || typeof row.sourceRunId !== 'string' || !row.sourceRunId
        || !/^[a-f0-9]{64}$/.test(row.sourceReportSha256 ?? '')
        || !/^[a-f0-9]{64}$/.test(row.sourceSealDigest ?? '') || !/^[a-f0-9]{40}$/.test(row.sourceCodeSha ?? '')
        || !['snapshotSha256', 'resultsSha256', 'outputsSha256', 'ledgerSha256'].every(key => /^[a-f0-9]{64}$/.test(row[key] ?? '')))))
      || (resume.transition === 'default-path-code-transition' && !validCodeTransition(resume.codeTransition, resume.priorCodeSha, codeSha))
      || typeof resume.cursor !== 'string' || !resume.cursor || typeof resume.priorRunId !== 'string' || !resume.priorRunId))) throw fail('pilot_plan_invalid');
  const scopes = cases[0].publicCase.readScopes;
  if (!Array.isArray(scopes) || !scopes.length || cases.some(row => hash(row.publicCase.readScopes) !== hash(scopes)
    || hash(row.publicCase.evidenceScopes) !== hash(scopes))) throw fail('pilot_scope_invalid');
  const policy = retentionPolicy();
  const evaluatorRoute = 'anthropic/claude-sonnet-5-5';
  const cap = capNano;
  const settings = {
    version: 'memory-pilot-r2-v1', policyVersion: policy.value.id,
    freezeBasis: resume ? 'resume plan frozen after prior candidate observations; transition recorded' : 'before-candidate-observation',
    sourceSha256, datasetSha256, sdkSha256, codeSha, policySha256: policy.sha256,
    interpretation: { id: 'INTERPRETATION-02', sha256: interpretationSha256 }, ...(resume ? { resume } : {}),
    answerer: { route: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'low', version: 'answerer-r2-v4',
      contextPolicy: 'request-and-returned-item-evidence-only', retrievalInterface: 'returned-item-evidence-v1',
      instructions: answerInstructions + ANSWERER_FORMAT_SUFFIX + ANSWERER_BUDGET_SUFFIX, tools_sha256: ANSWERER_TOOLS_SHA256, repair_instruction: ANSWERER_REPAIR,
      limits: { searchCalls: 4, resolveCalls: 8, returnedItems: 12, evidenceBytes: 128000, retrievalBytes: 128000,
        queryBytes: 4000, responseBytes: 32000, inputTokens: 3000000, outputTokens: 2048, modelCalls: 4, formatRepairCalls: 1, costNano: '10000000000' } },
    scorer: { route: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'low',
      instructions: scorerInstructions.replace('Return JSON only, without a code fence:', 'Use this JSON object schema:') + SCORER_FORMAT_SUFFIX,
      tools_sha256: SCORER_TOOLS_SHA256, repair_instruction: SCORER_REPAIR, formatRepairCalls: 1, version: 'scorer-r2-v2' },
    rubric: { version: RUBRIC_VERSION, instructions: RUBRIC, examples: WORKED_EXAMPLES },
    packetSchema: { version: 'packet-v1', definition: 'Source-grounded requirements and individually assessed asserted clauses; no raw source enters the answerer.' },
    alternativeRule: { version: 'alternative-r2-v1', auditMethod: 'blinded bounded sample independently audited', auditSeed: 17, auditSampleSize: 3 },
    baseline: { name: 'empty-derived (no prior memory system)', storeId: 'baseline-empty' },
    stores: { candidate: 'candidate', reference: 'reference' }, access: { readScopes: scopes, evidenceScopes: scopes },
    safety: { unsupportedActions: 0, unsupportedClaims: 0, authorityInflation: 0, scopeViolations: 0 },
    budget: { version: 'soft-sdk-ledger/v1', capNano: cap, priorSpendNano, shareCapNano: WORKER_SHARE_NANO.toString(), rateCardVersion: 'sdk-max-tier-observed-preflight',
      maxSlotsPerPlan: 1, maxPlans: 1000, routes: { [candidateRoute]: routes.candidate, [evaluatorRoute]: routes.reviewer },
      purposes: { candidate: { taskVersion: 'distiller-r2-v4', route: candidateRoute },
        reviewer: { taskVersion: 'link-review-r2-v3', route: evaluatorRoute },
        answerer: { taskVersion: 'answerer-r2-v4', route: evaluatorRoute }, scorer: { taskVersion: 'scorer-r2-v2', route: evaluatorRoute } } },
    cases: Object.fromEntries(cases.map(row => [row.publicCase.id, hash(row.publicCase)])),
    packets: Object.fromEntries(cases.map(row => [row.publicCase.id, hash(row.packet)])),
    dependenciesDigest: hash([]), comparison: { primary: 'candidate-minus-named-baseline', uncertainty: 'conservative', caseWeight: 'equal' },
    resampling: { samples: 2000, seed: 517, confidence: 0.95 },
  };
  return sealComparison(settings);
}

/** New comparisons and same-treatment resumptions use the citation-bound answerer. */
export function createCitedPilotPlan(options) {
  if (options?.resume != null && !CITED_RESUME_TRANSITIONS.includes(options.resume.transition)) throw fail('resume_transition_forbidden');
  if (!Array.isArray(options?.cases) || options.cases.some(row => row?.packet?.evidenceContract !== BLOCK_EVIDENCE_CONTRACT)) throw fail('packet_contract_mismatch');
  if (!/^[a-f0-9]{64}$/.test(options.toolCallReviewSha256 ?? '')) throw fail('pilot_plan_invalid');
  const settings = structuredClone(createPilotPlan({ ...options, candidateRoute: options.treatment?.candidateRoute ?? BASELINE_CANDIDATE_ROUTE }).spec);
  settings.toolCallReviewSha256 = options.toolCallReviewSha256;
  settings.designSha256 = DESIGN_SHA256;
  if (options.reanswer !== undefined && options.reanswer !== null) {
    const r = options.reanswer;
    if (Object.keys(r).sort().join(',') !== 'arms,priorCodeSha,priorReportSha256,priorSealDigest,priorTreatment'
      || !/^[a-f0-9]{64}$/.test(r.priorReportSha256 ?? '') || !/^[a-f0-9]{64}$/.test(r.priorSealDigest ?? '') || !/^[a-f0-9]{40}$/.test(r.priorCodeSha ?? '')
      || !Array.isArray(r.arms) || !r.arms.length || r.arms.some(arm => !REANSWER_ARMS.includes(arm))
      || new Set(r.arms).size !== r.arms.length || options.resume != null || options.treatment != null) throw fail('pilot_plan_invalid');
    settings.reanswer = structuredClone(r);
  }
  if (options.treatment !== undefined && options.treatment !== null) {
    if (!TREATMENTS[options.treatment?.id] || JSON.stringify(options.treatment) !== JSON.stringify(TREATMENTS[options.treatment.id])) throw fail('pilot_plan_invalid');
    settings.treatment = structuredClone(options.treatment);
  }
  settings.answerer.version = 'answerer-r2-v5';
  settings.answerer.citationProtocol = CITATION_PROTOCOL;
  settings.answerer.instructions += ANSWERER_CITATION_SUFFIX;
  settings.answerer.tools_sha256 = ANSWERER_CITED_TOOLS_SHA256;
  settings.answerer.repair_instruction = ANSWERER_CITED_REPAIR;
  settings.scorer.version = 'scorer-r2-v3-grounded';
  settings.scorer.groundingProtocol = GROUNDING_PROTOCOL;
  settings.scorer.instructions = groundedScorerInstructions;
  settings.scorer.tools_sha256 = SCORER_GROUNDED_TOOLS_SHA256;
  settings.scorer.repair_instruction = SCORER_GROUNDED_REPAIR;
  settings.rubric = { version: CITED_RUBRIC_VERSION, instructions: CITED_RUBRIC, examples: CITED_WORKED_EXAMPLES };
  settings.packetSchema.evidenceContract = BLOCK_EVIDENCE_CONTRACT;
  settings.budget.purposes.answerer.taskVersion = settings.answerer.version;
  settings.budget.purposes.scorer.taskVersion = settings.scorer.version;
  return sealComparison(settings);
}
