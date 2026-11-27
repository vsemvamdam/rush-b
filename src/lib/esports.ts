import { useCallback, useEffect, useState } from 'react';

/* Data: JSON built by scripts/fetch-esports.mjs in GitHub Actions every ~20 min and force-pushed to the
   orphan branch esports-data — the static site reads it at runtime, Pages is not rebuilt. */
const SOURCES = [
  import.meta.env.VITE_ESPORTS_URL as string | undefined,
  'https://raw.githubusercontent.com/vsemvamdam/rush-b/esports-data/esports.json',
  'https://cdn.jsdelivr.net/gh/vsemvamdam/rush-b@esports-data/esports.json',
].filter(Boolean) as string[];
export const MATCH_SCHEDULE_MAX_AGE = 2 * 3600;

export type Team = { n: string; f?: string; tbd?: boolean };
type Book = { b: string; o: [number, number]; at?: number };
export type Odds = { books: Book[]; best: [number, number]; bestBy: [string, string]; prob: [number, number]; fav: 0 | 1 | null; at?: number; closed?: boolean };
type Stream = { p: string; u: string };
export type Match = {
  id: string; t1: Team; t2: Team; start: number; status: 'live' | 'upcoming' | 'finished'; approx?: boolean; bo?: number;
  score?: [number, number]; winner?: 1 | 2; tour: string; stage?: string; tp?: string; tier?: string; streams?: Stream[]; odds?: Odds;
};
export type Tournament = {
  id: string; name: string; short?: string; tier?: string; tiertype?: string; start?: string; end?: string; prize?: number; cur?: string;
  city?: string; country?: string; venue?: string; type?: 'lan' | 'online' | 'mixed'; teams?: number; org?: string; major?: boolean;
  status: 'ongoing' | 'upcoming' | 'finished'; url: string; m?: { up: number; live: number; done: number };
};
export type Source = { ok: boolean; at: number | null; n?: number; total?: number; error?: string };
export type Data = {
  v: 1; updated: number; books: Record<string, string>; matches: Match[]; tournaments: Tournament[];
  sources: { liquipedia: Source; polymarket?: Source; oddspapi?: Source & { key: boolean; books: string[]; used?: number; limit?: number; every?: number } };
};

async function loadData(): Promise<Data> {
  let lastErr: unknown;
  for (const url of SOURCES) {
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as Data;
      if (d?.v !== 1 || !Array.isArray(d.matches)) throw new Error('неверный формат');
      return d;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

let pending: Promise<Data> | undefined;

export function useEsports() {
  const [s, set] = useState<{ data: Data | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const reload = useCallback(() => {
    pending ??= loadData().finally(() => { pending = undefined; });
    pending.then(
      (data) => set({ data, error: null, loading: false }),
      (e) => set((p) => ({ data: p.data, error: String(e?.message || e), loading: false })),
    );
  }, []);
  useEffect(() => {
    reload();
    const t = window.setInterval(reload, 5 * 60 * 1000);
    const vis = () => document.visibilityState === 'visible' && reload();
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [reload]);
  return { ...s, reload };
}

export function useNow(ms = 30000) {
  const [now, set] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = window.setInterval(() => set(Date.now() / 1000), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
