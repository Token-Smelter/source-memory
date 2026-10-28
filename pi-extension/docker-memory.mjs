import { spawn } from 'node:child_process';
import { createMemoryClient } from './memory-client.mjs';

const fail = code => Object.assign(new Error(code), { code });

/** The host owns one docker-exec child; no DB socket or credential is exposed to the model process. */
export function openDockerMemory({ containerId, scope, configPath, intentDir, spawnFn = spawn, timeoutMs = 30000, onReceipt }) {
  if (!/^[a-f0-9]{64}$/.test(containerId ?? '') || typeof scope !== 'string' || !scope
    || !/^\/scratch\/[A-Za-z0-9._/-]+$/.test(configPath ?? '') || !/^\/scratch\/[A-Za-z0-9._/-]+$/.test(intentDir ?? '')
    || configPath.split('/').includes('..') || intentDir.split('/').includes('..')) throw fail('binding_invalid');
  const child = spawnFn('/usr/bin/docker', ['exec', '-i', containerId, '/usr/local/bin/node', '/memory/pi-extension/serve.mjs',
    '--config', configPath, '--scope', scope, '--intent-dir', intentDir],
  { shell: false, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const client = createMemoryClient({ input: child.stdout, output: child.stdin, timeoutMs, onReceipt });
  let settled = null;
  child.on('error', () => { settled = 'unknown'; client.close(); });
  child.on('close', code => { settled = code === 0 ? 'closed' : 'failed'; client.close(); });
  return {
    ...client,
    init: () => client.init(scope),
    async close() {
      if (settled) return settled;
      return new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('unknown'); }, timeoutMs);
        child.once('close', code => { clearTimeout(timer); resolve(code === 0 ? 'closed' : 'failed'); });
        child.stdin.end();
      });
    },
  };
}
