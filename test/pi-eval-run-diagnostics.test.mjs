import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { digest } from '../src/core.mjs';
import { DEV_REFERENCES, dashboardHtml, readDevReference, readPinned, runExport } from '../pi-extension/evaluation/climb.mjs';
import { fictionalSettings } from '../pi-extension/evaluation/fictional.mjs';
import { sealComparison } from '../pi-extension/evaluation/seal.mjs';
import { LEVER_TABLE, STAGES, UNAVAILABLE_REASONS, WORDING, artifactFailureReason, createPathMap, describeRoot, diagnoseRun, diagnosticsHtml,
  parseRemapOption } from '../pi-extension/evaluation/run-diagnostics.mjs';
import { diagnoseClimbRun, guardOutputDir, parseArguments } from '../scripts/diagnose-climb-run.mjs';
import { loadRun, writeNew } from '../scripts/export-climb-run.mjs';

// Every record, reference, path and identifier below is fictional.
const DEV = 'doxagon-vault-software-presentations', SOURCE = DEV_REFERENCES[DEV].source_sha256;
const sha = value => createHash('sha256').update(value).digest('hex');
const EXPORT_SHA = 'a'.repeat(64);

// ---------------------------------------------------------------- in-memory fixture holding every finding class

const rec = (id, checkpoint_index, dated_by = 'write_receipt') => ({ id, kind: 'decision', text: `Fictional candidate ${id}.`, checkpoint_index, dated_by });
const refRec = (id, checkpoint_index) => ({ id, kind: 'decision', text: `Fictional reference ${id}.`, checkpoint_index });
const item = (reference_id, status, candidate_ids = []) => ({ reference_id, status, candidate_ids });
const edge = (from, to, type, status) => ({ from, to, type, status });
const NOT_OBSERVED = 'directed_edge_not_observed_provisional', UNMATCHED_EDGE = 'endpoint_unmatched_or_uncertain';
const SCHEDULE = ['e1', 'e2', 'e3', 'e4'];

function fixture() {
  const run = { schema: 'climb-run-graph/v1', source_key: DEV, treatment: 'fiction-t0', run_id: 'run-fiction', report_sha256: 'b'.repeat(64),
    seal_sha256: 'c'.repeat(64), code_sha: 'd'.repeat(40), coverage_status: 'complete',
    graph: { checkpoints: 4, schedule: SCHEDULE, relations: [],
      records: [rec('c1', 1), rec('c2', 1), rec('c3', 2), rec('c4', 2), rec('c9', 2), rec('c5', 3), rec('c6', 3), rec('c7', 4, 'first_snapshot'), rec('c8', 4), rec('c10', 4), rec('c11', 4)] } };
  const reference = { schedule: SCHEDULE, caption: 'fictional reference caption',
    records: [refRec('R1', 1), refRec('R2', 1), refRec('R3', 2), refRec('R6', 2), refRec('R7', 2), refRec('R4', 3), refRec('R5', 3), refRec('R8', 3),
      refRec('R9', 4), refRec('R10', 4), refRec('R11', 4)], relations: [] };
  const alignment = { schema: 'climb-alignment/v1', status: 'complete_provisional', run_export_sha256: EXPORT_SHA,
    summary: { cutoff: 4, items: [
      item('R1', 'stored_and_returned_provisional', ['c1']), item('R2', 'stored_and_returned_provisional', ['c2']),
      item('R3', 'stored_not_returned_provisional', ['c4', 'c3']), item('R4', 'stored_not_returned_provisional', ['c5']),
      item('R5', 'stored_not_returned_provisional', ['c6']), item('R6', 'no_match_provisional'), item('R7', 'not_stored_provisional'),
      item('R8', 'alignment_uncertain'), item('R9', 'stored_not_returned_provisional', ['c7']),
      item('R10', 'stored_not_returned_provisional', ['c8']), item('R11', 'stored_not_returned_provisional', ['c11'])],
    relations: [edge('R2', 'R1', 'supersedes', 'directed_edge_observed_provisional'), edge('R4', 'R1', 'depends_on', NOT_OBSERVED),
      edge('R5', 'R2', 'qualifies', NOT_OBSERVED), edge('R5', 'R3', 'depends_on', NOT_OBSERVED), edge('R10', 'R1', 'supersedes', NOT_OBSERVED),
      edge('R10', 'R2', 'qualifies', NOT_OBSERVED), edge('R11', 'R4', 'depends_on', NOT_OBSERVED), edge('R5', 'R4', 'qualifies', NOT_OBSERVED),
      edge('R9', 'R1', 'supersedes', NOT_OBSERVED), edge('R6', 'R1', 'qualifies', UNMATCHED_EDGE), edge('R7', 'R2', 'depends_on', UNMATCHED_EDGE),
      edge('R8', 'R1', 'qualifies', UNMATCHED_EDGE), edge('R8', 'R6', 'contradicts', UNMATCHED_EDGE)] } };
  reference.relations = alignment.summary.relations.map(({ from, to, type }) => ({ from, to, type }));
  const compact = previewed_ids => ({ surface: 'compact-records', status: 'ready', previewed_ids });
  const fetched = id => ({ surface: 'selected-record', id });
  const offer = candidate_ids => ({ surface: 'selected-link-offer', status: 'selected', candidate_ids });
  const disposition = (through, search_statuses) => ({ through, disposition: 'committed', code: null, search_incomplete: false, search_statuses });
  const report = { coverage: { status: 'complete', scheduled: 4, processed: 4, dispositions: [
    disposition('e1', [compact([])]), disposition('e2', [compact(['c1', 'c2']), fetched('c1'), offer(['c1'])]),
    disposition('e3', [compact(['c2', 'c3', 'c4']), fetched('c3'), offer(['c4'])]), disposition('e4', [compact(['c1', 'c2', 'c5']), fetched('c5'), offer(['c1', 'c2'])])] } };
  const call = (checkpoint, method, value, ok = true) => ({ checkpoint, method, ok, ...(ok ? { value } : { code: 'request_failed', effect: 'none' }) });
  const refs = records => ({ records: records.map(([ref, id]) => ({ ref, id })), sources: [] });
  const receipts = [
    call('e1', 'enrich', { records: ['c1', 'c2'] }), call('e2', 'searchCompact', {}), call('e2', 'beginLinks', { token: 't2', packet: {} }),
    call('e3', 'searchCompact', {}), call('e3', 'beginLinks', { token: 't3', packet: {} }),
    call('e3', 'finishLinks', { operation_id: 'op3', proposals: [], references: refs([['r0', 'c5'], ['r1', 'c4']]),
      unresolved: [{ type: 'depends_on', from: 'r0', to: 'r1', support: 'ambiguous' }] }),
    call('e3', 'applyLinks', { status: 'not_written', records: [], relations: [], review: { operation_id: 'op3', approved: [] } }),
    call('e4', 'searchCompact', {}), call('e4', 'beginLinks', { token: 't4', packet: {} }),
    call('e4', 'finishLinks', { operation_id: 'op4', unresolved: [], references: refs([['r0', 'c8'], ['r1', 'c1'], ['r2', 'c2']]),
      proposals: [{ type: 'supersedes', from: 'r0', to: 'r1', support: 'explicit' }, { type: 'qualifies', from: 'r0', to: 'r2', support: 'explicit' }] }),
    call('e4', 'applyLinks', { status: 'written', receipt: { records: [], relations: ['link-1'] }, review: { operation_id: 'op4', approved: [0] } })];
  return { run, exportSha256: EXPORT_SHA, alignment, reference, artifacts: { report, receiptRuns: [receipts] }, provenance: null, generatedAt: '2030-01-01T00:00:00.000Z' };
}
const diagnose = (change = input => input) => diagnoseRun(change(fixture()));

const LINK = ['link-step guidance', 'link-offer search reach', 'reviewer refusals'];
const RETENTION = ['retention guidance', 'kinds', 'context cut'];
const endpoint = (reference_id, reference_checkpoint_index, status, candidate_ids) => ({ reference_id, reference_checkpoint_index, status, candidate_ids });
const STORED_NOT_RETURNED = 'stored_not_returned_provisional', STORED_RETURNED = 'stored_and_returned_provisional';
const view = (id, checkpoint_index, dated_by = 'write_receipt') => ({ id, kind: 'decision', checkpoint_index, dated_by });

