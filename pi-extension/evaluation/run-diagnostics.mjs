import { isAbsolute } from 'node:path';
import { CLIMB_ALIGNMENT_SCHEMA, CLIMB_RUN_SCHEMA, MATCH_BUCKETS, assertSameSchedule, refuseHoldoutPaths } from './climb.mjs';

const fail = code => Object.assign(new Error(code), { code });
const missing = reason => ({ available: false, reason });
const deepFreeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child); return Object.freeze(value); };

export const DIAGNOSTICS_SCHEMA = 'climb-diagnostics/v1';

/** The four statements every report and page must carry; they match stage-alignment-method.md. */
export const WORDING = deepFreeze([
  'Alignment is model-based and provisional.',
  'The reference is a target, not ground truth.',
  'The attribution is not source-verified and not causal.',
  'A candidate record counts as aligned only when a matched verdict names it.',
]);

/** Verbatim from the evaluation owner; `finding` is the key this module files each finding class under. */
export const LEVER_TABLE = deepFreeze([
  { finding: 'linking_failure', diagnostic: 'Missing reference edge, both endpoints matched', classification: 'pure linking failure',
    levers: ['link-step guidance', 'link-offer search reach', 'reviewer refusals'] },
  { finding: 'retention_failure', diagnostic: 'Missing edge, an endpoint unmatched', classification: 'retention failure upstream',
    levers: ['retention guidance', 'kinds', 'context cut'] },
  { finding: 'duplicate', diagnostic: 'Candidate records aligned to one reference record', classification: 'duplicate / over-splitting',
    levers: ['search-before-write reach', 'dedup guidance', 'question cap'] },
  { finding: 'unaligned', diagnostic: 'Unaligned candidate records', classification: 'over-retention or unsupported',
    levers: ['retention test', 'evidence rules'] },
  { finding: 'funnel', diagnostic: 'Offered vs proposed vs reviewer-accepted links', classification: 'where links die in the funnel',
    levers: ['offers', 'guidance', 'reviewer'] },
  { finding: 'search_reach', diagnostic: 'Prior record reachable by distiller search at write time', classification: 'search reach',
    levers: ['compact search', 'ranking (cf. fusion probe)'] },
]);

/** Furthest stage a prior record reached at the checkpoint where the later record was written, in order. */
export const STAGES = Object.freeze(['not_previewed', 'previewed_by_compact_search', 'fetched', 'offered_as_link_candidate', 'proposed', 'refused_by_reviewer']);

/** Every fixed reason an input or diagnostic can be unavailable. Unknown is never reported as zero, failure or "not reachable". */
export const UNAVAILABLE_REASONS = Object.freeze([
  'no_alignment', 'alignment_partial', 'alignment_export_mismatch', 'alignment_invalid',
  'reference_schedule_mismatch', 'reference_unavailable',
  'run_directory_missing', 'run_artifact_missing', 'run_artifact_changed', 'run_artifact_invalid',
  'checkpoint_receipts_missing', 'link_receipts_missing', 'link_call_failed', 'receipts_lack_link_fields', 'reviewer_decision_unrecorded',
  'search_statuses_without_ids', 'record_dated_by_first_snapshot', 'endpoints_same_checkpoint',
  'candidate_only_duplicate_clusters_not_inferable', 'checkpoints_unavailable',
]);

const NOT_INFERABLE = 'candidate_only_duplicate_clusters_not_inferable';
const LINK_METHODS = new Set(['beginLinks', 'finishLinks', 'applyLinks']);
const STORED = new Set(['stored_and_returned_provisional', 'stored_not_returned_provisional']);
const UNMATCHED = new Set(['no_match_provisional', 'not_stored_provisional']);
const RELATION_STATUSES = new Set(['directed_edge_observed_provisional', 'directed_edge_not_observed_provisional', 'endpoint_unmatched_or_uncertain']);

// ---------------------------------------------------------------- archive remap

function normalizedPrefix(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw fail('remap_prefix_invalid');
  const prefix = value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
  if (prefix === '/' || prefix.split('/').slice(1).some(segment => !segment || segment === '.' || segment === '..')) throw fail('remap_prefix_invalid');
  return prefix;
}

/** Parses `<old prefix>=<new prefix>`; both sides must be absolute, canonical paths. */
export function parseRemapOption(text) {
  const parts = typeof text === 'string' ? text.split('=') : [];
  if (parts.length !== 2) throw fail('remap_prefix_invalid');
  return { from: parts[0], to: parts[1] };
}

