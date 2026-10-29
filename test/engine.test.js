'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./load.js');

const rowsOf = (values) => S.sentinelRowsFromValues(values, 1).rows;
const rulesOf = (issues) => issues.map((i) => `${i.row}:${i.column}:${i.rule}`);

test('normalizes headers, including accents and symbols', () => {
  assert.equal(S.sentinelNormalizeKey(' Shipment ID '), 'shipment_id');
  assert.equal(S.sentinelNormalizeKey('Código NCM'), 'codigo_ncm');
  assert.equal(S.sentinelNormalizeKey('FOB (USD)'), 'fob_usd');
});

test('parses numbers typed in Spanish and English locales', () => {
  const cases = [
    [1234.5, 1234.5], ['1234.5', 1234.5], ['1,234.50', 1234.5], ['1.234,50', 1234.5],
    ['1.234.567', 1234567], ['1,5', 1.5], ['1,234', 1234], ['USD 1.200', 1.2], ['$ 1.200,00', 1200],
    ['12%', 0.12], ['-3', -3], ['abc', null], ['', null], [null, null], [NaN, null]
  ];
  for (const [input, expected] of cases) assert.equal(S.sentinelToNumber(input), expected, `input ${JSON.stringify(input)}`);
});

test('parses dates as Date, ISO and dd/mm/yyyy, rejecting impossible ones', () => {
  const d = S.sentinelToDate('31/12/2026');
  assert.equal(d.getFullYear(), 2026); assert.equal(d.getMonth(), 11); assert.equal(d.getDate(), 31);
  assert.ok(S.sentinelToDate('2026-02-28'));
  assert.equal(S.sentinelToDate('2026-02-30'), null);
  assert.equal(S.sentinelToDate('31/02/2026'), null);
  assert.equal(S.sentinelToDate('soon'), null);
  assert.ok(S.sentinelToDate(new Date(2026, 0, 1)));
});

test('flags required, type, range, pattern and list violations', () => {
  const rows = rowsOf([
    ['ID', 'Email', 'Qty', 'Incoterm', 'Code'],
    ['A1', 'ok@example.com', 5, 'FOB', 'SH-000001'],
    ['', 'not-an-email', -1, 'XYZ', 'sh-1'],
    ['A3', '', 'many', 'cif', 'SH-000003']
  ]);
  const issues = S.sentinelValidate(rows, {
    columns: {
      ID: { required: true },
      Email: { type: 'email' },
      Qty: { type: 'number', min: 0 },
      Incoterm: { oneOf: ['EXW', 'FOB', 'CIF'] },
      Code: { pattern: '^SH-\\d{6}$' }
    }
  });
  assert.deepEqual(rulesOf(issues).sort(), [
    '3:code:pattern', '3:email:type', '3:id:required', '3:incoterm:oneOf', '3:qty:min', '4:qty:type'
  ].sort());
  assert.ok(issues.find((i) => i.rule === 'oneOf').message.includes('EXW, FOB, CIF'));
});

test('oneOf is case-insensitive and blank optional cells are ignored', () => {
  const rows = rowsOf([['Incoterm'], ['cif'], ['']]);
  assert.deepEqual(S.sentinelValidate(rows, { columns: { incoterm: { oneOf: ['CIF'] } } }), []);
});

test('detects duplicates and composite-key duplicates', () => {
  const rows = rowsOf([
    ['Invoice', 'Line', 'SKU'],
    ['F-1', 1, 'A'], ['F-1', 2, 'A'], ['f-1 ', 1, 'B'], ['F-2', 1, 'C']
  ]);
  const issues = S.sentinelValidate(rows, { columns: { sku: { unique: true } }, uniqueKey: ['Invoice', 'Line'] });
  assert.deepEqual(rulesOf(issues).sort(), ['2:*:uniqueKey', '2:sku:unique', '3:sku:unique', '4:*:uniqueKey'].sort());
  assert.match(issues.find((i) => i.rule === 'unique').message, /appears 2 times/);
});

