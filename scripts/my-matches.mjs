#!/usr/bin/env node
// my-matches.mjs — статистика матчей своего аккаунта CS2 (Premier / соревновательный / напарники).
//
//   1. Steam Web API ICSGOPlayers_730/GetNextMatchSharingCode — новые коды матчей после последнего известного;
//   2. вход в Steam (steam-user, refresh token второго аккаунта) → координатор CS2 (globaloffensive):
//      полная информация о матче по коду → ссылка на демку replay*.valve.net + счёт и K/D/A из roundstats;
//   3. демка → tools/matches/match_stats.py (demoparser2) → статистика всех 10 игроков;
//      если Valve уже удалила демку — остаётся статистика координатора, demo: false;
//   4. store/my-matches/matches/<steamid>.json (+ state.json, gc/*.json) — workflow кладёт это в релиз
//      data-store (scripts/store.sh push my-matches) и в ветку stats-data, откуда файл читает сайт:
//      https://raw.githubusercontent.com/vsemvamdam/rush-b/stats-data/matches/<steamid>.json
//
// Окружение: STEAM_API_KEY, CS2_AUTH_CODE, CS2_LAST_SHARECODE, STEAM_BOT_TOKEN (секреты), CS2_STEAMID,
// необязательно MATCHES_PER_RUN (20), MATCHES_BUDGET_MIN (18), PYTHON (python3), STORE_DIR.
// Если какого-то секрета нет — пишет, каких именно, и выходит с кодом 0. Значения секретов не печатаются.
//
// Формат matches/<steamid>.json (v1), матчи от новых к старым:
// {
//   v: 1, steamid: "7656…", name: "ник из последней демки", updated: "ISO",
//   matches: [{
//     code: "CSGO-…", id: "id матча", date: "ISO (matchtime координатора)",
//     map: "de_mirage" | null, mode: "premier" | "competitive" | "wingman" | "other",
//     duration: секунды, score: [мы, они], result: "W" | "L" | "T", rounds: число,
//     rh: "WWLW…" — раунды с нашей стороны (только с демкой),
//     rating: { type: "premier" | "competitive" | "wingman", before, after, delta, pred: true, wins } | null
//             (before — CS Rating (Premier) или звание на карте 1–18 перед матчем; after — прогноз игры
//              rank_if_win/loss/tie для фактического результата),
//     me: { k, d, a, hs, mvp, score,                                    ← есть всегда
//           adr, dmg, kast (%), ud, fa, ef, fk, fd, tk (размены),
//           mk: { "2": n, "3": n, "4": n, "5": n }, cl: { "1": [попыток, побед], … },
//           shots, hits, hh (в голову), acc (%),
//           weapons: { ak47: { k, hs, shots, hits, dmg }, … } },           ← только с демкой
//     players: [{ sid, name, team: 0 (наша) | 1, k, d, a, hs, mvp, score,
//                 adr, kast, fk, ud, rank }],                            ← adr…rank только с демкой
//     demo: true | false
//   }]
// }
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT, STORE, readJSON, writeJSON, sleep } from './lib/common.mjs';
import {
  SyncError, decodeShareCode, emptyState, envWithoutSecrets, isSteam64, isReplayUrl, makeMasker, mergeMatch, missingSecrets,
  nextShareCodes, parseGcMatch, pendingCodes, upsertMatch,
} from './lib/matches.mjs';
import { openGcSession } from './lib/gc-session.mjs';

const env = process.env;
const mask = makeMasker(env);
const log = (...a) => console.log(mask(a.join(' ')));
const warn = (...a) => console.log(mask(`::warning::${a.join(' ')}`));
const fail = (...a) => console.log(mask(`::error::${a.join(' ')}`));

const MAX_TRIES = 8; // GC / demo attempts per code (≈ 4 hours of runs every 30 min)
const PER_RUN = Math.max(1, +(env.MATCHES_PER_RUN || 20));
const BUDGET_MS = Math.max(1, +(env.MATCHES_BUDGET_MIN || 18)) * 60000;
const PYTHON = env.PYTHON || 'python3';
const DIR = path.join(STORE, 'my-matches');

