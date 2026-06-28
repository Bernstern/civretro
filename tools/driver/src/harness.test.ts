/**
 * Harness unit tests — DFA-driven.
 *
 * Each describe block corresponds to one DFA state or transition group.
 * States: S0(EVAL) S1(ARMED_LOADING) S2(ARM_PENDING) S3(ARMED_READY)
 *         S4(FAILED_READY) S5(GAME_OVER) S6(AGE_TRANSITION)
 *
 * The harness is loaded via createRequire so the CJS export path activates
 * while keeping this test file as ESM. resetModules() is NOT needed because
 * createHarness() is a pure factory — each call gets a fresh closure.
 */

import { createRequire } from "module";
import { describe, it, expect, vi, beforeEach } from "vitest";

const require = createRequire(import.meta.url);
const { createHarness } = require("../../../mod/civretro-harness/ui/autoplay-harness.js") as {
  createHarness: (deps: HarnessDeps) => void;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MockAutoplay {
  isActive: boolean;
  setActive:           ReturnType<typeof vi.fn>;
  setReturnAsPlayer:   ReturnType<typeof vi.fn>;
  setObserveAsPlayer:  ReturnType<typeof vi.fn>;
}

interface MockEngine {
  on:           ReturnType<typeof vi.fn>;
  whenReady:    Promise<void>;
  trigger:      (event: string, ...args: unknown[]) => void;
  resolveReady: () => void;
}

interface MockLocalStorage {
  getItem:    ReturnType<typeof vi.fn>;
  setItem:    ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
  store:      Record<string, string>;
}

interface HarnessDeps {
  engine:       MockEngine;
  Autoplay:     MockAutoplay;
  UI:           { notifyUIReady: ReturnType<typeof vi.fn> };
  Game:         { turn: number } | null;
  Automation:   { log: ReturnType<typeof vi.fn> };
  localStorage: MockLocalStorage;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeAutoplay(isActive = false): MockAutoplay {
  const state = { isActive };
  return {
    get isActive() { return state.isActive; },
    setActive:          vi.fn((v: boolean) => { state.isActive = v; }),
    setReturnAsPlayer:  vi.fn(),
    setObserveAsPlayer: vi.fn(),
  };
}

function makeEngine(): MockEngine {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  let resolveReady!: () => void;
  const whenReady = new Promise<void>(res => { resolveReady = res; });
  return {
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(fn);
    }),
    whenReady,
    trigger: (event: string, ...args: unknown[]) => {
      (handlers[event] ?? []).forEach(fn => fn(...args));
    },
    resolveReady: () => resolveReady(),
  };
}

function makeLocalStorage(initial: Record<string, string> = {}): MockLocalStorage {
  const store: Record<string, string> = { ...initial };
  return {
    getItem:    vi.fn((k: string) => store[k] ?? null),
    setItem:    vi.fn((k: string, v: string) => { store[k] = v; }),
    removeItem: vi.fn((k: string) => { delete store[k]; }),
    store,
  };
}

function makeDeps(overrides: Partial<HarnessDeps> = {}, lsInit: Record<string, string> = {}): HarnessDeps {
  return {
    engine:       makeEngine(),
    Autoplay:     makeAutoplay(),
    UI:           { notifyUIReady: vi.fn() },
    Game:         { turn: 1 },
    Automation:   { log: vi.fn() },
    localStorage: makeLocalStorage(lsInit),
    ...overrides,
  };
}

function config(turns = 10, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ turns, runId: "run1", observeAs: -1, returnAs: 0, ...extra });
}

function harnessState(turnsPlayed = 0, runId = "run1") {
  return JSON.stringify({ runId, turnsPlayed });
}

function gameOver(deps: HarnessDeps) {
  const raw = deps.localStorage.store["civretro:game_over"];
  return raw ? JSON.parse(raw) : null;
}

// ---------------------------------------------------------------------------
// S0 → S1 / S2 / S5  (eval-time arm)
// ---------------------------------------------------------------------------

