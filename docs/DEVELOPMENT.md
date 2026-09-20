# Development

## The checks

```bash
npm run typecheck     # tsc -p tsconfig.check.json --noEmit
npm test              # vitest run
npm run build         # next build
npm run typegen       # next typegen
npm run check:routes  # tsc -p tsconfig.json --noEmit
```

Run `typecheck` and `test` constantly; they take seconds. Run `build`,
`typegen` and `check:routes` before pushing anything that touches a route
handler or a page signature.

## Two tsconfigs, on purpose

This is the detail most likely to look like a mistake and get "cleaned
up". It is not a mistake.

`tsconfig.json` does **not** exclude `.next`. Next generates route
contract types under `.next/types` and adds them to `include`;
`check:routes` typechecks through that config, which is what catches a
handler whose `params` has the wrong shape.

`tsconfig.check.json` extends it and **does** exclude `.next`. The
per-commit check needs an answer that means the same thing whether or not
a build has run, so it looks at source only.

Excluding `.next` from the base config instead would make `next build` go
green while a route still violated its contract. The check would stop
measuring rather than start passing. If you change anything here, verify
it still bites: make a route's `params` synchronous on purpose and confirm
`check:routes` fails.

## Next 16 specifics

- **Turbopack is the default bundler.** A `webpack` key in
  `next.config.mjs` makes the build refuse to start.
- **Relative imports must be extensionless** — `./lib/supabase`, not
  `./lib/supabase.js`. `moduleResolution: "bundler"` expects that, and
  Turbopack will not resolve `.js` to `.ts`.
- **`next build` no longer typechecks the generated route validator.**
  That is why `typegen` and `check:routes` are separate steps. Without
  them the route contracts are generated and never checked.
- **Prefer the `@/` alias** over deep relative paths. It resolves the same
  from any directory; `../../lib/x` breaks the moment a file moves.

## npm scripts must not chain with `&&`

npm runs scripts through the platform shell. On Windows that is
PowerShell 5.1, where `&&` is a parser error. A chained script passes in
CI and fails on a developer laptop for reasons that have nothing to do
with the code. Split into separate scripts and run them as separate steps.

## After a migration

```bash
supabase db reset
supabase gen types typescript --local > src/lib/database.types.ts
```

Both, in that order, every time. `database.types.ts` is generated output —
editing it by hand is how rows start resolving to `never`, and the
compiler will point at the call sites rather than at what you changed.

## Reachability

A module that nothing imports from a real entry point is work that was
paid for and cannot run. This repo shipped that exact defect once: the
whole feed UI existed, compiled and tested, behind an app with no
`src/app/page.tsx`.

The check walks the import graph from **product** entry points only —
pages, route handlers, `src/middleware.ts`, edge functions, scripts. Tests
and barrel files are deliberately not entry points. Importing a module
from a test proves it parses; it does not mean anything runs it, and a
barrel that re-exports an orphan just moves the orphan.

So if a module is reported unreachable, wire it into the page or route
that should own it, and use it. Do not add an import that is never called,
and do not add a test that imports it to make the number go down. If there
is no entry point that should own it, the missing thing is the entry
point — or the module is dead code and should go, which is what happened
to `video-card.tsx`.

## Testing

`tests/entitlements.test.ts` covers `calculateEntitlements`, which is pure
and therefore cheap to test properly. Prefer that shape: keep decisions in
pure functions and test those, rather than mounting components to assert
they rendered.

`vitest` runs with `--passWithNoTests`, which exists so a fresh scaffold
can go green before any tests are written. It also means an empty `tests/`
directory reports success. If you delete a test, make sure you are not
leaving the suite empty — that is green for the wrong reason.
