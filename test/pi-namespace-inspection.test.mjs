import test from 'node:test';
import assert from 'node:assert/strict';
import { createNamespaceDocker } from '../pi-extension/namespace-docker.mjs';

const DB = 'a'.repeat(64);
const DRIVER = 'b'.repeat(64);
const FOREIGN = 'c'.repeat(64);
const IMAGE = `sha256:${'d'.repeat(64)}`;
const DRIVER_IMAGE = `sha256:${'e'.repeat(64)}`;
const RUN = '12345678-1234-5678';
const dataVolume = `pi-memory-${RUN}-data`;
const logsVolume = `pi-memory-${RUN}-logs`;
const mounts = { memory: '/fiction/memory', scratch: '/fiction/scratch' };
const daemonError = stderr => Object.assign(new Error('fictional discarded source text'), { code: 1, stderr });
const transient = (id = DB, type = 'containers') => daemonError(
  `error during connect: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/${type}/${id}${type === 'volumes' ? '' : '/json'}": EOF\n`);
const missing = id => daemonError(`Error: No such object: ${id}\n`);

function container(id) {
  const driver = id === DRIVER;
  return { Id: id, Image: driver ? DRIVER_IMAGE : IMAGE,
    Config: { Labels: { 'pi-memory.run': RUN }, User: `${process.getuid()}:${process.getgid()}` },
    HostConfig: { NetworkMode: driver ? `container:${DB}` : 'none', PortBindings: null, ReadonlyRootfs: true, CapDrop: ['ALL'] },
    NetworkSettings: { Networks: driver ? {} : { none: {} } },
    Mounts: driver ? [{ Type: 'bind', Source: mounts.memory, Destination: '/memory', RW: false },
      { Type: 'bind', Source: mounts.scratch, Destination: '/scratch', RW: true }]
      : [{ Type: 'volume', Name: dataVolume, Destination: '/data' }, { Type: 'volume', Name: logsVolume, Destination: '/logs' }] };
}

// All state, transport faults and content here are invented; no Docker or model is contacted.
function fixture({ fault = () => undefined, signal, sleep: sleepFn, now: nowFn } = {}) {
  const calls = [], receipts = [], sleeps = [], live = new Set(), volumes = new Set();
  let clock = 0;
  const execute = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    const override = await fault(argv, { calls, live, volumes, advance: ms => { clock += ms; } });
    if (override !== undefined) return override;
    if (argv[0] === 'image') return argv[2] === IMAGE ? '{"/data":{},"/logs":{}}' : 'null';
    if (argv[0] === 'volume') {
      const id = argv.at(-1);
      if (argv[1] === 'create') { volumes.add(id); return id; }
      if (argv[1] === 'rm') { volumes.delete(id); return id; }
      if (!volumes.has(id)) throw daemonError(`Error response from daemon: get ${id}: no such volume`);
      return JSON.stringify([{ Name: id, Labels: { 'pi-memory.run': RUN } }]);
    }
    if (argv[0] === 'create') { const id = argv.includes('none') ? DB : DRIVER; live.add(id); return id; }
    if (argv[0] === 'start') return argv[1];
    if (argv[0] === 'rm') { live.delete(argv.at(-1)); return argv.at(-1); }
    if (argv[0] === 'inspect') {
      const id = argv.at(-1);
      if (id === FOREIGN) return JSON.stringify({ Id: FOREIGN, NetworkSettings: { Networks: {} } });
      if (!live.has(id)) throw missing(id);
      return JSON.stringify([container(id)]);
    }
    if (argv[0] === 'ps') return [DB, DRIVER, FOREIGN].join('\n');
    if (argv[0] === 'exec' && argv[2] === '/bin/readlink') return 'net:[123]';
    throw new Error('unexpected fictional command');
  };
  const docker = createNamespaceDocker({ execute, signal, now: nowFn ?? (() => clock),
    sleep: sleepFn ?? (async ms => { sleeps.push(ms); clock += ms; }),
    databaseImage: IMAGE, driverImage: DRIVER_IMAGE, mounts, runId: RUN, onResource: event => receipts.push(event),
    hostInterfaces: () => ({ eth: [{ address: '192.0.2.1', internal: false }] }),
    probe: async (_id, targets) => ({ ok: true, namespace: 'net:[123]', interfaces: ['lo'], no_default_route: true,
      targets: targets.map(row => ({ ...row, outcome: 'error', errno: 'ENETUNREACH' })) }) });
  return { docker, calls, receipts, sleeps, live, volumes,
    inspections: site => receipts.filter(row => row.kind === 'docker_inspection' && row.site === site) };
}

