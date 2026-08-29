/**
 * Local print relay. Runs on the PC the Zebra is attached to.
 *
 *   node scripts/print-server.cjs                     open the setup page
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

const send = zpl => (target.mode === 'network' ? sendTcp(zpl) : sendWindowsRaw(zpl))

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
  <p>Leave this running while you print. The web app talks to it at
     <span class="now">http://localhost:${LISTEN}</span>, and it passes labels to the printer.</p>
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
 $('test').onclick = async () => {
   say('ok', 'Sending…')
   const r = await fetch('/test', { method: 'POST' })
   const d = await r.json()
   say(r.ok ? 'ok' : 'bad', r.ok ? 'Sent. A label should come out.' : (d.error || 'Failed.'))
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
      saveConfig({ ...target, listen: LISTEN, allow: ALLOW.join(',') })
      console.log('  printer set to ' + describe())
      return void json(res, 200, { ok: true, target: describe() })
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
  console.log('  accepting   ' + ALLOW.join(', '))
  console.log('')
  console.log('  Leave this window open. Ctrl-C to stop.')
  if (!target.mode && process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  }
})
