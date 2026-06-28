import { CDP } from "./cdp.js";
import { readLSJson } from "./sqlite.js";

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
  const turns = parseInt(get("--turns", "10"), 10);
  // Default timeout: 8s/turn + 90s buffer. Online speed at 2 players runs ~4s/turn;
  // 2× headroom keeps the bound tight enough to catch hangs quickly.
  const defaultTimeoutS = turns * 8 + 90;
  const timeoutS = parseInt(get("--timeout", String(defaultTimeoutS)), 10);
  return {
    turns,
    players:   parseInt(get("--players", "2"), 10),
    speed:     get("--speed",    "online"),
    mapSize:   get("--map-size", "tiny"),
    seed:      argv.includes("--seed") ? parseInt(get("--seed", "0"), 10) : null,
    timeoutMs: timeoutS * 1000,
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

// fallback is required — callers must be explicit about what they want on failure.
// Use cdp.eval() directly when a failure should propagate as an error.
async function tryEval<T>(cdp: CDP, js: string, fallback: T): Promise<T> {
  try {
    return await cdp.eval<T>(js);
  } catch {
    return fallback;
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
  runId?:      string;  // present in harness v2+; used to reject stale signals
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

interface LaunchContext {
  config: HarnessConfig;
  state:  HarnessState;
}

async function configureAndLaunch(cdp: CDP, args: ReturnType<typeof parseArgs>): Promise<LaunchContext> {
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

  const speed = speedMap[args.speed];
  if (!speed) throw new Error(`Unknown --speed "${args.speed}". Valid: ${Object.keys(speedMap).join(", ")}`);
  const mapSize = sizeMap[args.mapSize];
  if (!mapSize) throw new Error(`Unknown --map-size "${args.mapSize}". Valid: ${Object.keys(sizeMap).join(", ")}`);

  await cdp.eval("Configuration.editGame().reset()");
  await sleep(500);

  if (args.seed != null) {
    await cdp.eval(
      `Configuration.editMap().setMapSeed(${args.seed}); Configuration.editGame().setGameSeed(${args.seed});`
    );
  }
  await cdp.eval(`Configuration.editGame().setGameSpeedType("${speed}")`);
  await cdp.eval(`Configuration.editMap().setMapSize("${mapSize}")`);

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
  log(await cdp.eval<string>(playerSetup));

  log("launching game...");
  await cdp.eval("Network.hostGame(ServerType.SERVER_TYPE_NONE)");
  return { config, state };
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
        `typeof Game !== 'undefined' && typeof Game.turn !== 'undefined'`,
        false
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
  return tryEval<string>(cdp, `
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
    JSON.parse(raw);

  let dismissed = 0;
  for (const n of notifications) {
    log(`  notification id=${n.nid} type=${n.type} summary="${n.summary}" dismissed=${n.dismissed}`);
    if (n.dismissed) dismissed++;
  }
  return dismissed;
}

// ---------------------------------------------------------------------------
// Recorder index + game-over — read from sqlite, not CDP eval.
//
// The recorder and harness mods write to localStorage from within the game's
// mod execution context. CDP Runtime.evaluate runs in the main page context.
// These share the same sqlite backing store but have separate in-memory caches,
// so CDP eval sees stale data. Reading sqlite directly gives live values.
// ---------------------------------------------------------------------------

interface RecorderIndex {
  sessionId:  string;
  turns:      number[];
  latest:     number;
  totalTurns: number;
}

function readRecorderIndex(): RecorderIndex | null {
  const v = readLSJson<RecorderIndex>("civretro:index");
  if (
    !v ||
    typeof v.sessionId   !== "string" ||
    typeof v.latest      !== "number" ||
    typeof v.totalTurns  !== "number"
  ) return null;
  return v;
}

function readGameOver(runId: string, debug = false): GameOverSignal | null {
  const signal = readLSJson<GameOverSignal>("civretro:game_over");
  if (debug) log(`  game_over sqlite: ${JSON.stringify(signal)}`);
  if (!signal) return null;
  if (!signal.reason || typeof signal.reason !== "string") {
    if (debug) log(`  game_over rejected: no valid reason field`);
    return null;
  }
  if (signal.runId && signal.runId !== runId) {
    if (debug) log(`  game_over rejected: runId mismatch (got ${signal.runId}, want ${runId})`);
    return null;
  }
  return signal;
}

// ---------------------------------------------------------------------------
// Main poll loop
// ---------------------------------------------------------------------------

interface PollResult {
  turns:   number;
  reason:  string;
  elapsed: number;
}

async function pollUntilDone(cdp: CDP, runId: string, targetTurns: number, timeoutMs: number): Promise<PollResult> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  // No recorder progress for half the total budget (min 60s) → abort as hung.
  const hangMs = Math.max(60_000, timeoutMs / 2);

  // Snapshot the session that was in the index when the game loaded.
  // The recorder will switch to a new sessionId once it fires GameStarted for
  // this game; we ignore turn counts until that happens so stale sqlite data
  // from the previous game doesn't trigger a false turn-limit hit.
  const priorSession = readRecorderIndex()?.sessionId ?? null;

  let lastProgressAt = Date.now();
  let lastRecordedTurn = -1;       // global turns (accumulated across ages)
  let lastAutoplayState = "";

  // Age-transition accumulator: each age creates a new recorder session and
  // resets idx.latest back to 1. We sum up completed-age turn counts so that
  // lastRecordedTurn always reflects true global turns across all ages.
  let accumulatedTurns = 0;        // sum of turns from all completed ages
  let activeSession: string | null = null;
  let activeSessionMax = 0;        // highest idx.latest seen in the current age

  while (Date.now() < deadline) {
    await sleep(2000);

    // 1. Keep Autoplay active.
    const apState = await activateAutoplay(cdp);
    if (apState !== lastAutoplayState) {
      log(`autoplay: ${apState}`);
      lastAutoplayState = apState;
    }

    // 2. Dismiss pending notifications
    await dismissNotifications(cdp);

    // 3. Read recorder index — source of truth for global turns played.
    const idx = readRecorderIndex();
    if (idx !== null && idx.sessionId !== priorSession) {
      // Detect age transition: session changed → freeze previous age's count.
      if (activeSession !== null && idx.sessionId !== activeSession) {
        accumulatedTurns += activeSessionMax;
        activeSessionMax = 0;
      }
      activeSession = idx.sessionId;

      const ageTurn = idx.latest;
      if (ageTurn > activeSessionMax) activeSessionMax = ageTurn;
      const globalTurn = accumulatedTurns + ageTurn;

      if (globalTurn !== lastRecordedTurn) {
        log(`recorder: session=${idx.sessionId} age_turn=${ageTurn} global=${globalTurn}/${targetTurns}`);
        lastRecordedTurn = globalTurn;
        lastProgressAt = Date.now();
      }

      // Driver-enforced turn limit — authoritative, since the harness's
      // in-harness localStorage counter loses state across age reloads.
      if (targetTurns > 0 && lastRecordedTurn >= targetTurns) {
        log(`turn target reached (${lastRecordedTurn}/${targetTurns}) — stopping autoplay`);
        await tryEval(cdp, `try { Autoplay.setActive(false); } catch(e) {}`);
        await sleep(1500);  // let AutoplayEnded fire and harness write game_over
        const go = readGameOver(runId);
        if (go) {
          if (go.globalTurn == null) log(`WARNING: game_over has no globalTurn — using recorder count ${lastRecordedTurn}`);
          log(`game over: reason=${go.reason} globalTurn=${go.globalTurn ?? lastRecordedTurn}`);
          return { turns: go.globalTurn ?? lastRecordedTurn, reason: go.reason, elapsed: Date.now() - start };
        }
        // Harness didn't write game_over (e.g. gameOverWritten already set) — synthesize it.
        return { turns: lastRecordedTurn, reason: "turn_limit", elapsed: Date.now() - start };
      }
    }

    // 4. Check game_over signal written by the harness.
    const gameOver = readGameOver(runId, lastRecordedTurn < 0);
    if (gameOver) {
      if (gameOver.globalTurn == null) log(`WARNING: game_over has no globalTurn — using recorder count ${lastRecordedTurn}`);
      log(`game over: reason=${gameOver.reason} globalTurn=${gameOver.globalTurn ?? lastRecordedTurn}`);
      return {
        turns:   gameOver.globalTurn ?? lastRecordedTurn,
        reason:  gameOver.reason,
        elapsed: Date.now() - start,
      };
    }

    // 5. Hang detection — no recorder progress for half the total timeout.
    if (Date.now() - lastProgressAt > hangMs) {
      log(`WARNING: no recorder progress for ${Math.round(hangMs / 1000)}s — aborting`);
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
  log(`civretro driver — turns=${args.turns} players=${args.players} speed=${args.speed} map=${args.mapSize} timeout=${Math.round(args.timeoutMs / 1000)}s${args.seed != null ? ` seed=${args.seed}` : ""}`);

  log("connecting to Civ 7...");
  let cdp = await connectWithRetry(60_000);
  log("connected");

  const inShell = await cdp.eval<boolean>("UI.isInShell()");
  if (!inShell) {
    await cdp.close();
    throw new Error("A game is already running. Return to the main menu before launching the driver.");
  }

  const ctx = await configureAndLaunch(cdp, args);
  const config = ctx.config;
  const state  = ctx.state;
  const runId  = config.runId;
  await cdp.close();
  cdp = await waitForGameReady(120_000);

  // Re-write config & harness_state from inside the game context.
  // The shell-context writes go to sqlite, but Coherent Gameface's game-context
  // in-memory cache can start stale. Re-writing here ensures the harness sees
  // the correct values regardless of cache behavior.
  log(`applying harness config in game context (runId=${runId})...`);
  await setLS(cdp, "civretro:config",        config);
  await setLS(cdp, "civretro:harness_state", state);
  await removeLS(cdp, "civretro:game_over");
  const verifyGO = await tryEval<string | null>(cdp, `localStorage.getItem('civretro:game_over')`, null);
  if (verifyGO) log(`  WARNING: game_over still present: ${verifyGO.slice(0, 80)}`);

  log("activating Autoplay...");
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await activateAutoplay(cdp);
    log(`  autoplay: ${result}`);
    if (result.startsWith("activated") || result.startsWith("already-active")) break;
    await sleep(1000);
  }

  // Belt-and-suspenders: call notifyUIReady from the driver side so the Begin
  // Game screen is dismissed even if the harness's whenReady callback already
  // ran before the driver had a chance to activate Autoplay.
  await tryEval(cdp, `try { UI.notifyUIReady(); } catch(e) {}`);

  log("running game...");
  const result = await pollUntilDone(cdp, runId, args.turns, args.timeoutMs);

  log("exiting to main menu...");
  await tryEval(cdp, 'engine.call("exitToMainMenu")');
  // Wait for the shell (main menu) to be active before closing. The exit
  // command is async — the game needs a few seconds to transition.
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const inShell = await tryEval<boolean>(cdp, "UI.isInShell()", false);
    if (inShell) break;
  }
  await cdp.close();

  log(`done — turns=${result.turns} reason=${result.reason} elapsed=${Math.round(result.elapsed / 1000)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
