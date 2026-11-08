import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
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

async function probeDriver(id, hosts) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/docker', ['exec', '-i', id, '/usr/local/bin/node', '/memory/pi-extension/pilot-probe.mjs'],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let failed = false;
    let settled = false;
    const stop = () => {
      if (settled) return;
      failed = true;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      clearTimeout(timer);
      reject(fail('isolation_unknown'));
    };
    const timer = setTimeout(stop, 30000);
    child.stdout.on('data', part => { size += part.length; if (size > 65536) stop(); else chunks.push(part); });
    child.stderr.resume();
    child.stdin.on('error', stop);
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed) return reject(fail('isolation_unknown'));
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if ((code === 0 && value?.ok === true) || (code === 1 && value?.ok === false)) resolve(value);
        else reject(fail('isolation_unknown'));
      } catch { reject(fail('isolation_unknown')); }
    });
    child.stdin.end(JSON.stringify(hosts));
  });
}

/** Docker effects are admitted by the caller; the adapter only cleans resources whose exact IDs it created. */
export function createDockerAdapter({ execute = command, probe = probeDriver, databaseImage, driverImage, mounts }) {
  if (!validImage(databaseImage) || !validImage(driverImage) || !validPath(mounts?.memory) || !validPath(mounts?.scratch)) throw fail('binding_invalid');
  const networks = new Set();
  const containers = new Set();
  const volumes = new Map();
  let gateway = null;
  const json = async argv => {
    try { return JSON.parse(await execute(argv)); } catch { throw fail('docker_inspect_failed'); }
  };
  const owned = (set, id) => { if (!validId(id) || !set.has(id)) throw fail('resource_not_owned'); };
  const absent = async (argv, pattern) => {
    let problem;
    try { await execute(argv); } catch (error) { problem = error; }
    if (!problem || !pattern.test(String(problem.stderr ?? ''))) throw fail('cleanup_unknown');
  };
  const removeContainer = async id => {
    owned(containers, id);
    const knownVolumes = volumes.get(id);
    await execute(['rm', '--force', '--volumes', id]);
    await absent(['inspect', id], /no such (container|object)/i);
    if (!knownVolumes) throw fail('cleanup_unknown');
    for (const volume of knownVolumes) await absent(['volume', 'inspect', volume], /no such (volume|object)/i);
    containers.delete(id);
    volumes.delete(id);
  };
  const removeNetwork = async id => {
    owned(networks, id);
    await execute(['network', 'rm', id]);
    await absent(['network', 'inspect', id], /no such (network|object)/i);
    networks.delete(id);
  };
  const inspectContainer = async (id, image, network, driver = false) => {
    const rows = await json(['inspect', id]);
    const value = rows?.[0];
    const joined = Object.values(value?.NetworkSettings?.Networks ?? {});
    if (value?.Id !== id || value.Image !== image || joined.length !== 1 || joined[0].NetworkID !== network
      || Object.keys(value.HostConfig?.PortBindings ?? {}).length || (driver && value.HostConfig?.ReadonlyRootfs !== true)) throw fail('container_invalid');
    if (!Array.isArray(value.Mounts)) throw fail('container_invalid');
    if (!driver) {
      if (value.Mounts.some(mount => mount.Type !== 'volume' || !validId(mount.Name))) throw fail('container_invalid');
      volumes.set(id, value.Mounts.map(mount => mount.Name));
    }
    if (driver) {
      const expected = new Map([['/memory', [mounts.memory, false]], ['/scratch', [mounts.scratch, true]]]);
      if (!Array.isArray(value.Mounts) || value.Mounts.length !== expected.size || value.Mounts.some(mount => {
        const target = expected.get(mount.Destination);
        return !target || mount.Type !== 'bind' || mount.Source !== target[0] || mount.RW !== target[1];
      })) throw fail('container_invalid');
      volumes.set(id, []);
    }
  };
  return {
    get gateway() { return gateway; },
    async createNetwork({ internal }) {
      if (internal !== true) throw fail('network_invalid');
      let id;
      try { id = (await execute(['network', 'create', '--internal', '--label', 'pi-memory-owned=true', `pi-memory-${randomUUID()}`])).trim(); }
      catch { throw fail('creation_unknown'); }
      if (!validId(id)) throw fail('creation_unknown');
      networks.add(id);
      try {
        const rows = await json(['network', 'inspect', id]);
        const value = rows?.[0];
        const ips = (value?.IPAM?.Config ?? []).map(row => row.Gateway).filter(ip => isIP(ip) === 4);
        if (value?.Id !== id || value.Internal !== true || ips.length !== 1) throw fail('network_invalid');
        gateway = ips[0];
        return id;
      } catch (problem) { try { await removeNetwork(id); } catch { throw fail('cleanup_unknown'); } throw problem; }
    },
    async createDatabase({ network, publishedPorts }) {
      owned(networks, network);
      if (publishedPorts !== false) throw fail('network_invalid');
      let id;
      try { id = (await execute(['create', '--network', network, '--network-alias', 'pi-memory-db', '--memory', '2g', '--cpus', '2',
        '--env', 'NEO4J_AUTH=none', '--env', 'NEO4J_server_memory_heap_initial__size=512m',
        '--env', 'NEO4J_server_memory_heap_max__size=512m', '--env', 'NEO4J_server_memory_pagecache_size=128m', databaseImage])).trim(); }
      catch { throw fail('creation_unknown'); }
      if (!validId(id)) throw fail('creation_unknown');
      containers.add(id);
      try { await inspectContainer(id, databaseImage, network); await execute(['start', id]); return id; }
      catch (problem) { try { await removeContainer(id); } catch { throw fail('cleanup_unknown'); } throw problem; }
    },
    async createDriver({ network, database }) {
      owned(networks, network);
      owned(containers, database);
      let id;
      try { id = (await execute(['create', '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--mount', `type=bind,src=${mounts.memory},dst=/memory,readonly`, '--mount', `type=bind,src=${mounts.scratch},dst=/scratch`,
        '--entrypoint', '/usr/local/bin/node', driverImage, '-e', 'setInterval(()=>{},2147483647)'])).trim(); }
      catch { throw fail('creation_unknown'); }
      if (!validId(id)) throw fail('creation_unknown');
      containers.add(id);
      try { await inspectContainer(id, driverImage, network, true); await execute(['start', id]); return id; }
      catch (problem) { try { await removeContainer(id); } catch { throw fail('cleanup_unknown'); } throw problem; }
    },
    async pilotIps() {
      const rows = await json(['inspect', 'source-memory-pilot-neo4j-1']);
      const addresses = Object.values(rows?.[0]?.NetworkSettings?.Networks ?? {})
        .flatMap(row => [row.IPAddress, row.GlobalIPv6Address]).filter(ip => isIP(ip));
      if (!addresses.length) throw fail('pilot_addresses_unavailable');
      return [...new Set(addresses)];
    },
    async waitReady({ driver }) {
      owned(containers, driver);
      const result = await json(['exec', driver, '/usr/local/bin/node', '/memory/pi-extension/driver-ready.mjs']);
      if (result?.ready !== true) throw fail('database_unavailable');
    },
    async isolation({ network, database, driver }) {
      owned(networks, network);
      owned(containers, database);
      owned(containers, driver);
      if (!gateway) throw fail('network_invalid');
      const hosts = [...new Set(['127.0.0.1', gateway, ...await this.pilotIps()])];
      const result = await probe(driver, hosts);
      if (!Array.isArray(result?.targets) || result.targets.length !== hosts.length
        || result.targets.some((row, index) => row.host !== hosts[index] || row.port !== 27690
          || !['connected', 'timeout', 'error'].includes(row.outcome))) throw fail('isolation_unknown');
      return { ok: result.targets.every(row => row.outcome !== 'connected'), targets: result.targets };
    },
    removeContainer,
    removeNetwork,
  };
}
