// CivRetro Autoplay Harness — suppress Begin/Age screens, global turn counter.
//
// Two things block a fully-automated game:
//
//   1. Loading curtain "Begin Game" button (load-screen-model.js).
//      handleGameStart() calls UI.notifyUIReady() — no Autoplay check.
//      Fix: call UI.notifyUIReady() ourselves in engine.whenReady.
//
//   2. screen-advanced-start / screen-dedication-selection (notification-handlers.js).
//      CreateAdvancedStart.activate()  guards on `if (!Autoplay.isActive)`.
//      CreateAgeTransition.activate()  guards on `if (Autoplay.isActive)`.
//      Fix: set Autoplay active at eval-time, before any notification fires.
//
// Global turn counter:
//   Autoplay.setTurns() is per-age. The recorder also resets its index each age.
//   Instead, the harness maintains civretro:harness_state.turnsPlayed via the
//   TurnEnd event, which persists in LocalStorage across age context reloads.
//   The driver writes harness_state with turnsPlayed=0 before each game launch.
//   runId in config+harness_state guards against stale state from a prior game.
//
// Completion signal:
//   Writes civretro:game_over to localStorage once the target is reached or
//   Autoplay deactivates, so the external driver can detect it and exit.
//
// Testability:
//   All logic lives in createHarness(deps) — a factory that receives its
//   dependencies explicitly. In Civ 7 the real game globals are passed in.
//   In tests, mocks are injected. The guard at the bottom auto-initialises
//   in game context (typeof module === 'undefined') and exports for Node.js.
//
// Enable in Mods browser for automated runs; disable to return to normal play.

function createHarness(deps) {
    var engine       = deps.engine;
    var Autoplay     = deps.Autoplay;
    var UI           = deps.UI;
    var Game         = deps.Game;
    var Automation   = deps.Automation;
    var ls           = deps.localStorage;

    var gameOverWritten = false;
    var autoplayArmed   = false;  // set synchronously in arm(); read in whenReady

    // -------------------------------------------------------------------------
    // Persistence helpers
    // -------------------------------------------------------------------------

    function cfg() {
        try { return JSON.parse(ls.getItem('civretro:config') || '{}'); } catch (e) { return {}; }
    }

    function getHarnessState() {
        try { return JSON.parse(ls.getItem('civretro:harness_state') || '{}'); } catch (e) { return {}; }
    }

    function setHarnessState(s) {
        try { ls.setItem('civretro:harness_state', JSON.stringify(s)); } catch (e) {}
    }

    // -------------------------------------------------------------------------
    // Game-over signal — written at most once per age context.
    // -------------------------------------------------------------------------

    function writeGameOver(reason) {
        if (gameOverWritten) return;
        gameOverWritten = true;
        try {
            var c   = cfg();
            var idx = JSON.parse(ls.getItem('civretro:index') || 'null');
            var hs  = getHarnessState();
            ls.setItem('civretro:game_over', JSON.stringify({
                runId:      c.runId || null,
                sessionId:  idx ? idx.sessionId : null,
                reason:     reason,
                ageTurn:    Game ? Game.turn : null,
                globalTurn: hs.turnsPlayed || (idx ? (idx.totalTurns || idx.latest) : null),
                ts:         Date.now()
            }));
            Automation.log('civretro-harness: game_over reason=' + reason + ' globalTurn=' + (hs.turnsPlayed || 0));
        } catch (e) {
            Automation.log('civretro-harness: game_over write failed: ' + e.message);
        }
    }

    // -------------------------------------------------------------------------
    // Arm Autoplay — called at eval-time and on age transitions.
    // Does NOT call setTurns(); global turn math lives in onTurnEnd.
    // -------------------------------------------------------------------------

    function arm() {
        try {
            var c  = cfg();
            var hs = getHarnessState();

            // Detect stale harness_state: either a runId mismatch or a malformed
            // state object (e.g. it accidentally holds the config fields).
            var stateIsValid = typeof hs.turnsPlayed === 'number' && !('turns' in hs);
            if (!stateIsValid || (c.runId && hs.runId && c.runId !== hs.runId)) {
                hs = { runId: c.runId, turnsPlayed: 0 };
                setHarnessState(hs);
            }

            var target = c.turns > 0 ? c.turns : 0;
            var played = hs.turnsPlayed || 0;

            if (target > 0 && played >= target) {
                Automation.log('civretro-harness: global target reached at arm (played=' + played + '), writing game_over');
                writeGameOver('turn_limit');
                return;
            }

            Autoplay.setReturnAsPlayer(c.returnAs  !== undefined ? c.returnAs  : 0);
            Autoplay.setObserveAsPlayer(c.observeAs !== undefined ? c.observeAs : -1);
            Autoplay.setActive(true);
            autoplayArmed = true;
            Automation.log('civretro-harness: armed target=' + (target || 'unlimited')
                + ' played=' + played + ' remaining=' + (target > 0 ? target - played : 'unlimited')
                + ' isActive=' + Autoplay.isActive);
        } catch (e) {
            // Autoplay not yet available — PostGameInitialization will retry
        }
    }

    // -------------------------------------------------------------------------
    // Turn counter — increment turnsPlayed each global turn, stop at target.
    // TurnEnd fires once per round in Civ 7 (not per player).
    // -------------------------------------------------------------------------

    engine.on('TurnEnd', function () {
        var c = cfg();
        var target = c.turns > 0 ? c.turns : 0;
        if (target === 0) return;

        var hs = getHarnessState();
        hs.turnsPlayed = (hs.turnsPlayed || 0) + 1;
        setHarnessState(hs);

        if (hs.turnsPlayed >= target) {
            try { Autoplay.setActive(false); } catch (e) {}
            writeGameOver('turn_limit');
        }
    });

    // -------------------------------------------------------------------------
    // Autoplay deactivation backup — fires frequently (once per AI action).
    // Guard: only act when Autoplay is truly inactive.
    // -------------------------------------------------------------------------

    engine.on('AutoplayEnded', function () {
        if (Autoplay.isActive) return;
        writeGameOver('autoplay_ended');
    });

    // -------------------------------------------------------------------------
    // Event hooks
    // -------------------------------------------------------------------------

    // PRIMARY: set Autoplay active before CreateAdvancedStart.activate() fires.
    arm();

    // FALLBACK: if Autoplay wasn't available at eval time.
    engine.on('PostGameInitialization', arm);

    // RE-ARM: each age reloads the JS context; eval-time arm() above handles it,
    // but also hook GameAgeEnded as belt-and-suspenders.
    engine.on('GameAgeEnded', arm);

    // LOAD SCREEN: bypass the "Begin Game" button when Autoplay is active.
    // Use the JS flag rather than Autoplay.isActive — the C++ state may not
    // reflect setActive(true) synchronously, causing a missed notifyUIReady.
    engine.whenReady.then(function () {
        try {
            if (autoplayArmed) {
                UI.notifyUIReady();
                Automation.log('civretro-harness: notifyUIReady called');
            }
        } catch (e) {
            Automation.log('civretro-harness: notifyUIReady failed: ' + e.message);
        }
    });
}

// ---------------------------------------------------------------------------
// Context dispatch
// ---------------------------------------------------------------------------
// In Civ 7 (no CommonJS): auto-initialize with real game globals.
// In Node.js (required via createRequire): export createHarness for tests.

if (typeof module === 'undefined') {
    createHarness({
        engine:       engine,
        Autoplay:     Autoplay,
        UI:           UI,
        Game:         Game,
        Automation:   Automation,
        localStorage: localStorage
    });
} else {
    module.exports = { createHarness: createHarness };
}
