/**
 * Logic tests that need no database.
 *   node --experimental-strip-types scripts/test.ts
 */
import {
  parseOld,
  generateLabels,
  validatePair,
  newCode,
  splitNew,
  NEW_PATTERN,
  parseMapTable,
  verdictFor,
  displayCode,
  parseZones,
  normalizeScan,
} from '../src/lib/bins.ts'
import { makeXlsx } from '../src/lib/xlsx.ts'
import { parseDelimited, readXlsxRows } from '../src/lib/sheet.ts'
import { pickDatabaseUrl } from '../src/lib/dburl.mjs'
import {
  zplLabel,
  zplBatch,
  DEFAULT_LABEL,
  RESTORE,
  code128Modules,
  code39Modules,
  barcodeModules,
} from '../src/lib/zpl.ts'
import { writeFileSync, unlinkSync } from 'node:fs'

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean) => {
  cond ? pass++ : fail++
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name)
}

/* ---------- parsing ---------- */
ok('dashed bin', JSON.stringify(parseOld('A-1-2-3')) === JSON.stringify({ zone: 'A', aisle: 1, col: 2, shelf: 3 }))
ok('no-dash bin', JSON.stringify(parseOld('A010203')) === JSON.stringify({ zone: 'A', aisle: 1, col: 2, shelf: 3 }))
ok('missing dash after zone', JSON.stringify(parseOld('P3-3-0')) === JSON.stringify({ zone: 'P', aisle: 3, col: 3, shelf: 0 }))
ok('wide aisle digits', JSON.stringify(parseOld('U-01-11-05')) === JSON.stringify({ zone: 'U', aisle: 1, col: 11, shelf: 5 }))
ok('lowercase accepted', parseOld('a-1-2-3')?.zone === 'A')
ok('garbage rejected', parseOld('NOPE') === null)
ok('new code built', newCode('A', 1, 2, 'C') === 'A0102C01')
ok('new code split', splitNew('A0102C01')?.letter === 'C')
ok('bad new code rejected', splitNew('A1-2C01') === null)

/* ---------- generation ---------- */
const bins = [
  'A-1-1-1', 'A-1-1-2', 'A-1-1-3',
  'A-1-2-1', 'A-1-2-2',
  'A010301', 'A010302', 'A010303', 'A010304',
  'A-1-4-0',
]
const g = generateLabels({ mode: 'derive', oldBins: bins, basis: 'global', zMode: 'auto' })
ok('uniform basis pads every column to 4', g.labels.filter(l => l.startsWith('A0101')).length === 4)
ok('shorter column padded too', g.labels.filter(l => l.startsWith('A0102')).length === 4)
ok('floor column gets Z', g.labels.includes('A0104Z01'))
ok('floor column = 4 letters + Z', g.labels.filter(l => l.startsWith('A0104')).length === 5)
ok('letters run A..D', ['A', 'B', 'C', 'D'].every(x => g.labels.includes(`A0101${x}01`)))
ok('no stray E', !g.labels.includes('A0101E01'))
ok('tallest reported', g.tallest === 4)
ok('all labels valid format', g.labels.every(l => NEW_PATTERN.test(l)))
ok('labels sorted', g.labels.join() === [...g.labels].sort().join())

const ga = generateLabels({ mode: 'derive', oldBins: bins, basis: 'actual', zMode: 'auto' })
ok('actual basis: A-1-1 has 3', ga.labels.filter(l => l.startsWith('A0101')).length === 3)
ok('actual basis: A-1-3 has 4', ga.labels.filter(l => l.startsWith('A0103')).length === 4)

const gm = generateLabels({
  mode: 'manual', zones: ['A', 'B', 'C'],
  aisleFrom: 1, aisleTo: 2, colFrom: 1, colTo: 3, shelves: 26, zMode: 'never',
})
ok('manual: 3 x 2 x 3 x 26 = 468', gm.labels.length === 468)
ok('manual: A..Z present', gm.labels.includes('A0101A01') && gm.labels.includes('A0101Z01'))

const gz = generateLabels({
  mode: 'manual', zones: ['A'], aisleFrom: 1, aisleTo: 1,
  colFrom: 1, colTo: 1, shelves: 26, zMode: 'always',
})
ok('Z reserved caps letters at 25 + Z', gz.labels.length === 26 && gz.labels.includes('A0101Z01') && !gz.labels.includes('A0101Z01'.replace('Z', 'Y')) === false)
ok('overflow flagged when Z reserved', gz.capped.length === 1 && gz.capped[0].needed === 26)

