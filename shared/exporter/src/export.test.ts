import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExportRecordSchema, type TurnRecord } from '@civretro/types';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Db } from './db.js';
import { buildRecords, toNdjson, turnSummary } from './export.js';

// Build an in-memory LocalStorage.sqlite seeded from a real trace fixture,
// reshaped into the recorder's localStorage layout (civretro:session / :index /
// :t:{n} / :map:{age}). This exercises db.ts + export.ts end to end without the
// live game DB.

const TRACE = fileURLToPath(
  new URL('../../../fixtures/traces/20260621_003428_25t_4p_validation-a.ndjson', import.meta.url),
);
const ORIGIN = 'fs://game';

const RunMetaSchema = z.object({
  session: z.string(),
  ts: z.number(),
  config: z.object({ mode: z.string() }),
});

const TraceTurnSchema = z.object({
  turn: z.number(),
  age: z.number(),
  ts: z.number(),
  mapW: z.number(),
  mapH: z.number(),
  players: z.array(z.unknown()),
  owners: z.array(z.number()),
});

const lineKind = (line: unknown): string => {
  const parsed = z.object({ type: z.string() }).safeParse(line);
  return parsed.success ? parsed.data.type : '';
};

const seedDb = (): Db => {
  const lines = readFileSync(TRACE, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l): unknown => JSON.parse(l));

  const runmetaLine = lines.find((l) => lineKind(l) === 'runmeta');
  if (!runmetaLine) throw new Error('fixture has no runmeta line');
  const runmeta = RunMetaSchema.parse(runmetaLine);

  const turns = lines.filter((l) => lineKind(l) === 'turn').map((l) => TraceTurnSchema.parse(l));
  const firstTurn = turns[0];
  if (!firstTurn) throw new Error('fixture has no turn lines');

  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE "Values"("id" TEXT NOT NULL, "key" TEXT NOT NULL, "value" TEXT NOT NULL, PRIMARY KEY("id","key")) WITHOUT ROWID',
  );
  const insert = db.prepare('INSERT INTO "Values"(id, key, value) VALUES (?, ?, ?)');
  const put = (key: string, value: unknown): void => {
    insert.run(ORIGIN, key, JSON.stringify(value));
  };

  put('civretro:session', {
    id: runmeta.session,
    startTurn: 1,
    age: firstTurn.age,
    ts: runmeta.ts,
    localPlayerId: 0,
    isMP: runmeta.config.mode === 'mp',
  });

  // Reshape each legacy trace turn into a recorder TurnSnapshot.
  turns.forEach((t, i) => {
    put(`civretro:t:${i + 1}`, {
      globalTurn: i + 1,
      ageTurn: t.turn,
      age: t.age,
      ts: t.ts,
      mapW: t.mapW,
      mapH: t.mapH,
      localPlayerId: 0,
      players: t.players,
      owners: t.owners,
    });
  });

  put('civretro:index', {
    sessionId: runmeta.session,
    turns: turns.map((_, i) => i + 1),
    totalTurns: turns.length,
    latest: turns.length,
    lastTs: turns.at(-1)?.ts ?? firstTurn.ts,
    ages: [],
  });

  // One synthetic map snapshot per distinct age the turns cover.
  for (const age of new Set(turns.map((t) => t.age))) {
    put(`civretro:map:${age}`, {
      sessionId: runmeta.session,
      age,
      globalTurnAtCapture: 0,
      ts: runmeta.ts,
      mapW: 2,
      mapH: 1,
      tiles: [
        { terrain: 4, resource: -1, feature: -1 },
        { terrain: 4, resource: -1, feature: -1 },
      ],
    });
  }

  return db;
};

describe('export from a seeded DB', () => {
  let db: Db;
  beforeAll(() => {
    db = seedDb();
  });

  it('emits session first, then map snapshots, then turns', () => {
    const records = buildRecords(db);
    expect(records.at(0)?.type).toBe('session');

    const types = records.map((r) => r.type);
    const firstTurn = types.indexOf('turn');
    const lastMap = types.lastIndexOf('map_snapshot');
    expect(lastMap).toBeLessThan(firstTurn);
    expect(types.filter((t) => t === 'session')).toHaveLength(1);
    expect(types.filter((t) => t === 'map_snapshot').length).toBeGreaterThan(0);
  });

  it('orders turn records by globalTurn', () => {
    const turns = buildRecords(db).filter((r): r is TurnRecord => r.type === 'turn');
    const globalTurns = turns.map((t) => t.globalTurn);
    expect(globalTurns).toEqual([...globalTurns].sort((a, b) => a - b));
    expect(globalTurns.at(0)).toBe(1);
  });

  it('produces NDJSON whose every line parses against ExportRecordSchema', () => {
    const ndjson = toNdjson(buildRecords(db));
    expect(ndjson.endsWith('\n')).toBe(true);
    const lines = ndjson.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      const result = ExportRecordSchema.safeParse(JSON.parse(line));
      if (!result.success) {
        throw new Error(`record failed: ${JSON.stringify(result.error.issues.slice(0, 3))}`);
      }
    }
  });

  it('formats a --turns summary line', () => {
    const turns = buildRecords(db).filter((r): r is TurnRecord => r.type === 'turn');
    const first = turns.at(0);
    if (!first) throw new Error('expected at least one turn record');
    const summary = turnSummary(first);
    // e.g. "  g1/t4 age=Antiquity 60x38 players=[p0(...) gold=15 cities=1 units=1, ...]"
    // (globalTurn is 1; the trace's first captured age-turn happens to be 4).
    expect(summary).toMatch(/^ {2}g1\/t\d+ age=\S+ \d+x\d+ players=\[p\d+\(.*\)/);
    expect(summary).toContain('gold=');
    expect(summary).toContain('units=');
  });

  it('empty record set yields empty NDJSON', () => {
    expect(toNdjson([])).toBe('');
  });
});
