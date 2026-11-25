import { useEffect, useMemo, useState } from 'react';
import { Spinner } from '../components/ui';
import { extUrl, href, setQuery, useRoute } from '../lib/router';
import { loadLpLogos, loadTeamIndex, teamKeys, useTeamLogos, useTeamSlug, type TeamIndex } from '../lib/teams';
import { countryFromFlag, countryRu, flagUrl, ROLE_RU } from '../lib/people';
import TeamNews from '../components/TeamNews';
import '../styles/team.css';

/* Team page: everything we know about a team.
   matches since 2021 + titles — public/data/teams/<slug>.json (tools/teams/build_teams.py, Liquipedia pages)
   location, founded, staff, links — public/data/teams/info.json (scripts/fetch-logos.mjs, Liquipedia infobox)
   world rank + roster — rankings.json (Valve Regional Standings); player stats — players/index.json (our demos)
   next match — esports.json (esports-data branch, updated every 20 min)
   news — t/<slug>.json in the news-data branch (scripts/fetch-news.mjs, every 20 min) */

type MatchRow = [number, string, number, number, [string, number, number][], string, string, string, number | null, number | null];
type TeamFile = { name: string; page: string; m: MatchRow[]; titles: [number, string, string, string][] };
type Person = { id: string; t: string; name: string; flag: string; role: string; igl: number; inactive: number; sid?: string; for?: string; tour?: string };
type Info = { location?: string; region?: string; created?: string; disbanded?: string; staff?: [string, string, string?, string?, string?][]; links?: Record<string, string>; squad?: Person[]; standins?: Person[] };
type Ranking = { date: string; teams: [number, number, string, string[], string, number, number][] };
type PIndex = { cols: string[]; rows: (string | number)[][] };
type PInfo = { lp?: string; id?: string; name?: string; rn?: string; c?: string; r?: string };
type EsTeam = { n: string; f?: string; tbd?: boolean };
type EsMatch = { id: string; t1: EsTeam; t2: EsTeam; start: number; status: string; bo?: number; tour: string; stage?: string; tp?: string; tier?: string; score?: [number, number] };

const DATA = import.meta.env.BASE_URL + 'data/';
const getJSON = <T,>(u: string): Promise<T | null> => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const ESPORTS = 'https://raw.githubusercontent.com/vsemvamdam/rush-b/esports-data/esports.json';
const regionRu = (r?: string) => (r ? REGION_RU[r] || REGION_RU[r.toLowerCase()] || r : '');
const REGION_RU: Record<string, string> = {
  eu: 'Европа', europe: 'Европа', na: 'Северная Америка', sa: 'Южная Америка', am: 'Америка', americas: 'Америка', asia: 'Азия', as: 'Азия',
  oce: 'Океания', oceania: 'Океания', cis: 'СНГ', me: 'Ближний Восток', mena: 'Ближний Восток', af: 'Африка', africa: 'Африка', cn: 'Китай', china: 'Китай', apac: 'Азия и Океания', Europe: 'Европа', 'North America': 'Северная Америка', 'South America': 'Южная Америка', Americas: 'Америка', Asia: 'Азия', 'Asia-Pacific': 'Азия и Океания', Oceania: 'Океания', CIS: 'СНГ', 'Middle East': 'Ближний Восток', Africa: 'Африка', China: 'Китай', EU: 'Европа', AM: 'Америка', AS: 'Азия' };
