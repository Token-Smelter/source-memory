import assert from 'node:assert/strict';
import test from 'node:test';
import neo4j from 'neo4j-driver';
import { CENSUS_TIMEOUT_MS, checkCensusNotifications, indexCensus } from '../src/index-census.mjs';

const config = { scopes: { read: ['fictional'] }, embedding: {
  url: 'http://127.0.0.1:9/v1/embeddings', model: 'fixture', dimensions: 3,
} };
const counters = { containsUpdates: () => false };
const response = row => ({ records: row ? [{ toObject: () => row }] : [], summary: { notifications: [], counters } });

const emptyChunks = { chunks_total: 0, chunks_indexed: 0, chunks_unindexed: 0, terminal_byte: 0, terminal_context: 0,
  retry_marked: 0, cooling: 0, other: 0, same_key_missing_chunks: 0, turns_affected: 0, missing_chunk_turn_binding: 0 };
const emptyRecords = { records_total: 0, missing_record_vectors: 0, same_key_missing_records: 0 };

function storeWithReadback({ healthError, chunks = emptyChunks, records = emptyRecords } = {}) {
  const calls = [];
  const store = { database: 'neo4j', driver: { session(options) {
    assert.deepEqual(options, { database: 'neo4j', defaultAccessMode: neo4j.session.READ });
    return {
      beginTransaction(settings) {
        assert.deepEqual(settings, { timeout: CENSUS_TIMEOUT_MS });
        calls.push('begin');
        return {
          async run(query) {
            if (query.startsWith('MATCH (n:SMChunk')) { calls.push('chunks'); return response(chunks); }
            if (query.startsWith('MATCH (n:SMRecord')) { calls.push('records'); return response(records); }
            assert.match(query, /^SHOW INDEXES\b/);
            calls.push('health');
            if (healthError) throw healthError;
            return response(null);
          },
          async commit() { calls.push('commit'); },
          async close() { calls.push('close-transaction'); },
        };
      },
      async close() { calls.push('close-session'); },
    };
  } } };
  return { store, calls };
}

test('census reads counts and health under the same explicit READ transaction timeout', async () => {
  const { store, calls } = storeWithReadback();
  assert.deepEqual(await indexCensus(config, 'fictional', store), {
    ...emptyChunks, ...emptyRecords, chunk_index_health: 3, record_index_health: 3,
  });
  assert.deepEqual(calls, ['begin', 'chunks', 'records', 'health', 'commit', 'close-transaction', 'close-session']);
});

test('census refuses missing aliases, extra numeric columns and inconsistent counts', async () => {
  for (const rows of [{ chunks: { chunks_total: 0 } }, { chunks: { ...emptyChunks, extra: 1 } },
    { chunks: { ...emptyChunks, cooling: 1 } }, { records: { ...emptyRecords, missing_record_vectors: 1 } }]) {
    const { store, calls } = storeWithReadback(rows);
    await assert.rejects(indexCensus(config, 'fictional', store), { code: 'census_unverified' });
    assert.equal(calls.includes('commit'), false);
    assert.equal(calls.includes('health'), false);
  }
});

test('only missing optional marker property warnings are accepted', () => {
  const code = 'Neo.ClientNotification.Statement.UnknownPropertyKeyWarning';
  const warning = name => ({ code, description: `Property unavailable (the missing property name is: ${name})` });
  const keys = new Set();
  checkCensusNotifications([warning('embedding_oversized_key'), warning('embedding_retry_after')], keys);
  assert.deepEqual([...keys], ['embedding_oversized_key', 'embedding_retry_after']);
  assert.throws(() => checkCensusNotifications([warning('embedding_key')], keys), { code: 'census_unverified', notification: code });
  assert.throws(() => checkCensusNotifications([{ ...warning('embedding_retry_after'), code: 'Neo.ClientNotification.Schema.HintWarning' }], keys),
    { code: 'census_unverified', notification: 'Neo.ClientNotification.Schema.HintWarning' });
});

test('census does not return partial counts if the health read times out', async () => {
  const error = Object.assign(new Error('fixture'), { code: 'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration' });
  const { store, calls } = storeWithReadback({ healthError: error });
  await assert.rejects(indexCensus(config, 'fictional', store), value => value === error);
  assert.deepEqual(calls, ['begin', 'chunks', 'records', 'health', 'close-transaction', 'close-session']);
});
