import test from 'node:test';
import assert from 'node:assert/strict';
import { sealComparison, verifySeal } from '../pi-extension/evaluation/seal.mjs';
import { createAnswerer as createAnchoredAnswerer } from '../pi-extension/evaluation/answerer.mjs';
import { fictionalSettings, fictionalCase } from '../pi-extension/evaluation/fictional.mjs';

const createAnswerer = options => createAnchoredAnswerer({ ...options, expectedDigest: options.seal.digest });

test('comparison rejects changed or incomplete settings', () => {
  const s = fictionalSettings();
  const sealed = sealComparison(s);
  assert.equal(verifySeal(sealed, sealed.digest).baseline.name, 'fictional-old');
  assert.throws(() => verifySeal(sealed), /expected_digest_required/);
  const changed = structuredClone(sealed); changed.spec.answerer.instructions = 'different';
  assert.throws(() => verifySeal(changed, sealed.digest), /seal_mismatch/);
  assert.throws(() => verifySeal(sealed, '0'.repeat(64)), /seal_mismatch/);
  delete s.scorer.model;
  assert.throws(() => sealComparison(s), /settings_invalid/);
});

test('answerer confines evidence to returned items and keeps primary arms off raw search', async () => {
  const seen = [];
  const seal = sealComparison(fictionalSettings());
  const answerer = createAnswerer({ seal,
    memory: { async search(q) { seen.push(q); return [{ id: 'item', scope: 'fiction', text: 'Mira decided 4', evidence: [{ id: 'src', scope: 'fiction' }] }]; },
      async resolve(q) { return { id: q.evidenceId, scope: 'fiction', text: 'Mira decided 4' }; } },
    archive: { async search() { throw Error('raw_search_called'); } },
    async respond({ tools, request, instructions, ...rest }) {
      assert.equal(request, fictionalCase().request);
      assert.equal(instructions, 'Answer only from the permitted tools.');
      assert.equal('rubric' in rest, false);
      assert.equal('arm' in rest, false);
      const found = await tools.search('Mira');
      assert.throws(() => tools.resolve('other', 'src'), /not_offered/);
      assert.deepEqual(await tools.resolve('item', 'src'), { id: 'src', scope: 'fiction', text: 'Mira decided 4' });
      return { text: found[0].text };
    } });
  const result = await answerer.run({ arm: 'candidate', case: fictionalCase() });
  assert.equal(result.answer.text, 'Mira decided 4');
  assert.equal(seen[0].storeId, 'candidate-fiction');
  const changed = fictionalCase(); changed.request = 'changed after seal';
  await assert.rejects(answerer.run({ arm: 'candidate', case: changed }), /case_seal_mismatch/);
});

test('concurrent retrieval cannot exceed the shared returned-item limit', async () => {
  const answerer = createAnswerer({ seal: sealComparison(fictionalSettings()),
    memory: { async search() { await new Promise(resolve => setImmediate(resolve)); return [1, 2, 3].map(i => ({ id: `i${i}`, scope: 'fiction', text: 'fact', evidence: [] })); }, async resolve() {} },
    archive: { async search() { return []; } },
    async respond({ tools }) { const values = await Promise.allSettled([tools.search('a'), tools.search('b')]);
      assert.equal(values.filter(v => v.status === 'fulfilled').length, 1);
      assert.match(values.find(v => v.status === 'rejected').reason.message, /item_limit/);
      return { text: 'fiction' }; } });
  await answerer.run({ arm: 'candidate', case: fictionalCase() });
});

test('empty and raw-only conditions are separate and use fixed limits', async () => {
  const calls = [];
  const answerer = createAnswerer({ seal: sealComparison(fictionalSettings()),
    memory: { async search() { throw Error('unexpected'); }, async resolve() { throw Error('unexpected'); } },
    archive: { async search(q) { calls.push(q); return []; } },
    async respond({ tools }) { assert.deepEqual(await tools.search('query'), []); return { text: 'unknown' }; } });
  await answerer.run({ arm: 'empty', case: fictionalCase() });
  await answerer.run({ arm: 'raw-only', case: fictionalCase() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 3);
});
