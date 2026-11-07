import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNamespaceDocker } from '../pi-extension/namespace-docker.mjs';
import { runNamespaceHarness } from '../pi-extension/namespace-harness.mjs';
import { openUnixEmbeddingRelay } from '../pi-extension/unix-relay.mjs';
import { openDockerMemory } from '../pi-extension/docker-memory.mjs';
import { ensureIndexed } from '../pi-extension/index-readiness.mjs';
import { prepareReferenceSnapshot } from '../pi-extension/evaluation/reference-import.mjs';
import { identity, namespace, normalizeTurn } from '../src/core.mjs';
const scope = 'fiction', ns = namespace(scope), ev = entry_id => ({ source_key: 'fiction-source', entry_id });
const turn = normalizeTurn({ source: 'fiction', conversation_id: 'fiction', turn_id: 'a', lineage_root: true,
  entries: [{ id: 'a', role: 'user', text: 'A fictional source entry.' }] });
const uid = identity('turn', scope, turn.source, turn.conversation_id, turn.turn_id);
const source = { schema: 'source-memory-logical-snapshot/v1', scope,
  nodes: [{ uid, labels: ['SMTurn', `${ns}Turn`], properties: { uid, scope, body: JSON.stringify(turn), text: turn.entries[0].text } }], relationships: [] };
const reference = { schema: 'source-memory-r2-reference-cut/v1', source_key: 'fiction-source', scope, through_entry_id: 'a',
  records: [{ id: 'action', kind: 'action', text: 'Fictional action.', evidence: [ev('a')] },
    { id: 'outcome', kind: 'outcome', text: 'Fictional outcome.', evidence: [ev('a')] },
    { id: 'unlinked', kind: 'outcome', text: 'Fictional unlinked outcome.', evidence: [ev('a')] },
    { id: 'decision', kind: 'decision', text: 'Fictional decision.', evidence: [ev('a')] }],
  edges: [{ from: 'outcome', to: 'action', type: 'outcome_of', evidence: [ev('a')] },
    { from: 'unlinked', to: 'decision', type: 'outcome_of', evidence: [ev('a')] }] };
const prepared = prepareReferenceSnapshot({ snapshot: source, reference, sourceKey: 'fiction-source', through: 'a' });
const dir = mkdtempSync(join(tmpdir(), 'pi-reference-fixture-')), root = realpathSync(process.cwd()), runId = randomUUID();
const bytes = Buffer.from(JSON.stringify(prepared.snapshot)), digest = createHash('sha256').update(bytes).digest('hex');
writeFileSync(join(dir, 'reference.json'), bytes, { mode: 0o600 }); mkdirSync(join(dir, 'intents'), { mode: 0o700 });
writeFileSync(join(dir, 'config.json'), JSON.stringify({ neo4j: { uri: 'bolt://127.0.0.1:7687', auth: 'none' }, scopes: { read: [scope], write: [scope] },
  embedding: { url: 'http://127.0.0.1:18080/v1/embeddings', model: 'embeddinggemma', dimensions: 768 }, index_on_write: false }), { mode: 0o600 });
const image = name => execFileSync('/usr/bin/docker', ['image', 'inspect', name, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
const docker = createNamespaceDocker({ databaseImage: image('neo4j:5.26.14-community'), driverImage: image('node:22-bookworm-slim'),
  mounts: { memory: root, scratch: dir }, runId, onResource: row => appendFileSync(join(dir, 'resources.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 }) });
const relay = { open: ({ socketPath }) => openUnixEmbeddingRelay({ socketPath, fetchFn: async (_url, options) => {
  const input = JSON.parse(options.body).input;
  return new Response(JSON.stringify({ model: 'embeddinggemma', data: input.map((_item, index) => ({ index, embedding: [1, ...Array(767).fill(0)] })) }));
} }) };
const result = await runNamespaceHarness({ docker, relay, socketPath: join(dir, 'embeddings.sock'), shimPort: 18080,
  warm: { model: 'embeddinggemma', dimensions: 768 }, memoryFactory: async ({ driver }) => openDockerMemory({ containerId: driver, scope,
    configPath: '/scratch/config.json', intentDir: '/scratch/intents', spawnFn(program, args, options) {
      const child = spawn(program, args, options); child.stderr.resume(); return child;
    } }),
  async work({ memory, driver }) {
    const restored = JSON.parse(execFileSync('/usr/bin/docker', ['exec', driver, '/usr/local/bin/node', '/memory/pi-extension/restore-scope.mjs',
      '/scratch/reference.json', digest, scope], { encoding: 'utf8', timeout: 180000 }));
    if (!restored.equivalent) throw new Error('reference_restore_failed');
    await ensureIndexed(memory, scope, { status: 'deferred' }, { batchLimit: 16 });
    const status = await memory.status(scope);
    let records;
    for (let i = 0; i < 30; i++) {
      try { records = await memory.searchDerived(scope, { query: 'Fictional', limit: 8 }); break; }
      catch (error) { if (error.code !== 'search_incomplete') throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (status.records !== 4 || status.relations !== 1 || status.unindexed !== 0 || records?.length !== 4) throw new Error('reference_read_failed');
    return { restored, record_count: status.records, relation_count: status.relations, retrieved: records.length,
      unlinked_outcome_preserved: prepared.snapshot.nodes.some(row => row.properties?.record_id === 'unlinked'), audit: prepared.audit };
  } });
console.log(JSON.stringify({ status: result.status, result: result.result ?? null, run_id: runId, receipt_dir: dir }));
if (result.status !== 'complete') process.exitCode = 1;
