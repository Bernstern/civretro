import { z } from 'zod';

// Per-turn omniscient snapshot, written by recorder.js captureOmniscient() to
// localStorage key `civretro:t:{globalTurn}`. Schemas are derived from that
// function and cross-referenced against captured game data (live LocalStorage
// and the tools/traces/*.ndjson fixtures).
//
// Three data generations must all validate against these schemas:
//   - the current repo recorder.js,
//   - older deployed recorders (live DB: diplomacy field names differ, cities
//     lack currentProduction, victories is {}),
//   - the legacy CDP trace pipeline (tools/traces: cities carry origOwner,
//     units carry name/maxDmg, and the late-added player fields are absent).
// Fields that diverge across generations are marked .optional() so a single
// schema spans them; value-level nullability is kept precise.

export const CityRecordSchema = z.object({
  name: z.string(),
  // x/y come from c.location, which the recorder guards with `? : null`.
  x: z.number().nullable(),
  y: z.number().nullable(),
  pop: z.number(),
  isCapital: z.boolean(),
  isTown: z.boolean(),
  owner: z.number(),
  // recorder.js emits this BuildQueue production hash; older snapshots omit it.
  currentProduction: z.number().nullable().optional(),
  // legacy CDP trace pipeline only; recorder.js does not emit it.
  origOwner: z.number().optional(),
});

export const UnitRecordSchema = z.object({
  typeName: z.string(),
  // x/y can be the -9999 garrison/at-sea sentinel, or null when location is absent.
  x: z.number().nullable(),
  y: z.number().nullable(),
  dmg: z.number().nullable(), // u.Health?.damage, guarded to null
  owner: z.number(),
  // legacy CDP trace pipeline only; recorder.js does not emit these.
  name: z.string().optional(),
  maxDmg: z.number().optional(),
});

// captureOmniscient() always writes all seven keys; getNetYield is guarded to null.
export const YieldsSchema = z.object({
  YIELD_FOOD: z.number().nullable(),
  YIELD_PRODUCTION: z.number().nullable(),
  YIELD_GOLD: z.number().nullable(),
  YIELD_SCIENCE: z.number().nullable(),
  YIELD_CULTURE: z.number().nullable(),
  YIELD_HAPPINESS: z.number().nullable(),
  YIELD_DIPLOMACY: z.number().nullable(),
});

// A researched-tech entry as dumped from the Techs API. Current recorders emit
// objects like {type,state,progress,depth,maxDepth}; some versions push raw
// hash ints. passthrough() tolerates extra/missing API fields.
export const TechEntrySchema = z
  .object({
    type: z.number(),
    state: z.number(),
    progress: z.number(),
    depth: z.number(),
    maxDepth: z.number(),
  })
  .partial()
  .passthrough();

// Diplomacy is a record keyed by other players' ids, plus scalar _favors /
// _grievances entries. The per-relationship field names differ across recorder
// versions (repo: isAtWar/hasAllied/hasMet/relationshipLevel; deployed:
// warState/hasAlliance/influence), so values stay unknown.
export const DiplomacySchema = z.record(z.string(), z.unknown()).nullable();

// Game.VictoryManager aggregate. Empty object when the manager returns nothing.
export const VictoriesSchema = z
  .object({
    progress: z.array(z.unknown()).nullable(),
    victories: z.array(z.unknown()).nullable(),
  })
  .partial()
  .nullable();

export const PlayerSnapshotSchema = z.object({
  id: z.number(),
  name: z.string(),
  // recorder.js Locale.compose(p.name); legacy CDP traces omit it.
  leaderName: z.string().optional(),
  civType: z.number(),
  leaderType: z.number(),
  isHuman: z.boolean(),
  isAlive: z.boolean(),
  gold: z.number().nullable(), // p.Treasury?.goldBalance ?? null
  numCities: z.number().nullable(), // p.Stats?.numCities ?? null
  yields: YieldsSchema,
  cities: z.array(CityRecordSchema),
  units: z.array(UnitRecordSchema),
  legacyScore: z.number().nullable(), // always 0 currently; null if LegacyPaths is unavailable
  // The four below were added after the legacy trace pipeline, so they are
  // optional; their values are also nullable per recorder.js guards.
  techs: z.array(z.union([z.number(), TechEntrySchema])).nullable().optional(),
  // known gap: recorder.js civics returns null until the probe fix lands.
  civics: z.array(z.unknown()).nullable().optional(),
  diplomacy: DiplomacySchema.optional(),
  victories: VictoriesSchema.optional(),
});

// Flat owner-id grid, row-major, length === mapW * mapH. -1 means unowned.
export const OwnersSchema = z.array(z.number());

const turnBase = {
  globalTurn: z.number(),
  ageTurn: z.number(),
  ts: z.number(),
};

export const TurnSnapshotOkSchema = z.object({
  ...turnBase,
  age: z.number(),
  mapW: z.number(),
  mapH: z.number(),
  localPlayerId: z.number(),
  players: z.array(PlayerSnapshotSchema),
  owners: OwnersSchema,
});

// captureOmniscient() returns this shape from its top-level catch.
export const TurnSnapshotErrorSchema = z.object({
  ...turnBase,
  error: z.string(),
});

export const TurnSnapshotSchema = z.union([TurnSnapshotOkSchema, TurnSnapshotErrorSchema]);

export type CityRecord = z.infer<typeof CityRecordSchema>;
export type UnitRecord = z.infer<typeof UnitRecordSchema>;
export type Yields = z.infer<typeof YieldsSchema>;
export type TechEntry = z.infer<typeof TechEntrySchema>;
export type PlayerSnapshot = z.infer<typeof PlayerSnapshotSchema>;
export type TurnSnapshotOk = z.infer<typeof TurnSnapshotOkSchema>;
export type TurnSnapshotError = z.infer<typeof TurnSnapshotErrorSchema>;
export type TurnSnapshot = z.infer<typeof TurnSnapshotSchema>;
