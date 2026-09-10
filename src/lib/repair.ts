import { validatePair, normalizeScan, NEW_PATTERN } from './bins.ts'

/**
 * Repair: a pair scanned wrong, put right.
 *
 * Someone realises they scanned a shelf offset - old A was paired to the
 * label meant for the shelf beside it. Normal pairing cannot fix that: the
 * old bin is already paired, the label is already used, and both refusals
 * are correct. Repair is the explicit override: whatever either the old bin
 * or the new label was paired to is removed, and the pair as scanned goes
 * in, in one transaction. The unique constraints still hold - this is not a
 * read-then-write around them, it is a delete and an insert inside them.
 *
 * It reports what it displaced, because a wrong pair usually took a
 * neighbour's label: that neighbour is now unpaired and has to be re-scanned.
 */

type Sql = ReturnType<typeof import('./db').db>

export type Replaced = { old_bin: string; new_bin: string }

export class RepairRefused extends Error {
  status: number
  constructor(msg: string, status = 422) {
    super(msg)
    this.status = status
  }
}

export async function repairPair(
  sql: Sql,
  siteId: number,
  userId: number,
  rawOld: string,
  rawNew: string,
  location = 'repaired',
): Promise<{ pair: { id: number; old_bin: string; new_bin: string; location: string; created_at: string }; replaced: Replaced[] }> {
  const o = normalizeScan(rawOld)
  const n = normalizeScan(rawNew)
  // The same gates as pairing: format, reversed scan, same code twice. Repair
  // overrides what a shelf is paired to, never what a valid code is.
  const why = validatePair(o, n, { enforceFormat: true, location: null })
  if (why) throw new RepairRefused(why)

  const [removed, inserted] = (await sql.transaction([
    sql`DELETE FROM pairs WHERE site_id = ${siteId} AND (old_bin = ${o} OR new_bin = ${n}) RETURNING old_bin, new_bin`,
    sql`INSERT INTO pairs (site_id, old_bin, new_bin, location, user_id)
        VALUES (${siteId}, ${o}, ${n}, ${location}, ${userId})
        RETURNING id, old_bin, new_bin, location, created_at`,
  ])) as [Replaced[], Array<{ id: number; old_bin: string; new_bin: string; location: string; created_at: string }>]

  return { pair: inserted[0], replaced: removed }
}

/** One line for a verdict: what a repair displaced. */
export function describeReplaced(replaced: Replaced[]): string {
  if (!replaced.length) return 'Nothing was paired to either before.'
  const list = replaced.map(r => `${r.old_bin} → ${r.new_bin}`).join(', ')
  return `Replaced ${list}. ${replaced.length === 1 ? 'That old bin is' : 'Those old bins are'} now unpaired - re-scan ${replaced.length === 1 ? 'it' : 'them'} if the shelf still exists.`
}

/**
 * Unpair: scan a label or an old bin and its pair is removed, freeing both
 * sides to be scanned again as normal. The other way to put an offset run
 * right: unpair the run, then pair it again from the start.
 */
export async function unpair(sql: Sql, siteId: number, raw: string): Promise<Replaced | null> {
  const bin = normalizeScan(raw)
  if (!bin) return null
  const rows = (await (NEW_PATTERN.test(bin)
    ? sql`DELETE FROM pairs WHERE site_id = ${siteId} AND new_bin = ${bin} RETURNING old_bin, new_bin`
    : sql`DELETE FROM pairs WHERE site_id = ${siteId} AND old_bin = ${bin} RETURNING old_bin, new_bin`)) as Replaced[]
  return rows[0] ?? null
}
