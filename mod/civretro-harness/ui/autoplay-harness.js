// CivRetro AI Harness — developer-only mod script.
//
// Suppresses the Begin screen and Age Transition screens so autonomous all-AI
// games run without human input.
//
// HOW IT WORKS:
//   The game's own notification handlers already have the right guard:
//     CreateAdvancedStart.activate():  if (!Autoplay.isActive) { ContextManager.push(...) }
//     CreateAgeTransition.activate():  if (Autoplay.isActive)  { return true; }
//   If Autoplay is active when those fire, the screens are never pushed at all.
//
//   PRIMARY: call activateAutoplay() at eval time (synchronous, before any
//   notification handler runs — Coherent evals all scripts before dispatching
//   events). This sets Autoplay.isActive = true before the Begin/Age handlers fire.
//
//   BELT-AND-SUSPENDERS: repeat in PostGameInitialization, GameStarted,
//   AutoplayEnded, and GameAgeEnded to re-arm after age-transition context
//   reloads (Coherent Gameface reloads the JS context at each age boundary,
//   re-running this script from scratch).
//
// NOTE: ContextManager and NotificationModel are ES module exports in
//   base-standard, not globals — they cannot be monkey-patched from this scope.
//
// Always active — no opt-in guard. The mod drives the game whenever it is
//   installed and enabled in the Mods browser.
//
// Configuration (optional — set via CDP before the game starts):
//   window.__civretro = {
//     turns:     N,    // 0 or absent = unlimited
//     observeAs: -1,   // -1 = no camera; 1000 = full-vision observer
//     returnAs:  0,    // player to return control to when autoplay ends
//   }

(function () {
    const TAG = "CIVRETRO:harness";

    function cfg() {
        try {
            var stored = localStorage.getItem('civretro:config');
            if (stored) return JSON.parse(stored);
        } catch (e) {}
        return window.__civretro || {};
    }

    // -------------------------------------------------------------------------
    // Autoplay configuration and activation
    // -------------------------------------------------------------------------
    // applyConfig() always re-applies turns/observer even when already active —
    // CDP may set window.__civretro after the mod first fires, so we must not
    // guard on Autoplay.isActive when applying config.
    // activateAutoplay() calls applyConfig then sets active if not already set.

    function applyConfig() {
        try {
            const c = cfg();
            const turns     = (c.turns > 0) ? c.turns : 0;
            const observeAs = (c.observeAs !== undefined) ? c.observeAs : -1;
            const returnAs  = (c.returnAs  !== undefined) ? c.returnAs  : 0;

            Configuration.getUser().setLockedValue("QuickMovement", true);
            Configuration.getUser().setLockedValue("QuickCombat",   true);

            if (turns > 0) Autoplay.setTurns(turns);
            Autoplay.setReturnAsPlayer(returnAs);
            Autoplay.setObserveAsPlayer(observeAs);

            console.log(`${TAG}: config applied turns=${turns} observeAs=${observeAs} returnAs=${returnAs} (isActive=${Autoplay.isActive})`);
        } catch (e) {
            console.warn(`${TAG}: applyConfig failed: ${e.message}`);
        }
    }

    function activateAutoplay() {
        try {
            applyConfig();
            if (!Autoplay.isActive) {
                Autoplay.setActive(true);
                console.log(`${TAG}: Autoplay.setActive(true)`);
            }
        } catch (e) {
            console.warn(`${TAG}: activateAutoplay failed: ${e.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // PRIMARY: activate at eval time, before any notification handler runs.
    // If Autoplay is not yet available (early load), the catch is a no-op and
    // the event handlers below will pick it up.
    // -------------------------------------------------------------------------
    activateAutoplay();

    // -------------------------------------------------------------------------
    // BELT-AND-SUSPENDERS: re-arm on engine events.
    // PostGameInitialization and GameStarted catch the case where Autoplay was
    // not available at eval time. GameAgeEnded pre-arms before the next age's
    // context reload. AutoplayEnded re-arms if Autoplay self-terminates.
    // -------------------------------------------------------------------------

    engine.on("PostGameInitialization", function () {
        console.log(`${TAG}: PostGameInitialization`);
        activateAutoplay();
    });

    engine.on("GameStarted", function () {
        console.log(`${TAG}: GameStarted`);
        activateAutoplay();
    });

    engine.on("AutoplayEnded", function () {
        console.log(`${TAG}: AutoplayEnded — re-arming`);
        activateAutoplay();
    });

    engine.on("GameAgeEnded", function () {
        console.log(`${TAG}: GameAgeEnded — pre-arming for next age`);
        activateAutoplay();
    });

    // MP auto-EndTurn: in LAN/MP games Autoplay may not fully control the local
    // slot. Re-apply observer config (-1) each turn and submit End Turn so the
    // local slot never stalls waiting for human input.
    engine.on("LocalPlayerTurnBegin", function () {
        try {
            var isMP = typeof Network !== "undefined"
                       && typeof Network.getServerType === "function"
                       && Network.getServerType() !== 0;
            if (isMP) {
                applyConfig();
                setTimeout(function () {
                    try {
                        GameContext.sendTurnComplete();
                        console.log(`${TAG}: MP auto-EndTurn submitted`);
                    } catch (e) {
                        console.warn(`${TAG}: sendTurnComplete failed: ${e.message}`);
                    }
                }, 300);
            }
        } catch (e) {
            console.warn(`${TAG}: LocalPlayerTurnBegin handler error: ${e.message}`);
        }
    });

    engine.whenReady.then(function () {
        activateAutoplay();
        console.log(`${TAG}: ready`);
    });

    console.log(`${TAG}: loaded`);
})();
