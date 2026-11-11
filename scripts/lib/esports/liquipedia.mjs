// Liquipedia (Counter-Strike wiki) through its public MediaWiki API, following
// https://liquipedia.net/api-terms-of-use : custom User-Agent with contact, gzip, ≤1 request / 2 s,
// action=parse ≤1 / 30 s, results cached. Content: CC BY-SA 3.0, attribution on the page.
import { parseHTML } from '../mini-html.mjs';

export const WIKI = 'https://liquipedia.net/counterstrike/';
export const API = WIKI + 'api.php';
export const UA = 'RUSHB-esports/1.0 (https://github.com/vsemvamdam/rush-b)';

export const TIER = { 1: 'S', 2: 'A', 3: 'B', 4: 'C', 5: 'D' };

// One parse call renders several match tickers: per tier, so every match gets its tier from the section.
const TICKER = (type, tier, limit) =>
  `<div class="ccx-sec" data-type="${type}" data-tier="${tier}">{{#invoke:Lua|invoke|module=MatchTicker/Custom|fn=mainPage|type=${type}|limit=${limit}|filterbuttons-liquipediatier=${tier}}}</div>`;
export const TICKER_TEXT = [
  TICKER('upcoming', 1, 80), TICKER('upcoming', 2, 80), TICKER('upcoming', 3, 60), TICKER('upcoming', 4, 40),
  TICKER('recent', 1, 40), TICKER('recent', 2, 40), TICKER('recent', 3, 30), TICKER('recent', 4, 20),
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function liquipediaClient({ fetchImpl = fetch, log = console.log, dump } = {}) {
  let last = 0;
  let lastParse = 0;
  let n = 0;
  async function call(params, name) {
    const parse = params.action === 'parse';
    const wait = Math.max(last + 2200, parse && lastParse ? lastParse + 31000 : 0) - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    if (parse) lastParse = last;
    n++;
    const body = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
    // long parse texts go as POST (still the API, same limits)
    const usePost = body.toString().length > 1500;
    const r = await fetchImpl(usePost ? API : API + '?' + body, {
      method: usePost ? 'POST' : 'GET',
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip', Accept: 'application/json', ...(usePost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: usePost ? body : undefined,
    });
    const text = await r.text();
    if (dump) await dump(name, text);
    if (!r.ok) throw new Error(`Liquipedia ${name}: HTTP ${r.status}`);
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`Liquipedia ${name}: не JSON (${text.slice(0, 80)})`); }
    if (j.error) throw new Error(`Liquipedia ${name}: ${j.error.code} ${j.error.info || ''}`);
    return j;
  }
  return { call, get count() { return n; } };
}

// ───────────────────────── matches ─────────────────────────

