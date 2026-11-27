// Parsers of the «Матчи» data pipeline (scripts/fetch-esports.mjs), on small real-shaped samples.
// HTML samples are trimmed match tickers from Liquipedia (CC BY-SA 3.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMatches, parseTickers, parseTournamentList, parseInfobox, tournamentFromInfobox } from '../scripts/lib/esports/liquipedia.mjs';
import { parseEvents, csSports } from '../scripts/lib/esports/polymarket.mjs';
import { parseFixtures, parseOdds } from '../scripts/lib/esports/oddspapi.mjs';
import { teamKeys, sameTeam, findMatch, summarizeOdds } from '../scripts/lib/esports/teams.mjs';

const FINISHED = `<div class="match-info"><span class="match-info-countdown"><span class="timer-object timer-object-datetime-only" data-format="full" data-timestamp="1793815200" data-finished="finished">November 4, 2026 - 19:00 <abbr data-tz="+01:00" title="Central European Time (UTC+1)">CET</abbr></span></span><div class="match-info-header"><div class="match-info-header-opponent match-info-header-opponent-left match-info-header-winner"><div class="block-team flipped"><span class="name" style="white-space:pre;text-overflow:ellipsis;overflow:hidden"><a href="/counterstrike/RBLS_Gaming" title="RBLS Gaming">RBLS</a></span></div></div><div class="match-info-header-scoreholder"><span class="match-info-header-scoreholder-icon"><i class="fas fa-caret-left"></i></span><span class="match-info-header-scoreholder-scorewrapper"><span class="match-info-header-scoreholder-upper"><span class="match-info-header-scoreholder-score match-info-header-winner">2</span><span class="match-info-header-scoreholder-divider">:</span><span class="match-info-header-scoreholder-score">0</span></span><span class="match-info-header-scoreholder-lower">(Bo3)</span></span><span class="match-info-header-scoreholder-icon"></span></div><div class="match-info-header-opponent match-info-header-loser"><div class="block-team"><span class="name" style="white-space:pre;text-overflow:ellipsis;overflow:hidden"><a href="/counterstrike/index.php?title=Morrow_Esports&amp;action=edit&amp;redlink=1" class="new" title="Morrow Esports (page does not exist)">Morrow</a></span></div></div></div><div class="match-info-tournament"><span></span><span class="match-info-tournament-wrapper"><span class="match-info-tournament-name"><a href="/counterstrike/ESL/Challenger_League/Season_52/Europe/Cup_10#Playoffs" title="ESL/Challenger League/Season 52/Europe/Cup 10"><span>ECL Season 52: EU Cup #10 - Playoffs</span></a></span></span></div><div class="match-info-links"></div></div>`;
const LITERAL = `<div class="match-info"><span class="match-info-countdown"><span class="timer-object" data-format="full" data-timestamp="1794643200">November 14, 2026 - 16:00</span></span><div class="match-info-header"><div class="match-info-header-opponent match-info-header-opponent-left"><div class="brkts-opponent-block-literal flipped">Group A 1<sup>st</sup> Place</div></div><div class="match-info-header-scoreholder"><span class="match-info-header-scoreholder-scorewrapper"><span class="match-info-header-scoreholder-upper">vs</span><span class="match-info-header-scoreholder-lower">(Bo3)</span></span></div><div class="match-info-header-opponent"><div class="brkts-opponent-block-literal">&#8203;</div></div></div><div class="match-info-tournament"><span class="match-info-tournament-name"><a href="/counterstrike/BLAST/Rivals/2026/Fall#Playoffs" title="BLAST/Rivals/2026/Fall"><span>BLAST Rivals Fall 2026 - Playoffs</span></a></span></div><div class="match-info-links"></div></div>`;
const LIVE = `<div class="match-info"><span class="match-info-countdown"><span class="timer-object" data-timestamp="1793946600">November 6, 2026 - 14:30</span></span><div class="match-info-header"><div class="match-info-header-opponent match-info-header-opponent-left"><div class="block-team flipped"><span class="name"><a href="/counterstrike/PARIVISION" title="PARIVISION">PV</a></span></div></div><div class="match-info-header-scoreholder"><span class="match-info-header-scoreholder-scorewrapper"><span class="match-info-header-scoreholder-upper"><span class="match-info-header-scoreholder-score">1</span><span class="match-info-header-scoreholder-divider">:</span><span class="match-info-header-scoreholder-score">0</span></span><span class="match-info-header-scoreholder-lower">(Bo3)</span></span></div><div class="match-info-header-opponent"><div class="block-team"><span class="name"><a href="/counterstrike/Natus_Vincere" title="Natus Vincere">NAVI</a></span></div></div></div><div class="match-info-tournament"><span class="match-info-tournament-name"><a href="/counterstrike/Intel_Extreme_Masters/2026/Beijing#Playoffs" title="Intel Extreme Masters/2026/Beijing"><span>IEM Beijing 2026 - Playoffs</span></a></span></div><div class="match-info-links"><a href="/counterstrike/Special:Stream/twitch/ESLCS" title="Special:Stream/twitch/ESLCS"><span>Watch</span></a><a href="/counterstrike/Special:Stream/youtube/ESLCS" title="Special:Stream/youtube/ESLCS"><span>Watch</span></a></div></div>`;
const html = (tier, type, body) => `<div class="ccx-sec" data-type="${type}" data-tier="${tier}"><div class="">${body}</div></div>`;

