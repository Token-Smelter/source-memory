import { constants, closeSync, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../src/core.mjs';
import { distillThrough } from './core.mjs';

const fail = code => Object.assign(new Error(code), { code });
const effects = new Set(['ingest', 'enrich', 'applyLinks', 'applyOutcome']);
const tracking = Symbol('coverage-tracking');
const covered = new Set(['committed', 'abstained', 'ineligible_by_policy']);
const safeCode = error => typeof error?.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'operation_failed';

function staleLock(lockPath) {
  let owner;
  try { owner = readFileSync(lockPath, 'utf8'); } catch { return false; }
  if (!/^[1-9][0-9]{0,9}\n$/.test(owner)) return false;
  const pid = Number(owner);
  if (pid === process.pid) return false;
  try { process.kill(pid, 0); return false; }
  catch (problem) { return problem.code === 'ESRCH'; }
}

const idList = value => Array.isArray(value) && value.length <= 64 && value.every(id => typeof id === 'string' && id && id.length <= 512);

/**
 * One private, append-only journal per session. An orphan lock requires operator inspection, not automatic recovery.
 * effectIds records the deterministic record IDs a derived write names, so a restart can settle an unknown outcome by reading them.
 * pidLock writes the owner's process ID into the lock and breaks only a lock whose recorded owner no longer exists on this host;
 * an empty or unreadable lock still requires an operator.
 */
export function createCoverageJournal({ directory, sessionKey, effectIds = false, pidLock = false }) {
  if (typeof sessionKey !== 'string' || !sessionKey) throw fail('session_invalid');
  const dir = realpathSync(directory);
  const dirStat = statSync(dir);
  if (!dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0 || dirStat.uid !== process.getuid()) throw fail('work_dir_invalid');
  const name = `coverage-${digest(['coverage-session/v1', sessionKey])}`;
  const path = join(dir, `${name}.jsonl`);
  const lockPath = join(dir, `${name}.lock`);
  let lock, file;
  const takeLock = () => openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    try { lock = takeLock(); }
    catch (problem) {
      if (problem.code !== 'EEXIST' || !pidLock || !staleLock(lockPath)) throw problem;
      unlinkSync(lockPath);
      lock = takeLock();
    }
    if (pidLock) { writeSync(lock, `${process.pid}\n`); fsyncSync(lock); }
    file = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    const st = fstatSync(file);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw fail('journal_invalid');
    const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (problem) {
    if (file !== undefined) closeSync(file);
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
    throw problem.code === 'EEXIST' ? fail('journal_locked') : problem;
  }
  let closed = false;
  let seq = 0;
  let previous = null;
  let active = null;
  let gap = null;
  let gapEffects = new Map();
  const finished = new Map();
  const attempts = new Map();
  function apply(row) {
    if (row.type === 'begin') {
      if (active || (gap && (gap.reconciliation_required || !['failed', 'unresolved_scope'].includes(gap.disposition) || row.id !== gap.id || !row.retry)) || finished.has(row.id)) throw fail('journal_invalid');
      active = { id: row.id, through: row.through, cursor: row.cursor, effects: new Map(), derived: false };
      attempts.set(row.id, (attempts.get(row.id) ?? 0) + 1);
      gap = null;
    } else if (row.type === 'effect_begin') {
      if (!active || active.id !== row.id || active.effects.has(row.effect) || (row.ids !== undefined && !idList(row.ids))) throw fail('journal_invalid');
      active.effects.set(row.effect, { method: row.method, state: 'pending', ...(row.ids ? { ids: [...row.ids] } : {}) });
    } else if (row.type === 'effect_end') {
      const effect = active?.effects.get(row.effect);
      if (!effect || active.id !== row.id || effect.state !== 'pending' || !['confirmed', 'refused', 'unknown'].includes(row.outcome)) throw fail('journal_invalid');
      effect.state = row.outcome;
      if (row.outcome === 'confirmed' && ['enrich', 'applyLinks', 'applyOutcome'].includes(effect.method)) active.derived = true;
    } else if (row.type === 'offer_limit') {
      if (!active || active.id !== row.id || !Number.isSafeInteger(row.omitted_prior_records) || row.omitted_prior_records < 0
        || !Number.isSafeInteger(row.omitted_prior_spans) || row.omitted_prior_spans < 0 || !Array.isArray(row.trigger_omissions)) throw fail('journal_invalid');
    } else if (row.type === 'finish') {
      if (!active || active.id !== row.id || ![...covered, 'failed', 'uncertain', 'unresolved_scope'].includes(row.disposition)) throw fail('journal_invalid');
      if (covered.has(row.disposition)) finished.set(row.id, { disposition: row.disposition, search_incomplete: row.search_incomplete ?? null,
        cursor: active.cursor, through: active.through });
      else {
        gap = { id: row.id, disposition: row.disposition, through: active.through, cursor: active.cursor,
          ...(row.reconciliation_required ? { reconciliation_required: true } : {}) };
        gapEffects = active.effects;
      }
      active = null;
    } else if (row.type === 'reconcile') {
      if (active && active.id === row.id) {
        gap = { id: active.id, disposition: 'uncertain', through: active.through, cursor: active.cursor };
        gapEffects = active.effects;
        active = null;
      }
      if (!gap || gap.id !== row.id || !['uncertain', 'failed'].includes(gap.disposition)
        || (gap.disposition === 'failed' && (!gap.reconciliation_required || row.disposition !== 'failed'))
        || !['committed', 'failed'].includes(row.disposition)) throw fail('journal_invalid');
      if (row.disposition === 'committed') {
        finished.set(row.id, { disposition: 'committed', search_incomplete: null, cursor: gap.cursor, through: gap.through });
        gap = null;
      }
      else { gap.disposition = 'failed'; delete gap.reconciliation_required; }
    } else throw fail('journal_invalid');
  }
  function append(event) {
    if (closed) throw fail('journal_closed');
    const payload = { version: 1, seq: seq + 1, previous, ...event };
    const row = { ...payload, hash: digest(payload) };
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(file, bytes, offset, bytes.length - offset);
      fsyncSync(file);
    } catch { closed = true; throw fail('journal_write_uncertain'); }
    apply(row);
    seq = row.seq;
    previous = row.hash;
    return row;
  }
  try {
    const input = readFileSync(path, 'utf8');
    if (input && !input.endsWith('\n')) throw fail('journal_invalid');
    for (const line of input.split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      const { hash, ...payload } = row;
      if (row.version !== 1 || row.seq !== seq + 1 || row.previous !== previous || digest(payload) !== hash) throw fail('journal_invalid');
      apply(row);
      seq = row.seq;
      previous = hash;
    }
  } catch (problem) {
    closeSync(file); closeSync(lock); unlinkSync(lockPath);
    throw problem.code === 'journal_invalid' ? problem : fail('journal_invalid');
  }
  const outcomeIds = new Map();
  const api = {
    path,
    begin({ through, cursor, retry = false }) {
      if (typeof through !== 'string' || !through || (cursor !== null && (typeof cursor !== 'string' || !cursor))) throw fail('checkpoint_invalid');
      const id = digest(['coverage-interval/v1', sessionKey, cursor, through]);
      if (active || gap?.disposition === 'uncertain' || gap?.reconciliation_required) throw fail('reconciliation_required');
      if (gap && (gap.id !== id || !['failed', 'unresolved_scope'].includes(gap.disposition) || !retry)) throw fail('coverage_gap');
      if (finished.has(id)) throw fail('interval_already_covered');
      append({ type: 'begin', id, through, cursor, retry });
      return id;
    },
    track(memory) {
      if (!memory || typeof memory !== 'object') throw fail('memory_invalid');
      return new Proxy(memory, {
        get(target, key) {
          if (key === tracking) return api;
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          if (effectIds && key === 'beginOutcome') return async (...args) => {
            const result = await value.apply(target, args);
            if (typeof result?.token === 'string') outcomeIds.set(result.token, [args[2]?.id, args[3]?.id].filter(id => typeof id === 'string'));
            return result;
          };
          if (key === 'beginLinks') return async (...args) => {
            if (!active) throw fail('interval_not_started');
            const result = await value.apply(target, args), info = result?.packet?.retrieval;
            if (info && ((info.omitted_prior_records ?? 0) > 0 || (info.omitted_prior_spans ?? 0) > 0 || info.trigger_omissions?.length)) {
              append({ type: 'offer_limit', id: active.id, omitted_prior_records: info.omitted_prior_records ?? 0,
                omitted_prior_spans: info.omitted_prior_spans ?? 0, trigger_omissions: info.trigger_omissions ?? [] });
            }
            return result;
          };
          if (!effects.has(key)) return value.bind(target);
          return async (...args) => {
            if (!active) throw fail('interval_not_started');
            if ([...active.effects.values()].some(row => ['pending', 'unknown'].includes(row.state))) throw fail('write_reconciliation_required');
            const id = active.id;
            const effect = digest(['coverage-effect/v1', id, key, args]);
            if (active.effects.has(effect)) throw fail('effect_already_attempted');
            const ids = !effectIds ? null : key === 'enrich' ? args[1]?.records?.map(row => row?.id) ?? []
              : key === 'applyOutcome' ? outcomeIds.get(args[1]) ?? null : null;
            append({ type: 'effect_begin', id, method: key, effect, ...(ids && idList(ids) ? { ids } : {}) });
            try {
              const result = await value.apply(target, args);
              append({ type: 'effect_end', id, effect, outcome: 'confirmed', receipt_sha256: digest(result ?? null) });
              return result;
            } catch (problem) {
              const outcome = problem?.effect === 'refused' ? 'refused' : 'unknown';
              if (active?.effects.get(effect)?.state === 'pending') append({ type: 'effect_end', id, effect, outcome });
              if (outcome === 'unknown') throw Object.assign(fail('write_uncertain'), { write_outcome_unknown: true });
              throw problem;
            }
          };
        },
      });
    },
    finish(disposition, code = null, search = null, { boundaries } = {}) {
      if (boundaries !== undefined && (!Array.isArray(boundaries) || !boundaries.length
        || boundaries.some(row => typeof row?.entry_id !== 'string' || !['admissible', 'gap'].includes(row.disposition)))) throw fail('boundaries_invalid');
      if (!active) throw fail('interval_not_started');
      if (search !== null && (typeof search !== 'object' || typeof search.incomplete !== 'boolean' || !Array.isArray(search.statuses))) throw fail('search_status_invalid');
      const uncertain = [...active.effects.values()].some(row => !['confirmed', 'refused'].includes(row.state));
      if (!covered.has(disposition) && !['failed', 'unresolved_scope', 'uncertain'].includes(disposition)) throw fail('disposition_invalid');
      if (uncertain) disposition = 'uncertain';
      else if (disposition !== 'committed' && covered.has(disposition) && active.derived) disposition = 'failed';
      if (disposition === 'committed' && !active.derived) throw fail('disposition_invalid');
      const reconciliationRequired = active.derived && !covered.has(disposition) && disposition !== 'uncertain';
      append({ type: 'finish', id: active.id, disposition, code, ...(search ? { search_incomplete: search.incomplete, search_statuses: search.statuses } : {}),
        ...(reconciliationRequired ? { reconciliation_required: true } : {}), ...(boundaries ? { boundaries } : {}) });
      return disposition;
    },
    reconcile({ id, disposition, evidenceRef }) {
      if (typeof evidenceRef !== 'string' || !evidenceRef.trim() || !['committed', 'failed'].includes(disposition)) throw fail('reconciliation_invalid');
      if (!(active?.id === id || (gap?.id === id && (gap.disposition === 'uncertain' || gap.reconciliation_required)))) throw fail('reconciliation_invalid');
      append({ type: 'reconcile', id, disposition, evidence_ref: evidenceRef });
    },
    coveredDisposition({ through, cursor }) {
      if (typeof through !== 'string' || !through || (cursor !== null && (typeof cursor !== 'string' || !cursor))) throw fail('checkpoint_invalid');
      return finished.get(digest(['coverage-interval/v1', sessionKey, cursor, through]))?.disposition ?? null;
    },
    coveredSearchCompleteness({ through, cursor }) {
      if (typeof through !== 'string' || !through || (cursor !== null && (typeof cursor !== 'string' || !cursor))) throw fail('checkpoint_invalid');
      return finished.get(digest(['coverage-interval/v1', sessionKey, cursor, through]))?.search_incomplete ?? null;
    },
    /** Covered intervals, used to resolve a durable cursor against the active branch. */
    intervals() {
      return [...finished].map(([id, row]) => ({ id, cursor: row.cursor, through: row.through, disposition: row.disposition }));
    },
    /** Effects of the unfinished interval or of the current gap, for reconciliation planning. */
    effects() {
      const rows = active ? active.effects : gap ? gapEffects : new Map();
      return [...rows].map(([effect, row]) => ({ effect, ...structuredClone(row) }));
    },
    attempts: id => attempts.get(id) ?? 0,
    state() {
      if (active) return { status: 'uncertain', id: active.id, cursor: active.cursor, through: active.through, reason: 'unfinished_interval' };
      return gap ? { status: gap.disposition, ...gap } : { status: 'ready' };
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(file); closeSync(lock); unlinkSync(lockPath);
    },
  };
  return api;
}

