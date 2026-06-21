"""
Game launch helpers — connect to CDP, navigate menus, start an all-AI game,
wait for readiness, and activate Autoplay.

Also provides main() / parse_args() used by both tools/run_game.py (direct
invocation) and the run-game console script entry point (main_cli).
"""

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

from civretro.cdp import CDPClient, CDP_PORT, eval_any
from civretro.log import configure_logging, get_logger
from civretro.queries import READINESS_JS

log = get_logger(__name__)


async def connect_with_retry(max_wait: int = 120) -> CDPClient | None:
    """Attempt to connect to the CDP endpoint, retrying for up to max_wait seconds."""
    c = CDPClient()
    for i in range(max_wait):
        try:
            await c.connect()
            log.info("connected to CDP on port %d", CDP_PORT)
            return c
        except Exception:
            if i % 15 == 0:
                log.warning("[%ds] waiting for CDP on port %d...", i, CDP_PORT)
            await asyncio.sleep(1)
    return None


async def safe_eval(c: CDPClient, js: str, timeout: float = 30.0):
    """Evaluate JS with one automatic reconnect attempt on failure."""
    try:
        return await eval_any(c, js, timeout)
    except Exception as e:
        log.warning("CDP error (%s), reconnecting...", type(e).__name__)
        try:
            await c.close()
        except Exception:
            pass
        c2 = await connect_with_retry(30)
        if c2:
            c._ws = c2._ws
            try:
                return await eval_any(c, js, timeout)
            except Exception:
                pass
    return None


async def ensure_at_menu(c: CDPClient) -> CDPClient:
    """
    If a game is currently running, stop Autoplay and exit to the main menu.
    Returns a (possibly new) CDPClient connected after the menu appears.
    """
    in_shell = await safe_eval(c, "UI.isInShell()", timeout=5)
    if in_shell:
        return c

    log.info("game already running — stopping Autoplay and returning to main menu...")

    # Stop Autoplay if active
    await safe_eval(
        c,
        "(function(){ try { if (typeof Autoplay !== 'undefined' && Autoplay.isActive) "
        "{ Autoplay.setActive(false); } } catch(e){} })()",
        timeout=5,
    )

    # Exit to menu — CDP will drop during transition
    try:
        await eval_any(c, 'engine.call("exitToMainMenu")', timeout=5)
    except Exception:
        pass
    try:
        await c.close()
    except Exception:
        pass

    # Reconnect and wait for shell
    log.info("waiting for main menu...")
    for _ in range(60):
        await asyncio.sleep(2)
        c2 = CDPClient()
        try:
            await c2.connect()
            shell = await eval_any(c2, "UI.isInShell()", timeout=5)
            if shell:
                log.info("at main menu")
                return c2
            await c2.close()
        except Exception:
            pass

    log.warning("could not confirm return to main menu — proceeding anyway")
    c3 = await connect_with_retry(30)
    return c3 or c


# CLI string → DB type mappings (confirmed from config.xml)
_SPEED_MAP = {
    "online":   "GAMESPEED_ONLINE",
    "quick":    "GAMESPEED_QUICK",
    "standard": "GAMESPEED_STANDARD",
    "epic":     "GAMESPEED_EPIC",
    "marathon": "GAMESPEED_MARATHON",
}
_MAP_SIZE_MAP = {
    "tiny":     "MAPSIZE_TINY",
    "small":    "MAPSIZE_SMALL",
    "standard": "MAPSIZE_STANDARD",
    "large":    "MAPSIZE_LARGE",
    "huge":     "MAPSIZE_HUGE",
}
_MAP_TYPE_MAP = {
    "continents":       "{base-standard}maps/continents.js",
    "continents-plus":  "{base-standard}maps/continents-plus.js",
    "archipelago":      "{base-standard}maps/archipelago.js",
    "fractal":          "{base-standard}maps/fractal.js",
    "pangaea-plus":     "{base-standard}maps/pangaea-plus.js",
    "shuffle":          "{base-standard}maps/shuffle.js",
    "terra-incognita":  "{base-standard}maps/terra-incognita.js",
}


