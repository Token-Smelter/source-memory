import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');

/** Materialize only committed runtime sources and lockfile-resolved dependencies for a read-only driver mount. */
export function prepareRuntimeTree({ repo, codeSha, directory, npmCache }) {
  if (!isAbsolute(repo ?? '') || !isAbsolute(directory ?? '') || !isAbsolute(npmCache ?? '') || !/^[a-f0-9]{40}$/.test(codeSha ?? '')) throw fail('runtime_tree_invalid');
  const root = realpathSync(repo), target = realpathSync(directory), state = statSync(target);
  if (root !== repo || target !== directory || !state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o077)) throw fail('runtime_tree_invalid');
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 10_000_000 }).trim();
  if (git(['rev-parse', 'HEAD']) !== codeSha) throw fail('runtime_tree_changed');
  const paths = ['src', 'pi-extension', 'package.json', 'package-lock.json'];
  const tree = git(['ls-tree', '-r', codeSha, '--', ...paths]);
  if (tree.split('\n').some(line => line.startsWith('120000 '))) throw fail('runtime_tree_symlink');
  const archive = execFileSync('git', ['-C', root, 'archive', '--format=tar', codeSha, '--', ...paths], { timeout: 30000, maxBuffer: 50_000_000 });
  execFileSync('tar', ['-xf', '-', '-C', target], { input: archive, timeout: 30000, maxBuffer: 2_000_000 });
  const npm = execFileSync('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: target, npm_config_cache: npmCache, npm_config_update_notifier: 'false' },
    encoding: 'utf8', timeout: 120000, maxBuffer: 2_000_000 });
  return { schema: 'runtime-tree/v1', code_sha: codeSha, paths, archive_sha256: sha(archive),
    dependency_install: 'npm ci --offline --ignore-scripts', install_output_sha256: sha(npm) };
}
