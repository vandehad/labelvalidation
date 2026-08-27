import { currentUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const u = await currentUser()
    return json({ user: u ? { name: u.name, role: u.role } : null })
  } catch (e) {
    return fail(e)
  }
}
