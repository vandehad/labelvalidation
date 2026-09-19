import { isUniqueViolation } from './db'
import { validatePair, normalizeScan } from './bins.ts'
import { aisleWarning } from './pairguard.ts'

/**
 * Recording a pair - the one way in, for /api/pairs and the Windows Mobile
 * route alike, so the two cannot disagree about what is refused, what is
 * held for a second look, and what a conflict says.
 *
 *   refused   validatePair: format, reversed scan, same code twice, a UPC in
 *             the old field. And the database's one-for-one constraints.
 *   held      softWarnings: the labels name different aisles, or the old bin
 *             is not in the site's WMS list. Comes back `needsConfirm`; the
 *             same pair sent again with `confirmed` goes in, and the reason
 *             is kept on the row (`pairs.warned`) so the report can show who
 *             overrode what.
 */

type Sql = ReturnType<typeof import('./db').db>

export type PairRow = { id: number; old_bin: string; new_bin: string; location: string | null; created_at: string }

export type PairOutcome =
  | { ok: true; pair: PairRow; warned: string | null }
  | { ok: false; status: number; error: string; conflict?: 'old' | 'new'; needsConfirm?: boolean; warnings?: string[] }

/** Reasons to hold a pair for a second look. Empty means go ahead. */
export async function softWarnings(sql: Sql, siteId: number, oldBin: string, newBin: string): Promise<string[]> {
  const out: string[] = []
  const aisle = aisleWarning(oldBin, newBin)
  if (aisle) out.push(aisle)
  const rows = (await sql`
    SELECT EXISTS (SELECT 1 FROM old_bins WHERE site_id = ${siteId}) AS has_list,
           EXISTS (SELECT 1 FROM old_bins WHERE site_id = ${siteId} AND canon = canon_old(${oldBin})) AS listed`) as Array<{
    has_list: boolean
    listed: boolean
  }>
  if (rows[0].has_list && !rows[0].listed) out.push(`${oldBin} is not in this site's WMS bin list.`)
  return out
}

export async function recordPair(
  sql: Sql,
  siteId: number,
  user: { uid: number },
  rawOld: string,
  rawNew: string,
  opts: { location?: string | null; confirmed?: boolean } = {},
): Promise<PairOutcome> {
  // normalizeScan, not just trim: labels here encode a padded field ahead of
  // the code, so a scan arrives as `A     A0101B01`.
  const oldBin = normalizeScan(rawOld)
  const newBin = normalizeScan(rawNew)
  const why = validatePair(oldBin, newBin, { enforceFormat: true, location: null })
  if (why) return { ok: false, status: 422, error: why }

  const warnings = await softWarnings(sql, siteId, oldBin, newBin)
  if (warnings.length && !opts.confirmed) {
    // Asking someone to confirm a pair the database is about to refuse wastes
    // a scan and ends on a red screen anyway. This look is only for the
    // message - the insert below is still what enforces one-for-one.
    const taken = await clashOf(sql, siteId, oldBin, newBin)
    if (taken) return taken
    return { ok: false, status: 409, error: warnings.join(' '), needsConfirm: true, warnings }
  }
  const warned = warnings.length ? warnings.join(' ') : null

  try {
    const rows = (await sql`
      INSERT INTO pairs (site_id, old_bin, new_bin, location, user_id, warned)
      VALUES (${siteId}, ${oldBin}, ${newBin}, ${opts.location ?? null}, ${user.uid}, ${warned})
      RETURNING id, old_bin, new_bin, location, created_at`) as PairRow[]
    return { ok: true, pair: rows[0], warned }
  } catch (e) {
    // Left to the database rather than a read-then-write: with several people
    // scanning at once a check-first approach races between check and insert.
    if (!isUniqueViolation(e)) throw e
    const which = e.constraint === 'pairs_new_unique' ? 'new' : 'old'
    return (
      (await clashOf(sql, siteId, oldBin, newBin, which)) ?? {
        ok: false,
        status: 409,
        error: `That ${which} bin is already recorded.`,
        conflict: which,
      }
    )
  }
}

/** Who already holds the new label, or what the old bin is already paired to - in words. */
async function clashOf(
  sql: Sql,
  siteId: number,
  oldBin: string,
  newBin: string,
  only?: 'old' | 'new',
): Promise<Extract<PairOutcome, { ok: false }> | null> {
  const rows = (await sql`
    SELECT p.old_bin, p.new_bin, u.username FROM pairs p LEFT JOIN users u ON u.id = p.user_id
    WHERE p.site_id = ${siteId} AND (p.new_bin = ${newBin} OR p.old_bin = ${oldBin})`) as Array<{
    old_bin: string
    new_bin: string
    username: string | null
  }>
  const byNew = rows.find(r => r.new_bin === newBin)
  const byOld = rows.find(r => r.old_bin === oldBin)
  const who = (r: { username: string | null }) => (r.username ? ` (scanned by ${r.username})` : '')
  if (byNew && only !== 'old')
    return { ok: false, status: 409, error: `${newBin} is already used by ${byNew.old_bin}${who(byNew)}.`, conflict: 'new' }
  if (byOld && only !== 'new')
    return { ok: false, status: 409, error: `${oldBin} is already paired to ${byOld.new_bin}${who(byOld)}.`, conflict: 'old' }
  return null
}
