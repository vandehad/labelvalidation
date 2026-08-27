/* Bin Conversion Station - scan pairing, label generation, reconciliation. */
'use strict';

const KEY = 'binconv.v2';
const NEWPAT = /^[A-Z]\d{4}[A-Z]\d{2}$/;

let state = { site: '', labels: [], pairs: [], printed: [] };
let lastFocus = 'old';

/* ---------- persistence ---------- */
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { flash('bad', 'Could not save locally: ' + e.message); }
}
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = Object.assign(state, JSON.parse(raw));
  } catch (e) { /* start fresh */ }
}

/* ---------- bin parsing ---------- */
function parseOld(o) {
  o = String(o).trim().toUpperCase();
  let m = /^([A-Z])-?(\d+)-(\d+)-(\d+)$/.exec(o);
  if (m) return { zone: m[1], aisle: +m[2], col: +m[3], shelf: +m[4] };
  m = /^([A-Z])(\d{2})(\d{2})(\d{2})$/.exec(o);
  if (m) return { zone: m[1], aisle: +m[2], col: +m[3], shelf: +m[4] };
  return null;
}
const pad2 = n => String(n).padStart(2, '0');
const code = (z, a, c, letter) => `${z}${pad2(a)}${pad2(c)}${letter}01`;

/* ---------- ui helpers ---------- */
const $ = id => document.getElementById(id);
function flash(kind, text, sticky) {
  const m = $('scanMsg');
  m.className = 'msg show ' + kind;
  m.textContent = text;
  clearTimeout(flash._t);
  if (!sticky) flash._t = setTimeout(() => { m.className = 'msg'; }, 3200);
}
let actx = null;
function beep(good) {
  if ($('optBeep').value !== '1') return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.connect(g); g.connect(actx.destination);
    o.frequency.value = good ? 1180 : 220;
    o.type = good ? 'sine' : 'square';
    g.gain.setValueAtTime(0.14, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + (good ? 0.11 : 0.42));
    o.start(); o.stop(actx.currentTime + (good ? 0.12 : 0.45));
  } catch (e) { /* no audio, no problem */ }
}
function table(el, headers, rows, rowClass) {
  el.innerHTML = '<thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map(r => `<tr class="${rowClass ? rowClass(r) : ''}">` +
      r.map(c => `<td>${c === null || c === undefined ? '' : String(c)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>`).join('') + '</tr>').join('') +
    '</tbody>';
}
function stats(el, items) {
  el.innerHTML = items.map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
}

/* ---------- tabs ---------- */
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
  $('tab-' + b.dataset.tab).classList.add('on');
  if (b.dataset.tab === 'scan') setTimeout(() => $('fOld').focus(), 30);
  if (b.dataset.tab === 'data') renderIntegrity();
});

/* ---------- file reading ---------- */
async function readAnyFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (/\.xlsx$/i.test(file.name)) {
    try { return await readXlsxRows(buf); }
    catch (e) { throw new Error('Could not read that .xlsx (' + e.message + '). Save it as CSV and retry.'); }
  }
  const text = new TextDecoder().decode(buf).replace(/^﻿/, '');
  return /,/.test(text.split('\n')[0] || '') ? parseCsv(text) : text.split(/\r?\n/).map(l => [l]);
}
/* pull bin-looking tokens out of arbitrary rows */
function harvestBins(rows) {
  const out = [];
  for (const r of rows) {
    for (const cell of r) {
      const v = String(cell || '').trim().toUpperCase();
      if (!v) continue;
      if (parseOld(v) || NEWPAT.test(v)) { out.push(v); break; }
    }
  }
  return out;
}

/* ================= TAB 1 : generate ================= */
$('genMode').onchange = () => {
  const d = $('genMode').value === 'derive';
  $('deriveBox').style.display = d ? '' : 'none';
  $('manualBox').style.display = d ? 'none' : '';
};
$('oldFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const rows = await readAnyFile(f);
    $('oldList').value = harvestBins(rows).join('\n');
  } catch (err) { alert(err.message); }
};

