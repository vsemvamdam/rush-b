// «Мои матчи»: share codes, secret masking, the Steam Web API walk, GC match parsing, the GC session
// (driven by fake steam-user / globaloffensive objects) and the demo statistics (Python, real-demo fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  SyncError, accountToSteam64, decodeShareCode, encodeShareCode, envWithoutSecrets, isReplayUrl, isShareCode, makeMasker, mergeMatch,
  missingSecrets, nextShareCodes, parseGcMatch, pendingCodes, steam64ToAccount, upsertMatch,
} from '../scripts/lib/matches.mjs';
import { openGcSession } from '../scripts/lib/gc-session.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OWNER = '76561198077054958';

// ---------------------------------------------------------------- share codes
test('share code: documented vector (csgo-sharecode README)', () => {
  assert.deepEqual(decodeShareCode('CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK'), {
    matchId: '3230642215713767580', outcomeId: '3230647599455273103', token: '55788',
  });
  assert.equal(encodeShareCode({ matchId: '3230642215713767580', outcomeId: '3230647599455273103', token: 55788 }), 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK');
});

test('share code: agrees with csgo-sharecode and globaloffensive-sharecode on random codes', () => {
  const { decodeMatchShareCode } = require('csgo-sharecode');
  const { ShareCode } = require('globaloffensive-sharecode');
  const rnd64 = () => (BigInt(Math.floor(Math.random() * 2 ** 32)) << 32n) | BigInt(Math.floor(Math.random() * 2 ** 32));
  for (let i = 0; i < 200; i++) {
    const d = { matchId: rnd64().toString(), outcomeId: rnd64().toString(), token: String(Math.floor(Math.random() * 65536)) };
    const code = encodeShareCode(d);
    assert.ok(isShareCode(code), code);
    assert.deepEqual(decodeShareCode(code), d);
    const a = decodeMatchShareCode(code);
    assert.equal(a.matchId.toString(), d.matchId);
    assert.equal(a.reservationId.toString(), d.outcomeId);
    assert.equal(String(a.tvPort), d.token);
    assert.deepEqual(new ShareCode(code).decode(), d);
  }
});

test('share code: rejects junk', () => {
  for (const bad of ['', 'CSGO-', 'CSGO-GADqf-jjyJ8-cSP2r-smZRo', 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2x0', 'csgo-GADqf-jjyJ8-cSP2r-smZRo-TO2xK', 'n/a']) {
    assert.equal(isShareCode(bad), false, bad);
    assert.throws(() => decodeShareCode(bad), SyncError);
  }
});

test('steam ids', () => {
  assert.equal(accountToSteam64(116789230), OWNER);
  assert.equal(steam64ToAccount(OWNER), 116789230);
});

// ---------------------------------------------------------------- secrets
test('missing secrets are listed by name', () => {
  assert.deepEqual(missingSecrets({}), ['STEAM_API_KEY', 'CS2_AUTH_CODE', 'CS2_LAST_SHARECODE', 'STEAM_BOT_TOKEN']);
  assert.deepEqual(missingSecrets({ STEAM_API_KEY: 'x', CS2_AUTH_CODE: ' ', CS2_LAST_SHARECODE: 'y', STEAM_BOT_TOKEN: 'z' }), ['CS2_AUTH_CODE']);
});

test('masking hides secrets and anything token-like', () => {
  const env = { STEAM_API_KEY: '0123456789ABCDEF0123456789ABCDEF', CS2_AUTH_CODE: 'AB12-CDE34-FG56', STEAM_BOT_TOKEN: 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiI3NjU2MTE5OCJ9.c2lnbmF0dXJlc2lnbmF0dXJl', CS2_LAST_SHARECODE: 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK' };
  const mask = makeMasker(env);
  const text = `url ?key=${env.STEAM_API_KEY}&steamidkey=${env.CS2_AUTH_CODE}&knowncode=${env.CS2_LAST_SHARECODE} token ${env.STEAM_BOT_TOKEN}`;
  const m = mask(text);
  for (const v of Object.values(env)) assert.ok(!m.includes(v), `leaked ${v.slice(0, 6)}`);
  const other = makeMasker({});
  assert.equal(other('key FEDCBA9876543210FEDCBA9876543210 code ZZ99-YYY88-XX77'), 'key *** code ***');
  assert.ok(!other('t=eyJabcdefghij.eyJklmnopqrst.sigsigsigsig').includes('eyJ'));
  assert.equal(other('матч …123456: de_mirage 13:9 W'), 'матч …123456: de_mirage 13:9 W');
});

// ---------------------------------------------------------------- Steam Web API walk
function fakeFetch(script) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const step = script.shift();
    if (!step) throw new Error('unexpected call');
    if (step === 'throw') throw Object.assign(new Error('boom'), { name: 'TypeError' });
    return { status: step.status ?? 200, ok: (step.status ?? 200) < 300, json: async () => step.body };
  };
  fn.calls = calls;
  return fn;
}
const noSleep = async () => {};
const C = (i) => encodeShareCode({ matchId: String(1000 + i), outcomeId: String(2000 + i), token: String(i) });

