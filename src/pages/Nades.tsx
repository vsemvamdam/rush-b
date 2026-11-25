import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { usePanZoom } from '../lib/panzoom';
import { Spinner } from '../components/ui';
import { copy, useAsync } from '../lib/hooks';
import { extUrl, href, setQuery, useRoute } from '../lib/router';
import { loadGrid, placeName, useCalloutLang, useNames, type CalloutGrid, type NamesFile } from '../lib/callouts';
import type { Throw } from '../lib/map3d'; // type only: three.js stays in the lazily loaded Replay3D chunk
import '../styles/nades.css';

const Replay3D = lazy(() => import('../components/Replay3D'));
const MAPS3D = ['de_mirage', 'de_inferno', 'de_nuke', 'de_ancient', 'de_anubis', 'de_dust2', 'de_cache'];
const hasMap3D = (m: string) => MAPS3D.includes(m);

type MapInfo = { id: string; name: string; pos_x: number; pos_y: number; scale: number; radar: string; active?: boolean; lower?: { z_max: number; radar: string } };
/** library of lineups built by tools/demos/build_lineups.py from every parsed pro demo (v2 and v3 files) */
type Lineup = {
  id: string; type: string; side: 'T' | 'CT'; n: number; np: number;
  from: [number, number, number]; ang: [number, number]; land: [number, number, number];
  move: string; moves: Record<string, number>; time: number; traj: number[][];
  ex: [number, number, number][]; // [player, match, round] — latest few
  pp?: number[]; ms?: number[]; // all players / matches of the lineup (v3)
  t?: number; pf?: string; pl?: string; btn?: string; dur?: number;
  fw?: number; // median speed along the aim at the release, u/s (≥ 60 = W held), from the trajectories
};
type Target = [string, number, number, number, string, number]; // type, x, y, z, place, n
type MapFile = { v: number; map: string; updated: string; demos: number; throws: number; players: [string, string][]; matches: [string, string, string, string][]; targets?: Target[]; lineups: Lineup[] };
type IndexFile = { updated: string; maps: { map: string; demos: number; throws: number; lineups: number }[] };
/** one pro's throw of a lineup: player, match, round, time, move, btn, fx, fy, fz, pitch, yaw, lx, ly, lz, dur, traj */
type Detail = [number, number, number, number, string, string, number, number, number, number, number, number, number, number, number, number[][]];

const DATA = import.meta.env.BASE_URL + 'data/nades/';
export const NADE_TYPES: Record<string, { ru: string; one: string; color: string }> = {
  smoke: { ru: 'Смоки', one: 'Смок', color: '#c9d1d9' },
  flash: { ru: 'Флешки', one: 'Флешка', color: '#ffe066' },
  molotov: { ru: 'Молотовы', one: 'Молотов', color: '#ff7b3a' },
  he: { ru: 'Гранаты', one: 'Граната', color: '#ff4d6d' },
  decoy: { ru: 'Ложные', one: 'Ложная', color: '#9aa5b1' },
};
const MOVES: Record<string, string> = { stand: 'Стоя', crouch: 'Присев', jump: 'Бросок в прыжке', run: 'На бегу', walk: 'Шагом', runjump: 'Разбег + прыжок' };
const BTN: Record<string, string> = { L: 'Левый клик', R: 'Правый клик', LR: 'Левый + правый клик' };

async function getJSON<T>(f: string): Promise<T> {
  const r = await fetch(DATA + f);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
const detailCache = new Map<string, Promise<Record<string, Detail[]>>>();
function loadDetails(map: string, id: string) {
  const k = `${map}/${id[0]}`;
  let p = detailCache.get(k);
  if (!p) {
    p = getJSON<Record<string, Detail[]>>(`x/${k}.json`).catch(() => ({}));
    detailCache.set(k, p);
  }
  return p.then((d) => d[id] || null);
}
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** key presses for a throw, like cs2util: «Левый клик + W + Бросок в прыжке» */
export const W_SPEED = 60;
export function combo(move: string, btn?: string, fw?: number) {
  const b = btn ? BTN[btn] : '';
  const w = fw != null && fw >= W_SPEED;
  const m: Record<string, string[]> = {
    stand: w ? ['Зажать W'] : [], crouch: w ? ['Присесть', 'Зажать W'] : ['Присесть'], walk: ['Шаг (Shift)', 'W'], run: ['Бег (W)'],
    jump: w ? ['Зажать W', 'Бросок в прыжке'] : ['Бросок в прыжке'], runjump: ['Разбег (W)', 'Бросок в прыжке'],
  };
  return [b, ...(m[move] || [])].filter(Boolean);
}

function lineupTitle(l: Lineup, names: NamesFile | null, map: string, lang: 'en' | 'ru') {
  const to = placeName(names, map, l.pl || '', lang);
  const from = placeName(names, map, l.pf || '', lang);
  return { title: `${NADE_TYPES[l.type]?.one || l.type}${to ? ` → ${to}` : ''}`, from: from ? `с ${from}` : '' };
}

const FAV_KEY = 'nades-fav';
function useFavs(): [Set<string>, (id: string) => void] {
  const [s, setS] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { return new Set(); }
  });
  return [s, (id) => setS((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    try { localStorage.setItem(FAV_KEY, JSON.stringify([...n])); } catch { /* private mode */ }
    return n;
  })];
}

