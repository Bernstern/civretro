// CivRetro Recorder — localStorage-based per-turn state export.
//
// Session model:
//   One sessionId per game. Age transitions reload the UI context (Coherent
//   Gameface), which re-runs this script. We detect age transitions by checking
//   whether the existing session's last write timestamp is recent (< 90s), and
//   resume that session rather than creating a new one.
//
// Turn keys use a globalTurn counter (total TurnEnd events this game, starting
// at 1) instead of Game.turn, so turn numbers stay unique across age resets.
//
// localStorage keys (origin: fs://game, table: LocalStorage.sqlite):
//   civretro:session  — session metadata (id, isMP, etc.)
//   civretro:index    — { sessionId, turns[], totalTurns, latest, lastTs, ages[] }
//   civretro:t:{N}    — full omniscient snapshot for global turn N

(function () {

    var sessionId = null;
    var globalTurn = 0;

    // -------------------------------------------------------------------------
    // initSession — run once at IIFE evaluation time.
    // Detects age transition (recent index ts) vs new game (stale / missing).
    // -------------------------------------------------------------------------

    (function initSession() {
        try {
            var idxRaw = localStorage.getItem("civretro:index");
            if (idxRaw) {
                var idx = JSON.parse(idxRaw);
                var ageMs = Date.now() - (idx.lastTs || 0);
                // If the last turn was written < 90s ago, assume age transition — resume
                if (idx.sessionId && idx.turns && idx.turns.length > 0 && ageMs < 90000) {
                    sessionId = idx.sessionId;
                    globalTurn = idx.totalTurns || idx.turns.length;
                    Automation.log("CIVRETRO:session:resume id=" + sessionId + " globalTurn=" + globalTurn);
                    return;
                }
            }
        } catch (e) {}

        sessionId = "s" + Date.now().toString(36);
        globalTurn = 0;
        Automation.log("CIVRETRO:session:new id=" + sessionId);
    })();

    // -------------------------------------------------------------------------
    // captureOmniscient — full per-turn snapshot across all alive major players
    // -------------------------------------------------------------------------

    function captureOmniscient(ageTurn) {
        try {
            var ids = Players.getAliveMajorIds();
            var YIELDS = ["YIELD_FOOD", "YIELD_PRODUCTION", "YIELD_GOLD", "YIELD_SCIENCE",
                          "YIELD_CULTURE", "YIELD_HAPPINESS", "YIELD_DIPLOMACY"];
            var players = [];
            for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                var p = Players.get(id);
                var yields = {};
                for (var j = 0; j < YIELDS.length; j++) {
                    var yn = YIELDS[j];
                    try { yields[yn] = p.Stats ? p.Stats.getNetYield(YieldTypes[yn]) : null; } catch (e) { yields[yn] = null; }
                }
                var cities = [];
                try {
                    var cs = p.Cities ? p.Cities.getCities() : [];
                    for (var k = 0; k < cs.length; k++) {
                        var c = cs[k];
                        cities.push({
                            name: c.name, x: c.location ? c.location.x : null,
                            y: c.location ? c.location.y : null,
                            pop: c.population, isCapital: c.isCapital, isTown: c.isTown, owner: c.owner
                        });
                    }
                } catch (e) {}
                var units = [];
                try {
                    var us = p.Units ? p.Units.getUnits() : [];
                    for (var k = 0; k < us.length; k++) {
                        var u = us[k];
                        units.push({
                            typeName: u.typeName, x: u.location ? u.location.x : null,
                            y: u.location ? u.location.y : null,
                            dmg: u.Health ? u.Health.damage : null, owner: u.owner
                        });
                    }
                } catch (e) {}
                var legacyScore = null;
                try { legacyScore = p.LegacyPaths ? p.LegacyPaths.getScore() : null; } catch (e) {}
                var leaderName = null;
                try { leaderName = Locale.compose(p.name); } catch (e) {}
                players.push({
                    id: id,
                    name: p.name,
                    leaderName: leaderName,
                    civType: p.civilizationType,
                    leaderType: p.leaderType,
                    isHuman: p.isHuman,
                    isAlive: p.isAlive,
                    gold: p.Treasury ? p.Treasury.goldBalance : null,
                    numCities: p.Stats ? p.Stats.numCities : null,
                    yields: yields,
                    cities: cities,
                    units: units,
                    legacyScore: legacyScore
                });
            }
            var w = GameplayMap.getGridWidth(), h = GameplayMap.getGridHeight();
            var owners = new Array(w * h);
            for (var y = 0; y < h; y++)
                for (var x = 0; x < w; x++)
                    owners[y * w + x] = MapOwnership.getOwner(x, y);
            return {
                globalTurn: globalTurn,
                ageTurn: ageTurn !== undefined ? ageTurn : Game.turn,
                age: Game.age,
                ts: Date.now(),
                mapW: w, mapH: h,
                localPlayerId: GameContext.localPlayerID,
                players: players,
                owners: owners
            };
        } catch (e) {
            return { globalTurn: globalTurn, ageTurn: ageTurn !== undefined ? ageTurn : -1, error: e.message, ts: Date.now() };
        }
    }

    // -------------------------------------------------------------------------
    // updateIndex — append globalTurn to index, update lastTs
    // -------------------------------------------------------------------------

    function updateIndex() {
        try {
            var raw = localStorage.getItem("civretro:index");
            var idx = raw ? JSON.parse(raw) : { sessionId: sessionId, turns: [], totalTurns: 0, latest: null, lastTs: 0, ages: [] };
            idx.turns.push(globalTurn);
            idx.totalTurns = globalTurn;
            idx.latest = globalTurn;
            idx.lastTs = Date.now();
            localStorage.setItem("civretro:index", JSON.stringify(idx));
        } catch (e) {
            Automation.log("CIVRETRO:updateIndex:ERR:" + e.message);
        }
    }

    // -------------------------------------------------------------------------
    // onGameStarted — write/update session metadata; record age marker in index.
    // Called at game start AND at each age transition (Coherent context reload).
    // -------------------------------------------------------------------------

    function onGameStarted() {
        try {
            var isMP = false;
            try {
                isMP = !UI.isInShell() && typeof Network !== "undefined"
                       && Network.getServerType && Network.getServerType() !== 0;
            } catch (e) {}

            var meta = {
                id: sessionId,
                startTurn: Game.turn,
                age: Game.age,
                ts: Date.now(),
                localPlayerId: GameContext.localPlayerID,
                isMP: isMP
            };
            localStorage.setItem("civretro:session", JSON.stringify(meta));

            if (globalTurn === 0) {
                // New game: initialize a fresh index
                localStorage.setItem("civretro:index", JSON.stringify({
                    sessionId: sessionId, turns: [], totalTurns: 0, latest: null, lastTs: 0, ages: []
                }));
            } else {
                // Age transition: append an age marker to the existing index
                try {
                    var idxRaw = localStorage.getItem("civretro:index");
                    var idx = idxRaw ? JSON.parse(idxRaw) : {};
                    if (!idx.ages) idx.ages = [];
                    idx.ages.push({ age: Game.age, atGlobalTurn: globalTurn, atAgeTurn: Game.turn, ts: Date.now() });
                    localStorage.setItem("civretro:index", JSON.stringify(idx));
                } catch (e) {}
            }

            Automation.log("CIVRETRO:GameStarted session=" + sessionId
                           + " globalTurn=" + globalTurn + " age=" + Game.age);
        } catch (e) {
            Automation.log("CIVRETRO:GameStarted:ERR:" + e.message);
        }
    }

    // -------------------------------------------------------------------------
    // onTurnEnd — increment globalTurn, capture snapshot, write to localStorage
    // -------------------------------------------------------------------------

    function onTurnEnd(data) {
        try {
            globalTurn++;
            var ageTurn = (data && data.turn !== undefined) ? data.turn : Game.turn;
            var snap = captureOmniscient(ageTurn);
            localStorage.setItem("civretro:t:" + globalTurn, JSON.stringify(snap));
            updateIndex();
            Automation.log("CIVRETRO:turn:" + ageTurn + " global=" + globalTurn);
        } catch (e) {
            Automation.log("CIVRETRO:TurnEnd:ERR:" + e.message);
        }
    }

    // -------------------------------------------------------------------------
    // onLocalPlayerTurnBegin — MP heartbeat
    // -------------------------------------------------------------------------

    function onLocalPlayerTurnBegin() {
        try {
            Automation.log("CIVRETRO:localTurn:" + Game.turn);
        } catch (e) {}
    }

    // -------------------------------------------------------------------------
    // Register event listeners
    // -------------------------------------------------------------------------

    engine.on("GameStarted",          onGameStarted);
    engine.on("TurnEnd",              onTurnEnd);
    engine.on("LocalPlayerTurnBegin", onLocalPlayerTurnBegin);

})();
