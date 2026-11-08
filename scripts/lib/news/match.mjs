// Which teams a news headline is about.
//
// Catalog = teams of the site (public/data/teams/index.json) that played in the last year or are in the Valve
// ranking, with the names they go by in the press, plus the nicknames of their players and coaches
// (Liquipedia squads from teams/info.json, Valve ranking rosters). A news item belongs to a team when its
// title names the team or one of its people; the description (never published, used only here) can add
// teams when it names at most three of them — a tournament recap that lists ten teams is about none.

const FILLER = new Set(['team', 'esports', 'esport', 'e', 'sports', 'gaming', 'clan', 'club', 'gg']);
/** same as teamKeys() in src/lib/teams.ts and scripts/build-db.mjs */
export function teamKeys(name) {
  const words = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
  return [...new Set([words.join(''), words.filter((w) => !FILLER.has(w)).join('')].filter(Boolean))];
}

// names the press uses that are not derived from the official one (by team slug)
const ALIASES = {
  'natus-vincere': ['NAVI', "Na'Vi", 'Natus Vincere'],
  'virtus-pro': ['Virtus.pro', 'Virtus pro', 'Virtus.Pro'],
  mouz: ['MOUZ', 'mousesports'],
  'the-mongolz': ['The MongolZ', 'MongolZ', 'Mongolz'],
  'faze-clan': ['FaZe', 'FaZe Clan'],
  'ninjas-in-pyjamas': ['NIP', 'Ninjas in Pyjamas'],
  'betboom-team': ['BetBoom', 'BETBOOM TEAM', 'BetBoom Team'],
  'eternal-fire': ['Eternal Fire'],
  'gamerlegion': ['GamerLegion'],
  'bc-game-esports': ['BC.Game', 'BCGame', 'BC Game'],
  'lynn-vision-gaming': ['Lynn Vision'],
  'the-huns-esports': ['The Huns'],
  'rare-atom': ['Rare Atom'],
  'team-liquid': ['Team Liquid', 'Liquid'],
};
// words that are names of some team but mean something else in CS news
const STOP = new Set(`team esports gaming clan club the major minor cup open pro league masters final finals playoffs playoff stage group
iem esl pgl blast valve steam cs cs2 csgo cs:go faceit hltv mvp evp awp ak deagle inferno mirage nuke ancient anubis dust dust2 train
overpass vertigo cache premier rmr vrs legend legends challengers challenger elite rivals champions champion world global international
academy junior juniors female mix igl coach news live twitch youtube kick telegram discord reddit ceo game games play player players win top
best king boss god zero one ace clutch eco rush entry lurk support rifle sniper smoke flash skin skins case knife sticker music pass update
patch map maps round rounds match matches bo1 bo3 bo5 tv pc ai ok gg wp ez lol dota valorant season tour arena event spring fall summer
winter cologne katowice beijing singapore austin shanghai budapest copenhagen paris rio dallas melbourne chengdu astana bucharest cluj
krakow stockholm antwerp rotterdam london berlin moscow kyiv perfect adr kast rating kd hs fps ping cfg config stream streamer stats stat
demo bot bots rank elo eac vac`.split(/\s+/));
const SHORT_OK = new Set(['OG']); // two-letter tags that are well-known teams

const LATIN = /[A-Za-z0-9]/;
const TOP = 60; // teams of the Valve top-60: their one-word names ("Aurora", "Legacy") count in English headlines too
const hasUpperInside = (s) => /[A-Z]/.test(s.slice(1)) && /[a-z]/.test(s);
const lettersLen = (s) => s.replace(/[^\p{L}\p{N}]/gu, '').length;