test('the lever table is the evaluation owner table, verbatim', () => {
  assert.deepEqual(LEVER_TABLE.map(row => [row.diagnostic, row.classification, row.levers]), [
    ['Missing reference edge, both endpoints matched', 'pure linking failure', ['link-step guidance', 'link-offer search reach', 'reviewer refusals']],
    ['Missing edge, an endpoint unmatched', 'retention failure upstream', ['retention guidance', 'kinds', 'context cut']],
    ['Candidate records aligned to one reference record', 'duplicate / over-splitting', ['search-before-write reach', 'dedup guidance', 'question cap']],
    ['Unaligned candidate records', 'over-retention or unsupported', ['retention test', 'evidence rules']],
    ['Offered vs proposed vs reviewer-accepted links', 'where links die in the funnel', ['offers', 'guidance', 'reviewer']],
    ['Prior record reachable by distiller search at write time', 'search reach', ['compact search', 'ranking (cf. fusion probe)']]]);
});

test('edge gaps keep observed, linking failure, retention failure and uncertain apart, and lever only the first three kinds of finding', () => {
  const { edge_gaps } = diagnose();
  assert.deepEqual(edge_gaps.counts, { observed: 1, linking_failure: 8, retention_failure: 3, uncertain: 1, total: 13 });
  assert.deepEqual(edge_gaps.edges.map(row => [row.from, row.to, row.type, row.class, row.levers]), [
    ['R2', 'R1', 'supersedes', 'observed', []],
    ['R4', 'R1', 'depends_on', 'linking_failure', LINK], ['R5', 'R2', 'qualifies', 'linking_failure', LINK], ['R5', 'R3', 'depends_on', 'linking_failure', LINK],
    ['R10', 'R1', 'supersedes', 'linking_failure', LINK], ['R10', 'R2', 'qualifies', 'linking_failure', LINK], ['R11', 'R4', 'depends_on', 'linking_failure', LINK],
    ['R5', 'R4', 'qualifies', 'linking_failure', LINK], ['R9', 'R1', 'supersedes', 'linking_failure', LINK],
    ['R6', 'R1', 'qualifies', 'retention_failure', RETENTION], ['R7', 'R2', 'depends_on', 'retention_failure', RETENTION],
    ['R8', 'R1', 'qualifies', 'uncertain', []],
    // An unmatched endpoint outranks an uncertain one.
    ['R8', 'R6', 'contradicts', 'retention_failure', RETENTION]]);
  const byKey = Object.fromEntries(edge_gaps.edges.map(row => [`${row.from}>${row.to}`, row]));
  assert.deepEqual(byKey['R5>R3'].endpoints, { from: endpoint('R5', 3, STORED_NOT_RETURNED, ['c6']), to: endpoint('R3', 2, STORED_NOT_RETURNED, ['c3', 'c4']) });
  assert.deepEqual([byKey['R6>R1'].unmatched_endpoints, byKey['R7>R2'].unmatched_endpoints, byKey['R8>R6'].unmatched_endpoints],
    [['from'], ['from'], ['to']]);
  assert.equal(byKey['R7>R2'].endpoints.from.status, 'not_stored_provisional');
});

test('duplicates list reference records with two or more stored matched candidate records; candidate-only clusters are unavailable', () => {
  assert.deepEqual(diagnose().duplicates, { available: true,
    aligned_to_one_reference: { available: true, count: 1, references: [{ reference_id: 'R3', candidates: [view('c3', 2), view('c4', 2)], levers: ['search-before-write reach', 'dedup guidance', 'question cap'] }] },
    candidate_only_clusters: { available: false, reason: 'candidate_only_duplicate_clusters_not_inferable' } });
});

test('unaligned candidate records are those no matched verdict names', () => {
  assert.deepEqual(diagnose().unaligned_candidates, { available: true, candidate_records: 11, count: 2,
    records: [{ ...view('c9', 2), levers: ['retention test', 'evidence rules'] }, { ...view('c10', 4), levers: ['retention test', 'evidence rules'] }] });
});

test('the link funnel counts offers, proposals, reviewer decisions and applied links per checkpoint and in total', () => {
  const zero = { unresolved: 0 };
  const row = (checkpoint_index, counts) => ({ checkpoint_index, through: SCHEDULE[checkpoint_index - 1], disposition: 'committed', counts, unavailable: {} });
  const levers = ['offers', 'guidance', 'reviewer'];
  assert.deepEqual(diagnose().link_funnel, { available: true,
    note: 'offered counts distinct prior records the distiller selected for the link offer; the other columns count links',
    checkpoints: [
      row(1, { offered: 0, proposed: 0, ...zero, reviewer_accepted: 0, reviewer_refused: 0, applied: 0 }),
      row(2, { offered: 1, proposed: 0, ...zero, reviewer_accepted: 0, reviewer_refused: 0, applied: 0 }),
      row(3, { offered: 1, proposed: 0, unresolved: 1, reviewer_accepted: 0, reviewer_refused: 0, applied: 0 }),
      row(4, { offered: 2, proposed: 2, ...zero, reviewer_accepted: 1, reviewer_refused: 1, applied: 1 })],
    totals: { offered: { available: true, value: 4 }, proposed: { available: true, value: 2 }, unresolved: { available: true, value: 1 },
      reviewer_accepted: { available: true, value: 1 }, reviewer_refused: { available: true, value: 1 }, applied: { available: true, value: 1 } },
    findings: [{ checkpoint_index: 2, died_at: 'offered_not_proposed', links: 1, levers }, { checkpoint_index: 3, died_at: 'offered_not_proposed', links: 1, levers },
      { checkpoint_index: 3, died_at: 'not_reviewable', links: 1, levers }, { checkpoint_index: 4, died_at: 'refused_by_reviewer', links: 1, levers }] });
});

test('search reach reports the furthest stage of the prior record per linking failure, from the later record\'s checkpoint', () => {
  const { search_reach } = diagnose();
  const pair = (prior, later, extra) => ({ prior_id: prior.id, later_id: later.id, prior_checkpoint_index: prior.cp, later_checkpoint_index: later.cp,
    dating: { prior: prior.dating ?? 'write_receipt', later: later.dating ?? 'write_receipt' }, ...extra });
  const c = (id, cp, dating) => ({ id, cp, dating });
  const ok = (furthest_stage, reviewer_decision = null) => ({ available: true, furthest_stage, reviewer_decision });
  const finding = (from, to, type, pairs, { reviewer_decision: _decision, ...rest }) => ({ from, to, type, pairs, ...rest });
  const levers = ['compact search', 'ranking (cf. fusion probe)'];
  assert.deepEqual(search_reach, { available: true, linking_failures: 8, unavailable_findings: 2,
    stage_counts: { not_previewed: 1, previewed_by_compact_search: 1, fetched: 1, offered_as_link_candidate: 1, proposed: 1, refused_by_reviewer: 1 },
    findings: [
      finding('R4', 'R1', 'depends_on', [pair(c('c1', 1), c('c5', 3), ok('not_previewed'))], { ...ok('not_previewed'), levers }),
      finding('R5', 'R2', 'qualifies', [pair(c('c2', 1), c('c6', 3), ok('previewed_by_compact_search'))], { ...ok('previewed_by_compact_search'), levers }),
      finding('R5', 'R3', 'depends_on', [pair(c('c3', 2), c('c6', 3), ok('fetched')), pair(c('c4', 2), c('c6', 3), ok('offered_as_link_candidate'))],
        { ...ok('offered_as_link_candidate'), levers }),
      finding('R10', 'R1', 'supersedes', [pair(c('c1', 1), c('c8', 4), ok('proposed', 'accepted'))], { ...ok('proposed'), levers }),
      finding('R10', 'R2', 'qualifies', [pair(c('c2', 1), c('c8', 4), ok('refused_by_reviewer', 'refused'))], { ...ok('refused_by_reviewer'), levers }),
      finding('R11', 'R4', 'depends_on', [pair(c('c5', 3), c('c11', 4), ok('fetched'))], { ...ok('fetched'), levers }),
      finding('R5', 'R4', 'qualifies', [pair(c('c5', 3), c('c6', 3), { available: false, reason: 'endpoints_same_checkpoint' })],
        { available: false, reason: 'endpoints_same_checkpoint' }),
      finding('R9', 'R1', 'supersedes', [pair(c('c1', 1), c('c7', 4, 'first_snapshot'), { available: false, reason: 'record_dated_by_first_snapshot' })],
        { available: false, reason: 'record_dated_by_first_snapshot' })] });
});

