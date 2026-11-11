/**
 * cs2-craft-api — live Steam profile lookups for the «Статистика» section of vsemvamdam.github.io/cs2-craft.
 *
 *   GET /api/health                       → { ok, key }
 *   GET /api/profile?id=<steamid|url|vanity>[&fresh=1]
 *                                          → summary, Steam level/XP/badges, games & playtime, CS2 hours,
 *                                            lifetime CS2 stats, bans, friends, ladder ranks (cached 5 min)
 *   GET /api/inventory?id=<steamid>        → CS2 inventory grouped by market name (cached 30 min)
 *   GET /api/ladder?by=xp|level|games|playtime|cs2|badges|age&country=RU&limit=50&offset=0
 *   GET /api/history?id=<steamid>          → daily snapshots [day, level, xp, games, playtime, cs2]
 *   GET /api/faceit?id=<steamid>           → FACEIT profile of that Steam account: level, ELO, CS2 / CS:GO lifetime
 *                                            stats, last 20 results (official FACEIT Data API, cached 10 min)
 *   GET /api/servers                       → «Дуэли»: every Cybershoke CS2 server (mode, map, location, players,
 *                                            ip:port) packed into short rows (cached 20 s, see servers.ts)
 *   POST /api/servers/push                 ← the relay on a VPS in Finland sends the full list (only from RELAY_IPS)
 *
 * Every profile that is looked up joins the ladder (D1 table `profiles`); the cron trigger refreshes the
 * stalest ones every 10 minutes, so levels and game counts stay current. The Steam Web API key is a Worker
 * secret (STEAM_API_KEY) and never leaves the server.
 */
import { CYBERSHOKE_API, slimCybershoke, type ServersPayload } from './servers';

export interface Env {
  DB: D1Database;
  STEAM_API_KEY: string;
  FACEIT_API_KEY?: string;
  /** IPs allowed to POST /api/servers/push (the Cybershoke relay), comma-separated — wrangler.toml [vars] */
  RELAY_IPS?: string;
}

const API = 'https://api.steampowered.com';
const PROFILE_TTL = 300; // seconds a profile response is cached
const INVENTORY_TTL = 1800;
const STALE_AFTER = 3 * 3600; // cron refreshes profiles not updated for this long
const CRON_BATCH = 15; // profiles per cron run (2 Steam calls each + 1 batched summary call; free plan allows 50 subrequests)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(data: unknown, status = 200, maxAge = 0): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store', ...CORS },
  });
}

async function steam<T>(env: Env, path: string, params: Record<string, string | number>): Promise<T | null> {
  const u = new URL(API + path);
  u.searchParams.set('key', env.STEAM_API_KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u.toString(), { headers: { Accept: 'application/json' }, cf: { cacheTtl: 0 } });
  if (r.status === 401 || r.status === 403) return null; // private profile / friends list etc.
  if (r.status === 429) throw new HttpError(503, 'Steam ограничил частоту запросов, попробуйте через минуту');
  if (!r.ok) throw new HttpError(502, `Steam API ${path}: ${r.status}`);
  return (await r.json()) as T;
}

// ---------------------------------------------------------------------------
// ids
const BASE64 = 76561197960265728n;
export function parseInput(raw: string): { steamid?: string; vanity?: string } {
  const s = decodeURIComponent(raw || '').trim();
  if (!s) return {};
  let m = s.match(/(?:^|\D)(7656119\d{10})(?:\D|$)/); // bare id or any link containing it (Steam, tracker.gg, csst.at…)
  if (m) return { steamid: m[1] };
  m = s.match(/^\[?U:1:(\d+)\]?$/i);
  if (m) return { steamid: (BigInt(m[1]) + BASE64).toString() };
  m = s.match(/^STEAM_[0-5]:([01]):(\d+)$/i);
  if (m) return { steamid: (BigInt(m[2]) * 2n + BigInt(m[1]) + BASE64).toString() };
  m = s.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
  if (m) return { vanity: m[1] };
  if (/^[A-Za-z0-9_-]{2,32}$/.test(s)) return { vanity: s };
  return {};
}

