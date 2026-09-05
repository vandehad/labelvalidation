# Label Validation

Bin label conversion for warehouse re-slotting. Scan the old bin, scan the new
label, and the pairing is recorded with a **one-for-one guarantee enforced by the
database** — several people can scan different aisles at the same time without
any chance of two shelves ending up on one code.

Converts old `Zone-Aisle-Column-Shelf` bins to the new
`{Zone}{aisle:2}{column:2}{letter}01` format.

Two modes:

- **Scan & Pair** — build the mapping by scanning both labels. One-for-one is
  guaranteed because the database will not accept a second claim on either bin.
- **Batch + print** — say the shape of the warehouse (zones, aisles, columns,
  shelves, positions) and get the label set, printed to a Zebra as Code 128.
- **Admin** — accounts, roles, password resets. Nothing is ever deleted.
- **Handheld** — the same validation at `/scan`, sized for a Zebra TC52.
- **Validate** — audit a mapping that already exists. Upload the old→new
  worksheet (or point at the pairs already scanned in), then scan each shelf and
  get **match**, **mismatch** or **not in the reference**. Nothing is refused
  here: the shelf is reporting what is physically hung, right or wrong.

---

## Quick start

```bash
npm install
cp .env.example .env.local          # fill in DATABASE_URL and SESSION_SECRET
npm run migrate                     # create the schema
npm run user -- admin <password> admin
npm run dev                         # http://localhost:3000
```

Generate `SESSION_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Deploying to Vercel

```bash
vercel link
vercel integration add neon         # provisions Neon and sets DATABASE_URL
vercel env add SESSION_SECRET       # paste the hex string, all environments
vercel env pull .env.local          # bring DATABASE_URL down for local work
npm run migrate                     # run once against the provisioned database
vercel deploy --prod
```

`SESSION_SECRET` is the only variable you set by hand.

The connection string is found rather than named. The Neon integration prefixes
everything it injects with the storage name — a store called `labelpg` produces
`LABELPG_DATABASE_URL`, `LABELPG_PGHOST` and a dozen more — so
`src/lib/dburl.mjs` takes `DATABASE_URL` if it is set and otherwise looks for a
`*_DATABASE_URL` (then `*_POSTGRES_URL`), skipping the ones that are the wrong
kind of URL: `*_UNPOOLED` and `*_NON_POOLING` bypass the connection pooler,
`*_PRISMA_URL` is Prisma's format, `*_NO_SSL` is unencrypted.

Nothing to copy by hand, and nothing to go stale if the store is ever recreated
under a different name. Nothing else is required — no
`vercel.json`, no build configuration.

The database client initialises lazily, so `next build` succeeds before the
integration has provisioned anything.

---

## How a conversion runs

1. **Create a site** — admin only, the `+` beside the site picker.
2. **Generate labels** (Labels tab). Paste the old bin list; the app works out
   every zone/aisle/column and how tall each is, then stores the full label
   superset. Print those.
3. **Scan and pair** (Scan tab). Set the zone and aisle you are standing in,
   then scan old → new for each shelf.
4. **Reconcile** (Reconcile tab). Labels never scanned are unused and should be
   deleted from the WMS. That deletion is what makes the conversion exactly
   one-for-one.
5. **Export** the workbook: cross-reference, unused, unexpected, summary.

## Generating and printing a batch

The **Labels** tab builds the set from an old bin list, or from **zone
blocks** — one row per stretch of aisles, because a warehouse is rarely
uniform:

| Zone | Aisles | Columns/aisle | Shelves/column | Positions/shelf |
| --- | --- | --- | --- | --- |
| A | 1 – 26 | 24 | 10 | 1 |
| B | 27 – 36 | 18 | 8 | 1 |

Each block has its own shape, and the next site divides differently again. The
count, the first and last code, and any collision are shown before anything is
generated — 26 aisles x 24 columns x 10 shelves is 6,240 labels in zone A
alone, and roughly six rolls.

If two blocks claim the same aisle, it says so. The unique index on `labels`
would quietly collapse the duplicates otherwise, and a silently smaller label
set is exactly the sort of thing that is not noticed until the racks are hung.

### Reprinting

The Print card takes **every label**, **whole zones**, **a range** from one
code to another, or **just these** — a list typed in or scanned straight off
the damaged labels, since the gun returns the zone field and it is stripped on
the way in.

Reprints come out of what is stored, never out of the generator again: a
replacement has to be identical to the label it replaces. A code the site has
no record of is reported rather than printed.

Each label is 4x1 inch, Code 128:

```
+------------------------------------+
|  ||| || |||| | || ||| |||| | ||||   |   barcode:  A0000A01
|  ||| || |||| | || ||| |||| | ||||   |
|             A00-00A01              |   shown as: A00-00A01
+------------------------------------+
```

Two things about that, both taken from the labels the site already hangs:

**The dash is display only.** It never goes in the barcode — a scan of
`M05-01B01` matches nothing in the database.

**The barcode carries a zone field**: `M     M0501B01`, the zone letter padded
to six characters, then the code. It is derived from the code, not a setting.
A scanner returns all fourteen characters and `normalizeScan` takes what
follows the last space, so old and new labels scan identically.

### Getting them to the printer

A browser has no raw socket API and cannot see a USB printer, so a hosted page
cannot reach a Zebra by itself. Something local has to bridge it.

**The easy way — a standalone executable, nothing installed.**

```bash
npm run build-exe        # produces dist/print-server.exe, ~88 MB
```

Copy that one file to the PC with the printer and double-click it. It opens its
own window — Edge or Chrome in `--app` mode, so no address bar or tabs — where
you pick **network** and type the printer's IP, or **USB/shared** and choose
from the installed queues, then *Print a test label* to prove the path before
touching the web app.

Day to day:

| | |
| --- | --- |
| Change the printer | reopen `http://localhost:9110`, or just run the .exe again |
| Stop it | **Stop the relay** in the window, or Ctrl-C in the console |
| Start it | double-click the .exe; it remembers the printer |