const LINK_RU: [string, string, (v: string) => string][] = [
  ['website', 'Сайт', (v) => (/^https?:/.test(v) ? v : 'https://' + v)],
  ['twitter', 'X', (v) => `https://x.com/${v.replace(/^@/, '')}`],
  ['twitch', 'Twitch', (v) => `https://www.twitch.tv/${v}`],
  ['youtube', 'YouTube', (v) => `https://www.youtube.com/${v.replace(/^\/+/, '')}`],
  ['instagram', 'Instagram', (v) => `https://www.instagram.com/${v.replace(/^@/, '')}`],
  ['facebook', 'Facebook', (v) => `https://www.facebook.com/${v}`],
  ['tiktok', 'TikTok', (v) => `https://www.tiktok.com/@${v.replace(/^@/, '')}`],
  ['vk', 'ВКонтакте', (v) => `https://vk.com/${v}`],
  ['telegram', 'Telegram', (v) => `https://t.me/${v.replace(/^@/, '')}`],
  ['discord', 'Discord', (v) => (/^https?:/.test(v) ? v : `https://discord.gg/${v}`)],
  ['kick', 'Kick', (v) => `https://kick.com/${v}`],
  ['weibo', 'Weibo', (v) => `https://weibo.com/${v}`],
  ['bilibili', 'Bilibili', (v) => `https://space.bilibili.com/${v}`],
];
const ROLE_SHORT: Record<string, string> = { igl: 'Капитан', awp: 'Снайпер', entry: 'Энтри', lurk: 'Люркер', support: 'Саппорт', rifle: 'Райфлер', coach: 'Тренер' };
const fmtD = (ts: number) => new Date(ts * 1000).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDT = (ts: number) => new Date(ts * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const dateRu = (iso?: string) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return d ? `${d}.${m}.${y}` : m ? `${m}.${y}` : y;
};
const HUE = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; };
/** two columns (same breakpoint as .tm-grid in team.css) */
function useWide(q = '(min-width: 1001px)') {
  const [m, set] = useState(() => (typeof matchMedia === 'function' ? matchMedia(q).matches : true));
  useEffect(() => {
    const mq = matchMedia(q);
    const f = () => set(mq.matches);
    f();
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [q]);
  return m;
}

export default function Team({ slug }: { slug: string }) {
  const [file, setFile] = useState<TeamFile | null | undefined>(undefined);
  const [info, setInfo] = useState<Record<string, Info>>({});
  const [ix, setIx] = useState<TeamIndex | null>(null);
  const [rank, setRank] = useState<Ranking | null>(null);
  const [pix, setPix] = useState<PIndex | null>(null);
  const [links, setLinks] = useState<Record<string, PInfo>>({});
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [staffPhotos, setStaffPhotos] = useState<Record<string, string>>({});
  const [es, setEs] = useState<EsMatch[]>([]);
  const [extra, setExtra] = useState<Record<string, PInfo & { team?: string }>>({});
  const logo = useTeamLogos();
  const wide = useWide();
  useEffect(() => {
    setFile(undefined);
    getJSON<TeamFile>(`${DATA}teams/${encodeURIComponent(slug)}.json`).then(setFile);
  }, [slug]);
  useEffect(() => {
    getJSON<Record<string, Info>>(DATA + 'teams/info.json').then((x) => setInfo(x || {}));
    loadTeamIndex().then(setIx);
    getJSON<Ranking>(DATA + 'rankings.json').then(setRank);
    getJSON<PIndex>(DATA + 'players/index.json').then(setPix);
    getJSON<{ p: Record<string, PInfo> }>(DATA + 'players/links.json').then((x) => setLinks(x?.p || {}));
    getJSON<Record<string, string>>(DATA + 'players/avatars.json').then((x) => setAvatars(x || {}));
    loadLpLogos().then((x) => { setPhotos(x?.p || {}); setStaffPhotos(x?.s || {}); });
    getJSON<{ matches: EsMatch[] }>(ESPORTS).then((x) => setEs(x?.matches || []));
    getJSON<Record<string, PInfo & { team?: string }>>(DATA + 'players/extra.json').then((x) => setExtra(x || {}));
  }, []);

  const keys = useMemo(() => new Set(file ? [file.name, ...(ix ? Object.entries(ix.k).filter(([, s]) => s === slug).map(([k]) => k) : [])].flatMap(teamKeys) : []), [file, ix, slug]);
  const isUs = (n?: string) => !!n && teamKeys(n).some((k) => keys.has(k));
  const ranked = useMemo(() => rank?.teams.find((t) => isUs(t[2])) || null, [rank, keys]); // eslint-disable-line react-hooks/exhaustive-deps
  const next = useMemo(() => es.filter((m) => m.status !== 'finished' && (isUs(m.t1.f || m.t1.n) || isUs(m.t2.f || m.t2.n))).sort((a, b) => a.start - b.start)[0] || null, [es, keys]); // eslint-disable-line react-hooks/exhaustive-deps

  // matches of the last days that are on the matches page but not yet in the Liquipedia history (series score only)
  const merged = useMemo(() => {
    if (!file) return file;
    const last = file.m[0]?.[0] || 0;
    const add: MatchRow[] = es.filter((m) => m.status === 'finished' && m.score && m.start > last + 6 * 3600 && (isUs(m.t1.f || m.t1.n) || isUs(m.t2.f || m.t2.n))).map((m) => {
      const us1 = isUs(m.t1.f || m.t1.n);
      const opp = us1 ? m.t2 : m.t1;
      const [a, b] = us1 ? m.score! : [m.score![1], m.score![0]];
      const row: MatchRow = [m.start, opp.f || opp.n, a, b, [], m.tour, m.tp || '', m.tier || '', null, m.bo || null];
      return row;
    }).sort((x, y) => y[0] - x[0]);
    return add.length ? { ...file, m: [...add, ...file.m] } : file;
  }, [file, es, keys]); // eslint-disable-line react-hooks/exhaustive-deps

  if (file === undefined) return <Spinner />;
  if (!file) return <div className="empty card">Страницы этой команды пока нет. <a className="link" href={href('/players')}>Все команды →</a></div>;
  const T = merged as TeamFile;
  const inf = info[T.page] || {};
  const name = ranked?.[2] && ranked[2].length <= T.name.length ? ranked[2] : T.name;
  const now = Date.now() / 1000;
  const year = T.m.filter((m) => m[0] > now - 365 * 86400);
  const mapsYear = year.flatMap((m) => m[4]);
  const mw = mapsYear.filter((x) => x[1] > x[2]).length, ml = mapsYear.filter((x) => x[1] < x[2]).length;
  const titlesYear = T.titles.filter((t) => t[0] > now - 365 * 86400).length;
  const linkList = LINK_RU.filter(([k]) => inf.links?.[k]);
  const people: Record<string, string> = {};
  for (const x of [...(inf.squad || []), ...(inf.standins || [])]) if (x.sid && !x.role) people[x.id.toLowerCase()] ||= x.sid;
  if (pix) { // players our demos know (same lookup as the roster cards)
    const [iS, iN, iT] = ['sid', 'name', 'team'].map((k) => pix.cols.indexOf(k));
    for (const r of pix.rows) { const n = String(r[iN]).toLowerCase(); if (isUs(String(r[iT] || '')) && !people[n]) people[n] = String(r[iS]); }
  }
  // news: next to the roster on a phone, at the top of the side column on a wide screen
  const news = <TeamNews slug={slug} name={name} people={people} />;

  return (
    <div className="tm stack" style={{ gap: 18 }}>
      <div className="tm-head">
        <span className="tm-logo">{logo(name, T.name) ? <img src={logo(name, T.name)!} alt="" /> : <b style={{ color: `hsl(${HUE(name)} 60% 65%)` }}>{name.slice(0, 2).toUpperCase()}</b>}</span>
        <div className="stack" style={{ gap: 8, minWidth: 0 }}>
          <h1 className="tm-name">{name}</h1>
          <div className="tm-meta">
            {inf.location && <span>{flagUrl(inf.location) && <img className="tm-flag" src={flagUrl(inf.location)} alt="" />}{countryRu(inf.location)}</span>}
            {(inf.region || ranked?.[4]) && <span>Регион {regionRu(inf.region || ranked![4])}</span>}
            {inf.created && <span>Основана {dateRu(inf.created)}</span>}
            {inf.disbanded && <span className="bad">Распущена {inf.disbanded}</span>}
          </div>
          {linkList.length > 0 && (
            <div className="tm-links">
              {linkList.map(([k, ru, url]) => <a key={k} href={extUrl(url(inf.links![k]))} target="_blank" rel="noreferrer nofollow">{ru}</a>)}
            </div>
          )}
        </div>
      </div>

      <div className="tm-kpis">
        {ranked && <Kpi v={`#${ranked[0]}`} k="в мировом рейтинге Valve" sub={`${ranked[1].toLocaleString('ru-RU')} очков · ${regionRu(ranked[4])} #${ranked[5]}`} accent />}
        <Kpi v={String(titlesYear)} k="титулов за год" sub={`всего с 2021: ${T.titles.length}`} />
        <Kpi v={String(mapsYear.length)} k="карт за год" sub={`${year.length} матчей`} />
        <Kpi v={`${mw}–${ml}`} k="победы · поражения" sub="по картам за год" />
        <Kpi v={mw + ml ? `${Math.round((mw / (mw + ml)) * 100)}%` : '—'} k="доля побед" sub="карт за год" />
        <Kpi v={String(T.m.length)} k="матчей в базе" sub={`с ${new Date(T.m[T.m.length - 1][0] * 1000).getFullYear()} года`} />
      </div>

      <div className="tm-grid">
        <div className="stack" style={{ gap: 18, minWidth: 0 }}>
          {next && <NextMatch m={next} isUs={isUs} logo={logo} />}
          <Roster teamName={name} rank={ranked} squad={inf.squad} standins={inf.standins} pix={pix} links={links} extra={extra} avatars={avatars} photos={photos} isUs={isUs} />
          {!wide && news}
          <Matches file={T} logo={logo} />
        </div>
        <div className="stack" style={{ gap: 18, minWidth: 0 }}>
          {wide && news}
          {inf.staff?.length ? (
            <section className="tm-card">
              <h3 className="tm-h">Тренерский штаб</h3>
              {inf.staff.map(([n, role, real, flag, pg]) => (
                <div key={n + role} className="tm-staff">
                  {pg && staffPhotos[pg] ? <img className="tm-staff-photo" src={import.meta.env.BASE_URL + 'data/logos/' + staffPhotos[pg]} alt={n} loading="lazy" />
                    : <span className="tm-ini" style={{ background: `hsl(${HUE(n)} 25% 26%)` }}>{n.slice(0, 2).toUpperCase()}</span>}
                  <div className="stack" style={{ gap: 1, minWidth: 0 }}>
                    <span className="row" style={{ gap: 8 }}><b>{flag && flagUrl(flag) ? <img className="tm-flag" src={flagUrl(flag)} alt="" title={countryFromFlag(flag)} /> : null}{n}</b><span className="tm-chip">{role}</span></span>
                    {real ? <span className="tiny muted">{real}</span> : null}
                  </div>
                </div>
              ))}
            </section>
          ) : null}
          <MapsBlock file={T} />
          <Titles file={T} />
          <section className="tm-card">
            <h3 className="tm-h">Информация</h3>
            <dl className="tm-dl">
              {inf.created && <><dt>Основана</dt><dd>{dateRu(inf.created)}</dd></>}
              {(inf.region || ranked?.[4]) && <><dt>Регион</dt><dd>{regionRu(inf.region || ranked![4])}</dd></>}
              {inf.location && <><dt>База</dt><dd>{countryRu(inf.location)}</dd></>}
              <dt>Первый матч в базе</dt><dd>{fmtD(T.m[T.m.length - 1][0])}</dd>
              <dt>Последний матч</dt><dd>{fmtD(T.m[0][0])}</dd>
            </dl>
            <a className="link small" href={`https://liquipedia.net/counterstrike/${encodeURIComponent(T.page.replace(/ /g, '_'))}`} target="_blank" rel="noreferrer">Страница на Liquipedia ↗</a>
          </section>
        </div>
      </div>
      <p className="tiny muted">Матчи, титулы и сведения о команде — <a className="link" href="https://liquipedia.net/counterstrike/" target="_blank" rel="noreferrer">Liquipedia</a> (CC BY-SA 3.0, турниры S/A/B-уровня с 2021 года); рейтинг — Valve Regional Standings; статистика игроков — наши турнирные демки; новости — заголовки и ссылки из RSS-лент изданий, тексты принадлежат их авторам. Логотипы и фото принадлежат командам, игрокам и авторам снимков и показаны только для узнаваемости.</p>
    </div>
  );
}

function Kpi({ v, k, sub, accent }: { v: string; k: string; sub?: string; accent?: boolean }) {
  return <div className={'tm-kpi' + (accent ? ' accent' : '')}><b className="num">{v}</b><span>{k}</span>{sub && <i>{sub}</i>}</div>;
}

function TeamMark({ name, logo, size = 26 }: { name: string; logo: ReturnType<typeof useTeamLogos>; size?: number }) {
  const [bad, setBad] = useState(false);
  const src = bad ? null : logo(name);
  return src ? <img className="tm-mark" src={src} alt="" width={size} height={size} loading="lazy" onError={() => setBad(true)} />
    : <span className="tm-mark tm-ini" style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${HUE(name)} 30% 28%)` }}>{name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase()}</span>;
}

function TeamLink({ name, children }: { name: string; children: React.ReactNode }) {
  const slugOf = useTeamSlug();
  const s = slugOf(name);
  return s ? <a className="tm-tlink" href={href(`/team/${s}`)}>{children}</a> : <>{children}</>;
}

function NextMatch({ m, isUs, logo }: { m: EsMatch; isUs: (n?: string) => boolean; logo: ReturnType<typeof useTeamLogos> }) {
  const us1 = isUs(m.t1.f || m.t1.n);
  const [a, b] = us1 ? [m.t1, m.t2] : [m.t2, m.t1];
  return (
    <section className="tm-card">
      <h3 className="tm-h">{m.status === 'live' ? <span className="tm-live">LIVE</span> : null}Ближайший матч</h3>
      <div className="tm-next">
        <span className="tiny muted num">{fmtDT(m.start)}</span>
        <div className="tm-next-teams">
          <TeamMark name={a.f || a.n} logo={logo} /><b>{a.n}</b><span className="muted">—</span>
          <TeamLink name={b.f || b.n}><span>{b.tbd ? 'определится' : b.n}</span></TeamLink>{!b.tbd && <TeamMark name={b.f || b.n} logo={logo} />}
        </div>
        <span className="small muted">{m.tour}{m.stage ? ` — ${m.stage}` : ''}{m.bo ? ` · bo${m.bo}` : ''}</span>
      </div>
      <a className="link small" href={href(`/esports?t=${encodeURIComponent(m.tp || m.tour)}`)}>Все матчи турнира →</a>
    </section>
  );
}

function Roster({ teamName, rank, squad, standins, pix, links, extra, avatars, photos, isUs }: {
  teamName: string; rank: Ranking['teams'][0] | null; squad?: Person[]; standins?: Person[]; pix: PIndex | null; links: Record<string, PInfo>; extra: Record<string, PInfo>;
  avatars: Record<string, string>; photos: Record<string, string>; isUs: (n?: string) => boolean;
}) {
  type P = { sid: string; name: string; team: string; maps: number; kd: number; adr: number };
  const all = useMemo<P[]>(() => {
    if (!pix) return [];
    const c = (k: string) => pix.cols.indexOf(k);
    const [iS, iN, iT, iM, iK, iD, iA] = ['sid', 'name', 'team', 'maps', 'k', 'd', 'adr'].map(c);
    return pix.rows.map((r) => ({ sid: String(r[iS]), name: String(r[iN]), team: String(r[iT] || ''), maps: +r[iM], kd: +r[iK] / Math.max(+r[iD], 1), adr: +r[iA] }));
  }, [pix]);
  const bySid = useMemo(() => new Map(all.map((p) => [p.sid, p])), [all]);
  const byNick = (nick: string) => { const cands = all.filter((p) => p.name.toLowerCase() === nick.toLowerCase()); return cands.find((x) => isUs(x.team)) || cands.sort((x, y) => y.maps - x.maps)[0]; };
  // Current lineup = who plays now: the roster Valve counted for its latest ranking (it follows the latest
  // matches, so a stand-in who plays every event is in it). The Liquipedia page adds names, flags, SteamIDs and
  // the players of the official roster who are not playing right now.
  const official = squad?.filter((x) => !x.role) || [];
  const find = (nick: string) => official.find((x) => x.id.toLowerCase() === nick.toLowerCase()) || standins?.find((x) => x.id.toLowerCase() === nick.toLowerCase());
  type R = { nick: string; sid?: string; p?: P; flag?: string; real?: string; igl?: boolean; inactive?: boolean; sub?: string };
  const fromPerson = (x: Person, sub?: string): R => { const p = (x.sid && bySid.get(x.sid)) || byNick(x.id); return { nick: x.id, sid: x.sid || p?.sid, p, flag: x.flag, real: x.name, igl: !!x.igl, inactive: !!x.inactive, sub }; };
  let rows: R[];
  if (rank?.[3]?.length) {
    rows = rank[3].map((nick) => {
      const x = find(nick);
      const isSub = !!x && !official.includes(x);
      if (x) return fromPerson(x, isSub ? (x.for ? `замена за ${x.for}` : 'замена') : undefined);
      const p = byNick(nick);
      return { nick, sid: p?.sid, p };
    });
  } else if (official.length) rows = official.filter((x) => !x.inactive).map((x) => fromPerson(x));
  else rows = all.filter((p) => isUs(p.team)).sort((a, b) => b.maps - a.maps).slice(0, 5).map((p) => ({ nick: p.name, sid: p.sid, p }));
  if (!rows.length) return null;
  const inRows = (id: string) => rows.some((r) => r.nick.toLowerCase() === id.toLowerCase());
  // official players who are not in the current lineup (benched, or replaced for now)
  const others = official.filter((x) => !inRows(x.id)).map((x) => fromPerson(x));
  const subs = (standins || []).filter((x) => !x.role && !inRows(x.id) && !official.some((pl) => pl.id.toLowerCase() === x.id.toLowerCase()));
  const players = official;
  return (
    <section className="tm-card">
      <h3 className="tm-h">Основной состав<span className="tm-hsub">{rank?.[3]?.length ? 'кто играет сейчас — по рейтингу Valve' : players.length ? 'официальный, по Liquipedia' : 'по нашим демкам'}</span></h3>
      <div className="tm-roster">
        {rows.map(({ nick, sid, p, flag, real, igl, inactive, sub }) => {
          const li = sid ? links[sid] || extra[sid] : undefined;
          const photo = sid && photos[sid] ? import.meta.env.BASE_URL + 'data/logos/' + photos[sid] : sid && avatars[sid] ? `https://avatars.steamstatic.com/${avatars[sid]}_full.jpg` : '';
          const roles = (li?.r || '').split(',').filter(Boolean);
          const role = igl ? 'Капитан' : roles.length ? ROLE_SHORT[roles.find((r) => r !== 'igl') || roles[0]] || roles[0] : '';
          const fl = flag || li?.c;
          const body = (
            <>
              <span className={'tm-photo' + (sid && photos[sid] ? ' real' : '')}>{photo ? <img src={photo} alt={nick} loading="lazy" /> : <b>{nick.slice(0, 2).toUpperCase()}</b>}</span>
              {role ? <span className="tm-role" title={roles.map((r) => ROLE_RU[r] || r).join(', ')}>{role}</span> : <span className="tm-role empty" />}
              <b className="tm-nick">{fl && flagUrl(fl) ? <img className="tm-flag" src={flagUrl(fl)} alt="" title={flag ? countryFromFlag(flag) : countryRu(fl)} /> : null}{nick}</b>
              <span className="tm-real">{real || li?.rn || li?.name || ' '}</span>
              {sub ? <span className="tm-pill sub">{sub}</span> : null}
              {inactive ? <span className="tm-pill dim">в запасе</span> : p ? <span className="tm-pill">{p.maps} карт · ADR {p.adr.toFixed(0)}</span> : <span className="tm-pill dim">нет в наших демках</span>}
              {p ? <span className={'tm-kd num' + (p.kd >= 1.1 ? ' good' : p.kd < 0.95 ? ' bad' : '')}>K/D {p.kd.toFixed(2)}</span> : null}
            </>
          );
          return sid ? <a key={nick} className="tm-player" href={href(`/player/${sid}`)} title={`${nick} — профиль игрока`}>{body}</a> : <div key={nick} className="tm-player">{body}</div>;
        })}
      </div>
      {others.length > 0 && (
        <div className="tm-subs">
          <span className="tiny muted">Ещё в составе по Liquipedia:</span>
          {others.map((x) => {
            const inner = <>{x.flag && flagUrl(x.flag) ? <img className="tm-flag" src={flagUrl(x.flag)} alt="" /> : null}<b>{x.nick}</b><span className="muted"> {x.inactive ? '· в запасе' : '· не играл последние матчи'}</span></>;
            return x.sid ? <a key={x.nick} className="tm-sub" href={href(`/player/${x.sid}`)}>{inner}</a> : <span key={x.nick} className="tm-sub">{inner}</span>;
          })}
        </div>
      )}
      {subs.length > 0 && (
        <div className="tm-subs">
          <span className="tiny muted">Играли на замене:</span>
          {subs.map((x, i) => {
            const inner = <>{x.flag && flagUrl(x.flag) ? <img className="tm-flag" src={flagUrl(x.flag)} alt="" /> : null}<b>{x.id}</b>{x.for ? <span className="muted"> за {x.for}</span> : null}{x.tour ? <span className="faint"> · {x.tour}</span> : null}</>;
            return x.sid ? <a key={i} className="tm-sub" href={href(`/player/${x.sid}`)}>{inner}</a> : <span key={i} className="tm-sub">{inner}</span>;
          })}
        </div>
      )}
      {!players.length && !rank && <p className="tiny muted" style={{ padding: '0 16px 12px' }}>Состав с Liquipedia ещё не загружен и команды нет в рейтинге Valve — показаны игроки, чаще всего игравшие за неё в наших демках ({teamName}).</p>}
    </section>
  );
}

