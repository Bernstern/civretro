# TypeScript Style Guide

How we write TypeScript in this repo. The goal is code that is **easy to read**, **leans on
the type system to make illegal states unrepresentable**, and keeps **components and concerns
cleanly separated**.

This document covers *judgment* — the patterns and trade-offs a linter can't decide for you.
Mechanical rules (formatting, naming casing, no-`any`, no default exports) are enforced by
`tsconfig.json` (strict) and `biome.json`; you should rarely have to think about them.

> **Enforcement note.** `tsc --noEmit` (strict) is the primary gate — it catches the
> type-level rules below. Biome handles formatting and the lint rules it supports well. A few
> rules here (no `as`, no `enum`, errors-as-values) are **not fully machine-enforceable** with
> Biome today; they live in code review and in your discipline. When in doubt, prefer the
> stricter reading.

---

## 1. Make illegal states unrepresentable

The single most important principle. If a combination of values should never occur, the types
should make it impossible to write — not merely discouraged.

Prefer **discriminated unions** over objects full of optional fields.

```ts
// ✗ Avoid: every field optional; many impossible combinations are representable.
interface RequestState {
  loading?: boolean;
  data?: User[];
  error?: Error;
}

// ✓ Prefer: a closed set of honest states, each carrying exactly its data.
type RequestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: readonly User[] }
  | { status: 'error'; error: Error };
```

Use a consistent discriminant name across the codebase — we use **`status`** for state machines
and **`kind`** for structural variants. Pick one per union and never mix.

### Exhaustiveness

Switch over the discriminant and let the compiler prove you handled every case:

```ts
function render(state: RequestState): string {
  switch (state.status) {
    case 'idle':    return '';
    case 'loading': return 'Loading…';
    case 'success': return `${state.data.length} users`;
    case 'error':   return state.error.message;
    default:        return assertNever(state); // compile error if a case is added later
  }
}

/** Proves a branch is unreachable. Compiles only if `x` is `never`. */
function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}
```

---

## 2. Parse, don't validate — type the boundary

Everything from outside the program (network, filesystem, env, JSON snapshots, CDP messages)
arrives as **`unknown`**. Parse it **once**, at the boundary, into a trusted domain type. After
that point, the rest of the code works only with validated types and never re-checks.