/**
 * Maps pinned absolute paths from an old prefix to a new one. A path is under the prefix only at a path-segment boundary;
 * every other path is returned unchanged. A holdout path is refused on the original and on the mapped path.
 */
export function createPathMap(spec) {
  if (!spec) {
    const inPlace = path => { refuseHoldoutPaths([path]); return path; };
    return Object.assign(inPlace, { spec: null });
  }
  const from = normalizedPrefix(spec.from), to = normalizedPrefix(spec.to);
  refuseHoldoutPaths([from, to]);
  const map = path => {
    if (typeof path !== 'string') return path;
    if (path !== from && !path.startsWith(`${from}/`)) { refuseHoldoutPaths([path]); return path; }
    const mapped = `${to}${path.slice(from.length)}`;
    refuseHoldoutPaths([path, mapped]);
    return mapped;
  };
  return Object.assign(map, { spec: { from, to } });
}

/** Provenance entry for one root: remapped or read in place, with both prefixes of the option. */
export function describeRoot(map, role, original) {
  const mapped = map(original), option = map.spec;
  return { role, status: mapped === original ? 'read_in_place' : 'remapped', path: original, read_at: mapped,
    old_prefix: option?.from ?? null, new_prefix: option?.to ?? null };
}

/** Maps a loader error to a fixed reason; null means a refusal (holdout, non-development source) that must stop the CLI. */
export function artifactFailureReason(error) {
  const code = error?.code;
  if (['holdout_refused', 'source_not_development', 'source_binding_mismatch'].includes(code)) return null;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'run_artifact_missing';
  if (code === 'input_changed' || code === 'run_export_mismatch') return 'run_artifact_changed';
  return 'run_artifact_invalid';
}

// ---------------------------------------------------------------- gates

function alignmentGate({ run, exportSha256, alignment, reference }) {
  if (!alignment) return missing('no_alignment');
  if (alignment.unavailable) return missing(alignment.unavailable);
  if (alignment.schema !== CLIMB_ALIGNMENT_SCHEMA) return missing('alignment_invalid');
  if (alignment.status === 'partial') return missing('alignment_partial');
  if (alignment.status !== 'complete_provisional') return missing('alignment_invalid');
  if (alignment.run_export_sha256 !== exportSha256) return missing('alignment_export_mismatch');
  if (!reference || reference.unavailable) return missing(reference?.unavailable ?? 'reference_unavailable');
  try { assertSameSchedule(reference, run.graph.schedule); } catch { return missing('reference_schedule_mismatch'); }
  const summary = alignment.summary, graphIds = new Set(run.graph.records.map(row => row.id));
  const cutoff = run.graph.checkpoints, expected = new Map(reference.records.filter(row => row.checkpoint_index <= cutoff).map(row => [row.id, row]));
  if (!summary || summary.cutoff !== cutoff || !Array.isArray(summary.items) || !Array.isArray(summary.relations)
    || summary.items.length !== expected.size) return missing('alignment_invalid');
  const items = new Map();
  for (const row of summary.items) {
    if (!expected.has(row?.reference_id) || items.has(row.reference_id) || !MATCH_BUCKETS.includes(row.status) || !Array.isArray(row.candidate_ids)
      || new Set(row.candidate_ids).size !== row.candidate_ids.length || row.candidate_ids.some(id => !graphIds.has(id))
      || STORED.has(row.status) !== (row.candidate_ids.length > 0)) return missing('alignment_invalid');
    items.set(row.reference_id, row);
  }
  if (!Array.isArray(reference.relations)) return missing('reference_unavailable');
  // Every reference edge at or before the cutoff must appear once, in reference order: a missing edge is unknown, not absent.
  const wanted = reference.relations.filter(edge => expected.has(edge?.from) && expected.has(edge?.to));
  if (wanted.length !== summary.relations.length) return missing('alignment_invalid');
  for (const [index, edge] of summary.relations.entries()) {
    const want = wanted[index];
    if (edge?.from !== want.from || edge.to !== want.to || edge.type !== want.type || typeof edge.type !== 'string' || !RELATION_STATUSES.has(edge.status)) return missing('alignment_invalid');
    const matched = items.get(edge.from).candidate_ids.length > 0 && items.get(edge.to).candidate_ids.length > 0;
    if (matched === (edge.status === 'endpoint_unmatched_or_uncertain')) return missing('alignment_invalid');
  }
  return { ok: true, summary, items, expected };
}

