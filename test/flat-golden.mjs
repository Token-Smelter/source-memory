import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { identity } from '../src/core.mjs';
import { embeddingIdentity } from '../src/models.mjs';

/**
 * Flat-scope reads on a fixed fictional corpus, for pinning that nested scopes leave flat reads byte-identical. Only the
 * Memory API that predates nested scopes is used, so a Memory class from an older commit can write and read the same corpus.
 */
export const FLAT_GOLDEN_SCOPE = 'golden';

const WORDS = ['lighthouse', 'harbor', 'lantern', 'ferry', 'tide', 'beacon', 'fog', 'keeper'];
function embedding(text) {
  const lower = text.toLowerCase();
  const vector = WORDS.slice(0, 4).map((word, index) => (lower.includes(word) ? 1 : 0) + (lower.includes(WORDS[index + 4]) ? 0.5 : 0));
  return vector.some(Boolean) ? vector : [0.1, 0.1, 0.1, 0.1];
}

const conversations = [
  ['north', [
    ['n1', 'The keeper wants the lighthouse lantern painted teal before the ferry season.'],
    ['n2', 'Use teal for the lantern housing; the harbor board approved it.'],
    ['n3', 'Fog delayed the ferry, so the lantern work moved to Thursday.'],
  ]],
  ['south', [
    ['s1', 'The harbor beacon flickers whenever the tide turns.'],
    ['s2', 'Replace the beacon bulb and log the tide tables for the keeper.'],
  ]],
  ['east', [
    ['e1', 'Ferry timetable: first crossing at dawn, last before the fog bank.'],
    ['e2', 'The lighthouse keeper changed the lantern colour from teal to amber after the fog trial.'],
  ]],
];
const text = Object.fromEntries(conversations.flatMap(([, turns]) => turns));
const rerankKey = value => value.replace(/^\[user\] /u, '').split('\n')[0].replace(/^Noted: /u, '');

const turnInput = (conversation, [id, body], parent) => ({ source: 'golden-fixture', conversation_id: conversation, turn_id: id,
  ...(parent ? { parent_turn_id: parent } : { lineage_root: true }), occurred_at: '2026-01-02T03:04:05Z',
  entries: [{ id: `${id}-u`, role: 'user', text: body }, { id: `${id}-a`, role: 'assistant', text: `Noted: ${body}` }] });

