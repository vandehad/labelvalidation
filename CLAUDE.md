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
  `repairPair` is not an exception: it deletes whatever either bin was paired
  to and inserts the new pair inside one transaction, with the constraints
  still in force, and only while someone has Repair switched on by hand.
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
- **No validation against where the scanner says they are.** It was built,
  then removed: a scanner covers ground faster than they re-declare where they
  stand, so it mostly refused correct scans. `pairs.location` is a free-text
  note now. What *is* checked is the two scans against each other
  (`src/lib/pairguard.ts`): the old label's aisle against the new label's
  aisle. Aisle only - zone letters are a per-site mapping and columns run
  backwards in whole zones, so neither may ever be compared.
- **Three strengths of "no", and which is which matters.** *Refused*: bad
  format, reversed scan, a UPC in the old field (`looksLikeUpc`, 9+ digits),
  and the unique constraints. *Held*: a crossed aisle, or an old bin not in the
  site's WMS list - 409 `needsConfirm`, and the same pair sent again with
  `confirmed` goes in with the reason kept in `pairs.warned`. The confirmation
  is a second scan of the same label, never a button. *Recorded*: validation
  mode, which refuses nothing. Do not promote a held check to a refusal - 26
  real shelves at site 7 were not in the WMS list. `recordPair` in
  `src/lib/pairing.ts` is the one way a pair goes in, for `/api/pairs` and
  `/wm` alike.
- **One scan at a time on `/scan`.** While a pair is saving the fields are
  read-only and a scan that arrives is refused out loud (WAIT FOR THE BEEP),
  and after anything red they stay shut for a beat. A scan pulled mid-save
  used to land in a field about to be cleared and the associate walked on
  believing it counted. The fields reopen on the save, not on the tally -
  `void refresh()`, never `await` - and every call has a 12 s deadline.
- **`pairs.old_canon` is set by a trigger, not by code.** Progress joins on it.
  Never write it from an insert and never go back to `canon_old(old_bin)` over
  the table - that ran on every pair of the site after every scan.
- **A reprint comes out of what is stored, never out of the generator.** A
  replacement label has to be identical to the one it replaces, so `pickCodes`
  selects from the site's stored set and reports a code that is not in it
  rather than printing it. Printing a code the database has never heard of is
  how a rack ends up with a bin nothing can find.
- **Generating labels adds to the set; it never replaces unless asked.**
  `POST /api/labels` inserts with `ON CONFLICT DO NOTHING`. `replace: true` is
  the only thing that deletes first, the tab asks for it with a checkbox and a
  confirm, and the route refuses it while `pairs` exist for the site. The first
  version deleted before every insert, and adding one aisle to site 7 wiped
  44,451 labels. Admin -> Wipe is the deliberate way to clear a set.
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
  above holds from every screen; keep that check. Jobs carry a `kind`:
  `reprint` for a single label asked for from the floor, `batch` for a run,
  `batch2` for a run sent to a relay's second batch printer. A relay sends
  each to the printer it names and falls back to its first when that one is
  not set - never leave a job waiting on a printer nobody configured.
  `claimNext` hands reprints out ahead of batches. The relay runs a loop
  per printer and each claims only its own kinds, so the printers run at the
  same time; each printer's held run is released and cancelled on its own.
  **A run goes to one printer, whole.** Alternating a run's batches between
  the two was built and removed the same day - it puts half an aisle on each
  stack. Two printers are used by sending a zone to each. The one LAN listener is the
  **Windows Mobile gateway** (`wmGateway`, opt-in by port): it forwards `/wm`
  and nothing else, because an MC92N0 cannot do TLS 1.2 and cannot reach the
  app any other way. It must never accept ZPL or expose the setup page.
- **Nothing polls the database without a reason to.** Neon bills for every
  hour the database is awake and it only sleeps after five minutes of no
  queries at all. On 21 Sep 2026 the account ran out of quota and the floor
  stopped - scanning, not just printing - because the relays polled every few
  seconds all night (one loop per printer made it three times worse) and every
  open browser tab polled too. So: the relay makes **one** request for all its
  free printers, slows to 15 s when idle, and at night checks every 6 minutes
  (`restDelay`); every timer in `Station.tsx` goes through `everyWhileVisible`
  and stands still in a hidden tab. Do not add a bare `setInterval` that
  queries, and do not give the relay a second polling loop.
- **The relay waits for a busy printer; it never hangs up on one.** A Zebra
  with a full buffer stops reading until the batch ahead has printed, which
  for 500 labels is longer than the two minutes `sendTcp` used to allow. The
  relay destroyed the socket, a destroyed socket discards what was not yet
  delivered, and the tail of the batch never printed - ten batches at site 15
  in two days, each marked only "Timed out". Silence on a live connection
  means busy: the idle limit is 30 minutes (`--idle-seconds`), the close is
  always `end()`, never `destroy()` on a healthy send, and a printer that is
  off or unplugged still fails in seconds because that is a refused or lost
  connection, not silence. While it waits the relay refreshes its claim and a
  Stop drops the connection.
- **A batch run does not print a label twice without being told to.**
  `sentBefore` finds the codes already in a job that printed or is going to
  (held, queued, printing, done; thirty days), the Print card asks and leaves
  them out, and `queueJobs` refuses them with 409 for any screen that did not
  ask - `allowRepeat` is the deliberate way through, and a `reprint` is never
  checked. The zone buttons toggle: at site 15 "zone C" went to the second
  printer with B still lit, and 500 B labels came out twice.
- **`@zxing/*` is reached only through the dynamic import in
  `src/lib/camera.ts`.** It is the phone-camera fallback for browsers without
  `BarcodeDetector`. A static import anywhere would put a 450 KB decoder into
  the handheld bundle for every TC52, which never opens a camera.
- Refusals happen client-side for speed **and** server-side for truth. Keep
  both in step; `validatePair` in `src/lib/bins.ts` is shared by each.

## Conventions

- Bin codes are uppercased at every boundary.
- Old bins come in two formats (`A-1-1-1` and `A010101`) plus padding variants.
  Use `parseOld`; do not write another regex. The WMS at site 7 uses a third,
  numeric-zone form (`01-09-03-05`); `canonOld` in `src/lib/oldbins.ts` and
  `canon_old()` in Postgres are the one comparable form for it - keep them
  in step, and compare the WMS list to `pairs.old_bin` through them only.
- **Progress is measured against the WMS old-bin list, not the label set.**
  The label set is a deliberate superset, so "labels left" never reaches zero.
  `old_bins` is loaded per site on the Admin tab, changes neither pairs nor
  labels, and its unpaired remainder is the exception report on Reconcile.
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