function searchEvidence(disposition) {
  const empty = { previewed: new Set(), fetched: new Set(), offered: new Set(), offers: 0, ids: true, offersKnown: true, fetchedKnown: true, complete: true };
  if (disposition.disposition === 'ineligible_by_policy') return empty;
  const statuses = Array.isArray(disposition.search_statuses) ? disposition.search_statuses : [];
  const compact = statuses.filter(row => row?.surface === 'compact-records'), offers = statuses.filter(row => row?.surface === 'selected-link-offer');
  const records = statuses.filter(row => row?.surface === 'selected-record');
  const isIds = value => Array.isArray(value) && value.every(id => typeof id === 'string' && id);
  const ids = compact.length > 0 && compact.every(row => isIds(row.previewed_ids));
  const offersKnown = compact.length > 0 && offers.every(row => isIds(row.candidate_ids));
  // A fetch that was refused by a limit names no record; any other selected-record row without an id hides what was fetched.
  const fetchedKnown = records.every(row => (typeof row.id === 'string' && row.id) || ['fetch_limit', 'fetch_budget_exceeded'].includes(row.status));
  const strings = values => values.filter(value => typeof value === 'string');
  return { ids, offersKnown, fetchedKnown, complete: ids && offersKnown && fetchedKnown, offers: offers.length,
    previewed: new Set(compact.flatMap(row => strings(row.previewed_ids ?? []))),
    fetched: new Set(strings(records.map(row => row.id))),
    offered: new Set(offers.flatMap(row => strings(row.candidate_ids ?? []))) };
}

/** One checkpoint's link activity from the memory receipts: the proposals and what the reviewer and apply step did with them. */
function linkEvidence(rows, search, disposition) {
  const link = rows.filter(row => LINK_METHODS.has(row.method));
  const begins = link.filter(row => row.method === 'beginLinks'), finishes = link.filter(row => row.method === 'finishLinks'), applies = link.filter(row => row.method === 'applyLinks');
  if (!rows.length && disposition.disposition !== 'ineligible_by_policy') return { state: 'unknown', reason: 'checkpoint_receipts_missing' };
  // No link activity is a known zero only when the search statuses show that no offer was made; without them it is unknown.
  if (!search.offers && !begins.length) return search.offersKnown ? { state: 'none' } : { state: 'unknown', reason: 'search_statuses_without_ids' };
  if (!begins.some(row => row.ok === true)) return { state: 'unknown', reason: begins.length ? 'link_call_failed' : 'link_receipts_missing' };
  if (finishes.some(row => row.ok !== true)) return { state: 'unknown', reason: 'link_call_failed' };
  const proposals = [], unresolved = [];
  let accepted = 0, applied = 0, decisionsKnown = true;
  for (const row of finishes) {
    const value = row.value;
    if (!Array.isArray(value?.proposals) || !Array.isArray(value.unresolved) || !Array.isArray(value.references?.records)) return { state: 'unknown', reason: 'receipts_lack_link_fields' };
    const ids = new Map(value.references.records.map(entry => [entry.ref, entry.id]));
    const resolve = (list, reviewable) => list.map((entry, index) => ({ type: entry.type, from_id: ids.get(entry.from) ?? null, to_id: ids.get(entry.to) ?? null, reviewable, index }));
    const own = resolve(value.proposals, true), loose = resolve(value.unresolved, false);
    if ([...own, ...loose].some(entry => !entry.from_id || !entry.to_id)) return { state: 'unknown', reason: 'receipts_lack_link_fields' };
    const apply = applies.find(entry => entry.ok === true && entry.value?.review?.operation_id === value.operation_id);
    const approved = Array.isArray(apply?.value?.review?.approved) ? apply.value.review.approved : null;
    for (const entry of own) entry.decision = approved ? (approved.includes(entry.index) ? 'accepted' : 'refused') : 'unknown';
    if (own.length && !approved) decisionsKnown = false;
    else {
      accepted += approved?.length ?? 0;
      const written = apply?.value?.status === 'written' ? (apply.value.receipt?.relations ?? apply.value.enrichment?.relations) : [];
      if (own.length && !Array.isArray(written)) decisionsKnown = false; else applied += own.length ? written.length : 0;
    }
    proposals.push(...own);
    unresolved.push(...loose);
  }
  return { state: 'ok', proposals, unresolved, accepted: decisionsKnown ? accepted : null, applied: decisionsKnown ? applied : null };
}

