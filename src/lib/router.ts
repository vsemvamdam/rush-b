import { useSyncExternalStore } from 'react';

// Hash router: works on GitHub Pages without server rewrites. URLs look like #/skin/<id>?w=2
export type Route = { path: string; parts: string[]; query: URLSearchParams };

/** a stray «%» in a pasted link must not leave the visitor with a blank page */
function safeDecode(s: string) {
  try { return decodeURIComponent(s); } catch { return s; }
}
function parse(): Route {
  const h = location.hash.replace(/^#/, '') || '/';
  const [p, q = ''] = h.split('?');
  const path = p || '/';
  return { path, parts: path.split('/').filter(Boolean).map(safeDecode), query: new URLSearchParams(q) };
}
let current = parse();
let currentKey = location.hash;
const subs = new Set<() => void>();
window.addEventListener('hashchange', () => {
  const prevPath = current.path;
  current = parse();
  currentKey = location.hash;
  if (current.path !== prevPath) window.scrollTo({ top: 0 });
  subs.forEach((f) => f());
});
export function useRoute(): Route {
  useSyncExternalStore((cb) => (subs.add(cb), () => subs.delete(cb)), () => currentKey);
  return current;
}
export function navigate(to: string, replace = false) {
  const h = to.startsWith('#') ? to : '#' + to;
  if (replace) history.replaceState(null, '', h), (current = parse()), (currentKey = location.hash), subs.forEach((f) => f());
  else location.hash = h;
}
/** update query params of the current route without adding history entries */
export function setQuery(params: Record<string, string | number | null | undefined>) {
  const q = new URLSearchParams(current.query);
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') q.delete(k);
    else q.set(k, String(v));
  }
  const s = q.toString();
  navigate(current.path + (s ? '?' + s : ''), true);
}
export const href = (to: string) => '#' + to;
/**
 * A link that came with data (RSS, Liquipedia, the demo archive, the stats server) may become an href only when it is
 * plain http(s): React does not stop «javascript:» and other schemes. Anything else → undefined (no link).
 */
export function extUrl(u: unknown): string | undefined {
  if (typeof u !== 'string') return undefined;
  const s = u.trim();
  return /^https?:\/\/[^\s/?#]/i.test(s) ? s : undefined;
}
