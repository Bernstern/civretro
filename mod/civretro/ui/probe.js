// CivRetro export-channel and game-state probe.
// On GameStarted: fires all channel probes once and logs results.
// On PlayerTurnActivated: emits a compact snapshot via every working channel.
//
// Run probe-server.py before launching Civ 7.
// After 2-3 turns, check probe-server output and Scripting.log for CIVRETRO: lines.

const TAG = "CIVRETRO";
const WS_URL  = "ws://127.0.0.1:8765";
const HTTP_URL = "http://127.0.0.1:8766/turn";

// --- safe wrapper: returns the value or an error string, never throws ---
function safe(label, fn) {
    try {
        const v = fn();
        return v === undefined ? `${label}:undefined` : v;
    } catch (e) {
        return `${label}:ERR:${e.message}`;
    }
}

// --- output channels ---

function toLog(obj) {
    try { console.log(`${TAG}:${JSON.stringify(obj)}`); return true; } catch (_) { return false; }
}

function toAutomation(obj) {
    try {
        if (typeof Automation === "undefined") return "Automation:undefined";
        Automation.log(`${TAG}:${JSON.stringify(obj)}`);
        return true;
    } catch (e) { return `Automation:ERR:${e.message}`; }
}

function toClipboard(obj) {
    try {
        if (typeof UI === "undefined" || !UI.setClipboardText) return "UI.setClipboardText:undefined";
        UI.setClipboardText(`${TAG}:${JSON.stringify(obj)}`);
        return true;
    } catch (e) { return `clipboard:ERR:${e.message}`; }
}

// WebSocket — persistent connection, reconnects on close.
let ws = null;
let wsReady = false;

function openWS() {
    try {
        ws = new WebSocket(WS_URL);
        ws.onopen  = () => { wsReady = true;  toLog({ch:"ws", status:"open"}); };
        ws.onclose = (e) => { wsReady = false; toLog({ch:"ws", status:"closed", code:e.code}); };
        ws.onerror = ()  => { wsReady = false; toLog({ch:"ws", status:"error"}); };
        return "ws:connecting";
    } catch (e) { return `ws:ERR:${e.message}`; }
}

function toWS(obj) {
    if (!ws || ws.readyState !== 1) return "ws:not_ready";
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return `ws:ERR:${e.message}`; }
}

function toHTTP(obj) {
    try {
        fetch(HTTP_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(obj),
        })
        .then(r  => toLog({ch:"http", status:r.status}))
        .catch(e => toLog({ch:"http", err:e.message}));
        return "http:pending";
    } catch (e) { return `http:ERR:${e.message}`; }
}

// --- game state snapshot ---

function snapshot() {
    const localId = safe("localId", () => GameContext.localPlayerID);
    const p = safe("player", () => Players.get(localId));

    // Probe GameplayMap in this isolate — key unknown.
    const gmOwner   = safe("gm.owner",   () => GameplayMap.getOwner(0, 0));
    const gmTerrain = safe("gm.terrain", () => GameplayMap.getTerrainType(0, 0));
    const gmWidth   = safe("gm.width",   () => GameplayMap.getGridWidth());
    const gmHeight  = safe("gm.height",  () => GameplayMap.getGridHeight());

    const cities = safe("cities", () =>
        (p?.Cities?.getCities?.() ?? []).map(c => ({
            name: c.name,
            loc:  c.location,
            pop:  c.population,
            prod: c.BuildQueue?.CurrentProductionTypeHash,
        }))
    );

    const units = safe("units", () =>
        (p?.Units?.getUnits?.() ?? []).slice(0, 5).map(u => ({
            type:   u.type,
            loc:    u.location,
            damage: u.Health?.damage,
            moved:  u.hasMoved,
        }))
    );

    return {
        turn:       safe("turn",     () => Game.turn),
        age:        safe("age",      () => Game.age),
        localId,
        playerName: safe("name",     () => {
            const cfg = Configuration.getPlayer(localId);
            return cfg?.nickName_T2GP || cfg?.nickName_1P || null;
        }),
        gold:       safe("gold",     () => p?.Treasury?.goldBalance),
        goldIncome: safe("goldInc",  () => p?.Stats?.getNetYield?.(YieldTypes?.["YIELD_GOLD"])),
        science:    safe("science",  () => p?.Stats?.getNetYield?.(YieldTypes?.["YIELD_SCIENCE"])),
        culture:    safe("culture",  () => p?.Stats?.getNetYield?.(YieldTypes?.["YIELD_CULTURE"])),
        numCities:  safe("nCities",  () => p?.Stats?.numCities),
        numUnits:   safe("nUnits",   () => p?.Units?.getUnits?.()?.length),
        gm: { owner: gmOwner, terrain: gmTerrain, width: gmWidth, height: gmHeight },
        cities,
        units,
        ts: Date.now(),
    };
}

// --- probe run (called once on GameStarted) ---

function runChannelProbe() {
    const snap = snapshot();
    const results = {
        type:        "PROBE",
        snap,
        channels: {
            consoleLog:   toLog(snap),
            automationLog: toAutomation(snap),
            clipboard:    toClipboard(snap),
            webSocket:    toWS(snap),
            http:         toHTTP(snap),
        },
    };
    // Always land in Scripting.log regardless of other channels.
    console.log(`${TAG}:CHANNEL_RESULTS:${JSON.stringify(results.channels)}`);
}

// --- per-turn emit (lightweight, all channels) ---

function emitTurn() {
    const snap = snapshot();
    toLog({ type: "TURN", ...snap });
    toAutomation({ type: "TURN", turn: snap.turn, gold: snap.gold });
    toWS({ type: "TURN", ...snap });
    toHTTP({ type: "TURN", ...snap });
}

// --- init ---

function init() {
    console.log(`${TAG}:INIT turn=${safe("turn", () => Game.turn)}`);
    openWS();
    // Brief delay so WS handshake can complete before probe fires.
    setTimeout(runChannelProbe, 1500);
}

engine.on("GameStarted",           init);
engine.on("LocalPlayerTurnBegin", emitTurn);
