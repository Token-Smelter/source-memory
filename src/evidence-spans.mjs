const fail = code => Object.assign(new Error(code), { code });
const placeholder = /\[image sha256=[a-f0-9]{64} mime=[^\]]+\]/gi;

/** Long entries use the store's exact chunk offsets; images and partial chunks are never citable. */
export function evidenceSpansForEntry(entry, chunks = []) {
  if (!entry || typeof entry.id !== 'string' || typeof entry.text !== 'string' || !Array.isArray(chunks)) throw fail('evidence_invalid');
  const ranges = entry.uncitable_ranges ?? [...entry.text.matchAll(placeholder)].map(match => ({ start: match.index, end: match.index + match[0].length }));
  let previous = 0;
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < previous
      || range.end > entry.text.length || range.end <= range.start) throw fail('image_range_invalid');
    previous = range.end;
  }
  const spans = [], omissions = [];
  if (entry.text.length <= 16000) {
    let start = 0;
    for (const range of ranges) {
      if (start < range.start) spans.push({ entry_id: entry.id, start, end: range.start });
      omissions.push({ entry_id: entry.id, reason: 'image_not_citable', start: range.start, end: range.end });
      start = range.end;
    }
    if (start < entry.text.length) spans.push({ entry_id: entry.id, start, end: entry.text.length });
  } else {
    const matching = chunks.filter(row => row.entry_id === entry.id);
    if (!matching.length) throw fail('evidence_chunks_unavailable');
    const seen = new Set();
    for (const chunk of matching) {
      const { start, end, ordinal } = chunk;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(ordinal) || seen.has(ordinal)
        || start < 0 || end <= start || end > entry.text.length || end - start > 16000
        || (start > 0 && /[\uD800-\uDBFF]/u.test(entry.text[start - 1]) && /[\uDC00-\uDFFF]/u.test(entry.text[start]))
        || (end < entry.text.length && /[\uD800-\uDBFF]/u.test(entry.text[end - 1]) && /[\uDC00-\uDFFF]/u.test(entry.text[end]))) throw fail('evidence_chunk_invalid');
      seen.add(ordinal);
      if (ranges.some(range => start < range.end && end > range.start)) {
        omissions.push({ entry_id: entry.id, reason: 'image_overlapping_chunk_not_citable', ordinal });
        continue;
      }
      spans.push({ entry_id: entry.id, start, end });
    }
  }
  return { spans, omissions };
}
