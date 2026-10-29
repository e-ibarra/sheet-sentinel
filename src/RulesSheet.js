/**
 * Parse a no-code "Rules" tab into a sentinel schema, so people who never
 * open the script editor can maintain validations.
 *
 *   | Sheet     | Column       | Rule        | Value                | Severity | Message (optional)        |
 *   | Shipments | Shipment ID  | required    |                      | error    |                           |
 *   | Shipments | Shipment ID  | pattern     | ^SH-\d{6}$           | error    | Use SH-123456             |
 *   | Shipments | Incoterm     | one of      | EXW, FOB, CIF, DAP   |          |                           |
 *   | Shipments | Insurance    | required if | Incoterm in CIF, CIP | warning  |                           |
 *   | Shipments | ETA          | after       | ETD                  |          |                           |
 *   | Shipments | Supplier     | exists in   | Suppliers!A2:A       |          |                           |
 *   | Shipments | *            | unique key  | Invoice, Line        |          |                           |
 *
 * Rule names are case-insensitive and also accepted in Spanish
 * (obligatorio, tipo, mínimo, uno de, único, después de, existe en...).
 */

var SENTINEL_RULE_ALIASES = {
  required: 'required', obligatorio: 'required', requerido: 'required',
  'required if': 'requiredIf', 'obligatorio si': 'requiredIf', 'requerido si': 'requiredIf',
  type: 'type', tipo: 'type',
  min: 'min', minimum: 'min', minimo: 'min',
  max: 'max', maximum: 'max', maximo: 'max',
  'min length': 'minLength', 'longitud minima': 'minLength',
  'max length': 'maxLength', 'longitud maxima': 'maxLength',
  pattern: 'pattern', regex: 'pattern', formato: 'pattern', patron: 'pattern',
  'one of': 'oneOf', 'uno de': 'oneOf', 'valores': 'oneOf', 'lista': 'oneOf',
  unique: 'unique', unico: 'unique', 'sin duplicados': 'unique',
  'unique key': 'uniqueKey', 'clave unica': 'uniqueKey',
  after: 'after', 'despues de': 'after', 'posterior a': 'after',
  before: 'before', 'antes de': 'before', 'anterior a': 'before',
  gte: 'gte', '>=': 'gte', 'mayor o igual a': 'gte',
  lte: 'lte', '<=': 'lte', 'menor o igual a': 'lte',
  'exists in': 'lookup', lookup: 'lookup', 'existe en': 'lookup'
};

var SENTINEL_TYPE_ALIASES = {
  text: 'text', texto: 'text',
  number: 'number', numero: 'number', 'número': 'number',
  integer: 'integer', entero: 'integer',
  date: 'date', fecha: 'date',
  email: 'email', mail: 'email', correo: 'email',
  url: 'url', link: 'url',
  boolean: 'boolean', booleano: 'boolean', 'si/no': 'boolean'
};

