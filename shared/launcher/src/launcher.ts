/**
 * Game launch helpers — connect to CDP, navigate menus, start an all-AI game,
 * wait for readiness, and activate Autoplay.
 *
 * Launcher <-> Game Protocol
 *
 *   Pre-launch (menu context, shared fs://game localStorage):
 *     civretro:config          = JSON {turns, observeAs, returnAs}
 *     civretro:forceNewSession = "1"   (consumed by recorder on first eval)
 *
 *   Post-load injection (CDP -> game context):
 *     window.__civretro        = {turns, observeAs, returnAs}  (fallback)
 *
 *   Harness mod reads civretro:config -> Autoplay.setActive(true).
 *   Recorder mod writes civretro:index = {sessionId, turns[], totalTurns, ...}.
 *   Launcher polls civretro:index.totalTurns every 5s until >= nTurns,
 *   then sends exitToMainMenu.
 */

import { type SessionIndex, SessionIndexSchema } from '@civretro/types';
import { z } from 'zod';

import { CDP_PORT, type CdpClient, createCdpClient, evalAny } from './cdp.js';
import { getLogger } from './log.js';
import { READINESS_JS } from './queries.js';

const log = getLogger('civretro.launcher');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Relative monotonic clock in seconds (mirrors Python's time.monotonic()).
const monotonic = (): number => performance.now() / 1000;

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'Error');
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Ad-hoc shapes parsed out of CDP eval results (Game.turn / Game.age probes).
const TurnProbeSchema = z.object({ turn: z.number() }).partial();
const GameInfoSchema = z.object({ turn: z.unknown(), age: z.unknown() }).partial();
const PriorIndexSchema = z.object({ sessionId: z.string() }).partial();

export class RunError extends Error {}

export interface RunConfig {
  nTurns: number;
  nPlayers: number;
  seed: number | null;
  mode: string;
  speed: string;
  mapSize: string;
  mapType: string | null;
}

export interface RunResult {
  elapsed: number;
  turnsCaptured: number;
  nTurns: number;
}

interface AutoplayResult {
  turnsCaptured: number;
  sessionId?: string;
  timedOut?: boolean;
}

export const connectWithRetry = async (maxWait = 120): Promise<CdpClient | null> => {
  const c = createCdpClient();
  for (let i = 0; i < maxWait; i++) {
    try {
      await c.connect();
      log.info(`connected to CDP on port ${CDP_PORT}`);
      return c;
    } catch {
      if (i === 0) {
        log.warn(
          `Civ 7 not reachable on port ${CDP_PORT} — is the game running with the -dev Steam launch flag?`,
        );
      } else if (i % 15 === 0) {
        log.warn(`[${i}s] waiting for CDP on port ${CDP_PORT}...`);
      }
      await sleep(1000);
    }
  }
  return null;
};

/** Evaluate JS with one automatic reconnect attempt on failure. */
export const safeEval = async (c: CdpClient, js: string, timeoutSec = 30.0): Promise<unknown> => {
  try {
    return await evalAny(c, js, timeoutSec);
  } catch (e) {
    log.warn(`CDP error (${errName(e)}), reconnecting...`);
    try {
      await c.close();
    } catch {
      /* ignore */
    }
    const c2 = await connectWithRetry(30);
    if (c2) {
      // Hack: transplant the new WebSocket into the existing client so all
      // callers holding a reference to `c` automatically get the live socket.
      // c2 is intentionally not closed — its socket now lives in c.
      c.transplantSocket(c2);
      try {
        return await evalAny(c, js, timeoutSec);
      } catch {
        /* fall through */
      }
    }
  }
  return null;
};

/**
 * If a game is currently running, stop Autoplay and exit to the main menu.
 * Returns a (possibly new) CdpClient connected after the menu appears.
 */