async function resolve(env: Env, raw: string): Promise<string> {
  const p = parseInput(raw);
  if (p.steamid) return p.steamid;
  if (!p.vanity) throw new HttpError(400, 'Не похоже на ссылку на профиль Steam или SteamID');
  const r = await steam<{ response: { success: number; steamid?: string } }>(env, '/ISteamUser/ResolveVanityURL/v1/', { vanityurl: p.vanity });
  if (!r?.response?.steamid) throw new HttpError(404, 'Профиль не найден');
  return r.response.steamid;
}

// ---------------------------------------------------------------------------
type Summary = { steamid: string; personaname: string; profileurl: string; avatarfull: string; communityvisibilitystate: number; profilestate?: number; personastate: number; timecreated?: number; loccountrycode?: string; lastlogoff?: number; gameextrainfo?: string; gameid?: string };
type Badges = { response: { badges?: unknown[]; player_xp?: number; player_level?: number; player_xp_needed_to_level_up?: number; player_xp_needed_current_level?: number } };
type Game = { appid: number; name?: string; playtime_forever: number; playtime_2weeks?: number; rtime_last_played?: number; img_icon_url?: string };
type Owned = { response: { game_count?: number; games?: Game[] } };

async function summaries(env: Env, ids: string[]): Promise<Summary[]> {
  if (!ids.length) return [];
  const r = await steam<{ response: { players: Summary[] } }>(env, '/ISteamUser/GetPlayerSummaries/v2/', { steamids: ids.join(',') });
  return r?.response?.players || [];
}
const owned = (env: Env, steamid: string, info: boolean) =>
  steam<Owned>(env, '/IPlayerService/GetOwnedGames/v1/', { steamid, include_appinfo: info ? 1 : 0, include_played_free_games: 1, skip_unvetted_apps: 0 });
const badges = (env: Env, steamid: string) => steam<Badges>(env, '/IPlayerService/GetBadges/v1/', { steamid });

function gameTotals(o: Owned | null) {
  const games = o?.response?.games;
  if (!games) return null;
  let playtime = 0, played = 0, cs2: Game | undefined;
  for (const g of games) {
    playtime += g.playtime_forever || 0;
    if (g.playtime_forever > 0) played++;
    if (g.appid === 730) cs2 = g;
  }
  return { count: o!.response.game_count ?? games.length, playtime, played, cs2 };
}

