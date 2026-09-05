/**
 * ZPL II for Zebra bin labels.
 *
 * One label carries the bin code twice, and neither copy is what you would
 * guess from looking at it:
 *
 *   barcode  `M     M0501B01`  a six-character zone field, then the code
 *   line     `M05-01B01`       a dash after the third character, display only
 *
 * Both shapes come off the labels the site already hangs. A scanner returns
 * the whole barcode field, so `normalizeScan` in bins.ts takes what follows
 * the last space; and the dashed form is never encoded, because a scan of
 * `M05-01B01` matches nothing in `pairs`, `labels` or `bin_map`.
 *
 * Code 39, not Code 128 - see `Symbology`.
 *
 * No dependency, no vendor SDK - ZPL is a text protocol, and a Zebra printer
 * takes it raw over port 9100 or through a Windows print queue.
 */

// Explicit .ts extension: `scripts/*.ts` run this file under bare node, which
// does not resolve extensionless relative imports. Next handles either.
import { displayCode } from './bins.ts'

/**
 * Code 39 is what warehouse location labels are usually printed in, and it is
 * what the racks already hung at this site carry - 5 bars per character with
 * an even rhythm, against Code 128's tighter, blockier pattern. It only
 * encodes A-Z, 0-9 and a few symbols, which is exactly what a bin code is, and
 * it is self-checking so it needs no check digit.
 *
 * Code 128 is kept because it is roughly a third narrower for the same data,
 * which matters if a code ever gets longer.
 */
export type Symbology = 'code39' | 'code128'

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
  /**
   * Narrow-bar width in dots. Omit to size the barcode to fill the label,
   * which is what the racks already carry - a bin label is read from a couple
   * of feet up a rack, and a wide module is the difference between a scan and
   * a second attempt.
   */
  moduleW?: number
  /** What goes between zone-aisle and the rest on the printed line. */
  separator: string
  symbology: Symbology
  /** Code 39 wide-bar to narrow-bar ratio. 2 to 3; ignored by Code 128. */
  ratio: number
  /**
   * Glyph width as a fraction of glyph height. Font 0 is Bold *Condensed*, so
   * left to itself it prints narrow; pushing this up is what makes the line
   * read from down an aisle. Shrinks automatically rather than overrunning
   * the label when a code is long.
   */
  textWidthRatio: number
  /** Space between the line and the bars, as a fraction of label height. */
  gapRatio: number
  /**
   * Share of the usable height given to the line rather than the bars.
   *
   * Font 0 renders a cap of roughly 0.62 of the height it is asked for - the
   * rest is leading inside the character cell - so the line needs a bigger
   * share than it looks like it should to end up level with the bars.
   */
  textShare?: number
  /** Edge margin as a fraction of label height. The stock has little to spare. */
  marginRatio: number
  /**
   * Shifts every field left or right, in dots, for media that does not sit
   * where the head expects it. Applied to the field origins rather than ^LH,
   * which will not take a negative - and the correction is usually leftward,
   * because the overrun shows up on the right.
   *
   * 203 dots to the inch: 1/16in is 13, 1/8in is 25.
   */
  offsetX?: number
  /**
   * 'sample' emits the site's existing format verbatim, inheriting the
   * printer's stock. 'scaled' lays the same design out against ^PW/^LL, for
   * stock the existing format was not drawn for.
   */
  template: 'sample' | 'scaled'
}

export const DEFAULT_LABEL: LabelSpec = {
  dpi: 203,
  widthIn: 4,
  // 220 dots, not 203. The GX420d on the floor reports LABEL LENGTH 0220 for
  // this stock, and forcing ^LL203 laid the content into the top 203 dots and
  // left a dead strip along the bottom.
  heightIn: 220 / 203,
  darkness: 0,
  speed: 4,
  copies: 1,
  separator: '-',
  symbology: 'code39',
  ratio: 3,
  textWidthRatio: 98 / 84,
  gapRatio: 0.01,
  marginRatio: 0.047,
  template: 'sample',
}

/**
 * The format the site already prints with, reproduced command for command.
 *
 * Everything before the first label is setup the printer keeps: ^JMA sets full
 * resolution, ^MNY web/gap media tracking, ^MMT tear-off, ^MD+00 leaves the
 * printer's own darkness alone (the GX420d on the floor holds 26.0), ^PRC is
 * 4ips, the two ^IDR lines clear stored graphics, and ^ISLB saves the empty
 * format that every label then loads with ^ILLB.
 *
 * The preamble carries no ^PW or ^LL. Each label body does carry ^PW - see
 * `printWidth` - because the ZQ630 resets its width at every power-on and
 * nothing makes it keep one, so the label has to say. No ^LL still: the gap
 * sensor measures length better than we can declare it.
 *
 * The barcode field carries a six-character zone field before the code, as the
 * site's own labels do - see `barcodeData`.
 */
