# AGENTS.md

How we write **TypeScript** in this repo. Goal: code that is easy to read, leans on the type
system to make illegal states unrepresentable, and stays reliable against the messy recorded data
it consumes. Mechanical rules live in tooling (see [Tooling](#tooling)); this file is the judgment
a linter can't make.

## Commands

```sh
pnpm install
pnpm dev            # run the viewer
pnpm typecheck      # tsc --noEmit — the primary gate
pnpm check          # biome check (lint + format)
pnpm fix            # biome check --write
pnpm test           # vitest  (pnpm test <name> for one)
```

A change is done only when `typecheck`, `check`, and `test` pass — all run in CI on every PR.
`typecheck` is the real gate; it enforces the type-level rules Biome can't.

---

## Principles

### 1. Make illegal states unrepresentable
Prefer discriminated unions over objects of optional fields. Use a consistent discriminant —
`status` for state machines, `kind` for structural variants — and never mix them in one union.

```ts
type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: readonly User[] }
  | { status: 'error'; error: Error };
```

For unions you fully own, switch over the discriminant and prove exhaustiveness with `assertNever`:

```ts
function assertNever(x: never): never { throw new Error(`Unhandled: ${JSON.stringify(x)}`); }

switch (state.status) {
  case 'idle':    return '';
  case 'loading': return 'Loading…';
  case 'success': return `${state.data.length} users`;
  case 'error':   return state.error.message;
  default:        return assertNever(state);
}
```

`assertNever` throws at runtime, so only reach it with a value you fully own. A value from outside
the program — a new variant the recorder started emitting — must be treated as data, not a crash
(see [Reliability](#reliability)).

### 2. Parse, don't validate
Outside data (files, network, env, recorded messages) arrives as `unknown`. Parse it once, at the
boundary, into a trusted domain type with Zod; the schema is the single source of truth and the
type is derived from it. Only the boundary layer touches `unknown` — everything inward receives
parsed types.

Use `safeParse` at boundaries and lift the result into the `Result` type (Principle 6) rather than
letting parsing throw. Make parsed data immutable with `.readonly()` and reject non-finite numbers
with `.finite()`. Parse permissive discriminants as strings, not `z.enum`, so unknown variants
parse instead of failing.

```ts
const TurnSnapshot = z.object({
  schemaVersion: z.number().int(),
  globalTurn:    z.number().int().nonnegative(),
  age:           z.string(),
  players:       z.array(PlayerSchema).readonly(),
});
type TurnSnapshot = z.infer<typeof TurnSnapshot>;
```

### 3. Lean on inference; annotate intent
Let the compiler infer locals and obvious literals; annotate where it communicates intent or where
inference is too wide or narrow.
- Always annotate return types on exported functions.
- Never `any` — use `unknown` and narrow.
- No type-assertion `as` (`x as Foo`) and no `!`; narrow with a guard or parse instead. (`as const`
  is fine — it is a const assertion, not a cast, and makes no unchecked claim.) Suppress only with
  `@ts-expect-error` plus a one-line reason, never `@ts-ignore`.

### 4. Immutability by default
Mark data `readonly` / `readonly T[]`; return new values rather than mutating; use `as const` for
literal constants. No `enum` — use a `const` object plus an `as const` union:

```ts
const Phase = { Idle: 'idle', Playing: 'playing', Done: 'done' } as const;
type Phase = (typeof Phase)[keyof typeof Phase];
```

This means not mutating shared state — not deep-copying large arrays per frame (see
[Reliability](#reliability)).

### 5. Functions
One responsibility; pure where possible, pushing I/O, logging, and mutation to the edges. Take a
single object argument past ~2 params or any boolean, so call sites read clearly — prefer
`scrub({ snapshot, turn, smooth })` over `scrub(snap, 12, true, false)`.

### 6. Errors: return them, don't throw them
Model expected, recoverable failures in the return type so callers must handle them; throw only for
defects or invariant violations.

```ts
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
```

Never read `.value` before narrowing on `r.ok`. Propagate Results upward; unwrap only at the UI or
I/O edge. Define `Result` locally until two features actually need it.

### 7. Composition over inheritance; avoid over-abstraction
Combine small functions and plain data over deep class hierarchies. Don't abstract until there is
real, concrete duplication — a little copying beats the wrong interface. Keep the codebase shallow.

### 8. Modules
Named exports only. Relative imports within a feature, path-aliased (`@viewer/…`) across features.
One concept per file, named for what it exports.

### 9. Naming
| Kind | Convention | Example |
| --- | --- | --- |
| Variables, functions | `camelCase` | `globalTurn`, `parseSession` |
| Booleans | `is`/`has`/`should`… | `isLoading`, `hasNextTurn` |
| Types & components | `PascalCase` | `TurnSnapshot`, `Timeline` |
| Constants | `SCREAMING_SNAKE_CASE` | `CDP_PORT` |
| Generics | descriptive when >1 | `TRequest`, `TResponse` (a lone trivial generic may stay `T`) |
| Component props | `…Props` | `TimelineProps` |

Don't encode the type in the name (`userArray`, `nameString`) — the type already says it.

---

## Reliability

Handling recorded input gracefully is the point, not optional polish.

- **Unknown variants are data, not crashes.** The producer is a moving target; parse permissive
  discriminants as strings and handle the unrecognized case explicitly (render "unknown", count
  it). Never `assertNever` or throw on an external value.
- **Schema versioning.** Every snapshot carries a `schemaVersion`; document a compat window and
  surface a clear message on an out-of-range version. `z.object` strips unknown keys silently —
  safe for forward-compat, but new producer fields vanish until added to the schema deliberately.
- **Per-frame failure policy.** Parse per line, not the whole file as one blob. A malformed line is
  skipped, counted, and surfaced (line number plus reason) and never aborts the session. A
  non-newline-terminated trailing line may be a mid-flush truncation — hold or ignore it, don't
  report corruption. Only an unreadable file (can't open, zero valid frames) aborts.
- **Ordering and time.** Don't assume the turn counter is contiguous or ordered — a crash-resumed
  producer yields gaps, duplicates, and out-of-order frames. Index by turn, define an explicit
  policy (e.g. last-write-wins), and surface gaps. Treat recorded timestamps as display-only; order
  by turn or sequence.
- **Large sessions.** Parse incrementally and index; don't materialize the whole file or re-run Zod
  on every scrub — cache parsed frames and virtualize the timeline. Release blob URLs and stream
  readers when done.
- **Async correctness.** Scrubbing fires overlapping loads. Tie each to an `AbortSignal`, cancel
  superseded loads, and drop late results so an earlier turn's slow load can't clobber a later
  view. No floating promises.

## Testing & observability
- Tests gate "done." At minimum: parser/schema tests over a fixture corpus (good, truncated,
  malformed, unknown-variant), at least one golden test replaying a real recorded session
  end-to-end, and property tests on pure transforms. A change touching parsing without a
  malformed-input test is not done.
- A session parse produces a report — counts of ok, skipped, and unknown-variant frames with line
  numbers — that is both logged and visible in the UI. Silent drops produce silently-wrong
  replays; make them loud.

---

## Tooling

Push every mechanical rule into config so the prose stays about judgment.

- **`tsconfig.json`** — `strict: true` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `noUnusedLocals`,
  `noUnusedParameters`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`,
  `isolatedModules`. The primary enforcement gate. (`exactOptionalPropertyTypes` distinguishes
  "missing" from "present-but-`undefined`" — mind it with Zod `.optional()` fields.)
- **Biome** (v2.x) for lint and format: `noExplicitAny`, `noNonNullAssertion`, `noDefaultExport`,
  `noParameterAssign`, `useConst`, `useNamingConvention`, `noEnum`, and the type-aware
  `noFloatingPromises`; single quotes, semicolons, 100 columns.
- Caveat: `noFloatingPromises` catches roughly 75% of what typescript-eslint would, and the one real
  remaining gap is banning type-assertion `as`. Strict `tsc --noEmit` carries the type-level rules;
  the rest lives in review. When in doubt, prefer the stricter reading.

## Comments
Comment the why, not the what — the types say the what. JSDoc an exported function when its intent
isn't obvious from its signature, especially boundary parsers and anything with a subtle failure
mode.

## Boundaries
Don't commit secrets, save files, or recorded traces. Be read-only over recorded data — never write
to or mutate it.

## Commits, PRs & gray areas
Branch from `main`; conventional-commit subjects (`feat(viewer): …`). One logical change per PR; all
done-criteria commands pass before opening it. If a rule here fights the task, raise it in the PR
and propose the carve-out — don't silently bend it, and don't let "prefer stricter" become a cudgel
in review.

---

## References
[agents.md](https://agents.md/) ·
[Google TS Style Guide](https://google.github.io/styleguide/tsguide.html) ·
[mkosir/typescript-style-guide](https://mkosir.github.io/typescript-style-guide/) ·
[Effective TypeScript 2025 (O'Keeffe)](https://www.dennisokeeffe.com/blog/2025-03-16-effective-typescript-principles-in-2025) ·
[Parse, Don't Validate (King)](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) ·
[Biome v2 type-aware linting](https://biomejs.dev/blog/biome-v2/)
