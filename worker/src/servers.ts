/**
 * «Дуэли»: live list of Cybershoke CS2 community servers.
 *
 * Cybershoke's own site loads https://cybershoke.net/api/api/v2/main/data (one ~800 KB JSON with every server of
 * CS:GO, CS2 and Rust plus a lot of site config). Their API only allows their own origin (CORS), so the Worker
 * fetches it, keeps CS2 only, packs every server into a short row and serves it to the site with CORS.
 */

/** one server as Cybershoke sends it (fields we use) */
type RawServer = {
  ip: string; port: number; mode: string; num: number; location: string; map: string;
  players: number; maxplayers: number; category?: string; name_alt?: string | null; faceit_avg?: number;
};
type RawMode = { mode?: string; name?: string; label?: string | null; maplist?: string[]; categories?: Record<string, unknown> };
type RawLocation = { location: string; country?: string; city?: string; region?: string };

/** ip, port, mode, number, location id, map, players, max players, category, Cybershoke's name, avg FACEIT level */
export type Row = [string, number, string, number, string, string, number, number, string, string, number];
export type ModeInfo = { id: string; name: string; label: string | null; players: number; servers: number; cats: string[] };
export type ServersPayload = {
  source: string;
  fetched: number;
  players: number;
  servers: number;
  modes: ModeInfo[];
  /** location id → [country code, city, region] */
  locations: Record<string, [string, string, string]>;
  list: Row[];
  stale?: boolean;
};

export const CYBERSHOKE_API = 'https://cybershoke.net/api/api/v2/main/data';
export const CYBERSHOKE_SITE = 'https://cybershoke.net/ru/cs2';
/** id_games of CS2 in Cybershoke's data (1 — CS:GO, 3 — Rust) */
const CS2 = '2';

const isServer = (x: unknown): x is RawServer => {
  const s = x as RawServer;
  return !!s && typeof s.ip === 'string' && /^[\d.]+$/.test(s.ip) && Number.isInteger(s.port) && s.port > 0 && s.port < 65536 && typeof s.mode === 'string';
};

export function slimCybershoke(raw: unknown, now: number): ServersPayload {
  const mods = (raw as { data?: { modules?: Record<string, { data?: unknown }> } })?.data?.modules || {};
  const sd = (mods.servers?.data || {}) as { servers?: Record<string, Record<string, Record<string, unknown[]>>>; modes?: Record<string, Record<string, RawMode>> };
  const byMode = sd.servers?.[CS2] || {};
  const meta = sd.modes?.[CS2] || {};
  const list: Row[] = [];
  const seen = new Set<string>();
  const modes: ModeInfo[] = [];
  for (const [mode, cats] of Object.entries(byMode)) {
    if (!cats || typeof cats !== 'object') continue;
    let players = 0, servers = 0;
    const catNames = new Set<string>();
    for (const [cat, arr] of Object.entries(cats)) {
      if (!Array.isArray(arr)) continue;
      for (const s of arr) {
        if (!isServer(s)) continue;
        const key = s.ip + ':' + s.port;
        if (seen.has(key)) continue;
        seen.add(key);
        const c = String(s.category ?? cat ?? '');
        if (c) catNames.add(c);
        const p = Math.max(0, +s.players || 0), max = Math.max(0, +s.maxplayers || 0);
        players += p;
        servers++;
        list.push([s.ip, s.port, mode, +s.num || 0, String(s.location || ''), String(s.map || ''), p, max, c, s.name_alt ? String(s.name_alt) : '', +(s.faceit_avg || 0)]);
      }
    }
    if (!servers) continue;
    const m = meta[mode] || {};
    modes.push({ id: mode, name: String(m.name || mode), label: m.label ? String(m.label) : null, players, servers, cats: [...catNames] });
  }
  modes.sort((a, b) => b.players - a.players || b.servers - a.servers);
  const locations: Record<string, [string, string, string]> = {};
  const locs = mods.servers_locations?.data;
  if (Array.isArray(locs)) {
    for (const l of locs as RawLocation[]) if (l?.location) locations[l.location] = [String(l.country || '').toLowerCase(), String(l.city || l.location), String(l.region || '')];
  }
  for (const r of list) if (r[4] && !locations[r[4]]) locations[r[4]] = ['', r[4], ''];
  return {
    source: CYBERSHOKE_SITE,
    fetched: now,
    players: modes.reduce((a, m) => a + m.players, 0),
    servers: list.length,
    modes,
    locations,
    list,
  };
}
