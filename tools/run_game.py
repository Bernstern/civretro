"""
run_game.py — Launch an automated Civ 7 game via CDP.

Configures and starts an all-AI game, waits for it to finish (Autoplay done
or turn count reached), then returns to the main menu. Turn data is captured
by the civretro-recorder mod via localStorage — no CDP data collection here.

Usage:
  python run_game.py --n-turns 5 --n-players 2 --speed online --map-size tiny
  python run_game.py --mode mp --n-turns 5 --n-players 2 --speed online --map-size tiny
  python run_game.py --n-turns 50 --n-players 4 --seed 42 --map-type continents

Arguments:
  --n-turns   N     Turn count to run (default: 50)
  --n-players N     Number of AI player slots (2-6, default: 6)
  --seed      N     Map seed for reproducibility (default: random)
  --mode      STR   sp or mp (default: sp)
  --speed     STR   online|quick|standard|epic|marathon (default: online)
  --map-size  STR   tiny|small|standard|large|huge (default: small)
  --map-type  STR   continents|continents-plus|archipelago|fractal|pangaea-plus|shuffle|terra-incognita
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import asyncio

from civretro.launcher import build_arg_parser, RunConfig, _run, RunError, _args_to_config
from civretro.log import configure_logging


async def main():
    configure_logging()
    args = build_arg_parser().parse_args()
    cfg = _args_to_config(args)
    try:
        s = await _run(cfg)
    except RunError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"\nDone  turns={s['turns_captured']}/{s['n_turns']}  wall={s['elapsed']:.0f}s\n")


if __name__ == "__main__":
    asyncio.run(main())
