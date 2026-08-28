/**
 * ZPL II for Zebra bin labels.
 *
 * One label carries the bin code twice: as a Code 128 barcode holding the code
 * exactly as it is stored, and as a human-readable line with a dash inserted
 * after the third character. The dash is display only. A scanner reading
 * `A00-00A01` would match nothing in `pairs`, `labels` or `bin_map`, because
 * every bin code in this app is undashed.
 *
 * No dependency, no vendor SDK - ZPL is a text protocol, and a Zebra printer
 * takes it raw over port 9100 or through a Windows print queue.
 */

// Explicit .ts extension: `scripts/*.ts` run this file under bare node, which
// does not resolve extensionless relative imports. Next handles either.
import { displayCode } from './bins.ts'

export type LabelSpec = {
  /** Printer resolution. 203 covers ZD420/ZD620/ZT230; 300 covers the -300 models. */
  dpi: 203 | 300
  /** Label stock, in inches. */
  widthIn: number
  heightIn: number
  /** Burn temperature, 0-30. Higher is darker; too high bleeds the bars. */
  darkness: number
  /** Inches per second. Slower prints crisper barcodes. */
  speed: number
  /** How many of each label. */
  copies: number
}

export const DEFAULT_LABEL: LabelSpec = {
  dpi: 203,
  widthIn: 4,
  heightIn: 1,
  darkness: 10,
  speed: 4,
  copies: 1,
}

/**
 * Code 128 can encode the code in subset B throughout, but a run of digits is
 * half the width in subset C. Letting the printer choose (`^BCN` with no mode
 * character) makes it pick per run, which is what keeps an 8-character code
 * inside 4 inches at 203 dpi with room to spare.
 */
export function zplLabel(code: string, spec: LabelSpec = DEFAULT_LABEL): string {
  const c = String(code ?? '').trim().toUpperCase()
  const shown = displayCode(c)

  const w = Math.round(spec.widthIn * spec.dpi)
  const h = Math.round(spec.heightIn * spec.dpi)

  // Leave a margin all round; thermal heads drift a little and a barcode that
  // touches the edge is a barcode that sometimes will not scan.
  const margin = Math.round(spec.dpi * 0.1)
  const textH = Math.round(spec.dpi * 0.28)
  const barH = h - textH - margin * 2 - Math.round(spec.dpi * 0.05)

  // Narrow bar width. 2 dots at 203 dpi is ~0.0098in, comfortably above the
  // 0.0075in that most scanners give up below.
  const moduleW = spec.dpi >= 300 ? 3 : 2

  return [
    '^XA',
    `^PW${w}`, // print width
    `^LL${h}`, // label length
    '^LH0,0',
    `^MD${clamp(spec.darkness, 0, 30)}`,
    `^PR${clamp(spec.speed, 1, 14)}`,
    '^CI28', // UTF-8, so a stray character cannot corrupt the stream
    `^BY${moduleW},3,${barH}`,
    `^FO${margin},${margin}^BCN,${barH},N,N,N^FD${esc(c)}^FS`,
    // Human-readable line, centred across the full width.
    `^FO0,${margin + barH + Math.round(spec.dpi * 0.05)}^FB${w},1,0,C,0^A0N,${textH},${textH}^FD${esc(shown)}^FS`,
    `^PQ${Math.max(1, Math.floor(spec.copies))}`,
    '^XZ',
  ].join('\n')
}

/** A whole run, ready to send. */
export function zplBatch(codes: string[], spec: LabelSpec = DEFAULT_LABEL): string {
  return codes.map(c => zplLabel(c, spec)).join('\n') + '\n'
}

/**
 * ^FD ends at the next ^ or ~, so those two characters cannot appear raw in
 * data. Bin codes are A-Z and 0-9 and never contain them, but this is the
 * boundary where a bad code would corrupt every label after it, not just its
 * own - so it is checked rather than assumed.
 */
function esc(s: string): string {
  return s.replace(/[\^~]/g, '')
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

/** Rough guess at the bytes a run will be, for warning before a huge job. */
export function estimateBytes(count: number, spec: LabelSpec = DEFAULT_LABEL): number {
  return count * zplLabel('A0000A01', spec).length
}
