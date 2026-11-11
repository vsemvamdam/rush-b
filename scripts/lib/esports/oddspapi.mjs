// OddsPapi — bookmaker odds API (self-serve v4, free plan 250 requests/month): https://oddspapi.io
// Needs ODDS_API_KEY (repository secret). The key goes only into the request; it is never logged or stored.
// Per refresh: 1× /fixtures (names, tournaments) + 1× /odds-by-tournaments (up to 3 bookmakers).

export const BASE = 'https://api.oddspapi.io/v4';
export const SPORT_CS2 = 17;
export const WINNER_MARKET = '171'; // CS2 match winner; outcomes 171 (participant 1) and 172 (participant 2)
export const OUTCOMES = ['171', '172'];
export const BOOK_NAMES = { pinnacle: 'Pinnacle', '1xbet': '1xBet', stake: 'Stake', bet365: 'bet365', ggbet: 'GG.BET', thunderpick: 'Thunderpick', betway: 'Betway', unibet: 'Unibet', bcgame: 'BC.Game', cloudbet: 'Cloudbet', polymarket: 'Polymarket' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = (s) => {
  const t = typeof s === 'number' ? s * (s < 1e12 ? 1000 : 1) : Date.parse(s);
  return Number.isFinite(t) ? Math.round(t / 1000) : NaN;
};

/** /fixtures → Map(fixtureId → { t1, t2, start, tid, tname, live }) */
export function parseFixtures(list) {
  const out = new Map();
  for (const f of Array.isArray(list) ? list : []) {
    if (!f?.fixtureId) continue;
    if (f.statusId === 2 || f.statusId === 3) continue; // finished / cancelled
    const t1 = f.participant1Name || f.participants?.participant1Name;
    const t2 = f.participant2Name || f.participants?.participant2Name;
    if (!t1 || !t2) continue;
    out.set(String(f.fixtureId), { t1, t2, start: ts(f.startTime), tid: f.tournamentId, tname: f.tournamentName || '', live: f.statusId === 1 });
  }
  return out;
}

function priceOf(outcome) {
  const players = outcome?.players || {};
  const p = players['0'] || Object.values(players)[0];
  if (!p || p.active === false) return NaN;
  return +p.price;
}

/** /odds-by-tournaments → Map(fixtureId → [{ b, o:[o1,o2] }]) */
export function parseOdds(list) {
  const out = new Map();
  for (const f of Array.isArray(list) ? list : []) {
    const books = [];
    for (const [slug, bo] of Object.entries(f?.bookmakerOdds || {})) {
      if (slug === 'demo' || slug.includes('+')) continue;
      if (bo.bookmakerIsActive === false || bo.suspended) continue;
      const mk = bo.markets?.[WINNER_MARKET];
      if (!mk || mk.marketActive === false) continue;
      const o = OUTCOMES.map((id) => priceOf(mk.outcomes?.[id]));
      if (o.every((x) => x > 1)) books.push({ b: slug, o });
    }
    if (books.length) out.set(String(f.fixtureId), books);
  }
  return out;
}

const redact = (s, key) => (key ? String(s).split(key).join('***') : String(s));

/**
 * Returns { fixtures: [{ id, t1, t2, start, books }], used } or throws.
 * key is passed as the apiKey query parameter, as the v4 API requires.
 */
export async function fetchOddsPapi({ key, bookmakers, now = Date.now(), fetchImpl = fetch, log = console.log }) {
  let used = 0;
  async function get(path, params) {
    if (used) await sleep(1300); // endpoint cooldown is 1000 ms
    used++;
    const url = `${BASE}${path}?` + new URLSearchParams({ ...params, apiKey: key });
    let r;
    try {
      r = await fetchImpl(url, { headers: { 'User-Agent': 'RUSHB-esports/1.0 (https://github.com/vsemvamdam/rush-b)', 'Accept-Encoding': 'gzip', Accept: 'application/json' } });
    } catch (e) {
      throw new Error(redact(`OddsPapi ${path}: ${e.message}`, key));
    }
    const text = await r.text();
    if (r.status === 404) return []; // "nothing scheduled"
    if (!r.ok) {
      let msg = '';
      try { const j = JSON.parse(text); msg = j.message || j.error || j.code || ''; } catch {}
      const err = new Error(redact(`OddsPapi ${path}: HTTP ${r.status} ${msg}`.trim(), key));
      err.status = r.status;
      throw err;
    }
    return JSON.parse(text);
  }
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const books = bookmakers.slice(0, 3).join(',');
  const fx = parseFixtures(await get('/fixtures', { sportId: SPORT_CS2, from: iso(now - 6 * 3600e3), to: iso(now + 9.5 * 86400e3), hasOdds: 'true', bookmakers: books }));
  const tids = [...new Set([...fx.values()].map((f) => f.tid).filter(Boolean))];
  log(`oddspapi: ${fx.size} матчей с коэффициентами в ${tids.length} турнирах`);
  if (!tids.length) return { fixtures: [], used };
  const odds = parseOdds(await get('/odds-by-tournaments', { tournamentIds: tids.join(','), bookmakers: books }));
  const fixtures = [];
  for (const [id, f] of fx) if (odds.has(id)) fixtures.push({ id, ...f, books: odds.get(id) });
  return { fixtures, used };
}
