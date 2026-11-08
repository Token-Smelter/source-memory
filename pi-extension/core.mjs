import { digest, normalizeEnrichment, normalizeTurn, RELATIONS } from '../src/core.mjs';
import { imageBlock } from './image-archive.mjs';
import { evidenceSpansForEntry } from '../src/evidence-spans.mjs';

const fail = code => Object.assign(new Error(code), { code });
const finished = row => row?.message?.role === 'assistant' && !['error', 'aborted', 'toolUse'].includes(row.message.stopReason)
  && !row.message.content?.some?.(part => ['toolCall', 'tool_use'].includes(part.type));

function blockText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (['thinking', 'redacted_thinking', 'reasoning'].includes(block.type)) return '';
  if (['text', 'input_text', 'output_text'].includes(block.type)) return typeof block.text === 'string' ? block.text : '';
  if (['toolCall', 'tool_use'].includes(block.type)) return `${typeof block.name === 'string' ? block.name : 'tool'} ${JSON.stringify(block.arguments ?? block.input ?? block.args ?? {})}`;
  if (typeof block.text === 'string') return block.text;
  return typeof block.content === 'string' ? block.content : '';
}

function entryData(row) {
  const content = row.message.content;
  if (typeof content === 'string') return { text: content, ranges: [], images: [] };
  if (!Array.isArray(content)) return { text: '', ranges: [], images: [] };
  let result = '';
  const ranges = [], images = [];
  for (const block of content) {
    if (['audio', 'video'].includes(block?.type)) throw fail('source_content_unsupported');
    let value;
    if (block?.type === 'image') {
      const item = imageBlock(block);
      value = `[image sha256=${item.sha256} mime=${item.mime} bytes=${item.size}]`;
      images.push({ block, info: { sha256: item.sha256, mime: item.mime, bytes: item.size } });
    } else value = blockText(block);
    if (!value) continue;
    if (result) result += '\n';
    const start = result.length;
    result += value;
    if (block?.type === 'image') ranges.push({ start, end: result.length, reason: 'image_not_citable' });
  }
  return { text: result, ranges, images };
}

export function entryText(row) { return entryData(row).text; }

function turnAt(entries, through, cursor, conversation, { allowInterrupted = false } = {}) {
  if (!Array.isArray(entries) || typeof through !== 'string' || !through || (cursor !== null && (typeof cursor !== 'string' || !cursor))) throw fail('invalid_input');
  const byId = new Map();
  for (const row of entries) {
    if (!row || typeof row.id !== 'string' || !row.id || !Object.hasOwn(row, 'parentId') || byId.has(row.id)) throw fail('source_invalid');
    byId.set(row.id, row);
  }
  const reply = byId.get(through);
  if (!reply) throw fail('source_unavailable');
  if (reply.type !== 'message' || !reply.message) throw fail('turn_incomplete');
  if (!finished(reply) && !allowInterrupted) throw fail('turn_incomplete');
  const ancestry = [];
  const seen = new Set();
  for (let current = through; current; current = byId.get(current)?.parentId) {
    const row = byId.get(current);
    if (!row || seen.has(current)) throw fail('cursor_unresolved');
    seen.add(current);
    if (['compaction', 'branch_summary'].includes(row.type)) throw fail('source_boundary_unresolved');
    ancestry.unshift(row);
  }
  const position = cursor === null ? -1 : ancestry.findIndex(row => row.id === cursor);
  if ((cursor !== null && position < 0) || position === ancestry.length - 1) throw fail('cursor_unresolved');
  const chain = ancestry.slice(position + 1);
  const images = [];
  const sourceEntries = chain.filter(row => row.type === 'message' && row.message).map(row => {
    const role = row.message.role === 'toolResult' ? 'tool' : row.message.role;
    if (!['user', 'assistant', 'tool', 'system'].includes(role)) throw fail('source_role_unsupported');
    const parsed = entryData(row);
    for (const image of parsed.images) images.push({ entry_id: row.id, ...image });
    return { id: row.id, role, text: parsed.text, ...(parsed.ranges.length ? { uncitable_ranges: parsed.ranges } : {}) };
  });
  const omitted = chain.filter(row => row.type === 'custom_message').map(row => row.id);
  const turn = { source: 'pi-memory', conversation_id: conversation,
    turn_id: digest(['pi-memory-turn/v1', cursor, through]), ...(cursor === null ? { lineage_root: true } : {}), entries: sourceEntries };
  normalizeTurn(turn);
  return { turn, images, omissions: { custom_message: { count: omitted.length, entry_ids: omitted } } };
}

