'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./load.js');

test('parses a Rules tab into per-sheet schemas', () => {
  const { schemas, errors } = S.sentinelParseRules([
    ['Sheet', 'Column', 'Rule', 'Value', 'Severity', 'Message (optional)'],
    ['Shipments', 'Shipment ID', 'required', '', '', ''],
    ['Shipments', 'Shipment ID', 'pattern', '^SH-\\d{6}$', 'error', 'Use SH-123456'],
    ['Shipments', 'Incoterm', 'one of', 'EXW, FOB; CIF|DAP', '', ''],
    ['Shipments', 'Insurance', 'required if', 'Incoterm in CIF, CIP', 'warning', ''],
    ['Shipments', 'ETA', 'after', 'ETD', '', ''],
    ['Shipments', 'FOB', 'min', '1.000,50', '', ''],
    ['Shipments', 'Supplier', 'exists in', 'Suppliers!A2:A', '', ''],
    ['Shipments', '*', 'unique key', 'Invoice, Line', '', ''],
    ['Contacts', 'Email', 'type', 'email', 'warning', ''],
    ['', '', '', '', '', '']
  ]);
  assert.deepEqual(errors, []);
  const sh = schemas.Shipments;
  assert.equal(sh.columns.shipment_id.required, true);
  assert.equal(sh.columns.shipment_id.pattern, '^SH-\\d{6}$');
  assert.equal(sh.columns.shipment_id.message, 'Use SH-123456');
  assert.deepEqual(sh.columns.incoterm.oneOf, ['EXW', 'FOB', 'CIF', 'DAP']);
  assert.deepEqual(sh.columns.insurance.requiredIf, { column: 'Incoterm', in: ['CIF', 'CIP'] });
  assert.equal(sh.columns.insurance.severity, 'warning');
  assert.equal(sh.columns.eta.after, 'etd');
  assert.equal(sh.columns.fob.min, 1000.5);
  assert.equal(sh.columns.supplier.lookup, 'Suppliers!A2:A');
  assert.deepEqual(sh.uniqueKey, ['Invoice', 'Line']);
  assert.equal(schemas.Contacts.columns.email.type, 'email');
  assert.deepEqual(S.sentinelLookupRefs(sh), ['Suppliers!A2:A']);
});

test('accepts Spanish headers, rule names and types', () => {
  const { schemas, errors } = S.sentinelParseRules([
    ['Hoja', 'Columna', 'Regla', 'Valor', 'Severidad', 'Mensaje'],
    ['Embarques', 'Despacho', 'Obligatorio', '', 'Advertencia', ''],
    ['Embarques', 'Fecha llegada', 'Después de', 'Fecha salida', '', ''],
    ['Embarques', 'Monto', 'tipo', 'Número', '', ''],
    ['Embarques', 'Proveedor', 'existe en', 'Proveedores!A:A', '', ''],
    ['Embarques', 'Seguro', 'obligatorio si', 'Incoterm en CIF, CIP', '', ''],
    ['Embarques', 'Legajo', 'único', '', '', '']
  ]);
  assert.deepEqual(errors, []);
  const c = schemas.Embarques.columns;
  assert.equal(c.despacho.required, true);
  assert.equal(c.despacho.severity, 'warning');
  assert.equal(c.fecha_llegada.after, 'fecha_salida');
  assert.equal(c.monto.type, 'number');
  assert.equal(c.proveedor.lookup, 'Proveedores!A:A');
  assert.deepEqual(c.seguro.requiredIf.in, ['CIF', 'CIP']);
  assert.equal(c.legajo.unique, true);
});

test('reports configuration mistakes with row numbers instead of failing', () => {
  const { errors } = S.sentinelParseRules([
    ['Sheet', 'Column', 'Rule', 'Value'],
    ['S', 'A', 'mandatory-ish', ''],
    ['S', 'B', 'type', 'colour'],
    ['S', 'C', 'pattern', '(unclosed'],
    ['S', 'D', 'max length', 'ten'],
    ['S', '', 'required', '']
  ]);
  assert.equal(errors.length, 5);
  assert.match(errors[0], /Row 2: unknown rule/);
  assert.match(errors[1], /Row 3: unknown type "colour"/);
  assert.match(errors[2], /Row 4: invalid pattern/);
  assert.match(errors[3], /Row 5: maxLength needs a number/);
  assert.match(errors[4], /Row 6: missing column name/);
});

test('requiredIf supports equality and not-blank conditions', () => {
  const { schemas } = S.sentinelParseRules([
    ['Column', 'Rule', 'Value'],
    ['Container', 'required if', 'Mode = Sea'],
    ['AWB', 'required if', 'Air reference']
  ]);
  assert.deepEqual(schemas['*'].columns.container.requiredIf, { column: 'Mode', equals: 'Sea' });
  assert.deepEqual(schemas['*'].columns.awb.requiredIf, { column: 'Air reference', notBlank: true });
});

test('needs Column and Rule headers', () => {
  assert.match(S.sentinelParseRules([['Foo', 'Bar'], ['x', 'y']]).errors[0], /needs at least/);
  assert.match(S.sentinelParseRules([]).errors[0], /empty/);
});