test('Liquipedia ticker: finished, live with streams, bracket placeholders', () => {
  const now = 1793950000;
  const ms = parseTickers(html(1, 'upcoming', LIVE + LITERAL) + html(3, 'recent', FINISHED), now);
  assert.equal(ms.length, 3);
  const live = ms.find((m) => m.t1.n === 'PV');
  assert.equal(live.status, 'live');
  assert.equal(live.tier, 'S');
  assert.deepEqual(live.score, [1, 0]);
  assert.equal(live.bo, 3);
  assert.equal(live.tour, 'IEM Beijing 2026');
  assert.equal(live.stage, 'Playoffs');
  assert.equal(live.tpage, 'Intel Extreme Masters/2026/Beijing');
  assert.equal(live.t2.f, 'Natus Vincere');
  assert.deepEqual(live.streams.map((s) => s.p), ['twitch', 'youtube']);
  assert.equal(live.streams[0].u, 'https://www.twitch.tv/ESLCS');

  const done = ms.find((m) => m.t1.n === 'RBLS');
  assert.equal(done.status, 'finished');
  assert.equal(done.tier, 'B');
  assert.deepEqual(done.score, [2, 0]);
  assert.equal(done.winner, 1);
  assert.equal(done.t2.f, 'Morrow Esports');
  assert.equal(done.t2.page, 'Morrow Esports'); // red link → title= parameter
  assert.equal(done.streams, undefined);

  const tbd = ms.find((m) => m.t1.tbd);
  assert.equal(tbd.t1.n, 'Group A 1st Place');
  assert.equal(tbd.t2.n, 'TBD'); // zero-width space only
  assert.equal(tbd.status, 'upcoming');
});

test('Liquipedia new ticker cards preserve Major scores, status, and stage', () => {
  const slot = (team, score, winner = false) =>
    `<div class="match-ticker-card&#95;&#95;opponent${winner ? ' winner' : ''}"><div>${team}</div><div>${score}</div></div>`;
  const team = (short, full) => `<span class="name"><a title="${full}"><div class="team-shortname">${short}</div><div class="team-name">${full}</div></a></span>`;
  const card = (start, stage, opponents, finished = false) => `
    <div class="match-ticker-card">
      <div class="match-ticker-card&#95;&#95;header"><span data-timestamp="${start}"${finished ? ' data-finished="finished"' : ''}></span><div>Round 5 - Bo3</div></div>
      <div class="match-ticker-card&#95;&#95;opponents">${opponents}</div>
      <div class="match-ticker-card-tournament-name"><a title="PGL/2026/Singapore/${stage}">PGL Major Singapore 2026</a></div>
      <a href="/counterstrike/Special:Stream/twitch/PGL">Watch now</a>
    </div>`;
  const live = card(1795780800, 'Stage 1', slot(team('M80', 'M80'), 1) + slot(team('100T', '100 Thieves'), 1));
  const done = card(1795768200, 'Stage 1', slot(team('Imperial', 'Imperial Esports'), 2, true) + slot(team('Wildcard', 'Wildcard'), 1), true);
  const tbd = slot('<span class="team-shortname">TBD</span><span class="team-name">TBD</span>', '');
  const future = card(1796104800, 'Stage 2', tbd + tbd);
  const matches = parseTickers(html(1, 'upcoming', live + future) + html(1, 'recent', done), 1795783957);

  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map((m) => m.status), ['live', 'upcoming', 'finished']);
  assert.equal(matches[0].t2.n, '100T');
  assert.equal(matches[0].t2.f, '100 Thieves');
  assert.equal(matches[0].tier, 'S');
  assert.equal(matches[0].tpage, 'PGL/2026/Singapore/Stage 1');
  assert.equal(matches[0].stage, 'Round 5');
  assert.equal(matches[0].bo, 3);
  assert.deepEqual(matches[0].score, [1, 1]);
  assert.equal(matches[0].streams[0].u, 'https://www.twitch.tv/PGL');
  assert.deepEqual(matches[1].t1, { n: 'TBD', tbd: true });
  assert.deepEqual(matches[2].score, [2, 1]);
  assert.equal(matches[2].winner, 1);
  assert.equal(matches[2].streams, undefined);
});

