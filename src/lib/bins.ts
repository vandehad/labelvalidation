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

/**
 * What a scanner hands us, reduced to the bin code.
 *
 * The labels hung at this site encode a six-character field before the code -
 * `A     A2707G05` - so a scan returns all fourteen characters. The code is
 * whatever follows the last space, which leaves an unpadded scan untouched and
 * means a rack carrying both old and new labels behaves identically. Anything
 * with an internal space would otherwise fail the format gate and be recorded
 * as unmapped, which looks exactly like a missing bin.
 */
export function normalizeScan(raw: string): string {
  const t = String(raw ?? '').trim().toUpperCase()
  const i = t.lastIndexOf(' ')
  return i === -1 ? t : t.slice(i + 1).trim()
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * The trailing two digits are the position within the shelf. Every site seen
 * so far has exactly one, so it defaults to 01 and nothing that existed before
 * positions were added has to pass it.
 */
export function newCode(zone: string, aisle: number, col: number, letter: string, position = 1) {
  return `${zone}${pad2(aisle)}${pad2(col)}${letter}${pad2(position)}`
}

/**
 * How a code is shown to a human: a separator after the zone and aisle, so
 * A0000A01 reads as A00-00A01. Display only - the barcode carries the code
 * itself, undashed, or a scan will not match anything in the database.
 *
 * The printed label spaces the separator out (`L03 - 12K01`) because that is
 * what the racks at this site already carry; the screen uses the tight form.
 */
export function displayCode(code: string, separator = '-') {
  const c = String(code ?? '').trim().toUpperCase()
  return c.length > 3 ? `${c.slice(0, 3)}${separator}${c.slice(3)}` : c
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

/**
 * "A-Z", "A-E,K", "A, B, C" - all the ways someone writes a set of zones.
 * Anything that is not a single letter is dropped rather than guessed at.
 */
export function parseZones(input: string): string[] {
  const out = new Set<string>()
  for (const part of String(input ?? '').toUpperCase().split(/[,\s]+/)) {
    if (!part) continue
    const range = /^([A-Z])-([A-Z])$/.exec(part)
    if (range) {
      const [from, to] = [range[1].charCodeAt(0), range[2].charCodeAt(0)].sort((a, b) => a - b)
      for (let c = from; c <= to; c++) out.add(String.fromCharCode(c))
    } else if (/^[A-Z]$/.test(part)) {
      out.add(part)
    }
  }
  return [...out].sort()
}

export type Basis = 'global' | 'zone' | 'aisle' | 'actual'
export type ZMode = 'auto' | 'always' | 'never'

/**
 * One stretch of aisles sharing a zone and a rack shape.
 *
 * A warehouse is rarely uniform. Aisles 1-26 might be zone A at 24 columns of
 * 10 shelves, and 27-36 zone B at 18 columns of 8, and the next site will
 * divide differently again. One block per stretch, in whatever order suits -
 * they are sorted on the way out.
 */
export type ZoneBlock = {
  zone: string
  aisleFrom: number
  aisleTo: number
  /** Columns in every aisle of this block. */
  columns: number
  /** Shelves in every column of this block. */
  shelves: number
  /** Positions within each shelf. Defaults to 1, which is every site so far. */
  positions?: number
}

export type GenSpec =
  | { mode: 'derive'; oldBins: string[]; basis: Basis; zMode: ZMode }
  | { mode: 'blocks'; blocks: ZoneBlock[]; zMode: ZMode }
  | {
      mode: 'manual'
      zones: string[]
      aisleFrom: number
      aisleTo: number
      colFrom: number
      colTo: number
      shelves: number
      /** Positions within each shelf. Defaults to 1, which is every site so far. */
      positions?: number
      zMode: ZMode
    }

export type GenResult = {
  labels: string[]
  columns: number
  zones: number
  tallest: number
  capped: Array<{ zone: string; aisle: number; col: number; needed: number }>
  unparsed: string[]
  /**
   * Anything the spec asked for that could not be honoured, in plain words -
   * a block with no zone letter, or two blocks claiming the same aisle. The
   * unique index on `labels` would swallow a collision silently; saying so is
   * the whole point.
   */
  problems: string[]
}

export function generateLabels(spec: GenSpec): GenResult {
  // Positions live on the column, not the spec: with blocks, one stretch of
  // aisles can hold several positions per shelf while the next holds one.
  type Col = { zone: string; aisle: number; col: number; shelves: number; positions: number; floor: boolean }
  const cols: Col[] = []
  const unparsed: string[] = []
  const problems: string[] = []

  // Two digits is the ceiling on both counts: a third would change the length
  // of every code in the system.
  const clampPos = (n: unknown) => Math.min(99, Math.max(1, Math.floor(Number(n) || 1)))

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
    if (!all.length) return { labels: [], columns: 0, zones: 0, tallest: 0, capped: [], unparsed, problems }

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
      cols.push({ zone: e.zone, aisle: e.aisle, col: e.col, shelves: n, positions: 1, floor: e.floor })
    }
  } else if (spec.mode === 'blocks') {
    // Which block claimed each aisle, so a second claim can be named rather
    // than silently deduplicated by the unique index on `labels`.
    const claimed = new Map<string, number>()
    spec.blocks.forEach((b, i) => {
      const zone = String(b.zone ?? '').trim().toUpperCase()
      if (!/^[A-Z]$/.test(zone)) {
        problems.push(`Block ${i + 1} has no single-letter zone, so it was skipped.`)
        return
      }
      const from = Math.min(Math.floor(b.aisleFrom), Math.floor(b.aisleTo))
      const to = Math.max(Math.floor(b.aisleFrom), Math.floor(b.aisleTo))
      const columns = Math.max(1, Math.floor(b.columns))
      const shelves = Math.max(1, Math.floor(b.shelves))
      const positions = clampPos(b.positions)
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        problems.push(`Block ${i + 1} (zone ${zone}) has no aisle range, so it was skipped.`)
        return
      }
      for (let a = from; a <= to; a++) {
        const key = `${zone}|${a}`
        const first = claimed.get(key)
        if (first !== undefined && first !== i) {
          problems.push(`Zone ${zone} aisle ${a} is claimed by block ${first + 1} and block ${i + 1}.`)
        } else {
          claimed.set(key, i)
        }
        for (let c = 1; c <= columns; c++) cols.push({ zone, aisle: a, col: c, shelves, positions, floor: false })
      }
    })
  } else {
    const positions = clampPos(spec.positions)
    for (const z of spec.zones)
      for (let a = spec.aisleFrom; a <= spec.aisleTo; a++)
        for (let c = spec.colFrom; c <= spec.colTo; c++)
          cols.push({ zone: z, aisle: a, col: c, shelves: spec.shelves, positions, floor: false })
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
    for (let i = 0; i < n; i++)
      for (let p = 1; p <= e.positions; p++)
        labels.push(newCode(e.zone, e.aisle, e.col, String.fromCharCode(65 + i), p))
    if (wantZ) for (let p = 1; p <= e.positions; p++) labels.push(newCode(e.zone, e.aisle, e.col, 'Z', p))
  }
  labels.sort()
  const unique = [...new Set(labels)]
  if (unique.length !== labels.length) {
    problems.push(`${labels.length - unique.length} label(s) were produced more than once and collapsed.`)
  }
  return {
    labels: unique,
    columns: cols.length,
    zones: new Set(cols.map(c => c.zone)).size,
    tallest: cols.length ? Math.max(...cols.map(c => c.shelves)) : 0,
    capped,
    unparsed,
    problems,
  }
}

