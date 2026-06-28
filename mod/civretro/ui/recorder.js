// CivRetro Recorder — localStorage-based per-turn state export.
//
// Session model:
//   One sessionId per game. Age transitions reload the UI context (Coherent
//   Gameface), which re-runs this script. We detect age transitions vs new
//   games by comparing civretro:config.runId (written by the driver before
//   each launch) against the runId stored in civretro:session. Same runId →
//   age transition, resume. Different runId (or missing session) → new game.
//
//   This replaces the previous civretro:forceNewSession flag, which was
//   unreliable: removeItem() only clears the in-memory cache; the SQLite
//   value survived into the next age context, causing a false new-session.
//
// Turn keys use a globalTurn counter (total TurnEnd events this game, starting
// at 1) instead of Game.turn, so turn numbers stay unique across age resets.
// Keys are namespaced by sessionId so N games can coexist in the same sqlite.
//
// localStorage keys (origin: fs://game, table: LocalStorage.sqlite):
//   civretro:session           — session metadata (id, runId, isMP, etc.)
//   civretro:index             — { sessionId, turns[], totalTurns, latest, lastTs, ages[] }
//   civretro:{sessionId}:t:{N} — full omniscient snapshot for global turn N
//   civretro:map:{age}         — terrain/resource/feature tile snapshot for each age

