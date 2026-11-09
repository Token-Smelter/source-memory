import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../src/core.mjs';
import { DEV_REFERENCES, MATCH_BUCKETS, assertDevelopment, assertSameSchedule, dashboardHtml, referenceGraph, runExport, storeGraph } from '../pi-extension/evaluation/climb.mjs';
import { validAlignment } from '../scripts/align-climb-run.mjs';
import { pathFields } from '../scripts/export-climb-run.mjs';

const node = (label, body) => ({ labels: [label], properties: { body: JSON.stringify(body) } });
const record = (id, kind = 'decision') => node('SMRecord', { id, kind, text: `Fictional ${id}.` });
const DEV = 'doxagon-vault-software-presentations', SOURCE = DEV_REFERENCES[DEV].source_sha256;

// Three checkpoints; the driver lists snapshots keyed by entry ID, so an integer-like ID sorts first.
function fixture() {
  const schedule = ['e5f6a7b8', 'a1b2c3d4', '31415926'];
  const values = [{ records: ['r1', 'r2'] }, { records: ['r3'] }];
  const journal = [
    { type: 'begin', id: 'i1', through: 'e5f6a7b8' }, { type: 'effect_begin', id: 'i1', method: 'enrich', effect: 'x1' },
    { type: 'effect_end', id: 'i1', effect: 'x1', outcome: 'confirmed', receipt_sha256: digest(values[0]) },
    { type: 'begin', id: 'i3', through: '31415926' }, { type: 'effect_begin', id: 'i3', method: 'enrich', effect: 'x3' },
    { type: 'effect_end', id: 'i3', effect: 'x3', outcome: 'confirmed', receipt_sha256: digest(values[1]) }];
  const receipts = [{ checkpoint: 'e5f6a7b8', method: 'enrich', ok: true, value: values[0] }, { checkpoint: '31415926', method: 'enrich', ok: true, value: values[1] }];
  const snapshots = [
    { through: '31415926', snapshot: { nodes: [record('r1'), record('r2'), record('r3'), record('r4', 'action'), node('SMRelation', { from: 'r3', to: 'r1', type: 'supersedes' })] } },
    { through: 'a1b2c3d4', snapshot: { nodes: [record('r1'), record('r2'), record('r4', 'action')] } },
    { through: 'e5f6a7b8', snapshot: { nodes: [record('r1'), record('r2')] } }];
  return { schedule, journal, receipts, snapshots };
}

test('records are dated by their confirmed write receipt, else the first scheduled snapshot, regardless of snapshot order', () => {
  const graph = storeGraph(fixture());
  assert.deepEqual([graph.records.map(row => [row.id, row.checkpoint_index, row.dated_by]), graph.relations.length],
    [[['r1', 1, 'write_receipt'], ['r2', 1, 'write_receipt'], ['r4', 2, 'first_snapshot'], ['r3', 3, 'write_receipt']], 1]);
});

test('a receipt that does not hash to a confirmed effect in its own interval cannot date a record', () => {
  const value = fixture();
  value.receipts[1] = { ...value.receipts[1], checkpoint: 'a1b2c3d4' };
  assert.deepEqual(storeGraph(value).records.find(row => row.id === 'r3'), { id: 'r3', kind: 'decision', text: 'Fictional r3.', checkpoint_index: 3, dated_by: 'first_snapshot' });
  assert.throws(() => storeGraph({ ...value, snapshots: value.snapshots.slice(1) }), /snapshot_invalid/);
});

test('both reference layouts bind ordinals to checkpoint entries and stay additions-only', () => {
  const cut = referenceGraph({ format: 'cut', cut: { through_ordinal: 3, through_entry_id: 'c', records: [
    { id: 'r', kind: 'action', text: 'T.', created_at_checkpoint_ordinal: 2, created_at_entry_id: 'b' },
    { id: 's', kind: 'action', text: 'U.', created_at_checkpoint_ordinal: 3, created_at_entry_id: 'c' }],
  edges: [{ from: 's', to: 'r', type: 'qualifies', created_at_checkpoint_ordinal: 3, created_at_entry_id: 'c' }] } });
  assertSameSchedule(cut, ['a', 'b', 'c']);
  assert.throws(() => assertSameSchedule(cut, ['a', 'x', 'c']), /reference_schedule_mismatch/);
  const deltas = referenceGraph({ format: 'checkpoints', checkpoints: [{ ordinal: 2, checkpoint_entry_id: 'b', records: [{ id: 'r', kind: 'action', text: 'T.' }], edges: [] },
    { ordinal: 1, checkpoint_entry_id: 'a', records: [], edges: [] }] });
  assert.deepEqual([deltas.schedule, deltas.records[0].checkpoint_index], [['a', 'b'], 2]);
  assert.throws(() => referenceGraph({ format: 'checkpoints', checkpoints: [{ ordinal: 1, checkpoint_entry_id: 'a', records: [{ id: 'r' }], edges: [] },
    { ordinal: 2, checkpoint_entry_id: 'b', records: [{ id: 'r' }], edges: [] }] }), /reference_invalid/);
});

