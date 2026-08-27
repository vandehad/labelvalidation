import { clearSessionCookie } from '@/lib/auth'
import { json, fail } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST() {
  try {
    await clearSessionCookie()
    return json({ ok: true })
  } catch (e) {
    return fail(e)
  }
}
