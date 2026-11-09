import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createInputBudget } from './budget.mjs';

const fail = code => Object.assign(new Error(code), { code });
const refusal = code => Object.assign(new Error(code), { code, refused: true });
const counted = ['input', 'cacheRead', 'cacheWrite'];

/** A private append-only ledger of reported model usage and admitted intervals, grouped by UTC day so spend survives restarts. */
export function createUsageLedger({ directory, now = () => new Date() }) {
  const dir = realpathSync(directory);
  const st = statSync(dir);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid()) throw fail('work_dir_invalid');
  const path = join(dir, 'usage.jsonl');
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  const file = fstatSync(fd);
  if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o077) !== 0) { closeSync(fd); throw fail('ledger_invalid'); }
  const day = () => now().toISOString().slice(0, 10);
  const rows = [];
  const input = readFileSync(fd, 'utf8');
  // A torn or unreadable line is a crash during append; its usage is counted as unknown on the day it is found.
  const lines = input.split('\n');
  const torn = lines.pop();
  for (const line of lines) { try { rows.push(JSON.parse(line)); } catch { rows.push({ kind: 'usage', status: 'unknown', day: day() }); } }
  if (torn) rows.push({ kind: 'usage', status: 'unknown', day: day() });
  let unterminated = Boolean(torn);
  const of = when => rows.filter(row => row.day === when);
  const valid = row => counted.every(key => Number.isSafeInteger(row[key]) && row[key] >= 0);
  return {
    path,
    day,
    used: (when = day()) => of(when).filter(row => row.kind === 'usage' && !row.status && valid(row)).reduce((sum, row) => sum + counted.reduce((total, key) => total + row[key], 0), 0),
    unknown: (when = day()) => of(when).some(row => row.kind === 'usage' && (row.status === 'unknown' || !valid(row))),
    intervals: (when = day()) => of(when).filter(row => row.kind === 'interval').length,
    append(row) {
      const entry = { v: 1, day: day(), at: now().toISOString(), ...row };
      const bytes = Buffer.from(`${unterminated ? '\n' : ''}${JSON.stringify(entry)}\n`);
      for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
      unterminated = false;
      rows.push(entry);
    },
    close: () => closeSync(fd),
  };
}

/**
 * Daily input-token budget seeded from the ledger. The day rolls over only between intervals (rollover), never inside
 * one, so the distiller's per-call accounting stays consistent. Prior unknown usage on the same day keeps it refused.
 */
export function createDailyInputBudget({ ledger, limit }) {
  let current, currentDay;
  const open = () => {
    currentDay = ledger.day();
    current = createInputBudget(limit, { initialUsed: ledger.used(currentDay), initialUnknown: ledger.unknown(currentDay),
      onReceipt: receipt => ledger.append({ kind: 'usage', ...receipt }) });
  };
  open();
  return {
    beforeCall: () => current.beforeCall(),
    record: usage => current.record(usage),
    used: () => current.used(),
    started: () => current.started(),
    receipts: () => current.receipts(),
    reason: () => current.reason(),
    get limit() { return limit; },
    rollover() { if (ledger.day() !== currentDay && current.started() === current.receipts().length) open(); },
  };
}

/** Admission before any ingest: both scope grants, a known and unexhausted budget, and the daily interval cap. */
export function createLiveGate({ scope, grants, budget, ledger, maxIntervalsPerDay = null, minRemaining = 0 }) {
  if (typeof scope !== 'string' || !scope || typeof budget?.reason !== 'function' || typeof ledger?.append !== 'function'
    || (maxIntervalsPerDay !== null && (!Number.isSafeInteger(maxIntervalsPerDay) || maxIntervalsPerDay < 1))
    || !Number.isSafeInteger(minRemaining) || minRemaining < 0) throw fail('gate_invalid');
  return async ({ through, cursor, retry }) => {
    if (!grants?.read?.includes?.(scope) || !grants?.write?.includes?.(scope)) throw refusal('scope_permission_denied');
    budget.rollover?.();
    const reason = budget.reason();
    if (reason) throw refusal(reason);
    if (budget.limit - budget.used() < minRemaining) throw refusal('input_budget_reserve');
    if (maxIntervalsPerDay !== null && ledger.intervals() >= maxIntervalsPerDay) throw refusal('interval_limit');
    ledger.append({ kind: 'interval', through, cursor, retry });
  };
}