test('findings are totaled per lever, and no lever is attached to an unavailable class', () => {
  const { levers } = diagnose();
  assert.deepEqual(levers.finding_counts, { linking_failure: 8, retention_failure: 3, duplicate: 1, unaligned: 2, funnel: 4, search_reach: 6 });
  assert.deepEqual(levers.totals.map(row => [row.lever, row.findings, row.unavailable_classes]), [
    ['link-step guidance', 8, []], ['link-offer search reach', 8, []], ['reviewer refusals', 8, []],
    ['retention guidance', 3, []], ['kinds', 3, []], ['context cut', 3, []],
    ['search-before-write reach', 1, []], ['dedup guidance', 1, []], ['question cap', 1, []],
    ['retention test', 2, []], ['evidence rules', 2, []], ['offers', 4, []], ['guidance', 4, []], ['reviewer', 4, []],
    ['compact search', 6, []], ['ranking (cf. fusion probe)', 6, []]]);
  assert.deepEqual(levers.totals[0].by_class, { linking_failure: 8 });
  const none = diagnose(input => ({ ...input, alignment: null })).levers;
  assert.deepEqual(none.unavailable_classes, ['duplicate', 'linking_failure', 'retention_failure', 'search_reach', 'unaligned']);
  assert.deepEqual(none.totals.find(row => row.lever === 'kinds'), { lever: 'kinds', findings: 0, by_class: {}, unavailable_classes: ['retention_failure'] });
  assert.equal(none.totals.find(row => row.lever === 'offers').findings, 4);
});

test('the report states the four mandatory statements and is deterministic', () => {
  const report = diagnose();
  assert.deepEqual(report.wording, [...WORDING]);
  assert.deepEqual(WORDING, ['Alignment is model-based and provisional.', 'The reference is a target, not ground truth.',
    'The attribution is not source-verified and not causal.', 'A candidate record counts as aligned only when a matched verdict names it.']);
  assert.equal(JSON.stringify(diagnose()), JSON.stringify(report));
  assert.ok(STAGES.length === 6 && UNAVAILABLE_REASONS.every(reason => /^[a-z_]+$/.test(reason)));
});

// ---------------------------------------------------------------- unknown is not zero

const UNAVAILABLE = reason => ({ available: false, reason });
const alignmentParts = report => [report.edge_gaps, report.duplicates, report.unaligned_candidates, report.search_reach];

test('no alignment makes the alignment-based parts unavailable, not zero, and leaves the funnel', () => {
  const report = diagnose(input => ({ ...input, alignment: null }));
  assert.deepEqual(alignmentParts(report), Array(4).fill(UNAVAILABLE('no_alignment')));
  assert.equal(report.link_funnel.available, true);
});

test('a partial alignment is unavailable', () => {
  const report = diagnose(input => ({ ...input, alignment: { ...input.alignment, status: 'partial' } }));
  assert.deepEqual(alignmentParts(report), Array(4).fill(UNAVAILABLE('alignment_partial')));
});

test('an alignment bound to other export bytes is unavailable', () => {
  const report = diagnose(input => ({ ...input, alignment: { ...input.alignment, run_export_sha256: 'e'.repeat(64) } }));
  assert.deepEqual(alignmentParts(report), Array(4).fill(UNAVAILABLE('alignment_export_mismatch')));
});

test('a malformed alignment is unavailable', () => {
  const report = diagnose(input => ({ ...input, alignment: { ...input.alignment, summary: { ...input.alignment.summary, items: input.alignment.summary.items.slice(1) } } }));
  assert.deepEqual(alignmentParts(report), Array(4).fill(UNAVAILABLE('alignment_invalid')));
});

test('a reference schedule that does not match the run is unavailable', () => {
  const report = diagnose(input => ({ ...input, reference: { ...input.reference, schedule: ['e1', 'e2', 'zz', 'e4'] } }));
  assert.deepEqual(alignmentParts(report), Array(4).fill(UNAVAILABLE('reference_schedule_mismatch')));
  assert.equal(report.link_funnel.available, true);
});

test('a missing or changed run artifact makes the receipt-based parts unavailable with that reason', () => {
  for (const reason of ['run_directory_missing', 'run_artifact_missing', 'run_artifact_changed', 'run_artifact_invalid']) {
    const report = diagnose(input => ({ ...input, artifacts: { unavailable: reason } }));
    assert.deepEqual([report.link_funnel, report.search_reach], [UNAVAILABLE(reason), UNAVAILABLE(reason)]);
    assert.equal(report.edge_gaps.available, true);
    assert.equal(report.levers.totals.find(row => row.lever === 'offers').findings, 0);
    assert.deepEqual(report.levers.totals.find(row => row.lever === 'offers').unavailable_classes, ['funnel']);
  }
  assert.equal(artifactFailureReason(Object.assign(new Error('x'), { code: 'ENOENT' })), 'run_artifact_missing');
  assert.equal(artifactFailureReason(Object.assign(new Error('x'), { code: 'input_changed' })), 'run_artifact_changed');
  assert.equal(artifactFailureReason(Object.assign(new Error('x'), { code: 'path_invalid' })), 'run_artifact_invalid');
  assert.equal(artifactFailureReason(Object.assign(new Error('x'), { code: 'holdout_refused' })), null);
});

test('receipts without the link methods make the funnel unavailable and leave an offered record\'s reach unavailable, not a lower bound', () => {
  const report = diagnose(input => {
    input.artifacts.receiptRuns = [input.artifacts.receiptRuns[0].filter(row => !['beginLinks', 'finishLinks', 'applyLinks'].includes(row.method))];
    return input;
  });
  assert.deepEqual(report.link_funnel, UNAVAILABLE('link_receipts_missing'));
  const byEdge = Object.fromEntries(report.search_reach.findings.map(row => [`${row.from}>${row.to}`, row]));
  // Offered is all the statuses show; a proposal or refusal cannot be ruled out, so the stage is unknown. A record never offered cannot have been proposed.
  assert.deepEqual([byEdge['R10>R1'].available, byEdge['R10>R1'].reason, byEdge['R10>R2'].available, byEdge['R10>R2'].reason, byEdge['R5>R3'].reason],
    [false, 'link_receipts_missing', false, 'link_receipts_missing', 'link_receipts_missing']);
  assert.deepEqual([byEdge['R4>R1'].furthest_stage, byEdge['R11>R4'].furthest_stage], ['not_previewed', 'fetched']);
});

test('receipts with no link methods and no search statuses leave the funnel unavailable instead of known zeros', () => {
  const report = diagnose(input => {
    input.artifacts.receiptRuns = [input.artifacts.receiptRuns[0].filter(row => !['beginLinks', 'finishLinks', 'applyLinks'].includes(row.method))];
    for (const row of input.artifacts.report.coverage.dispositions) delete row.search_statuses;
    return input;
  });
  assert.deepEqual(report.link_funnel, UNAVAILABLE('search_statuses_without_ids'));
  assert.deepEqual(report.search_reach, UNAVAILABLE('search_statuses_without_ids'));
  assert.equal(report.levers.totals.find(row => row.lever === 'offers').findings, 0);
  assert.deepEqual(report.levers.totals.find(row => row.lever === 'offers').unavailable_classes, ['funnel']);
});

test('a checkpoint without any receipts, a failed link call and receipts lacking link fields are unavailable per checkpoint', () => {
  const only = (report, index) => report.link_funnel.checkpoints[index];
  const withReceipts = change => diagnose(input => { input.artifacts.receiptRuns = [change(input.artifacts.receiptRuns[0])]; return input; });
  const missingCheckpoint = withReceipts(rows => rows.filter(row => row.checkpoint !== 'e3'));
  assert.equal(only(missingCheckpoint, 2).counts.proposed, null);
  assert.equal(only(missingCheckpoint, 2).unavailable.proposed, 'checkpoint_receipts_missing');
  assert.deepEqual(missingCheckpoint.link_funnel.totals.proposed, { available: false, reason: 'checkpoints_unavailable', checkpoint_indices: [3] });
  const failed = withReceipts(rows => rows.map(row => row.checkpoint === 'e4' && row.method === 'finishLinks' ? { checkpoint: 'e4', method: 'finishLinks', ok: false, code: 'request_failed', effect: 'none' } : row));
  assert.equal(only(failed, 3).unavailable.proposed, 'link_call_failed');
  assert.equal(only(failed, 3).counts.reviewer_accepted, null);
  const lacking = withReceipts(rows => rows.map(row => row.checkpoint === 'e4' && row.method === 'finishLinks' ? { ...row, value: { operation_id: 'op4' } } : row));
  assert.equal(only(lacking, 3).unavailable.proposed, 'receipts_lack_link_fields');
  const reach = Object.fromEntries(lacking.search_reach.findings.map(row => [`${row.from}>${row.to}`, row]));
  assert.deepEqual([reach['R10>R1'].available, reach['R10>R1'].reason, reach['R4>R1'].furthest_stage], [false, 'receipts_lack_link_fields', 'not_previewed']);
  const noCheckpoint = Object.fromEntries(missingCheckpoint.search_reach.findings.map(row => [`${row.from}>${row.to}`, row]));
  assert.deepEqual([noCheckpoint['R5>R3'].available, noCheckpoint['R5>R3'].reason], [false, 'checkpoint_receipts_missing']);
});

