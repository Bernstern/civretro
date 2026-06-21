// CivRetro API Probe — developer tool.
// Runs once on GameStarted. Dumps all accessible globals and C++ object APIs
// to Automation.log so we can analyze offline for undiscovered export paths.
//
// Automation.log() is confirmed working in MP without any special flags.
// Output lines are prefixed PROBE: for easy grep.

(function () {
    const TAG = "PROBE";
    const SEP = "=".repeat(60);

    function alog(msg) {
        try { Automation.log(TAG + ": " + msg); } catch (_) {}
        try { console.log(TAG + ": " + msg); } catch (_) {}
    }

    // -------------------------------------------------------------------------
    // Safe introspection helpers
    // -------------------------------------------------------------------------

    function safe(fn) {
        try { return fn(); } catch (e) { return "ERR:" + e.message; }
    }

    // Collect all property names visible on an object, including prototype chain.
    // C++ proxy objects expose methods on the prototype, not as own properties.
    function allKeys(obj) {
        const seen = new Set();
        let cur = obj;
        let depth = 0;
        while (cur && depth < 8) {
            try {
                for (const k of Object.getOwnPropertyNames(cur)) seen.add(k);
            } catch (_) {}
            try {
                for (const k of Object.keys(cur)) seen.add(k);
            } catch (_) {}
            try {
                for (const k in cur) seen.add(k);
            } catch (_) {}
            try { cur = Object.getPrototypeOf(cur); } catch (_) { break; }
            depth++;
        }
        return [...seen].sort();
    }

    // Describe a value concisely.
    function describe(val, key) {
        if (val === null) return "null";
        if (val === undefined) return "undefined";
        const t = typeof val;
        if (t === "function") {
            // Try to get argument count hint from toString
            const src = safe(() => val.toString().slice(0, 80).replace(/\s+/g, " "));
            return "function(" + (val.length || "?") + ") " + src;
        }
        if (t === "object") {
            const keys = safe(() => allKeys(val).slice(0, 20).join(","));
            return "object{" + keys + "}";
        }
        return t + ":" + String(val).slice(0, 60);
    }

    // Probe a single object, emit one line per property.
    function probeObj(name, obj) {
        alog(SEP);
        alog("OBJECT: " + name);
        if (obj === undefined || obj === null) { alog("  <" + obj + ">"); return; }
        const keys = allKeys(obj);
        alog("  key_count=" + keys.length);
        for (const k of keys) {
            try {
                const val = obj[k];
                alog("  " + k + " => " + describe(val, k));
            } catch (e) {
                alog("  " + k + " => ACCESS_ERR:" + e.message);
            }
        }
    }

    // Probe a C++ object by trying a broad list of candidate method names
    // (C++ proxies may not enumerate their methods via getOwnPropertyNames).
    function probeByName(name, obj, candidates) {
        alog(SEP);
        alog("OBJECT_BY_NAME: " + name);
        if (obj === undefined || obj === null) { alog("  <" + obj + ">"); return; }
        // First do normal introspection
        const keys = allKeys(obj);
        alog("  enum_keys=" + keys.join(","));
        // Then probe candidates
        const found = [];
        for (const c of candidates) {
            try {
                const val = obj[c];
                if (val !== undefined) found.push(c + "=>" + describe(val, c));
            } catch (_) {}
        }
        alog("  found_candidates=" + found.length);
        for (const f of found) alog("  " + f);
    }

    // -------------------------------------------------------------------------
    // Candidate method names for file/IO/export discovery
    // -------------------------------------------------------------------------

    const FILE_CANDIDATES = [
        "writeFile","readFile","appendFile","deleteFile","fileExists",
        "openFile","closeFile","flushFile","copyFile","moveFile","renameFile",
        "createDir","listDir","getDir","setDir",
        "exportFile","importFile","saveFile","loadFile",
        "writeLine","writeString","writeJSON","writeData","writeBinary",
        "exportData","exportJSON","exportCSV","exportLog","exportSave",
        "copyAutosave","copySave","writeSave","exportSave","dumpState",
        "saveState","loadState","persistState","serializeState",
        "getPath","getSavePath","getLogPath","getDataPath","getModPath",
        "sendData","sendMessage","sendEvent","sendJSON","sendHTTP","sendWS",
        "postMessage","postData","postEvent",
        "broadcast","emit","publish","notify",
        "setProperty","getProperty","setData","getData",
        "setStorage","getStorage","clearStorage",
        "log","warn","error","info","debug","trace","print","output",
        "logToFile","logJSON","logData",
        "trigger","call","on","off","once",
        "ping","pong","sync","flush","commit",
    ];

    const AUTOMATION_CANDIDATES = FILE_CANDIDATES.concat([
        "isActive","setActive","log","warn","error",
        "setParameter","getParameter","setScriptHasLoaded",
        "copyAutosave","saveName","getSaveName","setSaveName",
        "requestSave","performSave","triggerSave","forceSave",
        "setTurns","getTurns","setTest","getTest",
        "passTest","failTest","endTest","completeTest",
        "sendTestComplete","sendTestResult","sendTestStatus",
        "nextTest","runTest","startTest","stopTest",
        "screenshot","captureScreen","dumpScreen",
        "dumpState","dumpGame","dumpMap","dumpPlayers",
        "writeToLog","writeToFile","writeString","writeJSON",
        "getLogPath","getLogFile","openLog","closeLog",
        "setLogPath","setLogFile","setOutput","getOutput",
    ]);

    const NETWORK_CANDIDATES = [
        "hostGame","joinGame","loadGame","saveGame","leaveGame","quitGame",
        "sendData","sendMessage","sendChatMessage","sendTurnData",
        "broadcastMessage","broadcastData","broadcastEvent",
        "postToServer","fetchFromServer","httpGet","httpPost",
        "openSocket","closeSocket","sendSocket","receiveSocket",
        "writeToSharedMemory","readFromSharedMemory",
        "exportToFile","exportGameState","dumpState",
    ];

    const UI_CANDIDATES = [
        "setClipboardText","getClipboardText","copyToClipboard",
        "writeToFile","exportToFile","saveToFile","downloadFile",
        "openURL","navigateToURL","openBrowser",
        "showDialog","hideDialog","showMessage","hideMessage",
        "playSound","stopSound",
        "notifyUIReady","isInGame","getGameLoadingState",
        "setTitle","getTitle","setIcon","getIcon",
        "setWindowTitle","getWindowTitle",
        "openFileDialog","saveFileDialog","selectFile",
        "sendMessage","postMessage","broadcastMessage",
        "sendToNative","callNative","invokeNative",
        "setLocalStorage","getLocalStorage","clearLocalStorage",
        "persistData","readData","writeData",
    ];

    const GAMESTATE_STORAGE_CANDIDATES = [
        "set","get","delete","clear","has","keys","values","entries",
        "setString","getString","setInt","getInt","setFloat","getFloat","setBool","getBool",
        "setJSON","getJSON","serialize","deserialize","export","import",
        "save","load","persist","flush","commit","sync",
        "toJSON","fromJSON","toString","toArray","toObject",
    ];

    // -------------------------------------------------------------------------
    // Global scope dump
    // -------------------------------------------------------------------------

    function dumpGlobals() {
        alog(SEP);
        alog("GLOBALS: enumerating window/global scope");
        const keys = [];
        try { for (const k in window) keys.push(k); } catch (_) {}
        try {
            for (const k of Object.getOwnPropertyNames(window)) {
                if (!keys.includes(k)) keys.push(k);
            }
        } catch (_) {}
        keys.sort();
        alog("  total=" + keys.length);
        // Emit in chunks of 20 per line so Automation.log doesn't truncate
        for (let i = 0; i < keys.length; i += 20) {
            alog("  keys[" + i + "]: " + keys.slice(i, i + 20).join(", "));
        }
        // Flag anything that looks like it might be file/IO/export related
        const interesting = keys.filter(k =>
            /file|write|export|save|dump|log|output|network|socket|fetch|http|ws|storage|persist/i.test(k)
        );
        alog("  io_related=" + interesting.join(", "));
    }

    // -------------------------------------------------------------------------
    // Known objects — standard introspection
    // -------------------------------------------------------------------------

    function dumpKnownObjects() {
        // These are accessible as globals in the game UI isolate
        const knownObjects = [
            ["Game",              typeof Game              !== "undefined" ? Game              : undefined],
            ["Players",           typeof Players           !== "undefined" ? Players           : undefined],
            ["GameplayMap",       typeof GameplayMap       !== "undefined" ? GameplayMap       : undefined],
            ["MapOwnership",      typeof MapOwnership      !== "undefined" ? MapOwnership      : undefined],
            ["GameContext",       typeof GameContext       !== "undefined" ? GameContext        : undefined],
            ["Configuration",     typeof Configuration     !== "undefined" ? Configuration     : undefined],
            ["Network",           typeof Network           !== "undefined" ? Network           : undefined],
            ["Database",          typeof Database          !== "undefined" ? Database          : undefined],
            ["Locale",            typeof Locale            !== "undefined" ? Locale            : undefined],
            ["UI",                typeof UI                !== "undefined" ? UI                : undefined],
            ["GameTutorial",      typeof GameTutorial      !== "undefined" ? GameTutorial      : undefined],
            ["Autoplay",          typeof Autoplay          !== "undefined" ? Autoplay          : undefined],
            ["ContextManager",    typeof ContextManager    !== "undefined" ? ContextManager    : undefined],
            ["NotificationModel", typeof NotificationModel !== "undefined" ? NotificationModel : undefined],
            ["YieldTypes",        typeof YieldTypes        !== "undefined" ? YieldTypes        : undefined],
            ["PlayerIds",         typeof PlayerIds         !== "undefined" ? PlayerIds         : undefined],
            ["SlotStatus",        typeof SlotStatus        !== "undefined" ? SlotStatus        : undefined],
            ["ServerType",        typeof ServerType        !== "undefined" ? ServerType        : undefined],
            ["engine",            typeof engine            !== "undefined" ? engine            : undefined],
            ["Achievements",      typeof Achievements      !== "undefined" ? Achievements      : undefined],
            ["GameStateStorage",  typeof GameStateStorage  !== "undefined" ? GameStateStorage  : undefined],
            ["Display",           typeof Display           !== "undefined" ? Display           : undefined],
            ["Camera",            typeof Camera            !== "undefined" ? Camera            : undefined],
            ["Input",             typeof Input             !== "undefined" ? Input             : undefined],
            ["Audio",             typeof Audio             !== "undefined" ? Audio             : undefined],
            ["WorldAnchor",       typeof WorldAnchor       !== "undefined" ? WorldAnchor       : undefined],
            ["TutorialManager",   typeof TutorialManager   !== "undefined" ? TutorialManager   : undefined],
        ];

        for (const [name, obj] of knownObjects) {
            probeObj(name, obj);
        }
    }

    // -------------------------------------------------------------------------
    // Targeted probes with candidate lists
    // -------------------------------------------------------------------------

    function dumpTargetedProbes() {
        probeByName("Automation_targeted", typeof Automation !== "undefined" ? Automation : undefined, AUTOMATION_CANDIDATES);
        probeByName("Network_targeted",    typeof Network    !== "undefined" ? Network    : undefined, NETWORK_CANDIDATES);
        probeByName("UI_targeted",         typeof UI         !== "undefined" ? UI         : undefined, UI_CANDIDATES);
        probeByName("GameStateStorage_targeted", typeof GameStateStorage !== "undefined" ? GameStateStorage : undefined, GAMESTATE_STORAGE_CANDIDATES);
    }

    // -------------------------------------------------------------------------
    // Web API availability check
    // -------------------------------------------------------------------------

    function dumpWebAPIs() {
        alog(SEP);
        alog("WEB_APIS: checking browser API availability");
        const apis = [
            "fetch","WebSocket","XMLHttpRequest","EventSource",
            "localStorage","sessionStorage","indexedDB","cacheStorage","Cache",
            "Blob","File","FileReader","FileWriter","FileSystem","FileSystemFileHandle",
            "URL","URLSearchParams",
            "Notification","PushManager","ServiceWorker","ServiceWorkerRegistration",
            "BroadcastChannel","MessageChannel","SharedWorker","Worker",
            "RTCPeerConnection","RTCDataChannel",
            "crypto","SubtleCrypto",
            "navigator","location","history",
            "performance","PerformanceObserver",
            "MutationObserver","IntersectionObserver","ResizeObserver",
            "CustomEvent","EventTarget",
            "AbortController","AbortSignal",
            "TextEncoder","TextDecoder",
            "ReadableStream","WritableStream","TransformStream",
            "CompressionStream","DecompressionStream",
            "structuredClone","queueMicrotask",
            "requestAnimationFrame","cancelAnimationFrame",
            "requestIdleCallback","cancelIdleCallback",
        ];
        for (const api of apis) {
            const avail = typeof window[api] !== "undefined";
            if (avail) alog("  AVAIL: " + api + " => " + typeof window[api]);
        }
        alog("  (only available APIs printed)");
    }

    // -------------------------------------------------------------------------
    // Automation object — deep probe for file-writing methods
    // -------------------------------------------------------------------------

    function dumpAutomationDeep() {
        alog(SEP);
        alog("AUTOMATION_DEEP");
        if (typeof Automation === "undefined") { alog("  Automation: undefined"); return; }
        alog("  isActive=" + safe(() => Automation.isActive));
        // Try file-writing candidates specifically
        const fileMethods = [
            "copyAutosave","writeSave","exportSave","saveCopy",
            "writeFile","appendFile","writeLog","writeToFile",
            "exportFile","exportData","exportState","exportGame",
            "dumpState","dumpGame","dumpLog","dumpData",
            "setOutput","getOutput","setLogFile","getLogFile","setLogPath",
            "openFile","closeFile","createFile","deleteFile",
            "getPath","getSavePath","getLogPath","getUserDataPath","getAppDataPath",
        ];
        for (const m of fileMethods) {
            const val = safe(() => Automation[m]);
            if (val !== "ERR:Cannot read properties of undefined" && val !== undefined) {
                alog("  " + m + " => " + describe(val, m));
            }
        }
        // Log the full Automation prototype chain
        let proto = Object.getPrototypeOf(Automation);
        let depth = 0;
        while (proto && depth < 5) {
            const keys = safe(() => Object.getOwnPropertyNames(proto).join(","));
            alog("  proto[" + depth + "]: " + keys);
            proto = Object.getPrototypeOf(proto);
            depth++;
        }
    }

    // -------------------------------------------------------------------------
    // Player object deep probe — what's on a player?
    // -------------------------------------------------------------------------

    function dumpPlayerAPIs() {
        alog(SEP);
        alog("PLAYER_API");
        try {
            const ids = Players.getAliveMajorIds();
            if (!ids || ids.length === 0) { alog("  no players yet"); return; }
            const p = Players.get(ids[0]);
            probeObj("Player[0]", p);
            // Sub-objects
            const subs = ["Treasury","Stats","Cities","Units","Diplomacy","Culture",
                          "LegacyPaths","Victories","Influence","Religion","AI",
                          "Techs","Civics","Ages","Commanders","Narratives"];
            for (const sub of subs) {
                const obj = safe(() => p[sub]);
                if (obj && typeof obj === "object") probeObj("Player[0]." + sub, obj);
            }
            // Probe first city's sub-objects (BuildQueue, etc.)
            try {
                const cs = p.Cities ? p.Cities.getCities() : [];
                if (cs && cs.length > 0) {
                    const city = cs[0];
                    probeObj("City[0]", city);
                    const citySubs = ["BuildQueue","Culture","Religion","Trade"];
                    for (const sub of citySubs) {
                        const obj = safe(() => city[sub]);
                        if (obj && typeof obj === "object") probeObj("City[0]." + sub, obj);
                    }
                } else {
                    alog("  City probe: no cities yet");
                }
            } catch (e) {
                alog("  City probe ERR: " + e.message);
            }
        } catch (e) {
            alog("  ERR: " + e.message);
        }
    }

    // -------------------------------------------------------------------------
    // Entry point
    // -------------------------------------------------------------------------

    function runDump() {
        alog(SEP);
        alog("BEGIN API DUMP — civretro-probe v1");
        alog("turn=" + safe(() => Game.turn) + " age=" + safe(() => Game.age));

        dumpGlobals();
        dumpWebAPIs();
        dumpKnownObjects();
        dumpTargetedProbes();
        dumpAutomationDeep();
        dumpPlayerAPIs();

        alog(SEP);
        alog("END API DUMP");
    }

    // Run after game is loaded so all globals are initialized
    engine.on("GameStarted", function () {
        // Small delay so game state is fully ready
        setTimeout(runDump, 2000);
    });

    alog("civretro-probe loaded — will dump on GameStarted");
})();