/** The session's distiller and ingest path must both use the same journal-tracked memory facade. */
export async function runCoveredInterval({ journal, session, through, cursor, allowInterrupted = false, retry = false, summaryPolicy }) {
  if (session?.memory?.[tracking] !== journal || session?.distiller?.memory !== session.memory) throw fail('tracking_required');
  const id = journal.begin({ through, cursor, retry });
  try {
    const result = await distillThrough(session, through, cursor, { allowInterrupted, ...(summaryPolicy ? { summaryPolicy } : {}) });
    const disposition = result.distillation.disposition;
    if (!covered.has(disposition)) throw fail('disposition_invalid');
    const limits = result.distillation.search_limitations;
    const search = limits ? { incomplete: limits.incomplete, statuses: limits.statuses } : null;
    const boundaries = result.omissions?.summaries;
    const actual = journal.finish(disposition, null, search, boundaries ? { boundaries } : {});
    if (!covered.has(actual)) return { id, through, cursor, disposition: actual, code: 'write_uncertain' };
    return { ...result, id, disposition: actual, ...(search ? { search_incomplete: search.incomplete, search_statuses: search.statuses } : {}) };
  } catch (error) {
    const disposition = journal.finish(error?.code === 'scope_unresolved' ? 'unresolved_scope' : 'failed', safeCode(error));
    return { id, through, cursor, disposition, code: safeCode(error) };
  }
}
