import { MemoryError } from './core.mjs';

export const POOL_MAX_CHARS = 1_000_000;
export const ENVELOPE_MAX_BYTES = 65_536;

export const isPoolRequest = input => input?.mode === 'evidence_advice' && input?.group === 'conversation';

const bytes = text => Buffer.byteLength(text);

// Serializes a grouped evidence_advice reply once and bounds its transport framing. U (unit bytes, as recall accounts
// them) and D (the duplicate top-level bundles) are measured on the pieces that are then spliced into the output, so
// no part is serialized twice; the result is byte-identical to JSON.stringify(reply) plus the newline.
export function serializePoolReply(reply, maxChars) {
  const units = reply.units.map(unit => JSON.stringify(unit));
  const bundles = reply.bundles.map(bundle => JSON.stringify(bundle));
  const fields = Object.entries(reply).flatMap(([key, value]) => {
    if (value === undefined) return [];
    const body = key === 'units' ? `[${units.join(',')}]` : key === 'bundles' ? `[${bundles.join(',')}]` : JSON.stringify(value);
    return [`${JSON.stringify(key)}:${body}`];
  });
  const output = `{${fields.join(',')}}\n`;
  const total = bytes(output);
  const unitBytes = units.reduce((sum, text) => sum + bytes(text), 0);
  const bundleBytes = bundles.reduce((sum, text) => sum + bytes(text), 0);
  const envelope = total - unitBytes - bundleBytes;
  if (envelope > ENVELOPE_MAX_BYTES || total > 2 * maxChars + ENVELOPE_MAX_BYTES) throw new MemoryError('output_envelope_exceeded');
  return output;
}
