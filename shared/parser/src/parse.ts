import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  decompressGameState,
  extractCurrentTurn,
  findCompressedBlock,
  findMarkerValues,
  MAGIC,
  readChunks,
} from './decode.js';

// High-level save parsing. The current .Civ7Save reverse-engineering only yields
// a handful of scalars (turn, plus the marker values), so this does NOT yet map
// to the full @civretro/types TurnSnapshot — that mapping is future work once
// more of the format is decoded.

export interface SaveSummary {
  readonly file: string;
  readonly fileSize: number;
  readonly magicOk: boolean;
  readonly compressedBlockOffset: number;
  readonly chunkCount: number;
  readonly decompressedSize: number;
  readonly currentTurn: number | null;
  // Decoded values per known marker (the entries that decoded to a number).
  readonly markers: Readonly<Record<string, readonly number[]>>;
}

const decodedValues = (dec: Buffer): Record<string, readonly number[]> => {
  const out: Record<string, readonly number[]> = {};
  for (const [name, entries] of Object.entries(findMarkerValues(dec))) {
    out[name] = entries.flatMap((e) => (e.value === null ? [] : [e.value]));
  }
  return out;
};

// Parse already-loaded save bytes. Degrades gracefully: a non-CIV7 file or one
// with no compressed block yields a summary with magicOk/empty fields rather
// than throwing, so callers can report bad input as data.
export const parseSave = (data: Buffer, file: string): SaveSummary => {
  const magicOk = data.subarray(0, 4).equals(MAGIC);
  const offset = findCompressedBlock(data);
  if (offset < 0) {
    return {
      file,
      fileSize: data.length,
      magicOk,
      compressedBlockOffset: -1,
      chunkCount: 0,
      decompressedSize: 0,
      currentTurn: null,
      markers: {},
    };
  }

  const { chunks } = readChunks(data, offset);
  const dec = decompressGameState(chunks);
  return {
    file,
    fileSize: data.length,
    magicOk,
    compressedBlockOffset: offset,
    chunkCount: chunks.length,
    decompressedSize: dec.length,
    currentTurn: extractCurrentTurn(dec),
    markers: decodedValues(dec),
  };
};

export const readSaveFile = (path: string): SaveSummary =>
  parseSave(readFileSync(path), basename(path));

// One marker compared across two saves; `changed` flags a difference.
export interface MarkerDiff {
  readonly marker: string;
  readonly a: readonly number[];
  readonly b: readonly number[];
  readonly changed: boolean;
}

export const compareSaves = (a: SaveSummary, b: SaveSummary): readonly MarkerDiff[] => {
  const names = new Set([...Object.keys(a.markers), ...Object.keys(b.markers)]);
  return [...names].sort().map((marker) => {
    const va = a.markers[marker] ?? [];
    const vb = b.markers[marker] ?? [];
    return { marker, a: va, b: vb, changed: JSON.stringify(va) !== JSON.stringify(vb) };
  });
};
