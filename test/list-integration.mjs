import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Memory } from '../src/memory.mjs';
import { identity } from '../src/core.mjs';
import { main } from '../bin/memory.mjs';

const turn = (conversation, id, parent = null) => ({ source: 'list-fixture', conversation_id: conversation, turn_id: id,
  ...(parent ? { parent_turn_id: parent } : { lineage_root: true }), occurred_at: '2026-03-04T05:06:07Z',
  entries: [{ id: `${id}-u`, role: 'user', text: `Fictional note ${id}.` }, { id: `${id}-a`, role: 'assistant', text: `Ack ${id}.` }] });

async function walk(memory, scope, input = {}) {
  const pages = [];
  let cursor;
  do {
    const page = await memory.list(scope, { ...input, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    cursor = page.next_cursor;
  } while (cursor);
  return pages;
}
const keyOf = item => [item.stored_at ?? '', item.kind === 'turn' ? item.id : identity('record', item.scope, item.id)];
const ids = pages => pages.flatMap(page => page.items.map(item => `${item.scope}:${item.id}`));

export async function runList(database, scratch = null) {
  const results = [];
  const check = async (name, fn) => { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); };
  const grants = ['lst', 'lst/**', 'lst/a b'];
  const config = { neo4j: database, scopes: { read: grants, write: grants } };
  const memory = new Memory(config);
  const seed = async (scope, conversation, turnIds, records = []) => {
    const uids = [];
    let parent = null;
    for (const id of turnIds) { uids.push((await memory.ingest(scope, turn(conversation, id, parent))).id); parent = id; }
    if (records.length) await memory.enrich(scope, { records: records.map(([id, kind]) => ({ id, kind, text: `Fictional ${kind} ${id}.`, attribution: 'fixture',
      evidence: [{ turn: uids[0], entry_id: `${turnIds[0]}-u`, start: 0, end: 10 }] })), relations: [] });
    return uids;
  };
  try {
    for (const scope of ['lst', 'lst/a b']) await memory.init(scope);
    await memory.init('lst/a');
    await seed('lst', 'c-root', ['r1', 'r2'], [['d1', 'decision'], ['e1', 'episode'], ['d2', 'decision']]);
    await seed('lst/a', 'c-a', ['a1'], [['d1', 'decision']]);
    await seed('lst/a/b', 'c-b', ['b1', 'b2'], [['e2', 'episode']]);
    await seed('lst/a b', 'c-odd', ['o1'], [['d9', 'decision']]);

    await check('list walks an exact flat scope newest first by (stored_at, uid), every item once', async () => {
      const pages = await walk(memory, 'lst', { limit: 2 });
      const items = pages.flatMap(page => page.items);
      assert.equal(items.length, 5);
      assert.deepEqual(new Set(ids(pages)).size, 5);
      const keys = items.map(keyOf);
      for (let index = 1; index < keys.length; index += 1) {
        const [at, uid] = keys[index - 1];
        const [nextAt, nextUid] = keys[index];
        assert.ok(Date.parse(at) > Date.parse(nextAt) || (at === nextAt && uid > nextUid), `order at ${index}`);
      }
      assert.deepEqual(items.find(item => item.kind === 'turn' && item.turn_id === 'r2'), { kind: 'turn', scope: 'lst',
        id: identity('turn', 'lst', 'list-fixture', 'c-root', 'r2'), source: 'list-fixture', conversation_id: 'c-root', turn_id: 'r2',
        parent_turn_id: 'r1', occurred_at: '2026-03-04T05:06:07Z', stored_at: items.find(item => item.turn_id === 'r2').stored_at, entry_count: 2 });
    });

    await check('a subtree list selects by path membership before any migration and keeps opaque names out', async () => {
      const all = ids(await walk(memory, 'lst/**', { limit: 3 }));
      assert.equal(all.length, 10);
      assert.ok(!all.some(id => id.startsWith('lst/a b:')));
      assert.deepEqual(ids(await walk(memory, 'lst/a/**', { kind: 'episode' })), ['lst/a/b:e2']);
      assert.deepEqual(ids(await walk(memory, 'lst/**', { kind: 'decision', conversation_id: 'c-a' })), ['lst/a:d1']);
      assert.equal((await memory.list('lst/**', { kind: 'turn', source: 'list-fixture', conversation_id: 'c-b' })).items.length, 2);
    });

    await check('an append during a walk is never returned twice and every earlier item is returned once', async () => {
      const first = await memory.list('lst/**', { limit: 4 });
      await seed('lst/a', 'c-late', ['late1']);
      const rest = await walk(memory, 'lst/**', { limit: 4, cursor: first.next_cursor });
      const walked = [...ids([first]), ...ids(rest)];
      assert.equal(new Set(walked).size, walked.length);
      assert.equal(walked.length, 10);
      assert.ok(!walked.some(id => id.endsWith(identity('turn', 'lst/a', 'list-fixture', 'c-late', 'late1'))));
      assert.equal(ids(await walk(memory, 'lst/**')).length, 11);
    });

    await check('a node without created_at lists last with a null stored_at', async () => {
      const uid = identity('turn', 'lst', 'list-fixture', 'c-old', 'old');
      const body = JSON.stringify({ source: 'list-fixture', conversation_id: 'c-old', turn_id: 'old', parent_turn_id: null, occurred_at: null,
        entries: [{ id: 'u', role: 'user', text: 'Old fictional turn.', occurred_at: null }] });
      await memory.store.transaction('write', tx => tx.run(`CREATE (t:SMTurn {uid:$uid, scope:'lst', hash:'h', body:$body, text:'[user] Old fictional turn.',
        lineage:true, source:'list-fixture', conversation_id:'c-old', turn_key:'old', chunked:true})`, { uid, body }));
      const items = (await walk(memory, 'lst', { limit: 64 })).flatMap(page => page.items);
      assert.deepEqual([items.at(-1).id, items.at(-1).stored_at, items.at(-1).turn_id], [uid, null, 'old']);
    });

    await check('the CLI lists a subtree from a file or empty input and refuses a foreign cursor', async () => {
      if (!scratch) return;
      const configPath = join(scratch, 'list-config.json');
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      const run = async (scope, input) => {
        const inputPath = join(scratch, 'list-input.json');
        await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
        let out = '';
        await main(['list', '--config', configPath, '--scope', scope, '--input', inputPath], { stdout: { write: chunk => { out += chunk; } } });
        return JSON.parse(out);
      };
      const reply = await run('lst/**', { kind: 'episode', limit: 1 });
      assert.deepEqual([reply.ok, reply.kind, reply.items.length, typeof reply.next_cursor], [true, 'list', 1, 'string']);
      await assert.rejects(run('lst', { cursor: reply.next_cursor }), { code: 'invalid_input' });
    });
  } finally { await memory.close(); }
  return results;
}
