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

const SUMMARY_TYPES = new Set(['compaction', 'branch_summary']);

/**
 * memory-retention/r2-v1 availability invariant, verbatim: "Use only material proven available and eligible on the selected
 * active branch at the checkpoint. A summary is admissible only when its full dependency closure is permitted."
 * Interpretation: permitted means on the active path. A Pi compaction summarizes the path from the previous kept boundary up
 * to its firstKeptEntryId, with the previous summary as context; a branch summary describes an abandoned branch, which is never
 * on the active path, so it and every compaction depending on it are gaps. Extension-provided (fromHook) summaries have no
 * provable closure. Trust assumption: /compact instructions and session_before_compact handlers that mutate the preparation
 * leave no trace in the entry, so a standard compaction is taken to summarize exactly its recorded span.
 */
function summaryVerdicts(ancestry) {
  const index = new Map(ancestry.map((row, position) => [row.id, position]));
  const verdicts = new Map();
  let previous = null;
  ancestry.forEach((row, position) => {
    if (row.type === 'branch_summary') verdicts.set(row.id, 'summary_source_off_branch');
    if (row.type !== 'compaction') return;
    const kept = typeof row.firstKeptEntryId === 'string' ? index.get(row.firstKeptEntryId) : undefined;
    let reason = null;
    // Pi treats any truthy fromHook as extension-provided; anything but absent or false is treated as unproved here.
    if ((row.fromHook !== undefined && row.fromHook !== false) || kept === undefined || kept >= position) reason = 'summary_closure_unproved';
    else {
      let start = 0;
      if (previous) {
        const at = index.get(previous.id), previousKept = index.get(previous.firstKeptEntryId);
        start = previousKept !== undefined && previousKept < at ? previousKept : at + 1;
        if (verdicts.get(previous.id)) reason = 'summary_dependency_inadmissible';
      }
      if (ancestry.slice(start, kept).some(dependency => verdicts.get(dependency.id))) reason = 'summary_dependency_inadmissible';
    }
    verdicts.set(row.id, reason);
    previous = row;
  });
  return verdicts;
}

function turnAt(entries, through, cursor, conversation, { allowInterrupted = false, summaryPolicy } = {}) {
  if (summaryPolicy !== undefined && summaryPolicy !== 'dependency_closure') throw fail('invalid_input');
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
    if (!summaryPolicy && SUMMARY_TYPES.has(row.type)) throw fail('source_boundary_unresolved');
    ancestry.unshift(row);
  }
  const verdicts = summaryPolicy ? summaryVerdicts(ancestry) : null;
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
  const omissions = { custom_message: { count: omitted.length, entry_ids: omitted } };
  if (!verdicts) return { turn, images, omissions };
  // Summaries are derived, never source; an inadmissible one is an explicit gap and is withheld from the distiller's context.
  const summaries = chain.filter(row => SUMMARY_TYPES.has(row.type)).map(row => ({ entry_id: row.id, type: row.type,
    disposition: verdicts.get(row.id) ? 'gap' : 'admissible', reason: verdicts.get(row.id) ?? null }));
  if (summaries.length) omissions.summaries = summaries;
  const excludedSummaryIds = [...verdicts].filter(([, reason]) => reason).map(([id]) => id);
  return { turn, images, omissions, excludedSummaryIds };
}

/** Pure check of one cursor interval; it throws the same codes distillThrough would before any side effect. */
export function sourceInterval(entries, throughEntryId, cursor, conversation, options = {}) {
  return turnAt(entries, throughEntryId, cursor, conversation, options);
}

