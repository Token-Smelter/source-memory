import { digest } from '../src/core.mjs';
import { sourceInterval } from './core.mjs';
import { runCoveredInterval } from './coverage.mjs';
import { createSessionQueue, settledSnapshot } from './index.mjs';

const fail = code => Object.assign(new Error(code), { code });
const covered = new Set(['committed', 'abstained', 'ineligible_by_policy']);
const settledEffect = new Set(['confirmed', 'refused']);

function ancestryOf(entries, leafId) {
  const parents = new Map(entries.map(row => [row.id, row.parentId]));
  const order = new Map();
  for (let id = leafId, depth = 0; id && !order.has(id); id = parents.get(id), depth++) order.set(id, depth);
  return order;
}

/**
 * agent_settled hook for live controllers. The handler only snapshots and enqueues, and never throws into Pi;
 * the session file path is captured synchronously because ctx must not be used after the handler returns.
 */
export function registerLiveMemory(pi, { controllerFor, onResult = () => {}, onError = () => {} }) {
  if (!pi || typeof pi.on !== 'function' || typeof controllerFor !== 'function') throw fail('extension_invalid');
  const queue = createSessionQueue(onError);
  pi.on('agent_settled', (_event, ctx) => {
    try {
      const snapshot = settledSnapshot(ctx);
      if (!snapshot) return;
      snapshot.sessionFile = ctx.sessionManager.getSessionFile?.() ?? null;
      queue.push(snapshot.sessionId, async () => {
        const controller = await controllerFor(snapshot);
        if (!controller) return;
        onResult(await controller.settle(snapshot), snapshot);
      });
    } catch (error) { try { onError(error); } catch {} }
  });
  return { pending: queue.pending, drain: queue.drain };
}

/**
 * Live custody of one Pi session: the coverage journal is the authority for what was covered, the cursor file is a durable
 * pointer into it. A failed cursor save, a crash or a branch switch is resolved from the journal before the next interval,
 * so no source entry is ingested under two different turn IDs.
 */
