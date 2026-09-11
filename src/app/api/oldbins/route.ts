import { db } from '@/lib/db'
import { requireUser, requireAdmin } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { cleanOldBins, loadOldBins, progress, unpairedOldBins, suspectPairs } from '@/lib/oldbins'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The WMS old-bin list for a site. See lib/oldbins.
 *
 *   GET  ?site=            progress and the first 500 unpaired
 *   GET  ?site=&all=1      every unpaired bin
 *   GET  ?site=&format=csv the exception report as a download
 *   POST { siteId, bins[], replace? }   admin: load the list (adds unless replace)
 */
export async function GET(req: Request) {
  try {
    await requireUser()
    const q = new URL(req.url).searchParams
    const siteId = Number(q.get('site'))
    if (!siteId) return json({ error: 'site is required' }, 400)
    const sql = db()
    const all = q.get('all') === '1' || q.get('format') === 'csv'
    const p = await progress(sql, siteId)
    const [unpaired, suspects] = await Promise.all([unpairedOldBins(sql, siteId, all ? null : 500), p_suspects(sql, siteId, p)])
    if (q.get('format') === 'csv') {
      const site = (await sql`SELECT name FROM sites WHERE id = ${siteId}`) as Array<{ name: string }>
      const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
      const lines = ['exception,old_bin,new_label,scanned_by,suggested_wms_bin']
      for (const b of unpaired) lines.push(['wms_bin_not_paired', b, '', '', ''].map(cell).join(','))
      for (const x of suspects)
        lines.push(
          [
            x.kind === 'upc' ? 'suspect_upc_not_a_bin' : x.kind === 'similar' ? 'suspect_similar_to_wms_bin' : x.kind === 'extra' ? 'additional_bin_not_in_wms_list' : 'old_bin_not_in_wms',
            x.old_bin,
            x.new_bin,
            x.username ?? '',
            x.suggestions.join(' | '),
          ]
            .map(cell)
            .join(','),
        )
      const body = lines.join('\r\n') + '\r\n'
      return new Response(body, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="unpaired-wms-bins-site-${(site[0]?.name ?? siteId).toString().replace(/[^\w.-]+/g, '_')}.csv"`,
          'Cache-Control': 'no-store',
        },
      })
    }
    return json({ ...p, unpaired, truncated: !all && unpaired.length === 500, suspects })
  } catch (e) {
    return fail(e)
  }
}

/** Suspects only make sense against a list; without one every pair would be "unknown". */
async function p_suspects(sql: ReturnType<typeof db>, siteId: number, p: { total: number }) {
  return p.total ? suspectPairs(sql, siteId) : []
}

export async function POST(req: Request) {
  try {
    await requireAdmin()
    const body = (await req.json()) as { siteId?: number; bins?: unknown; replace?: boolean }
    const siteId = Number(body.siteId)
    if (!siteId) return json({ error: 'site is required' }, 400)
    const raw = Array.isArray(body.bins) ? body.bins.map(String) : []
    const { bins, dropped } = cleanOldBins(raw)
    if (!bins.length) return json({ error: 'No bin ids in that.' }, 422)
    const sql = db()
    const r = await loadOldBins(sql, siteId, bins, body.replace === true)
    return json({ ...r, received: raw.length, loaded: bins.length, dropped, replaced: body.replace === true, ...(await progress(sql, siteId)) })
  } catch (e) {
    return fail(e)
  }
}
