import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Compare the stored label superset against what was actually scanned.
 *   unused     - printed but never scanned: delete these bins
 *   unexpected - scanned but not in the label set: investigate
 * A run is one-for-one when unexpected is empty and every pair used a label.
 */
export async function GET(req: Request) {
  try {
    await requireUser()
    const siteId = Number(new URL(req.url).searchParams.get('site'))
    if (!siteId) return json({ error: 'site is required' }, 400)
    const sql = db()

    const [unused, unexpected, counts] = await Promise.all([
      // Minted labels are excluded: they are bins being added, and listing
      // them as "delete these" is how a freshly hung shelf gets removed.
      sql`SELECT l.code, l.zone, l.aisle, l.col, l.letter
          FROM labels l
          WHERE l.site_id = ${siteId}
            AND l.origin <> 'minted'
            AND NOT EXISTS (SELECT 1 FROM pairs p WHERE p.site_id = l.site_id AND p.new_bin = l.code)
          ORDER BY l.code`,
      sql`SELECT p.new_bin AS code, p.old_bin, u.username
          FROM pairs p LEFT JOIN users u ON u.id = p.user_id
          WHERE p.site_id = ${siteId}
            AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.site_id = p.site_id AND l.code = p.new_bin)
          ORDER BY p.new_bin`,
      sql`SELECT
            (SELECT count(*)::int FROM labels WHERE site_id = ${siteId}) AS labels,
            (SELECT count(*)::int FROM pairs  WHERE site_id = ${siteId}) AS pairs,
            (SELECT count(*)::int FROM pairs  WHERE site_id = ${siteId} AND origin = 'minted') AS minted,
            (SELECT count(*)::int FROM labels WHERE site_id = ${siteId}
               AND origin = 'minted' AND hung_at IS NULL) AS to_hang`,
    ])

    const c = counts[0] as { labels: number; pairs: number; minted: number; to_hang: number }
    const used = c.labels - (unused as unknown[]).length
    return json({
      counts: { ...c, used, unused: (unused as unknown[]).length, unexpected: (unexpected as unknown[]).length },
      oneForOne: (unexpected as unknown[]).length === 0 && c.pairs === used,
      unused,
      unexpected,
    })
  } catch (e) {
    return fail(e)
  }
}
