import { NextResponse } from 'next/server'
import { issueSignedToken, presignUrl } from '@vercel/blob'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { RELAY_EXE_KEY, parseRelayExe, pickBlobStoreId } from '@/lib/relayexe.mjs'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Long enough to click, short enough that a copied link is worth nothing. */
const LINK_MINUTES = 5

/**
 * print-server.exe, for whoever is setting up a relay.
 *
 * The file sits in a private Blob store, so this does not serve it - 90 MB
 * through a function is the wrong way round. It checks the caller is an admin
 * and redirects to a link the store itself honours for a few minutes.
 */
export async function GET() {
  try {
    await requireAdmin()
    const rows = (await db()`SELECT value FROM settings WHERE key = ${RELAY_EXE_KEY}`) as Array<{ value: string }>
    const exe = parseRelayExe(rows[0]?.value)
    if (!exe) return json({ error: 'No relay has been published yet. Run: npm run publish-exe' }, 404)

    const storeId = pickBlobStoreId(process.env)
    if (!storeId) return json({ error: 'No Blob store is connected to this deployment.' }, 500)

    const validUntil = Date.now() + LINK_MINUTES * 60_000
    const token = await issueSignedToken({ storeId, pathname: exe.pathname, operations: ['get'], validUntil })
    const { presignedUrl } = await presignUrl(token, {
      operation: 'get',
      pathname: exe.pathname,
      access: 'private',
      validUntil,
      // Straight from the store: a republished exe must never be an older one out of a cache.
      useCache: false,
    })
    return NextResponse.redirect(presignedUrl, 302)
  } catch (e) {
    return fail(e)
  }
}
