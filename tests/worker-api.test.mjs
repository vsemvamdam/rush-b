// Сервер статистики (worker/src/index.ts): лимиты запросов и проверка того, что присылает посетитель.
// Cloudflare здесь заменён заглушками: база D1 запоминает запросы, лимитер считает обращения, Steam отвечает из теста.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';

const out = new URL('./.worker-api.bundle.mjs', import.meta.url).pathname;
await build({ entryPoints: ['worker/src/index.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const W = await import(out);
after(() => fs.rmSync(out, { force: true }));

const SID = '76561198000000001';

/** D1 stand-in: remembers every statement and what was bound to it */
function fakeDB() {
  const log = [];
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => { log.push({ sql, args }); return { results: [] }; },
    first: async () => { log.push({ sql, args }); return /COUNT\(\*\)/.test(sql) ? { n: 0 } : null; },
    run: async () => { log.push({ sql, args }); return {}; },
  });
  return { log, prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); } };
}
/** rate limiter stand-in: `limit` calls per key, then success: false */
function fakeLimiter(limit) {
  const hits = new Map();
  return { hits, limit: async ({ key }) => { const n = (hits.get(key) || 0) + 1; hits.set(key, n); return { success: n <= limit }; } };
}

let steamCalls;
const realFetch = globalThis.fetch;
beforeEach(() => {
  steamCalls = [];
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (u) => {
    const url = new URL(String(u));
    steamCalls.push(url.pathname);
    const body = url.pathname.includes('GetPlayerSummaries') ? { response: { players: [{ steamid: SID, personaname: 'tester', profileurl: 'https://steamcommunity.com/profiles/' + SID, avatarfull: '', communityvisibilitystate: 3, personastate: 0 }] } }
      : url.pathname.includes('ResolveVanityURL') ? { response: { success: 1, steamid: SID } }
        : { response: {} };
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  };
});
after(() => { globalThis.fetch = realFetch; delete globalThis.caches; });

const ctx = { waitUntil() {} };
const call = (path, env, { ip = '203.0.113.7', method = 'GET' } = {}) =>
  W.default.fetch(new Request('https://api.test' + path, { method, headers: { 'CF-Connecting-IP': ip } }), env, ctx);
const env = (over = {}) => ({ DB: fakeDB(), STEAM_API_KEY: 'k'.repeat(32), RELAY_IPS: '198.51.100.1', ...over });

