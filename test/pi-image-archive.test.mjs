import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageArchive } from '../pi-extension/image-archive.mjs';
import { createLinkChoices, createTurnTools, distillThrough } from '../pi-extension/core.mjs';

test('original image bytes are archived while only surrounding text is offered as citable evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-image-archive-'));
  try {
    const bytes = Buffer.from('fictional-image-bytes');
    const hash = createHash('sha256').update(bytes).digest('hex');
    let tools, stored;
    const memory = { async ingest(_scope, turn) { stored = turn; return { id: 'turn' }; }, async enrich() {} };
    const session = { scopes: ['fiction'], conversation_id: 'fiction', memory, imageArchive: createImageArchive({ directory }),
      entries: [{ type: 'message', id: 'u', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'Before' },
        { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }, { type: 'text', text: 'After' }] } },
      { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: 'Done', stopReason: 'stop' } }],
      distiller: { async run({ turn, receipt }) { tools = createTurnTools({ scope: 'fiction', turn, receipt, memory }); return { status: 'complete' }; } } };
    const result = await distillThrough(session, 'a', null);
    const labels = tools.labels();
    assert.deepEqual([readFileSync(join(directory, `${hash}.blob`)), result.omissions.images.disposition,
      tools.imageNotes()[0].reason, labels.some(row => row.text.includes('[image sha256=')), stored.entries[0].text.includes(hash)],
    [bytes, 'archived_not_text_citable', 'image_not_citable', false, true]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a link cannot cite a full source span containing an image placeholder', () => {
  const choices = createLinkChoices({ records: [{ ref: 'r0' }, { ref: 'r1' }],
    sources: [{ ref: 's0', text: `[image sha256=${'a'.repeat(64)} mime=image/png bytes=5]` }] });
  assert.throws(() => choices.add({ from: 'r0', to: 'r1', type: 'qualifies', evidence: ['s0'], support: 'explicit' }), /handle_not_offered/);
});
