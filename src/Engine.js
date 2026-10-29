/**
 * sheet-sentinel — validation engine.
 *
 * Pure functions over plain row objects, so it runs identically in Apps
 * Script and in Node. Apps Script shares one global scope across files:
 * names here are prefixed `Sentinel*` to avoid collisions.
 */

/**
 * @typedef {Object} Issue
 * @property {number} row        1-based sheet row number
 * @property {string} column     column key (normalized header) or '*' for row rules
 * @property {string} rule
 * @property {'error'|'warning'} severity
 * @property {string} message
 * @property {*} value
 */

/** "Shipment ID " -> "shipment_id" */
function sentinelNormalizeKey(header) {
  return String(header == null ? '' : header)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents: "Código" -> "Codigo"
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sentinelIsBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * Parse numbers the way people type them in Spanish- and English-locale
 * sheets: 1234.5, "1,234.50", "1.234,50", "USD 1.234", "12%".
 * @returns {number|null}
 */
function sentinelToNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  var s = v.trim().replace(/^[A-Za-z$€£\s]+/, '').replace(/\s/g, '');
  var pct = /%$/.test(s);
  if (pct) s = s.slice(0, -1);
  if (!s) return null;
  var lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    // the right-most separator is the decimal one
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // "1,5" decimal vs "1,234" thousands: three digits after a single comma = thousands
    var parts = s.split(',');
    s = (parts.length === 2 && parts[1].length !== 3) ? parts.join('.') : parts.join('');
  } else if (lastDot !== -1) {
    var dparts = s.split('.');
    if (dparts.length > 2) s = dparts.join(''); // "1.234.567"
  }
  if (!/^[-+]?\d*\.?\d+$/.test(s)) return null;
  var n = Number(s);
  return pct ? n / 100 : n;
}

/**
 * Accepts Date objects (what Sheets returns for date cells), ISO strings,
 * and dd/mm/yyyy (the Argentine/European convention).
 * @returns {Date|null}
 */
function sentinelToDate(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  var s = v.trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) {
    var iso = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
    return iso.getMonth() === Number(m[2]) - 1 ? iso : null;
  }
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    var d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return (d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[1])) ? d : null;
  }
  return null;
}

var SENTINEL_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
var SENTINEL_URL = /^https?:\/\/[^\s.]+\.[^\s]{2,}$/i;

/** Type checkers: return true when the value matches the type. */
var SentinelTypes = {
  text: function (v) { return typeof v === 'string' || typeof v === 'number'; },
  number: function (v) { return sentinelToNumber(v) !== null; },
  integer: function (v) { var n = sentinelToNumber(v); return n !== null && Math.floor(n) === n; },
  date: function (v) { return sentinelToDate(v) !== null; },
  email: function (v) { return typeof v === 'string' && SENTINEL_EMAIL.test(v.trim()); },
  url: function (v) { return typeof v === 'string' && SENTINEL_URL.test(v.trim()); },
  boolean: function (v) {
    return typeof v === 'boolean' || /^(true|false|yes|no|si|sí|1|0)$/i.test(String(v).trim());
  }
};

function sentinelFormat(v) {
  if (v instanceof Date) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  return String(v);
}

function sentinelCompare(a, b) {
  var da = a instanceof Date ? a : null, db = b instanceof Date ? b : null;
  if (da && db) return da.getTime() - db.getTime();
  return a - b;
}

/**
 * Coerce a value to the column's declared type for comparisons
 * (min/max/after/before). Falls back to number, then date.
 */
function sentinelCoerce(v, type) {
  if (type === 'date') return sentinelToDate(v);
  if (type === 'number' || type === 'integer') return sentinelToNumber(v);
  var n = sentinelToNumber(v);
  if (n !== null) return n;
  return sentinelToDate(v);
}

function sentinelConditionMet(row, cond) {
  if (!cond) return true;
  var key = sentinelNormalizeKey(cond.column);
  var val = row[key];
  if (cond.in) {
    var opts = cond.in.map(function (o) { return String(o).trim().toLowerCase(); });
    return !sentinelIsBlank(val) && opts.indexOf(String(val).trim().toLowerCase()) !== -1;
  }
  if (cond.notBlank) return !sentinelIsBlank(val);
  if (cond.equals !== undefined) return String(val).trim().toLowerCase() === String(cond.equals).trim().toLowerCase();
  return true;
}

