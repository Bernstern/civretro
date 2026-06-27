import { z } from 'zod';

// Per-turn omniscient snapshot, written by recorder.js captureOmniscient() to
// localStorage key `civretro:t:{globalTurn}`. Schemas are derived from that
// function and cross-referenced against captured game data (live LocalStorage
// and the fixtures/traces/*.ndjson files).
//
// Three data generations must all validate against these schemas:
//   - the current repo recorder.js,
//   - older deployed recorders (live DB: diplomacy field names differ, cities
//     lack currentProduction, victories is {}),
//   - the legacy CDP trace pipeline (fixtures/traces: cities carry origOwner,
//     units carry name/maxDmg, and the late-added player fields are absent).
// Fields that diverge across generations are marked .optional() so a single
// schema spans them; value-level nullability is kept precise.
//
// Parsed data is immutable (.readonly()) and numbers reject NaN/Infinity
// (.finite()), per AGENTS.md.

const finiteNumber = z.number().finite();

export const CityRecordSchema = z
  .object({
    name: z.string(),
    // x/y come from c.location, which the recorder guards with `? : null`.
    x: finiteNumber.nullable(),
    y: finiteNumber.nullable(),
    pop: finiteNumber,
    isCapital: z.boolean(),
    isTown: z.boolean(),
    owner: finiteNumber,
    // recorder.js emits this BuildQueue production hash; older snapshots omit it.
    currentProduction: finiteNumber.nullable().optional(),
    // legacy CDP trace pipeline only; recorder.js does not emit it.
    origOwner: finiteNumber.optional(),
  })
  .readonly();

export const UnitRecordSchema = z
  .object({
    typeName: z.string(),
    // x/y can be the -9999 garrison/at-sea sentinel, or null when location is absent.
    x: finiteNumber.nullable(),
    y: finiteNumber.nullable(),
    dmg: finiteNumber.nullable(), // u.Health?.damage, guarded to null
    owner: finiteNumber,
    // legacy CDP trace pipeline only; recorder.js does not emit these.
    name: z.string().optional(),
    maxDmg: finiteNumber.optional(),
  })
  .readonly();

// captureOmniscient() always writes all seven keys; getNetYield is guarded to null.
export const YieldsSchema = z
  .object({
    YIELD_FOOD: finiteNumber.nullable(),
    YIELD_PRODUCTION: finiteNumber.nullable(),
    YIELD_GOLD: finiteNumber.nullable(),
    YIELD_SCIENCE: finiteNumber.nullable(),
    YIELD_CULTURE: finiteNumber.nullable(),
    YIELD_HAPPINESS: finiteNumber.nullable(),
    YIELD_DIPLOMACY: finiteNumber.nullable(),
  })
  .readonly();

// A researched-tech entry from the Techs API. Current recorders emit objects
// like {type,state,progress,depth,maxDepth}; some versions push raw hash ints.
// passthrough() tolerates extra/missing API fields.
export const TechEntrySchema = z
  .object({
    type: finiteNumber,
    state: finiteNumber,
    progress: finiteNumber,
    depth: finiteNumber,
    maxDepth: finiteNumber,
  })
  .partial()
  .passthrough();

// Diplomacy is a record keyed by other players' ids, plus scalar _favors /
// _grievances entries. The per-relationship field names differ across recorder
// versions (repo: isAtWar/hasAllied/hasMet/relationshipLevel; deployed:
// warState/hasAlliance/influence), so values stay unknown.
export const DiplomacySchema = z.record(z.string(), z.unknown()).readonly().nullable();

// Game.VictoryManager aggregate. Empty object when the manager returns nothing.
export const VictoriesSchema = z
  .object({
    progress: z.array(z.unknown()).readonly().nullable(),
    victories: z.array(z.unknown()).readonly().nullable(),
  })
  .partial()
  .readonly()
  .nullable();

export const PlayerSnapshotSchema = z
  .object({
    id: finiteNumber,
    name: z.string(),
    // recorder.js Locale.compose(p.name); legacy CDP traces omit it.
    leaderName: z.string().optional(),
    civType: finiteNumber,
    leaderType: finiteNumber,
    isHuman: z.boolean(),
    isAlive: z.boolean(),
    gold: finiteNumber.nullable(), // p.Treasury?.goldBalance ?? null (can be fractional)
    numCities: finiteNumber.nullable(), // p.Stats?.numCities ?? null
    yields: YieldsSchema,
    cities: z.array(CityRecordSchema).readonly(),
    units: z.array(UnitRecordSchema).readonly(),
    legacyScore: finiteNumber.nullable(), // always 0 currently; null if LegacyPaths unavailable
    // The four below were added after the legacy trace pipeline, so they are
    // optional; their values are also nullable per recorder.js guards.
    techs: z
      .array(z.union([finiteNumber, TechEntrySchema]))
      .readonly()
      .nullable()
      .optional(),
    // known gap: recorder.js civics returns null until the probe fix lands.
    civics: z.array(z.unknown()).readonly().nullable().optional(),
    diplomacy: DiplomacySchema.optional(),
    victories: VictoriesSchema.optional(),
  })
  .readonly();

// Flat owner-id grid, row-major, length === mapW * mapH. -1 means unowned.
export const OwnersSchema = z.array(finiteNumber).readonly();

const turnBase = {
  globalTurn: finiteNumber,
  ageTurn: finiteNumber,
  ts: finiteNumber,
};

export const TurnSnapshotOkSchema = z
  .object({
    ...turnBase,
    age: finiteNumber,
    mapW: finiteNumber,
    mapH: finiteNumber,
    localPlayerId: finiteNumber,
    players: z.array(PlayerSnapshotSchema).readonly(),
    owners: OwnersSchema,
  })
  .readonly();

// captureOmniscient() returns this shape from its top-level catch.
export const TurnSnapshotErrorSchema = z
  .object({
    ...turnBase,
    error: z.string(),
  })
  .readonly();

export const TurnSnapshotSchema = z.union([TurnSnapshotOkSchema, TurnSnapshotErrorSchema]);

export type CityRecord = z.infer<typeof CityRecordSchema>;
export type UnitRecord = z.infer<typeof UnitRecordSchema>;
export type Yields = z.infer<typeof YieldsSchema>;
export type TechEntry = z.infer<typeof TechEntrySchema>;
export type PlayerSnapshot = z.infer<typeof PlayerSnapshotSchema>;
export type TurnSnapshotOk = z.infer<typeof TurnSnapshotOkSchema>;
export type TurnSnapshotError = z.infer<typeof TurnSnapshotErrorSchema>;
export type TurnSnapshot = z.infer<typeof TurnSnapshotSchema>;
