import { z } from 'zod';

const finiteNumber = z.number().finite();

// Session metadata, written once at game start by recorder.js onGameStarted()
// to localStorage key `civretro:session`.
export const SessionMetaSchema = z
  .object({
    id: z.string(),
    startTurn: finiteNumber,
    age: finiteNumber,
    ts: finiteNumber,
    localPlayerId: finiteNumber,
    isMP: z.boolean(),
  })
  .readonly();

// An age-transition marker, appended to the index when Game.age changes.
export const AgeMarkerSchema = z
  .object({
    age: finiteNumber,
    atGlobalTurn: finiteNumber,
    ts: finiteNumber,
  })
  .readonly();

// The turn index, written by recorder.js updateIndex() to `civretro:index`.
// `latest` is null until the first turn is captured; `lastAge` was added later
// so older indexes omit it.
export const SessionIndexSchema = z
  .object({
    sessionId: z.string(),
    turns: z.array(finiteNumber).readonly(),
    totalTurns: finiteNumber,
    latest: finiteNumber.nullable(),
    lastTs: finiteNumber,
    ages: z.array(AgeMarkerSchema).readonly(),
    lastAge: finiteNumber.optional(),
  })
  .readonly();

export type SessionMeta = z.infer<typeof SessionMetaSchema>;
export type AgeMarker = z.infer<typeof AgeMarkerSchema>;
export type SessionIndex = z.infer<typeof SessionIndexSchema>;
