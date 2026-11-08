import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reconcileStageBatches } from '../pi-extension/evaluation/stage-reconcile.mjs';
import { summarizeStage } from '../pi-extension/evaluation/stage-alignment.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
const root = '/var/tmp/source-memory-retention-eval-r2-notes', dir = `${root}/stage-run-mlngQ6`;
const read = (path, expected) => { const bytes = readFileSync(path); if (sha(bytes) !== expected) throw new Error('input_changed'); return bytes; };
const originalBytes = read(`${dir}/REPORT.json`, '1591efd38a902ee7512dc1a439edf3900144a9062dffb1e4c67f00791b743416'), original = JSON.parse(originalBytes);
const candidate = JSON.parse(read(`${root}/graph-exports/candidate-derived.json`, '833725a0d5d4fb03cc75603ced8b2e7dd6f2b5949e7c6b3be45abd971c1423b2'));
const reference = JSON.parse(read(`${root}/graph-exports/reference-cut44-as-labeled.json`, 'a03c27a482e94bb6bef791e36261ddc2ca40739551dc5fec3a855e027d9490d9'));
const parseLines = bytes => bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
const outputs = parseLines(read(original.artifacts['model-outputs.jsonl'].path, original.artifacts['model-outputs.jsonl'].sha256));
const ledger = parseLines(read(original.artifacts['ledger.jsonl'].path, original.artifacts['ledger.jsonl'].sha256));
const recovered = reconcileStageBatches({ reference, candidate, outputs, ledger });
const forSummaries = recovered.alignments.map(row => row.verdict === 'uncertain' ? { ...row, candidate_ids: [] } : row);
const pilotBytes = read(`${root}/pilot-ejJKv4/REPORT.json`, 'abd6eb67675f9a5fdda584069ca3113923abf5b5175cbf5a4b36253e9d078cbd'), pilot = JSON.parse(pilotBytes);
const caseRows = parseLines(read(pilot.artifacts['case-results.jsonl'].path, pilot.artifacts['case-results.jsonl'].sha256));
const manifestBytes = read('/var/tmp/source-memory-real-eval-r2-20261107T171141Z/development/CASE-MANIFEST.json', 'eb84b3f2c668cb6584994855415e438f1144faa77d3d58e771230a27a6f81625'), manifest = JSON.parse(manifestBytes);
const mappings = [[20, 'R2-NEED-001'], [37, 'R2-NEED-002'], [44, 'R2-NEED-006']];
const summaries = mappings.map(([cutoff, id]) => {
  const key = `development/reference/reference-cut-${String(cutoff).padStart(3, '0')}.json`;
  const cut = JSON.parse(read(`/var/tmp/source-memory-real-eval-r2-20261107T171141Z/${key}`, manifest.files[key].sha256));
  const snapshot = pilot.artifacts.case_snapshots.find(row => row.case_id === id), value = JSON.parse(read(snapshot.path, snapshot.sha256));
  const first = new Map(candidate.records.map(row => [row.id, row.checkpoint_index]));
  const records = value.nodes.filter(row => row.labels.includes('SMRecord')).map(row => { const record = JSON.parse(row.properties.body); return { id: record.id, checkpoint_index: first.get(record.id) ?? null }; });
  const relations = value.nodes.filter(row => row.labels.includes('SMRelation')).map(row => { const edge = JSON.parse(row.properties.body); return { from: edge.from, to: edge.to, type: edge.type }; });
  const answer = caseRows.find(row => row.case_id === id && row.arm === 'candidate' && row.type === 'answer');
  if (!answer) throw new Error('answer_trace_missing');
  return { case_id: id, ...summarizeStage({ reference: { records: cut.records.map(row => ({ id: row.id, checkpoint_index: row.created_at_checkpoint_ordinal })),
    relations: cut.edges.map(row => ({ from: row.from, to: row.to, type: row.type })) }, candidate: { records, relations },
  alignments: forSummaries, cutoff, returnedIds: answer.answer.trace.returnedItemIds }) };
});
const full = { schema: 'stage-reconciliation/v1', original_report_sha256: sha(originalBytes), original_output_sha256: original.artifacts['model-outputs.jsonl'].sha256,
  policy: 'Select earliest schema-valid original response per batch; allow candidate-ID hints on uncertain verdicts but remove those IDs from summary matching. No verdict is changed; no model call is made.',
  ...recovered, summaries };
const fullPath = join(dir, 'ALIGNMENTS-RECONCILED.json'), fullBytes = Buffer.from(JSON.stringify(full));
writeFileSync(fullPath, fullBytes, { flag: 'wx', mode: 0o600 });
const report = { schema: 'stage-reconciliation-report/v1', status: recovered.unresolved.length ? 'partial_provisional' : 'complete_provisional',
  original_report_sha256: sha(originalBytes), original_status: original.status, no_model_calls: true, batches: recovered.choices.length,
  unavailable_batches: recovered.unresolved, uncertain_hint_count: recovered.uncertain_hint_count,
  cases: summaries.map(({ items, relations, ...row }) => row),
  limitation: 'Post-hoc schema re-validation only; earliest valid retained response. Model-proposed text alignments are not source-supported, independently reviewed, or causal attribution. Uncertain hints are never counted as matches.',
  budget: original.budget, full_artifact: { path: fullPath, sha256: sha(fullBytes), bytes: fullBytes.length } };
const path = join(dir, 'REPORT-RECONCILED.json'), reportBytes = Buffer.from(JSON.stringify(report));
writeFileSync(path, reportBytes, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ ...report, report_path: path, report_sha256: sha(reportBytes) }));
