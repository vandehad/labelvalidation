/**
 * Add or update a user.
 *   npm run user -- <username> <password> [role]
 * role is "scanner" (default) or "admin".
 */
import { neon } from '@neondatabase/serverless'
import { requireDatabaseUrl } from './env.mjs'

const [username, password, role = 'scanner'] = process.argv.slice(2)
if (!username || !password) {
  console.error('usage: npm run user -- <username> <password> [scanner|admin]')
  process.exit(1)
}
if (password.length < 6) {
  console.error('Password must be at least 6 characters.')
  process.exit(1)
}
if (!['scanner', 'admin'].includes(role)) {
  console.error('Role must be "scanner" or "admin".')
  process.exit(1)
}

const sql = neon(requireDatabaseUrl())

const ITERATIONS = 210_000
const enc = new TextEncoder()
const b64 = b => Buffer.from(b).toString('base64url')

const salt = crypto.getRandomValues(new Uint8Array(16))
const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
const bits = await crypto.subtle.deriveBits(
  { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
  key,
  256,
)

const rows = await sql`
  INSERT INTO users (username, pass_hash, salt, role)
  VALUES (${username}, ${b64(new Uint8Array(bits))}, ${b64(salt)}, ${role})
  ON CONFLICT (lower(username)) DO UPDATE
    SET pass_hash = EXCLUDED.pass_hash, salt = EXCLUDED.salt, role = EXCLUDED.role, active = true
  RETURNING id, username, role
`
console.log(`ok: ${rows[0].username} (${rows[0].role}), id ${rows[0].id}`)
