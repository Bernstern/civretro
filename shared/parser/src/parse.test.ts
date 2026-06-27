import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeEncodedU32 } from './decode.js';
import { parseSave, readSaveFile } from './parse.js';

const savePath = (name: string): string =>
  fileURLToPath(new URL(`../../../fixtures/saves/${name}`, import.meta.url));

// Ground truth captured from the original parser/analyze.py over the same saves.
const EXPECTED = [
  { file: 'AutoSave_01_0035.Civ7Save', turn: 34, chunks: 89, decompressedSize: 30175845 },
  { file: 'AutoSave_01_0050.Civ7Save', turn: 49, chunks: 96, decompressedSize: 32767286 },
  { file: 'AutoSave_01_0060.Civ7Save', turn: 59, chunks: 100, decompressedSize: 33708882 },
  { file: 'ConfuciusAnt100.Civ7Save', turn: 100, chunks: 54, decompressedSize: 17158814 },
  { file: 'ConfuciusMod1.Civ7Save', turn: 1, chunks: 75, decompressedSize: 18915044 },
  { file: 'LafayetteExp1.Civ7Save', turn: 1, chunks: 72, decompressedSize: 24141421 },
] as const;

describe('decodeEncodedU32', () => {
  it('takes the upper 24 bits and adds 1 when the low byte is 0xFF', () => {
    expect(decodeEncodedU32(0x00006400)).toBe(0x64); // 100 << 8
    expect(decodeEncodedU32(0x000063ff)).toBe(0x64); // (99 << 8) | 0xFF → 99 + 1
  });
});

describe('parseSave over the save fixtures', () => {
  for (const exp of EXPECTED) {
    it(`${exp.file}: decodes turn ${exp.turn} (matches analyze.py)`, () => {
      const summary = readSaveFile(savePath(exp.file));
      expect(summary.magicOk).toBe(true);
      expect(summary.chunkCount).toBe(exp.chunks);
      expect(summary.decompressedSize).toBe(exp.decompressedSize);
      expect(summary.currentTurn).toBe(exp.turn);
    });
  }
});

describe('parseSave on bad input', () => {
  it('degrades gracefully on a non-CIV7 buffer instead of throwing', () => {
    const summary = parseSave(Buffer.from('not a civ7 save at all'), 'bogus.bin');
    expect(summary.magicOk).toBe(false);
    expect(summary.compressedBlockOffset).toBe(-1);
    expect(summary.currentTurn).toBeNull();
    expect(summary.chunkCount).toBe(0);
  });

  it('reads a real save header without error', () => {
    const data = readFileSync(savePath('LafayetteExp1.Civ7Save'));
    expect(data.subarray(0, 4).toString('ascii')).toBe('CIV7');
  });
});
