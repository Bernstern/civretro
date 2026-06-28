import Database from "better-sqlite3";

const DB_PATH =
  "/mnt/c/Users/Bernie Conrad/AppData/Local/Firaxis Games/Sid Meier's Civilization VII/LocalStorage.sqlite";
const ORIGIN = "fs://game";

// Open read-only so we never corrupt the game's database.
let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return db;
}

export function readLS(key: string): string | null {
  try {
    const row = getDb()
      .prepare('SELECT value FROM "Values" WHERE id = ? AND key = ?')
      .get(ORIGIN, key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function readLSJson<T>(key: string): T | null {
  const raw = readLS(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
