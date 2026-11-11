import { useEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from '../components/ui';
import { copy, useAsync } from '../lib/hooks';
import { extUrl, href, setQuery, useRoute } from '../lib/router';
import { decodeCode } from '../lib/crosshair';
import { paintCrosshair } from '../lib/crosshair-draw';
import { loadLpLogos, loadTeamIndex, teamKeys, useTeamLogos, useTeamSlug, type TeamIndex } from '../lib/teams';
import { LINK_META, linkUrl, countryRu, ROLE_RU } from '../lib/people';
import '../styles/players.css';

let avatarsP: Promise<Record<string, string>> | null = null;
function useAvatars() {
  const [a, setA] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!avatarsP) avatarsP = fetch(import.meta.env.BASE_URL + 'data/players/avatars.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    avatarsP.then(setA);
  }, []);
  return a;
}
const HUE = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; };
/** Steam avatar of the player (if the site has it) or initials */
function PlayerAvatar({ sid, name, size = 32, avatars }: { sid: string; name: string; size?: number; avatars: Record<string, string> }) {
  const [bad, setBad] = useState(false);
  const h = avatars[sid];
  if (h && !bad) return <img className="pl-ava" src={`https://avatars.steamstatic.com/${h}_${size > 64 ? 'full' : 'medium'}.jpg`} alt="" width={size} height={size} loading="lazy" onError={() => setBad(true)} />;
  return <span className="pl-ava pl-ini" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${HUE(name)} 35% 32%)` }}>{name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?'}</span>;
}
function TeamLogo({ team, size = 22, logo }: { team: string; size?: number; logo: ReturnType<typeof useTeamLogos> }) {
  const src = team ? logo(team) : null;
  if (src) return <img className="pl-team-logo" src={src} alt="" width={size} height={size} loading="lazy" />;
  return <span className="pl-team-logo pl-ini" style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${HUE(team || '?')} 30% 30%)` }}>{(team || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase()}</span>;
}

/** players/index.json and players/<steamid>.json, built from tournament demos by tools/demos/build_lineups.py */
type Index = { updated: string; cols: string[]; rows: (string | number)[][] };
type Row = { sid: string; name: string; team: string; maps: number; rounds: number; k: number; d: number; a: number; hs: number; adr: number; ud: number; fk: number; fd: number; fa: number; awp: number; xhair: string; last: string };
type Game = [string, string, string, string, string, string, number, number, number, number, number]; // date, map, match, event, url, team, k, d, a, adr, rounds
type Profile = { sid: string; name: string; names: string[]; team: string; teams: [string, number][]; xhair: string; xhairs: [string, string][]; maps: Record<string, number>; games: Game[] };

const BASE = import.meta.env.BASE_URL + 'data/players/';

// ---- official pages / channels (Liquipedia infobox, FACEIT API) — built by scripts/build-player-links.mjs ----
type PlayerInfo = { lp?: string; id?: string; name?: string; rn?: string; c?: string; b?: string; r?: string; st?: string; l: Record<string, string>; fl?: number; fe?: number };
let linksP: Promise<Record<string, PlayerInfo>> | null = null;
function useLinks() {
  const [v, setV] = useState<Record<string, PlayerInfo> | null>(null);
  useEffect(() => {
    linksP ||= fetch(BASE + 'links.json').then((r) => (r.ok ? r.json() : { p: {} })).then((j) => j.p || {}).catch(() => ({}));
    let live = true;
    linksP.then((x) => live && setV(x));
    return () => { live = false; };
  }, []);
  return v;
}
function age(b: string) {
  const d = new Date(b + 'T00:00:00Z'), n = new Date();
  let a = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) a--;
  return a;
}
const yearsRu = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'год' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'года' : 'лет');

