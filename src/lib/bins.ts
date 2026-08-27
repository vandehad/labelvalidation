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
    return `Incorrect format on the new label: ${newBin}. Expected a code like A0101F01 - zone letter, two-digit aisle, two-digit column, shelf letter, then 01. Scan it again.`
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

/* ------------------------------------------------------------------
 * Bin map — an existing old→new mapping, used as the reference to
 * audit against rather than as something to trust. The whole point of
 * validation mode is that the map may be wrong: site 18 shipped 364
 * bad codes and six zone-E shelves labelled with zone-K codes.
 * ------------------------------------------------------------------ */

export type MapRow = { oldBin: string; newBin: string }

export type MapParse = {
  rows: MapRow[]
  /** true when row 1 was read as a header and dropped. */
  header: boolean
  skipped: Array<{ row: number; why: string }>
  /** Old bins listed more than once — the last one wins. */
  dupOld: string[]
  /** One new code claimed by several old bins. This is the E/K collision. */
  dupNew: Array<{ newBin: string; oldBins: string[] }>
  /** Kept, but the new code is not in {Zone}{aisle}{col}{letter}01 shape. */
  badNew: string[]
}

const HEADER_WORDS = /old|new|bin|label|code|from|to/i

/**
 * Column A is the old bin, column B is the new bin. Anything past B is
 * ignored, so a wider export can be handed over untouched.
 */
export function parseMapTable(table: Array<Array<string | number | null | undefined>>): MapParse {
  const cell = (v: unknown) => String(v ?? '').trim().toUpperCase()
  const rows: MapRow[] = []
  const skipped: MapParse['skipped'] = []
  const badNew: string[] = []

  let start = 0
  let header = false
  const first = table[0]
  if (first) {
    const a = cell(first[0])
    const b = cell(first[1])
    const looksLikeData = parseOld(a) !== null || NEW_PATTERN.test(b)
    if (!looksLikeData && (HEADER_WORDS.test(a) || HEADER_WORDS.test(b))) {
      header = true
      start = 1
    }
  }

  for (let i = start; i < table.length; i++) {
    const a = cell(table[i]?.[0])
    const b = cell(table[i]?.[1])
    if (!a && !b) continue // blank filler row
    const n = i + 1 // 1-based, as the spreadsheet shows it
    if (!a) {
      skipped.push({ row: n, why: `no old bin (column A) beside ${b}` })
      continue
    }
    if (!b) {
      skipped.push({ row: n, why: `no new bin (column B) beside ${a}` })
      continue
    }
    if (a === b) {
      skipped.push({ row: n, why: `${a} is mapped to itself` })
      continue
    }
    if (!NEW_PATTERN.test(b)) badNew.push(b)
    rows.push({ oldBin: a, newBin: b })
  }

  const seenOld = new Set<string>()
  const dupOld: string[] = []
  const byNew = new Map<string, string[]>()
  for (const r of rows) {
    if (seenOld.has(r.oldBin)) dupOld.push(r.oldBin)
    else seenOld.add(r.oldBin)
    const list = byNew.get(r.newBin)
    if (list) list.push(r.oldBin)
    else byNew.set(r.newBin, [r.oldBin])
  }
  const dupNew = [...byNew.entries()]
    .filter(([, olds]) => new Set(olds).size > 1)
    .map(([newBin, oldBins]) => ({ newBin, oldBins: [...new Set(oldBins)] }))

  return { rows, header, skipped, dupOld: [...new Set(dupOld)], dupNew, badNew: [...new Set(badNew)] }
}

/* ---------------- validation (audit) ---------------- */

export type Verdict = 'match' | 'mismatch' | 'unmapped'

/**
 * What the shelf says versus what the reference says it should say.
 * `unmapped` is not a pass: the old bin is not in the reference at all,
 * which is how site 18 lost 17 bins holding 1,145 units.
 */
export function verdictFor(scannedNew: string, expected: string | null | undefined): Verdict {
  const got = String(scannedNew ?? '').trim().toUpperCase()
  const want = String(expected ?? '').trim().toUpperCase()
  if (!want) return 'unmapped'
  return want === got ? 'match' : 'mismatch'
}

export function verdictText(v: Verdict, scanned: string, expected: string | null): string {
  if (v === 'match') return `MATCH — ${scanned}`
  if (v === 'mismatch') return `MISMATCH — hung ${scanned}, should be ${expected}`
  return `NOT IN THE REFERENCE — nothing says what this bin should be`
}
