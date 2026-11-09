// Usage: node scripts/export-climb-run.mjs <run REPORT.json> <report sha256> <treatment id> <climb dir>
import { createHash } from 'node:crypto';
import { constants, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertDevelopment, readPinned, runExport, storeGraph } from '../pi-extension/evaluation/climb.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');

export function privateDir(path) {
  const stat = statSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw fail('climb_dir_invalid');
  return path;
}
export function writeNew(path, bytes) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

function main() {
  const [reportPath, reportSha, treatment, climbDir] = process.argv.slice(2);
  if (process.argv.length !== 6) throw fail('arguments_invalid');
  const reportBytes = readPinned(reportPath, reportSha, 50_000_000), report = JSON.parse(reportBytes);
  const ready = JSON.parse(readFileSync(join(dirname(reportPath), 'READY.json')));
  assertDevelopment(ready.source_key, [reportPath, climbDir]);
  privateDir(climbDir);
  const artifact = name => readPinned(report.artifacts[name].path, report.artifacts[name].sha256);
  const snapshots = report.artifacts.checkpoint_snapshots.map(row => JSON.parse(readPinned(row.path, row.sha256)));
  if (snapshots.length !== report.coverage?.scheduled) throw fail('checkpoint_coverage_invalid');
  const answers = artifact('case-results.jsonl').toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.type === 'answer');
  const value = runExport({ treatment, ready, report, reportSha256: reportSha, graph: storeGraph(snapshots), answers });
  const out = join(climbDir, 'runs');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const path = join(out, `${treatment}--${ready.source_key}.json`), bytes = Buffer.from(JSON.stringify(value));
  writeNew(path, bytes);
  process.stdout.write(`${JSON.stringify({ path, sha256: sha(bytes), records: value.graph.records.length, relations: value.graph.relations.length })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', code: error?.code ?? 'export_failed' })}\n`); process.exitCode = 1; }
}
