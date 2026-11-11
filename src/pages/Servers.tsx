import { useEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from '../components/ui';
import { copy } from '../lib/hooks';
import { setQuery, useRoute } from '../lib/router';
import {
  GROUPS, MODES, REGIONS, bestServer, catRu, connectCmd, connectUrl, filterServers, flagImg, locInfo, mapRu, modeGroup, modeRu, parseJoin, toSrv,
  type Filters, type Loc, type Region, type ServersPayload, type Sort, type Srv,
} from '../lib/servers';
import { ApiError, api, plural } from '../lib/stats';
import '../styles/servers.css';

const REFRESH = 30_000;
const PAGE = 60;
const SAVED = 'cs2craft.servers';
const DEFAULT_MODE = 'DUELS';

function useServers() {
  const [data, setData] = useState<ServersPayload | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const at = useRef(0);
  const [, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      setBusy(true);
      api<ServersPayload>('/api/servers')
        .then((d) => { if (!alive) return; at.current = Date.now(); setData(d); setError(''); })
        .catch((e) => { if (alive) setError(e instanceof ApiError ? e.message : 'Нет связи с сервером сайта'); })
        .finally(() => { if (alive) setBusy(false); });
    };
    load();
    const t = window.setInterval(load, REFRESH);
    const vis = () => { if (document.visibilityState === 'visible' && Date.now() - at.current > REFRESH) load(); };
    document.addEventListener('visibilitychange', vis);
    const clock = window.setInterval(() => setTick((x) => x + 1), 5000); // «обновлено N с назад»
    return () => { alive = false; clearInterval(t); clearInterval(clock); document.removeEventListener('visibilitychange', vis); };
  }, []);
  return { data, error, busy, at: at.current };
}

function ago(ms: number) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 10 ? 'только что' : s < 60 ? `${s} с назад` : `${Math.round(s / 60)} мин назад`;
}

function Flag({ loc }: { loc: Loc }) {
  const src = flagImg(loc.country);
  return src ? <img className="srv-flag" src={src} alt={loc.country.toUpperCase()} width={20} height={14} loading="lazy" /> : null;
}

const inviteLink = (s: { ip: string; port: number }) => `${location.origin}${location.pathname}#/duels?join=${s.ip}:${s.port}`;

function Actions({ s, big }: { s: Srv | { ip: string; port: number }; big?: boolean }) {
  return (
    <div className="srv-actions">
      <a className={'btn primary grow' + (big ? '' : ' small')} href={connectUrl(s)} title="Запустит CS2 через Steam и сразу подключит к серверу">▶ Играть</a>
      <button type="button" className={'btn' + (big ? '' : ' small')} title="Скопировать ссылку для друга: он откроет её и зайдёт на этот же сервер" onClick={() => copy(inviteLink(s), 'Ссылка для друга скопирована')}>👥</button>
      <button type="button" className={'btn' + (big ? '' : ' small')} title={`Скопировать команду для консоли: ${connectCmd(s)}`} onClick={() => copy(connectCmd(s), `Скопировано: ${connectCmd(s)}`)}>⧉</button>
    </div>
  );
}

function Fill({ s }: { s: Srv }) {
  const pct = s.max ? Math.min(100, (s.players / s.max) * 100) : 0;
  const cls = s.free <= 0 ? 'full' : s.free <= 2 ? 'almost' : '';
  return (
    <div className="srv-fill">
      <div className={'srv-bar ' + cls}><span style={{ width: pct + '%' }} /></div>
      <span className="num"><b>{s.players}</b>/{s.max}</span>
    </div>
  );
}

function ServerCard({ s, loc, hl }: { s: Srv; loc: Loc; hl?: boolean }) {
  return (
    <div className={'srv-card' + (hl ? ' hl' : '') + (s.players === 0 ? ' empty' : '')}>
      <div className="srv-top">
        <span className="badge">#{s.num}</span>
        <span className="grow" />
        <Flag loc={loc} />
        <span className="small muted nowrap">{loc.city}</span>
      </div>
      <div className="srv-map" title={s.map}>{mapRu(s.map)}</div>
      <div className="tiny faint srv-sub">{[s.cat ? catRu(s.cat) : '', s.faceit ? `ср. FACEIT ${s.faceit}` : ''].filter(Boolean).join(' · ') || ' '}</div>
      <Fill s={s} />
      <Actions s={s} />
    </div>
  );
}

