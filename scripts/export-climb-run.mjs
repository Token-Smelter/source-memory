// Usage: node scripts/export-climb-run.mjs <run REPORT.json> <report sha256> <treatment id> <climb dir>
import { createHash } from 'node:crypto';
import { constants, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readPinned, refuseHoldoutPaths, runExport, storeGraph } from '../pi-extension/evaluation/climb.mjs';
import { verifySeal } from '../pi-extension/evaluation/seal.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
const jsonl = bytes => bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);

export function privateDir(path) {
  const stat = statSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw fail('climb_dir_invalid');
  return path;
}
export function writeNew(path, bytes) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

// Every path-valued field, including resume handback descriptors, is checked against the holdout guard.
export const pathFields = value => Array.isArray(value) ? value.flatMap(pathFields) : value && typeof value === 'object'
  ? Object.entries(value).flatMap(([key, item]) => (/(path|dir)$/i.test(key) && typeof item === 'string' ? [item] : []).concat(typeof item === 'object' ? pathFields(item) : [])) : [];

function openReport(reportPath, reportSha) {
  const runDir = dirname(reportPath), report = JSON.parse(readPinned(reportPath, reportSha, 50_000_000));
  if (realpathSync(report.run_dir ?? '') !== runDir) throw fail('run_dir_mismatch');
  refuseHoldoutPaths([reportPath, ...pathFields(report.artifacts ?? {})]);
  const seal = JSON.parse(readPinned(report.artifacts['seal.json'].path, report.artifacts['seal.json'].sha256));
  verifySeal(seal, report.seal_sha256);
  return { runDir, report, seal };
}

/**
 * Loads a completed run only through hashes pinned by its report. A resumed run inherits checkpoint snapshots from its
 * prior runs; each prior run must be the one its successor's seal names, and its own report pins its write receipts.
 */
export function loadRun(reportPath, reportSha) {
  const head = openReport(reportPath, reportSha), chain = [head];
  const snapshotDirs = new Set(head.report.artifacts.checkpoint_snapshots.map(row => dirname(dirname(row.path))));
  for (let seal = head.seal; seal.spec.resume;) {
    const prior = [...snapshotDirs].filter(dir => !chain.some(row => row.runDir === dir)).map(dir => JSON.parse(readFileSync(join(dir, 'REPORT.json'))))
      .find(row => row.seal_sha256 === seal.spec.resume.priorSealDigest);
    if (!prior) throw fail('resume_chain_incomplete');
    const path = join(prior.run_dir, 'REPORT.json'), opened = openReport(path, sha(readFileSync(path)));
    if (opened.report.run_id !== seal.spec.resume.priorRunId) throw fail('resume_chain_mismatch');
    chain.push(opened);
    seal = opened.seal;
  }
  const roots = chain.map(row => `${row.runDir}/`);
  if (head.report.artifacts.checkpoint_snapshots.some(row => !roots.some(root => row.path.startsWith(root)))) throw fail('artifact_outside_run');
  const artifact = (report, name) => readPinned(report.artifacts[name].path, report.artifacts[name].sha256);
  const journals = readdirSync(head.runDir).filter(name => /^coverage-[a-f0-9]{64}\.jsonl$/.test(name));
  if (journals.length !== 1) throw fail('coverage_journal_ambiguous');
  // The resumed journal carries its predecessors' intervals, so it dates writes across the whole chain.
  const journalBytes = readFileSync(join(head.runDir, journals[0]));
  const graph = storeGraph({ schedule: head.report.coverage.dispositions.map(row => row.through),
    snapshots: head.report.artifacts.checkpoint_snapshots.map(row => ({ through: row.through, snapshot: JSON.parse(readPinned(row.path, row.sha256)) })),
    journal: jsonl(journalBytes), receipts: chain.flatMap(row => jsonl(artifact(row.report, 'memory-receipts.jsonl'))) });
  const answers = jsonl(artifact(head.report, 'case-results.jsonl')).filter(row => row.type === 'answer');
  return { report: head.report, seal: head.seal, graph, answers, journalSha256: sha(journalBytes),
    codeChain: chain.map(row => row.seal.spec.codeSha).reverse() };
}

function main() {
  const [reportPath, reportSha, treatment, climbDir] = process.argv.slice(2);
  if (process.argv.length !== 6) throw fail('arguments_invalid');
  refuseHoldoutPaths([climbDir]);
  privateDir(climbDir);
  const { report, seal, graph, answers, journalSha256, codeChain } = loadRun(reportPath, reportSha);
  const value = { ...runExport({ treatment, seal, report, reportSha256: reportSha, graph, answers }), coverage_journal_sha256: journalSha256, code_chain: codeChain };
  const out = join(climbDir, 'runs');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const path = join(out, `${treatment}--${value.source_key}.json`), bytes = Buffer.from(JSON.stringify(value));
  writeNew(path, bytes);
  const histogram = {};
  for (const row of value.graph.records) histogram[row.checkpoint_index] = (histogram[row.checkpoint_index] ?? 0) + 1;
  process.stdout.write(`${JSON.stringify({ path, sha256: sha(bytes), records: value.graph.records.length, relations: value.graph.relations.length,
    dated_by: value.diagnostics.record_dating, records_by_checkpoint: histogram })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', code: error?.code ?? 'export_failed' })}\n`); process.exitCode = 1; }
}
