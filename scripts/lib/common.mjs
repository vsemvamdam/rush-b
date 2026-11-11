// Shared helpers for the data pipeline (Node 20+, no dependencies).
import fs from 'node:fs/promises';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const DATA = path.join(ROOT, 'public', 'data');
export const STORE = path.resolve(process.env.STORE_DIR || path.join(ROOT, 'store'));

export const WEAR_NAMES = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];
export const DAY0 = Date.UTC(2013, 0, 1);
export const dayOf = (ms) => Math.floor((ms - DAY0) / 86400000);
export const today = () => dayOf(Date.now());

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function readJSON(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
export async function writeJSON(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

/**
 * Kind of a downloaded picture by its first bytes: 'png' | 'jpg' | 'gif' | 'webp', or '' when it is something else.
 * Pictures taken from other sites (Liquipedia) are published on our own address, so only real bitmaps may pass:
 * an SVG or an HTML page saved under an image name would run its scripts as the site when opened by a direct link.
 */
export function imageKind(buf) {
  const b = Buffer.from(buf.subarray(0, 12));
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  const head = b.toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  return '';
}

export const toCents = (v) => (v == null || Number.isNaN(+v) ? null : Math.round(+v * 100));

/**
 * Market name <-> (skin, variant) mapping, built from public/data/db.json.
 * variant key: '' | 's' (StatTrak) | 'v' (Souvenir) followed by wear 0..4 or 'x' (vanilla knife).
 */
export function buildNameIndex(db) {
  const byName = new Map();
  for (const s of db.skins) {
    const flags = [''];
    if (s.st) flags.push('s');
    if (s.sv) flags.push('v');
    for (const f of flags) {
      const wears = s.vanilla ? ['x'] : s.wears;
      for (const w of wears) byName.set(marketName(s, f, w), { id: s.id, vk: f + w });
    }
  }
  return byName;
}

export function marketName(s, flag, wear) {
  let base = s.name;
  let star = '';
  if (base.startsWith('★ ')) { star = '★ '; base = base.slice(2); }
  const prefix = flag === 's' ? 'StatTrak™ ' : flag === 'v' ? 'Souvenir ' : '';
  const w = wear === 'x' || wear == null ? '' : ` (${WEAR_NAMES[+wear]})`;
  return `${star}${prefix}${base}${w}`;
}

/** fetch with retries + exponential backoff. Returns Response or throws. */
export async function fetchRetry(url, opts = {}, { tries = 4, baseDelay = 4000, label = url } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout || 60000) });
      if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      return r;
    } catch (e) {
      lastErr = e;
      const wait = baseDelay * 2 ** i;
      console.warn(`  ${label}: ${e.message}; retry in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

export function timeBudget(minutes) {
  const end = Date.now() + minutes * 60000;
  return { left: () => end - Date.now(), over: () => Date.now() > end };
}
