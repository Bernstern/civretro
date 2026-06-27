import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PlayerSnapshotSchema, OwnersSchema } from './index.js';

// The tools/traces/*.ndjson fixtures come from the legacy CDP trace pipeline,
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

const TRACES_DIR = fileURLToPath(new URL('../../../tools/traces', import.meta.url));

interface TraceLine {
  type: string;
  [k: string]: unknown;
}

const readTrace = (file: string): TraceLine[] =>
  readFileSync(`${TRACES_DIR}/${file}`, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TraceLine);

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
    const turns = readTrace(file).filter((l) => l.type === 'turn');
    if (turns.length === 0) continue;

    describe(file, () => {
      it('every player validates against PlayerSnapshotSchema', () => {
        for (const turn of turns) {
          for (const player of turn.players as unknown[]) {
            const result = PlayerSnapshotSchema.safeParse(player);
            if (!result.success) {
              throw new Error(`player failed in ${file}: ${JSON.stringify(result.error.issues.slice(0, 3))}`);
            }
            totalPlayersValidated++;
          }
        }
      });

      it('owners is a numeric grid of length mapW*mapH', () => {
        for (const turn of turns) {
          expect(OwnersSchema.safeParse(turn.owners).success).toBe(true);
          expect((turn.owners as number[]).length).toBe((turn.mapW as number) * (turn.mapH as number));
        }
      });
    });
  }

  it('validated player snapshots across the fixtures', () => {
    expect(totalPlayersValidated).toBeGreaterThan(0);
  });
});
