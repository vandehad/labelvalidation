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
- Trailing `01` is the position within the shelf. Every site seen so far has
  exactly one, so it defaults to `01` — but the batch generator can lay down
  `01`..`NN` where a shelf holds several, up to 99. Two digits is the ceiling;
  a third would change the length of every code in the system.

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

**There is no zone/aisle check.** One was built — set the location, and a label
from the wrong aisle was refused — and then removed, because a scanner covers
ground faster than they re-declare where they are standing, so it mostly
refused correct scans. `pairs.location` survives as a free-text note that is
recorded and exported but never validated. The question that matters at the
shelf is whether the two labels in hand go together.

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

**The dash is display only.** `displayCode` inserts one after the third
character so `A0000A01` reads as `A00-00A01` on the printed label. The barcode
carries the undashed code, because that is what is in `pairs`, `labels` and
`bin_map`. Put the dash in the barcode and every scan silently matches nothing
— which is a whole afternoon to diagnose from the floor. There is a test
asserting the barcode field specifically, not merely "some field", because the
obvious regex for it matches the human-readable line by accident.

**The barcode carries a zone field.** The site's own ZPL encodes
`A     A2707G05` - `A`, five spaces, then the code - a six-character
left-justified field. The printed line carries no such thing. New labels match
it so a rack of old and new scans alike, and `normalizeScan` in `bins.ts` takes
whatever follows the last space, applied on the client and again on the server.
Skip it and every real scan fails the format gate and lands as `unmapped`,
indistinguishable from a bin nobody mapped.

That field held an ambiguity for a while: in `A     A2707G05` the leading `A`
is also the zone letter, so a constant and a repeated zone look identical. It
is the **zone** - `M0501B01` encodes as `M     M0501B01`. `barcodeData` in
`zpl.ts` derives it, and it is deliberately not a setting: the zone is already
the first character of the code, and a mistyped one would put the wrong
character in every barcode of a zone with nothing on screen to show it.

**Printing is a queue the relay pulls from, not a push to the printer.** A
page cannot open a raw socket and cannot see a USB printer, so something on
the PC with the printer has to bridge it — `scripts/print-server.cjs`, which
forwards ZPL over TCP to port 9100 or through the Windows spooler in RAW mode.
(RAW is not optional: ZPL through a normal driver prints the text of the ZPL.
The Windows path uses PowerShell with an inline `winspool` P/Invoke rather
than a native module, because a native module would want a compiler on a
warehouse PC.)

The first version had browsers POST to that relay at `localhost:9110`. That
only ever worked for the one PC the relay was on: a TC52 in an aisle cannot
reach it, and Chrome will not let an https page call an http LAN address
regardless — `Access-Control-Allow-Private-Network` rescues `localhost` only.
So the direction was turned round. Screens queue a job in `print_jobs` through
`/api/print`; the relay signs in with a key from `settings.relay_key`, is bound
to one site on its setup page, and polls `/api/print/next` for that site's
jobs. Outbound https from any PC is the one path that always works, which is
why the desktop, the TC52, a phone and the MC92N0 all print identically now.
The relay verifies the address and key before it will save them, so a relay
that silently prints nothing cannot be configured.

Things that matter in `src/lib/printq.ts`: the claim is one `UPDATE … FOR
UPDATE SKIP LOCKED` so two relays on a site never print the same job; a job
claimed three minutes ago and never finished goes back in the queue, so a
relay dying mid-print loses nothing; every code queued is checked against the
site's stored `labels` server-side, so the reprint rule holds no matter which
screen asked; and the key is in the database rather than an environment
variable, because a relay is set up by whoever is standing at that PC and the
Admin tab is where they can read it from. The direct `localhost` path is kept
as an option on the Print card for a laptop sitting beside the printer.

**Zone blocks, not one uniform shape.** A warehouse divides into stretches of
aisles - 1-26 zone A at 24 columns of 10 shelves, 27-36 zone B at 18 of 8 - and
the next site divides differently. `GenSpec` has a `blocks` mode taking one
`ZoneBlock` per stretch, each with its own columns, shelves and positions.
Positions moved onto the column for this: one block can hold several per shelf
while the next holds one.

Overlapping blocks are **reported**, in `GenResult.problems`. `UNIQUE
(site_id, code)` with `ON CONFLICT DO NOTHING` would absorb the duplicates in
silence, and a label set quietly smaller than asked for is not noticed until
the racks are hung.

**A reprint is not a small generation run.** `pickCodes` selects from the
site's *stored* labels - all, whole zones, a range between two codes, or a
typed-or-scanned list - because a replacement has to be identical to the label
it replaces. A code the site has no record of comes back in `missing` rather
than going to the printer; a rack with a bin the database cannot find is the
failure this app exists to prevent. List entries go through `normalizeScan`, so
a damaged label can be scanned straight into the box.

**The handheld is its own route, not a breakpoint.** `/scan` and the desktop
Validate tab do the same job for different hands. The desktop one shows tables
and history; the handheld one shows a verdict the size of the screen and
nothing else. Trying to serve both from one component would have meant a
compromise that suited neither.