/**
 * Which of a site's stored labels to print.
 *
 * Reprinting is not a special case of generating: a damaged label has to come
 * out identical to the one it replaces, so the codes come from what is stored
 * rather than from re-running the generator. A code that is not in the set is
 * reported instead of printed - printing a label the database has never heard
 * of is how a rack ends up with a bin nothing can find.
 */
export type Pick =
  | { mode: 'all' }
  | { mode: 'zones'; zones: string[] }
  | { mode: 'range'; from: string; to: string }
  | { mode: 'list'; codes: string[] }

export type PickResult = {
  codes: string[]
  /** Asked for but not in the stored set. */
  missing: string[]
}

export function pickCodes(all: string[], pick: Pick): PickResult {
  const have = new Set(all)

  if (pick.mode === 'zones') {
    const zones = new Set(pick.zones)
    return { codes: zones.size ? all.filter(c => zones.has(c[0])) : all, missing: [] }
  }

  if (pick.mode === 'range') {
    // Codes sort the way the racks run - zone, then aisle, then column, then
    // shelf - so a range is a plain comparison. Either end may be left blank
    // for an open bound, and a backwards range is read as intended.
    let from = normalizeScan(pick.from)
    let to = normalizeScan(pick.to)
    if (from && to && from > to) [from, to] = [to, from]
    return {
      codes: all.filter(c => (!from || c >= from) && (!to || c <= to)),
      missing: [],
    }
  }

  if (pick.mode === 'list') {
    // normalizeScan, so a label can be scanned straight into the box: the gun
    // returns the zone field too, and the code is what follows the last space.
    const wanted = pick.codes.map(normalizeScan).filter(Boolean)
    const seen = new Set<string>()
    const codes: string[] = []
    const missing: string[] = []
    for (const c of wanted) {
      if (seen.has(c)) continue
      seen.add(c)
      if (have.has(c)) codes.push(c)
      else missing.push(c)
    }
    // Print in rack order, not the order they were typed - a reprint run
    // should come off the roll in the order someone walks the aisle.
    codes.sort()
    return { codes, missing }
  }

  return { codes: all, missing: [] }
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
