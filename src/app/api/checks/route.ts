import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { verdictFor, normalizeScan } from '@/lib/bins'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Validation mode: audit labels that are already hung.
 *
 * Scan the old label, scan the new one, and the answer is match, mismatch or
 * not-in-the-reference. Unlike pairing, this refuses nothing - the shelf is
 * reporting what is physically there, and a wrong label still has to be
 * recorded before it can be fixed.
 *
 * The reference is either the uploaded bin map or the pairs captured by
 * scanning, chosen per audit run.
 */

export type Source = 'map' | 'pairs'

const sourceOf = (v: unknown): Source | null => (v === 'map' || v === 'pairs' ? v : null)

export async function GET(req: Request) {
  try {
    await requireUser()
    const { searchParams } = new URL(req.url)
    const siteId = Number(searchParams.get('site'))
    const source = sourceOf(searchParams.get('source') ?? 'map')
    if (!siteId) return json({ error: 'site is required' }, 400)
    if (!source) return json({ error: 'source must be map or pairs' }, 400)
    const limit = Math.min(Number(searchParams.get('limit') ?? 200), 1000)
    const sql = db()

    const [checks, tally, reference, byUser] = await Promise.all([
      sql`SELECT c.id, c.old_bin, c.new_bin, c.expected_bin, c.verdict, c.created_at, u.username
          FROM checks c LEFT JOIN users u ON u.id = c.user_id
          WHERE c.site_id = ${siteId} AND c.source = ${source}
          ORDER BY c.id DESC LIMIT ${limit}`,
      sql`SELECT verdict, count(*)::int AS n FROM checks
          WHERE site_id = ${siteId} AND source = ${source} GROUP BY verdict`,
      source === 'map'
        ? sql`SELECT count(*)::int AS n FROM bin_map WHERE site_id = ${siteId}`
        : sql`SELECT count(*)::int AS n FROM pairs WHERE site_id = ${siteId}`,
      sql`SELECT COALESCE(u.username,'?') AS username, count(*)::int AS n
          FROM checks c LEFT JOIN users u ON u.id = c.user_id
          WHERE c.site_id = ${siteId} AND c.source = ${source}
          GROUP BY 1 ORDER BY n DESC`,
    ])

    const t = tally as Array<{ verdict: string; n: number }>
    const n = (v: string) => t.find(x => x.verdict === v)?.n ?? 0
    const counts = {
      match: n('match'),
      mismatch: n('mismatch'),
      unmapped: n('unmapped'),
      checked: t.reduce((a, b) => a + b.n, 0),
      reference: (reference[0] as { n: number }).n,
    }
    return json({ checks, counts, byUser, source })
  } catch (e) {
    return fail(e)
  }
}

/** Record one audit scan. Re-scanning the same old bin replaces its result. */
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = (await req.json()) as {
      siteId?: number
      source?: string
      oldBin?: string
      newBin?: string
    }
    const siteId = Number(body.siteId)
    const source = sourceOf(body.source)
    // See /api/pairs: the barcode carries a padded field before the code.
    const oldBin = normalizeScan(body.oldBin ?? '')
    const newBin = normalizeScan(body.newBin ?? '')
    if (!siteId) return json({ error: 'site is required' }, 400)
    if (!source) return json({ error: 'source must be map or pairs' }, 400)
    if (!oldBin || !newBin) return json({ error: 'Both fields are needed.' }, 422)
    if (oldBin === newBin) return json({ error: 'Old and new are identical - same label scanned twice?' }, 422)

    const sql = db()

    // What the reference says this bin should be, and whether the code that
    // was actually hung belongs to some other bin. That second question is
    // the zone-E/zone-K collision from site 18, and it is silent otherwise.
    const [expectedRows, ownerRows] = await Promise.all([
      source === 'map'
        ? sql`SELECT new_bin FROM bin_map WHERE site_id = ${siteId} AND old_bin = ${oldBin} LIMIT 1`
        : sql`SELECT new_bin FROM pairs   WHERE site_id = ${siteId} AND old_bin = ${oldBin} LIMIT 1`,
      source === 'map'
        ? sql`SELECT old_bin FROM bin_map WHERE site_id = ${siteId} AND new_bin = ${newBin} AND old_bin <> ${oldBin} LIMIT 1`
        : sql`SELECT old_bin FROM pairs   WHERE site_id = ${siteId} AND new_bin = ${newBin} AND old_bin <> ${oldBin} LIMIT 1`,
    ])

    const expected = (expectedRows[0] as { new_bin: string } | undefined)?.new_bin ?? null
    const belongsTo = (ownerRows[0] as { old_bin: string } | undefined)?.old_bin ?? null
    const verdict = verdictFor(newBin, expected)

    const rows = (await sql`
      INSERT INTO checks (site_id, source, old_bin, new_bin, expected_bin, verdict, user_id)
      VALUES (${siteId}, ${source}, ${oldBin}, ${newBin}, ${expected}, ${verdict}, ${user.uid})
      ON CONFLICT (site_id, source, old_bin) DO UPDATE
        SET new_bin = EXCLUDED.new_bin,
            expected_bin = EXCLUDED.expected_bin,
            verdict = EXCLUDED.verdict,
            user_id = EXCLUDED.user_id,
            created_at = now()
      RETURNING id, old_bin, new_bin, expected_bin, verdict, created_at
    `) as Array<Record<string, unknown>>

    return json({ check: { ...rows[0], username: user.name }, verdict, expected, belongsTo }, 201)
  } catch (e) {
    return fail(e)
  }
}
