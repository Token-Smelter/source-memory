import { digest, normalizeEnrichment, normalizeTurn, RELATIONS } from '../src/core.mjs';

const fail = code => Object.assign(new Error(code), { code });
const finished = row => row?.message?.role === 'assistant' && !['error', 'aborted', 'toolUse'].includes(row.message.stopReason)
  && !row.message.content?.some?.(part => ['toolCall', 'tool_use'].includes(part.type));

function blockText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (['text', 'input_text', 'output_text'].includes(block.type)) return typeof block.text === 'string' ? block.text : '';
  if (['toolCall', 'tool_use'].includes(block.type)) return `${typeof block.name === 'string' ? block.name : 'tool'} ${JSON.stringify(block.arguments ?? block.input ?? block.args ?? {})}`;
  if (typeof block.text === 'string') return block.text;
  return typeof block.content === 'string' ? block.content : '';
}

function entryText(row) {
  const content = row.message.content;
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map(blockText).filter(Boolean).join('\n') : '';
}

function turnAt(entries, through, cursor, conversation) {
  if (!Array.isArray(entries) || typeof through !== 'string' || !through || (cursor !== null && (typeof cursor !== 'string' || !cursor))) throw fail('invalid_input');
  const byId = new Map();
  for (const row of entries) {
    if (!row || typeof row.id !== 'string' || !row.id || !Object.hasOwn(row, 'parentId') || byId.has(row.id)) throw fail('source_invalid');
    byId.set(row.id, row);
  }
  const reply = byId.get(through);
  if (!reply) throw fail('source_unavailable');
  if (!finished(reply)) throw fail('turn_incomplete');
  const chain = [];
  const seen = new Set();
  let current = through;
  while (current && current !== cursor) {
    const row = byId.get(current);
    if (!row || seen.has(current)) throw fail('cursor_unresolved');
    seen.add(current);
    if (['compaction', 'branch_summary'].includes(row.type)) throw fail('source_boundary_unresolved');
    chain.unshift(row);
    current = row.parentId;
  }
  if (current !== cursor || !chain.length) throw fail('cursor_unresolved');
  const sourceEntries = chain.filter(row => row.message).map(row => {
    const role = row.message.role === 'toolResult' ? 'tool' : row.message.role;
    if (!['user', 'assistant', 'tool', 'system'].includes(role)) throw fail('source_role_unsupported');
    return { id: row.id, role, text: entryText(row) };
  });
  if (chain.some(row => row.type === 'custom_message')) throw fail('source_role_unsupported');
  const turn = { source: 'pi-memory', conversation_id: conversation,
    turn_id: digest(['pi-memory-turn/v1', cursor, through]), ...(cursor === null ? { lineage_root: true } : {}), entries: sourceEntries };
  normalizeTurn(turn);
  return turn;
}

/** The same cursor-bounded source turn is retained before either live or replay distillation. */
export async function distillThrough(session, throughEntryId, cursor) {
  if (!session || !Array.isArray(session.scopes) || session.scopes.length !== 1
    || typeof session.scopes[0] !== 'string' || !session.scopes[0]) throw fail('scope_unresolved');
  if (!session.memory || typeof session.memory.ingest !== 'function' || !session.distiller || typeof session.distiller.run !== 'function') throw fail('invalid_input');
  const turn = turnAt(session.entries, throughEntryId, cursor, session.conversation_id);
  const receipt = await session.memory.ingest(session.scopes[0], turn);
  if (typeof receipt?.id !== 'string' || !receipt.id) throw fail('ingest_receipt_invalid');
  const result = await session.distiller.run({ turn, receipt, throughEntryId, cursor, scope: session.scopes[0] });
  if (result?.status !== 'complete') throw fail('distillation_incomplete');
  return { cursor: throughEntryId, turn_id: turn.turn_id, receipt, distillation: result };
}

