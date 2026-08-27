import { findUser, verifyPassword, sessionFor, setSessionCookie } from '@/lib/auth'
import { json, fail } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const { username, password } = (await req.json()) as { username?: string; password?: string }
    if (!username || !password) return json({ error: 'Username and password are required.' }, 400)

    const u = await findUser(username)
    // Same message either way - do not reveal which half was wrong.
    const bad = json({ error: 'Wrong username or password.' }, 401)
    if (!u || !u.active) return bad
    if (!(await verifyPassword(password, u.pass_hash, u.salt))) return bad

    const s = sessionFor(u)
    await setSessionCookie(s)
    return json({ user: { name: s.name, role: s.role } })
  } catch (e) {
    return fail(e)
  }
}
