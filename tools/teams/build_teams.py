#!/usr/bin/env python3
"""Team pages for the site: every match of a team since 2021 with map scores, titles, maps, form.

    python3 tools/teams/build_teams.py --hist store/matches-hist --out public/data/teams [--from 2021-01-01]

Source: Liquipedia (CC BY-SA 3.0) tournament pages already downloaded by scripts/fetch-matches-hist.mjs
(store matches-hist), parsed by tools/astro/lp_matches.py. Output:
  teams/index.json  { updated, k: { teamKey: slug }, t: [[slug, name, matches, last ts, titles]] }
  teams/<slug>.json { name, page, m: [[ts, opponent, maps won, maps lost, [[map, r, r_opp]…], tournament, tour page,
                                        tier, lan (1/0/null), bo]] newest first, titles: [[ts, tournament, tour page, tier]] }
  teams/need.json   { teams: [names whose logos are wanted], tours: [tournament pages whose icons are wanted],
                      pages: [team pages to read the infobox of] }  — for scripts/fetch-logos.mjs
  teams/people.json { updated, p: { nick: [slug, "YYYY-MM-DD"] } } — the team each player / coach last played a
                      tournament for (TeamCard lineups, last two years): news about a player who just left or
                      retired still reach his team's page (scripts/fetch-news.mjs)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "astro"))
from lp_matches import page_infobox, parse_store  # noqa: E402

FILLER = {"team", "esports", "esport", "e", "sports", "gaming", "clan", "club", "gg"}
MIN_MATCHES = 8          # smaller teams get no page
TITLE_TIERS = {"S", "A", "B"}
MAP_NAMES = {"dust ii": "Dust II", "dust2": "Dust II", "de_dust2": "Dust II"}


def team_keys(name: str) -> list[str]:
    """same as teamKeys() in scripts/build-db.mjs / src/lib/teams.ts"""
    s = unicodedata.normalize("NFKD", str(name).lower())
    s = "".join(c for c in s if not unicodedata.combining(c)).replace("&", " and ")
    words = [w for w in re.split(r"[^a-z0-9]+", s) if w]
    out = []
    for k in ("".join(words), "".join(w for w in words if w not in FILLER)):
        if k and k not in out:
            out.append(k)
    return out


def slug(page: str) -> str:
    s = unicodedata.normalize("NFKD", page.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:60] or "team"


def map_name(m: str) -> str:
    m = (m or "").strip().lower().replace("de_", "")
    return MAP_NAMES.get(m, m.title() if m else "")


TIER_NUM = {"1": "S", "2": "A", "3": "B", "4": "C", "5": "D"}


def page_meta(hist: Path) -> dict[str, dict]:
    """tournament page → {name, tier, tiertype, end} from its own infobox, else tournaments.json"""
    meta = {}
    tl = json.loads((hist / "tournaments.json").read_text())
    for p, x in tl.get("list", {}).items():
        t = x.get("t") or {}
        meta[p] = {"name": (t.get("name") or p).replace("&nbsp;", " "), "tier": t.get("tier") or "", "tiertype": t.get("tiertype") or "", "end": t.get("end") or ""}
    clean = lambda v: re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", r"\1", v or "").replace("&nbsp;", " ").strip()
    for f in (hist / "raw").glob("*.json"):
        j = json.loads(f.read_text())
        for title, c in j.get("titles", {}).items():
            if title in meta:
                continue
            ib = page_infobox(c.get("content") or "")
            if not ib:
                continue
            tier = (ib.get("liquipediatier") or "").strip().lower()
            meta[title] = {"name": clean(ib.get("name")) or title, "tier": TIER_NUM.get(tier, tier[:1].upper()),
                           "tiertype": clean(ib.get("liquipediatiertype")), "end": (re.search(r"\d{4}-\d\d-\d\d", ib.get("edate") or ib.get("date") or "") or [""])[0]}
    return meta


TEAMCARD = re.compile(r"\{\{TeamCard\b(?!\s*columns|Toggle)(.*?)\}\}", re.S)


def last_teams(hist: Path, meta: dict) -> dict[str, tuple[str, str]]:
    """nick → (date, team page) of the latest tournament lineup ({{TeamCard}}) with the player or coach"""
    last: dict[str, tuple[str, str]] = {}
    for f in (hist / "raw").glob("*.json"):
        j = json.loads(f.read_text())
        for title, c in j.get("titles", {}).items():
            end = (meta.get(title) or {}).get("end") or ""
            if not re.fullmatch(r"\d{4}-\d\d-\d\d", end):
                continue
            for m in TEAMCARD.finditer(c.get("content") or ""):
                prm = dict((k, v.strip()) for k, v in re.findall(r"\|\s*([a-z0-9]+)\s*=([^|\n{}]*)", m.group(1)))
                team = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", r"\1", prm.get("team", "")).strip()
                if not team:
                    continue
                for k in ("p1", "p2", "p3", "p4", "p5", "p6", "p7", "c"):
                    nick = prm.get(k, "")
                    if not nick or prm.get(k + "team") or not re.fullmatch(r"[\w.\-]{2,24}", nick):
                        continue  # empty, a stand-in from another team, or not a plain nickname
                    if nick not in last or last[nick][0] < end:
                        last[nick] = (end, team)
    return last


NOT_TITLE = re.compile(r"qualif|stage \d|/stage|group|play-?in|/open(/\d+)?$|closed|showmatch|last chance|decider|swiss|elimination stage|opening stage|challengers stage|legends stage|\brmr\b|/(europe|americas|asia|oceania)\b", re.I)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hist", default="store/matches-hist")
    ap.add_argument("--out", default="public/data/teams")
    ap.add_argument("--from", dest="since", default="2021-01-01")
    a = ap.parse_args()
    hist, out = Path(a.hist), Path(a.out)
    if not (hist / "tournaments.json").exists():
        print(f"нет {hist}/tournaments.json — страницы команд пропущены")
        return
    df, stats = parse_store(hist)
    since = dt.date.fromisoformat(a.since)
    df = df[(df["date"] >= since) & ~df["tiertype"].fillna("").str.contains("show", case=False)]
    meta = page_meta(hist)
    today = dt.date.today()

    def tname(page):
        if page in meta:
            return meta[page]["name"]
        return page.replace("/", " ")

    def event_of(page):
        # «X/Playoffs», «X/Main Event» are the final part of the event X
        return re.sub(r"/(Playoffs|Playoff Stage|Main Event|Finals?|Final Stage|Champions Stage)$", "", page)

    # ---- titles: the winner of the last match of a finished main event (or its playoffs page) ----
    titles = defaultdict(list)
    seen_events = set()
    for page, g in sorted(df.groupby("tour"), key=lambda x: -x[1]["ts"].max()):
        ev = event_of(page)
        m, me = meta.get(page) or {}, meta.get(ev) or {}
        tier = m.get("tier") or me.get("tier")
        tt = (m.get("tiertype") or me.get("tiertype") or "").lower()
        if ev in seen_events or tier not in TITLE_TIERS or "qualif" in tt or "show" in tt or NOT_TITLE.search(page) or NOT_TITLE.search(m.get("name") or ""):
            continue
        end = m.get("end") or me.get("end") or ""
        if not re.fullmatch(r"\d{4}-\d\d-\d\d", end) or dt.date.fromisoformat(end) >= today:
            continue
        last = g.sort_values("ts").iloc[-1]
        if abs((last["date"] - dt.date.fromisoformat(end)).days) > 3:
            continue  # the bracket is not complete in the data
        seen_events.add(ev)
        champ = last["t1"] if last["winner"] == 1 else last["t2"]
        titles[champ].append([int(last["ts"]), tname(ev) if ev in meta else re.sub(r":\s*Playoffs$", "", tname(page)), ev, tier])

    # ---- per team ----
    rows = defaultdict(list)
    for r in df.itertuples(index=False):
        lan = None if r.lan is None or r.lan != r.lan else int(bool(r.lan))
        maps = [[map_name(n), m[0], m[1]] for n, m in zip(r.mapnames, r.maps)] if len(r.mapnames) == len(r.maps) else [["", m[0], m[1]] for m in r.maps]
        for us, them, su, sv, flip in ((r.t1, r.t2, r.s1, r.s2, False), (r.t2, r.t1, r.s2, r.s1, True)):
            mm = [[n, b, a] for n, a, b in maps] if flip else maps
            rows[us].append([int(r.ts), them, int(su), int(sv), mm, tname(r.tour), r.tour, r.tier or "", lan, int(r.bo) if r.bo == r.bo and r.bo else None])

    # display names from the team templates ({{Team|id}} → page / short name) for matching VRS / matches-page names
    alias = defaultdict(set)
    tpl = json.loads((hist / "teams.json").read_text()).get("ids", {}) if (hist / "teams.json").exists() else {}
    for tid, html in tpl.items():
        m = re.search(r'team-template-text">\[\[([^|\]]+)(?:\|([^\]]+))?\]\]', html or "")
        if m:
            alias[m.group(1).strip()].update(x for x in (m.group(2), tid) if x)

    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*.json"):
        f.unlink()
    index, keys = [], {}
    need_teams, need_pages, need_tours = set(), [], set()
    for team, ms in sorted(rows.items(), key=lambda x: -len(x[1])):
        if len(ms) < MIN_MATCHES:
            continue
        ms.sort(key=lambda x: -x[0])
        s = slug(team)
        while any(i[0] == s for i in index):
            s += "-2"
        tl = sorted(titles.get(team, []), key=lambda x: -x[0])
        (out / f"{s}.json").write_text(json.dumps({"name": team, "page": team, "m": ms, "titles": tl}, ensure_ascii=False, separators=(",", ":")))
        index.append([s, team, len(ms), ms[0][0], len(tl)])
        for n in [team, *alias.get(team, ())]:
            for k in team_keys(n):
                keys.setdefault(k, s)
        need_pages.append(team)
        recent = [m for m in ms if m[0] >= ms[0][0] - 400 * 86400]
        if len(ms) >= 20:
            need_teams.add(team)
            need_teams.update(m[1] for m in recent)
            need_tours.update(m[6] for m in recent[:60])
            need_tours.update(t[2] for t in tl)
    (out / "index.json").write_text(json.dumps({"updated": dt.datetime.now(dt.timezone.utc).isoformat(), "src": "Liquipedia (CC BY-SA 3.0)", "k": keys, "t": index}, ensure_ascii=False, separators=(",", ":")))
    since_people = (today - dt.timedelta(days=730)).isoformat()
    people = {}
    for nick, (end, team) in sorted(last_teams(hist, meta).items()):
        sl = next((keys[k] for k in team_keys(team) if k in keys), None)
        if sl and end >= since_people:
            people[nick] = [sl, end]
    (out / "people.json").write_text(json.dumps({"updated": dt.datetime.now(dt.timezone.utc).isoformat(), "src": "Liquipedia (CC BY-SA 3.0)", "p": people}, ensure_ascii=False, separators=(",", ":")))
    (out / "need.json").write_text(json.dumps({"teams": sorted(need_teams), "tours": sorted(need_tours), "pages": need_pages[:400]}, ensure_ascii=False))
    print(f"команды: {len(index)} страниц, матчей с {a.since}: {len(df)}, титулов: {sum(len(v) for v in titles.values())}, игроков с последней командой: {len(people)}; разбор: {stats}")


if __name__ == "__main__":
    main()