const SAMPLE_PREAMBLE = [
  // ~CC resets the format prefix to ^. The site's own file opens with `~CC¬`,
  // which switches the printer to `¬` and *stays* switched - so after their
  // label program has run, a plain ^XA from here is ignored outright. ~ is the
  // control prefix and is unaffected either way, so this always lands.
  '~CC^',
  // ^JUR recalls the printer's saved configuration, which is what puts PRINT
  // WIDTH back. ^PW and ^LL persist on the printer, and this format sends
  // neither - it inherits the stock. So one 3x1 run leaves the width at 609
  // and every site-format label after it prints clipped, with nothing on
  // screen to say why. The site's own file has no ^JUR because their program
  // never changes the width; ours does.
  '^XA^JUR^XZ',
  '^XA^JMA^FS^XZ',
  '^XA^MNY^FS^XZ',
  '^XA^MMT^FS^XZ',
  '^XA^MD+00^FS^XZ',
  '^XA^PRC^FS^XZ',
  '^XA^IDR:*.GRF^XZ',
  '^XA^IDR:*.*^XZ',
  '^XA^MCY^XZ',
  '^XA^LH0000,0000^FS^PON^FS',
  '^ISLB,N^FS^XZ',
].join('\n')

/**
 * What actually goes in the barcode: a six-character left-justified zone
 * field, then the bin code. `M0501B01` is encoded as `M     M0501B01`.
 *
 * It is derived, never configured. The zone is already the first character of
 * every code, so asking for it is asking someone to retype something the code
 * has told us - and getting it wrong puts the wrong first character in every
 * barcode of a zone, which nothing on screen would show.
 *
 * The printed line carries no such field; it is the dashed code and nothing
 * else. A scanner returns all fourteen characters, which is why `normalizeScan`
 * in bins.ts takes what follows the last space.
 */
export function barcodeData(code: string): string {
  const c = String(code ?? '').trim().toUpperCase()
  return c ? c[0].padEnd(6, ' ') + c : ''
}

const pad4 = (n: number) => String(Math.max(1, Math.floor(n))).padStart(4, '0')

/**
 * ^PW for the stock, sent with every label whichever template is in use.
 *
 * The ZQ630 resets its print width at every power-on; `^JUS`, SGD setvar and
 * the config tool were all tried and none of them stuck. A ^PW ahead of the
 * job does not survive either, because the preamble's ^JUR restores the saved
 * configuration. Inside each label is the one place it holds - and it is
 * universal, so the ZT411 and GX420d get told the same way.
 *
 * 4in stock is the full 832-dot head; 3in is 609. The Print card's stock
 * choice is the only input: pick 4 x 1 and every label says 4, pick 3 x 1 and
 * every label says 3.
 */
export function printWidth(widthIn: number, dpi = 203): number {
  if (dpi !== 203) return Math.round(widthIn * dpi)
  if (widthIn >= 3.9) return 832
  if (widthIn >= 2.9) return 609
  return Math.round(widthIn * dpi)
}

function sampleBody(code: string, shown: string, copies: number, offsetX = 0, pw = 832): string {
  // The site's own origin is x=38. A media correction moves both fields
  // together, so the design is untouched and only where it lands changes.
  const x = String(Math.max(0, 38 + Math.round(offsetX))).padStart(4, '0')
  return [
    '^XA^MCY^XZ^XA^ILLB^FS',
    // After ^ILLB, so the stored format cannot override it.
    `^PW${pw}`,
    '^FO0000,0000^AAN,0000,0000^FD ^FS',
    `^FO${x},0084^BY03,3,100^B3N,N,0100,N,N^FD${barcodeData(code)}^FS`,
    `^FO${x},0012^A0N,0084,0098^FD${shown}^FS`,
    `^PQ${pad4(copies)},0000,0000,N^FS^MCY^XZ`,
  ].join('\n')
}

/**
 * Modules a Code 39 symbol occupies. Every character is 9 elements - 6 narrow
 * and 3 wide - plus a one-module gap before the next, and the `*` start and
 * stop characters are two more characters on the wire.
 */
export function code39Modules(data: string, ratio = 2): number {
  return (data.length + 2) * (7 + 3 * ratio) - 1
}