async function saveLadder(env: Env, s: Summary, b: Badges | null, t: ReturnType<typeof gameTotals>, vac: number | null, now: number) {
  const r = b?.response;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO profiles (steamid, name, avatar, country, level, xp, badges, games, playtime, cs2, cs2_2w, created, vac, visible, updated, added)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
      ON CONFLICT(steamid) DO UPDATE SET name=?2, avatar=?3, country=?4, level=COALESCE(?5, level), xp=COALESCE(?6, xp), badges=COALESCE(?7, badges),
        games=COALESCE(?8, games), playtime=COALESCE(?9, playtime), cs2=COALESCE(?10, cs2), cs2_2w=COALESCE(?11, cs2_2w), created=COALESCE(?12, created),
        vac=COALESCE(?13, vac), visible=?14, updated=?15`).bind(
      s.steamid, s.personaname, s.avatarfull, s.loccountrycode || null, r?.player_level ?? null, r?.player_xp ?? null, r?.badges?.length ?? null,
      t?.count ?? null, t?.playtime ?? null, t?.cs2?.playtime_forever ?? (t ? 0 : null), t?.cs2?.playtime_2weeks ?? (t ? 0 : null), s.timecreated || null,
      vac, s.communityvisibilitystate === 3 ? 1 : 0, now),
    env.DB.prepare(`INSERT OR REPLACE INTO history (steamid, day, level, xp, games, playtime, cs2) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`).bind(
      s.steamid, Math.floor(now / 86400), r?.player_level ?? null, r?.player_xp ?? null, t?.count ?? null, t?.playtime ?? null, t?.cs2?.playtime_forever ?? null),
  ]);
}

const LADDER: Record<string, { col: string; dir: 'DESC' | 'ASC' }> = {
  xp: { col: 'xp', dir: 'DESC' }, level: { col: 'xp', dir: 'DESC' }, games: { col: 'games', dir: 'DESC' },
  playtime: { col: 'playtime', dir: 'DESC' }, cs2: { col: 'cs2', dir: 'DESC' }, badges: { col: 'badges', dir: 'DESC' }, age: { col: 'created', dir: 'ASC' },
};

async function ranks(env: Env, steamid: string) {
  const row = await env.DB.prepare('SELECT xp, games, playtime, cs2, badges, created FROM profiles WHERE steamid = ?').bind(steamid).first<Record<string, number | null>>();
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM profiles').first<{ n: number }>())?.n || 0;
  if (!row) return { total };
  const out: Record<string, number | null> = { total };
  const q = (col: string, cmp: string, v: number | null) => (v == null ? Promise.resolve(null) : env.DB.prepare(`SELECT COUNT(*) + 1 AS n FROM profiles WHERE ${col} ${cmp} ?`).bind(v).first<{ n: number }>().then((r) => r?.n ?? null));
  const [xp, games, playtime, cs2, badgesR, age] = await Promise.all([
    q('xp', '>', row.xp), q('games', '>', row.games), q('playtime', '>', row.playtime), q('cs2', '>', row.cs2), q('badges', '>', row.badges), q('created', '<', row.created),
  ]);
  Object.assign(out, { xp, games, playtime, cs2, badges: badgesR, age });
  return out;
}

async function profile(env: Env, raw: string, ctx: ExecutionContext, fresh: boolean): Promise<Response> {
  const steamid = await resolve(env, raw);
  const cache = caches.default;
  const key = new Request(`https://cache.cs2-craft/profile/${steamid}`);
  if (!fresh) {
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), ...CORS, 'X-Cache': 'HIT' } });
  }
  const now = Math.floor(Date.now() / 1000);
  const [sum, b, o, stats, bans, friends] = await Promise.all([
    summaries(env, [steamid]),
    badges(env, steamid),
    owned(env, steamid, true),
    steam<{ playerstats?: { stats?: { name: string; value: number }[]; achievements?: { name: string; achieved: number }[] } }>(env, '/ISteamUserStats/GetUserStatsForGame/v2/', { appid: 730, steamid }).catch(() => null),
    steam<{ players: { CommunityBanned: boolean; VACBanned: boolean; NumberOfVACBans: number; DaysSinceLastBan: number; NumberOfGameBans: number; EconomyBan: string }[] }>(env, '/ISteamUser/GetPlayerBans/v1/', { steamids: steamid }).catch(() => null),
    steam<{ friendslist?: { friends: unknown[] } }>(env, '/ISteamUser/GetFriendList/v1/', { steamid, relationship: 'friend' }).catch(() => null),
  ]);
  const s = sum[0];
  if (!s) throw new HttpError(404, 'Профиль не найден');
  const t = gameTotals(o);
  const games = o?.response?.games || [];
  const top = [...games].sort((a, b2) => b2.playtime_forever - a.playtime_forever).slice(0, 40)
    .map((g) => ({ a: g.appid, n: g.name || String(g.appid), m: g.playtime_forever, m2: g.playtime_2weeks || 0, last: g.rtime_last_played || 0 }));
  const recent = games.filter((g) => g.playtime_2weeks).sort((a, b2) => (b2.playtime_2weeks || 0) - (a.playtime_2weeks || 0)).slice(0, 10)
    .map((g) => ({ a: g.appid, n: g.name || String(g.appid), m: g.playtime_forever, m2: g.playtime_2weeks || 0 }));
  const ban = bans?.players?.[0];
  const r = b?.response;
  const statMap = stats?.playerstats?.stats ? Object.fromEntries(stats.playerstats.stats.map((x) => [x.name, x.value])) : null;
  await saveLadder(env, s, b, t, ban ? ban.NumberOfVACBans + ban.NumberOfGameBans : null, now);
  const data = {
    steamid, name: s.personaname, avatar: s.avatarfull, url: s.profileurl, country: s.loccountrycode || null,
    created: s.timecreated || null, public: s.communityvisibilitystate === 3, state: s.personastate, lastlogoff: s.lastlogoff || null,
    ingame: s.gameextrainfo || null,
    level: r?.player_level ?? null, xp: r?.player_xp ?? null, xpNext: r?.player_xp_needed_to_level_up ?? null, xpCur: r?.player_xp_needed_current_level ?? null,
    badges: r?.badges ? r.badges.length : null,
    games: t ? { count: t.count, playtime: t.playtime, played: t.played, top, recent } : null,
    cs2: t?.cs2 ? { m: t.cs2.playtime_forever, m2: t.cs2.playtime_2weeks || 0, last: t.cs2.rtime_last_played || 0 } : null,
    stats: statMap,
    achievements: stats?.playerstats?.achievements ? stats.playerstats.achievements.filter((a) => a.achieved).length : null,
    bans: ban ? { vac: ban.NumberOfVACBans, game: ban.NumberOfGameBans, days: ban.DaysSinceLastBan, community: ban.CommunityBanned, economy: ban.EconomyBan !== 'none' } : null,
    friends: friends?.friendslist ? friends.friendslist.friends.length : null,
    ranks: await ranks(env, steamid),
    fetched: now,
  };
  const res = json(data, 200, PROFILE_TTL);
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

