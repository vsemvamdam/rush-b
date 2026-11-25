#!/usr/bin/env python3
"""Собирает из всех разобранных про-демок данные для сайта: библиотеку раскидок, коллауты
и профили игроков.

Вход:  store/nades-raw/<demo>.json — броски, позиции и статистика каждой демки (пишет opencs2.py)
Выход (по умолчанию store/nades-site/, оттуда workflow копирует в public/data/):
  nades/<map>.json        — раскидки (повторяющиеся броски), формат v3:
      { v: 3, map, updated, demos, throws, players: [[name, team]], matches: [[match, event, date, url]],
        targets: [[type, x, y, z, place, n]],
        lineups: [ { id, t, type, side, n, np, from:[x,y,z], ang:[pitch,yaw], land:[x,y,z], pf, pl,
                     move, moves:{...}, btn, dur, time, traj:[[x,y,z],...], ex:[[player, match, round], ...] } ] }
  nades/x/<map>/<h>.json  — броски каждого игрока по раскидкам (для 3D-повтора конкретного броска):
      { <lineup id>: [[player, match, round, time, move, btn, fx, fy, fz, pitch, yaw, lx, ly, lz, dur, traj], ...] }
  nades/index.json
  callouts/<map>.json     — сетка позиций игроков с официальным названием места (m_szLastPlaceName)
  players/index.json, players/<steamid>.json — статистика и прицелы игроков из демок

«Раскидка» = броски одного типа и стороны с одной точки (±56 юнитов) в одну точку (±96 юнитов).
Броски, встретившиеся за всю базу один раз, считаются ситуативными (кроме --keep-single).

  python3 tools/demos/build_lineups.py [--out store/nades-site] [--keep-single]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import time
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "store" / "nades-raw"
PLACES = RAW / "_places"  # aggregated callout samples per map (raw files are stripped after merging)
SEED = Path(__file__).resolve().parent / "seed"  # first demos committed to git (old format), merged into RAW
FROM_R, LAND_R, CELL = 56.0, 96.0, 64.0
TARGET_R = 128.0
MAX_EX = 12          # examples listed in the map file (all of a lineup's players/matches are in pp/ms)
MIN_N = 3            # a throw seen fewer times is situational, not a lineup
MAX_DETAIL = 30
RAW_VERSION = 3
PLACE_CELL = 64.0


def web_url(u) -> str:
    """Match page link for the site: only http(s). The links come with the demo archive (a third-party dataset)
    and end up in href on the pages, so anything else («javascript:…», data:, plain text) is dropped."""
    u = str(u or "").strip()
    return u if re.match(r"https?://[^\s/?#]", u, re.I) and not re.search(r"[\s<>\"']", u) else ""


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def run_forward(r):
    """Player's speed along the aim direction at the release, estimated from the first trajectory step
    (grenade velocity = aim * 675 * lerp(0.3, 1, strength) + 1.25 * player velocity). Per throw it is noisy
    (standing throws come out at about -20 ± 40 u/s), the median of a lineup is reliable: walking 60–160,
    running 150–250. It tells a plain jump-throw from one with W held — extract_nades classifies the
    movement by speed > 135 only, so W-jump-throws that start from a standstill were labelled «в прыжке»."""
    tr, dur = r.get("traj") or [], r.get("dur") or 0
    if len(tr) < 3 or len(tr[0]) < 3 or not dur:
        return None
    dt = dur / (len(tr) - 1)
    gvx, gvy = (tr[1][0] - tr[0][0]) / dt, (tr[1][1] - tr[0][1]) / dt
    p = r["pitch"] - 360 if r["pitch"] > 180 else r["pitch"]
    p -= (90 - abs(p)) * 10 / 90  # the game lifts the throw angle
    yaw = math.radians(r["yaw"])
    k = {"L": 1.0, "LR": 0.5, "R": 0.0}.get(r.get("btn") or "L", 1.0)
    v = 675 * (0.3 + 0.7 * k)
    fx, fy = math.cos(math.radians(p)) * math.cos(yaw), math.cos(math.radians(p)) * math.sin(yaw)
    pvx, pvy = (gvx - fx * v) / 1.25, (gvy - fy * v) / 1.25
    return pvx * math.cos(yaw) + pvy * math.sin(yaw)


def write_raw(out: Path, mp: str, meta: dict, throws: list, places=None, players=None):
    """compact per-demo file (format rv=3): throws as arrays, trajectory ≤20 points uniform in time (x, y, z)"""
    rows = []
    for t in throws:
        tr = t.get("traj") or []
        if len(tr) > 20:
            step = (len(tr) - 1) / 19
            tr = [tr[round(i * step)] for i in range(20)]
        rows.append([
            t["player"], t.get("team") or t["side"], t["side"], t["type"], t.get("round", 0), round(t.get("time") or 0, 1),
            round(t["throw"]["x"], 1), round(t["throw"]["y"], 1), round(t["throw"]["z"], 1),
            round(t["throw"]["pitch"], 2), round(t["throw"]["yaw"], 2),
            round(t["land"]["x"], 1), round(t["land"]["y"], 1), round(t["land"]["z"], 1),
            t.get("move", ""), [[round(p[0]), round(p[1]), round(p[2])] for p in tr if len(p) >= 3],
            t.get("place") or "", t.get("btn") or "", t.get("dur") or 0,
        ])
    obj = {"rv": RAW_VERSION, "map": mp, **meta, "rows": rows}
    if places:
        obj["places"] = places
    if players:
        obj["players"] = players
    write_json(out, obj)


class Cluster:
    __slots__ = ("type", "side", "fx", "fy", "lx", "ly", "items")

    def __init__(self, typ, side, r):
        self.type, self.side = typ, side
        self.fx, self.fy, self.lx, self.ly = r["fx"], r["fy"], r["lx"], r["ly"]
        self.items = [r]

    def add(self, r):
        self.items.append(r)
        k = len(self.items)
        self.fx += (r["fx"] - self.fx) / k
        self.fy += (r["fy"] - self.fy) / k
        self.lx += (r["lx"] - self.lx) / k
        self.ly += (r["ly"] - self.ly) / k


# --------------------------------------------------------------------------- #
# callouts: player position samples → place names
# --------------------------------------------------------------------------- #
class PlaceGrid:
    def __init__(self, mp):
        self.mp = mp
        self.path = PLACES / f"{mp}.json"
        self.cells: dict[tuple, Counter] = defaultdict(Counter)
        self.demos: set[str] = set()
        if self.path.exists():
            d = json.loads(self.path.read_text(encoding="utf-8"))
            names = d["names"]
            for cx, cy, cz, i, n in d["cells"]:
                self.cells[(cx, cy, cz)][names[i]] += n
            self.demos = set(d.get("demos", []))

    def add_samples(self, key, samples):
        if key in self.demos:
            return
        for cx, cy, cz, pl, n in samples:
            self.cells[(cx, cy, cz)][pl] += n
        self.demos.add(key)

    def add_point(self, x, y, z, pl, w=1):
        if pl:
            self.cells[(math.floor(x / PLACE_CELL), math.floor(y / PLACE_CELL), math.floor(z / PLACE_CELL))][pl] += w

    def save(self):
        names = sorted({pl for c in self.cells.values() for pl in c})
        idx = {n: i for i, n in enumerate(names)}
        cells = [[cx, cy, cz, idx[pl], n] for (cx, cy, cz), c in self.cells.items() for pl, n in c.items()]
        write_json(self.path, {"names": names, "cells": cells, "demos": sorted(self.demos)})

    def majority(self):
        return {k: c.most_common(1)[0] for k, c in self.cells.items() if c}

    def lookup(self, x, y, z, maj=None):
        """place name at a point: the closest sampled cell (same level preferred, then below)"""
        maj = maj if maj is not None else self.majority()
        cx, cy, cz = math.floor(x / PLACE_CELL), math.floor(y / PLACE_CELL), math.floor(z / PLACE_CELL)
        best, bd = "", 1e9
        for r in range(0, 4):
            for dz in (0, -1, 1, -2, -3):
                for dx in range(-r, r + 1):
                    for dy in range(-r, r + 1):
                        if max(abs(dx), abs(dy)) != r:
                            continue
                        m = maj.get((cx + dx, cy + dy, cz + dz))
                        if not m:
                            continue
                        d = math.hypot(dx, dy) + abs(dz) * 1.5 - min(m[1], 50) / 200
                        if d < bd:
                            best, bd = m[0], d
            if best:
                return best
        return best


def build_callouts(grid: PlaceGrid):
    maj = grid.majority()
    names = sorted({m[0] for m in maj.values()})
    idx = {n: i for i, n in enumerate(names)}
    cells = [[cx, cy, cz, idx[m[0]]] for (cx, cy, cz), m in maj.items() if m[1] >= 2]
    # label positions: weighted centroid of the biggest connected blob of each place
    centers = {}
    by_place = defaultdict(list)
    for (cx, cy, cz), m in maj.items():
        if m[1] >= 2:
            by_place[m[0]].append((cx, cy, cz, m[1]))
    for pl, cs in by_place.items():
        sx = sum((c[0] + 0.5) * c[3] for c in cs)
        sy = sum((c[1] + 0.5) * c[3] for c in cs)
        sz = sum((c[2] + 0.5) * c[3] for c in cs)
        w = sum(c[3] for c in cs)
        mx, my, mz = sx / w, sy / w, sz / w
        # snap to the sampled cell nearest to the centroid (centroid of an L-shaped area can lie outside it)
        nx = min(cs, key=lambda c: (c[0] + 0.5 - mx) ** 2 + (c[1] + 0.5 - my) ** 2)
        if (nx[0] + 0.5 - mx) ** 2 + (nx[1] + 0.5 - my) ** 2 > 4:
            mx, my, mz = nx[0] + 0.5, nx[1] + 0.5, nx[2] + 0.5
        centers[pl] = [round(mx * PLACE_CELL), round(my * PLACE_CELL), round(mz * PLACE_CELL), len(cs)]
    return {"map": grid.mp, "updated": now(), "cell": PLACE_CELL, "demos": len(grid.demos), "names": names,
            "centers": centers, "cells": cells}


# --------------------------------------------------------------------------- #
def load_raws():
    RAW.mkdir(parents=True, exist_ok=True)
    for f in SEED.glob("*.json"):
        if not (RAW / f.name).exists():
            (RAW / f.name).write_bytes(f.read_bytes())
    best = {}
    for f in sorted(RAW.glob("*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        d["_file"] = f
        key = (d.get("demo") or f.stem, d.get("url") or f"{d.get('event')}|{d.get('date')}")
        cur = best.get(key)
        if cur is None or d.get("rv", 2) > cur.get("rv", 2):
            best[key] = d
    return list(best.values())


def build(out_dir: Path, keep_single=False):
    demos_all = load_raws()
    per_map = defaultdict(list)
    for d in demos_all:
        per_map[d["map"]].append(d)
    nades_dir = out_dir / "nades"
    if nades_dir.exists():
        shutil.rmtree(nades_dir)
    index = []
    pstats: dict[str, dict] = {}
    for mp, demos in sorted(per_map.items()):
        grid = PlaceGrid(mp)
        for d in demos:
            if d.get("places"):
                grid.add_samples(f"{d.get('demo')}|{d.get('url')}", d["places"])
                # strip merged samples from the raw file to keep the store small
                f = d.pop("_file")
                d.pop("places")
                write_json(f, d)
                d["_file"] = f
        players, pidx = [], {}
        matches, midx = [], {}
        rows = []
        for d in demos:
            mk = (d.get("match", ""), d.get("event", ""), d.get("date", ""), web_url(d.get("url")))
            if mk not in midx:
                midx[mk] = len(matches)
                matches.append(list(mk))
            mi = midx[mk]
            for r in d["rows"]:
                pk = (r[0], r[1])
                if pk not in pidx:
                    pidx[pk] = len(players)
                    players.append([r[0], r[1]])
                row = {"p": pidx[pk], "m": mi, "side": r[2], "type": r[3], "round": r[4], "time": r[5],
                       "fx": r[6], "fy": r[7], "fz": r[8], "pitch": r[9], "yaw": r[10],
                       "lx": r[11], "ly": r[12], "lz": r[13], "move": r[14], "traj": r[15],
                       "pf": r[16] if len(r) > 16 else "", "btn": r[17] if len(r) > 17 else "", "dur": r[18] if len(r) > 18 else 0}
                rows.append(row)
                if row["pf"] and len(grid.demos) < 3:
                    grid.add_point(row["fx"], row["fy"], row["fz"], row["pf"])
            for p in d.get("players") or []:
                s = pstats.setdefault(p["sid"], {"sid": p["sid"], "names": Counter(), "teams": Counter(), "xh": {}, "maps": Counter(),
                                                 "games": [], **{k: 0 for k in ("k", "d", "a", "hs", "dmg", "ud", "fk", "fd", "fa", "awp", "rounds")}})
                s["names"][p["name"]] += 1
                if p.get("team"):
                    s["teams"][p["team"]] += 1
                if p.get("xhair"):
                    s["xh"][d.get("date") or ""] = p["xhair"]
                s["maps"][mp] += 1
                for k in ("k", "d", "a", "hs", "dmg", "ud", "fk", "fd", "fa", "awp", "rounds"):
                    s[k] += int(p.get(k) or 0)
                s["games"].append([d.get("date", ""), mp.replace("de_", ""), d.get("match", ""), d.get("event", ""), web_url(d.get("url")),
                                   p.get("team", ""), p["k"], p["d"], p["a"], round(p["dmg"] / max(p["rounds"], 1), 1), p["rounds"]])
        grid.save()
        maj = grid.majority()
        # greedy clustering with a spatial hash on the throw position
        clusters: list[Cluster] = []
        cgrid = defaultdict(list)
        for r in sorted(rows, key=lambda r: (r["type"], r["side"], r["fx"], r["fy"])):
            cx, cy = int(r["fx"] // CELL), int(r["fy"] // CELL)
            best, bd = None, 1e18
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for c in cgrid[(r["type"], r["side"], cx + dx, cy + dy)]:
                        df = math.hypot(c.fx - r["fx"], c.fy - r["fy"])
                        dl = math.hypot(c.lx - r["lx"], c.ly - r["ly"])
                        if df <= FROM_R and dl <= LAND_R and df + dl < bd:
                            best, bd = c, df + dl
            if best:
                best.add(r)
            else:
                c = Cluster(r["type"], r["side"], r)
                clusters.append(c)
                cgrid[(r["type"], r["side"], cx, cy)].append(c)
        lineups = []
        details = defaultdict(dict)
        for c in clusters:
            n = len(c.items)
            if n < MIN_N and not keep_single:
                continue
            # representative: prefer throws with a 3D trajectory, then the one closest to the cluster centre
            rep = min(c.items, key=lambda r: (0 if (r["traj"] and len(r["traj"][0]) >= 3) else 1,
                                              math.hypot(r["fx"] - c.fx, r["fy"] - c.fy) + math.hypot(r["lx"] - c.lx, r["ly"] - c.ly)))
            moves = Counter(r["move"] for r in c.items)
            btns = Counter(r["btn"] for r in c.items if r["btn"])
            durs = sorted(r["dur"] for r in c.items if r["dur"])
            fws = sorted(f for f in (run_forward(r) for r in c.items) if f is not None)
            times = sorted(r["time"] for r in c.items)
            ex_all = sorted(c.items, key=lambda r: (-r["m"], r["round"]))
            ex = ex_all[:MAX_EX]
            lid = hashlib.sha1(f"{mp}|{c.type}|{c.side}|{round(rep['fx'])}|{round(rep['fy'])}|{round(rep['lx'])}|{round(rep['ly'])}".encode()).hexdigest()[:10]
            pf = Counter(r["pf"] for r in c.items if r["pf"]).most_common(1)
            pf = pf[0][0] if pf else (grid.lookup(rep["fx"], rep["fy"], rep["fz"], maj) if maj else "")
            pl = grid.lookup(c.lx, c.ly, rep["lz"], maj) if maj else ""
            lineups.append({
                "id": lid, "type": c.type, "side": c.side, "n": n, "np": len({r["p"] for r in c.items}),
                "from": [rep["fx"], rep["fy"], rep["fz"]], "ang": [rep["pitch"], rep["yaw"]],
                "land": [round(c.lx, 1), round(c.ly, 1), rep["lz"]], "pf": pf, "pl": pl,
                "move": moves.most_common(1)[0][0], "moves": dict(moves),
                "btn": btns.most_common(1)[0][0] if btns else "", "dur": durs[len(durs) // 2] if durs else 0,
                **({"fw": round(fws[len(fws) // 2])} if len(fws) >= 3 else {}),
                "time": times[len(times) // 2], "traj": rep["traj"], "ex": [[r["p"], r["m"], r["round"]] for r in ex],
                "pp": sorted({r["p"] for r in c.items}), "ms": sorted({r["m"] for r in c.items}),
            })
            details[lid[0]][lid] = [[r["p"], r["m"], r["round"], r["time"], r["move"], r["btn"], r["fx"], r["fy"], r["fz"],
                                     r["pitch"], r["yaw"], r["lx"], r["ly"], r["lz"], r["dur"], r["traj"]] for r in ex_all[:MAX_DETAIL]]
        lineups.sort(key=lambda l: -l["n"])
        # targets: lineups of one type landing in (almost) the same spot, from any position/side
        targets = []
        tgrid = defaultdict(list)
        for l in lineups:
            k = (l["type"], int(l["land"][0] // TARGET_R), int(l["land"][1] // TARGET_R))
            hit = None
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for ti in tgrid[(l["type"], k[1] + dx, k[2] + dy)]:
                        t = targets[ti]
                        if math.hypot(t[1] - l["land"][0], t[2] - l["land"][1]) <= TARGET_R and abs(t[3] - l["land"][2]) < 160:
                            hit = ti
                            break
            if hit is None:
                hit = len(targets)
                targets.append([l["type"], l["land"][0], l["land"][1], l["land"][2], l["pl"], 0])
                tgrid[k].append(hit)
            targets[hit][5] += l["n"]
            l["t"] = hit
        out = {"v": 3, "map": mp, "updated": now(), "demos": len(demos), "throws": len(rows),
               "players": players, "matches": matches, "targets": targets, "lineups": lineups}
        write_json(nades_dir / f"{mp}.json", out)
        for h, dd in details.items():
            write_json(nades_dir / "x" / mp / f"{h}.json", dd)
        write_json(out_dir / "callouts" / f"{mp}.json", build_callouts(grid))
        index.append({"map": mp, "demos": len(demos), "throws": len(rows), "lineups": len(lineups), "targets": len(targets)})
        print(f"{mp}: {len(demos)} демок, {len(rows)} бросков → {len(lineups)} раскидок, {len(targets)} точек; коллауты: {len(grid.demos)} демок")
    write_json(nades_dir / "index.json", {"updated": now(), "maps": index})
    write_players(out_dir / "players", pstats)


def write_players(out: Path, pstats: dict):
    if out.exists():
        shutil.rmtree(out)
    rows = []
    for sid, s in pstats.items():
        name = s["names"].most_common(1)[0][0]
        games = sorted(s["games"], reverse=True)
        team = games[0][5] if games and games[0][5] else (s["teams"].most_common(1)[0][0] if s["teams"] else "")
        xh = s["xh"][max(s["xh"])] if s["xh"] else ""
        r = max(s["rounds"], 1)
        rows.append([sid, name, team, len(games), s["rounds"], s["k"], s["d"], s["a"], s["hs"], round(s["dmg"] / r, 1), s["ud"],
                     s["fk"], s["fd"], s["fa"], s["awp"], xh, games[0][0] if games else ""])
        write_json(out / f"{sid}.json", {"sid": sid, "name": name, "names": [n for n, _ in s["names"].most_common()], "team": team,
                                         "teams": [[t, n] for t, n in s["teams"].most_common()], "xhair": xh,
                                         "xhairs": sorted(([d, c] for d, c in s["xh"].items()), reverse=True),
                                         "maps": dict(s["maps"]), "games": games})
    rows.sort(key=lambda r: (-r[3], r[1].lower()))
    write_json(out / "index.json", {"updated": now(),
                                    "cols": ["sid", "name", "team", "maps", "rounds", "k", "d", "a", "hs", "adr", "ud", "fk", "fd", "fa", "awp", "xhair", "last"],
                                    "rows": rows})
    print(f"игроки: {len(rows)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "store" / "nades-site"))
    ap.add_argument("--keep-single", action="store_true")
    ap.add_argument("--seed-from-public", action="store_true", help="(устарело, игнорируется)")
    a = ap.parse_args()
    build(Path(a.out), a.keep_single)