function artifactGate(run, artifacts) {
  if (!artifacts || artifacts.unavailable) return missing(artifacts?.unavailable ?? 'run_artifact_invalid');
  const dispositions = artifacts.report?.coverage?.dispositions;
  if (!Array.isArray(dispositions) || JSON.stringify(dispositions.map(row => row?.through)) !== JSON.stringify(run.graph.schedule)
    || !Array.isArray(artifacts.receiptRuns)) return missing('run_artifact_invalid');
  // A resumed run may have retried a checkpoint: the newest run that has receipts for it is the one that counts.
  const byCheckpoint = new Map();
  for (const rows of artifacts.receiptRuns) {
    const fresh = new Map();
    for (const row of rows) if (!byCheckpoint.has(row.checkpoint)) {
      if (!fresh.has(row.checkpoint)) fresh.set(row.checkpoint, []);
      fresh.get(row.checkpoint).push(row);
    }
    for (const [checkpoint, list] of fresh) byCheckpoint.set(checkpoint, list);
  }
  const evidence = dispositions.map((disposition, i) => {
    const search = searchEvidence(disposition);
    return { index: i + 1, through: disposition.through, disposition: disposition.disposition, search,
      link: linkEvidence(byCheckpoint.get(disposition.through) ?? [], search, disposition) };
  });
  return { ok: true, evidence };
}

// ---------------------------------------------------------------- the five diagnostics

const sortRecords = (ids, byId) => [...ids].map(id => byId.get(id)).sort((a, b) => a.checkpoint_index - b.checkpoint_index || a.id.localeCompare(b.id));
const recordView = row => ({ id: row.id, kind: row.kind, checkpoint_index: row.checkpoint_index, dated_by: row.dated_by });
const leversOf = finding => [...LEVER_TABLE.find(row => row.finding === finding).levers];

function edgeGaps(gate, reference, byId) {
  const refs = new Map(reference.records.map(row => [row.id, row]));
  const endpoint = id => { const item = gate.items.get(id); return { reference_id: id, reference_checkpoint_index: refs.get(id).checkpoint_index, status: item.status,
    candidate_ids: sortRecords(item.candidate_ids, byId).map(row => row.id) }; };
  const counts = { observed: 0, linking_failure: 0, retention_failure: 0, uncertain: 0 };
  const edges = gate.summary.relations.map(edge => {
    const from = endpoint(edge.from), to = endpoint(edge.to);
    let kind;
    if (edge.status === 'directed_edge_observed_provisional') kind = 'observed';
    else if (from.candidate_ids.length && to.candidate_ids.length) kind = 'linking_failure';
    else kind = UNMATCHED.has(from.status) || UNMATCHED.has(to.status) ? 'retention_failure' : 'uncertain';
    counts[kind]++;
    const row = { from: edge.from, to: edge.to, type: edge.type, class: kind, endpoints: { from, to }, levers: kind === 'linking_failure' || kind === 'retention_failure' ? leversOf(kind) : [] };
    if (kind === 'retention_failure') row.unmatched_endpoints = ['from', 'to'].filter(side => UNMATCHED.has({ from, to }[side].status));
    return row;
  });
  return { available: true, cutoff: gate.summary.cutoff, counts: { ...counts, total: edges.length }, edges };
}

function duplicates(gate, byId) {
  const rows = [...gate.items.values()].filter(item => item.candidate_ids.length >= 2).sort((a, b) => a.reference_id.localeCompare(b.reference_id))
    .map(item => ({ reference_id: item.reference_id, candidates: sortRecords(item.candidate_ids, byId).map(recordView), levers: leversOf('duplicate') }));
  return { available: true, aligned_to_one_reference: { available: true, count: rows.length, references: rows },
    candidate_only_clusters: missing(NOT_INFERABLE) };
}

function unaligned(gate, run, byId) {
  const named = new Set([...gate.items.values()].flatMap(item => item.candidate_ids));
  const rows = run.graph.records.filter(row => !named.has(row.id)).map(row => ({ ...recordView(byId.get(row.id)), levers: leversOf('unaligned') }));
  return { available: true, candidate_records: run.graph.records.length, count: rows.length, records: rows };
}

const FUNNEL_FIELDS = ['offered', 'proposed', 'unresolved', 'reviewer_accepted', 'reviewer_refused', 'applied'];

