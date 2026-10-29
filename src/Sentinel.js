/**
 * sheet-sentinel — Google Sheets adapter and public API.
 *
 * Quick setup (bound script):
 *   function onOpen() { Sentinel.addMenu(); }
 *   function onEdit(e) { Sentinel.onEdit(e); }
 */

var SENTINEL_NOTE_PREFIX = '⚠ Sentinel: ';
var SENTINEL_RULES_TAB = 'Rules';
var SENTINEL_ISSUES_TAB = 'Issues';
var SENTINEL_RULE_NAMES = ['required', 'required if', 'type', 'min', 'max', 'min length', 'max length',
  'pattern', 'one of', 'unique', 'unique key', 'after', 'before', 'gte', 'lte', 'exists in'];

function sentinelColumnLetter(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Remove sentinel lines from existing notes, keeping anything a person wrote.
 * Returns a new 2D array.
 */
function sentinelStripNotes(notes) {
  return notes.map(function (row) {
    return row.map(function (note) {
      if (!note) return '';
      return String(note).split('\n').filter(function (l) { return l.indexOf(SENTINEL_NOTE_PREFIX) !== 0; }).join('\n');
    });
  });
}

var Sentinel = {
  /**
   * Validate one sheet against a schema and annotate it.
   * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
   * @param {Object} schema   see Engine.js
   * @param {Object} [opts]   {headerRow=1, notes=true, issuesTab='Issues', append=false, ss}
   * @returns {{issues: Array, summary: Object}}
   */
  check: function (sheet, schema, opts) {
    var o = opts || {};
    var ss = o.ss || sheet.getParent();
    var headerRow = o.headerRow || 1;
    var data = sheet.getDataRange().getValues();
    var parsed = sentinelRowsFromValues(data, headerRow);
    var lookups = Sentinel.resolveLookups_(ss, schema);
    var issues = sentinelValidate(parsed.rows, schema, { lookups: lookups });
    var dataRows = parsed.rows.filter(function (r) {
      return Object.keys(r).some(function (k) { return k !== '__row' && !sentinelIsBlank(r[k]); });
    }).length;
    var summary = sentinelSummarize(issues, dataRows);

    if (o.notes !== false) Sentinel.annotate_(sheet, parsed.headers, issues, headerRow, data.length);
    if (o.issuesTab !== false) {
      Sentinel.writeIssues_(ss, sheet, parsed.headers, issues, o.issuesTab || SENTINEL_ISSUES_TAB, !!o.append);
    }
    return { issues: issues, summary: summary };
  },

  /**
   * Run every rule in the Rules tab against its sheet(s) and produce one
   * combined Issues report.
   */
  runAll: function (ss) {
    ss = ss || SpreadsheetApp.getActive();
    var rulesSheet = ss.getSheetByName(SENTINEL_RULES_TAB);
    if (!rulesSheet) throw new Error('No "' + SENTINEL_RULES_TAB + '" tab. Use Sentinel ▸ Create Rules tab first.');
    var parsed = sentinelParseRules(rulesSheet.getDataRange().getValues());
    var results = [];
    var first = true;
    Object.keys(parsed.schemas).forEach(function (name) {
      var sheet = name === '*' ? ss.getActiveSheet() : ss.getSheetByName(name);
      if (!sheet) { parsed.errors.push('Sheet "' + name + '" not found'); return; }
      var res = Sentinel.check(sheet, parsed.schemas[name], { ss: ss, append: !first });
      first = false;
      results.push({ sheet: sheet.getName(), summary: res.summary });
    });
    return { results: results, configErrors: parsed.errors };
  },

  /** Menu handler: run all and show a short report. */
  runAllWithReport: function () {
    var ui = SpreadsheetApp.getUi();
    try {
      var out = Sentinel.runAll();
      var lines = out.results.map(function (r) {
        return r.sheet + ': ' + r.summary.healthPercent + '% clean, ' + r.summary.errors + ' errors, ' +
          r.summary.warnings + ' warnings in ' + r.summary.rows + ' rows';
      });
      if (out.configErrors.length) lines.push('', 'Rules tab problems:', out.configErrors.join('\n'));
      ui.alert('Sentinel report', lines.join('\n') || 'No rules defined yet.', ui.ButtonSet.OK);
    } catch (e) {
      ui.alert('Sentinel', String(e.message || e), ui.ButtonSet.OK);
    }
  },

  /**
   * Live validation for simple onEdit triggers: re-checks only the edited
   * rows (uniqueness still compares against the whole sheet) and updates
   * their notes. Cheap enough to run on every edit.
   */
  onEdit: function (e) {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    var ss = sheet.getParent();
    var rulesSheet = ss.getSheetByName(SENTINEL_RULES_TAB);
    if (!rulesSheet || sheet.getName() === SENTINEL_RULES_TAB || sheet.getName() === SENTINEL_ISSUES_TAB) return;
    var parsed = sentinelParseRules(rulesSheet.getDataRange().getValues());
    var schema = parsed.schemas[sheet.getName()];
    if (!schema) return;

    var startRow = e.range.getRow(), numRows = e.range.getNumRows();
    if (startRow + numRows - 1 <= 1) return; // header edit
    var data = sheet.getDataRange().getValues();
    var all = sentinelRowsFromValues(data, 1);
    var edited = all.rows.filter(function (r) { return r.__row >= startRow && r.__row < startRow + numRows; });
    var issues = sentinelValidate(edited, schema, { allRows: all.rows, lookups: Sentinel.resolveLookups_(ss, schema) });
    Sentinel.annotate_(sheet, all.headers, issues, 1, data.length, { from: Math.max(2, startRow), count: numRows });
    var errors = issues.filter(function (i) { return i.severity === 'error'; });
    if (errors.length) ss.toast(errors[0].message + (errors.length > 1 ? ' (+' + (errors.length - 1) + ' more)' : ''), 'Sentinel', 5);
  },

  /** Build a starter Rules tab with headers, examples and a rule dropdown. */
  createRulesTab: function (ss) {
    ss = ss || SpreadsheetApp.getActive();
    if (ss.getSheetByName(SENTINEL_RULES_TAB)) return ss.getSheetByName(SENTINEL_RULES_TAB);
    var target = ss.getActiveSheet().getName();
    var sheet = ss.insertSheet(SENTINEL_RULES_TAB);
    var rows = [
      ['Sheet', 'Column', 'Rule', 'Value', 'Severity', 'Message (optional)'],
      [target, 'ID', 'required', '', 'error', ''],
      [target, 'ID', 'unique', '', 'error', ''],
      [target, 'Email', 'type', 'email', 'warning', ''],
      [target, 'Amount', 'min', 0, 'error', 'Amounts cannot be negative']
    ];
    sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    var ruleRule = SpreadsheetApp.newDataValidation().requireValueInList(SENTINEL_RULE_NAMES, true).setAllowInvalid(true).build();
    sheet.getRange(2, 3, 200, 1).setDataValidation(ruleRule);
    var sevRule = SpreadsheetApp.newDataValidation().requireValueInList(['error', 'warning'], true).build();
    sheet.getRange(2, 5, 200, 1).setDataValidation(sevRule);
    sheet.autoResizeColumns(1, rows[0].length);
    return sheet;
  },

  /** Remove every sentinel note from a sheet (user notes are kept). */
  clearNotes: function (sheet) {
    sheet = sheet || SpreadsheetApp.getActiveSheet();
    var range = sheet.getDataRange();
    range.setNotes(sentinelStripNotes(range.getNotes()));
  },

  addMenu: function () {
    SpreadsheetApp.getUi().createMenu('Sentinel')
      .addItem('Check data now', 'sentinelMenuRun_')
      .addItem('Create Rules tab', 'sentinelMenuCreateRules_')
      .addItem('Clear Sentinel notes', 'sentinelMenuClear_')
      .addToUi();
  },

  // ---- internals -------------------------------------------------------

  resolveLookups_: function (ss, schema) {
    var out = {};
    sentinelLookupRefs(schema).forEach(function (ref) {
      try {
        var values = ss.getRange(ref).getValues();
        out[ref] = [].concat.apply([], values);
      } catch (err) {
        out[ref] = null; // unresolvable reference: skip rather than flag every row
      }
    });
    Object.keys(out).forEach(function (k) { if (out[k] === null) delete out[k]; });
    return out;
  },

  annotate_: function (sheet, headers, issues, headerRow, lastRow, only) {
    var firstData = headerRow + 1;
    var from = only ? only.from : firstData;
    var count = only ? only.count : Math.max(0, lastRow - headerRow);
    if (count <= 0 || headers.length === 0) return;
    var range = sheet.getRange(from, 1, count, headers.length);
    var notes = sentinelStripNotes(range.getNotes());
    issues.forEach(function (i) {
      var r = i.row - from;
      if (r < 0 || r >= count) return;
      var c = i.column === '*' ? 0 : headers.indexOf(i.column);
      if (c < 0) c = 0;
      var line = SENTINEL_NOTE_PREFIX + (i.severity === 'warning' ? '(warning) ' : '') + i.message;
      notes[r][c] = notes[r][c] ? notes[r][c] + '\n' + line : line;
    });
    range.setNotes(notes);
  },

  writeIssues_: function (ss, sheet, headers, issues, tabName, append) {
    var out = ss.getSheetByName(tabName) || ss.insertSheet(tabName);
    var header = ['Checked at', 'Sheet', 'Row', 'Column', 'Severity', 'Rule', 'Message', 'Value', 'Go to'];
    if (!append) {
      out.clearContents();
      out.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
      out.setFrozenRows(1);
    }
    if (!issues.length) return;
    var now = new Date();
    var gid = sheet.getSheetId();
    var rows = issues.map(function (i) {
      var colIdx = i.column === '*' ? 1 : headers.indexOf(i.column) + 1;
      var a1 = sentinelColumnLetter(Math.max(1, colIdx)) + i.row;
      var value = i.value instanceof Date ? i.value : (i.value == null ? '' : String(i.value));
      return [now, sheet.getName(), i.row, i.column, i.severity, i.rule, i.message, value,
        '=HYPERLINK("#gid=' + gid + '&range=' + a1 + '","' + a1 + '")'];
    });
    var start = Math.max(2, out.getLastRow() + 1);
    out.getRange(start, 1, rows.length, header.length).setValues(rows);
  }
};

// Global menu handlers (menus can only call top-level functions).
function sentinelMenuRun_() { Sentinel.runAllWithReport(); }
function sentinelMenuCreateRules_() { Sentinel.createRulesTab(); }
function sentinelMenuClear_() { Sentinel.clearNotes(); }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Sentinel: Sentinel, sentinelStripNotes: sentinelStripNotes, sentinelColumnLetter: sentinelColumnLetter, SENTINEL_NOTE_PREFIX: SENTINEL_NOTE_PREFIX };
}
