'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { validatePair, NEW_PATTERN, type Basis, type ZMode } from '@/lib/bins'

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

const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`)
  return body
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
  const [tab, setTab] = useState<'scan' | 'labels' | 'rec'>('scan')
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
  const [loc, setLoc] = useState<Loc | null>(null)
  const [zone, setZone] = useState('')
  const [aisle, setAisle] = useState('')
  const [col, setCol] = useState('')
  const [oldBin, setOldBin] = useState('')
  const [newBin, setNewBin] = useState('')
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null)
  const [pairs, setPairs] = useState<Pair[]>([])
  const [totals, setTotals] = useState<{ pairs: number; labels: number }>({ pairs: 0, labels: 0 })
  const [byUser, setByUser] = useState<Array<{ username: string; n: number }>>([])
  const [enforceFmt, setEnforceFmt] = useState(true)
  const [enforceLoc, setEnforceLoc] = useState(true)
  const [sound, setSound] = useState(true)
  const [busy, setBusy] = useState(false)
  const oldRef = useRef<HTMLInputElement>(null)
  const newRef = useRef<HTMLInputElement>(null)
  const actx = useRef<AudioContext | null>(null)

  const beep = useCallback(
    (good: boolean) => {
      if (!sound) return
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
    [sound],
  )

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

  const setLocation = () => {
    const z = zone.trim().toUpperCase()
    if (!/^[A-Z]$/.test(z)) return flash('bad', 'Zone must be a single letter.')
    if (aisle === '') return flash('bad', 'Enter an aisle.')
    setLoc({ zone: z, aisle: Number(aisle), col: col === '' ? null : Number(col) })
    flash('ok', `Location set to ${z}-${aisle}${col === '' ? '' : '-' + col}`)
    oldRef.current?.focus()
  }

  const locText = loc ? `${loc.zone}-${loc.aisle}${loc.col === null ? '' : '-' + loc.col}` : ''

  const commit = async () => {
    const o = oldBin.trim().toUpperCase()
    const n = newBin.trim().toUpperCase()
    if (!o || !n) return
    // Check locally first so an obvious mistake never costs a round trip.
    const why = validatePair(o, n, { enforceFormat: enforceFmt, location: enforceLoc ? loc : null })
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
          location: locText || null,
          enforceFormat: enforceFmt,
          loc: enforceLoc ? loc : null,
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
        <h2>Location</h2>
        <p className="hint">
          Scanned new bins are checked against this, so a label from the wrong aisle is caught immediately.
        </p>
        <div className="row">
          <div>
            <label>Zone</label>
            <input value={zone} maxLength={1} onChange={e => setZone(e.target.value)} style={{ textTransform: 'uppercase' }} />
          </div>
          <div>
            <label>Aisle</label>
            <input type="number" value={aisle} onChange={e => setAisle(e.target.value)} />
          </div>
          <div>
            <label>Column (optional)</label>
            <input type="number" value={col} onChange={e => setCol(e.target.value)} placeholder="any" />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button className="act" onClick={setLocation}>
              Set location
            </button>
          </div>
        </div>
        <div>
          Now working: <span className="loc">{locText || '— not set —'}</span>
        </div>
      </div>

      <div className="card">
        <h2>Scan pair</h2>
        <p className="hint">Scan the OLD label, then the NEW one. Enter moves along and saves.</p>
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
          <Toggle label="Enforce format" v={enforceFmt} set={setEnforceFmt} />
          <Toggle label="Must match location" v={enforceLoc} set={setEnforceLoc} />
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
  const [text, setText] = useState('')
  const [basis, setBasis] = useState<Basis>('global')
  const [zMode, setZMode] = useState<ZMode>('auto')
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

  const gen = async () => {
    setBusy(true)
    setErr('')
    try {
      const oldBins = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      if (!oldBins.length) throw new Error('Paste the old bin list first.')
      const r = await api('/api/labels', {
        method: 'POST',
        body: JSON.stringify({ siteId, spec: { mode: 'derive', oldBins, basis, zMode } }),
      })
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
        <h2>Build the label superset</h2>
        <p className="hint">
          Every zone/aisle/column gets a full run of shelf letters, so a label always exists no matter how
          tall the rack turns out to be. Unused ones fall out in Reconcile.
        </p>
        {err && <div className="msg show bad">{err}</div>}
        <div className="row">
          <div>
            <label>Shelf count basis</label>
            <select value={basis} onChange={e => setBasis(e.target.value as Basis)}>
              <option value="global">Tallest column anywhere (uniform)</option>
              <option value="zone">Tallest column in each zone</option>
              <option value="aisle">Tallest column in each aisle</option>
              <option value="actual">Actual shelves in each column</option>
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
        <label>Old bin list — one per line</label>
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder={'A-1-1-1\nA-1-1-2\nA010103'} />
        <div className="btns" style={{ marginTop: 10 }}>
          <button className="act" onClick={gen} disabled={busy}>
            {busy ? 'Generating…' : 'Generate and store'}
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
    </>
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
