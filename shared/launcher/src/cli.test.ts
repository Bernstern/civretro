import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';

describe('parseArgs', () => {
  it('applies defaults with no args', () => {
    expect(parseArgs([])).toEqual({
      nTurns: 50,
      nPlayers: 6,
      seed: null,
      mode: 'sp',
      speed: 'online',
      mapSize: 'small',
      mapType: null,
    });
  });

  it('parses overrides', () => {
    const cfg = parseArgs([
      '--n-turns',
      '5',
      '--n-players',
      '2',
      '--seed',
      '42',
      '--mode',
      'mp',
      '--speed',
      'quick',
      '--map-size',
      'tiny',
      '--map-type',
      'continents',
    ]);
    expect(cfg).toEqual({
      nTurns: 5,
      nPlayers: 2,
      seed: 42,
      mode: 'mp',
      speed: 'quick',
      mapSize: 'tiny',
      mapType: 'continents',
    });
  });

  it('throws on an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });

  it('throws on an out-of-range player count', () => {
    expect(() => parseArgs(['--n-players', '9'])).toThrow(/n-players/);
  });

  it('throws on a bad choice value', () => {
    expect(() => parseArgs(['--speed', 'turbo'])).toThrow(/speed/);
  });

  it('throws on a non-integer turn count', () => {
    expect(() => parseArgs(['--n-turns', 'abc'])).toThrow(/Invalid int/);
  });
});
