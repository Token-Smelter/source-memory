import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import neo4j from 'neo4j-driver';
import { runIntegration } from '../test/integration.mjs';
import { runQualification } from '../test/qualification.mjs';
import { runNestedScopes } from '../test/nested-scopes.mjs';
import { runList } from '../test/list-integration.mjs';
import { integrationResources } from './integration-resources.mjs';

const exec = promisify(execFile);
// `--suite qualification` runs only Q-SM-1…6 and `--suite scopes` only the nested-scope checks; the default runs the
// integration checks, the nested-scope checks and then the qualification.
const suiteIndex = process.argv.indexOf('--suite');
const suite = suiteIndex === -1 ? 'all' : process.argv[suiteIndex + 1];
if (!['all', 'qualification', 'scopes'].includes(suite)) throw new Error('--suite must be qualification or scopes');
const runId = randomUUID();
const name = `source-memory-test-${runId}`;
const scratch = await mkdtemp(join(tmpdir(), 'source-memory-test-'));
const receiptPath = join(scratch, 'resources.jsonl');
const receipt = openSync(receiptPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
const directory = openSync(scratch, constants.O_RDONLY | constants.O_DIRECTORY);
try { fsyncSync(directory); } finally { closeSync(directory); }
const record = event => {
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
  for (let offset = 0; offset < bytes.length;) offset += writeSync(receipt, bytes, offset, bytes.length - offset);
  fsyncSync(receipt);
};
const resources = integrationResources({ runId, execute: exec, record });
const startedAt = new Date().toISOString();
let creationInFlight = false;
let creationUnknown = false;
let stopped = false;
let results = [];
let failure = null;
let container = null;

async function stop() {
  if (stopped) return;
  if (creationInFlight || creationUnknown) throw new Error('owned_resource_creation_unknown');
  await resources.cleanup();
  stopped = true;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  try { await stop(); } finally { process.exit(130); }
});

try {
  await mkdir('.memory-local', { recursive: true, mode: 0o700 });
  creationInFlight = true;
  try { await resources.create(); }
  catch (error) { creationUnknown = ['creation_unknown', 'resource_receipt_unknown'].includes(error.code); throw error; }
  finally { creationInFlight = false; }
  const mapping = (await exec('docker', ['port', name, '7687/tcp'], { timeout: 10000 })).stdout.trim();
  if (!/^127\.0\.0\.1:\d+$/.test(mapping)) throw new Error('unexpected private port mapping');
  const uri = `bolt://${mapping}`;
  const image = (await exec('docker', ['inspect', '--format', '{{.Config.Image}}', name], { timeout: 10000 })).stdout.trim();
  const authTemplate = '{{range .Config.Env}}{{if eq (index (split . "=") 0) "NEO4J_AUTH"}}{{if eq . "NEO4J_AUTH=none"}}none{{else}}other{{end}}{{end}}{{end}}';
  const authOut = (await exec('docker', ['inspect', '--format', authTemplate, name], { timeout: 10000 })).stdout.trim();
  const auth = authOut === 'none' ? 'none' : 'other';
  const hostPort = Number(mapping.split(':')[1]);
  container = { image, host_port: hostPort, auth };
  console.log(`integration container: image=${image} port=127.0.0.1:${hostPort} auth=${auth}`);
  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    const driver = neo4j.driver(uri, undefined, { connectionTimeout: 1000, connectionAcquisitionTimeout: 1500, maxTransactionRetryTime: 0 });
    try { await driver.verifyConnectivity(); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    finally { await driver.close(); }
  }
  if (!ready) throw new Error('private Neo4j did not become ready');
  const database = { uri, auth: 'none', database: 'neo4j' };
  // Nested scopes run first: the flat integration checks then also run beside existing root trees.
  if (suite !== 'qualification') results = [...await runNestedScopes(database, scratch), ...await runList(database, scratch)];
  if (suite === 'all') results = [...results, ...await runIntegration(database, scratch)];
  if (suite !== 'scopes') results = [...results, ...await runQualification(database, scratch)];
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
    owned_container: name, container, container_stopped: stopped, resource_receipt: receiptPath, creation_unknown: creationUnknown, scratch };
  const reportPath = `.memory-local/integration-${startedAt.replaceAll(':', '-')}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`integration report: ${reportPath}`);
  closeSync(receipt);
  if (!failure) console.log(`integration: ${results.length} checks passed; private container stopped=${stopped}`);
}
