import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { suspectPairs } from '@/lib/oldbins'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The numbers for the Summary tab, in one round trip.
 *
 * Progress is measured against the WMS old-bin list where one is loaded, by
 * WMS zone (the first part of the canonical id). Rate is pairs per hour from
 * `pairs.created_at`: the last hour, the last eight, and the average over
 * hours in which anything was paired at all - a warehouse does not scan
 * overnight, so an average over the calendar would understate the pace.
 */
export async function GET(req: Request) {
  try {
    await requireUser()
    const siteId = Number(new URL(req.url).searchParams.get('site'))
    if (!siteId) return json({ error: 'site is required' }, 400)
    const sql = db()

    const [totals, byZone, perHour, perDay, byUser, rate, suspects] = await Promise.all([
      sql`WITH pc AS (SELECT DISTINCT canon_old(old_bin) AS c FROM pairs WHERE site_id = ${siteId})
          SELECT
            (SELECT count(*)::int FROM pairs WHERE site_id = ${siteId}) AS pairs,
            (SELECT count(*)::int FROM pairs WHERE site_id = ${siteId} AND origin = 'minted') AS minted,
            (SELECT count(*)::int FROM labels WHERE site_id = ${siteId}) AS labels,
            (SELECT count(*)::int FROM old_bins WHERE site_id = ${siteId}) AS wms,
            (SELECT count(*)::int FROM old_bins o JOIN pc ON pc.c = o.canon WHERE o.site_id = ${siteId}) AS wms_paired,
            (SELECT count(*)::int FROM checks WHERE site_id = ${siteId}) AS checks,
            (SELECT count(*)::int FROM checks WHERE site_id = ${siteId} AND verdict = 'mismatch') AS mismatches,
            (SELECT min(created_at) FROM pairs WHERE site_id = ${siteId}) AS first_pair,
            (SELECT max(created_at) FROM pairs WHERE site_id = ${siteId}) AS last_pair`,
      // WMS zone = first part of the canonical id ("01"). Anything not in that
      // shape lands under its own first character so nothing is dropped.
      sql`WITH pc AS (SELECT DISTINCT canon_old(old_bin) AS c FROM pairs WHERE site_id = ${siteId})
          SELECT split_part(o.canon, '-', 1) AS zone,
                 count(*)::int AS total,
                 count(pc.c)::int AS paired
          FROM old_bins o LEFT JOIN pc ON pc.c = o.canon
          WHERE o.site_id = ${siteId}
          GROUP BY 1 ORDER BY 1`,
      sql`SELECT date_trunc('hour', created_at) AS hour, count(*)::int AS n
          FROM pairs WHERE site_id = ${siteId} AND created_at > now() - interval '3 days'
          GROUP BY 1 ORDER BY 1`,
      sql`SELECT date_trunc('day', created_at) AS day, count(*)::int AS n,
                 count(DISTINCT date_trunc('hour', created_at))::int AS active_hours,
                 count(DISTINCT user_id)::int AS people
          FROM pairs WHERE site_id = ${siteId}
          GROUP BY 1 ORDER BY 1`,
      sql`SELECT COALESCE(u.username, '?') AS username,
                 count(*)::int AS pairs,
                 count(*) FILTER (WHERE p.created_at > now() - interval '1 hour')::int AS last_hour,
                 count(*) FILTER (WHERE p.created_at::date = now()::date)::int AS today,
                 count(DISTINCT date_trunc('hour', p.created_at))::int AS active_hours,
                 max(p.created_at) AS last_seen
          FROM pairs p LEFT JOIN users u ON u.id = p.user_id
          WHERE p.site_id = ${siteId}
          GROUP BY 1 ORDER BY pairs DESC`,
      sql`SELECT
            count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS last_hour,
            count(*) FILTER (WHERE created_at > now() - interval '8 hours')::int AS last_8h,
            count(DISTINCT date_trunc('hour', created_at))::int AS active_hours
          FROM pairs WHERE site_id = ${siteId}`,
      suspectPairs(sql, siteId),
    ])

    const t = totals[0] as Record<string, number | string | null>
    const r = rate[0] as { last_hour: number; last_8h: number; active_hours: number }
    const pairs = Number(t.pairs)
    const avgPerActiveHour = r.active_hours ? pairs / r.active_hours : 0
    const wms = Number(t.wms)
    const wmsPaired = Number(t.wms_paired)
    const exceptions = suspects.filter(s => s.kind !== 'extra').length
    const additional = suspects.length - exceptions

    return json({
      totals: { ...t, exceptions, additional },
      byZone,
      perHour,
      perDay,
      byUser,
      rate: {
        lastHour: r.last_hour,
        last8h: r.last_8h,
        activeHours: r.active_hours,
        avgPerActiveHour,
        // Hours of scanning left at the average pace, against the WMS list.
        hoursLeft: wms && avgPerActiveHour ? (wms - wmsPaired) / avgPerActiveHour : null,
      },
    })
  } catch (e) {
    return fail(e)
  }
}
