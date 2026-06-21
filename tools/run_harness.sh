#!/usr/bin/env bash
# run_harness.sh — fire a CivRetro all-AI harness game and trace it.
#
# Usage:
#   ./tools/run_harness.sh                          # 20 turns, 4 players
#   ./tools/run_harness.sh --n-turns 50             # override turns
#   ./tools/run_harness.sh --n-turns 20 --tag test  # add trace label
#   ./tools/run_harness.sh --n-players 6 --seed 42
#
# Requires: Civ 7 running with -dev flag (port 9444 open)
# Mods needed (enable in game):  CivRetro Recorder  •  CivRetro AI Harness

set -euo pipefail
cd "$(dirname "$0")/.."

TURNS=${CIVRETRO_TURNS:-20}
PLAYERS=${CIVRETRO_PLAYERS:-4}

# Pass any extra args directly to run_game.py (overrides defaults above)
python tools/run_game.py --n-turns "$TURNS" --n-players "$PLAYERS" "$@"