function sentinelPlain(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

function sentinelSplitList(v) {
  return String(v).split(/[,;|]/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
}

/**
 * @param {Array<Array>} values rows of the Rules tab, header first
 * @returns {{schemas: Object<string,Object>, errors: Array<string>}} one schema per sheet name
 */
function sentinelParseRules(values) {
  var schemas = {};
  var errors = [];
  if (!values || values.length < 2) return { schemas: schemas, errors: ['Rules tab is empty'] };
  var header = values[0].map(sentinelPlain);
  function idx(names) {
    for (var i = 0; i < names.length; i++) { var p = header.indexOf(names[i]); if (p !== -1) return p; }
    return -1;
  }
  var cSheet = idx(['sheet', 'hoja', 'tab', 'pestana']);
  var cCol = idx(['column', 'columna', 'field', 'campo']);
  var cRule = idx(['rule', 'regla']);
  var cVal = idx(['value', 'valor', 'parameter', 'parametro']);
  var cSev = idx(['severity', 'severidad', 'nivel']);
  var cMsg = idx(['message', 'mensaje', 'message (optional)', 'mensaje (opcional)']);
  if (cCol === -1 || cRule === -1) {
    return { schemas: schemas, errors: ['Rules tab needs at least "Column" and "Rule" headers'] };
  }

  for (var r = 1; r < values.length; r++) {
    var line = values[r];
    var rowNo = r + 1;
    var col = String(line[cCol] == null ? '' : line[cCol]).trim();
    var ruleRaw = sentinelPlain(line[cRule]);
    if (!col && !ruleRaw) continue;
    var sheetName = cSheet === -1 ? '*' : (String(line[cSheet] || '').trim() || '*');
    var value = cVal === -1 ? '' : line[cVal];
    var sev = cSev === -1 ? '' : sentinelPlain(line[cSev]);
    sev = (sev === 'warning' || sev === 'advertencia' || sev === 'aviso') ? 'warning' : 'error';
    var msg = cMsg === -1 ? '' : String(line[cMsg] || '').trim();

    var rule = SENTINEL_RULE_ALIASES[ruleRaw];
    if (!rule) { errors.push('Row ' + rowNo + ': unknown rule "' + line[cRule] + '"'); continue; }

    var schema = schemas[sheetName] || (schemas[sheetName] = { columns: {}, rowRules: [] });

    if (rule === 'uniqueKey') {
      schema.uniqueKey = sentinelSplitList(value);
      continue;
    }
    var key = sentinelNormalizeKey(col);
    if (!key) { errors.push('Row ' + rowNo + ': missing column name'); continue; }
    var c = schema.columns[key] || (schema.columns[key] = { label: col });
    if (sev === 'warning') c.severity = 'warning';
    if (msg) c.message = msg;

    switch (rule) {
      case 'required': c.required = true; break;
      case 'unique': c.unique = true; break;
      case 'type':
        var t = SENTINEL_TYPE_ALIASES[sentinelPlain(value)];
        if (!t) { errors.push('Row ' + rowNo + ': unknown type "' + value + '"'); break; }
        c.type = t; break;
      case 'min': case 'max':
        c[rule] = (typeof value === 'number' || value instanceof Date) ? value
          : (sentinelToNumber(value) !== null ? sentinelToNumber(value) : (sentinelToDate(value) || value));
        break;
      case 'minLength': case 'maxLength':
        var n = sentinelToNumber(value);
        if (n === null) { errors.push('Row ' + rowNo + ': ' + rule + ' needs a number'); break; }
        c[rule] = n; break;
      case 'pattern':
        try { new RegExp(String(value)); c.pattern = String(value); }
        catch (e) { errors.push('Row ' + rowNo + ': invalid pattern ' + value); }
        break;
      case 'oneOf': c.oneOf = sentinelSplitList(value); break;
      case 'after': case 'before': case 'gte': case 'lte':
        c[rule] = sentinelNormalizeKey(value); break;
      case 'lookup': c.lookup = String(value).trim(); break;
      case 'requiredIf':
        // "Incoterm in CIF, CIP" | "Incoterm = CIF" | "Incoterm" (not blank)
        var s = String(value).trim();
        var m = s.match(/^(.+?)\s+(?:in|en)\s+(.+)$/i);
        if (m) c.requiredIf = { column: m[1].trim(), in: sentinelSplitList(m[2]) };
        else if ((m = s.match(/^(.+?)\s*=\s*(.+)$/))) c.requiredIf = { column: m[1].trim(), equals: m[2].trim() };
        else if (s) c.requiredIf = { column: s, notBlank: true };
        else errors.push('Row ' + rowNo + ': "required if" needs a condition, e.g. "Incoterm in CIF, CIP"');
        break;
    }
  }
  return { schemas: schemas, errors: errors };
}

/** Lookup names referenced by a schema (e.g. "Suppliers!A2:A"). */
function sentinelLookupRefs(schema) {
  var refs = {};
  Object.keys(schema.columns || {}).forEach(function (k) {
    if (schema.columns[k].lookup) refs[schema.columns[k].lookup] = true;
  });
  return Object.keys(refs);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sentinelParseRules: sentinelParseRules, sentinelLookupRefs: sentinelLookupRefs };
}
