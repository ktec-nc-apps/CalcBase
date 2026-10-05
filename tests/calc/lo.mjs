// The LibreOffice side of the engine tests: a sheet spec becomes a flat ODS,
// `soffice --headless` converts it to CSV twice (as shown, and as the input line
// shows it), and the cells come back. Formulas are written in Calc's own syntax
// (A1, Sheet2.A1, 'My sheet'.A1:B2, A:A, ; between arguments) and translated to
// OpenFormula for the file, so a test reads like what a person types.
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const WORK = process.env.CALC_LO_WORK || join(tmpdir(), 'calcbase-lo');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function haveSoffice() {
  try { execFileSync('soffice', ['--version'], { stdio: 'pipe', env: envOf() }); return true; } catch (e) { return false; }
}
function envOf() { return { ...process.env, HOME: join(WORK, 'home') }; }

// Functions newer than ODF 1.2 carry Microsoft's prefix in the of: grammar.
const MS = ['CONCAT', 'TEXTJOIN', 'IFS', 'SWITCH', 'MINIFS', 'MAXIFS', 'XLOOKUP', 'XMATCH'];
/** Calc-native formula → OpenFormula (of:) with [.A1] references. */
export function toOf(f) {
  f = f.replace(/"(?:[^"]|"")*"|\b([A-Z]+)(?=\()/g, (m, name) => (name && MS.includes(name) ? 'COM.MICROSOFT.' + name : m));
  let out = '';
  let i = 0;
  const ref = /^((?:\$?[A-Za-z_][\w]*|'(?:[^']|'')+')\.)?(\$?[A-Za-z]{1,3}\$?\d+|\$?[A-Za-z]{1,3}|\$?\d+)(?::((?:\$?[A-Za-z_][\w]*|'(?:[^']|'')+')\.)?(\$?[A-Za-z]{1,3}\$?\d+|\$?[A-Za-z]{1,3}|\$?\d+))?(?![\w(])/;
  while (i < f.length) {
    const ch = f[i];
    if (ch === '"') { let j = i + 1; while (j < f.length) { if (f[j] === '"') { if (f[j + 1] === '"') { j += 2; continue; } break; } j++; } out += f.slice(i, j + 1); i = j + 1; continue; }
    if (i > 0 && /[\w.$']/.test(f[i - 1])) { out += ch; i++; continue; }
    const m = ref.exec(f.slice(i));
    if ((m && /[A-Za-z$']/.test(m[0][0])) || (m && /^\$?\d+:/.test(m[0]))) {
      const whole = m[0];
      const a = m[2]; const b = m[4];
      if (!b && !/\d/.test(a)) { out += ch; i++; continue; }
      if (!b && /^\$?\d+$/.test(a)) { out += ch; i++; continue; }
      const sa = m[1] || '.'; const sb = m[3] || '.';
      let A = a; let B = b;
      if (b != null && !/\d/.test(a) && !/\d/.test(b)) { A = a + '1'; B = b + '1048576'; } else if (b != null && /^\$?\d+$/.test(a) && /^\$?\d+$/.test(b)) { A = 'A' + a; B = 'XFD' + b; }
      out += '[' + sa + A + (B != null ? ':' + sb + B : '') + ']';
      i += whole.length; continue;
    }
    out += ch; i++;
  }
  return out;
}

/**
 * sheets: [{ name, rows: [[cell, …], …] }]; a cell is null/'' (empty), a number,
 * a boolean, '=…' (a formula in Calc syntax), other text, or { d: 'yyyy-mm-dd' }.
 */
export function fods(sheets, opts = {}) {
  const [lang, country] = (opts.lang || 'en-US').split('-');
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n';
  x += '<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">\n';
  x += '<office:styles><style:default-style style:family="table-cell"><style:text-properties fo:language="' + lang + '" fo:country="' + country + '"/></style:default-style></office:styles>\n';
  x += '<office:body><office:spreadsheet>\n';
  // Calc's defaults for a new document: case-sensitive comparison, wildcards (not regular expressions).
  x += '<table:calculation-settings table:case-sensitive="true" table:search-criteria-must-apply-to-whole-cell="true" table:use-wildcards="true" table:use-regular-expressions="false" table:automatic-find-labels="false"><table:null-date table:date-value="1899-12-30"/></table:calculation-settings>\n';
  for (const sh of sheets) {
    x += '<table:table table:name="' + esc(sh.name) + '">\n';
    for (const row of sh.rows) { x += '<table:table-row>' + row.map(cellXml).join('') + '</table:table-row>\n'; }
    x += '</table:table>\n';
  }
  x += '</office:spreadsheet></office:body></office:document>\n';
  return x;
}
function cellXml(cell) {
  if (cell == null || cell === '') { return '<table:table-cell/>'; }
  if (typeof cell === 'number') { return '<table:table-cell office:value-type="float" office:value="' + cell + '"/>'; }
  if (typeof cell === 'boolean') { return '<table:table-cell office:value-type="boolean" office:boolean-value="' + cell + '"/>'; }
  if (typeof cell === 'string') {
    if (cell.charAt(0) === '=') { return '<table:table-cell table:formula="of:' + esc(toOf(cell)) + '"/>'; }
    return '<table:table-cell office:value-type="string"><text:p>' + esc(cell) + '</text:p></table:table-cell>';
  }
  if (cell.d != null) { return '<table:table-cell office:value-type="date" office:date-value="' + cell.d + '"/>'; }
  return '<table:table-cell office:value-type="string"><text:p>' + esc(cell.s == null ? '' : cell.s) + '</text:p></table:table-cell>';
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; continue; } quoted = false; continue; }
      field += ch; continue;
    }
    if (ch === '"' && field === '') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

let seq = 0;
/** Convert a sheet spec with LibreOffice → { shown: { sheet: rows }, raw: { sheet: rows } }. */
export function loRun(sheets, opts = {}) {
  mkdirSync(join(WORK, 'home'), { recursive: true });
  const name = 'c' + process.pid + '_' + (seq++);
  const file = join(WORK, name + '.fods');
  writeFileSync(file, fods(sheets, opts));
  const res = { shown: {}, raw: {} };
  for (const mode of ['shown', 'raw']) {
    const out = join(WORK, name + '_' + mode);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
    const filter = 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,' + (mode === 'shown' ? 'true' : 'false') + ',false,false,-1';
    execFileSync('soffice', ['--headless', '-env:UserInstallation=file://' + join(WORK, 'home', 'lo-profile'), '--convert-to', filter, '--outdir', out, file], { stdio: 'pipe', env: envOf(), timeout: 180000 });
    for (const f of readdirSync(out)) {
      const m = new RegExp('^' + name + '-(.*)\\.csv$').exec(f);
      if (m) { res[mode][m[1]] = parseCsv(readFileSync(join(out, f), 'utf8')); }
    }
    rmSync(out, { recursive: true, force: true });
  }
  rmSync(file, { force: true });
  return res;
}

/** The cached answers of LibreOffice, so the tests also run where soffice is missing. */
export function readCache(file) { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; }
export function writeCache(file, data) { writeFileSync(file, JSON.stringify(data, null, 0) + '\n'); }
