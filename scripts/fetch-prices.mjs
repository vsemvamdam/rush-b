#!/usr/bin/env node
// Fetches CURRENT prices for every CS2 skin, sticker and charm and appends a daily
// snapshot to the price store. Runs in GitHub Actions (see .github/workflows/site.yml).
//
// Sources (no login needed):
//   * Steam Community Market search (lowest listing + number of listings), paged, resumable
//   * Skinport public API (/v1/items + /v1/sales/history) — min price, 7/30-day medians, volumes
//   * Central Bank of Russia daily rates (USD/EUR/CNY in RUB) for currency switching
//
// Env: STORE_DIR (default ./store), STEAM_BUDGET_MIN (default 45), SKIP_STEAM=1, SKIP_SKINPORT=1
//
// Store layout written here:
//   store/prices/current.json   { updated, rates, steam:{name:[low,listings,at]}, skinport:{name:[min,med7,vol7,med30,vol30,qty,sugg]}, phases:{"name|Phase":[med7,vol7]} }
//   store/prices/snap/<skinId>.json  { vk: [[day, steamLow, skinportMin], ...] }   (one point per day)
//   store/prices/meta.json      { steamCursor, steamTotal, steamPassStarted, steamPassDone }

import path from 'node:path';
import { DATA, STORE, readJSON, writeJSON, fetchRetry, sleep, toCents, today, timeBudget, buildNameIndex } from './lib/common.mjs';

const P = path.join(STORE, 'prices');
const UA = 'rush-b price bot (+https://github.com/vsemvamdam/rush-b)';

async function skinport() {
  const out = { items: {}, phases: {} };
  const headers = { 'Accept-Encoding': 'br', 'User-Agent': UA };
  try {
    const r = await fetchRetry('https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0', { headers }, { label: 'skinport items', baseDelay: 20000, tries: 3 });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const items = await r.json();
    for (const it of items) {
      out.items[it.market_hash_name] = [toCents(it.min_price), null, null, null, null, it.quantity ?? 0, toCents(it.suggested_price)];
    }
    console.log(`skinport items: ${items.length}`);
  } catch (e) { console.warn('skinport items failed:', e.message); }
  await sleep(15000);
  try {
    const r = await fetchRetry('https://api.skinport.com/v1/sales/history?app_id=730&currency=USD', { headers }, { label: 'skinport history', baseDelay: 20000, tries: 3 });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rows = await r.json();
    for (const it of rows) {
      const d7 = it.last_7_days || {}, d30 = it.last_30_days || {};
      if (it.version) {
        out.phases[`${it.market_hash_name}|${it.version}`] = [toCents(d7.median ?? d30.median), d7.volume ?? 0, toCents(d30.median), d30.volume ?? 0];
        continue;
      }
      const row = out.items[it.market_hash_name] || [null, null, null, null, null, 0, null];
      row[1] = toCents(d7.median); row[2] = d7.volume ?? 0; row[3] = toCents(d30.median); row[4] = d30.volume ?? 0;
      out.items[it.market_hash_name] = row;
    }
    console.log(`skinport sales history: ${rows.length}`);
  } catch (e) { console.warn('skinport sales history failed:', e.message); }
  return out;
}

async function cbrRates() {
  try {
    const r = await fetchRetry('https://www.cbr-xml-daily.ru/daily_json.js', {}, { label: 'cbr', tries: 3 });
    const j = await r.json();
    const usd = j.Valute.USD.Value / j.Valute.USD.Nominal;
    const eur = j.Valute.EUR.Value / j.Valute.EUR.Nominal;
    const cny = j.Valute.CNY.Value / j.Valute.CNY.Nominal;
    // value of 1 USD in each currency
    return { date: j.Date, USD: 1, RUB: +usd.toFixed(4), EUR: +(usd / eur).toFixed(5), CNY: +(usd / cny).toFixed(5) };
  } catch (e) {
    console.warn('rates failed:', e.message);
    return null;
  }
}

/** Steam market search — pages of 100 sorted by name; resumable via cursor.
 *  Steam often throttles datacenter IPs, so this is best-effort: it gives up after a run of
 *  failures and records what it saw in meta.steamDiag (visible in the data-store release). */
