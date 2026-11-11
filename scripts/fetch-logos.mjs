#!/usr/bin/env node
// Logos of every team (not only the Major teams that have Valve stickers), icons of tournaments, photos of
// players and the infoboxes of team pages (location, region, founded, coaches, official links).
//
//   node scripts/fetch-logos.mjs [--store store/logos] [--hist store/matches-hist] [--out public/data]
//
// Source: Liquipedia (liquipedia.net/counterstrike), through its MediaWiki API only (no HTML pages):
//   * team → logo file: the team templates already downloaded by scripts/fetch-matches-hist.mjs
//     (store matches-hist/teams.json: {{Team|id}} expansions with [[File:… darkmode.png]]); teams not there are
//     looked up by page title (infobox image / imagedark, 50 pages per request);
//   * tournament → icon file: the «icon» / «icondark» field of its infobox (40 pages per request);
//   * file → small thumbnail URL: prop=imageinfo&iiurlwidth (50 files per request).
// Thumbnails are downloaded once, politely (one at a time, ≥2 s apart, User-Agent with the repository as contact)
// and kept in the «logos» store, so later runs only fetch logos of new teams. Teams that get no logo are retried
// after a week. Liquipedia text is CC BY-SA 3.0; logos belong to their teams and organisers and are shown only
// to identify them.
//
// Wanted teams: world ranking (rankings.json), teams of the matches page (esports-data branch), teams of our
// players (players/index.json). Output: <out>/logos.json { t: { teamKey: file }, e: { tournament page: file } }
// and the images in <out>/logos/.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { liquipediaClient, parseInfobox, UA } from './lib/esports/liquipedia.mjs';
import { noRefs, parseSquad, plain, templates } from './lib/wikitext.mjs';

// same keys as teamKeys() in scripts/build-db.mjs and src/lib/teams.ts (the site looks logos up by them)
const FILLER = new Set(['team', 'esports', 'esport', 'e', 'sports', 'gaming', 'clan', 'club', 'gg']);
function teamKeys(name) {
  const words = String(name).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
  return [...new Set([words.join(''), words.filter((w) => !FILLER.has(w)).join('')].filter(Boolean))];
}

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const STORE = arg('store', 'store/logos');
const HIST = arg('hist', 'store/matches-hist');
const OUT = arg('out', 'public/data');
const MAX_DL = +(process.env.LOGOS_MAX_DOWNLOADS || 300);
// --offline: no requests to Liquipedia — only rebuild the site files from the store (local tests)
const OFFLINE = argv.includes('--offline');
const REPO = process.env.GITHUB_REPOSITORY || 'vsemvamdam/rush-b';
const WEEK = 7 * 86400000;

const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const DEFAULT = /^Counter-Strike 2 default|^CS2 default|^Logo filler|^Liquipedia/i;

