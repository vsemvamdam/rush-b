#!/usr/bin/env node
// CS2 news headlines → per-team files for the «Новости» column of team pages.
//
//   node scripts/fetch-news.mjs --prev <dir> --out <dir> [--site <url> | --data <dir>] [--feeds <dir>]
//
// <prev>/all.json and <prev>/catalog.json are the previous run's output (branch news-data): news are kept
//   for KEEP_DAYS, so a team page shows weeks of headlines although each feed holds only the last day or two.
// --site  the published site; its data/teams/index.json, data/teams/info.json, data/rankings.json and
//         data/teams/people.json give the teams, their names, rosters and recent former players (default https://vsemvamdam.github.io/cs2-craft/). --data reads the same
//         files from a local folder instead (public/data after a local build).
// --feeds local copies of the feeds as <source key>.xml (tests, offline runs).
//
// Output (<out>):
//   all.json      { v, updated, sources, items: [{ id, s, t, u, ts, tm: { slug: { w?, p? } } }] } — state between runs
//   catalog.json  the team/nickname matcher used (fallback when the site is unreachable)
//   latest.json   the newest CS2 headlines of all sources (any team or none)
//   t/<slug>.json { v, updated, src, items: [{ t, u, s, ts, p?, w? }] } — what a team page loads
// Only titles and links are published; descriptions are used for matching and dropped.

import fs from 'node:fs/promises';
import path from 'node:path';
import { SOURCES } from './lib/news/sources.mjs';
import { fetchFeed, readFeed, decodeBody } from './lib/news/rss.mjs';
import { buildCatalog, matchItem } from './lib/news/match.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PREV = arg('prev', 'news-prev');
const OUT = arg('out', 'news-out');
const SITE = arg('site', 'https://vsemvamdam.github.io/cs2-craft/').replace(/\/?$/, '/');
const DATA = arg('data', '');
const FEEDS = arg('feeds', '');

const NOW = Math.round(Date.now() / 1000);
const DAY = 86400;
const KEEP_DAYS = 120; // all.json
const TEAM_DAYS = 90; // per-team files
const TEAM_MAX = 60;
const LATEST_MAX = 80;

const log = (...a) => console.log(...a);
const errText = (e) => String(e?.message || e).slice(0, 200);
const readJSON = async (f, d = null) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

async function siteJSON(rel) {
  if (DATA) return JSON.parse(await fs.readFile(path.join(DATA, rel), 'utf8'));
  const r = await fetch(SITE + 'data/' + rel, { signal: AbortSignal.timeout(60000), headers: { 'Accept-Encoding': 'gzip' } });
  if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
  return r.json();
}

// ── 1. previous state and the team catalog ───────────────────────────────
const prev = await readJSON(path.join(PREV, 'all.json'), {});
let catalog = null;
try {
  const [index, info, rankings, people] = await Promise.all([
    siteJSON('teams/index.json'), siteJSON('teams/info.json'), siteJSON('rankings.json').catch(() => null), siteJSON('teams/people.json').catch(() => null),
  ]);
  catalog = buildCatalog(index, info, rankings, NOW, people);
  log(`каталог: ${Object.keys(catalog.teams).length} команд, ${catalog.forms.length} названий, ${catalog.nicks.length} ников`);
} catch (e) {
  catalog = await readJSON(path.join(PREV, 'catalog.json'));
  log(`каталог с сайта не загрузился (${errText(e)}) — ${catalog ? 'беру прошлый' : 'прошлого тоже нет'}`);
  if (!catalog) { process.exitCode = 1; process.exit(); }
}

