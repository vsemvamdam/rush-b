import React, { useMemo } from 'react';
import { imgUrl, type Prices, type Skin } from '../lib/data';
import { RARITIES, WEARS, rarityName } from '../lib/labels';
import { money, priceRange, usePrefs } from '../lib/prefs';
import { href } from '../lib/router';

export const Spinner = () => <div className="spinner" aria-label="Загрузка" />;

export function rarityColor(s: Skin) {
  return RARITIES[s.rar]?.color || '#888';
}

export function Price({ cents, prices, compact }: { cents: number | null | undefined; prices: Prices | null; compact?: boolean }) {
  const { currency } = usePrefs();
  return <span className="num">{money(cents, prices, currency, { compact })}</span>;
}

export function RarityTag({ rar, cat }: { rar: number; cat?: string }) {
  const r = RARITIES[rar];
  return (
    <span className="row" style={{ gap: 6, display: 'inline-flex' }}>
      <span className="rar-dot" style={{ background: r?.color }} />
      <span>{rarityName(rar, cat)}</span>
    </span>
  );
}

export function SkinCard({ s, prices, to, onClick, extra }: { s: Skin; prices: Prices | null; to?: string; onClick?: () => void; extra?: React.ReactNode }) {
  const { source, currency } = usePrefs();
  const range = useMemo(() => priceRange(prices, s, source), [prices, s, source]);
  const [wpn, fin] = s.name.replace('★ ', '').split(' | ');
  const body = (
    <>
      <div className="img">
        <img src={imgUrl(s.img, 256)} alt={s.name} loading="lazy" width={256} height={192} />
      </div>
      <div className="meta">
        <div className="row between" style={{ gap: 6 }}>
          <span className="wpn">{s.gold ? '★ ' : ''}{wpn}</span>
          <span className="row" style={{ gap: 4 }}>
            {s.st ? <span className="badge st">ST</span> : null}
            {s.sv ? <span className="badge sv">SV</span> : null}
          </span>
        </div>
        <div className="fin" title={s.ru ? `${s.name}\n${s.ru}` : s.name}>{fin || (s.vanilla ? 'Ванильный' : wpn)}</div>
        <div className="price muted">
          {range ? (range[0] === range[1] ? <span className="p-max">{money(range[0], prices, currency)}</span> : <><span className="p-min">{money(range[0], prices, currency, { compact: true })}</span> – <span className="p-max">{money(range[1], prices, currency, { compact: true })}</span></>) : '—'}
        </div>
        {extra}
      </div>
    </>
  );
  const style = { ['--rc' as any]: rarityColor(s) } as React.CSSProperties;
  if (onClick) return <div className="skin-card" style={style} onClick={onClick}>{body}</div>;
  return <a className="skin-card" style={style} href={href(to || `/skin/${s.id}`)}>{body}</a>;
}

/** wiki.cs.money-style float bar: wear segments, the skin's possible range, a knob */
export function FloatBar({ value, min = 0, max = 1, onChange, compact }: { value: number | null; min?: number; max?: number; onChange?: (v: number) => void; compact?: boolean }) {
  // the slider spans the whole 0–1 scale (same as the picture); values outside the skin's range snap to it
  const clamp = (v: number) => +Math.min(max, Math.max(min, v)).toFixed(4);
  return (
    <div className={'floatbar' + (compact ? ' compact' : '') + (onChange ? ' editable' : '')}>
      {!compact && (
        <div className="labels">
          {WEARS.map((w) => <span key={w.short} style={{ left: `${((w.min + w.max) / 2) * 100}%` }}>{w.short}</span>)}
        </div>
      )}
      <div className="track">
        {WEARS.map((w) => <div key={w.short} className="seg-w" style={{ width: `${(w.max - w.min) * 100}%`, background: w.color }} />)}
        {min > 0 && <div className="shade" style={{ left: 0, width: `${min * 100}%` }} />}
        {max < 1 && <div className="shade" style={{ left: `${max * 100}%`, right: 0 }} />}
      </div>
      {min > 0 && <div className="cap" style={{ left: `${min * 100}%` }} />}
      {max < 1 && <div className="cap" style={{ left: `${max * 100}%` }} />}
      {value != null && <div className="knob" style={{ left: `${Math.min(1, Math.max(0, value)) * 100}%` }} />}
      {!compact && (
        <div className="ticks">
          {[0.07, 0.15, 0.38, 0.45].map((t) => <span key={t} style={{ left: `${t * 100}%` }}>{t.toFixed(2)}</span>)}
        </div>
      )}
      {onChange && (
        <input type="range" min={0} max={1} step={0.0005} value={value ?? min} onChange={(e) => onChange(clamp(parseFloat(e.target.value)))} aria-label="Флоат" />
      )}
    </div>
  );
}

/** wear buttons FN…BS: picks a float in the middle of that wear within the skin's float range */
export function WearPicker({ value, min = 0, max = 1, onChange, full, select }: { value: number; min?: number; max?: number; onChange: (v: number) => void; full?: boolean; select?: boolean }) {
  const cur = value < 0.07 ? 0 : value < 0.15 ? 1 : value < 0.38 ? 2 : value < 0.45 ? 3 : 4;
  const pick = (i: number) => {
    const w = WEARS[i];
    const lo = Math.max(min, w.min), hi = Math.min(max, w.max);
    if (hi > lo) onChange(+(lo + (hi - lo) / 2).toFixed(4));
  };
  if (select) {
    return (
      <select className="select small wearselect" value={cur} onChange={(e) => pick(+e.target.value)} aria-label="Качество" style={{ borderLeft: `3px solid ${WEARS[cur].color}` }}>
        {WEARS.map((w, i) => {
          const ok = Math.min(max, w.max) > Math.max(min, w.min);
          return <option key={w.short} value={i} disabled={!ok}>{w.ru}{ok ? '' : ' — нет'}</option>;
        })}
      </select>
    );
  }
  return (
    <div className="seg wearpick" role="radiogroup" aria-label="Качество">
      {WEARS.map((w, i) => {
        const lo = Math.max(min, w.min), hi = Math.min(max, w.max);
        const ok = hi > lo;
        return (
          <button key={w.short} role="radio" aria-checked={cur === i} className={cur === i ? 'on' : ''} disabled={!ok} title={`${w.ru}${ok ? ` · ${lo.toFixed(2)}–${hi.toFixed(2)}` : ' — у этого скина не бывает'}`}
            style={cur === i ? { boxShadow: `inset 0 -2px 0 ${w.color}` } : undefined}
            onClick={() => pick(i)}>
            {full ? w.ru : w.short}
          </button>
        );
      })}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function NoPricesNotice({ prices }: { prices: Prices | null }) {
  if (!prices || prices.updated) return null;
  return (
    <div className="notice warn">
      Цены ещё не загружены: их собирает GitHub Actions по расписанию (каждые 6 часов). После первого запуска здесь появятся цены Steam и Skinport. Пока можно вводить цены вручную.
    </div>
  );
}

export function Updated({ prices }: { prices: Prices | null }) {
  if (!prices?.updated) return null;
  const d = new Date(prices.updated);
  return <span className="tiny faint"><span className="live-dot" aria-hidden="true" />Цены обновлены {d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</span>;
}
