// News feeds for the «Новости» column on team pages. Only headlines and links are published;
// descriptions are read to find the teams a story is about and then dropped.
// keep(item) — the CS2 part of a feed that also covers other games.

export const SOURCES = [
  {
    key: 'cybersport',
    name: 'Cybersport.ru',
    lang: 'ru',
    url: 'https://www.cybersport.ru/rss/materials',
    keep: (it) => /cybersport\.ru\/tags\/(cs2|cs-go|csgo|counter-strike)\//.test(it.link),
  },
  {
    key: 'sportsru',
    name: 'Sports.ru',
    lang: 'ru',
    url: 'https://cyber.sports.ru/rss/topnews.xml',
    keep: (it) => /sports\.ru\/cs\//.test(it.link) || it.cats.some((c) => /^(cs\s?2|cs:?go|counter[- ]strike)/i.test(c)),
  },
  {
    key: 'hltv',
    name: 'HLTV',
    lang: 'en',
    url: 'https://www.hltv.org/rss/news',
    keep: () => true,
  },
  {
    key: 'dust2us',
    name: 'Dust2.us',
    lang: 'en',
    url: 'https://www.dust2.us/rss',
    keep: () => true,
  },
];