test('cross-column date and number comparisons', () => {
  const rows = rowsOf([
    ['ETD', 'ETA', 'FOB', 'CIF'],
    [new Date(2026, 0, 10), new Date(2026, 0, 30), 100, 120],
    ['20/01/2026', '15/01/2026', 100, 90],
    ['2026-03-01', '2026-03-01', 100, 100]
  ]);
  const issues = S.sentinelValidate(rows, {
    columns: { ETA: { type: 'date', after: 'ETD' }, CIF: { type: 'number', gte: 'FOB' } }
  });
  assert.deepEqual(rulesOf(issues).sort(), ['3:cif:gte', '3:eta:after', '4:eta:after'].sort());
});

test('requiredIf only applies when the condition holds', () => {
  const rows = rowsOf([
    ['Incoterm', 'Insurance'],
    ['CIF', ''], ['FOB', ''], ['cip', 50]
  ]);
  const issues = S.sentinelValidate(rows, {
    columns: { insurance: { requiredIf: { column: 'Incoterm', in: ['CIF', 'CIP'] } } }
  });
  assert.deepEqual(rulesOf(issues), ['2:insurance:required']);
  assert.match(issues[0].message, /when Incoterm is CIF\/CIP/);
});

test('lookup checks values exist in another list', () => {
  const rows = rowsOf([['Supplier'], ['ACME'], ['Globex'], ['acme ']]);
  const issues = S.sentinelValidate(rows, { columns: { supplier: { lookup: 'Suppliers!A2:A' } } },
    { lookups: { 'Suppliers!A2:A': ['ACME', 'Initech', ''] } });
  assert.deepEqual(rulesOf(issues), ['3:supplier:lookup']);
});

test('row rules, custom checks, severities and custom messages', () => {
  const rows = rowsOf([['Qty', 'Unit price', 'Total'], [2, 10, 20], [3, 10, 25]]);
  const issues = S.sentinelValidate(rows, {
    columns: {
      Qty: { custom: (v) => (v > 2 ? 'Qty above 2 needs approval' : true), severity: 'warning' },
      Total: { min: 21, message: 'Order total too low' }
    },
    rowRules: [{ name: 'totalMatches', columns: ['Total'], test: (r) => r.qty * r.unit_price === r.total, message: 'Total != Qty x Unit price' }]
  });
  assert.deepEqual(rulesOf(issues).sort(), ['2:total:min', '3:qty:custom', '3:total:totalMatches'].sort());
  assert.equal(issues.find((i) => i.rule === 'custom').severity, 'warning');
  assert.equal(issues.find((i) => i.rule === 'min').message, 'Order total too low');
});

test('a throwing row rule counts as a failure instead of crashing', () => {
  const rows = rowsOf([['A'], [1]]);
  const issues = S.sentinelValidate(rows, { rowRules: [{ name: 'boom', test: () => { throw new Error('x'); } }] });
  assert.deepEqual(rulesOf(issues), ['2:*:boom']);
});

test('fully empty rows are skipped', () => {
  const rows = rowsOf([['ID', 'Name'], ['', ''], ['1', 'x']]);
  assert.deepEqual(S.sentinelValidate(rows, { columns: { id: { required: true } } }), []);
});

test('validating a subset still detects duplicates against all rows', () => {
  const all = rowsOf([['ID'], ['X'], ['Y'], ['X']]);
  const issues = S.sentinelValidate([all[2]], { columns: { id: { unique: true } } }, { allRows: all });
  assert.deepEqual(rulesOf(issues), ['4:id:unique']);
});

test('summary reports health percentage and counts', () => {
  const s = S.sentinelSummarize([
    { row: 2, rule: 'required', severity: 'error' },
    { row: 2, rule: 'type', severity: 'warning' },
    { row: 5, rule: 'required', severity: 'error' }
  ], 10);
  assert.deepEqual(s, { rows: 10, rowsWithIssues: 2, errors: 2, warnings: 1, healthPercent: 80, byRule: { required: 2, type: 1 } });
});
