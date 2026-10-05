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
