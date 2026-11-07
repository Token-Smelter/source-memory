import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectNamespace, probeNamespace } from '../pi-extension/namespace-probe.mjs';
import { openUnixEmbeddingRelay } from '../pi-extension/unix-relay.mjs';
import { createEmbeddingShim } from '../pi-extension/embedding-shim.mjs';
import { runNamespaceHarness } from '../pi-extension/namespace-harness.mjs';
import { createNamespaceDocker } from '../pi-extension/namespace-docker.mjs';

const state = { namespace: 'net:[123]', interfaces: ['lo'], ipv4Routes: 'Iface Destination Gateway Flags\n',
  ipv6Routes: `${'0'.repeat(32)} 00 ${'0'.repeat(32)} 00 ${'0'.repeat(32)} ffffffff 00000001 00000000 00200200 lo\n` };
const NETWORK_DB = 'a'.repeat(64);
const DRIVER = 'b'.repeat(64);
const FOREIGN = 'c'.repeat(64);
const IMAGE = `sha256:${'d'.repeat(64)}`;
const RUN = '12345678-1234-1234';

function unixRequest(socketPath, path, body = '') {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST' }, response => {
      const data = []; response.on('data', part => data.push(part));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(data).toString('utf8') }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('namespace gate rejects additional interfaces and live default routes', () => {
  assert.equal(inspectNamespace(state).no_default_route, true);
  assert.throws(() => inspectNamespace({ ...state, interfaces: ['lo', 'eth0'] }), /namespace_invalid/);
  assert.throws(() => inspectNamespace({ ...state, ipv4Routes: 'Iface Destination Gateway Flags\neth0 00000000 00000000 0001\n' }), /namespace_route_invalid/);
});

test('namespace probes reject a reachable non-private database target', async () => {
  const targets = [{ host: '172.17.0.2', port: 7687 }, { host: '192.0.2.1', port: 27690 }];
  const result = await probeNamespace({ targets, readState: () => state,
    dialFn: async row => ({ ...row, outcome: row.port === 7687 ? 'connected' : 'error' }) });
  assert.deepEqual([result.ok, result.targets], [false, [{ ...targets[0], outcome: 'connected' }, { ...targets[1], outcome: 'error' }]]);
});

test('Unix relay forwards only the embedding endpoint with sanitized headers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-unix-relay-'));
  try {
    const socketPath = join(directory, 'embeddings.sock');
    const calls = [];
    const relay = await openUnixEmbeddingRelay({ socketPath, fetchFn: async (url, options) => {
      calls.push({ url, headers: options.headers }); return new Response('{"data":[]}');
    } });
    const denied = await unixRequest(socketPath, '/elsewhere');
    const ok = await unixRequest(socketPath, '/v1/embeddings', '{"model":"fiction","input":["x"]}');
    await relay.close();
    assert.deepEqual([denied.status, ok.status, calls], [404, 200, [{ url: 'http://127.0.0.1:11434/v1/embeddings', headers: { 'content-type': 'application/json' } }]]);
  } finally { rmSync(directory, { force: true, recursive: true }); }
});

test('the loopback shim refuses any other Unix socket binding', () => {
  assert.throws(() => createEmbeddingShim({ socketPath: '/scratch/other.sock' }), /socket_invalid/);
});

test('a failed namespace gate starts neither relay nor Memory and removes only owned containers', async () => {
  const calls = [];
  const docker = { async createDatabase() { return 'db'; }, async createDriver() { return 'driver'; },
    async isolation() { return { ok: false, network_mode: 'none-shared-namespace', no_default_route: true, interfaces: ['lo'], targets: [{ outcome: 'connected' }] }; },
    async removeContainer(id) { calls.push(`remove:${id}`); } };
  const result = await runNamespaceHarness({ docker, relay: { async open() { calls.push('relay'); } },
    socketPath: '/fiction/embeddings.sock', shimPort: 18000, async memoryFactory() { calls.push('memory'); }, async work() {} });
  assert.deepEqual([result.status, calls], ['isolation_failed', ['remove:driver', 'remove:db']]);
});

test('the namespace adapter inventories foreign endpoints and verifies matching namespace identities', async () => {
  const calls = [];
  const execute = async argv => {
    calls.push(argv);
    if (argv[0] === 'image') return JSON.stringify({ '/data': {}, '/logs': {} });
    if (argv[0] === 'volume' && argv[1] === 'create') return argv.at(-1);
    if (argv[0] === 'volume' && argv[1] === 'inspect') return JSON.stringify([{ Name: argv[2], Labels: { 'pi-memory.run': RUN } }]);
    if (argv[0] === 'create' && argv.includes('none')) return NETWORK_DB;
    if (argv[0] === 'create') return DRIVER;
    if (argv[0] === 'start') return argv[1];
    if (argv[0] === 'ps') return [NETWORK_DB, DRIVER, FOREIGN].join('\n');
    if (argv[0] === 'exec') return 'net:[123]';
    if (argv[0] === 'inspect' && argv[1] === '--format') return JSON.stringify({ Networks: { x: { IPAddress: '172.17.0.8' } },
      Ports: { '7687/tcp': [{ HostPort: '27690' }], '7474/tcp': [{ HostPort: '17474' }] } });
    if (argv[0] === 'inspect' && argv[1] === NETWORK_DB) return JSON.stringify([{ Id: NETWORK_DB, Image: IMAGE, Config: { Labels: { 'pi-memory.run': RUN } },
      HostConfig: { NetworkMode: 'none', PortBindings: null }, NetworkSettings: { Networks: { none: {} } },
      Mounts: [{ Type: 'volume', Name: `pi-memory-${RUN}-data`, Destination: '/data' }, { Type: 'volume', Name: `pi-memory-${RUN}-logs`, Destination: '/logs' }] }]);
    if (argv[0] === 'inspect' && argv[1] === DRIVER) return JSON.stringify([{ Id: DRIVER, Image: IMAGE, Config: { Labels: { 'pi-memory.run': RUN }, User: `${process.getuid()}:${process.getgid()}` },
      HostConfig: { NetworkMode: `container:${NETWORK_DB}`, PortBindings: null, ReadonlyRootfs: true, CapDrop: ['ALL'] }, NetworkSettings: { Networks: {} },
      Mounts: [{ Type: 'bind', Source: '/fiction/memory', Destination: '/memory', RW: false },
        { Type: 'bind', Source: '/fiction/scratch', Destination: '/scratch', RW: true }] }]);
    throw new Error('unexpected');
  };
  const probe = async (_id, targets) => ({ ok: true, namespace: 'net:[123]', interfaces: ['lo'], no_default_route: true,
    targets: targets.map(row => ({ ...row, outcome: 'error', errno: 'ENETUNREACH' })) });
  const docker = createNamespaceDocker({ execute, probe, hostInterfaces: () => ({ eth: [{ address: '192.0.2.1', internal: false }] }),
    databaseImage: IMAGE, driverImage: IMAGE, mounts: { memory: '/fiction/memory', scratch: '/fiction/scratch' }, runId: RUN, onResource() {} });
  const database = await docker.createDatabase();
  const driver = await docker.createDriver({ database });
  const gate = await docker.isolation({ database, driver, shimPort: 18000 });
  assert.deepEqual([gate.ok, gate.foreign_container_count, gate.targets.some(row => row.host === '172.17.0.8' && row.port === 7687),
    gate.targets.some(row => row.host === '172.17.0.8' && row.port === 7474), gate.targets.some(row => row.host === '192.0.2.1' && row.port === 27690),
    calls.some(row => row.includes(`container:${NETWORK_DB}`))], [true, 1, true, true, true, true]);
});
