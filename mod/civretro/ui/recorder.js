// CivRetro Recorder — localStorage-based per-turn state export.
// Writes session metadata on GameStarted, full omniscient snapshots on TurnEnd.
// Data is persisted to LocalStorage.sqlite at:
//   %LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VII\LocalStorage.sqlite
//   Table: Values  |  id = "Afs://game"  |  key = "civretro:*"

(function () {

    var sessionId = null;

    // -------------------------------------------------------------------------
    // captureOmniscient — full per-turn snapshot across all alive major players
    // -------------------------------------------------------------------------

    function captureOmniscient(turn) {
        try {
            var ids = Players.getAliveMajorIds();
            var YIELDS = ["YIELD_FOOD", "YIELD_PRODUCTION", "YIELD_GOLD", "YIELD_SCIENCE", "YIELD_CULTURE", "YIELD_HAPPINESS", "YIELD_DIPLOMACY"];
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
                        cities.push({ name: c.name, x: c.location ? c.location.x : null, y: c.location ? c.location.y : null, pop: c.population, isCapital: c.isCapital, isTown: c.isTown, owner: c.owner });
                    }
                } catch (e) {}
                var units = [];
                try {
                    var us = p.Units ? p.Units.getUnits() : [];
                    for (var k = 0; k < us.length; k++) {
                        var u = us[k];
                        units.push({ typeName: u.typeName, x: u.location ? u.location.x : null, y: u.location ? u.location.y : null, dmg: u.Health ? u.Health.damage : null, owner: u.owner });
                    }
                } catch (e) {}
                var legacyScore = null;
                try { legacyScore = p.LegacyPaths ? p.LegacyPaths.getScore() : null; } catch (e) {}
                players.push({
                    id: id, name: p.name, civType: p.civilizationType, leaderType: p.leaderType,
                    isHuman: p.isHuman, isAlive: p.isAlive,
                    gold: p.Treasury ? p.Treasury.goldBalance : null,
                    numCities: p.Stats ? p.Stats.numCities : null,
                    yields: yields, cities: cities, units: units, legacyScore: legacyScore
                });
            }
            // Map ownership — full scan
            var w = GameplayMap.getGridWidth(), h = GameplayMap.getGridHeight();
            var owners = new Array(w * h);
            for (var y = 0; y < h; y++)
                for (var x = 0; x < w; x++)
                    owners[y * w + x] = MapOwnership.getOwner(x, y);
            return {
                turn: turn !== undefined ? turn : Game.turn,
                age: Game.age,
                ts: Date.now(),
                mapW: w, mapH: h,
                localPlayerId: GameContext.localPlayerID,
                players: players,
                owners: owners
            };
        } catch (e) {
            return { turn: turn !== undefined ? turn : -1, error: e.message, ts: Date.now() };
        }
    }

    // -------------------------------------------------------------------------
    // updateIndex — read current index, append turn, write back
    // -------------------------------------------------------------------------

    function updateIndex(turn) {
        try {
            var raw = localStorage.getItem("civretro:index");
            var idx = raw ? JSON.parse(raw) : { sessionId: sessionId, turns: [], latest: null };
            idx.turns.push(turn);
            idx.latest = turn;
            localStorage.setItem("civretro:index", JSON.stringify(idx));
        } catch (e) {
            Automation.log("CIVRETRO:updateIndex:ERR:" + e.message);
        }
    }

    // -------------------------------------------------------------------------
    // onGameStarted — write session metadata (fired once, delayed 1s)
    // -------------------------------------------------------------------------

    function onGameStarted() {
        setTimeout(function () {
            try {
                sessionId = "s" + Date.now().toString(36);

                var isMP = false;
                try {
                    isMP = !UI.isInShell() && typeof Network !== "undefined" && Network.getServerType && Network.getServerType() !== 0;
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
                localStorage.setItem("civretro:index", JSON.stringify({ sessionId: sessionId, turns: [], latest: null }));

                Automation.log("CIVRETRO:GameStarted session=" + sessionId);
            } catch (e) {
                Automation.log("CIVRETRO:GameStarted:ERR:" + e.message);
            }
        }, 1000);
    }

    // -------------------------------------------------------------------------
    // onTurnEnd — capture full omniscient snapshot and write to localStorage
    // -------------------------------------------------------------------------

    function onTurnEnd(data) {
        try {
            var turn = (data && data.turn !== undefined) ? data.turn : Game.turn;
            var snap = captureOmniscient(turn);
            localStorage.setItem("civretro:t:" + snap.turn, JSON.stringify(snap));
            updateIndex(snap.turn);
            Automation.log("CIVRETRO:turn:" + snap.turn);
        } catch (e) {
            Automation.log("CIVRETRO:TurnEnd:ERR:" + e.message);
        }
    }

    // -------------------------------------------------------------------------
    // onLocalPlayerTurnBegin — MP heartbeat / detection
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
