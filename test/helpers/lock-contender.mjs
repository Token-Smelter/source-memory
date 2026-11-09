import { createCoverageJournal } from '../../pi-extension/coverage.mjs';
import { acquireOwnerLock } from '../../pi-extension/owner-lock.mjs';

// One process contending for a pid-locked journal: report whether it held it, hold, then release.
// With a lock path and a pause, it takes the owner lock directly and pauses inside the takeover window.
const [directory, sessionKey, holdMs, lockPath, pauseMs] = process.argv.slice(2);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
try {
  if (lockPath) {
    const lock = acquireOwnerLock(lockPath, { beforeBreak: () => { process.stdout.write('breaking\n'); sleep(Number(pauseMs)); } });
    process.stdout.write('held\n');
    sleep(Number(holdMs));
    lock.release();
  } else {
    const journal = createCoverageJournal({ directory, sessionKey, pidLock: true });
    process.stdout.write('held\n');
    await new Promise(resolve => setTimeout(resolve, Number(holdMs)));
    journal.close();
  }
} catch (error) { process.stdout.write(`${error.code ?? 'error'}\n`); }