const gu = generateLabels({ mode: 'derive', oldBins: ['A-1-1-1', 'JUNK', ''], basis: 'actual', zMode: 'auto' })
ok('unparsable captured', gu.unparsed.length === 1 && gu.unparsed[0] === 'JUNK')

/* ---------- pair validation ---------- */
const loc = { zone: 'A', aisle: 1, col: null }
ok('valid pair', validatePair('A-1-1-1', 'A0101C01', { enforceFormat: true, location: loc }) === null)
ok('identical refused', !!validatePair('A0101C01', 'A0101C01', { enforceFormat: true, location: loc }))
ok('malformed refused', !!validatePair('A-1-1-1', 'GARBAGE', { enforceFormat: true, location: loc }))
ok(
  'format refusal names the shape it wants',
  String(validatePair('A-1-1-1', 'GARBAGE', { enforceFormat: true, location: loc })).includes('A0101F01'),
)
ok('malformed allowed when off', validatePair('A-1-1-1', 'GARBAGE', { enforceFormat: false, location: null }) === null)
ok('wrong zone refused', !!validatePair('A-1-1-1', 'B0101C01', { enforceFormat: true, location: loc }))
ok('wrong aisle refused', !!validatePair('A-1-1-1', 'A0201C01', { enforceFormat: true, location: loc }))
ok('wrong column refused', !!validatePair('A-1-1-1', 'A0102C01', { enforceFormat: true, location: { zone: 'A', aisle: 1, col: 1 } }))
ok('column free when null', validatePair('A-1-1-1', 'A0109C01', { enforceFormat: true, location: loc }) === null)
ok('empty refused', !!validatePair('', 'A0101C01', { enforceFormat: true, location: loc }))

/* ---------- uploaded bin map ---------- */
const mp = parseMapTable([
  ['OLD BIN', 'NEW BIN'],
  ['A-1-1-1', 'A0101E01'],
  ['a-1-1-2', 'a0101d01'],
  ['A010103', 'A0101C01', 'ignored third column'],
  ['', 'A0101B01'],
  ['A-1-1-5', ''],
  [null, null],
  ['A-1-1-6', 'A-1-1-6'],
  ['A-1-1-1', 'A0101Z01'],
  ['A-1-2-1', 'A0101E01'],
  ['A-1-3-1', 'JUNK'],
])
ok('map header dropped', mp.header === true)
ok('map rows kept', mp.rows.length === 6)
ok('map uppercases', mp.rows[1].oldBin === 'A-1-1-2' && mp.rows[1].newBin === 'A0101D01')
ok('map ignores column C', mp.rows[2].newBin === 'A0101C01')
ok('map skips missing old', mp.skipped.some(x => x.why.includes('no old bin')))
ok('map skips missing new', mp.skipped.some(x => x.why.includes('no new bin')))
ok('map skips self-mapping', mp.skipped.some(x => x.why.includes('mapped to itself')))
ok('map ignores blank rows', mp.skipped.length === 3)
ok('map flags repeated old bin', mp.dupOld.length === 1 && mp.dupOld[0] === 'A-1-1-1')
ok('map flags reused new code', mp.dupNew.length === 1 && mp.dupNew[0].newBin === 'A0101E01')
ok('map names the colliding bins', mp.dupNew[0].oldBins.join(',') === 'A-1-1-1,A-1-2-1')
ok('map flags wrong-shaped code', mp.badNew.length === 1 && mp.badNew[0] === 'JUNK')

const noHeader = parseMapTable([['A-1-1-1', 'A0101E01'], ['A-1-1-2', 'A0101D01']])
ok('map without a header keeps row 1', noHeader.header === false && noHeader.rows.length === 2)
const oddHeader = parseMapTable([['FROM', 'TO'], ['A-1-1-1', 'A0101E01']])
ok('map header need not say bin', oddHeader.header === true && oddHeader.rows.length === 1)
ok('map of nothing is empty', parseMapTable([]).rows.length === 0)

