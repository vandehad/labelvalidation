import { NextResponse } from 'next/server'
import { AuthError } from './auth'

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status })

export function fail(e: unknown) {
  if (e instanceof AuthError) return json({ error: e.message }, e.status)
  const msg = e instanceof Error ? e.message : String(e)
  // Never leak a connection string in an error body.
  const safe = msg.replace(/postgres(ql)?:\/\/[^\s"']+/gi, '[db-url]')
  console.error('[api]', safe)
  return json({ error: safe }, 500)
}

/** Every route touches the session or the DB, so nothing here may be cached. */
export const dynamic = 'force-dynamic'
