import { zplBatch, DEFAULT_LABEL } from './zpl.ts'

/**
 * The print queue.
 *
 * A browser cannot reach a Zebra, and a browser on the floor cannot reach the
 * PC the Zebra is plugged into either: the relay listens on that PC's own
 * loopback, and Chrome refuses to let an https page call an http address on
 * the LAN in any case. The only path that works from everywhere is the one
 * that goes *out*: the relay polls the app over https, which any PC can do.
 *
 * So the screens do not print. They queue a job here, and the relay signed in
 * to that site pulls it, prints it and reports back. The desktop, a TC52, a
 * phone and the MC92N0 all print the same way, and none of them has to know
 * where the printer is.
 *
 * A relay is bound to one site - it is told which on its setup page - so two
 * sites queuing at once each get their own labels, on their own printer.
 */

type Sql = ReturnType<typeof import('./db').db>

export type JobStatus = 'queued' | 'printing' | 'done' | 'failed'

export type Job = {
  id: number
  site_id: number
  labels: number
  copies: number
  relay: string | null
  status: JobStatus
  error: string | null
  username: string | null
  created_at: string
  claimed_at: string | null
  claimed_by: string | null
  done_at: string | null
}

export type RelaySeen = {
  name: string
  site_id: number | null
  site_name: string | null
  target: string | null
  version: string | null
  printed: number
  last_seen: string
  online: boolean
}

/** Labels per job. A run of thousands becomes a series of these, each with visible progress. */
export const CHUNK = 500

/** A relay that has not polled for this long is shown as offline. It polls every 2-15 s. */
export const ONLINE_SECONDS = 45

/** A job claimed this long ago and never finished goes back in the queue - the relay died mid-print. */
export const STALE_MINUTES = 3

/* ---------- pure helpers, tested ---------- */

/** `Authorization: Bearer <key>` → the key, or null. */
export function parseBearer(header: string | null | undefined): string | null {
  const m = /^\s*Bearer\s+([A-Za-z0-9._~+/=-]+)\s*$/i.exec(header ?? '')
  return m ? m[1] : null
}

/** A relay's name as it identifies itself: trimmed, bounded, never empty. */
export function relayName(raw: string | null | undefined): string {
  const s = String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 40)
  return s || 'relay'
}

/** Codes, uppercased and deduplicated, in slices of `size`. */
export function chunkCodes(codes: string[], size = CHUNK): string[][] {
  const seen = new Set<string>()
  const clean: string[] = []
  for (const c of codes) {
    const u = String(c ?? '')
      .trim()
      .toUpperCase()
    if (u && !seen.has(u)) {
      seen.add(u)
      clean.push(u)
    }
  }
  const out: string[][] = []
  for (let i = 0; i < clean.length; i += size) out.push(clean.slice(i, i + size))
  return out
}

export function newRelayKey(): string {
  const hex = () => crypto.randomUUID().replace(/-/g, '')
  return 'lvr_' + hex() + hex().slice(0, 16)
}