function funnel(gate, evidence) {
  const rows = evidence.map(entry => {
    const { search, link } = entry, counts = Object.fromEntries(FUNNEL_FIELDS.map(field => [field, null])), reasons = {};
    if (search.offersKnown) counts.offered = search.offered.size; else reasons.offered = 'search_statuses_without_ids';
    if (link.state === 'none') for (const field of FUNNEL_FIELDS.slice(1)) counts[field] = 0;
    else if (link.state === 'unknown') for (const field of FUNNEL_FIELDS.slice(1)) reasons[field] = link.reason;
    else {
      counts.proposed = link.proposals.length;
      counts.unresolved = link.unresolved.length;
      if (link.accepted === null) for (const field of ['reviewer_accepted', 'reviewer_refused', 'applied']) reasons[field] = 'reviewer_decision_unrecorded';
      else Object.assign(counts, { reviewer_accepted: link.accepted, reviewer_refused: link.proposals.length - link.accepted, applied: link.applied });
    }
    return { checkpoint_index: entry.index, through: entry.through, disposition: entry.disposition, counts, unavailable: reasons };
  });
  const reasons = new Set(evidence.map(entry => entry.link.state === 'unknown' ? entry.link.reason : null));
  if (reasons.size === 1 && !reasons.has(null)) return missing([...reasons][0]);
  // Without a single checkpoint whose link calls were recorded, no proposal, decision or applied count can be known.
  if (!evidence.some(entry => entry.link.state === 'ok') && evidence.some(entry => entry.link.state === 'unknown' && entry.link.reason === 'link_receipts_missing')) return missing('link_receipts_missing');
  const totals = Object.fromEntries(FUNNEL_FIELDS.map(field => {
    const unknown = rows.filter(row => row.counts[field] === null).map(row => row.checkpoint_index);
    return [field, unknown.length ? { available: false, reason: 'checkpoints_unavailable', checkpoint_indices: unknown }
      : { available: true, value: rows.reduce((sum, row) => sum + row.counts[field], 0) }];
  }));
  // A finding is a checkpoint where links were lost at one stage; it is only reported from counts that are all known.
  const findings = [];
  for (const row of rows) {
    const c = row.counts, add = (died_at, links) => findings.push({ checkpoint_index: row.checkpoint_index, died_at, links, levers: leversOf('funnel') });
    if (c.offered > 0 && c.proposed === 0) add('offered_not_proposed', c.offered);
    if (c.unresolved > 0) add('not_reviewable', c.unresolved);
    if (c.reviewer_refused > 0) add('refused_by_reviewer', c.reviewer_refused);
    if (c.reviewer_accepted !== null && c.applied !== null && c.reviewer_accepted > c.applied) add('accepted_not_applied', c.reviewer_accepted - c.applied);
  }
  return { available: true, note: 'offered counts distinct prior records the distiller selected for the link offer; the other columns count links', checkpoints: rows, totals, findings };
}

function pairReach(a, b, evidence) {
  const [prior, later] = (a.checkpoint_index - b.checkpoint_index || a.id.localeCompare(b.id)) <= 0 ? [a, b] : [b, a];
  const base = { prior_id: prior.id, later_id: later.id, prior_checkpoint_index: prior.checkpoint_index, later_checkpoint_index: later.checkpoint_index,
    dating: { prior: prior.dated_by, later: later.dated_by } };
  if (prior.dated_by === 'first_snapshot' || later.dated_by === 'first_snapshot') return { ...base, ...missing('record_dated_by_first_snapshot') };
  if (prior.checkpoint_index === later.checkpoint_index) return { ...base, ...missing('endpoints_same_checkpoint') };
  const at = evidence[later.checkpoint_index - 1];
  // Each surface that decides a stage must be recorded with ids; a missing one cannot be read as "not reached".
  if (!at.search.complete) return { ...base, ...missing('search_statuses_without_ids') };
  let stage = at.search.previewed.has(prior.id) ? 1 : 0;
  if (at.search.fetched.has(prior.id)) stage = 2;
  if (at.search.offered.has(prior.id)) stage = 3;
  let decision = null;
  // An offered record may have been proposed or refused; unrecorded link calls leave that open, a record never offered cannot have been.
  if (at.link.state === 'unknown' && stage === 3) return { ...base, ...missing(at.link.reason) };
  if (at.link.state === 'ok') {
    const same = entry => (entry.from_id === prior.id && entry.to_id === later.id) || (entry.from_id === later.id && entry.to_id === prior.id);
    const proposed = at.link.proposals.filter(same), loose = at.link.unresolved.filter(same);
    if (proposed.length || loose.length) stage = 4;
    if (proposed.length) {
      decision = proposed.some(entry => entry.decision === 'accepted') ? 'accepted' : proposed.every(entry => entry.decision === 'refused') ? 'refused' : 'unknown';
      if (decision === 'refused') stage = 5;
      if (decision === 'unknown') return { ...base, ...missing('reviewer_decision_unrecorded') };
    }
  }
  return { ...base, available: true, furthest_stage: STAGES[stage], reviewer_decision: decision };
}