type InvAsset = { classid: string; instanceid: string; amount: string };
type InvDesc = { classid: string; instanceid: string; market_hash_name: string; name: string; icon_url: string; tradable: number; marketable: number; type?: string; name_color?: string };
async function inventory(env: Env, raw: string, ctx: ExecutionContext): Promise<Response> {
  const steamid = await resolve(env, raw);
  const cache = caches.default;
  const key = new Request(`https://cache.cs2-craft/inventory/${steamid}`);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), ...CORS, 'X-Cache': 'HIT' } });
  const items = new Map<string, { n: string; c: number; i: string; t: number; m: number; col?: string; type?: string }>();
  let start = '';
  let total = 0;
  for (let page = 0; page < 3; page++) {
    const u = `https://steamcommunity.com/inventory/${steamid}/730/2?l=english&count=2000${start ? `&start_assetid=${start}` : ''}`;
    const r = await fetch(u, { headers: { Accept: 'application/json', 'User-Agent': 'cs2-craft (+https://github.com/vsemvamdam/cs2-craft)' } });
    if (r.status === 403 || r.status === 401) return json({ steamid, private: true, items: [] }, 200, 600);
    if (r.status === 429) throw new HttpError(503, 'Steam временно ограничил загрузку инвентарей, попробуйте позже');
    if (!r.ok) throw new HttpError(502, `Инвентарь: Steam ответил ${r.status}`);
    const d = (await r.json()) as { assets?: InvAsset[]; descriptions?: InvDesc[]; total_inventory_count?: number; more_items?: number; last_assetid?: string } | null;
    if (!d?.assets) break;
    total = d.total_inventory_count || total;
    const desc = new Map((d.descriptions || []).map((x) => [x.classid + '_' + x.instanceid, x]));
    for (const a of d.assets) {
      const x = desc.get(a.classid + '_' + a.instanceid);
      if (!x) continue;
      const e = items.get(x.market_hash_name);
      if (e) e.c += +a.amount || 1;
      else items.set(x.market_hash_name, { n: x.market_hash_name, c: +a.amount || 1, i: x.icon_url, t: x.tradable, m: x.marketable, col: x.name_color, type: x.type });
    }
    if (!d.more_items || !d.last_assetid) break;
    start = d.last_assetid;
  }
  const res = json({ steamid, private: false, total, items: [...items.values()], fetched: Math.floor(Date.now() / 1000) }, 200, INVENTORY_TTL);
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// ---------------------------------------------------------------------------
// FACEIT (official Data API, server key = Worker secret FACEIT_API_KEY)
const FACEIT = 'https://open.faceit.com/data/v4';
const FACEIT_TTL = 600;
async function fc<T>(env: Env, path: string): Promise<T | null> {
  const r = await fetch(FACEIT + path, { headers: { Authorization: `Bearer ${env.FACEIT_API_KEY}`, Accept: 'application/json' } });
  if (r.status === 404) return null;
  if (r.status === 429) throw new HttpError(503, 'FACEIT ограничил частоту запросов, попробуйте через минуту');
  if (r.status === 401 || r.status === 403) throw new HttpError(503, 'Ключ FACEIT API не подходит');
  if (!r.ok) throw new HttpError(502, `FACEIT API: ${r.status}`);
  return (await r.json()) as T;
}
type FcGame = { faceit_elo?: number; skill_level?: number; region?: string; game_player_name?: string };
type FcPlayer = { player_id: string; nickname: string; avatar?: string; country?: string; cover_image?: string; activated_at?: string; memberships?: string[]; verified?: boolean; faceit_url?: string; games?: Record<string, FcGame> };
type FcStats = { lifetime?: Record<string, unknown>; segments?: { label: string; mode: string; type: string; stats: Record<string, string> }[] };
type FcHistory = { items?: { match_id: string; finished_at?: number; started_at?: number; game_mode?: string; competition_name?: string; results?: { winner?: string; score?: Record<string, number> }; teams?: Record<string, { players?: { player_id: string }[] }> }[] };
// lifetime keys we show (FACEIT sends them as strings; CS2 and CS:GO have different sets)
const FC_KEYS = ['Matches', 'Wins', 'Win Rate %', 'Average K/D Ratio', 'Average Headshots %', 'ADR', 'Longest Win Streak', 'Current Win Streak',
  'Recent Results', '1v1 Win Rate', '1v2 Win Rate', 'Entry Success Rate', 'Utility Damage per Round', 'Flash Success Rate', 'Sniper Kill Rate', 'Total Matches'];

