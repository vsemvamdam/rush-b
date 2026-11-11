// Что сборщики данных пропускают на сайт из чужих источников: картинки (Liquipedia) и ссылки на трансляции.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageKind } from '../scripts/lib/common.mjs';
import { parseHTML } from '../scripts/lib/mini-html.mjs';
import { streamLinks } from '../scripts/lib/esports/liquipedia.mjs';

test('логотипы: тип файла определяется по содержимому, не по адресу — SVG и HTML не проходят', () => {
  assert.equal(imageKind(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')), 'png');
  assert.equal(imageKind(Buffer.from('ffd8ffe000104a46494600010100', 'hex')), 'jpg');
  assert.equal(imageKind(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')), 'gif');
  assert.equal(imageKind(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1')), 'webp');
  assert.equal(imageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), '');
  assert.equal(imageKind(Buffer.from('<?xml version="1.0"?><svg onload="alert(1)"/>')), '');
  assert.equal(imageKind(Buffer.from('<!doctype html><script>alert(1)</script>')), '');
  assert.equal(imageKind(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1')), '');
  assert.equal(imageKind(Buffer.alloc(0)), '');
  assert.equal(imageKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), 'png');
});

test('трансляции: ссылка берётся только с настоящего адреса площадки', () => {
  const links = (html) => streamLinks(parseHTML(`<div>${html}</div>`)).map((s) => s.u);
  assert.deepEqual(links('<a href="https://www.twitch.tv/ESLCS">t</a><a href="https://kick.com/blast">k</a><a href="https://www.youtube.com/watch?v=abc">y</a><a href="https://youtu.be/abc">y2</a>'),
    ['https://www.twitch.tv/ESLCS', 'https://kick.com/blast', 'https://www.youtube.com/watch?v=abc', 'https://youtu.be/abc']);
  // похожие адреса чужих сайтов и не-http ссылки отбрасываются
  assert.deepEqual(links('<a href="https://twitch.tv.evil.example/ESLCS">a</a><a href="https://kick.com.evil.example/x">b</a><a href="https://youtu.be.evil.example/x">c</a><a href="javascript:alert(1)//twitch.tv/">d</a><a href="https://evil.example/?https://www.twitch.tv/x">e</a>'), []);
  // ссылки вида Special:Stream ведут на Twitch или на страницу Liquipedia — всегда https
  for (const u of links('<a href="/counterstrike/Special:Stream/twitch/ESLCS">a</a><a href="/counterstrike/Special:Stream/kick/blast%22onmouseover">b</a>')) assert.match(u, /^https:\/\/(www\.twitch\.tv|liquipedia\.net)\//);
});
