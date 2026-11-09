import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Memory } from '../src/memory.mjs';
import { identity } from '../src/core.mjs';
import { fileURLToPath } from 'node:url';
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
  const grants = ['lst', 'lst/**', 'lst/a b', 'tie', 'legacy', 'stat'];
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

    await check('items sharing a write time, and untimed items, page one at a time in descending uid order', async () => {
      const raw = (uid, createdAt) => memory.store.transaction('write', tx => tx.run(`CREATE (t:SMTurn {uid:$uid, scope:'tie', hash:'h',
        body:'{"source":"tie","conversation_id":"c","turn_id":"x","parent_turn_id":null,"occurred_at":null,"entries":[]}', text:'',
        lineage:true, source:'tie', conversation_id:'c', turn_key:$uid}) SET t.created_at = $at`, { uid, at: createdAt }));
      for (const uid of ['turn_t1', 'turn_t3', 'turn_t2']) await memory.store.transaction('write', tx => tx.run(`CREATE (t:SMTurn {uid:$uid, scope:'tie',
        hash:'h', body:'{}', text:'', source:'tie', conversation_id:'c', turn_key:$uid, created_at: datetime('2026-02-03T04:05:06.007Z')})`, { uid }));
      await raw('turn_u1', null);
      await raw('turn_u2', 'not a datetime');
      const pages = await walk(memory, 'tie', { limit: 1 });
      assert.deepEqual(ids(pages), ['tie:turn_t3', 'tie:turn_t2', 'tie:turn_t1', 'tie:turn_u2', 'tie:turn_u1']);
      assert.deepEqual(pages.flatMap(page => page.items.map(item => item.stored_at)),
        ['2026-02-03T04:05:06.007Z', '2026-02-03T04:05:06.007Z', '2026-02-03T04:05:06.007Z', null, null]);
    });

    await check('source filters match a legacy turn and a record citing it through the stored envelope', async () => {
      const uid = identity('turn', 'legacy', 'list-fixture', 'c-legacy', 'old');
      const body = JSON.stringify({ source: 'list-fixture', conversation_id: 'c-legacy', turn_id: 'old', parent_turn_id: null, occurred_at: null,
        entries: [{ id: 'u', role: 'user', text: 'A "quoted" ,"conversation_id":"c-other","turn_id": decoy.', occurred_at: null }] });
      await memory.store.transaction('write', tx => tx.run(`CREATE (t:SMTurn {uid:$uid, scope:'legacy', hash:'h', body:$body, text:'legacy',
        created_at: datetime()})`, { uid, body }));
      await memory.enrich('legacy', { records: [{ id: 'legacy-d', kind: 'decision', text: 'Fictional legacy decision.', attribution: 'fixture',
        evidence: [{ turn: uid, entry_id: 'u', start: 0, end: 5 }] }], relations: [] });
      assert.deepEqual(ids(await walk(memory, 'legacy', { conversation_id: 'c-legacy' })), ['legacy:legacy-d', `legacy:${uid}`]);
      assert.deepEqual(ids(await walk(memory, 'legacy', { source: 'list-fixture', kind: 'decision' })), ['legacy:legacy-d']);
      assert.deepEqual(ids(await walk(memory, 'legacy', { conversation_id: 'c-other' })), [], 'quoted text inside an entry never matches');
      const legacyTurn = (await memory.list('legacy', { kind: 'turn' })).items[0];
      assert.deepEqual([legacyTurn.source, legacyTurn.conversation_id, legacyTurn.turn_id, legacyTurn.entry_count], ['list-fixture', 'c-legacy', 'old', 1]);
    });

    await check('a status filter matches the stored status, not a decoy inside record text', async () => {
      const [uid] = await seed('stat', 'c-stat', ['s1']);
      await memory.enrich('stat', { records: [
        { id: 'accepted-1', kind: 'decision', status: 'accepted', text: 'Fictional accepted.', attribution: 'fixture', evidence: [{ turn: uid, entry_id: 's1-u', start: 0, end: 5 }] },
        { id: 'decoy-1', kind: 'decision', text: 'Decoy ,"status":"accepted","attribution": inside.', attribution: 'fixture,"kind":"episode","text":',
          evidence: [{ turn: uid, entry_id: 's1-u', start: 0, end: 5 }] }], relations: [] });
      assert.deepEqual(ids(await walk(memory, 'stat', { status: 'accepted' })), ['stat:accepted-1']);
      assert.deepEqual(ids(await walk(memory, 'stat', { status: 'proposed' })), ['stat:decoy-1']);
      assert.deepEqual(ids(await walk(memory, 'stat', { kind: 'episode' })), []);
    });

    await check('the CLI lists with or without --input, never waits on stdin, and refuses a foreign cursor', async () => {
      if (!scratch) return;
      const configPath = join(scratch, 'list-config.json');
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      const run = async (scope, input) => {
        const args = ['list', '--config', configPath, '--scope', scope];
        if (input !== undefined) {
          const inputPath = join(scratch, 'list-input.json');
          await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
          args.push('--input', inputPath);
        }
        let out = '';
        await main(args, { stdout: { write: chunk => { out += chunk; } } });
        return JSON.parse(out);
      };
      const reply = await run('lst/**', { kind: 'episode', limit: 1 });
      assert.deepEqual([reply.ok, reply.kind, reply.items.length, typeof reply.next_cursor], [true, 'list', 1, 'string']);
      await assert.rejects(run('lst', { cursor: reply.next_cursor }), { code: 'invalid_input' });
      assert.equal((await run('lst/**')).items.length, 12, 'no --input lists with defaults');
      const { execFile } = await import('node:child_process');
      const started = Date.now();
      const child = await new Promise((resolve, reject) => {
        const proc = execFile(process.execPath, [fileURLToPath(new URL('../bin/memory.mjs', import.meta.url)), 'list', '--config', configPath, '--scope', 'lst'],
          { timeout: 20000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
        proc.stdin.write('');
      });
      assert.equal(JSON.parse(child).kind, 'list');
      assert.ok(Date.now() - started < 20000, 'an open stdin pipe does not block list');
    });
  } finally { await memory.close(); }
  return results;
}
