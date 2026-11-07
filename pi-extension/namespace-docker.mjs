import { execFile, spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const fail = code => Object.assign(new Error(code), { code });
const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validImage = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const validPath = value => typeof value === 'string' && isAbsolute(value) && !/[,\x00-\x1f]/.test(value);

async function command(argv) {
  const result = await exec('/usr/bin/docker', argv, { timeout: 90000, maxBuffer: 4_000_000,
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

/** Structural isolation: a network-none database and a driver sharing exactly its network namespace. */
export function createNamespaceDocker({ execute = command, probe = probeDriver, hostInterfaces = networkInterfaces,
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
  const json = async argv => { try { return JSON.parse(await execute(argv)); } catch { throw fail('docker_inspect_failed'); } };
  const requireOwned = id => { if (!validId(id) || !owned.has(id)) throw fail('resource_not_owned'); };
  const absent = async argv => {
    let missing = false;
    try { await execute(argv); } catch (error) { missing = /no such (container|volume|object)/i.test(String(error.stderr ?? '')); }
    if (!missing) throw fail('cleanup_unknown');
  };
  const remove = async id => {
    requireOwned(id);
    const value = (await json(['inspect', id]))?.[0];
    if (value?.Id !== id || value.Config?.Labels?.['pi-memory.run'] !== runId) throw fail('cleanup_unknown');
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
    const value = (await json(['volume', 'inspect', id]))?.[0];
    if (value?.Name !== id || value.Labels?.['pi-memory.run'] !== runId) throw fail('volume_invalid');
  };
  const inspect = async (id, image, mode, driver) => {
    const value = (await json(['inspect', id]))?.[0];
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
  };
  const hostIps = () => [...new Set(Object.values(hostInterfaces()).flat().filter(row => row && !row.internal && isIP(row.address)).map(row => row.address))].sort();
  return {
    async createDatabase() {
      const declared = await json(['image', 'inspect', databaseImage, '--format', '{{json .Config.Volumes}}']);
      if (!declared || Object.keys(declared).sort().join(',') !== '/data,/logs') throw fail('volume_invalid');
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
        const details = await json(['inspect', '--format', '{{json .NetworkSettings}}', id]);
        if (!details || typeof details !== 'object' || !details.Networks) throw fail('isolation_unknown');
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
    async startShim({ driver, port }) {
      requireOwned(driver);
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || [7474, 7687].includes(port)) throw fail('port_invalid');
      await execute(['exec', '--detach', driver, '/usr/local/bin/node', '/memory/pi-extension/embedding-shim.mjs', String(port)]);
    },
    async waitReady({ driver, port }) {
      requireOwned(driver);
      const result = await json(['exec', driver, '/usr/local/bin/node', '/memory/pi-extension/driver-ready.mjs', '127.0.0.1', '7687', String(port)]);
      if (result?.ready !== true) throw fail('database_unavailable');
    },
    removeContainer: remove,
    async removeVolumes() {
      for (const id of [...volumeNames]) {
        const value = (await json(['volume', 'inspect', id]))?.[0];
        if (value?.Name !== id || value.Labels?.['pi-memory.run'] !== runId) throw fail('cleanup_unknown');
        await execute(['volume', 'rm', id]);
        await absent(['volume', 'inspect', id]);
        record({ kind: 'volume', phase: 'removed', id, run_id: runId });
        volumeNames.delete(id);
      }
    },
  };
}
