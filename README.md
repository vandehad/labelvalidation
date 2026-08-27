# Label Validation

Bin label conversion for warehouse re-slotting. Scan the old bin, scan the new
label, and the pairing is recorded with a **one-for-one guarantee enforced by the
database** — several people can scan different aisles at the same time without
any chance of two shelves ending up on one code.

Converts old `Zone-Aisle-Column-Shelf` bins to the new
`{Zone}{aisle:2}{column:2}{letter}01` format.

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

`DATABASE_URL` is injected by the Neon Marketplace integration. `SESSION_SECRET`
is the only variable you set by hand. Nothing else is required — no
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
- new label from a different zone/aisle/column than the location you set
- new label not matching `Z##/##/L/##`
- old and new identical (a double-scan)

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
    page.tsx              session check, renders the client app
    api/
      auth/{login,logout,me}
      sites                 list / create
      labels                generate + store the superset
      pairs                 record a pair, list recent, per-user counts
      pairs/[id]            undo
      reconcile             unused / unexpected / one-for-one
      export                .xlsx workbook
  components/Station.tsx    the whole UI
  lib/
    bins.ts                 parsing, label generation, pair validation
    auth.ts                 PBKDF2 hashing + HMAC-signed cookie
    db.ts                   lazy Neon client
    xlsx.ts                 dependency-free XLSX writer
    api.ts                  shared route helpers
scripts/
  migrate.mjs               schema, safe to re-run
  create-user.mjs           add or update a user
  test.ts                   37 logic tests, no database needed
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
```

## Auth

Username and password, PBKDF2-SHA256 at 210k iterations, session in an
HTTP-only signed cookie lasting 12 hours (one shift). All Web Crypto, so it
runs on both Node and Edge with no dependency and no external auth service.

Two roles: `scanner` can scan and undo their own pairs; `admin` can also create
sites, generate label sets, and undo anyone's pair.

```bash
npm run user -- <username> <password> [scanner|admin]
```

Re-running with an existing username resets that password.

## Tests

```bash
npm test
```

37 tests over bin parsing (both old formats), label generation (every basis,
floor-level `Z`, 26-letter overflow), pair validation (every refusal case), and
the XLSX writer. No database required.

Not covered: the concurrency guarantee itself, which needs a live database —
see `HANDOFF.md`.

## `standalone/`

The original single-file offline version. No server, no login, one user,
browser-local storage. Still useful where there is no network on the floor.
Open `standalone/index.html` directly.

## Limits

- 26 shelves per column is the ceiling — `A`–`Z` runs out. Columns exceeding it
  are flagged, never silently truncated. One column at the last site hit exactly
  26, so this is a live constraint.
- Sessions last 12 hours; a scanner mid-shift will not be logged out.
- Label generation replaces the whole set for that site.
