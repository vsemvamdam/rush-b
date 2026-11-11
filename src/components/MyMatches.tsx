import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createChart, createSeriesMarkers, LineSeries, type SeriesMarker, type Time, type UTCTimestamp } from 'lightweight-charts';
import { Spinner } from './ui';
import { copy, useAsync, useLocal } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import '../styles/my-matches.css';

/**
 * «Мои матчи» — статистика своих матчей CS2 в духе csst.at / Leetify.
 * Данные: matches/<steamid>.json из ветки stats-data (собирает .github/workflows/my-matches.yml,
 * формат описан в scripts/my-matches.mjs).
 */

// ---------------------------------------------------------------- data
export type WeaponStats = { k: number; hs: number; shots: number; hits: number; dmg: number };
export type MeStats = {
  k: number; d: number; a: number; hs: number; mvp?: number; score?: number;
  adr?: number; dmg?: number; kast?: number; ud?: number; fa?: number; ef?: number; fk?: number; fd?: number; tk?: number;
  mk?: Record<string, number>; cl?: Record<string, [number, number]>;
  shots?: number; hits?: number; hh?: number; acc?: number; weapons?: Record<string, WeaponStats>;
};
export type PlayerRow = { sid: string; name: string; team: number; k: number; d: number; a: number; hs: number; mvp?: number; score?: number; adr?: number; kast?: number; fk?: number; ud?: number; rank?: number | null };
export type Rating = { type: string; before: number | null; after: number | null; delta: number | null; pred?: boolean; wins?: number | null };
export type Match = {
  code: string; id: string | null; date: string | null; map: string | null; mode: string; duration: number | null;
  score: [number, number] | null; result: 'W' | 'L' | 'T' | null; rounds: number | null; rh?: string;
  rating: Rating | null; me: MeStats | null; players: PlayerRow[]; demo: boolean;
};
export type MatchesFile = { v: number; steamid: string; name?: string; updated: string | null; matches: Match[] };
export type Filters = { mode: string; map: string; last: number };

export const dataUrl = (steamid: string) => `https://raw.githubusercontent.com/vsemvamdam/rush-b/stats-data/matches/${steamid}.json`;

export const MODES: { k: string; ru: string; short?: string }[] = [
  { k: 'all', ru: 'Все' }, { k: 'premier', ru: 'Premier' }, { k: 'competitive', ru: 'Соревновательный', short: 'Соревн.' }, { k: 'wingman', ru: 'Напарники' },
];
const MODE_RU: Record<string, string> = { premier: 'Premier', competitive: 'Соревн.', wingman: 'Напарники', other: 'Другое' };
const MAP_NAMES: Record<string, string> = {
  de_mirage: 'Mirage', de_inferno: 'Inferno', de_nuke: 'Nuke', de_ancient: 'Ancient', de_anubis: 'Anubis', de_dust2: 'Dust II',
  de_cache: 'Cache', de_overpass: 'Overpass', de_train: 'Train', de_vertigo: 'Vertigo', de_italy: 'Italy', cs_office: 'Office',
  cs_italy: 'Italy', de_basalt: 'Basalt', de_edin: 'Edin', de_palais: 'Palais', de_whistle: 'Whistle', de_brewery: 'Brewery',
  de_dogtown: 'Dogtown', de_jura: 'Jura', de_grail: 'Grail', de_agency: 'Agency', de_thera: 'Thera', de_mills: 'Mills',
};
export const mapName = (m: string | null | undefined) => (m ? MAP_NAMES[m] || m.replace(/^[a-z]{2,3}_/, '').replace(/^\w/, (c) => c.toUpperCase()) : 'Карта ?');
const WEAPONS: Record<string, string> = {
  ak47: 'AK-47', m4a1: 'M4A4', m4a1_silencer: 'M4A1-S', awp: 'AWP', ssg08: 'SSG 08', aug: 'AUG', sg556: 'SG 553', famas: 'FAMAS',
  galilar: 'Galil AR', g3sg1: 'G3SG1', scar20: 'SCAR-20', deagle: 'Desert Eagle', revolver: 'R8 Revolver', usp_silencer: 'USP-S',
  hkp2000: 'P2000', glock: 'Glock-18', p250: 'P250', fiveseven: 'Five-SeveN', tec9: 'Tec-9', cz75a: 'CZ75-Auto', elite: 'Dual Berettas',
  mac10: 'MAC-10', mp9: 'MP9', mp7: 'MP7', mp5sd: 'MP5-SD', ump45: 'UMP-45', p90: 'P90', bizon: 'ПП-19 Бизон', nova: 'Nova',
  xm1014: 'XM1014', mag7: 'MAG-7', sawedoff: 'Sawed-Off', m249: 'M249', negev: 'Negev', knife: 'Нож', taser: 'Zeus x27',
  hegrenade: 'HE-граната', molotov: 'Молотов', flashbang: 'Флешка', smokegrenade: 'Дым',
  decoy: 'Ложная граната', world: 'Мир',
};
export const weaponName = (w: string) => WEAPONS[w] || w;
const UTILITY = new Set(['hegrenade', 'molotov', 'flashbang', 'smokegrenade', 'decoy']);
const SKILL_GROUPS = ['', 'Серебро I', 'Серебро II', 'Серебро III', 'Серебро IV', 'Серебро — Элита', 'Серебро — Великий магистр', 'Золотая звезда I', 'Золотая звезда II', 'Золотая звезда III', 'Золотая звезда — Магистр', 'Магистр-хранитель I', 'Магистр-хранитель II', 'Магистр-хранитель — Элита', 'Заслуженный магистр-хранитель', 'Легендарный беркут', 'Легендарный беркут-магистр', 'Великий магистр высшего ранга', 'Всемирная элита'];

