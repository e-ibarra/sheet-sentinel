# sheet-sentinel

**Catch bad data in Google Sheets before it reaches a report, an invoice or a customs declaration.**

Shared spreadsheets break in boring ways: a duplicated ID, `1.234,50` typed into a column that expects `1234.50`, an arrival date before the departure date, a supplier that doesn't exist in the master list, CIF shipments missing their insurance amount. Sheets' built-in data validation handles one cell at a time and can't express "required only when Incoterm is CIF" or "must be unique per invoice and line".

`sheet-sentinel` lets the people who own the data write those rules **in a normal tab**, no code required. It then:

- **Flags each problem on the cell itself** as a note, keeping any notes people already wrote.
- **Builds an `Issues` tab** with one row per problem and a clickable link to the cell.
- **Checks rows live as people edit them**, with a toast explaining what's wrong.
- **Reports a health score** per sheet ("96.4% of rows clean"), ready for a nightly email.

## The Rules tab

| Sheet | Column | Rule | Value | Severity | Message (optional) |
| --- | --- | --- | --- | --- | --- |
| Shipments | Shipment ID | required | | error | |
| Shipments | Shipment ID | pattern | `^SH-\d{6}$` | error | Use the format SH-123456 |
| Shipments | Shipment ID | unique | | error | |
| Shipments | Incoterm | one of | EXW, FCA, FOB, CFR, CIF, CPT, CIP, DAP, DPU, DDP | | |
| Shipments | Insurance | required if | Incoterm in CIF, CIP | warning | |
| Shipments | ETA | after | ETD | | |
| Shipments | FOB (USD) | min | 0 | | |
| Shipments | Supplier | exists in | Suppliers!A2:A | | |
| Shipments | * | unique key | Invoice, Line | | |

`Sentinel ▸ Create Rules tab` generates a starter tab with dropdowns for rule names and severities.

Rules, headers and types also work **in Spanish** (`obligatorio`, `obligatorio si`, `uno de`, `único`, `después de`, `existe en`, `tipo: fecha / número`...), so Spanish-speaking teams can use their own words.

### Rules reference

| Rule | Value | Checks |
| --- | --- | --- |
| `required` | | Cell is not blank |
| `required if` | `Col in A, B` · `Col = A` · `Col` | Required only when another column matches / is filled |
| `type` | `text` `number` `integer` `date` `email` `url` `boolean` | Value has that type |
| `min` / `max` | number or date | Range check |
| `min length` / `max length` | number | Text length |
| `pattern` | regular expression | Format (IDs, codes, tax numbers) |
| `one of` | list separated by `,` `;` or `\|` | Allowed values, case-insensitive |
| `unique` | | No duplicates in the column |
| `unique key` | list of columns (Column = `*`) | No duplicate combinations |
| `after` / `before` | other column | Date or number ordering |
| `gte` / `lte` | other column | ≥ / ≤ another column (e.g. CIF ≥ FOB) |
| `exists in` | `Sheet!A2:A` | Value is present in a master list |

**Real-world input is handled:** numbers typed as `1.234,50`, `1,234.50`, `USD 1.200` or `12%`, dates as real date cells, `2026-03-01` or `01/03/2026`, headers with accents and symbols (`Código NCM`, `FOB (USD)`).

## Install

1. Open your spreadsheet → **Extensions ▸ Apps Script**.
2. Create files with the contents of `src/Engine.js`, `src/RulesSheet.js` and `src/Sentinel.js` (or `clasp push`).
3. Add [`examples/Code.js`](examples/Code.js), which wires up the menu and live checks:

```js
function onOpen() { Sentinel.addMenu(); }
function onEdit(e) { Sentinel.onEdit(e); }
```

4. Reload the sheet → **Sentinel ▸ Create Rules tab** → edit the rules → **Sentinel ▸ Check data now**.

## For developers

Define rules in code, including cross-column row rules and custom checks:

```js
Sentinel.check(sheet, {
  columns: {
    'Invoice':   { required: true, pattern: '^[A-Z]-\\d{4}-\\d{8}$' },
    'CUIT':      { required: true, custom: v => isValidCuit_(v) || 'Invalid CUIT check digit' },
    'Due date':  { type: 'date', after: 'Issue date' },
    'Currency':  { oneOf: ['ARS', 'USD', 'EUR'] }
  },
  uniqueKey: ['Invoice', 'CUIT'],
  rowRules: [{ name: 'totalAddsUp', columns: ['Total'], message: 'Total must equal Net + VAT',
               test: r => Math.abs(r.net + r.vat - r.total) < 0.01 }]
});
```

The engine (`sentinelValidate(rows, schema)`) is a pure function over row objects with no Apps Script dependency, so it can also validate data from an API or a CSV before it is written to a sheet.

## Design notes

- **One read, one write.** Validation reads the data range once and writes notes with a single `setNotes()` call; Apps Script round-trips are the main cost, not the checks.
- **Live checks stay cheap.** `onEdit` re-validates only the edited rows, while uniqueness is still compared against the whole sheet.
- **Never destroys work.** It doesn't touch values or formatting, and sentinel notes are prefixed so they can be removed without deleting human notes.
- **Configuration errors are reported, not thrown.** An unknown rule or a broken regex in row 14 of the Rules tab produces a readable message instead of a stack trace.
- **Tested.** 26 tests run in Node against an in-memory spreadsheet: `npm test`.

## License

MIT
