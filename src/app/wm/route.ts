import { db } from '@/lib/db'
import { currentUser, findUser, verifyPassword, sessionFor, setSessionCookie } from '@/lib/auth'
import { verdictFor, normalizeScan, reversedScan } from '@/lib/bins'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Validation for a Windows Mobile handheld - an MC92N0 running IE Mobile.
 *
 * A separate route rather than a compatibility mode on the modern one. That
 * browser predates everything the rest of the app is built from: no fetch, no
 * ES6, no flexbox, no CSS custom properties, and React will not run in it at
 * all. Bending the React UI to fit would make it worse for the TC52s and the
 * laptops, and it still would not work here.
 *
 * So: plain HTML 4.01, table layout, `bgcolor` rather than CSS backgrounds,
 * and a full page round trip per scan. No JavaScript is required for any of
 * it - there is one three-line script to put the cursor in the field, and if
 * the browser ignores it the operator taps the box instead.
 *
 * **One input per page.** That is the important part. A keyboard wedge sends
 * the scan followed by Enter, and Enter in a form holding two text inputs
 * either submits early or does nothing depending on the browser. With exactly
 * one field, Enter always means "this scan is finished". So the old bin is one
 * page, the new label is the next, and the verdict comes back with the next
 * old-bin page underneath it - the classic terminal rhythm, and the scanner
 * never has to touch the screen.
 */

type Step = { site: number; source: 'map' | 'pairs' }

