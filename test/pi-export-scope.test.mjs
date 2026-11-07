import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exportScope } from '../pi-extension/export-scope.mjs';

test('private logical snapshot preserves scoped node and relationship properties without asserting restore', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-snapshot-'));
  try {
    const queries = [];
    const driver = { session() { return { async executeRead(action) { return action({ async run(query, params) {
      queries.push({ query, params }); return { records: [{ toObject() { return query.includes('MATCH (n)')
        ? { uid: 'fiction', labels: ['SMRecord'], properties: { embedding: [1, 0], body: 'fictional body' } }
        : { from: 'fiction', type: 'SM_FROM', to: 'fiction2', properties: {} }; } }] };
    } }); }, async close() {} }; } };
    const path = join(directory, 'baseline.json');
    const result = await exportScope({ driver, scope: 'fiction', output: path, allowedDir: directory });
    const bytes = readFileSync(path);
    assert.deepEqual([result.sha256, result.nodes, result.relationships, result.restore_verified, queries.every(row => row.params.scope === 'fiction')],
      [createHash('sha256').update(bytes).digest('hex'), 1, 1, false, true]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
