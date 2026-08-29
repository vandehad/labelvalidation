import { db } from '@/lib/db'
import { requireAdmin, hashPassword } from '@/lib/auth'
import { json, fail } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * User administration. Admin only, throughout.
 *
 * Hashing goes through `hashPassword`, the same function `scripts/create-user.mjs`
 * relies on, so there is one implementation rather than two that can drift
 * apart on iteration count and quietly stop verifying each other's passwords.
 */

const ROLES = ['scanner', 'admin']

export async function GET() {
  try {
    await requireAdmin()
    const sql = db()
    const users = await sql`
      SELECT u.id, u.username, u.role, u.active, u.created_at,
             (SELECT count(*)::int FROM pairs  p WHERE p.user_id = u.id) AS pairs,
             (SELECT count(*)::int FROM checks c WHERE c.user_id = u.id) AS checks
      FROM users u ORDER BY lower(u.username)`
    return json({ users })
  } catch (e) {
    return fail(e)
  }
}

/** Add someone, or reset an existing password - as the CLI script does. */
export async function POST(req: Request) {
  try {
    await requireAdmin()
    const body = (await req.json()) as { username?: string; password?: string; role?: string }
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '')
    const role = String(body.role ?? 'scanner')

    if (!username) return json({ error: 'A username is required.' }, 400)
    if (password.length < 6) return json({ error: 'Password must be at least 6 characters.' }, 400)
    if (!ROLES.includes(role)) return json({ error: 'Role must be scanner or admin.' }, 400)

    const { hash, salt } = await hashPassword(password)
    const sql = db()
    const rows = (await sql`
      INSERT INTO users (username, pass_hash, salt, role)
      VALUES (${username}, ${hash}, ${salt}, ${role})
      ON CONFLICT (lower(username)) DO UPDATE
        SET pass_hash = EXCLUDED.pass_hash, salt = EXCLUDED.salt,
            role = EXCLUDED.role, active = true
      RETURNING id, username, role, active`) as Array<Record<string, unknown>>
    return json({ user: rows[0] }, 201)
  } catch (e) {
    return fail(e)
  }
}