const WM = 'lv_wm' // site and reference, since there is no localStorage here

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function page(title: string, body: string): Response {
  // HTML 4.01 Transitional: IE Mobile is far happier in quirks-adjacent
  // rendering than with an HTML5 doctype it does not know.
  const html = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="HandheldFriendly" content="true">
<meta name="MobileOptimized" content="480">
<meta name="viewport" content="width=device-width">
<title>${esc(title)}</title>
<style type="text/css">
body{margin:0;padding:0;background:#ffffff;color:#000000;
 font-family:Tahoma,Arial,sans-serif;font-size:20px}
table{border-collapse:collapse;width:100%}
td{padding:6px 8px}
.bar{background:#1f4e79;color:#ffffff;font-size:20px;font-weight:bold;padding:8px}
.lbl{font-size:16px;color:#333333;padding-top:10px}
input.scan{font-size:30px;font-weight:bold;width:96%;padding:6px;border:2px solid #1f4e79}
input.txt{font-size:22px;width:96%;padding:5px;border:2px solid #808080}
input.go{font-size:22px;font-weight:bold;padding:8px 18px}
.big{font-size:34px;font-weight:bold;padding:12px 8px}
.sub{font-size:18px;padding:0 8px 12px 8px}
.foot{font-size:15px;color:#444444;padding:8px}
a{color:#1f4e79}
</style>
</head><body>
${body}
<script type="text/javascript">
/* ES3 only. Puts the cursor in the scan field; harmless if it does nothing. */
try { document.forms[0].elements[0].focus(); } catch (e) { }
</script>
</body></html>`
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

const bar = (right = '') =>
  `<div class="bar">VALIDATE${right ? ` &nbsp;&nbsp; <span style="font-weight:normal">${esc(right)}</span>` : ''}</div>`

/* ---------------- screens ---------------- */

function loginScreen(err = '') {
  return page(
    'Sign in',
    `${bar()}
${err ? `<table><tr><td bgcolor="#a32020"><font color="#ffffff"><b>${esc(err)}</b></font></td></tr></table>` : ''}
<form method="post" action="/wm">
<input type="hidden" name="do" value="login">
<div class="lbl">USER</div><div><input class="txt" type="text" name="u"></div>
<div class="lbl">PASSWORD</div><div><input class="txt" type="password" name="p"></div>
<div style="padding:14px 8px"><input class="go" type="submit" value="Sign in"></div>
</form>`,
  )
}

function setupScreen(sites: Array<{ id: number; name: string }>, cur: Step | null, who: string) {
  const opts = sites
    .map(s => `<option value="${s.id}"${cur && cur.site === s.id ? ' selected' : ''}>${esc(s.name)}</option>`)
    .join('')
  return page(
    'Setup',
    `${bar(who)}
<form method="post" action="/wm">
<input type="hidden" name="do" value="setup">
<div class="lbl">SITE</div>
<div><select name="site" style="font-size:22px;width:96%">${opts || '<option value="">no sites</option>'}</select></div>
<div class="lbl">CHECK AGAINST</div>
<div><select name="source" style="font-size:22px;width:96%">
<option value="map"${cur && cur.source === 'map' ? ' selected' : ''}>The uploaded bin map</option>
<option value="pairs"${cur && cur.source === 'pairs' ? ' selected' : ''}>Bins scanned in on this site</option>
</select></div>
<div style="padding:14px 8px"><input class="go" type="submit" value="Start scanning"></div>
</form>
<div class="foot"><a href="/wm?do=out">Sign out ${esc(who)}</a></div>`,
  )
}

function oldScreen(st: Step, verdict: { colour: string; head: string; sub: string } | null, tally: string) {
  const banner = verdict
    ? `<table><tr><td bgcolor="${verdict.colour}"><font color="#ffffff">
<div class="big">${esc(verdict.head)}</div><div class="sub">${esc(verdict.sub)}</div>
</font></td></tr></table>`
    : ''
  return page(
    'Scan old bin',
    `${bar(tally)}
${banner}
<form method="post" action="/wm">
<input type="hidden" name="do" value="old">
<div class="lbl">1 &nbsp; OLD BIN &nbsp; &mdash; scan it</div>
<div><input class="scan" type="text" name="old"></div>
<div style="padding:12px 8px"><input class="go" type="submit" value="Next"></div>
</form>
<div class="foot"><a href="/wm?do=setup">Change site</a> &nbsp;|&nbsp; site ${st.site}, ${st.source}</div>`,
  )
}

function newScreen(oldBin: string, err = '') {
  return page(
    'Scan new label',
    `${bar()}
${err ? `<table><tr><td bgcolor="#a32020"><font color="#ffffff"><b>${esc(err)}</b></font></td></tr></table>` : ''}
<table><tr><td bgcolor="#e6f5ec"><b>OLD:</b> ${esc(oldBin)}</td></tr></table>
<form method="post" action="/wm">
<input type="hidden" name="do" value="new">
<input type="hidden" name="old" value="${esc(oldBin)}">
<div class="lbl">2 &nbsp; LABEL HUNG ON IT &nbsp; &mdash; scan it</div>
<div><input class="scan" type="text" name="new"></div>
<div style="padding:12px 8px">
<input class="go" type="submit" value="Check">
&nbsp;<a href="/wm">start over</a>
</div>
</form>`,
  )
}

/* ---------------- state ---------------- */

async function readStep(): Promise<Step | null> {
  const raw = (await cookies()).get(WM)?.value ?? ''
  const [site, source] = raw.split(':')
  if (!site || (source !== 'map' && source !== 'pairs')) return null
  return { site: Number(site), source }
}

async function tallyFor(st: Step): Promise<string> {
  try {
    const sql = db()
    const r = (await sql`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE verdict <> 'match')::int AS bad
      FROM checks WHERE site_id = ${st.site} AND source = ${st.source}`) as Array<{ n: number; bad: number }>
    return `${r[0].n} checked, ${r[0].bad} to fix`
  } catch {
    return ''
  }
}

/* ---------------- routes ---------------- */

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams
  const user = await currentUser().catch(() => null)
  if (!user) return loginScreen()

  if (q.get('do') === 'out') {
    ;(await cookies()).set('lv_session', '', { httpOnly: true, path: '/', maxAge: 0 })
    return loginScreen()
  }

  const st = await readStep()
  if (q.get('do') === 'setup' || !st) {
    const sql = db()
    const sites = (await sql`SELECT id, name FROM sites ORDER BY created_at DESC`) as Array<{
      id: number
      name: string
    }>
    return setupScreen(sites, st, user.name)
  }
  return oldScreen(st, null, await tallyFor(st))
}

export async function POST(req: Request) {
  const form = await req.formData()
  const doing = String(form.get('do') ?? '')

  if (doing === 'login') {
    const u = String(form.get('u') ?? '')
    const p = String(form.get('p') ?? '')
    const found = await findUser(u)
    if (!found || !found.active || !(await verifyPassword(p, found.pass_hash, found.salt)))
      return loginScreen('Wrong username or password.')
    await setSessionCookie(sessionFor(found))
    return Response.redirect(new URL('/wm', req.url), 303)
  }

  const user = await currentUser().catch(() => null)
  if (!user) return loginScreen('Session expired - sign in again.')

  if (doing === 'setup') {
    const site = Number(form.get('site'))
    const source = String(form.get('source')) === 'pairs' ? 'pairs' : 'map'
    if (!site) return Response.redirect(new URL('/wm?do=setup', req.url), 303)
    ;(await cookies()).set(WM, `${site}:${source}`, { httpOnly: true, path: '/wm', maxAge: 60 * 60 * 24 * 30 })
    return Response.redirect(new URL('/wm', req.url), 303)
  }

  const st = await readStep()
  if (!st) return Response.redirect(new URL('/wm?do=setup', req.url), 303)

  // Step one: the old label. One field, so Enter from the wedge lands here.
  if (doing === 'old') {
    const oldBin = normalizeScan(String(form.get('old') ?? ''))
    if (!oldBin) return oldScreen(st, null, await tallyFor(st))
    return newScreen(oldBin)
  }

  // Step two: the label hung on it, and the answer.
  if (doing === 'new') {
    const oldBin = normalizeScan(String(form.get('old') ?? ''))
    const newBin = normalizeScan(String(form.get('new') ?? ''))
    if (!newBin) return newScreen(oldBin)
    if (oldBin === newBin) return newScreen(oldBin, 'Both fields read the same code.')
    const backwards = reversedScan(oldBin, newBin)
    if (backwards) return newScreen(oldBin, backwards)

    const sql = db()
    const [expectedRows, ownerRows] = await Promise.all([
      st.source === 'map'
        ? sql`SELECT new_bin FROM bin_map WHERE site_id = ${st.site} AND old_bin = ${oldBin} LIMIT 1`
        : sql`SELECT new_bin FROM pairs   WHERE site_id = ${st.site} AND old_bin = ${oldBin} LIMIT 1`,
      st.source === 'map'
        ? sql`SELECT old_bin FROM bin_map WHERE site_id = ${st.site} AND new_bin = ${newBin} AND old_bin <> ${oldBin} LIMIT 1`
        : sql`SELECT old_bin FROM pairs   WHERE site_id = ${st.site} AND new_bin = ${newBin} AND old_bin <> ${oldBin} LIMIT 1`,
    ])
    const expected = (expectedRows[0] as { new_bin: string } | undefined)?.new_bin ?? null
    const belongsTo = (ownerRows[0] as { old_bin: string } | undefined)?.old_bin ?? null
    const verdict = verdictFor(newBin, expected)

    await sql`
      INSERT INTO checks (site_id, source, old_bin, new_bin, expected_bin, verdict, user_id)
      VALUES (${st.site}, ${st.source}, ${oldBin}, ${newBin}, ${expected}, ${verdict}, ${user.uid})
      ON CONFLICT (site_id, source, old_bin) DO UPDATE
        SET new_bin = EXCLUDED.new_bin, expected_bin = EXCLUDED.expected_bin,
            verdict = EXCLUDED.verdict, user_id = EXCLUDED.user_id, created_at = now()`

    const also = belongsTo ? ` ${newBin} belongs to ${belongsTo}.` : ''
    const shown =
      verdict === 'match'
        ? { colour: '#1b7f4b', head: 'MATCH', sub: `${oldBin} -> ${newBin}` }
        : verdict === 'mismatch'
          ? { colour: '#a32020', head: 'MISMATCH', sub: `${oldBin} should be ${expected}, not ${newBin}.${also}` }
          : { colour: '#8a6100', head: 'NOT IN REFERENCE', sub: `${oldBin} is not in the reference.${also}` }

    return oldScreen(st, shown, await tallyFor(st))
  }

  return Response.redirect(new URL('/wm', req.url), 303)
}