function PlayerLinks({ sid, info }: { sid: string; info: PlayerInfo | undefined }) {
  const keys = Object.keys(LINK_META).filter((k) => info?.l?.[k]);
  return (
    <div className="pl-links">
      {keys.map((k) => {
        const m = LINK_META[k];
        const extra = k === 'faceit' && info?.fl ? ` · ${info.fl} ур.${info.fe ? ` · ${info.fe} ELO` : ''}` : '';
        return (
          <a key={k} className="pl-link" href={linkUrl(k, info!.l[k])} target="_blank" rel="noreferrer" title={`${m.ru}: ${info!.l[k]}`}>
            <i style={{ background: m.color }} />{m.ru}{extra}
          </a>
        );
      })}
      <a className="pl-link" href={`https://steamcommunity.com/profiles/${sid}`} target="_blank" rel="noreferrer"><i style={{ background: '#66c0f4' }} />Steam</a>
      {info?.lp && <a className="pl-link" href={`https://liquipedia.net/counterstrike/${encodeURIComponent(info.lp.replace(/ /g, '_'))}`} target="_blank" rel="noreferrer"><i style={{ background: '#3d8ee6' }} />Liquipedia</a>}
    </div>
  );
}
const MAP_RU: Record<string, string> = { mirage: 'Mirage', inferno: 'Inferno', nuke: 'Nuke', ancient: 'Ancient', anubis: 'Anubis', dust2: 'Dust II', cache: 'Cache', overpass: 'Overpass', train: 'Train', vertigo: 'Vertigo' };
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) + '%' : '—');

function useIndex() {
  return useAsync(() => fetch(BASE + 'index.json').then((r) => (r.ok ? (r.json() as Promise<Index>) : null)).catch(() => null), []);
}
function toRows(ix: Index | null): Row[] {
  if (!ix) return [];
  return ix.rows.map((r) => Object.fromEntries(ix.cols.map((c, i) => [c, r[i]])) as unknown as Row);
}

type SortKey = 'name' | 'team' | 'maps' | 'kd' | 'adr' | 'hs' | 'kpr' | 'open' | 'awp' | 'ud';
const SORTS: { k: SortKey; ru: string; v: (r: Row) => number | string; title?: string }[] = [
  { k: 'maps', ru: 'Карт', v: (r) => r.maps },
  { k: 'kd', ru: 'K/D', v: (r) => r.k / Math.max(r.d, 1) },
  { k: 'adr', ru: 'ADR', v: (r) => r.adr, title: 'Средний урон за раунд' },
  { k: 'kpr', ru: 'Убийств/раунд', v: (r) => r.k / Math.max(r.rounds, 1) },
  { k: 'hs', ru: 'HS', v: (r) => r.hs / Math.max(r.k, 1), title: 'Доля убийств в голову' },
  { k: 'open', ru: 'Первые', v: (r) => r.fk / Math.max(r.fk + r.fd, 1), title: 'Доля выигранных первых дуэлей раунда' },
  { k: 'awp', ru: 'AWP', v: (r) => r.awp / Math.max(r.k, 1), title: 'Доля убийств с AWP' },
  { k: 'ud', ru: 'Урон гранатами', v: (r) => r.ud / Math.max(r.rounds, 1), title: 'Урон HE и молотовами за раунд' },
];

export default function Players({ sid }: { sid?: string }) {
  if (sid) return <PlayerPage sid={sid} key={sid} />;
  return <PlayerList />;
}