const PAIR_REASON_ORDER = ['record_dated_by_first_snapshot', 'endpoints_same_checkpoint', 'search_statuses_without_ids', 'reviewer_decision_unrecorded',
  'checkpoint_receipts_missing', 'link_receipts_missing', 'link_call_failed', 'receipts_lack_link_fields'];

function searchReach(edges, byId, evidence) {
  const failures = edges.filter(edge => edge.class === 'linking_failure');
  if (failures.length && failures.every(edge => [...edge.endpoints.from.candidate_ids, ...edge.endpoints.to.candidate_ids]
    .every(id => !evidence[byId.get(id).checkpoint_index - 1].search.complete))) return missing('search_statuses_without_ids');
  const findings = failures.map(edge => {
    const pairs = [];
    for (const from of edge.endpoints.from.candidate_ids) for (const to of edge.endpoints.to.candidate_ids) if (from !== to) pairs.push(pairReach(byId.get(from), byId.get(to), evidence));
    const head = { from: edge.from, to: edge.to, type: edge.type, pairs };
    // One pair with unknown evidence leaves the furthest stage of the edge unknown: the other pairs could be behind it.
    const blocked = PAIR_REASON_ORDER.find(reason => pairs.some(pair => pair.reason === reason));
    if (blocked || !pairs.length) return { ...head, ...missing(blocked ?? 'search_statuses_without_ids') };
    const best = pairs.reduce((top, pair) => STAGES.indexOf(pair.furthest_stage) > STAGES.indexOf(top.furthest_stage) ? pair : top);
    return { ...head, available: true, furthest_stage: best.furthest_stage, levers: leversOf('search_reach') };
  });
  const stages = Object.fromEntries(STAGES.map(stage => [stage, findings.filter(row => row.available && row.furthest_stage === stage).length]));
  return { available: true, linking_failures: failures.length, findings, stage_counts: stages,
    unavailable_findings: findings.filter(row => !row.available).length };
}

function leverTotals(counts, unavailable) {
  const totals = new Map();
  for (const row of LEVER_TABLE) for (const lever of row.levers) {
    const entry = totals.get(lever) ?? { lever, findings: 0, by_class: {}, unavailable_classes: [] };
    if (unavailable.has(row.finding)) entry.unavailable_classes.push(row.finding);
    else { entry.findings += counts[row.finding]; entry.by_class[row.finding] = counts[row.finding]; }
    totals.set(lever, entry);
  }
  return [...totals.values()];
}

/**
 * Pure, deterministic diagnostics for one completed run. `alignment`, `reference` and `artifacts` may each be absent or
 * carry `{ unavailable: <reason> }`; the parts that need them are then unavailable with that fixed reason, never zero.
 */
