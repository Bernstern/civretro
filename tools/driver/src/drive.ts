import { CDP } from "./cdp.js";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
  };
  return {
    turns:   parseInt(get("--turns",   "10"), 10),
    players: parseInt(get("--players", "2"),  10),
    speed:   get("--speed",    "online"),
    mapSize: get("--map-size", "tiny"),
    seed:    argv.includes("--seed") ? parseInt(get("--seed", "0"), 10) : null,
  };
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

async function connectWithRetry(maxMs: number): Promise<CDP> {
  const deadline = Date.now() + maxMs;
  let lastWarnAt = 0;
  while (Date.now() < deadline) {
    try {
      const cdp = new CDP();
      await cdp.connect();
      return cdp;
    } catch {
      // not ready yet
    }
    const now = Date.now();
    if (now - lastWarnAt >= 10_000) {
      log("waiting for CDP...");
      lastWarnAt = now;
    }
    await sleep(2000);
  }
  throw new Error(
    `Could not connect to Civ 7 CDP after ${maxMs / 1000}s.\n` +
    `  Is Civ 7 running? Add -dev to Steam launch options:\n` +
    `  Steam → right-click Civ 7 → Properties → Launch Options → -dev`
  );
}

async function tryEval<T>(cdp: CDP, js: string, fallback?: T): Promise<T> {
  try {
    return await cdp.eval<T>(js);
  } catch {
    return fallback as T;
  }
}

// ---------------------------------------------------------------------------
// Harness config & state — written to localStorage before each game launch.
// The harness mod reads these to configure Autoplay and track global turns.
// ---------------------------------------------------------------------------

interface HarnessConfig {
  turns:     number;  // global turn target (0 = unlimited)
  observeAs: number;  // player index to observe as (-1 = omniscient)
  returnAs:  number;  // player index to return control to when done
  runId:     string;  // unique per-launch; harness uses it to detect a fresh game
}

interface HarnessState {
  runId:       string;  // matches HarnessConfig.runId; harness resets turnsPlayed if mismatch
  turnsPlayed: number;
}

interface GameOverSignal {
  sessionId:   string | null;
  reason:      string;
  ageTurn:     number | null;
  globalTurn:  number | null;
  ts:          number;
}