/** CS Rating tier colours as in the game: grey < 5k, light blue, blue, purple, pink, red, gold ≥ 30k */
export function ratingColor(r: number | null | undefined) {
  if (!r) return 'var(--muted)';
  if (r < 5000) return '#b9c4d2';
  if (r < 10000) return '#7fb7e8';
  if (r < 15000) return '#5b7cff';
  if (r < 20000) return '#a26bff';
  if (r < 25000) return '#e04fe8';
  if (r < 30000) return '#ef5a5a';
  return '#f0b43c';
}

export function filterMatches(list: Match[], f: Filters) {
  const out = list.filter((m) => (f.mode === 'all' || m.mode === f.mode) && (!f.map || m.map === f.map));
  return f.last ? out.slice(0, f.last) : out;
}

export function summarize(list: Match[]) {
  const s = { n: list.length, w: 0, l: 0, t: 0, k: 0, d: 0, a: 0, hs: 0, mvp: 0, demo: 0, rounds: 0, dmg: 0, kastR: 0, ud: 0, shots: 0, hits: 0, hh: 0, fk: 0, fd: 0, ef: 0, fa: 0, tk: 0, clA: 0, clW: 0, mk: { 2: 0, 3: 0, 4: 0, 5: 0 } as Record<string, number> };
  for (const m of list) {
    if (m.result === 'W') s.w++; else if (m.result === 'L') s.l++; else if (m.result === 'T') s.t++;
    const me = m.me;
    if (!me) continue;
    s.k += me.k || 0; s.d += me.d || 0; s.a += me.a || 0; s.hs += me.hs || 0; s.mvp += me.mvp || 0;
    if (!m.demo || !m.rounds) continue;
    s.demo++;
    s.rounds += m.rounds;
    s.dmg += me.dmg ?? Math.round((me.adr || 0) * m.rounds);
    s.kastR += ((me.kast || 0) * m.rounds) / 100;
    s.ud += me.ud || 0; s.shots += me.shots || 0; s.hits += me.hits || 0; s.hh += me.hh || 0;
    s.fk += me.fk || 0; s.fd += me.fd || 0; s.ef += me.ef || 0; s.fa += me.fa || 0; s.tk += me.tk || 0;
    for (const x of ['2', '3', '4', '5']) s.mk[x] += me.mk?.[x] || 0;
    for (const [, [att, won]] of Object.entries(me.cl || {})) { s.clA += att; s.clW += won; }
  }
  const decided = s.w + s.l + s.t;
  return {
    ...s,
    winRate: decided ? s.w / decided : null,
    kd: s.d ? s.k / s.d : s.k ? s.k : null,
    hsp: s.k ? s.hs / s.k : null,
    adr: s.rounds ? s.dmg / s.rounds : null,
    kast: s.rounds ? s.kastR / s.rounds : null,
    acc: s.shots ? s.hits / s.shots : null,
    headAcc: s.hits ? s.hh / s.hits : null,
    fkRate: s.fk + s.fd ? s.fk / (s.fk + s.fd) : null,
    udr: s.rounds ? s.ud / s.rounds : null,
  };
}

