/**
 * Works out which environment variable holds the Postgres connection string.
 *
 * The Neon Marketplace integration does not always inject a plain
 * `DATABASE_URL`. It prefixes everything it creates with the name of the
 * storage, so a store called "labelpg" produces `LABELPG_DATABASE_URL`,
 * `LABELPG_PGHOST`, `LABELPG_POSTGRES_PRISMA_URL` and a dozen more. Requiring
 * someone to hand-copy one of those into `DATABASE_URL` works right up until
 * the day the store is recreated with a different name and the copy goes
 * stale, pointing a live station at a database that no longer exists.
 *
 * So: take `DATABASE_URL` when it is set, otherwise find the prefixed one.
 *
 * Plain .mjs rather than .ts on purpose - `scripts/*.mjs` run under bare node
 * and cannot import TypeScript, and this must not be two implementations that
 * drift apart. `allowJs` is on, so the app imports it just as happily.
 */

/**
 * Variables that are a connection string but the wrong one:
 *   *_UNPOOLED / *_NON_POOLING  bypass the connection pooler, which a
 *                               serverless app wants
 *   *_PRISMA_URL                Prisma's own format, with extra parameters
 *   *_NO_SSL                    unencrypted
 *   *_NEON_AUTH_*, *_VITE_*     Neon Auth, nothing to do with SQL
 */
const WRONG_ONE = /UNPOOLED|NON_POOLING|POOLING|PRISMA|NO_SSL|NEON_AUTH|VITE_/

const looksLikePostgres = v => typeof v === 'string' && /^postgres(ql)?:\/\/.+/i.test(v.trim())

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ url: string, name: string } | null}
 */
export function pickDatabaseUrl(env) {
  const take = name => {
    const v = env[name]
    return looksLikePostgres(v) ? { url: v.trim(), name } : null
  }

  // What the app documents, and what a hand-written .env.local uses.
  const direct = take('DATABASE_URL') ?? take('POSTGRES_URL')
  if (direct) return direct

  // Otherwise whatever the integration injected. Sorted so that two runs on
  // the same environment always choose the same variable.
  const names = Object.keys(env).sort()
  for (const suffix of ['_DATABASE_URL', '_POSTGRES_URL']) {
    for (const name of names) {
      if (!name.endsWith(suffix) || WRONG_ONE.test(name)) continue
      const hit = take(name)
      if (hit) return hit
    }
  }
  return null
}

/** What to tell someone when nothing was found. */
export const DB_URL_HELP = [
  'No Postgres connection string found.',
  '',
  'Looked for DATABASE_URL, POSTGRES_URL, and any *_DATABASE_URL or',
  '*_POSTGRES_URL injected by the Neon integration (e.g. LABELPG_DATABASE_URL).',
  'Pooled URLs only - *_UNPOOLED, *_PRISMA_URL and *_NO_SSL are skipped.',
  '',
  'Locally:  copy .env.example to .env.local and fill in DATABASE_URL,',
  '          or run  vercel env pull .env.local',
].join('\n')
