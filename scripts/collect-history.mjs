#!/usr/bin/env node
// Сбор полной истории цен Steam Market с обычного домашнего подключения.
// Steam отвечает 429 на все запросы истории с серверов GitHub, поэтому этот шаг делается на своём компьютере.
// Вход в Steam не нужен: история берётся со страницы предмета на торговой площадке (тот же график, что видят все).
//
// С ноября 2026 Steam показывает гостям новый маркет. Его страница предмета несёт историю цен в своём блоке
// данных (valve-ssr-data → запросы ["market","pricehistory",730,<название>]) — сразу для всех износов и StatTrak
// этого скина, поэтому одна страница закрывает до 10 предметов списка. Старая страница (var line1) тоже понимается.
//
//   node collect-history.mjs                 # 600 самых продаваемых скинов
//   node collect-history.mjs --limit 2000    # больше предметов (уже собранные пропускаются)
//
// Нужен только Node.js 18+. Результат — файл cs2-history.json.gz рядом со скриптом; его можно прервать
// (Ctrl+C) и запустить снова — продолжит с места остановки.

import fs from 'node:fs';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const LIMIT = +opt('limit', 600);
let DELAY = +opt('delay', 5000);
const TIMEOUT = +opt('timeout', 40000);
const OUT = opt('out', 'cs2-history.json.gz');
const SITE = 'https://vsemvamdam.github.io/rush-b/data/history-targets.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 46) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const mmss = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`; };

function load() {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(OUT)).toString()); } catch { return { v: 1, items: {} }; }
}
function save(db) {
  db.updated = new Date().toISOString();
  fs.writeFileSync(OUT + '.tmp', zlib.gzipSync(JSON.stringify(db)));
  fs.renameSync(OUT + '.tmp', OUT);
}
/** what is still to fetch: everything without a price history, except items Steam says don't exist (404) */
const pending = (it) => !it || !(it.p?.length || it.err === 404);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) rush-b history',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
const get = (url) => fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: HEADERS });

