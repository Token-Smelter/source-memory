import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDevelopment, dashboardHtml, referenceGraph, runExport, storeGraph } from '../pi-extension/evaluation/climb.mjs';
import { validAlignment } from '../scripts/align-climb-run.mjs';

const node = (label, body) => ({ labels: [label], properties: { body: JSON.stringify(body) } });
const record = (id, kind = 'decision') => node('SMRecord', { id, kind, text: `Fictional ${id}.` });
const DEV = 'doxagon-vault-software-presentations';

test('candidate records carry the first checkpoint that contains them and relations come from the final store', () => {
  const graph = storeGraph([{ nodes: [record('a')] }, { nodes: [record('a'), record('b', 'action'), node('SMRelation', { from: 'b', to: 'a', type: 'supersedes' })] }]);
  assert.deepEqual([graph.checkpoints, graph.records.map(row => [row.id, row.checkpoint_index]), graph.relations],
    [2, [['a', 1], ['b', 2]], [{ from: 'b', to: 'a', type: 'supersedes' }]]);
});

test('both reference layouts normalize to one checkpoint-indexed graph and gaps are refused', () => {
  const cut = referenceGraph({ format: 'cut', cut: { through_ordinal: 3, records: [{ id: 'r', kind: 'action', text: 'T.', created_at_checkpoint_ordinal: 2 }],
    edges: [{ from: 'r', to: 'r2', type: 'qualifies' }] } });
  const deltas = referenceGraph({ format: 'checkpoints', checkpoints: [{ ordinal: 2, records: [{ id: 'r', kind: 'action', text: 'T.' }], edges: [] },
    { ordinal: 1, records: [], edges: [] }] });
  assert.deepEqual([cut.checkpoints, cut.records[0].checkpoint_index, deltas.checkpoints, deltas.records[0].checkpoint_index], [3, 2, 2, 2]);
  assert.throws(() => referenceGraph({ format: 'checkpoints', checkpoints: [{ ordinal: 2, records: [], edges: [] }] }), /reference_invalid/);
});

test('only allowlisted development sessions and non-holdout paths are accepted', () => {
  assert.throws(() => assertDevelopment('unknown-session'), /source_not_development/);
  assert.throws(() => assertDevelopment(DEV, ['/var/tmp/eval/holdout/run']), /holdout_refused/);
});

test('the dashboard is self-contained and embedded text cannot close its data script', () => {
  const html = dashboardHtml({ generatedAt: 'fiction', sessions: [{ source_key: DEV, reference: null, reference_caption: 'c', runs: [{ graph: { records: [{ text: '</script><script>alert(1)</script>' }] } }] }] });
  assert.deepEqual([html.includes('</script><script>alert'), /<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(html), html.includes("default-src 'none'")], [false, false, true]);
  assert.throws(() => dashboardHtml({ generatedAt: 'fiction', sessions: [{ source_key: 'holdout-x', runs: [] }] }), /source_not_development/);
});

test('a run export needs complete coverage and records abstention markers per arm', () => {
  const ready = { source_key: DEV, run_id: 'run', seal_sha256: 's', code_sha: 'c', dataset_sha256: 'd', models: {} };
  const report = { run_id: 'run', seal_sha256: 's', run_dir: '/fiction', coverage: { status: 'complete', scheduled: 1, dispositions: [{ disposition: 'committed', search_incomplete: false }] },
    scorecard: { deltas: { candidate: 0.5 }, sensitivity: {}, confidence: {}, safety: {} }, budget: { spent_nano: '1', calls_started: 1 } };
  const answers = [{ arm: 'candidate', answer: { trace: { abstention: 'not_enforced', returnedItemIds: ['b', 'a', 'b'] } } },
    { arm: 'empty', answer: { trace: { abstention: 'host_enforced_no_citations', returnedItemIds: [] } } }];
  const value = runExport({ treatment: 'baseline-v2', ready, report, reportSha256: 'f'.repeat(64), graph: { records: [], relations: [] }, answers });
  assert.deepEqual([value.primary.value, value.returned_item_ids, value.diagnostics.abstention.empty], [0.5, ['a', 'b'], { host_enforced_no_citations: 1 }]);
  assert.throws(() => runExport({ treatment: 'baseline-v2', ready, report: { ...report, coverage: { ...report.coverage, status: 'case_failed' } },
    reportSha256: 'f'.repeat(64), graph: {}, answers }), /run_unqualified/);
});

test('an alignment must cover every reference once with offered candidates only', () => {
  const refs = [{ id: 'r1' }, { id: 'r2' }], candidates = [{ id: 'c1' }];
  const item = (reference_id, verdict, candidate_ids) => ({ reference_id, verdict, candidate_ids, reason: 'Fictional.' });
  assert.equal(validAlignment({ items: [item('r1', 'matched', ['c1']), item('r2', 'no_match', [])] }, refs, candidates), true);
  assert.equal(validAlignment({ items: [item('r1', 'matched', ['c9']), item('r2', 'no_match', [])] }, refs, candidates), false);
});
