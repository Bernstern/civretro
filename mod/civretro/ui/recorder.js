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
//   civretro:session     — session metadata (id, isMP, etc.) — written once at game start
//   civretro:index       — { sessionId, turns[], totalTurns, latest, lastTs, ages[] }
//   civretro:t:{N}       — full omniscient snapshot for global turn N
//   civretro:map:{age}   — terrain/resource/feature tile snapshot for each age

(function () {

    var sessionId = null;
    var globalTurn = 0;
    var currentAge = null;  // tracks age transitions in updateIndex

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
                    // Restore last known age from index so we don't emit a spurious age marker
                    if (idx.ages && idx.ages.length > 0) {
                        currentAge = idx.ages[idx.ages.length - 1].age;
                    }
                    Automation.log("CIVRETRO:session:resume id=" + sessionId + " globalTurn=" + globalTurn + " currentAge=" + currentAge);
                    return;
                }
            }
        } catch (e) {}

        sessionId = "s" + Date.now().toString(36);
        globalTurn = 0;
        currentAge = null;
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
                            pop: c.population, isCapital: c.isCapital, isTown: c.isTown, owner: c.owner,
                            currentProduction: (function() {
                                try { return c.BuildQueue ? c.BuildQueue.CurrentProductionTypeHash : null; } catch(e) { return null; }
                            })()
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
                try { leaderName = (typeof Locale !== "undefined" && Locale.compose) ? Locale.compose(p.name) : p.name; } catch (e) { leaderName = p.name; }
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
                    legacyScore: legacyScore,
                    techs: (function() {
                        try {
                            if (!p.Techs) return null;
                            var all = p.Techs.getResearched ? p.Techs.getResearched() :
                                      p.Techs.completed ? p.Techs.completed :
                                      p.Techs.known ? p.Techs.known : null;
                            if (!all) { Automation.log("CIVRETRO:probe:Techs no enum on p" + id); return null; }
                            var out = [];
                            for (var i = 0; i < all.length; i++) out.push(all[i]);
                            return out;
                        } catch(e) { return null; }
                    })(),
                    civics: (function() {
                        try {
                            if (!p.Civics) return null;
                            var all = p.Civics.getResearched ? p.Civics.getResearched() :
                                      p.Civics.completed ? p.Civics.completed :
                                      p.Civics.known ? p.Civics.known : null;
                            if (!all) { Automation.log("CIVRETRO:probe:Civics no enum on p" + id); return null; }
                            var out = [];
                            for (var i = 0; i < all.length; i++) out.push(all[i]);
                            return out;
                        } catch(e) { return null; }
                    })(),
                    diplomacy: (function() {
                        try {
                            if (!p.Diplomacy) return null;
                            var ids = Players.getAliveMajorIds();
                            var rels = {};
                            for (var i = 0; i < ids.length; i++) {
                                var otherId = ids[i];
                                if (otherId === id) continue;
                                try {
                                    rels[otherId] = {
                                        warState: p.Diplomacy.getWarState ? p.Diplomacy.getWarState(otherId) : null,
                                        hasAlliance: p.Diplomacy.hasAlliance ? p.Diplomacy.hasAlliance(otherId) : null,
                                        influence: p.Diplomacy.getInfluence ? p.Diplomacy.getInfluence(otherId) : null
                                    };
                                } catch(e) {}
                            }
                            return rels;
                        } catch(e) { return null; }
                    })(),
                    victories: (function() {
                        try {
                            if (!p.Victories) return null;
                            var out = {};
                            if (typeof p.Victories.getScore === 'function') out.score = p.Victories.getScore();
                            if (typeof p.Victories.getProgress === 'function') out.progress = p.Victories.getProgress();
                            return out;
                        } catch(e) { return null; }
                    })()
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
    // captureMapSnapshot — one-shot terrain/resource/feature capture per age
    // -------------------------------------------------------------------------

    function captureMapSnapshot() {
        try {
            var w = GameplayMap.getGridWidth(), h = GameplayMap.getGridHeight();
            // TODO: store diff vs. prior map snapshot for efficiency on long games; storing full array for now.
            var tiles = new Array(w * h);
            for (var y = 0; y < h; y++) {
                for (var x = 0; x < w; x++) {
                    var idx2 = y * w + x;
                    tiles[idx2] = {
                        terrain: (function() { try { return GameplayMap.getTerrainType(x, y); } catch(e) { return null; } })(),
                        resource: (function() { try { return GameplayMap.getResourceType(x, y); } catch(e) { return null; } })(),
                        feature: (function() { try { return GameplayMap.getFeatureType(x, y); } catch(e) { return null; } })()
                    };
                }
            }
            var snap = {
                sessionId: sessionId,
                age: Game.age,
                globalTurnAtCapture: globalTurn,
                ts: Date.now(),
                mapW: w, mapH: h,
                tiles: tiles
            };
            var mapKey = "civretro:map:" + Game.age;
            localStorage.setItem(mapKey, JSON.stringify(snap));
            Automation.log("CIVRETRO:mapSnapshot age=" + Game.age + " tiles=" + tiles.length);
        } catch(e) {
            Automation.log("CIVRETRO:mapSnapshot:ERR:" + e.message);
        }
    }

    // -------------------------------------------------------------------------
    // updateIndex — append globalTurn to index, update lastTs, detect age change
    // -------------------------------------------------------------------------

    function updateIndex(snap) {
        try {
            var raw = localStorage.getItem("civretro:index");
            var idx = raw ? JSON.parse(raw) : { sessionId: sessionId, turns: [], totalTurns: 0, latest: null, lastTs: 0, ages: [] };
            idx.turns.push(globalTurn);
            idx.totalTurns = globalTurn;
            idx.latest = globalTurn;
            idx.lastTs = Date.now();

            // Detect age transitions; snap.age or Game.age indicates the current age
            var snapAge = (snap && snap.age !== undefined) ? snap.age : Game.age;
            if (currentAge === null) {
                // First turn: record starting age but don't push a transition marker
                currentAge = snapAge;
            } else if (snapAge !== currentAge) {
                // Age changed — push a transition marker at the current globalTurn
                if (!idx.ages) idx.ages = [];
                idx.ages.push({ age: snapAge, atGlobalTurn: globalTurn, ts: Date.now() });
                currentAge = snapAge;
            }

            localStorage.setItem("civretro:index", JSON.stringify(idx));
        } catch (e) {
            Automation.log("CIVRETRO:updateIndex:ERR:" + e.message);
        }
    }

    // -------------------------------------------------------------------------
    // onGameStarted — write session metadata (new games only); capture map snapshot.
    // Called at game start AND at each age transition (Coherent context reload).
    // -------------------------------------------------------------------------

    function onGameStarted() {
        try {
            if (globalTurn === 0) {
                // New game: write session metadata and initialize a fresh index
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
                localStorage.setItem("civretro:index", JSON.stringify({
                    sessionId: sessionId, turns: [], totalTurns: 0, latest: null, lastTs: 0, ages: []
                }));
            }
            // Age transitions: do NOT overwrite civretro:session or civretro:index here.
            // Age markers are written in updateIndex() on the first turn of the new age.

            Automation.log("CIVRETRO:GameStarted session=" + sessionId
                           + " globalTurn=" + globalTurn + " age=" + Game.age);

            captureMapSnapshot();
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
            updateIndex(snap);
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