async def launch_game(
    c: CDPClient,
    n_players: int,
    seed: int | None,
    speed: str = "online",
    map_size: str = "small",
    map_type: str | None = None,
    mode: str = "sp",
) -> bool:
    """Configure and start an all-AI game from the main menu."""
    in_shell = await eval_any(c, "UI.isInShell()", timeout=5)
    if not in_shell:
        log.error("not at main menu after ensure_at_menu — cannot launch")
        return False

    # Reset configuration
    await eval_any(c, "Configuration.editGame().reset()", timeout=5)

    # Wait for config revision to update
    rev = await eval_any(c, "GameSetup.currentRevision", timeout=5)
    for _ in range(20):
        await asyncio.sleep(0.3)
        new_rev = await eval_any(c, "GameSetup.currentRevision", timeout=5)
        if new_rev != rev:
            break

    # Apply map seed if specified
    if seed is not None:
        await eval_any(
            c,
            f"Configuration.editMap().setMapSeed({seed}); Configuration.editGame().setGameSeed({seed});",
            timeout=5,
        )

    # Game speed
    speed_type = _SPEED_MAP.get(speed.lower(), f"GAMESPEED_{speed.upper()}")
    await eval_any(c, f'Configuration.editGame().setGameSpeedType("{speed_type}")', timeout=5)
    log.info("game speed: %s", speed_type)

    # Map size
    size_type = _MAP_SIZE_MAP.get(map_size.lower(), f"MAPSIZE_{map_size.upper()}")
    await eval_any(c, f'Configuration.editMap().setMapSize("{size_type}")', timeout=5)
    log.info("map size: %s", size_type)

    # Map type (optional)
    if map_type:
        script = _MAP_TYPE_MAP.get(map_type.lower(), map_type)
        await eval_any(c, f'Configuration.editMap().setScript("{script}")', timeout=5)
        log.info("map type: %s", script)

    # Set player count — close slots beyond n_players
    setup_js = f"""(function(){{
      var game = Configuration.getGame();
      var inUse = game.inUsePlayerIDs;
      var closed = 0;
      for (var i = 0; i < inUse.length; i++) {{
        var id = inUse[i];
        if (i >= {n_players}) {{
          Configuration.editPlayer(id).setSlotStatus(SlotStatus.SS_CLOSED);
          closed++;
        }} else {{
          Configuration.editPlayer(id).setSlotStatus(SlotStatus.SS_COMPUTER);
        }}
      }}
      return 'configured ' + {n_players} + ' AI players, closed ' + closed;
    }})()"""
    result = await eval_any(c, setup_js, timeout=5)
    log.info("player config: %s", result)

    # Host the game
    server_type = "ServerType.SERVER_TYPE_LAN" if mode == "mp" else "ServerType.SERVER_TYPE_NONE"
    host_result = await eval_any(c, f"Network.hostGame({server_type})", timeout=10)
    log.info("Network.hostGame(%s): %s", server_type, host_result)
    return bool(host_result)


