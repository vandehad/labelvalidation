import { db } from '@/lib/db'
import { json, fail } from '@/lib/api'
import { requireRelay, heartbeat, claimNext, parseKinds, RelayDenied } from '@/lib/printq'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The relay's poll. Bearer key, then: record that this relay is alive and
 * which site and printer it serves, and hand it the oldest queued job for
 * that site - 204 when there is none. A relay runs a loop per printer and
 * each names the `kinds` its printer takes; with none named, any job.
 *
 * Every poll writes the heartbeat, so "online" on the screens means "polled
 * in the last 45 seconds", which is the only definition that survives a PC
 * going to sleep with the relay window still open.
 */
export async function GET(req: Request) {
  try {
    const sql = db()
    const name = await requireRelay(sql, req)
    const q = new URL(req.url).searchParams
    const siteId = Number(q.get('site'))
    if (!siteId) return json({ error: 'Pick a site on the relay setup page.' }, 400)
    await heartbeat(sql, name, siteId, q.get('target'), q.get('v'))
    const job = await claimNext(sql, siteId, name, parseKinds(q.get('kinds')))
    if (!job) return new Response(null, { status: 204 })
    return json(job)
  } catch (e) {
    if (e instanceof RelayDenied) return json({ error: e.message }, e.status)
    return fail(e)
  }
}
