import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createChart, LineSeries, type UTCTimestamp } from 'lightweight-charts';
import { Spinner } from '../components/ui';
import { useAsync, useDB, usePrices } from '../lib/hooks';
import { extUrl, href, navigate, setQuery, useRoute } from '../lib/router';
import { marketName, money, pick, usePrefs, type Flag } from '../lib/prefs';
import { loadCharms, loadStickers, type Prices } from '../lib/data';
import {
  api, apiBase, flag, gameImg, hours, hoursFmt, levelColor, MAPS, num, plural, profilePath, STATE, WEAPON_BY_ID, WEAPONS, years,
  type GameRow, type Inventory, type Ladder, type Profile,
} from '../lib/stats';
import '../styles/stats.css';

const MyMatches = lazy(() => import('../components/MyMatches'));
/** per-match stats exist only for accounts synced by .github/workflows/my-matches.yml */
const matchesUrl = (sid: string) => `https://raw.githubusercontent.com/vsemvamdam/rush-b/stats-data/matches/${sid}.json`;

export default function Stats({ id }: { id?: string }) {
  const base = useAsync(() => apiBase(), []);
  if (base.loading) return <Spinner />;
  if (!base.data) return <NotConfigured />;
  return id ? <ProfilePage id={id} key={id} /> : <StatsHome />;
}

function NotConfigured() {
  return (
    <div className="stack" style={{ gap: 16 }}>
      <SearchHero disabled />
      <div className="notice">Поиск профилей пока не работает: сервер статистики ещё не запущен. Когда он заработает, здесь можно будет открыть любой профиль Steam — уровень, XP, игры и часы, статистику CS2, инвентарь — и рейтинг профилей.</div>
    </div>
  );
}

function SearchHero({ compact, disabled }: { compact?: boolean; disabled?: boolean }) {
  const [q, setQ] = useState('');
  const go = (e: React.FormEvent) => { e.preventDefault(); if (q.trim()) navigate(profilePath(q)); };
  return (
    <div className={'st-hero' + (compact ? ' compact' : '')}>
      {!compact && (
        <div className="stack" style={{ gap: 6 }}>
          <h1>Статистика Steam и CS2</h1>
          <p className="muted">Уровень и XP, игры и часы, статистика CS2, баны, инвентарь и место в рейтинге — для любого открытого профиля. Обновляется при каждом открытии.</p>
        </div>
      )}
      <form className="st-search" onSubmit={go}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} disabled={disabled} placeholder={disabled ? 'Поиск появится после запуска сервера статистики' : 'Ссылка на профиль Steam, SteamID64 или ник из ссылки (steamcommunity.com/id/…)'} aria-label="Профиль Steam" />
        <button className="btn primary" type="submit" disabled={disabled}>Найти</button>
      </form>
    </div>
  );
}

const LADDERS: { k: string; ru: string; col: (r: Ladder['rows'][number]) => string }[] = [
  { k: 'xp', ru: 'Уровень', col: (r) => `${num(r.level)} ур. · ${num(r.xp)} XP` },
  { k: 'games', ru: 'Игры', col: (r) => `${num(r.games)} игр` },
  { k: 'playtime', ru: 'Часы в Steam', col: (r) => hoursFmt(r.playtime) },
  { k: 'cs2', ru: 'Часы в CS2', col: (r) => hoursFmt(r.cs2) },
  { k: 'badges', ru: 'Значки', col: (r) => `${num(r.badges)} значков` },
  { k: 'age', ru: 'Старейшие', col: (r) => (r.created ? new Date(r.created * 1000).toLocaleDateString('ru-RU') : '—') },
];

