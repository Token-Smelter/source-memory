import neo4j from 'neo4j-driver';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, namespace } from '../src/core.mjs';
import { Memory } from '../src/memory.mjs';
import { exportScope } from './export-scope.mjs';
import { inspectNamespace } from './namespace-probe.mjs';

const fail = code => Object.assign(new Error(code), { code });
const edgeTypes = new Set(['SM_HAS_CHUNK', 'SM_EVIDENCE', 'SM_FROM', 'SM_TO']);
const bases = ['SMTurn', 'SMChunk', 'SMRecord', 'SMRelation'];

function dateTime(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('snapshot_invalid');
  const keys = ['year', 'month', 'day', 'hour', 'minute', 'second', 'nanosecond'];
  if (keys.some(key => !Number.isSafeInteger(value[key]))
    || (value.timeZoneOffsetSeconds !== undefined && !Number.isSafeInteger(value.timeZoneOffsetSeconds))
    || (value.timeZoneId !== undefined && value.timeZoneId !== null && typeof value.timeZoneId !== 'string')) throw fail('snapshot_invalid');
  return new neo4j.types.DateTime(...keys.map(key => value[key]), value.timeZoneOffsetSeconds, value.timeZoneId);
}

/** Restore only into a verified empty private database; no existing nodes may be overwritten. */
export async function restoreScope({ driver, snapshot, scope }) {
  if (!driver || snapshot?.schema !== 'source-memory-logical-snapshot/v1' || snapshot.scope !== scope
    || typeof scope !== 'string' || !scope || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.relationships)) throw fail('snapshot_invalid');
  const ns = namespace(scope), nodes = new Map(), grouped = new Map(bases.map(base => [base, []]));
  for (const row of snapshot.nodes) {
    if (!row || typeof row.uid !== 'string' || !row.uid || nodes.has(row.uid) || !Array.isArray(row.labels)
      || !row.properties || row.properties.uid !== row.uid || row.properties.scope !== scope) throw fail('snapshot_invalid');
    const base = bases.find(name => row.labels.includes(name));
    const expected = base === 'SMRelation' ? [base] : [base, `${ns}${base.slice(2)}`];
    if (!base || canonical([...row.labels].sort()) !== canonical(expected.sort())) throw fail('snapshot_invalid');
    const properties = { ...row.properties };
    if (properties.created_at !== undefined) properties.created_at = dateTime(properties.created_at);
    for (const [key, value] of Object.entries(properties)) {
      if (key === 'created_at') continue;
      if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) continue;
      if (Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isFinite(item))) continue;
      throw fail('snapshot_invalid');
    }
    nodes.set(row.uid, base); grouped.get(base).push(properties);
  }
  const edges = new Map([...edgeTypes].map(type => [type, []]));
  for (const row of snapshot.relationships) {
    if (!row || !edgeTypes.has(row.type) || !nodes.has(row.from) || !nodes.has(row.to)
      || !row.properties || Object.keys(row.properties).length) throw fail('snapshot_invalid');
    edges.get(row.type).push({ from: row.from, to: row.to });
  }
  const session = driver.session({ database: 'neo4j' });
  try {
    return await session.executeWrite(async tx => {
      const count = await tx.run('MATCH (n) RETURN count(n) AS count');
      if (count.records[0].get('count') !== 0) throw fail('database_not_empty');
      for (const base of bases) {
        const labels = base === 'SMRelation' ? base : `${base}:${ns}${base.slice(2)}`;
        for (let i = 0; i < grouped.get(base).length; i += 256) {
          await tx.run(`UNWIND $rows AS row CREATE (n:${labels}) SET n = row`, { rows: grouped.get(base).slice(i, i + 256) });
        }
      }
      for (const [type, rows] of edges) for (let i = 0; i < rows.length; i += 256) {
        await tx.run(`UNWIND $rows AS row MATCH (a {uid:row.from,scope:$scope}),(b {uid:row.to,scope:$scope}) CREATE (a)-[:${type}]->(b)`,
          { scope, rows: rows.slice(i, i + 256) });
      }
      return { nodes: nodes.size, relationships: snapshot.relationships.length };
    }, { timeout: 120000 });
  } finally { await session.close(); }
}

/** Compare data and relationships independent of JSON object or label ordering. */
export function sameLogicalSnapshot(a, b) {
  const normalize = value => ({ schema: value.schema, scope: value.scope,
    nodes: value.nodes.map(row => ({ ...row, labels: [...row.labels].sort() })).sort((x, y) => x.uid.localeCompare(y.uid)),
    relationships: value.relationships.map(row => ({ ...row })).sort((x, y) => canonical(x).localeCompare(canonical(y))) });
  return canonical(normalize(a)) === canonical(normalize(b));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path, expectedSha, scope] = process.argv.slice(2);
  const run = async () => {
    if (!/^\/scratch\/[a-zA-Z0-9._-]+\.json$/.test(path ?? '') || !/^[a-f0-9]{64}$/.test(expectedSha ?? '')
      || typeof scope !== 'string' || !scope) throw fail('snapshot_invalid');
    inspectNamespace({ interfaces: readdirSync('/sys/class/net').sort(), ipv4Routes: readFileSync('/proc/net/route', 'utf8'),
      ipv6Routes: readFileSync('/proc/net/ipv6_route', 'utf8'), namespace: readlinkSync('/proc/self/ns/net') });
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const state = fstatSync(fd);
      if (!state.isFile() || state.size < 1 || state.size > 128_000_000) throw fail('snapshot_invalid');
      bytes = readFileSync(fd);
      if (bytes.length !== state.size) throw fail('snapshot_invalid');
    } finally { closeSync(fd); }
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha) throw fail('snapshot_invalid');
    const snapshot = JSON.parse(bytes);
    const database = { uri: 'bolt://127.0.0.1:7687', auth: 'none' };
    const memory = new Memory({ neo4j: database, scopes: { read: [scope], write: [scope] },
      embedding: { url: 'http://127.0.0.1:18080/v1/embeddings', model: 'embeddinggemma', dimensions: 768 }, index_on_write: false });
    try {
      const session = memory.store.driver.session({ database: 'neo4j' });
      try {
        const empty = await session.executeRead(tx => tx.run('MATCH (n) RETURN count(n) AS count'));
        if (empty.records[0].get('count') !== 0) throw fail('database_not_empty');
      } finally { await session.close(); }
      await memory.init(scope);
      const restored = await restoreScope({ driver: memory.store.driver, snapshot, scope });
      const output = `/scratch/restore-check-${expectedSha.slice(0, 16)}.json`;
      const receipt = await exportScope({ driver: memory.store.driver, scope, output, allowedDir: '/scratch' });
      if (!sameLogicalSnapshot(snapshot, JSON.parse(readFileSync(output, 'utf8')))) throw fail('snapshot_mismatch');
      return { ...restored, source_sha256: expectedSha, restored_sha256: receipt.sha256, equivalent: true };
    } finally { await memory.close(); }
  };
  run().then(result => process.stdout.write(`${JSON.stringify(result)}\n`), () => {
    process.stderr.write('{"error":"restore_failed"}\n'); process.exitCode = 1;
  });
}
