import test from 'node:test';
import assert from 'node:assert/strict';
import { contentText, secureExternalUrl, validateMaterialFile } from '../functions/vip/api/[[path]].js';

test('content fields are trimmed, bounded, and enforce required title/body', () => {
  assert.equal(contentText('  Release notes  ', 180, 'Judul', true), 'Release notes');
  assert.throws(() => contentText(' ', 180, 'Judul', true), { status: 400 });
  assert.throws(() => contentText('x'.repeat(181), 180, 'Judul', true), { status: 400 });
});

test('material links require HTTPS and cannot embed URL credentials', () => {
  assert.equal(secureExternalUrl('https://docs.example.com/guide'), 'https://docs.example.com/guide');
  assert.equal(secureExternalUrl(''), null);
  assert.throws(() => secureExternalUrl('javascript:alert(1)'), { status: 400 });
  assert.throws(() => secureExternalUrl('http://example.com/file'), { status: 400 });
  assert.throws(() => secureExternalUrl('https://user:pass@example.com/file'), { status: 400 });
});

test('material uploads are size-limited and checked against their declared file type', async () => {
  const mockFile = (name, type, bytes) => ({ name, type, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer, slice: (start, end) => new Blob([Uint8Array.from(bytes.slice(start, end))]) });
  assert.equal(await validateMaterialFile(mockFile('guide.pdf', 'application/pdf', [37,80,68,70,45,49])), 'pdf');
  await assert.rejects(validateMaterialFile(mockFile('guide.pdf', 'application/pdf', [77,90,144,0])), { status: 400 });
  await assert.rejects(validateMaterialFile(mockFile('program.exe', 'application/octet-stream', [77,90,144,0])), { status: 400 });
  const tooLarge = { ...mockFile('guide.txt', 'text/plain', [65]), size: 50 * 1024 * 1024 + 1 };
  await assert.rejects(validateMaterialFile(tooLarge), { status: 400 });
});
