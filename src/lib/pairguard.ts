import { splitNew, parseOld } from './bins.ts'
import { canonOld } from './oldbins.ts'

/**
 * Guards that compare the two scans of a pair to each other.
 *
 * Not the zone/aisle check that was built and removed - that one compared a
 * scan to where the scanner *said* they were standing, and mostly refused
 * correct work. These compare the old label to the new label, which are both
 * in the associate's hands at that moment, and they are soft: the pair is
 * held, the screen says why, and scanning the same new label a second time
 * keeps it. Site 7 showed what they are for - 102 pairs hung down the wrong
 * aisles by one person in half an hour, found days later in a report.
 *
 * Only the aisle is compared. Zone letters are a per-site mapping (site 15
 * folds several WMS zones into one letter) and columns legitimately run
 * backwards in whole zones, but across 17,000 pairs at site 7 the aisle
 * carried over unchanged in all but a handful - every one of them a mistake.
 *
 * A UPC in the old field is not soft: see `looksLikeUpc` in bins.ts, which
 * `validatePair` refuses outright on every screen.
 */

/** The aisle an old bin id names, in any of the forms the WMS writes. */
export function oldAisle(raw: string): number | null {
  const c = canonOld(raw)
  const m = /^\d+-(\d+)-\d+-\d+$/.exec(c)
  if (m) return Number(m[1])
  // Undashed with a one-digit zone: 7421915 is 7-42-19-15 (site 15).
  if (/^\d{7}$/.test(c)) return Number(c.slice(1, 3))
  const p = parseOld(c)
  return p ? p.aisle : null
}

/** Words for the screen when the two labels name different aisles, else null. */
export function aisleWarning(oldBin: string, newBin: string): string | null {
  const from = oldAisle(oldBin)
  const to = splitNew(newBin)?.aisle
  if (from === null || to === undefined || from === to) return null
  return `Old bin ${oldBin} is aisle ${from}, but label ${newBin} is aisle ${to}.`
}

/** What a client appends to a held pair's warning, so every screen says it the same way. */
export const CONFIRM_HINT = 'Scan the SAME new label again to keep this pair, or scan the right label.'
