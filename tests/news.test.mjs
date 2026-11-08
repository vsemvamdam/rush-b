// «Новости» on team pages (scripts/fetch-news.mjs): feed parsing and which teams a headline is about.
// Feeds in tests/fixtures/news are small made-up samples shaped like the real ones; the team data there is a
// trimmed copy of public/data (teams/index.json, teams/info.json, rankings.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseDate, parseFeed, readFeed, plain } from '../scripts/lib/news/rss.mjs';
import { buildCatalog, matchItem } from '../scripts/lib/news/match.mjs';
import { SOURCES } from '../scripts/lib/news/sources.mjs';

const FIX = path.join(import.meta.dirname, 'fixtures', 'news');
const data = (f) => JSON.parse(fs.readFileSync(path.join(FIX, 'data', f), 'utf8'));
const NOW = 1794132000; // 2026-11-08
const catalog = buildCatalog(data('teams/index.json'), data('teams/info.json'), data('rankings.json'), NOW);
const teams = (title, lang = 'ru', desc = '') => matchItem({ title, desc }, lang, catalog);

test('dates: RFC 822 with two-digit years, zones, ISO', () => {
  assert.equal(parseDate('Sun, 08 Nov 26 12:31:00 +0300'), Date.UTC(2026, 10, 8, 9, 31) / 1000);
  assert.equal(parseDate('Sun, 08 Nov 2026 09:00:00 GMT'), Date.UTC(2026, 10, 8, 9, 0) / 1000);
  assert.equal(parseDate('Sat, 7 Nov 2026 19:32:00 -0500'), Date.UTC(2026, 10, 8, 0, 32) / 1000);
  assert.equal(parseDate('2026-11-08T10:00:00Z'), Date.UTC(2026, 10, 8, 10, 0) / 1000);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('вчера'), null);
});

test('feed parsing: CDATA, double-encoded entities, tags inside descriptions, categories, Atom', () => {
  const items = parseFeed(fs.readFileSync(path.join(FIX, 'cybersport.xml'), 'utf8'));
  assert.equal(items.length, 4);
  assert.equal(items[0].title, 'Chopper объявил о завершении карьеры игрока');
  assert.equal(items[0].desc, 'Бывший капитанTeam SpiritЛеонид chopper Вишняков завершил карьеру.');
  assert.equal(items[1].desc, 'Игрок составаNatus Vincereпо CS2 оценил выступление.');
  const sp = parseFeed(fs.readFileSync(path.join(FIX, 'sportsru.xml'), 'utf8'));
  assert.deepEqual(sp.map((x) => x.cats[0]), ['CS 2', 'Ставки', 'Dota 2']);
  assert.equal(plain('Tom &amp;amp; Jerry &lt;b&gt;x&lt;/b&gt;'), 'Tom & Jerry x');
  const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">A &amp; B</title><link rel="alternate" href="https://example.com/a?x=1&amp;y=2"/><id>urn:1</id><published>2026-11-08T10:00:00Z</published><summary>s</summary><category term="CS2"/></entry></feed>`);
  assert.deepEqual(atom, [{ title: 'A & B', link: 'https://example.com/a?x=1&y=2', guid: 'urn:1', desc: 's', cats: ['CS2'], ts: Date.UTC(2026, 10, 8, 10) / 1000 }]);
  assert.throws(() => readFeed('<html><body>Just a moment...</body></html>'), /не RSS/);
});

test('sources keep only CS2 from mixed feeds', () => {
  const keep = (key, file) => parseFeed(fs.readFileSync(path.join(FIX, file), 'utf8')).filter(SOURCES.find((s) => s.key === key).keep).map((x) => x.link);
  assert.deepEqual(keep('cybersport', 'cybersport.xml').map((u) => u.split('/').pop()), ['test-chopper-zavershil-kareru', 'test-b1t', 'test-recap']);
  assert.deepEqual(keep('sportsru', 'sportsru.xml'), ['https://cyber.sports.ru/cs/1-test-donk.html']);
});

