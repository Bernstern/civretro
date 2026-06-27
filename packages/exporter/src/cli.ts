import { openDb, getSession, getIndex, getTurn, getAllTurns, type Db } from './db.js';
import { buildRecords, toNdjson, ageName, turnSummary } from './export.js';

// DB path on Windows, reached through WSL. Mirrors tools/read_localstorage.py.
const DEFAULT_DB_PATH =
  "/mnt/c/Users/Bernie Conrad/AppData/Local/Firaxis Games/Sid Meier's Civilization VII/LocalStorage.sqlite";

interface Args {
  latest: boolean;
  all: boolean;
  turns: boolean;
  session: string | null;
  turn: number | null;
  db: string;
}

const USAGE = `civretro-export — read recorder data from LocalStorage.sqlite

  --latest          Export the current session as NDJSON to stdout
  --session <id>    Export the session with this id (if it is the stored one)
  --turns           List captured turns with a brief per-turn summary
  --turn <n>        Pretty-print the snapshot for global turn n
  --all             Summarize all civretro keys (default)
  --db <path>       Override the LocalStorage.sqlite path
`;

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    latest: false,
    all: false,
    turns: false,
    session: null,
    turn: null,
    db: DEFAULT_DB_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--latest': args.latest = true; break;
      case '--turns': args.turns = true; break;
      case '--all': args.all = true; break;
      case '--session': args.session = argv[++i] ?? null; break;
      case '--turn': args.turn = Number(argv[++i]); break;
      case '--db': args.db = argv[++i] ?? args.db; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  // Mirror read_localstorage.py: default to the --all summary.
  if (!args.latest && !args.turns && !args.session && args.turn === null) args.all = true;
  return args;
};

const printLatest = (db: Db): void => {
  process.stdout.write(toNdjson(buildRecords(db)));
};

const printSession = (db: Db, id: string): void => {
  const session = getSession(db);
  if (!session || session.id !== id) {
    throw new Error(`No stored session with id ${id} (stored: ${session?.id ?? 'none'})`);
  }
  process.stdout.write(toNdjson(buildRecords(db)));
};

const printTurns = (db: Db): void => {
  const turns = getAllTurns(db);
  console.log(`Captured turns (${turns.length}):`);
  for (const turn of turns) console.log(turnSummary(turn));
};

const printTurn = (db: Db, n: number): void => {
  const turn = getTurn(db, n);
  if (!turn) {
    console.log(`No data for global turn ${n}`);
    return;
  }
  console.log(JSON.stringify(turn, null, 2));
};

const printAll = (db: Db): void => {
  const session = getSession(db);
  const index = getIndex(db);
  if (session) {
    console.log(
      `[session] id=${session.id} startTurn=${session.startTurn} age=${ageName(session.age)} mp=${session.isMP} localPlayer=${session.localPlayerId}`,
    );
  }
  if (index) {
    console.log(`[index] sessionId=${index.sessionId} totalTurns=${index.totalTurns} latest=${index.latest}`);
  }
  for (const turn of getAllTurns(db)) console.log(turnSummary(turn));
};

const main = (): void => {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }

  let db: Db;
  try {
    db = openDb(args.db);
  } catch (e) {
    console.error(`ERROR: cannot open LocalStorage.sqlite at ${args.db}: ${(e as Error).message}`);
    process.exit(1);
  }

  try {
    if (args.latest) printLatest(db);
    else if (args.session) printSession(db, args.session);
    else if (args.turns) printTurns(db);
    else if (args.turn !== null) printTurn(db, args.turn);
    else printAll(db);
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
};

main();
