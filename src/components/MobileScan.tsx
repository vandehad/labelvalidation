'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { displayCode, newCode, normalizeScan, reversedScan, type Verdict } from '@/lib/bins'
import { startCamera, cameraAvailable, type StopCamera } from '@/lib/camera'

/**
 * Validation on a handheld - built for a Zebra TC52 in a warehouse aisle.
 *
 * The differences from the desktop tab are not cosmetic:
 *
 *   - DataWedge delivers a scan as keystrokes into the focused field, with an
 *     Enter suffix. `inputMode="none"` keeps the fields accepting those while
 *     stopping Android from throwing up the on-screen keyboard, which would
 *     otherwise cover half of a five-inch screen on every scan.
 *   - The verdict has to be readable at arm's length with the device in one
 *     hand, so it is the largest thing on the page rather than a line of text.
 *   - A mismatch vibrates. A warehouse is loud enough that a beep alone gets
 *     missed, and a missed mismatch is a wrong label left hanging.
 *   - Focus returns to the old-bin field after every scan, so the gun always
 *     lands somewhere useful without anyone tapping the screen with gloves on.
 *   - A shelf with no old label can be added from the aisle. The picker is
 *     native selects - a spinner under a thumb - and the code is built from
 *     the picks, so it cannot come out malformed. See `MobileAdd`.
 */

type User = { name: string; role: string }
type Site = { id: number; name: string }
type Source = 'map' | 'pairs'