The choice lives in `~/.labelvalidation/print-server.json`; delete that to start
over. Closing the app window alone leaves it running in the background — the
Stop button is what actually ends it.

It carries the whole Node runtime, which is where the size goes — no Node, no
npm, no dependencies on the machine that runs it.

**From source**, if Node is already there:

```bash
npm run print-server                              # opens the setup page
npm run print-server -- --host 192.168.60.81      # network printer
npm run print-server -- --printer "Zebra ECOM2"   # USB / local queue
```

Either way it listens on `http://localhost:9110`, accepts ZPL at `/print`, and
forwards it — a raw socket to port 9100 for a network printer, or the Windows
spooler in **RAW** mode for a local one. RAW is not optional: ZPL through a
normal driver prints the *text* of the ZPL, pages of it.

Loopback only, so nothing off that PC can drive your printer, and the app posts
in chunks of 500 so a run of thousands shows progress rather than looking like
a hang.

**Or no local software at all:** *Download .zpl* in the Print card, then
`copy /b labels.zpl \\localhost\ZebraECOM2`.

## On a handheld

`/scan` is validation for a Zebra TC52 or any Android scanner. Sign in on the
device and it stays signed in for the shift; the site and reference are
remembered between wakes.

It is a separate page rather than a narrow version of the desktop tab, because
the constraints are different:

- **The keyboard stays down.** DataWedge delivers a scan as keystrokes with an
  Enter suffix, so the fields accept it while `inputMode="none"` stops Android
  raising the on-screen keyboard over half the screen on every scan.
- **The verdict is the page** — full-width, colour first, readable at arm's
  length with the device in one hand.
- **A mismatch vibrates.** An aisle is loud enough that a beep alone gets
  missed, and a missed mismatch is a wrong label left on the rack.
- **Focus returns to the old-bin field after every scan**, so the gun always
  lands somewhere useful without tapping the screen with gloves on.
- Buttons are 52px, and the tally sits along the bottom: checked, mismatch,
  not-in-reference, to go.

Scanning a printed label works as it does anywhere else — the gun returns the
six-character zone field and `normalizeScan` strips it.

### With a phone camera

The **Camera** button on `/scan` opens the rear camera as a third way to get a
code into the same two fields. Point it at the old label, then at the new one;
the second read commits the pair exactly as if a gun had typed it. Nothing
downstream can tell the difference — the zone field is stripped and the
wrong-way-round gate applies.