const dbRead = argv => argv[0] === 'inspect' && argv[1] === DB;

test('fictional transient GET retries exact ID, validates fresh result, and retains sanitized bounded receipts', async () => {
  let failures = 0;
  const f = fixture({ fault(argv) { if (dbRead(argv) && failures++ < 2) throw transient(); } });
  assert.equal(await f.docker.createDatabase(), DB);
  assert.deepEqual(f.sleeps, [100, 200]);
  assert.deepEqual(f.inspections('database_identity').map(row => [row.classification, row.attempt, row.owned]),
    [['transient_transport', 1, true], ['transient_transport', 2, true], ['valid', 3, true]]);
  const reads = f.calls.filter(row => dbRead(row.argv));
  assert.equal(reads.length, 3);
  assert.ok(reads.every(row => JSON.stringify(row.argv) === JSON.stringify(['inspect', DB])));
  assert.deepEqual(reads.map(row => row.options.timeout), [5000, 4900, 4700]);
  assert.ok(reads.every(row => row.options.signal instanceof AbortSignal));
  const encoded = JSON.stringify(f.receipts);
  for (const excluded of ['discarded source text', 'stderr', 'Config', 'NEO4J_AUTH', mounts.memory, mounts.scratch, 'docker.sock']) {
    assert.equal(encoded.includes(excluded), false);
  }
});

for (const [name, mutate] of [
  ['id', row => { row.Id = FOREIGN; }],
  ['image', row => { row.Image = DRIVER_IMAGE; }],
  ['label', row => { row.Config.Labels['pi-memory.run'] = 'other'; }],
  ['network', row => { row.HostConfig.NetworkMode = 'bridge'; }],
  ['ports', row => { row.HostConfig.PortBindings = { '7687/tcp': [{}] }; }],
  ['mount', row => { row.Mounts[0].Name = 'unowned'; }],
  ['route', row => { row.NetworkSettings.Networks.none.Gateway = '192.0.2.2'; }],
]) {
  test(`transient followed by wrong database ${name} cannot succeed or retry validation`, async () => {
    let reads = 0;
    const f = fixture({ fault(argv) {
      if (!dbRead(argv)) return;
      if (++reads === 1) throw transient();
      if (reads === 2) { const row = container(DB); mutate(row); return JSON.stringify([row]); }
    } });
    await assert.rejects(f.docker.createDatabase(), { code: 'container_invalid' });
    assert.equal(reads, 4); // Two validation attempts, then cleanup ownership and positive absence reads.
    assert.deepEqual(f.inspections('database_identity').map(row => row.classification), ['transient_transport', 'validation_failed']);
    assert.equal(f.calls.some(row => row.argv[0] === 'start'), false);
    assert.deepEqual(f.calls.filter(row => row.argv[0] === 'rm').map(row => row.argv), [['rm', '--force', DB]]);
    assert.equal(f.live.size, 0);
  });
}

for (const [name, mutate] of [
  ['user', row => { row.Config.User = '0:0'; }],
  ['writable root', row => { row.HostConfig.ReadonlyRootfs = false; }],
  ['capabilities', row => { row.HostConfig.CapDrop = []; }],
  ['extra network', row => { row.NetworkSettings.Networks.bridge = {}; }],
  ['bind source', row => { row.Mounts[0].Source = '/fiction/other'; }],
  ['bind writable', row => { row.Mounts[0].RW = true; }],
  ['extra mount', row => { row.Mounts.push({}); }],
]) {
  test(`transient followed by wrong driver ${name} still fails closed`, async () => {
    let reads = 0;
    const f = fixture({ fault(argv) {
      if (argv[0] !== 'inspect' || argv[1] !== DRIVER) return;
      if (++reads === 1) throw transient(DRIVER);
      if (reads === 2) { const row = container(DRIVER); mutate(row); return JSON.stringify([row]); }
    } });
    await f.docker.createDatabase();
    await assert.rejects(f.docker.createDriver({ database: DB }), { code: 'container_invalid' });
    assert.deepEqual(f.inspections('driver_identity').map(row => row.classification), ['transient_transport', 'validation_failed']);
    assert.equal(f.calls.some(row => row.argv[0] === 'start' && row.argv[1] === DRIVER), false);
    assert.equal(f.live.has(DRIVER), false);
  });
}

