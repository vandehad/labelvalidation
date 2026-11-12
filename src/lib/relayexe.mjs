/**
 * The relay download: where print-server.exe lives and what the app knows
 * about the copy that was last published.
 *
 * The exe is ~90 MB and `dist/` is not in git, so it cannot ship with the app.
 * `npm run publish-exe` uploads it to the project's private Blob store and
 * writes one `settings` row describing it; the Admin tab reads that row and
 * `/api/print/download` turns it into a link that lasts a few minutes.
 *
 * Plain .mjs for the same reason as `dburl.mjs`: the publish script runs under
 * bare node, and the pathname and the row's shape must not be written twice.
 */

/** One fixed name. A relay PC that downloads again gets the same file name. */
export const RELAY_EXE_PATH = 'relay/print-server.exe'

/** The `settings` key the published copy is described under. */
export const RELAY_EXE_KEY = 'relay_exe'

/**
 * Which Blob store. Vercel prefixes what a store injects with the name it was
 * connected under - `LABELVAL_STORE_ID` here - exactly as the Neon integration
 * does with the database, so look for it instead of asking anyone to copy it.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function pickBlobStoreId(env) {
  const ok = v => typeof v === 'string' && /^store_[A-Za-z0-9]+$/.test(v.trim())
  if (ok(env.BLOB_STORE_ID)) return env.BLOB_STORE_ID.trim()
  for (const name of Object.keys(env).sort()) {
    if (name.endsWith('_STORE_ID') && ok(env[name])) return env[name].trim()
  }
  return null
}

/**
 * The `settings` value, read back. Null for anything that is not a published
 * exe - the card then shows no link rather than one that leads nowhere.
 *
 * @param {string | null | undefined} value
 * @returns {{ pathname: string, size: number, built: string, published: string } | null}
 */
export function parseRelayExe(value) {
  if (!value) return null
  try {
    const v = JSON.parse(value)
    if (typeof v?.pathname !== 'string' || !v.pathname) return null
    if (!Number.isFinite(v.size) || v.size <= 0) return null
    if (isNaN(Date.parse(v.built)) || isNaN(Date.parse(v.published))) return null
    return { pathname: v.pathname, size: v.size, built: v.built, published: v.published }
  } catch {
    return null
  }
}