function StatsHome() {
  const { query } = useRoute();
  const by = query.get('by') || 'xp';
  const country = query.get('country') || '';
  const page = +(query.get('page') || 0);
  const lad = useAsync(() => api<Ladder>(`/api/ladder?by=${encodeURIComponent(by)}&limit=50&offset=${(Math.max(0, Math.trunc(page)) || 0) * 50}${country ? `&country=${encodeURIComponent(country)}` : ''}`), [by, country, page]);
  const L = LADDERS.find((x) => x.k === by) || LADDERS[0];
  return (
    <div className="stack" style={{ gap: 18 }}>
      <SearchHero />
      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <div className="stack" style={{ gap: 2 }}>
            <h3>Рейтинг профилей</h3>
            <span className="tiny muted">все профили, открытые на сайте; обновляются каждые несколько минут</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <div className="seg st-seg-scroll">
              {LADDERS.map((x) => <button key={x.k} className={by === x.k ? 'on' : ''} onClick={() => setQuery({ by: x.k === 'xp' ? null : x.k, page: null })}>{x.ru}</button>)}
            </div>
            <select aria-label="Страна" className="select small" value={country} onChange={(e) => setQuery({ country: e.target.value || null, page: null })}>
              <option value="">Все страны</option>
              {(lad.data?.countries || []).map((c) => <option key={c.country} value={c.country}>{flag(c.country)} {c.country} · {c.n}</option>)}
            </select>
          </div>
        </div>
        {lad.loading ? <Spinner /> : lad.error ? <div className="notice bad" style={{ margin: 16 }}>{lad.error}</div> : (
          <>
            <div className="st-ladder">
              {lad.data!.rows.map((r, i) => (
                <a key={r.steamid} className="st-lrow" href={href(`/stats/${r.steamid}`)}>
                  <span className="st-pos num">{page * 50 + i + 1}</span>
                  <img src={r.avatar} alt="" loading="lazy" width={36} height={36} />
                  <span className="st-lname"><b>{r.name}</b> <span>{flag(r.country)}</span>{r.vac ? <span className="badge" style={{ marginLeft: 6, color: 'var(--bad)' }}>бан</span> : null}</span>
                  <span className="st-lvl" style={{ borderColor: levelColor(r.level) }}>{num(r.level)}</span>
                  <span className="st-lval num">{L.col(r)}</span>
                </a>
              ))}
              {!lad.data!.rows.length && <div className="empty small">Пока никого — откройте свой профиль через поиск выше, и он появится в рейтинге.</div>}
            </div>
            {lad.data!.total > 50 && (
              <div className="row between pad">
                <button className="btn small" disabled={page === 0} onClick={() => setQuery({ page: page - 1 || null })}>← Назад</button>
                <span className="small muted">{page * 50 + 1}–{Math.min((page + 1) * 50, lad.data!.total)} из {lad.data!.total.toLocaleString('ru-RU')}</span>
                <button className="btn small" disabled={(page + 1) * 50 >= lad.data!.total} onClick={() => setQuery({ page: page + 1 })}>Дальше →</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function ProfilePage({ id }: { id: string }) {
  const [fresh, setFresh] = useState(0);
  const p = useAsync(() => api<Profile>(`/api/profile?id=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`), [id, fresh]);
  const { query } = useRoute();
  const tab = query.get('tab') || 'overview';
  const hasMatches = useAsync(() => fetch(matchesUrl(id), { method: 'HEAD' }).then((r) => r.ok).catch(() => false), [id]);
  useEffect(() => {
    // vanity / link in the address → canonical SteamID64 address
    if (p.data && p.data.steamid !== id) navigate(`/stats/${p.data.steamid}${tab !== 'overview' ? `?tab=${tab}` : ''}`, true);
  }, [p.data, id, tab]);
  if (p.loading && !p.data) return <Spinner />;
  if (p.error || !p.data) {
    return (
      <div className="stack" style={{ gap: 16 }}>
        <SearchHero compact />
        <div className="notice bad">{p.error === 'not-configured' ? 'Сервер статистики ещё не подключён.' : p.error || 'Профиль не найден'}</div>
      </div>
    );
  }
  const d = p.data;
  const TABS = [
    { k: 'overview', ru: 'Обзор' },
    { k: 'cs2', ru: 'CS2' },
    { k: 'games', ru: `Игры${d.games ? ` · ${d.games.count}` : ''}` },
    { k: 'inventory', ru: 'Инвентарь' },
    ...(hasMatches.data ? [{ k: 'matches', ru: 'Матчи' }] : []),
  ];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <SearchHero compact />
      <Header d={d} onRefresh={() => setFresh((x) => x + 1)} loading={p.loading} />
      <div className="tabs st-tabs">
        {TABS.map((t) => <button key={t.k} className={tab === t.k ? 'on' : ''} onClick={() => setQuery({ tab: t.k === 'overview' ? null : t.k })}>{t.ru}</button>)}
      </div>
      {!d.public && <div className="notice warn">Профиль скрыт: Steam отдаёт только имя и аватар. Чтобы увидеть игры и статистику, откройте в настройках приватности Steam «Профиль» и «Игровую информацию».</div>}
      {tab === 'overview' && <Overview d={d} />}
      {tab === 'cs2' && <CS2Stats d={d} />}
      {tab === 'games' && <Games d={d} />}
      {tab === 'inventory' && <InventoryTab steamid={d.steamid} />}
      {tab === 'matches' && <Suspense fallback={<Spinner />}><MyMatches steamid={d.steamid} /></Suspense>}
      <p className="tiny muted">Данные Steam Web API{d.fetched ? ` · получены ${new Date(d.fetched * 1000).toLocaleString('ru-RU')}` : ''}. Steam отдаёт статистику только по открытым профилям.</p>
    </div>
  );
}

function LevelBadge({ level, size = 54 }: { level: number | null; size?: number }) {
  const c = levelColor(level);
  return (
    <span className={'st-level' + ((level || 0) >= 100 ? ' hex' : '')} style={{ width: size, height: size, borderColor: c, fontSize: size * 0.36 }} title="Уровень Steam">
      {level ?? '?'}
    </span>
  );
}

function Header({ d, onRefresh, loading }: { d: Profile; onRefresh: () => void; loading: boolean }) {
  const xpIn = d.xp != null && d.xpCur != null ? d.xp - d.xpCur : null;
  const xpSpan = xpIn != null && d.xpNext != null ? xpIn + d.xpNext : null;
  const banned = d.bans && (d.bans.vac || d.bans.game || d.bans.community || d.bans.economy);
  return (
    <div className="card st-head">
      <img className="st-avatar" src={d.avatar} alt="" width={96} height={96} />
      <div className="st-head-main">
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <h1 style={{ fontSize: 30 }}>{d.name}</h1>
          {d.country && <span style={{ fontSize: 22 }} title={d.country}>{flag(d.country)}</span>}
          <span className={'st-state s' + d.state}>{d.ingame ? `В игре: ${d.ingame}` : STATE[d.state] || ''}</span>
        </div>
        <div className="row small muted" style={{ gap: 14 }}>
          <span>Аккаунту {years(d.created)}{d.created ? ` (с ${new Date(d.created * 1000).toLocaleDateString('ru-RU')})` : ''}</span>
          {d.friends != null && <span>{num(d.friends)} {plural(d.friends, 'друг', 'друга', 'друзей')}</span>}
          <span className="faint">{d.steamid}</span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {banned ? <>
            {d.bans!.vac ? <span className="badge" style={{ color: 'var(--bad)' }}>VAC: {d.bans!.vac}</span> : null}
            {d.bans!.game ? <span className="badge" style={{ color: 'var(--bad)' }}>игровых банов: {d.bans!.game}</span> : null}
            {d.bans!.community ? <span className="badge" style={{ color: 'var(--bad)' }}>бан сообщества</span> : null}
            {d.bans!.economy ? <span className="badge" style={{ color: 'var(--warn)' }}>ограничен обмен</span> : null}
            {d.bans!.days ? <span className="tiny muted">последний {d.bans!.days} дн. назад</span> : null}
          </> : d.bans ? <span className="badge" style={{ color: 'var(--good)' }}>банов нет</span> : null}
        </div>
      </div>
      <div className="st-head-level">
        <LevelBadge level={d.level} size={64} />
        <div className="stack" style={{ gap: 4, minWidth: 160 }}>
          <span className="small"><b>{num(d.xp)}</b> XP</span>
          {xpSpan ? (
            <>
              <div className="st-bar"><span style={{ width: `${Math.round((xpIn! / xpSpan) * 100)}%`, background: levelColor(d.level) }} /></div>
              <span className="tiny muted">до {(d.level || 0) + 1} уровня — {num(d.xpNext)} XP</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="st-head-actions">
        <a className="btn small ghost" href={extUrl(d.url)} target="_blank" rel="noreferrer">Steam ↗</a>
        <button className="btn small ghost" onClick={onRefresh} disabled={loading}>{loading ? 'Обновляю…' : '↻ Обновить'}</button>
      </div>
    </div>
  );
}

function Kpi({ k, v, sub, rank, total }: { k: string; v: string; sub?: string; rank?: number | null; total?: number }) {
  return (
    <div className="st-kpi">
      <span className="tiny muted">{k}</span>
      <b className="num">{v}</b>
      {sub && <span className="tiny faint">{sub}</span>}
      {rank ? <span className="st-rank" title={`Место среди ${total?.toLocaleString('ru-RU')} профилей на сайте`}>#{rank.toLocaleString('ru-RU')}</span> : null}
    </div>
  );
}

function Overview({ d }: { d: Profile }) {
  const r = d.ranks || { total: 0 };
  const hist = useAsync(() => api<{ rows: number[][] }>(`/api/history?id=${d.steamid}`).catch(() => null), [d.steamid]);
  const s = d.stats;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="st-kpis">
        <Kpi k="Уровень Steam" v={num(d.level)} sub={`${num(d.xp)} XP`} rank={r.xp} total={r.total} />
        <Kpi k="Игр" v={num(d.games?.count)} sub={d.games ? `запускал ${num(d.games.played)}` : undefined} rank={r.games} total={r.total} />
        <Kpi k="Часов в Steam" v={hours(d.games?.playtime)} rank={r.playtime} total={r.total} />
        <Kpi k="Часов в CS2" v={hours(d.cs2?.m)} sub={d.cs2 ? `${hours(d.cs2.m2)} ч за 2 недели` : undefined} rank={r.cs2} total={r.total} />
        <Kpi k="Значков" v={num(d.badges)} rank={r.badges} total={r.total} />
        <Kpi k="Достижений CS2" v={num(d.achievements)} />
      </div>
      <FaceitBlock steamid={d.steamid} />
      {s && (
        <div className="card pad">
          <div className="row between" style={{ marginBottom: 12 }}><h3>CS2 коротко</h3><a className="link small" href={href(`/stats/${d.steamid}?tab=cs2`)}>Вся статистика →</a></div>
          <CsRings s={s} />
        </div>
      )}
      {d.public && <Showcase steamid={d.steamid} />}
      {s && <WeaponStrip s={s} />}
      <div className="grid st-2col">
        <div className="card">
          <div className="card-head"><h3>Последние 2 недели</h3><span className="small muted">{hoursFmt(d.games?.recent.reduce((a, g) => a + g.m2, 0))}</span></div>
          <GameBars games={d.games?.recent || []} field="m2" empty="За две недели игр нет" />
        </div>
        <div className="card">
          <div className="card-head"><h3>История профиля</h3><span className="tiny muted">по дням, с первого открытия на сайте</span></div>
          <HistoryChart rows={hist.data?.rows || []} />
        </div>
      </div>
    </div>
  );
}

function HistoryChart({ rows }: { rows: number[][] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [field, setField] = useState(2); // 2 = xp, 4 = playtime, 5 = cs2, 3 = games
  const { theme } = usePrefs();
  useEffect(() => {
    if (!ref.current || rows.length < 2) return;
    const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: css('--muted'), fontFamily: 'Inter, system-ui, sans-serif', attributionLogo: true },
      grid: { vertLines: { color: 'transparent' }, horzLines: { color: css('--border') } },
      rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
      localization: { locale: 'ru-RU', priceFormatter: (v: number) => (field >= 4 ? `${Math.round(v / 60).toLocaleString('ru-RU')} ч` : Math.round(v).toLocaleString('ru-RU')) },
    });
    const s = chart.addSeries(LineSeries, { color: css('--accent'), lineWidth: 2, priceLineVisible: false });
    s.setData(rows.filter((r) => r[field] != null).map((r) => ({ time: (r[0] * 86400) as UTCTimestamp, value: r[field] })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [rows, field, theme]);
  if (rows.length < 2) return <div className="empty small">График появится, когда профиль накопит хотя бы два дня наблюдений — сайт обновляет его автоматически.</div>;
  return (
    <div className="pad stack" style={{ gap: 8 }}>
      <div className="seg">
        {[[2, 'XP'], [3, 'Игры'], [4, 'Часы Steam'], [5, 'Часы CS2']].map(([k, ru]) => <button key={k} className={field === k ? 'on' : ''} onClick={() => setField(k as number)}>{ru}</button>)}
      </div>
      <div ref={ref} style={{ height: 220 }} />
    </div>
  );
}

function GameBars({ games, field, empty, limit = 12 }: { games: GameRow[]; field: 'm' | 'm2'; empty: string; limit?: number }) {
  const list = [...games].sort((a, b) => b[field] - a[field]).filter((g) => g[field] > 0).slice(0, limit);
  const max = Math.max(1, ...list.map((g) => g[field]));
  if (!list.length) return <div className="empty small">{empty}</div>;
  return (
    <div className="st-games">
      {list.map((g) => (
        <a key={g.a} className="st-game" href={`https://store.steampowered.com/app/${g.a}`} target="_blank" rel="noreferrer">
          <img src={gameImg(g.a)} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
          <div className="st-game-main">
            <div className="row between" style={{ gap: 8, flexWrap: 'nowrap' }}><span className="st-ell">{g.n}</span><b className="num nowrap">{hoursFmt(g[field])}</b></div>
            <div className="st-bar thin"><span style={{ width: `${(g[field] / max) * 100}%` }} /></div>
            {field === 'm' && g.m2 > 0 && <span className="tiny faint">{hoursFmt(g.m2)} за 2 недели</span>}
          </div>
        </a>
      ))}
    </div>
  );
}

function Games({ d }: { d: Profile }) {
  if (!d.games) return <div className="notice">Список игр скрыт настройками приватности.</div>;
  const g = d.games;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="st-kpis">
        <Kpi k="Игр в библиотеке" v={num(g.count)} rank={d.ranks?.games} total={d.ranks?.total} />
        <Kpi k="Запускал" v={num(g.played)} sub={g.count ? `${Math.round((g.played / g.count) * 100)}% библиотеки` : undefined} />
        <Kpi k="Не запускал" v={num(g.count - g.played)} />
        <Kpi k="Всего часов" v={hours(g.playtime)} sub={g.played ? `в среднем ${Math.round(g.playtime / 60 / g.played)} ч на игру` : undefined} rank={d.ranks?.playtime} total={d.ranks?.total} />
      </div>
      <div className="card">
        <div className="card-head"><h3>Больше всего часов</h3><span className="small muted">топ-{Math.min(40, g.top.length)}</span></div>
        <GameBars games={g.top} field="m" empty="Нет данных" limit={40} />
      </div>
    </div>
  );
}

// ---- CS2 lifetime stats ----------------------------------------------------
function Ring({ value, max = 1, label, sub, color = 'var(--accent)' }: { value: number | null; max?: number; label: string; sub: string; color?: string }) {
  const f = value == null ? 0 : Math.max(0, Math.min(1, value / max));
  const R = 34, C = 2 * Math.PI * R;
  return (
    <div className="st-ring">
      <svg viewBox="0 0 84 84" width="96" height="96">
        <circle cx="42" cy="42" r={R} fill="none" stroke="var(--surface-3)" strokeWidth="8" />
        <circle cx="42" cy="42" r={R} fill="none" stroke={color} strokeWidth="8" strokeDasharray={`${f * C} ${C}`} strokeLinecap="round" transform="rotate(-90 42 42)" />
        <text x="42" y="46" textAnchor="middle" className="st-ring-v">{sub}</text>
      </svg>
      <span className="small muted">{label}</span>
    </div>
  );
}

function CsRings({ s }: { s: Record<string, number> }) {
  const k = s.total_kills || 0, d = s.total_deaths || 0;
  const kd = d ? k / d : null;
  const hs = k ? (s.total_kills_headshot || 0) / k : null;
  const acc = s.total_shots_fired ? (s.total_shots_hit || 0) / s.total_shots_fired : null;
  const wr = s.total_matches_played ? (s.total_matches_won || 0) / s.total_matches_played : s.total_rounds_played ? (s.total_wins || 0) / s.total_rounds_played : null;
  return (
    <div className="st-rings">
      <Ring value={kd} max={2} label="K/D" sub={kd == null ? '—' : kd.toFixed(2)} color={kd != null && kd >= 1 ? 'var(--good)' : 'var(--bad)'} />
      <Ring value={hs} label="В голову" sub={hs == null ? '—' : `${Math.round(hs * 100)}%`} />
      <Ring value={acc} max={0.4} label="Точность" sub={acc == null ? '—' : `${Math.round(acc * 100)}%`} color="#4e8ddb" />
      <Ring value={wr} label={s.total_matches_played ? 'Побед в матчах' : 'Побед в раундах'} sub={wr == null ? '—' : `${Math.round(wr * 100)}%`} color="var(--warn)" />
    </div>
  );
}

function CS2Stats({ d }: { d: Profile }) {
  const s = d.stats;
  if (!s) return <div className="notice">Статистика CS2 недоступна: профиль или «Игровая информация» скрыты, либо игрок ещё не играл.</div>;
  const v = (key: string) => s[key] || 0;
  const rounds = v('total_rounds_played');
  const tiles: [string, string, string?][] = [
    ['Убийств', num(v('total_kills')), `${(v('total_kills') / Math.max(rounds, 1)).toFixed(2)} за раунд`],
    ['Смертей', num(v('total_deaths'))],
    ['Урона', num(v('total_damage_done')), rounds ? `${Math.round(v('total_damage_done') / rounds)} за раунд` : undefined],
    ['MVP', num(v('total_mvps'))],
    ['Матчей', num(v('total_matches_played')), v('total_matches_played') ? `побед ${num(v('total_matches_won'))}` : undefined],
    ['Раундов', num(rounds), `побед ${num(v('total_wins'))}`],
    ['Пистолетных побед', num(v('total_wins_pistolround'))],
    ['Бомб заложено', num(v('total_planted_bombs'))],
    ['Бомб обезврежено', num(v('total_defused_bombs'))],
    ['Заработано денег', `$${num(v('total_money_earned'))}`],
    ['Ножом', num(v('total_kills_knife'))],
    ['Гранатой HE', num(v('total_kills_hegrenade'))],
    ['Ослеплённых врагов убито', num(v('total_kills_enemy_blinded'))],
    ['Против снайпера в прицеле', num(v('total_kills_against_zoomed_sniper'))],
    ['Оружием врага', num(v('total_kills_enemy_weapon'))],
    ['Доминаций', num(v('total_dominations'))],
    ['Окон разбито', num(v('total_broken_windows'))],
    ['Часов в CS2', hours(d.cs2?.m), d.cs2 ? `${hours(d.cs2.m2)} ч за 2 недели` : undefined],
  ];
  const weapons = WEAPONS.map(([key, name]) => ({ key, name, k: v('total_kills_' + key), shots: v('total_shots_' + key), hits: v('total_hits_' + key) })).filter((w) => w.k > 0).sort((a, b) => b.k - a.k);
  const wmax = Math.max(1, ...weapons.map((w) => w.k));
  const maps = MAPS.map(([key, name]) => ({ key, name, r: v('total_rounds_map_' + key), w: v('total_wins_map_' + key) })).filter((m) => m.r > 0).sort((a, b) => b.r - a.r);
  const last = s.last_match_rounds ? {
    k: v('last_match_kills'), d: v('last_match_deaths'), mvp: v('last_match_mvps'), dmg: v('last_match_damage'), rounds: v('last_match_rounds'),
    wins: v('last_match_wins'), ct: v('last_match_ct_wins'), t: v('last_match_t_wins'), fav: WEAPON_BY_ID[v('last_match_favweapon_id')], favK: v('last_match_favweapon_kills'),
    favAcc: v('last_match_favweapon_shots') ? v('last_match_favweapon_hits') / v('last_match_favweapon_shots') : null, money: v('last_match_money_spent'),
  } : null;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card pad"><CsRings s={s} /></div>
      <WeaponStrip s={s} />
      <div className="st-tiles">
        {tiles.map(([k, val, sub]) => <div key={k} className="st-tile"><span className="tiny muted">{k}</span><b className="num">{val}</b>{sub && <span className="tiny faint">{sub}</span>}</div>)}
      </div>
      {last && (
        <div className="card pad stack" style={{ gap: 10 }}>
          <h3>Последний матч</h3>
          <div className="st-tiles">
            <div className="st-tile"><span className="tiny muted">Счёт раундов</span><b className="num">{last.wins} : {last.rounds - last.wins}</b><span className="tiny faint">CT {last.ct} · T {last.t}</span></div>
            <div className="st-tile"><span className="tiny muted">K / D</span><b className="num">{last.k} / {last.d}</b><span className="tiny faint">MVP {last.mvp}</span></div>
            <div className="st-tile"><span className="tiny muted">ADR</span><b className="num">{last.rounds ? Math.round(last.dmg / last.rounds) : '—'}</b><span className="tiny faint">урон {num(last.dmg)}</span></div>
            {last.fav && <div className="st-tile"><span className="tiny muted">Любимое оружие</span><b>{last.fav}</b><span className="tiny faint">{last.favK} убийств{last.favAcc != null ? ` · точность ${Math.round(last.favAcc * 100)}%` : ''}</span></div>}
          </div>
        </div>
      )}
      <div className="grid st-2col wide">
        <div className="card">
          <div className="card-head"><h3>Оружие</h3><span className="tiny muted">убийства · точность</span></div>
          <div className="st-wlist">
            {weapons.map((w) => (
              <div key={w.key} className="st-wrow">
                <span className="st-wname">{w.name}</span>
                <div className="st-bar"><span style={{ width: `${(w.k / wmax) * 100}%` }} /></div>
                <b className="num">{num(w.k)}</b>
                <span className="tiny muted num" style={{ width: 44, textAlign: 'right' }}>{w.shots ? `${Math.round((w.hits / w.shots) * 100)}%` : ''}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Карты</h3><span className="tiny muted">раунды · доля побед</span></div>
          <div className="st-wlist">
            {maps.map((m) => (
              <div key={m.key} className="st-wrow">
                <span className="st-wname">{m.name}</span>
                <div className="st-bar"><span style={{ width: `${(m.w / Math.max(m.r, 1)) * 100}%`, background: m.w / m.r >= 0.5 ? 'var(--good)' : 'var(--bad)' }} /></div>
                <b className="num">{Math.round((m.w / Math.max(m.r, 1)) * 100)}%</b>
                <span className="tiny muted num" style={{ width: 54, textAlign: 'right' }}>{num(m.r)}</span>
              </div>
            ))}
            {!maps.length && <div className="empty small">Нет данных по картам</div>}
          </div>
        </div>
      </div>
      <p className="tiny muted">Это общая статистика Steam по аккаунту: она копится с первого матча в CS:GO и продолжается в CS2. Что именно Valve засчитывает в неё в CS2, официально не описано, поэтому её стоит воспринимать как ориентир. Подробная статистика по каждому матчу — на вкладке «Матчи» (для подключённых аккаунтов).</p>
    </div>
  );
}

// ---- FACEIT ------------------------------------------------------------------------
type FcGame = { elo: number | null; level: number | null; region: string | null; life: Record<string, string | string[]>; maps: { map: string; m: number; wr: number; kd: number }[] };
type Faceit = { found: boolean; nick?: string; avatar?: string | null; country?: string | null; url?: string; premium?: boolean; verified?: boolean; created?: string | null; games?: Record<string, FcGame>; recent?: { id: string; at: number | null; win: boolean | null }[] };
const FC_COLOR = (lvl: number | null) => (!lvl ? '#888' : lvl === 1 ? '#eeeeee' : lvl <= 3 ? '#1ce400' : lvl <= 7 ? '#ffc800' : lvl <= 9 ? '#ff6309' : '#fe1f00');
// ELO needed for each level (FACEIT CS2)
const FC_LEVELS = [0, 100, 501, 751, 901, 1051, 1201, 1351, 1531, 1751, 2001];
function FaceitLevel({ level, size = 56 }: { level: number | null; size?: number }) {
  const c = FC_COLOR(level);
  const f = (level || 0) / 10;
  const R = 22, C = 2 * Math.PI * R, arc = 0.8; // open ring at the bottom, like FACEIT's badge
  return (
    <svg viewBox="0 0 56 56" width={size} height={size} className="fc-level" aria-label={`Уровень FACEIT ${level ?? '—'}`}>
      <circle cx="28" cy="28" r="26" fill="#1b1d22" />
      <circle cx="28" cy="28" r={R} fill="none" stroke="#3a3d45" strokeWidth="4" strokeDasharray={`${arc * C} ${C}`} transform="rotate(126 28 28)" strokeLinecap="round" />
      <circle cx="28" cy="28" r={R} fill="none" stroke={c} strokeWidth="4" strokeDasharray={`${arc * C * f} ${C}`} transform="rotate(126 28 28)" strokeLinecap="round" />
      <text x="28" y="34" textAnchor="middle" fill={c} fontSize="19" fontWeight="800" fontFamily="Inter, system-ui, sans-serif">{level ?? '?'}</text>
    </svg>
  );
}
const pct = (v: unknown) => (v == null || v === '' ? '—' : `${Math.round(+String(v))}%`);
const dec = (v: unknown, n = 2) => (v == null || v === '' ? '—' : (+String(v)).toFixed(n));

function FaceitBlock({ steamid }: { steamid: string }) {
  const r = useAsync(() => api<Faceit>(`/api/faceit?id=${steamid}`).catch((e: Error) => ({ found: false, err: e.message }) as Faceit & { err: string }), [steamid]);
  const [g, setG] = useState<string>('');
  const d = r.data as (Faceit & { err?: string }) | null;
  if (r.loading) return <div className="card pad fc-card"><span className="tiny muted">Загружаю FACEIT…</span></div>;
  if (!d || d.err) return null; // server without a FACEIT key — no block at all
  if (!d.found) return <div className="card pad fc-card row" style={{ gap: 10 }}><span className="fc-logo">FACEIT</span><span className="small muted">К этому Steam-аккаунту не привязан профиль FACEIT.</span></div>;
  const games = Object.keys(d.games || {});
  const cur = g && games.includes(g) ? g : games[0];
  const x = d.games?.[cur];
  const life = x?.life || {};
  const recent: (boolean | null)[] = d.recent?.length && cur === 'cs2' ? d.recent.map((m) => m.win) : Array.isArray(life['Recent Results']) ? (life['Recent Results'] as string[]).map((v) => v === '1') : [];
  const last = cur === 'cs2' ? d.recent?.find((m) => m.at)?.at : null;
  const next = x?.level && x.level < 10 && x.elo != null ? FC_LEVELS[x.level + 1] - x.elo : null;
  const lvlFrom = x?.level ? FC_LEVELS[x.level] : 0, lvlTo = x?.level && x.level < 10 ? FC_LEVELS[x.level + 1] : null;
  const tiles: [string, string, string?][] = [
    ['Винрейт', pct(life['Win Rate %']), life['Wins'] ? `${num(+String(life['Wins']))} побед` : undefined],
    ['K/D', dec(life['Average K/D Ratio'])],
    ['HS%', pct(life['Average Headshots %'])],
    ['ADR', dec(life['ADR'], 1)],
    ['Матчей', num(+String(life['Matches'] ?? life['Total Matches'] ?? 0) || null)],
    ['Серия побед', life['Longest Win Streak'] ? String(life['Longest Win Streak']) : '—', life['Current Win Streak'] ? `сейчас ${life['Current Win Streak']}` : undefined],
    ['Клатч 1v1', pct(life['1v1 Win Rate'] != null ? +String(life['1v1 Win Rate']) * (+String(life['1v1 Win Rate']) <= 1 ? 100 : 1) : null)],
    ['Клатч 1v2', pct(life['1v2 Win Rate'] != null ? +String(life['1v2 Win Rate']) * (+String(life['1v2 Win Rate']) <= 1 ? 100 : 1) : null)],
    ['Входы', pct(life['Entry Success Rate'] != null ? +String(life['Entry Success Rate']) * (+String(life['Entry Success Rate']) <= 1 ? 100 : 1) : null), 'успешных первых дуэлей'],
    ['Урон гранатами', dec(life['Utility Damage per Round'], 1), 'за раунд'],
  ];
  return (
    <div className="card fc-card">
      <div className="fc-head">
        <span className="fc-logo">FACEIT</span>
        {games.length > 1 && (
          <div className="seg">{games.map((k) => <button key={k} className={k === cur ? 'on' : ''} onClick={() => setG(k)}>{k === 'cs2' ? 'CS2' : 'CS:GO'}</button>)}</div>
        )}
        <a className="btn small ghost" href={extUrl(d.url)} target="_blank" rel="noreferrer">Профиль FACEIT ↗</a>
      </div>
      <div className="fc-body">
        <div className="fc-id">
          {d.avatar ? <img className="fc-ava" src={d.avatar} alt="" width={64} height={64} /> : <span className="fc-ava fc-ava0">{(d.nick || '?').slice(0, 2).toUpperCase()}</span>}
          <div className="stack" style={{ gap: 4, minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <b className="fc-nick">{d.nick}</b>
              {d.premium && <span className="fc-badge prem">Premium</span>}
              {d.verified && <span className="fc-badge ver" title="Подтверждённый аккаунт">✓</span>}
            </div>
            <span className="tiny muted">
              {d.country ? <>{flag(d.country.toUpperCase())} {d.country.toUpperCase()} · </> : null}
              {x?.region ? `регион ${x.region} · ` : ''}
              {d.created ? `на FACEIT с ${new Date(d.created).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}` : ''}
            </span>
          </div>
        </div>
        <div className="fc-elo">
          <FaceitLevel level={x?.level ?? null} />
          <div className="stack" style={{ gap: 4, minWidth: 150 }}>
            <span className="tiny muted">ELO</span>
            <b className="fc-elo-v num" style={{ color: FC_COLOR(x?.level ?? null) }}>{x?.elo != null ? x.elo.toLocaleString('ru-RU') : '—'}</b>
            {lvlTo && x?.elo != null ? (
              <>
                <div className="st-bar"><span style={{ width: `${Math.max(3, Math.min(100, ((x.elo - lvlFrom) / (lvlTo - lvlFrom)) * 100))}%`, background: FC_COLOR(x.level) }} /></div>
                <span className="tiny faint">до {x.level! + 1} уровня — {next} ELO</span>
              </>
            ) : x?.level === 10 ? <span className="tiny faint">максимальный уровень</span> : null}
          </div>
        </div>
      </div>
      <div className="fc-tiles">
        {tiles.filter(([, v]) => v !== '—').map(([k, v, sub]) => <div key={k} className="fc-tile"><span className="tiny muted">{k}</span><b className="num">{v}</b>{sub && <span className="tiny faint">{sub}</span>}</div>)}
      </div>
      {(recent.length > 0 || last) && (
        <div className="fc-foot">
          {recent.length > 0 && (
            <div className="row" style={{ gap: 6 }}>
              <span className="tiny muted">Последние матчи</span>
              <span className="fc-recent">{recent.slice(0, 20).map((w, i) => <span key={i} className={w == null ? '' : w ? 'w' : 'l'}>{w == null ? '·' : w ? 'W' : 'L'}</span>)}</span>
            </div>
          )}
          {last ? <span className="tiny muted">последний матч {new Date(last * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</span> : null}
        </div>
      )}
      {x?.maps?.length ? (
        <div className="fc-maps">
          {x.maps.map((m) => (
            <div key={m.map} className="fc-map" title={`${m.map}: ${m.m} матчей, винрейт ${m.wr}%, K/D ${m.kd.toFixed(2)}`}>
              <span className="small">{m.map.replace(/^de_/, '').replace(/^\w/, (c) => c.toUpperCase())}</span>
              <div className="st-bar thin"><span style={{ width: `${m.wr}%`, background: m.wr >= 50 ? 'var(--good)' : 'var(--bad)' }} /></div>
              <span className="tiny muted num">{m.wr}% · {m.m}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---- showcase: coins, medals, pins and trophies from the inventory -------------
function Showcase({ steamid }: { steamid: string }) {
  const inv = useAsync(() => api<Inventory>(`/api/inventory?id=${steamid}`).catch(() => null), [steamid]);
  const list = useMemo(() => (inv.data?.items || []).filter((x) => /collectible/i.test(x.type || '') || /\b(Coin|Medal|Trophy|Pin)\b/.test(x.n)), [inv.data]);
  if (inv.loading) return <div className="card pad st-showcase"><span className="tiny muted">Загружаю медали и значки…</span></div>;
  if (!list.length) return null;
  return (
    <div className="card pad stack st-showcase" style={{ gap: 10 }}>
      <div className="row between"><h3>Медали, монеты и значки</h3><span className="tiny muted">{list.length} · из инвентаря</span></div>
      <div className="st-medals">
        {list.map((x) => (
          <span key={x.n} className="st-medal" title={x.n + (x.c > 1 ? ` ×${x.c}` : '')} style={x.col ? { ['--mc' as string]: '#' + x.col } : undefined}>
            <img src={`https://community.cloudflare.steamstatic.com/economy/image/${x.i}/96fx96f`} alt={x.n} loading="lazy" width={48} height={48} />
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- kills by weapon: a strip of silhouettes --------------------------------------
let iconsP: Promise<Record<string, string>> | null = null;
function loadWeaponIcons() {
  iconsP ||= fetch(import.meta.env.BASE_URL + 'data/weapon-icons.json').then((r) => r.json()).then((j: { imgPrefix: string[]; w: Record<string, string> }) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(j.w)) { const i = v.indexOf(':'); out[k] = (j.imgPrefix[+v.slice(0, i)] || '') + v.slice(i + 1); }
    return out;
  }).catch(() => ({}));
  return iconsP;
}
function WeaponStrip({ s }: { s: Record<string, number> }) {
  const icons = useAsync(loadWeaponIcons, []);
  const list = WEAPONS.map(([key, name]) => ({ key, name, k: s['total_kills_' + key] || 0, shots: s['total_shots_' + key] || 0, hits: s['total_hits_' + key] || 0 }))
    .concat([{ key: 'knife', name: 'Нож', k: s.total_kills_knife || 0, shots: 0, hits: 0 }, { key: 'hegrenade', name: 'Граната HE', k: s.total_kills_hegrenade || 0, shots: 0, hits: 0 }])
    .filter((w) => w.k > 0).sort((a, b) => b.k - a.k);
  if (!list.length) return null;
  const max = list[0].k;
  return (
    <div className="card st-wstrip">
      <div className="st-wstrip-label"><span>Убийства</span><span>Оружие</span></div>
      <div className="st-wstrip-row">
        {list.map((w) => (
          <div key={w.key} className="st-wcell" title={`${w.name}: ${w.k.toLocaleString('ru-RU')} убийств${w.shots ? ` · точность ${Math.round((w.hits / w.shots) * 100)}%` : ''}`}>
            <span className="st-wicon">{icons.data?.[w.key] ? <img src={icons.data[w.key] + '/128fx64f'} alt={w.name} loading="lazy" /> : <span className="tiny">{w.name}</span>}</span>
            <b className="num">{w.k.toLocaleString('ru-RU')}</b>
            <span className="st-wbar"><span style={{ width: `${(w.k / max) * 100}%` }} /></span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- inventory ----------------------------------------------------------------
function usePriceIndex() {
  const db = useDB();
  const prices = usePrices();
  const extra = useAsync(() => Promise.all([loadStickers().catch(() => []), loadCharms().catch(() => [])]), []);
  const { source } = usePrefs();
  return useMemo(() => {
    if (!db || !prices) return null;
    const m = new Map<string, number>();
    const flags: Flag[] = ['', 's', 'v'];
    for (const s of db.skins) {
      const rows = prices.s[s.id];
      if (!rows) continue;
      for (const f of flags) {
        for (const w of (s.vanilla ? ['x'] : [0, 1, 2, 3, 4]) as (number | 'x')[]) {
          const c = pick(rows[`${f}${w}`], source);
          if (c != null) m.set(marketName(s, f, w), c);
        }
      }
    }
    const [st, ch] = extra.data || [[], []];
    for (const x of st as { id: string; n: string; m?: string }[]) { const c = pick(prices.st?.[x.id], source); if (c != null) m.set(x.m || `Sticker | ${x.n}`, c); }
    for (const x of ch as { id: string; n: string; m?: string }[]) { const c = pick(prices.ch?.[x.id], source); if (c != null) m.set(x.m || `Charm | ${x.n}`, c); }
    return { m, prices: prices as Prices };
  }, [db, prices, extra.data, source]);
}

function InventoryTab({ steamid }: { steamid: string }) {
  const inv = useAsync(() => api<Inventory>(`/api/inventory?id=${steamid}`), [steamid]);
  const idx = usePriceIndex();
  const { currency } = usePrefs();
  const [sort, setSort] = useState<'price' | 'name'>('price');
  const rows = useMemo(() => (inv.data?.items || []).map((x) => ({ ...x, p: idx?.m.get(x.n) ?? null }))
    .sort((a, b) => (sort === 'price' ? (b.p ?? -1) * b.c - (a.p ?? -1) * a.c : a.n.localeCompare(b.n))), [inv.data, idx, sort]);
  if (inv.loading) return <Spinner />;
  if (inv.error) return <div className="notice bad">{inv.error}</div>;
  const d = inv.data!;
  if (d.private) return <div className="notice">Инвентарь скрыт настройками приватности Steam.</div>;
  const priced = rows.filter((r) => r.p != null);
  const total = priced.reduce((a, r) => a + r.p! * r.c, 0);
  const count = rows.reduce((a, r) => a + r.c, 0);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="st-kpis">
        <Kpi k="Стоимость (оценка)" v={idx ? money(total, idx.prices, currency) : '…'} sub={`оценено ${priced.length} из ${rows.length} позиций`} />
        <Kpi k="Предметов CS2" v={num(d.total || count)} />
        <Kpi k="Разных" v={num(rows.length)} />
        <Kpi k="Можно продать" v={num(rows.filter((r) => r.m).reduce((a, r) => a + r.c, 0))} />
      </div>
      <div className="row between">
        <span className="small muted">Цены — с сайта (Steam/Skinport, как выбрано в шапке); кейсы, капсулы и редкие предметы без цены не оцениваются.</span>
        <div className="seg"><button className={sort === 'price' ? 'on' : ''} onClick={() => setSort('price')}>По цене</button><button className={sort === 'name' ? 'on' : ''} onClick={() => setSort('name')}>По имени</button></div>
      </div>
      <div className="st-inv">
        {rows.map((r) => (
          <div key={r.n} className="st-item" title={r.n}>
            <img src={`https://community.cloudflare.steamstatic.com/economy/image/${r.i}/120fx90f`} alt="" loading="lazy" />
            <span className="st-item-name" style={r.col ? { borderLeftColor: '#' + r.col } : undefined}>{r.n}</span>
            <span className="row between tiny"><span className="muted">{r.c > 1 ? `×${r.c}` : r.t ? '' : 'нельзя обменять'}</span><b className="num">{r.p != null && idx ? money(r.p * r.c, idx.prices, currency) : '—'}</b></span>
          </div>
        ))}
      </div>
    </div>
  );
}