test('an alignment that omits, repeats or alters a reference edge is invalid, never a zero edge count', () => {
  const edgesOf = change => diagnose(input => { change(input); return input; }).edge_gaps;
  assert.deepEqual(edgesOf(input => { input.alignment.summary.relations = []; }), UNAVAILABLE('alignment_invalid'));
  assert.deepEqual(edgesOf(input => { input.alignment.summary.relations = input.alignment.summary.relations.slice(1); }), UNAVAILABLE('alignment_invalid'));
  assert.deepEqual(edgesOf(input => { input.alignment.summary.relations = [...input.alignment.summary.relations, input.alignment.summary.relations[0]]; }), UNAVAILABLE('alignment_invalid'));
  assert.deepEqual(edgesOf(input => { input.alignment.summary.relations[1] = { ...input.alignment.summary.relations[1], to: 'R2' }; }), UNAVAILABLE('alignment_invalid'));
  assert.deepEqual(edgesOf(input => { input.alignment.summary.relations[1] = { ...input.alignment.summary.relations[1], status: UNMATCHED_EDGE }; }), UNAVAILABLE('alignment_invalid'));
  assert.deepEqual(edgesOf(input => { input.reference.relations.push({ from: 'R3', to: 'R2', type: 'supersedes' }); }), UNAVAILABLE('alignment_invalid'));
  // An edge whose endpoint lies after the cutoff is not a reference edge for this run.
  assert.equal(edgesOf(input => { input.reference.relations.push({ from: 'R3', to: 'R99', type: 'supersedes' }); }).counts.total, 13);
});

test('a fetch or offer without record ids makes the reach unavailable, not a definite stage', () => {
  for (const surface of ['selected-record', 'selected-link-offer']) {
    const report = diagnose(input => {
      const three = input.artifacts.report.coverage.dispositions[2];
      three.search_statuses = three.search_statuses.map(row => row.surface === surface ? { surface, status: 'ok' } : row);
      return input;
    });
    const byEdge = Object.fromEntries(report.search_reach.findings.map(row => [`${row.from}>${row.to}`, row]));
    // Edges whose later record was written at checkpoint 3 cannot say how far the prior record got.
    assert.deepEqual([byEdge['R5>R2'].reason, byEdge['R5>R3'].reason, byEdge['R4>R1'].reason], Array(3).fill('search_statuses_without_ids'), surface);
    assert.deepEqual([byEdge['R10>R1'].furthest_stage, byEdge['R11>R4'].furthest_stage], ['proposed', 'fetched']);
    assert.equal(report.link_funnel.checkpoints[2].counts.offered, surface === 'selected-link-offer' ? null : 1);
  }
  // A fetch refused by a limit names no record and is not a missing id.
  const limited = diagnose(input => { input.artifacts.report.coverage.dispositions[3].search_statuses.push({ surface: 'selected-record', status: 'fetch_limit' }); return input; });
  assert.equal(limited.search_reach.findings.find(row => row.from === 'R10' && row.to === 'R1').furthest_stage, 'proposed');
});

test('search id fields that are not arrays make the reach and funnel unavailable instead of throwing', () => {
  for (const [surface, field] of [['compact-records', 'previewed_ids'], ['selected-link-offer', 'candidate_ids']]) {
    const report = diagnose(input => {
      const three = input.artifacts.report.coverage.dispositions[2];
      three.search_statuses = three.search_statuses.map(row => row.surface === surface ? { ...row, [field]: 'fictional missing ids' } : row);
      return input;
    });
    const byEdge = Object.fromEntries(report.search_reach.findings.map(row => [`${row.from}>${row.to}`, row]));
    assert.deepEqual([byEdge['R5>R2'].reason, byEdge['R5>R3'].reason, byEdge['R4>R1'].reason], Array(3).fill('search_statuses_without_ids'), surface);
    if (surface === 'selected-link-offer') assert.equal(report.link_funnel.checkpoints[2].counts.offered, null);
  }
});

test('a reviewer decision that was not recorded is unknown, not a refusal or an acceptance', () => {
  const report = diagnose(input => {
    input.artifacts.receiptRuns = [input.artifacts.receiptRuns[0].filter(row => !(row.method === 'applyLinks' && row.checkpoint === 'e4'))];
    return input;
  });
  const row = report.link_funnel.checkpoints[3];
  assert.deepEqual([row.counts.proposed, row.counts.reviewer_accepted, row.counts.reviewer_refused, row.counts.applied], [2, null, null, null]);
  assert.deepEqual(row.unavailable, { reviewer_accepted: 'reviewer_decision_unrecorded', reviewer_refused: 'reviewer_decision_unrecorded', applied: 'reviewer_decision_unrecorded' });
  assert.deepEqual(report.link_funnel.totals.applied, { available: false, reason: 'checkpoints_unavailable', checkpoint_indices: [4] });
  const refused = report.search_reach.findings.find(finding => finding.to === 'R2' && finding.from === 'R10');
  assert.deepEqual([refused.available, refused.reason, refused.pairs[0].reason], [false, 'reviewer_decision_unrecorded', 'reviewer_decision_unrecorded']);
});

test('search statuses without record ids make reach unavailable and the offered count unknown', () => {
  const report = diagnose(input => {
    for (const row of input.artifacts.report.coverage.dispositions) row.search_statuses = row.search_statuses.map(({ previewed_ids: _ids, candidate_ids: _offered, ...rest }) => rest);
    return input;
  });
  assert.deepEqual(report.search_reach, UNAVAILABLE('search_statuses_without_ids'));
  // No offer was made at checkpoint 1, so zero is known there; elsewhere the offered ids are gone.
  assert.deepEqual(report.link_funnel.checkpoints.map(row => row.counts.offered), [0, null, null, null]);
  assert.equal(report.link_funnel.checkpoints[1].unavailable.offered, 'search_statuses_without_ids');
  assert.equal(report.link_funnel.totals.offered.available, false);
  assert.equal(report.edge_gaps.available, true);
});

test('one checkpoint without ids leaves its findings unavailable and the others intact', () => {
  const report = diagnose(input => {
    input.artifacts.report.coverage.dispositions[3].search_statuses = [{ surface: 'compact-records', status: 'ready' }];
    return input;
  });
  const byEdge = Object.fromEntries(report.search_reach.findings.map(row => [`${row.from}>${row.to}`, row]));
  assert.deepEqual([byEdge['R10>R1'].available, byEdge['R10>R1'].reason, byEdge['R4>R1'].furthest_stage], [false, 'search_statuses_without_ids', 'not_previewed']);
});

test('a record dated by its first snapshot never yields a reach verdict, and the dating basis is on the finding', () => {
  const finding = diagnose().search_reach.findings.find(row => row.from === 'R9');
  assert.deepEqual([finding.available, finding.reason, finding.pairs[0].dating], [false, 'record_dated_by_first_snapshot', { prior: 'write_receipt', later: 'first_snapshot' }]);
  assert.equal(finding.furthest_stage, undefined);
});

test('endpoints written at one checkpoint are not applicable for search reach', () => {
  const finding = diagnose().search_reach.findings.find(row => row.from === 'R5' && row.to === 'R4');
  assert.deepEqual([finding.available, finding.reason], [false, 'endpoints_same_checkpoint']);
});

test('candidate-only duplicate clusters are reported unavailable, never guessed from text', () => {
  const { duplicates } = diagnose(input => { input.run.graph.records.find(row => row.id === 'c10').text = input.run.graph.records.find(row => row.id === 'c9').text; return input; });
  assert.deepEqual(duplicates.candidate_only_clusters, UNAVAILABLE('candidate_only_duplicate_clusters_not_inferable'));
  assert.equal(duplicates.aligned_to_one_reference.count, 1);
});

// ---------------------------------------------------------------- the page