- Android Chrome uses the browser's built-in `BarcodeDetector`: native, no
  download.
- Safari has no such thing, so on an iPhone the ZXing decoder is fetched on
  first use (about 450 KB). It is a dynamic import in `src/lib/camera.ts` —
  a TC52 or a laptop, which never open the camera, never download it.
- A camera reads the same label many times a second. `debounceCode` counts a
  code once and treats repeats within 1.5 s as the camera still looking at it.
- It needs HTTPS. `getUserMedia` refuses on plain http, so `npm run dev` on a
  phone will say the camera could not be opened; the Vercel deployment is fine.

## Auditing labels that are already hung

Use the **Validate** tab when the labels exist and the question is whether they
are correct — a vendor-supplied conversion, or a re-check of your own work.

1. **Pick the site** in the header. Everything below is loaded against it, so
   choose it before uploading anything.
2. **Choose the reference**: the uploaded bin map, or the pairs already scanned
   in on this site.
3. **Upload the worksheet** (admin). Two columns, in this order:

   | | A | B |
   | --- | --- | --- |
   | 1 | `OLD BIN` | `NEW BIN` |
   | 2 | `A-1-1-1` | `A0101E01` |
   | 3 | `A010102` | `A0101D01` |

   Anything past column B is ignored and a header row is detected and skipped.
   `.xlsx`, `.csv`, `.tsv` or a paste all work; the file is read in the browser,
   so a bad sheet is caught before anything is stored.

   Before it loads, the map is checked against itself and will tell you about
   repeated old bins, **one new code claimed by two old bins** (the collision
   that put zone-K labels on zone-E shelves at site 18), codes that are not
   shaped like a new bin, and rows it cannot use.

4. **Scan** old label, then the label hung on it. Green is a match, red gives
   the code that should have been there, amber means that bin is not in the
   reference at all — which is not a pass, it is how site 18 lost 17 bins
   holding 1,145 units.
5. **Export.** `AUDIT - TO FIX` is the sheet to walk the floor with.

### Shelf count basis

| Basis | Effect |
| --- | --- |
| Tallest anywhere | Every column gets the same number of letters. Print extra, delete the slack in step 4. Safest. |
| Tallest per zone | Same, per zone. |
| Tallest per aisle | Same, per aisle. |
| Actual per column | Exactly what the old data shows. Smallest print run, no slack if a rack is taller than the data claims. |

`Z` is held back for floor level wherever a shelf 0 exists, so a 26-shelf
column with a floor position is capped at 25 letters plus `Z`.

---

## What gets refused

Checked in the browser for speed, then again on the server — the server is the
one that counts.

- old bin already paired, **including by another user**
- new label already used elsewhere, **including by another user**
- new label not shaped like `A0101F01` — this one cannot be switched off, on
  the client or the server, because a bad code in the cross-reference has to
  be found by hand afterwards
- old and new identical (a double-scan)

None of this applies to the Validate tab, which refuses nothing — see above.

The first two are enforced by unique constraints in Postgres, not by an
application-level check. A read-then-write would race when two people scan at
once; a constraint cannot. A violation returns `409` naming the bin and the
person who scanned it.

---

## Scanner

Any USB scanner in keyboard-wedge mode. It must send **Enter** (CR) after each
scan — most do by default. Tab works too. Test by scanning into the Old bin
field: the code should land and the cursor jump to New bin.

---

## Layout

```
src/
  app/
    page.tsx              session check, renders the desktop app
    scan/page.tsx         the same for the handheld page
    api/
      auth/{login,logout,me}
      sites                 list / create
      labels                generate + store the superset
      pairs                 record a pair, list recent, per-user counts
      pairs/[id]            undo
      users                 list / add / reset password  (admin)
      users/[id]            enable, disable, change role (admin)
      map                   upload / inspect / clear the bin map
      checks                record an audit scan, list recent, tallies
      checks/[id]           undo
      reconcile             unused / unexpected / one-for-one
      export                .xlsx workbook
  components/Station.tsx    the desktop UI
  components/MobileScan.tsx the handheld validation page
  lib/camera.ts             phone camera decoding: BarcodeDetector, else ZXing on demand
  lib/
    bins.ts                 parsing, label generation, pair validation
    auth.ts                 PBKDF2 hashing + HMAC-signed cookie
    db.ts                   lazy Neon client
    xlsx.ts                 dependency-free XLSX writer
    sheet.ts                browser-side .xlsx / .csv reader
    zpl.ts                  Zebra label generation, Code 128
    api.ts                  shared route helpers
scripts/
  migrate.mjs               schema, safe to re-run
  create-user.mjs           add or update a user
  print-server.cjs          local relay: USB or network Zebra
  build-exe.mjs             packages the relay as a standalone .exe
  test.ts                   200 logic tests, no database needed
standalone/                 the offline single-file version this grew from
```

