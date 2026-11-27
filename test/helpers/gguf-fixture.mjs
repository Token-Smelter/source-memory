// Builds a small fictional GGUF v3 file holding only tokenizer metadata, in the layout readGgufTokenizer parses.
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const str = value => { const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([u64(bytes.length), bytes]); };

function kv(key, type, value) {
  const head = Buffer.concat([str(key), u32(type)]);
  if (type === 8) return Buffer.concat([head, str(value)]);
  if (type === 4) return Buffer.concat([head, u32(value)]);
  if (type === 7) return Buffer.concat([head, Buffer.from([value ? 1 : 0])]);
  if (type === 9) {
    const [itemType, items] = value;
    const body = itemType === 8 ? items.map(str)
      : items.map(item => { const b = Buffer.alloc(4); if (itemType === 6) b.writeFloatLE(item); else b.writeInt32LE(item); return b; });
    return Buffer.concat([head, u32(itemType), u64(items.length), ...body]);
  }
  throw new Error(`unsupported type ${type}`);
}

const NORMAL = 1, CONTROL = 3, USER_DEFINED = 4, BYTE = 6;

/** A fictional vocabulary: controls, all 256 byte tokens, a space and newline special, and scored normal pieces. */
export function fictionalVocabulary(pieces = {}) {
  const tokens = ['<pad>', '<eos>', '<bos>', '<unk>', '<start_of_turn>'];
  const types = [CONTROL, CONTROL, CONTROL, CONTROL, USER_DEFINED];
  const scores = [0, 0, 0, 0, 0];
  for (let b = 0; b < 256; b++) { tokens.push(`<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`); types.push(BYTE); scores.push(0); }
  for (const special of [' ', '\n']) { tokens.push(special); types.push(USER_DEFINED); scores.push(0); }
  const normal = { '\u2581': -1, a: -2, b: -2, c: -2, d: -2, e: -2, x: -3, y: -3, ab: -1.5, abc: -1, cd: -1.2, abcd: -0.5, ...pieces };
  for (const [piece, score] of Object.entries(normal)) { tokens.push(piece); types.push(NORMAL); scores.push(score); }
  return { tokens, types, scores };
}

export function ggufTokenizerFile({ tokens, types, scores }, { addEos = true, context = 64, extra = [] } = {}) {
  const entries = [
    kv('general.architecture', 8, 'fiction'),
    kv('fiction.context_length', 4, context),
    kv('tokenizer.ggml.model', 8, 'llama'),
    kv('tokenizer.ggml.tokens', 9, [8, tokens]),
    kv('tokenizer.ggml.scores', 9, [6, scores]),
    kv('tokenizer.ggml.token_type', 9, [5, types]),
    kv('tokenizer.ggml.bos_token_id', 4, 2),
    kv('tokenizer.ggml.eos_token_id', 4, 1),
    kv('tokenizer.ggml.add_bos_token', 7, true),
    kv('tokenizer.ggml.add_eos_token', 7, addEos),
    ...extra,
  ];
  return Buffer.concat([Buffer.from('GGUF', 'latin1'), u32(3), u64(0), u64(entries.length), ...entries]);
}