test('the page is self-contained, renders by textContent and SVG attributes, and carries the mandatory wording', () => {
  const input = fixture();
  input.run.graph.records[0].kind = '</script><script>alert(1)</script>';
  const html = diagnosticsHtml(diagnoseRun(input));
  assert.equal(html.includes('</script><script>alert'), false);
  assert.equal(/<script[^>]+src=|<link[^>]+href=|<img|@import|url\(|https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(html), false);
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket/.test(html), false);
  assert.ok(html.includes('textContent') && html.includes('createElementNS'));
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(dashboardHtml({ generatedAt: 'fiction', sessions: [] }))[1];
  assert.ok(html.includes(`Content-Security-Policy" content="${csp}"`) && csp === "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  for (const sentence of WORDING) assert.ok(html.includes(sentence));
  const data = JSON.parse(/<script type="application\/json" id="data">(.*?)<\/script>/s.exec(html)[1]);
  assert.equal(data.run.run_id, 'run-fiction');
});

test('the page script runs against a stub DOM for available and unavailable parts and only sets text and attributes', () => {
  const render = report => {
    const html = diagnosticsHtml(report), all = [];
    const make = tag => { const n = { tag, attrs: {}, children: [], textContent: '', setAttribute(key, value) { this.attrs[key] = value; }, appendChild(child) { this.children.push(child); return child; } }; all.push(n); return n; };
    const byId = { data: { textContent: /<script type="application\/json" id="data">(.*?)<\/script>/s.exec(html)[1] }, head: make('header'), main: make('main') };
    const document = { getElementById: id => byId[id], createElement: make, createElementNS: (_ns, tag) => make(`svg:${tag}`) };
    vm.runInNewContext(/<script>(.*)<\/script><\/body>/s.exec(html)[1], { document });
    return all.map(n => n.textContent).filter(Boolean);
  };
  const full = render(diagnose());
  for (const sentence of WORDING) assert.ok(full.includes(sentence));
  assert.ok(full.includes('compact search') && full.includes('refused_by_reviewer'));
  const none = render(diagnose(input => ({ ...input, alignment: null, artifacts: { unavailable: 'run_artifact_missing' } })));
  assert.ok(none.includes('Unavailable: no_alignment (unknown, not a zero count)') && none.includes('Unavailable: run_artifact_missing (unknown, not a zero count)'));
});

// ---------------------------------------------------------------- archive remap

function temp(prefix = 'diag-') { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }

test('a prefix maps only at path-segment boundaries; other paths are read where they are', () => {
  const map = createPathMap({ from: '/old/root', to: '/new/root' });
  assert.deepEqual(['/old/root', '/old/root/run/REPORT.json', '/old/root-2/run', '/elsewhere/x', '/old'].map(map),
    ['/new/root', '/new/root/run/REPORT.json', '/old/root-2/run', '/elsewhere/x', '/old']);
  assert.deepEqual(createPathMap({ from: '/old/root/', to: '/new/root/' }).spec, { from: '/old/root', to: '/new/root' });
  assert.equal(createPathMap(null)('/anything/else'), '/anything/else');
  assert.deepEqual(parseRemapOption('/a/b=/c/d'), { from: '/a/b', to: '/c/d' });
});

test('a prefix that is not an absolute canonical path is refused', () => {
  for (const spec of [{ from: 'old/root', to: '/new' }, { from: '/old', to: 'new' }, { from: '/', to: '/new' }, { from: '/old/../x', to: '/new' },
    { from: '/old//x', to: '/new' }, { from: '/old/./x', to: '/new' }, { from: '/old', to: '/new/..' }, { from: '', to: '/new' }]) {
    assert.throws(() => createPathMap(spec), /remap_prefix_invalid/);
  }
  for (const text of ['/a/b', '/a=/b=/c', '']) assert.throws(() => parseRemapOption(text), /remap_prefix_invalid/);
});

test('a holdout path is refused on the original and on the mapped path', () => {
  assert.throws(() => createPathMap({ from: '/old/root', to: '/new/holdout-archive' }), /holdout_refused/);
  assert.throws(() => createPathMap({ from: '/old/holdout', to: '/new/root' }), /holdout_refused/);
  const map = createPathMap({ from: '/old/root', to: '/new/root' });
  assert.throws(() => map('/old/root/holdout/run'), /holdout_refused/);
  assert.throws(() => map('/elsewhere/holdout/run'), /holdout_refused/);
});

test('the mapped path passes every existing read check: a moved pinned file is read, a changed byte or a symlink is refused', () => {
  const base = temp(), oldRoot = join(base, 'old'), newRoot = join(base, 'new');
  mkdirSync(newRoot);
  const bytes = Buffer.from('{"fiction":true}');
  writeFileSync(join(newRoot, 'pinned.json'), bytes);
  const map = createPathMap({ from: oldRoot, to: newRoot });
  assert.deepEqual(readPinned(map(join(oldRoot, 'pinned.json')), sha(bytes)), bytes);
  writeFileSync(join(newRoot, 'pinned.json'), Buffer.from('{"fiction":false}'));
  assert.throws(() => readPinned(map(join(oldRoot, 'pinned.json')), sha(bytes)), /input_changed/);
  const outside = join(base, 'outside.json');
  writeFileSync(outside, bytes);
  symlinkSync(outside, join(newRoot, 'link.json'));
  assert.throws(() => readPinned(map(join(oldRoot, 'link.json')), sha(bytes)), /path_invalid/);
  symlinkSync(newRoot, join(base, 'linked-root'));
  const viaLink = createPathMap({ from: oldRoot, to: join(base, 'linked-root') });
  assert.throws(() => readPinned(viaLink(join(oldRoot, 'pinned.json')), sha(Buffer.from('{"fiction":false}'))), /path_invalid/);
  assert.throws(() => readPinned(join(newRoot, 'missing.json'), sha(bytes)), /ENOENT/);
});

test('the reference root is remapped too, and its pinned manifest is still verified at the mapped path', () => {
  const base = temp(), root = DEV_REFERENCES[DEV].root, mapped = join(base, 'ref');
  mkdirSync(mapped);
  const map = createPathMap({ from: root, to: mapped });
  assert.throws(() => readDevReference(DEV, map), /ENOENT/);
  writeFileSync(join(mapped, DEV_REFERENCES[DEV].manifest), Buffer.from('{"fictional":"manifest"}'));
  assert.throws(() => readDevReference(DEV, map), /input_changed/);
  assert.throws(() => readDevReference(DEV, createPathMap({ from: root, to: join(base, 'holdout-ref') })), /holdout_refused/);
  assert.deepEqual(describeRoot(map, 'reference_root', root), { role: 'reference_root', status: 'remapped', path: root, read_at: mapped, old_prefix: root, new_prefix: mapped });
  assert.deepEqual(describeRoot(createPathMap(null), 'reference_root', root), { role: 'reference_root', status: 'read_in_place', path: root, read_at: root, old_prefix: null, new_prefix: null });
});

// ---------------------------------------------------------------- a fictional run directory on disk

const node = (label, body) => ({ labels: [label], properties: { body: JSON.stringify(body) } });

/** Builds a complete fictional run under <base>/old/run-1 plus its export and alignment in <base>/climb. */
function buildWorld(base, { alignmentChange = value => value, resumed = false } = {}) {
  const runDir = join(base, 'old', 'run-1'), climbDir = join(base, 'climb');
  mkdirSync(join(runDir, 'snapshots'), { recursive: true });
  mkdirSync(join(climbDir, 'runs'), { recursive: true, mode: 0o700 });
  chmodSync(climbDir, 0o700);
  const putIn = dir => (rel, value) => {
    const path = join(dir, rel), bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    writeFileSync(path, bytes);
    return { path, sha256: sha(bytes) };
  };
  const put = putIn(runDir);
  const values = [{ records: ['c1'] }, { records: ['c2'] }];
  const record = id => node('SMRecord', { id, kind: 'decision', text: `Fictional candidate ${id}.` });
  const sealSpec = { ...fictionalSettings(), sourceSha256: SOURCE, codeSha: 'c0de', datasetSha256: 'd'.repeat(64) };
  // A resumed run inherits checkpoint 1 from run-0, whose receipts and snapshot live in run-0's directory.
  let inherited = null;
  if (resumed) {
    const priorDir = join(base, 'old', 'run-0'), putPrior = putIn(priorDir), priorSeal = sealComparison(sealSpec);
    mkdirSync(join(priorDir, 'snapshots'), { recursive: true });
    inherited = { seal: priorSeal, snapshot: putPrior('snapshots/e1.json', { nodes: [record('c1')] }) };
    writeFileSync(join(priorDir, 'REPORT.json'), JSON.stringify({ run_id: 'run-0', run_dir: priorDir, seal_sha256: priorSeal.digest, artifacts: {
      'seal.json': putPrior('seal.json', { spec: priorSeal.spec, digest: priorSeal.digest }),
      'memory-receipts.jsonl': putPrior('memory-receipts.jsonl', `${JSON.stringify({ checkpoint: 'e1', method: 'enrich', ok: true, value: values[0] })}\n`),
      checkpoint_snapshots: [{ through: 'e1', ...inherited.snapshot }] } }));
  }
  const journal = ['e1', 'e2'].flatMap((through, i) => [{ type: 'begin', id: `i${i}`, through }, { type: 'effect_begin', id: `i${i}`, method: 'enrich', effect: `x${i}` },
    { type: 'effect_end', id: `i${i}`, effect: `x${i}`, outcome: 'confirmed', receipt_sha256: digest(values[i]) }]);
  writeFileSync(join(runDir, `coverage-${'1'.repeat(64)}.jsonl`), journal.map(row => `${JSON.stringify(row)}\n`).join(''));
  const receipts = [...(resumed ? [] : [{ checkpoint: 'e1', method: 'enrich', ok: true, value: values[0] }]), { checkpoint: 'e2', method: 'searchCompact', ok: true, value: {} },
    { checkpoint: 'e2', method: 'enrich', ok: true, value: values[1] }];
  const seal = sealComparison(resumed ? { ...sealSpec, resume: { priorSealDigest: inherited.seal.digest, priorRunId: 'run-0' } } : sealSpec);
  const search = previewed_ids => [{ surface: 'compact-records', status: 'ready', previewed_ids }];
  const report = { run_id: 'run-fiction', run_dir: runDir, seal_sha256: seal.digest,
    coverage: { status: 'complete', scheduled: 2, processed: 2, dispositions: [
      { through: 'e1', disposition: 'committed', code: null, search_incomplete: false, search_statuses: search([]) },
      { through: 'e2', disposition: 'committed', code: null, search_incomplete: false, search_statuses: search(['c1']) }] },
    scorecard: { deltas: { candidate: 0.5 }, sensitivity: {}, confidence: {}, safety: {} }, budget: { spent_nano: '1', calls_started: 1 },
    artifacts: { 'seal.json': put('seal.json', { spec: seal.spec, digest: seal.digest }),
      'memory-receipts.jsonl': put('memory-receipts.jsonl', receipts.map(row => `${JSON.stringify(row)}\n`).join('')),
      'case-results.jsonl': put('case-results.jsonl', `${JSON.stringify({ type: 'answer', arm: 'candidate', answer: { trace: { abstention: 'not_enforced', returnedItemIds: ['c1'] } } })}\n`),
      checkpoint_snapshots: [{ through: 'e1', ...(inherited?.snapshot ?? put('snapshots/e1.json', { nodes: [record('c1')] })) }, { through: 'e2', ...put('snapshots/e2.json', { nodes: [record('c1'), record('c2')] }) }] } };
  const reportBytes = Buffer.from(JSON.stringify(report));
  writeFileSync(join(runDir, 'REPORT.json'), reportBytes);
  const reportSha = sha(reportBytes), loaded = loadRun(join(runDir, 'REPORT.json'), reportSha);
  const exported = { ...runExport({ treatment: 'baseline-fiction', seal: loaded.seal, report: loaded.report, reportSha256: reportSha, graph: loaded.graph, answers: loaded.answers }),
    coverage_journal_sha256: loaded.journalSha256 };
  const exportPath = join(climbDir, 'runs', `baseline-fiction--${DEV}.json`), exportBytes = Buffer.from(JSON.stringify(exported));
  writeFileSync(exportPath, exportBytes);
  const alignmentDir = join(climbDir, 'alignments', `baseline-fiction--${DEV}`);
  mkdirSync(alignmentDir, { recursive: true });
  const alignment = { schema: 'climb-alignment/v1', status: 'complete_provisional', run_export_sha256: sha(exportBytes),
    summary: { cutoff: 2, items: [item('R1', STORED_RETURNED, ['c1']), item('R2', STORED_NOT_RETURNED, ['c2'])],
      relations: [edge('R2', 'R1', 'supersedes', NOT_OBSERVED)] } };
  writeFileSync(join(alignmentDir, 'ALIGNMENT.json'), JSON.stringify(alignmentChange(alignment)));
  const reference = { schedule: ['e1', 'e2'], caption: 'fictional reference caption', records: [refRec('R1', 1), refRec('R2', 2)], relations: [{ from: 'R2', to: 'R1', type: 'supersedes' }] };
  const output = join(base, 'out');
  mkdirSync(output, { mode: 0o700 });
  chmodSync(output, 0o700);
  return { base, runDir, climbDir, exportPath, exportSha: sha(exportBytes), exported, reference, output };
}

const deps = world => ({ readDevReference: () => world.reference, now: () => new Date('2030-01-01T00:00:00Z') });
const args = (world, extra = {}) => ({ exportPath: world.exportPath, exportSha: world.exportSha, climbDir: world.climbDir, outputDir: world.output, ...extra });
const run = (world, extra = {}) => diagnoseClimbRun(args(world, extra), deps(world));
const fresh = (options) => buildWorld(temp(), options);

test('a run is diagnosed in place from its hash-pinned artifacts, and the outputs are private, exclusive and consistent', () => {
  const world = fresh(), { report, json, html } = run(world);
  assert.deepEqual([report.edge_gaps.counts.linking_failure, report.search_reach.findings[0].furthest_stage, report.link_funnel.available, report.unaligned_candidates.count],
    [1, 'previewed_by_compact_search', true, 0]);
  assert.deepEqual(report.provenance.roots.map(row => [row.role, row.status]), [['export_run_dir', 'read_in_place'], ['reference_root', 'read_in_place']]);
  assert.equal(report.provenance.remap, null);
  for (const file of [json, html]) assert.equal(statSync(file.path).mode & 0o777, 0o600);
  assert.equal(sha(readFileSync(json.path)), json.sha256);
  const saved = JSON.parse(readFileSync(json.path));
  assert.deepEqual(saved.wording, [...WORDING]);
  for (const sentence of WORDING) assert.ok(readFileSync(html.path, 'utf8').includes(sentence));
  assert.deepEqual(saved.run.export_sha256, world.exportSha);
  assert.throws(() => run(world), /output_exists/);
});

test('a moved archive is read through the explicit remap and the provenance lists each root', () => {
  const world = fresh(), moved = join(world.base, 'archive');
  renameSync(join(world.base, 'old'), moved);
  // Without the option the pinned original location no longer exists: unknown, not a failure of the run.
  const unmapped = run(world).report;
  assert.deepEqual([unmapped.link_funnel, unmapped.search_reach], [UNAVAILABLE('run_directory_missing'), UNAVAILABLE('run_directory_missing')]);
  rmSync(join(world.output, 'baseline-fiction--' + DEV + '.diagnostics.json'));
  rmSync(join(world.output, 'baseline-fiction--' + DEV + '.diagnostics.html'));
  const { report } = run(world, { remap: { from: join(world.base, 'old'), to: moved } });
  assert.equal(report.link_funnel.available, true);
  assert.equal(report.search_reach.findings[0].furthest_stage, 'previewed_by_compact_search');
  assert.deepEqual(report.provenance.roots.map(row => [row.role, row.status, row.old_prefix, row.new_prefix]),
    [['export_run_dir', 'remapped', join(world.base, 'old'), moved], ['reference_root', 'read_in_place', join(world.base, 'old'), moved]]);
  assert.equal(report.provenance.roots[0].read_at, join(moved, 'run-1'));
});

test('a pinned path outside the old prefix is read at its original place', () => {
  const world = fresh(), { report } = run(world, { remap: { from: join(world.base, 'unrelated'), to: join(world.base, 'elsewhere') } });
  assert.equal(report.link_funnel.available, true);
  assert.deepEqual(report.provenance.roots.map(row => row.status), ['read_in_place', 'read_in_place']);
});

test('a resumed run takes the receipts of its inherited checkpoints from the prior run, also through the remap', () => {
  const world = fresh({ resumed: true }), { report } = run(world);
  assert.deepEqual(report.link_funnel.checkpoints.map(row => [row.counts.proposed, row.unavailable]), [[0, {}], [0, {}]]);
  assert.deepEqual(report.provenance.roots.map(row => [row.role, row.status]), [['export_run_dir', 'read_in_place'], ['reference_root', 'read_in_place'], ['resume_prior_run_dir', 'read_in_place']]);
  assert.deepEqual(report.search_reach.findings.map(row => row.furthest_stage), ['previewed_by_compact_search']);
  const moved = join(world.base, 'archive');
  renameSync(join(world.base, 'old'), moved);
  rmSync(join(world.output, `baseline-fiction--${DEV}.diagnostics.json`));
  rmSync(join(world.output, `baseline-fiction--${DEV}.diagnostics.html`));
  const remapped = run(world, { remap: { from: join(world.base, 'old'), to: moved } }).report;
  assert.deepEqual(remapped.provenance.roots.map(row => row.status), ['remapped', 'read_in_place', 'remapped']);
  assert.equal(remapped.link_funnel.available, true);
  assert.equal(remapped.link_funnel.checkpoints[0].unavailable.proposed, undefined);
});

test('loadRun and openReport read in place without the option and refuse changed, missing and symlinked artifacts through the remap', () => {
  const world = fresh(), reportPath = join(world.runDir, 'REPORT.json'), reportSha = world.exported.report_sha256;
  assert.equal(loadRun(reportPath, reportSha).graph.records.length, 2);
  assert.equal(loadRun(reportPath, reportSha, createPathMap(null)).graph.records.length, 2);
  const moved = join(world.base, 'archive');
  renameSync(join(world.base, 'old'), moved);
  const map = createPathMap({ from: join(world.base, 'old'), to: moved }), movedReport = join(moved, 'run-1', 'REPORT.json');
  assert.equal(loadRun(movedReport, reportSha, map).graph.records.length, 2);
  assert.throws(() => loadRun(movedReport, reportSha), /ENOENT|run_dir_mismatch|path_invalid/);
  const receipts = join(moved, 'run-1', 'memory-receipts.jsonl'), original = readFileSync(receipts);
  writeFileSync(receipts, Buffer.concat([original, Buffer.from(' ')]));
  assert.throws(() => loadRun(movedReport, reportSha, map), /input_changed/);
  rmSync(receipts);
  symlinkSync(join(moved, 'run-1', 'case-results.jsonl'), receipts);
  assert.throws(() => loadRun(movedReport, reportSha, map), /path_invalid/);
  rmSync(receipts);
  assert.throws(() => loadRun(movedReport, reportSha, map), /ENOENT/);
});

test('through the CLI, a changed, missing or symlinked run artifact is unavailable with a fixed reason, and a holdout mapped path is refused', () => {
  const cases = [['run_artifact_changed', receipts => writeFileSync(receipts, 'tampered\n')], ['run_artifact_missing', receipts => rmSync(receipts)],
    ['run_artifact_invalid', receipts => { const copy = `${receipts}.copy`; writeFileSync(copy, readFileSync(receipts)); rmSync(receipts); symlinkSync(copy, receipts); }]];
  for (const [reason, damage] of cases) {
    const world = fresh();
    damage(join(world.runDir, 'memory-receipts.jsonl'));
    const { report } = run(world);
    assert.deepEqual([report.link_funnel, report.search_reach], [UNAVAILABLE(reason), UNAVAILABLE(reason)], reason);
    assert.equal(report.edge_gaps.available, true);
  }
  const world = fresh();
  assert.throws(() => run(world, { remap: { from: join(world.base, 'old'), to: join(world.base, 'holdout-archive') } }), /holdout_refused/);
});

test('a run export that no longer matches its run directory is a changed artifact', () => {
  const world = fresh(), snapshot = join(world.runDir, 'snapshots', 'e2.json');
  writeFileSync(snapshot, readFileSync(snapshot, 'utf8').replace('Fictional candidate c2.', 'Fictional candidate c2 changed.'));
  assert.deepEqual(run(world).report.search_reach, UNAVAILABLE('run_artifact_changed'));
});

test('a coverage journal that differs from the digest the export pins is a changed artifact, and a symlinked journal is refused', () => {
  const changed = fresh(), journal = readdirSync(changed.runDir).find(name => name.startsWith('coverage-'));
  writeFileSync(join(changed.runDir, journal), `${readFileSync(join(changed.runDir, journal), 'utf8')}\n`);
  const report = run(changed).report;
  assert.deepEqual([report.link_funnel, report.search_reach], [UNAVAILABLE('run_artifact_changed'), UNAVAILABLE('run_artifact_changed')]);
  assert.equal(report.edge_gaps.available, true);
  const linked = fresh(), path = join(linked.runDir, readdirSync(linked.runDir).find(name => name.startsWith('coverage-')));
  const copy = `${path}.copy`;
  writeFileSync(copy, readFileSync(path));
  rmSync(path);
  symlinkSync(copy, path);
  assert.deepEqual(run(linked).report.link_funnel, UNAVAILABLE('run_artifact_invalid'));
  // The pinned reader sees the journal before loadRun's bare read does: a journal that is not a regular file is refused as invalid.
  const nonregular = fresh(), target = join(nonregular.runDir, readdirSync(nonregular.runDir).find(name => name.startsWith('coverage-')));
  rmSync(target);
  mkdirSync(target);
  assert.deepEqual(run(nonregular).report.link_funnel, UNAVAILABLE('run_artifact_invalid'));
  const unpinned = fresh();
  const { coverage_journal_sha256: _pin, ...rest } = unpinned.exported, bytes = Buffer.from(JSON.stringify(rest)), file = join(unpinned.climbDir, 'runs', 'unpinned.json');
  writeFileSync(file, bytes);
  assert.deepEqual(diagnoseClimbRun({ ...args(unpinned), exportPath: file, exportSha: sha(bytes) }, deps(unpinned)).report.link_funnel, UNAVAILABLE('run_artifact_invalid'));
});

test('a missing alignment, a partial alignment and a foreign export hash are reported unavailable through the CLI', () => {
  const none = fresh();
  rmSync(join(none.climbDir, 'alignments', `baseline-fiction--${DEV}`, 'ALIGNMENT.json'));
  assert.deepEqual(run(none).report.edge_gaps, UNAVAILABLE('no_alignment'));
  assert.deepEqual(run(fresh({ alignmentChange: value => ({ ...value, status: 'partial' }) })).report.edge_gaps, UNAVAILABLE('alignment_partial'));
  assert.deepEqual(run(fresh({ alignmentChange: value => ({ ...value, run_export_sha256: 'f'.repeat(64) }) })).report.edge_gaps, UNAVAILABLE('alignment_export_mismatch'));
  const bad = fresh();
  writeFileSync(join(bad.climbDir, 'alignments', `baseline-fiction--${DEV}`, 'ALIGNMENT.json'), 'not json');
  assert.deepEqual(run(bad).report.edge_gaps, UNAVAILABLE('alignment_invalid'));
  const unreadable = fresh();
  assert.deepEqual(diagnoseClimbRun(args(unreadable), { ...deps(unreadable), readDevReference: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }).report.edge_gaps,
    UNAVAILABLE('reference_unavailable'));
});

test('a reference whose schedule differs from the run is unavailable through the CLI', () => {
  const world = fresh();
  world.reference = { ...world.reference, schedule: ['e1', 'other'] };
  assert.deepEqual(run(world).report.edge_gaps, UNAVAILABLE('reference_schedule_mismatch'));
});

// ---------------------------------------------------------------- development only

test('only a development source and a non-holdout path are read', () => {
  const world = fresh();
  const rewrite = change => {
    const bytes = Buffer.from(JSON.stringify({ ...world.exported, ...change })), path = join(world.climbDir, 'runs', 'changed.json');
    writeFileSync(path, bytes);
    return { exportPath: path, exportSha: sha(bytes) };
  };
  assert.throws(() => diagnoseClimbRun(args(world, rewrite({ source_key: 'unlisted-session' })), deps(world)), /source_not_development/);
  assert.throws(() => diagnoseClimbRun(args(world, rewrite({ source_sha256: '0'.repeat(64) })), deps(world)), /source_binding_mismatch/);
  assert.throws(() => diagnoseClimbRun(args(world, rewrite({ run_dir: join(world.base, 'holdout-run') })), deps(world)), /holdout_refused/);
  assert.throws(() => run(world, { exportPath: join(world.base, 'holdout', 'x.json') }), /holdout_refused/);
  assert.throws(() => run(world, { climbDir: join(world.base, 'holdout-climb') }), /holdout_refused/);
  assert.throws(() => run(world, { outputDir: join(world.base, 'holdout-out') }), /holdout_refused/);
  assert.throws(() => run(world, { exportSha: '0'.repeat(64) }), /input_changed/);
});

test('the module and the CLI import no network, model, database or process-spawning facility beyond a read-only git query', () => {
  const sources = ['../pi-extension/evaluation/run-diagnostics.mjs', '../scripts/diagnose-climb-run.mjs'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
  const imports = sources.flatMap(text => [...text.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])).sort();
  assert.deepEqual([...new Set(imports)], ['../pi-extension/evaluation/climb.mjs', '../pi-extension/evaluation/run-diagnostics.mjs', '../pi-extension/evaluation/seal.mjs', './climb.mjs', './export-climb-run.mjs',
    'node:child_process', 'node:crypto', 'node:fs', 'node:path', 'node:url']);
  assert.equal(/fetch\(|spawn|exec\(|execSync|createConnection|neo4j|XMLHttpRequest/.test(sources.join('\n')), false);
  assert.deepEqual([...sources[1].matchAll(/execFileSync\('([^']+)'/g)].map(match => match[1]), ['git']);
  assert.equal(/'(?:push|fetch|pull|clone|commit|add|config|init)'/.test(sources[1]), false);
});

test('arguments are positional and exact', () => {
  assert.deepEqual(parseArguments(['e.json', 'h', 'c', 'o', '--remap', '/a=/b', '--allow-no-remote-repo']),
    { exportPath: 'e.json', exportSha: 'h', climbDir: 'c', outputDir: 'o', remap: { from: '/a', to: '/b' }, allowNoRemote: true });
  for (const bad of [['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', '--unknown'], ['a', 'b', 'c', 'd', '--remap'],
    ['a', 'b', 'c', 'd', '--remap', '/a=/b', '--remap', '/c=/d']]) assert.throws(() => parseArguments(bad), /arguments_invalid/);
});

// ---------------------------------------------------------------- private output

const gitIn = (cwd, ...rest) => execFileSync('git', rest, { cwd, encoding: 'utf8', stdio: 'pipe' });
const GIT_IDENTITY = ['-c', 'user.name=Fiction', '-c', 'user.email=fiction@example.invalid'];
function repo(parent, name, remote) {
  const dir = join(parent, name);
  mkdirSync(dir);
  gitIn(dir, 'init', '-q');
  if (remote) gitIn(dir, 'remote', 'add', 'origin', 'https://example.invalid/fiction.git');
  return dir;
}
function privateSub(parent, name = 'out') {
  const dir = join(parent, name);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
const SCRIPT = fileScript => ({ scriptPath: fileScript });

test('the output directory must be an owner-only 0700 canonical directory', () => {
  const base = temp(), script = join(base, 'script.mjs');
  writeFileSync(script, '');
  const open = privateSub(base, 'open');
  assert.doesNotThrow(() => guardOutputDir(open, SCRIPT(script)));
  chmodSync(open, 0o755);
  assert.throws(() => guardOutputDir(open, SCRIPT(script)), /output_dir_invalid/);
  chmodSync(open, 0o770);
  assert.throws(() => guardOutputDir(open, SCRIPT(script)), /output_dir_invalid/);
  chmodSync(open, 0o500);
  assert.throws(() => guardOutputDir(open, SCRIPT(script)), /output_dir_invalid/);
  chmodSync(open, 0o700);
  symlinkSync(open, join(base, 'link'));
  assert.throws(() => guardOutputDir(join(base, 'link'), SCRIPT(script)), /output_dir_invalid/);
  assert.throws(() => guardOutputDir(join(base, 'missing'), SCRIPT(script)), /output_dir_invalid/);
  assert.throws(() => guardOutputDir('relative/out', SCRIPT(script)), /output_dir_invalid/);
  assert.throws(() => guardOutputDir(script, SCRIPT(script)), /output_dir_invalid/);
  assert.throws(() => guardOutputDir(privateSub(base, 'holdout-out'), SCRIPT(script)), /holdout_refused/);
});

test('a git work tree with no remote is refused unless explicitly allowed, and the page and report are then written there', () => {
  const base = temp(), script = join(base, 'script.mjs');
  writeFileSync(script, '');
  const tree = repo(base, 'bare-local', false), out = privateSub(tree);
  assert.throws(() => guardOutputDir(out, SCRIPT(script)), /output_worktree_no_remote_requires_option/);
  assert.doesNotThrow(() => guardOutputDir(out, { ...SCRIPT(script), allowNoRemote: true }));
  const world = fresh();
  const inside = privateSub(repo(world.base, 'local-only', false));
  assert.throws(() => run(world, { outputDir: inside }), /output_worktree_no_remote_requires_option/);
  const { json, html } = run(world, { outputDir: inside, allowNoRemote: true });
  assert.deepEqual([dirname(json.path), dirname(html.path)], [inside, inside]);
});

test('a work tree with a configured remote is always refused, even with the option', () => {
  const base = temp(), script = join(base, 'script.mjs');
  writeFileSync(script, '');
  const out = privateSub(repo(base, 'published', true));
  assert.throws(() => guardOutputDir(out, SCRIPT(script)), /output_worktree_has_remote/);
  assert.throws(() => guardOutputDir(out, { ...SCRIPT(script), allowNoRemote: true }), /output_worktree_has_remote/);
});

test('every enclosing work tree is checked, not only the nearest', () => {
  const base = temp(), script = join(base, 'script.mjs');
  writeFileSync(script, '');
  const outer = repo(base, 'outer', true), inner = repo(outer, 'inner', false), out = privateSub(inner);
  assert.throws(() => guardOutputDir(out, { ...SCRIPT(script), allowNoRemote: true }), /output_worktree_has_remote/);
  const quiet = repo(base, 'quiet-outer', false), nested = repo(quiet, 'nested', false), deep = privateSub(nested);
  assert.doesNotThrow(() => guardOutputDir(deep, { ...SCRIPT(script), allowNoRemote: true }));
  const published = repo(base, 'published-outer', true), plain = join(published, 'plain', 'deeper');
  mkdirSync(plain, { recursive: true });
  assert.throws(() => guardOutputDir(privateSub(plain), { ...SCRIPT(script), allowNoRemote: true }), /output_worktree_has_remote/);
});

test('a work tree whose remotes cannot be determined is refused', () => {
  const base = temp(), script = join(base, 'script.mjs');
  writeFileSync(script, '');
  const broken = join(base, 'broken');
  mkdirSync(join(broken, '.git'), { recursive: true });
  assert.throws(() => guardOutputDir(privateSub(broken), { ...SCRIPT(script), allowNoRemote: true }), /output_worktree_unknown/);
  const stray = join(base, 'stray');
  mkdirSync(stray);
  writeFileSync(join(stray, '.git'), 'gitdir: /nonexistent/fiction\n');
  assert.throws(() => guardOutputDir(privateSub(stray), { ...SCRIPT(script), allowNoRemote: true }), /output_worktree_unknown/);
});

test('the work tree holding the running script, and any work tree sharing its git directory, is always refused', () => {
  const base = temp(), tree = repo(base, 'toolbox', false);
  const script = join(tree, 'scripts', 'diagnose.mjs');
  mkdirSync(dirname(script));
  writeFileSync(script, '');
  assert.throws(() => guardOutputDir(privateSub(tree), { ...SCRIPT(script), allowNoRemote: true }), /output_in_script_worktree/);
  gitIn(tree, ...GIT_IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'fiction');
  const linked = join(base, 'linked');
  gitIn(tree, 'worktree', 'add', '-q', '--detach', linked);
  assert.throws(() => guardOutputDir(privateSub(linked), { ...SCRIPT(script), allowNoRemote: true }), /output_in_script_worktree/);
  const other = repo(base, 'other', false);
  assert.doesNotThrow(() => guardOutputDir(privateSub(other), { ...SCRIPT(script), allowNoRemote: true }));
});

test('outside any work tree the output directory needs no option', () => {
  const base = temp(), script = join(base, 'script.mjs');
  writeFileSync(script, '');
  assert.doesNotThrow(() => guardOutputDir(privateSub(base), SCRIPT(script)));
});

test('writeNew creates exclusively and owner-only', () => {
  const base = temp(), path = join(base, 'x.json');
  writeNew(path, Buffer.from('1'));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => writeNew(path, Buffer.from('2')), /EEXIST/);
});
