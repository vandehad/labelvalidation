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
real Excel and in openpyxl, including `"`, `&` and `<>` in values. The
standalone version also has a *reader* using the browser's native
`DecompressionStream`; the server side does not need one yet.

**Superset then reconcile.** Print more labels than needed, scan what is real,
then delete the leftovers. The alternative — print exactly what the old data
implies — is what failed at site 18.

---

## State: what works

Verified:

- `npm run build` — clean, all routes correctly dynamic
- `npm test` — 37 logic tests pass
- `npx tsc --noEmit` — clean

Built and working:

- login / logout / session
- site create (admin) and select
- label generation from an old bin list, four bases, floor-level `Z`,
  26-letter overflow flagged
- scan pairing with local + server validation, audio feedback, undo
- live view of other scanners' progress (10s poll)
- reconcile — unused, unexpected, one-for-one verdict
- `.xlsx` export — summary, cross-reference, unused, unexpected

---

## State: what is NOT done

**Untested against a live database.** No Neon instance existed while building.
Everything DB-shaped is unexercised: the migration, the unique-violation path,
the conflict message, `unnest` bulk label insert, the reconcile queries. The
SQL is straightforward but *none of it has run*. First real task:

```bash
npm run migrate
npm run user -- admin <password> admin
npm run dev
```

then create a site, generate labels from a small list, scan a few pairs, and
force a conflict by scanning the same old bin twice — from two browsers at
once, ideally, since that is the behaviour the whole design rests on.

**Also missing:**

- No manual-range UI. `generateLabels` supports `mode: 'manual'` (zones, aisle
  and column ranges, shelf count) and it is tested, but the Labels tab only
  exposes the derive path. Wiring it up is a small form.
- No file upload in the web app — paste only. The standalone version reads
  `.xlsx`/`.csv`; that reader could be lifted into `Station.tsx`.
- No printed-list upload for reconcile. It reconciles against the *stored*
  label set, which assumes what was generated is what was printed. If they can
  differ, add an upload.
- No label PDF/print output. Labels export as `.xlsx`; whatever prints the
  barcodes is outside this app.
- No site archiving, no delete, no per-site user assignment.
- Polling is every 10s. Fine for a handful of scanners; if it gets busy, move
  to SSE or shorten it.
- No rate limiting on login. Add Upstash if this is ever internet-facing rather
  than on the warehouse network.

---

## Gotchas

- `next build` reconfigures `tsconfig.json` (sets `jsx: react-jsx`, adds a
  types include). Expected, harmless, already committed.
- `scripts/*.mjs` need `.env.local` — they load it via `dotenv/config`. Only
  Next auto-loads env files; plain Node scripts do not.
- `scripts/test.ts` runs under `node --experimental-strip-types`. The
  `MODULE_TYPELESS_PACKAGE_JSON` warning is noise. Adding `"type": "module"`
  would silence it but was left alone to avoid disturbing the Next build.
- The Neon driver needs Node 19+; `package.json` asks for 20+.
- Neon's HTTP driver has no multi-statement transactions. Nothing here needs
  one — the bulk label insert is chunked into single statements.