test('next share codes: walks until n/a', async () => {
  const f = fakeFetch([{ body: { result: { nextcode: C(1) } } }, { body: { result: { nextcode: C(2) } } }, { status: 202, body: { result: { nextcode: 'n/a' } } }]);
  const r = await nextShareCodes({ key: 'K'.repeat(32), steamid: OWNER, auth: 'AAAA-BBBBB-CCCC', known: C(0), fetch: f, sleep: noSleep });
  assert.deepEqual(r, { codes: [C(1), C(2)], more: false });
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls[0].startsWith('https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1/?'));
  assert.ok(f.calls[1].includes(`knowncode=${encodeURIComponent(C(1))}`));
  assert.ok(f.calls[0].includes(`steamid=${OWNER}`) && f.calls[0].includes('steamidkey=AAAA-BBBBB-CCCC'));
});

test('next share codes: "n/a" with 200, retry on 5xx and network errors, max', async () => {
  let f = fakeFetch([{ status: 503 }, 'throw', { body: { result: { nextcode: 'n/a' } } }]);
  assert.deepEqual(await nextShareCodes({ key: 'k', steamid: OWNER, auth: 'a', known: C(0), fetch: f, sleep: noSleep }), { codes: [], more: false });
  f = fakeFetch([{ body: { result: { nextcode: C(1) } } }, { body: { result: { nextcode: C(2) } } }]);
  assert.deepEqual(await nextShareCodes({ key: 'k', steamid: OWNER, auth: 'a', known: C(0), fetch: f, sleep: noSleep, max: 2 }), { codes: [C(1), C(2)], more: true });
  f = fakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
  await assert.rejects(nextShareCodes({ key: 'k', steamid: OWNER, auth: 'a', known: C(0), fetch: f, sleep: noSleep }), (e) => e instanceof SyncError && e.kind === 'net' && !e.fatal);
});

test('next share codes: 403 / 412 are fatal and never echo the URL', async () => {
  const key = 'F'.repeat(32);
  for (const [status, kind] of [[403, 'auth'], [412, 'knowncode']]) {
    const f = fakeFetch([{ status }]);
    await assert.rejects(nextShareCodes({ key, steamid: OWNER, auth: 'AAAA-BBBBB-CCCC', known: C(0), fetch: f, sleep: noSleep }), (e) => {
      assert.ok(e instanceof SyncError && e.kind === kind && e.fatal);
      assert.ok(!e.message.includes(key) && !e.message.includes('AAAA-BBBBB-CCCC') && !e.message.includes('http'));
      return true;
    });
  }
});

