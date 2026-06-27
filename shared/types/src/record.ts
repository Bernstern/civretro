import { z } from 'zod';
import { MapSnapshotSchema } from './map.js';
import { SessionMetaSchema } from './session.js';
import { TurnSnapshotSchema } from './snapshot.js';

// The exporter emits NDJSON where each line is a base payload tagged with a
// `type` discriminator. These envelope schemas describe those lines so both the
// exporter tests and downstream NDJSON consumers can validate a stream.
//
// Intersection (`.and`) rather than `.extend` because the base schemas are
// `.readonly()` (ZodReadonly has no `.extend`); Zod merges object intersections.

export const SessionRecordSchema = z.object({ type: z.literal('session') }).and(SessionMetaSchema);

export const MapRecordSchema = z.object({ type: z.literal('map_snapshot') }).and(MapSnapshotSchema);

export const TurnRecordSchema = z.object({ type: z.literal('turn') }).and(TurnSnapshotSchema);

export const ExportRecordSchema = z.union([SessionRecordSchema, MapRecordSchema, TurnRecordSchema]);

export type SessionRecord = z.infer<typeof SessionRecordSchema>;
export type MapRecord = z.infer<typeof MapRecordSchema>;
export type TurnRecord = z.infer<typeof TurnRecordSchema>;
export type ExportRecord = z.infer<typeof ExportRecordSchema>;
