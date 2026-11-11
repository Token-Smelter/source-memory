import { execFile, spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleepTimer } from 'node:timers/promises';

const exec = promisify(execFile);
const fail = code => Object.assign(new Error(code), { code });
const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validImage = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const validPath = value => typeof value === 'string' && isAbsolute(value) && !/[,\x00-\x1f]/.test(value);

async function command(argv, { timeout = 150000, signal } = {}) {
  const result = await exec('/usr/bin/docker', argv, { timeout, signal, maxBuffer: 4_000_000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
  return result.stdout.trim();
}

async function probeDriver(id, targets) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/docker', ['exec', '-i', id, '/usr/local/bin/node', '/memory/pi-extension/namespace-probe.mjs'],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) { try { child.kill('SIGKILL'); } catch {} reject(fail('isolation_unknown')); } else resolve(result);
    };
    const timer = setTimeout(() => finish(true), 90000);
    child.stdout.on('data', data => { size += data.length; if (size > 1_000_000) finish(true); else chunks.push(data); });
    child.stderr.resume();
    child.stdin.on('error', () => finish(true));
    child.on('error', () => finish(true));
    child.on('close', code => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if ((code === 0 && result?.ok === true) || (code === 1 && result?.ok === false)) finish(false, result);
        else finish(true);
      } catch { finish(true); }
    });
    child.stdin.end(JSON.stringify({ targets }));
  });
}

// Only a complete Docker CLI GET transport error for this exact resource is retryable.
function inspectionFailure(error, endpoint) {
  const stderr = typeof error?.stderr === 'string' && error.stderr.length <= 4096 ? error.stderr.trim() : '';
  if (error?.code === 'EACCES' || /permission denied|access denied|operation not permitted/i.test(stderr)) return 'permission';
  if (/no such (container|volume|object|image)/i.test(stderr)) return 'missing';
  const transport = /^error during connect: Get "http:\/\/%2F(?:var%2F)?run%2Fdocker\.sock\/v\d+\.\d+([^"\s]+)": (?:unexpected EOF|EOF)$/.exec(stderr);
  if (error?.code === 1 && !error.killed && !error.signal && transport) {
    try { if (decodeURIComponent(transport[1]) === endpoint) return 'transient_transport'; } catch {}
  }
  return 'unclassified';
}

