import { db } from '@/lib/db'
import { requireUser, requireAdmin } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { parseMapTable } from '@/lib/bins'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * The uploaded bin map: column A is the old bin, column B is the new one.
 *
 * This is reference data to audit against, never a source of truth. It is
 * stored separately from `pairs` for exactly that reason - a scanned pair is
 * something two people watched happen, an uploaded row is a vendor's claim.
 */

/** What is loaded for this site, and anything about it worth distrusting. */
export async function GET(req: Request) {
  try {
    await requireUser()
    const siteId = Number(new URL(req.url).searchParams.get('site'))
    if (!siteId) return json({ error: 'site is required' }, 400)
    const sql = db()

    const [counts, dupNew, sample] = await Promise.all([
      sql`SELECT count(*)::int AS rows FROM bin_map WHERE site_id = ${siteId}`,
      sql`SELECT new_bin, array_agg(old_bin ORDER BY old_bin) AS old_bins
          FROM bin_map WHERE site_id = ${siteId}
          GROUP BY new_bin HAVING count(*) > 1
          ORDER BY new_bin LIMIT 200`,
      sql`SELECT old_bin, new_bin FROM bin_map WHERE site_id = ${siteId}
          ORDER BY row_no NULLS LAST, old_bin LIMIT 10`,
    ])
    return json({ rows: (counts[0] as { rows: number }).rows, dupNew, sample })
  } catch (e) {
    return fail(e)
  }
}

/**
 * Load a chunk of the map. The client sends the sheet in slices so a
 * 30,000-row workbook is not one enormous request; `replace` is set on the
 * first slice only, which is what makes a re-upload clean rather than merged.
 */
export async function POST(req: Request) {
  try {
    await requireAdmin()
    const body = (await req.json()) as {
      siteId?: number
      rows?: Array<Array<string | number | null>>
      replace?: boolean
      rowOffset?: number
    }
    const siteId = Number(body.siteId)
    if (!siteId) return json({ error: 'site is required' }, 400)
    if (!Array.isArray(body.rows)) return json({ error: 'rows are required' }, 400)

    const parsed = parseMapTable(body.rows)
    const sql = db()

    if (body.replace) await sql`DELETE FROM bin_map WHERE site_id = ${siteId}`

    // A single INSERT cannot touch the same key twice, so collapse repeats
    // here - last one wins, and parseMapTable already reported them.
    const byOld = new Map<string, string>()
    for (const r of parsed.rows) byOld.set(r.oldBin, r.newBin)
    const olds = [...byOld.keys()]
    const news = olds.map(o => byOld.get(o)!)
    const offset = Number(body.rowOffset ?? 0)

    const CHUNK = 5000
    for (let i = 0; i < olds.length; i += CHUNK) {
      const o = olds.slice(i, i + CHUNK)
      const n = news.slice(i, i + CHUNK)
      const r = o.map((_, k) => offset + i + k + 1)
      await sql`
        INSERT INTO bin_map (site_id, old_bin, new_bin, row_no)
        SELECT ${siteId}, * FROM unnest(${o}::text[], ${n}::text[], ${r}::int[])
        ON CONFLICT (site_id, old_bin) DO UPDATE
          SET new_bin = EXCLUDED.new_bin, row_no = EXCLUDED.row_no`
    }

    const total = (await sql`SELECT count(*)::int AS rows FROM bin_map WHERE site_id = ${siteId}`) as Array<{
      rows: number
    }>
    return json({
      accepted: olds.length,
      total: total[0].rows,
      header: parsed.header,
      skipped: parsed.skipped.slice(0, 50),
      skippedCount: parsed.skipped.length,
      dupOld: parsed.dupOld.slice(0, 50),
      dupOldCount: parsed.dupOld.length,
      dupNew: parsed.dupNew.slice(0, 50),
      dupNewCount: parsed.dupNew.length,
      badNew: parsed.badNew.slice(0, 50),
      badNewCount: parsed.badNew.length,
    })
  } catch (e) {
    return fail(e)
  }
}

/** Clear the map for a site. Audit results are left alone. */
export async function DELETE(req: Request) {
  try {
    await requireAdmin()
    const siteId = Number(new URL(req.url).searchParams.get('site'))
    if (!siteId) return json({ error: 'site is required' }, 400)
    const sql = db()
    await sql`DELETE FROM bin_map WHERE site_id = ${siteId}`
    return json({ ok: true })
  } catch (e) {
    return fail(e)
  }
}
