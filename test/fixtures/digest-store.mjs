import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * An in-memory store double over one fictional flat scope, and the battery of recall, show, list and status calls whose
 * replies without `digests` are pinned in digest-baseline.json. Store calls are logged with functions removed. A trailing
 * `{digests: true}` option is honoured as the real store honours it, so the same double drives the opted-in tests.
 */
export const SCOPE = 'fiction';
const KEY = { scope: SCOPE, source: 'harbor', conversation_id: 'c1' };
const turn = (uid, turnId, parent, text) => ({ id: uid, scope: SCOPE, source: 'harbor', conversation_id: 'c1', turn_id: turnId,
  parent_turn_id: parent, occurred_at: '2026-03-04T05:06:07Z', entries: [{ id: `${turnId}-u`, role: 'user', text, occurred_at: null }] });
const TURNS = {
  t1: turn('t1', 'x1', null, 'The keeper wants the lighthouse lantern painted teal.'),
  t2: turn('t2', 'x2', 'x1', 'Fog changed the plan: paint the lantern amber instead.'),
};
const span = (uid, end) => ({ turn: uid, entry_id: `${TURNS[uid].turn_id}-u`, start: 0, end });
const record = (id, kind, text, evidence, hash) => ({ uid: `record_${id}`, id, kind, text, status: 'proposed', attribution: 'keeper', evidence, hash });
// r3 was written by another writer without a hash; r4 is too large for a 4 KiB list page on its own.
export const RECORDS = {
  r1: record('r1', 'decision', 'Paint the lantern teal.', [span('t1', 20)], 'a'.repeat(64)),
  r2: record('r2', 'decision', 'Paint the lantern amber.', [span('t2', 24)], 'b'.repeat(64)),
  r3: record('r3', 'observation', 'Fog delayed the lantern work.', [span('t2', 12)], undefined),
  r4: record('r4', 'episode', `Lantern log: ${'amber '.repeat(800)}`.trim(), [span('t1', 10)], 'd'.repeat(64)),
};
const RELATIONS = [{ uid: 'relation_e1', id: 'e1', type: 'supersedes', from: 'r2', to: 'r1', attribution: 'keeper', evidence: [span('t2', 24)] }];
const STORED = { t1: '2026-03-04T05:06:07.001Z', t2: '2026-03-04T05:06:07.002Z', r1: '2026-03-04T05:06:07.003Z',
  r2: '2026-03-04T05:06:07.004Z', r3: '2026-03-04T05:06:07.005Z', r4: '2026-03-04T05:06:07.006Z', e1: '2026-03-04T05:06:07.007Z' };

const body = ({ uid: _uid, hash: _hash, ...rest }) => rest;
const node = row => ({ uid: row.uid, scope: SCOPE, record_id: row.id, text: row.text, body: JSON.stringify(body(row)),
  ...(row.hash === undefined ? {} : { hash: row.hash }) });
const decoded = (row, options) => ({ uid: row.uid, scope: SCOPE, ...body(row),
  ...(options?.digests ? { record_digest: typeof row.hash === 'string' ? row.hash : null } : {}) });
const recordHit = (row, options, extra = {}) => ({ kind: 'record', id: row.id, text: row.text, ...extra,
  ...(options?.digests ? { record_digest: typeof row.hash === 'string' ? row.hash : null } : {}) });