Three things there are load-bearing rather than decorative. `inputMode="none"`
on the scan fields: DataWedge types a scan in as keystrokes, so the field must
accept them, but without this Android raises the on-screen keyboard over half a
five-inch screen on every single scan. `navigator.vibrate` on a mismatch: an
aisle is loud, a beep alone gets missed, and a missed mismatch is a wrong label
left hanging. And focus returning to the old-bin field after every scan, so
nobody has to tap a screen wearing gloves.

**The camera is a third way in, not a fourth screen.** A phone with no gun can
press Camera on `/scan` and read labels through `src/lib/camera.ts`. It feeds
the same two fields and the same `commit`, so every rule — zone field stripped,
reversed scan refused, one-for-one enforced by Postgres — applies unchanged.
Android Chrome has a native `BarcodeDetector`; Safari does not, so ZXing is a
dynamic import fetched only when a camera is opened on a browser without one.
Keep it dynamic: a static import would hand every TC52 a 450 KB decoder it will
never run. Nobody has asked for this yet; it is there because it was cheap and
a foreman with a phone is a plausible Tuesday.

**Add-a-bin is on all three screens, and all three print.** The desktop
card, `/scan` and `/wm` go through `src/lib/mint.ts`, so they cannot disagree
about what a valid new bin is, and each queues the label through the same
`queueJobs` the moment the bin is made. The handheld then watches the job and
walks the verdict from ADDED to PRINTING to PRINTED, so nobody has to ask
whether the label came out. The Labels tab's "Added on the floor" pick still
lists every minted bin for printing in one go; `/api/labels` returns `origin`
for that.

**Superset then reconcile.** Print more labels than needed, scan what is real,
then delete the leftovers. The alternative — print exactly what the old data
implies — is what failed at site 18.

---

## State: what works

Verified in this repo:

- `npm run build` — clean, all routes correctly dynamic
- `npm test` — 200 logic tests pass
- `npx tsc --noEmit` — clean
- 37 further checks against the live Neon database, end to end through the
  HTTP routes — see the section below

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

## The database, and what running it proved

A Neon instance now exists — the `labelpg` store on the `npwcompanies` Vercel
project, `neondb` on an `ep-dark-frog-…-pooler` host. `npm run migrate` has run
against it: 13 statements, all applied, and a second run was a no-op, so it is
genuinely idempotent.

Every constraint the design depends on is in place and was read back out of
`pg_constraint` to be sure:

```
bin_map   bin_map_pkey         PRIMARY KEY (site_id, old_bin)
checks    checks_old_unique    UNIQUE (site_id, source, old_bin)
labels    labels_site_id_code_key  UNIQUE (site_id, code)
pairs     pairs_new_unique     UNIQUE (site_id, new_bin)
pairs     pairs_old_unique     UNIQUE (site_id, old_bin)
```

`pairs_new_unique` and `pairs_old_unique` matter by *name*: `/api/pairs` reads
`e.constraint` to decide which of the two conflicts it is looking at. Rename
either and the 409 message silently starts describing the wrong bin.

The whole path was then exercised end to end against that database — 37 checks,
all passing. Worth knowing what is now proven rather than assumed:

- both `unnest` bulk inserts, including a chunk containing the same old bin
  twice, which Postgres rejects outright unless the repeats are collapsed
  first — `/api/map` does collapse them, and last one wins
- both unique-violation paths, returning the right bin and the right person:
  `A-1-1-1 is already paired to A0101C01 (scanned by admin).` and
  `A0101C01 is already used by A-1-1-1 (scanned by admin).`
- the format gate, which refuses a malformed new label *even when the client
  asks it not to*
- the `ON CONFLICT DO UPDATE` upserts: re-auditing a fixed shelf flipped its
  verdict from mismatch to match and left the total at three, rather than
  accumulating a fourth row
- audits against the map and against the pairs keeping separate tallies
- deleting a pair freeing both bins for reuse
- the reconcile queries, and a 19 KB workbook out of the export

Two bugs were found and fixed on the way, both sitting in the first lines of
database code anyone executes: `sql(ddl)` (the driver is tagged-template only
since v1) and `dotenv/config` reading `.env` while the README says `.env.local`.

## State: what is NOT done

**Production cannot sign anyone in.** The deployed app reaches the database
fine — it resolves `LABELPG_DATABASE_URL` and queries happily — but
`SESSION_SECRET` is not reaching the runtime, so a correct password returns
`500 SESSION_SECRET is not set` while a wrong one correctly returns 401. The
variable is listed for Production and the serving deployment is newer than it,
so the value is most likely empty. Re-add it in the dashboard and redeploy;
env changes only reach *new* deployments.

**The Windows RAW print path has never run.** The network path is proven end
to end - labels came out of the Zebra at 192.168.60.81 directly, through the
relay, and through the packaged `.exe`. The USB/local-queue path is written but
untested; a `WritePrinter` failure would surface as a PowerShell error in the
relay's console.

**Nothing has been tested with two people scanning at once.** The constraints
make the race impossible in principle and the conflict path is proven, but the
actual simultaneous case — two scan guns, one shelf — has not been staged.

**Also missing:**

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
- The relay polls every 15 s when idle, which keeps the Neon database awake
  while a relay window is open. Fine on a paid plan; on a free one, stop the
  relay when nobody is printing, or add a "pause" to it.
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