function generateRunId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Set a localStorage key inside the Civ 7 JS context.
// Double-stringify so the value arrives as a JS string literal regardless of content.
async function setLS(cdp: CDP, key: string, value: unknown): Promise<void> {
  await cdp.eval(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(value))})`);
}

async function removeLS(cdp: CDP, key: string): Promise<void> {
  await cdp.eval(`localStorage.removeItem(${JSON.stringify(key)})`);
}

// ---------------------------------------------------------------------------
// Game setup
// ---------------------------------------------------------------------------

async function configureAndLaunch(cdp: CDP, args: ReturnType<typeof parseArgs>): Promise<void> {
  const runId = generateRunId();

  const config: HarnessConfig = {
    turns:     args.turns,
    observeAs: -1,
    returnAs:  0,
    runId,
  };

  const state: HarnessState = {
    runId,
    turnsPlayed: 0,
  };

  await setLS(cdp, "civretro:config",        config);
  await setLS(cdp, "civretro:harness_state", state);
  await removeLS(cdp, "civretro:game_over");
  await setLS(cdp, "civretro:forceNewSession", "1");
  await setLS(cdp, "civretro:debug",           "1");
  log(`localStorage written (runId=${runId})`);

  const speedMap: Record<string, string> = {
    online: "GAMESPEED_ONLINE", quick: "GAMESPEED_QUICK",
    standard: "GAMESPEED_STANDARD", epic: "GAMESPEED_EPIC",
  };
  const sizeMap: Record<string, string> = {
    tiny: "MAPSIZE_TINY", small: "MAPSIZE_SMALL",
    standard: "MAPSIZE_STANDARD", large: "MAPSIZE_LARGE",
  };

  await cdp.eval("Configuration.editGame().reset()");
  await sleep(500);

  if (args.seed != null) {
    await cdp.eval(
      `Configuration.editMap().setMapSeed(${args.seed}); Configuration.editGame().setGameSeed(${args.seed});`
    );
  }
  await cdp.eval(
    `Configuration.editGame().setGameSpeedType("${speedMap[args.speed] ?? "GAMESPEED_ONLINE"}")`
  );
  await cdp.eval(
    `Configuration.editMap().setMapSize("${sizeMap[args.mapSize] ?? "MAPSIZE_TINY"}")`
  );

  const playerSetup = `(function() {
    var ids = Configuration.getGame().inUsePlayerIDs;
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (i < ${args.players}) {
        Configuration.editPlayer(id).setSlotStatus(SlotStatus.SS_COMPUTER);
      } else {
        Configuration.editPlayer(id).setSlotStatus(SlotStatus.SS_CLOSED);
      }
    }
    return 'configured ' + ${args.players} + ' AI players';
  })()`;
  const setupResult = await cdp.eval<string>(playerSetup);
  log(setupResult ?? "players configured");

  log("launching game...");
  await cdp.eval("Network.hostGame(ServerType.SERVER_TYPE_NONE)");
}

// ---------------------------------------------------------------------------
// Post-launch reconnect
// ---------------------------------------------------------------------------

async function waitForGameReady(maxMs: number): Promise<CDP> {
  log("waiting for game to load...");
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const cdp = new CDP();
      await cdp.connect();
      const ready = await tryEval<boolean>(
        cdp,
        `typeof Game !== 'undefined' && typeof Game.turn !== 'undefined'`
      );
      if (ready) {
        log("game ready");
        return cdp;
      }
      await cdp.close();
    } catch {
      // still loading
    }
  }
  throw new Error("game never became ready");
}

// ---------------------------------------------------------------------------
// Autoplay
// ---------------------------------------------------------------------------

async function activateAutoplay(cdp: CDP): Promise<string> {
  const result = await tryEval<string>(cdp, `
    (function() {
      try {
        if (typeof Autoplay === 'undefined') return 'unavailable';
        Autoplay.setReturnAsPlayer(0);
        Autoplay.setObserveAsPlayer(-1);
        try { Configuration.getUser().setLockedValue("QuickMovement", true); } catch(_) {}
        try { Configuration.getUser().setLockedValue("QuickCombat",   true); } catch(_) {}
        var was = Autoplay.isActive;
        if (!was) Autoplay.setActive(true);
        return (was ? 'already-active' : 'activated') + ':' + Autoplay.isActive;
      } catch(e) { return 'err:' + e.message; }
    })()
  `, "unavailable");
  return result ?? "unavailable";
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function dismissNotifications(cdp: CDP): Promise<number> {
  const raw = await tryEval<string>(cdp, `
    (function() {
      try {
        var out = [];
        var ids = new Set();
        for (var pid = 0; pid < 8; pid++) {
          try {
            var nids = Notifications.getIdsForPlayer(pid);
            if (nids) for (var i = 0; i < nids.length; i++) ids.add(nids[i]);
          } catch(_) {}
        }
        ids.forEach(function(nid) {
          try {
            var canDismiss = !!Notifications.canUserDismissNotification(nid);
            var type = '';
            var summary = '';
            try { type = String(Notifications.getType(nid)); } catch(_) {}
            try { summary = String(Notifications.getSummary(nid)); } catch(_) {}
            if (canDismiss) Notifications.dismiss(nid);
            out.push({ nid: nid, type: type, summary: summary, dismissed: canDismiss });
          } catch(_) {}
        });
        return JSON.stringify(out);
      } catch(e) { return JSON.stringify([]); }
    })()
  `, "[]");

  const notifications: Array<{ nid: number; type: string; summary: string; dismissed: boolean }> =
    JSON.parse(raw ?? "[]");

  let dismissed = 0;
  for (const n of notifications) {
    log(`  notification id=${n.nid} type=${n.type} summary="${n.summary}" dismissed=${n.dismissed}`);
    if (n.dismissed) dismissed++;
  }
  return dismissed;
}

// ---------------------------------------------------------------------------
// Recorder index helpers
// ---------------------------------------------------------------------------

interface RecorderIndex {
  session:  string;
  turns:    number[];
  lastTurn: number;
}

async function readRecorderIndex(cdp: CDP): Promise<RecorderIndex | null> {
  const raw = await tryEval<string>(
    cdp,
    `localStorage.getItem('civretro:index')`,
    null
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RecorderIndex;
  } catch {
    return null;
  }
}

async function readGameOver(cdp: CDP): Promise<GameOverSignal | null> {
  const raw = await tryEval<string>(
    cdp,
    `localStorage.getItem('civretro:game_over')`,
    null
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GameOverSignal;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main poll loop
// ---------------------------------------------------------------------------

interface PollResult {
  turns:   number;
  reason:  string;
  elapsed: number;
}

async function pollUntilDone(cdp: CDP, targetTurns: number, timeoutMs: number): Promise<PollResult> {
  const start = Date.now();
  const deadline = start + timeoutMs;

  let lastProgressAt = Date.now();
  let lastRecordedTurn = -1;
  let lastAutoplayState = "";

  while (Date.now() < deadline) {
    await sleep(2000);

    // 1. Keep Autoplay active. The harness owns turn-limit math via TurnEnd.
    const apState = await activateAutoplay(cdp);
    if (apState !== lastAutoplayState) {
      log(`autoplay: ${apState}`);
      lastAutoplayState = apState;
    }

    // 2. Dismiss pending notifications
    await dismissNotifications(cdp);

    // 3. Read recorder index
    const idx = await readRecorderIndex(cdp);
    if (idx !== null) {
      if (idx.lastTurn !== lastRecordedTurn) {
        log(`recorder: session=${idx.session} turn=${idx.lastTurn}/${targetTurns} (${idx.turns.length} turns recorded)`);
        lastRecordedTurn = idx.lastTurn;
        lastProgressAt = Date.now();
      }
    }

    // 4. Check game_over signal written by the harness mod
    const gameOver = await readGameOver(cdp);
    if (gameOver) {
      log(`game over: reason=${gameOver.reason} globalTurn=${gameOver.globalTurn}`);
      return {
        turns:   gameOver.globalTurn ?? lastRecordedTurn,
        reason:  gameOver.reason,
        elapsed: Date.now() - start,
      };
    }

    // 5. Hang detection (no recorder progress for 300s)
    if (Date.now() - lastProgressAt > 300_000) {
      log(`WARNING: no recorder progress for 300s — aborting`);
      return {
        turns:   lastRecordedTurn >= 0 ? lastRecordedTurn : 0,
        reason:  "hang_detected",
        elapsed: Date.now() - start,
      };
    }
  }

  return {
    turns:   lastRecordedTurn >= 0 ? lastRecordedTurn : 0,
    reason:  "timeout",
    elapsed: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  log(`civretro driver — turns=${args.turns} players=${args.players} speed=${args.speed} map=${args.mapSize}${args.seed != null ? ` seed=${args.seed}` : ""}`);

  log("connecting to Civ 7...");
  let cdp = await connectWithRetry(60_000);
  log("connected");

  const inShell = await tryEval<boolean>(cdp, "UI.isInShell()");
  if (!inShell) {
    log("WARNING: game already running — will attempt to continue from current state");
  } else {
    await configureAndLaunch(cdp, args);
    await cdp.close();
    cdp = await waitForGameReady(120_000);
  }

  log("activating Autoplay...");
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await activateAutoplay(cdp);
    log(`  autoplay: ${result}`);
    if (result.startsWith("activated") || result.startsWith("already-active")) break;
    await sleep(1000);
  }

  log("running game...");
  const result = await pollUntilDone(cdp, args.turns, 600_000);

  log("exiting to main menu...");
  await tryEval(cdp, 'engine.call("exitToMainMenu")');
  await cdp.close();

  log(`done — turns=${result.turns} reason=${result.reason} elapsed=${Math.round(result.elapsed / 1000)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
