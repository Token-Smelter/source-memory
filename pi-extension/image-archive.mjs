import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const fail = code => Object.assign(new Error(code), { code });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function imageBlock(block) {
  if (block?.type !== 'image' || typeof block.mimeType !== 'string' || !/^image\/[a-zA-Z0-9.+-]{1,64}$/.test(block.mimeType)
    || typeof block.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.data)) throw fail('image_invalid');
  const bytes = Buffer.from(block.data, 'base64');
  if (!bytes.length || bytes.length > 10_000_000) throw fail('image_invalid');
  return { bytes, sha256: sha(bytes), mime: block.mimeType, size: bytes.length };
}

/** Store the exact original image bytes by digest under a private directory. */
export function createImageArchive({ directory }) {
  const root = realpathSync(directory), state = statSync(root);
  if (!state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o077) !== 0) throw fail('work_dir_invalid');
  return { archive(block) {
    const item = imageBlock(block), path = join(root, `${item.sha256}.blob`);
    let fd;
    try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(existing), bytes = readFileSync(existing);
        if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || sha(bytes) !== item.sha256 || bytes.length !== item.size) throw fail('image_archive_conflict');
      } finally { closeSync(existing); }
      return { sha256: item.sha256, mime: item.mime, bytes: item.size };
    }
    try {
      for (let offset = 0; offset < item.bytes.length;) offset += writeSync(fd, item.bytes, offset, item.bytes.length - offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return { sha256: item.sha256, mime: item.mime, bytes: item.size };
  } };
}
