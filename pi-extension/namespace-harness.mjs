const fail = code => Object.assign(new Error(code), { code });

/** Neither Memory nor the work callback is opened before namespace isolation has been verified. */
export async function runNamespaceHarness({ docker, relay, socketPath, shimPort, memoryFactory, work, onIsolation = async () => {} }) {
  let database, driver, listener, memory;
  let outcome = { status: 'failed' };
  let cleanupFailed = false;
  try {
    if (typeof memoryFactory !== 'function' || typeof work !== 'function' || typeof onIsolation !== 'function') throw fail('input_invalid');
    database = await docker.createDatabase();
    driver = await docker.createDriver({ database });
    const gate = await docker.isolation({ database, driver, shimPort });
    await onIsolation(gate);
    if (gate?.ok !== true || gate.network_mode !== 'none-shared-namespace' || gate.no_default_route !== true
      || gate.interfaces?.length !== 1 || gate.interfaces[0] !== 'lo' || !Array.isArray(gate.targets) || !gate.targets.length
      || gate.targets.some(row => !['error', 'timeout'].includes(row.outcome))) {
      outcome = { status: 'isolation_failed', isolation: gate };
    } else {
      listener = await relay.open({ socketPath });
      await docker.startShim({ driver, port: shimPort });
      await docker.waitReady({ driver, port: shimPort });
      memory = await memoryFactory({ database, driver });
      if (!memory || typeof memory.init !== 'function' || typeof memory.close !== 'function') throw fail('memory_invalid');
      await memory.init();
      outcome = { status: 'complete', isolation: gate, result: await work({ memory, isolation: gate, driver }) };
    }
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'harness_failed';
    outcome = { status: ['creation_unknown', 'cleanup_unknown', 'resource_receipt_unknown'].includes(code) ? 'cleanup_unknown' : 'failed', code };
    if (outcome.status === 'cleanup_unknown') cleanupFailed = true;
  } finally {
    try { if (memory && await memory.close() !== 'closed') cleanupFailed = true; } catch { cleanupFailed = true; }
    try { await listener?.close(); } catch { cleanupFailed = true; }
    for (const id of [driver, database].filter(Boolean)) try { await docker.removeContainer(id); } catch { cleanupFailed = true; }
    try { await docker.removeVolumes?.(); } catch { cleanupFailed = true; }
    if (cleanupFailed) outcome.status = 'cleanup_unknown';
  }
  return outcome;
}