test('Liquipedia refuses to replace the match feed with an unparseable response', async () => {
  const lp = { call: async () => ({ parse: { text: html(1, 'upcoming', '<div class="unsupported-card">M80</div>') } }) };
  await assert.rejects(fetchMatches(lp, 1795783957), /не удалось разобрать ни одного матча/);
});

test('Liquipedia:Tournaments list and infobox', () => {
  const list = parseTournamentList('*Upcoming\n**PGL/2026/Singapore|PGL Major Singapore 2026|iconfile=x.png\n*Ongoing\n**Intel_Extreme_Masters/2026/Beijing|IEM Beijing 2026|iconfile=y.png\n*Concluded\n**ESL/Pro_League/Season_24|ESL Pro League Season 24');
  assert.deepEqual(list.map((x) => [x.page, x.group]), [['PGL/2026/Singapore', 'upcoming'], ['Intel Extreme Masters/2026/Beijing', 'ongoing'], ['ESL/Pro League/Season 24', 'concluded']]);
  const wt = `{{Infobox league
|name=Intel Extreme Masters Beijing 2026
|tickername=IEM Beijing 2026
|series={{Series|IEM}}
|organizer=[[ESL|ESL FACEIT Group]]
|type=Offline
|country=China
|city=Beijing
|prizepoolusd=1,250,000<ref>source</ref>
|sdate=2026-11-02
|edate=2026-11-08
|liquipediatier=1
|team_number=16
}}
Intro text with {{template|a=b}}.`;
  const t = tournamentFromInfobox(parseInfobox(wt), 'Intel Extreme Masters/2026/Beijing');
  assert.equal(t.name, 'Intel Extreme Masters Beijing 2026');
  assert.equal(t.short, 'IEM Beijing 2026');
  assert.equal(t.tier, 'S');
  assert.equal(t.prize, 1250000);
  assert.equal(t.cur, 'USD');
  assert.equal(t.start, '2026-11-02');
  assert.equal(t.end, '2026-11-08');
  assert.equal(t.city, 'Beijing');
  assert.equal(t.type, 'lan');
  assert.equal(t.teams, 16);
  assert.equal(t.org, 'ESL FACEIT Group');
  const rub = tournamentFromInfobox(parseInfobox('{{Infobox league|name=Moscow Cyber Games 2026|prizepool=15,000,000|localcurrency=rub|liquipediatier=B-Tier|sdate=2026-10-31}}'), 'x');
  assert.equal(rub.prize, 15000000);
  assert.equal(rub.cur, 'RUB');
  assert.equal(rub.tier, 'B');
});

