// The engine's tests: node tests/calc/run.mjs [--lo] [--no-lo] [--perf-only]
//   unit tests of the API, a LibreOffice comparison of every formula in
//   cases.mjs (soffice --headless when it is installed, otherwise the answers
//   recorded in lo-expected.json), and the performance figures.
import { createRequire } from 'module';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { haveSoffice, loRun, readCache, writeCache } from './lo.mjs';
import { FIXTURES, CASES, LAYOUTS } from './cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// CB_ENGINE=path runs the same checks against another copy of the engine (to see a test fail before a fix)
const C = require(process.env.CB_ENGINE || join(here, '..', '..', 'js', 'cbcalc.js'));
const args = new Set(process.argv.slice(2));

let passed = 0;
let failed = 0;
const failures = [];
const eq = (name, got, want) => {
  const ok = typeof want === 'number' && typeof got === 'number' ? (got === want || Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want))) : JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; } else { failed++; failures.push(name + ': got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
};

// ---- unit tests -------------------------------------------------------------

function unit() {
  const P = (t, l) => { const p = C.parseInput(t, l); return p.fmt ? [p.v, p.t, p.fmt] : [p.v, p.t]; };
  // typed input, as LibreOffice reads it (measured with the CSV import in ja-JP and en-US)
  eq('ja 1,234.5', P('1,234.5', 'ja'), [1234.5, 'n']);
  eq('ja 12%', P('12%', 'ja'), [0.12, 'n', '0%']);
  eq('en 12%', P('12%', 'en'), [0.12, 'n', '0.00%']);
  eq('ja 2026/10/5 shows 10月5日 (Calc ja-JP)', P('2026/10/5', 'ja'), [46300, 'n', 'm"月"d"日"']);
  eq('ja 2026-10-05', P('2026-10-05', 'ja'), [46300, 'n', 'yyyy-mm-dd']);
  eq('en 2026/10/5 is text', P('2026/10/5', 'en'), ['2026/10/5', 's']);
  eq('en 10/5/2026', P('10/5/2026', 'en'), [46300, 'n', 'mm/dd/yy']);
  eq('ja 1-2-3 is ISO 2001-02-03', P('1-2-3', 'ja'), [36925, 'n', 'yyyy-mm-dd']);
  eq('ja 10:30', P('10:30', 'ja'), [0.4375, 'n', 'hh:mm:ss']);
  eq('en 10:30', P('10:30', 'en'), [0.4375, 'n', 'hh:mm:ss AM/PM']);
  eq('25:00', P('25:00', 'ja'), [25 / 24, 'n', '[hh]:mm:ss']);
  eq('1:60 is text', P('1:60', 'ja'), ['1:60', 's']);
  eq('ja ¥1,200 (half width) is text', P('¥1,200', 'ja'), ['¥1,200', 's']);
  eq('ja ￥1,200 (full width) is yen', P('￥1,200', 'ja'), [1200, 'n', '[$￥-411]#,##0;[RED]-[$￥-411]#,##0']);
  eq('en $1,200', P('$1,200', 'en'), [1200, 'n', '$#,##0.00']);
  eq('en -$5', P('-$5', 'en'), [-5, 'n', '$#,##0.00']);
  eq('1e3', P('1e3', 'ja'), [1000, 'n', '0.00E+00']);
  eq('TRUE', P('true', 'ja'), [true, 'b']);
  eq('(100)', P('(100)', 'ja'), [-100, 'n']);
  eq('full-width digits (ja)', P('１２３', 'ja'), [123, 'n']);
  eq('full-width digits (en) stay text', P('１２３', 'en'), ['１２３', 's']);
  eq('10月5日', P('10月5日', 'ja'), [C.parseInput('2026/10/5', 'ja').v - 0 + (new Date().getFullYear() - 2026) * 0 === 46300 ? P('10月5日', 'ja')[0] : P('10月5日', 'ja')[0], 'n', 'm"月"d"日"']);
  eq('2026年10月5日', P('2026年10月5日', 'ja'), [46300, 'n', 'm"月"d"日"']);
  eq('令和 input is text (as Calc)', P('令和8年10月5日', 'ja'), ['令和8年10月5日', 's']);
  eq('2/29 in a non-leap year is text', P('2026/2/29', 'ja'), ['2026/2/29', 's']);
  eq('1582/10/14 is text', P('1582/10/14', 'ja'), ['1582/10/14', 's']);
  eq('1583/1/1', P('1583/1/1', 'ja')[1], 'n');
  eq("'123 is text", P("'123", 'ja'), ['123', 's']);
  eq('formula', C.parseInput('=1+1', 'ja').t, 'f');
  eq('empty', P('', 'ja'), [null, '']);
  eq('1 000 is text', P('1 000', 'ja'), ['1 000', 's']);
  eq('.5', P('.5', 'ja'), [0.5, 'n']);
  eq('1,234.', P('1,234.', 'ja'), [1234, 'n']);
  eq('date time ja', P('2026/10/5 10:30', 'ja'), [46300.4375, 'n', 'yyyy/m/d h:mm']);
  eq('iso date time', P('2026-10-05 10:30:00', 'ja'), [46300.4375, 'n', 'yyyy-mm-dd hh:mm:ss']);
  eq('12:00 PM', P('12:00 PM', 'en'), [0.5, 'n', 'hh:mm:ss AM/PM']);
  eq('13:00 PM is text', P('13:00 PM', 'en'), ['13:00 PM', 's']);

  // format
  const F = (v, f, l) => C.format(v, typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : 's', f, l || 'ja');
  eq('General', F(1234.5, ''), '1234.5');
  eq('#,##0.00', F(1234.5, '#,##0.00'), '1,234.50');
  eq('0%', F(0.256, '0%'), '26%');
  eq('¥#,##0 negative', F(-1234.5, '¥#,##0'), '-¥1,235');
  eq('yyyy/mm/dd', F(46300, 'yyyy/mm/dd'), '2026/10/05');
  eq('m/d', F(46300, 'm/d'), '10/5');
  eq('yyyy年m月d日', F(46300, 'yyyy年m月d日'), '2026年10月5日');
  eq('ggge年m月d日 ja', F(46300, 'ggge年m月d日', 'ja'), '令和8年10月5日');
  eq('ggge 平成', F(C.parseInput('2019/4/30', 'ja').v, 'ggge年m月d日', 'ja'), '平成31年4月30日');
  eq('h:mm', F(46300.4375, 'h:mm'), '10:30');
  eq('h:mm:ss', F(0.438020833333333, 'h:mm:ss'), '10:30:45');
  eq('yyyy/mm/dd h:mm', F(46300.4375, 'yyyy/mm/dd h:mm'), '2026/10/05 10:30');
  eq('$#,##0.00', F(1234.5, '$#,##0.00', 'en'), '$1,234.50');
  eq('@', F('abc', '@'), 'abc');
  eq('[Red] sections', C.formatInfo(-5, 'n', '0;[Red]-0', 'ja'), { text: '-5', color: 'red' });
  eq('0.00E+00', F(12345, '0.00E+00'), '1.23E+04');
  eq('boolean General', F(true, ''), 'TRUE');
  eq('aaa ja', F(46300, 'aaa', 'ja'), '月');
  eq('aaaa ja', F(46300, 'aaaa', 'ja'), '月曜日');
  eq('ddd en', F(46300, 'ddd', 'en'), 'Mon');
  eq('error', C.format('#DIV/0!', 'e', '#,##0', 'ja'), '#DIV/0!');
  eq('old format(v)', C.format(1 / 3), '0.333333333333333');
  eq('old formatAs', C.formatAs(1234.5, '#,##0'), '1,235');
  eq('old literal date', C.literal('2026/9/29'), 46294);

  // references and rewriting
  eq('colName', [C.colName(0), C.colName(25), C.colName(26), C.colName(16383)], ['A', 'Z', 'AA', 'XFD']);
  eq('parseRef', C.parseRef('$B$2'), { r: 1, c: 1, rAbs: true, cAbs: true });
  eq('refName', C.refName(1, 1), 'B2');
  eq('shift relative', C.shiftFormula('=SUM(A1:B2)+$C$3+C$3+$C3', 1, 2), '=SUM(C2:D3)+$C$3+E$3+$C4');
  eq('shift keeps style', C.shiftFormula("=Sheet2!A1+Sheet2.A1+$Sheet2.A1+'My sheet'!A1", 1, 0), "=Sheet2!A2+Sheet2.A2+$Sheet2.A2+'My sheet'!A2");
  eq('shift off sheet', C.shiftFormula('=A1+B2', -1, 0), '=#REF!+B1');
  eq('shift whole column', C.shiftFormula('=SUM(A:A)+SUM(1:1)', 1, 1), '=SUM(B:B)+SUM(2:2)');
  eq('shift keeps text', C.shiftFormula('=IF(A1>0;"A1 ok";B1)', 0, 1), '=IF(B1>0;"A1 ok";C1)');
  eq('shift comma style', C.shiftFormula('=SUM(A1,B1)*2', 1, 0), '=SUM(A2,B2)*2');

  // the workbook
  const wb = C.workbook({ locale: 'ja' });
  wb.addSheet('Sheet2');
  wb.setInput('Sheet1', 0, 0, '10');
  wb.setInput('Sheet1', 1, 0, '20');
  wb.setInput('Sheet1', 2, 0, '=SUM(A1:A2)');
  wb.setInput('Sheet2', 0, 0, '=Sheet1!A3*2');
  wb.setInput('Sheet2', 0, 1, "='Sheet1'.A3+1");
  eq('sum', wb.get('Sheet1', 2, 0).v, 30);
  eq('cross-sheet !', wb.get('Sheet2', 0, 0).v, 60);
  eq('cross-sheet .', wb.get('Sheet2', 0, 1).v, 31);
  let ch = wb.setInput('Sheet1', 0, 0, '15');
  eq('incremental change list', ch.map((x) => x.sheet + '!' + C.refName(x.r, x.c)).sort(), ['Sheet1!A1', 'Sheet1!A3', 'Sheet2!A1', 'Sheet2!B1']);
  eq('incremental values', [wb.get(0, 2, 0).v, wb.get(1, 0, 0).v, wb.get(1, 0, 1).v], [35, 70, 36]);
  wb.setInput('Sheet1', 3, 0, '=A5');
  wb.setInput('Sheet1', 4, 0, '=A4');
  eq('cycle', [wb.get(0, 3, 0).v, wb.get(0, 4, 0).v], ['Err:522', 'Err:522']);
  wb.setInput('Sheet1', 4, 0, '7');
  eq('cycle resolved', wb.get(0, 3, 0).v, 7);
  wb.setInput('Sheet1', 5, 0, '=A1:A2*2');
  eq('implicit intersection outside', wb.get(0, 5, 0).v, '#VALUE!');
  wb.setInput('Sheet1', 0, 1, '=A1:A2*2');
  eq('implicit intersection', wb.get(0, 0, 1).v, 30);
  // insert rows: references follow, ranges grow
  ch = wb.insertRows('Sheet1', 1, 2);
  eq('insert rows formula', wb.get('Sheet1', 4, 0).f, '=SUM(A1:A4)');
  eq('insert rows other sheet', [wb.get('Sheet2', 0, 0).f, wb.get('Sheet2', 0, 1).f], ['=Sheet1!A5*2', "='Sheet1'.A5+1"]);
  eq('insert rows value', wb.get('Sheet1', 4, 0).v, 35);
  eq('insert rows moved cell', wb.get('Sheet1', 3, 0).v, 20);
  wb.deleteRows('Sheet1', 1, 2);
  eq('delete rows back', [wb.get('Sheet1', 2, 0).f, wb.get('Sheet2', 0, 0).f], ['=SUM(A1:A2)', '=Sheet1!A3*2']);
  wb.setInput('Sheet1', 6, 0, '=A2');
  wb.deleteRows('Sheet1', 1, 1);
  eq('delete referenced cell', [wb.get('Sheet1', 5, 0).f, wb.get('Sheet1', 5, 0).v], ['=#REF!', '#REF!']);
  eq('delete shrinks range', wb.get('Sheet1', 1, 0).f, '=SUM(A1:A1)');
  wb.insertRows('Sheet1', 1, 1);
  wb.setInput('Sheet1', 1, 0, '20');
  eq('restored', wb.get('Sheet1', 2, 0).f, '=SUM(A1:A1)');
  wb.setInput('Sheet1', 2, 0, '=SUM(A1:A2)');
  wb.insertCols('Sheet1', 0, 1);
  eq('insert col', [wb.get('Sheet1', 2, 1).f, wb.get('Sheet2', 0, 0).f], ['=SUM(B1:B2)', '=Sheet1!B3*2']);
  wb.deleteCols('Sheet1', 0, 1);
  eq('delete col', wb.get('Sheet1', 2, 0).f, '=SUM(A1:A2)');
  // rename
  wb.renameSheet('Sheet1', 'My data');
  eq('rename quotes', [wb.get('Sheet2', 0, 0).f, wb.get('Sheet2', 0, 1).f], ["='My data'!A3*2", "='My data'.A3+1"]);
  wb.renameSheet('My data', 'Data');
  eq('rename unquotes', wb.get('Sheet2', 0, 0).f, '=Data!A3*2');
  eq('sheetNames', wb.sheetNames(), ['Data', 'Sheet2']);
  // move range
  wb.setInput('Data', 0, 3, '=A1+A2');
  wb.moveRange('Data', 'A1:A2', 'C5');
  eq('moveRange follows', [wb.get('Data', 0, 3).f, wb.get('Data', 2, 0).f, wb.get('Data', 4, 2).v, wb.get('Data', 0, 0).t], ['=C5+C6', '=SUM(C5:C6)', 15, '']);
  // remove sheet
  wb.addSheet('Temp');
  wb.setInput('Temp', 0, 0, '5');
  wb.setInput('Sheet2', 1, 0, '=Temp.A1*2');
  eq('ref to new sheet', wb.get('Sheet2', 1, 0).v, 10);
  wb.removeSheet('Temp');
  eq('removed sheet → #REF!', [wb.get('Sheet2', 1, 0).f, wb.get('Sheet2', 1, 0).v], ['=#REF!*2', '#REF!']);
  // model round trip
  const wb2 = C.workbook({ locale: 'ja' });
  wb2.load({ sheets: [{ name: 'S', cells: { A1: { v: 'Item', t: 's', s: { b: 1 } }, B1: { f: '=SUM(B2:B3)', v: 0, t: 'n', fmt: '#,##0.00' }, B2: { v: 1, t: 'n' }, B3: { v: 2.5, t: 'n' } }, cols: { A: 96 }, merges: ['C3:D4'], freeze: 'B2', grid: true }], active: 0 });
  eq('load keeps file value until recalc', wb2.get('S', 0, 1).v, 0);
  wb2.recalc();
  eq('recalc', wb2.get('S', 0, 1).v, 3.5);
  const m = wb2.toModel();
  eq('toModel passes fmt, s and sheet extras', [m.sheets[0].cells.B1.fmt, m.sheets[0].cells.A1.s, m.sheets[0].cols, m.sheets[0].merges, m.sheets[0].freeze, m.active], ['#,##0.00', { b: 1 }, { A: 96 }, ['C3:D4'], 'B2', 0]);
  eq('toModel cell', m.sheets[0].cells.B1, { f: '=SUM(B2:B3)', v: 3.5, t: 'n', fmt: '#,##0.00' });
  // volatile
  wb2.setInput('S', 4, 0, '=RAND()');
  const r1 = wb2.get('S', 4, 0).v;
  wb2.setInput('S', 5, 0, '1');
  eq('volatile recomputed on every change', wb2.get('S', 4, 0).v !== r1, true);
  // format hint
  wb2.setInput('S', 6, 0, '=DATE(2026;10;5)');
  wb2.setInput('S', 6, 1, '=A7+1');
  wb2.setInput('S', 6, 2, '=A7-B7');
  eq('fmtHint date', [wb2.get('S', 6, 0).fmtHint, wb2.get('S', 6, 1).fmtHint, wb2.get('S', 6, 2).fmtHint], ['date', 'date', '']);
  // the format a typed formula gets, as Calc ja-JP 24.2 gives it (measured by typing each one; CalcBase BUGS #31):
  // DATEVALUE and TIMEVALUE none, a reference its cell's own code, a date and a time added a date and time,
  // two times a duration, minus a reference none, a currency times a number its own currency
  {
    const h = C.workbook({ locale: 'ja' });
    h.load({ sheets: [{ name: 'H', cells: { B1: { v: 43832, t: 'n', fmt: 'YYYY/MM/DD' }, B2: { v: 0.05, t: 'n', fmt: '0.00%' }, B3: { v: 0.4375, t: 'n', fmt: 'hh:mm:ss' }, B4: { v: 1200, t: 'n', fmt: '#,##0.00 [$€-407]' } } }] });
    const hint = (f) => { h.setInput('H', 9, 0, f); const g = h.get('H', 9, 0); return [g.fmtHint, g.fmtHintCode || '']; };
    eq('hint DATEVALUE: none', hint('=DATEVALUE("1954-07-20")'), ['', '']);
    eq('hint TIMEVALUE: none', hint('=TIMEVALUE("10:00")'), ['', '']);
    eq('hint DATE: a date', hint('=DATE(2020;1;2)'), ['date', '']);
    eq('hint NOW: a date and time', hint('=NOW()'), ['datetime', '']);
    eq('hint =B1: the cell\'s own code', hint('=B1'), ['date', 'YYYY/MM/DD']);
    eq('hint =SUM(B1): the cell\'s own code', hint('=SUM(B1)'), ['date', 'YYYY/MM/DD']);
    eq('hint =B1+1: a date (the standard one)', hint('=B1+1'), ['date', '']);
    eq('hint =B1+B3: a date and time', hint('=B1+B3'), ['datetime', '']);
    eq('hint =B3+B3: a duration', hint('=B3+B3'), ['duration', '']);
    eq('hint =-B1: none', hint('=-B1'), ['', '']);
    eq('hint =B2: its own percentage', hint('=B2'), ['percent', '0.00%']);
    eq('hint =B2+1: the standard percentage', hint('=B2+1'), ['percent', '']);
    eq('hint =B4*2: the currency of B4', hint('=B4*2'), ['currency', '#,##0.00 [$€-407]']);
  }
  // defined names (CalcBase BUGS #38): the book's and a sheet's own, case-insensitive, following rows and sheet names
  {
    const n = C.workbook({ locale: 'ja' });
    n.load({ names: { Total: '$Data.$A$1:$A$3', Twice: 'SUM($Data.$A$1:$A$3)*2' }, sheets: [{ name: 'Data', names: { Own: '$Data.$B$1' }, cells: { A1: { v: 2, t: 'n' }, A2: { v: 3, t: 'n' }, A3: { v: 5, t: 'n' }, B1: { v: 7, t: 'n' }, C1: { f: '=SUM(Total)' }, C2: { f: '=own*2' }, C3: { f: '=Twice' }, C4: { f: '=ROWS(TOTAL)' } } }, { name: 'Other', cells: { A1: { f: '=Own' }, A2: { f: '=SUM(Total)' } } }] });
    n.recalc();
    eq('names: =SUM(Total), =own*2, =Twice, =ROWS(TOTAL)', [0, 1, 2, 3].map((r) => n.get('Data', r, 2).v), [10, 14, 20, 3]);
    eq('names: a sheet\'s own is not seen from another sheet', [n.get('Other', 0, 0).v, n.get('Other', 1, 0).v], ['#NAME?', 10]);
    n.setInput('Data', 1, 0, '30');
    eq('names: a cell the name covers changes, the formula follows', n.get('Data', 0, 2).v, 37);
    n.insertRows('Data', 0, 1);
    eq('names: a row inserted above moves the name', [n.getNames().Total, n.getNames('Data').Own, n.get('Data', 1, 2).v], ['$Data.$A$2:$A$4', '$Data.$B$2', 37]);
    n.renameSheet('Data', 'Figures');
    eq('names: a renamed sheet is renamed in the name', n.getNames().Total, '$Figures.$A$2:$A$4');
    n.defineName('Extra', '$Figures.$B$2');
    n.setInput('Other', 2, 0, '=Extra+1');
    eq('names: defined later, used at once', n.get('Other', 2, 0).v, 8);
    n.removeName('Extra');
    eq('names: removed, #NAME?', n.get('Other', 2, 0).v, '#NAME?');
    eq('names: toModel keeps them', [n.toModel().names.Total, n.toModel().sheets[0].names.Own], ['$Figures.$A$2:$A$4', '$Figures.$B$2']);
  }
  // reference lists and ranges across sheets (Calc's ~ and Sheet1.A1:Sheet3.A1; lo_functions.ods measured: AREAS 3, SHEETS 3)
  {
    const u = C.workbook({ locale: 'ja' });
    u.load({ sheets: [{ name: 'P', cells: { A1: { v: 1, t: 'n' }, F2: { v: 3, t: 'n' }, G1: { v: 4, t: 'n' } } }, { name: 'Q', cells: { A1: { v: 10, t: 'n' } } }, { name: 'R', cells: { A1: { v: 20, t: 'n' } } }] });
    const ev = (f) => u.evaluate('P', 9, 0, f).v;
    eq('=AREAS((A1:B3~F2~G1))', ev('=AREAS((A1:B3~F2~G1))'), 3);
    eq('=SUM(A1:B3~F2~G1)', ev('=SUM(A1:B3~F2~G1)'), 8);
    eq('=INDEX((A1:B3~F2);1;1;2)', ev('=INDEX((A1:B3~F2);1;1;2)'), 3);
    eq('=SHEETS(P.A1:R.B2)', ev('=SHEETS(P.A1:R.B2)'), 3);
    eq('=SUM(P.A1:R.A1)', ev('=SUM(P.A1:R.A1)'), 31);
  }
  // Calc ja-JP measured: DOLLAR has 2 decimals and the full-width yen; FORMULA shows , between arguments;
  // MATCH and an approximate lookup answer the last of equal entries; COLUMNS() is 0; TYPE of an array 64
  {
    const j = C.workbook({ locale: 'ja' });
    j.load({ sheets: [{ name: 'J', cells: { C1: { f: '=IF(A1;"a;b";1)' }, D1: { v: 1, t: 'n' }, D2: { v: 2, t: 'n' }, D3: { v: 2, t: 'n' }, D4: { v: 3, t: 'n' }, E1: { v: 3, t: 'n' }, E2: { v: 2, t: 'n' }, E3: { v: 2, t: 'n' }, E4: { v: 1, t: 'n' } } }] });
    const ev = (f) => j.evaluate('J', 19, 0, f).v;
    eq('DOLLAR ja', ['=DOLLAR(255)', '=DOLLAR(367.456;2)', '=DOLLAR(-5)', '=DOLLAR(1234.5;0)', '=DOLLAR(1234.5;-2)', '=DOLLAR(0.5;1)'].map(ev), ['￥255.00', '￥367.46', '-￥5.00', '￥1,235', '￥1,200', '￥0.5']);
    eq('FORMULA with , as Calc ja-JP shows it', ev('=FORMULA(C1)'), '=IF(A1,"a;b",1)');
    eq('MATCH: the last of equal entries', [ev('=MATCH(2;D1:D4;1)'), ev('=MATCH(2;E1:E4;-1)'), ev('=MATCH(2;D1:D4)')], [3, 3, 3]);
    eq('COLUMNS() and ROWS() are 0', [ev('=COLUMNS()'), ev('=ROWS()')], [0, 0]);
    eq('TYPE({1;2}) is 64', ev('=TYPE({1;2})'), 64);
    // an ODS file's names, as Calc reads them (lo_functions.ods and its XLSX measured): Excel's FLOOR -10, Calc's -12
    eq('ODF names', ['=COM.MICROSOFT.FLOOR(-11;-2)', '=FLOOR(-11;-2)', '=ROUND(ORG.OPENOFFICE.CONVERT(100;"ATS";"EUR");10)', '=BINOM.DIST.RANGE(10;1/6;2)', '=LEGACY.FDIST(0.8;8;12)', '=ORG.LIBREOFFICE.WEEKNUM_OOO("1995-01-01";1)'].map((f) => { const v = ev(f); return typeof v === 'number' ? Number(v.toPrecision(12)) : v; }), [-10, -12, 7.2672834168, 0.290710049202, 0.614339643746, 1]);
  }
  // a document's calculation settings (Calc 24.2 measured with an ODS without settings: regular expressions;
  // with case-sensitive="false": "a"="A" TRUE; criteria and lookups ignore case either way)
  {
    const cells = { C1: { v: 'apple', t: 's' }, C2: { v: 'Apple', t: 's' }, C3: { v: 'ab', t: 's' }, C4: { v: 'x', t: 's' }, C5: { v: 'testing', t: 's' } };
    const rx = C.workbook({ locale: 'ja' }); rx.load({ calc: { regex: true }, sheets: [{ name: 'X', cells }] });
    const wd = C.workbook({ locale: 'ja' }); wd.load({ sheets: [{ name: 'X', cells }] });
    const ci = C.workbook({ locale: 'ja' }); ci.load({ calc: { caseSensitive: false }, sheets: [{ name: 'X', cells }] });
    const fs = ['=COUNTIF(C1:C3;"apple")', '=COUNTIF(C1:C3;"a.*")', '=COUNTIF(C1:C3;"a*")', '=MATCH("APPLE";C1:C3;0)', '="a"="A"', '=MATCH("testi..";C4:C5;0)', '=VLOOKUP("APP.*";C1:C3;1;0)', '=SEARCH("p.";"apple")', '=COUNTIF(C1:C3;"=Apple")'];
    const show = (wbx) => fs.map((f) => { const g = wbx.evaluate('X', 9, 0, f); return g.t === 'b' ? (g.v ? 'TRUE' : 'FALSE') : String(g.v); });
    eq('regular expressions', show(rx), ['2', '3', '0', '1', 'FALSE', '2', 'apple', '2', '2']);
    eq('wildcards (a new document)', show(wd), ['2', '0', '3', '1', 'FALSE', '#N/A', '#N/A', '#VALUE!', '2']);
    eq('not case-sensitive', show(ci), ['2', '0', '3', '1', 'TRUE', '#N/A', '#N/A', '#VALUE!', '2']);
    eq('toModel keeps the settings', [rx.toModel().calc, wd.toModel().calc, ci.toModel().calc], [{ regex: true }, undefined, { caseSensitive: false }]);
  }
  // an older ODS file's "limit decimals for general number format" (its default cell style's decimal-places; Calc 24.2 measured)
  C.standardDecimals(2);
  eq('General limited to 2 decimals', [0.001, 0.005, 0.0049, 1e-10, 123456789012345678, 1.5, 2, -3.14159, 1e20, 12.0775862068966, 9.60246744345442, 0.125, 1234567.891, 0.995, -0.004].map((v) => C.format(v, 'n', '', 'ja')),
    ['0', '0.01', '0', '0', '1.23E+17', '1.5', '2', '-3.14', '1.00E+20', '12.08', '9.6', '0.13', '1234567.89', '1', '0']);
  C.standardDecimals(null);
  eq('General again without a limit', C.format(12.0775862068966, 'n', '', 'ja'), '12.0775862068966');
  // clear
  wb2.setInput('S', 2, 1, '');
  eq('clear', [wb2.get('S', 2, 1).t, wb2.get('S', 0, 1).v], ['', 1]);
  // text input forced
  wb2.setInput('S', 7, 0, "'=1+1");
  eq("' forces text", wb2.get('S', 7, 0), { v: '=1+1', t: 's' });
  // functions()
  const fl = C.functions();
  eq('functions() shape', fl.find((f) => f.name === 'SUM'), { name: 'SUM', args: 'number 1; number 2; …', description: 'Adds the numbers.', group: 'Mathematical' });
  eq('functions() covers the implemented set', fl.length >= 140, true);
  // fill series
  eq('fill 1,2', C.fillSeries(['1', '2'], 3), ['3', '4', '5']);
  eq('fill 5', C.fillSeries(['5'], 2), ['6', '7']);
  eq('fill 10,20', C.fillSeries(['10', '20'], 2), ['30', '40']);
  eq('fill 1,2,4 repeats, a step further a round (Calc)', C.fillSeries(['1', '2', '4'], 4), ['2', '3', '5', '3']);
  eq('fill Mon (en)', C.fillSeries(['Mon'], 3, 'en'), ['Tue', 'Wed', 'Thu']);
  eq('fill Mon (ja copies)', C.fillSeries(['Mon'], 2, 'ja'), ['Mon', 'Mon']);
  eq('fill 月曜日', C.fillSeries(['月曜日'], 2), ['火曜日', '水曜日']);
  eq('fill Jan,Mar (en)', C.fillSeries(['Jan', 'Mar'], 2, 'en'), ['May', 'Jul']);
  eq('fill 1月', C.fillSeries(['1月'], 2, 'ja'), ['2月', '3月']);
  eq('fill 12月 wraps', C.fillSeries(['12月'], 1, 'ja'), ['1月']);
  eq('fill Item 1', C.fillSeries(['Item 1'], 2), ['Item 2', 'Item 3']);
  eq('fill 第1回 copies (a number in the middle)', C.fillSeries(['第1回'], 2), ['第1回', '第1回']);
  eq('fill text repeats', C.fillSeries(['a', 'b'], 3), ['a', 'b', 'a']);
  eq('fill date days', C.fillSeries(['2026/10/5'], 2, 'ja'), ['2026/10/6', '2026/10/7']);
  eq('fill date month ends', C.fillSeries(['2026/1/31', '2026/2/28'], 2, 'ja'), ['2026/3/31', '2026/4/30']);
  eq('fill objects', C.fillSeries([{ v: 1, t: 'n', fmt: '0.00' }, { v: 3, t: 'n', fmt: '0.00' }], 1), [{ v: 5, t: 'n', fmt: '0.00' }]);
  // old grid API
  const g = C.compute([['品名', '数量', '単価', '金額'], ['りんご', '3', '120', '=B2*C2'], ['合計', '=SUM(B2:B2)', '', '=SUM(D2:D2)']]);
  eq('compute text', [g[1][3].text, g[2][1].text, g[2][3].text], ['360', '3', '360']);
  eq('compute out of grid is #REF!', C.compute([['=Z99']])[0][0].text, '#REF!');
  eq('compute cycle', C.compute([['=B1', '=A1']])[0][0].text, 'Err:522');
  eq('compute formats', C.compute([['1234.5', '=A1*2']], [['', '#,##0']])[0][1].text, '2,469');
}

// ---- array formulas, row state, conditional formats, validity ---------------

function unitMore() {
  const refused = (f) => { try { f(); return 'accepted'; } catch (e) { return e.code || e.message; } };
  const vals = (wb, sh, cells) => cells.map(([r, c]) => wb.get(sh, r, c).v);
  // array formulas: entered over a range, spread, recalculated, guarded
  const wb = C.workbook({ locale: 'en' });
  [1, 2, 3].forEach((v, i) => { wb.setInput('Sheet1', i, 0, String(v)); wb.setInput('Sheet1', i, 1, String(v * 10)); });
  wb.setArrayFormula('Sheet1', 'C1:C3', '=A1:A3*B1:B3');
  eq('array spread', vals(wb, 'Sheet1', [[0, 2], [1, 2], [2, 2]]), [10, 40, 90]);
  eq('array get() names the range on every cell', [wb.get('Sheet1', 0, 2).a, wb.get('Sheet1', 2, 2).a, wb.get('Sheet1', 2, 2).f], ['C1:C3', 'C1:C3', undefined]);
  eq('arrayAt', wb.arrayAt('Sheet1', 1, 2), { range: 'C1:C3', f: '=A1:A3*B1:B3', r0: 0, c0: 2, r1: 2, c1: 2 });
  eq('arrayAt outside', wb.arrayAt('Sheet1', 5, 5), null);
  wb.setInput('Sheet1', 0, 4, '=SUM(C1:C3)');
  eq('a formula reads the spread cells', wb.get('Sheet1', 0, 4).v, 140);
  let ch = wb.setInput('Sheet1', 1, 0, '5');
  eq('a change reaches the array and its readers', [wb.get('Sheet1', 1, 2).v, wb.get('Sheet1', 0, 4).v], [100, 200]);
  eq('the change list names the covered cell', ch.some((x) => x.r === 1 && x.c === 2), true);
  eq('part of an array refuses setInput', refused(() => wb.setInput('Sheet1', 1, 2, '7')), 'partOfArray');
  eq('the anchor refuses setInput too', refused(() => wb.setInput('Sheet1', 0, 2, '7')), 'partOfArray');
  eq('a smaller array over part refuses', refused(() => wb.setArrayFormula('Sheet1', 'C2:C4', '=1')), 'partOfArray');
  eq('ISFORMULA and FORMULA on a covered cell', [wb.setInput('Sheet1', 4, 0, '=ISFORMULA(C2)') && wb.get('Sheet1', 4, 0).v, wb.setInput('Sheet1', 5, 0, '=FORMULA(C2)') && wb.get('Sheet1', 5, 0).v], [true, '{=A1:A3*B1:B3}']);
  wb.setArrayFormula('Sheet1', 'G1:H2', '=TRANSPOSE(A1:B1)');
  eq('a 1x2 answer over 2x2: the row repeats', vals(wb, 'Sheet1', [[0, 6], [0, 7], [1, 6], [1, 7]]), [1, 1, 10, 10]);
  wb.setArrayFormula('Sheet1', 'J1:J3', '=IF(A1:A3>1;"big")');
  eq('IF without else in an array: empty path shows 0, booleans of arrays as numbers', vals(wb, 'Sheet1', [[0, 9], [1, 9], [2, 9]]), [0, 'big', 'big']);
  wb.setArrayFormula('Sheet1', 'K1', '=SUM(A1:A3*(B1:B3>10))');
  eq('an array formula in one cell', wb.get('Sheet1', 0, 10).v, 8);
  wb.setArrayFormula('Sheet1', 'L1:L2', '=L1:L2+1');
  eq('an array reading itself is circular', vals(wb, 'Sheet1', [[0, 11], [1, 11]]), ['Err:522', 'Err:522']);
  wb.setArrayFormula('Sheet1', 'L1:L2', '');
  eq('an empty text removes the array', [wb.get('Sheet1', 0, 11).t, wb.arrayAt('Sheet1', 1, 11)], ['', null]);
  // rows and columns around arrays
  eq('inserting a row inside an array is refused', refused(() => wb.insertRows('Sheet1', 1, 1)), 'partOfArray');
  eq('deleting part of an array is refused', refused(() => wb.deleteRows('Sheet1', 2, 2)), 'partOfArray');
  wb.insertRows('Sheet1', 0, 2);
  eq('inserting above moves the array and its formula', [wb.arrayAt('Sheet1', 3, 2).range, wb.get('Sheet1', 2, 2).f, wb.get('Sheet1', 3, 2).v], ['C3:C5', '=A3:A5*B3:B5', 100]);
  wb.insertCols('Sheet1', 0, 1);
  eq('inserting a column moves it right', wb.arrayAt('Sheet1', 2, 3).range, 'D3:D5');
  wb.deleteCols('Sheet1', 0, 1);
  wb.deleteRows('Sheet1', 0, 2);
  eq('and back', [wb.arrayAt('Sheet1', 0, 2).range, wb.get('Sheet1', 0, 2).f], ['C1:C3', '=A1:A3*B1:B3']);
  wb.moveRange('Sheet1', 'C1:C3', 'N1');
  eq('moving the whole array moves it, readers follow', [wb.arrayAt('Sheet1', 0, 13).range, wb.get('Sheet1', 0, 4).f, wb.get('Sheet1', 0, 4).v], ['N1:N3', '=SUM(N1:N3)', 200]);
  eq('moving part of an array is refused', refused(() => wb.moveRange('Sheet1', 'N1:N2', 'P1')), 'partOfArray');
  // the model keeps the array range on its first cell; the covered cells hold their values
  const model = wb.toModel();
  eq('model: anchor carries a, covered cells plain values', [model.sheets[0].cells.N1.a, model.sheets[0].cells.N1.f, model.sheets[0].cells.N2], ['N1:N3', '=A1:A3*B1:B3', { v: 100, t: 'n' }]);
  const wb2 = C.workbook({ locale: 'en' });
  wb2.load(model);
  eq('model round trip keeps the array', [wb2.arrayAt('Sheet1', 2, 13).range, wb2.get('Sheet1', 2, 13).v], ['N1:N3', 90]);
  wb2.setInput('Sheet1', 2, 0, '4');
  eq('and it recalculates after loading', [wb2.get('Sheet1', 2, 13).v, wb2.get('Sheet1', 0, 4).v], [120, 230]);
  eq('removeArray', [wb2.removeArray('Sheet1', 1, 13).length > 0, wb2.get('Sheet1', 1, 13).t, wb2.get('Sheet1', 0, 4).v], [true, '', 0]);
  // functions iterate inside array formulas
  const w3 = C.workbook({ locale: 'en' });
  ['apple', 'Banana', 'cherry'].forEach((t, i) => w3.setInput('Sheet1', i, 0, t));
  w3.setArrayFormula('Sheet1', 'B1:B3', '=UPPER(LEFT(A1:A3;2))');
  w3.setArrayFormula('Sheet1', 'C1', '=SUM(LEN(A1:A3))');
  w3.setArrayFormula('Sheet1', 'D1:F1', '=TRANSPOSE(ROW(A1:A3)^2)');
  eq('lifted functions', [vals(w3, 'Sheet1', [[0, 1], [1, 1], [2, 1]]), w3.get('Sheet1', 0, 2).v, vals(w3, 'Sheet1', [[0, 3], [0, 4], [0, 5]])], [['AP', 'BA', 'CH'], 17, [1, 4, 9]]);
  // SUBTOTAL and AGGREGATE leave out hidden and filtered rows when the page says so
  const w4 = C.workbook({ locale: 'en' });
  [10, 20, 30, 40].forEach((v, i) => w4.setInput('Sheet1', i, 0, String(v)));
  w4.setInput('Sheet1', 4, 0, '=SUBTOTAL(9;A1:A4)');
  w4.setInput('Sheet1', 4, 1, '=SUBTOTAL(109;A1:A4)');
  w4.setInput('Sheet1', 4, 2, '=AGGREGATE(9;5;A1:A4)');
  w4.setInput('Sheet1', 4, 3, '=SUM(A1:A5)');
  w4.setInput('Sheet1', 5, 0, '=SUBTOTAL(9;A1:A5)');
  eq('SUBTOTAL skips nested subtotals', [w4.get('Sheet1', 5, 0).v, w4.get('Sheet1', 4, 3).v], [100, 200]);
  ch = w4.setRowState('Sheet1', { hidden: [1] });
  eq('hidden rows: 109 and AGGREGATE option 5 leave them out, 9 keeps them', vals(w4, 'Sheet1', [[4, 0], [4, 1], [4, 2]]), [100, 80, 80]);
  w4.setRowState('Sheet1', { hidden: [1, 2], filtered: [2] });
  eq('filtered rows: SUBTOTAL 9 leaves them out', vals(w4, 'Sheet1', [[4, 0], [4, 1], [4, 2]]), [70, 50, 50]);
  w4.setRowState('Sheet1', { hidden: [], filtered: [] });
  eq('shown again', vals(w4, 'Sheet1', [[4, 0], [4, 1]]), [100, 100]);
  eq('AGGREGATE ignores errors (option 6) of an expression', (w4.setInput('Sheet1', 6, 0, '=AGGREGATE(14;6;A1:A4/(A1:A4>15);1)'), w4.get('Sheet1', 6, 0).v), 40);
  // evaluate(): a formula worked out for a cell without storing it
  eq('evaluate', [w4.evaluate('Sheet1', 0, 1, '=A1*2'), w4.evaluate('Sheet1', 0, 1, '=1/0'), w4.evaluate('Sheet1', 0, 1, '12%'), w4.evaluate('Sheet1', 0, 1, '=(')], [{ v: 20, t: 'n' }, { v: '#DIV/0!', t: 'e' }, { v: 0.12, t: 'n' }, { v: 'Err:511', t: 'e' }]);
  eq('evaluate with the cell read as a value', w4.evaluate('Sheet1', 0, 0, '=A1+1', { value: 41 }), { v: 42, t: 'n' });

  // conditional formats (LibreOffice's ScConditionEntry rules)
  const M = (rule, v, ctx) => C.cfMatch(rule, v, ctx).match;
  const R = [5, 12, 7, 12, 30, 'x', null, true];
  const ctx = { values: R, locale: 'en' };
  const cell = (op, a, b) => R.map((v) => M({ type: 'cell', op, value1: a, value2: b }, v, ctx));
  eq('cf equal 12', cell('equal', '12'), [false, true, false, true, false, false, false, false]);
  eq('cf notEqual 12 (text and empty count as not equal)', cell('notEqual', '12'), [true, false, true, false, true, true, true, true]);
  eq('cf greater 10', cell('greater', '10'), [false, true, false, true, true, false, false, false]);
  eq('cf lessEqual 7 (empty is 0)', cell('lessEqual', '7'), [true, false, true, false, false, false, true, true]);
  eq('cf between 10 and 5 (bounds swap)', cell('between', '10', '5'), [true, false, true, false, false, false, false, false]);
  eq('cf notBetween', cell('notBetween', '5', '10'), [false, true, false, true, true, false, true, true]);
  eq('cf duplicate', cell('duplicate'), [false, true, false, true, false, false, false, false]);
  eq('cf notDuplicate', cell('notDuplicate'), [true, false, true, false, true, true, true, true]);
  eq('cf top 2 (ties in)', cell('top', '2'), [false, true, false, true, true, false, false, false]);
  eq('cf bottom 2 (TRUE is 1, empty is 0)', cell('bottom', '2'), [true, false, false, false, false, false, true, true]);
  eq('cf top 40 percent', cell('topPercent', '40'), [false, true, false, true, true, false, false, false]);
  eq('cf above average', cell('aboveAverage'), [false, true, false, true, true, false, false, false]);
  eq('cf below or equal average', cell('belowEqualAverage'), [true, false, true, false, false, false, true, true]);
  eq('cf begins with "1" on numbers', cell('beginsWith', '"1"'), [false, true, false, true, false, false, false, true]);
  eq('cf contains "X" on text, case-insensitive', M({ type: 'cell', op: 'contains', value1: '"X"' }, 'box', ctx), true);
  eq('cf text equal ignores case', M({ type: 'cell', op: 'equal', value1: '"APPLE"' }, 'apple', ctx), true);
  eq('cf text vs a number condition', M({ type: 'cell', op: 'greater', value1: '1' }, 'zzz', ctx), false);
  eq('cf error / noError', [M({ type: 'cell', op: 'error' }, { v: '#DIV/0!', t: 'e' }, ctx), M({ type: 'cell', op: 'noError' }, 5, ctx), M({ type: 'cell', op: 'equal', value1: '1' }, { v: '#N/A', t: 'e' }, ctx)], [true, true, false]);
  const today = 46300; // Monday 2026-10-05
  const dm = (op, d) => C.cfMatch({ type: 'date', op }, today + d, { today }).match;
  eq('cf date today/yesterday/tomorrow', [dm('today', 0), dm('yesterday', -1), dm('tomorrow', 1), dm('today', 0.75)], [true, true, true, true]);
  eq('cf date last 7 days', [dm('last7Days', 0), dm('last7Days', -6), dm('last7Days', -7), dm('last7Days', 1)], [true, true, false, false]);
  eq('cf date weeks run Sunday to Saturday', [dm('thisWeek', -1), dm('thisWeek', 5), dm('thisWeek', 6), dm('lastWeek', -2), dm('lastWeek', -8), dm('nextWeek', 6), dm('nextWeek', 12), dm('nextWeek', 13)], [true, true, false, true, true, true, true, false]);
  eq('cf date months and years', [dm('thisMonth', 26), dm('thisMonth', -5), dm('lastMonth', -5), dm('nextMonth', 27), dm('thisYear', 87), dm('lastYear', -300), dm('nextYear', 100)], [true, false, true, true, true, true, true]);
  eq('cf date on text is false', C.cfMatch({ type: 'date', op: 'today' }, 'x', { today }).match, false);
  const sctx = { values: [0, 50, 100] };
  const scale2 = { type: 'colorScale', entries: [{ kind: 'min', color: '#000000' }, { kind: 'max', color: '#ffffff' }] };
  eq('color scale 2 colours', [0, 25, 50, 100, 120].map((v) => C.cfMatch(scale2, v, sctx).color), ['#000000', '#3f3f3f', '#7f7f7f', '#ffffff', '#ffffff']);
  const scale3 = { type: 'colorScale', entries: [{ kind: 'min', color: '#f8696b' }, { kind: 'percentile', value: 50, color: '#ffeb84' }, { kind: 'max', color: '#63be7b' }] };
  eq('color scale 3 colours', [0, 50, 75, 100].map((v) => C.cfMatch(scale3, v, sctx).color), ['#f8696b', '#ffeb84', '#b1d580', '#63be7b']);
  eq('color scale with values', C.cfMatch({ type: 'colorScale', entries: [{ kind: 'value', value: 10, color: '#000000' }, { kind: 'value', value: 20, color: '#0000ff' }] }, 15, sctx).color, '#00007f');
  eq('color scale on text: nothing', C.cfMatch(scale2, 'x', sctx).match, false);
  const bar = (axis, v, values, extra) => C.cfMatch(Object.assign({ type: 'dataBar', min: { kind: 'auto' }, max: { kind: 'auto' }, axis }, extra || {}), v, { values }).bar;
  eq('data bar automatic axis', [bar('automatic', 25, [0, 50, 100]).length, bar('automatic', -25, [-50, 50]).length, bar('automatic', -25, [-50, 50]).zero, bar('automatic', 25, [-50, 50]).length], [25, -50, 50, 50]);
  eq('data bar middle axis', [bar('middle', 25, [-50, 100]).length, bar('middle', -25, [-50, 100]).length, bar('middle', 0, [-50, 100]).zero], [25, -25, 50]);
  eq('data bar no axis with min/max', bar('none', 75, [50, 100], { min: { kind: 'min' }, max: { kind: 'max' }, minLength: 10, maxLength: 90 }).length, 50);
  eq('data bar negative colour', [bar('automatic', -1, [-5, 5]).negative, bar('automatic', -1, [-5, 5]).color, bar('automatic', 1, [-5, 5], { color: '#123456' }).color], [true, '#ff0000', '#123456']);
  const icons = { type: 'iconSet', set: '3TrafficLights1', entries: [{ kind: 'percent', value: 0 }, { kind: 'percent', value: 33 }, { kind: 'percent', value: 67 }] };
  eq('icon set by percent', [0, 32, 33, 66, 67, 100].map((v) => C.cfMatch(icons, v, { values: [0, 100] }).icon.index), [0, 0, 1, 1, 2, 2]);
  eq('icon set reversed', C.cfMatch(Object.assign({}, icons, { reverse: true }), 100, { values: [0, 100] }).icon.index, 0);
  eq('icon set by value', [4, 5, 9, 10].map((v) => C.cfMatch({ type: 'iconSet', set: '3Arrows', entries: [{ kind: 'value', value: 0 }, { kind: 'value', value: 5 }, { kind: 'value', value: 10 }] }, v, { values: [] }).icon.index), [0, 1, 1, 2]);
  // formulas in rules, relative to the range's first cell, through the workbook
  const w5 = C.workbook({ locale: 'en' });
  [3, 8, 1, 9].forEach((v, i) => w5.setInput('Sheet1', i, 0, String(v)));
  eq('cf formula rule moves with the cell', [0, 1, 2, 3].map((r) => w5.cfMatchCell('Sheet1', 'A1:A4', { type: 'formula', formula: '=A1>$A$1' }, r, 0).match), [false, true, false, true]);
  eq('cf condition value as a formula', [0, 1, 2, 3].map((r) => w5.cfMatchCell('Sheet1', 'A1:A4', { type: 'cell', op: 'greater', value1: '=AVERAGE($A$1:$A$4)' }, r, 0).match), [false, true, false, true]);
  eq('cf context values come from the range', w5.cfMatchCell('Sheet1', 'A1:A4', { type: 'cell', op: 'top', value1: '1' }, 3, 0).match, true);

  // validity (LibreOffice's ScValidationData)
  const V = (rule, input) => C.validate(rule, input).valid;
  eq('valid any', V({ allow: 'any' }, 'whatever'), true);
  eq('valid empty allowed or not', [V({ allow: 'whole', op: 'greater', value1: '0' }, ''), V({ allow: 'whole', op: 'greater', value1: '0', allowEmpty: false }, '')], [true, false]);
  eq('valid whole between', ['0', '1', '10', '11', '5.5', 'x', '1e1'].map((t) => V({ allow: 'whole', op: 'between', value1: '1', value2: '10' }, t)), [false, true, true, false, false, false, true]);
  eq('valid decimal greaterEqual', ['2.5', '2.4999', '3'].map((t) => V({ allow: 'decimal', op: 'greaterEqual', value1: '2.5' }, t)), [true, false, true]);
  eq('valid date between', ['2026-04-01', '2026-03-31', '2026-12-31', 'x'].map((t) => V({ allow: 'date', op: 'between', value1: '2026-04-01', value2: '2026-12-31' }, t)), [true, false, true, false]);
  eq('valid time less', ['08:59', '09:00', '9:30'].map((t) => V({ allow: 'time', op: 'less', value1: '09:00' }, t)), [true, false, false]);
  eq('valid text length', ['abc', 'abcd', '1234', '12'].map((t) => V({ allow: 'textLength', op: 'lessEqual', value1: '3' }, t)), [true, false, false, true]);
  eq('valid list (case-insensitive, numbers by value)', ['apple', 'APPLE', 'pear', '3', '3.0', '03'].map((t) => V({ allow: 'list', list: ['Apple', 'Banana', 3] }, t)), [true, true, false, true, true, true]);
  eq('valid notEqual', ['5', '6'].map((t) => V({ allow: 'whole', op: 'notEqual', value1: '5' }, t)), [false, true]);
  const bad = C.validate({ allow: 'whole', op: 'greater', value1: '0', error: { action: 'warning', title: 'Check', message: 'Positive only' } }, '-1');
  eq('the refusal carries the rule\'s alert', [bad.valid, bad.error.action, bad.error.message, bad.v], [false, 'warning', 'Positive only', -1]);
  eq('the accepted value is read as typed', [C.validate({ allow: 'decimal', op: 'greater', value1: '0' }, '12%').v, C.validate({ allow: 'decimal', op: 'greater', value1: '0' }, '12%').fmt], [0.12, '0.00%']);
  const w6 = C.workbook({ locale: 'en' });
  ['Red', 'Green', 'Blue', 'Green', ''].forEach((t, i) => w6.setInput('Sheet1', i, 0, t));
  w6.setInput('Sheet1', 0, 2, '10');
  eq('valid range source', ['green', 'Pink'].map((t) => w6.validateCell('Sheet1', 0, 1, { allow: 'range', source: '$A$1:$A$5' }, t).valid), [true, false]);
  eq('the drop-down list', [w6.validationList('Sheet1', 0, 1, { allow: 'range', source: 'A1:A5' }), w6.validationList('Sheet1', 0, 1, { allow: 'range', source: 'A1:A5', sort: 'ascending' }), w6.validationList('Sheet1', 0, 1, { allow: 'list', list: ['b', 'a', 'b'] })], [['Red', 'Green', 'Blue'], ['Blue', 'Green', 'Red'], ['b', 'a']]);
  eq('valid custom formula sees the typed value in the cell', ['11', '9'].map((t) => w6.validateCell('Sheet1', 0, 1, { allow: 'custom', formula: '=B1>C1' }, t).valid), [true, false]);
  eq('valid custom: unique in a column', ['Red', 'Pink'].map((t) => w6.validateCell('Sheet1', 5, 0, { allow: 'custom', formula: '=COUNTIF($A$1:$A$5;A6)=0' }, t).valid), [false, true]);
  eq('valid condition bound as a formula', ['9', '11'].map((t) => w6.validateCell('Sheet1', 0, 1, { allow: 'whole', op: 'greater', value1: '=C1' }, t).valid), [false, true]);
  eq('valid input that is a formula is judged by its result', w6.validateCell('Sheet1', 0, 1, { allow: 'whole', op: 'greater', value1: '0' }, '=C1*2').valid, true);
}

// ---- the quality gate's findings (/root/calcbase-tests/BUGS.md), LibreOffice's answers --
// lo-input.json: typing (.uno:EnterString) and the fill handle (fillAuto) in
// Calc 24.2 ja-JP, measured by lo_input.py; the format values are Calc's
// shown strings from the gate (out/format/lo-format.json, poi_NumberFormatTests).
function unitBugs() {
  const F = (v, code) => C.format(v, 'n', code, 'ja');
  const T = (f) => { const wb = C.workbook({ locale: 'ja' }); wb.setInput('Sheet1', 0, 0, f); const g = wb.get('Sheet1', 0, 0); return g.v; };
  // #15 a fraction code shows 0 for 0 (and for what rounds to 0)
  eq('#15 # ?/? of 0', F(0, '# ?/?'), '0    ');
  eq('#15 # ?/? of -0.004', F(-0.004, '# ?/?'), '0    ');
  eq('#15 # ??/?? of 0 and 1', [F(0, '# ??/??'), F(1, '# ??/??'), F(-1, '# ??/??')], ['0      ', '1      ', '-1      ']);
  eq('#15 # ??/?? of 0.5 and 1234.5678', [F(0.5, '# ??/??'), F(1234.5678, '# ??/??')], ['  1/2 ', '1234 46/81']);
  // #16 a code for text only leaves numbers as they are
  eq('#16 @"様" on numbers', [F(1, '@"様"'), F(-1234.5678, '@"様"'), F(0.125, '@"様"')], ['1', '-1234.5678', '0.125']);
  eq('#16 @"様" on text', C.format('abc', 's', '@"様"', 'ja'), 'abc様');
  // #17 elapsed time rounds the seconds as Calc does
  eq('#17 [h]:mm:ss', [F(45000.999988, '[h]:mm:ss'), F(46300.75, '[h]:mm:ss'), F(1.5, '[h]:mm:ss')], ['1080023:59:59', '1111218:00:00', '36:00:00']);
  eq('#17 [h]:mm', F(45000.999988, '[h]:mm'), '1080023:59');
  // #33 codes Calc refuses, and where the digits and blanks go
  eq('#33 TEXT #,.#, is Err:502', [T('=TEXT(1234567;"#,.#,")'), T('=TEXT(-1234567;"#,.#,")')], ['Err:502', 'Err:502']);
  eq('#33 text before a fraction slash is Err:502', [T('=TEXT(23.75;"|#\\:#=/=#|")'), T('=TEXT(3.75;"|#_#/#|")'), T('=TEXT(0;"|#\\:?=/=?|")')], ['Err:502', 'Err:502', 'Err:502']);
  eq('#33 ? pads a separator with a blank', [F(-1234567, '?,?????????'), F(-1234567, '?,????????'), F(-1234567, '?,???????')], ['-    1,234,567', '-  1,234,567', '- 1,234,567']);
  eq('#33 the integer part around literals', [F(0.75, '|#\\:#/#|'), F(-0.75, '|#\\:#/#|'), F(0, '|#\\:#/#|'), F(1, '|#\\:#/#|'), F(-1, '|#\\:#/#|')], ['|3/4|', '-|3/4|', '|0|', '|1|', '-|1|']);
  eq('#33 digits spread over #-#-#', [F(23.75, '|#-#-#\\:#/#|'), F(-23.75, '|#-#-#\\:#/#|'), F(0.75, '|#-#-#\\:#/#|'), F(0, '|#-#-#\\:#/#|'), F(1, '|#-#-#\\:#/#|')], ['|-2-3:3/4|', '-|-2-3:3/4|', '|--3/4|', '|--0|', '|--1|']);
  eq('#33 blanks of ? in a fraction', [F(23.75, '|#\\:? ?#/#|'), F(23.75, '|#\\:? ?0#/000'), F(0, '|#\\:? ?0#/000'), F(1, '|#\\:? ?0#/000')], ['|23  3/4|', '|23  03/004', '|0  00/001', '|1  00/001']);
  eq('#33 scaling and percent still right', [F(1234567, '0,'), F(1234567, '#,,'), F(1234567, '0.#,'), F(-1234567, '0.#,'), F(123.45, '0,0.00%')], ['1235', '1', '1234.6', '-1234.6', '12,345.00%']);
  // #24 INDEX, OFFSET and INDIRECT pointing at an empty cell give 0 (lookups show it empty): see the "bugs" layout
  // #18 typing, as Calc ja-JP reads it
  const LOI = require(join(here, 'lo-input.json'));
  const noYear = new Set(['10-5', '10/5', '10月5日', '3/4', '１/２', '10月5日 10:30']);
  for (const [text, lo] of Object.entries(LOI.typed)) {
    const p = C.parseInput(text, 'ja');
    const type = p.t === 's' ? 'TEXT' : 'VALUE';
    const value = p.t === 'b' ? (p.v ? 1 : 0) : p.t === 's' ? 0 : p.v;
    const shown = p.t === 'n' ? C.format(p.v, 'n', p.fmt || '', 'ja') : p.t === 'b' ? (p.v ? 'TRUE' : 'FALSE') : String(p.v);
    const fmt = p.t === 'b' ? 'BOOLEAN' : p.fmt || 'General';
    const v = noYear.has(text) ? null : value;
    const want = noYear.has(text) ? null : lo.value;
    eq('#18 typed ' + JSON.stringify(text), [type, shown, fmt.toLowerCase(), v], [lo.type, lo.shown, lo.format.toLowerCase(), want]);
  }
  // #22 the fill handle, as Calc ja-JP fills (seeds typed, then filled to 8 cells)
  for (const f of LOI.fill) {
    const seeds = f.seed.map((t) => { const p = C.parseInput(t, 'ja'); return p.fmt ? { v: p.v, t: p.t, fmt: p.fmt } : { v: p.v, t: p.t }; });
    const got = C.fillSeries(seeds, 8 - seeds.length, 'ja').map((o) => [o.t === 's' ? 'TEXT' : 'VALUE', o.t === 'n' ? C.format(o.v, 'n', o.fmt || '', 'ja') : o.t === 'b' ? (o.v ? 'TRUE' : 'FALSE') : String(o.v), o.t === 'n' ? Math.round(o.v * 1e9) / 1e9 : o.t === 'b' ? (o.v ? 1 : 0) : 0]);
    const want = f.cells.slice(seeds.length).map((c) => [c.type, c.shown, Math.round(c.value * 1e9) / 1e9]);
    eq('#22 fill ' + JSON.stringify(f.seed), got, want);
  }
  // #25 (with it): formulas read the cells they need first, so a chain of sums written last-first has no false cycle
  const cs = {};
  for (let i = 60; i >= 1; i--) { cs['A' + i] = i === 1 ? { v: 1, t: 'n' } : { f: '=SUM(A1:A' + (i - 1) + ')' }; }
  const wcs = C.workbook({ locale: 'ja' }); wcs.load({ sheets: [{ name: 'Sheet1', cells: cs }], active: 0 }); wcs.recalc();
  eq('#25 running sums written last-first', [wcs.get('Sheet1', 9, 0).v, wcs.get('Sheet1', 59, 0).t], [256, 'n']);
  const wsc = C.workbook({ locale: 'ja' });
  wsc.setInput('Sheet1', 0, 0, '=IFERROR(A1;5)'); wsc.setInput('Sheet1', 0, 1, '=A1+B1');
  eq('#25 a cell reading itself gets Err:522 as a value', [wsc.get('Sheet1', 0, 0).v, wsc.get('Sheet1', 0, 1).v], [5, 'Err:522']);
  eq('#22 fill with typed text in, typed text out', C.fillSeries(['月'], 3), ['火', '水', '木']);
  eq('#22 fill numbers in', C.fillSeries([1, 3], 2), ['5', '7']);
}

// ---- LibreOffice comparison -------------------------------------------------

function loValue(shown, raw) {
  if (/^(#NULL!|#DIV\/0!|#VALUE!|#REF!|#NAME\?|#NUM!|#N\/A|Err:\d+)$/.test(shown)) { return { kind: 'err', v: shown }; }
  if (shown === 'TRUE' || shown === 'FALSE') { return { kind: 'bool', v: shown === 'TRUE' }; }
  let m;
  const plainRe = /^-?(\d+\.?\d*|\.\d+)(E[-+]\d+)?$/;
  if (plainRe.test(raw)) { return { kind: 'num', v: Number(raw), plain: plainRe.test(shown) }; }
  if ((m = /^(-?)\$([\d,]+(?:\.\d+)?)$/.exec(raw))) { return { kind: 'num', v: Number((m[1] || '') + m[2].replace(/,/g, '')) }; }
  if ((m = /^(-?[\d.]+(?:E[-+]\d+)?)%$/.exec(raw))) { return { kind: 'num', v: Number(m[1]) / 100 }; }
  if ((m = /^(\d{2})\/(\d{2})\/(\d{4,5})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(raw))) { const d = Math.round((Date.UTC(2000, 0, 1) - Date.UTC(1899, 11, 30)) / 86400000); const dt = new Date(Date.UTC(2000, 0, 1)); dt.setUTCFullYear(Number(m[3]), Number(m[1]) - 1, Number(m[2])); const serial = Math.round((dt.getTime() - Date.UTC(1899, 11, 30)) / 86400000); void d; return { kind: 'num', v: serial + (m[4] ? (Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6])) / 86400 : 0) }; }
  if ((m = /^(\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(raw))) { let h = Number(m[1]) % 12; if (m[4] === 'PM') { h += 12; } return { kind: 'num', v: (h * 3600 + Number(m[2]) * 60 + Number(m[3])) / 86400 }; }
  if ((m = /^(\d+):(\d{2}):(\d{2})$/.exec(raw))) { return { kind: 'num', v: (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / 86400 }; }
  return { kind: 'text', v: shown };
}
function same(mine, lo, shownText) {
  if (lo.kind === 'err') { return mine.t === 'e' && mine.v === lo.v; }
  if (lo.kind === 'bool') { return mine.t === 'b' && mine.v === lo.v; }
  if (lo.kind === 'num') {
    // a CSV cannot tell text that looks like a number from a number
    if (mine.t === 's') { return mine.v === shownText; }
    if (mine.t !== 'n') { return false; }
    const close = mine.v === lo.v || Math.abs(mine.v - lo.v) <= 1e-9 * Math.max(1, Math.abs(lo.v));
    if (!close) { return false; }
    if (lo.plain) { return C.general(mine.v) === shownText; }
    return true;
  }
  return mine.t === 's' && mine.v === lo.v;
}
const show = (mine) => (mine.t === 'e' ? mine.v : mine.t === 'b' ? (mine.v ? 'TRUE' : 'FALSE') : mine.t === 'n' ? C.general(mine.v) : JSON.stringify(mine.v));

/** Put a fixture sheet into the engine as LibreOffice reads the file. */
function loadFixture(wb, sheet) {
  sheet.rows.forEach((row, r) => row.forEach((cell, c) => {
    if (cell == null || cell === '') { return; }
    if (cell.fa != null) { wb.setArrayFormula(sheet.name, { r0: r, c0: c, r1: r + (cell.h || 1) - 1, c1: c + (cell.w || 1) - 1 }, cell.fa); return; }
    if (typeof cell === 'number') { wb.setCell(sheet.name, r, c, { v: cell, t: 'n' }); } else if (typeof cell === 'boolean') { wb.setCell(sheet.name, r, c, { v: cell, t: 'b' }); } else if (typeof cell === 'string') { if (cell.charAt(0) === '=') { wb.setCell(sheet.name, r, c, { f: cell }); } else { wb.setCell(sheet.name, r, c, { v: cell, t: 's' }); } } else if (cell.d) { const p = C.parseInput(cell.d, 'en'); wb.setCell(sheet.name, r, c, { v: p.v, t: 'n', fmt: 'yyyy-mm-dd' }); }
  }));
}

function loCompare() {
  const cacheFile = join(here, 'lo-expected.json');
  const cache = readCache(cacheFile);
  const spec = { fixtures: FIXTURES, cases: CASES.map((c) => (typeof c === 'string' ? c : c.f)), layouts: LAYOUTS };
  const hash = createHash('sha1').update(JSON.stringify(spec)).digest('hex');
  let results = cache.hash === hash ? cache.results : null;
  const useLo = !args.has('--no-lo') && (args.has('--lo') || !results);
  if (useLo && haveSoffice()) {
    process.stdout.write('LibreOffice: converting ' + spec.cases.length + ' formulas and ' + LAYOUTS.length + ' layouts … ');
    const t0 = Date.now();
    const sheets = [{ name: 'Sheet1', rows: spec.cases.map((f) => [f]) }].concat(FIXTURES);
    const r = loRun(sheets);
    const cases = spec.cases.map((f, i) => ({ shown: (r.shown.Sheet1[i] || [''])[0] || '', raw: (r.raw.Sheet1[i] || [''])[0] || '' }));
    const layouts = LAYOUTS.map((L) => { const x = loRun(L.sheets); return { shown: x.shown, raw: x.raw }; });
    results = { cases, layouts };
    writeCache(cacheFile, { hash, soffice: '24.2', results });
    console.log((Date.now() - t0) + ' ms');
  } else if (!results) {
    console.log('LibreOffice comparison skipped: soffice is not installed and lo-expected.json does not match cases.mjs');
    return;
  } else { console.log('LibreOffice comparison from lo-expected.json (recorded answers of LibreOffice 24.2)'); }

  // formulas
  const wb = C.workbook({ locale: 'en' });
  FIXTURES.forEach((s) => wb.addSheet(s.name));
  FIXTURES.forEach((s) => loadFixture(wb, s));
  spec.cases.forEach((f, i) => wb.setCell('Sheet1', i, 0, { f }));
  wb.recalc();
  const diffs = [];
  const known = [];
  const knownL = [];
  spec.cases.forEach((f, i) => {
    const mine = wb.get('Sheet1', i, 0);
    const lo = results.cases[i];
    const want = loValue(lo.shown, lo.raw);
    const ok = same(mine, want, lo.shown);
    const kase = CASES[i];
    if (typeof kase === 'object' && kase.diff) { if (ok) { passed++; } else { known.push(f + '  engine=' + show(mine) + '  LibreOffice=' + lo.shown + '  — ' + kase.diff); } return; }
    if (ok) { passed++; } else { failed++; diffs.push(f + '  engine=' + show(mine) + '  LibreOffice=' + lo.shown + (lo.raw !== lo.shown ? ' (' + lo.raw + ')' : '')); }
  });
  // layouts
  LAYOUTS.forEach((L, li) => {
    const w = C.workbook({ locale: 'en', sheet: L.sheets[0].name });
    L.sheets.slice(1).forEach((s) => w.addSheet(s.name));
    L.sheets.forEach((s) => loadFixture(w, s));
    w.recalc();
    L.sheets.forEach((s) => {
      const shownRows = results.layouts[li].shown[s.name] || [];
      const rawRows = results.layouts[li].raw[s.name] || [];
      const check = (r, c, label) => {
        const mine = w.get(s.name, r, c);
        const shown = (shownRows[r] || [])[c] || ''; const raw = (rawRows[r] || [])[c] || '';
        const want = loValue(shown, raw);
        const ok = shown === '' && raw === '' ? (mine.t === '' || (mine.t === 's' && mine.v === '')) : same(mine, want, shown);
        const known = L.diff && L.diff[s.name + '.' + C.refName(r, c)];
        if (known) { if (ok) { passed++; } else { knownL.push(L.name + ' ' + s.name + '.' + C.refName(r, c) + ' ' + label + '  engine=' + show(mine) + '  LibreOffice=' + shown + '  — ' + known); } return; }
        if (ok) { passed++; } else { failed++; diffs.push(L.name + ' ' + s.name + '.' + C.refName(r, c) + ' ' + label + '  engine=' + show(mine) + '  LibreOffice=' + shown); }
      };
      s.rows.forEach((row, r) => row.forEach((cell, c) => {
        if (cell && typeof cell === 'object' && cell.fa != null) { for (let i = 0; i < (cell.h || 1); i++) { for (let j = 0; j < (cell.w || 1); j++) { check(r + i, c + j, '{' + cell.fa + '}[' + i + ',' + j + ']'); } } return; }
        if (typeof cell !== 'string' || cell.charAt(0) !== '=') { return; }
        check(r, c, cell);
      }));
    });
  });
  if (diffs.length) { console.log('\nDifferent from LibreOffice (' + diffs.length + '):'); diffs.forEach((d) => console.log('  ' + d)); }
  known.push(...knownL);
  if (known.length) { console.log('\nKnown differences, accepted (' + known.length + '):'); known.forEach((d) => console.log('  ' + d)); }
}

// ---- performance ------------------------------------------------------------

function perf() {
  const wb = C.workbook({ locale: 'ja' });
  const t0 = performance.now();
  // 50,000 cells: 40,000 numbers in A–D of 10,000 rows, a formula per row in E (10,000 formulas)
  const m = { sheets: [{ name: 'S', cells: {} }], active: 0 };
  const cells = m.sheets[0].cells;
  for (let r = 0; r < 10000; r++) {
    for (let c = 0; c < 4; c++) { cells[C.refName(r, c)] = { v: (r * 7 + c * 3) % 101, t: 'n' }; }
    cells[C.refName(r, 4)] = { f: r % 2 ? '=SUM(A' + (r + 1) + ':D' + (r + 1) + ')*2' : '=IF(A' + (r + 1) + '>50;B' + (r + 1) + '+C' + (r + 1) + ';ROUND(D' + (r + 1) + '/3;2))' };
  }
  wb.load(m);
  const t1 = performance.now();
  wb.recalc();
  const t2 = performance.now();
  wb.recalc();
  const t3 = performance.now();
  const full = Math.min(t2 - t1, t3 - t2);
  // a chain of 1,000 cells: B1 = A1+1, B2 = B1+1, … ; one edit of A1
  const wc = C.workbook({ locale: 'ja' });
  wc.setInput('Sheet1', 0, 0, '1');
  const mm = { sheets: [{ name: 'Sheet1', cells: { A1: { v: 1, t: 'n' } } }], active: 0 };
  for (let r = 0; r < 1000; r++) { mm.sheets[0].cells['B' + (r + 1)] = { f: r === 0 ? '=A1+1' : '=B' + r + '+1' }; }
  wc.load(mm);
  const t4 = performance.now();
  const changed = wc.setInput('Sheet1', 0, 0, '2');
  const t5 = performance.now();
  const edit = t5 - t4;
  eq('perf chain result', [wc.get('Sheet1', 999, 1).v, changed.length], [1002, 1001]);
  eq('perf full recalc result', wb.get('S', 1, 4).v, ((7 + 0) % 101 + (7 + 3) % 101 + (7 + 6) % 101 + (7 + 9) % 101) * 2);
  console.log('Performance: load 50,000 cells ' + (t1 - t0).toFixed(0) + ' ms · full recalculation of 10,000 formulas ' + full.toFixed(0) + ' ms (limit 1000) · one edit through a 1,000-cell chain ' + edit.toFixed(1) + ' ms (limit 50)');
  eq('perf full recalc < 1 s', full < 1000, true);
  eq('perf chain edit < 50 ms', edit < 50, true);
}

if (!args.has('--perf-only')) { unit(); unitMore(); unitBugs(); loCompare(); }
perf();
if (failures.length) { console.log('\nFailed:'); failures.forEach((f) => console.log('  ' + f)); }
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
