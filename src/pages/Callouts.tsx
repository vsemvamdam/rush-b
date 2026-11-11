import { useMemo, useState } from 'react';
import { usePanZoom } from '../lib/panzoom';
import { Spinner } from '../components/ui';
import { useAsync } from '../lib/hooks';
import { extUrl, href } from '../lib/router';
import { loadGrid, placeName, prettyPlace, useCalloutLang, useNames, type PlaceName } from '../lib/callouts';
import '../styles/nades.css';

type MapInfo = { id: string; name: string; pos_x: number; pos_y: number; scale: number; radar: string; active?: boolean; lower?: { z_max: number; radar: string } };

const hue = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h * 137.508) % 360;
};
const CONF: Record<string, string> = { high: '', medium: 'средняя уверенность', low: 'мало источников' };

export default function Callouts({ map }: { map?: string }) {
  const maps = useAsync(() => fetch(import.meta.env.BASE_URL + 'data/nades/maps.json').then((r) => r.json()).then((j) => (j.maps as MapInfo[]).filter((m) => m.active)), []);
  if (maps.loading) return <Spinner />;
  const list = maps.data || [];
  const m = list.find((x) => x.id === map) || list.find((x) => x.id === 'de_mirage') || list[0];
  if (!m) return <div className="notice">Нет данных о картах</div>;
  return <MapCallouts key={m.id} m={m} maps={list} />;
}