export function diagnoseRun({ run, exportSha256, alignment = null, reference = null, artifacts = null, provenance = null, generatedAt }) {
  if (run?.schema !== CLIMB_RUN_SCHEMA || !Array.isArray(run.graph?.records) || !Array.isArray(run.graph.schedule)
    || !Number.isSafeInteger(run.graph.checkpoints) || !/^[a-f0-9]{64}$/.test(exportSha256 ?? '')) throw fail('run_export_invalid');
  const byId = new Map(run.graph.records.map(row => [row.id, row]));
  const gate = alignmentGate({ run, exportSha256, alignment, reference }), data = artifactGate(run, artifacts);
  const fromAlignment = build => gate.ok ? build() : missing(gate.reason);
  const edges = fromAlignment(() => edgeGaps(gate, reference, byId));
  const dup = fromAlignment(() => duplicates(gate, byId));
  const unal = fromAlignment(() => unaligned(gate, run, byId));
  const link = data.ok ? funnel(gate, data.evidence) : missing(data.reason);
  const reach = !gate.ok ? missing(gate.reason) : !data.ok ? missing(data.reason) : searchReach(edges.edges, byId, data.evidence);
  const counts = { linking_failure: edges.counts?.linking_failure ?? 0, retention_failure: edges.counts?.retention_failure ?? 0,
    duplicate: dup.aligned_to_one_reference?.count ?? 0, unaligned: unal.count ?? 0, funnel: link.findings?.length ?? 0,
    search_reach: reach.findings?.filter(row => row.available).length ?? 0 };
  const unavailable = new Set([...(edges.available ? [] : ['linking_failure', 'retention_failure']), ...(dup.available ? [] : ['duplicate']),
    ...(unal.available ? [] : ['unaligned']), ...(link.available ? [] : ['funnel']), ...(reach.available ? [] : ['search_reach'])]);
  return { schema: DIAGNOSTICS_SCHEMA, generated_at: generatedAt, development_only: true, wording: [...WORDING],
    reference_caption: reference?.caption ?? null,
    run: { source_key: run.source_key, treatment: run.treatment, run_id: run.run_id, export_sha256: exportSha256, report_sha256: run.report_sha256,
      seal_sha256: run.seal_sha256, code_sha: run.code_sha, cutoff: run.graph.checkpoints, coverage_status: run.coverage_status },
    alignment: alignment && !alignment.unavailable ? { status: alignment.status ?? null, run_export_sha256: alignment.run_export_sha256 ?? null } : null,
    provenance,
    edge_gaps: edges, duplicates: dup, unaligned_candidates: unal, link_funnel: link, search_reach: reach,
    levers: { table: LEVER_TABLE.map(row => ({ ...row, levers: [...row.levers] })), finding_counts: counts, unavailable_classes: [...unavailable].sort(),
      totals: leverTotals(counts, unavailable),
      note: 'Levers are attached by finding class; uncertain edges and unavailable findings carry none. A count is a number of findings, not a measured effect.' } };
}

// ---------------------------------------------------------------- page

const embed = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const STYLE = `
:root{--bg:#f4f1ea;--ink:#1d1c1a;--muted:#6b665c;--line:#d8d1c3;--panel:#fffdf8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
header,section{margin:14px 18px;padding:10px 12px;background:var(--panel);border:1px solid var(--line);border-radius:6px}
h1{font:600 17px/1.2 ui-serif,Georgia,serif;margin:0 0 6px}h2{font:600 15px ui-serif,Georgia,serif;margin:0 0 6px}
.wording{margin:6px 0 0;padding-left:18px}.muted{color:var(--muted)}.na{color:#8c2a1f;font-weight:600}
table{border-collapse:collapse;margin:6px 0;width:100%}th,td{border:1px solid var(--line);padding:3px 6px;text-align:left;vertical-align:top}th{background:#ece6da}
svg{width:100%;max-width:560px;height:auto;display:block}`;

