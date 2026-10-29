'use strict';
// Minimal in-memory Spreadsheet/Sheet/Range covering what the adapter uses.

function a1ToRC(a1) {
  const m = a1.match(/^([A-Z]+)(\d+)?$/);
  if (!m) throw new Error('Bad A1: ' + a1);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: m[2] ? Number(m[2]) : null };
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) { Object.assign(this, { sheet, row, col, numRows, numCols }); }
  getRow() { return this.row; }
  getNumRows() { return this.numRows; }
  getSheet() { return this.sheet; }
  getValues() { return this.sheet.read('values', this); }
  setValues(v) { this.sheet.write('values', this, v); return this; }
  getNotes() { return this.sheet.read('notes', this); }
  setNotes(v) { this.sheet.write('notes', this, v); return this; }
  setFontWeight() { return this; }
  setDataValidation() { return this; }
}

class FakeSheet {
  constructor(ss, name, values = [], id = 0) {
    this.ss = ss; this.name = name; this.id = id;
    this.values = values.map((r) => r.slice());
    this.notes = values.map((r) => r.map(() => ''));
    this.noteWrites = [];
  }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  getParent() { return this.ss; }
  getLastRow() { return this.values.length; }
  getLastColumn() { return Math.max(0, ...this.values.map((r) => r.length)); }
  getDataRange() { return new FakeRange(this, 1, 1, this.getLastRow(), this.getLastColumn()); }
  getRange(row, col, numRows = 1, numCols = 1) { return new FakeRange(this, row, col, numRows, numCols); }
  ensure(rows, cols) {
    for (const grid of ['values', 'notes']) {
      while (this[grid].length < rows) this[grid].push([]);
      for (const r of this[grid]) while (r.length < cols) r.push('');
    }
  }
  read(grid, rg) {
    this.ensure(rg.row + rg.numRows - 1, rg.col + rg.numCols - 1);
    return this[grid].slice(rg.row - 1, rg.row - 1 + rg.numRows).map((r) => r.slice(rg.col - 1, rg.col - 1 + rg.numCols));
  }
  write(grid, rg, v) {
    if (v.length !== rg.numRows || v.some((r) => r.length !== rg.numCols)) throw new Error('dimension mismatch');
    this.ensure(rg.row + rg.numRows - 1, rg.col + rg.numCols - 1);
    if (grid === 'notes') this.noteWrites.push({ row: rg.row, numRows: rg.numRows });
    v.forEach((r, i) => r.forEach((x, j) => { this[grid][rg.row - 1 + i][rg.col - 1 + j] = x; }));
  }
  clearContents() { this.values = []; return this; }
  setFrozenRows() {}
  autoResizeColumns() {}
  noteAt(row, col) { return (this.notes[row - 1] || [])[col - 1] || ''; }
}

class FakeSpreadsheet {
  constructor() { this.sheets = []; this.toasts = []; this.active = null; }
  add(name, values) { const s = new FakeSheet(this, name, values, this.sheets.length * 1000 + 7); this.sheets.push(s); this.active = this.active || s; return s; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { return this.add(n, []); }
  getActiveSheet() { return this.active; }
  toast(msg) { this.toasts.push(msg); }
  /** Supports "Sheet!A2:A" and "Sheet!A:A" style references. */
  getRange(ref) {
    const [name, rng] = ref.split('!');
    const sheet = this.getSheetByName(name);
    if (!sheet) throw new Error('Range not found');
    const [a, b] = rng.split(':');
    const s = a1ToRC(a), e = a1ToRC(b || a);
    const startRow = s.row || 1;
    const endRow = e.row || sheet.getLastRow();
    return sheet.getRange(startRow, s.col, Math.max(0, endRow - startRow + 1), e.col - s.col + 1);
  }
}

module.exports = { FakeSpreadsheet };
