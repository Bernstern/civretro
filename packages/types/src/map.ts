import { z } from 'zod';

// One terrain/resource/feature tile. Each lookup is guarded to null in
// captureMapSnapshot(); -1 is the game's "none" value (not null).
export const TileRecordSchema = z.object({
  terrain: z.number().nullable(),
  resource: z.number().nullable(),
  feature: z.number().nullable(),
});

// One-shot per-age map capture, written by recorder.js captureMapSnapshot() to
// localStorage key `civretro:map:{age}`. `tiles` is row-major, length mapW*mapH.
export const MapSnapshotSchema = z.object({
  sessionId: z.string(),
  age: z.number(),
  globalTurnAtCapture: z.number(),
  ts: z.number(),
  mapW: z.number(),
  mapH: z.number(),
  tiles: z.array(TileRecordSchema),
});

export type TileRecord = z.infer<typeof TileRecordSchema>;
export type MapSnapshot = z.infer<typeof MapSnapshotSchema>;
