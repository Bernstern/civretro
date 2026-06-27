import { pathToFileURL } from 'node:url';

import { type RunConfig, RunError, run } from './launcher.js';
import { getLogger } from './log.js';

const log = getLogger('civretro.cli');

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const MODE_CHOICES = ['sp', 'mp'];
const SPEED_CHOICES = ['online', 'quick', 'standard', 'epic', 'marathon'];
const MAP_SIZE_CHOICES = ['tiny', 'small', 'standard', 'large', 'huge'];
const MAP_TYPE_CHOICES = [
  'continents',
  'continents-plus',
  'archipelago',
  'fractal',
  'pangaea-plus',
  'shuffle',
  'terra-incognita',
];

const USAGE = `civretro-launch — launch an automated Civ 7 game via CDP

  --n-turns   N     Turn count to run (default: 50)
  --n-players N     Number of AI player slots (2-6, default: 6)
  --seed      N     Map+game seed for reproducibility (default: random)
  --mode      STR   sp or mp (default: sp)
  --speed     STR   online|quick|standard|epic|marathon (default: online)
  --map-size  STR   tiny|small|standard|large|huge (default: small)
  --map-type  STR   continents|continents-plus|archipelago|fractal|pangaea-plus|shuffle|terra-incognita
`;

const parseInt10 = (raw: string | undefined, flag: string): number => {
  if (raw === undefined) throw new Error(`Missing value for ${flag}`);
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`Invalid int value for ${flag}: ${raw}`);
  return n;
};

const requireChoice = (raw: string | undefined, flag: string, choices: string[]): string => {
  if (raw === undefined || !choices.includes(raw)) {
    throw new Error(`Invalid value for ${flag}: ${raw} (choose from ${choices.join(', ')})`);
  }
  return raw;
};

export const parseArgs = (argv: string[]): RunConfig => {
  const cfg: RunConfig = {
    nTurns: 50,
    nPlayers: 6,
    seed: null,
    mode: 'sp',
    speed: 'online',
    mapSize: 'small',
    mapType: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--n-turns':
        cfg.nTurns = parseInt10(argv[++i], a);
        break;
      case '--n-players': {
        const n = parseInt10(argv[++i], a);
        if (n < 2 || n > 6)
          throw new Error(`Invalid value for --n-players: ${n} (choose from 2-6)`);
        cfg.nPlayers = n;
        break;
      }
      case '--seed':
        cfg.seed = parseInt10(argv[++i], a);
        break;
      case '--mode':
        cfg.mode = requireChoice(argv[++i], a, MODE_CHOICES);
        break;
      case '--speed':
        cfg.speed = requireChoice(argv[++i], a, SPEED_CHOICES);
        break;
      case '--map-size':
        cfg.mapSize = requireChoice(argv[++i], a, MAP_SIZE_CHOICES);
        break;
      case '--map-type':
        cfg.mapType = requireChoice(argv[++i], a, MAP_TYPE_CHOICES);
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return cfg;
};

const main = async (): Promise<void> => {
  let cfg: RunConfig;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${errMessage(e)}\n\n${USAGE}`);
    process.exit(2);
  }

  let s: Awaited<ReturnType<typeof run>>;
  try {
    s = await run(cfg);
  } catch (e) {
    if (e instanceof RunError) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  log.info(`done  turns=${s.turnsCaptured}/${s.nTurns}  wall=${s.elapsed.toFixed(0)}s`);
};

// Only drive a real run when invoked as the entry point — importing parseArgs
// from tests must not start the launcher.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