/** Width in narrow-bar modules, whichever symbology is in use. */
export function barcodeModules(data: string, spec: LabelSpec): number {
  return spec.symbology === 'code39' ? code39Modules(data, spec.ratio) : code128Modules(data)
}

/**
 * Modules a Code 128 symbol will occupy, near enough to lay out against.
 *
 * Every symbol is 11 modules, plus a 13-module stop. The encoder drops into
 * subset C for runs of four or more digits, halving them, so the estimate has
 * to model that or a mostly-numeric code comes out far wider than predicted.
 */
export function code128Modules(data: string): number {
  let symbols = 2 // start + check digit
  let i = 0
  let inC = false
  while (i < data.length) {
    const run = /^\d+/.exec(data.slice(i))?.[0]?.length ?? 0
    if (run >= 4) {
      const pairs = Math.floor(run / 2)
      if (!inC) {
        symbols++ // switch to subset C
        inC = true
      }
      symbols += pairs
      i += pairs * 2
    } else {
      if (inC) {
        symbols++ // back to subset B
        inC = false
      }
      symbols++
      i++
    }
  }
  return symbols * 11 + 13
}

/**
 * Code 128 can encode the code in subset B throughout, but a run of digits is
 * half the width in subset C. Letting the printer choose (`^BCN` with no mode
 * character) makes it pick per run, which is what keeps an 8-character code
 * inside 4 inches at 203 dpi with room to spare.
 */
export function zplLabel(code: string, spec: LabelSpec = DEFAULT_LABEL): string {
  const c = String(code ?? '').trim().toUpperCase()
  const shown = displayCode(c, spec.separator ?? '-')

  if ((spec.template ?? 'sample') === 'sample') {
    return `${SAMPLE_PREAMBLE}\n${sampleBody(esc(c), esc(shown), spec.copies, spec.offsetX ?? 0, printWidth(spec.widthIn, spec.dpi))}`
  }

  const w = Math.round(spec.widthIn * spec.dpi)
  const h = Math.round(spec.heightIn * spec.dpi)

  // Geometry lifted from the ZPL the racks at this site were printed with:
  //
  //   ^FO0038,0084^BY03,3,100^B3N,N,0100,N,N^FD...^FS
  //   ^FO0038,0012^A0N,0084,0098^FD A27-07G05 ^FS
  //
  // Both fields start at the same x, the line sits at y=12 with a height of
  // 84, and the bars start at y=84 - overlapping the line's cell, because a
  // font cell is taller than the glyphs inside it. Held as fractions so the
  // same layout survives a different stock size or a 300dpi head.
  const nudge = Math.round(spec.offsetX ?? 0)
  const margin = Math.max(0, Math.round(w * (spec.marginRatio ?? 0.047)) + nudge)
  // A rightward nudge has to come out of the width available, or correcting
  // an offset just moves the overrun rather than curing it.
  const usable = w - margin - Math.round(w * (spec.marginRatio ?? 0.047))

  // Fill the width unless told otherwise. Floor of 2 dots keeps the narrow bar
  // above 0.0098in at 203dpi, comfortably clear of the 0.0075in where cheap
  // scanners start to give up; 8 is as wide as is worth going.
  // The bars get more room than the text does. The site format starts them at
  // x=38 and runs to 803 of an 812-dot head - a 9-dot right margin, not a
  // matching 38 - and a symbol sized against the narrower figure drops a whole
  // module width.
  const barUsable = w - margin - Math.round(w * 0.011)
  const modules = barcodeModules(barcodeData(esc(c)), spec)
  const moduleW = clamp(spec.moduleW ?? Math.floor(barUsable / modules), 2, 8)

  // Font 0 is proportional: the width parameter is the widest a glyph may be,
  // not the advance. Measured against the sample, the line comes out at about
  // 0.62 of width-times-characters, which is what the fit check has to use -
  // treating the width as an advance shrinks the text for no reason.
  const widthRatio = spec.textWidthRatio ?? 98 / 84
  const textY = Math.round(h * 0.059)
  const barY = Math.round(h * 0.414)
  const barH = Math.round(h * 0.493)

  // Grow the line to fill the stock rather than pinning it to the sample's
  // dot values. Those suit one width: 84x98 fills a 3in label, and the same
  // numbers on 4in stock leave a third of the label empty. Fed 3in stock this
  // arrives back at 84x98 on its own.
  // Font 0 is proportional: the width parameter caps a glyph, it is not the
  // advance. 0.62 was measured off the site's own 84x98 line, but a measurement
  // taken at one size is a thin thing to size a whole label on - at width 131
  // it predicted the line ending at 769 of 812, and being wrong by a tenth put
  // it off the edge. 0.75 with a margin of safety costs a few dots of height
  // and cannot overrun.
  const PROPORTIONAL = 0.75
  const SAFETY = 0.92
  let textW = spec.textShare
    ? Math.round(h * spec.textShare * widthRatio)
    : Math.floor((usable * SAFETY) / (Math.max(1, shown.length) * PROPORTIONAL))
  let textH = Math.round(textW / widthRatio)

  // The glyphs have to stop before the bars start. Only the cap matters, and
  // that is about 0.62 of the cell the font is given.
  const maxTextH = Math.floor((barY - textY) / PROPORTIONAL)
  if (textH > maxTextH) {
    textH = maxTextH
    textW = Math.round(textH * widthRatio)
  }

  // The sample left-aligns the bars with the line rather than centring them.
  // With a symbol this wide the difference is a few dots either way.
  const barW = modules * moduleW
  const barX = margin

  // Code 39 wants ^B3, Code 128 wants ^BC. Same arguments either way:
  // orientation, height, no interpretation line (there is one already).
  const barcode =
    spec.symbology === 'code39'
      ? `^B3N,N,${barH},N,N^FD${barcodeData(esc(c))}^FS`
      : `^BCN,${barH},N,N,N^FD${barcodeData(esc(c))}^FS`

  return [
    '^XA',
    `^PW${printWidth(spec.widthIn, spec.dpi)}`, // the stock, stated on every label - see printWidth
    // No ^LL. Length is 1in on every stock here, only the width changes, and
    // the printer's own gap sensor measures it better than we can declare it -
    // it calibrated to 218 where this was asserting 220. Declaring a length
    // that disagrees with the calibration is how registration drifts.
    '^LH0,0',
    '^PON', // normal orientation, as the sample sets
    `^MD${clamp(spec.darkness, 0, 30)}`,
    `^PR${clamp(spec.speed, 1, 14)}`,
    '^CI28', // UTF-8, so a stray character cannot corrupt the stream
    // ^FB bounds the field: whatever the estimate does, the printer will not
    // draw past `usable`. Left-justified, one line, no wrap.
    `^FO${margin},${textY}^FB${usable},1,0,L,0^A0N,${textH},${textW}^FD${esc(shown)}^FS`,
    `^BY${moduleW},${clamp(spec.ratio ?? 3, 2, 3)},${barH}`,
    `^FO${barX},${barY}${barcode}`,
    `^PQ${Math.max(1, Math.floor(spec.copies))}`,
    '^XZ',
  ].join('\n')
}