function Matches({ file, logo }: { file: TeamFile; logo: ReturnType<typeof useTeamLogos> }) {
  const { query } = useRoute();
  const yr = query.get('y') || '';
  const opp = query.get('vs') || '';
  const [limit, setLimit] = useState(20);
  useEffect(() => setLimit(20), [yr, opp]);
  const years = useMemo(() => [...new Set(file.m.map((m) => new Date(m[0] * 1000).getFullYear()))], [file]);
  const list = file.m.filter((m) => (!yr || new Date(m[0] * 1000).getFullYear() === +yr) && (!opp || m[1] === opp));
  const w = list.filter((m) => m[2] > m[3]).length;
  return (
    <section className="tm-card">
      <div className="tm-h row between" style={{ gap: 10 }}>
        <span>Матчи{opp ? <> против <b style={{ color: 'var(--text)' }}>{opp}</b> <button className="tm-x" onClick={() => setQuery({ vs: null })} title="Все соперники">×</button></> : null}</span>
        <span className="tm-hsub">{list.length} · побед {w} ({list.length ? Math.round((w / list.length) * 100) : 0}%)</span>
      </div>
      <div className="tm-years">
        <button className={!yr ? 'on' : ''} onClick={() => setQuery({ y: null })}>Все</button>
        {years.map((y) => <button key={y} className={yr === String(y) ? 'on' : ''} onClick={() => setQuery({ y: String(y) })}>{y}</button>)}
      </div>
      <div className="tm-matches">
        {list.slice(0, limit).map((m, i) => {
          const win = m[2] > m[3];
          return (
            <div key={m[0] + m[1] + i} className={'tm-match' + (win ? ' w' : ' l')}>
              <span className="tm-date num">{fmtD(m[0])}</span>
              <TeamMark name={m[1]} logo={logo} size={30} />
              <div className="tm-mbody">
                <span className="tm-opp"><TeamLink name={m[1]}><b>{m[1]}</b></TeamLink><button className="tm-vs" onClick={() => setQuery({ vs: m[1] })} title="Все матчи против этой команды">все очные</button></span>
                <span className="tm-msub">
                  {m[4].map(([mp, a, b], j) => <span key={j} className={a > b ? 'mw' : 'ml'}>{mp ? mp + ' ' : ''}{a}:{b}</span>)}
                  <span className="tm-tour">{m[5]}{m[7] ? <i className={'tm-tier t-' + m[7]}>{m[7]}</i> : null}{m[8] === 1 ? <i className="tm-lan">LAN</i> : null}</span>
                </span>
              </div>
              <span className={'tm-score num' + (win ? ' w' : ' l')}>{m[2]}:{m[3]}</span>
            </div>
          );
        })}
        {!list.length && <div className="empty small">Матчей нет</div>}
      </div>
      {list.length > limit && <button className="tm-more" onClick={() => setLimit((l) => l + 30)}>Показать ещё · {list.length - limit}</button>}
    </section>
  );
}