export const ensureAtMenu = async (c: CdpClient): Promise<CdpClient> => {
  const inShell = await safeEval(c, 'UI.isInShell()', 5);
  if (inShell) return c;

  log.info('game already running — stopping Autoplay and returning to main menu...');

  // Stop Autoplay if active
  await safeEval(
    c,
    "(function(){ try { if (typeof Autoplay !== 'undefined' && Autoplay.isActive) " +
      '{ Autoplay.setActive(false); } } catch(e){} })()',
    5,
  );

  // Exit to menu — CDP will drop during transition
  try {
    await evalAny(c, 'engine.call("exitToMainMenu")', 5);
  } catch {
    /* ignore */
  }
  try {
    await c.close();
  } catch {
    /* ignore */
  }

  // Reconnect and wait for shell
  log.info('waiting for main menu...');
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const c2 = createCdpClient();
    try {
      await c2.connect();
      const shell = await evalAny(c2, 'UI.isInShell()', 5);
      if (shell) {
        log.info('at main menu');
        return c2;
      }
      await c2.close();
    } catch {
      /* ignore */
    }
  }

  log.warn('could not confirm return to main menu — proceeding anyway');
  const c3 = await connectWithRetry(30);
  return c3 ?? c;
};

// CLI string → DB type mappings (confirmed from config.xml)
const SPEED_MAP: Record<string, string> = {
  online: 'GAMESPEED_ONLINE',
  quick: 'GAMESPEED_QUICK',
  standard: 'GAMESPEED_STANDARD',
  epic: 'GAMESPEED_EPIC',
  marathon: 'GAMESPEED_MARATHON',
};
const MAP_SIZE_MAP: Record<string, string> = {
  tiny: 'MAPSIZE_TINY',
  small: 'MAPSIZE_SMALL',
  standard: 'MAPSIZE_STANDARD',
  large: 'MAPSIZE_LARGE',
  huge: 'MAPSIZE_HUGE',
};
const MAP_TYPE_MAP: Record<string, string> = {
  continents: '{base-standard}maps/continents.js',
  'continents-plus': '{base-standard}maps/continents-plus.js',
  archipelago: '{base-standard}maps/archipelago.js',
  fractal: '{base-standard}maps/fractal.js',
  'pangaea-plus': '{base-standard}maps/pangaea-plus.js',
  shuffle: '{base-standard}maps/shuffle.js',
  'terra-incognita': '{base-standard}maps/terra-incognita.js',
};

export const speedType = (name: string): string =>
  SPEED_MAP[name.toLowerCase()] ?? `GAMESPEED_${name.toUpperCase()}`;

export const mapSizeType = (name: string): string =>
  MAP_SIZE_MAP[name.toLowerCase()] ?? `MAPSIZE_${name.toUpperCase()}`;

export const mapTypeScript = (name: string): string => MAP_TYPE_MAP[name.toLowerCase()] ?? name;

/** Configure and start an all-AI game from the main menu. */
export const launchGame = async (
  c: CdpClient,
  nPlayers: number,
  seed: number | null,
  speed = 'online',
  mapSize = 'small',
  mapType: string | null = null,
  mode = 'sp',
): Promise<boolean> => {
  const inShell = await evalAny(c, 'UI.isInShell()', 5);
  if (!inShell) {
    log.error('not at main menu after ensureAtMenu — cannot launch');
    return false;
  }

  // Reset configuration
  await evalAny(c, 'Configuration.editGame().reset()', 5);

  // Wait for config revision to update
  const rev = await evalAny(c, 'GameSetup.currentRevision', 5);
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const newRev = await evalAny(c, 'GameSetup.currentRevision', 5);
    if (newRev !== rev) break;
  }

  // Apply map seed if specified
  if (seed !== null) {
    await evalAny(
      c,
      `Configuration.editMap().setMapSeed(${seed}); Configuration.editGame().setGameSeed(${seed});`,
      5,
    );
  }

  // Game speed
  const gameSpeed = speedType(speed);
  await evalAny(c, `Configuration.editGame().setGameSpeedType("${gameSpeed}")`, 5);
  log.info(`game speed: ${gameSpeed}`);

  // Map size
  const sizeType = mapSizeType(mapSize);
  await evalAny(c, `Configuration.editMap().setMapSize("${sizeType}")`, 5);
  log.info(`map size: ${sizeType}`);

  // Map type (optional)
  if (mapType) {
    const script = mapTypeScript(mapType);
    await evalAny(c, `Configuration.editMap().setScript("${script}")`, 5);
    log.info(`map type: ${script}`);
  }

  // Set player count — close slots beyond nPlayers
  const setupJs = `(function(){
      var game = Configuration.getGame();
      var inUse = game.inUsePlayerIDs;
      var closed = 0;
      for (var i = 0; i < inUse.length; i++) {
        var id = inUse[i];
        if (i >= ${nPlayers}) {
          Configuration.editPlayer(id).setSlotStatus(SlotStatus.SS_CLOSED);
          closed++;
        } else {
          Configuration.editPlayer(id).setSlotStatus(SlotStatus.SS_COMPUTER);
        }
      }
      return 'configured ' + ${nPlayers} + ' AI players, closed ' + closed;
    })()`;
  const result = await evalAny(c, setupJs, 5);
  log.info(`player config: ${String(result)}`);

  // Host the game
  const serverType = mode === 'mp' ? 'ServerType.SERVER_TYPE_LAN' : 'ServerType.SERVER_TYPE_NONE';
  const hostResult = await evalAny(c, `Network.hostGame(${serverType})`, 10);
  log.info(`Network.hostGame(${serverType}): ${String(hostResult)}`);
  return Boolean(hostResult);
};

