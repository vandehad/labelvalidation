import { db } from '@/lib/db'
import { requireUser, requireAdmin } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { generateLabels, splitNew, type GenSpec } from '@/lib/bins'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(req: Request) {
  try {
    await requireUser()
    const siteId = Number(new URL(req.url).searchParams.get('site'))
    if (!siteId) return json({ error: 'site is required' }, 400)
    const sql = db()
    const rows = await sql`
      SELECT code, zone, aisle, col, letter FROM labels
      WHERE site_id = ${siteId} ORDER BY code`
    return json({ labels: rows })
  } catch (e) {
    return fail(e)
  }
}

/** Generate the label superset for a site and store it. Replaces any prior set. */
export async function POST(req: Request) {
  try {
    await requireAdmin()
    const body = (await req.json()) as { siteId?: number; spec?: GenSpec }
    const siteId = Number(body.siteId)
    if (!siteId || !body.spec) return json({ error: 'siteId and spec are required' }, 400)

    const result = generateLabels(body.spec)
    if (!result.labels.length) return json({ error: 'Nothing to generate - check the input.' }, 422)

    const sql = db()
    await sql`DELETE FROM labels WHERE site_id = ${siteId}`

    // One multi-row insert per chunk; unnest keeps the statement small.
    const CHUNK = 5000
    for (let i = 0; i < result.labels.length; i += CHUNK) {
      const slice = result.labels.slice(i, i + CHUNK)
      const parts = slice.map(c => splitNew(c)!)
      await sql`
        INSERT INTO labels (site_id, code, zone, aisle, col, letter)
        SELECT ${siteId}, * FROM unnest(
          ${slice}::text[],
          ${parts.map(p => p.zone)}::text[],
          ${parts.map(p => p.aisle)}::int[],
          ${parts.map(p => p.col)}::int[],
          ${parts.map(p => p.letter)}::text[]
        )
        ON CONFLICT (site_id, code) DO NOTHING`
    }
    return json({
      stored: result.labels.length,
      columns: result.columns,
      zones: result.zones,
      tallest: result.tallest,
      capped: result.capped,
      unparsed: result.unparsed.slice(0, 50),
      unparsedCount: result.unparsed.length,
      // Overlapping blocks and skipped ones. The unique index would swallow a
      // collision without a word; the caller has to be told.
      problems: result.problems,
    })
  } catch (e) {
    return fail(e)
  }
}