export default function Servers() {
  const r = useRoute();
  const { data, error, busy, at } = useServers();
  const [shown, setShown] = useState(PAGE);
  // on phones the other 25+ modes would push the servers far down — they open with one tap
  const [allModes, setAllModes] = useState(() => typeof matchMedia !== 'function' || matchMedia('(min-width: 700px)').matches);
  const q = r.query;

  // returning visitors get their last mode / region / city back
  useEffect(() => {
    if ([...q.keys()].length) return;
    try {
      const saved = JSON.parse(localStorage.getItem(SAVED) || 'null');
      if (saved && typeof saved === 'object') setQuery({ mode: saved.mode, reg: saved.reg, loc: saved.loc, n: saved.n });
    } catch { /* storage unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mode = q.get('mode') || DEFAULT_MODE;
  const f: Filters = {
    mode, cat: q.get('cat') || '', region: (q.get('reg') || '') as Region | '', loc: q.get('loc') || '', map: q.get('map') || '',
    slots: Math.min(10, Math.max(0, +(q.get('n') || 0) || 0)), full: q.get('full') === '1', empty: q.get('noempty') !== '1',
    q: q.get('q') || '', sort: (q.get('sort') || 'players') as Sort,
  };
  useEffect(() => {
    try { localStorage.setItem(SAVED, JSON.stringify({ mode: f.mode, reg: f.region || undefined, loc: f.loc || undefined, n: f.slots || undefined })); } catch { /* ignore */ }
  }, [f.mode, f.region, f.loc, f.slots]);
  useEffect(() => setShown(PAGE), [mode, f.cat, f.region, f.loc, f.map, f.slots, f.full, f.empty, f.q, f.sort]);

  const all = useMemo(() => (data ? data.list.map(toSrv) : []), [data]);
  const locCache = useMemo(() => new Map<string, Loc>(), [data]);
  const loc = (id: string) => {
    let l = locCache.get(id);
    if (!l) locCache.set(id, (l = locInfo(data, id)));
    return l;
  };
  const modeInfo = data?.modes.find((m) => m.id === mode);
  const inMode = useMemo(() => all.filter((s) => s.mode === mode), [all, mode]);
  const list = useMemo(() => filterServers(all, f, loc), [all, mode, f.cat, f.region, f.loc, f.map, f.slots, f.full, f.empty, f.q, f.sort]);
  const best = useMemo(() => bestServer(filterServers(all, { ...f, full: false, empty: true, sort: 'players' }, loc), f.slots || 1), [list]);
  const join = parseJoin(q.get('join'));
  const joined = join ? all.find((s) => s.ip === join.ip && s.port === join.port) || null : null;

  // dropdown options from the servers of this mode (with the category picked)
  const opts = useMemo(() => {
    const base = inMode.filter((s) => !f.cat || s.cat === f.cat);
    const locs = new Map<string, { n: number; p: number }>();
    const maps = new Map<string, number>();
    for (const s of base) {
      const l = locs.get(s.loc) || { n: 0, p: 0 };
      l.n++; l.p += s.players;
      locs.set(s.loc, l);
      maps.set(s.map, (maps.get(s.map) || 0) + s.players);
    }
    return {
      locs: [...locs.entries()].map(([id, v]) => ({ ...loc(id), ...v })).sort((a, b) => b.p - a.p),
      maps: [...maps.entries()].sort((a, b) => b[1] - a[1]),
      cats: modeInfo?.cats || [],
    };
  }, [inMode, f.cat, modeInfo]);

  const pickMode = (m: string) => setQuery({ mode: m === DEFAULT_MODE ? null : m, cat: null, map: null, q: null, join: q.get('join') });
  const freeSum = list.reduce((a, s) => a + s.free, 0);
  const playersInList = list.reduce((a, s) => a + s.players, 0);

  return (
    <div className="stack srv-page" style={{ gap: 18 }}>
      <section className="srv-hero">
        <div className="stack" style={{ gap: 8 }}>
          <h1>Дуэли</h1>
          <p className="muted srv-lead">
            Живой список серверов <a className="link" href="https://cybershoke.net/ru/cs2" target="_blank" rel="noreferrer">Cybershoke</a> — самого большого проекта
            с дуэлями в CS2. Выбирай режим, карту и город, жми «Играть» — CS2 запустится и сразу подключится. Список обновляется каждые 30 секунд.
          </p>
        </div>
        <div className="srv-kpis">
          <div className="kpi"><div className="label">Играют сейчас</div><div className="value">{data ? data.players.toLocaleString('ru-RU') : '—'}</div></div>
          <div className="kpi"><div className="label">Серверов</div><div className="value">{data ? data.servers.toLocaleString('ru-RU') : '—'}</div></div>
          <div className="kpi"><div className="label">Обновлено</div><div className="value small-v">{busy && !data ? '…' : ago(at) || '—'}</div></div>
        </div>
      </section>

      {error && !data && (
        <div className="notice bad">
          {error === 'not-configured' ? 'Сервер сайта ещё не подключён, поэтому список серверов недоступен.' : `Не удалось загрузить серверы: ${error}.`}{' '}
          Пока можно открыть список на <a className="link" href="https://cybershoke.net/ru/cs2/servers/duels" target="_blank" rel="noreferrer">cybershoke.net</a>.
        </div>
      )}
      {data?.partial && !data.stale && <div className="notice">Сейчас список неполный: нет серверов в Москве, Казахстане и ещё нескольких городах. Полный список обычно возвращается через минуту.</div>}
      {data?.stale && <div className="notice warn">Cybershoke сейчас не отвечает — показан последний полученный список (от {new Date(data.fetched * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}). Число игроков может быть неточным.</div>}

      {join && (
        <section className="srv-join card pad">
          <div className="stack" style={{ gap: 4 }}>
            <span className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>Тебя позвали на сервер</span>
            {joined ? (
              <>
                <b className="srv-join-title">#{joined.num} · {modeRu(joined.mode)} · {mapRu(joined.map)}</b>
                <span className="row small muted" style={{ gap: 8 }}><Flag loc={loc(joined.loc)} />{loc(joined.loc).city} · {joined.players}/{joined.max} игроков{joined.free <= 0 ? ' · сейчас мест нет' : ''}</span>
              </>
            ) : (
              <b className="srv-join-title mono">{join.ip}:{join.port}</b>
            )}
          </div>
          <div className="srv-join-act">
            <Actions s={joined || join} big />
            <button type="button" className="btn ghost small" onClick={() => setQuery({ join: null })}>Скрыть</button>
          </div>
        </section>
      )}

      {!data && !error ? <Spinner /> : data && (
        <>
          <section className="srv-modes">
            {GROUPS.map((g) => {
              const ms = data.modes.filter((m) => modeGroup(m.id) === g.id);
              if (!ms.length) return null;
              if (g.id !== 'duels' && !allModes && modeGroup(mode) !== g.id) return null;
              if (g.id === 'duels') ms.sort((a, b) => Object.keys(MODES).indexOf(a.id) - Object.keys(MODES).indexOf(b.id));
              const sum = ms.reduce((a, m) => a + m.players, 0);
              return (
                <div key={g.id} className={'srv-group g-' + g.id}>
                  <div className="srv-group-name"><span>{g.ru}</span><span className="num faint">{sum.toLocaleString('ru-RU')} в игре</span></div>
                  <div className="srv-tiles">
                    {ms.map((m) => (
                      <button key={m.id} type="button" className={'srv-tile' + (m.id === mode ? ' on' : '') + (m.players ? '' : ' dead') + (m.label ? ' tagged' : '')} onClick={() => pickMode(m.id)}
                        title={MODES[m.id]?.d || m.name} aria-pressed={m.id === mode}>
                        {m.label && <span className={'srv-tile-tag' + (/new/i.test(m.label) ? ' new' : '')}>{/new/i.test(m.label) ? 'Новый' : m.label}</span>}
                        <span className="srv-tile-name">{modeRu(m.id, m.name)}</span>
                        <span className="srv-tile-meta"><b className="num">{m.players.toLocaleString('ru-RU')}</b> в игре</span>
                        <span className="srv-tile-sub">{m.servers} {plural(m.servers, 'сервер', 'сервера', 'серверов')}</span>
                      </button>
                    ))}
                    {g.id === 'tactics' && (
                      <a className="srv-tile ext" href="https://cybershoke.net/ru/cs2/matches" target="_blank" rel="noreferrer" title="Свой сервер с друзьями: создаётся на сайте Cybershoke">
                        <span className="srv-tile-name">Своё лобби ↗</span>
                        <span className="srv-tile-meta">матч с друзьями</span>
                        <span className="srv-tile-sub">на сайте Cybershoke</span>
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
            {!allModes && (
              <button type="button" className="btn" onClick={() => setAllModes(true)}>
                Все режимы: DM, ретейки, 5×5, сёрф, KZ… ({data.modes.length})
              </button>
            )}
          </section>

          {modeInfo ? (
            <>
              <div className="srv-mode-head">
                <div className="stack" style={{ gap: 2 }}>
                  <h2>{modeRu(mode, modeInfo.name)}</h2>
                  {MODES[mode]?.d && <span className="muted small">{MODES[mode].d}</span>}
                </div>
                <span className="small muted">
                  <b className="num">{modeInfo.players.toLocaleString('ru-RU')}</b> {plural(modeInfo.players, 'игрок', 'игрока', 'игроков')} на{' '}
                  <b className="num">{modeInfo.servers}</b> {plural(modeInfo.servers, 'сервере', 'серверах', 'серверах')}
                </span>
              </div>

              <section className="card pad srv-filters">
                {opts.cats.length > 1 && (
                  <div className="filter-list">
                    <button type="button" className={'chip' + (!f.cat ? ' on' : '')} onClick={() => setQuery({ cat: null, map: null })}>Все</button>
                    {opts.cats.map((c) => <button key={c} type="button" className={'chip' + (f.cat === c ? ' on' : '')} onClick={() => setQuery({ cat: c, map: null })}>{catRu(c)}</button>)}
                  </div>
                )}
                <div className="srv-filter-row">
                  <select className="select" value={f.loc ? 'l:' + f.loc : f.region ? 'r:' + f.region : ''} aria-label="Где сервер"
                    onChange={(e) => { const v = e.target.value; setQuery(v.startsWith('l:') ? { loc: v.slice(2), reg: null } : { reg: v.slice(2) || null, loc: null }); }}>
                    <option value="">Все страны</option>
                    {REGIONS.map((rg) => {
                      const ls = opts.locs.filter((l) => l.region === rg.id);
                      if (!ls.length) return null;
                      return (
                        <optgroup key={rg.id} label={rg.ru}>
                          <option value={'r:' + rg.id}>{rg.ru} — все</option>
                          {ls.map((l) => <option key={l.id} value={'l:' + l.id}>{l.city} · {l.p} игр.</option>)}
                        </optgroup>
                      );
                    })}
                  </select>
                  {opts.maps.length > 1 && (
                    <select className="select" value={f.map} onChange={(e) => setQuery({ map: e.target.value || null })} aria-label="Карта">
                      <option value="">Все карты</option>
                      {opts.maps.map(([m, p]) => <option key={m} value={m}>{mapRu(m)} · {p} игр.</option>)}
                    </select>
                  )}
                  <div className="seg" role="radiogroup" aria-label="Сколько вас" title="Покажем только серверы, где хватит мест на всех">
                    <button type="button" className={!f.slots ? 'on' : ''} onClick={() => setQuery({ n: null })}>Любые</button>
                    {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={f.slots === n} className={f.slots === n ? 'on' : ''} onClick={() => setQuery({ n })}>{n === 1 ? 'Я один' : `Нас ${n}`}</button>)}
                  </div>
                  <input className="input srv-search" placeholder="Номер, карта, IP…" value={f.q} onChange={(e) => setQuery({ q: e.target.value })} />
                  <select className="select" value={f.sort} onChange={(e) => setQuery({ sort: e.target.value === 'players' ? null : e.target.value })} aria-label="Сортировка">
                    <option value="players">Сначала живые</option>
                    <option value="free">Больше свободных мест</option>
                    <option value="num">По номеру</option>
                  </select>
                </div>
                <div className="row" style={{ gap: 18 }}>
                  <label className="check"><input type="checkbox" checked={f.empty} onChange={(e) => setQuery({ noempty: e.target.checked ? null : 1 })} /> Показывать пустые</label>
                  <label className="check"><input type="checkbox" checked={!!f.full} disabled={!!f.slots} onChange={(e) => setQuery({ full: e.target.checked ? 1 : null })} /> Показывать заполненные</label>
                  <span className="grow" />
                  <span className="small muted">
                    {list.length} {plural(list.length, 'сервер', 'сервера', 'серверов')} · {playersInList} {plural(playersInList, 'игрок', 'игрока', 'игроков')} · {freeSum} {plural(freeSum, 'свободное место', 'свободных места', 'свободных мест')}
                  </span>
                </div>
              </section>

              {best && (
                <section className="srv-best">
                  <div className="stack grow" style={{ gap: 2 }}>
                    <span className="tiny muted srv-best-label">Быстрое подключение{f.slots && f.slots > 1 ? ` · места для ${f.slots}` : ''}</span>
                    <b>#{best.num} · {mapRu(best.map)}{best.cat ? ` · ${catRu(best.cat)}` : ''}</b>
                    <span className="row small muted" style={{ gap: 8 }}><Flag loc={loc(best.loc)} />{loc(best.loc).city} · {best.players}/{best.max} — самый живой сервер под фильтр, где есть место</span>
                  </div>
                  <Actions s={best} big />
                </section>
              )}

              {list.length ? (
                <>
                  <div className="srv-grid">
                    {list.slice(0, shown).map((s) => <ServerCard key={s.key} s={s} loc={loc(s.loc)} hl={!!join && s.ip === join.ip && s.port === join.port} />)}
                  </div>
                  {list.length > shown && (
                    <div className="row" style={{ justifyContent: 'center' }}>
                      <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>Показать ещё {Math.min(PAGE, list.length - shown)} из {list.length - shown}</button>
                    </div>
                  )}
                </>
              ) : (
                <div className="empty">Под такой фильтр серверов нет. Попробуй другой город{f.slots ? ' или меньше мест' : ''}.</div>
              )}
            </>
          ) : (
            <div className="empty">Серверов этого режима сейчас нет. <button type="button" className="link srv-linkbtn" onClick={() => pickMode(DEFAULT_MODE)}>К дуэлям</button></div>
          )}

          <section className="card pad stack srv-help">
            <h3>Как зайти с другом</h3>
            <p className="muted small">1. Выбери «Нас 2» (или сколько вас) — останутся серверы, где хватит мест на всех, а «Быстрое подключение» сразу предложит лучший.</p>
            <p className="muted small">2. Нажми 👥 на карточке сервера — скопируется ссылка. Отправь её другу: он откроет её и зайдёт на тот же сервер.</p>
            <p className="muted small">3. «Играть» запускает CS2 через Steam и подключает к серверу. Если игра уже открыта, можно нажать ⧉ и вставить команду <span className="mono">connect IP:порт</span> в консоль (клавиша ~).</p>
            <p className="tiny faint">Серверы принадлежат проекту Cybershoke; RUSH B только показывает их публичный список (cybershoke.net) и не связан с Cybershoke. Ранги, статистика и премиум — на их сайте.</p>
          </section>
        </>
      )}
    </div>
  );
}
