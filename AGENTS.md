# AGENTS.md

Guidance for coding agents and humans writing **TypeScript** in this repo. (Python collector in
`src/civretro/` and the Gameface mod JS in `mod/` are separate concerns with their own
conventions — don't apply this to them.)

Goal: TypeScript that is **easy to read**, **leans on the type system to make illegal states
unrepresentable**, and keeps **components and concerns cleanly separated**.

Mechanical rules (formatting, casing, no-`any`, no default exports) are enforced by tooling — see
[Tooling](#tooling). This file is about the *judgment* a linter can't make. If a rule can be
expressed in config, it lives there, not here.

---

## Commands

```sh
pnpm install        # install deps
pnpm typecheck      # tsc --noEmit — the PRIMARY gate
pnpm check          # biome check  (lint + format check)
pnpm fix            # biome check --write  (auto-fix)
pnpm test           # run tests   (pnpm test <name> for one)
```

A change is **done** only when `typecheck`, `check`, and `test` all pass. `typecheck` is the real
gate — it enforces the type-level rules Biome can't.

---

## Principles

### 1. Make illegal states unrepresentable
If a combination should never occur, the types should make it impossible to write. Prefer
**discriminated unions** over objects of optional fields. Use a consistent discriminant — `status`
for state machines, `kind` for structural variants — and never mix them in one union.

```ts
// ✗ many impossible combinations representable
interface State { loading?: boolean; data?: User[]; error?: Error }

// ✓ closed set of honest states, each carrying exactly its data
type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: readonly User[] }
  | { status: 'error'; error: Error };
```

Switch over the discriminant and prove exhaustiveness:

```ts
function assertNever(x: never): never { throw new Error(`Unhandled: ${JSON.stringify(x)}`); }

switch (state.status) {
  case 'idle':    return '';
  case 'loading': return 'Loading…';
  case 'success': return `${state.data.length} users`;
  case 'error':   return state.error.message;
  default:        return assertNever(state); // compile error if a case is added later
}
```

### 2. Parse, don't validate — type the boundary
Outside data (network, fs, env, JSON snapshots, CDP messages) arrives as `unknown`. Parse it
**once**, at the boundary, into a trusted domain type with **Zod**. The schema is the single
source of truth — derive the type from it. Only the boundary layer touches `unknown`/raw shapes;
domain and app logic receive parsed types and never re-check.

```ts
const TurnSnapshot = z.object({
  globalTurn: z.number().int().nonnegative(),
  age:        z.enum(['antiquity', 'exploration', 'modern']),
  players:    z.array(PlayerSchema),
});
type TurnSnapshot = z.infer<typeof TurnSnapshot>; // type derived from schema, not vice versa
```

### 3. Lean on inference; annotate intent
Let the compiler infer locals and obvious literals; annotate where it communicates intent or
where inference is too wide/narrow.
- **Always annotate return types on exported functions** (documentation + stops silent contract drift).
- **Never `any`** — use `unknown` and narrow.
- **No `as` and no `!`** — they're unchecked claims; narrow with a guard or parse instead.
  Rare justified suppression: `@ts-expect-error` **with a one-line reason**, never `@ts-ignore`.

### 4. Immutability by default
Mark data `readonly` / `readonly T[]`; return new values rather than mutating; use `as const` for
literal constants. **No `enum`** — use a `const` object + `as const` union (erasable,
tree-shakeable, composes with discriminated unions):

```ts
const Age = { Antiquity: 'antiquity', Exploration: 'exploration', Modern: 'modern' } as const;
type Age = (typeof Age)[keyof typeof Age]; // 'antiquity' | 'exploration' | 'modern'
```

### 5. Functions
One responsibility; pure where possible (push I/O, logging, mutation to the edges); a **single
object argument** past ~2 params or any boolean (call sites stay readable, args order-free).

```ts
// ✗ scrub(snap, 12, true, false)
// ✓ scrub({ snapshot, turn, smooth })
```

### 6. Errors: return them, don't throw them
Model expected, recoverable failures in the return type so callers must handle them. `throw` only
for defects / invariant violations.

```ts
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

const r = parseTurn(line);
if (!r.ok) return logSkippedFrame(r.error); // compiler forces handling
useSnapshot(r.value);
```

### 7. Composition over inheritance; avoid over-abstraction
Combine small functions and plain data over deep class hierarchies. Don't abstract until there's
real, concrete duplication — a little copying beats the wrong interface. Keep the codebase shallow.

### 8. Modules
Organize **by feature** (colocate component + types + tests + styles), not by technical layer.
**Named exports only.** Relative imports within a feature, path-aliased (`@viewer/…`) across
features. One concept per file, named for what it exports.

### 9. Naming
| Kind | Convention | Example |
| --- | --- | --- |
| Variables, functions | `camelCase` | `globalTurn`, `parseSnapshot` |
| Booleans | `is`/`has`/`should`… | `isLoading`, `hasNextTurn` |
| Types & components | `PascalCase` | `TurnSnapshot`, `Timeline` |
| Constants | `SCREAMING_SNAKE_CASE` | `CDP_PORT` |
| Generics | `T`-prefixed & named | `TRequest` (not bare `T`) |
| Component props | `…Props` | `TimelineProps` |

Don't encode the type in the name (`userArray`, `nameString`) — the type already says it.

---

## Tooling

Push every mechanical rule into config so the prose above stays about judgment.

- **`tsconfig.json`** — `strict: true` **plus** `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`,
  `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `isolatedModules`. This is the
  **primary enforcement gate**.
- **Biome** for lint + format: `noExplicitAny`, `noNonNullAssertion`, `noDefaultExport`,
  `noParameterAssign`, `useConst`, `useNamingConvention`; single quotes, semicolons, 100 cols.
- **Honest caveat:** Biome can't enforce *every* rule above (no-floating-promises, banning `as`
  and `enum` are weak/absent vs. typescript-eslint). Strict `tsc --noEmit` carries the type-level
  rules; the rest lives in review. When in doubt, prefer the stricter reading.

---

## Boundaries / safety
- Don't commit secrets, save files (`saves/`), or recorded traces.
- The viewer is read-only over snapshot files — never write to or mutate game data.

## Commits & PRs
Branch from `main`; conventional-commit subjects (`feat(viewer): …`). One logical change per PR;
all three done-criteria commands pass before opening it.

---

## References
[agents.md](https://agents.md/) ·
[Google TS Style Guide](https://google.github.io/styleguide/tsguide.html) ·
[mkosir/typescript-style-guide](https://mkosir.github.io/typescript-style-guide/) ·
[Effective TypeScript 2025 (O'Keeffe)](https://www.dennisokeeffe.com/blog/2025-03-16-effective-typescript-principles-in-2025) ·
[Parse, Don't Validate (King)](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/)
