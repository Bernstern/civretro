import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OwnersSchema, PlayerSnapshotSchema } from './index.js';

// The fixtures/traces/*.ndjson files come from the legacy CDP trace pipeline,
// not the current recorder. Their top-level `turn` wrapper differs from the
// recorder's TurnSnapshot (turn/seq/session/autoplayActive vs. globalTurn/
// ageTurn/localPlayerId), but the nested players/cities/units/owners — the real
// captured game state — are the same structures the recorder emits. We validate
// those shared substructures against the schemas.
//
// known gap: legacy traces omit the later-added player fields (leaderName,
// techs, civics, diplomacy, victories) and city.currentProduction, and carry
// legacy-only fields (city.origOwner, unit.name, unit.maxDmg). The schemas mark
// all of these optional, so one schema spans both pipelines.

const TRACES_DIR = fileURLToPath(new URL('../../../fixtures/traces', import.meta.url));

const LegacyTurnLineSchema = z.object({
  players: z.array(z.unknown()),
  owners: z.array(z.number()),
  mapW: z.number(),
  mapH: z.number(),
});
type LegacyTurnLine = z.infer<typeof LegacyTurnLineSchema>;

const lineKind = (line: unknown): string => {
  const parsed = z.object({ type: z.string() }).safeParse(line);
  return parsed.success ? parsed.data.type : '';
};

// Parse only the `turn` lines (skipping runmeta/error/gap/age_transition) into
// the legacy wrapper shape.
const readTurnLines = (file: string): LegacyTurnLine[] =>
  readFileSync(`${TRACES_DIR}/${file}`, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l): unknown => JSON.parse(l))
    .filter((line) => lineKind(line) === 'turn')
    .map((line) => LegacyTurnLineSchema.parse(line));

const traceFiles = readdirSync(TRACES_DIR).filter((f) => f.endsWith('.ndjson'));

describe('trace fixtures', () => {
  it('finds trace files to validate', () => {
    expect(traceFiles.length).toBeGreaterThan(0);
  });

  // Some traces are aborted runs (only runmeta + error lines, no turns), so we
  // don't require turns per-file — but the suite as a whole must validate real
  // captured turns, asserted in the coverage test below.
  let totalPlayersValidated = 0;

  for (const file of traceFiles) {
    const turns = readTurnLines(file);
    if (turns.length === 0) continue;

    describe(file, () => {
      it('every player validates against PlayerSnapshotSchema', () => {
        for (const turn of turns) {
          for (const player of turn.players) {
            const result = PlayerSnapshotSchema.safeParse(player);
            if (!result.success) {
              throw new Error(
                `player failed in ${file}: ${JSON.stringify(result.error.issues.slice(0, 3))}`,
              );
            }
            totalPlayersValidated++;
          }
        }
      });

      it('owners is a numeric grid of length mapW*mapH', () => {
        for (const turn of turns) {
          expect(OwnersSchema.safeParse(turn.owners).success).toBe(true);
          expect(turn.owners.length).toBe(turn.mapW * turn.mapH);
        }
      });
    });
  }

  it('validated player snapshots across the fixtures', () => {
    expect(totalPlayersValidated).toBeGreaterThan(0);
  });
});
