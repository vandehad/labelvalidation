/**
 * Publishes the relay so the Admin tab can offer it as a download.
 *
 *   npm run build-exe      # first, if the relay changed
 *   npm run publish-exe
 *
 * Uploads the newest build in dist/ to the project's private Blob store and
 * records what it uploaded in `settings`, which is what the Print relays card
 * shows. The upload goes through the Vercel CLI, so it uses the login and the
 * project link already on this PC - there is no token to keep in a file.
 *
 * Nothing publishes by itself. What the card offers is whatever this was last
 * run on, and the build date beside the link is how anyone tells.
 */
import { execSync } from 'node:child_process'
import { existsSync, statSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { parse } from 'dotenv'
import { requireDatabaseUrl } from './env.mjs'
import { RELAY_EXE_PATH, RELAY_EXE_KEY, pickBlobStoreId } from '../src/lib/relayexe.mjs'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')

// build-exe writes print-server.new.exe when print-server.exe is the one a
// relay is running from, so the current build is whichever is newer.
const builds = ['print-server.exe', 'print-server.new.exe']
  .map(n => join(dist, n))
  .filter(existsSync)
  .map(p => {
    // Named one by one: mtime is a getter on Stats and a spread leaves it behind.
    const s = statSync(p)
    return { path: p, size: s.size, mtime: s.mtime, mtimeMs: s.mtimeMs }
  })
  .sort((a, b) => b.mtimeMs - a.mtimeMs)

const exe = builds[0]
if (!exe) {
  console.error('No build in dist/. Run: npm run build-exe')
  process.exit(1)
}
// A plain copy of node.exe is what a failed injection leaves behind.
if (exe.size < 50 * 1024 * 1024) {
  console.error(`${exe.path} is only ${(exe.size / 1024 / 1024).toFixed(1)} MB - that is not a relay build. Nothing was published.`)
  process.exit(1)
}

const sql = neon(requireDatabaseUrl())
const mb = (exe.size / 1024 / 1024).toFixed(0)
console.log(`1/2  uploading ${exe.path.slice(root.length + 1)}  (${mb} MB, built ${exe.mtime.toLocaleString()})`)

// The store takes no static token: it is reached with a short-lived OIDC token
// for the project plus the store's id. Both come from the project's
// Development environment, so pull them fresh - a token left in .env.local
// from this morning has expired by this afternoon. Pulled to a file of its own
// and removed, because `vercel env pull .env.local` would replace that file.
// shell:true because `vercel` is a .cmd shim on Windows; paths are quoted
// because the shell would otherwise split them on a space.
// One string, not an argument list: node warns about a list handed to a shell.
const vercel = (args, opts = {}) => execSync(['vercel', ...args].join(' '), { cwd: root, ...opts })
const pulled = join(dist, `.publish-${Date.now()}.env`)
let creds = {}
try {
  vercel(['env', 'pull', JSON.stringify(pulled), '--environment=development', '--yes'], { stdio: 'ignore' })
  creds = parse(readFileSync(pulled))
} catch {
  console.error('')
  console.error('  FAILED: could not read the project environment from Vercel. Nothing was uploaded.')
  console.error('          Check `vercel whoami` and that this folder is linked (`vercel link`).')
  process.exit(1)
} finally {
  try { rmSync(pulled) } catch {}
}
const storeId = pickBlobStoreId(creds)
if (!creds.VERCEL_OIDC_TOKEN || !storeId) {
  console.error('')
  console.error('  FAILED: the Blob store is not connected to the Development environment, so this PC')
  console.error('          has nothing to upload with. Nothing was uploaded. Connect it once with:')
  console.error('            vercel storage update labelvalidation-blob -e production -e preview -e development')
  process.exit(1)
}

try {
  vercel(
    ['blob', 'put', JSON.stringify(exe.path), '--access', 'private', '--pathname', RELAY_EXE_PATH, '--force', '--cache-control-max-age', '60'],
    { stdio: 'inherit', env: { ...process.env, VERCEL_OIDC_TOKEN: creds.VERCEL_OIDC_TOKEN, BLOB_STORE_ID: storeId } },
  )
} catch {
  console.error('')
  console.error('  FAILED: the upload did not finish, and the download link was left as it was.')
  process.exit(1)
}

// Only after the upload: the row must never describe a file that is not there.
console.log('2/2  recording it for the Admin tab')
const value = JSON.stringify({
  pathname: RELAY_EXE_PATH,
  size: exe.size,
  built: exe.mtime.toISOString(),
  published: new Date().toISOString(),
})
await sql`
  INSERT INTO settings (key, value) VALUES (${RELAY_EXE_KEY}, ${value})
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`

console.log('')
console.log('  published. Admin -> Print relays now offers this build.')
