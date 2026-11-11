import { expect, type Page } from '@playwright/test';

// The sandbox / CI may not reach Steam's CDN, flagcdn or avatars — failed external images are not site bugs.
const EXTERNAL = /steamstatic|akamai|cloudflare|flagcdn|avatars|liquipedia|googleusercontent|workers\.dev|ccr|fonts\.g/;

/** collect console errors and 5xx responses of the site itself; call `check()` at the end of a test */
export function guard(page: Page) {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    if (/Failed to load resource/.test(t) || EXTERNAL.test(t) || /ERR_|net::/.test(t)) return;
    errors.push(t);
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 500 && !EXTERNAL.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  return { check: () => expect(errors, errors.join('\n')).toEqual([]) };
}

/** site images (served by us) that failed to load — external ones are skipped */
export async function brokenLocalImages(page: Page, selector = 'img') {
  return page.$$eval(selector, (imgs) => imgs
    .filter((i) => (i as HTMLImageElement).src.includes('/rush-b/') && (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth === 0)
    .map((i) => (i as HTMLImageElement).src));
}

/** no horizontal page scroll (mobile layouts) */
export async function noHorizontalScroll(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, `page is ${sw}px wide in a ${cw}px viewport`).toBeLessThanOrEqual(cw + 1);
}
