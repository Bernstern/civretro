# civretro

Record and replay Civ 7 games. A background collector captures live game state each turn via the game's built-in Chrome DevTools Protocol endpoint (port 9444, always open in all retail builds — no user setup required); a viewer lets you scrub through the session after it ends.

## How it works

Civ 7 runs its UI on Coherent Gameface and exposes a CDP WebSocket on port 9444. civretro connects to that endpoint during a game, queries `Game`, `Players`, and `GameplayMap` each turn, and writes a newline-delimited JSON snapshot file.

## Status

Active development. CDP collection confirmed working. All-AI autonomous game loop confirmed working: Begin screen suppression, age-transition screen suppression, and autonomous SP game control via the harness mod are all functional. Turn counting is contiguous across age boundaries: the recorder uses a globalTurn counter and age-aware session detection (civretro:forceNewSession + 90-second lastTs heuristic).

## Project structure

```
src/civretro/        Python CDP collector (launcher, collector state machine, queries)
tools/               Run scripts (run_game.py, run_harness.sh) and output traces/
mod/civretro/        CivRetro Recorder mod — localStorage-based per-turn state export
mod/civretro-harness/  AI Harness mod — suppresses Begin/Age screens, enables Autoplay (always-on when installed)
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

Enable `CivRetro Recorder` and `CivRetro AI Harness` in the Mods menu before starting. After any mod changes, copy the mod folder directly to `%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VII\Mods\` (or use the Write tool if running Claude Code) — `deploy-mod.sh` uses WSL rsync and does not work with Windows mount permissions.

## Requirements

- Civ 7 on Windows (Steam) with `-dev` launch flag for CDP access
- Python 3.10+ in WSL for the collector
- No AppOptions.txt changes needed — port 9444 is active in all retail builds

## TypeScript tooling

An npm-workspaces monorepo under `packages/` holds the data-layer tooling. The
game mod in `mod/` and the Python launcher (`src/civretro/`, `tools/run_game.py`)
are **not** part of this workspace and stay as-is.

- **`packages/types`** — Zod schemas and inferred types for every recorder
  structure (`civretro:session`, `civretro:index`, `civretro:t:{n}`,
  `civretro:map:{age}`) plus the exporter's tagged NDJSON envelope records.
  Schemas are derived from `mod/civretro/ui/recorder.js` and validated against the
  live `LocalStorage.sqlite`, older deployed recorders, and the legacy
  `tools/traces/*.ndjson` fixtures.
- **`packages/exporter`** — replaces `tools/read_localstorage.py`. Reads the
  recorder's `LocalStorage.sqlite` with `better-sqlite3` and emits NDJSON: one
  `session`, one `map_snapshot` per age, then one `turn` per global turn ordered
  by `globalTurn`.

```sh
npm install        # one-time
npm test           # vitest across all packages
npm run typecheck  # tsc --noEmit, no build required
npm run build      # tsc -b → packages/*/dist

npm run export -- --latest      # full NDJSON to stdout
npm run export -- --turns       # list captured turns with a brief summary
npm run export -- --turn 5      # pretty-print one turn snapshot
npm run export -- --all         # summarize all civretro keys (default)
npm run export -- --db <path>   # override the LocalStorage.sqlite path
```