test('лимит считается по адресу: IPv4 целиком, IPv6 — по префиксу /64', () => {
  assert.equal(W.clientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(W.clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(W.clientKey('2001:DB8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(W.clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(W.clientKey('2001:0db8:0001:0002:0:0:0:1'), W.clientKey('2001:db8:1:2:ffff::9'));
  assert.notEqual(W.clientKey('2001:db8:1:2::1'), W.clientKey('2001:db8:1:3::1'));
  assert.equal(W.clientKey(''), '');
});

test('числа из адреса: только целые в допустимых границах', () => {
  assert.equal(W.intParam(null, 50, 1, 100), 50);
  assert.equal(W.intParam('', 50, 1, 100), 50);
  assert.equal(W.intParam('abc', 50, 1, 100), 50);
  assert.equal(W.intParam('1e999', 50, 1, 100), 50);
  assert.equal(W.intParam('7.9', 50, 1, 100), 7);
  assert.equal(W.intParam('-3', 0, 0, 1000), 0);
  assert.equal(W.intParam('5000', 50, 1, 100), 100);
  assert.equal(W.intParam('1;DROP TABLE profiles', 50, 1, 100), 50);
});

test('ссылка на профиль: случайный «%» и слишком длинный текст не роняют сервер', () => {
  assert.deepEqual(W.parseInput('100%'), {});
  assert.deepEqual(W.parseInput('%E0%A4%A'), {});
  assert.deepEqual(W.parseInput('https%3A%2F%2Fsteamcommunity.com%2Fid%2Fgaben'), { vanity: 'gaben' });
  assert.deepEqual(W.parseInput(`https://steamcommunity.com/profiles/${SID}/`), { steamid: SID });
  assert.deepEqual(W.parseInput('a'.repeat(301)), {});
});

test('рейтинг: в текст SQL попадают только имена колонок из списка, остальное — параметры', async () => {
  for (const q of ['by=constructor', 'by=__proto__', 'by=xp;DROP TABLE profiles', 'limit=abc&offset=-5', 'limit=1.5&offset=2.7', 'limit=NaN&offset=Infinity', "country=R'U&by=cs2"]) {
    const e = env();
    const r = await call('/api/ladder?' + q, e);
    assert.equal(r.status, 200, q);
    const sel = e.DB.log.find((x) => /^SELECT steamid/.test(x.sql));
    assert.match(sel.sql, /^SELECT steamid, name, avatar, country, level, xp, badges, games, playtime, cs2, cs2_2w, created, vac, updated FROM profiles WHERE (xp|games|playtime|cs2|badges|created) IS NOT NULL( AND country = \?)? ORDER BY (xp|games|playtime|cs2|badges|created) (ASC|DESC) LIMIT \? OFFSET \?$/, q);
    const [limit, offset] = sel.args.slice(-2);
    assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 100, q);
    assert.ok(Number.isInteger(offset) && offset >= 0, q);
    for (const a of sel.args.slice(0, -2)) assert.match(a, /^[A-Z]{1,2}$/, q);
  }
  const body = await (await call('/api/ladder?by=constructor', env())).json();
  assert.equal(body.by, 'xp');
});

test('общий лимит: сверх него 429 и Retry-After, у другого адреса свой счёт', async () => {
  const e = env({ RL_API: fakeLimiter(3) });
  for (let i = 0; i < 3; i++) assert.equal((await call('/api/health', e)).status, 200);
  const r = await call('/api/health', e);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('Retry-After'), '60');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match((await r.json()).error, /Слишком много запросов/);
  assert.equal((await call('/api/health', e, { ip: '203.0.113.8' })).status, 200);
  // соседи по одной IPv6-сети /64 делят один счётчик
  const e6 = env({ RL_API: fakeLimiter(1) });
  assert.equal((await call('/api/health', e6, { ip: '2001:db8:1:2::1' })).status, 200);
  assert.equal((await call('/api/health', e6, { ip: '2001:db8:1:2:ffff::2' })).status, 429);
});

test('лимит Steam: профиль и поиск по нику тратят его, запросы по SteamID — нет', async () => {
  const e = env({ RL_STEAM: fakeLimiter(2) });
  assert.equal((await call(`/api/profile?id=${SID}`, e)).status, 200);
  assert.equal((await call(`/api/profile?id=${SID}&fresh=1`, e)).status, 200);
  const before = steamCalls.length;
  assert.equal((await call(`/api/profile?id=${SID}&fresh=1`, e)).status, 429);
  assert.equal((await call('/api/history?id=gaben', e)).status, 429); // nickname → ResolveVanityURL
  assert.equal(steamCalls.length, before, 'после отказа к Steam не ходим');
  assert.equal((await call(`/api/history?id=${SID}`, e)).status, 200);
  assert.equal((await call('/api/ladder', e)).status, 200);
  assert.equal(e.RL_STEAM.hits.get('203.0.113.7'), 4);
});

test('сломанный или не подключённый лимитер не выключает сервер', async () => {
  const broken = { limit: async () => { throw new Error('boom'); } };
  assert.equal((await call('/api/health', env({ RL_API: broken, RL_STEAM: broken }))).status, 200);
  assert.equal((await call(`/api/profile?id=${SID}`, env({ RL_API: broken, RL_STEAM: broken }))).status, 200);
  assert.equal((await call('/api/health', env())).status, 200);
});

test('ответы: nosniff, 400 вместо 500 на мусор, список серверов принимается только от ретранслятора', async () => {
  const r = await call('/api/health', env());
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await call('/api/history?id=100%25', env())).status, 400);
  assert.equal((await call('/api/profile?id=', env())).status, 400);
  const limiter = fakeLimiter(0);
  const push = await call('/api/servers/push', env({ RL_API: limiter }), { method: 'POST' });
  assert.equal(push.status, 403); // чужой адрес; общий лимит на ретранслятор не действует
  assert.equal(limiter.hits.size, 0);
  assert.equal((await call('/api/health', env(), { method: 'DELETE' })).status, 405);
});
