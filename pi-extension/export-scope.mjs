import { createHash } from 'node:crypto';
import { constants, closeSync, fsyncSync, openSync, realpathSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';

const fail = code => Object.assign(new Error(code), { code });

/** A private, read-only logical snapshot includes scoped nodes, vectors and relationships. Restore is not implied. */
export async function exportScope({ driver, scope, output, allowedDir }) {
  if (!driver || typeof scope !== 'string' || !scope || scope.length > 256 || !isAbsolute(output ?? '') || !isAbsolute(allowedDir ?? '')
    || dirname(output) !== allowedDir || !/^[a-zA-Z0-9._-]+\.json$/.test(basename(output))) throw fail('snapshot_invalid');
  const dir = realpathSync(allowedDir);
  const state = statSync(dir);
  if (dir !== allowedDir || !state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o077) !== 0) throw fail('snapshot_invalid');
  const session = driver.session({ database: 'neo4j' });
  let value;
  try {
    value = await session.executeRead(async tx => {
      const nodes = await tx.run('MATCH (n) WHERE n.scope=$scope AND (n:SMTurn OR n:SMChunk OR n:SMRecord OR n:SMRelation) RETURN n.uid AS uid,labels(n) AS labels,properties(n) AS properties ORDER BY uid', { scope });
      const edges = await tx.run('MATCH (a)-[r]->(b) WHERE a.scope=$scope AND b.scope=$scope RETURN a.uid AS from,type(r) AS type,b.uid AS to,properties(r) AS properties ORDER BY from,type,to', { scope });
      return { schema: 'source-memory-logical-snapshot/v1', scope,
        nodes: nodes.records.map(row => row.toObject()), relationships: edges.records.map(row => row.toObject()) };
    }, { timeout: 60000 });
  } finally { await session.close(); }
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 134_217_728) throw fail('snapshot_too_large');
  const fd = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const parent = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    nodes: value.nodes.length, relationships: value.relationships.length, restore_verified: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [scope, output] = process.argv.slice(2);
  const driver = neo4j.driver('bolt://127.0.0.1:7687', undefined, { disableLosslessIntegers: true, connectionTimeout: 10000 });
  exportScope({ driver, scope, output, allowedDir: '/scratch' }).then(result => process.stdout.write(`${JSON.stringify(result)}\n`), () => {
    process.stderr.write('{"error":"snapshot_failed"}\n'); process.exitCode = 1;
  }).finally(() => driver.close());
}
