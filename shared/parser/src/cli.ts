import { fileURLToPath } from 'node:url';
import { compareSaves, readSaveFile, type SaveSummary } from './parse.js';

const USAGE = `civretro-parse — decode Civ 7 .Civ7Save files

  <save>                 Decode one save and print a report
  --all <save...>        One summary line per save
  --compare <a> <b>      Diff known marker values between two saves
  --json <save>          Print the parsed summary as JSON
`;

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const reportLine = (s: SaveSummary): string =>
  `${s.file} magic=${s.magicOk ? 'OK' : 'BAD'} chunks=${s.chunkCount} dec=${s.decompressedSize} turn=${s.currentTurn}`;

const printReport = (s: SaveSummary): void => {
  console.log(`=== ${s.file} ===`);
  console.log(`  size=${s.fileSize} magic=${s.magicOk ? 'OK' : 'BAD'}`);
  console.log(
    `  compressedBlock=0x${s.compressedBlockOffset.toString(16)} chunks=${s.chunkCount} decompressed=${s.decompressedSize}`,
  );
  console.log(`  currentTurn=${s.currentTurn}`);
  for (const [name, values] of Object.entries(s.markers)) {
    console.log(
      `  ${name}: ${values.length > 0 ? values.slice(0, 8).join(', ') : '(no decoded values)'}`,
    );
  }
};

const printCompare = (a: SaveSummary, b: SaveSummary): void => {
  console.log(`=== ${a.file} vs ${b.file} ===`);
  for (const d of compareSaves(a, b)) {
    console.log(
      `  ${d.marker}${d.changed ? ' ← CHANGED' : ''}\n    a: [${d.a.join(', ')}]\n    b: [${d.b.join(', ')}]`,
    );
  }
};

const main = (argv: readonly string[]): void => {
  const [first, ...rest] = argv;
  if (first === undefined) {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  try {
    if (first === '--all') {
      for (const path of rest) console.log(reportLine(readSaveFile(path)));
    } else if (first === '--compare') {
      const [a, b] = rest;
      if (!a || !b) throw new Error('--compare needs two save paths');
      printCompare(readSaveFile(a), readSaveFile(b));
    } else if (first === '--json') {
      const path = rest[0];
      if (!path) throw new Error('--json needs a save path');
      console.log(JSON.stringify(readSaveFile(path), null, 2));
    } else {
      printReport(readSaveFile(first));
    }
  } catch (e) {
    console.error(`ERROR: ${errMessage(e)}`);
    process.exit(1);
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