/** The same cursor-bounded source turn is retained before either live or replay distillation. */
export async function distillThrough(session, throughEntryId, cursor, { allowInterrupted = false, summaryPolicy } = {}) {
  if (!session || !Array.isArray(session.scopes) || session.scopes.length !== 1
    || typeof session.scopes[0] !== 'string' || !session.scopes[0]) throw fail('scope_unresolved');
  if (!session.memory || typeof session.memory.ingest !== 'function' || !session.distiller || typeof session.distiller.run !== 'function') throw fail('invalid_input');
  const { turn, images, omissions, excludedSummaryIds } = turnAt(session.entries, throughEntryId, cursor, session.conversation_id, { allowInterrupted, summaryPolicy });
  if (images.length && typeof session.imageArchive?.archive !== 'function') throw fail('image_archive_required');
  if (images.length) {
    const archived = images.map(image => ({ entry_id: image.entry_id, ...session.imageArchive.archive(image.block) }));
    omissions.images = { count: archived.length, disposition: 'archived_not_text_citable', items: archived };
  }
  const receipt = await session.memory.ingest(session.scopes[0], turn);
  if (typeof receipt?.id !== 'string' || !receipt.id) throw fail('ingest_receipt_invalid');
  if (typeof session.ensureIndexed === 'function') await session.ensureIndexed(session.memory, session.scopes[0], receipt.indexing, { turnId: receipt.id });
  const result = await session.distiller.run({ turn, receipt, throughEntryId, cursor, scope: session.scopes[0],
    ...(excludedSummaryIds ? { excludedSummaryIds } : {}) });
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
export const RETRIEVAL_MODES = ['search', 'oracle-catalog'];
/** Diagnostic D0: 'oracle-catalog' replaces ranked search with every prior record in scope; it is not a product mode. */
const SEARCH_SHAPE = { search: { channels: ['turn_lexical', 'record_lexical', 'chunk_lexical', 'chunk_vector', 'record_vector'], seeds: 48, pool: 64, bytes: 24000 },
  'oracle-catalog': { channels: ['catalog'], seeds: 256, pool: 256, bytes: 120000 } };
export function createTurnTools({ scope, turn, receipt, memory, sourceChunks = [], requireSearch = false, ensureIndexed, reviewer, reviewMode = 'separate', retrieval = 'search' }) {
  if (!RETRIEVAL_MODES.includes(retrieval)) throw fail('invalid_input');
  const shape = SEARCH_SHAPE[retrieval];
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
  const returnedPriorIds = new Set(), fetchedIds = new Set(), linkCandidateIds = new Set();
  const compactHandles = new Map();
  let fetches = 0;
  let offer = null;
  let offerHandles = null;
  let choices = null;
  let choiceCount = 0;
  return {
    labels() { return [...labels].map(([ref, span]) => ({ ref, role: span.entry.role, text: span.entry.text.slice(span.start, span.end) })); },
    imageNotes() { return structuredClone(imageNotes); },
    async record(kind, text, refs, options = {}) {
      if (requireSearch && (!searches || searchFailed)) throw fail('search_required');
      const record = buildRecord(kind, text, refs);
      if (offer) {
        try { if (typeof memory.cancelLinks === 'function') await memory.cancelLinks(offer.token); }
        catch (problem) { searchFailed = true; throw problem; }
        finally { offer = null; offerHandles = null; choices = null; choiceCount = 0; }
      }
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
      offerHandles = null;
      choices = null;
      choiceCount = 0;
      return { id: record.id, status: 'proposed' };
    },
    async search(query, kinds) {
      if (typeof query !== 'string' || !query || !Array.isArray(kinds) || kinds.some(kind => typeof kind !== 'string')) throw fail('invalid_input');
      try {
        if (typeof memory.searchCompact !== 'function') throw fail('search_unavailable');
        const envelope = await memory.searchCompact(scope, { query, kinds, limit: 48, max_bytes: shape.bytes, ...(retrieval === 'oracle-catalog' ? { catalog: true } : {}) }, receipt.id);
        const result = envelope?.surface, bindings = envelope?.bindings;
        if (!Array.isArray(bindings) || !Array.isArray(result?.records) || bindings.length !== result.records.length
          || new Set(bindings.map(row => row?.handle)).size !== bindings.length || new Set(bindings.map(row => row?.id)).size !== bindings.length
          || bindings.some((row, index) => typeof row?.id !== 'string' || !row.id || typeof row.handle !== 'string'
            || row.handle !== result.records[index]?.id || (compactHandles.has(row.handle) && compactHandles.get(row.handle) !== row.id))) throw fail('search_incomplete');
        const requiredChannels = shape.channels;
        if (!['ready', 'no_matches', 'budget_limited'].includes(result?.status) || !Array.isArray(result.records)
          || result.records.length > 256 || !Array.isArray(result.relations) || result.relations.length > 512 || !result.channels
          || requiredChannels.some(name => result.channels[name]?.status !== 'ready')
          || Object.values(result.channels).some(row => ['partial', 'pending', 'unavailable'].includes(row.status))
          || result.completeness_guaranteed !== false || !Array.isArray(result.graph_gaps)
          || new Set(result.graph_gaps).size !== result.graph_gaps.length
          || result.graph_gaps.some(gap => !['node_limit', 'edge_limit', 'hop_limit', 'summary_node_limit', 'summary_edge_limit'].includes(gap))
          || result.declared_seed_limit !== shape.seeds || result.candidate_pool_limit !== shape.pool
          || !Number.isSafeInteger(result.seed_count) || result.seed_count < 0 || result.seed_count > shape.seeds
          || !Number.isSafeInteger(result.graph_edge_count) || result.graph_edge_count !== result.relations.length + result.edge_budget_omitted
          || !Number.isSafeInteger(result.collapsed_edge_count) || result.collapsed_edge_count < 0
          || typeof result.relationship_context_complete !== 'boolean' || !Number.isSafeInteger(result.ranked_count)
          || !Number.isSafeInteger(result.budget_omitted) || result.budget_omitted < 0
          || !Number.isSafeInteger(result.edge_budget_omitted) || result.edge_budget_omitted < 0
          || result.ranked_count !== result.records.length + result.budget_omitted
          || result.relationship_context_complete !== (!result.graph_gaps.length && !result.budget_omitted && !result.edge_budget_omitted)
          || (result.status === 'budget_limited') !== (result.budget_omitted > 0 || result.edge_budget_omitted > 0)
          || (result.status === 'ready' && !result.records.length)
          || (result.status === 'no_matches' && result.ranked_count !== 0)) throw fail('search_incomplete');
        if (new Set(result.records.map(row => row.id)).size !== result.records.length
          || result.records.some(row => typeof row.id !== 'string' || !row.id
            || typeof row.kind !== 'string' || typeof row.text !== 'string' || typeof row.text_truncated !== 'boolean'
            || (row.score !== null && (typeof row.score !== 'number' || !Number.isFinite(row.score))))) throw fail('search_incomplete');
        if (result.relations.some(row => !Array.isArray(row?.endpoints) || row.endpoints.length !== 2
          || row.endpoints.some(index => !Number.isSafeInteger(index) || index < 0 || index >= result.records.length)
          || row.endpoints[0] === row.endpoints[1])) throw fail('search_incomplete');
        if (!result.relationship_context_complete) incompleteSearch = true;
        searches++;
        searchStatuses.push({ surface: 'compact-records', status: result.status, budget_omitted: result.budget_omitted,
          edge_budget_omitted: result.edge_budget_omitted, graph_gaps: [...result.graph_gaps],
          relationship_context_complete: result.relationship_context_complete, declared_seed_limit: result.declared_seed_limit,
          candidate_pool_limit: result.candidate_pool_limit,
          filtered_record_count: result.filtered_record_count, related_kind_count: result.related_kind_count,
          collapsed_edge_count: result.collapsed_edge_count, previewed_ids: bindings.map(row => row.id), channels: structuredClone(result.channels) });
        for (const [index, row] of result.records.entries()) {
          compactHandles.set(row.id, bindings[index].id);
          returnedPriorIds.add(bindings[index].id);
          if (typeof row.action_handle === 'string' && row.action_handle) actionHandles.add(row.action_handle);
        }
        return result;
      } catch (problem) { searchFailed = true; throw problem; }
    },
    async fetch(handle) {
      if (!compactHandles.has(handle) || typeof memory.fetchCompact !== 'function') throw fail('handle_not_offered');
      if (++fetches > 32) {
        incompleteSearch = true;
        searchStatuses.push({ surface: 'selected-record', status: 'fetch_limit' });
        throw fail('fetch_limit');
      }
      try {
        const result = await memory.fetchCompact(scope, receipt.id, handle);
        if (result?.record?.id !== compactHandles.get(handle) || !Array.isArray(result.relations)
          || !Array.isArray(result.evidence) || !result.evidence.length
          || result.evidence.some(row => typeof row?.role !== 'string' || typeof row.text !== 'string' || !row.text)
          || typeof result.immediate_relations_complete !== 'boolean') throw fail('search_incomplete');
        if (!result.immediate_relations_complete) incompleteSearch = true;
        for (const edge of result.relations) {
          if (!RELATIONS.includes(edge.type) || typeof edge.from_id !== 'string' || typeof edge.to_id !== 'string'
            || typeof edge.from_handle !== 'string' || typeof edge.to_handle !== 'string' || edge.from_id === edge.to_id
            || (edge.from_id !== result.record.id && edge.to_id !== result.record.id)
            || (edge.from_id === result.record.id && edge.from_handle !== handle)
            || (edge.to_id === result.record.id && edge.to_handle !== handle)
            || (compactHandles.has(edge.from_handle) && compactHandles.get(edge.from_handle) !== edge.from_id)
            || (compactHandles.has(edge.to_handle) && compactHandles.get(edge.to_handle) !== edge.to_id)) throw fail('search_incomplete');
          compactHandles.set(edge.from_handle, edge.from_id); compactHandles.set(edge.to_handle, edge.to_id);
        }
        fetchedIds.add(result.record.id);
        searchStatuses.push({ surface: 'selected-record', id: result.record.id,
          immediate_relations_complete: result.immediate_relations_complete, relationship_omitted_at_least: result.relationship_omitted_at_least ?? null });
        const pairs = new Map();
        for (const edge of result.relations) {
          const endpoints = [edge.from_handle, edge.to_handle].sort();
          pairs.set(JSON.stringify(endpoints), { endpoints });
        }
        return { kind: 'record', record: { id: handle, kind: result.record.kind, text: result.record.text },
          evidence: result.evidence.map(row => ({ role: row.role, text: row.text })), relations: [...pairs.values()],
          collapsed_relation_count: result.relations.length - pairs.size, immediate_relations_complete: result.immediate_relations_complete,
          relationship_omitted_at_least: result.relationship_omitted_at_least };
      } catch (problem) {
        if (problem?.code === 'fetch_budget_exceeded') {
          incompleteSearch = true;
          searchStatuses.push({ surface: 'selected-record', status: 'fetch_budget_exceeded' });
        } else searchFailed = true;
        throw problem;
      }
    },
    async offer(handles = []) {
      if (!recordIds.length || typeof memory.beginLinks !== 'function') throw fail('offer_unavailable');
      if (!Array.isArray(handles) || handles.length > 32 || new Set(handles).size !== handles.length
        || handles.some(handle => !compactHandles.has(handle))) throw fail('handle_not_offered');
      if (offer && JSON.stringify(offerHandles) === JSON.stringify(handles)) return { token: offer.token, packet: offer.packet };
      if (offer && choiceCount) throw fail('offer_in_use');
      if (offer) {
        try { if (typeof memory.cancelLinks === 'function') await memory.cancelLinks(offer.token); }
        catch (problem) { incompleteSearch = true; throw problem; }
        finally { offer = null; offerHandles = null; choices = null; choiceCount = 0; }
      }
      let result;
      try { result = await memory.beginLinks(scope, receipt.id, [...recordIds], { candidateHandles: handles }); }
      catch (problem) { incompleteSearch = true; throw problem; }
      if (!result?.token || !result.packet) { incompleteSearch = true; throw fail('offer_invalid'); }
      const retrieval = result.packet.retrieval ?? null;
      if (retrieval?.status !== 'selected' || retrieval?.relationship_context_complete !== false || retrieval?.completeness_guaranteed !== false
        || !Number.isSafeInteger(retrieval?.omitted_prior_records) || !Number.isSafeInteger(retrieval?.omitted_prior_spans)
        || !Array.isArray(retrieval?.trigger_omissions) || retrieval.omitted_prior_records > 0 || retrieval.omitted_prior_spans > 0) incompleteSearch = true;
      // Evidence cited by new records must fit, and omitted prior memory stays fail-closed. Uncited spans of the
      // current turn are optional context the distiller already read, so their omission is disclosed, not a retrieval gap.
      searchStatuses.push({ surface: 'selected-link-offer', status: retrieval?.status ?? 'offer',
        budget_omitted: retrieval?.budget_omitted ?? 0, omitted_prior_records: retrieval?.omitted_prior_records ?? 0,
        trigger_omitted: retrieval?.trigger_omissions?.length ?? 0,
        trigger_context_omitted: retrieval?.trigger_omissions?.filter(row => row.reason === 'packet_budget').length ?? 0, candidate_ids: handles.map(handle => compactHandles.get(handle)) });
      for (const handle of handles) linkCandidateIds.add(compactHandles.get(handle));
      offer = result;
      offerHandles = [...handles];
      choices = createLinkChoices(result.packet);
      return { token: offer.token, packet: offer.packet };
    },
    link(choice) {
      if (!choices) throw fail('offer_unavailable');
      choices.add(choice);
      choiceCount++;
      return { status: 'pending_review' };
    },
    pendingLinks() { return offer && choices && choiceCount ? { token: offer.token, output: choices.output() } : null; },
    async release() {
      try { if (offer && typeof memory.cancelLinks === 'function') await memory.cancelLinks(offer.token); }
      finally { if (typeof memory.releaseCompact === 'function') await memory.releaseCompact(scope, receipt.id); }
    },
    stats() { return { records: recordIds.length, searches, search_failed: searchFailed,
      incomplete_search: incompleteSearch, search_statuses: structuredClone(searchStatuses), returned_prior_ids: [...returnedPriorIds],
      fetched_ids: [...fetchedIds], link_candidate_ids: [...linkCandidateIds] }; },
  };
}
