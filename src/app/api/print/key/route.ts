import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { relayKey, rotateRelayKey, relaysSeen } from '@/lib/printq'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** The relay key, for the Admin tab, and every relay that has ever signed in. */
export async function GET() {
  try {
    await requireAdmin()
    const sql = db()
    const [key, relays] = await Promise.all([relayKey(sql), relaysSeen(sql)])
    return json({ key, relays })
  } catch (e) {
    return fail(e)
  }
}

/** A new key. Every relay stops printing until it is given the new one. */
export async function POST() {
  try {
    await requireAdmin()
    return json({ key: await rotateRelayKey(db()) })
  } catch (e) {
    return fail(e)
  }
}
