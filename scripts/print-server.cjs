/**
 * Local print relay. Runs on the PC the Zebra is attached to.
 *
 *   node scripts/print-server.cjs                     use saved settings
 *   node scripts/print-server.cjs --setup             force the setup page
 *   node scripts/print-server.cjs --host 192.168.60.81 network printer
 *   node scripts/print-server.cjs --printer "Zebra"    USB / local queue
 *
 * A browser has no raw socket API and cannot see a USB printer, so a hosted
 * page cannot reach a Zebra on its own. This bridges the two. Two backends:
 *
 *   network  a raw TCP socket to port 9100, the printer's own protocol
 *   local    the Windows spooler in RAW mode, via winspool WritePrinter
 *
 * RAW is not optional on the Windows path: ZPL sent through a normal driver
 * prints the *text* of the ZPL, pages of it.
 *
 * Also, opted in, a plain-HTTP gateway for the Windows Mobile handhelds: an
 * MC92N0's browser speaks TLS 1.0 at best and the app is served over TLS 1.2+,
 * so it cannot reach the app at all. The gateway listens on the LAN and
 * forwards /wm to the app over https. Nothing else is proxied and no printing
 * is accepted on it - see `wmGateway`.
 *
 * Two ways in. A browser on this PC can POST ZPL to /print directly. And,
 * once connected to the web app with the relay key, this polls the app's
 * print queue for its site and prints whatever is there - which is how a
 * TC52, a phone or an MC92N0 in an aisle gets a label out of a printer they
 * cannot see. Outbound https from this PC is the one path that always works.
 *
 * CommonJS on purpose - Node's single-executable format takes a CJS entry, and
 * one file that both runs from source and packages into an .exe beats two that
 * drift apart. No dependencies.
 */
const http = require('node:http')
const net = require('node:net')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* ---------------- arguments and saved settings ---------------- */

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

// Beside the user's profile rather than beside the executable: an .exe may sit
// somewhere unwritable, and this has to survive a restart.
const CONFIG_DIR = path.join(os.homedir(), '.labelvalidation')
const CONFIG_FILE = path.join(CONFIG_DIR, 'print-server.json')

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  } catch (e) {
    console.error('could not save settings:', e.message)
  }
}

const saved = loadConfig()
let target = {
  mode: arg('printer') ? 'local' : arg('host') ? 'network' : saved.mode || null,
  host: arg('host') || saved.host || '',
  port: Number(arg('port') || saved.port || 9100),
  printer: arg('printer') || saved.printer || '',
}

/**
 * A second printer, for single labels asked for from the floor: a reprint of
 * a torn label, a bin added in an aisle. Those are one label somebody is
 * standing waiting for, and they should not come out at the back of a
 * 500-label run on the office printer. Jobs arrive marked 'batch' or
 * 'reprint'; with this unset, everything goes to the one printer as before.
 */
const savedR = saved.reprint || {}
let reprint = {
  mode: arg('reprint-printer') ? 'local' : arg('reprint-host') ? 'network' : savedR.mode || null,
  host: arg('reprint-host') || savedR.host || '',
  port: Number(arg('reprint-port') || savedR.port || 9100),
  printer: arg('reprint-printer') || savedR.printer || '',
}
const targetFor = kind => (kind === 'reprint' && reprint.mode ? reprint : target)

const LISTEN = Number(arg('listen', saved.listen || '9110'))
const ALLOW = (arg('allow') || saved.allow || 'https://labelvalidation.vercel.app,http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const describe = (t = target) =>
  !t.mode ? 'nothing yet' : t.mode === 'network' ? `${t.host}:${t.port}` : `queue "${t.printer}"`
/** Both printers in one line, for the app's relay table. */
const describeAll = () => describe() + (reprint.mode ? ` | reprints -> ${describe(reprint)}` : '')

/* ---------------- the web app's print queue ---------------- */

const VERSION = '3'

/**
 * Labels per piece. A job goes to the printer in pieces this size, and the
 * app is asked between pieces whether the job has been cancelled. Once bytes
 * are in the printer's buffer nothing can pull them back, so this is the most
 * that prints after someone presses Stop. About fifteen seconds of printing.
 */
const PIECE = Number(arg('piece') || saved.piece || 50)

/**
 * Labels per second the printer actually prints. A Zebra swallows a whole job
 * into memory in a second, so "bytes accepted" says nothing about progress -
 * the relay has to pace itself. Between pieces it waits this long for the
 * piece just sent, checking for a stop as it waits. A GX420d at 4 ips on 1in
 * labels does a little under 4/s; 3 leaves the buffer never more than about
 * a piece ahead. Too low only means the printer idles briefly between pieces.
 */
const LPS = Math.max(0.5, Number(arg('lps') || saved.lps || 3))

/**
 * The Windows Mobile gateway port. 0 is off. When on, http://<this PC>:<port>/wm
 * on the warehouse LAN is the app's /wm for a device that cannot do TLS 1.2.
 */
let WM_PORT = Math.max(0, Math.floor(Number(arg('wm-port') || saved.wmPort || 0)))
let link = {
  app: arg('app') || saved.app || 'https://labelvalidation.vercel.app',
  key: arg('key') || saved.key || '',
  name: arg('name') || saved.name || os.hostname(),
  site: Number(arg('site') || saved.site || 0),
  siteName: saved.siteName || '',
}
const persist = () => saveConfig({ ...target, reprint, ...link, listen: LISTEN, allow: ALLOW.join(','), wmPort: WM_PORT })

/** This PC's LAN addresses, for the address to type into a handheld. */
function lanAddresses() {
  // Virtual adapters (Hyper-V, WSL, VirtualBox, VMware) have addresses nothing
  // on the warehouse network can reach, and one of them is often listed first.
  const virtual = /vethernet|wsl|virtualbox|vmware|hyper-v|loopback|bluetooth|docker/i
  const real = []
  const other = []
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) (virtual.test(name) ? other : real).push(a.address)
  return [...real, ...other]
}