// ---------------------------------------------------------------- GC match info
const ACC = [11, 12, 13, 14, 15, 116789230, 17, 18, 19, 20];
function gcInfo(over = {}) {
  const last = {
    reservation: { account_ids: ACC, game_type: 520, rankings: [] },
    map: 'http://replay123.valve.net/730/003700000000000000_0123456789.dem.bz2',
    round: 22, kills: [10, 11, 12, 13, 14, 25, 9, 8, 7, 6], assists: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    deaths: [15, 16, 17, 18, 19, 12, 13, 14, 15, 16], scores: [20, 22, 24, 26, 28, 60, 18, 16, 14, 12],
    mvps: [0, 1, 2, 3, 4, 7, 1, 0, 0, 0], enemy_headshots: [5, 5, 5, 5, 5, 11, 4, 4, 4, 4],
    team_scores: [9, 13], match_result: 2, match_duration: 2400, ...over.last,
  };
  return { matchid: '3230642215713767580', matchtime: 1762300000, watchablematchinfo: {}, roundstatsall: [{ reservation: { account_ids: ACC }, kills: [] }, last], ...over.info };
}

test('GC: owner in the second half of account_ids → their team is team_scores[1]', () => {
  const g = parseGcMatch(gcInfo(), OWNER);
  assert.equal(g.id, '3230642215713767580');
  assert.equal(g.date, new Date(1762300000 * 1000).toISOString());
  assert.deepEqual(g.score, [13, 9]);
  assert.equal(g.result, 'W');
  assert.equal(g.rounds, 22);
  assert.equal(g.duration, 2400);
  assert.equal(g.demoUrl, 'http://replay123.valve.net/730/003700000000000000_0123456789.dem.bz2');
  assert.deepEqual(g.me, { k: 25, d: 12, a: 6, hs: 11, mvp: 7, score: 60 });
  assert.equal(g.players.length, 10);
  assert.equal(g.players[0].sid, OWNER);
  assert.equal(g.players.filter((p) => p.team === 0).length, 5);
  assert.ok(g.players.filter((p) => p.team === 0).every((p) => ACC.slice(5).map(accountToSteam64).includes(p.sid)));
  assert.equal(g.mode, null);
});

test('GC: first half, draw, wingman, ratings, foreign demo hosts', () => {
  const ids = [116789230, ...ACC.slice(1)];
  let g = parseGcMatch(gcInfo({ last: { reservation: { account_ids: ids }, team_scores: [12, 12] } }), OWNER);
  assert.deepEqual(g.score, [12, 12]);
  assert.equal(g.result, 'T');
  g = parseGcMatch(gcInfo({ last: { reservation: { account_ids: [116789230, 2, 3, 4] }, team_scores: [9, 4] } }), OWNER);
  assert.equal(g.mode, 'wingman');
  assert.equal(g.result, 'W');
  g = parseGcMatch(gcInfo({ last: { team_scores: [9, 13], reservation: { account_ids: ACC, rankings: [{ account_id: 116789230, rank_id: 15230, rank_type_id: 11, rank_if_win: 15480, rank_if_lose: 14990, rank_if_tie: 15235, wins: 120 }] } } }), OWNER);
  assert.equal(g.mode, 'premier');
  assert.deepEqual(g.rating, { type: 'premier', before: 15230, after: 15480, delta: 250, pred: true, wins: 120 });
  g = parseGcMatch(gcInfo({ last: { map: 'http://evil.example.com/730/x.dem.bz2' } }), OWNER);
  assert.equal(g.demoUrl, null);
  assert.equal(parseGcMatch({ matchid: '1', roundstatsall: [] }, OWNER), null);
  assert.equal(isReplayUrl('https://replay9.valve.net/730/1_2.dem.bz2'), true);
  assert.equal(isReplayUrl('http://replay9.valve.net.evil.com/730/1_2.dem.bz2'), false);
  assert.equal(isReplayUrl('http://replay9.valve.net/730/1_2.zip'), false);
});

