import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Undo. A scanner may remove their own most recent pair; an admin may remove
 * any. Deleting frees both the old and the new bin to be scanned again.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await ctx.params
    const pairId = Number(id)
    if (!pairId) return json({ error: 'bad id' }, 400)
    const sql = db()

    const rows = (await sql`SELECT id, user_id, old_bin, new_bin FROM pairs WHERE id = ${pairId}`) as Array<{
      id: number
      user_id: number | null
      old_bin: string
      new_bin: string
    }>
    if (!rows.length) return json({ error: 'Already gone.' }, 404)
    if (user.role !== 'admin' && rows[0].user_id !== user.uid)
      return json({ error: 'That pair was scanned by someone else.' }, 403)

    await sql`DELETE FROM pairs WHERE id = ${pairId}`
    return json({ ok: true, removed: rows[0] })
  } catch (e) {
    return fail(e)
  }
}
