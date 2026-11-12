import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { relayKey, rotateRelayKey, relaysSeen } from '@/lib/printq'
import { RELAY_EXE_KEY, parseRelayExe } from '@/lib/relayexe.mjs'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** The relay key, for the Admin tab, every relay that has ever signed in, and the exe on offer. */
export async function GET() {
  try {
    await requireAdmin()
    const sql = db()
    const [key, relays, exe] = await Promise.all([
      relayKey(sql),
      relaysSeen(sql),
      sql`SELECT value FROM settings WHERE key = ${RELAY_EXE_KEY}` as unknown as Promise<Array<{ value: string }>>,
    ])
    return json({ key, relays, exe: parseRelayExe(exe[0]?.value) })
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
