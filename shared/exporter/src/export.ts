import type { ExportRecord, PlayerSnapshot, TurnSnapshot } from '@civretro/types';
import { type Db, getAllMapSnapshots, getAllTurns, getSession } from './db.js';

// Known age hashes (Game.age). Used only for human-readable CLI summaries; the
// exported NDJSON keeps the numeric hash for fidelity.
const AGE_NAMES: Record<number, string> = {
  2077444219: 'Antiquity',
  [-610349106]: 'Exploration',
  // A third age hash 1907737892 is present in live data (Civ VII's Modern age),
  // but the hash↔name mapping is unconfirmed — fall back to the numeric value.
};

export const ageName = (age: number): string => AGE_NAMES[age] ?? String(age);

// Assemble the full export in canonical order: session, then one map snapshot
// per age, then every turn ordered by globalTurn.
export const buildRecords = (db: Db): ExportRecord[] => {
  const records: ExportRecord[] = [];

  const session = getSession(db);
  if (session) records.push({ type: 'session', ...session });

  for (const map of getAllMapSnapshots(db)) {
    records.push({ type: 'map_snapshot', ...map });
  }

  for (const turn of getAllTurns(db)) {
    records.push({ type: 'turn', ...turn });
  }

  return records;
};

export const toNdjson = (records: ExportRecord[]): string =>
  records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');

// A turn snapshot is either a full capture or an error placeholder.
export const isErrorTurn = (turn: TurnSnapshot): turn is Extract<TurnSnapshot, { error: string }> =>
  'error' in turn;

// One-line human-readable summaries (used by the --turns and --all CLI views).
export const playerBrief = (p: PlayerSnapshot): string =>
  `p${p.id}(${p.leaderName ?? p.name}) gold=${p.gold} cities=${p.numCities} units=${p.units.length}`;

export const turnSummary = (turn: TurnSnapshot): string => {
  if (isErrorTurn(turn)) return `  g${turn.globalTurn}/t${turn.ageTurn}: ERROR=${turn.error}`;
  const players = turn.players.map(playerBrief).join(', ');
  return `  g${turn.globalTurn}/t${turn.ageTurn} age=${ageName(turn.age)} ${turn.mapW}x${turn.mapH} players=[${players}]`;
};