const queue = { state: 'off', detail: '', lastPoll: 0, lastWork: 0, printed: 0, lastJob: null }

function appFetch(pathname, init = {}, use = link) {
  const url = use.app.replace(/\/$/, '') + pathname
  return fetch(url, {
    ...init,
    headers: { Authorization: 'Bearer ' + use.key, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
}

/** Proves the address and key, and lists the sites to bind to. */
async function checkApp(use = link) {
  if (!use.app || !use.key) throw new Error('The app address and the relay key are both needed.')
  let r
  try {
    r = await appFetch('/api/print/relay?relay=' + encodeURIComponent(use.name), {}, use)
  } catch (e) {
    throw new Error('Could not reach ' + use.app + ' - ' + e.message)
  }
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || 'The app returned ' + r.status)
  return d
}

/**
 * Cut a job at label boundaries. Label blocks are the ^XA...^XZ blocks that
 * carry a ^PQ; whatever precedes the first (the site preamble) rides with the
 * first piece and whatever follows the last (a restore) with the last.
 */
function splitJob(zpl, per) {
  const blocks = [...zpl.matchAll(/\^XA[\s\S]*?\^XZ/g)]
  const labels = blocks.filter(m => m[0].includes('^PQ'))
  if (labels.length <= per) return [{ zpl, labels: labels.length }]
  const pieces = []
  let cursor = 0
  for (let i = per; i < labels.length; i += per) {
    pieces.push({ zpl: zpl.slice(cursor, labels[i].index), labels: per })
    cursor = labels[i].index
  }
  pieces.push({ zpl: zpl.slice(cursor), labels: labels.length - pieces.length * per })
  return pieces
}

/** Between pieces: has anyone asked this job to stop? Unsure means carry on. */
async function wantsStop(id) {
  try {
    const r = await appFetch('/api/print/' + id + '?relay=' + encodeURIComponent(link.name))
    if (!r.ok) return false
    const d = await r.json()
    return d.status === 'cancelled'
  } catch {
    return false
  }
}

/** Send a job piece by piece, pacing to the printer and looking up between pieces. */
async function sendJob(job) {
  const pieces = splitJob(job.zpl, PIECE)
  let sent = 0
  for (let i = 0; i < pieces.length; i++) {
    await send(pieces[i].zpl, targetFor(job.kind))
    sent += pieces[i].labels
    if (i === pieces.length - 1) break
    // Let the printer work through that piece before the next goes into its
    // buffer. Every look also refreshes the job's claim, so a long paced
    // batch is not mistaken for a dead relay and handed out again.
    const until = Date.now() + (pieces[i].labels / LPS) * 1000
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, Math.min(2000, until - Date.now())))
      if (await wantsStop(job.id)) return { stopped: true, sent }
    }
    if (await wantsStop(job.id)) return { stopped: true, sent }
  }
  return { stopped: false, sent }
}

/** One poll: take the next job for this site, print it, report back. */
async function pollOnce() {
  const q =
    '?relay=' + encodeURIComponent(link.name) + '&site=' + link.site +
    '&target=' + encodeURIComponent(describeAll()) + '&v=' + VERSION
  const r = await appFetch('/api/print/next' + q)
  if (r.status === 204) return false
  const job = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(job.error || 'The app returned ' + r.status)

  let ok = true
  let error = ''
  let stopped = false
  let sent = 0
  const labels = (job.codes || []).length
  try {
    // Sent as-is, in pieces. The width is inside every label already - the
    // Print card's stock choice put it there - so this has nothing to add.
    const r = await sendJob(job)
    stopped = r.stopped
    sent = r.sent
    if (stopped) error = `Stopped after ${sent} of ${labels} labels`
  } catch (e) {
    ok = false
    error = e.message
  }
  const copies = job.copies || 1
  queue.lastJob = { id: job.id, ok: ok && !stopped, error, labels, at: Date.now() }
  if (stopped) console.log(`  job #${job.id}: STOPPED after ${sent} of ${labels} label(s)`)
  else if (ok) {
    queue.printed += labels * copies
    console.log(`  job #${job.id} (${job.kind || 'batch'}): ${labels} label(s) x${copies} -> ${describe(targetFor(job.kind))}`)
  } else console.error(`  job #${job.id} FAILED: ${error}`)

  const done = await appFetch('/api/print/' + job.id + '?relay=' + encodeURIComponent(link.name), {
    method: 'POST',
    body: JSON.stringify({ ok, error, stopped }),
  })
  if (!done.ok) console.error(`  could not report job #${job.id}: the app returned ` + done.status)
  return true
}