async def wait_for_game_ready(max_wait: int = 180, n_turns: int = 0) -> CDPClient | None:
    """Reconnect after game load and wait for Autoplay to be available."""
    log.info("waiting for game to load...")
    c = await connect_with_retry(max_wait)
    if c is None:
        return None

    # Inject harness config IMMEDIATELY after CDP reconnects, before the
    # loading curtain clears and ContextManager.push("screen-advanced-start")
    # fires. The civretro-harness mod's isEnabled() check gates on this flag.
    harness_js = (
        f"window.__civretro = {{enabled: true, turns: {n_turns}, observeAs: -1, returnAs: 0}}"
    )
    try:
        await eval_any(c, harness_js, timeout=5)
        log.info("window.__civretro injected (turns=%d)", n_turns)
    except Exception as e:
        log.warning("harness inject failed on first connect (%s) — will retry in loop", type(e).__name__)

    for i in range(max_wait):
        await asyncio.sleep(1)
        try:
            ready = await eval_any(c, READINESS_JS, timeout=5)
        except Exception:
            try:
                await c.close()
            except Exception:
                pass
            c = await connect_with_retry(30)
            if c is None:
                return None
            # Re-inject after reconnect — V8 context may have reset
            try:
                await eval_any(c, harness_js, timeout=5)
                log.info("window.__civretro re-injected after reconnect")
            except Exception:
                pass
            continue

        if ready and str(ready).startswith("READY:"):
            log.info("game ready at turn %s", ready.split(':')[1])
            return c
        if i % 10 == 0:
            log.debug("[%ds] %s", i, ready)

    return None


_BEGIN_CLICK_JS = """(function(){
  var LABELS = /^(begin|start|start game|play|continue|ok|launch|next)$/i;
  var candidates = Array.from(document.querySelectorAll(
    'button, [class*="btn"], [class*="button"], [class*="action"], fxs-button'
  ));
  for (var i = 0; i < candidates.length; i++) {
    var el = candidates[i];
    var txt = (el.textContent || el.innerText || el.getAttribute('caption') || '').trim();
    if (LABELS.test(txt)) {
      el.click();
      return 'clicked:' + txt;
    }
  }
  return 'not-found:' + candidates.length + ' candidates checked';
})()"""


async def try_begin_game(c: CDPClient, max_attempts: int = 8, interval: float = 2.0) -> bool:
    """Retry DOM click for Begin/Start screen for up to max_attempts × interval seconds."""
    for attempt in range(max_attempts):
        try:
            result = await asyncio.wait_for(eval_any(c, _BEGIN_CLICK_JS), timeout=5)
            log.info("begin screen attempt %d/%d: %s", attempt + 1, max_attempts, result)
            if isinstance(result, str) and result.startswith("clicked:"):
                return True
        except Exception as e:
            log.debug("begin click attempt %d failed: %s", attempt + 1, e)
        if attempt < max_attempts - 1:
            await asyncio.sleep(interval)
    log.warning("begin screen: no button found after %d attempts", max_attempts)
    return False


async def activate_autoplay(c: CDPClient, n_turns: int) -> bool:
    result = await eval_any(
        c,
        f"""(function(){{
          try {{
            Autoplay.setTurns({n_turns});
            Autoplay.setReturnAsPlayer(-1);
            Autoplay.setObserveAsPlayer(-1);
            Autoplay.setActive(true);
            return JSON.stringify({{active: Autoplay.isActive, turns: {n_turns}}});
          }} catch(e) {{ return 'err:' + e.message; }}
        }})()""",
        timeout=5,
    )
    log.info("Autoplay: %s", result)
    return result and "true" in str(result)


_HANG_WARN_S  = 120   # warn if no new turns for this many seconds
_HANG_ABORT_S = 300   # abort if no new turns for this many seconds


