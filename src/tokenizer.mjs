import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
// Tokenizer failures never reach a caller: the chunk policy turns them into typed gaps. `reason` is missing or invalid.
export class TokenizerError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const check = condition => { if (!condition) throw new TokenizerError('invalid'); };

// Names the rendered-input contract this module reproduces: Ollama's SentencePiece encoder (tokenizer/sentencepiece.go at
// v0.21.0) over the raw /v1/embeddings input, with BOS and EOS added as the GGUF metadata says. A change to what is counted
// is a new version.
export const RENDER_CONTRACT = 'ollama-spm-raw-input/1';

const HEADER_MAX_BYTES = 64 * 1024 * 1024;
const TOKENIZER_KEYS = ['tokenizer.ggml.model', 'tokenizer.ggml.tokens', 'tokenizer.ggml.scores', 'tokenizer.ggml.token_type',
  'tokenizer.ggml.bos_token_id', 'tokenizer.ggml.eos_token_id', 'tokenizer.ggml.add_bos_token', 'tokenizer.ggml.add_eos_token'];
const TYPE_CONTROL = 3, TYPE_USER_DEFINED = 4;
const SCALAR = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

class Reader {
  constructor(handle) { this.handle = handle; this.buffer = Buffer.alloc(0); this.offset = 0; }

  async need(bytes) {
    if (this.offset + bytes <= this.buffer.length) return;
    check(this.offset + bytes <= HEADER_MAX_BYTES);
    const grow = Math.min(HEADER_MAX_BYTES, Math.max(this.offset + bytes, this.buffer.length * 2, 1 << 20));
    const next = Buffer.alloc(grow);
    this.buffer.copy(next);
    const { bytesRead } = await this.handle.read(next, this.buffer.length, grow - this.buffer.length, this.buffer.length);
    this.buffer = next.subarray(0, this.buffer.length + bytesRead);
    check(this.offset + bytes <= this.buffer.length);
  }

  async u32() { await this.need(4); const v = this.buffer.readUInt32LE(this.offset); this.offset += 4; return v; }
  async u64() {
    await this.need(8);
    const v = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    check(v <= BigInt(Number.MAX_SAFE_INTEGER));
    return Number(v);
  }
  async string() {
    const length = await this.u64();
    await this.need(length);
    const v = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return v;
  }

  async value(type) {
    if (type === 8) return this.string();
    if (type === 9) {
      const itemType = await this.u32();
      const count = await this.u64();
      if (itemType === 8) {
        const items = new Array(count);
        for (let i = 0; i < count; i++) items[i] = await this.string();
        return items;
      }
      const width = SCALAR[itemType];
      check(width !== undefined);
      await this.need(width * count);
      const start = this.offset;
      this.offset += width * count;
      if (itemType === 6) return Float32Array.from({ length: count }, (_, i) => this.buffer.readFloatLE(start + i * 4));
      if (itemType === 5) return Int32Array.from({ length: count }, (_, i) => this.buffer.readInt32LE(start + i * 4));
      if (itemType === 4) return Uint32Array.from({ length: count }, (_, i) => this.buffer.readUInt32LE(start + i * 4));
      return null;
    }
    const width = SCALAR[type];
    check(width !== undefined);
    await this.need(width);
    const at = this.offset;
    this.offset += width;
    switch (type) {
      case 0: return this.buffer.readUInt8(at);
      case 1: return this.buffer.readInt8(at);
      case 2: return this.buffer.readUInt16LE(at);
      case 3: return this.buffer.readInt16LE(at);
      case 4: return this.buffer.readUInt32LE(at);
      case 5: return this.buffer.readInt32LE(at);
      case 6: return this.buffer.readFloatLE(at);
      case 7: return this.buffer.readUInt8(at) !== 0;
      case 12: return this.buffer.readDoubleLE(at);
      default: return Number(this.buffer.readBigUInt64LE(at));
    }
  }
}

/**
 * The tokenizer metadata of a GGUF file, and a digest over the raw bytes of exactly the keys the encoder uses. The digest
 * identifies the tokenizer, not the weights: two models with equal digests tokenize identically.
 */
export async function readGgufTokenizer(path) {
  let handle;
  try { handle = await open(path, 'r'); } catch { throw new TokenizerError('missing'); }
  try {
    return await readGgufTokenizerFrom(handle);
  } finally {
    await handle.close();
  }
}

/** As readGgufTokenizer, from an already open file handle the caller owns, so other checks can bind the same open file. */
export async function readGgufTokenizerFrom(handle) {
  const reader = new Reader(handle);
  await reader.need(4);
  check(reader.buffer.toString('latin1', 0, 4) === 'GGUF');
  reader.offset = 4;
  const version = await reader.u32();
  check(version === 2 || version === 3);
  await reader.u64();
  const kvCount = await reader.u64();
  const meta = {};
  const hash = createHash('sha256').update('source-memory.gguf-tokenizer/1\0');
  const raw = {};
  for (let i = 0; i < kvCount; i++) {
    const key = await reader.string();
    const type = await reader.u32();
    const start = reader.offset;
    const value = await reader.value(type);
    if (TOKENIZER_KEYS.includes(key)) raw[key] = { type, bytes: reader.buffer.subarray(start, reader.offset) };
    if (TOKENIZER_KEYS.includes(key) || key === 'general.architecture' || key.endsWith('.context_length')) meta[key] = value;
  }
  for (const key of TOKENIZER_KEYS) {
    hash.update(`${key}\0`);
    if (raw[key]) hash.update(`${raw[key].type}\0`).update(raw[key].bytes);
    hash.update('\0');
  }
  const architecture = meta['general.architecture'];
  return {
    model: meta['tokenizer.ggml.model'] ?? null,
    architecture: architecture ?? null,
    context_length: architecture ? meta[`${architecture}.context_length`] ?? null : null,
    tokens: meta['tokenizer.ggml.tokens'],
    scores: meta['tokenizer.ggml.scores'],
    types: meta['tokenizer.ggml.token_type'],
    bos: meta['tokenizer.ggml.bos_token_id'],
    eos: meta['tokenizer.ggml.eos_token_id'],
    add_bos: meta['tokenizer.ggml.add_bos_token'] ?? true,
    add_eos: meta['tokenizer.ggml.add_eos_token'] ?? false,
    sha256: hash.digest('hex'),
  };
}

