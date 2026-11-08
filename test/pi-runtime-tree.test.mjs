import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRuntimeTree } from '../pi-extension/runtime-tree.mjs';

test('driver runtime tree contains only committed runtime paths and offline dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-runtime-tree-')), repo = join(root, 'repo'), target = join(root, 'runtime'), cache = join(root, 'cache');
  mkdirSync(repo, { mode: 0o700 }); mkdirSync(target, { mode: 0o700 }); mkdirSync(cache, { mode: 0o700 });
  try {
    const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git(['init', '-q']); mkdirSync(join(repo, 'src')); mkdirSync(join(repo, 'pi-extension'));
    writeFileSync(join(repo, 'src', 'fixture.mjs'), 'export const value = 1;\n');
    writeFileSync(join(repo, 'pi-extension', 'fixture.mjs'), 'export const value = 2;\n');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fiction-runtime', version: '1.0.0' }));
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ name: 'fiction-runtime', version: '1.0.0', lockfileVersion: 3,
      requires: true, packages: { '': { name: 'fiction-runtime', version: '1.0.0' } } }));
    git(['add', 'src', 'pi-extension', 'package.json', 'package-lock.json']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Add fixture']);
    writeFileSync(join(repo, 'private-untracked.txt'), 'must not be mounted');
    const result = prepareRuntimeTree({ repo, codeSha: git(['rev-parse', 'HEAD']), directory: target, npmCache: cache });
    assert.deepEqual([result.schema, readFileSync(join(target, 'src', 'fixture.mjs'), 'utf8'), existsSync(join(target, 'private-untracked.txt'))],
      ['runtime-tree/v1', 'export const value = 1;\n', false]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
