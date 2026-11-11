#!/usr/bin/env node
// CS2 pro matches, tournaments and odds → one compact JSON for the «Матчи» page.
//
//   node scripts/fetch-esports.mjs --prev <dir> --out <dir> [--dump <dir>]
//
// <prev>/esports.json and <prev>/cache.json are the previous run's output (branch esports-data);
// they keep finished results, tournament infoboxes and the last bookmaker odds between runs.
// Sources:
//   • Liquipedia MediaWiki API (CC BY-SA 3.0) — matches (1 parse call) and tournament infoboxes (cheap queries, cached);
//   • Polymarket Gamma API (public, no key) — prediction-market prices for match winners;
//   • OddsPapi v4 (only with ODDS_API_KEY) — bookmaker odds; 2 requests per refresh, refreshed every ODDS_REFRESH_MIN.
// Env: ODDS_API_KEY, ODDS_BOOKMAKERS (default pinnacle,1xbet,stake), ODDS_REFRESH_MIN (default 420),
//      ODDS_MONTHLY_LIMIT (default 240), FORCE_ODDS=true.

import fs from 'node:fs/promises';
import path from 'node:path';
import { liquipediaClient, fetchMatches, fetchTournamentList, fetchInfoboxes, matchKey, WIKI } from './lib/esports/liquipedia.mjs';
import { fetchPolymarket } from './lib/esports/polymarket.mjs';
import { fetchOddsPapi, BOOK_NAMES } from './lib/esports/oddspapi.mjs';
import { teamKeys, findMatch, summarizeOdds } from './lib/esports/teams.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PREV = arg('prev', 'esports-prev');
const OUT = arg('out', 'esports-out');
const DUMP = arg('dump', process.env.DUMP_DIR || '');

const NOW_MS = Date.now();
const NOW = Math.round(NOW_MS / 1000);
const H = 3600;
const KEY = (process.env.ODDS_API_KEY || '').trim();
const BOOKS = (process.env.ODDS_BOOKMAKERS || 'pinnacle,1xbet,stake').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 3);
const ODDS_EVERY = (+process.env.ODDS_REFRESH_MIN || 420) * 60;
const ODDS_MONTHLY = +process.env.ODDS_MONTHLY_LIMIT || 240;
const FORCE_ODDS = /^(1|true|yes)$/i.test(process.env.FORCE_ODDS || '');
const RESULTS_KEEP = 4 * 24 * H; // finished matches shown for 4 days
const UPCOMING_HORIZON = 21 * 24 * H;

const log = (...a) => console.log(...a);
const readJSON = async (f, d = null) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };
const dump = DUMP
  ? async (name, text) => { await fs.mkdir(DUMP, { recursive: true }); await fs.writeFile(path.join(DUMP, name + '.json'), text); }
  : null;

// GET JSON with the same polite UA for Polymarket
async function pmGet(name, url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'RUSHB-esports/1.0 (https://github.com/vsemvamdam/rush-b)', 'Accept-Encoding': 'gzip', Accept: 'application/json' } });
  const text = await r.text();
  if (dump) await dump(name, text);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(text);
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
const errText = (e) => String(e?.message || e).slice(0, 200);

const prev = await readJSON(path.join(PREV, 'esports.json'), {});
const cache = await readJSON(path.join(PREV, 'cache.json'), {});
cache.v = 1;
cache.tours ||= {};
cache.results ||= [];
const sources = {};
const lp = liquipediaClient({ log, dump });

// ── 1. matches (Liquipedia) ───────────────────────────────────────────────
let matches = [];
try {
  matches = await fetchMatches(lp, NOW);
  sources.liquipedia = { ok: true, at: NOW, n: matches.length };
  log(`liquipedia: ${matches.length} матчей (${matches.filter((m) => m.status === 'live').length} live, ${matches.filter((m) => m.status === 'finished').length} завершено)`);
} catch (e) {
  log('liquipedia matches FAILED:', errText(e));
  sources.liquipedia = { ok: false, at: prev.sources?.liquipedia?.at || null, error: errText(e) };
  // keep the previous list; statuses are recomputed below and on the page
  matches = (prev.matches || []).map(({ odds, id, tp, ...m }) => ({ ...m, tpage: tp, _odds: odds }));
}

// finished results: this run's + earlier ones (the ticker only lists the last N)
// same match across runs; bracket slots (TBD) differ only by time
const keyOf = (m) => matchKey(m) + '|' + (m.t1.tbd || m.t2.tbd ? m.start : Math.round(m.start / (6 * H)));
const byKey = new Map();
for (const m of cache.results) if (m.start > NOW - RESULTS_KEEP) byKey.set(keyOf(m), m);
for (const m of matches) {
  if (m.status === 'finished' && m.start < NOW - RESULTS_KEEP) continue;
  if (m.status !== 'finished' && m.start > NOW + UPCOMING_HORIZON) continue;
  if (m.status !== 'finished' && m.start < NOW - 10 * H) continue; // "live" for 10+ hours = stale wiki entry
  byKey.set(keyOf(m), m); // fresher wins
}
// a match that was upcoming/live before and is now listed as finished replaces the old entry (same key)
matches = [...byKey.values()];

