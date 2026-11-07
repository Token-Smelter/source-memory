import { createServer, request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = code => Object.assign(new Error(code), { code });

/** The in-namespace listener can only forward the admitted route to the mounted Unix socket. */
export function createEmbeddingShim({ socketPath, requestFn = httpRequest }) {
  if (socketPath !== '/scratch/embeddings.sock') throw fail('socket_invalid');
  return createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/embeddings') {
      response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"error":"not_found"}'); return;
    }
    const upstream = requestFn({ socketPath, method: 'POST', path: '/v1/embeddings', headers: { 'content-type': 'application/json' } }, result => {
      response.writeHead(result.statusCode ?? 502, { 'content-type': 'application/json' });
      result.pipe(response);
    });
    upstream.setTimeout(100000, () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' }); response.end('{"error":"relay_unavailable"}'); });
    request.on('error', () => upstream.destroy());
    request.pipe(upstream);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || port === 7687 || port === 7474) throw fail('port_invalid');
  const server = createEmbeddingShim({ socketPath: '/scratch/embeddings.sock' });
  server.listen(port, '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
