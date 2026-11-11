/** «Дуэли»: Cybershoke CS2 servers served by the Worker (/api/servers, see worker/src/servers.ts) */

export type Row = [string, number, string, number, string, string, number, number, string, string, number];
export type ModeInfo = { id: string; name: string; label: string | null; players: number; servers: number; cats: string[] };
export type ServersPayload = {
  source: string; fetched: number; players: number; servers: number; modes: ModeInfo[];
  locations: Record<string, [string, string, string]>; list: Row[]; stale?: boolean; partial?: boolean; relay?: boolean;
};
export type Srv = {
  key: string; ip: string; port: number; mode: string; num: number; loc: string; map: string;
  players: number; max: number; free: number; cat: string; name: string; faceit: number;
};

export const toSrv = (r: Row): Srv => ({
  key: r[0] + ':' + r[1], ip: r[0], port: r[1], mode: r[2], num: r[3], loc: r[4], map: r[5],
  players: r[6], max: r[7], free: Math.max(0, r[7] - r[6]), cat: r[8], name: r[9], faceit: r[10],
});

/** launches CS2 through Steam and connects right away (same link Cybershoke uses) */
export const connectUrl = (s: { ip: string; port: number }) => `steam://rungameid/730//+connect%20${s.ip}:${s.port}`;
/** for the CS2 console (~) */
export const connectCmd = (s: { ip: string; port: number }) => `connect ${s.ip}:${s.port}`;

// ---------------------------------------------------------------------------
// modes
export type Group = 'duels' | 'aim' | 'tactics' | 'movement' | 'fun' | 'other';
export const GROUPS: { id: Group; ru: string }[] = [
  { id: 'duels', ru: 'Дуэли' },
  { id: 'aim', ru: 'Стрельба' },
  { id: 'tactics', ru: 'Тактика и матчи' },
  { id: 'movement', ru: 'Мувмент' },
  { id: 'fun', ru: 'Развлечения' },
  { id: 'other', ru: 'Другое' },
];
const M = (ru: string, group: Group, d = '') => ({ ru, group, d });
export const MODES: Record<string, { ru: string; group: Group; d: string }> = {
  DUELS: M('Дуэли 1×1', 'duels', 'Один на один на картах соревновательного режима: после каждой дуэли — новый соперник, оружие выбираешь сам.'),
  ARENA: M('Арена 1×1', 'duels', 'Мульти-арены: все дерутся один на один на своих аренах, победитель поднимается выше, проигравший опускается.'),
  DUELS2X2: M('Дуэли 2×2', 'duels', 'Дуэли двое на двое на картах соревновательного режима — удобно заходить вдвоём с другом.'),
  DM: M('DM', 'aim', 'Классический дезматч: мгновенное возрождение и любое оружие — разминка перед матчем.'),
  HSDM: M('HS DM', 'aim', 'Дезматч, где урон проходит только в голову.'),
  PISTOLDM: M('Пистолетный DM', 'aim', 'Дезматч только с пистолетами.'),
  AWPDM: M('AWP DM', 'aim', 'Дезматч только с AWP.'),
  AIMDM: M('Aim DM', 'aim', 'Дезматч на аим-картах: короткие дистанции, быстрые размены.'),
  MULTICFGDM: M('Multi-CFG DM', 'aim', 'Дезматч с разными наборами оружия по раундам.'),
  AWP: M('AWP', 'aim', 'Снайперские карты: AWP Lego, AWP Cannons.'),
  RETAKE: M('Ретейки', 'tactics', 'Короткие раунды: защита заходит на уже заложенную бомбу, атака её держит.'),
  PISTOLRETAKE: M('Пистолетные ретейки', 'tactics', 'Ретейки, где есть только пистолеты.'),
  RETAKECARDS: M('Retake Cards', 'tactics', 'Ретейки с картами-бонусами.'),
  EXECUTE: M('Execute', 'tactics', 'Отработка выходов на плент с раскидкой гранат.'),
  CLUTCH: M('Клатчи', 'tactics', 'Раунды в меньшинстве: 1 против 3, 2 против 5.'),
  '5X5': M('5×5', 'tactics', 'Полноценные матчи пять на пять, как в Premier.'),
  '2X2': M('Напарники 2×2', 'tactics', 'Матчи в режиме «Напарники» на картах wingman.'),
  PUBLIC: M('Паблик', 'tactics', 'Обычный паблик: Dust2, Mirage и другие карты, иногда с событиями.'),
  BHOP: M('Bhop', 'movement', 'Карты на распрыжку разной сложности.'),
  SURF: M('Surf', 'movement', 'Сёрф-карты разной сложности.'),
  SURFCOMBAT: M('Surf Combat', 'movement', 'Сёрф с перестрелками команда на команду.'),
  KZ: M('KZ', 'movement', 'Паркур-карты (climb) по тирам сложности.'),
  KNIFE: M('Ножи', 'fun', 'Бои на ножах.'),
  HNS: M('HNS', 'fun', 'Прятки: террористы прячутся, спецназ ищет.'),
  JAIL: M('Jail', 'fun', 'Тюрьма: заключённые пытаются сбежать от охраны.'),
  MANIAC: M('Маньяк', 'fun', 'Маньяки ищут, остальные прячутся и пытаются выжить.'),
  DEATHRUN: M('Deathrun', 'fun', 'Пройди карту и не попадись в ловушки.'),
  MINIGAMES: M('Мини-игры', 'fun', 'Футбол, гонки и другие мини-игры.'),
  LOUNGE: M('Skin Inspect', 'fun', 'Сервер, где можно посмотреть любые скины в игре.'),
  RUSH: M('Rush', 'fun'),
};
export const modeRu = (id: string, fallback?: string) => MODES[id]?.ru || fallback || id;
export const modeGroup = (id: string): Group => MODES[id]?.group || 'other';