function expandZones(spec) {
  const out = [];
  for (const part of spec.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)) {
    const m = /^([A-Z])-([A-Z])$/.exec(part);
    if (m) { for (let c = m[1].charCodeAt(0); c <= m[2].charCodeAt(0); c++) out.push(String.fromCharCode(c)); }
    else if (/^[A-Z]$/.test(part)) out.push(part);
  }
  return [...new Set(out)];
}

$('btnGen').onclick = () => {
  const basis = $('genBasis').value, zmode = $('genZ').value;
  let cols = [];            // {zone,aisle,col,shelves,hasFloor}

  if ($('genMode').value === 'derive') {
    const bins = $('oldList').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const parsed = bins.map(parseOld).filter(Boolean);
    if (!parsed.length) return alert('No recognisable bins in that list.');
    const map = new Map();
    for (const p of parsed) {
      const k = p.zone + '|' + p.aisle + '|' + p.col;
      if (!map.has(k)) map.set(k, { zone: p.zone, aisle: p.aisle, col: p.col, shelves: new Set(), floor: false });
      const e = map.get(k);
      if (p.shelf === 0) e.floor = true; else e.shelves.add(p.shelf);
    }
    const all = [...map.values()];
    const maxGlobal = Math.max(...all.map(e => e.shelves.size));
    const byZone = {}, byAisle = {};
    for (const e of all) {
      byZone[e.zone] = Math.max(byZone[e.zone] || 0, e.shelves.size);
      const ka = e.zone + '|' + e.aisle;
      byAisle[ka] = Math.max(byAisle[ka] || 0, e.shelves.size);
    }
    cols = all.map(e => ({
      zone: e.zone, aisle: e.aisle, col: e.col, hasFloor: e.floor,
      shelves: basis === 'global' ? maxGlobal
        : basis === 'zone' ? byZone[e.zone]
          : basis === 'aisle' ? byAisle[e.zone + '|' + e.aisle]
            : e.shelves.size
    }));
  } else {
    const zones = expandZones($('mZones').value);
    if (!zones.length) return alert('Enter at least one zone.');
    const a1 = +$('mA1').value, a2 = +$('mA2').value, c1 = +$('mC1').value, c2 = +$('mC2').value, sh = +$('mS').value;
    if (a2 < a1 || c2 < c1) return alert('Check the from/to ranges.');
    for (const z of zones)
      for (let a = a1; a <= a2; a++)
        for (let c = c1; c <= c2; c++)
          cols.push({ zone: z, aisle: a, col: c, shelves: sh, hasFloor: false });
  }

  const labels = [];
  let capped = 0;
  for (const e of cols) {
    let n = Math.max(1, e.shelves);
    const wantZ = zmode === 'always' || (zmode === 'auto' && e.hasFloor);
    const limit = wantZ ? 25 : 26;           // keep Z free when it means floor
    if (n > limit) { n = limit; capped++; }
    for (let i = 0; i < n; i++) labels.push(code(e.zone, e.aisle, e.col, String.fromCharCode(65 + i)));
    if (wantZ) labels.push(code(e.zone, e.aisle, e.col, 'Z'));
  }
  labels.sort();
  state.labels = labels;
  save();

  const zoneCount = new Set(cols.map(c => c.zone)).size;
  stats($('genStats'), [
    [labels.length.toLocaleString(), 'labels'],
    [cols.length.toLocaleString(), 'columns'],
    [zoneCount, 'zones'],
    [Math.max(...cols.map(c => c.shelves)), 'tallest column'],
    [capped, 'capped at 26']
  ]);
  table($('genTable'), ['LABEL', 'ZONE', 'AISLE', 'COLUMN', 'SHELF'],
    labels.slice(0, 400).map(l => [l, l[0], +l.slice(1, 3), +l.slice(3, 5), l[5]]));
  $('genResult').style.display = '';
  $('btnGenXlsx').disabled = $('btnGenCsv').disabled = false;
  if (capped) flash('warn', capped + ' column(s) needed more than 26 shelves and were capped — check those.', true);
};