let pollTimer = null
async function pollLoop() {
  clearTimeout(pollTimer)
  let delay = 5000
  if (!target.mode || !link.key || !link.site) {
    queue.state = 'off'
    queue.detail = !target.mode ? 'no printer chosen' : !link.key ? 'not connected to the app' : 'no site chosen'
  } else {
    try {
      const had = await pollOnce()
      if (queue.state !== 'ok')
        console.log(`  queue: connected to ${link.app} as "${link.name}" for ${link.siteName || 'site ' + link.site}`)
      queue.state = 'ok'
      queue.detail = ''
      queue.lastPoll = Date.now()
      if (had) queue.lastWork = Date.now()
      // Straight back for the next one while there is work; every couple of
      // seconds for a while after; then every five, which is as long as
      // "Release next batch" should take to start printing.
      delay = had ? 200 : Date.now() - queue.lastWork < 120000 ? 2000 : 5000
    } catch (e) {
      if (queue.detail !== e.message) console.error('  queue: ' + e.message)
      queue.state = 'error'
      queue.detail = e.message
      delay = 10000
    }
  }
  pollTimer = setTimeout(pollLoop, delay)
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/* ---------------- the two backends ---------------- */

function sendTcp(zpl, t = target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: t.host, port: t.port })
    sock.setTimeout(120000)
    sock.on('error', reject)
    sock.on('timeout', () => {
      sock.destroy()
      reject(new Error(`Timed out talking to ${t.host}:${t.port}`))
    })
    // One socket for the whole job, and end() only once the write has drained -
    // a printer takes data far slower than a socket will accept it.
    sock.on('connect', () => sock.write(zpl, () => sock.end()))
    sock.on('close', () => resolve())
  })
}

