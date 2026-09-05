/**
 * Creates the schema. Safe to run repeatedly.
 *   npm run migrate
 *
 * The unique constraints on pairs are the point of the whole app: they make
 * the one-for-one guarantee a property of the database, so two people
 * scanning the same shelf at the same time cannot both succeed.
 */
import { neon } from '@neondatabase/serverless'
import { randomUUID } from 'node:crypto'
import { requireDatabaseUrl } from './env.mjs'

// --print emits the SQL and stops, without needing a connection string at all.
// Vercel marks integration variables as sensitive, so their values cannot be
// pulled to a laptop; this lets the schema be pasted into the Neon SQL editor
// instead. Same statements either way - there is no second copy to drift.
const printOnly = process.argv.includes('--print')

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

  // ---- bins added during the conversion --------------------------------
  // A shelf found with no old label still needs a code, a printed label and
  // somebody to hang it. It has no old counterpart, so left alone it looks
  // like a label nobody paired - and reconcile would list it under "unused,
  // delete these". Deleting it is how a freshly hung shelf becomes a bin the
  // WMS cannot find. It gets a placeholder old bin instead and stays in
  // `pairs`, so every existing rule holds unchanged.
  ['minted bin numbers', `CREATE SEQUENCE IF NOT EXISTS minted_bin_seq`],
  // origin is what queries branch on - never the NEW- prefix, which is a
  // convention someone will eventually type into a scan field.
  ['pairs.origin', `ALTER TABLE pairs ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'scanned'`],
  ['labels.origin', `ALTER TABLE labels ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'generated'`],
  ['labels.printed_at', `ALTER TABLE labels ADD COLUMN IF NOT EXISTS printed_at timestamptz`],
  ['labels.hung_at', `ALTER TABLE labels ADD COLUMN IF NOT EXISTS hung_at timestamptz`],
  ['labels.minted_by', `ALTER TABLE labels ADD COLUMN IF NOT EXISTS minted_by integer REFERENCES users(id)`],
  ['minted labels by site', `CREATE INDEX IF NOT EXISTS labels_origin_idx ON labels (site_id, origin)`],

  // ---- the print queue -------------------------------------------------
  // Screens queue; the relay on the PC with the printer polls and prints.
  // That is the only direction that works from a handheld: nothing on the
  // floor can reach that PC, but that PC can always reach the app.
  [
    'settings',
    `CREATE TABLE IF NOT EXISTS settings (
      key        text PRIMARY KEY,
      value      text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
  ],
  [
    'relays',
    `CREATE TABLE IF NOT EXISTS relays (
      name      text PRIMARY KEY,
      site_id   integer REFERENCES sites(id) ON DELETE SET NULL,
      target    text,
      version   text,
      printed   integer NOT NULL DEFAULT 0,
      last_seen timestamptz NOT NULL DEFAULT now()
    )`,
  ],
  [
    'print_jobs',
    `CREATE TABLE IF NOT EXISTS print_jobs (
      id         serial PRIMARY KEY,
      site_id    integer NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      codes      text[] NOT NULL,
      copies     integer NOT NULL DEFAULT 1,
      zpl        text NOT NULL,
      relay      text,
      status     text NOT NULL DEFAULT 'queued',
      error      text,
      user_id    integer REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      claimed_at timestamptz,
      claimed_by text,
      done_at    timestamptz
    )`,
  ],
  ['print_jobs by site', `CREATE INDEX IF NOT EXISTS print_jobs_site_idx ON print_jobs (site_id, status, id)`],
]

if (printOnly) {
  console.log('-- labelvalidation schema. Safe to run repeatedly.')
  for (const [name, ddl] of steps) {
    const flat = ddl.split(`\n    `).join(`\n`)
    console.log(`\n-- ${name}\n${flat};`)
  }
  process.exit(0)
}

const sql = neon(requireDatabaseUrl())

for (const [name, ddl] of steps) {
  // sql.query(), not sql(): as of @neondatabase/serverless v1 the returned
  // function is tagged-template only and throws when called with a plain
  // string. These are fixed DDL strings with no interpolation.
  await sql.query(ddl)
  console.log('  ok  ' + name)
}

// The key a relay signs in with. Made once; the Admin tab shows it and can
// replace it. ON CONFLICT so re-running never rotates it by accident.
const key = 'lvr_' + randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 16)
await sql`INSERT INTO settings (key, value) VALUES ('relay_key', ${key}) ON CONFLICT (key) DO NOTHING`
console.log('  ok  relay key (Admin tab -> Print relays)')

const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`
console.log(`\nSchema ready. ${count} user(s) exist.`)
if (count === 0) console.log('Create the first one with:  npm run user -- <name> <password> admin')
