/**
 * Minimal logger to stderr for the civretro launcher.
 *
 * Environment variables:
 *   CIVRETRO_LOG_LEVEL  — log level name (default: INFO)
 *   CIVRETRO_LOG_JSON   — set to 1/true/yes to emit JSON lines to stderr
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const isLevel = (s: string): s is Level => s in LEVELS;

const envLevel = (process.env['CIVRETRO_LOG_LEVEL'] ?? 'info').toLowerCase();
const threshold = LEVELS[isLevel(envLevel) ? envLevel : 'info'];
const useJson = ['1', 'true', 'yes'].includes(
  (process.env['CIVRETRO_LOG_JSON'] ?? '').toLowerCase(),
);

const pad2 = (n: number): string => String(n).padStart(2, '0');

const timeStr = (d: Date): string =>
  `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

const emit = (name: string, level: Level, msg: string): void => {
  if (LEVELS[level] < threshold) return;
  const tag = level.toUpperCase();
  if (useJson) {
    process.stderr.write(`${JSON.stringify({ ts: Date.now(), level: tag, logger: name, msg })}\n`);
  } else {
    process.stderr.write(`${timeStr(new Date())} ${tag.padEnd(5)} ${name}: ${msg}\n`);
  }
};

export interface Logger {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export const getLogger = (name: string): Logger => ({
  debug: (msg) => emit(name, 'debug', msg),
  info: (msg) => emit(name, 'info', msg),
  warn: (msg) => emit(name, 'warn', msg),
  error: (msg) => emit(name, 'error', msg),
});
