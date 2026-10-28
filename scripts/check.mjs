import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
let checked = 0;
for (const file of ['src', 'bin', 'scripts', 'test', 'pi-extension'].flatMap(files).filter(path => path.endsWith('.mjs'))) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  if (readFileSync(file, 'utf8').split('\n').some(line => /[\t ]+$/.test(line))) {
    throw new Error(`Trailing whitespace: ${file}`);
  }
  checked++;
}
const json = ['package.json', ...readdirSync('examples').map(name => `examples/${name}`), ...readdirSync('config').map(name => `config/${name}`)]
  .filter(path => path.endsWith('.json'));
for (const path of json) JSON.parse(readFileSync(path, 'utf8'));
console.log(`source checks: ${checked} JavaScript files parsed; ${json.length} JSON files valid`);
