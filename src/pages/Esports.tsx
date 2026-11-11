import { useTeamLogos, useTourIcons } from '../lib/teams';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner } from '../components/ui';
import { setQuery, useRoute } from '../lib/router';
import './Esports.css';

/* Data: JSON built by scripts/fetch-esports.mjs in GitHub Actions every ~20 min and force-pushed to the
   orphan branch esports-data — the static site reads it at runtime, Pages is not rebuilt. */
const SOURCES = [
  import.meta.env.VITE_ESPORTS_URL as string | undefined,
  'https://raw.githubusercontent.com/vsemvamdam/rush-b/esports-data/esports.json',
  'https://cdn.jsdelivr.net/gh/vsemvamdam/rush-b@esports-data/esports.json',
].filter(Boolean) as string[];

type Team = { n: string; f?: string; tbd?: boolean };
type Book = { b: string; o: [number, number]; at?: number };
type Odds = { books: Book[]; best: [number, number]; bestBy: [string, string]; prob: [number, number]; fav: 0 | 1 | null; at?: number; closed?: boolean };
type Stream = { p: string; u: string };
type Match = {
  id: string; t1: Team; t2: Team; start: number; status: 'live' | 'upcoming' | 'finished'; approx?: boolean; bo?: number;
  score?: [number, number]; winner?: 1 | 2; tour: string; stage?: string; tp?: string; tier?: string; streams?: Stream[]; odds?: Odds;
};
type Tournament = {
  id: string; name: string; short?: string; tier?: string; tiertype?: string; start?: string; end?: string; prize?: number; cur?: string;
  city?: string; country?: string; venue?: string; type?: 'lan' | 'online' | 'mixed'; teams?: number; org?: string; major?: boolean;
  status: 'ongoing' | 'upcoming' | 'finished'; url: string; m?: { up: number; live: number; done: number };
};
type Source = { ok: boolean; at: number | null; n?: number; total?: number; error?: string };
type Data = {
  v: 1; updated: number; books: Record<string, string>; matches: Match[]; tournaments: Tournament[];
  sources: { liquipedia: Source; polymarket?: Source; oddspapi?: Source & { key: boolean; books: string[]; used?: number; limit?: number; every?: number } };
};

