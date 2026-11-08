import { connect, isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = code => Object.assign(new Error(code), { code });
const dial = host => new Promise(resolveReply => {
  const socket = connect({ host, port: 27690 });
  socket.setTimeout(1000);
  socket.on('connect', () => { socket.destroy(); resolveReply({ outcome: 'connected' }); });
  socket.on('timeout', () => { socket.destroy(); resolveReply({ outcome: 'timeout' }); });
  socket.on('error', error => resolveReply({ outcome: 'error', errno: error.code ?? 'UNKNOWN' }));
});

/** Runs inside the admitted driver; addresses are network metadata, never session content. */
export async function probePilot(hosts, dialFn = dial) {
  if (!Array.isArray(hosts) || hosts.length < 3 || !hosts.includes('127.0.0.1') || hosts.some(host => !isIP(host))) throw fail('isolation_targets_invalid');
  const targets = [];
  for (const host of [...new Set(hosts)]) {
    const result = await dialFn(host);
    if (!['connected', 'timeout', 'error'].includes(result?.outcome)) throw fail('isolation_unknown');
    targets.push({ host, port: 27690, ...result });
  }
  return { ok: targets.every(row => row.outcome !== 'connected'), targets };
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 65536) throw fail('input_too_large'); chunks.push(chunk); }
  const result = await probePilot(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('{"ok":false,"code":"isolation_unknown"}\n'); process.exitCode = 1; });
}
