import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, linkSync, openSync, readdirSync, readFileSync, readlinkSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

const fail = code => Object.assign(new Error(code), { code });
const read = (load, fallback = null) => { try { return load(); } catch { return fallback; } };
// The hostname alone can repeat across machines sharing a directory (NFS, cloned VMs, containers); the machine ID cannot.
const machineId = () => read(() => readFileSync('/etc/machine-id', 'utf8').trim()) ?? read(() => readFileSync('/var/lib/dbus/machine-id', 'utf8').trim());
const bootId = () => read(() => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
const pidNamespace = () => read(() => readlinkSync('/proc/self/ns/pid'));
// Field 22 of /proc/<pid>/stat (after the parenthesised command) is the start time in clock ticks since boot.
const startTime = pid => read(() => readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19]);
// Field 3 is the process state; a zombie (Z) or dead (X) process holds its PID but runs nothing.
const running = pid => !['Z', 'X', null].includes(read(() => readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[0]));

export function ownerRecord(pid = process.pid) {
  return { v: 1, host: hostname(), machine: machineId() || null, boot: bootId(), pidns: pidNamespace(), pid, start: startTime(pid) };
}

/**
 * A lock owner is gone only when its record names this host and PID namespace and either this boot has changed, or its PID
 * no longer exists or now has a different start time. Anything unreadable, foreign or ambiguous is treated as alive.
 */
export function ownerGone(owner, self = ownerRecord()) {
  if (!owner || owner.v !== 1 || owner.host !== self.host || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  if (!owner.machine || owner.machine !== self.machine) return false;
  if (owner.boot && self.boot && owner.boot !== self.boot) return true;
  if (!owner.boot || owner.boot !== self.boot || !owner.pidns || owner.pidns !== self.pidns) return false;
  if (owner.pid === self.pid) return owner.start !== null && self.start !== null && owner.start !== self.start;
  try { process.kill(owner.pid, 0); }
  catch (problem) { return problem.code === 'ESRCH'; }
  const now = startTime(owner.pid);
  return owner.start !== null && now !== null && owner.start !== now;
}

/**
 * The opposite proof, for spend: an owner is alive only when it names this host, machine, boot and PID namespace and its PID
 * runs with the recorded start time. Anything unprovable (no /proc, another namespace or host) is not alive; callers that
 * need to recognize their own process tag their records instead (live-gate instance IDs).
 */
export function ownerAlive(owner, self = ownerRecord()) {
  if (!owner || owner.v !== 1 || owner.host !== self.host || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  if (!owner.machine || owner.machine !== self.machine) return false;
  if (!owner.boot || owner.boot !== self.boot || !owner.pidns || owner.pidns !== self.pidns || owner.start === null) return false;
  if (owner.pid === self.pid) return owner.start === self.start;
  try { process.kill(owner.pid, 0); } catch (problem) { if (problem.code !== 'EPERM') return false; }
  return startTime(owner.pid) === owner.start && running(owner.pid);
}

/** Create the lock with its owner record in one step: write a private temp file, then hard-link it into place. */
function place(lockPath, bytes) {
  const temporary = `${lockPath}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { linkSync(temporary, lockPath); } finally { try { unlinkSync(temporary); } catch {} }
}

/**
 * Exclusive journal lock that a restarted process may take over from a dead owner. Taking over is serialised by an
 * O_EXCL break guard and re-checked under it, so concurrent openers end with exactly one holder. A guard left by a crash
 * during takeover requires an operator.
 */
export function acquireOwnerLock(lockPath, { beforeBreak } = {}) {
  const record = ownerRecord();
  const bytes = Buffer.from(JSON.stringify(record));
  try { place(lockPath, bytes); }
  catch (problem) {
    if (problem.code !== 'EEXIST') throw problem;
    const guardPath = `${lockPath}.break`;
    let guard;
    try { guard = openSync(guardPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch { throw fail('journal_locked'); }
    try {
      const owner = read(() => JSON.parse(readFileSync(lockPath, 'utf8')));
      if (!ownerGone(owner, record)) throw fail('journal_locked');
      beforeBreak?.();
      unlinkSync(lockPath);
      place(lockPath, bytes);
    } catch (inner) {
      throw ['EEXIST', 'ENOENT', 'journal_locked'].includes(inner.code) ? fail('journal_locked') : inner;
    } finally { closeSync(guard); try { unlinkSync(guardPath); } catch {} }
  }
  // Temp files a crash left between write and link are stale after a minute; younger ones may belong to a live opener.
  const prefix = `${basename(lockPath)}.`;
  for (const name of readdirSync(dirname(lockPath))) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const path = join(dirname(lockPath), name);
    try { if (Date.now() - statSync(path).mtimeMs > 60000) unlinkSync(path); } catch {}
  }
  return {
    record,
    release() {
      // Remove only a lock that still carries this owner's record.
      const current = read(() => readFileSync(lockPath));
      if (current && current.equals(bytes)) { try { unlinkSync(lockPath); } catch {} }
    },
  };
}
