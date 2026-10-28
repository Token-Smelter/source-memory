import { connect } from 'node:net';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const attempt = () => new Promise(resolve => {
  const socket = connect({ host: 'pi-memory-db', port: 7687 });
  socket.setTimeout(1000);
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('timeout', () => { socket.destroy(); resolve(false); });
  socket.on('error', () => resolve(false));
});
let ready = false;
for (let i = 0; i < 60; i++) {
  if (await attempt()) { ready = true; break; }
  await wait(1000);
}
process.stdout.write(`${JSON.stringify({ ready })}\n`);
if (!ready) process.exitCode = 1;
