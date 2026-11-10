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
  const grants = ['lst', 'lst/**', 'lst/a b', 'tie', 'legacy', 'stat', 'rel', 'rel/**'];
  const config = { neo4j: database, scopes: { read: grants, write: grants } };
  const memory = new Memory(config);
  const seed = async (scope, conversation, turnIds, records = [], relations = []) => {
    const uids = [];
    let parent = null;
    for (const id of turnIds) { uids.push((await memory.ingest(scope, turn(conversation, id, parent))).id); parent = id; }
    const evidence = [{ turn: uids[0], entry_id: `${turnIds[0]}-u`, start: 0, end: 10 }];
    if (records.length) await memory.enrich(scope, { records: records.map(([id, kind]) => ({ id, kind, text: `Fictional ${kind} ${id}.`, attribution: 'fixture',
      evidence })), relations: relations.map(([id, type, from, to]) => ({ id, type, from, to, attribution: 'fixture', evidence })) });
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

    await check('list relations: each page carries exactly the relations touching its records, in their own scope', async () => {
      await memory.init('rel');
      await memory.init('rel/a');
      await seed('rel', 'c-rel1', ['rel1'], [['d1', 'decision'], ['q1', 'question']], [['q1-on-d1', 'depends_on', 'q1', 'd1']]);
      await seed('rel', 'c-rel2', ['rel2'], [['d2', 'decision'], ['o1', 'observation']],
        [['d2-over-d1', 'supersedes', 'd2', 'd1'], ['o1-on-d2', 'qualifies', 'o1', 'd2']]);
      await seed('rel/a', 'c-rel3', ['rel3'], [['d1', 'decision'], ['x1', 'observation']], [['x1-vs-d1', 'contradicts', 'x1', 'd1']]);
      await seed('rel/a/b', 'c-rel4', ['rel4'], [['e1', 'episode']]);
      const fixture = [['rel', 'q1-on-d1', 'q1', 'd1'], ['rel', 'd2-over-d1', 'd2', 'd1'], ['rel', 'o1-on-d2', 'o1', 'd2'], ['rel/a', 'x1-vs-d1', 'x1', 'd1']];
      for (const [scope, input] of [['rel', { limit: 1 }], ['rel', { limit: 3, kind: 'decision' }], ['rel/**', { limit: 2 }], ['rel/a', {}], ['rel/**', { limit: 64 }]]) {
        const plain = await walk(memory, scope, input);
        const pages = await walk(memory, scope, { ...input, relations: true });
        assert.deepEqual(pages.map(page => [page.items, page.next_cursor]), plain.map(page => [page.items, page.next_cursor]), `${scope} items and cursor unchanged`);
        for (const page of pages) {
          const onPage = new Set(page.items.filter(item => item.kind === 'record').map(item => `${item.scope}:${item.id}`));
          const expected = fixture.filter(([at, , from, to]) => onPage.has(`${at}:${from}`) || onPage.has(`${at}:${to}`)).map(([at, id]) => `${at}:${id}`);
          assert.deepEqual(page.relations.map(row => `${row.scope}:${row.id}`).sort(), expected.sort(), `${scope} ${JSON.stringify(input)}`);
          assert.deepEqual([page.relations_truncated, page.relations_total], [false, expected.length]);
          assert.ok(page.relations.every(row => typeof row.stored_at === 'string' && row.evidence.length === 1 && row.evidence[0].start === 0));
          // Supersedes first, then newest first by (stored_at, uid): each key strictly precedes the next.
          const keys = page.relations.map(row => [row.type === 'supersedes' ? 0 : 1, -Date.parse(row.stored_at), identity('relation', row.scope, row.id)]);
          for (let index = 1; index < keys.length; index += 1) {
            const [a, b] = [keys[index - 1], keys[index]];
            assert.ok(a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] > b[2]))), `relation order at ${index}`);
          }
        }
      }
      const all = await memory.store.listRelations('rel', [identity('record', 'rel', 'd1'), identity('record', 'rel', 'd2')], 256);
      const cut = await memory.store.listRelations('rel', [identity('record', 'rel', 'd1'), identity('record', 'rel', 'd2')], 2);
      assert.deepEqual([all.total, all.rows.length, cut.total, cut.rows], [3, 3, 3, all.rows.slice(0, 2)], 'the store cut keeps its order and counts the rest');
      assert.equal(all.rows[0].uid, identity('relation', 'rel', 'd2-over-d1'));
      const exact = await memory.list('rel/a', { relations: true });
      assert.deepEqual(exact.relations.map(row => [row.scope, row.id, row.type, row.from, row.to]), [['rel/a', 'x1-vs-d1', 'contradicts', 'x1', 'd1']],
        'a record id shared with another scope never draws that scope\'s relations');
      const legacy = identity('relation', 'rel', 'q1-on-d1');
      await memory.store.transaction('write', tx => tx.run('MATCH (e:SMRelation {uid:$uid}) REMOVE e.created_at', { uid: legacy }));
      const page = await memory.list('rel', { kind: 'question', relations: true });
      assert.deepEqual(page.relations.map(row => [row.id, row.stored_at]), [['q1-on-d1', null]], 'a relation written before stored_at reports null');
    });

    await check('list relations: one query per page, seeking page records by uid rather than scanning or seeking by scope', async () => {
      const original = memory.store.transaction.bind(memory.store);
      const dropRangeIndexes = () => original('write', tx => tx.run('DROP INDEX smrecord_scope IF EXISTS'))
        .then(() => original('write', tx => tx.run('DROP INDEX smrelation_scope IF EXISTS')));
      try {
        for (const [scope, ranges] of [['rel', true], ['rel/**', true], ['rel', false], ['rel/**', false]]) {
          if (!ranges) await dropRangeIndexes();
          await planCheck(scope, ranges);
        }
      } finally {
        // Restore the range indexes a tree init creates for the suites that follow.
        await memory.init('rel/a');
        await original('read', tx => tx.run('CALL db.awaitIndexes(60)'));
      }
      async function planCheck(scope, ranges) {
        const queries = [];
        memory.store.transaction = (mode, action) => original(mode, tx => action({ run: (query, params) => { queries.push({ query, params }); return tx.run(query, params); } }));
        try { await memory.list(scope, { relations: true }); } finally { memory.store.transaction = original; }
        assert.equal(queries.length, 2, 'the page query and one relations query');
        const { query, params } = queries[1];
        const plan = (await original('read', tx => tx.run(`EXPLAIN ${query}`, params))).summary.plan;
        const operators = [];
        const visit = node => { operators.push(`${node.operatorType} ${node.arguments?.Details ?? ''}`); node.children.forEach(visit); };
        visit(plan);
        const seen = `${scope} ranges=${ranges}: ${operators.join(' | ')}`;
        assert.ok(operators.some(row => /^NodeUniqueIndexSeek/u.test(row) && /SMRecord\(uid\)/u.test(row)), seen);
        assert.ok(!operators.some(row => /LabelScan|AllNodesScan|smrecord_scope|smrelation_scope|\(scope\)/u.test(row)), seen);
        assert.ok(!operators.some(row => /SMRelation/u.test(row) && /Scan|IndexSeek/u.test(row.split(' ')[0])), `${seen}: relations are reached by their edges`);
      }
    });

    await check('list relations on a store without the uid constraint ignores the hint and returns the same relations', async () => {
      const before = await memory.list('rel', { relations: true });
      const schema = async kind => (await memory.store.transaction('read', tx => tx.run(`SHOW ${kind} YIELD name, labelsOrTypes, properties
        WHERE labelsOrTypes = ['SMRecord'] AND properties = ['uid'] RETURN name`))).records.map(row => row.get('name'));
      const dropped = [];
      for (const name of await schema('CONSTRAINTS')) { await memory.store.transaction('write', tx => tx.run(`DROP CONSTRAINT ${name}`)); dropped.push(name); }
      for (const name of await schema('INDEXES')) { await memory.store.transaction('write', tx => tx.run(`DROP INDEX ${name}`)); dropped.push(name); }
      try {
        assert.deepEqual(await schema('INDEXES'), [], `dropped ${dropped}`);
        assert.deepEqual(await memory.list('rel', { relations: true }), before, `dropped ${dropped}`);
      } finally { await memory.init('rel'); }
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
