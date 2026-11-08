const fail = code => Object.assign(new Error(code), { code });

function valid(value, references, candidates) {
  if (!value || Object.keys(value).sort().join(',') !== 'items' || !Array.isArray(value.items) || value.items.length !== references.length) return false;
  const expected = new Set(references.map(row => row.id)), allowed = new Set(candidates.map(row => row.id)), seen = new Set();
  return value.items.every(row => {
    if (!row || Object.keys(row).sort().join(',') !== 'candidate_ids,reason,reference_id,verdict' || !expected.has(row.reference_id) || seen.has(row.reference_id)
      || !['matched', 'no_match', 'uncertain'].includes(row.verdict) || !Array.isArray(row.candidate_ids)
      || new Set(row.candidate_ids).size !== row.candidate_ids.length || row.candidate_ids.some(id => !allowed.has(id))
      || (row.verdict === 'matched' && !row.candidate_ids.length) || (row.verdict === 'no_match' && row.candidate_ids.length)
      || typeof row.reason !== 'string' || !row.reason.trim() || Buffer.byteLength(row.reason) > 1024) return false;
    seen.add(row.reference_id); return true;
  });
}

/** Re-read original outputs only; uncertain candidate IDs remain hints and are never treated as matches. */
export function reconcileStageBatches({ reference, candidate, outputs, ledger, batchSize = 10 }) {
  if (!Array.isArray(reference?.records) || !Array.isArray(candidate?.records) || !Array.isArray(outputs) || !Array.isArray(ledger)
    || !Number.isSafeInteger(batchSize) || batchSize < 1) throw fail('stage_reconcile_invalid');
  const starts = new Map(ledger.filter(row => row.type === 'started').map(row => [row.id, row]));
  const results = new Map(ledger.filter(row => row.type === 'result').map(row => [row.id, row]));
  const alignments = [], choices = [], unresolved = [];
  for (let offset = 0; offset < reference.records.length; offset += batchSize) {
    const batch = reference.records.slice(offset, offset + batchSize), number = Math.floor(offset / batchSize) + 1;
    const attempts = outputs.filter(row => starts.get(row.id)?.checkpoint === `batch-${number}` && results.get(row.id)?.outcome === 'received')
      .sort((a, b) => a.id - b.id);
    let accepted = null, selected = null;
    for (const row of attempts) {
      const calls = (row.message?.content ?? []).filter(part => part.type === 'toolCall');
      const call = row.message?.stopReason === 'toolUse' && calls.length === 1 && calls[0].name === 'submit_alignment' ? calls[0] : null;
      if (call && valid(call.arguments, batch, candidate.records)) { accepted = call.arguments.items; selected = row.id; break; }
    }
    if (!accepted) { unresolved.push(number); accepted = batch.map(row => ({ reference_id: row.id, verdict: 'uncertain', candidate_ids: [], reason: 'alignment unavailable' })); }
    choices.push({ batch: number, source_call_id: selected, inspected_attempts: attempts.length, status: selected === null ? 'unavailable' : 'accepted_schema_valid' });
    alignments.push(...accepted);
  }
  return { alignments, choices, unresolved, uncertain_hint_count: alignments.filter(row => row.verdict === 'uncertain' && row.candidate_ids.length).length };
}