const PS_RAW = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class Raw {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFO { public string name; public string output; public string datatype; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr h, IntPtr buf, int count, out int written);
  public static void Send(string printer, string file) {
    byte[] bytes = File.ReadAllBytes(file);
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Cannot open printer: " + printer);
    try {
      DOCINFO di = new DOCINFO();
      di.name = "labelvalidation"; di.datatype = "RAW";
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter failed");
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter failed");
        IntPtr buf = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, buf, bytes.Length);
          int written;
          if (!WritePrinter(h, buf, bytes.Length, out written)) throw new Exception("WritePrinter failed");
        } finally { Marshal.FreeCoTaskMem(buf); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
[Raw]::Send($env:LV_PRINTER, $env:LV_FILE)
`.trim()

/**
 * Values go in through the environment, not the command line. `-Command`
 * takes the rest of the line as the command text, so anything appended after
 * the script - an `-args`, a printer name - becomes part of the command and
 * breaks it. That is why the printer list came back empty.
 */
function powershell(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, env: { ...process.env, ...env } },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `PowerShell exited ${code}`))))
  })
}

async function sendWindowsRaw(zpl, t = target) {
  // By path, not inline: a run of thousands of labels is far past any sane
  // command-line length.
  const file = path.join(os.tmpdir(), `lv-${Date.now()}-${Math.random().toString(36).slice(2)}.zpl`)
  fs.writeFileSync(file, zpl, 'binary')
  try {
    await powershell(PS_RAW, { LV_PRINTER: t.printer, LV_FILE: file })
  } finally {
    try {
      fs.unlinkSync(file)
    } catch {
      /* already gone */
    }
  }
}

async function listPrinters() {
  if (process.platform !== 'win32') return []
  try {
    const out = await powershell('Get-Printer | Select-Object -ExpandProperty Name')
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

const send = (zpl, t = target) => (t.mode === 'network' ? sendTcp(zpl, t) : sendWindowsRaw(zpl, t))

/* ---------------- setup page ---------------- */

const PAGE = printers => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Label print relay</title>
<style>
 :root{--ink:#1a2128;--muted:#667;--line:#d6dde4;--brand:#1f4e79;--ok:#1b7f4b;--bad:#a32020}
 body{font:15px system-ui,Segoe UI,sans-serif;color:var(--ink);background:#f4f6f8;margin:0;padding:28px}
 .card{background:#fff;border:1px solid var(--line);border-radius:9px;padding:20px;max-width:620px;margin:0 auto 16px}
 h1{font-size:19px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px}
 p{color:var(--muted);margin:0 0 14px;line-height:1.5}
 label{display:block;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:12px 0 4px}
 input,select{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:6px;font-size:15px;box-sizing:border-box}
 button{background:var(--brand);color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer;margin-top:14px}
 button.ghost{background:#fff;color:var(--brand);border:1px solid var(--brand)}
 .row{display:flex;gap:10px}.row>*{flex:1}
 .now{font-family:ui-monospace,Consolas,monospace;background:#eef2f6;padding:3px 8px;border-radius:5px}
 .msg{padding:10px 12px;border-radius:6px;margin-top:14px;display:none}
 .msg.ok{background:#e6f5ec;color:var(--ok);border:1px solid var(--ok);display:block}
 .msg.bad{background:#fdeaea;color:var(--bad);border:1px solid var(--bad);display:block}
</style>
<div class="card">
  <h1>Label print relay</h1>
  <p>Leave this running while you print. Connected to the web app below, it fetches
     that site's labels itself - from a laptop, a TC52, a phone or the old handhelds.
     A browser on this PC can also send to it directly at
     <span class="now">http://localhost:${LISTEN}</span>.</p>
  <p>Printing to <span class="now" id="now">${describe()}</span></p>
</div>
<div class="card">
  <h2>Choose the printer</h2>
  <label>Connection</label>
  <select id="mode">
    <option value="network"${target.mode === 'network' ? ' selected' : ''}>Network — the printer has its own IP address</option>
    <option value="local"${target.mode === 'local' ? ' selected' : ''}>USB or shared — installed on this PC</option>
  </select>
  <div id="net">
    <div class="row">
      <div><label>IP address</label><input id="host" value="${target.host}" placeholder="192.168.60.81"></div>
      <div style="flex:0 0 110px"><label>Port</label><input id="port" value="${target.port}"></div>
    </div>
    <p style="margin-top:10px">The printer prints its own address on the configuration label — hold FEED at power-on.</p>
  </div>
  <div id="loc" hidden>
    <label>Installed printer</label>
    <select id="printer">
      ${printers.length ? printers.map(p => `<option${p === target.printer ? ' selected' : ''}>${p}</option>`).join('') : '<option value="">none found</option>'}
    </select>
  </div>
  <button id="save">Save and use this printer</button>
  <button class="ghost" id="test">Print a test label</button>
  <div class="msg" id="msg"></div>
</div>
<div class="card">
  <h2>Reprint printer <span style="font-weight:normal;color:var(--muted)">- optional</span></h2>
  <p>Single labels asked for from the floor - a reprint of a torn label, a bin added in an aisle - can come
     out of a different printer from the big runs, so nobody waits at the back of a 500-label batch. Put this
     one where the scanning is happening.</p>
  <p>Reprints go to <span class="now" id="rnow">${reprint.mode ? esc(describe(reprint)) : 'the same printer as the batches'}</span></p>
  <label>Connection</label>
  <select id="rmode">
    <option value=""${!reprint.mode ? ' selected' : ''}>Same printer as the batches</option>
    <option value="network"${reprint.mode === 'network' ? ' selected' : ''}>Network - the printer has its own IP address</option>
    <option value="local"${reprint.mode === 'local' ? ' selected' : ''}>USB or shared - installed on this PC</option>
  </select>
  <div id="rnet" hidden>
    <div class="row">
      <div><label>IP address</label><input id="rhost" value="${esc(reprint.host)}" placeholder="192.168.60.82"></div>
      <div style="flex:0 0 110px"><label>Port</label><input id="rport" value="${reprint.port}"></div>
    </div>
  </div>
  <div id="rloc" hidden>
    <label>Installed printer</label>
    <select id="rprinter">
      ${printers.length ? printers.map(p => `<option${p === reprint.printer ? ' selected' : ''}>${p}</option>`).join('') : '<option value="">none found</option>'}
    </select>
  </div>
  <button id="rsave">Save the reprint printer</button>
  <button class="ghost" id="rtest">Print a test label there</button>
  <div class="msg" id="rmsg"></div>
</div>
<div class="card">
  <h2>Connect to the web app</h2>
  <p>The relay signs in with the key from the app's Admin tab, picks a site, and prints whatever
     that site queues. Nothing on the floor has to reach this PC.</p>
  <label>Web app address</label>
  <input id="app" value="${esc(link.app)}" placeholder="https://labelvalidation.vercel.app">
  <label>Relay key <span style="font-weight:normal;text-transform:none">(Admin tab &rarr; Print relays)</span></label>
  <input id="key" value="${esc(link.key)}" placeholder="lvr_…" autocomplete="off" spellcheck="false">
  <div class="row">
    <div><label>This relay's name</label><input id="name" value="${esc(link.name)}"></div>
    <div><label>Site</label>
      <select id="site">${
        link.site
          ? `<option value="${link.site}" selected>${esc(link.siteName || 'site ' + link.site)}</option>`
          : '<option value="">check the connection first</option>'
      }</select></div>
  </div>
  <button class="ghost" id="check">Check connection</button>
  <button id="connect">Save and print for this site</button>
  <div class="msg" id="qmsg"></div>
  <p id="qstat" style="margin-top:12px;font-weight:600"></p>
</div>
<div class="card">
  <h2>Old handhelds (Windows Mobile MC92N0)</h2>
  <p>Their browser cannot open the web app - it speaks an older https than the app accepts - so
     this relay can serve the handheld page to them over plain http on the warehouse network.
     Type the address below into the handheld's browser. It carries only the handheld page;
     nothing else, and no printing.</p>
  <div class="row">
    <div><label>Port (0 = off)</label><input id="wmport" value="${WM_PORT}"></div>
    <div style="flex:2"><label>Address for the handhelds</label>
      <div class="now" id="wmaddr">${WM_PORT ? `http://${esc(lanAddresses()[0] || '<this PC>')}:${WM_PORT}/wm` : 'off'}</div></div>
  </div>
  <p style="margin-top:10px">Windows Firewall may ask to allow this program on the private network the first time - say yes,
     or the handhelds cannot reach it. The address is this PC's, so give it a fixed IP.</p>
  <button id="wmsave">Save</button>
  <div class="msg" id="wmmsg"></div>
  <h2 style="margin-top:18px">If a handheld says "The page cannot be displayed"</h2>
  <p><b>1.</b> On the handheld, open <span class="now" id="wmping">${WM_PORT ? `http://${esc(lanAddresses()[0] || '<this PC>')}:${WM_PORT}/ping` : 'the /ping address (turn the gateway on first)'}</span>
     - type the <b>http://</b>, it will not guess it with a port number. That page needs nothing but this PC.</p>
  <p><b>2.</b> Watch the list below while you do. If the handheld's address <b>appears</b>, the network is fine.
     If <b>nothing appears</b>, the request never left the handheld: on it, go to Start &rarr; Settings &rarr; Connections &rarr;
     Wi-Fi (or Network Cards) and set <b>"My network card connects to"</b> to <b>The Internet</b>, not Work. Windows Mobile
     sends any address with dots in it down the Internet connection, and a card marked Work has none.</p>
  <label>Requests the gateway has seen</label>
  <div id="wmhits" style="font:12px ui-monospace,Consolas,monospace;background:#eef2f6;border-radius:6px;padding:8px 10px;min-height:38px;white-space:pre-wrap">none yet</div>
</div>
<div class="card">
  <h2>Stop</h2>
  <p>Closing this window on its own leaves the relay running in the background.
     Use this to actually stop it.</p>
  <button class="ghost" id="quit">Stop the relay and close</button>
</div>
<script>
 const $ = i => document.getElementById(i)
 const sync = () => { const n = $('mode').value === 'network'; $('net').hidden = !n; $('loc').hidden = n }
 $('mode').onchange = sync; sync()
 const say = (k, t) => { $('msg').className = 'msg ' + k; $('msg').textContent = t }
 const body = () => JSON.stringify({
   mode: $('mode').value, host: $('host').value.trim(),
   port: Number($('port').value) || 9100, printer: $('printer').value,
 })
 $('save').onclick = async () => {
   const r = await fetch('/target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body() })
   const d = await r.json()
   if (r.ok) { $('now').textContent = d.target; say('ok', 'Saved. The web app can print now.') }
   else say('bad', d.error || 'Could not save that.')
 }
 $('quit').onclick = async () => {
   say('ok', 'Stopping…')
   try { await fetch('/quit', { method: 'POST' }) } catch (e) {}
   document.body.innerHTML = '<div class="card"><h1>Stopped</h1>' +
     '<p>The relay is no longer running. Printing from the web app will fail ' +
     'until you start it again. You can close this window.</p></div>'
   setTimeout(() => window.close(), 400)
 }
 $('test').onclick = async () => {
   say('ok', 'Sending…')
   const r = await fetch('/test', { method: 'POST' })
   const d = await r.json()
   say(r.ok ? 'ok' : 'bad', r.ok ? 'Sent. A label should come out.' : (d.error || 'Failed.'))
 }

 const qsay = (k, t) => { $('qmsg').className = 'msg ' + k; $('qmsg').textContent = t }
 const linkBody = () => ({
   app: $('app').value.trim(), key: $('key').value.trim(), name: $('name').value.trim(),
   site: Number($('site').value),
 })
 const post = async (u, b) => {
   const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
   return [r.ok, await r.json().catch(() => ({}))]
 }
 $('check').onclick = async () => {
   qsay('ok', 'Checking…')
   const [ok, d] = await post('/app/check', linkBody())
   if (!ok) return qsay('bad', d.error || 'Could not connect.')
   const cur = Number($('site').value)
   $('site').innerHTML = d.sites.length
     ? d.sites.map(s => '<option value="' + s.id + '"' + (s.id === cur ? ' selected' : '') + '>' + s.name + '</option>').join('')
     : '<option value="">the app has no sites yet</option>'
   qsay('ok', 'Connected. Pick the site, then save.')
 }
 $('connect').onclick = async () => {
   qsay('ok', 'Saving…')
   const [ok, d] = await post('/app', linkBody())
   qsay(ok ? 'ok' : 'bad', ok ? 'Printing for ' + d.site + '. Leave this running.' : (d.error || 'Could not save.'))
 }
 const rsync = () => { const m = $('rmode').value; $('rnet').hidden = m !== 'network'; $('rloc').hidden = m !== 'local' }
 $('rmode').onchange = rsync; rsync()
 const rsay = (k, t) => { $('rmsg').className = 'msg ' + k; $('rmsg').textContent = t }
 $('rsave').onclick = async () => {
   const [ok, d] = await post('/target-reprint', {
     mode: $('rmode').value, host: $('rhost').value.trim(), port: Number($('rport').value) || 9100, printer: $('rprinter').value,
   })
   if (ok) { $('rnow').textContent = d.target; rsay('ok', 'Saved.') } else rsay('bad', d.error || 'Could not save that.')
 }
 $('rtest').onclick = async () => {
   rsay('ok', 'Sending…')
   const [ok, d] = await post('/test-reprint', {})
   rsay(ok ? 'ok' : 'bad', ok ? 'Sent. A label should come out of the reprint printer.' : (d.error || 'Failed.'))
 }
 const ago = t => (t ? Math.round((Date.now() - t) / 1000) + 's ago' : 'never')
 async function refreshStatus() {
   try {
     const s = await (await fetch('/status')).json()
     const q = s.queue
     let t =
       q.state === 'ok' ? 'Queue: printing for ' + (q.siteName || 'site ' + q.site) + ' as "' + q.name + '" · polled ' + ago(q.lastPoll) + ' · ' + q.printed + ' label(s) this session'
       : q.state === 'error' ? 'Queue: ' + q.detail
       : 'Queue: not running - ' + q.detail
     if (q.lastJob) t += ' · last job #' + q.lastJob.id + (q.lastJob.ok ? ' printed' : ' FAILED: ' + q.lastJob.error)
     $('qstat').textContent = t
     $('qstat').style.color = q.state === 'ok' ? 'var(--ok)' : q.state === 'error' ? 'var(--bad)' : 'var(--muted)'
     const g = s.gateway || { hits: [] }
     $('wmhits').textContent = g.hits.length
       ? g.hits.map(h => ago(h.at).padEnd(9) + h.ip.padEnd(16) + (h.method + ' ' + h.url).padEnd(22) + String(h.status).padEnd(5) + (h.note ? h.note + '  ' : '') + h.ua).join(String.fromCharCode(10)) // not '\\n': this script sits in a template string, where that becomes a real line break
       : (g.port ? 'none yet - nothing has reached this PC on port ' + g.port : 'gateway is off')
   } catch (e) {}
 }
 refreshStatus(); setInterval(refreshStatus, 3000)
 $('wmsave').onclick = async () => {
   const [ok, d] = await post('/wm-gateway', { port: Number($('wmport').value) || 0 })
   $('wmmsg').className = 'msg ' + (ok ? 'ok' : 'bad')
   $('wmmsg').textContent = ok ? (d.address ? 'Serving the handheld page at ' + d.address : 'Gateway off.') : (d.error || 'Could not save.')
   if (ok) $('wmaddr').textContent = d.address || 'off'
 }
</script>`

// A label that proves the path end to end without needing the web app.
const TEST_ZPL = [
  '~CC^',
  '^XA^MCY^XZ',
  '^XA',
  '^FO38,12^A0N,84,98^FDRELAY-OK^FS',
  '^BY3,3,100',
  '^FO38,84^B3N,N,100,N,N^FDRELAYOK^FS',
  '^PQ1',
  '^XZ',
].join('\n')

/* ---------------- the Windows Mobile gateway ---------------- */

/**
 * Forward one /wm request to the app and hand the answer back over plain
 * http. Three things have to be rewritten on the way back:
 *
 *   Location    the app redirects with absolute URLs built from the request
 *               it saw - https://…/wm - which the device cannot follow.
 *   Set-Cookie  the app marks its cookies Secure in production, and a browser
 *               will not send a Secure cookie back over http.
 *   nothing else the HTML is HTML 4.01 with relative links already.
 *
 * Only /wm is forwarded. Any other path is sent to /wm. The gateway accepts
 * no ZPL and exposes no setup page - it is the handheld route and nothing
 * more, which is why it is allowed to listen on the LAN at all.
 */
/** The last requests the gateway saw, newest first - shown in the relay window. */
const gatewayHits = []
function noteHit(req, status, note) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  const hit = { at: Date.now(), ip, method: req.method, url: (req.url || '').slice(0, 60), status, ua: String(req.headers['user-agent'] || '').slice(0, 90), note: note || '' }
  gatewayHits.unshift(hit)
  gatewayHits.length = Math.min(gatewayHits.length, 25)
  console.log(`  gateway  ${ip}  ${req.method} ${hit.url} -> ${status}${note ? '  ' + note : ''}  [${hit.ua.slice(0, 50)}]`)
}

/**
 * Answer the way an IE6-era browser expects: an explicit Content-Length and
 * Connection: close. Left to itself Node answers HTTP/1.1 with chunked
 * transfer on a kept-alive socket, which a phone handles and Pocket IE on
 * Windows Mobile 6.5 may turn into "The page cannot be displayed".
 */
function plainSend(req, res, status, headers, body, note) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8')
  res.shouldKeepAlive = false
  res.writeHead(status, { ...headers, 'Content-Length': buf.length, Connection: 'close' })
  res.end(buf)
  noteHit(req, status, note)
}

async function wmGateway(req, res) {
  const url = req.url || '/'

  // A page that needs nothing but this PC. If the handheld can show this, the
  // network path is good and anything wrong is further in; if it cannot, the
  // request never got here and the device's own settings are the place to look.
  if (url === '/ping' || url.startsWith('/ping?')) {
    return plainSend(req, res, 200, { 'Content-Type': 'text/html' },
      '<html><head><title>Gateway OK</title></head><body>' +
      '<font face="Tahoma" size="5"><b>GATEWAY OK</b></font><br><br>' +
      '<font face="Tahoma" size="4">This handheld can reach the relay PC.<br><br>' +
      '<a href="/wm">Go to the scanning page</a></font></body></html>', 'ping')
  }

  if (!(url === '/wm' || url.startsWith('/wm?') || url.startsWith('/wm/')))
    return plainSend(req, res, 302, { Location: '/wm', 'Content-Type': 'text/html' }, '<html><body><a href="/wm">continue</a></body></html>')

  const origin = link.app.replace(/\/$/, '')
  const body = req.method === 'POST' ? await readBody(req, 1024 * 1024) : undefined
  const headers = {}
  for (const h of ['content-type', 'cookie', 'user-agent', 'accept', 'accept-language']) if (req.headers[h]) headers[h] = req.headers[h]
  let r
  try {
    r = await fetch(origin + url, { method: req.method, headers, body, redirect: 'manual' })
  } catch (e) {
    return plainSend(req, res, 502, { 'Content-Type': 'text/html' },
      '<html><body><font face="Tahoma" size="4"><b>Cannot reach the app</b><br>' + esc(e.message) + '<br><a href="/wm">try again</a></font></body></html>', 'UPSTREAM FAILED')
  }
  const out = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
  const ct = r.headers.get('content-type')
  if (ct) out['Content-Type'] = ct
  const loc = r.headers.get('location')
  const host = 'http://' + (req.headers.host || 'localhost')
  if (loc) out['Location'] = loc.startsWith('/') ? host + loc : loc.replace(origin, host)
  const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
  // Secure would stop the cookie coming back over http; SameSite is an
  // attribute old parsers have been known to trip on, and means nothing here.
  if (cookies.length) out['Set-Cookie'] = cookies.map(c => c.replace(/;\s*Secure/gi, '').replace(/;\s*SameSite=\w+/gi, ''))
  let buf = Buffer.from(await r.arrayBuffer())
  // 303 and 307 are HTTP/1.1; an old browser is only sure of 302, and treats
  // it the same way - a GET of the new address.
  let status = r.status
  if (status === 303 || status === 307 || status === 308) status = 302
  if (status === 302 && !buf.length) buf = Buffer.from('<html><body><a href="' + esc(out['Location'] || '/wm') + '">continue</a></body></html>')
  plainSend(req, res, status, out, buf)
}

let gateway = null
function startGateway() {
  if (gateway) {
    gateway.close()
    gateway = null
  }
  if (!WM_PORT) return
  gateway = http.createServer((req, res) => {
    wmGateway(req, res).catch(e => {
      console.error('  gateway: ' + e.message)
      try {
        res.writeHead(500)
        res.end()
      } catch {}
    })
  })
  gateway.on('error', e => {
    console.error(`  gateway: cannot listen on ${WM_PORT}: ${e.message}`)
    gateway = null
  })
  // The LAN, on purpose - this is the one listener that has to be reachable
  // from the floor, and it forwards /wm and nothing else.
  gateway.listen(WM_PORT, '0.0.0.0', () => {
    const ips = lanAddresses()
    console.log(`  handhelds   http://${ips[0] || '<this PC>'}:${WM_PORT}/wm  (Windows Mobile gateway)`)
    console.log(`              test page: http://${ips[0] || '<this PC>'}:${WM_PORT}/ping`)
    if (ips.length > 1) console.log('              this PC also answers on: ' + ips.slice(1).join(', '))
  })
}

