import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { captureTote, listTotes, removeTote, totesCsv, ToteRefused } from '@/lib/totes'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Tote capture: a list of label numbers, nothing more.
 *
 *   GET  ?site=1          the list, newest first, and the count
 *   GET  ?site=1&csv=1    the whole list as a file
 *   POST { siteId, code } capture one; a repeat says so and changes nothing
 *   DELETE ?site=1&id=9   drop a mis-scan
 */
export async function GET(req: Request) {
  try {
    await requireUser()
    const q = new URL(req.url).searchParams
    const siteId = Number(q.get('site'))
    if (!siteId) return json({ error: 'site is required' }, 400)
    const sql = db()
    if (q.get('csv')) {
      const site = (await sql`SELECT name FROM sites WHERE id = ${siteId}`) as Array<{ name: string }>
      const name = (site[0]?.name ?? siteId).toString().replace(/[^\w.-]+/g, '_')
      return new Response(await totesCsv(sql, siteId), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="totes-site-${name}.csv"`,
        },
      })
    }
    return json(await listTotes(sql, siteId, Math.min(Number(q.get('limit') ?? 200), 1000)))
  } catch (e) {
    return fail(e)
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = (await req.json()) as { siteId?: number; code?: unknown; note?: unknown }
    const siteId = Number(body.siteId)
    if (!siteId) return json({ error: 'site is required' }, 400)
    const sql = db()
    return json(await captureTote(sql, siteId, user.uid, body.code, body.note), 201)
  } catch (e) {
    if (e instanceof ToteRefused) return json({ error: e.message }, 400)
    return fail(e)
  }
}

export async function DELETE(req: Request) {
  try {
    await requireUser()
    const q = new URL(req.url).searchParams
    const siteId = Number(q.get('site'))
    const id = Number(q.get('id'))
    if (!siteId || !id) return json({ error: 'site and id are required' }, 400)
    const code = await removeTote(db(), siteId, id)
    if (!code) return json({ error: 'Not on the list.' }, 404)
    return json({ ok: true, code })
  } catch (e) {
    return fail(e)
  }
}