test('catalog: active teams, press names, rosters', () => {
  assert.ok(catalog.teams['team-spirit'] && !catalog.teams['old-team'], 'teams without matches for a year are left out');
  const forms = new Map(catalog.forms.map((x) => [x[0], x[1]]));
  assert.equal(forms.get('Spirit'), 'team-spirit');
  assert.equal(forms.get('NAVI'), 'natus-vincere');
  assert.equal(forms.get('BETBOOM TEAM'), 'betboom-team');
  assert.equal(forms.get('Spirit Academy'), 'team-spirit-academy');
  const nicks = new Map(catalog.nicks);
  assert.equal(nicks.get('donk'), 'team-spirit');
  assert.equal(nicks.get('hally'), 'team-spirit'); // coach
  assert.equal(nicks.get('xertioN'), 'mouz'); // Valve ranking roster
  assert.equal(nicks.has('iM'), false); // two letters — too short to find in text
  assert.equal(nicks.has('PR'), false);
});

test('headlines in Russian: team names and nicknames, Latin inside Cyrillic', () => {
  assert.deepEqual(teams('Chopper завершил карьеру: «Vega и Spirit для меня стали больше, чем клубами»'), { 'team-spirit': {} });
  assert.deepEqual(teams('Chopper официально покинул Team Spirit'), { 'team-spirit': {} });
  assert.deepEqual(teams('Team Spirit Academy вышла в финал'), { 'team-spirit-academy': {} });
  assert.deepEqual(teams('Donk о подготовке'), { 'team-spirit': { p: ['donk'] } });
  assert.deepEqual(teams('B1t об IEM Beijing 2026'), { 'natus-vincere': { p: ['b1t'] } });
  assert.deepEqual(teams('Natus Vincere обыграли BETBOOM TEAM'), { 'natus-vincere': {}, 'betboom-team': {} });
  assert.deepEqual(teams('Игрок показал ADR 95'), {});
  assert.deepEqual(teams('HyperSpirit сыграет на турнире'), {}); // part of another word
  // the description adds a team only when it names few of them
  assert.deepEqual(teams('Интервью с капитаном', 'ru', 'Капитан составаNatus Vincereпо CS2 ответил на вопросы'), { 'natus-vincere': { w: 1 } });
  assert.deepEqual(teams('Итоги дня', 'ru', 'MOUZ, FURIA, NAVI и The MongolZ сыграли'), {});
});

test('headlines in English: plain words are not team names', () => {
  assert.deepEqual(teams('chopper announces retirement', 'en', 'The former Spirit in-game leader calls time on his career.'), { 'team-spirit': { w: 1 } });
  assert.deepEqual(teams('Echo of a legacy: what the big Major changes mean', 'en'), {});
  assert.deepEqual(teams('Legacy and BIG advance', 'en'), { legacy: {}, big: {} });
  assert.deepEqual(teams('donk and ZywOo top the ranking', 'en'), { 'team-vitality': { p: ['ZywOo'] } }); // lowercase nick = maybe a word
  assert.deepEqual(teams('Team Spirit sign a coach', 'en'), { 'team-spirit': {} });
});

test('fetch-news: feeds → per-team files, state carried between runs, a broken feed does not stop the rest', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'news-'));
  const run = (prev, out) => execFileSync(process.execPath, ['scripts/fetch-news.mjs', '--prev', prev, '--out', out, '--data', path.join(FIX, 'data'), '--feeds', FIX], { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8' });
  const log1 = run(path.join(tmp, 'none'), path.join(tmp, 'a'));
  assert.match(log1, /Dust2\.us: ОШИБКА/);
  const spirit = JSON.parse(fs.readFileSync(path.join(tmp, 'a', 't', 'team-spirit.json'), 'utf8'));
  assert.deepEqual(spirit.items.map((x) => [x.s, x.t]), [
    ['cybersport', 'Chopper объявил о завершении карьеры игрока'],
    ['sportsru', 'Donk рассказал о подготовке к мейджору'],
    ['hltv', 'chopper announces retirement'],
  ]);
  assert.ok(spirit.items.every((x) => /^https:\/\//.test(x.u) && x.ts > 1794000000 && !('desc' in x)));
  assert.deepEqual(spirit.src.hltv, ['HLTV', 'en']);
  const all = JSON.parse(fs.readFileSync(path.join(tmp, 'a', 'all.json'), 'utf8'));
  assert.equal(all.items.length, 6);
  assert.equal(all.sources.dust2us.ok, false);
  assert.ok(!JSON.stringify(all).includes('Вишняков'), 'descriptions are not published');
  const log2 = run(path.join(tmp, 'a'), path.join(tmp, 'b'));
  assert.match(log2, /новых 0, всего 6/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
