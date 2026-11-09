import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyChronologicalCheckpoint } from '../pi-extension/chronology.mjs';
import { prepareDevelopmentCases, toolCallReviewSummary, verifyToolCallReview } from '../pi-extension/evaluation/dev-dataset.mjs';
import { validatePacket } from '../pi-extension/evaluation/scorer.mjs';

// Structural preflight only: prints counts and hashes, never case, answer or source text.
const fail = code => Object.assign(new Error(code), { code });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function pinned(path, expected, max = 200_000_000) {
  if (!isAbsolute(path ?? '') || realpathSync(path) !== path || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw fail('path_invalid');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > max) throw fail('input_invalid');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha(bytes) !== expected) throw fail('input_changed');
    return bytes;
  } finally { closeSync(fd); }
}
const lines = bytes => bytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);

async function main() {
  const [manifestPath, manifestSha, reviewMapPath, reviewMapSha, sdkPath, sdkSha] = process.argv.slice(2);
  if (process.argv.length !== 8 || basename(manifestPath ?? '') !== 'MANIFEST.json') throw fail('arguments_invalid');
  const manifest = JSON.parse(pinned(manifestPath, manifestSha, 2_000_000).toString('utf8'));
  if (manifest.schema !== 'source-memory-change-development-manifest/v2') throw fail('manifest_invalid');
  const root = dirname(manifestPath);
  const file = key => {
    const descriptor = manifest.files?.[key];
    if (!descriptor || !Number.isSafeInteger(descriptor.bytes)) throw fail('manifest_invalid');
    const bytes = pinned(join(root, key), descriptor.sha256);
    if (bytes.length !== descriptor.bytes) throw fail('input_changed');
    return bytes;
  };
  const cases = lines(file('cases.final.jsonl')), availability = lines(file('availability.jsonl'));
  const proofs = JSON.parse(file('checkpoint-proofs.json').toString('utf8')).cases;
  const sources = JSON.parse(file('SOURCES.json').toString('utf8')).sources;
  if (manifest.review_sha256 !== manifest.files['REVIEW.json']?.sha256 || cases.length !== manifest.case_count) throw fail('manifest_invalid');
  const review = verifyToolCallReview({ bytes: pinned(reviewMapPath, reviewMapSha, 1_000_000), expectedSha256: reviewMapSha,
    datasetManifestSha256: manifestSha, sourceReviewSha256: manifest.review_sha256 });
  pinned(sdkPath, sdkSha, 5_000_000);
  const pi = await import(pathToFileURL(sdkPath).href);
  const bySource = [];
  for (const source of sources) {
    const mine = cases.filter(row => row.pre_answer_store_snapshot?.source_key === source.source_key);
    if (mine.length !== manifest.counts_by_source?.[source.source_key]) throw fail('source_count_mismatch');
    const bytes = pinned(source.source_snapshot_path, source.source_sha256);
    const entries = lines(bytes).filter(row => row.type !== 'session');
    const verified = mine.map(item => verifyChronologicalCheckpoint({ bytes, availability, pi,
      proof: proofs.find(row => row.case_id === item.case_id && row.source_key === source.source_key) }));
    const prepared = prepareDevelopmentCases({ cases: mine, proofs, verified, entries, availability, sourceKey: source.source_key,
      scope: mine[0].read_scopes[0], sourceSha256: source.source_sha256, toolCallReview: review });
    for (const row of prepared) validatePacket(row.packet);
    bySource.push({ source_key: source.source_key, cases: prepared.length,
      requirements: prepared.reduce((sum, row) => sum + row.packet.requirements.length, 0),
      correction_chains: prepared.reduce((sum, row) => sum + row.packet.correctionChains.length, 0),
      distinct_block_sources: prepared.reduce((sum, row) => sum + row.packet.sources.length, 0) });
  }
  const summary = toolCallReviewSummary(review);
  if (summary.used !== summary.approved) throw fail('toolcall_review_unused');
  return { status: 'structural_block_evidence_preflight_only', manifest_sha256: manifestSha, review_map_sha256: reviewMapSha,
    cases: bySource.reduce((sum, row) => sum + row.cases, 0), sources: bySource, toolcall_approvals: summary,
    limits: ['No model call or semantic review.', 'No case, answer or source text is printed.'] };
}

main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`), error => {
  const code = typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'preflight_failed';
  process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`);
  process.exitCode = 1;
});
