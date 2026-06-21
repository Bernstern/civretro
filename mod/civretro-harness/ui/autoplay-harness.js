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
//
// Debug logging:
//   Set localStorage key civretro:debug = '1' to enable Automation.log output.
//   The launcher injects this via CDP: localStorage.setItem('civretro:debug','1')
//   Logs are written to the game's Automation log file.

(function () {
    const TAG = "CIVRETRO:harness";

    // -------------------------------------------------------------------------
    // Logger — writes to Automation.log when civretro:debug = '1' in localStorage.
    // error() is always-on regardless of the flag.
    // -------------------------------------------------------------------------
    var log = (function () {
        function isEnabled() {
            try { return localStorage.getItem('civretro:debug') === '1'; } catch (e) { return false; }
        }
        return {
            info:  function (msg) { if (isEnabled()) Automation.log(TAG + ':INFO: ' + msg); },
            warn:  function (msg) { if (isEnabled()) Automation.log(TAG + ':WARN: ' + msg); },
            error: function (msg) { Automation.log(TAG + ':ERR: ' + msg); },
        };
    })();

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

            log.info('config applied turns=' + turns + ' observeAs=' + observeAs + ' returnAs=' + returnAs + ' isActive=' + Autoplay.isActive);
        } catch (e) {
            log.error('applyConfig failed: ' + e.message);
        }
    }

    function activateAutoplay() {
        try {
            applyConfig();
            if (!Autoplay.isActive) {
                Autoplay.setActive(true);
                log.info('Autoplay.setActive(true)');
            }
        } catch (e) {
            log.error('activateAutoplay failed: ' + e.message);
        }
    }

    // -------------------------------------------------------------------------
    // PRIMARY: activate at eval time, before any notification handler runs.
    // If Autoplay is not yet available (early load), the catch is a no-op and
    // the event handlers below will pick it up.
    // -------------------------------------------------------------------------
    log.info('eval autoplayDefined=' + (typeof Autoplay !== 'undefined') + ' isActive=' + (typeof Autoplay !== 'undefined' ? Autoplay.isActive : 'n/a'));
    activateAutoplay();
    log.info('eval-after isActive=' + (typeof Autoplay !== 'undefined' ? Autoplay.isActive : 'n/a'));

    // -------------------------------------------------------------------------
    // BELT-AND-SUSPENDERS: re-arm on engine events.
    // PostGameInitialization and GameStarted catch the case where Autoplay was
    // not available at eval time. GameAgeEnded pre-arms before the next age's
    // context reload. AutoplayEnded re-arms if Autoplay self-terminates.
    // -------------------------------------------------------------------------

    engine.on("PostGameInitialization", function () {
        log.info('PostGameInitialization isActive=' + (typeof Autoplay !== 'undefined' ? Autoplay.isActive : 'n/a'));
        activateAutoplay();
    });

    engine.on("GameStarted", function () {
        log.info('GameStarted isActive=' + (typeof Autoplay !== 'undefined' ? Autoplay.isActive : 'n/a'));
        activateAutoplay();
    });

    engine.on("AutoplayEnded", function () {
        log.info('AutoplayEnded — re-arming');
        activateAutoplay();
    });

    engine.on("GameAgeEnded", function () {
        log.info('GameAgeEnded — pre-arming for next age');
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
                        log.info('MP auto-EndTurn submitted');
                    } catch (e) {
                        log.error('sendTurnComplete failed: ' + e.message);
                    }
                }, 300);
            }
        } catch (e) {
            log.error('LocalPlayerTurnBegin handler error: ' + e.message);
        }
    });

    engine.whenReady.then(function () {
        log.info('whenReady isActive=' + (typeof Autoplay !== 'undefined' ? Autoplay.isActive : 'n/a'));
        activateAutoplay();
    });

    log.info('loaded');
})();
