import { useMemo } from 'react';
import { SkinCard, Spinner, Updated } from '../components/ui';
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
    <div className="stack" style={{ gap: 28 }}>
      <section className="hero">
        <span className="badge" style={{ alignSelf: 'flex-start' }}>Ноябрь 2026 · правила с крафтом ножей и сувениров</span>
        <h1>Крафты, скины и цены CS2 — в одном месте</h1>
        <p className="lead">Считаем контракты обмена с учётом всех новых правил, показываем историю цены каждого скина с первой сделки в Steam, собираем стикер-крафты и раскидки профи.</p>
        <div className="row">
          <a className="btn primary" href="#/tradeup">Открыть калькулятор</a>
          <a className="btn" href="#/skins">Каталог скинов</a>
          <a className="btn ghost" href="#/craft">Собрать стикер-крафт</a>
        </div>
        {db && <div className="row small muted" style={{ gap: 18 }}><span><b className="num">{db.skins.length.toLocaleString('ru-RU')}</b> скинов</span><span><b className="num">{db.collections.length}</b> коллекций</span><span><b className="num">{db.collections.filter((c) => c.gold.length).length}</b> коллекций с ножами/перчатками</span><Updated prices={prices} /></div>}
      </section>
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