export default function Nades({ map }: { map?: string }) {
  const maps = useAsync(() => getJSON<MapInfo[] | { maps: MapInfo[] }>('maps.json').then((j) => (Array.isArray(j) ? j : j.maps)), []);
  const index = useAsync(() => getJSON<IndexFile>('index.json').catch(() => null), []);
  if (maps.loading) return <Spinner />;
  const list = maps.data || [];
  const m = map ? list.find((x) => x.id === map) : null;
  if (map && m) return <MapView m={m} maps={list} />;
  const stat = (id: string) => index.data?.maps.find((x) => x.map === id);
  const total = index.data?.maps.reduce((a, x) => ({ demos: a.demos + x.demos, throws: a.throws + x.throws, lineups: a.lineups + x.lineups }), { demos: 0, throws: 0, lineups: 0 });
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="stack" style={{ gap: 6 }}>
        <h1>Раскидки профи</h1>
        <p className="muted">Все гранаты из про-матчей HLTV, сгруппированные в раскидки: откуда кидали, куда упало, кто из профи так кидает и как часто. Каждую можно посмотреть в 3D прямо на сайте — от первого лица, с позиции и в полёте — и скачать видео, а <span className="kbd">setpos</span>/<span className="kbd">setang</span> поставят вас в ту же точку на своём сервере.</p>
        {total && total.throws > 0 && <p className="small muted"><b className="num">{total.lineups.toLocaleString('ru-RU')}</b> раскидок из <b className="num">{total.throws.toLocaleString('ru-RU')}</b> бросков в <b className="num">{total.demos.toLocaleString('ru-RU')}</b> картах про-матчей · обновлено {new Date(index.data!.updated).toLocaleDateString('ru-RU')}</p>}
      </div>
      <div className="feature-grid">
        {[...list].sort((a, b) => Number(!!b.active) - Number(!!a.active)).map((x) => {
          const s = stat(x.id);
          return (
            <a key={x.id} className="feature" href={href(`/nades/${x.id}`)} style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ aspectRatio: '16 / 9', background: '#0b0d10', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
                <img src={x.radar} alt={x.name} loading="lazy" style={{ width: '70%', opacity: 0.9 }} />
              </div>
              <div style={{ padding: '12px 16px' }} className="stack">
                <div className="row between"><h3>{x.name}</h3>{x.active ? <span className="badge gold">Active Duty</span> : <span className="badge">Резерв</span>}</div>
                <span className="tiny muted">{s ? `${s.lineups.toLocaleString('ru-RU')} раскидок · ${s.demos} матчей` : 'пока нет данных'}</span>
              </div>
            </a>
          );
        })}
      </div>
      <div className="card pad stack small">
        <h3>Откуда данные</h3>
        <p className="muted">Каждая турнирная демка разбирается целиком: игрок, команда, сторона, раунд, позиция и углы в момент броска, кнопка (по скорости вылета гранаты), прыжок/бег, траектория в 3D и точка взрыва, название места. Одинаковые броски (та же точка, то же место падения) объединяются в раскидку; разовые ситуативные броски в библиотеку не попадают.</p>
        <p className="muted">Демки: открытый датасет <a className="link" href="https://huggingface.co/datasets/blanchon/opencs2_dataset_demo" target="_blank" rel="noreferrer">OpenCS2</a> (CC BY 4.0, зеркало демок HLTV) и про-демки <a className="link" href="https://github.com/pnxenopoulos/awpy-fixtures" target="_blank" rel="noreferrer">awpy-fixtures</a>; разбор — demoparser2 (MIT). 3D-геометрия карт — <a className="link" href="https://github.com/pnxenopoulos/awpy-data" target="_blank" rel="noreferrer">awpy-data</a>, карты © Valve.</p>
      </div>
    </div>
  );
}