/* ---------------- http ---------------- */

function cors(req, res) {
  const origin = req.headers.origin
  if (origin && ALLOW.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    // Chrome refuses a public https page reaching a localhost service without
    // this on the preflight.
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Vary', 'Origin')
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error('Job too large. Split it.')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const server = http.createServer(async (req, res) => {
  cors(req, res)
  if (req.method === 'OPTIONS') return void res.writeHead(204).end()
  const url = (req.url || '/').split('?')[0]

  try {
    if (req.method === 'GET' && (url === '/' || url === '/setup')) {
      const printers = await listPrinters()
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return void res.end(PAGE(printers))
    }

    if (req.method === 'GET' && url === '/status') {
      return void json(res, 200, {
        ok: Boolean(target.mode),
        target: describe(),
        reprint: reprint.mode ? describe(reprint) : null,
        mode: target.mode,
        configured: Boolean(target.mode),
        queue: {
          ...queue,
          app: link.app,
          name: link.name,
          site: link.site,
          siteName: link.siteName,
          connected: Boolean(link.key && link.site),
        },
        gateway: { port: WM_PORT, addresses: lanAddresses(), hits: gatewayHits.slice(0, 12) },
      })
    }

    if (req.method === 'GET' && url === '/printers') {
      return void json(res, 200, { printers: await listPrinters() })
    }

    if (req.method === 'POST' && url === '/target') {
      const body = JSON.parse((await readBody(req, 64 * 1024)) || '{}')
      if (body.mode === 'network' && !String(body.host || '').trim())
        return void json(res, 400, { error: 'An IP address is needed.' })
      if (body.mode === 'local' && !String(body.printer || '').trim())
        return void json(res, 400, { error: 'Pick an installed printer.' })
      target = {
        mode: body.mode === 'local' ? 'local' : 'network',
        host: String(body.host || '').trim(),
        port: Number(body.port) || 9100,
        printer: String(body.printer || ''),
      }
      persist()
      console.log('  printer set to ' + describe())
      void pollLoop()
      return void json(res, 200, { ok: true, target: describe() })
    }

    if (req.method === 'POST' && url === '/wm-gateway') {
      const body = JSON.parse((await readBody(req, 64 * 1024)) || '{}')
      const port = Math.max(0, Math.floor(Number(body.port) || 0))
      if (port && (port < 1024 || port > 65535 || port === LISTEN))
        return void json(res, 400, { error: 'Use a port from 1024 to 65535, not the relay\'s own.' })
      WM_PORT = port
      persist()
      startGateway()
      const address = WM_PORT ? `http://${lanAddresses()[0] || '<this PC>'}:${WM_PORT}/wm` : ''
      console.log(WM_PORT ? `  handheld gateway on ${address}` : '  handheld gateway off')
      return void json(res, 200, { ok: true, address })
    }

    // The web app link. /app/check proves the address and key and lists the
    // sites; /app saves the lot and starts polling. A link that does not work
    // is refused rather than saved - a relay that silently prints nothing is
    // worse than one that says why.
    if (req.method === 'POST' && (url === '/app/check' || url === '/app')) {
      const body = JSON.parse((await readBody(req, 64 * 1024)) || '{}')
      const use = {
        app: String(body.app || '').trim().replace(/\/$/, ''),
        key: String(body.key || '').trim(),
        name: String(body.name || '').trim().slice(0, 40) || os.hostname(),
      }
      let d
      try {
        d = await checkApp(use)
      } catch (e) {
        return void json(res, 400, { error: e.message })
      }
      if (url === '/app/check') return void json(res, 200, { ok: true, sites: d.sites, name: d.name })
      const site = Number(body.site)
      const found = (d.sites || []).find(s => s.id === site)
      if (!found) return void json(res, 400, { error: 'Pick a site for this relay to print for.' })
      link = { app: use.app, key: use.key, name: use.name, site, siteName: found.name }
      persist()
      console.log(`  connected to ${link.app} as "${link.name}" for ${link.siteName}`)
      queue.state = 'off'
      queue.detail = ''
      void pollLoop()
      return void json(res, 200, { ok: true, site: found.name })
    }

    if (req.method === 'POST' && url === '/target-reprint') {
      const body = JSON.parse((await readBody(req, 64 * 1024)) || '{}')
      if (body.mode === 'network' && !String(body.host || '').trim())
        return void json(res, 400, { error: 'An IP address is needed.' })
      if (body.mode === 'local' && !String(body.printer || '').trim())
        return void json(res, 400, { error: 'Pick an installed printer.' })
      reprint = {
        mode: body.mode === 'local' ? 'local' : body.mode === 'network' ? 'network' : null,
        host: String(body.host || '').trim(),
        port: Number(body.port) || 9100,
        printer: String(body.printer || ''),
      }
      persist()
      console.log('  reprints go to ' + (reprint.mode ? describe(reprint) : 'the batch printer'))
      return void json(res, 200, { ok: true, target: reprint.mode ? describe(reprint) : 'the same printer as the batches' })
    }

    if (req.method === 'POST' && url === '/test-reprint') {
      if (!reprint.mode) return void json(res, 409, { error: 'No reprint printer is set - reprints go to the batch printer.' })
      await send(TEST_ZPL, reprint)
      console.log('  test label -> reprint printer ' + describe(reprint))
      return void json(res, 200, { ok: true })
    }

    if (req.method === 'POST' && (url === '/print' || url === '/test')) {
      if (!target.mode) return void json(res, 409, { error: 'No printer chosen yet. Open http://localhost:' + LISTEN })
      const zpl = url === '/test' ? TEST_ZPL : await readBody(req)
      // ^PQ, not ^XZ: the site format closes several blocks per label and
      // its preamble has eleven of its own, so counting ^XZ reports nonsense.
      const labels = (zpl.match(/\^PQ/g) || []).length
      await send(zpl)
      console.log(`  sent ${labels} label(s), ${zpl.length.toLocaleString()} bytes -> ${describe()}`)
      return void json(res, 200, { ok: true, labels, bytes: zpl.length })
    }

    if (req.method === 'POST' && url === '/quit') {
      json(res, 200, { ok: true })
      console.log('  stopping, asked from the app window')
      // Let the response flush before the process goes.
      setTimeout(() => process.exit(0), 250)
      return
    }

    json(res, 404, { error: 'POST ZPL to /print, or open / for setup' })
  } catch (e) {
    console.error('  FAILED: ' + e.message)
    json(res, 502, { error: e.message })
  }
})

// Loopback only. Nothing off this PC has any business printing here.
server.listen(LISTEN, '127.0.0.1', () => {
  const url = `http://localhost:${LISTEN}`
  console.log('')
  console.log('  Label print relay')
  console.log('  ' + '-'.repeat(40))
  console.log('  setup page  ' + url)
  console.log('  printing to ' + describe())
  if (reprint.mode) console.log('  reprints to ' + describe(reprint))
  console.log('  accepting   ' + ALLOW.join(', '))
  if (link.key && link.site) console.log(`  queue       ${link.app} as "${link.name}" for ${link.siteName || 'site ' + link.site}`)
  else console.log('  queue       not connected - open the setup page to connect to the web app')
  console.log('')
  void pollLoop()
  startGateway()
  console.log('  Close the app window to stop, or press Ctrl-C here.')
  if (!argv.includes('--no-window')) openWindow(url)
})

/**
 * Open the setup page as its own window rather than a browser tab.
 *
 * `--app=` on Edge or Chrome gives a chromeless window with no address bar or
 * tabs, which is as close to a native app as this gets without shipping a
 * whole browser runtime alongside it. Falls back to the default browser, which
 * still works, just with browser furniture around it.
 */
function openWindow(url) {
  if (process.platform !== 'win32') return
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  for (const exe of candidates) {
    if (!fs.existsSync(exe)) continue
    try {
      spawn(exe, [`--app=${url}`, '--window-size=680,760'], {
        detached: true,
        stdio: 'ignore',
      }).unref()
      return
    } catch {
      /* try the next one */
    }
  }
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}