/* ---------- validation verdicts ---------- */
ok('verdict match', verdictFor('A0101E01', 'A0101E01') === 'match')
ok('verdict match ignores case and space', verdictFor(' a0101e01 ', 'A0101E01') === 'match')
ok('verdict mismatch', verdictFor('A0101D01', 'A0101E01') === 'mismatch')
ok('verdict unmapped when no reference', verdictFor('A0101E01', null) === 'unmapped')
ok('verdict unmapped on empty reference', verdictFor('A0101E01', '') === 'unmapped')

/* ---------- pasted / csv input ---------- */
ok('csv two columns', JSON.stringify(parseDelimited('A-1-1-1,A0101E01')) === JSON.stringify([['A-1-1-1', 'A0101E01']]))
ok('csv keeps quoted commas', parseDelimited('"a,b",A0101E01')[0][0] === 'a,b')
ok('tsv detected', parseDelimited('A-1-1-1\tA0101E01\nA-1-1-2\tA0101D01').length === 2)
ok('blank lines dropped', parseDelimited('A-1-1-1,A0101E01\n\n\nA-1-1-2,A0101D01').length === 2)

/* ---------- which env var holds the connection string ---------- */
const PG = 'postgres://u:p@ep-x-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require'
const NEON_ENV = {
  LABELPG_DATABASE_URL: PG,
  LABELPG_DATABASE_URL_UNPOOLED: PG + '&unpooled',
  LABELPG_POSTGRES_PRISMA_URL: PG + '&prisma',
  LABELPG_POSTGRES_URL_NO_SSL: 'postgres://u:p@host/db',
  LABELPG_POSTGRES_URL_NON_POOLING: PG,
  LABELPG_PGHOST: 'ep-x.us-east-1.aws.neon.tech',
  LABELPG_NEON_PROJECT_ID: 'quiet-bird-123',
}
ok('plain DATABASE_URL wins', pickDatabaseUrl({ DATABASE_URL: PG, ...NEON_ENV })?.name === 'DATABASE_URL')
ok('falls back to the prefixed one', pickDatabaseUrl(NEON_ENV)?.name === 'LABELPG_DATABASE_URL')
ok('returns the value, trimmed', pickDatabaseUrl({ DATABASE_URL: '  ' + PG + '  ' })?.url === PG)
ok('skips unpooled', pickDatabaseUrl({ LABELPG_DATABASE_URL_UNPOOLED: PG }) === null)
ok('skips prisma', pickDatabaseUrl({ LABELPG_POSTGRES_PRISMA_URL: PG }) === null)
ok('skips non-pooling', pickDatabaseUrl({ LABELPG_POSTGRES_URL_NON_POOLING: PG }) === null)
ok('ignores a host that is not a url', pickDatabaseUrl({ LABELPG_PGHOST: 'ep-x.neon.tech' }) === null)
ok('ignores an empty value', pickDatabaseUrl({ DATABASE_URL: '' }) === null)
ok('nothing set is null', pickDatabaseUrl({}) === null)
ok('postgresql:// accepted', pickDatabaseUrl({ DATABASE_URL: 'postgresql://u:p@h/d' })?.url === 'postgresql://u:p@h/d')
ok('POSTGRES_URL is a fallback', pickDatabaseUrl({ POSTGRES_URL: PG })?.name === 'POSTGRES_URL')
ok(
  'two stores pick the same one every time',
  pickDatabaseUrl({ ZED_DATABASE_URL: PG, ALPHA_DATABASE_URL: PG })?.name === 'ALPHA_DATABASE_URL',
)

/* ---------- positions within a shelf ---------- */
ok('position defaults to 01', newCode('A', 0, 0, 'A') === 'A0000A01')
ok('position is padded', newCode('A', 1, 2, 'C', 7) === 'A0102C07')
const multi = generateLabels({
  mode: 'manual', zones: ['A'], aisleFrom: 1, aisleTo: 1,
  colFrom: 1, colTo: 1, shelves: 2, positions: 3, zMode: 'never',
})
ok('2 shelves x 3 positions = 6 labels', multi.labels.length === 6)
ok('positions run 01..03', multi.labels.slice(0, 3).join(',') === 'A0101A01,A0101A02,A0101A03')
ok('every generated position is a valid code', multi.labels.every(l => NEW_PATTERN.test(l)))
const withZ = generateLabels({
  mode: 'manual', zones: ['A'], aisleFrom: 1, aisleTo: 1,
  colFrom: 1, colTo: 1, shelves: 1, positions: 2, zMode: 'always',
})
ok('floor level gets positions too', withZ.labels.filter(l => l[5] === 'Z').length === 2)
const batch = generateLabels({
  mode: 'manual', zones: parseZones('A-D'), aisleFrom: 1, aisleTo: 2,
  colFrom: 1, colTo: 24, shelves: 10, positions: 1, zMode: 'never',
})
ok('4 zones x 2 aisles x 24 cols x 10 shelves = 1920', batch.labels.length === 1920)
ok('no duplicates in a batch', new Set(batch.labels).size === batch.labels.length)