function MapCallouts({ m, maps }: { m: MapInfo; maps: MapInfo[] }) {
  const grid = useAsync(() => loadGrid(m.id), [m.id]);
  const names = useNames();
  const [lang, setLang] = useCalloutLang();
  const [zones, setZones] = useState(true);
  const [labels, setLabels] = useState(true);
  const [lower, setLower] = useState(false);
  const [hover, setHover] = useState('');
  const [q, setQ] = useState('');
  const g = grid.data;
  const info = names?.[m.id];
  const levelOk = (z: number) => (!m.lower ? true : lower ? z < m.lower.z_max : z >= m.lower.z_max);
  const project = (x: number, y: number) => ({ px: (x - m.pos_x) / m.scale, py: (m.pos_y - y) / m.scale });

  const places = useMemo(() => {
    const ids = new Set<string>([...(g ? Object.keys(g.centers) : []), ...(info ? Object.keys(info.places) : [])]);
    return [...ids].map((id) => ({ id, p: info?.places[id] as PlaceName | undefined, c: g?.centers[id] }))
      .sort((a, b) => placeName(names, m.id, a.id, 'en').localeCompare(placeName(names, m.id, b.id, 'en')));
  }, [g, info, names, m.id]);
  const extras = useMemo(() => {
    const by = new Map<string, NonNullable<typeof info>['extra']>();
    for (const e of info?.extra || []) {
      const a = by.get(e.near) || [];
      a.push(e);
      by.set(e.near, a);
    }
    return by;
  }, [info]);
  const nq = q.trim().toLowerCase().replace(/ё/g, 'е');
  const match = (id: string) => {
    if (!nq) return true;
    const p = info?.places[id];
    const hay = [id, p?.en, p?.en_community, p?.ru, p?.ru_game, ...(p?.ru_alt || []), ...(extras.get(id) || []).flatMap((e) => [e.en, e.ru, ...(e.ru_alt || [])])].join(' ').toLowerCase().replace(/ё/g, 'е');
    return hay.includes(nq);
  };
  const cellPx = g ? g.cell / m.scale : 0;
  const pz = usePanZoom(1024, 6);
  const ls = 1 / Math.pow(pz.k, 0.6);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row between">
        <div className="stack" style={{ gap: 4 }}>
          <h1>Коллауты {m.name}</h1>
          <p className="muted small" style={{ maxWidth: 760 }}>Два варианта: <b>английские</b> названия, как в игре и у профи, и <b>русские</b> — как говорят в русскоязычных командах. Зоны на радаре построены по реальным позициям игроков из про-демок с официальным названием места, которое показывает игра.</p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {maps.map((x) => <a key={x.id} className={'chip' + (x.id === m.id ? ' on' : '')} href={href(`/callouts/${x.id}`)}>{x.name}</a>)}
        </div>
      </div>
      <div className="card pad row" style={{ gap: 10 }}>
        <div className="seg">
          <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>English</button>
          <button className={lang === 'ru' ? 'on' : ''} onClick={() => setLang('ru')}>Русские</button>
        </div>
        {m.lower && (
          <div className="seg">
            <button className={!lower ? 'on' : ''} onClick={() => setLower(false)}>Верхний уровень</button>
            <button className={lower ? 'on' : ''} onClick={() => setLower(true)}>Нижний уровень</button>
          </div>
        )}
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={zones} onChange={(e) => setZones(e.target.checked)} /> зоны</label>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> подписи</label>
        <input className="input small" placeholder="Найти: окно, шорт, Window…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <a className="link small" href={href(`/nades/${m.id}`)} style={{ marginLeft: 'auto' }}>Раскидки {m.name} →</a>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.2fr) minmax(320px, 1fr)', alignItems: 'start' }}>
        <div className="card nd-radar" style={{ position: 'sticky', top: 76 }}>
          <div className="nd-zoom">
            <button className="btn small icon" onClick={() => pz.zoomBy(1.6)} aria-label="Приблизить" title="Приблизить (колесо мыши, щипок)">+</button>
            <button className="btn small icon" onClick={() => pz.zoomBy(1 / 1.6)} aria-label="Отдалить" title="Отдалить">−</button>
            <button className="btn small icon" onClick={pz.reset} aria-label="Вся карта" title="Вся карта" disabled={pz.k <= 1.01}>⤢</button>
          </div>
          <svg ref={pz.ref} viewBox={pz.viewBox} style={{ width: '100%', display: 'block', touchAction: pz.touchAction, aspectRatio: '1 / 1', cursor: pz.k > 1.01 ? 'grab' : undefined }} {...pz.handlers} onMouseLeave={() => setHover('')}>
            <image href={lower && m.lower ? m.lower.radar : m.radar} x="0" y="0" width="1024" height="1024" />
            {g && zones && g.cells.map(([cx, cy, cz, ni], i) => {
              const id = g.names[ni];
              if (!levelOk((cz + 0.5) * g.cell)) return null;
              const p = project(cx * g.cell, (cy + 1) * g.cell);
              const on = hover === id || (nq && match(id));
              return <rect key={i} x={p.px} y={p.py} width={cellPx + 0.6} height={cellPx + 0.6} fill={`hsl(${hue(id)} 70% 55%)`} fillOpacity={on ? 0.6 : hover || nq ? 0.12 : 0.3} onMouseEnter={() => setHover(id)} />;
            })}
            {g && labels && Object.entries(g.centers).map(([id, c]) => {
              if (!levelOk(c[2])) return null;
              const p = project(c[0], c[1]);
              const dim = (hover && hover !== id) || (nq && !match(id));
              return (
                <text key={id} x={p.px} y={p.py} className="nd-callout" textAnchor="middle" dominantBaseline="middle" style={{ opacity: dim ? 0.35 : 1, fontSize: (hover === id ? 19 : 15) * ls, strokeWidth: 4 * ls }}>
                  {placeName(names, m.id, id, lang)}
                </text>
              );
            })}
          </svg>
          {!g?.cells.length && !grid.loading && <div className="notice" style={{ margin: 10 }}>Зоны для {m.name} появятся, когда в базу попадут про-демки этой карты — сейчас идёт разбор архива.</div>}
        </div>
        <div className="card">
          <div className="card-head"><h3>Названия · {places.filter((x) => match(x.id)).length}</h3><span className="tiny muted">наведите на зону на радаре</span></div>
          <div className="stack" style={{ gap: 0 }}>
            {places.filter((x) => match(x.id)).map(({ id, p }) => {
              const ex = extras.get(id) || [];
              const en = p?.en_community || p?.en || prettyPlace(id);
              return (
                <div key={id} className="co-row" onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover('')} style={{ background: hover === id ? 'var(--surface-2)' : undefined }}>
                  <span className="co-swatch" style={{ background: `hsl(${hue(id)} 70% 55%)` }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row between" style={{ gap: 8 }}>
                      <b>{lang === 'ru' ? p?.ru || en : en}</b>
                      {p?.confidence && CONF[p.confidence] && <span className="badge" title="Насколько уверенно название подтверждено источниками">{CONF[p.confidence]}</span>}
                    </div>
                    <div className="small muted">
                      {lang === 'ru' ? en : p?.ru || ''}
                      {p?.ru_alt?.length ? <> · ещё: {p.ru_alt.join(', ')}</> : null}
                    </div>
                    <div className="tiny faint">
                      в игре: {p?.en || prettyPlace(id)}{p?.ru_game ? ` / ${p.ru_game}` : ''}
                    </div>
                    {p?.note && <div className="tiny muted" style={{ marginTop: 2 }}>{p.note}</div>}
                    {ex.length > 0 && (
                      <div className="co-extra">
                        {ex.map((e) => (
                          <div key={e.en} className="tiny"><b>{lang === 'ru' ? e.ru : e.en}</b> <span className="muted">({lang === 'ru' ? e.en : e.ru}{e.ru_alt?.length ? `, ${e.ru_alt.join(', ')}` : ''})</span>{e.where ? <span className="muted"> — {e.where}</span> : null}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {!places.length && <div className="empty small">Нет данных</div>}
          </div>
        </div>
      </div>
      <div className="card pad stack small">
        <h3>Откуда названия</h3>
        <p className="muted">Зоны и английские названия — официальные места из игры (то, что показывается в чате и на HUD), их положение — по позициям игроков в турнирных демках{g?.demos ? ` (${g.demos} карт)` : ''}. Мелкие точки внутри зон (ящики, углы) перечислены под зоной. Русские варианты собраны по русскоязычным гайдам и статьям; где источник один, стоит пометка «мало источников».</p>
        {info?.sources?.length ? (
          <details>
            <summary className="link">Источники для {m.name} ({info.sources.length})</summary>
            <ul className="tiny" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {info.sources.map((s) => <li key={s}><a className="link" href={extUrl(s)} target="_blank" rel="noreferrer">{s.replace(/^https?:\/\//, '').slice(0, 90)}</a></li>)}
            </ul>
          </details>
        ) : null}
      </div>
      <style>{`.co-row{display:flex;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border)} .co-swatch{width:10px;height:10px;border-radius:3px;margin-top:6px;flex:none} .co-extra{margin-top:6px;padding:6px 8px;border-radius:7px;background:var(--bg-2);display:grid;gap:3px} @media (max-width: 900px){ .grid[style*="1.2fr"]{grid-template-columns:1fr !important} .grid[style*="1.2fr"] .nd-radar{position:static !important} }`}</style>
    </div>
  );
}

