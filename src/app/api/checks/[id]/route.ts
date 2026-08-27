import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Undo an audit scan. Same rule as pairs: your own, or anything if admin.
 * Removing a check leaves that bin unaudited rather than passing it.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await ctx.params
    const checkId = Number(id)
    if (!checkId) return json({ error: 'bad id' }, 400)
    const sql = db()

    const rows = (await sql`SELECT id, user_id, old_bin, new_bin FROM checks WHERE id = ${checkId}`) as Array<{
      id: number
      user_id: number | null
      old_bin: string
      new_bin: string
    }>
    if (!rows.length) return json({ error: 'Already gone.' }, 404)
    if (user.role !== 'admin' && rows[0].user_id !== user.uid)
      return json({ error: 'That check was recorded by someone else.' }, 403)

    await sql`DELETE FROM checks WHERE id = ${checkId}`
    return json({ ok: true, removed: rows[0] })
  } catch (e) {
    return fail(e)
  }
}
