import { execFileSync, spawn } from 'node:child_process';
import { closeSync, constants, fsyncSync, mkdtempSync, mkdirSync, openSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNamespaceDocker } from '../pi-extension/namespace-docker.mjs';
import { runNamespaceHarness } from '../pi-extension/namespace-harness.mjs';
import { openUnixEmbeddingRelay } from '../pi-extension/unix-relay.mjs';
import { openDockerMemory } from '../pi-extension/docker-memory.mjs';
import { ensureIndexed } from '../pi-extension/index-readiness.mjs';

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
    warm: { model: 'fictional-embedding', dimensions: 2 },
    memoryFactory: async ({ driver }) => openDockerMemory({ containerId: driver, scope: 'fiction', configPath: '/scratch/config.json', intentDir: '/scratch/intents',
      spawnFn(program, args, options) {
        const child = spawn(program, args, options);
        child.stderr.on('data', data => process.stderr.write(data));
        return child;
      } }),
    async onIsolation(gate) { writeFileSync(join(scratch, 'isolation.json'), JSON.stringify(gate), { mode: 0o600 }); },
    async work({ memory, driver }) {
      const stored = await memory.ingest('fiction', { source: 'pi-memory', conversation_id: 'fictional-session', turn_id: 'fictional-turn',
        lineage_root: true, entries: [{ id: 'fictional-entry', role: 'user', text: 'The amber fictional key requires rotation.' }] });
      const recalled = await memory.recall('fiction', { query: 'amber fictional key', limit: 8 });
      const firstRecord = await memory.enrich('fiction', { records: [{ id: 'fictional-record', kind: 'observation', text: 'The amber key requires rotation.',
        status: 'proposed', attribution: 'fiction', evidence: [{ turn: stored.id, entry_id: 'fictional-entry', start: 0, end: 42 }] }], relations: [] }, { trigger: stored.id });
      await ensureIndexed(memory, 'fiction', firstRecord.indexing, { waitForVectors: true, recordIds: firstRecord.records });
      let derived;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { derived = await memory.searchDerived('fiction', { query: 'amber key rotation', limit: 8 }); break; }
        catch (error) { if (error.code !== 'search_incomplete') throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
      }
      if (!derived?.length) throw new Error('derived_search_failed');
      const resolved = await memory.resolveDerived('fiction', { item_id: derived[0].id, evidence_id: derived[0].evidence[0].id });
      const updateText = 'Only during rehearsal, rotate the amber fictional key weekly.';
      const later = await memory.ingest('fiction', { source: 'pi-memory', conversation_id: 'fictional-session', turn_id: 'fictional-next',
        entries: [{ id: 'fictional-update', role: 'user', text: updateText }] });
      const updateRecord = await memory.enrich('fiction', { records: [{ id: 'fictional-update-record', kind: 'observation', text: updateText,
        status: 'proposed', attribution: 'fiction', evidence: [{ turn: later.id, entry_id: 'fictional-update', start: 0, end: updateText.length }] }], relations: [] }, { trigger: later.id });
      await ensureIndexed(memory, 'fiction', updateRecord.indexing, { waitForVectors: true, recordIds: updateRecord.records });
      const offer = await memory.beginLinks('fiction', later.id, ['fictional-update-record']);
      const from = offer.packet.records.find(row => row.newly_retained)?.ref;
      const to = offer.packet.records.find(row => !row.newly_retained && row.text === 'The amber key requires rotation.')?.ref;
      const source = offer.packet.sources.find(row => row.trigger && row.text === updateText)?.ref;
      if (!from || !to || !source) throw new Error('link_fixture_unavailable');
      const proposal = await memory.finishLinks(offer.token, JSON.stringify({ links: [{ from, to, type: 'qualifies', evidence: [source], support: 'explicit' }] }),
        { provider: 'fiction', model: 'fixture' });
      const review = { reviewer: 'fictional-reviewer', decision_ref: 'fictional-review', contract: proposal.contract, scope: 'fiction',
        review_contract: proposal.review_contract, operation_id: proposal.operation_id, context_sha256: proposal.context_sha256,
        semantic_proposal_sha256: proposal.semantic_proposal_sha256, proposal_sha256: proposal.proposal_sha256, approved: [0] };
      const linked = await memory.applyLinks(offer.token, review);
      const actionText = 'The fictional beacon was inspected and the test passed.';
      const actionTurn = await memory.ingest('fiction', { source: 'pi-memory', conversation_id: 'fictional-session', turn_id: 'fictional-outcome',
        entries: [{ id: 'fictional-outcome-source', role: 'user', text: actionText }] });
      const actionEvidence = [{ turn: actionTurn.id, entry_id: 'fictional-outcome-source', start: 0, end: actionText.length }];
      const newAction = { id: 'fictional-action', kind: 'action', text: 'Inspect the fictional beacon.', status: 'proposed', attribution: 'fiction', evidence: actionEvidence };
      const newOutcome = { id: 'fictional-outcome-record', kind: 'outcome', text: 'The fictional beacon test passed.', status: 'proposed', attribution: 'fiction', evidence: actionEvidence };
      const atomic = await memory.beginOutcome('fiction', actionTurn.id, newOutcome, newAction, null);
      const atomicResult = await memory.applyOutcome('fiction', atomic.token, null);
      const followText = 'The fictional beacon inspection later confirmed another pass.';
      const follow = await memory.ingest('fiction', { source: 'pi-memory', conversation_id: 'fictional-session', turn_id: 'fictional-prior-outcome',
        entries: [{ id: 'fictional-prior-source', role: 'user', text: followText }] });
      const priorSearch = await memory.recall('fiction', { query: 'fictional beacon inspected', limit: 8 }, { trigger: follow.id });
      const priorHandle = priorSearch.bundles.flatMap(row => row.records).find(row => row.id === 'fictional-action')?.action_handle;
      if (!priorHandle) throw new Error('prior_action_unavailable');
      const priorOutcome = { id: 'fictional-prior-outcome-record', kind: 'outcome', text: 'Another fictional test passed.', status: 'proposed', attribution: 'fiction',
        evidence: [{ turn: follow.id, entry_id: 'fictional-prior-source', start: 0, end: followText.length }] };
      const priorProposal = await memory.beginOutcome('fiction', follow.id, priorOutcome, null, priorHandle);
      const priorReview = { reviewer: 'separate:fiction', decision_ref: 'fictional-review', proposal_sha256: priorProposal.proposal.proposal_sha256, approved: [0] };
      const priorResult = await memory.applyOutcome('fiction', priorProposal.token, priorReview);
      const snapshot = await docker.snapshot({ driver, scope: 'fiction', filename: `baseline-${runId}.json` });
      return { retained: stored.retained, indexing: stored.indexing?.status, recall_status: recalled.status,
        returned: recalled.bundles?.length ?? 0, derived_returned: derived.length,
        evidence_resolved: resolved.text === 'The amber fictional key requires rotation.', link_status: linked.status,
        atomic_new_status: atomicResult.status, atomic_prior_status: priorResult.status, snapshot, relay_calls: relayCalls };
    } });
  if (result.status !== 'complete' || result.result?.retained !== true || result.result.indexing !== 'ready'
    || result.result.returned < 1 || result.result.derived_returned < 1 || result.result.evidence_resolved !== true
    || result.result.link_status !== 'written' || result.result.atomic_new_status !== 'written' || result.result.atomic_prior_status !== 'written'
    || result.result.snapshot?.nodes < 1 || result.result.relay_calls < 1) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify({ ...result, run_id: runId, private_receipt_dir: scratch })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', code: error?.code ?? 'smoke_failed' })}\n`);
  process.exitCode = 1;
} finally {
  if (receipt !== undefined) closeSync(receipt);
  process.stderr.write(`private smoke receipts retained at ${scratch}\n`);
}
