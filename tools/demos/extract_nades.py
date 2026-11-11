#!/usr/bin/env python3
"""
extract_nades.py — вытаскивает броски гранат из демок CS2 (.dem) для раздела
«Раскидки профи» и сливает их в public/data/nades/<map>.json.

Источник данных — demoparser2 (pip install demoparser2):
  * weapon_fire (weapon_smokegrenade / _flashbang / _hegrenade / _molotov /
    _incgrenade / _decoy) — момент броска + X/Y/Z (ноги), pitch/yaw, скорость,
    duck_amount, is_walking, is_airborne игрока;
  * parse_grenades() — покадровые координаты снарядов (C*Projectile), по
    ним строится траектория и точка приземления;
  * *_detonate / inferno_startburn / decoy_started — точка срабатывания.

Примеры:
  python3 extract_nades.py match.dem --event "IEM Cologne 2026" \
      --match "Vitality vs Spirit" --date 2026-08-10 \
      --url https://www.hltv.org/matches/... --vod https://youtu.be/...
  python3 extract_nades.py demos/              # все .dem в папке (+ sidecar .json)
  python3 extract_nades.py --from-urls urls.txt  # скачать архивы и разобрать

Sidecar: рядом с foo.dem можно положить foo.json (или meta.json в папке):
  {"event": "...", "match": "...", "date": "YYYY-MM-DD", "url": "...", "vod": "..."}
Флаги командной строки перекрывают sidecar.
"""
from __future__ import annotations

import argparse
import bz2
import datetime as dt
import gzip
import hashlib
import json
import lzma
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_OUT = (SCRIPT_DIR / ".." / ".." / "public" / "data" / "nades").resolve()

TICKRATE = 64.0
TRAJ_POINTS = 40
RELEASE_WINDOW = 8  # ticks after weapon_fire to look for the actual release

WEAPON_TYPE = {
    "weapon_smokegrenade": "smoke",
    "weapon_flashbang": "flash",
    "weapon_hegrenade": "he",
    "weapon_molotov": "molotov",
    "weapon_incgrenade": "molotov",
    "weapon_decoy": "decoy",
}
PROJECTILE_TYPE = {
    "CSmokeGrenadeProjectile": "smoke",
    "CFlashbangProjectile": "flash",
    "CHEGrenadeProjectile": "he",
    "CMolotovProjectile": "molotov",
    "CDecoyProjectile": "decoy",
}
DETONATE_EVENTS = {
    "smokegrenade_detonate": "smoke",
    "flashbang_detonate": "flash",
    "hegrenade_detonate": "he",
    "inferno_startburn": "molotov",
    "decoy_started": "decoy",
}

PLAYER_PROPS = [
    "X", "Y", "Z", "pitch", "yaw",
    "velocity_X", "velocity_Y", "velocity_Z",
    "duck_amount", "is_walking", "is_airborne", "team_num", "team_clan_name", "last_place_name",
]
GRENADE_SPEED = 675.0  # 750 * 0.9: launch speed of a full (left-click) throw
PLACE_CELL = 64.0      # grid for player-position → callout samples


def log(*a):
    print(*a, file=sys.stderr)


def r1(v):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), 1)


def r2(v):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), 2)


def fnum(v, default=0.0):
    try:
        f = float(v)
        return default if math.isnan(f) else f
    except (TypeError, ValueError):
        return default


def bval(v):
    try:
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return False
    except TypeError:
        pass
    return bool(v)


# --------------------------------------------------------------------------- #
# metadata
# --------------------------------------------------------------------------- #
def load_sidecar(dem: Path) -> dict:
    meta = {}
    for cand in (dem.parent / "meta.json", dem.with_suffix(".json"),
                 dem.parent / (dem.name + ".json")):
        if cand.is_file():
            try:
                meta.update(json.loads(cand.read_text(encoding="utf-8")))
            except Exception as e:  # noqa: BLE001
                log(f"  ! не удалось прочитать {cand}: {e}")
    return meta


def guess_date(dem: Path) -> str | None:
    m = re.search(r"(20\d\d)[-_.]?(\d\d)[-_.]?(\d\d)", dem.name)
    if m:
        try:
            return dt.date(int(m[1]), int(m[2]), int(m[3])).isoformat()
        except ValueError:
            pass
    return None


