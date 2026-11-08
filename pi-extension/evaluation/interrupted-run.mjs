import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { verifySeal } from './seal.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function privateFile(path, maxBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o077) || before.size > maxBytes) throw fail('recovery_input_invalid');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail('recovery_input_changed');
    return bytes;
  } finally { closeSync(fd); }
}
function jsonLines(bytes) {
  const value = bytes.toString('utf8');
  if (value && !value.endsWith('\n')) throw fail('recovery_input_incomplete');
  try { return value.split('\n').filter(Boolean).map(JSON.parse); } catch { throw fail('recovery_input_invalid'); }
}

/** Inspect a crash cut without mutating resources or declaring the old execution quiescent. */
export function inspectInterruptedRun(directory) {
  const dir = realpathSync(directory), info = statSync(dir);
  if (dir !== directory || !info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw fail('work_dir_invalid');
  try { lstatSync(join(dir, 'REPORT.json')); throw fail('report_present'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const readyBytes = privateFile(join(dir, 'READY.json'), 1_000_000), ready = JSON.parse(readyBytes);
  if (ready.run_dir !== dir || typeof ready.run_id !== 'string' || !/^[a-f0-9]{64}$/.test(ready.seal_sha256 ?? '')) throw fail('recovery_input_invalid');
  const sealBytes = privateFile(join(dir, 'seal.json'), 10_000_000), seal = JSON.parse(sealBytes);
  try { verifySeal(seal, ready.seal_sha256); } catch { throw fail('recovery_input_invalid'); }
  const progressBytes = privateFile(join(dir, 'progress.jsonl'), 20_000_000), ledgerBytes = privateFile(join(dir, 'ledger.jsonl'), 20_000_000);
  const resourcesBytes = privateFile(join(dir, 'resources.jsonl'), 5_000_000);
  const progress = jsonLines(progressBytes), ledger = jsonLines(ledgerBytes), resources = jsonLines(resourcesBytes);
  const starts = ledger.filter(row => row.type === 'started'), results = ledger.filter(row => row.type === 'result');
  if (new Set(starts.map(row => row.id)).size !== starts.length || new Set(results.map(row => row.id)).size !== results.length
    || results.some(row => !starts.some(start => start.id === row.id))) throw fail('recovery_input_invalid');
  const unresolvedCalls = starts.filter(row => !results.some(result => result.id === row.id)
    || results.some(result => result.id === row.id && result.outcome === 'unknown')).map(row => row.id);
  const clean = progress.filter(row => row.type === 'checkpoint' && ['committed', 'abstained'].includes(row.disposition)
    && row.search_incomplete === false && row.snapshot?.path && row.snapshot?.sha256);
  const last = clean.at(-1);
  let snapshot = null;
  if (last) {
    if (!last.snapshot.path.startsWith(`${dir}/driver/`) || realpathSync(last.snapshot.path) !== last.snapshot.path) throw fail('recovery_input_invalid');
    const bytes = privateFile(last.snapshot.path, 128_000_000);
    if (sha(bytes) !== last.snapshot.sha256) throw fail('recovery_snapshot_changed');
    snapshot = { through: last.through, path: last.snapshot.path, sha256: last.snapshot.sha256, bytes: bytes.length };
  }
  if (resources.some(row => row.run_id !== ready.run_id)) throw fail('recovery_input_invalid');
  const outstandingResources = resources.filter(row => row.phase === 'created'
    && !resources.some(end => end.phase === 'removed' && end.kind === row.kind && end.id === row.id)).map(row => ({ kind: row.kind, id: row.id }));
  const uncertainCreations = resources.filter(row => row.phase === 'planned' && !resources.some(created => created.phase === 'created'
    && created.kind === row.kind && (created.id === row.id || created.name === row.id))).map(row => ({ kind: row.kind, planned_id: row.id }));
  return { status: 'manual_review_required', run_id: ready.run_id, seal_sha256: ready.seal_sha256, latest_clean_snapshot: snapshot,
    unresolved_model_call_ids: unresolvedCalls, outstanding_resources: outstandingResources, uncertain_creations: uncertainCreations,
    hashes: { ready: sha(readyBytes), seal: sha(sealBytes), progress: sha(progressBytes), ledger: sha(ledgerBytes), resources: sha(resourcesBytes) },
    caveat: 'This read does not prove process quiescence, absence of external effects, cost completeness, or authority to resume or delete resources.' };
}
