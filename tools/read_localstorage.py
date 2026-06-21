#!/usr/bin/env python3
"""
Read civretro data from Civ 7's LocalStorage.sqlite.
Usage: python3 tools/read_localstorage.py [--turns] [--turn N] [--session] [--raw]
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path("/mnt/c/Users/Bernie Conrad/AppData/Local/Firaxis Games/Sid Meier's Civilization VII/LocalStorage.sqlite")
ORIGIN = "fs://game"


def get_civretro(key):
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            'SELECT value FROM "Values" WHERE id=? AND key=?', (ORIGIN, key)
        ).fetchone()
    return json.loads(row[0]) if row else None


def get_all_civretro():
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            'SELECT key, value FROM "Values" WHERE id=? AND key LIKE \'civretro:%\' ORDER BY key',
            (ORIGIN,)
        ).fetchall()
    return {k: json.loads(v) for k, v in rows}


def main():
    p = argparse.ArgumentParser(description="Read civretro data from LocalStorage.sqlite")
    p.add_argument("--session",  action="store_true", help="Show session metadata")
    p.add_argument("--index",    action="store_true", help="Show turn index")
    p.add_argument("--turn",     type=int,            help="Show snapshot for turn N")
    p.add_argument("--turns",    action="store_true", help="List all captured turns")
    p.add_argument("--players",  action="store_true", help="Show player summaries for all captured turns")
    p.add_argument("--all",      action="store_true", help="Show all civretro keys")
    p.add_argument("--raw",      action="store_true", help="Print raw JSON")
    args = p.parse_args()

    if not DB_PATH.exists():
        print(f"ERROR: SQLite not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    if not any([args.session, args.index, args.turn is not None, args.turns, args.players, args.all]):
        args.all = True  # default

    if args.all:
        data = get_all_civretro()
        for key, val in data.items():
            if args.raw:
                print(f"{key}: {json.dumps(val)}")
            elif key == "civretro:session":
                print(f"[session] id={val.get('id')} turn={val.get('startTurn')} age={val.get('age')} mp={val.get('isMP')} localPlayer={val.get('localPlayerId')}")
            elif key == "civretro:index":
                print(f"[index] sessionId={val.get('sessionId')} turns={val.get('turns')} latest={val.get('latest')}")
            elif key.startswith("civretro:t:"):
                gt = val.get("globalTurn", val.get("turn"))
                at = val.get("ageTurn", val.get("turn"))
                players = val.get("players", [])
                err = val.get("error")
                if err:
                    print(f"  g{gt}/t{at}: ERROR={err}")
                else:
                    psum = ", ".join(
                        f"p{p['id']}({(p.get('leaderName') or p.get('name','?'))[:20]}) "
                        f"gold={p.get('gold')} cities={p.get('numCities')} units={len(p.get('units',[]))}"
                        for p in players
                    )
                    print(f"  g{gt}/t{at}: mapW={val.get('mapW')} mapH={val.get('mapH')} players=[{psum}]")
        print(f"\nTotal civretro keys: {len(data)}")
        return

    if args.session:
        s = get_civretro("civretro:session")
        print(json.dumps(s, indent=2) if s else "No session data")

    if args.index:
        idx = get_civretro("civretro:index")
        print(json.dumps(idx, indent=2) if idx else "No index data")

    if args.turn is not None:
        snap = get_civretro(f"civretro:t:{args.turn}")
        if not snap:
            print(f"No data for global turn {args.turn}")
        elif args.raw:
            print(json.dumps(snap, indent=2))
        else:
            gt = snap.get("globalTurn", snap.get("turn"))
            at = snap.get("ageTurn", snap.get("turn"))
            print(f"Global turn {gt} / age turn {at} | Age {snap.get('age')} | Map {snap.get('mapW')}x{snap.get('mapH')}")
            for pl in snap.get("players", []):
                yields = pl.get("yields", {})
                name = pl.get("leaderName") or pl.get("name", "?")
                print(f"  Player {pl['id']} ({name}) human={pl.get('isHuman')} gold={pl.get('gold')} cities={pl.get('numCities')} units={len(pl.get('units',[]))}")
                print(f"    yields: food={yields.get('YIELD_FOOD')} prod={yields.get('YIELD_PRODUCTION')} science={yields.get('YIELD_SCIENCE')} culture={yields.get('YIELD_CULTURE')}")

    if args.turns or args.players:
        idx = get_civretro("civretro:index")
        if not idx:
            print("No index data")
            return
        turns = idx.get("turns", [])
        print(f"Captured turns ({len(turns)}): {turns}")
        if args.players:
            for t in turns:
                snap = get_civretro(f"civretro:t:{t}")
                if snap and not snap.get("error"):
                    players = snap.get("players", [])
                    print(f"\nTurn {t}:")
                    for pl in players:
                        print(f"  p{pl['id']} {pl.get('name','?')[:25]:25} human={pl.get('isHuman')} gold={pl.get('gold'):6} cities={pl.get('numCities')} legacyScore={pl.get('legacyScore')}")


if __name__ == "__main__":
    main()