/* ---------- zone ranges ---------- */
ok('A-Z is 26 zones', parseZones('A-Z').length === 26)
ok('a range is inclusive', parseZones('A-C').join('') === 'ABC')
ok('a backwards range still works', parseZones('C-A').join('') === 'ABC')
ok('comma list', parseZones('A,B,K').join('') === 'ABK')
ok('mixed list and range', parseZones('A-C, K').join('') === 'ABCK')
ok('lowercase accepted', parseZones('a-c').join('') === 'ABC')
ok('duplicates collapse', parseZones('A,A,A-B').join('') === 'AB')
ok('junk dropped', parseZones('A, 7, ??, B').join('') === 'AB')
ok('empty is empty', parseZones('').length === 0)

/* ---------- display vs barcode ---------- */
ok('dash goes after the third character', displayCode('A0000A01') === 'A00-00A01')
ok('display uppercases', displayCode('a0102c01') === 'A01-02C01')
ok('short strings are left alone', displayCode('AB') === 'AB')

/* ---------- zpl: the format the site already prints ---------- */
// Byte for byte the site's own export, with `^` for its `¬` and only the code
// substituted. Their file is the specification, so this is a fixture rather
// than a calculation - if it drifts, new labels stop matching the racks.
const SAMPLE = [
  '~CC^',
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
  '^XA^MCY^XZ^XA^ILLB^FS',
  '^FO0000,0000^AAN,0000,0000^FD ^FS',
  '^FO0038,0084^BY03,3,100^B3N,N,0100,N,N^FDA     A2707G05^FS',
  '^FO0038,0012^A0N,0084,0098^FDA27-07G05^FS',
  '^PQ0001,0000,0000,N^FS^MCY^XZ',
].join('\n')

ok('reproduces the site format exactly', zplLabel('A2707G05') === SAMPLE)
// The one addition to their file. ^PW and ^LL persist on the printer and this
// format sends neither, so without recalling the saved configuration a single
// 3x1 run leaves every later label clipped to 609 dots - and switching the
// setting back does nothing, because there is nothing in the format to undo it.
ok('recalls the saved configuration first', zplLabel('A2707G05').split('\n')[1] === '^XA^JUR^XZ')
ok('no ^PW or ^LL - the printer stock decides', !zplLabel('A2707G05').includes('^PW'))
// Their file opens with ~CC¬, which switches the format prefix and leaves it
// switched. Without resetting it, a plain ^XA after their program has run is
// ignored by the printer.
ok('resets the format prefix', zplLabel('A2707G05').startsWith('~CC^'))
ok('barcode carries the padded field then the code', zplLabel('A2707G05').includes('^FDA     A2707G05^FS'))
ok('the padding is six characters', 'A     '.length === 6)
ok('line carries the dashed code and no padding', zplLabel('A2707G05').includes('^FDA27-07G05^FS'))
ok('the prefix can be turned off', zplLabel('A2707G05', { ...DEFAULT_LABEL, barcodePrefix: '' }).includes('^FDA2707G05^FS'))
ok('copies land in ^PQ', zplLabel('A2707G05', { ...DEFAULT_LABEL, copies: 12 }).includes('^PQ0012,'))
ok('darkness is left to the printer', zplLabel('A2707G05').includes('^MD+00'))
ok('code 39, no check digit, no interpretation line', zplLabel('A2707G05').includes('^B3N,N,0100,N,N'))
ok('^ and ~ are stripped from data', !zplLabel('A^27~0G05').includes('^27~0'))
// 14 characters at ^BY03,3 is 765 dots, ending at 803 of an 812-dot head.
ok('the padded symbol still fits the head', code39Modules('A     A2707G05', 3) * 3 + 38 <= 812)
ok('one more character would not', code39Modules('A      A2707G05', 3) * 3 + 38 > 812)

