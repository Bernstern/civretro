import { describe, expect, it } from 'vitest';
import { mapSizeType, mapTypeScript, speedType } from './launcher.js';

describe('speed name → DB type', () => {
  it('maps known speeds', () => {
    expect(speedType('online')).toBe('GAMESPEED_ONLINE');
    expect(speedType('marathon')).toBe('GAMESPEED_MARATHON');
  });
  it('is case-insensitive', () => {
    expect(speedType('Quick')).toBe('GAMESPEED_QUICK');
  });
  it('falls back to GAMESPEED_<UPPER> for unknown keys', () => {
    expect(speedType('blitz')).toBe('GAMESPEED_BLITZ');
  });
});

describe('map size name → DB type', () => {
  it('maps known sizes', () => {
    expect(mapSizeType('tiny')).toBe('MAPSIZE_TINY');
    expect(mapSizeType('huge')).toBe('MAPSIZE_HUGE');
  });
  it('falls back to MAPSIZE_<UPPER> for unknown keys', () => {
    expect(mapSizeType('gigantic')).toBe('MAPSIZE_GIGANTIC');
  });
});

describe('map type name → script path', () => {
  it('maps known map types', () => {
    expect(mapTypeScript('continents')).toBe('{base-standard}maps/continents.js');
    expect(mapTypeScript('terra-incognita')).toBe('{base-standard}maps/terra-incognita.js');
  });
  it('falls back to the raw name for unknown keys', () => {
    expect(mapTypeScript('{custom}maps/foo.js')).toBe('{custom}maps/foo.js');
  });
});