async def wait_for_autoplay_done(
    c: CDPClient,
    n_turns: int,
    prior_session_id: str | None = None,
    max_wait: int = 7200,
) -> dict:
    """
    Poll until the recorder has captured n_turns, then actively exit to menu.

    prior_session_id: sessionId from civretro:index before launching. We wait
    until the index shows a *new* sessionId before counting turns — prevents
    stale data from a previous run triggering an instant exit.

    Primary signal: civretro:index (authoritative, written by recorder mod).
    Fallback:       Game.turn advance counting (before recorder writes first entry).
    Hang watchdog:  warns at _HANG_WARN_S, aborts at _HANG_ABORT_S with no progress.
    """
    log.info("waiting for recorder to capture %d turns (prior_session=%s)...",
             n_turns, prior_session_id)

    session_confirmed = prior_session_id is None
    last_turn = None
    turn_advances = 0
    last_progress_t = time.monotonic()
    last_captured = 0

    for _ in range(0, max_wait, 5):
        await asyncio.sleep(5)

        # Primary: recorder's authoritative captured-turn index
        idx_raw = await safe_eval(c, "localStorage.getItem('civretro:index')", timeout=10)
        if idx_raw and idx_raw not in ("null", "undefined"):
            try:
                idx = json.loads(idx_raw)
                current_session = idx.get("sessionId")

                if not session_confirmed:
                    if current_session and current_session != prior_session_id:
                        session_confirmed = True
                        log.info("new recorder session: %s", current_session)
                    else:
                        log.debug("waiting for new session (still %s)", current_session)
                        continue

                captured = len(idx.get("turns", []))
                if captured > last_captured:
                    last_captured = captured
                    last_progress_t = time.monotonic()
                    if captured % 5 == 0 or captured == n_turns:
                        log.info("recorder: %d/%d turns", captured, n_turns)

                if captured >= n_turns:
                    log.info("recorder done (%d turns) — sending exitToMainMenu", captured)
                    try:
                        await eval_any(c, 'engine.call("exitToMainMenu")', timeout=5)
                    except Exception:
                        pass
                    return {"turns_captured": captured, "session_id": current_session}

                stall_s = time.monotonic() - last_progress_t
                if stall_s > _HANG_ABORT_S:
                    log.error("no progress for %.0fs — aborting", stall_s)
                    return {"turns_captured": captured, "timed_out": True}
                if stall_s > _HANG_WARN_S and int(stall_s) % 30 < 5:
                    log.warning("no progress for %.0fs (stalled at turn %d?)", stall_s, captured)
                continue
            except Exception:
                pass

        # Fallback: Game.turn advance tracking (before recorder writes first entry)
        if not session_confirmed:
            continue

        snap_raw = await safe_eval(c, "JSON.stringify({turn: Game.turn})", timeout=10)
        if not snap_raw:
            continue
        try:
            snap = json.loads(snap_raw)
        except Exception:
            continue

        turn = snap.get("turn", 0)
        if last_turn is not None and turn != last_turn:
            turn_advances += 1
            last_progress_t = time.monotonic()
            if turn_advances % 5 == 0:
                log.info("fallback: turn=%d advances=%d/%d", turn, turn_advances, n_turns)
        last_turn = turn

        stall_s = time.monotonic() - last_progress_t
        if stall_s > _HANG_ABORT_S:
            log.error("fallback: no progress for %.0fs — aborting", stall_s)
            return {"turns_captured": turn_advances, "timed_out": True}

        if turn_advances >= n_turns:
            log.info("fallback: %d advances → exitToMainMenu", turn_advances)
            try:
                await eval_any(c, 'engine.call("exitToMainMenu")', timeout=5)
            except Exception:
                pass
            return {"turns_captured": turn_advances}

    log.warning("wait_for_autoplay_done timed out after %ds", max_wait)
    return {"turns_captured": 0, "timed_out": True}


# ── CLI entry points ──────────────────────────────────────────────────────────

