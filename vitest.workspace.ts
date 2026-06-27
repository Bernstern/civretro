// Run each workspace package with its own vitest.config.ts (so the exporter's
// '@civretro/types' → source alias applies under a root `npm test`).
export default ['packages/*'];
