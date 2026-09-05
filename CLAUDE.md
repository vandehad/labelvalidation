# CLAUDE.md

Warehouse bin label conversion. Next.js 16 + Neon Postgres on Vercel.

**Read `HANDOFF.md` first** — it has the project history, the numbering rule,
the design decisions and, most importantly, what is not yet done.

## Commands

```bash
npm run dev        # local
npm test           # 214 logic tests, no DB needed
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
- **The barcode carries a zone field, the printed line does not.**
  `M0501B01` is encoded as `M     M0501B01` - the zone letter padded to six
  characters, then the code - so a scanner returns all fourteen. `normalizeScan`
  takes what follows the last space, on the client *and* the server. Without it
  every real scan fails the format gate and is recorded as `unmapped`, which
  looks exactly like a missing bin.
- **That zone field is derived by `barcodeData`, never configured.** The zone
  is already the first character of the code. Asking anyone to supply it invites
  a wrong letter across a whole zone's worth of barcodes, and nothing on screen
  would show it - the printed line looks right either way.
- **The barcode is never dashed.** `displayCode` puts a dash after the third
  character for the human-readable line only. A scan of `A00-00A01` matches
  nothing in `pairs`, `labels` or `bin_map` - every code stored is undashed.
- **No zone/aisle validation on pairing.** It was built, then removed: a
  scanner covers ground faster than they re-declare where they stand, so it
  mostly refused correct scans. `pairs.location` is a free-text note now.
- **A reprint comes out of what is stored, never out of the generator.** A
  replacement label has to be identical to the one it replaces, so `pickCodes`
  selects from the site's stored set and reports a code that is not in it
  rather than printing it. Printing a code the database has never heard of is
  how a rack ends up with a bin nothing can find.
- **`generateLabels` reports what it could not honour.** Overlapping zone
  blocks would otherwise be swallowed by `UNIQUE (site_id, code)` without a
  word. `problems` carries them out to the caller; do not drop it.
- **`/wm` is the Windows Mobile route and takes no JavaScript.** IE Mobile on
  an MC92N0 has no `fetch`, no ES6, no flexbox, and React will not run. It is
  HTML 4.01 with table layout, and **one input per page** - a wedge sends the
  scan then Enter, and Enter in a form with two text inputs submits early or
  not at all depending on the browser. Do not add a second field to those forms.
- **`/scan` is the handheld page and is a separate route on purpose.** Not a
  breakpoint on the desktop tab - the two are different tools. Its fields carry
  `inputMode="none"`: DataWedge types a scan in as keystrokes, and Android must
  not raise the on-screen keyboard over a five-inch screen on every scan.
- **A bin added on the floor keeps a placeholder old bin.** A shelf with no
  old label still gets a code, and `mintedOldBin` gives it `NEW-000117` so the
  row stays in `pairs`. Without a partner it would look like an orphan and
  reconcile would list it under "unused, delete these" - which is how a freshly
  hung shelf becomes a bin the WMS cannot find. Branch on `pairs.origin`, never
  on the `NEW-` prefix.
- Scanner input must never be cached. Routes are `force-dynamic`.
- **Printing is a queue the relay pulls; nothing pushes to the relay from
  off its PC.** A TC52 cannot reach the relay's loopback, and Chrome refuses
  an https page calling an http LAN address regardless. Screens POST to
  `/api/print`; the relay polls `/api/print/next` for its one site with the key
  from `settings.relay_key`. Do not bind the relay off `127.0.0.1` or add a
  LAN push path - it will work on one laptop and nowhere else. `queueJobs`
  checks every code against the site's stored `labels`, so the reprint rule
  above holds from every screen; keep that check.
- **`@zxing/*` is reached only through the dynamic import in
  `src/lib/camera.ts`.** It is the phone-camera fallback for browsers without
  `BarcodeDetector`. A static import anywhere would put a 450 KB decoder into
  the handheld bundle for every TC52, which never opens a camera.
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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
