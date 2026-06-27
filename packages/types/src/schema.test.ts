import { describe, it, expect } from 'vitest';
import {
  SessionMetaSchema,
  SessionIndexSchema,
  MapSnapshotSchema,
  TurnSnapshotSchema,
  TurnSnapshotErrorSchema,
  PlayerSnapshotSchema,
} from './index.js';

// A snapshot built to match what the current recorder.js captureOmniscient()
// writes, used as a positive control for the schemas.
const recorderPlayer = {
  id: 0,
  name: 'LOC_LEADER_FRANKLIN_NAME',
  leaderName: 'Benjamin Franklin',
  civType: 2053970112,
  leaderType: 578691269,
  isHuman: false,
  isAlive: true,
  gold: 9369.82,
  numCities: 4,
  yields: {
    YIELD_FOOD: 7,
    YIELD_PRODUCTION: 8,
    YIELD_GOLD: 7,
    YIELD_SCIENCE: 10,
    YIELD_CULTURE: 11,
    YIELD_HAPPINESS: 7,
    YIELD_DIPLOMACY: 13,
  },
  cities: [{ name: 'LOC_CITY', x: 66, y: 32, pop: 30, isCapital: true, isTown: false, owner: 0 }],
  units: [{ typeName: 'UNIT_ARMY_COMMANDER', x: 66, y: 35, dmg: 0, owner: 0 }],
  legacyScore: 0,
  techs: [{ type: -1580632053, state: 5, progress: 0, depth: 1, maxDepth: 1 }],
  // known gap: recorder.js civics returns null until the probe fix lands.
  civics: null,
  // Deployed recorder's diplomacy field names (warState/hasAlliance/influence).
  diplomacy: { '1': { warState: null, hasAlliance: null, influence: null } },
  victories: {},
};

const recorderTurn = {
  globalTurn: 1,
  ageTurn: 1,
  age: 1907737892,
  ts: 1782580943038,
  mapW: 2,
  mapH: 1,
  localPlayerId: 0,
  players: [recorderPlayer],
  owners: [-1, 0],
};

describe('recorder-shaped fixtures', () => {
  it('accepts a full turn snapshot', () => {
    expect(TurnSnapshotSchema.safeParse(recorderTurn).success).toBe(true);
  });

  it('accepts session metadata', () => {
    const session = { id: 's1', startTurn: 1, age: 1907737892, ts: 1, localPlayerId: 0, isMP: false };
    expect(SessionMetaSchema.safeParse(session).success).toBe(true);
  });

  it('accepts a fresh index where latest is null and lastAge is absent', () => {
    const index = { sessionId: 's1', turns: [], totalTurns: 0, latest: null, lastTs: 0, ages: [] };
    expect(SessionIndexSchema.safeParse(index).success).toBe(true);
  });

  it('accepts a map snapshot with -1 (none) tile values', () => {
    const map = {
      sessionId: 's1',
      age: 1907737892,
      globalTurnAtCapture: 0,
      ts: 1,
      mapW: 1,
      mapH: 1,
      tiles: [{ terrain: 4, resource: -1, feature: -1 }],
    };
    expect(MapSnapshotSchema.safeParse(map).success).toBe(true);
  });
});

describe('known nullability', () => {
  it('accepts civics === null (always-null until probe fix)', () => {
    expect(PlayerSnapshotSchema.safeParse({ ...recorderPlayer, civics: null }).success).toBe(true);
  });

  it('accepts legacyScore === null as well as 0', () => {
    expect(PlayerSnapshotSchema.safeParse({ ...recorderPlayer, legacyScore: null }).success).toBe(true);
    expect(PlayerSnapshotSchema.safeParse({ ...recorderPlayer, legacyScore: 0 }).success).toBe(true);
  });

  it('accepts a null gold balance', () => {
    expect(PlayerSnapshotSchema.safeParse({ ...recorderPlayer, gold: null }).success).toBe(true);
  });

  it('accepts the -9999 garrison/at-sea unit sentinel', () => {
    const player = { ...recorderPlayer, units: [{ typeName: 'UNIT_X', x: -9999, y: -9999, dmg: null, owner: 0 }] };
    expect(PlayerSnapshotSchema.safeParse(player).success).toBe(true);
  });

  it('accepts the error-variant turn snapshot', () => {
    const errTurn = { globalTurn: 7, ageTurn: 7, ts: 1, error: 'boom' };
    expect(TurnSnapshotErrorSchema.safeParse(errTurn).success).toBe(true);
    expect(TurnSnapshotSchema.safeParse(errTurn).success).toBe(true);
  });
});
