# Roadmap

A review of the app against the job it actually has to do: relabel a warehouse
end to end, with twenty people capturing at once on a mix of laptops and TC52s.

Written after reading the whole codebase. What follows is ordered by how much
damage the gap can do, not by how hard it is to build.

---

## The job, in six phases

| | Phase | Where it stands |
| --- | --- | --- |
| 1 | **Survey** — walk the aisles, record what is physically there | **nothing.** Zone blocks are typed in from memory |
| 2 | **Design** — settle the schema, generate the superset | good: zone blocks, per-block shape, collisions reported |
| 3 | **Print** — batch, by zone, by range, one-off reprints | good, and proven on real hardware |
| 4 | **Hang** — put labels on shelves | **nothing.** No idea what has been hung |
| 5 | **Capture** — scan old, scan new, one-for-one | good, and now refuses reversed scans |
| 6 | **Export** — cross-reference, reconcile, sign-off | good except sign-off |

Phases 1 and 4 are missing entirely, and they are the two that decide whether
phase 6 can be trusted. Everything below is in that light.

---

## What is already right, and should not be disturbed

- **One-for-one is a property of Postgres**, not of application code.
  `pairs_old_unique` and `pairs_new_unique` make a duplicate on either side
  impossible with twenty people scanning. A read-then-write would race here;
  a constraint cannot.
- **The format gates run twice** - in the browser for speed, on the server for
  truth - and the client cannot switch either off.
- **The superset is generated, never derived per bin.** Deriving the shelf
  letter from old data is what produced 364 bad codes at site 18.
- **A reprint comes out of what is stored.** A code the site has no record of
  is reported, never printed.

---

## 1. Capture has to survive a dead spot  *(highest risk)*

A TC52 in a warehouse aisle will lose WiFi. Today a failed POST is a **lost
scan** - the pair is gone, the picker has already moved on, and nothing says
so. Over a shift of twenty people this is the most likely source of missing
rows in the final cross-reference, and it is invisible until reconcile.

**What to build.** Queue every scan in IndexedDB before sending. Show a
pending count in the header. Drain the queue in the background whenever the
network returns. On replay, a `409` is not an error - it means that pair
already landed, and the queued copy should be dropped quietly.

This changes the failure mode from *silent data loss* to *delayed write*,
which is the difference between a usable tool and one people stop trusting.

---

## 2. Nobody knows which aisles are done

Twenty people need to divide the floor without colliding, and a supervisor
needs to know what is left. Right now the only progress signal is a total
count and a per-user tally.

**What to build.**

- **Aisle claim.** A scanner picks an aisle; it shows as taken, with their
  name, until they release it. Not a lock - two people in one aisle is wasted
  effort rather than corruption, since the constraints already prevent double
  writes - but it stops the waste.
- **Progress by aisle.** For each zone/aisle: labels generated, pairs
  captured, percent done. That is one `GROUP BY` over `labels` and `pairs`,
  and it turns "are we nearly finished" into a number.
- **A floor view** for whoever is running the job: aisles down the side,
  who is in each, how far along.

---

## 3. Adding a bin that was never in the plan

A shelf turns up with no old label - an unassigned, zero-inventory bin. It
needs a new code, a printed label, and someone to come back and hang it.

**The data model matters more than the screen here.** A minted bin has no old
counterpart, so left alone it looks exactly like a label nobody paired - and
reconcile would list it under *unused, delete these*. That is precisely
backwards: it is a bin being **added**, and deleting it at the end of the
conversion is how a freshly hung shelf becomes a bin the WMS cannot find.

**It gets a placeholder old bin and stays in `pairs`.** A row with a partner
is not an orphan, so every existing rule keeps working unchanged: the unique
constraints still guarantee one-for-one, reconcile still sees a paired label,
and the export still carries it. No second state machine.

```
old_bin              new_bin
NEW-000117           M0501B01
```

Three things make it safe rather than a magic string:

- **A column, not a prefix.** `pairs.origin` (`scanned` | `minted`) is what
  every query branches on. Nothing should parse `NEW-` out of `old_bin` to
  decide what a row means - that is the kind of convention someone breaks by
  typing it into a scan field, and then a real pairing is treated as minted.
  The placeholder is for a human reading the sheet; the column is for code.
- **A Postgres sequence for the number.** With twenty people minting, a
  `SELECT max(...) + 1` races and hands two shelves the same placeholder.
  `nextval` cannot.
- **A shape that cannot collide.** `NEW-000117` matches neither `parseOld`
  nor `NEW_PATTERN`, so it can never be mistaken for a real old bin, and
  `reversedScan` will not trip over it.

