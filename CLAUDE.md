# CLAUDE.md

Warehouse bin label conversion. Next.js 16 + Neon Postgres on Vercel.

**Read `HANDOFF.md` first** — it has the project history, the numbering rule,
the design decisions and, most importantly, what is not yet done.

## Commands

```bash
npm run dev        # local
npm test           # 79 logic tests, no DB needed
npm run build      # must stay clean
npm run migrate    # schema, safe to re-run
npm run user -- <name> <password> [scanner|admin]
```

## Non-negotiables

- **One-for-one is enforced by Postgres**, not application code. `pairs` has
  `UNIQUE (site_id, old_bin)` and `UNIQUE (site_id, new_bin)`. Never replace
  that with a read-then-write check — it races when two people scan at once.
- **Never derive the new bin letter from old data.** That is what produced 364
  bad codes at the previous site. Generate a superset, scan reality, delete the
  leftovers.
- `src/lib/db.ts` stays a lazy plain function. No `Proxy` wrapper, or DB
  introspection breaks. No top-level `neon()` call, or `next build` fails
  before the integration provisions the database.
- The connection string is resolved by `src/lib/dburl.mjs`, never read straight
  out of `process.env.DATABASE_URL`. The Neon integration prefixes what it
  injects with the storage name. Keep that file `.mjs` — `scripts/*.mjs` run
  under bare node and cannot import TypeScript, and two copies would drift.
- **Validation mode records reality, it never refuses.** `/api/checks` writes
  whatever was scanned with a verdict of `match`, `mismatch` or `unmapped`. A
  wrong label has to be recorded before anyone can go and fix it. Do not add
  refusals there — that is what `pairs` is for.
- Scanner input must never be cached. Routes are `force-dynamic`.
- Refusals happen client-side for speed **and** server-side for truth. Keep
  both in step; `validatePair` in `src/lib/bins.ts` is shared by each.

## Conventions

- Bin codes are uppercased at every boundary.
- Old bins come in two formats (`A-1-1-1` and `A010101`) plus padding variants.
  Use `parseOld`; do not write another regex.
- An uploaded bin map is reference data, never truth. It lives in `bin_map`,
  separate from `pairs`, because a scanned pair is something two people watched
  happen and an uploaded row is a vendor's claim. Site 18's claim was wrong 364
  times.
- Spreadsheets are read in the browser (`src/lib/sheet.ts`, native
  `DecompressionStream`), then posted as rows. Do not add a server-side unzip.
- Add a test in `scripts/test.ts` for anything touching parsing, generation or
  validation.
