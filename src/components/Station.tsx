'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  validatePair,
  parseMapTable,
  NEW_PATTERN,
  type Basis,
  type ZMode,
  type MapParse,
  type Verdict,
  parseZones,
  newCode,
  displayCode,
} from '@/lib/bins'
import { readTable, parseDelimited } from '@/lib/sheet'
import { zplBatch } from '@/lib/zpl'

type User = { name: string; role: string }
type Site = { id: number; name: string; status: string; labels: number; pairs: number }
type Pair = {
  id: number
  old_bin: string
  new_bin: string
  location: string | null
  username: string | null
  created_at: string
}
type Loc = { zone: string; aisle: number; col: number | null }
type Source = 'map' | 'pairs'
type Check = {
  id: number
  old_bin: string
  new_bin: string
  expected_bin: string | null
  verdict: Verdict
  username: string | null
  created_at: string
}

const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`)
  return body
}

/**
 * Scanner feedback has to be audible: nobody on a floor is looking at the
 * screen while their hands are on a scan gun. High and short means good,
 * low and long means stop.
 */
function useBeep(on: boolean) {
  const actx = useRef<AudioContext | null>(null)
  return useCallback(
    (good: boolean) => {
      if (!on) return
      try {
        actx.current ??= new AudioContext()
        const a = actx.current
        const o = a.createOscillator()
        const g = a.createGain()
        o.connect(g)
        g.connect(a.destination)
        o.frequency.value = good ? 1180 : 220
        o.type = good ? 'sine' : 'square'
        g.gain.setValueAtTime(0.14, a.currentTime)
        g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + (good ? 0.11 : 0.42))
        o.start()
        o.stop(a.currentTime + (good ? 0.12 : 0.45))
      } catch {
        /* no audio device */
      }
    },
    [on],
  )
}

export default function Station({ initialUser }: { initialUser: User | null }) {
  const [user, setUser] = useState<User | null>(initialUser)
  if (!user) return <Login onIn={setUser} />
  return <Main user={user} onOut={() => setUser(null)} />
}

/* ------------------------------------------------------------------ */

function Login({ onIn }: { onIn: (u: User) => void }) {
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const go = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const { user } = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) })
      onIn(user)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header>
        <h1>LABEL VALIDATION</h1>
      </header>
      <div className="login">
        <form className="card" onSubmit={go}>
          <h2>Sign in</h2>
          {err && <div className="msg show bad">{err}</div>}
          <label>Username</label>
          <input value={u} onChange={e => setU(e.target.value)} autoFocus autoComplete="username" />
          <label>Password</label>
          <input type="password" value={p} onChange={e => setP(e.target.value)} autoComplete="current-password" />
          <button className="act" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */

function Main({ user, onOut }: { user: User; onOut: () => void }) {
  const [tab, setTab] = useState<'scan' | 'val' | 'labels' | 'rec'>('scan')
  const [sites, setSites] = useState<Site[]>([])
  const [siteId, setSiteId] = useState<number | null>(null)
  const [err, setErr] = useState('')

  const loadSites = useCallback(async () => {
    try {
      const { sites } = await api('/api/sites')
      setSites(sites)
      setSiteId(cur => cur ?? (sites[0]?.id ?? null))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void loadSites()
  }, [loadSites])

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' })
    onOut()
  }

  const addSite = async () => {
    const name = prompt('New site name')
    if (!name) return
    try {
      const { site } = await api('/api/sites', { method: 'POST', body: JSON.stringify({ name }) })
      await loadSites()
      setSiteId(site.id)
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <header>
        <h1>LABEL VALIDATION</h1>
        <div className="site">
          <label style={{ margin: 0, color: 'rgba(255,255,255,.75)' }}>Site</label>
          <select
            className="site"
            value={siteId ?? ''}
            onChange={e => setSiteId(Number(e.target.value))}
            style={{ width: 200 }}
          >
            {sites.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            {!sites.length && <option value="">— no sites —</option>}
          </select>
          {user.role === 'admin' && (
            <button className="act ghost" style={{ padding: '4px 10px', color: '#fff', borderColor: '#fff' }} onClick={addSite}>
              +
            </button>
          )}
        </div>
        <div className="who">
          <b>{user.name}</b>
          <span style={{ opacity: 0.7 }}>{user.role}</span>
          <button className="act ghost" style={{ padding: '4px 10px', color: '#fff', borderColor: '#fff' }} onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <nav>
        <button className={tab === 'scan' ? 'on' : ''} onClick={() => setTab('scan')}>
          Scan &amp; Pair
        </button>
        <button className={tab === 'val' ? 'on' : ''} onClick={() => setTab('val')}>
          Validate
        </button>
        <button className={tab === 'labels' ? 'on' : ''} onClick={() => setTab('labels')}>
          Labels
        </button>
        <button className={tab === 'rec' ? 'on' : ''} onClick={() => setTab('rec')}>
          Reconcile
        </button>
      </nav>

      <main>
        {err && <div className="msg show bad">{err}</div>}
        {!siteId ? (
          <div className="card">
            <h2>No site yet</h2>
            <p className="hint">
              {user.role === 'admin' ? 'Use + beside the site picker to create one.' : 'Ask an admin to create a site.'}
            </p>
          </div>
        ) : tab === 'scan' ? (
          <Scan siteId={siteId} user={user} />
        ) : tab === 'val' ? (
          <Validate siteId={siteId} siteName={sites.find(s => s.id === siteId)?.name ?? ''} user={user} />
        ) : tab === 'labels' ? (
          <Labels siteId={siteId} user={user} onDone={loadSites} />
        ) : (
          <Reconcile siteId={siteId} />
        )}
      </main>
    </>
  )
}

/* ------------------------------------------------------------------ */

function Scan({ siteId, user }: { siteId: number; user: User }) {
  const [where, setWhere] = useState('')
  const [oldBin, setOldBin] = useState('')
  const [newBin, setNewBin] = useState('')
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null)
  const [pairs, setPairs] = useState<Pair[]>([])
  const [totals, setTotals] = useState<{ pairs: number; labels: number }>({ pairs: 0, labels: 0 })
  const [byUser, setByUser] = useState<Array<{ username: string; n: number }>>([])
  const [sound, setSound] = useState(true)
  const [busy, setBusy] = useState(false)
  const oldRef = useRef<HTMLInputElement>(null)
  const newRef = useRef<HTMLInputElement>(null)
  const beep = useBeep(sound)

  const refresh = useCallback(async () => {
    try {
      const d = await api(`/api/pairs?site=${siteId}&limit=200`)
      setPairs(d.pairs)
      setTotals(d.totals)
      setByUser(d.byUser)
    } catch {
      /* transient - the poll will retry */
    }
  }, [siteId])

  useEffect(() => {
    void refresh()
    const t = setInterval(refresh, 10000) // see other scanners' progress
    return () => clearInterval(t)
  }, [refresh])

  const flash = (kind: string, text: string) => {
    setMsg({ kind, text })
    if (kind === 'ok') setTimeout(() => setMsg(m => (m?.text === text ? null : m)), 3000)
  }

  const commit = async () => {
    const o = oldBin.trim().toUpperCase()
    const n = newBin.trim().toUpperCase()
    if (!o || !n) return
    // Check locally first so an obvious mistake never costs a round trip.
    // The format gate is not optional - the server enforces it either way.
    // There is deliberately no zone/aisle check: a scanner moves around faster
    // than they would re-declare where they are standing, and the question
    // that matters is whether the two labels go together.
    const why = validatePair(o, n, { enforceFormat: true, location: null })
    if (why) {
      flash('bad', why)
      beep(false)
      newRef.current?.select()
      return
    }
    setBusy(true)
    try {
      const { pair } = await api('/api/pairs', {
        method: 'POST',
        body: JSON.stringify({
          siteId,
          oldBin: o,
          newBin: n,
          location: where.trim() || null,
        }),
      })
      setPairs(p => [pair, ...p])
      setTotals(t => ({ ...t, pairs: t.pairs + 1 }))
      flash('ok', `${o}  →  ${n}`)
      beep(true)
      setOldBin('')
      setNewBin('')
      oldRef.current?.focus()
    } catch (e) {
      flash('bad', e instanceof Error ? e.message : String(e))
      beep(false)
      newRef.current?.select()
    } finally {
      setBusy(false)
    }
  }

  const undo = async () => {
    const mine = pairs.find(p => user.role === 'admin' || p.username === user.name)
    if (!mine) return flash('warn', 'Nothing of yours to undo.')
    try {
      await api(`/api/pairs/${mine.id}`, { method: 'DELETE' })
      setPairs(p => p.filter(x => x.id !== mine.id))
      setTotals(t => ({ ...t, pairs: Math.max(0, t.pairs - 1) }))
      flash('warn', `Removed ${mine.old_bin} → ${mine.new_bin}`)
      oldRef.current?.focus()
    } catch (e) {
      flash('bad', e instanceof Error ? e.message : String(e))
    }
  }

  const key = (e: React.KeyboardEvent<HTMLInputElement>, from: 'old' | 'new') => {
    if (e.key !== 'Enter' && e.key !== 'Tab') return
    e.preventDefault()
    if (from === 'old') {
      if (oldBin.trim()) newRef.current?.focus()
    } else if (newBin.trim()) void commit()
    else oldRef.current?.focus()
  }

  return (
    <>
      <div className="card">
        <h2>Where you are working <span className="pill warn">optional</span></h2>
        <p className="hint">
          Recorded against every pair you scan and carried into the export. A note for whoever reads the
          workbook later — nothing is checked against it.
        </p>
        <input
          value={where}
          onChange={e => setWhere(e.target.value)}
          placeholder="e.g. Zone A, aisles 1-4"
          autoComplete="off"
        />
      </div>

      <div className="card">
        <h2>Scan pair</h2>
        <p className="hint">
          Scan the OLD label, then the NEW one. Enter moves along and saves. A new label that is not shaped
          like <code>A0101F01</code> is refused outright — it cannot be saved into the cross-reference.
        </p>
        {msg && <div className={`msg show ${msg.kind}`}>{msg.text}</div>}
        <div className="scanwrap">
          <div className={`scanfield ${oldBin ? 'armed' : ''}`}>
            <label>1 · Old bin</label>
            <input
              ref={oldRef}
              value={oldBin}
              onChange={e => setOldBin(e.target.value)}
              onKeyDown={e => key(e, 'old')}
              autoComplete="off"
              spellCheck={false}
              placeholder="scan…"
              autoFocus
            />
          </div>
          <div className={`scanfield ${newBin ? 'armed' : ''}`}>
            <label>2 · New bin</label>
            <input
              ref={newRef}
              value={newBin}
              onChange={e => setNewBin(e.target.value)}
              onKeyDown={e => key(e, 'new')}
              autoComplete="off"
              spellCheck={false}
              placeholder="scan…"
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Toggle label="Sound" v={sound} set={setSound} />
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <button className="act ghost" onClick={undo} disabled={busy}>
              Undo last
            </button>
            <button
              className="act ghost"
              onClick={() => {
                setOldBin('')
                setNewBin('')
                oldRef.current?.focus()
              }}
            >
              Clear
            </button>
            {busy && <span className="spin" />}
          </div>
        </div>
      </div>

      <div className="stats">
        <Stat n={totals.pairs.toLocaleString()} l="pairs captured" />
        <Stat n={totals.labels ? totals.labels.toLocaleString() : '—'} l="labels generated" />
        <Stat n={totals.labels ? (totals.labels - totals.pairs).toLocaleString() : '—'} l="labels unused" />
        <Stat n={byUser.length} l="people scanning" />
      </div>

      {byUser.length > 1 && (
        <div className="peer">
          {byUser.map(b => (
            <span key={b.username}>
              {b.username} <b>{b.n}</b>
            </span>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Recent pairs — everyone</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>OLD BIN</th>
                <th>NEW BIN</th>
                <th>LOCATION</th>
                <th>BY</th>
                <th>TIME</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map(p => (
                <tr key={p.id}>
                  <td>{p.old_bin}</td>
                  <td>{p.new_bin}</td>
                  <td>{p.location ?? '—'}</td>
                  <td>{p.username ?? '—'}</td>
                  <td>{new Date(p.created_at).toLocaleTimeString()}</td>
                </tr>
              ))}
              {!pairs.length && (
                <tr>
                  <td colSpan={5} style={{ color: 'var(--muted)' }}>
                    Nothing scanned yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */

function Labels({ siteId, user, onDone }: { siteId: number; user: User; onDone: () => void }) {
  const [mode, setMode] = useState<'derive' | 'batch'>('derive')
  const [text, setText] = useState('')
  const [basis, setBasis] = useState<Basis>('global')
  const [zMode, setZMode] = useState<ZMode>('auto')

  // batch
  const [zonesText, setZonesText] = useState('A-Z')
  const [aisleFrom, setAisleFrom] = useState('1')
  const [aisleTo, setAisleTo] = useState('1')
  const [columns, setColumns] = useState('24')
  const [shelves, setShelves] = useState('10')
  const [positions, setPositions] = useState('1')

  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<{
    stored: number
    columns: number
    zones: number
    tallest: number
    capped: Array<{ zone: string; aisle: number; col: number; needed: number }>
    unparsedCount: number
    unparsed: string[]
  } | null>(null)
  const [err, setErr] = useState('')

  if (user.role !== 'admin')
    return (
      <div className="card">
        <h2>Labels</h2>
        <p className="hint">Only an admin can generate the label set for a site.</p>
      </div>
    )

  const zones = parseZones(zonesText)
  const batchSpec = {
    mode: 'batch' as const,
    zones,
    aisleFrom: Math.max(0, Number(aisleFrom) || 0),
    aisleTo: Math.max(0, Number(aisleTo) || 0),
    columns: Math.max(1, Number(columns) || 1),
    shelves: Math.max(1, Number(shelves) || 1),
    positions: Math.max(1, Number(positions) || 1),
  }
  const aisleCount = Math.max(0, batchSpec.aisleTo - batchSpec.aisleFrom + 1)
  const perColumn = (batchSpec.shelves + (zMode === 'always' ? 1 : 0)) * batchSpec.positions
  const batchCount = zones.length * aisleCount * batchSpec.columns * perColumn

  const gen = async () => {
    setBusy(true)
    setErr('')
    try {
      let spec
      if (mode === 'derive') {
        const oldBins = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
        if (!oldBins.length) throw new Error('Paste the old bin list first.')
        spec = { mode: 'derive', oldBins, basis, zMode }
      } else {
        if (!zones.length) throw new Error('No zones - try A-Z, or A-E,K.')
        if (aisleCount < 1) throw new Error('The aisle range is backwards.')
        if (batchSpec.shelves > 26) throw new Error('More than 26 shelves has no letter left to use.')
        spec = {
          mode: 'manual',
          zones,
          aisleFrom: batchSpec.aisleFrom,
          aisleTo: batchSpec.aisleTo,
          colFrom: 1,
          colTo: batchSpec.columns,
          shelves: batchSpec.shelves,
          positions: batchSpec.positions,
          zMode,
        }
      }
      const r = await api('/api/labels', { method: 'POST', body: JSON.stringify({ siteId, spec }) })
      setRes(r)
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="card">
        <h2>Build the label set</h2>
        <p className="hint">
          Every zone/aisle/column gets a full run of shelf letters, so a label always exists no matter how
          tall the rack turns out to be. Unused ones fall out in Reconcile.
        </p>
        {err && <div className="msg show bad">{err}</div>}
        <div className="row">
          <div style={{ flex: '1 1 320px' }}>
            <label>Where the racks come from</label>
            <select value={mode} onChange={e => setMode(e.target.value as 'derive' | 'batch')}>
              <option value="derive">An old bin list — work out the racks from it</option>
              <option value="batch">A batch by range — say the shape of the warehouse</option>
            </select>
          </div>
          <div>
            <label>Reserve Z for floor level</label>
            <select value={zMode} onChange={e => setZMode(e.target.value as ZMode)}>
              <option value="auto">Only where shelf 0 exists</option>
              <option value="always">Always</option>
              <option value="never">Never</option>
            </select>
          </div>
        </div>

        {mode === 'derive' ? (
          <>
            <div className="row">
              <div style={{ flex: '1 1 320px' }}>
                <label>Shelf count basis</label>
                <select value={basis} onChange={e => setBasis(e.target.value as Basis)}>
                  <option value="global">Tallest column anywhere (uniform)</option>
                  <option value="zone">Tallest column in each zone</option>
                  <option value="aisle">Tallest column in each aisle</option>
                  <option value="actual">Actual shelves in each column</option>
                </select>
              </div>
            </div>
            <label>Old bin list — one per line</label>
            <textarea value={text} onChange={e => setText(e.target.value)} placeholder={'A-1-1-1\nA-1-1-2\nA010103'} />
          </>
        ) : (
          <>
            <div className="row">
              <div style={{ flex: '1 1 220px' }}>
                <label>Zones</label>
                <input
                  value={zonesText}
                  onChange={e => setZonesText(e.target.value)}
                  placeholder="A-Z, or A-E,K"
                  style={{ textTransform: 'uppercase' }}
                />
              </div>
              <div>
                <label>Aisle from</label>
                <input type="number" min={0} value={aisleFrom} onChange={e => setAisleFrom(e.target.value)} />
              </div>
              <div>
                <label>Aisle to</label>
                <input type="number" min={0} value={aisleTo} onChange={e => setAisleTo(e.target.value)} />
              </div>
              <div>
                <label>Columns per aisle</label>
                <input type="number" min={1} value={columns} onChange={e => setColumns(e.target.value)} />
              </div>
              <div>
                <label>Shelves per column</label>
                <input type="number" min={1} max={26} value={shelves} onChange={e => setShelves(e.target.value)} />
              </div>
              <div>
                <label>Positions per shelf</label>
                <input type="number" min={1} max={99} value={positions} onChange={e => setPositions(e.target.value)} />
              </div>
            </div>
            <div className="stats" style={{ marginTop: 4 }}>
              <Stat n={zones.length} l="zones" />
              <Stat n={aisleCount} l="aisles each" />
              <Stat n={batchSpec.columns} l="columns each" />
              <Stat n={perColumn} l="labels per column" />
              <Stat n={batchCount.toLocaleString()} l="labels in total" />
            </div>
            {batchCount > 20000 && (
              <div className="msg show warn">
                {batchCount.toLocaleString()} labels is a lot of stock — around{' '}
                {Math.ceil(batchCount / 1000).toLocaleString()} rolls of 1,000. Worth generating one zone at a
                time.
              </div>
            )}
            {zones.length > 0 && (
              <p className="hint">
                First and last: <code>{newCode(zones[0], batchSpec.aisleFrom, 1, 'A', 1)}</code> …{' '}
                <code>
                  {newCode(
                    zones[zones.length - 1],
                    batchSpec.aisleTo,
                    batchSpec.columns,
                    zMode === 'always' ? 'Z' : String.fromCharCode(64 + batchSpec.shelves),
                    batchSpec.positions,
                  )}
                </code>
              </p>
            )}
          </>
        )}

        <div className="btns" style={{ marginTop: 10 }}>
          <button className="act" onClick={gen} disabled={busy}>
            {busy ? 'Generating…' : mode === 'batch' ? `Generate ${batchCount.toLocaleString()} and store` : 'Generate and store'}
          </button>
          <a className="act ghost" href={`/api/export?site=${siteId}`} style={{ textDecoration: 'none' }}>
            Export workbook (.xlsx)
          </a>
        </div>
      </div>

      {res && (
        <div className="card">
          <h2>Generated</h2>
          <div className="stats">
            <Stat n={res.stored.toLocaleString()} l="labels stored" />
            <Stat n={res.columns.toLocaleString()} l="columns" />
            <Stat n={res.zones} l="zones" />
            <Stat n={res.tallest} l="tallest column" />
            <Stat n={res.capped.length} l="capped at 26" />
            <Stat n={res.unparsedCount} l="unreadable" />
          </div>
          {res.capped.length > 0 && (
            <div className="msg show warn">
              {res.capped.length} column(s) need more than 26 shelves and were capped — the alphabet runs
              out. Check: {res.capped.slice(0, 6).map(c => `${c.zone}-${c.aisle}-${c.col} (${c.needed})`).join(', ')}
            </div>
          )}
          {res.unparsedCount > 0 && (
            <div className="msg show warn">
              {res.unparsedCount} line(s) were not recognised as bins, e.g. {res.unparsed.slice(0, 5).join(', ')}
            </div>
          )}
        </div>
      )}

      <Print siteId={siteId} />
    </>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Printing to the Zebra.
 *
 * A browser cannot open a raw socket and cannot reach a USB printer, so there
 * are two ways out: download the ZPL and send it however you already do, or
 * run `scripts/print-server.mjs` on the PC the printer is attached to and let
 * this post to it. The relay covers both network and USB printers; the
 * download covers everything else.
 *
 * Labels are printed from what is *stored* for the site, never from the form
 * above, so what comes off the printer is what the database will accept.
 */
function Print({ siteId }: { siteId: number }) {
  const [relay, setRelay] = useState('http://localhost:9110')
  const [status, setStatus] = useState<{ ok: boolean; target?: string; mode?: string } | null>(null)
  const [dpi, setDpi] = useState<203 | 300>(203)
  const [copies, setCopies] = useState('1')
  const [darkness, setDarkness] = useState('10')
  const [speed, setSpeed] = useState('4')
  const [filter, setFilter] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null)

  const spec = { dpi, widthIn: 4, heightIn: 1, darkness: Number(darkness) || 10, speed: Number(speed) || 4, copies: Math.max(1, Number(copies) || 1) }

  const load = useCallback(async () => {
    try {
      const d = await api(`/api/labels?site=${siteId}`)
      setCodes((d.labels as Array<{ code: string }>).map(l => l.code))
    } catch (e) {
      setMsg({ kind: 'bad', text: e instanceof Error ? e.message : String(e) })
    }
  }, [siteId])

  useEffect(() => {
    void load()
  }, [load])

  const check = async () => {
    setStatus(null)
    try {
      const r = await fetch(relay.replace(/\/$/, '') + '/status')
      setStatus(await r.json())
    } catch {
      setStatus({ ok: false })
    }
  }

  const zones = parseZones(filter)
  const selected = (codes ?? []).filter(c => !zones.length || zones.includes(c[0]))

  const download = () => {
    const zpl = zplBatch(selected, spec)
    const blob = new Blob([zpl], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `labels-${selected.length}.zpl`
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      URL.revokeObjectURL(url)
      a.remove()
    }, 1500)
  }

  const print = async () => {
    if (!selected.length) return
    setBusy(true)
    setMsg(null)
    // Chunked so a job of thousands is a series of modest posts with visible
    // progress, rather than one request that looks like a hang.
    const CHUNK = 500
    try {
      for (let i = 0; i < selected.length; i += CHUNK) {
        const slice = selected.slice(i, i + CHUNK)
        setMsg({ kind: 'warn', text: `Sending ${Math.min(i + CHUNK, selected.length).toLocaleString()} of ${selected.length.toLocaleString()}…` })
        const r = await fetch(relay.replace(/\/$/, '') + '/print', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: zplBatch(slice, spec),
        })
        if (!r.ok) {
          const b = await r.json().catch(() => ({}))
          throw new Error(b.error || `Relay returned ${r.status}`)
        }
      }
      setMsg({ kind: 'ok', text: `Sent ${(selected.length * spec.copies).toLocaleString()} label(s) to the printer.` })
    } catch (e) {
      setMsg({
        kind: 'bad',
        text: `${e instanceof Error ? e.message : String(e)} — is the relay running? node scripts/print-server.mjs --host <printer-ip>`,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2>Print to the Zebra</h2>
      <p className="hint">
        Prints the labels stored for this site, so what comes off the printer is exactly what the database
        will accept. The barcode carries the code undashed — <code>A0000A01</code> — and the line underneath
        shows it as <code>A00-00A01</code> for a human to read. Scanning the dashed form would match nothing.
      </p>
      {msg && <div className={`msg show ${msg.kind}`}>{msg.text}</div>}

      <div className="row">
        <div>
          <label>Printer resolution</label>
          <select value={dpi} onChange={e => setDpi(Number(e.target.value) as 203 | 300)}>
            <option value={203}>203 dpi — ZD420 / ZD620 / ZT230</option>
            <option value={300}>300 dpi — the -300 models</option>
          </select>
        </div>
        <div>
          <label>Copies of each</label>
          <input type="number" min={1} value={copies} onChange={e => setCopies(e.target.value)} />
        </div>
        <div>
          <label>Darkness (0–30)</label>
          <input type="number" min={0} max={30} value={darkness} onChange={e => setDarkness(e.target.value)} />
        </div>
        <div>
          <label>Speed (in/sec)</label>
          <input type="number" min={1} max={14} value={speed} onChange={e => setSpeed(e.target.value)} />
        </div>
        <div>
          <label>Only these zones</label>
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="all" style={{ textTransform: 'uppercase' }} />
        </div>
      </div>

      <div className="stats" style={{ marginTop: 4 }}>
        <Stat n={(codes?.length ?? 0).toLocaleString()} l="labels stored" />
        <Stat n={selected.length.toLocaleString()} l="selected to print" />
        <Stat n={(selected.length * spec.copies).toLocaleString()} l="labels off the roll" />
        <Stat n={`4×1″`} l={`at ${dpi} dpi`} />
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <div style={{ flex: '1 1 260px' }}>
          <label>Local print relay</label>
          <input value={relay} onChange={e => setRelay(e.target.value)} placeholder="http://localhost:9110" />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <button className="act ghost" onClick={check}>
            Test relay
          </button>
          {status && (
            <span className={`pill ${status.ok ? 'ok' : 'bad'}`}>
              {status.ok ? `${status.mode} → ${status.target}` : 'not reachable'}
            </span>
          )}
        </div>
      </div>

      <div className="btns" style={{ marginTop: 12 }}>
        <button className="act" onClick={print} disabled={busy || !selected.length}>
          {busy ? 'Sending…' : `Print ${selected.length.toLocaleString()} label(s)`}
        </button>
        <button className="act ghost" onClick={download} disabled={!selected.length}>
          Download .zpl
        </button>
        {busy && <span className="spin" />}
      </div>

      {selected.length > 0 && (
        <p className="hint" style={{ marginTop: 10 }}>
          First: <code>{selected[0]}</code> prints as <code>{displayCode(selected[0])}</code>. Last:{' '}
          <code>{selected[selected.length - 1]}</code> as <code>{displayCode(selected[selected.length - 1])}</code>.
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function Reconcile({ siteId }: { siteId: number }) {
  const [d, setD] = useState<{
    counts: { labels: number; pairs: number; used: number; unused: number; unexpected: number }
    oneForOne: boolean
    unused: Array<{ code: string; zone: string; aisle: number; col: number; letter: string }>
    unexpected: Array<{ code: string; old_bin: string; username: string | null }>
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const run = useCallback(async () => {
    setBusy(true)
    setErr('')
    try {
      setD(await api(`/api/reconcile?site=${siteId}`))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [siteId])

  useEffect(() => {
    void run()
  }, [run])

  return (
    <>
      <div className="card">
        <h2>Reconcile</h2>
        <p className="hint">
          Anything printed but never scanned is a bin to delete. Anything scanned that is not in the label
          set needs investigating.
        </p>
        <div className="btns">
          <button className="act" onClick={run} disabled={busy}>
            {busy ? 'Checking…' : 'Re-check'}
          </button>
          <a className="act ghost" href={`/api/export?site=${siteId}`} style={{ textDecoration: 'none' }}>
            Export workbook (.xlsx)
          </a>
        </div>
        {err && <div className="msg show bad" style={{ marginTop: 12 }}>{err}</div>}
      </div>

      {d && (
        <>
          <div className="stats">
            <Stat n={d.counts.labels.toLocaleString()} l="labels" />
            <Stat n={d.counts.used.toLocaleString()} l="used" />
            <Stat n={d.counts.unused.toLocaleString()} l="unused → delete" />
            <Stat n={d.counts.unexpected.toLocaleString()} l="unexpected" />
            <Stat n={d.counts.pairs.toLocaleString()} l="pairs" />
            <Stat n={d.oneForOne ? '1 : 1' : 'CHECK'} l="match" />
          </div>
          <div className="split">
            <div className="card">
              <h2 style={{ color: 'var(--bad)' }}>Unused — delete these</h2>
              <div className="scroll" style={{ maxHeight: 320 }}>
                <table>
                  <thead>
                    <tr>
                      <th>LABEL</th>
                      <th>ZONE</th>
                      <th>AISLE</th>
                      <th>COL</th>
                      <th>SHELF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.unused.slice(0, 500).map(l => (
                      <tr key={l.code}>
                        <td>{l.code}</td>
                        <td>{l.zone}</td>
                        <td>{l.aisle}</td>
                        <td>{l.col}</td>
                        <td>{l.letter}</td>
                      </tr>
                    ))}
                    {!d.unused.length && (
                      <tr>
                        <td colSpan={5} style={{ color: 'var(--ok)' }}>
                          None — every label was used.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <h2 style={{ color: 'var(--warn)' }}>Scanned but not in the label set</h2>
              <div className="scroll" style={{ maxHeight: 320 }}>
                <table>
                  <thead>
                    <tr>
                      <th>NEW BIN</th>
                      <th>OLD BIN</th>
                      <th>BY</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.unexpected.slice(0, 500).map(u => (
                      <tr key={u.code} className="dupe">
                        <td>{u.code}</td>
                        <td>{u.old_bin}</td>
                        <td>{u.username ?? '—'}</td>
                      </tr>
                    ))}
                    {!d.unexpected.length && (
                      <tr>
                        <td colSpan={3} style={{ color: 'var(--ok)' }}>
                          None.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Validation mode - audit labels that are already hung.
 *
 * Pairing builds the mapping; this checks one that already exists. Scan the
 * old label, scan the new one, and the answer is match, mismatch, or the bin
 * is not in the reference at all. Nothing is refused: a wrong label has to be
 * recorded before anyone can go and fix it.
 *
 * The reference is either an uploaded worksheet or the pairs already scanned
 * in on this site, so an audit can run against a vendor file or against the
 * app's own work.
 */
function Validate({ siteId, siteName, user }: { siteId: number; siteName: string; user: User }) {
  const [source, setSource] = useState<Source>('map')
  const [counts, setCounts] = useState({ match: 0, mismatch: 0, unmapped: 0, checked: 0, reference: 0 })
  const [checks, setChecks] = useState<Check[]>([])
  const [byUser, setByUser] = useState<Array<{ username: string; n: number }>>([])
  const [dupNew, setDupNew] = useState<Array<{ new_bin: string; old_bins: string[] }>>([])

  const [oldBin, setOldBin] = useState('')
  const [newBin, setNewBin] = useState('')
  const [msg, setMsg] = useState<{ kind: string; text: string; sub?: string } | null>(null)
  const [sound, setSound] = useState(true)
  const [busy, setBusy] = useState(false)

  const [table, setTable] = useState<string[][] | null>(null)
  const [preview, setPreview] = useState<MapParse | null>(null)
  const [fileName, setFileName] = useState('')
  const [paste, setPaste] = useState('')
  const [loading, setLoading] = useState('')
  const [upErr, setUpErr] = useState('')

  const oldRef = useRef<HTMLInputElement>(null)
  const newRef = useRef<HTMLInputElement>(null)
  const beep = useBeep(sound)

  const refresh = useCallback(async () => {
    try {
      const d = await api(`/api/checks?site=${siteId}&source=${source}&limit=200`)
      setChecks(d.checks)
      setCounts(d.counts)
      setByUser(d.byUser)
    } catch {
      /* transient - the poll will retry */
    }
    if (source === 'map') {
      try {
        const m = await api(`/api/map?site=${siteId}`)
        setDupNew(m.dupNew ?? [])
      } catch {
        /* same */
      }
    } else setDupNew([])
  }, [siteId, source])

  useEffect(() => {
    void refresh()
    const t = setInterval(refresh, 10000)
    return () => clearInterval(t)
  }, [refresh])

  const flash = (kind: string, text: string, sub?: string) => {
    setMsg({ kind, text, sub })
  }

  /* ---------- upload ---------- */

  const take = (rows: string[][], name: string) => {
    setUpErr('')
    setFileName(name)
    setTable(rows)
    setPreview(parseMapTable(rows))
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setUpErr('')
    setLoading('Reading the file…')
    try {
      take(await readTable(f), f.name)
    } catch (err) {
      setUpErr(err instanceof Error ? err.message : String(err))
      setTable(null)
      setPreview(null)
    } finally {
      setLoading('')
      e.target.value = '' // so the same file can be picked again
    }
  }

  const onPaste = () => {
    let rows = parseDelimited(paste)
    // Two columns separated by spaces is what you get pasting out of Excel
    // into some editors, so fall back to any whitespace.
    if (rows.length && rows.every(r => r.length === 1)) {
      rows = rows.map(r => String(r[0]).trim().split(/\s+/))
    }
    if (!rows.length) return setUpErr('Nothing to read in that paste.')
    take(rows, 'pasted')
  }

  const load = async () => {
    if (!table) return
    setUpErr('')
    const CHUNK = 4000
    try {
      let stored = 0
      for (let i = 0; i < table.length; i += CHUNK) {
        setLoading(`Loading ${Math.min(i + CHUNK, table.length).toLocaleString()} of ${table.length.toLocaleString()}…`)
        const r = await api('/api/map', {
          method: 'POST',
          body: JSON.stringify({ siteId, rows: table.slice(i, i + CHUNK), replace: i === 0, rowOffset: i }),
        })
        stored = r.total
      }
      setTable(null)
      setPreview(null)
      setPaste('')
      setFileName('')
      flash('ok', `Bin map loaded — ${stored.toLocaleString()} rows for ${siteName}.`)
      await refresh()
    } catch (err) {
      setUpErr(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading('')
    }
  }

  const clearMap = async () => {
    if (!confirm(`Remove the whole bin map for ${siteName}? Audit results are kept.`)) return
    try {
      await api(`/api/map?site=${siteId}`, { method: 'DELETE' })
      await refresh()
      flash('warn', 'Bin map cleared.')
    } catch (err) {
      setUpErr(err instanceof Error ? err.message : String(err))
    }
  }

  /* ---------- scanning ---------- */

  const commit = async () => {
    const o = oldBin.trim().toUpperCase()
    const n = newBin.trim().toUpperCase()
    if (!o || !n) return
    if (o === n) {
      flash('bad', 'Old and new are identical — same label scanned twice?')
      beep(false)
      newRef.current?.select()
      return
    }
    setBusy(true)
    try {
      const r = await api('/api/checks', {
        method: 'POST',
        body: JSON.stringify({ siteId, source, oldBin: o, newBin: n }),
      })
      const v = r.verdict as Verdict
      const also = r.belongsTo ? `${n} belongs to ${r.belongsTo} in the reference.` : undefined
      if (v === 'match') {
        flash('ok', `MATCH — ${o} → ${n}`, also)
        beep(true)
      } else if (v === 'mismatch') {
        flash('bad', `MISMATCH — ${o} has ${n} hung, should be ${r.expected}`, also)
        beep(false)
      } else {
        flash('warn', `${o} is not in the reference — nothing says what it should be.`, also)
        beep(false)
      }
      setChecks(c => [r.check, ...c.filter(x => x.old_bin !== o)])
      await refresh()
      setOldBin('')
      setNewBin('')
      oldRef.current?.focus()
    } catch (err) {
      flash('bad', err instanceof Error ? err.message : String(err))
      beep(false)
      newRef.current?.select()
    } finally {
      setBusy(false)
    }
  }

  const undo = async () => {
    const mine = checks.find(c => user.role === 'admin' || c.username === user.name)
    if (!mine) return flash('warn', 'Nothing of yours to undo.')
    try {
      await api(`/api/checks/${mine.id}`, { method: 'DELETE' })
      setChecks(c => c.filter(x => x.id !== mine.id))
      await refresh()
      flash('warn', `Removed the check on ${mine.old_bin}.`)
      oldRef.current?.focus()
    } catch (err) {
      flash('bad', err instanceof Error ? err.message : String(err))
    }
  }

  const key = (e: React.KeyboardEvent<HTMLInputElement>, from: 'old' | 'new') => {
    if (e.key !== 'Enter' && e.key !== 'Tab') return
    e.preventDefault()
    if (from === 'old') {
      if (oldBin.trim()) newRef.current?.focus()
    } else if (newBin.trim()) void commit()
    else oldRef.current?.focus()
  }

  const isAdmin = user.role === 'admin'
  const todo = Math.max(0, counts.reference - counts.checked)

  return (
    <>
      <div className="card">
        <h2>What to audit against</h2>
        <p className="hint">
          Validation compares the label that is physically hung against a reference. It never refuses a scan —
          the point is to record what is on the shelf, right or wrong.
        </p>
        <div className="row">
          <div style={{ flex: '1 1 340px' }}>
            <label>Reference</label>
            <select value={source} onChange={e => setSource(e.target.value as Source)}>
              <option value="map">Uploaded bin map</option>
              <option value="pairs">Bins scanned in on this site (Scan &amp; Pair)</option>
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <span className="loc">
              {counts.reference.toLocaleString()} reference row{counts.reference === 1 ? '' : 's'} for {siteName}
            </span>
          </div>
        </div>
        {source === 'pairs' && !counts.reference && (
          <div className="msg show warn">
            Nothing has been scanned in on this site yet, so every check would come back as not-in-the-reference.
            Upload a bin map instead, or capture some pairs first.
          </div>
        )}
        {dupNew.length > 0 && (
          <div className="msg show warn">
            {dupNew.length} new code{dupNew.length === 1 ? ' is' : 's are'} claimed by more than one old bin in the
            uploaded map — that is a fault in the map itself, not in the labels:{' '}
            {dupNew.slice(0, 4).map(d => `${d.new_bin} (${d.old_bins.join(', ')})`).join('; ')}
          </div>
        )}
      </div>

      {source === 'map' && (
        <div className="card">
          <h2>Bin map for {siteName}</h2>
          <p className="hint">
            Pick the site above first — the map is loaded against whichever site is selected. The worksheet needs
            two columns in this order; anything past column B is ignored, and a header row is detected and skipped.
          </p>
          <div className="scroll" style={{ maxHeight: 180, marginBottom: 12 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40 }}></th>
                  <th>A</th>
                  <th>B</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ color: 'var(--muted)' }}>1</td>
                  <td>
                    <b>OLD BIN</b>
                  </td>
                  <td>
                    <b>NEW BIN</b>
                  </td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--muted)' }}>2</td>
                  <td>A-1-1-1</td>
                  <td>A0101E01</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--muted)' }}>3</td>
                  <td>A010102</td>
                  <td>A0101D01</td>
                </tr>
              </tbody>
            </table>
          </div>

          {upErr && <div className="msg show bad">{upErr}</div>}
          {loading && <div className="msg show warn">{loading}</div>}

          {!isAdmin ? (
            <p className="hint">An admin loads the bin map. You can audit against whatever is loaded.</p>
          ) : (
            <>
              <div className="row">
                <div style={{ flex: '1 1 320px' }}>
                  <label>Upload .xlsx or .csv</label>
                  <input type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" onChange={onFile} />
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                  <button className="act ghost" onClick={clearMap} disabled={!!loading}>
                    Clear map
                  </button>
                </div>
              </div>
              <label style={{ marginTop: 10 }}>…or paste two columns</label>
              <textarea
                value={paste}
                onChange={e => setPaste(e.target.value)}
                placeholder={'A-1-1-1\tA0101E01\nA-1-1-2\tA0101D01'}
                style={{ minHeight: 90 }}
              />
              <div className="btns" style={{ marginTop: 8 }}>
                <button className="act ghost" onClick={onPaste} disabled={!paste.trim() || !!loading}>
                  Read the paste
                </button>
              </div>
            </>
          )}

          {preview && (
            <>
              <div className="stats" style={{ marginTop: 14 }}>
                <Stat n={preview.rows.length.toLocaleString()} l="rows to load" />
                <Stat n={preview.skipped.length} l="unusable rows" />
                <Stat n={preview.dupOld.length} l="repeated old bins" />
                <Stat n={preview.dupNew.length} l="new codes reused" />
                <Stat n={preview.badNew.length} l="wrong-shaped codes" />
              </div>
              {preview.header && <p className="hint">Row 1 was read as a header and will be skipped.</p>}
              {preview.dupNew.length > 0 && (
                <div className="msg show warn">
                  {preview.dupNew.length} new code(s) appear against more than one old bin — the collision that put
                  zone-K labels on zone-E shelves at site 18. Check:{' '}
                  {preview.dupNew.slice(0, 4).map(d => `${d.newBin} (${d.oldBins.join(', ')})`).join('; ')}
                </div>
              )}
              {preview.badNew.length > 0 && (
                <div className="msg show warn">
                  {preview.badNew.length} code(s) are not shaped like a new bin, e.g. {preview.badNew.slice(0, 5).join(', ')}
                </div>
              )}
              {preview.skipped.length > 0 && (
                <div className="msg show warn">
                  {preview.skipped.length} row(s) cannot be used: {preview.skipped.slice(0, 3).map(s => `row ${s.row}, ${s.why}`).join('; ')}
                </div>
              )}
              <div className="scroll" style={{ maxHeight: 200, marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th>OLD BIN</th>
                      <th>NEW BIN</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 8).map((r, i) => (
                      <tr key={i}>
                        <td>{r.oldBin}</td>
                        <td>{r.newBin}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="btns" style={{ marginTop: 10 }}>
                <button className="act" onClick={load} disabled={!!loading || !preview.rows.length}>
                  {loading ? 'Loading…' : `Load ${preview.rows.length.toLocaleString()} rows into ${siteName}`}
                </button>
                <button
                  className="act ghost"
                  onClick={() => {
                    setTable(null)
                    setPreview(null)
                    setFileName('')
                  }}
                >
                  Discard {fileName ? `"${fileName}"` : 'this'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="card">
        <h2>Validate a bin</h2>
        <p className="hint">Scan the OLD label on the shelf, then the NEW one hung beside it. Enter moves along and checks.</p>
        {msg && (
          <div className={`msg show ${msg.kind}`}>
            {msg.text}
            {msg.sub && (
              <div style={{ fontWeight: 400, marginTop: 4, fontSize: 13 }}>{msg.sub}</div>
            )}
          </div>
        )}
        <div className="scanwrap">
          <div className={`scanfield ${oldBin ? 'armed' : ''}`}>
            <label>1 · Old bin</label>
            <input
              ref={oldRef}
              value={oldBin}
              onChange={e => setOldBin(e.target.value)}
              onKeyDown={e => key(e, 'old')}
              autoComplete="off"
              spellCheck={false}
              placeholder="scan…"
              autoFocus
            />
          </div>
          <div className={`scanfield ${newBin ? 'armed' : ''}`}>
            <label>2 · Label hung on it</label>
            <input
              ref={newRef}
              value={newBin}
              onChange={e => setNewBin(e.target.value)}
              onKeyDown={e => key(e, 'new')}
              autoComplete="off"
              spellCheck={false}
              placeholder="scan…"
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Toggle label="Sound" v={sound} set={setSound} />
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <button className="act ghost" onClick={undo} disabled={busy}>
              Undo last
            </button>
            <button
              className="act ghost"
              onClick={() => {
                setOldBin('')
                setNewBin('')
                oldRef.current?.focus()
              }}
            >
              Clear
            </button>
            <a className="act ghost" href={`/api/export?site=${siteId}`} style={{ textDecoration: 'none' }}>
              Export workbook (.xlsx)
            </a>
            {busy && <span className="spin" />}
          </div>
        </div>
      </div>

      <div className="stats">
        <Stat n={counts.checked.toLocaleString()} l="bins audited" />
        <Stat n={counts.match.toLocaleString()} l="match" />
        <Stat n={counts.mismatch.toLocaleString()} l="MISMATCH" />
        <Stat n={counts.unmapped.toLocaleString()} l="not in reference" />
        <Stat n={todo.toLocaleString()} l="left to check" />
        <Stat n={counts.checked > 0 && counts.mismatch + counts.unmapped === 0 ? 'CLEAN' : 'CHECK'} l="so far" />
      </div>

      {byUser.length > 1 && (
        <div className="peer">
          {byUser.map(b => (
            <span key={b.username}>
              {b.username} <b>{b.n}</b>
            </span>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Audited — everyone</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>OLD BIN</th>
                <th>LABEL HUNG</th>
                <th>SHOULD BE</th>
                <th>VERDICT</th>
                <th>BY</th>
                <th>TIME</th>
              </tr>
            </thead>
            <tbody>
              {checks.map(c => (
                <tr key={c.id} className={c.verdict === 'mismatch' ? 'dupe' : ''}>
                  <td>{c.old_bin}</td>
                  <td>{c.new_bin}</td>
                  <td>{c.expected_bin ?? '—'}</td>
                  <td>
                    <span className={`pill ${c.verdict === 'match' ? 'ok' : c.verdict === 'mismatch' ? 'bad' : 'warn'}`}>
                      {c.verdict === 'unmapped' ? 'NOT IN REFERENCE' : c.verdict.toUpperCase()}
                    </span>
                  </td>
                  <td>{c.username ?? '—'}</td>
                  <td>{new Date(c.created_at).toLocaleTimeString()}</td>
                </tr>
              ))}
              {!checks.length && (
                <tr>
                  <td colSpan={6} style={{ color: 'var(--muted)' }}>
                    Nothing audited yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */

function Stat({ n, l }: { n: string | number; l: string }) {
  return (
    <div className="stat">
      <b>{n}</b>
      <span>{l}</span>
    </div>
  )
}

function Toggle({ label, v, set }: { label: string; v: boolean; set: (b: boolean) => void }) {
  return (
    <div style={{ flex: '0 0 auto' }}>
      <label>{label}</label>
      <select value={v ? '1' : '0'} onChange={e => set(e.target.value === '1')}>
        <option value="1">Yes</option>
        <option value="0">No</option>
      </select>
    </div>
  )
}

export { NEW_PATTERN }
