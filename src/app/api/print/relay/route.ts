import { db } from '@/lib/db'
import { json, fail } from '@/lib/api'
import { requireRelay, RelayDenied } from '@/lib/printq'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * "Check connection" on the relay's setup page: proves the key, and lists the
 * sites so the relay can be bound to one.
 */
export async function GET(req: Request) {
  try {
    const sql = db()
    const name = await requireRelay(sql, req)
    const sites = (await sql`SELECT id, name FROM sites ORDER BY name`) as Array<{ id: number; name: string }>
    return json({ ok: true, name, sites })
  } catch (e) {
    if (e instanceof RelayDenied) return json({ error: e.message }, e.status)
    return fail(e)
  }
}
