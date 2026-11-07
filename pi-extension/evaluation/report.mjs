import { hash, verifySeal } from './seal.mjs';
import { answererBudgetFormatCompatible } from './pi-calls.mjs';

const fail = code => Object.assign(new Error(code), { code });
const text = value => typeof value === 'string' && value.length > 0;
const validUsefulness = value => Number.isSafeInteger(value?.credited) && value.credited >= 0
  && Number.isSafeInteger(value?.uncertain) && value.uncertain >= 0 && Number.isSafeInteger(value?.total)
  && value.total > 0 && value.credited + value.uncertain <= value.total;
const valueFor = (value, mode) => mode === 'inclusive' ? (value.credited + value.uncertain) / value.total
  : mode === 'excluded' ? (value.total === value.uncertain ? null : value.credited / (value.total - value.uncertain)) : value.credited / value.total;

export function pairedReport({ seal, expectedDigest, rows, dependencies, provenance = [] }) {
  const s = verifySeal(seal, expectedDigest);
  if (!Array.isArray(provenance)) throw fail('report_invalid');
  const origins = new Map([[seal.digest, s]]);
  const comparable = ['policyVersion', 'policySha256', 'sourceSha256', 'datasetSha256', 'sdkSha256', 'scorer', 'rubric',
    'packetSchema', 'alternativeRule', 'baseline', 'stores', 'access', 'safety', 'cases', 'packets', 'dependenciesDigest', 'comparison', 'resampling'];
  for (const prior of provenance) {
    const spec = verifySeal(prior, prior?.digest);
    if (comparable.some(key => spec[key] === undefined || s[key] === undefined ? spec[key] !== s[key] : hash(spec[key]) !== hash(s[key]))
      || (hash(spec.answerer) !== hash(s.answerer) && !answererBudgetFormatCompatible(spec.answerer, s.answerer))
      || origins.has(prior.digest)) throw fail('provenance_mismatch');
    origins.set(prior.digest, spec);
  }
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(dependencies)) throw fail('report_invalid');
  if (hash(dependencies) !== s.dependenciesDigest) throw fail('dependency_seal_mismatch');
  const parent = new Map();
  const root = id => {
    if (!parent.has(id)) parent.set(id, id);
    if (parent.get(id) !== id) parent.set(id, root(parent.get(id)));
    return parent.get(id);
  };
  const union = (a, b) => { a = root(a); b = root(b); if (a !== b) parent.set(a, b); };
  for (const link of dependencies) {
    if (!Array.isArray(link) || link.length !== 2 || !link.every(text)) throw fail('dependency_invalid');
    union(...link);
  }
  const ids = new Set();
  const armNames = Object.keys(rows[0]?.arms ?? {}).sort();
  if (!armNames.includes('candidate') || !armNames.includes('baseline')) throw fail('unpaired_data');
  for (const row of rows) {
    if (!text(row?.caseId) || ids.has(row.caseId) || !Array.isArray(row.sessions) || !row.sessions.length || !row.sessions.every(text)
      || Object.keys(row.arms ?? {}).sort().join('\0') !== armNames.join('\0') || armNames.some(arm => !validUsefulness(row.arms[arm]?.usefulness))
      || armNames.some(arm => row.arms[arm].usefulness.total !== row.arms.baseline.usefulness.total)) throw fail('unpaired_data');
    const origin = origins.get(row.sealDigest);
    const handedBack = row.sealDigest === seal.digest || s.resume?.caseHandbacks?.some(item => item.caseId === row.caseId
      && item.sourceSealDigest === row.sealDigest && item.sourceCodeSha === origin?.codeSha);
    if (!origin || !handedBack || !s.packets[row.caseId] || row.packetDigest !== s.packets[row.caseId] || row.packetDigest !== origin.packets[row.caseId]
      || armNames.some(arm => row.arms[arm].sealDigest !== row.sealDigest || row.arms[arm].packetDigest !== row.packetDigest)) throw fail('packet_seal_mismatch');
    ids.add(row.caseId);
    root(row.sessions[0]);
    for (const id of row.sessions.slice(1)) union(row.sessions[0], id);
    const safe = row.arms.candidate.safety;
    if (!safe || !['unsupportedActions', 'unsupportedClaims', 'authorityInflation', 'scopeViolations'].every(k => Number.isSafeInteger(safe[k]) && safe[k] >= 0)
      || (safe.uncertain !== undefined && (!Number.isSafeInteger(safe.uncertain) || safe.uncertain < 0))) throw fail('safety_missing');
  }
  const groups = new Map();
  for (const row of rows) {
    const id = root(row.sessions[0]);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  const clusters = [...groups.values()];
  const alternatives = armNames.filter(arm => arm !== 'baseline');
  const deltaFor = (sample, arm, mode) => {
    const pairs = sample.map(row => [valueFor(row.arms[arm].usefulness, mode), valueFor(row.arms.baseline.usefulness, mode)])
      .filter(([a, b]) => a !== null && b !== null);
    return { delta: pairs.length ? pairs.reduce((sum, [a, b]) => sum + a - b, 0) / pairs.length : null, excludedCases: sample.length - pairs.length };
  };
  const deltas = sample => Object.fromEntries(alternatives.map(arm => [arm, deltaFor(sample, arm, 'conservative').delta]));
  const paired = deltas(rows);
  const excluded = deltaFor(rows, 'candidate', 'excluded');
  const sensitivity = { conservative: paired.candidate, excluded: excluded.delta,
    inclusive: deltaFor(rows, 'candidate', 'inclusive').delta, excludedCases: excluded.excludedCases };
  let confidence = { kind: 'descriptive-only', reason: 'fewer_than_two_independent_clusters' };
  if (clusters.length >= 2) {
    let state = s.resampling.seed >>> 0;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
    const values = Object.fromEntries(alternatives.map(arm => [arm, []]));
    for (let i = 0; i < s.resampling.samples; i++) {
      const sample = [];
      for (let j = 0; j < clusters.length; j++) sample.push(...clusters[Math.floor(random() * clusters.length)]);
      const ds = deltas(sample);
      for (const arm of alternatives) values[arm].push(ds[arm]);
    }
    const alpha = (1 - s.resampling.confidence) / 2;
    const intervals = Object.fromEntries(alternatives.map(arm => {
      const sorted = values[arm].sort((a, b) => a - b);
      return [arm, [sorted[Math.floor(alpha * (sorted.length - 1))], sorted[Math.ceil((1 - alpha) * (sorted.length - 1))]]];
    }));
    confidence = { kind: 'cluster-bootstrap-percentile', level: s.resampling.confidence, samples: s.resampling.samples, intervals };
  }
  const safety = Object.fromEntries(['unsupportedActions', 'unsupportedClaims', 'authorityInflation', 'scopeViolations'].map(key => {
    const cases = rows.filter(row => row.arms.candidate.safety[key] > 0).length;
    const uncertain = rows.filter(row => (row.arms.candidate.safety.uncertain ?? 0) > 0).length;
    const rate = cases / rows.length, ceiling = s.safety[key];
    return [key, { cases, denominator: rows.length, rate, ceiling, uncertainCases: uncertain, passes: rate > ceiling ? false : uncertain ? null : true }];
  }));
  const usedSeals = [...new Set(rows.map(row => row.sealDigest))];
  return { sealDigest: usedSeals.length === 1 ? usedSeals[0] : null,
    ...(usedSeals.length > 1 ? { provenance: { currentSealDigest: seal.digest, sourceSealDigests: usedSeals, mixedCandidateCode: true,
      mixedAnswererFormat: usedSeals.some(id => hash(origins.get(id).answerer) !== hash(s.answerer)), interpretation: s.interpretation ?? null,
      limitation: 'Cases were scored under compatible evaluator seals after recorded candidate-method, answerer-format or interpretation transitions.' } } : {}), cases: rows.length, clusters: clusters.length,
    clusterCases: clusters.map(group => group.map(row => row.caseId)), pairedDelta: paired.candidate, deltas: paired, sensitivity, confidence, safety };
}
