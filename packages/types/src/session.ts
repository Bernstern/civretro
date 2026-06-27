import { z } from 'zod';

// Session metadata, written once at game start by recorder.js onGameStarted()
// to localStorage key `civretro:session`.
export const SessionMetaSchema = z.object({
  id: z.string(),
  startTurn: z.number(),
  age: z.number(),
  ts: z.number(),
  localPlayerId: z.number(),
  isMP: z.boolean(),
});

// An age-transition marker, appended to the index when Game.age changes.
export const AgeMarkerSchema = z.object({
  age: z.number(),
  atGlobalTurn: z.number(),
  ts: z.number(),
});

// The turn index, written by recorder.js updateIndex() to `civretro:index`.
// `latest` is null until the first turn is captured; `lastAge` was added later
// so older indexes omit it.
export const SessionIndexSchema = z.object({
  sessionId: z.string(),
  turns: z.array(z.number()),
  totalTurns: z.number(),
  latest: z.number().nullable(),
  lastTs: z.number(),
  ages: z.array(AgeMarkerSchema),
  lastAge: z.number().optional(),
});

export type SessionMeta = z.infer<typeof SessionMetaSchema>;
export type AgeMarker = z.infer<typeof AgeMarkerSchema>;
export type SessionIndex = z.infer<typeof SessionIndexSchema>;
