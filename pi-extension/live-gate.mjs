import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, realpathSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { acquireOwnerLock, ownerAlive, ownerRecord } from './owner-lock.mjs';

const fail = code => Object.assign(new Error(code), { code });
const refusal = code => Object.assign(new Error(code), { code, refused: true });
const counted = ['input', 'cacheRead', 'cacheWrite'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Identifies this process's own call starts in a ledger it shares with other processes.
const INSTANCE = randomUUID();
const tokens = row => counted.every(key => Number.isSafeInteger(row[key]) && row[key] >= 0);

/** A row is understood only in its exact shapes; anything else is unknown usage. */
function classify(row) {
  if (!row || typeof row !== 'object' || row.v !== 1 || typeof row.day !== 'string' || !DAY.test(row.day)) return null;
  if (row.kind === 'call' && typeof row.id === 'string' && row.owner && typeof row.owner === 'object') return 'call';
  if (row.kind === 'interval') return 'interval';
  if (row.kind === 'usage' && (row.status === 'unknown' || (row.status === undefined && tokens(row)))) return 'usage';
  return null;
}

/**
 * A private, append-only ledger of model call starts, reported usage and admitted intervals per UTC day. Every process and
 * session using the same state directory appends to it and re-reads it before each decision, so the day total is durable and
 * shared. A call start without a usage row is in flight only while its owner is provably alive, and unknown usage otherwise.
 * An unreadable line is acknowledged once, as unknown usage on the day it is found.
 */
export function createUsageLedger({ directory, now = () => new Date() }) {
  const dir = realpathSync(directory);
  const st = statSync(dir);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid()) throw fail('work_dir_invalid');
  const path = join(dir, 'usage.jsonl');
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  let closed = false, offset = 0, pendingTail = Buffer.alloc(0);
  const rows = [], acknowledged = new Set(), unreadable = [];
  const day = () => now().toISOString().slice(0, 10);
  const self = ownerRecord();
  function write(text) {
    if (closed) throw fail('ledger_closed');
    const size = fstatSync(fd).size;
    let prefix = '';
    if (size) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 10) prefix = '\n';
    }
    const bytes = Buffer.from(`${prefix}${text}\n`);
    try {
      for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } catch { closed = true; try { closeSync(fd); } catch {} throw fail('ledger_write_uncertain'); }
  }
  function refresh() {
    if (closed) throw fail('ledger_closed');
    const size = fstatSync(fd).size;
    if (size > offset) {
      const chunk = Buffer.alloc(size - offset);
      for (let read = 0; read < chunk.length;) {
        const count = readSync(fd, chunk, read, chunk.length - read, offset + read);
        if (!count) throw fail('ledger_invalid');
        read += count;
      }
      const data = Buffer.concat([pendingTail, chunk]);
      const start = offset - pendingTail.length;
      let lineStart = 0;
      for (let index = data.indexOf(10); index >= 0; index = data.indexOf(10, lineStart)) {
        const line = data.subarray(lineStart, index);
        const at = start + lineStart;
        lineStart = index + 1;
        if (!line.length) continue;
        let row = null;
        try { row = JSON.parse(line.toString('utf8')); } catch {}
        if (row?.kind === 'ack' && Number.isSafeInteger(row.offset) && typeof row.day === 'string' && DAY.test(row.day)) {
          acknowledged.add(`${row.offset}:${row.sha256}`);
          rows.push({ v: 1, kind: 'usage', status: 'unknown', day: row.day, reason: 'ledger_line_unreadable' });
          continue;
        }
        const kind = classify(row);
        if (kind) rows.push({ ...row, kind });
        else unreadable.push({ offset: at, sha256: createHash('sha256').update(line).digest('hex') });
      }
      pendingTail = data.subarray(lineStart);
      offset = size;
    }
    let wrote = false;
    for (const line of unreadable.splice(0)) {
      const key = `${line.offset}:${line.sha256}`;
      if (acknowledged.has(key)) continue;
      wrote = true;
      const ack = { v: 1, kind: 'ack', day: day(), offset: line.offset, sha256: line.sha256, reason: 'ledger_line_unreadable' };
      write(JSON.stringify(ack));
      acknowledged.add(key);
    }
    if (wrote) refresh();
  }
  try {
    const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o077) !== 0) throw fail('ledger_invalid');
    refresh();
    // A torn final line from a crash is complete once this process terminates it.
    if (pendingTail.length) { write(''); refresh(); }
  } catch (problem) { if (!closed) { closed = true; closeSync(fd); } throw problem; }
  const of = when => { refresh(); return rows.filter(row => row.day === when); };
  const receipts = () => new Set(rows.filter(row => row.kind === 'usage' && typeof row.call === 'string').map(row => row.call));
  return {
    path,
    day,
    used: (when = day()) => of(when).filter(row => row.kind === 'usage' && !row.status).reduce((sum, row) => sum + counted.reduce((total, key) => total + row[key], 0), 0),
    unknown(when = day()) {
      const today = of(when);
      if (today.some(row => row.kind === 'usage' && row.status === 'unknown')) return true;
      const reported = receipts();
      // A call started by this process is provably in flight even where /proc cannot prove anything.
      return today.some(row => row.kind === 'call' && !reported.has(row.id) && row.owner?.instance !== INSTANCE && !ownerAlive(row.owner, self));
    },
    intervals: (when = day()) => of(when).filter(row => row.kind === 'interval').length,
    append(row) {
      refresh();
      const entry = { v: 1, day: day(), at: now().toISOString(), ...row };
      write(JSON.stringify(entry));
      refresh();
      return entry;
    },
    callStart() { return this.append({ kind: 'call', id: randomUUID(), owner: { ...self, instance: INSTANCE } }).id; },
    /** Run a check-and-append decision exclusively across processes sharing the directory, waiting without blocking the host. */
    async exclusive(action) {
      const lockPath = join(dir, 'usage.lock');
      let lock;
      for (let attempt = 0; !lock; attempt++) {
        try { lock = acquireOwnerLock(lockPath); }
        catch (problem) {
          if (problem.code !== 'journal_locked') throw refusal('ledger_lock_unavailable');
          if (attempt >= 200) throw refusal('ledger_busy');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      try { return action(); } finally { lock.release(); }
    },
    close() { if (!closed) { closed = true; closeSync(fd); } },
  };
}

/**
 * Daily input-token budget over the shared ledger, with the createInputBudget interface the distiller uses. Each call start
 * is durable before dispatch, so a crash mid-call leaves unknown usage rather than forgotten spend. Use one budget per live
 * session; sessions and processes coordinate only through the ledger.
 */
export function createDailyInputBudget({ ledger, limit }) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || typeof ledger?.callStart !== 'function') throw fail('input_budget_invalid');
  const own = [];
  let unknownDay = null, prevented = 0, stopped = false;
  const check = () => {
    if (unknownDay === ledger.day() || own.some(call => !call.receipt) || ledger.unknown()) return 'input_budget_unknown';
    return ledger.used() >= limit ? 'input_budget_exhausted' : null;
  };
  return {
    ledger,
    /** Sticky: every later dispatch is refused before it is sent, so shutdown cannot start a model call. */
    stop() { stopped = true; },
    beforeCall() {
      if (stopped) { prevented++; throw fail('dispatch_prevented'); }
      const reason = check();
      // Pi reports a dispatch it never made with empty usage; that report must not read as lost spend.
      if (reason) { prevented++; throw fail(reason); }
      own.push({ id: ledger.callStart(), receipt: null });
    },
    record(usage) {
      const call = own.find(row => !row.receipt);
      // An empty report answers a prevented dispatch first, so it can never settle an open call as zero tokens.
      if (prevented && usage && counted.every(key => usage[key] === 0)) { prevented--; return; }
      const valid = usage && tokens(usage) && Number.isSafeInteger(counted.reduce((sum, key) => sum + usage[key], 0));
      const receipt = valid ? { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
        output: Number.isSafeInteger(usage.output) ? usage.output : null } : { status: 'unknown' };
      // An invalid report writes a durable unknown row for every process; a report without an open call is known only
      // to this process, whose flag ends with its day.
      if (!valid || !call) unknownDay = ledger.day();
      if (call) call.receipt = receipt;
      try { ledger.append({ kind: 'usage', ...(call ? { call: call.id } : {}), ...receipt }); }
      catch { unknownDay = ledger.day(); throw fail('usage_receipt_unavailable'); }
    },
    used: () => ledger.used(),
    started: () => own.length,
    receipts: () => own.filter(row => row.receipt).map(row => structuredClone(row.receipt)),
    reason: check,
    limit,
  };
}

