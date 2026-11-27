// Runs one sealed chunking treatment against the fictional corpus, or compares two finished runs.
//   node scripts/eval-chunking.mjs --treatment default-v1 --config eval.json --tokenizer /path/to/sha256-<blob> [--experiment]
//   node scripts/eval-chunking.mjs --compare reference.result.json candidate.result.json
// Results go to .memory-local/chunk-eval/<manifest digest>/<run id>.{seal,result}.json and are never merged across digests.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonical, digest } from '../src/core.mjs';
import { embed } from '../src/models.mjs';
import { readGgufTokenizer, sentencePiece } from '../src/tokenizer.mjs';
import { chunkEvalCorpus } from '../test/fixtures/chunk-eval/corpus.mjs';
import { compareRuns, deriveCorpus, EVAL_VERSION, rank, scoreRun, validateManifest } from './chunk-eval-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const write = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

function options(argv) {
  const values = { flags: new Set(), positional: [] };
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    if (arg === '--experiment') values.flags.add('experiment');
    else if (arg === '--compare') values.compare = [argv[++at], argv[++at]];
    else if (['--treatment', '--config', '--tokenizer', '--out'].includes(arg)) values[arg.slice(2)] = argv[++at];
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
  if (embedding?.model?.replace(/:latest$/u, '') !== manifest.embedder.model || new URL(embedding.url).pathname !== manifest.embedder.endpoint_path
      || embedding.dimensions !== manifest.embedder.dimensions) {
    throw new Error('the embedding config does not match the sealed embedder');
  }
  if (basename(args.tokenizer) !== manifest.embedder.served_blob.replace(':', '-')) throw new Error('the tokenizer file is not the sealed served blob');
  const spec = await readGgufTokenizer(args.tokenizer);
  if (spec.sha256 !== manifest.embedder.tokenizer_sha256) throw new Error('the served blob tokenizer digest differs from the manifest');
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
    derivation_digest: digest(derived.chunks.map(({ turn, entry_id, start, end }) => [turn, entry_id, start, end])) };
  await write(join(dir, `${runId}.seal.json`), seal);

  const started = Date.now();
  const vectors = [];
  const texts = [...derived.chunks.map(chunk => chunk.text), ...corpus.queries.map(query => query.text)];
  for (let offset = 0; offset < texts.length; offset += 16) {
    if (Date.now() - started > manifest.budget.max_seconds * 1000) throw new Error('budget: elapsed time exceeded; no result written');
    vectors.push(...await embed(embedding, texts.slice(offset, offset + 16)));
  }
  const chunkVectors = vectors.slice(0, derived.chunks.length);
  const queryVectors = vectors.slice(derived.chunks.length);
  const score = scoreRun({ corpus, derived, rankings: rank(queryVectors, chunkVectors), context: manifest.embedder.context, counter });
  const result = { eval_version: EVAL_VERSION, run_id: runId, manifest_digest: manifest.digest, name: manifest.name, role: manifest.role,
    qualification: manifest.qualification, corpus_digest: corpusDigest, seal_digest: digest(canonical(seal)),
    elapsed_ms: Date.now() - started, inputs, score };
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
