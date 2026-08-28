/**
 * Local print relay. Run this on the PC the Zebra is attached to.
 *
 *   node scripts/print-server.mjs --printer "ZDesigner ZD620"     USB / local queue
 *   node scripts/print-server.mjs --host 192.168.1.50             network printer
 *   node scripts/print-server.mjs --host 192.168.1.50 --port 9100
 *
 * A browser cannot open a raw socket and cannot reach a USB printer, so the
 * hosted app POSTs ZPL here and this forwards it. Two backends:
 *
 *   network  a raw TCP socket to port 9100, the printer's own protocol
 *   local    Windows spooler in RAW mode, via winspool WritePrinter
 *
 * The Windows path goes through PowerShell rather than a native module,
 * because a native module would need a compiler on a warehouse PC. RAW mode
 * matters: sending ZPL through a normal driver prints the *text* of the ZPL,
 * pages of it, which is a memorable way to waste a roll.
 *
 * No dependencies. Node 20+.
 */
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ---------------- arguments ---------------- */

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

const PRINTER = arg('printer')
const HOST = arg('host')
const PORT = Number(arg('port', '9100'))
const LISTEN = Number(arg('listen', '9110'))
// Which web origins may talk to this. The relay only ever prints, but it
// should still not take orders from any page that happens to be open.
const ALLOW = (arg('allow', 'https://labelvalidation.vercel.app,http://localhost:3000') || '').split(',')

if (!PRINTER && !HOST) {
  console.error('Give it a printer:')
  console.error('  --printer "ZDesigner ZD620"     a USB or otherwise local queue')
  console.error('  --host 192.168.1.50             a network printer on port 9100')
  console.error('')
  console.error('Local queue names, on Windows:')
  console.error('  powershell -c "Get-Printer | Select-Object Name"')
  process.exit(1)
}

/* ---------------- the two backends ---------------- */

/**
 * Raw TCP. One socket for the whole job, respecting backpressure - a printer
 * accepts data far slower than a socket will take it, and thousands of labels
 * will overrun a printer that is written to without waiting for drain.
 */
function sendTcp(zpl) {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: HOST, port: PORT })
    sock.setTimeout(120_000)
    sock.on('error', reject)
    sock.on('timeout', () => {
      sock.destroy()
      reject(new Error(`Timed out talking to ${HOST}:${PORT}`))
    })
    sock.on('connect', () => {
      sock.write(zpl, () => sock.end())
    })
    sock.on('close', () => resolve())
  })
}

/**
 * Windows spooler, RAW. Add-Type compiles the P/Invoke on the fly, so there is
 * nothing to install. The file is passed by path rather than inline because a
 * job of thousands of labels is far past any sane command-line length.
 */
function sendWindowsRaw(zpl) {
  return new Promise((resolve, reject) => {
    const file = join(tmpdir(), `lv-${Date.now()}-${Math.random().toString(36).slice(2)}.zpl`)
    writeFileSync(file, zpl, 'binary')

    const ps = `
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
  public static void Send(string printer, string path) {
    byte[] bytes = File.ReadAllBytes(path);
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

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps, '-args', PRINTER, file],
      { windowsHide: true },
    )
    let err = ''
    child.stderr.on('data', d => (err += d))
    child.on('error', e => {
      try { unlinkSync(file) } catch { /* gone already */ }
      reject(e)
    })
    child.on('close', code => {
      try { unlinkSync(file) } catch { /* gone already */ }
      code === 0 ? resolve() : reject(new Error(err.trim() || `PowerShell exited ${code}`))
    })
  })
}

const send = HOST ? sendTcp : sendWindowsRaw
const target = HOST ? `${HOST}:${PORT}` : `queue "${PRINTER}"`

/* ---------------- http ---------------- */

function cors(req, res) {
  const origin = req.headers.origin
  if (origin && ALLOW.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    // Chrome's Private Network Access preflight: a public https page reaching
    // a localhost service is refused without this.
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Vary', 'Origin')
}

const server = createServer(async (req, res) => {
  cors(req, res)
  if (req.method === 'OPTIONS') return void res.writeHead(204).end()

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return void res.end(JSON.stringify({ ok: true, target, mode: HOST ? 'network' : 'local' }))
  }

  if (req.method !== 'POST' || req.url !== '/print') {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    return void res.end(JSON.stringify({ error: 'POST ZPL to /print, or GET /status' }))
  }

  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > 64 * 1024 * 1024) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      return void res.end(JSON.stringify({ error: 'Job too large. Split it.' }))
    }
    chunks.push(c)
  }
  const zpl = Buffer.concat(chunks).toString('utf8')
  const labels = (zpl.match(/\^XA/g) ?? []).length

  try {
    await send(zpl)
    console.log(`  sent ${labels} label(s), ${size.toLocaleString()} bytes -> ${target}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, labels, bytes: size }))
  } catch (e) {
    console.error(`  FAILED: ${e.message}`)
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: e.message }))
  }
})

// Loopback only. Nothing outside this PC has any business printing here.
server.listen(LISTEN, '127.0.0.1', () => {
  console.log(`label relay on http://localhost:${LISTEN}`)
  console.log(`printing to ${target}`)
  console.log(`accepting from ${ALLOW.join(', ')}`)
  console.log('\nleave this running; ctrl-c to stop')
})
