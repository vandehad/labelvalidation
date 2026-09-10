import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { unpair } from '@/lib/repair'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Remove the pair a scanned label or old bin belongs to. See lib/repair. */
export async function POST(req: Request) {
  try {
    await requireUser()
    const body = (await req.json()) as { siteId?: number; bin?: string }
    const siteId = Number(body.siteId)
    if (!siteId) return json({ error: 'site is required' }, 400)
    const removed = await unpair(db(), siteId, body.bin ?? '')
    if (!removed) return json({ error: `${(body.bin ?? '').trim().toUpperCase() || 'That'} is not paired to anything.` }, 404)
    return json({ removed })
  } catch (e) {
    return fail(e)
  }
}