/** Collects only the record and evidence handles offered by the current Memory comparison packet. */
export function createLinkChoices(packet) {
  if (!packet || !Array.isArray(packet.records) || !Array.isArray(packet.sources)) throw fail('offer_invalid');
  const records = new Set(packet.records.map(row => row.ref));
  const sources = new Set(packet.sources.map(row => row.ref));
  const links = [];
  return {
    add(link) {
      if (!link || !records.has(link.from) || !records.has(link.to) || link.from === link.to
        || !Array.isArray(link.evidence) || !link.evidence.length || !link.evidence.every(ref => sources.has(ref))) throw fail('handle_not_offered');
      if (!RELATIONS.includes(link.type) || !['explicit', 'ambiguous', 'unsupported', 'chronology_only'].includes(link.support)) throw fail('link_invalid');
      if (links.length >= 16 || link.evidence.length > 16 || new Set(link.evidence).size !== link.evidence.length) throw fail('link_invalid');
      links.push({ from: link.from, to: link.to, type: link.type, evidence: [...link.evidence], support: link.support });
    },
    output() { return JSON.stringify({ links }); },
  };
}

/** Tool-facing labels name only entries of the just-retained cursor turn. */
export function createTurnTools({ scope, turn, receipt, memory }) {
  if (typeof scope !== 'string' || !scope || !turn?.turn_id || !Array.isArray(turn.entries) || !receipt?.id || !memory) throw fail('invalid_input');
  const labels = new Map(turn.entries.map((entry, index) => [`ref-${String(index + 1).padStart(6, '0')}`, entry]));
  const recordIds = [];
  let offer = null;
  let choices = null;
  return {
    labels() { return [...labels].map(([ref, entry]) => ({ ref, role: entry.role, text: entry.text })); },
    async record(kind, text, refs) {
      if (!Array.isArray(refs) || !refs.length || new Set(refs).size !== refs.length || refs.some(ref => !labels.has(ref))) throw fail('label_not_offered');
      const spans = refs.map(ref => {
        const entry = labels.get(ref);
        return { turn: receipt.id, entry_id: entry.id, start: 0, end: entry.text.length };
      });
      const record = { id: `pi-memory-record-${digest(['pi-memory-record/v1', scope, turn.turn_id, kind, text, spans])}`,
        kind, text, status: 'proposed', attribution: 'Pi distiller proposal; not operator acceptance', evidence: spans };
      const payload = normalizeEnrichment({ records: [record], relations: [] });
      if (offer && typeof memory.cancelLinks === 'function') await memory.cancelLinks(offer.token);
      await memory.enrich(scope, payload, { trigger: receipt.id });
      if (!recordIds.includes(record.id)) recordIds.push(record.id);
      offer = null;
      choices = null;
      return { id: record.id, status: 'proposed' };
    },
    async search(query, kinds) {
      if (typeof query !== 'string' || !query || !Array.isArray(kinds) || kinds.some(kind => typeof kind !== 'string')) throw fail('invalid_input');
      if (recordIds.length && typeof memory.beginLinks === 'function') {
        const offered = await this.offer();
        const records = offered.packet.records.filter(row => !kinds.length || kinds.includes(row.kind)).slice(0, 32)
          .map(row => ({ handle: row.ref, kind: row.kind, snippet: row.text.slice(0, 500) }));
        const sources = offered.packet.sources.slice(0, 128).map(row => ({ handle: row.ref, role: row.role, trigger: row.trigger, snippet: row.text.slice(0, 500) }));
        return { status: 'offer', records, sources, filtered: kinds.length > 0, completeness_guaranteed: false };
      }
      if (typeof memory.recall !== 'function') throw fail('search_unavailable');
      const result = await memory.recall(scope, { query, limit: 8, max_chars: 24000 });
      const records = (result.bundles ?? []).flatMap(bundle => bundle.records ?? []).filter(row => !kinds.length || kinds.includes(row.kind))
        .slice(0, 32).map(row => ({ kind: row.kind, snippet: row.text.slice(0, 500) }));
      return { status: result.status, records, filtered: kinds.length > 0, completeness_guaranteed: false };
    },
    async offer() {
      if (!recordIds.length || typeof memory.beginLinks !== 'function') throw fail('offer_unavailable');
      if (offer) return { token: offer.token, packet: offer.packet };
      const result = await memory.beginLinks(scope, receipt.id, [...recordIds]);
      if (!result?.token || !result.packet) throw fail('offer_invalid');
      offer = result;
      choices = createLinkChoices(result.packet);
      return { token: result.token, packet: result.packet };
    },
    link(choice) {
      if (!choices) throw fail('offer_unavailable');
      choices.add(choice);
      return { status: 'pending_review' };
    },
    pendingLinks() { return offer && choices ? { token: offer.token, output: choices.output() } : null; },
  };
}
