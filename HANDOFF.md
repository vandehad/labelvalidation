# Handoff

Where this came from, what is done, what is not, and the decisions worth
knowing before changing anything. Written so a fresh session in this repo can
pick up without the original conversation.

---

## Background

This grew out of converting site **18 (NPW Hillsboro)** from old
`Zone-Aisle-Column-Shelf` bins to the new `{Zone}{aisle}{column}{letter}01`
format. That conversion was done with spreadsheets and Python, and it went
wrong in ways worth not repeating:

- The vendor-supplied new-bin column had **364 wrong codes** out of 32,575.
- Labels for zones A–E were hung **before** the errors were found, so those
  had to be frozen as-is and worked around.
- One column had two shelves sharing a single label.
- Six bins in zone E were hung with **zone K** codes, which then collided with
  zone K's own bins.
- A replacement extract for zones R/S silently dropped 17 bins that still held
  1,145 units of stock.

Every one of those is a failure to guarantee one-for-one. This app exists so
the next site cannot repeat them: labels are generated up front as a superset,
each pairing is captured by scanning both labels, and the leftovers are
identified explicitly rather than assumed.

The prior site's analysis lives in `f:\Random Projects\Bin Crossref\` — that is
reference material, not an input to this app.

---

## Two modes

The app does two different jobs and they must not be confused:

| | **Scan & Pair** | **Validate** |
| --- | --- | --- |
| Question | what should this bin become? | is what is already hung correct? |
| Truth | the two labels in front of you | nothing — everything is suspect |
| Writes to | `pairs` | `checks` |
| On a clash | **refuses**, 409 | **records it**, verdict `mismatch` |

Pairing builds a cross-reference and guarantees it is one-for-one. Validation
audits a cross-reference that already exists — a vendor's file, or the app's
own earlier work — and its entire value is that it will happily record a wrong
answer. A label that is wrong has to be written down before anyone can go and
fix it.

---

## The numbering rule

Derived and validated against 32,575 real bins from site 18.

```
NEW = {Zone}{aisle:02}{column:02}{letter}{01}
```

The letter is assigned per zone/aisle/column over the **distinct** shelf
numbers:

- **Most zones** — shelves run 1 = top to N = bottom, and the order is
  flipped: the **highest** shelf number becomes `A`, each next-lower shelf
  steps one letter. Rank-based, so gaps do not skip letters.
- **Zones R and S** — already numbered bottom-up, so the **lowest** becomes
  `A`, stepping up.
- **Shelf 0** — floor level, always `Z`.
- Trailing `01` is the position within the shelf. Only one exists today.

Rank-based beat value-based decisively on the real data: **30,835 correct vs
325** for the descending zones. For R/S, where the two disagree, rank matched
180 rows and value only 10.

**This rule is not implemented in this app.** The app generates a *superset* of
labels (`A` through however many shelves) and lets scanning establish the
actual mapping. That is deliberate — deriving the letter from old data is
exactly what produced the 364 errors. Scanning what is physically there cannot
be wrong in the same way.

---

## Old bin formats

Two shapes, both handled by `parseOld` in `src/lib/bins.ts`:

```
A-1-1-1        dashed, any digit widths
A010101        no dashes, fixed 2-digit aisle/column/shelf
```

Plus real-world variants seen at site 18 and covered by tests:

- `P3-3-0` — missing dash after the zone
- `U-01-11-05` — zero-padded, wide fields
- `C-0-1-1` vs `C-00-1-1` vs `C-000-1-1` — leading-zero variants that are
  **different physical shelves**, not duplicates. Sorting the raw strings puts
  them in the right order (`-` sorts before digits), which reproduced the hung
  labels exactly. If a site does this, treat them as distinct.

---

## Decisions and why

**Postgres unique constraints, not application checks.** `pairs` has
`UNIQUE (site_id, old_bin)` and `UNIQUE (site_id, new_bin)`. With several
people scanning at once, a check-then-insert races; a constraint cannot. The
route catches `23505`, works out which constraint fired, looks up the row that
already owns it, and returns `409` naming the bin and the person. This is the
whole reason the app moved off browser-local storage.

