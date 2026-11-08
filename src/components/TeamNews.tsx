import { useEffect, useMemo, useState } from 'react';
import { href } from '../lib/router';

/* «Новости» column of a team page: CS2 headlines that name the team, its players or coach.
   scripts/fetch-news.mjs (workflow news.yml, every 20 min) reads the RSS of Cybersport.ru, Sports.ru, HLTV and
   Dust2.us and publishes t/<slug>.json in the orphan branch news-data — the site reads it at runtime. */
const BASES = [
  import.meta.env.VITE_NEWS_BASE as string | undefined,
  'https://raw.githubusercontent.com/vsemvamdam/cs2-craft/news-data/',
  'https://cdn.jsdelivr.net/gh/vsemvamdam/cs2-craft@news-data/',
].filter(Boolean) as string[];

type Item = { t: string; u: string; s: string; ts: number; p?: string[]; w?: 1 };
type NewsFile = { v: 1; updated: number; src: Record<string, [string, string]>; items: Item[] };
const SRC_NAMES = 'Cybersport.ru, Sports.ru, HLTV и Dust2.us';
const PAGE = 8;

/** null — the team has no news (404); throws when no mirror answers */
async function loadNews(slug: string): Promise<NewsFile | null> {
  let reached = false;
  for (const b of BASES) {
    try {
      const r = await fetch(`${b}t/${encodeURIComponent(slug)}.json`, { cache: 'no-cache' });
      reached = true;
      if (r.status === 404) return null;
      if (!r.ok) continue;
      const d = (await r.json()) as NewsFile;
      if (d?.v === 1 && Array.isArray(d.items)) return d;
    } catch { /* blocked or offline — next mirror */ }
  }
  if (reached) return null;
  throw new Error('offline');
}

const dayKey = (ts: number) => new Date(ts * 1000).toDateString();
function dayLabel(ts: number) {
  const d = new Date(ts * 1000), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
const hhmm = (ts: number) => new Date(ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function ago(ts: number) {
  const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} ч назад` : new Date(ts * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/** people: lowercased nickname → SteamID64 (players of the team), to link the nickname chips */
export default function TeamNews({ slug, name, people }: { slug: string; name: string; people: Record<string, string> }) {
  const [data, setData] = useState<NewsFile | null | undefined>(undefined);
  const [err, setErr] = useState(false);
  const [lang, setLang] = useState<'' | 'ru' | 'en'>('');
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => {
    let alive = true;
    setData(undefined); setErr(false); setLimit(PAGE); setLang('');
    loadNews(slug).then((d) => alive && setData(d), () => alive && (setErr(true), setData(null)));
    return () => { alive = false; };
  }, [slug]);

  const items = data?.items || [];
  const langOf = (it: Item) => data?.src[it.s]?.[1] || 'ru';
  const langs = useMemo(() => new Set(items.map(langOf)), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = lang ? items.filter((it) => langOf(it) === lang) : items;
  const shown = list.slice(0, limit);
  const fresh = Date.now() / 1000 - 6 * 3600;

  return (
    <section className="tm-card tm-news" aria-labelledby="tm-news-h">
      <div className="tm-h row between">
        <span id="tm-news-h">Новости</span>
        {langs.size > 1 ? (
          <span className="tm-seg" role="group" aria-label="Язык новостей">
            {([['', 'Все'], ['ru', 'RU'], ['en', 'EN']] as const).map(([k, ru]) => (
              <button key={k} className={lang === k ? 'on' : ''} aria-pressed={lang === k} onClick={() => { setLang(k); setLimit(PAGE); }}>{ru}</button>
            ))}
          </span>
        ) : items.length ? <span className="tm-hsub">{items.length}</span> : null}
      </div>
      {data === undefined ? (
        <div className="tm-nw-empty"><span className="spinner" aria-label="Загрузка" /></div>
      ) : err ? (
        <p className="tm-nw-empty small muted">Не удалось загрузить новости — проверьте подключение и обновите страницу.</p>
      ) : !items.length ? (
        <p className="tm-nw-empty small muted">Свежих новостей о {name} пока нет. Заголовки {SRC_NAMES} проверяются каждые 20 минут.</p>
      ) : (
        <div className="tm-nw-list">
          {shown.map((it, i) => {
            const newDay = i === 0 || dayKey(it.ts) !== dayKey(shown[i - 1].ts);
            const src = data?.src[it.s];
            return (
              <div key={it.u}>
                {newDay && <div className="tm-nw-day">{dayLabel(it.ts)}</div>}
                <article className="tm-nw">
                  <time className={'tm-nw-time num' + (it.ts > fresh ? ' new' : '')} dateTime={new Date(it.ts * 1000).toISOString()}>{hhmm(it.ts)}</time>
                  <div className="tm-nw-body">
                    <a className="tm-nw-t" href={it.u} target="_blank" rel="noreferrer nofollow">{it.t}</a>
                    <div className="tm-nw-meta">
                      <span>{src?.[0] || it.s}</span>
                      {src?.[1] === 'en' && <i className="tm-nw-tag">EN</i>}
                      {it.p?.map((n) => {
                        const sid = people[n.toLowerCase()];
                        return sid ? <a key={n} className="tm-nw-tag p" href={href(`/player/${sid}`)}>{n}</a> : <i key={n} className="tm-nw-tag p">{n}</i>;
                      })}
                    </div>
                  </div>
                </article>
              </div>
            );
          })}
          {!list.length && <p className="tm-nw-empty small muted">Нет новостей на этом языке.</p>}
        </div>
      )}
      {list.length > limit && <button className="tm-more" onClick={() => setLimit((l) => l + 12)}>Ещё новости · {list.length - limit}</button>}
      {data ? <p className="tm-nw-foot tiny faint">Заголовки {SRC_NAMES} · обновлено {ago(data.updated)}</p> : null}
    </section>
  );
}