const SCRIPT = `
const D=JSON.parse(document.getElementById('data').textContent);
const NS='http://www.w3.org/2000/svg';
const el=(tag,attrs,parent)=>{const n=tag.startsWith('svg:')?document.createElementNS(NS,tag.slice(4)):document.createElement(tag);
  for(const[k,v]of Object.entries(attrs||{}))k==='text'?n.textContent=String(v):n.setAttribute(k,String(v));if(parent)parent.appendChild(n);return n};
const show=v=>v===null||v===undefined?'unknown':Array.isArray(v)?v.join(', '):String(v);
const head=document.getElementById('head');
el('h1',{text:'Source Memory run diagnostics (private)'},head);
el('p',{class:'muted',text:D.run.source_key+' · '+D.run.treatment+' · run '+D.run.run_id+' · cutoff checkpoint '+D.run.cutoff+' · generated '+D.generated_at},head);
const words=el('ul',{class:'wording'},head);for(const w of D.wording)el('li',{text:w},words);
if(D.reference_caption)el('p',{class:'muted',text:'Reference: '+D.reference_caption},head);
const main=document.getElementById('main');
function section(title,part){const s=el('section',{},main);el('h2',{text:title},s);
  if(part.available===false){el('p',{class:'na',text:'Unavailable: '+part.reason+' (unknown, not a zero count)'},s);return null}return s}
function table(parent,cols,rows){const t=el('table',{},parent),h=el('tr',{},t);for(const c of cols)el('th',{text:c},h);
  for(const r of rows){const tr=el('tr',{},t);for(const c of r)el('td',{text:show(c)},tr)}}
function bars(parent,items){const W=520,row=20,svg=el('svg:svg',{viewBox:'0 0 '+W+' '+(row*items.length+4)},parent),top=Math.max(1,...items.map(i=>i[1]||0));
  items.forEach((it,i)=>{el('svg:text',{x:0,y:row*i+14,'font-size':11,fill:'#1d1c1a',text:it[0]},svg);
    el('svg:rect',{x:230,y:row*i+3,width:Math.max(1,270*((it[1]||0)/top)),height:12,fill:it[1]===null?'#a39e93':'#3b6ea5'},svg);
    el('svg:text',{x:236+270*((it[1]||0)/top),y:row*i+14,'font-size':11,fill:'#6b665c',text:show(it[1])},svg)})}
{const p=D.edge_gaps,s=section('1. Edge-gap attribution',p);if(s){
  bars(s,Object.entries(p.counts));
  table(s,['from','to','type','class','from endpoint','to endpoint','levers'],p.edges.map(e=>[e.from,e.to,e.type,e.class,e.endpoints.from.status+' '+show(e.endpoints.from.candidate_ids),e.endpoints.to.status+' '+show(e.endpoints.to.candidate_ids),e.levers]))}}
{const p=D.duplicates,s=section('2. Duplicates',p);if(s){
  const a=p.aligned_to_one_reference;el('p',{text:'(a) Reference records with two or more stored matched candidate records: '+a.count},s);
  table(s,['reference','candidate records','levers'],a.references.map(r=>[r.reference_id,r.candidates.map(c=>c.id+' (cp '+c.checkpoint_index+', '+c.dated_by+')'),r.levers]));
  el('p',{class:'na',text:'(b) Duplicate clusters among unaligned candidate records: unavailable, '+p.candidate_only_clusters.reason},s)}}
{const p=D.unaligned_candidates,s=section('3. Unaligned candidate records',p);if(s){
  el('p',{text:p.count+' of '+p.candidate_records+' candidate records are named by no matched verdict'},s);
  table(s,['record','kind','checkpoint','dated by','levers'],p.records.map(r=>[r.id,r.kind,r.checkpoint_index,r.dated_by,r.levers]))}}
{const p=D.link_funnel,s=section('4. Link funnel',p);if(s){
  el('p',{class:'muted',text:p.note},s);
  bars(s,Object.entries(p.totals).map(([k,v])=>[k,v.available?v.value:null]));
  table(s,['checkpoint','offered','proposed','not reviewable','accepted','refused','applied','unavailable'],p.checkpoints.map(r=>[r.checkpoint_index,r.counts.offered,r.counts.proposed,r.counts.unresolved,r.counts.reviewer_accepted,r.counts.reviewer_refused,r.counts.applied,Object.entries(r.unavailable).map(([k,v])=>k+': '+v)]))}}
{const p=D.search_reach,s=section('5. Search reach at write time',p);if(s){
  bars(s,Object.entries(p.stage_counts));
  table(s,['from','to','type','furthest stage','pairs'],p.findings.map(f=>[f.from,f.to,f.type,f.available?f.furthest_stage:'unavailable: '+f.reason,f.pairs.map(x=>x.prior_id+' -> '+x.later_id+' ['+x.dating.prior+'/'+x.dating.later+']'+(x.available?'':' unavailable: '+x.reason))]))}}
{const s=el('section',{},main);el('h2',{text:'Levers'},s);el('p',{class:'muted',text:D.levers.note},s);
  table(s,['lever','findings','by class','classes unavailable'],D.levers.totals.map(l=>[l.lever,l.findings,Object.entries(l.by_class).map(([k,v])=>k+' '+v),l.unavailable_classes]))}
{const s=el('section',{},main);el('h2',{text:'Provenance'},s);
  const pv=D.provenance||{};table(s,['root','status','path','read at','old prefix','new prefix'],(pv.roots||[]).map(r=>[r.role,r.status,r.path,r.read_at,r.old_prefix,r.new_prefix]))}`;

/** A self-contained page: data is embedded as inert JSON and rendered only through textContent and SVG attributes. */
export function diagnosticsHtml(report) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Source Memory run diagnostics (private)</title><style>${STYLE}</style></head><body>
<header id="head"></header><main id="main"></main>
<script type="application/json" id="data">${embed(report)}</script><script>${SCRIPT}</script></body></html>`;
}
