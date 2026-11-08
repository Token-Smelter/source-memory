import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, constants, fstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../src/core.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');

function snapshot(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw fail('source_unavailable');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const named = statSync(path);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.dev !== before.dev || named.ino !== before.ino) throw fail('source_changed');
    return bytes;
  } finally { closeSync(fd); }
}

function parseLines(bytes, through) {
  const lines = [];
  let start = 0;
  let end = -1;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 10) continue;
    const line = bytes.subarray(start, index + 1);
    let row;
    try { row = JSON.parse(line.toString('utf8')); } catch { throw fail('source_invalid'); }
    lines.push({ row, bytes: line, end: index + 1 });
    start = index + 1;
    if (row.id === through && row.type !== 'session') { end = start; break; }
  }
  if (!lines.length || lines[0].row?.type !== 'session' || end < 0) throw fail('source_unavailable');
  const seen = new Set();
  for (const { row } of lines.slice(1)) {
    if (typeof row.id !== 'string' || !row.id || !Object.hasOwn(row, 'parentId') || seen.has(row.id)
      || (row.parentId !== null && !seen.has(row.parentId))) throw fail('source_invalid');
    seen.add(row.id);
  }
  return { lines, end };
}

/** Owns a private file; source lines remain byte-identical and task rows stay on Pi side branches. */
export async function createIncrementalSession({ source, workDir, sessionId = randomUUID() }) {
  if (typeof source !== 'string' || typeof sessionId !== 'string' || !sessionId) throw fail('invalid_input');
  const dir = realpathSync(workDir);
  const stat = statSync(dir);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw fail('work_dir_invalid');
  const file = join(dir, `pi-memory-${randomUUID()}.jsonl`);
  let offset = 0;
  let prefix = null;
  let header;
  let sourceHeaderId;
  let previous = [];
  let busy = false;
  return {
    file,
    sessionId,
    async syncThrough(through) {
      if (busy) throw fail('session_busy');
      busy = true;
      try {
        const bytes = snapshot(source);
        const parsed = parseLines(bytes, through);
        if (header && parsed.lines[0].row.id !== sourceHeaderId) throw fail('source_identity_changed');
        const changed = offset > 0 && (bytes.length < offset || sha(bytes.subarray(0, offset)) !== prefix);
        if (changed) {
          const now = new Map(parsed.lines.slice(1).map(({ row }) => [row.id, canonical(row)]));
          if (previous.some(row => now.get(row.id) !== canonical(row))) throw fail('source_identity_changed');
        } else if (parsed.end < offset) throw fail('cursor_unresolved');
        if (!header) {
          const { parentSession: _parent, ...original } = parsed.lines[0].row;
          sourceHeaderId = original.id;
          header = { ...original, id: sessionId };
          writeFileSync(file, JSON.stringify(header) + '\n', { flag: 'wx', mode: 0o600 });
        }
        if (changed) {
          const temporary = join(dir, `.pi-memory-${randomUUID()}.tmp`);
          const body = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), ...parsed.lines.slice(1).map(line => line.bytes)]);
          try { writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
          catch (problem) { try { const { unlinkSync } = await import('node:fs'); unlinkSync(temporary); } catch {} throw problem; }
        } else {
          const added = parsed.lines.filter(line => line.end > offset && line.row.type !== 'session');
          const existing = new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(1).map(line => JSON.parse(line).id));
          if (added.some(line => existing.has(line.row.id))) throw fail('entry_id_collision');
          if (added.length) appendFileSync(file, Buffer.concat(added.map(line => line.bytes)));
        }
        offset = parsed.end;
        prefix = sha(bytes.subarray(0, offset));
        previous = parsed.lines.slice(1).map(line => line.row);
        return { file, sessionId, source_offset: offset, source_prefix_sha256: prefix, rebuilt: changed };
      } finally { busy = false; }
    },
  };
}
