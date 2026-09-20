/**
 * Builds a standalone print-server.exe.
 *
 *   npm run build-exe
 *
 * Node's own single-executable format: a config file describes the entry
 * script, `--experimental-sea-config` bakes it into a blob, and postject
 * injects that blob into a copy of node.exe. The result needs nothing
 * installed on the machine that runs it - no Node, no npm, no dependencies.
 *
 * The entry has to be CommonJS, which is why the relay is `.cjs`.
 *
 * postject is fetched with npx at build time and is not a dependency of the
 * app. Only whoever cuts a release runs this.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, copyFileSync, existsSync, statSync, rmSync, renameSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'dist')
const entry = join(root, 'scripts', 'print-server.cjs')
const blob = join(out, 'print-server.blob')
// Built beside the real one and swapped in at the end. The first version
// deleted dist/print-server.exe before building, which was wrong twice over:
// any failure after that left no relay at all, and when the relay is running
// - which on the PC that builds it, it usually is - Windows holds the file
// and the delete throws before a byte is built.
// Either name may be the one the relay is running from right now - after a
// build that could not replace print-server.exe, the natural thing is to start
// print-server.new.exe, and then that is the locked one. So the build goes to
// a name of its own and is moved onto whichever of the two is free.
const final = join(out, 'print-server.exe')
const spare = join(out, 'print-server.new.exe')
const exe = join(out, `print-server.build-${Date.now()}.exe`)
const cfg = join(out, 'sea-config.json')

// No shell: node lives under "C:\Program Files\nodejs" and a shell splits
// that on the space. npx needs its .cmd shim named explicitly instead.
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })

const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'

if (process.platform !== 'win32') {
  console.error('This builds a Windows .exe. On another platform the same steps')
  console.error('produce a native binary for that platform instead - change the')
  console.error('output name and drop the signature step.')
}

mkdirSync(out, { recursive: true })
// Leftovers of earlier builds. One that is locked is a relay someone is running; leave it.
for (const f of readdirSync(out)) if (/^print-server\.build-\d+\.exe$/.test(f)) try { rmSync(join(out, f)) } catch {}

// The setup page's script lives inside a template string in the relay, so an
// escape written once is interpreted twice: a backslash-n in it reaches the
// browser as a real line break inside a quoted string, the script fails to parse, and
// every button in the window is dead. `node --check` on the relay cannot see
// that - the relay file is valid. So serve the page and parse what is served.
console.log('0/4  checking the setup page the relay serves')
{
  const { spawn } = await import('node:child_process')
  const port = 9187
  const child = spawn(process.execPath, [entry, '--no-window', '--listen', String(port), '--site', '0', '--app', 'http://127.0.0.1:1', '--key', 'none', '--wm-port', '0'], { stdio: 'ignore' })
  let html = ''
  try {
    for (let i = 0; i < 40 && !html; i++) {
      await new Promise(r => setTimeout(r, 250))
      html = await fetch(`http://127.0.0.1:${port}/`).then(r => r.text()).catch(() => '')
    }
  } finally {
    await fetch(`http://127.0.0.1:${port}/quit`, { method: 'POST' }).catch(() => {})
    child.kill()
  }
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (!script) {
    console.error('  FAILED: the relay did not serve its setup page. Nothing was built.')
    process.exit(1)
  }
  try {
    new Function(script)
  } catch (e) {
    console.error(`  FAILED: the setup page's script does not parse - ${e.message}`)
    console.error('          Every button in the relay window would be dead. Nothing was built.')
    process.exit(1)
  }
}

console.log('1/4  writing the sea config')
writeFileSync(
  cfg,
  JSON.stringify(
    {
      main: entry,
      output: blob,
      disableExperimentalSEAWarning: true,
      // The relay reads no files of its own at startup, so nothing to bundle.
      useSnapshot: false,
      useCodeCache: true,
    },
    null,
    2,
  ),
)

console.log('2/4  building the blob')
run(process.execPath, ['--experimental-sea-config', cfg])

console.log('3/4  copying the node runtime')
copyFileSync(process.execPath, exe)

// node.exe ships Authenticode-signed. Injecting a blob invalidates that
// signature, and Windows is happier with no signature than a broken one.
try {
  run('signtool', ['remove', '/s', exe], { stdio: 'ignore' })
  console.log('     removed the existing signature')
} catch {
  console.log('     signtool not present, leaving the signature alone (harmless)')
}

console.log('4/4  injecting')
// shell:true only here - npx is a .cmd shim on Windows and will not spawn
// without one. Paths are quoted because the shell would otherwise split them.
run(
  NPX,
  [
    '--yes',
    'postject',
    JSON.stringify(exe),
    'NODE_SEA_BLOB',
    JSON.stringify(blob),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { shell: true },
)

// Never leave a half-built exe behind. If injection failed, what is on disk
// is a plain copy of node.exe - it starts, treats the relay's own flags as
// bad Node options, and exits, which reads as "the app does not start".
// A real build is the runtime plus the blob, so the size says which it is.
const grew = statSync(exe).size >= statSync(process.execPath).size + statSync(blob).size
if (!grew) {
  rmSync(exe)
  console.error('')
  console.error('  FAILED: the blob was not injected. No exe was written. Run again.')
  process.exit(1)
}

const mb = (statSync(exe).size / 1024 / 1024).toFixed(0)

// Swap it in. If the relay is running from the old file Windows will not let
// go of it; that is not a failed build, so say exactly where the new one is
// rather than leaving someone to copy the old exe believing it is current.
let where = exe
const locked = e => e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES'
for (const name of [final, spare]) {
  try {
    if (existsSync(name)) rmSync(name)
    renameSync(exe, name)
    where = name
    break
  } catch (e) {
    if (!locked(e)) throw e
    console.log(`  NOTE: ${name.slice(out.length + 1)} is in use - a relay is running from it - so it was left alone.`)
  }
}
if (where !== final) {
  console.log('')
  console.log(`  The NEW build is ${where.slice(out.length + 1)}. Use that file: stop the relay (Stop in its`)
  console.log('  window) and start this one, or copy it to the relay PC. The saved setup carries over.')
}
console.log('')
console.log(`  built  ${where}  (${mb} MB)`)
console.log('')
console.log('  It carries the whole Node runtime, which is where the size goes.')
console.log('  Copy it to the PC with the printer and double-click it - the setup')
console.log('  page opens in a browser, pick the printer, done.')
