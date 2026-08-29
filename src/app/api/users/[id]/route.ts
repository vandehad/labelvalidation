import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { json, fail } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Enable, disable, or change someone's role.
 *
 * Accounts are never deleted: `pairs.user_id` and `checks.user_id` point at
 * them, and the whole value of this app is being able to say who scanned what.
 * Deactivating stops the login and keeps the history.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const me = await requireAdmin()
    const { id } = await ctx.params
    const userId = Number(id)
    if (!userId) return json({ error: 'bad id' }, 400)

    const body = (await req.json()) as { active?: boolean; role?: string }
    if (body.role !== undefined && !['scanner', 'admin'].includes(body.role))
      return json({ error: 'Role must be scanner or admin.' }, 400)

    const sql = db()
    const demoting = body.active === false || body.role === 'scanner'

    // Locking yourself out, or removing the last admin, leaves nobody able to
    // add users or generate labels, and the only way back is the CLI.
    if (userId === me.uid && demoting)
      return json({ error: 'That would lock you out of your own admin account.' }, 409)
    if (demoting) {
      const others = (await sql`
        SELECT count(*)::int AS n FROM users
        WHERE role = 'admin' AND active = true AND id <> ${userId}`) as Array<{ n: number }>
      if (others[0].n === 0) return json({ error: 'That is the last active admin.' }, 409)
    }

    const rows = (await sql`
      UPDATE users SET
        active = COALESCE(${body.active ?? null}, active),
        role   = COALESCE(${body.role ?? null}, role)
      WHERE id = ${userId}
      RETURNING id, username, role, active`) as Array<Record<string, unknown>>
    if (!rows.length) return json({ error: 'No such user.' }, 404)
    return json({ user: rows[0] })
  } catch (e) {
    return fail(e)
  }
}