// ── 2. feeds ─────────────────────────────────────────────────────────────
const known = new Map((prev.items || []).filter((x) => x.ts > NOW - KEEP_DAYS * DAY).map((x) => [x.id, x]));
const urls = new Set([...known.values()].map((x) => x.u));
// headlines of earlier runs are matched again with today's rosters (a transfer, a new team page); the teams their
// descriptions added (w) stay — descriptions are not stored
const LANG = Object.fromEntries(SOURCES.map((s) => [s.key, s.lang]));
let rematched = 0;
for (const it of known.values()) {
  const tm = matchItem({ title: it.t, desc: '' }, LANG[it.s] || 'ru', catalog);
  for (const [s, m] of Object.entries(it.tm || {})) if (m.w && !tm[s]) tm[s] = m;
  if (JSON.stringify(Object.keys(tm).sort()) !== JSON.stringify(Object.keys(it.tm || {}).sort())) rematched++;
  it.tm = tm;
}
if (rematched) log(`прошлые заголовки: команды поменялись у ${rematched}`);
const sources = {};
let added = 0;
for (const src of SOURCES) {
  let items;
  try {
    if (FEEDS) {
      const f = path.join(FEEDS, src.key + '.xml');
      items = readFeed(decodeBody(new Uint8Array(await fs.readFile(f))));
    } else items = await fetchFeed(src.url);
  } catch (e) {
    const p = prev.sources?.[src.key];
    sources[src.key] = { ok: false, at: p?.at || null, error: e.status ? `HTTP ${e.status}` : errText(e) };
    log(`${src.name}: ОШИБКА ${sources[src.key].error}`);
    continue;
  }
  const cs = items.filter(src.keep);
  let n = 0, nm = 0;
  for (const it of cs) {
    const id = hash(src.key + '|' + (it.guid || it.link));
    if (known.has(id) || urls.has(it.link)) continue;
    let ts = it.ts || NOW;
    if (ts > NOW + 3600) ts = NOW; // wrong time zone in a feed — never "from the future"
    const tm = matchItem({ title: it.title, desc: it.desc }, src.lang, catalog);
    known.set(id, { id, s: src.key, t: it.title, u: it.link, ts, tm });
    urls.add(it.link);
    n++;
    if (Object.keys(tm).length) nm++;
  }
  added += n;
  sources[src.key] = { ok: true, at: NOW, n: cs.length, new: n };
  log(`${src.name}: в ленте ${items.length}, про CS2 ${cs.length}, новых ${n} (с командой ${nm})`);
}
if (!Object.values(sources).some((s) => s.ok) && !known.size) {
  log('ни один источник не ответил и прошлых данных нет — нечего публиковать');
  process.exitCode = 1;
  process.exit();
}

// ── 3. output ────────────────────────────────────────────────────────────
const items = [...known.values()].sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id)).slice(0, 6000);
const src = Object.fromEntries(SOURCES.map((s) => [s.key, [s.name, s.lang]]));
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, 't'), { recursive: true });
await fs.writeFile(path.join(OUT, 'all.json'), JSON.stringify({ v: 1, updated: NOW, sources, items }));
await fs.writeFile(path.join(OUT, 'catalog.json'), JSON.stringify(catalog));
await fs.writeFile(path.join(OUT, 'latest.json'), JSON.stringify({
  v: 1, updated: NOW, src, sources,
  items: items.slice(0, LATEST_MAX).map(({ t, u, s, ts, tm }) => ({ t, u, s, ts, ...(Object.keys(tm).length ? { tm: Object.keys(tm) } : {}) })),
}));

const perTeam = new Map();
for (const it of items) {
  if (it.ts < NOW - TEAM_DAYS * DAY) break;
  for (const [slug, m] of Object.entries(it.tm || {})) {
    const arr = perTeam.get(slug) || [];
    if (arr.length >= TEAM_MAX) continue;
    arr.push({ t: it.t, u: it.u, s: it.s, ts: it.ts, ...(m.p?.length ? { p: m.p } : {}), ...(m.w ? { w: 1 } : {}) });
    perTeam.set(slug, arr);
  }
}
for (const [slug, arr] of perTeam) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) continue;
  await fs.writeFile(path.join(OUT, 't', slug + '.json'), JSON.stringify({ v: 1, updated: NOW, src, items: arr }));
}
const top = [...perTeam].sort((a, b) => b[1].length - a[1].length).slice(0, 8).map(([s, a]) => `${s} ${a.length}`).join(', ');
log(`готово: новых ${added}, всего ${items.length}, команд с новостями ${perTeam.size} (${top})`);