function PlayerList() {
  const ix = useIndex();
  const { query } = useRoute();
  const q = query.get('q') || '';
  const team = query.get('team') || '';
  const min = +(query.get('min') || 3);
  const sort = (query.get('sort') || 'maps') as SortKey;
  // text columns go A→Я first, numbers from the largest; a second click on the same column flips it
  const rev = query.get('rev') === '1';
  const textCol = sort === 'name' || sort === 'team';
  const asc = textCol !== rev;
  const sortBy = (k: SortKey) => setQuery(k === sort ? { rev: rev ? null : '1' } : { sort: k === 'maps' ? null : k, rev: null });
  const arrow = (k: SortKey) => (k === sort ? (asc ? ' ↑' : ' ↓') : '');
  // the ranking of teams opens first; old links with a team filter / sort keep showing the players table
  const tab = query.get('tab') || (query.get('team') || query.get('sort') || query.get('q') ? 'players' : 'teams');
  const rows = useMemo(() => toRows(ix.data), [ix.data]);
  const avatars = useAvatars();
  const logo = useTeamLogos();
  const slugOf = useTeamSlug();
  const teams = useMemo(() => {
    const c = new Map<string, Row[]>();
    for (const r of rows) if (r.team) c.set(r.team, [...(c.get(r.team) || []), r]);
    return [...c.entries()].map(([t, ps]) => ({ team: t, players: ps.sort((a, b) => b.maps - a.maps), maps: Math.max(...ps.map((p) => p.maps)) })).sort((a, b) => b.maps - a.maps);
  }, [rows]);
  const list = useMemo(() => {
    const nq = q.trim().toLowerCase();
    const s = SORTS.find((x) => x.k === sort) || SORTS[0];
    return rows
      .filter((r) => (!nq || r.name.toLowerCase().includes(nq) || r.team.toLowerCase().includes(nq)) && (!team || r.team === team) && r.maps >= (nq ? 1 : min))
      .sort((a, b) => {
        const d = sort === 'name' ? a.name.localeCompare(b.name, 'ru') : sort === 'team' ? (a.team || '\uffff').localeCompare(b.team || '\uffff', 'ru') || b.maps - a.maps : (s.v(a) as number) - (s.v(b) as number);
        return asc || sort === 'team' && !a.team !== !b.team ? d : -d;
      });
  }, [rows, q, team, min, sort, asc]);
  if (ix.loading) return <Spinner />;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="stack" style={{ gap: 6 }}>
        <h1>Команды и игроки</h1>
        <p className="muted">Статистика, прицелы и раскидки профи — посчитаны напрямую из турнирных демок: каждое убийство, урон и граната. Прицел — тот, с которым игрок играл в матче.</p>
        {ix.data && <p className="small muted">{rows.length.toLocaleString('ru-RU')} игроков · обновлено {new Date(ix.data.updated).toLocaleDateString('ru-RU')}</p>}
      </div>
      {!ix.data ? (
        <div className="notice">Профили игроков появятся после разбора про-демок — архив сейчас обрабатывается, загляните чуть позже.</div>
      ) : (
        <>
          <div className="card pad row" style={{ gap: 10 }}>
            <div className="tabs" style={{ borderBottom: 0 }}>
              <button className={tab === 'teams' ? 'on' : ''} style={tab === 'teams' ? { color: 'var(--text)', borderBottomColor: 'var(--accent)' } : undefined} onClick={() => setQuery({ tab: null, team: null, sort: null, rev: null })}>Команды · рейтинг</button>
              <button className={tab === 'players' ? 'on' : ''} style={tab === 'players' ? { color: 'var(--text)', borderBottomColor: 'var(--accent)' } : undefined} onClick={() => setQuery({ tab: 'players' })}>Игроки</button>
            </div>
            <input className="input small" placeholder="Поиск: ник или команда" value={q} onChange={(e) => setQuery({ q: e.target.value })} style={{ width: 220 }} />
            {tab === 'teams' && <TeamsControls />}
            {tab === 'players' && (
              <>
                <select className="select small" aria-label="Команда" value={team} onChange={(e) => setQuery({ team: e.target.value })}>
                  <option value="">Все команды</option>
                  {teams.map((t) => <option key={t.team} value={t.team}>{t.team}</option>)}
                </select>
                <label className="row small muted" style={{ gap: 6 }}>от
                  <select className="select small" aria-label="Минимум карт" value={min} onChange={(e) => setQuery({ min: e.target.value })}>
                    {[1, 3, 5, 10, 20].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>карт
                </label>
                <span className="small muted">{list.length}</span>
              </>
            )}
          </div>
          {tab === 'teams' ? (
            <TeamsTab rows={rows} teams={teams} q={q} avatars={avatars} logo={logo} />
          ) : (
            <div className="card table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="pl-sort" title="Сортировать; ещё клик — в обратную сторону" style={{ color: sort === 'name' ? 'var(--text)' : undefined }} onClick={() => sortBy('name')}>Игрок{arrow('name')}</th>
                    <th className="pl-sort" title="Сортировать; ещё клик — в обратную сторону" style={{ color: sort === 'team' ? 'var(--text)' : undefined }} onClick={() => sortBy('team')}>Команда{arrow('team')}</th>
                    {SORTS.map((s) => <th key={s.k} className="r pl-sort" title={(s.title ? s.title + '. ' : '') + 'Клик — сортировать, ещё клик — в обратную сторону'} style={{ color: sort === s.k ? 'var(--text)' : undefined }} onClick={() => sortBy(s.k)}>{s.ru}{arrow(s.k)}</th>)}
                    <th>Прицел</th>
                  </tr>
                </thead>
                <tbody>
                  {list.slice(0, 400).map((r) => (
                    <tr key={r.sid} className="click" onClick={() => { location.hash = `#/player/${r.sid}`; }}>
                      <td><span className="row" style={{ gap: 10, flexWrap: 'nowrap' }}><PlayerAvatar sid={r.sid} name={r.name} size={32} avatars={avatars} /><b>{r.name}</b></span></td>
                      <td className="muted small"><span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>{r.team ? <TeamLogo team={r.team} size={22} logo={logo} /> : null}{slugOf(r.team) ? <a className="nowrap pl-tname" href={href(`/team/${slugOf(r.team)}`)} onClick={(e) => e.stopPropagation()}>{r.team}</a> : <span className="nowrap">{r.team}</span>}</span></td>
                      <td className="r num">{r.maps}</td>
                      <td className="r num">{f2(r.k / Math.max(r.d, 1))}</td>
                      <td className="r num">{f1(r.adr)}</td>
                      <td className="r num">{f2(r.k / Math.max(r.rounds, 1))}</td>
                      <td className="r num">{pct(r.hs, r.k)}</td>
                      <td className="r num" title={`${r.fk} побед / ${r.fd} поражений`}>{pct(r.fk, r.fk + r.fd)}</td>
                      <td className="r num">{pct(r.awp, r.k)}</td>
                      <td className="r num">{f1(r.ud / Math.max(r.rounds, 1))}</td>
                      <td>{r.xhair ? <XhairThumb code={r.xhair} size={36} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!list.length && <div className="empty small">Никого не нашли</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function XhairThumb({ code, size = 120, zoom = 1, bg = '#6b6f76' }: { code: string; size?: number; zoom?: number; bg?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const res = decodeCode(code, 1080);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const px = Math.round(size / zoom);
    c.width = px; c.height = px;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, px, px);
    if (res.ok) paintCrosshair(ctx, res.ch, 1080, Math.floor(px / 2), Math.floor(px / 2));
  }, [code, size, zoom, bg]);
  return <canvas ref={ref} style={{ width: size, height: size, imageRendering: 'pixelated', borderRadius: 6, display: 'block' }} />;
}

function PlayerPage({ sid }: { sid: string }) {
  const p = useAsync(() => fetch(BASE + sid + '.json').then((r) => (r.ok ? (r.json() as Promise<Profile>) : null)).catch(() => null), [sid]);
  const ix = useIndex();
  const row = useMemo(() => toRows(ix.data).find((r) => r.sid === sid) || null, [ix.data, sid]);
  const [allGames, setAllGames] = useState(false);
  const avatars = useAvatars();
  const logo = useTeamLogos();
  const links = useLinks();
  const info = links?.[sid];
  if (p.loading || ix.loading) return <Spinner />;
  const d = p.data;
  if (!d || !row) return <LitePlayer sid={sid} />;
  const r = row;
  const kd = r.k / Math.max(r.d, 1);
  const stats: [string, string, string?][] = [
    ['Карт', String(r.maps)], ['Раундов', String(r.rounds)], ['K/D', f2(kd), `${r.k} / ${r.d}`], ['ADR', f1(r.adr), 'урон за раунд'],
    ['Убийств/раунд', f2(r.k / Math.max(r.rounds, 1))], ['HS', pct(r.hs, r.k), 'убийств в голову'],
    ['Первые дуэли', pct(r.fk, r.fk + r.fd), `${r.fk} выиграно / ${r.fd} проиграно`], ['С AWP', pct(r.awp, r.k), `${r.awp} убийств`],
    ['Ассисты флешкой', String(r.fa)], ['Урон гранатами', f1(r.ud / Math.max(r.rounds, 1)), 'за раунд'],
  ];
  const maps = Object.entries(d.maps).sort((a, b) => b[1] - a[1]);
  const games = allGames ? d.games : d.games.slice(0, 15);
  const xhDate = d.xhairs[0]?.[0];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="small muted"><a className="link" href="#/players">Игроки</a> / {d.name}</div>
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div className="stack" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'nowrap' }}>
            <PlayerAvatar sid={d.sid} name={d.name} size={72} avatars={avatars} />
            <h1>{d.name}</h1>
          </div>
          <div className="muted row" style={{ gap: 8 }}>{d.team ? <TeamLogo team={d.team} size={22} logo={logo} /> : null}{d.team || 'Без команды'}{d.teams.length > 1 ? <span className="small"> · ранее: {d.teams.filter(([t]) => t !== d.team).map(([t]) => t).join(', ')}</span> : null}</div>
          {(info?.name || info?.c || info?.b || info?.r) && (
            <div className="small muted row" style={{ gap: 6 }}>
              {[
                info.rn ? `${info.rn}${info.name && info.name !== info.rn ? ` (${info.name})` : ''}` : info.name,
                info.c ? countryRu(info.c) : '',
                info.b ? `${age(info.b)} ${yearsRu(age(info.b))}` : '',
                info.r ? info.r.split(',').map((x) => ROLE_RU[x] || x).join(', ') : '',
              ].filter(Boolean).join(' · ')}
            </div>
          )}
          {d.names.length > 1 && <div className="tiny faint">другие ники в демках: {d.names.slice(1).join(', ')}</div>}
        </div>
      </div>
      <PlayerLinks sid={d.sid} info={info} />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(280px, 1fr)', alignItems: 'start' }}>
        <div className="stack" style={{ gap: 16 }}>
          <div className="card pad">
            <div className="pl-stats">
              {stats.map(([k, v, t]) => <div key={k} className="pl-stat" title={t}><span className="tiny muted">{k}</span><b className="num">{v}</b>{t ? <span className="tiny faint">{t}</span> : null}</div>)}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Матчи</h3><span className="small muted">{d.games.length}</span></div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Дата</th><th>Карта</th><th>Матч</th><th className="r">K–D–A</th><th className="r">ADR</th><th /></tr></thead>
                <tbody>
                  {games.map((g, i) => (
                    <tr key={i}>
                      <td className="small muted nowrap">{g[0] ? new Date(g[0]).toLocaleDateString('ru-RU') : ''}</td>
                      <td className="small">{MAP_RU[g[1]] || g[1]}</td>
                      <td className="small">{g[2]}<div className="tiny faint">{g[3]}</div></td>
                      <td className="r num" style={{ color: g[6] > g[7] ? 'var(--good)' : g[6] < g[7] ? 'var(--bad)' : undefined }}>{g[6]}–{g[7]}–{g[8]}</td>
                      <td className="r num">{f1(g[9])}</td>
                      <td>{extUrl(g[4]) ? <a className="link small" href={extUrl(g[4])} target="_blank" rel="noreferrer" title="Матч на HLTV">↗</a> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {d.games.length > 15 && !allGames && <div className="pad"><button className="btn small" onClick={() => setAllGames(true)}>Показать все {d.games.length}</button></div>}
          </div>
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <div className="card pad stack" style={{ gap: 10 }}>
            <h3>Прицел</h3>
            {d.xhair ? (
              <>
                <div className="row" style={{ gap: 12, alignItems: 'center' }}>
                  <XhairThumb code={d.xhair} size={132} zoom={3} />
                  <div className="stack" style={{ gap: 6, minWidth: 0 }}>
                    <span className="tiny muted">из демки матча{xhDate ? ` ${new Date(xhDate).toLocaleDateString('ru-RU')}` : ''}; масштаб ×3</span>
                    <a className="btn small primary" href={href(`/crosshair?c=${encodeURIComponent(d.xhair)}`)}>Открыть в генераторе</a>
                  </div>
                </div>
                <div className="code small">{d.xhair}</div>
                <button className="btn small" onClick={() => copy(d.xhair, 'Код прицела скопирован')}>Копировать код</button>
                <p className="tiny muted">Код старого формата (матчи до обновления прицелов 30.09.2026). CS2 принимает его через импорт, генератор пересчитает его в новый формат.</p>
                {d.xhairs.length > 1 && new Set(d.xhairs.map((x) => x[1])).size > 1 && (
                  <details className="small"><summary className="link">Менял прицел ({new Set(d.xhairs.map((x) => x[1])).size} разных)</summary>
                    <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                      {[...new Map(d.xhairs.map((x) => [x[1], x[0]])).entries()].map(([code, date]) => (
                        <div key={code} className="row" style={{ gap: 8 }}><XhairThumb code={code} size={40} /><span className="tiny muted">{date ? new Date(date).toLocaleDateString('ru-RU') : ''}</span><a className="link tiny" href={href(`/crosshair?c=${encodeURIComponent(code)}`)}>открыть</a></div>
                      ))}
                    </div>
                  </details>
                )}
              </>
            ) : <p className="small muted">В демках прицел не найден.</p>}
          </div>
          <div className="card pad stack" style={{ gap: 8 }}>
            <h3>Раскидки {d.name}</h3>
            <p className="tiny muted">Гранаты игрока из этих матчей — с 3D-повтором каждого броска.</p>
            <div className="row" style={{ gap: 6 }}>
              {maps.map(([m, n]) => <a key={m} className="chip" href={href(`/nades/${m}?player=${encodeURIComponent(d.name)}`)}>{MAP_RU[m.replace('de_', '')] || m} · {n}</a>)}
            </div>
          </div>
        </div>
      </div>
      <p className="tiny muted">{info?.lp ? <>Имя, страна, роль и ссылки на соцсети — <a className="link" href="https://liquipedia.net/counterstrike/" target="_blank" rel="noreferrer">Liquipedia</a> (CC BY-SA 3.0){info.fl ? ', уровень FACEIT — FACEIT API' : ''}. </> : null}Статистика посчитана по турнирным демкам из открытого архива (OpenCS2, CC BY 4.0) — это не полная карьерная статистика, а только матчи, попавшие в базу.</p>
    </div>
  );
}

// ---- teams: world ranking (Valve Regional Standings) + our demo stats -------------------------------------
type Ranking = { date: string; prev: string | null; teams: [number, number, string, string[], string, number, number][] };
let rankP: Promise<Ranking | null> | null = null;
function useRanking() {
  const [r, setR] = useState<Ranking | null | undefined>(undefined);
  useEffect(() => {
    rankP ||= fetch(import.meta.env.BASE_URL + 'data/rankings.json').then((x) => (x.ok ? x.json() : null)).catch(() => null);
    rankP.then(setR);
  }, []);
  return r;
}
const REGION: Record<string, string> = { EU: 'Европа', AM: 'Америка', AS: 'Азия' };

function TeamsControls() {
  const { query } = useRoute();
  const reg = query.get('reg') || '';
  const tsort = query.get('tsort') || 'rank';
  return (
    <>
      <div className="seg">
        {[['', 'Весь мир'], ['EU', 'Европа'], ['AM', 'Америка'], ['AS', 'Азия']].map(([k, ru]) => <button key={k} className={reg === k ? 'on' : ''} onClick={() => setQuery({ reg: k || null })}>{ru}</button>)}
      </div>
      <select className="select small" aria-label="Сортировка команд" value={tsort} onChange={(e) => setQuery({ tsort: e.target.value === 'rank' ? null : e.target.value })}>
        <option value="rank">По мировому рейтингу</option>
        <option value="maps">По картам в наших демках</option>
      </select>
    </>
  );
}

type TeamCard = { name: string; rank?: number; pts?: number; reg?: string; rr?: number; prev?: number; roster: { nick: string; p?: Row; sid?: string }[]; demo?: { team: string; maps: number } };

type SquadPerson = { id: string; role: string; sid?: string; inactive?: number };
type SquadInfo = Record<string, { squad?: SquadPerson[]; standins?: SquadPerson[] }>;
let squadsP: Promise<SquadInfo> | null = null;
function TeamsTab({ rows, teams, q, avatars, logo }: { rows: Row[]; teams: { team: string; players: Row[]; maps: number }[]; q: string; avatars: Record<string, string>; logo: ReturnType<typeof useTeamLogos> }) {
  const rk = useRanking();
  // official rosters (Liquipedia team pages) replace the roster Valve counted, where we have them
  const [squads, setSquads] = useState<SquadInfo>({});
  const [tix, setTix] = useState<TeamIndex | null>(null);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  useEffect(() => {
    loadLpLogos().then((x) => setPhotos(x?.p || {}));
    squadsP ||= fetch(import.meta.env.BASE_URL + 'data/teams/info.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    squadsP.then(setSquads);
    loadTeamIndex().then(setTix);
  }, []);
  const { query } = useRoute();
  const reg = query.get('reg') || '';
  const tsort = query.get('tsort') || 'rank';
  const [limit, setLimit] = useState(60);
  const cards = useMemo(() => {
    const demo = new Map<string, (typeof teams)[0]>();
    for (const t of teams) for (const k of teamKeys(t.team)) if (!demo.has(k)) demo.set(k, t);
    const byNick = new Map<string, Row[]>();
    for (const r of rows) { const k = r.name.toLowerCase(); byNick.set(k, [...(byNick.get(k) || []), r]); }
    const used = new Set<string>();
    const out: TeamCard[] = [];
    const bySid = new Map(rows.map((r) => [r.sid, r]));
    const pageOf = (n: string) => { const sl = teamKeys(n).map((k) => tix?.k[k]).find(Boolean); return sl ? tix?.t.find((x) => x[0] === sl)?.[1] : undefined; };
    for (const [rank, pts, name, roster, region, rr, prev] of rk?.teams || []) {
      const d = teamKeys(name).map((k) => demo.get(k)).find(Boolean);
      if (d) used.add(d.team);
      // who plays now = the roster Valve counted; the Liquipedia squad gives SteamIDs to find their demo stats
      const pg = pageOf(name);
      const people = pg ? [...(squads[pg]?.squad || []), ...(squads[pg]?.standins || [])] : [];
      const players = roster.map((nick) => {
        const x = people.find((y) => y.id.toLowerCase() === nick.toLowerCase());
        const cands = byNick.get(nick.toLowerCase()) || [];
        const p = (x?.sid && bySid.get(x.sid)) || cands.find((c) => d && c.team === d.team) || cands.sort((a, b) => b.maps - a.maps)[0];
        return { nick, p, sid: x?.sid };
      });
      out.push({ name, rank, pts, reg: region, rr, prev, roster: players, demo: d ? { team: d.team, maps: d.maps } : undefined });
    }
    // teams we have demos of but that are not in the ranking (academies, old rosters)
    for (const t of teams) if (!used.has(t.team)) out.push({ name: t.team, roster: t.players.slice(0, 5).map((p) => ({ nick: p.name, p })), demo: { team: t.team, maps: t.maps } });
    return out;
  }, [rk, rows, teams, squads, tix]);
  const nq = q.trim().toLowerCase();
  const list = cards
    .filter((c) => (!reg || c.reg === reg) && (!nq || c.name.toLowerCase().includes(nq) || c.roster.some((x) => x.nick.toLowerCase().includes(nq))))
    .sort((a, b) => (tsort === 'maps' ? (b.demo?.maps || 0) - (a.demo?.maps || 0) : (a.rank || 1e9) - (b.rank || 1e9) || (b.demo?.maps || 0) - (a.demo?.maps || 0)));
  if (rk === undefined) return <Spinner />;
  return (
    <div className="stack" style={{ gap: 12 }}>
      {rk && <p className="small muted">Мировой рейтинг — официальный рейтинг Valve (Valve Regional Standings), по нему зовут на мейджоры. Обновлён {new Date(rk.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}{rk.prev ? `, стрелки — изменение места с ${new Date(rk.prev).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}` : ''}. Статистика игроков — из наших турнирных демок.</p>}
      <div className="pl-teams">
        {list.slice(0, limit).map((c) => <TeamCardView key={c.name + (c.rank || '')} c={c} avatars={avatars} photos={photos} logo={logo} />)}
      </div>
      {list.length > limit && <button className="btn" onClick={() => setLimit((l) => l + 120)}>Показать ещё ({list.length - limit})</button>}
      {!list.length && <div className="empty">Ничего не найдено</div>}
    </div>
  );
}

function TeamCardView({ c, avatars, photos, logo }: { c: TeamCard; avatars: Record<string, string>; photos: Record<string, string>; logo: ReturnType<typeof useTeamLogos> }) {
  const move = c.rank && c.prev ? c.prev - c.rank : null;
  const slugOf = useTeamSlug();
  const slug = slugOf(c.name, c.demo?.team);
  return (
    <div className={'card pad stack pl-tcard' + (c.rank && c.rank <= 3 ? ' top' + c.rank : '')} style={{ gap: 10 }}>
      <div className="pl-thead">
        {c.rank ? <span className="pl-wrank" title="Место в мировом рейтинге Valve">#{c.rank}</span> : <span className="pl-wrank none" title="Нет в мировом рейтинге Valve">—</span>}
        <TeamLogo team={c.demo?.team || c.name} size={36} logo={logo} />
        <div className="stack" style={{ gap: 2, minWidth: 0 }}>
          <h3 className="pl-ell" title={c.name}>{slug ? <a className="pl-tname" href={href(`/team/${slug}`)}>{c.name}</a> : c.name}</h3>
          <span className="tiny muted row" style={{ gap: 8 }}>
            {c.pts ? <span>{c.pts.toLocaleString('ru-RU')} очк.</span> : null}
            {c.reg ? <span>{REGION[c.reg]} #{c.rr}</span> : null}
            {move != null ? <span className={move > 0 ? 'pl-up' : move < 0 ? 'pl-down' : ''} title="Изменение места за месяц">{move > 0 ? `▲${move}` : move < 0 ? `▼${-move}` : '='}</span> : c.rank ? <span className="pl-up" title="Не было в прошлом рейтинге">new</span> : null}
            {!c.rank && c.demo ? <span>{c.demo.maps} карт в демках</span> : null}
          </span>
        </div>
      </div>
      <div className="pl-roster">
        {c.roster.map(({ nick, p, sid }) => {
          const inner = (
            <>
              {(p?.sid || sid) && photos[(p?.sid || sid)!] ? <img className="pl-ava pl-photo" src={import.meta.env.BASE_URL + 'data/logos/' + photos[(p?.sid || sid)!]} alt="" width={26} height={26} loading="lazy" />
                : p || sid ? <PlayerAvatar sid={p?.sid || sid!} name={nick} size={26} avatars={avatars} /> : <span className="pl-ava pl-ini" style={{ width: 26, height: 26, fontSize: 10, background: `hsl(${HUE(nick)} 25% 28%)` }}>{nick.slice(0, 2).toUpperCase()}</span>}
              <b className="pl-ell" title={nick}>{nick}</b>
              <span className="num tiny" title="K/D">{p ? f2(p.k / Math.max(p.d, 1)) : ''}</span>
              <span className="num tiny muted" title="ADR">{p ? f1(p.adr) : ''}</span>
            </>
          );
          const to = p?.sid || sid;
          return to ? <a key={nick} className="pl-rrow" href={href(`/player/${to}`)}>{inner}</a> : <div key={nick} className="pl-rrow">{inner}</div>;
        })}
      </div>
      <div className="row between tiny">
        {slug ? <a className="link small" href={href(`/team/${slug}`)}>Страница команды →</a> : c.demo ? <a className="link small" href={href(`/players?team=${encodeURIComponent(c.demo.team)}`)}>Статистика состава →</a> : <span className="muted">в наших демках пока нет</span>}
        {c.rank && c.demo ? <span className="muted">{c.demo.maps} карт</span> : null}
      </div>
    </div>
  );
}

// ---- a roster player we have no demos of yet: Liquipedia profile only ----
type Extra = PlayerInfo & { team?: string };
let extraP: Promise<Record<string, Extra>> | null = null;
function LitePlayer({ sid }: { sid: string }) {
  const [e, setE] = useState<Extra | null | undefined>(undefined);
  const [photo, setPhoto] = useState('');
  const avatars = useAvatars();
  const logo = useTeamLogos();
  const slugOf = useTeamSlug();
  useEffect(() => {
    extraP ||= fetch(BASE + 'extra.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    extraP.then((x) => setE(x[sid] || null));
    loadLpLogos().then((x) => { const f = x?.p?.[sid]; if (f) setPhoto(import.meta.env.BASE_URL + 'data/logos/' + f); });
  }, [sid]);
  if (e === undefined) return <Spinner />;
  if (!e) return <div className="notice">Игрок не найден. <a className="link" href="#/players">Все игроки</a></div>;
  const nick = e.id || e.lp || sid;
  const slug = e.team ? slugOf(e.team) : null;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="small muted"><a className="link" href="#/players">Игроки</a> / {nick}</div>
      <div className="row" style={{ gap: 18, flexWrap: 'nowrap', alignItems: 'center' }}>
        {photo ? <img className="pl-lite-photo" src={photo} alt={nick} /> : <PlayerAvatar sid={sid} name={nick} size={96} avatars={avatars} />}
        <div className="stack" style={{ gap: 6 }}>
          <h1>{nick}</h1>
          {e.team && <div className="muted row" style={{ gap: 8 }}><TeamLogo team={e.team} size={22} logo={logo} />{slug ? <a className="link" href={`#/team/${slug}`}>{e.team}</a> : e.team}</div>}
          <div className="small muted">
            {[e.rn ? `${e.rn}${e.name && e.name !== e.rn ? ` (${e.name})` : ''}` : e.name, e.c ? countryRu(e.c) : '', e.b ? `${age(e.b)} ${yearsRu(age(e.b))}` : '', e.r ? e.r.split(',').map((x) => ROLE_RU[x] || x).join(', ') : ''].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>
      <PlayerLinks sid={sid} info={e} />
      <div className="card pad stack" style={{ gap: 6 }}>
        <b>Статистики из демок пока нет</b>
        <span className="small muted">Игрок есть в официальном составе команды, но его матчей ещё нет в нашей базе турнирных демок. Как только демки с его участием будут разобраны, здесь появятся K/D, ADR, карты, прицел и раскидки.</span>
        {e.lp && <a className="link small" href={`https://liquipedia.net/counterstrike/${encodeURIComponent(e.lp.replace(/ /g, '_'))}`} target="_blank" rel="noreferrer">Профиль на Liquipedia ↗</a>}
      </div>
    </div>
  );
}
