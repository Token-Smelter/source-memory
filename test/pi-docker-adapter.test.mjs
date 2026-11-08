import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../pi-extension/docker-adapter.mjs');
const NETWORK = 'a'.repeat(64);
const DB = 'b'.repeat(64);
const DRIVER = 'c'.repeat(64);
const IMAGE = `sha256:${'d'.repeat(64)}`;

test('network and containers use owned exact IDs and a verified internal bridge', async () => {
  const { createDockerAdapter } = await load();
  const calls = [];
  const execute = async argv => {
    calls.push(argv);
    if (argv[0] === 'network' && argv[1] === 'create') return NETWORK;
    if (argv[0] === 'network' && argv[1] === 'inspect') return JSON.stringify([{ Id: NETWORK, Internal: true, IPAM: { Config: [{ Gateway: '172.30.0.1' }] } }]);
    if (argv[0] === 'create' && argv.includes('--network-alias')) return DB;
    if (argv[0] === 'create') return DRIVER;
    if (argv[0] === 'inspect' && argv[1] === DB) return JSON.stringify([{ Id: DB, Image: IMAGE, HostConfig: { PortBindings: null }, Mounts: [], NetworkSettings: { Networks: { n: { NetworkID: NETWORK } } } }]);
    if (argv[0] === 'inspect' && argv[1] === DRIVER) return JSON.stringify([{ Id: DRIVER, Image: IMAGE, HostConfig: { PortBindings: null, ReadonlyRootfs: true },
      Mounts: [{ Type: 'bind', Source: '/fiction/memory', Destination: '/memory', RW: false }, { Type: 'bind', Source: '/fiction/scratch', Destination: '/scratch', RW: true }],
      NetworkSettings: { Networks: { n: { NetworkID: NETWORK } } } }]);
    if (argv[0] === 'start') return argv[1];
    throw new Error('unexpected');
  };
  const docker = createDockerAdapter({ execute, databaseImage: IMAGE, driverImage: IMAGE, mounts: { memory: '/fiction/memory', scratch: '/fiction/scratch' } });
  const network = await docker.createNetwork({ internal: true });
  const database = await docker.createDatabase({ network, publishedPorts: false });
  const driver = await docker.createDriver({ network, database });
  assert.deepEqual([network, database, driver, docker.gateway, calls[0].includes('--internal')], [NETWORK, DB, DRIVER, '172.30.0.1', true]);
});

test('pilot probe records exact targets and rejects a connected one', async () => {
  const { probePilot } = await import('../pi-extension/pilot-probe.mjs');
  const result = await probePilot(['127.0.0.1', '172.30.0.1', '172.17.0.8'], async host => host === '172.17.0.8'
    ? { outcome: 'connected' } : { outcome: 'timeout' });
  assert.deepEqual([result.ok, result.targets.map(row => [row.host, row.port, row.outcome])], [false,
    [['127.0.0.1', 27690, 'timeout'], ['172.30.0.1', 27690, 'timeout'], ['172.17.0.8', 27690, 'connected']]]);
});

test('adapter sends all pilot addresses to a driver-contained probe before returning the gate', async () => {
  const { createDockerAdapter } = await load();
  const calls = [];
  const execute = async argv => {
    if (argv[0] === 'network' && argv[1] === 'create') return NETWORK;
    if (argv[0] === 'network' && argv[1] === 'inspect') return JSON.stringify([{ Id: NETWORK, Internal: true, IPAM: { Config: [{ Gateway: '172.30.0.1' }] } }]);
    if (argv[0] === 'create' && argv.includes('--network-alias')) return DB;
    if (argv[0] === 'create') return DRIVER;
    if (argv[0] === 'inspect' && argv[1] === 'source-memory-pilot-neo4j-1') return JSON.stringify([{ NetworkSettings: { Networks: { n: { IPAddress: '172.17.0.8' } } } }]);
    if (argv[0] === 'inspect' && argv[1] === DB) return JSON.stringify([{ Id: DB, Image: IMAGE, HostConfig: { PortBindings: null }, Mounts: [], NetworkSettings: { Networks: { n: { NetworkID: NETWORK } } } }]);
    if (argv[0] === 'inspect' && argv[1] === DRIVER) return JSON.stringify([{ Id: DRIVER, Image: IMAGE, HostConfig: { PortBindings: null, ReadonlyRootfs: true },
      Mounts: [{ Type: 'bind', Source: '/fiction/memory', Destination: '/memory', RW: false }, { Type: 'bind', Source: '/fiction/scratch', Destination: '/scratch', RW: true }], NetworkSettings: { Networks: { n: { NetworkID: NETWORK } } } }]);
    if (argv[0] === 'start') return argv[1];
    throw new Error('unexpected');
  };
  const probe = async (id, hosts) => { calls.push([id, hosts]); return { ok: false, targets: hosts.map(host => ({ host, port: 27690, outcome: host === '172.17.0.8' ? 'connected' : 'timeout' })) }; };
  const docker = createDockerAdapter({ execute, probe, databaseImage: IMAGE, driverImage: IMAGE, mounts: { memory: '/fiction/memory', scratch: '/fiction/scratch' } });
  const network = await docker.createNetwork({ internal: true });
  const database = await docker.createDatabase({ network, publishedPorts: false });
  const driver = await docker.createDriver({ network, database });
  const gate = await docker.isolation({ network, database, driver });
  assert.deepEqual([gate.ok, calls], [false, [[DRIVER, ['127.0.0.1', '172.30.0.1', '172.17.0.8']]]]);
});

test('a non-internal bridge is refused before any container create', async () => {
  const { createDockerAdapter } = await load();
  const calls = [];
  let removed = false;
  const execute = async argv => {
    calls.push(argv);
    if (argv[1] === 'create') return NETWORK;
    if (argv[1] === 'rm') { removed = true; return ''; }
    if (removed) throw Object.assign(new Error('missing'), { stderr: 'No such network' });
    return JSON.stringify([{ Id: NETWORK, Internal: false, IPAM: { Config: [{ Gateway: '172.30.0.1' }] } }]);
  };
  const docker = createDockerAdapter({ execute, databaseImage: IMAGE, driverImage: IMAGE, mounts: { memory: '/fiction/memory', scratch: '/fiction/scratch' } });
  await assert.rejects(docker.createNetwork({ internal: true }), /network_invalid/);
  assert.equal(calls.every(row => row[0] === 'network'), true);
});
