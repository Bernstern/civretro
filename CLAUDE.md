# CivRetro

## Tracking
- **Tasks**: https://app.notion.com/p/thenardog/3855fbc8ebdf800d8bf0e2fd69f4bd89?v=3855fbc8ebdf806db564000ca32fb546
- **Technical notes & findings**: https://app.notion.com/p/3855fbc8ebdf80bab931eb3d3c9943ab
- **Project**: https://app.notion.com/p/3855fbc8ebdf80da8391f1abed8457c0

Create tasks in Notion (not locally). Data source ID: `410c8774-11d0-44b7-bda6-c0cc4d6bf782`, Project relation: `https://app.notion.com/p/3855fbc8ebdf80da8391f1abed8457c0`.

## Repo layout
- `mods/` — game-side mods (raw JS; Coherent Gameface, no build): `civretro` (recorder, shipped), `civretro-harness` (dev; always-on autoplay), `civretro-probe` (dev; one-shot API dump).
- `shared/` — all-TypeScript data + automation layer (npm workspaces): `types` (Zod schema contract), `exporter` (LocalStorage.sqlite → NDJSON), `parser` (.Civ7Save → game state), `launcher` (CDP game automation).
- `app/` — the viewer (replay UI); stub for now.
- `fixtures/` — committed test data: `traces/` (recorder NDJSON), `saves/` (.Civ7Save samples).

## Deploy mods
```sh
bash deploy-mod.sh              # recorder only
bash deploy-mod.sh --harness    # recorder + AI harness
```

## TS tooling
```sh
npm test          # vitest across shared/*
npm run typecheck # tsc --noEmit
npm run build     # tsc -b shared/*
npm run export -- --latest     # NDJSON export from the recorder's LocalStorage.sqlite
npm run parse  -- <save.Civ7Save>
npm run launch -- --n-turns 20 --n-players 4   # drive a game via CDP (needs Civ 7 on :9444)
```
