import { canonical, CHUNK_MAX_BYTES, chunkEntries, chunkEntriesTokenCapped, CHUNK_DERIVATION_MAX, digest, integer, requireThat }
  from './core.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readGgufTokenizer, RENDER_CONTRACT, sentencePiece, TokenizerError } from './tokenizer.mjs';

export const LEGACY_POLICY = 'legacy-bytes/1';
export const TOKEN_POLICY = 'token-capped/1';
export const MANIFEST_CONTRACT = 'source-memory.chunk-manifest/1';
export const DEFAULT_CHUNK_TOKEN_CAP = 1920;
export const GAP_CAUSES = ['unsplittable_unit', 'tokenizer_unavailable', 'derivation_bound_exceeded'];

// Tokenizer digests whose local counts were shown equal to the served rendering by a parity qualification, each bound to the
// served model, rendering contract, owner serving revision and verified effective context it was qualified with, and the
// parity report that showed it: { [sha256]: { model, served_blob: 'sha256:<hex>', render, serving_revision, context,
// parity_evidence_sha256 } }. The configured GGUF must hash to served_blob before it is used. Only a reviewed qualification
// adds an entry.
export const VERIFIED_TOKENIZERS = Object.freeze({});

const HEX64 = /^[0-9a-f]{64}$/u;

const normalizedModel = embedding => typeof embedding?.model === 'string' ? embedding.model.replace(/:latest$/u, '') : null;

/** The verified contract for this tokenizer and serving configuration, or null: a digest alone verifies nothing. */
export function verifiedContract(verified, sha256, embedding) {
  const entry = Object.hasOwn(verified, sha256) ? verified[sha256] : null;
  return entry && entry.model === normalizedModel(embedding) && entry.render === RENDER_CONTRACT
    && typeof entry.serving_revision === 'string' && entry.serving_revision === embedding?.ollama_context_revision
    && Number.isSafeInteger(entry.context) && entry.context > 0 && HEX64.test(entry.parity_evidence_sha256 ?? '')
    && /^sha256:[0-9a-f]{64}$/u.test(entry.served_blob ?? '') ? entry : null;
}

// The one supported treatment. A policy is qualified only if its descriptor digest is listed in QUALIFIED_TREATMENTS, which
// only a reviewed evaluation of exactly that descriptor adds to. Any other valid policy is recorded as unqualified.
// The serving revision names the served blob, Ollama release and effective context the default is qualified against; an owner
// opts in by setting embedding.ollama_context_revision to it.
export const DEFAULT_SERVING_REVISION = 'ollama-0.21.0-embeddinggemma-0800cbac-ctx2048';
export const DEFAULT_TREATMENT = Object.freeze({
  policy: TOKEN_POLICY, words: 256, overlap: 32, byte_cap: CHUNK_MAX_BYTES, token_cap: DEFAULT_CHUNK_TOKEN_CAP,
  render: RENDER_CONTRACT, model: 'embeddinggemma', context: 2048, serving_revision: DEFAULT_SERVING_REVISION,
  tokenizer_sha256: '2e942f0ea32d8432a164585591b58632b48a78da0e2d1b0c315bb1f18725b698',
  served_blob: 'sha256:0800cbac9c2064dde519420e75e512a83cb360de3ad5df176185dc69652fc515',
  provider: 'ollama', endpoint_path: '/v1/embeddings', transport: 'openai_compat', dimensions: 768,
});
// Policy digest → the evaluation that qualified exactly that descriptor: { manifest_digest, eval_version, evidence_sha256 }.
export const QUALIFIED_TREATMENTS = Object.freeze({});

// The deployment a token count is claimed for. A different endpoint, transport or vector shape is a different treatment.
function deployment(embedding) {
  let path = null;
  try { path = new URL(embedding.url).pathname; } catch { /* An invalid URL is refused when embedding is used. */ }
  return { provider: embedding.allow_remote === true ? 'remote' : 'ollama', endpoint_path: path,
    transport: embedding.ollama_transport ?? 'openai_compat', dimensions: Number.isSafeInteger(embedding.dimensions) ? embedding.dimensions : null };
}

const qualifiedBy = policyDigest => {
  const entry = Object.hasOwn(QUALIFIED_TREATMENTS, policyDigest) ? QUALIFIED_TREATMENTS[policyDigest] : null;
  return entry && HEX64.test(entry.manifest_digest ?? '') && HEX64.test(entry.evidence_sha256 ?? '') ? entry : null;
};

/**
 * The chunk policy a configuration selects, without any file access. Without `embedding.tokenizer` it is the legacy byte
 * policy and makes no token claim; a cap without that contract is refused. With it, the cap defaults to 1920.
 */
