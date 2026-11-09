import { dirname } from 'node:path';
import { canonical, digest } from '../src/core.mjs';
import { sourceInterval } from './core.mjs';
import { runCoveredInterval } from './coverage.mjs';
import { writeDurableFile } from './cursor-store.mjs';
import { createSessionQueue, settledSnapshot } from './index.mjs';

const fail = code => Object.assign(new Error(code), { code });
const covered = new Set(['committed', 'abstained', 'ineligible_by_policy']);
const settledEffect = new Set(['confirmed', 'refused']);
const safeCode = value => typeof value?.code === 'string' && /^[a-z_]{1,80}$/.test(value.code) ? value.code : 'gate_refused';

/** Explicit opt-out for replay and tests: admits every interval and is recorded as ungated. */
export const admitAll = Object.assign(async () => ({ admitted: true }), { ungated: true });

/** Active-branch entry IDs from the leaf to the root, in that order. */
function ancestryOf(entries, leafId) {
  const parents = new Map(entries.map(row => [row.id, row.parentId]));
  const path = [];
  const seen = new Set();
  for (let id = leafId; id && parents.has(id) && !seen.has(id); id = parents.get(id)) { seen.add(id); path.push(id); }
  return path;
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
      const snapshot = settledSnapshot(ctx, { throughSummaries: true });
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
 * Live custody of one Pi session. The coverage journal is the authority for what was covered; the cursor file is a durable
 * pointer that must agree with it. Each settle derives its cursor as the end of the covered prefix of the active branch,
 * so a failed cursor save, a crash, a fork inside a covered interval or a branch switch never ingests a covered entry again.
 */
export function createLiveController({ journal, cursorStore, conversationId, open, gate, maxRetries = 3 }) {
  if (!journal || !journal.options?.effectIds || !journal.options?.pidLock || !cursorStore || typeof open !== 'function' || typeof gate !== 'function'
    || typeof conversationId !== 'string' || !conversationId || !Number.isSafeInteger(maxRetries) || maxRetries < 0) throw fail('controller_invalid');
  // Live sessions compact; summaries follow the dependency-closure rule instead of blocking every later interval.
  const summaryPolicy = 'dependency_closure';
  let session = null;
  let busy = false;

  /** Only an explicit { admitted: true } admits; anything else, including a thrown error, is a refusal. */
  async function admit(request) {
    try {
      const decision = await gate(request);
      if (decision?.admitted === true) return null;
      return safeCode(decision);
    } catch (problem) { return problem?.refused ? safeCode(problem) : 'gate_unavailable'; }
  }

  async function getSession() {
    if (!session) {
      const opened = await open();
      // The admitted scope and budget must be the ones this session writes and spends through.
      if ((gate.scope !== undefined && opened?.scopes?.[0] !== gate.scope) || (gate.budget !== undefined && opened?.budget !== gate.budget)) {
        try { await opened?.close?.(); } catch {}
        throw fail('gate_binding_mismatch');
      }
      if (opened?.conversation_id !== conversationId) {
        try { await opened?.close?.(); } catch {}
        throw fail('session_identity_changed');
      }
      session = opened;
    }
    return session;
  }
  async function dropSession() {
    const current = session;
    session = null;
    try { await current?.close?.(); } catch {}
  }

  /**
   * Settle every effect of an uncertain or partially written interval by its deterministic identity, persist the evidence,
   * then reopen the interval for a retry under the same turn ID. Unknown effects are read through a newly opened Memory
   * session, because the session that issued them is closed first.
   */
  async function reconcile() {
    const state = journal.state();
    const partial = state.status === 'failed' && state.reconciliation_required;
    if (state.status !== 'uncertain' && !partial) return state.reconciliation_required ? { blocked: 'reconciliation_required' } : null;
    const effects = journal.effects();
    // Confirmed links cannot be deduplicated by a retry; a person decides.
    if (effects.some(effect => effect.method === 'applyLinks' && effect.state !== 'refused')) return { blocked: 'reconciliation_required' };
    await dropSession();
    const confirmed = [], present = [], absent = [];
    let replayedIngest = false;
    for (const effect of effects) {
      if (effect.state === 'confirmed') { confirmed.push({ method: effect.method, ids: effect.ids ?? [] }); continue; }
      if (settledEffect.has(effect.state)) continue;
      if (effect.method === 'ingest') { replayedIngest = true; continue; }
      if (!['enrich', 'applyOutcome'].includes(effect.method) || !effect.ids?.length) return { blocked: 'reconciliation_required' };
      const fresh = await getSession();
      if (typeof fresh.memory.recordPresence !== 'function') return { blocked: 'reconciliation_required' };
      const found = await fresh.memory.recordPresence(fresh.scopes[0], effect.ids);
      if (!Array.isArray(found?.present) || !Array.isArray(found?.absent)
        || found.present.length + found.absent.length !== effect.ids.length) return { blocked: 'reconciliation_required' };
      // An outcome and its action land in one transaction; a split result is not a settled outcome.
      if (effect.method === 'applyOutcome' && found.present.length && found.absent.length) return { blocked: 'reconciliation_required' };
      present.push(...found.present);
      absent.push(...found.absent);
    }
    const evidence = { kind: 'live-reconcile/v1', interval: state.id, cursor: state.cursor, through: state.through,
      ingest: replayedIngest ? 'idempotent_replay_by_turn_id' : 'confirmed', confirmed, present: present.sort(), absent: absent.sort() };
    const sha = digest(evidence);
    try { writeDurableFile(dirname(journal.path), `reconcile-${sha}.json`, Buffer.from(canonical(evidence))); }
    catch (problem) { if (problem.code !== 'EEXIST') throw problem; }
    journal.reconcile({ id: state.id, disposition: 'failed', evidenceRef: `${evidence.kind}:${sha}` });
    return evidence;
  }

  /** End of the covered prefix of this branch: every entry on a covered interval's chain counts, not only its endpoints. */
  function resolveCursor(entries, path) {
    const saved = cursorStore.load()?.cursor ?? null;
    const intervals = journal.intervals();
    if (saved !== null && !intervals.some(row => row.through === saved)) throw fail('cursor_journal_mismatch');
    const parents = new Map(entries.map(row => [row.id, row.parentId]));
    const coveredIds = new Set();
    for (const row of intervals) {
      const chain = [];
      let id = row.through;
      for (; id && id !== row.cursor && parents.has(id) && chain.length <= parents.size; id = parents.get(id)) chain.push(id);
      if ((id ?? null) === row.cursor) for (const entry of chain) coveredIds.add(entry);
    }
    let cursor = null;
    for (let index = path.length - 1; index >= 0 && coveredIds.has(path[index]); index--) cursor = path[index];
    return cursor;
  }

  function save(cursor, intervalId) {
    try { cursorStore.save(cursor, { intervalId }); return null; }
    catch (problem) { return problem.code ?? 'cursor_save_failed'; }
  }

  async function run(entries, through, cursor, retry) {
    // Admission precedes the journal begin and the Memory process, so a refusal leaves no row, no ingest and no spend.
    const refusal = await admit({ phase: 'interval', through, cursor, retry });
    if (refusal) return { refused: true, through, cursor, code: refusal };
    const current = await getSession();
    const result = await runCoveredInterval({ journal, session: { ...current, entries }, through, cursor, retry, summaryPolicy });
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
      const results = [];
      let reconciled = null;
      try {
        if (!Array.isArray(entries) || !entries.some(row => row?.id === leafId)) return { status: 'skipped', code: 'source_unavailable', results, reconciled };
        const pending = journal.state();
        if (pending.status === 'uncertain' || pending.reconciliation_required) {
          // Reconciliation reads Memory, so the scope grants are checked first; it spends no model budget.
          const refusal = await admit({ phase: 'reconcile', id: pending.id });
          if (refusal) return { status: 'refused', code: refusal, results, reconciled };
        }
        reconciled = await reconcile();
        if (reconciled?.blocked) return { status: 'blocked', code: reconciled.blocked, id: journal.state().id, results, reconciled };
        const path = ancestryOf(entries, leafId);
        const state = journal.state();
        if (['failed', 'unresolved_scope'].includes(state.status)) {
          // A gap is retried wherever it still validates, also on another branch; nothing else may begin before it closes.
          if (journal.attempts(state.id) > maxRetries) return { status: 'blocked', code: 'retry_limit', id: state.id, results, reconciled };
          try { sourceInterval(entries, state.through, state.cursor, conversationId, { summaryPolicy }); }
          catch { return { status: 'blocked', code: 'coverage_gap_unreachable', id: state.id, results, reconciled }; }
          const retried = await run(entries, state.through, state.cursor, true);
          results.push(retried);
          if (!covered.has(retried.disposition)) return { status: retried.refused ? 'refused' : 'stopped', code: retried.code, results, reconciled };
        }
        const cursor = resolveCursor(entries, path);
        if (leafId === cursor) return { status: 'current', cursor, results, reconciled };
        try { sourceInterval(entries, leafId, cursor, conversationId, { summaryPolicy }); }
        catch (problem) { return { status: 'skipped', code: problem.code ?? 'source_invalid', cursor, results, reconciled }; }
        const result = await run(entries, leafId, cursor, false);
        results.push(result);
        const done = covered.has(result.disposition);
        return { status: done ? 'covered' : result.refused ? 'refused' : 'stopped', ...(result.refused ? { code: result.code } : {}),
          cursor: done ? leafId : cursor, results, reconciled, ...(gate.ungated ? { ungated: true } : {}) };
      } finally { busy = false; }
    },
    async close() { await dropSession(); },
  };
}