async function loadData(): Promise<Data> {
  let lastErr: unknown;
  for (const url of SOURCES) {
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as Data;
      if (d?.v !== 1 || !Array.isArray(d.matches)) throw new Error('неверный формат');
      return d;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function useEsports() {
  const [s, set] = useState<{ data: Data | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const reload = useCallback(() => {
    loadData().then(
      (data) => set({ data, error: null, loading: false }),
      (e) => set((p) => ({ data: p.data, error: String(e?.message || e), loading: false })),
    );
  }, []);
  useEffect(() => {
    reload();
    const t = window.setInterval(reload, 5 * 60 * 1000);
    const vis = () => document.visibilityState === 'visible' && reload();
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [reload]);
  return { ...s, reload };
}

function useNow(ms = 30000) {
  const [now, set] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = window.setInterval(() => set(Date.now() / 1000), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ── formatting ─────────────────────────────────────────────────────────────
const plural = (n: number, f: [string, string, string]) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return f[a > 10 && a < 20 ? 2 : b > 1 && b < 5 ? 1 : b === 1 ? 0 : 2];
};
const fmtTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtDM = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dayKey = (t: number) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function dayLabel(t: number, now: number) {
  const d = new Date(t * 1000);
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const n = new Date(now * 1000);
  const b = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const diff = Math.round((a - b) / 86400000);
  const rel = diff === 0 ? 'Сегодня' : diff === 1 ? 'Завтра' : diff === -1 ? 'Вчера' : '';
  const s = fmtDay.format(d);
  return rel ? `${rel} · ${s}` : s[0].toUpperCase() + s.slice(1);
}
function ago(t: number | null | undefined, now: number) {
  if (!t) return '—';
  const m = Math.max(0, Math.round((now - t) / 60));
  if (m < 1) return 'только что';
  if (m < 60) return `${m} ${plural(m, ['минуту', 'минуты', 'минут'])} назад`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ${plural(h, ['час', 'часа', 'часов'])} назад`;
  const d = Math.round(h / 24);
  return `${d} ${plural(d, ['день', 'дня', 'дней'])} назад`;
}
function until(t: number, now: number) {
  const m = Math.round((t - now) / 60);
  if (m < 1) return 'вот-вот начнётся';
  if (m <= 90) return `через ${m} мин`;
  return '';
}
const parseDate = (s?: string) => (s && s.length === 10 ? new Date(s + 'T12:00:00') : null);
function dateRange(a?: string, b?: string) {
  const x = parseDate(a), y = parseDate(b);
  if (!x) return a ? a.replace(/-/g, '.') : 'даты уточняются';
  if (!y || a === b) return `${fmtDM.format(x)} ${x.getFullYear()}`;
  const sameYear = x.getFullYear() === y.getFullYear();
  if (sameYear && x.getMonth() === y.getMonth()) return `${x.getDate()}–${fmtDM.format(y)} ${y.getFullYear()}`;
  return sameYear ? `${fmtDM.format(x)} – ${fmtDM.format(y)} ${y.getFullYear()}` : `${fmtDM.format(x)} ${x.getFullYear()} – ${fmtDM.format(y)} ${y.getFullYear()}`;
}
function money(v?: number, cur = 'USD') {
  if (!v) return null;
  try {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v);
  } catch {
    return `${v.toLocaleString('ru-RU')} ${cur}`;
  }
}
/** two probabilities rounded so that they add up to 100% */
const pct2 = (p: [number, number]): [string, string] => { const a = Math.round(p[0] * 100); return [`${a}%`, `${100 - a}%`]; };
/** Liquipedia placeholders ("Group B 1st Place", "Winner of …") in Russian */
function tbdName(n: string) {
  let m;
  if (!n || n === 'TBD') return 'TBD';
  if ((m = /^Group (\S+) (\d+)(?:st|nd|rd|th) Place$/i.exec(n))) return `${m[2]}-е место группы ${m[1]}`;
  if ((m = /^(\d+)(?:st|nd|rd|th) Place$/i.exec(n))) return `${m[1]}-е место`;
  if ((m = /^Winner (?:of )?(.+)$/i.exec(n))) return `Победитель ${m[1]}`;
  if ((m = /^Loser (?:of )?(.+)$/i.exec(n))) return `Проигравший ${m[1]}`;
  return n;
}
const odd = (o: number) => o.toFixed(2);
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

const COUNTRY: Record<string, string> = {
  Germany: 'Германия', China: 'Китай', Poland: 'Польша', Spain: 'Испания', France: 'Франция', Denmark: 'Дания', Sweden: 'Швеция', Romania: 'Румыния',
  Malta: 'Мальта', Serbia: 'Сербия', Singapore: 'Сингапур', 'Hong Kong': 'Гонконг', Portugal: 'Португалия', 'United States': 'США', USA: 'США',
  Brazil: 'Бразилия', Argentina: 'Аргентина', Russia: 'Россия', Kazakhstan: 'Казахстан', 'Saudi Arabia': 'Саудовская Аравия', 'United Arab Emirates': 'ОАЭ',
  'United Kingdom': 'Великобритания', England: 'Англия', Netherlands: 'Нидерланды', Belgium: 'Бельгия', Austria: 'Австрия', Switzerland: 'Швейцария',
  Italy: 'Италия', Hungary: 'Венгрия', Czechia: 'Чехия', 'Czech Republic': 'Чехия', Slovakia: 'Словакия', Ukraine: 'Украина', Finland: 'Финляндия',
  Norway: 'Норвегия', Turkey: 'Турция', Australia: 'Австралия', Japan: 'Япония', 'South Korea': 'Южная Корея', Mongolia: 'Монголия', Thailand: 'Таиланд',
  India: 'Индия', Mexico: 'Мексика', Canada: 'Канада', Chile: 'Чили', Colombia: 'Колумбия', Peru: 'Перу', Uzbekistan: 'Узбекистан', Azerbaijan: 'Азербайджан',
  Georgia: 'Грузия', Belarus: 'Беларусь', Lithuania: 'Литва', Latvia: 'Латвия', Estonia: 'Эстония', Bulgaria: 'Болгария', Greece: 'Греция', Croatia: 'Хорватия',
  Slovenia: 'Словения', Israel: 'Израиль', Qatar: 'Катар', Macau: 'Макао', Taiwan: 'Тайвань', Malaysia: 'Малайзия', Indonesia: 'Индонезия', Philippines: 'Филиппины',
  Vietnam: 'Вьетнам', Europe: 'Европа', 'North America': 'Северная Америка', 'South America': 'Южная Америка', Asia: 'Азия', Oceania: 'Океания',
  'Middle East': 'Ближний Восток', CIS: 'СНГ', Africa: 'Африка', 'South Africa': 'ЮАР', Egypt: 'Египет', Ireland: 'Ирландия', Iceland: 'Исландия',
};
const CITY: Record<string, string> = {
  Cologne: 'Кёльн', Katowice: 'Катовице', Beijing: 'Пекин', Bucharest: 'Бухарест', Singapore: 'Сингапур', Kallang: 'Сингапур', Shanghai: 'Шанхай',
  Copenhagen: 'Копенгаген', Austin: 'Остин', Dallas: 'Даллас', 'Rio de Janeiro': 'Рио-де-Жанейро', Paris: 'Париж', London: 'Лондон', Attard: 'Аттард',
  Belgrade: 'Белград', Riyadh: 'Эр-Рияд', Astana: 'Астана', Melbourne: 'Мельбурн', Sydney: 'Сидней', Lisbon: 'Лиссабон', Porto: 'Порту', Hamburg: 'Гамбург',
  Berlin: 'Берлин', Stockholm: 'Стокгольм', Budapest: 'Будапешт', Antwerp: 'Антверпен', Rotterdam: 'Роттердам', Atlanta: 'Атланта', Chengdu: 'Чэнду',
  'Hong Kong': 'Гонконг', 'Chek Lap Kok': 'Гонконг', Macau: 'Макао', 'Abu Dhabi': 'Абу-Даби', Dubai: 'Дубай', Moscow: 'Москва', 'Saint Petersburg': 'Санкт-Петербург',
  Kazan: 'Казань', Bangkok: 'Бангкок', 'Jönköping': 'Йёнчёпинг', 'Fort Worth': 'Форт-Уэрт', Arlington: 'Арлингтон', Kyiv: 'Киев', Warsaw: 'Варшава', Prague: 'Прага',
  Bratislava: 'Братислава', Valencia: 'Валенсия', Madrid: 'Мадрид', Barcelona: 'Барселона', Malaga: 'Малага', Monterrey: 'Монтеррей', 'Mexico City': 'Мехико',
  Tokyo: 'Токио', Seoul: 'Сеул', Ulaanbaatar: 'Улан-Батор', Tashkent: 'Ташкент', Baku: 'Баку', Tbilisi: 'Тбилиси', Minsk: 'Минск', Suzhou: 'Сучжоу',
  'Buenos Aires': 'Буэнос-Айрес', 'São Paulo': 'Сан-Паулу', 'Sao Paulo': 'Сан-Паулу', Malmö: 'Мальмё', Odense: 'Оденсе', Herning: 'Хернинг', Oslo: 'Осло',
  Helsinki: 'Хельсинки', Vienna: 'Вена', Sofia: 'София', Athens: 'Афины', Istanbul: 'Стамбул', Doha: 'Доха', Jeddah: 'Джидда', Manila: 'Манила',
  'Kuala Lumpur': 'Куала-Лумпур', Jakarta: 'Джакарта', 'New York': 'Нью-Йорк', 'Los Angeles': 'Лос-Анджелес', Chicago: 'Чикаго', 'Las Vegas': 'Лас-Вегас',
  Toronto: 'Торонто', Montreal: 'Монреаль', Wroclaw: 'Вроцлав', Krakow: 'Краков', Gdansk: 'Гданьск', Lyon: 'Лион', Marseille: 'Марсель', Amsterdam: 'Амстердам',
  Utrecht: 'Утрехт', Leipzig: 'Лейпциг', Munich: 'Мюнхен', Frankfurt: 'Франкфурт', Dusseldorf: 'Дюссельдорф', Düsseldorf: 'Дюссельдорф', Belo: 'Белу-Оризонти',
};
const place = (t: Tournament) => {
  const c = t.city ? CITY[t.city] || t.city : '';
  const k = t.country ? COUNTRY[t.country] || t.country : '';
  return [c, k && k !== c ? k : ''].filter(Boolean).join(', ');
};
const TYPE: Record<string, string> = { lan: 'LAN', online: 'Онлайн', mixed: 'Онлайн + LAN' };
const STREAM: Record<string, string> = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', afreeca: 'AfreecaTV', huya: 'Huya', douyu: 'Douyu', bilibili: 'Bilibili', vk: 'VK', trovo: 'Trovo' };

function hue(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
function Mono({ t }: { t: Team }) {
  const logo = useTeamLogos();
  const [broken, setBroken] = useState(false);
  if (t.tbd) return <span className="es-mono tbd">?</span>;
  const src = broken ? null : logo(t.f, t.n);
  if (src) return <span className="es-mono es-logo" aria-hidden><img src={src} alt="" loading="lazy" onError={() => setBroken(true)} /></span>;
  const letters = (t.n.match(/[A-Za-zА-Яа-я0-9]/g) || ['?']).slice(0, 2).join('').toUpperCase();
  return <span className="es-mono" style={{ ['--h' as string]: hue(t.f || t.n) }} aria-hidden>{letters}</span>;
}
/** tournament icon (Liquipedia), nothing when there is none */
function TourIcon({ page, size = 18 }: { page?: string; size?: number }) {
  const icon = useTourIcons();
  const [bad, setBad] = useState(false);
  const src = bad ? null : icon(page);
  return src ? <img className="es-ticon" src={src} alt="" width={size} height={size} loading="lazy" onError={() => setBad(true)} /> : null;
}
const TierBadge = ({ tier }: { tier?: string }) => (tier ? <span className={'es-tier t-' + tier} title={`${tier}-Tier по классификации Liquipedia`}>{tier}</span> : null);

// ── page ───────────────────────────────────────────────────────────────────
export default function Esports() {
  const { query } = useRoute();
  const { data, error, loading, reload } = useEsports();
  const now = useNow();
  const tab = query.get('tab') === 't' ? 't' : 'm';
  const tier = query.get('tier') || '';
  const tour = query.get('t') || '';
  const q = query.get('q') || '';
  const onlyOdds = query.get('odds') === '1';
  const [qInput, setQInput] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => q !== qInput && setQuery({ q: qInput.trim() || null }), 250);
    return () => clearTimeout(t);
  }, [qInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const qn = norm(q.trim());
  const textOk = useCallback((m: Match) => !qn || [m.t1.n, m.t1.f, m.t2.n, m.t2.f, m.tour].some((s) => s && norm(s).includes(qn)), [qn]);
  const matches = useMemo(() => {
    if (!data) return [];
    return data.matches.filter((m) => {
      if (tier && (tier === 'C' ? !m.tier || 'SAB'.includes(m.tier) : m.tier !== tier)) return false;
      if (tour && m.tp !== tour && m.tour !== tour) return false;
      if (onlyOdds && !m.odds) return false;
      if (!tour && m.t1.tbd && m.t2.tbd && m.status !== 'finished') return false; // empty bracket slots — only on a tournament's list
      return textOk(m);
    });
  }, [data, tier, tour, onlyOdds, textOk]);
  const tours = useMemo(() => {
    if (!data) return [];
    return data.tournaments.filter((t) => (!tier || (tier === 'C' ? !t.tier || !'SAB'.includes(t.tier) : t.tier === tier)) && (!qn || norm(t.name + ' ' + (t.short || '')).includes(qn)));
  }, [data, tier, qn]);
  const tourOptions = useMemo(() => {
    if (!data) return [];
    const m = new Map<string, { id: string; name: string; tier?: string; n: number }>();
    for (const x of data.matches) {
      const id = x.tp || x.tour;
      const o = m.get(id) || { id, name: x.tour, tier: x.tier, n: 0 };
      o.n++;
      m.set(id, o);
    }
    return [...m.values()].sort((a, b) => (a.tier || 'Z').localeCompare(b.tier || 'Z') || a.name.localeCompare(b.name));
  }, [data]);

  if (loading && !data) return <Spinner />;
  if (!data)
    return (
      <div className="stack">
        <h1>Турниры и матчи</h1>
        <div className="notice bad">Не удалось загрузить расписание матчей ({error}). Данные обновляются автоматически — попробуйте чуть позже.</div>
        <div><button className="btn" onClick={reload}>Повторить</button></div>
      </div>
    );

  const stale = now - data.updated > 2 * 3600;
  const op = data.sources.oddspapi;
  const pm = data.sources.polymarket;
  const anyOdds = data.matches.some((m) => m.odds);
  const counts = { m: data.matches.filter((m) => m.status !== 'finished').length, t: data.tournaments.filter((t) => t.status !== 'finished').length };
  const tierCount = (t: string) => data.matches.filter((m) => m.status !== 'finished' && (t === 'C' ? !m.tier || !'SAB'.includes(m.tier) : m.tier === t)).length;

  return (
    <div className="es stack" style={{ gap: 16 }}>
      <div className="es-head">
        <div className="stack" style={{ gap: 6 }}>
          <h1>Турниры и матчи</h1>
          <p className="muted">Расписание, live и результаты про-матчей CS2 с коэффициентами букмекеров. Время — ваше местное.</p>
        </div>
        <div className={'es-upd' + (stale ? ' stale' : '')} title={new Date(data.updated * 1000).toLocaleString('ru-RU')}>
          <span className="dot" /> обновлено {ago(data.updated, now)}
        </div>
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'm'} className={tab === 'm' ? 'on' : ''} onClick={() => setQuery({ tab: null })}>Матчи <span className="es-count">{counts.m}</span></button>
        <button role="tab" aria-selected={tab === 't'} className={tab === 't' ? 'on' : ''} onClick={() => setQuery({ tab: 't', t: null })}>Турниры <span className="es-count">{counts.t}</span></button>
      </div>

      <div className="es-filters">
        <div className="filter-list" role="group" aria-label="Уровень турнира">
          <button className={'chip' + (!tier ? ' on' : '')} onClick={() => setQuery({ tier: null })}>Все уровни</button>
          {['S', 'A', 'B', 'C'].map((t) => (
            <button key={t} className={'chip' + (tier === t ? ' on' : '')} onClick={() => setQuery({ tier: tier === t ? null : t })} title={t === 'C' ? 'C-Tier и ниже' : `${t}-Tier`}>
              {t === 'C' ? 'C и ниже' : `${t}-Tier`}{tab === 'm' && <span className="es-count">{tierCount(t)}</span>}
            </button>
          ))}
        </div>
        <div className="es-filters-row">
          {tab === 'm' && (
            <select className="select" value={tour} onChange={(e) => setQuery({ t: e.target.value || null })} aria-label="Турнир">
              <option value="">Все турниры</option>
              {tourOptions.map((o) => <option key={o.id} value={o.id}>{o.tier ? `[${o.tier}] ` : ''}{o.name} ({o.n})</option>)}
            </select>
          )}
          <input className="input es-search" placeholder={tab === 'm' ? 'Команда или турнир' : 'Название турнира'} value={qInput} onChange={(e) => setQInput(e.target.value)} aria-label="Поиск" />
          {tab === 'm' && anyOdds && (
            <label className="check small"><input type="checkbox" checked={onlyOdds} onChange={(e) => setQuery({ odds: e.target.checked ? '1' : null })} /> с коэффициентами</label>
          )}
          {(tier || tour || q || onlyOdds) && <button className="btn small ghost" onClick={() => { setQInput(''); setQuery({ tier: null, t: null, q: null, odds: null }); }}>Сбросить</button>}
        </div>
      </div>

      {stale && <div className="notice warn">Данные давно не обновлялись ({ago(data.updated, now)}) — расписание и счёт могли измениться.</div>}
      {!data.sources.liquipedia.ok && <div className="notice warn">Liquipedia сейчас не отвечает — показаны данные последнего удачного обновления.</div>}

      <div className="es-layout">
        <div className="es-main">
          {tab === 'm' && (
            <div className="es-disc"><span className="es-18">18+</span> Коэффициенты — справочно, не реклама и не рекомендация к ставкам.</div>
          )}
          {tab === 'm' ? <MatchesView matches={matches} data={data} now={now} anyOdds={anyOdds} /> : <ToursView tours={tours} now={now} />}
        </div>
        <aside className="es-aside">
          {tab === 'm' && <OddsNote data={data} now={now} op={op} pm={pm} />}
          {tab === 'm' && <OngoingTours data={data} />}
          <div className="card pad stack small es-src">
            <h3>Источники</h3>
            <p className="muted">
              Матчи и турниры: <a className="link" href="https://liquipedia.net/counterstrike/" target="_blank" rel="noreferrer">Liquipedia</a>, лицензия{' '}
              <a className="link" href="https://creativecommons.org/licenses/by-sa/3.0/deed.ru" target="_blank" rel="noreferrer">CC BY-SA 3.0</a>. Данные взяты через API Liquipedia и сокращены.
              Логотипы команд и иконки турниров — с Liquipedia; они принадлежат командам и организаторам и показаны только для узнаваемости.
            </p>
            <p className="muted">
              Цены рынка предсказаний: <a className="link" href="https://polymarket.com" target="_blank" rel="noreferrer">Polymarket</a> (публичный API).
              {op?.key && <> Коэффициенты букмекеров: <a className="link" href="https://oddspapi.io" target="_blank" rel="noreferrer">OddsPapi</a>.</>}
            </p>
            <p className="faint tiny">Расписание обновляется каждые 20 минут, страница подтягивает свежие данные сама.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function OddsNote({ data, now, op, pm }: { data: Data; now: number; op: Data['sources']['oddspapi']; pm?: Source }) {
  const pmN = pm?.ok ? pm.n || 0 : 0;
  let body;
  if (!op?.key) {
    body = pmN
      ? <>Коэффициенты букмекеров появятся после подключения ключа OddsPapi. Пока показаны цены рынка предсказаний Polymarket — там, где на матч открыт рынок ({pmN}).</>
      : <>Коэффициенты появятся после подключения ключа OddsPapi.</>;
  } else if (op.error === 'badkey') body = <>Ключ OddsPapi не принят — коэффициенты букмекеров не обновляются. {pmN ? 'Показаны цены Polymarket.' : ''}</>;
  else if (op.error === 'limit') body = <>Исчерпан лимит запросов OddsPapi — коэффициенты букмекеров на {ago(op.at, now).replace(' назад', '')} давности.</>;
  else body = <>Коэффициенты: {op.books.map((b) => data.books[b] || b).join(', ')}{pmN ? ', Polymarket' : ''}. Букмекеры обновлены {ago(op.at, now)}{pm?.at ? `, Polymarket — ${ago(pm.at, now)}` : ''}.</>;
  return (
    <div className="card pad stack small es-oddsnote">
      <h3>Коэффициенты</h3>
      <p className="muted">{body}</p>
      <p className="faint tiny">Коэффициент — десятичный (сколько вернётся с 1 ₽ при выигрыше). Процент — оценка шанса без маржи букмекера, усреднённая по источникам. Подсвечен фаворит.</p>
    </div>
  );
}

function OngoingTours({ data }: { data: Data }) {
  const list = data.tournaments.filter((t) => t.status === 'ongoing' && t.tier && 'SA'.includes(t.tier)).slice(0, 5);
  if (!list.length) return null;
  return (
    <div className="card stack es-ongoing">
      <div className="card-head"><h3>Идут сейчас</h3><button className="btn small ghost" onClick={() => setQuery({ tab: 't', t: null })}>Все турниры</button></div>
      {list.map((t) => (
        <button key={t.id} className="es-ongoing-row" onClick={() => setQuery({ tab: null, t: t.id })}>
          <TierBadge tier={t.tier} />
          <TourIcon page={t.id} size={24} />
          <span className="grow">
            <b>{t.short || t.name}</b>
            <span className="tiny muted">{dateRange(t.start, t.end)}{t.prize ? ' · ' + money(t.prize, t.cur) : ''}</span>
          </span>
          {t.m?.up ? <span className="tiny muted nowrap">{t.m.up} {plural(t.m.up, ['матч', 'матча', 'матчей'])}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ── matches ────────────────────────────────────────────────────────────────
function MatchesView({ matches, data, now, anyOdds }: { matches: Match[]; data: Data; now: number; anyOdds: boolean }) {
  const [moreResults, setMoreResults] = useState(false);
  const live = matches.filter((m) => m.status === 'live' || (m.status === 'upcoming' && m.start <= now)).sort((a, b) => a.start - b.start);
  const upcoming = matches.filter((m) => m.status === 'upcoming' && m.start > now).sort((a, b) => a.start - b.start);
  const results = matches.filter((m) => m.status === 'finished').sort((a, b) => b.start - a.start);
  const groups = (list: Match[]) => {
    const out: { key: string; label: string; items: Match[] }[] = [];
    for (const m of list) {
      const k = dayKey(m.start);
      if (!out.length || out[out.length - 1].key !== k) out.push({ key: k, label: dayLabel(m.start, now), items: [] });
      out[out.length - 1].items.push(m);
    }
    return out;
  };
  const shownResults = moreResults ? results : results.slice(0, 30);
  if (!matches.length) return <div className="empty card">Под фильтр не попал ни один матч.</div>;
  const row = (m: Match) => <MatchRow key={m.id} m={m} data={data} now={now} oddsCol={anyOdds} />;
  return (
    <div className="stack" style={{ gap: 18 }}>
      {live.length > 0 && (
        <section className="stack es-sec">
          <h2 className="es-h"><span className="es-livedot" /> Сейчас идут <span className="es-count">{live.length}</span></h2>
          <div className="es-list">{live.map(row)}</div>
        </section>
      )}
      {groups(upcoming).map((g) => (
        <section key={g.key} className="stack es-sec">
          <h2 className="es-h">{g.label} <span className="es-count">{g.items.length}</span></h2>
          <div className="es-list">{g.items.map(row)}</div>
        </section>
      ))}
      {!live.length && !upcoming.length && <div className="empty card">Ближайших матчей под фильтр нет.</div>}
      {results.length > 0 && (
        <section className="stack es-sec">
          <h2 className="es-h es-h-results">Результаты <span className="es-count">{results.length}</span></h2>
          {groups(shownResults).map((g) => (
            <div key={g.key} className="stack" style={{ gap: 8 }}>
              <div className="es-subh">{g.label}</div>
              <div className="es-list">{g.items.map(row)}</div>
            </div>
          ))}
          {results.length > shownResults.length && <div><button className="btn" onClick={() => setMoreResults(true)}>Показать все результаты ({results.length})</button></div>}
        </section>
      )}
    </div>
  );
}

function MatchRow({ m, data, now, oddsCol }: { m: Match; data: Data; now: number; oddsCol: boolean }) {
  const [open, setOpen] = useState(false);
  const live = m.status === 'live' || (m.status === 'upcoming' && m.start <= now);
  const done = m.status === 'finished';
  const o = m.odds;
  const p = o ? pct2(o.prob) : null;
  const soon = !live && !done ? until(m.start, now) : '';
  const team = (t: Team, i: 0 | 1) => {
    const win = done && m.winner === i + 1;
    const lose = done && m.winner && m.winner !== i + 1;
    const fav = o && o.fav === i;
    return (
      <div className={'es-team' + (win ? ' win' : '') + (lose ? ' lose' : '')}>
        <Mono t={t} />
        <span className={'es-tname' + (t.tbd ? ' tbd' : '')} title={t.f || t.n}>{t.tbd ? tbdName(t.n) : t.n}</span>
        {m.score && <span className="es-score num">{m.score[i]}</span>}
        {o && p ? (
          <span className={'es-odd' + (fav ? ' fav' : '') + (o.closed ? ' closed' : '')} title={`Лучший коэффициент ${odd(o.best[i])} — ${data.books[o.bestBy[i]] || o.bestBy[i]}. Оценка шанса ${p[i]}`}>
            <b className="num">{odd(o.best[i])}</b><i className="num">{p[i]}</i>
          </span>
        ) : oddsCol && !done ? <span className="es-odd none" aria-hidden /> : null}
      </div>
    );
  };
  const booksLabel = o ? (o.closed ? 'коэф. до матча' : o.books.length === 1 ? data.books[o.books[0].b] || o.books[0].b : `${o.books.length} ${plural(o.books.length, ['источник', 'источника', 'источников'])}`) : '';
  return (
    <div className={'es-match' + (live ? ' live' : '') + (done ? ' done' : '')}>
      <div className="es-when">
        {live ? <span className="es-live">LIVE</span> : m.approx ? <span className="tiny muted">время<br />уточн.</span> : <b className="num">{fmtTime.format(new Date(m.start * 1000))}</b>}
        {m.bo ? <span className="tiny faint">Bo{m.bo}</span> : null}
      </div>
      <div className="es-teams">
        {team(m.t1, 0)}
        {team(m.t2, 1)}
      </div>
      <div className="es-meta">
        <div className="es-tourline">
          <TierBadge tier={m.tier} />
          <TourIcon page={m.tp} />
          <button className="es-tour" onClick={() => setQuery({ t: m.tp || m.tour, tab: null })} title={`${m.tour}${m.stage ? ' · ' + m.stage : ''} — показать матчи турнира`}>
            <span className="es-tour-n">{m.tour}</span>{m.stage ? <span className="es-stage">{m.stage}</span> : null}
          </button>
        </div>
        {(soon || m.streams?.length || o) && (
          <div className="es-actions">
            {soon && <span className="tiny es-soon">{soon}</span>}
            {m.streams?.map((s) => (
              <a key={s.u} className={'es-stream p-' + s.p} href={s.u} target="_blank" rel="noreferrer nofollow">{STREAM[s.p] || s.p}</a>
            ))}
            {o && (
              <button className={'es-books' + (open ? ' on' : '')} onClick={() => setOpen((x) => !x)} aria-expanded={open} title="Коэффициенты по источникам">
                {booksLabel} {open ? '▴' : '▾'}
              </button>
            )}
          </div>
        )}
      </div>
      {open && o && <BooksTable m={m} o={o} data={data} now={now} />}
    </div>
  );
}

function BooksTable({ m, o, data, now }: { m: Match; o: Odds; data: Data; now: number }) {
  return (
    <div className="es-bookt">
      <table className="table">
        <thead>
          <tr><th>Источник</th><th className="r" title={m.t1.f || m.t1.n}>{m.t1.n}</th><th className="r" title={m.t2.f || m.t2.n}>{m.t2.n}</th><th className="r">Маржа</th></tr>
        </thead>
        <tbody>
          {o.books.map((b) => {
            const margin = 1 / b.o[0] + 1 / b.o[1] - 1;
            return (
              <tr key={b.b}>
                <td>{data.books[b.b] || b.b}<div className="tiny faint">{b.b === 'polymarket' ? 'рынок предсказаний' : ''}{b.b === 'polymarket' && b.at ? ' · ' : ''}{b.at ? ago(b.at, now) : ''}</div></td>
                {[0, 1].map((i) => <td key={i} className={'r num' + (b.o[i] === o.best[i] ? ' es-best' : '')}>{odd(b.o[i])}</td>)}
                <td className="r num muted">{b.b === 'polymarket' ? '—' : (margin * 100).toFixed(1) + '%'}</td>
              </tr>
            );
          })}
          <tr className="es-cons">
            <td>Шанс без маржи</td>
            <td className="r num">{pct2(o.prob)[0]}</td>
            <td className="r num">{pct2(o.prob)[1]}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── tournaments ────────────────────────────────────────────────────────────
function ToursView({ tours, now }: { tours: Tournament[]; now: number }) {
  const { query } = useRoute();
  const st = (query.get('st') || 'active') as 'active' | 'ongoing' | 'upcoming' | 'finished' | 'all';
  const by = (s: Tournament['status']) => tours.filter((t) => t.status === s);
  const list = st === 'all' ? tours : st === 'active' ? tours.filter((t) => t.status !== 'finished') : by(st);
  const segs: [typeof st, string, number][] = [
    ['active', 'Идут и скоро', tours.filter((t) => t.status !== 'finished').length],
    ['ongoing', 'Идут', by('ongoing').length],
    ['upcoming', 'Скоро', by('upcoming').length],
    ['finished', 'Завершены', by('finished').length],
    ['all', 'Все', tours.length],
  ];
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="es-segwrap"><div className="seg">
        {segs.map(([k, l, n]) => <button key={k} className={st === k ? 'on' : ''} onClick={() => setQuery({ st: k === 'active' ? null : k })}>{l} <span className="es-count">{n}</span></button>)}
      </div></div>
      {!list.length ? <div className="empty card">Турниров под фильтр нет.</div> : (
        <div className="es-tgrid">{list.map((t) => <TourCard key={t.id} t={t} now={now} />)}</div>
      )}
    </div>
  );
}

function TourCard({ t, now }: { t: Tournament; now: number }) {
  const start = parseDate(t.start);
  const end = parseDate(t.end);
  let status;
  if (t.status === 'ongoing') status = <span className="es-tst on"><span className="es-livedot" /> Идёт{end ? ` · до ${fmtDM.format(end)}` : ''}</span>;
  else if (t.status === 'upcoming') {
    const d = start ? Math.ceil((start.getTime() / 1000 - now) / 86400) : null;
    status = <span className="es-tst up">{d != null && d > 0 ? `через ${d} ${plural(d, ['день', 'дня', 'дней'])}` : 'скоро'}</span>;
  } else status = <span className="es-tst">Завершён</span>;
  const facts = [
    t.prize ? <span key="p"><span className="faint">Призовой</span> <b className="es-tnum">{money(t.prize, t.cur)}</b></span> : null,
    t.teams ? <span key="n"><b className="es-tnum">{t.teams}</b> <span className="faint">{plural(t.teams, ['команда', 'команды', 'команд'])}</span></span> : null,
    t.type ? <span key="ty">{TYPE[t.type]}</span> : null,
  ].filter(Boolean);
  return (
    <div className={'card es-tcard' + (t.status === 'ongoing' ? ' on' : '')}>
      <div className="row between" style={{ gap: 8 }}>
        <span className="row" style={{ gap: 6 }}>
          <TierBadge tier={t.tier} />
          {t.major && <span className="badge gold">Major</span>}
          {t.tiertype && <span className="badge">{t.tiertype === 'Qualifier' ? 'Квалификация' : t.tiertype === 'Showmatch' ? 'Шоу-матч' : t.tiertype}</span>}
        </span>
        {status}
      </div>
      <h3 className="es-tname-h row" style={{ gap: 8, flexWrap: 'nowrap' }}><TourIcon page={t.id} size={28} /><span>{t.name}</span></h3>
      <div className="small muted">{dateRange(t.start, t.end)}{place(t) ? ` · ${place(t)}` : ''}</div>
      {facts.length > 0 && <div className="es-tfacts small">{facts}</div>}
      <div className="row" style={{ gap: 8, marginTop: 'auto' }}>
        {t.m && (t.m.up + t.m.live + t.m.done) > 0 && (
          <button className="btn small" onClick={() => setQuery({ tab: null, t: t.id, st: null })}>
            Матчи{t.m.live ? ` · ${t.m.live} live` : t.m.up ? ` · ${t.m.up}` : ''}
          </button>
        )}
        <a className="btn small ghost" href={t.url} target="_blank" rel="noreferrer">Liquipedia ↗</a>
      </div>
    </div>
  );
}