/**
 * Validate rows against a schema.
 *
 * @param {Array<Object>} rows      objects keyed by normalized header
 * @param {Object} schema
 * @param {Object<string,Object>} schema.columns   rules per column (see README)
 * @param {Array<Object>} [schema.rowRules]       {name, test(row), message, columns, severity}
 * @param {Array<string>} [schema.uniqueKey]      composite key that must be unique per row
 * @param {Object} [opts]
 * @param {number} [opts.firstRow=2]              sheet row number of rows[0]
 * @param {Object<string,Array>} [opts.lookups]   values for `lookup` rules, keyed by lookup name
 * @param {Array<Object>} [opts.allRows]          full data set when validating a subset (for unique checks)
 * @returns {Array<Issue>}
 */
function sentinelValidate(rows, schema, opts) {
  var o = opts || {};
  var firstRow = o.firstRow || 2;
  var lookups = o.lookups || {};
  var issues = [];
  var columns = {};
  Object.keys(schema.columns || {}).forEach(function (k) { columns[sentinelNormalizeKey(k)] = schema.columns[k]; });

  // Pre-compute duplicate counts for `unique` columns over the full data set.
  var population = o.allRows || rows;
  var counts = {};
  Object.keys(columns).forEach(function (key) {
    if (!columns[key].unique) return;
    var c = {};
    population.forEach(function (r) {
      var v = r[key];
      if (sentinelIsBlank(v)) return;
      var norm = String(v).trim().toLowerCase();
      c[norm] = (c[norm] || 0) + 1;
    });
    counts[key] = c;
  });
  var compositeCounts = null;
  if (schema.uniqueKey && schema.uniqueKey.length) {
    var keys = schema.uniqueKey.map(sentinelNormalizeKey);
    compositeCounts = {};
    population.forEach(function (r) {
      var k = keys.map(function (x) { return String(r[x] == null ? '' : r[x]).trim().toLowerCase(); }).join('\u0001');
      compositeCounts[k] = (compositeCounts[k] || 0) + 1;
    });
  }
  var lookupSets = {};
  Object.keys(lookups).forEach(function (name) {
    var set = {};
    (lookups[name] || []).forEach(function (v) { if (!sentinelIsBlank(v)) set[String(v).trim().toLowerCase()] = true; });
    lookupSets[name] = set;
  });

  rows.forEach(function (row, i) {
    var rowNum = (row.__row) || (firstRow + i);
    if (Object.keys(row).every(function (k) { return k === '__row' || sentinelIsBlank(row[k]); })) return; // skip empty rows

    function add(column, rule, message, value, severity) {
      issues.push({ row: rowNum, column: column, rule: rule, severity: severity || 'error', message: message, value: value });
    }

    Object.keys(columns).forEach(function (key) {
      var r = columns[key];
      var v = row[key];
      var sev = r.severity || 'error';
      var label = r.label || key;
      var custom = function (fallback) { return r.message || fallback; };

      var requiredNow = r.required === true || (r.requiredIf && sentinelConditionMet(row, r.requiredIf));
      if (sentinelIsBlank(v)) {
        if (requiredNow) {
          var why = r.requiredIf ? ' when ' + r.requiredIf.column + ' is ' + (r.requiredIf.in ? r.requiredIf.in.join('/') : 'set') : '';
          add(key, 'required', custom(label + ' is required' + why), v, sev);
        }
        return; // nothing else to check on a blank cell
      }

      if (r.type && SentinelTypes[r.type] && !SentinelTypes[r.type](v)) {
        add(key, 'type', custom(label + ' should be a valid ' + r.type + ' (got "' + sentinelFormat(v) + '")'), v, sev);
        return; // other checks are meaningless on the wrong type
      }

      var cv = sentinelCoerce(v, r.type);
      if (r.min !== undefined && cv !== null && sentinelCompare(cv, sentinelCoerce(r.min, r.type)) < 0) {
        add(key, 'min', custom(label + ' must be at least ' + sentinelFormat(r.min)), v, sev);
      }
      if (r.max !== undefined && cv !== null && sentinelCompare(cv, sentinelCoerce(r.max, r.type)) > 0) {
        add(key, 'max', custom(label + ' must be at most ' + sentinelFormat(r.max)), v, sev);
      }
      var str = String(v).trim();
      if (r.minLength !== undefined && str.length < r.minLength) {
        add(key, 'minLength', custom(label + ' must have at least ' + r.minLength + ' characters'), v, sev);
      }
      if (r.maxLength !== undefined && str.length > r.maxLength) {
        add(key, 'maxLength', custom(label + ' must have at most ' + r.maxLength + ' characters'), v, sev);
      }
      if (r.pattern) {
        var re = r.pattern instanceof RegExp ? r.pattern : new RegExp(r.pattern);
        if (!re.test(str)) add(key, 'pattern', custom(label + ' has an invalid format ("' + str + '")'), v, sev);
      }
      if (r.oneOf) {
        var allowed = r.oneOf.map(function (x) { return String(x).trim().toLowerCase(); });
        if (allowed.indexOf(str.toLowerCase()) === -1) {
          add(key, 'oneOf', custom(label + ' must be one of: ' + r.oneOf.join(', ')), v, sev);
        }
      }
      if (r.unique && counts[key] && counts[key][str.toLowerCase()] > 1) {
        add(key, 'unique', custom(label + ' "' + str + '" appears ' + counts[key][str.toLowerCase()] + ' times'), v, sev);
      }
      if (r.lookup) {
        var set = lookupSets[r.lookup];
        if (set && !set[str.toLowerCase()]) {
          add(key, 'lookup', custom(label + ' "' + str + '" not found in ' + r.lookup), v, sev);
        }
      }
      ['after', 'before', 'gte', 'lte'].forEach(function (op) {
        if (!r[op]) return;
        var otherKey = sentinelNormalizeKey(r[op]);
        var other = row[otherKey];
        if (sentinelIsBlank(other)) return;
        var a = cv, b = sentinelCoerce(other, r.type);
        if (a === null || b === null) return;
        var d = sentinelCompare(a, b);
        var bad = (op === 'after' && d <= 0) || (op === 'before' && d >= 0) || (op === 'gte' && d < 0) || (op === 'lte' && d > 0);
        var words = { after: 'after', before: 'before', gte: 'greater than or equal to', lte: 'less than or equal to' };
        if (bad) add(key, op, custom(label + ' must be ' + words[op] + ' ' + otherKey + ' (' + sentinelFormat(other) + ')'), v, sev);
      });
      if (typeof r.custom === 'function') {
        var res = r.custom(v, row);
        if (res !== true && res !== undefined && res !== null) {
          add(key, 'custom', typeof res === 'string' ? res : custom(label + ' failed a custom check'), v, sev);
        }
      }
    });

    if (compositeCounts) {
      var ck = schema.uniqueKey.map(sentinelNormalizeKey)
        .map(function (x) { return String(row[x] == null ? '' : row[x]).trim().toLowerCase(); }).join('\u0001');
      if (compositeCounts[ck] > 1) {
        add('*', 'uniqueKey', 'Duplicate row for (' + schema.uniqueKey.join(', ') + ')', null, 'error');
      }
    }

    (schema.rowRules || []).forEach(function (rr) {
      var ok;
      try { ok = rr.test(row); } catch (e) { ok = false; }
      if (!ok) {
        var col = rr.columns && rr.columns.length ? sentinelNormalizeKey(rr.columns[0]) : '*';
        add(col, rr.name || 'rowRule', rr.message || ('Row rule failed: ' + (rr.name || '')), col === '*' ? null : row[col], rr.severity || 'error');
      }
    });
  });

  return issues;
}