export function createLiveController({ journal, cursorStore, conversationId, open, maxRetries = 3, gate = null }) {
  // Live sessions compact; summaries follow the frozen dependency-closure rule instead of blocking every later interval.
  const distillOptions = { summaryPolicy: 'dependency_closure' };
  if (!journal || !cursorStore || typeof open !== 'function' || typeof conversationId !== 'string' || !conversationId
    || !Number.isSafeInteger(maxRetries) || maxRetries < 0 || (gate !== null && typeof gate !== 'function')) throw fail('controller_invalid');
  let session = null;
  let busy = false;

  async function getSession() {
    session ??= await open();
    if (session.conversation_id !== conversationId) throw fail('session_identity_changed');
    return session;
  }
  async function dropSession() {
    const current = session;
    session = null;
    try { await current?.close?.(); } catch {}
  }

  /** Settle every unknown effect by its deterministic identity through a fresh Memory process, then reopen the interval. */
  async function reconcile() {
    const state = journal.state();
    if (state.status !== 'uncertain' && !state.reconciliation_required) return null;
    await dropSession();
    const present = [], absent = [];
    let replayedIngest = false;
    for (const effect of journal.effects()) {
      if (settledEffect.has(effect.state)) continue;
      if (effect.method === 'ingest') { replayedIngest = true; continue; }
      if (!['enrich', 'applyOutcome'].includes(effect.method) || !effect.ids?.length) throw fail('reconciliation_required');
      const fresh = await getSession();
      if (typeof fresh.memory.recordPresence !== 'function') throw fail('reconciliation_required');
      const found = await fresh.memory.recordPresence(fresh.scopes[0], effect.ids);
      if (!Array.isArray(found?.present) || !Array.isArray(found?.absent)
        || found.present.length + found.absent.length !== effect.ids.length) throw fail('reconciliation_required');
      // An outcome and its action land in one transaction; a split result is not a settled outcome.
      if (effect.method === 'applyOutcome' && found.present.length && found.absent.length) throw fail('reconciliation_required');
      present.push(...found.present);
      absent.push(...found.absent);
    }
    const evidence = { kind: 'live-reconcile/v1', ingest: replayedIngest ? 'idempotent_replay_by_turn_id' : 'confirmed_or_absent',
      present: present.sort(), absent: absent.sort() };
    journal.reconcile({ id: state.id, disposition: 'failed', evidenceRef: `${evidence.kind}:${digest(evidence)}` });
    return evidence;
  }

  /** The committed cursor for this leaf: the saved pointer, walked back off a foreign branch and forward over saved-but-unrecorded intervals. */
  function resolveCursor(order) {
    const intervals = journal.intervals();
    const saved = cursorStore.load()?.cursor ?? null;
    const known = cursor => cursor === null || intervals.some(row => row.through === cursor);
    let cursor = saved;
    if (!known(cursor)) throw fail('cursor_journal_mismatch');
    for (let guard = 0; cursor !== null && !order.has(cursor); guard++) {
      if (guard > intervals.length) throw fail('cursor_unresolved');
      cursor = intervals.find(row => row.through === cursor).cursor;
      if (!known(cursor)) throw fail('cursor_journal_mismatch');
    }
    for (let guard = 0; guard <= intervals.length; guard++) {
      const depth = cursor === null ? Infinity : order.get(cursor);
      const next = intervals.filter(row => row.cursor === cursor && order.has(row.through) && order.get(row.through) < depth)
        .sort((a, b) => order.get(a.through) - order.get(b.through))[0];
      if (!next) break;
      cursor = next.through;
    }
    return { cursor, saved };
  }

  function save(cursor, intervalId) {
    try { cursorStore.save(cursor, { intervalId }); return null; }
    catch (problem) { return problem.code ?? 'cursor_save_failed'; }
  }

  async function run(entries, through, cursor, retry) {
    // Admission precedes the journal begin and the Memory process, so a refusal leaves no row, no ingest and no spend.
    if (gate) {
      try { await gate({ through, cursor, retry }); }
      catch (problem) { return { refused: true, through, cursor, code: problem?.refused ? problem.code : 'gate_unavailable' }; }
    }
    const current = await getSession();
    const result = await runCoveredInterval({ journal, session: { ...current, entries }, through, cursor, retry, ...distillOptions });
    if (covered.has(result.disposition)) {
      const saveError = save(through, result.id);
      return saveError ? { ...result, cursor_save: saveError } : result;
    }
    if (result.disposition === 'uncertain') await dropSession();
    return result;
  }

  return {
    /** Process the source suffix through one settled leaf; returns a status object and never advances past an uncovered interval. */
    async settle({ leafId, entries }) {
      if (busy) throw fail('controller_busy');
      busy = true;
      try {
        const reconciled = await reconcile();
        const order = ancestryOf(entries, leafId);
        let { cursor, saved } = resolveCursor(order);
        const repaired = cursor !== saved ? save(cursor, null) : null;
        const results = [];
        const state = journal.state();
        if (['failed', 'unresolved_scope'].includes(state.status)) {
          if (journal.attempts(state.id) > maxRetries) return { status: 'blocked', code: 'retry_limit', id: state.id, cursor };
          try { if (state.cursor !== cursor) throw fail('cursor_unresolved'); sourceInterval(entries, state.through, state.cursor, conversationId, distillOptions); }
          catch { return { status: 'blocked', code: 'coverage_gap_unreachable', id: state.id, cursor }; }
          const retried = await run(entries, state.through, state.cursor, true);
          results.push(retried);
          if (!covered.has(retried.disposition)) return { status: retried.refused ? 'refused' : 'stopped', cursor, results, reconciled };
          cursor = state.through;
        }
        if (leafId === cursor) return { status: 'current', cursor, results, reconciled };
        try { sourceInterval(entries, leafId, cursor, conversationId, distillOptions); }
        catch (problem) { return { status: 'skipped', code: problem.code ?? 'source_invalid', cursor, results, reconciled }; }
        const result = await run(entries, leafId, cursor, false);
        results.push(result);
        return { status: covered.has(result.disposition) ? 'covered' : result.refused ? 'refused' : 'stopped', cursor: covered.has(result.disposition) ? leafId : cursor,
          results, reconciled, ...(repaired ? { cursor_repair: repaired } : {}) };
      } finally { busy = false; }
    },
    async close() { await dropSession(); },
  };
}
