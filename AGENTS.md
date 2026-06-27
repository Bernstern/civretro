# AGENTS.md

Guidance for coding agents and humans writing **TypeScript** in this repo. (The Python collector
in `src/civretro/` and the Gameface mod JS in `mod/` are separate concerns with their own
conventions — don't apply this to them.)

Goal: TypeScript that is **easy to read**, **leans on the type system to make illegal states
unrepresentable**, and is **reliable in the face of real, messy recorded data**. We optimize for
code that a new contributor can land safely on day one.

> **Status:** the TS viewer is **not scaffolded yet** — `viewer/` is empty. The commands and
> tooling below describe the intended setup; when you scaffold the project, make them real
> (`package.json`, `tsconfig.json`, `biome.json`) and delete this note.

---

## What the viewer is

A browser app that reads **newline-delimited JSON (NDJSON)** snapshot files written by the Python
CDP collector — one snapshot per game turn — and lets a user scrub through a recorded Civ 7
session after it ends. It is **read-only** over those files. The recorder is a *separate,
actively-changing* producer, so the viewer must treat every snapshot as untrusted, possibly-stale,
possibly-truncated input. Reliability here is mostly about handling that input gracefully.

## Where code lives

Organize **by feature**, colocating related files. Example:

```
viewer/
  src/
    timeline/         Timeline.tsx  types.ts  Timeline.test.ts
    snapshot/         schema.ts  parseSession.ts  parseSession.test.ts
    fixtures/         good.ndjson  truncated.ndjson  malformed.ndjson
  tsconfig.json       @viewer/* path alias configured here + in the bundler
  biome.json
  package.json
```

## Commands

```sh
pnpm install        # install deps  (Node = current LTS via corepack)
pnpm dev            # run the viewer; open the printed localhost URL and load a sample .ndjson
pnpm typecheck      # tsc --noEmit — the PRIMARY gate
pnpm check          # biome check  (lint + format)
pnpm fix            # biome check --write
pnpm test           # Vitest  (pnpm test <name> for one)
```

A change is **done** only when `typecheck`, `check`, and `test` pass — and these run in CI on every
PR. `typecheck` is the real gate; it enforces the type-level rules Biome can't.

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

For **internal** unions, switch over the discriminant and prove exhaustiveness with `assertNever`:

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

⚠️ **`assertNever` throws at runtime — only use it on unions you fully own.** Never reach it with a
value that came from outside the program (a new `age`, a new event `kind` the recorder started
emitting). For external discriminants, treat an unrecognized variant as *data*, not a crash — see
Reliability §A.

### 2. Parse, don't validate — type the boundary
Outside data (files, network, env, CDP messages — Chrome DevTools Protocol, the channel the
collector records over) arrives as `unknown`. Parse it **once**, at the boundary, into a trusted
domain type with **Zod**. The schema is the single source of truth — derive the type from it. Only
the boundary layer touches `unknown`/raw shapes; everything inward receives parsed types.

Use **`safeParse`** at boundaries and lift the result into the `Result` type (§6) — don't let
parsing `throw` into your control flow. Make parsed data immutable (`.readonly()`) and reject
non-finite numbers (`.finite()`).

```ts
const TurnSnapshot = z.object({
  schemaVersion: z.number().int(),        // recorder evolves — see Reliability §B
  globalTurn:    z.number().int().nonnegative(),
  age:           z.string(),              // NOT z.enum — unknown ages must parse, not fail (§A)
  players:       z.array(PlayerSchema).readonly(),
});
type TurnSnapshot = z.infer<typeof TurnSnapshot>; // type derived from schema, not vice versa
```

### 3. Lean on inference; annotate intent
Let the compiler infer locals and obvious literals; annotate where it communicates intent or where
inference is too wide/narrow.
- **Always annotate return types on exported functions** (documentation + stops silent contract drift).
- **Never `any`** — use `unknown` and narrow.
- **No type-assertion `as` (`x as Foo`) and no `!`** — they're unchecked claims; narrow with a
  guard or parse instead. (`as const` is fine — it's a *const assertion*, not a cast, and makes no
  unchecked claim.) Rare justified suppression: `@ts-expect-error` **with a one-line reason**,
  never `@ts-ignore`.

### 4. Immutability by default
Mark data `readonly` / `readonly T[]`; return new values rather than mutating; use `as const` for
literal constants. **No `enum`** — use a `const` object + `as const` union:

```ts
const Phase = { Idle: 'idle', Playing: 'playing', Done: 'done' } as const;
type Phase = (typeof Phase)[keyof typeof Phase]; // 'idle' | 'playing' | 'done'
```

Immutability is about *not mutating shared state*, not about deep-copying large arrays per frame —
see Reliability §E for the perf caveat.

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
```

Discipline: never read `.value` before narrowing on `r.ok`. **Propagate** Results upward; **unwrap**
only at the UI / I-O edge. (Define `Result` locally for now; promote to a shared util only once
two features actually need it — see §7.)

### 7. Composition over inheritance; avoid over-abstraction
Combine small functions and plain data over deep class hierarchies. Don't abstract until there's
real, concrete duplication — a little copying beats the wrong interface. Keep the codebase shallow.

### 8. Modules
**Named exports only.** Relative imports within a feature, path-aliased (`@viewer/…`) across
features. One concept per file, named for what it exports.

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

## Reliability (this domain)

The viewer's reliability lives or dies on how it treats recorded NDJSON. These rules are not
optional polish — they are the point.

**A. Unknown variants are data, not crashes.** The recorder is a moving target; it will add ages,
event kinds, and fields the viewer has never seen. Parse permissive discriminants as strings and
handle the unrecognized case explicitly (render "unknown", count it) — never `assertNever` or
`throw` on external values.

**B. Schema versioning.** Every snapshot carries a `schemaVersion`. Decide and document a compat
window; on an out-of-range version, surface a clear message rather than mis-parsing. Zod's
`z.object` **strips unknown keys silently** — that's the safe default for forward-compat, but it
means new recorder fields vanish without warning, so add them to the schema deliberately.

**C. Per-frame failure policy — the central decision.** Parse **per line**, not the whole file as
one blob:
- A single malformed or unparseable line is **skipped, counted, and surfaced** (line number +
  reason) — it must **never** abort the session.
- The **last line may be truncated** (collector mid-flush / crash). A non-newline-terminated tail
  is *held/ignored*, not reported as corruption.
- Only a structurally unreadable file (can't open / zero valid frames) aborts with an error.

**D. Ordering & time.** Don't assume `globalTurn` is contiguous or in order — a crash-resumed
collector can produce gaps, duplicates, or out-of-order frames. Index by turn, define an explicit
policy (e.g. last-write-wins), and surface gaps. Treat recorder timestamps as **display-only**;
order by turn/sequence, never by wall-clock time.

**E. Large sessions.** A long game is hundreds of turns × many players. Parse **incrementally** and
index; don't materialize the entire file or re-run Zod on every scrub — cache parsed frames.
Virtualize the timeline. Release blob/object URLs and stream readers when done.

**F. Async correctness.** Scrubbing fires overlapping loads. Tie each load to an `AbortSignal`,
cancel superseded loads, and **drop late results** (scrub to 50 then 10 — the turn-50 load must not
clobber the turn-10 view). No floating promises (Biome's `noFloatingPromises` catches most; be
deliberate about the rest).

---

## Testing & observability

- **Tests gate "done."** At minimum: parser/schema tests over the `fixtures/` corpus
  (`good`, `truncated`, `malformed`, and an unknown-variant case); at least one **golden test**
  that replays a real recorded session end-to-end; **property tests** on pure transforms
  (round-trip, ordering). A feature touching parsing without a malformed-input test is not done.
- **Observability.** A session parse must produce a **report** — counts of ok / skipped /
  unknown-variant frames with line numbers — that is both logged and **visible in the UI**. A
  read-only viewer that silently drops frames produces silently-wrong replays; make the drops loud.

---

## Tooling

Push every mechanical rule into config so the prose above stays about judgment.

- **`tsconfig.json`** — `strict: true` **plus** `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`,
  `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `isolatedModules`. The **primary
  enforcement gate**. (Note: `exactOptionalPropertyTypes` distinguishes "missing" from
  "present-but-`undefined`" — mind it when a Zod `.optional()` field round-trips through code that
  sets `undefined` explicitly.)
- **Biome** (v2.x) for lint + format: `noExplicitAny`, `noNonNullAssertion`, `noDefaultExport`,
  `noParameterAssign`, `useConst`, `useNamingConvention`, **`noEnum`**, and the type-aware
  **`noFloatingPromises`**; single quotes, semicolons, 100 cols.
- **Honest caveat:** Biome's `noFloatingPromises` catches ~75% of what typescript-eslint would; the
  one real remaining gap is banning type-assertion `as` (no Biome equivalent). Strict
  `tsc --noEmit` carries the type-level rules; the rest lives in review. When in doubt, prefer the
  stricter reading.

## Comments
Comment the **why**, not the what (the types say the what). JSDoc an exported function when its
intent isn't obvious from its signature, especially boundary parsers and anything with a subtle
failure mode.

## Boundaries / safety
- Don't commit secrets, save files (`saves/`), or recorded traces.
- The viewer is read-only over snapshot files — never write to or mutate game data.

## Commits, PRs & gray areas
Branch from `main`; conventional-commit subjects (`feat(viewer): …`). One logical change per PR;
all done-criteria commands pass before opening it. **If a rule here fights the task, raise it in the
PR** — propose the carve-out, don't silently bend the rule and don't let "prefer stricter" become a
cudgel in review. The guide is meant to serve reliable, contributable code, not the reverse.

---

## References
[agents.md](https://agents.md/) ·
[Google TS Style Guide](https://google.github.io/styleguide/tsguide.html) ·
[mkosir/typescript-style-guide](https://mkosir.github.io/typescript-style-guide/) ·
[Effective TypeScript 2025 (O'Keeffe)](https://www.dennisokeeffe.com/blog/2025-03-16-effective-typescript-principles-in-2025) ·
[Parse, Don't Validate (King)](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) ·
[Biome v2 type-aware linting](https://biomejs.dev/blog/biome-v2/)
