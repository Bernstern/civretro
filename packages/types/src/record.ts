import { z } from 'zod';
import { SessionMetaSchema } from './session.js';
import { MapSnapshotSchema } from './map.js';
import { TurnSnapshotOkSchema, TurnSnapshotErrorSchema } from './snapshot.js';

// The exporter emits NDJSON where each line is a base payload tagged with a
// `type` discriminator. These envelope schemas describe those lines so both the
// exporter tests and downstream NDJSON consumers can validate a stream.

export const SessionRecordSchema = SessionMetaSchema.extend({
  type: z.literal('session'),
});

export const MapRecordSchema = MapSnapshotSchema.extend({
  type: z.literal('map_snapshot'),
});

export const TurnRecordSchema = z.union([
  TurnSnapshotOkSchema.extend({ type: z.literal('turn') }),
  TurnSnapshotErrorSchema.extend({ type: z.literal('turn') }),
]);

export const ExportRecordSchema = z.union([
  SessionRecordSchema,
  MapRecordSchema,
  TurnRecordSchema,
]);

export type SessionRecord = z.infer<typeof SessionRecordSchema>;
export type MapRecord = z.infer<typeof MapRecordSchema>;
export type TurnRecord = z.infer<typeof TurnRecordSchema>;
export type ExportRecord = z.infer<typeof ExportRecordSchema>;