describe("arm() at eval time", () => {
  it("S0+arm_ok → S1: arms Autoplay when Autoplay is available", () => {
    const deps = makeDeps({}, { "civretro:config": config(10) });
    createHarness(deps);

    expect(deps.Autoplay.setActive).toHaveBeenCalledWith(true);
    expect(deps.Autoplay.isActive).toBe(true);
    expect(gameOver(deps)).toBeNull();
  });

  it("S0+arm_ok_stale → S1: resets turnsPlayed when runId mismatches", () => {
    const deps = makeDeps({}, {
      "civretro:config":        config(10, { runId: "run-new" }),
      "civretro:harness_state": harnessState(7, "run-old"),
    });
    createHarness(deps);

    const stored = JSON.parse(deps.localStorage.store["civretro:harness_state"]);
    expect(stored.turnsPlayed).toBe(0);
    expect(stored.runId).toBe("run-new");
    expect(deps.Autoplay.setActive).toHaveBeenCalledWith(true);
  });

  it("S0+arm_ok (matching runId) → S1: preserves existing turnsPlayed", () => {
    const deps = makeDeps({}, {
      "civretro:config":        config(10),
      "civretro:harness_state": harnessState(4),
    });
    createHarness(deps);

    const stored = JSON.parse(deps.localStorage.store["civretro:harness_state"]);
    expect(stored.turnsPlayed).toBe(4);
    expect(deps.Autoplay.setActive).toHaveBeenCalledWith(true);
  });

  it("S0+arm_fail → S2: silently catches when Autoplay.setActive throws", () => {
    const Autoplay = makeAutoplay();
    Autoplay.setActive.mockImplementation(() => { throw new Error("not ready"); });
    const deps = makeDeps({ Autoplay }, { "civretro:config": config(10) });

    expect(() => createHarness(deps)).not.toThrow();
    expect(gameOver(deps)).toBeNull();
  });

  it("S0+arm_game_over → S5: writes game_over immediately when turn limit already met", () => {
    const deps = makeDeps({}, {
      "civretro:config":        config(10),
      "civretro:harness_state": harnessState(10),
    });
    createHarness(deps);

    expect(deps.Autoplay.setActive).not.toHaveBeenCalled();
    expect(gameOver(deps)).toMatchObject({ reason: "turn_limit" });
  });

  it("unlimited mode (turns=0): arms Autoplay without any turn limit tracking", () => {
    const deps = makeDeps({}, {
      "civretro:config": JSON.stringify({ turns: 0, runId: "run1" }),
    });
    createHarness(deps);

    expect(deps.Autoplay.setActive).toHaveBeenCalledWith(true);
    expect(gameOver(deps)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S2 → S1  (PostGameInitialization fallback arm)
// ---------------------------------------------------------------------------

describe("PostGameInitialization fallback", () => {
  it("S2+PGI/arm_ok → S1: re-arms when Autoplay becomes available after initial failure", () => {
    // First call throws; after PGI Autoplay works
    let calls = 0;
    const Autoplay = makeAutoplay();
    Autoplay.setActive.mockImplementation(() => {
      if (calls++ === 0) throw new Error("not ready");
      Autoplay.isActive = true as never;
    });
    const deps = makeDeps({ Autoplay }, { "civretro:config": config(10) });
    createHarness(deps);

    expect(deps.Autoplay.isActive).toBe(false); // still S2

    deps.engine.trigger("PostGameInitialization");
    expect(deps.Autoplay.setActive).toHaveBeenLastCalledWith(true);
  });

  it("S3+PGI/arm_ok → S3: redundant re-arm in ARMED_READY is harmless", () => {
    const deps = makeDeps({}, { "civretro:config": config(10) });
    createHarness(deps);

    const callsBefore = (deps.Autoplay.setActive as ReturnType<typeof vi.fn>).mock.calls.length;
    deps.engine.trigger("PostGameInitialization");
    expect((deps.Autoplay.setActive as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1);
    expect(gameOver(deps)).toBeNull();
  });

  it("S2+PGI/arm_game_over → S5: detects limit met at PGI time", () => {
    const Autoplay = makeAutoplay();
    Autoplay.setActive.mockImplementation(() => { throw new Error("not ready"); });
    const deps = makeDeps({ Autoplay }, {
      "civretro:config":        config(5),
      "civretro:harness_state": harnessState(5),
    });
    createHarness(deps);
    expect(gameOver(deps)).toMatchObject({ reason: "turn_limit" });
  });
});

// ---------------------------------------------------------------------------
// S1 → S3 / S4  (engine.whenReady)
// ---------------------------------------------------------------------------

describe("engine.whenReady — begin screen bypass", () => {
  it("S1+whenReady_active → S3: calls notifyUIReady when Autoplay is active", async () => {
    const deps = makeDeps({}, { "civretro:config": config(10) });
    createHarness(deps);

    deps.engine.resolveReady();
    await deps.engine.whenReady;

    expect(deps.UI.notifyUIReady).toHaveBeenCalledOnce();
  });

  it("S1+whenReady_inactive → S4: does NOT call notifyUIReady when Autoplay is inactive", async () => {
    // Autoplay unavailable at eval time → stays inactive
    const Autoplay = makeAutoplay();
    Autoplay.setActive.mockImplementation(() => { throw new Error("not ready"); });
    const deps = makeDeps({ Autoplay }, { "civretro:config": config(10) });
    createHarness(deps);

    deps.engine.resolveReady();
    await deps.engine.whenReady;

    expect(deps.UI.notifyUIReady).not.toHaveBeenCalled();
  });

  it("notifyUIReady throwing is caught and logged — no crash", async () => {
    const UI = { notifyUIReady: vi.fn().mockImplementation(() => { throw new Error("ui not ready"); }) };
    const deps = makeDeps({ UI }, { "civretro:config": config(10) });
    createHarness(deps);

    deps.engine.resolveReady();
    await expect(deps.engine.whenReady).resolves.toBeUndefined();
    expect(deps.Automation.log).toHaveBeenCalledWith(expect.stringContaining("notifyUIReady failed"));
  });
});

// ---------------------------------------------------------------------------
// S3 ↔ S3  (TurnEnd counter — below target)
// S3 → S5  (TurnEnd counter — at target)
// ---------------------------------------------------------------------------

describe("TurnEnd counter", () => {
  it("below target: increments turnsPlayed by 1 per fire, no game_over", () => {
    const deps = makeDeps({}, {
      "civretro:config":        config(5),
      "civretro:harness_state": harnessState(0),
    });
    createHarness(deps);

    deps.engine.trigger("TurnEnd");
    deps.engine.trigger("TurnEnd");
    deps.engine.trigger("TurnEnd");

    const stored = JSON.parse(deps.localStorage.store["civretro:harness_state"]);
    expect(stored.turnsPlayed).toBe(3);
    expect(gameOver(deps)).toBeNull();
  });

  it("at target: sets Autoplay inactive and writes game_over exactly once", () => {
    const deps = makeDeps({}, {
      "civretro:config":        config(3),
      "civretro:harness_state": harnessState(2),
    });
    createHarness(deps);

    deps.engine.trigger("TurnEnd"); // turnsPlayed → 3 === target

    expect(deps.Autoplay.setActive).toHaveBeenLastCalledWith(false);
    expect(gameOver(deps)).toMatchObject({ reason: "turn_limit" });
    expect(deps.localStorage.setItem).toHaveBeenCalledWith(
      "civretro:game_over", expect.any(String)
    );
  });

  it("unlimited (turns=0): TurnEnd is a no-op", () => {
    const deps = makeDeps({}, {
      "civretro:config": JSON.stringify({ turns: 0, runId: "run1" }),
    });
    createHarness(deps);

    const beforeKeys = { ...deps.localStorage.store };
    deps.engine.trigger("TurnEnd");
    deps.engine.trigger("TurnEnd");

    // harness_state should not have been written by TurnEnd
    expect(deps.localStorage.store["civretro:harness_state"]).toBe(beforeKeys["civretro:harness_state"]);
    expect(gameOver(deps)).toBeNull();
  });

  it("past target: game_over written only once even if TurnEnd fires again", () => {
    const deps = makeDeps({}, {
      "civretro:config":        config(2),
      "civretro:harness_state": harnessState(1),
    });
    createHarness(deps);

    deps.engine.trigger("TurnEnd"); // turnsPlayed → 2, game_over written
    deps.engine.trigger("TurnEnd"); // turnsPlayed → 3, game_over guard fires

    const setItemCalls = (deps.localStorage.setItem as ReturnType<typeof vi.fn>).mock.calls
      .filter(([k]) => k === "civretro:game_over");
    expect(setItemCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AutoplayEnded guard
// ---------------------------------------------------------------------------

describe("AutoplayEnded guard", () => {
  it("fires with Autoplay.isActive=true (spam): no game_over written", () => {
    const deps = makeDeps({}, { "civretro:config": config(10) });
    createHarness(deps);
    // Autoplay is active from arm()

    for (let i = 0; i < 50; i++) deps.engine.trigger("AutoplayEnded");

    expect(gameOver(deps)).toBeNull();
  });

  it("fires with Autoplay.isActive=false: writes game_over once with autoplay_ended reason", () => {
    const deps = makeDeps({}, { "civretro:config": config(10) });
    createHarness(deps);

    deps.Autoplay.setActive(false); // simulate external deactivation
    deps.engine.trigger("AutoplayEnded");

    expect(gameOver(deps)).toMatchObject({ reason: "autoplay_ended" });
  });

  it("fires 50× with Autoplay.isActive=false: game_over written exactly once", () => {
    const deps = makeDeps({}, { "civretro:config": config(10) });
    createHarness(deps);

    deps.Autoplay.setActive(false);
    for (let i = 0; i < 50; i++) deps.engine.trigger("AutoplayEnded");

    const calls = (deps.localStorage.setItem as ReturnType<typeof vi.fn>).mock.calls
      .filter(([k]) => k === "civretro:game_over");
    expect(calls).toHaveLength(1);
  });

  it("TurnEnd wins the race: reason is turn_limit when both fire in same context", () => {
    const deps = makeDeps({}, {
      "civretro:config":        config(2),
      "civretro:harness_state": harnessState(1),
    });
    createHarness(deps);

    // TurnEnd fires first, sets Autoplay inactive, writes game_over
    deps.engine.trigger("TurnEnd");
    // AutoplayEnded fires after (Autoplay now inactive but gameOverWritten=true)
    deps.engine.trigger("AutoplayEnded");

    expect(gameOver(deps)).toMatchObject({ reason: "turn_limit" });
    const goWrites = (deps.localStorage.setItem as ReturnType<typeof vi.fn>).mock.calls
      .filter(([k]) => k === "civretro:game_over");
    expect(goWrites).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// writeGameOver idempotency
// ---------------------------------------------------------------------------

describe("writeGameOver idempotency", () => {
  it("game_over payload unchanged on repeated trigger", () => {
    const deps = makeDeps({}, {
      "civretro:config":        config(1),
      "civretro:harness_state": harnessState(0),
    });
    createHarness(deps);

    deps.engine.trigger("TurnEnd"); // writes game_over (reason=turn_limit)

    const firstWrite = deps.localStorage.store["civretro:game_over"];

    // PGI fires again after game_over — arm_game_over path
    deps.engine.trigger("PostGameInitialization");

    expect(deps.localStorage.store["civretro:game_over"]).toBe(firstWrite);
  });
});

// ---------------------------------------------------------------------------
// Age transition (S3/S6 → S0[new] via ContextReload)
// ---------------------------------------------------------------------------

describe("age transition", () => {
  it("GAE re-arms Autoplay as belt-and-suspenders", () => {
    const deps = makeDeps({}, { "civretro:config": config(50) });
    createHarness(deps);

    const callsBefore = (deps.Autoplay.setActive as ReturnType<typeof vi.fn>).mock.calls.length;
    deps.engine.trigger("GameAgeEnded");
    expect((deps.Autoplay.setActive as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("new context (ContextReload): turnsPlayed persists and remaining turns are correct", () => {
    // Simulate: Antiquity played 6 turns of a 10-turn target, then age transition.
    // localStorage persists. New IIFE (new createHarness call) reads it.
    const sharedStore = {
      "civretro:config":        config(10),
      "civretro:harness_state": harnessState(6),
    };
    const deps = makeDeps({}, sharedStore);
    createHarness(deps); // new context, fresh gameOverWritten=false

    expect(deps.Autoplay.setActive).toHaveBeenCalledWith(true);
    expect(gameOver(deps)).toBeNull();

    // Verify 4 more TurnEnds triggers game_over
    for (let i = 0; i < 4; i++) deps.engine.trigger("TurnEnd");
    expect(gameOver(deps)).toMatchObject({ reason: "turn_limit" });
    const stored = JSON.parse(deps.localStorage.store["civretro:harness_state"]);
    expect(stored.turnsPlayed).toBe(10);
  });

  it("new context: if turnsPlayed >= target already, writes game_over at eval-time", () => {
    const deps = makeDeps({}, {
      "civretro:config":        config(10),
      "civretro:harness_state": harnessState(10),
    });
    createHarness(deps); // new context

    expect(gameOver(deps)).toMatchObject({ reason: "turn_limit" });
    expect(deps.Autoplay.setActive).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runId stale state detection
// ---------------------------------------------------------------------------

describe("runId stale state detection", () => {
  it("matching runIds: turnsPlayed is preserved (no reset)", () => {
    const deps = makeDeps({}, {
      "civretro:config":        config(10, { runId: "abc" }),
      "civretro:harness_state": JSON.stringify({ runId: "abc", turnsPlayed: 5 }),
    });
    createHarness(deps);

    const stored = JSON.parse(deps.localStorage.store["civretro:harness_state"]);
    expect(stored.turnsPlayed).toBe(5);
  });

  it("mismatching runIds: turnsPlayed reset to 0 and runId updated", () => {
    const deps = makeDeps({}, {
      "civretro:config":        config(10, { runId: "new-run" }),
      "civretro:harness_state": JSON.stringify({ runId: "old-run", turnsPlayed: 99 }),
    });
    createHarness(deps);

    const stored = JSON.parse(deps.localStorage.store["civretro:harness_state"]);
    expect(stored.turnsPlayed).toBe(0);
    expect(stored.runId).toBe("new-run");
  });
});

// ---------------------------------------------------------------------------
// game_over payload shape
// ---------------------------------------------------------------------------

describe("game_over payload", () => {
  it("contains reason, globalTurn, ageTurn, ts", () => {
    const deps = makeDeps({ Game: { turn: 7 } }, {
      "civretro:config":        config(1),
      "civretro:harness_state": harnessState(0),
    });
    createHarness(deps);
    deps.engine.trigger("TurnEnd");

    const go = gameOver(deps);
    expect(go).toMatchObject({
      reason:     "turn_limit",
      ageTurn:    7,
      globalTurn: 1,
    });
    expect(typeof go.ts).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// S4 (FAILED_READY) — documented as unreachable in normal flow
// ---------------------------------------------------------------------------

describe("S4 FAILED_READY — ordering violation", () => {
  it.todo("whenReady resolves before PGI: notifyUIReady not called, game stuck on begin screen");
  it.todo("late PGI after S4: Autoplay armed but notifyUIReady was never called — incomplete recovery");
});
