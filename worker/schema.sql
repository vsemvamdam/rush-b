-- ladder of every profile looked up on the site (refreshed by the cron trigger)
CREATE TABLE IF NOT EXISTS profiles (
  steamid TEXT PRIMARY KEY,
  name TEXT, avatar TEXT, country TEXT,
  level INTEGER, xp INTEGER, badges INTEGER,
  games INTEGER, playtime INTEGER,       -- minutes in all games
  cs2 INTEGER, cs2_2w INTEGER,           -- minutes in CS2 (total, last two weeks)
  created INTEGER,                       -- account creation, unix seconds
  vac INTEGER, visible INTEGER,
  updated INTEGER, added INTEGER
);
CREATE INDEX IF NOT EXISTS p_xp ON profiles(xp DESC);
CREATE INDEX IF NOT EXISTS p_games ON profiles(games DESC);
CREATE INDEX IF NOT EXISTS p_playtime ON profiles(playtime DESC);
CREATE INDEX IF NOT EXISTS p_cs2 ON profiles(cs2 DESC);
CREATE INDEX IF NOT EXISTS p_badges ON profiles(badges DESC);
CREATE INDEX IF NOT EXISTS p_created ON profiles(created ASC);
CREATE INDEX IF NOT EXISTS p_updated ON profiles(updated ASC);
-- one snapshot per profile per day → level / XP / hours charts
CREATE TABLE IF NOT EXISTS history (
  steamid TEXT, day INTEGER,
  level INTEGER, xp INTEGER, games INTEGER, playtime INTEGER, cs2 INTEGER,
  PRIMARY KEY (steamid, day)
);
-- small key → value store: «servers» = the latest Cybershoke list posted by the relay (tools/cybershoke-relay)
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL);