const pageFromHref = (href) => {
  const red = /[?&]title=([^&#]+)/.exec(href || ''); // red link: index.php?title=X&action=edit&redlink=1
  const m = red || /\/counterstrike\/([^?#]+)/.exec(href || '');
  return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : null;
};

function opponent(node) {
  if (!node) return null;
  const a = node.find('.name')?.find('a') || node.find('a[title]');
  if (a) {
    const short = a.clean;
    const title = (a.attr('title') || short).replace(/ \(page does not exist\)$/, '');
    const full = title.replace(/\s*\([^)]*\)$/, ''); // "MAYBE (Ukrainian team)" → "MAYBE"
    return { n: short || full, f: full !== short ? full : undefined, page: pageFromHref(a.attr('href')) || title };
  }
  const lit = node.clean.replace(/[\u200b-\u200d\ufeff]/g, '').trim(); // "TBD", "Group B 2nd Place", zero-width space
  return { n: lit || 'TBD', tbd: true };
}

export function streamLinks(container) {
  const out = [];
  const seen = new Set();
  for (const a of container.findAll('a[href]')) {
    const href = a.attr('href');
    const m = /Special:Stream\/([^/]+)\/([^?#"]+)/.exec(href);
    let p, u;
    if (m) {
      p = m[1].toLowerCase();
      const id = decodeURIComponent(m[2]);
      // Twitch values are channel names; other platforms go through Liquipedia's stream page,
      // which resolves its own aliases to the real channel
      if (p.startsWith('twitch') && /^\w+$/.test(id)) u = 'https://www.twitch.tv/' + id;
      else u = WIKI + 'Special:Stream/' + m[1] + '/' + m[2];
      p = p.replace(/[^a-z]/g, '');
    } else if (/^https?:\/\/(www\.)?(twitch\.tv\/|kick\.com\/|youtube\.com\/(live|watch|@)|youtu\.be\/)/.test(href) && !a.closest('.match-info-vods-area')) {
      // the «/» right after the host matters: «twitch.tv.example.com» is somebody else's site
      p = /twitch/.test(href) ? 'twitch' : /kick/.test(href) ? 'kick' : 'youtube';
      u = href;
    } else continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push({ p, u });
  }
  return out.slice(0, 6);
}

/** one ".match-info" block → match */
export function parseMatchInfo(mi, { tier, now = Date.now() / 1000 } = {}) {
  const timer = mi.find('[data-timestamp]');
  const start = timer ? +timer.attr('data-timestamp') : NaN;
  if (!Number.isFinite(start) || start <= 0) return null;
  const finished = timer.attr('data-finished') === 'finished';
  const exact = !timer.hasClass('timer-object-datetime-only') || finished;
  const ops = mi.findAll('.match-info-header-opponent');
  if (ops.length < 2) return null;
  const t1 = opponent(ops[0]);
  const t2 = opponent(ops[1]);
  const holder = mi.find('.match-info-header-scoreholder');
  const scores = holder ? holder.findAll('.match-info-header-scoreholder-score').map((x) => x.clean) : [];
  let score;
  if (scores.length === 2 && scores.every((s) => /^\d+$/.test(s))) score = [+scores[0], +scores[1]];
  else {
    const m = /(\d+)\s*[:–-]\s*(\d+)/.exec(holder?.find('.match-info-header-scoreholder-upper')?.clean || '');
    if (m) score = [+m[1], +m[2]];
  }
  const boM = /Bo\s?(\d+)/i.exec(holder?.find('.match-info-header-scoreholder-lower')?.clean || holder?.clean || '');
  const bo = boM ? +boM[1] : undefined;
  let winner;
  if (ops[0].hasClass('match-info-header-winner')) winner = 1;
  else if (ops[1].hasClass('match-info-header-winner')) winner = 2;
  const tn = mi.find('.match-info-tournament-name');
  const ta = tn?.find('a');
  const tourPage = ta ? (ta.attr('title') || pageFromHref(ta.attr('href')) || '').split('#')[0].replace(/_/g, ' ') : '';
  const tourText = tn?.clean || '';
  // "IEM Beijing 2026 - Playoffs" → name + stage
  const dash = tourText.lastIndexOf(' - ');
  const tour = dash > 0 ? tourText.slice(0, dash) : tourText;
  const stage = dash > 0 ? tourText.slice(dash + 3) : undefined;
  const status = finished ? 'finished' : start <= now ? 'live' : 'upcoming';
  const m = {
    t1, t2, start, status,
    ...(exact ? {} : { approx: true }),
    ...(bo ? { bo } : {}),
    ...(score && status !== 'upcoming' ? { score } : {}),
    ...(finished && winner ? { winner } : {}),
    tour: tour || tourPage,
    ...(stage ? { stage } : {}),
    tpage: tourPage || undefined,
    ...(tier ? { tier } : {}),
  };
  const streams = streamLinks(mi);
  if (streams.length && !finished) m.streams = streams;
  return m;
}

export const matchKey = (m) => {
  const a = m.t1.n.toLowerCase();
  const b = m.t2.n.toLowerCase();
  return [a, b].sort().join('|') + '|' + (m.tpage || m.tour || '').toLowerCase();
};

/** HTML of the parse call → matches (deduplicated; tier from the section) */
export function parseTickers(html, now = Date.now() / 1000) {
  const root = parseHTML(html);
  const out = [];
  const sections = root.findAll('.ccx-sec');
  const blocks = sections.length ? sections : [root];
  for (const sec of blocks) {
    const tier = TIER[sec.attr('data-tier')] || undefined;
    for (const mi of sec.findAll('.match-info')) {
      const m = parseMatchInfo(mi, { tier, now });
      if (m) out.push(m);
    }
  }
  // the same match can be in two sections only by mistake; keep first (highest tier)
  const seen = new Map();
  for (const m of out) {
    const k = matchKey(m) + '|' + Math.round(m.start / 3600);
    if (!seen.has(k)) seen.set(k, m);
  }
  return [...seen.values()];
}

export async function fetchMatches(lp, now) {
  const j = await lp.call({ action: 'parse', title: 'Liquipedia:Matches', contentmodel: 'wikitext', text: TICKER_TEXT, prop: 'text', disablelimitreport: '1', disableeditsection: '1' }, 'lp-tickers');
  const html = j.parse?.text;
  if (typeof html !== 'string') throw new Error('Liquipedia: пустой ответ parse');
  return parseTickers(html, now);
}

// ───────────────────────── tournaments ─────────────────────────

/** Liquipedia:Tournaments wikitext → [{ page, name, group }] */
export function parseTournamentList(wikitext) {
  const out = [];
  let group = '';
  for (const line of String(wikitext || '').split('\n')) {
    const g = /^\*\s*([^*].*?)\s*$/.exec(line);
    if (g && !line.startsWith('**')) { group = g[1].toLowerCase(); continue; }
    const t = /^\*\*\s*([^|]+)\|([^|]+)/.exec(line);
    if (t) out.push({ page: t[1].trim().replace(/_/g, ' '), name: t[2].trim(), group });
  }
  return out;
}

/** top-level params of the first {{Infobox league ...}} in wikitext */
export function parseInfobox(wikitext) {
  const s = String(wikitext || '');
  const i = s.search(/\{\{\s*Infobox[ _]league/i);
  if (i < 0) return null;
  let depth = 0;
  let j = i;
  for (; j < s.length - 1; j++) {
    if (s[j] === '{' && s[j + 1] === '{') { depth++; j++; }
    else if (s[j] === '}' && s[j + 1] === '}') { depth--; j++; if (depth === 0) break; }
  }
  const body = s.slice(i + 2, j - 1);
  // split on | at depth 1 (ignore inside nested templates/links)
  const parts = [];
  let cur = '';
  let d = 0;
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    const two = body.slice(k, k + 2);
    if (two === '{{' || two === '[[') { d++; cur += two; k++; continue; }
    if (two === '}}' || two === ']]') { d--; cur += two; k++; continue; }
    if (c === '|' && d === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  const args = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    const v = p.slice(eq + 1).replace(/<!--[\s\S]*?-->/g, '').trim();
    if (k && v) args[k] = v;
  }
  return args;
}

const stripWiki = (v) =>
  String(v || '')
    .replace(/<ref[\s\S]*?(<\/ref>|\/>)/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/'''?/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

const TIER_NAMES = { s: 1, 's-tier': 1, a: 2, 'a-tier': 2, b: 3, 'b-tier': 3, c: 4, 'c-tier': 4, d: 5, 'd-tier': 5 };
const isoDate = (v) => {
  const m = /(\d{4})-(\d{2}|\?\?)-(\d{2}|\?\?)/.exec(v || '');
  if (!m) return undefined;
  return [m[1], m[2] === '??' ? '' : m[2], m[3] === '??' ? '' : m[3]].filter(Boolean).join('-');
};

/** infobox args → tournament fields */
export function tournamentFromInfobox(args, page) {
  if (!args) return null;
  const tierRaw = String(args.liquipediatier || '').toLowerCase().trim();
  const tierN = /^\d$/.test(tierRaw) ? +tierRaw : TIER_NAMES[tierRaw];
  const usd = stripWiki(args.prizepoolusd).replace(/[^\d.]/g, '');
  const local = stripWiki(args.prizepool).replace(/[^\d.]/g, '');
  const cur = (args.localcurrency || '').toUpperCase();
  const city = stripWiki(args.city || args.location);
  const country = stripWiki(args.country);
  const venue = stripWiki(args.venue);
  const type = /online/i.test(args.type || '') ? (/offline/i.test(args.type) ? 'mixed' : 'online') : /offline|lan/i.test(args.type || '') ? 'lan' : undefined;
  const t = {
    page,
    name: stripWiki(args.name) || page,
    ...(args.tickername ? { short: stripWiki(args.tickername) } : {}),
    ...(tierN ? { tier: TIER[tierN] } : {}),
    ...(args.liquipediatiertype ? { tiertype: stripWiki(args.liquipediatiertype) } : {}),
    ...(isoDate(args.sdate || args.date) ? { start: isoDate(args.sdate || args.date) } : {}),
    ...(isoDate(args.edate || args.date) ? { end: isoDate(args.edate || args.date) } : {}),
    ...(usd ? { prize: Math.round(+usd), cur: 'USD' } : local ? { prize: Math.round(+local), cur: cur && cur !== 'USD' ? cur : 'USD' } : {}),
    ...(city ? { city } : {}),
    ...(country ? { country } : {}),
    ...(venue ? { venue } : {}),
    ...(type ? { type } : {}),
    ...(+args.team_number ? { teams: +args.team_number } : {}),
    ...(args.organizer ? { org: stripWiki(args.organizer).split(/\s*[,;]\s*/)[0] } : {}),
    ...(/^(1|true|yes)$/i.test(args.cstrikemajor || '') ? { major: true } : {}),
  };
  return t;
}

/** batch-fetch infoboxes (lead section) of pages → Map(page → tournament|null) */
export async function fetchInfoboxes(lp, pages, log = console.log) {
  const out = new Map();
  const list = [...new Set(pages.filter(Boolean))];
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40);
    let j;
    try {
      j = await lp.call({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', rvsection: '0', redirects: '1', titles: chunk.join('|') }, `lp-infobox-${i / 40}`);
    } catch (e) {
      log('infobox batch:', e.message);
      continue;
    }
    const q = j.query || {};
    const alias = new Map();
    for (const x of [...(q.normalized || []), ...(q.redirects || [])]) alias.set(x.to, x.from);
    for (const p of q.pages || []) {
      // map back to the requested title through redirects/normalisation
      let req = p.title;
      for (let k = 0; k < 3 && alias.has(req); k++) req = alias.get(req);
      const content = p.revisions?.[0]?.slots?.main?.content ?? p.revisions?.[0]?.content;
      const t = p.missing ? null : tournamentFromInfobox(parseInfobox(content), p.title);
      out.set(req, t);
      if (req !== p.title) out.set(p.title, t);
    }
  }
  return out;
}

export async function fetchTournamentList(lp) {
  const j = await lp.call({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: 'Liquipedia:Tournaments' }, 'lp-tournament-list');
  const content = j.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
  return parseTournamentList(content);
}