test('merge: demo stats win, GC fills the rest; upsert keeps newest first', () => {
  const gc = parseGcMatch(gcInfo(), OWNER);
  const demo = { map: 'de_mirage', mode: 'premier', duration: 2390, rounds: 22, score: [13, 9], result: 'W', rh: 'W'.repeat(13) + 'L'.repeat(9), rating: { type: 'premier', before: 15000, after: 15200, delta: 200, pred: true, wins: 50 }, me: { k: 25, d: 12, a: 6, hs: 11, mvp: 0, score: 0, adr: 101.2 }, players: [{ sid: OWNER }], demo: true, name: 'me' };
  const m = mergeMatch('CSGO-x', gc, demo);
  assert.equal(m.demo, true);
  assert.equal(m.map, 'de_mirage');
  assert.equal(m.mode, 'premier');
  assert.equal(m.me.mvp, 7); // from the GC when the demo has none
  assert.equal(m.date, gc.date);
  assert.equal(m.rating.after, 15200);
  const g = mergeMatch('CSGO-y', gc, null);
  assert.equal(g.demo, false);
  assert.equal(g.mode, 'competitive');
  assert.deepEqual(g.score, [13, 9]);
  assert.equal(g.players.length, 10);
  let list = upsertMatch([], { id: '1', date: '2026-01-01T00:00:00Z' });
  list = upsertMatch(list, { id: '2', date: '2026-02-01T00:00:00Z' });
  list = upsertMatch(list, { id: '1', date: '2026-01-01T00:00:00Z', x: 1 });
  assert.deepEqual(list.map((x) => x.id), ['2', '1']);
  assert.equal(list[1].x, 1);
  const state = { codes: { a: { st: 'done' }, b: { st: 'new', n: 0 }, c: { st: 'gc', n: 7 }, d: { st: 'gc', n: 8 }, e: { st: 'failed' } } };
  assert.deepEqual(pendingCodes(state, 8), ['b', 'c']);
});

// ---------------------------------------------------------------- GC session with fakes
class FakeSteam extends EventEmitter {
  constructor(opts) { super(); FakeSteam.last = this; this.opts = opts; this.played = []; this.licenceCalls = 0; this.loggedOff = false; }
  logOn(details) {
    this.details = details;
    setImmediate(() => (FakeSteam.loginError ? this.emit('error', Object.assign(new Error('x'), { eresult: FakeSteam.loginError })) : this.emit('loggedOn', {})));
  }
  async requestFreeLicense(apps) { this.licenceCalls++; this.licenceApps = apps; return { grantedPackageIds: [303386], grantedAppIds: [730] }; }
  gamesPlayed(apps) { this.played.push(apps); if (apps.includes(730)) this.emit('appLaunched', 730); }
  logOff() { this.loggedOff = true; setImmediate(() => this.emit('disconnected', 0, 'bye')); }
}
class FakeGO extends EventEmitter {
  constructor(steam) {
    super(); FakeGO.last = this; this.haveGCSession = false; this.requests = [];
    steam.on('appLaunched', () => setImmediate(() => { if (!FakeGO.silent) { this.haveGCSession = true; this.emit('connectedToGC'); } }));
  }
  requestGame(code) {
    this.requests.push(code);
    const { matchId } = decodeShareCode(code);
    setImmediate(() => {
      if (FakeGO.answer === 'none') return;
      this.emit('matchList', FakeGO.answer === 'empty' ? [] : [{ matchid: '999' }, { matchid: matchId, roundstatsall: [] }]);
    });
  }
}

test('GC session: login, licence once, connect, request by match id, log off', async () => {
  FakeSteam.loginError = null; FakeGO.silent = false; FakeGO.answer = 'ok';
  const logs = [];
  const state = { licence: false };
  const s = await openGcSession({ SteamUser: FakeSteam, GlobalOffensive: FakeGO, refreshToken: 'tok', state, log: (m) => logs.push(m), timeouts: { gap: 1, request: 200 } });
  const steam = FakeSteam.last;
  assert.equal(steam.details.refreshToken, 'tok');
  assert.equal(steam.opts.dataDirectory, null);
  assert.deepEqual(steam.licenceApps, [730]);
  assert.equal(state.licence, true);
  assert.deepEqual(steam.played[0], [730]);
  const code = C(5);
  const m = await s.requestGame(code, decodeShareCode(code).matchId);
  assert.equal(m.matchid, decodeShareCode(code).matchId);
  FakeGO.answer = 'empty';
  assert.deepEqual(await s.requestGame(C(6), decodeShareCode(C(6)).matchId), { empty: true });
  FakeGO.answer = 'none';
  assert.equal(await s.requestGame(C(7), decodeShareCode(C(7)).matchId), null);
  assert.equal(FakeGO.last.requests.length, 4); // one retry after the timeout
  await s.close();
  assert.equal(steam.loggedOff, true);
  assert.deepEqual(steam.played.at(-1), []);
  assert.ok(!logs.join('\n').includes('tok'));
  // licence already known → not requested again
  const s2 = await openGcSession({ SteamUser: FakeSteam, GlobalOffensive: FakeGO, refreshToken: 'tok', state, log: () => {}, timeouts: { gap: 1 } });
  assert.equal(FakeSteam.last.licenceCalls, 0);
  await s2.close();
});