**The new-label format is a hard gate on pairing.** `/api/pairs` always calls
`validatePair` with `enforceFormat: true` — the client cannot opt out, and
there is no longer a toggle for it. A code that is not shaped like `A0101F01`
in the cross-reference is a mis-scan that somebody has to find by hand later.
The location check *is* still optional, because a scanner legitimately moves
between aisles faster than they re-set the location.

**Validation refuses nothing.** `/api/checks` writes whatever was scanned with
a verdict of `match`, `mismatch` or `unmapped`. Adding a refusal there would
defeat the point of the mode. `unmapped` is deliberately not a pass: an old bin
that is in nobody's reference is how site 18 lost 17 bins holding 1,145 units.

**The bin map is reference data, not truth.** Uploaded rows live in `bin_map`,
kept away from `pairs`, because a scanned pair is something two people watched
happen and an uploaded row is a vendor's claim. There is deliberately **no**
unique constraint on `bin_map.new_bin`: a map that gives one code to two old
bins is exactly the zone-E/zone-K defect, and refusing to load it would hide
the defect instead of reporting it. Both the upload preview and `/api/map` GET
call those collisions out.

**`checks` is unique per `(site, source, old_bin)`.** Re-auditing a shelf after
its label has been fixed replaces the old verdict rather than accumulating
history, so the tallies always describe the current state of the floor. Keeping
`source` in the key means an audit against the uploaded map and one against the
scanned pairs do not overwrite each other.

**Spreadsheets are read in the browser.** `src/lib/sheet.ts` parses the zip
central directory by hand and inflates with the native `DecompressionStream`,
then posts plain rows in chunks of 4,000. No server-side unzip, no dependency,
and a bad sheet is caught before anything is stored. It was lifted from the
standalone build's reader, and `npm test` now round-trips it against our own
writer.

**Auth is deliberately small.** PBKDF2 + an HMAC-signed cookie via Web Crypto —
no Clerk, no Auth.js, no extra dependency. Warehouse floor, handful of users,
shared machines. If SSO is ever needed, `src/lib/auth.ts` is the only file that
changes.

**Neon, not `@vercel/postgres`.** That package is sunset. The client is lazily
initialised in `src/lib/db.ts` because Next evaluates module top level at build
time and `neon()` throws without `DATABASE_URL` — which breaks the first
deploy. Deliberately a plain function, **not** a `Proxy` wrapper; Proxies
around DB clients break libraries that introspect them.

**Own XLSX writer.** `src/lib/xlsx.ts` is a hand-built stored-zip + CRC32 +
inline-string writer, no dependency. Verified by opening generated files in
real Excel and in openpyxl, including `"`, `&` and `<>` in values.

**Superset then reconcile.** Print more labels than needed, scan what is real,
then delete the leftovers. The alternative — print exactly what the old data
implies — is what failed at site 18.

---

## State: what works

Verified in this repo:

- `npm run build` — clean, all routes correctly dynamic
- `npm test` — 79 logic tests pass
- `npx tsc --noEmit` — clean

Built:

- login / logout / session
- site create (admin) and select
- label generation from an old bin list, four bases, floor-level `Z`,
  26-letter overflow flagged
- scan pairing with local + server validation, audio feedback, undo
- live view of other scanners' progress (10s poll)
- reconcile — unused, unexpected, one-for-one verdict
- **validation mode** — upload an old→new worksheet (`.xlsx` / `.csv` / `.tsv`
  / paste, read in the browser), or audit against the pairs already scanned in;
  scan old → hung label and get match / mismatch / not-in-reference, with the
  expected code shown on a mismatch and a warning when the code that was hung
  belongs to a different bin
- `.xlsx` export — summary, cross-reference, unused, unexpected, plus
  `AUDIT - TO FIX`, `AUDIT - ALL` and `BIN MAP` when those exist

---

## State: what is NOT done

**Untested against a live database.** No Neon instance existed while building.
Everything DB-shaped is unexercised: the migration, the unique-violation path,
the conflict message, both `unnest` bulk inserts, the `ON CONFLICT DO UPDATE`
upserts in `bin_map` and `checks`, and the reconcile queries. The SQL is
straightforward but *none of it has run*. First real task:

```bash
npm run migrate
npm run user -- admin <password> admin
npm run dev
```

then:

1. create a site, generate labels from a small list, scan a few pairs;
2. force a conflict by scanning the same old bin twice — from two browsers at
   once, ideally, since that is the behaviour the whole design rests on;