function project(m: MapInfo, x: number, y: number) {
  return { px: (x - m.pos_x) / m.scale, py: (m.pos_y - y) / m.scale };
}

/** v2 files have no targets: group by type + landing point here */
function computeTargets(ls: Lineup[]): Target[] {
  const out: Target[] = [];
  for (const l of ls) {
    let ti = out.findIndex((t) => t[0] === l.type && Math.hypot(t[1] - l.land[0], t[2] - l.land[1]) <= 128 && Math.abs(t[3] - l.land[2]) < 160);
    if (ti < 0) { ti = out.length; out.push([l.type, l.land[0], l.land[1], l.land[2], l.pl || '', 0]); }
    out[ti][5] += l.n;
    l.t = ti;
  }
  return out;
}

function MapView({ m, maps }: { m: MapInfo; maps: MapInfo[] }) {
  const { query } = useRoute();
  const data = useAsync(() => getJSON<MapFile>(`${m.id}.json`).then((d) => (d.lineups ? d : null)).catch(() => null), [m.id]);
  const grid = useAsync(() => loadGrid(m.id), [m.id]);
  const names = useNames();
  const [lang, setLang] = useCalloutLang();
  const [favs, toggleFav] = useFavs();
  const [showCallouts, setShowCallouts] = useState(true);
  const type = query.get('type') || '';
  const side = query.get('side') || '';
  const player = query.get('player') || '';
  const event = query.get('event') || '';
  const tab = query.get('tab') || 'all';
  const min = +(query.get('min') || 3);
  const tg = query.get('tg') === null ? -1 : +query.get('tg')!;
  const sel = query.get('id') || '';
  const d = data.data;

  const targets = useMemo(() => (d ? d.targets || computeTargets(d.lineups) : []), [d]);
  const playerIdx = useMemo(() => (d && player ? d.players.findIndex((p) => p[0] === player) : -1), [d, player]);
  const players = useMemo(() => {
    if (!d) return [];
    const c = new Map<number, number>();
    for (const l of d.lineups) for (const p of new Set(l.pp || l.ex.map((e) => e[0]))) c.set(p, (c.get(p) || 0) + 1);
    const byName = new Map<string, { name: string; team: string; n: number }>();
    for (const [i, n] of c) {
      const [name, team] = d.players[i];
      const x = byName.get(name);
      if (x) x.n += n; else byName.set(name, { name, team, n });
    }
    return [...byName.values()].sort((a, b) => b.n - a.n);
  }, [d]);
  const events = useMemo(() => (d ? [...new Set(d.matches.map((x) => x[1]).filter(Boolean))].sort() : []), [d]);
  const base = useMemo(() => {
    if (!d) return [];
    const pIdx = new Set(player ? d.players.map((p, i) => (p[0] === player ? i : -1)).filter((i) => i >= 0) : []);
    return d.lineups.filter((l) => {
      if (side && l.side !== side) return false;
      if (pIdx.size && !(l.pp || l.ex.map((e) => e[0])).some((p) => pIdx.has(p))) return false;
      if (event && !(l.ms || l.ex.map((e) => e[1])).some((m) => d.matches[m][1] === event)) return false;
      if (tab === 'fav' && !favs.has(l.id)) return false;
      if (!pIdx.size && tab !== 'fav' && l.n < min) return false;
      return true;
    });
  }, [d, side, player, event, min, tab, favs]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of base) c[l.type] = (c[l.type] || 0) + 1;
    return c;
  }, [base]);
  const list = useMemo(() => (type ? base.filter((l) => l.type === type) : base), [base, type]);
  const visTargets = useMemo(() => {
    const n = new Map<number, number>();
    for (const l of list) n.set(l.t!, (n.get(l.t!) || 0) + l.n);
    return [...n.entries()].map(([i, k]) => ({ i, t: targets[i], n: k })).filter((x) => x.t).sort((a, b) => a.n - b.n);
  }, [list, targets]);
  const tgLineups = useMemo(() => (tg >= 0 ? list.filter((l) => l.t === tg) : []), [list, tg]);
  const selected = d?.lineups.find((l) => l.id === sel) || null;
  const shownList = tg >= 0 ? tgLineups : list;
  const tgName = tg >= 0 && targets[tg] ? placeName(names, m.id, targets[tg][4], lang) : '';

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row between">
        <div className="stack" style={{ gap: 4 }}>
          <div className="small muted"><a className="link" href="#/nades">Раскидки</a> / {m.name}</div>
          <h1>{m.name}</h1>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {maps.filter((x) => x.active).map((x) => <a key={x.id} className={'chip' + (x.id === m.id ? ' on' : '')} href={href(`/nades/${x.id}`)}>{x.name}</a>)}
        </div>
      </div>

      {data.loading ? <Spinner /> : !d ? (
        <div className="notice">Для {m.name} раскидок пока нет — они появятся, когда в базу попадут про-демки на этой карте.</div>
      ) : (
        <div className="nd-layout">
          <aside className="nd-side card">
            <div className="nd-side-sec">
              <div className="tabs nd-tabs">
                <button className={tab === 'all' ? 'on' : ''} onClick={() => setQuery({ tab: null, tg: null })}>Профи</button>
                <button className={tab === 'fav' ? 'on' : ''} onClick={() => setQuery({ tab: 'fav', tg: null })}>Мой набор{favs.size ? ` · ${favs.size}` : ''}</button>
              </div>
            </div>
            <div className="nd-side-sec">
              <div className="nd-label">Граната</div>
              <div className="nd-types">
                <button className={!type ? 'on' : ''} onClick={() => setQuery({ type: null, tg: null })}>
                  <span>Все</span><b>{base.length}</b>
                </button>
                {['smoke', 'flash', 'molotov', 'he'].map((k) => (
                  <button key={k} className={type === k ? 'on' : ''} onClick={() => setQuery({ type: type === k ? null : k, tg: null })}>
                    <NadeIcon type={k} size={18} /><span>{NADE_TYPES[k].ru}</span><b>{counts[k] || 0}</b>
                  </button>
                ))}
              </div>
            </div>
            <div className="nd-side-sec">
              <div className="nd-label">Сторона</div>
              <div className="seg" style={{ width: '100%' }}>
                <button style={{ flex: 1 }} className={!side ? 'on' : ''} onClick={() => setQuery({ side: null, tg: null })}>Обе</button>
                <button style={{ flex: 1 }} className={side === 'T' ? 'on' : ''} onClick={() => setQuery({ side: 'T', tg: null })}>T</button>
                <button style={{ flex: 1 }} className={side === 'CT' ? 'on' : ''} onClick={() => setQuery({ side: 'CT', tg: null })}>CT</button>
              </div>
            </div>
            <div className="nd-side-sec stack" style={{ gap: 8 }}>
              <div className="nd-label">Фильтры</div>
              <select aria-label="Игрок" className="select small" value={player} onChange={(e) => setQuery({ player: e.target.value || null, tg: null })}>
                <option value="">Все игроки</option>
                {players.map((p) => <option key={p.name} value={p.name}>{p.name}{p.team ? ` (${p.team})` : ''} · {p.n}</option>)}
              </select>
              {events.length > 1 && (
                <select aria-label="Турнир" className="select small" value={event} onChange={(e) => setQuery({ event: e.target.value || null, tg: null })}>
                  <option value="">Все турниры</option>
                  {events.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
              )}
              {!player && tab !== 'fav' && (
                <label className="row small muted" style={{ gap: 6 }}>Популярность от
                  <select aria-label="Минимум бросков" className="select small" value={min} onChange={(e) => setQuery({ min: e.target.value })}>
                    {[3, 5, 10, 20, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>бросков
                </label>
              )}
            </div>
            <div className="nd-side-sec stack" style={{ gap: 8 }}>
              <div className="nd-label">Коллауты</div>
              <div className="row" style={{ gap: 6 }}>
                <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={showCallouts} onChange={(e) => setShowCallouts(e.target.checked)} /> на радаре</label>
                <div className="seg">
                  <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
                  <button className={lang === 'ru' ? 'on' : ''} onClick={() => setLang('ru')}>RU</button>
                </div>
              </div>
              <a className="link small" href={href(`/callouts/${m.id}`)}>Все коллауты {m.name} →</a>
            </div>
            <div className="nd-side-sec tiny muted">{d.lineups.length.toLocaleString('ru-RU')} раскидок · {d.throws.toLocaleString('ru-RU')} бросков · {d.demos} карт про-матчей</div>
          </aside>

          <div className="nd-main">
            <Radar m={m} targets={visTargets} tg={tg} lineups={tgLineups} selected={selected} grid={showCallouts ? grid.data || null : null} names={names} lang={lang}
              onTarget={(i) => setQuery({ tg: i === tg ? null : String(i), id: null })} onPick={(id) => setQuery({ id })} />
            <div className="tiny muted" style={{ marginTop: 6 }}>Кружки — куда падают гранаты (размер — сколько раз кидали). Нажмите на кружок: карта приблизится и покажет позиции, откуда его кидают; нажмите на позицию — откроется 3D-повтор. Приближение — колесо мыши или щипок двумя пальцами, перемещение — перетаскиванием, двойной клик или двойной тап — ближе.</div>
          </div>

          <div className="nd-list card">
            <div className="card-head">
              <h3>{tg >= 0 ? `${NADE_TYPES[targets[tg]?.[0]]?.one || ''}${tgName ? ` → ${tgName}` : ''}` : player ? `Раскидки ${player}` : tab === 'fav' ? 'Мой набор' : 'Популярные раскидки'}</h3>
              {tg >= 0 ? <button className="btn small ghost" onClick={() => setQuery({ tg: null })}>× все</button> : <span className="small muted">{list.length}</span>}
            </div>
            <div className="nd-list-body">
              {shownList.slice(0, 250).map((l) => {
                const t = lineupTitle(l, names, m.id, lang);
                const who = [...new Set(l.ex.map((e) => d.players[e[0]][0]))];
                return (
                  <button key={l.id} onClick={() => setQuery({ id: l.id, ex: null })} className={'nd-item' + (l.id === sel ? ' on' : '')}>
                    <NadeIcon type={l.type} size={20} />
                    <span className="nd-item-main">
                      <span className="nd-item-title">{t.title} <span className="muted" style={{ fontWeight: 500 }}>{t.from}</span></span>
                      <span className="tiny muted nd-ell">{l.side} · {MOVES[l.move] || l.move}{(l.fw ?? 0) >= W_SPEED && ['jump', 'stand', 'crouch'].includes(l.move) ? ' + W' : ''} · {who.slice(0, 3).join(', ')}{who.length > 3 ? ` +${who.length - 3}` : ''}</span>
                    </span>
                    <span className="small muted nowrap">{favs.has(l.id) ? '★ ' : ''}{l.n}×</span>
                  </button>
                );
              })}
              {!shownList.length && <div className="empty small">{tab === 'fav' ? 'Добавляйте раскидки в свой набор звёздочкой в окне раскидки' : 'Нет раскидок под эти фильтры'}</div>}
            </div>
          </div>
        </div>
      )}
      {selected && d && (
        <LineupModal key={selected.id} m={m} l={selected} d={d} names={names} lang={lang} highlight={player} fav={favs.has(selected.id)} onFav={() => toggleFav(selected.id)}
          onClose={() => setQuery({ id: null, ex: null })} />
      )}
    </div>
  );
}

export function NadeIcon({ type, size = 16 }: { type: string; size?: number }) {
  const c = NADE_TYPES[type]?.color || '#999';
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden style={{ flex: 'none' }}>
      {type === 'smoke' && <path d="M5.5 15.5a3.5 3.5 0 0 1-.4-7 4.6 4.6 0 0 1 8.9-1A3.8 3.8 0 0 1 14.6 15.5z" fill={c} />}
      {type === 'flash' && <path d="M11 1.5 4 11.5h5l-1 7 7-10h-5z" fill={c} />}
      {type === 'molotov' && <path d="M10 1.5c1 3.2 5 4.7 5 9.3a5 5 0 0 1-10 0c0-2.2 1.2-3.6 2.4-4.6.1 1.5.8 2.4 1.7 2.6C8.6 6.2 9 3.8 10 1.5z" fill={c} />}
      {type === 'he' && <><circle cx="10" cy="11.5" r="6" fill={c} /><rect x="8" y="2.5" width="4" height="3.5" rx="1" fill={c} /></>}
      {type === 'decoy' && <circle cx="10" cy="10" r="6" fill="none" stroke={c} strokeWidth="2.5" />}
    </svg>
  );
}

