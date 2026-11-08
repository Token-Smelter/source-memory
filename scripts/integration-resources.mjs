const fail = code => Object.assign(new Error(code), { code });

/** The caller persists each event before continuing and retains resources after uncertain creation. */
export function integrationResources({ runId, execute, record }) {
  if (!/^[a-f0-9-]{16,64}$/.test(runId ?? '') || typeof execute !== 'function' || typeof record !== 'function') throw fail('resource_input_invalid');
  const name = `source-memory-test-${runId}`;
  const label = `source-memory.run=${runId}`;
  const data = `${name}-data`, logs = `${name}-logs`;
  const volumes = [];
  let id = null;
  const emit = event => { try { record({ run_id: runId, ...event }); } catch { throw fail('resource_receipt_unknown'); } };
  const cmd = async args => (await execute('docker', args, { timeout: 90000 })).stdout.trim();
  const json = async args => { try { return JSON.parse(await cmd(args)); } catch { throw fail('resource_inspect_failed'); } };
  const absent = async args => {
    let missing = false;
    try { await cmd(args); } catch (error) { missing = /no such (container|volume|object)/i.test(String(error.stderr ?? '')); }
    if (!missing) throw fail('cleanup_unknown');
  };
  return {
    name,
    get id() { return id; },
    async create() {
      const declared = await json(['image', 'inspect', 'neo4j:5.26.14-community', '--format', '{{json .Config.Volumes}}']);
      if (!declared || Object.keys(declared).sort().join(',') !== '/data,/logs') throw fail('volume_invalid');
      for (const volume of [data, logs]) {
        emit({ kind: 'volume', phase: 'planned', id: volume });
        let created;
        try { created = await cmd(['volume', 'create', '--label', label, volume]); } catch { throw fail('creation_unknown'); }
        if (created !== volume) throw fail('creation_unknown');
        volumes.push(volume);
        emit({ kind: 'volume', phase: 'created', id: volume });
        const info = (await json(['volume', 'inspect', volume]))?.[0];
        if (info?.Name !== volume || info.Labels?.['source-memory.run'] !== runId) throw fail('volume_invalid');
      }
      emit({ kind: 'container', phase: 'planned', id: name });
      let created;
      try { created = await cmd(['create', '--name', name, '--label', label, '--publish', '127.0.0.1::7687', '--memory', '1536m', '--cpus', '2',
        '--mount', `type=volume,src=${data},dst=/data`, '--mount', `type=volume,src=${logs},dst=/logs`,
        '--env', 'NEO4J_AUTH=none', '--env', 'NEO4J_server_memory_heap_initial__size=512m',
        '--env', 'NEO4J_server_memory_heap_max__size=512m', '--env', 'NEO4J_server_memory_pagecache_size=128m', 'neo4j:5.26.14-community']); }
      catch { throw fail('creation_unknown'); }
      if (!/^[a-f0-9]{64}$/.test(created)) throw fail('creation_unknown');
      id = created;
      emit({ kind: 'container', phase: 'created', id, name });
      const info = (await json(['inspect', id]))?.[0];
      if (info?.Id !== id || info.Config?.Labels?.['source-memory.run'] !== runId || !Array.isArray(info.Mounts)
        || info.Mounts.length !== 2 || info.Mounts.some(m => m.Type !== 'volume'
          || !((m.Destination === '/data' && m.Name === data) || (m.Destination === '/logs' && m.Name === logs)))) throw fail('container_invalid');
      await cmd(['start', id]);
      return { id, name };
    },
    async cleanup() {
      if (id) {
        const info = (await json(['inspect', id]))?.[0];
        if (info?.Id !== id || info.Config?.Labels?.['source-memory.run'] !== runId) throw fail('cleanup_unknown');
        await cmd(['stop', '--time', '10', id]);
        await cmd(['rm', id]);
        await absent(['inspect', id]);
        emit({ kind: 'container', phase: 'removed', id });
        id = null;
      }
      for (const volume of [...volumes]) {
        const info = (await json(['volume', 'inspect', volume]))?.[0];
        if (info?.Name !== volume || info.Labels?.['source-memory.run'] !== runId) throw fail('cleanup_unknown');
        await cmd(['volume', 'rm', volume]);
        await absent(['volume', 'inspect', volume]);
        emit({ kind: 'volume', phase: 'removed', id: volume });
        volumes.splice(volumes.indexOf(volume), 1);
      }
    },
  };
}