/**
 * A whole run, ready to send.
 *
 * The preamble is printer setup, not part of any label: it clears stored
 * graphics and re-saves the format. Repeating it per label across a run of
 * thousands would do that thousands of times, so it goes out once and each
 * label is just its own body.
 */
export function zplBatch(codes: string[], spec: LabelSpec = DEFAULT_LABEL): string {
  if ((spec.template ?? 'sample') === 'sample') {
    const bodies = codes.map(c => {
      const u = String(c ?? '').trim().toUpperCase()
      return sampleBody(esc(u), esc(displayCode(u, spec.separator ?? '-')), spec.copies, spec.offsetX ?? 0, printWidth(spec.widthIn, spec.dpi))
    })
    return [SAMPLE_PREAMBLE, ...bodies].join('\n') + '\n'
  }
  // A scaled run sets ^PW/^LL for its own stock, and those persist after it.
  // Leaving them set would narrow the next job from any other program on this
  // printer - including the site's own label software, which assumes the
  // saved configuration. Hand the printer back as we found it.
  return codes.map(c => zplLabel(c, spec)).join('\n') + '\n' + RESTORE + '\n'
}

/** Puts the printer back to its saved configuration. */
export const RESTORE = '^XA^JUR^XZ'

/**
 * ^FD ends at the next ^ or ~, so those two characters cannot appear raw in
 * data. Bin codes are A-Z and 0-9 and never contain them, but this is the
 * boundary where a bad code would corrupt every label after it, not just its
 * own - so it is checked rather than assumed.
 */
function esc(s: string): string {
  // Spaces are deliberately kept: the zone field is padded with them.
  return s.replace(/[\^~]/g, '')
}

function clamp01(n: number): number {
  return Math.min(0.85, Math.max(0.2, n))
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

/** Rough guess at the bytes a run will be, for warning before a huge job. */
export function estimateBytes(count: number, spec: LabelSpec = DEFAULT_LABEL): number {
  return count * zplLabel('A0000A01', spec).length
}
