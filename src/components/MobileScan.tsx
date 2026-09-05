'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizeScan, reversedScan, type Verdict } from '@/lib/bins'

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

  const oldRef = useRef<HTMLInputElement>(null)
  const newRef = useRef<HTMLInputElement>(null)
  const actx = useRef<AudioContext | null>(null)

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

  const commit = async () => {
    const o = normalizeScan(oldBin)
    const n = normalizeScan(newBin)
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
      oldRef.current?.focus()
    }
  }

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
        <b>VALIDATE</b>
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
              oldRef.current?.focus()
            }}
          >
            Clear
          </button>
        </div>
      </div>

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
