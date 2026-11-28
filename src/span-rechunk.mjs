import { CHUNK_MAX_BYTES, MemoryError, normalizeTurn, requireThat } from './core.mjs';
import { deriveChunks, TOKEN_POLICY } from './chunk-policy.mjs';

// A UTF-16 offset that does not split a surrogate pair.
const boundary = (text, at) => at === 0 || at === text.length
  || !(/[\uD800-\uDBFF]/u.test(text[at - 1]) && /[\uDC00-\uDFFF]/u.test(text[at]));

// The pieces' intervals, in order, must exactly cover a text of `length`: same ends and no hole. Overlap is allowed.
function coversExactly(pieces, length) {
  let reached = 0;
  for (const piece of [...pieces].sort((a, b) => a.start - b.start)) {
    if (piece.start > reached) return false;
    reached = Math.max(reached, piece.end);
  }
  return pieces.length > 0 && pieces[0].start === 0 && reached === length;
}

/**
 * Re-derives one stored span of an unchanged entry under a verified token policy, as pieces that cover the span exactly: the
 * first starts at `start`, the last ends at `end`, there is no hole, and each is within the policy's token cap and
 * CHUNK_MAX_BYTES. Offsets are UTF-16 into the original entry, so citations of the entry resolve as before. Nothing is
 * stored or embedded here. A span that is not an exact, in-bounds slice on code-point boundaries, an unverified tokenizer, a
 * derivation gap or a piece over a limit is refused; the caller keeps the span as a declared gap.
 */
export async function rechunkSpan({ entryText, entryId, role, start, end, policy }) {
  requireThat(typeof entryText === 'string' && typeof entryId === 'string' && typeof role === 'string', 'span_rechunk_invalid_span');
  requireThat(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < end && end <= entryText.length
    && boundary(entryText, start) && boundary(entryText, end), 'span_rechunk_invalid_span');
  requireThat(policy?.descriptor?.policy === TOKEN_POLICY && policy.descriptor.context !== null, 'span_rechunk_tokenizer_unverified');
  const text = entryText.slice(start, end);
  let derived;
  try {
    const turn = normalizeTurn({ source: 'span-rechunk', conversation_id: 'span-rechunk', turn_id: 'span-rechunk', entries: [{ id: entryId, role, text }] });
    derived = await deriveChunks(turn, policy);
  } catch (error) {
    // A span normalization or derivation cannot use is a refusal of this span, not a crash of the caller's batch.
    if (error instanceof MemoryError) throw new MemoryError('span_rechunk_coverage_incomplete');
    throw error;
  }
  requireThat(derived.gaps.length === 0 && coversExactly(derived.chunks, text.length), 'span_rechunk_coverage_incomplete');
  const cap = policy.descriptor.token_cap;
  for (const piece of derived.chunks) {
    requireThat(Number.isSafeInteger(piece.token_count) && piece.token_count <= cap && Buffer.byteLength(piece.text) <= CHUNK_MAX_BYTES,
      'span_rechunk_piece_over_limit');
  }
  const pieces = derived.chunks.map(piece => ({ start: start + piece.start, end: start + piece.end, text: piece.text, token_count: piece.token_count }));
  // Each piece must be the entry's own text at its offsets; a normalization that changed the text would break citations.
  requireThat(pieces.every(piece => entryText.slice(piece.start, piece.end) === piece.text), 'span_rechunk_coverage_incomplete');
  return pieces;
}