export function byMap(list: Match[]) {
  const g = new Map<string, { map: string; n: number; w: number; l: number; t: number; k: number; d: number; rounds: number; dmg: number }>();
  for (const m of list) {
    const key = m.map || '';
    const x = g.get(key) || { map: key, n: 0, w: 0, l: 0, t: 0, k: 0, d: 0, rounds: 0, dmg: 0 };
    x.n++;
    if (m.result === 'W') x.w++; else if (m.result === 'L') x.l++; else if (m.result === 'T') x.t++;
    x.k += m.me?.k || 0; x.d += m.me?.d || 0;
    if (m.demo && m.rounds && m.me) { x.rounds += m.rounds; x.dmg += m.me.dmg ?? Math.round((m.me.adr || 0) * m.rounds); }
    g.set(key, x);
  }
  return [...g.values()].sort((a, b) => b.n - a.n || b.w - a.w);
}

export function byWeapon(list: Match[]) {
  const g = new Map<string, WeaponStats & { w: string }>();
  for (const m of list) {
    for (const [w, v] of Object.entries(m.me?.weapons || {})) {
      const x = g.get(w) || { w, k: 0, hs: 0, shots: 0, hits: 0, dmg: 0 };
      x.k += v.k || 0; x.hs += v.hs || 0; x.shots += v.shots || 0; x.hits += v.hits || 0; x.dmg += v.dmg || 0;
      g.set(w, x);
    }
  }
  return [...g.values()].filter((x) => x.k || x.dmg).sort((a, b) => b.k - a.k || b.dmg - a.dmg);
}

/** Premier rating after each match (oldest → newest), one point per match */
export function ratingSeries(list: Match[]) {
  const pts = list
    .filter((m) => m.mode === 'premier' && m.date && (m.rating?.after || m.rating?.before))
    .map((m) => ({ t: Math.floor(Date.parse(m.date!) / 1000), value: (m.rating!.after || m.rating!.before) as number, m }))
    .sort((a, b) => a.t - b.t);
  let prev = -Infinity;
  for (const p of pts) { if (p.t <= prev) p.t = prev + 1; prev = p.t; }
  return pts;
}

// ---------------------------------------------------------------- formatting
const f1 = (x: number | null | undefined) => (x == null ? '—' : x.toFixed(1));
const f2 = (x: number | null | undefined) => (x == null ? '—' : x.toFixed(2));
const pc = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const signed = (x: number) => (x > 0 ? `+${x}` : `${x}`);
const dateRu = (iso: string | null, withTime = true) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', withTime ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'long', year: 'numeric' });
};
const resultRu = { W: 'Победа', L: 'Поражение', T: 'Ничья' } as const;
const resultClass = (r: Match['result']) => (r === 'W' ? 'w' : r === 'L' ? 'l' : 't');

function RatingNum({ value, size = 'l' }: { value: number | null | undefined; size?: 'l' | 's' }) {
  if (!value) return <span className={`mm-rn mm-rn-${size} muted`}>—</span>;
  const head = Math.floor(value / 1000);
  const tail = String(value % 1000).padStart(3, '0');
  return (
    <span className={`mm-rn mm-rn-${size}`} style={{ ['--rc' as string]: ratingColor(value) }} title={`CS Rating ${value.toLocaleString('ru-RU')}`}>
      {head ? <>{head}<small>,{tail}</small></> : <>{value}</>}
    </span>
  );
}

function Delta({ v }: { v: number | null | undefined }) {
  if (v == null) return null;
  return <span className={`num mm-delta ${v > 0 ? 'good' : v < 0 ? 'bad' : 'muted'}`}>{signed(v)}</span>;
}

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

