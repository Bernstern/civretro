"""
run_game.py — Launch an automated Civ 7 game via CDP.

Configures and starts an all-AI game, waits for it to finish (Autoplay done
or turn count reached), then returns to the main menu. Turn data is captured
by the civretro-recorder mod via localStorage — no CDP data collection here.

Usage:
  python run_game.py --n-turns 5 --n-players 2 --speed online --map-size tiny
  python run_game.py --mode mp --n-turns 5 --n-players 2 --speed online --map-size tiny --tag mp-a
  python run_game.py --n-turns 50 --n-players 4 --seed 42 --map-type continents

Arguments:
  --n-turns   N     Turn count to run (default: 50)
  --n-players N     Number of AI player slots (2-6, default: 6)
  --seed      N     Map seed for reproducibility (default: random)
  --mode      STR   sp or mp (default: sp)
  --speed     STR   online|quick|standard|epic|marathon (default: online)
  --map-size  STR   tiny|small|standard|large|huge (default: small)
  --map-type  STR   continents|continents-plus|archipelago|fractal|pangaea-plus|shuffle|terra-incognita
  --tag       STR   Label for this run (informational)
  --note      STR   Free-text note (informational)
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import argparse
import asyncio

from civretro.launcher import _run
from civretro.log import configure_logging


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--n-turns",   type=int,   default=50,   help="Turn count (default: 50)")
    p.add_argument("--n-players", type=int,   default=6,    choices=range(2, 7), metavar="2-6",
                   help="Number of AI players (default: 6)")
    p.add_argument("--seed",      type=int,   default=None, help="Map+game seed for reproducibility")
    p.add_argument("--tag",       type=str,   default=None, help="Label for this run (informational)")
    p.add_argument("--note",      type=str,   default=None, help="Free-text note (informational)")
    p.add_argument("--mode",      type=str,   default="sp", choices=["sp", "mp"],
                   help="Game mode: sp (single-player) or mp (LAN multiplayer) (default: sp)")
    p.add_argument("--speed",     type=str,   default="online",
                   choices=["online", "quick", "standard", "epic", "marathon"],
                   help="Game speed (default: online)")
    p.add_argument("--map-size",  type=str,   default="small",
                   choices=["tiny", "small", "standard", "large", "huge"],
                   help="Map size (default: small)")
    p.add_argument("--map-type",  type=str,   default=None,
                   choices=["continents", "continents-plus", "archipelago", "fractal",
                            "pangaea-plus", "shuffle", "terra-incognita"],
                   help="Map script (default: game default)")
    return p.parse_args()


async def main(args):
    configure_logging()
    s = await _run(args)
    print(f"\nDone  turns={s['turns_captured']}/{s['n_turns']}  wall={s['elapsed']:.0f}s\n")


if __name__ == "__main__":
    asyncio.run(main(parse_args()))