// Max-heap on (score, then leftmost), the order Ollama's merge queue pops in.
class MergeQueue {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  before(x, y) { return x.score > y.score || (x.score === y.score && x.a < y.a); }
  push(item) {
    const items = this.items;
    items.push(item);
    for (let i = items.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (!this.before(items[i], items[parent])) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      for (let i = 0; ;) {
        const left = 2 * i + 1, right = left + 1;
        let best = i;
        if (left < items.length && this.before(items[left], items[best])) best = left;
        if (right < items.length && this.before(items[right], items[best])) best = right;
        if (best === i) break;
        [items[i], items[best]] = [items[best], items[i]];
        i = best;
      }
    }
    return top;
  }
}

// JSON decoding on the server replaces an unpaired surrogate with U+FFFD; count what it will see.
const wellFormed = value => typeof value.toWellFormed === 'function' ? value.toWellFormed()
  : value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '\uFFFD');

/** An exact token counter for one tokenizer: `count(text)` is the length of the rendered input including BOS and EOS. */
export function sentencePiece(spec) {
  check(spec && spec.model === 'llama' && Array.isArray(spec.tokens) && spec.tokens.length > 0
    && spec.scores?.length === spec.tokens.length && spec.types?.length === spec.tokens.length);
  const ids = new Map();
  spec.tokens.forEach((token, id) => ids.set(token, id));
  const specials = spec.tokens.filter((token, id) => token && (spec.types[id] === TYPE_CONTROL || spec.types[id] === TYPE_USER_DEFINED));
  const specialFirst = specials.map(special => String.fromCodePoint(special.codePointAt(0)));
  // Every token covers at least one byte, except a space rewritten to an absent U+2581 piece, which falls back to its 3 bytes.
  const perByte = ids.has('\u2581') ? 1 : 3;
  const bytes = Array.from({ length: 256 }, (_, b) => ids.has(`<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`));
  const overhead = (spec.add_bos && Number.isSafeInteger(spec.bos) ? 1 : 0) + (spec.add_eos && Number.isSafeInteger(spec.eos) ? 1 : 0);

  function pieces(fragment) {
    const value = fragment.replaceAll(' ', '\u2581');
    if (ids.has(value)) return 1;
    const runes = Array.from(value);
    const merges = runes.map((rune, r) => ({ p: r - 1, n: r + 1, text: rune }));
    const queue = new MergeQueue();
    const pair = (a, b) => {
      if (a < 0 || b >= runes.length) return null;
      const joined = merges[a].text + merges[b].text;
      const id = ids.get(joined);
      return id === undefined ? null : { a, b, score: spec.scores[id], size: Buffer.byteLength(joined) };
    };
    for (let i = 0; i < runes.length - 1; i++) {
      const candidate = pair(i, i + 1);
      if (candidate) queue.push(candidate);
    }
    while (queue.size) {
      const { a, b, size } = queue.pop();
      const left = merges[a], right = merges[b];
      if (!left.text || !right.text || Buffer.byteLength(left.text) + Buffer.byteLength(right.text) !== size) continue;
      left.text += right.text;
      right.text = '';
      left.n = right.n;
      if (right.n < merges.length) merges[right.n].p = a;
      const before = pair(left.p, a);
      if (before) queue.push(before);
      const after = pair(a, left.n);
      if (after) queue.push(after);
    }
    let count = 0;
    for (const merge of merges) {
      if (!merge.text) continue;
      if (ids.has(merge.text)) { count++; continue; }
      for (const byte of Buffer.from(merge.text)) if (bytes[byte]) count++;
    }
    return count;
  }

  function count(input) {
    check(typeof input === 'string');
    const source = wellFormed(input);
    // Same split order as the server: each special, in vocabulary order, splits every remaining text fragment.
    let fragments = [{ value: source, special: false }];
    const present = new Set(source);
    for (let index = 0; index < specials.length; index++) {
      const special = specials[index];
      if (!present.has(specialFirst[index]) || !source.includes(special)) continue;
      const next = [];
      for (const fragment of fragments) {
        if (fragment.special) { next.push(fragment); continue; }
        let rest = fragment.value;
        for (let at = rest.indexOf(special); at >= 0; at = rest.indexOf(special)) {
          if (at > 0) next.push({ value: rest.slice(0, at), special: false });
          next.push({ value: special, special: true });
          rest = rest.slice(at + special.length);
        }
        if (rest) next.push({ value: rest, special: false });
      }
      fragments = next;
    }
    let total = overhead;
    for (const fragment of fragments) total += fragment.special ? 1 : pieces(fragment.value);
    return total;
  }

  /** A cheap upper bound on count(text); when it fits, the exact count fits too. */
  const bound = input => overhead + perByte * Buffer.byteLength(input);

  return { count, bound, overhead, sha256: spec.sha256 ?? null, context_length: spec.context_length ?? null };
}
