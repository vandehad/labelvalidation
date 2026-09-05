import { db, isUniqueViolation } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { newCode, NEW_PATTERN, mintedOldBin } from '@/lib/bins'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Adding a bin that was never in the plan.
 *
 * A shelf turns up with no old label - unassigned, zero inventory. It needs a
 * code, a printed label, and somebody to come back and hang it.
 *
 * The code is never typed. GET walks the site's own label set one level at a
 * time - zones, then that zone's aisles, then that aisle's columns, then the
 * shelf letters already used - so the picker can only offer locations the
 * warehouse actually has. POST assembles the code from those choices, which is
 * the only way to be sure it is both well-formed and inside the site that was
 * designed.
 *
 * A minted bin is stored with a placeholder old bin so it stays in `pairs`.
 * That keeps every existing rule working: the unique constraints still make it
 * one-for-one, and reconcile sees a paired label rather than an orphan it
 * would tell someone to delete.
 */

export async function GET(req: Request) {
  try {
    await requireUser()
    const q = new URL(req.url).searchParams
    const siteId = Number(q.get('site'))
    if (!siteId) return json({ error: 'site is required' }, 400)
    const zone = (q.get('zone') ?? '').toUpperCase()
    const aisle = q.get('aisle') === null ? null : Number(q.get('aisle'))
    const col = q.get('col') === null ? null : Number(q.get('col'))
    const sql = db()

    // One level per call. The whole tree would be 20,000-odd entries on a real
    // site, and the picker only ever needs the next step.
    if (!zone) {
      const rows = (await sql`
        SELECT DISTINCT zone FROM labels WHERE site_id = ${siteId} ORDER BY zone`) as Array<{ zone: string }>
      return json({ level: 'zone', zones: rows.map(r => r.zone) })
    }
    if (aisle === null) {
      const rows = (await sql`
        SELECT DISTINCT aisle FROM labels WHERE site_id = ${siteId} AND zone = ${zone}
        ORDER BY aisle`) as Array<{ aisle: number }>
      return json({ level: 'aisle', aisles: rows.map(r => r.aisle) })
    }
    if (col === null) {
      const rows = (await sql`
        SELECT DISTINCT col FROM labels WHERE site_id = ${siteId} AND zone = ${zone} AND aisle = ${aisle}
        ORDER BY col`) as Array<{ col: number }>
      return json({ level: 'col', columns: rows.map(r => r.col) })
    }

    // Which shelf/position codes this column already holds, so the picker can
    // grey them out rather than letting someone choose a collision.
    const rows = (await sql`
      SELECT code, letter FROM labels
      WHERE site_id = ${siteId} AND zone = ${zone} AND aisle = ${aisle} AND col = ${col}
      ORDER BY code`) as Array<{ code: string; letter: string }>
    return json({ level: 'shelf', taken: rows.map(r => r.code), letters: [...new Set(rows.map(r => r.letter))] })
  } catch (e) {
    return fail(e)
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = (await req.json()) as {
      siteId?: number
      zone?: string
      aisle?: number
      col?: number
      letter?: string
      position?: number
    }
    const siteId = Number(body.siteId)
    const zone = String(body.zone ?? '').trim().toUpperCase()
    const aisle = Number(body.aisle)
    const col = Number(body.col)
    const letter = String(body.letter ?? '').trim().toUpperCase()
    const position = Number(body.position ?? 1)

    if (!siteId) return json({ error: 'site is required' }, 400)
    if (!/^[A-Z]$/.test(zone)) return json({ error: 'Pick a zone.' }, 400)
    if (!/^[A-Z]$/.test(letter)) return json({ error: 'Pick a shelf.' }, 400)
    if (!Number.isInteger(aisle) || aisle < 0 || aisle > 99) return json({ error: 'Aisle must be 0-99.' }, 400)
    if (!Number.isInteger(col) || col < 0 || col > 99) return json({ error: 'Column must be 0-99.' }, 400)
    if (!Number.isInteger(position) || position < 1 || position > 99)
      return json({ error: 'Position must be 1-99.' }, 400)

    const code = newCode(zone, aisle, col, letter, position)
    // Belt and braces: the pickers cannot produce a bad code, but this route
    // is reachable without them.
    if (!NEW_PATTERN.test(code)) return json({ error: `${code} is not a valid bin code.` }, 422)

    const sql = db()

    // The sequence, not a count: with several people minting at once a
    // max()+1 hands two shelves the same placeholder.
    // Tagged template, not sql(...): the driver has been tagged-template
    // only since v1 and throws on a plain string - the same fault that
    // stopped migrate.mjs before it reached Postgres. No interpolation
    // here, so a bare template is the simplest thing that works.
    const seq = (await sql`SELECT nextval('minted_bin_seq')::int AS n`) as Array<{ n: number }>
    const oldBin = mintedOldBin(seq[0].n)

    try {
      await sql`
        INSERT INTO labels (site_id, code, zone, aisle, col, letter, origin, minted_by)
        VALUES (${siteId}, ${code}, ${zone}, ${aisle}, ${col}, ${letter}, 'minted', ${user.uid})`
    } catch (e) {
      if (isUniqueViolation(e))
        return json(
          { error: `${code} is already in this site's label set - print and hang that one rather than adding it again.` },
          409,
        )
      throw e
    }

    const rows = (await sql`
      INSERT INTO pairs (site_id, old_bin, new_bin, location, user_id, origin)
      VALUES (${siteId}, ${oldBin}, ${code}, ${'minted'}, ${user.uid}, 'minted')
      RETURNING id, old_bin, new_bin, created_at`) as Array<Record<string, unknown>>

    return json({ pair: { ...rows[0], username: user.name }, code, oldBin }, 201)
  } catch (e) {
    return fail(e)
  }
}