function Radar({ m, targets, tg, lineups, selected, grid, names, lang, onTarget, onPick }: {
  m: MapInfo; targets: { i: number; t: Target; n: number }[]; tg: number; lineups: Lineup[]; selected: Lineup | null;
  grid: CalloutGrid | null; names: NamesFile | null; lang: 'en' | 'ru'; onTarget: (i: number) => void; onPick: (id: string) => void;
}) {
  const max = Math.max(1, ...targets.map((x) => x.n));
  const cur = targets.find((x) => x.i === tg);
  const labels = useMemo(() => {
    if (!grid) return [];
    return Object.entries(grid.centers).map(([id, c]) => ({ id, p: project(m, c[0], c[1]), name: placeName(names, m.id, id, lang) }));
  }, [grid, names, lang, m]);
  const pz = usePanZoom(1024, 6);
  // markers and labels shrink a little as you zoom in, so close points separate
  const s = 1 / Math.pow(pz.k, 0.72);
  // selecting a landing spot zooms to it and the positions it is thrown from; clearing zooms back out
  const fitKey = cur ? `${cur.i}|${lineups.length}` : '';
  useEffect(() => {
    if (!cur) { pz.reset(); return; }
    const pts = [project(m, cur.t[1], cur.t[2]), ...lineups.map((l) => project(m, l.from[0], l.from[1]))];
    const xs = pts.map((p) => p.px), ys = pts.map((p) => p.py);
    pz.fit(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, m.id]);
  return (
    <div className="card nd-radar">
      <div className="nd-zoom">
        <button className="btn small icon" onClick={() => pz.zoomBy(1.6)} aria-label="Приблизить" title="Приблизить (колесо мыши, щипок)">+</button>
        <button className="btn small icon" onClick={() => pz.zoomBy(1 / 1.6)} aria-label="Отдалить" title="Отдалить">−</button>
        <button className="btn small icon" onClick={pz.reset} aria-label="Вся карта" title="Вся карта" disabled={pz.k <= 1.01}>⤢</button>
      </div>
      <svg ref={pz.ref} viewBox={pz.viewBox} style={{ width: '100%', display: 'block', touchAction: pz.touchAction, cursor: pz.k > 1.01 ? 'grab' : undefined, aspectRatio: '1 / 1' }} {...pz.handlers}>
        <image href={m.radar} x="0" y="0" width="1024" height="1024" />
        {labels.map((x) => (
          <text key={x.id} x={x.p.px} y={x.p.py} className="nd-callout" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 15 * Math.pow(s, 0.85), strokeWidth: 4 * s }}>{x.name}</text>
        ))}
        {targets.map(({ i, t, n }) => {
          const p = project(m, t[1], t[2]);
          const r = (9 + 13 * Math.sqrt(n / max)) * s;
          const on = i === tg;
          const dim = tg >= 0 && !on;
          return (
            <g key={i} transform={`translate(${p.px},${p.py})`} style={{ cursor: 'pointer', opacity: dim ? 0.35 : 1 }} onClick={() => onTarget(i)}>
              <circle r={on ? r + 4 * s : r} fill={NADE_TYPES[t[0]]?.color} fillOpacity={on ? 0.95 : 0.6} stroke={on ? '#fff' : '#000'} strokeWidth={(on ? 3 : 1.4) * s} />
              <g transform={`translate(${-r * 0.55},${-r * 0.55}) scale(${(r * 1.1) / 20})`} style={{ pointerEvents: 'none' }}>
                <NadeGlyph type={t[0]} />
              </g>
              <title>{NADE_TYPES[t[0]]?.one} · {n} бросков{t[4] ? ` · ${placeName(names, m.id, t[4], lang)}` : ''}</title>
            </g>
          );
        })}
        {cur && lineups.map((l) => {
          const f = project(m, l.from[0], l.from[1]);
          const to = project(m, cur.t[1], cur.t[2]);
          const on = l.id === selected?.id;
          const sideC = l.side === 'T' ? '#e0a64e' : '#6fa3e0';
          return (
            <g key={l.id} style={{ cursor: 'pointer' }} onClick={() => onPick(l.id)}>
              <line x1={f.px} y1={f.py} x2={to.px} y2={to.py} stroke={on ? '#fff' : sideC} strokeWidth={(on ? 3 : 2) * s} strokeDasharray={`${7 * s} ${6 * s}`} opacity={0.95} />
              <circle cx={f.px} cy={f.py} r={(on ? 11 : 8) * s} fill={sideC} stroke="#000" strokeWidth={2 * s} />
              <circle cx={f.px} cy={f.py} r={16 * s} fill="transparent" />
              <title>{l.side} · {MOVES[l.move] || l.move} · {l.n} бросков</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function NadeGlyph({ type }: { type: string }) {
  const c = '#14161b';
  return (
    <>
      {type === 'smoke' && <path d="M5.5 15.5a3.5 3.5 0 0 1-.4-7 4.6 4.6 0 0 1 8.9-1A3.8 3.8 0 0 1 14.6 15.5z" fill={c} opacity=".75" />}
      {type === 'flash' && <path d="M11 1.5 4 11.5h5l-1 7 7-10h-5z" fill={c} opacity=".75" />}
      {type === 'molotov' && <path d="M10 1.5c1 3.2 5 4.7 5 9.3a5 5 0 0 1-10 0c0-2.2 1.2-3.6 2.4-4.6.1 1.5.8 2.4 1.7 2.6C8.6 6.2 9 3.8 10 1.5z" fill={c} opacity=".75" />}
      {type === 'he' && <><circle cx="10" cy="11.5" r="5.5" fill={c} opacity=".75" /><rect x="8" y="3" width="4" height="3" rx="1" fill={c} opacity=".75" /></>}
    </>
  );
}

function LineupModal({ m, l, d, names, lang, highlight, fav, onFav, onClose }: {
  m: MapInfo; l: Lineup; d: MapFile; names: NamesFile | null; lang: 'en' | 'ru'; highlight: string; fav: boolean; onFav: () => void; onClose: () => void;
}) {
  const { query } = useRoute();
  const exSel = query.get('ex') === null ? -1 : +query.get('ex')!;
  const det = useAsync(() => loadDetails(m.id, l.id), [m.id, l.id]);
  const details = det.data;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    const o = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = o; };
  }, [onClose]);

  // examples: per-throw details (v3) or the short list (older data, all replay the representative throw)
  const examples = useMemo(() => {
    const rows = details ? details.map((x, i) => ({ i, p: x[0], m: x[1], round: x[2], time: x[3], det: x })) : l.ex.map((e, i) => ({ i, p: e[0], m: e[1], round: e[2], time: null as number | null, det: null as Detail | null }));
    return rows.sort((a, b) => Number(d.players[b.p][0] === highlight) - Number(d.players[a.p][0] === highlight));
  }, [details, l, d, highlight]);
  const cur = exSel >= 0 ? examples.find((x) => x.i === exSel) || null : null;
  const th: Throw = useMemo(() => {
    const x = cur?.det;
    if (x) return { type: l.type, side: l.side, from: [x[6], x[7], x[8]], ang: [x[9], x[10]], land: [x[11], x[12], x[13]], traj: x[15], dur: x[14], move: x[4], btn: x[5] };
    return { type: l.type, side: l.side, from: l.from, ang: l.ang, land: l.land, traj: l.traj, dur: l.dur || 0, move: l.move, btn: l.btn || '' };
  }, [cur, l]);
  const t = lineupTitle(l, names, m.id, lang);
  const setpos = `setpos ${th.from[0]} ${th.from[1]} ${th.from[2]}; setang ${th.ang[0]} ${th.ang[1]} 0`;
  const moves = Object.entries(l.moves).sort((a, b) => b[1] - a[1]);
  const keys = combo(th.move, th.btn, l.fw);
  const curName = cur ? d.players[cur.p][0] : '';
  const title = `${m.name} — ${t.title} ${t.from}`.trim();

  return (
    <div className="nd-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="nd-dialog card" role="dialog" aria-label={title}>
        <div className="nd-dialog-head">
          <div className="row" style={{ gap: 10, flexWrap: 'nowrap', minWidth: 0 }}>
            <NadeIcon type={l.type} size={24} />
            <div style={{ minWidth: 0 }}>
              <h2 className="nd-ell" style={{ fontSize: 20 }}>{t.title} <span className="muted" style={{ fontWeight: 500 }}>{t.from}</span></h2>
              <div className="small muted">{m.name} · {l.side === 'T' ? 'атака (T)' : 'защита (CT)'} · {l.n} бросков у {l.np} {l.np === 1 ? 'игрока' : 'игроков'}{curName ? <> · повтор броска <b style={{ color: 'var(--text)' }}>{curName}</b></> : null}</div>
            </div>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <button className={'btn small' + (fav ? ' primary' : '')} onClick={onFav} title="В мой набор">{fav ? '★ В наборе' : '☆ В набор'}</button>
            <button className="btn small ghost" onClick={onClose} aria-label="Закрыть">✕</button>
          </div>
        </div>
        <div className="nd-dialog-body">
          <div className="nd-dialog-video">
            {hasMap3D(m.id) ? (
              <Suspense fallback={<div className="r3d"><div className="r3d-stage"><div className="r3d-msg">Загрузка…</div></div></div>}>
                <Replay3D map={m.id} th={th} title={title} keys={keys} />
              </Suspense>
            ) : <div className="notice">3D-повтор для этой карты пока недоступен.</div>}
            <div className="nd-keys">
              {keys.map((k, i) => <span key={k} className="row" style={{ gap: 6 }}>{i ? <span className="faint">+</span> : null}<span className="nd-key">{k}</span></span>)}
              <span className="tiny muted" style={{ marginLeft: 'auto' }}><span className="kbd">Shift</span> прицел · <span className="kbd">Ctrl</span> позиция · <span className="kbd">Пробел</span> пауза</span>
            </div>
          </div>
          <div className="nd-dialog-info stack" style={{ gap: 12 }}>
            <dl className="dl">
              <dt>Техника</dt><dd>{moves.map(([k, v], i) => <span key={k}>{i ? ', ' : ''}{MOVES[k] || k}{moves.length > 1 ? ` ${Math.round((v / l.n) * 100)}%` : ''}</span>)}
                {l.fw != null && ['jump', 'stand', 'crouch'].includes(l.move) ? <span className="muted" title="Скорость игрока вдоль прицела в момент броска, посчитана по полёту гранат всех профи этой раскидки">{l.fw >= W_SPEED ? ` · с зажатой W (≈${l.fw} ед/с)` : ' · стоя на месте, без W'}</span> : null}</dd>
              {th.btn && <><dt>Кнопка</dt><dd>{BTN[th.btn]}</dd></>}
              <dt>Обычно</dt><dd>на {fmtTime(l.time)} от начала раунда</dd>
              {th.dur > 0 && <><dt>До взрыва</dt><dd>{th.dur.toFixed(1)} с после броска</dd></>}
            </dl>
            <div className="code small">{setpos}</div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn small primary" onClick={() => copy(setpos, 'Скопировано — вставьте в консоль на сервере с sv_cheats 1')}>Копировать setpos</button>
              <a className="btn small ghost" href="#/tools?t=practice">Конфиг тренировки</a>
            </div>
            <div className="stack" style={{ gap: 0 }}>
              <div className="row between" style={{ padding: '4px 0 6px' }}>
                <span className="tiny muted">Кто так кидает — нажмите, чтобы посмотреть его бросок</span>
                {cur && <button className="btn small ghost" onClick={() => setQuery({ ex: null })}>типичный</button>}
              </div>
              <div className="nd-who">
                {examples.map((x) => {
                  const [name, team] = d.players[x.p];
                  const [match, event, date, url] = d.matches[x.m];
                  const on = cur?.i === x.i;
                  return (
                    <div key={x.i} className={'nd-who-row' + (on ? ' on' : '') + (name === highlight ? ' hl' : '')}>
                      <button className="nd-who-main" disabled={!x.det} onClick={() => setQuery({ ex: String(x.i) })} title={x.det ? 'Показать этот бросок в 3D' : 'Подробности броска появятся после обновления базы'}>
                        <span><b>{name}</b> <span className="muted">{team}</span></span>
                        <span className="tiny muted">{match}{event ? ` · ${event}` : ''}{date ? ` · ${new Date(date).toLocaleDateString('ru-RU')}` : ''} · раунд {x.round}{x.time != null ? ` · ${fmtTime(x.time)}` : ''}</span>
                      </button>
                      {extUrl(url) && <a className="nd-ext" href={extUrl(url)} target="_blank" rel="noreferrer" title="Матч на HLTV">↗</a>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
