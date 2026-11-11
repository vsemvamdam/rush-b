// «Мои матчи» dashboard: filters and aggregations of src/components/MyMatches.tsx
// (bundled with esbuild; the chart library and CSS are stubbed out).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ui-'));
const out = path.join(dir, 'my-matches.bundle.mjs');
await build({
  entryPoints: ['src/components/MyMatches.tsx'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
  jsx: 'automatic', define: { 'import.meta.env.BASE_URL': '"/"', 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /^lightweight-charts$/ }, () => ({ path: 'lwc', namespace: 'stub' }));
      b.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'stub' }));
      // site modules touch window/location at import time — not needed for the pure helpers
      b.onResolve({ filter: /(lib\/hooks|lib\/prefs|^\.\/ui)$/ }, () => ({ path: 'site', namespace: 'stub' }));
      const STUBS = {
        lwc: 'export const createChart=()=>{};export const createSeriesMarkers=()=>{};export const LineSeries={};',
        site: 'export const Spinner=()=>null;export const useAsync=()=>({data:null,loading:true});export const useLocal=(k,v)=>[v,()=>{}];export const copy=()=>{};export const usePrefs=()=>({theme:"auto"});',
        css: '',
      };
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
    },
  }],
});
const M = await import(out);
fs.rmSync(dir, { recursive: true, force: true });

const me = (o = {}) => ({ k: 20, d: 10, a: 5, hs: 10, mvp: 3, score: 50, adr: 100, dmg: 2400, kast: 75, ud: 48, fa: 1, ef: 4, fk: 3, fd: 1, tk: 2, mk: { 2: 2, 3: 1, 4: 0, 5: 0 }, cl: { 1: [2, 1] }, shots: 200, hits: 50, hh: 10, acc: 25, weapons: { ak47: { k: 15, hs: 8, shots: 150, hits: 40, dmg: 1800 }, hegrenade: { k: 0, hs: 0, shots: 0, hits: 0, dmg: 48 } }, ...o });
const match = (i, o = {}) => ({ code: `CSGO-${i}`, id: String(i), date: new Date(Date.UTC(2026, 10, 1 + i)).toISOString(), map: 'de_mirage', mode: 'premier', duration: 2400, score: [13, 7], result: 'W', rounds: 24, rh: '', rating: { type: 'premier', before: 15000 + i * 100, after: 15100 + i * 100, delta: 100, pred: true, wins: 10 + i }, me: me(), players: [], demo: true, ...o });

test('summary: rates are weighted by rounds and demo-only fields skip GC-only matches', () => {
  const list = [
    match(3),
    match(2, { result: 'L', score: [9, 13], rounds: 12, me: me({ k: 10, d: 10, hs: 2, dmg: 600, kast: 50, shots: 100, hits: 10, fk: 0, fd: 2, ud: 12 }) }),
    match(1, { demo: false, result: 'T', score: [12, 12], rounds: 24, rating: null, me: { k: 30, d: 30, a: 1, hs: 10, mvp: 1, score: 40 } }),
  ];
  const s = M.summarize(list);
  assert.equal(s.n, 3);
  assert.deepEqual([s.w, s.l, s.t], [1, 1, 1]);
  assert.equal(s.winRate, 1 / 3);
  assert.equal(s.k, 60);
  assert.equal(s.d, 50);
  assert.equal(s.kd, 1.2);
  assert.equal(s.hsp, 22 / 60);
  assert.equal(s.demo, 2);
  assert.equal(s.rounds, 36);
  assert.equal(s.adr, 3000 / 36);
  assert.equal(s.kast, (0.75 * 24 + 0.5 * 12) / 36);
  assert.equal(s.acc, 60 / 300);
  assert.equal(s.fkRate, 3 / 6);
  assert.equal(s.udr, 60 / 36);
  assert.deepEqual([s.clA, s.clW], [4, 2]);
  assert.equal(s.mk[2], 4);
  assert.equal(M.summarize([]).winRate, null);
});

test('filters: mode, map, last N (newest first)', () => {
  const list = [match(5), match(4, { mode: 'competitive' }), match(3, { map: 'de_nuke' }), match(2), match(1, { mode: 'wingman', map: 'de_inferno' })];
  assert.deepEqual(M.filterMatches(list, { mode: 'all', map: '', last: 0 }).map((m) => m.id), ['5', '4', '3', '2', '1']);
  assert.deepEqual(M.filterMatches(list, { mode: 'premier', map: '', last: 0 }).map((m) => m.id), ['5', '3', '2']);
  assert.deepEqual(M.filterMatches(list, { mode: 'premier', map: 'de_mirage', last: 1 }).map((m) => m.id), ['5']);
  assert.deepEqual(M.filterMatches(list, { mode: 'all', map: 'de_inferno', last: 20 }).map((m) => m.id), ['1']);
});

test('per map, per weapon, rating series', () => {
  const list = [match(3), match(2, { map: 'de_nuke', result: 'L' }), match(1), match(0, { mode: 'competitive', rating: { type: 'competitive', before: 9, after: 10, delta: 1 } })];
  const maps = M.byMap(list);
  assert.equal(maps[0].map, 'de_mirage');
  assert.equal(maps[0].n, 3);
  assert.equal(maps[0].w, 3);
  assert.equal(maps[1].l, 1);
  const w = M.byWeapon(list);
  assert.equal(w[0].w, 'ak47');
  assert.equal(w[0].k, 60);
  assert.equal(w[1].w, 'hegrenade');
  const r = M.ratingSeries(list);
  assert.deepEqual(r.map((p) => p.value), [15200, 15300, 15400]); // premier only, oldest first, rating after the match
  assert.ok(r[0].t < r[1].t && r[1].t < r[2].t);
  const same = M.ratingSeries([match(1), match(2, { date: match(1).date })]);
  assert.ok(same[1].t > same[0].t); // equal timestamps are nudged apart for the chart
});

test('labels', () => {
  assert.equal(M.mapName('de_dust2'), 'Dust II');
  assert.equal(M.mapName('de_newmap'), 'Newmap');
  assert.equal(M.mapName(null), 'Карта ?');
  assert.equal(M.weaponName('m4a1_silencer'), 'M4A1-S');
  assert.equal(M.weaponName('m4a1'), 'M4A4');
  assert.equal(M.ratingColor(4999), '#b9c4d2');
  assert.equal(M.ratingColor(15000), '#a26bff');
  assert.equal(M.ratingColor(31000), '#f0b43c');
  assert.equal(M.dataUrl('76561198077054958'), 'https://raw.githubusercontent.com/vsemvamdam/rush-b/stats-data/matches/76561198077054958.json');
});
