// Runs one sealed chunking treatment against the fictional corpus, or compares two finished runs.
//   node scripts/eval-chunking.mjs --treatment default-v1 --config eval.json --tokenizer /path/to/sha256-<blob> [--experiment]
//   node scripts/eval-chunking.mjs --treatment remote-... --config eval.json --tokenizer /path/to/sha256-<blob> --experiment
//     An adapter-witnessed embedder loads only the adapter module the sealed manifest names, from this repository, at the
//     committed git blob the manifest pins, in a clean checkout: no other executable code is trusted. Its export
//     createAdapter(config) must return an identity equal to the sealed one. Each input counts as embedded only with the
//     adapter's full-input proof.
//   node scripts/eval-chunking.mjs --compare reference.result.json candidate.result.json
// Results go to .memory-local/chunk-eval/<manifest digest>/<run id>.{seal,result}.json and are never merged across digests.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { canonical, digest } from '../src/core.mjs';
import { embed } from '../src/models.mjs';
import { readGgufTokenizer, sentencePiece } from '../src/tokenizer.mjs';
import { chunkEvalCorpus } from '../test/fixtures/chunk-eval/corpus.mjs';
import { ADAPTER_WITNESS, compareRuns, deriveCorpus, embedWitnessed, EVAL_VERSION, rank, scoreRun, validateManifest } from './chunk-eval-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const write = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

function options(argv) {
  const values = { flags: new Set(), positional: [] };
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    if (arg === '--experiment') values.flags.add('experiment');
    else if (arg === '--compare') values.compare = [argv[++at], argv[++at]];
    else if (['--treatment', '--config', '--tokenizer', '--out', '--max-load5'].includes(arg)) values[arg.slice(2)] = argv[++at];
    else throw new Error(`unknown argument ${arg}`);
  }
  return values;
}

async function codeCommit() {
  const { stdout: head } = await exec('git', ['-C', root, 'rev-parse', 'HEAD']);
  const { stdout: dirty } = await exec('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no']);
  return { commit: head.trim(), dirty: dirty.trim().length > 0 };
}