/** Reconnect after game load and wait for Autoplay to be available. */
export const waitForGameReady = async (maxWait = 180, nTurns = 0): Promise<CdpClient | null> => {
  log.info('waiting for game to load...');
  let c = await connectWithRetry(maxWait);
  if (c === null) return null;

  // Belt-and-suspenders: also written to localStorage before launch (see run).
  // Inject optional Autoplay config for the harness mod (turns/observeAs/returnAs).
  const harnessJs = `window.__civretro = {turns: ${nTurns}, observeAs: -1, returnAs: 0}`;
  try {
    await evalAny(c, harnessJs, 5);
    log.info(`window.__civretro injected (turns=${nTurns})`);
  } catch (e) {
    log.warn(`harness inject failed on first connect (${errName(e)}) — will retry in loop`);
  }

  for (let i = 0; i < maxWait; i++) {
    await sleep(1000);
    let ready: unknown;
    try {
      ready = await evalAny(c, READINESS_JS, 5);
    } catch {
      try {
        await c.close();
      } catch {
        /* ignore */
      }
      const c2 = await connectWithRetry(30);
      if (c2 === null) return null;
      c = c2;
      // Re-inject after reconnect — V8 context may have reset
      try {
        await evalAny(c, harnessJs, 5);
        log.info('window.__civretro re-injected after reconnect');
      } catch {
        /* ignore */
      }
      continue;
    }

    if (ready != null && String(ready).startsWith('READY:')) {
      log.info(`game ready at turn ${String(ready).split(':')[1]}`);
      return c;
    }
    if (i % 10 === 0) log.debug(`[${i}s] ${String(ready)}`);
  }

  return null;
};

/** Poll Autoplay.isActive for up to timeout seconds; warn if harness hasn't activated it. */
export const checkHarness = async (c: CdpClient, timeout = 15): Promise<boolean> => {
  for (let i = 0; i < timeout; i++) {
    await sleep(1000);
    const active = await safeEval(c, "typeof Autoplay !== 'undefined' && Autoplay.isActive", 5);
    if (active === true || active === 'true') {
      log.info(`harness confirmed active (Autoplay.isActive=true) after ${i + 1}s`);
      return true;
    }
    if (i === 4) {
      log.warn('Autoplay not yet active after 5s — are both mods enabled in the Mods menu?');
    }
  }
  log.error(`harness not active after ${timeout}s — civretro-harness mod may not be enabled`);
  return false;
};

const HANG_WARN_S = 120; // warn if no new turns for this many seconds
const HANG_ABORT_S = 300; // abort if no new turns for this many seconds

