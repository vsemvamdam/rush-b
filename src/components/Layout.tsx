import React, { useEffect, useMemo, useRef, useState } from 'react';
import { imgUrl } from '../lib/data';
import { useDB } from '../lib/hooks';
import { RARITIES } from '../lib/labels';
import { setPrefs, usePrefs, type Currency } from '../lib/prefs';
import { href, navigate, useRoute } from '../lib/router';

const NAV = [
  { to: '/skins', label: 'Скины' },
  { to: '/tradeup', label: 'Крафты' },
  { to: '/nades', label: 'Раскидки' },
  { to: '/callouts', label: 'Коллауты' },
  { to: '/players', label: 'Команды и игроки' },
  { to: '/esports', label: 'Матчи' },
  { to: '/duels', label: 'Дуэли' },
  { to: '/stats', label: 'Статистика' },
  { to: '/crosshair', label: 'Прицел' },
];
/** less used sections: under «Ещё» on desktop, listed flat in the mobile menu */
const MORE = [
  { to: '/craft', label: 'Стикер-крафт' },
  { to: '/patterns', label: 'Паттерны' },
  { to: '/tools', label: 'Утилиты' },
  { to: '/collections', label: 'Коллекции' },
  { to: '/about', label: 'О данных' },
];

/** searchable text of a skin: English market name + official Russian name */
export const skinText = (s: { name: string; ru?: string }) => norm(s.name + ' ' + (s.ru || ''));

export function norm(s: string) {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[★™|()\-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function Search() {
  const db = useDB();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const results = useMemo(() => {
    if (!db || q.trim().length < 2) return [];
    const words = norm(q).split(' ');
    const out: { to: string; title: string; sub: string; img: string; color: string }[] = [];
    for (const s of db.skins) {
      const n = skinText(s);
      if (words.every((w) => n.includes(w))) out.push({ to: `/skin/${s.id}`, title: s.name, sub: (s.ru ? s.ru + ' · ' : '') + (RARITIES[s.rar]?.ru || ''), img: imgUrl(s.img, 96), color: RARITIES[s.rar]?.color });
      if (out.length > 40) break;
    }
    for (const c of db.collections) {
      if (words.every((w) => norm(c.name).includes(w))) out.push({ to: `/collection/${c.id}`, title: c.name, sub: 'Коллекция', img: imgUrl(c.img), color: 'transparent' });
    }
    return out.slice(0, 40);
  }, [db, q]);
  useEffect(() => {
    const f = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', f);
    return () => document.removeEventListener('mousedown', f);
  }, []);
  const go = (to: string) => { navigate(to); setOpen(false); setQ(''); };
  return (
    <div ref={box} className="header-search" style={{ position: 'relative', width: 'clamp(140px, 13vw, 210px)' }}>
      <input
        className="input"
        style={{ width: '100%' }}
        placeholder="Поиск: Redline, Керамбит…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setSel(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { setSel((s) => Math.min(s + 1, results.length - 1)); e.preventDefault(); }
          if (e.key === 'ArrowUp') { setSel((s) => Math.max(s - 1, 0)); e.preventDefault(); }
          if (e.key === 'Enter') {
            if (results[sel]) go(results[sel].to);
            else if (q.trim()) go(`/skins?q=${encodeURIComponent(q.trim())}`);
          }
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && results.length > 0 && (
        <div className="search-pop">
          {results.map((r, i) => (
            <a key={r.to} href={href(r.to)} className={i === sel ? 'sel' : ''} onClick={(e) => { e.preventDefault(); go(r.to); }}>
              <img src={r.img} alt="" style={{ width: 48, height: 36, objectFit: 'contain' }} />
              <span className="grow">
                <div style={{ fontWeight: 600, fontSize: 14 }}>{r.title}</div>
                <div className="tiny" style={{ color: r.color === 'transparent' ? 'var(--muted)' : r.color }}>{r.sub}</div>
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const route = useRoute();
  const prefs = usePrefs();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [route.path]);
  const active = (to: string) => route.path === to || route.path.startsWith(to + '/') || (to === '/skins' && route.path.startsWith('/skin/')) || (to === '/collections' && route.path.startsWith('/collection/')) || (to === '/players' && (route.path.startsWith('/player/') || route.path.startsWith('/team/')));
  return (
    <div className="app">
      <header className="header">
        <div className="container header-inner">
          <a href="#/" className="logo"><span className="logo-mark">C2</span><span>CS2 CRAFT</span></a>
          <nav className={'nav' + (menu ? ' open' : '')}>
            {NAV.map((n) => <a key={n.to} href={href(n.to)} className={active(n.to) ? 'active' : ''}>{n.label}</a>)}
            <div className="nav-more">
              <button type="button" className={'nav-more-btn' + (MORE.some((n) => active(n.to)) ? ' active' : '')}>Ещё ▾</button>
              <div className="nav-more-menu">
                {MORE.map((n) => <a key={n.to} href={href(n.to)} className={active(n.to) ? 'active' : ''}>{n.label}</a>)}
              </div>
            </div>
          </nav>
          <div className="header-tools">
            <Search />
            <a className="btn icon search-btn" href="#/skins" aria-label="Поиск">🔍</a>
            <select className="select" value={prefs.currency} onChange={(e) => setPrefs({ currency: e.target.value as Currency })} aria-label="Валюта" title="Валюта">
              <option value="RUB">₽ RUB</option>
              <option value="USD">$ USD</option>
              <option value="EUR">€ EUR</option>
              <option value="CNY">¥ CNY</option>
            </select>
            <button className="btn icon" title={prefs.theme === 'dark' ? 'Тёмная тема' : prefs.theme === 'light' ? 'Светлая тема' : 'Тема как в системе'} onClick={() => setPrefs({ theme: prefs.theme === 'dark' ? 'light' : prefs.theme === 'light' ? 'auto' : 'dark' })}>
              {prefs.theme === 'dark' ? '🌙' : prefs.theme === 'light' ? '☀️' : '🌗'}
            </button>
            <button className="btn icon menu-btn" onClick={() => setMenu((m) => !m)} aria-label="Меню">☰</button>
          </div>
        </div>
      </header>
      <main>
        <div className="container">{children}</div>
      </main>
      <footer className="footer">
        <div className="container row between">
          <span>CS2 CRAFT — фанатский проект, не связан с Valve. Изображения предметов — Steam CDN; база предметов — ByMykel/CSGO-API.</span>
          <span><a className="link" href="https://github.com/vsemvamdam/cs2-craft" target="_blank" rel="noreferrer">GitHub</a> · <a className="link" href="#/about">О данных</a></span>
        </div>
      </footer>
    </div>
  );
}
