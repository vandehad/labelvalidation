import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { fail, json } from '@/lib/api'
import { makeXlsx, type Sheet } from '@/lib/xlsx'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Full workbook: cross-reference, unused (to delete), unexpected, summary,
 * plus the uploaded bin map and the validation audit when either exists.
 * Sheets with nothing in them are left out rather than shipped empty.
 */
export async function GET(req: Request) {
  try {
    await requireUser()
    const url = new URL(req.url)
    const siteId = Number(url.searchParams.get('site'))
    if (!siteId) return json({ error: 'site is required' }, 400)
    const sql = db()

    const site = (await sql`SELECT name FROM sites WHERE id = ${siteId}`) as Array<{ name: string }>
    if (!site.length) return json({ error: 'No such site.' }, 404)

    const [pairs, unused, unexpected, binMap, checks] = (await Promise.all([
      // Minted bins sort last: a rename whose "from" side does not exist is
      // not a rename, and mixing the two makes the sheet harder to act on.
      sql`SELECT p.old_bin, p.new_bin, p.location, p.origin, u.username, p.created_at,
                 l.hung_at, l.printed_at
          FROM pairs p
          LEFT JOIN users u  ON u.id = p.user_id
          LEFT JOIN labels l ON l.site_id = p.site_id AND l.code = p.new_bin
          WHERE p.site_id = ${siteId}
          ORDER BY (p.origin = 'minted'), p.new_bin`,
      sql`SELECT l.code, l.zone, l.aisle, l.col, l.letter FROM labels l
          WHERE l.site_id = ${siteId}
            AND l.origin <> 'minted'
            AND NOT EXISTS (SELECT 1 FROM pairs p WHERE p.site_id = l.site_id AND p.new_bin = l.code)
          ORDER BY l.code`,
      sql`SELECT p.new_bin, p.old_bin, u.username FROM pairs p
          LEFT JOIN users u ON u.id = p.user_id
          WHERE p.site_id = ${siteId}
            AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.site_id = p.site_id AND l.code = p.new_bin)
          ORDER BY p.new_bin`,
      sql`SELECT old_bin, new_bin FROM bin_map WHERE site_id = ${siteId}
          ORDER BY row_no NULLS LAST, old_bin`,
      sql`SELECT c.source, c.old_bin, c.new_bin, c.expected_bin, c.verdict, u.username, c.created_at
          FROM checks c LEFT JOIN users u ON u.id = c.user_id
          WHERE c.site_id = ${siteId}
          ORDER BY c.verdict, c.old_bin`,
    ])) as [
      Array<{
        old_bin: string
        new_bin: string
        location: string | null
        origin: string
        username: string | null
        created_at: string
        hung_at: string | null
        printed_at: string | null
      }>,
      Array<{ code: string; zone: string; aisle: number; col: number; letter: string }>,
      Array<{ new_bin: string; old_bin: string; username: string | null }>,
      Array<{ old_bin: string; new_bin: string }>,
      Array<{
        source: string
        old_bin: string
        new_bin: string
        expected_bin: string | null
        verdict: string
        username: string | null
        created_at: string
      }>,
    ]

    const labelCount = (await sql`SELECT count(*)::int AS n FROM labels WHERE site_id = ${siteId}`) as Array<{ n: number }>
    const used = labelCount[0].n - unused.length
    const oneForOne = unexpected.length === 0 && pairs.length === used

    const at = (t: string) => String(t).replace('T', ' ').slice(0, 19)
    const bad = checks.filter(c => c.verdict !== 'match')
    const nMatch = checks.length - bad.length
    const nMismatch = checks.filter(c => c.verdict === 'mismatch').length
    const nUnmapped = checks.filter(c => c.verdict === 'unmapped').length

    const summary: Array<Array<string | number | null>> = [
      ['MEASURE', 'VALUE'],
      ['site', site[0].name],
      ['labels generated', labelCount[0].n],
      ['labels used', used],
      ['labels unused - delete these', unused.length],
      ['pairs captured', pairs.length],
      ['scanned but not in label set', unexpected.length],
      ['one-for-one', oneForOne ? 'YES' : 'NO'],
    ]
    const minted = pairs.filter(p => p.origin === 'minted')
    if (minted.length) {
      summary.push(
        ['bins added during the conversion', minted.length],
        ['added but not yet hung', minted.filter(m => !m.hung_at).length],
      )
    }
    if (binMap.length || checks.length) {
      summary.push(
        ['bin map rows loaded', binMap.length],
        ['bins audited', checks.length],
        ['audit - match', nMatch],
        ['audit - MISMATCH', nMismatch],
        ['audit - not in reference', nUnmapped],
        ['audit clean', checks.length > 0 && bad.length === 0 ? 'YES' : 'NO'],
      )
    }
    summary.push(['exported', new Date().toISOString().replace('T', ' ').slice(0, 19)])

    const sheets: Sheet[] = [
      { name: 'SUMMARY', widths: [34, 16], rows: summary },
      {
        name: 'CROSS REFERENCE',
        widths: [16, 14, 24, 12, 14, 20],
        rows: [
          ['OLD BIN', 'NEW BIN', 'ORIGIN', 'LOCATION', 'SCANNED BY', 'SCANNED AT'],
          ...pairs.map(p => [
            p.old_bin,
            p.new_bin,
            p.origin === 'minted' ? 'ADDED - CREATE THIS BIN' : 'renamed',
            p.location ?? '',
            p.username ?? '',
            at(p.created_at),
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

    if (minted.length) {
      // Its own sheet as well as the cross-reference: this is the list of bins
      // to *create* in the WMS, which is a different job from the renames and
      // should not arrive mixed in with them.
      sheets.push({
        name: 'NEW BINS',
        widths: [16, 14, 8, 8, 9, 8, 14, 20],
        rows: [
          ['PLACEHOLDER', 'NEW BIN', 'ZONE', 'AISLE', 'COLUMN', 'SHELF', 'ADDED BY', 'ADDED AT'],
          ...minted.map(m => [
            m.old_bin,
            m.new_bin,
            m.new_bin[0],
            Number(m.new_bin.slice(1, 3)),
            Number(m.new_bin.slice(3, 5)),
            m.new_bin[5],
            m.username ?? '',
            at(m.created_at),
          ]),
        ],
      })
    }

    if (checks.length) {
      // Everything that failed, first and on its own sheet - this is the
      // list someone walks the floor with.
      sheets.push({
        name: 'AUDIT - TO FIX',
        widths: [14, 16, 16, 14, 14, 20],
        rows: [
          ['OLD BIN', 'HUNG LABEL', 'SHOULD BE', 'VERDICT', 'CHECKED BY', 'CHECKED AT'],
          ...bad.map(c => [
            c.old_bin,
            c.new_bin,
            c.expected_bin ?? '',
            c.verdict === 'unmapped' ? 'NOT IN REFERENCE' : 'MISMATCH',
            c.username ?? '',
            at(c.created_at),
          ]),
        ],
      })
      sheets.push({
        name: 'AUDIT - ALL',
        widths: [10, 14, 16, 16, 12, 14, 20],
        rows: [
          ['SOURCE', 'OLD BIN', 'HUNG LABEL', 'SHOULD BE', 'VERDICT', 'CHECKED BY', 'CHECKED AT'],
          ...checks.map(c => [
            c.source,
            c.old_bin,
            c.new_bin,
            c.expected_bin ?? '',
            c.verdict.toUpperCase(),
            c.username ?? '',
            at(c.created_at),
          ]),
        ],
      })
    }

    if (binMap.length) {
      sheets.push({
        name: 'BIN MAP',
        widths: [14, 14],
        rows: [['OLD BIN', 'NEW BIN'], ...binMap.map(m => [m.old_bin, m.new_bin])],
      })
    }

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