/**
 * Turn 2D sheet values into row objects keyed by normalized header.
 * @param {Array<Array>} values including the header row
 * @param {number} headerRow 1-based
 */
function sentinelRowsFromValues(values, headerRow) {
  var h = (headerRow || 1) - 1;
  var headers = (values[h] || []).map(sentinelNormalizeKey);
  var rows = [];
  for (var i = h + 1; i < values.length; i++) {
    var obj = { __row: i + 1 };
    for (var c = 0; c < headers.length; c++) if (headers[c]) obj[headers[c]] = values[i][c];
    rows.push(obj);
  }
  return { headers: headers, rows: rows };
}

/** Summary numbers for a dashboard cell or an email. */
function sentinelSummarize(issues, totalRows) {
  var badRows = {};
  var byRule = {};
  var errors = 0, warnings = 0;
  issues.forEach(function (i) {
    badRows[i.row] = true;
    byRule[i.rule] = (byRule[i.rule] || 0) + 1;
    if (i.severity === 'warning') warnings++; else errors++;
  });
  var bad = Object.keys(badRows).length;
  return {
    rows: totalRows,
    rowsWithIssues: bad,
    errors: errors,
    warnings: warnings,
    healthPercent: totalRows ? Math.round(((totalRows - bad) / totalRows) * 1000) / 10 : 100,
    byRule: byRule
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sentinelNormalizeKey: sentinelNormalizeKey,
    sentinelToNumber: sentinelToNumber,
    sentinelToDate: sentinelToDate,
    sentinelValidate: sentinelValidate,
    sentinelRowsFromValues: sentinelRowsFromValues,
    sentinelSummarize: sentinelSummarize,
    SentinelTypes: SentinelTypes,
    sentinelIsBlank: sentinelIsBlank
  };
}