(function () {

    var sessionId = null;
    var globalTurn = 0;
    var currentAge = null;  // tracks age transitions in updateIndex

    // -------------------------------------------------------------------------
    // initSession — run once at IIFE evaluation time.
    // Detects age transition (recent index ts) vs new game (stale / missing).
    // -------------------------------------------------------------------------

    (function initSession() {
        // Read the runId written by the driver before this game launch.
        // This is the authoritative signal for new game vs age transition.
        var configRunId = null;
        try {
            var cfgRaw = localStorage.getItem("civretro:config");
            if (cfgRaw) { var cfg = JSON.parse(cfgRaw); configRunId = cfg.runId || null; }
        } catch (e) {}

        try {
            var idxRaw = localStorage.getItem("civretro:index");
            var sesRaw = localStorage.getItem("civretro:session");
            if (idxRaw && sesRaw) {
                var idx = JSON.parse(idxRaw);
                var ses = JSON.parse(sesRaw);
                var sessionRunId = ses.runId || null;
                // Resume if: same runId (same driver launch = same game) and
                // either the age just changed or a recent flush exists.
                var sameRun = configRunId && sessionRunId && configRunId === sessionRunId;
                if (sameRun && idx.sessionId && idx.totalTurns > 0) {
                    var ageChanged = (typeof Game !== "undefined") && idx.lastAge !== undefined && idx.lastAge !== Game.age;
                    var ageMs = Date.now() - (idx.lastTs || 0);
                    if (ageChanged || ageMs < 1200000) {
                        sessionId = idx.sessionId;
                        globalTurn = idx.totalTurns;
                        if (idx.ages && idx.ages.length > 0) {
                            currentAge = idx.ages[idx.ages.length - 1].age;
                        }
                        Automation.log("CIVRETRO:session:resume id=" + sessionId + " globalTurn=" + globalTurn
                                       + " ageChanged=" + ageChanged + " ageMs=" + Math.round(ageMs / 1000) + "s");
                        return;
                    }
                }
            }
        } catch (e) {}

        sessionId = "s" + Date.now().toString(36);
        globalTurn = 0;
        currentAge = null;
        Automation.log("CIVRETRO:session:new id=" + sessionId + " runId=" + configRunId);
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
                            var majorIds = Players.getAliveMajorIds();
                            var rels = {};
                            for (var di = 0; di < majorIds.length; di++) {
                                var otherId = majorIds[di];
                                if (otherId === id) continue;
                                try {
                                    rels[otherId] = {
                                        isAtWar:           p.Diplomacy.isAtWarWith       ? p.Diplomacy.isAtWarWith(otherId)       : null,
                                        hasAllied:         p.Diplomacy.hasAllied          ? p.Diplomacy.hasAllied(otherId)          : null,
                                        hasMet:            p.Diplomacy.hasMet             ? p.Diplomacy.hasMet(otherId)             : null,
                                        relationshipLevel: p.Diplomacy.getRelationshipLevel ? p.Diplomacy.getRelationshipLevel(otherId) : null,
                                    };
                                } catch(e) {}
                            }
                            try { rels._favors    = p.Diplomacy.getNumFavors    ? p.Diplomacy.getNumFavors()    : null; } catch(e) {}
                            try { rels._grievances = p.Diplomacy.getNumGrievances ? p.Diplomacy.getNumGrievances() : null; } catch(e) {}
                            return rels;
                        } catch(e) { return null; }
                    })(),
                    victories: (function() {
                        try {
                            // p.Victories methods require VictoryType hash args — use Game.VictoryManager instead
                            // for a hash-free aggregate view of this player's victory state.
                            var vm = (typeof Game !== "undefined") ? Game.VictoryManager : null;
                            if (!vm) return null;
                            var out = {};
                            try { out.progress = vm.getVictoryProgress ? vm.getVictoryProgress() : null; } catch(e) {}
                            try { out.victories = vm.getVictories ? vm.getVictories() : null; } catch(e) {}
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
            var idx = raw ? JSON.parse(raw) : null;
            // Coherent Gameface's native JSON parser can return arrays that don't
            // inherit from the current realm's Array.prototype, causing .push to
            // throw "is not a function". Always re-wrap turns and ages into new
            // native arrays. Also reset the index if it belongs to a different session
            // (stale autoplay index left in localStorage).
            if (!idx || idx.sessionId !== sessionId) {
                idx = { sessionId: sessionId, turns: [], totalTurns: 0, latest: null, lastTs: 0, ages: [] };
            } else {
                idx.turns = Array.isArray(idx.turns) ? idx.turns.slice() : [];
                idx.ages  = Array.isArray(idx.ages)  ? idx.ages.slice()  : [];
            }
            idx.turns.push(globalTurn);
            idx.totalTurns = globalTurn;
            idx.latest = globalTurn;
            idx.lastTs = Date.now();
            idx.lastAge = (snap && snap.age !== undefined) ? snap.age : Game.age;

            // Detect age transitions; snap.age or Game.age indicates the current age
            var snapAge = (snap && snap.age !== undefined) ? snap.age : Game.age;
            if (currentAge === null) {
                // First turn: record starting age but don't push a transition marker
                currentAge = snapAge;
            } else if (snapAge !== currentAge) {
                // Age changed — push a transition marker at the current globalTurn
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

                var configRunId2 = null;
                try {
                    var cfgRaw2 = localStorage.getItem("civretro:config");
                    if (cfgRaw2) { var cfg2 = JSON.parse(cfgRaw2); configRunId2 = cfg2.runId || null; }
                } catch (e) {}

                var meta = {
                    id: sessionId,
                    runId: configRunId2,
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
            localStorage.setItem("civretro:" + sessionId + ":t:" + globalTurn, JSON.stringify(snap));
            if (globalTurn === 1) {
                localStorage.setItem("civretro:firstTurn", JSON.stringify({ sessionId: sessionId, ts: Date.now(), ageTurn: ageTurn }));
            }
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
    // Heartbeat — written every 30s regardless of game events.
    // If heartbeat.ts is recent but index.lastTs is stale, TurnEnd isn't firing.
    // -------------------------------------------------------------------------

    setInterval(function() {
        try {
            localStorage.setItem("civretro:heartbeat", JSON.stringify({
                sessionId: sessionId, globalTurn: globalTurn, ts: Date.now()
            }));
        } catch(e) { Automation.log("CIVRETRO:heartbeat:ERR:" + e.message); }
    }, 30000);

    // -------------------------------------------------------------------------
    // Register event listeners
    // -------------------------------------------------------------------------

    engine.on("GameStarted",          onGameStarted);
    engine.on("TurnEnd",              onTurnEnd);
    engine.on("LocalPlayerTurnBegin", onLocalPlayerTurnBegin);

})();