// ── 2. tournaments (list + infoboxes, cached) ────────────────────────────
let list = cache.list?.items || [];
if (!cache.list || NOW - cache.list.at > 3 * H) {
  try {
    list = await fetchTournamentList(lp);
    cache.list = { at: NOW, items: list };
  } catch (e) {
    log('tournament list FAILED:', errText(e));
  }
}
const today = new Date(NOW_MS).toISOString().slice(0, 10);
const tourStale = (c) => {
  if (!c) return true;
  const age = NOW - c.at;
  if (!c.t) return age > 24 * H;
  if (c.t.end && c.t.end < today) return age > 3 * 24 * H;
  return age > 6 * H;
};
const pages = [...new Set([...list.map((x) => x.page), ...matches.filter((m) => m.tier && 'SAB'.includes(m.tier)).map((m) => m.tpage)].filter(Boolean))];
const need = pages.filter((p) => tourStale(cache.tours[p])).slice(0, 120);
if (need.length) {
  const got = await fetchInfoboxes(lp, need, log);
  for (const p of need) if (got.has(p)) cache.tours[p] = { at: NOW, t: got.get(p) };
  log(`liquipedia: инфобоксы ${got.size}/${need.length}`);
}
// forget tournaments nobody refers to anymore
for (const p of Object.keys(cache.tours)) if (!pages.includes(p) && NOW - cache.tours[p].at > 7 * 24 * H) delete cache.tours[p];
log(`liquipedia: всего запросов ${lp.count}`);

// ── 3. odds ───────────────────────────────────────────────────────────────
const live = matches.filter((m) => m.status !== 'finished' && !m.t1.tbd && !m.t2.tbd);
const target = live.map((m) => ({ m, keys1: teamKeys(m.t1.n, m.t1.f), keys2: teamKeys(m.t2.n, m.t2.f), start: m.start }));
const books = new Map(); // match → [{ b, o, p?, at }]
const addBook = (m, book) => {
  if (!books.has(m)) books.set(m, []);
  const arr = books.get(m);
  if (!arr.some((x) => x.b === book.b)) arr.push(book);
};
const attach = (fx, book) => {
  const hit = findMatch(target, { keys1: teamKeys(fx.t1), keys2: teamKeys(fx.t2), start: fx.start });
  if (!hit) return false;
  const sw = (a) => (a && hit.swap ? [a[1], a[0]] : a);
  addBook(hit.match.m, { ...book, o: sw(book.o), ...(book.p ? { p: sw(book.p) } : {}) });
  return true;
};

// Polymarket — every run
try {
  const ev = await fetchPolymarket(pmGet, { now: NOW_MS, log });
  let n = 0;
  for (const e of ev) if (attach(e, { b: 'polymarket', o: e.o, p: e.p, at: NOW })) n++;
  sources.polymarket = { ok: true, at: NOW, n, total: ev.length };
  log(`polymarket: ${ev.length} рынков, сопоставлено ${n}`);
} catch (e) {
  log('polymarket FAILED:', errText(e));
  sources.polymarket = { ok: false, at: prev.sources?.polymarket?.at || null, error: errText(e) };
}

// OddsPapi — only with a key, rarely (free plan: 250 requests a month)
const month = new Date(NOW_MS).toISOString().slice(0, 7);
if (cache.odds?.month !== month) cache.odds = { ...(cache.odds || {}), month, used: 0 };
const op = { key: !!KEY, books: BOOKS };
if (!KEY) {
  op.ok = false;
  op.error = 'nokey';
  delete cache.odds.fixtures;
} else {
  const last = cache.odds.tried || cache.odds.at;
  const due = FORCE_ODDS || !last || NOW - last >= ODDS_EVERY || cache.odds.books !== BOOKS.join(',');
  const budget = cache.odds.used + 2 <= ODDS_MONTHLY;
  const anySoon = live.some((m) => m.start < NOW + 3 * 24 * H);
  if (due && budget && anySoon) {
    cache.odds.tried = NOW; // also after a failure: don't retry every run
    try {
      const r = await fetchOddsPapi({ key: KEY, bookmakers: BOOKS, now: NOW_MS, log });
      cache.odds.used += r.used;
      cache.odds.at = NOW;
      cache.odds.books = BOOKS.join(',');
      cache.odds.fixtures = r.fixtures;
      delete cache.odds.error;
    } catch (e) {
      cache.odds.used += 1;
      cache.odds.books = BOOKS.join(',');
      cache.odds.error = e.status === 401 || e.status === 403 ? 'badkey' : e.status === 429 ? 'limit' : errText(e);
      log('oddspapi FAILED:', cache.odds.error === 'badkey' ? 'ключ не принят (401/403)' : cache.odds.error);
    }
  } else log(`oddspapi: пропуск (${!due ? 'ещё рано' : !budget ? 'исчерпан месячный лимит' : 'нет матчей в ближайшие 3 дня'}; использовано ${cache.odds.used}/${ODDS_MONTHLY} за ${month})`);
  let n = 0;
  for (const f of cache.odds.fixtures || []) {
    if (f.start < NOW - 12 * H) continue;
    let used = false;
    for (const b of f.books) used = attach(f, { b: b.b, o: b.o, at: cache.odds.at }) || used;
    if (used) n++;
  }
  Object.assign(op, { ok: !cache.odds.error, at: cache.odds.at || null, n, used: cache.odds.used, limit: ODDS_MONTHLY, every: ODDS_EVERY / 60, ...(cache.odds.error ? { error: cache.odds.error } : {}) });
  log(`oddspapi: сопоставлено ${n} матчей`);
}
sources.oddspapi = op;