# --------------------------------------------------------------------------- #
# core extraction
# --------------------------------------------------------------------------- #
def downsample(points, n=TRAJ_POINTS):
    if len(points) <= n:
        return points
    step = (len(points) - 1) / (n - 1)
    return [points[round(i * step)] for i in range(n)]


def classify_move(speed, vz, airborne, duck, walking, jump_signal):
    """stand | crouch | walk | run | jump | runjump"""
    in_air = airborne or jump_signal
    if in_air:
        return "runjump" if speed > 135 else "jump"
    if duck >= 0.5:
        return "crouch"
    if speed < 10:
        return "stand"
    if walking or speed <= 135:
        return "walk"
    return "run"


def extract_demo(dem: Path, meta: dict, include_warmup=False, players=None, keep_postround=False):
    import pandas as pd  # noqa: F401  (demoparser2 returns pandas DataFrames)
    from demoparser2 import DemoParser

    parser = DemoParser(str(dem))
    header = parser.parse_header()
    map_name = (header.get("map_name") or "unknown").lower()

    # ---- rounds ---------------------------------------------------------- #
    evs = dict(parser.parse_events(
        ["round_freeze_end", "round_end", "round_announce_match_start", "begin_new_match"],
        other=["total_rounds_played"]))
    fe = evs.get("round_freeze_end")
    freeze_ends = sorted(int(t) for t in fe["tick"]) if fe is not None and len(fe) else []
    ms = evs.get("round_announce_match_start")
    match_start = int(ms["tick"].max()) if ms is not None and len(ms) else 0

    # ---- throws ---------------------------------------------------------- #
    wf = parser.parse_event(
        "weapon_fire", player=PLAYER_PROPS,
        other=["total_rounds_played", "is_warmup_period", "is_freeze_period"])
    if wf is None or not len(wf):
        return map_name, [], {}
    wf = wf[wf["weapon"].isin(WEAPON_TYPE.keys())].copy()
    if not include_warmup and "is_warmup_period" in wf.columns:
        wf = wf[~wf["is_warmup_period"].fillna(False).astype(bool)]
    if not include_warmup and match_start:
        wf = wf[wf["tick"] >= match_start]
    wf["sid"] = wf["user_steamid"].astype(str)
    if players:
        low = {p.lower() for p in players}
        wf = wf[wf["user_name"].str.lower().isin(low) | wf["sid"].isin(players)]
    if not len(wf):
        return map_name, [], {}

    # ---- projectiles ----------------------------------------------------- #
    g = parser.parse_grenades()
    g = g[g["grenade_type"].isin(PROJECTILE_TYPE.keys())].copy()
    g = g.dropna(subset=["x", "y", "z"])
    g["sid"] = g["steamid"].astype(str)
    g = g.sort_values(["grenade_entity_id", "tick"])
    brk = ((g["grenade_entity_id"] != g["grenade_entity_id"].shift())
           | (g["tick"].diff() != 1) | (g["sid"] != g["sid"].shift()))
    g["seg"] = brk.cumsum()
    segments = {}
    for seg_id, s in g.groupby("seg", sort=False):
        segments[seg_id] = {
            "type": PROJECTILE_TYPE[s["grenade_type"].iloc[0]],
            "eid": int(s["grenade_entity_id"].iloc[0]),
            "sid": s["sid"].iloc[0],
            "t0": int(s["tick"].iloc[0]),
            "t1": int(s["tick"].iloc[-1]),
            "xyz": s[["x", "y", "z"]].to_numpy(),
            "ticks": s["tick"].to_numpy(),
        }
    by_owner = {}
    for sg in segments.values():
        by_owner.setdefault((sg["sid"], sg["type"]), []).append(sg)
    for v in by_owner.values():
        v.sort(key=lambda s: s["t0"])

    # ---- detonations ----------------------------------------------------- #
    det = {}
    names = [n for n in DETONATE_EVENTS if n in set(parser.list_game_events())]
    if names:
        for name, df in parser.parse_events(names):
            for _, e in df.iterrows():
                det.setdefault((str(e.get("user_steamid")), DETONATE_EVENTS[name]), []).append(
                    (int(e["tick"]), fnum(e.get("x")), fnum(e.get("y")), fnum(e.get("z")),
                     int(fnum(e.get("entityid"), -1))))
        for v in det.values():
            v.sort()

    # ---- player state between weapon_fire and projectile release --------- #
    # In CS2 weapon_fire is emitted when the attack button is released; the
    # projectile is created ~0.1 s (7 ticks @64) later, using the player's
    # velocity/eye position at THAT moment. A jump-throw = player on the ground
    # at weapon_fire, airborne at release. We sample ticks T..T+8.
    look_ticks = sorted({int(t) + d for t in wf["tick"] for d in range(0, RELEASE_WINDOW + 1)})
    after = {}
    try:
        ta = parser.parse_ticks(["is_airborne", "velocity_Z", "duck_amount", "pitch", "yaw"],
                                ticks=look_ticks)
        for _, r in ta.iterrows():
            after[(str(r["steamid"]), int(r["tick"]))] = (
                bval(r["is_airborne"]), fnum(r["velocity_Z"]), fnum(r["duck_amount"]),
                fnum(r["pitch"], None), fnum(r["yaw"], None))
    except Exception as e:  # noqa: BLE001
        log(f"  ! parse_ticks для прыжков не удался: {e}")

    round_ends = []
    re_df = evs.get("round_end")
    if re_df is not None and len(re_df):
        round_ends = sorted(int(t) for t in re_df["tick"])

    used_segments = set()
    throws = []
    demo_name = meta.get("demo_name") or dem.name
    stats = {"no_projectile": 0, "no_land": 0, "post_round": 0, "freeze": 0}

    for _, r in wf.sort_values("tick").iterrows():
        tick = int(r["tick"])
        sid = r["sid"]
        gtype = WEAPON_TYPE[r["weapon"]]

        if bval(r.get("is_freeze_period")):
            stats["freeze"] += 1
            continue
        fe_tick = max((t for t in freeze_ends if t <= tick), default=None)
        last_end = max((t for t in round_ends if t < tick), default=None)
        if not keep_postround and fe_tick is not None and last_end is not None and last_end > fe_tick:
            stats["post_round"] += 1  # thrown after round_end, before next round — not a lineup
            continue

        # projectile spawned by this throw: same owner+type, starts 0..32 ticks later
        seg = None
        for cand in by_owner.get((sid, gtype), []):
            if id(cand) in used_segments:
                continue
            if tick - 2 <= cand["t0"] <= tick + 32:
                seg = cand
                break
            if cand["t0"] > tick + 32:
                break
        if seg is not None:
            used_segments.add(id(seg))
        else:
            stats["no_projectile"] += 1

        # land / detonation point
        land = None
        end_tick = None
        if seg is not None:
            end_tick = seg["t1"]
            # detonation event of that owner/type within projectile lifetime (+ small slack);
            # prefer the one carrying the projectile's entity id (smoke/flash/he/decoy),
            # molotov's inferno is a separate entity → first one in the window.
            window = [d for d in det.get((sid, gtype), []) if seg["t0"] <= d[0] <= seg["t1"] + 4]
            pick = next((d for d in window if d[4] == seg["eid"]), window[0] if window else None)
            if pick is not None:
                land = pick[1:4]
                end_tick = pick[0]
            if land is None:
                if gtype == "smoke" or gtype == "decoy":
                    # projectile stays in world after landing → take first point it stops moving
                    xyz = seg["xyz"]
                    idx = len(xyz) - 1
                    for i in range(1, len(xyz)):
                        if (abs(xyz[i] - xyz[i - 1]).sum() < 0.05):
                            idx = i
                            break
                    land = tuple(xyz[idx])
                    end_tick = int(seg["ticks"][idx])
                else:
                    land = tuple(seg["xyz"][-1])
        else:
            for (dtick, dx, dy, dz, _eid) in det.get((sid, gtype), []):
                if tick <= dtick <= tick + 64 * 25:
                    land = (dx, dy, dz)
                    end_tick = dtick
                    break
        if land is None:
            stats["no_land"] += 1
            continue

        # trajectory (cut at detonation / rest point); points are 1 tick apart → uniform in time
        traj = []
        dur = None
        btn = ""
        if seg is not None:
            mask = seg["ticks"] <= (end_tick if end_tick is not None else seg["t1"])
            pts = seg["xyz"][mask]
            traj = downsample([[r1(p[0]), r1(p[1]), r1(p[2])] for p in pts])
            dur = round(max(len(pts) - 1, 0) / TICKRATE, 2)

        # movement
        vx, vy, vz = fnum(r.get("user_velocity_X")), fnum(r.get("user_velocity_Y")), fnum(r.get("user_velocity_Z"))
        speed = math.hypot(vx, vy)
        airborne = bval(r.get("user_is_airborne"))
        release = (seg["t0"] - 1) if seg is not None else tick + 6
        release = min(max(release, tick), tick + RELEASE_WINDOW)
        jump_signal = False
        duck = fnum(r.get("user_duck_amount"))
        for d in range(1, release - tick + 2):
            a = after.get((sid, tick + d))
            if a and a[0] and a[1] > 50:  # left the ground (upward) before the nade was released
                jump_signal = True
                break
        rel_state = after.get((sid, release))
        if rel_state:
            duck = max(duck, rel_state[2]) if not jump_signal else duck
        move = classify_move(speed, vz, airborne, duck, bval(r.get("user_is_walking")), jump_signal)

        # throw button from the launch speed: vel = forward * 675 * lerp(strength, 0.3, 1) + 1.25 * player_vel
        # (strength 1 = left click, 0.5 = both buttons, 0 = right click)
        if seg is not None and len(seg["xyz"]) >= 3:
            xyz, tks = seg["xyz"], seg["ticks"]
            dtk = max(int(tks[2] - tks[1]), 1)
            gv = [(xyz[2][i] - xyz[1][i]) * TICKRATE / dtk for i in range(3)]
            pvz = rel_state[1] if rel_state else vz
            tv = (gv[0] - 1.25 * vx, gv[1] - 1.25 * vy, gv[2] - 1.25 * pvz)
            k = math.sqrt(sum(c * c for c in tv)) / GRENADE_SPEED
            btn = "L" if k > 0.83 else "LR" if k > 0.49 else "R"

        # Angles: the view angles at the release tick are what the game uses for the
        # launch vector (verified: median yaw error 0.04° vs 0.17° at weapon_fire tick).
        # Position: feet at weapon_fire tick (still on the ground for jump-throws).
        pitch, yaw = fnum(r.get("user_pitch")), fnum(r.get("user_yaw"))
        if rel_state and rel_state[3] is not None and rel_state[4] is not None:
            pitch, yaw = rel_state[3], rel_state[4]
        yaw = ((yaw + 180.0) % 360.0) - 180.0

        # side / team
        tnum = int(fnum(r.get("user_team_num"), 0))
        side = "T" if tnum == 2 else "CT" if tnum == 3 else None
        if side is None:
            tn = str(r.get("user_team_name") or "").upper()
            side = "T" if tn.startswith("T") else "CT"
        clan_col = "t_team_clan_name" if side == "T" else "ct_team_clan_name"
        team = str(r.get(clan_col) or r.get("user_team_clan_name") or "").strip() or side

        # round & time
        rnd = int(fnum(r.get("total_rounds_played"), 0)) + 1
        t_in_round = (tick - fe_tick) / TICKRATE if fe_tick is not None else None

        ident = f"{demo_name}|{tick}|{sid}"
        tid = hashlib.sha1(ident.encode("utf-8")).hexdigest()[:12]

        throws.append({
            "id": tid,
            "player": str(r.get("user_name") or ""),
            "steamid": sid,
            "team": team,
            "side": side,
            "type": gtype,
            "round": rnd,
            "tick": tick,
            "time": r2(t_in_round) if t_in_round is not None else None,
            "throw": {"x": r2(r["user_X"]), "y": r2(r["user_Y"]), "z": r2(r["user_Z"]),
                      "pitch": r2(pitch), "yaw": r2(yaw)},
            "land": {"x": r1(land[0]), "y": r1(land[1]), "z": r1(land[2])},
            "traj": traj,
            "move": move,
            "btn": btn,
            "dur": dur,
            "place": str(r.get("user_last_place_name") or "") if not isinstance(r.get("user_last_place_name"), float) else "",
            "speed": r1(speed),
            "event": meta.get("event") or "",
            "match": meta.get("match") or "",
            "date": meta.get("date") or guess_date(dem) or "",
            "demo": demo_name,
            "url": meta.get("url") or None,
            "vod": meta.get("vod") or None,
        })
    skipped = {k: v for k, v in stats.items() if v}
    if skipped:
        log(f"  пропущено/без снаряда: {skipped}")
    extras = {}
    try:
        extras["places"] = place_samples(parser, match_start)
    except Exception as e:  # noqa: BLE001
        log(f"  ! позиции/коллауты не собраны: {e}")
    try:
        extras["players"] = player_stats(parser, match_start, freeze_ends)
    except Exception as e:  # noqa: BLE001
        log(f"  ! статистика игроков не собрана: {e}")
    return map_name, throws, extras


