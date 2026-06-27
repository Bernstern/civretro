import { constants, inflateSync } from 'node:zlib';

// Civ 7 .Civ7Save binary decoder. Ported 1:1 from the original parser/analyze.py.
//
// Layout:
//   [4]   "CIV7" magic
//   [...] metadata block
//   [6]   compressed-block marker: 00 00 01 00 78 9C  (u32 chunk_size=65536 + zlib magic)
//   [...] chunked deflate stream: repeat [u32LE size][size bytes] until size <= 1
//   [...] footer
// The joined chunk bytes form one zlib stream (header 78 9C).

export const MAGIC = Buffer.from('CIV7', 'ascii');
const COMPRESSED_MARKER = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x78, 0x9c]);
const FXSBLKED = Buffer.from('FXSBLKED', 'ascii');
const GAME_TURN_MARKER = Buffer.from([0x9d, 0x2c, 0xe6, 0xbd]);

// Known 4-byte chunk-marker ids (hashed keys in the game state).
export const MARKERS: ReadonlyArray<{ bytes: Buffer; name: string }> = [
  { bytes: Buffer.from([0x9d, 0x2c, 0xe6, 0xbd]), name: 'GAME_TURN' },
  { bytes: Buffer.from([0x84, 0x84, 0xc6, 0xd0]), name: 'GAME_AGE' },
  { bytes: Buffer.from([0x0f, 0xfb, 0x8c, 0xc1]), name: 'LEADER_NAME' },
  { bytes: Buffer.from([0x76, 0x97, 0x40, 0xde]), name: 'CIV_NAME' },
  { bytes: Buffer.from([0x23, 0x1e, 0x99, 0x37]), name: 'GOLD_TREASURY' },
  { bytes: Buffer.from([0x50, 0x3c, 0xa8, 0x4a]), name: 'ACCUMULATED_INFLUENCE' },
  { bytes: Buffer.from([0xcb, 0x51, 0x98, 0xf0]), name: 'TURN_HISTORY' },
];

export const findCompressedBlock = (data: Buffer): number => data.indexOf(COMPRESSED_MARKER);

// Read the chunked deflate stream from `start`; returns the raw chunk bytes and
// the offset where the footer begins.
export const readChunks = (data: Buffer, start: number): { chunks: Buffer[]; end: number } => {
  const chunks: Buffer[] = [];
  let offset = start;
  while (offset + 4 <= data.length) {
    const size = data.readUInt32LE(offset);
    offset += 4;
    if (size <= 1) break;
    chunks.push(data.subarray(offset, offset + size));
    offset += size;
  }
  return { chunks, end: offset };
};

// Z_SYNC_FLUSH (not the default Z_FINISH) so a stream with trailing footer bytes
// yields its decoded output instead of throwing Z_BUF_ERROR — matching Python's
// zlib.decompressobj(wbits=47).decompress().
export const decompressGameState = (chunks: Buffer[]): Buffer =>
  inflateSync(Buffer.concat(chunks), { finishFlush: constants.Z_SYNC_FLUSH });

// Firaxis encoded u32: value in the upper 24 bits; a low byte of 0xFF means +1.
export const decodeEncodedU32 = (raw: number): number => {
  let val = (raw >>> 8) & 0xffffff;
  if ((raw & 0xff) === 0xff) val += 1;
  return val;
};

// Every offset of `needle` within `haystack`.
const findAll = (haystack: Buffer, needle: Buffer): number[] => {
  const positions: number[] = [];
  let from = haystack.indexOf(needle);
  while (from !== -1) {
    positions.push(from);
    from = haystack.indexOf(needle, from + 1);
  }
  return positions;
};

export interface ChunkValue {
  offset: number;
  type: number | null;
  value: number | null;
  raw: string | null;
}

// Parse the chunk at `pos`. Observed value layouts by type: 8, 0x407, 0x400.
export const decodeChunkValue = (dec: Buffer, pos: number): ChunkValue => {
  if (pos + 12 > dec.length) return { offset: pos, type: null, value: null, raw: null };

  const chunkType = dec.readUInt32LE(pos + 4);
  const valueStartByType: Record<number, number> = { 8: pos + 12, 1031: pos + 24, 1024: pos + 32 };
  const valStart = valueStartByType[chunkType];

  if (valStart !== undefined && valStart + 4 <= dec.length) {
    const raw = dec.readUInt32LE(valStart);
    return {
      offset: pos,
      type: chunkType,
      value: decodeEncodedU32(raw),
      raw: dec.subarray(valStart, valStart + 4).toString('hex'),
    };
  }
  // Fallback: raw bytes for inspection.
  return {
    offset: pos,
    type: chunkType,
    value: null,
    raw: dec.subarray(pos + 4, pos + 36).toString('hex'),
  };
};

export const findMarkerValues = (dec: Buffer): Record<string, ChunkValue[]> => {
  const results: Record<string, ChunkValue[]> = {};
  for (const { bytes, name } of MARKERS) {
    results[name] = findAll(dec, bytes).map((pos) => decodeChunkValue(dec, pos));
  }
  return results;
};

// Current game turn = max(non-FF) of the FXSBLKED "last-touched turn" array that
// sits within ~256 bytes after the GAME_TURN marker. For autosaves this is the
// displayed turn − 1 (the save is written before players act).
export const extractCurrentTurn = (dec: Buffer): number | null => {
  const gtPos = dec.indexOf(GAME_TURN_MARKER);
  if (gtPos < 0) return null;
  const fxPos = dec.indexOf(FXSBLKED, gtPos);
  if (fxPos < 0 || fxPos >= Math.min(dec.length, gtPos + 256)) return null;

  const arrStart = fxPos + 12; // FXSBLKED(8) + array_type_u32(4)
  let best: number | null = null;
  let ffRun = 0;
  let offset = arrStart;
  while (offset + 4 <= dec.length) {
    const val = dec.readUInt32LE(offset);
    if (val === 0xffffffff) {
      ffRun += 1;
      if (ffRun >= 4) break; // terminal sentinel block
      offset += 4;
      continue;
    }
    ffRun = 0;
    if (val > 0x10000) break; // sanity: turns never exceed 65536
    if (best === null || val > best) best = val;
    offset += 4;
    if (offset - arrStart > 512 * 4) break;
  }
  return best;
};