async function run(args) {
  const manifest = validateManifest(JSON.parse(await readFile(join(root, 'test/fixtures/chunk-eval/treatments', `${args.treatment}.json`), 'utf8')));
  if (manifest.role === 'experiment' && !args.flags.has('experiment')) throw new Error('an experiment row runs only with --experiment');
  const config = JSON.parse(await readFile(args.config, 'utf8'));
  const embedding = config.embedding;
  const witnessed = manifest.embedder.full_input_witness === ADAPTER_WITNESS;
  let adapter = null;
  let adapterCode = null;
  if (witnessed) {
    // Code provenance, not self-report: the sealed module at its pinned blob, in a clean checkout of this repository.
    const { module, git_blob: blob } = manifest.embedder.adapter;
    const code = await codeCommit();
    if (code.dirty) throw new Error('an adapter-witnessed run needs a clean checkout');
    const { stdout } = await exec('git', ['-C', root, 'rev-parse', `HEAD:${module}`]);
    if (stdout.trim() !== blob) throw new Error('the adapter module is not the sealed git blob');
    try { adapter = await (await import(pathToFileURL(join(root, module)).href)).createAdapter(config); }
    catch { throw new Error('adapter failure: create'); }
    if (canonical(adapter?.identity) !== canonical(manifest.embedder.identity)) throw new Error('the adapter identity differs from the sealed embedder');
    adapterCode = { module, git_blob: blob, commit: code.commit };
  } else if (embedding?.model?.replace(/:latest$/u, '') !== manifest.embedder.model || new URL(embedding.url).pathname !== manifest.embedder.endpoint_path
      || embedding.dimensions !== manifest.embedder.dimensions || (embedding.ollama_transport ?? 'openai_compat') !== manifest.embedder.transport
      || embedding.allow_remote === true) {
    throw new Error('the embedding config does not match the sealed embedder');
  }
  // The chunker's own tokenizer: the sealed local served blob, for the embedder or, when witnessed, for the chunker alone.
  const local = witnessed ? manifest.chunker : manifest.embedder;
  if (basename(args.tokenizer) !== local.served_blob.replace(':', '-')) throw new Error('the tokenizer file is not the sealed served blob');
  const spec = await readGgufTokenizer(args.tokenizer);
  if (spec.sha256 !== local.tokenizer_sha256) throw new Error('the served blob tokenizer digest differs from the manifest');
  const counter = sentencePiece(spec);
  const corpus = chunkEvalCorpus();
  const corpusDigest = digest(corpus);
  const derived = deriveCorpus(corpus, manifest.chunker, counter);
  const inputs = derived.chunks.length + corpus.queries.length;
  if (inputs > manifest.budget.max_inputs) throw new Error(`budget: ${inputs} inputs exceed ${manifest.budget.max_inputs}`);

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const dir = join(args.out ?? join(root, '.memory-local/chunk-eval'), manifest.digest);
  await mkdir(dir, { recursive: true });
  // The seal is written before the first embedding request, so the treatment cannot be chosen after seeing results.
  const seal = { eval_version: EVAL_VERSION, run_id: runId, sealed_at: new Date().toISOString(), manifest, manifest_digest: manifest.digest,
    corpus_version: corpus.version, corpus_digest: corpusDigest, code: await codeCommit(), inputs,
    derivation_digest: digest(derived.chunks.map(({ turn, entry_id, start, end }) => [turn, entry_id, start, end])),
    ...(adapterCode ? { adapter: adapterCode } : {}) };
  await write(join(dir, `${runId}.seal.json`), seal);

  const started = Date.now();
  let vectors = [];
  let witness = null;
  const texts = [...derived.chunks.map(chunk => chunk.text), ...corpus.queries.map(query => query.text)];
  const maxLoad = Number(args['max-load5'] ?? Infinity);
  const deadline = started + manifest.budget.max_seconds * 1000;
  const expired = () => { if (Date.now() >= deadline) throw new Error('budget: elapsed time exceeded; no result written'); };
  const admit = async () => {
    // The host scheduler admits this run only below a load ceiling; wait between requests while it is exceeded.
    while (loadavg()[1] > maxLoad) await sleep(15000);
    expired();
    // Each request is aborted at the deadline. Aborting stops waiting; it cannot prove the provider stopped work or did not
    // receive the text.
    return { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) };
  };
  if (witnessed) {
    const items = [...derived.chunks.map(chunk => ({ text: chunk.text, purpose: 'document' })), ...corpus.queries.map(query => ({ text: query.text, purpose: 'query' }))];
    const embedded = await embedWitnessed(adapter, items, { dimensions: manifest.embedder.dimensions, context: manifest.embedder.context, admit });
    vectors = embedded.vectors;
    derived.chunks.forEach((chunk, index) => { chunk.witnessed = vectors[index] !== null; });
    witness = { refusals: embedded.refusals, evidence_kinds: embedded.evidence_kinds,
      queries_unembedded: vectors.slice(derived.chunks.length).filter(vector => vector === null).length };
  } else {
    for (let offset = 0; offset < texts.length; offset += 16) {
      await admit();
      vectors.push(...await embed(embedding, texts.slice(offset, offset + 16)));
    }
  }
  // A last reply that arrived after the deadline does not publish a result.
  expired();
  const chunkVectors = vectors.slice(0, derived.chunks.length);
  const queryVectors = vectors.slice(derived.chunks.length);
  const score = scoreRun({ corpus, derived, rankings: rank(queryVectors, chunkVectors), context: manifest.embedder.context, counter,
    ...(witnessed ? { queryEmbedded: queryVectors.map(vector => vector !== null) } : {}) });
  expired();
  const result = { eval_version: EVAL_VERSION, run_id: runId, manifest_digest: manifest.digest, name: manifest.name, role: manifest.role,
    qualification: manifest.qualification, corpus_digest: corpusDigest, seal_digest: digest(canonical(seal)),
    elapsed_ms: Date.now() - started, inputs, ...(witness ? { witness } : {}), score };
  await write(join(dir, `${runId}.result.json`), result);
  return { result: join(dir, `${runId}.result.json`), summary: { name: manifest.name, qualification: manifest.qualification,
    coverage: score.coverage, all: score.aggregate.all, dense: score.aggregate.dense, elapsed_ms: result.elapsed_ms } };
}

async function compare([referencePath, candidatePath]) {
  const [reference, candidate] = await Promise.all([referencePath, candidatePath].map(async path => JSON.parse(await readFile(path, 'utf8'))));
  return compareRuns(reference, candidate);
}

const args = options(process.argv.slice(2));
try {
  const output = args.compare ? await compare(args.compare) : await run(args);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
