import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectInterruptedRun } from '../pi-extension/evaluation/interrupted-run.mjs';
import { fictionalSettings } from '../pi-extension/evaluation/fictional.mjs';
import { sealComparison } from '../pi-extension/evaluation/seal.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-interrupted-')), driver = join(dir, 'driver'); mkdirSync(driver, { mode: 0o700 });
  const seal = sealComparison(fictionalSettings()), put = (name, data) => writeFileSync(join(dir, name), data, { mode: 0o600 });
  const snapshot = Buffer.from('{"fiction":true}'), path = join(driver, 'baseline-fiction.json'), digest = createHash('sha256').update(snapshot).digest('hex');
  writeFileSync(path, snapshot, { mode: 0o600 });
  put('READY.json', JSON.stringify({ run_dir: dir, run_id: 'fiction', seal_sha256: seal.digest }));
  put('seal.json', JSON.stringify(seal));
  put('progress.jsonl', `${JSON.stringify({ type: 'checkpoint', through: 'a', disposition: 'committed', search_incomplete: false, snapshot: { path, sha256: digest } })}\n`);
  put('ledger.jsonl', `${JSON.stringify({ type: 'started', id: 1 })}\n`);
  put('resources.jsonl', `${JSON.stringify({ kind: 'container', phase: 'created', id: 'fiction-container', run_id: 'fiction' })}\n`);
  return { dir, path };
}

test('interrupted run inspection identifies unresolved calls and owned resources without asserting quiescence', () => {
  const { dir } = fixture();
  try { const result = inspectInterruptedRun(dir);
    assert.deepEqual([result.status, result.latest_clean_snapshot.through, result.unresolved_model_call_ids, result.outstanding_resources.length],
      ['manual_review_required', 'a', [1], 1]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unconfirmed creation remains explicitly uncertain', () => {
  const { dir } = fixture();
  try {
    writeFileSync(join(dir, 'resources.jsonl'), `${JSON.stringify({ kind: 'container', phase: 'planned', id: 'fixture-name', run_id: 'fiction' })}\n`, { mode: 0o600 });
    assert.deepEqual(inspectInterruptedRun(dir).uncertain_creations, [{ kind: 'container', planned_id: 'fixture-name' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('interrupted run inspection refuses a changed snapshot', () => {
  const { dir, path } = fixture();
  try { writeFileSync(path, 'changed'); assert.throws(() => inspectInterruptedRun(dir), /recovery_snapshot_changed/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
