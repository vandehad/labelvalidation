/**
 * Environment loading for the plain-node scripts.
 *
 * Next auto-loads .env files; bare node does not, and `dotenv/config` reads
 * `.env` only — while the README says to use `.env.local` and `vercel env
 * pull` writes `.env.local`. Load both, nearest first.
 *
 * dotenv never overwrites a variable that is already set, so a real
 * environment variable beats .env.local, which beats .env.
 */
import { config } from 'dotenv'
import { pickDatabaseUrl, DB_URL_HELP } from '../src/lib/dburl.mjs'

config({ path: '.env.local' })
config()

/** The connection string, or exit with something useful to read. */
export function requireDatabaseUrl() {
  const found = pickDatabaseUrl(process.env)
  if (!found) {
    console.error(DB_URL_HELP)
    process.exit(1)
  }
  if (found.name !== 'DATABASE_URL') console.log(`  using ${found.name}`)
  return found.url
}
