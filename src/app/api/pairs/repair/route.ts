import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { repairPair, RepairRefused } from '@/lib/repair'
import { softWarnings } from '@/lib/pairing'
import { normalizeScan, validatePair } from '@/lib/bins'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Re-pair a shelf scanned wrong. See lib/repair. */
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = (await req.json()) as { siteId?: number; oldBin?: string; newBin?: string; location?: string | null; confirmed?: boolean }
    const siteId = Number(body.siteId)
    if (!siteId) return json({ error: 'site is required' }, 400)
    // Repair overrides what a shelf is paired to - not the second look. A
    // repair that pairs across aisles is held exactly as a first scan would be.
    const o = normalizeScan(body.oldBin ?? '')
    const n = normalizeScan(body.newBin ?? '')
    let warned: string | null = null
    if (!validatePair(o, n, { enforceFormat: true, location: null })) {
      const warnings = await softWarnings(db(), siteId, o, n)
      if (warnings.length && body.confirmed !== true)
        return json({ error: warnings.join(' '), needsConfirm: true, warnings }, 409)
      warned = warnings.length ? warnings.join(' ') : null
    }
    const r = await repairPair(db(), siteId, user.uid, o, n, body.location?.trim() || 'repaired', warned)
    return json({ pair: { ...r.pair, username: user.name }, replaced: r.replaced }, 201)
  } catch (e) {
    if (e instanceof RepairRefused) return json({ error: e.message }, e.status)
    return fail(e)
  }
}
