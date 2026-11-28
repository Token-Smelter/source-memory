import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Memory } from '../src/memory.mjs';

// The budgeted index step against a disposable Neo4j. Content and vectors are fictional. The model is a loopback fixture whose
// requests move a fake step clock, so a budget is spent by requests, not by wall time; one request outlasts its shortened
// timeout in real time.
export async function runIndexBudget(database) {
  const results = [];
  const check = async (name, fn) => { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); };
  const clock = { now: 0 };
  const calls = [];
  let plan = () => ({});
  const model = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const input = JSON.parse(body);
    const { advance = 0, delay = 0 } = plan(calls.length);
    calls.push(input.input);
    clock.now += advance;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (!res.destroyed) res.end(JSON.stringify({ model: input.model, data: input.input.map((value, index) => ({ index, embedding: [value.length, 1, 1] })) }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const scopes = ['budget-resume', 'budget-cut', 'budget-full-timeout', 'budget-unset'];
  const embedding = { url: `http://127.0.0.1:${model.address().port}/embed`, model: 'budget-fixture', dimensions: 3 };
  const configFor = extra => ({ neo4j: database, scopes: { read: scopes, write: scopes }, index_on_write: false, embedding: { ...embedding, ...extra } });
  const base = new Memory(configFor({}));
  // Every step shares the one store connection; only the configuration and the clock differ.
  const memoryFor = extra => {
    const memory = new Memory(configFor(extra), base.store);
    memory.clock = () => clock.now;
    return memory;
  };
  const seed = async (scope, count) => {
    await base.init(scope);
    await base.ingest(scope, { source: 'budget-fixture', conversation_id: scope, turn_id: 't1', lineage_root: true,
      entries: Array.from({ length: count }, (_, index) => ({ id: `e${index}`, role: 'user', text: `A fictional note number ${index} about ${scope}.` })) });
  };
  const marks = async scope => {
    const session = base.store.driver.session({ database: database.database });
    try {
      const [row] = (await session.run(`MATCH (c:SMChunk {scope:$scope}) RETURN count(c.embedding) AS vectors,
        count(c.embedding_retry_after) AS deferred, count(c.embedding_rejected_context) + count(c.embedding_oversized_key) AS rejected`, { scope })).records;
      return { vectors: Number(row.get('vectors')), deferred: Number(row.get('deferred')), rejected: Number(row.get('rejected')) };
    } finally { await session.close(); }
  };
  try {
    await check('B1 a budget ends the step with a typed partial after saving what it embedded, and later steps finish the rest', async () => {
      await seed('budget-resume', 10);
      plan = () => ({ advance: 2000 });
      const memory = memoryFor({ index_budget_ms: 5000, index_batch: 2 });
      const first = await memory.index('budget-resume');
      assert.deepEqual([first.status, first.indexed, first.partial], ['pending', 6, { reason: 'index_budget_exhausted', budget_ms: 5000 }]);
      assert.deepEqual(await marks('budget-resume'), { vectors: 6, deferred: 0, rejected: 0 }, 'each saved group is durable; nothing is deferred');
      assert.ok(calls.every(input => input.length <= 2));
      const second = await memory.index('budget-resume');
      assert.deepEqual([second.status, second.indexed], ['ready', 4], JSON.stringify(second));
      assert.equal((await base.status('budget-resume')).unindexed, 0);
    });

    await check('B2 a request the budget shortened leaves no cooldown, isolation or terminal mark on its rows', async () => {
      await seed('budget-cut', 4);
      calls.length = 0;
      plan = index => (index === 0 ? { advance: 850 } : { delay: 2500 });
      const reply = await memoryFor({ index_budget_ms: 2000, index_batch: 2 }).index('budget-cut');
      assert.deepEqual([reply.status, reply.indexed, reply.partial?.reason], ['pending', 2, 'index_budget_exhausted']);
      assert.deepEqual(await marks('budget-cut'), { vectors: 2, deferred: 0, rejected: 0 });
      plan = () => ({});
      assert.equal((await memoryFor({ index_budget_ms: 2000, index_batch: 2 }).index('budget-cut')).status, 'ready', 'the rows are selected again at once');
    });

    await check('B3 a failure within the full timeout is still deferred under a budget', async () => {
      await seed('budget-full-timeout', 2);
      plan = () => ({ delay: 800 });
      const reply = await memoryFor({ index_budget_ms: 100_000, timeout_ms: 300 }).index('budget-full-timeout');
      assert.deepEqual([reply.status, reply.reason], ['unavailable', 'model_timeout']);
      assert.deepEqual(await marks('budget-full-timeout'), { vectors: 0, deferred: 2, rejected: 0 });
    });

    await check('B4 with neither key the step indexes everything in one call as before, and the fake clock is never consulted', async () => {
      await seed('budget-unset', 20);
      calls.length = 0;
      plan = () => ({ advance: 10_000_000 });
      const reply = await memoryFor({}).index('budget-unset');
      assert.deepEqual([reply.status, reply.indexed, reply.partial], ['ready', 20, undefined]);
      assert.deepEqual(calls.map(input => input.length), [16, 4]);
    });
  } finally {
    await base.close();
    await new Promise(resolve => { model.closeAllConnections(); model.close(resolve); });
  }
  return results;
}
