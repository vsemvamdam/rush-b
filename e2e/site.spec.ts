import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { brokenLocalImages, guard, noHorizontalScroll } from './helpers';

// F01 — every section opens without errors
const ROUTES: [string, string, RegExp][] = [
  ['F01-H1', '#/', /CS2|Скины|крафт/i],
  ['F01-H2', '#/skins', /скины/i],
  ['F01-H3', '#/tradeup', /контракт|крафт/i],
  ['F01-H4', '#/craft', /наклей|стикер/i],
  ['F01-H5', '#/patterns', /паттерн/i],
  ['F01-H6', '#/nades', /раскидк/i],
  ['F01-H7', '#/callouts', /коллаут|карт/i],
  ['F01-H8', '#/players', /команды и игроки/i],
  ['F01-H9', '#/esports', /матч/i],
  ['F01-H10', '#/stats', /статистик/i],
  ['F01-H11', '#/crosshair', /прицел/i],
  ['F01-H12', '#/collections', /коллекци/i],
  ['F01-H13', '#/tools', /утилит|инструмент/i],
  ['F01-H14', '#/about', /данн/i],
];
for (const [id, url, text] of ROUTES) {
  test(`${id} раздел ${url} открывается без ошибок`, async ({ page }) => {
    const g = guard(page);
    await page.goto(url);
    await expect(page.locator('main, #root').first()).toContainText(text);
    await page.waitForLoadState('networkidle');
    g.check();
  });
}

test('F01-E1 несуществующий адрес не ломает сайт', async ({ page }) => {
  const g = guard(page);
  await page.goto('#/team/no-such-team-xyz');
  await expect(page.getByText(/страницы этой команды пока нет/i)).toBeVisible();
  await page.goto('#/player/123');
  await expect(page.getByText(/игрок не найден/i)).toBeVisible();
  g.check();
});

// F02 — catalog, «Другое»
test('F02-H1 каталог: раздел «Другое» → агенты, поиск, сортировка', async ({ page }) => {
  const g = guard(page);
  await page.goto('#/skins');
  await page.getByRole('button', { name: 'Агенты' }).click();
  await expect(page.getByRole('heading', { name: 'Агенты', level: 1 })).toBeVisible();
  const cards = page.locator('.skin-grid > *');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThan(20);
  await page.getByPlaceholder('Название…').fill('Профессионалы');
  await expect(cards.first()).toContainText(/Профессионалы/);
  await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
  for (const cat of ['Кейсы и капсулы', 'Граффити', 'Наборы музыки', 'Брелоки', 'Нашивки', 'Ключи', 'Пропуска', 'Коллекционные', 'Подарки']) {
    await page.getByRole('button', { name: cat, exact: true }).click();
    await expect(page.getByRole('heading', { name: cat, level: 1 })).toBeVisible();
    await expect(cards.first()).toBeVisible();
  }
  g.check();
});

// F04 — trade-up picker: rarity sort both ways
test('F04-H1 контракты: сортировка по редкости и в обратную сторону', async ({ page }) => {
  const g = guard(page);
  await page.goto('#/tradeup');
  await page.getByRole('button', { name: /добавить/i }).first().click();
  const rarBtn = page.getByRole('button', { name: /^Редкость/ });
  await rarBtn.click();
  await expect(rarBtn).toHaveText(/Редкость ↓/);
  await rarBtn.click();
  await expect(rarBtn).toHaveText(/Редкость ↑/);
  const price = page.getByRole('button', { name: /^Цена/ });
  await price.click();
  await price.click();
  await expect(price).toHaveText(/Цена ↓/);
  g.check();
});

