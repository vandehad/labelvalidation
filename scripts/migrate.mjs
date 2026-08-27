/**
 * Creates the schema. Safe to run repeatedly.
 *   npm run migrate
 *
 * The unique constraints on pairs are the point of the whole app: they make
 * the one-for-one guarantee a property of the database, so two people
 * scanning the same shelf at the same time cannot both succeed.
 */
import 'dotenv/config'
import { neon } from '@neondatabase/serverless'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in,')
  console.error('or run:  vercel env pull .env.local')
  process.exit(1)
}
const sql = neon(url)

const steps = [
  [
    'users',
    `CREATE TABLE IF NOT EXISTS users (
      id         serial PRIMARY KEY,
      username   text NOT NULL,
      pass_hash  text NOT NULL,
      salt       text NOT NULL,
      role       text NOT NULL DEFAULT 'scanner',
      active     boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  ],
  ['users lower(username) unique', `CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username))`],
  [
    'sites',
    `CREATE TABLE IF NOT EXISTS sites (
      id         serial PRIMARY KEY,
      name       text NOT NULL UNIQUE,
      status     text NOT NULL DEFAULT 'open',
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  ],
  [
    'labels',
    `CREATE TABLE IF NOT EXISTS labels (
      id       serial PRIMARY KEY,
      site_id  integer NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      code     text NOT NULL,
      zone     text NOT NULL,
      aisle    integer NOT NULL,
      col      integer NOT NULL,
      letter   text NOT NULL,
      printed  boolean NOT NULL DEFAULT true,
      UNIQUE (site_id, code)
    )`,
  ],
  ['labels by site', `CREATE INDEX IF NOT EXISTS labels_site_idx ON labels (site_id, zone, aisle, col)`],
  [
    'pairs',
    `CREATE TABLE IF NOT EXISTS pairs (
      id         serial PRIMARY KEY,
      site_id    integer NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      old_bin    text NOT NULL,
      new_bin    text NOT NULL,
      location   text,
      user_id    integer REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pairs_old_unique UNIQUE (site_id, old_bin),
      CONSTRAINT pairs_new_unique UNIQUE (site_id, new_bin)
    )`,
  ],
  ['pairs by site', `CREATE INDEX IF NOT EXISTS pairs_site_idx ON pairs (site_id, created_at DESC)`],
  ['pairs by user', `CREATE INDEX IF NOT EXISTS pairs_user_idx ON pairs (site_id, user_id)`],
  [
    'bin_map',
    `CREATE TABLE IF NOT EXISTS bin_map (
      site_id  integer NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      old_bin  text NOT NULL,
      new_bin  text NOT NULL,
      row_no   integer,
      PRIMARY KEY (site_id, old_bin)
    )`,
  ],
  ['bin_map by new bin', `CREATE INDEX IF NOT EXISTS bin_map_new_idx ON bin_map (site_id, new_bin)`],
  [
    'checks',
    `CREATE TABLE IF NOT EXISTS checks (
      id           serial PRIMARY KEY,
      site_id      integer NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      source       text NOT NULL,
      old_bin      text NOT NULL,
      new_bin      text NOT NULL,
      expected_bin text,
      verdict      text NOT NULL,
      user_id      integer REFERENCES users(id),
      created_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT checks_old_unique UNIQUE (site_id, source, old_bin)
    )`,
  ],
  ['checks by site', `CREATE INDEX IF NOT EXISTS checks_site_idx ON checks (site_id, source, created_at DESC)`],
  ['checks by verdict', `CREATE INDEX IF NOT EXISTS checks_verdict_idx ON checks (site_id, source, verdict)`],
]

for (const [name, ddl] of steps) {
  await sql(ddl)
  console.log('  ok  ' + name)
}

const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`
console.log(`\nSchema ready. ${count} user(s) exist.`)
if (count === 0) console.log('Create the first one with:  npm run user -- <name> <password> admin')
