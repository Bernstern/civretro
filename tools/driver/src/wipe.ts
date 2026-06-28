// wipe.ts — remove all civretro data from LocalStorage.sqlite and manifests.
// Safety: aborts if CDP is reachable (game is running).
// Usage: npx tsx src/wipe.ts [--force]

import Database from "better-sqlite3";
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { CDP } from "./cdp.js";

const DB_PATH =
  "/mnt/c/Users/Bernie Conrad/AppData/Local/Firaxis Games/Sid Meier's Civilization VII/LocalStorage.sqlite";
const MANIFEST_DIR =
  "/mnt/c/Users/Bernie Conrad/AppData/Local/Firaxis Games/Sid Meier's Civilization VII/ModUserData/civretro";
const ORIGIN = "fs://game";

async function gameIsRunning(): Promise<boolean> {
  const cdp = new CDP();
  try {
    await cdp.connect();
    await cdp.close();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const force = process.argv.includes("--force");

  if (await gameIsRunning()) {
    console.error("ERROR: Civ 7 is running. Close the game before wiping.");
    process.exit(1);
  }

  if (!existsSync(DB_PATH)) {
    console.error("ERROR: LocalStorage.sqlite not found at expected path.");
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  let keysDeleted = 0;
  try {
    const rows = db
      .prepare(`SELECT key FROM "Values" WHERE id = ? AND key LIKE 'civretro:%'`)
      .all(ORIGIN) as { key: string }[];

    if (rows.length === 0) {
      console.log("No civretro keys found in LocalStorage.sqlite.");
    } else {
      if (!force) {
        console.log(`Found ${rows.length} civretro keys in LocalStorage.sqlite.`);
        console.log("Run with --force to delete them.");
        db.close();
        process.exit(0);
      }
      const del = db.prepare(`DELETE FROM "Values" WHERE id = ? AND key = ?`);
      const deleteAll = db.transaction(() => {
        for (const r of rows) del.run(ORIGIN, r.key);
      });
      deleteAll();
      keysDeleted = rows.length;
      console.log(`Deleted ${keysDeleted} civretro keys from LocalStorage.sqlite.`);
    }
  } finally {
    db.close();
  }

  // Wipe manifests
  let manifestsDeleted = 0;
  if (existsSync(MANIFEST_DIR)) {
    const files = readdirSync(MANIFEST_DIR).filter(f => f.endsWith(".json"));
    if (files.length === 0) {
      console.log("No manifests found.");
    } else if (!force) {
      console.log(`Found ${files.length} manifest(s) in ModUserData/civretro/. Run with --force to delete.`);
    } else {
      for (const f of files) {
        rmSync(join(MANIFEST_DIR, f));
        manifestsDeleted++;
      }
      console.log(`Deleted ${manifestsDeleted} manifest file(s).`);
    }
  }

  if (force) {
    console.log(`Done — wiped ${keysDeleted} keys, ${manifestsDeleted} manifests.`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
