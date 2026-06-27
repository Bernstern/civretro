# civretro

Record and replay Civ 7 games. A background collector captures live game state each turn via the game's built-in Chrome DevTools Protocol endpoint (port 9444, always open in all retail builds — no user setup required); a viewer lets you scrub through the session after it ends.

## How it works

Civ 7 runs its UI on Coherent Gameface and exposes a CDP WebSocket on port 9444. civretro connects to that endpoint during a game, queries `Game`, `Players`, and `GameplayMap` each turn, and writes a newline-delimited JSON snapshot file.

## Status

Active development. CDP collection confirmed working. All-AI autonomous game loop confirmed working: Begin screen suppression, age-transition screen suppression, and autonomous SP game control via the harness mod are all functional. Turn counting is contiguous across age boundaries: the recorder uses a globalTurn counter and age-aware session detection (civretro:forceNewSession + 90-second lastTs heuristic).

## Project structure

Everything off-game is one TypeScript codebase (pnpm workspaces); the only
non-TS code is `mods/`, which must be raw JS because Coherent Gameface loads it
directly with no build step. See [AGENTS.md](AGENTS.md) for the TS conventions.

```
mods/civretro/          CivRetro Recorder — localStorage per-turn state export (the only shipped mod)
mods/civretro-harness/  AI Harness — suppresses Begin/Age screens, enables Autoplay (dev only)
mods/civretro-probe/    API Dump — one-shot global/prototype dump to Automation.log (dev only)
shared/types/           Zod schema contract + inferred types (the spine everything imports)
shared/exporter/        LocalStorage.sqlite → NDJSON
shared/parser/          .Civ7Save binary decoder
shared/launcher/        CDP game automation (drives an all-AI game, polls the recorder)
app/                    Replay viewer (stub)
fixtures/               Committed test data: traces/ (recorder NDJSON), saves/ (.Civ7Save)
deploy-mod.sh           Sync mods to the Windows Civ 7 mods directory (WSL rsync)
```

## Running the harness

```sh
# With Civ 7 running (-dev flag), from the WSL project root:
pnpm launch -- --n-turns 20 --n-players 4
```

Enable `CivRetro Recorder` and `CivRetro AI Harness` in the Mods menu before starting. After any mod changes, copy the mod folder directly to `%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VII\Mods\` (or use the Write tool if running Claude Code) — `deploy-mod.sh` uses WSL rsync and does not work with Windows mount permissions.

## Requirements

- Civ 7 on Windows (Steam) with `-dev` launch flag for CDP access
- Node 20+ and pnpm in WSL (`corepack enable` provides pnpm)
- No AppOptions.txt changes needed — port 9444 is active in all retail builds

## TypeScript tooling

A pnpm-workspaces monorepo. `shared/types` is the keystone: Zod schemas derived
from `mods/civretro/ui/recorder.js`, validated against the live
`LocalStorage.sqlite`, older deployed recorders, and the legacy
`fixtures/traces/*.ndjson`. The exporter and parser both normalize toward this
contract so the viewer can stay source-agnostic.

```sh
pnpm install        # one-time
pnpm typecheck      # tsc --noEmit — the primary gate
pnpm check          # biome (lint + format); pnpm fix to apply
pnpm test           # vitest across shared/*
pnpm build          # tsc -b → shared/*/dist

pnpm export -- --latest        # full NDJSON from the recorder's LocalStorage.sqlite
pnpm export -- --turns         # list captured turns with a brief summary
pnpm parse  -- <save.Civ7Save> # decode a save file
pnpm launch -- --n-turns 20    # drive a game via CDP (needs Civ 7 on :9444)
```
