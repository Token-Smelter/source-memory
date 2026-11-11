// Usage: node scripts/diagnose-climb-run.mjs <run export> <export sha256> <climb dir> <output dir> [--remap <old prefix>=<new prefix>] [--allow-no-remote-repo]
// Local, deterministic and model-free: reads one development run through the hash-pinned readers and writes one JSON report and one HTML page.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { linkSync, lstatSync, readdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIMB_RUN_SCHEMA, DEV_REFERENCES, assertDevelopmentSource, readDevReference, readPinned, refuseHoldoutPaths } from '../pi-extension/evaluation/climb.mjs';
import { artifactFailureReason, createPathMap, describeRoot, diagnoseRun, diagnosticsHtml, parseRemapOption } from '../pi-extension/evaluation/run-diagnostics.mjs';
import { verifySeal } from '../pi-extension/evaluation/seal.mjs';
import { loadRun, pathFields, privateDir, writeNew } from './export-climb-run.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
const jsonl = bytes => bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
// A refusal is never reported as an unavailable diagnostic.
const REFUSALS = new Set(['holdout_refused', 'source_not_development', 'source_binding_mismatch', 'remap_prefix_invalid']);
const refusal = error => REFUSALS.has(error?.code);

export function parseArguments(argv) {
  const positional = [];
  let remap = null, allowNoRemote = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--remap') {
      if (remap || i + 1 >= argv.length) throw fail('arguments_invalid');
      remap = parseRemapOption(argv[++i]);
    } else if (arg === '--allow-no-remote-repo') allowNoRemote = true;
    else if (arg.startsWith('--')) throw fail('arguments_invalid');
    else positional.push(arg);
  }
  if (positional.length !== 4) throw fail('arguments_invalid');
  const [exportPath, exportSha, climbDir, outputDir] = positional;
  return { exportPath, exportSha, climbDir, outputDir, remap, allowNoRemote };
}

// ---------------------------------------------------------------- output directory guard

function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, GIT_OPTIONAL_LOCKS: '0' } }).trim(); }
  catch { throw fail('output_worktree_unknown'); }
}
const exists = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

/** Every directory from `path` upward that holds a `.git` entry (directory or file), nearest first. */
function workTreesAround(path) {
  const found = [];
  for (let dir = path; ; dir = dirname(dir)) {
    if (exists(join(dir, '.git'))) found.push(dir);
    if (dirname(dir) === dir) return found;
  }
}
const identify = dir => ({ dir: realpathSync(dir), common: realpathSync(git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])),
  remotes: git(dir, ['remote']).split('\n').filter(Boolean) });

/**
 * The output must be a private (0700, owner-only) directory. It may not sit in any git work tree that holds this script or shares
 * its git directory, that has a remote, or whose remotes cannot be determined; one with no remote needs the explicit option.
 */
export function guardOutputDir(outputDir, { allowNoRemote = false, scriptPath = fileURLToPath(import.meta.url) } = {}) {
  refuseHoldoutPaths([outputDir]);
  try {
    if (!isAbsolute(outputDir) || realpathSync(outputDir) !== outputDir) throw fail('output_dir_invalid');
    privateDir(outputDir);
    if ((lstatSync(outputDir).mode & 0o777) !== 0o700) throw fail('output_dir_invalid');
  } catch { throw fail('output_dir_invalid'); }
  const trees = workTreesAround(outputDir);
  if (!trees.length) return;
  const own = workTreesAround(dirname(realpathSync(scriptPath))).map(identify);
  for (const dir of trees) {
    const tree = identify(dir);
    if (own.some(row => row.dir === tree.dir || row.common === tree.common)) throw fail('output_in_script_worktree');
    if (tree.remotes.length) throw fail('output_worktree_has_remote');
    if (!allowNoRemote) throw fail('output_worktree_no_remote_requires_option');
  }
}

// ---------------------------------------------------------------- inputs

function readAlignment(climbDir, exportPath) {
  const path = join(climbDir, 'alignments', basename(exportPath).replace(/\.json$/, ''), 'ALIGNMENT.json');
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return { alignment: null, sha256: null }; throw error; }
  if (!stat.isFile() || stat.size > 50_000_000) return { alignment: { unavailable: 'alignment_invalid' }, sha256: null };
  const bytes = readFileSync(path);
  try {
    const alignment = JSON.parse(bytes);
    return { alignment: alignment && typeof alignment === 'object' && !Array.isArray(alignment) ? alignment : { unavailable: 'alignment_invalid' }, sha256: sha(bytes) };
  } catch { return { alignment: { unavailable: 'alignment_invalid' }, sha256: sha(bytes) }; }
}

/**
 * A prior run of a resume chain was already validated by loadRun on its successor; it is reopened here with the same checks, but
 * without rebuilding its graph, because an interrupted prior run does not cover the whole schedule.
 */
function openPrior(path, map, priorRunId) {
  const report = JSON.parse(readPinned(path, sha(readFileSync(path)), 50_000_000));
  if (realpathSync(map(report.run_dir ?? '')) !== dirname(path) || report.run_id !== priorRunId) throw fail('resume_chain_mismatch');
  const fields = pathFields(report.artifacts ?? {});
  refuseHoldoutPaths([path, ...fields, ...fields.map(map)]);
  const seal = JSON.parse(readPinned(map(report.artifacts['seal.json'].path), report.artifacts['seal.json'].sha256));
  verifySeal(seal, report.seal_sha256);
  return { report, seal };
}

