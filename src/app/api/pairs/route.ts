import { db, isUniqueViolation } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { validatePair } from '@/lib/bins'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Recent pairs for a site, plus per-user counts so the floor can see progress. */
export async function GET(req: Request) {
  try {
    await requireUser()
    const { searchParams } = new URL(req.url)
    const siteId = Number(searchParams.get('site'))
    if (!siteId) return json({ error: 'site is required' }, 400)
    const limit = Math.min(Number(searchParams.get('limit') ?? 200), 1000)
    const sql = db()

    const [pairs, totals, byUser] = await Promise.all([
      sql`SELECT p.id, p.old_bin, p.new_bin, p.location, p.created_at, u.username
          FROM pairs p LEFT JOIN users u ON u.id = p.user_id
          WHERE p.site_id = ${siteId}
          ORDER BY p.id DESC LIMIT ${limit}`,
      sql`SELECT
            (SELECT count(*)::int FROM pairs  WHERE site_id = ${siteId}) AS pairs,
            (SELECT count(*)::int FROM labels WHERE site_id = ${siteId}) AS labels`,
      sql`SELECT COALESCE(u.username,'?') AS username, count(*)::int AS n
          FROM pairs p LEFT JOIN users u ON u.id = p.user_id
          WHERE p.site_id = ${siteId} GROUP BY 1 ORDER BY n DESC`,
    ])
    return json({ pairs, totals: totals[0], byUser })
  } catch (e) {
    return fail(e)
  }
}

/**
 * Record one pair.
 *
 * The new-bin format is a hard gate here and not a preference: a
 * cross-reference is only worth anything if every code in it is a real code,
 * and a mis-scan that lands in this table has to be hunted down by hand later.
 * The client cannot turn it off - `enforceFormat` is accepted for the location
 * check only.
 *
 * The uniqueness checks are left to the database rather than a read-then-write
 * in application code: with several people scanning at once, a check-first
 * approach has a race between the check and the insert. A unique violation
 * comes back as 409 with the row that already owns the code.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = (await req.json()) as {
      siteId?: number
      oldBin?: string
      newBin?: string
      location?: string | null
      loc?: { zone: string; aisle: number; col: number | null } | null
    }
    const siteId = Number(body.siteId)
    const oldBin = String(body.oldBin ?? '').trim().toUpperCase()
    const newBin = String(body.newBin ?? '').trim().toUpperCase()
    if (!siteId) return json({ error: 'site is required' }, 400)

    const why = validatePair(oldBin, newBin, {
      enforceFormat: true,
      location: body.loc ?? null,
    })
    if (why) return json({ error: why }, 422)

    const sql = db()
    try {
      const rows = (await sql`
        INSERT INTO pairs (site_id, old_bin, new_bin, location, user_id)
        VALUES (${siteId}, ${oldBin}, ${newBin}, ${body.location ?? null}, ${user.uid})
        RETURNING id, old_bin, new_bin, location, created_at
      `) as Array<Record<string, unknown>>
      return json({ pair: { ...rows[0], username: user.name } }, 201)
    } catch (e) {
      if (isUniqueViolation(e)) {
        const which = e.constraint === 'pairs_new_unique' ? 'new' : 'old'
        const clash = (await (which === 'new'
          ? sql`SELECT p.old_bin, p.new_bin, u.username
                FROM pairs p LEFT JOIN users u ON u.id = p.user_id
                WHERE p.site_id = ${siteId} AND p.new_bin = ${newBin} LIMIT 1`
          : sql`SELECT p.old_bin, p.new_bin, u.username
                FROM pairs p LEFT JOIN users u ON u.id = p.user_id
                WHERE p.site_id = ${siteId} AND p.old_bin = ${oldBin} LIMIT 1`)) as Array<{
          old_bin: string
          new_bin: string
          username: string | null
        }>
        const c = clash[0]
        const msg = c
          ? which === 'new'
            ? `${newBin} is already used by ${c.old_bin}${c.username ? ` (scanned by ${c.username})` : ''}.`
            : `${oldBin} is already paired to ${c.new_bin}${c.username ? ` (scanned by ${c.username})` : ''}.`
          : `That ${which} bin is already recorded.`
        return json({ error: msg, conflict: which }, 409)
      }
      throw e
    }
  } catch (e) {
    return fail(e)
  }
}
