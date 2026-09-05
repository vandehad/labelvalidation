import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { listJobs, relaysSeen, queueJobs, onlineRelays, QueueRefused } from '@/lib/printq'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The print queue, from a screen's side. Nothing here touches a printer: a
 * job is queued for the site, and the relay signed in to that site pulls it
 * through /api/print/next.
 */

export async function GET(req: Request) {
  try {
    await requireUser()
    const q = new URL(req.url).searchParams
    const siteId = Number(q.get('site'))
    if (!siteId) return json({ error: 'site is required' }, 400)
    const sql = db()
    const [jobs, relays] = await Promise.all([listJobs(sql, siteId), relaysSeen(sql, siteId)])
    return json({ jobs, relays })
  } catch (e) {
    return fail(e)
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = (await req.json()) as Record<string, unknown>
    const siteId = Number(body.siteId)
    if (!siteId) return json({ error: 'site is required' }, 400)
    const codes = Array.isArray(body.codes) ? body.codes.map(String) : []
    const relay = typeof body.relay === 'string' && body.relay ? body.relay : null
    const sql = db()
    const jobs = await queueJobs(sql, {
      siteId,
      userId: user.uid,
      codes,
      copies: Number(body.copies) || 1,
      relay,
      zpl: typeof body.zpl === 'string' && body.zpl ? body.zpl : undefined,
    })
    const online = await onlineRelays(sql, siteId, relay)
    return json({ jobs, online }, 201)
  } catch (e) {
    if (e instanceof QueueRefused) return json({ error: e.message }, e.status)
    return fail(e)
  }
}
