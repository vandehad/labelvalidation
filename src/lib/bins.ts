/**
 * Bin parsing and label generation.
 *
 * Old bins come in two shapes at every site seen so far:
 *   A-1-1-1     dashed, any digit widths, sometimes a missing dash (P3-3-0)
 *   A010101     no dashes, fixed 2-digit aisle / column / shelf
 *
 * New bins are {Zone}{aisle:2}{column:2}{letter}{01}. The trailing 01 is the
 * bin position within the shelf; only one exists today, so it is always 01.
 */

export const NEW_PATTERN = /^[A-Z]\d{4}[A-Z]\d{2}$/

export type OldBin = { zone: string; aisle: number; col: number; shelf: number }

export function parseOld(raw: string): OldBin | null {
  const o = String(raw).trim().toUpperCase()
  let m = /^([A-Z])-?(\d+)-(\d+)-(\d+)$/.exec(o)
  if (m) return { zone: m[1], aisle: +m[2], col: +m[3], shelf: +m[4] }
  m = /^([A-Z])(\d{2})(\d{2})(\d{2})$/.exec(o)
  if (m) return { zone: m[1], aisle: +m[2], col: +m[3], shelf: +m[4] }
  return null
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function newCode(zone: string, aisle: number, col: number, letter: string) {
  return `${zone}${pad2(aisle)}${pad2(col)}${letter}01`
}

export function splitNew(code: string) {
  if (!NEW_PATTERN.test(code)) return null
  return {
    zone: code[0],
    aisle: +code.slice(1, 3),
    col: +code.slice(3, 5),
    letter: code[5],
    position: code.slice(6),
  }
}

export type Basis = 'global' | 'zone' | 'aisle' | 'actual'
export type ZMode = 'auto' | 'always' | 'never'

export type GenSpec =
  | { mode: 'derive'; oldBins: string[]; basis: Basis; zMode: ZMode }
  | {
      mode: 'manual'
      zones: string[]
      aisleFrom: number
      aisleTo: number
      colFrom: number
      colTo: number
      shelves: number
      zMode: ZMode
    }

export type GenResult = {
  labels: string[]
  columns: number
  zones: number
  tallest: number
  capped: Array<{ zone: string; aisle: number; col: number; needed: number }>
  unparsed: string[]
}

export function generateLabels(spec: GenSpec): GenResult {
  type Col = { zone: string; aisle: number; col: number; shelves: number; floor: boolean }
  const cols: Col[] = []
  const unparsed: string[] = []

  if (spec.mode === 'derive') {
    const map = new Map<string, { zone: string; aisle: number; col: number; shelves: Set<number>; floor: boolean }>()
    for (const raw of spec.oldBins) {
      const t = raw.trim()
      if (!t) continue
      const p = parseOld(t)
      if (!p) {
        unparsed.push(t)
        continue
      }
      const k = `${p.zone}|${p.aisle}|${p.col}`
      let e = map.get(k)
      if (!e) {
        e = { zone: p.zone, aisle: p.aisle, col: p.col, shelves: new Set(), floor: false }
        map.set(k, e)
      }
      if (p.shelf === 0) e.floor = true
      else e.shelves.add(p.shelf)
    }
    const all = [...map.values()]
    if (!all.length) return { labels: [], columns: 0, zones: 0, tallest: 0, capped: [], unparsed }

    const globalMax = Math.max(...all.map(e => e.shelves.size))
    const byZone = new Map<string, number>()
    const byAisle = new Map<string, number>()
    for (const e of all) {
      byZone.set(e.zone, Math.max(byZone.get(e.zone) ?? 0, e.shelves.size))
      const ka = `${e.zone}|${e.aisle}`
      byAisle.set(ka, Math.max(byAisle.get(ka) ?? 0, e.shelves.size))
    }
    for (const e of all) {
      const n =
        spec.basis === 'global'
          ? globalMax
          : spec.basis === 'zone'
            ? byZone.get(e.zone)!
            : spec.basis === 'aisle'
              ? byAisle.get(`${e.zone}|${e.aisle}`)!
              : e.shelves.size
      cols.push({ zone: e.zone, aisle: e.aisle, col: e.col, shelves: n, floor: e.floor })
    }
  } else {
    for (const z of spec.zones)
      for (let a = spec.aisleFrom; a <= spec.aisleTo; a++)
        for (let c = spec.colFrom; c <= spec.colTo; c++)
          cols.push({ zone: z, aisle: a, col: c, shelves: spec.shelves, floor: false })
  }

  const labels: string[] = []
  const capped: GenResult['capped'] = []
  for (const e of cols) {
    const wantZ = spec.zMode === 'always' || (spec.zMode === 'auto' && e.floor)
    const limit = wantZ ? 25 : 26 // keep Z free when it means floor level
    let n = Math.max(1, e.shelves)
    if (n > limit) {
      capped.push({ zone: e.zone, aisle: e.aisle, col: e.col, needed: n })
      n = limit
    }
    for (let i = 0; i < n; i++) labels.push(newCode(e.zone, e.aisle, e.col, String.fromCharCode(65 + i)))
    if (wantZ) labels.push(newCode(e.zone, e.aisle, e.col, 'Z'))
  }
  labels.sort()
  return {
    labels,
    columns: cols.length,
    zones: new Set(cols.map(c => c.zone)).size,
    tallest: cols.length ? Math.max(...cols.map(c => c.shelves)) : 0,
    capped,
    unparsed,
  }
}

/** Reasons a pair is refused. Checked client-side for speed and again on the server. */
export function validatePair(
  oldBin: string,
  newBin: string,
  opts: { enforceFormat: boolean; location: { zone: string; aisle: number; col: number | null } | null },
): string | null {
  if (!oldBin || !newBin) return 'Both fields are needed.'
  if (oldBin === newBin) return 'Old and new are identical - same label scanned twice?'
  if (opts.enforceFormat && !NEW_PATTERN.test(newBin))
    return `${newBin} is not a valid new bin (expected like A0102C01).`
  const loc = opts.location
  if (loc && NEW_PATTERN.test(newBin)) {
    const n = splitNew(newBin)!
    if (n.zone !== loc.zone) return `${newBin} is zone ${n.zone}, but you are in zone ${loc.zone}.`
    if (n.aisle !== loc.aisle) return `${newBin} is aisle ${n.aisle}, but you are in aisle ${loc.aisle}.`
    if (loc.col !== null && n.col !== loc.col)
      return `${newBin} is column ${n.col}, but you are at column ${loc.col}.`
  }
  return null
}