async function faceit(env: Env, raw: string, ctx: ExecutionContext): Promise<Response> {
  if (!env.FACEIT_API_KEY) throw new HttpError(503, 'Ключ FACEIT API не настроен');
  const steamid = await resolve(env, raw);
  const cache = caches.default;
  const key = new Request(`https://cache.cs2-craft/faceit/${steamid}`);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), ...CORS, 'X-Cache': 'HIT' } });
  // the same Steam account can be linked to CS2 and/or CS:GO on FACEIT
  const p = (await fc<FcPlayer>(env, `/players?game=cs2&game_player_id=${steamid}`)) || (await fc<FcPlayer>(env, `/players?game=csgo&game_player_id=${steamid}`));
  if (!p) {
    const res = json({ steamid, found: false }, 200, FACEIT_TTL);
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }
  const games = ['cs2', 'csgo'].filter((g) => p.games?.[g]);
  const [stats, hist] = await Promise.all([
    Promise.all(games.map((g) => fc<FcStats>(env, `/players/${p.player_id}/stats/${g}`).catch(() => null))),
    games.includes('cs2') ? fc<FcHistory>(env, `/players/${p.player_id}/history?game=cs2&limit=20`).catch(() => null) : Promise.resolve(null),
  ]);
  const out: Record<string, unknown> = {
    steamid, found: true, id: p.player_id, nick: p.nickname, avatar: p.avatar || null, country: p.country || null,
    url: (p.faceit_url || `https://www.faceit.com/{lang}/players/${p.nickname}`).replace('{lang}', 'ru'),
    premium: (p.memberships || []).some((m) => m !== 'free'), verified: !!p.verified, created: p.activated_at || null,
    games: {} as Record<string, unknown>,
  };
  games.forEach((g, i) => {
    const gi = p.games![g];
    const life = stats[i]?.lifetime || {};
    const lt: Record<string, unknown> = {};
    for (const k of FC_KEYS) if (life[k] != null && life[k] !== '') lt[k] = life[k];
    // per-map results (5v5 only)
    const maps = (stats[i]?.segments || []).filter((s) => s.type === 'Map' && /5v5/.test(s.mode)).map((s) => ({
      map: s.label, m: +s.stats['Matches'] || 0, wr: +s.stats['Win Rate %'] || 0, kd: +s.stats['Average K/D Ratio'] || 0,
    })).filter((x) => x.m > 0).sort((a, b) => b.m - a.m).slice(0, 10);
    (out.games as Record<string, unknown>)[g] = { elo: gi.faceit_elo ?? null, level: gi.skill_level ?? null, region: gi.region || null, life: lt, maps };
  });
  if (hist?.items?.length) {
    out.recent = hist.items.map((m) => {
      const side = Object.entries(m.teams || {}).find(([, t]) => t.players?.some((x) => x.player_id === p.player_id))?.[0];
      return { id: m.match_id, at: m.finished_at || m.started_at || null, win: side && m.results?.winner ? m.results.winner === side : null, mode: m.game_mode || '', comp: m.competition_name || '' };
    });
  }
  const res = json(out, 200, FACEIT_TTL);
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// ---------------------------------------------------------------------------
// «Дуэли»: Cybershoke server list (their API allows only their own origin, so the site gets it through here).
// Cybershoke picks the servers it lists by the requester's country, and a Worker gets only part of them (no Moscow,
// Kazakhstan…). So a tiny relay on a VPS in Finland (tools/cybershoke-relay) posts the full list here every 30 s;
// the Worker's own request is the fallback while the relay is silent.
const SERVERS_TTL = 20; // seconds a list is served from memory
const RELAY_FRESH = 120; // a relayed list younger than this wins over our own (partial) request
const SERVERS_STALE = 3600; // serve the last good list this long if nothing fresh can be had
let srvMem: { at: number; data: ServersPayload } | null = null; // per-isolate copy (the Cache API is a no-op on *.workers.dev)
let srvPending: Promise<ServersPayload> | null = null; // one upstream request at a time