async def _run(args):
    """Core async run logic shared by main() and main_cli()."""
    log.info(
        "CivRetro run_game  turns=%d  players=%d  speed=%s  map_size=%s  mode=%s  seed=%s",
        args.n_turns, args.n_players, args.speed, args.map_size, args.mode, args.seed,
    )

    log.info("connecting to CDP...")
    c = await connect_with_retry(30)
    if c is None:
        log.error("could not connect to Civ 7 CDP on port 9444. Is the game running?")
        sys.exit(1)

    in_shell = await safe_eval(c, "UI.isInShell()", timeout=5)
    if not in_shell:
        try:
            raw = await safe_eval(c, "JSON.stringify({turn:Game.turn,age:Game.age})", timeout=5)
            ginfo = json.loads(raw) if raw else {}
            turn_str = f" at turn {ginfo.get('turn','?')} age {ginfo.get('age','?')}"
        except Exception:
            turn_str = ""
        log.warning("game already running%s", turn_str)
        answer = input(f"Back out of current game{turn_str} and launch new {args.n_players}p/{args.n_turns}t game? [y/N] ").strip().lower()
        if answer != "y":
            log.info("aborted by user")
            await c.close()
            sys.exit(0)

    c = await ensure_at_menu(c)

    # Capture old session ID before launching so wait_for_autoplay_done can
    # ignore stale localStorage data from the previous game.
    prior_session_id = None
    try:
        old_idx = await safe_eval(c, "localStorage.getItem('civretro:index')", timeout=5)
        if old_idx and old_idx not in ("null", "undefined"):
            prior_session_id = json.loads(old_idx).get("sessionId")
            log.info("prior recorder session: %s", prior_session_id)
    except Exception:
        pass

    log.info("launching game...")
    ok = await launch_game(
        c, args.n_players, args.seed,
        speed=args.speed, map_size=args.map_size, map_type=args.map_type, mode=args.mode,
    )
    if not ok:
        log.error("failed to launch game")
        sys.exit(1)

    try:
        await c.close()
    except Exception:
        pass

    c = await wait_for_game_ready(n_turns=args.n_turns)
    if c is None:
        log.error("game never became ready")
        sys.exit(1)

    ok = await activate_autoplay(c, args.n_turns)
    if not ok:
        log.error("failed to activate Autoplay")
        sys.exit(1)

    await try_begin_game(c)

    run_start = time.time()
    result = await wait_for_autoplay_done(c, args.n_turns, prior_session_id=prior_session_id)
    elapsed = time.time() - run_start

    # exitToMainMenu was sent inside wait_for_autoplay_done; confirm menu reached
    log.info("confirming return to main menu...")
    try:
        c = await ensure_at_menu(c)
        await c.close()
    except Exception as e:
        log.warning("exit to menu failed: %s", e)
        try:
            await c.close()
        except Exception:
            pass

    turns_captured = result.get("turns_captured", 0)
    log.info("run complete  turns=%d/%d  wall=%.0fs", turns_captured, args.n_turns, elapsed)
    return {"elapsed": elapsed, "turns_captured": turns_captured, "n_turns": args.n_turns}


def main_cli():
    """Entry point for the run-game console script (installed via pyproject.toml)."""
    configure_logging()
    args = _parse_args_standalone()
    s = asyncio.run(_run(args))
    log.info("done  turns=%d/%d  wall=%.0fs", s["turns_captured"], s["n_turns"], s["elapsed"])


def _parse_args_standalone():
    p = argparse.ArgumentParser(
        description="Launch an automated Civ 7 game via CDP.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--n-turns",   type=int,   default=50,   help="Turn count (default: 50)")
    p.add_argument("--n-players", type=int,   default=6,    choices=range(2, 7), metavar="2-6",
                   help="Number of AI players (default: 6)")
    p.add_argument("--seed",      type=int,   default=None, help="Map+game seed for reproducibility")
    p.add_argument("--tag",       type=str,   default=None, help="Label for this run (informational)")
    p.add_argument("--note",      type=str,   default=None, help="Free-text note (informational)")
    p.add_argument("--mode",      type=str,   default="sp", choices=["sp", "mp"],
                   help="Game mode: sp (single-player) or mp (LAN multiplayer) (default: sp)")
    p.add_argument("--speed",     type=str,   default="online",
                   choices=["online", "quick", "standard", "epic", "marathon"],
                   help="Game speed (default: online)")
    p.add_argument("--map-size",  type=str,   default="small",
                   choices=["tiny", "small", "standard", "large", "huge"],
                   help="Map size (default: small)")
    p.add_argument("--map-type",  type=str,   default=None,
                   choices=["continents", "continents-plus", "archipelago", "fractal",
                            "pangaea-plus", "shuffle", "terra-incognita"],
                   help="Map script (default: game default)")
    return p.parse_args()
