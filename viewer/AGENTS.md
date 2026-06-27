# AGENTS.md — viewer (TypeScript)

Agent context for the TypeScript session viewer. Keep this file terse and command-first; the full
rationale lives in [`../docs/typescript-style.md`](../docs/typescript-style.md). If a rule can be
enforced by tooling, it belongs in `tsconfig.json` / `biome.json`, not here.

## Project

The viewer reads newline-delimited JSON snapshot files written by the Python CDP collector and
lets a user scrub through a recorded Civ 7 session after it ends. TypeScript, strict mode, Zod at
every data boundary.

## Commands

- Install: `pnpm install`
- Dev server: `pnpm dev`
- Type-check (primary gate): `pnpm typecheck`
- Lint + format check: `pnpm check`
- Auto-fix lint + format: `pnpm fix`
- Tests: `pnpm test`
- Single test: `pnpm test <file-or-name>`

## Done criteria

A change is done only when `pnpm typecheck`, `pnpm check`, and `pnpm test` all pass. `typecheck`
is the real gate — it enforces the type-level rules Biome can't.

## Code style (the rules most likely to trip you up)

- **Make illegal states unrepresentable** — discriminated unions (`status`/`kind`) over bags of
  optional fields; `assertNever` in the `default` branch for exhaustiveness.
- **Parse, don't validate** — outside data is `unknown`; parse once with Zod at the boundary into
  domain types. Schema is the source of truth (`type T = z.infer<typeof S>`). Never pass `unknown`
  or `any` inward.
- **No escape hatches** — no `any`, no `as`, no `!`. Narrow or parse instead. Suppress only with
  `@ts-expect-error` + a one-line reason; never `@ts-ignore`.
- **Errors as values** — return a `Result` union for expected failures; `throw` only for defects.
- **Immutable by default** — `readonly`, `as const`, return new values. No `enum` (use `as const`).
- **Functions** — one responsibility, pure where possible, single object arg past ~2 params,
  explicit return types on exports.
- **Modules** — named exports only, organize by feature, one concept per file.

## Boundaries / safety

- Do not commit secrets, save files (`saves/`), or recorded traces (`tools/.../traces/`).
- The viewer is read-only over snapshot files; it must never write to or mutate game data.
- Don't edit the Python collector (`src/civretro/`) or the Gameface mod JS (`mod/`) from here —
  they are separate concerns with their own conventions.

## Commits & PRs

- Branch from `main`; conventional-commit subjects (`feat(viewer): …`, `fix(viewer): …`).
- One logical change per PR; ensure the done criteria above pass before opening it.