async function loadServers(): Promise<ServersPayload> {
  const r = await fetch(CYBERSHOKE_API, {
    headers: { Accept: 'application/json', 'User-Agent': 'cs2-craft server list (+https://github.com/vsemvamdam/cs2-craft)', Referer: 'https://cybershoke.net/' },
    cf: { cacheTtl: 0 },
  });
  if (!r.ok) throw new HttpError(502, `Cybershoke ответил ${r.status}`);
  if (!(r.headers.get('content-type') || '').includes('json')) throw new HttpError(502, 'Cybershoke не отдал список серверов');
  const data = slimCybershoke(await r.json(), Math.floor(Date.now() / 1000));
  if (!data.list.length) throw new HttpError(502, 'В ответе Cybershoke нет серверов CS2');
  return { ...data, partial: true };
}

async function relayed(env: Env): Promise<ServersPayload | null> {
  try {
    const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind('servers').first<{ v: string }>();
    return row ? (JSON.parse(row.v) as ServersPayload) : null;
  } catch {
    return null; // table not created yet
  }
}

async function servers(env: Env): Promise<Response> {
  const now = Date.now();
  if (srvMem && now - srvMem.at < SERVERS_TTL * 1000) return json(srvMem.data, 200, SERVERS_TTL);
  const relay = await relayed(env);
  const age = (d: ServersPayload | null) => (d ? now / 1000 - d.fetched : Infinity);
  if (relay && age(relay) < RELAY_FRESH) {
    srvMem = { at: now, data: relay };
    return json(relay, 200, SERVERS_TTL);
  }
  try {
    srvPending ||= loadServers().finally(() => { srvPending = null; });
    const data = await srvPending;
    srvMem = { at: Date.now(), data };
    return json(data, 200, SERVERS_TTL);
  } catch (e) {
    const last = [relay, srvMem?.data || null].filter((d): d is ServersPayload => !!d && age(d) < SERVERS_STALE).sort((a, b) => b.fetched - a.fetched)[0];
    if (last) return json({ ...last, stale: true }, 200, 10);
    throw e instanceof HttpError ? e : new HttpError(502, 'Не удалось получить список серверов Cybershoke');
  }
}

/** POST /api/servers/push — the relay sends Cybershoke's raw main/data (gzip). Accepted only from RELAY_IPS. */
async function pushServers(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const allowed = (env.RELAY_IPS || '').split(/[\s,]+/).filter(Boolean);
  if (!ip || !allowed.includes(ip)) throw new HttpError(403, 'Этот адрес не может присылать список');
  if (!req.body) throw new HttpError(400, 'Пустой запрос');
  const body = /gzip/i.test(req.headers.get('Content-Type') || '') ? req.body.pipeThrough(new DecompressionStream('gzip')) : req.body;
  let raw: unknown;
  try { raw = await new Response(body).json(); } catch { throw new HttpError(400, 'Это не JSON'); }
  const data: ServersPayload = { ...slimCybershoke(raw, Math.floor(Date.now() / 1000)), relay: true };
  if (!data.list.length) throw new HttpError(400, 'В списке нет серверов CS2');
  await env.DB.prepare('INSERT INTO kv (k, v, at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = ?2, at = ?3')
    .bind('servers', JSON.stringify(data), data.fetched).run();
  srvMem = { at: Date.now(), data };
  return json({ ok: true, servers: data.servers, players: data.players });
}

