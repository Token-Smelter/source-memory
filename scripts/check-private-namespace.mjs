import { execFileSync, spawn } from 'node:child_process';
import { closeSync, constants, fsyncSync, mkdtempSync, mkdirSync, openSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNamespaceDocker } from '../pi-extension/namespace-docker.mjs';
import { runNamespaceHarness } from '../pi-extension/namespace-harness.mjs';
import { openUnixEmbeddingRelay } from '../pi-extension/unix-relay.mjs';
import { openDockerMemory } from '../pi-extension/docker-memory.mjs';

// This opt-in smoke uses only invented content, an in-memory embedding response and owned disposable containers.
const scratch = mkdtempSync(join(tmpdir(), 'pi-private-namespace-'));
const root = realpathSync(process.cwd());
const runId = randomUUID();
let result;
let receipt;
try {
  receipt = openSync(join(scratch, 'resources.jsonl'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  const directory = openSync(scratch, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
  const onResource = event => {
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
    for (let offset = 0; offset < bytes.length;) offset += writeSync(receipt, bytes, offset, bytes.length - offset);
    fsyncSync(receipt);
  };
  mkdirSync(join(scratch, 'intents'), { mode: 0o700 });
  writeFileSync(join(scratch, 'config.json'), JSON.stringify({ neo4j: { uri: 'bolt://127.0.0.1:7687', auth: 'none' },
    scopes: { read: ['fiction'], write: ['fiction'] }, chunking: { words: 256, overlap: 32 },
    embedding: { url: 'http://127.0.0.1:18080/v1/embeddings', model: 'fictional-embedding', dimensions: 2 }, index_on_write: true }), { mode: 0o600 });
  const image = name => execFileSync('/usr/bin/docker', ['image', 'inspect', name, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
  const docker = createNamespaceDocker({ databaseImage: image('neo4j:5.26.14-community'), driverImage: image('node:22-bookworm-slim'),
    mounts: { memory: root, scratch }, runId, onResource });
  let relayCalls = 0;
  const relay = { async open({ socketPath }) { return openUnixEmbeddingRelay({ socketPath, fetchFn: async (_url, options) => {
    relayCalls++;
    const input = JSON.parse(options.body).input;
    return new Response(JSON.stringify({ model: 'fictional-embedding', data: input.map((_item, index) => ({ index, embedding: [1, 0] })) }));
  } }); } };
  result = await runNamespaceHarness({ docker, relay, socketPath: join(scratch, 'embeddings.sock'), shimPort: 18080,
    memoryFactory: async ({ driver }) => openDockerMemory({ containerId: driver, scope: 'fiction', configPath: '/scratch/config.json', intentDir: '/scratch/intents',
      spawnFn(program, args, options) {
        const child = spawn(program, args, options);
        child.stderr.on('data', data => process.stderr.write(data));
        return child;
      } }),
    async onIsolation(gate) { writeFileSync(join(scratch, 'isolation.json'), JSON.stringify(gate), { mode: 0o600 }); },
    async work({ memory }) {
      const stored = await memory.ingest('fiction', { source: 'pi-memory', conversation_id: 'fictional-session', turn_id: 'fictional-turn',
        lineage_root: true, entries: [{ id: 'fictional-entry', role: 'user', text: 'The amber fictional key requires rotation.' }] });
      const recalled = await memory.recall('fiction', { query: 'amber fictional key', limit: 8 });
      return { retained: stored.retained, indexing: stored.indexing?.status, recall_status: recalled.status,
        returned: recalled.bundles?.length ?? 0, relay_calls: relayCalls };
    } });
  if (result.status !== 'complete' || result.result?.retained !== true || result.result.indexing !== 'ready'
    || result.result.returned < 1 || result.result.relay_calls < 1) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify({ ...result, run_id: runId, private_receipt_dir: scratch })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', code: error?.code ?? 'smoke_failed' })}\n`);
  process.exitCode = 1;
} finally {
  if (receipt !== undefined) closeSync(receipt);
  process.stderr.write(`private smoke receipts retained at ${scratch}\n`);
}