/** {{Team|…}} expansion → { page, display, file (dark mode first) } */
function fromTemplate(html) {
  const files = [...html.matchAll(/\[\[File:([^|\]]+)/g)].map((m) => m[1].trim()).filter((f) => !DEFAULT.test(f));
  const file = files.find((f) => /darkmode/i.test(f)) || files.find((f) => /allmode/i.test(f)) || files[0];
  const page = (/team-template-text">\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/.exec(html) || []);
  return { file, page: page[1], display: page[2] || page[1] };
}

async function main() {
  fs.mkdirSync(path.join(STORE, 'img'), { recursive: true });
  const idx = read(path.join(STORE, 'index.json')) || { files: {}, teams: {}, tours: {} };
  // idx.files: { liquipedia file: { img?: local name, url?, miss?: ts } }
  // idx.teams: { teamKey: { file?, miss?: ts } }   idx.tours: { page: { file?, miss?: ts } }

  // ---- which teams and tournaments the site shows ----
  const want = new Map(); // key → display name (first seen)
  const addTeam = (n) => { if (!n || /^(tbd|tba)$/i.test(n)) return; for (const k of teamKeys(n)) if (!want.has(k)) want.set(k, n); };
  for (const t of read(path.join(OUT, 'rankings.json'))?.teams || []) addTeam(t[2]);
  let esports = null;
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/esports-data/esports.json`, { signal: AbortSignal.timeout(30000) });
    if (r.ok) esports = await r.json();
  } catch { /* the matches page is optional here */ }
  for (const m of esports?.matches || []) for (const t of [m.t1, m.t2]) if (!t?.tbd) { addTeam(t.f); addTeam(t.n); }
  const ix = read(path.join(OUT, 'players', 'index.json'));
  if (ix?.cols) { const ti = ix.cols.indexOf('team'); for (const r of ix.rows) addTeam(r[ti]); }
  const tours = new Set((esports?.tournaments || []).map((t) => t.id).filter(Boolean));
  for (const m of esports?.matches || []) if (m.tp) tours.add(m.tp);
  const firstWanted = want.size;
  // team pages (tools/teams/build_teams.py): their opponents' logos, icons of their tournaments, their infoboxes
  const need = read(path.join(OUT, 'teams', 'need.json')) || { teams: [], tours: [], pages: [] };
  for (const n of need.teams) addTeam(n);
  for (const p of need.tours) tours.add(p);
  console.log(`логотипы: нужно ${want.size} ключей команд (${firstWanted} — рейтинг, матчи, игроки), ${tours.size} турниров, инфобоксов команд ${need.pages.length}`);

  // ---- team → file from the stored team templates ----
  const tpl = read(path.join(HIST, 'teams.json'))?.ids || {};
  const byKey = new Map();
  for (const [id, html] of Object.entries(tpl)) {
    if (typeof html !== 'string') continue;
    const t = fromTemplate(html);
    if (!t.file) continue;
    for (const n of [t.display, t.page, id]) if (n) for (const k of teamKeys(n)) if (!byKey.has(k)) byKey.set(k, t.file);
  }
  for (const [k] of want) {
    const e = idx.teams[k];
    if (e?.file) continue;
    if (byKey.has(k)) idx.teams[k] = { file: byKey.get(k) };
  }

  const lp = liquipediaClient({ log: console.log });
  const clean = (v) => String(v || '').replace(/<ref[\s\S]*?(<\/ref>|\/>)/gi, '').replace(/<[^>]+>/g, '').replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '').replace(/'''?/g, '').replace(/&nbsp;/g, ' ').trim();
  const teamInfo = (ib) => {
    const f = {};
    const created = /(\d{4})(?:-(\d\d|\?\?))?(?:-(\d\d|\?\?))?/.exec(ib.created || '');
    if (created) f.created = [created[1], created[2] && created[2] !== '??' ? created[2] : '', created[3] && created[3] !== '??' ? created[3] : ''].filter(Boolean).join('-');
    if (ib.disbanded) f.disbanded = clean(ib.disbanded).slice(0, 10);
    for (const k of ['location', 'region']) if (ib[k]) f[k] = clean(ib[k]);
    // staff: [shown name, role, real name, flag, Liquipedia page] — page from [[Page|Name]] links when present
    const staff = [];
    for (const k of ['coach', 'coaches', 'headcoach', 'assistantcoach', 'analyst', 'manager']) {
      const role = k.includes('assistant') ? 'Ассистент тренера' : k === 'analyst' ? 'Аналитик' : k === 'manager' ? 'Менеджер' : 'Тренер';
      const raw = noRefs(ib[k] || '');
      const linked = [...raw.matchAll(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g)].map((m) => [m[2] || m[1], m[1]]);
      const list = linked.length ? linked : clean(raw).split(/\s*(?:<br\s*\/?>|,|\n)\s*/).filter(Boolean).map((x) => [x, x]);
      for (const [shown, page] of list) if (shown && staff.length < 8) staff.push([shown.trim(), role, '', '', page.trim()]);
    }
    if (staff.length) f.staff = staff;
    const links = {};
    for (const k of ['website', 'twitter', 'twitch', 'youtube', 'instagram', 'facebook', 'tiktok', 'vk', 'discord', 'kick', 'weibo', 'bilibili', 'telegram'])
      if (ib[k] && !/\{\{/.test(ib[k])) links[k] = clean(ib[k]).replace(/\s+/g, '');
    if (Object.keys(links).length) f.links = links;
    return f;
  };
  idx.pages ||= {};
  // team pages of the world ranking first (rosters change often → weekly), the rest monthly
  const tix = read(path.join(OUT, 'teams', 'index.json'));
  const slugName = new Map((tix?.t || []).map((x) => [x[0], x[1]]));
  const rankedPages = [];
  for (const t of read(path.join(OUT, 'rankings.json'))?.teams || []) {
    if (t[0] > 120) break;
    const slug = teamKeys(t[2]).map((k) => tix?.k?.[k]).find(Boolean);
    const pg = slug && slugName.get(slug);
    if (pg && !rankedPages.includes(pg)) rankedPages.push(pg);
  }
  // also refetch pages read before staff had page links (photos of coaches / managers need them)
  const stale = (p) => !idx.pages[p]?.sq || (idx.pages[p].f?.staff || []).some((x) => x.length < 5)
    || !(idx.pages[p].at > now - (rankedPages.includes(p) ? WEEK : 30 * 86400000));
  const pagesTodo = OFFLINE ? [] : [...new Set([...rankedPages, ...need.pages])].filter(stale).slice(0, 420);
  for (const part of chunks(pagesTodo, 10)) {
    let j;
    try { j = await lp.call({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', redirects: '1', titles: part.join('|') }, 'lp-team-info'); } catch (e) { console.log('страницы команд:', e.message); break; }
    const q = j.query || {};
    const back = new Map();
    for (const x of [...(q.normalized || []), ...(q.redirects || [])]) back.set(x.to, x.from);
    for (const p of q.pages || []) {
      let req = p.title;
      for (let i = 0; i < 3 && back.has(req); i++) req = back.get(req);
      const content = p.revisions?.[0]?.slots?.main?.content || '';
      const ib = /\{\{\s*Infobox[ _]team/i.test(content) ? parseInfobox(content.replace(/Infobox[ _]team/i, 'Infobox league')) : null;
      const f = ib ? teamInfo(ib) : {};
      let sq = { squad: [], standins: [] };
      try { sq = parseSquad(content); } catch { /* unusual page */ }
      if (sq.squad.length) {
        f.squad = sq.squad;
        // coaches & analysts from the roster (with real names) replace the infobox list; the manager stays
        const staff = sq.squad.filter((x) => x.role).map((x) => [x.id, /assist/i.test(x.role) ? 'Ассистент тренера' : /analyst/i.test(x.role) ? 'Аналитик' : /manager/i.test(x.role) ? 'Менеджер' : 'Тренер', x.name, x.flag, x.t]);
        if (staff.length) f.staff = [...staff, ...(f.staff || []).filter(([, r]) => r === 'Менеджер')];
      }
      if (sq.standins.length) f.standins = sq.standins;
      idx.pages[req] = { at: now, sq: 1, f };
      const file = ib && [ib.imagedark, ib.imagedarkmode, ib.image].map((x) => (x || '').replace(/^(File|Image):/i, '').trim()).find((x) => x && !DEFAULT.test(x));
      if (file) for (const k of teamKeys(req)) if (!idx.teams[k]?.file) idx.teams[k] = { file };
    }
  }

  // ---- teams still without a file: page infobox by title («X», «Team X») ----
  const missing = [...want].filter(([k]) => !idx.teams[k]?.file && !(idx.teams[k]?.miss > now - WEEK));
  const titles = new Map(); // title → keys
  for (const [k, n] of missing) for (const t of [n, 'Team ' + n]) { const tt = t.trim(); if (tt) titles.set(tt, [...(titles.get(tt) || []), k]); }
  let looked = 0;
  for (const part of OFFLINE ? [] : chunks([...titles.keys()], 50).slice(0, 12)) {
    let j;
    try { j = await lp.call({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', rvsection: '0', redirects: '1', titles: part.join('|') }, 'lp-team-pages'); } catch (e) { console.log('страницы команд:', e.message); break; }
    const q = j.query || {};
    const back = new Map();
    for (const x of [...(q.normalized || []), ...(q.redirects || [])]) back.set(x.to, x.from);
    for (const p of q.pages || []) {
      if (p.missing) continue;
      const content = p.revisions?.[0]?.slots?.main?.content || '';
      const ib = /\{\{\s*Infobox[ _]team/i.test(content) ? parseInfobox(content.replace(/Infobox[ _]team/i, 'Infobox league')) : null;
      const file = [ib?.imagedark, ib?.imagedarkmode, ib?.image].map((f) => (f || '').replace(/^(File|Image):/i, '').trim()).find((f) => f && !DEFAULT.test(f));
      if (!file) continue;
      let req = p.title;
      for (let i = 0; i < 3 && back.has(req); i++) req = back.get(req);
      for (const k of titles.get(req) || titles.get(p.title) || []) if (!idx.teams[k]?.file) idx.teams[k] = { file };
    }
    looked += part.length;
  }
  // ranked teams whose page is named differently (sponsor names: «Betclic» → «Betclic Apogee Esports»):
  // full-text search, the first result that is a team page with a logo (≤ 15 searches a run)
  // the first version of this search accepted any page whose name merely contained the ranked name
  // (STATE → Sissi State Punks, PCIFIC → WRAITH PCIFIC): forget those matches once
  if (idx.searchV !== 2) { for (const k of ['state', 'pcific']) delete idx.teams[k]; idx.searchV = 2; }
  const rosterOf = new Map((read(path.join(OUT, 'rankings.json'))?.teams || []).map((t) => [t[2], t[3]]));
  const rankedMissing = (read(path.join(OUT, 'rankings.json'))?.teams || []).slice(0, 150).map((t) => t[2])
    .filter((n) => !/^ex-|^ex /i.test(n) && !teamKeys(n).some((k) => idx.teams[k]?.file) && !(idx.teams[teamKeys(n)[0]]?.searched > now - 30 * 86400000));
  for (const n of OFFLINE ? [] : rankedMissing.slice(0, 15)) {
    let j;
    try { j = await lp.call({ action: 'query', list: 'search', srsearch: n + ' Counter-Strike team', srnamespace: '0', srlimit: '5', srprop: '' }, 'lp-team-search'); } catch (e) { console.log('поиск команд:', e.message); break; }
    const cands = (j.query?.search || []).map((x) => x.title).filter((t) => !t.includes('/'));
    let found = '';
    if (cands.length) {
      let jj;
      try { jj = await lp.call({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: cands.join('|') }, 'lp-team-search-pages'); } catch { jj = null; }
      const pages = new Map((jj?.query?.pages || []).map((p) => [p.title, p.revisions?.[0]?.slots?.main?.content || '']));
      for (const t of cands) {
        const content = pages.get(t) || '';
        if (!/\{\{\s*Infobox[ _]team/i.test(content)) continue;
        const ib = parseInfobox(content.replace(/Infobox[ _]team/i, 'Infobox league'));
        const nm = String(ib?.name || t).toLowerCase();
        // accept when the page's name starts with the ranked name, or its current roster has ≥ 2 of the
        // players Valve lists for that team (sponsor names: «Betclic» → «Betclic Apogee Esports»)
        const a = teamKeys(n)[0], b = teamKeys(nm)[0] || '';
        const squadIds = new Set((() => { try { return parseSquad(content).squad.map((x) => x.id.toLowerCase()); } catch { return []; } })());
        const shared = (rosterOf.get(n) || []).filter((p) => squadIds.has(p.toLowerCase())).length;
        if (!(b === a || b.startsWith(a) || shared >= 2)) continue;
        const file = [ib?.imagedark, ib?.imagedarkmode, ib?.image].map((x) => (x || '').replace(/^(File|Image):/i, '').trim()).find((x) => x && !DEFAULT.test(x));
        if (file) { found = file; for (const k of teamKeys(n)) idx.teams[k] = { file }; console.log(`логотип найден поиском: ${n} → ${t}`); break; }
      }
    }
    if (!found) for (const k of teamKeys(n)) idx.teams[k] = { ...(idx.teams[k] || {}), searched: now };
  }
  for (const [k] of missing) if (!idx.teams[k]?.file) idx.teams[k] = { ...(idx.teams[k] || {}), miss: now };

  // ---- tournament → icon file: the stored tournament pages first (no request), then the API ----
  const rawDir = path.join(HIST, 'raw');
  if (fs.existsSync(rawDir)) {
    const wantTour = new Set([...tours].filter((p) => !idx.tours[p]?.file));
    for (const f of fs.readdirSync(rawDir)) {
      if (!wantTour.size) break;
      const j = read(path.join(rawDir, f));
      const titles = j?.titles || {};
      for (const [title, c] of Object.entries(titles)) {
        if (!wantTour.has(title)) continue;
        // a subpage without its own icon uses the nearest parent's
        let ib = parseInfobox(c.content || ''), t = title;
        let file = ib && [ib.icondark, ib.icondarkmode, ib.icon].map((x) => (x || '').replace(/^(File|Image):/i, '').trim()).find((x) => x && !DEFAULT.test(x));
        while (!file && t.includes('/')) {
          t = t.slice(0, t.lastIndexOf('/'));
          const pc = titles[t]?.content;
          ib = pc ? parseInfobox(pc) : null;
          file = ib && [ib.icondark, ib.icondarkmode, ib.icon].map((x) => (x || '').replace(/^(File|Image):/i, '').trim()).find((x) => x && !DEFAULT.test(x));
        }
        if (file) { idx.tours[title] = { file }; wantTour.delete(title); }
      }
    }
  }
  const tourTodo = OFFLINE ? [] : [...tours].filter((p) => !idx.tours[p]?.file && !(idx.tours[p]?.miss > now - WEEK)).slice(0, 400);
  for (const part of chunks(tourTodo, 40)) {
    let j;
    try { j = await lp.call({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', rvsection: '0', redirects: '1', titles: part.join('|') }, 'lp-tour-icons'); } catch (e) { console.log('турниры:', e.message); break; }
    const q = j.query || {};
    const back = new Map();
    for (const x of [...(q.normalized || []), ...(q.redirects || [])]) back.set(x.to, x.from);
    for (const p of q.pages || []) {
      const ib = parseInfobox(p.revisions?.[0]?.slots?.main?.content || '');
      const file = [ib?.icondark, ib?.icondarkmode, ib?.icon].map((f) => (f || '').replace(/^(File|Image):/i, '').trim()).find((f) => f && !DEFAULT.test(f));
      let req = p.title;
      for (let i = 0; i < 3 && back.has(req); i++) req = back.get(req);
      idx.tours[req] = file ? { file } : { miss: now };
    }
  }
  for (const p of tourTodo) if (!idx.tours[p]) idx.tours[p] = { miss: now };

  // ---- player photos: «image» of the Liquipedia player infobox (pages stored in matches-hist players.json) ----
  idx.players ||= {};
  const links = read(path.join(OUT, 'players', 'links.json'))?.p || {};
  const extra = read(path.join(HIST, 'players.json'))?.extra || {};
  const rosterNicks = new Map(); // nick (lower) → world rank of the team
  for (const t of read(path.join(OUT, 'rankings.json'))?.teams || []) for (const n of t[3]) if (!rosterNicks.has(n.toLowerCase())) rosterNicks.set(n.toLowerCase(), t[0]);
  const photoRank = [];
  for (const [sid, e] of Object.entries(links)) {
    const content = e.lp && extra[e.lp];
    if (typeof content !== 'string') continue;
    const m = /^\|\s*image\s*=\s*([^\n|]+)$/m.exec(content.slice(content.indexOf('{{Infobox player')));
    const file = m && m[1].replace(/^(File|Image):/i, '').trim();
    if (!file || DEFAULT.test(file) || /\{\{/.test(file)) continue;
    idx.players[sid] = { file };
    photoRank.push([rosterNicks.get(String(e.id || '').toLowerCase()) ?? 999, file]);
  }
  // roster players (official squads + stand-ins) that are not among the pages we already have: their infobox
  idx.ppl ||= {};
  const lpToSid = new Map(Object.entries(links).filter(([, e]) => e.lp).map(([sid, e]) => [e.lp, sid]));
  const squadOf = new Map(); // person page → [team page, rank]
  for (const [pg, v] of Object.entries(idx.pages)) {
    const r = rankedPages.indexOf(pg);
    for (const x of [...(v.f?.squad || []), ...(v.f?.standins || [])]) if (x.t && !squadOf.has(x.t)) squadOf.set(x.t, [pg, r < 0 ? 999 : r + 1]);
  }
  // coaches / managers / analysts of every team page (photo for the staff block)
  const staffOf = new Map(); // person page → rank of the team
  for (const [pg, v] of Object.entries(idx.pages)) {
    const r = rankedPages.indexOf(pg);
    for (const x of v.f?.staff || []) if (x[4] && !staffOf.has(x[4])) staffOf.set(x[4], r < 0 ? 999 : r + 1);
  }
  const fromExtra = (t) => { const c = extra[t]; if (typeof c !== 'string') return ''; const m = /^\|\s*image\s*=\s*([^\n|]+)$/m.exec(c); return m ? m[1].replace(/^(File|Image):/i, '').trim() : ''; };
  const pplTodo = OFFLINE ? [] : [...new Set([...squadOf.keys(), ...[...staffOf.keys()].sort((a, b) => staffOf.get(a) - staffOf.get(b))])]
    .filter((t) => !lpToSid.has(t) && !(staffOf.has(t) && !squadOf.has(t) && typeof extra[t] === 'string') && !(idx.ppl[t]?.at > now - 30 * 86400000)).slice(0, 800);
  for (const part of chunks(pplTodo, 50)) {
    let j;
    try { j = await lp.call({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', rvsection: '0', redirects: '1', titles: part.join('|') }, 'lp-roster-players'); } catch (e) { console.log('игроки составов:', e.message); break; }
    const q = j.query || {};
    const back = new Map();
    for (const x of [...(q.normalized || []), ...(q.redirects || [])]) back.set(x.to, x.from);
    for (const p of q.pages || []) {
      let req = p.title;
      for (let i = 0; i < 3 && back.has(req); i++) req = back.get(req);
      const ib = templates(noRefs(p.revisions?.[0]?.slots?.main?.content || ''), 'Infobox (?:player|person|talent|staff|coach|manager)')[0];
      if (!ib) { idx.ppl[req] = { at: now }; continue; }
      const sid = (ib.steam64id || '').replace(/\D/g, '');
      const l = {};
      for (const k of ['faceit', 'twitter', 'instagram', 'twitch', 'youtube', 'telegram', 'vk', 'tiktok', 'kick']) if (ib[k] && !/\{\{/.test(ib[k])) l[k] = plain(ib[k]).replace(/\s+/g, '');
      idx.ppl[req] = {
        at: now, sid: sid.length === 17 ? sid : '', image: plain(ib.image).replace(/^(File|Image):/i, ''),
        f: { lp: req, id: plain(ib.id) || req, name: plain(ib.name), rn: plain(ib.romanized_name), c: plain(ib.country), b: /^\d{4}-\d\d-\d\d$/.test(ib.birth_date || '') ? ib.birth_date : '', r: plain(ib.roles).toLowerCase().replace(/\s+/g, ''), l },
      };
    }
  }
  idx.staff = {}; // person page → photo file (coaches, managers)
  for (const [t, v] of Object.entries(idx.ppl)) {
    if (!v.image || DEFAULT.test(v.image)) continue;
    if (v.sid) idx.players[v.sid] = { file: v.image };
    if (staffOf.has(t)) idx.staff[t] = v.image;
    if (v.sid || staffOf.has(t)) photoRank.push([Math.min(squadOf.get(t)?.[1] ?? 999, (staffOf.get(t) ?? 999) + 0.5), v.image]);
  }
  for (const [t, r] of staffOf) {
    if (idx.staff[t]) continue;
    const img = fromExtra(t) || (lpToSid.has(t) && idx.players[lpToSid.get(t)]?.file) || '';
    if (img && !DEFAULT.test(img)) { idx.staff[t] = img; photoRank.push([r + 0.5, img]); }
  }
  photoRank.sort((a, b) => a[0] - b[0]);

  // ---- download queue, most visible first ----
  const queue = [];
  const push = (f, size) => { if (f && !queue.some((q) => q[0] === f)) queue.push([f, size]); };
  const wantKeys = [...want.keys()];
  for (const k of wantKeys.slice(0, firstWanted)) push(idx.teams[k]?.file, 64);      // ranking, matches page, our players' teams
  for (const p of (esports?.tournaments || []).map((t) => t.id)) push(idx.tours[p]?.file, 64);
  for (const [r, f] of photoRank) if (r <= 60) push(f, 160);                          // rosters of the world top 60
  for (const p of need.tours) push(idx.tours[p]?.file, 64);                           // titles / recent tournaments
  for (const k of wantKeys.slice(firstWanted)) push(idx.teams[k]?.file, 64);          // opponents on team pages
  for (const [r, f] of photoRank) if (r > 60) push(f, 160);

  // ---- file → thumbnail URL ----
  for (const size of [64, 160]) {
    const toResolve = OFFLINE ? [] : queue.filter(([f, sz]) => sz === size && !idx.files[f]?.img && !idx.files[f]?.url && !(idx.files[f]?.miss > now - WEEK)).map(([f]) => f).slice(0, 2000);
    for (const part of chunks(toResolve, 50)) {
      let j;
      const params = { action: 'query', prop: 'imageinfo', iiprop: 'url', iiurlwidth: String(size), iiurlheight: String(size), titles: part.map((f) => 'File:' + f).join('|') };
      try { j = await lp.call(params, 'lp-imageinfo'); } catch (e) {
        console.log('imageinfo:', e.message, '— повтор через 30 с');
        await sleep(30000);
        try { j = await lp.call(params, 'lp-imageinfo'); } catch (e2) { console.log('imageinfo:', e2.message); break; }
      }
      const q = j.query || {};
      const back = new Map();
      for (const x of q.normalized || []) back.set(x.to, x.from);
      for (const p of q.pages || []) {
        const name = (back.get(p.title) || p.title).replace(/^File:/, '');
        const ii = p.imageinfo?.[0];
        idx.files[name] = ii?.thumburl || ii?.url ? { url: ii.thumburl || ii.url } : { miss: now };
      }
    }
  }

  // ---- download thumbnails ----
  const order = OFFLINE ? [] : queue.map(([f]) => f).filter((f) => idx.files[f]?.url && !idx.files[f]?.img);
  let got = 0, fail = 0, waits = 0;
  // Liquipedia asks automated clients for ≤ 1 request per 2 s in total; on 429 back off a minute, give up after 3
  await sleep(5000);
  for (const f of order.slice(0, MAX_DL)) {
    try {
      let r = await fetch(idx.files[f].url, { headers: { 'User-Agent': UA, Accept: 'image/*' }, signal: AbortSignal.timeout(30000) });
      while (r.status === 429 && waits < 3) {
        waits++;
        console.log(`Liquipedia просит подождать (${waits}/3) — пауза 60 с`);
        await sleep(60000);
        r = await fetch(idx.files[f].url, { headers: { 'User-Agent': UA, Accept: 'image/*' }, signal: AbortSignal.timeout(30000) });
      }
      if (r.status === 429) { console.log('Liquipedia просит подождать — остальное в следующий раз'); break; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const ext = (/\.(png|jpe?g|webp|gif|svg)(?:$|\?)/i.exec(idx.files[f].url)?.[1] || 'png').toLowerCase().replace('jpeg', 'jpg');
      const name = crypto.createHash('sha1').update(f).digest('hex').slice(0, 12) + '.' + (ext === 'svg' ? 'svg' : ext);
      fs.writeFileSync(path.join(STORE, 'img', name), buf);
      idx.files[f] = { img: name };
      got++;
    } catch (e) {
      fail++;
      idx.files[f] = { url: idx.files[f].url, err: String(e.message).slice(0, 60), miss: now };
    }
    await sleep(2200);
  }

  idx.at = new Date().toISOString();
  fs.writeFileSync(path.join(STORE, 'index.json'), JSON.stringify(idx));

  // ---- site files ----
  const outDir = path.join(OUT, 'logos');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const t = {}, e = {};
  const used = new Set();
  for (const [k, v] of Object.entries(idx.teams)) { const img = v.file && idx.files[v.file]?.img; if (img) { t[k] = img; used.add(img); } }
  for (const [p, v] of Object.entries(idx.tours)) { const img = v.file && idx.files[v.file]?.img; if (img) { e[p] = img; used.add(img); } }
  const ph = {};
  for (const [sid, v] of Object.entries(idx.players || {})) { const img = v.file && idx.files[v.file]?.img; if (img) { ph[sid] = img; used.add(img); } }
  const st = {};
  for (const [t, f] of Object.entries(idx.staff || {})) { const img = idx.files[f]?.img; if (img) { st[t] = img; used.add(img); } }
  for (const img of used) fs.copyFileSync(path.join(STORE, 'img', img), path.join(outDir, img));
  fs.writeFileSync(path.join(OUT, 'logos.json'), JSON.stringify({ src: 'Liquipedia', at: idx.at, t, e, p: ph, s: st }));
  // team infoboxes for the team pages
  const info = {};
  const sidOf = (t) => lpToSid.get(t) || idx.ppl[t]?.sid || '';
  for (const [pg, v] of Object.entries(idx.pages || {})) {
    if (!v.f || !Object.keys(v.f).length) continue;
    const f = { ...v.f };
    if (f.squad) f.squad = f.squad.map((x) => ({ ...x, sid: sidOf(x.t) }));
    if (f.standins) f.standins = f.standins.map((x) => ({ ...x, sid: sidOf(x.t) }));
    info[pg] = f;
  }
  // profiles of roster players our demos don't have yet (their player page shows Liquipedia data only)
  const known = new Set(Object.keys(links));
  const pix = read(path.join(OUT, 'players', 'index.json'));
  if (pix?.cols) { const si = pix.cols.indexOf('sid'); for (const r of pix.rows) known.add(String(r[si])); }
  const extraOut = {};
  for (const [t, v] of Object.entries(idx.ppl)) {
    if (!v.sid || known.has(v.sid) || !v.f) continue;
    const team = squadOf.get(t)?.[0];
    extraOut[v.sid] = { ...v.f, ...(team ? { team } : {}) };
  }
  if (fs.existsSync(path.join(OUT, 'players'))) fs.writeFileSync(path.join(OUT, 'players', 'extra.json'), JSON.stringify(extraOut));
  console.log(`составы: ${Object.values(info).filter((x) => x.squad).length} команд; игроков без демок с профилем: ${Object.keys(extraOut).length}`);
  if (fs.existsSync(path.join(OUT, 'teams'))) fs.writeFileSync(path.join(OUT, 'teams', 'info.json'), JSON.stringify(info));
  console.log(`фото игроков: ${Object.keys(ph).length}, тренеров и менеджеров: ${Object.keys(st).length}, инфобоксов команд: ${Object.keys(info).length}`);
  const haveWanted = [...want.keys()].filter((k) => t[k]).length;
  console.log(`логотипы: скачано ${got}${fail ? `, не удалось ${fail}` : ''}, в очереди ${Math.max(0, order.length - MAX_DL)}; у команд сайта: ${haveWanted}/${want.size} ключей, турниров с иконкой: ${[...tours].filter((p) => e[p]).length}/${tours.size}; запросов к API: ${lp.count}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