export function chunkPolicy(config, verified = VERIFIED_TOKENIZERS) {
  const words = integer(config.chunking?.words, 256, 8, 4096);
  const overlap = integer(config.chunking?.overlap, Math.min(32, words - 1), 0, words - 1);
  const embedding = config.embedding;
  const contract = embedding?.tokenizer;
  if (contract === undefined) {
    requireThat(embedding?.chunk_token_cap === undefined, 'invalid_chunk_token_cap');
    const descriptor = { policy: LEGACY_POLICY, words, overlap, byte_cap: CHUNK_MAX_BYTES };
    return { descriptor, digest: digest(descriptor), qualification: null, tokenizer: null };
  }
  requireThat(contract && typeof contract === 'object' && typeof contract.gguf === 'string' && contract.gguf.startsWith('/')
    && contract.gguf.length <= 4096 && typeof contract.sha256 === 'string' && HEX64.test(contract.sha256), 'invalid_chunk_tokenizer');
  const verifiedEntry = verifiedContract(verified, contract.sha256, embedding);
  const context = verifiedEntry?.context ?? null;
  const cap = embedding.chunk_token_cap ?? DEFAULT_CHUNK_TOKEN_CAP;
  requireThat(Number.isSafeInteger(cap) && cap >= 1 && cap <= (context ?? Number.MAX_SAFE_INTEGER), 'invalid_chunk_token_cap');
  const descriptor = { policy: TOKEN_POLICY, words, overlap, byte_cap: CHUNK_MAX_BYTES, token_cap: cap, render: RENDER_CONTRACT,
    model: normalizedModel(embedding), context, serving_revision: verifiedEntry?.serving_revision ?? null,
    tokenizer_sha256: contract.sha256, served_blob: verifiedEntry?.served_blob ?? null, ...deployment(embedding) };
  const policyDigest = digest(descriptor);
  // An unverified contract can never be qualified, whatever its digest.
  const qualified = context !== null && qualifiedBy(policyDigest) !== null;
  return { descriptor, digest: policyDigest, qualification: qualified ? 'qualified' : 'unqualified',
    tokenizer: { path: contract.gguf, sha256: contract.sha256 } };
}

const loaded = new Map();

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

// A verified counter for the policy, or the reason it cannot be had. Only successful loads are cached.
async function counterFor(policy) {
  // chunkPolicy took the context from a matching verified contract; without one it is null.
  if (policy.descriptor.context === null) return { reason: 'unverified' };
  const { path, sha256 } = policy.tokenizer;
  const key = `${sha256}\0${policy.descriptor.served_blob}\0${path}`;
  if (!loaded.has(key)) {
    let spec;
    try { spec = await readGgufTokenizer(path); } catch (error) {
      return { reason: error instanceof TokenizerError ? error.reason : 'invalid' };
    }
    if (spec.sha256 !== sha256) return { reason: 'digest_mismatch' };
    // The whole file must be the served artifact the contract was verified on, not merely carry its tokenizer or name.
    try { if (await fileSha256(path) !== policy.descriptor.served_blob) return { reason: 'digest_mismatch' }; } catch { return { reason: 'missing' }; }
    try { loaded.set(key, sentencePiece(spec)); } catch { return { reason: 'invalid' }; }
  }
  const counter = loaded.get(key);
  if (counter.context_length !== null && policy.descriptor.token_cap > counter.context_length) return { reason: 'context_exceeded' };
  return { counter, context: policy.descriptor.context };
}

/**
 * Derives the chunks and gaps of a new turn under `policy`. It never throws for an unusable tokenizer: the source is kept and
 * each nonblank entry becomes a typed gap. Only a first retain calls it, so a replay never needs the tokenizer.
 */
export async function deriveChunks(turn, policy) {
  const { words, overlap } = policy.descriptor;
  if (policy.descriptor.policy === LEGACY_POLICY) {
    return { chunks: chunkEntries(turn, words, overlap).map(chunk => ({ ...chunk, token_count: null })), gaps: [] };
  }
  const resolved = await counterFor(policy);
  if (!resolved.counter) {
    return { chunks: [], gaps: turn.entries.filter(entry => /\S/u.test(entry.text))
      .map(entry => ({ entry_id: entry.id, start: 0, end: entry.text.length, cause: 'tokenizer_unavailable', reason: resolved.reason })) };
  }
  return chunkEntriesTokenCapped(turn, words, overlap, resolved.counter, policy.descriptor.token_cap);
}

/**
 * The immutable first-retain record of what was derived for one turn. Offsets are UTF-16 into the unchanged entry; no source
 * text is copied. Null when the derivation exceeds the bound, which only a legacy policy can produce.
 */
export function chunkManifest({ scope, turnUid, turnHash, turn, policy, chunks, gaps }) {
  if (chunks.length + gaps.length > CHUNK_DERIVATION_MAX) return null;
  const entries = new Map(turn.entries.map(entry => [entry.id, entry.text]));
  const manifest = {
    contract: MANIFEST_CONTRACT, scope, turn_uid: turnUid, turn_hash: turnHash,
    policy: policy.descriptor, policy_digest: policy.digest, qualification: policy.qualification,
    chunks: chunks.map(chunk => ({ uid: chunk.uid, ordinal: chunk.ordinal, entry_id: chunk.entry_id, start: chunk.start, end: chunk.end,
      text_sha256: digest(chunk.text), token_count: chunk.token_count })),
    gaps: gaps.map(gap => ({ entry_id: gap.entry_id, start: gap.start, end: gap.end, cause: gap.cause,
      text_sha256: digest(entries.get(gap.entry_id).slice(gap.start, gap.end)),
      ...(gap.reason === undefined ? {} : { reason: gap.reason }) })),
  };
  const body = canonical(manifest);
  return { body, digest: digest(body) };
}