def place_samples(parser, match_start):
    """player positions every 32 ticks → grid cells with the in-game callout (last_place_name).
    Returns [[cx, cy, cz, place, n], ...] with cell = floor(coord / PLACE_CELL)."""
    from collections import Counter

    re_df = parser.parse_event("round_end")
    last = int(re_df["tick"].max()) if re_df is not None and len(re_df) else match_start + 64 * 60 * 40
    ticks = list(range(max(match_start, 1), last, 32))
    df = parser.parse_ticks(["X", "Y", "Z", "last_place_name", "is_alive"], ticks=ticks)
    cells = Counter()
    for x, y, z, pl, alive in zip(df["X"], df["Y"], df["Z"], df["last_place_name"], df["is_alive"]):
        if not isinstance(pl, str) or not pl or not bval(alive):
            continue
        try:
            key = (math.floor(x / PLACE_CELL), math.floor(y / PLACE_CELL), math.floor(z / PLACE_CELL), pl)
        except (TypeError, ValueError):
            continue
        cells[key] += 1
    return [[a, b, c, pl, n] for (a, b, c, pl), n in cells.items()]


def player_stats(parser, match_start, freeze_ends):
    """per-player match stats + crosshair code from the demo"""
    deaths = parser.parse_event("player_death", player=["team_num"], other=["total_rounds_played"])
    hurt = parser.parse_event("player_hurt", player=["team_num"], other=["total_rounds_played"])
    rounds_end = parser.parse_event("round_end")
    if match_start:
        deaths = deaths[deaths["tick"] >= match_start] if len(deaths) else deaths
        hurt = hurt[hurt["tick"] >= match_start] if len(hurt) else hurt
        rounds_end = rounds_end[rounds_end["tick"] >= match_start] if len(rounds_end) else rounds_end
    n_rounds = len(rounds_end)
    probe = int(rounds_end["tick"].iloc[len(rounds_end) // 2]) if n_rounds else match_start + 64 * 60
    roster = parser.parse_ticks(["crosshair_code", "team_clan_name", "team_num"], ticks=[probe])
    P = {}
    for _, r in roster.iterrows():
        sid = str(r["steamid"])
        P[sid] = {"name": str(r["name"]), "sid": sid, "team": str(r.get("team_clan_name") or "").strip(),
                  "xhair": str(r.get("crosshair_code") or ""), "k": 0, "d": 0, "a": 0, "hs": 0, "dmg": 0,
                  "ud": 0, "fk": 0, "fd": 0, "fa": 0, "awp": 0, "rounds": n_rounds}

    def st(sid):
        return P.get(str(sid))
    first_in_round = set()
    for _, e in deaths.sort_values("tick").iterrows() if len(deaths) else []:
        att, vic = str(e.get("attacker_steamid")), str(e.get("user_steamid"))
        same = e.get("attacker_team_num") == e.get("user_team_num")
        rnd = int(fnum(e.get("total_rounds_played"), 0))
        if st(vic):
            st(vic)["d"] += 1
        if st(att) and att != vic and not same:
            a = st(att)
            a["k"] += 1
            a["hs"] += 1 if bval(e.get("headshot")) else 0
            a["awp"] += 1 if str(e.get("weapon")) == "awp" else 0
            if rnd not in first_in_round:
                first_in_round.add(rnd)
                a["fk"] += 1
                if st(vic):
                    st(vic)["fd"] += 1
        elif rnd not in first_in_round:
            first_in_round.add(rnd)
        ass = str(e.get("assister_steamid"))
        if st(ass) and e.get("assister_team_num") != e.get("user_team_num"):
            st(ass)["a"] += 1
            if bval(e.get("assistedflash")):
                st(ass)["fa"] += 1
    hp = {}
    cur_round = None
    for _, e in hurt.sort_values("tick").iterrows() if len(hurt) else []:
        rnd = int(fnum(e.get("total_rounds_played"), 0))
        if rnd != cur_round:
            hp, cur_round = {}, rnd
        vic, att = str(e.get("user_steamid")), str(e.get("attacker_steamid"))
        before = hp.get(vic, 100)
        dmg = min(int(fnum(e.get("dmg_health"), 0)), before)
        hp[vic] = max(before - dmg, 0)
        if st(att) and att != vic and e.get("attacker_team_num") != e.get("user_team_num"):
            st(att)["dmg"] += dmg
            if str(e.get("weapon")) in ("hegrenade", "inferno", "molotov", "incgrenade"):
                st(att)["ud"] += dmg
    return [p for p in P.values() if p["team"] or p["k"] or p["d"]]


# --------------------------------------------------------------------------- #
# merge / write
# --------------------------------------------------------------------------- #
def merge_into(out_dir: Path, map_name: str, throws: list, replace_demo=True, extras=None):
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{map_name}.json"
    data = {"map": map_name, "updated": None, "throws": []}
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            log(f"  ! {path} повреждён ({e}), перезаписываю")
    existing = data.get("throws", [])
    new_ids = {t["id"] for t in throws}
    demos = {t["demo"] for t in throws}
    kept = [t for t in existing
            if t.get("id") not in new_ids and not (replace_demo and t.get("demo") in demos)]
    merged = kept + throws
    merged.sort(key=lambda t: (t.get("date") or "", t.get("demo") or "", t.get("tick") or 0))
    data = {
        "map": map_name,
        "updated": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "throws": merged,
        **(extras or {}),  # places / players of the last parsed demo (opencs2.py parses one demo per dir)
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)
    return path, len(merged), len(merged) - len(kept)


# --------------------------------------------------------------------------- #
# downloading / unpacking (for --from-urls / CI)
# --------------------------------------------------------------------------- #
UA = "Mozilla/5.0 (X11; Linux x86_64) rush-b-nades/1.0"


def download(url: str, dest_dir: Path) -> Path:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status}")
        cd = resp.headers.get("Content-Disposition", "")
        m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', cd)
        name = m.group(1) if m else Path(urllib.parse.urlparse(resp.url).path).name or "download.bin"
        name = re.sub(r"[^\w.\-]+", "_", urllib.parse.unquote(name))[:150]
        ctype = resp.headers.get("Content-Type", "")
        if "text/html" in ctype:
            raise RuntimeError("получен HTML вместо файла (вероятно, Cloudflare/защита от ботов)")
        out = dest_dir / name
        with open(out, "wb") as f:
            shutil.copyfileobj(resp, f, length=1 << 20)
    return out


def sniff(path: Path) -> str:
    with open(path, "rb") as f:
        head = f.read(8)
    if head.startswith(b"PBDEMS2"):
        return "dem"
    if head.startswith(b"HL2DEMO"):
        return "dem1"  # CS:GO demo — not supported by demoparser2
    if head.startswith(b"PK\x03\x04"):
        return "zip"
    if head.startswith(b"Rar!"):
        return "rar"
    if head.startswith(b"\x1f\x8b"):
        return "gz"
    if head.startswith(b"BZh"):
        return "bz2"
    if head.startswith(b"\xfd7zXZ"):
        return "xz"
    if head.startswith(b"7z\xbc\xaf\x27\x1c"):
        return "7z"
    if head.startswith(b"\x28\xb5\x2f\xfd"):
        return "zst"
    return "unknown"


def safe_member(name: str) -> bool:
    p = Path(name)
    return not p.is_absolute() and ".." not in p.parts


def unpack(path: Path, dest: Path, depth=0) -> list[Path]:
    """Return list of .dem files (recursively unpacking archives)."""
    kind = sniff(path)
    if kind == "dem":
        return [path]
    if depth > 3:
        return []
    sub = dest / (path.name + "_x")
    sub.mkdir(parents=True, exist_ok=True)
    if kind == "zip":
        with zipfile.ZipFile(path) as z:
            for m in z.infolist():
                if m.is_dir() or not safe_member(m.filename):
                    continue
                target = sub / Path(m.filename).name
                k = 1
                while target.exists():  # same basename in different folders
                    target = sub / f"{Path(m.filename).stem}_{k}{Path(m.filename).suffix}"
                    k += 1
                with z.open(m) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst, length=1 << 20)
    elif kind in ("gz", "bz2", "xz"):
        opener = {"gz": gzip.open, "bz2": bz2.open, "xz": lzma.open}[kind]
        target = sub / re.sub(r"\.(gz|bz2|xz)$", "", path.name)
        if target == path or target.name == path.name:
            target = sub / (path.stem or "file")
        with opener(path, "rb") as src, open(target, "wb") as dst:
            shutil.copyfileobj(src, dst, length=1 << 20)
    elif kind in ("rar", "7z", "zst"):
        tool = None
        for cand in (["unrar", "x", "-o+", "-inul", str(path), str(sub) + "/"],
                     ["7z", "x", "-y", f"-o{sub}", str(path)],
                     ["bsdtar", "-xf", str(path), "-C", str(sub)],
                     ["unar", "-q", "-o", str(sub), str(path)]):
            if kind == "zst":
                cand = ["zstd", "-d", "-q", str(path), "-o", str(sub / path.stem)]
            if shutil.which(cand[0]):
                tool = cand
                break
        if not tool:
            log(f"  ! нет распаковщика для {kind} ({path.name}); установите unrar/7z/bsdtar")
            return []
        subprocess.run(tool, check=True)
    elif kind == "dem1":
        log(f"  ! {path.name}: демка CS:GO (HL2DEMO), demoparser2 читает только CS2")
        return []
    else:
        log(f"  ! {path.name}: неизвестный формат")
        return []
    out = []
    for f in sorted(sub.rglob("*")):
        if f.is_file():
            out.extend(unpack(f, sub, depth + 1))
    return out


