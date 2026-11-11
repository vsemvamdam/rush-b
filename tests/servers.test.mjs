// «Дуэли»: Worker-side packing of Cybershoke's server list and the site-side filters, on a trimmed real response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';

const outW = new URL('./.servers-worker.bundle.mjs', import.meta.url).pathname;
const outL = new URL('./.servers-lib.bundle.mjs', import.meta.url).pathname;
await build({ entryPoints: ['worker/src/servers.ts'], bundle: true, format: 'esm', platform: 'node', outfile: outW, logLevel: 'error' });
await build({ entryPoints: ['src/lib/servers.ts'], bundle: true, format: 'esm', platform: 'node', outfile: outL, logLevel: 'error' });
const W = await import(outW);
const L = await import(outL);
const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/cybershoke-main.json', import.meta.url), 'utf8'));
const cs2 = raw.data.modules.servers.data.servers['2'];
const cs2Count = Object.values(cs2).flatMap((c) => Object.values(c)).flat().length;

test('packs every CS2 server and nothing from CS:GO', () => {
  const p = W.slimCybershoke(raw, 1794386000);
  assert.equal(p.servers, cs2Count);
  assert.equal(p.list.length, cs2Count);
  assert.ok(p.list.every((r) => r.length === 11 && /^\d+\.\d+\.\d+\.\d+$/.test(r[0]) && r[1] > 0));
  assert.ok(!p.modes.some((m) => m.id === 'AMONGUS' || m.id === 'DANGERZONE'), 'CS:GO-only modes leaked in');
  const duels = p.modes.find((m) => m.id === 'DUELS');
  assert.ok(duels && duels.servers > 0 && duels.cats.includes('ONLY MIRAGE'));
  assert.equal(p.players, p.list.reduce((a, r) => a + r[6], 0));
  for (let i = 1; i < p.modes.length; i++) assert.ok(p.modes[i - 1].players >= p.modes[i].players, 'modes sorted by players');
  assert.deepEqual(p.locations.moscow, ['ru', 'Moscow', 'europe']);
  assert.equal(p.fetched, 1794386000);
});

test('skips broken and duplicate entries, survives garbage', () => {
  const s = { ip: '1.2.3.4', port: 27015, mode: 'DUELS', num: 1, location: 'moscow', map: 'am_mirage', players: 3, maxplayers: 20, category: 'ARENA MAPS' };
  const r = { data: { modules: { servers: { data: { servers: { 2: { DUELS: { 'ARENA MAPS': [s, { ...s }, { ...s, ip: 'evil<script>' }, null, { ...s, port: 99999 }] } } } } } } } };
  const p = W.slimCybershoke(r, 0);
  assert.equal(p.list.length, 1);
  assert.equal(W.slimCybershoke(null, 0).list.length, 0);
  assert.equal(W.slimCybershoke({ data: { modules: { servers: { data: { servers: { 2: 'x' } } } } } }, 0).list.length, 0);
});

const payload = W.slimCybershoke(raw, 0);
const all = payload.list.map(L.toSrv);
const loc = (id) => L.locInfo(payload, id);

test('filters: mode, free places for a group, region, full servers', () => {
  const duels = L.filterServers(all, { mode: 'DUELS', empty: true, full: true }, loc);
  assert.ok(duels.length > 0 && duels.every((s) => s.mode === 'DUELS'));
  const open = L.filterServers(all, { mode: 'DUELS', empty: true }, loc);
  assert.ok(open.every((s) => s.free > 0), 'full servers are hidden by default');
  const two = L.filterServers(all, { mode: 'DUELS', empty: true, slots: 2 }, loc);
  assert.ok(two.every((s) => s.free >= 2));
  const ru = L.filterServers(all, { mode: 'DUELS', empty: true, full: true, region: 'ru' }, loc);
  assert.ok(ru.every((s) => loc(s.loc).country === 'ru'));
  for (let i = 1; i < duels.length; i++) assert.ok(duels[i - 1].players >= duels[i].players, 'liveliest first');
  const byNum = L.filterServers(all, { mode: 'DUELS', empty: true, full: true, q: '#' + duels[0].num }, loc);
  assert.ok(byNum.some((s) => s.num === duels[0].num));
});

test('quick connect picks the liveliest server with room for everybody', () => {
  const mk = (port, players, max) => L.toSrv(['1.1.1.1', port, 'DUELS', port, 'moscow', 'am_mirage', players, max, '', '', 0]);
  const list = [mk(1, 20, 20), mk(2, 19, 20), mk(3, 15, 20), mk(4, 0, 20)];
  assert.equal(L.bestServer(list, 1).port, 2);
  assert.equal(L.bestServer(list, 2).port, 3);
  assert.equal(L.bestServer(list, 30), null);
  assert.equal(L.bestServer([mk(5, 0, 20)], 1), null, 'an empty server is not «lively»');
});

test('labels, links and invite parsing', () => {
  assert.equal(L.mapRu('duels_mirage_1x1'), 'Mirage 1×1');
  assert.equal(L.mapRu('am_dust2'), 'Dust II · арены');
  assert.equal(L.mapRu('de_mirage_wingman'), 'Mirage · напарники');
  assert.equal(L.mapRu('kz_dejavu'), 'kz_dejavu');
  assert.equal(L.catRu('ONLY MIRAGE'), 'Только Mirage');
  assert.equal(L.catRu('TIER 1-2 - EASY'), 'Тир 1–2 · лёгкие');
  assert.equal(L.catRu('20 SLOTS'), '20 слотов');
  assert.equal(L.connectUrl({ ip: '46.174.52.89', port: 28020 }), 'steam://rungameid/730//+connect%2046.174.52.89:28020');
  assert.equal(L.connectCmd({ ip: '46.174.52.89', port: 28020 }), 'connect 46.174.52.89:28020');
  assert.deepEqual(L.parseJoin('46.174.52.89:28020'), { ip: '46.174.52.89', port: 28020 });
  assert.equal(L.parseJoin('javascript:alert(1)'), null);
  assert.equal(L.modeRu('DUELS2X2'), 'Дуэли 2×2');
  assert.equal(L.modeGroup('SURF'), 'movement');
});
