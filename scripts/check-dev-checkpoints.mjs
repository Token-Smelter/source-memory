import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyChronologicalCheckpoint } from '../pi-extension/chronology.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function readPinned(path, expected, maxBytes = 100_000_000) {
  if (!isAbsolute(path) || realpathSync(path) !== path || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw fail('path_invalid');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw fail('input_invalid');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size || sha(bytes) !== expected) throw fail('input_changed');
    return bytes;
  } finally { closeSync(fd); }
}

async function main() {
  const [manifestPath, manifestSha, sourceKey, sdkPath, sdkSha256] = process.argv.slice(2);
  if (process.argv.length !== 7 || !isAbsolute(manifestPath ?? '') || basename(manifestPath) !== 'CASE-MANIFEST.json'
    || basename(dirname(manifestPath)) !== 'development' || typeof sourceKey !== 'string' || !sourceKey) throw fail('arguments_invalid');
  const manifest = JSON.parse(readPinned(manifestPath, manifestSha, 2_000_000).toString('utf8'));
  if (manifest.schema !== 'source-memory-r2-development-case-manifest/v1' || !manifest.case_sources?.includes(sourceKey)
    || manifest.frozen_design_sha256 !== '5b0c1fc1d3a94117c9518b8180b7587551514460ec0c9e47a35275063c5eaa6e') throw fail('manifest_invalid');
  const sources = manifest.source_pins.filter(row => row.source_key === sourceKey);
  if (sources.length !== 1) throw fail('source_invalid');
  const source = sources[0];
  const root = dirname(dirname(manifestPath));
  const readManifestFile = key => {
    const descriptor = manifest.files?.[key];
    if (!descriptor || !Number.isSafeInteger(descriptor.bytes)) throw fail('manifest_invalid');
    const bytes = readPinned(join(root, key), descriptor.sha256);
    if (bytes.length !== descriptor.bytes) throw fail('input_changed');
    return bytes;
  };
  const proofFile = JSON.parse(readManifestFile('development/checkpoint-proofs.json').toString('utf8'));
  const availability = readManifestFile('development/availability.jsonl').toString('utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(row => row.source_key === sourceKey);
  const proofs = proofFile.cases.filter(row => row.source_key === sourceKey);
  if (!proofs.length || proofs.some(row => row.snapshot_path !== source.snapshot_path || row.source_sha256 !== source.source_sha256)) throw fail('checkpoint_invalid');
  const sourceBytes = readPinned(source.snapshot_path, source.source_sha256);
  readPinned(sdkPath, sdkSha256, 5_000_000);
  const pi = await import(pathToFileURL(sdkPath).href);
  const checked = proofs.map(proof => verifyChronologicalCheckpoint({ bytes: sourceBytes, proof, availability, pi }));
  return { status: 'structural_preflight_only', manifest_sha256: manifestSha, manifest_state: manifest.state,
    source_key: sourceKey, source_sha256: source.source_sha256, sdk_sha256: sdkSha256, checkpoints: checked.length,
    checkpoint_hashes: checked.map(row => ({ through_entry_id: row.through_entry_id, prefix_sha256: row.prefix_sha256,
      context_messages_sha256: row.context_messages_sha256, ancestry_sha256: row.ancestry_sha256 })),
    limits: ['No model call, semantic review, scope authorization or paid-run admission.', 'Case labels and answers were not opened.'] };
}

main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`), error => {
  const code = typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'preflight_failed';
  process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`);
  process.exitCode = 1;
});