/** Parse + validate the recorder index; returns null on any failure (mirrors Python try/except). */
const parseIndex = (raw: string): SessionIndex | null => {
  try {
    const result = SessionIndexSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

/**
 * Poll until the recorder has captured nTurns, then actively exit to menu.
 *
 * priorSessionId: sessionId from civretro:index before launching. We wait until
 * the index shows a *new* sessionId before counting turns — prevents stale data
 * from a previous run triggering an instant exit.
 */
export const waitForAutoplayDone = async (
  c: CdpClient,
  nTurns: number,
  priorSessionId: string | null = null,
  maxWait = 7200,
): Promise<AutoplayResult> => {
  log.info(`waiting for recorder to capture ${nTurns} turns (prior_session=${priorSessionId})...`);

  let sessionConfirmed = priorSessionId === null;
  let lastTurn: number | null = null;
  let turnAdvances = 0;
  let lastProgressT = monotonic();
  let lastCaptured = 0;

  for (let elapsed = 0; elapsed < maxWait; elapsed += 5) {
    await sleep(5000);

    // Primary: recorder's authoritative captured-turn index
    const idxRaw = await safeEval(c, "localStorage.getItem('civretro:index')", 10);
    if (typeof idxRaw === 'string' && idxRaw && idxRaw !== 'null' && idxRaw !== 'undefined') {
      const idx = parseIndex(idxRaw);
      if (idx) {
        const currentSession = idx.sessionId;

        // The recorder resumes the same sessionId across age transitions but always
        // generates a new one for a fresh game — this guard fires on new game launch.
        if (!sessionConfirmed) {
          if (currentSession && currentSession !== priorSessionId) {
            sessionConfirmed = true;
            log.info(`new recorder session: ${currentSession}`);
          } else {
            log.debug(`waiting for new session (still ${currentSession})`);
            continue;
          }
        }

        // totalTurns is the global counter across age transitions; falls back to
        // turns.length for older recorder versions.
        const captured = idx.totalTurns ?? idx.turns.length;
        if (captured > lastCaptured) {
          lastCaptured = captured;
          lastProgressT = monotonic();
          if (captured % 5 === 0 || captured === nTurns) {
            log.info(`recorder: ${captured}/${nTurns} turns`);
          }
        }

        if (captured >= nTurns) {
          log.info(`recorder done (${captured} turns) — sending exitToMainMenu`);
          try {
            await evalAny(c, 'engine.call("exitToMainMenu")', 5);
          } catch {
            /* ignore */
          }
          return { turnsCaptured: captured, sessionId: currentSession };
        }

        const stallS = monotonic() - lastProgressT;
        if (stallS > HANG_ABORT_S) {
          log.error(`no progress for ${stallS.toFixed(0)}s — aborting`);
          return { turnsCaptured: captured, timedOut: true };
        }
        if (stallS > HANG_WARN_S && Math.floor(stallS) % 30 < 5) {
          log.warn(`no progress for ${stallS.toFixed(0)}s (stalled at turn ${captured}?)`);
        }
        continue;
      }
    }

    // Fallback: Game.turn advance tracking (before recorder writes first entry)
    if (!sessionConfirmed) continue;

    const snapRaw = await safeEval(c, 'JSON.stringify({turn: Game.turn})', 10);
    if (typeof snapRaw !== 'string' || !snapRaw) continue;
    let turn: number;
    try {
      const parsed = TurnProbeSchema.safeParse(JSON.parse(snapRaw));
      turn = parsed.success ? (parsed.data.turn ?? 0) : 0;
    } catch {
      continue;
    }

    if (lastTurn !== null && turn !== lastTurn) {
      turnAdvances += 1;
      lastProgressT = monotonic();
      if (turnAdvances % 5 === 0) {
        log.info(`fallback: turn=${turn} advances=${turnAdvances}/${nTurns}`);
      }
    }
    lastTurn = turn;

    const stallS = monotonic() - lastProgressT;
    if (stallS > HANG_ABORT_S) {
      log.error(`fallback: no progress for ${stallS.toFixed(0)}s — aborting`);
      return { turnsCaptured: turnAdvances, timedOut: true };
    }

    if (turnAdvances >= nTurns) {
      log.info(`fallback: ${turnAdvances} advances → exitToMainMenu`);
      try {
        await evalAny(c, 'engine.call("exitToMainMenu")', 5);
      } catch {
        /* ignore */
      }
      return { turnsCaptured: turnAdvances };
    }
  }

  log.warn(`waitForAutoplayDone timed out after ${maxWait}s`);
  return { turnsCaptured: 0, timedOut: true };
};

/** Core run logic. */
export const run = async (cfg: RunConfig): Promise<RunResult> => {
  log.info(
    `CivRetro run_game  turns=${cfg.nTurns}  players=${cfg.nPlayers}  speed=${cfg.speed}  ` +
      `mapSize=${cfg.mapSize}  mode=${cfg.mode}  seed=${cfg.seed}`,
  );

  log.info('── connecting ──');
  let c = await connectWithRetry(30);
  if (c === null) {
    log.error(`could not connect to Civ 7 CDP on port ${CDP_PORT}`);
    throw new RunError(`could not connect to Civ 7 CDP on port ${CDP_PORT}`);
  }

  const inShell = await safeEval(c, 'UI.isInShell()', 5);
  if (!inShell) {
    let turnStr = '';
    try {
      const raw = await safeEval(c, 'JSON.stringify({turn:Game.turn,age:Game.age})', 5);
      const parsed =
        typeof raw === 'string' && raw ? GameInfoSchema.safeParse(JSON.parse(raw)) : null;
      const ginfo = parsed?.success ? parsed.data : {};
      turnStr = ` at turn ${String(ginfo.turn ?? '?')} age ${String(ginfo.age ?? '?')}`;
    } catch {
      turnStr = '';
    }
    log.warn(`game already running${turnStr}`);
    // The Python CLI asked for interactive [y/N] confirmation here. In this
    // non-interactive port we log the warning and proceed to ensureAtMenu.
  }

  log.info('── configuring game ──');
  c = await ensureAtMenu(c);

  // Capture old session ID before launching so waitForAutoplayDone can ignore
  // stale localStorage data from the previous game.
  let priorSessionId: string | null = null;
  try {
    const oldIdx = await safeEval(c, "localStorage.getItem('civretro:index')", 5);
    if (typeof oldIdx === 'string' && oldIdx && oldIdx !== 'null' && oldIdx !== 'undefined') {
      const parsed = PriorIndexSchema.safeParse(JSON.parse(oldIdx));
      priorSessionId = parsed.success ? (parsed.data.sessionId ?? null) : null;
      log.info(`prior recorder session: ${priorSessionId}`);
    }
  } catch {
    /* ignore */
  }

  // Write config and new-session flag to localStorage (fs://game origin persists into game context)
  const configJs =
    `localStorage.setItem('civretro:config', JSON.stringify({turns:${cfg.nTurns},observeAs:-1,returnAs:0}));` +
    `localStorage.setItem('civretro:forceNewSession','1')`;
  try {
    await safeEval(c, configJs, 5);
    log.info(`civretro config written to localStorage (turns=${cfg.nTurns})`);
  } catch (e) {
    log.warn(`localStorage config write failed: ${errMessage(e)}`);
  }

  log.info('launching game...');
  const ok = await launchGame(
    c,
    cfg.nPlayers,
    cfg.seed,
    cfg.speed,
    cfg.mapSize,
    cfg.mapType,
    cfg.mode,
  );
  if (!ok) {
    log.error('failed to launch game');
    throw new RunError('failed to launch game');
  }

  try {
    await c.close();
  } catch {
    /* ignore */
  }

  log.info('── waiting for load ──');
  const loaded = await waitForGameReady(180, cfg.nTurns);
  if (loaded === null) {
    log.error('game never became ready');
    throw new RunError('game never became ready');
  }
  c = loaded;

  await checkHarness(c);
  // (don't raise on failure — proceed anyway, warn is enough)

  // Harness handles Autoplay activation and Begin screen suppression.
  log.info('── collecting ──');
  const runStart = Date.now();
  const result = await waitForAutoplayDone(c, cfg.nTurns, priorSessionId);
  const elapsed = (Date.now() - runStart) / 1000;

  // exitToMainMenu was sent inside waitForAutoplayDone; confirm menu reached
  log.info('── exiting ──');
  log.info('confirming return to main menu...');
  try {
    c = await ensureAtMenu(c);
    await c.close();
  } catch (e) {
    log.warn(`exit to menu failed: ${errMessage(e)}`);
    try {
      await c.close();
    } catch {
      /* ignore */
    }
  }

  const turnsCaptured = result.turnsCaptured ?? 0;
  log.info(`run complete  turns=${turnsCaptured}/${cfg.nTurns}  wall=${elapsed.toFixed(0)}s`);
  return { elapsed, turnsCaptured, nTurns: cfg.nTurns };
};
