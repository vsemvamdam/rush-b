import { useMemo } from 'react';
import { SkinCard, Spinner, Updated } from '../components/ui';
import { MATCH_SCHEDULE_MAX_AGE, useEsports, useNow } from '../lib/esports';
import { useDB, usePrices } from '../lib/hooks';
import { priceRange, usePrefs } from '../lib/prefs';
import { href } from '../lib/router';

const FEATURES = [
  { to: '/tradeup', ic: '⚗️', t: 'Калькулятор крафтов', d: 'Оружие 10 → 1 и ножи/перчатки 5 → 1: шансы, флоат результата, EV, ROI, шанс профита, симуляция.' },
  { to: '/skins', ic: '🗂️', t: 'Все скины и цены', d: 'Каталог оружия, ножей и перчаток. Цены Steam и Skinport по каждому износу, история с первой сделки.' },
  { to: '/craft', ic: '🎨', t: 'Стикер-крафт', d: 'Наклейки и брелок на любое оружие: поворот, потёртость, стоимость сборки, превью прямо в CS2.' },
  { to: '/patterns', ic: '🧬', t: 'Паттерны', d: 'Процент Fade по сиду, фазы Doppler, blue gem Case Hardened, Fire & Ice и другие редкие паттерны.' },
  { to: '/nades', ic: '💨', t: 'Раскидки профи', d: 'Все гранаты из турнирных демок с 3D-повтором прямо на сайте: от первого лица, с позиции и в полёте. Клавиши, setpos, кто из профи так кидает.' },
  { to: '/callouts', ic: '🗺️', t: 'Коллауты', d: 'Названия всех мест на картах Active Duty — английские, как у профи, и русские, как говорят в комах.' },
  { to: '/players', ic: '👤', t: 'Игроки', d: 'Статистика профи из турнирных демок, их прицелы и раскидки, составы команд.' },
  { to: '/duels', ic: '⚔️', t: 'Дуэли и серверы', d: 'Живой список серверов Cybershoke: дуэли 1×1 и 2×2, арены, DM, ретейки, сёрф, KZ. Фильтр по городу и свободным местам для компании, вход в один клик.' },
  { to: '/crosshair', ic: '🎯', t: 'Генератор прицела', d: 'Коды нового формата CS…, предпросмотр в реальном масштабе на 16:9 и растянутом 4:3, импорт старых кодов и команд, autoexec.' },
  { to: '/tools', ic: '🛠️', t: 'Утилиты', d: 'Перевод сенсы и eDPI, viewmodel, конфиг для тренировки, бинды, параметры запуска.' },
];

const matchTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const matchDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

function HomeMatches() {
  const { data, loading } = useEsports();
  const now = useNow();
  const source = data?.sources.liquipedia;
  const fresh = source?.ok && source.at != null && now - source.at <= MATCH_SCHEDULE_MAX_AGE;
  const matches = fresh && data ? data.matches.filter((m) => !m.t1.tbd && !m.t2.tbd) : [];
  const liveMatches = matches.filter((m) => m.status === 'live' && m.start <= now && !m.approx);
  const live = liveMatches.find((m) => m.tier === 'S') || liveMatches[0];
  const match = live || matches.find((m) => m.status === 'upcoming' && m.start > now);
  const start = match ? new Date(match.start * 1000) : null;
  const today = start?.toDateString() === new Date(now * 1000).toDateString();
  const timeText = start && [
    !today && matchDate.format(start),
    match?.approx ? today && 'Время уточняется' : matchTime.format(start),
  ].filter(Boolean).join(' · ');

  return (
    <section className="card home-matches" aria-labelledby="home-matches-title">
      <div className="row between home-matches-head">
        <h2 id="home-matches-title">{start && !today && !live ? 'Ближайший матч' : 'Матчи сегодня'}</h2>
        <a className="link small" href={href('/esports')}>Расписание →</a>
      </div>
      {match && start ? (
        <>
          <p className="home-match-pair">
            {match.t1.f || match.t1.n}
            <span className="num muted home-match-score">{live && match.score ? match.score.join(' : ') : 'vs'}</span>
            {match.t2.f || match.t2.n}
          </p>
          <p className="small muted home-match-meta">
            {live ? <span className="home-match-live"><span className="live-dot" aria-hidden="true" />Идёт сейчас</span> : (
              <time dateTime={start.toISOString()}>{timeText}</time>
            )}
            <span>{match.tour}</span>
          </p>
        </>
      ) : (
        <p className="small muted">
          {loading ? 'Загружаем расписание…' : fresh && data?.matches.length ? 'Ближайшие пары пока не объявлены.' : 'Расписание обновляется.'}
        </p>
      )}
    </section>
  );
}

export default function Home() {
  const db = useDB();
  const prices = usePrices();
  const { source } = usePrefs();
  const top = useMemo(() => {
    if (!db) return [];
    const withPrice = db.skins.map((s) => ({ s, p: priceRange(prices, s, source)?.[1] ?? null }));
    if (withPrice.some((x) => x.p != null)) return withPrice.filter((x) => x.p != null && !x.s.gold).sort((a, b) => b.p! - a.p!).slice(0, 12).map((x) => x.s);
    return db.skins.filter((s) => s.rar === 6 && !s.gold).slice(-12).reverse();
  }, [db, prices, source]);
  const knives = useMemo(() => (db ? db.skins.filter((s) => s.cat === 'knife' && /Fade|Doppler|Marble/.test(s.fin)).slice(0, 6) : []), [db]);
  return (
    <div className="stack home">
      <div className="hero">
        <div className="hero-copy">
          <h1>Всё про CS2 — в одном месте</h1>
          <p className="lead">Скины и крафты, раскидки профи в 3D и серверы для игры с друзьями.</p>
          <div className="row hero-actions">
            <a className="btn primary" href="#/duels">Найти дуэль</a>
            <a className="btn" href="#/skins">Каталог скинов</a>
            <a className="btn" href="#/tradeup">Крафты</a>
            <a className="btn ghost" href="#/nades">Раскидки профи</a>
          </div>
        </div>
        <HomeMatches />
      </div>
      <section className="feature-grid">
        {FEATURES.map((f) => (
          <a key={f.to} href={href(f.to)} className="feature">
            <span className="ic">{f.ic}</span>
            <h3>{f.t}</h3>
            <p className="small muted">{f.d}</p>
          </a>
        ))}
      </section>
      {!db ? <Spinner /> : (
        <>
          <div className="hero-stats"><span><b className="num">{db.skins.length.toLocaleString('ru-RU')}</b> скинов</span><span><b className="num">{db.collections.length}</b> коллекций</span><span><b className="num">{db.collections.filter((c) => c.gold.length).length}</b> коллекций с ножами/перчатками</span><Updated prices={prices} /></div>
          <section className="stack">
            <div className="section-title"><h2>{prices?.updated ? 'Самые дорогие скины оружия' : 'Тайные скины из свежих коллекций'}</h2><a className="link small" href="#/skins?sort=price-desc">Все →</a></div>
            <div className="skin-grid">{top.map((s) => <SkinCard key={s.id} s={s} prices={prices} />)}</div>
          </section>
          <section className="stack">
            <div className="section-title"><h2>Ножи с паттернами</h2><a className="link small" href="#/patterns">Про паттерны →</a></div>
            <div className="skin-grid">{knives.map((s) => <SkinCard key={s.id} s={s} prices={prices} />)}</div>
          </section>
        </>
      )}
    </div>
  );
}
