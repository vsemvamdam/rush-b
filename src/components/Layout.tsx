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

/** RUSH B mark: a bombsite «B» painted on the wall in a freehand circle — drips, and splatter flung from the rush */
function Logo() {
  return (
    <a href="#/" className="logo" aria-label="RUSH B — на главную">
      <svg className="logo-mark" viewBox="2 4 44 42" width="46" height="44" aria-hidden="true">
        <defs>
          <filter id="rb-paint" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves={2} seed={11} result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale={1.7} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
        <g className="lm-paint" filter="url(#rb-paint)">
          <path fill="none" strokeWidth="2.9" strokeLinecap="round" d="M14.2 13.4 C19.6 8.6 29.4 8.1 35.6 12.8 C41.9 17.6 42.6 27.6 37.4 33.8 C32.4 39.8 22.6 41.1 16.4 37.2 C11.6 34.2 9.6 28.6 10.6 23.2 C11.2 19.9 12.6 17.4 15.4 15.2 C17.9 13.2 21 12 23.6 11.6" />
          <g transform="rotate(-6 26 25)">
            <path fillRule="evenodd" stroke="none" d="M18.4 14 C21.6 13.6 25.2 13.5 27.6 13.7 C32.2 14 34.4 16.4 34.2 19.6 C34.1 22 32.9 23.5 30.9 24.2 C33.7 24.9 35.6 26.9 35.5 29.7 C35.4 33.5 32.4 35.6 27.6 35.7 C24.6 35.8 21.6 35.7 18.9 35.5 C18.7 28.4 18.5 21.1 18.4 14 Z M23.2 17.9 L23.3 22.6 C24.6 22.7 25.8 22.7 26.8 22.6 C28.5 22.5 29.4 21.6 29.3 20.2 C29.2 18.8 28.1 18 26.4 17.9 C25.4 17.8 24.2 17.8 23.2 17.9 Z M23.4 26.4 L23.5 31.5 C24.9 31.6 26.2 31.6 27.3 31.5 C29.3 31.4 30.3 30.4 30.2 28.9 C30.1 27.3 29 26.4 27 26.3 C25.8 26.2 24.6 26.3 23.4 26.4 Z" />
            <g fill="none" strokeLinecap="round">
              <path strokeWidth="1.9" d="M20.6 35 C20.6 37.6 20.7 40.4 20.5 43.4" />
              <path strokeWidth="1.5" d="M27.2 35.4 V39.6" />
              <path strokeWidth="1.2" d="M33.2 33.6 V36.8" />
            </g>
          </g>
          <g stroke="none">
            <ellipse cx="6.4" cy="24.6" rx="2.6" ry="1.3" transform="rotate(-8 6.4 24.6)" />
            <ellipse cx="3.2" cy="28.8" rx="1.8" ry=".9" transform="rotate(12 3.2 28.8)" opacity=".85" />
            <ellipse cx="4.6" cy="19.6" rx="1.5" ry=".8" transform="rotate(-18 4.6 19.6)" opacity=".8" />
            <circle cx="8.6" cy="31.6" r="1.1" />
            <circle cx="1.8" cy="23" r=".7" opacity=".7" />
            <circle cx="9.2" cy="17.2" r=".6" opacity=".7" />
            <circle cx="5.6" cy="35.2" r=".8" opacity=".6" />
            <circle cx="41.8" cy="9.2" r=".8" opacity=".7" />
            <circle cx="44.2" cy="36.4" r=".6" opacity=".6" />
          </g>
        </g>
      </svg>
      <span className="logo-text">
        <span className="logo-name">RUSH <b>B</b></span>
        <span className="logo-sub">CS2</span>
      </span>
    </a>
  );
}

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
          <Logo />
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
          <span>RUSH B — фанатский проект, не связан с Valve. Изображения предметов — Steam CDN; база предметов — ByMykel/CSGO-API.</span>
          <span><a className="link" href="https://github.com/vsemvamdam/rush-b" target="_blank" rel="noreferrer">GitHub</a> · <a className="link" href="#/about">О данных</a></span>
        </div>
      </footer>
    </div>
  );
}
