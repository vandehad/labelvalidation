import { db } from '@/lib/db'
import { requireAdmin, requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Clearing a site's data. Admin only, and never by accident.
 *
 * Four separate things can be wiped, because they are undone at different
 * moments and for different reasons:
 *
 *   labels   the generated superset - regenerate after changing the blocks
 *   pairs    the captured cross-reference - the actual work, hardest to redo
 *   map      the uploaded reference, replaced by re-uploading anyway
 *   checks   audit results
 *
 * Deleting a whole site cascades to all four. That is deliberately a separate
 * flag from the individual ones: someone clearing a stale label set should not
 * be one mis-click from destroying a week of scanning.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
    const { id } = await ctx.params
    const siteId = Number(id)
    if (!siteId) return json({ error: 'bad id' }, 400)

    const what = new URL(req.url).searchParams.get('what') ?? ''
    const parts = new Set(what.split(',').map(s => s.trim()).filter(Boolean))
    if (!parts.size) return json({ error: 'Nothing named to clear.' }, 400)

    const sql = db()
    const site = (await sql`SELECT name FROM sites WHERE id = ${siteId}`) as Array<{ name: string }>
    if (!site.length) return json({ error: 'No such site.' }, 404)

    const cleared: Record<string, number> = {}
    const count = async (t: 'labels' | 'pairs' | 'bin_map' | 'checks') => {
      const r = (await (t === 'labels'
        ? sql`SELECT count(*)::int AS n FROM labels WHERE site_id = ${siteId}`
        : t === 'pairs'
          ? sql`SELECT count(*)::int AS n FROM pairs WHERE site_id = ${siteId}`
          : t === 'bin_map'
            ? sql`SELECT count(*)::int AS n FROM bin_map WHERE site_id = ${siteId}`
            : sql`SELECT count(*)::int AS n FROM checks WHERE site_id = ${siteId}`)) as Array<{ n: number }>
      return r[0].n
    }

    if (parts.has('site')) {
      cleared.labels = await count('labels')
      cleared.pairs = await count('pairs')
      cleared.map = await count('bin_map')
      cleared.checks = await count('checks')
      // Every child table cascades from sites.
      await sql`DELETE FROM sites WHERE id = ${siteId}`
      return json({ ok: true, deletedSite: site[0].name, cleared })
    }

    if (parts.has('labels')) {
      cleared.labels = await count('labels')
      // Minted labels are kept: they record a bin that was added and hung,
      // and their pair rows would be orphaned by removing them.
      await sql`DELETE FROM labels WHERE site_id = ${siteId} AND origin <> 'minted'`
      cleared.labels -= await count('labels')
    }
    if (parts.has('pairs')) {
      cleared.pairs = await count('pairs')
      await sql`DELETE FROM pairs WHERE site_id = ${siteId}`
    }
    if (parts.has('map')) {
      cleared.map = await count('bin_map')
      await sql`DELETE FROM bin_map WHERE site_id = ${siteId}`
    }
    if (parts.has('checks')) {
      cleared.checks = await count('checks')
      await sql`DELETE FROM checks WHERE site_id = ${siteId}`
    }

    return json({ ok: true, site: site[0].name, cleared })
  } catch (e) {
    return fail(e)
  }
}

/**
 * The label stock in this site's printer, 4 or 3 inches. Chosen on the Print
 * card and read by every screen that prints, so a bin added from a TC52 comes
 * out at the same width as the run it joins.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser()
    const siteId = Number((await ctx.params).id)
    const body = (await req.json()) as { labelWidth?: number }
    const w = Number(body.labelWidth) === 3 ? 3 : 4
    const rows = await db()`UPDATE sites SET label_width = ${w} WHERE id = ${siteId} RETURNING id, label_width`
    if (!rows.length) return json({ error: 'No such site.' }, 404)
    return json({ site: rows[0] })
  } catch (e) {
    return fail(e)
  }
}