// `missing: true` reports both vector indexes missing, so recall scores the scanned vectors itself (the fallback path).
export function digestStore(log = [], { missing = false } = {}) {
  const call = (name, impl) => async (...args) => {
    log.push([name, ...structuredClone(args.filter(arg => typeof arg !== 'function'))]);
    return impl(...args);
  };
  const listRow = (type, id) => type === 'turn'
    ? { uid: id, type, at: STORED[id], untimed: false, scope: SCOPE, header: null, entry_count: 1,
      properties: { source: 'harbor', conversation_id: 'c1', turn_id: TURNS[id].turn_id, parent_turn_id: TURNS[id].parent_turn_id } }
    : { uid: RECORDS[id].uid, type, at: STORED[id], untimed: false, scope: SCOPE, body: JSON.stringify(body(RECORDS[id])) };
  const order = [['record', 'r4'], ['record', 'r3'], ['record', 'r2'], ['record', 'r1'], ['turn', 't2'], ['turn', 't1']];
  return {
    identity: call('identity', () => ({ system: 'neo4j', database_id: 'db-fixture', database: 'neo4j' })),
    status: call('status', () => ({ turns: 2, chunks: 2, records: 4, relations: 1, unindexed: 0 })),
    vectorIndexStatus: call('vectorIndexStatus', () => missing ? 'missing' : 'online'),
    vectors: call('vectors', () => [{ ...node(RECORDS.r2), embedding: [1, 0] }, { ...node(RECORDS.r3), embedding: [0.6, 0.8] },
      { uid: 'chunk_t1', scope: SCOPE, turn_uid: 't1', entry_id: 'x1-u', start: 0, end: 20, text: 'The keeper wants the', embedding: [1, 0] }]),
    lexicalStatus: call('lexicalStatus', () => ({ status: 'ready' })),
    chunkLexicalStatus: call('chunkLexicalStatus', () => ({ status: 'ready' })),
    lexical: call('lexical', (_scope, kind, _query, _limit, _exclude, options) => kind === 'turn'
      ? [{ kind, id: 't1', text: TURNS.t1.entries[0].text }]
      : [recordHit(RECORDS.r1, options), recordHit(RECORDS.r3, options)]),
    chunkLexical: call('chunkLexical', () => [{ kind: 'turn', id: 't2', text: 'Fog changed the plan',
      match: { turn: 't2', entry_id: 'x2-u', start: 0, end: 20, role: 'user' }, conversation: KEY }]),
    admittedLexical: call('admittedLexical', (_scope, kind) => ({
      hits: kind === 'chunk' ? [] : kind === 'turn' ? [{ kind, id: 't1', text: TURNS.t1.entries[0].text, conversations: [{ key: KEY }] }]
        : [{ ...recordHit(RECORDS.r1), conversations: [{ key: KEY }] }],
      omitted: [], admitted_conversations: 1, exhausted: false })),
    vectorCounts: call('vectorCounts', () => ({ total: 3, unindexed: 0 })),
    indexedVectors: call('indexedVectors', (_scope, kind, _model, _vector, _limit, perConversation) => {
      const nodes = kind === 'record' ? [{ ...node(RECORDS.r2), similarity: 0.9 }, { ...node(RECORDS.r3), similarity: 0.8 }]
        : [{ uid: 'chunk_t1', scope: SCOPE, turn_uid: 't1', entry_id: 'x1-u', start: 0, end: 20, text: 'The keeper wants the', similarity: 0.7 }];
      if (perConversation === null) return { nodes, partial: false, unindexed: 0, ran: true };
      const hits = kind === 'record' ? [{ ...recordHit(RECORDS.r2), conversations: [{ key: KEY }] }]
        : [{ kind: 'turn', id: 't1', text: 'The keeper wants the', match: { turn: 't1', entry_id: 'x1-u', start: 0, end: 20, role: 'user' },
          conversations: [{ key: KEY }] }];
      return { hits, omitted: [], admitted_conversations: 1, exhausted: false, partial: false, unindexed: 0, ran: true };
    }),
    getTurn: call('getTurn', (_scope, uid) => structuredClone(TURNS[uid] ?? null)),
    getRecord: call('getRecord', (_scope, id, options) => RECORDS[id] ? decoded(RECORDS[id], options) : null),
    recordsForTurn: call('recordsForTurn', (_scope, uid, limit, options) => Object.values(RECORDS)
      .filter(row => row.evidence.some(item => item.turn === uid)).slice(0, limit).map(row => decoded(row, options))),
    neighbors: call('neighbors', (_scope, ids, limit) => RELATIONS
      .filter(edge => ids.includes(edge.from) || ids.includes(edge.to)).slice(0, limit).map(edge => structuredClone(edge))),
    childTurns: call('childTurns', (_scope, parent, limit) => Object.values(TURNS)
      .filter(row => row.parent_turn_id === parent.turn_id).slice(0, limit).map(row => structuredClone(row))),
    unlinkedTurns: call('unlinkedTurns', () => 0),
    listPage: call('listPage', (_target, { turns, records, kind, after, limit, digests }) => order
      .filter(([type, id]) => (type === 'turn' ? turns : records && (kind === null || RECORDS[id].kind === kind)))
      .filter(([, id]) => after === null || STORED[id] < after.at)
      .slice(0, limit).map(([type, id]) => ({ ...listRow(type, id),
        ...(digests && type === 'record' ? { hash: RECORDS[id].hash ?? null } : {}) }))),
    listRelations: call('listRelations', (_target, uids) => {
      const rows = RELATIONS.filter(edge => uids.includes(`record_${edge.from}`) || uids.includes(`record_${edge.to}`)).map(edge => ({ uid: edge.uid, scope: SCOPE, body: JSON.stringify(body(edge)), at: STORED[edge.id], untimed: false }));
      return { total: rows.length, rows };
    }),
    close: call('close', () => undefined),
  };
}

