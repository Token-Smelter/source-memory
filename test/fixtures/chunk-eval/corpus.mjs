import { createHash } from 'node:crypto';

// A fully fictional retrieval corpus for chunking treatments. Each query names one gold source span: (turn key, entry id,
// UTF-16 interval) inside an unchanged entry, so treatments with different chunkings share one denominator. Dense entries
// put their needle sentence late in a byte-bounded legacy window that exceeds the 2,048-token context.
export const CORPUS_VERSION = 'chunk-eval-corpus/1';

const KEEPERS = ['Orla', 'Bram', 'Senna', 'Tovin', 'Ilse', 'Maro', 'Petra', 'Quill', 'Rhea', 'Soren', 'Talia', 'Udo', 'Vela'];
const THINGS = ['shutters', 'beacon lens', 'tide gauge', 'rope locker', 'fog horn', 'signal flags', 'rain barrel', 'chart table',
  'oil lamp', 'boat winch', 'weather vane', 'pigeon loft', 'bell rope'];
const COLORS = ['teal', 'amber', 'crimson', 'ochre', 'slate', 'violet', 'umber', 'jade', 'cobalt', 'saffron', 'ivory', 'rust', 'sable'];
const PLACES = ['Gullrock', 'Marrow Point', 'Kestrel Isle', 'Brine Hollow', 'Ashcombe Light', 'Wren Shoal', 'Fennick Bay', 'Oxley Spit',
  'Harrow Reach', 'Lantern Cay', 'Pell Narrows', 'Duskwater', 'Cormorant Rock'];

// Deterministic pseudo-random words; no real data.
function stream(seed) {
  let state = createHash('sha256').update(seed).digest();
  let offset = 0;
  return () => {
    if (offset + 4 > state.length) { state = createHash('sha256').update(state).digest(); offset = 0; }
    const value = state.readUInt32LE(offset);
    offset += 4;
    return value;
  };
}

const base64Words = (seed, count) => {
  const next = stream(seed);
  return Array.from({ length: count }, () => Buffer.from(Array.from({ length: 24 }, () => next() & 255)).toString('base64'));
};

const hexLog = (seed, count) => {
  const next = stream(seed);
  return Array.from({ length: count }, (_, i) => `ts=${1000 + i} id=${next().toString(16)}${next().toString(16)} crc=0x${(next() >>> 0).toString(16)}`);
};

const prose = (seed, sentences) => {
  const next = stream(seed);
  const pick = list => list[next() % list.length];
  return Array.from({ length: sentences }, () =>
    `The keeper at ${pick(PLACES)} noted that the ${pick(THINGS)} needed ${pick(['oil', 'paint', 'new hinges', 'a clean', 'tightening'])} before the ${pick(['spring', 'gale', 'equinox', 'regatta'])}.`).join(' ');
};

const needle = i => `${KEEPERS[i]} repainted the ${THINGS[i]} at ${PLACES[i]} a deep ${COLORS[i]} after the winter storm.`;
const question = i => `What colour did ${KEEPERS[i]} paint the ${THINGS[i]} at ${PLACES[i]}?`;

export function chunkEvalCorpus() {
  const turns = [];
  const queries = [];
  const add = (key, subset, before, i, after) => {
    const text = `${before}${before ? ' ' : ''}${needle(i)}${after ? ' ' : ''}${after}`;
    const start = before.length + (before ? 1 : 0);
    turns.push({ key, entries: [{ id: 'e0', role: 'user', text }] });
    queries.push({ id: `q-${key}`, subset, text: question(i), gold: { turn: key, entry_id: 'e0', start, end: start + needle(i).length } });
  };
  // Dense: about 170 base64 words (≤ 8,192 bytes, well over 2,048 tokens) precede the needle inside one legacy window.
  for (let i = 0; i < 6; i++) add(`dense-b64-${i}`, 'dense', base64Words(`b64-${i}`, 170).join(' '), i, base64Words(`b64-tail-${i}`, 40).join(' '));
  for (let i = 6; i < 9; i++) add(`dense-log-${i}`, 'dense', hexLog(`log-${i}`, 60).join('\n'), i, hexLog(`log-tail-${i}`, 10).join('\n'));
  // Ordinary prose: the needle sits among similar distractor sentences.
  for (let i = 9; i < 12; i++) add(`prose-${i}`, 'ordinary', prose(`prose-${i}`, 20), i, prose(`prose-tail-${i}`, 10));
  // A short note, so the default must not regress on small turns.
  add('short-12', 'ordinary', '', 12, '');
  // Distractors: the same people and things with other colours and no storm, in their own turns.
  for (let i = 0; i < 12; i++) {
    const other = (i + 5) % 12;
    turns.push({ key: `distractor-${i}`, entries: [{ id: 'e0', role: 'assistant',
      text: `${prose(`distractor-${i}`, 6)} ${KEEPERS[i]} once considered ${COLORS[other]} for the ${THINGS[other]} but chose nothing.` }] });
  }
  return { version: CORPUS_VERSION, turns, queries };
}
