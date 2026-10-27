import { authorize, integer, MemoryError, requireThat } from './core.mjs';

// This module takes a store from its caller and imports nothing that can reach an embedding or reranking endpoint.

export const WARM_RUN_CEILING_MS = 20000;
// Fixed and neutral: the warm run carries no memory text. Its query terms are only looked up in the index.
export const WARM_QUERY = 'source memory warm';
// One fixed pair that matches no stored conversation; it makes the non-empty `$exclude` query shape run.
export const WARM_EXCLUDE_SAMPLE = Object.freeze([Object.freeze({ source: 'source-memory-warm', conversation_id: 'absent' })]);

// WARM_FRESHNESS_WINDOW_MS (how long a ready result may be trusted) is deliberately NOT defined here. The caller owns
// freshness policy, and its value is set from idle measurements that are still pending. A Neo4j restart makes the
// server cold again whatever the window, so the caller must warm again after any restart.

const WARM_ABSENT_ID = 'source-memory-warm-absent';
const WARM_CANDIDATES = 8;
const WARM_PER_CONVERSATION = 2;
const KINDS = ['turn', 'record', 'chunk'];

const elapsed = started => Math.round(performance.now() - started);
const reasonOf = error => error instanceof MemoryError ? error.code : 'database_unavailable';
const validStatus = value => Boolean(value) && typeof value.status === 'string';
const validAdmitted = value => Boolean(value) && Array.isArray(value.hits) && Array.isArray(value.omitted);

async function step(record, name, read, valid) {
  const started = performance.now();
  const result = await read();
  requireThat(valid(result), 'malformed_reply');
  record.steps[name] = elapsed(started);
  return result;
}

async function conclude(record, started, work) {
  try {
    await work();
    record.status = 'ready';
  } catch (error) {
    record.status = 'unavailable';
    record.reason = reasonOf(error);
  }
  record.ms = elapsed(started);
}

// The same store methods and argument shapes recall uses, so the server sees the same query texts.
function warmKind(store, scope, kind, record) {
  return conclude(record, performance.now(), async () => {
    const state = await step(record, 'status', () => store.lexicalStatus(scope, kind), validStatus);
    requireThat(state.status === 'ready', 'index_not_ready');
    if (kind === 'chunk') {
      const chunkState = await step(record, 'chunk_status', () => store.chunkLexicalStatus(scope), validStatus);
      requireThat(chunkState.status === 'ready', 'index_not_ready');
    }
    for (const [label, exclude] of [['empty', []], ['sample', WARM_EXCLUDE_SAMPLE]]) {
      await step(record, `lexical_${label}`, () => kind === 'chunk'
        ? store.chunkLexical(scope, WARM_QUERY, WARM_CANDIDATES, exclude)
        : store.lexical(scope, kind, WARM_QUERY, WARM_CANDIDATES, exclude), Array.isArray);
    }
    for (const [label, exclude] of [['empty', []], ['sample', WARM_EXCLUDE_SAMPLE]]) {
      await step(record, `grouped_${label}`, () => store.admittedLexical(scope, kind, WARM_QUERY, WARM_CANDIDATES,
        WARM_PER_CONVERSATION, exclude), validAdmitted);
    }
  });
}

// The reads a bundle makes for a seed, against an id that names nothing, so no stored text is returned.
function warmBundle(store, scope, record) {
  return conclude(record, performance.now(), () => Promise.all([
    step(record, 'turn', () => store.getTurn(scope, WARM_ABSENT_ID), value => value === null),
    step(record, 'records_for_turn', () => store.recordsForTurn(scope, WARM_ABSENT_ID, 1), Array.isArray),
    step(record, 'neighbors', () => store.neighbors(scope, [WARM_ABSENT_ID], 1), Array.isArray),
    step(record, 'record', () => store.getRecord(scope, WARM_ABSENT_ID), value => value === null),
  ]));
}

/**
 * Runs the recall-shaped read paths once against `store` and reports whether the server answered them all inside the
 * ceiling. Read-only, no model call. Any failure, timeout, unready index or malformed answer is 'unavailable', never
 * 'ready'. 'warming' is the caller's own state while a run is in flight and is never returned. The ceiling abandons
 * slow reads rather than cancelling them: the caller closes the store, and the server ends them at its own
 * transaction timeout.
 */
export async function warmDb(config, scope, store, { ceilingMs = WARM_RUN_CEILING_MS } = {}) {
  authorize(config, scope, 'read');
  integer(ceilingMs, undefined, 1, 600000);
  const started = performance.now();
  const channels = Object.fromEntries(KINDS.map(kind => [kind, { steps: {} }]));
  const bundle = { steps: {} };
  const work = Promise.all([...KINDS.map(kind => warmKind(store, scope, kind, channels[kind])),
    warmBundle(store, scope, bundle)]).then(() => 'done');
  let timer;
  const outcome = await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, ceilingMs, 'ceiling'); })])
    .finally(() => clearTimeout(timer));
  const ms = elapsed(started);
  const records = [...KINDS.map(kind => channels[kind]), bundle];
  if (outcome === 'ceiling') {
    for (const record of records) if (record.status === undefined) Object.assign(record, { status: 'unavailable', reason: 'ceiling' });
  }
  const failed = records.find(record => record.status !== 'ready');
  const reason = outcome === 'ceiling' ? 'ceiling' : failed?.reason;
  // Reads still in flight after the ceiling write to the originals, so the reply is a snapshot.
  return structuredClone({ warm: { db: { status: reason === undefined ? 'ready' : 'unavailable',
    ...(reason === undefined ? {} : { reason }), ms, ceiling_ms: ceilingMs, channels, bundle } } });
}