test('Polymarket: open moneyline markets only', () => {
  const now = 1793850000;
  const ev = (over) => ({
    id: '1', title: 'Counter-Strike: Team Vitality vs MOUZ (BO3) - IEM Beijing Playoffs', slug: 'cs2-vit-mouz-2026-11-06', startTime: '2026-11-06T09:00:00Z', closed: false, ended: false, live: false,
    markets: [
      { sportsMarketType: 'moneyline', outcomes: '["Team Vitality", "MOUZ"]', outcomePrices: '["0.62", "0.38"]', gameStartTime: '2026-11-06 09:00:00+00', closed: false, active: true, liquidity: '5000', volume: '12000' },
      { sportsMarketType: 'child_moneyline', outcomes: '["Team Vitality", "MOUZ"]', outcomePrices: '["0.7", "0.3"]', closed: false, active: true, liquidity: '900' },
    ],
    ...over,
  });
  const r = parseEvents([ev({}), ev({ id: '2', ended: true }), ev({ id: '3', markets: [{ sportsMarketType: 'moneyline', outcomes: '["A","B"]', outcomePrices: '["0.5","0.5"]', liquidity: '3', volume: '0' }] })], now);
  assert.equal(r.length, 1);
  assert.equal(r[0].t1, 'Team Vitality');
  assert.equal(r[0].start, Date.parse('2026-11-06T09:00:00Z') / 1000);
  assert.ok(Math.abs(r[0].o[0] - 1 / 0.62) < 1e-9);
  assert.ok(Math.abs(r[0].p[0] + r[0].p[1] - 1) < 1e-9);
  assert.deepEqual(csSports([{ sport: 'cs2', tags: '1,64,100780', series: '10310' }, { sport: 'nba', series: '1' }]).series, ['10310']);
});

test('OddsPapi v4: fixtures and match-winner odds', () => {
  const fx = parseFixtures([
    { fixtureId: 'id1', participant1Name: 'MOUZ', participant2Name: 'Team Vitality', startTime: '2026-11-06T09:00:00.000Z', statusId: 0, tournamentId: 77, tournamentName: 'IEM Beijing' },
    { fixtureId: 'id2', participant1Name: 'A', participant2Name: 'B', startTime: '2026-11-01T09:00:00.000Z', statusId: 2, tournamentId: 77 },
  ]);
  assert.equal(fx.size, 1);
  assert.equal(fx.get('id1').tid, 77);
  const odds = parseOdds([{
    fixtureId: 'id1',
    bookmakerOdds: {
      pinnacle: { bookmakerIsActive: true, markets: { 171: { marketActive: true, outcomes: { 171: { players: { 0: { active: true, price: 2.6 } } }, 172: { players: { 0: { active: true, price: 1.52 } } } } } } },
      demo: { markets: { 171: { outcomes: { 171: { players: { 0: { price: 9 } } }, 172: { players: { 0: { price: 9 } } } } } } },
      stake: { markets: { 171: { outcomes: { 171: { players: { 0: { active: false, price: 2.5 } } }, 172: { players: { 0: { active: true, price: 1.5 } } } } } } },
    },
  }]);
  assert.deepEqual(odds.get('id1'), [{ b: 'pinnacle', o: [2.6, 1.52] }]);
});

test('team matching and odds summary', () => {
  assert.ok(sameTeam(teamKeys('NAVI Jr.', 'Natus Vincere Junior'), teamKeys('NAVI Junior')));
  assert.ok(sameTeam(teamKeys('MongolZ', 'The MongolZ'), teamKeys('The MongolZ')));
  assert.ok(!sameTeam(teamKeys('Vitality', 'Team Vitality'), teamKeys('Vitality Academy')));
  const target = [{ keys1: teamKeys('Vitality', 'Team Vitality'), keys2: teamKeys('MOUZ'), start: 1000 }];
  const hit = findMatch(target, { keys1: teamKeys('MOUZ'), keys2: teamKeys('Team Vitality'), start: 1000 + 3600 });
  assert.equal(hit.swap, true);
  assert.equal(findMatch(target, { keys1: teamKeys('MOUZ'), keys2: teamKeys('Team Vitality'), start: 1000 + 86400 }), null);
  const s = summarizeOdds([{ b: 'pinnacle', o: [1.52, 2.6] }, { b: 'polymarket', o: [1 / 0.62, 1 / 0.38], p: [0.62, 0.38] }]);
  assert.deepEqual(s.best, [1.61, 2.63]);
  assert.deepEqual(s.bestBy, ['polymarket', 'polymarket']);
  assert.equal(s.fav, 0);
  const pinP = (1 / 1.52) / (1 / 1.52 + 1 / 2.6);
  assert.ok(Math.abs(s.prob[0] - (pinP + 0.62) / 2) < 0.001);
});
