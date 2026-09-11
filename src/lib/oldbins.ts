/**
 * The WMS old-bin list: what has to end up paired.
 *
 * The label set is deliberately a superset - more labels than shelves, so
 * that every shelf has a label waiting - which makes "labels paired" a poor
 * measure of progress. The measure that matters is how many of the bins the
 * WMS knows about have been paired to a new label. That list is loaded here,
 * per site, separately from pairs and from the label set, and never changes
 * either of them.
 *
 * Comparison is on a canonical form. The WMS writes `01-09-03-05`; a scanned
 * old label or a typed id may come back `1-9-3-5`. `canonOld` pads each part
 * of a dash-separated numeric id to two digits and uppercases everything
 * else. The same rule lives in Postgres as `canon_old()` so the count is a
 * hash join, not a per-row scan. Keep the two in step - `scripts/test.ts`
 * checks the JavaScript one.
 */

type Sql = ReturnType<typeof import('./db').db>

export function canonOld(raw: string): string {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase()
  // Bare digits that can only mean one bin: eight is two digits a part,
  // four is one digit a part. `01090305` and `1935` are both `01-09-03-05`.
  // Five to seven digits split more than one way and are left for the
  // report to suggest against the WMS list.
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  if (/^\d{4}$/.test(s)) return s.split('').map(d => '0' + d).join('-')
  // Dashed parts pad to two: `1-9-3-5` is `01-09-03-05`.
  const m = /^(\d+)-(\d+)-(\d+)-(\d+)$/.exec(s)
  if (!m) return s
  return m
    .slice(1)
    .map(p => (p.length < 2 ? p.padStart(2, '0') : p))
    .join('-')
}

/** A bin id in the WMS's own shape: two digits, two, two or three, two. */
export function looksLikeWmsBin(canon: string): boolean {
  return /^\d{2}-\d{2}-\d{2,3}-\d{2}$/.test(canon)
}

/** Ids that name a WMS concept rather than a shelf. Not loaded; nothing will ever pair to them. */
export const NOT_A_SHELF = new Set(['NO_BIN', 'UNASSIGNED', 'BIN', 'BINID', 'USERBINID', 'OLD BIN', 'OLDBIN'])

