import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

/**
 * Lazy init. Next evaluates module top-level code at build time, and neon()
 * throws when DATABASE_URL is missing - which would break `next build` before
 * the Marketplace integration has provisioned anything.
 *
 * Deliberately a plain function, not a Proxy wrapper: Proxies around the DB
 * client break libraries that introspect the object.
 */
let _sql: NeonQueryFunction<false, false> | null = null

export function db(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set')
    _sql = neon(url)
  }
  return _sql
}

/** Postgres unique-violation code. */
export const UNIQUE_VIOLATION = '23505'

export function isUniqueViolation(e: unknown): e is { code: string; constraint?: string } {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION
}
