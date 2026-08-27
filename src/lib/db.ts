import { neon, type NeonQueryFunction } from '@neondatabase/serverless'
import { pickDatabaseUrl, DB_URL_HELP } from './dburl.mjs'

/**
 * Lazy init. Next evaluates module top-level code at build time, and neon()
 * throws when the connection string is missing - which would break
 * `next build` before the Marketplace integration has provisioned anything.
 *
 * Deliberately a plain function, not a Proxy wrapper: Proxies around the DB
 * client break libraries that introspect the object.
 *
 * The variable is resolved rather than named outright, because the Neon
 * integration prefixes what it injects with the storage name - see dburl.mjs.
 */
let _sql: NeonQueryFunction<false, false> | null = null

export function db(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const found = pickDatabaseUrl(process.env)
    if (!found) throw new Error(DB_URL_HELP)
    _sql = neon(found.url)
  }
  return _sql
}

/** Postgres unique-violation code. */
export const UNIQUE_VIOLATION = '23505'

export function isUniqueViolation(e: unknown): e is { code: string; constraint?: string } {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION
}