let mapsP: Promise<{ maps: { id: string; name: string; radar: string }[] } | null> | null = null;
function MapsBlock({ file }: { file: TeamFile }) {
  const [period, setPeriod] = useState(90);
  const [radars, setRadars] = useState<Record<string, string>>({});
  useEffect(() => {
    mapsP ||= getJSON(DATA + 'nades/maps.json');
    mapsP.then((j) => { const o: Record<string, string> = {}; for (const m of j?.maps || []) o[m.name.toLowerCase()] = m.radar; setRadars(o); });
  }, []);
  const since = Date.now() / 1000 - period * 86400;
  const agg = new Map<string, [number, number, number, number]>(); // wins, maps, rounds won, rounds lost
  for (const m of file.m) {
    if (m[0] < since) break;
    for (const [mp, a, b] of m[4]) {
      if (!mp) continue;
      const e = agg.get(mp) || [0, 0, 0, 0];
      e[0] += a > b ? 1 : 0; e[1]++; e[2] += a; e[3] += b;
      agg.set(mp, e);
    }
  }
  const list = [...agg.entries()].sort((a, b) => b[1][1] - a[1][1]);
  return (
    <section className="tm-card">
      <div className="tm-h row between"><span>Карты</span>
        <span className="tm-seg">{[[90, '3 мес'], [180, '6 мес'], [365, 'год']].map(([d, ru]) => <button key={d} className={period === d ? 'on' : ''} onClick={() => setPeriod(d as number)}>{ru}</button>)}</span>
      </div>
      {list.map(([mp, [w, n, rw, rl]]) => {
        const p = Math.round((w / n) * 100);
        return (
          <div key={mp} className="tm-map" title={`${mp}: ${w} побед из ${n} карт, раунды ${rw}:${rl}`}>
            <span className="tm-mapimg" style={radars[mp.toLowerCase()] ? { backgroundImage: `url(${radars[mp.toLowerCase()]})` } : undefined}>{radars[mp.toLowerCase()] ? '' : mp.slice(0, 2)}</span>
            <div className="tm-mapbody">
              <div className="row between"><b>{mp}</b><b className={'num' + (p >= 55 ? ' good' : p < 45 ? ' bad' : '')}>{p}%</b></div>
              <div className="tm-bar"><span style={{ width: `${p}%` }} /></div>
              <span className="tiny muted">{w} из {n} карт · раунды {rw}:{rl}</span>
            </div>
          </div>
        );
      })}
      {!list.length && <div className="empty small">За этот срок карт нет</div>}
    </section>
  );
}

function Titles({ file }: { file: TeamFile }) {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [all, setAll] = useState(false);
  useEffect(() => { loadLpLogos().then((x) => setIcons(x?.e || {})); }, []);
  if (!file.titles.length) return null;
  const list = all ? file.titles : file.titles.slice(0, 10);
  return (
    <section className="tm-card">
      <h3 className="tm-h">Титулы<span className="tm-hsub">{file.titles.length} с 2021</span></h3>
      {list.map(([ts, nm, pg, tier]) => (
        <div key={pg} className="tm-title">
          {icons[pg] ? <img src={import.meta.env.BASE_URL + 'data/logos/' + icons[pg]} alt="" width={26} height={26} loading="lazy" /> : <span className="tm-cup">🏆</span>}
          <div className="stack" style={{ gap: 1, minWidth: 0 }}>
            <span className="tm-ell">{nm}</span>
            <span className="tiny muted">{new Date(ts * 1000).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}{tier ? ` · ${tier}-Tier` : ''}</span>
          </div>
        </div>
      ))}
      {file.titles.length > 10 && <button className="tm-more" onClick={() => setAll(!all)}>{all ? 'Свернуть' : `Все титулы · ${file.titles.length}`}</button>}
    </section>
  );
}