async function ladder(env: Env, url: URL): Promise<Response> {
  const by = LADDER[url.searchParams.get('by') || 'xp'] || LADDER.xp;
  const limit = Math.min(100, Math.max(1, +(url.searchParams.get('limit') || 50)));
  const offset = Math.max(0, +(url.searchParams.get('offset') || 0));
  const country = (url.searchParams.get('country') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
  const where = `${by.col} IS NOT NULL${country ? ' AND country = ?1' : ''}`;
  const stmt = env.DB.prepare(`SELECT steamid, name, avatar, country, level, xp, badges, games, playtime, cs2, cs2_2w, created, vac, updated FROM profiles WHERE ${where} ORDER BY ${by.col} ${by.dir} LIMIT ${limit} OFFSET ${offset}`);
  const cnt = env.DB.prepare(`SELECT COUNT(*) AS n FROM profiles WHERE ${where}`);
  const [rows, n] = await Promise.all([(country ? stmt.bind(country) : stmt).all(), (country ? cnt.bind(country) : cnt).first<{ n: number }>()]);
  const countries = await env.DB.prepare('SELECT country, COUNT(*) AS n FROM profiles WHERE country IS NOT NULL GROUP BY country ORDER BY n DESC LIMIT 60').all();
  return json({ by: url.searchParams.get('by') || 'xp', total: n?.n || 0, offset, rows: rows.results, countries: countries.results }, 200, 60);
}

async function history(env: Env, raw: string): Promise<Response> {
  const steamid = await resolve(env, raw);
  const r = await env.DB.prepare('SELECT day, level, xp, games, playtime, cs2 FROM history WHERE steamid = ? ORDER BY day').bind(steamid).all<Record<string, number>>();
  return json({ steamid, rows: r.results.map((x) => [x.day, x.level, x.xp, x.games, x.playtime, x.cs2]) }, 200, 300);
}

/** cron: keep the ladder fresh — refresh the profiles that were updated longest ago */
async function refresh(env: Env) {
  const now = Math.floor(Date.now() / 1000);
  const stale = await env.DB.prepare('SELECT steamid FROM profiles WHERE updated < ? ORDER BY updated ASC LIMIT ?').bind(now - STALE_AFTER, CRON_BATCH).all<{ steamid: string }>();
  const ids = stale.results.map((r) => r.steamid);
  if (!ids.length) return;
  const sums = new Map((await summaries(env, ids)).map((s) => [s.steamid, s]));
  for (const id of ids) {
    const s = sums.get(id);
    if (!s) { await env.DB.prepare('UPDATE profiles SET updated = ? WHERE steamid = ?').bind(now, id).run(); continue; }
    try {
      const [b, o] = await Promise.all([badges(env, id), owned(env, id, false)]);
      await saveLadder(env, s, b, gameTotals(o), null, now);
    } catch {
      await env.DB.prepare('UPDATE profiles SET updated = ? WHERE steamid = ?').bind(now, id).run();
    }
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const isPush = req.method === 'POST' && url.pathname === '/api/servers/push';
    if (req.method !== 'GET' && !isPush) return json({ error: 'Только GET' }, 405);
    try {
      if (isPush) return await pushServers(req, env);
      if (url.pathname === '/api/servers') return await servers(env); // needs no keys
      if (!env.STEAM_API_KEY && url.pathname !== '/api/health') throw new HttpError(503, 'Ключ Steam API не настроен');
      switch (url.pathname) {
        case '/api/health': return json({ ok: true, key: !!env.STEAM_API_KEY, faceit: !!env.FACEIT_API_KEY });
        case '/api/faceit': return await faceit(env, url.searchParams.get('id') || '', ctx);
        case '/api/profile': return await profile(env, url.searchParams.get('id') || '', ctx, url.searchParams.get('fresh') === '1');
        case '/api/inventory': return await inventory(env, url.searchParams.get('id') || '', ctx);
        case '/api/ladder': return await ladder(env, url);
        case '/api/history': return await history(env, url.searchParams.get('id') || '');
        default: return json({ error: 'Нет такого адреса', endpoints: ['/api/profile?id=', '/api/inventory?id=', '/api/ladder?by=xp', '/api/history?id=', '/api/servers'] }, 404);
      }
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      return json({ error: 'Внутренняя ошибка' }, 500);
    }
  },
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (env.STEAM_API_KEY) ctx.waitUntil(refresh(env));
  },
} satisfies ExportedHandler<Env>;