for (const [name, output, classification] of [
  ['missing', () => { throw missing(DB); }, 'missing'],
  ['malformed JSON', () => '{fictional broken JSON', 'malformed_json'],
  ['permission', () => { throw daemonError('permission denied while trying to connect to the Docker daemon socket'); }, 'permission'],
  ['generic error', () => { throw new Error('docker_inspect_failed'); }, 'unclassified'],
  ['structured but not CLI transport', () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }, 'unclassified'],
  ['wrong endpoint', () => { throw transient(FOREIGN); }, 'unclassified'],
  ['oversized stderr', () => { throw daemonError('x'.repeat(4097)); }, 'unclassified'],
  ['mixed denial and EOF', () => { throw daemonError(`${transient().stderr}permission denied`); }, 'permission'],
]) {
  test(`${name} is not retried even if a later read would succeed`, async () => {
    let reads = 0;
    const f = fixture({ fault(argv) { if (dbRead(argv) && ++reads === 1) return output(); } });
    await assert.rejects(f.docker.createDatabase(), { code: 'docker_inspect_failed' });
    assert.deepEqual(f.inspections('database_identity').map(row => [row.classification, row.attempt]), [[classification, 1]]);
    assert.deepEqual(f.sleeps, []);
    assert.equal(reads, 3); // Cleanup ownership and absence reads cannot convert creation to success.
    assert.equal(f.calls.some(row => row.argv[0] === 'start'), false);
  });
}

test('transient exhaustion is exactly three attempts and cleanup failure remains unknown', async () => {
  const f = fixture({ fault(argv) { if (dbRead(argv)) throw transient(); } });
  await assert.rejects(f.docker.createDatabase(), { code: 'cleanup_unknown' });
  assert.deepEqual(f.inspections('database_identity').map(row => row.attempt), [1, 2, 3]);
  assert.deepEqual(f.inspections('cleanup_container').map(row => row.attempt), [1, 2, 3]);
  assert.equal(f.calls.some(row => row.argv[0] === 'rm'), false);
  assert.equal(f.receipts.some(row => row.phase === 'removed'), false);
  assert.equal(f.live.has(DB), true);
});

test('one total deadline includes failed calls and sleep; a late valid result is rejected', async () => {
  let reads = 0;
  const f = fixture({ fault(argv, { advance }) {
    if (!dbRead(argv)) return;
    if (++reads === 1) { advance(4800); throw transient(); }
    if (reads === 2) { advance(101); return JSON.stringify([container(DB)]); }
  } });
  await assert.rejects(f.docker.createDatabase(), { code: 'docker_inspect_failed' });
  assert.deepEqual(f.inspections('database_identity').map(row => row.classification), ['transient_transport', 'deadline']);
  assert.deepEqual(f.calls.filter(row => dbRead(row.argv)).slice(0, 2).map(row => row.options.timeout), [5000, 100]);
});

test('deadline exhausted by backoff cannot start another attempt', async () => {
  let reads = 0;
  const f = fixture({ fault(argv, { advance }) {
    if (dbRead(argv) && ++reads === 1) { advance(4950); throw transient(); }
  } });
  await assert.rejects(f.docker.createDatabase(), { code: 'docker_inspect_failed' });
  assert.equal(f.inspections('database_identity').at(-1).classification, 'deadline');
  assert.equal(reads, 3);
});

test('real deadline bounds an executor that never settles', async () => {
  const f = fixture({ fault(argv) { if (argv[0] === 'image') return new Promise(() => {}); } });
  await assert.rejects(f.docker.createDatabase(), { code: 'docker_inspect_failed' });
  assert.deepEqual(f.inspections('database_image').map(row => [row.classification, row.attempt]), [['deadline', 1]]);
  assert.equal(f.calls.length, 1);
});

test('pre-cancelled inspection executes nothing', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture({ signal: controller.signal });
  await assert.rejects(f.docker.createDatabase(), { code: 'docker_inspect_failed' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.inspections('database_image').map(row => [row.classification, row.attempt]), [['cancelled', 0]]);
});

test('cancellation of an in-flight inspection cannot preempt independent cleanup', async () => {
  const controller = new AbortController();
  let reads = 0;
  const f = fixture({ signal: controller.signal, fault(argv) {
    if (dbRead(argv) && ++reads === 1) { controller.abort(); return new Promise(() => {}); }
  } });
  await assert.rejects(f.docker.createDatabase(), { code: 'docker_inspect_failed' });
  assert.equal(f.inspections('database_identity')[0].classification, 'cancelled');
  assert.equal(f.inspections('cleanup_container')[0].classification, 'valid');
  assert.equal(f.live.size, 0);
});