$('btnGenXlsx').onclick = () => {
  const rows = [['LABEL', 'ZONE', 'AISLE', 'COLUMN', 'SHELF']];
  for (const l of state.labels) rows.push([l, l[0], +l.slice(1, 3), +l.slice(3, 5), l[5]]);
  downloadBytes(makeXlsx([{ name: 'LABELS', rows, widths: [14, 8, 8, 9, 8] }]),
    fname('labels', 'xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
};
$('btnGenCsv').onclick = () => {
  const rows = [['LABEL']].concat(state.labels.map(l => [l]));
  downloadBytes(new TextEncoder().encode(toCsv(rows)), fname('labels', 'csv'), 'text/csv');
};

function fname(what, ext) {
  const s = (state.site || 'site').replace(/[^\w-]+/g, '_');
  const d = new Date().toISOString().slice(0, 10);
  return `${s}_${what}_${d}.${ext}`;
}

/* ================= TAB 2 : scan ================= */
let loc = { zone: '', aisle: null, col: null };

$('btnLoc').onclick = () => {
  const z = $('locZone').value.trim().toUpperCase();
  const a = $('locAisle').value === '' ? null : +$('locAisle').value;
  const c = $('locCol').value === '' ? null : +$('locCol').value;
  if (!/^[A-Z]$/.test(z)) return alert('Zone must be a single letter.');
  if (a === null || isNaN(a)) return alert('Enter an aisle.');
  loc = { zone: z, aisle: a, col: c };
  $('locNow').textContent = `${z}-${a}${c === null ? '' : '-' + c}`;
  flash('ok', 'Location set to ' + $('locNow').textContent);
  $('fOld').focus();
};

function locLabel() { return loc.zone ? `${loc.zone}-${loc.aisle}${loc.col === null ? '' : '-' + loc.col}` : ''; }

function advance(e, from) {
  if (e.key !== 'Enter' && e.key !== 'Tab') return;
  e.preventDefault();
  const v = e.target.value.trim().toUpperCase();
  if (!v) { if (from === 'new') $('fOld').focus(); return; }
  e.target.value = v;
  if (from === 'old') { $('fNew').focus(); arm(); }
  else commit();
}
function arm() {
  $('fOldWrap').classList.toggle('armed', !!$('fOld').value.trim());
  $('fNewWrap').classList.toggle('armed', !!$('fNew').value.trim());
}
$('fOld').addEventListener('keydown', e => advance(e, 'old'));
$('fNew').addEventListener('keydown', e => advance(e, 'new'));
$('fOld').addEventListener('input', arm);
$('fNew').addEventListener('input', arm);

function commit() {
  const oldBin = $('fOld').value.trim().toUpperCase();
  const newBin = $('fNew').value.trim().toUpperCase();
  if (!oldBin || !newBin) { flash('bad', 'Both fields are needed.'); beep(false); return; }

  const fail = validate(oldBin, newBin);
  if (fail) { flash('bad', fail, true); beep(false); $('fNew').select(); return; }

  state.pairs.push({ old: oldBin, new: newBin, loc: locLabel(), ts: Date.now() });
  save();
  flash('ok', `${oldBin}  →  ${newBin}`);
  beep(true);
  $('fOld').value = ''; $('fNew').value = '';
  arm(); $('fOld').focus();
  renderPairs();
}

function validate(oldBin, newBin) {
  if (oldBin === newBin) return 'Old and new are identical — same label scanned twice?';
  const dupOld = state.pairs.find(p => p.old === oldBin);
  if (dupOld) return `Old bin ${oldBin} was already paired to ${dupOld.new}.`;
  const dupNew = state.pairs.find(p => p.new === newBin);
  if (dupNew) return `New bin ${newBin} is already used by ${dupNew.old}.`;
  if ($('optFmt').value === '1' && !NEWPAT.test(newBin))
    return `${newBin} is not a valid new bin (expected like A0102C01).`;
  if ($('optLoc').value === '1' && loc.zone && NEWPAT.test(newBin)) {
    if (newBin[0] !== loc.zone) return `${newBin} is zone ${newBin[0]}, but you are in zone ${loc.zone}.`;
    if (+newBin.slice(1, 3) !== loc.aisle) return `${newBin} is aisle ${+newBin.slice(1, 3)}, but you are in aisle ${loc.aisle}.`;
    if (loc.col !== null && +newBin.slice(3, 5) !== loc.col)
      return `${newBin} is column ${+newBin.slice(3, 5)}, but you are at column ${loc.col}.`;
  }
  return null;
}

$('btnUndo').onclick = () => {
  if (!state.pairs.length) return flash('warn', 'Nothing to undo.');
  const p = state.pairs.pop();
  save(); renderPairs();
  flash('warn', `Removed ${p.old} → ${p.new}`);
  $('fOld').focus();
};
$('btnClearFields').onclick = () => {
  $('fOld').value = ''; $('fNew').value = ''; arm(); $('fOld').focus();
};

function renderPairs() {
  const p = state.pairs;
  const zones = new Set(p.map(x => x.new && x.new[0]));
  stats($('scanStats'), [
    [p.length.toLocaleString(), 'pairs captured'],
    [new Set(p.map(x => x.loc)).size, 'locations'],
    [zones.size, 'zones touched'],
    [state.labels.length ? (state.labels.length - p.length).toLocaleString() : '—', 'labels unused']
  ]);
  const recent = p.slice(-250).reverse();
  table($('pairTable'), ['#', 'OLD BIN', 'NEW BIN', 'LOCATION', 'TIME'],
    recent.map((x, i) => [p.length - i, x.old, x.new, x.loc || '—',
    new Date(x.ts).toLocaleTimeString()]));
}

/* ================= TAB 3 : reconcile ================= */
$('printedFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const rows = await readAnyFile(f);
    const bins = harvestBins(rows).filter(b => NEWPAT.test(b));
    $('printedList').value = bins.join('\n');
    if (!bins.length) alert('No new-format labels found in that file.');
  } catch (err) { alert(err.message); }
};
$('btnUseGen').onclick = () => {
  if (!state.labels.length) return alert('No generated list yet — build one on tab 1.');
  $('printedList').value = state.labels.join('\n');
};

let recData = null;
$('btnRec').onclick = () => {
  const printed = [...new Set($('printedList').value.split(/\r?\n/)
    .map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (!printed.length) return alert('Load or paste the printed label list first.');
  const used = new Set(state.pairs.map(p => p.new));
  const printedSet = new Set(printed);
  const unused = printed.filter(l => !used.has(l)).sort();
  const unexpected = [...used].filter(l => !printedSet.has(l)).sort();
  const matched = printed.length - unused.length;
  state.printed = printed; save();
  recData = { printed, unused, unexpected, matched };

  stats($('recStats'), [
    [printed.length.toLocaleString(), 'printed'],
    [matched.toLocaleString(), 'used'],
    [unused.length.toLocaleString(), 'unused → delete'],
    [unexpected.length.toLocaleString(), 'unexpected'],
    [state.pairs.length.toLocaleString(), 'pairs'],
    [(unexpected.length === 0 && state.pairs.length === matched) ? '1 : 1' : 'CHECK', 'match']
  ]);
  const byZone = {};
  for (const l of unused) byZone[l[0]] = (byZone[l[0]] || 0) + 1;
  table($('unusedTable'), ['LABEL', 'ZONE', 'AISLE', 'COLUMN', 'SHELF'],
    unused.slice(0, 500).map(l => [l, l[0], +l.slice(1, 3), +l.slice(3, 5), l[5]]));
  table($('unexpTable'), ['LABEL', 'PAIRED TO OLD BIN'],
    unexpected.slice(0, 500).map(l => [l, (state.pairs.find(p => p.new === l) || {}).old || '']));
  $('recResult').style.display = '';
};

$('btnRecXlsx').onclick = () => {
  if (!recData) return;
  const sheets = [
    {
      name: 'SUMMARY', widths: [34, 14], rows: [['MEASURE', 'COUNT'],
      ['printed labels', recData.printed.length],
      ['used (scanned)', recData.matched],
      ['unused - delete these', recData.unused.length],
      ['scanned but not printed', recData.unexpected.length],
      ['pairs captured', state.pairs.length],
      ['one-for-one', (recData.unexpected.length === 0 && state.pairs.length === recData.matched) ? 'YES' : 'NO']]
    },
    {
      name: 'DELETE - UNUSED', widths: [14, 8, 8, 9, 8],
      rows: [['LABEL', 'ZONE', 'AISLE', 'COLUMN', 'SHELF']]
        .concat(recData.unused.map(l => [l, l[0], +l.slice(1, 3), +l.slice(3, 5), l[5]]))
    },
    {
      name: 'UNEXPECTED', widths: [14, 14],
      rows: [['LABEL', 'PAIRED TO OLD BIN']]
        .concat(recData.unexpected.map(l => [l, (state.pairs.find(p => p.new === l) || {}).old || '']))
    },
    {
      name: 'CROSS REFERENCE', widths: [14, 14, 12, 20],
      rows: [['OLD BIN', 'NEW BIN', 'LOCATION', 'SCANNED AT']]
        .concat(state.pairs.map(p => [p.old, p.new, p.loc || '', new Date(p.ts).toLocaleString()]))
    }
  ];
  downloadBytes(makeXlsx(sheets), fname('reconciliation', 'xlsx'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
};

/* ================= TAB 4 : export ================= */
function xrefRows() {
  return [['OLD BIN', 'NEW BIN', 'LOCATION', 'SCANNED AT']]
    .concat(state.pairs.map(p => [p.old, p.new, p.loc || '', new Date(p.ts).toLocaleString()]));
}
$('btnXrefXlsx').onclick = () => {
  if (!state.pairs.length) return alert('No pairs captured yet.');
  downloadBytes(makeXlsx([{ name: 'CROSS REFERENCE', rows: xrefRows(), widths: [14, 14, 12, 20] }]),
    fname('crossref', 'xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
};
$('btnXrefCsv').onclick = () => {
  if (!state.pairs.length) return alert('No pairs captured yet.');
  downloadBytes(new TextEncoder().encode(toCsv(xrefRows())), fname('crossref', 'csv'), 'text/csv');
};
$('btnBackup').onclick = () => {
  state.site = $('site').value;
  downloadBytes(new TextEncoder().encode(JSON.stringify(state, null, 1)), fname('backup', 'json'), 'application/json');
};
$('restoreFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    if (!s || !Array.isArray(s.pairs)) throw new Error('not a backup file');
    if (!confirm(`Restore ${s.pairs.length} pairs and ${(s.labels || []).length} labels? This replaces what is here now.`)) return;
    state = Object.assign({ site: '', labels: [], pairs: [], printed: [] }, s);
    save(); boot();
    alert('Restored.');
  } catch (err) { alert('Could not restore: ' + err.message); }
};
$('btnReset').onclick = () => {
  if (!confirm('Delete every captured pair? The generated label list is kept.')) return;
  if (!confirm('This cannot be undone. Really clear ' + state.pairs.length + ' pairs?')) return;
  state.pairs = []; save(); renderPairs(); renderIntegrity();
};

function renderIntegrity() {
  const p = state.pairs, issues = [];
  const seenOld = new Map(), seenNew = new Map();
  for (const x of p) {
    if (seenOld.has(x.old)) issues.push(['Old bin used twice', x.old, seenOld.get(x.old) + ' / ' + x.new]);
    else seenOld.set(x.old, x.new);
    if (seenNew.has(x.new)) issues.push(['New bin used twice', x.new, seenNew.get(x.new) + ' / ' + x.old]);
    else seenNew.set(x.new, x.old);
    if (!NEWPAT.test(x.new)) issues.push(['New bin malformed', x.new, x.old]);
    if (!parseOld(x.old)) issues.push(['Old bin unrecognised', x.old, x.new]);
  }
  stats($('intStats'), [
    [p.length.toLocaleString(), 'pairs'],
    [seenOld.size.toLocaleString(), 'distinct old'],
    [seenNew.size.toLocaleString(), 'distinct new'],
    [issues.length, 'issues']
  ]);
  table($('intTable'), ['ISSUE', 'BIN', 'RELATED'],
    issues.length ? issues.slice(0, 300) : [['None — every pair is one-for-one', '', '']]);
}

/* ---------- boot ---------- */
function boot() {
  $('site').value = state.site || '';
  renderPairs();
  if (state.labels.length) {
    $('btnGenXlsx').disabled = $('btnGenCsv').disabled = false;
  }
}
$('site').oninput = () => { state.site = $('site').value; save(); };
window.addEventListener('beforeunload', e => {
  if (state.pairs.length) { e.preventDefault(); e.returnValue = ''; }
});
load();
boot();
$('fOld').focus();