async function main() {
  const t0 = Date.now();
  const summary = [];
  const missing = missingSecrets(env);
  if (missing.length) {
    const msg = `Синхронизация матчей пропущена: не заданы секреты ${missing.join(', ')}. Добавьте их в Settings → Secrets and variables → Actions (см. README → «Мои матчи»).`;
    console.log(`::notice::${msg}`);
    await output({ changed: 'false', ok: 'false' }, [`### Мои матчи`, msg]);
    return 0;
  }
  const steamid = String(env.CS2_STEAMID || '').trim();
  if (!isSteam64(steamid)) {
    fail('CS2_STEAMID должен быть SteamID64 (17 цифр, 7656119…)');
    return 1;
  }
  try {
    decodeShareCode(env.CS2_LAST_SHARECODE);
  } catch {
    fail('CS2_LAST_SHARECODE не похож на код матча (CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx) — скопируйте его в CS2: «Смотреть» → «Ваши матчи» → «Поделиться»');
    return 1;
  }

  const statePath = path.join(DIR, 'state.json');
  const outPath = path.join(DIR, 'matches', `${steamid}.json`);
  const state = { ...emptyState(), ...(await readJSON(statePath, {})) };
  state.codes ||= {};
  const before = JSON.stringify(state);
  const out = (await readJSON(outPath, null)) || { v: 1, steamid, name: '', updated: null, matches: [] };
  let outChanged = !(await exists(outPath));

  // ---- 1. new share codes --------------------------------------------- //
  const first = String(env.CS2_LAST_SHARECODE).trim();
  if (!state.last && !state.codes[first]) state.codes[first] = { st: 'new', n: 0 };
  const known = state.last || first;
  let codes = [];
  try {
    const r = await nextShareCodes({ key: env.STEAM_API_KEY.trim(), steamid, auth: env.CS2_AUTH_CODE.trim(), known });
    codes = r.codes;
    if (r.more) log('Кодов больше 100 — остальные заберу в следующий запуск');
  } catch (e) {
    if (!(e instanceof SyncError)) throw e;
    (e.fatal ? fail : warn)(e.message);
    if (e.fatal) { await saveState(state, statePath, before); return 1; }
  }
  for (const c of codes) state.codes[c] ||= { st: 'new', n: 0 };
  if (codes.length) state.last = codes[codes.length - 1];
  else if (!state.last) state.last = first;
  log(`Новых матчей от Steam: ${codes.length}`);
  summary.push(`Новых кодов матчей: **${codes.length}**`);

  // ---- 2. game coordinator --------------------------------------------- //
  const todo = pendingCodes(state, MAX_TRIES).slice(0, PER_RUN);
  const needGc = todo.filter((c) => state.codes[c].st === 'new');
  const gcDir = path.join(DIR, 'gc');
  if (needGc.length) {
    log(`Запрашиваю у координатора CS2: ${needGc.length}`);
    let session = null;
    try {
      const [{ default: SteamUser }, { default: GlobalOffensive }] = await Promise.all([import('steam-user'), import('globaloffensive')]);
      session = await openGcSession({ SteamUser, GlobalOffensive, refreshToken: env.STEAM_BOT_TOKEN.trim(), state, log });
      for (const code of needGc) {
        if (Date.now() - t0 > BUDGET_MS / 2) { log('Время на координатор вышло — продолжу в следующий запуск'); break; }
        const c = state.codes[code];
        c.n = (c.n || 0) + 1;
        c.t = new Date().toISOString();
        const { matchId } = decodeShareCode(code);
        const info = await session.requestGame(code, matchId);
        if (!info || info.empty) {
          log(`Матч ${short(matchId)}: координатор ${info?.empty ? 'не знает этот матч' : 'не ответил'} (попытка ${c.n}/${MAX_TRIES})`);
          if (info?.empty && c.n >= 3) c.st = 'failed';
          else if (c.n >= MAX_TRIES) c.st = 'failed';
          continue;
        }
        const gc = parseGcMatch(info, steamid);
        if (!gc) { log(`Матч ${short(matchId)}: в ответе координатора нет статистики`); if (c.n >= MAX_TRIES) c.st = 'failed'; continue; }
        gc.id ||= matchId;
        await writeJSON(path.join(gcDir, `${gc.id}.json`), gc);
        c.st = 'gc';
        c.id = gc.id;
        c.n = 0;
      }
    } catch (e) {
      if (!(e instanceof SyncError)) throw e;
      (e.fatal ? fail : warn)(e.message);
      if (e.fatal) { if (session) await session.close().catch(() => {}); await saveState(state, statePath, before); return 1; }
    } finally {
      if (session) await session.close().catch(() => {});
    }
  }

  // ---- 3. demos -------------------------------------------------------- //
  let added = 0, withDemo = 0, gcOnly = 0;
  for (const code of todo) {
    const c = state.codes[code];
    if (c.st !== 'gc') continue;
    if (Date.now() - t0 > BUDGET_MS) { log('Время вышло — остальные демки разберу в следующий запуск'); break; }
    const gc = await readJSON(path.join(gcDir, `${c.id}.json`), null);
    if (!gc) { c.st = 'new'; continue; }
    let demo = null;
    let gone = !gc.demoUrl;
    if (gc.demoUrl) {
      try {
        demo = await processDemo(gc.demoUrl, steamid);
        if (demo === 'gone') { demo = null; gone = true; }
      } catch (e) {
        c.n = (c.n || 0) + 1;
        c.t = new Date().toISOString();
        warn(`Матч ${short(c.id)}: демку не удалось обработать (${e.message}), попытка ${c.n}/${MAX_TRIES}`);
        if (c.n < MAX_TRIES) continue;
        gone = true;
      }
    }
    const m = mergeMatch(code, gc, demo);
    if (demo?.name) out.name = demo.name;
    if (!demo) await fillNames(m, env.STEAM_API_KEY.trim());
    out.matches = upsertMatch(out.matches || [], m);
    outChanged = true;
    added++;
    if (demo) withDemo++; else gcOnly++;
    c.st = demo ? 'done' : 'gc-only';
    c.n = 0;
    log(`Матч ${short(c.id)}: ${m.map || 'карта ?'} ${m.score ? m.score.join(':') : ''} ${m.result || ''}${gone && !demo ? ' — демки уже нет, только данные координатора' : ''}`);
  }
  summary.push(`Добавлено матчей: **${added}** (с демкой: ${withDemo}, только координатор: ${gcOnly})`);
  const left = pendingCodes(state, MAX_TRIES).length;
  if (left) summary.push(`В очереди: ${left}`);
  const failed = Object.values(state.codes).filter((x) => x.st === 'failed').length;
  if (failed) summary.push(`Не удалось получить: ${failed}`);

  // ---- 4. save --------------------------------------------------------- //
  if (outChanged) {
    out.v = 1;
    out.steamid = steamid;
    out.updated = new Date().toISOString();
    await writeJSON(outPath, out);
  }
  const stateChanged = await saveState(state, statePath, before);
  summary.push(`Всего матчей в статистике: **${(out.matches || []).length}**`);
  log(summary.map((s) => s.replace(/\*\*/g, '')).join(' · '));
  await output({ changed: outChanged || stateChanged ? 'true' : 'false', ok: 'true' }, ['### Мои матчи', ...summary.map((s) => `- ${s}`)]);
  return 0;
}

