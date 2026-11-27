// Offline check of a sealed evaluation run against the current manifests and coverage rule, with no endpoint call.
//   node scripts/rescore-chunk-eval.mjs --seal run.seal.json --treatment default-v1 --tokenizer /path/to/sha256-<blob>
// It re-derives the corpus under the current manifest, requires the sealed derivation digest to be identical, and recomputes
// the coverage facts that do not depend on vectors.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../src/core.mjs';
import { readGgufTokenizer, sentencePiece } from '../src/tokenizer.mjs';
import { chunkEvalCorpus } from '../test/fixtures/chunk-eval/corpus.mjs';
import { deriveCorpus, scoreRun, validateManifest } from './chunk-eval-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [all[index].slice(2), all[index + 1]]], []));
const seal = JSON.parse(await readFile(args.seal, 'utf8'));
const manifest = validateManifest(JSON.parse(await readFile(join(root, 'test/fixtures/chunk-eval/treatments', `${args.treatment}.json`), 'utf8')));
const counter = sentencePiece(await readGgufTokenizer(args.tokenizer));
const corpus = chunkEvalCorpus();
const derived = deriveCorpus(corpus, manifest.chunker, counter);
const derivation = digest(derived.chunks.map(({ turn, entry_id, start, end }) => [turn, entry_id, start, end]));
const score = scoreRun({ corpus, derived, rankings: corpus.queries.map(() => []), context: manifest.embedder.context, counter });
console.log(JSON.stringify({
  sealed_manifest_digest: seal.manifest_digest, current_manifest_digest: manifest.digest,
  corpus_identical: seal.corpus_digest === digest(corpus), derivation_identical: seal.derivation_digest === derivation,
  coverage: score.coverage,
  not_fully_represented: score.per_query.filter(row => !row.gold_fully_represented).map(row => row.id),
}, null, 2));
