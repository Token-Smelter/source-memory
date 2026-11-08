#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const repo = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 2_000_000 }).trim();
  const codeSha = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(codeSha)) throw fail('compiler_identity_invalid');
  const compilerDirty = Boolean(git(['status', '--porcelain', '--untracked-files=no']));
  const compilerFiles = Object.fromEntries(['scripts/prepare-reference-store.mjs', 'pi-extension/evaluation/reference-prepare.mjs',
    'pi-extension/evaluation/reference-import.mjs', 'src/core.mjs'].map(path => [path, sha(readFileSync(join(repo, path)))]));
  const outputSnapshotBytes = Buffer.from(JSON.stringify(result.snapshot));
  const audit = writePrivate(join(dir, 'reference-audit.json'), { schema: 'source-memory-reference-audit/v1', ...result.audit,
    qualification: result.qualification, limitation: result.limitation, compiler_sha: codeSha, compiler_dirty: compilerDirty,
    compiler_file_sha256s: compilerFiles, output_snapshot_sha256: sha(outputSnapshotBytes),
    inputs: { config: configSha256, report: config.report.sha256, candidate_snapshot: config.snapshot.sha256, reference_cut: config.reference.sha256 } });
  const snapshot = writePrivate(join(dir, 'reference-store.json'), result.snapshot);
  const parent = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  process.stdout.write(`${JSON.stringify({ status: result.qualification, snapshot, audit, model_calls: 0 })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', code: error?.code ?? 'reference_prepare_failed' })}\n`);
  process.exitCode = 1;
}
