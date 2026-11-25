// Pure helpers for scripts/my-matches.mjs (no network, no Steam) — unit-tested in tests/my-matches.test.mjs.

export const SECRET_NAMES = ['STEAM_API_KEY', 'CS2_AUTH_CODE', 'CS2_LAST_SHARECODE', 'STEAM_BOT_TOKEN'];
export const STEAM64_BASE = 76561197960265728n;
export const RANK_TYPES = { 11: 'premier', 12: 'competitive', 6: 'competitive', 7: 'wingman' };

export class SyncError extends Error {
  /** @param {string} kind  config | auth | knowncode | steam | gc | net @param {string} message (Russian) */
  constructor(kind, message, { fatal = false } = {}) {
    super(message);
    this.kind = kind;
    this.fatal = fatal; // fatal = wrong secret, fail the run so the owner notices
  }
}

// ---------------------------------------------------------------- secrets / masking
/** copy of the environment for a child process that has no use for the Steam secrets or the GitHub token */
export function envWithoutSecrets(env) {
  const out = { ...env };
  for (const n of [...SECRET_NAMES, 'GH_TOKEN', 'GITHUB_TOKEN']) delete out[n];
  return out;
}
export function missingSecrets(env) {
  return SECRET_NAMES.filter((n) => !String(env[n] || '').trim());
}

/** Returns mask(text): hides the secret values and anything that looks like a key or token. */
export function makeMasker(env = {}) {
  const values = SECRET_NAMES.map((n) => String(env[n] || '').trim()).filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
  return (text) => {
    let s = String(text);
    for (const v of values) s = s.split(v).join('***');
    return s
      .replace(/([?&](?:key|steamidkey|access_token|knowncode)=)[^&\s"']+/gi, '$1***')
      .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '***') // JWT (Steam refresh tokens)
      .replace(/\b[0-9A-F]{32}\b/gi, '***') // Web API key
      .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{5}-[A-Z0-9]{4}\b/g, '***'); // match history authentication code
  };
}

// ---------------------------------------------------------------- share codes
// CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx: 18 bytes (match id u64 LE, outcome/reservation id u64 LE,
// tv port u16 LE) as a base-57 number, least significant digit first.
const DICT = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789';
export const SHARE_RE = /^CSGO(-[ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789]{5}){5}$/;

export function isShareCode(code) {
  return SHARE_RE.test(String(code || '').trim());
}

export function decodeShareCode(code) {
  const s = String(code || '').trim();
  if (!SHARE_RE.test(s)) throw new SyncError('config', 'Это не код матча CS2 (ожидается CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx)');
  const chars = s.slice(5).replace(/-/g, '');
  let big = 0n;
  for (let i = chars.length - 1; i >= 0; i--) big = big * 57n + BigInt(DICT.indexOf(chars[i]));
  const bytes = [];
  for (let i = 0; i < 18; i++) { bytes.unshift(Number(big & 0xffn)); big >>= 8n; }
  const le = (from, n) => { let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[from + i]); return v; };
  return { matchId: le(0, 8).toString(), outcomeId: le(8, 8).toString(), token: le(16, 2).toString() };
}

export function encodeShareCode({ matchId, outcomeId, token }) {
  const bytes = [];
  const put = (v, n) => { let x = BigInt(v); for (let i = 0; i < n; i++) { bytes.push(Number(x & 0xffn)); x >>= 8n; } };
  put(matchId, 8); put(outcomeId, 8); put(token, 2);
  let big = 0n;
  for (const b of bytes) big = (big << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 25; i++) { out += DICT[Number(big % 57n)]; big /= 57n; }
  return `CSGO-${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15, 20)}-${out.slice(20)}`;
}

// ---------------------------------------------------------------- steam ids
export const accountToSteam64 = (acc) => (STEAM64_BASE + BigInt(acc >>> 0)).toString();
export const steam64ToAccount = (sid) => Number(BigInt(sid) - STEAM64_BASE);
export const isSteam64 = (s) => /^7656119\d{10}$/.test(String(s || ''));

// ---------------------------------------------------------------- Steam Web API: next share codes
const API = 'https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1/';

