/**
 * Minimal auth: PBKDF2 password hashing + an HMAC-signed session cookie.
 *
 * Everything here uses Web Crypto, so it runs unchanged on Node and Edge.
 * No external auth service, no extra dependency - the whole thing is a
 * username, a password and a signed cookie, which is all a warehouse floor
 * tool needs.
 */
import { cookies } from 'next/headers'
import { db } from './db'

const COOKIE = 'lv_session'
const MAX_AGE = 60 * 60 * 12 // 12 hours - one shift
const ITERATIONS = 210_000

const enc = new TextEncoder()

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

/* ---------- passwords ---------- */

export async function hashPassword(password: string, saltHex?: string) {
  const salt = saltHex
    ? unb64(saltHex)
    : crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )
  return { hash: b64(bits), salt: b64(salt) }
}

export async function verifyPassword(password: string, hash: string, salt: string) {
  const { hash: got } = await hashPassword(password, salt)
  // constant-time-ish compare
  if (got.length !== hash.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hash.charCodeAt(i)
  return diff === 0
}

/* ---------- session cookie ---------- */

async function hmacKey() {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET is not set')
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export type Session = { uid: number; name: string; role: string; exp: number }

export async function signSession(s: Session): Promise<string> {
  const payload = b64(enc.encode(JSON.stringify(s)))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(payload))
  return `${payload}.${b64(sig)}`
}

export async function readSession(token: string | undefined): Promise<Session | null> {
  if (!token || !token.includes('.')) return null
  const [payload, sig] = token.split('.')
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(),
      unb64(sig) as BufferSource,
      enc.encode(payload),
    )
    if (!valid) return null
    const s = JSON.parse(new TextDecoder().decode(unb64(payload))) as Session
    if (!s.exp || s.exp < Date.now()) return null
    return s
  } catch {
    return null
  }
}

export async function currentUser(): Promise<Session | null> {
  const jar = await cookies()
  return readSession(jar.get(COOKIE)?.value)
}

export async function setSessionCookie(s: Session) {
  const jar = await cookies()
  jar.set(COOKIE, await signSession(s), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
  })
}

export async function clearSessionCookie() {
  const jar = await cookies()
  jar.set(COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
}

export function sessionFor(u: { id: number; username: string; role: string }): Session {
  return { uid: u.id, name: u.username, role: u.role, exp: Date.now() + MAX_AGE * 1000 }
}

/* ---------- guards ---------- */

export async function requireUser() {
  const u = await currentUser()
  if (!u) throw new AuthError('Not signed in', 401)
  return u
}

export async function requireAdmin() {
  const u = await requireUser()
  if (u.role !== 'admin') throw new AuthError('Admin only', 403)
  return u
}

export class AuthError extends Error {
  status: number
  constructor(msg: string, status: number) {
    super(msg)
    this.status = status
  }
}

/** Look a user up by name. */
export async function findUser(username: string) {
  const sql = db()
  const rows = (await sql`
    SELECT id, username, pass_hash, salt, role, active
    FROM users WHERE lower(username) = lower(${username}) LIMIT 1
  `) as Array<{ id: number; username: string; pass_hash: string; salt: string; role: string; active: boolean }>
  return rows[0] ?? null
}
