import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { listJobs, relaysSeen, queueJobs, onlineRelays, releaseNext, cancelHeld, QueueRefused } from '@/lib/printq'

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
      hold: body.hold === true,
      zpl: typeof body.zpl === 'string' && body.zpl ? body.zpl : undefined,
    })
    const online = await onlineRelays(sql, siteId, relay)
    return json({ jobs, online }, 201)
  } catch (e) {
    if (e instanceof QueueRefused) return json({ error: e.message }, e.status)
    return fail(e)
  }
}

/**
 * The held run, as a whole: release the next batch, or drop every held batch.
 * Held jobs have never been offered to a relay, so cancelling them is clean.
 */
export async function PATCH(req: Request) {
  try {
    await requireUser()
    const body = (await req.json()) as { siteId?: number; action?: string }
    const siteId = Number(body.siteId)
    if (!siteId) return json({ error: 'site is required' }, 400)
    const sql = db()
    if (body.action === 'release-next') {
      const id = await releaseNext(sql, siteId)
      if (id === null) return json({ error: 'Nothing is held.' }, 409)
      return json({ ok: true, released: id })
    }
    if (body.action === 'cancel-held') return json({ ok: true, cancelled: await cancelHeld(sql, siteId) })
    return json({ error: 'action must be release-next or cancel-held' }, 400)
  } catch (e) {
    return fail(e)
  }
}