// Steam currency codes → the prefix|suffix the importer understands (scripts/lib/steam-history.mjs currencyOf)
const CUR = { 1: '$|', 2: '£|', 3: '|€', 5: '|pуб.', 23: '¥|' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** unix seconds → the old chart's date string «Feb 21 2014 01: +0» (what the importer parses) */
const steamDate = (t) => { const d = new Date(t * 1000); return `${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}: +0`; };

/** new market page → { market_hash_name: { cur, p: [[date, price, volume]] } } for every variant on the page */
function parseNewMarket(html) {
  const m = html.match(/<script[^>]*id="valve-ssr-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let q;
  try { q = JSON.parse(JSON.parse(m[1]).renderContext?.queryData || '{}'); } catch { return null; }
  const out = {};
  for (const x of q.queries || []) {
    const k = x.queryKey, d = x.state?.data;
    if (!Array.isArray(k) || k[0] !== 'market' || k[1] !== 'pricehistory' || k[2] !== 730 || !d?.prices?.length) continue;
    out[k[3]] = { cur: CUR[d.ecurrency] || `?${d.ecurrency}`, p: d.prices.map((r) => [steamDate(r.time), Math.round(r.price_median * 1000) / 1000, String(r.purchases)]) };
  }
  return out;
}
/** old market page → { cur, p } for the one item */
function parseOldMarket(html) {
  const m = html.match(/var line1=(\[.*?\]);/s);
  if (!m) return null;
  const pre = (html.match(/var strFormatPrefix = "([^"]*)"/) || [])[1] || '';
  const suf = (html.match(/var strFormatSuffix = "([^"]*)"/) || [])[1] || '';
  try { const p = JSON.parse(m[1]); return p.length ? { cur: `${pre}|${suf}`, p } : null; } catch { return null; }
}

async function main() {
  console.log('Загружаю список самых продаваемых скинов…');
  const targets = (await (await fetch(SITE, { signal: AbortSignal.timeout(TIMEOUT) })).json()).names.slice(0, LIMIT);
  const db = load();
  for (const it of Object.values(db.items)) delete it.tried; // leftovers of an interrupted run
  let todo = targets.filter((n) => pending(db.items[n]));
  console.log(`Всего ${targets.length}, уже собрано ${targets.length - todo.length}, осталось ${todo.length}. Одна страница даёт сразу все износы скина, так что запросов будет меньше.`);
  if (!todo.length) return done(db);

  let stop = false;
  process.on('SIGINT', () => {
    if (stop) process.exit(130);
    stop = true;
    console.log('\nОстанавливаюсь, сохраняю собранное… (ещё раз Ctrl+C — выйти сразу)');
  });

  let ok = 0, extra = 0, empty = 0, wait = 0, netErr = 0, emptyRun = 0, req = 0, badCur = 0;
  const t0 = Date.now();
  const left = () => targets.filter((n) => pending(db.items[n]));
  while (!stop) {
    todo = left().filter((n) => !db.items[n]?.tried);
    if (!todo.length) break;
    const name = todo[0];
    const tag = `[${targets.length - left().length + 1}/${targets.length}]`;
    const url = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(name)}`;
    let r;
    try {
      r = await get(url);
      req++;
    } catch (e) {
      netErr++;
      const why = e.name === 'TimeoutError' ? `нет ответа за ${TIMEOUT / 1000} с` : (e.cause?.code || e.cause?.message || e.message);
      console.log(`${tag} ${short(name)} — ошибка сети: ${why}`);
      if (netErr >= 6) {
        save(db);
        console.log('\nsteamcommunity.com не отвечает 6 раз подряд. Проверьте, открывается ли он в браузере;');
        console.log('если только с обходом блокировок (Zapret, VPN) — он должен работать и для node. Собранное сохранено.');
        process.exit(2);
      }
      await sleep(5000 * netErr);
      continue;
    }
    netErr = 0;
    if (r.status === 429) {
      wait = Math.min((wait || 30000) * 2, 600000);
      DELAY = Math.min(DELAY + 1000, 12000);
      console.log(`${tag} Steam просит подождать (429) — пауза ${Math.round(wait / 1000)} с, дальше по ${DELAY / 1000} с на страницу…`);
      save(db);
      await sleep(wait);
      continue;
    }
    wait = 0;
    if (!r.ok) {
      db.items[name] = { err: r.status, tried: true };
      console.log(`${tag} ${short(name)} — Steam ответил ${r.status}`);
    } else {
      const html = await r.text();
      const found = parseNewMarket(html) || {};
      const old = parseOldMarket(html);
      if (old) found[name] = old;
      const names = Object.keys(found);
      for (const n of names) {
        if (found[n].cur.startsWith('?')) { badCur++; continue; }
        const isTarget = targets.includes(n);
        if (!pending(db.items[n]) && db.items[n]?.p?.length >= found[n].p.length) continue;
        db.items[n] = found[n];
        if (n !== name) isTarget ? ok++ : extra++;
      }
      if (badCur && !ok && names.length) {
        save(db);
        console.log(`\nSteam показывает цены в валюте, которую импорт пока не понимает (${Object.values(found)[0].cur}). Пришлите скриншот.`);
        process.exit(4);
      }
      if (found[name] && !found[name].cur.startsWith('?')) {
        ok++;
        emptyRun = 0;
        const sib = names.filter((n) => n !== name).length;
        console.log(`${tag} ${short(name)} — ${found[name].p.length} точек с ${found[name].p[0][0].slice(0, 11)}${sib ? ` (+${sib} вариантов с той же страницы)` : ''}`);
      } else {
        db.items[name] = { p: [], tried: true };
        empty++;
        emptyRun++;
        const title = ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim();
        console.log(`${tag} ${short(name)} — на странице нет истории (${Math.round(html.length / 1024)} КБ, «${short(title || 'без заголовка', 50)}»)`);
        if (empty === 1) try { fs.writeFileSync('debug-page.html', html); console.log('   образец страницы сохранён в debug-page.html'); } catch { /* read-only */ }
        if (emptyRun === 6 && ok === 0) {
          save(db);
          console.log('\n6 страниц подряд без истории цен — похоже, Steam опять поменял страницу. Пришлите скриншот и debug-page.html.');
          process.exit(3);
        }
      }
    }
    if (req % 5 === 0) {
      save(db);
      const rest = left().length;
      console.log(`   … сохранено; осталось ${rest} из ${targets.length}${extra ? `, попутно собрано ещё ${extra} вариантов вне списка` : ''}; ≈${mmss(((Date.now() - t0) / req) * Math.max(1, rest / 4))}`);
    }
    await sleep(DELAY + Math.random() * 700);
  }
  // items only marked as tried (no history found) stay pending for the next run
  for (const it of Object.values(db.items)) delete it.tried;
  done(db, stop);
}

function done(db, stopped = false) {
  save(db);
  const all = Object.values(db.items);
  const good = all.filter((x) => x.p?.length).length;
  console.log(`\n${stopped ? 'Остановлено, при следующем запуске продолжу' : 'Готово'}: ${good} предметов с историей (из ${all.length}) в файле ${OUT}.`);
  if (!good) console.log('Ни одного графика не получено — пришлите скриншот вывода, разберёмся.');
}

main().catch((e) => { console.error('Ошибка:', e.cause?.code || e.message); process.exit(1); });
