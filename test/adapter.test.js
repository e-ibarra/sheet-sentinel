'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./load.js');
const { FakeSpreadsheet } = require('./fakes.js');

function workbook() {
  const ss = new FakeSpreadsheet();
  const shipments = ss.add('Shipments', [
    ['Shipment ID', 'Supplier', 'Incoterm', 'Insurance', 'ETD', 'ETA'],
    ['SH-000001', 'ACME', 'FOB', '', '2026-01-10', '2026-02-01'],
    ['SH-000002', 'Globex', 'CIF', '', '2026-01-10', '2026-01-05'],
    ['SH-000001', 'ACME', 'XYZ', '', '', ''],
    ['', '', '', '', '', '']
  ]);
  ss.add('Suppliers', [['Name'], ['ACME'], ['Initech']]);
  ss.add('Rules', [
    ['Sheet', 'Column', 'Rule', 'Value', 'Severity'],
    ['Shipments', 'Shipment ID', 'required', '', ''],
    ['Shipments', 'Shipment ID', 'unique', '', ''],
    ['Shipments', 'Supplier', 'exists in', 'Suppliers!A2:A', ''],
    ['Shipments', 'Incoterm', 'one of', 'EXW, FOB, CIF, CIP, DAP', ''],
    ['Shipments', 'Insurance', 'required if', 'Incoterm in CIF, CIP', 'warning'],
    ['Shipments', 'ETA', 'after', 'ETD', '']
  ]);
  return { ss, shipments };
}

test('runAll writes an Issues report with links and annotates cells', () => {
  const { ss, shipments } = workbook();
  const out = S.Sentinel.runAll(ss);
  assert.deepEqual(out.configErrors, []);
  const sum = out.results[0].summary;
  assert.equal(out.results[0].sheet, 'Shipments');
  assert.equal(sum.rows, 3, 'empty row not counted');
  assert.equal(sum.rowsWithIssues, 3);
  assert.equal(sum.warnings, 1);

  const issues = ss.getSheetByName('Issues').values;
  assert.deepEqual(issues[0].slice(0, 4), ['Checked at', 'Sheet', 'Row', 'Column']);
  const keys = issues.slice(1).map((r) => `${r[2]}:${r[3]}:${r[5]}`).sort();
  assert.deepEqual(keys, [
    '2:shipment_id:unique', '3:eta:after', '3:insurance:required', '3:supplier:lookup',
    '4:incoterm:oneOf', '4:shipment_id:unique'
  ].sort());
  const link = issues.slice(1).find((r) => r[5] === 'after')[8];
  assert.equal(link, '=HYPERLINK("#gid=7&range=F3","F3")');

  assert.match(shipments.noteAt(3, 2), /^⚠ Sentinel: Supplier "Globex" not found in Suppliers!A2:A$/);
  assert.match(shipments.noteAt(3, 4), /\(warning\) Insurance is required when Incoterm is CIF\/CIP/);
  assert.equal(shipments.noteAt(2, 2), '', 'clean cells stay clean');
});

test('re-running replaces sentinel notes but keeps notes people wrote', () => {
  const { ss, shipments } = workbook();
  shipments.notes[2][1] = 'Call supplier about this one';
  S.Sentinel.runAll(ss);
  assert.equal(shipments.noteAt(3, 2).split('\n').length, 2);

  shipments.values[2][1] = 'Initech'; // fix the data
  S.Sentinel.runAll(ss);
  assert.equal(shipments.noteAt(3, 2), 'Call supplier about this one');
  S.Sentinel.clearNotes(shipments);
  assert.equal(shipments.noteAt(3, 4), '');
  assert.equal(shipments.noteAt(3, 2), 'Call supplier about this one');
});

test('onEdit re-validates only the edited rows and toasts the first error', () => {
  const { ss, shipments } = workbook();
  shipments.values[3][2] = 'DAP'; // fix row 4 incoterm, but it is still a duplicate ID
  const range = shipments.getRange(4, 3, 1, 1);
  S.Sentinel.onEdit({ range });
  assert.equal(shipments.noteWrites.length, 1);
  assert.deepEqual(shipments.noteWrites[0], { row: 4, numRows: 1 });
  assert.match(shipments.noteAt(4, 1), /appears 2 times/);
  assert.equal(shipments.noteAt(4, 3), '');
  assert.equal(ss.toasts.length, 1);
  assert.match(ss.toasts[0], /appears 2 times/);
});

test('onEdit ignores the header row, the Rules tab and sheets without rules', () => {
  const { ss, shipments } = workbook();
  S.Sentinel.onEdit({ range: shipments.getRange(1, 1, 1, 1) });
  S.Sentinel.onEdit({ range: ss.getSheetByName('Rules').getRange(2, 1, 1, 1) });
  S.Sentinel.onEdit({ range: ss.getSheetByName('Suppliers').getRange(2, 1, 1, 1) });
  S.Sentinel.onEdit(undefined);
  assert.equal(shipments.noteWrites.length, 0);
  assert.equal(ss.toasts.length, 0);
});

test('an unresolvable lookup reference is skipped, not flagged on every row', () => {
  const { ss } = workbook();
  ss.getSheetByName('Rules').values[3][3] = 'Missing!A:A';
  const out = S.Sentinel.runAll(ss);
  const rules = ss.getSheetByName('Issues').values.slice(1).map((r) => r[5]);
  assert.ok(!rules.includes('lookup'));
  assert.equal(out.results.length, 1);
});

test('reports a missing target sheet as a configuration error', () => {
  const { ss } = workbook();
  ss.getSheetByName('Rules').values.push(['Nope', 'X', 'required', '', '']);
  const out = S.Sentinel.runAll(ss);
  assert.ok(out.configErrors.includes('Sheet "Nope" not found'));
});

test('helpers: column letters and note stripping', () => {
  assert.equal(S.sentinelColumnLetter(1), 'A');
  assert.equal(S.sentinelColumnLetter(26), 'Z');
  assert.equal(S.sentinelColumnLetter(27), 'AA');
  assert.equal(S.sentinelColumnLetter(703), 'AAA');
  assert.deepEqual(S.sentinelStripNotes([['keep\n⚠ Sentinel: x', '⚠ Sentinel: y', null]]), [['keep', '', '']]);
});
