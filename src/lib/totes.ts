import { normalizeScan } from './bins.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sql = any

/**
 * Tote capture: a plain list of label numbers, per site.
 *
 * It is not pairing and it is not validation. Nothing is looked up, nothing is
 * compared, nothing is refused for its shape - a tote label is whatever the
 * vendor printed on it, and the job is to write down which ones exist. The one
 * thing it will not do is hold the same code twice: a second scan of a tote
 * already on the list says so and leaves the list as it was, because someone
 * re-scanning a shelf of totes must not silently double the count.
 */
export type Tote = {
  id: number
  code: string
  note: string | null
  username: string | null
  created_at: string
}

/**
 * What a scan means here. The same two boundary rules as every other scan
 * surface: the barcode carries a zone field padded to six characters before
 * the code, so take what follows the last space, and store it uppercase.
 * Everything after that is kept as scanned.
 */
export function toteCode(raw: unknown): string {
  return normalizeScan(String(raw ?? '')).slice(0, 64)
}

export class ToteRefused extends Error {}

export async function captureTote(
  sql: Sql,
  siteId: number,
  userId: number | null,
  raw: unknown,
  note?: unknown,
): Promise<{ tote: Tote; duplicate: boolean; total: number }> {
  const code = toteCode(raw)
  if (!code) throw new ToteRefused('Nothing scanned.')
  const text = String(note ?? '').trim().slice(0, 120) || null

  // ON CONFLICT DO NOTHING, then read back: one round trip either way, and the
  // row that comes back is the first capture - who saw this tote and when.
  const put = (await sql`
    INSERT INTO totes (site_id, code, note, user_id) VALUES (${siteId}, ${code}, ${text}, ${userId})
    ON CONFLICT (site_id, code) DO NOTHING
    RETURNING id`) as Array<{ id: number }>
  const rows = (await sql`
    SELECT t.id, t.code, t.note, t.created_at, u.username
    FROM totes t LEFT JOIN users u ON u.id = t.user_id
    WHERE t.site_id = ${siteId} AND t.code = ${code}`) as Tote[]
  const total = ((await sql`SELECT count(*)::int AS n FROM totes WHERE site_id = ${siteId}`) as Array<{ n: number }>)[0].n
  return { tote: rows[0], duplicate: put.length === 0, total }
}

export async function listTotes(sql: Sql, siteId: number, limit = 200): Promise<{ totes: Tote[]; total: number }> {
  const [totes, count] = await Promise.all([
    sql`SELECT t.id, t.code, t.note, t.created_at, u.username
        FROM totes t LEFT JOIN users u ON u.id = t.user_id
        WHERE t.site_id = ${siteId} ORDER BY t.id DESC LIMIT ${limit}`,
    sql`SELECT count(*)::int AS n FROM totes WHERE site_id = ${siteId}`,
  ])
  return { totes: totes as Tote[], total: (count as Array<{ n: number }>)[0].n }
}

/** Remove one capture - a mis-scan, picked off the list by its id. */
export async function removeTote(sql: Sql, siteId: number, id: number): Promise<string | null> {
  const rows = (await sql`DELETE FROM totes WHERE site_id = ${siteId} AND id = ${id} RETURNING code`) as Array<{ code: string }>
  return rows[0]?.code ?? null
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The whole list, oldest first, as captured. */
export async function totesCsv(sql: Sql, siteId: number): Promise<string> {
  const rows = (await sql`
    SELECT t.code, t.note, t.created_at, u.username
    FROM totes t LEFT JOIN users u ON u.id = t.user_id
    WHERE t.site_id = ${siteId} ORDER BY t.id`) as Tote[]
  const out = ['tote,note,captured_at,by']
  for (const r of rows) out.push([r.code, r.note, new Date(r.created_at).toISOString(), r.username].map(cell).join(','))
  return out.join('\r\n') + '\r\n'
}