// ── 4. output ─────────────────────────────────────────────────────────────
const prevOdds = new Map();
for (const m of prev.matches || []) if (m.odds) prevOdds.set(m.id, m.odds);

const team = (t) => ({ n: t.n, ...(t.f ? { f: t.f } : {}), ...(t.tbd ? { tbd: true } : {}) });
const outMatches = matches
  .map((m) => {
    const k = hash(keyOf(m));
    let status = m.status;
    if (status !== 'finished' && m.start <= NOW) status = 'live';
    const b = books.get(m);
    let odds = b ? summarizeOdds(b) : null;
    if (odds) odds.at = Math.max(...b.map((x) => x.at || 0));
    // finished (or temporarily unmatched) — keep the last known odds as closing line
    if (!odds && (prevOdds.get(k) || m._odds)) odds = { ...(prevOdds.get(k) || m._odds), closed: status === 'finished' || undefined };
    return {
      id: k,
      t1: team(m.t1),
      t2: team(m.t2),
      start: m.start,
      status,
      ...(m.approx ? { approx: true } : {}),
      ...(m.bo ? { bo: m.bo } : {}),
      ...(m.score ? { score: m.score } : {}),
      ...(m.winner ? { winner: m.winner } : {}),
      tour: m.tour,
      ...(m.stage ? { stage: m.stage } : {}),
      ...(m.tpage ? { tp: m.tpage } : {}),
      ...(m.tier ? { tier: m.tier } : {}),
      ...(m.streams?.length && status !== 'finished' ? { streams: m.streams } : {}),
      ...(odds ? { odds } : {}),
    };
  })
  .sort((a, b) => a.start - b.start || (a.tier || 'Z').localeCompare(b.tier || 'Z'));

cache.results = matches.filter((m) => m.status === 'finished').map(({ _odds, ...m }) => m);

// tournaments: Liquipedia:Tournaments list + S/A/B tournaments with matches in the list
const tourMatches = new Map();
for (const m of outMatches) if (m.tp) {
  const s = tourMatches.get(m.tp) || { up: 0, live: 0, done: 0 };
  s[m.status === 'finished' ? 'done' : m.status === 'live' ? 'live' : 'up']++;
  tourMatches.set(m.tp, s);
}
const listGroup = new Map(list.map((x) => [x.page, x]));
const tours = [];
for (const p of pages) {
  const info = cache.tours[p]?.t;
  const li = listGroup.get(p);
  const tm = tourMatches.get(p);
  if (!info && !li) continue;
  if (!li && !(info?.tier && 'SAB'.includes(info.tier))) continue;
  const start = info?.start;
  const end = info?.end || start;
  let status;
  if (tm?.live) status = 'ongoing';
  else if (tm?.up && start && today >= start) status = 'ongoing';
  else if (start && end && start.length === 10 && end.length === 10) status = today < start ? 'upcoming' : today > end ? 'finished' : 'ongoing';
  else status = li?.group === 'upcoming' ? 'upcoming' : li?.group === 'ongoing' ? 'ongoing' : li?.group ? 'finished' : 'upcoming';
  tours.push({
    id: p,
    name: info?.name || li?.name || p,
    ...(li?.name && info?.name && li.name !== info.name ? { short: li.name } : info?.short ? { short: info.short } : {}),
    ...(info ? Object.fromEntries(Object.entries(info).filter(([k]) => !['page', 'name', 'short'].includes(k))) : {}),
    status,
    url: WIKI + encodeURI(p.replace(/ /g, '_')),
    ...(tm ? { m: tm } : {}),
  });
}
const order = { ongoing: 0, upcoming: 1, finished: 2 };
tours.sort((a, b) => order[a.status] - order[b.status] || (a.status === 'finished' ? (b.end || '').localeCompare(a.end || '') : (a.start || '9').localeCompare(b.start || '9')));

const out = {
  v: 1,
  updated: NOW,
  sources,
  books: Object.fromEntries([...BOOKS, 'polymarket'].map((b) => [b, BOOK_NAMES[b] || b])),
  matches: outMatches,
  tournaments: tours,
};
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'esports.json'), JSON.stringify(out));
await fs.writeFile(path.join(OUT, 'cache.json'), JSON.stringify(cache));
const size = (await fs.stat(path.join(OUT, 'esports.json'))).size;
log(`готово: ${outMatches.length} матчей (${outMatches.filter((m) => m.odds && !m.odds.closed).length} с коэффициентами), ${tours.length} турниров, ${(size / 1024).toFixed(1)} КБ`);
if (!sources.liquipedia.ok && !outMatches.length) process.exitCode = 1;
