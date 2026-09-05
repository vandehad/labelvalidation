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

const LISTEN = Number(arg('listen', saved.listen || '9110'))
const ALLOW = (arg('allow') || saved.allow || 'https://labelvalidation.vercel.app,http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const describe = () =>
  !target.mode ? 'nothing yet' : target.mode === 'network' ? `${target.host}:${target.port}` : `queue "${target.printer}"`

/* ---------------- the web app's print queue ---------------- */

const VERSION = '2'
let link = {
  app: arg('app') || saved.app || 'https://labelvalidation.vercel.app',
  key: arg('key') || saved.key || '',
  name: arg('name') || saved.name || os.hostname(),
  site: Number(arg('site') || saved.site || 0),
  siteName: saved.siteName || '',
  // Label width in dots, forced into every label. The ZQ630 forgets its
  // width at every power-on and nothing makes it keep one; ^PW in each label
  // is what worked. Per relay, because it is about this printer.
  // 4in stock is 832 dots, 3in is 609. Always sent; there is no "printer's
  // own setting", because the printer's own setting is the thing that drifts.
  width: Number(arg('width') || saved.width) === 609 ? 609 : 832,
}
const persist = () => saveConfig({ ...target, ...link, listen: LISTEN, allow: ALLOW.join(',') })

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

/** One poll: take the next job for this site, print it, report back. */
async function pollOnce() {
  const q =
    '?relay=' + encodeURIComponent(link.name) + '&site=' + link.site +
    '&target=' + encodeURIComponent(describe()) + '&v=' + VERSION
  const r = await appFetch('/api/print/next' + q)
  if (r.status === 204) return false
  const job = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(job.error || 'The app returned ' + r.status)

  let ok = true
  let error = ''
  try {
    await send(job.zpl)
  } catch (e) {
    ok = false
    error = e.message
  }
  const labels = (job.codes || []).length
  const copies = job.copies || 1
  queue.lastJob = { id: job.id, ok, error, labels, at: Date.now() }
  if (ok) {
    queue.printed += labels * copies
    console.log(`  job #${job.id}: ${labels} label(s) x${copies} -> ${describe()}`)
  } else console.error(`  job #${job.id} FAILED: ${error}`)

  const done = await appFetch('/api/print/' + job.id + '?relay=' + encodeURIComponent(link.name), {
    method: 'POST',
    body: JSON.stringify({ ok, error }),
  })
  if (!done.ok) console.error(`  could not report job #${job.id}: the app returned ` + done.status)
  return true
}

let pollTimer = null
async function pollLoop() {
  clearTimeout(pollTimer)
  let delay = 15000
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
      // seconds for a while after; then gently, so an idle relay does not
      // keep the database awake for nothing.
      delay = had ? 200 : Date.now() - queue.lastWork < 120000 ? 2000 : 15000
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

function sendTcp(zpl) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: target.host, port: target.port })
    sock.setTimeout(120000)
    sock.on('error', reject)
    sock.on('timeout', () => {
      sock.destroy()
      reject(new Error(`Timed out talking to ${target.host}:${target.port}`))
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
[Raw]::Send($args[0], $args[1])
`.trim()

function powershell(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, '-args', ...args],
      { windowsHide: true },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `PowerShell exited ${code}`))))
  })
}

async function sendWindowsRaw(zpl) {
  // By path, not inline: a run of thousands of labels is far past any sane
  // command-line length.
  const file = path.join(os.tmpdir(), `lv-${Date.now()}-${Math.random().toString(36).slice(2)}.zpl`)
  fs.writeFileSync(file, zpl, 'binary')
  try {
    await powershell(PS_RAW, [target.printer, file])
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
    const out = await powershell('Get-Printer | Select-Object -ExpandProperty Name', [])
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Stamp the width into every format block. Inside each ^XA, not ahead of the
 * job: the site preamble carries ^JUR, which restores the printer's saved
 * configuration and would undo a ^PW sent before it. Every label carrying
 * its own ^PW is what survived the ZQ630's power cycles.
 */
const forceWidth = (zpl, dots) => zpl.replace(/\^XA/g, '^XA^PW' + dots)

const send = zpl => {
  const out = forceWidth(zpl, link.width)
  return target.mode === 'network' ? sendTcp(out) : sendWindowsRaw(out)
}

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
  <label>Label stock in this printer</label>
  <select id="width">
    <option value="832"${link.width !== 609 ? ' selected' : ''}>4 inch wide - sends ^PW832 with every label</option>
    <option value="609"${link.width === 609 ? ' selected' : ''}>3 inch wide - sends ^PW609 with every label</option>
  </select>
  <p style="margin-top:10px">Stamped into every label, so a printer that forgets its width at power-on still
     prints to the stock it has loaded.</p>
  <button class="ghost" id="check">Check connection</button>
  <button id="connect">Save and print for this site</button>
  <div class="msg" id="qmsg"></div>
  <p id="qstat" style="margin-top:12px;font-weight:600"></p>
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
   width: Number($('width').value),
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
   } catch (e) {}
 }
 refreshStatus(); setInterval(refreshStatus, 3000)
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
        mode: target.mode,
        configured: Boolean(target.mode),
        queue: {
          ...queue,
          app: link.app,
          name: link.name,
          site: link.site,
          siteName: link.siteName,
          width: link.width,
          connected: Boolean(link.key && link.site),
        },
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
      const width = Number(body.width) === 609 ? 609 : 832
      link = { app: use.app, key: use.key, name: use.name, site, siteName: found.name, width }
      persist()
      console.log(`  connected to ${link.app} as "${link.name}" for ${link.siteName}, ^PW${width} on every label`)
      queue.state = 'off'
      queue.detail = ''
      void pollLoop()
      return void json(res, 200, { ok: true, site: found.name })
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
  console.log('  printing to ' + describe() + ` with ^PW${link.width} on every label`)
  console.log('  accepting   ' + ALLOW.join(', '))
  if (link.key && link.site) console.log(`  queue       ${link.app} as "${link.name}" for ${link.siteName || 'site ' + link.site}`)
  else console.log('  queue       not connected - open the setup page to connect to the web app')
  console.log('')
  void pollLoop()
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