async function steamSearch(current, meta, budgetMin) {
  const budget = timeBudget(budgetMin);
  let start = meta.steamCursor || 0;
  if (!meta.steamPassStarted || start === 0) meta.steamPassStarted = Date.now();
  let delay = 3500;
  let pages = 0, got = 0, fails = 0;
  const diag = { at: new Date().toISOString(), statuses: {}, sample: '' };
  const fail = async (key, wait, sample = '') => {
    diag.statuses[key] = (diag.statuses[key] || 0) + 1;
    if (sample && !diag.sample) diag.sample = sample.slice(0, 300);
    fails++;
    await sleep(wait);
  };
  while (!budget.over()) {
    if (fails >= 8 && pages === 0) { console.warn('steam: too many failures without a single page — giving up for this run'); break; }
    if (fails >= 20) { console.warn('steam: too many failures — giving up for this run'); break; }
    const url = `https://steamcommunity.com/market/search/render/?query=&start=${start}&count=100&search_descriptions=0&sort_column=name&sort_dir=asc&appid=730&norender=1`;
    let r;
    try {
      r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) rush-b', Accept: 'application/json, text/javascript, */*; q=0.01', 'Accept-Language': 'en-US,en;q=0.9', Referer: 'https://steamcommunity.com/market/search?appid=730' }, signal: AbortSignal.timeout(45000) });
    } catch (e) {
      console.warn(`steam ${start}: ${e.message}`); await fail('network', 20000, e.message); continue;
    }
    if (r.status === 429) {
      delay = Math.min(delay * 1.5, 20000);
      console.warn(`steam 429 at ${start}; cooling down 60s, delay → ${Math.round(delay)}ms`);
      await fail('429', 60000); continue;
    }
    if (!r.ok) { console.warn(`steam HTTP ${r.status} at ${start}`); await fail(String(r.status), 20000, await r.text().catch(() => '')); continue; }
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { await fail('not-json', 15000, text); continue; }
    if (!j || !j.success || !Array.isArray(j.results)) { console.warn('steam: bad payload'); await fail('bad-payload', 20000, text); continue; }
    fails = Math.max(0, fails - 1);
    meta.steamTotal = j.total_count;
    const now = Date.now();
    for (const it of j.results) {
      current.steam[it.hash_name] = [it.sell_price ?? null, it.sell_listings ?? 0, now];
      got++;
    }
    pages++;
    start += j.results.length || 100;
    meta.steamCursor = start;
    if (start >= j.total_count || j.results.length === 0) {
      meta.steamCursor = 0;
      meta.steamPassDone = now;
      console.log(`steam pass complete: ${j.total_count} items`);
      break;
    }
    if (pages % 25 === 0) console.log(`steam: ${start}/${j.total_count}`);
    await sleep(delay);
  }
  diag.pages = pages; diag.items = got;
  meta.steamDiag = diag;
  console.log(`steam: ${pages} pages, ${got} items this run, cursor ${meta.steamCursor}`, JSON.stringify(diag.statuses));
}

async function main() {
  const db = await readJSON(path.join(DATA, 'db.json'));
  if (!db) throw new Error('public/data/db.json missing — run scripts/build-db.mjs first');
  const index = buildNameIndex(db);
  const current = (await readJSON(path.join(P, 'current.json'))) || { steam: {}, skinport: {}, phases: {} };
  current.steam ||= {}; current.skinport ||= {}; current.phases ||= {};
  const meta = (await readJSON(path.join(P, 'meta.json'))) || {};

  const rates = await cbrRates();
  if (rates) current.rates = rates;

  if (!process.env.SKIP_SKINPORT) {
    const sp = await skinport();
    if (Object.keys(sp.items).length) current.skinport = sp.items;
    if (Object.keys(sp.phases).length) current.phases = sp.phases;
  }
  if (!process.env.SKIP_STEAM) await steamSearch(current, meta, +(process.env.STEAM_BUDGET_MIN || 45));
  current.updated = new Date().toISOString();
  await writeJSON(path.join(P, 'current.json'), current);
  await writeJSON(path.join(P, 'meta.json'), meta);

  // ---- daily snapshot per skin variant ----
  const d = today();
  const perSkin = new Map();
  for (const [name, { id, vk }] of index) {
    const st = current.steam[name];
    const sp = current.skinport[name];
    const steamLow = st && Date.now() - st[2] < 3 * 86400000 ? st[0] : null;
    const spMin = sp ? sp[0] : null;
    if (steamLow == null && spMin == null) continue;
    if (!perSkin.has(id)) perSkin.set(id, []);
    perSkin.get(id).push([vk, steamLow, spMin]);
  }
  let written = 0;
  for (const [id, rows] of perSkin) {
    const file = path.join(P, 'snap', id + '.json');
    const snap = (await readJSON(file)) || {};
    for (const [vk, a, b] of rows) {
      const arr = (snap[vk] ||= []);
      const last = arr[arr.length - 1];
      if (last && last[0] === d) { last[1] = a ?? last[1]; last[2] = b ?? last[2]; }
      else arr.push([d, a, b]);
    }
    await writeJSON(file, snap);
    written++;
  }
  console.log(`snapshots updated for ${written} skins (day ${d})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