// ------------------------------------------------------------------------- //
function short(id) { return id ? `…${String(id).slice(-6)}` : '?'; }

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function saveState(state, file, before) {
  if (JSON.stringify(state) === before) return false;
  await writeJSON(file, state);
  return true;
}

async function output(vars, lines) {
  if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, Object.entries(vars).map(([k, v]) => `${k}=${v}\n`).join(''));
  if (env.GITHUB_STEP_SUMMARY && lines?.length) await fs.appendFile(env.GITHUB_STEP_SUMMARY, mask(lines.join('\n')) + '\n');
}

/** download replay*.valve.net/…dem.bz2 → match_stats.py → JSON; 'gone' if Valve already deleted it */
async function processDemo(url, steamid) {
  if (!isReplayUrl(url)) return 'gone';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'my-match-'));
  try {
    const file = path.join(dir, /\.bz2$/i.test(new URL(url).pathname) ? 'demo.dem.bz2' : 'demo.dem');
    let res = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(10 * 60000), headers: { 'user-agent': 'rush-b-matches/1.0' } });
        if (res.status < 500) break;
      } catch (e) {
        res = null;
        if (attempt === 2) throw new Error(e?.name === 'TimeoutError' ? 'таймаут загрузки' : 'ошибка сети');
      }
      await sleep(5000 * (attempt + 1));
    }
    if (!res) throw new Error('сервер демок не ответил');
    if (res.status === 404 || res.status === 410 || res.status === 403) return 'gone';
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
    const json = path.join(dir, 'match.json');
    await new Promise((resolve, reject) => {
      // the demo parser is somebody else's package and needs only the file: it runs without our secrets
      execFile(PYTHON, ['-I', path.join(ROOT, 'tools', 'matches', 'match_stats.py'), file, '--steamid', steamid, '--out', json],
        { timeout: 15 * 60000, maxBuffer: 16 << 20, env: envWithoutSecrets(env) },
        (err, _stdout, stderr) => (err ? reject(new Error(lastLine(stderr) || err.message)) : resolve()));
    });
    return JSON.parse(await fs.readFile(json, 'utf8'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function lastLine(s) { return String(s || '').trim().split('\n').pop().slice(0, 300); }

/** names for GC-only matches: ISteamUser/GetPlayerSummaries (the GC gives only account ids) */
async function fillNames(m, key) {
  const ids = (m.players || []).filter((p) => !p.name).map((p) => p.sid);
  if (!ids.length) return;
  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${ids.join(',')}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return;
    const j = await r.json();
    const names = new Map((j?.response?.players || []).map((p) => [String(p.steamid), String(p.personaname || '')]));
    for (const p of m.players) if (!p.name && names.get(p.sid)) p.name = names.get(p.sid);
  } catch { /* names are optional */ }
}

main().then((code) => process.exit(code), (e) => {
  console.log(mask(`::error::Сбой синхронизации матчей: ${e?.message || e}`));
  process.exit(1);
});
