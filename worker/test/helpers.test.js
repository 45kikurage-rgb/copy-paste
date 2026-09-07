import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip, isOriginAllowed, parseUrls, todayInTokyo } from '../src/index.js';

test('URLの改行入力を保持する', () => {
  assert.deepEqual(parseUrls('https://example.com/a\n\nhttps://example.com/b'), [
    'https://example.com/a', 'https://example.com/b'
  ]);
});

test('許可したGitHub Pages originだけをCORSで許可する', () => {
  const env = { ALLOWED_ORIGINS: 'https://45kikurage-rgb.github.io, https://example.jp' };
  assert.equal(isOriginAllowed(new Request('https://api.test', { headers: { Origin: 'https://45kikurage-rgb.github.io' } }), env), true);
  assert.equal(isOriginAllowed(new Request('https://api.test', { headers: { Origin: 'https://evil.example' } }), env), false);
});

test('東京基準の日付を返す', () => {
  assert.equal(todayInTokyo(new Date('2026-09-06T16:00:00Z')), '2026-09-07');
});

test('複数ファイルのZIPを生成する', () => {
  const zip = createZip([
    { name: '01-a.txt', data: new TextEncoder().encode('a') },
    { name: '02-b.txt', data: new TextEncoder().encode('b') }
  ]);
  assert.equal(new DataView(zip.buffer).getUint32(0, true), 0x04034b50);
  assert.equal(new DataView(zip.buffer).getUint32(zip.length - 22, true), 0x06054b50);
});
