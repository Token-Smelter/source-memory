import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Memory } from '../src/memory.mjs';
import { embeddingIdentity } from '../src/models.mjs';
import { CHUNK_MAX_BYTES } from '../src/core.mjs';

// Concurrency checks for embedding writeback against a disposable Neo4j. The indexer and the competing writer use separate
// drivers, so every interleaving below crosses real connections and real Neo4j locks. Content and vectors are fictional.
const gate = () => { let open; const opened = new Promise(resolve => { open = resolve; }); return { opened, open }; };
const INDEXED = [1, 0, 0], CHANGED = [0, 1, 0], COMPETING = [0, 0, 1];

export async function runEmbeddingRace(database) {
  const results = [];
  const check = async (name, fn) => { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); };
  const calls = [];
  let hold = null;
  const model = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const input = JSON.parse(body);
    calls.push(input.input);
    const barrier = hold;
    hold = null;
    if (barrier) {
      barrier.arrived.open();
      await barrier.release.opened;
      if (barrier.fail) { res.writeHead(503).end(); return; }
    }
    res.end(JSON.stringify({ model: input.model, data: input.input.map((value, index) => ({ index,
      embedding: /changed/i.test(value) ? CHANGED : INDEXED })) }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const scopes = ['race-text', 'race-key', 'race-repair', 'race-retry', 'race-defer', 'race-control', 'race-lock-text', 'race-lock-repair',
    'race-lock-retry', 'race-lock-terminal', 'race-lock-defer', 'race-lock-control', 'race-naive', 'race-prior', 'race-prior-control',
    'race-lock-prior', 'race-lock-prior-control', 'race-lossless', 'race-select', 'race-typed-cap', 'race-typed-retry', 'race-lock-cap',
    'race-lock-cap-control', 'race-bounded', 'race-context-marker'];
  const config = { neo4j: database, scopes: { read: scopes, write: scopes }, index_on_write: false,
    embedding: { url: `http://127.0.0.1:${model.address().port}/embed`, model: 'race-fixture', dimensions: 3 } };
  const key = embeddingIdentity(config.embedding);
  const indexer = new Memory(config);
  const other = new Memory(config);
  const write = (query, params) => other.store.transaction('write', tx => tx.run(query, params));
  const chunk = async scope => {
    const result = await indexer.store.transaction('read', tx => tx.run(`MATCH (c:SMChunk {scope:$scope})
      RETURN c.uid AS uid, c.text AS text, c.embedding AS vector, c.embedding_key AS key, c.embedding_retry_key AS retry_key,
        c.embedding_retry_after IS NOT NULL AS retry_after, c.embedding_oversized_key AS oversized_key, c.embedding_write_lock AS lock`, { scope }));
    assert.equal(result.records.length, 1, 'each fixture scope holds one chunk');
    return result.records[0].toObject();
  };
  const seed = async (scope, value = 'A fictional lantern note.') => {
    await indexer.init(scope);
    await indexer.ingest(scope, { source: 'race-fixture', conversation_id: scope, turn_id: 't1', entries: [{ id: 'u1', role: 'user', text: value }] });
    return chunk(scope);
  };
  // The competing writer changes the row while the indexer's model request is held open, then the request completes.
  const race = async (scope, interfere, { fail = false } = {}) => {
    const barrier = { arrived: gate(), release: gate(), fail };
    hold = barrier;
    const running = indexer.index(scope);
    await Promise.race([barrier.arrived.opened,
      running.then(reply => { throw new Error(`index returned before its model request: ${JSON.stringify(reply)}`); })]);
    await interfere();
    barrier.release.open();
    return running;
  };
  // The competing writer holds an uncommitted change, so the indexer's write must wait for that lock and then decide.
  const underLock = async (interfere, action) => {
    const session = other.store.driver.session({ database: database.database });
    const tx = session.beginTransaction();
    try {
      await interfere(tx);
      const running = action();
      await blockedOnLock();
      await tx.commit();
      return await running;
    } finally {
      if (tx.isOpen()) await tx.rollback();
      await session.close();
    }
  };
  const blockedOnLock = async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const result = await other.store.transaction('read', tx => tx.run(`SHOW TRANSACTIONS YIELD status, currentQuery
        WHERE status STARTS WITH 'Blocked' AND currentQuery CONTAINS 'SMChunk' RETURN count(*) AS blocked`));
      if (result.records[0].get('blocked') > 0) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('the indexer write never waited on the competing lock');
  };
  // A row that already holds a vector under a key other than the current one, as left by an earlier model config.
  const seedPrior = async scope => {
    const row = await seed(scope);
    await write('MATCH (c:SMChunk {scope:$scope}) SET c.embedding=$vector, c.embedding_key=$prior', { scope, vector: CHANGED, prior: 'prior-key' });
    return row;
  };
  const replacePrior = (run, scope) => run('MATCH (c:SMChunk {scope:$scope}) SET c.embedding=$vector', { scope, vector: COMPETING });
  // Discovery, then hydration of the one row: the exact state a write is guarded by.
  const observe = async (memory, scope, model = key) => {
    const hints = await memory.store.pendingEmbeddings(scope, model, 2);
    assert.equal(hints.length, 1);
    const rows = await memory.store.observeEmbeddings(scope, model, [hints[0].uid]);
    assert.equal(rows.length, 1);
    return rows[0];
  };
  const selected = scope => observe(indexer, scope);
  // Runs observeEmbeddings with the given rows as its hydration result; the judgement statement still runs on Neo4j.
  const judged = async (scope, rows) => {
    const store = indexer.store;
    store.transaction = (mode, action) => Object.getPrototypeOf(store).transaction.call(store, mode, tx => action({
      run: (query, params) => (query.trimStart().startsWith('UNWIND range') ? { records: rows.map(row => ({ get: name => row[name] })) }
        : tx.run(query, params)) }));
    try { return await store.observeEmbeddings(scope, key, rows.map(row => row.uid)); } finally { delete store.transaction; }
  };
  const capType = async scope => (await indexer.store.transaction('read', tx => tx.run(
    'MATCH (c:SMChunk {scope:$scope}) RETURN valueType(c.embedding_oversized_cap) AS type', { scope }))).records[0].get('type');
  const OVERSIZED = `${'é'.repeat(4096)}x`;
  const drained = async scope => {
    const before = calls.length;
    assert.deepEqual(await indexer.index(scope), { status: 'ready', indexed: 0, embedding_key: key }, 'a drained scope is a no-op');
    assert.equal(calls.length, before, 'a no-op sends no model request');
    assert.deepEqual(await indexer.store.pendingEmbeddings(scope, key, 2), []);
    assert.equal((await indexer.status(scope)).unindexed, 0);
  };

  try {
    await check('a text change during the model request refuses the stale vector and re-embeds the new text', async () => {
      const scope = 'race-text';
      await seed(scope);
      const reply = await race(scope, () => write('MATCH (c:SMChunk {scope:$scope}) SET c.text=$text', { scope, text: 'A changed fictional note.' }));
      assert.deepEqual(reply, { status: 'pending', indexed: 0, embedding_key: key, stale: 1 });
      const row = await chunk(scope);
      assert.deepEqual([row.vector, row.key, row.lock], [null, null, null]);
      assert.equal((await indexer.status(scope)).unindexed, 1, 'refused work is not progress');
      assert.deepEqual(await indexer.index(scope), { status: 'ready', indexed: 1, embedding_key: key });
      assert.deepEqual((await chunk(scope)).vector, CHANGED, 'the stored vector belongs to the current text');
      await drained(scope);
    });

    await check('a vector written under another key during the model request is not overwritten by the stale result', async () => {
      const scope = 'race-key';
      await seed(scope);
      const reply = await race(scope, async () => {
        const row = await observe(other, scope, 'other-key');
        assert.deepEqual(await other.store.saveEmbeddings(scope, 'other-key', [{ uid: row.uid, observed: row.observed, vector: COMPETING }]),
          { applied: 1, refused: 0, uncertain: false });
      });
      assert.deepEqual(reply, { status: 'pending', indexed: 0, embedding_key: key, stale: 1 });
      assert.deepEqual([(await chunk(scope)).vector, (await chunk(scope)).key], [COMPETING, 'other-key']);
      assert.deepEqual(await indexer.index(scope), { status: 'ready', indexed: 1, embedding_key: key });
      assert.deepEqual([(await chunk(scope)).vector, (await chunk(scope)).key], [INDEXED, key]);
      await drained(scope);
    });

    await check('a competing same-key repair during the model request is kept and the late result is not counted', async () => {
      const scope = 'race-repair';
      await seed(scope);
      const reply = await race(scope, async () => {
        const row = await observe(other, scope);
        assert.equal((await other.store.saveEmbeddings(scope, key, [{ uid: row.uid, observed: row.observed, vector: COMPETING }])).applied, 1);
      });
      assert.deepEqual(reply, { status: 'pending', indexed: 0, embedding_key: key, stale: 1 });
      assert.deepEqual([(await chunk(scope)).vector, (await chunk(scope)).key], [COMPETING, key]);
      await drained(scope);
      assert.deepEqual((await chunk(scope)).vector, COMPETING);
    });

    await check('a newer retry deferral during the model request is not cleared by the late vector', async () => {
      const scope = 'race-retry';
      await seed(scope);
      const reply = await race(scope, async () => {
        const row = await observe(other, scope);
        assert.equal((await other.store.deferEmbeddings(scope, key, [{ uid: row.uid, observed: row.observed }], 60, true)).applied, 1);
      });
      assert.deepEqual(reply, { status: 'pending', indexed: 0, embedding_key: key, stale: 1 });
      const row = await chunk(scope);
      assert.deepEqual([row.vector, row.retry_key, row.retry_after], [null, key, true]);
      assert.equal((await indexer.index(scope)).reason, 'embedding_retry_deferred', 'the newer cooldown governs the row');
      await write('MATCH (c:SMChunk {scope:$scope}) SET c.embedding_retry_after=datetime() - duration({seconds:1})', { scope });
      assert.deepEqual(await indexer.index(scope), { status: 'ready', indexed: 1, embedding_key: key });
      const repaired = await chunk(scope);
      assert.deepEqual([repaired.vector, repaired.retry_key, repaired.retry_after], [INDEXED, null, false]);
      await drained(scope);
    });

    await check('a failed request defers only the unchanged row and never a row repaired or rewritten meanwhile', async () => {
      const scope = 'race-defer';
      await seed(scope);
      const repaired = await race(scope, async () => {
        const row = await observe(other, scope);
        assert.equal((await other.store.saveEmbeddings(scope, key, [{ uid: row.uid, observed: row.observed, vector: COMPETING }])).applied, 1);
      }, { fail: true });
      assert.deepEqual(repaired, { status: 'unavailable', reason: 'model_request_failed', source_retained: true, stale: 1 });
      const row = await chunk(scope);
      assert.deepEqual([row.vector, row.retry_key, row.retry_after], [COMPETING, null, false]);
      await write('MATCH (c:SMChunk {scope:$scope}) REMOVE c.embedding, c.embedding_key', { scope });
      const rewritten = await race(scope, () => write('MATCH (c:SMChunk {scope:$scope}) SET c.text=$text', { scope, text: 'A changed fictional note.' }),
        { fail: true });
      assert.deepEqual(rewritten, { status: 'unavailable', reason: 'model_request_failed', source_retained: true, stale: 1 });
      assert.deepEqual([(await chunk(scope)).retry_key, (await chunk(scope)).retry_after], [null, false], 'new text inherits no cooldown');
      const unchanged = await race(scope, async () => {}, { fail: true });
      assert.deepEqual(unchanged, { status: 'unavailable', reason: 'model_request_failed', source_retained: true });
      assert.deepEqual([(await chunk(scope)).retry_key, (await chunk(scope)).retry_after], [key, true]);
    });

    await check('a prior-key vector replaced under the same key during the model request is kept and not counted', async () => {
      const scope = 'race-prior';
      await seedPrior(scope);
      const reply = await race(scope, () => replacePrior(write, scope));
      assert.deepEqual(reply, { status: 'pending', indexed: 0, embedding_key: key, stale: 1 });
      const row = await chunk(scope);
      assert.deepEqual([row.vector, row.key, row.lock], [COMPETING, 'prior-key', null], 'the competing repair is preserved');
      assert.equal((await indexer.status(scope)).unindexed, 1, 'refused work is not progress');
      assert.deepEqual(await indexer.index(scope), { status: 'ready', indexed: 1, embedding_key: key });
      assert.deepEqual([(await chunk(scope)).vector, (await chunk(scope)).key], [INDEXED, key]);
      await drained(scope);
    });

    await check('an unchanged prior-key vector is replaced by the current-key result and counted once', async () => {
      const scope = 'race-prior-control';
      await seedPrior(scope);
      const reply = await race(scope, async () => {});
      assert.deepEqual(reply, { status: 'ready', indexed: 1, embedding_key: key });
      assert.deepEqual([(await chunk(scope)).vector, (await chunk(scope)).key, (await chunk(scope)).lock], [INDEXED, key, null]);
      await drained(scope);
    });

    await check('an unchanged row applies its vector, clears its expired retry markers and counts once', async () => {
      const scope = 'race-control';
      const { uid } = await seed(scope);
      await write(`MATCH (c:SMChunk {scope:$scope,uid:$uid}) SET c.embedding_retry_key=$key, c.embedding_retry_single=false,
        c.embedding_retry_after=datetime() - duration({seconds:1})`, { scope, uid, key });
      const reply = await race(scope, async () => {});
      assert.deepEqual(reply, { status: 'ready', indexed: 1, embedding_key: key });
      const row = await chunk(scope);
      assert.deepEqual([row.vector, row.key, row.retry_key, row.retry_after, row.lock], [INDEXED, key, null, false, null]);
      await drained(scope);
    });

    // The pre-lock reads above cannot prove serialization: here the competing change is uncommitted while the indexer's
    // write starts, so a predicate read before the lock would still see the old row.
    await check('under a held competing lock a text change commits first and the waiting vector write is refused', async () => {
      const scope = 'race-lock-text';
      await seed(scope);
      const row = await selected(scope);
      const outcome = await underLock(tx => tx.run('MATCH (c:SMChunk {scope:$scope}) SET c.text=$text', { scope, text: 'A changed fictional note.' }),
        () => indexer.store.saveEmbeddings(scope, key, [{ uid: row.uid, observed: row.observed, vector: INDEXED }]));
      assert.deepEqual(outcome, { applied: 0, refused: 1, uncertain: false });
      assert.deepEqual([(await chunk(scope)).vector, (await chunk(scope)).lock], [null, null]);
    });

    await check('under a held competing lock a same-key repair commits first and is not clobbered', async () => {
      const scope = 'race-lock-repair';
      await seed(scope);
      const row = await selected(scope);
      const outcome = await underLock(tx => tx.run('MATCH (c:SMChunk {scope:$scope}) SET c.embedding=$vector, c.embedding_key=$key',
        { scope, vector: COMPETING, key }), () => indexer.store.saveEmbeddings(scope, key, [{ uid: row.uid, observed: row.observed, vector: INDEXED }]));
      assert.deepEqual(outcome, { applied: 0, refused: 1, uncertain: false });
      assert.deepEqual([(await chunk(scope)).vector, (await chunk(scope)).key], [COMPETING, key]);
      await drained(scope);
    });

    await check('under a held competing lock a newer retry deferral survives the waiting vector write', async () => {
      const scope = 'race-lock-retry';
      await seed(scope);
      const row = await selected(scope);
      const outcome = await underLock(tx => tx.run(`MATCH (c:SMChunk {scope:$scope}) SET c.embedding_retry_key=$key, c.embedding_retry_single=true,
        c.embedding_retry_after=datetime() + duration({seconds:60})`, { scope, key }),
      () => indexer.store.saveEmbeddings(scope, key, [{ uid: row.uid, observed: row.observed, vector: INDEXED }]));
      assert.deepEqual(outcome, { applied: 0, refused: 1, uncertain: false });
      const stored = await chunk(scope);
      assert.deepEqual([stored.vector, stored.retry_key, stored.retry_after], [null, key, true]);
    });

    await check('under a held competing lock a terminal oversize marker is refused once the measured text changed', async () => {
      const scope = 'race-lock-terminal';
      const { uid } = await seed(scope);
      await write('MATCH (c:SMChunk {scope:$scope,uid:$uid}) SET c.text=$text', { scope, uid, text: `${'é'.repeat(4096)}x` });
      const row = await selected(scope);
      const outcome = await underLock(tx => tx.run('MATCH (c:SMChunk {scope:$scope}) SET c.text=$text', { scope, text: 'A changed fictional note.' }),
        () => indexer.store.markOversizedChunks(scope, key, [row]));
      assert.deepEqual(outcome, { applied: 0, refused: 1, uncertain: false });
      assert.equal((await chunk(scope)).oversized_key, null);
      assert.equal((await indexer.status(scope)).unembeddable, undefined, 'the changed text is not reported unembeddable');
      assert.deepEqual(await indexer.index(scope), { status: 'ready', indexed: 1, embedding_key: key });
      assert.deepEqual((await chunk(scope)).vector, CHANGED);
      await drained(scope);
    });

    await check('under a held competing lock a repaired row receives no deferral from a stale failure', async () => {
      const scope = 'race-lock-defer';
      await seed(scope);
      const row = await selected(scope);
      const outcome = await underLock(tx => tx.run('MATCH (c:SMChunk {scope:$scope}) SET c.embedding=$vector, c.embedding_key=$key',
        { scope, vector: COMPETING, key }), () => indexer.store.deferEmbeddings(scope, key, [row], 60, true));
      assert.deepEqual(outcome, { applied: 0, refused: 1, uncertain: false });
      const stored = await chunk(scope);
      assert.deepEqual([stored.vector, stored.retry_key, stored.retry_after], [COMPETING, null, false]);
    });

    await check('under a held competing lock an unrelated change still lets the unchanged row apply', async () => {
      const scope = 'race-lock-control';
      await seed(scope);
      const row = await selected(scope);
      const outcome = await underLock(tx => tx.run('MATCH (c:SMChunk {scope:$scope}) SET c.race_fixture_note=true', { scope }),
        () => indexer.store.saveEmbeddings(scope, key, [{ uid: row.uid, observed: row.observed, vector: INDEXED }]));
      assert.deepEqual(outcome, { applied: 1, refused: 0, uncertain: false });
      assert.deepEqual([(await chunk(scope)).vector, (await chunk(scope)).key, (await chunk(scope)).lock], [INDEXED, key, null]);
      await drained(scope);
    });

    await check('under a held competing lock a prior-key vector replaced under the same key is neither clobbered nor deferred', async () => {
      const scope = 'race-lock-prior';
      await seedPrior(scope);
      const row = await selected(scope);
      assert.deepEqual(row.observed.embedding, ['LIST<FLOAT NOT NULL> NOT NULL', '0.0', '1.0', '0.0'], 'selection observes the prior vector by value');
      const saved = await underLock(tx => replacePrior((query, params) => tx.run(query, params), scope),
        () => indexer.store.saveEmbeddings(scope, key, [{ uid: row.uid, observed: row.observed, vector: INDEXED }]));
      assert.deepEqual(saved, { applied: 0, refused: 1, uncertain: false });
      const deferred = await underLock(tx => tx.run('MATCH (c:SMChunk {scope:$scope}) SET c.race_fixture_note=true', { scope }),
        () => indexer.store.deferEmbeddings(scope, key, [row], 60, true));
      assert.deepEqual(deferred, { applied: 0, refused: 1, uncertain: false });
      const stored = await chunk(scope);
      assert.deepEqual([stored.vector, stored.key, stored.retry_key, stored.lock], [COMPETING, 'prior-key', null, null]);
    });

    await check('under a held competing lock an unchanged prior-key vector lets the current-key result apply', async () => {
      const scope = 'race-lock-prior-control';
      await seedPrior(scope);
      const row = await selected(scope);
      const outcome = await underLock(tx => tx.run('MATCH (c:SMChunk {scope:$scope}) SET c.race_fixture_note=true', { scope }),
        () => indexer.store.saveEmbeddings(scope, key, [{ uid: row.uid, observed: row.observed, vector: INDEXED }]));
      assert.deepEqual(outcome, { applied: 1, refused: 0, uncertain: false });
      assert.deepEqual([(await chunk(scope)).vector, (await chunk(scope)).key, (await chunk(scope)).lock], [INDEXED, key, null]);
      await drained(scope);
    });

    await check('a prior-key integer vector beyond 2^53 is compared losslessly: replaced it is kept, unchanged it progresses', async () => {
      const scope = 'race-lossless';
      await seed(scope);
      const first = () => indexer.store.transaction('read', tx => tx.run(
        'MATCH (c:SMChunk {scope:$scope}) RETURN toString(c.embedding[0]) AS first, c.embedding_key AS key', { scope }))
        .then(result => result.records[0].toObject());
      await write('MATCH (c:SMChunk {scope:$scope}) SET c.embedding=[9007199254740993,0,0], c.embedding_key=$prior', { scope, prior: 'prior-key' });
      const row = await selected(scope);
      assert.deepEqual(row.observed.embedding, ['LIST<INTEGER NOT NULL> NOT NULL', '9007199254740993', '0', '0']);
      // Both values read as the same JS number; only the exact witness tells them apart.
      const outcome = await underLock(tx => tx.run('MATCH (c:SMChunk {scope:$scope}) SET c.embedding=[9007199254740992,0,0]', { scope }),
        () => indexer.store.saveEmbeddings(scope, key, [{ uid: row.uid, observed: row.observed, vector: INDEXED }]));
      assert.deepEqual(outcome, { applied: 0, refused: 1, uncertain: false });
      assert.deepEqual(await first(), { first: '9007199254740992', key: 'prior-key' }, 'the replacement survives');
      const reply = await race(scope, async () => {});
      assert.deepEqual(reply, { status: 'ready', indexed: 1, embedding_key: key }, 'the unchanged integer vector is not refused');
      assert.deepEqual([(await chunk(scope)).vector, (await chunk(scope)).key], [INDEXED, key]);
      await drained(scope);
    });

    // A stale terminal marker makes the selection predicate read the text before the row is projected, so a text written
    // mid-selection can differ between reads of one statement. The model input must be the observed text the guard compares.
    // The window is timing-dependent; test/embedding-selection.test.mjs pins the derivation for a mixed-read result.
    await check('model input during selection-time text changes is always the observed text the guard compares', async () => {
      const scope = 'race-select';
      await seed(scope);
      const texts = ['A fictional lantern note.', 'A changed fictional note.'];
      const expected = text => (/changed/i.test(text) ? CHANGED : INDEXED);
      const reset = () => write(`MATCH (c:SMChunk {scope:$scope}) SET c.embedding_oversized_key=$key, c.embedding_oversized_cap=$cap,
        c.embedding_oversized_text='An earlier fictional note.' REMOVE c.embedding, c.embedding_key`, { scope, key, cap: CHUNK_MAX_BYTES });
      let flipping = true, flips = 0;
      const flipper = (async () => {
        while (flipping) await write('MATCH (c:SMChunk {scope:$scope}) SET c.text=$text', { scope, text: texts[++flips % 2] });
      })();
      const violations = [];
      let saved = 0, raced = 0;
      const save = indexer.store.saveEmbeddings.bind(indexer.store);
      indexer.store.saveEmbeddings = async (target, model, rows) => {
        for (const row of rows) if (JSON.stringify(row.vector) !== JSON.stringify(expected(row.observed.text))) violations.push(row.observed.text);
        const outcome = await save(target, model, rows);
        saved += outcome.applied;
        return outcome;
      };
      try {
        for (let round = 0; round < 60; round++) {
          const hints = await indexer.store.pendingEmbeddings(scope, key, 2);
          for (const row of await indexer.store.observeEmbeddings(scope, key, hints.map(hint => hint.uid))) {
            if (!row.cooling && row.text !== row.observed.text) raced += 1;
          }
          await reset();
          const reply = await indexer.index(scope);
          assert.ok(['ready', 'pending'].includes(reply.status), JSON.stringify(reply));
          assert.ok(reply.status !== 'ready' || reply.indexed === 1, JSON.stringify(reply));
        }
      } finally {
        flipping = false;
        await flipper;
        delete indexer.store.saveEmbeddings;
      }
      assert.deepEqual([raced, violations], [0, []], 'no model input or vector came from text other than the observed text');
      assert.ok(saved > 0 && flips > 0, 'the stress applied vectors while the text changed');
      await reset();
      assert.deepEqual(await indexer.index(scope), { status: 'ready', indexed: 1, embedding_key: key });
      const row = await chunk(scope);
      assert.deepEqual(row.vector, expected(row.text), 'the stored vector belongs to the stored text');
      await drained(scope);
    });

    // Cypher's `=` makes INTEGER 8192 and FLOAT 8192.0 the terminal cap and no STRING. Selection, the judgement of the observed
    // witness, the locked write and the census must all draw that line in the same place.
    await check('the oversize cap type decides terminal state alike in selection, judgement, the locked write and the census', async () => {
      const scope = 'race-typed-cap';
      const { uid } = await seed(scope);
      await write('MATCH (c:SMChunk {scope:$scope}) SET c.text=$text', { scope, text: OVERSIZED });
      const variants = [['8192', ['INTEGER NOT NULL', '8192'], true], ['8192.0', ['FLOAT NOT NULL', '8192.0'], true],
        ["'8192'", ['STRING NOT NULL', '8192'], false], ["'8192.0'", ['STRING NOT NULL', '8192.0'], false],
        ['8192.5', ['FLOAT NOT NULL', '8192.5'], false]];
      for (const [literal, witness, terminal] of variants) {
        const label = `cap ${literal}`;
        // Observe the stored cap's witness while the marker names other text, so the row is selectable.
        await write(`MATCH (c:SMChunk {scope:$scope}) SET c.embedding_oversized_key=$key, c.embedding_oversized_cap=${literal},
          c.embedding_oversized_text='An earlier fictional note.'`, { scope, key });
        const { observed } = await selected(scope);
        assert.deepEqual(observed.oversized_cap, witness, `${label}: the witness keeps the stored type`);
        await write('MATCH (c:SMChunk {scope:$scope}) SET c.embedding_oversized_text=c.text', { scope });
        const current = { ...observed, oversized_text: OVERSIZED };
        assert.equal((await indexer.store.pendingEmbeddings(scope, key, 2)).length, terminal ? 0 : 1, `${label}: selection`);
        const [judgedRow] = await judged(scope, [{ uid, chunk: true, observed: current }]);
        assert.equal(!judgedRow.eligible, terminal, `${label}: judgement of the observed witness`);
        assert.equal((await indexer.status(scope)).unembeddable, terminal ? 1 : undefined, `${label}: census`);
        // The witness matches the stored row exactly, so only the locked eligibility recheck can refuse a terminal row.
        assert.deepEqual(await indexer.store.markOversizedChunks(scope, key, [{ uid, observed: current }]),
          terminal ? { applied: 0, refused: 1, uncertain: false } : { applied: 1, refused: 0, uncertain: false }, `${label}: locked write`);
        assert.equal(await capType(scope), terminal ? witness[0] : 'FLOAT NOT NULL', `${label}: a terminal row is left as it was`);
        assert.equal((await indexer.status(scope)).unembeddable, 1, `${label}: terminal after the write either way`);
      }
    });

    await check('the retry deadline type decides cooldown as Neo4j compares it, and only a ZONED DATETIME cools', async () => {
      const scope = 'race-typed-retry';
      await seed(scope);
      const variants = [['datetime() + duration({seconds:60})', 'ZONED DATETIME NOT NULL', true],
        ['toString(datetime() + duration({seconds:60}))', 'STRING NOT NULL', false],
        ['localdatetime() + duration({days:2})', 'LOCAL DATETIME NOT NULL', false]];
      for (const [expression, type, cooling] of variants) {
        await write(`MATCH (c:SMChunk {scope:$scope}) SET c.embedding_retry_key=$key, c.embedding_retry_single=false,
          c.embedding_retry_after=${expression} REMOVE c.embedding, c.embedding_key`, { scope, key });
        const row = await selected(scope);
        assert.deepEqual([row.observed.retry_after[0], row.cooling, row.eligible], [type, cooling, true], type);
        const before = calls.length;
        const reply = await indexer.index(scope);
        if (cooling) {
          assert.deepEqual([reply.status, reply.reason, calls.length], ['unavailable', 'embedding_retry_deferred', before], type);
        } else {
          assert.deepEqual(reply, { status: 'ready', indexed: 1, embedding_key: key }, type);
          await drained(scope);
        }
      }
    });

    // The reviewer's interleaving: the cap turns terminal (STRING "8192.0" to FLOAT 8192.0) while the mark waits on the lock.
    await check('under a held competing lock a row made terminal by another writer is refused, not counted as marked', async () => {
      const scope = 'race-lock-cap';
      await seed(scope);
      await write(`MATCH (c:SMChunk {scope:$scope}) SET c.text=$text, c.embedding_oversized_key=$key, c.embedding_oversized_cap='8192.0',
        c.embedding_oversized_text=$text`, { scope, key, text: OVERSIZED });
      assert.equal((await indexer.status(scope)).unembeddable, undefined, 'a STRING cap is not terminal');
      const before = calls.length;
      const reply = await underLock(tx => tx.run('MATCH (c:SMChunk {scope:$scope}) SET c.embedding_oversized_cap=8192.0', { scope }),
        () => indexer.index(scope));
      assert.deepEqual(reply, { status: 'pending', indexed: 0, embedding_key: key, stale: 1 }, 'the competitor\'s mark is not this call\'s progress');
      assert.deepEqual([await capType(scope), (await chunk(scope)).lock], ['FLOAT NOT NULL', null]);
      assert.deepEqual(await indexer.index(scope), { status: 'unavailable', reason: 'embedding_unembeddable', source_retained: true,
        indexed: 0, embedding_key: key, unembeddable: 1 }, 'the next call sees the terminal row and claims no work');
      assert.equal(calls.length, before, 'no model request was sent for the oversized row');
    });

    await check('under a held competing lock an unrelated change lets the non-terminal oversized row be marked once', async () => {
      const scope = 'race-lock-cap-control';
      await seed(scope);
      await write(`MATCH (c:SMChunk {scope:$scope}) SET c.text=$text, c.embedding_oversized_key=$key, c.embedding_oversized_cap='8192.0',
        c.embedding_oversized_text=$text`, { scope, key, text: OVERSIZED });
      const reply = await underLock(tx => tx.run('MATCH (c:SMChunk {scope:$scope}) SET c.race_fixture_note=true', { scope }),
        () => indexer.index(scope));
      assert.deepEqual(reply, { status: 'unavailable', reason: 'embedding_unembeddable', source_retained: true,
        indexed: 0, embedding_key: key, unembeddable: 1 });
      assert.deepEqual([await capType(scope), (await chunk(scope)).lock], ['FLOAT NOT NULL', null]);
      assert.deepEqual(await indexer.store.pendingEmbeddings(scope, key, 2), [], 'the marked row leaves the selection');
    });

    await check('a competing context mark survives a waiting guarded marker or vector write', async () => {
      const scope = 'race-context-marker';
      const context = 'a'.repeat(64);
      const different = 'b'.repeat(64);
      await seed(scope);
      await write(`MATCH (c:SMChunk {scope:$scope}) SET c.embedding_retry_key=$key,c.embedding_retry_single=true`, { scope, key });
      const [hint] = await indexer.store.pendingEmbeddings(scope, key, 2, context);
      const [row] = await indexer.store.observeEmbeddings(scope, key, [hint.uid], context);
      assert.ok(row.eligible && row.single);
      const reply = await underLock(tx => tx.run(`MATCH (c:SMChunk {scope:$scope})
        SET c.embedding_rejected_context=$different,c.embedding_rejected_text=c.text`, { scope, different }),
      () => indexer.store.markContextRejectedChunk(scope, key, context, row));
      assert.deepEqual(reply, { applied: 0, refused: 1, uncertain: false });
      assert.deepEqual(await indexer.store.saveEmbeddings(scope, key, [{ ...row, vector: [1, 0, 0] }], context),
        { applied: 0, refused: 1, uncertain: false });
      assert.equal((await indexer.store.status(scope, key, [], context)).unembeddable, undefined);
      assert.equal((await indexer.store.status(scope, key, [], different)).unembeddable, 1);
      assert.deepEqual(await indexer.store.pendingEmbeddings(scope, key, 2, different), []);
    });

    // Residency on real Neo4j: every statement and its reply is inspected. Discovery replies carry no vector or text, and
    // no hydration or write carries more than one work unit, whatever the caller's limit. Small fictional data only.
    await check('prior-key rows index across several units with no page-wide witness, and accounting matches the store', async () => {
      const scope = 'race-bounded';
      const count = 40, dimensions = 64;
      await indexer.init(scope);
      await indexer.ingest(scope, { source: 'race-fixture', conversation_id: scope, turn_id: 't1',
        entries: Array.from({ length: count }, (_, i) => ({ id: `u${i}`, role: 'user', text: `Fictional lantern note ${i}.` })) });
      await write(`MATCH (c:SMChunk {scope:$scope}) SET c.embedding=[d IN range(1, $dimensions) | toFloat(d) / 7], c.embedding_key='prior-key'`,
        { scope, dimensions });
      assert.equal((await indexer.status(scope)).unindexed, count);
      const store = indexer.store;
      const statements = [];
      store.transaction = (mode, action) => Object.getPrototypeOf(store).transaction.call(store, mode, tx => action({
        run: async (query, params) => {
          const result = await tx.run(query, params);
          statements.push({ query, params, keys: result.records[0]?.keys ?? [],
            values: result.records.flatMap(record => record.keys.map(name => record.get(name))) });
          return result;
        } }));
      const runs = [];
      try {
        for (const limit of [7, 20, 2048]) {
          statements.length = 0;
          const reply = await indexer.index(scope, { limit });
          const discovery = statements.filter(s => s.query.includes('ORDER BY cooling'));
          const hydration = statements.filter(s => s.query.trimStart().startsWith('UNWIND range'));
          const writes = statements.filter(s => s.query.includes('RETURN count(n) AS applied'));
          assert.equal(discovery.length, 1);
          assert.deepEqual(discovery[0].keys, ['uid', 'chunk', 'isolated', 'cooling', 'single'], `limit ${limit}: discovery projection`);
          assert.ok(discovery[0].values.every(value => typeof value === 'string' || typeof value === 'boolean'),
            `limit ${limit}: discovery and look-ahead carry no vector values`);
          assert.equal(discovery[0].params.limit.toNumber(), limit + 1);
          assert.ok(statements.every(s => !Array.isArray(s.params?.uids) || s.params.uids.length <= 16)
            && statements.every(s => !Array.isArray(s.params?.rows) || s.params.rows.length <= 16), `limit ${limit}: one unit per statement`);
          runs.push({ reply, hydrated: hydration.map(s => s.params.uids.length), written: writes.map(s => s.params.rows.length) });
        }
      } finally { delete store.transaction; }
      assert.deepEqual(runs, [
        { reply: { status: 'pending', indexed: 7, embedding_key: key }, hydrated: [7], written: [7] },
        { reply: { status: 'pending', indexed: 20, embedding_key: key }, hydrated: [16, 4], written: [16, 4] },
        { reply: { status: 'ready', indexed: 13, embedding_key: key }, hydrated: [13], written: [13] },
      ]);
      const stored = await indexer.store.transaction('read', tx => tx.run(`MATCH (c:SMChunk {scope:$scope})
        RETURN count(c) AS total, count(CASE WHEN c.embedding_key=$key AND c.embedding=$vector THEN 1 END) AS indexed,
          count(c.embedding_write_lock) AS locks`, { scope, key, vector: INDEXED }));
      assert.deepEqual(stored.records[0].toObject(), { total: count, indexed: count, locks: 0 });
      await drained(scope);
    });

    // Witness that the interleaving is real: the same race against a single-statement predicate write lands the stale vector.
    await check('the held-lock interleaving defeats a predicate evaluated before the lock', async () => {
      const scope = 'race-naive';
      await seed(scope);
      const row = await selected(scope);
      const naive = await underLock(tx => tx.run('MATCH (c:SMChunk {scope:$scope}) SET c.text=$text', { scope, text: 'A changed fictional note.' }),
        () => indexer.store.transaction('write', tx => tx.run(`MATCH (n:SMChunk {uid:$uid,scope:$scope}) WHERE n.text=$text
          SET n.embedding=$vector, n.embedding_key=$key RETURN count(n) AS applied`, { uid: row.uid, scope, text: row.observed.text, vector: INDEXED, key })));
      assert.equal(naive.records[0].get('applied'), 1);
      const stored = await chunk(scope);
      assert.deepEqual([stored.text, stored.vector], ['A changed fictional note.', INDEXED], 'the pre-lock predicate wrote a vector for replaced text');
    });
  } finally {
    await Promise.allSettled([indexer.close?.(), other.close?.()]);
    await new Promise(done => { model.closeAllConnections(); model.close(done); });
  }
  return results;
}