/**
 * Walks GetNextMatchSharingCode from `known` until "n/a". Returns { codes, more } (more = stopped at `max`).
 * Never puts the URL (it carries the key) into errors or logs.
 */
export async function nextShareCodes({ key, steamid, auth, known, fetch = globalThis.fetch, sleep = defaultSleep, max = 100, pause = 1100 }) {
  const codes = [];
  let cur = known;
  for (let i = 0; i < max; i++) {
    const url = `${API}?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamid)}&steamidkey=${encodeURIComponent(auth)}&knowncode=${encodeURIComponent(cur)}`;
    let res = null;
    let lastErr = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json' } });
      } catch (e) {
        res = null;
        lastErr = e?.name === 'TimeoutError' ? 'таймаут' : 'сеть недоступна';
      }
      if (res && res.status !== 429 && res.status < 500) break;
      if (res) lastErr = `HTTP ${res.status}`;
      await sleep(3000 * 2 ** attempt);
    }
    if (!res || res.status === 429 || res.status >= 500) throw new SyncError('net', `Steam Web API недоступен (${lastErr}) — попробую в следующий раз`);
    if (res.status === 403 || res.status === 401) {
      throw new SyncError('auth', 'Steam отклонил STEAM_API_KEY или CS2_AUTH_CODE (HTTP 403): проверьте ключ API и код аутентификации истории матчей', { fatal: true });
    }
    if (res.status === 412) {
      throw new SyncError('knowncode', 'Steam не принял известный код матча (HTTP 412): CS2_LAST_SHARECODE должен быть кодом матча этого же аккаунта', { fatal: true });
    }
    if (res.status === 202) return { codes, more: false };
    if (!res.ok) throw new SyncError('net', `Steam Web API ответил HTTP ${res.status}`);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const next = body?.result?.nextcode;
    if (!next || next === 'n/a') return { codes, more: false };
    if (!isShareCode(next)) throw new SyncError('net', 'Steam Web API вернул непонятный ответ вместо кода матча');
    if (next === cur || codes.includes(next)) return { codes, more: false };
    codes.push(next);
    cur = next;
    await sleep(pause);
  }
  return { codes, more: true };
}

function defaultSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------- game coordinator → match
/** demo links come from the GC; accept only Valve replay servers */
export function isReplayUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && /^replay\d+\.valve\.net$/i.test(u.hostname) && /\.dem(\.bz2)?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

const num = (v) => (v == null || v === '' || Number.isNaN(+v) ? 0 : +v);

/**
 * CDataGCCStrike15_v2_MatchInfo (as decoded by the `globaloffensive` package, longs as strings) →
 * compact summary for one player. Players are listed in reservation.account_ids; the first half is the
 * team of team_scores[0] (match_result 1 = that team won, 2 = the other, 0 = draw).
 */
