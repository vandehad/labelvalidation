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
import { mkdirSync, writeFileSync, copyFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'dist')
const entry = join(root, 'scripts', 'print-server.cjs')
const blob = join(out, 'print-server.blob')
const exe = join(out, 'print-server.exe')
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
if (existsSync(exe)) rmSync(exe)

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

const mb = (statSync(exe).size / 1024 / 1024).toFixed(0)
console.log('')
console.log(`  built  ${exe}  (${mb} MB)`)
console.log('')
console.log('  It carries the whole Node runtime, which is where the size goes.')
console.log('  Copy it to the PC with the printer and double-click it - the setup')
console.log('  page opens in a browser, pick the printer, done.')
