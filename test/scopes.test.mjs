import assert from 'node:assert/strict';
import test from 'node:test';
import { authorize, authorizeTarget, fuse, isNested, isSelector, scopePath, scopeTerm, scopeTerms, treeLayout } from '../src/core.mjs';
import { selection } from '../src/store.mjs';
import { Memory } from '../src/memory.mjs';

const config = (read, write = read) => ({ scopes: { read, write } });
const denied = action => assert.throws(action, { code: 'scope_denied' });

test('path scopes are 1 to 8 segments of [A-Za-z0-9_-]{1,64} within 256 characters', () => {
  assert.deepEqual(scopePath('acme/init-7/actor_3'), ['acme', 'init-7', 'actor_3']);
  for (const name of ['', 'a//b', '/a', 'a/', 'a/../b', 'a/./b', 'a b', 'a/b c', 'a.b', 'a:b', 'a/**', `${'a/'.repeat(8)}a`, 'x'.repeat(65)]) {
    assert.equal(scopePath(name), null, name);
  }
  assert.deepEqual(scopePath(Array(8).fill('a').join('/')).length, 8);
  assert.equal(scopePath(Array(5).fill('x'.repeat(64)).join('/')), null, 'over 256 characters');
  assert.deepEqual([isNested('acme'), isNested('a b/c'), isNested('acme/x')], [false, false, true]);
  assert.deepEqual([isSelector('acme/**'), isSelector('a b/**'), isSelector('acme/*'), isSelector('acme')], [true, false, false, false]);
  const longest = Array(4).fill('x'.repeat(63)).join('/');
  assert.deepEqual([longest.length, isSelector(`${longest}/**`), isSelector(`${longest}x/**`)], [255, false, false], 'a selector fits in 256 characters');
  assert.equal(isSelector(`${'x'.repeat(253)}/**`), false, 'a 253-character segment is not a path');
  assert.equal(isSelector(`${Array(4).fill('x'.repeat(63)).join('/').slice(0, 253)}/**`), true);
});

test('exact grants keep granting exactly what they spell, including opaque names', () => {
  const settings = config(['default', 'my scope', 'acme']);
  assert.equal(authorize(settings, 'default'), 'default');
  assert.equal(authorize(settings, 'my scope'), 'my scope');
  denied(() => authorize(settings, 'acme/x'));
  denied(() => authorizeTarget(settings, 'acme/**'));
});

test('a subtree pattern grants its root and every descendant, never a sibling or a name that only shares a prefix', () => {
  const settings = config(['acme/**']);
  for (const scope of ['acme', 'acme/x', 'acme/x/y/z']) assert.equal(authorize(settings, scope), scope);
  for (const scope of ['acmeco', 'acme-x', 'other/acme', 'acme/x y', 'acme/../other', 'acme/x/']) denied(() => authorize(settings, scope));
  assert.deepEqual(authorizeTarget(settings, 'acme/x/**'), { scope: 'acme/x', subtree: true });
  assert.deepEqual(authorizeTarget(settings, 'acme/**'), { scope: 'acme', subtree: true });
  denied(() => authorizeTarget(config(['acme/x/**']), 'acme/**'));
  denied(() => authorize(config(['a b/**']), 'a b/c'));
});

test('a selector is never an exact target, so it cannot be written even when spelled in the grants', () => {
  const settings = config(['acme/**']);
  denied(() => authorize(settings, 'acme/**', 'write'));
  assert.deepEqual(authorizeTarget(settings, 'acme/**', 'write'), { scope: 'acme', subtree: true });
  denied(() => authorizeTarget(config(['acme/**'], ['acme']), 'acme/**', 'write'));
});

test('scope terms name every ancestor-or-self and the exact scope', () => {
  assert.equal(scopeTerms('acme/x'), [scopeTerm('acme', false), scopeTerm('acme/x', false), scopeTerm('acme/x', true)].join(' '));
  assert.match(scopeTerm('acme', true), /^x[0-9a-f]{64}$/);
});

test('flat selections keep per-scope names and the exact predicate; nested and subtree ones use the tree with an in-Lucene filter', () => {
  const flat = selection('acme');
  assert.deepEqual([flat.tree, flat.where('n'), flat.lucene('"q"'), flat.params], [false, 'n.scope=$scope', '"q"', { scope: 'acme' }]);
  assert.match(flat.names.turns, /^smt_/);
  const nested = selection('acme/x');
  assert.deepEqual([nested.tree, nested.subtree, nested.where('n'), nested.names, nested.labels], [true, false, 'n.scope=$scope', treeLayout('acme').indexes, treeLayout('acme').labels]);
  assert.notDeepEqual(treeLayout('acme').indexes, treeLayout('other').indexes);
  assert.match(treeLayout('acme').indexes.turns, /^smtree_t_[0-9a-f]{64}$/);
  assert.equal(nested.lucene('"q"'), `text:("q") AND scope_terms:${scopeTerm('acme/x', true)}^0`);
  const subtree = selection({ scope: 'acme', subtree: true });
  assert.equal(subtree.lucene('"q"'), `text:("q") AND scope_terms:${scopeTerm('acme', false)}^0`);
  assert.deepEqual([subtree.owns('acme'), subtree.owns('acme/x/y'), subtree.owns('acme/x y'), subtree.owns('acmeco')], [true, true, false, false]);
  assert.equal(new RegExp(`^${subtree.params.scopeRegex}$`).test('acme/x y'), false);
  assert.equal(new RegExp(`^${subtree.params.scopeRegex}$`).test('acme/x/y'), true);
  assert.equal(selection({ scope: Array(8).fill('a').join('/'), subtree: true }).params.scopeRegex, '(?!)');
});

test('fusion keeps same-id records of different scopes apart and flat hits unchanged', () => {
  const flat = fuse({ a: [{ kind: 'record', id: 'd' }], b: [{ kind: 'record', id: 'd' }] });
  assert.equal(flat.length, 1);
  assert.equal(flat[0].scope, undefined);
  const scoped = fuse({ a: [{ kind: 'record', id: 'd', scope: 'acme/x' }, { kind: 'record', id: 'd', scope: 'acme/y' }] });
  assert.deepEqual(scoped.map(hit => hit.scope), ['acme/x', 'acme/y']);
});

test('reads and writes that take one exact scope refuse a selector before touching storage', async () => {
  const store = new Proxy({}, { get: () => () => { throw new Error('store touched'); } });
  const memory = new Memory(config(['acme/**']), store);
  for (const [method, input] of [['show', { kind: 'record', id: 'x' }], ['index', {}], ['ingest', {}], ['enrich', {}]]) {
    await assert.rejects(memory[method]('acme/**', input), { code: 'scope_denied' }, method);
  }
  await assert.rejects(new Memory(config(['acme']), store).recall('acme/**', { query: 'q' }), { code: 'scope_denied' });
});