export function parseGcMatch(info, steamid) {
  if (!info || typeof info !== 'object') return null;
  const rs = (info.roundstatsall || []).filter(Boolean);
  if (!rs.length && info.roundstats_legacy) rs.push(info.roundstats_legacy);
  if (!rs.length) return null;
  const last = rs[rs.length - 1];
  const withRes = [...rs].reverse().find((r) => r.reservation?.account_ids?.length) || last;
  const res = withRes.reservation || {};
  const ids = (res.account_ids || []).map((x) => num(x) >>> 0);
  const me = steam64ToAccount(steamid);
  const idx = ids.indexOf(me);
  const half = Math.ceil(ids.length / 2);
  const myTeam = idx < 0 ? 0 : idx < half ? 0 : 1;
  const ts = (last.team_scores || []).map(num);
  const score = ts.length >= 2 ? [ts[myTeam], ts[1 - myTeam]] : null;
  let result = null;
  if (score) result = score[0] > score[1] ? 'W' : score[0] < score[1] ? 'L' : 'T';
  else if (last.match_result != null) {
    const mr = num(last.match_result);
    result = mr === 0 ? 'T' : (mr === 1) === (myTeam === 0) ? 'W' : 'L';
  }
  const demoEntry = [...rs].reverse().find((r) => r.map && /^https?:\/\//.test(r.map));
  const at = (arr, i) => num((arr || [])[i]);
  const players = ids.map((acc, i) => ({
    sid: accountToSteam64(acc),
    name: '',
    team: (i < half ? 0 : 1) === myTeam ? 0 : 1,
    k: at(last.kills, i), d: at(last.deaths, i), a: at(last.assists, i),
    hs: at(last.enemy_headshots, i), mvp: at(last.mvps, i), score: at(last.scores, i),
  })).sort((a, b) => a.team - b.team || b.score - a.score || b.k - a.k);
  const mine = players.find((p) => p.sid === steamid);
  let rating = null;
  let mode = ids.length && ids.length <= 4 ? 'wingman' : null;
  const rk = (res.rankings || []).find((r) => num(r?.account_id) === me);
  if (rk && num(rk.rank_type_id)) {
    mode = RANK_TYPES[num(rk.rank_type_id)] || mode;
    if (num(rk.rank_id)) {
      const after = { W: num(rk.rank_if_win), L: num(rk.rank_if_lose), T: num(rk.rank_if_tie) }[result] || null;
      rating = { type: RANK_TYPES[num(rk.rank_type_id)] || String(rk.rank_type_id), before: num(rk.rank_id), after, delta: after ? after - num(rk.rank_id) : null, pred: true, wins: num(rk.wins) || null };
    }
  }
  const wmi = info.watchablematchinfo || {};
  const map = typeof wmi.game_map === 'string' && /^[a-z]{2,3}_\w+$/.test(wmi.game_map) ? wmi.game_map : null;
  return {
    id: info.matchid != null ? String(info.matchid) : null,
    date: num(info.matchtime) ? new Date(num(info.matchtime) * 1000).toISOString() : null,
    map,
    mode,
    duration: num(last.match_duration) || null,
    rounds: score ? score[0] + score[1] : num(last.round) || null,
    score,
    result,
    demoUrl: demoEntry && isReplayUrl(demoEntry.map) ? demoEntry.map : null,
    rating,
    gameType: num(res.game_type) || null,
    me: mine ? { k: mine.k, d: mine.d, a: mine.a, hs: mine.hs, mvp: mine.mvp, score: mine.score } : null,
    players,
  };
}

/** One element of matches[] (shape documented in scripts/my-matches.mjs). `demo` = output of match_stats.py or null. */
export function mergeMatch(code, gc, demo) {
  const base = {
    code,
    id: gc?.id || null,
    date: gc?.date || null,
    map: demo?.map || gc?.map || null,
    mode: (demo?.mode && demo.mode !== 'other' ? demo.mode : null) || gc?.mode || demo?.mode || 'competitive',
    duration: demo?.duration || gc?.duration || null,
  };
  if (demo) {
    const gcMe = gc?.me || {};
    const me = { ...demo.me };
    if (!me.mvp && gcMe.mvp) me.mvp = gcMe.mvp;
    if (!me.score && gcMe.score) me.score = gcMe.score;
    return {
      ...base,
      score: demo.score, result: demo.result, rounds: demo.rounds, rh: demo.rh,
      rating: demo.rating || gc?.rating || null,
      me, players: demo.players, demo: true,
    };
  }
  return {
    ...base,
    score: gc?.score || null, result: gc?.result || null, rounds: gc?.rounds || null,
    rating: gc?.rating || null,
    me: gc?.me || null, players: gc?.players || [], demo: false,
  };
}

/** insert/replace by id (or code), newest first */
export function upsertMatch(list, m) {
  const key = (x) => x.id || x.code;
  const out = list.filter((x) => key(x) !== key(m));
  out.push(m);
  out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return out;
}

/** codes still to do, oldest first: new ones need the GC, 'gc' ones only the demo */
export function pendingCodes(state, maxTries) {
  return Object.entries(state.codes || {})
    .filter(([, c]) => (c.st === 'new' || c.st === 'gc') && (c.n || 0) < maxTries)
    .map(([code]) => code);
}

export function emptyState() {
  return { v: 1, last: null, licence: false, codes: {} };
}