test('GC session: expired token is fatal with a Russian hint; silent GC is a soft error', async () => {
  FakeSteam.loginError = 27;
  await assert.rejects(openGcSession({ SteamUser: FakeSteam, GlobalOffensive: FakeGO, refreshToken: 'tok', state: { licence: true }, log: () => {} }), (e) => {
    assert.ok(e instanceof SyncError && e.fatal);
    assert.match(e.message, /STEAM_BOT_TOKEN/);
    assert.match(e.message, /steam-login\.mjs --client/);
    return true;
  });
  FakeSteam.loginError = null; FakeGO.silent = true;
  await assert.rejects(openGcSession({ SteamUser: FakeSteam, GlobalOffensive: FakeGO, refreshToken: 'tok', state: { licence: true }, log: () => {}, timeouts: { gc: 30 } }), (e) => {
    assert.ok(e instanceof SyncError && e.kind === 'gc' && !e.fatal);
    return true;
  });
  assert.equal(FakeSteam.last.licenceCalls, 1); // no welcome → asked for the licence once, then gave up
  assert.equal(FakeSteam.last.loggedOff, true);
  FakeGO.silent = false;
});

// ---------------------------------------------------------------- the script itself
test('my-matches.mjs without secrets: names the missing ones, exits 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  const out = path.join(tmp, 'out');
  const env = { PATH: process.env.PATH, STORE_DIR: tmp, GITHUB_OUTPUT: out, CS2_STEAMID: OWNER, STEAM_API_KEY: 'x'.repeat(32) };
  const stdout = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'my-matches.mjs')], { env, encoding: 'utf8' });
  assert.match(stdout, /CS2_AUTH_CODE, CS2_LAST_SHARECODE, STEAM_BOT_TOKEN/);
  assert.ok(!stdout.includes('x'.repeat(32)));
  assert.match(fs.readFileSync(out, 'utf8'), /changed=false/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the demo parser (a third-party package) is started without the Steam secrets and the GitHub token', () => {
  const env = { PATH: '/usr/bin', LD_LIBRARY_PATH: '/opt/python/lib', STEAM_API_KEY: 'k', CS2_AUTH_CODE: 'a', CS2_LAST_SHARECODE: 'c', STEAM_BOT_TOKEN: 't', GH_TOKEN: 'g', GITHUB_TOKEN: 'g2', CS2_STEAMID: OWNER };
  const child = envWithoutSecrets(env);
  assert.deepEqual(child, { PATH: '/usr/bin', LD_LIBRARY_PATH: '/opt/python/lib', CS2_STEAMID: OWNER });
  assert.equal(env.STEAM_BOT_TOKEN, 't'); // the script's own environment is left alone
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'my-matches.mjs'), 'utf8');
  assert.match(src, /execFile\(PYTHON,[^;]*env: envWithoutSecrets\(env\)/s);
});

// ---------------------------------------------------------------- demo statistics (Python)
test('match_stats.py on the real-demo fixture (python unittest)', (t) => {
  const py = spawnSync('python3', ['--version']);
  if (py.status !== 0) return t.skip('python3 не найден');
  const r = spawnSync('python3', ['-I', path.join(ROOT, 'tools', 'matches', 'test_match_stats.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
