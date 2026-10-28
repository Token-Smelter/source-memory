import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = readFileSync(new URL('./fixtures/pi-extension-steer.jsonl', import.meta.url), 'utf8').trimEnd().split('\n');
const load = () => import('../pi-extension/incremental.mjs');
async function local(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-memory-incremental-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('incrementally appending three turns preserves source IDs and one private session ID', () => local(async dir => {
  const { createIncrementalSession } = await load();
  const source = join(dir, 'source.jsonl');
  writeFileSync(source, fixture.slice(0, 2).join('\n') + '\n');
  const copy = await createIncrementalSession({ source, workDir: dir, sessionId: 'fictional-private-id' });
  for (const [end, leaf] of [[2, 'u1'], [6, 'a2'], [8, 'a3']]) {
    writeFileSync(source, fixture.slice(0, end).join('\n') + '\n');
    await copy.syncThrough(leaf);
  }
  const lines = readFileSync(copy.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([lines[0].id, lines.slice(1).map(row => row.id)], ['fictional-private-id', fixture.slice(1).map(line => JSON.parse(line).id)]);
}));

test('source prefix reserialization rebuilds the private copy without changing session ID', () => local(async dir => {
  const { createIncrementalSession } = await load();
  const source = join(dir, 'source.jsonl');
  writeFileSync(source, fixture.slice(0, 6).join('\n') + '\n');
  const copy = await createIncrementalSession({ source, workDir: dir, sessionId: 'fictional-private-id' });
  await copy.syncThrough('a2');
  const changed = fixture.map(line => JSON.stringify(JSON.parse(line), null, 0).replaceAll(':', ': '));
  writeFileSync(source, changed.join('\n') + '\n');
  const result = await copy.syncThrough('a3');
  assert.deepEqual([result.rebuilt, JSON.parse(readFileSync(copy.file, 'utf8').split('\n')[0]).id], [true, 'fictional-private-id']);
}));

test('source entry collision with an existing task side branch is refused', () => local(async dir => {
  const { createIncrementalSession } = await load();
  const source = join(dir, 'source.jsonl');
  writeFileSync(source, fixture.slice(0, 6).join('\n') + '\n');
  const copy = await createIncrementalSession({ source, workDir: dir, sessionId: 'fictional-private-id' });
  await copy.syncThrough('a2');
  const { appendFileSync } = await import('node:fs');
  appendFileSync(copy.file, JSON.stringify({ type: 'message', id: 'u3', parentId: 'a2', message: { role: 'user', content: 'fiction task' } }) + '\n');
  writeFileSync(source, fixture.join('\n') + '\n');
  await assert.rejects(copy.syncThrough('a3'), /entry_id_collision/);
}));

test('replay invokes the same incremental core across successive leaves', () => local(async dir => {
  const { createIncrementalSession } = await load();
  const { replay } = await import('../pi-extension/replay.mjs');
  const source = join(dir, 'source.jsonl');
  writeFileSync(source, fixture.join('\n') + '\n');
  const incremental = await createIncrementalSession({ source, workDir: dir, sessionId: 'fictional-private-id' });
  const turns = [];
  const session = { conversation_id: 'fiction', scopes: ['private'], entries: fixture.slice(1).map(JSON.parse),
    memory: { async ingest(_scope, turn) { turns.push(turn); return { id: `turn-${turns.length}` }; } },
    distiller: { async run({ throughEntryId }) { await incremental.syncThrough(throughEntryId); return { status: 'complete' }; } } };
  const result = await replay(session, ['a2', 'a3'], null);
  assert.deepEqual([result.cursor, turns.map(turn => turn.entries.map(entry => entry.id))],
    ['a3', [['u1', 'a1', 't1', 'u2', 'a2'], ['u3', 'a3']]]);
}));

test('incremental private session reopens each source leaf with no prior task or future source context', () => local(async dir => {
  const { createIncrementalSession } = await load();
  const { createPiDistiller } = await import('../pi-extension/pi-runtime.mjs');
  const { appendFileSync } = await import('node:fs');
  const source = join(dir, 'source.jsonl');
  writeFileSync(source, fixture.join('\n') + '\n');
  const incremental = await createIncrementalSession({ source, workDir: dir, sessionId: 'fictional-private-id' });
  const contexts = [];
  let serial = 0;
  const pi = { SessionManager: { open(file) {
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    const byId = new Map(rows.slice(1).map(row => [row.id, row]));
    return { getSessionId: () => rows[0].id, branch(id) { this.leaf = id; }, buildSessionContext() {
      const path = []; for (let id = this.leaf; id; id = byId.get(id).parentId) path.unshift(byId.get(id));
      return { messages: path.filter(row => row.message).map(row => ({ ...row.message, source_id: row.id })) };
    }, appendTask() { appendFileSync(file, JSON.stringify({ type: 'message', id: `task-${++serial}`, parentId: this.leaf,
      message: { role: 'user', content: 'fiction task sentinel' } }) + '\n'); } };
  } }, async createAgentSession({ sessionManager }) {
    return { session: { sessionId: 'fictional-private-id', agent: { sessionId: 'fictional-private-id', state: {} }, messages: [], async prompt() {
      contexts.push(this.agent.state.messages.map(row => row.source_id)); sessionManager.appendTask();
      this.messages = [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'fiction result' }] }];
    } } };
  } };
  const runtime = await createPiDistiller({ pi, incremental, workDir: dir, model: {}, memory: {}, scope: 'private' });
  for (const leaf of ['a2', 'a3']) await runtime.run({ throughEntryId: leaf, turn: { turn_id: leaf, entries: [] }, receipt: { id: 'turn' } });
  assert.deepEqual(contexts, [['u1', 'a1', 't1', 'u2', 'a2'], ['u1', 'a1', 't1', 'u2', 'a2', 'u3', 'a3']]);
}));

test('task side branches do not become ancestors of later source entries', () => local(async dir => {
  const { createIncrementalSession } = await load();
  const source = join(dir, 'source.jsonl');
  writeFileSync(source, fixture.slice(0, 6).join('\n') + '\n');
  const copy = await createIncrementalSession({ source, workDir: dir, sessionId: 'fictional-private-id' });
  await copy.syncThrough('a2');
  const { appendFileSync } = await import('node:fs');
  appendFileSync(copy.file, JSON.stringify({ type: 'message', id: 'task', parentId: 'a2', message: { role: 'user', content: 'fiction task' } }) + '\n');
  writeFileSync(source, fixture.join('\n') + '\n');
  await copy.syncThrough('a3');
  const byId = new Map(readFileSync(copy.file, 'utf8').trim().split('\n').slice(1).map(line => { const row = JSON.parse(line); return [row.id, row]; }));
  assert.deepEqual([byId.get('task').parentId, byId.get('u3').parentId, byId.get('a3').parentId], ['a2', 'a2', 'u3']);
}));
