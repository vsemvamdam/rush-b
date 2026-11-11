import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { applyTheme } from './lib/prefs';
import { useRoute } from './lib/router';
import Home from './pages/Home';

const Catalog = lazy(() => import('./pages/Catalog'));
const SkinPage = lazy(() => import('./pages/SkinPage'));
const TradeUp = lazy(() => import('./pages/TradeUp'));
const Craft = lazy(() => import('./pages/Craft'));
const Patterns = lazy(() => import('./pages/Patterns'));
const Nades = lazy(() => import('./pages/Nades'));
const Tools = lazy(() => import('./pages/Tools'));
const Crosshair = lazy(() => import('./pages/Crosshair'));
const Callouts = lazy(() => import('./pages/Callouts'));
const Players = lazy(() => import('./pages/Players'));
const Team = lazy(() => import('./pages/Team'));
const Stats = lazy(() => import('./pages/Stats'));
const Esports = lazy(() => import('./pages/Esports'));
const About = lazy(() => import('./pages/About'));
const Servers = lazy(() => import('./pages/Servers'));
const Collections = lazy(() => import('./pages/Collections').then((m) => ({ default: m.Collections })));
const CollectionPage = lazy(() => import('./pages/Collections').then((m) => ({ default: m.CollectionPage })));

const TITLES: Record<string, string> = {
  skins: 'Все скины', tradeup: 'Калькулятор крафтов', craft: 'Стикер-крафт', patterns: 'Паттерны', nades: 'Раскидки профи', callouts: 'Коллауты карт', players: 'Команды и игроки', player: 'Игрок', team: 'Команда', stats: 'Статистика Steam и CS2', crosshair: 'Генератор прицела', tools: 'Утилиты', esports: 'Турниры и матчи', duels: 'Дуэли и серверы CS2', collections: 'Коллекции', about: 'О данных',
};

function App() {
  const r = useRoute();
  const [a, b] = r.parts;
  document.title = (TITLES[a] ? TITLES[a] + ' · ' : '') + 'CS2 CRAFT';
  let page;
  switch (a) {
    case undefined: page = <Home />; break;
    case 'skins': page = <Catalog />; break;
    case 'skin': page = <SkinPage id={b} key={b} />; break;
    case 'tradeup': page = <TradeUp />; break;
    case 'craft': page = <Craft />; break;
    case 'patterns': page = <Patterns />; break;
    case 'nades': page = <Nades map={b} />; break;
    case 'crosshair': page = <Crosshair />; break;
    case 'callouts': page = <Callouts map={b} />; break;
    case 'players': page = <Players />; break;
    case 'player': page = <Players sid={b} />; break;
    case 'team': page = <Team slug={b} key={b} />; break;
    case 'stats': page = <Stats id={b} key={b || ''} />; break;
    case 'tools': page = <Tools />; break;
    case 'esports': page = <Esports />; break;
    case 'duels': page = <Servers />; break;
    case 'collections': page = <Collections />; break;
    case 'collection': page = <CollectionPage id={b} key={b} />; break;
    case 'about': page = <About />; break;
    default: page = <div className="empty">Страница не найдена. <a className="link" href="#/">На главную</a></div>;
  }
  return <Layout><Suspense fallback={<Spinner />}>{page}</Suspense></Layout>;
}

applyTheme();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
