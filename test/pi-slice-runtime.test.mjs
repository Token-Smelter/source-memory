import test from 'node:test';
import assert from 'node:assert/strict';

test('slice selection chooses the smallest ordinary development source and excludes holdout', async () => {
  const { selectSlice } = await import('../pi-extension/slice-runtime.mjs');
  const corpus = { holdout_source_files: ['/fiction/held'], sessions: [
    { role: 'evidence', fixed_split: 'holdout', class: 'ordinary', file: '/fiction/held', bytes: 1 },
    { role: 'evidence', fixed_split: 'development', class: 'ordinary', file: '/fiction/dev-small', bytes: 10 },
    { role: 'evidence', fixed_split: 'development', class: 'ordinary', file: '/fiction/dev-large', bytes: 20 }] };
  const cases = [{ split: 'development', required_evidence: [{ file: '/fiction/dev-small' }] }];
  assert.deepEqual(selectSlice({ corpus, cases }).source.file, '/fiction/dev-small');
});

test('host model routing uses Pi runtime and rejects ambiguous routes without copying credentials', async () => {
  const { resolvePiModels } = await import('../pi-extension/slice-runtime.mjs');
  const checks = [];
  const runtime = { getModels: () => [{ provider: 'anthropic', id: 'claude-haiku-5-5', api: 'anthropic-messages' }],
    async checkAuth(provider) { checks.push(provider); return true; } };
  const pi = { ModelRuntime: { async create(options) { assert.deepEqual(options, { allowModelNetwork: false, refreshOnCreate: false }); return runtime; } } };
  const result = await resolvePiModels({ pi, modelId: 'anthropic/claude-haiku-5-5', reviewerId: 'anthropic/claude-haiku-5-5' });
  assert.deepEqual([result.model.id, result.reviewerModel.id, checks], ['claude-haiku-5-5', 'claude-haiku-5-5', ['anthropic', 'anthropic']]);
});

test('missing or unconfigured model route is refused before any Pi session', async () => {
  const { resolvePiModels } = await import('../pi-extension/slice-runtime.mjs');
  const pi = { ModelRuntime: { async create() { return { getModels: () => [], async checkAuth() { return true; } }; } } };
  await assert.rejects(resolvePiModels({ pi, modelId: 'anthropic/missing', reviewerId: 'anthropic/missing' }), /model_not_found/);
});
