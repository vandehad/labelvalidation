import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { mintOptions, mintBin, checkPick, MintRefused } from '@/lib/mint'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Adding a bin that was never in the plan.
 *
 * The rules live in `src/lib/mint.ts`, shared with the Windows Mobile route -
 * the two cannot share a component but must not disagree about what a valid
 * new bin is.
 */

export async function GET(req: Request) {
  try {
    await requireUser()
    const q = new URL(req.url).searchParams
    const siteId = Number(q.get('site'))
    if (!siteId) return json({ error: 'site is required' }, 400)
    const zone = (q.get('zone') ?? '').toUpperCase()
    const aisle = q.get('aisle') === null ? null : Number(q.get('aisle'))
    const col = q.get('col') === null ? null : Number(q.get('col'))
    return json(await mintOptions(db(), siteId, zone, aisle, col))
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
    const pick = checkPick(body as never)
    const made = await mintBin(db(), siteId, user.uid, pick)
    return json({ ...made, username: user.name }, 201)
  } catch (e) {
    if (e instanceof MintRefused) return json({ error: e.message }, e.status)
    return fail(e)
  }
}
