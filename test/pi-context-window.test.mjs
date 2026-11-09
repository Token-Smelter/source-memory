import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextWindow, omittedHistoryNote } from '../pi-extension/pi-runtime.mjs';

const user = (i, size = 100) => ({ role: 'user', content: [{ type: 'text', text: `u${i}`.padEnd(size, 'x') }], timestamp: i });
const assistant = (i, size = 100) => ({ role: 'assistant', content: [{ type: 'text', text: `a${i}`.padEnd(size, 'y') }], timestamp: i });
const toolResult = (i, size = 100) => ({ role: 'toolResult', toolCallId: `t${i}`, content: [{ type: 'text', text: `r${i}`.padEnd(size, 'z') }], timestamp: i });
const history = turns => Array.from({ length: turns }, (_, i) => [user(i), assistant(i), toolResult(i)]).flat();

test('a context under the threshold is passed through unchanged', () => {
  const messages = history(3), window = createContextWindow({ contextWindow: 1_000_000 });
  const result = window.apply(messages);
  assert.deepEqual([result.messages === messages, result.status], [true, null]);
});

test('an overflow cuts whole turns once, before a user message, and keeps that cut while the context fits', () => {
  const window = createContextWindow({ contextWindow: 1000 });
  const first = window.apply(history(12));
  const cut = first.status.omitted_messages;
  assert.deepEqual([first.status.recut, first.messages[0].content[0].text, first.messages[1].role, cut % 3],
    [true, omittedHistoryNote(cut), 'user', 0]);
  const next = window.apply([...history(12), user(12, 10)]);
  assert.deepEqual([next.status.recut, next.status.omitted_messages, JSON.stringify(next.messages.slice(0, first.messages.length))],
    [false, cut, JSON.stringify(first.messages)]);
});

test('a later overflow moves the cut forward, and an unfittable context fails closed', () => {
  const window = createContextWindow({ contextWindow: 1000 });
  const cut = window.apply(history(12)).status.omitted_messages;
  const later = window.apply(history(30));
  assert.equal(later.status.recut && later.status.omitted_messages > cut, true);
  assert.throws(() => createContextWindow({ contextWindow: 10 }).apply([user(0, 5000)]), /context_window_exceeded/);
});

test('a large context of sparse tokens is not cut once its observed usage shows it fits', () => {
  const messages = history(40), bytes = Buffer.byteLength(JSON.stringify(messages));
  const window = createContextWindow({ contextWindow: Math.ceil(bytes * 0.5 * 0.95) });
  window.observe(messages, Math.ceil(bytes * 0.15));
  const next = [...messages, user(40)];
  assert.deepEqual([window.apply(next).messages === next, window.state().cut], [true, 0]);
});