/** Constant-time-ish comparison, so a wrong key takes as long as a right one. */
export function sameKey(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/* ---------- the relay key ---------- */

export async function relayKey(sql: Sql): Promise<string> {
  const rows = (await sql`SELECT value FROM settings WHERE key = 'relay_key'`) as Array<{ value: string }>
  if (rows[0]) return rows[0].value
  // The migration seeds one; this covers a database that predates it. ON
  // CONFLICT so two first calls at once agree on which key won.
  await sql`INSERT INTO settings (key, value) VALUES ('relay_key', ${newRelayKey()}) ON CONFLICT (key) DO NOTHING`
  const again = (await sql`SELECT value FROM settings WHERE key = 'relay_key'`) as Array<{ value: string }>
  return again[0].value
}

export async function rotateRelayKey(sql: Sql): Promise<string> {
  const key = newRelayKey()
  await sql`
    INSERT INTO settings (key, value) VALUES ('relay_key', ${key})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`
  return key
}

export class RelayDenied extends Error {
  status = 401
}

export class QueueRefused extends Error {
  status: number
  constructor(msg: string, status = 400) {
    super(msg)
    this.status = status
  }
}

/** The relay's bearer key has to match. Returns the name it calls itself. */
export async function requireRelay(sql: Sql, req: Request): Promise<string> {
  const key = parseBearer(req.headers.get('authorization'))
  if (!key || !sameKey(key, await relayKey(sql)))
    throw new RelayDenied('Relay key is wrong or missing. Copy the current one from the Admin tab.')
  return relayName(new URL(req.url).searchParams.get('relay'))
}

export async function heartbeat(
  sql: Sql,
  name: string,
  siteId: number | null,
  target: string | null,
  version: string | null,
): Promise<void> {
  await sql`
    INSERT INTO relays (name, site_id, target, version, last_seen)
    VALUES (${name}, ${siteId}, ${target}, ${version}, now())
    ON CONFLICT (name) DO UPDATE
      SET site_id = EXCLUDED.site_id, target = EXCLUDED.target, version = EXCLUDED.version, last_seen = now()`
}

/* ---------- queuing ---------- */

export type QueueInput = {
  siteId: number
  userId: number
  codes: string[]
  copies?: number
  /** Pin to one relay by name; null lets any relay signed in to the site take it. */
  relay?: string | null
  /**
   * ZPL already rendered by the caller (the desktop, with its stock and nudge
   * settings). Without it the site format is rendered here. Either way the
   * codes must be in the site's stored label set - a reprint comes out of
   * what is stored, never out of thin air.
   */
  zpl?: string
}

export async function queueJobs(sql: Sql, input: QueueInput): Promise<Job[]> {
  const copies = Math.min(99, Math.max(1, Math.floor(Number(input.copies) || 1)))
  const chunks = input.zpl ? [chunkCodes(input.codes, Infinity)[0] ?? []] : chunkCodes(input.codes)
  const all = chunks.flat()
  if (!all.length) throw new QueueRefused('Nothing to print.')

  const stored = (await sql`
    SELECT code FROM labels WHERE site_id = ${input.siteId} AND code = ANY(${all})`) as Array<{ code: string }>
  const have = new Set(stored.map(r => r.code))
  const missing = all.filter(c => !have.has(c))
  if (missing.length)
    throw new QueueRefused(
      `Not in this site's label set, so not printed: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}. Generate or add them first.`,
      422,
    )

  // Rendered here for the screens that have no Print card: the site format,
  // at the stock the site's Print card chose. The width rides in every label.
  const siteRows = (await sql`SELECT label_width FROM sites WHERE id = ${input.siteId}`) as Array<{ label_width: number }>
  if (!siteRows[0]) throw new QueueRefused('No such site.', 404)
  const widthIn = Number(siteRows[0].label_width) === 3 ? 3 : 4

  const relay = input.relay ? relayName(input.relay) : null
  const jobs: Job[] = []
  for (const codes of chunks) {
    const zpl = input.zpl ?? zplBatch(codes, { ...DEFAULT_LABEL, widthIn, copies })
    const rows = (await sql`
      INSERT INTO print_jobs (site_id, codes, copies, zpl, relay, user_id)
      VALUES (${input.siteId}, ${codes}, ${copies}, ${zpl}, ${relay}, ${input.userId})
      RETURNING id, site_id, cardinality(codes)::int AS labels, copies, relay, status, error,
                created_at, claimed_at, claimed_by, done_at`) as Array<Omit<Job, 'username'>>
    jobs.push({ ...rows[0], username: null })
  }
  return jobs
}

/** Names of relays that could take a job for this site right now. */
export async function onlineRelays(sql: Sql, siteId: number, relay?: string | null): Promise<string[]> {
  const rows = (await sql`
    SELECT name FROM relays
    WHERE site_id = ${siteId} AND last_seen > now() - make_interval(secs => ${ONLINE_SECONDS})
    ORDER BY name`) as Array<{ name: string }>
  const names = rows.map(r => r.name)
  return relay ? names.filter(n => n === relayName(relay)) : names
}

/* ---------- the relay's side ---------- */

export type Claimed = { id: number; codes: string[]; copies: number; zpl: string }

/**
 * Hand the next job for this site to the relay that asked. One statement
 * does the claim - `FOR UPDATE SKIP LOCKED` - so two relays on one site
 * never print the same job.
 */
export async function claimNext(sql: Sql, siteId: number, name: string): Promise<Claimed | null> {
  await sql`
    UPDATE print_jobs SET status = 'queued', claimed_at = NULL, claimed_by = NULL
    WHERE status = 'printing' AND claimed_at < now() - make_interval(mins => ${STALE_MINUTES})`
  const rows = (await sql`
    UPDATE print_jobs SET status = 'printing', claimed_at = now(), claimed_by = ${name}
    WHERE id = (
      SELECT id FROM print_jobs
      WHERE site_id = ${siteId} AND status = 'queued' AND (relay IS NULL OR relay = ${name})
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
    RETURNING id, codes, copies, zpl`) as Claimed[]
  return rows[0] ?? null
}

export async function finishJob(sql: Sql, id: number, name: string, ok: boolean, error: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE print_jobs
    SET status = ${ok ? 'done' : 'failed'}, error = ${ok ? null : error.slice(0, 500)}, done_at = now()
    WHERE id = ${id} AND claimed_by = ${name} AND status = 'printing'
    RETURNING site_id, codes, cardinality(codes)::int AS labels, copies`) as Array<{
    site_id: number
    codes: string[]
    labels: number
    copies: number
  }>
  const job = rows[0]
  if (!job) return false
  if (ok) {
    await sql`UPDATE labels SET printed_at = now() WHERE site_id = ${job.site_id} AND code = ANY(${job.codes})`
    await sql`UPDATE relays SET printed = printed + ${job.labels * job.copies} WHERE name = ${name}`
  }
  return true
}

/* ---------- what the screens show ---------- */

export async function listJobs(sql: Sql, siteId: number, limit = 20): Promise<Job[]> {
  return (await sql`
    SELECT j.id, j.site_id, cardinality(j.codes)::int AS labels, j.copies, j.relay, j.status, j.error,
           u.username, j.created_at, j.claimed_at, j.claimed_by, j.done_at
    FROM print_jobs j LEFT JOIN users u ON u.id = j.user_id
    WHERE j.site_id = ${siteId}
    ORDER BY j.id DESC LIMIT ${limit}`) as Job[]
}

export async function jobById(sql: Sql, id: number): Promise<Job | null> {
  const rows = (await sql`
    SELECT j.id, j.site_id, cardinality(j.codes)::int AS labels, j.copies, j.relay, j.status, j.error,
           u.username, j.created_at, j.claimed_at, j.claimed_by, j.done_at
    FROM print_jobs j LEFT JOIN users u ON u.id = j.user_id
    WHERE j.id = ${id}`) as Job[]
  return rows[0] ?? null
}

/** Only a job nobody has started can be cancelled. */
export async function cancelJob(sql: Sql, id: number): Promise<boolean> {
  const rows = await sql`DELETE FROM print_jobs WHERE id = ${id} AND status = 'queued' RETURNING id`
  return rows.length > 0
}

export async function retryJob(sql: Sql, id: number): Promise<boolean> {
  const rows = await sql`
    UPDATE print_jobs SET status = 'queued', error = NULL, claimed_at = NULL, claimed_by = NULL, done_at = NULL
    WHERE id = ${id} AND status = 'failed' RETURNING id`
  return rows.length > 0
}

export async function relaysSeen(sql: Sql, siteId?: number): Promise<RelaySeen[]> {
  const rows = (await sql`
    SELECT r.name, r.site_id, s.name AS site_name, r.target, r.version, r.printed, r.last_seen,
           (r.last_seen > now() - make_interval(secs => ${ONLINE_SECONDS})) AS online
    FROM relays r LEFT JOIN sites s ON s.id = r.site_id
    WHERE ${siteId ?? null}::int IS NULL OR r.site_id = ${siteId ?? null}
    ORDER BY online DESC, r.last_seen DESC`) as RelaySeen[]
  return rows
}
