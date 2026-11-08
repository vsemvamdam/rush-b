// RSS 2.0 / Atom → plain items, no dependencies.
// Only what the news column needs: title, link, plain-text description (for matching, never published),
// categories, publish time.

import { decode } from '../mini-html.mjs';

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const TZ = { GMT: 0, UT: 0, UTC: 0, Z: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, MSK: 3, CET: 1, CEST: 2 };

/** RFC 822 date ("Sun, 08 Nov 26 12:31:00 +0300" — two-digit years too) or ISO 8601 → unix seconds, or null */
export function parseDate(s) {
  if (!s) return null;
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{2}:?\d{2}|[A-Z]{1,4})?/.exec(s);
  if (m) {
    const mon = MON[m[2].toLowerCase()];
    if (mon === undefined) return null;
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    let off = 0;
    const z = m[7];
    if (z && /^[+-]/.test(z)) { const d = z.replace(':', ''); off = (d[0] === '-' ? -1 : 1) * (+d.slice(1, 3) * 60 + +d.slice(3, 5)); }
    else if (z && TZ[z] !== undefined) off = TZ[z] * 60;
    const t = Date.UTC(y, mon, +m[1], +m[4], +m[5], +(m[6] || 0)) / 1000 - off * 60;
    return Number.isFinite(t) ? Math.round(t) : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.round(t / 1000) : null;
}

const unCdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
/** text of an XML element's body: CDATA unwrapped, entities decoded (twice — feeds often double-encode), tags dropped */
export function plain(s) {
  if (!s) return '';
  let t = unCdata(s);
  t = decode(t);
  if (/&(#x?[0-9a-f]+|[a-z]+);/i.test(t)) t = decode(t);
  t = t.replace(/<(br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, ' ').replace(/<[^>]+>/g, '');
  return t.replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tag(body, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = re.exec(body);
  return m ? m[1] : '';
}
function tags(body, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi');
  return [...body.matchAll(re)].map((m) => plain(m[1])).filter(Boolean);
}

/** feed XML → [{ title, link, guid, desc, cats, ts }] */
export function parseFeed(xml) {
  const out = [];
  const isAtom = !/<rss[\s>]/i.test(xml) && /<feed[\s>]/i.test(xml);
  const re = isAtom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  for (const [, body] of xml.matchAll(re)) {
    const title = plain(tag(body, 'title'));
    let link = '';
    if (isAtom) {
      const l = /<link\b[^>]*rel=["']alternate["'][^>]*>/i.exec(body) || /<link\b[^>]*>/i.exec(body);
      link = l ? decode(/href=["']([^"']+)["']/i.exec(l[0])?.[1] || '') : '';
    } else link = plain(tag(body, 'link'));
    const guid = plain(tag(body, isAtom ? 'id' : 'guid')) || link;
    const desc = plain(tag(body, isAtom ? 'summary' : 'description') || tag(body, 'content'));
    const cats = isAtom
      ? [...body.matchAll(/<category\b[^>]*term=["']([^"']+)["']/gi)].map((m) => decode(m[1]))
      : tags(body, 'category');
    const ts = parseDate(plain(tag(body, isAtom ? 'published' : 'pubDate') || tag(body, 'updated') || tag(body, 'dc:date')));
    if (!title || !/^https?:\/\//.test(link)) continue;
    out.push({ title, link, guid, desc, cats, ts });
  }
  return out;
}

/** bytes → string, honouring the charset of the response or of the XML declaration */
export function decodeBody(buf, contentType = '') {
  const head = Buffer.from(buf.slice(0, 200)).toString('latin1');
  const cs = (/charset=([\w-]+)/i.exec(contentType)?.[1] || /encoding=["']([\w-]+)["']/i.exec(head)?.[1] || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

export const UA = 'CS2CRAFT-news/1.0 (+https://github.com/vsemvamdam/cs2-craft)';

/** GET a feed → parsed items. Throws with .status on HTTP errors. */
export async function fetchFeed(url, { timeoutMs = 20000 } = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5', 'Accept-Encoding': 'gzip' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return readFeed(decodeBody(new Uint8Array(await r.arrayBuffer()), r.headers.get('content-type') || ''));
}

/** parseFeed() that refuses pages that are not feeds (an anti-bot page, an error page) */
export function readFeed(xml) {
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new Error('не RSS: ' + xml.slice(0, 80).replace(/\s+/g, ' '));
  return parseFeed(xml);
}