function okForm(f) {
  if (!f || !/[A-Za-z]/.test(f) || /^\d+$/.test(f)) return false;
  if (!/^[\x20-\x7e]+$/.test(f)) return false; // Latin-script names only (the press writes them in Latin)
  if (f === f.toLowerCase() && !/\d/.test(f)) return false; // "benched", "magic", "los kogutos" — words, not names
  const n = lettersLen(f);
  if (n < 2) return false;
  if (n === 2 && !/\d/.test(f) && !SHORT_OK.has(f)) return false; // "AM", "XI", "WW"
  if (n === 3 && /^[A-Z][a-z]+$/.test(f)) return false; // "Few", "Los"
  return !STOP.has(f.toLowerCase());
}
function shortForms(name) {
  name = name.replace(/\s*\([^)]*\)\s*$/, '').trim(); // "Arcade (Australian team)"
  if (!name) return [];
  const out = [name];
  const words = name.split(/\s+/);
  const core = words.filter((w) => !FILLER.has(w.toLowerCase()));
  if (core.length && core.length < words.length) out.push(core.join(' '));
  if (/^the\s/i.test(name)) out.push(name.replace(/^the\s+/i, ''));
  return out;
}
function okNick(n) {
  if (!n || !/^[A-Za-z0-9_.\-]+$/.test(n) || /^\d+$/.test(n)) return false;
  const len = n.length;
  if (len < 2 || (len < 3 && !/\d/.test(n))) return false;
  return !STOP.has(n.toLowerCase());
}

/**
 * Build the matcher catalog.
 * @param {{k: Record<string,string>, t: [string,string,number,number,number][]}} index teams/index.json
 * @param {Record<string, any>} info teams/info.json (Liquipedia page → infobox)
 * @param {{teams: [number,number,string,string[],string,number,number][]}} rankings rankings.json
 */
export function buildCatalog(index, info, rankings, nowSec = Date.now() / 1000) {
  const slugOf = (name) => { for (const k of teamKeys(name || '')) if (index.k[k]) return index.k[k]; return null; };
  const byslug = new Map(index.t.map((t) => [t[0], t]));
  const rank = new Map();
  for (const r of rankings?.teams || []) { const s = slugOf(r[2]); if (s && !rank.has(s)) rank.set(s, { pos: r[0], name: r[2], roster: r[3] || [] }); }
  const universe = index.t.filter((t) => t[3] > nowSec - 365 * 86400 || rank.has(t[0])).map((t) => t[0]);
  const prio = (s) => (rank.has(s) ? rank.get(s).pos : 1000 + 1 / (1 + (byslug.get(s)?.[2] || 0)));
  const pages = new Map(); // slug → info
  for (const [pg, f] of Object.entries(info || {})) { const s = slugOf(pg); if (s && !pages.has(s)) pages.set(s, { page: pg, ...f }); }

  const forms = new Map(); // form → slug (best priority wins)
  const top = (slug) => (rank.get(slug)?.pos || 999) <= TOP;
  const add = (map, key, slug) => { const cur = map.get(key); if (!cur || prio(slug) < prio(cur)) map.set(key, slug); };
  for (const s of universe) {
    const names = new Set([byslug.get(s)[1], pages.get(s)?.page, rank.get(s)?.name, ...(ALIASES[s] || [])].filter(Boolean));
    for (const n of names) for (const f of shortForms(n)) if (okForm(f)) add(forms, f, s);
  }
  const formsLower = new Set([...forms.keys()].map((f) => f.toLowerCase()));
  const nicks = new Map(); // nick → slug
  for (const s of universe) {
    const p = pages.get(s);
    const people = new Set([
      ...(p?.squad || []).filter((x) => !x.role).map((x) => x.id),
      ...(p?.staff || []).filter((x) => /тренер|coach/i.test(x[1] || '')).map((x) => x[0]),
      ...(rank.get(s)?.roster || []),
    ]);
    for (const n of people) if (okNick(n) && !formsLower.has(n.toLowerCase())) add(nicks, n, s);
  }
  return {
    v: 1,
    teams: Object.fromEntries(universe.map((s) => [s, byslug.get(s)[1]])),
    forms: [...forms.entries()].map(([f, s]) => (top(s) ? [f, s, 1] : [f, s])),
    nicks: [...nicks.entries()],
  };
}