const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`)
  return body
}

export default function MobileScan({ initialUser }: { initialUser: User | null }) {
  const [user, setUser] = useState<User | null>(initialUser)
  if (!user) return <MobileLogin onIn={setUser} />
  return <Scanner user={user} onOut={() => setUser(null)} />
}

/* ------------------------------------------------------------------ */

function MobileLogin({ onIn }: { onIn: (u: User) => void }) {
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
    <div className="m-wrap">
      <div className="m-bar">
        <b>VALIDATE</b>
      </div>
      <form className="m-pad" onSubmit={go}>
        {err && <div className="m-verdict bad">{err}</div>}
        <label className="m-label">Username</label>
        <input className="m-in" value={u} onChange={e => setU(e.target.value)} autoComplete="username" autoFocus />
        <label className="m-label">Password</label>
        <input className="m-in" type="password" value={p} onChange={e => setP(e.target.value)} autoComplete="current-password" />
        <button className="m-btn wide" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Adding a bin from the aisle - a shelf that never had an old label.
 *
 * Same rules as the desktop card and the Windows Mobile page, because all
 * three go through `src/lib/mint.ts`: the code is assembled from picks the
 * site's own label set offers, never typed, and the placeholder old bin comes
 * from a sequence so the row survives reconcile. The picks are native selects,
 * which Android renders as a spinner a gloved thumb can drive.
 *
 * It records the bin; it does not print it. The relay listens only on the
 * desktop's own loopback, and a browser will not let an https page call an
 * http address on the LAN in any case. The label comes off the desktop:
 * Labels, "Added on the floor".
 */
function MobileAdd({
  siteId,
  onAdded,
  onClose,
}: {
  siteId: number
  onAdded: (code: string, oldBin: string) => void
  onClose: () => void
}) {
  const [zones, setZones] = useState<string[] | null>(null)
  const [aisles, setAisles] = useState<number[]>([])
  const [columns, setColumns] = useState<number[]>([])
  const [taken, setTaken] = useState<string[]>([])

  const [zone, setZone] = useState('')
  const [aisle, setAisle] = useState<number | ''>('')
  const [col, setCol] = useState<number | ''>('')
  const [letter, setLetter] = useState('')
  const [position, setPosition] = useState(1)

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const step = useCallback(
    async (q: string) => {
      try {
        return await api(`/api/mint?site=${siteId}${q}`)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        return null
      }
    },
    [siteId],
  )

  useEffect(() => {
    void (async () => {
      const d = await step('')
      if (d) setZones(d.zones)
    })()
  }, [step])

  const pickZone = async (z: string) => {
    setZone(z)
    setAisle('')
    setCol('')
    setLetter('')
    setAisles([])
    setColumns([])
    setTaken([])
    if (!z) return
    const d = await step(`&zone=${z}`)
    if (d) setAisles(d.aisles)
  }
  const pickAisle = async (a: number | '') => {
    setAisle(a)
    setCol('')
    setLetter('')
    setColumns([])
    setTaken([])
    if (a === '') return
    const d = await step(`&zone=${zone}&aisle=${a}`)
    if (d) setColumns(d.columns)
  }
  const pickCol = async (c: number | '') => {
    setCol(c)
    setLetter('')
    setTaken([])
    if (c === '') return
    const d = await step(`&zone=${zone}&aisle=${aisle}&col=${c}`)
    if (d) setTaken(d.taken)
  }

  const code =
    zone && aisle !== '' && col !== '' && letter ? newCode(zone, Number(aisle), Number(col), letter, position) : ''
  const clash = !!code && taken.includes(code)

  const addBin = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await api('/api/mint', {
        method: 'POST',
        body: JSON.stringify({ siteId, zone, aisle, col, letter, position }),
      })
      setTaken(t => [...t, r.code])
      setLetter('') // the next shelf on this column is the likely next add
      onAdded(r.code, r.oldBin)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))
  const num = (v: string): number | '' => (v === '' ? '' : Number(v))

  return (
    <div className="m-pad m-add">
      {err && (
        <div className="m-verdict error" style={{ minHeight: 0 }}>
          <span className="m-sub">{err}</span>
        </div>
      )}
      {zones && !zones.length && !err && (
        <div className="m-verdict unmapped" style={{ minHeight: 0 }}>
          <span className="m-sub">This site has no labels yet, so there is nowhere to add a bin. Generate the label set on the desktop first.</span>
        </div>
      )}

      <label className="m-label">Zone</label>
      <select className="m-in" value={zone} onChange={e => pickZone(e.target.value)} disabled={!zones?.length}>
        <option value="">{zones ? '—' : 'loading…'}</option>
        {(zones ?? []).map(z => (
          <option key={z} value={z}>
            {z}
          </option>
        ))}
      </select>

      <label className="m-label">Aisle</label>
      <select className="m-in" value={aisle} onChange={e => pickAisle(num(e.target.value))} disabled={!zone}>
        <option value="">—</option>
        {aisles.map(a => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>

      <label className="m-label">Column</label>
      <select className="m-in" value={col} onChange={e => pickCol(num(e.target.value))} disabled={aisle === ''}>
        <option value="">—</option>
        {columns.map(c => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <div className="m-row">
        <div style={{ flex: 2 }}>
          <label className="m-label">Shelf</label>
          <select className="m-in" value={letter} onChange={e => setLetter(e.target.value)} disabled={col === ''}>
            <option value="">—</option>
            {LETTERS.map(L => {
              const used = taken.includes(newCode(zone || 'A', Number(aisle) || 0, Number(col) || 0, L, position))
              return (
                <option key={L} value={L} disabled={used}>
                  {L}
                  {used ? ' — taken' : ''}
                </option>
              )
            })}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label className="m-label">Position</label>
          <select className="m-in" value={position} onChange={e => setPosition(Number(e.target.value))} disabled={col === ''}>
            {Array.from({ length: 99 }, (_, i) => i + 1).map(p => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={`m-code ${clash ? 'clash' : ''}`}>{code ? displayCode(code) : '— pick a shelf —'}</div>
      {clash && <div className="m-sub">Already in the label set. Print and hang that one instead.</div>}

      <div className="m-row">
        <button className="m-btn" onClick={addBin} disabled={busy || !code || clash}>
          {busy ? 'Adding…' : 'Add this bin'}
        </button>
        <button className="m-btn ghost" onClick={onClose}>
          Back to scanning
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function Scanner({ user, onOut }: { user: User; onOut: () => void }) {
  const [sites, setSites] = useState<Site[]>([])
  const [siteId, setSiteId] = useState<number | null>(null)
  const [source, setSource] = useState<Source>('map')
  const [setup, setSetup] = useState(false)

  const [oldBin, setOldBin] = useState('')
  const [newBin, setNewBin] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastId, setLastId] = useState<number | null>(null)
  const [result, setResult] = useState<{ verdict: Verdict | 'error'; text: string; sub?: string } | null>(null)
  const [counts, setCounts] = useState({ match: 0, mismatch: 0, unmapped: 0, checked: 0, reference: 0 })
  const [add, setAdd] = useState(false) // the add-a-bin picker is showing instead of the scan fields

  const oldRef = useRef<HTMLInputElement>(null)
  const newRef = useRef<HTMLInputElement>(null)
  const actx = useRef<AudioContext | null>(null)

  // Camera mode, for a phone with no scan gun. The camera is a third way to
  // get characters into the same two fields; nothing downstream can tell.
  const [cam, setCam] = useState(false)
  const [camStep, setCamStep] = useState<'old' | 'new'>('old')
  const [camMsg, setCamMsg] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const stopCam = useRef<StopCamera | null>(null)
  const camOld = useRef('') // the old label the camera has read, awaiting the new one
  const onCodeRef = useRef<(c: string) => void>(() => {})

  // Remember the site and reference between shifts - a handheld gets locked
  // and picked up again all day, and re-choosing both every time is friction
  // nobody needs while holding a scan gun.
  useEffect(() => {
    try {
      const s = Number(localStorage.getItem('lv.site'))
      if (s) setSiteId(s)
      const src = localStorage.getItem('lv.source')
      if (src === 'map' || src === 'pairs') setSource(src)
    } catch {
      /* private mode, or storage disabled */
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const { sites } = await api('/api/sites')
        setSites(sites)
        setSiteId(cur => cur ?? sites[0]?.id ?? null)
        if (!sites.length) setSetup(true)
      } catch {
        /* the refresh below will surface it */
      }
    })()
  }, [])

  const refresh = useCallback(async () => {
    if (!siteId) return
    try {
      const d = await api(`/api/checks?site=${siteId}&source=${source}&limit=1`)
      setCounts(d.counts)
    } catch {
      /* transient */
    }
  }, [siteId, source])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (siteId) try { localStorage.setItem('lv.site', String(siteId)) } catch {}
  }, [siteId])
  useEffect(() => {
    try { localStorage.setItem('lv.source', source) } catch {}
  }, [source])

  const feedback = (good: boolean) => {
    try {
      actx.current ??= new AudioContext()
      const a = actx.current
      const o = a.createOscillator()
      const g = a.createGain()
      o.connect(g)
      g.connect(a.destination)
      o.frequency.value = good ? 1180 : 220
      o.type = good ? 'sine' : 'square'
      g.gain.setValueAtTime(0.2, a.currentTime)
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + (good ? 0.11 : 0.42))
      o.start()
      o.stop(a.currentTime + (good ? 0.12 : 0.45))
    } catch {
      /* no audio device */
    }
    // An aisle is loud. A mismatch that is only audible gets missed, and a
    // missed mismatch is a wrong label left on the rack.
    try {
      navigator.vibrate?.(good ? 40 : [90, 60, 90, 60, 200])
    } catch {
      /* not supported */
    }
  }

  const commit = async (rawOld: string = oldBin, rawNew: string = newBin) => {
    const o = normalizeScan(rawOld)
    const n = normalizeScan(rawNew)
    if (!o || !n) return
    if (o === n) {
      setResult({ verdict: 'error', text: 'SAME LABEL TWICE', sub: 'Both fields read the same code.' })
      feedback(false)
      setNewBin('')
      newRef.current?.focus()
      return
    }
    // Backwards: a new-style code in the old field. The fault is in the old
    // field, so the cursor goes back there - the next trigger pull should be
    // the shelf's existing label, not another attempt at the new one.
    const backwards = reversedScan(o, n)
    if (backwards) {
      setResult({ verdict: 'error', text: 'WRONG WAY ROUND', sub: backwards })
      feedback(false)
      setOldBin('')
      setNewBin('')
      oldRef.current?.focus()
      return
    }
    setBusy(true)
    try {
      const r = await api('/api/checks', { method: 'POST', body: JSON.stringify({ siteId, source, oldBin: o, newBin: n }) })
      const v = r.verdict as Verdict
      setLastId(r.check?.id ?? null)
      const also = r.belongsTo ? `${n} belongs to ${r.belongsTo}.` : undefined
      if (v === 'match') setResult({ verdict: v, text: 'MATCH', sub: `${o}  →  ${n}` })
      else if (v === 'mismatch') setResult({ verdict: v, text: 'MISMATCH', sub: `${o} should be ${r.expected}, not ${n}. ${also ?? ''}`.trim() })
      else setResult({ verdict: v, text: 'NOT IN REFERENCE', sub: `${o} is not in the reference. ${also ?? ''}`.trim() })
      feedback(v === 'match')
      await refresh()
    } catch (e) {
      setResult({ verdict: 'error', text: 'FAILED', sub: e instanceof Error ? e.message : String(e) })
      feedback(false)
    } finally {
      setBusy(false)
      setOldBin('')
      setNewBin('')
      camOld.current = ''
      setCamStep('old')
      oldRef.current?.focus()
    }
  }

  // What a decoded barcode does: the first read is the old bin, the second is
  // the label hung on it and commits the pair. Held in a ref so the camera
  // loop always calls the current version without being restarted.
  onCodeRef.current = (text: string) => {
    if (!camOld.current) {
      camOld.current = text
      setOldBin(text)
      setNewBin('')
      setCamStep('new')
      feedback(true)
      return
    }
    const o = camOld.current
    setNewBin(text)
    void commit(o, text)
  }

  useEffect(() => {
    if (!cam) return
    const v = videoRef.current
    if (!v) return
    let cancelled = false
    setCamMsg('')
    startCamera(v, c => onCodeRef.current(c))
      .then(stop => {
        if (cancelled) stop()
        else stopCam.current = stop
      })
      .catch(e => {
        setCamMsg(
          e instanceof Error && /denied|permission/i.test(e.message)
            ? 'Camera permission was refused. Allow it in the browser and try again.'
            : `Could not open the camera. ${e instanceof Error ? e.message : String(e)}`,
        )
        setCam(false)
      })
    return () => {
      cancelled = true
      stopCam.current?.()
      stopCam.current = null
    }
  }, [cam])

  const undo = async () => {
    if (!lastId) return
    try {
      await api(`/api/checks/${lastId}`, { method: 'DELETE' })
      setLastId(null)
      setResult({ verdict: 'error', text: 'UNDONE', sub: 'That check was removed.' })
      await refresh()
    } catch (e) {
      setResult({ verdict: 'error', text: 'COULD NOT UNDO', sub: e instanceof Error ? e.message : String(e) })
    }
    oldRef.current?.focus()
  }

  const key = (e: React.KeyboardEvent<HTMLInputElement>, from: 'old' | 'new') => {
    if (e.key !== 'Enter' && e.key !== 'Tab') return
    e.preventDefault()
    if (from === 'old') {
      if (oldBin.trim()) newRef.current?.focus()
    } else if (newBin.trim()) void commit()
    else oldRef.current?.focus()
  }

  const site = sites.find(s => s.id === siteId)
  const todo = Math.max(0, counts.reference - counts.checked)

  return (
    <div className="m-wrap">
      <div className="m-bar">
        <b>{add ? 'ADD A BIN' : 'VALIDATE'}</b>
        <span className="m-site">{site?.name ?? 'no site'}</span>
        <button className="m-gear" onClick={() => setSetup(v => !v)} aria-label="Settings">
          ⚙
        </button>
      </div>

      {setup && (
        <div className="m-pad m-setup">
          <label className="m-label">Site</label>
          <select className="m-in" value={siteId ?? ''} onChange={e => setSiteId(Number(e.target.value))}>
            {sites.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            {!sites.length && <option value="">— no sites —</option>}
          </select>
          <label className="m-label">Check against</label>
          <select className="m-in" value={source} onChange={e => setSource(e.target.value as Source)}>
            <option value="map">The uploaded bin map</option>
            <option value="pairs">Bins scanned in on this site</option>
          </select>
          <div className="m-row">
            <button className="m-btn ghost" onClick={() => setSetup(false)}>
              Done
            </button>
            <button
              className="m-btn ghost"
              onClick={async () => {
                await api('/api/auth/logout', { method: 'POST' })
                onOut()
              }}
            >
              Sign out {user.name}
            </button>
          </div>
        </div>
      )}

      <div className={`m-verdict ${result?.verdict ?? 'idle'}`}>
        <span className="m-big">{result?.text ?? 'READY'}</span>
        <span className="m-sub">{result?.sub ?? 'Scan the old label, then the one hung on it.'}</span>
      </div>

      {cam && !add && (
        <div className="m-cam">
          <video ref={videoRef} autoPlay muted playsInline />
          <div className="m-cam-guide" />
          <div className="m-cam-hint">{camStep === 'old' ? 'Point at the OLD label' : 'Now the label hung on it'}</div>
        </div>
      )}
      {camMsg && <div className="m-verdict error" style={{ minHeight: 0 }}><span className="m-sub">{camMsg}</span></div>}

      {add && siteId ? (
        <MobileAdd
          siteId={siteId}
          onAdded={(code, oldBin) => {
            setResult({
              verdict: 'match',
              text: 'ADDED',
              sub: `${displayCode(code)} is recorded as ${oldBin}. Print it from the desktop - Labels, "Added on the floor" - then hang it.`,
            })
            feedback(true)
            void refresh()
          }}
          onClose={() => {
            setAdd(false)
            setTimeout(() => oldRef.current?.focus(), 0)
          }}
        />
      ) : (
      <div className="m-pad">
        <label className="m-label">1 · Old bin</label>
        <input
          ref={oldRef}
          className={`m-in scan ${oldBin ? 'armed' : ''}`}
          value={oldBin}
          onChange={e => setOldBin(e.target.value)}
          onKeyDown={e => key(e, 'old')}
          // inputMode none: DataWedge types the scan in as keystrokes, but
          // Android must not raise the on-screen keyboard over the screen.
          inputMode="none"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="scan…"
          autoFocus
        />
        <label className="m-label">2 · Label hung on it</label>
        <input
          ref={newRef}
          className={`m-in scan ${newBin ? 'armed' : ''}`}
          value={newBin}
          onChange={e => setNewBin(e.target.value)}
          onKeyDown={e => key(e, 'new')}
          inputMode="none"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="scan…"
        />

        <div className="m-row">
          <button className="m-btn ghost" onClick={undo} disabled={busy || !lastId}>
            Undo last
          </button>
          <button
            className="m-btn ghost"
            onClick={() => {
              setOldBin('')
              setNewBin('')
              setResult(null)
              camOld.current = ''
              setCamStep('old')
              oldRef.current?.focus()
            }}
          >
            Clear
          </button>
        </div>
        <div className="m-row">
          {cameraAvailable() && (
            <button className={`m-btn ${cam ? '' : 'ghost'}`} onClick={() => setCam(v => !v)}>
              {cam ? 'Stop camera' : 'Camera'}
            </button>
          )}
          <button
            className="m-btn ghost"
            disabled={!siteId}
            onClick={() => {
              setCam(false)
              setAdd(true)
            }}
          >
            Add a bin
          </button>
        </div>
      </div>
      )}

      <div className="m-tally">
        <div>
          <b>{counts.checked.toLocaleString()}</b>
          <span>checked</span>
        </div>
        <div className={counts.mismatch ? 'bad' : ''}>
          <b>{counts.mismatch.toLocaleString()}</b>
          <span>mismatch</span>
        </div>
        <div className={counts.unmapped ? 'warn' : ''}>
          <b>{counts.unmapped.toLocaleString()}</b>
          <span>not in ref</span>
        </div>
        <div>
          <b>{todo.toLocaleString()}</b>
          <span>to go</span>
        </div>
      </div>
    </div>
  )
}
