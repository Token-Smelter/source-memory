import { digest, identity, namespace, normalizeEnrichment, OUTCOME_REFERENT_KINDS, RELATIONS } from '../../src/core.mjs';

const fail = code => Object.assign(new Error(code), { code });
const image = /\[image sha256=[a-f0-9]{64} mime=[^\]]+\]/i;
const attribution = 'Model-adjudicated reference; semantic audit pending; cited entries are not an authority determination.';

function wholeSpans(turn, entry) {
  const spans = [];
  for (let start = 0; start < entry.text.length;) {
    let end = Math.min(start + 16000, entry.text.length);
    if (end < entry.text.length && /[\uD800-\uDBFF]/u.test(entry.text[end - 1]) && /[\uDC00-\uDFFF]/u.test(entry.text[end])) end--;
    if (end <= start) throw fail('reference_evidence_invalid');
    spans.push({ turn, entry_id: entry.id, start, end });
    start = end;
  }
  return spans;
}

/** Build a fresh evaluation-only store image; the labeled reference itself is never changed. */
export function prepareReferenceSnapshot({ snapshot, reference, sourceKey, through }) {
  if (snapshot?.schema !== 'source-memory-logical-snapshot/v1' || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.relationships)
    || reference?.schema !== 'source-memory-r2-reference-cut/v1' || reference.source_key !== sourceKey || reference.scope !== snapshot.scope
    || reference.through_entry_id !== through || !Array.isArray(reference.records) || !Array.isArray(reference.edges)) throw fail('reference_invalid');
  const scope = snapshot.scope, ns = namespace(scope), entries = new Map();
  for (const node of snapshot.nodes.filter(row => row.labels?.includes('SMTurn'))) {
    const body = JSON.parse(node.properties.body);
    for (const entry of body.entries ?? []) {
      if (entries.has(entry.id)) throw fail('reference_source_ambiguous');
      entries.set(entry.id, { turn: node.uid, entry });
    }
  }
  const audit = { input_records: reference.records.length, input_edges: reference.edges.length,
    imported_records: 0, imported_edges: 0, dropped_entries: [], omitted_items: [], omitted_edges: [] };
  const spansFor = (citations, owner, kind) => {
    if (!Array.isArray(citations) || !citations.length) throw fail('reference_evidence_invalid');
    const chosen = [], seen = new Set();
    let used = 0;
    for (const citation of citations) {
      if (citation.source_key !== sourceKey || typeof citation.entry_id !== 'string' || seen.has(citation.entry_id)) throw fail('reference_evidence_invalid');
      seen.add(citation.entry_id);
      const value = entries.get(citation.entry_id);
      let reason = null, spans = [];
      if (!value) reason = 'source_entry_missing';
      else if (value.entry.role === 'derived' || !value.entry.text) reason = 'source_entry_uncitable';
      else if (image.test(value.entry.text)) reason = 'image_not_text_citable';
      else {
        spans = wholeSpans(value.turn, value.entry);
        if (used + value.entry.text.length > 32000) reason = 'whole_entry_character_budget';
        else if (chosen.length + spans.length > 16) reason = 'whole_entry_span_budget';
      }
      if (reason) { audit.dropped_entries.push({ owner_kind: kind, owner, entry_id: citation.entry_id, reason }); continue; }
      chosen.push(...spans); used += value.entry.text.length;
    }
    return chosen;
  };
  const records = [], original = new Map(reference.records.map(row => [row.id, row]));
  if (original.size !== reference.records.length) throw fail('reference_invalid');
  for (const row of reference.records) {
    const evidence = spansFor(row.evidence, row.id, 'record');
    if (!evidence.length) { audit.omitted_items.push({ id: row.id, reason: 'no_whole_citable_entry' }); continue; }
    records.push({ id: row.id, kind: row.kind, text: row.text, status: 'proposed', attribution, evidence });
  }
  const admitted = new Set(records.map(row => row.id)), relations = [];
  for (const [index, row] of reference.edges.entries()) {
    const key = `reference-edge-${digest(['reference-edge/v1', sourceKey, through, index, row.type, row.from, row.to])}`;
    if (row.type === 'outcome_of' && (original.get(row.from)?.kind !== 'outcome' || !OUTCOME_REFERENT_KINDS.includes(original.get(row.to)?.kind))) {
      audit.omitted_edges.push({ index, reason: 'outcome_of_invalid_endpoint_kind' }); continue;
    }
    if (!RELATIONS.includes(row.type) || row.from === row.to) { audit.omitted_edges.push({ index, reason: 'invalid_relation' }); continue; }
    if (!admitted.has(row.from) || !admitted.has(row.to)) { audit.omitted_edges.push({ index, reason: 'endpoint_item_omitted' }); continue; }
    const evidence = spansFor(row.evidence, String(index), 'edge');
    if (!evidence.length) { audit.omitted_edges.push({ index, reason: 'no_whole_citable_entry' }); continue; }
    relations.push({ id: key, type: row.type, from: row.from, to: row.to, attribution, evidence });
  }
  const normalized = normalizeEnrichment({ records, relations });
  const nodes = snapshot.nodes.filter(row => row.labels?.includes('SMTurn') || row.labels?.includes('SMChunk')).map(row => structuredClone(row));
  const relationships = snapshot.relationships.filter(row => row.type === 'SM_HAS_CHUNK').map(row => structuredClone(row));
  const retainedIds = new Set(nodes.map(row => row.uid));
  if (relationships.some(row => !retainedIds.has(row.from) || !retainedIds.has(row.to))) throw fail('reference_source_invalid');
  for (const record of normalized.records) {
    const uid = identity('record', scope, record.id);
    if (retainedIds.has(uid)) throw fail('reference_invalid');
    retainedIds.add(uid);
    nodes.push({ uid, labels: ['SMRecord', `${ns}Record`], properties: { uid, scope, record_id: record.id,
      hash: digest(record), body: JSON.stringify(record), text: record.text } });
    for (const turn of new Set(record.evidence.map(span => span.turn))) relationships.push({ from: uid, to: turn, type: 'SM_EVIDENCE', properties: {} });
  }
  for (const edge of normalized.relations) {
    const uid = identity('relation', scope, edge.id), from = identity('record', scope, edge.from), to = identity('record', scope, edge.to);
    if (retainedIds.has(uid) || !retainedIds.has(from) || !retainedIds.has(to)) throw fail('reference_invalid');
    retainedIds.add(uid);
    nodes.push({ uid, labels: ['SMRelation'], properties: { uid, scope, hash: digest(edge), body: JSON.stringify(edge), type: edge.type, from_uid: from, to_uid: to } });
    relationships.push({ from: uid, to: from, type: 'SM_FROM', properties: {} }, { from: uid, to, type: 'SM_TO', properties: {} });
  }
  audit.imported_records = normalized.records.length;
  audit.imported_edges = normalized.relations.length;
  return { snapshot: { schema: snapshot.schema, scope, nodes, relationships }, audit };
}
