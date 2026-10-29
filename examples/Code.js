/**
 * Minimal setup for a Sheets-bound script. Copy the three files in src/
 * plus this file into Extensions ▸ Apps Script, save, and reload the sheet.
 */

function onOpen() {
  Sentinel.addMenu(); // Sentinel ▸ Check data now / Create Rules tab / Clear notes
}

// Simple trigger: validates the rows you just edited, as you type.
function onEdit(e) {
  Sentinel.onEdit(e);
}

/**
 * Nightly check with an email digest. Install once with
 * ScriptApp.newTrigger('nightlyDataCheck').timeBased().everyDays(1).atHour(6).create();
 */
function nightlyDataCheck() {
  var out = Sentinel.runAll(SpreadsheetApp.getActive());
  var bad = out.results.filter(function (r) { return r.summary.errors > 0; });
  if (!bad.length && !out.configErrors.length) return;
  var body = bad.map(function (r) {
    return r.sheet + ': ' + r.summary.errors + ' errors, ' + r.summary.healthPercent + '% of rows clean';
  }).concat(out.configErrors).join('\n');
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'Data check: issues found',
    body + '\n\n' + SpreadsheetApp.getActive().getUrl());
}

/**
 * Developers can skip the Rules tab and define rules in code, including
 * row-level checks that span several columns.
 */
function checkInvoicesInCode() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Invoices');
  var result = Sentinel.check(sheet, {
    columns: {
      'Invoice': { required: true, pattern: '^[A-Z]-\\d{4}-\\d{8}$' },
      'CUIT': { required: true, custom: function (v) { return isValidCuit_(v) || 'Invalid CUIT check digit'; } },
      'Issue date': { type: 'date', required: true },
      'Due date': { type: 'date', after: 'Issue date' },
      'Currency': { oneOf: ['ARS', 'USD', 'EUR'] },
      'Net': { type: 'number', min: 0 },
      'VAT': { type: 'number', min: 0 },
      'Total': { type: 'number' }
    },
    uniqueKey: ['Invoice', 'CUIT'],
    rowRules: [{
      name: 'totalAddsUp',
      columns: ['Total'],
      message: 'Total must equal Net + VAT',
      test: function (r) {
        return Math.abs(sentinelToNumber(r.net) + sentinelToNumber(r.vat) - sentinelToNumber(r.total)) < 0.01;
      }
    }]
  });
  Logger.log(JSON.stringify(result.summary));
}

/** Argentine CUIT/CUIL check digit (mod 11). */
function isValidCuit_(value) {
  var digits = String(value).replace(/\D/g, '');
  if (digits.length !== 11) return false;
  var weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  var sum = 0;
  for (var i = 0; i < 10; i++) sum += Number(digits[i]) * weights[i];
  var check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) return false;
  return check === Number(digits[10]);
}