/** «ONLY MIRAGE» → «Только Mirage», «TIER 1-2 - EASY» → «Тир 1–2 · лёгкие» */
export function catRu(c: string) {
  if (!c) return '';
  const dict: Record<string, string> = {
    'ALL MAPS': 'Все карты', 'ARENA MAPS': 'Арена-карты', 'FUN MODE': 'Фан', 'ONLY RING': 'Только ринг', 'FUN MAPS': 'Фан-карты',
    'ONLY HEADSHOT': 'Только в голову', 'ONLY AWP LEGO 2': 'Только AWP Lego 2', 'AWP CANNONS': 'AWP Cannons',
    CLASSIC: 'Классика', EASY: 'Лёгкие', MIX: 'Микс', RULES: 'С правилами', TRAINING: 'Тренировка', LEGACY: 'Legacy',
    'RANDOM EVENTS': 'Случайные события', 'FLASHLIGHT NIGHT': 'Ночь с фонариками', '1VS3': '1 против 3', '2VS5': '2 против 5',
  };
  if (dict[c]) return dict[c];
  let m = c.match(/^ONLY ([A-Z0-9]+)$/);
  if (m) return 'Только ' + mapRu('de_' + m[1].toLowerCase());
  m = c.match(/^(\d+) SLOTS$/);
  if (m) return `${m[1]} слотов`;
  m = c.match(/^TIER (\d+)-(\d+)\s*-?\s*(EASY|MEDIUM|HARD|WHITELIST)?$/);
  if (m) return `Тир ${m[1]}–${m[2]}` + (m[3] ? ' · ' + ({ EASY: 'лёгкие', MEDIUM: 'средние', HARD: 'сложные', WHITELIST: 'вайтлист' } as Record<string, string>)[m[3]] : '');
  return c;
}

// ---------------------------------------------------------------------------
// maps
const MAP_NAMES: Record<string, string> = { dust2: 'Dust II', fps: 'FPS' };
const capWord = (w: string) => MAP_NAMES[w] || w.charAt(0).toUpperCase() + w.slice(1);
/**
 * «duels_mirage_1x1» → «Mirage 1×1», «am_dust2» → «Dust II · арены», «de_mirage_wingman» → «Mirage · напарники».
 * Surf, bhop, KZ, aim and fun maps are known by their file names, so they stay as they are («kz_dejavu»).
 */
export function mapRu(map: string) {
  if (!map) return '—';
  const p = map.toLowerCase().match(/^(de|cs|am|duels)_(.+)$/);
  if (!p) return map;
  let m = p[2];
  let tag = p[1] === 'am' ? ' · арены' : '';
  const t = m.match(/_(1x1|2x2|wingman)$/);
  if (t) { m = m.slice(0, -t[0].length); tag += t[1] === 'wingman' ? ' · напарники' : ' ' + t[1].replace('x', '×'); }
  return m.split('_').filter(Boolean).map(capWord).join(' ') + tag;
}

