/*
 * SPDX-FileCopyrightText: 2026 KTEC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * CalcBase's calculation engine: formulas as LibreOffice Calc and Excel write
 * them (=SUM(B2:B5), =Sheet2.A1*2, =IF(A1>0;"yes";"no")), a workbook of sheets
 * with a dependency graph for incremental recalculation, number formats, the
 * reading of typed input and the fill series.
 *
 * It began as EditBase's ebcalc.js and keeps that grid API (compute, formatAs,
 * literal, FUNCS) so EditBase can adopt this file later. It is bundled under its
 * own global (CalcBaseCalc) so two apps carrying a copy each never share one.
 *
 * Where Calc and Excel differ, Calc is followed, measured against LibreOffice
 * 24.2: ; and , both separate arguments, Sheet2.A1 and Sheet2!A1 are both read
 * (and each formula keeps the style it was written in when it is rewritten), a
 * circular reference is Err:522, text that does not read as a number is #VALUE!
 * in arithmetic, an empty cell is 0 in arithmetic and is not counted by COUNT or
 * AVERAGE, "General" shows 15 significant digits, booleans are numbers.
 */
(function (root) {
  'use strict';

  const MAXR = 1048576;
  const MAXC = 16384;
  const DAY0 = Date.UTC(1899, 11, 30);
  const MS_DAY = 86400000;

  const ERR = {
    DIV0: '#DIV/0!', VALUE: '#VALUE!', REF: '#REF!', NAME: '#NAME?', NA: '#N/A', NUM: '#NUM!', NULL: '#NULL!',
    CIRC: 'Err:522', PARSE: 'Err:509', PAIR: 'Err:508', MISSING: 'Err:511', ARG: 'Err:502', PARAM: 'Err:504',
    CONV: 'Err:523', SYNTAX: 'Err:520', CHAR: 'Err:501',
  };
  class CalcError { constructor(code) { this.code = code; } toString() { return this.code; } }
  const fail = (code) => { throw new CalcError(code); };
  const isErr = (v) => v instanceof CalcError;

  // ---- references ---------------------------------------------------------

  function colIndex(letters) {
    let c = 0;
    for (const ch of letters.toUpperCase()) { c = c * 26 + (ch.charCodeAt(0) - 64); }
    return c - 1;
  }
  function colName(c) {
    let s = '';
    let n = c + 1;
    while (n > 0) { const k = (n - 1) % 26; s = String.fromCharCode(65 + k) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  /** B2 or $B$2 → { r: 1, c: 1, rAbs, cAbs }; null when it is not a cell address. */
  function parseRef(text) {
    const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/.exec(String(text == null ? '' : text).trim());
    if (!m) { return null; }
    const c = colIndex(m[2]);
    const r = Number(m[4]) - 1;
    if (c >= MAXC || r < 0 || r >= MAXR) { return null; }
    return { r, c, rAbs: m[3] === '$', cAbs: m[1] === '$' };
  }
  const refName = (r, c) => colName(c) + (r + 1);
  const SIMPLE_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;
  /** A sheet name is quoted in a formula when it is not a plain word or could be read as a cell. */
  const needsQuote = (name) => !SIMPLE_NAME.test(name);
  const quoteSheet = (name) => (needsQuote(name) ? "'" + String(name).replace(/'/g, "''") + "'" : name);

  // ---- locales ------------------------------------------------------------

  const LOC = {
    en: {
      id: 'en',
      months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
      monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      am: 'AM', pm: 'PM', currency: '$', curDec: 2,
      curFmt: '$#,##0.00', pctFmt: '0.00%', dateFmt: 'mm/dd/yy', mdFmt: 'mmm dd', timeFmt: 'hh:mm:ss AM/PM',
      dtFmt: 'mm/dd/yyyy hh:mm AM/PM', dtsFmt: 'mm/dd/yyyy hh:mm:ss', dateOrder: 'MDY', fullWidth: false,
    },
    ja: {
      id: 'ja',
      months: ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'],
      monthsShort: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
      days: ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'],
      daysShort: ['日', '月', '火', '水', '木', '金', '土'],
      am: '午前', pm: '午後', currency: '¥', curDec: 0,
      curFmt: '¥#,##0', pctFmt: '0%', dateFmt: 'yyyy/mm/dd', mdFmt: 'm月d日', timeFmt: 'hh:mm:ss',
      dtFmt: 'yyyy/m/d h:mm', dtsFmt: 'yyyy/m/d h:mm:ss', dateOrder: 'YMD', fullWidth: true,
    },
  };
  const locOf = (l) => LOC[String(l || 'en').slice(0, 2).toLowerCase()] || LOC.en;

  // ---- dates --------------------------------------------------------------

  function utcDate(y, m, d) {
    const dt = new Date(0);
    dt.setUTCFullYear(y, m - 1, d);
    dt.setUTCHours(0, 0, 0, 0);
    return dt;
  }
  const ymdToSerial = (y, m, d) => Math.round((utcDate(y, m, d).getTime() - DAY0) / MS_DAY);
  function serialToYmd(n) {
    const dt = new Date(DAY0 + Math.floor(n) * MS_DAY);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  const dayOfWeek = (n) => (((Math.floor(n) + 6) % 7) + 7) % 7; // 0 = Sunday; day 0 (1899-12-30) was a Saturday
  const daysInMonth = (y, m) => utcDate(y, m + 1, 0).getUTCDate();
  const GREGORIAN = ymdToSerial(1582, 10, 15);
  const validDate = (y, m, d) => Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d) && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m) && y <= 9999 && ymdToSerial(y, m, d) >= GREGORIAN;
  /** Calc reads a two-digit year inside 1930–2029. */
  const fullYear = (y) => (y < 100 ? (y < 30 ? 2000 + y : 1900 + y) : y);
  const ERAS = [
    { from: ymdToSerial(2019, 5, 1), name: '令和', short: '令', letter: 'R' },
    { from: ymdToSerial(1989, 1, 8), name: '平成', short: '平', letter: 'H' },
    { from: ymdToSerial(1926, 12, 25), name: '昭和', short: '昭', letter: 'S' },
    { from: ymdToSerial(1912, 7, 30), name: '大正', short: '大', letter: 'T' },
    { from: ymdToSerial(1868, 1, 1), name: '明治', short: '明', letter: 'M' },
  ];
  function eraOf(n) {
    const day = Math.floor(n);
    for (const e of ERAS) { if (day >= e.from) { return { era: e, year: serialToYmd(day).y - serialToYmd(e.from).y + 1 }; } }
    return { era: { name: '西暦', short: '西', letter: 'AD' }, year: serialToYmd(day).y };
  }

  // ---- numbers as Calc shows them -----------------------------------------

  /** Calc compares with a relative tolerance of 2^-48 (rtl::math::approxEqual). */
  const approxEqual = (a, b) => a === b || Math.abs(a - b) < Math.abs(a) * 3.552713678800501e-15;
  const approxAdd = (a, b) => (((a < 0 && b > 0) || (a > 0 && b < 0)) && approxEqual(a, -b) ? 0 : a + b);
  const approxSub = (a, b) => (((a < 0 && b < 0) || (a > 0 && b > 0)) && approxEqual(a, b) ? 0 : a - b);
  /** Neumaier summation, as Calc's SUM (KahanSum). */
  class KSum {
    constructor() { this.s = 0; this.c = 0; }
    add(x) { const t = this.s + x; if (Math.abs(this.s) >= Math.abs(x)) { this.c += (this.s - t) + x; } else { this.c += (x - t) + this.s; } this.s = t; }
    get value() { return this.s + this.c; }
  }

  /** The 15 significant digits of a > 0 and the exponent of the first: a = d.dddd × 10^exp. */
  function digitsOf(a) {
    const parts = a.toExponential(14).split('e');
    return { digits: parts[0].replace('.', ''), exp: Number(parts[1]) };
  }
  /** a ≥ 0 with exactly d decimals, rounded half away from zero on the decimal digits (as Calc rounds). */
  function fixedStr(a, d) {
    if (a === 0 || !isFinite(a)) { return d > 0 ? '0.' + '0'.repeat(d) : '0'; }
    const { digits, exp } = digitsOf(a);
    let intPart;
    let frac;
    if (exp >= 0) {
      if (exp + 1 >= 15) { intPart = digits + '0'.repeat(exp + 1 - 15); frac = ''; } else { intPart = digits.slice(0, exp + 1); frac = digits.slice(exp + 1); }
    } else { intPart = '0'; frac = '0'.repeat(-exp - 1) + digits; }
    if (frac.length > d) {
      const up = frac.charCodeAt(d) >= 53;
      frac = frac.slice(0, d);
      if (up) {
        const arr = (intPart + frac).split('');
        let i = arr.length - 1;
        while (i >= 0) { if (arr[i] === '9') { arr[i] = '0'; i--; } else { arr[i] = String.fromCharCode(arr[i].charCodeAt(0) + 1); break; } }
        if (i < 0) { arr.unshift('1'); }
        const s = arr.join('');
        intPart = s.slice(0, s.length - d); frac = s.slice(s.length - d);
      }
    } else { frac = frac.padEnd(d, '0'); }
    intPart = intPart.replace(/^0+(?=\d)/, '');
    return d > 0 ? intPart + '.' + frac : intPart;
  }
  /** ROUND as Calc: half away from zero, judged on the decimal digits (1.005 → 1.01). */
  function roundHalfAway(x, d) {
    if (!isFinite(x)) { return x; }
    const sign = x < 0 ? -1 : 1;
    const a = Math.abs(x);
    if (d >= 0) { return sign * Number(fixedStr(a, Math.min(d, 20))); }
    const f = Math.pow(10, -d);
    return sign * Number(fixedStr(a / f, 0)) * f;
  }
  const stripZeros = (s) => (s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  function expStr(a, decimals, minExpDigits) {
    const parts = a.toExponential(decimals).split('e');
    const mant = stripZeros(parts[0]);
    const e = Number(parts[1]);
    return mant + 'E' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(minExpDigits, '0');
  }
  /**
   * Calc's "General": up to 15 significant digits, E notation from 1E15 (with a
   * three-digit exponent) and below 1E-10 or when the small number needs more
   * than 16 decimals (two-digit exponent), as svl's SvNumberformat does it.
   */
  function general(v) {
    if (v === 0 || !isFinite(v)) { return v === 0 ? '0' : ERR.NUM; }
    const sign = v < 0 ? '-' : '';
    const a = Math.abs(v);
    if (a >= 1) {
      if (Number.isInteger(a) && a < 9007199254740992) { return sign + String(a); }
      let e = Math.floor(Math.log10(a));
      if (Math.pow(10, e) > a) { e--; } else if (Math.pow(10, e + 1) <= a) { e++; }
      if (e >= 15) { return sign + expStr(a, 14, 3); }
      return sign + stripZeros(a.toFixed(15 - e - 1));
    }
    const e = digitsOf(a).exp;
    let fix = a > 1e-4;
    if (!fix) {
      const nExp = Math.ceil(-Math.log10(a));
      if (nExp <= 9 && approxEqual(Number(a.toFixed(16)), a)) { fix = true; }
    }
    if (fix) { return sign + stripZeros(a.toFixed(Math.min(100, 15 - e - 1))); }
    return sign + expStr(a, 14, 2);
  }

  // ---- reading what is typed ----------------------------------------------

  const normalizeWidth = (s) => s.replace(/[０-９．，／－＋￥]/g, (ch) => (ch === '￥' ? '¥' : String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)));
  const NUM_RE = /^([-+]?)(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/;
  function readNumber(s) {
    const m = NUM_RE.exec(s);
    if (!m || (m[2] == null && !m[3])) { return null; }
    const n = Number((m[1] || '') + (m[2] || '0').replace(/,/g, '') + '.' + (m[3] || '0') + (m[4] != null ? 'e' + m[4] : ''));
    if (isNaN(n)) { return null; }
    return { v: isFinite(n) ? n : (n < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE), sci: m[4] != null, dec: m[3] ? m[3].length : 0 };
  }
  function readTime(s, L) {
    const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?(?:\s*([AaPp])\.?[Mm]?\.?)?$/.exec(s);
    if (!m) { return null; }
    let h = Number(m[1]); const mi = Number(m[2]); const se = m[3] != null ? Number(m[3]) : 0;
    if (mi > 59 || se > 59) { return null; }
    const ap = m[5] ? m[5].toLowerCase() : '';
    if (ap) { if (h > 12 || h === 0) { return null; } if (ap === 'a' && h === 12) { h = 0; } else if (ap === 'p' && h < 12) { h += 12; } }
    const frac = m[4] ? Number('0.' + m[4]) : 0;
    const v = (h * 3600 + mi * 60 + se + frac) / 86400;
    const fracFmt = m[4] ? '.' + '0'.repeat(Math.min(m[4].length, 2)) : '';
    let fmt;
    if (h >= 24) { fmt = '[hh]:mm:ss' + fracFmt; } else if (ap || (L.id === 'en' && !fracFmt)) { fmt = 'hh:mm:ss' + fracFmt + ' AM/PM'; } else { fmt = 'hh:mm:ss' + fracFmt; }
    return { v, fmt, hasSec: m[3] != null, ap: !!ap };
  }
  const MONTH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i;
  function readDate(s, L) {
    let m;
    const today = serialToYmd(Math.floor((Date.now() - DAY0) / MS_DAY));
    const mk = (y, mo, d, fmt) => (validDate(y, mo, d) ? { v: ymdToSerial(y, mo, d), fmt } : null);
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) { return mk(Number(m[1]), Number(m[2]), Number(m[3]), 'yyyy-mm-dd'); }
    if (L.id === 'ja') {
      if ((m = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(s))) { return mk(fullYear(Number(m[1])), Number(m[2]), Number(m[3]), 'yyyy/mm/dd'); }
      if ((m = /^(\d{1,4})年(\d{1,2})月(\d{1,2})日$/.exec(s))) { return mk(fullYear(Number(m[1])), Number(m[2]), Number(m[3]), 'yyyy年m月d日'); }
      if ((m = /^(\d{1,2})月(\d{1,2})日$/.exec(s))) { return mk(today.y, Number(m[1]), Number(m[2]), 'm月d日'); }
      if ((m = /^(\d{1,2})[/-](\d{1,2})$/.exec(s))) { return mk(today.y, Number(m[1]), Number(m[2]), 'm月d日'); }
      return null;
    }
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{1,4})$/.exec(s))) { return mk(fullYear(Number(m[3])), Number(m[1]), Number(m[2]), 'mm/dd/yy'); }
    if ((m = /^(\d{1,2})\/(\d{1,2})$/.exec(s))) { return mk(today.y, Number(m[1]), Number(m[2]), 'mmm dd'); }
    if ((m = /^([A-Za-z]+\.?)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s)) && MONTH_RE.test(m[1])) { return mk(Number(m[3]), monthIndex(m[1]), Number(m[2]), 'mm/dd/yy'); }
    if ((m = /^([A-Za-z]+\.?)\s+(\d{1,2})$/.exec(s)) && MONTH_RE.test(m[1])) { return mk(today.y, monthIndex(m[1]), Number(m[2]), 'mmm dd'); }
    return null;
  }
  function monthIndex(word) {
    const w = word.toLowerCase().slice(0, 3);
    return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(w) + 1;
  }
  /**
   * What typed text means: a number (1,234.5 · 12% · ¥1,200 · 1e3), a date or
   * time in the locale's patterns, TRUE/FALSE, a formula (=…), text (a leading
   * apostrophe forces text), or nothing. The answer carries the number format
   * Calc would give the cell (fmt), when there is one.
   */
  function parseInput(text, locale) {
    const L = locOf(locale);
    const raw = String(text == null ? '' : text);
    if (raw === '') { return { v: null, t: '' }; }
    if (raw.charAt(0) === "'") { return { v: raw.slice(1), t: 's' }; }
    if (raw.charAt(0) === '=' && raw.length > 1) { return { v: raw, t: 'f', f: raw }; }
    let s = raw.replace(/[　\s]+/g, ' ').trim();
    if (L.fullWidth) { s = normalizeWidth(s); }
    if (s === '') { return { v: raw, t: 's' }; }
    const up = s.toUpperCase();
    if (up === 'TRUE') { return { v: true, t: 'b' }; }
    if (up === 'FALSE') { return { v: false, t: 'b' }; }
    let m;
    let n = readNumber(s);
    if (n) { return n.sci ? { v: n.v, t: 'n', fmt: '0.00E+00' } : { v: n.v, t: 'n' }; }
    if ((m = /^\((.+)\)$/.exec(s)) && (n = readNumber(m[1])) && n.v >= 0) { return { v: -n.v, t: 'n' }; }
    if ((m = /^(.+?) ?%$/.exec(s)) && (n = readNumber(m[1]))) { return { v: n.v / 100, t: 'n', fmt: L.pctFmt }; }
    if ((m = /^([-+]?)([¥$]) ?([-+]?)(.+)$/.exec(s)) && !(m[1] && m[3]) && (n = readNumber(m[4])) && n.v >= 0) {
      const neg = m[1] === '-' || m[3] === '-';
      const fmt = m[2] === '$' ? '$#,##0.00' : (n.dec ? '¥#,##0.00' : '¥#,##0');
      return { v: neg ? -n.v : n.v, t: 'n', fmt };
    }
    const dt = readDate(s, L);
    if (dt) { return { v: dt.v, t: 'n', fmt: dt.fmt }; }
    const tm = readTime(s, L);
    if (tm) { return { v: tm.v, t: 'n', fmt: tm.fmt }; }
    const sp = s.indexOf(' ');
    if (sp > 0) {
      const d2 = readDate(s.slice(0, sp), L);
      const t2 = d2 ? readTime(s.slice(sp + 1).trim(), L) : null;
      if (d2 && t2) {
        let fmt;
        if (d2.fmt === 'yyyy-mm-dd') { fmt = t2.hasSec ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd hh:mm'; } else if (L.id === 'ja') { fmt = t2.hasSec ? L.dtsFmt : L.dtFmt; } else { fmt = t2.hasSec ? L.dtsFmt : L.dtFmt; }
        return { v: d2.v + t2.v, t: 'n', fmt };
      }
    }
    return { v: raw, t: 's' };
  }
  /** Old grid API: a number when the text reads as one, otherwise the text; '' for empty. */
  function literal(text) {
    const p = parseInput(text, 'ja');
    if (p.t === '') { return ''; }
    if (p.t === 'f') { return p.v; }
    return p.v;
  }

  // ---- number formats -----------------------------------------------------
  // A format code as Calc writes it: #,##0.00 · 0% · ¥#,##0 · 0.00E+00 ·
  // yyyy/mm/dd · ggge年m月d日 · [h]:mm · @ · [Red] and ; sections.

  const COLORS = /^(black|blue|cyan|green|magenta|red|white|yellow|color\s*\d+)$/i;
  const fmtCache = new Map();
  function parseFormat(code) {
    let parsed = fmtCache.get(code);
    if (parsed) { return parsed; }
    const sections = [];
    let cur = newSection();
    let i = 0;
    const s = code;
    const push = (tok) => cur.toks.push(tok);
    while (i < s.length) {
      const ch = s[i];
      if (ch === ';') { sections.push(cur); cur = newSection(); i++; continue; }
      if (ch === '"') { let j = i + 1; let lit = ''; while (j < s.length && s[j] !== '"') { lit += s[j]; j++; } push({ k: 'lit', v: lit }); i = j + 1; continue; }
      if (ch === '\\') { push({ k: 'lit', v: s[i + 1] || '' }); i += 2; continue; }
      if (ch === '_') { push({ k: 'lit', v: ' ' }); i += 2; continue; }
      if (ch === '*') { i += 2; continue; }
      if (ch === '[') {
        const j = s.indexOf(']', i);
        const inner = j < 0 ? s.slice(i + 1) : s.slice(i + 1, j);
        i = j < 0 ? s.length : j + 1;
        let m;
        if (COLORS.test(inner)) { cur.color = inner.toLowerCase(); continue; }
        if ((m = /^(<>|>=|<=|=|>|<)\s*(-?[\d.]+)$/.exec(inner))) { cur.cond = { op: m[1], v: Number(m[2]) }; continue; }
        if ((m = /^\$([^-]*)-([0-9A-Fa-f]+)$/.exec(inner))) { if (m[1]) { push({ k: 'lit', v: m[1] }); } const lc = parseInt(m[2], 16) & 0x3ff; if (lc === 0x11) { cur.locale = 'ja'; } else if (lc === 0x09) { cur.locale = 'en'; } continue; }
        if ((m = /^(h+|m+|s+)$/i.exec(inner))) { push({ k: 'dt', v: inner.toLowerCase(), elapsed: true }); continue; }
        continue; // [NatNum1], [DBNum1], [~calendar]: not supported, dropped
      }
      if (/^general$/i.test(s.slice(i, i + 7))) { push({ k: 'general' }); i += 7; continue; }
      if (ch === '@') { push({ k: 'text' }); i++; continue; }
      if (/^(am\/pm|a\/p)/i.test(s.slice(i))) { const m = /^(am\/pm|a\/p)/i.exec(s.slice(i)); push({ k: 'dt', v: m[1].length === 5 ? 'ampm' : 'ap' }); i += m[1].length; continue; }
      if (/[0#?]/.test(ch)) { push({ k: 'dig', v: ch }); i++; continue; }
      if (ch === '.' ) { push({ k: 'point' }); i++; continue; }
      if (ch === ',') { push({ k: 'comma' }); i++; continue; }
      if (ch === '%') { push({ k: 'pct' }); i++; continue; }
      if ((ch === 'E' || ch === 'e') && (s[i + 1] === '+' || s[i + 1] === '-')) { push({ k: 'exp', sign: s[i + 1] }); i += 2; continue; }
      if (ch === '/') { push({ k: 'slash' }); i++; continue; }
      const dm = /^(y+|m+|d+|h+|s+|g+|e+|r+|n+|a+|q+|w+)/i.exec(s.slice(i));
      if (dm) { push({ k: 'dt', v: dm[1].toLowerCase() }); i += dm[1].length; continue; }
      push({ k: 'lit', v: ch }); i++;
    }
    sections.push(cur);
    sections.forEach(classify);
    parsed = { sections };
    fmtCache.set(code, parsed);
    return parsed;
  }
  function newSection() { return { toks: [], cond: null, color: null, locale: null, type: 'lit' }; }
  function classify(sec) {
    const toks = sec.toks;
    if (toks.some((t) => t.k === 'dt')) {
      sec.type = 'date';
      // m is a minute next to h or before s, otherwise a month.
      toks.forEach((t, i) => {
        if (t.k !== 'dt' || t.v[0] !== 'm') { return; }
        if (t.elapsed) { t.v = 'min' + t.v.length; return; }
        let prev = null; for (let j = i - 1; j >= 0; j--) { if (toks[j].k === 'dt') { prev = toks[j]; break; } }
        let next = null; for (let j = i + 1; j < toks.length; j++) { if (toks[j].k === 'dt') { next = toks[j]; break; } }
        const isMin = (prev && prev.v[0] === 'h') || (next && next.v[0] === 's' && !(prev && prev.v[0] === 'd' && !(next && next.v[0] === 's'))) || (prev && (prev.v === 'ampm' || prev.v === 'ap')) ;
        if (isMin) { t.v = 'min' + Math.min(t.v.length, 2); }
      });
      // .00 after seconds are fractions of a second
      toks.forEach((t, i) => {
        if (t.k === 'point') { const prev = toks[i - 1]; if (prev && prev.k === 'dt' && prev.v[0] === 's') { let n = 0; let j = i + 1; while (toks[j] && toks[j].k === 'dig') { n++; toks[j].k = 'skip'; j++; } t.k = 'secfrac'; t.n = n; } else { t.k = 'lit'; t.v = '.'; } }
        if (t.k === 'slash') { t.k = 'lit'; t.v = '/'; }
        if (t.k === 'comma') { t.k = 'lit'; t.v = ','; }
        if (t.k === 'dig') { t.k = 'lit'; }
      });
      sec.ampm = toks.some((t) => t.k === 'dt' && (t.v === 'ampm' || t.v === 'ap'));
    } else if (toks.some((t) => t.k === 'dig')) {
      sec.type = 'num';
      const ints = []; const decs = []; let seenPoint = false; let exp = null; let scale = 0; let group = false; let pct = 0; let frac = null;
      let lastDig = -1;
      toks.forEach((t, i) => { if (t.k === 'dig') { lastDig = i; } });
      const slashAt = toks.findIndex((t) => t.k === 'slash');
      if (slashAt > 0 && toks[slashAt - 1].k === 'dig' && toks[slashAt + 1] && toks[slashAt + 1].k === 'dig') {
        // a fraction: the placeholders before the slash (after a space) are the numerator
        let j = slashAt - 1; const num = []; while (j >= 0 && toks[j].k === 'dig') { num.unshift(toks[j]); toks[j].k = 'fracnum'; j--; }
        let k = slashAt + 1; const den = []; while (k < toks.length && toks[k].k === 'dig') { den.push(toks[k]); toks[k].k = 'fracden'; k++; }
        frac = { num: num.length, den: den.length };
        toks[slashAt].k = 'fracslash';
        lastDig = -1; toks.forEach((t, i2) => { if (t.k === 'dig') { lastDig = i2; } });
      }
      toks.forEach((t, i) => {
        if (t.k === 'exp') { exp = { sign: t.sign, digits: 0 }; return; }
        if (t.k === 'dig') { if (exp) { exp.digits++; t.k = 'expdig'; } else if (seenPoint) { decs.push(t.v); t.k = 'decdig'; } else { ints.push(t.v); t.k = 'intdig'; } return; }
        if (t.k === 'point' && !exp) { seenPoint = true; return; }
        if (t.k === 'pct') { pct++; return; }
        if (t.k === 'comma') {
          const prevDig = i > 0 && (toks[i - 1].k === 'intdig' || toks[i - 1].k === 'decdig' || toks[i - 1].k === 'comma');
          const nextDig = toks[i + 1] && toks[i + 1].k === 'dig';
          if (prevDig && i > lastDig && !exp) { scale++; } else if (!seenPoint && !exp && prevDig && nextDig) { group = true; } else if (!seenPoint && !exp && prevDig) { group = true; } else { t.k = 'lit'; t.v = ','; }
        }
      });
      Object.assign(sec, { ints, decs, exp, scale, group, pct, frac });
    } else if (toks.some((t) => t.k === 'text')) { sec.type = 'text'; }
    else if (toks.some((t) => t.k === 'general')) { sec.type = 'general'; }
    else { sec.type = 'lit'; }
  }
  const condHolds = (c, v) => ({ '<>': v !== c.v, '>=': v >= c.v, '<=': v <= c.v, '=': v === c.v, '>': v > c.v, '<': v < c.v }[c.op]);
  /** Which section shows a number, and whether it supplies the minus sign itself. */
  function pickSection(secs, v) {
    const conds = secs.filter((s) => s.cond);
    if (conds.length) {
      for (const s of secs) { if (s.cond && condHolds(s.cond, v)) { return { sec: s, sign: false }; } }
      const rest = secs.find((s) => !s.cond && s.type !== 'text');
      return { sec: rest || secs[0], sign: false };
    }
    const numSecs = secs.filter((s) => s.type !== 'text');
    if (numSecs.length >= 2 && v < 0) { return { sec: numSecs[1], sign: false }; }
    if (numSecs.length >= 3 && v === 0) { return { sec: numSecs[2], sign: false }; }
    return { sec: numSecs[0] || secs[0], sign: v < 0 };
  }
  function formatNumberSection(v, sec, L) {
    let a = Math.abs(v);
    if (sec.pct) { a *= 100; }
    if (sec.scale) { a /= Math.pow(1000, sec.scale); }
    const out = [];
    let intStr = ''; let decStr = ''; let expOut = ''; let fracOut = '';
    if (sec.exp) {
      const intCount = Math.max(1, sec.ints.length);
      let e = a === 0 ? 0 : digitsOf(a).exp;
      if (intCount > 1) { e = Math.floor(e / intCount) * intCount; }
      let mant = a === 0 ? 0 : a / Math.pow(10, e);
      let ms = fixedStr(mant, sec.decs.length);
      if (a !== 0 && Number(ms) >= Math.pow(10, intCount)) { e += intCount; mant = a / Math.pow(10, e); ms = fixedStr(mant, sec.decs.length); }
      const p = ms.split('.');
      intStr = p[0]; decStr = p[1] || '';
      expOut = 'E' + (e < 0 ? '-' : (sec.exp.sign === '+' ? '+' : '')) + String(Math.abs(e)).padStart(sec.exp.digits, '0');
    } else if (sec.frac) {
      const whole = sec.ints.length ? Math.floor(a) : 0;
      const rest = a - whole;
      const maxDen = Math.pow(10, sec.frac.den) - 1;
      let bestN = 0; let bestD = 1; let bestErr = rest;
      for (let d = 1; d <= maxDen; d++) { const n = Math.round(rest * d); const err = Math.abs(rest - n / d); if (err < bestErr - 1e-12) { bestErr = err; bestN = n; bestD = d; if (err < 1e-12) { break; } } }
      if (bestN === bestD) { bestN = 0; intStr = String(whole + 1); } else { intStr = whole || !sec.ints.length ? String(whole) : ''; }
      fracOut = bestN ? String(bestN).padStart(sec.frac.num, ' ') + '/' + String(bestD).padEnd(sec.frac.den, ' ') : ' '.repeat(sec.frac.num + 1 + sec.frac.den);
    } else {
      const fs = fixedStr(a, sec.decs.length);
      const p = fs.split('.');
      intStr = p[0]; decStr = p[1] || '';
    }
    // decimals: # drops trailing zeros, ? keeps the space
    if (!sec.frac) {
      let d = '';
      for (let i = sec.decs.length - 1; i >= 0; i--) {
        const ch = decStr[i] || '0';
        if (d === '' && ch === '0' && sec.decs[i] !== '0') { if (sec.decs[i] === '?') { d = ' ' + d; } continue; }
        d = ch + d;
      }
      decStr = d;
    }
    // integer part: enough zeros, grouping
    if (!sec.frac || sec.ints.length) {
      const zeros = sec.ints.filter((c) => c === '0').length;
      if (intStr === '0' && zeros === 0 && (sec.decs.length || sec.frac || sec.exp)) { intStr = ''; } else if (intStr === '0' && zeros === 0) { intStr = ''; }
      if (intStr.length < zeros) { intStr = intStr.padStart(zeros, '0'); }
      const qs = sec.ints.filter((c) => c === '?').length;
      if (intStr.length < zeros + qs) { intStr = intStr.padStart(zeros + qs, ' '); }
      if (sec.group && intStr.length > 3) { intStr = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
    }
    let intDone = false; let decDone = false; let expDone = false; let fracDone = false;
    sec.toks.forEach((t) => {
      switch (t.k) {
        case 'intdig': if (!intDone) { out.push(intStr); intDone = true; } break;
        case 'point': if (decStr !== '') { out.push('.'); } break;
        case 'decdig': if (!decDone) { out.push(decStr); decDone = true; } break;
        case 'exp': if (!expDone) { out.push(expOut); expDone = true; } break;
        case 'expdig': break;
        case 'pct': out.push('%'); break;
        case 'comma': break;
        case 'lit': out.push(t.v); break;
        case 'fracnum': if (!fracDone) { out.push(fracOut || ''); fracDone = true; } break;
        case 'fracslash': case 'fracden': break;
        case 'general': out.push(general(a)); break;
        default: break;
      }
    });
    const text = out.join('');
    const zero = !/[1-9]/.test(text.replace(/E[-+]?\d+/, ''));
    return { text, zero };
  }
  function formatDateSection(v, sec, L) {
    const n = v < 0 ? -v : v;
    const day = v < 0 ? Math.ceil(v) : Math.floor(v);
    let secs = Math.round((n - Math.floor(n)) * 86400 * 1e6) / 1e6;
    let d = day;
    if (secs >= 86400) { secs -= 86400; d += 1; }
    const ymd = serialToYmd(d);
    const whole = Math.floor(secs);
    const h = Math.floor(whole / 3600); const mi = Math.floor((whole % 3600) / 60); const s = whole % 60;
    const out = [];
    const two = (x) => String(x).padStart(2, '0');
    sec.toks.forEach((t, i) => {
      if (t.k === 'lit') { out.push(t.v); return; }
      if (t.k === 'secfrac') { const f = secs - whole; out.push(('.' + fixedStr(f, t.n).split('.')[1])); return; }
      if (t.k === 'general') { out.push(general(v)); return; }
      if (t.k !== 'dt') { return; }
      const code = t.v;
      if (t.elapsed) {
        if (code[0] === 'h') { out.push(String(Math.floor(n * 24)).padStart(code.length, '0')); } else if (code[0] === 's') { out.push(String(Math.floor(Math.round(n * 86400 * 1e6) / 1e6)).padStart(code.length, '0')); } else { out.push(String(Math.floor(n * 1440)).padStart(code.length, '0')); }
        return;
      }
      switch (code) {
        case 'yy': out.push(two(ymd.y % 100)); break;
        case 'yyyy': case 'yyy': out.push(String(ymd.y) + (code === 'yyy' ? '' : '')); break;
        case 'm': out.push(String(ymd.m)); break;
        case 'mm': out.push(two(ymd.m)); break;
        case 'mmm': out.push(L.monthsShort[ymd.m - 1]); break;
        case 'mmmm': out.push(L.months[ymd.m - 1]); break;
        case 'mmmmm': out.push(L.months[ymd.m - 1].charAt(0)); break;
        case 'min1': out.push(String(mi)); break;
        case 'min2': out.push(two(mi)); break;
        case 'd': out.push(String(ymd.d)); break;
        case 'dd': out.push(two(ymd.d)); break;
        case 'ddd': case 'nn': case 'aaa': out.push(L.daysShort[dayOfWeek(d)]); break;
        case 'dddd': case 'nnn': case 'aaaa': out.push(L.days[dayOfWeek(d)]); break;
        case 'nnnn': out.push(L.days[dayOfWeek(d)] + ', '); break;
        case 'h': case 'hh': { let hh = h; if (sec.ampm) { hh = h % 12; if (hh === 0) { hh = 12; } } out.push(code === 'hh' ? two(hh) : String(hh)); break; }
        case 's': out.push(String(s)); break;
        case 'ss': out.push(two(s)); break;
        case 'ampm': out.push(h < 12 ? L.am : L.pm); break;
        case 'ap': out.push(h < 12 ? 'a' : 'p'); break;
        case 'g': out.push(eraOf(d).era.letter); break;
        case 'gg': out.push(eraOf(d).era.short); break;
        case 'ggg': out.push(eraOf(d).era.name); break;
        case 'e': out.push(String(eraOf(d).year)); break;
        case 'ee': case 'r': out.push(two(eraOf(d).year)); break;
        case 'rr': out.push(eraOf(d).era.name + two(eraOf(d).year)); break;
        case 'q': out.push('Q' + (Math.floor((ymd.m - 1) / 3) + 1)); break;
        case 'qq': out.push(['1st', '2nd', '3rd', '4th'][Math.floor((ymd.m - 1) / 3)] + ' quarter'); break;
        case 'w': case 'ww': out.push(String(weekNum(d, 1))); break;
        default: out.push(code.length > 4 ? L.months[ymd.m - 1] : code); break;
      }
    });
    return out.join('');
  }
  /** Calc's WEEKNUM: mode 1 weeks start on Sunday, 2 on Monday, 11–17 Monday…Sunday, 21/150 ISO 8601. */
  function weekNum(day, mode) {
    const d = Math.floor(day);
    if (mode === 21 || mode === 150) {
      const wd = (dayOfWeek(d) + 6) % 7; // Monday = 0
      const thursday = d - wd + 3;
      const y = serialToYmd(thursday).y;
      const jan1 = ymdToSerial(y, 1, 1);
      return Math.floor((thursday - jan1) / 7) + 1;
    }
    let start;
    if (mode === 1) { start = 0; } else if (mode === 2 || mode === 11) { start = 1; } else if (mode >= 12 && mode <= 17) { start = (mode - 10) % 7; } else { return fail(ERR.ARG); }
    const y = serialToYmd(d).y;
    const jan1 = ymdToSerial(y, 1, 1);
    const weekStart = d - ((dayOfWeek(d) - start + 7) % 7);
    if (weekStart + 6 >= ymdToSerial(y + 1, 1, 1)) { return 1; }
    const offset = (dayOfWeek(jan1) - start + 7) % 7;
    return Math.floor((d - jan1 + offset) / 7) + 1;
  }
  /** What a value shows with a format code: the text and the colour the code asks for. */
  function formatInfo(v, t, fmt, locale) {
    let L = locOf(locale);
    const code = fmt == null ? '' : String(fmt);
    if (t === 'e' || isErr(v)) { return { text: isErr(v) ? v.code : String(v), color: null }; }
    if (v == null || v === '' && t !== 's') { if (v == null) { return { text: '', color: null }; } }
    const type = t || (typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : 's');
    if (code === '' || code === 'General') {
      if (type === 'b') { return { text: v ? 'TRUE' : 'FALSE', color: null }; }
      if (type === 'n') { return { text: general(Number(v)), color: null }; }
      return { text: String(v), color: null };
    }
    const parsed = parseFormat(code);
    const secs = parsed.sections;
    if (type === 's') {
      const ts = secs.find((s) => s.type === 'text');
      if (!ts) { return { text: String(v), color: null }; }
      return { text: ts.toks.map((tk) => (tk.k === 'text' ? String(v) : tk.k === 'lit' ? tk.v : '')).join(''), color: ts.color };
    }
    const num = type === 'b' ? (v ? 1 : 0) : Number(v);
    if (!isFinite(num)) { return { text: ERR.NUM, color: null }; }
    if (type === 'b' && secs.every((s) => s.type === 'text' || s.type === 'general')) { return { text: v ? 'TRUE' : 'FALSE', color: null }; }
    const { sec, sign } = pickSection(secs, num);
    if (sec.locale) { L = LOC[sec.locale]; }
    if (sec.type === 'date') { return { text: formatDateSection(num, sec, L), color: sec.color }; }
    if (sec.type === 'general') { return { text: sec.toks.map((tk) => (tk.k === 'general' ? general(num) : tk.k === 'lit' ? tk.v : '')).join(''), color: sec.color }; }
    if (sec.type === 'text') { return { text: sec.toks.map((tk) => (tk.k === 'text' ? general(num) : tk.k === 'lit' ? tk.v : '')).join(''), color: sec.color }; }
    if (sec.type === 'lit') { return { text: sec.toks.map((tk) => (tk.k === 'lit' ? tk.v : '')).join(''), color: sec.color }; }
    const r = formatNumberSection(num, sec, L);
    return { text: (sign && !r.zero ? '-' : '') + r.text, color: sec.color };
  }
  /**
   * format(v, t, fmt, locale) → the text a cell shows. Also the old one-argument
   * form, format(v), which is Calc's General.
   */
  function format(v, t, fmt, locale) {
    if (arguments.length <= 1) { return formatInfo(v, isErr(v) ? 'e' : typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : 's', '', 'en').text; }
    return formatInfo(v, t, fmt, locale).text;
  }
  /** Old grid API: a value with a format code ('' is General). */
  function formatAs(v, code) {
    if (isErr(v)) { return v.code; }
    const t = typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : v == null ? '' : 's';
    return formatInfo(v, t, code || '', 'ja').text;
  }
  /** The kind of a format code, for the inference of what a formula shows. */
  function fmtKind(code) {
    if (!code || code === 'General') { return ''; }
    const p = parseFormat(String(code)).sections[0];
    if (p.type === 'date') { const hasDate = p.toks.some((t) => t.k === 'dt' && /^(y|d|g|e|r|n|a|q|w|mm?m?m?m?$)/.test(t.v) && !/^min/.test(t.v)); const hasTime = p.toks.some((t) => t.k === 'dt' && (/^(h|s)/.test(t.v) || /^min/.test(t.v) || t.v === 'ampm' || t.v === 'ap')); return hasDate && hasTime ? 'datetime' : hasTime ? 'time' : 'date'; }
    if (p.type === 'num') { if (p.pct) { return 'percent'; } if (p.toks.some((t) => t.k === 'lit' && /[¥$€£]/.test(t.v))) { return 'currency'; } return 'number'; }
    return p.type;
  }

  // ---- reading a formula --------------------------------------------------
  // Tokens keep their place in the text (s, e) so a formula can be rewritten
  // reference by reference, leaving everything else as the person wrote it.

  const ERR_LIT = /^#(REF!|N\/A|NAME\?|DIV\/0!|VALUE!|NUM!|NULL!)/;
  const SHEET_PART = "(?:(\\$?)([\\p{L}_][\\p{L}\\p{N}_]*)([.!]))?";
  const CELL_PART = "(\\$?)([A-Za-z]{1,3})(\\$?)(\\d{1,7})";
  const REF_RE = new RegExp('^' + SHEET_PART + CELL_PART + '(?![\\p{L}\\p{N}_(])(?::' + SHEET_PART + CELL_PART + '(?![\\p{L}\\p{N}_(]))?', 'u');
  const COLS_RE = new RegExp('^' + SHEET_PART + '(\\$?)([A-Za-z]{1,3}):' + SHEET_PART + '(\\$?)([A-Za-z]{1,3})(?![\\p{L}\\p{N}_(])', 'u');
  const ROWS_RE = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![\d.])/;
  const SROWS_RE = new RegExp('^(\\$?)([\\p{L}_][\\p{L}\\p{N}_]*)([.!])(\\$?)(\\d{1,7}):(\\$?)(\\d{1,7})(?![\\d.])', 'u');
  const WORD_RE = /^[\p{L}_][\p{L}\p{N}_.]*/u;

  function mkSheetPart(abs, name, sep, quoted) { return name ? { abs: abs === '$', name, sep, quoted: !!quoted } : null; }
  /** The reference token after an already read, quoted sheet name ('My sheet'.A1:B2). */
  function readRefAfterSheet(src, i, sheet) {
    const rest = src.slice(i);
    let m;
    if ((m = new RegExp('^' + CELL_PART + '(?![\\p{L}\\p{N}_(])(?::' + SHEET_PART + CELL_PART + '(?![\\p{L}\\p{N}_(]))?', 'u').exec(rest))) {
      const a = cellPart(m[1], m[2], m[3], m[4]);
      if (!a) { return null; }
      const tok = { t: 'ref', sheet, a, b: null, sheetB: null, kind: 'cell' };
      if (m[8] != null) { const b = cellPart(m[8], m[9], m[10], m[11]); if (!b) { return null; } tok.b = b; tok.sheetB = mkSheetPart(m[5], m[6], m[7]); tok.kind = 'range'; }
      tok.len = m[0].length;
      return tok;
    }
    if ((m = new RegExp('^(\\$?)([A-Za-z]{1,3}):' + SHEET_PART + '(\\$?)([A-Za-z]{1,3})(?![\\p{L}\\p{N}_(])', 'u').exec(rest))) {
      const c0 = colIndex(m[2]); const c1 = colIndex(m[6]);
      if (c0 >= MAXC || c1 >= MAXC) { return null; }
      return { t: 'ref', sheet, a: { c: c0, r: -1, cAbs: m[1] === '$', rAbs: false }, b: { c: c1, r: -1, cAbs: m[5] === '$', rAbs: false }, sheetB: mkSheetPart(m[3], m[4], m[5]), kind: 'cols', len: m[0].length };
    }
    if ((m = ROWS_RE.exec(rest))) {
      const r0 = Number(m[2]) - 1; const r1 = Number(m[4]) - 1;
      if (r0 >= MAXR || r1 >= MAXR) { return null; }
      return { t: 'ref', sheet, a: { c: -1, r: r0, cAbs: false, rAbs: m[1] === '$' }, b: { c: -1, r: r1, cAbs: false, rAbs: m[3] === '$' }, sheetB: null, kind: 'rows', len: m[0].length };
    }
    return null;
  }
  function cellPart(cAbs, col, rAbs, row) {
    const c = colIndex(col); const r = Number(row) - 1;
    if (c >= MAXC || r < 0 || r >= MAXR) { return null; }
    return { c, r, cAbs: cAbs === '$', rAbs: rAbs === '$' };
  }

  function tokenize(src) {
    const out = [];
    let i = 0;
    const n = src.length;
    const push = (tok, s, e) => { tok.s = s; tok.e = e; out.push(tok); };
    while (i < n) {
      const ch = src[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '　') { i++; continue; }
      if (ch === '"') {
        let j = i + 1;
        let s = '';
        for (;;) {
          if (j >= n) { fail(ERR.PARSE); }
          if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
          s += src[j]; j++;
        }
        push({ t: 'str', v: s }, i, j + 1);
        i = j + 1;
        continue;
      }
      if (ch === "'") {
        let j = i + 1;
        let name = '';
        for (;;) {
          if (j >= n) { fail(ERR.PARSE); }
          if (src[j] === "'") { if (src[j + 1] === "'") { name += "'"; j += 2; continue; } break; }
          name += src[j]; j++;
        }
        j++;
        const sep = src[j];
        if (sep !== '.' && sep !== '!') { fail(ERR.PARSE); }
        const tok = readRefAfterSheet(src, j + 1, { abs: false, name, sep, quoted: true });
        if (!tok) { fail(ERR.PARSE); }
        push(tok, i, j + 1 + tok.len);
        i = j + 1 + tok.len;
        continue;
      }
      if (ch === '#') {
        const m = ERR_LIT.exec(src.slice(i));
        if (m) { push({ t: 'err', v: m[0] }, i, i + m[0].length); i += m[0].length; continue; }
        fail(ERR.CHAR);
      }
      const rest = src.slice(i);
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        const prev = out[out.length - 1];
        const mr = ROWS_RE.exec(rest);
        if (mr && !(prev && (prev.t === 'ref' || prev.t === 'num' || (prev.t === 'op' && prev.v === ')')))) {
          const r0 = Number(mr[2]) - 1; const r1 = Number(mr[4]) - 1;
          if (r0 < MAXR && r1 < MAXR) {
            push({ t: 'ref', sheet: null, a: { c: -1, r: r0, cAbs: false, rAbs: mr[1] === '$' }, b: { c: -1, r: r1, cAbs: false, rAbs: mr[3] === '$' }, sheetB: null, kind: 'rows' }, i, i + mr[0].length);
            i += mr[0].length;
            continue;
          }
        }
        const num = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(rest);
        push({ t: 'num', v: Number(num[0]) }, i, i + num[0].length);
        i += num[0].length;
        continue;
      }
      if (ch === '$' || /[\p{L}_]/u.test(ch)) {
        let m = REF_RE.exec(rest);
        if (m) {
          const a = cellPart(m[4], m[5], m[6], m[7]);
          if (a) {
            const tok = { t: 'ref', sheet: mkSheetPart(m[1], m[2], m[3]), a, b: null, sheetB: null, kind: 'cell' };
            if (m[11] != null) { const b = cellPart(m[11], m[12], m[13], m[14]); if (b) { tok.b = b; tok.sheetB = mkSheetPart(m[8], m[9], m[10]); tok.kind = 'range'; } else { m = null; } }
            if (m) { push(tok, i, i + m[0].length); i += m[0].length; continue; }
          }
        }
        if ((m = COLS_RE.exec(rest))) {
          const c0 = colIndex(m[5]); const c1 = colIndex(m[10]);
          if (c0 < MAXC && c1 < MAXC) {
            push({ t: 'ref', sheet: mkSheetPart(m[1], m[2], m[3]), a: { c: c0, r: -1, cAbs: m[4] === '$', rAbs: false }, b: { c: c1, r: -1, cAbs: m[9] === '$', rAbs: false }, sheetB: mkSheetPart(m[6], m[7], m[8]), kind: 'cols' }, i, i + m[0].length);
            i += m[0].length;
            continue;
          }
        }
        if ((m = SROWS_RE.exec(rest))) {
          const r0 = Number(m[5]) - 1; const r1 = Number(m[7]) - 1;
          if (r0 < MAXR && r1 < MAXR) {
            push({ t: 'ref', sheet: mkSheetPart(m[1], m[2], m[3]), a: { c: -1, r: r0, cAbs: false, rAbs: m[4] === '$' }, b: { c: -1, r: r1, cAbs: false, rAbs: m[6] === '$' }, sheetB: null, kind: 'rows' }, i, i + m[0].length);
            i += m[0].length;
            continue;
          }
        }
        if (ch === '$') { fail(ERR.CHAR); }
        m = WORD_RE.exec(rest);
        push({ t: 'word', v: m[0] }, i, i + m[0].length);
        i += m[0].length;
        continue;
      }
      const two = src.slice(i, i + 2);
      if (two === '<>' || two === '<=' || two === '>=') { push({ t: 'op', v: two }, i, i + 2); i += 2; continue; }
      if ('+-*/^&=<>%(),;:{}|'.indexOf(ch) >= 0) { push({ t: 'op', v: ch }, i, i + 1); i++; continue; }
      fail(ERR.CHAR);
    }
    return out;
  }

  const VOLATILE = new Set(['NOW', 'TODAY', 'RAND', 'RANDBETWEEN', 'OFFSET', 'INDIRECT']);
  const FN_PREFIX = /^(COM\.MICROSOFT\.|ORG\.OPENOFFICE\.|COM\.SUN\.STAR\.SHEET\.ADDIN\.ANALYSIS\.GET|_XLFN\.|_XLWS\.)/i;

  /**
   * Recursive descent with Calc's order: comparison < & < + - < * / < ^ < unary
   * minus < % postfix. A missing closing parenthesis is supplied, as Calc does.
   */
  function parse(src) {
    const toks = tokenize(src);
    let k = 0;
    let depth = 0;
    const info = { volatile: false, refs: [] };
    const peek = () => toks[k];
    const isOp = (t, v) => t && t.t === 'op' && t.v === v;
    const take = (v) => { if (isOp(toks[k], v)) { k++; return true; } return false; };
    const missing = () => fail(depth > 0 ? ERR.MISSING : ERR.SYNTAX);
    const cmp = () => {
      let a = concat();
      for (;;) {
        const t = peek();
        if (t && t.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].indexOf(t.v) >= 0) { k++; a = { k: 'bin', op: t.v, a, b: concat() }; } else { return a; }
      }
    };
    const concat = () => { let a = add(); while (take('&')) { a = { k: 'bin', op: '&', a, b: add() }; } return a; };
    const add = () => {
      let a = mul();
      for (;;) {
        if (take('+')) { a = { k: 'bin', op: '+', a, b: mul() }; } else if (take('-')) { a = { k: 'bin', op: '-', a, b: mul() }; } else { return a; }
      }
    };
    const mul = () => {
      let a = pow();
      for (;;) {
        if (take('*')) { a = { k: 'bin', op: '*', a, b: pow() }; } else if (take('/')) { a = { k: 'bin', op: '/', a, b: pow() }; } else { return a; }
      }
    };
    const pow = () => { let a = unary(); while (take('^')) { a = { k: 'bin', op: '^', a, b: unary() }; } return a; };
    const unary = () => {
      if (take('-')) { return { k: 'neg', a: unary() }; }
      if (take('+')) { return unary(); }
      return percent();
    };
    const percent = () => { let a = atom(); while (take('%')) { a = { k: 'pct', a }; } return a; };
    const sepAhead = () => { const t = peek(); return !t || (t.t === 'op' && (t.v === ';' || t.v === ',' || t.v === ')')); };
    const atom = () => {
      const t = toks[k++];
      if (!t) { k--; return missing(); }
      if (t.t === 'num') { return { k: 'num', v: t.v }; }
      if (t.t === 'str') { return { k: 'str', v: t.v }; }
      if (t.t === 'err') { return { k: 'err', v: t.v }; }
      if (t.t === 'ref') { info.refs.push(t); return { k: 'ref', tok: t }; }
      if (t.t === 'op' && t.v === '(') { depth++; const e = cmp(); depth--; if (!take(')')) { if (peek()) { fail(ERR.PARSE); } } return e; }
      if (t.t === 'op' && t.v === '{') { return array(); }
      if (t.t === 'word') {
        const w = t.v;
        if (take('(')) {
          const name = w.toUpperCase().replace(FN_PREFIX, '');
          if (VOLATILE.has(name)) { info.volatile = true; }
          const args = [];
          depth++;
          if (!take(')')) {
            for (;;) {
              args.push(sepAhead() ? { k: 'empty' } : cmp());
              if (take(')')) { break; }
              if (!(take(';') || take(','))) { if (!peek()) { break; } fail(ERR.PARSE); }
            }
          }
          depth--;
          return { k: 'fn', name, args };
        }
        const up = w.toUpperCase();
        if (up === 'TRUE') { return { k: 'bool', v: true }; }
        if (up === 'FALSE') { return { k: 'bool', v: false }; }
        return { k: 'name', v: w };
      }
      if (t.t === 'op' && t.v === ')') { fail(ERR.PAIR); }
      if (t.t === 'op' && (t.v === ';' || t.v === ',')) { k--; return missing(); }
      k--;
      return missing();
    };
    const array = () => {
      // {1;2;3} is a row in Calc, {1,2;3,4} two rows in Excel, {1;2|3;4} two rows in Calc.
      const items = [];
      const seps = [];
      for (;;) {
        const t = peek();
        if (!t) { fail(ERR.PAIR); }
        if (isOp(t, '}')) { k++; break; }
        if (t.t === 'op' && (t.v === ';' || t.v === ',' || t.v === '|')) { seps.push(t.v); k++; continue; }
        let neg = false;
        if (take('-')) { neg = true; }
        const e = toks[k++];
        if (!e) { fail(ERR.PAIR); }
        let v;
        if (e.t === 'num') { v = neg ? -e.v : e.v; } else if (e.t === 'str') { v = e.v; } else if (e.t === 'word' && /^(TRUE|FALSE)$/i.test(e.v)) { v = e.v.toUpperCase() === 'TRUE'; } else if (e.t === 'err') { v = new CalcError(e.v); } else { fail(ERR.PARSE); }
        items.push(v);
      }
      const hasBar = seps.indexOf('|') >= 0;
      const hasComma = seps.indexOf(',') >= 0;
      const hasSemi = seps.indexOf(';') >= 0;
      const rowSep = hasBar ? '|' : (hasComma && hasSemi ? ';' : null);
      const rows = [[]];
      items.forEach((v, idx) => { if (idx > 0) { if (seps[idx - 1] === rowSep) { rows.push([]); } } rows[rows.length - 1].push(v); });
      if (rows.some((r) => r.length !== rows[0].length)) { fail(ERR.PARSE); }
      return { k: 'array', rows };
    };
    if (!toks.length) { fail(ERR.SYNTAX); }
    const tree = cmp();
    if (k !== toks.length) { const t = toks[k]; fail(t.t === 'op' && t.v === ')' ? ERR.PAIR : ERR.PARSE); }
    tree.info = info;
    return tree;
  }

  // ---- values -------------------------------------------------------------
  // A cell holds a number, a string, a boolean, an error or nothing (null). A
  // reference evaluates to a RangeVal; an inline array to an ArrayVal.

  class RangeVal { constructor(sheet, r0, c0, r1, c1) { this.sheet = sheet; this.r0 = r0; this.c0 = c0; this.r1 = r1; this.c1 = c1; } get single() { return this.r0 === this.r1 && this.c0 === this.c1; } }
  class ArrayVal { constructor(rows) { this.rows = rows; } get h() { return this.rows.length; } get w() { return this.rows[0] ? this.rows[0].length : 0; } }

  const typeOf = (v) => (v == null ? '' : typeof v === 'number' ? 'n' : typeof v === 'string' ? 's' : typeof v === 'boolean' ? 'b' : isErr(v) ? 'e' : 'x');

  /** Text to number as Calc's operators do it (locale-dependent conversion). */
  function textToNum(s, L) {
    const p = parseInput(s, L.id);
    if (p.t === 'n') { return p.v; }
    if (p.t === 'b') { return p.v ? 1 : 0; }
    return fail(ERR.VALUE);
  }
  const toNum = (v, L) => {
    if (typeof v === 'number') { return v; }
    if (v == null) { return 0; }
    if (typeof v === 'boolean') { return v ? 1 : 0; }
    if (isErr(v)) { throw v; }
    if (typeof v === 'string') { return textToNum(v, L || LOC.en); }
    return fail(ERR.VALUE);
  };
  const toText = (v) => {
    if (typeof v === 'string') { return v; }
    if (v == null) { return ''; }
    if (typeof v === 'number') { return general(v); }
    if (typeof v === 'boolean') { return v ? '1' : '0'; }
    if (isErr(v)) { throw v; }
    return fail(ERR.VALUE);
  };
  const toBool = (v, L) => {
    if (typeof v === 'boolean') { return v; }
    if (typeof v === 'number') { return v !== 0; }
    if (v == null) { return false; }
    if (isErr(v)) { throw v; }
    if (typeof v === 'string') { return textToNum(v, L || LOC.en) !== 0; }
    return fail(ERR.VALUE);
  };
  const coll = new Map();
  function collator(L) {
    let c = coll.get(L.id);
    if (!c) { c = new Intl.Collator(L.id === 'ja' ? 'ja' : 'en'); coll.set(L.id, c); }
    return c;
  }
  /** Calc's ordering: numbers (booleans among them) before text; empty is 0 or "". */
  function compare(a, b, L) {
    if (isErr(a)) { throw a; }
    if (isErr(b)) { throw b; }
    if (typeof a === 'boolean') { a = a ? 1 : 0; }
    if (typeof b === 'boolean') { b = b ? 1 : 0; }
    const sa = typeof a === 'string'; const sb = typeof b === 'string';
    if (a == null) { a = sb ? '' : 0; }
    if (b == null) { b = sa ? '' : 0; }
    if (typeof a === 'number' && typeof b === 'number') { return approxEqual(a, b) ? 0 : a < b ? -1 : 1; }
    if (typeof a === 'number') { return -1; }
    if (typeof b === 'number') { return 1; }
    if (a === b) { return 0; }
    const c = collator(L).compare(a, b);
    return c < 0 ? -1 : c > 0 ? 1 : 0;
  }

  // ---- criteria (COUNTIF, SUMIF, …) ---------------------------------------

  const wildCache = new Map();
  /** A pattern with * ? and ~ (escape) as a whole-cell, case-insensitive test. */
  function wildcard(p) {
    let re = wildCache.get(p);
    if (!re) {
      let s = '';
      for (let i = 0; i < p.length; i++) {
        const ch = p[i];
        if (ch === '~' && i + 1 < p.length) { s += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); } else if (ch === '*') { s += '.*'; } else if (ch === '?') { s += '.'; } else { s += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
      }
      re = new RegExp('^' + s + '$', 'is');
      wildCache.set(p, re);
    }
    return re;
  }
  const hasWild = (p) => /[*?~]/.test(p);
  /**
   * A criterion as COUNTIF writes it: ">5", "<>x", "apple", "a*", 3, TRUE. The
   * answer is a test on a cell's value (null for empty).
   */
  function criterion(c, L) {
    if (isErr(c)) { throw c; }
    if (typeof c === 'boolean') { c = c ? 1 : 0; }
    if (typeof c === 'number') { return (v) => (typeof v === 'number' || typeof v === 'boolean') && approxEqual(toNum(v), c); }
    const s = c == null ? '' : String(c);
    const m = /^(<>|>=|<=|=|>|<)?\s*(.*)$/s.exec(s);
    const op = m[1] || '=';
    const rhs = m[2];
    if (rhs === '') {
      if (op === '<>') { return (v) => v != null; }
      if (op === '=') { return (v) => v == null || v === ''; }
      return () => false;
    }
    const p = parseInput(rhs, L.id);
    if (p.t === 'n' || p.t === 'b') {
      const n = p.t === 'b' ? (p.v ? 1 : 0) : p.v;
      return (v) => {
        if (typeof v === 'boolean') { v = v ? 1 : 0; }
        if (typeof v !== 'number') { return op === '<>'; }
        return { '=': approxEqual(v, n), '<>': !approxEqual(v, n), '>': v > n, '<': v < n, '>=': v >= n || approxEqual(v, n), '<=': v <= n || approxEqual(v, n) }[op];
      };
    }
    if (op === '=' || op === '<>') {
      const re = hasWild(rhs) ? wildcard(rhs) : null;
      const low = rhs.toLowerCase();
      const eq = (v) => {
        if (v == null) { return false; }
        const t = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : toText(v);
        return re ? re.test(t) : t.toLowerCase() === low;
      };
      return op === '=' ? eq : (v) => !eq(v);
    }
    return (v) => {
      if (typeof v !== 'string') { return false; }
      const d = compare(v, rhs, L);
      return { '>': d > 0, '<': d < 0, '>=': d >= 0, '<=': d <= 0 }[op];
    };
  }

  // ---- evaluation ---------------------------------------------------------

  /** The cells of a range, clamped to the sheet's used area so A:A does not walk a million rows. */
  function eachCell(rv, fn) {
    const sh = rv.sheet;
    const r1 = Math.min(rv.r1, sh.maxR); const c1 = Math.min(rv.c1, sh.maxC);
    if (r1 < rv.r0 || c1 < rv.c0) { return; }
    const area = (r1 - rv.r0 + 1) * (c1 - rv.c0 + 1);
    if (area > 4 * sh.cells.size + 64) {
      const list = [];
      for (const cell of sh.cells.values()) { if (cell.r >= rv.r0 && cell.r <= r1 && cell.c >= rv.c0 && cell.c <= c1) { list.push(cell); } }
      list.sort((a, b) => a.r - b.r || a.c - b.c);
      for (const cell of list) { fn(cell.r, cell.c); }
      return;
    }
    for (let r = rv.r0; r <= r1; r++) { for (let c = rv.c0; c <= c1; c++) { fn(r, c); } }
  }

  /** Evaluate in a scalar place: a range becomes one cell (implicit intersection), an array its first element. */
  function deref(v, ctx) {
    if (v instanceof RangeVal) {
      let x;
      if (v.single) { x = ctx.cellValue(v.sheet, v.r0, v.c0); } else if (v.c0 === v.c1 && ctx.at.r >= v.r0 && ctx.at.r <= v.r1 && v.sheet === ctx.sheet) { x = ctx.cellValue(v.sheet, ctx.at.r, v.c0); } else if (v.r0 === v.r1 && ctx.at.c >= v.c0 && ctx.at.c <= v.c1 && v.sheet === ctx.sheet) { x = ctx.cellValue(v.sheet, v.r0, ctx.at.c); } else { return fail(ERR.VALUE); }
      if (isErr(x)) { throw x; }
      return x;
    }
    if (v instanceof ArrayVal) { const x = v.rows[0] ? v.rows[0][0] : null; if (isErr(x)) { throw x; } return x; }
    if (isErr(v)) { throw v; }
    return v;
  }
  function resolveRef(tok, ctx) {
    const sh = tok.sheet ? ctx.wb.sheetByName(tok.sheet.name) : ctx.sheet;
    if (!sh) { return fail(ERR.REF); }
    if (tok.sheetB && tok.sheetB.name.toLowerCase() !== (tok.sheet ? tok.sheet.name : ctx.sheet.name).toLowerCase()) { return fail(ERR.REF); }
    const a = tok.a; const b = tok.b || tok.a;
    let r0; let c0; let r1; let c1;
    if (tok.kind === 'cols') { r0 = 0; r1 = MAXR - 1; c0 = Math.min(a.c, b.c); c1 = Math.max(a.c, b.c); } else if (tok.kind === 'rows') { c0 = 0; c1 = MAXC - 1; r0 = Math.min(a.r, b.r); r1 = Math.max(a.r, b.r); } else { r0 = Math.min(a.r, b.r); r1 = Math.max(a.r, b.r); c0 = Math.min(a.c, b.c); c1 = Math.max(a.c, b.c); }
    const gb = ctx.wb.gridBounds;
    if (gb && (r1 >= gb.rows || c1 >= gb.cols) && tok.kind === 'cell') { return fail(ERR.REF); }
    return new RangeVal(sh, r0, c0, r1, c1);
  }
  function ev(n, ctx) {
    switch (n.k) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'err': return fail(n.v);
      case 'empty': return null;
      case 'ref': return resolveRef(n.tok, ctx);
      case 'array': return new ArrayVal(n.rows);
      case 'name': return fail(ERR.NAME);
      case 'neg': return -toNum(deref(ev(n.a, ctx), ctx), ctx.L);
      case 'pct': return toNum(deref(ev(n.a, ctx), ctx), ctx.L) / 100;
      case 'fn': {
        const f = FN[n.name];
        if (!f) { return fail(ERR.NAME); }
        const ar = ARITY[n.name];
        if (ar) { const cnt = n.args.length; if (cnt < ar[0]) { return fail(ERR.MISSING); } if (ar[1] >= 0 && cnt > ar[1]) { return fail(ERR.PAIR); } }
        return f(new Args(n.args, ctx), ctx);
      }
      case 'bin': return binop(n.op, deref(ev(n.a, ctx), ctx), deref(ev(n.b, ctx), ctx), ctx.L);
      default: return fail(ERR.PARSE);
    }
  }
  function binop(op, a, b, L) {
    switch (op) {
      case '+': return approxAdd(toNum(a, L), toNum(b, L));
      case '-': return approxSub(toNum(a, L), toNum(b, L));
      case '*': return toNum(a, L) * toNum(b, L);
      case '/': { const d = toNum(b, L); const x = toNum(a, L); return d === 0 ? fail(ERR.DIV0) : x / d; }
      case '^': return power(toNum(a, L), toNum(b, L));
      case '&': return toText(a) + toText(b);
      default: {
        const c = compare(a, b, L);
        return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[op];
      }
    }
  }
  function power(a, b) {
    if (a === 0 && b === 0) { return 1; }
    let v = Math.pow(a, b);
    if (isNaN(v) && a < 0 && !Number.isInteger(b)) {
      // Calc takes the odd root of a negative number: POWER(-8;1/3) = -2.
      const inv = 1 / b;
      if (approxEqual(inv, Math.round(inv)) && Math.round(inv) % 2 !== 0) { v = -Math.pow(-a, b); } else { return fail(ERR.ARG); }
    }
    if (isNaN(v)) { return fail(ERR.ARG); }
    if (!isFinite(v)) { return fail(ERR.NUM); }
    return v;
  }
  /** Evaluate for an array place (SUMPRODUCT): ranges and arrays stay whole, operators work element by element. */
  function evArray(n, ctx) {
    if (n.k === 'ref') { return toArray(resolveRef(n.tok, ctx), ctx); }
    if (n.k === 'array') { return new ArrayVal(n.rows); }
    if (n.k === 'bin') {
      const a = evArray(n.a, ctx); const b = evArray(n.b, ctx);
      return zip(a, b, (x, y) => binop(n.op, x, y, ctx.L));
    }
    if (n.k === 'neg') { return mapA(evArray(n.a, ctx), (x) => -toNum(x, ctx.L)); }
    if (n.k === 'pct') { return mapA(evArray(n.a, ctx), (x) => toNum(x, ctx.L) / 100); }
    const v = ev(n, ctx);
    return v instanceof RangeVal ? toArray(v, ctx) : v;
  }
  function toArray(rv, ctx) {
    const rows = [];
    const r1 = Math.min(rv.r1, rv.sheet.maxR); const c1 = Math.min(rv.c1, rv.sheet.maxC);
    for (let r = rv.r0; r <= Math.max(r1, rv.r0); r++) { const row = []; for (let c = rv.c0; c <= Math.max(c1, rv.c0); c++) { row.push(ctx.cellValue(rv.sheet, r, c)); } rows.push(row); }
    return new ArrayVal(rows);
  }
  const mapA = (a, f) => (a instanceof ArrayVal ? new ArrayVal(a.rows.map((row) => row.map((x) => safe(() => f(x))))) : safe(() => f(a)));
  function safe(f) { try { return f(); } catch (e) { if (isErr(e)) { return e; } throw e; } }
  function zip(a, b, f) {
    const aa = a instanceof ArrayVal; const bb = b instanceof ArrayVal;
    if (!aa && !bb) { return f(a, b); }
    const h = aa ? a.h : b.h; const w = aa ? a.w : b.w;
    if (aa && bb && (a.h !== b.h || a.w !== b.w)) { return fail(ERR.VALUE); }
    const rows = [];
    for (let r = 0; r < h; r++) { const row = []; for (let c = 0; c < w; c++) { row.push(safe(() => f(aa ? a.rows[r][c] : a, bb ? b.rows[r][c] : b))); } rows.push(row); }
    return new ArrayVal(rows);
  }

  /** The arguments of a function, read as the function needs them. */
  class Args {
    constructor(nodes, ctx) { this.nodes = nodes; this.ctx = ctx; this.L = ctx.L; }
    get n() { return this.nodes.length; }
    has(i) { return i < this.nodes.length && this.nodes[i].k !== 'empty'; }
    raw(i) { return ev(this.nodes[i], this.ctx); }
    val(i) { return deref(ev(this.nodes[i], this.ctx), this.ctx); }
    num(i, def) { if (!this.has(i)) { if (def !== undefined) { return def; } if (i < this.nodes.length) { return 0; } return fail(ERR.MISSING); } return toNum(this.val(i), this.L); }
    int(i, def) { const v = this.num(i, def); return Math.trunc(v); }
    str(i, def) { if (!this.has(i)) { if (def !== undefined) { return def; } if (i < this.nodes.length) { return ''; } return fail(ERR.MISSING); } return toText(this.val(i)); }
    bool(i, def) { if (!this.has(i)) { if (def !== undefined) { return def; } return false; } return toBool(this.val(i), this.L); }
    /** A reference argument (ranges for lookups, INDEX, ROWS …). */
    ref(i, code) { const v = this.raw(i); if (v instanceof RangeVal) { return v; } if (isErr(v)) { throw v; } return fail(code || ERR.PARAM); }
    arr(i) { return evArray(this.nodes[i], this.ctx); }
    /** Every value the arguments give: cells opened out (ref: true), inline values as typed (ref: false). */
    items(from, to) {
      const out = [];
      const end = to === undefined ? this.nodes.length : to;
      for (let i = from || 0; i < end; i++) {
        const node = this.nodes[i];
        if (node.k === 'empty') { out.push({ v: null, ref: false }); continue; }
        const v = ev(node, this.ctx);
        if (v instanceof RangeVal) { eachCell(v, (r, c) => { out.push({ v: this.ctx.cellValue(v.sheet, r, c), ref: true }); }); } else if (v instanceof ArrayVal) { v.rows.forEach((row) => row.forEach((x) => out.push({ v: x, ref: true }))); } else { out.push({ v, ref: false }); }
      }
      return out;
    }
    /** The numbers among the arguments: from cells only real numbers (and booleans); typed in, anything that reads as one. */
    numbers(from, to, strict) {
      const out = [];
      for (const it of this.items(from, to)) {
        const v = it.v;
        if (isErr(v)) { throw v; }
        if (it.ref) { if (typeof v === 'number') { out.push(v); } else if (typeof v === 'boolean') { out.push(v ? 1 : 0); } continue; }
        if (v == null) { out.push(0); continue; }
        if (typeof v === 'string') { return fail(strict ? ERR.PARAM : ERR.VALUE); }
        out.push(toNum(v, this.L));
      }
      return out;
    }
  }
  const ksum = (nums) => { const k = new KSum(); nums.forEach((x) => k.add(x)); return k.value; };

  // ---- functions ----------------------------------------------------------

  const FN = {};
  /** [min, max] arguments; -1 = any number. Too few is Err:511, too many Err:508, as Calc says. */
  const ARITY = {};
  function def(name, min, max, f) { FN[name] = f; ARITY[name] = [min, max]; }

  const intArg = (x) => Math.trunc(x);
  const checkFinite = (v) => (isFinite(v) ? v : fail(ERR.NUM));
  /** The criteria pairs of SUMIFS-like functions, with the ranges checked to be the same shape. */
  function criteriaPairs(A, from, shape) {
    const pairs = [];
    for (let i = from; i + 1 < A.n || i < A.n; i += 2) {
      const rng = A.ref(i, ERR.ARG);
      if (!shape) { shape = rng; }
      if (shape && (rng.r1 - rng.r0 !== shape.r1 - shape.r0 || rng.c1 - rng.c0 !== shape.c1 - shape.c0)) { return fail(ERR.ARG); }
      pairs.push({ rng, ok: criterion(A.has(i + 1) ? A.val(i + 1) : null, A.L) });
    }
    return pairs;
  }
  function matchingCells(A, sumRange, from, ctx) {
    const pairs = criteriaPairs(A, from, sumRange);
    const out = [];
    const first = pairs[0].rng;
    eachCell(first, (r, c) => {
      const dr = r - first.r0; const dc = c - first.c0;
      for (const p of pairs) { if (!p.ok(ctx.cellValue(p.rng.sheet, p.rng.r0 + dr, p.rng.c0 + dc))) { return; } }
      out.push(sumRange ? ctx.cellValue(sumRange.sheet, sumRange.r0 + dr, sumRange.c0 + dc) : true);
    });
    return out;
  }
  /** SUMIF's sum range is only an anchor: it takes the shape of the test range. */
  function anchored(rng, shape) { return new RangeVal(rng.sheet, rng.r0, rng.c0, rng.r0 + (shape.r1 - shape.r0), rng.c0 + (shape.c1 - shape.c0)); }
  const numsOf = (vals) => vals.filter((v) => typeof v === 'number');

  // math
  def('SUM', 0, -1, (A) => ksum(A.numbers()));
  def('PRODUCT', 1, -1, (A) => A.numbers().reduce((s, n) => s * n, 1));
  def('ABS', 1, 1, (A) => Math.abs(A.num(0)));
  def('SIGN', 1, 1, (A) => Math.sign(A.num(0)));
  def('SQRT', 1, 1, (A) => { const n = A.num(0); return n < 0 ? fail(ERR.ARG) : Math.sqrt(n); });
  def('POWER', 2, 2, (A) => power(A.num(0), A.num(1)));
  def('EXP', 1, 1, (A) => checkFinite(Math.exp(A.num(0))));
  def('LN', 1, 1, (A) => { const n = A.num(0); return n <= 0 ? fail(ERR.ARG) : Math.log(n); });
  def('LOG10', 1, 1, (A) => { const n = A.num(0); return n <= 0 ? fail(ERR.ARG) : Math.log10(n); });
  def('LOG', 1, 2, (A) => { const n = A.num(0); const b = A.has(1) ? A.num(1) : 10; if (n <= 0 || b <= 0 || b === 1) { return fail(ERR.ARG); } return b === 10 ? Math.log10(n) : Math.log(n) / Math.log(b); });
  def('PI', 0, 0, () => Math.PI);
  def('INT', 1, 1, (A) => { const n = A.num(0); const r = Math.round(n); return approxEqual(n, r) ? r : Math.floor(n); });
  def('ROUND', 1, 2, (A) => roundHalfAway(A.num(0), A.has(1) ? intArg(A.num(1)) : 0));
  const roundDir = (n, d, up) => { const f = Math.pow(10, d); const sc = Math.abs(n) * f; const r = Math.round(sc); const v = approxEqual(sc, r) ? r : (up ? Math.ceil(sc) : Math.floor(sc)); return Math.sign(n) * v / f; };
  def('ROUNDUP', 1, 2, (A) => roundDir(A.num(0), A.has(1) ? intArg(A.num(1)) : 0, true));
  def('ROUNDDOWN', 1, 2, (A) => roundDir(A.num(0), A.has(1) ? intArg(A.num(1)) : 0, false));
  def('TRUNC', 1, 2, (A) => roundDir(A.num(0), A.has(1) ? intArg(A.num(1)) : 0, false));
  def('MOD', 2, 2, (A) => { const n = A.num(0); const d = A.num(1); if (d === 0) { return fail(ERR.DIV0); } const r = n - d * Math.floor(n / d); return approxEqual(Math.abs(r), Math.abs(d)) ? 0 : r; });
  def('QUOTIENT', 2, 2, (A) => { const d = A.num(1); if (d === 0) { return fail(ERR.ARG); } return Math.trunc(A.num(0) / d); });
  /** Calc's CEILING/FLOOR: significance must share the number's sign; mode ≠ 0 rounds away from zero. */
  function ceilFloor(A, isCeil) {
    const n = A.num(0);
    const sig = A.has(1) ? A.num(1) : (n < 0 ? -1 : 1);
    const mode = A.has(2) ? A.num(2) : 0;
    if (sig === 0 || n === 0) { return 0; }
    if ((n < 0 && sig > 0) || (n > 0 && sig < 0)) { return fail(ERR.ARG); }
    const q = n / sig;
    const rq = Math.round(q);
    if (approxEqual(q, rq)) { return rq * sig; }
    let k;
    if (mode !== 0) { k = isCeil ? Math.ceil(Math.abs(q)) : Math.floor(Math.abs(q)); return (n < 0 ? -k : k) * Math.abs(sig); }
    k = isCeil ? Math.ceil(q) : Math.floor(q);
    if (n < 0) { k = isCeil ? Math.floor(q) : Math.ceil(q); }
    return k * sig;
  }
  def('CEILING', 1, 3, (A) => ceilFloor(A, true));
  def('FLOOR', 1, 3, (A) => ceilFloor(A, false));
  def('MROUND', 2, 2, (A) => { const n = A.num(0); const m = A.num(1); if (m === 0) { return 0; } return roundHalfAway(n / m, 0) * m; });
  def('GCD', 1, -1, (A) => { const ns = A.numbers().map(Math.trunc); if (ns.some((x) => x < 0)) { return fail(ERR.ARG); } return ns.reduce((a, b) => { while (b) { [a, b] = [b, a % b]; } return a; }, 0); });
  def('LCM', 1, -1, (A) => { const ns = A.numbers().map(Math.trunc); if (ns.some((x) => x < 0)) { return fail(ERR.ARG); } if (ns.some((x) => x === 0)) { return 0; } const g = (a, b) => { while (b) { [a, b] = [b, a % b]; } return a; }; return ns.reduce((a, b) => a / g(a, b) * b, 1); });
  def('FACT', 1, 1, (A) => { const n = Math.trunc(A.num(0)); if (n < 0) { return fail(ERR.ARG); } if (n > 170) { return fail(ERR.VALUE); } let f = 1; for (let i = 2; i <= n; i++) { f *= i; } return f; });
  def('RAND', 0, 0, () => Math.random());
  def('RANDBETWEEN', 2, 2, (A) => { const lo = Math.ceil(A.num(0)); const hi = Math.floor(A.num(1)); if (A.num(0) > A.num(1)) { return fail(ERR.ARG); } return lo + Math.floor(Math.random() * Math.max(0, hi - lo + 1)); });
  def('SUMIF', 2, 3, (A, ctx) => { const test = A.ref(0, ERR.ARG); const sum = A.has(2) ? anchored(A.ref(2, ERR.ARG), test) : test; return ksum(numsOf(matchingCells(new Args(A.nodes.slice(0, 2), ctx), sum, 0, ctx))); });
  def('SUMIFS', 3, -1, (A, ctx) => ksum(numsOf(matchingCells(A, A.ref(0, ERR.ARG), 1, ctx))));
  def('SUMPRODUCT', 1, -1, (A) => {
    const arrs = [];
    for (let i = 0; i < A.n; i++) { const a = A.arr(i); arrs.push(a instanceof ArrayVal ? a : new ArrayVal([[a]])); }
    const h = arrs[0].h; const w = arrs[0].w;
    if (arrs.some((a) => a.h !== h || a.w !== w)) { return fail(ERR.VALUE); }
    const k = new KSum();
    for (let r = 0; r < h; r++) { for (let c = 0; c < w; c++) { let p = 1; for (const a of arrs) { const v = a.rows[r][c]; if (isErr(v)) { throw v; } p *= typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0; } k.add(p); } }
    return k.value;
  });

  // statistics
  def('AVERAGE', 1, -1, (A) => { const n = A.numbers(); return n.length ? ksum(n) / n.length : fail(ERR.DIV0); });
  def('MIN', 1, -1, (A) => { const n = A.numbers(0, undefined, true); return n.length ? Math.min(...n) : 0; });
  def('MAX', 1, -1, (A) => { const n = A.numbers(0, undefined, true); return n.length ? Math.max(...n) : 0; });
  def('MEDIAN', 1, -1, (A) => { const n = A.numbers(0, undefined, true).sort((p, q) => p - q); if (!n.length) { return fail(ERR.VALUE); } const h = Math.floor(n.length / 2); return n.length % 2 ? n[h] : (n[h - 1] + n[h]) / 2; });
  def('MODE', 1, -1, (A) => {
    const n = A.numbers(0, undefined, true).sort((p, q) => p - q);
    let best = null; let bestCount = 1;
    for (let i = 0; i < n.length;) { let j = i; while (j < n.length && n[j] === n[i]) { j++; } if (j - i > bestCount) { bestCount = j - i; best = n[i]; } i = j; }
    return best == null ? fail(ERR.VALUE) : best;
  });
  const variance = (n, sample) => { if (n.length < (sample ? 2 : 1)) { return fail(ERR.DIV0); } const m = ksum(n) / n.length; const k = new KSum(); n.forEach((x) => k.add((x - m) * (x - m))); return k.value / (n.length - (sample ? 1 : 0)); };
  def('VAR', 1, -1, (A) => variance(A.numbers(0, undefined, true), true));
  def('VARP', 1, -1, (A) => variance(A.numbers(0, undefined, true), false));
  def('STDEV', 1, -1, (A) => Math.sqrt(variance(A.numbers(0, undefined, true), true)));
  def('STDEVP', 1, -1, (A) => Math.sqrt(variance(A.numbers(0, undefined, true), false)));
  def('COUNT', 1, -1, (A) => A.items().filter(({ v, ref }) => (ref ? typeof v === 'number' || typeof v === 'boolean' : (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && parseInput(v, A.L.id).t === 'n')))).length);
  def('COUNTA', 1, -1, (A) => A.items().filter(({ v }) => v != null).length);
  def('COUNTBLANK', 1, 1, (A, ctx) => { const rv = A.ref(0, ERR.ARG); let used = 0; eachCell(rv, (r, c) => { const v = ctx.cellValue(rv.sheet, r, c); if (v != null && v !== '') { used++; } }); return (rv.r1 - rv.r0 + 1) * (rv.c1 - rv.c0 + 1) - used; });
  def('COUNTIF', 2, 2, (A, ctx) => matchingCells(A, null, 0, ctx).length);
  def('COUNTIFS', 2, -1, (A, ctx) => matchingCells(A, null, 0, ctx).length);
  def('AVERAGEIF', 2, 3, (A, ctx) => { const test = A.ref(0, ERR.ARG); const avg = A.has(2) ? anchored(A.ref(2, ERR.ARG), test) : test; const n = numsOf(matchingCells(new Args(A.nodes.slice(0, 2), ctx), avg, 0, ctx)); return n.length ? ksum(n) / n.length : fail(ERR.DIV0); });
  def('AVERAGEIFS', 3, -1, (A, ctx) => { const n = numsOf(matchingCells(A, A.ref(0, ERR.ARG), 1, ctx)); return n.length ? ksum(n) / n.length : fail(ERR.DIV0); });
  def('MINIFS', 3, -1, (A, ctx) => { const n = numsOf(matchingCells(A, A.ref(0, ERR.ARG), 1, ctx)); return n.length ? Math.min(...n) : 0; });
  def('MAXIFS', 3, -1, (A, ctx) => { const n = numsOf(matchingCells(A, A.ref(0, ERR.ARG), 1, ctx)); return n.length ? Math.max(...n) : 0; });
  const kth = (A, desc) => { const n = A.numbers(0, 1, true).sort((p, q) => (desc ? q - p : p - q)); const k = roundHalfAway(A.num(1), 0); if (k < 1 || k > n.length) { return fail(ERR.VALUE); } return n[k - 1]; };
  def('LARGE', 2, 2, (A) => kth(A, true));
  def('SMALL', 2, 2, (A) => kth(A, false));
  def('RANK', 2, 3, (A) => { const v = A.num(0); const n = A.numbers(1, 2); const asc = A.has(2) && A.num(2) !== 0; if (!n.some((x) => approxEqual(x, v))) { return fail(ERR.NA); } return 1 + n.filter((x) => (asc ? x < v : x > v) && !approxEqual(x, v)).length; });

  // logical
  def('TRUE', 0, 0, () => true);
  def('FALSE', 0, 0, () => false);
  def('IF', 1, 3, (A) => (A.bool(0) ? (A.n > 1 ? (A.has(1) ? A.raw(1) : 0) : true) : (A.n > 2 ? (A.has(2) ? A.raw(2) : 0) : false)));
  def('IFS', 2, -1, (A) => { for (let i = 0; i + 1 < A.n; i += 2) { if (A.bool(i)) { return A.raw(i + 1); } } return fail(ERR.NA); });
  def('SWITCH', 3, -1, (A) => { const ok = lookupMatcher(typeof A.val(0) === 'string' ? A.val(0).replace(/[*?~]/g, '~$&') : A.val(0), A.L); let i = 1; for (; i + 1 < A.n; i += 2) { if (ok(A.val(i))) { return A.raw(i + 1); } } return i < A.n ? A.raw(i) : fail(ERR.NA); });
  def('CHOOSE', 2, -1, (A) => { const i = Math.trunc(A.num(0)); if (i < 1 || i >= A.n) { return fail(ERR.ARG); } return A.raw(i); });
  const catchErr = (f, onErr) => { try { const v = f(); if (isErr(v)) { return onErr(v); } return v; } catch (e) { if (isErr(e)) { return onErr(e); } throw e; } };
  def('IFERROR', 2, 2, (A) => catchErr(() => { const v = A.val(0); return v == null ? 0 : v; }, () => A.raw(1)));
  def('IFNA', 2, 2, (A) => catchErr(() => { const v = A.val(0); return v == null ? 0 : v; }, (e) => (e.code === ERR.NA ? A.raw(1) : fail(e.code))));
  /** AND/OR/XOR: text in cells is skipped, typed text is an error, nothing to judge is #VALUE!. */
  function bools(A) {
    const out = [];
    for (const it of A.items()) {
      const v = it.v;
      if (isErr(v)) { throw v; }
      if (it.ref) { if (typeof v === 'boolean') { out.push(v); } else if (typeof v === 'number') { out.push(v !== 0); } continue; }
      if (typeof v === 'string') { return fail(ERR.VALUE); }
      if (v == null) { out.push(false); continue; }
      out.push(toBool(v, A.L));
    }
    if (!out.length) { return fail(ERR.VALUE); }
    return out;
  }
  def('AND', 1, -1, (A) => bools(A).every((b) => b));
  def('OR', 1, -1, (A) => bools(A).some((b) => b));
  def('XOR', 1, -1, (A) => bools(A).filter((b) => b).length % 2 === 1);
  def('NOT', 1, 1, (A) => !A.bool(0));

  // text
  const chars = (s) => Array.from(s);
  def('CONCATENATE', 0, -1, (A) => { let s = ''; for (let i = 0; i < A.n; i++) { s += toText(A.val(i)); } return s; });
  def('CONCAT', 1, -1, (A) => A.items().map(({ v }) => (isErr(v) ? fail(v.code) : v == null ? '' : toText(v))).join(''));
  def('TEXTJOIN', 3, -1, (A) => {
    const delims = []; const d = A.raw(0);
    if (d instanceof RangeVal || d instanceof ArrayVal) { new Args([A.nodes[0]], A.ctx).items().forEach(({ v }) => delims.push(toText(v))); } else { delims.push(toText(deref(d, A.ctx))); }
    const skip = A.bool(1, true);
    const parts = [];
    A.items(2).forEach(({ v }) => { if (isErr(v)) { throw v; } const s = v == null ? '' : toText(v); if (skip && s === '') { return; } parts.push(s); });
    let out = '';
    parts.forEach((p, i) => { out += (i ? delims[(i - 1) % delims.length] : '') + p; });
    return out;
  });
  def('LEN', 1, 1, (A) => chars(A.str(0)).length);
  def('LEFT', 1, 2, (A) => { const n = A.has(1) ? Math.trunc(A.num(1)) : 1; if (n < 0) { return fail(ERR.ARG); } return chars(A.str(0)).slice(0, n).join(''); });
  def('RIGHT', 1, 2, (A) => { const n = A.has(1) ? Math.trunc(A.num(1)) : 1; if (n < 0) { return fail(ERR.ARG); } const s = chars(A.str(0)); return n > 0 ? s.slice(-n).join('') : ''; });
  def('MID', 3, 3, (A) => { const s = Math.trunc(A.num(1)); const n = Math.trunc(A.num(2)); if (s < 1 || n < 0) { return fail(ERR.ARG); } return chars(A.str(0)).slice(s - 1, s - 1 + n).join(''); });
  def('UPPER', 1, 1, (A) => A.str(0).toUpperCase());
  def('LOWER', 1, 1, (A) => A.str(0).toLowerCase());
  def('PROPER', 1, 1, (A) => A.str(0).toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()));
  def('TRIM', 1, 1, (A) => A.str(0).replace(/ +/g, ' ').replace(/^ | $/g, ''));
  def('CLEAN', 1, 1, (A) => A.str(0).replace(/[\x00-\x1f]/g, ''));
  def('REPT', 2, 2, (A) => { const n = Math.trunc(A.num(1)); if (n < 0) { return fail(ERR.ARG); } return A.str(0).repeat(n); });
  def('EXACT', 2, 2, (A) => A.str(0) === A.str(1));
  def('CHAR', 1, 1, (A) => { const n = Math.trunc(A.num(0)); if (n < 0 || n > 255) { return fail(ERR.ARG); } return String.fromCharCode(n); });
  def('CODE', 1, 1, (A) => { const s = A.str(0); if (!s) { return 0; } const cp = s.codePointAt(0); return cp < 128 ? cp : (cp < 0x800 ? 0xC0 | (cp >> 6) : cp < 0x10000 ? 0xE0 | (cp >> 12) : 0xF0 | (cp >> 18)); });
  def('UNICHAR', 1, 1, (A) => { const n = Math.trunc(A.num(0)); if (n < 0 || n > 0x10FFFF) { return fail(ERR.ARG); } return String.fromCodePoint(n); });
  def('UNICODE', 1, 1, (A) => { const s = A.str(0); if (!s) { return fail(ERR.PARAM); } return s.codePointAt(0); });
  def('FIND', 2, 3, (A) => {
    const what = A.str(0); const where = chars(A.str(1)); const start = A.has(2) ? Math.trunc(A.num(2)) : 1;
    if (what === '' || start < 1 || start > where.length) { return fail(ERR.VALUE); }
    const idx = where.slice(start - 1).join('').indexOf(what);
    if (idx < 0) { return fail(ERR.VALUE); }
    return start + chars(where.slice(start - 1).join('').slice(0, idx)).length;
  });
  def('SEARCH', 2, 3, (A) => {
    const what = A.str(0); const where = chars(A.str(1)); const start = A.has(2) ? Math.trunc(A.num(2)) : 1;
    if (start < 1) { return fail(ERR.ARG); }
    if (what === '' || start > where.length) { return fail(ERR.VALUE); }
    const hay = where.slice(start - 1);
    let s = '';
    for (let i = 0; i < what.length; i++) { const ch = what[i]; if (ch === '~' && i + 1 < what.length) { s += what[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); } else if (ch === '*') { s += '.*?'; } else if (ch === '?') { s += '.'; } else { s += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); } }
    const m = new RegExp(s, 'isu').exec(hay.join(''));
    if (!m) { return fail(ERR.VALUE); }
    return start + chars(hay.join('').slice(0, m.index)).length;
  });
  def('SUBSTITUTE', 3, 4, (A) => {
    const text = A.str(0); const old = A.str(1); const neu = A.str(2);
    if (old === '') { return text; }
    if (!A.has(3)) { return text.split(old).join(neu); }
    const k = Math.trunc(A.num(3));
    if (k < 1) { return fail(ERR.ARG); }
    let idx = -1; let count = 0;
    for (;;) { idx = text.indexOf(old, idx + 1); if (idx < 0) { return text; } count++; if (count === k) { return text.slice(0, idx) + neu + text.slice(idx + old.length); } }
  });
  def('REPLACE', 4, 4, (A) => { const s = chars(A.str(0)); const pos = Math.trunc(A.num(1)); const len = Math.trunc(A.num(2)); if (pos < 1 || len < 0) { return fail(ERR.ARG); } return s.slice(0, pos - 1).join('') + A.str(3) + s.slice(pos - 1 + len).join(''); });
  def('TEXT', 2, 2, (A) => {
    const v = A.val(0); const code = A.str(1);
    if (code === '') { return ''; }
    if (typeof v === 'string') { const p = parseInput(v, A.L.id); if (p.t !== 'n' && p.t !== 'b') { return format(v, 's', code, A.L.id); } return format(p.v, p.t, code, A.L.id); }
    return format(v == null ? 0 : v, typeof v === 'boolean' ? 'b' : 'n', code, A.L.id);
  });
  def('VALUE', 1, 1, (A) => { const v = A.val(0); if (typeof v === 'number') { return v; } if (typeof v === 'boolean') { return v ? 1 : 0; } const p = parseInput(v == null ? '' : String(v), A.L.id); return p.t === 'n' ? p.v : p.t === 'b' ? (p.v ? 1 : 0) : fail(ERR.ARG); });
  def('FIXED', 1, 3, (A) => { const d = A.has(1) ? Math.trunc(A.num(1)) : 2; const noCommas = A.bool(2, false); const n = roundHalfAway(A.num(0), d); return format(n, 'n', (noCommas ? '0' : '#,##0') + (d > 0 ? '.' + '0'.repeat(d) : ''), A.L.id); });
  def('DOLLAR', 1, 2, (A) => { const d = A.has(1) ? Math.trunc(A.num(1)) : A.L.curDec; const n = roundHalfAway(A.num(0), d); const code = A.L.currency + '#,##0' + (d > 0 ? '.' + '0'.repeat(d) : ''); return format(n, 'n', code, A.L.id); });
  def('T', 1, 1, (A) => { const v = A.val(0); return typeof v === 'string' ? v : ''; });
  def('N', 1, 1, (A) => { const v = A.val(0); return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0; });

  // lookup
  /** Does a looked-up value match a cell? Text is case-insensitive with wildcards; "21" also finds 21. */
  function lookupMatcher(q, L) {
    if (isErr(q)) { throw q; }
    if (typeof q === 'boolean') { q = q ? 1 : 0; }
    if (typeof q === 'number') { return (v) => (typeof v === 'number' || typeof v === 'boolean') && approxEqual(toNum(v), q); }
    if (q == null) { return () => false; }
    const s = String(q);
    const re = hasWild(s) ? wildcard(s) : null;
    const low = s.toLowerCase();
    const p = parseInput(s, L.id);
    const asNum = p.t === 'n' ? p.v : null;
    return (v) => {
      if (v == null) { return false; }
      if (typeof v === 'number' || typeof v === 'boolean') { return asNum != null && approxEqual(toNum(v), asNum); }
      if (typeof v !== 'string') { return false; }
      return re ? re.test(v) : v.toLowerCase() === low;
    };
  }
  /** The values of one row or column of a range, as a list. */
  function vector(rv, ctx, byRow, index) {
    const out = [];
    if (byRow) { for (let c = rv.c0; c <= rv.c1; c++) { out.push(ctx.cellValue(rv.sheet, rv.r0 + index, c)); } } else { for (let r = rv.r0; r <= rv.r1; r++) { out.push(ctx.cellValue(rv.sheet, r, rv.c0 + index)); } }
    return out;
  }
  const sameKind = (a, b) => (typeof a === 'number' || typeof a === 'boolean') === (typeof b === 'number' || typeof b === 'boolean');
  /** Position of the largest entry ≤ q (ascending data) or the smallest ≥ q (descending), skipping empties; -1 if none. */
  function approxFind(list, q, L, descending) {
    if (typeof q === 'boolean') { q = q ? 1 : 0; }
    const idx = [];
    list.forEach((v, i) => { if (v != null && !isErr(v) && sameKind(v, q)) { idx.push(i); } });
    let lo = 0; let hi = idx.length - 1; let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = compare(list[idx[mid]], q, L);
      if (c === 0) { return idx[mid]; }
      if (descending ? c > 0 : c < 0) { best = idx[mid]; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }
  function exactFind(list, q, L) { const ok = lookupMatcher(q, L); for (let i = 0; i < list.length; i++) { if (ok(list[i])) { return i; } } return -1; }
  function hvlookup(A, ctx, byRow) {
    const q = A.val(0); const rng = A.ref(1, ERR.ARG); const idx = Math.trunc(A.num(2)); const sorted = A.has(3) ? A.bool(3) : true;
    const size = byRow ? rng.r1 - rng.r0 + 1 : rng.c1 - rng.c0 + 1;
    if (idx < 1 || idx > size) { return fail(ERR.ARG); }
    if (q == null) { return fail(ERR.NA); }
    const keys = vector(rng, ctx, byRow, 0);
    const pos = sorted ? approxFind(keys, q, ctx.L) : exactFind(keys, q, ctx.L);
    if (pos < 0) { return fail(ERR.NA); }
    return byRow ? new RangeVal(rng.sheet, rng.r0 + idx - 1, rng.c0 + pos, rng.r0 + idx - 1, rng.c0 + pos) : new RangeVal(rng.sheet, rng.r0 + pos, rng.c0 + idx - 1, rng.r0 + pos, rng.c0 + idx - 1);
  }
  def('VLOOKUP', 3, 4, (A, ctx) => hvlookup(A, ctx, false));
  def('HLOOKUP', 3, 4, (A, ctx) => hvlookup(A, ctx, true));
  def('LOOKUP', 2, 3, (A, ctx) => {
    const q = A.val(0); const rng = A.ref(1, ERR.ARG);
    const byRow = rng.c1 - rng.c0 > rng.r1 - rng.r0;
    const keys = vector(rng, ctx, byRow, 0);
    const pos = approxFind(keys, q, ctx.L);
    if (pos < 0) { return fail(ERR.NA); }
    if (A.has(2)) { const res = A.ref(2, ERR.ARG); const resByRow = res.c1 - res.c0 > res.r1 - res.r0; return resByRow ? new RangeVal(res.sheet, res.r0, res.c0 + pos, res.r0, res.c0 + pos) : new RangeVal(res.sheet, res.r0 + pos, res.c0, res.r0 + pos, res.c0); }
    return byRow ? new RangeVal(rng.sheet, rng.r1, rng.c0 + pos, rng.r1, rng.c0 + pos) : new RangeVal(rng.sheet, rng.r0 + pos, rng.c1, rng.r0 + pos, rng.c1);
  });
  def('MATCH', 2, 3, (A, ctx) => {
    const q = A.val(0); const rng = A.ref(1, ERR.ARG); const type = A.has(2) ? A.num(2) : 1;
    if (rng.r1 > rng.r0 && rng.c1 > rng.c0) { return fail(ERR.PARAM); }
    const keys = vector(rng, ctx, rng.c1 > rng.c0, 0);
    const pos = type === 0 ? exactFind(keys, q, ctx.L) : approxFind(keys, q, ctx.L, type < 0);
    return pos < 0 ? fail(ERR.NA) : pos + 1;
  });
  /** XLOOKUP/XMATCH as Excel and Calc 24.8 define them (not in LibreOffice 24.2). */
  function xfind(A, ctx, qIdx, rngIdx, modeIdx, searchIdx) {
    const q = A.val(qIdx); const rng = A.ref(rngIdx, ERR.ARG);
    const mode = A.has(modeIdx) ? Math.trunc(A.num(modeIdx)) : 0;
    const search = A.has(searchIdx) ? Math.trunc(A.num(searchIdx)) : 1;
    const byRow = rng.c1 - rng.c0 > rng.r1 - rng.r0;
    let keys = vector(rng, ctx, byRow, 0);
    let order = keys.map((v, i) => i);
    if (search === -1) { order.reverse(); }
    if (Math.abs(search) === 2) { order = order.filter((i) => keys[i] != null && sameKind(keys[i], q)).sort((a, b) => compare(keys[a], keys[b], ctx.L) * (search < 0 ? -1 : 1)); }
    const ok = mode === 2 ? lookupMatcher(q, ctx.L) : lookupMatcher(typeof q === 'string' ? q.replace(/[*?~]/g, '~$&') : q, ctx.L);
    let best = -1;
    for (const i of order) {
      const v = keys[i];
      if (ok(v)) { return i; }
      if (mode === -1 || mode === 1) {
        if (v == null || !sameKind(v, q)) { continue; }
        const c = compare(v, q, ctx.L);
        if ((mode === -1 && c < 0) || (mode === 1 && c > 0)) { if (best < 0 || (mode === -1 ? compare(v, keys[best], ctx.L) > 0 : compare(v, keys[best], ctx.L) < 0)) { best = i; } }
      }
    }
    return best;
  }
  def('XLOOKUP', 3, 6, (A, ctx) => {
    const pos = xfind(A, ctx, 0, 1, 4, 5);
    if (pos < 0) { return A.has(3) ? A.raw(3) : fail(ERR.NA); }
    const res = A.ref(2, ERR.ARG); const lk = A.ref(1, ERR.ARG);
    const byRow = lk.c1 - lk.c0 > lk.r1 - lk.r0;
    return byRow ? new RangeVal(res.sheet, res.r0, res.c0 + pos, res.r1, res.c0 + pos) : new RangeVal(res.sheet, res.r0 + pos, res.c0, res.r0 + pos, res.c1);
  });
  def('XMATCH', 2, 4, (A, ctx) => { const pos = xfind(A, ctx, 0, 1, 2, 3); return pos < 0 ? fail(ERR.NA) : pos + 1; });
  def('INDEX', 1, 4, (A) => {
    const base = A.raw(0);
    const row = A.has(1) ? Math.trunc(A.num(1)) : 0;
    const col = A.has(2) ? Math.trunc(A.num(2)) : 0;
    if (row < 0 || col < 0) { return fail(ERR.ARG); }
    if (A.has(3) && Math.trunc(A.num(3)) !== 1) { return fail(ERR.REF); }
    if (base instanceof ArrayVal) { let r = row || 1; let c = col || 1; if (base.h === 1 && row > 0 && !A.has(2)) { c = row; r = 1; } if (r > base.h || c > base.w) { return fail(ERR.REF); } return base.rows[r - 1][c - 1]; }
    if (!(base instanceof RangeVal)) { if (isErr(base)) { throw base; } return row <= 1 && col <= 1 ? base : fail(ERR.REF); }
    const h = base.r1 - base.r0 + 1; const w = base.c1 - base.c0 + 1;
    let r = row; let c = col;
    if (h === 1 && col === 0 && row > 0 && !A.has(2)) { c = row; r = 1; } else if (row > 0 && A.n < 3) { c = 1; }
    if (r > h || c > w) { return fail(ERR.REF); }
    return new RangeVal(base.sheet, r ? base.r0 + r - 1 : base.r0, c ? base.c0 + c - 1 : base.c0, r ? base.r0 + r - 1 : base.r1, c ? base.c0 + c - 1 : base.c1);
  });
  def('OFFSET', 2, 5, (A) => {
    const base = A.ref(0, ERR.ARG);
    const dr = Math.trunc(A.num(1)); const dc = A.has(2) ? Math.trunc(A.num(2)) : 0;
    const h = A.has(3) ? Math.trunc(A.num(3)) : base.r1 - base.r0 + 1;
    const w = A.has(4) ? Math.trunc(A.num(4)) : base.c1 - base.c0 + 1;
    if (h <= 0 || w <= 0) { return fail(ERR.ARG); }
    const r0 = base.r0 + dr; const c0 = base.c0 + dc;
    if (r0 < 0 || c0 < 0 || r0 + h > MAXR || c0 + w > MAXC) { return fail(ERR.ARG); }
    return new RangeVal(base.sheet, r0, c0, r0 + h - 1, c0 + w - 1);
  });
  /** A reference written as text: Sheet2.A1, Sheet2!A1, 'My sheet'.A1:B2, $A$1, or R1C1 when a1 is 0. */
  function refFromText(text, ctx, a1) {
    const s = String(text).trim();
    if (!a1) {
      const m = /^(?:(?:'((?:[^']|'')+)'|([^!.]+))[!.])?R(\[?)(-?\d+)\]?C(\[?)(-?\d+)\]?$/i.exec(s);
      if (!m) { return fail(ERR.REF); }
      const sh = m[1] || m[2] ? ctx.wb.sheetByName((m[1] || m[2]).replace(/''/g, "'")) : ctx.sheet;
      if (!sh) { return fail(ERR.REF); }
      const r = m[3] ? ctx.at.r + Number(m[4]) : Number(m[4]) - 1;
      const c = m[5] ? ctx.at.c + Number(m[6]) : Number(m[6]) - 1;
      if (r < 0 || c < 0 || r >= MAXR || c >= MAXC) { return fail(ERR.REF); }
      return new RangeVal(sh, r, c, r, c);
    }
    let toks;
    try { toks = tokenize(s); } catch (e) { return fail(ERR.REF); }
    if (toks.length !== 1 || toks[0].t !== 'ref') { return fail(ERR.REF); }
    return resolveRef(toks[0], ctx);
  }
  def('INDIRECT', 1, 2, (A, ctx) => refFromText(A.str(0), ctx, A.has(1) ? A.bool(1) : true));
  const rowsOf = (A, ctx, fn) => { if (!A.n) { return fn(ctx.at.r, ctx.at.c); } const rv = A.ref(0, ERR.PARAM); if (rv.single) { return fn(rv.r0, rv.c0); } const rows = []; for (let r = rv.r0; r <= rv.r1; r++) { const row = []; for (let c = rv.c0; c <= rv.c1; c++) { row.push(fn(r, c)); } rows.push(row); } return new ArrayVal(rows); };
  def('ROW', 0, 1, (A, ctx) => rowsOf(A, ctx, (r) => r + 1));
  def('COLUMN', 0, 1, (A, ctx) => rowsOf(A, ctx, (r, c) => c + 1));
  def('ROWS', 1, 1, (A) => { const v = A.raw(0); if (v instanceof RangeVal) { return v.r1 - v.r0 + 1; } if (v instanceof ArrayVal) { return v.h; } return fail(ERR.PARAM); });
  def('COLUMNS', 1, 1, (A) => { const v = A.raw(0); if (v instanceof RangeVal) { return v.c1 - v.c0 + 1; } if (v instanceof ArrayVal) { return v.w; } return fail(ERR.PARAM); });
  def('ADDRESS', 2, 5, (A) => {
    const r = Math.trunc(A.num(0)); const c = Math.trunc(A.num(1));
    let abs = A.has(2) ? Math.trunc(A.num(2)) : 1;
    if (abs < 1 || abs > 4) { abs = 1; }
    const a1 = A.has(3) ? A.bool(3) : true;
    const sheet = A.has(4) ? A.str(4) : '';
    if (r < 1 || c < 1 || r > MAXR || c > MAXC) { return fail(ERR.ARG); }
    const rA = abs === 1 || abs === 2; const cA = abs === 1 || abs === 3;
    let ref;
    if (a1) { ref = (cA ? '$' : '') + colName(c - 1) + (rA ? '$' : '') + r; } else { ref = 'R' + (rA ? r : '[' + r + ']') + 'C' + (cA ? c : '[' + c + ']'); }
    return sheet ? quoteSheet(sheet) + (a1 ? '.' : '!') + ref : ref;
  });

  // dates and times
  const serialNow = () => { const d = new Date(); return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()) - DAY0) / MS_DAY; };
  function dateArg(A, i) {
    const v = A.val(i);
    if (typeof v === 'string') { const p = parseInput(v, A.L.id); if (p.t !== 'n') { return fail(ERR.ARG); } return p.v; }
    return toNum(v, A.L);
  }
  def('DATE', 3, 3, (A) => {
    let y = Math.trunc(A.num(0)); const m = Math.trunc(A.num(1)); const d = Math.trunc(A.num(2));
    if (y < 0) { return fail(ERR.ARG); }
    y = fullYear(y);
    const dt = utcDate(y, 1, 1); dt.setUTCMonth(m - 1, d);
    const serial = Math.round((dt.getTime() - DAY0) / MS_DAY);
    if (serial < GREGORIAN) { return fail(ERR.VALUE); }
    return serial;
  });
  def('TIME', 3, 3, (A) => { const t = A.num(0) * 3600 + A.num(1) * 60 + A.num(2); if (t < 0) { return fail(ERR.ARG); } return (t % 86400) / 86400; });
  def('TODAY', 0, 0, () => Math.floor(serialNow()));
  def('NOW', 0, 0, () => serialNow());
  def('YEAR', 1, 1, (A) => serialToYmd(dateArg(A, 0)).y);
  def('MONTH', 1, 1, (A) => serialToYmd(dateArg(A, 0)).m);
  def('DAY', 1, 1, (A) => serialToYmd(dateArg(A, 0)).d);
  const timeParts = (v) => { const f = v - Math.floor(v); const s = Math.floor(Math.round(f * 86400 * 1e6) / 1e6); return { h: Math.floor(s / 3600) % 24, m: Math.floor(s / 60) % 60, s: s % 60 }; };
  def('HOUR', 1, 1, (A) => timeParts(dateArg(A, 0)).h);
  def('MINUTE', 1, 1, (A) => timeParts(dateArg(A, 0)).m);
  def('SECOND', 1, 1, (A) => timeParts(dateArg(A, 0)).s);
  def('WEEKDAY', 1, 2, (A) => {
    const d = dayOfWeek(dateArg(A, 0)); const type = A.has(1) ? Math.trunc(A.num(1)) : 1;
    if (type === 1) { return d + 1; }
    if (type === 2 || type === 11) { return ((d + 6) % 7) + 1; }
    if (type === 3) { return (d + 6) % 7; }
    if (type >= 12 && type <= 17) { const start = (type - 10) % 7; return ((d - start + 7) % 7) + 1; }
    return fail(ERR.ARG);
  });
  def('WEEKNUM', 1, 2, (A) => weekNum(dateArg(A, 0), A.has(1) ? Math.trunc(A.num(1)) : 1));
  def('DAYS', 2, 2, (A) => Math.floor(dateArg(A, 0)) - Math.floor(dateArg(A, 1)));
  def('DATEDIF', 3, 3, (A) => {
    const d1 = Math.floor(dateArg(A, 0)); const d2 = Math.floor(dateArg(A, 1)); const unit = A.str(2).toUpperCase();
    if (d1 > d2) { return fail(ERR.ARG); }
    const a = serialToYmd(d1); const b = serialToYmd(d2);
    switch (unit) {
      case 'D': return d2 - d1;
      case 'M': { let m = (b.y - a.y) * 12 + b.m - a.m; if (b.d < a.d) { m--; } return m; }
      case 'Y': { let y = b.y - a.y; if (b.m < a.m || (b.m === a.m && b.d < a.d)) { y--; } return y; }
      case 'MD': { if (b.d >= a.d) { return b.d - a.d; } let y = b.y; let m = b.m - 1; if (m < 1) { m = 12; y--; } const dt = utcDate(y, 1, 1); dt.setUTCMonth(m - 1, a.d); return d2 - Math.round((dt.getTime() - DAY0) / MS_DAY); }
      case 'YM': { let m = b.m - a.m; if (b.d < a.d) { m--; } if (m < 0) { m += 12; } return m; }
      case 'YD': { let s = ymdToSerial(b.y, a.m, a.d); if (s > d2) { s = ymdToSerial(b.y - 1, a.m, a.d); } return d2 - s; }
      default: return fail(ERR.ARG);
    }
  });
  function addMonths(serial, months) {
    const p = serialToYmd(serial);
    const total = p.m - 1 + months;
    const y = p.y + Math.floor(total / 12); const m = ((total % 12) + 12) % 12 + 1;
    return { y, m, d: Math.min(p.d, daysInMonth(y, m)) };
  }
  def('EDATE', 2, 2, (A) => { const x = addMonths(Math.floor(dateArg(A, 0)), Math.trunc(A.num(1))); return ymdToSerial(x.y, x.m, x.d); });
  def('EOMONTH', 2, 2, (A) => { const x = addMonths(Math.floor(dateArg(A, 0)), Math.trunc(A.num(1))); return ymdToSerial(x.y, x.m, daysInMonth(x.y, x.m)); });
  /** Which weekdays are off and which dates are holidays, for NETWORKDAYS and WORKDAY. */
  function offDays(A, holidaysIdx, weekendIdx) {
    const holidays = new Set();
    if (A.has(holidaysIdx)) { A.items(holidaysIdx, holidaysIdx + 1).forEach(({ v }) => { if (typeof v === 'number') { holidays.add(Math.floor(v)); } }); }
    let weekend = [true, false, false, false, false, false, true]; // Sunday .. Saturday, as Calc's list of workdays is ordered
    if (A.has(weekendIdx)) {
      const w = A.arr(weekendIdx);
      if (w instanceof ArrayVal) { const flat = w.rows.flat(); if (flat.length !== 7) { return fail(ERR.PARAM); } weekend = flat.map((x) => toNum(x) !== 0); } else { return fail(ERR.PARAM); }
    }
    return (serial) => weekend[dayOfWeek(serial)] || holidays.has(Math.floor(serial));
  }
  def('NETWORKDAYS', 2, 4, (A) => {
    let s = Math.floor(dateArg(A, 0)); let e = Math.floor(dateArg(A, 1));
    const off = offDays(A, 2, 3);
    const sign = e < s ? -1 : 1;
    if (e < s) { [s, e] = [e, s]; }
    let n = 0;
    for (let d = s; d <= e; d++) { if (!off(d)) { n++; } }
    return sign * n;
  });
  def('WORKDAY', 2, 3, (A) => {
    let d = Math.floor(dateArg(A, 0)); let n = Math.trunc(A.num(1));
    const off = offDays(A, 2, 99);
    const step = n < 0 ? -1 : 1;
    n = Math.abs(n);
    while (n > 0) { d += step; if (!off(d)) { n--; } }
    return d;
  });
  def('DATEVALUE', 1, 1, (A) => { const v = A.val(0); if (typeof v !== 'string') { return fail(ERR.ARG); } const p = parseInput(v, A.L.id); if (p.t !== 'n' || !p.fmt || !/[yd]/.test(p.fmt)) { return fail(ERR.ARG); } return Math.floor(p.v); });
  def('TIMEVALUE', 1, 1, (A) => { const v = A.val(0); if (typeof v !== 'string') { return fail(ERR.ARG); } const p = parseInput(v, A.L.id); if (p.t !== 'n' || !p.fmt || !/[hs]/.test(p.fmt)) { return fail(ERR.ARG); } return p.v - Math.floor(p.v); });

  // information
  const cellOf = (A, i) => { const v = A.raw(i); if (v instanceof RangeVal) { return v; } return null; };
  def('ISBLANK', 1, 1, (A) => { const rv = cellOf(A, 0); return !!rv && rv.single && A.ctx.cellValue(rv.sheet, rv.r0, rv.c0) == null; });
  const isType = (A, test) => catchErr(() => test(A.val(0)), () => false);
  def('ISNUMBER', 1, 1, (A) => isType(A, (v) => typeof v === 'number' || typeof v === 'boolean'));
  def('ISTEXT', 1, 1, (A) => isType(A, (v) => typeof v === 'string'));
  def('ISLOGICAL', 1, 1, (A) => isType(A, (v) => typeof v === 'boolean'));
  def('ISERROR', 1, 1, (A) => catchErr(() => { A.val(0); return false; }, () => true));
  def('ISERR', 1, 1, (A) => catchErr(() => { A.val(0); return false; }, (e) => e.code !== ERR.NA));
  def('ISNA', 1, 1, (A) => catchErr(() => { A.val(0); return false; }, (e) => e.code === ERR.NA));
  def('ISFORMULA', 1, 1, (A) => { const rv = cellOf(A, 0); if (!rv) { return false; } const cell = rv.sheet.cells.get(rv.r0 * MAXC + rv.c0); return !!(cell && cell.f); });
  def('NA', 0, 0, () => fail(ERR.NA));
  def('TYPE', 1, 1, (A) => { const rv = catchErr(() => cellOf(A, 0), () => null); if (rv) { if (!rv.single) { return fail(ERR.VALUE); } const cell = rv.sheet.cells.get(rv.r0 * MAXC + rv.c0); if (cell && cell.f) { return 8; } } return catchErr(() => { const v = A.val(0); return typeof v === 'string' ? 2 : 1; }, () => 16); });

  // financial
  const pmtOf = (r, n, pv, fv, type) => (r === 0 ? -(pv + fv) / n : -(pv * Math.pow(1 + r, n) + fv) * r / ((1 + r * type) * (Math.pow(1 + r, n) - 1)));
  const fvOf = (r, n, pmt, pv, type) => (r === 0 ? -(pv + pmt * n) : -(pv * Math.pow(1 + r, n) + pmt * (1 + r * type) * (Math.pow(1 + r, n) - 1) / r));
  def('PMT', 3, 5, (A) => { const n = A.num(1); if (n === 0) { return fail(ERR.NUM); } return checkFinite(pmtOf(A.num(0), n, A.num(2), A.num(3, 0), A.num(4, 0) ? 1 : 0)); });
  def('FV', 3, 5, (A) => checkFinite(fvOf(A.num(0), A.num(1), A.num(2), A.num(3, 0), A.num(4, 0) ? 1 : 0)));
  def('PV', 3, 5, (A) => { const r = A.num(0); const n = A.num(1); const pmt = A.num(2); const fv = A.num(3, 0); const type = A.num(4, 0) ? 1 : 0; if (r === 0) { return -(fv + pmt * n); } return checkFinite(-(fv + pmt * (1 + r * type) * (Math.pow(1 + r, n) - 1) / r) / Math.pow(1 + r, n)); });
  def('NPV', 2, -1, (A) => { const r = A.num(0); const k = new KSum(); let i = 1; A.items(1).forEach(({ v }) => { if (typeof v === 'number') { k.add(v / Math.pow(1 + r, i)); i++; } else if (isErr(v)) { throw v; } }); return k.value; });
  def('IRR', 1, 2, (A) => {
    const vals = A.items(0, 1).map(({ v }) => v).filter((v) => typeof v === 'number');
    let x = A.has(1) ? A.num(1) : 0.1;
    for (let it = 0; it < 100; it++) {
      let f = 0; let df = 0;
      vals.forEach((v, i) => { f += v / Math.pow(1 + x, i); df -= i * v / Math.pow(1 + x, i + 1); });
      if (df === 0 || !isFinite(df)) { break; }
      const nx = x - f / df;
      if (!isFinite(nx)) { break; }
      if (Math.abs(nx - x) < 1e-12) { return nx; }
      x = nx;
    }
    return fail(ERR.CONV);
  });
  def('NPER', 3, 5, (A) => { const r = A.num(0); const pmt = A.num(1); const pv = A.num(2); const fv = A.num(3, 0); const type = A.num(4, 0) ? 1 : 0; if (r === 0) { return pmt === 0 ? fail(ERR.DIV0) : -(pv + fv) / pmt; } const a = pmt * (1 + r * type); const v = Math.log((a - fv * r) / (a + pv * r)) / Math.log1p(r); return isFinite(v) ? v : fail(ERR.NUM); });
  def('RATE', 3, 6, (A) => {
    const n = A.num(0); const pmt = A.num(1); const pv = A.num(2); const fv = A.num(3, 0); const type = A.num(4, 0) ? 1 : 0;
    let x = A.has(5) ? A.num(5) : 0.1;
    if (n <= 0) { return fail(ERR.ARG); }
    const f = (r) => (r === 0 ? pv + pmt * n + fv : pv * Math.pow(1 + r, n) + pmt * (1 + r * type) * (Math.pow(1 + r, n) - 1) / r + fv);
    for (let it = 0; it < 200; it++) {
      const h = 1e-6;
      const y = f(x); const dy = (f(x + h) - f(x - h)) / (2 * h);
      if (!isFinite(y) || !isFinite(dy) || dy === 0) { break; }
      const nx = x - y / dy;
      if (!isFinite(nx) || nx <= -1) { break; }
      if (Math.abs(nx - x) < 1e-13) { return nx; }
      x = nx;
    }
    return fail(ERR.CONV);
  });
  function ipmtOf(A) {
    const r = A.num(0); const per = Math.trunc(A.num(1)); const n = A.num(2); const pv = A.num(3); const fv = A.num(4, 0); const type = A.num(5, 0) ? 1 : 0;
    if (per < 1 || per > n) { return fail(ERR.ARG); }
    const pmt = pmtOf(r, n, pv, fv, type);
    let ipmt;
    if (type === 1) { ipmt = per === 1 ? 0 : (fvOf(r, per - 2, pmt, pv, 1) - pmt) * r; } else { ipmt = fvOf(r, per - 1, pmt, pv, 0) * r; }
    return { ipmt, pmt };
  }
  def('IPMT', 4, 6, (A) => checkFinite(ipmtOf(A).ipmt));
  def('PPMT', 4, 6, (A) => { const x = ipmtOf(A); return checkFinite(x.pmt - x.ipmt); });

  // ---- rewriting formulas -------------------------------------------------
  // A reference token is written back in the style it came in: Sheet2.A1 or
  // Sheet2!A1, quoted or not, $ where it was.

  function partText(p, kind) {
    if (kind === 'cols') { return (p.cAbs ? '$' : '') + colName(p.c); }
    if (kind === 'rows') { return (p.rAbs ? '$' : '') + (p.r + 1); }
    return (p.cAbs ? '$' : '') + colName(p.c) + (p.rAbs ? '$' : '') + (p.r + 1);
  }
  function sheetText(sp) {
    if (!sp) { return ''; }
    const q = sp.quoted || needsQuote(sp.name);
    return (sp.abs ? '$' : '') + (q ? "'" + sp.name.replace(/'/g, "''") + "'" : sp.name) + sp.sep;
  }
  function refText(tok) {
    if (tok.kind === 'cols') { return sheetText(tok.sheet) + partText(tok.a, 'cols') + ':' + sheetText(tok.sheetB) + partText(tok.b, 'cols'); }
    if (tok.kind === 'rows') { return sheetText(tok.sheet) + partText(tok.a, 'rows') + ':' + sheetText(tok.sheetB) + partText(tok.b, 'rows'); }
    return sheetText(tok.sheet) + partText(tok.a, 'cell') + (tok.b ? ':' + sheetText(tok.sheetB) + partText(tok.b, 'cell') : '');
  }
  /** Rewrite every reference of a formula with fn(tok) → new tok | '#REF!' | null (unchanged). */
  function rewrite(formula, fn) {
    const src = String(formula);
    if (src.charAt(0) !== '=') { return src; }
    let toks;
    try { toks = tokenize(src.slice(1)); } catch (e) { return src; }
    let out = '=';
    let pos = 0;
    const body = src.slice(1);
    for (const t of toks) {
      if (t.t !== 'ref') { continue; }
      const res = fn(t);
      if (res == null) { continue; }
      out += body.slice(pos, t.s) + (res === ERR.REF ? ERR.REF : refText(res));
      pos = t.e;
    }
    return out + body.slice(pos);
  }
  const copyTok = (t) => ({ t: 'ref', kind: t.kind, sheet: t.sheet, sheetB: t.sheetB, a: { ...t.a }, b: t.b ? { ...t.b } : null });
  /** Copy/fill: relative parts move by (dr, dc), $-absolute ones stay; off the sheet → #REF!. */
  function shiftFormula(formula, dr, dc) {
    return rewrite(formula, (t) => {
      const n = copyTok(t);
      for (const p of [n.a, n.b]) {
        if (!p) { continue; }
        if (!p.rAbs && p.r >= 0) { p.r += dr; if (p.r < 0 || p.r >= MAXR) { return ERR.REF; } }
        if (!p.cAbs && p.c >= 0) { p.c += dc; if (p.c < 0 || p.c >= MAXC) { return ERR.REF; } }
      }
      return n;
    });
  }
  /** The row or column span of a token on the given axis (whole columns span every row). */
  function span(t, axis) {
    const a = t.a; const b = t.b || t.a;
    if (axis === 'r') { if (t.kind === 'cols') { return [0, MAXR - 1]; } return [Math.min(a.r, b.r), Math.max(a.r, b.r)]; }
    if (t.kind === 'rows') { return [0, MAXC - 1]; }
    return [Math.min(a.c, b.c), Math.max(a.c, b.c)];
  }
  /** Insert (n > 0) or delete (n < 0) |n| rows/columns at `at`: what happens to a span [lo, hi]. */
  function adjustSpan(lo, hi, at, n, whole) {
    if (whole) { return [lo, hi]; }
    if (n > 0) {
      if (lo >= at) { return [lo + n, hi + n]; }
      if (hi >= at) { return [lo, hi + n]; }
      return [lo, hi];
    }
    const cnt = -n; const end = at + cnt;
    if (lo >= at && hi < end) { return null; }
    const nlo = lo < at ? lo : (lo >= end ? lo - cnt : at);
    const nhi = hi < at ? hi : (hi >= end ? hi - cnt : at - 1);
    return nhi < nlo ? null : [nlo, nhi];
  }
  const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  // ---- the workbook -------------------------------------------------------

  class Sheet {
    constructor(wb, name, id) {
      this.wb = wb; this.name = name; this.id = id;
      this.cells = new Map();
      this.maxR = -1; this.maxC = -1;
      this.rdepCols = new Map(); // column → Set of range dependencies touching it
      this.rdepWide = new Set();  // range dependencies wider than 32 columns
      this.extra = {};            // cols, rows, merges, freeze, grid: kept for the UI, untouched
    }
    key(r, c) { return r * MAXC + c; }
    cell(r, c) { return this.cells.get(r * MAXC + c); }
    touch(r, c) { if (r > this.maxR) { this.maxR = r; } if (c > this.maxC) { this.maxC = c; } }
    shrink() { let mr = -1; let mc = -1; for (const cell of this.cells.values()) { if (cell.r > mr) { mr = cell.r; } if (cell.c > mc) { mc = cell.c; } } this.maxR = mr; this.maxC = mc; }
  }

  class Workbook {
    constructor(opts) {
      this.locale = (opts && opts.locale) || 'en';
      this.L = locOf(this.locale);
      this.sheets = [];
      this.byName = new Map();
      this.nextId = 1;
      this.rev = new Map();       // cell id → Set of formula cells depending on it
      this.volatile = new Set();
      this.dirty = new Set();
      this.active = 0;
      this.extraModel = {};
      this.gridBounds = null;
    }
    // -- sheets
    sheetByName(name) { return this.byName.get(String(name).toLowerCase()) || null; }
    sheet(s) {
      if (s instanceof Sheet) { return s; }
      const sh = typeof s === 'number' ? this.sheets[s] : this.sheetByName(s);
      if (!sh) { throw new Error('CalcBaseCalc: no sheet ' + s); }
      return sh;
    }
    sheetNames() { return this.sheets.map((s) => s.name); }
    addSheet(name, index) {
      let nm = name == null || name === '' ? null : String(name);
      if (nm == null) { let i = this.sheets.length + 1; while (this.sheetByName('Sheet' + i)) { i++; } nm = 'Sheet' + i; }
      if (this.sheetByName(nm)) { throw new Error('CalcBaseCalc: sheet exists ' + nm); }
      const sh = new Sheet(this, nm, this.nextId++);
      const at = index == null ? this.sheets.length : Math.max(0, Math.min(this.sheets.length, index));
      this.sheets.splice(at, 0, sh);
      this.byName.set(nm.toLowerCase(), sh);
      if (this.sheets.length > 1) { this.rebuild(); }
      return sh.name;
    }
    renameSheet(oldName, newName) {
      const sh = this.sheet(oldName);
      const nm = String(newName);
      if (!nm) { throw new Error('CalcBaseCalc: empty sheet name'); }
      const other = this.sheetByName(nm);
      if (other && other !== sh) { throw new Error('CalcBaseCalc: sheet exists ' + nm); }
      this.byName.delete(sh.name.toLowerCase());
      const was = sh.name;
      sh.name = nm;
      this.byName.set(nm.toLowerCase(), sh);
      this.rewriteAll((t) => {
        let changed = false;
        const n = copyTok(t);
        if (n.sheet && sameName(n.sheet.name, was)) { n.sheet = { ...n.sheet, name: nm, quoted: false }; changed = true; }
        if (n.sheetB && sameName(n.sheetB.name, was)) { n.sheetB = { ...n.sheetB, name: nm, quoted: false }; changed = true; }
        return changed ? n : null;
      });
      return this.rebuild();
    }
    removeSheet(name) {
      const sh = this.sheet(name);
      if (this.sheets.length === 1) { throw new Error('CalcBaseCalc: cannot remove the last sheet'); }
      this.sheets.splice(this.sheets.indexOf(sh), 1);
      this.byName.delete(sh.name.toLowerCase());
      this.rewriteAll((t) => ((t.sheet && sameName(t.sheet.name, sh.name)) || (t.sheetB && sameName(t.sheetB.name, sh.name)) ? ERR.REF : null), sh);
      if (this.active >= this.sheets.length) { this.active = this.sheets.length - 1; }
      return this.rebuild();
    }
    moveSheet(name, index) {
      const sh = this.sheet(name);
      this.sheets.splice(this.sheets.indexOf(sh), 1);
      this.sheets.splice(Math.max(0, Math.min(this.sheets.length, index)), 0, sh);
    }
    // -- cells
    get(s, r, c) {
      const sh = this.sheet(s);
      const cell = sh.cell(r, c);
      if (!cell) { return { v: null, t: '' }; }
      const out = { v: cell.v, t: cell.t };
      if (cell.f) { out.f = cell.f; out.fmtHint = cell.hint || ''; }
      if (cell.fmt != null) { out.fmt = cell.fmt; }
      if (cell.s != null) { out.s = cell.s; }
      return out;
    }
    /** Text as typed: a formula, a number, a date, TRUE/FALSE, text ('… forces text), '' clears. */
    setInput(s, r, c, text) {
      const p = parseInput(text, this.locale);
      if (p.t === 'f') { return this.setCell(s, r, c, { f: p.v }); }
      const spec = { v: p.v, t: p.t };
      if (p.fmt) { spec.fmt = p.fmt; }
      return this.setCell(s, r, c, spec);
    }
    /** Put a cell as a file holds it: { f, v, t, fmt, s }. Formulas are not recalculated unless they are new or changed. */
    setCell(s, r, c, spec) {
      const sh = this.sheet(s);
      const changed = [];
      this.put(sh, r, c, spec || {}, changed, true);
      return changed.concat(this.flush());
    }
    put(sh, r, c, spec, changed, live) {
      const key = sh.key(r, c);
      let cell = sh.cells.get(key);
      const oldV = cell ? cell.v : null; const oldT = cell ? cell.t : '';
      const f = spec.f != null && String(spec.f).charAt(0) === '=' && String(spec.f).length > 1 ? String(spec.f) : null;
      const empty = !f && (spec.v == null || spec.v === '') && spec.t !== 's' && spec.fmt == null && spec.s == null && (!cell || (cell.fmt == null && cell.s == null));
      if (cell && cell.f) { this.unregister(cell); }
      if (empty) {
        if (cell) { sh.cells.delete(key); if (r === sh.maxR || c === sh.maxC) { sh.shrink(); } }
        if (oldV !== null || oldT !== '') { changed.push({ sheet: sh.name, r, c }); }
        if (live) { this.propagate(sh, r, c); }
        return;
      }
      if (!cell) { cell = { r, c, sheet: sh, f: null, ast: null, v: null, t: '', fmt: undefined, s: undefined, hint: '', vol: false, dirty: false, pre: null, busy: false }; sh.cells.set(key, cell); sh.touch(r, c); }
      if ('fmt' in spec) { cell.fmt = spec.fmt == null ? undefined : spec.fmt; } else if (!f && spec.v != null) { cell.fmt = cell.fmt; }
      if ('s' in spec) { cell.s = spec.s == null ? undefined : spec.s; }
      if (f) {
        const same = cell.f === f;
        cell.f = f;
        if (!same || !cell.ast) {
          cell.ast = null; cell.err = null;
          try { cell.ast = parse(f.slice(1)); } catch (e) { if (isErr(e)) { cell.err = e.code; } else { throw e; } }
        }
        this.register(cell, sh);
        // A new or changed formula: it and everything reading it are worked out again.
        if (spec.v !== undefined && !live) { cell.v = spec.v; cell.t = spec.t || typeOf(spec.v); cell.dirty = false; } else { cell.dirty = false; this.markDirty(cell); }
        if (live && oldV === null && oldT === '') { /* value comes with the flush */ }
      } else {
        cell.f = null; cell.ast = null; cell.err = null; cell.hint = '';
        const v = spec.v == null ? null : spec.v;
        cell.v = v; cell.t = spec.t || typeOf(v);
        cell.dirty = false;
        if (v !== oldV || cell.t !== oldT) { changed.push({ sheet: sh.name, r, c }); if (live) { this.propagate(sh, r, c); } }
      }
    }
    // -- dependency graph
    cellId(sh, r, c) { return sh.id * 34359738368 + r * MAXC + c; }
    register(cell, sh) {
      const pre = { cells: [], ranges: [] };
      cell.vol = !!(cell.ast && cell.ast.info.volatile);
      if (cell.vol) { this.volatile.add(cell); } else { this.volatile.delete(cell); }
      if (cell.ast) {
        for (const t of cell.ast.info.refs) {
          const target = t.sheet ? this.sheetByName(t.sheet.name) : sh;
          if (!target) { continue; }
          const [r0, r1] = span(t, 'r'); const [c0, c1] = span(t, 'c');
          if (r0 === r1 && c0 === c1) {
            const id = this.cellId(target, r0, c0);
            pre.cells.push(id);
            let set = this.rev.get(id); if (!set) { set = new Set(); this.rev.set(id, set); }
            set.add(cell);
          } else {
            const dep = { cell, sheet: target, r0, c0, r1, c1 };
            pre.ranges.push(dep);
            if (c1 - c0 > 32) { target.rdepWide.add(dep); } else { for (let c = c0; c <= c1; c++) { let set = target.rdepCols.get(c); if (!set) { set = new Set(); target.rdepCols.set(c, set); } set.add(dep); } }
          }
        }
      }
      cell.pre = pre;
    }
    unregister(cell) {
      const pre = cell.pre;
      if (pre) {
        for (const id of pre.cells) { const set = this.rev.get(id); if (set) { set.delete(cell); if (!set.size) { this.rev.delete(id); } } }
        for (const dep of pre.ranges) { if (dep.c1 - dep.c0 > 32) { dep.sheet.rdepWide.delete(dep); } else { for (let c = dep.c0; c <= dep.c1; c++) { const set = dep.sheet.rdepCols.get(c); if (set) { set.delete(dep); } } } }
      }
      cell.pre = null;
      this.volatile.delete(cell);
      this.dirty.delete(cell);
    }
    /** A cell's value changed: every formula reading it must be worked out again. */
    propagate(sh, r, c) {
      const set = this.rev.get(this.cellId(sh, r, c));
      if (set) { for (const dep of set) { this.markDirty(dep); } }
      const col = sh.rdepCols.get(c);
      if (col) { for (const d of col) { if (r >= d.r0 && r <= d.r1) { this.markDirty(d.cell); } } }
      for (const d of sh.rdepWide) { if (r >= d.r0 && r <= d.r1 && c >= d.c0 && c <= d.c1) { this.markDirty(d.cell); } }
    }
    markDirty(cell) {
      if (cell.dirty) { return; }
      const stack = [cell];
      while (stack.length) {
        const x = stack.pop();
        if (x.dirty) { continue; }
        x.dirty = true;
        this.dirty.add(x);
        const sh = this.sheetOfCell(x);
        const set = this.rev.get(this.cellId(sh, x.r, x.c));
        if (set) { for (const dep of set) { if (!dep.dirty) { stack.push(dep); } } }
        const col = sh.rdepCols.get(x.c);
        if (col) { for (const d of col) { if (x.r >= d.r0 && x.r <= d.r1 && !d.cell.dirty) { stack.push(d.cell); } } }
        for (const d of sh.rdepWide) { if (x.r >= d.r0 && x.r <= d.r1 && x.c >= d.c0 && x.c <= d.c1 && !d.cell.dirty) { stack.push(d.cell); } }
      }
    }
    sheetOfCell(cell) { if (cell.sheet) { return cell.sheet; } for (const sh of this.sheets) { if (sh.cells.get(sh.key(cell.r, cell.c)) === cell) { cell.sheet = sh; return sh; } } return null; }
    // -- recalculation
    /** Work out every dirty formula (volatile ones too); answers which cells changed value. */
    flush() {
      const changed = [];
      for (const cell of this.volatile) { this.markDirty(cell); }
      if (!this.dirty.size) { return changed; }
      const work = Array.from(this.dirty);
      for (const cell of work) { if (cell.dirty) { this.ensure(cell, changed); } }
      this.dirty.clear();
      return changed;
    }
    recalc() {
      for (const sh of this.sheets) { for (const cell of sh.cells.values()) { if (cell.f) { cell.dirty = true; this.dirty.add(cell); } } }
      return this.flush();
    }
    /** Rebuild the graph and work everything out again (after sheets or rows moved). */
    rebuild() {
      this.rev = new Map(); this.volatile = new Set(); this.dirty = new Set();
      for (const sh of this.sheets) { sh.rdepCols = new Map(); sh.rdepWide = new Set(); }
      for (const sh of this.sheets) { for (const cell of sh.cells.values()) { cell.sheet = sh; if (cell.f) { cell.pre = null; cell.busy = false; if (!cell.ast && !cell.err) { try { cell.ast = parse(cell.f.slice(1)); } catch (e) { if (isErr(e)) { cell.err = e.code; } else { throw e; } } } this.register(cell, sh); } } }
      return this.recalc();
    }
    /** Evaluate a formula cell and, first, any dirty cell it reads; cycles become Err:522 for every cell in them. */
    ensure(root, changed) {
      const stack = [root];
      root.busy = true; root.depth = 0;
      let cycleFrom = -1;
      while (stack.length) {
        const cell = stack[stack.length - 1];
        if (!cell.dirty) { cell.busy = false; stack.pop(); continue; }
        const sh = this.sheetOfCell(cell);
        const pending = [];
        const ctx = this.context(sh, cell, pending, (busyCell) => { cycleFrom = cycleFrom < 0 ? busyCell.depth : Math.min(cycleFrom, busyCell.depth); });
        let v; let hint = '';
        if (cell.err) { v = new CalcError(cell.err); } else {
          try {
            v = ev(cell.ast, ctx);
            if (!pending.length) {
              const fromFn = v instanceof RangeVal && cell.ast.k === 'fn';
              v = deref(v, ctx);
              if (v == null) { v = fromFn ? '' : 0; }
              if (typeof v === 'number' && !isFinite(v)) { v = new CalcError(ERR.NUM); }
              hint = this.inferHint(cell.ast, ctx);
            }
          } catch (e) { if (isErr(e)) { v = e; } else { throw e; } }
        }
        if (pending.length) {
          const fresh = pending.filter((p) => p.dirty && !p.busy);
          if (fresh.length) { for (const p of fresh) { p.busy = true; p.depth = stack.length; stack.push(p); } continue; }
          // every pending cell is on the stack: a cycle through this cell
          v = new CalcError(ERR.CIRC);
        }
        if (cycleFrom >= 0 && cell.depth >= cycleFrom) { v = new CalcError(ERR.CIRC); }
        if (cycleFrom === cell.depth) { cycleFrom = -1; }
        const oldV = cell.v; const oldT = cell.t;
        if (isErr(v)) { cell.v = v.code; cell.t = 'e'; } else { cell.v = v; cell.t = typeOf(v); }
        cell.hint = hint;
        cell.dirty = false; cell.busy = false;
        this.dirty.delete(cell);
        stack.pop();
        if (cell.v !== oldV || cell.t !== oldT) { changed.push({ sheet: sh.name, r: cell.r, c: cell.c }); }
      }
    }
    context(sh, cell, pending, onCycle) {
      const wb = this;
      return {
        wb, sheet: sh, at: { r: cell.r, c: cell.c }, L: this.L,
        cellValue(target, r, c) {
          const x = target.cells.get(r * MAXC + c);
          if (!x) { return null; }
          if (x.f && x.dirty) {
            if (x.busy || x === cell) { onCycle(x); return new CalcError(ERR.CIRC); }
            pending.push(x);
            return null;
          }
          if (x.t === 'e') { return new CalcError(x.v); }
          return x.v;
        },
        cellType(node) { return ''; },
      };
    }
    /** What a formula probably shows: a date, a time, a percentage, money — from the functions and cells it uses. */
    inferHint(ast, ctx) {
      const kindOfCell = (tok) => {
        const sh = tok.sheet ? this.sheetByName(tok.sheet.name) : ctx.sheet;
        if (!sh || tok.kind !== 'cell') { return ''; }
        const cell = sh.cells.get(tok.a.r * MAXC + tok.a.c);
        if (!cell) { return ''; }
        return cell.fmt ? fmtKind(cell.fmt) : (cell.hint || '');
      };
      const walk = (n) => {
        switch (n.k) {
          case 'ref': return kindOfCell(n.tok);
          case 'pct': return 'percent';
          case 'neg': return walk(n.a);
          case 'fn': {
            if (n.name === 'DATE' || n.name === 'TODAY' || n.name === 'DATEVALUE') { return 'date'; }
            if (n.name === 'NOW') { return 'datetime'; }
            if (n.name === 'TIME' || n.name === 'TIMEVALUE') { return 'time'; }
            if (['PMT', 'FV', 'PV', 'NPV', 'IPMT', 'PPMT'].indexOf(n.name) >= 0) { return 'currency'; }
            if (n.name === 'IRR' || n.name === 'RATE') { return 'percent'; }
            if (n.name === 'IF' && n.args[1]) { return walk(n.args[1]); }
            if ((n.name === 'SUM' || n.name === 'MIN' || n.name === 'MAX' || n.name === 'IFERROR') && n.args[0]) { return walk(n.args[0]); }
            return '';
          }
          case 'bin': {
            if (n.op === '+' || n.op === '-') {
              const a = walk(n.a); const b = walk(n.b);
              const isDt = (k) => k === 'date' || k === 'datetime' || k === 'time';
              if (n.op === '-' && isDt(a) && isDt(b)) { return ''; }
              return a || b;
            }
            if (n.op === '*' || n.op === '/') { const a = walk(n.a); const b = walk(n.b); return a === 'currency' || b === 'currency' ? 'currency' : ''; }
            return '';
          }
          default: return '';
        }
      };
      return walk(ast);
    }
    // -- structure
    rewriteAll(fn, skipSheet) {
      for (const sh of this.sheets) {
        if (sh === skipSheet) { continue; }
        for (const cell of sh.cells.values()) {
          if (!cell.f) { continue; }
          const nf = rewrite(cell.f, (t) => fn(t, sh));
          if (nf !== cell.f) { cell.f = nf; cell.ast = null; cell.err = null; }
        }
      }
    }
    /** Insert (n > 0) or delete (n < 0) rows (axis 'r') or columns (axis 'c') of a sheet at `at`. */
    shiftAxis(s, axis, at, n) {
      const sh = this.sheet(s);
      const other = axis === 'r' ? 'c' : 'r';
      this.rewriteAll((t, formulaSheet) => {
        const target = t.sheet ? this.sheetByName(t.sheet.name) : formulaSheet;
        if (target !== sh) { return null; }
        const whole = axis === 'r' ? t.kind === 'cols' : t.kind === 'rows';
        const [lo, hi] = span(t, axis);
        const nw = adjustSpan(lo, hi, at, n, whole);
        if (!nw) { return ERR.REF; }
        if (nw[0] === lo && nw[1] === hi) { return null; }
        const nt = copyTok(t);
        const a = nt.a; const b = nt.b || nt.a;
        const first = axis === 'r' ? (a.r <= b.r ? a : b) : (a.c <= b.c ? a : b);
        const second = first === a ? b : a;
        if (axis === 'r') { first.r = nw[0]; second.r = nw[1]; if (!nt.b) { a.r = nw[0]; } } else { first.c = nw[0]; second.c = nw[1]; if (!nt.b) { a.c = nw[0]; } }
        return nt;
      });
      const moved = new Map();
      for (const cell of sh.cells.values()) {
        const pos = axis === 'r' ? cell.r : cell.c;
        let np = pos;
        if (n > 0) { if (pos >= at) { np = pos + n; } } else { if (pos >= at && pos < at - n) { continue; } if (pos >= at - n) { np = pos + n; } }
        if (axis === 'r') { cell.r = np; } else { cell.c = np; }
        if ((axis === 'r' ? cell.r : cell.c) >= (axis === 'r' ? MAXR : MAXC)) { continue; }
        moved.set(sh.key(cell.r, cell.c), cell);
      }
      sh.cells = moved;
      sh.shrink();
      void other;
      return this.rebuild();
    }
    insertRows(s, at, n) { return this.shiftAxis(s, 'r', at, Math.max(1, n || 1)); }
    deleteRows(s, at, n) { return this.shiftAxis(s, 'r', at, -Math.max(1, n || 1)); }
    insertCols(s, at, n) { return this.shiftAxis(s, 'c', at, Math.max(1, n || 1)); }
    deleteCols(s, at, n) { return this.shiftAxis(s, 'c', at, -Math.max(1, n || 1)); }
    /** Cut and paste a block: references to the moved cells follow them; cells pasted over are gone (#REF!). */
    moveRange(s, srcRange, dstTopLeft) {
      const sh = this.sheet(s);
      const src = rangeOf(srcRange); const dst = parseRef(dstTopLeft);
      if (!src || !dst) { throw new Error('CalcBaseCalc: bad range'); }
      const dr = dst.r - src.r0; const dc = dst.c - src.c0;
      if (!dr && !dc) { return []; }
      const inSrc = (r, c) => r >= src.r0 && r <= src.r1 && c >= src.c0 && c <= src.c1;
      const inDst = (r, c) => r >= src.r0 + dr && r <= src.r1 + dr && c >= src.c0 + dc && c <= src.c1 + dc;
      this.rewriteAll((t, formulaSheet) => {
        const target = t.sheet ? this.sheetByName(t.sheet.name) : formulaSheet;
        if (target !== sh || t.kind === 'cols' || t.kind === 'rows') { return null; }
        const a = t.a; const b = t.b || t.a;
        const r0 = Math.min(a.r, b.r); const r1 = Math.max(a.r, b.r); const c0 = Math.min(a.c, b.c); const c1 = Math.max(a.c, b.c);
        if (inSrc(r0, c0) && inSrc(r1, c1)) { const nt = copyTok(t); nt.a.r += dr; nt.a.c += dc; if (nt.b) { nt.b.r += dr; nt.b.c += dc; } return nt; }
        if (inDst(r0, c0) && inDst(r1, c1) && !inSrc(r0, c0)) { return ERR.REF; }
        return null;
      });
      const moved = new Map();
      for (const cell of sh.cells.values()) {
        if (inSrc(cell.r, cell.c)) { cell.r += dr; cell.c += dc; if (cell.r < 0 || cell.c < 0 || cell.r >= MAXR || cell.c >= MAXC) { continue; } moved.set(sh.key(cell.r, cell.c), cell); } else if (!inDst(cell.r, cell.c)) { moved.set(sh.key(cell.r, cell.c), cell); }
      }
      sh.cells = moved;
      sh.shrink();
      return this.rebuild();
    }
    // -- the model (§3)
    load(model) {
      this.sheets = []; this.byName = new Map(); this.rev = new Map(); this.volatile = new Set(); this.dirty = new Set();
      const m = model || {};
      this.extraModel = {};
      for (const k of Object.keys(m)) { if (k !== 'sheets' && k !== 'active') { this.extraModel[k] = m[k]; } }
      (m.sheets && m.sheets.length ? m.sheets : [{ name: 'Sheet1', cells: {} }]).forEach((ms, i) => {
        const nm = ms.name || 'Sheet' + (i + 1);
        const sh = new Sheet(this, nm, this.nextId++);
        this.sheets.push(sh); this.byName.set(nm.toLowerCase(), sh);
        for (const k of Object.keys(ms)) { if (k !== 'name' && k !== 'cells') { sh.extra[k] = ms[k]; } }
        const cells = ms.cells || {};
        for (const addr of Object.keys(cells)) {
          const ref = parseRef(addr);
          if (!ref) { continue; }
          const c = cells[addr] || {};
          this.put(sh, ref.r, ref.c, { f: c.f, v: c.v, t: c.t, fmt: c.fmt, s: c.s }, [], false);
        }
      });
      this.active = m.active || 0;
      for (const sh of this.sheets) { for (const cell of sh.cells.values()) { if (cell.f) { cell.sheet = sh; if (cell.v === undefined) { cell.dirty = true; this.dirty.add(cell); } } } }
      return this.flush();
    }
    toModel() {
      const out = { ...this.extraModel, sheets: [], active: this.active };
      for (const sh of this.sheets) {
        const ms = { name: sh.name, cells: {} };
        const keys = Array.from(sh.cells.values()).sort((a, b) => a.r - b.r || a.c - b.c);
        for (const cell of keys) {
          const o = {};
          if (cell.f) { o.f = cell.f; }
          if (cell.v !== null || cell.f) { o.v = cell.v; o.t = cell.t; }
          if (cell.fmt != null) { o.fmt = cell.fmt; }
          if (cell.s != null) { o.s = cell.s; }
          ms.cells[refName(cell.r, cell.c)] = o;
        }
        Object.assign(ms, sh.extra);
        out.sheets.push(ms);
      }
      return out;
    }
  }
  /** 'B2:D4' or 'B2' → { r0, c0, r1, c1 }. */
  function rangeOf(text) {
    const parts = String(text).split(':');
    const a = parseRef(parts[0]); const b = parseRef(parts[1] || parts[0]);
    if (!a || !b) { return null; }
    return { r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) };
  }
  function workbook(opts) {
    const wb = new Workbook(opts || {});
    wb.addSheet((opts && opts.sheet) || 'Sheet1');
    return wb;
  }

  // ---- fill series --------------------------------------------------------

  const DAY_SERIES = [LOC.en.days, LOC.en.daysShort, LOC.ja.days, LOC.ja.daysShort.map((d) => d + '曜')];
  const MONTH_SERIES = [LOC.en.months, LOC.en.monthsShort, LOC.ja.monthsShort];
  function seriesOf(text) {
    for (const list of DAY_SERIES.concat(MONTH_SERIES)) {
      const i = list.findIndex((x) => x.toLowerCase() === String(text).toLowerCase());
      if (i >= 0) { return { list, i, upper: text === text.toUpperCase() && /[a-z]/i.test(text) }; }
    }
    return null;
  }
  /**
   * The next n values after a selection, as the fill handle makes them: 1,2 → 3,4;
   * Mon → Tue; a date → the next days (or months when the days agree); 1月 → 2月;
   * 'Item 1' → 'Item 2'. Values are typed text or { v, t, fmt }; the answer has
   * the same shape.
   */
  function fillSeries(values, n, locale) {
    const L = locOf(locale);
    const asObj = values.length && typeof values[0] === 'object' && values[0] !== null;
    const items = values.map((x) => (typeof x === 'object' && x !== null ? { ...x } : (() => { const p = parseInput(x, L.id); return { v: p.v, t: p.t, fmt: p.fmt, text: String(x) }; })()));
    const out = [];
    const emit = (o) => { if (asObj) { const r = { v: o.v, t: o.t }; if (o.fmt) { r.fmt = o.fmt; } out.push(r); } else { out.push(o.t === 's' ? String(o.v) : o.t === 'n' ? (o.fmt ? format(o.v, 'n', o.fmt, L.id) : general(o.v)) : o.t === 'b' ? (o.v ? 'TRUE' : 'FALSE') : ''); } };
    const nums = items.every((o) => o.t === 'n');
    if (items.length && nums) {
      const vs = items.map((o) => o.v);
      const fmt = items[items.length - 1].fmt;
      const kind = fmt ? fmtKind(fmt) : '';
      if (kind === 'date' && vs.length > 1) {
        const ymds = vs.map((v) => serialToYmd(v));
        const sameDay = ymds.every((p) => p.d === ymds[0].d || (p.d === daysInMonth(p.y, p.m) && ymds[0].d >= p.d));
        const mstep = (ymds[1].y - ymds[0].y) * 12 + ymds[1].m - ymds[0].m;
        const monthly = sameDay && mstep !== 0 && ymds.every((p, i) => i === 0 || (p.y - ymds[i - 1].y) * 12 + p.m - ymds[i - 1].m === mstep);
        if (monthly) { let last = vs[vs.length - 1]; for (let i = 0; i < n; i++) { const x = addMonths(last, mstep); x.d = Math.min(ymds[0].d, daysInMonth(x.y, x.m)); last = ymdToSerial(x.y, x.m, x.d); emit({ v: last, t: 'n', fmt }); } return out; }
      }
      let step = 1;
      let linear = true;
      if (vs.length >= 2) {
        step = vs[1] - vs[0];
        for (let i = 2; i < vs.length; i++) { if (!approxEqual(vs[i] - vs[i - 1], step) && Math.abs((vs[i] - vs[i - 1]) - step) > 1e-9) { linear = false; break; } }
      }
      if (linear) { const last = vs[vs.length - 1]; for (let i = 1; i <= n; i++) { emit({ v: last + step * i, t: 'n', fmt }); } return out; }
      // not a straight series: the least-squares trend, as Calc's fill does
      const m = vs.length; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
      vs.forEach((y, x) => { sx += x; sy += y; sxx += x * x; sxy += x * y; });
      const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx); const icpt = (sy - slope * sx) / m;
      for (let i = 0; i < n; i++) { emit({ v: icpt + slope * (m + i), t: 'n', fmt }); }
      return out;
    }
    if (items.length && items.every((o) => o.t === 's')) {
      const last = String(items[items.length - 1].v);
      const ser = seriesOf(last);
      if (ser && items.every((o) => seriesOf(String(o.v)) && seriesOf(String(o.v)).list === ser.list)) {
        const idx = items.map((o) => seriesOf(String(o.v)).i);
        const step = idx.length > 1 ? ((idx[1] - idx[0]) % ser.list.length + ser.list.length) % ser.list.length || 1 : 1;
        for (let i = 1; i <= n; i++) { let s = ser.list[(ser.i + step * i) % ser.list.length]; if (ser.upper) { s = s.toUpperCase(); } emit({ v: s, t: 's' }); }
        return out;
      }
      const m = /^(.*?)(\d+)(\D*)$/.exec(last);
      if (m) {
        const allNums = items.map((o) => /^(.*?)(\d+)(\D*)$/.exec(String(o.v)));
        let step = 1;
        if (allNums.every((x) => x && x[1] === m[1] && x[3] === m[3]) && allNums.length > 1) { step = Number(allNums[1][2]) - Number(allNums[0][2]); const consistent = allNums.every((x, i) => i === 0 || Number(x[2]) - Number(allNums[i - 1][2]) === step); if (!consistent) { step = 1; } }
        const width = m[2].length;
        for (let i = 1; i <= n; i++) { const v = Number(m[2]) + step * i; emit({ v: m[1] + (m[2].charAt(0) === '0' ? String(Math.max(0, v)).padStart(width, '0') : String(v)) + m[3], t: 's' }); }
        return out;
      }
    }
    for (let i = 0; i < n; i++) { emit(items.length ? items[i % items.length] : { v: null, t: '' }); }
    return out;
  }

  // ---- the old grid API (EditBase's tables) --------------------------------

  /**
   * Work out a whole table. grid[r][c] is the text written in each cell -- a
   * formula when it starts with "=". The answer has the same shape: for each
   * cell, { value, text, error, formula } where text is what the cell shows.
   */
  function compute(grid, formats) {
    const wb = workbook({ locale: 'ja' });
    const rows = grid.length;
    let cols = 0;
    grid.forEach((row) => { if (row && row.length > cols) { cols = row.length; } });
    wb.gridBounds = { rows, cols };
    const sh = wb.sheets[0];
    grid.forEach((row, r) => (row || []).forEach((src, c) => {
      const text = src == null ? '' : String(src);
      if (text.charAt(0) === '=' && text.length > 1) { wb.put(sh, r, c, { f: text }, [], false); } else { const v = literal(text); if (v !== '') { wb.put(sh, r, c, { v, t: typeOf(v) }, [], false); } }
    }));
    wb.recalc();
    return grid.map((row, r) => (row || []).map((src, c) => {
      const cell = sh.cell(r, c);
      const v = cell ? (cell.t === 'e' ? new CalcError(cell.v) : cell.v) : '';
      const formula = String(src == null ? '' : src).charAt(0) === '=' && String(src).length > 1;
      const code = formats && formats[r] ? formats[r][c] || '' : '';
      return { value: isErr(v) ? null : (v == null ? '' : v), text: formatAs(v == null ? '' : v, code), error: isErr(v) ? v.code : '', formula };
    }));
  }

  // ---- the list of functions ----------------------------------------------

  const FUNCS = [
    ['SUM', 'Mathematical', 'SUM(number 1; number 2; …)', 'Adds the numbers.'],
    ['SUMIF', 'Mathematical', 'SUMIF(range; criterion; sum range)', 'Adds the cells that meet a criterion.'],
    ['SUMIFS', 'Mathematical', 'SUMIFS(sum range; range 1; criterion 1; …)', 'Adds the cells that meet every criterion.'],
    ['SUMPRODUCT', 'Mathematical', 'SUMPRODUCT(array 1; array 2; …)', 'Multiplies matching entries and adds the products.'],
    ['PRODUCT', 'Mathematical', 'PRODUCT(number 1; number 2; …)', 'Multiplies the numbers.'],
    ['ROUND', 'Mathematical', 'ROUND(number; places)', 'Rounds to the given number of decimal places.'],
    ['ROUNDUP', 'Mathematical', 'ROUNDUP(number; places)', 'Rounds away from zero.'],
    ['ROUNDDOWN', 'Mathematical', 'ROUNDDOWN(number; places)', 'Rounds towards zero.'],
    ['INT', 'Mathematical', 'INT(number)', 'Rounds down to a whole number.'],
    ['TRUNC', 'Mathematical', 'TRUNC(number; places)', 'Cuts off decimal places.'],
    ['MOD', 'Mathematical', 'MOD(number; divisor)', 'The remainder after dividing.'],
    ['ABS', 'Mathematical', 'ABS(number)', 'The number without its sign.'],
    ['SIGN', 'Mathematical', 'SIGN(number)', '1, 0 or -1 for the sign of the number.'],
    ['SQRT', 'Mathematical', 'SQRT(number)', 'The square root.'],
    ['POWER', 'Mathematical', 'POWER(number; power)', 'A number raised to a power.'],
    ['EXP', 'Mathematical', 'EXP(number)', 'e raised to the power.'],
    ['LN', 'Mathematical', 'LN(number)', 'The natural logarithm.'],
    ['LOG', 'Mathematical', 'LOG(number; base)', 'The logarithm to a base (10 when omitted).'],
    ['LOG10', 'Mathematical', 'LOG10(number)', 'The base-10 logarithm.'],
    ['PI', 'Mathematical', 'PI()', 'The number π.'],
    ['CEILING', 'Mathematical', 'CEILING(number; significance; mode)', 'Rounds up to a multiple of the significance.'],
    ['FLOOR', 'Mathematical', 'FLOOR(number; significance; mode)', 'Rounds down to a multiple of the significance.'],
    ['MROUND', 'Mathematical', 'MROUND(number; multiple)', 'Rounds to the nearest multiple.'],
    ['QUOTIENT', 'Mathematical', 'QUOTIENT(numerator; denominator)', 'The whole part of a division.'],
    ['GCD', 'Mathematical', 'GCD(integer 1; integer 2; …)', 'The greatest common divisor.'],
    ['LCM', 'Mathematical', 'LCM(integer 1; integer 2; …)', 'The least common multiple.'],
    ['FACT', 'Mathematical', 'FACT(number)', 'The factorial.'],
    ['RAND', 'Mathematical', 'RAND()', 'A random number between 0 and 1.'],
    ['RANDBETWEEN', 'Mathematical', 'RANDBETWEEN(bottom; top)', 'A random whole number in a range.'],
    ['AVERAGE', 'Statistical', 'AVERAGE(number 1; number 2; …)', 'The average of the numbers.'],
    ['AVERAGEIF', 'Statistical', 'AVERAGEIF(range; criterion; average range)', 'The average of the cells that meet a criterion.'],
    ['AVERAGEIFS', 'Statistical', 'AVERAGEIFS(average range; range 1; criterion 1; …)', 'The average of the cells that meet every criterion.'],
    ['MIN', 'Statistical', 'MIN(number 1; number 2; …)', 'The smallest number.'],
    ['MAX', 'Statistical', 'MAX(number 1; number 2; …)', 'The largest number.'],
    ['MINIFS', 'Statistical', 'MINIFS(min range; range 1; criterion 1; …)', 'The smallest of the cells that meet every criterion.'],
    ['MAXIFS', 'Statistical', 'MAXIFS(max range; range 1; criterion 1; …)', 'The largest of the cells that meet every criterion.'],
    ['MEDIAN', 'Statistical', 'MEDIAN(number 1; number 2; …)', 'The middle number.'],
    ['MODE', 'Statistical', 'MODE(number 1; number 2; …)', 'The most frequent number.'],
    ['COUNT', 'Statistical', 'COUNT(value 1; value 2; …)', 'Counts the numbers.'],
    ['COUNTA', 'Statistical', 'COUNTA(value 1; value 2; …)', 'Counts the cells that are not empty.'],
    ['COUNTBLANK', 'Statistical', 'COUNTBLANK(range)', 'Counts the empty cells.'],
    ['COUNTIF', 'Statistical', 'COUNTIF(range; criterion)', 'Counts the cells that meet a criterion.'],
    ['COUNTIFS', 'Statistical', 'COUNTIFS(range 1; criterion 1; range 2; criterion 2; …)', 'Counts the cells that meet every criterion.'],
    ['LARGE', 'Statistical', 'LARGE(data; rank)', 'The k-th largest value.'],
    ['SMALL', 'Statistical', 'SMALL(data; rank)', 'The k-th smallest value.'],
    ['RANK', 'Statistical', 'RANK(value; data; order)', 'The rank of a value in the data.'],
    ['STDEV', 'Statistical', 'STDEV(number 1; number 2; …)', 'The standard deviation of a sample.'],
    ['STDEVP', 'Statistical', 'STDEVP(number 1; number 2; …)', 'The standard deviation of a population.'],
    ['VAR', 'Statistical', 'VAR(number 1; number 2; …)', 'The variance of a sample.'],
    ['VARP', 'Statistical', 'VARP(number 1; number 2; …)', 'The variance of a population.'],
    ['IF', 'Logical', 'IF(test; then; otherwise)', 'One value if the test is true, another if it is not.'],
    ['IFS', 'Logical', 'IFS(test 1; value 1; test 2; value 2; …)', 'The value of the first test that is true.'],
    ['IFERROR', 'Logical', 'IFERROR(value; if error)', 'The value, or something else when it is an error.'],
    ['IFNA', 'Logical', 'IFNA(value; if #N/A)', 'The value, or something else when it is #N/A.'],
    ['AND', 'Logical', 'AND(test 1; test 2; …)', 'TRUE when every test is true.'],
    ['OR', 'Logical', 'OR(test 1; test 2; …)', 'TRUE when any test is true.'],
    ['XOR', 'Logical', 'XOR(test 1; test 2; …)', 'TRUE when an odd number of tests are true.'],
    ['NOT', 'Logical', 'NOT(test)', 'The opposite of the test.'],
    ['SWITCH', 'Logical', 'SWITCH(value; case 1; result 1; …; otherwise)', 'The result matching the value.'],
    ['CHOOSE', 'Logical', 'CHOOSE(index; value 1; value 2; …)', 'The value at the index.'],
    ['TRUE', 'Logical', 'TRUE()', 'The value TRUE.'],
    ['FALSE', 'Logical', 'FALSE()', 'The value FALSE.'],
    ['CONCATENATE', 'Text', 'CONCATENATE(text 1; text 2; …)', 'Joins the texts together.'],
    ['CONCAT', 'Text', 'CONCAT(text 1; text 2; …)', 'Joins texts and ranges together.'],
    ['TEXTJOIN', 'Text', 'TEXTJOIN(delimiter; skip empty; text 1; …)', 'Joins texts with a delimiter.'],
    ['LEFT', 'Text', 'LEFT(text; count)', 'The first characters.'],
    ['RIGHT', 'Text', 'RIGHT(text; count)', 'The last characters.'],
    ['MID', 'Text', 'MID(text; start; count)', 'Characters from the middle.'],
    ['LEN', 'Text', 'LEN(text)', 'The number of characters.'],
    ['UPPER', 'Text', 'UPPER(text)', 'In capital letters.'],
    ['LOWER', 'Text', 'LOWER(text)', 'In small letters.'],
    ['PROPER', 'Text', 'PROPER(text)', 'Each word starting with a capital.'],
    ['TRIM', 'Text', 'TRIM(text)', 'Without extra spaces.'],
    ['CLEAN', 'Text', 'CLEAN(text)', 'Without non-printing characters.'],
    ['SUBSTITUTE', 'Text', 'SUBSTITUTE(text; old; new; occurrence)', 'Replaces text by matching it.'],
    ['REPLACE', 'Text', 'REPLACE(text; position; length; new)', 'Replaces characters by position.'],
    ['FIND', 'Text', 'FIND(find; within; start)', 'Where a text starts (case-sensitive).'],
    ['SEARCH', 'Text', 'SEARCH(find; within; start)', 'Where a text starts (wildcards allowed).'],
    ['TEXT', 'Text', 'TEXT(value; format)', 'A number as text in a format.'],
    ['VALUE', 'Text', 'VALUE(text)', 'Text as a number.'],
    ['REPT', 'Text', 'REPT(text; count)', 'The text repeated.'],
    ['EXACT', 'Text', 'EXACT(text 1; text 2)', 'TRUE when two texts are identical.'],
    ['CHAR', 'Text', 'CHAR(number)', 'The character of a code.'],
    ['CODE', 'Text', 'CODE(text)', 'The code of the first character.'],
    ['UNICHAR', 'Text', 'UNICHAR(number)', 'The character of a Unicode code point.'],
    ['UNICODE', 'Text', 'UNICODE(text)', 'The Unicode code point of the first character.'],
    ['FIXED', 'Text', 'FIXED(number; decimals; no commas)', 'A number as text with fixed decimals.'],
    ['DOLLAR', 'Text', 'DOLLAR(number; decimals)', 'A number as text in the currency format.'],
    ['VLOOKUP', 'Lookup', 'VLOOKUP(value; range; column; sorted)', 'Finds a value in the first column and returns from another.'],
    ['HLOOKUP', 'Lookup', 'HLOOKUP(value; range; row; sorted)', 'Finds a value in the first row and returns from another.'],
    ['LOOKUP', 'Lookup', 'LOOKUP(value; search vector; result vector)', 'Finds a value in a sorted vector.'],
    ['XLOOKUP', 'Lookup', 'XLOOKUP(value; lookup array; return array; if not found; match mode; search mode)', 'Finds a value and returns the matching entry.'],
    ['INDEX', 'Lookup', 'INDEX(range; row; column)', 'The cell at a position in a range.'],
    ['MATCH', 'Lookup', 'MATCH(value; range; type)', 'The position of a value in a range.'],
    ['XMATCH', 'Lookup', 'XMATCH(value; lookup array; match mode; search mode)', 'The position of a value with match modes.'],
    ['OFFSET', 'Lookup', 'OFFSET(reference; rows; columns; height; width)', 'A range moved from a reference.'],
    ['INDIRECT', 'Lookup', 'INDIRECT(text; A1)', 'The reference a text names.'],
    ['ROW', 'Lookup', 'ROW(reference)', 'The row number.'],
    ['ROWS', 'Lookup', 'ROWS(range)', 'The number of rows.'],
    ['COLUMN', 'Lookup', 'COLUMN(reference)', 'The column number.'],
    ['COLUMNS', 'Lookup', 'COLUMNS(range)', 'The number of columns.'],
    ['ADDRESS', 'Lookup', 'ADDRESS(row; column; abs; A1; sheet)', 'A cell address as text.'],
    ['DATE', 'Date & Time', 'DATE(year; month; day)', 'The date as a serial number.'],
    ['DATEVALUE', 'Date & Time', 'DATEVALUE(text)', 'A date written as text, as a serial number.'],
    ['TIME', 'Date & Time', 'TIME(hour; minute; second)', 'The time as a fraction of a day.'],
    ['TIMEVALUE', 'Date & Time', 'TIMEVALUE(text)', 'A time written as text, as a fraction of a day.'],
    ['TODAY', 'Date & Time', 'TODAY()', 'Today.'],
    ['NOW', 'Date & Time', 'NOW()', 'The current date and time.'],
    ['YEAR', 'Date & Time', 'YEAR(date)', 'The year of a date.'],
    ['MONTH', 'Date & Time', 'MONTH(date)', 'The month of a date.'],
    ['DAY', 'Date & Time', 'DAY(date)', 'The day of a date.'],
    ['HOUR', 'Date & Time', 'HOUR(time)', 'The hour of a time.'],
    ['MINUTE', 'Date & Time', 'MINUTE(time)', 'The minute of a time.'],
    ['SECOND', 'Date & Time', 'SECOND(time)', 'The second of a time.'],
    ['WEEKDAY', 'Date & Time', 'WEEKDAY(date; type)', 'The day of the week as a number.'],
    ['WEEKNUM', 'Date & Time', 'WEEKNUM(date; mode)', 'The week number of the year.'],
    ['DATEDIF', 'Date & Time', 'DATEDIF(start; end; unit)', 'The difference between dates in years, months or days.'],
    ['DAYS', 'Date & Time', 'DAYS(end; start)', 'The number of days between dates.'],
    ['EDATE', 'Date & Time', 'EDATE(start; months)', 'The date some months away.'],
    ['EOMONTH', 'Date & Time', 'EOMONTH(start; months)', 'The last day of a month some months away.'],
    ['NETWORKDAYS', 'Date & Time', 'NETWORKDAYS(start; end; holidays; workdays)', 'The working days between dates.'],
    ['WORKDAY', 'Date & Time', 'WORKDAY(start; days; holidays)', 'The date some working days away.'],
    ['ISBLANK', 'Information', 'ISBLANK(value)', 'TRUE for an empty cell.'],
    ['ISNUMBER', 'Information', 'ISNUMBER(value)', 'TRUE for a number.'],
    ['ISTEXT', 'Information', 'ISTEXT(value)', 'TRUE for text.'],
    ['ISLOGICAL', 'Information', 'ISLOGICAL(value)', 'TRUE for TRUE or FALSE.'],
    ['ISERROR', 'Information', 'ISERROR(value)', 'TRUE for any error.'],
    ['ISERR', 'Information', 'ISERR(value)', 'TRUE for any error but #N/A.'],
    ['ISNA', 'Information', 'ISNA(value)', 'TRUE for #N/A.'],
    ['ISFORMULA', 'Information', 'ISFORMULA(reference)', 'TRUE when the cell holds a formula.'],
    ['NA', 'Information', 'NA()', 'The error #N/A.'],
    ['N', 'Information', 'N(value)', 'The value as a number, text as 0.'],
    ['T', 'Information', 'T(value)', 'The value when it is text, otherwise empty.'],
    ['TYPE', 'Information', 'TYPE(value)', 'The type of a value as a number.'],
    ['PMT', 'Financial', 'PMT(rate; periods; present value; future value; type)', 'The payment of an annuity.'],
    ['FV', 'Financial', 'FV(rate; periods; payment; present value; type)', 'The future value of an investment.'],
    ['PV', 'Financial', 'PV(rate; periods; payment; future value; type)', 'The present value of an investment.'],
    ['NPV', 'Financial', 'NPV(rate; value 1; value 2; …)', 'The net present value of cash flows.'],
    ['IRR', 'Financial', 'IRR(values; guess)', 'The internal rate of return.'],
    ['RATE', 'Financial', 'RATE(periods; payment; present value; future value; type; guess)', 'The interest rate per period.'],
    ['NPER', 'Financial', 'NPER(rate; payment; present value; future value; type)', 'The number of periods.'],
    ['IPMT', 'Financial', 'IPMT(rate; period; periods; present value; future value; type)', 'The interest part of a payment.'],
    ['PPMT', 'Financial', 'PPMT(rate; period; periods; present value; future value; type)', 'The principal part of a payment.'],
  ].map(([name, group, syntax, about]) => ({ name, group, syntax, about }));
  /** For the formula bar's hints: name, the arguments, a short English description. */
  const functions = () => FUNCS.map((f) => ({ name: f.name, args: f.syntax.replace(/^[A-Z0-9.]+\((.*)\)$/, '$1'), description: f.about, group: f.group }));

  const api = {
    workbook, shiftFormula, parseInput, format, formatInfo, colName, parseRef, refName, functions, fillSeries,
    compute, formatAs, literal, ERR, FUNCS, general,
    MAXR, MAXC,
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (root) { root.CalcBaseCalc = api; }
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null)));

/* CalcBase — Nextcloud native SPA (buildless Vue 3, precompiled render function).
 *
 * The spreadsheet of the "Base" series by KTEC, derived from EditBase: a workbook
 * is a plain .html file in the person's Files that any browser opens. Vue owns the
 * chrome (sidebar, toolbar, dialogs, the AI assistant); the grid itself is plain
 * DOM drawn by hand below, because only the rows and columns in sight are ever in
 * the document -- a sheet may be 1,048,576 rows -- and a virtual DOM over a
 * million cells is neither fast nor useful. The arithmetic lives in cbcalc.js
 * (CalcBaseCalc), which knows nothing of the page.
 */
(function () {
  'use strict';
  // vue-private.js moved the runtime off window.Vue (see the note there).
  const Vue = window.__EditBaseVue || window.Vue;
  const { createApp } = Vue;
  const Calc = window.CalcBaseCalc;

  const BASE = ((window.OC && OC.generateUrl) ? OC.generateUrl('/apps/calcbase') : '/apps/calcbase') + '/';
  // The request token is read each time it is sent, not once at load: Nextcloud
  // hands out a new one when the session is renewed (as EditBase, review D13).
  function requestToken() {
    if (window.OC && OC.requestToken) { return OC.requestToken; }
    const head = document.head && document.head.dataset ? document.head.dataset.requesttoken : '';
    return head || '';
  }
  async function renewToken() {
    const url = (window.OC && OC.generateUrl) ? OC.generateUrl('/csrftoken') : '/csrftoken';
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) { throw new Error('HTTP ' + res.status); }
    const got = await res.json();
    const token = got && typeof got.token === 'string' ? got.token : '';
    if (!token) { throw new Error('no token'); }
    if (window.OC) { OC.requestToken = token; }
    if (document.head && document.head.dataset) { document.head.dataset.requesttoken = token; }
    return token;
  }

  // ---- i18n -----------------------------------------------------------------
  // English strings are the source/keys; Nextcloud loads l10n/<ncLang>.js server-side.
  // A non-'auto' language setting installs a client-side override map instead.
  let i18nOverride = null;
  function subst(s, vars) {
    return vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)) : s;
  }
  function T(text, vars) {
    if (i18nOverride) {
      return subst(i18nOverride[text] != null ? i18nOverride[text] : text, vars);
    }
    try {
      if (typeof window.t === 'function') { return window.t('calcbase', text, vars, undefined, { escape: false }); }
    } catch (e) { /* fall through to the raw key */ }
    return subst(text, vars);
  }
  function uiLang() {
    if (i18nOverride && i18nOverride.__lang) { return i18nOverride.__lang; }
    try { if (window.OC && OC.getLanguage) { return String(OC.getLanguage() || 'en').slice(0, 2); } } catch (e) { /* no OC */ }
    return String(document.documentElement.lang || navigator.language || 'en').slice(0, 2);
  }

  // ---- server ---------------------------------------------------------------
  async function api(path, opts, retried) {
    const res = await fetch(BASE + 'api/' + path, {
      credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json', requesttoken: requestToken() }, (opts || {}).headers || {}),
      method: (opts || {}).method || 'GET',
      body: (opts || {}).body != null ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 412 && !retried) {
      let renewed = false;
      try { await renewToken(); renewed = true; } catch (e) { /* answered below as it was */ }
      if (renewed) { return api(path, opts, true); }
    }
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    if (res.status === 409) {
      // The file moved on under this copy: the caller takes theirs in (see save()).
      const err = new Error('conflict'); err.conflict = body || {}; throw err;
    }
    if (!res.ok) { throw new Error(serverSays((body && body.error) || ('HTTP ' + res.status))); }
    return body;
  }
  // What the server said went wrong, in the person's language (as EditBase).
  const SERVER_SHAPES = [
    [/^book \d+ not found$/, 'The book was not found. It may have been moved or deleted.'],
    [/^file \d+ not found$/, 'The file was not found. It may have been moved or deleted.'],
    [/^file is larger than (\d+) MB$/, 'The file is larger than {n} MB.'],
    [/^there is a file called (.+) there already$/, 'There is already a file called {n} there.'],
    [/^there is no version (\d+)$/, 'There is no version {n}.'],
  ];
  function serverSays(msg) {
    const text = String(msg == null ? '' : msg);
    for (let i = 0; i < SERVER_SHAPES.length; i += 1) {
      const m = SERVER_SHAPES[i][0].exec(text);
      if (m) { return T(SERVER_SHAPES[i][1], { n: m[1] != null ? m[1] : '' }); }
    }
    return T(text);
  }

  // ---- the sheet: sizes and addresses ------------------------------------------
  const MAX_ROWS = 1048576;
  const MAX_COLS = 16384;
  const DEF_ROW_H = 24;
  const DEF_COL_W = 80;
  const HEAD_H = 22;      // the column letters
  const HEAD_W_MIN = 40;  // the row numbers (grows with the digits)
  const colName = (c) => Calc.colName(c);
  const refName = (r, c) => colName(c) + (r + 1);
  const parseRef = (s) => Calc.parseRef(s);
  const K = (r, c) => r * MAX_COLS + c;   // one number for a cell, exact in a double
  const KR = (k) => Math.floor(k / MAX_COLS);
  const KC = (k) => k % MAX_COLS;
  /** "A1:B3" or "A1" -> {r0,c0,r1,c1} (normalised), or null. Whole columns "A:A" and rows "1:1" too. */
  function parseRange(text) {
    const s = String(text || '').trim().toUpperCase();
    let m = /^([A-Z]{1,3}):([A-Z]{1,3})$/.exec(s);
    if (m) { const a = parseRef(m[1] + '1'); const b = parseRef(m[2] + '1'); if (!a || !b) { return null; } return { r0: 0, c0: Math.min(a.c, b.c), r1: MAX_ROWS - 1, c1: Math.max(a.c, b.c) }; }
    m = /^(\d+):(\d+)$/.exec(s);
    if (m) { return { r0: Math.min(m[1], m[2]) - 1, c0: 0, r1: Math.max(m[1], m[2]) - 1, c1: MAX_COLS - 1 }; }
    const parts = s.split(':');
    const a = parseRef(parts[0]); const b = parts[1] ? parseRef(parts[1]) : a;
    if (!a || !b) { return null; }
    return { r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) };
  }
  function rangeName(g) {
    if (!g) { return ''; }
    if (g.r0 === 0 && g.r1 >= MAX_ROWS - 1) { return colName(g.c0) + ':' + colName(g.c1); }
    if (g.c0 === 0 && g.c1 >= MAX_COLS - 1) { return (g.r0 + 1) + ':' + (g.r1 + 1); }
    const a = refName(g.r0, g.c0);
    return g.r0 === g.r1 && g.c0 === g.c1 ? a : a + ':' + refName(g.r1, g.c1);
  }
  const norm = (a, b) => ({ r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) });
  const inRange = (g, r, c) => r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /**
   * A sheet as the page keeps it: what the engine does not hold -- the look of the
   * cells, the sizes of rows and columns, merges, frozen panes -- and a note of how
   * far the sheet is used. The values and formulas live in the engine (wb).
   */
  function newSheetUI(name) {
    return { name, cols: new Map(), rows: new Map(), meta: new Map(), merges: [], freeze: null, grid: true, maxR: 0, maxC: 0, filter: null };
  }
  /** Positions. Rows have default heights except for the few in `rows`, so a
   *  row's top is its index times the default plus the extra of the odd ones
   *  above it; the odd ones are walked, which is cheap while they are few. */
  function rowTop(sh, r) {
    let y = r * DEF_ROW_H;
    sh.rows.forEach((h, i) => { if (i < r) { y += h - DEF_ROW_H; } });
    return y;
  }
  function colLeft(sh, c) {
    let x = c * DEF_COL_W;
    sh.cols.forEach((w, i) => { if (i < c) { x += w - DEF_COL_W; } });
    return x;
  }
  const rowH = (sh, r) => (sh.rows.has(r) ? sh.rows.get(r) : DEF_ROW_H);
  const colW = (sh, c) => (sh.cols.has(c) ? sh.cols.get(c) : DEF_COL_W);
  /** The row at a y (monotonic, so a binary search over the index). */
  function rowAtY(sh, y, maxRow) {
    if (y <= 0) { return 0; }
    let lo = 0; let hi = Math.min(MAX_ROWS - 1, maxRow == null ? MAX_ROWS - 1 : maxRow);
    if (!sh.rows.size) { return clamp(Math.floor(y / DEF_ROW_H), 0, hi); }
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rowTop(sh, mid) <= y) { lo = mid; } else { hi = mid - 1; } }
    return lo;
  }
  function colAtX(sh, x, maxCol) {
    if (x <= 0) { return 0; }
    let lo = 0; let hi = Math.min(MAX_COLS - 1, maxCol == null ? MAX_COLS - 1 : maxCol);
    if (!sh.cols.size) { return clamp(Math.floor(x / DEF_COL_W), 0, hi); }
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (colLeft(sh, mid) <= x) { lo = mid; } else { hi = mid - 1; } }
    return lo;
  }
  /** The merge a cell belongs to, if any. */
  function mergeAt(sh, r, c) {
    for (let i = 0; i < sh.merges.length; i += 1) { const m = sh.merges[i]; if (inRange(m, r, c)) { return m; } }
    return null;
  }

  // ---- cell styles ------------------------------------------------------------
  // The model's `s` (§3) and the file's inline style (§2) are the same facts in two
  // spellings; only the properties listed in §2 are read, anything else is ignored.
  function styleToCss(s) {
    if (!s) { return ''; }
    const out = [];
    if (s.b) { out.push('font-weight:700'); }
    if (s.i) { out.push('font-style:italic'); }
    if (s.u && s.strike) { out.push('text-decoration:underline line-through'); } else if (s.u) { out.push('text-decoration:underline'); } else if (s.strike) { out.push('text-decoration:line-through'); }
    if (s.color) { out.push('color:' + s.color); }
    if (s.bg) { out.push('background-color:' + s.bg); }
    if (s.ha) { out.push('text-align:' + s.ha); }
    if (s.va) { out.push('vertical-align:' + s.va); }
    if (s.wrap) { out.push('white-space:normal'); }
    if (s.font) { out.push('font-family:' + s.font); }
    if (s.size) { out.push('font-size:' + s.size + 'pt'); }
    if (s.bt) { out.push('border-top:' + s.bt); }
    if (s.br) { out.push('border-right:' + s.br); }
    if (s.bb) { out.push('border-bottom:' + s.bb); }
    if (s.bl) { out.push('border-left:' + s.bl); }
    return out.join(';');
  }
  function cssToStyle(css) {
    const s = {};
    String(css || '').split(';').forEach((decl) => {
      const i = decl.indexOf(':');
      if (i < 0) { return; }
      const k = decl.slice(0, i).trim().toLowerCase();
      const v = decl.slice(i + 1).trim();
      if (!v) { return; }
      if (k === 'font-weight' && (v === '700' || v === 'bold' || Number(v) >= 600)) { s.b = 1; }
      else if (k === 'font-style' && v === 'italic') { s.i = 1; }
      else if (k === 'text-decoration' || k === 'text-decoration-line') { if (/underline/.test(v)) { s.u = 1; } if (/line-through/.test(v)) { s.strike = 1; } }
      else if (k === 'color') { s.color = v; }
      else if (k === 'background-color' || k === 'background') { s.bg = v; }
      else if (k === 'text-align' && /^(left|center|right)$/.test(v)) { s.ha = v; }
      else if (k === 'vertical-align' && /^(top|middle|bottom)$/.test(v)) { s.va = v; }
      else if (k === 'white-space' && v === 'normal') { s.wrap = 1; }
      else if (k === 'font-family') { s.font = v.replace(/^["']|["']$/g, ''); }
      else if (k === 'font-size') { const m = /^([\d.]+)pt$/.exec(v); if (m) { s.size = Number(m[1]); } else { const px = /^([\d.]+)px$/.exec(v); if (px) { s.size = Math.round(Number(px[1]) * 0.75 * 2) / 2; } } }
      else if (k === 'border-top') { s.bt = v; } else if (k === 'border-right') { s.br = v; } else if (k === 'border-bottom') { s.bb = v; } else if (k === 'border-left') { s.bl = v; }
      else if (k === 'border') { s.bt = s.br = s.bb = s.bl = v; }
    });
    return Object.keys(s).length ? s : null;
  }
  const isEmptyObj = (o) => !o || !Object.keys(o).length;
  // What a formula's result wants to look like, when the cell has no format of
  // its own (the engine's fmtHint): a date for DATE(), a time, a percentage.
  const HINT_FMT = { date: 'yyyy/mm/dd', time: 'hh:mm:ss', datetime: 'yyyy/mm/dd hh:mm', percent: '0%', currency: '¥#,##0' };
  /** The format a cell is shown in: set by the person ('General' means none, on purpose), kept by the engine from the typed text, or hinted by the formula. */
  function fmtOf(meta, g) {
    const own = meta && meta.fmt;
    if (own === 'General') { return ''; }
    if (own) { return own; }
    if (g && g.fmt) { return g.fmt; }
    return (g && g.fmtHint && HINT_FMT[g.fmtHint]) || '';
  }
  const fmtForFile = (fmt) => (fmt && fmt !== 'General' ? fmt : '');

  // ---- the file (§2) -------------------------------------------------------------
  // Fixed CSS written into every book, so a browser shows the sheets as tables and
  // prints one sheet per page group. The app never reads this back.
  const BOOK_CSS = [
    'body.cb-book{margin:16px;font-family:"Noto Sans JP","Hiragino Sans","Segoe UI",Roboto,sans-serif;color:#111;background:#fff}',
    '.cb-sheet{margin:0 0 28px;page-break-after:always;break-after:page}',
    '.cb-sheet:last-child{page-break-after:auto;break-after:auto}',
    'h2.cb-sheet-name{margin:0 0 8px;font-size:14px;font-weight:600;color:#555}',
    '.cb-sheet table{border-collapse:collapse;table-layout:fixed;font-size:11pt}',
    '.cb-sheet td{border:1px solid #d4dae3;padding:0 4px;height:24px;overflow:hidden;white-space:nowrap;text-overflow:clip;vertical-align:bottom;line-height:1.25}',
    '.cb-sheet[data-grid="0"] td{border-color:transparent}',
    '.cb-sheet td[data-t="n"]{text-align:right}',
    '.cb-sheet td[data-t="e"]{color:#c62828;font-weight:600}',
    '.cb-sheet tr[style*="height:0px"]{display:none}',
    '@media print{body.cb-book{margin:0}.cb-sheet{margin:0}}',
  ].join('\n');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const VERSION_FOR_FILE = () => (document.getElementById('calcbase-root') || { dataset: {} }).dataset.version || '0.0.1';

  /**
   * The whole book as the file: one <section> per sheet, a dense table over the
   * used range, each cell saying what it shows and (in attributes) what it is.
   * `read(sheetName, r, c)` is the engine's cell; `uis` the sheets as the page keeps them.
   */
  function buildHtml(title, uis, read, active, lang) {
    const out = [];
    out.push('<!DOCTYPE html>', '<html lang="' + esc(lang || 'ja') + '">', '<head>', '<meta charset="utf-8">',
      '<meta name="generator" content="CalcBase ' + esc(VERSION_FOR_FILE()) + '">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>' + esc(title) + '</title>', '<style id="cb-style">' + BOOK_CSS + '</style>', '</head>',
      '<body class="cb-book" data-active="' + (active | 0) + '">');
    uis.forEach((sh) => {
      const used = usedRange(sh, read);
      const attrs = [' data-name="' + esc(sh.name) + '"'];
      if (sh.freeze && (sh.freeze.r || sh.freeze.c)) { attrs.push(' data-freeze="' + refName(sh.freeze.r, sh.freeze.c) + '"'); }
      attrs.push(' data-grid="' + (sh.grid === false ? 0 : 1) + '"');
      out.push('<section class="cb-sheet"' + attrs.join('') + '>', '<h2 class="cb-sheet-name">' + esc(sh.name) + '</h2>', '<table>', '<colgroup>');
      for (let c = 0; c <= used.c1; c += 1) { out.push('<col style="width:' + colW(sh, c) + 'px">'); }
      out.push('</colgroup>', '<tbody>');
      // Cells hidden under a merge are left out, as HTML requires.
      const covered = new Set();
      sh.merges.forEach((m) => { for (let r = m.r0; r <= m.r1; r += 1) { for (let c = m.c0; c <= m.c1; c += 1) { if (r !== m.r0 || c !== m.c0) { covered.add(K(r, c)); } } } });
      for (let r = 0; r <= used.r1; r += 1) {
        const h = rowH(sh, r);
        const row = ['<tr' + (h !== DEF_ROW_H ? ' style="height:' + h + 'px"' : '') + '>'];
        for (let c = 0; c <= used.c1; c += 1) {
          if (covered.has(K(r, c))) { continue; }
          const g = read(sh.name, r, c);
          const meta = sh.meta.get(K(r, c));
          const m = mergeAt(sh, r, c);
          const a = [];
          if (m && m.r0 === r && m.c0 === c) {
            if (m.c1 > m.c0) { a.push(' colspan="' + (m.c1 - m.c0 + 1) + '"'); }
            if (m.r1 > m.r0) { a.push(' rowspan="' + (m.r1 - m.r0 + 1) + '"'); }
          }
          let text = '';
          if (g && g.t) {
            if (g.f) { a.push(' data-f="' + esc(g.f) + '"'); }
            a.push(' data-t="' + g.t + '"');
            text = Calc.format(g.v, g.t, fmtOf(meta, g), 'ja');
            if (g.t === 'n' && !fmtOf(meta, g) && read.font) {
              const cw = m && m.r0 === r && m.c0 === c ? colLeft(sh, m.c1 + 1) - colLeft(sh, m.c0) : colW(sh, c);
              text = fitNumber(text, g.v, cw - 2 * (CELL_MARGIN + NUM_GAP), read.font(meta));
            }
            if (g.t === 'n') { a.push(' data-v="' + esc(String(g.v)) + '"'); }
            else if (g.t === 'b') { a.push(' data-v="' + (g.v ? 'TRUE' : 'FALSE') + '"'); }
            else if (g.t === 's' && String(g.v) !== text) { a.push(' data-v="' + esc(g.v) + '"'); }
          }
          const fmtOut = fmtForFile(fmtOf(meta, g));
          if (fmtOut) { a.push(' data-fmt="' + esc(fmtOut) + '"'); }
          const css = meta ? styleToCss(meta.s) : '';
          if (css) { a.push(' style="' + esc(css) + '"'); }
          row.push('<td' + a.join('') + '>' + esc(text) + '</td>');
        }
        row.push('</tr>');
        out.push(row.join(''));
      }
      out.push('</tbody>', '</table>', '</section>');
    });
    out.push('</body>', '</html>', '');
    return out.join('\n');
  }
  /** A1 to the last used row/column: the cells the engine holds, the styled cells, the merges. */
  function usedRange(sh, read) {
    let r1 = -1; let c1 = -1;
    const grow = (r, c) => { if (r > r1) { r1 = r; } if (c > c1) { c1 = c; } };
    if (read.used) { const u = read.used(sh.name); if (u) { grow(u.r1, u.c1); } }
    sh.meta.forEach((m, k) => { if (!isEmptyObj(m) && (m.fmt || !isEmptyObj(m.s))) { grow(KR(k), KC(k)); } });
    sh.merges.forEach((m) => grow(m.r1, m.c1));
    if (r1 < 0) { r1 = 0; } if (c1 < 0) { c1 = 0; }
    return { r0: 0, c0: 0, r1, c1 };
  }
  /**
   * A file read back: attributes and text only, never inserted as HTML. Answers the
   * §3 model (for wb.load) and the sheets as the page keeps them.
   */
  function parseBook(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const uis = []; const model = { sheets: [], active: 0 };
    const body = doc.body;
    model.active = Number((body && body.getAttribute('data-active')) || 0) || 0;
    const title = doc.title || '';
    const sections = Array.from(doc.querySelectorAll('section.cb-sheet'));
    sections.forEach((sec, idx) => {
      const name = sec.getAttribute('data-name') || (sec.querySelector('.cb-sheet-name') || {}).textContent || ('Sheet' + (idx + 1));
      const ui = newSheetUI(String(name).trim() || ('Sheet' + (idx + 1)));
      const fz = parseRef(sec.getAttribute('data-freeze') || '');
      if (fz && (fz.r || fz.c)) { ui.freeze = { r: fz.r, c: fz.c }; }
      ui.grid = sec.getAttribute('data-grid') !== '0';
      const cells = {};
      Array.from(sec.querySelectorAll('colgroup col')).forEach((col, c) => {
        const m = /width:\s*([\d.]+)px/.exec(col.getAttribute('style') || '');
        if (m && Math.round(Number(m[1])) !== DEF_COL_W) { ui.cols.set(c, Math.max(0, Math.round(Number(m[1])))); }
      });
      const trs = Array.from(sec.querySelectorAll('tbody > tr, table > tr'));
      const taken = new Set();
      trs.forEach((tr, r) => {
        const hm = /height:\s*([\d.]+)px/.exec(tr.getAttribute('style') || '');
        if (hm && Math.round(Number(hm[1])) !== DEF_ROW_H) { ui.rows.set(r, Math.max(0, Math.round(Number(hm[1])))); }
        let c = 0;
        Array.from(tr.children).forEach((td) => {
          if (td.tagName !== 'TD' && td.tagName !== 'TH') { return; }
          while (taken.has(K(r, c))) { c += 1; }
          const cs = Math.max(1, Number(td.getAttribute('colspan') || 1)); const rs = Math.max(1, Number(td.getAttribute('rowspan') || 1));
          if (cs > 1 || rs > 1) {
            ui.merges.push({ r0: r, c0: c, r1: r + rs - 1, c1: c + cs - 1 });
            for (let rr = r; rr < r + rs; rr += 1) { for (let cc = c; cc < c + cs; cc += 1) { if (rr !== r || cc !== c) { taken.add(K(rr, cc)); } } }
          }
          const t = td.getAttribute('data-t') || '';
          const f = td.getAttribute('data-f') || '';
          const text = td.textContent || '';
          const dv = td.getAttribute('data-v');
          const fmt = td.getAttribute('data-fmt') || '';
          const s = cssToStyle(td.getAttribute('style'));
          if (t || f) {
            const cell = {};
            if (f && f[0] === '=') { cell.f = f; }
            if (t === 'n') { cell.v = Number(dv != null ? dv : text.replace(/[,¥$€£%\s]/g, '')); cell.t = 'n'; if (isNaN(cell.v)) { cell.v = 0; } }
            else if (t === 'b') { cell.v = String(dv != null ? dv : text).toUpperCase() === 'TRUE'; cell.t = 'b'; }
            else if (t === 'e') { cell.v = text; cell.t = 'e'; }
            else { cell.v = dv != null ? dv : text; cell.t = 's'; }
            if (fmt) { cell.fmt = fmt; }
            if (s) { cell.s = s; }
            cells[refName(r, c)] = cell;
            if (r > ui.maxR) { ui.maxR = r; } if (c > ui.maxC) { ui.maxC = c; }
          } else if (text && td.children.length === 0) {
            // A table not made by CalcBase: the words as text, numbers as numbers.
            const p = Calc.parseInput(text, 'ja');
            if (p.t) { const cell = { v: p.v, t: p.t }; if (p.fmt) { cell.fmt = p.fmt; } if (s) { cell.s = s; } cells[refName(r, c)] = cell; if (r > ui.maxR) { ui.maxR = r; } if (c > ui.maxC) { ui.maxC = c; } }
          }
          if (fmt || s) { ui.meta.set(K(r, c), { fmt: fmt || '', s: s || null }); }
          c += cs;
        });
      });
      // A sheet of the book, even when it is empty.
      model.sheets.push({ name: ui.name, cells });
      uis.push(ui);
    });
    if (!uis.length) {
      // Not a CalcBase file: the first table of the page, if there is one, becomes Sheet1.
      const ui = newSheetUI('Sheet1'); const cells = {};
      const table = doc.querySelector('table');
      if (table) {
        Array.from(table.querySelectorAll('tr')).forEach((tr, r) => {
          Array.from(tr.children).forEach((td, c) => {
            const p = Calc.parseInput(td.textContent || '', 'ja');
            if (p.t) { const cell = { v: p.v, t: p.t }; if (p.fmt) { cell.fmt = p.fmt; ui.meta.set(K(r, c), { fmt: p.fmt, s: null }); } cells[refName(r, c)] = cell; if (r > ui.maxR) { ui.maxR = r; } if (c > ui.maxC) { ui.maxC = c; } }
          });
        });
      }
      model.sheets.push({ name: 'Sheet1', cells }); uis.push(ui);
    }
    if (model.active < 0 || model.active >= uis.length) { model.active = 0; }
    return { title, model, uis };
  }
  /** §3 model from the engine plus what the page keeps (for import/export and the AI). */
  function toFullModel(wb, uis, active, withShown) {
    const m = wb.toModel();
    m.active = active | 0;
    m.sheets.forEach((s) => {
      s.cells = s.cells || {};
      const ui = uis.find((u) => u.name === s.name);
      if (!ui) { s.cols = {}; s.rows = {}; s.merges = []; return; }
      ui.meta.forEach((meta, k) => {
        if (isEmptyObj(meta) || (!meta.fmt && isEmptyObj(meta.s))) { return; }
        const key = refName(KR(k), KC(k));
        const cell = s.cells[key] || (s.cells[key] = { v: '', t: '' });
        if (meta.fmt === 'General') { delete cell.fmt; } else if (meta.fmt) { cell.fmt = meta.fmt; }
        if (!isEmptyObj(meta.s)) { cell.s = Object.assign({}, meta.s); }
      });
      if (withShown) { Object.keys(s.cells).forEach((key) => { const cell = s.cells[key]; if (cell.t) { cell.d = Calc.format(cell.v, cell.t, cell.fmt || '', 'ja'); } }); }
      s.cols = {}; ui.cols.forEach((w, c) => { s.cols[colName(c)] = w; });
      s.rows = {}; ui.rows.forEach((h, r) => { s.rows[String(r + 1)] = h; });
      s.merges = ui.merges.map(rangeName);
      if (ui.freeze) { s.freeze = refName(ui.freeze.r, ui.freeze.c); }
      s.grid = ui.grid !== false;
    });
    return m;
  }
  /** The page's sheets from a §3 model (import). The engine is loaded separately with wb.load(model). */
  function uisFromModel(model) {
    return (model.sheets || []).map((s, i) => {
      const ui = newSheetUI(s.name || ('Sheet' + (i + 1)));
      Object.keys(s.cells || {}).forEach((key) => {
        const p = parseRef(key); if (!p) { return; }
        const cell = s.cells[key];
        if (cell.fmt || !isEmptyObj(cell.s)) { ui.meta.set(K(p.r, p.c), { fmt: cell.fmt || '', s: isEmptyObj(cell.s) ? null : Object.assign({}, cell.s) }); }
        if (p.r > ui.maxR) { ui.maxR = p.r; } if (p.c > ui.maxC) { ui.maxC = p.c; }
      });
      Object.keys(s.cols || {}).forEach((cn) => { const p = parseRef(cn + '1'); if (p && Number(s.cols[cn]) > 0) { ui.cols.set(p.c, Math.round(Number(s.cols[cn]))); } });
      Object.keys(s.rows || {}).forEach((rn) => { const r = Number(rn) - 1; if (r >= 0 && Number(s.rows[rn]) >= 0) { ui.rows.set(r, Math.round(Number(s.rows[rn]))); } });
      (s.merges || []).forEach((mr) => { const g = parseRange(mr); if (g && (g.r1 > g.r0 || g.c1 > g.c0)) { ui.merges.push(g); } });
      const fz = s.freeze ? parseRef(s.freeze) : null;
      if (fz && (fz.r || fz.c)) { ui.freeze = { r: fz.r, c: fz.c }; }
      ui.grid = s.grid !== false;
      return ui;
    });
  }

  // ---- formulas on the page ---------------------------------------------------------
  // The references written in a formula, with where they stand in the text, so
  // that they can be coloured, replaced while pointing, and cycled with F4.
  const REF_IN_TEXT = /(?:(?:'(?:[^']|'')+'|\$?[A-Za-z_][\w]*)[.!])?\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?|(?:(?:'(?:[^']|'')+'|\$?[A-Za-z_][\w]*)[.!])?\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}(?![\w(])|\$?\d{1,7}:\$?\d{1,7}/g;
  function refsInFormula(text) {
    const out = [];
    const s = String(text || '');
    if (s[0] !== '=') { return out; }
    // strings are skipped
    let i = 1;
    let plain = '';
    const map = [];
    while (i < s.length) {
      if (s[i] === '"') { let j = i + 1; while (j < s.length) { if (s[j] === '"') { if (s[j + 1] === '"') { j += 2; continue; } break; } j += 1; } plain += ' '.repeat(j + 1 - i); i = j + 1; continue; }
      plain += s[i]; i += 1;
    }
    REF_IN_TEXT.lastIndex = 0;
    let m;
    while ((m = REF_IN_TEXT.exec(plain))) {
      const start = m.index + 1; const end = start + m[0].length;
      // not the tail of a word, not a function name
      if (start > 1 && /[\w.]/.test(s[start - 1]) && !/[.!]/.test(s[start - 1])) { continue; }
      if (s[end] === '(') { continue; }
      const txt = m[0];
      const sm = /^(?:'((?:[^']|'')+)'|\$?([A-Za-z_]\w*))[.!](.*)$/.exec(txt);
      const sheet = sm ? (sm[1] != null ? sm[1].replace(/''/g, "'") : sm[2]) : null;
      const addr = sm ? sm[3] : txt;
      const g = parseRange(addr.replace(/\$/g, ''));
      if (!g) { continue; }
      out.push({ start, end, text: txt, sheet, range: g });
      map.push(txt);
    }
    return out;
  }
  /** The next spelling of a reference under F4: A1 -> $A$1 -> A$1 -> $A1 -> A1. */
  function cycleAbs(text) {
    const one = (a) => {
      const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(a);
      if (!m) { return a; }
      const st = (m[1] ? 2 : 0) + (m[3] ? 1 : 0);  // 0: A1, 1: A$1, 2: $A1, 3: $A$1
      const next = { 0: 3, 3: 1, 1: 2, 2: 0 }[st];
      return (next & 2 ? '$' : '') + m[2] + (next & 1 ? '$' : '') + m[4];
    };
    const sm = /^((?:'(?:[^']|'')+'|\$?[A-Za-z_]\w*)[.!])?(.*)$/.exec(text);
    const prefix = sm[1] || ''; const addr = sm[2];
    return prefix + addr.split(':').map(one).join(':');
  }
  /** Where the caret is in a formula: after an operator or an opening bracket a
   *  reference may be pointed at; on a reference it may be replaced. */
  function refSlot(text, caret) {
    const s = String(text || '');
    if (s[0] !== '=') { return null; }
    const refs = refsInFormula(s);
    for (let i = 0; i < refs.length; i += 1) { const r = refs[i]; if (caret >= r.start && caret <= r.end) { return { start: r.start, end: r.end, replace: true }; } }
    const before = s.slice(0, caret).replace(/\s+$/, '');
    if (before === '=' || /[-+*/^&=<>(,;:%]$/.test(before)) { return { start: caret, end: caret, replace: false }; }
    return null;
  }
  /** The function call the caret is inside, and which argument: for the signature hint. */
  function callAtCaret(text, caret) {
    const s = String(text || '').slice(0, caret);
    let depth = 0; let arg = 0;
    const args = [];
    for (let i = s.length - 1; i > 0; i -= 1) {
      const ch = s[i];
      if (ch === '"') { let j = i - 1; while (j > 0 && !(s[j] === '"' && s[j - 1] !== '"')) { j -= 1; } i = j; continue; }
      if (ch === ')') { depth += 1; continue; }
      if (ch === '(') {
        if (depth === 0) {
          const m = /([A-Za-z_][\w.]*)\s*$/.exec(s.slice(0, i));
          if (m) { return { name: m[1].toUpperCase(), arg }; }
          return null;
        }
        depth -= 1; continue;
      }
      if ((ch === ',' || ch === ';') && depth === 0) { arg += 1; }
    }
    return args.length ? null : null;
  }
  /** The word being typed at the caret of a formula (a function name beginning). */
  function wordAtCaret(text, caret) {
    const s = String(text || '').slice(0, caret);
    if (s[0] !== '=') { return ''; }
    const m = /(?:^=|[-+*/^&=<>(,;:])\s*([A-Za-z_][\w.]*)$/.exec(s);
    return m ? m[1] : '';
  }
  /** A number format with one more or one fewer decimal place; General counts the value's own. */
  function stepDecimals(fmt, dir, v) {
    let code = fmt || 'General';
    if (code === 'General' || code === '@') {
      let d = 0;
      if (typeof v === 'number' && !Number.isInteger(v)) { const s = String(v); const i = s.indexOf('.'); d = i >= 0 ? s.length - i - 1 : 0; }
      d = clamp(d + dir, 0, 10);
      return d ? '0.' + '0'.repeat(d) : '0';
    }
    const m = /^([^0#]*[#,0]*)(?:\.(0+))?(.*)$/.exec(code.split(';')[0]);
    if (!m) { return code; }
    const d = clamp((m[2] ? m[2].length : 0) + dir, 0, 10);
    const head = m[1] || '0';
    return head + (d ? '.' + '0'.repeat(d) : '') + m[3];
  }
  const isDateFmt = (fmt) => /[ymd]|ggg/i.test(String(fmt || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, ''));
  const isTimeFmt = (fmt) => /h/i.test(String(fmt || '').replace(/"[^"]*"/g, ''));

  // ---- TSV and HTML for the clipboard ------------------------------------------
  function parseTsv(text) {
    const rows = [];
    const s = String(text || '').replace(/\r\n?/g, '\n');
    let row = []; let cell = ''; let q = false;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i += 1; } else { q = false; } } else { cell += ch; } continue; }
      if (ch === '"' && cell === '') { q = true; continue; }
      if (ch === '\t') { row.push(cell); cell = ''; continue; }
      if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
      cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') { rows.pop(); }
    return rows;
  }
  const tsvCell = (s) => (/[\t\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  /** The table in pasted HTML, as the text of each cell (and what LibreOffice/Excel say about it). */
  function tableFromHtml(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const table = doc.querySelector('table');
    if (!table) { return null; }
    const rows = [];
    Array.from(table.querySelectorAll('tr')).forEach((tr) => {
      const row = [];
      Array.from(tr.children).forEach((td) => {
        if (td.tagName !== 'TD' && td.tagName !== 'TH') { return; }
        const o = { text: (td.textContent || '').replace(/ /g, ' ').replace(/\s+$/g, ''), f: td.getAttribute('data-f') || '', fmt: td.getAttribute('data-fmt') || '', t: td.getAttribute('data-t') || '', v: td.getAttribute('data-v'), s: cssToStyle(td.getAttribute('style')) };
        // LibreOffice writes sdval/sdnum, Excel x:num / x:fmla
        const sdval = td.getAttribute('sdval'); if (sdval != null && sdval !== '') { o.text = sdval; }
        const xf = td.getAttribute('x:fmla'); if (xf) { o.f = xf[0] === '=' ? xf : '=' + xf; }
        const cs = Number(td.getAttribute('colspan') || 1);
        row.push(o);
        for (let i = 1; i < cs; i += 1) { row.push({ text: '', f: '', fmt: '', t: '', v: null, s: null, covered: true }); }
      });
      rows.push(row);
    });
    return { rows, own: table.getAttribute('data-cb-clip') || '' };
  }

  // ---- icons -------------------------------------------------------------------
  // Drawn, not typed (as EditBase): emoji render differently on every platform.
  const I = (paths, opts) => '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="' + ((opts && opts.w) || 1.5) + '" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  const ICONS = {
    undo: I('<path d="M3 8h7.5a3 3 0 0 1 0 6H7"/><path d="M5.5 5.5 3 8l2.5 2.5"/>'),
    redo: I('<path d="M13 8H5.5a3 3 0 0 0 0 6H9"/><path d="M10.5 5.5 13 8l-2.5 2.5"/>'),
    save: I('<path d="M3 2.8h7.5L13.2 5.5V13a.8.8 0 0 1-.8.8H3.6a.8.8 0 0 1-.8-.8V3.6a.8.8 0 0 1 .8-.8z"/><path d="M5.5 2.8v3.4h5V2.8M5.5 13.8v-3.6h5v3.6"/>'),
    print: I('<path d="M4.5 6V2.5h7V6"/><rect x="2.2" y="6" width="11.6" height="5" rx="1"/><path d="M4.5 9.5h7v4h-7z"/>'),
    menu: I('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'),
    plus: I('<path d="M8 3.5v9M3.5 8h9"/>'),
    minus: I('<path d="M3.5 8h9"/>'),
    down: I('<path d="M4 6.5 8 10.5l4-4"/>'),
    close: I('<path d="M4 4l8 8M12 4l-8 8"/>'),
    search: I('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 14 14"/>'),
    cut: I('<circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M6 10 13 2M10 10 3 2"/>'),
    copy: I('<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3 10.5V3.5a1 1 0 0 1 1-1h7"/>'),
    paste: I('<rect x="3.5" y="3.5" width="9" height="10.5" rx="1"/><path d="M6 3.5V2.2h4v1.3M6 7.5h4M6 10.5h4"/>'),
    colour: I('<path d="M8 1.8c3.4 0 6.2 2.5 6.2 5.6 0 2-1.6 2.9-2.8 2.9h-1.2c-1 0-1.7.7-1.7 1.6 0 .4.2.8.4 1.1.2.3.3.6.3.9 0 .6-.5 1.1-1.2 1.1C4.4 15 1.8 11.9 1.8 8.2 1.8 4.7 4.6 1.8 8 1.8z"/><circle cx="5.4" cy="7" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="4.9" r=".9" fill="currentColor" stroke="none"/><circle cx="10.8" cy="6.6" r=".9" fill="currentColor" stroke="none"/>'),
    fill: I('<path d="M3 9.2 8.6 3.6l4 4L7 13.2a1.4 1.4 0 0 1-2 0L3 11.2a1.4 1.4 0 0 1 0-2z"/><path d="M13.5 10.5c.6.9.9 1.6.9 2.1a.9.9 0 0 1-1.8 0c0-.5.3-1.2.9-2.1z" fill="currentColor" stroke="none"/>'),
    borders: I('<path d="M2 2.5h12v11H2zM2 7h12M8.5 2.5v11"/>'),
    alignL: I('<path d="M2.5 4h11M2.5 7h7M2.5 10h11M2.5 13h7"/>'),
    alignC: I('<path d="M2.5 4h11M4.5 7h7M2.5 10h11M4.5 13h7"/>'),
    alignR: I('<path d="M2.5 4h11M6.5 7h7M2.5 10h11M6.5 13h7"/>'),
    vTop: I('<path d="M2.6 2.6h10.8"/><path d="M8 5v7.4M5.6 10 8 12.4 10.4 10"/>'),
    vMid: I('<path d="M2.6 8h10.8"/><path d="M8 2.4v3M8 10.6v3"/>'),
    vBot: I('<path d="M2.6 13.4h10.8"/><path d="M8 3.6V11M5.6 6 8 3.6 10.4 6"/>'),
    wrap: I('<path d="M2.5 4h11M2.5 8h8a2 2 0 0 1 0 4H8"/><path d="M9.6 10.4 8 12l1.6 1.6M2.5 12h2.5"/>'),
    merge: I('<rect x="1.8" y="3" width="12.4" height="10" rx="1"/><path d="M5.5 8h5M9 6.5 10.5 8 9 9.5M7 6.5 5.5 8 7 9.5"/>'),
    rows: I('<rect x="1.8" y="2.4" width="12.4" height="11.2" rx="1"/><path d="M1.8 6.2h12.4M1.8 9.8h12.4"/>'),
    cols: I('<rect x="1.8" y="2.4" width="12.4" height="11.2" rx="1"/><path d="M6 2.4v11.2M10 2.4v11.2"/>'),
    sortAZ: I('<path d="M3.5 2.5v11M1.5 11.5l2 2 2-2"/><path d="M8 7.5l2-5 2 5M8.7 6h2.6M8 9.5h4l-4 4h4"/>'),
    sortZA: I('<path d="M3.5 2.5v11M1.5 11.5l2 2 2-2"/><path d="M8 2.5h4l-4 4h4M8 13.5l2-5 2 5M8.7 12h2.6"/>'),
    filter: I('<path d="M2 3h12l-4.6 5.4V13l-2.8-1.4V8.4z"/>'),
    freeze: I('<rect x="1.8" y="2.4" width="12.4" height="11.2" rx="1"/><path d="M1.8 6.2h12.4M6 2.4v11.2" stroke-width="2.2"/>'),
    fx: I('<path d="M4 3h7l-4 5 4 5H4"/>'),
    settings: I('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5"/>'),
    folder: I('<path d="M1.8 4.2a1 1 0 0 1 1-1h3l1.4 1.6h6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/>'),
    doc: I('<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M8.8 1.8v3.3H12"/><path d="M6 8h4M6 10.5h4"/>'),
    up: I('<path d="M8 13V3.5M4 7.5 8 3.5l4 4"/>'),
    table: I('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1"/><path d="M1.8 6.3h12.4M1.8 9.8h12.4M6 2.8v10.4M10 2.8v10.4"/>'),
    check: I('<path d="M3 8.5 6.5 12 13 4.5"/>'),
    more: I('<circle cx="3.2" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.8" cy="8" r="1.1" fill="currentColor" stroke="none"/>'),
    percent: I('<path d="M3.5 12.5 12.5 3.5"/><circle cx="5" cy="5" r="1.8"/><circle cx="11" cy="11" r="1.8"/>'),
    dec0: I('<text x="1.5" y="11" font-size="7.5" fill="currentColor" stroke="none" font-family="sans-serif">.00</text><path d="M11 5.5v3M9.5 7h3" stroke-width="1.3"/>'),
    dec1: I('<text x="1.5" y="11" font-size="7.5" fill="currentColor" stroke="none" font-family="sans-serif">.00</text><path d="M9.5 7h3" stroke-width="1.3"/>'),
    import: I('<path d="M8 2v8M5 7l3 3 3-3"/><path d="M2.5 11v2.5h11V11"/>'),
    export: I('<path d="M8 10V2M5 5l3-3 3 3"/><path d="M2.5 11v2.5h11V11"/>'),
  };
  // The CalcBase logo (img/logo.svg) inline, for the sidebar and the empty desk.
  const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="406 386 1306 1042" aria-hidden="true"><path fill="none" stroke="#ffffff" stroke-width="100" d="M1083.52,1350.98c-3.65-4.48-4.91-9.8-3.78-15.97l115.97-542.87c1.12-6.16,4.33-11.48,9.66-15.97,5.32-4.48,11.06-6.72,17.23-6.72h262.19c37.53,0,69.33,7.14,95.38,21.43s45.51,33.06,58.4,56.3c12.88,23.25,19.33,47.77,19.33,73.53,0,12.33-1.13,22.98-3.36,31.93-5.61,28.02-15.27,50.57-28.99,67.65-13.73,17.1-27.31,30.12-40.76,39.08,25.21,20.73,37.82,47.62,37.82,80.67,0,12.89-1.68,27.46-5.04,43.7-7.85,35.29-19.05,65.42-33.61,90.34-14.57,24.93-37.12,45.1-67.65,60.5-30.54,15.42-71.01,23.11-121.43,23.11h-296.64c-6.17,0-11.07-2.23-14.71-6.72ZM1396.55,1227.45c19.04,0,35.15-6.16,48.32-18.49,13.16-12.32,19.75-27.17,19.75-44.54,0-11.76-4.2-21.28-12.61-28.57-8.4-7.27-19.62-10.92-33.61-10.92h-138.66l-21.85,102.52h138.66ZM1327.65,899.71l-20.17,95.8h130.25c16.81,0,30.53-4.2,41.18-12.61,10.64-8.4,17.36-20.17,20.17-35.29,1.12-6.72,1.68-11.2,1.68-13.45,0-11.2-3.65-19.75-10.92-25.63-7.29-5.88-17.94-8.82-31.93-8.82h-130.25Z"/><path fill="#2e3192" d="M1083.52,1350.98c-3.65-4.48-4.91-9.8-3.78-15.97l115.97-542.87c1.12-6.16,4.33-11.48,9.66-15.97,5.32-4.48,11.06-6.72,17.23-6.72h262.19c37.53,0,69.33,7.14,95.38,21.43s45.51,33.06,58.4,56.3c12.88,23.25,19.33,47.77,19.33,73.53,0,12.33-1.13,22.98-3.36,31.93-5.61,28.02-15.27,50.57-28.99,67.65-13.73,17.1-27.31,30.12-40.76,39.08,25.21,20.73,37.82,47.62,37.82,80.67,0,12.89-1.68,27.46-5.04,43.7-7.85,35.29-19.05,65.42-33.61,90.34-14.57,24.93-37.12,45.1-67.65,60.5-30.54,15.42-71.01,23.11-121.43,23.11h-296.64c-6.17,0-11.07-2.23-14.71-6.72ZM1396.55,1227.45c19.04,0,35.15-6.16,48.32-18.49,13.16-12.32,19.75-27.17,19.75-44.54,0-11.76-4.2-21.28-12.61-28.57-8.4-7.27-19.62-10.92-33.61-10.92h-138.66l-21.85,102.52h138.66ZM1327.65,899.71l-20.17,95.8h130.25c16.81,0,30.53-4.2,41.18-12.61,10.64-8.4,17.36-20.17,20.17-35.29,1.12-6.72,1.68-11.2,1.68-13.45,0-11.2-3.65-19.75-10.92-25.63-7.29-5.88-17.94-8.82-31.93-8.82h-130.25Z"/><path fill="#e56b00" d="M677.91,1046.23c0,79.48,40.03,119.22,120.12,119.22,46.66,0,82.22-9.92,106.72-29.8s44.14-44.06,58.92-72.58c7.77-14.69,14.38-24.62,19.81-29.81s14.39-7.78,26.84-7.78h152.8c7,0,12.62,2.81,16.91,8.44s5.64,12.31,4.08,20.08c-12.44,59.62-37.12,113.62-74.06,162-36.94,48.39-84.38,86.62-142.3,114.7-57.94,28.08-123.83,42.11-197.7,42.11-59.88,0-113.34-13.39-160.39-40.17s-83.78-63.06-110.22-108.86c-26.44-45.78-39.66-96.77-39.66-152.94,0-16.41,1.16-32.81,3.5-49.23,7-50.97,21.77-127.88,44.33-230.69,23.31-103.69,69.58-188.14,138.8-253.38,69.2-65.22,162.12-97.84,278.77-97.84,55.2,0,107.3,12.31,156.3,36.94,48.98,24.62,88.25,58.11,117.81,100.44,29.55,42.34,44.33,88.56,44.33,138.67,0,13.83-1.17,28.08-3.5,42.77-.78,7.78-4.48,14.47-11.09,20.09s-13.41,8.42-20.41,8.42h-152.8c-12.44,0-20.41-2.59-23.91-7.78s-6.03-15.12-7.59-29.81c-3.89-29.38-14.39-53.78-31.48-73.22-17.11-19.44-48.98-29.16-95.64-29.16-49,0-87.48,13.83-115.48,41.47-28,27.66-47.83,63.94-59.48,108.86-6.22,21.61-14,57.03-23.33,106.28-9.34,49.25-15.56,86.41-18.66,111.45-1.56,13.83-2.33,24.2-2.33,31.11Z"/><path fill="none" stroke="#ffffff" stroke-width="106.22" stroke-linecap="round" stroke-linejoin="round" d="M677.91,1046.23c0,79.48,40.03,119.22,120.12,119.22,46.66,0,82.22-9.92,106.72-29.8s44.14-44.06,58.92-72.58c7.77-14.69,14.38-24.62,19.81-29.81s14.39-7.78,26.84-7.78h152.8c7,0,12.62,2.81,16.91,8.44s5.64,12.31,4.08,20.08c-12.44,59.62-37.12,113.62-74.06,162-36.94,48.39-84.38,86.62-142.3,114.7-57.94,28.08-123.83,42.11-197.7,42.11-59.88,0-113.34-13.39-160.39-40.17s-83.78-63.06-110.22-108.86c-26.44-45.78-39.66-96.77-39.66-152.94,0-16.41,1.16-32.81,3.5-49.23,7-50.97,21.77-127.88,44.33-230.69,23.31-103.69,69.58-188.14,138.8-253.38,69.2-65.22,162.12-97.84,278.77-97.84,55.2,0,107.3,12.31,156.3,36.94,48.98,24.62,88.25,58.11,117.81,100.44,29.55,42.34,44.33,88.56,44.33,138.67,0,13.83-1.17,28.08-3.5,42.77-.78,7.78-4.48,14.47-11.09,20.09s-13.41,8.42-20.41,8.42h-152.8c-12.44,0-20.41-2.59-23.91-7.78s-6.03-15.12-7.59-29.81c-3.89-29.38-14.39-53.78-31.48-73.22-17.11-19.44-48.98-29.16-95.64-29.16-49,0-87.48,13.83-115.48,41.47-28,27.66-47.83,63.94-59.48,108.86-6.22,21.61-14,57.03-23.33,106.28-9.34,49.25-15.56,86.41-18.66,111.45-1.56,13.83-2.33,24.2-2.33,31.11Z"/><path fill="#00a99d" d="M677.91,1046.23c0,79.48,40.03,119.22,120.12,119.22,46.66,0,82.22-9.92,106.72-29.8s44.14-44.06,58.92-72.58c7.77-14.69,14.38-24.62,19.81-29.81s14.39-7.78,26.84-7.78h152.8c7,0,12.62,2.81,16.91,8.44s5.64,12.31,4.08,20.08c-12.44,59.62-37.12,113.62-74.06,162-36.94,48.39-84.38,86.62-142.3,114.7-57.94,28.08-123.83,42.11-197.7,42.11-59.88,0-113.34-13.39-160.39-40.17s-83.78-63.06-110.22-108.86c-26.44-45.78-39.66-96.77-39.66-152.94,0-16.41,1.16-32.81,3.5-49.23,7-50.97,21.77-127.88,44.33-230.69,23.31-103.69,69.58-188.14,138.8-253.38,69.2-65.22,162.12-97.84,278.77-97.84,55.2,0,107.3,12.31,156.3,36.94,48.98,24.62,88.25,58.11,117.81,100.44,29.55,42.34,44.33,88.56,44.33,138.67,0,13.83-1.17,28.08-3.5,42.77-.78,7.78-4.48,14.47-11.09,20.09s-13.41,8.42-20.41,8.42h-152.8c-12.44,0-20.41-2.59-23.91-7.78s-6.03-15.12-7.59-29.81c-3.89-29.38-14.39-53.78-31.48-73.22-17.11-19.44-48.98-29.16-95.64-29.16-49,0-87.48,13.83-115.48,41.47-28,27.66-47.83,63.94-59.48,108.86-6.22,21.61-14,57.03-23.33,106.28-9.34,49.25-15.56,86.41-18.66,111.45-1.56,13.83-2.33,24.2-2.33,31.11Z"/></svg>';

  // ---- printing --------------------------------------------------------------------
  /** Print in an isolated frame, so no application style reaches the page (as EditBase). */
  function printHtml(html) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;';
    document.body.appendChild(frame);
    const done = () => { setTimeout(() => { frame.remove(); }, 1000); };
    frame.onload = () => {
      const win = frame.contentWindow;
      const go = () => { try { win.focus(); win.print(); } catch (e) { /* the person can still print from the browser menu */ } done(); };
      const faces = win.document.fonts;
      if (faces && faces.ready) { let went = false; const fire = () => { if (!went) { went = true; go(); } }; try { faces.ready.then(fire, fire); } catch (e) { fire(); } setTimeout(fire, 1500); } else { go(); }
    };
    frame.srcdoc = html;
    return frame;
  }
  const PAPERS = { A3: { w: 297, h: 420 }, A4: { w: 210, h: 297 }, B5: { w: 182, h: 257 }, Letter: { w: 215.9, h: 279.4 } };

  /** Is Nextcloud itself dark? (as EditBase's ncIsDark) */
  function ncIsDark() {
    try {
      const body = document.body;
      if (body && (body.hasAttribute('data-theme-dark') || body.hasAttribute('data-themes') && /dark/.test(body.getAttribute('data-themes') || ''))) { return true; }
      if (body && body.hasAttribute('data-theme-light')) { return false; }
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--color-main-background').trim();
      const m = /^#([0-9a-f]{6})$/i.exec(bg);
      if (m) {
        const n = parseInt(m[1], 16);
        const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
        return lum < 128;
      }
    } catch (e) { /* fall through */ }
    if (window.matchMedia) { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
    return null;
  }
  /** Black or white, whichever reads on a given background (LibreOffice's automatic font colour). */
  function inkFor(bg) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(bg || '').trim());
    let r = 255; let g = 255; let b = 255;
    if (m) { let h = m[1]; if (h.length === 3) { h = h.split('').map((c) => c + c).join(''); } const n = parseInt(h, 16); r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255; }
    else { const rm = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(bg || '')); if (rm) { r = Number(rm[1]); g = Number(rm[2]); b = Number(rm[3]); } }
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 140 ? '#ffffff' : '#111111';
  }
  /**
   * A number in the General format that does not fit its column, as LibreOffice
   * Calc shows it: with fewer decimal places (686.6667), then as an exponent
   * (1.23E+11) when even the whole part will not fit, and ### only after that.
   * A cell with a format of its own is not touched (it shows ###, as Calc).
   */
  // Whether a number fits is judged by Calc's own cell margin (0.35 mm, about
  // 1.5 px a side), not by the 4 px the cell is drawn with: a right-aligned
  // number may run into that padding, as it does in Calc. The General format
  // keeps a little more clear (NUM_GAP a side) when it drops decimals.
  const CELL_MARGIN = 1.5;
  const NUM_GAP = 3;
  /** The typeface for measuring, exactly as the cell is drawn (the family quoted, the same fallback). */
  function fontCss(bold, px, fam) { return (bold ? '700 ' : '') + px + 'px "' + String(fam || 'Noto Sans JP').replace(/"/g, '') + '", sans-serif'; }
  function fitNumber(text, v, avail, font) {
    if (!(avail > 0) || textWidth(text, font) <= avail) { return text; }
    if (typeof v !== 'number' || !isFinite(v)) { return '###'; }
    const plain = /^-?\d+(\.\d+)?$/.test(text);
    let dec = plain ? (text.split('.')[1] || '').length : 10;
    for (let d = Math.min(dec, 15) - 1; d >= 0; d -= 1) {
      const t = Calc.format(Number(v.toFixed(d)), 'n', '', 'ja');
      if (textWidth(t, font) <= avail) { return t; }
    }
    for (let k = 5; k >= 0; k -= 1) {
      const t = v.toExponential(k).replace(/e([+-])(\d+)$/, (m, sign, n) => 'E' + sign + n.padStart(2, '0'));
      if (textWidth(t, font) <= avail) { return t; }
    }
    return '###';
  }
  /** A text's width in a typeface, for fitting columns (one canvas, kept). */
  let measureCtx = null;
  function textWidth(text, font) {
    if (!measureCtx) { measureCtx = document.createElement('canvas').getContext('2d'); }
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  // The engine, one workbook for the open book. Non-reactive on purpose: Vue must
  // not wrap a hundred thousand cells.
  let wb = null;
  // The sheets as the page keeps them (non-reactive, see above); `tick` in the Vue
  // state is bumped whenever the chrome has to notice a change in them.
  let UIS = [];
  // What was copied last, with its formulas: the clipboard carries text and HTML,
  // and this carries the cells themselves for a paste back into CalcBase.
  let CLIP = null;
  let clipSerial = 0;
  // When the context menu was opened by a long press, so the lift of the finger does not shut it.
  let ctxAt = 0;

  // ---- the page ---------------------------------------------------------------------
  // Precompiled render function (eval-free). Source template lives in calcbase.js;
  // regenerate with regibase-build/calcbase-build.mjs after editing the template.
  const render = (function () {
const { openBlock: _openBlock, createElementBlock: _createElementBlock, createCommentVNode: _createCommentVNode, createElementVNode: _createElementVNode, toDisplayString: _toDisplayString, createTextVNode: _createTextVNode, renderList: _renderList, Fragment: _Fragment, withModifiers: _withModifiers, normalizeClass: _normalizeClass, vModelText: _vModelText, withDirectives: _withDirectives, normalizeStyle: _normalizeStyle, withKeys: _withKeys, vModelCheckbox: _vModelCheckbox, vModelSelect: _vModelSelect, vShow: _vShow, vModelDynamic: _vModelDynamic, createStaticVNode: _createStaticVNode } = Vue

const _hoisted_1 = { class: "brand" }
const _hoisted_2 = ["innerHTML"]
const _hoisted_3 = /*#__PURE__*/_createElementVNode("span", { class: "name" }, "CalcBase", -1 /* HOISTED */)
const _hoisted_4 = {
  key: 0,
  class: "ver"
}
const _hoisted_5 = ["title"]
const _hoisted_6 = ["innerHTML"]
const _hoisted_7 = { class: "side-actions" }
const _hoisted_8 = ["innerHTML"]
const _hoisted_9 = { class: "cb-booklist" }
const _hoisted_10 = {
  key: 0,
  class: "hint"
}
const _hoisted_11 = ["onClick", "onContextmenu"]
const _hoisted_12 = { class: "t" }
const _hoisted_13 = { class: "m" }
const _hoisted_14 = { key: 0 }
const _hoisted_15 = { class: "side-foot" }
const _hoisted_16 = { class: "cb-main" }
const _hoisted_17 = { class: "cb-topbar" }
const _hoisted_18 = ["title"]
const _hoisted_19 = ["innerHTML"]
const _hoisted_20 = ["placeholder", "disabled"]
const _hoisted_21 = ["disabled", "title"]
const _hoisted_22 = ["innerHTML"]
const _hoisted_23 = { class: "lbl" }
const _hoisted_24 = ["disabled", "title"]
const _hoisted_25 = ["innerHTML"]
const _hoisted_26 = { class: "lbl" }
const _hoisted_27 = { class: "cb-pop" }
const _hoisted_28 = ["title"]
const _hoisted_29 = ["disabled"]
const _hoisted_30 = ["innerHTML"]
const _hoisted_31 = ["disabled"]
const _hoisted_32 = ["innerHTML"]
const _hoisted_33 = ["disabled"]
const _hoisted_34 = /*#__PURE__*/_createElementVNode("div", { class: "cb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_35 = ["disabled"]
const _hoisted_36 = ["disabled"]
const _hoisted_37 = ["innerHTML"]
const _hoisted_38 = /*#__PURE__*/_createElementVNode("span", { class: "k" }, "Ctrl+F", -1 /* HOISTED */)
const _hoisted_39 = /*#__PURE__*/_createElementVNode("span", { class: "grow" }, null, -1 /* HOISTED */)
const _hoisted_40 = { class: "hist" }
const _hoisted_41 = ["disabled", "title"]
const _hoisted_42 = ["innerHTML"]
const _hoisted_43 = ["disabled", "title"]
const _hoisted_44 = ["innerHTML"]
const _hoisted_45 = ["title"]
const _hoisted_46 = ["innerHTML"]
const _hoisted_47 = ["innerHTML"]
const _hoisted_48 = {
  key: 0,
  class: "fmttools"
}
const _hoisted_49 = ["disabled", "title"]
const _hoisted_50 = ["innerHTML"]
const _hoisted_51 = ["title"]
const _hoisted_52 = ["innerHTML"]
const _hoisted_53 = ["disabled", "title"]
const _hoisted_54 = ["innerHTML"]
const _hoisted_55 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_56 = ["value", "title", "disabled"]
const _hoisted_57 = { value: "" }
const _hoisted_58 = ["value"]
const _hoisted_59 = ["value", "title", "disabled"]
const _hoisted_60 = { value: "" }
const _hoisted_61 = ["value"]
const _hoisted_62 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_63 = ["disabled", "title"]
const _hoisted_64 = /*#__PURE__*/_createElementVNode("span", { class: "b" }, "B", -1 /* HOISTED */)
const _hoisted_65 = [
  _hoisted_64
]
const _hoisted_66 = ["disabled", "title"]
const _hoisted_67 = /*#__PURE__*/_createElementVNode("span", { class: "i" }, "I", -1 /* HOISTED */)
const _hoisted_68 = [
  _hoisted_67
]
const _hoisted_69 = ["disabled", "title"]
const _hoisted_70 = /*#__PURE__*/_createElementVNode("span", { class: "u" }, "U", -1 /* HOISTED */)
const _hoisted_71 = [
  _hoisted_70
]
const _hoisted_72 = ["disabled", "title"]
const _hoisted_73 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "S", -1 /* HOISTED */)
const _hoisted_74 = [
  _hoisted_73
]
const _hoisted_75 = { class: "cb-pop" }
const _hoisted_76 = ["title"]
const _hoisted_77 = ["innerHTML"]
const _hoisted_78 = ["value", "disabled"]
const _hoisted_79 = ["innerHTML", "title"]
const _hoisted_80 = /*#__PURE__*/_createElementVNode("span", { class: "cb-swatch none" }, null, -1 /* HOISTED */)
const _hoisted_81 = { class: "cb-swatches" }
const _hoisted_82 = ["title", "onClick"]
const _hoisted_83 = { class: "cb-pop" }
const _hoisted_84 = ["title"]
const _hoisted_85 = ["innerHTML"]
const _hoisted_86 = ["value", "disabled"]
const _hoisted_87 = ["innerHTML", "title"]
const _hoisted_88 = /*#__PURE__*/_createElementVNode("span", { class: "cb-swatch none" }, null, -1 /* HOISTED */)
const _hoisted_89 = { class: "cb-swatches" }
const _hoisted_90 = ["title", "onClick"]
const _hoisted_91 = { class: "cb-pop" }
const _hoisted_92 = ["disabled", "title"]
const _hoisted_93 = ["innerHTML"]
const _hoisted_94 = ["innerHTML"]
const _hoisted_95 = { class: "bgrid" }
const _hoisted_96 = ["onClick", "title"]
const _hoisted_97 = /*#__PURE__*/_createElementVNode("div", { class: "cb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_98 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_99 = ["disabled", "title", "innerHTML"]
const _hoisted_100 = ["disabled", "title", "innerHTML"]
const _hoisted_101 = ["disabled", "title", "innerHTML"]
const _hoisted_102 = ["disabled", "title", "innerHTML"]
const _hoisted_103 = ["disabled", "title", "innerHTML"]
const _hoisted_104 = ["disabled", "title", "innerHTML"]
const _hoisted_105 = ["disabled", "title", "innerHTML"]
const _hoisted_106 = ["disabled", "title", "innerHTML"]
const _hoisted_107 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_108 = { class: "cb-pop" }
const _hoisted_109 = ["disabled", "title"]
const _hoisted_110 = { class: "fname" }
const _hoisted_111 = ["innerHTML"]
const _hoisted_112 = ["onClick"]
const _hoisted_113 = { class: "ex" }
const _hoisted_114 = /*#__PURE__*/_createElementVNode("div", { class: "cb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_115 = ["disabled", "title", "innerHTML"]
const _hoisted_116 = ["disabled", "title", "innerHTML"]
const _hoisted_117 = ["disabled", "title", "innerHTML"]
const _hoisted_118 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_119 = { class: "cb-pop" }
const _hoisted_120 = ["disabled", "title"]
const _hoisted_121 = ["innerHTML"]
const _hoisted_122 = ["innerHTML"]
const _hoisted_123 = /*#__PURE__*/_createElementVNode("div", { class: "cb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_124 = /*#__PURE__*/_createElementVNode("div", { class: "cb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_125 = ["disabled", "title", "innerHTML"]
const _hoisted_126 = ["disabled", "title", "innerHTML"]
const _hoisted_127 = ["disabled", "title", "innerHTML"]
const _hoisted_128 = ["disabled", "title", "innerHTML"]
const _hoisted_129 = ["disabled", "title", "innerHTML"]
const _hoisted_130 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_131 = ["disabled", "title", "innerHTML"]
const _hoisted_132 = ["title", "innerHTML"]
const _hoisted_133 = ["disabled", "title", "innerHTML"]
const _hoisted_134 = {
  key: 0,
  class: "cb-work"
}
const _hoisted_135 = { class: "cb-sheetcol" }
const _hoisted_136 = { class: "cb-fbar" }
const _hoisted_137 = ["value", "title"]
const _hoisted_138 = ["title", "disabled"]
const _hoisted_139 = ["title"]
const _hoisted_140 = ["title"]
const _hoisted_141 = ["value", "disabled", "placeholder"]
const _hoisted_142 = {
  key: 0,
  class: "cb-find"
}
const _hoisted_143 = ["innerHTML"]
const _hoisted_144 = ["placeholder"]
const _hoisted_145 = { class: "count" }
const _hoisted_146 = ["title"]
const _hoisted_147 = ["title"]
const _hoisted_148 = { class: "opt" }
const _hoisted_149 = { class: "opt" }
const _hoisted_150 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_151 = ["placeholder", "disabled"]
const _hoisted_152 = ["disabled"]
const _hoisted_153 = ["disabled"]
const _hoisted_154 = ["title"]
const _hoisted_155 = ["innerHTML"]
const _hoisted_156 = {
  class: "cb-view",
  ref: "view"
}
const _hoisted_157 = {
  class: "cb-layers",
  ref: "layers"
}
const _hoisted_158 = {
  class: "cb-spacer",
  ref: "spacer"
}
const _hoisted_159 = ["onClick"]
const _hoisted_160 = { class: "d" }
const _hoisted_161 = ["innerHTML"]
const _hoisted_162 = { class: "cb-sheets" }
const _hoisted_163 = ["disabled", "title"]
const _hoisted_164 = ["innerHTML"]
const _hoisted_165 = ["onClick", "onDblclick", "onContextmenu"]
const _hoisted_166 = { class: "cb-status" }
const _hoisted_167 = { class: "grow" }
const _hoisted_168 = { key: 0 }
const _hoisted_169 = {
  key: 0,
  class: "stat"
}
const _hoisted_170 = {
  key: 1,
  class: "stat avg"
}
const _hoisted_171 = {
  key: 2,
  class: "stat cnt"
}
const _hoisted_172 = { class: "ai-head" }
const _hoisted_173 = { class: "ai-title" }
const _hoisted_174 = { class: "ai-sub" }
const _hoisted_175 = /*#__PURE__*/_createElementVNode("span", { class: "grow" }, null, -1 /* HOISTED */)
const _hoisted_176 = ["title"]
const _hoisted_177 = ["disabled", "title"]
const _hoisted_178 = ["title", "aria-label"]
const _hoisted_179 = {
  class: "ai-msgs",
  ref: "aiMsgs"
}
const _hoisted_180 = {
  key: 0,
  class: "ai-hint"
}
const _hoisted_181 = ["innerHTML"]
const _hoisted_182 = {
  key: 0,
  class: "did"
}
const _hoisted_183 = {
  key: 1,
  class: "ai-msg assistant"
}
const _hoisted_184 = { class: "ai-bubble busy" }
const _hoisted_185 = {
  key: 2,
  class: "ai-err"
}
const _hoisted_186 = { class: "ai-foot" }
const _hoisted_187 = ["placeholder", "disabled"]
const _hoisted_188 = ["disabled"]
const _hoisted_189 = {
  key: 1,
  class: "ai-bar"
}
const _hoisted_190 = ["title", "aria-label"]
const _hoisted_191 = { class: "ai-lb" }
const _hoisted_192 = {
  key: 1,
  class: "cb-empty"
}
const _hoisted_193 = ["innerHTML"]
const _hoisted_194 = {
  key: 1,
  class: "cb-modal-back"
}
const _hoisted_195 = { class: "set-head" }
const _hoisted_196 = /*#__PURE__*/_createElementVNode("span", { class: "ic big" }, "⚙", -1 /* HOISTED */)
const _hoisted_197 = { class: "dim" }
const _hoisted_198 = ["title", "aria-label"]
const _hoisted_199 = /*#__PURE__*/_createElementVNode("svg", { viewBox: "0 0 24 24" }, [
  /*#__PURE__*/_createElementVNode("path", { d: "M18 6L6 18" }),
  /*#__PURE__*/_createElementVNode("path", { d: "M6 6l12 12" })
], -1 /* HOISTED */)
const _hoisted_200 = [
  _hoisted_199
]
const _hoisted_201 = { class: "body" }
const _hoisted_202 = {
  class: "set-tabs",
  role: "tablist"
}
const _hoisted_203 = ["aria-selected", "title", "onClick"]
const _hoisted_204 = { class: "ic" }
const _hoisted_205 = { class: "set-group" }
const _hoisted_206 = /*#__PURE__*/_createElementVNode("span", { class: "ic" }, "🎨", -1 /* HOISTED */)
const _hoisted_207 = { class: "theme-picks" }
const _hoisted_208 = ["onClick"]
const _hoisted_209 = /*#__PURE__*/_createElementVNode("i", { class: "bar" }, null, -1 /* HOISTED */)
const _hoisted_210 = /*#__PURE__*/_createElementVNode("i", { class: "line" }, null, -1 /* HOISTED */)
const _hoisted_211 = /*#__PURE__*/_createElementVNode("i", { class: "line short" }, null, -1 /* HOISTED */)
const _hoisted_212 = [
  _hoisted_209,
  _hoisted_210,
  _hoisted_211
]
const _hoisted_213 = { class: "dim" }
const _hoisted_214 = {
  key: 0,
  class: "tick"
}
const _hoisted_215 = { class: "dim tiny" }
const _hoisted_216 = { class: "fl" }
const _hoisted_217 = { value: "auto" }
const _hoisted_218 = ["value"]
const _hoisted_219 = { class: "dim tiny" }
const _hoisted_220 = { class: "fl" }
const _hoisted_221 = { class: "ai-widthbox" }
const _hoisted_222 = ["min", "max", "aria-label"]
const _hoisted_223 = ["aria-label"]
const _hoisted_224 = /*#__PURE__*/_createElementVNode("option", { value: "px" }, "px", -1 /* HOISTED */)
const _hoisted_225 = /*#__PURE__*/_createElementVNode("option", { value: "%" }, "%", -1 /* HOISTED */)
const _hoisted_226 = [
  _hoisted_224,
  _hoisted_225
]
const _hoisted_227 = { class: "dim tiny" }
const _hoisted_228 = { class: "set-group" }
const _hoisted_229 = /*#__PURE__*/_createElementVNode("span", { class: "ic" }, "✏️", -1 /* HOISTED */)
const _hoisted_230 = { class: "fl" }
const _hoisted_231 = { value: "down" }
const _hoisted_232 = { value: "right" }
const _hoisted_233 = { class: "dim tiny" }
const _hoisted_234 = { class: "opt" }
const _hoisted_235 = { class: "fl-row" }
const _hoisted_236 = { class: "fl" }
const _hoisted_237 = { class: "fl-label" }
const _hoisted_238 = ["value"]
const _hoisted_239 = { class: "fl short" }
const _hoisted_240 = { class: "fl-label" }
const _hoisted_241 = { class: "dim tiny" }
const _hoisted_242 = { class: "set-group" }
const _hoisted_243 = /*#__PURE__*/_createElementVNode("span", { class: "ic" }, "💾", -1 /* HOISTED */)
const _hoisted_244 = { class: "opt" }
const _hoisted_245 = { class: "fl" }
const _hoisted_246 = ["aria-label"]
const _hoisted_247 = { class: "dim tiny" }
const _hoisted_248 = { class: "fl-row" }
const _hoisted_249 = { class: "fl short" }
const _hoisted_250 = { class: "fl-label" }
const _hoisted_251 = { class: "fl" }
const _hoisted_252 = { class: "fl-label" }
const _hoisted_253 = { value: "manual" }
const _hoisted_254 = { value: "auto" }
const _hoisted_255 = { class: "dim tiny" }
const _hoisted_256 = { class: "foot" }
const _hoisted_257 = {
  key: 2,
  class: "cb-modal-back"
}
const _hoisted_258 = {
  class: "cb-tip",
  style: {"font-weight":"400"}
}
const _hoisted_259 = {
  class: "cb-fp-tabs",
  role: "tablist"
}
const _hoisted_260 = ["onClick"]
const _hoisted_261 = { class: "body" }
const _hoisted_262 = {
  key: 0,
  class: "cb-nf"
}
const _hoisted_263 = { class: "cb-nf-cats" }
const _hoisted_264 = ["onClick"]
const _hoisted_265 = { class: "cb-nf-main" }
const _hoisted_266 = { class: "cb-nf-sample" }
const _hoisted_267 = { class: "k" }
const _hoisted_268 = { class: "v" }
const _hoisted_269 = { class: "cb-tip" }
const _hoisted_270 = {
  key: 0,
  class: "cb-row"
}
const _hoisted_271 = { class: "cb-field" }
const _hoisted_272 = {
  key: 0,
  class: "cb-field"
}
const _hoisted_273 = /*#__PURE__*/_createElementVNode("label", null, " ", -1 /* HOISTED */)
const _hoisted_274 = { class: "opt" }
const _hoisted_275 = {
  key: 1,
  class: "cb-field"
}
const _hoisted_276 = /*#__PURE__*/_createElementVNode("option", null, "¥", -1 /* HOISTED */)
const _hoisted_277 = /*#__PURE__*/_createElementVNode("option", null, "$", -1 /* HOISTED */)
const _hoisted_278 = /*#__PURE__*/_createElementVNode("option", null, "€", -1 /* HOISTED */)
const _hoisted_279 = /*#__PURE__*/_createElementVNode("option", null, "£", -1 /* HOISTED */)
const _hoisted_280 = [
  _hoisted_276,
  _hoisted_277,
  _hoisted_278,
  _hoisted_279
]
const _hoisted_281 = {
  key: 2,
  class: "cb-field"
}
const _hoisted_282 = /*#__PURE__*/_createElementVNode("label", null, " ", -1 /* HOISTED */)
const _hoisted_283 = { class: "opt" }
const _hoisted_284 = {
  key: 1,
  class: "cb-field"
}
const _hoisted_285 = /*#__PURE__*/_createStaticVNode("<option value=\"yyyy/mm/dd\">2026/10/05</option><option value=\"yyyy-mm-dd\">2026-10-05</option><option value=\"yyyy年m月d日\">2026年10月5日</option><option value=\"ggge年m月d日\">令和8年10月5日</option><option value=\"m/d\">10/5</option><option value=\"yyyy/mm/dd h:mm\">2026/10/05 9:30</option>", 6)
const _hoisted_291 = [
  _hoisted_285
]
const _hoisted_292 = {
  key: 2,
  class: "cb-field"
}
const _hoisted_293 = /*#__PURE__*/_createElementVNode("option", { value: "h:mm" }, "9:30", -1 /* HOISTED */)
const _hoisted_294 = /*#__PURE__*/_createElementVNode("option", { value: "h:mm:ss" }, "9:30:15", -1 /* HOISTED */)
const _hoisted_295 = [
  _hoisted_293,
  _hoisted_294
]
const _hoisted_296 = { class: "cb-field" }
const _hoisted_297 = { class: "cb-nf-examples" }
const _hoisted_298 = ["onClick"]
const _hoisted_299 = { class: "s" }
const _hoisted_300 = {
  key: 1,
  class: "cb-row",
  style: {"margin-top":"10px"}
}
const _hoisted_301 = { class: "cb-field" }
const _hoisted_302 = { value: "" }
const _hoisted_303 = { value: "left" }
const _hoisted_304 = { value: "center" }
const _hoisted_305 = { value: "right" }
const _hoisted_306 = { class: "cb-field" }
const _hoisted_307 = { value: "" }
const _hoisted_308 = { value: "top" }
const _hoisted_309 = { value: "middle" }
const _hoisted_310 = {
  class: "cb-field",
  style: {"flex-basis":"100%"}
}
const _hoisted_311 = /*#__PURE__*/_createElementVNode("label", null, " ", -1 /* HOISTED */)
const _hoisted_312 = { class: "opt" }
const _hoisted_313 = {
  key: 2,
  class: "cb-fontpick"
}
const _hoisted_314 = { class: "col fam" }
const _hoisted_315 = ["placeholder"]
const _hoisted_316 = { class: "list" }
const _hoisted_317 = ["onClick"]
const _hoisted_318 = { class: "col sty" }
const _hoisted_319 = ["value"]
const _hoisted_320 = { class: "list" }
const _hoisted_321 = { class: "col siz" }
const _hoisted_322 = ["placeholder"]
const _hoisted_323 = { class: "list" }
const _hoisted_324 = ["onClick"]
const _hoisted_325 = { class: "row2" }
const _hoisted_326 = ["value"]
const _hoisted_327 = { class: "opt" }
const _hoisted_328 = { class: "opt" }
const _hoisted_329 = { class: "preview" }
const _hoisted_330 = {
  key: 3,
  class: "cb-bd"
}
const _hoisted_331 = { class: "cb-bd-line" }
const _hoisted_332 = ["onClick"]
const _hoisted_333 = { class: "nm" }
const _hoisted_334 = { class: "cb-field" }
const _hoisted_335 = { class: "cb-field" }
const _hoisted_336 = { class: "cb-bd-main" }
const _hoisted_337 = { class: "cb-bd-presets" }
const _hoisted_338 = ["onClick", "title"]
const _hoisted_339 = { class: "cb-tip" }
const _hoisted_340 = {
  key: 4,
  class: "cb-fillpick"
}
const _hoisted_341 = { class: "cb-swatches" }
const _hoisted_342 = ["onClick", "title"]
const _hoisted_343 = ["value"]
const _hoisted_344 = {
  class: "cb-tip",
  style: {"margin-top":"12px"}
}
const _hoisted_345 = { class: "foot" }
const _hoisted_346 = { class: "body" }
const _hoisted_347 = { class: "cb-row" }
const _hoisted_348 = { class: "cb-field" }
const _hoisted_349 = { value: "" }
const _hoisted_350 = ["value"]
const _hoisted_351 = { class: "cb-field" }
const _hoisted_352 = ["placeholder"]
const _hoisted_353 = { class: "cb-fxlist" }
const _hoisted_354 = ["onClick"]
const _hoisted_355 = { class: "d" }
const _hoisted_356 = { class: "g" }
const _hoisted_357 = {
  key: 0,
  class: "cb-tip",
  style: {"padding":"10px"}
}
const _hoisted_358 = {
  key: 0,
  class: "cb-fxabout"
}
const _hoisted_359 = { class: "cb-tip" }
const _hoisted_360 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_361 = { class: "foot" }
const _hoisted_362 = ["disabled"]
const _hoisted_363 = { class: "body" }
const _hoisted_364 = { class: "cb-row" }
const _hoisted_365 = { class: "cb-field" }
const _hoisted_366 = { value: "sheet" }
const _hoisted_367 = { value: "selection" }
const _hoisted_368 = { value: "book" }
const _hoisted_369 = { class: "cb-field" }
const _hoisted_370 = ["value"]
const _hoisted_371 = { class: "cb-field" }
const _hoisted_372 = { value: "portrait" }
const _hoisted_373 = { value: "landscape" }
const _hoisted_374 = { class: "cb-row" }
const _hoisted_375 = { class: "cb-field" }
const _hoisted_376 = { class: "cb-field" }
const _hoisted_377 = { class: "cb-field" }
const _hoisted_378 = { class: "cb-field" }
const _hoisted_379 = { class: "opt" }
const _hoisted_380 = { class: "opt" }
const _hoisted_381 = { class: "opt" }
const _hoisted_382 = { class: "opt" }
const _hoisted_383 = { class: "cb-tip" }
const _hoisted_384 = { class: "foot" }
const _hoisted_385 = { class: "body" }
const _hoisted_386 = {
  key: 0,
  class: "cb-tip"
}
const _hoisted_387 = {
  key: 1,
  class: "cb-versions"
}
const _hoisted_388 = { class: "no" }
const _hoisted_389 = { class: "when" }
const _hoisted_390 = { class: "sz" }
const _hoisted_391 = ["onClick"]
const _hoisted_392 = ["onClick", "disabled"]
const _hoisted_393 = ["innerHTML"]
const _hoisted_394 = { class: "cb-tip" }
const _hoisted_395 = { class: "foot" }
const _hoisted_396 = { class: "body" }
const _hoisted_397 = { class: "cb-tip" }
const _hoisted_398 = ["value"]
const _hoisted_399 = { class: "foot" }
const _hoisted_400 = { class: "body" }
const _hoisted_401 = { class: "cb-field" }
const _hoisted_402 = { key: 0 }
const _hoisted_403 = ["type", "min", "max"]
const _hoisted_404 = {
  key: 0,
  class: "cb-tip"
}
const _hoisted_405 = { class: "foot" }
const _hoisted_406 = { class: "body" }
const _hoisted_407 = { class: "fp-path" }
const _hoisted_408 = ["disabled", "title"]
const _hoisted_409 = ["innerHTML"]
const _hoisted_410 = { class: "crumbs" }
const _hoisted_411 = { class: "fp-list" }
const _hoisted_412 = {
  key: 0,
  class: "cb-tip",
  style: {"padding":"10px"}
}
const _hoisted_413 = ["onClick", "onDblclick"]
const _hoisted_414 = ["innerHTML"]
const _hoisted_415 = { class: "nm" }
const _hoisted_416 = {
  key: 0,
  class: "meta"
}
const _hoisted_417 = {
  key: 0,
  class: "cb-tip",
  style: {"padding":"10px"}
}
const _hoisted_418 = {
  key: 0,
  class: "cb-tip"
}
const _hoisted_419 = { class: "foot" }
const _hoisted_420 = ["disabled"]
const _hoisted_421 = { class: "body" }
const _hoisted_422 = { class: "cb-field" }
const _hoisted_423 = /*#__PURE__*/_createElementVNode("option", { value: "xlsx" }, "Excel (.xlsx)", -1 /* HOISTED */)
const _hoisted_424 = /*#__PURE__*/_createElementVNode("option", { value: "ods" }, "LibreOffice Calc (.ods)", -1 /* HOISTED */)
const _hoisted_425 = { value: "csv" }
const _hoisted_426 = { class: "cb-tip" }
const _hoisted_427 = { class: "foot" }
const _hoisted_428 = ["disabled"]
const _hoisted_429 = {
  class: "opt",
  style: {"margin":"0"}
}
const _hoisted_430 = ["checked"]
const _hoisted_431 = { class: "list" }
const _hoisted_432 = ["checked", "onChange"]
const _hoisted_433 = { class: "acts" }
const _hoisted_434 = { class: "hd" }
const _hoisted_435 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_436 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_437 = { class: "hd" }
const _hoisted_438 = ["disabled"]
const _hoisted_439 = ["disabled"]
const _hoisted_440 = ["disabled"]
const _hoisted_441 = ["disabled"]
const _hoisted_442 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_443 = ["disabled"]
const _hoisted_444 = ["disabled"]
const _hoisted_445 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_446 = ["disabled"]
const _hoisted_447 = { class: "hd" }
const _hoisted_448 = ["disabled"]
const _hoisted_449 = ["disabled"]
const _hoisted_450 = ["disabled"]
const _hoisted_451 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_452 = ["disabled"]
const _hoisted_453 = ["disabled"]
const _hoisted_454 = ["disabled"]
const _hoisted_455 = ["disabled"]
const _hoisted_456 = ["disabled"]
const _hoisted_457 = ["disabled"]
const _hoisted_458 = ["disabled"]
const _hoisted_459 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_460 = ["disabled"]
const _hoisted_461 = ["disabled"]
const _hoisted_462 = ["disabled"]
const _hoisted_463 = ["disabled"]
const _hoisted_464 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_465 = ["disabled"]
const _hoisted_466 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+X", -1 /* HOISTED */)
const _hoisted_467 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+C", -1 /* HOISTED */)
const _hoisted_468 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+V", -1 /* HOISTED */)
const _hoisted_469 = { class: "hd" }
const _hoisted_470 = ["disabled"]
const _hoisted_471 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+X", -1 /* HOISTED */)
const _hoisted_472 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+C", -1 /* HOISTED */)
const _hoisted_473 = ["disabled"]
const _hoisted_474 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+V", -1 /* HOISTED */)
const _hoisted_475 = ["disabled"]
const _hoisted_476 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+Shift+V", -1 /* HOISTED */)
const _hoisted_477 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_478 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_479 = { class: "fly" }
const _hoisted_480 = ["disabled"]
const _hoisted_481 = ["disabled"]
const _hoisted_482 = ["disabled"]
const _hoisted_483 = ["disabled"]
const _hoisted_484 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_485 = { class: "fly" }
const _hoisted_486 = ["disabled"]
const _hoisted_487 = ["disabled"]
const _hoisted_488 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_489 = { class: "fly" }
const _hoisted_490 = ["disabled"]
const _hoisted_491 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Delete", -1 /* HOISTED */)
const _hoisted_492 = ["disabled"]
const _hoisted_493 = ["disabled"]
const _hoisted_494 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_495 = ["disabled"]
const _hoisted_496 = ["disabled"]
const _hoisted_497 = ["disabled"]
const _hoisted_498 = ["disabled"]
const _hoisted_499 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+1", -1 /* HOISTED */)
const _hoisted_500 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_501 = {
  key: 14,
  class: "cb-toast"
}

return function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", {
    class: _normalizeClass(["cb-shell", { narrow: _ctx.narrow }]),
    onContextmenu: _cache[344] || (_cache[344] = $event => (_ctx.onContextMenu($event)))
  }, [
    (_ctx.narrow && _ctx.sideOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 0,
          class: "cb-backdrop",
          onClick: _cache[0] || (_cache[0] = $event => (_ctx.sideOpen = false))
        }))
      : _createCommentVNode("v-if", true),
    _createElementVNode("aside", {
      class: _normalizeClass(["cb-side", { hidden: !_ctx.sideOpen }])
    }, [
      _createElementVNode("div", _hoisted_1, [
        _createElementVNode("span", {
          class: "logo",
          innerHTML: _ctx.logo
        }, null, 8 /* PROPS */, _hoisted_2),
        _hoisted_3,
        (!_ctx.narrow)
          ? (_openBlock(), _createElementBlock("span", _hoisted_4, _toDisplayString(_ctx.version), 1 /* TEXT */))
          : _createCommentVNode("v-if", true),
        (_ctx.narrow)
          ? (_openBlock(), _createElementBlock("button", {
              key: 1,
              class: "cb-tb side-close",
              onClick: _cache[1] || (_cache[1] = $event => (_ctx.sideOpen = false)),
              title: _ctx.t('Close')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.close
              }, null, 8 /* PROPS */, _hoisted_6)
            ], 8 /* PROPS */, _hoisted_5))
          : _createCommentVNode("v-if", true)
      ]),
      _createElementVNode("div", _hoisted_7, [
        _createElementVNode("button", {
          class: "cb-btn primary wide",
          onClick: _cache[2] || (_cache[2] = (...args) => (_ctx.newBook && _ctx.newBook(...args)))
        }, "＋ " + _toDisplayString(_ctx.t('New book')), 1 /* TEXT */),
        _createElementVNode("button", {
          class: "cb-btn ghost wide",
          onClick: _cache[3] || (_cache[3] = (...args) => (_ctx.importBook && _ctx.importBook(...args)))
        }, [
          _createElementVNode("span", {
            innerHTML: _ctx.icons.import
          }, null, 8 /* PROPS */, _hoisted_8),
          _createTextVNode(" " + _toDisplayString(_ctx.t('Import…')), 1 /* TEXT */)
        ])
      ]),
      _createElementVNode("div", _hoisted_9, [
        (!_ctx.books.length)
          ? (_openBlock(), _createElementBlock("p", _hoisted_10, _toDisplayString(_ctx.t('No books yet. Everything you make here is saved to {folder} in your Files as a plain .html file.', { folder: _ctx.settings.folder })), 1 /* TEXT */))
          : _createCommentVNode("v-if", true),
        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.books, (b) => {
          return (_openBlock(), _createElementBlock("button", {
            key: b.id,
            class: _normalizeClass(["cb-bookitem", { active: b.id === _ctx.book.id }]),
            onClick: $event => (_ctx.openBook(b.id)),
            onContextmenu: _withModifiers($event => (_ctx.bookCtx($event, b)), ["prevent","stop"])
          }, [
            _createElementVNode("span", _hoisted_12, _toDisplayString(b.title || b.name), 1 /* TEXT */),
            _createElementVNode("span", _hoisted_13, [
              _createTextVNode(_toDisplayString(_ctx.when(b.mtime)) + " · " + _toDisplayString(_ctx.size(b.size)), 1 /* TEXT */),
              (b.shared)
                ? (_openBlock(), _createElementBlock("span", _hoisted_14, " · " + _toDisplayString(b.owner), 1 /* TEXT */))
                : _createCommentVNode("v-if", true)
            ])
          ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_11))
        }), 128 /* KEYED_FRAGMENT */))
      ]),
      _createElementVNode("div", _hoisted_15, [
        _createElementVNode("button", {
          class: "cb-btn ghost wide",
          onClick: _cache[4] || (_cache[4] = $event => (_ctx.openSettings()))
        }, "⚙ " + _toDisplayString(_ctx.t('Settings')), 1 /* TEXT */)
      ])
    ], 2 /* CLASS */),
    _createElementVNode("section", _hoisted_16, [
      _createElementVNode("div", _hoisted_17, [
        _createElementVNode("button", {
          class: "cb-tb menu-btn",
          onTouchend: _cache[5] || (_cache[5] = _withModifiers($event => (_ctx.sideOpen = !_ctx.sideOpen), ["prevent"])),
          onClick: _cache[6] || (_cache[6] = $event => (_ctx.sideOpen = !_ctx.sideOpen)),
          title: _ctx.t('Books')
        }, [
          _createElementVNode("span", {
            innerHTML: _ctx.icons.menu
          }, null, 8 /* PROPS */, _hoisted_19)
        ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_18),
        _withDirectives(_createElementVNode("input", {
          class: "title-input",
          "onUpdate:modelValue": _cache[7] || (_cache[7] = $event => ((_ctx.book.name) = $event)),
          placeholder: _ctx.t('Untitled book'),
          onChange: _cache[8] || (_cache[8] = (...args) => (_ctx.applyTitle && _ctx.applyTitle(...args))),
          disabled: !_ctx.book.id || _ctx.book.readOnly
        }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_20), [
          [_vModelText, _ctx.book.name]
        ]),
        _createElementVNode("span", {
          class: _normalizeClass(["state", { dirty: _ctx.dirty, ro: _ctx.book.readOnly }])
        }, _toDisplayString(_ctx.stateText), 3 /* TEXT, CLASS */),
        _createElementVNode("button", {
          class: "cb-btn",
          onClick: _cache[9] || (_cache[9] = $event => (_ctx.save(true))),
          disabled: !_ctx.book.id || _ctx.saving || _ctx.book.readOnly,
          title: _ctx.t('Save') + ' (Ctrl+S)'
        }, [
          _createElementVNode("span", {
            innerHTML: _ctx.icons.save
          }, null, 8 /* PROPS */, _hoisted_22),
          _createTextVNode(),
          _createElementVNode("span", _hoisted_23, _toDisplayString(_ctx.t('Save')), 1 /* TEXT */)
        ], 8 /* PROPS */, _hoisted_21),
        _createElementVNode("button", {
          class: "cb-btn",
          onClick: _cache[10] || (_cache[10] = (...args) => (_ctx.openPrint && _ctx.openPrint(...args))),
          disabled: !_ctx.book.id,
          title: _ctx.t('Print / PDF')
        }, [
          _createElementVNode("span", {
            innerHTML: _ctx.icons.print
          }, null, 8 /* PROPS */, _hoisted_25),
          _createTextVNode(),
          _createElementVNode("span", _hoisted_26, _toDisplayString(_ctx.t('Print / PDF')), 1 /* TEXT */)
        ], 8 /* PROPS */, _hoisted_24),
        _createElementVNode("span", _hoisted_27, [
          _createElementVNode("button", {
            class: "cb-btn ghost",
            onClick: _cache[11] || (_cache[11] = $event => (_ctx.toggleMenu('more'))),
            title: _ctx.t('More')
          }, "⋯", 8 /* PROPS */, _hoisted_28),
          (_ctx.menu === 'more')
            ? (_openBlock(), _createElementBlock("div", {
                key: 0,
                class: "cb-menu",
                onMousedown: _cache[17] || (_cache[17] = _withModifiers(() => {}, ["prevent"]))
              }, [
                _createElementVNode("button", {
                  class: "cb-menu-item",
                  disabled: !_ctx.book.id,
                  onClick: _cache[12] || (_cache[12] = $event => {_ctx.menu = ''; _ctx.openExport()})
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.export
                  }, null, 8 /* PROPS */, _hoisted_30),
                  _createTextVNode(_toDisplayString(_ctx.t('Export as CSV / ODS / XLSX…')), 1 /* TEXT */)
                ], 8 /* PROPS */, _hoisted_29),
                _createElementVNode("button", {
                  class: "cb-menu-item",
                  disabled: !_ctx.book.id,
                  onClick: _cache[13] || (_cache[13] = $event => {_ctx.menu = ''; _ctx.downloadBook(_ctx.book)})
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.doc
                  }, null, 8 /* PROPS */, _hoisted_32),
                  _createTextVNode(_toDisplayString(_ctx.t('Download the .html')), 1 /* TEXT */)
                ], 8 /* PROPS */, _hoisted_31),
                _createElementVNode("button", {
                  class: "cb-menu-item",
                  disabled: !_ctx.book.id,
                  onClick: _cache[14] || (_cache[14] = $event => {_ctx.menu = ''; _ctx.openVersions(_ctx.book)})
                }, _toDisplayString(_ctx.t('Versions…')), 9 /* TEXT, PROPS */, _hoisted_33),
                _hoisted_34,
                _createElementVNode("button", {
                  class: "cb-menu-item",
                  disabled: !_ctx.book.id,
                  onClick: _cache[15] || (_cache[15] = $event => {_ctx.menu = ''; _ctx.showSource})
                }, "</> " + _toDisplayString(_ctx.t('View the HTML')), 9 /* TEXT, PROPS */, _hoisted_35),
                _createElementVNode("button", {
                  class: "cb-menu-item",
                  disabled: !_ctx.book.id,
                  onClick: _cache[16] || (_cache[16] = $event => {_ctx.menu = ''; _ctx.toggleFind()})
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.search
                  }, null, 8 /* PROPS */, _hoisted_37),
                  _createTextVNode(_toDisplayString(_ctx.t('Find and replace')), 1 /* TEXT */),
                  _hoisted_38
                ], 8 /* PROPS */, _hoisted_36)
              ], 32 /* NEED_HYDRATION */))
            : _createCommentVNode("v-if", true)
        ]),
        _hoisted_39,
        _createElementVNode("span", _hoisted_40, [
          _createElementVNode("button", {
            class: "cb-tb",
            onMousedown: _cache[18] || (_cache[18] = _withModifiers(() => {}, ["prevent"])),
            onClick: _cache[19] || (_cache[19] = (...args) => (_ctx.undo && _ctx.undo(...args))),
            disabled: !_ctx.canUndo,
            title: _ctx.t('Undo') + ' (Ctrl+Z)'
          }, [
            _createElementVNode("span", {
              innerHTML: _ctx.icons.undo
            }, null, 8 /* PROPS */, _hoisted_42)
          ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_41),
          _createElementVNode("button", {
            class: "cb-tb",
            onMousedown: _cache[20] || (_cache[20] = _withModifiers(() => {}, ["prevent"])),
            onClick: _cache[21] || (_cache[21] = (...args) => (_ctx.redo && _ctx.redo(...args))),
            disabled: !_ctx.canRedo,
            title: _ctx.t('Redo') + ' (Ctrl+Y)'
          }, [
            _createElementVNode("span", {
              innerHTML: _ctx.icons.redo
            }, null, 8 /* PROPS */, _hoisted_44)
          ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_43)
        ]),
        _createElementVNode("span", {
          class: "cb-num",
          title: _ctx.t('Zoom')
        }, [
          _createElementVNode("button", {
            class: "cb-tb",
            onMousedown: _cache[22] || (_cache[22] = _withModifiers(() => {}, ["prevent"])),
            onClick: _cache[23] || (_cache[23] = $event => (_ctx.stepZoom(-10))),
            innerHTML: _ctx.icons.minus
          }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_46),
          _createElementVNode("button", {
            class: "cb-tb text zoomv",
            onMousedown: _cache[24] || (_cache[24] = _withModifiers(() => {}, ["prevent"])),
            onClick: _cache[25] || (_cache[25] = $event => (_ctx.setZoom(100)))
          }, _toDisplayString(_ctx.zoom) + "%", 33 /* TEXT, NEED_HYDRATION */),
          _createElementVNode("button", {
            class: "cb-tb",
            onMousedown: _cache[26] || (_cache[26] = _withModifiers(() => {}, ["prevent"])),
            onClick: _cache[27] || (_cache[27] = $event => (_ctx.stepZoom(10))),
            innerHTML: _ctx.icons.plus
          }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_47)
        ], 8 /* PROPS */, _hoisted_45),
        (_ctx.book.id)
          ? (_openBlock(), _createElementBlock("span", _hoisted_48, [
              _createElementVNode("button", {
                class: "cb-tb",
                onMousedown: _cache[28] || (_cache[28] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[29] || (_cache[29] = $event => (_ctx.clipCut())),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Cut') + ' (Ctrl+X)'
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.cut
                }, null, 8 /* PROPS */, _hoisted_50)
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_49),
              _createElementVNode("button", {
                class: "cb-tb",
                onMousedown: _cache[30] || (_cache[30] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[31] || (_cache[31] = $event => (_ctx.clipCopy())),
                title: _ctx.t('Copy') + ' (Ctrl+C)'
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.copy
                }, null, 8 /* PROPS */, _hoisted_52)
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_51),
              _createElementVNode("button", {
                class: "cb-tb",
                onMousedown: _cache[32] || (_cache[32] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[33] || (_cache[33] = $event => (_ctx.clipPasteButton())),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Paste') + ' (Ctrl+V)'
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.paste
                }, null, 8 /* PROPS */, _hoisted_54)
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_53),
              _hoisted_55,
              _createElementVNode("select", {
                class: "tb-select tb-font",
                value: _ctx.fmtNow.font || '',
                onChange: _cache[34] || (_cache[34] = $event => (_ctx.setStyle('font', $event.target.value))),
                title: _ctx.t('Font'),
                disabled: _ctx.book.readOnly
              }, [
                _createElementVNode("option", _hoisted_57, _toDisplayString(_ctx.t('Default font')), 1 /* TEXT */),
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontChoices, (f) => {
                  return (_openBlock(), _createElementBlock("option", {
                    key: f,
                    value: f,
                    style: _normalizeStyle({ fontFamily: f })
                  }, _toDisplayString(f), 13 /* TEXT, STYLE, PROPS */, _hoisted_58))
                }), 128 /* KEYED_FRAGMENT */))
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_56),
              _createElementVNode("select", {
                class: "tb-select tb-size",
                value: _ctx.fmtNow.size || '',
                onChange: _cache[35] || (_cache[35] = $event => (_ctx.setStyle('size', $event.target.value ? Number($event.target.value) : ''))),
                title: _ctx.t('Size (pt)'),
                disabled: _ctx.book.readOnly
              }, [
                _createElementVNode("option", _hoisted_60, _toDisplayString(_ctx.settings.fontSize), 1 /* TEXT */),
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontSizes, (n) => {
                  return (_openBlock(), _createElementBlock("option", {
                    key: n,
                    value: n
                  }, _toDisplayString(n), 9 /* TEXT, PROPS */, _hoisted_61))
                }), 128 /* KEYED_FRAGMENT */))
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_59),
              _hoisted_62,
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.fmtNow.b }]),
                onMousedown: _cache[36] || (_cache[36] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[37] || (_cache[37] = $event => (_ctx.toggleStyle('b'))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Bold') + ' (Ctrl+B)'
              }, _hoisted_65, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_63),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.fmtNow.i }]),
                onMousedown: _cache[38] || (_cache[38] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[39] || (_cache[39] = $event => (_ctx.toggleStyle('i'))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Italic') + ' (Ctrl+I)'
              }, _hoisted_68, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_66),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.fmtNow.u }]),
                onMousedown: _cache[40] || (_cache[40] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[41] || (_cache[41] = $event => (_ctx.toggleStyle('u'))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Underline') + ' (Ctrl+U)'
              }, _hoisted_71, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_69),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.fmtNow.strike }]),
                onMousedown: _cache[42] || (_cache[42] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[43] || (_cache[43] = $event => (_ctx.toggleStyle('strike'))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Strikethrough')
              }, _hoisted_74, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_72),
              _createElementVNode("span", _hoisted_75, [
                _createElementVNode("label", {
                  class: "cb-tb",
                  title: _ctx.t('Text colour')
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.colour
                  }, null, 8 /* PROPS */, _hoisted_77),
                  _createElementVNode("span", {
                    class: "colour-bar",
                    style: _normalizeStyle({ background: _ctx.fmtNow.color || 'var(--sheet-ink)' })
                  }, null, 4 /* STYLE */),
                  _createElementVNode("input", {
                    type: "color",
                    value: _ctx.fmtNow.color || '#000000',
                    onInput: _cache[44] || (_cache[44] = $event => (_ctx.setStyle('color', $event.target.value))),
                    disabled: _ctx.book.readOnly
                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_78)
                ], 8 /* PROPS */, _hoisted_76),
                _createElementVNode("button", {
                  class: _normalizeClass(["cb-tb caret", { on: _ctx.menu === 'color' }]),
                  onMousedown: _cache[45] || (_cache[45] = _withModifiers(() => {}, ["prevent"])),
                  onClick: _cache[46] || (_cache[46] = $event => (_ctx.toggleMenu('color'))),
                  innerHTML: _ctx.icons.down,
                  title: _ctx.t('Text colour')
                }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_79),
                (_ctx.menu === 'color')
                  ? (_openBlock(), _createElementBlock("div", {
                      key: 0,
                      class: "cb-menu",
                      onMousedown: _cache[48] || (_cache[48] = _withModifiers(() => {}, ["prevent"]))
                    }, [
                      _createElementVNode("button", {
                        class: "cb-menu-item",
                        onClick: _cache[47] || (_cache[47] = $event => {_ctx.setStyle('color', ''); _ctx.menu = ''})
                      }, [
                        _hoisted_80,
                        _createTextVNode(_toDisplayString(_ctx.t('Automatic')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("div", _hoisted_81, [
                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.palette, (c) => {
                          return (_openBlock(), _createElementBlock("button", {
                            key: c,
                            class: _normalizeClass(["sw", { on: _ctx.fmtNow.color === c }]),
                            style: _normalizeStyle({ background: c }),
                            title: c,
                            onClick: $event => {_ctx.setStyle('color', c); _ctx.menu = ''}
                          }, null, 14 /* CLASS, STYLE, PROPS */, _hoisted_82))
                        }), 128 /* KEYED_FRAGMENT */))
                      ])
                    ], 32 /* NEED_HYDRATION */))
                  : _createCommentVNode("v-if", true)
              ]),
              _createElementVNode("span", _hoisted_83, [
                _createElementVNode("label", {
                  class: "cb-tb",
                  title: _ctx.t('Fill colour')
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.fill
                  }, null, 8 /* PROPS */, _hoisted_85),
                  _createElementVNode("span", {
                    class: "colour-bar",
                    style: _normalizeStyle({ background: _ctx.fmtNow.bg || 'transparent', border: _ctx.fmtNow.bg ? 'none' : '1px dashed var(--muted)' })
                  }, null, 4 /* STYLE */),
                  _createElementVNode("input", {
                    type: "color",
                    value: _ctx.fmtNow.bg || '#ffff00',
                    onInput: _cache[49] || (_cache[49] = $event => (_ctx.setStyle('bg', $event.target.value))),
                    disabled: _ctx.book.readOnly
                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_86)
                ], 8 /* PROPS */, _hoisted_84),
                _createElementVNode("button", {
                  class: _normalizeClass(["cb-tb caret", { on: _ctx.menu === 'bg' }]),
                  onMousedown: _cache[50] || (_cache[50] = _withModifiers(() => {}, ["prevent"])),
                  onClick: _cache[51] || (_cache[51] = $event => (_ctx.toggleMenu('bg'))),
                  innerHTML: _ctx.icons.down,
                  title: _ctx.t('Fill colour')
                }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_87),
                (_ctx.menu === 'bg')
                  ? (_openBlock(), _createElementBlock("div", {
                      key: 0,
                      class: "cb-menu",
                      onMousedown: _cache[53] || (_cache[53] = _withModifiers(() => {}, ["prevent"]))
                    }, [
                      _createElementVNode("button", {
                        class: "cb-menu-item",
                        onClick: _cache[52] || (_cache[52] = $event => {_ctx.setStyle('bg', ''); _ctx.menu = ''})
                      }, [
                        _hoisted_88,
                        _createTextVNode(_toDisplayString(_ctx.t('No fill')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("div", _hoisted_89, [
                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.palette, (c) => {
                          return (_openBlock(), _createElementBlock("button", {
                            key: c,
                            class: _normalizeClass(["sw", { on: _ctx.fmtNow.bg === c }]),
                            style: _normalizeStyle({ background: c }),
                            title: c,
                            onClick: $event => {_ctx.setStyle('bg', c); _ctx.menu = ''}
                          }, null, 14 /* CLASS, STYLE, PROPS */, _hoisted_90))
                        }), 128 /* KEYED_FRAGMENT */))
                      ])
                    ], 32 /* NEED_HYDRATION */))
                  : _createCommentVNode("v-if", true)
              ]),
              _createElementVNode("span", _hoisted_91, [
                _createElementVNode("button", {
                  class: _normalizeClass(["cb-tb", { on: _ctx.menu === 'borders' }]),
                  onMousedown: _cache[54] || (_cache[54] = _withModifiers(() => {}, ["prevent"])),
                  onClick: _cache[55] || (_cache[55] = $event => (_ctx.toggleMenu('borders'))),
                  disabled: _ctx.book.readOnly,
                  title: _ctx.t('Borders')
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.borders
                  }, null, 8 /* PROPS */, _hoisted_93),
                  _createElementVNode("span", {
                    class: "caret",
                    innerHTML: _ctx.icons.down
                  }, null, 8 /* PROPS */, _hoisted_94)
                ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_92),
                (_ctx.menu === 'borders')
                  ? (_openBlock(), _createElementBlock("div", {
                      key: 0,
                      class: "cb-menu",
                      onMousedown: _cache[57] || (_cache[57] = _withModifiers(() => {}, ["prevent"]))
                    }, [
                      _createElementVNode("div", _hoisted_95, [
                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.borderPresets, (p) => {
                          return (_openBlock(), _createElementBlock("button", {
                            key: p.key,
                            class: "bp",
                            onClick: $event => {_ctx.applyBorderPreset(p.key); _ctx.menu = ''},
                            title: p.label
                          }, [
                            _createElementVNode("span", {
                              class: _normalizeClass(["pic", p.key])
                            }, null, 2 /* CLASS */),
                            _createTextVNode(_toDisplayString(p.label), 1 /* TEXT */)
                          ], 8 /* PROPS */, _hoisted_96))
                        }), 128 /* KEYED_FRAGMENT */))
                      ]),
                      _hoisted_97,
                      _createElementVNode("button", {
                        class: "cb-menu-item",
                        onClick: _cache[56] || (_cache[56] = $event => {_ctx.menu = ''; _ctx.openCellProps('border')})
                      }, _toDisplayString(_ctx.t('More borders…')), 1 /* TEXT */)
                    ], 32 /* NEED_HYDRATION */))
                  : _createCommentVNode("v-if", true)
              ]),
              _hoisted_98,
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.fmtNow.ha === 'left' }]),
                onMousedown: _cache[58] || (_cache[58] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[59] || (_cache[59] = $event => (_ctx.setStyle('ha', _ctx.fmtNow.ha === 'left' ? '' : 'left'))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Align left'),
                innerHTML: _ctx.icons.alignL
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_99),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.fmtNow.ha === 'center' }]),
                onMousedown: _cache[60] || (_cache[60] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[61] || (_cache[61] = $event => (_ctx.setStyle('ha', _ctx.fmtNow.ha === 'center' ? '' : 'center'))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Centre'),
                innerHTML: _ctx.icons.alignC
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_100),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.fmtNow.ha === 'right' }]),
                onMousedown: _cache[62] || (_cache[62] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[63] || (_cache[63] = $event => (_ctx.setStyle('ha', _ctx.fmtNow.ha === 'right' ? '' : 'right'))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Align right'),
                innerHTML: _ctx.icons.alignR
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_101),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.fmtNow.va === 'top' }]),
                onMousedown: _cache[64] || (_cache[64] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[65] || (_cache[65] = $event => (_ctx.setStyle('va', _ctx.fmtNow.va === 'top' ? '' : 'top'))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Align top'),
                innerHTML: _ctx.icons.vTop
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_102),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.fmtNow.va === 'middle' }]),
                onMousedown: _cache[66] || (_cache[66] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[67] || (_cache[67] = $event => (_ctx.setStyle('va', _ctx.fmtNow.va === 'middle' ? '' : 'middle'))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Centre vertically'),
                innerHTML: _ctx.icons.vMid
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_103),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.fmtNow.va === 'bottom' }]),
                onMousedown: _cache[68] || (_cache[68] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[69] || (_cache[69] = $event => (_ctx.setStyle('va', ''))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Align bottom'),
                innerHTML: _ctx.icons.vBot
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_104),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.fmtNow.wrap }]),
                onMousedown: _cache[70] || (_cache[70] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[71] || (_cache[71] = $event => (_ctx.toggleStyle('wrap'))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Wrap text'),
                innerHTML: _ctx.icons.wrap
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_105),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.selIsMerged }]),
                onMousedown: _cache[72] || (_cache[72] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[73] || (_cache[73] = (...args) => (_ctx.toggleMerge && _ctx.toggleMerge(...args))),
                disabled: _ctx.book.readOnly,
                title: _ctx.selIsMerged ? _ctx.t('Unmerge cells') : _ctx.t('Merge cells'),
                innerHTML: _ctx.icons.merge
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_106),
              _hoisted_107,
              _createElementVNode("span", _hoisted_108, [
                _createElementVNode("button", {
                  class: _normalizeClass(["cb-tb text", { on: _ctx.menu === 'numfmt' }]),
                  onMousedown: _cache[74] || (_cache[74] = _withModifiers(() => {}, ["prevent"])),
                  onClick: _cache[75] || (_cache[75] = $event => (_ctx.toggleMenu('numfmt'))),
                  disabled: _ctx.book.readOnly,
                  title: _ctx.t('Number format')
                }, [
                  _createElementVNode("span", _hoisted_110, _toDisplayString(_ctx.numFmtLabel), 1 /* TEXT */),
                  _createElementVNode("span", {
                    class: "caret",
                    innerHTML: _ctx.icons.down
                  }, null, 8 /* PROPS */, _hoisted_111)
                ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_109),
                (_ctx.menu === 'numfmt')
                  ? (_openBlock(), _createElementBlock("div", {
                      key: 0,
                      class: "cb-menu wide",
                      onMousedown: _cache[77] || (_cache[77] = _withModifiers(() => {}, ["prevent"]))
                    }, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.numFormats, (nf) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: nf.code,
                          class: _normalizeClass(["cb-menu-item", { on: (_ctx.fmtNow.fmt || 'General') === nf.code }]),
                          onClick: $event => {_ctx.setFmt(nf.code); _ctx.menu = ''}
                        }, [
                          _createElementVNode("span", null, _toDisplayString(nf.label), 1 /* TEXT */),
                          _createElementVNode("span", _hoisted_113, _toDisplayString(nf.sample), 1 /* TEXT */)
                        ], 10 /* CLASS, PROPS */, _hoisted_112))
                      }), 128 /* KEYED_FRAGMENT */)),
                      _hoisted_114,
                      _createElementVNode("button", {
                        class: "cb-menu-item",
                        onClick: _cache[76] || (_cache[76] = $event => {_ctx.menu = ''; _ctx.openCellProps('number')})
                      }, _toDisplayString(_ctx.t('More formats…')), 1 /* TEXT */)
                    ], 32 /* NEED_HYDRATION */))
                  : _createCommentVNode("v-if", true)
              ]),
              _createElementVNode("button", {
                class: "cb-tb",
                onMousedown: _cache[78] || (_cache[78] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[79] || (_cache[79] = $event => (_ctx.setFmt('0%'))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Percent'),
                innerHTML: _ctx.icons.percent
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_115),
              _createElementVNode("button", {
                class: "cb-tb",
                onMousedown: _cache[80] || (_cache[80] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[81] || (_cache[81] = $event => (_ctx.stepDec(1))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Add a decimal place'),
                innerHTML: _ctx.icons.dec0
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_116),
              _createElementVNode("button", {
                class: "cb-tb",
                onMousedown: _cache[82] || (_cache[82] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[83] || (_cache[83] = $event => (_ctx.stepDec(-1))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Remove a decimal place'),
                innerHTML: _ctx.icons.dec1
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_117),
              _hoisted_118,
              _createElementVNode("span", _hoisted_119, [
                _createElementVNode("button", {
                  class: _normalizeClass(["cb-tb", { on: _ctx.menu === 'rows' }]),
                  onMousedown: _cache[84] || (_cache[84] = _withModifiers(() => {}, ["prevent"])),
                  onClick: _cache[85] || (_cache[85] = $event => (_ctx.toggleMenu('rows'))),
                  disabled: _ctx.book.readOnly,
                  title: _ctx.t('Rows and columns')
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.rows
                  }, null, 8 /* PROPS */, _hoisted_121),
                  _createElementVNode("span", {
                    class: "caret",
                    innerHTML: _ctx.icons.down
                  }, null, 8 /* PROPS */, _hoisted_122)
                ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_120),
                (_ctx.menu === 'rows')
                  ? (_openBlock(), _createElementBlock("div", {
                      key: 0,
                      class: "cb-menu wide",
                      onMousedown: _cache[94] || (_cache[94] = _withModifiers(() => {}, ["prevent"]))
                    }, [
                      _createElementVNode("button", {
                        class: "cb-menu-item",
                        onClick: _cache[86] || (_cache[86] = $event => {_ctx.insertRows(0); _ctx.menu = ''})
                      }, _toDisplayString(_ctx.t('Insert rows above')), 1 /* TEXT */),
                      _createElementVNode("button", {
                        class: "cb-menu-item",
                        onClick: _cache[87] || (_cache[87] = $event => {_ctx.insertRows(1); _ctx.menu = ''})
                      }, _toDisplayString(_ctx.t('Insert rows below')), 1 /* TEXT */),
                      _createElementVNode("button", {
                        class: "cb-menu-item",
                        onClick: _cache[88] || (_cache[88] = $event => {_ctx.deleteRows(); _ctx.menu = ''})
                      }, _toDisplayString(_ctx.t('Delete rows')), 1 /* TEXT */),
                      _hoisted_123,
                      _createElementVNode("button", {
                        class: "cb-menu-item",
                        onClick: _cache[89] || (_cache[89] = $event => {_ctx.insertCols(0); _ctx.menu = ''})
                      }, _toDisplayString(_ctx.t('Insert columns before')), 1 /* TEXT */),
                      _createElementVNode("button", {
                        class: "cb-menu-item",
                        onClick: _cache[90] || (_cache[90] = $event => {_ctx.insertCols(1); _ctx.menu = ''})
                      }, _toDisplayString(_ctx.t('Insert columns after')), 1 /* TEXT */),
                      _createElementVNode("button", {
                        class: "cb-menu-item",
                        onClick: _cache[91] || (_cache[91] = $event => {_ctx.deleteCols(); _ctx.menu = ''})
                      }, _toDisplayString(_ctx.t('Delete columns')), 1 /* TEXT */),
                      _hoisted_124,
                      _createElementVNode("button", {
                        class: "cb-menu-item",
                        onClick: _cache[92] || (_cache[92] = $event => {_ctx.askRowHeight(); _ctx.menu = ''})
                      }, _toDisplayString(_ctx.t('Row height…')), 1 /* TEXT */),
                      _createElementVNode("button", {
                        class: "cb-menu-item",
                        onClick: _cache[93] || (_cache[93] = $event => {_ctx.askColWidth(); _ctx.menu = ''})
                      }, _toDisplayString(_ctx.t('Column width…')), 1 /* TEXT */)
                    ], 32 /* NEED_HYDRATION */))
                  : _createCommentVNode("v-if", true)
              ]),
              _createElementVNode("button", {
                class: "cb-tb",
                onMousedown: _cache[95] || (_cache[95] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[96] || (_cache[96] = $event => (_ctx.sortSel(1))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Sort ascending'),
                innerHTML: _ctx.icons.sortAZ
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_125),
              _createElementVNode("button", {
                class: "cb-tb",
                onMousedown: _cache[97] || (_cache[97] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[98] || (_cache[98] = $event => (_ctx.sortSel(-1))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Sort descending'),
                innerHTML: _ctx.icons.sortZA
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_126),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.hasFilter }]),
                onMousedown: _cache[99] || (_cache[99] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[100] || (_cache[100] = (...args) => (_ctx.toggleFilter && _ctx.toggleFilter(...args))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('AutoFilter'),
                innerHTML: _ctx.icons.filter
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_127),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.hasFreeze }]),
                onMousedown: _cache[101] || (_cache[101] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[102] || (_cache[102] = (...args) => (_ctx.toggleFreeze && _ctx.toggleFreeze(...args))),
                disabled: _ctx.book.readOnly,
                title: _ctx.hasFreeze ? _ctx.t('Unfreeze rows and columns') : _ctx.t('Freeze rows and columns at the cursor'),
                innerHTML: _ctx.icons.freeze
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_128),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: !_ctx.gridOn }]),
                onMousedown: _cache[103] || (_cache[103] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[104] || (_cache[104] = (...args) => (_ctx.toggleGrid && _ctx.toggleGrid(...args))),
                disabled: _ctx.book.readOnly,
                title: _ctx.gridOn ? _ctx.t('Hide gridlines') : _ctx.t('Show gridlines'),
                innerHTML: _ctx.icons.table
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_129),
              _hoisted_130,
              _createElementVNode("button", {
                class: "cb-tb",
                onMousedown: _cache[105] || (_cache[105] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[106] || (_cache[106] = (...args) => (_ctx.openFx && _ctx.openFx(...args))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Insert function…'),
                innerHTML: _ctx.icons.fx
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_131),
              _createElementVNode("button", {
                class: _normalizeClass(["cb-tb", { on: _ctx.find.open }]),
                onMousedown: _cache[107] || (_cache[107] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[108] || (_cache[108] = $event => (_ctx.toggleFind())),
                title: _ctx.t('Find and replace') + ' (Ctrl+F)',
                innerHTML: _ctx.icons.search
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_132),
              _createElementVNode("button", {
                class: "cb-tb",
                onMousedown: _cache[109] || (_cache[109] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[110] || (_cache[110] = $event => (_ctx.openCellProps('number'))),
                disabled: _ctx.book.readOnly,
                title: _ctx.t('Cell properties…'),
                innerHTML: _ctx.icons.settings
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_133)
            ]))
          : _createCommentVNode("v-if", true)
      ]),
      (_ctx.book.id)
        ? (_openBlock(), _createElementBlock("div", _hoisted_134, [
            _createElementVNode("div", _hoisted_135, [
              _createCommentVNode(" the formula bar "),
              _createElementVNode("div", _hoisted_136, [
                _createElementVNode("input", {
                  class: "namebox",
                  value: _ctx.nameBoxText,
                  onKeydown: [
                    _cache[111] || (_cache[111] = _withKeys(_withModifiers($event => {_ctx.goToName($event.target.value); $event.target.blur()}, ["prevent"]), ["enter"])),
                    _cache[112] || (_cache[112] = _withKeys(_withModifiers($event => {$event.target.value = _ctx.nameBoxText; $event.target.blur()}, ["prevent"]), ["esc"]))
                  ],
                  onFocus: _cache[113] || (_cache[113] = $event => ($event.target.select())),
                  title: _ctx.t('Name box: the cell or range, or type an address to go there'),
                  spellcheck: "false"
                }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_137),
                _createElementVNode("button", {
                  class: "cb-tb fx",
                  onMousedown: _cache[114] || (_cache[114] = _withModifiers(() => {}, ["prevent"])),
                  onClick: _cache[115] || (_cache[115] = (...args) => (_ctx.openFx && _ctx.openFx(...args))),
                  title: _ctx.t('Insert function…'),
                  disabled: _ctx.book.readOnly
                }, "fx", 40 /* PROPS, NEED_HYDRATION */, _hoisted_138),
                (_ctx.edit.on)
                  ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                      _createElementVNode("button", {
                        class: "cb-tb no",
                        onMousedown: _cache[116] || (_cache[116] = _withModifiers(() => {}, ["prevent"])),
                        onClick: _cache[117] || (_cache[117] = (...args) => (_ctx.cancelEdit && _ctx.cancelEdit(...args))),
                        title: _ctx.t('Cancel')
                      }, "✕", 40 /* PROPS, NEED_HYDRATION */, _hoisted_139),
                      _createElementVNode("button", {
                        class: "cb-tb ok",
                        onMousedown: _cache[118] || (_cache[118] = _withModifiers(() => {}, ["prevent"])),
                        onClick: _cache[119] || (_cache[119] = $event => (_ctx.commitEdit())),
                        title: _ctx.t('Accept')
                      }, "✓", 40 /* PROPS, NEED_HYDRATION */, _hoisted_140)
                    ], 64 /* STABLE_FRAGMENT */))
                  : _createCommentVNode("v-if", true),
                _createElementVNode("textarea", {
                  class: _normalizeClass(["finput", { tall: _ctx.fbarFocused }]),
                  ref: "finput",
                  rows: "1",
                  value: _ctx.fbarText,
                  disabled: _ctx.book.readOnly,
                  spellcheck: "false",
                  autocomplete: "off",
                  onFocus: _cache[120] || (_cache[120] = (...args) => (_ctx.fbarFocus && _ctx.fbarFocus(...args))),
                  onBlur: _cache[121] || (_cache[121] = $event => (_ctx.fbarFocused = false)),
                  onInput: _cache[122] || (_cache[122] = $event => (_ctx.fbarInput($event))),
                  onKeydown: _cache[123] || (_cache[123] = $event => (_ctx.fbarKey($event))),
                  onClick: _cache[124] || (_cache[124] = $event => (_ctx.caretMoved($event.target))),
                  onKeyup: _cache[125] || (_cache[125] = $event => (_ctx.caretMoved($event.target))),
                  placeholder: _ctx.t('Type here, or in the cell')
                }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_141)
              ]),
              _createCommentVNode(" find and replace "),
              (_ctx.find.open)
                ? (_openBlock(), _createElementBlock("div", _hoisted_142, [
                    _createElementVNode("span", {
                      class: "ic",
                      innerHTML: _ctx.icons.search
                    }, null, 8 /* PROPS */, _hoisted_143),
                    _withDirectives(_createElementVNode("input", {
                      ref: "findInput",
                      type: "text",
                      "onUpdate:modelValue": _cache[126] || (_cache[126] = $event => ((_ctx.find.query) = $event)),
                      placeholder: _ctx.t('Find'),
                      onInput: _cache[127] || (_cache[127] = $event => (_ctx.runFind())),
                      onKeydown: [
                        _cache[128] || (_cache[128] = _withKeys(_withModifiers($event => (_ctx.findNext($event.shiftKey ? -1 : 1)), ["prevent"]), ["enter"])),
                        _cache[129] || (_cache[129] = _withKeys(_withModifiers($event => (_ctx.toggleFind(false)), ["prevent"]), ["esc"]))
                      ]
                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_144), [
                      [_vModelText, _ctx.find.query]
                    ]),
                    _createElementVNode("span", _hoisted_145, _toDisplayString(_ctx.find.hits.length ? (_ctx.find.index + 1) + ' / ' + _ctx.find.hits.length : _ctx.t('none')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "cb-tb",
                      onMousedown: _cache[130] || (_cache[130] = _withModifiers(() => {}, ["prevent"])),
                      onClick: _cache[131] || (_cache[131] = $event => (_ctx.findNext(-1))),
                      title: _ctx.t('Previous')
                    }, "↑", 40 /* PROPS, NEED_HYDRATION */, _hoisted_146),
                    _createElementVNode("button", {
                      class: "cb-tb",
                      onMousedown: _cache[132] || (_cache[132] = _withModifiers(() => {}, ["prevent"])),
                      onClick: _cache[133] || (_cache[133] = $event => (_ctx.findNext(1))),
                      title: _ctx.t('Next')
                    }, "↓", 40 /* PROPS, NEED_HYDRATION */, _hoisted_147),
                    _createElementVNode("label", _hoisted_148, [
                      _withDirectives(_createElementVNode("input", {
                        type: "checkbox",
                        "onUpdate:modelValue": _cache[134] || (_cache[134] = $event => ((_ctx.find.caseSensitive) = $event)),
                        onChange: _cache[135] || (_cache[135] = $event => (_ctx.runFind()))
                      }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                        [_vModelCheckbox, _ctx.find.caseSensitive]
                      ]),
                      _createTextVNode(" " + _toDisplayString(_ctx.t('Match case')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("label", _hoisted_149, [
                      _withDirectives(_createElementVNode("input", {
                        type: "checkbox",
                        "onUpdate:modelValue": _cache[136] || (_cache[136] = $event => ((_ctx.find.formulas) = $event)),
                        onChange: _cache[137] || (_cache[137] = $event => (_ctx.runFind()))
                      }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                        [_vModelCheckbox, _ctx.find.formulas]
                      ]),
                      _createTextVNode(" " + _toDisplayString(_ctx.t('In formulas')), 1 /* TEXT */)
                    ]),
                    _hoisted_150,
                    _withDirectives(_createElementVNode("input", {
                      type: "text",
                      "onUpdate:modelValue": _cache[138] || (_cache[138] = $event => ((_ctx.find.replace) = $event)),
                      placeholder: _ctx.t('Replace with'),
                      onKeydown: _cache[139] || (_cache[139] = _withKeys(_withModifiers((...args) => (_ctx.replaceOne && _ctx.replaceOne(...args)), ["prevent"]), ["enter"])),
                      disabled: _ctx.book.readOnly
                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_151), [
                      [_vModelText, _ctx.find.replace]
                    ]),
                    _createElementVNode("button", {
                      class: "cb-btn",
                      onMousedown: _cache[140] || (_cache[140] = _withModifiers(() => {}, ["prevent"])),
                      onClick: _cache[141] || (_cache[141] = (...args) => (_ctx.replaceOne && _ctx.replaceOne(...args))),
                      disabled: !_ctx.find.hits.length || _ctx.book.readOnly
                    }, _toDisplayString(_ctx.t('Replace')), 41 /* TEXT, PROPS, NEED_HYDRATION */, _hoisted_152),
                    _createElementVNode("button", {
                      class: "cb-btn",
                      onMousedown: _cache[142] || (_cache[142] = _withModifiers(() => {}, ["prevent"])),
                      onClick: _cache[143] || (_cache[143] = (...args) => (_ctx.replaceAll && _ctx.replaceAll(...args))),
                      disabled: !_ctx.find.hits.length || _ctx.book.readOnly
                    }, _toDisplayString(_ctx.t('Replace all')), 41 /* TEXT, PROPS, NEED_HYDRATION */, _hoisted_153),
                    _createElementVNode("button", {
                      class: "cb-tb",
                      onClick: _cache[144] || (_cache[144] = $event => (_ctx.toggleFind(false))),
                      title: _ctx.t('Close')
                    }, [
                      _createElementVNode("span", {
                        innerHTML: _ctx.icons.close
                      }, null, 8 /* PROPS */, _hoisted_155)
                    ], 8 /* PROPS */, _hoisted_154)
                  ]))
                : _createCommentVNode("v-if", true),
              _createCommentVNode(" the grid: drawn by hand into .cb-layers (see paint()) "),
              _createElementVNode("div", {
                class: _normalizeClass(["cb-gridwrap", { nogrid: !_ctx.gridOn }]),
                ref: "gridwrap",
                tabindex: "-1",
                onMousedown: _cache[157] || (_cache[157] = $event => (_ctx.gridMouseDown($event))),
                onDblclick: _cache[158] || (_cache[158] = $event => (_ctx.gridDblClick($event))),
                onWheel: _cache[159] || (_cache[159] = $event => (_ctx.gridWheel($event))),
                onTouchstartPassive: _cache[160] || (_cache[160] = $event => (_ctx.gridTouchStart($event))),
                onTouchend: _cache[161] || (_cache[161] = $event => (_ctx.gridTouchEnd($event))),
                onTouchmovePassive: _cache[162] || (_cache[162] = $event => (_ctx.gridTouchMove($event)))
              }, [
                _createElementVNode("div", {
                  class: "cb-scroller",
                  ref: "scroller",
                  onScrollPassive: _cache[155] || (_cache[155] = (...args) => (_ctx.onScroll && _ctx.onScroll(...args)))
                }, [
                  _createElementVNode("div", _hoisted_156, [
                    _createElementVNode("div", _hoisted_157, null, 512 /* NEED_PATCH */),
                    _createElementVNode("textarea", {
                      ref: "editor",
                      class: _normalizeClass(["cb-editor", { wrap: _ctx.edit.wrap, idle: !_ctx.edit.on }]),
                      style: _normalizeStyle(_ctx.edit.style),
                      spellcheck: "false",
                      autocomplete: "off",
                      autocapitalize: "off",
                      "aria-label": "cell",
                      onInput: _cache[145] || (_cache[145] = $event => (_ctx.editorInput($event))),
                      onKeydown: _cache[146] || (_cache[146] = $event => (_ctx.gridKey($event))),
                      onClick: _cache[147] || (_cache[147] = $event => (_ctx.caretMoved($event.target))),
                      onKeyup: _cache[148] || (_cache[148] = $event => (_ctx.caretMoved($event.target))),
                      onBlur: _cache[149] || (_cache[149] = $event => (_ctx.editorBlur($event))),
                      onPaste: _cache[150] || (_cache[150] = $event => (_ctx.onPaste($event))),
                      onCopy: _cache[151] || (_cache[151] = $event => (_ctx.onCopy($event))),
                      onCut: _cache[152] || (_cache[152] = $event => (_ctx.onCut($event))),
                      onCompositionstart: _cache[153] || (_cache[153] = $event => (_ctx.composing = true)),
                      onCompositionend: _cache[154] || (_cache[154] = $event => {_ctx.composing = false; _ctx.editorInput($event)})
                    }, null, 38 /* CLASS, STYLE, NEED_HYDRATION */)
                  ], 512 /* NEED_PATCH */),
                  _createElementVNode("div", _hoisted_158, null, 512 /* NEED_PATCH */)
                ], 544 /* NEED_HYDRATION, NEED_PATCH */),
                (_ctx.edit.on && (_ctx.edit.hints.length || _ctx.edit.sig))
                  ? (_openBlock(), _createElementBlock("div", {
                      key: 0,
                      class: "cb-hints",
                      style: _normalizeStyle(_ctx.hintsStyle)
                    }, [
                      (_ctx.edit.hints.length)
                        ? (_openBlock(true), _createElementBlock(_Fragment, { key: 0 }, _renderList(_ctx.edit.hints, (h, i) => {
                            return (_openBlock(), _createElementBlock("button", {
                              key: h.name,
                              class: _normalizeClass(["hint-item", { on: i === _ctx.edit.hintIdx }]),
                              onMousedown: _cache[156] || (_cache[156] = _withModifiers(() => {}, ["prevent"])),
                              onClick: $event => (_ctx.takeHint(h))
                            }, [
                              _createElementVNode("b", null, _toDisplayString(h.name) + "(" + _toDisplayString(h.args) + ")", 1 /* TEXT */),
                              _createElementVNode("span", _hoisted_160, _toDisplayString(_ctx.t(h.description)), 1 /* TEXT */)
                            ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_159))
                          }), 128 /* KEYED_FRAGMENT */))
                        : (_ctx.edit.sig)
                          ? (_openBlock(), _createElementBlock("div", {
                              key: 1,
                              class: "sig",
                              innerHTML: _ctx.sigHtml
                            }, null, 8 /* PROPS */, _hoisted_161))
                          : _createCommentVNode("v-if", true)
                    ], 4 /* STYLE */))
                  : _createCommentVNode("v-if", true)
              ], 34 /* CLASS, NEED_HYDRATION */),
              _createCommentVNode(" sheet tabs "),
              _createElementVNode("div", _hoisted_162, [
                _createElementVNode("button", {
                  class: "cb-tb add",
                  onClick: _cache[163] || (_cache[163] = $event => (_ctx.addSheet())),
                  disabled: _ctx.book.readOnly,
                  title: _ctx.t('Insert sheet')
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.plus
                  }, null, 8 /* PROPS */, _hoisted_164)
                ], 8 /* PROPS */, _hoisted_163),
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.sheetNames, (name, i) => {
                  return (_openBlock(), _createElementBlock(_Fragment, {
                    key: i + ':' + name
                  }, [
                    (_ctx.renameSheet.idx === i)
                      ? _withDirectives((_openBlock(), _createElementBlock("input", {
                          key: 0,
                          class: "rename-input",
                          ref_for: true,
                          ref: "renameInput",
                          "onUpdate:modelValue": _cache[164] || (_cache[164] = $event => ((_ctx.renameSheet.text) = $event)),
                          onKeydown: [
                            _cache[165] || (_cache[165] = _withKeys(_withModifiers((...args) => (_ctx.finishRenameSheet && _ctx.finishRenameSheet(...args)), ["prevent"]), ["enter"])),
                            _cache[166] || (_cache[166] = _withKeys(_withModifiers($event => (_ctx.renameSheet.idx = -1), ["prevent"]), ["esc"]))
                          ],
                          onBlur: _cache[167] || (_cache[167] = (...args) => (_ctx.finishRenameSheet && _ctx.finishRenameSheet(...args))),
                          maxlength: "60"
                        }, null, 544 /* NEED_HYDRATION, NEED_PATCH */)), [
                          [_vModelText, _ctx.renameSheet.text]
                        ])
                      : (_openBlock(), _createElementBlock("button", {
                          key: 1,
                          class: _normalizeClass(["tab", { active: i === _ctx.active }]),
                          onClick: $event => (_ctx.switchSheet(i)),
                          onDblclick: $event => (_ctx.startRenameSheet(i)),
                          onContextmenu: _withModifiers($event => (_ctx.sheetCtx($event, i)), ["prevent","stop"])
                        }, _toDisplayString(name), 43 /* TEXT, CLASS, PROPS, NEED_HYDRATION */, _hoisted_165))
                  ], 64 /* STABLE_FRAGMENT */))
                }), 128 /* KEYED_FRAGMENT */))
              ]),
              _createCommentVNode(" status bar "),
              _createElementVNode("div", _hoisted_166, [
                _createElementVNode("span", _hoisted_167, [
                  _createTextVNode(_toDisplayString(_ctx.t('Sheet {n} of {total}', { n: _ctx.active + 1, total: _ctx.sheetNames.length })), 1 /* TEXT */),
                  (_ctx.selCount > 1)
                    ? (_openBlock(), _createElementBlock("span", _hoisted_168, " · " + _toDisplayString(_ctx.t('{n} cells selected', { n: _ctx.selCount })), 1 /* TEXT */))
                    : _createCommentVNode("v-if", true)
                ]),
                (_ctx.stats.count)
                  ? (_openBlock(), _createElementBlock("span", _hoisted_169, [
                      _createElementVNode("b", null, _toDisplayString(_ctx.t('Sum')) + ":", 1 /* TEXT */),
                      _createTextVNode(" " + _toDisplayString(_ctx.stats.sum), 1 /* TEXT */)
                    ]))
                  : _createCommentVNode("v-if", true),
                (_ctx.stats.count)
                  ? (_openBlock(), _createElementBlock("span", _hoisted_170, [
                      _createElementVNode("b", null, _toDisplayString(_ctx.t('Average')) + ":", 1 /* TEXT */),
                      _createTextVNode(" " + _toDisplayString(_ctx.stats.avg), 1 /* TEXT */)
                    ]))
                  : _createCommentVNode("v-if", true),
                (_ctx.stats.count)
                  ? (_openBlock(), _createElementBlock("span", _hoisted_171, [
                      _createElementVNode("b", null, _toDisplayString(_ctx.t('Count')) + ":", 1 /* TEXT */),
                      _createTextVNode(" " + _toDisplayString(_ctx.stats.count), 1 /* TEXT */)
                    ]))
                  : _createCommentVNode("v-if", true)
              ])
            ]),
            _createCommentVNode(" the AI assistant (through AI-Hub) -- the same column as the other Base apps "),
            (_ctx.ai.show && _ctx.ai.open)
              ? (_openBlock(), _createElementBlock("aside", {
                  key: 0,
                  class: "ai-col",
                  style: _normalizeStyle({ flex: '0 0 ' + _ctx.aiWidth(), width: _ctx.aiWidth() })
                }, [
                  _createElementVNode("div", _hoisted_172, [
                    _createElementVNode("span", _hoisted_173, _toDisplayString(_ctx.t('AI assistant')), 1 /* TEXT */),
                    _createElementVNode("span", _hoisted_174, _toDisplayString(_ctx.t('CalcBase only')), 1 /* TEXT */),
                    _hoisted_175,
                    (_ctx.ai.model)
                      ? (_openBlock(), _createElementBlock("span", {
                          key: 0,
                          class: "ai-model",
                          title: _ctx.ai.model
                        }, _toDisplayString(_ctx.ai.model), 9 /* TEXT, PROPS */, _hoisted_176))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("button", {
                      type: "button",
                      class: "cb-btn xs",
                      disabled: _ctx.ai.busy,
                      title: _ctx.t('New conversation'),
                      onClick: _cache[168] || (_cache[168] = (...args) => (_ctx.aiClear && _ctx.aiClear(...args)))
                    }, "＋ " + _toDisplayString(_ctx.t('New conversation')), 9 /* TEXT, PROPS */, _hoisted_177),
                    _createElementVNode("button", {
                      type: "button",
                      class: "hnd",
                      title: _ctx.t('Hide') + ' — ' + _ctx.t('AI assistant'),
                      "aria-label": _ctx.t('Hide') + ' — ' + _ctx.t('AI assistant'),
                      onClick: _cache[169] || (_cache[169] = (...args) => (_ctx.aiToggle && _ctx.aiToggle(...args)))
                    }, _toDisplayString(_ctx.narrow ? '▼' : '▶'), 9 /* TEXT, PROPS */, _hoisted_178)
                  ]),
                  _createElementVNode("div", _hoisted_179, [
                    (!_ctx.ai.msgs.length)
                      ? (_openBlock(), _createElementBlock("p", _hoisted_180, _toDisplayString(_ctx.t('Ask how to do something in CalcBase, or say what to change in this book: the assistant can write into cells.')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.ai.msgs, (m, i) => {
                      return (_openBlock(), _createElementBlock("div", {
                        class: _normalizeClass(["ai-msg", m.role]),
                        key: i
                      }, [
                        _createElementVNode("div", {
                          class: "ai-bubble",
                          innerHTML: _ctx.aiHtml(m)
                        }, null, 8 /* PROPS */, _hoisted_181),
                        (m.did)
                          ? (_openBlock(), _createElementBlock("div", _hoisted_182, _toDisplayString(m.did), 1 /* TEXT */))
                          : _createCommentVNode("v-if", true)
                      ], 2 /* CLASS */))
                    }), 128 /* KEYED_FRAGMENT */)),
                    (_ctx.ai.busy)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_183, [
                          _createElementVNode("div", _hoisted_184, _toDisplayString(_ctx.t('Thinking…')), 1 /* TEXT */)
                        ]))
                      : _createCommentVNode("v-if", true),
                    (_ctx.ai.error)
                      ? (_openBlock(), _createElementBlock("p", _hoisted_185, _toDisplayString(_ctx.ai.error), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ], 512 /* NEED_PATCH */),
                  _createElementVNode("div", _hoisted_186, [
                    _withDirectives(_createElementVNode("textarea", {
                      "onUpdate:modelValue": _cache[170] || (_cache[170] = $event => ((_ctx.ai.input) = $event)),
                      rows: "2",
                      placeholder: _ctx.ai.ready ? _ctx.t('Message to the assistant…') : _ctx.aiNotReady(),
                      disabled: !_ctx.ai.ready,
                      onKeydown: _cache[171] || (_cache[171] = $event => (_ctx.aiKey($event))),
                      onCompositionstart: _cache[172] || (_cache[172] = $event => (_ctx.ai.composing = true)),
                      onCompositionend: _cache[173] || (_cache[173] = $event => (_ctx.ai.composing = false))
                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_187), [
                      [_vModelText, _ctx.ai.input]
                    ]),
                    _createElementVNode("button", {
                      class: "cb-btn primary",
                      onClick: _cache[174] || (_cache[174] = (...args) => (_ctx.aiSend && _ctx.aiSend(...args))),
                      disabled: _ctx.ai.busy || !_ctx.ai.ready || !_ctx.ai.input.trim()
                    }, _toDisplayString(_ctx.t('Send')), 9 /* TEXT, PROPS */, _hoisted_188)
                  ])
                ], 4 /* STYLE */))
              : _createCommentVNode("v-if", true),
            (_ctx.ai.show && !_ctx.ai.open)
              ? (_openBlock(), _createElementBlock("div", _hoisted_189, [
                  _createElementVNode("button", {
                    type: "button",
                    class: "hnd",
                    title: _ctx.t('Show') + ' — ' + _ctx.t('AI assistant'),
                    "aria-label": _ctx.t('Show') + ' — ' + _ctx.t('AI assistant'),
                    onClick: _cache[175] || (_cache[175] = (...args) => (_ctx.aiToggle && _ctx.aiToggle(...args)))
                  }, _toDisplayString(_ctx.narrow ? '▲' : '◀'), 9 /* TEXT, PROPS */, _hoisted_190),
                  _createElementVNode("span", _hoisted_191, _toDisplayString(_ctx.t('AI assistant')), 1 /* TEXT */)
                ]))
              : _createCommentVNode("v-if", true)
          ]))
        : (_openBlock(), _createElementBlock("div", _hoisted_192, [
            _createElementVNode("span", {
              class: "mark",
              innerHTML: _ctx.logo
            }, null, 8 /* PROPS */, _hoisted_193),
            _createElementVNode("p", null, _toDisplayString(_ctx.books.length ? _ctx.t('Choose a book on the left, or make a new one.') : _ctx.t('Make your first book with “New book”.')), 1 /* TEXT */),
            _createElementVNode("button", {
              class: "cb-btn primary",
              onClick: _cache[176] || (_cache[176] = (...args) => (_ctx.newBook && _ctx.newBook(...args)))
            }, "＋ " + _toDisplayString(_ctx.t('New book')), 1 /* TEXT */)
          ]))
    ]),
    _createCommentVNode(" ===== dialogs ===== "),
    (_ctx.settingsOpen)
      ? (_openBlock(), _createElementBlock("div", _hoisted_194, [
          _createElementVNode("div", {
            class: "cb-modal cb-settings",
            onClick: _cache[193] || (_cache[193] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("div", _hoisted_195, [
              _hoisted_196,
              _createElementVNode("div", null, [
                _createElementVNode("strong", null, _toDisplayString(_ctx.t('Settings')), 1 /* TEXT */),
                _createElementVNode("div", _hoisted_197, _toDisplayString(_ctx.t('Applies to CalcBase only, for your account.')), 1 /* TEXT */)
              ]),
              _createElementVNode("button", {
                type: "button",
                class: "set-close",
                title: _ctx.t('Close'),
                "aria-label": _ctx.t('Close'),
                onClick: _cache[177] || (_cache[177] = $event => (_ctx.cancelSettings()))
              }, _hoisted_200, 8 /* PROPS */, _hoisted_198)
            ]),
            _createElementVNode("div", _hoisted_201, [
              _createElementVNode("div", _hoisted_202, [
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.settingTabs, (tb) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: tb.key,
                    type: "button",
                    class: _normalizeClass(["set-tab", { active: _ctx.setTab === tb.key }]),
                    role: "tab",
                    "aria-selected": _ctx.setTab === tb.key ? 'true' : 'false',
                    title: tb.label,
                    onClick: $event => (_ctx.setTab = tb.key)
                  }, [
                    _createElementVNode("span", _hoisted_204, _toDisplayString(tb.icon), 1 /* TEXT */),
                    _createTextVNode(_toDisplayString(tb.label), 1 /* TEXT */)
                  ], 10 /* CLASS, PROPS */, _hoisted_203))
                }), 128 /* KEYED_FRAGMENT */))
              ]),
              _withDirectives(_createElementVNode("section", _hoisted_205, [
                _createElementVNode("h3", null, [
                  _hoisted_206,
                  _createTextVNode(_toDisplayString(_ctx.t('Appearance and language')), 1 /* TEXT */)
                ]),
                _createElementVNode("div", _hoisted_207, [
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.themeOptions, (opt) => {
                    return (_openBlock(), _createElementBlock("button", {
                      key: opt.id,
                      type: "button",
                      class: _normalizeClass(["theme-pick", { active: _ctx.settings.theme === opt.id }]),
                      onClick: $event => (_ctx.pickTheme(opt.id))
                    }, [
                      _createElementVNode("span", {
                        class: _normalizeClass(["swatch", opt.id])
                      }, _hoisted_212, 2 /* CLASS */),
                      _createElementVNode("strong", null, _toDisplayString(_ctx.t(opt.label)), 1 /* TEXT */),
                      _createElementVNode("span", _hoisted_213, _toDisplayString(_ctx.t(opt.hint)), 1 /* TEXT */),
                      (_ctx.settings.theme === opt.id)
                        ? (_openBlock(), _createElementBlock("span", _hoisted_214, "✓"))
                        : _createCommentVNode("v-if", true)
                    ], 10 /* CLASS, PROPS */, _hoisted_208))
                  }), 128 /* KEYED_FRAGMENT */))
                ]),
                _createElementVNode("p", _hoisted_215, _toDisplayString(_ctx.t('Saved to your account, so it follows you to every browser you sign in from.')), 1 /* TEXT */),
                _createElementVNode("h4", null, _toDisplayString(_ctx.t('Language')), 1 /* TEXT */),
                _createElementVNode("label", _hoisted_216, [
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[178] || (_cache[178] = $event => ((_ctx.settings.language) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_217, _toDisplayString(_ctx.t('Follow Nextcloud')), 1 /* TEXT */),
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.settings.languages, (l) => {
                      return (_openBlock(), _createElementBlock("option", {
                        key: l.code,
                        value: l.code
                      }, _toDisplayString(l.name), 9 /* TEXT, PROPS */, _hoisted_218))
                    }), 128 /* KEYED_FRAGMENT */))
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.settings.language]
                  ])
                ]),
                _createElementVNode("p", _hoisted_219, _toDisplayString(_ctx.t('CalcBase can speak a different language from the rest of Nextcloud.')), 1 /* TEXT */),
                (_ctx.ai.show)
                  ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                      _createElementVNode("h4", null, "🤖 " + _toDisplayString(_ctx.t('Width of the AI assistant')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_220, [
                        _createElementVNode("span", _hoisted_221, [
                          _withDirectives(_createElementVNode("input", {
                            type: "number",
                            step: "1",
                            min: _ctx.settings.aiU === '%' ? 15 : 240,
                            max: _ctx.settings.aiU === '%' ? 60 : 1200,
                            "onUpdate:modelValue": _cache[179] || (_cache[179] = $event => ((_ctx.settings.aiW) = $event)),
                            "aria-label": _ctx.t('Width of the AI assistant'),
                            onChange: _cache[180] || (_cache[180] = (...args) => (_ctx.aiWidthChanged && _ctx.aiWidthChanged(...args)))
                          }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_222), [
                            [
                              _vModelText,
                              _ctx.settings.aiW,
                              void 0,
                              { number: true }
                            ]
                          ]),
                          _withDirectives(_createElementVNode("select", {
                            "onUpdate:modelValue": _cache[181] || (_cache[181] = $event => ((_ctx.settings.aiU) = $event)),
                            "aria-label": _ctx.t('Width of the AI assistant'),
                            onChange: _cache[182] || (_cache[182] = (...args) => (_ctx.aiWidthChanged && _ctx.aiWidthChanged(...args)))
                          }, _hoisted_226, 40 /* PROPS, NEED_HYDRATION */, _hoisted_223), [
                            [_vModelSelect, _ctx.settings.aiU]
                          ])
                        ])
                      ]),
                      _createElementVNode("p", _hoisted_227, _toDisplayString(_ctx.t('In pixels (240 to 1200), or as a percentage of the width of the window (15 to 60).')), 1 /* TEXT */)
                    ], 64 /* STABLE_FRAGMENT */))
                  : _createCommentVNode("v-if", true)
              ], 512 /* NEED_PATCH */), [
                [_vShow, _ctx.setTab === 'view']
              ]),
              _withDirectives(_createElementVNode("section", _hoisted_228, [
                _createElementVNode("h3", null, [
                  _hoisted_229,
                  _createTextVNode(_toDisplayString(_ctx.t('Editing')), 1 /* TEXT */)
                ]),
                _createElementVNode("h4", null, _toDisplayString(_ctx.t('The Enter key')), 1 /* TEXT */),
                _createElementVNode("label", _hoisted_230, [
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[183] || (_cache[183] = $event => ((_ctx.settings.enterMoves) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_231, _toDisplayString(_ctx.t('Moves down, to the next row')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_232, _toDisplayString(_ctx.t('Moves right, to the next column')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.settings.enterMoves]
                  ])
                ]),
                _createElementVNode("p", _hoisted_233, _toDisplayString(_ctx.t('Shift+Enter goes the other way. Tab always moves right.')), 1 /* TEXT */),
                _createElementVNode("h4", null, _toDisplayString(_ctx.t('New sheets')), 1 /* TEXT */),
                _createElementVNode("label", _hoisted_234, [
                  _withDirectives(_createElementVNode("input", {
                    type: "checkbox",
                    "onUpdate:modelValue": _cache[184] || (_cache[184] = $event => ((_ctx.settings.showGrid) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelCheckbox, _ctx.settings.showGrid]
                  ]),
                  _createTextVNode(" " + _toDisplayString(_ctx.t('Show gridlines on a new sheet')), 1 /* TEXT */)
                ]),
                _createElementVNode("h4", null, _toDisplayString(_ctx.t('Default font')), 1 /* TEXT */),
                _createElementVNode("div", _hoisted_235, [
                  _createElementVNode("label", _hoisted_236, [
                    _createElementVNode("span", _hoisted_237, _toDisplayString(_ctx.t('Font')), 1 /* TEXT */),
                    _withDirectives(_createElementVNode("select", {
                      "onUpdate:modelValue": _cache[185] || (_cache[185] = $event => ((_ctx.settings.font) = $event))
                    }, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontChoices, (f) => {
                        return (_openBlock(), _createElementBlock("option", {
                          key: f,
                          value: f
                        }, _toDisplayString(f), 9 /* TEXT, PROPS */, _hoisted_238))
                      }), 128 /* KEYED_FRAGMENT */))
                    ], 512 /* NEED_PATCH */), [
                      [_vModelSelect, _ctx.settings.font]
                    ])
                  ]),
                  _createElementVNode("label", _hoisted_239, [
                    _createElementVNode("span", _hoisted_240, _toDisplayString(_ctx.t('Size (pt)')), 1 /* TEXT */),
                    _withDirectives(_createElementVNode("input", {
                      type: "number",
                      min: "6",
                      max: "48",
                      step: "1",
                      "onUpdate:modelValue": _cache[186] || (_cache[186] = $event => ((_ctx.settings.fontSize) = $event))
                    }, null, 512 /* NEED_PATCH */), [
                      [
                        _vModelText,
                        _ctx.settings.fontSize,
                        void 0,
                        { number: true }
                      ]
                    ])
                  ])
                ]),
                _createElementVNode("p", _hoisted_241, _toDisplayString(_ctx.t('Cells with no font of their own are shown in this. The file itself names a font only where you set one.')), 1 /* TEXT */)
              ], 512 /* NEED_PATCH */), [
                [_vShow, _ctx.setTab === 'edit']
              ]),
              _withDirectives(_createElementVNode("section", _hoisted_242, [
                _createElementVNode("h3", null, [
                  _hoisted_243,
                  _createTextVNode(_toDisplayString(_ctx.t('Saving')), 1 /* TEXT */)
                ]),
                _createElementVNode("label", _hoisted_244, [
                  _withDirectives(_createElementVNode("input", {
                    type: "checkbox",
                    "onUpdate:modelValue": _cache[187] || (_cache[187] = $event => ((_ctx.settings.autosave) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelCheckbox, _ctx.settings.autosave]
                  ]),
                  _createTextVNode(" " + _toDisplayString(_ctx.t('Save automatically while typing')), 1 /* TEXT */)
                ]),
                _createElementVNode("h4", null, _toDisplayString(_ctx.t('Save books in')), 1 /* TEXT */),
                _createElementVNode("label", _hoisted_245, [
                  _withDirectives(_createElementVNode("input", {
                    type: "text",
                    "onUpdate:modelValue": _cache[188] || (_cache[188] = $event => ((_ctx.settings.folder) = $event)),
                    "aria-label": _ctx.t('Save books in')
                  }, null, 8 /* PROPS */, _hoisted_246), [
                    [_vModelText, _ctx.settings.folder]
                  ])
                ]),
                _createElementVNode("p", _hoisted_247, _toDisplayString(_ctx.t('A folder in your own Files. Books already saved elsewhere stay where they are.')), 1 /* TEXT */),
                _createElementVNode("h4", null, _toDisplayString(_ctx.t('Versions')), 1 /* TEXT */),
                _createElementVNode("div", _hoisted_248, [
                  _createElementVNode("label", _hoisted_249, [
                    _createElementVNode("span", _hoisted_250, _toDisplayString(_ctx.t('Versions kept')), 1 /* TEXT */),
                    _withDirectives(_createElementVNode("input", {
                      type: "number",
                      min: "0",
                      max: "99",
                      step: "1",
                      "onUpdate:modelValue": _cache[189] || (_cache[189] = $event => ((_ctx.settings.versionKeep) = $event))
                    }, null, 512 /* NEED_PATCH */), [
                      [
                        _vModelText,
                        _ctx.settings.versionKeep,
                        void 0,
                        { number: true }
                      ]
                    ])
                  ]),
                  _createElementVNode("label", _hoisted_251, [
                    _createElementVNode("span", _hoisted_252, _toDisplayString(_ctx.t('A version is kept')), 1 /* TEXT */),
                    _withDirectives(_createElementVNode("select", {
                      "onUpdate:modelValue": _cache[190] || (_cache[190] = $event => ((_ctx.settings.versionWhen) = $event))
                    }, [
                      _createElementVNode("option", _hoisted_253, _toDisplayString(_ctx.t('When you save')), 1 /* TEXT */),
                      _createElementVNode("option", _hoisted_254, _toDisplayString(_ctx.t('Every time it is saved, autosave and all')), 1 /* TEXT */)
                    ], 512 /* NEED_PATCH */), [
                      [_vModelSelect, _ctx.settings.versionWhen]
                    ])
                  ])
                ]),
                _createElementVNode("p", _hoisted_255, _toDisplayString(_ctx.t('The version before each save is kept beside the book, named after it: 売上.html keeps 売上.#01, and the older ones shift down to #99. They are plain HTML and open in any browser. Nought keeps none.')), 1 /* TEXT */)
              ], 512 /* NEED_PATCH */), [
                [_vShow, _ctx.setTab === 'save']
              ])
            ]),
            _createElementVNode("div", _hoisted_256, [
              _createElementVNode("button", {
                class: "cb-btn ghost",
                onClick: _cache[191] || (_cache[191] = $event => (_ctx.cancelSettings()))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "cb-btn primary",
                onClick: _cache[192] || (_cache[192] = (...args) => (_ctx.saveSettings && _ctx.saveSettings(...args)))
              }, _toDisplayString(_ctx.t('Save')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the cell properties "),
    (_ctx.cellPropsOpen)
      ? (_openBlock(), _createElementBlock("div", _hoisted_257, [
          _createElementVNode("div", {
            class: "cb-modal cb-cellprops",
            style: {"width":"min(640px,100%)"},
            onClick: _cache[231] || (_cache[231] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, [
              _createTextVNode(_toDisplayString(_ctx.t('Cell properties')) + " ", 1 /* TEXT */),
              _createElementVNode("span", _hoisted_258, _toDisplayString(_ctx.selText), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_259, [
              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.cellTabs, (tb) => {
                return (_openBlock(), _createElementBlock("button", {
                  key: tb.key,
                  class: _normalizeClass(["cb-fp-tab", { on: _ctx.cellTab === tb.key }]),
                  role: "tab",
                  onClick: $event => (_ctx.cellTab = tb.key)
                }, _toDisplayString(tb.label), 11 /* TEXT, CLASS, PROPS */, _hoisted_260))
              }), 128 /* KEYED_FRAGMENT */))
            ]),
            _createElementVNode("div", _hoisted_261, [
              (_ctx.cellTab === 'number')
                ? (_openBlock(), _createElementBlock("div", _hoisted_262, [
                    _createElementVNode("div", _hoisted_263, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.numCats, (c) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: c.key,
                          class: _normalizeClass(["cb-nf-cat", { on: _ctx.numUi.cat === c.key }]),
                          onClick: $event => {_ctx.numUi.cat = c.key; _ctx.numBuild()}
                        }, _toDisplayString(c.label), 11 /* TEXT, CLASS, PROPS */, _hoisted_264))
                      }), 128 /* KEYED_FRAGMENT */))
                    ]),
                    _createElementVNode("div", _hoisted_265, [
                      _createElementVNode("div", _hoisted_266, [
                        _createElementVNode("span", _hoisted_267, _toDisplayString(_ctx.t('Sample')), 1 /* TEXT */),
                        _createElementVNode("span", _hoisted_268, _toDisplayString(_ctx.numPreview), 1 /* TEXT */)
                      ]),
                      _createElementVNode("p", _hoisted_269, _toDisplayString(_ctx.numCatAbout), 1 /* TEXT */),
                      (['number', 'percent', 'currency', 'sci'].indexOf(_ctx.numUi.cat) >= 0)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_270, [
                            _createElementVNode("div", _hoisted_271, [
                              _createElementVNode("label", null, _toDisplayString(_ctx.t('Decimal places')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("input", {
                                type: "number",
                                min: "0",
                                max: "10",
                                step: "1",
                                "onUpdate:modelValue": _cache[194] || (_cache[194] = $event => ((_ctx.numUi.dec) = $event)),
                                onInput: _cache[195] || (_cache[195] = (...args) => (_ctx.numBuild && _ctx.numBuild(...args)))
                              }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                                [
                                  _vModelText,
                                  _ctx.numUi.dec,
                                  void 0,
                                  { number: true }
                                ]
                              ])
                            ]),
                            (_ctx.numUi.cat === 'number' || _ctx.numUi.cat === 'currency')
                              ? (_openBlock(), _createElementBlock("div", _hoisted_272, [
                                  _hoisted_273,
                                  _createElementVNode("label", _hoisted_274, [
                                    _withDirectives(_createElementVNode("input", {
                                      type: "checkbox",
                                      "onUpdate:modelValue": _cache[196] || (_cache[196] = $event => ((_ctx.numUi.sep) = $event)),
                                      onChange: _cache[197] || (_cache[197] = (...args) => (_ctx.numBuild && _ctx.numBuild(...args)))
                                    }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                                      [_vModelCheckbox, _ctx.numUi.sep]
                                    ]),
                                    _createTextVNode(" " + _toDisplayString(_ctx.t('Thousands separator')), 1 /* TEXT */)
                                  ])
                                ]))
                              : _createCommentVNode("v-if", true),
                            (_ctx.numUi.cat === 'currency')
                              ? (_openBlock(), _createElementBlock("div", _hoisted_275, [
                                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Currency symbol')), 1 /* TEXT */),
                                  _withDirectives(_createElementVNode("select", {
                                    "onUpdate:modelValue": _cache[198] || (_cache[198] = $event => ((_ctx.numUi.cur) = $event)),
                                    onChange: _cache[199] || (_cache[199] = (...args) => (_ctx.numBuild && _ctx.numBuild(...args)))
                                  }, _hoisted_280, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                                    [_vModelSelect, _ctx.numUi.cur]
                                  ])
                                ]))
                              : _createCommentVNode("v-if", true),
                            (_ctx.numUi.cat === 'number' || _ctx.numUi.cat === 'currency')
                              ? (_openBlock(), _createElementBlock("div", _hoisted_281, [
                                  _hoisted_282,
                                  _createElementVNode("label", _hoisted_283, [
                                    _withDirectives(_createElementVNode("input", {
                                      type: "checkbox",
                                      "onUpdate:modelValue": _cache[200] || (_cache[200] = $event => ((_ctx.numUi.red) = $event)),
                                      onChange: _cache[201] || (_cache[201] = (...args) => (_ctx.numBuild && _ctx.numBuild(...args)))
                                    }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                                      [_vModelCheckbox, _ctx.numUi.red]
                                    ]),
                                    _createTextVNode(" " + _toDisplayString(_ctx.t('Negative numbers in red')), 1 /* TEXT */)
                                  ])
                                ]))
                              : _createCommentVNode("v-if", true)
                          ]))
                        : _createCommentVNode("v-if", true),
                      (_ctx.numUi.cat === 'date')
                        ? (_openBlock(), _createElementBlock("div", _hoisted_284, [
                            _createElementVNode("label", null, _toDisplayString(_ctx.t('Date style')), 1 /* TEXT */),
                            _withDirectives(_createElementVNode("select", {
                              "onUpdate:modelValue": _cache[202] || (_cache[202] = $event => ((_ctx.numUi.date) = $event)),
                              onChange: _cache[203] || (_cache[203] = (...args) => (_ctx.numBuild && _ctx.numBuild(...args)))
                            }, _hoisted_291, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                              [_vModelSelect, _ctx.numUi.date]
                            ])
                          ]))
                        : _createCommentVNode("v-if", true),
                      (_ctx.numUi.cat === 'time')
                        ? (_openBlock(), _createElementBlock("div", _hoisted_292, [
                            _createElementVNode("label", null, _toDisplayString(_ctx.t('Time style')), 1 /* TEXT */),
                            _withDirectives(_createElementVNode("select", {
                              "onUpdate:modelValue": _cache[204] || (_cache[204] = $event => ((_ctx.numUi.time) = $event)),
                              onChange: _cache[205] || (_cache[205] = (...args) => (_ctx.numBuild && _ctx.numBuild(...args)))
                            }, _hoisted_295, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                              [_vModelSelect, _ctx.numUi.time]
                            ])
                          ]))
                        : _createCommentVNode("v-if", true),
                      (_ctx.numUi.cat === 'custom')
                        ? (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
                            _createElementVNode("div", _hoisted_296, [
                              _createElementVNode("label", null, _toDisplayString(_ctx.t('Format code')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("input", {
                                type: "text",
                                "onUpdate:modelValue": _cache[206] || (_cache[206] = $event => ((_ctx.cellProps.fmt) = $event)),
                                spellcheck: "false"
                              }, null, 512 /* NEED_PATCH */), [
                                [_vModelText, _ctx.cellProps.fmt]
                              ])
                            ]),
                            _createElementVNode("div", _hoisted_297, [
                              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.numExamples, (x) => {
                                return (_openBlock(), _createElementBlock("button", {
                                  key: x.code,
                                  class: _normalizeClass(["cb-nf-ex", { on: _ctx.cellProps.fmt === x.code }]),
                                  onClick: $event => (_ctx.cellProps.fmt = x.code)
                                }, [
                                  _createElementVNode("code", null, _toDisplayString(x.code), 1 /* TEXT */),
                                  _createElementVNode("span", _hoisted_299, _toDisplayString(_ctx.numSampleOf(x.code)), 1 /* TEXT */)
                                ], 10 /* CLASS, PROPS */, _hoisted_298))
                              }), 128 /* KEYED_FRAGMENT */))
                            ])
                          ], 64 /* STABLE_FRAGMENT */))
                        : _createCommentVNode("v-if", true)
                    ])
                  ]))
                : _createCommentVNode("v-if", true),
              (_ctx.cellTab === 'align')
                ? (_openBlock(), _createElementBlock("div", _hoisted_300, [
                    _createElementVNode("div", _hoisted_301, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Across the cell')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("select", {
                        "onUpdate:modelValue": _cache[207] || (_cache[207] = $event => ((_ctx.cellProps.ha) = $event))
                      }, [
                        _createElementVNode("option", _hoisted_302, _toDisplayString(_ctx.t('Default (numbers right, text left)')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_303, _toDisplayString(_ctx.t('Left')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_304, _toDisplayString(_ctx.t('Centre')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_305, _toDisplayString(_ctx.t('Right')), 1 /* TEXT */)
                      ], 512 /* NEED_PATCH */), [
                        [_vModelSelect, _ctx.cellProps.ha]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_306, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Up and down in the cell')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("select", {
                        "onUpdate:modelValue": _cache[208] || (_cache[208] = $event => ((_ctx.cellProps.va) = $event))
                      }, [
                        _createElementVNode("option", _hoisted_307, _toDisplayString(_ctx.t('At the bottom')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_308, _toDisplayString(_ctx.t('At the top')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_309, _toDisplayString(_ctx.t('In the middle')), 1 /* TEXT */)
                      ], 512 /* NEED_PATCH */), [
                        [_vModelSelect, _ctx.cellProps.va]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_310, [
                      _hoisted_311,
                      _createElementVNode("label", _hoisted_312, [
                        _withDirectives(_createElementVNode("input", {
                          type: "checkbox",
                          "onUpdate:modelValue": _cache[209] || (_cache[209] = $event => ((_ctx.cellProps.wrap) = $event))
                        }, null, 512 /* NEED_PATCH */), [
                          [_vModelCheckbox, _ctx.cellProps.wrap]
                        ]),
                        _createTextVNode(" " + _toDisplayString(_ctx.t('Wrap text automatically')), 1 /* TEXT */)
                      ])
                    ])
                  ]))
                : _createCommentVNode("v-if", true),
              (_ctx.cellTab === 'font')
                ? (_openBlock(), _createElementBlock("div", _hoisted_313, [
                    _createElementVNode("div", _hoisted_314, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Font')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "text",
                        "onUpdate:modelValue": _cache[210] || (_cache[210] = $event => ((_ctx.cellProps.font) = $event)),
                        placeholder: _ctx.t('Default font')
                      }, null, 8 /* PROPS */, _hoisted_315), [
                        [_vModelText, _ctx.cellProps.font]
                      ]),
                      _createElementVNode("div", _hoisted_316, [
                        _createElementVNode("button", {
                          class: _normalizeClass(["it", { on: !_ctx.cellProps.font }]),
                          onClick: _cache[211] || (_cache[211] = $event => (_ctx.cellProps.font = ''))
                        }, _toDisplayString(_ctx.t('Default font')), 3 /* TEXT, CLASS */),
                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontChoices, (f) => {
                          return (_openBlock(), _createElementBlock("button", {
                            key: f,
                            class: _normalizeClass(["it", { on: _ctx.cellProps.font === f }]),
                            style: _normalizeStyle({ fontFamily: f }),
                            onClick: $event => (_ctx.cellProps.font = f)
                          }, _toDisplayString(f), 15 /* TEXT, CLASS, STYLE, PROPS */, _hoisted_317))
                        }), 128 /* KEYED_FRAGMENT */))
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_318, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Font style')), 1 /* TEXT */),
                      _createElementVNode("input", {
                        type: "text",
                        readonly: "",
                        value: _ctx.cellStyleName
                      }, null, 8 /* PROPS */, _hoisted_319),
                      _createElementVNode("div", _hoisted_320, [
                        _createElementVNode("button", {
                          class: _normalizeClass(["it", { on: !_ctx.cellProps.b && !_ctx.cellProps.i }]),
                          onClick: _cache[212] || (_cache[212] = $event => {_ctx.cellProps.b = false; _ctx.cellProps.i = false})
                        }, _toDisplayString(_ctx.t('Regular')), 3 /* TEXT, CLASS */),
                        _createElementVNode("button", {
                          class: _normalizeClass(["it", { on: !_ctx.cellProps.b && _ctx.cellProps.i }]),
                          style: {"font-style":"italic"},
                          onClick: _cache[213] || (_cache[213] = $event => {_ctx.cellProps.b = false; _ctx.cellProps.i = true})
                        }, _toDisplayString(_ctx.t('Italic')), 3 /* TEXT, CLASS */),
                        _createElementVNode("button", {
                          class: _normalizeClass(["it", { on: _ctx.cellProps.b && !_ctx.cellProps.i }]),
                          style: {"font-weight":"700"},
                          onClick: _cache[214] || (_cache[214] = $event => {_ctx.cellProps.b = true; _ctx.cellProps.i = false})
                        }, _toDisplayString(_ctx.t('Bold')), 3 /* TEXT, CLASS */),
                        _createElementVNode("button", {
                          class: _normalizeClass(["it", { on: _ctx.cellProps.b && _ctx.cellProps.i }]),
                          style: {"font-weight":"700","font-style":"italic"},
                          onClick: _cache[215] || (_cache[215] = $event => {_ctx.cellProps.b = true; _ctx.cellProps.i = true})
                        }, _toDisplayString(_ctx.t('Bold italic')), 3 /* TEXT, CLASS */)
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_321, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Size (pt)')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "number",
                        min: "4",
                        max: "200",
                        step: "0.5",
                        "onUpdate:modelValue": _cache[216] || (_cache[216] = $event => ((_ctx.cellProps.size) = $event)),
                        placeholder: String(_ctx.settings.fontSize)
                      }, null, 8 /* PROPS */, _hoisted_322), [
                        [_vModelText, _ctx.cellProps.size]
                      ]),
                      _createElementVNode("div", _hoisted_323, [
                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontSizes, (n) => {
                          return (_openBlock(), _createElementBlock("button", {
                            key: n,
                            class: _normalizeClass(["it", { on: Number(_ctx.cellProps.size) === n }]),
                            onClick: $event => (_ctx.cellProps.size = n)
                          }, _toDisplayString(n), 11 /* TEXT, CLASS, PROPS */, _hoisted_324))
                        }), 128 /* KEYED_FRAGMENT */))
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_325, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Text colour')), 1 /* TEXT */),
                      _createElementVNode("input", {
                        type: "color",
                        value: _ctx.cellProps.color || '#000000',
                        onInput: _cache[217] || (_cache[217] = $event => (_ctx.cellProps.color = $event.target.value))
                      }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_326),
                      _createElementVNode("button", {
                        class: "cb-btn ghost",
                        onClick: _cache[218] || (_cache[218] = $event => (_ctx.cellProps.color = ''))
                      }, _toDisplayString(_ctx.t('Automatic')), 1 /* TEXT */),
                      _createElementVNode("label", _hoisted_327, [
                        _withDirectives(_createElementVNode("input", {
                          type: "checkbox",
                          "onUpdate:modelValue": _cache[219] || (_cache[219] = $event => ((_ctx.cellProps.u) = $event))
                        }, null, 512 /* NEED_PATCH */), [
                          [_vModelCheckbox, _ctx.cellProps.u]
                        ]),
                        _createTextVNode(" " + _toDisplayString(_ctx.t('Underline')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("label", _hoisted_328, [
                        _withDirectives(_createElementVNode("input", {
                          type: "checkbox",
                          "onUpdate:modelValue": _cache[220] || (_cache[220] = $event => ((_ctx.cellProps.strike) = $event))
                        }, null, 512 /* NEED_PATCH */), [
                          [_vModelCheckbox, _ctx.cellProps.strike]
                        ]),
                        _createTextVNode(" " + _toDisplayString(_ctx.t('Strikethrough')), 1 /* TEXT */)
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_329, [
                      _createElementVNode("span", {
                        style: _normalizeStyle({ fontFamily: _ctx.cellProps.font || null, fontSize: _ctx.cellProps.size ? _ctx.cellProps.size + 'pt' : null, fontWeight: _ctx.cellProps.b ? 700 : null, fontStyle: _ctx.cellProps.i ? 'italic' : null, textDecoration: [_ctx.cellProps.u ? 'underline' : '', _ctx.cellProps.strike ? 'line-through' : ''].join(' ').trim() || null, color: _ctx.cellProps.color || null })
                      }, _toDisplayString(_ctx.t('Aa あア亜 123')), 5 /* TEXT, STYLE */)
                    ])
                  ]))
                : _createCommentVNode("v-if", true),
              (_ctx.cellTab === 'border')
                ? (_openBlock(), _createElementBlock("div", _hoisted_330, [
                    _createElementVNode("div", _hoisted_331, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Line style')), 1 /* TEXT */),
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.borderStyles, (st) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: st.key,
                          class: _normalizeClass(["cb-bd-st", { on: _ctx.bord.style === st.key }]),
                          onClick: $event => (_ctx.bord.style = st.key)
                        }, [
                          _createElementVNode("span", {
                            class: "ln",
                            style: _normalizeStyle({ borderTop: st.key === 'none' ? '0' : (st.w + 'px ' + st.key + ' currentColor') })
                          }, null, 4 /* STYLE */),
                          _createElementVNode("span", _hoisted_333, _toDisplayString(st.label), 1 /* TEXT */)
                        ], 10 /* CLASS, PROPS */, _hoisted_332))
                      }), 128 /* KEYED_FRAGMENT */)),
                      _createElementVNode("div", _hoisted_334, [
                        _createElementVNode("label", null, _toDisplayString(_ctx.t('Thickness (px)')), 1 /* TEXT */),
                        _withDirectives(_createElementVNode("input", {
                          type: "number",
                          min: "1",
                          max: "6",
                          step: "1",
                          "onUpdate:modelValue": _cache[221] || (_cache[221] = $event => ((_ctx.bord.width) = $event))
                        }, null, 512 /* NEED_PATCH */), [
                          [
                            _vModelText,
                            _ctx.bord.width,
                            void 0,
                            { number: true }
                          ]
                        ])
                      ]),
                      _createElementVNode("div", _hoisted_335, [
                        _createElementVNode("label", null, _toDisplayString(_ctx.t('Line colour')), 1 /* TEXT */),
                        _withDirectives(_createElementVNode("input", {
                          type: "color",
                          "onUpdate:modelValue": _cache[222] || (_cache[222] = $event => ((_ctx.bord.colour) = $event))
                        }, null, 512 /* NEED_PATCH */), [
                          [_vModelText, _ctx.bord.colour]
                        ])
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_336, [
                      _createElementVNode("div", _hoisted_337, [
                        _createElementVNode("button", {
                          class: "cb-btn",
                          onClick: _cache[223] || (_cache[223] = $event => (_ctx.bordPreset('none')))
                        }, _toDisplayString(_ctx.t('No borders')), 1 /* TEXT */),
                        _createElementVNode("button", {
                          class: "cb-btn",
                          onClick: _cache[224] || (_cache[224] = $event => (_ctx.bordPreset('outline')))
                        }, _toDisplayString(_ctx.t('Outline')), 1 /* TEXT */),
                        (_ctx.selSpan.rows > 1 || _ctx.selSpan.cols > 1)
                          ? (_openBlock(), _createElementBlock("button", {
                              key: 0,
                              class: "cb-btn",
                              onClick: _cache[225] || (_cache[225] = $event => (_ctx.bordPreset('inside')))
                            }, _toDisplayString(_ctx.t('Inside')), 1 /* TEXT */))
                          : _createCommentVNode("v-if", true),
                        _createElementVNode("button", {
                          class: "cb-btn",
                          onClick: _cache[226] || (_cache[226] = $event => (_ctx.bordPreset('all')))
                        }, _toDisplayString(_ctx.t('All borders')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("div", {
                        class: "cb-bd-pic",
                        style: _normalizeStyle({ display: 'grid', gridTemplateColumns: 'repeat(' + (_ctx.selSpan.cols > 1 ? 2 : 1) + ', 1fr)', gridTemplateRows: 'repeat(' + (_ctx.selSpan.rows > 1 ? 2 : 1) + ', 1fr)' })
                      }, [
                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList((_ctx.selSpan.cols > 1 ? 2 : 1) * (_ctx.selSpan.rows > 1 ? 2 : 1), (n) => {
                          return (_openBlock(), _createElementBlock("span", {
                            key: 'w' + n,
                            class: "txt"
                          }, _toDisplayString(_ctx.t('Words')), 1 /* TEXT */))
                        }), 128 /* KEYED_FRAGMENT */)),
                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.bordEdges, (e) => {
                          return _withDirectives((_openBlock(), _createElementBlock("button", {
                            key: e,
                            class: _normalizeClass(["edge", [e, _ctx.bord.edges[e]]]),
                            onClick: $event => (_ctx.bordToggle(e)),
                            title: _ctx.edgeLabel(e)
                          }, null, 10 /* CLASS, PROPS */, _hoisted_338)), [
                            [_vShow, (e !== 'insideH' || _ctx.selSpan.rows > 1) && (e !== 'insideV' || _ctx.selSpan.cols > 1)]
                          ])
                        }), 128 /* KEYED_FRAGMENT */))
                      ], 4 /* STYLE */),
                      _createElementVNode("p", _hoisted_339, _toDisplayString(_ctx.t('Choose a line, then press a preset or an edge of the picture. Edges left grey are not changed.')), 1 /* TEXT */)
                    ])
                  ]))
                : _createCommentVNode("v-if", true),
              (_ctx.cellTab === 'fill')
                ? (_openBlock(), _createElementBlock("div", _hoisted_340, [
                    _createElementVNode("button", {
                      class: _normalizeClass(["cb-btn", { primary: !_ctx.cellProps.bg }]),
                      onClick: _cache[227] || (_cache[227] = $event => (_ctx.cellProps.bg = ''))
                    }, _toDisplayString(_ctx.t('No fill')), 3 /* TEXT, CLASS */),
                    _createElementVNode("div", _hoisted_341, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.palette, (c) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: c,
                          class: _normalizeClass(["sw", { on: _ctx.cellProps.bg === c }]),
                          style: _normalizeStyle({ background: c }),
                          onClick: $event => (_ctx.cellProps.bg = c),
                          title: c
                        }, null, 14 /* CLASS, STYLE, PROPS */, _hoisted_342))
                      }), 128 /* KEYED_FRAGMENT */))
                    ]),
                    _createElementVNode("label", null, [
                      _createTextVNode(_toDisplayString(_ctx.t('Other colour')) + " ", 1 /* TEXT */),
                      _createElementVNode("input", {
                        type: "color",
                        value: _ctx.cellProps.bg || '#ffffff',
                        onInput: _cache[228] || (_cache[228] = $event => (_ctx.cellProps.bg = $event.target.value))
                      }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_343)
                    ])
                  ]))
                : _createCommentVNode("v-if", true),
              _createElementVNode("p", _hoisted_344, _toDisplayString(_ctx.t('This is put on every cell of the selection.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_345, [
              _createElementVNode("button", {
                class: "cb-btn",
                onClick: _cache[229] || (_cache[229] = $event => (_ctx.cellPropsOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "cb-btn primary",
                onClick: _cache[230] || (_cache[230] = (...args) => (_ctx.applyCellProps && _ctx.applyCellProps(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the functions "),
    (_ctx.fxOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 3,
          class: "cb-modal-back",
          onClick: _cache[239] || (_cache[239] = $event => (_ctx.fxOpen = false))
        }, [
          _createElementVNode("div", {
            class: "cb-modal",
            onClick: _cache[238] || (_cache[238] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "fx " + _toDisplayString(_ctx.t('Insert function')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_346, [
              _createElementVNode("div", _hoisted_347, [
                _createElementVNode("div", _hoisted_348, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Category')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[232] || (_cache[232] = $event => ((_ctx.fxGroup) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_349, _toDisplayString(_ctx.t('All categories')), 1 /* TEXT */),
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fxGroups, (g) => {
                      return (_openBlock(), _createElementBlock("option", {
                        key: g,
                        value: g
                      }, _toDisplayString(_ctx.t(g)), 9 /* TEXT, PROPS */, _hoisted_350))
                    }), 128 /* KEYED_FRAGMENT */))
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.fxGroup]
                  ])
                ]),
                _createElementVNode("div", _hoisted_351, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Search')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "text",
                    ref: "fxSearch",
                    "onUpdate:modelValue": _cache[233] || (_cache[233] = $event => ((_ctx.fxQuery) = $event)),
                    placeholder: _ctx.t('Search by name or purpose'),
                    onKeydown: _cache[234] || (_cache[234] = _withKeys(_withModifiers($event => (_ctx.fxInsert()), ["prevent"]), ["enter"]))
                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_352), [
                    [_vModelText, _ctx.fxQuery]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_353, [
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fxList, (f) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: f.name,
                    class: _normalizeClass(["it", { on: _ctx.fxSel === f.name }]),
                    onClick: $event => (_ctx.fxSel = f.name),
                    onDblclick: _cache[235] || (_cache[235] = $event => (_ctx.fxInsert()))
                  }, [
                    _createElementVNode("b", null, _toDisplayString(f.name), 1 /* TEXT */),
                    _createElementVNode("span", _hoisted_355, _toDisplayString(_ctx.t(f.description)), 1 /* TEXT */),
                    _createElementVNode("span", _hoisted_356, _toDisplayString(_ctx.t(f.group)), 1 /* TEXT */)
                  ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_354))
                }), 128 /* KEYED_FRAGMENT */)),
                (!_ctx.fxList.length)
                  ? (_openBlock(), _createElementBlock("p", _hoisted_357, _toDisplayString(_ctx.t('No function matches.')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true)
              ]),
              (_ctx.fxCurrent)
                ? (_openBlock(), _createElementBlock("div", _hoisted_358, [
                    _createElementVNode("code", null, _toDisplayString(_ctx.fxCurrent.name) + "(" + _toDisplayString(_ctx.fxCurrent.args) + ")", 1 /* TEXT */),
                    _createTextVNode(),
                    _createElementVNode("span", _hoisted_359, _toDisplayString(_ctx.t(_ctx.fxCurrent.group)), 1 /* TEXT */),
                    _hoisted_360,
                    _createTextVNode(_toDisplayString(_ctx.t(_ctx.fxCurrent.description)), 1 /* TEXT */)
                  ]))
                : _createCommentVNode("v-if", true)
            ]),
            _createElementVNode("div", _hoisted_361, [
              _createElementVNode("button", {
                class: "cb-btn",
                onClick: _cache[236] || (_cache[236] = $event => (_ctx.fxOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "cb-btn primary",
                disabled: !_ctx.fxCurrent,
                onClick: _cache[237] || (_cache[237] = $event => (_ctx.fxInsert()))
              }, _toDisplayString(_ctx.t('Insert')), 9 /* TEXT, PROPS */, _hoisted_362)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" printing "),
    (_ctx.printOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 4,
          class: "cb-modal-back",
          onClick: _cache[254] || (_cache[254] = $event => (_ctx.printOpen = false))
        }, [
          _createElementVNode("div", {
            class: "cb-modal",
            onClick: _cache[253] || (_cache[253] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Print / PDF')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_363, [
              _createElementVNode("div", _hoisted_364, [
                _createElementVNode("div", _hoisted_365, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('What to print')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[240] || (_cache[240] = $event => ((_ctx.print.range) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_366, _toDisplayString(_ctx.t('The sheet (used range)')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_367, _toDisplayString(_ctx.t('The selection')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_368, _toDisplayString(_ctx.t('Every sheet')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.print.range]
                  ])
                ]),
                _createElementVNode("div", _hoisted_369, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Paper')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[241] || (_cache[241] = $event => ((_ctx.print.paper) = $event))
                  }, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.paperNames, (p) => {
                      return (_openBlock(), _createElementBlock("option", {
                        key: p,
                        value: p
                      }, _toDisplayString(p), 9 /* TEXT, PROPS */, _hoisted_370))
                    }), 128 /* KEYED_FRAGMENT */))
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.print.paper]
                  ])
                ]),
                _createElementVNode("div", _hoisted_371, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Orientation')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[242] || (_cache[242] = $event => ((_ctx.print.orientation) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_372, _toDisplayString(_ctx.t('Portrait')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_373, _toDisplayString(_ctx.t('Landscape')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.print.orientation]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_374, [
                _createElementVNode("div", _hoisted_375, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Margin top (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "50",
                    "onUpdate:modelValue": _cache[243] || (_cache[243] = $event => ((_ctx.print.margins.t) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.print.margins.t,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_376, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Margin right (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "50",
                    "onUpdate:modelValue": _cache[244] || (_cache[244] = $event => ((_ctx.print.margins.r) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.print.margins.r,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_377, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Margin bottom (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "50",
                    "onUpdate:modelValue": _cache[245] || (_cache[245] = $event => ((_ctx.print.margins.b) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.print.margins.b,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_378, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Margin left (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "50",
                    "onUpdate:modelValue": _cache[246] || (_cache[246] = $event => ((_ctx.print.margins.l) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.print.margins.l,
                      void 0,
                      { number: true }
                    ]
                  ])
                ])
              ]),
              _createElementVNode("label", _hoisted_379, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[247] || (_cache[247] = $event => ((_ctx.print.grid) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.print.grid]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Print the gridlines')), 1 /* TEXT */)
              ]),
              _createElementVNode("label", _hoisted_380, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[248] || (_cache[248] = $event => ((_ctx.print.header) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.print.header]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Repeat the first row on every page')), 1 /* TEXT */)
              ]),
              _createElementVNode("label", _hoisted_381, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[249] || (_cache[249] = $event => ((_ctx.print.fit) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.print.fit]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Fit the columns to the width of the page')), 1 /* TEXT */)
              ]),
              _createElementVNode("label", _hoisted_382, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[250] || (_cache[250] = $event => ((_ctx.print.headings) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.print.headings]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Print the row numbers and column letters')), 1 /* TEXT */)
              ]),
              _createElementVNode("p", _hoisted_383, _toDisplayString(_ctx.t('The browser’s print dialogue opens next; choose “Save as PDF” there for a PDF.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_384, [
              _createElementVNode("button", {
                class: "cb-btn",
                onClick: _cache[251] || (_cache[251] = $event => (_ctx.printOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "cb-btn primary",
                onClick: _cache[252] || (_cache[252] = (...args) => (_ctx.doPrint && _ctx.doPrint(...args)))
              }, _toDisplayString(_ctx.t('Print')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the versions kept beside a book "),
    (_ctx.vers.open)
      ? (_openBlock(), _createElementBlock("div", {
          key: 5,
          class: "cb-modal-back",
          onClick: _cache[257] || (_cache[257] = $event => (_ctx.vers.open = false))
        }, [
          _createElementVNode("div", {
            class: "cb-modal",
            style: {"width":"min(560px,100%)"},
            onClick: _cache[256] || (_cache[256] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Versions of “{name}”', { name: _ctx.vers.title })), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_385, [
              (!_ctx.vers.list.length)
                ? (_openBlock(), _createElementBlock("p", _hoisted_386, _toDisplayString(_ctx.t('None yet. One is kept each time the book is saved, if versions are switched on in the settings.')), 1 /* TEXT */))
                : (_openBlock(), _createElementBlock("ol", _hoisted_387, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.vers.list, (v) => {
                      return (_openBlock(), _createElementBlock("li", {
                        key: v.number
                      }, [
                        _createElementVNode("span", _hoisted_388, "#" + _toDisplayString(String(v.number).padStart(2, '0')), 1 /* TEXT */),
                        _createElementVNode("span", _hoisted_389, _toDisplayString(_ctx.when(v.mtime)), 1 /* TEXT */),
                        _createElementVNode("span", _hoisted_390, _toDisplayString(_ctx.size(v.size)), 1 /* TEXT */),
                        _createElementVNode("button", {
                          class: "cb-btn ghost",
                          onClick: $event => (_ctx.previewVersion(v.number))
                        }, _toDisplayString(_ctx.t('Look')), 9 /* TEXT, PROPS */, _hoisted_391),
                        _createElementVNode("button", {
                          class: "cb-btn ghost",
                          onClick: $event => (_ctx.restoreVersion(v.number)),
                          disabled: _ctx.book.readOnly
                        }, _toDisplayString(_ctx.t('Put this one back')), 9 /* TEXT, PROPS */, _hoisted_392)
                      ]))
                    }), 128 /* KEYED_FRAGMENT */))
                  ])),
              (_ctx.vers.preview)
                ? (_openBlock(), _createElementBlock("div", {
                    key: 2,
                    class: "cb-verview",
                    innerHTML: _ctx.vers.preview
                  }, null, 8 /* PROPS */, _hoisted_393))
                : _createCommentVNode("v-if", true),
              _createElementVNode("p", _hoisted_394, _toDisplayString(_ctx.t('Putting a version back keeps what is there now as #01 first, so it can be undone the same way. The version files sit beside the book in your Files and can be opened there like any other page.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_395, [
              _createElementVNode("button", {
                class: "cb-btn primary",
                onClick: _cache[255] || (_cache[255] = $event => (_ctx.vers.open = false))
              }, _toDisplayString(_ctx.t('Done')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the file itself "),
    (_ctx.htmlOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 6,
          class: "cb-modal-back",
          onClick: _cache[260] || (_cache[260] = $event => (_ctx.htmlOpen = false))
        }, [
          _createElementVNode("div", {
            class: "cb-modal",
            style: {"width":"min(860px,100%)"},
            onClick: _cache[259] || (_cache[259] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "</> " + _toDisplayString(_ctx.t('View the HTML')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_396, [
              _createElementVNode("p", _hoisted_397, _toDisplayString(_ctx.t('This is exactly what is stored in Files — one file, styles included, nothing else needed to open it.')), 1 /* TEXT */),
              _createElementVNode("textarea", {
                rows: "18",
                spellcheck: "false",
                readonly: "",
                value: _ctx.htmlText,
                style: {"width":"100%","font-family":"monospace","font-size":"12px"}
              }, null, 8 /* PROPS */, _hoisted_398)
            ]),
            _createElementVNode("div", _hoisted_399, [
              _createElementVNode("button", {
                class: "cb-btn primary",
                onClick: _cache[258] || (_cache[258] = $event => (_ctx.htmlOpen = false))
              }, _toDisplayString(_ctx.t('Close')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" a question with one answer: a name, a number "),
    (_ctx.ask.open)
      ? (_openBlock(), _createElementBlock("div", {
          key: 7,
          class: "cb-modal-back",
          onClick: _cache[267] || (_cache[267] = $event => (_ctx.askAnswer(null)))
        }, [
          _createElementVNode("div", {
            class: "cb-modal",
            style: {"width":"min(420px,100%)"},
            onClick: _cache[266] || (_cache[266] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.ask.title), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_400, [
              _createElementVNode("div", _hoisted_401, [
                (_ctx.ask.label)
                  ? (_openBlock(), _createElementBlock("label", _hoisted_402, _toDisplayString(_ctx.ask.label), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true),
                _withDirectives(_createElementVNode("input", {
                  ref: "askInput",
                  type: _ctx.ask.number ? 'number' : 'text',
                  "onUpdate:modelValue": _cache[261] || (_cache[261] = $event => ((_ctx.ask.value) = $event)),
                  min: _ctx.ask.min,
                  max: _ctx.ask.max,
                  onKeydown: [
                    _cache[262] || (_cache[262] = _withKeys(_withModifiers($event => (_ctx.askAnswer(_ctx.ask.value)), ["prevent"]), ["enter"])),
                    _cache[263] || (_cache[263] = _withKeys(_withModifiers($event => (_ctx.askAnswer(null)), ["prevent"]), ["esc"]))
                  ]
                }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_403), [
                  [_vModelDynamic, _ctx.ask.value]
                ])
              ]),
              (_ctx.ask.tip)
                ? (_openBlock(), _createElementBlock("p", _hoisted_404, _toDisplayString(_ctx.ask.tip), 1 /* TEXT */))
                : _createCommentVNode("v-if", true)
            ]),
            _createElementVNode("div", _hoisted_405, [
              _createElementVNode("button", {
                class: "cb-btn",
                onClick: _cache[264] || (_cache[264] = $event => (_ctx.askAnswer(null)))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "cb-btn primary",
                onClick: _cache[265] || (_cache[265] = $event => (_ctx.askAnswer(_ctx.ask.value)))
              }, _toDisplayString(_ctx.t('OK')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the Files picker: a folder to move to, or a file to import "),
    (_ctx.picker.open)
      ? (_openBlock(), _createElementBlock("div", {
          key: 8,
          class: "cb-modal-back",
          onClick: _cache[272] || (_cache[272] = $event => (_ctx.pickerAnswer(null)))
        }, [
          _createElementVNode("div", {
            class: "cb-modal",
            onClick: _cache[271] || (_cache[271] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.picker.mode === 'import' ? _ctx.t('Import a CSV, ODS or XLSX file') : _ctx.t('Choose a folder')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_406, [
              _createElementVNode("div", _hoisted_407, [
                _createElementVNode("button", {
                  class: "cb-tb",
                  onClick: _cache[268] || (_cache[268] = (...args) => (_ctx.pickerUp && _ctx.pickerUp(...args))),
                  disabled: !_ctx.picker.path,
                  title: _ctx.t('Up')
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.up
                  }, null, 8 /* PROPS */, _hoisted_409)
                ], 8 /* PROPS */, _hoisted_408),
                _createElementVNode("span", _hoisted_410, _toDisplayString(_ctx.picker.path || '/'), 1 /* TEXT */)
              ]),
              _createElementVNode("div", _hoisted_411, [
                (_ctx.picker.busy)
                  ? (_openBlock(), _createElementBlock("p", _hoisted_412, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */))
                  : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.picker.items, (it) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: it.path,
                          class: _normalizeClass(["fp-item", { on: _ctx.picker.chosen === it.path, dim: _ctx.picker.mode === 'import' && !it.dir && !it.ok }]),
                          onClick: $event => (_ctx.pickerClick(it)),
                          onDblclick: $event => (_ctx.pickerOpen(it))
                        }, [
                          _createElementVNode("span", {
                            class: "ic",
                            innerHTML: it.dir ? _ctx.icons.folder : _ctx.icons.doc
                          }, null, 8 /* PROPS */, _hoisted_414),
                          _createElementVNode("span", _hoisted_415, _toDisplayString(it.name), 1 /* TEXT */),
                          (!it.dir)
                            ? (_openBlock(), _createElementBlock("span", _hoisted_416, _toDisplayString(_ctx.size(it.size)), 1 /* TEXT */))
                            : _createCommentVNode("v-if", true)
                        ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_413))
                      }), 128 /* KEYED_FRAGMENT */)),
                      (!_ctx.picker.items.length)
                        ? (_openBlock(), _createElementBlock("p", _hoisted_417, _toDisplayString(_ctx.t('Nothing here.')), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true)
                    ], 64 /* STABLE_FRAGMENT */))
              ]),
              (_ctx.picker.mode === 'import')
                ? (_openBlock(), _createElementBlock("p", _hoisted_418, _toDisplayString(_ctx.t('The file is only read. A new book is made from it in your save folder, and the file itself stays as it was.')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true)
            ]),
            _createElementVNode("div", _hoisted_419, [
              _createElementVNode("button", {
                class: "cb-btn",
                onClick: _cache[269] || (_cache[269] = $event => (_ctx.pickerAnswer(null)))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "cb-btn primary",
                onClick: _cache[270] || (_cache[270] = $event => (_ctx.pickerAnswer(_ctx.picker.mode === 'import' ? _ctx.picker.chosen : (_ctx.picker.chosen || _ctx.picker.path)))),
                disabled: _ctx.picker.mode === 'import' && !_ctx.picker.chosen
              }, _toDisplayString(_ctx.picker.mode === 'import' ? _ctx.t('Import') : _ctx.t('Choose this folder')), 9 /* TEXT, PROPS */, _hoisted_420)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" export "),
    (_ctx.exportOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 9,
          class: "cb-modal-back",
          onClick: _cache[277] || (_cache[277] = $event => (_ctx.exportOpen = false))
        }, [
          _createElementVNode("div", {
            class: "cb-modal",
            style: {"width":"min(460px,100%)"},
            onClick: _cache[276] || (_cache[276] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Export')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_421, [
              _createElementVNode("div", _hoisted_422, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Format')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("select", {
                  "onUpdate:modelValue": _cache[273] || (_cache[273] = $event => ((_ctx.exportFmt) = $event))
                }, [
                  _hoisted_423,
                  _hoisted_424,
                  _createElementVNode("option", _hoisted_425, "CSV (" + _toDisplayString(_ctx.t('the active sheet')) + ")", 1 /* TEXT */)
                ], 512 /* NEED_PATCH */), [
                  [_vModelSelect, _ctx.exportFmt]
                ])
              ]),
              _createElementVNode("p", _hoisted_426, _toDisplayString(_ctx.t('The file is written next to the book in your Files, under the book’s name. Formulas, values, number formats, the styles above, widths and merges are kept in ODS and XLSX.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_427, [
              _createElementVNode("button", {
                class: "cb-btn",
                onClick: _cache[274] || (_cache[274] = $event => (_ctx.exportOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "cb-btn primary",
                onClick: _cache[275] || (_cache[275] = (...args) => (_ctx.doExport && _ctx.doExport(...args))),
                disabled: _ctx.exporting
              }, _toDisplayString(_ctx.exporting ? _ctx.t('Writing…') : _ctx.t('Export')), 9 /* TEXT, PROPS */, _hoisted_428)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the autofilter's list of values "),
    (_ctx.filterPop.open)
      ? (_openBlock(), _createElementBlock("div", {
          key: 10,
          class: "cb-ctx-back",
          onMousedown: _cache[278] || (_cache[278] = $event => (_ctx.filterPop.open = false))
        }, null, 32 /* NEED_HYDRATION */))
      : _createCommentVNode("v-if", true),
    (_ctx.filterPop.open)
      ? (_openBlock(), _createElementBlock("div", {
          key: 11,
          class: "cb-filterpop",
          style: _normalizeStyle({ left: _ctx.filterPop.x + 'px', top: _ctx.filterPop.y + 'px' })
        }, [
          _createElementVNode("label", _hoisted_429, [
            _createElementVNode("input", {
              type: "checkbox",
              checked: _ctx.filterAllChecked,
              onChange: _cache[279] || (_cache[279] = $event => (_ctx.filterCheckAll($event.target.checked)))
            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_430),
            _createTextVNode(),
            _createElementVNode("b", null, _toDisplayString(_ctx.t('Select all')), 1 /* TEXT */)
          ]),
          _createElementVNode("div", _hoisted_431, [
            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.filterPop.values, (v) => {
              return (_openBlock(), _createElementBlock("label", {
                key: v,
                class: "it"
              }, [
                _createElementVNode("input", {
                  type: "checkbox",
                  checked: _ctx.filterPop.checked.has(v),
                  onChange: $event => (_ctx.filterCheck(v, $event.target.checked))
                }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_432),
                _createTextVNode(" " + _toDisplayString(v === '' ? _ctx.t('(empty)') : v), 1 /* TEXT */)
              ]))
            }), 128 /* KEYED_FRAGMENT */))
          ]),
          _createElementVNode("div", _hoisted_433, [
            _createElementVNode("button", {
              class: "cb-btn ghost",
              onClick: _cache[280] || (_cache[280] = $event => (_ctx.filterPop.open = false))
            }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
            _createElementVNode("button", {
              class: "cb-btn primary",
              onClick: _cache[281] || (_cache[281] = (...args) => (_ctx.applyFilterPop && _ctx.applyFilterPop(...args)))
            }, _toDisplayString(_ctx.t('OK')), 1 /* TEXT */)
          ])
        ], 4 /* STYLE */))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the right button: the app's own menu, never the browser's "),
    (_ctx.ctx.open)
      ? (_openBlock(), _createElementBlock("div", {
          key: 12,
          class: "cb-ctx-back",
          onMousedown: _cache[282] || (_cache[282] = _withModifiers(() => {}, ["prevent"])),
          onClick: _cache[283] || (_cache[283] = (...args) => (_ctx.closeCtxIfSettled && _ctx.closeCtxIfSettled(...args))),
          onTouchend: _cache[284] || (_cache[284] = _withModifiers((...args) => (_ctx.closeCtxIfSettled && _ctx.closeCtxIfSettled(...args)), ["prevent"])),
          onContextmenu: _cache[285] || (_cache[285] = _withModifiers((...args) => (_ctx.closeCtx && _ctx.closeCtx(...args)), ["prevent"]))
        }, null, 32 /* NEED_HYDRATION */))
      : _createCommentVNode("v-if", true),
    (_ctx.ctx.open)
      ? (_openBlock(), _createElementBlock("div", {
          key: 13,
          class: _normalizeClass(["cb-ctxmenu", { flip: _ctx.ctx.flip, tall: _ctx.ctx.tall }]),
          style: _normalizeStyle({ left: _ctx.ctx.x + 'px', top: _ctx.ctx.y + 'px', maxHeight: _ctx.ctx.tall ? _ctx.ctx.tall + 'px' : null }),
          onMousedown: _cache[342] || (_cache[342] = _withModifiers(() => {}, ["prevent"])),
          onContextmenu: _cache[343] || (_cache[343] = _withModifiers(() => {}, ["prevent"]))
        }, [
          (_ctx.ctx.kind === 'book')
            ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                _createElementVNode("div", _hoisted_434, _toDisplayString(_ctx.ctx.book.title || _ctx.ctx.book.name), 1 /* TEXT */),
                _createElementVNode("button", {
                  class: "ci",
                  onClick: _cache[286] || (_cache[286] = $event => {_ctx.closeCtx(); _ctx.openBook(_ctx.ctx.book.id)})
                }, _toDisplayString(_ctx.t('Open')), 1 /* TEXT */),
                _hoisted_435,
                _createElementVNode("button", {
                  class: "ci",
                  onClick: _cache[287] || (_cache[287] = $event => (_ctx.renameBook(_ctx.ctx.book)))
                }, _toDisplayString(_ctx.t('Rename…')), 1 /* TEXT */),
                (_ctx.ctx.book.download !== false)
                  ? (_openBlock(), _createElementBlock("button", {
                      key: 0,
                      class: "ci",
                      onClick: _cache[288] || (_cache[288] = $event => (_ctx.duplicateBook(_ctx.ctx.book.id)))
                    }, _toDisplayString(_ctx.t('Duplicate')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true),
                (!_ctx.ctx.book.shared)
                  ? (_openBlock(), _createElementBlock("button", {
                      key: 1,
                      class: "ci",
                      onClick: _cache[289] || (_cache[289] = $event => (_ctx.moveBook(_ctx.ctx.book)))
                    }, _toDisplayString(_ctx.t('Move to…')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true),
                (_ctx.ctx.book.download !== false)
                  ? (_openBlock(), _createElementBlock("button", {
                      key: 2,
                      class: "ci",
                      onClick: _cache[290] || (_cache[290] = $event => (_ctx.downloadBook(_ctx.ctx.book)))
                    }, _toDisplayString(_ctx.t('Download')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true),
                _createElementVNode("button", {
                  class: "ci",
                  onClick: _cache[291] || (_cache[291] = $event => (_ctx.openVersions(_ctx.ctx.book)))
                }, _toDisplayString(_ctx.t('Versions…')), 1 /* TEXT */),
                _hoisted_436,
                _createElementVNode("button", {
                  class: "ci danger",
                  onClick: _cache[292] || (_cache[292] = $event => (_ctx.deleteBook(_ctx.ctx.book)))
                }, _toDisplayString(_ctx.t('Delete')), 1 /* TEXT */)
              ], 64 /* STABLE_FRAGMENT */))
            : (_ctx.ctx.kind === 'sheet')
              ? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                  _createElementVNode("div", _hoisted_437, _toDisplayString(_ctx.sheetNames[_ctx.ctx.sheet]), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: "ci",
                    disabled: _ctx.book.readOnly,
                    onClick: _cache[293] || (_cache[293] = $event => {_ctx.closeCtx(); _ctx.addSheet(_ctx.ctx.sheet)})
                  }, _toDisplayString(_ctx.t('Insert sheet before')), 9 /* TEXT, PROPS */, _hoisted_438),
                  _createElementVNode("button", {
                    class: "ci",
                    disabled: _ctx.book.readOnly,
                    onClick: _cache[294] || (_cache[294] = $event => {_ctx.closeCtx(); _ctx.addSheet(_ctx.ctx.sheet + 1)})
                  }, _toDisplayString(_ctx.t('Insert sheet after')), 9 /* TEXT, PROPS */, _hoisted_439),
                  _createElementVNode("button", {
                    class: "ci",
                    disabled: _ctx.book.readOnly,
                    onClick: _cache[295] || (_cache[295] = $event => {_ctx.closeCtx(); _ctx.startRenameSheet(_ctx.ctx.sheet)})
                  }, _toDisplayString(_ctx.t('Rename…')), 9 /* TEXT, PROPS */, _hoisted_440),
                  _createElementVNode("button", {
                    class: "ci",
                    disabled: _ctx.book.readOnly,
                    onClick: _cache[296] || (_cache[296] = $event => {_ctx.closeCtx(); _ctx.duplicateSheet(_ctx.ctx.sheet)})
                  }, _toDisplayString(_ctx.t('Duplicate')), 9 /* TEXT, PROPS */, _hoisted_441),
                  _hoisted_442,
                  _createElementVNode("button", {
                    class: "ci",
                    disabled: _ctx.book.readOnly || _ctx.ctx.sheet === 0,
                    onClick: _cache[297] || (_cache[297] = $event => {_ctx.closeCtx(); _ctx.moveSheet(_ctx.ctx.sheet, -1)})
                  }, _toDisplayString(_ctx.t('Move left')), 9 /* TEXT, PROPS */, _hoisted_443),
                  _createElementVNode("button", {
                    class: "ci",
                    disabled: _ctx.book.readOnly || _ctx.ctx.sheet >= _ctx.sheetNames.length - 1,
                    onClick: _cache[298] || (_cache[298] = $event => {_ctx.closeCtx(); _ctx.moveSheet(_ctx.ctx.sheet, 1)})
                  }, _toDisplayString(_ctx.t('Move right')), 9 /* TEXT, PROPS */, _hoisted_444),
                  _hoisted_445,
                  _createElementVNode("button", {
                    class: "ci danger",
                    disabled: _ctx.book.readOnly || _ctx.sheetNames.length < 2,
                    onClick: _cache[299] || (_cache[299] = $event => {_ctx.closeCtx(); _ctx.deleteSheet(_ctx.ctx.sheet)})
                  }, _toDisplayString(_ctx.t('Delete sheet')), 9 /* TEXT, PROPS */, _hoisted_446)
                ], 64 /* STABLE_FRAGMENT */))
              : (_ctx.ctx.kind === 'col' || _ctx.ctx.kind === 'row')
                ? (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                    _createElementVNode("div", _hoisted_447, _toDisplayString(_ctx.ctx.kind === 'col' ? _ctx.t('Column {n}', { n: _ctx.colLetter(_ctx.ctx.col) }) : _ctx.t('Row {n}', { n: _ctx.ctx.row + 1 })), 1 /* TEXT */),
                    (_ctx.ctx.kind === 'col')
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[300] || (_cache[300] = $event => {_ctx.closeCtx(); _ctx.insertCols(0)})
                          }, _toDisplayString(_ctx.t('Insert columns before')), 9 /* TEXT, PROPS */, _hoisted_448),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[301] || (_cache[301] = $event => {_ctx.closeCtx(); _ctx.insertCols(1)})
                          }, _toDisplayString(_ctx.t('Insert columns after')), 9 /* TEXT, PROPS */, _hoisted_449),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[302] || (_cache[302] = $event => {_ctx.closeCtx(); _ctx.deleteCols()})
                          }, _toDisplayString(_ctx.t('Delete columns')), 9 /* TEXT, PROPS */, _hoisted_450),
                          _hoisted_451,
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[303] || (_cache[303] = $event => {_ctx.closeCtx(); _ctx.askColWidth()})
                          }, _toDisplayString(_ctx.t('Column width…')), 9 /* TEXT, PROPS */, _hoisted_452),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[304] || (_cache[304] = $event => {_ctx.closeCtx(); _ctx.fitCols()})
                          }, _toDisplayString(_ctx.t('Optimal width')), 9 /* TEXT, PROPS */, _hoisted_453),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[305] || (_cache[305] = $event => {_ctx.closeCtx(); _ctx.hideCols(true)})
                          }, _toDisplayString(_ctx.t('Hide these columns')), 9 /* TEXT, PROPS */, _hoisted_454),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[306] || (_cache[306] = $event => {_ctx.closeCtx(); _ctx.hideCols(false)})
                          }, _toDisplayString(_ctx.t('Show hidden columns')), 9 /* TEXT, PROPS */, _hoisted_455)
                        ], 64 /* STABLE_FRAGMENT */))
                      : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[307] || (_cache[307] = $event => {_ctx.closeCtx(); _ctx.insertRows(0)})
                          }, _toDisplayString(_ctx.t('Insert rows above')), 9 /* TEXT, PROPS */, _hoisted_456),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[308] || (_cache[308] = $event => {_ctx.closeCtx(); _ctx.insertRows(1)})
                          }, _toDisplayString(_ctx.t('Insert rows below')), 9 /* TEXT, PROPS */, _hoisted_457),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[309] || (_cache[309] = $event => {_ctx.closeCtx(); _ctx.deleteRows()})
                          }, _toDisplayString(_ctx.t('Delete rows')), 9 /* TEXT, PROPS */, _hoisted_458),
                          _hoisted_459,
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[310] || (_cache[310] = $event => {_ctx.closeCtx(); _ctx.askRowHeight()})
                          }, _toDisplayString(_ctx.t('Row height…')), 9 /* TEXT, PROPS */, _hoisted_460),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[311] || (_cache[311] = $event => {_ctx.closeCtx(); _ctx.fitRows()})
                          }, _toDisplayString(_ctx.t('Optimal height')), 9 /* TEXT, PROPS */, _hoisted_461),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[312] || (_cache[312] = $event => {_ctx.closeCtx(); _ctx.hideRows(true)})
                          }, _toDisplayString(_ctx.t('Hide these rows')), 9 /* TEXT, PROPS */, _hoisted_462),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[313] || (_cache[313] = $event => {_ctx.closeCtx(); _ctx.hideRows(false)})
                          }, _toDisplayString(_ctx.t('Show hidden rows')), 9 /* TEXT, PROPS */, _hoisted_463)
                        ], 64 /* STABLE_FRAGMENT */)),
                    _hoisted_464,
                    _createElementVNode("button", {
                      class: "ci",
                      disabled: _ctx.book.readOnly,
                      onClick: _cache[314] || (_cache[314] = $event => {_ctx.closeCtx(); _ctx.clearCells('all')})
                    }, _toDisplayString(_ctx.t('Clear contents')), 9 /* TEXT, PROPS */, _hoisted_465)
                  ], 64 /* STABLE_FRAGMENT */))
                : (_ctx.ctx.kind === 'field')
                  ? (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
                      _createElementVNode("button", {
                        class: "ci",
                        onClick: _cache[315] || (_cache[315] = $event => (_ctx.fieldCmd('cut')))
                      }, [
                        _createElementVNode("span", null, _toDisplayString(_ctx.t('Cut')), 1 /* TEXT */),
                        _hoisted_466
                      ]),
                      _createElementVNode("button", {
                        class: "ci",
                        onClick: _cache[316] || (_cache[316] = $event => (_ctx.fieldCmd('copy')))
                      }, [
                        _createElementVNode("span", null, _toDisplayString(_ctx.t('Copy')), 1 /* TEXT */),
                        _hoisted_467
                      ]),
                      _createElementVNode("button", {
                        class: "ci",
                        onClick: _cache[317] || (_cache[317] = $event => (_ctx.fieldCmd('paste')))
                      }, [
                        _createElementVNode("span", null, _toDisplayString(_ctx.t('Paste')), 1 /* TEXT */),
                        _hoisted_468
                      ])
                    ], 64 /* STABLE_FRAGMENT */))
                  : (_openBlock(), _createElementBlock(_Fragment, { key: 4 }, [
                      _createElementVNode("div", _hoisted_469, _toDisplayString(_ctx.selText), 1 /* TEXT */),
                      _createElementVNode("button", {
                        class: "ci",
                        disabled: _ctx.book.readOnly,
                        onClick: _cache[318] || (_cache[318] = $event => {_ctx.closeCtx(); _ctx.clipCut()})
                      }, [
                        _createElementVNode("span", null, _toDisplayString(_ctx.t('Cut')), 1 /* TEXT */),
                        _hoisted_471
                      ], 8 /* PROPS */, _hoisted_470),
                      _createElementVNode("button", {
                        class: "ci",
                        onClick: _cache[319] || (_cache[319] = $event => {_ctx.closeCtx(); _ctx.clipCopy()})
                      }, [
                        _createElementVNode("span", null, _toDisplayString(_ctx.t('Copy')), 1 /* TEXT */),
                        _hoisted_472
                      ]),
                      _createElementVNode("button", {
                        class: "ci",
                        disabled: _ctx.book.readOnly,
                        onClick: _cache[320] || (_cache[320] = $event => {_ctx.closeCtx(); _ctx.clipPasteButton()})
                      }, [
                        _createElementVNode("span", null, _toDisplayString(_ctx.t('Paste')), 1 /* TEXT */),
                        _hoisted_474
                      ], 8 /* PROPS */, _hoisted_473),
                      _createElementVNode("button", {
                        class: "ci",
                        disabled: _ctx.book.readOnly,
                        onClick: _cache[321] || (_cache[321] = $event => {_ctx.closeCtx(); _ctx.clipPasteButton('values')})
                      }, [
                        _createElementVNode("span", null, _toDisplayString(_ctx.t('Paste values only')), 1 /* TEXT */),
                        _hoisted_476
                      ], 8 /* PROPS */, _hoisted_475),
                      _hoisted_477,
                      _createElementVNode("div", {
                        class: "ci has-sub",
                        onMouseenter: _cache[326] || (_cache[326] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
                        onClick: _cache[327] || (_cache[327] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
                      }, [
                        _createElementVNode("span", null, _toDisplayString(_ctx.t('Insert')), 1 /* TEXT */),
                        _hoisted_478,
                        _createElementVNode("div", _hoisted_479, [
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[322] || (_cache[322] = $event => {_ctx.closeCtx(); _ctx.insertRows(0)})
                          }, _toDisplayString(_ctx.t('Rows above')), 9 /* TEXT, PROPS */, _hoisted_480),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[323] || (_cache[323] = $event => {_ctx.closeCtx(); _ctx.insertRows(1)})
                          }, _toDisplayString(_ctx.t('Rows below')), 9 /* TEXT, PROPS */, _hoisted_481),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[324] || (_cache[324] = $event => {_ctx.closeCtx(); _ctx.insertCols(0)})
                          }, _toDisplayString(_ctx.t('Columns before')), 9 /* TEXT, PROPS */, _hoisted_482),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[325] || (_cache[325] = $event => {_ctx.closeCtx(); _ctx.insertCols(1)})
                          }, _toDisplayString(_ctx.t('Columns after')), 9 /* TEXT, PROPS */, _hoisted_483)
                        ])
                      ], 32 /* NEED_HYDRATION */),
                      _createElementVNode("div", {
                        class: "ci has-sub",
                        onMouseenter: _cache[330] || (_cache[330] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
                        onClick: _cache[331] || (_cache[331] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
                      }, [
                        _createElementVNode("span", null, _toDisplayString(_ctx.t('Delete')), 1 /* TEXT */),
                        _hoisted_484,
                        _createElementVNode("div", _hoisted_485, [
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[328] || (_cache[328] = $event => {_ctx.closeCtx(); _ctx.deleteRows()})
                          }, _toDisplayString(_ctx.t('Rows')), 9 /* TEXT, PROPS */, _hoisted_486),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[329] || (_cache[329] = $event => {_ctx.closeCtx(); _ctx.deleteCols()})
                          }, _toDisplayString(_ctx.t('Columns')), 9 /* TEXT, PROPS */, _hoisted_487)
                        ])
                      ], 32 /* NEED_HYDRATION */),
                      _createElementVNode("div", {
                        class: "ci has-sub",
                        onMouseenter: _cache[335] || (_cache[335] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
                        onClick: _cache[336] || (_cache[336] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
                      }, [
                        _createElementVNode("span", null, _toDisplayString(_ctx.t('Clear')), 1 /* TEXT */),
                        _hoisted_488,
                        _createElementVNode("div", _hoisted_489, [
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[332] || (_cache[332] = $event => {_ctx.closeCtx(); _ctx.clearCells('contents')})
                          }, [
                            _createElementVNode("span", null, _toDisplayString(_ctx.t('Contents')), 1 /* TEXT */),
                            _hoisted_491
                          ], 8 /* PROPS */, _hoisted_490),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[333] || (_cache[333] = $event => {_ctx.closeCtx(); _ctx.clearCells('formats')})
                          }, _toDisplayString(_ctx.t('Formats')), 9 /* TEXT, PROPS */, _hoisted_492),
                          _createElementVNode("button", {
                            class: "ci",
                            disabled: _ctx.book.readOnly,
                            onClick: _cache[334] || (_cache[334] = $event => {_ctx.closeCtx(); _ctx.clearCells('all')})
                          }, _toDisplayString(_ctx.t('Everything')), 9 /* TEXT, PROPS */, _hoisted_493)
                        ])
                      ], 32 /* NEED_HYDRATION */),
                      _hoisted_494,
                      _createElementVNode("button", {
                        class: "ci",
                        disabled: _ctx.book.readOnly,
                        onClick: _cache[337] || (_cache[337] = $event => {_ctx.closeCtx(); _ctx.sortSel(1)})
                      }, _toDisplayString(_ctx.t('Sort ascending')), 9 /* TEXT, PROPS */, _hoisted_495),
                      _createElementVNode("button", {
                        class: "ci",
                        disabled: _ctx.book.readOnly,
                        onClick: _cache[338] || (_cache[338] = $event => {_ctx.closeCtx(); _ctx.sortSel(-1)})
                      }, _toDisplayString(_ctx.t('Sort descending')), 9 /* TEXT, PROPS */, _hoisted_496),
                      _createElementVNode("button", {
                        class: "ci",
                        disabled: _ctx.book.readOnly,
                        onClick: _cache[339] || (_cache[339] = $event => {_ctx.closeCtx(); _ctx.toggleMerge()})
                      }, _toDisplayString(_ctx.selIsMerged ? _ctx.t('Unmerge cells') : _ctx.t('Merge cells')), 9 /* TEXT, PROPS */, _hoisted_497),
                      _createElementVNode("button", {
                        class: "ci",
                        disabled: _ctx.book.readOnly,
                        onClick: _cache[340] || (_cache[340] = $event => {_ctx.closeCtx(); _ctx.openCellProps('number')})
                      }, [
                        _createElementVNode("span", null, _toDisplayString(_ctx.t('Cell properties…')), 1 /* TEXT */),
                        _hoisted_499
                      ], 8 /* PROPS */, _hoisted_498),
                      (_ctx.ai.show)
                        ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                            _hoisted_500,
                            _createElementVNode("button", {
                              class: "ci",
                              onClick: _cache[341] || (_cache[341] = $event => {_ctx.closeCtx(); _ctx.aiAskAboutCell()})
                            }, "🤖 " + _toDisplayString(_ctx.t('Ask the assistant about this cell')), 1 /* TEXT */)
                          ], 64 /* STABLE_FRAGMENT */))
                        : _createCommentVNode("v-if", true)
                    ], 64 /* STABLE_FRAGMENT */))
        ], 38 /* CLASS, STYLE, NEED_HYDRATION */))
      : _createCommentVNode("v-if", true),
    (_ctx.toast)
      ? (_openBlock(), _createElementBlock("div", _hoisted_501, _toDisplayString(_ctx.toast), 1 /* TEXT */))
      : _createCommentVNode("v-if", true)
  ], 34 /* CLASS, NEED_HYDRATION */))
}
})();

  const PALETTE = ['#000000', '#444444', '#777777', '#aaaaaa', '#dddddd', '#ffffff', '#ffff00', '#ffd966',
    '#f4b183', '#ff0000', '#c00000', '#7030a0', '#0070c0', '#00b0f0', '#00b050', '#92d050',
    '#fff2cc', '#fce4d6', '#ffc7ce', '#e2efda', '#ddebf7', '#ede7f6', '#d9d9d9', '#bdd7ee'];
  const FONTS = ['Noto Sans JP', 'Noto Serif JP', 'Hiragino Sans', 'Meiryo', 'Yu Gothic', 'MS PGothic', 'MS PMincho', 'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New', 'Roboto', 'Segoe UI'];
  const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];

  const app = createApp({
    render,
    data() {
      return {
        version: '',
        logo: LOGO,
        icons: ICONS,
        palette: PALETTE,
        fontChoices: FONTS,
        fontSizes: FONT_SIZES,
        sideOpen: true,
        narrow: false,
        coarse: false,
        i18nTick: 0,
        // bumped whenever the sheets (kept outside Vue) change in a way the chrome shows
        tick: 0,
        books: [],
        book: { id: 0, name: '', path: '', etag: '', readOnly: false, download: true },
        active: 0,
        dirty: false,
        saving: false,
        saveError: '',
        savedAt: 0,
        opening: false,
        settings: { theme: 'auto', language: 'auto', languages: [], folder: 'CalcBase', autosave: true, versionKeep: 10, versionWhen: 'manual',
          enterMoves: 'down', aiW: 500, aiU: 'px', showGrid: true, font: 'Noto Sans JP', fontSize: 11 },
        settingsOpen: false,
        setTab: 'view',
        themeOptions: [
          { id: 'auto', label: 'Default (match Nextcloud)', hint: 'Follows whatever theme Nextcloud is using' },
          { id: 'light', label: 'Light', hint: 'Always light, whatever Nextcloud does' },
          { id: 'dark', label: 'Dark', hint: 'Always dark, whatever Nextcloud does' },
        ],
        zoom: 100,
        menu: '',
        // the selection, mirrored from the grid for the chrome
        selText: 'A1',
        selCount: 1,
        stats: { sum: '', avg: '', count: 0 },
        fmtNow: { b: 0, i: 0, u: 0, strike: 0, color: '', bg: '', ha: '', va: '', wrap: 0, font: '', size: '', fmt: '' },
        // the cell being edited
        edit: { on: false, text: '', mode: '', r: 0, c: 0, style: {}, wrap: false, hints: [], hintIdx: 0, sig: '', caret: 0, source: 'cell' },
        fbarFocused: false,
        composing: false,
        canUndo: false,
        canRedo: false,
        find: { open: false, query: '', replace: '', hits: [], index: 0, caseSensitive: false, formulas: false },
        renameSheet: { idx: -1, text: '' },
        ctx: { open: false, x: 0, y: 0, flip: false, tall: 0, kind: 'cell', book: null, sheet: -1, col: -1, row: -1 },
        vers: { open: false, id: 0, title: '', list: [], preview: '' },
        htmlOpen: false, htmlText: '',
        cellPropsOpen: false, cellTab: 'number',
        cellProps: { fmt: '', ha: '', va: '', wrap: false, font: '', size: '', b: false, i: false, u: false, strike: false, color: '', bg: '' },
        numUi: { cat: 'general', dec: 2, sep: true, cur: '¥', red: false, date: 'yyyy/mm/dd', time: 'h:mm' },
        bord: { style: 'solid', width: 1, colour: '#000000', edges: { top: 'keep', bottom: 'keep', left: 'keep', right: 'keep', insideH: 'keep', insideV: 'keep' } },
        fxOpen: false, fxQuery: '', fxSel: '', fxGroup: '',
        printOpen: false,
        print: { range: 'sheet', paper: 'A4', orientation: 'portrait', margins: { t: 15, r: 15, b: 15, l: 15 }, grid: true, header: true, fit: true, headings: false },
        ask: { open: false, title: '', label: '', value: '', tip: '', number: false, min: null, max: null, resolve: null },
        picker: { open: false, mode: 'folder', path: '', items: [], busy: false, chosen: '', resolve: null },
        exportOpen: false, exportFmt: 'xlsx', exporting: false,
        filterPop: { open: false, x: 0, y: 0, col: -1, values: [], checked: new Set() },
        // The AI assistant: shown only when AI-Hub is there and the administrator allows this person.
        ai: { show: false, ready: false, reason: '', model: '', open: false, msgs: [], input: '', busy: false, error: '', composing: false, ask: 0 },
        toast: '',
      };
    },
    computed: {
      settingTabs() {
        this.i18nTick;
        return [
          { key: 'view', icon: '🎨', label: this.t('Appearance and language') },
          { key: 'edit', icon: '✏️', label: this.t('Editing') },
          { key: 'save', icon: '💾', label: this.t('Saving') },
        ];
      },
      cellTabs() {
        this.i18nTick;
        return [{ key: 'number', label: this.t('Number format') }, { key: 'align', label: this.t('Alignment') }, { key: 'font', label: this.t('Font') },
          { key: 'border', label: this.t('Borders') }, { key: 'fill', label: this.t('Background') }];
      },
      numCats() {
        this.i18nTick;
        return [{ key: 'general', label: this.t('General') }, { key: 'number', label: this.t('Number') }, { key: 'currency', label: this.t('Currency') },
          { key: 'percent', label: this.t('Percent') }, { key: 'date', label: this.t('Date') }, { key: 'time', label: this.t('Time') },
          { key: 'sci', label: this.t('Scientific') }, { key: 'text', label: this.t('Text') }, { key: 'custom', label: this.t('Custom') }];
      },
      numCatAbout() {
        this.i18nTick;
        return {
          general: this.t('Shows the number as it is.'), number: this.t('A fixed number of decimal places, with or without thousands separators.'),
          currency: this.t('A currency symbol in front, as ¥1,200.'), percent: this.t('Multiplied by 100 with a % sign: 0.12 shows as 12%.'),
          date: this.t('A date. The cell holds the day count; the format only chooses how it is shown.'), time: this.t('A time of day.'),
          sci: this.t('Powers of ten, as 1.23E+05.'), text: this.t('Shown exactly as typed, even when it looks like a number.'),
          custom: this.t('A format code as LibreOffice Calc and Excel write them.'),
        }[this.numUi.cat] || '';
      },
      numExamples() {
        return ['General', '0', '0.00', '#,##0', '#,##0.00', '#,##0;[Red]-#,##0', '0%', '0.00%', '0.00E+00', 'yyyy/mm/dd', 'yyyy-mm-dd', 'yyyy年m月d日', 'ggge年m月d日', 'm/d', 'h:mm', 'h:mm:ss', 'yyyy/mm/dd h:mm', '¥#,##0', '$#,##0.00', '@'].map((code) => ({ code }));
      },
      numPreview() { return this.numSampleOf(this.cellProps.fmt); },
      numFormats() {
        this.i18nTick;
        const v = 1234.5;
        const d = Calc.parseInput('2026/10/5', 'ja').v;
        return [
          { code: 'General', label: this.t('General'), sample: '1234.5' },
          { code: '#,##0.00', label: this.t('Number'), sample: Calc.format(v, 'n', '#,##0.00', 'ja') },
          { code: '¥#,##0', label: this.t('Currency'), sample: Calc.format(v, 'n', '¥#,##0', 'ja') },
          { code: '0%', label: this.t('Percent'), sample: Calc.format(0.125, 'n', '0%', 'ja') },
          { code: 'yyyy/mm/dd', label: this.t('Date'), sample: Calc.format(d, 'n', 'yyyy/mm/dd', 'ja') },
          { code: 'yyyy年m月d日', label: this.t('Date (Japanese)'), sample: Calc.format(d, 'n', 'yyyy年m月d日', 'ja') },
          { code: 'h:mm', label: this.t('Time'), sample: Calc.format(0.4375, 'n', 'h:mm', 'ja') },
          { code: '@', label: this.t('Text'), sample: 'abc' },
        ];
      },
      numFmtLabel() {
        const code = this.fmtNow.fmt || 'General';
        const hit = this.numFormats.find((f) => f.code === code);
        if (hit) { return hit.label; }
        if (isDateFmt(code)) { return this.t('Date'); }
        if (/%/.test(code)) { return this.t('Percent'); }
        return code;
      },
      borderPresets() {
        this.i18nTick;
        return [{ key: 'all', label: this.t('All') }, { key: 'outer', label: this.t('Outline') }, { key: 'inner', label: this.t('Inside') }, { key: 'none', label: this.t('None') },
          { key: 'top', label: this.t('Top') }, { key: 'bottom', label: this.t('Bottom') }, { key: 'left', label: this.t('Left') }, { key: 'right', label: this.t('Right') }];
      },
      borderStyles() {
        this.i18nTick;
        return [{ key: 'solid', w: 1, label: this.t('Solid') }, { key: 'dashed', w: 1, label: this.t('Dashed') }, { key: 'dotted', w: 1, label: this.t('Dotted') }, { key: 'double', w: 3, label: this.t('Double') }, { key: 'none', w: 0, label: this.t('None') }];
      },
      bordEdges() { return ['top', 'bottom', 'left', 'right', 'insideH', 'insideV']; },
      cellStyleName() {
        this.i18nTick;
        return this.cellProps.b && this.cellProps.i ? this.t('Bold italic') : this.cellProps.b ? this.t('Bold') : this.cellProps.i ? this.t('Italic') : this.t('Regular');
      },
      sheetNames() { this.tick; return UIS.map((u) => u.name); },
      stateText() {
        this.i18nTick;
        if (this.book.readOnly) { return this.t('Read-only'); }
        if (this.saving) { return this.t('Saving…'); }
        if (!this.book.id) { return ''; }
        if (this.dirty && this.saveError) { return this.t('Could not save: {msg}', { msg: this.saveError }); }
        if (this.dirty) { return this.t('Unsaved changes'); }
        return this.savedAt ? this.t('Saved {time}', { time: this.when(this.savedAt / 1000) }) : this.t('Saved');
      },
      nameBoxText() { return this.selText; },
      fbarText() { return this.edit.on ? this.edit.text : this.curInput; },
      curInput() { this.tick; return this.inputAt(this.sel.cur.r, this.sel.cur.c); },
      selIsMerged() { this.tick; const sh = this.sheet(); if (!sh) { return false; } const g = this.selRange(); return sh.merges.some((m) => m.r0 === g.r0 && m.c0 === g.c0 && m.r1 === g.r1 && m.c1 === g.c1); },
      selSpan() { const g = this.selRange(); return { rows: g.r1 - g.r0 + 1, cols: g.c1 - g.c0 + 1 }; },
      hasFilter() { this.tick; const sh = this.sheet(); return !!(sh && sh.filter); },
      hasFreeze() { this.tick; const sh = this.sheet(); return !!(sh && sh.freeze); },
      gridOn() { this.tick; const sh = this.sheet(); return !sh || sh.grid !== false; },
      filterAllChecked() { return this.filterPop.values.every((v) => this.filterPop.checked.has(v)); },
      fxGroups() { const seen = []; ((Calc.functions && Calc.functions()) || []).forEach((f) => { if (f.group && !seen.includes(f.group)) { seen.push(f.group); } }); return seen; },
      fxList() {
        this.i18nTick;
        const q = this.fxQuery.trim().toLowerCase();
        let all = (Calc.functions && Calc.functions()) || [];
        if (this.fxGroup) { all = all.filter((f) => f.group === this.fxGroup); }
        if (!q) { return all; }
        return all.filter((f) => f.name.toLowerCase().includes(q) || String(f.description || '').toLowerCase().includes(q) || this.t(f.description || '').toLowerCase().includes(q) || this.t(f.group || '').toLowerCase().includes(q));
      },
      fxCurrent() { return this.fxList.find((f) => f.name === this.fxSel) || this.fxList[0] || null; },
      hintsStyle() {
        const base = this.edit.source === 'bar' ? (this.$refs.finput && this.$refs.finput.getBoundingClientRect()) : (this.$refs.editor && this.$refs.editor.getBoundingClientRect());
        if (!base) { return { display: 'none' }; }
        const left = Math.min(base.left, window.innerWidth - 300);
        return { left: Math.max(4, left) + 'px', top: Math.min(base.bottom + 4, window.innerHeight - 160) + 'px' };
      },
      sigHtml() {
        const s = this.edit.sig;
        if (!s) { return ''; }
        const f = ((Calc.functions && Calc.functions()) || []).find((x) => x.name === s.name);
        if (!f) { return ''; }
        const args = String(f.args || '').split(/;\s*/).map((a, i) => (i === s.arg ? '<span class="cur">' + esc(a) + '</span>' : esc(a)));
        return '<b>' + esc(f.name) + '</b>(' + args.join('; ') + ')<span class="d">' + esc(this.t(f.description || '')) + '</span>';
      },
      paperNames() { return Object.keys(PAPERS); },
    },

    methods: {
      t(text, vars) { return T(text, vars); },
      notify(msg, ms) {
        this.toast = msg;
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { this.toast = ''; }, ms || 2600);
      },
      when(ts) {
        if (!ts) { return ''; }
        const d = new Date(ts * 1000);
        const today = new Date();
        return d.toDateString() === today.toDateString() ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
      },
      size(bytes) {
        const kb = (bytes || 0) / 1024;
        return kb < 1024 ? Math.max(1, Math.round(kb)) + ' KB' : (kb / 1024).toFixed(1) + ' MB';
      },
      colLetter(c) { return colName(c); },
      sheet() { return UIS[this.active] || null; },
      sheetName() { const sh = this.sheet(); return sh ? sh.name : ''; },
      /** A question with one answer, in the app's own dialogue rather than the browser's. */
      askFor(opts) {
        return new Promise((resolve) => {
          this.ask = Object.assign({ open: true, title: '', label: '', value: '', tip: '', number: false, min: null, max: null }, opts, { resolve });
          this.$nextTick(() => { const el = this.$refs.askInput; if (el) { el.focus(); el.select(); } });
        });
      },
      askAnswer(v) {
        const res = this.ask.resolve;
        this.ask.open = false; this.ask.resolve = null;
        if (res) { res(v == null ? null : (this.ask.number ? Number(v) : String(v))); }
      },

      // ---- books ----
      async loadBooks() {
        try {
          const r = await api('books');
          this.books = (Array.isArray(r) ? r : (r.books || [])).map((b) => Object.assign({}, b, { title: b.title || String(b.name || '').replace(/\.html?$/i, '') }));
        } catch (e) { this.notify(this.t('Could not read the list of books: {msg}', { msg: e.message })); }
      },
      /** The next name not yet in the list: 無題のブック, 無題のブック 2, 3 … */
      freshBookName() {
        const base = this.t('Untitled book');
        const taken = (n) => this.books.some((b) => (b.title || String(b.name || '').replace(/\.html?$/i, '')) === n);
        if (!taken(base)) { return base; }
        let n = 2;
        while (taken(base + ' ' + n)) { n += 1; }
        return base + ' ' + n;
      },
      async newBook() {
        const name = await this.askFor({ title: this.t('New book'), label: this.t('Name'), value: this.freshBookName() });
        if (name == null) { return; }
        try {
          const created = await api('books', { method: 'POST', body: { name: (name.trim() || this.t('Untitled book')) } });
          await this.loadBooks();
          await this.openBook(created.id);
          this.notify(this.t('Created {name}', { name: created.title || String(created.name || '').replace(/\.html?$/i, '') }));
        } catch (e) { this.notify(this.t('Could not create the book: {msg}', { msg: e.message })); }
      },
      /** Everything on the screen into its file before another book takes its place. */
      async leaveBook() {
        if (!this.book.id || (!this.dirty && !this.saving)) { return true; }
        if (await this.saveNow(true)) { return true; }
        return !!window.confirm(this.t('Changes to {name} could not be saved. Go on anyway? What was not saved will be lost.', { name: this.book.name || this.t('Untitled book') }));
      },
      async openBook(id) {
        if (this.narrow) { this.sideOpen = false; }
        const ticket = (this._openTicket || 0) + 1;
        this._openTicket = ticket;
        if (!(await this.leaveBook())) { return; }
        if (ticket !== this._openTicket) { return; }
        this.opening = true;
        try {
          const d = await api('books/' + id);
          if (ticket !== this._openTicket) { return; }
          this.cancelEdit();
          this.loadContent(d.content || '', d.name);
          this.book = { id: d.id, name: d.title || String(d.name || '').replace(/\.html?$/i, ''), path: d.path || '', folder: d.folder || '', etag: d.etag || '', readOnly: !!d.readOnly, download: d.canDownload !== false };
          this.dirty = false; this.saveError = ''; this.savedAt = 0;
          this.history = []; this.redoStack = []; this.canUndo = false; this.canRedo = false;
          window.localStorage.setItem('cb-last-book', String(d.id));
          this.$nextTick(() => { this.layout(); this.focusGrid(); });
        } catch (e) { this.notify(this.t('Could not open the book: {msg}', { msg: e.message })); }
        finally { if (ticket === this._openTicket) { this.opening = false; } }
      },
      /** The file's text becomes the engine's workbook and the page's sheets. */
      loadContent(html, name) {
        const parsed = parseBook(html);
        wb = Calc.workbook({ locale: uiLang() });
        wb.load(parsed.model);
        if (wb.recalc) { try { wb.recalc(); } catch (e) { /* the engine already recalculated on load */ } }
        UIS = parsed.uis;
        UIS.forEach((u) => { if (!u.grid && this.settings.showGrid === false) { u.grid = false; } });
        this.active = parsed.model.active || 0;
        this.sel = { ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], cur: { r: 0, c: 0 }, anchor: { r: 0, c: 0 } };
        this.tick += 1;
        this.syncSel();
        if (this.$refs.scroller) { this.$refs.scroller.scrollTop = 0; this.$refs.scroller.scrollLeft = 0; }
      },
      currentHtml() {
        const read = (name, r, c) => wb.get(name, r, c);
        read.used = (name) => { const u = UIS.find((x) => x.name === name); return u ? { r1: u.maxR, c1: u.maxC } : null; };
        read.font = (meta) => { const f = this.cellFont(meta, 1); const st = (meta && meta.s) || {}; return fontCss(st.b, f.px, f.family); };
        this.refreshUsed();
        return buildHtml(this.book.name || this.t('Untitled book'), UIS, read, this.active, uiLang());
      },
      /** How far each sheet is used, from the engine's cells (the page's own note grows as cells are typed, and this trims it). */
      refreshUsed() {
        const m = wb.toModel();
        m.sheets.forEach((s) => {
          const u = UIS.find((x) => x.name === s.name);
          if (!u) { return; }
          let r1 = 0; let c1 = 0;
          // A cell the engine keeps only for its format (cleared, format left) is not used.
          Object.keys(s.cells).forEach((k) => { const cell = s.cells[k]; if (!cell.t && !cell.f) { return; } const p = parseRef(k); if (p) { if (p.r > r1) { r1 = p.r; } if (p.c > c1) { c1 = p.c; } } });
          u.maxR = r1; u.maxC = c1;
        });
      },
      async applyTitle() {
        if (!this.book.id) { return; }
        const name = (this.book.name || '').trim() || this.t('Untitled book');
        this.book.name = name;
        try {
          const r = await api('books/' + this.book.id + '/rename', { method: 'POST', body: { name } });
          if (r && r.name) { this.book.name = String(r.name).replace(/\.html?$/i, ''); }
          if (r && r.etag) { this.book.etag = r.etag; }
          this.touch();
          await this.loadBooks();
        } catch (e) { this.notify(this.t('Could not rename: {msg}', { msg: e.message })); }
      },
      async renameBook(b) {
        this.closeCtx();
        const name = await this.askFor({ title: this.t('Rename'), label: this.t('Name'), value: String(b.name || '').replace(/\.html?$/i, '') });
        if (name == null || !name.trim()) { return; }
        try {
          if (b.id === this.book.id) { this.book.name = name.trim(); await this.applyTitle(); return; }
          await api('books/' + b.id + '/rename', { method: 'POST', body: { name: name.trim() } });
          await this.loadBooks();
        } catch (e) { this.notify(this.t('Could not rename: {msg}', { msg: e.message })); }
      },
      async duplicateBook(id) {
        this.closeCtx();
        if (id === this.book.id) { await this.saveNow(); }
        try {
          const copy = await api('books/' + id + '/duplicate', { method: 'POST' });
          await this.loadBooks();
          await this.openBook(copy.id);
        } catch (e) { this.notify(this.t('Could not duplicate: {msg}', { msg: e.message })); }
      },
      async moveBook(b) {
        this.closeCtx();
        const folder = await this.pickFolder();
        if (folder == null) { return; }
        try {
          if (b.id === this.book.id) { await this.saveNow(); }
          await api('books/' + b.id + '/move', { method: 'POST', body: { folder } });
          await this.loadBooks();
        } catch (e) { this.notify(this.t('Could not move it: {msg}', { msg: e.message })); }
      },
      async deleteBook(b) {
        this.closeCtx();
        if (!window.confirm(this.t('Move “{name}” to the trash?', { name: b.title || b.name }))) { return; }
        try {
          await api('books/' + b.id, { method: 'DELETE' });
          await this.loadBooks();
          if (b.id === this.book.id) {
            this.cancelEdit();
            this.book = { id: 0, name: '', path: '', folder: '', etag: '', readOnly: false, download: true };
            this.dirty = false; UIS = []; this.tick += 1;
            const next = this.books[0];
            if (next) { await this.openBook(next.id); }
          }
        } catch (e) { this.notify(this.t('Could not delete: {msg}', { msg: e.message })); }
      },
      /** The .html itself, saved by the browser (works on every server; respects a share that forbids downloads). */
      async downloadBook(b) {
        this.closeCtx();
        try {
          let html; let name = String(b.name || 'book');
          if (b.id === this.book.id) { html = this.currentHtml(); name = this.book.name || name; } else { const d = await api('books/' + b.id); html = d.content; }
          const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = /\.html?$/i.test(name) ? name : name + '.html';
          document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        } catch (e) { this.notify(this.t('Could not download: {msg}', { msg: e.message })); }
      },
      showSource() { this.menu = ''; this.htmlText = this.currentHtml(); this.htmlOpen = true; },

      // ---- the Files picker ----
      pickFolder() { return this.openPicker('folder'); },
      openPicker(mode) {
        return new Promise((resolve) => {
          this.picker = { open: true, mode, path: '', items: [], busy: true, chosen: '', resolve };
          this.pickerLoad('');
        });
      },
      async pickerLoad(path) {
        this.picker.busy = true; this.picker.path = path; this.picker.chosen = '';
        try {
          const r = await api('files/browse?path=' + encodeURIComponent(path));
          const items = (r.entries || r.items || []).map((it) => ({ name: it.name, path: it.path || (path + '/' + it.name).replace(/\/+/g, '/'), dir: !!(it.is_dir || it.dir || it.type === 'dir' || it.type === 'folder'), size: it.size || 0, ok: /\.(csv|tsv|txt|ods|xlsx)$/i.test(it.name || ''), id: it.id || it.fileId || 0 }));
          items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
          this.picker.items = this.picker.mode === 'import' ? items : items.filter((it) => it.dir);
        } catch (e) { this.picker.items = []; this.notify(this.t('Could not read the folder: {msg}', { msg: e.message })); }
        this.picker.busy = false;
      },
      pickerUp() { const p = this.picker.path.replace(/\/[^/]*$/, ''); this.pickerLoad(p); },
      pickerClick(it) { if (it.dir && this.picker.mode === 'folder') { this.picker.chosen = it.path; } else if (!it.dir && it.ok) { this.picker.chosen = it.path; this.picker.chosenItem = it; } },
      pickerOpen(it) { if (it.dir) { this.pickerLoad(it.path); } else if (it.ok) { this.picker.chosen = it.path; this.picker.chosenItem = it; this.pickerAnswer(it.path); } },
      pickerAnswer(v) {
        const res = this.picker.resolve;
        this.picker.open = false; this.picker.resolve = null;
        if (res) { res(v == null ? null : (this.picker.mode === 'import' ? (this.picker.chosenItem || { path: v }) : v)); }
      },
      // ---- import / export ----
      async importBook() {
        const it = await this.openPicker('import');
        if (!it) { return; }
        try {
          const r = await api('import', { method: 'POST', body: { fileId: it.id, path: it.path } });
          const model = r.model || r;
          const name = String(r.name || it.name || 'Imported').replace(/\.(csv|tsv|txt|ods|xlsx|html?)$/i, '');
          const created = await api('books', { method: 'POST', body: { name } });
          await this.loadBooks();
          await this.openBook(created.id);
          // the imported model replaces the empty book
          wb = Calc.workbook({ locale: uiLang() }); wb.load(model); if (wb.recalc) { wb.recalc(); }
          UIS = uisFromModel(model); this.active = Math.min(model.active || 0, UIS.length - 1);
          this.tick += 1; this.touch(); this.layout();
          await this.saveNow(true);
          this.notify(this.t('Imported {name}', { name: it.name }));
        } catch (e) { this.notify(this.t('Could not import: {msg}', { msg: e.message }), 6000); }
      },
      openExport() { this.exportOpen = true; },
      async doExport() {
        this.exporting = true;
        try {
          await this.saveNow();
          const model = toFullModel(wb, UIS, this.active, true);
          const r = await api('export', { method: 'POST', body: { format: this.exportFmt, model, folder: this.book.folder || this.book.path.replace(/\/[^/]*$/, ''), name: this.book.name, sheet: this.exportFmt === 'csv' ? this.sheetName() : undefined } });
          this.exportOpen = false;
          this.notify(this.t('Written to {path}', { path: r.path || r.name || '' }), 5000);
        } catch (e) { this.notify(this.t('Could not export: {msg}', { msg: e.message }), 6000); }
        this.exporting = false;
      },

      // ---- saving ----
      touch() {
        if (this.opening) { return; }
        this._edits = (this._edits || 0) + 1;
        this.dirty = true;
        this.scheduleAutosave();
      },
      scheduleAutosave() {
        clearTimeout(this._saveTimer);
        if (!this.settings.autosave || !this.book.id || this.book.readOnly) { return; }
        this._saveTimer = setTimeout(() => { if (this.dirty) { this.save(false); } }, 2500);
      },
      async save(asked) {
        if (!this.book.id || this.book.readOnly) { return false; }
        if (this.saving) { if (asked) { this._saveAsked = true; } return false; }
        const book = this.book;
        let ok = false;
        this.saving = true;
        const run = (async () => {
          try {
            const edits = this._edits || 0;
            let saved;
            try {
              saved = await api('books/' + book.id, { method: 'PUT', body: { content: this.currentHtml(), etag: book.etag || '', manual: !!asked } });
            } catch (e) {
              if (!e.conflict) { throw e; }
              // 409: the file moved on under this copy. Theirs is taken in and shown;
              // what was typed here stays in the undo stack (said in the toast), as
              // the contract allows for 0.0.1.
              const theirs = e.conflict;
              if (this.book !== book) { return; }
              if (theirs.content) {
                this.cancelEdit();
                this.loadContent(theirs.content, book.name);
                this.layout();
              }
              book.etag = theirs.etag || '';
              this.dirty = false;
              this.saveError = '';
              this.notify(this.t('The book was changed elsewhere, so that version is shown now. Your unsaved edits are not in it; Ctrl+Z still has them.'), 9000);
              ok = true;
              return;
            }
            if (this.book !== book) { book.etag = saved.etag || ''; ok = true; return; }
            book.etag = saved.etag || '';
            this.savedAt = Date.now();
            this.saveError = '';
            if ((this._edits || 0) === edits) { this.dirty = false; }
            const row = this.books.find((b) => b.id === book.id);
            if (row) { if (saved.mtime) { row.mtime = saved.mtime; } if (saved.size) { row.size = saved.size; } }
            ok = true;
          } catch (e) {
            if (this.book === book) {
              this.saveError = e.message || String(e);
              this.notify(this.t('Could not save: {msg}', { msg: this.saveError }), 9000);
            }
          }
        })();
        this._saveRun = run;
        try { await run; } finally { this.saving = false; this._saveRun = null; }
        const asking = !!this._saveAsked;
        this._saveAsked = false;
        if (this.book !== book || !this.dirty) { return ok; }
        if (asking && ok) { return (await this.save(true)) && ok; }
        if (ok) { this.scheduleAutosave(); }
        return ok;
      },
      async saveNow(asked) {
        const book = this.book;
        for (let go = 0; go < 4; go += 1) {
          if (this._saveRun) { try { await this._saveRun; } catch (e) { /* said already */ } }
          if (this.book !== book) { return false; }
          if (!book.id || !this.dirty) { return true; }
          if (this.saving) { continue; }
          const ok = await this.save(asked);
          if (!ok && this.dirty && !this.saving) { return false; }
        }
        return !this.dirty;
      },

      // ---- versions ----
      async openVersions(b) {
        this.closeCtx(); this.menu = '';
        if (!b || !b.id) { return; }
        this.vers = { open: true, id: b.id, title: String(b.name || '').replace(/\.html?$/i, ''), list: [], preview: '' };
        await this.reloadVersions();
      },
      async reloadVersions() {
        try {
          const r = await api('books/' + this.vers.id + '/versions');
          this.vers.list = r.versions || (Array.isArray(r) ? r : []);
        } catch (e) { this.notify(this.t('Could not read the versions: {msg}', { msg: e.message })); }
      },
      /** A version shown read-only: its first sheet as a small table (text only, never as HTML). */
      async previewVersion(number) {
        try {
          const r = await api('books/' + this.vers.id + '/versions/' + number);
          const parsed = parseBook(r.content || '');
          const tmp = Calc.workbook({ locale: uiLang() }); tmp.load(parsed.model); if (tmp.recalc) { tmp.recalc(); }
          const u = parsed.uis[0];
          const rows = [];
          for (let rr = 0; rr <= Math.min(u.maxR, 40); rr += 1) {
            const tds = [];
            for (let cc = 0; cc <= Math.min(u.maxC, 12); cc += 1) { const g = tmp.get(u.name, rr, cc); const meta = u.meta.get(K(rr, cc)); tds.push('<td>' + esc(g.t ? Calc.format(g.v, g.t, fmtOf(meta, g), 'ja') : '') + '</td>'); }
            rows.push('<tr>' + tds.join('') + '</tr>');
          }
          this.vers.preview = '<table>' + rows.join('') + '</table>';
        } catch (e) { this.notify(this.t('Could not read the version: {msg}', { msg: e.message })); }
      },
      async restoreVersion(number) {
        if (Number(this.settings.versionKeep) < 1) {
          this.notify(this.t('Could not put it back: {msg}', { msg: this.t('versions are switched off, so what is in the book now cannot be kept; nothing was put back') }), 9000);
          return;
        }
        if (!window.confirm(this.t('Put version #{n} back? What is in the book now is kept as a version of its own.', { n: String(number).padStart(2, '0') }))) { return; }
        const id = this.vers.id;
        if (id === this.book.id && !(await this.saveNow())) { this.notify(this.t('Could not put it back: {msg}', { msg: this.saveError || this.t('Unsaved changes') }), 9000); return; }
        try {
          const back = await api('books/' + id + '/versions/restore', { method: 'POST', body: { number } });
          await this.reloadVersions();
          await this.loadBooks();
          if (id === this.book.id && back && back.content) {
            this.cancelEdit();
            this.loadContent(back.content, this.book.name);
            this.book.etag = back.etag || this.book.etag;
            this.dirty = false;
            this.layout();
          }
          this.notify(this.t('Version #{n} was put back.', { n: String(number).padStart(2, '0') }));
        } catch (e) { this.notify(this.t('Could not put it back: {msg}', { msg: e.message }), 9000); }
      },

      // ---- settings ----
      openSettings() {
        this.settingsSaved = JSON.stringify(this.settings);
        this.settingsOpen = true;
      },
      pickTheme(id) {
        if (!this.themeOptions.some((o) => o.id === id)) { return; }
        this.settings.theme = id;
        this.applyTheme(id);
      },
      cancelSettings() {
        this.settingsOpen = false;
        if (this.settingsSaved) {
          const was = JSON.parse(this.settingsSaved);
          Object.assign(this.settings, was);
          this.applyTheme(this.settings.theme);
        }
        this.settingsSaved = null;
      },
      aiWidthValue() {
        const u = this.settings.aiU === '%' ? '%' : 'px';
        let n = Number(this.settings.aiW);
        if (!(n > 0)) { n = u === '%' ? 30 : 500; }
        n = u === '%' ? Math.min(60, Math.max(15, n)) : Math.min(1200, Math.max(240, n));
        this.settings.aiW = Math.round(n); this.settings.aiU = u;
        return Math.round(n) + u;
      },
      aiWidth() { return this.aiWidthValue().replace(/%$/, 'vw'); },
      aiWidthChanged() { this.aiWidthValue(); },
      async saveSettings() {
        try {
          await api('settings', { method: 'POST', body: {
            folder: this.settings.folder, theme: this.settings.theme, language: this.settings.language,
            autosave: this.settings.autosave ? '1' : '0',
            versionKeep: this.settings.versionKeep, versionWhen: this.settings.versionWhen,
            enterMoves: this.settings.enterMoves, aiWidth: this.aiWidthValue(),
            gridDefault: this.settings.showGrid ? '1' : '0', font: this.settings.font, fontSize: this.settings.fontSize,
          } });
          window.localStorage.setItem('cb-local', JSON.stringify({ showGrid: this.settings.showGrid, font: this.settings.font, fontSize: this.settings.fontSize, autosave: this.settings.autosave }));
          this.applyTheme(this.settings.theme);
          await this.applyLanguage(this.settings.language);
          this.settingsSaved = null;
          this.settingsOpen = false;
          this.paint();
          await this.loadBooks();
          this.notify(this.t('Settings saved'));
        } catch (e) { this.notify(this.t('Could not save the settings: {msg}', { msg: e.message })); }
      },
      applyTheme(pref) {
        const root = document.getElementById('calcbase-root');
        if (!root) { return; }
        root.dataset.theme = pref;
        if (pref === 'auto') {
          const resolved = ncIsDark();
          if (resolved === null) { delete root.dataset.cbtheme; } else { root.dataset.cbtheme = resolved ? 'dark' : 'light'; }
        } else {
          root.dataset.cbtheme = pref;
        }
      },
      async applyLanguage(lang) {
        if (!lang || lang === 'auto') { i18nOverride = null; } else {
          try {
            const r = await api('i18n/' + encodeURIComponent(lang));
            i18nOverride = (r && r.translations) ? Object.assign({}, r.translations, { __lang: lang }) : { __lang: lang };
          } catch (e) { i18nOverride = null; }
        }
        this.i18nTick += 1;
        this.$forceUpdate();
        this.paint();
      },

      // ---- the AI assistant (through AI-Hub) ----
      async aiLoad() {
        try {
          const st = await api('ai/status');
          Object.assign(this.ai, { show: !!st.show, ready: !!st.ready, reason: st.reason || '', model: st.model || '' });
          const m = /^(\d+(?:\.\d+)?)(px|%)$/.exec(String(st.width || ''));
          if (m && !this._aiWidthFromSettings) { this.settings.aiW = Number(m[1]); this.settings.aiU = m[2]; }
        } catch (e) { this.ai.show = false; }
      },
      aiNotReady() {
        return {
          'no-key': this.t('AI-Hub has no API key yet.'),
          'no-cli': this.t('AI-Hub\'s command line tool is not set up.'),
          'no-model': this.t('AI-Hub has no model chosen yet.'),
          'no-store': this.t('AI-Hub cannot keep an answer on this server.'),
        }[this.ai.reason] || this.t('The assistant is not ready.');
      },
      aiToggle() {
        this.ai.open = !this.ai.open;
        window.localStorage.setItem('cb-ai-open', this.ai.open ? '1' : '0');
        this.$nextTick(() => { this.layout(); if (this.ai.open) { const ta = this.$el && this.$el.querySelector('.ai-col textarea'); if (ta) { ta.focus(); } this.aiScroll(); } });
      },
      aiClear() {
        this.ai.ask += 1;
        Object.assign(this.ai, { msgs: [], busy: false, error: '' });
      },
      aiKey(e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !this.ai.composing && e.keyCode !== 229) { e.preventDefault(); this.aiSend(); }
      },
      aiScroll() { this.$nextTick(() => { const box = this.$refs.aiMsgs; if (box) { box.scrollTop = box.scrollHeight; } }); },
      aiHtml(m) {
        const src = m.role === 'assistant' ? (m.reply != null ? m.reply : m.text) : String(m.text || '');
        let h = esc(src);
        h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
        return h.replace(/\n/g, '<br>');
      },
      /** What the model is shown: the book's name, the sheets, the active sheet's used range as TSV with formulas (capped), the selection. */
      aiContext() {
        const sh = this.sheet();
        const out = { book: this.book.name || '', sheets: UIS.map((u) => u.name), active: sh ? sh.name : '', range: '', tsv: '', selection: { range: this.selText, tsv: '' } };
        if (!sh) { return out; }
        this.refreshUsed();
        const cellText = (r, c) => {
          const g = wb.get(sh.name, r, c);
          if (!g.t) { return ''; }
          const shown = Calc.format(g.v, g.t, this.fmtAt(sh, r, c, g), 'ja');
          return (g.f ? g.f + ' → ' + shown : shown).replace(/[\t\n]/g, ' ');
        };
        const tsvOf = (g) => { const lines = []; for (let r = g.r0; r <= g.r1; r += 1) { const row = []; for (let c = g.c0; c <= g.c1; c += 1) { row.push(cellText(r, c)); } lines.push(row.join('\t')); } return lines.join('\n'); };
        const used = { r0: 0, c0: 0, r1: Math.min(sh.maxR, 300), c1: Math.min(sh.maxC, 40) };
        out.range = rangeName(used); out.tsv = tsvOf(used).slice(0, 20000);
        const sel = this.selRange();
        out.selection = { range: this.selText, tsv: tsvOf({ r0: sel.r0, c0: sel.c0, r1: Math.min(sel.r1, sel.r0 + 100), c1: Math.min(sel.c1, sel.c0 + 30) }).slice(0, 6000) };
        return out;
      },
      aiError(e) {
        const m = String((e && e.message) || e || '');
        if (m === 'busy') { return this.t('Too many questions at once. Wait a moment and ask again.'); }
        if (m === 'not-ready') { return this.aiNotReady(); }
        if (m === 'not-allowed') { return this.t('The administrator has not allowed the assistant for you.'); }
        if (m === 'timeout') { return this.t('No answer came back in time.'); }
        return this.t('The assistant could not answer: {e}', { e: m });
      },
      aiAskAboutCell() {
        if (!this.ai.show) { return; }
        if (!this.ai.open) { this.aiToggle(); }
        const g = wb.get(this.sheetName(), this.sel.cur.r, this.sel.cur.c);
        const addr = refName(this.sel.cur.r, this.sel.cur.c);
        this.ai.input = this.t('Tell me about cell {addr}: {what}', { addr, what: g.f ? g.f : (g.t ? Calc.format(g.v, g.t, '', 'ja') : this.t('(empty)')) });
        this.$nextTick(() => { const ta = this.$el && this.$el.querySelector('.ai-col textarea'); if (ta) { ta.focus(); } });
      },
      async aiSend() {
        const text = this.ai.input.trim();
        if (!text || this.ai.busy || !this.ai.ready) { return; }
        this.ai.input = ''; this.ai.error = '';
        this.ai.msgs.push({ role: 'user', text });
        this.aiScroll();
        const ticket = this.ai.ask;
        const history = this.ai.msgs.slice(0, -1).map((m) => ({ role: m.role, text: m.text }));
        this.ai.busy = true;
        let answer = null;
        try {
          const r = await api('ai/ask', { method: 'POST', body: { history, message: text, context: this.aiContext() } });
          if (!r || !r.id) { throw new Error((r && r.error) || 'not-ready'); }
          const until = Date.now() + 10 * 60 * 1000;
          while (Date.now() < until) {
            await new Promise((res) => setTimeout(res, 1500));
            if (ticket !== this.ai.ask) { return; }
            const x = await api('ai/result/' + encodeURIComponent(r.id));
            if (x.state === 'running') { continue; }
            if (x.state === 'done') { answer = x; break; }
            throw new Error(x.error || x.state);
          }
          if (answer === null) { throw new Error('timeout'); }
        } catch (e) {
          if (ticket === this.ai.ask) { this.ai.busy = false; this.ai.error = this.aiError(e); this.aiScroll(); }
          return;
        }
        if (ticket !== this.ai.ask) { return; }
        const parsed = (answer && typeof answer === 'object' && (typeof answer.reply === 'string' || Array.isArray(answer.edits))) ? { reply: String(answer.reply || answer.text || ''), edits: Array.isArray(answer.edits) ? answer.edits : null, bad: false } : aiAnswer(answer && typeof answer === 'object' ? answer.text : answer);
        const msg = { role: 'assistant', text: parsed.reply || String((answer && answer.text) || ''), reply: parsed.reply, did: '' };
        this.ai.msgs.push(msg);
        if (parsed.edits && parsed.edits.length) { msg.did = this.aiApply(parsed.edits); }
        else if (parsed.bad) { msg.did = this.t('The assistant\'s list of changes could not be read, so nothing was changed.'); }
        this.ai.busy = false;
        this.aiScroll();
      },
      /** The assistant's edits, as one step that Ctrl+Z takes back. */
      aiApply(edits) {
        if (this.book.readOnly) { return this.t('The book is read-only, so nothing was changed.'); }
        let done = 0; let failed = 0;
        this.withStep((rec) => {
          edits.slice(0, 500).forEach((e) => {
            try {
              const sheet = e.sheet ? UIS.find((u) => u.name === e.sheet) : this.sheet();
              const p = parseRef(String(e.cell || ''));
              if (!sheet || !p) { failed += 1; return; }
              rec(sheet, p.r, p.c);
              this.setInputRaw(sheet, p.r, p.c, String(e.input == null ? '' : e.input));
              done += 1;
            } catch (err) { failed += 1; }
          });
        });
        const said = [];
        if (done === 1) { said.push(this.t('Made one change. Ctrl+Z undoes it.')); } else if (done) { said.push(this.t('Made {n} changes. Ctrl+Z undoes them.', { n: done })); }
        if (failed === 1) { said.push(this.t('One of the changes could not be made.')); } else if (failed) { said.push(this.t('{n} of the changes could not be made.', { n: failed })); }
        return said.join(' ');
      },

      // ---- the grid: geometry ----
      z() { return this.zoom / 100; },
      cellFont(meta, z) {
        const s = (meta && meta.s) || {};
        const pt = s.size || this.settings.fontSize || 11;
        return { px: pt * 4 / 3 * z, family: s.font || this.settings.font || 'Noto Sans JP' };
      },
      headWidth(z) {
        const digits = String(Math.max(1, Math.min(MAX_ROWS, (this.extentR || 100)))).length;
        return Math.max(HEAD_W_MIN, 14 + digits * 8) * z;
      },
      /** The virtual size of the sheet: the used range with room beyond it, grown as the person scrolls on (as Calc's scrollbars). */
      layout() {
        const sh = this.sheet(); const vp = this.$refs.scroller;
        if (!sh || !vp) { return; }
        const z = this.z();
        const W = vp.clientWidth; const H = vp.clientHeight;
        const minR = Math.ceil(H / (DEF_ROW_H * z)) + 30; const minC = Math.ceil(W / (DEF_COL_W * z)) + 5;
        let er = Math.max(sh.maxR + 50, sh.extentR || 0, minR);
        let ec = Math.max(sh.maxC + 10, sh.extentC || 0, minC);
        // A browser draws nothing taller than about 33 million pixels, so the scroll range stops there.
        er = Math.min(MAX_ROWS, er, Math.floor(30000000 / (DEF_ROW_H * z)));
        ec = Math.min(MAX_COLS, ec, Math.floor(30000000 / (DEF_COL_W * z)));
        sh.extentR = er; sh.extentC = ec;
        this.extentR = er;
        const headW = this.headWidth(z); const headH = HEAD_H * z;
        const sp = this.$refs.spacer;
        if (sp) { sp.style.width = Math.round(headW + colLeft(sh, ec) * z) + 'px'; sp.style.height = Math.round(headH + rowTop(sh, er) * z) + 'px'; }
        this.paint();
      },
      /** Grows the sheet's scroll range so that a cell can be scrolled to. */
      growTo(r, c) {
        const sh = this.sheet(); if (!sh) { return; }
        let grew = false;
        if (r + 20 > (sh.extentR || 0)) { sh.extentR = Math.min(MAX_ROWS, r + 60); grew = true; }
        if (c + 3 > (sh.extentC || 0)) { sh.extentC = Math.min(MAX_COLS, c + 10); grew = true; }
        if (grew) { this.layout(); }
      },
      onScroll() {
        const sh = this.sheet(); const vp = this.$refs.scroller;
        if (!sh || !vp) { return; }
        // Near the end of the range: more room, as Calc's scrollbar grows.
        if (vp.scrollTop + vp.clientHeight * 2 > vp.scrollHeight && (sh.extentR || 0) < MAX_ROWS) { sh.extentR = Math.min(MAX_ROWS, Math.floor((sh.extentR || 100) * 1.5)); this.layout(); return; }
        if (vp.scrollLeft + vp.clientWidth * 2 > vp.scrollWidth && (sh.extentC || 0) < MAX_COLS) { sh.extentC = Math.min(MAX_COLS, Math.floor((sh.extentC || 20) * 1.5)); this.layout(); return; }
        this.paint();
      },
      /** Where things are, this frame: the frozen split, the visible rows and columns of each quadrant. */
      frame() {
        const sh = this.sheet(); const vp = this.$refs.scroller;
        if (!sh || !vp) { return null; }
        const z = this.z();
        const W = vp.clientWidth; const H = vp.clientHeight; const sx = vp.scrollLeft; const sy = vp.scrollTop;
        const headW = this.headWidth(z); const headH = HEAD_H * z;
        const fr = sh.freeze ? Math.min(sh.freeze.r, 200) : 0; const fc = sh.freeze ? Math.min(sh.freeze.c, 50) : 0;
        const fh = fr ? rowTop(sh, fr) * z : 0; const fw = fc ? colLeft(sh, fc) * z : 0;
        const mainW = Math.max(0, W - headW - fw); const mainH = Math.max(0, H - headH - fh);
        const r0 = rowAtY(sh, (sy + fh) / z); const r1 = Math.min(MAX_ROWS - 1, rowAtY(sh, (sy + fh + mainH) / z) + 1);
        const c0 = colAtX(sh, (sx + fw) / z); const c1 = Math.min(MAX_COLS - 1, colAtX(sh, (sx + fw + mainW) / z) + 1);
        return { sh, z, W, H, sx, sy, headW, headH, fr, fc, fh, fw, mainW, mainH, r0, r1, c0, c1 };
      },
      /** The rectangle of a cell (or its merge) in view coordinates, and whether it is in sight. */
      cellRect(r, c, F) {
        const f = F || this.frame(); if (!f) { return null; }
        const sh = f.sh; const z = f.z;
        const m = mergeAt(sh, r, c);
        const rr0 = m ? m.r0 : r; const cc0 = m ? m.c0 : c; const rr1 = m ? m.r1 : r; const cc1 = m ? m.c1 : c;
        const x = colLeft(sh, cc0) * z; const y = rowTop(sh, rr0) * z;
        const w = (colLeft(sh, cc1 + 1) - colLeft(sh, cc0)) * z; const h = (rowTop(sh, rr1 + 1) - rowTop(sh, rr0)) * z;
        const left = f.headW + x - (cc0 < f.fc ? 0 : f.sx);
        const top = f.headH + y - (rr0 < f.fr ? 0 : f.sy);
        const inX = cc0 < f.fc || (left + w > f.headW + f.fw && left < f.W);
        const inY = rr0 < f.fr || (top + h > f.headH + f.fh && top < f.H);
        return { left, top, w, h, visible: inX && inY, r0: rr0, c0: cc0, r1: rr1, c1: cc1 };
      },
      // ---- the grid: painting ----
      paint() {
        const f = this.frame(); const layers = this.$refs.layers;
        if (!f || !layers) { return; }
        const t0 = performance.now();
        const { sh, z, W, H, headW, headH, fr, fc, fh, fw } = f;
        layers.style.width = W + 'px'; layers.style.height = H + 'px';
        const html = [];
        // headers
        html.push('<div class="cb-corner" style="width:' + headW + 'px;height:' + headH + 'px"' + (this.selAll() ? ' data-all="1"' : '') + '></div>');
        html.push('<div class="cb-colhead" style="left:' + headW + 'px;width:' + (W - headW) + 'px;height:' + headH + 'px">');
        const colSel = this.selColumnsSet(); const rowSel = this.selRowsSet();
        const colHead = (c, left) => { const w = colW(sh, c) * z; if (w <= 0) { return; } html.push('<div class="cb-hcell' + (colSel.all ? ' all' : colSel.has(c) ? ' on' : '') + '" data-c="' + c + '" style="left:' + left + 'px;top:0;width:' + w + 'px;height:' + headH + 'px;font-size:' + (11.5 * z) + 'px">' + colName(c) + '</div>'); };
        for (let c = 0; c < fc; c += 1) { colHead(c, colLeft(sh, c) * z); }
        html.push('<div style="position:absolute;left:' + fw + 'px;top:0;right:0;bottom:0;overflow:hidden">');
        for (let c = f.c0; c <= f.c1; c += 1) { colHead(c, colLeft(sh, c) * z - f.sx - fw); }
        html.push('</div></div>');
        html.push('<div class="cb-rowhead" style="top:' + headH + 'px;height:' + (H - headH) + 'px;width:' + headW + 'px">');
        const rowHead = (r, top) => { const h = rowH(sh, r) * z; if (h <= 0) { return; } html.push('<div class="cb-hcell' + (rowSel.all ? ' all' : rowSel.has(r) ? ' on' : '') + '" data-r="' + r + '" style="top:' + top + 'px;left:0;width:' + headW + 'px;height:' + h + 'px;font-size:' + (11 * z) + 'px">' + (r + 1) + '</div>'); };
        for (let r = 0; r < fr; r += 1) { rowHead(r, rowTop(sh, r) * z); }
        html.push('<div style="position:absolute;top:' + fh + 'px;left:0;right:0;bottom:0;overflow:hidden">');
        for (let r = f.r0; r <= f.r1; r += 1) { rowHead(r, rowTop(sh, r) * z - f.sy - fh); }
        html.push('</div></div>');
        // the four quadrants
        const quads = [
          { cls: 'main', left: headW + fw, top: headH + fh, w: W - headW - fw, h: H - headH - fh, r0: f.r0, r1: f.r1, c0: f.c0, c1: f.c1, ox: f.sx + fw, oy: f.sy + fh },
        ];
        if (fr) { quads.push({ cls: 'top', left: headW + fw, top: headH, w: W - headW - fw, h: fh, r0: 0, r1: fr - 1, c0: f.c0, c1: f.c1, ox: f.sx + fw, oy: 0 }); }
        if (fc) { quads.push({ cls: 'left', left: headW, top: headH + fh, w: fw, h: H - headH - fh, r0: f.r0, r1: f.r1, c0: 0, c1: fc - 1, ox: 0, oy: f.sy + fh }); }
        if (fr && fc) { quads.push({ cls: 'corner', left: headW, top: headH, w: fw, h: fh, r0: 0, r1: fr - 1, c0: 0, c1: fc - 1, ox: 0, oy: 0 }); }
        quads.forEach((q) => { if (q.w > 0 && q.h > 0) { html.push(this.paintQuadrant(q, f)); } });
        layers.innerHTML = html.join('');
        this.placeEditor(f);
        this.lastPaintMs = performance.now() - t0;
        this.paintCount = (this.paintCount || 0) + 1;
      },
      paintQuadrant(q, f) {
        const { sh, z } = f;
        const out = ['<div class="cb-q ' + q.cls + '" data-q="' + q.cls + '" style="left:' + q.left + 'px;top:' + q.top + 'px;width:' + q.w + 'px;height:' + q.h + 'px">'];
        const name = sh.name;
        const defFont = this.settings.font || 'Noto Sans JP';
        const defPx = (this.settings.fontSize || 11) * 4 / 3 * z;
        // merges that touch this quadrant are drawn once, by their anchor
        const merged = new Set(); const anchors = [];
        sh.merges.forEach((m) => {
          if (m.r1 < q.r0 || m.r0 > q.r1 || m.c1 < q.c0 || m.c0 > q.c1) { return; }
          anchors.push(m);
          for (let r = m.r0; r <= m.r1; r += 1) { for (let c = m.c0; c <= m.c1; c += 1) { merged.add(K(r, c)); } }
        });
        // The gridlines: one line per visible column and row, drawn before the
        // cells so that a cell's own background covers them (as LibreOffice Calc).
        if (sh.grid !== false) {
          for (let c = q.c0; c <= q.c1; c += 1) { const w = colW(sh, c) * z; if (w <= 0) { continue; } const x = colLeft(sh, c + 1) * z - q.ox - 1; if (x >= -1 && x <= q.w) { out.push('<div class="cb-gl v" style="left:' + x + 'px"></div>'); } }
          for (let r = q.r0; r <= q.r1; r += 1) { const h = rowH(sh, r) * z; if (h <= 0) { continue; } const y = rowTop(sh, r + 1) * z - q.oy - 1; if (y >= -1 && y <= q.h) { out.push('<div class="cb-gl h" style="top:' + y + 'px"></div>'); } }
        }
        const paintCell = (r, c, x, y, w, h) => {
          const g = wb.get(name, r, c);
          const meta = sh.meta.get(K(r, c));
          const s = (meta && meta.s) || null;
          if (!g.t && !s) { return; }
          const css = ['left:' + x + 'px', 'top:' + y + 'px', 'width:' + w + 'px', 'height:' + h + 'px'];
          const px = s && s.size ? s.size * 4 / 3 * z : defPx;
          const fam = (s && s.font) || defFont;
          css.push('font-size:' + px + 'px', 'font-family:' + fam.replace(/"/g, "'") + ',sans-serif');
          let cls = 'cb-cell';
          if (s) {
            if (s.b) { css.push('font-weight:700'); } if (s.i) { css.push('font-style:italic'); }
            if (s.u || s.strike) { css.push('text-decoration:' + [s.u ? 'underline' : '', s.strike ? 'line-through' : ''].join(' ').trim()); }
            if (s.color) { css.push('color:' + s.color); } else if (s.bg) { css.push('color:' + inkFor(s.bg)); }
            if (s.bg) { css.push('background-color:' + s.bg); }
            if (s.bt) { css.push('border-top:' + s.bt); } if (s.br) { css.push('border-right:' + s.br); } if (s.bb) { css.push('border-bottom:' + s.bb); } if (s.bl) { css.push('border-left:' + s.bl); }
            if (s.va === 'top') { cls += ' vtop'; } else if (s.va === 'middle') { cls += ' vmid'; }
            if (s.wrap) { cls += ' wrap'; }
          }
          let text = ''; let fmtColor = '';
          if (g.t) { const info = Calc.formatInfo ? Calc.formatInfo(g.v, g.t, fmtOf(meta, g), 'ja') : { text: Calc.format(g.v, g.t, fmtOf(meta, g), 'ja') }; text = info.text; fmtColor = info.color || ''; }
          if (fmtColor && !(s && s.color)) { css.push('color:' + fmtColor); }
          const isNum = g.t === 'n' || g.t === 'b';
          const ha = (s && s.ha) || (isNum ? 'right' : g.t === 'e' ? 'center' : 'left');
          if (g.t === 'e') { cls += ' err'; }
          cls += ha === 'right' ? ' rgt' : ha === 'center' ? ' ctr' : ' lft';
          let width = w;
          if (text && !(s && s.wrap)) {
            const fontStr = fontCss(s && s.b, px, fam);
            const tx = textWidth(text, fontStr);
            const tw = tx + 8 * z;
            if (tw > w) {
              const room = w - 2 * CELL_MARGIN * z;
              if (g.t === 'n') {
                if (fmtOf(meta, g)) { if (tx > room) { text = '###'; cls += ' hash'; } }
                else { text = fitNumber(text, g.v, room - 2 * NUM_GAP * z, fontStr); if (text === '###') { cls += ' hash'; } }
              }
              else if (g.t === 'b') { if (tx > room) { text = '###'; cls += ' hash'; } }
              else if (ha === 'left' && !mergeAt(sh, r, c)) {
                // Text runs into empty neighbours, as Calc shows it.
                let cc = c + 1; let ext = w;
                while (cc <= q.c1 + 1 && cc < MAX_COLS && ext < tw) { const ng = wb.get(name, r, cc); if (ng.t) { break; } ext += colW(sh, cc) * z; cc += 1; }
                if (ext > w) { width = Math.min(ext, tw); cls += ' over'; if (s && s.bg) { out.push('<div class="cb-cell" style="left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;background-color:' + s.bg + '"></div>'); } }
              }
            }
          }
          css[2] = 'width:' + width + 'px';
          out.push('<div class="' + cls + '" style="' + css.join(';') + '">' + esc(text) + '</div>');
        };
        for (let r = q.r0; r <= q.r1; r += 1) {
          const h = rowH(sh, r) * z; if (h <= 0) { continue; }
          const y = rowTop(sh, r) * z - q.oy;
          for (let c = q.c0; c <= q.c1; c += 1) {
            const w = colW(sh, c) * z; if (w <= 0) { continue; }
            if (merged.has(K(r, c))) { continue; }
            paintCell(r, c, colLeft(sh, c) * z - q.ox, y, w, h);
          }
        }
        anchors.forEach((m) => {
          const x = colLeft(sh, m.c0) * z - q.ox; const y = rowTop(sh, m.r0) * z - q.oy;
          const w = (colLeft(sh, m.c1 + 1) - colLeft(sh, m.c0)) * z; const h = (rowTop(sh, m.r1 + 1) - rowTop(sh, m.r0)) * z;
          const g = wb.get(name, m.r0, m.c0); const meta = sh.meta.get(K(m.r0, m.c0));
          if (!g.t && !(meta && meta.s)) { out.push('<div class="cb-cell merged" style="left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px"></div>'); }
          else { paintCell(m.r0, m.c0, x, y, w, h); }
        });
        // the selection
        const rect = (g) => {
          const r0 = Math.max(g.r0, q.r0); const r1 = Math.min(g.r1, q.r1 + 1); const c0 = Math.max(g.c0, q.c0); const c1 = Math.min(g.c1, q.c1 + 1);
          if (r0 > r1 || c0 > c1) { return null; }
          const x = colLeft(sh, c0) * z - q.ox; const y = rowTop(sh, r0) * z - q.oy;
          return { x, y, w: (colLeft(sh, c1 + 1) - colLeft(sh, c0)) * z, h: (rowTop(sh, r1 + 1) - rowTop(sh, r0)) * z, clipped: g.r1 > q.r1 + 1 || g.c1 > q.c1 + 1 || g.r0 < q.r0 || g.c0 < q.c0 };
        };
        const sel = this.sel;
        sel.ranges.forEach((g) => {
          const rc = rect(g); if (!rc) { return; }
          if (g.r0 === g.r1 && g.c0 === g.c1 && sel.ranges.length === 1 && !this.editRefs().length) { return; }
          out.push('<div class="cb-selbox' + (sel.ranges.length > 1 ? ' multi' : '') + '" style="left:' + rc.x + 'px;top:' + rc.y + 'px;width:' + rc.w + 'px;height:' + rc.h + 'px"></div>');
        });
        if (!this.edit.on || this.active === this.edit.sheetIdx) {
          const curM = mergeAt(sh, sel.cur.r, sel.cur.c);
          const cg = curM || { r0: sel.cur.r, c0: sel.cur.c, r1: sel.cur.r, c1: sel.cur.c };
          const cr = rect(cg);
          if (cr && !this.edit.on) { out.push('<div class="cb-curbox" style="left:' + (cr.x - 1) + 'px;top:' + (cr.y - 1) + 'px;width:' + (cr.w + 2) + 'px;height:' + (cr.h + 2) + 'px"></div>'); }
          if (sel.ranges.length === 1 && !this.edit.on && !this.book.readOnly) {
            const last = sel.ranges[0]; const lr = rect({ r0: last.r1, c0: last.c1, r1: last.r1, c1: last.c1 });
            if (lr && last.r1 <= q.r1 + 1 && last.c1 <= q.c1 + 1 && last.r1 >= q.r0 && last.c1 >= q.c0) { out.push('<div class="cb-fillh" style="left:' + (lr.x + lr.w - 4) + 'px;top:' + (lr.y + lr.h - 4) + 'px"></div>'); }
          }
        }
        if (this.fillPrev) { const fp = rect(this.fillPrev); if (fp) { out.push('<div class="cb-fillprev" style="left:' + fp.x + 'px;top:' + fp.y + 'px;width:' + fp.w + 'px;height:' + fp.h + 'px"></div>'); } }
        if (this.cutMark && CLIP && CLIP.cut && CLIP.sheet === sh.name) { const cm = rect(this.cutMark); if (cm) { out.push('<div class="cb-fillprev" style="left:' + cm.x + 'px;top:' + cm.y + 'px;width:' + cm.w + 'px;height:' + cm.h + 'px"></div>'); } }
        if (this.movePrev) { const mp = rect(this.movePrev); if (mp) { out.push('<div class="cb-moveprev" style="left:' + mp.x + 'px;top:' + mp.y + 'px;width:' + mp.w + 'px;height:' + mp.h + 'px"></div>'); } }
        // the references of the formula being written, coloured
        this.editRefs().forEach((ref, i) => {
          const target = ref.sheet == null ? (this.edit.sheetName || sh.name) : ref.sheet;
          if (target !== sh.name) { return; }
          const rc = rect(ref.range); if (!rc) { return; }
          out.push('<div class="cb-refbox c' + (i % 8) + '" style="left:' + rc.x + 'px;top:' + rc.y + 'px;width:' + rc.w + 'px;height:' + rc.h + 'px"></div>');
        });
        // autofilter buttons on the header row
        if (sh.filter && sh.filter.r0 >= q.r0 && sh.filter.r0 <= q.r1) {
          const r = sh.filter.r0;
          for (let c = Math.max(sh.filter.c0, q.c0); c <= Math.min(sh.filter.c1, q.c1); c += 1) {
            const x = colLeft(sh, c + 1) * z - q.ox - 18; const y = rowTop(sh, r) * z - q.oy + (rowH(sh, r) * z - 16) / 2;
            const on = sh.filter.cols && sh.filter.cols[c];
            out.push('<button type="button" class="cb-filterbtn' + (on ? ' on' : '') + '" data-fc="' + c + '" style="left:' + x + 'px;top:' + y + 'px">▼</button>');
          }
        }
        out.push('</div>');
        return out.join('');
      },
      editRefs() {
        if (!this.edit.on || this.edit.text[0] !== '=') { return []; }
        if (this._refsFor !== this.edit.text) { this._refsFor = this.edit.text; this._refs = refsInFormula(this.edit.text); }
        return this._refs;
      },
      /** The box the cell is edited in: over the cell, growing to the right as the text does. */
      placeEditor(F) {
        if (!this.edit.on) { this.edit.style = { left: '0px', top: '0px', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none' }; return; }
        const f = F || this.frame(); if (!f) { return; }
        if (this.active !== this.edit.sheetIdx) { this.edit.style = { left: '-9999px', top: '0px' }; return; }
        const rc = this.cellRect(this.edit.r, this.edit.c, f);
        if (!rc || !rc.visible) { this.edit.style = { left: '-9999px', top: '0px' }; return; }
        const meta = f.sh.meta.get(K(this.edit.r, this.edit.c));
        const font = this.cellFont(meta, f.z);
        const s = (meta && meta.s) || {};
        const lines = String(this.edit.text).split('\n');
        let need = 0; lines.forEach((ln) => { need = Math.max(need, textWidth(ln, fontCss(s.b, font.px, font.family)) + 12 * f.z); });
        const w = s.wrap ? rc.w : Math.min(Math.max(rc.w, need), f.W - rc.left - 2);
        const h = Math.max(rc.h, lines.length * font.px * 1.25 + 4);
        this.edit.wrap = !!s.wrap;
        this.edit.style = { left: (rc.left - 1) + 'px', top: (rc.top - 1) + 'px', width: (w + 2) + 'px', height: (h + 2) + 'px', fontSize: font.px + 'px', fontFamily: font.family,
          fontWeight: s.b ? 700 : 400, fontStyle: s.i ? 'italic' : 'normal', textAlign: s.ha || ((this.edit.text !== '' && !isNaN(Number(this.edit.text)) && this.edit.text[0] !== '=') ? 'right' : 'left'),
          color: s.color || (s.bg ? inkFor(s.bg) : null), backgroundColor: s.bg || null, opacity: 1, pointerEvents: 'auto' };
      },
      // ---- the grid: the selection ----
      selRange() { const g = this.sel.ranges[this.sel.ranges.length - 1]; return g || { r0: 0, c0: 0, r1: 0, c1: 0 }; },
      selAll() { const g = this.sel.ranges[0]; return this.sel.ranges.length === 1 && g.r0 === 0 && g.c0 === 0 && g.r1 >= MAX_ROWS - 1 && g.c1 >= MAX_COLS - 1; },
      selColumnsSet() { const set = new Set(); let all = false; this.sel.ranges.forEach((g) => { if (g.r0 === 0 && g.r1 >= MAX_ROWS - 1) { if (g.c1 - g.c0 > 2000) { all = true; } else { for (let c = g.c0; c <= g.c1; c += 1) { set.add(c); } } } else { for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 400); c += 1) { set.add(c); } } }); set.all = all; return set; },
      selRowsSet() { const set = new Set(); let all = false; this.sel.ranges.forEach((g) => { if (g.c0 === 0 && g.c1 >= MAX_COLS - 1) { if (g.r1 - g.r0 > 5000) { all = true; } else { for (let r = g.r0; r <= g.r1; r += 1) { set.add(r); } } } else { for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 2000); r += 1) { set.add(r); } } }); set.all = all; return set; },
      /** The selection in words for the chrome: the name box, the status bar, the toolbar's state. */
      syncSel() {
        const sh = this.sheet(); if (!sh) { return; }
        const g = this.selRange();
        this.selText = this.sel.ranges.length > 1 ? this.sel.ranges.map(rangeName).join(', ') : rangeName(g);
        let count = 0; this.sel.ranges.forEach((x) => { count += (Math.min(x.r1, MAX_ROWS - 1) - x.r0 + 1) * (Math.min(x.c1, MAX_COLS - 1) - x.c0 + 1); });
        this.selCount = count;
        // Sum / Average / Count of the numbers in the selection (walked up to a limit, as a status bar should stay quick)
        let sum = 0; let n = 0; let seen = 0;
        outer: for (const x of this.sel.ranges) {
          const r1 = Math.min(x.r1, sh.maxR); const c1 = Math.min(x.c1, sh.maxC);
          for (let r = x.r0; r <= r1; r += 1) { for (let c = x.c0; c <= c1; c += 1) { seen += 1; if (seen > 200000) { break outer; } const v = wb.get(sh.name, r, c); if (v.t === 'n') { sum += v.v; n += 1; } } }
        }
        this.stats = n ? { sum: Calc.format(sum, 'n', 'General', 'ja'), avg: Calc.format(Math.round(sum / n * 1e10) / 1e10, 'n', 'General', 'ja'), count: n } : { sum: '', avg: '', count: 0 };
        const meta = sh.meta.get(K(this.sel.cur.r, this.sel.cur.c)) || {};
        const s = meta.s || {};
        this.fmtNow = { b: s.b || 0, i: s.i || 0, u: s.u || 0, strike: s.strike || 0, color: s.color || '', bg: s.bg || '', ha: s.ha || '', va: s.va || '', wrap: s.wrap || 0, font: s.font || '', size: s.size || '', fmt: fmtOf(meta, wb.get(sh.name, this.sel.cur.r, this.sel.cur.c)) };
        this.tick += 1;
      },
      setCur(r, c, keepRanges) {
        r = clamp(r, 0, MAX_ROWS - 1); c = clamp(c, 0, MAX_COLS - 1);
        const sh = this.sheet();
        const m = sh ? mergeAt(sh, r, c) : null;
        if (m) { r = m.r0; c = m.c0; }
        this.sel.cur = { r, c };
        if (!keepRanges) { this.sel.anchor = { r, c }; this.sel.ranges = [m ? Object.assign({}, m) : { r0: r, c0: c, r1: r, c1: c }]; }
        this.ensureVisible(r, c);
        this.syncSel();
        this.paint();
      },
      extendTo(r, c) {
        r = clamp(r, 0, MAX_ROWS - 1); c = clamp(c, 0, MAX_COLS - 1);
        const a = this.sel.anchor;
        let g = norm(a, { r, c });
        // a merge touched by the selection is taken in whole, as Calc does
        const sh = this.sheet();
        if (sh) { let grew = true; while (grew) { grew = false; sh.merges.forEach((m) => { if (m.r1 >= g.r0 && m.r0 <= g.r1 && m.c1 >= g.c0 && m.c0 <= g.c1) { const n = { r0: Math.min(g.r0, m.r0), c0: Math.min(g.c0, m.c0), r1: Math.max(g.r1, m.r1), c1: Math.max(g.c1, m.c1) }; if (n.r0 !== g.r0 || n.c0 !== g.c0 || n.r1 !== g.r1 || n.c1 !== g.c1) { g = n; grew = true; } } }); } }
        this.sel.ranges[this.sel.ranges.length - 1] = g;
        this.ensureVisible(r, c);
        this.syncSel();
        this.paint();
      },
      selectAll() { this.sel.ranges = [{ r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 }]; this.syncSel(); this.paint(); },
      selectCols(c0, c1, add) { const g = { r0: 0, c0: Math.min(c0, c1), r1: MAX_ROWS - 1, c1: Math.max(c0, c1) }; if (add) { this.sel.ranges.push(g); } else { this.sel.ranges = [g]; } this.sel.cur = { r: this.frame() ? this.frame().r0 : 0, c: c0 }; this.sel.anchor = { r: 0, c: c0 }; this.syncSel(); this.paint(); },
      selectRows(r0, r1, add) { const g = { r0: Math.min(r0, r1), c0: 0, r1: Math.max(r0, r1), c1: MAX_COLS - 1 }; if (add) { this.sel.ranges.push(g); } else { this.sel.ranges = [g]; } this.sel.cur = { r: r0, c: this.frame() ? this.frame().c0 : 0 }; this.sel.anchor = { r: r0, c: 0 }; this.syncSel(); this.paint(); },
      /** Scrolls so that the cell is within the main area (not under the frozen panes). */
      ensureVisible(r, c) {
        const vp = this.$refs.scroller; const sh = this.sheet();
        if (!vp || !sh) { return; }
        this.growTo(r, c);
        const f = this.frame(); if (!f) { return; }
        const z = f.z;
        if (r >= f.fr) {
          const top = rowTop(sh, r) * z; const bottom = rowTop(sh, r + 1) * z;
          const viewTop = f.sy + f.fh; const viewBottom = f.sy + f.H - f.headH;
          if (top < viewTop) { vp.scrollTop = Math.max(0, top - f.fh); } else if (bottom > viewBottom) { vp.scrollTop = bottom - (f.H - f.headH); }
        }
        if (c >= f.fc) {
          const left = colLeft(sh, c) * z; const right = colLeft(sh, c + 1) * z;
          const viewLeft = f.sx + f.fw; const viewRight = f.sx + f.W - f.headW;
          if (left < viewLeft) { vp.scrollLeft = Math.max(0, left - f.fw); } else if (right > viewRight) { vp.scrollLeft = right - (f.W - f.headW); }
        }
      },
      goToName(text) {
        const g = parseRange(text);
        if (!g) { this.notify(this.t('“{name}” is not a cell or a range.', { name: text })); return; }
        this.sel.ranges = [g]; this.sel.cur = { r: g.r0, c: g.c0 }; this.sel.anchor = { r: g.r0, c: g.c0 };
        this.ensureVisible(g.r0, g.c0); this.syncSel(); this.paint(); this.focusGrid();
      },
      /** Where a point of the screen falls: a cell, a header, a header's edge (for resizing). */
      hitTest(clientX, clientY) {
        const f = this.frame(); const view = this.$refs.view;
        if (!f || !view) { return { kind: 'outside' }; }
        const rect = view.getBoundingClientRect();
        const x = clientX - rect.left; const y = clientY - rect.top;
        if (x < 0 || y < 0 || x > f.W || y > f.H) { return { kind: 'outside' }; }
        const sh = f.sh; const z = f.z;
        const contentX = x < f.headW + f.fw ? (x - f.headW) / z : (x - f.headW + f.sx) / z;
        const contentY = y < f.headH + f.fh ? (y - f.headH) / z : (y - f.headH + f.sy) / z;
        if (x < f.headW && y < f.headH) { return { kind: 'corner' }; }
        if (y < f.headH) {
          const c = colAtX(sh, Math.max(0, contentX));
          const right = colLeft(sh, c + 1); const left = colLeft(sh, c);
          let edge = -1;
          if ((right - contentX) * z < 5) { edge = c; } else if ((contentX - left) * z < 5 && c > 0) { edge = c - 1; }
          return { kind: 'colhead', c, edge };
        }
        if (x < f.headW) {
          const r = rowAtY(sh, Math.max(0, contentY));
          const bottom = rowTop(sh, r + 1); const top = rowTop(sh, r);
          let edge = -1;
          if ((bottom - contentY) * z < 5) { edge = r; } else if ((contentY - top) * z < 5 && r > 0) { edge = r - 1; }
          return { kind: 'rowhead', r, edge };
        }
        return { kind: 'cell', r: rowAtY(sh, Math.max(0, contentY)), c: colAtX(sh, Math.max(0, contentX)) };
      },
      focusGrid() { const ed = this.$refs.editor; if (ed && document.activeElement !== ed) { try { ed.focus({ preventScroll: true }); } catch (e) { ed.focus(); } } },
      // ---- the grid: the mouse ----
      gridMouseDown(e) {
        if (e.button === 2) { return; }
        if (!this.book.id) { return; }
        const target = e.target;
        if (target && target.classList && target.classList.contains('cb-editor') && this.edit.on) { return; }
        if (target && target.classList && target.classList.contains('cb-filterbtn')) { e.preventDefault(); this.openFilterPop(Number(target.dataset.fc), target); return; }
        e.preventDefault();
        this.menu = '';
        const hit = this.hitTest(e.clientX, e.clientY);
        if (target && target.classList && target.classList.contains('cb-fillh')) { this.startFillDrag(e); return; }
        if (hit.kind === 'outside') { return; }
        if (this.edit.on && this.edit.text[0] === '=' && hit.kind === 'cell') {
          const slot = refSlot(this.edit.text, this.edit.caret);
          if (slot) { this.startRefDrag(e, hit, slot); return; }
        }
        if (this.edit.on) { if (!this.commitEdit()) { return; } }
        this.focusGrid();
        if (hit.kind === 'corner') { this.selectAll(); return; }
        if (hit.kind === 'colhead') {
          if (hit.edge >= 0 && !this.book.readOnly) { this.startResize(e, 'col', hit.edge); return; }
          if (e.shiftKey) { this.selectCols(this.sel.anchor.c, hit.c); } else { this.selectCols(hit.c, hit.c, e.ctrlKey || e.metaKey); }
          this.dragSel = { kind: 'col', from: hit.c };
          this.trackDrag(e);
          return;
        }
        if (hit.kind === 'rowhead') {
          if (hit.edge >= 0 && !this.book.readOnly) { this.startResize(e, 'row', hit.edge); return; }
          if (e.shiftKey) { this.selectRows(this.sel.anchor.r, hit.r); } else { this.selectRows(hit.r, hit.r, e.ctrlKey || e.metaKey); }
          this.dragSel = { kind: 'row', from: hit.r };
          this.trackDrag(e);
          return;
        }
        // a cell
        if (e.shiftKey) { this.extendTo(hit.r, hit.c); }
        else if (e.ctrlKey || e.metaKey) { this.sel.ranges.push({ r0: hit.r, c0: hit.c, r1: hit.r, c1: hit.c }); this.sel.cur = { r: hit.r, c: hit.c }; this.sel.anchor = { r: hit.r, c: hit.c }; this.syncSel(); this.paint(); }
        else {
          // Dragging the edge of the selection moves it (cut-and-paste by hand).
          const g = this.selRange();
          const rc = this.cellRect(g.r0, g.c0); const rc2 = this.cellRect(g.r1, g.c1);
          const view = this.$refs.view.getBoundingClientRect(); const x = e.clientX - view.left; const y = e.clientY - view.top;
          if (rc && rc2 && !this.book.readOnly && (g.r1 > g.r0 || g.c1 > g.c0 || true) && inRange(g, hit.r, hit.c)) {
            const nearEdge = Math.abs(x - rc.left) < 4 || Math.abs(y - rc.top) < 4 || Math.abs(x - (rc2.left + rc2.w)) < 4 || Math.abs(y - (rc2.top + rc2.h)) < 4;
            if (nearEdge && (g.r1 > g.r0 || g.c1 > g.c0)) { this.startMoveDrag(e, g, hit); return; }
          }
          this.setCur(hit.r, hit.c);
        }
        this.dragSel = { kind: 'cell' };
        this.trackDrag(e);
      },
      /** Dragging extends the selection; past the edge of the view the sheet scrolls along. */
      trackDrag(e0) {
        const move = (e) => {
          const hit = this.hitTest(e.clientX, e.clientY);
          this.autoScroll(e);
          if (hit.kind === 'cell' && this.dragSel.kind === 'cell') { this.extendTo(hit.r, hit.c); }
          else if (this.dragSel.kind === 'col' && (hit.kind === 'colhead' || hit.kind === 'cell')) { this.selectCols(this.dragSel.from, hit.c); }
          else if (this.dragSel.kind === 'row' && (hit.kind === 'rowhead' || hit.kind === 'cell')) { this.selectRows(this.dragSel.from, hit.r); }
        };
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); this.dragSel = null; clearInterval(this._autoScroll); this._autoScroll = 0; };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      },
      autoScroll(e) {
        const vp = this.$refs.scroller; const view = this.$refs.view; if (!vp || !view) { return; }
        const r = view.getBoundingClientRect(); const f = this.frame();
        let dx = 0; let dy = 0;
        if (e.clientX > r.left + f.W) { dx = 24; } else if (e.clientX < r.left + f.headW + f.fw) { dx = -24; }
        if (e.clientY > r.top + f.H) { dy = 24; } else if (e.clientY < r.top + f.headH + f.fh) { dy = -24; }
        clearInterval(this._autoScroll); this._autoScroll = 0;
        if (dx || dy) { this._autoScroll = setInterval(() => { vp.scrollLeft += dx; vp.scrollTop += dy; }, 50); }
      },
      startResize(e, kind, index) {
        const sh = this.sheet(); const z = this.z();
        const start = kind === 'col' ? e.clientX : e.clientY;
        const was = kind === 'col' ? colW(sh, index) : rowH(sh, index);
        const guide = document.createElement('div'); guide.className = 'cb-resize-guide';
        const layers = this.$refs.layers; const f = this.frame();
        const place = (v) => {
          if (kind === 'col') { const x = f.headW + (colLeft(sh, index) + v) * z - (index < f.fc ? 0 : f.sx); guide.style.cssText = 'left:' + x + 'px;top:0;width:1px;height:' + f.H + 'px'; }
          else { const y = f.headH + (rowTop(sh, index) + v) * z - (index < f.fr ? 0 : f.sy); guide.style.cssText = 'top:' + y + 'px;left:0;height:1px;width:' + f.W + 'px'; }
        };
        layers.appendChild(guide); place(was);
        let now = was;
        const move = (ev) => { now = Math.max(0, Math.round(was + ((kind === 'col' ? ev.clientX : ev.clientY) - start) / z)); place(now); };
        const up = () => {
          document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); guide.remove();
          if (now !== was) {
            const sel = this.sel; const set = kind === 'col' ? this.selColumnsSet() : this.selRowsSet();
            // every selected column (row) when the dragged one is among them, as Calc
            const targets = (set.has(index) && !set.all && set.size > 1) ? Array.from(set) : [index];
            this.sizeLines(kind, targets, now);
          }
        };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      },
      /** Sets the width of columns or the height of rows, as one undoable step. */
      sizeLines(kind, indexes, value) {
        const sh = this.sheet(); if (!sh) { return; }
        const map = kind === 'col' ? sh.cols : sh.rows; const def = kind === 'col' ? DEF_COL_W : DEF_ROW_H;
        const before = indexes.map((i) => [i, map.has(i) ? map.get(i) : null]);
        const apply = (pairs) => { pairs.forEach(([i, v]) => { if (v == null || v === def) { map.delete(i); } else { map.set(i, v); } }); this.layout(); this.touch(); };
        apply(indexes.map((i) => [i, value]));
        this.pushStep({ undo: () => apply(before), redo: () => apply(indexes.map((i) => [i, value])) });
      },
      gridDblClick(e) {
        if (!this.book.id) { return; }
        const hit = this.hitTest(e.clientX, e.clientY);
        if (hit.kind === 'colhead' && hit.edge >= 0) { this.fitCols([hit.edge]); return; }
        if (hit.kind === 'rowhead' && hit.edge >= 0) { this.fitRows([hit.edge]); return; }
        if (hit.kind === 'cell' && !this.book.readOnly) { if (!inRange(this.selRange(), hit.r, hit.c)) { this.setCur(hit.r, hit.c); } this.startEdit('full'); }
      },
      gridWheel(e) {
        if (e.ctrlKey) { e.preventDefault(); this.stepZoom(e.deltaY < 0 ? 10 : -10); }
      },
      // touch: a tap selects, a long press opens the menu, the scroller scrolls by itself
      gridTouchStart(e) {
        const t = e.touches[0]; if (!t) { return; }
        this._touch = { x: t.clientX, y: t.clientY, moved: false };
        clearTimeout(this._pressTimer);
        this._pressTimer = setTimeout(() => {
          if (!this._touch || this._touch.moved) { return; }
          const hit = this.hitTest(this._touch.x, this._touch.y);
          if (hit.kind === 'cell') { if (!inRange(this.selRange(), hit.r, hit.c)) { this.setCur(hit.r, hit.c); } ctxAt = performance.now(); this.openCellCtx(this._touch.x, this._touch.y); }
          this._touch = null;
        }, 550);
      },
      gridTouchMove(e) { const t = e.touches[0]; if (this._touch && t && (Math.abs(t.clientX - this._touch.x) > 8 || Math.abs(t.clientY - this._touch.y) > 8)) { this._touch.moved = true; clearTimeout(this._pressTimer); } },
      gridTouchEnd(e) {
        clearTimeout(this._pressTimer);
        const tc = this._touch; this._touch = null;
        if (!tc || tc.moved || !this.book.id) { return; }
        const hit = this.hitTest(tc.x, tc.y);
        if (hit.kind === 'cell') {
          const same = this.sel.cur.r === hit.r && this.sel.cur.c === hit.c;
          if (same && !this.book.readOnly) { this.startEdit('full'); } else { if (this.edit.on) { this.commitEdit(); } this.setCur(hit.r, hit.c); }
          e.preventDefault();
        } else if (hit.kind === 'colhead') { this.selectCols(hit.c, hit.c); } else if (hit.kind === 'rowhead') { this.selectRows(hit.r, hit.r); }
      },
      // ---- the grid: the keyboard (the editor textarea holds the focus; idle, it is invisible) ----
      gridKey(e) {
        if (this.edit.on) { this.editorKey(e); return; }
        if (!this.book.id) { return; }
        const ctrl = e.ctrlKey || e.metaKey; const k = e.key;
        const ro = this.book.readOnly;
        const move = (dr, dc) => {
          e.preventDefault();
          const cur = this.sel.cur;
          let r = cur.r; let c = cur.c;
          const sh = this.sheet();
          if (ctrl) { const edge = this.dataEdge(r, c, dr, dc); r = edge.r; c = edge.c; }
          else {
            // a merged cell is stepped over as one
            const m = mergeAt(sh, r, c);
            if (m && dr > 0) { r = m.r1 + 1; } else if (m && dc > 0) { c = m.c1 + 1; } else { r += dr; c += dc; }
          }
          r = clamp(r, 0, MAX_ROWS - 1); c = clamp(c, 0, MAX_COLS - 1);
          if (e.shiftKey) { this.sel.cur = { r, c }; this.extendTo(r, c); } else { this.setCur(r, c); }
        };
        if (k === 'ArrowDown') { return move(1, 0); } if (k === 'ArrowUp') { return move(-1, 0); }
        if (k === 'ArrowRight') { return move(0, 1); } if (k === 'ArrowLeft') { return move(0, -1); }
        if (k === 'Tab') { e.preventDefault(); if (!e.shiftKey && this.tabStart == null) { this.tabStart = this.sel.cur.c; } const m = mergeAt(this.sheet(), this.sel.cur.r, this.sel.cur.c); this.setCur(this.sel.cur.r, e.shiftKey ? this.sel.cur.c - 1 : (m ? m.c1 + 1 : this.sel.cur.c + 1)); return undefined; }
        if (k === 'Enter') { e.preventDefault(); this.enterMove(e.shiftKey); return undefined; }
        if (k === 'Home') { e.preventDefault(); if (ctrl) { this.setCur(0, 0); } else { this.setCur(this.sel.cur.r, 0); } return undefined; }
        if (k === 'End') { e.preventDefault(); const sh = this.sheet(); this.refreshUsed(); if (ctrl) { this.setCur(sh.maxR, sh.maxC); } else { this.setCur(this.sel.cur.r, this.rowEnd(this.sel.cur.r)); } return undefined; }
        if (k === 'PageDown' || k === 'PageUp') {
          e.preventDefault();
          if (ctrl) { this.switchSheet(clamp(this.active + (k === 'PageDown' ? 1 : -1), 0, UIS.length - 1)); return undefined; }
          const f = this.frame(); const n = Math.max(1, f.r1 - f.r0 - 1);
          const r = clamp(this.sel.cur.r + (k === 'PageDown' ? n : -n), 0, MAX_ROWS - 1);
          if (e.shiftKey) { this.sel.cur = { r, c: this.sel.cur.c }; this.extendTo(r, this.sel.cur.c); } else { this.setCur(r, this.sel.cur.c); }
          return undefined;
        }
        if (k === 'Delete') { e.preventDefault(); if (!ro) { this.clearCells('contents'); } return undefined; }
        if (k === 'Backspace') { e.preventDefault(); if (!ro) { this.startEdit('quick', ''); } return undefined; }
        if (k === 'F2') { e.preventDefault(); if (!ro) { this.startEdit('full'); } return undefined; }
        if (k === 'Escape') { if (this.cutMark) { this.cutMark = null; if (CLIP) { CLIP.cut = false; } this.paint(); } else if (this.find.open) { this.toggleFind(false); } return undefined; }
        if (k === ' ' && (ctrl || e.shiftKey)) { e.preventDefault(); if (ctrl) { this.selectCols(this.sel.cur.c, this.sel.cur.c); } else { this.selectRows(this.sel.cur.r, this.sel.cur.r); } return undefined; }
        if (ctrl) {
          const lk = k.toLowerCase();
          if (lk === 'a') { e.preventDefault(); this.selectAll(); return undefined; }
          if (lk === 'z') { e.preventDefault(); if (e.shiftKey) { this.redo(); } else { this.undo(); } return undefined; }
          if (lk === 'y') { e.preventDefault(); this.redo(); return undefined; }
          if (lk === 's') { e.preventDefault(); this.save(true); return undefined; }
          if (lk === 'f' || lk === 'h') { e.preventDefault(); this.toggleFind(true); return undefined; }
          if (lk === 'b' && !ro) { e.preventDefault(); this.toggleStyle('b'); return undefined; }
          if (lk === 'i' && !ro) { e.preventDefault(); this.toggleStyle('i'); return undefined; }
          if (lk === 'u' && !ro) { e.preventDefault(); this.toggleStyle('u'); return undefined; }
          if (lk === 'd' && !ro) { e.preventDefault(); this.fillSelection('down'); return undefined; }
          if (lk === 'r' && !ro) { e.preventDefault(); this.fillSelection('right'); return undefined; }
          if (k === '1' && !ro) { e.preventDefault(); this.openCellProps('number'); return undefined; }
          if (lk === 'v' && e.shiftKey) { this.pasteValuesOnly = true; return undefined; }
          // c / x / v arrive as copy / cut / paste events
          return undefined;
        }
        // Anything else that prints a character starts an edit through the input event.
        return undefined;
      },
      /** Enter moves down (or right, per the settings); Shift goes back; after Tabs it returns to the column the Tabs began in. */
      enterMove(back) {
        const dir = this.settings.enterMoves === 'right' ? 'right' : 'down';
        const cur = this.sel.cur; const sh = this.sheet();
        const g = this.selRange();
        const multi = g.r1 > g.r0 || g.c1 > g.c0;
        if (multi) {
          // Enter walks the selection, as Calc
          let r = cur.r; let c = cur.c;
          if (dir === 'down') { r += back ? -1 : 1; if (r > g.r1) { r = g.r0; c = c + 1 > g.c1 ? g.c0 : c + 1; } if (r < g.r0) { r = g.r1; c = c - 1 < g.c0 ? g.c1 : c - 1; } }
          else { c += back ? -1 : 1; if (c > g.c1) { c = g.c0; r = r + 1 > g.r1 ? g.r0 : r + 1; } if (c < g.c0) { c = g.c1; r = r - 1 < g.r0 ? g.r1 : r - 1; } }
          this.sel.cur = { r, c }; this.ensureVisible(r, c); this.syncSel(); this.paint();
          return;
        }
        const m = mergeAt(sh, cur.r, cur.c);
        if (dir === 'down') { const c = this.tabStart != null && !back ? this.tabStart : cur.c; this.tabStart = null; this.setCur(back ? cur.r - 1 : (m ? m.r1 + 1 : cur.r + 1), c); }
        else { this.tabStart = null; this.setCur(cur.r, back ? cur.c - 1 : (m ? m.c1 + 1 : cur.c + 1)); }
      },
      rowEnd(r) { const sh = this.sheet(); let last = 0; for (let c = 0; c <= sh.maxC; c += 1) { if (wb.get(sh.name, r, c).t) { last = c; } } return last; },
      /** Ctrl+arrow: to the edge of the block of data, as Calc. */
      dataEdge(r, c, dr, dc) {
        const sh = this.sheet(); const has = (rr, cc) => rr >= 0 && cc >= 0 && rr < MAX_ROWS && cc < MAX_COLS && !!wb.get(sh.name, rr, cc).t;
        const limitR = dr > 0 ? Math.max(sh.maxR, r) : 0; const limitC = dc > 0 ? Math.max(sh.maxC, c) : 0;
        let rr = r; let cc = c;
        const next = () => has(rr + dr, cc + dc);
        if (has(rr, cc) && next()) { while (next()) { rr += dr; cc += dc; } return { r: rr, c: cc }; }
        rr += dr; cc += dc;
        while (rr >= 0 && cc >= 0 && !has(rr, cc)) { if (dr && (dr > 0 ? rr >= limitR : rr <= 0)) { return { r: dr > 0 ? Math.max(limitR, 0) : 0, c }; } if (dc && (dc > 0 ? cc >= limitC : cc <= 0)) { return { r, c: dc > 0 ? Math.max(limitC, 0) : 0 }; } rr += dr; cc += dc; }
        return { r: clamp(rr, 0, MAX_ROWS - 1), c: clamp(cc, 0, MAX_COLS - 1) };
      },
      stepZoom(d) { this.setZoom(this.zoom + d); },
      setZoom(v) { this.zoom = clamp(Math.round(v / 10) * 10, 50, 200); window.localStorage.setItem('cb-zoom', String(this.zoom)); this.layout(); },

      // ---- cells: reading and writing through the engine ----
      /** What is typed to make a cell: the formula, or the literal as it would be typed. */
      inputAt(r, c) {
        if (!wb || !this.sheet()) { return ''; }
        const g = wb.get(this.sheetName(), r, c);
        return this.inputOf(g, fmtOf(this.sheet().meta.get(K(r, c)), g));
      },
      /** The format a cell is shown in (see fmtOf). */
      fmtAt(sh, r, c, g) { return fmtOf(sh.meta.get(K(r, c)), g || wb.get(sh.name, r, c)); },
      inputOf(g, fmt) {
        if (!g || !g.t) { return ''; }
        if (g.f) { return g.f; }
        if (g.t === 'n') { if (fmt && (isDateFmt(fmt) || isTimeFmt(fmt) || /%/.test(fmt))) { return Calc.format(g.v, 'n', fmt.split(';')[0].replace(/\[[^\]]*\]/g, ''), 'ja'); } return String(g.v); }
        if (g.t === 'b') { return g.v ? 'TRUE' : 'FALSE'; }
        if (g.t === 'e') { return String(g.v); }
        const s = String(g.v);
        // text that would read as a number or a formula keeps its quote
        return (s !== '' && (s[0] === '=' || s[0] === "'" || (Calc.parseInput(s, 'ja').t !== 's'))) ? "'" + s : s;
      },
      /** One cell set from typed text; a format the engine suggests (12% -> 0%) is kept unless the cell has one. */
      setInputRaw(sh, r, c, text) {
        const before = wb.get(sh.name, r, c);
        wb.setInput(sh.name, r, c, text);
        const after = wb.get(sh.name, r, c);
        const meta = sh.meta.get(K(r, c));
        if (text !== '' && text[0] !== '=' && after.fmt && !(meta && meta.fmt)) { this.setMeta(sh, r, c, { fmt: after.fmt }); }
        if (after.t) { if (r > sh.maxR) { sh.maxR = r; } if (c > sh.maxC) { sh.maxC = c; } }
      },
      setMeta(sh, r, c, patch) {
        const k = K(r, c);
        const meta = Object.assign({ fmt: '', s: null }, sh.meta.get(k) || {});
        if (patch.fmt !== undefined) { meta.fmt = patch.fmt || ''; }
        if (patch.s !== undefined) { meta.s = isEmptyObj(patch.s) ? null : Object.assign({}, patch.s); }
        if (!meta.fmt && !meta.s) { sh.meta.delete(k); } else { sh.meta.set(k, meta); if (r > sh.maxR) { sh.maxR = r; } if (c > sh.maxC) { sh.maxC = c; } }
      },
      /** A cell's whole state, for the undo stack. */
      cellState(sh, r, c) {
        const g = wb.get(sh.name, r, c); const meta = sh.meta.get(K(r, c));
        return { input: this.inputOf(g, fmtOf(meta, g)), fmt: (meta && meta.fmt) || '', s: meta && meta.s ? Object.assign({}, meta.s) : null };
      },
      applyCellState(sh, r, c, st) {
        wb.setInput(sh.name, r, c, st.input);
        this.setMeta(sh, r, c, { fmt: st.fmt, s: st.s });
        if (st.input !== '') { if (r > sh.maxR) { sh.maxR = r; } if (c > sh.maxC) { sh.maxC = c; } }
      },
      // ---- undo ----
      /** A step records the cells it is about to change; endStep records what they became. */
      beginStep() { return { sheet: this.sheet(), before: new Map() }; },
      endStep(step) {
        const items = [];
        step.before.forEach((b) => { items.push({ sh: b.sh, r: b.r, c: b.c, was: b.st, now: this.cellState(b.sh, b.r, b.c) }); });
        if (!items.length) { return; }
        const sel = JSON.stringify(this.sel); const active = this.active;
        this.pushStep({
          undo: () => { items.forEach((it) => this.applyCellState(it.sh, it.r, it.c, it.was)); this.restoreSel(sel, active); },
          redo: () => { items.forEach((it) => this.applyCellState(it.sh, it.r, it.c, it.now)); this.restoreSel(sel, active); },
        });
      },
      restoreSel(json, active) { if (this.active !== active && UIS[active]) { this.active = active; } try { this.sel = JSON.parse(json); } catch (e) { /* keep */ } this.afterChange(); },
      pushStep(step) { this.history.push(step); if (this.history.length > 200) { this.history.shift(); } this.redoStack = []; this.canUndo = true; this.canRedo = false; },
      undo() { if (this.edit.on) { this.cancelEdit(); return; } const s = this.history.pop(); if (!s) { return; } s.undo(); this.redoStack.push(s); this.canUndo = this.history.length > 0; this.canRedo = true; this.touch(); this.afterChange(); },
      redo() { const s = this.redoStack.pop(); if (!s) { return; } s.redo(); this.history.push(s); this.canUndo = true; this.canRedo = this.redoStack.length > 0; this.touch(); this.afterChange(); },
      /** After the sheets changed under the chrome: repaint, recount, re-read the formula bar. */
      afterChange() { this.tick += 1; this.syncSel(); this.layout(); },
      /** Runs fn with a step open: fn(step) calls step.before(sh, r, c) before touching a cell. */
      withStep(fn) {
        const step = this.beginStep(); this.curStep = step; step.before = new Map();
        const rec = (sh, r, c) => { const k = sh.name + '!' + K(r, c); if (!step.before.has(k)) { step.before.set(k, { sh, r, c, st: this.cellState(sh, r, c) }); } };
        const res = fn(rec);
        this.endStep(step);
        this.curStep = null;
        this.touch();
        this.afterChange();
        return res;
      },
      /** Every cell of the selection, capped so that a whole-column selection does not walk a million rows. */
      eachSelCell(fn, cap) {
        const sh = this.sheet(); if (!sh) { return; }
        let n = 0; const max = cap || 100000;
        this.sel.ranges.forEach((g) => {
          const r1 = Math.min(g.r1, Math.max(sh.maxR, g.r0)); const c1 = Math.min(g.c1, Math.max(sh.maxC, g.c0));
          for (let r = g.r0; r <= r1; r += 1) { for (let c = g.c0; c <= c1; c += 1) { n += 1; if (n > max) { return; } fn(sh, r, c); } }
        });
      },
      // ---- editing ----
      startEdit(mode, text) {
        if (this.book.readOnly) { return; }
        const sh = this.sheet(); if (!sh) { return; }
        const cur = this.sel.cur;
        this.edit.on = true; this.edit.mode = mode; this.edit.r = cur.r; this.edit.c = cur.c; this.edit.sheetIdx = this.active; this.edit.sheetName = sh.name;
        this.edit.text = text != null ? text : this.inputAt(cur.r, cur.c);
        this.edit.caret = this.edit.text.length; this.edit.source = 'cell'; this.edit.pointer = null;
        this.edit.hints = []; this.edit.hintIdx = 0; this.edit.sig = '';
        this.placeEditor();
        this.$nextTick(() => {
          const ed = this.$refs.editor; if (!ed) { return; }
          if (ed.value !== this.edit.text) { ed.value = this.edit.text; }
          ed.focus(); ed.setSelectionRange(this.edit.text.length, this.edit.text.length);
          this.paint();
        });
      },
      /** Typing on the idle textarea begins a quick edit with what was typed. */
      editorInput(e) {
        const ed = e.target;
        if (!this.edit.on) {
          if (this.book.readOnly) { ed.value = ''; return; }
          const text = ed.value;
          this.edit.on = true; this.edit.mode = 'quick'; this.edit.r = this.sel.cur.r; this.edit.c = this.sel.cur.c; this.edit.sheetIdx = this.active; this.edit.sheetName = this.sheetName();
          this.edit.source = 'cell'; this.edit.pointer = null;
          this.edit.text = text; this.edit.caret = text.length;
          this.placeEditor(); this.paint();
        } else {
          this.edit.text = ed.value; this.edit.caret = ed.selectionStart;
          this.placeEditor(); this.paint();
        }
        this.updateHints();
      },
      caretMoved(el) { if (this.edit.on) { this.edit.caret = el.selectionStart; this.updateHints(); } },
      updateHints() {
        const text = this.edit.text; const caret = this.edit.caret;
        this.edit.hints = []; this.edit.sig = '';
        if (!this.edit.on || text[0] !== '=' || this.composing) { return; }
        const word = wordAtCaret(text, caret);
        const all = (Calc.functions && Calc.functions()) || [];
        if (word.length >= 1) { this.edit.hints = all.filter((f) => f.name.startsWith(word.toUpperCase())).slice(0, 8); this.edit.hintIdx = 0; }
        if (!this.edit.hints.length) { const call = callAtCaret(text, caret); if (call && all.some((f) => f.name === call.name)) { this.edit.sig = call; } }
      },
      takeHint(h) {
        const text = this.edit.text; const caret = this.edit.caret;
        const word = wordAtCaret(text, caret);
        const next = text.slice(0, caret - word.length) + h.name + '(' + text.slice(caret);
        this.setEditText(next, caret - word.length + h.name.length + 1);
      },
      setEditText(text, caret) {
        this.edit.text = text; this.edit.caret = caret;
        const el = this.edit.source === 'bar' ? this.$refs.finput : this.$refs.editor;
        this.$nextTick(() => { if (el) { el.value = text; try { el.setSelectionRange(caret, caret); } catch (e) { /* not focusable */ } } this.placeEditor(); this.paint(); this.updateHints(); });
      },
      editorKey(e) {
        if (!this.edit.on) { return; }
        const k = e.key;
        if (e.isComposing || this.composing || e.keyCode === 229) { return; }
        if (k === 'Escape') { e.preventDefault(); this.cancelEdit(); return; }
        if (this.edit.hints.length && (k === 'ArrowDown' || k === 'ArrowUp')) { e.preventDefault(); this.edit.hintIdx = (this.edit.hintIdx + (k === 'ArrowDown' ? 1 : this.edit.hints.length - 1)) % this.edit.hints.length; return; }
        if (this.edit.hints.length && k === 'Tab') { e.preventDefault(); this.takeHint(this.edit.hints[this.edit.hintIdx]); return; }
        if (k === 'Enter') {
          if (e.altKey) { e.preventDefault(); const t = this.edit.text; const c = this.edit.caret; this.setEditText(t.slice(0, c) + '\n' + t.slice(c), c + 1); return; }
          if (this.edit.hints.length && this.edit.hints[this.edit.hintIdx] && wordAtCaret(this.edit.text, this.edit.caret) && this.edit.hints[this.edit.hintIdx].name !== wordAtCaret(this.edit.text, this.edit.caret).toUpperCase()) { e.preventDefault(); this.takeHint(this.edit.hints[this.edit.hintIdx]); return; }
          e.preventDefault(); if (this.commitEdit()) { this.enterMove(e.shiftKey); } return;
        }
        if (k === 'Tab') { e.preventDefault(); if (this.commitEdit()) { if (this.tabStart == null && !e.shiftKey) { this.tabStart = this.sel.cur.c; } this.setCur(this.sel.cur.r, this.sel.cur.c + (e.shiftKey ? -1 : 1)); } return; }
        if (k === 'F4') { e.preventDefault(); this.cycleRefAtCaret(); return; }
        if (/^Arrow/.test(k)) {
          const dr = k === 'ArrowDown' ? 1 : k === 'ArrowUp' ? -1 : 0; const dc = k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : 0;
          // in a formula, where a reference may go, the arrows point at cells
          if (this.edit.text[0] === '=') {
            const slot = refSlot(this.edit.text, this.edit.caret);
            if (slot && (slot.replace === false || this.edit.pointer)) {
              e.preventDefault();
              const p = this.edit.pointer || { r: this.edit.r, c: this.edit.c, r2: null, c2: null };
              if (e.shiftKey && p.set) { p.r2 = clamp((p.r2 == null ? p.r : p.r2) + dr, 0, MAX_ROWS - 1); p.c2 = clamp((p.c2 == null ? p.c : p.c2) + dc, 0, MAX_COLS - 1); }
              else { p.r = clamp(p.r + dr, 0, MAX_ROWS - 1); p.c = clamp(p.c + dc, 0, MAX_COLS - 1); p.r2 = null; p.c2 = null; }
              p.set = true; this.edit.pointer = p;
              const g = p.r2 == null ? { r0: p.r, c0: p.c, r1: p.r, c1: p.c } : norm({ r: p.r, c: p.c }, { r: p.r2, c: p.c2 });
              this.insertRef(g, this.active !== this.edit.sheetIdx ? this.sheetName() : null);
              this.ensureVisible(p.r2 == null ? p.r : p.r2, p.c2 == null ? p.c : p.c2);
              return;
            }
          }
          if (this.edit.mode === 'quick') { e.preventDefault(); if (this.commitEdit()) { this.setCur(this.sel.cur.r + dr, this.sel.cur.c + dc); } return; }
          // full edit: the caret moves in the text
          return;
        }
        if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 's') { e.preventDefault(); if (this.commitEdit()) { this.save(true); } return; }
        if (k === 'Home' || k === 'End' || k === 'PageUp' || k === 'PageDown') { if (this.edit.mode === 'quick' && k !== 'Home' && k !== 'End') { e.preventDefault(); this.commitEdit(); this.gridKey(e); } }
      },
      /** Puts a reference at the caret's slot (replacing the one being pointed at). */
      insertRef(g, sheetName) {
        const slot = refSlot(this.edit.text, this.edit.caret) || (this.edit.refSlot ? { start: this.edit.refSlot.start, end: this.edit.refSlot.end } : null);
        if (!slot) { return; }
        let ref = rangeName(g);
        if (sheetName) { ref = (/[^\w]/.test(sheetName) ? "'" + sheetName.replace(/'/g, "''") + "'" : sheetName) + '.' + ref; }
        const start = this.edit.refSlot && this.edit.refSlot.start === slot.start ? this.edit.refSlot.start : slot.start;
        const end = this.edit.refSlot && this.edit.refSlot.start === slot.start ? this.edit.refSlot.end : slot.end;
        const text = this.edit.text.slice(0, start) + ref + this.edit.text.slice(end);
        this.edit.refSlot = { start, end: start + ref.length };
        this.setEditText(text, start + ref.length);
      },
      cycleRefAtCaret() {
        const refs = refsInFormula(this.edit.text); const caret = this.edit.caret;
        let hit = refs.find((r) => caret >= r.start && caret <= r.end);
        if (!hit) { hit = refs.filter((r) => r.end <= caret).pop(); }
        if (!hit) { return; }
        const next = cycleAbs(hit.text);
        this.setEditText(this.edit.text.slice(0, hit.start) + next + this.edit.text.slice(hit.end), hit.start + next.length);
      },
      /** Pointing at cells with the mouse while writing a formula. */
      startRefDrag(e, hit, slot) {
        const from = { r: hit.r, c: hit.c };
        const otherSheet = this.active !== this.edit.sheetIdx ? this.sheetName() : null;
        this.edit.refSlot = { start: slot.start, end: slot.end };
        this.edit.pointer = { r: hit.r, c: hit.c, r2: null, c2: null, set: true };
        this.insertRef({ r0: hit.r, c0: hit.c, r1: hit.r, c1: hit.c }, otherSheet);
        const move = (ev) => { const h = this.hitTest(ev.clientX, ev.clientY); if (h.kind === 'cell') { this.insertRef(norm(from, { r: h.r, c: h.c }), otherSheet); } };
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); const el = this.edit.source === 'bar' ? this.$refs.finput : this.$refs.editor; if (el) { el.focus(); } };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      },
      commitEdit() {
        if (!this.edit.on) { return true; }
        const sh = UIS[this.edit.sheetIdx]; const text = this.edit.text;
        const r = this.edit.r; const c = this.edit.c;
        const el = this.$refs.editor;
        if (sh && this.inputAt(r, c) !== text || (sh && this.active !== this.edit.sheetIdx)) {
          if (this.active !== this.edit.sheetIdx) { this.active = this.edit.sheetIdx; }
          const was = this.inputOf(wb.get(sh.name, r, c), (sh.meta.get(K(r, c)) || {}).fmt);
          if (was !== text) { this.withStep((rec) => { rec(sh, r, c); this.setInputRaw(sh, r, c, text); }); }
        }
        this.edit.on = false; this.edit.text = ''; this.edit.hints = []; this.edit.sig = ''; this.edit.pointer = null; this.edit.refSlot = null; this._refsFor = null;
        if (el) { el.value = ''; }
        this.fbarFocused = false;
        this.placeEditor(); this.syncSel(); this.paint(); this.focusGrid();
        return true;
      },
      cancelEdit() {
        if (!this.edit.on) { return; }
        if (this.active !== this.edit.sheetIdx && UIS[this.edit.sheetIdx]) { this.active = this.edit.sheetIdx; }
        this.edit.on = false; this.edit.text = ''; this.edit.hints = []; this.edit.sig = ''; this.edit.pointer = null; this.edit.refSlot = null; this._refsFor = null;
        const el = this.$refs.editor; if (el) { el.value = ''; }
        this.fbarFocused = false;
        this.placeEditor(); this.layout(); this.focusGrid();
      },
      editorBlur(e) {
        const to = e.relatedTarget;
        if (!this.edit.on) { return; }
        if (to && (to.closest('.cb-fbar') || to.closest('.cb-gridwrap') || to.closest('.cb-hints') || to.closest('.cb-sheets') || to.closest('.cb-topbar'))) { return; }
        if (to && to.closest('.cb-modal-back')) { return; }
        // the focus went elsewhere (the sidebar, the AI column): what was typed goes in
        if (to) { this.commitEdit(); }
      },
      // the formula bar is a second place to type the same text
      fbarFocus() {
        if (this.book.readOnly) { return; }
        this.fbarFocused = true;
        if (!this.edit.on) { this.startEdit('full'); }
        this.edit.source = 'bar';
        this.$nextTick(() => { const el = this.$refs.finput; if (el) { el.focus(); this.edit.caret = el.selectionStart; } });
      },
      fbarInput(e) { this.edit.source = 'bar'; this.edit.text = e.target.value; this.edit.caret = e.target.selectionStart; this.placeEditor(); this.paint(); this.updateHints(); },
      fbarKey(e) {
        if (!this.edit.on) { return; }
        if (e.key === 'Enter' && !e.altKey && !e.shiftKey) { e.preventDefault(); if (this.commitEdit()) { this.enterMove(false); } return; }
        if (e.key === 'Enter' && e.altKey) { e.preventDefault(); const t = this.edit.text; const c = this.edit.caret; this.setEditText(t.slice(0, c) + '\n' + t.slice(c), c + 1); return; }
        if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(); return; }
        if (e.key === 'Tab') { e.preventDefault(); if (this.edit.hints.length) { this.takeHint(this.edit.hints[this.edit.hintIdx]); return; } if (this.commitEdit()) { this.setCur(this.sel.cur.r, this.sel.cur.c + 1); } return; }
        if (e.key === 'F4') { e.preventDefault(); this.cycleRefAtCaret(); return; }
        if (this.edit.hints.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); this.edit.hintIdx = (this.edit.hintIdx + (e.key === 'ArrowDown' ? 1 : this.edit.hints.length - 1)) % this.edit.hints.length; }
      },
      imeStart() { /* the composition lands in the editor textarea itself; nothing to do */ },

      // ---- the clipboard ----
      /** The cells of the selection as the clipboard carries them: TSV of what is shown, an HTML table with the formulas, and CalcBase's own copy. */
      clipData() {
        const sh = this.sheet(); const g = this.selRange();
        const r1 = Math.min(g.r1, Math.max(sh.maxR, g.r0) + 1); const c1 = Math.min(g.c1, Math.max(sh.maxC, g.c0) + 1);
        const cells = []; const tsv = []; const html = [];
        clipSerial += 1;
        const id = 'cb' + Date.now() + '-' + clipSerial;
        for (let r = g.r0; r <= r1; r += 1) {
          const row = []; const trow = []; const hrow = [];
          for (let c = g.c0; c <= c1; c += 1) {
            const st = this.cellState(sh, r, c); const gg = wb.get(sh.name, r, c);
            const shown = gg.t ? Calc.format(gg.v, gg.t, fmtOf(sh.meta.get(K(r, c)), gg), 'ja') : '';
            row.push(st); trow.push(tsvCell(shown));
            const a = []; if (gg.f) { a.push(' data-f="' + esc(gg.f) + '"'); } if (gg.t) { a.push(' data-t="' + gg.t + '"'); if (gg.t === 'n' || gg.t === 'b') { a.push(' data-v="' + esc(String(gg.v)) + '"'); } }
            const fo = fmtForFile(fmtOf(sh.meta.get(K(r, c)), gg)); if (fo) { a.push(' data-fmt="' + esc(fo) + '"'); } const css = styleToCss(st.s); if (css) { a.push(' style="' + esc(css) + '"'); }
            hrow.push('<td' + a.join('') + '>' + esc(shown) + '</td>');
          }
          cells.push(row); tsv.push(trow.join('\t')); html.push('<tr>' + hrow.join('') + '</tr>');
        }
        return { id, sheet: sh.name, range: { r0: g.r0, c0: g.c0, r1, c1 }, cells, tsv: tsv.join('\n'), html: '<table data-cb-clip="' + id + '"><tbody>' + html.join('') + '</tbody></table>' };
      },
      onCopy(e) {
        if (this.edit.on || !this.book.id) { return; }
        e.preventDefault();
        const d = this.clipData();
        CLIP = Object.assign({ cut: false }, d);
        this.cutMark = null; this.paint();
        try { e.clipboardData.setData('text/plain', d.tsv); e.clipboardData.setData('text/html', d.html); } catch (err) { /* the app's own copy still works */ }
      },
      onCut(e) {
        if (this.edit.on || !this.book.id) { return; }
        if (this.book.readOnly) { e.preventDefault(); return; }
        this.onCopy(e);
        CLIP.cut = true;
        this.cutMark = Object.assign({}, CLIP.range); this.paint();
      },
      clipCopy() { this.focusGrid(); const d = this.clipData(); CLIP = Object.assign({ cut: false }, d); this.cutMark = null; this.writeSystemClipboard(d); this.paint(); },
      clipCut() { if (this.book.readOnly) { return; } this.focusGrid(); const d = this.clipData(); CLIP = Object.assign({ cut: true }, d); this.writeSystemClipboard(d); this.cutMark = Object.assign({}, d.range); this.paint(); },
      writeSystemClipboard(d) {
        try {
          if (navigator.clipboard && window.ClipboardItem) {
            navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([d.tsv], { type: 'text/plain' }), 'text/html': new Blob([d.html], { type: 'text/html' }) })]).catch(() => {});
          } else if (navigator.clipboard) { navigator.clipboard.writeText(d.tsv).catch(() => {}); }
        } catch (e) { /* the app's own copy still works */ }
      },
      onPaste(e) {
        if (this.edit.on || !this.book.id) { return; }
        e.preventDefault();
        if (this.book.readOnly) { return; }
        const valuesOnly = !!this.pasteValuesOnly; this.pasteValuesOnly = false;
        const html = e.clipboardData ? e.clipboardData.getData('text/html') : '';
        const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        this.pasteFrom(html, text, valuesOnly);
      },
      /** The toolbar's and the menu's Paste: the system clipboard where the browser allows it, else the app's own copy. */
      async clipPasteButton(mode) {
        this.focusGrid();
        if (this.book.readOnly) { return; }
        let html = ''; let text = '';
        try {
          if (navigator.clipboard && navigator.clipboard.read) {
            const items = await navigator.clipboard.read();
            for (const it of items) { if (it.types.includes('text/html')) { html = await (await it.getType('text/html')).text(); } if (it.types.includes('text/plain')) { text = await (await it.getType('text/plain')).text(); } }
          } else if (navigator.clipboard && navigator.clipboard.readText) { text = await navigator.clipboard.readText(); }
        } catch (err) { /* not allowed: the app's own copy below */ }
        this.pasteFrom(html, text, mode === 'values');
      },
      pasteFrom(html, text, valuesOnly) {
        const sh = this.sheet(); const g = this.selRange();
        let grid = null; let own = null;
        const table = html ? tableFromHtml(html) : null;
        if (table && table.own && CLIP && CLIP.id === table.own) { own = CLIP; }
        else if (!html && !text && CLIP) { own = CLIP; }
        if (!own) {
          if (table && table.rows.length) { grid = table.rows.map((row) => row.map((o) => ({ input: o.f && !valuesOnly ? o.f : (o.v != null && o.t === 'n' ? String(o.v) : o.text), fmt: valuesOnly ? '' : o.fmt, s: valuesOnly ? null : o.s }))); }
          else if (text) { grid = parseTsv(text).map((row) => row.map((v) => ({ input: v, fmt: '', s: null }))); }
        }
        if (!own && !grid) { return; }
        const srcRows = own ? own.cells.length : grid.length; const srcCols = own ? own.cells[0].length : Math.max(...grid.map((r) => r.length));
        if (!srcRows || !srcCols) { return; }
        // Into the selection: once if the selection is a single cell (or smaller), tiled if it is a multiple.
        const selRows = g.r1 - g.r0 + 1; const selCols = g.c1 - g.c0 + 1;
        const tileR = selRows >= srcRows && selRows % srcRows === 0 ? selRows / srcRows : 1;
        const tileC = selCols >= srcCols && selCols % srcCols === 0 ? selCols / srcCols : 1;
        const r1 = g.r0 + srcRows * tileR - 1; const c1 = g.c0 + srcCols * tileC - 1;
        if (r1 >= MAX_ROWS || c1 >= MAX_COLS) { this.notify(this.t('That does not fit on the sheet.')); return; }
        this.withStep((rec) => {
          if (own && own.cut && UIS.find((u) => u.name === own.sheet)) {
            // cut-and-paste: the cells leave where they were only now, and every
            // formula that pointed at them is recorded too, so one Ctrl+Z puts the
            // whole move back
            const src = UIS.find((u) => u.name === own.sheet);
            for (let r = own.range.r0; r <= own.range.r1; r += 1) { for (let c = own.range.c0; c <= own.range.c1; c += 1) { rec(src, r, c); } }
            let n = 0;
            wb.toModel().sheets.forEach((ms) => { const u = UIS.find((x) => x.name === ms.name); if (!u) { return; } Object.keys(ms.cells).forEach((key) => { if (!ms.cells[key].f || n > 50000) { return; } const pp = parseRef(key); if (pp) { rec(u, pp.r, pp.c); n += 1; } }); });
            for (let r = own.range.r0; r <= own.range.r1; r += 1) { for (let c = own.range.c0; c <= own.range.c1; c += 1) { wb.setInput(src.name, r, c, ''); this.setMeta(src, r, c, { fmt: '', s: null }); } }
          }
          for (let r = g.r0; r <= r1; r += 1) { for (let c = g.c0; c <= c1; c += 1) { rec(sh, r, c); } }
          for (let r = g.r0; r <= r1; r += 1) {
            for (let c = g.c0; c <= c1; c += 1) {
              const sr = (r - g.r0) % srcRows; const sc = (c - g.c0) % srcCols;
              let cell = own ? own.cells[sr][sc] : (grid[sr] && grid[sr][sc]) || { input: '', fmt: '', s: null };
              let input = cell.input || '';
              if (own && input[0] === '=') { input = own.cut ? input : Calc.shiftFormula(input, r - (own.range.r0 + sr), c - (own.range.c0 + sc)); }
              if (valuesOnly && input[0] === '=') { const src = UIS.find((u) => u.name === own.sheet); const gg = own && src ? { t: 's', v: '' } : null; input = gg ? input : input; const shown = own ? this.valueOfClip(own, sr, sc) : input; input = shown; }
              this.setInputRaw(sh, r, c, input);
              const implied = (sh.meta.get(K(r, c)) || {}).fmt || '';
              if (!valuesOnly) { this.setMeta(sh, r, c, { fmt: cell.fmt || implied, s: cell.s || null }); } else { this.setMeta(sh, r, c, { fmt: cell.fmt || implied }); }
            }
          }
          if (own && own.cut) {
            const src = UIS.find((u) => u.name === own.sheet);
            if (src && !(src === sh && own.range.r0 === g.r0 && own.range.c0 === g.c0)) {
              // references elsewhere that pointed at the cut cells now point at the pasted ones
              this.retarget(src, own.range, sh, g.r0, g.c0);
            }
            CLIP.cut = false; this.cutMark = null;
          }
          this.sel.ranges = [{ r0: g.r0, c0: g.c0, r1, c1 }]; this.sel.cur = { r: g.r0, c: g.c0 }; this.sel.anchor = { r: g.r0, c: g.c0 };
        });
      },
      /** The shown value of a copied cell, for "paste values only". */
      valueOfClip(own, sr, sc) {
        const src = UIS.find((u) => u.name === own.sheet);
        const cell = own.cells[sr][sc];
        if (!cell.input || cell.input[0] !== '=' || !src) { return cell.input || ''; }
        const g = wb.get(src.name, own.range.r0 + sr, own.range.c0 + sc);
        return g.t === 'e' ? '' : this.inputOf(Object.assign({}, g, { f: '' }), cell.fmt);
      },
      /** After a cut-and-paste: every formula that pointed into the moved block points at where it went. */
      retarget(src, range, dst, r0, c0) {
        const dr = r0 - range.r0; const dc = c0 - range.c0;
        const m = wb.toModel();
        m.sheets.forEach((s) => {
          const u = UIS.find((x) => x.name === s.name); if (!u) { return; }
          Object.keys(s.cells).forEach((key) => {
            const cell = s.cells[key]; if (!cell.f) { return; }
            const refs = refsInFormula(cell.f);
            let out = cell.f; let changed = false;
            for (let i = refs.length - 1; i >= 0; i -= 1) {
              const ref = refs[i]; const target = ref.sheet == null ? s.name : ref.sheet;
              if (target !== src.name) { continue; }
              const g = ref.range;
              if (g.r0 >= range.r0 && g.r1 <= range.r1 && g.c0 >= range.c0 && g.c1 <= range.c1) {
                const moved = { r0: g.r0 + dr, c0: g.c0 + dc, r1: g.r1 + dr, c1: g.c1 + dc };
                const sm = /^((?:'(?:[^']|'')+'|\$?[A-Za-z_]\w*)[.!])?/.exec(ref.text);
                let prefix = sm[1] || '';
                if (dst !== src) { prefix = (/[^\w]/.test(dst.name) ? "'" + dst.name + "'" : dst.name) + '.'; } else if (prefix && dst === src) { /* keep */ }
                const keep$ = (a, b) => (ref.text.includes('$') ? a : b);
                out = out.slice(0, ref.start) + prefix + keep$(rangeName(moved), rangeName(moved)) + out.slice(ref.end);
                changed = true;
              }
            }
            if (changed) { const p = parseRef(key); wb.setInput(s.name, p.r, p.c, out); }
          });
        });
      },
      fieldCmd(kind) {
        this.closeCtx();
        const el = this._fieldTarget; if (!el) { return; }
        el.focus();
        if (kind === 'paste') { if (navigator.clipboard && navigator.clipboard.readText) { navigator.clipboard.readText().then((t) => { const s = el.selectionStart; const e = el.selectionEnd; el.setRangeText(t, s, e, 'end'); el.dispatchEvent(new Event('input', { bubbles: true })); }).catch(() => {}); } return; }
        try { document.execCommand(kind); } catch (e) { /* not allowed */ }
      },
      // ---- the fill handle and Ctrl+D / Ctrl+R ----
      startFillDrag(e) {
        const src = this.selRange();
        let target = null;
        const move = (ev) => {
          const hit = this.hitTest(ev.clientX, ev.clientY); this.autoScroll(ev);
          if (hit.kind !== 'cell') { return; }
          const dr = hit.r < src.r0 ? hit.r - src.r0 : hit.r > src.r1 ? hit.r - src.r1 : 0;
          const dc = hit.c < src.c0 ? hit.c - src.c0 : hit.c > src.c1 ? hit.c - src.c1 : 0;
          if (Math.abs(dr) >= Math.abs(dc)) { target = dr ? { r0: dr > 0 ? src.r0 : hit.r, c0: src.c0, r1: dr > 0 ? hit.r : src.r1, c1: src.c1, dir: dr > 0 ? 'down' : 'up' } : null; }
          else { target = { r0: src.r0, c0: dc > 0 ? src.c0 : hit.c, r1: src.r1, c1: dc > 0 ? hit.c : src.c1, dir: dc > 0 ? 'right' : 'left' }; }
          this.fillPrev = target; this.paint();
        };
        const up = () => {
          document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); clearInterval(this._autoScroll); this._autoScroll = 0;
          this.fillPrev = null;
          if (target) { this.fillRange(src, target); } else { this.paint(); }
        };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      },
      /** Fills `target` from `src`: formulas are shifted, constants continue their series (1,2 -> 3,4; Mon -> Tue). */
      fillRange(src, target, copyOnly) {
        const sh = this.sheet();
        this.withStep((rec) => {
          const vertical = target.dir === 'down' || target.dir === 'up';
          if (vertical) {
            for (let c = src.c0; c <= src.c1; c += 1) {
              const states = []; for (let r = src.r0; r <= src.r1; r += 1) { states.push(this.cellState(sh, r, c)); }
              const rows = []; if (target.dir === 'down') { for (let r = src.r1 + 1; r <= target.r1; r += 1) { rows.push(r); } } else { for (let r = src.r0 - 1; r >= target.r0; r -= 1) { rows.push(r); } }
              this.fillLine(sh, states, rows.map((r) => ({ r, c })), src.r0, src.c0, rec, target.dir === 'up', copyOnly);
            }
          } else {
            for (let r = src.r0; r <= src.r1; r += 1) {
              const states = []; for (let c = src.c0; c <= src.c1; c += 1) { states.push(this.cellState(sh, r, c)); }
              const cols = []; if (target.dir === 'right') { for (let c = src.c1 + 1; c <= target.c1; c += 1) { cols.push(c); } } else { for (let c = src.c0 - 1; c >= target.c0; c -= 1) { cols.push(c); } }
              this.fillLine(sh, states, cols.map((c) => ({ r, c })), src.r0, src.c0, rec, target.dir === 'left', copyOnly);
            }
          }
          this.sel.ranges = [{ r0: target.r0, c0: target.c0, r1: target.r1, c1: target.c1 }];
        });
      },
      fillLine(sh, states, targets, r0, c0, rec, backwards, copyOnly) {
        if (!targets.length) { return; }
        const n = states.length;
        const anyFormula = states.some((s) => s.input[0] === '=');
        const consts = states.map((s) => (s.input[0] === '=' ? null : s.input));
        let series = null;
        if (!copyOnly && !anyFormula && consts.every((v) => v !== '')) {
          const vals = consts.map((v) => { const p = Calc.parseInput(v, 'ja'); return p.t === 'n' ? p.v : v; });
          const ordered = backwards ? vals.slice().reverse() : vals;
          if (backwards && typeof ordered[0] === 'number' && ordered.length === 1) { series = Calc.fillSeries([ordered[0] + 1, ordered[0]], targets.length); }
          else { series = Calc.fillSeries(ordered, targets.length); }
        }
        targets.forEach((tg, i) => {
          rec(sh, tg.r, tg.c);
          const si = backwards ? (n - 1 - (i % n)) : i % n;
          const st = states[si];
          let input;
          if (st.input[0] === '=') {
            const srcR = r0 + (targets[0].c === targets[targets.length - 1].c ? si : 0); const srcC = c0 + (targets[0].r === targets[targets.length - 1].r ? si : 0);
            input = Calc.shiftFormula(st.input, tg.r - srcR, tg.c - srcC);
          } else if (series && series[i] != null) {
            const v = series[i];
            input = typeof v === 'number' ? (st.fmt && (isDateFmt(st.fmt) || isTimeFmt(st.fmt)) ? Calc.format(v, 'n', st.fmt, 'ja') : String(Math.round(v * 1e10) / 1e10)) : String(v);
          } else { input = st.input; }
          this.setInputRaw(sh, tg.r, tg.c, input);
          this.setMeta(sh, tg.r, tg.c, { fmt: st.fmt, s: st.s });
        });
      },
      fillSelection(dir) {
        const g = this.selRange();
        if (dir === 'down' && g.r1 > g.r0) { this.fillRange({ r0: g.r0, c0: g.c0, r1: g.r0, c1: g.c1 }, { r0: g.r0, c0: g.c0, r1: g.r1, c1: g.c1, dir: 'down' }, true); }
        else if (dir === 'right' && g.c1 > g.c0) { this.fillRange({ r0: g.r0, c0: g.c0, r1: g.r1, c1: g.c0 }, { r0: g.r0, c0: g.c0, r1: g.r1, c1: g.c1, dir: 'right' }, true); }
        else if (dir === 'down' && g.r0 > 0) { this.fillRange({ r0: g.r0 - 1, c0: g.c0, r1: g.r0 - 1, c1: g.c1 }, { r0: g.r0 - 1, c0: g.c0, r1: g.r0, c1: g.c1, dir: 'down' }, true); }
      },
      /** Dragging a selection by its edge moves it (cut-and-paste by hand). */
      startMoveDrag(e, g, hit) {
        const off = { r: hit.r - g.r0, c: hit.c - g.c0 };
        let dst = null;
        const move = (ev) => { const h = this.hitTest(ev.clientX, ev.clientY); this.autoScroll(ev); if (h.kind !== 'cell') { return; } const r0 = Math.max(0, h.r - off.r); const c0 = Math.max(0, h.c - off.c); dst = { r0, c0, r1: r0 + g.r1 - g.r0, c1: c0 + g.c1 - g.c0 }; this.movePrev = dst; this.paint(); };
        const up = () => {
          document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); clearInterval(this._autoScroll); this._autoScroll = 0;
          this.movePrev = null;
          if (dst && (dst.r0 !== g.r0 || dst.c0 !== g.c0)) { this.moveCells(g, dst); } else { this.paint(); }
        };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      },
      moveCells(g, dst) {
        const sh = this.sheet();
        this.withStep((rec) => {
          for (let r = g.r0; r <= g.r1; r += 1) { for (let c = g.c0; c <= g.c1; c += 1) { rec(sh, r, c); } }
          for (let r = dst.r0; r <= dst.r1; r += 1) { for (let c = dst.c0; c <= dst.c1; c += 1) { rec(sh, r, c); } }
          const metas = []; for (let r = g.r0; r <= g.r1; r += 1) { for (let c = g.c0; c <= g.c1; c += 1) { const m = sh.meta.get(K(r, c)); metas.push(m ? Object.assign({}, m) : null); sh.meta.delete(K(r, c)); } }
          wb.moveRange(sh.name, rangeName(g), refName(dst.r0, dst.c0));
          let i = 0; for (let r = dst.r0; r <= dst.r1; r += 1) { for (let c = dst.c0; c <= dst.c1; c += 1) { const m = metas[i]; i += 1; if (m) { sh.meta.set(K(r, c), m); } else { sh.meta.delete(K(r, c)); } } }
          if (dst.r1 > sh.maxR) { sh.maxR = dst.r1; } if (dst.c1 > sh.maxC) { sh.maxC = dst.c1; }
          this.sel.ranges = [Object.assign({}, dst)]; this.sel.cur = { r: dst.r0, c: dst.c0 }; this.sel.anchor = { r: dst.r0, c: dst.c0 };
        });
      },
      // ---- clearing, formatting ----
      clearCells(what) {
        if (this.book.readOnly) { return; }
        this.withStep((rec) => {
          this.eachSelCell((sh, r, c) => {
            const g = wb.get(sh.name, r, c); const meta = sh.meta.get(K(r, c));
            if (!g.t && !meta) { return; }
            rec(sh, r, c);
            if (what === 'contents' || what === 'all') { wb.setInput(sh.name, r, c, ''); }
            if (what === 'formats' || what === 'all') { this.setMeta(sh, r, c, { fmt: '', s: null }); }
          });
        });
      },
      /** A style property on every cell of the selection. */
      setStyle(key, value) {
        if (this.book.readOnly) { return; }
        this.focusGrid();
        this.withStep((rec) => {
          this.eachSelCell((sh, r, c) => {
            rec(sh, r, c);
            const meta = sh.meta.get(K(r, c)) || {}; const s = Object.assign({}, meta.s || {});
            if (value === '' || value === 0 || value === false || value == null) { delete s[key]; } else { s[key] = value; }
            this.setMeta(sh, r, c, { s });
          }, 20000);
        });
      },
      toggleStyle(key) { const on = !!this.fmtNow[key]; this.setStyle(key, on ? '' : 1); },
      setFmt(code) {
        if (this.book.readOnly) { return; }
        this.focusGrid();
        this.withStep((rec) => { this.eachSelCell((sh, r, c) => { rec(sh, r, c); this.setMeta(sh, r, c, { fmt: code === 'General' || !code ? (wb.get(sh.name, r, c).fmt || wb.get(sh.name, r, c).fmtHint ? 'General' : '') : code }); }, 20000); });
      },
      stepDec(dir) {
        const g = wb.get(this.sheetName(), this.sel.cur.r, this.sel.cur.c);
        this.setFmt(stepDecimals(this.fmtNow.fmt, dir, g.v));
      },
      applyBorderPreset(key) {
        if (this.book.readOnly) { return; }
        const g = this.selRange(); const line = '1px solid #000000';
        this.withStep((rec) => {
          this.eachSelCell((sh, r, c) => {
            rec(sh, r, c);
            const meta = sh.meta.get(K(r, c)) || {}; const s = Object.assign({}, meta.s || {});
            const top = r === g.r0; const bottom = r === g.r1; const left = c === g.c0; const right = c === g.c1;
            if (key === 'none') { delete s.bt; delete s.bb; delete s.bl; delete s.br; }
            if (key === 'all') { s.bt = s.bb = s.bl = s.br = line; }
            if (key === 'outer') { if (top) { s.bt = line; } if (bottom) { s.bb = line; } if (left) { s.bl = line; } if (right) { s.br = line; } }
            if (key === 'inner') { if (!top) { s.bt = line; } if (!bottom) { s.bb = line; } if (!left) { s.bl = line; } if (!right) { s.br = line; } }
            if (key === 'top' && top) { s.bt = line; } if (key === 'bottom' && bottom) { s.bb = line; } if (key === 'left' && left) { s.bl = line; } if (key === 'right' && right) { s.br = line; }
            this.setMeta(sh, r, c, { s });
          }, 20000);
        });
      },
      toggleMerge() {
        if (this.book.readOnly) { return; }
        const sh = this.sheet(); const g = this.selRange();
        const idx = sh.merges.findIndex((m) => m.r0 === g.r0 && m.c0 === g.c0 && m.r1 === g.r1 && m.c1 === g.c1);
        const apply = (list) => { sh.merges = list.map((m) => Object.assign({}, m)); this.touch(); this.afterChange(); };
        const was = sh.merges.map((m) => Object.assign({}, m));
        let now;
        if (idx >= 0) { now = was.filter((m, i) => i !== idx); }
        else {
          if (g.r0 === g.r1 && g.c0 === g.c1) { return; }
          // The hidden cells keep what is in them (LibreOffice's default when
          // merging, "Keep the contents of the hidden cells"): nothing is lost,
          // and it comes back when the cells are split again.
          now = was.filter((m) => !(m.r1 >= g.r0 && m.r0 <= g.r1 && m.c1 >= g.c0 && m.c0 <= g.c1)).concat([{ r0: g.r0, c0: g.c0, r1: g.r1, c1: g.c1 }]);
          this.sel.cur = { r: g.r0, c: g.c0 };
        }
        apply(now);
        this.pushStep({ undo: () => apply(was), redo: () => apply(now) });
      },
      toggleFreeze() {
        if (this.book.readOnly) { return; }
        const sh = this.sheet(); const was = sh.freeze ? Object.assign({}, sh.freeze) : null;
        const cur = this.sel.cur;
        const now = sh.freeze ? null : (cur.r || cur.c ? { r: cur.r, c: cur.c } : { r: 1, c: 0 });
        const set = (v) => { sh.freeze = v; this.touch(); this.afterChange(); };
        set(now);
        this.pushStep({ undo: () => set(was), redo: () => set(now) });
      },
      toggleGrid() { const sh = this.sheet(); if (!sh || this.book.readOnly) { return; } sh.grid = sh.grid === false; this.touch(); this.afterChange(); },
      // ---- rows and columns ----
      /** The rows (columns) the operation is about: the selection's, or the cursor's. */
      selRows() { const g = this.selRange(); return { at: g.r0, n: Math.min(g.r1, MAX_ROWS - 1) - g.r0 + 1 }; },
      selCols() { const g = this.selRange(); return { at: g.c0, n: Math.min(g.c1, MAX_COLS - 1) - g.c0 + 1 }; },
      /** Moves the page's own facts about rows -- heights, styles, merges, the frozen split -- when rows are put in or taken out. */
      shiftMetaRows(sh, at, n) {
        const next = new Map(); sh.meta.forEach((m, k) => { const r = KR(k); const c = KC(k); if (n < 0 && r >= at && r < at - n) { return; } next.set(K(r >= at ? r + n : r, c), m); }); sh.meta = next;
        const rows = new Map(); sh.rows.forEach((h, r) => { if (n < 0 && r >= at && r < at - n) { return; } rows.set(r >= at ? r + n : r, h); }); sh.rows = rows;
        sh.merges = sh.merges.map((m) => { const mm = Object.assign({}, m); if (n < 0) { const d0 = at; const d1 = at - n - 1; if (m.r0 >= d0 && m.r1 <= d1) { return null; } if (m.r0 > d1) { mm.r0 += n; mm.r1 += n; } else if (m.r1 >= d0) { mm.r1 = Math.max(m.r0, m.r1 - Math.min(m.r1, d1) + Math.max(m.r0, d0) - 1); if (m.r0 > d0) { mm.r0 = d0; } } } else if (m.r0 >= at) { mm.r0 += n; mm.r1 += n; } else if (m.r1 >= at) { mm.r1 += n; } return mm; }).filter((m) => m && (m.r1 > m.r0 || m.c1 > m.c0));
        if (sh.freeze && sh.freeze.r > at) { sh.freeze.r = Math.max(at, sh.freeze.r + n); }
        if (sh.filter) { if (sh.filter.r0 >= at) { sh.filter.r0 += n; } sh.filter.r1 += n; }
        sh.maxR = Math.max(0, sh.maxR + n);
      },
      shiftMetaCols(sh, at, n) {
        const next = new Map(); sh.meta.forEach((m, k) => { const r = KR(k); const c = KC(k); if (n < 0 && c >= at && c < at - n) { return; } next.set(K(r, c >= at ? c + n : c), m); }); sh.meta = next;
        const cols = new Map(); sh.cols.forEach((w, c) => { if (n < 0 && c >= at && c < at - n) { return; } cols.set(c >= at ? c + n : c, w); }); sh.cols = cols;
        sh.merges = sh.merges.map((m) => { const mm = Object.assign({}, m); if (n < 0) { const d0 = at; const d1 = at - n - 1; if (m.c0 >= d0 && m.c1 <= d1) { return null; } if (m.c0 > d1) { mm.c0 += n; mm.c1 += n; } else if (m.c1 >= d0) { mm.c1 = Math.max(m.c0, m.c1 - Math.min(m.c1, d1) + Math.max(m.c0, d0) - 1); } } else if (m.c0 >= at) { mm.c0 += n; mm.c1 += n; } else if (m.c1 >= at) { mm.c1 += n; } return mm; }).filter((m) => m && (m.r1 > m.r0 || m.c1 > m.c0));
        if (sh.freeze && sh.freeze.c > at) { sh.freeze.c = Math.max(at, sh.freeze.c + n); }
        if (sh.filter) { if (sh.filter.c0 >= at) { sh.filter.c0 += n; } sh.filter.c1 += n; }
        sh.maxC = Math.max(0, sh.maxC + n);
      },
      /** A snapshot of the whole book's cells and page facts, for the undo of a structural change (rows and columns move, every formula may change). */
      snapshotBook() {
        const model = toFullModel(wb, UIS, this.active);
        const uis = UIS.map((u) => ({ name: u.name, cols: new Map(u.cols), rows: new Map(u.rows), meta: new Map(Array.from(u.meta.entries()).map(([k, m]) => [k, Object.assign({}, m)])), merges: u.merges.map((m) => Object.assign({}, m)), freeze: u.freeze ? Object.assign({}, u.freeze) : null, grid: u.grid, maxR: u.maxR, maxC: u.maxC, filter: u.filter ? JSON.parse(JSON.stringify(u.filter)) : null, extentR: u.extentR, extentC: u.extentC }));
        const sel = JSON.stringify(this.sel); const active = this.active;
        return () => { wb = Calc.workbook({ locale: uiLang() }); wb.load(model); if (wb.recalc) { wb.recalc(); } UIS = uis.map((u) => Object.assign(newSheetUI(u.name), u, { cols: new Map(u.cols), rows: new Map(u.rows), meta: new Map(Array.from(u.meta.entries()).map(([k, m]) => [k, Object.assign({}, m)])), merges: u.merges.map((m) => Object.assign({}, m)), freeze: u.freeze ? Object.assign({}, u.freeze) : null })); this.restoreSel(sel, active); };
      },
      /** A structural change: done through fn, undone by putting the snapshot back. */
      structural(fn) {
        const before = this.snapshotBook();
        fn();
        this.touch(); this.afterChange();
        const after = this.snapshotBook();
        this.pushStep({ undo: before, redo: after });
      },
      insertRows(below) {
        if (this.book.readOnly) { return; }
        const sh = this.sheet(); const { at, n } = this.selRows(); const where = below ? at + n : at;
        if (n > 10000) { this.notify(this.t('Too many rows at once.')); return; }
        this.structural(() => { wb.insertRows(sh.name, where, n); this.shiftMetaRows(sh, where, n); this.sel.ranges = [{ r0: where, c0: 0, r1: where + n - 1, c1: MAX_COLS - 1 }]; this.sel.cur = { r: where, c: this.sel.cur.c }; });
      },
      deleteRows() {
        if (this.book.readOnly) { return; }
        const sh = this.sheet(); const { at, n } = this.selRows();
        if (n > 10000 && n < MAX_ROWS) { this.notify(this.t('Too many rows at once.')); return; }
        this.structural(() => { wb.deleteRows(sh.name, at, Math.min(n, 10000)); this.shiftMetaRows(sh, at, -Math.min(n, 10000)); this.sel.ranges = [{ r0: at, c0: this.sel.cur.c, r1: at, c1: this.sel.cur.c }]; this.sel.cur = { r: at, c: this.sel.cur.c }; });
      },
      insertCols(after) {
        if (this.book.readOnly) { return; }
        const sh = this.sheet(); const { at, n } = this.selCols(); const where = after ? at + n : at;
        if (n > 1000) { this.notify(this.t('Too many columns at once.')); return; }
        this.structural(() => { wb.insertCols(sh.name, where, n); this.shiftMetaCols(sh, where, n); this.sel.ranges = [{ r0: 0, c0: where, r1: MAX_ROWS - 1, c1: where + n - 1 }]; this.sel.cur = { r: this.sel.cur.r, c: where }; });
      },
      deleteCols() {
        if (this.book.readOnly) { return; }
        const sh = this.sheet(); const { at, n } = this.selCols();
        if (n > 1000 && n < MAX_COLS) { this.notify(this.t('Too many columns at once.')); return; }
        this.structural(() => { wb.deleteCols(sh.name, at, Math.min(n, 1000)); this.shiftMetaCols(sh, at, -Math.min(n, 1000)); this.sel.ranges = [{ r0: this.sel.cur.r, c0: at, r1: this.sel.cur.r, c1: at }]; this.sel.cur = { r: this.sel.cur.r, c: at }; });
      },
      async askRowHeight() {
        const sh = this.sheet(); const { at, n } = this.selRows();
        const v = await this.askFor({ title: this.t('Row height'), label: this.t('Height (px)'), value: rowH(sh, at), number: true, min: 0, max: 600 });
        if (v == null || isNaN(v)) { return; }
        const rows = []; for (let r = at; r < at + Math.min(n, 10000); r += 1) { rows.push(r); }
        this.sizeLines('row', rows, clamp(Math.round(v), 0, 600));
      },
      async askColWidth() {
        const sh = this.sheet(); const { at, n } = this.selCols();
        const v = await this.askFor({ title: this.t('Column width'), label: this.t('Width (px)'), value: colW(sh, at), number: true, min: 0, max: 2000 });
        if (v == null || isNaN(v)) { return; }
        const cols = []; for (let c = at; c < at + Math.min(n, 1000); c += 1) { cols.push(c); }
        this.sizeLines('col', cols, clamp(Math.round(v), 0, 2000));
      },
      hideRows(hide) { const { at, n } = this.selRows(); const rows = []; for (let r = at; r < at + Math.min(n, 10000); r += 1) { rows.push(r); } this.sizeLines('row', rows, hide ? 0 : DEF_ROW_H); },
      hideCols(hide) { const { at, n } = this.selCols(); const cols = []; for (let c = at; c < at + Math.min(n, 1000); c += 1) { cols.push(c); } this.sizeLines('col', cols, hide ? 0 : DEF_COL_W); },
      /** Optimal width: as wide as the widest text in the column (the first 5,000 rows are measured). */
      fitCols(list) {
        const sh = this.sheet(); const cols = list || (() => { const { at, n } = this.selCols(); const a = []; for (let c = at; c < at + Math.min(n, 200); c += 1) { a.push(c); } return a; })();
        const z = 1;
        cols.forEach((c) => {
          let best = 20;
          for (let r = 0; r <= Math.min(sh.maxR, 5000); r += 1) {
            const g = wb.get(sh.name, r, c); if (!g.t) { continue; }
            const meta = sh.meta.get(K(r, c)); const f = this.cellFont(meta, z); const s = (meta && meta.s) || {};
            const text = Calc.format(g.v, g.t, fmtOf(meta, g), 'ja');
            best = Math.max(best, textWidth(text, fontCss(s.b, f.px, f.family)) + 10);
          }
          this.sizeLines('col', [c], Math.min(2000, Math.ceil(best)));
        });
      },
      fitRows(list) {
        const sh = this.sheet(); const rows = list || (() => { const { at, n } = this.selRows(); const a = []; for (let r = at; r < at + Math.min(n, 2000); r += 1) { a.push(r); } return a; })();
        rows.forEach((r) => {
          let best = DEF_ROW_H;
          for (let c = 0; c <= Math.min(sh.maxC, 200); c += 1) {
            const g = wb.get(sh.name, r, c); if (!g.t) { continue; }
            const meta = sh.meta.get(K(r, c)); const f = this.cellFont(meta, 1); const s = (meta && meta.s) || {};
            const text = Calc.format(g.v, g.t, fmtOf(meta, g), 'ja');
            let lines = text.split('\n').length;
            if (s.wrap) { const w = colW(sh, c) - 8; const tw = textWidth(text, fontCss(false, f.px, f.family)); lines = Math.max(lines, Math.ceil(tw / Math.max(1, w))); }
            best = Math.max(best, Math.ceil(lines * f.px * 1.25 + 4));
          }
          this.sizeLines('row', [r], Math.min(600, best));
        });
      },
      // ---- sorting and the autofilter ----
      /** The block of data round the cursor: the contiguous cells, as Calc's current region. */
      currentRegion() {
        const sh = this.sheet(); const g = this.selRange();
        if (g.r1 > g.r0 || g.c1 > g.c0) { return { r0: g.r0, c0: g.c0, r1: Math.min(g.r1, sh.maxR), c1: Math.min(g.c1, sh.maxC) }; }
        const has = (r, c) => r >= 0 && c >= 0 && !!wb.get(sh.name, r, c).t;
        let { r0, c0, r1, c1 } = g;
        let grew = true;
        while (grew) {
          grew = false;
          const rowHas = (r) => { for (let c = c0; c <= c1; c += 1) { if (has(r, c)) { return true; } } return false; };
          const colHas = (c) => { for (let r = r0; r <= r1; r += 1) { if (has(r, c)) { return true; } } return false; };
          if (r0 > 0 && rowHas(r0 - 1)) { r0 -= 1; grew = true; } if (r1 < sh.maxR && rowHas(r1 + 1)) { r1 += 1; grew = true; }
          if (c0 > 0 && colHas(c0 - 1)) { c0 -= 1; grew = true; } if (c1 < sh.maxC && colHas(c1 + 1)) { c1 += 1; grew = true; }
        }
        return { r0, c0, r1, c1 };
      },
      /** Does the block begin with a header row? Text across the top and something that is not text below it. */
      hasHeader(g) {
        const sh = this.sheet(); if (g.r1 === g.r0) { return false; }
        let texts = 0; let other = 0;
        for (let c = g.c0; c <= g.c1; c += 1) { const a = wb.get(sh.name, g.r0, c); const b = wb.get(sh.name, g.r0 + 1, c); if (a.t === 's') { texts += 1; } if (b.t && b.t !== 's') { other += 1; } }
        return texts > 0 && texts >= (g.c1 - g.c0 + 1) / 2 && other > 0;
      },
      sortSel(dir) {
        if (this.book.readOnly) { return; }
        const sh = this.sheet(); const g = this.currentRegion(); const col = clamp(this.sel.cur.c, g.c0, g.c1);
        const start = this.hasHeader(g) ? g.r0 + 1 : g.r0;
        if (g.r1 <= start) { return; }
        const rows = []; for (let r = start; r <= g.r1; r += 1) { rows.push(r); }
        const keyOf = (r) => wb.get(sh.name, r, col);
        const cmp = (a, b) => {
          const x = keyOf(a); const y = keyOf(b);
          // numbers before text, empty last (as Calc)
          const rank = (v) => (!v.t ? 3 : v.t === 'n' || v.t === 'b' ? 0 : v.t === 's' ? 1 : 2);
          if (rank(x) !== rank(y)) { return rank(x) - rank(y); }
          if (x.t === 'n') { return (x.v - y.v) * dir; }
          return String(x.v).localeCompare(String(y.v), 'ja', { numeric: true, sensitivity: 'base' }) * dir || 0;
        };
        const order = rows.slice().sort(cmp);
        if (order.every((r, i) => r === rows[i])) { return; }
        this.withStep((rec) => {
          const states = new Map();
          order.forEach((src) => { const row = []; for (let c = g.c0; c <= g.c1; c += 1) { row.push(this.cellState(sh, src, c)); } states.set(src, row); });
          rows.forEach((r) => { for (let c = g.c0; c <= g.c1; c += 1) { rec(sh, r, c); } });
          rows.forEach((dstR, i) => {
            const srcR = order[i]; const row = states.get(srcR);
            row.forEach((st, j) => { const c = g.c0 + j; const input = st.input[0] === '=' ? Calc.shiftFormula(st.input, dstR - srcR, 0) : st.input; this.setInputRaw(sh, dstR, c, input); this.setMeta(sh, dstR, c, { fmt: st.fmt, s: st.s }); });
          });
          this.sel.ranges = [g];
        });
      },
      toggleFilter() {
        if (this.book.readOnly) { return; }
        const sh = this.sheet();
        if (sh.filter) { const hidden = sh.filter.hidden || []; sh.filter = null; hidden.forEach((r) => sh.rows.delete(r)); this.touch(); this.afterChange(); return; }
        const g = this.currentRegion();
        if (g.r1 === g.r0) { this.notify(this.t('Put the cursor in a block of data with a header row first.')); return; }
        sh.filter = { r0: g.r0, c0: g.c0, r1: g.r1, c1: g.c1, cols: {}, hidden: [] };
        this.touch(); this.afterChange();
      },
      openFilterPop(c, btn) {
        const sh = this.sheet(); const f = sh.filter; if (!f) { return; }
        const values = new Set();
        for (let r = f.r0 + 1; r <= Math.max(f.r1, sh.maxR); r += 1) { const g = wb.get(sh.name, r, c); values.add(g.t ? Calc.format(g.v, g.t, this.fmtAt(sh, r, c, g), 'ja') : ''); }
        const list = Array.from(values).sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
        const rect = btn.getBoundingClientRect();
        const chosen = f.cols[c] ? new Set(f.cols[c]) : new Set(list);
        this.filterPop = { open: true, x: Math.min(rect.left, window.innerWidth - 250), y: Math.min(rect.bottom + 2, window.innerHeight - 340), col: c, values: list, checked: chosen };
      },
      filterCheck(v, on) { const s = new Set(this.filterPop.checked); if (on) { s.add(v); } else { s.delete(v); } this.filterPop.checked = s; },
      filterCheckAll(on) { this.filterPop.checked = on ? new Set(this.filterPop.values) : new Set(); },
      applyFilterPop() {
        const sh = this.sheet(); const f = sh.filter; const c = this.filterPop.col;
        if (!f) { this.filterPop.open = false; return; }
        if (this.filterAllChecked) { delete f.cols[c]; } else { f.cols[c] = Array.from(this.filterPop.checked); }
        this.filterPop.open = false;
        this.applyFilterRows();
      },
      /** Rows that fail a column's list are hidden (height 0), as Calc's AutoFilter hides them. */
      applyFilterRows() {
        const sh = this.sheet(); const f = sh.filter; if (!f) { return; }
        const before = new Map(sh.rows); const hiddenWas = f.hidden.slice();
        f.hidden.forEach((r) => sh.rows.delete(r));
        f.hidden = [];
        const last = Math.max(f.r1, sh.maxR); f.r1 = last;
        for (let r = f.r0 + 1; r <= last; r += 1) {
          let show = true;
          Object.keys(f.cols).forEach((cc) => { const c = Number(cc); const g = wb.get(sh.name, r, c); const shown = g.t ? Calc.format(g.v, g.t, this.fmtAt(sh, r, c, g), 'ja') : ''; if (!f.cols[cc].includes(shown)) { show = false; } });
          if (!show) { sh.rows.set(r, 0); f.hidden.push(r); }
        }
        const after = new Map(sh.rows); const hiddenNow = f.hidden.slice(); const colsNow = JSON.parse(JSON.stringify(f.cols));
        this.touch(); this.afterChange();
        this.pushStep({ undo: () => { sh.rows = new Map(before); if (sh.filter) { sh.filter.hidden = hiddenWas; } this.afterChange(); }, redo: () => { sh.rows = new Map(after); if (sh.filter) { sh.filter.hidden = hiddenNow; sh.filter.cols = colsNow; } this.afterChange(); } });
      },
      // ---- find and replace ----
      toggleFind(on) {
        this.find.open = on == null ? !this.find.open : on;
        if (this.find.open) { this.$nextTick(() => { const el = this.$refs.findInput; if (el) { el.focus(); el.select(); } }); } else { this.focusGrid(); }
      },
      runFind() {
        const sh = this.sheet(); const q = this.find.query; this.find.hits = []; this.find.index = 0;
        if (!sh || !q) { return; }
        const cs = this.find.caseSensitive; const needle = cs ? q : q.toLowerCase();
        const m = wb.toModel().sheets.find((s) => s.name === sh.name);
        const keys = Object.keys(m ? m.cells : {}).map((k) => parseRef(k)).filter(Boolean).sort((a, b) => a.r - b.r || a.c - b.c);
        keys.forEach((p) => {
          const g = wb.get(sh.name, p.r, p.c);
          const shown = Calc.format(g.v, g.t, this.fmtAt(sh, p.r, p.c, g), 'ja');
          const hay = this.find.formulas && g.f ? g.f : shown;
          if ((cs ? hay : hay.toLowerCase()).includes(needle)) { this.find.hits.push({ r: p.r, c: p.c }); }
        });
        if (this.find.hits.length) { const cur = this.sel.cur; const i = this.find.hits.findIndex((h) => h.r > cur.r || (h.r === cur.r && h.c >= cur.c)); this.find.index = i < 0 ? 0 : i; this.showHit(); }
      },
      showHit() { const h = this.find.hits[this.find.index]; if (!h) { return; } this.sel.ranges = [{ r0: h.r, c0: h.c, r1: h.r, c1: h.c }]; this.sel.cur = { r: h.r, c: h.c }; this.sel.anchor = { r: h.r, c: h.c }; this.ensureVisible(h.r, h.c); this.syncSel(); this.paint(); },
      findNext(d) { if (!this.find.hits.length) { this.runFind(); if (!this.find.hits.length) { return; } } this.find.index = (this.find.index + d + this.find.hits.length) % this.find.hits.length; this.showHit(); },
      replaceOne() {
        const h = this.find.hits[this.find.index]; if (!h || this.book.readOnly) { return; }
        const sh = this.sheet();
        this.withStep((rec) => { rec(sh, h.r, h.c); this.setInputRaw(sh, h.r, h.c, this.replacedInput(sh, h.r, h.c)); });
        this.runFind();
      },
      replaceAll() {
        if (!this.find.hits.length || this.book.readOnly) { return; }
        const sh = this.sheet(); const hits = this.find.hits.slice();
        this.withStep((rec) => { hits.forEach((h) => { rec(sh, h.r, h.c); this.setInputRaw(sh, h.r, h.c, this.replacedInput(sh, h.r, h.c)); }); });
        this.notify(this.t('Replaced {n} cells.', { n: hits.length }));
        this.runFind();
      },
      replacedInput(sh, r, c) {
        const g = wb.get(sh.name, r, c);
        const input = this.inputOf(g, this.fmtAt(sh, r, c, g));
        const q = this.find.query; const rep = this.find.replace;
        if (this.find.caseSensitive) { return input.split(q).join(rep); }
        return input.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), rep);
      },
      // ---- sheets ----
      switchSheet(i) {
        if (i < 0 || i >= UIS.length) { return; }
        if (this.edit.on && this.edit.text[0] === '=') { this.active = i; this.$nextTick(() => this.layout()); return; }
        if (this.edit.on) { this.commitEdit(); }
        this.active = i;
        if (!this.sheetSel) { this.sheetSel = {}; }
        this.sel = this.sheetSel[UIS[i].name] || { ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], cur: { r: 0, c: 0 }, anchor: { r: 0, c: 0 } };
        this.$nextTick(() => { const vp = this.$refs.scroller; if (vp) { const pos = (this.sheetScroll || {})[UIS[i].name] || { x: 0, y: 0 }; vp.scrollLeft = pos.x; vp.scrollTop = pos.y; } this.syncSel(); this.layout(); this.focusGrid(); });
      },
      rememberSheetState() {
        const sh = this.sheet(); const vp = this.$refs.scroller;
        if (!sh) { return; }
        if (!this.sheetSel) { this.sheetSel = {}; } if (!this.sheetScroll) { this.sheetScroll = {}; }
        this.sheetSel[sh.name] = JSON.parse(JSON.stringify(this.sel));
        if (vp) { this.sheetScroll[sh.name] = { x: vp.scrollLeft, y: vp.scrollTop }; }
      },
      freshSheetName() { let n = UIS.length + 1; let name = 'Sheet' + n; while (UIS.some((u) => u.name === name)) { n += 1; name = 'Sheet' + n; } return name; },
      addSheet(at) {
        if (this.book.readOnly) { return; }
        const name = this.freshSheetName(); const idx = at == null ? UIS.length : at;
        this.structural(() => { wb.addSheet(name, idx); const u = newSheetUI(name); u.grid = this.settings.showGrid !== false; UIS.splice(idx, 0, u); this.active = idx; this.sel = { ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], cur: { r: 0, c: 0 }, anchor: { r: 0, c: 0 } }; });
      },
      deleteSheet(i) {
        if (this.book.readOnly || UIS.length < 2) { return; }
        if (!window.confirm(this.t('Delete the sheet “{name}”? Formulas that point into it will show #REF!.', { name: UIS[i].name }))) { return; }
        this.structural(() => { wb.removeSheet(UIS[i].name); UIS.splice(i, 1); this.active = Math.min(i, UIS.length - 1); this.sel = { ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], cur: { r: 0, c: 0 }, anchor: { r: 0, c: 0 } }; });
      },
      duplicateSheet(i) {
        if (this.book.readOnly) { return; }
        const src = UIS[i]; let name = src.name + ' (2)'; let n = 2; while (UIS.some((u) => u.name === name)) { n += 1; name = src.name + ' (' + n + ')'; }
        this.structural(() => {
          wb.addSheet(name, i + 1);
          const m = wb.toModel().sheets.find((s) => s.name === src.name);
          Object.keys(m ? m.cells : {}).forEach((k) => { const p = parseRef(k); const cell = m.cells[k]; wb.setCell(name, p.r, p.c, { f: cell.f, v: cell.v, t: cell.t, fmt: cell.fmt, s: cell.s }); });
          if (wb.recalc) { wb.recalc(); }
          const u = newSheetUI(name); u.cols = new Map(src.cols); u.rows = new Map(src.rows); u.meta = new Map(Array.from(src.meta.entries()).map(([k, mm]) => [k, Object.assign({}, mm)])); u.merges = src.merges.map((x) => Object.assign({}, x)); u.freeze = src.freeze ? Object.assign({}, src.freeze) : null; u.grid = src.grid; u.maxR = src.maxR; u.maxC = src.maxC;
          UIS.splice(i + 1, 0, u); this.active = i + 1;
        });
      },
      moveSheet(i, d) {
        if (this.book.readOnly) { return; }
        const j = i + d; if (j < 0 || j >= UIS.length) { return; }
        this.structural(() => { const [u] = UIS.splice(i, 1); UIS.splice(j, 0, u); wb.moveSheet(u.name, j); if (this.active === i) { this.active = j; } else if (this.active === j) { this.active = i; } });
      },
      startRenameSheet(i) { if (this.book.readOnly) { return; } this.renameSheet = { idx: i, text: UIS[i].name }; this.$nextTick(() => { const el = this.$refs.renameInput; const inp = Array.isArray(el) ? el[0] : el; if (inp) { inp.focus(); inp.select(); } }); },
      finishRenameSheet() {
        const i = this.renameSheet.idx; if (i < 0) { return; }
        const name = this.renameSheet.text.trim(); this.renameSheet.idx = -1;
        if (!name || name === UIS[i].name) { return; }
        if (UIS.some((u, k) => k !== i && u.name === name) || /[\[\]*?:/\\]/.test(name)) { this.notify(this.t('A sheet cannot be called that.')); return; }
        this.structural(() => { const old = UIS[i].name; wb.renameSheet(old, name); UIS[i].name = name; if (this.sheetSel && this.sheetSel[old]) { this.sheetSel[name] = this.sheetSel[old]; } });
      },
      // ---- the cell properties dialog ----
      openCellProps(tab) {
        if (this.book.readOnly) { return; }
        this.menu = '';
        const sh = this.sheet(); const meta = sh.meta.get(K(this.sel.cur.r, this.sel.cur.c)) || {}; const s = meta.s || {};
        this.cellProps = { fmt: fmtOf(meta, wb.get(sh.name, this.sel.cur.r, this.sel.cur.c)), ha: s.ha || '', va: s.va || '', wrap: !!s.wrap, font: s.font || '', size: s.size || '', b: !!s.b, i: !!s.i, u: !!s.u, strike: !!s.strike, color: s.color || '', bg: s.bg || '' };
        this.numFromCode(this.cellProps.fmt);
        this.bord = { style: 'solid', width: 1, colour: '#000000', edges: { top: 'keep', bottom: 'keep', left: 'keep', right: 'keep', insideH: 'keep', insideV: 'keep' } };
        this.cellTab = tab || 'number';
        this.cellPropsOpen = true;
      },
      numFromCode(code) {
        const u = this.numUi;
        if (!code || code === 'General') { u.cat = 'general'; return; }
        if (code === '@') { u.cat = 'text'; return; }
        if (/E\+/.test(code)) { u.cat = 'sci'; u.dec = (code.split('.')[1] || '').replace(/[^0]/g, '').length; return; }
        if (/%/.test(code)) { u.cat = 'percent'; u.dec = (code.split('.')[1] || '').replace(/[^0]/g, '').length; return; }
        if (/^[¥$€£]/.test(code)) { u.cat = 'currency'; u.cur = code[0]; u.dec = (code.split(';')[0].split('.')[1] || '').replace(/[^0]/g, '').length; u.red = /\[Red\]/i.test(code); return; }
        if (isTimeFmt(code) && !isDateFmt(code.replace(/h.*$/, ''))) { u.cat = 'time'; u.time = code; return; }
        if (isDateFmt(code)) { u.cat = 'date'; u.date = code; return; }
        if (/^[#,0]+(\.0+)?/.test(code)) { u.cat = 'number'; u.sep = code.includes(','); u.dec = (code.split(';')[0].split('.')[1] || '').replace(/[^0]/g, '').length; u.red = /\[Red\]/i.test(code); return; }
        u.cat = 'custom';
      },
      numBuild() {
        const u = this.numUi; const dec = u.dec ? '.' + '0'.repeat(clamp(u.dec, 0, 10)) : '';
        let code = 'General';
        if (u.cat === 'number') { code = (u.sep ? '#,##0' : '0') + dec; if (u.red) { code = code + ';[Red]-' + code; } }
        else if (u.cat === 'currency') { code = u.cur + '#,##0' + dec; if (u.red) { code = code + ';[Red]-' + code; } }
        else if (u.cat === 'percent') { code = '0' + dec + '%'; }
        else if (u.cat === 'sci') { code = '0' + (dec || '.00') + 'E+00'; }
        else if (u.cat === 'date') { code = u.date; } else if (u.cat === 'time') { code = u.time; } else if (u.cat === 'text') { code = '@'; }
        else if (u.cat === 'custom') { return; }
        this.cellProps.fmt = code === 'General' ? '' : code;
      },
      numSampleOf(code) {
        const g = wb ? wb.get(this.sheetName(), this.sel.cur.r, this.sel.cur.c) : { t: '' };
        const v = g.t === 'n' ? g.v : (isDateFmt(code) || isTimeFmt(code) ? Calc.parseInput('2026/10/5 9:30', 'ja').v : 1234.5);
        return Calc.format(v, 'n', code === 'General' ? '' : (code || ''), 'ja');
      },
      bordPreset(kind) { const e = this.bord.edges; const v = kind === 'none' ? 'none' : 'set'; ['top', 'bottom', 'left', 'right'].forEach((k) => { e[k] = kind === 'inside' ? e[k] : v; }); ['insideH', 'insideV'].forEach((k) => { e[k] = kind === 'outline' ? e[k] : v; }); },
      bordToggle(e) { const now = this.bord.edges[e]; this.bord.edges[e] = now === 'keep' ? 'set' : now === 'set' ? 'none' : 'keep'; },
      edgeLabel(e) { return { top: this.t('Top'), bottom: this.t('Bottom'), left: this.t('Left'), right: this.t('Right'), insideH: this.t('Inside, horizontal'), insideV: this.t('Inside, vertical') }[e]; },
      applyCellProps() {
        const p = this.cellProps; const g = this.selRange(); const b = this.bord;
        const line = b.style === 'none' ? '' : (b.style === 'double' ? Math.max(3, b.width) : b.width) + 'px ' + b.style + ' ' + b.colour;
        this.withStep((rec) => {
          this.eachSelCell((sh, r, c) => {
            rec(sh, r, c);
            const meta = sh.meta.get(K(r, c)) || {}; const s = Object.assign({}, meta.s || {});
            const put = (k, v) => { if (v === '' || v === false || v == null) { delete s[k]; } else { s[k] = v; } };
            put('ha', p.ha); put('va', p.va); put('wrap', p.wrap ? 1 : ''); put('font', p.font); put('size', p.size ? Number(p.size) : ''); put('b', p.b ? 1 : ''); put('i', p.i ? 1 : ''); put('u', p.u ? 1 : ''); put('strike', p.strike ? 1 : ''); put('color', p.color); put('bg', p.bg);
            const top = r === g.r0; const bottom = r === g.r1; const left = c === g.c0; const right = c === g.c1;
            const edge = (key, which) => { const st = b.edges[which]; if (st === 'keep') { return; } if (st === 'none') { delete s[key]; } else if (line) { s[key] = line; } };
            if (top) { edge('bt', 'top'); } else { edge('bt', 'insideH'); }
            if (bottom) { edge('bb', 'bottom'); } else { edge('bb', 'insideH'); }
            if (left) { edge('bl', 'left'); } else { edge('bl', 'insideV'); }
            if (right) { edge('br', 'right'); } else { edge('br', 'insideV'); }
            this.setMeta(sh, r, c, { fmt: p.fmt || (wb.get(sh.name, r, c).fmt || wb.get(sh.name, r, c).fmtHint ? 'General' : ''), s });
          }, 20000);
        });
        this.cellPropsOpen = false;
        this.focusGrid();
      },
      // ---- the functions dialog ----
      openFx() { if (this.book.readOnly) { return; } this.menu = ''; this.fxQuery = ''; this.fxSel = ''; this.fxGroup = ''; this.fxOpen = true; this.$nextTick(() => { const el = this.$refs.fxSearch; if (el) { el.focus(); } }); },
      fxInsert() {
        const f = this.fxCurrent; if (!f) { return; }
        this.fxOpen = false;
        if (!this.edit.on) { this.startEdit('full', '=' + f.name + '('); this.$nextTick(() => { const ed = this.$refs.editor; if (ed) { ed.setSelectionRange(this.edit.text.length, this.edit.text.length); } this.edit.caret = this.edit.text.length; this.updateHints(); }); return; }
        const t = this.edit.text; const c = this.edit.caret;
        const ins = (t[0] === '=' ? '' : '=') + f.name + '(';
        this.setEditText(t.slice(0, c) + ins + t.slice(c), c + ins.length);
      },
      // ---- printing ----
      openPrint() { this.menu = ''; this.printOpen = true; },
      doPrint() {
        const p = this.print; const paper = PAPERS[p.paper] || PAPERS.A4;
        const sheets = p.range === 'book' ? UIS : [this.sheet()];
        const parts = [];
        this.refreshUsed();
        sheets.forEach((sh) => {
          let g = { r0: 0, c0: 0, r1: sh.maxR, c1: sh.maxC };
          if (p.range === 'selection' && sh === this.sheet()) { const s = this.selRange(); g = { r0: s.r0, c0: s.c0, r1: Math.min(s.r1, Math.max(sh.maxR, s.r0)), c1: Math.min(s.c1, Math.max(sh.maxC, s.c0)) }; }
          const covered = new Set(); sh.merges.forEach((m) => { for (let r = m.r0; r <= m.r1; r += 1) { for (let c = m.c0; c <= m.c1; c += 1) { if (r !== m.r0 || c !== m.c0) { covered.add(K(r, c)); } } } });
          const rows = [];
          const colsHtml = []; if (p.headings) { colsHtml.push('<col style="width:34px">'); } for (let c = g.c0; c <= g.c1; c += 1) { colsHtml.push('<col style="width:' + colW(sh, c) + 'px">'); }
          const totalW = (p.headings ? 34 : 0) + Array.from({ length: g.c1 - g.c0 + 1 }, (_, i) => colW(sh, g.c0 + i)).reduce((a, b) => a + b, 0);
          const rowHtml = (r) => {
            const h = rowH(sh, r); if (h === 0) { return ''; }
            const tds = []; if (p.headings) { tds.push('<th class="rh">' + (r + 1) + '</th>'); }
            for (let c = g.c0; c <= g.c1; c += 1) {
              if (covered.has(K(r, c))) { continue; }
              const gg = wb.get(sh.name, r, c); const meta = sh.meta.get(K(r, c)); const m = mergeAt(sh, r, c);
              const a = []; if (m && m.r0 === r && m.c0 === c) { if (m.c1 > m.c0) { a.push(' colspan="' + (m.c1 - m.c0 + 1) + '"'); } if (m.r1 > m.r0) { a.push(' rowspan="' + (m.r1 - m.r0 + 1) + '"'); } }
              if (gg.t === 'n' || gg.t === 'b') { a.push(' class="n"'); }
              const css = meta ? styleToCss(meta.s) : ''; if (css) { a.push(' style="' + esc(css) + '"'); }
              tds.push('<td' + a.join('') + '>' + esc(gg.t ? Calc.format(gg.v, gg.t, fmtOf(meta, gg), 'ja') : '') + '</td>');
            }
            return '<tr style="height:' + h + 'px">' + tds.join('') + '</tr>';
          };
          let head = '';
          if (p.headings) { const ths = ['<th class="rh"></th>']; for (let c = g.c0; c <= g.c1; c += 1) { ths.push('<th>' + colName(c) + '</th>'); } head = '<tr class="ch">' + ths.join('') + '</tr>'; }
          let first = g.r0;
          if (p.header && g.r1 > g.r0) { head += rowHtml(g.r0); first = g.r0 + 1; }
          for (let r = first; r <= g.r1; r += 1) { rows.push(rowHtml(r)); }
          parts.push('<section class="cb-sheet"><table style="' + (p.fit ? 'width:100%' : 'width:' + totalW + 'px') + '"><colgroup>' + colsHtml.join('') + '</colgroup>' + (head ? '<thead>' + head + '</thead>' : '') + '<tbody>' + rows.join('') + '</tbody></table></section>');
        });
        const size = (p.orientation === 'landscape' ? paper.h + 'mm ' + paper.w + 'mm' : paper.w + 'mm ' + paper.h + 'mm');
        const css = '@page{size:' + size + ';margin:' + p.margins.t + 'mm ' + p.margins.r + 'mm ' + p.margins.b + 'mm ' + p.margins.l + 'mm}' +
          'body{margin:0;font-family:"' + (this.settings.font || 'Noto Sans JP') + '","Noto Sans JP",sans-serif;font-size:' + (this.settings.fontSize || 11) + 'pt;color:#111}' +
          '.cb-sheet{page-break-after:always;break-after:page}.cb-sheet:last-child{page-break-after:auto;break-after:auto}' +
          'table{border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}' +
          'td,th{padding:0 4px;overflow:hidden;white-space:nowrap;vertical-align:bottom;line-height:1.25;' + (p.grid ? 'border:1px solid #999;' : 'border:1px solid transparent;') + '}' +
          'td.n{text-align:right}th{background:#eee;font-weight:400;color:#555;font-size:9pt;text-align:center}th.rh{width:34px}tr{page-break-inside:avoid;break-inside:avoid}';
        const html = '<!DOCTYPE html><html lang="' + esc(uiLang()) + '"><head><meta charset="utf-8"><title>' + esc(this.book.name) + '</title><style>' + css + '</style></head><body>' + parts.join('') + '</body></html>';
        this.printOpen = false;
        this.lastPrintHtml = html;
        printHtml(html);
      },
      // ---- the context menu ----
      onContextMenu(e) {
        // The browser's menu never appears inside the app; the app's own stands in for it.
        e.preventDefault();
        const tgt = e.target;
        if (tgt && tgt.closest && tgt.closest('.cb-ctxmenu, .cb-ctx-back')) { return; }
        if (tgt && tgt.closest && (tgt.closest('.cb-bookitem') || tgt.closest('.cb-sheets .tab'))) { return; }   // their own handlers
        if (tgt && tgt.closest && tgt.closest('.cb-modal-back')) { if (tgt.matches('input, textarea')) { this._fieldTarget = tgt; this.ctx.kind = 'field'; this.placeCtx(e.clientX, e.clientY); } return; }
        if (tgt && tgt.matches && tgt.matches('input, textarea') && !tgt.classList.contains('cb-editor')) { this._fieldTarget = tgt; this.ctx.kind = 'field'; this.placeCtx(e.clientX, e.clientY); return; }
        if (tgt && tgt.classList && tgt.classList.contains('cb-editor') && this.edit.on) { this._fieldTarget = tgt; this.ctx.kind = 'field'; this.placeCtx(e.clientX, e.clientY); return; }
        if (!this.book.id) { return; }
        const inGrid = tgt && tgt.closest && tgt.closest('.cb-gridwrap');
        if (!inGrid) { return; }
        const hit = this.hitTest(e.clientX, e.clientY);
        if (hit.kind === 'colhead') { if (!this.selColumnsSet().has(hit.c)) { this.selectCols(hit.c, hit.c); } this.ctx.kind = 'col'; this.ctx.col = hit.c; this.placeCtx(e.clientX, e.clientY); return; }
        if (hit.kind === 'rowhead') { if (!this.selRowsSet().has(hit.r)) { this.selectRows(hit.r, hit.r); } this.ctx.kind = 'row'; this.ctx.row = hit.r; this.placeCtx(e.clientX, e.clientY); return; }
        if (hit.kind === 'cell') { if (this.edit.on) { this.commitEdit(); } if (!this.sel.ranges.some((g) => inRange(g, hit.r, hit.c))) { this.setCur(hit.r, hit.c); } this.openCellCtx(e.clientX, e.clientY); }
      },
      openCellCtx(x, y) { this.ctx.kind = 'cell'; this.placeCtx(x, y); },
      bookCtx(e, b) { this.ctx.kind = 'book'; this.ctx.book = b; this.placeCtx(e.clientX, e.clientY); },
      sheetCtx(e, i) { this.ctx.kind = 'sheet'; this.ctx.sheet = i; this.placeCtx(e.clientX, e.clientY); },
      placeCtx(x, y) {
        this.ctx.open = true; this.ctx.x = x; this.ctx.y = y; this.ctx.flip = false; this.ctx.tall = 0;
        this.$nextTick(() => {
          const el = this.$el.querySelector('.cb-ctxmenu'); if (!el) { return; }
          const r = el.getBoundingClientRect();
          if (r.right > window.innerWidth - 6) { this.ctx.x = Math.max(6, window.innerWidth - r.width - 6); this.ctx.flip = true; }
          if (r.height > window.innerHeight - 16) { this.ctx.tall = window.innerHeight - 16; this.ctx.y = 8; }
          else if (r.bottom > window.innerHeight - 6) { this.ctx.y = Math.max(6, window.innerHeight - r.height - 6); }
        });
      },
      closeCtx() { this.ctx.open = false; },
      closeCtxIfSettled() { const now = window.performance ? window.performance.now() : 0; if (now - ctxAt < 400) { return; } this.closeCtx(); },
      toggleFly(e) {
        if (e.target.closest && e.target.closest('.fly')) { return; }
        const row = e.currentTarget; const was = row.classList.contains('open');
        const menu = row.closest('.cb-ctxmenu');
        if (menu) { Array.from(menu.querySelectorAll('.has-sub.open')).forEach((n) => n.classList.remove('open')); }
        if (!was) { row.classList.add('open'); }
      },
      placeFly(e) {
        const fly = e.currentTarget.querySelector('.fly'); if (!fly) { return; }
        if (window.innerWidth <= 560) { fly.style.top = ''; fly.style.bottom = ''; return; }
        fly.style.top = '-6px'; fly.style.bottom = 'auto';
        const measure = () => { const r = fly.getBoundingClientRect(); if (!r.height) { return; } if (r.bottom > window.innerHeight - 8) { fly.style.top = 'auto'; fly.style.bottom = '-6px'; } };
        measure(); window.requestAnimationFrame(measure);
      },
      toggleMenu(k) { this.menu = this.menu === k ? '' : k; },

      measureWidth() {
        const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        this.coarse = coarse;
        const narrow = window.innerWidth <= 860 || (coarse && window.innerWidth <= 1100);
        const became = narrow && !this.narrow;
        this.narrow = narrow;
        if (became) { this.sideOpen = false; }
        if (!narrow && !this.sideOpen && window.innerWidth > 1100) { this.sideOpen = true; }
        this.$nextTick(() => this.layout());
      },
      async boot() {
        const root = document.getElementById('calcbase-root');
        this.version = (root && root.dataset.version) || '';
        try {
          const local = JSON.parse(window.localStorage.getItem('cb-local') || '{}');
          if (local.showGrid != null) { this.settings.showGrid = !!local.showGrid; }
          if (local.font) { this.settings.font = local.font; }
          if (local.fontSize) { this.settings.fontSize = Number(local.fontSize) || 11; }
          if (local.autosave != null) { this.settings.autosave = !!local.autosave; }
        } catch (e) { /* nothing remembered */ }
        try {
          const s = await api('settings');
          this.settings.folder = s.folder || 'CalcBase';
          this.settings.theme = s.theme || 'auto';
          this.settings.language = s.language || 'auto';
          this.settings.languages = s.languages || [];
          this.settings.versionKeep = s.versionKeep == null ? 10 : Number(s.versionKeep);
          this.settings.versionWhen = s.versionWhen || 'manual';
          this.settings.enterMoves = s.enterMoves === 'right' ? 'right' : 'down';
          if (s.autosave != null) { this.settings.autosave = s.autosave === '1' || s.autosave === true; }
          if (s.gridDefault != null) { this.settings.showGrid = s.gridDefault === '1' || s.gridDefault === true; }
          if (s.font) { this.settings.font = s.font; }
          if (s.fontSize) { this.settings.fontSize = Number(s.fontSize) || 11; }
          const m = /^(\d+(?:\.\d+)?)(px|%)$/.exec(String(s.aiWidth || ''));
          if (m) { this.settings.aiW = Number(m[1]); this.settings.aiU = m[2]; this._aiWidthFromSettings = true; }
        } catch (e) { /* the app still works with the defaults */ }
        this.applyTheme(this.settings.theme);
        if (this.settings.language && this.settings.language !== 'auto') { await this.applyLanguage(this.settings.language); }
        const z = Number(window.localStorage.getItem('cb-zoom') || 0);
        if (z >= 50 && z <= 200) { this.zoom = z; }
        if (window.localStorage.getItem('cb-ai-open') === '1') { this.ai.open = true; }
        await this.loadBooks();
        this.aiLoad();
        const wanted = Number((root && root.dataset.fileid) || 0);
        const last = Number(window.localStorage.getItem('cb-last-book') || 0);
        const usable = (id) => this.books.some((b) => b.id === id);
        const target = wanted || (usable(last) ? last : (this.books[0] && this.books[0].id));
        if (target) { await this.openBook(target); }
      },
    },
    watch: {
      active() { this.rememberSheetState(); },
      'settings.autosave'() { this.scheduleAutosave(); },
    },
    created() {
      // Not in data(): Vue must not wrap the selection and the undo stack, which change on every keystroke.
      this.sel = { ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], cur: { r: 0, c: 0 }, anchor: { r: 0, c: 0 } };
      this.history = []; this.redoStack = [];
      this.tabStart = null; this.fillPrev = null; this.movePrev = null; this.dragSel = null;
    },
    mounted() {
      this.measureWidth();
      window.addEventListener('resize', () => this.measureWidth());
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this.layout());
        const watchWrap = () => { const w = this.$refs.gridwrap; if (w && this._roTarget !== w) { if (this._roTarget) { this._ro.unobserve(this._roTarget); } this._ro.observe(w); this._roTarget = w; } };
        watchWrap(); this.$watch('book.id', () => this.$nextTick(watchWrap));
      }
      document.addEventListener('click', (e) => { if (this.menu && !e.target.closest('.cb-pop')) { this.menu = ''; } });
      // Escape closes whatever is on top: a popup menu, then a dialogue.
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') { return; }
        if (this.ctx.open) { this.closeCtx(); e.preventDefault(); return; }
        if (this.filterPop.open) { this.filterPop.open = false; e.preventDefault(); return; }
        if (this.menu) { this.menu = ''; e.preventDefault(); return; }
        if (this.ask.open) { this.askAnswer(null); e.preventDefault(); return; }
        if (this.picker.open) { this.pickerAnswer(null); e.preventDefault(); return; }
        if (this.vers.open) { this.vers.open = false; e.preventDefault(); return; }
        const modals = ['cellPropsOpen', 'fxOpen', 'printOpen', 'htmlOpen', 'exportOpen', 'settingsOpen'];
        for (const key of modals) { if (this[key]) { if (key === 'settingsOpen') { this.cancelSettings(); } else { this[key] = false; } e.preventDefault(); return; } }
        if (this.narrow && this.sideOpen) { this.sideOpen = false; e.preventDefault(); }
      });
      // Unsaved work is not lost to a closed tab without a word.
      window.addEventListener('beforeunload', (e) => { if (this.dirty && this.book.id && !this.book.readOnly) { e.preventDefault(); e.returnValue = ''; } });
      // The tooltip of a button, drawn by the app under the button and clear of the pointer (as EditBase).
      const tipRoot = this.$el;
      let hoverEl = null; let hoverTimer = 0; let hoverY = 0;
      const hoverBox = () => { let box = document.getElementById('cb-hovertip'); if (!box) { box = document.createElement('div'); box.id = 'cb-hovertip'; box.setAttribute('role', 'tooltip'); document.body.appendChild(box); } return box; };
      const hoverHide = () => { window.clearTimeout(hoverTimer); const box = document.getElementById('cb-hovertip'); if (box) { box.classList.remove('on'); } };
      const hoverShow = (el) => {
        const text = el.dataset.cbTip || ''; if (!text || !el.isConnected) { return; }
        const box = hoverBox(); box.textContent = text; box.classList.add('on');
        const r = el.getBoundingClientRect(); const w = box.offsetWidth; const h = box.offsetHeight;
        let top = Math.max(r.bottom + 6, hoverY + 26);
        if (top + h > window.innerHeight - 4) { top = Math.max(4, r.top - h - 6); }
        const left = Math.min(Math.max(4, r.left + r.width / 2 - w / 2), window.innerWidth - w - 4);
        box.style.top = top + 'px'; box.style.left = left + 'px';
      };
      tipRoot.addEventListener('mouseover', (e) => {
        hoverY = e.clientY;
        const el = e.target && e.target.closest ? e.target.closest('[title], [data-cb-tip]') : null;
        if (!el || !tipRoot.contains(el) || el.closest('.cb-layers, #cb-hovertip')) { return; }
        const title = el.getAttribute('title');
        if (title) { if (el.dataset.cbTipOrig === undefined) { el.dataset.cbTipOrig = title; } el.dataset.cbTip = title; el.removeAttribute('title'); }
        if (hoverEl === el) { return; }
        hoverHide(); hoverEl = el;
        hoverTimer = window.setTimeout(() => hoverShow(el), 450);
      });
      tipRoot.addEventListener('mousemove', (e) => { hoverY = e.clientY; }, { passive: true });
      tipRoot.addEventListener('mouseout', (e) => {
        const el = e.target && e.target.closest ? e.target.closest('[data-cb-tip]') : null;
        if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) { return; }
        hoverHide(); if (hoverEl === el) { hoverEl = null; }
        const orig = el.dataset.cbTipOrig; if (orig) { el.setAttribute('title', orig); } else { el.removeAttribute('title'); }
        delete el.dataset.cbTip; delete el.dataset.cbTipOrig;
      });
      ['mousedown', 'keydown', 'wheel'].forEach((ev) => tipRoot.addEventListener(ev, hoverHide, { passive: true }));
      // for the harness and the browser console: the page's own state
      window.__cbvm = this;
      this.boot();
    },
  });
  window.__cbtest = { parseBook, buildHtml, refsInFormula, cycleAbs, refSlot, parseTsv, tableFromHtml, uis: () => UIS, wb: () => wb };

  /** The assistant's answer in CalcBase's shape: {"reply": string, "edits": [{sheet?, cell, input}]}, as JSON, in a ```json block, or as prose. */
  function aiAnswer(answer) {
    const out = { reply: '', edits: null, bad: false };
    let obj = null;
    if (answer && typeof answer === 'object') { obj = answer; }
    else {
      const text = String(answer == null ? '' : answer);
      const tryParse = (s) => { try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch (e) { return null; } };
      obj = tryParse(text.trim());
      if (!obj) { const m = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text); if (m) { obj = tryParse(m[1]); if (!obj) { out.bad = true; } out.reply = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(); } }
      if (!obj && !out.bad) { const i = text.indexOf('{'); const j = text.lastIndexOf('}'); if (i >= 0 && j > i) { obj = tryParse(text.slice(i, j + 1)); if (obj) { out.reply = (text.slice(0, i) + text.slice(j + 1)).trim(); } } }
      if (!obj) { out.reply = out.reply || text; return out; }
    }
    if (typeof obj.reply === 'string') { out.reply = out.reply ? out.reply + '\n' + obj.reply : obj.reply; }
    if (Array.isArray(obj.edits)) { out.edits = obj.edits.filter((e) => e && typeof e === 'object' && typeof e.cell === 'string'); }
    if (!out.reply && !out.edits) { out.reply = JSON.stringify(obj); }
    return out;
  }

  app.config.errorHandler = (err) => { console.error('CalcBase:', err); };
  const rootEl = document.getElementById('calcbase-root');
  if (rootEl) { rootEl.innerHTML = ''; app.mount(rootEl); }
  window.__cb = { app };
})();