/** Opens the run through loadRun, follows its resume chain, and reads every pinned receipt file. */
function loadArtifacts(run, runDir, map) {
  // The journal is not in REPORT.json; the export pins its digest. loadRun reads the journal with a bare readFileSync, so the
  // pinned reader (no symlink, regular file, size limit, SHA-256) must see it first.
  if (!/^[a-f0-9]{64}$/.test(run.coverage_journal_sha256 ?? '')) throw fail('run_export_invalid');
  const journals = readdirSync(runDir).filter(name => /^coverage-[a-f0-9]{64}\.jsonl$/.test(name));
  if (journals.length !== 1) throw fail('coverage_journal_ambiguous');
  readPinned(join(runDir, journals[0]), run.coverage_journal_sha256);
  const head = loadRun(join(runDir, 'REPORT.json'), run.report_sha256, map), chain = [{ original: run.run_dir, ...head }];
  if (head.seal.digest !== run.seal_sha256 || head.seal.spec.sourceSha256 !== run.source_sha256 || head.report.run_id !== run.run_id
    || JSON.stringify(head.graph) !== JSON.stringify(run.graph)) throw fail('run_export_mismatch');
  if (head.journalSha256 !== run.coverage_journal_sha256) throw fail('run_export_mismatch');
  for (let current = head; current.seal.spec.resume;) {
    const dirs = new Set(current.report.artifacts.checkpoint_snapshots.map(row => dirname(dirname(map(row.path)))));
    const prior = [...dirs].map(dir => { try { return JSON.parse(readFileSync(join(dir, 'REPORT.json'))); } catch { return null; } })
      .find(row => row?.seal_sha256 === current.seal.spec.resume.priorSealDigest);
    if (!prior) throw fail('resume_chain_incomplete');
    current = openPrior(join(map(prior.run_dir), 'REPORT.json'), map, current.seal.spec.resume.priorRunId);
    chain.push({ original: prior.run_dir, ...current });
  }
  const receiptRuns = chain.map(row => {
    const entry = row.report.artifacts['memory-receipts.jsonl'];
    return jsonl(readPinned(map(entry.path), entry.sha256));
  });
  return { report: head.report, receiptRuns, chain };
}

// ---------------------------------------------------------------- orchestration

export function diagnoseClimbRun({ exportPath, exportSha, climbDir, outputDir, remap = null, allowNoRemote = false }, deps = {}) {
  // Only the reference reader, the clock and the script location are injectable, so tests can run without the archived reference.
  const read = { readDevReference, scriptPath: fileURLToPath(import.meta.url), now: () => new Date(), ...deps };
  const map = createPathMap(remap);
  refuseHoldoutPaths([exportPath, climbDir, outputDir]);
  try { privateDir(climbDir); } catch { throw fail('climb_dir_invalid'); }
  guardOutputDir(outputDir, { allowNoRemote, scriptPath: read.scriptPath });

  const exportBytes = readPinned(exportPath, exportSha, 50_000_000), run = JSON.parse(exportBytes);
  if (run.schema !== CLIMB_RUN_SCHEMA) throw fail('run_export_invalid');
  assertDevelopmentSource(run.source_key, run.source_sha256);
  const runDir = map(run.run_dir);
  const { alignment, sha256: alignmentSha256 } = readAlignment(climbDir, exportPath);

  let reference;
  try { reference = read.readDevReference(run.source_key, map); } catch (error) { if (refusal(error)) throw error; reference = { unavailable: 'reference_unavailable' }; }

  const roots = [describeRoot(map, 'export_run_dir', run.run_dir), describeRoot(map, 'reference_root', DEV_REFERENCES[run.source_key].root)];
  let artifacts;
  try {
    if (!exists(runDir)) artifacts = { unavailable: 'run_directory_missing' };
    else {
      const loaded = loadArtifacts(run, runDir, map);
      artifacts = { report: loaded.report, receiptRuns: loaded.receiptRuns };
      for (const row of loaded.chain.slice(1)) roots.push(describeRoot(map, 'resume_prior_run_dir', row.original));
    }
  } catch (error) {
    const reason = artifactFailureReason(error);
    if (reason === null || refusal(error)) throw error;
    artifacts = { unavailable: reason };
  }

  const provenance = { remap: map.spec, roots, alignment_sha256: alignmentSha256 };
  const report = diagnoseRun({ run, exportSha256: sha(exportBytes), alignment, reference, artifacts, provenance, generatedAt: read.now().toISOString() });
  const stem = basename(exportPath).replace(/\.json$/, '');
  const jsonPath = join(outputDir, `${stem}.diagnostics.json`), htmlPath = join(outputDir, `${stem}.diagnostics.html`);
  if (exists(jsonPath) || exists(htmlPath)) throw fail('output_exists');
  const jsonBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`), html = diagnosticsHtml(report);
  writeNew(jsonPath, jsonBytes);
  const temp = `${htmlPath}.${process.pid}.tmp`;
  writeNew(temp, html);
  try { linkSync(temp, htmlPath); } finally { unlinkSync(temp); }
  return { report, json: { path: jsonPath, sha256: sha(jsonBytes) }, html: { path: htmlPath, sha256: sha(html) } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { report, json, html } = diagnoseClimbRun(parseArguments(process.argv.slice(2)));
    const available = Object.fromEntries(['edge_gaps', 'duplicates', 'unaligned_candidates', 'link_funnel', 'search_reach'].map(key => [key, report[key].available]));
    process.stdout.write(`${JSON.stringify({ json, html, available, finding_counts: report.levers.finding_counts })}\n`);
  } catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', code: error?.code ?? 'diagnose_failed' })}\n`); process.exitCode = 1; }
}