// ---------------------------------------------------------------- component
export default function MyMatches({ steamid }: { steamid: string }) {
  const file = useAsync<MatchesFile | null>(
    () => fetch(dataUrl(steamid), { cache: 'no-cache' }).then((r) => (r.ok ? (r.json() as Promise<MatchesFile>) : null)).catch(() => null),
    [steamid],
  );
  const [filters, setFilters] = useLocal<Filters>('my-matches-filters', { mode: 'all', map: '', last: 50 });
  const all = useMemo(() => (file.data?.matches || []).filter((m) => m && typeof m === 'object'), [file.data]);
  const list = useMemo(() => filterMatches(all, filters), [all, filters]);
  const maps = useMemo(() => byMap(all).map((x) => x.map).filter(Boolean), [all]);
  const modes = useMemo(() => new Set(all.map((m) => m.mode)), [all]);
  const sum = useMemo(() => summarize(list), [list]);
  const premier = useMemo(() => ratingSeries(filterMatches(all, { mode: 'premier', map: '', last: 0 })), [all]);

  if (file.loading) return <Spinner />;
  if (!file.data || !all.length) {
    return (
      <section className="mm">
        <Head file={file.data} count={0} />
        <div className="card pad mm-empty">
          <div className="mm-empty-mark" aria-hidden>
            <span /><span /><span /><span /><span />
          </div>
          <h3>Статистика матчей появится после первой синхронизации</h3>
          <p className="small muted">
            Новые матчи Premier, соревновательного режима и напарников подтягиваются автоматически каждые 30 минут: счёт и рейтинг, K/D, ADR, HS, KAST, первые дуэли, клатчи, оружие и полный состав обеих команд из демки матча.
          </p>
        </div>
      </section>
    );
  }
  const set = (p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p }));
  const current = premier.length ? premier[premier.length - 1] : null;
  const peak = premier.reduce((mx, p) => Math.max(mx, p.value, p.m.rating?.before || 0), 0);
  return (
    <section className="mm">
      <Head file={file.data} count={all.length} />
      <div className="card pad mm-filters">
        <div className="seg mm-seg">
          {MODES.filter((m) => m.k === 'all' || modes.has(m.k)).map((m) => (
            <button key={m.k} className={filters.mode === m.k ? 'on' : ''} onClick={() => set({ mode: m.k })}>
              {m.short ? <><span className="mm-long">{m.ru}</span><span className="mm-short">{m.short}</span></> : m.ru}
            </button>
          ))}
        </div>
        <select className="select small" value={filters.map} onChange={(e) => set({ map: e.target.value })} aria-label="Карта">
          <option value="">Все карты</option>
          {maps.map((m) => <option key={m} value={m}>{mapName(m)}</option>)}
        </select>
        <div className="seg mm-seg">
          {[20, 50, 0].map((n) => <button key={n} className={filters.last === n ? 'on' : ''} onClick={() => set({ last: n })}>{n ? <><span className="mm-long">Последние </span>{n}</> : 'Все'}</button>)}
        </div>
        <span className="small muted mm-count">{list.length} из {all.length}</span>
      </div>

      {!list.length ? (
        <div className="card pad mm-empty"><h3>Нет матчей с такими фильтрами</h3><button className="btn small" onClick={() => setFilters({ mode: 'all', map: '', last: 50 })}>Сбросить фильтры</button></div>
      ) : (
        <>
          <div className="mm-top">
            <div className="card pad mm-rating">
              <div className="mm-rating-head">
                <div className="stack" style={{ gap: 2 }}>
                  <span className="tiny muted mm-label">Рейтинг Premier</span>
                  <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                    <RatingNum value={current?.value} />
                    {current?.m.rating?.delta != null && <Delta v={current.m.rating.delta} />}
                  </div>
                </div>
                {premier.length > 0 && (
                  <div className="mm-rating-meta small">
                    <span><span className="muted">Пик</span> <b>{peak.toLocaleString('ru-RU')}</b></span>
                    <span><span className="muted">Матчей</span> <b className="num">{premier.length}</b></span>
                    {current?.m.rating?.wins ? <span><span className="muted">Побед</span> <b className="num">{current.m.rating.wins}</b></span> : null}
                  </div>
                )}
              </div>
              {premier.length >= 2 ? (
                <RatingChart points={premier} />
              ) : (
                <div className="notice small">{premier.length ? 'График появится после второго матча в Premier.' : 'Рейтинг Premier появится после первого матча в Premier с доступной демкой.'}</div>
              )}
              <Form list={list.slice(0, 20)} />
            </div>
            <Summary s={sum} />
          </div>

          <div className="mm-two">
            <MapsCard list={list} />
            <WeaponsCard list={list} />
          </div>

          <MatchList list={list} steamid={steamid} />
          <p className="tiny faint">
            Счёт, K/D/A и MVP — от координатора CS2, остальное посчитано по демке матча (Valve хранит демки несколько недель; у более старых матчей — только данные координатора). Рейтинг после матча — прогноз игры для этого результата. ADR, KAST, точность и урон гранатами — только по матчам с демкой.
          </p>
        </>
      )}
    </section>
  );
}