/**
 * Admission before any ingest. Grants must be arrays naming the scope for both read and write; the budget must be known and
 * not exhausted, with at least minRemaining tokens left; the durable daily interval cap must not be reached. An admitted
 * interval is recorded. The gate carries its scope and budget so the controller can check they are the session's own.
 */
export function createLiveGate({ scope, grants, budget, ledger, maxIntervalsPerDay = null, minRemaining = 0 }) {
  if (typeof scope !== 'string' || !scope || typeof budget?.reason !== 'function' || !Number.isSafeInteger(budget.limit) || budget.limit <= 0
    || typeof ledger?.append !== 'function' || typeof ledger.exclusive !== 'function' || budget.ledger !== ledger || !grants || !Array.isArray(grants.read) || !Array.isArray(grants.write)
    || (maxIntervalsPerDay !== null && (!Number.isSafeInteger(maxIntervalsPerDay) || maxIntervalsPerDay < 1))
    || !Number.isSafeInteger(minRemaining) || minRemaining < 0) throw fail('gate_invalid');
  const permitted = grants.read.includes(scope) && grants.write.includes(scope);
  const gate = async ({ phase = 'interval', through = null, cursor = null, retry = false } = {}) => {
    if (!permitted) throw refusal('scope_permission_denied');
    if (phase === 'reconcile') return { admitted: true };
    // Check and record under the ledger lock so concurrent processes cannot all pass the interval cap.
    return ledger.exclusive(() => {
      const reason = budget.reason();
      if (reason) throw refusal(reason);
      const remaining = budget.limit - budget.used();
      if (!Number.isSafeInteger(remaining) || remaining < minRemaining) throw refusal('input_budget_reserve');
      if (maxIntervalsPerDay !== null && ledger.intervals() >= maxIntervalsPerDay) throw refusal('interval_limit');
      ledger.append({ kind: 'interval', through, cursor, retry });
      return { admitted: true };
    });
  };
  return Object.assign(gate, { scope, budget });
}
