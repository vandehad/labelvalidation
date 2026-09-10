import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { repairPair, RepairRefused } from '@/lib/repair'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Re-pair a shelf scanned wrong. See lib/repair. */
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = (await req.json()) as { siteId?: number; oldBin?: string; newBin?: string; location?: string | null }
    const siteId = Number(body.siteId)
    if (!siteId) return json({ error: 'site is required' }, 400)
    const r = await repairPair(db(), siteId, user.uid, body.oldBin ?? '', body.newBin ?? '', body.location?.trim() || 'repaired')
    return json({ pair: { ...r.pair, username: user.name }, replaced: r.replaced }, 201)
  } catch (e) {
    if (e instanceof RepairRefused) return json({ error: e.message }, e.status)
    return fail(e)
  }
}