/** The same cursor-bounded source turn is retained before either live or replay distillation. */
export async function distillThrough(session, throughEntryId, cursor, { allowInterrupted = false } = {}) {
  if (!session || !Array.isArray(session.scopes) || session.scopes.length !== 1
    || typeof session.scopes[0] !== 'string' || !session.scopes[0]) throw fail('scope_unresolved');
  if (!session.memory || typeof session.memory.ingest !== 'function' || !session.distiller || typeof session.distiller.run !== 'function') throw fail('invalid_input');
  const { turn, images, omissions } = turnAt(session.entries, throughEntryId, cursor, session.conversation_id, { allowInterrupted });
  if (images.length && typeof session.imageArchive?.archive !== 'function') throw fail('image_archive_required');
  if (images.length) {
    const archived = images.map(image => ({ entry_id: image.entry_id, ...session.imageArchive.archive(image.block) }));
    omissions.images = { count: archived.length, disposition: 'archived_not_text_citable', items: archived };
  }
  const receipt = await session.memory.ingest(session.scopes[0], turn);
  if (typeof receipt?.id !== 'string' || !receipt.id) throw fail('ingest_receipt_invalid');
  if (typeof session.ensureIndexed === 'function') await session.ensureIndexed(session.memory, session.scopes[0], receipt.indexing, { turnId: receipt.id });
  const result = await session.distiller.run({ turn, receipt, throughEntryId, cursor, scope: session.scopes[0] });
  if (result?.status !== 'complete') throw fail('distillation_incomplete');
  return { cursor: throughEntryId, turn_id: turn.turn_id, receipt, omissions, distillation: result };
}

