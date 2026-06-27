import Database from 'better-sqlite3';
import {
  SessionMetaSchema,
  SessionIndexSchema,
  MapSnapshotSchema,
  TurnSnapshotSchema,
  type SessionMeta,
  type SessionIndex,
  type MapSnapshot,
  type TurnSnapshot,
} from '@civretro/types';

// recorder.js writes under the game's localStorage origin into the "Values"
// table (columns: id, key, value). Mirrors tools/read_localstorage.py.
const ORIGIN = 'fs://game';
const TURN_PREFIX = 'civretro:t:';
const MAP_PREFIX = 'civretro:map:';

export type Db = Database.Database;

export const openDb = (path: string): Db =>
  new Database(path, { readonly: true, fileMustExist: true });

interface ValueRow {
  value: string;
}
interface KeyValueRow {
  key: string;
  value: string;
}

const readValue = (db: Db, key: string): unknown => {
  const row = db
    .prepare('SELECT value FROM "Values" WHERE id = ? AND key = ?')
    .get(ORIGIN, key) as ValueRow | undefined;
  return row ? JSON.parse(row.value) : null;
};

const readPrefix = (db: Db, prefix: string): KeyValueRow[] =>
  db
    .prepare('SELECT key, value FROM "Values" WHERE id = ? AND key LIKE ?')
    .all(ORIGIN, `${prefix}%`) as KeyValueRow[];

export const getSession = (db: Db): SessionMeta | null => {
  const raw = readValue(db, 'civretro:session');
  if (raw === null) return null;
  const parsed = SessionMetaSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Failed to parse civretro:session: ${parsed.error.message}`);
  return parsed.data;
};

export const getIndex = (db: Db): SessionIndex | null => {
  const raw = readValue(db, 'civretro:index');
  if (raw === null) return null;
  const parsed = SessionIndexSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Failed to parse civretro:index: ${parsed.error.message}`);
  return parsed.data;
};

export const getTurn = (db: Db, globalTurn: number): TurnSnapshot | null => {
  const raw = readValue(db, `${TURN_PREFIX}${globalTurn}`);
  if (raw === null) return null;
  const parsed = TurnSnapshotSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Failed to read turn ${globalTurn}: ${parsed.error.message}`);
  return parsed.data;
};

// LIKE returns keys in lexicographic order (t:10 before t:2), so re-sort by the
// numeric globalTurn parsed out of each key.
export const getAllTurns = (db: Db): TurnSnapshot[] =>
  readPrefix(db, TURN_PREFIX)
    .map((row) => ({ n: Number(row.key.slice(TURN_PREFIX.length)), value: row.value }))
    .sort((a, b) => a.n - b.n)
    .map(({ n, value }) => {
      const parsed = TurnSnapshotSchema.safeParse(JSON.parse(value));
      if (!parsed.success) throw new Error(`Failed to read turn ${n}: ${parsed.error.message}`);
      return parsed.data;
    });

export const getAllMapSnapshots = (db: Db): MapSnapshot[] =>
  readPrefix(db, MAP_PREFIX)
    .map(({ key, value }) => {
      const parsed = MapSnapshotSchema.safeParse(JSON.parse(value));
      if (!parsed.success) throw new Error(`Failed to read map snapshot ${key}: ${parsed.error.message}`);
      return parsed.data;
    })
    .sort((a, b) => a.age - b.age);
