import { connect } from 'node:net';

const host = process.argv[2] ?? 'pi-memory-db';
const ports = process.argv.length > 3 ? process.argv.slice(3).map(Number) : [7687];
if (!['pi-memory-db', '127.0.0.1'].includes(host) || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) process.exit(1);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const attempt = port => new Promise(resolve => {
  const socket = connect({ host, port });
  socket.setTimeout(1000);
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('timeout', () => { socket.destroy(); resolve(false); });
  socket.on('error', () => resolve(false));
});
let ready = false;
for (let i = 0; i < 60; i++) {
  if ((await Promise.all(ports.map(attempt))).every(Boolean)) { ready = true; break; }
  await wait(1000);
}
process.stdout.write(`${JSON.stringify({ ready })}\n`);
if (!ready) process.exitCode = 1;