test('resume handback descriptors expose every path field to the holdout guard', () => {
  const artifacts = { 'seal.json': { path: '/run/seal.json' }, carried_cases: [{ caseId: 'c', sourceReportPath: '/prior/REPORT.json', sourceSnapshotPath: '/prior/s.json' }] };
  assert.deepEqual(pathFields(artifacts).sort(), ['/prior/REPORT.json', '/prior/s.json', '/run/seal.json']);
});

test('only allowlisted development sessions and non-holdout paths are accepted', () => {
  assert.throws(() => assertDevelopment('unknown-session'), /source_not_development/);
  assert.throws(() => assertDevelopment(DEV, ['/var/tmp/eval/holdout/run']), /holdout_refused/);
});

test('the dashboard is self-contained, shows no-match references, and embedded text cannot close its data script', () => {
  const html = dashboardHtml({ generatedAt: 'fiction', sessions: [{ source_key: DEV, reference: null, reference_caption: 'c', runs: [{ graph: { records: [{ text: '</script><script>alert(1)</script>' }] } }] }] });
  assert.deepEqual([html.includes('</script><script>alert'), /<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(html),
    html.includes("default-src 'none'"), MATCH_BUCKETS.includes('no_match_provisional')], [false, false, true, true]);
  assert.throws(() => dashboardHtml({ generatedAt: 'fiction', sessions: [{ source_key: 'holdout-x', runs: [] }] }), /source_not_development/);
});

test('a run export is bound to its sealed source, needs complete coverage, and records abstention markers per arm', () => {
  const graph = { schedule: ['a'], records: [{ id: 'r', dated_by: 'write_receipt' }], relations: [] };
  const seal = { digest: 's', spec: { sourceSha256: SOURCE, codeSha: 'c', datasetSha256: 'd', budget: { purposes: {} } } };
  const report = { run_id: 'run', seal_sha256: 's', run_dir: '/fiction', coverage: { status: 'complete', scheduled: 1, dispositions: [{ through: 'a', disposition: 'committed', search_incomplete: false }] },
    scorecard: { deltas: { candidate: 0.5 }, sensitivity: {}, confidence: {}, safety: {} }, budget: { spent_nano: '1', calls_started: 1 } };
  const answers = [{ arm: 'candidate', answer: { trace: { abstention: 'not_enforced', returnedItemIds: ['b', 'a', 'b'] } } },
    { arm: 'empty', answer: { trace: { abstention: 'host_enforced_no_citations', returnedItemIds: [] } } }];
  const value = runExport({ treatment: 'baseline-v2', seal, report, reportSha256: 'f'.repeat(64), graph, answers });
  assert.deepEqual([value.source_key, value.primary.value, value.returned_item_ids, value.diagnostics.abstention.empty], [DEV, 0.5, ['a', 'b'], { host_enforced_no_citations: 1 }]);
  assert.throws(() => runExport({ treatment: 'baseline-v2', seal: { ...seal, spec: { ...seal.spec, sourceSha256: '0'.repeat(64) } }, report,
    reportSha256: 'f'.repeat(64), graph, answers }), /source_not_development/);
  assert.throws(() => runExport({ treatment: 'baseline-v2', seal, report: { ...report, coverage: { ...report.coverage, status: 'case_failed' } },
    reportSha256: 'f'.repeat(64), graph, answers }), /run_unqualified/);
});

test('an alignment must cover every reference once with offered candidates only', () => {
  const refs = [{ id: 'r1' }, { id: 'r2' }], candidates = [{ id: 'c1' }];
  const item = (reference_id, verdict, candidate_ids) => ({ reference_id, verdict, candidate_ids, reason: 'Fictional.' });
  assert.equal(validAlignment({ items: [item('r1', 'matched', ['c1']), item('r2', 'no_match', [])] }, refs, candidates), true);
  assert.equal(validAlignment({ items: [item('r1', 'matched', ['c9']), item('r2', 'no_match', [])] }, refs, candidates), false);
  assert.equal(validAlignment({ items: [item('r1', 'uncertain', ['c1']), item('r2', 'no_match', [])] }, refs, candidates), true);
  assert.equal(validAlignment({ items: [item('r1', 'no_match', ['c1']), item('r2', 'no_match', [])] }, refs, candidates), false);
});