// A batch is the setup once, then a body per label - repeating ^IDR across
// thousands would re-clear stored graphics on every single one.
const zbatch = zplBatch(['A0101A01', 'A0101B01', 'A0101C01'])
ok('zbatch sends the preamble once', (zbatch.match(/\^IDR:\*\.GRF/g) ?? []).length === 1)
ok('zbatch has one body per label', (zbatch.match(/\^ILLB/g) ?? []).length === 3)
ok('zbatch pads every barcode', (zbatch.match(/\^FDA {5}A0101/g) ?? []).length === 3)
ok('zbatch keeps every dashed line', zbatch.includes('^FDA01-01A01^FS'))

/* ---------- what a scanner hands back ---------- */
// The label encodes `A     A0101B01`, so the gun returns all fourteen
// characters. Everything after the last space is the bin code.
ok('padding is stripped', normalizeScan('A     A0101B01') === 'A0101B01')
ok('an unpadded scan is untouched', normalizeScan('A0101B01') === 'A0101B01')
ok('an old bin is untouched', normalizeScan('A-1-1-1') === 'A-1-1-1')
ok('surrounding space is trimmed', normalizeScan('  A0101B01  ') === 'A0101B01')
ok('lowercase is lifted', normalizeScan('a     a0101b01') === 'A0101B01')
ok('empty stays empty', normalizeScan('') === '')
ok('only spaces is empty', normalizeScan('     ') === '')
// The whole point: a padded scan has to pass the same gate an unpadded one does.
ok(
  'a padded scan passes the format gate',
  validatePair('A-1-1-1', normalizeScan('A     A0101C01'), { enforceFormat: true, location: null }) === null,
)
ok(
  'and would not have without it',
  !!validatePair('A-1-1-1', 'A     A0101C01', { enforceFormat: true, location: null }),
)

/* ---------- zpl: laid out against other stock ---------- */
// The site format has no ^PW/^LL and its dot values suit its own stock. For
// anything else the same design is measured out against the label size.
const SCALED = { ...DEFAULT_LABEL, template: 'scaled' as const }
const z = zplLabel('A0102C01', SCALED)
ok('scaled is one label', (z.match(/\^XA/g) ?? []).length === 1 && z.trim().endsWith('^XZ'))
// ^PW but no ^LL. Length is 1in on every stock, only the width changes, and
// the printer's gap sensor measures length better than we can declare it -
// asserting 220 against its calibrated 218 is how registration drifts.
ok('scaled states the width', z.includes('^PW812'))
ok('scaled leaves length to the calibration', !z.includes('^LL'))
const barcodeData = /\^B[3C]N[^^]*\^FD([^^]*)\^FS/.exec(z)?.[1]
ok('barcode field is the padding then the code', barcodeData === 'A     A0102C01')
ok('the dash is never inside the barcode field', !barcodeData?.includes('-'))
ok('and without padding it is just the code', /\^B3N[^^]*\^FD([^^]*)\^FS/.exec(zplLabel('A0102C01', { ...SCALED, barcodePrefix: '' }))?.[1] === 'A0102C01')
ok('code 39 by default', z.includes('^B3N,'))
ok('code 128 on request', zplLabel('A0102C01', { ...SCALED, symbology: 'code128' }).includes('^BCN,'))
const zi = zplLabel('L0312K01', SCALED)
const barX = Number(/\^FO(\d+),\d+\^B[3C]/.exec(zi)![1])
// ^FB now sits between ^FO and the font, bounding the line.
const textX = Number(/\^FO(\d+),\d+\^FB/.exec(zi)![1])
ok('bars and line start at the same x', barX === textX)
ok('text is printed before the barcode', zi.indexOf('^A0N') < zi.indexOf('^B3N'))
ok('the line is bounded so it cannot overrun', /\^FB(\d+),1,0,L,0/.test(zi))
ok('that bound is the usable width', Number(/\^FB(\d+),/.exec(zi)![1]) === 812 - 38 * 2)
ok('a label home offset can be set', zplLabel('L0312K01', { ...SCALED, offsetX: 25 }).includes('^LH25,0'))
ok('and defaults to none', zi.includes('^LH0,0'))