/** Deterministic embedding and rerank endpoints and a configuration granting `scopes` (default: the golden scope). */
export async function goldenFixtures(database, scopes = [FLAT_GOLDEN_SCOPE]) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const input = JSON.parse(body);
    if (req.url === '/embed') res.end(JSON.stringify({ model: input.model, data: input.input.map((value, index) => ({ index, embedding: embedding(value) })) }));
    // Fusion keeps the text of whichever channel finished first, so one turn reaches the reranker as its whole-turn text or
    // as one entry's chunk, at the base commit too. Scoring the entry sentence they share keeps the fixture's order stable.
    else res.end(JSON.stringify({ results: input.documents.map((value, index) => ({ index,
      relevance_score: parseInt(createHash('sha256').update(rerankKey(value)).digest('hex').slice(0, 8), 16) / 2 ** 32 })) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const config = { neo4j: database, scopes: { read: scopes, write: scopes },
    embedding: { url: `${url}/embed`, model: 'golden-fixture', dimensions: 4 }, reranker: { url: `${url}/rerank`, model: 'golden-fixture' } };
  return { config, close: () => new Promise(resolve => server.close(resolve)) };
}

const RECORD_IDS = ['teal', 'delay', 'bulb', 'amber'];
const RELATION_IDS = ['amber-over-teal', 'delay-depends'];

/** Every identity the corpus creates in `scope`, in a fixed order, for comparing stored nodes across scopes. */
export function goldenIdentities(scope) {
  const turns = conversations.flatMap(([conversation, turns]) => turns.map(([id]) => identity('turn', scope, 'golden-fixture', conversation, id)));
  return [...turns, ...turns.flatMap(uid => [0, 1, 2, 3].map(ordinal => identity('chunk', scope, uid, ordinal))),
    ...RECORD_IDS.map(id => identity('record', scope, id)), ...RELATION_IDS.map(id => identity('relation', scope, id))];
}

/** Idempotent: a replay writes nothing new. */
export async function writeGoldenCorpus(memory, scope = FLAT_GOLDEN_SCOPE) {
  await memory.init(scope);
  const ids = {};
  for (const [conversation, turns] of conversations) {
    let parent = null;
    for (const turn of turns) {
      ids[turn[0]] = (await memory.ingest(scope, turnInput(conversation, turn, parent))).id;
      parent = turn[0];
    }
  }
  const span = turn => [{ turn: ids[turn], entry_id: `${turn}-u`, start: 0, end: text[turn].length }];
  await memory.enrich(scope, { records: [
    { id: 'teal', kind: 'decision', status: 'accepted', text: 'Paint the lighthouse lantern housing teal.', attribution: 'harbor board', evidence: span('n2') },
    { id: 'delay', kind: 'observation', text: 'Fog delayed the ferry and the lantern work.', attribution: 'keeper', evidence: span('n3') },
    { id: 'bulb', kind: 'action', text: 'Replace the harbor beacon bulb.', attribution: 'keeper', evidence: span('s2') },
    { id: 'amber', kind: 'decision', text: 'Change the lantern colour to amber.', attribution: 'keeper', evidence: span('e2') },
  ], relations: [
    { id: 'amber-over-teal', type: 'supersedes', from: 'amber', to: 'teal', attribution: 'keeper', evidence: span('e2') },
    { id: 'delay-depends', type: 'depends_on', from: 'delay', to: 'teal', attribution: 'keeper', evidence: span('n3') },
  ] });
}

/** Every flat read the corpus is pinned with, serialized once; the fixture's ephemeral URL and the store id are normalized. */
export async function readGoldenCorpus(memory, config) {
  const scope = FLAT_GOLDEN_SCOPE;
  let ready = false;
  for (let attempt = 0; attempt < 2400 && !ready; attempt += 1) {
    const status = await memory.status(scope);
    ready = status.unindexed === 0 && Object.values(status.vector_indexes).every(state => state === 'online');
    if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!ready) throw new Error('golden scope never became ready; refusing to pin a partial read');
  const north = (await memory.show(scope, { kind: 'turn_by_key', source: 'golden-fixture', conversation_id: 'north', turn_ids: ['n2'] })).found[0].id;
  const replies = [];
  for (const input of [
    { query: 'lantern colour teal' },
    { query: 'harbor beacon tide', limit: 4, candidates: 8 },
    { query: 'ferry fog keeper', mode: 'evidence_advice', group: 'conversation', follow: {} },
    { query: 'lighthouse lantern', mode: 'history_search', group: 'conversation', per_conversation: 1,
      exclude_conversations: [{ source: 'golden-fixture', conversation_id: 'south' }] },
  ]) replies.push(await memory.recall(scope, input));
  replies.push(await memory.recall(scope, { query: 'lantern teal amber' }, { seedsOnly: true }));
  replies.push(await memory.show(scope, { kind: 'record', id: 'teal' }));
  replies.push(await memory.show(scope, { kind: 'bundle', seed: { kind: 'record', id: 'teal' } }));
  replies.push(await memory.show(scope, { kind: 'units', follow: {}, units: [{ key: { scope, source: 'golden-fixture', conversation_id: 'north' },
    seeds: [{ kind: 'turn', id: north }, { kind: 'record', id: 'delay' }, { kind: 'record', id: 'missing' }] }] }));
  const { store: { database_id: _id, ...store }, ...status } = await memory.status(scope);
  replies.push({ ...status, store });
  const bytes = JSON.stringify(canonicalRun(replies)).replaceAll(embeddingIdentity(config.embedding), '<embedding_key>');
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Recall runs its lexical channels concurrently and fuses them in completion order, at the base commit too. In the
 * ranking-only reply that order shows as the channel-key order, each item's trace order, and the text, match and
 * conversation fields an item keeps from whichever channel found it first. Only those are normalized: keys and traces
 * sorted by name, first-channel fields dropped. Fused scores are exact (at most two lexical terms per item), so they are not.
 */
export function canonicalRun(replies) {
  return replies.map(reply => !reply.ranked ? reply : { ...reply,
    channels: Object.fromEntries(Object.entries(reply.channels).sort(([a], [b]) => a.localeCompare(b))),
    ranked: reply.ranked.map(({ text: _text, match: _match, conversation: _conversation, ...item }) =>
      ({ ...item, channels: [...item.channels].sort((a, b) => a.channel.localeCompare(b.channel)) })) });
}

// `node test/flat-golden.mjs <bolt uri> [out.json]` writes and reads the corpus with this checkout's Memory.
if (process.argv[1]?.endsWith('flat-golden.mjs') && process.argv[2]) {
  const { Memory } = await import('../src/memory.mjs');
  const fixtures = await goldenFixtures({ uri: process.argv[2], auth: 'none', database: 'neo4j' });
  const memory = new Memory(fixtures.config);
  try {
    await writeGoldenCorpus(memory);
    const result = await readGoldenCorpus(memory, fixtures.config);
    console.log(result.sha256);
    if (process.argv[3]) (await import('node:fs')).writeFileSync(process.argv[3], result.bytes);
  } finally { await memory.close(); await fixtures.close(); }
}
