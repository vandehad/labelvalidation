/**
 * Reads a spreadsheet in the browser, so an uploaded file never has to be
 * shipped to the server before it can be checked.
 *
 * Lifted from the standalone build's reader: parses the zip central
 * directory by hand and inflates with the browser's native
 * DecompressionStream. No dependency, and it keeps `next build` free of a
 * server-side unzip.
 *
 * Client only - DecompressionStream is not used on the server here.
 */

const dec = new TextDecoder()

/* ---------------- zip ---------------- */

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

type Entry = { method: number; raw: Uint8Array }

function unzip(bytes: Uint8Array): Record<string, Entry> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 70000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('That file is not a readable .xlsx (no zip end record).')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out: Record<string, Entry> = {}
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break
    const method = dv.getUint16(p + 10, true)
    const compSize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const cmtLen = dv.getUint16(p + 32, true)
    const lho = dv.getUint32(p + 42, true)
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    const lNameLen = dv.getUint16(lho + 26, true)
    const lExtraLen = dv.getUint16(lho + 28, true)
    const dataStart = lho + 30 + lNameLen + lExtraLen
    out[name] = { method, raw: bytes.subarray(dataStart, dataStart + compSize) }
    p += 46 + nameLen + extraLen + cmtLen
  }
  return out
}

/* ---------------- xlsx ---------------- */

function colIndex(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

function unesc(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&')
}

export async function readXlsxRows(bytes: Uint8Array): Promise<string[][]> {
  const entries = unzip(bytes)
  const get = async (n: string) => {
    const e = entries[n]
    if (!e) return null
    return dec.decode(e.method === 8 ? await inflateRaw(e.raw) : e.raw)
  }

  const ssXml = await get('xl/sharedStrings.xml')
  const shared: string[] = []
  if (ssXml) {
    const re = /<si>([\s\S]*?)<\/si>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(ssXml))) {
      const txt = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')
      shared.push(unesc(txt))
    }
  }

  let sheetName = 'xl/worksheets/sheet1.xml'
  if (!entries[sheetName]) {
    const found = Object.keys(entries).find(k => /^xl\/worksheets\/.*\.xml$/.test(k))
    if (!found) throw new Error('That workbook has no worksheet in it.')
    sheetName = found
  }
  const xml = await get(sheetName)
  if (!xml) throw new Error('That workbook has no worksheet in it.')

  const rows: string[][] = []
  const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(xml))) {
    const cells: string[] = []
    const cRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g
    let cm: RegExpExecArray | null
    while ((cm = cRe.exec(rm[2]))) {
      const attr = cm[1] || cm[3] || ''
      const body = cm[2] || ''
      const refM = /r="([A-Z]+)\d+"/.exec(attr)
      const ci = refM ? colIndex(refM[1]) : cells.length + 1
      const t = /t="(\w+)"/.exec(attr)
      let val = ''
      if (t && t[1] === 'inlineStr') {
        val = unesc([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''))
      } else {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body)
        if (vM) val = t && t[1] === 's' ? (shared[+vM[1]] ?? '') : unesc(vM[1])
      }
      while (cells.length < ci - 1) cells.push('')
      cells[ci - 1] = val
    }
    rows.push(cells)
  }
  return rows
}

/* ---------------- delimited text ---------------- */

/** CSV with quotes, or tab-separated - whichever the first line looks like. */
export function parseDelimited(text: string): string[][] {
  const head = text.slice(0, 4000)
  const delim = head.includes('\t') && (head.split('\t').length > head.split(',').length) ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cellText = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cellText += '"'
          i++
        } else q = false
      } else cellText += c
    } else if (c === '"') q = true
    else if (c === delim) {
      row.push(cellText)
      cellText = ''
    } else if (c === '\n') {
      row.push(cellText)
      rows.push(row)
      row = []
      cellText = ''
    } else if (c !== '\r') cellText += c
  }
  if (cellText || row.length) {
    row.push(cellText)
    rows.push(row)
  }
  return rows.filter(r => r.some(x => String(x).trim() !== ''))
}

/** One entry point for whatever the user drops in. */
export async function readTable(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    return readXlsxRows(new Uint8Array(await file.arrayBuffer()))
  }
  if (name.endsWith('.xls')) {
    throw new Error('Old .xls is not readable here - open it in Excel and Save As .xlsx or .csv.')
  }
  return parseDelimited(await file.text())
}
