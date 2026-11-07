import { constants, closeSync, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../src/core.mjs';
import { distillThrough } from './core.mjs';

const fail = code => Object.assign(new Error(code), { code });
const effects = new Set(['ingest', 'enrich', 'applyLinks', 'index']);
const tracking = Symbol('coverage-tracking');
const covered = new Set(['committed', 'abstained', 'ineligible_by_policy']);
const safeCode = error => typeof error?.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'operation_failed';

/** One private, append-only journal per session. An orphan lock requires operator inspection, not automatic recovery. */
export function createCoverageJournal({ directory, sessionKey }) {
  if (typeof sessionKey !== 'string' || !sessionKey) throw fail('session_invalid');
  const dir = realpathSync(directory);
  const dirStat = statSync(dir);
  if (!dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0 || dirStat.uid !== process.getuid()) throw fail('work_dir_invalid');
  const name = `coverage-${digest(['coverage-session/v1', sessionKey])}`;
  const path = join(dir, `${name}.jsonl`);
  const lockPath = join(dir, `${name}.lock`);
  let lock, file;
  try {
    lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
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
  const finished = new Map();
  function apply(row) {
    if (row.type === 'begin') {
      if (active || (gap && (!['failed', 'unresolved_scope'].includes(gap.disposition) || row.id !== gap.id || !row.retry)) || finished.has(row.id)) throw fail('journal_invalid');
      active = { id: row.id, through: row.through, cursor: row.cursor, effects: new Map(), derived: false };
      gap = null;
    } else if (row.type === 'effect_begin') {
      if (!active || active.id !== row.id || active.effects.has(row.effect)) throw fail('journal_invalid');
      active.effects.set(row.effect, { method: row.method, state: 'pending' });
    } else if (row.type === 'effect_end') {
      const effect = active?.effects.get(row.effect);
      if (!effect || active.id !== row.id || effect.state !== 'pending' || !['confirmed', 'unknown'].includes(row.outcome)) throw fail('journal_invalid');
      effect.state = row.outcome;
      if (row.outcome === 'confirmed' && effect.method !== 'ingest') active.derived = true;
    } else if (row.type === 'finish') {
      if (!active || active.id !== row.id || ![...covered, 'failed', 'uncertain', 'unresolved_scope'].includes(row.disposition)) throw fail('journal_invalid');
      if (covered.has(row.disposition)) finished.set(row.id, row.disposition);
      else gap = { id: row.id, disposition: row.disposition, through: active.through, cursor: active.cursor };
      active = null;
    } else if (row.type === 'reconcile') {
      if (active && active.id === row.id) {
        gap = { id: active.id, disposition: 'uncertain', through: active.through, cursor: active.cursor };
        active = null;
      }
      if (!gap || gap.id !== row.id || gap.disposition !== 'uncertain' || !['committed', 'failed'].includes(row.disposition)) throw fail('journal_invalid');
      if (row.disposition === 'committed') { finished.set(row.id, 'committed'); gap = null; }
      else gap.disposition = 'failed';
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
  const api = {
    path,
    begin({ through, cursor, retry = false }) {
      if (typeof through !== 'string' || !through || (cursor !== null && (typeof cursor !== 'string' || !cursor))) throw fail('checkpoint_invalid');
      const id = digest(['coverage-interval/v1', sessionKey, cursor, through]);
      if (active || gap?.disposition === 'uncertain') throw fail('reconciliation_required');
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
          if (!effects.has(key)) return value.bind(target);
          return async (...args) => {
            if (!active) throw fail('interval_not_started');
            const id = active.id;
            const effect = digest(['coverage-effect/v1', id, key, args]);
            if (active.effects.has(effect)) throw fail('effect_already_attempted');
            append({ type: 'effect_begin', id, method: key, effect });
            try {
              const result = await value.apply(target, args);
              append({ type: 'effect_end', id, effect, outcome: 'confirmed', receipt_sha256: digest(result ?? null) });
              return result;
            } catch (problem) {
              if (active?.effects.get(effect)?.state === 'pending') append({ type: 'effect_end', id, effect, outcome: 'unknown' });
              throw problem;
            }
          };
        },
      });
    },
    finish(disposition, code = null) {
      if (!active) throw fail('interval_not_started');
      const uncertain = [...active.effects.values()].some(row => row.state !== 'confirmed');
      if (!covered.has(disposition) && !['failed', 'unresolved_scope', 'uncertain'].includes(disposition)) throw fail('disposition_invalid');
      if (uncertain || (active.derived && !covered.has(disposition))) disposition = 'uncertain';
      if (disposition !== 'committed' && covered.has(disposition) && active.derived) disposition = 'uncertain';
      if (disposition === 'committed' && !active.derived) throw fail('disposition_invalid');
      append({ type: 'finish', id: active.id, disposition, code });
      return disposition;
    },
    reconcile({ id, disposition, evidenceRef }) {
      if (typeof evidenceRef !== 'string' || !evidenceRef.trim() || !['committed', 'failed'].includes(disposition)) throw fail('reconciliation_invalid');
      if (!(active?.id === id || (gap?.id === id && gap.disposition === 'uncertain'))) throw fail('reconciliation_invalid');
      append({ type: 'reconcile', id, disposition, evidence_ref: evidenceRef });
    },
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
export async function runCoveredInterval({ journal, session, through, cursor, allowInterrupted = false, retry = false }) {
  if (session?.memory?.[tracking] !== journal || session?.distiller?.memory !== session.memory) throw fail('tracking_required');
  const id = journal.begin({ through, cursor, retry });
  try {
    const result = await distillThrough(session, through, cursor, { allowInterrupted });
    const disposition = result.distillation.disposition;
    if (!covered.has(disposition)) throw fail('disposition_invalid');
    const actual = journal.finish(disposition);
    if (!covered.has(actual)) return { id, through, cursor, disposition: actual, code: 'write_uncertain' };
    return { ...result, id, disposition: actual };
  } catch (error) {
    const disposition = journal.finish(error?.code === 'scope_unresolved' ? 'unresolved_scope' : 'failed', safeCode(error));
    return { id, through, cursor, disposition, code: safeCode(error) };
  }
}
