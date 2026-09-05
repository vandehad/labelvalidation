import { isUniqueViolation } from './db'
import { newCode, NEW_PATTERN, mintedOldBin } from './bins.ts'

/**
 * Adding a bin that was never in the plan - the rules, once.
 *
 * Two routes need this: the modern UI and the Windows Mobile page, which
 * cannot share a component but must share the behaviour. Minting is the one
 * place in the app that *creates* a bin code rather than reading one, so the
 * guarantees live here rather than in either screen:
 *
 *   - the code is assembled from choices, never parsed from typed input
 *   - the choices come from the site's own label set, so a minted bin cannot
 *     land in a zone or aisle the warehouse does not have
 *   - the placeholder old bin comes from a sequence, so twenty people minting
 *     at once cannot be handed the same one
 */

type Sql = ReturnType<typeof import('./db').db>

export type MintOptions =
  | { level: 'zone'; zones: string[] }
  | { level: 'aisle'; aisles: number[] }
  | { level: 'col'; columns: number[] }
  | { level: 'shelf'; taken: string[]; letters: string[] }

/**
 * One level of the picker at a time. The whole tree is 20,000-odd entries on a
 * real site and the picker only ever needs the next step.
 */
export async function mintOptions(
  sql: Sql,
  siteId: number,
  zone?: string,
  aisle?: number | null,
  col?: number | null,
): Promise<MintOptions> {
  if (!zone) {
    const rows = (await sql`
      SELECT DISTINCT zone FROM labels WHERE site_id = ${siteId} ORDER BY zone`) as Array<{ zone: string }>
    return { level: 'zone', zones: rows.map(r => r.zone) }
  }
  if (aisle === null || aisle === undefined) {
    const rows = (await sql`
      SELECT DISTINCT aisle FROM labels WHERE site_id = ${siteId} AND zone = ${zone}
      ORDER BY aisle`) as Array<{ aisle: number }>
    return { level: 'aisle', aisles: rows.map(r => r.aisle) }
  }
  if (col === null || col === undefined) {
    const rows = (await sql`
      SELECT DISTINCT col FROM labels WHERE site_id = ${siteId} AND zone = ${zone} AND aisle = ${aisle}
      ORDER BY col`) as Array<{ col: number }>
    return { level: 'col', columns: rows.map(r => r.col) }
  }
  const rows = (await sql`
    SELECT code, letter FROM labels
    WHERE site_id = ${siteId} AND zone = ${zone} AND aisle = ${aisle} AND col = ${col}
    ORDER BY code`) as Array<{ code: string; letter: string }>
  return { level: 'shelf', taken: rows.map(r => r.code), letters: [...new Set(rows.map(r => r.letter))] }
}

export type MintPick = { zone: string; aisle: number; col: number; letter: string; position: number }

/** A refusal a caller should show, rather than an error it should log. */
export class MintRefused extends Error {
  status: number
  constructor(msg: string, status = 400) {
    super(msg)
    this.status = status
  }
}

export function checkPick(p: Partial<MintPick>): MintPick {
  const zone = String(p.zone ?? '').trim().toUpperCase()
  const letter = String(p.letter ?? '').trim().toUpperCase()
  const aisle = Number(p.aisle)
  const col = Number(p.col)
  const position = Number(p.position ?? 1)
  if (!/^[A-Z]$/.test(zone)) throw new MintRefused('Pick a zone.')
  if (!/^[A-Z]$/.test(letter)) throw new MintRefused('Pick a shelf.')
  if (!Number.isInteger(aisle) || aisle < 0 || aisle > 99) throw new MintRefused('Aisle must be 0-99.')
  if (!Number.isInteger(col) || col < 0 || col > 99) throw new MintRefused('Column must be 0-99.')
  if (!Number.isInteger(position) || position < 1 || position > 99) throw new MintRefused('Position must be 1-99.')
  return { zone, aisle, col, letter, position }
}

/**
 * Create the bin. Returns the code and the placeholder that keeps it in
 * `pairs` - without which reconcile would list a freshly hung shelf under
 * "unused, delete these".
 */
export async function mintBin(
  sql: Sql,
  siteId: number,
  userId: number,
  pick: MintPick,
): Promise<{ code: string; oldBin: string; pairId: number }> {
  const { zone, aisle, col, letter, position } = pick
  const code = newCode(zone, aisle, col, letter, position)
  // The pickers cannot produce a bad code, but neither route is the only way
  // in - the HTTP endpoints are reachable directly.
  if (!NEW_PATTERN.test(code)) throw new MintRefused(`${code} is not a valid bin code.`, 422)

  // A sequence, not a count: with several people minting at once a max()+1
  // hands two shelves the same placeholder. Tagged template because the driver
  // has been tagged-template only since v1.
  const seq = (await sql`SELECT nextval('minted_bin_seq')::int AS n`) as Array<{ n: number }>
  const oldBin = mintedOldBin(seq[0].n)

  try {
    await sql`
      INSERT INTO labels (site_id, code, zone, aisle, col, letter, origin, minted_by)
      VALUES (${siteId}, ${code}, ${zone}, ${aisle}, ${col}, ${letter}, 'minted', ${userId})`
  } catch (e) {
    if (isUniqueViolation(e))
      throw new MintRefused(
        `${code} is already in this site's label set - print and hang that one rather than adding it again.`,
        409,
      )
    throw e
  }

  const rows = (await sql`
    INSERT INTO pairs (site_id, old_bin, new_bin, location, user_id, origin)
    VALUES (${siteId}, ${oldBin}, ${code}, 'minted', ${userId}, 'minted')
    RETURNING id`) as Array<{ id: number }>

  return { code, oldBin, pairId: rows[0].id }
}
