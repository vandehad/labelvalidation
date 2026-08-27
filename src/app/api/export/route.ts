import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { fail, json } from '@/lib/api'
import { makeXlsx, type Sheet } from '@/lib/xlsx'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

/** Full workbook: cross-reference, unused (to delete), unexpected, summary. */
export async function GET(req: Request) {
  try {
    await requireUser()
    const url = new URL(req.url)
    const siteId = Number(url.searchParams.get('site'))
    if (!siteId) return json({ error: 'site is required' }, 400)
    const sql = db()

    const site = (await sql`SELECT name FROM sites WHERE id = ${siteId}`) as Array<{ name: string }>
    if (!site.length) return json({ error: 'No such site.' }, 404)

    const [pairs, unused, unexpected] = (await Promise.all([
      sql`SELECT p.old_bin, p.new_bin, p.location, u.username, p.created_at
          FROM pairs p LEFT JOIN users u ON u.id = p.user_id
          WHERE p.site_id = ${siteId} ORDER BY p.new_bin`,
      sql`SELECT l.code, l.zone, l.aisle, l.col, l.letter FROM labels l
          WHERE l.site_id = ${siteId}
            AND NOT EXISTS (SELECT 1 FROM pairs p WHERE p.site_id = l.site_id AND p.new_bin = l.code)
          ORDER BY l.code`,
      sql`SELECT p.new_bin, p.old_bin, u.username FROM pairs p
          LEFT JOIN users u ON u.id = p.user_id
          WHERE p.site_id = ${siteId}
            AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.site_id = p.site_id AND l.code = p.new_bin)
          ORDER BY p.new_bin`,
    ])) as [
      Array<{ old_bin: string; new_bin: string; location: string | null; username: string | null; created_at: string }>,
      Array<{ code: string; zone: string; aisle: number; col: number; letter: string }>,
      Array<{ new_bin: string; old_bin: string; username: string | null }>,
    ]

    const labelCount = (await sql`SELECT count(*)::int AS n FROM labels WHERE site_id = ${siteId}`) as Array<{ n: number }>
    const used = labelCount[0].n - unused.length
    const oneForOne = unexpected.length === 0 && pairs.length === used

    const sheets: Sheet[] = [
      {
        name: 'SUMMARY',
        widths: [34, 16],
        rows: [
          ['MEASURE', 'VALUE'],
          ['site', site[0].name],
          ['labels generated', labelCount[0].n],
          ['labels used', used],
          ['labels unused - delete these', unused.length],
          ['pairs captured', pairs.length],
          ['scanned but not in label set', unexpected.length],
          ['one-for-one', oneForOne ? 'YES' : 'NO'],
          ['exported', new Date().toISOString().replace('T', ' ').slice(0, 19)],
        ],
      },
      {
        name: 'CROSS REFERENCE',
        widths: [14, 14, 12, 14, 20],
        rows: [
          ['OLD BIN', 'NEW BIN', 'LOCATION', 'SCANNED BY', 'SCANNED AT'],
          ...pairs.map(p => [
            p.old_bin,
            p.new_bin,
            p.location ?? '',
            p.username ?? '',
            String(p.created_at).replace('T', ' ').slice(0, 19),
          ]),
        ],
      },
      {
        name: 'DELETE - UNUSED',
        widths: [14, 8, 8, 9, 8],
        rows: [['LABEL', 'ZONE', 'AISLE', 'COLUMN', 'SHELF'], ...unused.map(l => [l.code, l.zone, l.aisle, l.col, l.letter])],
      },
      {
        name: 'UNEXPECTED',
        widths: [14, 14, 14],
        rows: [['NEW BIN', 'OLD BIN', 'SCANNED BY'], ...unexpected.map(u => [u.new_bin, u.old_bin, u.username ?? ''])],
      },
    ]

    const bytes = makeXlsx(sheets)
    const safe = site[0].name.replace(/[^\w-]+/g, '_')
    const stamp = new Date().toISOString().slice(0, 10)
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${safe}_crossref_${stamp}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    return fail(e)
  }
}
