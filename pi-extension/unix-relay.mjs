import { chmodSync, lstatSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createEmbeddingHandler } from './bridge-harness.mjs';

const fail = code => Object.assign(new Error(code), { code });

/** Only the private socket is exposed; the handler forwards the one admitted embeddings route. */
export async function openUnixEmbeddingRelay({ socketPath, fetchFn, serverFactory = createServer }) {
  if (!isAbsolute(socketPath ?? '') || Buffer.byteLength(socketPath) > 100 || basename(socketPath) !== 'embeddings.sock') throw fail('socket_invalid');
  const dir = realpathSync(dirname(socketPath));
  const stat = statSync(dir);
  if (join(dir, basename(socketPath)) !== socketPath || !stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw fail('work_dir_invalid');
  try { lstatSync(socketPath); throw fail('socket_exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const server = serverFactory(createEmbeddingHandler({ fetchFn }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
  });
  try {
    chmodSync(socketPath, 0o600);
    const socket = lstatSync(socketPath);
    if (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077) !== 0) throw fail('socket_invalid');
    return { async close() {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      try {
        const current = lstatSync(socketPath);
        if (current.dev !== socket.dev || current.ino !== socket.ino) throw fail('socket_identity_changed');
        unlinkSync(socketPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } };
  } catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
}