3. upload a small two-column sheet on the Validate tab and check the row count
   that comes back, then re-upload it to confirm `replace` really replaces;
4. scan a match, a mismatch and a bin that is not in the map, and confirm the
   three verdicts and the tallies;
5. re-scan a mismatch correctly and confirm the verdict is replaced, not added.

Watch particularly for a bulk insert that repeats a key inside one statement —
Postgres rejects that outright. `/api/map` collapses repeats before inserting,
which is the part most worth confirming on real data.

One bug of exactly this kind has already been found and fixed without a
database: `scripts/migrate.mjs` called `sql(ddl)`, and as of
`@neondatabase/serverless` v1 the function returned by `neon()` is
tagged-template only — it throws on a plain string. Every DDL statement would
have failed before touching Postgres. It now calls `sql.query(ddl)`. Assume
there are more like it.

**Also missing:**

- Not yet published to the shared repository under `NPW-Companies/`. There is
  no git remote on this clone and the `gh` CLI is not installed on this
  machine, so it needs either `gh` or a repo URL to push to.
- No manual-range UI. `generateLabels` supports `mode: 'manual'` (zones, aisle
  and column ranges, shelf count) and it is tested, but the Labels tab only
  exposes the derive path. Wiring it up is a small form.
- The Labels tab is still paste-only. `src/lib/sheet.ts` now reads `.xlsx` and
  `.csv` for the bin map, and the same reader would drop straight into the old
  bin list — nothing else is needed.
- No printed-list upload for reconcile. It reconciles against the *stored*
  label set, which assumes what was generated is what was printed. If they can
  differ, add an upload.
- Validation has no location gate. Pairing checks the scanned code against the
  zone/aisle you are standing in; an audit accepts any bin at any time, because
  auditing tends to jump around. If audits turn out to want it too, `Loc` and
  `validatePair` are already there.
- No label PDF/print output. Labels export as `.xlsx`; whatever prints the
  barcodes is outside this app.
- No site archiving, no delete, no per-site user assignment.
- Polling is every 10s. Fine for a handful of scanners; if it gets busy, move
  to SSE or shorten it.
- No rate limiting on login. Add Upstash if this is ever internet-facing rather
  than on the warehouse network.

---

## Gotchas

- `tsconfig.json` needs `"allowImportingTsExtensions": true`. `next build`
  rewrites `include` to `**/*.ts`, which pulls in `scripts/test.ts`, and that
  file imports with explicit `.ts` extensions because it runs under
  `node --experimental-strip-types`. Without the flag the build fails type
  checking — it did, before this was added. It is safe: `noEmit` is on.
- `next build` also reconfigures `jsx: react-jsx` and adds a types include.
  Expected, harmless, already committed.
- `scripts/*.mjs` load `.env.local` and then `.env`, explicitly. Plain
  `dotenv/config` reads `.env` only, which silently did nothing for anyone who
  followed the README and created `.env.local` — that was a real bug, fixed.
  Only Next auto-loads env files; Node scripts do not.
- The Neon Marketplace integration prefixes everything it injects with the
  storage name — `LABELPG_DATABASE_URL` and so on — so the connection string is
  *resolved*, not named: `src/lib/dburl.mjs` prefers `DATABASE_URL` and falls
  back to any `*_DATABASE_URL` / `*_POSTGRES_URL`, skipping `*_UNPOOLED`,
  `*_NON_POOLING`, `*_PRISMA_URL` and `*_NO_SSL`. It is plain `.mjs` so the
  `scripts/*.mjs` and the app share one implementation; `allowJs` is on.
- `scripts/test.ts` runs under `node --experimental-strip-types`. The
  `MODULE_TYPELESS_PACKAGE_JSON` warning is noise. Adding `"type": "module"`
  would silence it but was left alone to avoid disturbing the Next build.
- `src/lib/sheet.ts` is browser-side, but it does run under Node 20 for the
  round-trip test — `Blob`, `Response` and `DecompressionStream` all exist
  there. Do not import it into a route; there is no reason to.
- The Neon driver needs Node 19+; `package.json` asks for 20+.
- Neon's HTTP driver has no multi-statement transactions. Nothing here needs
  one — both bulk inserts are chunked into single statements.