/** Structural isolation: a network-none database and a driver sharing exactly its network namespace. */
export function createNamespaceDocker({ execute = command, probe = probeDriver, hostInterfaces = networkInterfaces,
  now = () => performance.now(), sleep = (ms, options) => sleepTimer(ms, undefined, options), signal,
  databaseImage, driverImage, mounts, runId, onResource }) {
  if (!validImage(databaseImage) || !validImage(driverImage) || !validPath(mounts?.memory) || !validPath(mounts?.scratch)
    || !/^[a-f0-9-]{16,64}$/.test(runId ?? '') || typeof onResource !== 'function') throw fail('binding_invalid');
  if (!Number.isSafeInteger(process.getuid?.()) || process.getuid() < 1 || !Number.isSafeInteger(process.getgid?.())) throw fail('driver_user_invalid');
  const driverUser = `${process.getuid()}:${process.getgid()}`;
  const owned = new Set();
  const volumeNames = new Set();
  const label = `pi-memory.run=${runId}`;
  const record = event => { try { onResource(event); } catch { throw fail('resource_receipt_unknown'); } };
  const dataVolume = `pi-memory-${runId}-data`;
  const logsVolume = `pi-memory-${runId}-logs`;
  // Exec JSON is deliberately single-shot: it may perform writes or paid work.
  const json = async (operation, id, argv) => {
    let classification = 'unclassified';
    try {
      let output;
      try { output = await execute(argv); } catch (error) { classification = inspectionFailure(error, ''); throw error; }
      try { return JSON.parse(output); } catch (error) { classification = 'malformed_json'; throw error; }
    } catch {
      record({ kind: 'docker_operation', phase: 'failed', operation, site: operation, id,
        run_id: runId, owned: owned.has(id), classification, attempt: 1 });
      throw fail('docker_inspect_failed');
    }
  };
  const inspectJson = async (operation, id, validate, site, cleanup = false) => {
    const networkOnly = operation === 'container_network_inspect';
    const type = operation === 'container_inspect' || networkOnly ? 'container' : operation === 'volume_inspect' ? 'volume' : 'image';
    const argv = networkOnly ? ['inspect', '--format', '{"Id":{{json .Id}},"NetworkSettings":{{json .NetworkSettings}}}', id]
      : type === 'container' ? ['inspect', id] : type === 'volume' ? ['volume', 'inspect', id]
        : ['image', 'inspect', id, '--format', '{{json .Config.Volumes}}'];
    const endpoint = type === 'container' ? `/containers/${id}/json` : type === 'volume' ? `/volumes/${id}` : `/images/${id}/json`;
    const deadline = now() + 5000;
    const controller = new AbortController();
    // Caller cancellation cannot prevent the independent exact-ID cleanup inspection.
    const callerSignal = cleanup ? undefined : signal;
    let stopped;
    let attempt = 0;
    let rejectStopped;
    const interrupted = new Promise((_resolve, reject) => { rejectStopped = reject; });
    // A pre-aborted signal must not create an unhandled rejection before the first race.
    interrupted.catch(() => {});
    const stop = classification => {
      if (stopped) return;
      stopped = classification;
      controller.abort();
      rejectStopped(fail('docker_inspect_failed'));
    };
    const cancel = () => stop('cancelled');
    const timer = setTimeout(() => stop('deadline'), 5000);
    callerSignal?.addEventListener('abort', cancel, { once: true });
    if (callerSignal?.aborted) cancel();
    const check = () => {
      if (!stopped && now() >= deadline) stop('deadline');
      if (stopped) throw fail('docker_inspect_failed');
    };
    const diagnostic = (phase, classification) => record({ kind: 'docker_inspection', phase, operation, site, id,
      run_id: runId, owned: owned.has(id) || volumeNames.has(id), classification, attempt });
    try {
      for (;;) {
        let classification;
        let problem;
        try {
          check();
          attempt++;
          let output;
          try {
            output = await Promise.race([execute(argv, { timeout: Math.max(1, Math.ceil(deadline - now())), signal: controller.signal }), interrupted]);
          } catch (error) {
            classification = inspectionFailure(error, endpoint);
            throw fail('docker_inspect_failed');
          }
          check();
          let value;
          try { value = JSON.parse(output); } catch { classification = 'malformed_json'; throw fail('docker_inspect_failed'); }
          try { validate(value); } catch (error) { classification = 'validation_failed'; throw error; }
          check();
          diagnostic('succeeded', 'valid');
          return value;
        } catch (error) {
          problem = error;
          classification = stopped ?? classification ?? 'unclassified';
        }
        diagnostic('failed', classification);
        if (classification !== 'transient_transport' || attempt >= 3) throw problem;
        try {
          check();
          await Promise.race([sleep(100 * attempt, { signal: controller.signal }), interrupted]);
          check();
        } catch {
          diagnostic('failed', stopped ?? 'unclassified');
          throw fail('docker_inspect_failed');
        }
      }
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', cancel);
    }
  };
  const requireOwned = id => { if (!validId(id) || !owned.has(id)) throw fail('resource_not_owned'); };
  const absent = async argv => {
    const volume = argv[0] === 'volume';
    const id = argv.at(-1);
    let missing = false;
    let classification = 'still_present';
    try { await execute(argv, { timeout: 5000 }); } catch (error) {
      const stderr = typeof error?.stderr === 'string' && error.stderr.length <= 4096 ? error.stderr.trim() : '';
      const proofs = volume ? [`Error response from daemon: get ${id}: no such volume`, `Error: No such volume: ${id}`]
        : [`Error: No such object: ${id}`, `Error response from daemon: No such container: ${id}`];
      missing = error?.code === 1 && !error.killed && !error.signal && proofs.includes(stderr);
      classification = missing ? 'missing' : inspectionFailure(error, '');
    }
    record({ kind: 'docker_inspection', phase: missing ? 'absence_proved' : 'failed',
      operation: volume ? 'volume_absence' : 'container_absence', site: 'cleanup_absence', id, run_id: runId, owned: true, classification, attempt: 1 });
    if (!missing) throw fail('cleanup_unknown');
  };
  const remove = async id => {
    requireOwned(id);
    await inspectJson('container_inspect', id, rows => {
      const value = rows?.[0];
      if (value?.Id !== id || value.Config?.Labels?.['pi-memory.run'] !== runId) throw fail('cleanup_unknown');
    }, 'cleanup_container', true);
    await execute(['rm', '--force', id]);
    await absent(['inspect', id]);
    record({ kind: 'container', phase: 'removed', id, run_id: runId });
    owned.delete(id);
  };
  const createVolume = async name => {
    record({ kind: 'volume', phase: 'planned', id: name, run_id: runId });
    let id;
    try { id = (await execute(['volume', 'create', '--label', label, name])).trim(); }
    catch { throw fail('creation_unknown'); }
    if (id !== name) throw fail('creation_unknown');
    volumeNames.add(id);
    record({ kind: 'volume', phase: 'created', id, run_id: runId });
    await inspectJson('volume_inspect', id, rows => {
      const value = rows?.[0];
      if (value?.Name !== id || value.Labels?.['pi-memory.run'] !== runId) throw fail('volume_invalid');
    }, 'created_volume');
  };
  const inspect = async (id, image, mode, driver) => inspectJson('container_inspect', id, rows => {
    const value = rows?.[0];
    if (value?.Id !== id || value.Image !== image || value.Config?.Labels?.['pi-memory.run'] !== runId || value.HostConfig?.NetworkMode !== mode
      || Object.keys(value.HostConfig?.PortBindings ?? {}).length || !Array.isArray(value.Mounts)) throw fail('container_invalid');
    if (driver) {
      const expected = new Map([['/memory', [mounts.memory, false]], ['/scratch', [mounts.scratch, true]]]);
      if (value.Config.User !== driverUser || value.HostConfig.ReadonlyRootfs !== true || !Array.isArray(value.HostConfig.CapDrop)
        || !value.HostConfig.CapDrop.includes('ALL') || Object.keys(value.NetworkSettings?.Networks ?? {}).length
        || value.Mounts.length !== expected.size || value.Mounts.some(mount => {
          const required = expected.get(mount.Destination);
          return !required || mount.Type !== 'bind' || mount.Source !== required[0] || mount.RW !== required[1];
        })) throw fail('container_invalid');
    } else {
      const networks = Object.values(value.NetworkSettings?.Networks ?? {});
      const expected = new Map([['/data', dataVolume], ['/logs', logsVolume]]);
      if (networks.some(row => row.IPAddress || row.GlobalIPv6Address || row.Gateway || row.IPv6Gateway)
        || value.Mounts.length !== expected.size || value.Mounts.some(row => row.Type !== 'volume' || expected.get(row.Destination) !== row.Name)) throw fail('container_invalid');
    }
  }, driver ? 'driver_identity' : 'database_identity');
  const hostIps = () => [...new Set(Object.values(hostInterfaces()).flat().filter(row => row && !row.internal && isIP(row.address)).map(row => row.address))].sort();
  return {
    async createDatabase() {
      await inspectJson('image_inspect', databaseImage, declared => {
        if (!declared || Object.keys(declared).sort().join(',') !== '/data,/logs') throw fail('volume_invalid');
      }, 'database_image');
      await createVolume(dataVolume);
      await createVolume(logsVolume);
      const name = `pi-memory-${runId}-db`;
      record({ kind: 'container', phase: 'planned', id: name, run_id: runId });
      let id;
      try { id = (await execute(['create', '--name', name, '--label', label, '--network', 'none', '--hostname', 'pi-memory-db', '--add-host', 'pi-memory-db:127.0.0.1', '--memory', '2g', '--cpus', '2',
        '--mount', `type=volume,src=${dataVolume},dst=/data`, '--mount', `type=volume,src=${logsVolume},dst=/logs`,
        '--env', 'NEO4J_AUTH=none', '--env', 'NEO4J_server_memory_heap_initial__size=512m',
        '--env', 'NEO4J_server_memory_heap_max__size=512m', '--env', 'NEO4J_server_memory_pagecache_size=128m', databaseImage])).trim(); }
      catch { throw fail('creation_unknown'); }
      if (!validId(id)) throw fail('creation_unknown');
      owned.add(id);
      record({ kind: 'container', phase: 'created', id, name, run_id: runId });
      try { await inspect(id, databaseImage, 'none', false); await execute(['start', id]); return id; }
      catch (problem) { try { await remove(id); } catch { throw fail('cleanup_unknown'); } throw problem; }
    },
    async createDriver({ database }) {
      requireOwned(database);
      await inspectJson('image_inspect', driverImage, declared => {
        if (declared !== null && (typeof declared !== 'object' || Object.keys(declared).length !== 0)) throw fail('volume_invalid');
      }, 'driver_image');
      const name = `pi-memory-${runId}-driver`;
      record({ kind: 'container', phase: 'planned', id: name, run_id: runId });
      let id;
      try { id = (await execute(['create', '--name', name, '--label', label, '--network', `container:${database}`, '--user', driverUser, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--mount', `type=bind,src=${mounts.memory},dst=/memory,readonly`, '--mount', `type=bind,src=${mounts.scratch},dst=/scratch`,
        '--entrypoint', '/usr/local/bin/node', driverImage, '-e', 'setInterval(()=>{},2147483647)'])).trim(); }
      catch { throw fail('creation_unknown'); }
      if (!validId(id)) throw fail('creation_unknown');
      owned.add(id);
      record({ kind: 'container', phase: 'created', id, name, run_id: runId });
      try { await inspect(id, driverImage, `container:${database}`, true); await execute(['start', id]); return id; }
      catch (problem) { try { await remove(id); } catch { throw fail('cleanup_unknown'); } throw problem; }
    },
    async isolation({ database, driver, shimPort }) {
      requireOwned(database); requireOwned(driver);
      if (!Number.isInteger(shimPort) || shimPort < 1024 || shimPort > 65535 || [7474, 7687].includes(shimPort)) throw fail('port_invalid');
      await inspect(database, databaseImage, 'none', false);
      await inspect(driver, driverImage, `container:${database}`, true);
      const dbNamespace = (await execute(['exec', database, '/bin/readlink', '/proc/self/ns/net'])).trim();
      if (!/^net:\[\d+\]$/.test(dbNamespace)) throw fail('isolation_unknown');
      const list = (await execute(['ps', '--no-trunc', '--quiet'])).split('\n').filter(Boolean);
      if (list.some(id => !validId(id)) || !list.includes(database) || !list.includes(driver)) throw fail('isolation_unknown');
      const addresses = [];
      const ports = new Set();
      for (const id of list) {
        if (id === database || id === driver) continue;
        const value = await inspectJson('container_network_inspect', id, row => {
          if (row?.Id !== id || !row.NetworkSettings?.Networks) throw fail('isolation_unknown');
        }, 'foreign_network');
        const details = value.NetworkSettings;
        for (const net of Object.values(details.Networks)) for (const ip of [net.IPAddress, net.GlobalIPv6Address]) if (isIP(ip)) addresses.push(ip);
        for (const key of ['7687/tcp', '7474/tcp']) for (const binding of details.Ports?.[key] ?? []) {
          const port = Number(binding.HostPort);
          if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw fail('isolation_unknown');
          ports.add(port);
        }
      }
      const allHosts = hostIps();
      const hosts = allHosts.filter(host => !/^fe[89ab][0-9a-f]:/i.test(host));
      const unprobeableLinkLocal = allHosts.filter(host => !hosts.includes(host));
      if (!hosts.length) throw fail('host_addresses_unavailable');
      const targets = [];
      for (const host of [...new Set(addresses)]) for (const port of [7687, 7474]) targets.push({ host, port });
      for (const host of hosts) for (const port of new Set([...ports, 7687, 7474, 11434])) targets.push({ host, port });
      for (const port of ports) if (![7687, 7474, shimPort].includes(port)) targets.push({ host: '127.0.0.1', port });
      const unique = [...new Map(targets.map(row => [`${row.host}:${row.port}`, row])).values()];
      if (!unique.length) throw fail('isolation_unknown');
      const result = await probe(driver, unique);
      if (result?.namespace !== dbNamespace || result.no_default_route !== true || result.interfaces?.length !== 1
        || result.interfaces[0] !== 'lo' || !Array.isArray(result.targets) || result.targets.length !== unique.length
        || result.targets.some((row, i) => row.host !== unique[i].host || row.port !== unique[i].port
          || !['connected', 'timeout', 'error'].includes(row.outcome)
          || (row.outcome === 'error' && !['ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED'].includes(row.errno)))) throw fail('isolation_unknown');
      return { ok: result.ok === true && result.targets.every(row => row.outcome !== 'connected'), network_mode: 'none-shared-namespace',
        namespace: dbNamespace, interfaces: result.interfaces, no_default_route: true, host_addresses: hosts,
        unprobeable_link_local: unprobeableLinkLocal, foreign_container_count: list.length - 2, targets: result.targets };
    },
    async snapshot({ driver, scope, filename }) {
      requireOwned(driver);
      if (typeof scope !== 'string' || !scope || scope.length > 256 || !/^baseline-[a-f0-9-]+\.json$/.test(filename ?? '')) throw fail('snapshot_invalid');
      const result = await json('snapshot_export', driver, ['exec', driver, '/usr/local/bin/node', '/memory/pi-extension/export-scope.mjs', scope, `/scratch/${filename}`]);
      if (!/^[a-f0-9]{64}$/.test(result?.sha256 ?? '') || !Number.isSafeInteger(result.bytes) || result.bytes < 1
        || result.restore_verified !== false) throw fail('snapshot_invalid');
      return { ...result, path: `${mounts.scratch}/${filename}` };
    },
    async startShim({ driver, port }) {
      requireOwned(driver);
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || [7474, 7687].includes(port)) throw fail('port_invalid');
      await execute(['exec', '--detach', driver, '/usr/local/bin/node', '/memory/pi-extension/embedding-shim.mjs', String(port)]);
    },
    async waitReady({ driver, port }) {
      requireOwned(driver);
      const result = await json('driver_ready', driver, ['exec', driver, '/usr/local/bin/node', '/memory/pi-extension/driver-ready.mjs', '127.0.0.1', '7687', String(port)]);
      if (result?.ready !== true) throw fail('database_unavailable');
    },
    async warmEmbedding({ driver, port, model = 'embeddinggemma', dimensions = 768 }) {
      requireOwned(driver);
      if (typeof model !== 'string' || !model || !Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 4096) throw fail('embedding_unavailable');
      const result = await json('warm_embedding', driver, ['exec', driver, '/usr/local/bin/node', '/memory/pi-extension/warm-embedding.mjs', String(port), model, String(dimensions)]);
      if (result?.ready !== true || !Number.isSafeInteger(result.elapsed_ms)) throw fail('embedding_unavailable');
      return result;
    },
    removeContainer: remove,
    async removeVolumes() {
      for (const id of [...volumeNames]) {
        await inspectJson('volume_inspect', id, rows => {
          const value = rows?.[0];
          if (value?.Name !== id || value.Labels?.['pi-memory.run'] !== runId) throw fail('cleanup_unknown');
        }, 'cleanup_volume', true);
        await execute(['volume', 'rm', id]);
        await absent(['volume', 'inspect', id]);
        record({ kind: 'volume', phase: 'removed', id, run_id: runId });
        volumeNames.delete(id);
      }
    },
  };
}