```sql
CREATE SEQUENCE IF NOT EXISTS minted_bin_seq;
ALTER TABLE pairs  ADD COLUMN origin     text NOT NULL DEFAULT 'scanned';
                                          -- scanned | minted
ALTER TABLE labels ADD COLUMN origin     text NOT NULL DEFAULT 'generated';
                                          -- generated | minted
ALTER TABLE labels ADD COLUMN printed_at timestamptz;
ALTER TABLE labels ADD COLUMN hung_at    timestamptz;
ALTER TABLE labels ADD COLUMN minted_by  integer REFERENCES users(id);
```

**In the export**, minted rows sort to the bottom of `CROSS REFERENCE` and
also get their own `NEW BINS` sheet. Both, deliberately: the cross-reference
is the complete picture, and the separate sheet is what someone hands the WMS
team, because a rename instruction whose *from* side does not exist is not a
rename - it is a bin to create. Those are different jobs and they should not
arrive mixed together.

Reconcile then reads:

| state | meaning |
| --- | --- |
| generated, no pair | printed too many - delete from the WMS |
| minted, not hung | waiting for someone to hang it |
| minted, hung, no pair | hung, needs pairing |
| any, paired | done - including minted, which must **not** be deleted |

**The code is chosen, never typed.** Zone, aisle, column, shelf letter and
position each come from a picker driven by the site's own zone blocks - so
zone A only offers its aisles, and an aisle only offers its column count. The
app assembles `M0501B01` from the choices and the operator never touches a
keyboard. That is the only way to guarantee the code is well-formed *and*
inside the warehouse that was designed, and it means a minted code cannot
collide with the superset by accident.

Then: check it against `labels`, refuse it if taken, insert it as `minted`,
and offer **Print now** straight to the relay. Someone hangs it later and it
gets paired like any other bin.

---

## 4. Survey mode - phase 1

Before any of this, someone has to establish what the warehouse actually
contains. Today that knowledge goes into the block editor by hand.

**What to build.** A handheld mode that walks an aisle and records: zone,
aisle, how many columns, how many shelves per column, whether there is a floor
position. It writes straight into the zone blocks, so design is a review of
what was surveyed rather than a guess.

Worth having even when the WMS can supply an old bin list, because the list
describes what the WMS *believes* - and at site 18 that belief was wrong 364
times.

---

## 5. The admin console / capture route split

The app is one page with five tabs, and a scanner on a laptop sees all of it -
including label generation, which replaces the whole set for a site.

```
/admin     sites, zone blocks, generation, printing, users, exports
/capture   laptop: scan old -> scan new, and nothing else
/scan      handheld: the same, sized for a TC52   (exists)
```

Three benefits beyond tidiness: a scanner cannot reach a destructive action; a
laptop capture screen can be as focused as the handheld one; and the admin
surface can grow - survey review, floor view, sign-off - without making the
capture screen worse.

---

## 6. Smaller things, roughly in order

- **Split the poll.** Every client fetches 200 pairs every 10 seconds. Twenty
  clients is 2 requests/second each returning rows nobody looks at. Counts and
  the recent list should be separate calls, with the list on demand.
- **Print state.** Nothing records that a label was printed. `printed_at`
  makes a reprint deliberate rather than a guess, and makes "did that aisle
  ever get printed" answerable.
- **Sign-off.** A site should be closeable: reconcile clean, one-for-one
  confirmed, exported, locked against further writes. Without it there is no
  moment where the job is *done*.
- **Session resume on the handheld.** Site and reference already persist;
  the pending queue should too.
- **Rate limit the login** if this is ever reachable off the warehouse network.
- **`^PW` in every ZPL job.** Proven necessary on the ZQ630, which cannot
  hold a print width across a power cycle by any of five methods tried.

---

## The schema itself

```
{Zone}{aisle:02}{column:02}{letter}{position:02}      M0501B01
```

Capacity is not the constraint - 26 zones x 99 aisles x 99 columns x 26
shelves x 99 positions is far beyond any warehouse. Two limits are real:

- **26 shelves per column.** The alphabet runs out. Already capped and
  reported rather than silently truncated, and one column at site 18 hit
  exactly 26 - so this is a live edge, not a theoretical one.
- **99 aisles and 99 columns.** Two digits each. A third would change the
  length of every code in the system, so it is not a small change later.

`Z` is held back for floor level wherever shelf 0 exists.

The barcode carries a six-character zone field before the code -
`M     M0501B01` - matching the labels already hung. The printed line carries
the dashed form, `M05-01B01`, and the dash is never encoded.

---

## Suggested order

1. Offline queue (capture cannot lose data)
2. Aisle progress and claims (twenty people need to divide the floor)
3. Mint-a-bin with picker-driven codes, plus the `labels` columns above
4. Admin / capture route split
5. Survey mode
6. Sign-off and the smaller items
