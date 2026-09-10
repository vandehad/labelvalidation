import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { resolveLabel } from '@/lib/lookup'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** For a reprint: what a scanned label or typed old bin refers to. See lib/lookup. */
export async function GET(req: Request) {
  try {
    await requireUser()
    const q = new URL(req.url).searchParams
    const siteId = Number(q.get('site'))
    const bin = q.get('bin') ?? ''
    if (!siteId) return json({ error: 'site is required' }, 400)
    if (!bin.trim()) return json({ error: 'bin is required' }, 400)
    return json(await resolveLabel(db(), siteId, bin))
  } catch (e) {
    return fail(e)
  }
}