// The site format is a 4in format after all: its 14-character symbol at
// ^BY03,3 is 765 dots, which needs the 812-dot head. Sized against the same
// stock the scaled path picks the same module width.
const derived = zplLabel('A2707G05', SCALED)
ok('4in stock picks the site module width', derived.includes('^BY3,3,'))
// It does give the line more room than the site format does - the site's own
// 84x98 fills about two thirds of the label and leaves the rest empty.
// Bigger than the site format's own 84x98, but sized with headroom now: the
// proportional advance was estimated at one size and applying it at another
// put the line off the right edge.
ok('the line is grown, but within the stock', derived.includes('^A0N,86,100'))
ok('a 3in roll drops the module rather than overflowing', zplLabel('A2707G05', { ...SCALED, widthIn: 3 }).includes('^BY2,'))

/* ---------- the printer is handed back as it was found ---------- */
// A scaled run sets ^PW/^LL for its own stock and those outlive the job. Left
// set, they would narrow the next print from any other program on the printer,
// including the site's own label software.
const narrow = zplBatch(['L0312K01'], { ...SCALED, widthIn: 3 })
ok('a scaled run states its stock', narrow.includes('^PW609'))
ok('and restores the printer afterwards', narrow.trim().endsWith('^XA^JUR^XZ'))
ok('the site format restores it up front too', zplBatch(['L0312K01']).includes('^XA^JUR^XZ'))
ok('restore is exported for reuse', RESTORE === '^XA^JUR^XZ')


/* ---------- barcode sizing ---------- */
ok('code 39 is 9 elements plus a gap per character', code39Modules('AB', 2) === (2 + 2) * 13 - 1)
ok('a wider ratio makes a wider symbol', code39Modules('AB', 3) > code39Modules('AB', 2))
ok('code 39 is wider than code 128 for the same data', code39Modules('L0312K01', 2) > code128Modules('L0312K01'))
ok('a plain letter run is 11 modules each', code128Modules('ABC') === (2 + 3) * 11 + 13)
ok('four digits collapse into subset C', code128Modules('A0102') < code128Modules('ABCDE'))
ok('a real code is 123 modules', code128Modules('A0102C01') === 123)
ok('barcodeModules follows the chosen symbology', barcodeModules('L0312K01', { ...SCALED, symbology: 'code128' }) === code128Modules('L0312K01'))

/* ---------- display vs barcode ---------- */
ok('dash goes after the third character', displayCode('A0000A01') === 'A00-00A01')
ok('display uppercases', displayCode('a0102c01') === 'A01-02C01')
ok('short strings are left alone', displayCode('AB') === 'AB')
ok('the separator is configurable', displayCode('A0000A01', ' - ') === 'A00 - 00A01')

/* ---------- xlsx ---------- */
const rows: Array<Array<string | number | null>> = [['OLD BIN', 'NEW BIN', 'QTY', 'NOTE']]
for (let i = 1; i <= 200; i++) rows.push([`A-1-${i}-2`, `A01${String(i % 99).padStart(2, '0')}C01`, i, i % 7 ? '' : 'quote " & <tag>'])
const bytes = makeXlsx([
  { name: 'CROSS REFERENCE', rows, widths: [14, 14, 8, 24] },
  { name: 'SUMMARY', rows: [['MEASURE', 'VALUE'], ['pairs', 200], ['one-for-one', 'YES']], widths: [30, 12] },
])
ok('xlsx has zip magic', bytes[0] === 0x50 && bytes[1] === 0x4b)
ok('xlsx non-trivial size', bytes.length > 5000)
writeFileSync('_test.xlsx', bytes)
ok('xlsx written to disk', true)
try { unlinkSync('_test.xlsx') } catch { /* leave it */ }

// The reader lifted from the standalone build, checked against our own writer.
const back = await readXlsxRows(bytes)
ok('xlsx reads back the header', back[0][0] === 'OLD BIN' && back[0][1] === 'NEW BIN')
ok('xlsx reads back every row', back.length === rows.length)
ok('xlsx reads back a value', back[1][0] === 'A-1-1-2')
ok('xlsx unescapes markup', back.some(r => r[3] === 'quote " & <tag>'))
const mapped = parseMapTable(back)
ok('a written workbook parses as a bin map', mapped.header === true && mapped.rows.length === 200)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
