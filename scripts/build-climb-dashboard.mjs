// Usage: node scripts/build-climb-dashboard.mjs <climb dir>
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CLIMB_ALIGNMENT_SCHEMA, CLIMB_RUN_SCHEMA, DEV_REFERENCES, assertDevelopment, dashboardHtml, readDevReference, refuseHoldoutPaths, assertDevelopmentSource, assertSameSchedule } from '../pi-extension/evaluation/climb.mjs';
import { privateDir, writeNew } from './export-climb-run.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');

function main() {
  const [climbDir] = process.argv.slice(2);
  if (process.argv.length !== 3) throw fail('arguments_invalid');
  refuseHoldoutPaths([climbDir]);
  privateDir(climbDir);
  const runsDir = join(climbDir, 'runs'), runs = existsSync(runsDir) ? readdirSync(runsDir).filter(name => name.endsWith('.json')).sort() : [];
  const bySource = new Map(Object.keys(DEV_REFERENCES).map(key => [key, []]));
  for (const name of runs) {
    const bytes = readFileSync(join(runsDir, name)), run = JSON.parse(bytes);
    if (run.schema !== CLIMB_RUN_SCHEMA) throw fail('run_export_invalid');
    assertDevelopmentSource(run.source_key, run.source_sha256);
    refuseHoldoutPaths([run.run_dir]);
    const alignmentPath = join(climbDir, 'alignments', name.replace(/\.json$/, ''), 'ALIGNMENT.json');
    let alignment = null;
    if (existsSync(alignmentPath)) {
      alignment = JSON.parse(readFileSync(alignmentPath));
      if (alignment.schema !== CLIMB_ALIGNMENT_SCHEMA || alignment.run_export_sha256 !== sha(bytes)) throw fail('alignment_mismatch');
      alignment = { item_counts: alignment.summary.item_counts, relation_counts: alignment.summary.relation_counts, spent_nano: alignment.spent_nano, status: alignment.status };
    }
    const { returned_item_ids: _ids, ...shown } = run;
    bySource.get(run.source_key).push({ ...shown, alignment });
  }
  const sessions = [...bySource].map(([sourceKey, list]) => {
    const { panel: _panel, manifest_sha256, caption, ...reference } = readDevReference(sourceKey);
    for (const run of list) assertSameSchedule(reference, run.graph.schedule);
    return { source_key: sourceKey, reference: { ...reference, manifest_sha256 }, reference_caption: caption, runs: list };
  });
  const html = dashboardHtml({ generatedAt: new Date().toISOString(), sessions });
  const path = join(climbDir, 'climb-dashboard.html'), temp = `${path}.${process.pid}.tmp`;
  writeNew(temp, html);
  renameSync(temp, path);
  process.stdout.write(`${JSON.stringify({ path, sha256: sha(html), runs: runs.length, sessions: sessions.length })}\n`);
}

try { main(); } catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', code: error?.code ?? 'build_failed' })}\n`); process.exitCode = 1; }
