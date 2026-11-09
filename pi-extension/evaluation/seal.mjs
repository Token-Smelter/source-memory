import { createHash } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const uint = value => Number.isSafeInteger(value) && value >= 0;
const strings = value => Array.isArray(value) && value.length > 0 && value.every(nonempty) && new Set(value).size === value.length;
const digestMap = value => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length > 0
  && Object.entries(value).every(([key, digest]) => nonempty(key) && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));

export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw fail('non_json_value');
}

export function hash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }

export function modelFingerprint(model) {
  if (![model?.provider, model?.id, model?.api, model?.baseUrl].every(nonempty)
    || !uint(model.contextWindow) || !uint(model.maxTokens) || !Array.isArray(model.input) || typeof model.reasoning !== 'boolean') throw fail('model_identity_unavailable');
  return hash({ provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl, contextWindow: model.contextWindow,
    maxTokens: model.maxTokens, input: model.input, reasoning: model.reasoning, compat: model.compat ?? null, cost: model.cost ?? null });
}

function validate(s) {
  const a = s?.answerer, sc = s?.scorer, l = a?.limits;
  if (![s?.version, s?.policyVersion, s?.freezeBasis, a?.route, a?.model, a?.reasoning, a?.instructions, a?.version,
    a?.contextPolicy, a?.retrievalInterface, sc?.route, sc?.model, sc?.reasoning, sc?.instructions, sc?.version,
    s?.rubric?.version, s?.rubric?.instructions, s?.packetSchema?.version, s?.packetSchema?.definition,
    s?.baseline?.name, s?.baseline?.storeId, s?.stores?.candidate, s?.stores?.reference,
    s?.alternativeRule?.version, s?.alternativeRule?.auditMethod, s?.budget?.version, s?.budget?.capNano,
    s?.budget?.rateCardVersion, s?.comparison?.primary].every(nonempty)
    || !Array.isArray(s?.rubric?.examples) || !s.rubric.examples.length
    || s.rubric.examples.some(e => ![e?.source, e?.answer, e?.judgment].every(nonempty))
    || !digestMap(s?.cases) || !digestMap(s?.packets) || !/^[a-f0-9]{64}$/.test(s?.dependenciesDigest ?? '')
    || Object.keys(s.cases).sort().join('\0') !== Object.keys(s.packets).sort().join('\0')
    || a.retrievalInterface !== 'returned-item-evidence-v1'
    || (a.citationProtocol !== undefined && a.citationProtocol !== 'returned-evidence-v1')
    || (a.version === 'answerer-r2-v5' && a.citationProtocol !== 'returned-evidence-v1') || s.packetSchema.version !== 'packet-v1'
    || s.comparison.primary !== 'candidate-minus-named-baseline' || s.comparison.uncertainty !== 'conservative' || s.comparison.caseWeight !== 'equal'
    || s.baseline.storeId === s.stores.candidate || !uint(s.budget.maxSlotsPerPlan) || s.budget.maxSlotsPerPlan < 1
    || !uint(s.budget.maxPlans) || s.budget.maxPlans < 1
    || !s.budget.routes || typeof s.budget.routes !== 'object' || !Object.keys(s.budget.routes).length
    || !s.budget.purposes || typeof s.budget.purposes !== 'object' || !Object.keys(s.budget.purposes).length
    || Object.values(s.budget.purposes).some(p => !nonempty(p?.taskVersion) || !nonempty(p?.route) || !s.budget.routes[p.route])
    || !uint(s?.alternativeRule?.auditSeed) || !uint(s?.alternativeRule?.auditSampleSize) || s.alternativeRule.auditSampleSize < 1
    || !strings(s?.access?.readScopes) || !strings(s?.access?.evidenceScopes)
    || !['searchCalls', 'resolveCalls', 'returnedItems', 'evidenceBytes', 'retrievalBytes', 'queryBytes', 'responseBytes', 'inputTokens', 'outputTokens', 'modelCalls'].every(k => uint(l?.[k]) && l[k] > 0)
    || !/^[1-9]\d*$/.test(l?.costNano ?? '')
    || !['unsupportedActions', 'unsupportedClaims', 'authorityInflation', 'scopeViolations'].every(k => typeof s?.safety?.[k] === 'number' && s.safety[k] >= 0 && s.safety[k] <= 1)
    || !uint(s?.resampling?.samples) || s.resampling.samples < 1 || s.resampling.samples > 100000
    || !uint(s?.resampling?.seed) || s.resampling.seed > 0xffffffff
    || typeof s?.resampling?.confidence !== 'number' || s.resampling.confidence <= 0 || s.resampling.confidence >= 1
    || !/^[1-9]\d*$/.test(s.budget.capNano)) throw fail('settings_invalid');
  canonical(s);
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function sealComparison(spec) {
  validate(spec);
  const copy = JSON.parse(canonical(spec));
  return freezeDeep({ spec: copy, digest: hash(copy) });
}

export function verifySeal(seal, expectedDigest) {
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) throw fail('expected_digest_required');
  if (!seal || typeof seal.digest !== 'string' || !/^[a-f0-9]{64}$/.test(seal.digest)) throw fail('seal_invalid');
  validate(seal.spec);
  if (hash(seal.spec) !== seal.digest || expectedDigest !== seal.digest) throw fail('seal_mismatch');
  return freezeDeep(JSON.parse(canonical(seal.spec)));
}