test('cancellation during injected sleep stops retries and still permits owned cleanup', async () => {
  const controller = new AbortController();
  let reads = 0;
  const f = fixture({ signal: controller.signal,
    fault(argv) { if (dbRead(argv) && ++reads === 1) throw transient(); },
    sleep: async () => { controller.abort(); } });
  await assert.rejects(f.docker.createDatabase(), { code: 'docker_inspect_failed' });
  assert.deepEqual(f.inspections('database_identity').map(row => row.classification), ['transient_transport', 'cancelled']);
  assert.equal(f.live.size, 0);
});

test('image and volume inspection retries have exact typed resource identities', async () => {
  const failed = new Set();
  const f = fixture({ fault(argv) {
    const type = argv[0] === 'image' ? 'images' : argv[0] === 'volume' && argv[1] === 'inspect' ? 'volumes' : undefined;
    if (!type || failed.has(argv[2])) return;
    failed.add(argv[2]); throw transient(argv[2], type);
  } });
  assert.equal(await f.docker.createDatabase(), DB);
  for (const site of ['database_image', 'created_volume']) {
    assert.ok(f.inspections(site).some(row => row.classification === 'transient_transport' && row.attempt === 1));
    assert.ok(f.inspections(site).some(row => row.classification === 'valid' && row.attempt === 2));
  }
});

test('isolation re-inspects both owned IDs and the exact foreign ID, never cached creation results', async () => {
  let failForeign = true;
  const f = fixture({ fault(argv) {
    if (argv[0] === 'inspect' && argv.at(-1) === FOREIGN && failForeign) { failForeign = false; throw transient(FOREIGN); }
  } });
  await f.docker.createDatabase(); await f.docker.createDriver({ database: DB });
  assert.equal((await f.docker.isolation({ database: DB, driver: DRIVER, shimPort: 18080 })).ok, true);
  assert.equal(f.inspections('database_identity').length, 2);
  assert.equal(f.inspections('driver_identity').length, 2);
  assert.deepEqual(f.inspections('foreign_network').map(row => [row.id, row.owned, row.attempt]), [[FOREIGN, false, 1], [FOREIGN, false, 2]]);
});

test('foreign transient followed by a different returned ID fails without another retry', async () => {
  let reads = 0;
  const f = fixture({ fault(argv) {
    if (argv[0] !== 'inspect' || argv.at(-1) !== FOREIGN) return;
    if (++reads === 1) throw transient(FOREIGN);
    return JSON.stringify({ Id: DB, NetworkSettings: { Networks: {} } });
  } });
  await f.docker.createDatabase(); await f.docker.createDriver({ database: DB });
  await assert.rejects(f.docker.isolation({ database: DB, driver: DRIVER, shimPort: 18080 }), { code: 'isolation_unknown' });
  assert.equal(reads, 2);
  assert.deepEqual(f.inspections('foreign_network').map(row => row.classification), ['transient_transport', 'validation_failed']);
  assert.ok(f.calls.filter(row => row.argv.at(-1) === FOREIGN).every(row => row.argv[2] === '{"Id":{{json .Id}},"NetworkSettings":{{json .NetworkSettings}}}'));
});

for (const [operation, call] of [
  ['snapshot_export', docker => docker.snapshot({ driver: DRIVER, scope: 'fiction-private-source', filename: `baseline-${RUN}.json` })],
  ['driver_ready', docker => docker.waitReady({ driver: DRIVER, port: 18080 })],
  ['warm_embedding', docker => docker.warmEmbedding({ driver: DRIVER, port: 18080, model: 'fiction-private-model' })],
]) {
  for (const malformed of [false, true]) {
    test(`${operation} ${malformed ? 'parse' : 'execute'} failure has safe diagnosis and NEVER retries`, async () => {
      const f = fixture({ fault(argv) {
        if (argv[0] !== 'exec') return;
        if (malformed) return 'fiction-private-source malformed';
        throw transient(DRIVER);
      } });
      await f.docker.createDatabase(); await f.docker.createDriver({ database: DB });
      await assert.rejects(call(f.docker), { code: 'docker_inspect_failed' });
      assert.equal(f.calls.filter(row => row.argv[0] === 'exec').length, 1);
      assert.deepEqual(f.receipts.filter(row => row.kind === 'docker_operation'), [{ kind: 'docker_operation', phase: 'failed',
        operation, site: operation, id: DRIVER, run_id: RUN, owned: true, classification: malformed ? 'malformed_json' : 'unclassified', attempt: 1 }]);
      assert.equal(JSON.stringify(f.receipts).includes('fiction-private'), false);
    });
  }
}

