// CivRetro AI Harness — developer-only mod script.
//
// Suppresses the Begin screen and Age Transition screens so autonomous all-AI
// games run without human input.
//
// Two blocking screens, confirmed screen names from notification-handlers.js:
//   "screen-advanced-start"    — Begin screen at game start (line 284)
//   "screen-dedication-selection" — dedication/legacy chooser at age transition (lines 303, 329)
//   "age-transition-banner"    — age transition overlay (line 316)
//
// PRIMARY FIX: monkey-patch ContextManager.push.
//   Applied at module eval time (synchronous, before any notification fires)
//   AND in engine.whenReady.then() AND on PostGameInitialization (re-arms
//   after age-transition context reloads). Idempotent — safe to call many
//   times. This eliminates the timing race on fast-loading (tiny) maps and
//   across age-boundary UI reloads.
//
// SECONDARY: registerHandler override inside engine.whenReady, where Game is
//   guaranteed to be available.
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

    function cfg() { return window.__civretro || {}; }

    // Screens to suppress entirely. Any ContextManager.push with one of these
    // names is swallowed; activateAutoplay() is called first.
    const BLOCKED_SCREENS = new Set([
        "screen-advanced-start",
        "screen-dedication-selection",
        "age-transition-banner",
    ]);

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
    // PRIMARY: ContextManager.push monkey-patch
    // -------------------------------------------------------------------------
    // Idempotent — safe to call at eval time, in engine.whenReady, and on
    // engine events. Called early so fast-loading maps and age-transition
    // context reloads don't beat the patch installation.

    let _cmPatched = false;
    function patchContextManager() {
        if (_cmPatched) return;
        if (typeof ContextManager === "undefined" || typeof ContextManager.push !== "function") {
            console.warn(`${TAG}: ContextManager not available yet`);
            return;
        }
        const _orig = ContextManager.push.bind(ContextManager);
        ContextManager.push = function (screenName, ...args) {
            if (BLOCKED_SCREENS.has(screenName)) {
                console.log(`${TAG}: blocked ContextManager.push("${screenName}")`);
                activateAutoplay();
                return Promise.resolve();
            }
            return _orig(screenName, ...args);
        };
        _cmPatched = true;
        console.log(`${TAG}: ContextManager.push patched`);
    }

    // Apply immediately at eval time — catches the case where ContextManager
    // is already available and a blocked screen fires before engine.whenReady.
    patchContextManager();

    // -------------------------------------------------------------------------
    // SECONDARY: notification handler overrides (inside engine.whenReady so
    // Game.getHash() is available when registerHandler calls it)
    // -------------------------------------------------------------------------

    function installHandlerOverrides() {
        try {
            const noop = { activate: function () { activateAutoplay(); return true; } };
            NotificationModel.manager.registerHandler("NOTIFICATION_ADVANCED_START", noop);
            NotificationModel.manager.registerHandler("NOTIFICATION_AGE_TRANSITION",  noop);
            console.log(`${TAG}: notification handler overrides installed`);
        } catch (e) {
            console.warn(`${TAG}: registerHandler failed: ${e.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // Engine event hooks (belt-and-suspenders)
    // -------------------------------------------------------------------------

    engine.on("PostGameInitialization", function () {
        console.log(`${TAG}: PostGameInitialization`);
        patchContextManager(); // re-arm after age-transition context reload
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

    // -------------------------------------------------------------------------
    // Boot: also patch + install overrides once engine is fully ready
    // -------------------------------------------------------------------------

    engine.whenReady.then(function () {
        patchContextManager(); // no-op if already applied at eval time
        installHandlerOverrides();
        console.log(`${TAG}: ready`);
    });

    console.log(`${TAG}: loaded`);
})();
