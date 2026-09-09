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
      SELECT code, zone, aisle, col, letter, origin FROM labels
      WHERE site_id = ${siteId} ORDER BY code`
    return json({ labels: rows })
  } catch (e) {
    return fail(e)
  }
}

/**
 * Generate labels for a site and store them.
 *
 * Adds to the set. A site is built up over several generates - a block of
 * aisles today, a range that was missed tomorrow - and the first version of
 * this deleted the whole set before every insert, which turned "add one
 * aisle" into "lose 44,000 labels". Replacing is now something the caller
 * has to ask for by name, and it is refused while pairs exist: a pair points
 * at a label, and deleting the label under it is how a hung shelf becomes a
 * bin nothing can find. Admin -> Wipe is the deliberate way to clear a set.
 */
export async function POST(req: Request) {
  try {
    await requireAdmin()
    const body = (await req.json()) as { siteId?: number; spec?: GenSpec; replace?: boolean }
    const siteId = Number(body.siteId)
    if (!siteId || !body.spec) return json({ error: 'siteId and spec are required' }, 400)

    const result = generateLabels(body.spec)
    if (!result.labels.length) return json({ error: 'Nothing to generate - check the input.' }, 422)

    const sql = db()
    const before = (await sql`SELECT count(*)::int AS n FROM labels WHERE site_id = ${siteId}`) as Array<{ n: number }>
    if (body.replace === true) {
      const paired = (await sql`SELECT count(*)::int AS n FROM pairs WHERE site_id = ${siteId}`) as Array<{ n: number }>
      if (paired[0].n > 0)
        return json(
          { error: `${paired[0].n.toLocaleString()} pairs already point at this site's labels. Add to the set instead, or clear the pairs first from Admin.` },
          409,
        )
      await sql`DELETE FROM labels WHERE site_id = ${siteId}`
    }

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
    const after = (await sql`SELECT count(*)::int AS n FROM labels WHERE site_id = ${siteId}`) as Array<{ n: number }>
    return json({
      // What this call produced, what it actually added, and the set's size now.
      stored: result.labels.length,
      added: after[0].n - (body.replace === true ? 0 : before[0].n),
      total: after[0].n,
      replaced: body.replace === true,
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
