// Usage: node scripts/export-climb-run.mjs <run REPORT.json> <report sha256> <treatment id> <climb dir>
import { createHash } from 'node:crypto';
import { constants, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readPinned, refuseHoldoutPaths, runExport, storeGraph } from '../pi-extension/evaluation/climb.mjs';

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

/** Loads a completed run only through hashes pinned by its report; the coverage journal is hashed into the export. */
export function loadRun(reportPath, reportSha) {
  const runDir = dirname(reportPath), report = JSON.parse(readPinned(reportPath, reportSha, 50_000_000));
  if (realpathSync(report.run_dir ?? '') !== runDir) throw fail('run_dir_mismatch');
  const artifacts = Object.values(report.artifacts ?? {}).flatMap(value => Array.isArray(value) ? value : [value]);
  refuseHoldoutPaths([reportPath, ...artifacts.map(row => row.path)]);
  if (artifacts.some(row => !row.path?.startsWith(`${runDir}/`))) throw fail('artifact_outside_run');
  const artifact = name => readPinned(report.artifacts[name].path, report.artifacts[name].sha256);
  const seal = JSON.parse(artifact('seal.json'));
  const journals = readdirSync(runDir).filter(name => /^coverage-[a-f0-9]{64}\.jsonl$/.test(name));
  if (journals.length !== 1) throw fail('coverage_journal_ambiguous');
  const journalBytes = readFileSync(join(runDir, journals[0]));
  const graph = storeGraph({ schedule: report.coverage.dispositions.map(row => row.through),
    snapshots: report.artifacts.checkpoint_snapshots.map(row => ({ through: row.through, snapshot: JSON.parse(readPinned(row.path, row.sha256)) })),
    journal: jsonl(journalBytes), receipts: jsonl(artifact('memory-receipts.jsonl')) });
  const answers = jsonl(artifact('case-results.jsonl')).filter(row => row.type === 'answer');
  return { report, seal, graph, answers, journalSha256: sha(journalBytes) };
}

function main() {
  const [reportPath, reportSha, treatment, climbDir] = process.argv.slice(2);
  if (process.argv.length !== 6) throw fail('arguments_invalid');
  refuseHoldoutPaths([climbDir]);
  privateDir(climbDir);
  const { report, seal, graph, answers, journalSha256 } = loadRun(reportPath, reportSha);
  const value = { ...runExport({ treatment, seal, report, reportSha256: reportSha, graph, answers }), coverage_journal_sha256: journalSha256 };
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
