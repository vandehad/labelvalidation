/**
 * Logic tests that need no database.
 *   node --experimental-strip-types scripts/test.ts
 */
import { parseOld, generateLabels, validatePair, newCode, splitNew, NEW_PATTERN } from '../src/lib/bins.ts'
import { makeXlsx } from '../src/lib/xlsx.ts'
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
ok('malformed allowed when off', validatePair('A-1-1-1', 'GARBAGE', { enforceFormat: false, location: null }) === null)
ok('wrong zone refused', !!validatePair('A-1-1-1', 'B0101C01', { enforceFormat: true, location: loc }))
ok('wrong aisle refused', !!validatePair('A-1-1-1', 'A0201C01', { enforceFormat: true, location: loc }))
ok('wrong column refused', !!validatePair('A-1-1-1', 'A0102C01', { enforceFormat: true, location: { zone: 'A', aisle: 1, col: 1 } }))
ok('column free when null', validatePair('A-1-1-1', 'A0109C01', { enforceFormat: true, location: loc }) === null)
ok('empty refused', !!validatePair('', 'A0101C01', { enforceFormat: true, location: loc }))

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
