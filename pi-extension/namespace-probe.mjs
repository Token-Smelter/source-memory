import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { connect, isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = code => Object.assign(new Error(code), { code });

/** Reject every non-loopback interface and any live default or non-loopback route. */
export function inspectNamespace({ interfaces, ipv4Routes, ipv6Routes, namespace }) {
  if (!Array.isArray(interfaces) || interfaces.length !== 1 || interfaces[0] !== 'lo'
    || typeof namespace !== 'string' || !/^net:\[\d+\]$/.test(namespace)
    || typeof ipv4Routes !== 'string' || typeof ipv6Routes !== 'string') throw fail('namespace_invalid');
  const ipv4 = ipv4Routes.trim().split('\n').slice(1).filter(Boolean).map(line => line.trim().split(/\s+/));
  if (ipv4.some(row => row.length < 4 || !/^[0-9a-f]+$/i.test(row[3])
    || ((parseInt(row[3], 16) & 1) !== 0 && (row[0] !== 'lo' || row[1] === '00000000')))) throw fail('namespace_route_invalid');
  const ipv6 = ipv6Routes.trim().split('\n').filter(Boolean).map(line => line.trim().split(/\s+/));
  if (ipv6.some(row => {
    if (row.length !== 10 || !/^[0-9a-f]+$/i.test(row[8])) return true;
    const flags = parseInt(row[8], 16);
    if (!(flags & 1) || (flags & 0x200)) return false;
    return row[9] !== 'lo' || (row[0] === '0'.repeat(32) && row[1] === '00');
  })) throw fail('namespace_route_invalid');
  return { namespace, interfaces: ['lo'], no_default_route: true };
}

function dial({ host, port }) {
  return new Promise(resolveReply => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (outcome, errno) => {
      if (done) return;
      done = true; socket.destroy();
      resolveReply({ host, port, outcome, ...(errno ? { errno } : {}) });
    };
    socket.setTimeout(1000);
    socket.on('connect', () => finish('connected'));
    socket.on('timeout', () => finish('timeout'));
    socket.on('error', error => finish('error', error.code ?? 'UNKNOWN'));
  });
}

export async function probeNamespace({ targets, readState, dialFn = dial }) {
  if (!Array.isArray(targets) || !targets.length || targets.length > 2048 || targets.some(row => !isIP(row?.host)
    || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535 || Object.keys(row).some(key => !['host', 'port'].includes(key)))) throw fail('isolation_targets_invalid');
  const state = (readState ?? (() => ({ interfaces: readdirSync('/sys/class/net').sort(),
    ipv4Routes: readFileSync('/proc/net/route', 'utf8'), ipv6Routes: readFileSync('/proc/net/ipv6_route', 'utf8'),
    namespace: readlinkSync('/proc/self/ns/net') })))();
  const namespace = inspectNamespace(state);
  const unique = [...new Map(targets.map(row => [`${row.host}:${row.port}`, row])).values()];
  const results = [];
  for (let index = 0; index < unique.length; index += 32) {
    const batch = await Promise.all(unique.slice(index, index + 32).map(dialFn));
    for (const [i, row] of batch.entries()) {
      const expected = unique[index + i];
      if (row?.host !== expected.host || row.port !== expected.port || !['connected', 'timeout', 'error'].includes(row.outcome)) throw fail('isolation_unknown');
      results.push(row);
    }
  }
  return { ...namespace, ok: results.every(row => row.outcome !== 'connected'), targets: results };
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 256000) throw fail('input_too_large'); chunks.push(chunk); }
  const result = await probeNamespace(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('{"ok":false,"code":"isolation_unknown"}\n'); process.exitCode = 1; });
}