function Head({ file, count }: { file: MatchesFile | null; count: number }) {
  return (
    <div className="row between mm-head">
      <div className="stack" style={{ gap: 2 }}>
        <h2>Мои матчи</h2>
        <span className="small muted">
          {file?.name ? <b className="mm-name">{file.name}</b> : null}
          {file?.name ? ' · ' : ''}
          {count ? `${count} ${plural(count, 'матч', 'матча', 'матчей')}` : 'Premier, соревновательный и напарники'}
          {file?.updated ? ` · обновлено ${dateRu(file.updated)}` : ''}
        </span>
      </div>
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

function Form({ list }: { list: Match[] }) {
  if (!list.length) return null;
  return (
    <div className="mm-form-wrap">
      <span className="tiny muted mm-label">Последние {list.length}</span>
      <div className="mm-form">
        {[...list].reverse().map((m) => (
          <span key={m.id || m.code} className={`mm-chip-${resultClass(m.result)}`} title={`${dateRu(m.date)} · ${mapName(m.map)} · ${m.score ? m.score.join(':') : ''}`}>
            {m.result === 'W' ? 'В' : m.result === 'L' ? 'П' : 'Н'}
          </span>
        ))}
      </div>
    </div>
  );
}

function Summary({ s }: { s: ReturnType<typeof summarize> }) {
  const items: [string, string, string?][] = [
    ['Матчей', String(s.n), `${s.w} В · ${s.l} П${s.t ? ` · ${s.t} Н` : ''}`],
    ['Винрейт', pc(s.winRate)],
    ['K/D', f2(s.kd), `${s.k} / ${s.d}`],
    ['ADR', f1(s.adr), 'урон за раунд'],
    ['HS', pc(s.hsp), 'убийств в голову'],
    ['KAST', pc(s.kast), 'раундов с вкладом'],
    ['Точность', pc(s.acc), s.headAcc != null ? `в голову ${pc(s.headAcc)}` : undefined],
    ['Первые дуэли', pc(s.fkRate), s.fk + s.fd ? `${s.fk} из ${s.fk + s.fd}` : undefined],
    ['Урон гранатами', f1(s.udr), 'за раунд'],
    ['Клатчи', s.clA ? `${s.clW}/${s.clA}` : '—', s.clA ? `выиграно ${pct(s.clW, s.clA)}` : undefined],
    ['Мультикиллы', String(s.mk[3] + s.mk[4] + s.mk[5]), `3K ${s.mk[3]} · 4K ${s.mk[4]} · эйсов ${s.mk[5]}`],
    ['MVP', String(s.mvp), s.n ? `${f1(s.mvp / s.n)} за матч` : undefined],
  ];
  return (
    <div className="card pad mm-kpis">
      {items.map(([k, v, t]) => (
        <div key={k} className="mm-kpi">
          <span className="tiny muted">{k}</span>
          <b className="num">{v}</b>
          {t ? <span className="tiny faint">{t}</span> : <span className="tiny faint">&nbsp;</span>}
        </div>
      ))}
    </div>
  );
}

function RatingChart({ points }: { points: ReturnType<typeof ratingSeries> }) {
  const ref = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const { theme } = usePrefs();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: css('--muted'), fontFamily: 'Inter, system-ui, sans-serif', attributionLogo: true },
      grid: { vertLines: { color: 'transparent' }, horzLines: { color: css('--border') } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { mode: 0, vertLine: { color: css('--faint'), labelVisible: false }, horzLine: { color: css('--faint') } },
      handleScroll: false,
      handleScale: false,
      localization: { locale: 'ru-RU', priceFormatter: (v: number) => Math.round(v).toLocaleString('ru-RU') },
    });
    const line = chart.addSeries(LineSeries, { color: css('--accent'), lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 5 });
    line.setData(points.map((p) => ({ time: p.t as UTCTimestamp, value: p.value })));
    const good = css('--good'), bad = css('--bad'), muted = css('--muted');
    createSeriesMarkers(line, points.map((p): SeriesMarker<Time> => ({ time: p.t as UTCTimestamp, position: 'inBar', shape: 'circle', size: 0.5, color: p.m.result === 'W' ? good : p.m.result === 'L' ? bad : muted })));
    chart.timeScale().fitContent();
    const byTime = new Map(points.map((p) => [p.t, p]));
    chart.subscribeCrosshairMove((param) => {
      const box = tip.current;
      if (!box) return;
      const p = param.time != null ? byTime.get(param.time as number) : undefined;
      if (!p || !param.point) { box.style.display = 'none'; return; }
      const m = p.m;
      box.innerHTML = '';
      const add = (cls: string, text: string) => { const s = document.createElement('div'); s.className = cls; s.textContent = text; box.appendChild(s); };
      add('tiny muted', dateRu(m.date));
      add('small', `${mapName(m.map)} · ${m.score ? m.score.join(':') : '—'} · ${m.result ? resultRu[m.result] : ''}`);
      add('small num', `${p.value.toLocaleString('ru-RU')}${m.rating?.delta != null ? ` (${signed(m.rating.delta)})` : ''}`);
      box.style.display = 'block';
      const w = el.clientWidth;
      const x = Math.min(Math.max(param.point.x + 12, 0), Math.max(0, w - 190));
      box.style.left = `${x}px`;
      box.style.top = `${Math.max(param.point.y - 70, 0)}px`;
    });
    return () => chart.remove();
  }, [points, theme]);
  return (
    <div className="mm-chart">
      <div ref={ref} style={{ position: 'absolute', inset: 0 }} />
      <div ref={tip} className="mm-tip" style={{ display: 'none' }} />
    </div>
  );
}

