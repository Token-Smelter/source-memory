import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextWindow, omittedHistoryNote } from '../pi-extension/pi-runtime.mjs';

const user = (i, size = 100) => ({ role: 'user', content: [{ type: 'text', text: `u${i}`.padEnd(size, 'x') }], timestamp: i });
const assistant = (i, size = 100) => ({ role: 'assistant', content: [{ type: 'text', text: `a${i}`.padEnd(size, 'y') }], timestamp: i });
const toolResult = (i, size = 100) => ({ role: 'toolResult', toolCallId: `t${i}`, content: [{ type: 'text', text: `r${i}`.padEnd(size, 'z') }], timestamp: i });
const history = turns => Array.from({ length: turns }, (_, i) => [user(i), assistant(i), toolResult(i)]).flat();
const bytes = value => Buffer.byteLength(JSON.stringify(value));

test('a context under the threshold is passed through unchanged', () => {
  const messages = history(3), window = createContextWindow({ contextWindow: 1_000_000 });
  const result = window.apply(messages, { promptBytes: 1000 });
  assert.deepEqual([result.messages === messages, result.status], [true, null]);
});

test('an overflow cuts whole turns once, before a user message, and keeps that cut while the context fits', () => {
  const window = createContextWindow({ contextWindow: 3000 });
  const first = window.apply(history(12), { promptBytes: 0 });
  const cut = first.status.omitted_messages;
  assert.deepEqual([first.status.recut, first.messages[0].content[0].text, first.messages[1].role, cut % 3],
    [true, omittedHistoryNote(cut), 'user', 0]);
  const next = window.apply([...history(12), user(12, 10)], { promptBytes: 0 });
  assert.deepEqual([next.status.recut, next.status.omitted_messages, JSON.stringify(next.messages.slice(0, first.messages.length))],
    [false, cut, JSON.stringify(first.messages)]);
});

test('a large task prompt and the tool-round reserve force a cut of a small history', () => {
  const messages = history(20), window = createContextWindow({ contextWindow: 10_000 });
  assert.equal(window.apply(messages, { promptBytes: 0 }).status, null);
  const result = window.apply(messages, { promptBytes: 6_000 });
  assert.deepEqual([result.status.recut, result.status.estimated_request_tokens <= 7000], [true, true]);
});

test('a later overflow moves the cut forward, and an uncuttable estimate is sent and disclosed', () => {
  const window = createContextWindow({ contextWindow: 3000 });
  const cut = window.apply(history(12), { promptBytes: 0 }).status.omitted_messages;
  const later = window.apply(history(30), { promptBytes: 0 });
  assert.equal(later.status.recut && later.status.omitted_messages > cut, true);
  const over = createContextWindow({ contextWindow: 10 }).apply([user(0, 5000)], { promptBytes: 0 });
  assert.deepEqual([over.status.over_estimate, over.status.omitted_messages], [true, 0]);
});

test('a large context of sparse tokens is not cut once its observed usage shows it fits', () => {
  const messages = history(40), size = bytes(messages);
  const window = createContextWindow({ contextWindow: Math.ceil(size * 0.5) });
  window.observe(messages, 200, Math.ceil(size * 0.15));
  const next = [...messages, user(40)];
  assert.deepEqual([window.apply(next, { promptBytes: 200 }).messages === next, window.state().cut], [true, 0]);
});
