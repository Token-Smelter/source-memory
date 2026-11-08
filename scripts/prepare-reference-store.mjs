#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { prepareReferenceInputs } from '../pi-extension/evaluation/reference-prepare.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function readPinned(path, expected, max) {
  if (!isAbsolute(path ?? '') || realpathSync(path) !== path || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw fail('path_invalid');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o077) || before.size > max) throw fail('input_invalid');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size || sha(bytes) !== expected) throw fail('input_changed');
    return bytes;
  } finally { closeSync(fd); }
}
function writePrivate(path, value) {
  const bytes = Buffer.from(JSON.stringify(value)), fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  return { path, sha256: sha(bytes), bytes: bytes.length };
}

try {
  if (process.argv.length !== 5) throw fail('arguments_invalid');
  const [configPath, configSha256, outputDir] = process.argv.slice(2);
  const dir = realpathSync(outputDir), state = statSync(dir);
  if (dir !== outputDir || !state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o077)) throw fail('work_dir_invalid');
  const configBytes = readPinned(configPath, configSha256, 1_000_000), config = JSON.parse(configBytes);
  if (config.schema !== 'source-memory-reference-preparation/v1' || config.split !== 'development') throw fail('config_invalid');
  const reportBytes = readPinned(config.report?.path, config.report?.sha256, 20_000_000);
  const snapshotBytes = readPinned(config.snapshot?.path, config.snapshot?.sha256, 128_000_000);
  const referenceBytes = readPinned(config.reference?.path, config.reference?.sha256, 20_000_000);
  const result = prepareReferenceInputs({ report: JSON.parse(reportBytes), candidateSnapshot: JSON.parse(snapshotBytes),
    candidateSnapshotSha256: config.snapshot.sha256, reference: JSON.parse(referenceBytes), sourceKey: config.source_key,
    sourceSha256: config.source_sha256, caseId: config.case_id, through: config.through_entry_id });
  const snapshot = writePrivate(join(dir, 'reference-store.json'), result.snapshot);
  const audit = writePrivate(join(dir, 'reference-audit.json'), { schema: 'source-memory-reference-audit/v1', ...result.audit,
    qualification: result.qualification, limitation: result.limitation, inputs: { config: configSha256, report: config.report.sha256,
      candidate_snapshot: config.snapshot.sha256, reference_cut: config.reference.sha256 } });
  const parent = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  process.stdout.write(`${JSON.stringify({ status: result.qualification, snapshot, audit, model_calls: 0 })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', code: error?.code ?? 'reference_prepare_failed' })}\n`);
  process.exitCode = 1;
}