function MapsCard({ list }: { list: Match[] }) {
  const rows = byMap(list);
  return (
    <div className="card">
      <div className="card-head"><h3>Карты</h3><span className="small muted">{rows.length}</span></div>
      <div className="table-wrap">
        <table className="table mm-table">
          <thead><tr><th>Карта</th><th className="r" title="Матчей">Игр</th><th>Винрейт</th><th className="r">K/D</th><th className="r">ADR</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const wr = r.w + r.l + r.t ? r.w / (r.w + r.l + r.t) : 0;
              return (
                <tr key={r.map || '?'}>
                  <td><b>{mapName(r.map || null)}</b></td>
                  <td className="r num">{r.n}</td>
                  <td>
                    <div className="mm-wr">
                      <div className="bar"><div style={{ width: `${Math.round(wr * 100)}%`, background: wr >= 0.5 ? 'var(--good)' : 'var(--bad)' }} /></div>
                      <span className="num small">{Math.round(wr * 100)}%</span>
                      <span className="tiny faint num">{r.w}–{r.l}{r.t ? `–${r.t}` : ''}</span>
                    </div>
                  </td>
                  <td className="r num">{f2(r.d ? r.k / r.d : r.k)}</td>
                  <td className="r num">{r.rounds ? f1(r.dmg / r.rounds) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WeaponsCard({ list }: { list: Match[] }) {
  const rows = byWeapon(list);
  const [all, setAll] = useState(false);
  const total = rows.reduce((a, r) => a + r.k, 0);
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <div className="card">
      <div className="card-head"><h3>Оружие</h3><span className="small muted">по матчам с демкой</span></div>
      {!rows.length ? <div className="empty small">Нет матчей с демкой</div> : (
        <>
          <div className="table-wrap">
            <table className="table mm-table">
              <thead><tr><th>Оружие</th><th className="r">Убийств</th><th className="r">HS</th><th className="r" title="Точность: попаданий по врагам на выстрел">Точн.</th><th className="r">Урон</th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.w}>
                    <td>
                      <div className="mm-wpn">
                        <b>{weaponName(r.w)}</b>
                        <div className="bar"><div style={{ width: `${total ? Math.round((r.k / total) * 100) : 0}%` }} /></div>
                      </div>
                    </td>
                    <td className="r num">{r.k}</td>
                    <td className="r num">{r.k && !UTILITY.has(r.w) ? pct(r.hs, r.k) : '—'}</td>
                    <td className="r num">{UTILITY.has(r.w) || r.w === 'knife' || !r.shots ? '—' : pct(r.hits, r.shots)}</td>
                    <td className="r num">{r.dmg.toLocaleString('ru-RU')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 8 && <div className="pad" style={{ padding: '10px 14px' }}><button className="btn small ghost" onClick={() => setAll(!all)}>{all ? 'Свернуть' : `Всё оружие (${rows.length})`}</button></div>}
        </>
      )}
    </div>
  );
}

function MatchList({ list, steamid }: { list: Match[]; steamid: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(25);
  return (
    <div className="card">
      <div className="card-head"><h3>Матчи</h3><span className="small muted">{list.length}</span></div>
      <div className="mm-list" role="list">
        <div className="mm-row mm-row-head tiny muted" aria-hidden>
          <span /><span>Матч</span><span className="r">Счёт</span><span className="r">K–D–A</span><span className="r">K/D</span><span className="r">ADR</span><span className="r">HS</span><span className="r">KAST</span><span className="r">Рейтинг</span><span />
        </div>
        {list.slice(0, limit).map((m) => {
          const key = m.id || m.code;
          const me = m.me;
          const isOpen = open === key;
          return (
            <Fragment key={key}>
              <button type="button" role="listitem" className={`mm-row ${isOpen ? 'open' : ''}`} onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}>
                <span className={`mm-strip mm-bg-${resultClass(m.result)}`} />
                <span className="mm-what">
                  <b>{mapName(m.map)}</b>
                  <span className="tiny muted">{dateRu(m.date)} · {MODE_RU[m.mode] || m.mode}{m.demo ? '' : ' · без демки'}</span>
                </span>
                <span className={`r num mm-score mm-fg-${resultClass(m.result)}`}>{m.score ? `${m.score[0]}:${m.score[1]}` : '—'}</span>
                <span className="r num mm-kda">{me ? `${me.k}–${me.d}–${me.a}` : '—'}{me?.adr != null ? <span className="mm-kda-x"> · ADR {f1(me.adr)}</span> : null}</span>
                <span className={`r num mm-c-kd ${me && me.k > me.d ? 'good' : me && me.k < me.d ? 'bad' : ''}`}>{me ? f2(me.d ? me.k / me.d : me.k) : '—'}</span>
                <span className="r num mm-c-adr">{me?.adr != null ? f1(me.adr) : '—'}</span>
                <span className="r num mm-c-hs">{me && me.k ? pct(me.hs, me.k) : '—'}</span>
                <span className="r num mm-c-kast">{me?.kast != null ? `${Math.round(me.kast)}%` : '—'}</span>
                <span className="r mm-c-rating">{m.rating && m.rating.type === 'premier' ? <><RatingNum value={m.rating.after || m.rating.before} size="s" /> <Delta v={m.rating.delta} /></> : m.rating && m.rating.before ? <span className="tiny muted">{SKILL_GROUPS[m.rating.before] || `ранг ${m.rating.before}`}</span> : <span className="muted">—</span>}</span>
                <span className="mm-chev" aria-hidden>{isOpen ? '▴' : '▾'}</span>
              </button>
              {isOpen && <MatchDetail m={m} steamid={steamid} />}
            </Fragment>
          );
        })}
      </div>
      {list.length > limit && <div style={{ padding: '10px 14px' }}><button className="btn small" onClick={() => setLimit(limit + 25)}>Показать ещё ({list.length - limit})</button></div>}
    </div>
  );
}

function MatchDetail({ m, steamid }: { m: Match; steamid: string }) {
  const me = m.me;
  const half = m.mode === 'wingman' ? 8 : 12;
  const facts: [string, string][] = [];
  if (me && m.demo) {
    const mk = me.mk || {};
    const mks = ['2', '3', '4', '5'].filter((x) => mk[x]).map((x) => `${x === '5' ? 'эйс' : x + 'K'} ×${mk[x]}`);
    facts.push(['Мультикиллы', mks.length ? mks.join(', ') : '—']);
    const cl = Object.entries(me.cl || {});
    facts.push(['Клатчи', cl.length ? cl.map(([x, [a, w]]) => `1v${x}: ${w}/${a}`).join(', ') : '—']);
    const fk = me.fk ?? 0, fd = me.fd ?? 0;
    facts.push(['Первые дуэли', `${fk} ${plural(fk, 'убийство', 'убийства', 'убийств')} / ${fd} ${plural(fd, 'смерть', 'смерти', 'смертей')}`]);
    facts.push(['Размены', String(me.tk ?? 0)]);
    facts.push(['Урон гранатами', String(me.ud ?? 0)]);
    facts.push(['Ослеплено врагов', `${me.ef ?? 0}${me.fa ? ` · флеш-ассистов ${me.fa}` : ''}`]);
    if (me.shots) facts.push(['Точность', `${pct(me.hits || 0, me.shots)} (${me.hits}/${me.shots}), в голову ${pct(me.hh || 0, me.hits || 0)}`]);
  }
  if (m.duration) facts.push(['Длительность', `${Math.round(m.duration / 60)} мин`]);
  if (m.rating?.before) {
    facts.push([m.rating.type === 'premier' ? 'Рейтинг' : 'Звание', m.rating.type === 'premier'
      ? `${m.rating.before.toLocaleString('ru-RU')} → ${m.rating.after ? m.rating.after.toLocaleString('ru-RU') : '?'}`
      : `${SKILL_GROUPS[m.rating.before] || m.rating.before}${m.rating.after && m.rating.after !== m.rating.before ? ` → ${SKILL_GROUPS[m.rating.after] || m.rating.after}` : ''}`]);
  }
  const teams = [0, 1].map((t) => m.players.filter((p) => p.team === t));
  const premierSb = m.mode === 'premier' && m.players.some((p) => p.rank);
  const cols = 8 + (premierSb ? 1 : 0) + (m.demo ? 2 : 0);
  return (
    <div className="mm-detail">
      {m.rh ? (
        <div className="mm-rh-wrap">
          <span className="tiny muted mm-label">Раунды</span>
          <div className="mm-rh">
            {m.rh.split('').map((c, i) => (
              <Fragment key={i}>
                {i === half || (i >= 2 * half && (i - 2 * half) % 3 === 0) ? <span className="mm-rh-sep" title={i < 2 * half ? 'Смена сторон' : 'Овертайм'} /> : null}
                <i className={c === 'W' ? 'mm-bg-w' : 'mm-bg-l'} title={`Раунд ${i + 1}: ${c === 'W' ? 'выигран' : 'проигран'}`} />
              </Fragment>
            ))}
          </div>
        </div>
      ) : null}
      {facts.length > 0 && (
        <dl className="mm-facts">
          {facts.map(([k, v]) => <div key={k}><dt className="tiny muted">{k}</dt><dd className="small">{v}</dd></div>)}
        </dl>
      )}
      {!m.demo && <div className="notice small">Демку этого матча Valve уже удалила — показана статистика координатора игры (счёт, K/D/A, HS, MVP).</div>}
      {m.players.length > 0 && (
        <div className="table-wrap mm-sb">
          <table className="table mm-table mm-sb-table">
            <thead><tr><th>Игрок</th>{premierSb && <th className="r">Рейтинг</th>}<th className="r">K</th><th className="r">D</th><th className="r">A</th><th className="r">+/−</th>{m.demo && <><th className="r">ADR</th><th className="r">KAST</th></>}<th className="r">HS</th><th className="r">MVP</th><th className="r">Очки</th></tr></thead>
            {teams.map((ps, t) => ps.length ? (
              <tbody key={t}>
                <tr className="mm-sb-team">
                  <td colSpan={cols}><b className={t === 0 ? 'mm-fg-us' : 'mm-fg-them'}>{t === 0 ? 'Наша команда' : 'Соперники'}</b>{m.score ? <span className="num muted"> · {m.score[t]}</span> : null}</td>
                </tr>
                {ps.map((p) => (
                  <tr key={p.sid} className={p.sid === steamid ? 'mm-me' : ''}>
                    <td className="mm-pname"><a href={`https://steamcommunity.com/profiles/${p.sid}`} target="_blank" rel="noreferrer">{p.name || `…${p.sid.slice(-5)}`}</a></td>
                    {premierSb && <td className="r"><RatingNum value={p.rank} size="s" /></td>}
                    <td className="r num">{p.k}</td>
                    <td className="r num">{p.d}</td>
                    <td className="r num">{p.a}</td>
                    <td className={`r num ${p.k - p.d > 0 ? 'good' : p.k - p.d < 0 ? 'bad' : 'muted'}`}>{signed(p.k - p.d)}</td>
                    {m.demo && <><td className="r num">{p.adr != null ? f1(p.adr) : '—'}</td><td className="r num">{p.kast != null ? `${Math.round(p.kast)}%` : '—'}</td></>}
                    <td className="r num">{p.k ? pct(p.hs, p.k) : '—'}</td>
                    <td className="r num">{p.mvp ?? '—'}</td>
                    <td className="r num">{p.score ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            ) : null)}
          </table>
        </div>
      )}
      <div className="row mm-actions">
        <a className="btn small" href={`steam://rungame/730/76561202255233023/+csgo_download_match%20${encodeURIComponent(m.code)}`} title="Откроет CS2 и загрузит запись матча, пока Valve её хранит">Смотреть в CS2</a>
        <button className="btn small ghost" onClick={() => copy(m.code, 'Код матча скопирован')}>Копировать код матча</button>
        <span className="tiny faint mono mm-code">{m.code}</span>
      </div>
    </div>
  );
}