/** case rules per language: Latin words inside Russian text are distinctive, inside English text they may be plain words */
function compile(catalog) {
  const pats = [];
  for (const [f, slug, top] of catalog.forms) {
    const multi = /\s/.test(f) || /[\d.']/.test(f);
    const n = lettersLen(f);
    // English: a one-word Capitalized name is also an ordinary word ("Legacy", "Echo") — only top teams count
    const en = multi || f !== f[0] + f.slice(1).toLowerCase() || !!top;
    pats.push({ s: f, l: f.toLowerCase(), slug, kind: 'team', ci: { ru: n >= 4, en: multi && n >= 4 }, en });
  }
  for (const [nick, slug] of catalog.nicks) {
    const distinct = /\d/.test(nick) || hasUpperInside(nick) || (nick.length >= 4 && nick === nick.toUpperCase());
    pats.push({ s: nick, l: nick.toLowerCase(), slug, kind: 'nick', ci: { ru: nick.length >= 4, en: false }, en: distinct });
    // a headline starts with a capital: "B1t об IEM…" for b1t
    if (nick.length === 3 && /^[a-z]/.test(nick)) pats.push({ s: nick[0].toUpperCase() + nick.slice(1), l: '', slug, kind: 'nick', ci: { ru: false, en: false }, en: distinct, as: nick });
  }
  return pats;
}
const cache = new WeakMap();

function findAll(text, lang, pats) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const p of pats) {
    if (lang === 'en' && !p.en) continue;
    const ci = p.ci[lang];
    const hay = ci ? lower : text;
    const needle = ci ? p.l : p.s;
    let i = hay.indexOf(needle);
    while (i >= 0) {
      const a = text[i - 1] || ' ', b = text[i + needle.length] || ' ';
      const edgeA = LATIN.test(needle[0]) && (LATIN.test(a) || a === '_');
      const edgeB = LATIN.test(needle[needle.length - 1]) && (LATIN.test(b) || b === '_');
      // "Virtus.pro" ends a sentence fine; "G2." too, but "x.com" style joins are not names
      if (!edgeA && !edgeB) hits.push({ i, j: i + needle.length, p });
      i = hay.indexOf(needle, i + 1);
    }
  }
  // longest first, no overlaps; team names beat nicknames of the same length
  hits.sort((x, y) => (y.j - y.i) - (x.j - x.i) || (x.p.kind === 'team' ? -1 : 1));
  const taken = [];
  const out = [];
  for (const h of hits) {
    if (taken.some(([a, b]) => h.i < b && a < h.j)) continue;
    taken.push([h.i, h.j]);
    out.push(h);
  }
  return out;
}

/**
 * @returns {Record<string, {w?: 1, p?: string[]}>} slug → (w: only the description names it; p: players/coaches named)
 */
export function matchItem({ title, desc }, lang, catalog) {
  let pats = cache.get(catalog);
  if (!pats) cache.set(catalog, (pats = compile(catalog)));
  const strong = new Map(), weak = new Map();
  const put = (m, h) => { const e = m.get(h.p.slug) || new Set(); if (h.p.kind === 'nick') e.add(h.p.as || h.p.s); m.set(h.p.slug, e); };
  for (const h of findAll(title || '', lang, pats)) put(strong, h);
  for (const h of findAll(desc || '', lang, pats)) put(weak, h);
  const all = new Set([...strong.keys(), ...weak.keys()]);
  const out = {};
  for (const [s, ps] of strong) {
    const more = weak.get(s);
    const p = [...new Set([...ps, ...(more || [])])];
    out[s] = p.length ? { p } : {};
  }
  if (all.size <= 3) for (const [s, ps] of weak) if (!out[s]) out[s] = { w: 1, ...(ps.size ? { p: [...ps] } : {}) };
  return out;
}