def read_url_list(path: Path):
    """urls.txt: одна строка = URL [| json-метаданные] ; '#' — комментарий.
    Пример:  https://example.com/demo.rar | {"event":"Major","match":"A vs B","date":"2026-06-20"}"""
    items = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        url, _, rest = line.partition("|")
        meta = {}
        rest = rest.strip()
        if rest:
            try:
                meta = json.loads(rest)
            except json.JSONDecodeError:
                log(f"  ! плохой JSON в строке: {line}")
        meta.setdefault("url", None)
        items.append((url.strip(), meta))
    return items


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def collect_inputs(paths):
    dems = []
    for p in paths:
        p = Path(p)
        if p.is_dir():
            dems += sorted(p.rglob("*.dem"))
        elif p.is_file():
            dems.append(p)
        else:
            log(f"  ! нет такого файла: {p}")
    return dems


def main(argv=None):
    ap = argparse.ArgumentParser(description="CS2 demo → public/data/nades/<map>.json")
    ap.add_argument("inputs", nargs="*", help=".dem файлы, архивы или папки")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help=f"папка вывода (по умолчанию {DEFAULT_OUT})")
    ap.add_argument("--meta", help="sidecar JSON с метаданными для всех входных демок")
    ap.add_argument("--event")
    ap.add_argument("--match")
    ap.add_argument("--date", help="YYYY-MM-DD")
    ap.add_argument("--url", help="страница матча (HLTV и т.п.)")
    ap.add_argument("--vod", help="ссылка на VOD (YouTube)")
    ap.add_argument("--from-urls", help="файл со списком URL демок/архивов (режим для CI)")
    ap.add_argument("--work-dir", help="куда скачивать/распаковывать (по умолчанию временная папка)")
    ap.add_argument("--keep", action="store_true", help="не удалять скачанные файлы")
    ap.add_argument("--players", help="только эти игроки (ники или steamid через запятую)")
    ap.add_argument("--types", help="только эти типы: smoke,flash,he,molotov,decoy")
    ap.add_argument("--include-warmup", action="store_true")
    ap.add_argument("--keep-postround", action="store_true",
                    help="оставлять броски после конца раунда (по умолчанию выкидываются)")
    ap.add_argument("--no-traj", action="store_true", help="не сохранять траектории (меньше файл)")
    ap.add_argument("--dry-run", action="store_true", help="ничего не записывать, только статистика")
    args = ap.parse_args(argv)

    out_dir = Path(args.out)
    cli_meta = {k: v for k, v in {
        "event": args.event, "match": args.match, "date": args.date,
        "url": args.url, "vod": args.vod}.items() if v}
    if args.date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
        ap.error("--date должен быть в формате YYYY-MM-DD")
    file_meta = {}
    if args.meta:
        file_meta = json.loads(Path(args.meta).read_text(encoding="utf-8"))
    players = [p.strip() for p in args.players.split(",")] if args.players else None
    types = set(args.types.split(",")) if args.types else None

    jobs = []  # (dem_path, meta)
    tmp_root = None
    if args.from_urls:
        work = Path(args.work_dir) if args.work_dir else Path(tempfile.mkdtemp(prefix="nades_"))
        tmp_root = None if (args.work_dir or args.keep) else work
        work.mkdir(parents=True, exist_ok=True)
        for i, (url, meta) in enumerate(read_url_list(Path(args.from_urls))):
            d = work / f"{i:03d}"
            d.mkdir(exist_ok=True)
            log(f"↓ {url}")
            try:
                f = download(url, d)
                dems = unpack(f, d)
            except Exception as e:  # noqa: BLE001
                log(f"  ! не удалось скачать/распаковать: {e}")
                continue
            if not dems:
                log("  ! внутри нет .dem")
            for dem in dems:
                m = {**file_meta, **meta, **cli_meta}
                jobs.append((dem, m))

    work_unpack = None
    for p in collect_inputs(args.inputs):
        if sniff(p) == "dem":
            jobs.append((p, {**file_meta, **load_sidecar(p), **cli_meta}))
        else:
            work_unpack = work_unpack or Path(tempfile.mkdtemp(prefix="nades_unpack_"))
            for dem in unpack(p, work_unpack):
                jobs.append((dem, {**file_meta, **load_sidecar(p), **cli_meta}))

    if not jobs:
        ap.error("нет входных демок")

    totals = {}
    exit_code = 0
    for dem, meta in jobs:
        log(f"▶ {dem.name}")
        try:
            map_name, throws, extras = extract_demo(dem, meta, include_warmup=args.include_warmup,
                                                    players=players, keep_postround=args.keep_postround)
        except Exception as e:  # noqa: BLE001
            log(f"  ! ошибка разбора: {e}")
            exit_code = 1
            continue
        if types:
            throws = [t for t in throws if t["type"] in types]
        if args.no_traj:
            for t in throws:
                t["traj"] = []
        counts = {}
        for t in throws:
            counts[t["type"]] = counts.get(t["type"], 0) + 1
        log(f"  карта {map_name}: {len(throws)} бросков {counts}")
        if not args.dry_run and throws:
            # full re-parse of a demo replaces its old throws; filtered runs only upsert by id
            path, n_total, n_new = merge_into(out_dir, map_name, throws,
                                              replace_demo=not (players or types), extras=extras)
            log(f"  → {path} (всего {n_total}, добавлено/обновлено {n_new})")
        totals.setdefault(map_name, {})
        for k, v in counts.items():
            totals[map_name][k] = totals[map_name].get(k, 0) + v

    for d in (tmp_root, work_unpack):
        if d and not args.keep:
            shutil.rmtree(d, ignore_errors=True)
    print(json.dumps(totals, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
