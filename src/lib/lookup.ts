import { normalizeScan, NEW_PATTERN, splitNew } from './bins.ts'

/**
 * What a scanned or typed bin refers to, for a reprint.
 *
 * Someone in an aisle has either the new label in front of them or the old
 * bin id in their head. Either way the answer is the new code, whether the
 * site holds a label for it, and - for a new-format code it does not hold -
 * the code's parts, so Add-a-bin can open with the shelf already picked. A
 * code the site does not hold is not refused here: the usual reason is a
 * shelf that was never in the plan, and the fix is to add it.
 */

type Sql = ReturnType<typeof import('./db').db>

export type Resolved = {
  kind: 'new' | 'old'
  /** The new code, or null for an old bin nothing has been paired to. */
  code: string | null
  /** Whether `code` is in the site's label set - the only thing the queue will print. */
  stored: boolean
  oldBin: string | null
  parts: { zone: string; aisle: number; col: number; letter: string } | null
}

const partsOf = (code: string) => {
  const p = splitNew(code)
  return p ? { zone: p.zone, aisle: p.aisle, col: p.col, letter: p.letter } : null
}

export async function resolveLabel(sql: Sql, siteId: number, raw: string): Promise<Resolved> {
  const scanned = normalizeScan(raw)

  if (NEW_PATTERN.test(scanned)) {
    const [stored, pair] = await Promise.all([
      sql`SELECT 1 FROM labels WHERE site_id = ${siteId} AND code = ${scanned} LIMIT 1`,
      sql`SELECT old_bin FROM pairs WHERE site_id = ${siteId} AND new_bin = ${scanned} LIMIT 1`,
    ])
    return {
      kind: 'new',
      code: scanned,
      stored: stored.length > 0,
      oldBin: (pair[0] as { old_bin: string } | undefined)?.old_bin ?? null,
      parts: partsOf(scanned),
    }
  }

  // An old bin: the pair says which new label hangs there now.
  const pair = (await sql`
    SELECT new_bin FROM pairs WHERE site_id = ${siteId} AND old_bin = ${scanned} LIMIT 1`) as Array<{ new_bin: string }>
  const code = pair[0]?.new_bin ?? null
  if (!code) return { kind: 'old', code: null, stored: false, oldBin: scanned, parts: null }
  const stored = await sql`SELECT 1 FROM labels WHERE site_id = ${siteId} AND code = ${code} LIMIT 1`
  return { kind: 'old', code, stored: stored.length > 0, oldBin: scanned, parts: partsOf(code) }
}