/** Clean a pasted or uploaded column into the ids to load, dropping blanks, headers and duplicates. */
export function cleanOldBins(raw: string[]): { bins: string[]; dropped: string[] } {
  const seen = new Set<string>()
  const bins: string[] = []
  const dropped: string[] = []
  for (const r of raw) {
    // Quotes and whitespace are packaging, not id. A WMS export had the same
    // bin twice, once as `04-32-06-02` and once as `" 04-32-06-02"`.
    const s = String(r ?? '')
      .replace(/^[\s"']+|[\s"']+$/g, '')
      .toUpperCase()
    if (!s) continue
    if (NOT_A_SHELF.has(s)) {
      dropped.push(s)
      continue
    }
    if (seen.has(s)) continue
    seen.add(s)
    bins.push(s)
  }
  return { bins, dropped }
}

export type Progress = { total: number; paired: number; unpaired: number }

export async function loadOldBins(sql: Sql, siteId: number, bins: string[], replace: boolean): Promise<{ added: number; total: number }> {
  const before = (await sql`SELECT count(*)::int AS n FROM old_bins WHERE site_id = ${siteId}`) as Array<{ n: number }>
  if (replace) await sql`DELETE FROM old_bins WHERE site_id = ${siteId}`
  const CHUNK = 5000
  for (let i = 0; i < bins.length; i += CHUNK) {
    const slice = bins.slice(i, i + CHUNK)
    await sql`
      INSERT INTO old_bins (site_id, old_bin, canon)
      SELECT ${siteId}, b, canon_old(b) FROM unnest(${slice}::text[]) AS b
      ON CONFLICT (site_id, old_bin) DO NOTHING`
  }
  const after = (await sql`SELECT count(*)::int AS n FROM old_bins WHERE site_id = ${siteId}`) as Array<{ n: number }>
  return { added: after[0].n - (replace ? 0 : before[0].n), total: after[0].n }
}

/** How many WMS bins are paired. `total` 0 means no list is loaded for the site. */
export async function progress(sql: Sql, siteId: number): Promise<Progress> {
  const rows = (await sql`
    WITH pc AS (SELECT DISTINCT canon_old(old_bin) AS c FROM pairs WHERE site_id = ${siteId})
    SELECT (SELECT count(*)::int FROM old_bins WHERE site_id = ${siteId}) AS total,
           (SELECT count(*)::int FROM old_bins o JOIN pc ON pc.c = o.canon WHERE o.site_id = ${siteId}) AS paired`) as Array<{
    total: number
    paired: number
  }>
  const { total, paired } = rows[0]
  return { total, paired, unpaired: total - paired }
}

/** The exception report: WMS bins nothing has been paired to yet. */
export async function unpairedOldBins(sql: Sql, siteId: number, limit: number | null): Promise<string[]> {
  const rows = (await (limit === null
    ? sql`
      WITH pc AS (SELECT DISTINCT canon_old(old_bin) AS c FROM pairs WHERE site_id = ${siteId})
      SELECT o.old_bin FROM old_bins o LEFT JOIN pc ON pc.c = o.canon
      WHERE o.site_id = ${siteId} AND pc.c IS NULL ORDER BY o.old_bin`
    : sql`
      WITH pc AS (SELECT DISTINCT canon_old(old_bin) AS c FROM pairs WHERE site_id = ${siteId})
      SELECT o.old_bin FROM old_bins o LEFT JOIN pc ON pc.c = o.canon
      WHERE o.site_id = ${siteId} AND pc.c IS NULL ORDER BY o.old_bin LIMIT ${limit}`)) as Array<{ old_bin: string }>
  return rows.map(r => r.old_bin)
}

/* ---------- suspect old bins: pairs whose old bin is not a WMS bin ---------- */

export type SuspectKind = 'upc' | 'similar' | 'unknown' | 'extra'
export type Suspect = {
  old_bin: string
  new_bin: string
  username: string | null
  kind: SuspectKind
  /** WMS bins this was probably meant to be. One means "Use suggestion" is safe. */
  suggestions: string[]
}

/**
 * What a non-matching old bin probably is.
 *
 *   upc      nine or more digits - a product barcode scanned instead of the
 *            shelf label. Nothing to suggest; the shelf has to be re-scanned.
 *   similar  a run of 4-8 digits that splits into a WMS bin: `01090305` and
 *            `1935` both mean `01-09-03-05`. Every split into four parts of
 *            one or two digits is tried against the WMS list; only real WMS
 *            bins are suggested, so a unique suggestion can be applied.
 *   extra    a bin in the WMS's own shape that the WMS list does not have.
 *            Not an exception: a real shelf the list missed. Listed apart,
 *            and never counted toward the WMS total.
 *   unknown  anything else - a code from another site, a typo with letters.
 *
 * Eight and four bare digits never arrive here: `canonOld` already reads them
 * as the one bin they can mean, so they count as paired outright.
 */
export function suggestOldBin(raw: string, wmsCanons: Set<string>): { kind: SuspectKind; suggestions: string[] } {
  const s = canonOld(raw)
  if (looksLikeWmsBin(s)) return { kind: 'extra', suggestions: [] }
  const digits = /^\d+$/.test(s) ? s : /^[\d-]+$/.test(s) ? s.replace(/-/g, '') : null
  if (digits === null) return { kind: 'unknown', suggestions: [] }
  if (digits.length >= 9) return { kind: 'upc', suggestions: [] }
  if (digits.length < 4) return { kind: 'unknown', suggestions: [] }
  const found = new Set<string>()
  for (const a of [1, 2])
    for (const b of [1, 2])
      for (const c of [1, 2])
        for (const d of [1, 2]) {
          if (a + b + c + d !== digits.length) continue
          const parts = [digits.slice(0, a), digits.slice(a, a + b), digits.slice(a + b, a + b + c), digits.slice(a + b + c)]
          const cand = parts.map(p => p.padStart(2, '0')).join('-')
          if (wmsCanons.has(cand)) found.add(cand)
        }
  return { kind: found.size ? 'similar' : 'unknown', suggestions: [...found].sort() }
}

/**
 * Pairs whose old bin is not in the WMS list. Placeholder-paired shelves
 * (`origin = 'minted'`) are not suspects - they never had an old bin.
 */
export async function suspectPairs(sql: Sql, siteId: number): Promise<Suspect[]> {
  const rows = (await sql`
    SELECT p.old_bin, p.new_bin, u.username
    FROM pairs p LEFT JOIN users u ON u.id = p.user_id
    WHERE p.site_id = ${siteId} AND p.origin <> 'minted'
      AND NOT EXISTS (SELECT 1 FROM old_bins o WHERE o.site_id = p.site_id AND o.canon = canon_old(p.old_bin))
    ORDER BY p.old_bin`) as Array<{ old_bin: string; new_bin: string; username: string | null }>
  if (!rows.length) return []
  const canons = new Set(
    ((await sql`SELECT canon FROM old_bins WHERE site_id = ${siteId}`) as Array<{ canon: string }>).map(r => r.canon),
  )
  return rows.map(r => ({ ...r, ...suggestOldBin(r.old_bin, canons) }))
}
