import { db } from '@/lib/db'
import { requireUser, requireAdmin } from '@/lib/auth'
import { json, fail } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    await requireUser()
    const sql = db()
    const sites = await sql`
      SELECT s.id, s.name, s.status,
             (SELECT count(*)::int FROM labels l WHERE l.site_id = s.id) AS labels,
             (SELECT count(*)::int FROM pairs  p WHERE p.site_id = s.id) AS pairs
      FROM sites s ORDER BY s.created_at DESC`
    return json({ sites })
  } catch (e) {
    return fail(e)
  }
}

export async function POST(req: Request) {
  try {
    await requireAdmin()
    const { name } = (await req.json()) as { name?: string }
    const n = String(name ?? '').trim()
    if (!n) return json({ error: 'Name is required.' }, 400)
    const sql = db()
    const rows = await sql`
      INSERT INTO sites (name) VALUES (${n})
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name, status`
    return json({ site: rows[0] }, 201)
  } catch (e) {
    return fail(e)
  }
}