/** A loopback embedding endpoint returning one fixed vector; the embedding key it implies is normalized out of replies. */
export async function embeddingFixture() {
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const input = JSON.parse(text);
    res.end(JSON.stringify({ model: input.model, data: input.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { embedding: { url: `http://127.0.0.1:${server.address().port}/embed`, model: 'fixture', dimensions: 2 },
    close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}

const units = { units: [{ key: KEY, seeds: [{ kind: 'turn', id: 't1' }, { kind: 'record', id: 'r2' }, { kind: 'record', id: 'missing' }] }] };
/** Every call pinned, by name: [method, input, options?, store options?]. `extra` is merged into each input (for example digests). */
export const BATTERY = [
  ['recall', 'recall', { query: 'lantern teal' }],
  ['recall_limited', 'recall', { query: 'lantern teal', limit: 2, candidates: 4 }],
  ['recall_grouped', 'recall', { query: 'lantern', group: 'conversation', mode: 'evidence_advice', follow: {} }],
  ['recall_history', 'recall', { query: 'lantern', group: 'conversation', mode: 'history_search', per_conversation: 1 }],
  ['recall_seeds', 'recall', { query: 'lantern' }, { seedsOnly: true }],
  ['show_record', 'show', { kind: 'record', id: 'r1' }],
  ['show_record_unhashed', 'show', { kind: 'record', id: 'r3' }],
  ['show_bundle', 'show', { kind: 'bundle', seed: { kind: 'record', id: 'r2' } }],
  ['show_bundle_turn', 'show', { kind: 'bundle', seed: { kind: 'turn', id: 't2' }, max_nodes: 2 }],
  ['show_units', 'show', { kind: 'units', follow: {}, ...units }],
  ['show_following', 'show', { kind: 'following', turn: 't1' }],
  ['show_turn', 'show', { kind: 'turn', id: 't1' }],
  ['show_turn_by_key', 'show', { kind: 'turn_by_key', source: 'harbor', conversation_id: 'c1', turn_ids: ['x1', 'x9'] }],
  ['list', 'list', {}],
  ['list_relations', 'list', { relations: true }],
  ['list_page', 'list', { kind: 'decision', limit: 1 }],
  ['list_stub', 'list', { max_bytes: 4096 }],
  ['list_turns', 'list', { kind: 'turn' }],
  ['recall_fallback', 'recall', { query: 'lantern teal' }, null, { missing: true }],
  ['recall_seeds_fallback', 'recall', { query: 'lantern' }, { seedsOnly: true }, { missing: true }],
];

/** Runs the battery (or the calls named in `only`) against `scope` and returns {name: {reply, calls}}, the embedding key normalized. */
export async function runBattery(MemoryClass, extra = {}, scope = SCOPE, only = null) {
  const fixture = await embeddingFixture();
  const out = {};
  try {
    const config = { scopes: { read: [SCOPE], write: [] }, embedding: fixture.embedding };
    const { embeddingIdentity } = await import('../../src/models.mjs');
    const key = embeddingIdentity(fixture.embedding);
    for (const [name, method, input, options, storeOptions] of BATTERY.filter(([key]) => !only || only.includes(key))) {
      const log = [];
      const memory = new MemoryClass(config, digestStore(log, storeOptions));
      const reply = await memory[method](scope, { ...input, ...extra }, ...(options ? [options] : []));
      out[name] = { reply: JSON.stringify(reply).replaceAll(key, '<embedding_key>'), calls: JSON.stringify(log).replaceAll(key, '<embedding_key>') };
    }
  } finally { await fixture.close(); }
  return out;
}

// `node test/fixtures/digest-store.mjs <src/memory.mjs of a checkout> <out.json>` records that checkout's replies.
if (process.argv[1]?.endsWith('digest-store.mjs') && process.argv[3]) {
  const { Memory } = await import(pathToFileURL(process.argv[2]).href);
  writeFileSync(process.argv[3], `${JSON.stringify(await runBattery(Memory), null, 1)}\n`);
}