// ---------------------------------------------------------------------------
// locations
const CITY_RU: Record<string, string> = {
  Moscow: 'Москва', 'Saint-Petersburg': 'Санкт-Петербург', Ekaterinburg: 'Екатеринбург', Novosibirsk: 'Новосибирск', Yakutsk: 'Якутск',
  Vilnius: 'Вильнюс', Limburg: 'Лимбург', Falkenstein: 'Фалькенштайн', Luxembourg: 'Люксембург', Astana: 'Астана', Almaty: 'Алматы',
  Copenhagen: 'Копенгаген', 'Hong Kong': 'Гонконг', Istanbul: 'Стамбул', 'New York': 'Нью-Йорк', Dallas: 'Даллас', Warsaw: 'Варшава',
  Tbilisi: 'Тбилиси', Amsterdam: 'Амстердам', Gravelines: 'Гравлин', Helsinki: 'Хельсинки', 'Sao Paulo': 'Сан-Паулу', London: 'Лондон',
  Kiev: 'Киев', Stockholm: 'Стокгольм', Tashkent: 'Ташкент', Ulaanbaatar: 'Улан-Батор', 'Los Angeles': 'Лос-Анджелес', Chicago: 'Чикаго',
  Bucharest: 'Бухарест',
};
export type Region = 'ru' | 'europe' | 'asia' | 'america';
export const REGIONS: { id: Region; ru: string }[] = [
  { id: 'ru', ru: 'Россия' }, { id: 'europe', ru: 'Европа' }, { id: 'asia', ru: 'Азия' }, { id: 'america', ru: 'Америка' },
];
export type Loc = { id: string; country: string; city: string; region: Region };
export function locInfo(p: ServersPayload | null, id: string): Loc {
  const l = p?.locations[id];
  const country = l?.[0] || '';
  const city = l ? CITY_RU[l[1]] || l[1] : id;
  const reg = l?.[2] || '';
  const region: Region = country === 'ru' ? 'ru' : /america/.test(reg) ? 'america' : /asia/.test(reg) ? 'asia' : 'europe';
  return { id, country, city, region };
}
export const flagImg = (country: string) => (country ? `https://flagcdn.com/h20/${country === 'uk' ? 'gb' : country}.png` : '');

// ---------------------------------------------------------------------------
// filters
export type Sort = 'players' | 'free' | 'num';
export type Filters = {
  mode: string; cat?: string; region?: Region | ''; loc?: string; map?: string;
  /** free slots needed: 2 = you and a friend */
  slots?: number; full?: boolean; empty?: boolean; q?: string; sort?: Sort;
};

export function filterServers(list: Srv[], f: Filters, loc: (id: string) => Loc): Srv[] {
  const slots = Math.max(0, f.slots || 0);
  const q = (f.q || '').trim().toLowerCase().replace(/^#/, '');
  const out = list.filter((s) => {
    if (s.mode !== f.mode) return false;
    if (f.cat && s.cat !== f.cat) return false;
    if (f.loc && s.loc !== f.loc) return false;
    if (!f.loc && f.region && loc(s.loc).region !== f.region) return false;
    if (f.map && s.map !== f.map) return false;
    if (slots ? s.free < slots : !f.full && s.free <= 0) return false;
    if (!f.empty && s.players === 0) return false;
    if (q) {
      const hay = `${s.num} ${s.map} ${mapRu(s.map)} ${s.ip}:${s.port} ${s.name} ${loc(s.loc).city}`.toLowerCase();
      if (!(q === String(s.num) || hay.includes(q))) return false;
    }
    return true;
  });
  const sort = f.sort || 'players';
  out.sort((a, b) =>
    sort === 'num' ? a.num - b.num
      : sort === 'free' ? b.free - a.free || b.players - a.players || a.num - b.num
        : b.players - a.players || b.free - a.free || a.num - b.num);
  return out;
}

/**
 * «Быстрое подключение»: the liveliest server that still has room for everybody —
 * most players among those with `slots` free places (2 for you and a friend), ties → more free places.
 */
export function bestServer(list: Srv[], slots = 1): Srv | null {
  let best: Srv | null = null;
  for (const s of list) {
    if (s.free < Math.max(1, slots) || s.players === 0) continue;
    if (!best || s.players > best.players || (s.players === best.players && s.free > best.free)) best = s;
  }
  return best;
}

export function parseJoin(v: string | null): { ip: string; port: number } | null {
  const m = (v || '').match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/);
  return m ? { ip: m[1], port: +m[2] } : null;
}
