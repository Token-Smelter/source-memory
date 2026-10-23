import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import neo4j from 'neo4j-driver';
import { runIntegration } from '../test/integration.mjs';

const exec = promisify(execFile);
const name = `source-memory-test-${randomUUID()}`;
const scratch = await mkdtemp(join(tmpdir(), 'source-memory-test-'));
const startedAt = new Date().toISOString();
let owned = false;
let stopped = false;
let results = [];
let failure = null;

async function stop() {
  if (!owned || stopped) return;
  await exec('docker', ['stop', '--time', '10', name], { timeout: 30000 });
  stopped = true;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  try { await stop(); } finally { process.exit(130); }
});

try {
  await exec('docker', ['run', '--detach', '--rm', '--name', name,
    '--publish', '127.0.0.1::7687', '--memory', '768m', '--cpus', '1',
    '--env', 'NEO4J_AUTH=none',
    '--env', 'NEO4J_server_memory_heap_initial__size=128m',
    '--env', 'NEO4J_server_memory_heap_max__size=256m',
    '--env', 'NEO4J_server_memory_pagecache_size=64m',
    'neo4j:5.26.14-community'], { timeout: 90000 });
  owned = true;
  const mapping = (await exec('docker', ['port', name, '7687/tcp'], { timeout: 10000 })).stdout.trim();
  if (!/^127\.0\.0\.1:\d+$/.test(mapping)) throw new Error('unexpected private port mapping');
  const uri = `bolt://${mapping}`;
  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    const driver = neo4j.driver(uri, undefined, { connectionTimeout: 1000, connectionAcquisitionTimeout: 1500, maxTransactionRetryTime: 0 });
    try { await driver.verifyConnectivity(); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    finally { await driver.close(); }
  }
  if (!ready) throw new Error('private Neo4j did not become ready');
  results = await runIntegration({ uri, auth: 'none', database: 'neo4j' }, scratch);
} catch (error) {
  failure = { name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 2000) };
  // Only this fixture's assertions/database are involved; no existing store or credentials are read.
  console.error(`integration failed: ${failure.message}`);
  process.exitCode = 1;
} finally {
  try { await stop(); } catch { failure ??= { message: 'owned_container_cleanup_failed' }; process.exitCode = 1; }
  const report = { started_at: startedAt, finished_at: new Date().toISOString(),
    fixture: 'disposable Neo4j 5.26.14; fictional content; deterministic HTTP model fixtures',
    semantic_quality_measured: false, tests: results, failure,
    owned_container: name, container_stopped: stopped, scratch };
  await mkdir('.memory-local', { recursive: true, mode: 0o700 });
  const reportPath = `.memory-local/integration-${startedAt.replaceAll(':', '-')}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`integration report: ${reportPath}`);
  if (!failure) console.log(`integration: ${results.length} checks passed; private container stopped=${stopped}`);
}
