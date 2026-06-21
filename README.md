# civretro

Record and replay Civ 7 games. A background collector captures live game state each turn via the game's built-in Chrome DevTools Protocol endpoint (port 9444, always open in all retail builds — no user setup required); a viewer lets you scrub through the session after it ends.

## How it works

Civ 7 runs its UI on Coherent Gameface and exposes a CDP WebSocket on port 9444. civretro connects to that endpoint during a game, queries `Game`, `Players`, and `GameplayMap` each turn, and writes a newline-delimited JSON snapshot file.

## Status

Active development. CDP collection confirmed working. All-AI autonomous game loop (Autoplay via harness mod) confirmed through turn 20 in SP.

## Project structure

```
src/civretro/        Python CDP collector (launcher, collector state machine, queries)
tools/               Run scripts (run_game.py, run_harness.sh) and output traces/
mod/civretro/        CivRetro Recorder mod — localStorage-based per-turn state export
mod/civretro-harness/  AI Harness mod — suppresses Begin/Age screens, enables Autoplay
mod/civretro-probe/  API Dump mod — one-shot global/prototype dump to Automation.log
deploy-mod.sh        Sync all mods to Windows Civ 7 mods directory (WSL rsync)
CLAUDE.md            Agent context — architecture quick-ref and link to living Notion notes
```

## Running the harness

```sh
# With Civ 7 running, from WSL project root:
python tools/run_game.py --n-turns 20 --n-players 4

# Or via wrapper:
./tools/run_harness.sh
```

Enable `CivRetro Recorder` and `CivRetro AI Harness` in the Mods menu before starting. Deploy with `bash deploy-mod.sh` after any mod changes.

## Requirements

- Civ 7 on Windows (Steam) with `-dev` launch flag for CDP access
- Python 3.10+ in WSL for the collector
- No AppOptions.txt changes needed — port 9444 is active in all retail builds