/** Collects only the record and evidence handles offered by the current Memory comparison packet. */
export function createLinkChoices(packet) {
  if (!packet || !Array.isArray(packet.records) || !Array.isArray(packet.sources)) throw fail('offer_invalid');
  const records = new Set(packet.records.map(row => row.ref));
  const sources = new Set(packet.sources.filter(row => !/\[image sha256=[a-f0-9]{64} mime=/.test(row.text ?? '')).map(row => row.ref));
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
export function createTurnTools({ scope, turn, receipt, memory, sourceChunks = [], requireSearch = false, ensureIndexed, reviewer, reviewMode = 'separate' }) {
  if (typeof scope !== 'string' || !scope || !turn?.turn_id || !Array.isArray(turn.entries) || !receipt?.id || !memory) throw fail('invalid_input');
  const labels = new Map();
  const imageNotes = [];
  for (const entry of turn.entries) {
    const offered = evidenceSpansForEntry(entry, sourceChunks);
    for (const span of offered.spans) labels.set(`ref-${String(labels.size + 1).padStart(6, '0')}`, { entry, start: span.start, end: span.end });
    imageNotes.push(...offered.omissions);
  }
  const recordIds = [];
  const actionHandles = new Set();
  const buildRecord = (kind, text, refs) => {
    if (!Array.isArray(refs) || !refs.length || new Set(refs).size !== refs.length || refs.some(ref => !labels.has(ref))) throw fail('label_not_offered');
    const spans = refs.map(ref => {
      const { entry, start, end } = labels.get(ref);
      if (start === end) throw fail('label_empty');
      return { turn: receipt.id, entry_id: entry.id, start, end };
    });
    return { id: `pi-memory-record-${digest(['pi-memory-record/v1', scope, turn.turn_id, kind, text, spans])}`,
      kind, text, status: 'proposed', attribution: 'Pi distiller proposal; not operator acceptance', evidence: spans };
  };
  let searches = 0;
  let searchFailed = false;
  let incompleteSearch = false;
  const searchStatuses = [];
  const returnedPriorIds = new Set();
  let offer = null;
  let choices = null;
  return {
    labels() { return [...labels].map(([ref, span]) => ({ ref, role: span.entry.role, text: span.entry.text.slice(span.start, span.end) })); },
    imageNotes() { return structuredClone(imageNotes); },
    async record(kind, text, refs, options = {}) {
      if (requireSearch && (!searches || searchFailed)) throw fail('search_required');
      const record = buildRecord(kind, text, refs);
      if (offer && typeof memory.cancelLinks === 'function') await memory.cancelLinks(offer.token);
      let write;
      if (kind === 'outcome') {
        const handle = options.action_handle;
        const actionInput = options.new_action;
        if (Boolean(handle) === Boolean(actionInput) || (handle && !actionHandles.has(handle))) throw fail('outcome_referent_required');
        if (typeof memory.beginOutcome !== 'function' || typeof memory.applyOutcome !== 'function') throw fail('outcome_unavailable');
        const action = actionInput ? buildRecord('action', actionInput.text, actionInput.evidence_labels) : null;
        const offered = await memory.beginOutcome(scope, receipt.id, record, action, handle ?? null);
        let review = null;
        if (offered.proposal?.requires_review) {
          if (reviewMode !== 'separate' || typeof reviewer?.review !== 'function') throw fail('review_required');
          const decision = await reviewer.review({ proposal: offered.proposal, mode: reviewMode });
          if (!decision || !Array.isArray(decision.approved) || typeof decision.reviewer !== 'string' || typeof decision.decision_ref !== 'string') throw fail('review_invalid');
          if (!decision.approved.includes(0)) { await memory.cancelOutcome(offered.token); return { status: 'refused', reason: 'review_rejected' }; }
          review = { reviewer: `separate:${decision.reviewer}`, decision_ref: decision.decision_ref,
            proposal_sha256: offered.proposal.proposal_sha256, approved: [0] };
        }
        write = await memory.applyOutcome(scope, offered.token, review);
        if (write?.status !== 'written' || !write.records?.includes(record.id)) throw fail('outcome_write_unknown');
        for (const id of write.records) if (!recordIds.includes(id)) recordIds.push(id);
      } else {
        if (options.action_handle || options.new_action) throw fail('invalid_input');
        const payload = normalizeEnrichment({ records: [record], relations: [] });
        write = await memory.enrich(scope, payload, { trigger: receipt.id });
        if (!recordIds.includes(record.id)) recordIds.push(record.id);
      }
      if (typeof ensureIndexed === 'function') await ensureIndexed(memory, scope, write?.indexing, { recordIds: write?.records ?? [] });
      offer = null;
      choices = null;
      return { id: record.id, status: 'proposed' };
    },
    async search(query, kinds) {
      if (typeof query !== 'string' || !query || !Array.isArray(kinds) || kinds.some(kind => typeof kind !== 'string')) throw fail('invalid_input');
      try {
        if (typeof memory.recall !== 'function') throw fail('search_unavailable');
        const result = await memory.recall(scope, { query, limit: 8, max_chars: 24000 }, { trigger: receipt.id });
        if (!['ready', 'no_matches', 'budget_limited'].includes(result?.status) || !Array.isArray(result.bundles)
          || Object.values(result.channels ?? {}).some(row => row.status === 'unavailable')) throw fail('search_incomplete');
        if (result.status === 'budget_limited') {
          if (!Number.isSafeInteger(result.budget_omitted) || result.budget_omitted < 1 || !result.channels) throw fail('search_incomplete');
          incompleteSearch = true;
        }
        if (Object.values(result.channels ?? {}).some(row => ['partial', 'pending'].includes(row.status))) incompleteSearch = true;
        const relationshipsComplete = result.relationship_context_complete === true
          && result.bundles.every(bundle => bundle.relationship_context_complete === true);
        if (!relationshipsComplete) incompleteSearch = true;
        const relationshipGaps = [...new Set(result.bundles.flatMap(bundle => Array.isArray(bundle.gaps) ? bundle.gaps : []))];
        searches++;
        const matching = result.bundles.flatMap(bundle => bundle.records ?? []).filter(row => !kinds.length || kinds.includes(row.kind));
        const localOmitted = Math.max(0, matching.length - 32);
        if (localOmitted) incompleteSearch = true;
        searchStatuses.push({ status: result.status, budget_omitted: result.budget_omitted ?? 0, local_records_omitted: localOmitted,
          relationship_context_complete: relationshipsComplete, relationship_gaps: relationshipGaps,
          partial_channels: Object.entries(result.channels ?? {}).filter(([, row]) => ['partial', 'pending'].includes(row.status)).map(([name]) => name) });
        const records = matching.slice(0, 32).map(row => ({ id: row.id, kind: row.kind, snippet: row.text,
            ...(row.kind === 'action' && row.action_handle ? { action_handle: row.action_handle } : {}) }));
        for (const row of records) {
          if (typeof row.id === 'string' && row.id) returnedPriorIds.add(row.id);
          if (typeof row.action_handle === 'string' && row.action_handle) actionHandles.add(row.action_handle);
        }
        const channels = result.channels ? Object.fromEntries(Object.entries(result.channels).map(([name, value]) => [name,
          { status: value.status, ...(value.reason ? { reason: value.reason } : {}) }])) : null;
        let linkOffer = null;
        if (recordIds.length && typeof memory.beginLinks === 'function') {
          const offered = await this.offer();
          const retrieval = offered.packet.retrieval ?? null;
          if (retrieval?.status === 'budget_limited' || (retrieval?.omitted_prior_records ?? 0) > 0
            || retrieval?.trigger_omissions?.some(row => row.reason === 'packet_budget')) incompleteSearch = true;
          searchStatuses.push({ status: retrieval?.status ?? 'offer', budget_omitted: retrieval?.budget_omitted ?? 0,
            omitted_prior_records: retrieval?.omitted_prior_records ?? 0, trigger_omitted: retrieval?.trigger_omissions?.length ?? 0 });
          linkOffer = {
            records: offered.packet.records.filter(row => !kinds.length || kinds.includes(row.kind)).slice(0, 32)
              .map(row => ({ handle: row.ref, kind: row.kind, snippet: row.text })),
            sources: offered.packet.sources.filter(row => !/\[image sha256=[a-f0-9]{64} mime=/.test(row.text ?? ''))
              .slice(0, 128).map(row => ({ handle: row.ref, role: row.role, trigger: row.trigger, snippet: row.text })),
            retrieval,
          };
        }
        return { status: result.status, records, filtered: kinds.length > 0, completeness_guaranteed: false,
          budget_omitted: result.budget_omitted ?? null, local_records_omitted: localOmitted,
          retrieval_complete: result.retrieval_complete ?? false, channels, ...(linkOffer ? { link_offer: linkOffer } : {}) };
      } catch (problem) { searchFailed = true; throw problem; }
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
    stats() { return { records: recordIds.length, searches, search_failed: searchFailed,
      incomplete_search: incompleteSearch, search_statuses: structuredClone(searchStatuses), returned_prior_ids: [...returnedPriorIds] }; },
  };
}
