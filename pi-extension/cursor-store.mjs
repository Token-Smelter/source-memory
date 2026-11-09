import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../src/core.mjs';

const fail = code => Object.assign(new Error(code), { code });
const owned = st => st.uid === process.getuid() && (st.mode & 0o077) === 0;

function syncDirectory(dir) {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Write a new private file durably: exclusive create, fsync, directory fsync. An existing file is left unchanged. */
export function writeDurableFile(directory, name, bytes) {
  const path = join(directory, name);
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(directory);
  return path;
}

/**
 * One durable processed-cursor file per session. A save is a private temp write, fsync, rename and directory fsync,
 * so a crash leaves either the previous or the new cursor, never a partial one.
 */
export function createCursorStore({ directory, sessionKey, hooks = {} }) {
  if (typeof sessionKey !== 'string' || !sessionKey) throw fail('session_invalid');
  const dir = realpathSync(directory);
  const st = statSync(dir);
  if (!st.isDirectory() || !owned(st)) throw fail('work_dir_invalid');
  const key = digest(['live-cursor/v1', sessionKey]);
  const path = join(dir, `cursor-${key}.json`);
  // A temp file left by a crash before its rename was never the cursor.
  for (const name of readdirSync(dir)) if (name.startsWith(`.cursor-${key}-`) && name.endsWith('.tmp')) { try { unlinkSync(join(dir, name)); } catch {} }
  return {
    path,
    load() {
      let fd;
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (problem) { if (problem.code === 'ENOENT') return null; throw fail('cursor_store_invalid'); }
      try {
        const file = fstatSync(fd);
        if (!file.isFile() || !owned(file)) throw fail('cursor_store_invalid');
        const { hash, ...payload } = JSON.parse(readFileSync(fd, 'utf8'));
        if (payload.version !== 1 || payload.session !== key || digest(payload) !== hash
          || (payload.cursor !== null && (typeof payload.cursor !== 'string' || !payload.cursor))) throw fail('cursor_store_invalid');
        return { cursor: payload.cursor, interval_id: payload.interval_id ?? null, saved_at: payload.saved_at };
      } catch (problem) { throw problem.code === 'cursor_store_invalid' ? problem : fail('cursor_store_invalid'); }
      finally { closeSync(fd); }
    },
    save(cursor, { intervalId = null } = {}) {
      if (cursor !== null && (typeof cursor !== 'string' || !cursor)) throw fail('checkpoint_invalid');
      const payload = { version: 1, session: key, cursor, interval_id: intervalId, saved_at: new Date().toISOString() };
      const bytes = Buffer.from(JSON.stringify({ ...payload, hash: digest(payload) }));
      const temporary = join(dir, `.cursor-${key}-${randomUUID()}.tmp`);
      let fd;
      try {
        fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        hooks.beforeRename?.();
        renameSync(temporary, path);
      } catch (problem) {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temporary); } catch {}
        throw Object.assign(fail('cursor_save_failed'), { cause: problem });
      }
      try { syncDirectory(dir); } catch (problem) { throw Object.assign(fail('cursor_save_unsynced'), { cause: problem }); }
      return { cursor, interval_id: intervalId };
    },
  };
}