We use [Zod](https://zod.dev) as the boundary parser. The schema is the **single source of
truth**; derive the TypeScript type from it, not the other way around.

```ts
import { z } from 'zod';

// Schema is the source of truth…
const TurnSnapshot = z.object({
  globalTurn: z.number().int().nonnegative(),
  age:        z.enum(['antiquity', 'exploration', 'modern']),
  players:    z.array(PlayerSchema),
});

// …and the type is derived from it.
type TurnSnapshot = z.infer<typeof TurnSnapshot>;

/** The ONLY place raw CDP data crosses into the domain. Returns a trusted type or throws. */
function parseSnapshot(raw: unknown): TurnSnapshot {
  return TurnSnapshot.parse(raw);
}
```

**Layering rule:** only the infrastructure/boundary layer touches `unknown` and raw shapes.
Domain and application logic receive already-parsed types. Do not pass `unknown`, `any`, or
loosely-typed blobs inward.

---

## 3. Lean on inference; annotate intent

Let the compiler infer locals and obvious literals. Be explicit where the annotation communicates
intent or where inference would be too wide/narrow.

```ts
const count = 0;                            // ✓ inferred number — no annotation needed
const roles = ['admin', 'guest'] as const;  // ✓ `as const` narrows to a literal tuple
const cache = new Map<string, User>();      // ✓ annotate: inference can't know the value type

export function loadUser(id: UserId): Promise<User> { // ✓ explicit return type on exported fns
  // …
}
```

Rules:
- **Always annotate return types on exported functions.** It's documentation and it stops an
  internal change from silently widening a public contract.
- **Never `any`.** Use `unknown` and narrow. `any` disables the type system locally and leaks.
- **No type assertions (`as`) or non-null assertions (`!`).** They are unchecked claims. If you
  truly know more than the compiler, narrow with a type guard or parse the value instead. The
  rare justified suppression uses `@ts-expect-error` **with a one-line reason** — never
  `@ts-ignore`.

---

## 4. Immutability by default

```ts
function withPlayer(s: GameState, p: Player): GameState {
  return { ...s, players: [...s.players, p] }; // ✓ new value, no mutation
}
```

- Mark data `readonly` / `ReadonlyArray<T>` (or `readonly T[]`) wherever it isn't meant to change.
- Return new arrays/objects rather than mutating arguments or shared state.
- Use `as const` for literal constants to get the narrowest type and deep readonly-ness.
- Avoid `enum`; use a `const` object or `as const` union instead — they're erasable, tree-shakeable,
  and play nicely with discriminated unions:

```ts
const Age = { Antiquity: 'antiquity', Exploration: 'exploration', Modern: 'modern' } as const;
type Age = (typeof Age)[keyof typeof Age]; // 'antiquity' | 'exploration' | 'modern'
```

---

## 5. Functions

- **One responsibility.** A function does one thing; its name says what.
- **Pure where possible.** Same input → same output, no hidden side effects. Push effects
  (I/O, logging, mutation) to the edges.
- **Single object argument** when a function takes more than ~2 related params, or any boolean —
  call sites stay readable and arguments become order-independent and self-documenting.

```ts
// ✗ what do these args mean at the call site?  scrub(snap, 12, true, false)
// ✓ self-documenting, order-free, easy to extend
function scrub({ snapshot, turn, smooth }: ScrubOptions): Frame { /* … */ }
```

- **Errors as values for expected failures** (see §6). Throw only for programmer mistakes /
  truly exceptional defects.

---

## 6. Errors: return them, don't throw them

Expected, recoverable failures are part of a function's contract — model them in the return
type so callers must handle them. Reserve `throw` for *exceptional* circumstances (bugs,
invariant violations).

```ts
type Result<T, E = Error> =
  | { ok: true;  value: T }
  | { ok: false; error: E };

function parseTurn(raw: unknown): Result<TurnSnapshot, z.ZodError> {
  const r = TurnSnapshot.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error };
}

const r = parseTurn(line);
if (!r.ok) return logSkippedFrame(r.error); // compiler forces you to handle the failure
useSnapshot(r.value);
```

This keeps the happy path and the failure path both visible and type-checked, instead of relying
on out-of-band `try/catch` that the types don't mention.

---

## 7. Composition over inheritance; avoid over-abstraction

- Build behavior by **combining small functions and plain data**, not deep class hierarchies.
- Don't introduce an abstraction until there are real, concrete duplications to unify. A little
  copying is cheaper than the wrong interface.
- Keep the codebase **shallow**: prefer flat modules of focused functions over layered indirection.

---

## 8. Module & project organization

- **Organize by feature**, colocating related code (component + its types + its tests + its
  styles in one folder), rather than by technical layer (`/components`, `/types`, `/utils`).
- **Named exports only** — no default exports. They make renames, grep, and auto-import reliable.
- **Imports:** relative (`./frame`) within a feature; path-aliased (`@viewer/…`) across features.
- **One concept per file**, named for what it exports.

---

## 9. Naming

Casing is enforced by tooling; these are the conventions it enforces:

| Kind                 | Convention             | Example                       |
| -------------------- | ---------------------- | ----------------------------- |
| Variables, functions | `camelCase`            | `globalTurn`, `parseSnapshot` |
| Booleans             | `is`/`has`/`should` …  | `isLoading`, `hasNextTurn`    |
| Types & components   | `PascalCase`           | `TurnSnapshot`, `Timeline`    |
| Constants            | `SCREAMING_SNAKE_CASE` | `CDP_PORT`                    |
| Generics             | `T`-prefixed & named   | `TRequest` (not bare `T`)     |
| Component props      | `…Props`               | `TimelineProps`               |

Don't encode the type in the name (`userArray`, `nameString`) — the type already says it.

---

## References

The conventions above are distilled from these sources — read them when you want the full rationale:

- [AGENTS.md open format](https://agents.md/) — the agent-instructions file spec.
- [mkosir/typescript-style-guide](https://mkosir.github.io/typescript-style-guide/) — the closest modern opinionated guide to this one.
- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) — authoritative baseline for naming/structure.
- [Effective TypeScript Principles in 2025 (Dennis O'Keeffe)](https://www.dennisokeeffe.com/blog/2025-03-16-effective-typescript-principles-in-2025) — composition, never-throw, parse-don't-validate.
- [Parse, Don't Validate in TypeScript (cekrem)](https://cekrem.github.io/posts/parse-dont-validate-typescript/) and [Elias Nygren / ITNEXT](https://itnext.io/parse-dont-validate-incoming-data-in-typescript-d6d5bfb092c8) — typing the boundary.
- Alexis King, ["Parse, Don't Validate"](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) — the original essay.