for (const effect of ['create', 'start', 'rm', 'volume_create', 'volume_rm', 'exec_detach']) {
  test(`${effect} effect is never retried`, async () => {
    let enabled = false;
    const matches = argv => effect === 'volume_create' ? argv[0] === 'volume' && argv[1] === 'create'
      : effect === 'volume_rm' ? argv[0] === 'volume' && argv[1] === 'rm'
        : effect === 'exec_detach' ? argv[0] === 'exec' && argv[1] === '--detach' : argv[0] === effect;
    const f = fixture({ fault(argv) { if (enabled && matches(argv)) throw transient(); } });
    let action;
    if (['create', 'start', 'volume_create'].includes(effect)) action = () => f.docker.createDatabase();
    else {
      await f.docker.createDatabase();
      if (effect === 'exec_detach') { await f.docker.createDriver({ database: DB }); action = () => f.docker.startShim({ driver: DRIVER, port: 18080 }); }
      else action = effect === 'rm' ? () => f.docker.removeContainer(DB) : () => f.docker.removeVolumes();
    }
    const before = f.calls.filter(row => matches(row.argv)).length;
    enabled = true;
    await assert.rejects(action());
    assert.equal(f.calls.filter(row => matches(row.argv)).length - before, 1);
    assert.deepEqual(f.sleeps, []);
  });
}

test('cleanup requires owned IDs, matching labels, positive exact absence and removal receipts', async () => {
  const f = fixture();
  await f.docker.createDatabase(); await f.docker.createDriver({ database: DB });
  await assert.rejects(f.docker.removeContainer(FOREIGN), { code: 'resource_not_owned' });
  await f.docker.removeContainer(DRIVER); await f.docker.removeContainer(DB); await f.docker.removeVolumes();
  assert.deepEqual(f.receipts.filter(row => row.phase === 'removed').map(row => row.id), [DRIVER, DB, dataVolume, logsVolume]);
  assert.equal(f.receipts.filter(row => row.phase === 'absence_proved').length, 4);
  assert.equal(f.live.size + f.volumes.size, 0);
  await assert.rejects(f.docker.removeContainer(DB), { code: 'resource_not_owned' });
});

for (const mode of ['unclassified absence', 'wrong missing ID', 'still present', 'transient absence', 'wrong cleanup label', 'wrong cleanup ID']) {
  test(`cleanup ${mode} stays unknown without a removed receipt`, async () => {
    let enabled = false;
    const f = fixture({ fault(argv, { live }) {
      if (!enabled || !dbRead(argv)) return;
      if (live.has(DB)) {
        if (mode.startsWith('wrong cleanup')) {
          const row = container(DB);
          if (mode === 'wrong cleanup ID') row.Id = FOREIGN;
          else row.Config.Labels['pi-memory.run'] = 'not-owned';
          return JSON.stringify([row]);
        }
        return;
      }
      if (mode === 'wrong missing ID') throw missing(FOREIGN);
      if (mode === 'still present') return JSON.stringify([container(DB)]);
      if (mode === 'transient absence') throw transient();
      throw new Error('unknown absence');
    } });
    await f.docker.createDatabase(); enabled = true;
    await assert.rejects(f.docker.removeContainer(DB), { code: 'cleanup_unknown' });
    assert.equal(f.receipts.some(row => row.phase === 'removed'), false);
    assert.deepEqual(f.sleeps, []);
    if (mode.startsWith('wrong cleanup')) assert.equal(f.calls.some(row => row.argv[0] === 'rm'), false);
    else assert.equal(f.calls.filter(row => dbRead(row.argv)).length, 3);
  });
}

test('transient cleanup inspection may retry but rm and absence proof remain single-shot', async () => {
  let enabled = false, reads = 0;
  const f = fixture({ fault(argv) { if (enabled && dbRead(argv) && ++reads === 1) throw transient(); } });
  await f.docker.createDatabase(); enabled = true;
  await f.docker.removeContainer(DB);
  assert.deepEqual(f.inspections('cleanup_container').map(row => row.attempt), [1, 2]);
  assert.equal(f.calls.filter(row => row.argv[0] === 'rm').length, 1);
  assert.equal(f.inspections('cleanup_absence').length, 1);
  assert.equal(f.receipts.filter(row => row.phase === 'removed').length, 1);
});