## Schema

```
users   id, username (unique, case-insensitive), pass_hash, salt, role, active
sites   id, name (unique), status
labels  id, site_id, code, zone, aisle, col, letter    UNIQUE (site_id, code)
pairs   id, site_id, old_bin, new_bin, location, user_id, created_at
                                       UNIQUE (site_id, old_bin)
                                       UNIQUE (site_id, new_bin)
bin_map site_id, old_bin, new_bin, row_no       PRIMARY KEY (site_id, old_bin)
checks  id, site_id, source, old_bin, new_bin, expected_bin, verdict,
        user_id, created_at            UNIQUE (site_id, source, old_bin)
```

`bin_map` has no unique constraint on `new_bin` on purpose: a map that reuses a
code is a defect in the map, and refusing to load it would hide the defect
rather than report it. `checks` is unique per old bin *per source*, so
re-auditing a shelf after fixing its label replaces the old verdict, and an
audit against the uploaded map is kept separate from one against the scanned
pairs.

## Auth

Username and password, PBKDF2-SHA256 at 210k iterations, session in an
HTTP-only signed cookie lasting 12 hours (one shift). All Web Crypto, so it
runs on both Node and Edge with no dependency and no external auth service.

Two roles: `scanner` can scan, audit, and undo their own work; `admin` can also
create sites, generate label sets, load or clear the bin map, manage accounts,
and undo anyone's pair or check.

Accounts are managed from the **Admin** tab, or from the command line. They are
disabled rather than deleted, because `pairs.user_id` and `checks.user_id` point
at them and being able to say who scanned what is most of the point. The last
active admin cannot be disabled or demoted - otherwise nobody could add users or
generate labels, and the only way back would be the CLI.

```bash
npm run user -- <username> <password> [scanner|admin]
```

Re-running with an existing username resets that password.

## Environment

| Variable | Where from | Required |
| --- | --- | --- |
| `DATABASE_URL` | you, locally | only if no `*_DATABASE_URL` is present |
| `<STORE>_DATABASE_URL` | Neon integration | used automatically when `DATABASE_URL` is unset |
| `SESSION_SECRET` | you, always | yes — session cookies are unsigned without it |

## Tests

```bash
npm test
```

200 tests over bin parsing (both old formats), label generation (every basis,
floor-level `Z`, 26-letter overflow, positions within a shelf), zone ranges,
pair validation (every refusal case), bin map parsing (headers, blanks,
duplicates, collisions, malformed codes), audit verdicts, CSV/TSV input,
connection-string resolution, ZPL output (including that the dash never reaches
the barcode), and the XLSX writer — including a round trip, where a
written workbook is read back and parsed as a bin map. No database required.

Not covered: the concurrency guarantee itself, which needs a live database —
see `HANDOFF.md`.

## `standalone/`

The original single-file offline version. No server, no login, one user,
browser-local storage. Still useful where there is no network on the floor.
Open `standalone/index.html` directly.

## Limits

- 99 positions per shelf is the ceiling — the field is two digits, and a third
  would change the length of every code.
- 26 shelves per column is the ceiling — `A`–`Z` runs out. Columns exceeding it
  are flagged, never silently truncated. One column at the last site hit exactly
  26, so this is a live constraint.
- Sessions last 12 hours; a scanner mid-shift will not be logged out.
- Label generation replaces the whole set for that site, and so does a bin map
  upload.
- Old `.xls` cannot be read. Save as `.xlsx` or `.csv` first.