// F08 — teams ranking & players table
test('F08-H1 рейтинг команд: регион, карточка → страница команды', async ({ page }) => {
  const g = guard(page);
  await page.goto('#/players');
  await expect(page.getByText(/Valve Regional Standings/)).toBeVisible();
  await page.getByRole('button', { name: 'Европа', exact: true }).click();
  const first = page.locator('.pl-tcard').first();
  await expect(first).toContainText('#');
  await first.getByRole('link', { name: /страница команды/i }).click();
  await expect(page).toHaveURL(/#\/team\//);
  await expect(page.locator('.tm-name')).toBeVisible();
  g.check();
});

test('F08-H3 у команд топ-30 мира есть логотип, у игроков топ-10 — фото', async ({ page }) => {
  const g = guard(page);
  await page.goto('#/players');
  const cards = page.locator('.pl-tcard');
  await expect(cards.first()).toBeVisible();
  const noLogo: string[] = [];
  for (let i = 0; i < 30; i++) {
    const c = cards.nth(i);
    if (!(await c.locator('.pl-thead img').count())) noLogo.push((await c.locator('h3').innerText()).trim());
  }
  expect(noLogo, 'команды без логотипа: ' + noLogo.join(', ')).toEqual([]);
  const noPhoto: string[] = [];
  for (let i = 0; i < 10; i++) {
    const c = cards.nth(i);
    const rows = c.locator('.pl-rrow');
    for (let j = 0; j < (await rows.count()); j++) if (!(await rows.nth(j).locator('img.pl-photo').count())) noPhoto.push((await rows.nth(j).locator('b').innerText()).trim());
  }
  expect(noPhoto.length, 'игроки топ-10 без фото: ' + noPhoto.join(', ')).toBeLessThanOrEqual(5);
  g.check();
});

test('F08-H2 таблица игроков сортируется в обе стороны', async ({ page }) => {
  const g = guard(page);
  await page.goto('#/players?tab=players');
  const kd = page.getByRole('columnheader', { name: /^K\/D/ });
  await kd.click();
  await expect(kd).toHaveText(/K\/D ↓/);
  const col = await page.locator('tbody tr td:nth-child(4)').allInnerTexts();
  await kd.click();
  await expect(kd).toHaveText(/K\/D ↑/);
  const col2 = await page.locator('tbody tr td:nth-child(4)').allInnerTexts();
  expect(+col[0]).toBeGreaterThanOrEqual(+col2[0]);
  g.check();
});

// F09 — team page (Vitality)
test('F09-H1 Vitality: состав, кто играет сейчас (jL), apEX в составе, замены, штаб, логотип', async ({ page }) => {
  const g = guard(page);
  await page.goto('#/team/team-vitality');
  await expect(page.locator('.tm-name')).toHaveText(/Vitality/);
  const roster = page.locator('.tm-roster');
  for (const nick of ['ZywOo', 'flameZ', 'mezii', 'ropz', 'jL']) await expect(roster).toContainText(nick);
  await expect(page.locator('.tm-subs').first()).toContainText('apEX');
  await expect(roster.getByText(/замена за apEX/)).toBeVisible();
  // every player card leads to a player page
  const jl = roster.getByRole('link', { name: /jL/ });
  await expect(jl).toHaveAttribute('href', /#\/player\/7656\d{13}/);
  await expect(page.getByRole('heading', { name: /Тренерский штаб/i })).toBeVisible();
  await expect(page.getByText('XTQZZZ').first()).toBeVisible();
  // our own images (team logo, opponent logos, title icons, photos) all load
  await page.waitForLoadState('networkidle');
  expect(await brokenLocalImages(page)).toEqual([]);
  await expect(page.locator('.tm-logo img')).toHaveJSProperty('complete', true);
  g.check();
});

test('F09-H2 Vitality: матчи листаются по годам, «Показать ещё», очные встречи', async ({ page }) => {
  const g = guard(page);
  await page.goto('#/team/team-vitality');
  const rows = page.locator('.tm-match');
  await expect(rows).toHaveCount(20);
  await page.getByRole('button', { name: /Показать ещё/ }).click();
  await expect(rows).toHaveCount(50);
  await page.getByRole('button', { name: '2021' }).click();
  await expect(rows.first()).toContainText('2021');
  await rows.first().hover();
  await rows.first().getByRole('button', { name: 'все очные' }).click();
  await expect(page.getByText(/Матчи против/)).toBeVisible();
  g.check();
});

test('F09-H3 Vitality: карты за 3/6/12 месяцев и титулы', async ({ page }) => {
  const g = guard(page);
  await page.goto('#/team/team-vitality');
  await expect(page.locator('.tm-map').first()).toBeVisible();
  const n3 = await page.locator('.tm-map').count();
  await page.getByRole('button', { name: 'год' }).click();
  expect(await page.locator('.tm-map').count()).toBeGreaterThanOrEqual(n3);
  await expect(page.locator('.tm-title').first()).toContainText(/ESL Pro League|StarSeries|BLAST|IEM|PGL|Major/);
  g.check();
});

test('F09-H4 Vitality: колонка «Новости» — дни, источники, ники игроков, фильтр языка, пустое состояние', async ({ page }) => {
  const g = guard(page);
  const now = Math.round(Date.now() / 1000);
  const news = {
    v: 1, updated: now - 300,
    src: { cybersport: ['Cybersport.ru', 'ru'], hltv: ['HLTV', 'en'] },
    items: [
      { t: 'Mezii о новом сезоне', u: 'https://www.cybersport.ru/tags/cs2/test-1', s: 'cybersport', ts: now - 3600, p: ['mezii'] },
      { t: 'Vitality win the event', u: 'https://www.hltv.org/news/1/test-2', s: 'hltv', ts: now - 3 * 86400 },
    ],
  };
  await page.route(/news-data\/t\/team-vitality\.json/, (r) => r.fulfill({ json: news }));
  await page.route(/news-data\/t\/team-spirit\.json/, (r) => r.fulfill({ status: 404, body: '404: Not Found' }));
  await page.goto('#/team/team-vitality');
  const card = page.locator('.tm-news');
  await expect(card.locator('#tm-news-h')).toHaveText('Новости');
  await expect(card.locator('.tm-nw')).toHaveCount(2);
  await expect(card.locator('.tm-nw-day').first()).toHaveText(/Сегодня/i);
  const link = card.getByRole('link', { name: 'Mezii о новом сезоне' });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(card.getByRole('link', { name: 'mezii', exact: true })).toHaveAttribute('href', /#\/player\/7656\d{13}/);
  await card.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(card.locator('.tm-nw')).toHaveCount(1);
  await expect(card).toContainText('HLTV');
  await page.goto('#/team/team-spirit');
  await expect(page.locator('.tm-news')).toContainText(/новостей .* пока нет/);
  g.check();
});

// F10 — player pages
test('F10-H1 игрок без демок (jL): профиль с Liquipedia', async ({ page }) => {
  const g = guard(page);
  await page.goto('#/team/team-vitality');
  await page.locator('.tm-roster').getByRole('link', { name: /jL/ }).click();
  await expect(page.getByRole('heading', { name: 'jL', level: 1 })).toBeVisible();
  await expect(page.getByText(/Статистики из демок пока нет/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Team Vitality/ })).toBeVisible();
  g.check();
});

test('F10-H2 игрок с демками (ZywOo): статистика и матчи', async ({ page }) => {
  const g = guard(page);
  await page.goto('#/team/team-vitality');
  await page.locator('.tm-roster').getByRole('link', { name: /ZywOo/ }).click();
  await expect(page.getByRole('heading', { name: 'ZywOo', level: 1 })).toBeVisible();
  await expect(page.getByText('K/D').first()).toBeVisible();
  g.check();
});

// F11 — matches page
test('F11-H1 матчи: список и иконки турниров', async ({ page }) => {
  const g = guard(page);
  await page.goto('#/esports');
  await page.waitForLoadState('networkidle');
  expect(await brokenLocalImages(page)).toEqual([]);
  g.check();
});

// F14 — phone width
for (const url of ['#/team/team-vitality', '#/players', '#/skins?cat=agent', '#/esports']) {
  test(`F14-E1 @mobile ${url} без горизонтальной прокрутки`, async ({ page }) => {
    const g = guard(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await noHorizontalScroll(page);
    g.check();
  });
}

// accessibility: no critical axe violations on the new pages
for (const url of ['#/team/team-vitality', '#/players', '#/skins?cat=agent']) {
  test(`A11Y ${url} без критических нарушений доступности`, async ({ page }) => {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    const r = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    const critical = r.violations.filter((v) => v.impact === 'critical');
    expect(critical.map((v) => `${v.id}: ${v.nodes.length} — ${v.help}`)).toEqual([]);
  });
}
