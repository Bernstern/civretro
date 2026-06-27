import { z } from 'zod';

const finiteNumber = z.number().finite();

// One terrain/resource/feature tile. Each lookup is guarded to null in
// captureMapSnapshot(); -1 is the game's "none" value (not null).
export const TileRecordSchema = z
  .object({
    terrain: finiteNumber.nullable(),
    resource: finiteNumber.nullable(),
    feature: finiteNumber.nullable(),
  })
  .readonly();

// One-shot per-age map capture, written by recorder.js captureMapSnapshot() to
// localStorage key `civretro:map:{age}`. `tiles` is row-major, length mapW*mapH.
export const MapSnapshotSchema = z
  .object({
    sessionId: z.string(),
    age: finiteNumber,
    globalTurnAtCapture: finiteNumber,
    ts: finiteNumber,
    mapW: finiteNumber,
    mapH: finiteNumber,
    tiles: z.array(TileRecordSchema).readonly(),
  })
  .readonly();

export type TileRecord = z.infer<typeof TileRecordSchema>;
export type MapSnapshot = z.infer<typeof MapSnapshotSchema>;
