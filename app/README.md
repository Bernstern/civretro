# @civretro/viewer (stub)

The replay app — not built yet. It will load an NDJSON export (from
`shared/exporter`, or eventually `shared/parser`) and render the map (the
`owners` grid + `map_snapshot` tiles) with a turn scrubber driven by
`globalTurn`.

## Input contract

One JSON object per line, each tagged with a `type` discriminator and validated
by `@civretro/types` (`ExportRecordSchema`):

- `{ "type": "session", ... }` — once, first line (`SessionMeta`)
- `{ "type": "map_snapshot", ... }` — one per age (`MapSnapshot`)
- `{ "type": "turn", ... }` — one per global turn, ordered by `globalTurn` (`TurnSnapshot`)

Produce a sample to develop against:

```sh
npm run export -- --latest > session.ndjson
```

The viewer depends only on `@civretro/types` for these shapes — it does no
parsing of its own.
