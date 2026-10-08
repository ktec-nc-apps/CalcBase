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

  /** How deep formulas work out the cells they read on the spot before queueing them (the JavaScript stack). */
  const NEST = 96;
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

  /** The shortest digits of a > 0 that read back as a (what Calc's dragonbox gives), and the exponent of the first. */
  function shortest(a) { const p = a.toExponential().split('e'); return { digits: p[0].replace('.', ''), exp: Number(p[1]) }; }
  /**
   * Those digits rounded half up to n significant digits, once, as Calc's
   * rtl::math::doubleToString does (roundToPow10) — so 0.4795001221869535
   * shows 0.479500122186954 as in Calc, not 0.479500122186953.
   */
  function roundSig(a, n) {
    let { digits, exp } = shortest(a);
    if (digits.length <= n) { return { digits, exp }; }
    if (n <= 0) { return n === 0 && digits.charCodeAt(0) >= 53 ? { digits: '1', exp: exp + 1 } : { digits: '0', exp, zero: true }; }
    const up = digits.charCodeAt(n) >= 53;
    digits = digits.slice(0, n);
    if (up) {
      const arr = digits.split('');
      let i = arr.length - 1;
      while (i >= 0) { if (arr[i] === '9') { arr[i] = '0'; i--; } else { arr[i] = String.fromCharCode(arr[i].charCodeAt(0) + 1); break; } }
      if (i < 0) { arr.unshift('1'); arr.pop(); exp++; }
      digits = arr.join('');
    }
    return { digits, exp };
  }
  /** Digits d.ddd × 10^exp written without an exponent. */
  function placeDigits(digits, exp) {
    if (exp >= 0) { const s2 = digits.padEnd(exp + 1, '0'); return { intPart: s2.slice(0, exp + 1), frac: s2.slice(exp + 1) }; }
    return { intPart: '0', frac: '0'.repeat(-exp - 1) + digits };
  }
  /** a ≥ 0 with exactly d decimals, rounded half away from zero on its decimal digits, at most 15 significant (as Calc writes F format). */
  function fixedStr(a, d) {
    if (a === 0 || !isFinite(a)) { return d > 0 ? '0.' + '0'.repeat(d) : '0'; }
    const n = Math.min(d + shortest(a).exp + 1, 15);
    if (n < 0) { return d > 0 ? '0.' + '0'.repeat(d) : '0'; }
    const r = roundSig(a, n);
    if (r.zero) { return d > 0 ? '0.' + '0'.repeat(d) : '0'; }
    const p = placeDigits(r.digits, r.exp);
    const frac = p.frac.padEnd(d, '0').slice(0, Math.max(d, 0));
    const intPart = p.intPart.replace(/^0+(?=\d)/, '');
    return d > 0 ? intPart + '.' + frac : intPart;
  }
  /** ROUND as Calc: half away from zero, judged on the decimal digits (1.005 → 1.01). */
  function roundHalfAway(x, d) {
    if (!isFinite(x)) { return x; }
    const sign = x < 0 ? -1 : 1;
    const a = Math.abs(x);
    if (d >= 0) { return sign * Number(fixedStr(a, Math.min(d, 20))); }
    const f = xpow(10, -d);
    return sign * Number(fixedStr(a / f, 0)) * f;
  }
  const stripZeros = (s) => (s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  function expStr(a, decimals, minExpDigits) {
    const r = roundSig(a, decimals + 1);
    const mant = stripZeros(r.digits[0] + '.' + r.digits.slice(1).padEnd(decimals, '0'));
    const e = r.exp;
    return mant + 'E' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(minExpDigits, '0');
  }
  /** a > 0 with 15 significant digits and no exponent, trailing zeros dropped. */
  function fixed15(a) { const r = roundSig(a, 15); const p = placeDigits(r.digits, r.exp); return stripZeros(p.intPart.replace(/^0+(?=\d)/, '') + '.' + p.frac); }
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
      if (a > 1e15) { return sign + expStr(a, 14, 3); }
      return sign + fixed15(a);
    }
    const e = roundSig(a, 15).exp;
    let fix = a > 1e-4;
    if (!fix) {
      const nExp = Math.ceil(-xlog10(a));
      if (nExp <= 9 && approxEqual(Number(a.toFixed(16)), a)) { fix = true; }
    }
    if (fix) { return sign + fixed15(a); }
    return sign + expStr(a, 14, 2);
  }

  /**
   * General with the document's "limit decimals for general number format" (Tools ▸ Options ▸ Calc ▸
   * Calculate; an ODS file's default cell style says style:decimal-places), as Calc 24.2 shows it
   * (measured with 2: 12.0775862068966 → 12.08, 9.60246744345442 → 9.6, 0.995 → 1, -0.004 → 0,
   * 1E-10 → 0, 123456789012345678 → 1.23E+17, 1E+20 → 1.00E+20).
   */
  function generalDec(v, dec) {
    if (v === 0 || !isFinite(v)) { return general(v); }
    const sign = v < 0 ? '-' : '';
    const a = Math.abs(v);
    if (a >= 1 && /E/.test(general(a))) {
      let e = Math.floor(xlog10(a)); let m = roundHalfAway(a / xpow(10, e), dec);
      if (m >= 10) { m = roundHalfAway(m / 10, dec); e += 1; }
      return sign + fixedStr(m, dec) + 'E+' + String(e).padStart(2, '0');
    }
    const r = roundHalfAway(v, dec);
    return r === 0 ? '0' : general(r);
  }
  /** The decimals General is limited to in the book being shown (null: as many as the column allows). */
  let STD_DEC = null;

  // ---- reading what is typed ----------------------------------------------

  // full-width digits and the full-width comma and point read as numbers in ja (Calc); －, ％, ： and ／ do not
  const normalizeWidth = (s) => s.replace(/[０-９．，]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  const NUM_RE = /^([-+]?)(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/;
  function readNumber(s) {
    const m = NUM_RE.exec(s);
    if (!m || (m[2] == null && !m[3])) { return null; }
    const n = Number((m[1] || '') + (m[2] || '0').replace(/,/g, '') + '.' + (m[3] || '0') + (m[4] != null ? 'e' + m[4] : ''));
    if (isNaN(n)) { return null; }
    return { v: isFinite(n) ? n : (n < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE), sci: m[4] != null, dec: m[3] ? m[3].length : 0, signed: !!m[1] };
  }
  function readTime(s, L) {
    const ja = L.id === 'ja';
    let m = (ja ? /^(\d+):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?()$/ : /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?(?:\s*([AaPp])\.?[Mm]?\.?)?$/).exec(s);
    if (!m && !ja) { const h = /^(\d{1,2})\s*([AaPp])\.?[Mm]\.?$/.exec(s); if (h) { m = [s, h[1], '0', undefined, undefined, h[2]]; } }
    if (!m) { return null; }
    let h = Number(m[1]); const mi = Number(m[2]); const se = m[3] != null ? Number(m[3]) : 0;
    if (mi > 59 || se > 59) { return null; }
    const ap = m[5] ? m[5].toLowerCase() : '';
    if (ap) { if (h > 12 || h === 0) { return null; } if (ap === 'a' && h === 12) { h = 0; } else if (ap === 'p' && h < 12) { h += 12; } }
    const frac = m[4] ? Number('0.' + m[4]) : 0;
    const v = (h * 3600 + mi * 60 + se + frac) / 86400;
    let fmt;
    if (ja) {
      // Calc ja-JP: HH:MM:SS, [HH]:MM:SS past a day, [HH]:MM:SS.00 with fractions of a second
      fmt = m[4] ? '[hh]:mm:ss.00' : h >= 24 ? '[hh]:mm:ss' : 'hh:mm:ss';
    } else {
      const fracFmt = m[4] ? '.' + '0'.repeat(Math.min(m[4].length, 2)) : '';
      if (h >= 24) { fmt = '[hh]:mm:ss' + fracFmt; } else if (ap || !fracFmt) { fmt = 'hh:mm:ss' + fracFmt + ' AM/PM'; } else { fmt = 'hh:mm:ss' + fracFmt; }
    }
    return { v, fmt, hasSec: m[3] != null, ap: !!ap };
  }
  const MONTH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i;
  /** Calc ja-JP shows a typed date as M月D日 (an ISO Y-M-D stays ISO). */
  const JA_DATE = 'm"月"d"日"';
  function readDate(s, L) {
    let m;
    const today = serialToYmd(Math.floor((Date.now() - DAY0) / MS_DAY));
    const mk = (y, mo, d, fmt, iso) => (validDate(y, mo, d) ? { v: ymdToSerial(y, mo, d), fmt, iso: !!iso } : null);
    if (L.id === 'ja') {
      if ((m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(s))) { return mk(fullYear(Number(m[1])), Number(m[2]), Number(m[3]), 'yyyy-mm-dd', true); }
      if ((m = /^(\d{1,4})([/.])(\d{1,2})\2(\d{1,2})$/.exec(s))) { return mk(fullYear(Number(m[1])), Number(m[3]), Number(m[4]), JA_DATE); }
      if ((m = /^(\d{1,4})年(\d{1,2})月(\d{1,2})日$/.exec(s))) { return mk(fullYear(Number(m[1])), Number(m[2]), Number(m[3]), JA_DATE); }
      if ((m = /^(\d{1,2})月(\d{1,2})日$/.exec(s))) { return mk(today.y, Number(m[1]), Number(m[2]), JA_DATE); }
      if ((m = /^(\d{1,2})[/-](\d{1,2})$/.exec(s))) { return mk(today.y, Number(m[1]), Number(m[2]), JA_DATE); }
      return null;
    }
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) { return mk(Number(m[1]), Number(m[2]), Number(m[3]), 'yyyy-mm-dd', true); }
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
  /** Calc ja-JP's format for a number typed with ￥ (full width): the yen without decimals, negatives red. */
  const JA_YEN = '[$￥-411]#,##0;[RED]-[$￥-411]#,##0';
  /**
   * What typed text means, as Calc reads it (ja-JP measured: lo-input.json):
   * a number (1,234.5 · 12% · ￥1,200 · 1e3 · (5) · 5- · 1 1/2), a date or
   * time in the locale's patterns, TRUE/FALSE, a formula (=…), text (a
   * leading apostrophe forces text), or nothing. The answer carries the
   * number format Calc would give the cell (fmt), when there is one.
   */
  function parseInput(text, locale) {
    const L = locOf(locale);
    const raw = String(text == null ? '' : text);
    if (raw === '') { return { v: null, t: '' }; }
    if (raw.charAt(0) === "'") { return { v: raw.slice(1), t: 's' }; }
    if (raw.charAt(0) === '=' && raw.length > 1) { return { v: raw, t: 'f', f: raw }; }
    let s = raw.replace(/[　\s]+/g, ' ').trim();
    if (L.fullWidth) { s = normalizeWidth(s); }
    s = s.replace(/−/g, '-');
    if (s === '') { return { v: raw, t: 's' }; }
    const up = s.toUpperCase();
    if (up === 'TRUE') { return { v: true, t: 'b' }; }
    if (up === 'FALSE') { return { v: false, t: 'b' }; }
    let m;
    let n = readNumber(s);
    if (n) { return n.sci ? { v: n.v, t: 'n', fmt: '0.00E+00' } : { v: n.v, t: 'n' }; }
    if ((m = /^\((.+)\)$/.exec(s)) && (n = readNumber(m[1])) && n.v >= 0 && !n.signed) { return { v: -n.v, t: 'n' }; }
    if ((m = /^(.+)-$/.exec(s)) && (n = readNumber(m[1])) && n.v >= 0 && !n.signed) { return { v: -n.v, t: 'n' }; }
    if ((m = /^(.+?) ?%$/.exec(s)) && (n = readNumber(m[1]))) { return { v: n.v / 100, t: 'n', fmt: L.pctFmt }; }
    // a whole number and a fraction: 1 1/2 → 1.5 shown # ?/?
    if ((m = /^([-+]?)(\d+) (\d+)\/(\d+)$/.exec(s)) && Number(m[4]) > 0) { const v = Number(m[2]) + Number(m[3]) / Number(m[4]); return { v: m[1] === '-' ? -v : v, t: 'n', fmt: '# ?/?' }; }
    if (L.id === 'ja') {
      // ￥ (full width) is Calc ja-JP's currency; a half-width ¥ or $ leaves the text as text
      if (((m = /^([-+]?)￥ ?([-+]?)(.+)$/.exec(s)) && !(m[1] && m[2]) && (n = readNumber(m[3])) && !n.signed) || ((m = /^\(()￥ ?()(.+)\)$/.exec(s)) && (n = readNumber(m[3])) && !n.signed && (m[1] = '-'))) {
        const neg = m[1] === '-' || m[2] === '-';
        return { v: neg ? -n.v : n.v, t: 'n', fmt: JA_YEN };
      }
    } else if ((m = /^([-+]?)([¥$]) ?([-+]?)(.+)$/.exec(s)) && !(m[1] && m[3]) && (n = readNumber(m[4])) && n.v >= 0) {
      const neg = m[1] === '-' || m[3] === '-';
      const fmt = m[2] === '$' ? '$#,##0.00' : (n.dec ? '¥#,##0.00' : '¥#,##0');
      return { v: neg ? -n.v : n.v, t: 'n', fmt };
    }
    const dt = readDate(s, L);
    if (dt) { return { v: dt.v, t: 'n', fmt: dt.fmt }; }
    const tm = readTime(s, L);
    if (tm) { return { v: tm.v, t: 'n', fmt: tm.fmt }; }
    const sp = L.id === 'ja' && /^\d{1,4}-\d{1,2}-\d{1,2}T/.test(s) ? s.indexOf('T') : s.indexOf(' ');
    if (sp > 0) {
      const d2 = readDate(s.slice(0, sp), L);
      const t2 = d2 ? readTime(s.slice(sp + 1).trim(), L) : null;
      if (d2 && t2) {
        let fmt;
        if (L.id === 'ja') { fmt = d2.iso ? (s[sp] === 'T' ? 'yyyy-mm-dd"T"hh:mm:ss' : 'yyyy-mm-dd hh:mm:ss') : 'yyyy/m/d h:mm'; } else if (d2.iso) { fmt = t2.hasSec ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd hh:mm'; } else { fmt = t2.hasSec ? L.dtsFmt : L.dtFmt; }
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
    let from = 0;
    const s = code;
    const push = (tok) => cur.toks.push(tok);
    while (i < s.length) {
      const ch = s[i];
      if (ch === ';') { cur.src = s.slice(from, i); sections.push(cur); cur = newSection(); i++; from = i; continue; }
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
      if ((ch === 'E' || ch === 'e') && (s[i + 1] === '0' || s[i + 1] === '#') && cur.toks.some((t) => t.k === 'dig')) { push({ k: 'exp', sign: '' }); i++; continue; }
      if (ch === '/') { push({ k: 'slash' }); i++; continue; }
      const dm = /^(y+|m+|d+|h+|s+|g+|e+|r+|n+|a+|q+|w+)/i.exec(s.slice(i));
      if (dm) { push({ k: 'dt', v: dm[1].toLowerCase() }); i += dm[1].length; continue; }
      push({ k: 'lit', v: ch }); i++;
    }
    cur.src = s.slice(from);
    sections.push(cur);
    sections.forEach(classify);
    // a code Calc refuses (#,.#, · a fraction with text before the slash) is refused whole
    const invalid = sections.some((sec) => sec.type === 'num' && !(sec.lo = scanNumber(sec.src)));
    parsed = { sections, invalid };
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
  // ---- number codes as svl reads and writes them ---------------------------
  // A port of LibreOffice's ImpSvNumberformatScan (Next_Symbol, ScanType and
  // FinalScan for numbers, percentages, currencies, fractions and scientific
  // codes) and of SvNumberformat's number, fraction and scientific output, so
  // 000-0000 shows 123-4567, ?,??? pads separators with blanks, # ?/? shows 0
  // and codes Calc refuses (#,.#, or a fraction with text before the slash)
  // are refused here too.

  const S_STRING = -1; const S_DEL = -2; const S_BLANK = -3; const S_STAR = -4; const S_DIGIT = -5; const S_DECSEP = -6; const S_THSEP = -7;
  const S_EXP = -8; const S_FRAC = -9; const S_EMPTY = -10; const S_FRACBLANK = -11; const S_CURRENCY = -12; const S_PERCENT = -16; const S_FDIV = -17;
  const K_E = 1; const K_GENERAL = 2;
  const NT_NUMBER = 1; const NT_PERCENT = 2; const NT_SCI = 3; const NT_FRAC = 4; const NT_CURR = 5; const NT_TEXT = 6;
  const FLAG_STANDARD = 1000;
  // what Calc shows when a number does not fit its code (svl's sErrStr): TEXT(1E+16;"# ?/?") is #FMT
  const CHAR_WIDTHS = [1, 1, 1, 2, 2, 3, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 2, 2, 2, 2, 3, 2, 2, 2, 2, 2, 2, 3, 2, 1, 2, 2, 2, 3, 3, 3,
    2, 3, 2, 2, 2, 2, 2, 3, 2, 2, 2, 1, 1, 1, 2, 2, 1, 2, 2, 2, 2, 2, 1, 2, 2, 1, 1, 2, 1, 3, 2, 2, 2, 2, 1, 2, 1, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 1];
  /** The blanks _x leaves: as wide as x (svl's InsertBlanks). */
  function blanksOf(sym) {
    const c = sym.length >= 2 ? sym.charCodeAt(1) : 0;
    if (c < 32) { return ''; }
    return ' '.repeat(c <= 127 ? CHAR_WIDTHS[c - 32] : 2);
  }
  const isDigitCh = (ch) => ch >= '0' && ch <= '9';
  const isLetterCh = (ch) => /\p{L}/u.test(ch);
  /** The symbols of one section of a number code (Next_Symbol); colours, conditions and [$-411] are already taken off. */
  function lexNumber(src) {
    const syms = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '[') {
        const j = src.indexOf(']', i);
        const inner = j < 0 ? src.slice(i + 1) : src.slice(i + 1, j);
        i = j < 0 ? src.length : j + 1;
        const m = /^\$([^-]*)(?:-[0-9A-Fa-f]*)?$/.exec(inner);
        if (m && m[1]) { syms.push({ t: S_CURRENCY, s: m[1] }); }
        continue;
      }
      if ('#0?%@],./\' :-'.indexOf(ch) >= 0) { syms.push({ t: S_DEL, s: ch }); i++; continue; }
      if (ch === '*') { syms.push({ t: S_STAR, s: src.slice(i, i + 2) }); i += 2; continue; }
      if (ch === '_') { syms.push({ t: S_BLANK, s: src.slice(i, i + 2) }); i += 2; continue; }
      if (ch === '"') { let j = i + 1; while (j < src.length && src[j] !== '"') { j++; } syms.push({ t: S_STRING, s: src.slice(i, j + 1) }); i = j + 1; continue; }
      if (ch === '\\') { syms.push({ t: S_STRING, s: src.slice(i, i + 2) }); i += 2; continue; }
      if ((ch === 'E' || ch === 'e') && i + 1 < src.length && '+-0#'.indexOf(src[i + 1]) >= 0) {
        if (src[i + 1] === '+' || src[i + 1] === '-') { syms.push({ t: K_E, s: 'E' + src[i + 1] }); i += 2; } else { syms.push({ t: K_E, s: 'E' }); i++; }
        continue;
      }
      if (/^general/i.test(src.slice(i, i + 7))) { syms.push({ t: K_GENERAL, s: src.slice(i, i + 7) }); i += 7; continue; }
      if (src.slice(i, i + 4) === 'G/標準') { syms.push({ t: K_GENERAL, s: 'G/標準' }); i += 4; continue; }
      if (isLetterCh(ch)) { let j = i + 1; while (j < src.length && isLetterCh(src[j])) { j++; } syms.push({ t: S_STRING, s: src.slice(i, j) }); i = j; continue; }
      const cp = src.codePointAt(i); const w = cp > 0xffff ? 2 : 1;
      syms.push({ t: S_STRING, s: src.slice(i, i + w) }); i += w;
    }
    return syms;
  }
  /** What kind of number code the symbols make (ScanType), or 0 when Calc refuses the mixture. */
  function numberType(syms) {
    let type = 0;
    for (const y of syms) {
      if (y.t === S_STRING || y.t === S_BLANK || y.t === S_STAR) { continue; }
      let nt = 0;
      if (y.t === K_E) { nt = NT_SCI; } else if (y.t === K_GENERAL) { nt = NT_NUMBER; } else if (y.t === S_CURRENCY) { nt = NT_CURR; } else if (y.t === S_DEL) {
        const c = y.s;
        nt = c === '#' || c === '?' || c === '0' ? NT_NUMBER : c === '%' ? NT_PERCENT : c === '/' ? NT_FRAC : c === '@' ? NT_TEXT : 0;
      }
      if (!type) { type = nt; continue; }
      if (type === NT_TEXT || nt === NT_TEXT) { type = NT_TEXT; continue; }
      if (!nt || nt === type) { continue; }
      if (type === NT_PERCENT || type === NT_SCI || type === NT_FRAC) { if (nt !== NT_NUMBER) { return -1; } continue; }
      if (type === NT_NUMBER) { type = nt; continue; }
    }
    return type || NT_NUMBER;
  }
  const prevChar = (syms, i) => {
    if (i <= 0 || i >= syms.length) { return ' '; }
    i--;
    while (i > 0 && (syms[i].t === S_EMPTY || syms[i].t === S_STRING || syms[i].t === S_STAR || syms[i].t === S_BLANK)) { i--; }
    const s = syms[i].s; return s.length ? s[s.length - 1] : ' ';
  };
  const nextChar = (syms, i) => {
    if (i >= syms.length - 1) { return ' '; }
    i++;
    while (i < syms.length - 1 && (syms[i].t === S_EMPTY || syms[i].t === S_STRING || syms[i].t === S_STAR || syms[i].t === S_BLANK)) { i++; }
    const s = syms[i].s; return s.length ? s[0] : ' ';
  };
  const prevType = (syms, i) => { if (i <= 0 || i >= syms.length) { return 0; } do { i--; } while (i > 0 && syms[i].t === S_EMPTY); return syms[i].t; };
  const isPlaceholder = (ch) => ch === '#' || ch === '0' || ch === '?';
  /** FinalScan for number types: the symbols typed, the grouping put in, and the counts the output needs; null when Calc refuses the code. */
  function scanNumber(src) {
    const syms = lexNumber(src);
    const type = numberType(syms);
    if (type < 0) { return null; }
    if (type === NT_TEXT) { return { type }; }
    const n = syms.length;
    let i = 0; let counter = 0; let bExp = false; let bThousand = false; let nThousand = 0; let bDecSep = false; let nDecPos = -1; let nExpPos = -1; let nBlankPos = -1;
    let cntPre = 0; let cntPost = 0; let cntExp = 0; let bFrac = false; let bBlank = false; let bDenomin = false;
    while (i < n) {
      const y = syms[i];
      if (y.t === S_BLANK || y.t === S_STAR || y.t === K_GENERAL) {
        if (y.t === K_GENERAL) { nThousand = FLAG_STANDARD; }
        i++;
      } else if (y.t === S_STRING || y.t > 0) {
        const c0 = y.s[0];
        if (type === NT_SCI && y.t === K_E) {
          if (bExp) { return null; }
          bExp = true; nExpPos = i;
          if (bDecSep) { cntPost = counter; } else { cntPre = counter; }
          counter = 0; y.t = S_EXP;
        } else if (type === NT_FRAC && (c0 === ' ' || (y.t === S_STRING && !isDigitCh(c0)))) {
          if (!bBlank && !bFrac) {
            if (bDecSep && counter > 0) { return null; }
            if (c0 === ' ' || counter > 0) { bBlank = true; nBlankPos = i; cntPre = counter; counter = 0; y.t = S_FRACBLANK; }
          } else if (c0 === ' ') { y.t = S_FRACBLANK; } else if (bFrac && counter > 0) { bDenomin = true; }
        } else if (isDigitCh(c0) && !bDenomin) {
          let j = i; let div = '';
          while (j < n && isDigitCh(syms[j].s[0])) { div += syms[j].s; j++; }
          if (String(parseInt(div, 10)) === div) {
            while (i < j) { syms[i].t = S_FDIV; i++; }
            i = j - 1;
            if (cntPost) { counter = cntPost; } else if (cntPre) { counter = cntPre; }
            if (type !== NT_FRAC && !cntPre) { cntPre++; }
            if (bFrac) { bDenomin = true; }
          }
        } else {
          if (bFrac && counter > 0) { bDenomin = true; }
          y.t = S_STRING;
        }
        i++;
      } else if (y.t === S_DEL) {
        const c = y.s[0];
        if (isPlaceholder(c)) {
          if (nThousand > 0) { return null; }
          if (!bDenomin) {
            y.t = S_DIGIT; i++; counter++;
            while (i < n && isPlaceholder(syms[i].s[0])) { syms[i].t = S_DIGIT; counter++; i++; }
          } else { y.t = S_STRING; }
        } else if (c === '-') {
          if (bDecSep && nDecPos + 1 === i && syms[nDecPos].t === S_DECSEP) {
            y.t = S_DIGIT; i++; counter++;
            while (i < n && syms[i].s[0] === '-') {
              if (type === NT_CURR && y.s.length >= 2 && (i === n - 1 || syms[i + 1].s[0] !== '-')) { break; }
              y.s += syms[i].s; syms[i].t = S_EMPTY; counter++; i++;
            }
          } else { y.t = S_STRING; i++; }
        } else if (c === ',') {
          const cPre = prevChar(syms, i);
          let cNext;
          if (bExp || bBlank || bFrac) { y.t = S_EMPTY; i++; } else if (i > 0 && i < n - 1 && isPlaceholder(cPre) && isPlaceholder((cNext = nextChar(syms, i)))) {
            bThousand = true; y.t = S_EMPTY; i++;
          } else if (i > 0 && isPlaceholder(cPre) && prevType(syms, i) === S_DIGIT && nThousand < FLAG_STANDARD) {
            do { nThousand++; syms[i].t = S_THSEP; syms[i].s = ','; i++; } while (i < n && syms[i].s === ',');
          } else {
            y.t = S_STRING; i++;
            while (i < n && syms[i].s === ',') { y.s += ','; syms[i].t = S_EMPTY; i++; }
          }
        } else if (c === '.') {
          if (bBlank || bFrac) { return null; }
          if (bExp) { y.t = S_EMPTY; i++; } else if (bDecSep) {
            y.t = S_STRING; i++;
            while (i < n && syms[i].s === '.') { y.s += '.'; syms[i].t = S_EMPTY; i++; }
          } else { y.t = S_DECSEP; bDecSep = true; nDecPos = i; cntPre = counter; counter = 0; i++; }
        } else if (c === ' ' || c === '\'') {
          if (c === ' ' && type === NT_FRAC) {
            if (!bBlank && !bFrac) {
              if (bDecSep && counter > 0) { return null; }
              bBlank = true; nBlankPos = i; cntPre = counter; counter = 0;
            }
            if (bFrac && counter > 0) { bDenomin = true; }
            y.t = S_STRING; // seen again as a string: a fraction's blank
          } else {
            y.t = S_STRING;
            if (bFrac && counter > 0) { bDenomin = true; }
            i++;
            while (i < n && syms[i].s === c) { y.s += c; syms[i].t = S_EMPTY; i++; }
          }
        } else if (c === '/') {
          if (type === NT_FRAC) {
            if (i === 0 || (syms[i - 1].t !== S_DIGIT && syms[i - 1].t !== S_EMPTY)) { return null; }
            if (!bFrac || (bDecSep && counter > 0)) { bFrac = true; cntPost = counter; counter = 0; y.t = S_FRAC; i++; } else { return null; }
          } else { y.t = S_STRING; i++; }
        } else if (c === '%' && type === NT_PERCENT) { y.t = S_PERCENT; i++; } else { y.t = S_STRING; i++; }
      } else { i++; }
    }
    if (type === NT_FRAC) {
      if (bFrac) { cntExp = counter; } else if (bBlank) { cntPost = counter; } else { cntPre = counter; }
    } else if (bExp) { cntExp = counter; } else if (bDecSep) { cntPost = counter; } else { cntPre = counter; }
    if (bThousand) {
      const maxPos = bFrac ? (bBlank ? nBlankPos : 0) : bDecSep ? nDecPos : bExp ? nExpPos : n;
      let count = 0; let group = 3; let firstDigit = maxPos; let firstGroup = maxPos;
      let k = maxPos;
      while (k-- > 0) {
        if (syms[k].t !== S_DIGIT) { continue; }
        firstDigit = k;
        count += syms[k].s.length;
        if (k > 0 && count >= group) {
          if (syms[k - 1].t === S_EMPTY) { k--; syms[k] = { t: S_THSEP, s: ',' }; } else { syms.splice(k, 0, { t: S_THSEP, s: ',' }); }
          firstDigit = k + 1; firstGroup = k; group += 3;
        }
      }
      if (firstGroup < firstDigit) { syms[firstGroup].t = S_EMPTY; }
    }
    if (type === NT_SCI && (cntPre + cntPost === 0 || cntExp === 0)) { return null; }
    if (type === NT_FRAC && (cntExp > 8 || cntExp === 0)) { return null; }
    // digits run together; strings run together and lose their quotes
    const out = [];
    let gap = false; // an emptied symbol ends a run of strings, as in svl
    for (let j = 0; j < syms.length; j++) {
      const y = syms[j];
      if (y.t === S_EMPTY) { gap = true; continue; }
      const prev = gap ? null : out[out.length - 1];
      gap = false;
      if (y.t === S_DIGIT && prev && prev.t === S_DIGIT) { prev.s += y.s; continue; }
      if (y.t === S_STRING || y.t === S_FRACBLANK || y.t === S_CURRENCY) {
        const s = y.s.length > 1 && y.s[0] === '"' && y.s[y.s.length - 1] === '"' ? y.s.slice(1, -1) : y.s.length > 1 && y.s[0] === '\\' ? y.s.slice(1) : y.s;
        if (y.t === S_STRING && prev && (prev.t === S_STRING || prev.t === S_FRACBLANK) && prev.run) { prev.s += s; continue; }
        out.push({ t: y.t, s, run: y.t !== S_CURRENCY });
        continue;
      }
      out.push({ t: y.t, s: y.s });
    }
    return { type, syms: out, bThousand, nThousand, cntPre, cntPost, cntExp };
  }
  function fracParts(info) {
    const syms = info.syms;
    const f = syms.findIndex((y) => y.t === S_FRAC);
    let num = ''; let den = ''; let int = '';
    if (f >= 0) {
      for (let j = f - 1; j >= 0 && syms[j].t === S_DIGIT; j--) { num = syms[j].s + num; }
      let j = f + 1; while (j < syms.length && syms[j].t !== S_FDIV && syms[j].t !== S_DIGIT) { j++; }
      for (; j < syms.length && (syms[j].t === S_FDIV || syms[j].t === S_DIGIT); j++) { den += syms[j].s; }
    }
    const b = syms.findIndex((y) => y.t === S_FRACBLANK);
    if (b >= 0) { for (let j = b - 1; j >= 0 && (syms[j].t === S_DIGIT || syms[j].t === S_THSEP); j--) { int = syms[j].s + int; } }
    return { num, den, int };
  }
  const toInt32 = (s) => { const m = /^[+-]?\d+/.exec(s); return m ? Number(m[0]) : 0; };
  /** svl's GetPrecExp: the number of digits before the point (negative below 1). */
  function precExp(a) {
    if (a < 1e-7 || a > 1e7) { return Math.floor(xlog10(a)) + 1; }
    let n = 1;
    while (a < 1) { a *= 10; n--; }
    while (a >= 10) { a /= 10; n++; }
    return n;
  }
  /** Builds a string backwards the way svl's fill routines do (insert at k). */
  class SBuf {
    constructor(s) { this.s = s; }
    ins(k, t) { this.s = this.s.slice(0, k) + t + this.s.slice(k); }
    del(k) { this.s = this.s.slice(0, k) + this.s.slice(k + 1); }
    set(k, ch) { this.s = this.s.slice(0, k) + ch + this.s.slice(k + 1); }
    get length() { return this.s.length; }
  }
  /** Separators for the digits beyond the code's own (ImpDigitFill). */
  function digitFill(buf, start, st, info) {
    if (info.bThousand) {
      while (st.k > start) { if (st.count === st.group) { buf.ins(st.k, ','); st.group += 3; } st.count++; st.k--; }
    } else { st.k = start; }
  }
  /** The integer part, right to left (ImpNumberFillWithThousands). */
  function fillWithThousands(buf, v, k, j, info, digCnt, addDecSep) {
    const syms = info.syms;
    let leading = 0; let doThousands = info.nThousand === 0;
    const st = { k, count: 0, group: 3 };
    let stop = false;
    while (!stop) {
      if (j <= 0) { stop = true; }
      if (j < 0) { break; }
      const y = syms[j];
      switch (y.t) {
        case S_DECSEP: case S_STRING: case S_CURRENCY: case S_PERCENT:
          if (y.t === S_DECSEP) { st.group = 3; }
          if (y.t !== S_DECSEP || addDecSep) { buf.ins(st.k, y.t === S_DECSEP ? '.' : y.s); }
          if (st.k === 0) { leading += y.s.length; }
          break;
        case S_BLANK: buf.ins(st.k, blanksOf(y.s)); break;
        case S_THSEP:
          if (!doThousands && j < syms.length - 1) { doThousands = j === 0 || (syms[j - 1].t !== S_DIGIT && syms[j - 1].t !== S_THSEP) || syms[j + 1].t === S_DIGIT; }
          if (doThousands) {
            if (st.k > 0) { buf.ins(st.k, y.s); } else if (st.count < digCnt) {
              const lead = j > 0 && syms[j - 1].t === S_DIGIT ? syms[j - 1].s[syms[j - 1].s.length - 1] : '';
              if (lead === '?') { buf.ins(st.k, ' '); } else if (lead !== '#') { buf.ins(st.k, y.s); }
            }
            st.group += 3;
          }
          break;
        case S_DIGIT:
          for (let p = y.s.length - 1; p >= 0; p--) {
            st.count++;
            if (st.k > 0) { st.k--; } else if (y.s[p] === '0') { buf.ins(0, '0'); } else if (y.s[p] === '?') { buf.ins(0, ' '); }
            if (st.count === digCnt && st.k > 0) { digitFill(buf, 0, st, info); }
          }
          break;
        case K_GENERAL: buf.ins(st.k, general(Math.abs(v)).replace(/^-/, '')); break;
        default: break;
      }
      j--;
    }
    st.k += leading;
    if (st.k > leading) { digitFill(buf, leading, st, info); }
  }
  /** The decimals, right to left, then the integer part (ImpDecimalFill). */
  function decimalFill(buf, v, decPos, j, info, isInteger) {
    const syms = info.syms;
    let filled = false;
    let k = buf.length;
    if (info.cntPost > 0) {
      let trailing = true;
      while (j > 0 && syms[j].t !== S_DECSEP) {
        const y = syms[j];
        switch (y.t) {
          case S_BLANK: buf.ins(k, blanksOf(y.s)); break;
          case S_STRING: case S_CURRENCY: case S_PERCENT: buf.ins(k, y.s); break;
          case S_THSEP: if (info.nThousand === 0) { buf.ins(k, y.s); } break;
          case S_DIGIT: {
            if (decPos >= 0 && decPos <= k) { let add = y.s.length - (k - decPos); while (add-- > 0) { buf.ins(k++, '0'); } }
            let p = y.s.length;
            while (k && p > 0) {
              p--; const c = y.s[p]; k--;
              if (buf.s[k] !== '0') { trailing = false; filled = true; }
              if (trailing) {
                if (c === '0') { filled = true; } else if (c === '-') { if (isInteger) { buf.set(k, '-'); } filled = true; } else if (c === '?') { buf.set(k, ' '); filled = true; } else if (!filled) { buf.del(k); }
              }
            }
            break;
          }
          case K_GENERAL: buf.ins(k, general(Math.abs(v)).replace(/^-/, '')); break;
          default: break;
        }
        j--;
      }
    }
    fillWithThousands(buf, v, k, j, info, info.cntPre, filled);
  }
  /** Numerator, denominator or exponent, right to left (ImpNumberFill); returns the index it stopped at. */
  function numberFill(buf, v, j, info, stopType, rightBlank) {
    const syms = info.syms;
    let doThousands = info.nThousand === 0; let found = false;
    let k = buf.length;
    while (j >= 0 && syms[j].t !== stopType) {
      const y = syms[j];
      switch (y.t) {
        case S_STAR: break;
        case S_BLANK: if (found && stopType !== S_EXP) { k = 0; } { const b = blanksOf(y.s); buf.ins(k, b); k += b.length; } break;
        case S_THSEP:
          if (!doThousands && j < syms.length - 1) { doThousands = j === 0 || (syms[j - 1].t !== S_DIGIT && syms[j - 1].t !== S_THSEP) || syms[j + 1].t === S_DIGIT; }
          if (doThousands && k > 0) { buf.ins(k, y.s); }
          break;
        case S_DIGIT: {
          found = true;
          const at = rightBlank ? k : 0;
          for (let p = y.s.length - 1; p >= 0; p--) {
            if (k > 0) { k--; } else if (y.s[p] === '0') { buf.ins(0, '0'); } else if (y.s[p] === '?') { buf.ins(at, ' '); }
          }
          break;
        }
        case K_GENERAL: found = true; buf.ins(k, general(Math.abs(v)).replace(/^-/, '')); break;
        case S_FDIV: if (k > 0) { k--; } break;
        default:
          if (found && stopType !== S_EXP) { k = 0; }
          buf.ins(k, y.t === S_DECSEP ? '.' : y.t === S_EXP ? y.s[0] : y.s);
          break;
      }
      if (j === 0) { return { j: 0, stopped: false }; }
      j--;
    }
    return { j, stopped: true };
  }
  function numberOutput(v, sign, info) {
    let a = Math.abs(v);
    if (info.type === NT_PERCENT) { if (a < 1.7e306) { a *= 100; } else { return '#FMT'; } }
    let str = ''; let decPos = -1; let isInteger = false;
    if (info.nThousand !== FLAG_STANDARD) {
      for (let i = 0; i < info.nThousand; i++) { a = a > 2.3e-305 ? a / 1000 : 0; }
      const pe = a > 0 ? precExp(a) : 0;
      a = rtlRound(a, info.cntPost, 'corr');
      if (info.cntPost) {
        if (info.cntPost + pe > 15 && pe < 15) { str = fixedStr(a, 15 - pe) + '0'.repeat(info.cntPost - (15 - pe)); } else { str = fixedStr(a, info.cntPost); }
        str = str.replace(/^0+/, '');
      } else if (a !== 0) { str = fixedStr(a, 0).replace(/^0+/, ''); }
      decPos = str.indexOf('.');
      if (decPos >= 0) { isInteger = /^0*$/.test(str.slice(decPos + 1)); str = str.slice(0, decPos) + str.slice(decPos + 1); }
      if (sign && (str === '' || /^0+$/.test(str))) { sign = false; }
    }
    const buf = new SBuf(str);
    decimalFill(buf, a, decPos, info.syms.length - 1, info, isInteger);
    return (sign ? '-' : '') + buf.s;
  }
  /** svl's ImpGetFractionElements: the whole part and the fraction, best within the denominator's digits. */
  function fractionElements(v, info) {
    const a = Math.abs(v);
    let whole = Math.floor(a); const x = a - whole;
    const forced = toInt32(fracParts(info).den);
    let nFrac = 0; let nDiv = 1;
    if (forced > 0) {
      nDiv = forced; nFrac = Math.floor(x * nDiv);
      if (x - nFrac / nDiv > (nFrac + 1) / nDiv - x) { nFrac++; }
    } else {
      const basis = Math.floor(xpow(10, info.cntExp)) - 1;
      let fracPrev = 1; let divPrev = 0; let rem = x;
      while (rem > 0) {
        const t = 1 / rem; const pd = Math.floor(t); rem = t - pd;
        const divNext = pd * nDiv + divPrev;
        if (divNext <= basis) { const fracNext = pd * nFrac + fracPrev; fracPrev = nFrac; nFrac = fracNext; divPrev = nDiv; nDiv = divNext; } else {
          const collat = Math.trunc((basis - divPrev) / nDiv);
          if (2 * collat >= pd) {
            const fracTest = collat * nFrac + fracPrev; const divTest = collat * nDiv + divPrev;
            const sgn = nFrac > x * nDiv ? 1 : -1;
            const B = BigInt;
            const lhs = Number(B(nFrac) * B(divTest) + B(nDiv) * B(fracTest)) - 2 * Number(B(nDiv) * B(divTest)) * x;
            if (sgn * lhs > 0) { nFrac = fracTest; nDiv = divTest; }
          }
          rem = 0;
        }
      }
    }
    if (nFrac >= nDiv) { whole++; nFrac = 0; nDiv = forced > 0 ? forced : 1; }
    return { whole, nFrac, nDiv };
  }
  function fractionOutput(v, sign, info) {
    const syms = info.syms;
    const { num, den, int } = fracParts(info);
    if (Math.floor(v) > 4294967295 || info.cntExp > 9) { return '#FMT'; }
    if (info.cntExp === 0) { return ''; }
    let { whole, nFrac, nDiv } = fractionElements(v, info);
    let sStr = '';
    if (info.cntPre === 0) {
      const all = whole * nDiv + nFrac;
      if (all > 9007199254740991) { return '#FMT'; }
      nFrac = Math.floor(all);
    } else if (!(whole === 0 && nFrac !== 0)) { sStr = String(whole); }
    const hide = info.cntPre > 0 && nFrac === 0 && num.indexOf('0') < 0 && (den.indexOf('0') < 0 || toInt32(den) > 0);
    const sFrac = new SBuf(hide ? '' : String(nFrac));
    const sDiv = new SBuf(hide ? '' : String(nDiv));
    let r = numberFill(sDiv, v, syms.length - 1, info, S_FRAC, true);
    let j = r.j;
    let cont = true;
    if (r.stopped && syms[j].t === S_FRAC) {
      if (hide) { if (num.indexOf('?') >= 0 || den.indexOf('?') >= 0) { sDiv.ins(0, ' '); } } else { sDiv.ins(0, '/'); }
      if (j) { j--; } else { cont = false; }
    }
    if (!cont) { sFrac.s = ''; } else {
      r = numberFill(sFrac, v, j, info, S_FRACBLANK, false);
      j = r.j;
      cont = false;
      if (r.stopped && syms[j].t === S_FRACBLANK) {
        const blank = syms[j].s;
        if (j) {
          if (hide) { if (int.indexOf('?') >= 0 || num.indexOf('?') >= 0 || den.indexOf('?') >= 0) { sFrac.ins(0, ' '.repeat(blank.length)); } } else if (whole !== 0 || int.indexOf('0') >= 0) { sFrac.ins(0, blank); } else if (int.indexOf('?') >= 0 || num.indexOf('?') >= 0) { sFrac.ins(0, ' '.repeat(blank.length)); }
          j--; cont = true;
        } else { sFrac.ins(0, blank); }
      }
    }
    const sInt = new SBuf(cont ? sStr : '');
    if (cont) { fillWithThousands(sInt, v, sInt.length, j, info, info.cntPre, false); }
    return (sign && (nFrac !== 0 || whole !== 0) ? '-' : '') + sInt.s + sFrac.s + sDiv.s;
  }
  /** The mantissa digits of a in E format with dec decimals (rtl's doubleToString E), and its exponent. */
  function eDigits(a, dec) {
    if (a === 0) { return { mant: dec > 0 ? '0.' + '0'.repeat(dec) : '0', exp: 0 }; }
    const r = roundSig(a, Math.min(dec + 1, 17));
    const d = r.digits.padEnd(dec + 1, '0');
    return { mant: dec > 0 ? d[0] + '.' + d.slice(1) : d[0], exp: r.exp };
  }
  function scientificOutput(v, sign, info) {
    const a = Math.abs(v);
    let { mant, exp } = eDigits(a, Math.max(info.cntPre + info.cntPost - 1, 0));
    let expSign = exp < 0 ? -1 : 1;
    let expStr = String(Math.abs(exp));
    if (info.cntPre !== 1) {
      let nExp = exp;
      let rescale = info.cntPre !== 0 ? nExp % info.cntPre : -1;
      if (rescale < 0 && info.cntPre !== 0) { rescale += info.cntPre; }
      nExp -= rescale;
      if (nExp < 0) { expSign = -1; nExp = -nExp; } else { expSign = 1; }
      expStr = String(nExp);
      const first = mant[0];
      mant = eDigits(a, rescale + info.cntPost).mant;
      if (mant[0] === '1' && first !== '1') { mant += '0'; }
    }
    const decPos = mant.indexOf('.');
    const digits = mant.replace(/\./g, '');
    const syms = info.syms;
    const eb = new SBuf(expStr);
    const r = numberFill(eb, a, syms.length - 1, info, S_EXP, false);
    let j = r.j; let cont = true;
    if (r.stopped && syms[j].t === S_EXP) {
      const es = syms[j].s;
      if (expSign === -1) { eb.ins(0, '-'); } else if (es.length > 1 && es[1] === '+') { eb.ins(0, '+'); }
      eb.ins(0, es[0]);
      if (j) { j--; } else { cont = false; }
    }
    const buf = new SBuf(cont ? digits : '');
    if (cont) { decimalFill(buf, a, decPos, j, info, false); }
    return (sign ? '-' : '') + buf.s + eb.s;
  }
  /** A number in a number section, sign included when the section wants it: the text, or null when Calc refuses the code. */
  function numberSectionText(v, sec, sign) {
    if (sec.lo === undefined) { sec.lo = scanNumber(sec.src); }
    const info = sec.lo;
    if (!info) { return null; }
    if (info.type === NT_TEXT) { return general(v); }
    if (info.type === NT_FRAC) { return fractionOutput(v, sign, info); }
    if (info.type === NT_SCI) { return scientificOutput(v, sign, info); }
    return numberOutput(v, sign, info);
  }
  function formatDateSection(v, sec, L, sign) {
    const n = v < 0 ? -v : v;
    const day = v < 0 ? Math.ceil(v) : Math.floor(v);
    let secs = Math.round((n - Math.floor(n)) * 86400 * 1e6) / 1e6;
    let d = day;
    if (secs >= 86400) { secs -= 86400; d += 1; }
    const ymd = serialToYmd(d);
    let whole = Math.floor(secs);
    let h = Math.floor(whole / 3600); let mi = Math.floor((whole % 3600) / 60); let s = whole % 60;
    let frac = secs - whole;
    // [h] [mm] [ss]: the whole time in seconds, rounded to the decimals shown, then split (svl's ImpGetTimeOutput)
    const el = sec.toks.find((t) => t.k === 'dt' && t.elapsed);
    let neg = false;
    if (el) {
      const fr = sec.toks.find((t) => t.k === 'secfrac');
      const total = rtlRound(n * 86400, fr ? fr.n : 0, 'corr');
      if (total > 4294967295) { return '#FMT'; }
      whole = Math.floor(total); frac = total - whole;
      const unit = el.v[0] === 'h' ? 'h' : el.v[0] === 's' ? 's' : 'm';
      if (unit === 'h') { h = Math.floor(whole / 3600); mi = Math.floor((whole % 3600) / 60); s = whole % 60; } else if (unit === 'm') { h = 0; mi = Math.floor(whole / 60); s = whole % 60; } else { h = 0; mi = 0; s = whole; }
      neg = !!sign && v < 0 && total !== 0;
    }
    const out = [];
    const two = (x) => String(x).padStart(2, '0');
    sec.toks.forEach((t, i) => {
      if (t.k === 'lit') { out.push(t.v); return; }
      if (t.k === 'secfrac') { out.push(('.' + fixedStr(frac, t.n).split('.')[1])); return; }
      if (t.k === 'general') { out.push(general(v)); return; }
      if (t.k !== 'dt') { return; }
      const code = t.v;
      if (t.elapsed) {
        const width = code[0] === 'm' ? code.length - 3 : code.length;
        out.push(String(code[0] === 'h' ? h : code[0] === 's' ? s : mi).padStart(width, '0'));
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
    return (neg ? '-' : '') + out.join('');
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
      if (type === 'n') { return { text: STD_DEC != null ? generalDec(Number(v), STD_DEC) : general(Number(v)), color: null }; }
      return { text: String(v), color: null };
    }
    const parsed = parseFormat(code);
    const secs = parsed.sections;
    if (type === 's') {
      if (parsed.invalid) { return { text: String(v), color: null, invalid: true }; }
      const ts = secs.find((s) => s.type === 'text');
      if (!ts) { return { text: String(v), color: null }; }
      return { text: ts.toks.map((tk) => (tk.k === 'text' ? String(v) : tk.k === 'lit' ? tk.v : '')).join(''), color: ts.color };
    }
    const num = type === 'b' ? (v ? 1 : 0) : Number(v);
    if (!isFinite(num)) { return { text: ERR.NUM, color: null }; }
    if (type === 'b' && secs.every((s) => s.type === 'text' || s.type === 'general')) { return { text: v ? 'TRUE' : 'FALSE', color: null }; }
    const { sec, sign } = pickSection(secs, num);
    if (sec.locale) { L = LOC[sec.locale]; }
    if (sec.type === 'date') { const text = formatDateSection(num, sec, L, sign); return { text, color: sec.color }; }
    if (sec.type === 'general') { return { text: sec.toks.map((tk) => (tk.k === 'general' ? general(num) : tk.k === 'lit' ? tk.v : '')).join(''), color: sec.color }; }
    // a code only for text leaves numbers as they are (Calc: @"様" shows 1 as 1)
    if (sec.type === 'text') { return { text: general(num), color: null }; }
    if (sec.type === 'lit') { return { text: sec.toks.map((tk) => (tk.k === 'lit' ? tk.v : '')).join(''), color: sec.color }; }
    const text = parsed.invalid ? null : numberSectionText(num, sec, sign);
    if (text == null) { return { text: general(num), color: null, invalid: true }; }
    return { text, color: sec.color };
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
    if (p.type === 'num') { if (p.pct) { return 'percent'; } if (p.toks.some((t) => t.k === 'lit' && /[¥￥$€£]/.test(t.v))) { return 'currency'; } return 'number'; }
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
      if ('+-*/^&=<>%(),;:{}|~'.indexOf(ch) >= 0) { push({ t: 'op', v: ch }, i, i + 1); i++; continue; }
      fail(ERR.CHAR);
    }
    return out;
  }

  const VOLATILE = new Set(['NOW', 'TODAY', 'RAND', 'RANDBETWEEN', 'OFFSET', 'INDIRECT']);
  const FN_PREFIX = /^(COM\.MICROSOFT\.|ORG\.OPENOFFICE\.|ORG\.LIBREOFFICE\.|LEGACY\.|COM\.SUN\.STAR\.SHEET\.ADDIN\.ANALYSIS\.GET|_XLFN\.|_XLWS\.)/i;
  /**
   * An ODS file's names that are not Calc's own with the prefix taken off (LibreOffice 24.2's
   * FormulaOpCodeMapper; the server reads a file's names so, this is for a formula that still says them).
   */
  const ODF_NAMES = { 'COM.MICROSOFT.FLOOR': 'FLOOR.XCL', 'COM.MICROSOFT.CEILING': 'CEILING.XCL', 'ORG.OPENOFFICE.CONVERT': 'CONVERT_OOO', 'BINOM.DIST.RANGE': 'B', 'COM.MICROSOFT.FORECAST.ETS': 'FORECAST.ETS.ADD', 'COM.MICROSOFT.FORECAST.ETS.CONFINT': 'FORECAST.ETS.PI.ADD', 'COM.MICROSOFT.FORECAST.ETS.STAT': 'FORECAST.ETS.STAT.ADD', 'MULTIPLE.OPERATIONS': 'MULTIPLE.OPERATIONS' };

  /**
   * Recursive descent with Calc's order: comparison < & < + - < * / < ^ < unary
   * minus < % postfix. A missing closing parenthesis is supplied, as Calc does.
   */
  function parse(src) {
    const toks = tokenize(src);
    let k = 0;
    let depth = 0;
    const info = { volatile: false, refs: [], names: [] };
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
    const percent = () => { let a = union(); while (take('%')) { a = { k: 'pct', a }; } return a; };
    // A1:B3~F2: Calc's reference concatenation, a list of areas (AREAS counts them)
    const union = () => { let a = atom(); while (take('~')) { a = { k: 'union', a, b: atom() }; } return a; };
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
          const upper = w.toUpperCase();
          const name = ODF_NAMES[upper] || upper.replace(FN_PREFIX, '');
          if (VOLATILE.has(name)) { info.volatile = true; }
          if (name === 'SUBTOTAL' || name === 'AGGREGATE') { info.sub = true; }
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
        info.names.push(w);
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
  /** Several areas as one reference: A1:B3~F2 (Calc's ~), or one range over several sheets (Sheet1.A1:Sheet3.B2). */
  class RefList { constructor(areas) { this.areas = areas; } }
  /** An array worked out only when its elements are read (ROW(A:A) has a million of them, and usually only the first is wanted). */
  class GenArray extends ArrayVal {
    constructor(h, w, fn) { super(null); this.gh = h; this.gw = w; this.fn = fn; this.built = null; }
    get rows() { if (!this.built) { const rows = new Array(this.gh); for (let r = 0; r < this.gh; r++) { const row = new Array(this.gw); for (let c = 0; c < this.gw; c++) { row[c] = this.fn(r, c); } rows[r] = row; } this.built = rows; } return this.built; }
    set rows(v) { /* set by the base constructor: ignored */ }
    get h() { return this.gh; }
    get w() { return this.gw; }
  }

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
    const key = L.coll || L.id;
    let c = coll.get(key);
    // a document that is not case-sensitive ("a"="A" is TRUE: an XLSX file, Calc measured) compares without case
    if (!c) { c = new Intl.Collator(L.id === 'ja' ? 'ja' : 'en', L.caseless ? { sensitivity: 'accent' } : undefined); coll.set(key, c); }
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
    if (L.caseless && a.toLowerCase() === b.toLowerCase()) { return 0; }
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
  const regexCache = new Map();
  /**
   * A criterion read as a regular expression, as Calc does in a document set so (an ODS file
   * without settings of its own: "testi.." finds "testing", "a.*" every word starting with a):
   * the whole cell, without regard to case. null when it is not one (it is then compared as text).
   */
  function regexOf(p) {
    if (regexCache.has(p)) { return regexCache.get(p); }
    let re = null;
    try { re = new RegExp('^(?:' + p + ')$', 'isu'); } catch (e) { re = null; }
    if (regexCache.size > 500) { regexCache.clear(); }
    regexCache.set(p, re);
    return re;
  }
  /** The test a text criterion makes: a regular expression, wildcards, or none (plain text). */
  const patternOf = (p, L) => (L.regex ? regexOf(p) : hasWild(p) ? wildcard(p) : null);
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
      const re = patternOf(rhs, L);
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

  /** The cells of a range column by column (Calc's order for SUM and the like), clamped like eachCell. */
  function eachCellByColumn(rv, fn) {
    const sh = rv.sheet;
    const r1 = Math.min(rv.r1, sh.maxR); const c1 = Math.min(rv.c1, sh.maxC);
    if (r1 < rv.r0 || c1 < rv.c0) { return; }
    const area = (r1 - rv.r0 + 1) * (c1 - rv.c0 + 1);
    if (area > 4 * sh.cells.size + 64) {
      const list = [];
      for (const cell of sh.cells.values()) { if (cell.r >= rv.r0 && cell.r <= r1 && cell.c >= rv.c0 && cell.c <= c1) { list.push(cell); } }
      list.sort((a, b) => a.c - b.c || a.r - b.r);
      for (const cell of list) { fn(cell.r, cell.c); }
      return;
    }
    for (let c = rv.c0; c <= c1; c++) { for (let r = rv.r0; r <= r1; r++) { fn(r, c); } }
  }
  /** Evaluate in a scalar place: a range becomes one cell (implicit intersection), an array its first element. */
  function deref(v, ctx) {
    if (v instanceof RefList) { if (v.areas.length === 1) { return deref(v.areas[0], ctx); } return fail(ERR.VALUE); }
    if (v instanceof RangeVal) {
      let x;
      if (v.single) { x = ctx.cellValue(v.sheet, v.r0, v.c0); } else if (v.c0 === v.c1 && ctx.at.r >= v.r0 && ctx.at.r <= v.r1 && v.sheet === ctx.sheet) { x = ctx.cellValue(v.sheet, ctx.at.r, v.c0); } else if (v.r0 === v.r1 && ctx.at.c >= v.c0 && ctx.at.c <= v.c1 && v.sheet === ctx.sheet) { x = ctx.cellValue(v.sheet, v.r0, ctx.at.c); } else { return fail(ERR.VALUE); }
      if (isErr(x)) { throw x; }
      return x;
    }
    if (v instanceof ArrayVal) { const x = v instanceof GenArray ? v.fn(0, 0) : v.rows[0] ? v.rows[0][0] : null; if (isErr(x)) { throw x; } return x; }
    if (isErr(v)) { throw v; }
    return v;
  }
  /** More than one value: what an array formula iterates over instead of intersecting. */
  const isMulti = (v) => (v instanceof RangeVal ? !v.single : v instanceof ArrayVal ? v.h * v.w > 1 : false);
  function resolveRef(tok, ctx) {
    const sh = tok.sheet ? ctx.wb.sheetByName(tok.sheet.name) : ctx.sheet;
    if (!sh) { return fail(ERR.REF); }
    const a = tok.a; const b = tok.b || tok.a;
    if (tok.sheetB && tok.sheetB.name.toLowerCase() !== (tok.sheet ? tok.sheet.name : ctx.sheet.name).toLowerCase()) {
      // Sheet1.A1:Sheet3.B2: the same cells on every sheet from the first to the last (a 3D reference)
      const shB = ctx.wb.sheetByName(tok.sheetB.name);
      if (!shB || tok.kind !== 'range') { return fail(ERR.REF); }
      const i0 = ctx.wb.sheets.indexOf(sh); const i1 = ctx.wb.sheets.indexOf(shB);
      const list = ctx.wb.sheets.slice(Math.min(i0, i1), Math.max(i0, i1) + 1);
      return new RefList(list.map((x) => new RangeVal(x, Math.min(a.r, b.r), Math.min(a.c, b.c), Math.max(a.r, b.r), Math.max(a.c, b.c))));
    }
    let r0; let c0; let r1; let c1;
    if (tok.kind === 'cols') { r0 = 0; r1 = MAXR - 1; c0 = Math.min(a.c, b.c); c1 = Math.max(a.c, b.c); } else if (tok.kind === 'rows') { c0 = 0; c1 = MAXC - 1; r0 = Math.min(a.r, b.r); r1 = Math.max(a.r, b.r); } else { r0 = Math.min(a.r, b.r); r1 = Math.max(a.r, b.r); c0 = Math.min(a.c, b.c); c1 = Math.max(a.c, b.c); }
    const gb = ctx.wb.gridBounds;
    if (gb && (r1 >= gb.rows || c1 >= gb.cols) && tok.kind === 'cell') { return fail(ERR.REF); }
    return new RangeVal(sh, r0, c0, r1, c1);
  }
  /** An error raised while an argument was worked out, kept until a function reads that argument. */
  class Thrown { constructor(e) { this.e = e; } }
  /**
   * A scalar argument of a function met several values inside an array
   * formula: the function is then called once per element (Calc's implicit
   * iteration, its "jump matrix").
   */
  class Lift { constructor(node) { this.node = node; } }
  function ev(n, ctx) {
    if (ctx.over !== null) { const o = ctx.over.get(n); if (o !== undefined) { if (o instanceof Thrown) { throw o.e; } return o; } }
    switch (n.k) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'err': return fail(n.v);
      case 'empty': return null;
      case 'ref': return resolveRef(n.tok, ctx);
      case 'array': return new ArrayVal(n.rows);
      case 'name': return evName(n, ctx);
      case 'union': {
        const areas = [];
        for (const side of [ev(n.a, ctx), ev(n.b, ctx)]) {
          if (side instanceof RangeVal) { areas.push(side); } else if (side instanceof RefList) { areas.push(...side.areas); } else if (isErr(side)) { throw side; } else { return fail(ERR.VALUE); }
        }
        return new RefList(areas);
      }
      case 'neg': if (ctx.arr) { const a = ev(n.a, ctx); if (isMulti(a)) { return mapA(toArray(a, ctx), (x) => -toNum(x, ctx.L)); } return -toNum(deref(a, ctx), ctx.L); } return -toNum(deref(ev(n.a, ctx), ctx), ctx.L);
      case 'pct': if (ctx.arr) { const a = ev(n.a, ctx); if (isMulti(a)) { return mapA(toArray(a, ctx), (x) => toNum(x, ctx.L) / 100); } return toNum(deref(a, ctx), ctx.L) / 100; } return toNum(deref(ev(n.a, ctx), ctx), ctx.L) / 100;
      case 'fn': return callFn(n, ctx);
      case 'bin': {
        if (ctx.arr) {
          const a = ev(n.a, ctx); const b = ev(n.b, ctx);
          if (isMulti(a) || isMulti(b)) { return zip(isMulti(a) ? toArray(a, ctx) : deref(a, ctx), isMulti(b) ? toArray(b, ctx) : deref(b, ctx), (x, y) => binop(n.op, x, y, ctx.L)); }
          return binop(n.op, deref(a, ctx), deref(b, ctx), ctx.L);
        }
        const left = deref(ev(n.a, ctx), ctx);
        ctx.cur = left; // what CURRENT() answers: the formula worked out so far (Calc's =1+2+CURRENT() is 6)
        return binop(n.op, left, deref(ev(n.b, ctx), ctx), ctx.L);
      }
      default: return fail(ERR.PARSE);
    }
  }
  /**
   * A defined name (Calc's Sheet ▸ Named Ranges and Expressions): the sheet's own name first,
   * then the book's. What it stands for is worked out where it is used: a reference in it
   * written without a sheet is on the sheet of the formula, a relative one moves with the cell.
   */
  function evName(n, ctx) {
    const e = ctx.wb.nameEntry(ctx.sheet, n.v);
    if (!e) { return fail(ERR.NAME); }
    const depth = ctx.nameDepth || 0;
    if (depth > 32) { return fail(ERR.CIRC); }
    const ast = ctx.wb.nameAst(e, ctx.at.r, ctx.at.c);
    if (!ast) { return fail(e.err || ERR.NAME); }
    ctx.nameDepth = depth + 1;
    try { return ev(ast, ctx); } finally { ctx.nameDepth = depth; }
  }
  /** A name as Calc allows it: a letter or _ first, then letters, digits, _ and .; not a cell address, not TRUE or FALSE. */
  const NAME_OK = /^[\p{L}_][\p{L}\p{N}_.]{0,254}$/u;
  function validName(name) {
    const nm = String(name == null ? '' : name);
    return NAME_OK.test(nm) && !parseRef(nm) && !/^(TRUE|FALSE)$/i.test(nm) && !/^[A-Za-z]{1,3}\d+$/.test(nm) && !/^R\d*C\d*$/i.test(nm);
  }
  function callFn(n, ctx) {
    const f = FN[n.name];
    if (!f) { return fail(ERR.NAME); }
    const ar = ARITY[n.name];
    if (ar) { const cnt = n.args.length; if (cnt < ar[0]) { return fail(ERR.MISSING); } if (ar[1] >= 0 && cnt > ar[1]) { return fail(ERR.PAIR); } }
    if (!ctx.arr) { return f(new Args(n.args, ctx), ctx); }
    try { return f(new Args(n.args, ctx), ctx); } catch (e) { if (e instanceof Lift) { return liftCall(n, f, ctx, e.node); } throw e; }
  }
  /** One element of an array for position (i, j): a single row or column is repeated, outside is #N/A. */
  function elemAt(v, i, j) {
    if (!(v instanceof ArrayVal)) { return v; }
    const h = v.h; const w = v.w;
    const r = h === 1 ? 0 : i; const c = w === 1 ? 0 : j;
    if (r >= h || c >= w) { return new CalcError(ERR.NA); }
    return v.rows[r][c];
  }
  /** IF's "false without an else" inside an array: shown as 0, skipped by SUM and COUNT (Calc's empty path). */
  const EMPTY_PATH = Object.freeze({ emptyPath: true });
  /**
   * Call a function once per element of the arguments that are arrays in a
   * scalar place; the answer is an array as large as the largest of them
   * (#N/A where a smaller one has no element). When those arrays are a single
   * row or column and the function answers with larger arrays (IF's branches),
   * the answer grows to their size, as Calc adjusts its jump matrix.
   */
  function liftCall(n, f, ctx, first) {
    const over = new Map(ctx.over || []);
    for (const a of n.args) {
      if (a.k === 'empty' || over.has(a)) { continue; }
      try { over.set(a, ev(a, ctx)); } catch (e) { if (isErr(e)) { over.set(a, new Thrown(e)); } else { throw e; } }
    }
    const ec = Object.assign({}, ctx, { over });
    const lifted = new Map();
    const addLift = (node) => {
      if (n.args.indexOf(node) < 0 || lifted.has(node)) { return false; }
      const v = over.get(node);
      lifted.set(node, v instanceof RangeVal ? toArray(v, ctx, true) : v);
      return true;
    };
    if (!addLift(first)) { return fail(ERR.VALUE); }
    let growH = 0; let growW = 0;
    for (let guard = 0; guard <= n.args.length + 1; guard++) {
      let h = 1; let w = 1;
      for (const v of lifted.values()) { if (v instanceof ArrayVal) { h = Math.max(h, v.h); w = Math.max(w, v.w); } }
      const jh = h; const jw = w;
      if (growH) { h = growH; }
      if (growW) { w = growW; }
      const rows = [];
      let restart = false; let resH = 0; let resW = 0;
      for (let i = 0; i < h && !restart; i++) {
        const row = [];
        for (let j = 0; j < w; j++) {
          for (const [node, v] of lifted) { const x = elemAt(v, i, j); over.set(node, x == null ? null : x); }
          let r;
          try {
            r = f(new Args(n.args, ec), ec);
            if (r instanceof RangeVal || r instanceof ArrayVal) {
              if (isMulti(r)) { const ra = toArray(r, ec, true); resH = Math.max(resH, ra.h); resW = Math.max(resW, ra.w); r = elemAt(ra, i, j); } else { r = deref(r, ec); }
            }
            if (r === EMPTY_PATH) { r = null; (rows.ep || (rows.ep = new Set())).add(i * 65536 + j); }
          } catch (e) {
            if (e instanceof Lift) { if (addLift(e.node)) { restart = true; break; } r = new CalcError(ERR.VALUE); } else if (isErr(e)) { r = e; } else { throw e; }
          }
          row.push(r);
        }
        rows.push(row);
      }
      if (restart) { continue; }
      const nh = jh === 1 && resH > h ? resH : 0; const nw = jw === 1 && resW > w ? resW : 0;
      if ((nh || nw) && !growH && !growW) { growH = nh || h; growW = nw || w; continue; }
      const out = new ArrayVal(rows);
      if (rows.ep) { out.ep = rows.ep; }
      return out;
    }
    return fail(ERR.VALUE);
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
    let v = xpow(a, b);
    if (isNaN(v) && a < 0 && !Number.isInteger(b)) {
      // Calc takes the odd root of a negative number: POWER(-8;1/3) = -2.
      const inv = 1 / b;
      if (approxEqual(inv, Math.round(inv)) && Math.round(inv) % 2 !== 0) { v = -xpow(-a, b); } else { return fail(ERR.ARG); }
    }
    if (isNaN(v)) { return fail(ERR.ARG); }
    if (!isFinite(v)) { return fail(ERR.NUM); }
    return v;
  }
  /** The context of an array place: operators work element by element, functions iterate. */
  function arrCtx(ctx) {
    if (ctx.arr) { return ctx; }
    if (!ctx.arrView) { ctx.arrView = Object.assign({}, ctx, { arr: true }); ctx.arrView.arrView = ctx.arrView; }
    return ctx.arrView;
  }
  /** Evaluate for an array place (SUMPRODUCT, MMULT …): ranges and arrays stay whole, operators work element by element. */
  function evArray(n, ctx) {
    const c = arrCtx(ctx);
    const v = ev(n, c);
    return v instanceof RangeVal ? toArray(v, c) : v;
  }
  /** The rows above every sheet's last used row are empty: a whole column need not be walked to the bottom. */
  function usedRows(wb) { let m = 0; for (const sh of wb.sheets) { if (sh.maxR > m) { m = sh.maxR; } } return m; }
  function usedCols(wb) { let m = 0; for (const sh of wb.sheets) { if (sh.maxC > m) { m = sh.maxC; } } return m; }
  /** A range as an array of values. A huge range is cut to the used area of the workbook (the same for every sheet, so shapes still agree). */
  function toArray(rv, ctx) {
    if (!(rv instanceof RangeVal)) { return rv instanceof ArrayVal ? rv : new ArrayVal([[rv]]); }
    let r1 = rv.r1; let c1 = rv.c1;
    if ((r1 - rv.r0 + 1) * (c1 - rv.c0 + 1) > 65536) { r1 = Math.max(rv.r0, Math.min(r1, usedRows(ctx.wb))); c1 = Math.max(rv.c0, Math.min(c1, usedCols(ctx.wb))); }
    const rows = new Array(r1 - rv.r0 + 1);
    for (let r = rv.r0; r <= r1; r++) { const row = new Array(c1 - rv.c0 + 1); for (let c = rv.c0; c <= c1; c++) { row[c - rv.c0] = ctx.cellValue(rv.sheet, r, c); } rows[r - rv.r0] = row; }
    return new ArrayVal(rows);
  }
  const mapA = (a, f) => (a instanceof ArrayVal ? new ArrayVal(a.rows.map((row) => row.map((x) => safe(() => f(x))))) : safe(() => f(a)));
  function safe(f) { try { return f(); } catch (e) { if (isErr(e)) { return e; } throw e; } }
  /** Two arrays element by element, as Calc's operators: the smaller extent wins, a single row or column is repeated. */
  function zip(a, b, f) {
    const aa = a instanceof ArrayVal; const bb = b instanceof ArrayVal;
    if (!aa && !bb) { return f(a, b); }
    const ext = (x, y) => (x === 1 ? y : y === 1 ? x : Math.min(x, y));
    const h = aa && bb ? ext(a.h, b.h) : aa ? a.h : b.h;
    const w = aa && bb ? ext(a.w, b.w) : aa ? a.w : b.w;
    const rows = [];
    for (let r = 0; r < h; r++) { const row = []; for (let c = 0; c < w; c++) { row.push(safe(() => f(aa ? elemAt(a, r, c) : a, bb ? elemAt(b, r, c) : b))); } rows.push(row); }
    return new ArrayVal(rows);
  }

  /** The arguments of a function, read as the function needs them. */
  class Args {
    constructor(nodes, ctx) { this.nodes = nodes; this.ctx = ctx; this.L = ctx.L; }
    get n() { return this.nodes.length; }
    has(i) { return i < this.nodes.length && this.nodes[i].k !== 'empty'; }
    raw(i) { return ev(this.nodes[i], this.ctx); }
    val(i) { const v = ev(this.nodes[i], this.ctx); if (this.ctx.arr && isMulti(v)) { throw new Lift(this.nodes[i]); } return deref(v, this.ctx); }
    num(i, def) { if (!this.has(i)) { if (def !== undefined) { return def; } if (i < this.nodes.length) { return 0; } return fail(ERR.MISSING); } return toNum(this.val(i), this.L); }
    int(i, def) { const v = this.num(i, def); return Math.trunc(v); }
    str(i, def) { if (!this.has(i)) { if (def !== undefined) { return def; } if (i < this.nodes.length) { return ''; } return fail(ERR.MISSING); } return toText(this.val(i)); }
    bool(i, def) { if (!this.has(i)) { if (def !== undefined) { return def; } return false; } return toBool(this.val(i), this.L); }
    /** A reference argument (ranges for lookups, INDEX, ROWS …). */
    ref(i, code) { const v = this.raw(i); if (v instanceof RangeVal) { return v; } if (isErr(v)) { throw v; } return fail(code || ERR.PARAM); }
    arr(i) { return evArray(this.nodes[i], this.ctx); }
    /** An argument as a matrix (a range, an inline array or an expression worked out as an array): { h, w, rows }. */
    matrix(i) { if (!this.has(i)) { return fail(ERR.MISSING); } const v = this.arr(i); if (isErr(v)) { throw v; } return v instanceof ArrayVal ? v : new ArrayVal([[v]]); }
    /** Every value the arguments give: cells opened out (ref: true), inline values as typed (ref: false). */
    items(from, to) {
      const out = [];
      const end = to === undefined ? this.nodes.length : to;
      for (let i = from || 0; i < end; i++) {
        const node = this.nodes[i];
        if (node.k === 'empty') { out.push({ v: null, ref: false }); continue; }
        const v = ev(node, this.ctx);
        if (v instanceof RefList) { for (const x of v.areas) { eachCell(x, (r, c) => { out.push({ v: this.ctx.cellValue(x.sheet, r, c), ref: true }); }); } continue; }
        if (v instanceof RangeVal) { eachCell(v, (r, c) => { out.push({ v: this.ctx.cellValue(v.sheet, r, c), ref: true }); }); } else if (v instanceof ArrayVal) { v.rows.forEach((row) => row.forEach((x) => out.push({ v: x, ref: true }))); } else { out.push({ v, ref: false }); }
      }
      return out;
    }
    /** The numbers among the arguments: from cells only real numbers (and booleans); typed in, anything that reads as one. */
    numbers(from, to, strict) {
      // column by column and stopping at the first error, as Calc's SUM, MAX, AVERAGE … read a range:
      // a later cell (even the formula's own) is not read once an error is met
      const out = [];
      const end = to === undefined ? this.nodes.length : to;
      const ref = (v) => { if (isErr(v)) { throw v; } if (typeof v === 'number') { out.push(v); } else if (typeof v === 'boolean') { out.push(v ? 1 : 0); } };
      for (let i = from || 0; i < end; i++) {
        const node = this.nodes[i];
        if (node.k === 'empty') { out.push(0); continue; }
        const v = ev(node, this.ctx);
        if (v instanceof RefList) { for (const x of v.areas) { eachCellByColumn(x, (r, c) => ref(this.ctx.cellValue(x.sheet, r, c))); } continue; }
        if (v instanceof RangeVal) { eachCellByColumn(v, (r, c) => ref(this.ctx.cellValue(v.sheet, r, c))); continue; }
        if (v instanceof ArrayVal) { for (let c = 0; c < v.w; c++) { for (let r = 0; r < v.h; r++) { ref(v.rows[r][c]); } } continue; }
        if (isErr(v)) { throw v; }
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
  /** The numbers of a sum range (TRUE and FALSE are 1 and 0 there, as in Calc). */
  const numsOf = (vals) => { const out = []; for (const v of vals) { if (typeof v === 'number') { out.push(v); } else if (typeof v === 'boolean') { out.push(v ? 1 : 0); } } return out; };

  // math
  def('SUM', 0, -1, (A) => ksum(A.numbers()));
  def('PRODUCT', 1, -1, (A) => A.numbers().reduce((s, n) => s * n, 1));
  def('ABS', 1, 1, (A) => Math.abs(A.num(0)));
  def('SIGN', 1, 1, (A) => Math.sign(A.num(0)));
  def('SQRT', 1, 1, (A) => { const n = A.num(0); return n < 0 ? fail(ERR.ARG) : Math.sqrt(n); });
  def('POWER', 2, 2, (A) => power(A.num(0), A.num(1)));
  def('EXP', 1, 1, (A) => checkFinite(xexp(A.num(0))));
  def('LN', 1, 1, (A) => { const n = A.num(0); return n <= 0 ? fail(ERR.ARG) : xlog(n); });
  def('LOG10', 1, 1, (A) => { const n = A.num(0); return n <= 0 ? fail(ERR.ARG) : xlog10(n); });
  def('LOG', 1, 2, (A) => { const n = A.num(0); const b = A.has(1) ? A.num(1) : 10; if (n <= 0 || b <= 0 || b === 1) { return fail(ERR.ARG); } return b === 10 ? xlog10(n) : xlog(n) / xlog(b); });
  def('PI', 0, 0, () => Math.PI);
  def('INT', 1, 1, (A) => { const n = A.num(0); const r = Math.round(n); return approxEqual(n, r) ? r : Math.floor(n); });
  def('ROUND', 1, 2, (A) => roundHalfAway(A.num(0), A.has(1) ? intArg(A.num(1)) : 0));
  const roundDir = (n, d, up) => { const f = xpow(10, d); const sc = Math.abs(n) * f; const r = Math.round(sc); const v = approxEqual(sc, r) ? r : (up ? Math.ceil(sc) : Math.floor(sc)); return Math.sign(n) * v / f; };
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
  def('FACT', 1, 1, (A) => { const n = A.num(0); if (n < 0) { return fail(ERR.ARG); } return fakultaet(n); });
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
    // column by column, as Calc's matrices are kept (the first error met is the answer)
    for (let c = 0; c < w; c++) { for (let r = 0; r < h; r++) { let p = 1; for (const a of arrs) { const v = a.rows[r][c]; if (isErr(v)) { throw v; } p *= typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0; } k.add(p); } }
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
  def('COUNTA', 1, -1, (A) => {
    if (A.flags) { return A.items().filter(({ v }) => v != null).length; }
    // a formula cell counts without being worked out (Calc only looks whether a cell is empty)
    let n = 0;
    for (const node of A.nodes) {
      if (node.k === 'empty') { continue; }
      const v = ev(node, A.ctx);
      if (v instanceof RangeVal) { const sh = v.sheet; eachCell(v, (r, c) => { const x = sh.cells.get(r * MAXC + c); if (x && (x.f || x.of || x.t === 's' || x.t === 'n' || x.t === 'b' || x.t === 'e')) { n++; } }); } else if (v instanceof ArrayVal) { v.rows.forEach((row) => row.forEach((x) => { if (x != null) { n++; } })); } else if (v != null) { n++; }
    }
    return n;
  });
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
  def('IF', 1, 3, (A, ctx) => (A.bool(0) ? (A.n > 1 ? (A.has(1) ? A.raw(1) : 0) : true) : (A.n > 2 ? (A.has(2) ? A.raw(2) : 0) : (ctx.over ? EMPTY_PATH : false))));
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
    if (A.L.regex) {
      // a document set to regular expressions (Calc measured: SEARCH("p.";"apple") is 2)
      let re = null; try { re = new RegExp(what, 'isu'); } catch (e) { return fail(ERR.VALUE); }
      const mm = re.exec(hay.join(''));
      if (!mm) { return fail(ERR.VALUE); }
      return start + chars(hay.join('').slice(0, mm.index)).length;
    }
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
    // a code Calc refuses is Err:502 (TEXT(1234567;"#,.#,"))
    const out = (x, t) => { const r = formatInfo(x, t, code, A.L.id); return r.invalid ? fail(ERR.ARG) : r.text; };
    if (typeof v === 'string') { const p = parseInput(v, A.L.id); if (p.t !== 'n' && p.t !== 'b') { return out(v, 's'); } return out(p.v, p.t); }
    return out(v == null ? 0 : v, typeof v === 'boolean' ? 'b' : 'n');
  });
  def('VALUE', 1, 1, (A) => { const v = A.val(0); if (typeof v === 'number') { return v; } if (typeof v === 'boolean') { return v ? 1 : 0; } const p = parseInput(v == null ? '' : String(v), A.L.id); return p.t === 'n' ? p.v : p.t === 'b' ? (p.v ? 1 : 0) : fail(ERR.ARG); });
  def('FIXED', 1, 3, (A) => { const d = A.has(1) ? Math.trunc(A.num(1)) : 2; const noCommas = A.bool(2, false); const n = roundHalfAway(A.num(0), d); return format(n, 'n', (noCommas ? '0' : '#,##0') + (d > 0 ? '.' + '0'.repeat(d) : ''), A.L.id); });
  // two decimals unless told otherwise, and in Japanese the full-width yen sign (Calc ja-JP measured: DOLLAR(255) is ￥255.00, DOLLAR(-5) -￥5.00)
  def('DOLLAR', 1, 2, (A) => { const d = A.has(1) ? Math.trunc(A.num(1)) : 2; const n = roundHalfAway(A.num(0), d); const code = '"' + (A.L.id === 'ja' ? '￥' : A.L.currency) + '"#,##0' + (d > 0 ? '.' + '0'.repeat(d) : ''); return format(n, 'n', code, A.L.id); });
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
    const re = patternOf(s, L);
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
    if (rv instanceof ArrayVal) { if (byRow) { return rv.rows[index] ? rv.rows[index].slice() : []; } return rv.rows.map((row) => row[index]); }
    // past the sheet's last used row or column every cell is empty: a whole column need not be read
    if (byRow) { const c1 = Math.min(rv.c1, Math.max(rv.c0, rv.sheet.maxC)); for (let c = rv.c0; c <= c1; c++) { out.push(ctx.cellValue(rv.sheet, rv.r0 + index, c)); } } else { const r1 = Math.min(rv.r1, Math.max(rv.r0, rv.sheet.maxR)); for (let r = rv.r0; r <= r1; r++) { out.push(ctx.cellValue(rv.sheet, r, rv.c0 + index)); } }
    return out;
  }
  /** A lookup's search area: a reference stays one (the answer is a cell), anything else is worked out as an array (Calc's ReferenceOrForceArray). */
  function lookupArea(A, i) {
    const node = A.nodes[i];
    const v = node.k === 'ref' || node.k === 'fn' || node.k === 'name' ? A.raw(i) : evArray(node, A.ctx);
    if (v instanceof RangeVal || v instanceof ArrayVal) { return v; }
    if (isErr(v)) { throw v; }
    return new ArrayVal([[v]]);
  }
  const areaH = (a) => (a instanceof ArrayVal ? a.h : a.r1 - a.r0 + 1);
  const areaW = (a) => (a instanceof ArrayVal ? a.w : a.c1 - a.c0 + 1);
  /** The cell (r, c) of an area as a reference, or the element of an array. */
  const areaAt = (a, r, c) => (a instanceof ArrayVal ? (a.rows[r] && a.rows[r][c] !== undefined ? a.rows[r][c] : fail(ERR.REF)) : new RangeVal(a.sheet, a.r0 + r, a.c0 + c, a.r0 + r, a.c0 + c));
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
      // an equal entry is kept and the search goes on to the right: of several equal ones Calc answers
      // the last (measured: MATCH(2;{1;2;2;3};1) is 3, MATCH(2;{3;2;2;1};-1) is 3)
      if (c === 0 || (descending ? c > 0 : c < 0)) { best = idx[mid]; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }
  function exactFind(list, q, L) { const ok = lookupMatcher(q, L); for (let i = 0; i < list.length; i++) { if (ok(list[i])) { return i; } } return -1; }
  function hvlookup(A, ctx, byRow) {
    const q = A.val(0); const rng = lookupArea(A, 1); const idx = Math.trunc(A.num(2)); const sorted = A.has(3) ? A.bool(3) : true;
    const size = byRow ? areaH(rng) : areaW(rng);
    if (idx < 1 || idx > size) { return fail(ERR.ARG); }
    if (q == null) { return fail(ERR.NA); }
    const keys = vector(rng, ctx, byRow, 0);
    const pos = sorted ? approxFind(keys, q, ctx.L) : exactFind(keys, q, ctx.L);
    if (pos < 0) { return fail(ERR.NA); }
    const hit = byRow ? areaAt(rng, idx - 1, pos) : areaAt(rng, pos, idx - 1);
    // Calc answers the cell's value: text is text to the formula around it (SUM(VLOOKUP(…)) of text is #VALUE!)
    if (hit instanceof RangeVal) { const v = ctx.cellValue(hit.sheet, hit.r0, hit.c0); if (typeof v === 'string') { return v; } }
    return shownEmpty(hit);
  }
  /** A lookup's answer: an empty cell there shows empty, not 0 (Calc pushes an empty-cell token shown as ""). */
  function shownEmpty(x) { if (!(x instanceof RangeVal)) { return x; } const y = new RangeVal(x.sheet, x.r0, x.c0, x.r1, x.c1); y.showEmpty = true; return y; }
  def('VLOOKUP', 3, 4, (A, ctx) => hvlookup(A, ctx, false));
  def('HLOOKUP', 3, 4, (A, ctx) => hvlookup(A, ctx, true));
  def('LOOKUP', 2, 3, (A, ctx) => {
    const q = A.val(0); const rng = lookupArea(A, 1);
    const byRow = areaW(rng) - 1 > areaH(rng) - 1;
    const keys = vector(rng, ctx, byRow, 0);
    const pos = approxFind(keys, q, ctx.L);
    if (pos < 0) { return fail(ERR.NA); }
    if (A.has(2)) { const res = lookupArea(A, 2); const resByRow = areaW(res) - 1 > areaH(res) - 1; return shownEmpty(resByRow ? areaAt(res, 0, pos) : areaAt(res, pos, 0)); }
    return shownEmpty(byRow ? areaAt(rng, areaH(rng) - 1, pos) : areaAt(rng, pos, areaW(rng) - 1));
  });
  def('MATCH', 2, 3, (A, ctx) => {
    const q = A.val(0); const rng = lookupArea(A, 1); const type = A.has(2) ? A.num(2) : 1;
    if (areaH(rng) > 1 && areaW(rng) > 1) { return fail(ERR.PARAM); }
    const keys = vector(rng, ctx, areaW(rng) > 1, 0);
    const pos = type === 0 ? exactFind(keys, q, ctx.L) : approxFind(keys, q, ctx.L, type < 0);
    return pos < 0 ? fail(ERR.NA) : pos + 1;
  });
  /** XLOOKUP/XMATCH as Excel and Calc 24.8 define them (not in LibreOffice 24.2). */
  function xfind(A, ctx, qIdx, rngIdx, modeIdx, searchIdx) {
    const q = A.val(qIdx); const rng = lookupArea(A, rngIdx);
    const mode = A.has(modeIdx) ? Math.trunc(A.num(modeIdx)) : 0;
    const search = A.has(searchIdx) ? Math.trunc(A.num(searchIdx)) : 1;
    const byRow = areaW(rng) - 1 > areaH(rng) - 1;
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
    const res = lookupArea(A, 2); const lk = lookupArea(A, 1);
    const byRow = areaW(lk) - 1 > areaH(lk) - 1;
    if (res instanceof ArrayVal) { return byRow ? new ArrayVal(res.rows.map((row) => [row[pos]])) : new ArrayVal([res.rows[pos] ? res.rows[pos].slice() : []]); }
    return shownEmpty(byRow ? new RangeVal(res.sheet, res.r0, res.c0 + pos, res.r1, res.c0 + pos) : new RangeVal(res.sheet, res.r0 + pos, res.c0, res.r0 + pos, res.c1));
  });
  def('XMATCH', 2, 4, (A, ctx) => { const pos = xfind(A, ctx, 0, 1, 2, 3); return pos < 0 ? fail(ERR.NA) : pos + 1; });
  def('INDEX', 1, 4, (A) => {
    let base = A.raw(0);
    const area = A.has(3) ? Math.trunc(A.num(3)) : 1;
    if (base instanceof RefList) {
      // the area_num-th area of A1:B3~F2 (the first without one)
      if (area < 1 || area > base.areas.length) { return fail(ERR.REF); }
      base = base.areas[area - 1];
    } else if (area !== 1) { return fail(ERR.REF); }
    const row = A.has(1) ? Math.trunc(A.num(1)) : 0;
    const col = A.has(2) ? Math.trunc(A.num(2)) : 0;
    if (row < 0 || col < 0) { return fail(ERR.ARG); }
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
  const rowsOf = (A, ctx, fn) => { if (!A.n) { return fn(ctx.at.r, ctx.at.c); } const rv = A.ref(0, ERR.PARAM); if (rv.single) { return fn(rv.r0, rv.c0); } return new GenArray(rv.r1 - rv.r0 + 1, rv.c1 - rv.c0 + 1, (i, j) => fn(rv.r0 + i, rv.c0 + j)); };
  def('ROW', 0, 1, (A, ctx) => rowsOf(A, ctx, (r) => r + 1));
  def('COLUMN', 0, 1, (A, ctx) => rowsOf(A, ctx, (r, c) => c + 1));
  def('ROWS', 0, 1, (A) => { if (!A.n) { return 0; } const v = A.raw(0); if (v instanceof RefList) { return v.areas.reduce((n, x) => n + x.r1 - x.r0 + 1, 0); } if (v instanceof RangeVal) { return v.r1 - v.r0 + 1; } if (v instanceof ArrayVal) { return v.h; } return fail(ERR.PARAM); });
  def('COLUMNS', 0, 1, (A) => { if (!A.n) { return 0; } const v = A.raw(0); if (v instanceof RefList) { return v.areas.reduce((n, x) => n + x.c1 - x.c0 + 1, 0); } if (v instanceof RangeVal) { return v.c1 - v.c0 + 1; } if (v instanceof ArrayVal) { return v.w; } return fail(ERR.PARAM); });
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
  def('ISFORMULA', 1, 1, (A) => { const rv = cellOf(A, 0); if (!rv) { return false; } const cell = rv.sheet.cells.get(rv.r0 * MAXC + rv.c0); return !!(cell && (cell.f || cell.of)); });
  def('NA', 0, 0, () => fail(ERR.NA));
  def('TYPE', 1, 1, (A) => { if (A.nodes[0].k === 'array') { return 64; } const rv = catchErr(() => cellOf(A, 0), () => null); if (rv) { if (!rv.single) { return fail(ERR.VALUE); } const cell = rv.sheet.cells.get(rv.r0 * MAXC + rv.c0); if (cell && cell.f) { return 8; } } return catchErr(() => { const v = A.val(0); return typeof v === 'string' ? 2 : 1; }, () => 16); });

  // financial
  const pmtOf = (r, n, pv, fv, type) => (r === 0 ? -(pv + fv) / n : -(pv * xpow(1 + r, n) + fv) * r / ((1 + r * type) * (xpow(1 + r, n) - 1)));
  const fvOf = (r, n, pmt, pv, type) => (r === 0 ? -(pv + pmt * n) : -(pv * xpow(1 + r, n) + pmt * (1 + r * type) * (xpow(1 + r, n) - 1) / r));
  def('PMT', 3, 5, (A) => { const n = A.num(1); if (n === 0) { return fail(ERR.NUM); } return checkFinite(pmtOf(A.num(0), n, A.num(2), A.num(3, 0), A.num(4, 0) ? 1 : 0)); });
  def('FV', 3, 5, (A) => checkFinite(fvOf(A.num(0), A.num(1), A.num(2), A.num(3, 0), A.num(4, 0) ? 1 : 0)));
  def('PV', 3, 5, (A) => { const r = A.num(0); const n = A.num(1); const pmt = A.num(2); const fv = A.num(3, 0); const type = A.num(4, 0) ? 1 : 0; if (r === 0) { return -(fv + pmt * n); } return checkFinite(-(fv + pmt * (1 + r * type) * (xpow(1 + r, n) - 1) / r) / xpow(1 + r, n)); });
  def('NPV', 2, -1, (A) => { const r = A.num(0); const k = new KSum(); let i = 1; A.items(1).forEach(({ v }) => { if (typeof v === 'number') { k.add(v / xpow(1 + r, i)); i++; } else if (isErr(v)) { throw v; } }); return k.value; });
  def('IRR', 1, 2, (A) => {
    const vals = A.items(0, 1).map(({ v }) => v).filter((v) => typeof v === 'number');
    let x = A.has(1) ? A.num(1) : 0.1;
    for (let it = 0; it < 100; it++) {
      let f = 0; let df = 0;
      vals.forEach((v, i) => { f += v / xpow(1 + x, i); df -= i * v / xpow(1 + x, i + 1); });
      if (df === 0 || !isFinite(df)) { break; }
      const nx = x - f / df;
      if (!isFinite(nx)) { break; }
      if (Math.abs(nx - x) < 1e-12) { return nx; }
      x = nx;
    }
    return fail(ERR.CONV);
  });
  def('NPER', 3, 5, (A) => { const r = A.num(0); const pmt = A.num(1); const pv = A.num(2); const fv = A.num(3, 0); const type = A.num(4, 0) ? 1 : 0; if (r === 0) { return pmt === 0 ? fail(ERR.DIV0) : -(pv + fv) / pmt; } const a = pmt * (1 + r * type); const v = xlog((a - fv * r) / (a + pv * r)) / Math.log1p(r); return isFinite(v) ? v : fail(ERR.NUM); });
  def('RATE', 3, 6, (A) => {
    const n = A.num(0); const pmt = A.num(1); const pv = A.num(2); const fv = A.num(3, 0); const type = A.num(4, 0) ? 1 : 0;
    let x = A.has(5) ? A.num(5) : 0.1;
    if (n <= 0) { return fail(ERR.ARG); }
    const f = (r) => (r === 0 ? pv + pmt * n + fv : pv * xpow(1 + r, n) + pmt * (1 + r * type) * (xpow(1 + r, n) - 1) / r + fv);
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



  // ---- exp, log and pow rounded as glibc rounds them ----------------------
  // V8's Math.exp/log/pow (fdlibm) are off by one unit in the last place in
  // about one result in ten; glibc's, which LibreOffice uses, are (all but
  // never) correctly rounded. These work in double-double arithmetic (about
  // 100 bits) and round once at the end, so the digits agree with Calc's.

  const F64 = new Float64Array(1);
  const U32 = new Uint32Array(F64.buffer);
  let DDH = 0; let DDL = 0; // the result of the last dd operation
  const SPLITTER = 134217729; // 2^27 + 1
  function twoProd(a, b) {
    const p = a * b;
    let t = SPLITTER * a; const ah = t - (t - a); const al = a - ah;
    t = SPLITTER * b; const bh = t - (t - b); const bl = b - bh;
    DDH = p; DDL = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  }
  function ddAdd(ah, al, bh, bl) {
    const s = ah + bh; const v = s - ah;
    let e = (ah - (s - v)) + (bh - v);
    e += al + bl;
    DDH = s + e; DDL = e - (DDH - s);
  }
  function ddMul(ah, al, bh, bl) {
    twoProd(ah, bh);
    const p = DDH; let e = DDL;
    e += ah * bl + al * bh;
    DDH = p + e; DDL = e - (DDH - p);
  }
  function ddDiv(ah, al, bh, bl) {
    const q1 = ah / bh;
    ddMul(q1, 0, bh, bl); ddAdd(ah, al, -DDH, -DDL);
    const rh = DDH; const rl = DDL;
    const q2 = rh / bh;
    ddMul(q2, 0, bh, bl); ddAdd(rh, rl, -DDH, -DDL);
    const q3 = DDH / bh;
    ddAdd(q1, 0, q2, 0); ddAdd(DDH, DDL, q3, 0);
  }
  const LN2A = 0.6931471803691238; const LN2B = 1.9082149292705877e-10; const LN2C = 1.1612227229362532e-26;
  const LN2H = 0.6931471805599453; const LN2L = 2.3190468138462996e-17;
  const INV_LN2 = 1.4426950408889634;
  /** 1/n! as double-double, for the exponential series. */
  const FACT_INV = (() => { const out = []; let h = 1; let l = 0; for (let n = 0; n <= 12; n++) { if (n > 0) { ddDiv(h, l, n, 0); h = DDH; l = DDL; } out.push([h, l]); } return out; })();
  /** 1/(2n+1) as double-double, for the logarithm's series. */
  const ODD_INV = (() => { const out = []; for (let n = 0; n <= 24; n++) { const d = 2 * n + 1; const h = 1 / d; twoProd(h, d); out.push([h, (1 - DDH - DDL) / d]); } return out; })();
  function scale2(v, k) {
    if (k > 1023) { return v * Math.pow(2, 1023) * Math.pow(2, k - 1023); }
    if (k < -1022) { return v * Math.pow(2, -1022) * Math.pow(2, k + 1022); }
    return v * Math.pow(2, k);
  }
  /** exp(xh + xl), correctly rounded. */
  function expDD(xh, xl) {
    if (xh !== xh) { return NaN; }
    if (xh > 709.8) { return Infinity; }
    if (xh < -745.2) { return 0; }
    const k = Math.round(xh * INV_LN2);
    // r = x - k·ln2 in double-double (k·LN2A is exact)
    ddAdd(xh - k * LN2A, 0, xl, 0); let rh = DDH; let rl = DDL;
    twoProd(k, LN2B); ddAdd(rh, rl, -DDH, -DDL); rh = DDH; rl = DDL;
    ddAdd(rh, rl, -k * LN2C, 0); rh = DDH / 256; rl = DDL / 256;
    // Taylor series of exp(r/256), then squared eight times
    let ph = FACT_INV[12][0]; let pl = FACT_INV[12][1];
    for (let n = 11; n >= 0; n--) { ddMul(ph, pl, rh, rl); ddAdd(DDH, DDL, FACT_INV[n][0], FACT_INV[n][1]); ph = DDH; pl = DDL; }
    for (let i = 0; i < 8; i++) { ddMul(ph, pl, ph, pl); ph = DDH; pl = DDL; }
    return scale2(ph + pl, k);
  }
  /** log(x) for x > 0 as double-double (DDH, DDL). */
  function logDD(x) {
    let k = 0;
    if (x < 2.2250738585072014e-308) { x *= 18014398509481984; k = -54; }
    F64[0] = x;
    const e = ((U32[1] >>> 20) & 0x7ff) - 1023;
    U32[1] = (U32[1] & 0x800fffff) | 0x3ff00000;
    let m = F64[0]; k += e;
    if (m > 1.4142135623730951) { m /= 2; k += 1; }
    const num = m - 1;
    ddAdd(m, 0, 1, 0); ddDiv(num, 0, DDH, DDL);
    const sh = DDH; const sl = DDL;
    ddMul(sh, sl, sh, sl); const s2h = DDH; const s2l = DDL;
    let qh = ODD_INV[24][0]; let ql = ODD_INV[24][1];
    for (let n = 23; n >= 0; n--) { ddMul(qh, ql, s2h, s2l); ddAdd(DDH, DDL, ODD_INV[n][0], ODD_INV[n][1]); qh = DDH; ql = DDL; }
    ddMul(qh, ql, sh, sl); const lmh = DDH * 2; const lml = DDL * 2;
    twoProd(k, LN2H); const kh = DDH; const kl = DDL + k * LN2L;
    ddAdd(kh, kl, lmh, lml);
  }
  /** Math.exp, correctly rounded (as glibc). */
  function xexp(x) { if (!isFinite(x)) { return Math.exp(x); } return expDD(x, 0); }
  /** Math.log, correctly rounded (as glibc). */
  function xlog(x) { if (!(x > 0) || !isFinite(x)) { return Math.log(x); } if (x === 1) { return 0; } logDD(x); return DDH + DDL; }
  /** Math.log10 as glibc computes it (fdlibm's formula on top of the correctly rounded log). */
  function xlog10(x) {
    if (!(x > 0) || !isFinite(x)) { return Math.log10(x); }
    let k = 0;
    if (x < 2.2250738585072014e-308) { k -= 54; x *= 18014398509481984; }
    F64[0] = x;
    k += ((U32[1] >>> 20) & 0x7ff) - 1023;
    const i = k < 0 ? 1 : 0;
    U32[1] = (U32[1] & 0x000fffff) | ((0x3ff - i) << 20);
    const y = k + i;
    const z = y * 3.69423907715893078616e-13 + 4.34294481903251816668e-01 * xlog(F64[0]);
    return z + y * 3.01029995663611771306e-01;
  }
  /** Math.pow with C99's special cases, correctly rounded (as glibc). */
  function xpow(x, y) {
    if (y === 0 || x === 1) { return 1; }
    if (x !== x || y !== y) { return NaN; }
    if (!isFinite(x) || !isFinite(y) || x === 0) { if (x === -1) { return 1; } return Math.pow(x, y); }
    const yi = Number.isInteger(y);
    if (x < 0 && !yi) { return NaN; }
    const neg = x < 0 && yi && Math.abs(y) < 9007199254740992 && Math.abs(y) % 2 === 1;
    const ax = Math.abs(x);
    if (y === 0.5) { return Math.sqrt(x); }
    if (yi && Math.abs(y) <= 64) {
      let n = Math.abs(y); let bh = ax; let bl = 0; let rh = 1; let rl = 0; let ok = true;
      while (n > 0) { if (n & 1) { ddMul(rh, rl, bh, bl); rh = DDH; rl = DDL; } n >>= 1; if (n) { ddMul(bh, bl, bh, bl); bh = DDH; bl = DDL; } if (!isFinite(rh) || !isFinite(bh) || Math.abs(rh) > 1e300 || Math.abs(bh) > 1e300 || (rh !== 0 && Math.abs(rh) < 1e-290)) { ok = false; break; } }
      if (ok) { let v; if (y < 0) { ddDiv(1, 0, rh, rl); v = DDH + DDL; } else { v = rh + rl; } return neg ? -v : v; }
    }
    logDD(ax); const lh = DDH; const ll = DDL;
    twoProd(y, lh); const ph = DDH; const pl = DDL + y * ll;
    const v = ph > 709.8 ? Infinity : ph < -745.2 ? 0 : expDD(ph, pl);
    return neg ? -v : v;
  }

  // ---- Calc's numerical kernels -------------------------------------------
  // The special functions are the algorithms LibreOffice 24.2 uses (its
  // interpreter, rtl::math and glibc's erf/erfc), so a distribution gives the
  // digits Calc shows, not just a close number.

  const DBL_MIN = 2.2250738585072014e-308;
  const DBL_MAX = Number.MAX_VALUE;
  const EPS = 2.220446049250313e-16;
  const MAX_GAMMA_ARG = 171.624376956302;
  const LOG_DBL_MAX = xlog(DBL_MAX);
  const LOG_DBL_MIN = xlog(DBL_MIN);
  const N10 = (n) => Number('1e' + n);
  const isReprInt = (a) => a < 9007199254740992 && Math.trunc(a) === a;
  /** Number of binary digits after the point (rtl::math getBitsInFracPart). */
  function bitsInFrac(a) {
    if (a === 0) { return 0; }
    F64[0] = a;
    const lo = U32[0]; const hi = U32[1];
    const ex = ((hi >>> 20) & 0x7ff) - 1023;
    if (ex >= 52) { return 0; }
    const ffs = (n) => (n === 0 ? 0 : 31 - Math.clz32(n & -n) + 1);
    let least = ffs(lo);
    if (least === 0) { least = ffs(hi & 0xfffff); least = least === 0 ? 53 : least + 32; }
    return Math.max(53 - least - ex, 0);
  }
  /** rtl::math::approxValue: a number cut to 15 significant digits, so 0.1*3 is 0.3 before it is floored. */
  function approxValue(v) {
    if (v === 0 || !isFinite(v) || v > 2199023255552) { return v; }
    const neg = v < 0; let a = neg ? -v : v;
    if (isReprInt(a) || bitsInFrac(a) <= 11) { return v; }
    const ex = 14 - Math.floor(xlog10(a));
    const f = N10(Math.abs(ex));
    a = ex < 0 ? a / f : a * f;
    if (!isFinite(a)) { return v; }
    a = roundHalfUpAway(a);
    a = ex < 0 ? a * f : a / f;
    if (!isFinite(a)) { return v; }
    return neg ? -a : a;
  }
  /** std::round: half away from zero. */
  function roundHalfUpAway(a) { const r = Math.floor(a); return a - r >= 0.5 ? r + 1 : r; }
  const approxFloor = (x) => Math.floor(approxValue(x));
  const approxCeil = (x) => Math.ceil(approxValue(x));
  const stdRound = (x) => (x < 0 ? -roundHalfUpAway(-x) : roundHalfUpAway(x));
  /** rtl::math::round with its modes: 'corr' (half away), 'down', 'up', 'floor', 'ceil', 'even'. */
  function rtlRound(v, dec, mode) {
    if (!isFinite(v) || v === 0) { return v; }
    if (!dec && mode === 'corr') { return stdRound(v); }
    const neg = v < 0; let a = neg ? -v : v;
    if (dec >= 0 && (a >= 4503599627370496 || isReprInt(a))) { return v; }
    let fac = 0;
    if (dec) {
      if (dec > 0) { F64[0] = a; const nd = 52 - (((U32[1] >>> 20) & 0x7ff) - 1023); if (nd <= 0) { return v; } if (nd < dec) { dec = nd; } }
      fac = N10(Math.abs(dec));
      if (fac === 0 || (dec < 0 && !isFinite(fac))) { return 0; }
      if (!isFinite(fac)) { return v; }
      a = dec < 0 ? a / fac : a * fac;
      if (!isFinite(a)) { return v; }
    }
    if (a < 4503599627370496) {
      switch (mode) {
        case 'corr': a = approxFloor(a + 0.5); break;
        case 'down': a = approxFloor(a); break;
        case 'up': a = approxCeil(a); break;
        case 'floor': a = neg ? approxCeil(a) : approxFloor(a); break;
        case 'ceil': a = neg ? approxFloor(a) : approxCeil(a); break;
        case 'even': { const f = Math.floor(a); if (a - f !== 0.5) { a = Math.floor(a + 0.5); } else { a = (f / 2) === Math.floor(f / 2) ? f : f + 1; } break; }
        default: break;
      }
    }
    if (dec) { a = dec < 0 ? a * fac : a / fac; }
    if (!isFinite(a)) { return v; }
    return neg ? -a : a;
  }
  /** rtl::math::approxEqual (2^-48 relative, never between two different integers). */
  function lApproxEq(a, b) {
    if (a === b) { return true; }
    if (a === 0 || b === 0 || (a < 0) !== (b < 0)) { return false; }
    const d = Math.abs(a - b);
    if (!isFinite(d)) { return false; }
    a = Math.abs(a); b = Math.abs(b);
    if (d >= a * 3.552713678800501e-15 || d >= b * 3.552713678800501e-15) { return false; }
    return !(isReprInt(a) && isReprInt(b));
  }
  /** Calc's KahanSum (Neumaier summation with a delayed last term), so sums carry Calc's rounding. */
  class LSum {
    constructor(x) { this.s = x || 0; this.e = 0; this.m = 0; }
    static nm(o, x) { const t = o.s + x; if (Math.abs(o.s) >= Math.abs(x)) { o.e += (o.s - t) + x; } else { o.e += (x - t) + o.s; } o.s = t; }
    add(x) { if (x === 0) { return this; } if (!this.m) { this.m = x; return this; } LSum.nm(this, this.m); this.m = x; return this; }
    /** Another sum added as Calc adds one KahanSum to another on x86-64 (its SSE2 path). */
    addSum(o) { this.add(o.s + o.e); this.add(o.m); return this; }
    copy() { const c = new LSum(this.s); c.e = this.e; c.m = this.m; return c; }
    neg() { const c = new LSum(-this.s); c.e = -this.e; c.m = -this.m; return c; }
    get() {
      const total = this.s + this.e;
      if (!this.m) { return total; }
      if (((this.m < 0 && total > 0) || (total < 0 && this.m > 0)) && lApproxEq(this.m, -total)) { return 0; }
      LSum.nm(this, this.m); this.m = 0;
      return this.s + this.e;
    }
  }

  // erf and erfc as glibc 2.39 computes them (Sun's fdlibm, glibc's evaluation order).
  // Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved. Developed at
  // SunPro, a Sun Microsystems, Inc. business. Permission to use, copy, modify, and
  // distribute this software is freely granted, provided that this notice is preserved.
  const ERX = 8.45062911510467529297e-01; const EFX = 1.28379167095512586316e-01;
  const PP = [1.28379167095512558561e-01, -3.25042107247001499370e-01, -2.84817495755985104766e-02, -5.77027029648944159157e-03, -2.37630166566501626084e-05];
  const QQ = [1, 3.97917223959155352819e-01, 6.50222499887672944485e-02, 5.08130628187576562776e-03, 1.32494738004321644526e-04, -3.96022827877536812320e-06];
  const PA = [-2.36211856075265944077e-03, 4.14856118683748331666e-01, -3.72207876035701323847e-01, 3.18346619901161753674e-01, -1.10894694282396677476e-01, 3.54783043256182359371e-02, -2.16637559486879084300e-03];
  const QA = [1, 1.06420880400844228286e-01, 5.40397917702171048937e-01, 7.18286544141962662868e-02, 1.26171219808761642112e-01, 1.36370839120290507362e-02, 1.19844998467991074170e-02];
  const RA = [-9.86494403484714822705e-03, -6.93858572707181764372e-01, -1.05586262253232909814e+01, -6.23753324503260060396e+01, -1.62396669462573470355e+02, -1.84605092906711035994e+02, -8.12874355063065934246e+01, -9.81432934416914548592e+00];
  const SA = [1, 1.96512716674392571292e+01, 1.37657754143519042600e+02, 4.34565877475229228821e+02, 6.45387271733267880336e+02, 4.29008140027567833386e+02, 1.08635005541779435134e+02, 6.57024977031928170135e+00, -6.04244152148580987438e-02];
  const RB = [-9.86494292470009928597e-03, -7.99283237680523006574e-01, -1.77579549177547519889e+01, -1.60636384855821916062e+02, -6.37566443368389627722e+02, -1.02509513161107724954e+03, -4.83519191608651397019e+02];
  const SB = [1, 3.03380607434824582924e+01, 3.25792512996573918826e+02, 1.53672958608443695994e+03, 3.19985821950859553908e+03, 2.55305040643316442583e+03, 4.74528541206955367215e+02, -2.24409524465858183362e+01];
  const hiWord = (x) => { F64[0] = x; return U32[1] | 0; };
  const lowZero = (x) => { F64[0] = x; U32[0] = 0; return F64[0]; };
  function erfSmall(z) {
    const r1 = PP[0] + z * PP[1]; const z2 = z * z; const r2 = PP[2] + z * PP[3]; const z4 = z2 * z2;
    const s1 = 1 + z * QQ[1]; const s2 = QQ[2] + z * QQ[3]; const s3 = QQ[4] + z * QQ[5];
    return (r1 + z2 * r2 + z4 * PP[4]) / (s1 + z2 * s2 + z4 * s3);
  }
  function erfMid(s) {
    const P1 = PA[0] + s * PA[1]; const s2 = s * s; const Q1 = 1 + s * QA[1]; const s4 = s2 * s2;
    const P2 = PA[2] + s * PA[3]; const s6 = s4 * s2; const Q2 = QA[2] + s * QA[3];
    const P3 = PA[4] + s * PA[5]; const Q3 = QA[4] + s * QA[5];
    return [P1 + s2 * P2 + s4 * P3 + s6 * PA[6], Q1 + s2 * Q2 + s4 * Q3 + s6 * QA[6]];
  }
  function erfTail(x, ix, limit) {
    const s = 1 / (x * x);
    let R; let S;
    if (ix < limit) {
      const R1 = RA[0] + s * RA[1]; const s2 = s * s; const S1 = 1 + s * SA[1]; const s4 = s2 * s2;
      const R2 = RA[2] + s * RA[3]; const s6 = s4 * s2; const S2 = SA[2] + s * SA[3]; const s8 = s4 * s4;
      const R3 = RA[4] + s * RA[5]; const S3 = SA[4] + s * SA[5]; const R4 = RA[6] + s * RA[7]; const S4 = SA[6] + s * SA[7];
      R = R1 + s2 * R2 + s4 * R3 + s6 * R4; S = S1 + s2 * S2 + s4 * S3 + s6 * S4 + s8 * SA[8];
    } else {
      const R1 = RB[0] + s * RB[1]; const s2 = s * s; const S1 = 1 + s * SB[1]; const s4 = s2 * s2;
      const R2 = RB[2] + s * RB[3]; const s6 = s4 * s2; const S2 = SB[2] + s * SB[3];
      const R3 = RB[4] + s * RB[5]; const S3 = SB[4] + s * SB[5]; const S4 = SB[6] + s * SB[7];
      R = R1 + s2 * R2 + s4 * R3 + s6 * RB[6]; S = S1 + s2 * S2 + s4 * S3 + s6 * S4;
    }
    const z = lowZero(x);
    return xexp(-z * z - 0.5625) * xexp((z - x) * (z + x) + R / S);
  }
  function erf(x) {
    const hx = hiWord(x); const ix = hx & 0x7fffffff;
    if (isNaN(x)) { return x; }
    if (!isFinite(x)) { return x > 0 ? 1 : -1; }
    if (ix < 0x3feb0000) {
      if (ix < 0x3e300000) { return ix < 0x00800000 ? 0.0625 * (16 * x + (16 * EFX) * x) : x + EFX * x; }
      return x + x * erfSmall(x * x);
    }
    if (ix < 0x3ff40000) { const [P, Q] = erfMid(Math.abs(x) - 1); return hx >= 0 ? ERX + P / Q : -ERX - P / Q; }
    if (ix >= 0x40180000) { return hx >= 0 ? 1 - 1e-300 : 1e-300 - 1; }
    const ax = Math.abs(x);
    const r = erfTail(ax, ix, 0x4006DB6E);
    return hx >= 0 ? 1 - r / ax : r / ax - 1;
  }
  function erfc(x) {
    const hx = hiWord(x); const ix = hx & 0x7fffffff;
    if (isNaN(x)) { return x; }
    if (!isFinite(x)) { return x > 0 ? 0 : 2; }
    if (ix < 0x3feb0000) {
      if (ix < 0x3c700000) { return 1 - x; }
      const y = erfSmall(x * x);
      if (hx < 0x3fd00000) { return 1 - (x + x * y); }
      let r = x * y; r += (x - 0.5); return 0.5 - r;
    }
    if (ix < 0x3ff40000) { const [P, Q] = erfMid(Math.abs(x) - 1); if (hx >= 0) { return (1 - ERX) - P / Q; } return 1 + (ERX + P / Q); }
    if (ix < 0x403c0000) {
      const ax = Math.abs(x);
      if (ix >= 0x4006DB6D && hx < 0 && ix >= 0x40180000) { return 2 - 1e-300; }
      const r = erfTail(ax, ix, 0x4006DB6D);
      return hx > 0 ? r / ax : 2 - r / ax;
    }
    return hx > 0 ? 0 : 2;
  }

  // the normal distribution
  const phi = (x) => 0.39894228040143268 * xexp(-(x * x) / 2);
  const integralPhi = (x) => 0.5 * erfc(-x * Math.SQRT1_2);
  function taylor(p, x) { const k = new LSum(p[p.length - 1]); let v = k; for (let i = p.length - 2; i >= 0; i--) { v = new LSum(v.get() * x).add(p[i]); } return v.get(); }
  const GT0 = [0.39894228040143268, -0.06649038006690545, 0.00997355701003582, -0.00118732821548045, 0.00011543468761616, -0.00000944465625950, 0.00000066596935163, -0.00000004122667415, 0.00000000227352982, 0.00000000011301172, 0.00000000000511243, -0.00000000000021218];
  const GT2 = [0.47724986805182079, 0.05399096651318805, -0.05399096651318805, 0.02699548325659403, -0.00449924720943234, -0.00224962360471617, 0.00134977416282970, -0.00011783742691370, -0.00011515930357476, 0.00003704737285544, 0.00000282690796889, -0.00000354513195524, 0.00000037669563126, 0.00000019202407921, -0.00000005226908590, -0.00000000491799345, 0.00000000366377919, -0.00000000015981997, -0.00000000017381238, 0.00000000002624031, 0.00000000000560919, -0.00000000000172127, -0.00000000000008634, 0.00000000000007894];
  const GT4 = [0.49996832875816688, 0.00013383022576489, -0.00026766045152977, 0.00033457556441221, -0.00028996548915725, 0.00018178605666397, -0.00008252863922168, 0.00002551802519049, -0.00000391665839292, -0.00000074018205222, 0.00000064422023359, -0.00000017370155340, 0.00000000909595465, 0.00000000944943118, -0.00000000329957075, 0.00000000029492075, 0.00000000011874477, -0.00000000004420396, 0.00000000000361422, 0.00000000000143638, -0.00000000000045848];
  /** Calc's GAUSS: the standard normal integral from 0 to x. */
  function gauss(x) {
    const ax = Math.abs(x);
    const xs = Math.floor(approxValue(ax));
    let v;
    if (xs === 0) { v = taylor(GT0, ax * ax) * ax; } else if (xs <= 2) { v = taylor(GT2, ax - 2); } else if (xs <= 4) { v = taylor(GT4, ax - 4); } else { v = 0.5 + phi(ax) * taylor([-1, 1, -3, 15, -105], 1 / (ax * ax)) / ax; }
    return x < 0 ? -v : v;
  }
  /** The inverse of the standard normal distribution (Wichura's AS 241, as Calc). */
  function gaussinv(x) {
    const q = x - 0.5; let t; let z;
    if (Math.abs(q) <= 0.425) {
      t = 0.180625 - q * q;
      z = q * (((((((t * 2509.0809287301226727 + 33430.575583588128105) * t + 67265.770927008700853) * t + 45921.953931549871457) * t + 13731.693765509461125) * t + 1971.5909503065514427) * t + 133.14166789178437745) * t + 3.387132872796366608)
        / (((((((t * 5226.495278852854561 + 28729.085735721942674) * t + 39307.89580009271061) * t + 21213.794301586595867) * t + 5394.1960214247511077) * t + 687.1870074920579083) * t + 42.313330701600911252) * t + 1.0);
    } else {
      t = q > 0 ? 1 - x : x;
      t = Math.sqrt(-xlog(t));
      if (t <= 5.0) {
        t += -1.6;
        z = (((((((t * 7.7454501427834140764e-4 + 0.0227238449892691845833) * t + 0.24178072517745061177) * t + 1.27045825245236838258) * t + 3.64784832476320460504) * t + 5.7694972214606914055) * t + 4.6303378461565452959) * t + 1.42343711074968357734)
          / (((((((t * 1.05075007164441684324e-9 + 5.475938084995344946e-4) * t + 0.0151986665636164571966) * t + 0.14810397642748007459) * t + 0.68976733498510000455) * t + 1.6763848301838038494) * t + 2.05319162663775882187) * t + 1.0);
      } else {
        t += -5.0;
        z = (((((((t * 2.01033439929228813265e-7 + 2.71155556874348757815e-5) * t + 0.0012426609473880784386) * t + 0.026532189526576123093) * t + 0.29656057182850489123) * t + 1.7848265399172913358) * t + 5.4637849111641143699) * t + 6.6579046435011037772)
          / (((((((t * 2.04426310338993978564e-15 + 1.4215117583164458887e-7) * t + 1.8463183175100546818e-5) * t + 7.868691311456132591e-4) * t + 0.0148753612908506148525) * t + 0.13692988092273580531) * t + 0.59983220655588793769) * t + 1.0);
      }
      if (q < 0) { z = -z; }
    }
    return z;
  }

  // gamma and beta (the Lanczos sum Calc takes from Boost's lanczos13m53)
  const LNUM = [23531376880.41075968857200767445163675473, 42919803642.64909876895789904700198885093, 35711959237.35566804944018545154716670596, 17921034426.03720969991975575445893111267, 6039542586.35202800506429164430729792107, 1439720407.311721673663223072794912393972, 248874557.8620541565114603864132294232163, 31426415.58540019438061423162831820536287, 2876370.628935372441225409051620849613599, 186056.2653952234950402949897160456992822, 8071.672002365816210638002902272250613822, 210.8242777515793458725097339207133627117, 2.506628274631000270164908177133837338626];
  const LDEN = [0, 39916800, 120543840, 150917976, 105258076, 45995730, 13339535, 2637558, 357423, 32670, 1925, 66, 1];
  const LG = 6.024680040776729583740234375;
  function lanczosSum(z) {
    let n; let d;
    if (z <= 1) { n = LNUM[12]; d = LDEN[12]; for (let i = 11; i >= 0; i--) { n *= z; n += LNUM[i]; d *= z; d += LDEN[i]; } } else { const zi = 1 / z; n = LNUM[0]; d = LDEN[0]; for (let i = 1; i <= 12; i++) { n *= zi; n += LNUM[i]; d *= zi; d += LDEN[i]; } }
    return n / d;
  }
  function gammaHelper(z) {
    let g = lanczosSum(z);
    const zg = z + LG - 0.5;
    const half = xpow(zg, z / 2 - 0.25);
    g *= half; g /= xexp(zg); g *= half;
    if (z <= 20 && z === approxFloor(z)) { g = stdRound(g); }
    return g;
  }
  const logGammaHelper = (z) => { const zg = z + LG - 0.5; return xlog(lanczosSum(z)) + (z - 0.5) * xlog(zg) - zg; };
  const sinX = (d) => (Math.abs(d) <= 9223372036854775808 * 4 ? Math.sin(d) : NaN);
  /** Γ(z); #NUM! when it overflows. */
  function getGamma(z) {
    if (z > MAX_GAMMA_ARG) { return fail(ERR.NUM); }
    if (z >= 1) { return gammaHelper(z); }
    if (z >= 0.5) { return gammaHelper(z + 1) / z; }
    if (z >= -0.5) {
      if (logGammaHelper(z + 2) - Math.log1p(z) - xlog(Math.abs(z)) >= LOG_DBL_MAX) { return fail(ERR.NUM); }
      return gammaHelper(z + 2) / (z + 1) / z;
    }
    const logPi = xlog(Math.PI);
    const ldiv = logGammaHelper(1 - z) + xlog(Math.abs(sinX(Math.PI * z)));
    if (ldiv - logPi >= LOG_DBL_MAX) { return 0; }
    if (ldiv < 0 && logPi - ldiv > LOG_DBL_MAX) { return fail(ERR.NUM); }
    return xexp(logPi - ldiv) * (sinX(Math.PI * z) < 0 ? -1 : 1);
  }
  function getLogGamma(z) {
    if (z >= MAX_GAMMA_ARG) { return logGammaHelper(z); }
    if (z >= 1) { return xlog(gammaHelper(z)); }
    if (z >= 0.5) { return xlog(gammaHelper(z + 1) / z); }
    return logGammaHelper(z + 2) - Math.log1p(z) - xlog(z);
  }
  function getBeta(alpha, beta) {
    const a = alpha > beta ? alpha : beta; const b = alpha > beta ? beta : alpha;
    if (a + b < MAX_GAMMA_ARG) { return getGamma(a) / getGamma(a + b) * getGamma(b); }
    const gm = LG - 0.5;
    let lz = lanczosSum(a); lz /= lanczosSum(a + b); lz *= lanczosSum(b);
    const abgm = a + b + gm;
    lz *= Math.sqrt((abgm / (a + gm)) / (b + gm));
    const ta = b / (a + gm); const tb = a / (b + gm);
    return xexp(-a * Math.log1p(ta) - b * Math.log1p(tb) - gm) * lz;
  }
  function getLogBeta(alpha, beta) {
    const a = alpha > beta ? alpha : beta; const b = alpha > beta ? beta : alpha;
    const gm = LG - 0.5;
    let lz = lanczosSum(a); lz /= lanczosSum(a + b); lz *= lanczosSum(b);
    let llz = xlog(lz);
    const abgm = a + b + gm;
    llz += 0.5 * (xlog(abgm) - xlog(a + gm) - xlog(b + gm));
    const ta = b / (a + gm); const tb = a / (b + gm);
    return -a * Math.log1p(ta) - b * Math.log1p(tb) - gm + llz;
  }
  function betaPDF(x, a, b) {
    if (a === 1) {
      if (b === 1) { return 1; }
      if (b === 2) { return -2 * x + 2; }
      if (x === 1 && b < 1) { return fail(ERR.ARG); }
      if (x <= 0.01) { return b + b * Math.expm1((b - 1) * Math.log1p(-x)); }
      return b * xpow(0.5 - x + 0.5, b - 1);
    }
    if (b === 1) {
      if (a === 2) { return a * x; }
      if (x === 0 && a < 1) { return fail(ERR.ARG); }
      return a * xpow(x, a - 1);
    }
    if (x <= 0) { if (a < 1 && x === 0) { return fail(ERR.ARG); } return 0; }
    if (x >= 1) { if (b < 1 && x === 1) { return fail(ERR.ARG); } return 0; }
    const ly = x < 0.1 ? Math.log1p(-x) : xlog(0.5 - x + 0.5);
    const lx = xlog(x);
    const al = (a - 1) * lx; const bl = (b - 1) * ly; const lb = getLogBeta(a, b);
    if (al < LOG_DBL_MAX && al > LOG_DBL_MIN && bl < LOG_DBL_MAX && bl > LOG_DBL_MIN && lb < LOG_DBL_MAX && lb > LOG_DBL_MIN && al + bl < LOG_DBL_MAX && al + bl > LOG_DBL_MIN) { return xpow(x, a - 1) * xpow(0.5 - x + 0.5, b - 1) / getBeta(a, b); }
    return xexp(al + bl - lb);
  }
  function betaContFrac(x, a, b) {
    let a1 = 1; let b1 = 1; let b2 = 1 - (a + b) / (a + 1) * x; let a2; let fnorm; let cf;
    if (b2 === 0) { a2 = 0; fnorm = 1; cf = 1; } else { a2 = 1; fnorm = 1 / b2; cf = a2 * fnorm; }
    let cfnew = 1; let rm = 1; let done = false;
    do {
      const apl2m = a + 2 * rm;
      const d2m = rm * (b - rm) * x / ((apl2m - 1) * apl2m);
      const d2m1 = -(a + rm) * (a + b + rm) * x / (apl2m * (apl2m + 1));
      a1 = (a2 + d2m * a1) * fnorm; b1 = (b2 + d2m * b1) * fnorm;
      a2 = a1 + d2m1 * a2 * fnorm; b2 = b1 + d2m1 * b2 * fnorm;
      if (b2 !== 0) { fnorm = 1 / b2; cfnew = a2 * fnorm; done = Math.abs(cf - cfnew) < Math.abs(cf) * EPS; }
      cf = cfnew; rm += 1;
    } while (rm < 50000 && !done);
    return cf;
  }
  /** The regularized incomplete beta function I_x(a, b). */
  function betaDist(xin, alpha, beta) {
    if (xin <= 0) { return 0; }
    if (xin >= 1) { return 1; }
    if (beta === 1) { return xpow(xin, alpha); }
    if (alpha === 1) { return -Math.expm1(beta * Math.log1p(-xin)); }
    let y = (0.5 - xin) + 0.5; let lny = Math.log1p(-xin); let x = xin; let lnx = xlog(xin); let a = alpha; let b = beta;
    const reflect = xin > alpha / (alpha + beta);
    if (reflect) { a = beta; b = alpha; x = y; y = xin; lnx = lny; lny = xlog(xin); }
    let r = betaContFrac(x, a, b) / a;
    const p = a / (a + b); const q = b / (a + b);
    const t = a > 1 && b > 1 && p < 0.97 && q < 0.97 ? betaPDF(x, a, b) * x * y : xexp(a * lnx + b * lny - getLogBeta(a, b));
    r *= t;
    if (reflect) { r = 0.5 - r + 0.5; }
    return r > 1 ? 1 : r < 0 ? 0 : r;
  }
  function gammaContFraction(a, x) {
    const bigInv = EPS; const big = 1 / bigInv;
    let count = 0; let y = 1 - a; let denom = x + 2 - a; let pkm1 = x + 1; let pkm2 = 1; let qkm1 = denom * x; let qkm2 = x;
    let approx = pkm1 / qkm1; let done = false;
    do {
      count += 1; y += 1;
      const num = y * count; denom += 2;
      const pk = pkm1 * denom - pkm2 * num; const qk = qkm1 * denom - qkm2 * num;
      if (qk !== 0) { const r = pk / qk; done = Math.abs((approx - r) / r) <= EPS / 2; approx = r; }
      pkm2 = pkm1; pkm1 = pk; qkm2 = qkm1; qkm1 = qk;
      if (Math.abs(pk) > big) { pkm2 *= bigInv; pkm1 *= bigInv; qkm2 *= bigInv; qkm1 *= bigInv; }
    } while (!done && count < 10000);
    if (!done) { return fail(ERR.CONV); }
    return approx;
  }
  function gammaSeries(a, x) {
    let den = a; let term = 1 / a; let sum = term; let n = 1;
    do { den += 1; term = term * x / den; sum += term; n++; } while (term / sum > EPS / 2 && n <= 10000);
    if (n > 10000) { return fail(ERR.CONV); }
    return sum;
  }
  function lowRegIGamma(a, x) { const f = xexp(a * xlog(x) - x - getLogGamma(a)); return x > a + 1 ? 1 - f * gammaContFraction(a, x) : f * gammaSeries(a, x); }
  function upRegIGamma(a, x) { const f = xexp(a * xlog(x) - x - getLogGamma(a)); return x > a + 1 ? f * gammaContFraction(a, x) : 1 - f * gammaSeries(a, x); }
  function gammaPDF(x, alpha, lambda) {
    if (x < 0) { return 0; }
    if (x === 0) { if (alpha < 1) { return fail(ERR.DIV0); } return alpha === 1 ? 1 / lambda : 0; }
    const xr = x / lambda;
    if (xr > 1) {
      if (xlog(xr) * (alpha - 1) < LOG_DBL_MAX && alpha < MAX_GAMMA_ARG) { return xpow(xr, alpha - 1) * xexp(-xr) / lambda / getGamma(alpha); }
      return xexp((alpha - 1) * xlog(xr) - xr - xlog(lambda) - getLogGamma(alpha));
    }
    if (alpha < MAX_GAMMA_ARG) { return xpow(xr, alpha - 1) * xexp(-xr) / lambda / getGamma(alpha); }
    return xpow(xr, alpha - 1) * xexp(-xr) / lambda / xexp(getLogGamma(alpha));
  }
  const gammaDist = (x, alpha, lambda) => (x <= 0 ? 0 : lowRegIGamma(alpha, x / lambda));
  const fDist = (x, f1, f2) => betaDist(f2 / (f2 + f1 * x), f2 / 2, f1 / 2);
  function tDist(t, df, type) {
    switch (type) {
      case 1: return 0.5 * betaDist(df / (df + t * t), df / 2, 0.5);
      case 2: return betaDist(df / (df + t * t), df / 2, 0.5);
      case 3: return xpow(1 + (t * t / df), -(df + 1) / 2) / (Math.sqrt(df) * getBeta(0.5, df / 2));
      case 4: { const X = df / (t * t + df); const R = 0.5 * betaDist(X, 0.5 * df, 0.5); return t < 0 ? R : 1 - R; }
      default: return fail(ERR.ARG);
    }
  }
  const chiDist = (x, df) => (x <= 0 ? 1 : upRegIGamma(df / 2, x / 2));
  const chiSqCDF = (x, df) => (x <= 0 ? 0 : lowRegIGamma(df / 2, x / 2));
  function chiSqPDF(x, df) {
    if (x <= 0) { return 0; }
    if (df * x > 1391000) { return xexp((0.5 * df - 1) * xlog(x * 0.5) - 0.5 * x - xlog(2) - getLogGamma(0.5 * df)); }
    let v; let c;
    if (df % 2 < 0.5) { v = 0.5; c = 2; } else { v = 1 / Math.sqrt(x * 2 * Math.PI); c = 1; }
    while (c < df) { v *= (x / c); c += 2; }
    if (x >= 1425) { v = xexp(xlog(v) - x / 2); } else { v *= xexp(-x / 2); }
    return v;
  }
  /** Calc's lcl_IterateInverse: bracket, then inverse quadratic interpolation; null when it does not converge. */
  function iterateInverse(fn, ax, bx) {
    const yEps = 1e-307;
    let kax = new LSum(ax); let kbx = new LSum(bx);
    let ay = fn(ax); let by = fn(bx);
    const sign = (u, w) => (u < 0 && w > 0) || (u > 0 && w < 0);
    for (let n = 0; n < 1000 && !sign(ay, by); n++) {
      if (Math.abs(ay) <= Math.abs(by)) {
        const tmp = kax.get();
        const nx = new LSum(tmp); nx.add((tmp - kbx.get()) * 2);
        kax = nx.get() < 0 ? new LSum(0) : nx;
        kbx = new LSum(tmp); by = ay; ay = fn(kax.get());
      } else {
        const tmp = kbx.get();
        const nx = new LSum(tmp); nx.add((tmp - kax.get()) * 2);
        kbx = nx; kax = new LSum(tmp); ay = by; by = fn(kbx.get());
      }
    }
    ax = kax.get(); bx = kbx.get();
    if (ay === 0) { return ax; }
    if (by === 0) { return bx; }
    if (!sign(ay, by)) { return null; }
    let px = ax; let py = ay; let qx = bx; let qy = by; let rx = ax; let ry = ay; let sx = 0.5 * (ax + bx);
    let interp = true; let n = 0;
    while (n < 500 && Math.abs(ry) > yEps && (bx - ax) > Math.max(Math.abs(ax), Math.abs(bx)) * EPS) {
      if (interp) {
        if (py !== qy && qy !== ry && ry !== py) {
          sx = px * ry * qy / (ry - py) / (qy - py) + rx * qy * py / (qy - ry) / (py - ry) + qx * py * ry / (py - qy) / (ry - qy);
          interp = ax < sx && sx < bx;
        } else { interp = false; }
      }
      if (!interp) { sx = 0.5 * (ax + bx); qx = bx; qy = by; interp = true; }
      px = qx; qx = rx; rx = sx; py = qy; qy = ry; ry = fn(sx);
      if (sign(ay, ry)) { bx = rx; by = ry; } else { ax = rx; ay = ry; }
      interp = interp && (Math.abs(ry) * 2 <= Math.abs(qy));
      ++n;
    }
    return rx;
  }
  const inverse = (fn, a, b) => { const v = iterateInverse(fn, a, b); return v === null ? fail(ERR.CONV) : v; };
  /** Calc's Fakultaet: n! for 0 ≤ n ≤ 170. */
  function fakultaet(x) {
    x = approxFloor(x);
    if (x < 0) { return 0; }
    if (x === 0) { return 1; }
    if (x <= 170) { let t = x; while (t > 2) { t--; x *= t; } return x; }
    return fail(ERR.VALUE);
  }
  function binomKoeff(n, k) {
    k = approxFloor(k);
    if (n < k) { return 0; }
    if (k === 0) { return 1; }
    let v = n / k; n--; k--;
    while (k > 0) { v *= n / k; k--; n--; }
    return v;
  }
  function binomPMF(x, n, p) {
    const q = (0.5 - p) + 0.5;
    let f = xpow(q, n);
    if (f <= DBL_MIN) {
      f = xpow(p, n);
      if (f <= DBL_MIN) { return betaPDF(p, x + 1, n - x + 1) / (n + 1); }
      const max = Math.trunc(n - x); for (let i = 0; i < max && f > 0; i++) { f *= (n - i) / (i + 1) * q / p; }
      return f;
    }
    const max = Math.trunc(x); for (let i = 0; i < max && f > 0; i++) { f *= (n - i) / (i + 1) * p / q; }
    return f;
  }
  function binomRange(n, xs, xe, f, p, q) {
    const nxs = Math.trunc(xs); let i;
    for (i = 1; i <= nxs && f > 0; i++) { f *= (n - i + 1) / i * p / q; }
    const sum = new LSum(f);
    const nxe = Math.trunc(xe);
    for (i = nxs + 1; i <= nxe && f > 0; i++) { f *= (n - i + 1) / i * p / q; sum.add(f); }
    return Math.min(sum.get(), 1);
  }
  /** One value of the hypergeometric distribution by Calc's cancelling of the nine factorials (#i47296#). */
  function hypGeom(x, n, M, N) {
    const num = []; const den = [];
    const put = (arr, lo, hi, base) => { for (let i = lo; i <= hi; ++i) { const v = base - i; if (v > 1) { arr.push(v); } } };
    if (x + Math.min(n, M) > 500000) { return fail(ERR.VALUE); }
    let cNumVarUpper = N - n - M + x - 1; let cDenomVarLower = 1;
    if (N - n - M + x >= M - x + 1) { cNumVarUpper = M - x - 1; cDenomVarLower = N - n - 2 * (M - x) + 1; }
    let cDenomUpper = N - n - M + x + 1 - cDenomVarLower;
    let dNumVarLower = n - M;
    if (n >= M + 1) {
      if (N - M < n + 1) {
        if (N - n < n + 1) { put(num, 0, cNumVarUpper, N - n); put(den, 0, N - n - 1, N); } else { put(num, N - 2 * n, cNumVarUpper, N - n); put(den, 0, n - 1, N); }
        if (cDenomUpper < n - x + 1) { put(num, 1, N - M - n + x, N - M + 1); } else { put(num, 1, N - M - cDenomUpper, N - M + 1); cDenomUpper = n - x; cDenomVarLower = N - M - 2 * (n - x) + 1; }
      } else {
        if (n > M - 1) { put(num, 0, cNumVarUpper, N - n); put(den, 0, M - 1, N); } else { put(num, M - n, cNumVarUpper, N - n); put(den, 0, n - 1, N); }
        if (cDenomUpper < n - x + 1) { put(num, N - M - n + 1, N - M - n + x, N - M + 1); } else { put(num, N - M - n + 1, N - M - cDenomUpper, N - M + 1); cDenomUpper = n - x; cDenomVarLower = N - M - 2 * (n - x) + 1; }
      }
    } else {
      if (N - M < M + 1) {
        if (N - n < M + 1) { put(num, 0, cNumVarUpper, N - n); put(den, 0, N - M - 1, N); } else { put(num, N - n - M, cNumVarUpper, N - n); put(den, 0, n - 1, N); }
        if (n - x + 1 > cDenomUpper) { put(num, 1, N - M - n + x, N - M + 1); } else { put(num, 1, N - M - cDenomUpper, N - M + 1); cDenomVarLower = N - M - 2 * (n - x) + 1; cDenomUpper = n - x; }
      } else {
        if (N - n < N - M + 1) { put(num, 0, cNumVarUpper, N - n); put(den, 0, M - 1, N); } else { put(num, M - n, cNumVarUpper, N - n); put(den, 0, n - 1, N); }
        if (n - x + 1 > cDenomUpper) { put(num, N - 2 * M + 1, N - M - n + x, N - M + 1); } else if (M >= cDenomUpper) { put(num, N - 2 * M + 1, N - M - cDenomUpper, N - M + 1); cDenomUpper = n - x; cDenomVarLower = N - M - 2 * (n - x) + 1; } else { put(den, cDenomVarLower, N - n - 2 * M + x, N - n - M + x + 1); cDenomUpper = n - x; cDenomVarLower = N - M - 2 * (n - x) + 1; }
      }
      dNumVarLower = 0;
    }
    const dNumVarUpper = cDenomUpper < x + 1 ? n - x - 1 : n - cDenomUpper - 1;
    const dDenomVarLower = cDenomUpper < x + 1 ? cDenomVarLower : N - n - M + 1;
    put(num, dNumVarLower, dNumVarUpper, n);
    put(den, dDenomVarLower, N - n - M + x, N - n - M + x + 1);
    num.sort((a, b) => a - b); den.sort((a, b) => a - b);
    let i1 = num.length - 1; let i2 = den.length - 1; let f = 1;
    while (i1 >= 0 || i2 >= 0) { const e = i1 >= 0 ? num[i1--] : 1; const d = i2 >= 0 ? den[i2--] : 1; f *= e / d; }
    return f;
  }

  // ---- the wider function set (LibreOffice 24.2's categories) -------------
  // Each function follows the routine Calc runs for it (named in the comment
  // where the name differs), with the same argument checks and error codes.

  let GRP = 'Statistical';
  const MORE = [];
  /** Define a function and its line for the function list: fx(name, min, max, 'arg; arg', 'What it does.', impl). */
  function fx(name, min, max, syntax, about, f) { def(name, min, max, f); MORE.push([name, GRP, name + '(' + syntax + ')', about]); }
  /** The same implementation under another name (Excel 2010 names, legacy names). */
  function alias(name, of, about) { FN[name] = FN[of]; ARITY[name] = ARITY[of]; MORE.push([name, GRP, '@' + of, about || '']); }
  const isNumLike = (v) => typeof v === 'number' || typeof v === 'boolean';
  const numOf = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
  /** The numbers of the arguments as Calc's GetNumberSequenceArray reads them (typed text is Err:504). */
  const seqOf = (A, from, to) => A.numbers(from, to, true);
  /** Values for VAR, STDEV, DEVSQ and their A forms (Calc's GetStVarParams): text in cells is 0 for the A forms. */
  function stValues(A, textAsZero) {
    const vals = [];
    for (let i = 0; i < A.n; i++) {
      const node = A.nodes[i];
      if (node.k === 'empty') { vals.push(0); continue; }
      const v = ev(node, A.ctx);
      if (v instanceof RangeVal || v instanceof ArrayVal) {
        const isArr = v instanceof ArrayVal;
        new Args([node], A.ctx).items().forEach(({ v: x }) => {
          if (isErr(x)) { throw x; }
          if (isNumLike(x)) { vals.push(numOf(x)); } else if (textAsZero && (typeof x === 'string' || (isArr && x == null))) { vals.push(0); }
        });
        continue;
      }
      if (isErr(v)) { throw v; }
      if (typeof v === 'string') { if (textAsZero) { vals.push(0); continue; } return fail(ERR.PARAM); }
      vals.push(v == null ? 0 : toNum(v, A.L));
    }
    return vals;
  }
  /** Σ(x − mean)² as Calc sums it (plain sum of approxSub squares, mean from a Kahan sum). */
  function devSq(vals) {
    const s = new LSum(); vals.forEach((x) => s.add(x));
    const mean = s.get() / vals.length;
    let v = 0;
    for (const x of vals) { const d = approxSub(x, mean); v += d * d; }
    return v;
  }
  const varOf = (vals, sample) => { const n = vals.length; if (sample ? n <= 1 : n === 0) { return fail(ERR.DIV0); } return devSq(vals) / (sample ? n - 1 : n); };
  /** Values of the "A" forms of MIN/MAX/AVERAGE: text in cells and typed text count as 0. */
  function aValues(A) {
    const out = [];
    for (const it of A.items()) {
      const v = it.v;
      if (isErr(v)) { throw v; }
      if (isNumLike(v)) { out.push(numOf(v)); continue; }
      if (typeof v === 'string') { out.push(0); continue; }
      if (v == null && !it.ref) { out.push(0); }
    }
    return out;
  }
  /** Two matrices of the same shape, taken where both hold numbers (Calc's pair loops run column by column). */
  function pairsOf(A, i, j) {
    const X = A.matrix(i); const Y = A.matrix(j);
    if (X.h !== Y.h || X.w !== Y.w) { return fail(ERR.ARG); }
    const xs = []; const ys = [];
    for (let c = 0; c < X.w; c++) {
      for (let r = 0; r < X.h; r++) {
        const x = X.rows[r][c]; const y = Y.rows[r][c];
        if (x == null || y == null || typeof x === 'string' || typeof y === 'string') { continue; }
        if (isErr(x)) { throw x; }
        if (isErr(y)) { throw y; }
        xs.push(numOf(x)); ys.push(numOf(y));
      }
    }
    return { xs, ys };
  }
  /** The numbers of one matrix argument, column by column (strings and empty skipped). */
  function matNums(M) {
    const out = [];
    for (let c = 0; c < M.w; c++) { for (let r = 0; r < M.h; r++) { const x = M.rows[r][c]; if (x == null || typeof x === 'string') { continue; } if (isErr(x)) { throw x; } out.push(numOf(x)); } }
    return out;
  }
  const mean = (a) => { const s = new LSum(); a.forEach((x) => s.add(x)); return s.get() / a.length; };
  /** The same arguments worked out in an array place (Calc's ForceArray parameters: FREQUENCY, MODE, AGGREGATE's data …). */
  const forceArray = (A) => new Args(A.nodes, arrCtx(A.ctx));

  // descriptive statistics
  fx('AVERAGEA', 1, -1, 'value 1; value 2; …', 'The average, text counting as 0.', (A) => { const v = aValues(A); if (!v.length) { return fail(ERR.DIV0); } const s = new LSum(); v.forEach((x) => s.add(x)); return s.get() / v.length; });
  fx('MAXA', 1, -1, 'value 1; value 2; …', 'The largest value, text counting as 0.', (A) => { const v = aValues(A); return v.length ? Math.max(...v) : 0; });
  fx('MINA', 1, -1, 'value 1; value 2; …', 'The smallest value, text counting as 0.', (A) => { const v = aValues(A); return v.length ? Math.min(...v) : 0; });
  fx('VARA', 1, -1, 'value 1; value 2; …', 'The variance of a sample, text counting as 0.', (A) => varOf(stValues(A, true), true));
  fx('VARPA', 1, -1, 'value 1; value 2; …', 'The variance of a population, text counting as 0.', (A) => varOf(stValues(A, true), false));
  fx('STDEVA', 1, -1, 'value 1; value 2; …', 'The standard deviation of a sample, text counting as 0.', (A) => Math.sqrt(varOf(stValues(A, true), true)));
  fx('STDEVPA', 1, -1, 'value 1; value 2; …', 'The standard deviation of a population, text counting as 0.', (A) => Math.sqrt(varOf(stValues(A, true), false)));
  alias('VAR.S', 'VAR', 'The variance of a sample.');
  alias('VAR.P', 'VARP', 'The variance of a population.');
  alias('STDEV.S', 'STDEV', 'The standard deviation of a sample.');
  alias('STDEV.P', 'STDEVP', 'The standard deviation of a population.');
  fx('DEVSQ', 1, -1, 'number 1; number 2; …', 'The sum of squared deviations from the mean.', (A) => { const v = stValues(A, false); if (!v.length) { return fail(ERR.DIV0); } return devSq(v); });
  fx('AVEDEV', 1, -1, 'number 1; number 2; …', 'The average of the absolute deviations from the mean.', (A) => { const v = seqOf(A); const m = mean(v); const s = new LSum(); v.forEach((x) => s.add(Math.abs(x - m))); return s.get() / v.length; });
  fx('GEOMEAN', 1, -1, 'number 1; number 2; …', 'The geometric mean.', (A) => { const v = seqOf(A); const s = new LSum(); for (const x of v) { if (x === 0) { return 0; } if (x < 0) { return fail(ERR.ARG); } s.add(xlog(x)); } return xexp(s.get() / v.length); });
  fx('HARMEAN', 1, -1, 'number 1; number 2; …', 'The harmonic mean.', (A) => { const v = seqOf(A); const s = new LSum(); for (const x of v) { if (x <= 0) { return fail(ERR.ARG); } s.add(1 / x); } return v.length / s.get(); });
  function skewParts(A) { const v = seqOf(A); const s = new LSum(); v.forEach((x) => s.add(x)); return { v, n: v.length, m: s.get() / v.length }; }
  function skew(A, p) {
    const { v, n, m } = skewParts(A);
    if (n < 3) { return fail(ERR.DIV0); }
    const vs = new LSum(); v.forEach((x) => vs.add((x - m) * (x - m)));
    const sd = Math.sqrt(vs.get() / (p ? n : n - 1));
    if (sd === 0) { return fail(ERR.ARG); }
    const c = new LSum(); v.forEach((x) => { const d = (x - m) / sd; c.add(d * d * d); });
    return p ? c.get() / n : ((c.get() * n) / (n - 1)) / (n - 2);
  }
  fx('SKEW', 1, -1, 'number 1; number 2; …', 'The skewness of a sample.', (A) => skew(A, false));
  fx('SKEWP', 1, -1, 'number 1; number 2; …', 'The skewness of a population.', (A) => skew(A, true));
  fx('KURT', 1, -1, 'number 1; number 2; …', 'The kurtosis.', (A) => {
    const { v, n, m } = skewParts(A);
    if (n < 4) { return fail(ERR.DIV0); }
    const vs = new LSum(); v.forEach((x) => vs.add((x - m) * (x - m)));
    const sd = Math.sqrt(vs.get() / (n - 1));
    if (sd === 0) { return fail(ERR.DIV0); }
    const p4 = new LSum(); v.forEach((x) => { const d = (x - m) / sd; p4.add((d * d) * (d * d)); });
    const kd = (n - 2) * (n - 3); const kl = n * (n + 1) / ((n - 1) * kd); const kt = 3 * (n - 1) * (n - 1) / kd;
    return p4.get() * kl - kt;
  });
  fx('STANDARDIZE', 3, 3, 'x; mean; standard deviation', 'A value as a number of standard deviations from the mean.', (A) => { const x = A.num(0); const m = A.num(1); const s = A.num(2); if (s < 0) { return fail(ERR.ARG); } if (s === 0) { return fail(ERR.DIV0); } return (x - m) / s; });
  fx('FISHER', 1, 1, 'number', 'The Fisher transformation.', (A) => { const x = A.num(0); if (Math.abs(x) >= 1) { return fail(ERR.ARG); } return Math.atanh(x); });
  fx('FISHERINV', 1, 1, 'number', 'The inverse of the Fisher transformation.', (A) => Math.tanh(A.num(0)));
  function percentile(v, p) {
    const n = v.length;
    if (n === 1) { return v[0]; }
    v.sort((a, b) => a - b);
    const idx = approxFloor(p * (n - 1)); const diff = p * (n - 1) - approxFloor(p * (n - 1));
    if (diff <= 0) { return v[idx]; }
    return v[idx] + diff * (v[idx + 1] - v[idx]);
  }
  function percentileExc(v, p) {
    const n1 = v.length + 1;
    if (!v.length) { return fail(ERR.VALUE); }
    if (p * n1 < 1 || p * n1 > n1 - 1) { return fail(ERR.PARAM); }
    v.sort((a, b) => a - b);
    const idx = approxFloor(p * n1 - 1); const diff = p * n1 - 1 - approxFloor(p * n1 - 1);
    if (diff === 0) { return v[idx]; }
    return v[idx] + diff * (v[idx + 1] - v[idx]);
  }
  const medianOf = (v) => { const s = v.slice().sort((a, b) => a - b); const h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h] + s[h - 1]) / 2; };
  const pctFn = (inc) => (A) => { const p = A.num(1); if (inc ? p < 0 || p > 1 : p <= 0 || p >= 1) { return fail(ERR.ARG); } const v = seqOf(A, 0, 1); if (!v.length) { return fail(ERR.VALUE); } return inc ? percentile(v, p) : percentileExc(v, p); };
  const qrtFn = (inc) => (A) => { const q = approxFloor(A.num(1)); if (inc ? q < 0 || q > 4 : q <= 0 || q >= 4) { return fail(ERR.ARG); } const v = seqOf(A, 0, 1); if (!v.length) { return fail(ERR.VALUE); } if (q === 2) { return medianOf(v); } return inc ? percentile(v, 0.25 * q) : percentileExc(v, 0.25 * q); };
  fx('PERCENTILE', 2, 2, 'data; alpha', 'The value below which a fraction of the data lies.', pctFn(true));
  alias('PERCENTILE.INC', 'PERCENTILE');
  fx('PERCENTILE.EXC', 2, 2, 'data; alpha', 'The percentile, 0 and 1 excluded.', pctFn(false));
  fx('QUARTILE', 2, 2, 'data; type', 'The quartile of the data (0 to 4).', qrtFn(true));
  alias('QUARTILE.INC', 'QUARTILE');
  fx('QUARTILE.EXC', 2, 2, 'data; type', 'The quartile, 0 and 4 excluded.', qrtFn(false));
  function pctRank(v, x, inc) {
    const n = v.length;
    if (x === v[0]) { return inc ? 0 : 1 / (n + 1); }
    let old = 0; let oldVal = v[0]; let i;
    for (i = 1; i < n && v[i] < x; i++) { if (v[i] !== oldVal) { old = i; oldVal = v[i]; } }
    if (v[i] !== oldVal) { old = i; }
    if (x === v[i]) { return inc ? old / (n - 1) : (i + 1) / (n + 1); }
    if (old === 0) { return 0; }
    const fr = (x - v[old - 1]) / (v[old] - v[old - 1]);
    return inc ? (old - 1 + fr) / (n - 1) : (old + fr) / (n + 1);
  }
  const prankFn = (inc) => (A) => {
    const sig = A.n >= 3 ? approxFloor(A.num(2)) : 3;
    if (sig < 1) { return fail(ERR.ARG); }
    const x = A.num(1);
    const v = seqOf(A, 0, 1).sort((a, b) => a - b);
    if (!v.length) { return fail(ERR.VALUE); }
    if (x < v[0] || x > v[v.length - 1]) { return fail(ERR.VALUE); }
    let r = v.length === 1 ? 1 : pctRank(v, x, inc);
    if (r !== 0) { const e = approxFloor(xlog10(r)) + 1 - sig; r = stdRound(r * xpow(10, -e)) / xpow(10, -e); }
    return r;
  };
  fx('PERCENTRANK', 2, 3, 'data; value; significance', 'The rank of a value as a percentage of the data.', prankFn(true));
  alias('PERCENTRANK.INC', 'PERCENTRANK');
  fx('PERCENTRANK.EXC', 2, 3, 'data; value; significance', 'The percentage rank, 0 and 1 excluded.', prankFn(false));
  function rankFn(avg) {
    return (A) => {
      const asc = A.n >= 3 ? A.bool(2) : false;
      const v = seqOf(A, 1, 2).sort((a, b) => a - b);
      const x = A.num(0);
      const n = v.length;
      if (!n) { return fail(ERR.VALUE); }
      if (x < v[0] || x > v[n - 1]) { return fail(ERR.NA); }
      let last = 0; let first = -1; let done = false; let i;
      for (i = 0; i < n && !done; i++) { if (v[i] === x) { if (first < 0) { first = i + 1; } } else if (v[i] > x) { last = i; done = true; } }
      if (!done) { last = i; }
      if (first <= 0) { return fail(ERR.NA); }
      if (!avg) { return asc ? first : n + 1 - last; }
      return asc ? (first + last) / 2 : n + 1 - (first + last) / 2;
    };
  }
  FN.RANK = rankFn(false);
  alias('RANK.EQ', 'RANK');
  fx('RANK.AVG', 2, 3, 'value; data; order', 'The rank of a value, ties sharing the average rank.', rankFn(true));
  fx('TRIMMEAN', 2, 2, 'data; alpha', 'The mean without the given fraction of extreme values.', (A) => {
    const a = A.num(1); if (a < 0 || a >= 1) { return fail(ERR.ARG); }
    const v = seqOf(A, 0, 1).sort((p, q) => p - q); const n = v.length;
    if (!n) { return fail(ERR.VALUE); }
    let k = approxFloor(a * n); if (k % 2) { k--; } k /= 2;
    const s = new LSum(); for (let i = k; i < n - k; i++) { s.add(v[i]); }
    return s.get() / (n - 2 * k);
  });
  /** LARGE and SMALL: the rank may be an array, then so is the answer. */
  function smallLarge(A, small) {
    const kv = A.raw(1);
    const kArr = kv instanceof RangeVal || kv instanceof ArrayVal ? toArray(kv, A.ctx) : null;
    const ks = kArr ? kArr.rows.map((row) => row.map((x) => x)) : [[A.num(1)]];
    const v = seqOf(A, 0, 1).sort((p, q) => p - q); const n = v.length;
    if (!n) { return fail(ERR.VALUE); }
    const pick = (k) => {
      if (isErr(k)) { return k; }
      const f = small ? approxFloor(toNum(k, A.L)) : approxCeil(toNum(k, A.L));
      if (f < 1 || f > n) { return kArr ? new CalcError(ERR.ARG) : fail(ERR.VALUE); }
      return small ? v[f - 1] : v[n - f];
    };
    if (!kArr) { return pick(ks[0][0]); }
    if (kArr.h * kArr.w === 1) { return pick(ks[0][0]); }
    return new ArrayVal(ks.map((row) => row.map((k) => safe(() => pick(k)))));
  }
  FN.LARGE = (A) => smallLarge(A, false);
  FN.SMALL = (A) => smallLarge(A, true);
  function modeMS(A, single) {
    const arr = seqOf(forceArray(A));
    const s = arr.slice().sort((a, b) => a - b); const n = s.length;
    if (!n) { return fail(ERR.VALUE); }
    let max = 1; let count = 1; let old = s[0]; let res = [];
    for (let i = 1; i < n; i++) {
      if (s[i] === old) { count++; } else { if (count >= max && count > 1) { if (count > max) { max = count; res = [old]; } else { res.push(old); } } old = s[i]; count = 1; }
    }
    if (count >= max && count > 1) { if (count > max) { res = []; max = count; } res.push(old); }
    if (max === 1 && count === 1) { return fail(ERR.VALUE); }
    if (max === 1) { return old; }
    const order = res.map((x) => [x, arr.indexOf(x)]).sort((p, q) => p[1] - q[1]);
    if (single) { return order[0][0]; }
    return new ArrayVal(order.map((o) => [o[0]]));
  }
  fx('MODE.SNGL', 1, -1, 'number 1; number 2; …', 'The most frequent number (the first one found).', (A) => modeMS(A, true));
  fx('MODE.MULT', 1, -1, 'number 1; number 2; …', 'The most frequent numbers, as a column.', (A) => modeMS(A, false));
  fx('PROB', 3, 4, 'data; probabilities; start; end', 'The probability that values lie between two limits.', (A) => {
    const up0 = A.num(2); const lo0 = A.n >= 4 && A.has(3) ? A.num(3) : up0;
    const hi = Math.max(up0, lo0); const lo = Math.min(up0, lo0);
    const W = A.matrix(0); const P = A.matrix(1);
    if (W.h !== P.h || W.w !== P.w || !W.h || !W.w) { return fail(ERR.NA); }
    const sum = new LSum(); const res = new LSum();
    for (let c = 0; c < W.w; c++) {
      for (let r = 0; r < W.h; r++) {
        const p = P.rows[r][c]; const w = W.rows[r][c];
        if (isNumLike(p) && isNumLike(w)) { const pv = numOf(p); const wv = numOf(w); if (pv < 0 || pv > 1) { return fail(ERR.VALUE); } sum.add(pv); if (wv >= lo && wv <= hi) { res.add(pv); } } else { return fail(ERR.ARG); }
      }
    }
    if (Math.abs(new LSum(sum.get()).add(-1).get()) > 1e-7) { return fail(ERR.VALUE); }
    return res.get();
  });

  // two variables
  function pearsonCovar(A, pearson, steyx, sample) {
    const { xs, ys } = pairsOf(A, 1, 0); const n = xs.length;
    if (n < (steyx ? 3 : sample ? 2 : 1)) { return fail(ERR.VALUE); }
    const sx = new LSum(); const sy = new LSum(); xs.forEach((x, i) => { sx.add(x); sy.add(ys[i]); });
    const mx = sx.get() / n; const my = sy.get() / n;
    const dxy = new LSum(); const dxx = new LSum(); const dyy = new LSum();
    xs.forEach((x, i) => { const y = ys[i]; dxy.add((x - mx) * (y - my)); if (pearson) { dxx.add((x - mx) * (x - mx)); dyy.add((y - my) * (y - my)); } });
    if (pearson) {
      if (dxx.get() < DBL_MIN || (!steyx && dyy.get() < DBL_MIN)) { return fail(ERR.DIV0); }
      if (steyx) { return Math.sqrt((dyy.get() - dxy.get() * dxy.get() / dxx.get()) / (n - 2)); }
      return dxy.get() / Math.sqrt(dxx.get() * dyy.get());
    }
    return sample ? dxy.get() / (n - 1) : dxy.get() / n;
  }
  fx('CORREL', 2, 2, 'data 1; data 2', 'The correlation coefficient of two data sets.', (A) => pearsonCovar(A, true, false, false));
  fx('PEARSON', 2, 2, 'data 1; data 2', 'The Pearson correlation coefficient.', (A) => pearsonCovar(A, true, false, false));
  fx('RSQ', 2, 2, 'data Y; data X', 'The square of the Pearson correlation coefficient.', (A) => { const r = pearsonCovar(A, true, false, false); return r * r; });
  fx('STEYX', 2, 2, 'data Y; data X', 'The standard error of the predicted y of a linear regression.', (A) => pearsonCovar(A, true, true, false));
  fx('COVAR', 2, 2, 'data 1; data 2', 'The covariance of a population.', (A) => pearsonCovar(A, false, false, false));
  alias('COVARIANCE.P', 'COVAR');
  fx('COVARIANCE.S', 2, 2, 'data 1; data 2', 'The covariance of a sample.', (A) => pearsonCovar(A, false, false, true));
  function slopeParts(A, yi, xi) {
    const { xs: ys, ys: xs } = pairsOf(A, yi, xi);
    const n = xs.length;
    if (n < 1) { return fail(ERR.VALUE); }
    const sx = new LSum(); const sy = new LSum(); xs.forEach((x, i) => { sx.add(x); sy.add(ys[i]); });
    const mx = sx.get() / n; const my = sy.get() / n;
    const dxy = new LSum(); const dxx = new LSum();
    xs.forEach((x, i) => { dxy.add((x - mx) * (ys[i] - my)); dxx.add((x - mx) * (x - mx)); });
    if (dxx.get() === 0) { return fail(ERR.DIV0); }
    return { mx, my, b: dxy.get() / dxx.get() };
  }
  fx('SLOPE', 2, 2, 'data Y; data X', 'The slope of the linear regression line.', (A) => slopeParts(A, 0, 1).b);
  fx('INTERCEPT', 2, 2, 'data Y; data X', 'Where the linear regression line meets the y axis.', (A) => { const p = slopeParts(A, 0, 1); return p.my - p.b * p.mx; });
  fx('FORECAST', 3, 3, 'x; data Y; data X', 'A value on the linear trend.', (A) => { const x = A.num(0); const p = slopeParts(A, 1, 2); return p.my + p.b * (x - p.mx); });
  alias('FORECAST.LINEAR', 'FORECAST');

  // combinatorics and gamma
  GRP = 'Mathematical';
  fx('COMBIN', 2, 2, 'count; count chosen', 'The number of combinations without repetition.', (A) => { const n = approxFloor(A.num(0)); const k = approxFloor(A.num(1)); if (k < 0 || n < 0 || k > n) { return fail(ERR.ARG); } return binomKoeff(n, k); });
  fx('COMBINA', 2, 2, 'count; count chosen', 'The number of combinations with repetition.', (A) => { const n = approxFloor(A.num(0)); const k = approxFloor(A.num(1)); if (k < 0 || n < 0 || k > n) { return fail(ERR.ARG); } return binomKoeff(n + k - 1, k); });
  GRP = 'Statistical';
  fx('PERMUT', 2, 2, 'count; count chosen', 'The number of permutations without repetition.', (A) => { const n = approxFloor(A.num(0)); const k = approxFloor(A.num(1)); if (n < 0 || k < 0 || k > n) { return fail(ERR.ARG); } if (k === 0) { return 1; } let v = n; for (let i = k - 1; i >= 1; i--) { v *= n - i; } return v; });
  fx('PERMUTATIONA', 2, 2, 'count; count chosen', 'The number of permutations with repetition.', (A) => { const n = approxFloor(A.num(0)); const k = approxFloor(A.num(1)); if (n < 0 || k < 0) { return fail(ERR.ARG); } return xpow(n, k); });
  fx('GAMMA', 1, 1, 'number', 'The gamma function.', (A) => { const x = A.num(0); if (x <= 0 && x === approxFloor(x)) { return fail(ERR.ARG); } return getGamma(x); });
  fx('GAMMALN', 1, 1, 'number', 'The natural logarithm of the gamma function.', (A) => { const x = A.num(0); if (x <= 0) { return fail(ERR.ARG); } return getLogGamma(x); });
  alias('GAMMALN.PRECISE', 'GAMMALN');

  // distributions
  fx('PHI', 1, 1, 'number', 'The density of the standard normal distribution.', (A) => phi(A.num(0)));
  fx('GAUSS', 1, 1, 'number', 'The standard normal integral from 0 to x (0.5 less than NORMSDIST).', (A) => gauss(A.num(0)));
  const normDist = (A) => { const cum = A.n !== 4 || A.bool(3); const x = A.num(0); const m = A.num(1); const s = A.num(2); if (s <= 0) { return fail(ERR.ARG); } return cum ? integralPhi((x - m) / s) : phi((x - m) / s) / s; };
  fx('NORMDIST', 3, 4, 'x; mean; standard deviation; cumulative', 'The normal distribution.', normDist);
  fx('NORM.DIST', 4, 4, 'x; mean; standard deviation; cumulative', 'The normal distribution.', normDist);
  fx('NORMSDIST', 1, 1, 'x', 'The cumulative standard normal distribution.', (A) => integralPhi(A.num(0)));
  fx('NORM.S.DIST', 2, 2, 'x; cumulative', 'The standard normal distribution.', (A) => { const cum = A.bool(1); const x = A.num(0); return cum ? integralPhi(x) : xexp(-xpow(x, 2) / 2) / Math.sqrt(2 * Math.PI); });
  const normInv = (A) => { const p = A.num(0); const m = A.num(1); const s = A.num(2); if (s <= 0 || p < 0 || p > 1) { return fail(ERR.ARG); } if (p === 0 || p === 1) { return fail(ERR.VALUE); } return gaussinv(p) * s + m; };
  fx('NORMINV', 3, 3, 'probability; mean; standard deviation', 'The inverse of the normal distribution.', normInv);
  alias('NORM.INV', 'NORMINV');
  const sNormInv = (A) => { const p = A.num(0); if (p < 0 || p > 1) { return fail(ERR.ARG); } if (p === 0 || p === 1) { return fail(ERR.VALUE); } return gaussinv(p); };
  fx('NORMSINV', 1, 1, 'probability', 'The inverse of the standard normal distribution.', sNormInv);
  alias('NORM.S.INV', 'NORMSINV');
  const logNormDist = (A) => {
    const cum = A.n !== 4 || A.bool(3); const s = A.n >= 3 ? A.num(2) : 1; const m = A.n >= 2 ? A.num(1) : 0; const x = A.num(0);
    if (s <= 0) { return fail(ERR.ARG); }
    if (cum) { return x <= 0 ? 0 : integralPhi((xlog(x) - m) / s); }
    if (x <= 0) { return fail(ERR.ARG); }
    return phi((xlog(x) - m) / s) / s / x;
  };
  fx('LOGNORMDIST', 1, 4, 'x; mean; standard deviation; cumulative', 'The lognormal distribution.', logNormDist);
  fx('LOGNORM.DIST', 4, 4, 'x; mean; standard deviation; cumulative', 'The lognormal distribution.', logNormDist);
  fx('LOGINV', 1, 3, 'probability; mean; standard deviation', 'The inverse of the lognormal distribution.', (A) => { const s = A.n === 3 ? A.num(2) : 1; const m = A.n >= 2 ? A.num(1) : 0; const p = A.num(0); if (s <= 0 || p <= 0 || p >= 1) { return fail(ERR.ARG); } return xexp(m + s * gaussinv(p)); });
  alias('LOGNORM.INV', 'LOGINV');
  const expDist = (A) => { const x = A.num(0); const l = A.num(1); const k = A.num(2); if (l <= 0) { return fail(ERR.ARG); } if (k === 0) { return x >= 0 ? l * xexp(-l * x) : 0; } return x > 0 ? 1 - xexp(-l * x) : 0; };
  fx('EXPONDIST', 3, 3, 'x; lambda; cumulative', 'The exponential distribution.', expDist);
  alias('EXPON.DIST', 'EXPONDIST');
  const weibull = (A) => { const x = A.num(0); const a = A.num(1); const b = A.num(2); const k = A.num(3); if (a <= 0 || b <= 0 || x < 0) { return fail(ERR.ARG); } if (k === 0) { return a / xpow(b, a) * xpow(x, a - 1) * xexp(-xpow(x / b, a)); } return 1 - xexp(-xpow(x / b, a)); };
  fx('WEIBULL', 4, 4, 'x; alpha; beta; cumulative', 'The Weibull distribution.', weibull);
  alias('WEIBULL.DIST', 'WEIBULL');
  const poisson = (A) => {
    const cum = A.n !== 3 || A.bool(2); const l = A.num(1); const x = approxFloor(A.num(0));
    if (l <= 0 || x < 0) { return fail(ERR.ARG); }
    if (!cum) { if (l > 712) { return xexp(x * xlog(l) - l - getLogGamma(x + 1)); } let p = 1; for (let f = 0; f < x; ++f) { p *= l / (f + 1); } return p * xexp(-l); }
    if (l > 712) { return upRegIGamma(x + 1, l); }
    if (x >= 936) { return 1; }
    let t = xexp(-l); const s = new LSum(t); const end = Math.trunc(x);
    for (let i = 1; i <= end; i++) { t = (t * l) / i; s.add(t); }
    return s.get();
  };
  fx('POISSON', 2, 3, 'number; mean; cumulative', 'The Poisson distribution.', poisson);
  fx('POISSON.DIST', 3, 3, 'number; mean; cumulative', 'The Poisson distribution.', poisson);
  fx('BINOMDIST', 4, 4, 'successes; trials; probability; cumulative', 'The binomial distribution.', (A) => {
    const x = approxFloor(A.num(0)); const n = approxFloor(A.num(1)); const p = A.num(2); const cum = A.bool(3);
    const q = (0.5 - p) + 0.5;
    if (n < 0 || x < 0 || x > n || p < 0 || p > 1) { return fail(ERR.ARG); }
    if (p === 0) { return x === 0 || cum ? 1 : 0; }
    if (p === 1) { return x === n ? 1 : 0; }
    if (!cum) { return binomPMF(x, n, p); }
    if (x === n) { return 1; }
    let f = xpow(q, n);
    if (x === 0) { return f; }
    if (f <= DBL_MIN) {
      f = xpow(p, n);
      if (f <= DBL_MIN) { return betaDist(q, n - x, x + 1); }
      if (f > EPS) { let s = 1 - f; const max = Math.trunc(n - x) - 1; for (let i = 0; i < max && f > 0; i++) { f *= (n - i) / (i + 1) * q / p; s -= f; } return s < 0 ? 0 : s; }
      return binomRange(n, n - x, n, f, q, p);
    }
    return binomRange(n, 0, x, f, p, q);
  });
  alias('BINOM.DIST', 'BINOMDIST');
  fx('B', 3, 4, 'trials; probability; start; end', 'The probability of a number of successes (or of a range of them) in a binomial trial.', (A) => {
    if (A.n === 3) {
      const n = approxFloor(A.num(0)); const p = A.num(1); const x = approxFloor(A.num(2));
      if (n < 0 || x < 0 || x > n || p < 0 || p > 1) { return fail(ERR.ARG); }
      if (p === 0) { return x === 0 ? 1 : 0; }
      if (p === 1) { return x === n ? 1 : 0; }
      return binomPMF(x, n, p);
    }
    const n = approxFloor(A.num(0)); const p = A.num(1); const xs = approxFloor(A.num(2)); const xe = approxFloor(A.num(3));
    const q = (0.5 - p) + 0.5;
    const valid = xs >= 0 && xs <= xe && xe <= n;
    if (valid && p > 0 && p < 1) {
      if (xs === xe) { return binomPMF(xs, n, p); }
      let f = xpow(q, n);
      if (f > DBL_MIN) { return binomRange(n, xs, xe, f, p, q); }
      f = xpow(p, n);
      if (f > DBL_MIN) { return binomRange(n, n - xe, n - xs, f, q, p); }
      return betaDist(q, n - xe, xe + 1) - betaDist(q, n - xs + 1, xs);
    }
    if (valid) { if (p === 0) { return xs === 0 ? 1 : 0; } if (p === 1) { return xe === n ? 1 : 0; } }
    return fail(ERR.ARG);
  });
  fx('CRITBINOM', 3, 3, 'trials; probability; alpha', 'The smallest number of successes whose cumulative binomial probability reaches alpha.', (A) => {
    const n = approxFloor(A.num(0)); const p = A.num(1); let alpha = A.num(2);
    if (n < 0 || alpha < 0 || alpha > 1 || p < 0 || p > 1) { return fail(ERR.ARG); }
    if (alpha === 0) { return 0; }
    if (alpha === 1) { return p === 0 ? 0 : n; }
    const q = (0.5 - p) + 0.5; const max = Math.trunc(n); let i;
    if (q > p) {
      let f = xpow(q, n);
      if (f > DBL_MIN) { const s = new LSum(f); for (i = 0; i < max && s.get() < alpha; i++) { f *= (n - i) / (i + 1) * p / q; s.add(f); } return i; }
      const s = new LSum(0); for (i = 0; i < max && s.get() < alpha; i++) { s.add(betaPDF(p, i + 1, n - i + 1) / (n + 1)); } return i - 1;
    }
    let f = xpow(p, n);
    if (f > DBL_MIN) { const s = new LSum(1 - f); for (i = 0; i < max && s.get() >= alpha; i++) { f *= (n - i) / (i + 1) * q / p; s.add(-f); } return n - i; }
    const s = new LSum(0); alpha = 1 - alpha; for (i = 0; i < max && s.get() < alpha; i++) { s.add(betaPDF(q, i + 1, n - i + 1) / (n + 1)); } return n - i + 1;
  });
  alias('BINOM.INV', 'CRITBINOM');
  fx('NEGBINOMDIST', 3, 3, 'failures; successes; probability', 'The negative binomial distribution.', (A) => { const f = approxFloor(A.num(0)); const s = approxFloor(A.num(1)); const p = A.num(2); if (f + s <= 1 || p < 0 || p > 1) { return fail(ERR.ARG); } const q = 1 - p; let v = xpow(p, s); for (let i = 0; i < f; i++) { v *= (i + s) / (i + 1) * q; } return v; });
  fx('NEGBINOM.DIST', 4, 4, 'failures; successes; probability; cumulative', 'The negative binomial distribution.', (A) => { const f = approxFloor(A.num(0)); const s = approxFloor(A.num(1)); const p = A.num(2); const cum = A.bool(3); if (s < 1 || f < 0 || p < 0 || p > 1) { return fail(ERR.ARG); } const q = 1 - p; if (cum) { return 1 - betaDist(q, f + 1, s); } let v = xpow(p, s); for (let i = 0; i < f; i++) { v *= (i + s) / (i + 1) * q; } return v; });
  const hypGeomFn = (A) => {
    const cum = A.n === 5 && A.bool(4);
    const x = approxFloor(A.num(0)); const n = approxFloor(A.num(1)); const M = approxFloor(A.num(2)); const N = approxFloor(A.num(3));
    if (x < 0 || n < x || N < n || N < M || M < 0) { return fail(ERR.ARG); }
    const s = new LSum(0);
    for (let i = cum ? 0 : x; i <= x; i++) { if (n - i <= N - M && i <= M) { s.add(hypGeom(i, n, M, N)); } }
    return s.get();
  };
  fx('HYPGEOMDIST', 4, 5, 'successes; sample size; population successes; population size; cumulative', 'The hypergeometric distribution.', hypGeomFn);
  fx('HYPGEOM.DIST', 5, 5, 'successes; sample size; population successes; population size; cumulative', 'The hypergeometric distribution.', hypGeomFn);
  const gammaDistFn = (odff) => (A) => { const cum = A.n === 4 ? A.bool(3) : true; const x = A.num(0); const a = A.num(1); const b = A.num(2); if ((!odff && x < 0) || a <= 0 || b <= 0) { return fail(ERR.ARG); } return cum ? gammaDist(x, a, b) : gammaPDF(x, a, b); };
  fx('GAMMADIST', 3, 4, 'x; alpha; beta; cumulative', 'The gamma distribution.', gammaDistFn(true));
  fx('GAMMA.DIST', 4, 4, 'x; alpha; beta; cumulative', 'The gamma distribution.', gammaDistFn(false));
  fx('GAMMAINV', 3, 3, 'probability; alpha; beta', 'The inverse of the gamma distribution.', (A) => { const p = A.num(0); const a = A.num(1); const b = A.num(2); if (a <= 0 || b <= 0 || p < 0 || p >= 1) { return fail(ERR.ARG); } if (p === 0) { return 0; } const st = a * b; return inverse((x) => p - gammaDist(x, a, b), st * 0.5, st); });
  alias('GAMMA.INV', 'GAMMAINV');
  fx('BETADIST', 3, 6, 'x; alpha; beta; start; end; cumulative', 'The beta distribution.', (A) => {
    const cum = A.n === 6 ? A.bool(5) : true; const hi = A.n >= 5 ? A.num(4) : 1; const lo = A.n >= 4 ? A.num(3) : 0;
    const b = A.num(2); const a = A.num(1); let x = A.num(0);
    const scale = hi - lo;
    if (scale <= 0 || a <= 0 || b <= 0) { return fail(ERR.ARG); }
    if (cum) { if (x < lo) { return 0; } if (x > hi) { return 1; } return betaDist((x - lo) / scale, a, b); }
    if (x < lo || x > hi) { return 0; }
    x = (x - lo) / scale;
    return betaPDF(x, a, b) / scale;
  });
  fx('BETA.DIST', 4, 6, 'x; alpha; beta; cumulative; start; end', 'The beta distribution.', (A) => {
    const hi = A.n === 6 ? A.num(5) : 1; const lo = A.n >= 5 ? A.num(4) : 0; const cum = A.bool(3);
    const b = A.num(2); const a = A.num(1); const x = A.num(0);
    if (a <= 0 || b <= 0 || x < lo || x > hi) { return fail(ERR.ARG); }
    const scale = hi - lo;
    return cum ? betaDist((x - lo) / scale, a, b) : betaPDF((x - lo) / scale, a, b) / scale;
  });
  fx('BETAINV', 3, 5, 'probability; alpha; beta; start; end', 'The inverse of the beta distribution.', (A) => {
    const hi = A.n === 5 ? A.num(4) : 1; const lo = A.n >= 4 ? A.num(3) : 0; const b = A.num(2); const a = A.num(1); const p = A.num(0);
    if (p < 0 || p > 1 || lo >= hi || a <= 0 || b <= 0) { return fail(ERR.ARG); }
    return lo + inverse((x) => p - betaDist(x, a, b), 0, 1) * (hi - lo);
  });
  alias('BETA.INV', 'BETAINV');
  fx('TDIST', 3, 3, 'x; degrees of freedom; tails', 'The t-distribution (one or two tails).', (A) => { const t = A.num(0); const df = approxFloor(A.num(1)); const fl = approxFloor(A.num(2)); if (df < 1 || t < 0 || (fl !== 1 && fl !== 2)) { return fail(ERR.ARG); } return tDist(t, df, fl); });
  fx('T.DIST', 3, 3, 'x; degrees of freedom; cumulative', 'The left-tailed t-distribution.', (A) => { const t = A.num(0); const df = approxFloor(A.num(1)); const cum = A.bool(2); if (df < 1) { return fail(ERR.ARG); } return tDist(t, df, cum ? 4 : 3); });
  const tDistT = (tails) => (A) => { const t = A.num(0); const df = approxFloor(A.num(1)); if (df < 1 || (tails === 2 && t < 0)) { return fail(ERR.ARG); } const r = tDist(t, df, tails); return tails === 1 && t < 0 ? 1 - r : r; };
  fx('T.DIST.RT', 2, 2, 'x; degrees of freedom', 'The right-tailed t-distribution.', tDistT(1));
  fx('T.DIST.2T', 2, 2, 'x; degrees of freedom', 'The two-tailed t-distribution.', tDistT(2));
  const tInv = (type) => (A) => {
    const p = A.num(0); const df = approxFloor(A.num(1));
    if (df < 1 || p <= 0 || p > 1) { return fail(ERR.ARG); }
    const inv = (pp) => inverse((x) => pp - tDist(x, df, type), df * 0.5, df);
    if (type === 4) { if (p === 1) { return fail(ERR.ARG); } return p < 0.5 ? -inv(1 - p) : inv(p); }
    return inv(p);
  };
  fx('TINV', 2, 2, 'probability; degrees of freedom', 'The inverse of the two-tailed t-distribution.', tInv(2));
  alias('T.INV.2T', 'TINV');
  fx('T.INV', 2, 2, 'probability; degrees of freedom', 'The inverse of the left-tailed t-distribution.', tInv(4));
  const fArgs = (A) => { const x = A.num(0); const f1 = approxFloor(A.num(1)); const f2 = approxFloor(A.num(2)); if (x < 0 || f1 < 1 || f2 < 1 || f1 >= 1e10 || f2 >= 1e10) { return fail(ERR.ARG); } return { x, f1, f2 }; };
  fx('FDIST', 3, 3, 'x; degrees of freedom 1; degrees of freedom 2', 'The right-tailed F distribution.', (A) => { const { x, f1, f2 } = fArgs(A); return fDist(x, f1, f2); });
  alias('F.DIST.RT', 'FDIST');
  fx('F.DIST', 3, 4, 'x; degrees of freedom 1; degrees of freedom 2; cumulative', 'The left-tailed F distribution.', (A) => {
    const cum = A.n === 3 || !A.has(3) ? true : A.bool(3);
    const { x, f1, f2 } = fArgs(A);
    if (cum) { return 1 - fDist(x, f1, f2); }
    return xpow(f1 / f2, f1 / 2) * xpow(x, (f1 / 2) - 1) / (xpow((1 + (x * f1 / f2)), (f1 + f2) / 2) * getBeta(f1 / 2, f2 / 2));
  });
  const fInv = (left) => (A) => { const p = A.num(0); const f1 = approxFloor(A.num(1)); const f2 = approxFloor(A.num(2)); if (p <= 0 || f1 < 1 || f2 < 1 || f1 >= 1e10 || f2 >= 1e10 || p > 1) { return fail(ERR.ARG); } const pp = left ? 1 - p : p; return inverse((x) => pp - fDist(x, f1, f2), f1 * 0.5, f1); };
  fx('FINV', 3, 3, 'probability; degrees of freedom 1; degrees of freedom 2', 'The inverse of the right-tailed F distribution.', fInv(false));
  alias('F.INV.RT', 'FINV');
  fx('F.INV', 3, 3, 'probability; degrees of freedom 1; degrees of freedom 2', 'The inverse of the left-tailed F distribution.', fInv(true));
  const chiDistFn = (odff) => (A) => { const x = A.num(0); const df = approxFloor(A.num(1)); if (df < 1 || (!odff && x < 0)) { return fail(ERR.ARG); } return chiDist(x, df); };
  fx('CHIDIST', 2, 2, 'x; degrees of freedom', 'The right-tailed chi-square distribution.', chiDistFn(true));
  fx('CHISQ.DIST.RT', 2, 2, 'x; degrees of freedom', 'The right-tailed chi-square distribution.', chiDistFn(false));
  fx('CHISQDIST', 2, 3, 'x; degrees of freedom; cumulative', 'The chi-square distribution.', (A) => { const cum = A.n === 3 ? A.bool(2) : true; const df = approxFloor(A.num(1)); if (df < 1) { return fail(ERR.ARG); } const x = A.num(0); return cum ? chiSqCDF(x, df) : chiSqPDF(x, df); });
  fx('CHISQ.DIST', 3, 3, 'x; degrees of freedom; cumulative', 'The left-tailed chi-square distribution.', (A) => { const cum = A.bool(2); const df = approxFloor(A.num(1)); if (df < 1 || df > 1e10) { return fail(ERR.ARG); } const x = A.num(0); if (x < 0) { return fail(ERR.ARG); } return cum ? chiSqCDF(x, df) : chiSqPDF(x, df); });
  fx('CHIINV', 2, 2, 'probability; degrees of freedom', 'The inverse of the right-tailed chi-square distribution.', (A) => { const p = A.num(0); const df = approxFloor(A.num(1)); if (df < 1 || p <= 0 || p > 1) { return fail(ERR.ARG); } return inverse((x) => p - chiDist(x, df), df * 0.5, df); });
  alias('CHISQ.INV.RT', 'CHIINV');
  fx('CHISQINV', 2, 2, 'probability; degrees of freedom', 'The inverse of the left-tailed chi-square distribution.', (A) => { const p = A.num(0); const df = approxFloor(A.num(1)); if (df < 1 || p < 0 || p >= 1) { return fail(ERR.ARG); } return inverse((x) => p - chiSqCDF(x, df), df * 0.5, df); });
  alias('CHISQ.INV', 'CHISQINV');
  fx('CONFIDENCE', 3, 3, 'alpha; standard deviation; size', 'The confidence interval of a population mean (normal distribution).', (A) => { const a = A.num(0); const s = A.num(1); const n = approxFloor(A.num(2)); if (s <= 0 || a <= 0 || a >= 1 || n < 1) { return fail(ERR.ARG); } return gaussinv(1 - a / 2) * s / Math.sqrt(n); });
  alias('CONFIDENCE.NORM', 'CONFIDENCE');
  fx('CONFIDENCE.T', 3, 3, 'alpha; standard deviation; size', 'The confidence interval of a population mean (t-distribution).', (A) => { const a = A.num(0); const s = A.num(1); const n = approxFloor(A.num(2)); if (s <= 0 || a <= 0 || a >= 1 || n < 1) { return fail(ERR.ARG); } if (n === 1) { return fail(ERR.DIV0); } return s * inverse((x) => a - tDist(x, n - 1, 2), (n - 1) * 0.5, n - 1) / Math.sqrt(n); });
  fx('ZTEST', 2, 3, 'data; mu; sigma', 'The one-tailed probability of a z-test.', (A) => {
    let sigma = 0;
    if (A.n === 3) { sigma = A.num(2); if (sigma <= 0) { return fail(ERR.ARG); } }
    const x = A.num(1);
    const v = matNums(A.matrix(0));
    const s = new LSum(); const sq = new LSum(); v.forEach((t) => { s.add(t); sq.add(t * t); });
    const n = v.length;
    if (n <= 1) { return fail(ERR.DIV0); }
    const mu = s.get() / n;
    if (A.n !== 3) { const ssn = s.get() * s.get() / n; const sg = sq.copy().add(-ssn).get() / (n - 1); if (sg === 0) { return fail(ERR.DIV0); } return 0.5 - gauss((mu - x) / Math.sqrt(sg / n)); }
    return 0.5 - gauss((mu - x) * Math.sqrt(n) / sigma);
  });
  alias('Z.TEST', 'ZTEST');
  function sumSq(v) { const s = new LSum(); const q = new LSum(); v.forEach((x) => { s.add(x); q.add(x * x); }); return { s, q, n: v.length }; }
  const varFrom = (o) => { const x = o.s.get() * o.s.get() / o.n; return o.q.copy().add(-x).get(); };
  fx('TTEST', 4, 4, 'data 1; data 2; tails; type', 'The probability of a Student t-test.', (A) => {
    const typ = approxFloor(A.num(3)); const tails = approxFloor(A.num(2));
    if (tails !== 1 && tails !== 2) { return fail(ERR.ARG); }
    const X = A.matrix(0); const Y = A.matrix(1);
    let t; let df;
    if (typ === 1) {
      if (X.h !== Y.h || X.w !== Y.w) { return fail(ERR.ARG); }
      let cnt = 0; const s1 = new LSum(); const s2 = new LSum(); const sd = new LSum();
      for (let c = 0; c < X.w; c++) { for (let r = 0; r < X.h; r++) { const a = X.rows[r][c]; const b = Y.rows[r][c]; if (a == null || b == null || typeof a === 'string' || typeof b === 'string') { continue; } if (isErr(a)) { throw a; } if (isErr(b)) { throw b; } const x1 = numOf(a); const x2 = numOf(b); s1.add(x1); s2.add(x2); sd.add((x1 - x2) * (x1 - x2)); cnt++; } }
      if (cnt < 1) { return fail(ERR.VALUE); }
      const sD = s1.copy().addSum(s2.neg());
      const dv = new LSum(sd.get() * cnt); dv.add(-(sD.get() * sD.get()));
      const divider = dv.get();
      if (divider === 0) { return fail(ERR.DIV0); }
      t = Math.abs(sD.get()) * Math.sqrt((cnt - 1) / divider); df = cnt - 1;
    } else if (typ === 2 || typ === 3) {
      const a = sumSq(matNums(X)); const b = sumSq(matNums(Y));
      if (a.n < 2 || b.n < 2) { return fail(ERR.VALUE); }
      if (typ === 3) {
        const v1 = varFrom(a) / (a.n - 1) / a.n; const v2 = varFrom(b) / (b.n - 1) / b.n;
        if (v1 + v2 === 0) { return fail(ERR.VALUE); }
        const dm = new LSum(a.s.get() / a.n).addSum(new LSum(b.s.get() / b.n).neg());
        t = Math.abs(dm.get()) / Math.sqrt(v1 + v2);
        const c = v1 / (v1 + v2);
        df = 1 / (c * c / (a.n - 1) + (1 - c) * (1 - c) / (b.n - 1));
      } else {
        const v1 = varFrom(a) / (a.n - 1); const v2 = varFrom(b) / (b.n - 1);
        t = Math.abs(a.s.get() / a.n - b.s.get() / b.n) / Math.sqrt((a.n - 1) * v1 + (b.n - 1) * v2) * Math.sqrt(a.n * b.n * (a.n + b.n - 2) / (a.n + b.n));
        df = a.n + b.n - 2;
      }
    } else { return fail(ERR.ARG); }
    return tDist(t, df, tails);
  });
  alias('T.TEST', 'TTEST');
  fx('FTEST', 2, 2, 'data 1; data 2', 'The two-tailed probability of an F-test.', (A) => {
    const a = sumSq(matNums(A.matrix(0))); const b = sumSq(matNums(A.matrix(1)));
    if (a.n < 2 || b.n < 2) { return fail(ERR.VALUE); }
    const s1 = varFrom(a) / (a.n - 1); const s2 = varFrom(b) / (b.n - 1);
    if (s1 === 0 || s2 === 0) { return fail(ERR.VALUE); }
    const p = s1 > s2 ? fDist(s1 / s2, a.n - 1, b.n - 1) : fDist(s2 / s1, b.n - 1, a.n - 1);
    return 2 * Math.min(p, 1 - p);
  });
  alias('F.TEST', 'FTEST');
  fx('CHITEST', 2, 2, 'observed; expected', 'The probability of a chi-square test of independence.', (A) => {
    const X = A.matrix(0); const E = A.matrix(1);
    if (X.h !== E.h || X.w !== E.w) { return fail(ERR.ARG); }
    const chi = new LSum(); let empty = true;
    for (let c = 0; c < X.w; c++) {
      for (let r = 0; r < X.h; r++) {
        const x = X.rows[r][c]; const e = E.rows[r][c];
        if (x == null || e == null) { continue; }
        empty = false;
        if (typeof x === 'string' || typeof e === 'string') { return fail(ERR.ARG); }
        if (isErr(x)) { throw x; }
        if (isErr(e)) { throw e; }
        const xv = numOf(x); const evv = numOf(e);
        if (evv === 0) { return fail(ERR.DIV0); }
        const t = (xv - evv) * (xv - evv);
        if (!isFinite(t)) { return fail(ERR.CONV); }
        chi.add(t / evv);
      }
    }
    if (empty) { return fail(ERR.ARG); }
    let df;
    if (X.w === 1 || X.h === 1) { df = X.w * X.h - 1; if (df === 0) { return fail(ERR.VALUE); } } else { df = (X.w - 1) * (X.h - 1); }
    return chiDist(chi.get(), df);
  });
  alias('CHISQ.TEST', 'CHITEST');
  fx('ERF.PRECISE', 1, 1, 'x', 'The error function from 0 to x.', (A) => erf(A.num(0)));
  fx('ERFC.PRECISE', 1, 1, 'x', 'The complementary error function from x to infinity.', (A) => erfc(A.num(0)));

  // mathematics
  GRP = 'Mathematical';
  /** An add-in's whole-number argument (Calc's double_to_int32: toward zero after approxValue). */
  const int32 = (x) => { const v = x > 0 ? approxFloor(x) : x < 0 ? approxCeil(x) : 0; if (v > 2147483647 || v < -2147483648) { return fail(ERR.ARG); } return v; };
  /** sin, cos and tan refuse angles beyond 2^63 (rtl::math), Calc then shows #VALUE!. */
  const arcOk = (x) => (Math.abs(x) <= 9223372036854775808 * 4 ? x : fail(ERR.VALUE));
  fx('SIN', 1, 1, 'number', 'The sine of an angle in radians.', (A) => Math.sin(arcOk(A.num(0))));
  fx('COS', 1, 1, 'number', 'The cosine of an angle in radians.', (A) => Math.cos(arcOk(A.num(0))));
  fx('TAN', 1, 1, 'number', 'The tangent of an angle in radians.', (A) => Math.tan(arcOk(A.num(0))));
  fx('COT', 1, 1, 'number', 'The cotangent of an angle in radians.', (A) => 1 / Math.tan(arcOk(A.num(0))));
  fx('SEC', 1, 1, 'number', 'The secant of an angle in radians.', (A) => 1 / Math.cos(arcOk(A.num(0))));
  fx('CSC', 1, 1, 'number', 'The cosecant of an angle in radians.', (A) => 1 / Math.sin(arcOk(A.num(0))));
  fx('ASIN', 1, 1, 'number', 'The arcsine, in radians.', (A) => Math.asin(A.num(0)));
  fx('ACOS', 1, 1, 'number', 'The arccosine, in radians.', (A) => Math.acos(A.num(0)));
  fx('ATAN', 1, 1, 'number', 'The arctangent, in radians.', (A) => Math.atan(A.num(0)));
  fx('ACOT', 1, 1, 'number', 'The arccotangent, in radians.', (A) => Math.PI / 2 - Math.atan(A.num(0)));
  fx('ATAN2', 2, 2, 'x; y', 'The angle of the point (x, y) from the x axis, in radians.', (A) => { const x = A.num(0); const y = A.num(1); return Math.atan2(y, x); });
  fx('SINH', 1, 1, 'number', 'The hyperbolic sine.', (A) => Math.sinh(A.num(0)));
  fx('COSH', 1, 1, 'number', 'The hyperbolic cosine.', (A) => Math.cosh(A.num(0)));
  fx('TANH', 1, 1, 'number', 'The hyperbolic tangent.', (A) => Math.tanh(A.num(0)));
  fx('COTH', 1, 1, 'number', 'The hyperbolic cotangent.', (A) => 1 / Math.tanh(A.num(0)));
  fx('SECH', 1, 1, 'number', 'The hyperbolic secant.', (A) => 1 / Math.cosh(A.num(0)));
  fx('CSCH', 1, 1, 'number', 'The hyperbolic cosecant.', (A) => 1 / Math.sinh(A.num(0)));
  fx('ASINH', 1, 1, 'number', 'The inverse hyperbolic sine.', (A) => {
    let x = A.num(0); if (x === 0) { return 0; } let s = 1; if (x < 0) { x = -x; s = -1; }
    if (x < 0.125) { return s * Math.log1p(x + x * x / (1 + Math.sqrt(1 + x * x))); }
    if (x < 1.25e7) { return s * xlog(x + Math.sqrt(1 + x * x)); }
    return s * xlog(2 * x);
  });
  fx('ACOSH', 1, 1, 'number', 'The inverse hyperbolic cosine.', (A) => {
    const x = A.num(0); if (x < 1) { return fail(ERR.ARG); } if (x === 1) { return 0; }
    const z = x - 1;
    if (x < 1.1) { return Math.log1p(z + Math.sqrt(z * z + 2 * z)); }
    if (x < 1.25e7) { return xlog(x + Math.sqrt(x * x - 1)); }
    return xlog(2 * x);
  });
  fx('ATANH', 1, 1, 'number', 'The inverse hyperbolic tangent.', (A) => { const x = A.num(0); if (Math.abs(x) >= 1) { return fail(ERR.ARG); } return Math.atanh(x); });
  fx('ACOTH', 1, 1, 'number', 'The inverse hyperbolic cotangent.', (A) => { const x = A.num(0); if (Math.abs(x) <= 1) { return fail(ERR.ARG); } return 0.5 * xlog((x + 1) / (x - 1)); });
  fx('DEGREES', 1, 1, 'radians', 'An angle in radians as degrees.', (A) => A.num(0) * (180 / Math.PI));
  fx('RADIANS', 1, 1, 'degrees', 'An angle in degrees as radians.', (A) => A.num(0) * (Math.PI / 180));
  fx('EVEN', 1, 1, 'number', 'Rounds away from zero to the next even whole number.', (A) => { const x = A.num(0); return x < 0 ? approxFloor(x / 2) * 2 : approxCeil(x / 2) * 2; });
  fx('ODD', 1, 1, 'number', 'Rounds away from zero to the next odd whole number.', (A) => { let x = A.num(0); if (x >= 0) { x = approxCeil(x); if (x % 2 === 0) { ++x; } } else { x = approxFloor(x); if (x % 2 === 0) { --x; } } return x; });
  /** CEILING.MATH and FLOOR.MATH (Calc's ScCeil/ScFloor without the ODFF sign rule). */
  function ceilFloorMath(A, ceil) {
    const abs = A.n === 3 && A.bool(2);
    const val = A.num(0);
    let dec = A.n >= 2 && A.has(1) ? A.num(1) : (val < 0 ? -1 : 1);
    if (val === 0 || dec === 0) { return 0; }
    if (val * dec < 0) { dec = -dec; }
    if (ceil) { return !abs && val < 0 ? approxFloor(val / dec) * dec : approxCeil(val / dec) * dec; }
    return !abs && val < 0 ? approxCeil(val / dec) * dec : approxFloor(val / dec) * dec;
  }
  fx('CEILING.MATH', 1, 3, 'number; significance; mode', 'Rounds up to a multiple of the significance (any sign).', (A) => ceilFloorMath(A, true));
  fx('FLOOR.MATH', 1, 3, 'number; significance; mode', 'Rounds down to a multiple of the significance (any sign).', (A) => ceilFloorMath(A, false));
  const precise = (ceil) => (A) => { const val = A.num(0); const dec = A.n === 1 || !A.has(1) ? 1 : Math.abs(A.num(1)); if (dec === 0 || val === 0) { return 0; } return (ceil ? approxCeil(val / dec) : approxFloor(val / dec)) * dec; };
  fx('CEILING.PRECISE', 1, 2, 'number; significance', 'Rounds up to a multiple of the significance.', precise(true));
  fx('ISO.CEILING', 1, 2, 'number; significance', 'Rounds up to a multiple of the significance (ISO).', precise(true));
  fx('FLOOR.PRECISE', 1, 2, 'number; significance', 'Rounds down to a multiple of the significance.', precise(false));
  fx('CEILING.XCL', 2, 2, 'number; significance', 'Rounds up to a multiple of the significance, as Excel does.', (A) => { const val = A.num(0); const dec = A.num(1); if (val === 0 || dec === 0) { return 0; } if (val * dec > 0) { return approxCeil(val / dec) * dec; } if (val < 0) { return approxFloor(val / -dec) * -dec; } return fail(ERR.ARG); });
  fx('FLOOR.XCL', 2, 2, 'number; significance', 'Rounds down to a multiple of the significance, as Excel does.', (A) => { const val = A.num(0); const dec = A.num(1); if (val === 0) { return 0; } if (val * dec > 0) { return approxFloor(val / dec) * dec; } if (dec === 0) { return fail(ERR.ARG); } if (val < 0) { return approxCeil(val / -dec) * -dec; } return fail(ERR.ARG); });
  fx('ROUNDSIG', 2, 2, 'number; digits', 'Rounds to a number of significant digits.', (A) => {
    const d = approxFloor(A.num(1)); const x = A.num(0);
    if (d < 1) { return fail(ERR.ARG); }
    if (x === 0) { return 0; }
    const t = Math.floor(xlog10(Math.abs(x))) + 1 - d;
    let v = t < 0 ? x * xpow(10, -t) : x / xpow(10, t);
    v = rtlRound(v, 0, 'corr');
    return t < 0 ? v / xpow(10, -t) : v * xpow(10, t);
  });
  fx('SUMSQ', 1, -1, 'number 1; number 2; …', 'The sum of the squares.', (A) => { const s = new LSum(); A.numbers().forEach((x) => s.add(x * x)); return s.get(); });
  fx('SQRTPI', 1, 1, 'number', 'The square root of the number times π.', (A) => { const v = Math.sqrt(A.num(0) * Math.PI); return isFinite(v) ? v : fail(ERR.ARG); });
  const FACT2 = (() => { const t = [1, 1, 2]; let o = 1; let e = 2; let odd = true; for (let n = 3; n <= 300; n++) { if (odd) { o *= n; t[n] = o; } else { e *= n; t[n] = e; } odd = !odd; } return t; })();
  fx('FACTDOUBLE', 1, 1, 'number', 'The double factorial n!!.', (A) => { const n = int32(A.num(0)); if (n < 0 || n > 300) { return fail(ERR.ARG); } const v = FACT2[n]; return isFinite(v) ? v : fail(ERR.ARG); });
  /** The numbers of an add-in's list argument (ranges and arrays opened out; empty cells skipped). */
  function addinList(A, from, to) {
    const out = [];
    for (const it of A.items(from, to)) {
      const v = it.v;
      if (isErr(v)) { throw v; }
      if (v == null) { continue; }
      if (typeof v === 'string') { if (it.ref) { continue; } const p = parseInput(v, A.L.id); if (p.t !== 'n') { return fail(ERR.VALUE); } out.push(p.v); continue; }
      out.push(numOf(v));
    }
    return out;
  }
  fx('MULTINOMIAL', 1, -1, 'number 1; number 2; …', 'The multinomial coefficient of the numbers.', (A) => {
    const list = addinList(A, 0); if (list.some((d) => d < 0)) { return fail(ERR.ARG); }
    let z = 0; let r = 1;
    for (const d of list) { const n = d >= 0 ? approxFloor(d) : approxCeil(d); if (n < 0) { return fail(ERR.ARG); } if (n > 0) { z += n; r *= binomKoeff(z, n); } }
    return isFinite(r) ? r : fail(ERR.ARG);
  });
  fx('SERIESSUM', 4, 4, 'x; n; m; coefficients', 'The sum of a power series.', (A) => {
    const x = A.num(0); let n = A.num(1); const m = A.num(2);
    if (x === 0 && n === 0) { return fail(ERR.VALUE); }
    const co = A.matrix(3); let r = 0;
    if (x !== 0) { for (const row of co.rows) { for (const c of row) { if (isErr(c)) { throw c; } const cv = c == null ? 0 : toNum(c, A.L); r += cv * xpow(x, n); n += m; } } }
    return isFinite(r) ? r : fail(ERR.ARG);
  });
  const gcd2 = (a, b) => { let f = a % b; while (f > 0) { a = b; b = f; f = a % b; } return b; };
  fx('GCD_EXCEL2003', 1, -1, 'number 1; number 2; …', 'The greatest common divisor (Excel 2003 rules).', (A) => { const l = addinList(A, 0).map(Math.trunc).filter((x) => x !== 0); if (l.some((x) => x < 0)) { return fail(ERR.ARG); } if (!l.length) { return 0; } let f = l[0]; for (let i = 1; i < l.length; i++) { f = gcd2(l[i], f); } return f; });
  fx('LCM_EXCEL2003', 1, -1, 'number 1; number 2; …', 'The least common multiple (Excel 2003 rules).', (A) => { const l = addinList(A, 0); if (!l.length) { return 0; } let f = approxFloor(l[0]); if (f < 0) { return fail(ERR.ARG); } if (f === 0) { return 0; } for (let i = 1; i < l.length; i++) { const t = approxFloor(l[i]); if (t < 0) { return fail(ERR.ARG); } f = t * f / gcd2(t, f); if (f === 0) { return 0; } } return f; });
  const bitArgs = (A) => { const a = approxFloor(A.num(0)); const b = approxFloor(A.num(1)); if (a >= 281474976710656 || a < 0 || b >= 281474976710656 || b < 0) { return fail(ERR.ARG); } return [BigInt(a), BigInt(b)]; };
  fx('BITAND', 2, 2, 'number 1; number 2', 'The bitwise AND of two numbers.', (A) => { const [a, b] = bitArgs(A); return Number(a & b); });
  fx('BITOR', 2, 2, 'number 1; number 2', 'The bitwise OR of two numbers.', (A) => { const [a, b] = bitArgs(A); return Number(a | b); });
  fx('BITXOR', 2, 2, 'number 1; number 2', 'The bitwise exclusive OR of two numbers.', (A) => { const [a, b] = bitArgs(A); return Number(a ^ b); });
  fx('BITLSHIFT', 2, 2, 'number; shift', 'The number shifted left by bits.', (A) => { const n = approxFloor(A.num(0)); const s = approxFloor(A.num(1)); if (n >= 281474976710656 || n < 0) { return fail(ERR.ARG); } if (s < 0) { return approxFloor(n / xpow(2, -s)); } return s === 0 ? n : n * xpow(2, s); });
  fx('BITRSHIFT', 2, 2, 'number; shift', 'The number shifted right by bits.', (A) => { const n = approxFloor(A.num(0)); const s = approxFloor(A.num(1)); if (n >= 281474976710656 || n < 0) { return fail(ERR.ARG); } if (s < 0) { return n * xpow(2, -s); } return s === 0 ? n : approxFloor(n / xpow(2, s)); });
  fx('RAWSUBTRACT', 2, -1, 'minuend; subtrahend 1; …', 'Subtracts without Calc’s rounding of nearly equal numbers.', (A) => { let r = A.num(0); for (let i = 1; i < A.n; i++) { r -= A.num(i); } return r; });
  fx('RAND.NV', 0, 0, '', 'A random number between 0 and 1 that does not change on recalculation.', () => Math.random());
  fx('RANDBETWEEN.NV', 2, 2, 'bottom; top', 'A random whole number that does not change on recalculation.', (A) => { const hi = rtlRound(A.num(1), 0, 'up'); const lo = rtlRound(A.num(0), 0, 'up'); if (lo > hi) { return fail(ERR.ARG); } return Math.floor(lo + Math.random() * (hi + 1 - lo)); });
  const EURO = { EUR: [1, 2], ATS: [13.7603, 2], BEF: [40.3399, 0], DEM: [1.95583, 2], ESP: [166.386, 0], FIM: [5.94573, 2], FRF: [6.55957, 2], IEP: [0.787564, 2], ITL: [1936.27, 0], LUF: [40.3399, 0], NLG: [2.20371, 2], PTE: [200.482, 2], GRD: [340.750, 2], SIT: [239.640, 2], MTL: [0.429300, 2], CYP: [0.585274, 2], SKK: [30.1260, 2], EEK: [15.6466, 2], LVL: [0.702804, 2], LTL: [3.45280, 2], HRK: [7.53450, 2] };
  fx('EUROCONVERT', 3, 5, 'value; from currency; to currency; full precision; triangulation precision', 'Converts between the old European currencies and the euro.', (A) => {
    let prec = 0;
    if (A.n === 5) { prec = approxFloor(A.num(4)); if (prec < 3) { return fail(ERR.ARG); } }
    const full = A.n >= 4 && A.bool(3);
    const to = A.str(2).toUpperCase(); const from = A.str(1).toUpperCase(); const v = A.num(0);
    const f = EURO[from]; const t = EURO[to];
    if (!f || !t) { return fail(ERR.ARG); }
    if (from === to) { return v; }
    let r;
    if (from === 'EUR') { r = v * t[0]; } else { let mid = v / f[0]; if (prec) { mid = rtlRound(mid, prec, 'corr'); } r = mid * t[0]; }
    return full ? r : rtlRound(r, t[1], 'corr');
  });
  fx('CONVERT_OOO', 3, 3, 'value; from; to', 'Converts between the euro and the old European currencies (LibreOffice’s table).', (A) => {
    const to = A.str(2); const from = A.str(1); const v = A.num(0);
    if (from === 'EUR' && to !== 'EUR' && EURO[to]) { return v * EURO[to][0]; }
    if (to === 'EUR' && from !== 'EUR' && EURO[from]) { return v / EURO[from][0]; }
    return fail(ERR.NA);
  });
  fx('COLOR', 3, 4, 'red; green; blue; alpha', 'A colour as a number (alpha, red, green, blue each 0–255).', (A) => {
    const al = A.n === 4 ? approxFloor(A.num(3)) : 0; if (al < 0 || al > 255) { return fail(ERR.ARG); }
    const b = approxFloor(A.num(2)); if (b < 0 || b > 255) { return fail(ERR.ARG); }
    const g = approxFloor(A.num(1)); if (g < 0 || g > 255) { return fail(ERR.ARG); }
    const r = approxFloor(A.num(0)); if (r < 0 || r > 255) { return fail(ERR.ARG); }
    return 256 * 256 * 256 * al + 256 * 256 * r + 256 * g + b;
  });
  /**
   * The arguments of SUBTOTAL and AGGREGATE: cells of nested SUBTOTAL/AGGREGATE
   * formulas are left out, and rows filtered (or also hidden) as the sheet
   * says (wb.setRowState), and error values when asked.
   */
  class SubArgs extends Args {
    constructor(nodes, ctx, flags) { super(nodes, ctx); this.flags = flags; }
    /** The numbers among what items() keeps (hidden rows, errors and nested subtotals left out as asked). */
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
    items(from, to) {
      const out = [];
      const end = to === undefined ? this.nodes.length : to;
      const fl = this.flags;
      for (let i = from || 0; i < end; i++) {
        const node = this.nodes[i];
        if (node.k === 'empty') { out.push({ v: null, ref: false }); continue; }
        const v = ev(node, this.ctx);
        if (v instanceof RangeVal) {
          const sh = v.sheet;
          eachCell(v, (r, c) => {
            if ((fl.filtered && sh.filtered && sh.filtered.has(r)) || (fl.hidden && sh.hidden && sh.hidden.has(r))) { return; }
            const cell = sh.cells.get(r * MAXC + c);
            if (fl.nested && cell && cell.ast && cell.ast.info.sub) { return; }
            const x = this.ctx.cellValue(sh, r, c);
            if (fl.errors && isErr(x)) { return; }
            out.push({ v: x, ref: true });
          });
        } else if (v instanceof ArrayVal) { v.rows.forEach((row) => row.forEach((x) => { if (!(fl.errors && isErr(x))) { out.push({ v: x, ref: true }); } })); } else { out.push({ v, ref: false }); }
      }
      return out;
    }
  }
  const SUB_FUNCS = [null, 'AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'PRODUCT', 'STDEV', 'STDEVP', 'SUM', 'VAR', 'VARP', 'MEDIAN', 'MODE.SNGL', 'LARGE', 'SMALL', 'PERCENTILE.INC', 'QUARTILE.INC', 'PERCENTILE.EXC', 'QUARTILE.EXC'];
  fx('SUBTOTAL', 2, -1, 'function; range 1; range 2; …', 'A subtotal that leaves out filtered rows (and hidden rows with 101–111) and other subtotals.', (A, ctx) => {
    let f = Math.trunc(A.num(0));
    const flags = { nested: true, filtered: true, hidden: false, errors: false };
    if (f > 100) { flags.hidden = true; f -= 100; }
    if (f < 1 || f > 11) { return fail(ERR.ARG); }
    return FN[SUB_FUNCS[f]](new SubArgs(A.nodes.slice(1), ctx, flags), ctx);
  });
  fx('AGGREGATE', 3, -1, 'function; option; range 1; …', 'An aggregate (19 functions) that can leave out hidden rows, errors and nested subtotals.', (A, ctx) => {
    const f = Math.trunc(A.num(0)); const o = Math.trunc(A.num(1));
    if (f < 1 || f > 19) { return fail(ERR.ARG); }
    const opts = [{ nested: 1 }, { nested: 1, hidden: 1 }, { nested: 1, errors: 1 }, { nested: 1, hidden: 1, errors: 1 }, {}, { hidden: 1 }, { errors: 1 }, { hidden: 1, errors: 1 }][o];
    if (!opts) { return fail(ERR.ARG); }
    const flags = { nested: !!opts.nested, hidden: !!opts.hidden, filtered: !!opts.hidden, errors: !!opts.errors };
    // AGGREGATE's data are worked out as arrays (Calc's ReferenceOrForceArray): AGGREGATE(14;6;A1:A9/(B1:B9>0);1)
    const ac = arrCtx(ctx);
    return FN[SUB_FUNCS[f]](new SubArgs(A.nodes.slice(2), ac, flags), ac);
  });


  // arrays and matrices
  GRP = 'Array';
  /** A matrix argument that must be all numbers (booleans count): rows of numbers, or #VALUE!. */
  function numMatrix(A, i) {
    const M = A.matrix(i);
    return M.rows.map((row) => row.map((x) => { if (isErr(x)) { throw x; } if (!isNumLike(x)) { return fail(ERR.VALUE); } return numOf(x); }));
  }
  fx('MMULT', 2, 2, 'array 1; array 2', 'The product of two matrices.', (A) => {
    const a = numMatrix(A, 0); const b = numMatrix(A, 1);
    const n = a.length; const m = a[0].length; const l = b[0].length;
    if (m !== b.length) { return fail(ERR.ARG); }
    const out = [];
    for (let i = 0; i < n; i++) { const row = []; for (let j = 0; j < l; j++) { const s = new LSum(0); for (let k = 0; k < m; k++) { s.add(a[i][k] * b[k][j]); } row.push(s.get()); } out.push(row); }
    return new ArrayVal(out);
  });
  fx('TRANSPOSE', 1, 1, 'array', 'The array with rows and columns swapped.', (A) => {
    const M = A.matrix(0);
    const out = [];
    for (let c = 0; c < M.w; c++) { const row = []; for (let r = 0; r < M.h; r++) { row.push(M.rows[r][c]); } out.push(row); }
    return new ArrayVal(out);
  });
  fx('MUNIT', 1, 1, 'size', 'The unit matrix of a size.', (A) => {
    const n = approxFloor(A.num(0));
    if (n < 1 || n > 4294967295) { return fail(ERR.ARG); }
    if (n > 65536) { return fail('Err:538'); }
    const out = []; for (let i = 0; i < n; i++) { const row = new Array(n).fill(0); row[i] = 1; out.push(row); }
    return new ArrayVal(out);
  });
  /** Calc's LUP decomposition with row scaling (Cormen et al.); answers the sign of the determinant, 0 when singular. */
  function lupDecompose(a, n, P) {
    let sign = 1;
    const scale = new Array(n);
    for (let i = 0; i < n; ++i) { let max = 0; for (let j = 0; j < n; ++j) { const t = Math.abs(a[i][j]); if (max < t) { max = t; } } if (max === 0) { return 0; } scale[i] = 1 / max; }
    for (let i = 0; i < n; ++i) { P[i] = i; }
    for (let k = 0; k < n - 1; ++k) {
      let max = 0; const sc = scale[k]; let kp = k;
      for (let i = k; i < n; ++i) { const t = sc * Math.abs(a[i][k]); if (max < t) { max = t; kp = i; } }
      if (max === 0) { return 0; }
      if (k !== kp) { [P[k], P[kp]] = [P[kp], P[k]]; sign = -sign; [scale[k], scale[kp]] = [scale[kp], scale[k]]; [a[k], a[kp]] = [a[kp], a[k]]; }
      for (let i = k + 1; i < n; ++i) {
        const num = a[i][k]; const den = a[k][k];
        a[i][k] = num / den;
        for (let j = k + 1; j < n; ++j) { a[i][j] = (a[i][j] * den - num * a[k][j]) / den; }
      }
    }
    for (let i = 0; i < n; i++) { if (a[i][i] === 0) { return 0; } }
    return sign;
  }
  function lupSolve(lu, n, P, B, X) {
    let first = -1;
    for (let i = 0; i < n; ++i) {
      const s = new LSum(B[P[i]]);
      if (first >= 0) { for (let j = first; j < i; ++j) { s.add(-(lu[i][j] * X[j])); } } else if (s.get() !== 0) { first = i; }
      X[i] = s.get();
    }
    for (let i = n - 1; i >= 0; i--) { const s = new LSum(X[i]); for (let j = i + 1; j < n; ++j) { s.add(-(lu[i][j] * X[j])); } X[i] = s.get() / lu[i][i]; }
  }
  fx('MDETERM', 1, 1, 'array', 'The determinant of a square matrix.', (A) => {
    const a = numMatrix(A, 0); const n = a.length;
    if (n !== a[0].length || !n) { return fail(ERR.ARG); }
    const P = new Array(n); const sign = lupDecompose(a, n, P);
    if (!sign) { return 0; }
    let d = sign; for (let i = 0; i < n; ++i) { d *= a[i][i]; }
    return d;
  });
  fx('MINVERSE', 1, 1, 'array', 'The inverse of a square matrix.', (A) => {
    const a = numMatrix(A, 0); const n = a.length;
    if (n !== a[0].length || !n) { return fail(ERR.ARG); }
    const P = new Array(n);
    if (!lupDecompose(a, n, P)) { return fail(ERR.ARG); }
    const out = Array.from({ length: n }, () => new Array(n));
    const B = new Array(n); const X = new Array(n);
    for (let j = 0; j < n; ++j) { B.fill(0); B[j] = 1; lupSolve(a, n, P, B, X); for (let i = 0; i < n; ++i) { out[i][j] = X[i]; } }
    return new ArrayVal(out);
  });
  fx('FREQUENCY', 2, 2, 'data; classes', 'How many values fall into each class, as a column one longer than the classes.', (A0) => {
    const A = forceArray(A0);
    const bins = seqOf(A, 1, 2);
    const order = bins.map((v, i) => i).sort((p, q) => bins[p] - bins[q] || p - q);
    const sorted = order.map((i) => bins[i]);
    const data = seqOf(A, 0, 1).sort((p, q) => p - q);
    if (!data.length) { return fail(ERR.VALUE); }
    const res = new Array(bins.length + 1).fill(0);
    let i = 0; let j;
    for (j = 0; j < sorted.length; ++j) { let cnt = 0; while (i < data.length && data[i] <= sorted[j]) { ++cnt; ++i; } res[order[j]] = cnt; }
    res[j] = data.length - i;
    return new ArrayVal(res.map((x) => [x]));
  });
  function sumX2(A, kind) {
    const X = A.matrix(0); const Y = A.matrix(1);
    if (X.h !== Y.h || X.w !== Y.w) { return fail(ERR.VALUE); }
    const s = new LSum(0);
    for (let c = 0; c < X.w; c++) {
      for (let r = 0; r < X.h; r++) {
        const x = X.rows[r][c]; const y = Y.rows[r][c];
        if (x == null || y == null || typeof x === 'string' || typeof y === 'string') { continue; }
        if (isErr(x)) { throw x; }
        if (isErr(y)) { throw y; }
        const a = numOf(x); const b = numOf(y);
        if (kind === 'xmy2') { const d = a - b; s.add(d * d); } else { s.add(a * a); s.add(kind === 'x2py2' ? b * b : -(b * b)); }
      }
    }
    return s.get();
  }
  fx('SUMX2MY2', 2, 2, 'array X; array Y', 'The sum of the differences of the squares.', (A) => sumX2(A, 'x2my2'));
  fx('SUMX2PY2', 2, 2, 'array X; array Y', 'The sum of the sums of the squares.', (A) => sumX2(A, 'x2py2'));
  fx('SUMXMY2', 2, 2, 'array X; array Y', 'The sum of the squares of the differences.', (A) => sumX2(A, 'xmy2'));

  /** A column-major matrix as Calc's ScMatrix (get(col, row), getI(index)), for the regressions. */
  class CM {
    constructor(cols, rows, data) { this.c = cols; this.r = rows; this.d = data || new Array(cols * rows).fill(0); }
    static of(M) { const m = new CM(M.w, M.h); for (let c = 0; c < M.w; c++) { for (let r = 0; r < M.h; r++) { m.d[c * M.h + r] = M.rows[r][c]; } } return m; }
    g(c, r) { return this.d[c * this.r + r]; }
    s(v, c, r) { this.d[c * this.r + r] = v; }
    gi(i) { return this.d[i]; }
    si(v, i) { this.d[i] = v; }
    clone() { return new CM(this.c, this.r, this.d.slice()); }
  }
  const sumProd = (a, b, n) => { const s = new LSum(0); for (let i = 0; i < n; i++) { s.add(a.gi(i) * b.gi(i)); } return s.get(); };
  const colNorm = (a, c, r0, n) => { const s = new LSum(0); for (let r = r0; r < n; r++) { s.add(a.g(c, r) * a.g(c, r)); } return Math.sqrt(s.get()); };
  const tColNorm = (a, r, c0, n) => { const s = new LSum(0); for (let c = c0; c < n; c++) { s.add(a.g(c, r) * a.g(c, r)); } return Math.sqrt(s.get()); };
  const colMax = (a, c, r0, n) => { let m = 0; for (let r = r0; r < n; r++) { const v = Math.abs(a.g(c, r)); if (m < v) { m = v; } } return m; };
  const tColMax = (a, r, c0, n) => { let m = 0; for (let c = c0; c < n; c++) { const v = Math.abs(a.g(c, r)); if (m < v) { m = v; } } return m; };
  const colSumProd = (a, ca, b, cb, r0, n) => { const s = new LSum(0); for (let r = r0; r < n; r++) { s.add(a.g(ca, r) * b.g(cb, r)); } return s.get(); };
  const tColSumProd = (a, ra, b, rb, c0, n) => { const s = new LSum(0); for (let c = c0; c < n; c++) { s.add(a.g(c, ra) * b.g(c, rb)); } return s.get(); };
  const sgn = (v) => (v >= 0 ? 1 : -1);
  function qr(a, R, K, N) {
    for (let col = 0; col < K; col++) {
      const scale = colMax(a, col, col, N); if (scale === 0) { return false; }
      for (let row = col; row < N; row++) { a.s(a.g(col, row) / scale, col, row); }
      const eu = colNorm(a, col, col, N); const fac = 1 / eu / (eu + Math.abs(a.g(col, col))); const sg = sgn(a.g(col, col));
      a.s(a.g(col, col) + sg * eu, col, col); R[col] = -sg * scale * eu;
      for (let c = col + 1; c < K; c++) { const s = colSumProd(a, col, a, c, col, N); for (let row = col; row < N; row++) { a.s(a.g(c, row) - s * fac * a.g(col, row), c, row); } }
    }
    return true;
  }
  function tqr(a, R, K, N) {
    for (let row = 0; row < K; row++) {
      const scale = tColMax(a, row, row, N); if (scale === 0) { return false; }
      for (let col = row; col < N; col++) { a.s(a.g(col, row) / scale, col, row); }
      const eu = tColNorm(a, row, row, N); const fac = 1 / eu / (eu + Math.abs(a.g(row, row))); const sg = sgn(a.g(row, row));
      a.s(a.g(row, row) + sg * eu, row, row); R[row] = -sg * scale * eu;
      for (let r = row + 1; r < K; r++) { const s = tColSumProd(a, row, a, r, row, N); for (let col = row; col < N; col++) { a.s(a.g(col, r) - s * fac * a.g(col, row), col, r); } }
    }
    return true;
  }
  function householder(a, c, y, N) { const den = colSumProd(a, c, a, c, c, N); const num = colSumProd(a, c, y, 0, c, N); const f = 2 * (num / den); for (let row = c; row < N; row++) { y.si(y.gi(row) - f * a.g(c, row), row); } }
  function tHouseholder(a, r, y, N) { const den = tColSumProd(a, r, a, r, r, N); const num = tColSumProd(a, r, y, 0, r, N); const f = 2 * (num / den); for (let col = r; col < N; col++) { y.si(y.gi(col) - f * a.g(col, r), col); } }
  function solveUpper(a, R, S, K, tr) { for (let rp = K; rp > 0; rp--) { const row = rp - 1; const s = new LSum(S.gi(row)); for (let col = rp; col < K; col++) { s.add(-((tr ? a.g(row, col) : a.g(col, row)) * S.gi(col))); } S.si(s.get() / R[row], row); } }
  function solveLower(a, R, T, K, tr) { for (let row = 0; row < K; row++) { const s = new LSum(T.gi(row)); for (let col = 0; col < row; col++) { s.add(-((tr ? a.g(col, row) : a.g(row, col)) * T.gi(col))); } T.si(s.get() / R[row], row); } }
  function applyUpper(a, R, B, Z, K, tr) { for (let row = 0; row < K; row++) { const s = new LSum(R[row] * B.gi(row)); for (let col = row + 1; col < K; col++) { s.add((tr ? a.g(row, col) : a.g(col, row)) * B.gi(col)); } Z.si(s.get(), row); } }
  const meanAll = (m, n) => { const s = new LSum(0); for (let i = 0; i < n; i++) { s.add(m.gi(i)); } return s.get() / n; };
  /** Calc's CheckMatrix: the regression's case (1 simple, 2 Y a column, 3 Y a row), K variables, N samples. */
  function regressionData(A, log, xi) {
    const Ym = A.matrix(0);
    let Y = CM.of(Ym);
    for (let i = 0; i < Y.d.length; i++) { const v = Y.d[i]; if (isErr(v)) { throw v; } if (!isNumLike(v)) { return fail(ERR.ARG); } Y.d[i] = numOf(v); }
    if (log) { for (let i = 0; i < Y.d.length; i++) { if (Y.d[i] <= 0) { return fail(ERR.PARAM); } Y.d[i] = xlog(Y.d[i]); } }
    let X; let kase; let K; let N;
    if (xi != null && A.has(xi)) {
      X = CM.of(A.matrix(xi));
      for (let i = 0; i < X.d.length; i++) { const v = X.d[i]; if (isErr(v)) { throw v; } if (!isNumLike(v)) { return fail(ERR.ARG); } X.d[i] = numOf(v); }
      if (X.c === Y.c && X.r === Y.r) { kase = 1; K = 1; N = Y.d.length; } else if (Y.c !== 1 && Y.r !== 1) { return fail(ERR.PARAM); } else if (Y.c === 1) { if (X.r !== Y.r) { return fail(ERR.PARAM); } kase = 2; N = Y.r; K = X.c; } else { if (X.c !== Y.c) { return fail(ERR.PARAM); } kase = 3; N = Y.c; K = X.r; }
    } else {
      X = new CM(Y.c, Y.r); for (let i = 1; i <= Y.d.length; i++) { X.si(i, i - 1); }
      kase = 1; N = Y.d.length; K = 1;
    }
    return { X, Y, kase, K, N };
  }
  function linest(A, log) {
    const stats = A.n === 4 ? A.bool(3) : false;
    const konst = A.n >= 3 && A.has(2) ? A.bool(2) : true;
    const { X, Y, kase, K, N } = regressionData(A, log, A.n >= 2 ? 1 : null);
    if ((konst && N < K + 1) || (!konst && N < K) || N < 1 || K < 1) { return fail(ERR.PARAM); }
    const NA = new CalcError(ERR.NA);
    const res = Array.from({ length: stats ? 5 : 1 }, () => new Array(K + 1).fill(null));
    const put = (v, c, r) => { res[r][c] = v; };
    if (stats) { for (let i = 2; i < K + 1; i++) { put(NA, i, 2); put(NA, i, 3); put(NA, i, 4); } }
    let meanY = 0;
    if (konst) { meanY = meanAll(Y, N); for (let i = 0; i < N; i++) { Y.si(approxSub(Y.gi(i), meanY), i); } }
    const ex = (v) => (log ? xexp(v) : v);
    const exactFit = (df, ssres, ssreg) => df === 0 || ssres === 0 || ssreg === 0;
    if (kase === 1) {
      let meanX = 0;
      if (konst) { meanX = meanAll(X, N); for (let i = 0; i < N; i++) { X.si(approxSub(X.gi(i), meanX), i); } }
      const sxy = sumProd(X, Y, N); const sx2 = sumProd(X, X, N);
      if (sx2 === 0) { return fail(ERR.VALUE); }
      const slope = sxy / sx2; const icpt = konst ? meanY - slope * meanX : 0;
      put(ex(icpt), 1, 0); put(ex(slope), 0, 0);
      if (stats) {
        const ssreg = slope * slope * sx2; put(ssreg, 0, 4);
        const df = konst ? N - 2 : N - 1; put(df, 1, 3);
        const s = new LSum(0); for (let i = 0; i < N; i++) { const t = Y.gi(i) - slope * X.gi(i); s.add(t * t); }
        const ssres = s.get(); put(ssres, 1, 4);
        if (exactFit(df, ssres, ssreg)) { put(0, 1, 4); put(NA, 0, 3); put(0, 1, 2); put(0, 0, 1); put(konst ? 0 : NA, 1, 1); put(1, 0, 2); } else {
          put((ssreg / K) / (ssres / df), 0, 3);
          const rmse = Math.sqrt(ssres / df); put(rmse, 1, 2);
          put(rmse / Math.sqrt(sx2), 0, 1);
          put(konst ? rmse * Math.sqrt(meanX * meanX / sx2 + 1 / N) : NA, 1, 1);
          put(ssreg / (ssreg + ssres), 0, 2);
        }
      }
      return new ArrayVal(res);
    }
    const tr = kase === 3;
    const R = new Array(N);
    const means = new CM(tr ? 1 : K, tr ? K : 1);
    const Z = stats ? Y.clone() : Y;
    const slopes = new CM(tr ? K : 1, tr ? 1 : K);
    if (konst) { centre(X, means, K, N, tr); }
    if (!(tr ? tqr(X, R, K, N) : qr(X, R, K, N))) { return fail(ERR.VALUE); }
    for (let i = 0; i < K; i++) { if (R[i] === 0) { return fail(ERR.VALUE); } }
    for (let i = 0; i < K; i++) { if (tr) { tHouseholder(X, i, Z, N); } else { householder(X, i, Z, N); } }
    for (let i = 0; i < K; i++) { slopes.si(Z.gi(i), i); }
    solveUpper(X, R, slopes, K, tr);
    const icpt = konst ? meanY - sumProd(means, slopes, K) : 0;
    put(ex(icpt), K, 0);
    for (let i = 0; i < K; i++) { put(ex(slopes.gi(i)), K - 1 - i, 0); }
    if (stats) {
      for (let i = 0; i < N; i++) { Z.si(0, i); }
      applyUpper(X, R, slopes, Z, K, tr);
      for (let i = K; i > 0; i--) { if (tr) { tHouseholder(X, i - 1, Z, N); } else { householder(X, i - 1, Z, N); } }
      const ssreg = sumProd(Z, Z, N);
      for (let i = 0; i < N; i++) { Y.si(Y.gi(i) - Z.gi(i), i); }
      const ssres = sumProd(Y, Y, N);
      put(ssreg, 0, 4); put(ssres, 1, 4);
      const df = konst ? N - K - 1 : N - K; put(df, 1, 3);
      if (exactFit(df, ssres, ssreg)) {
        put(0, 1, 4); put(NA, 0, 3); put(0, 1, 2);
        for (let i = 0; i < K; i++) { put(0, K - 1 - i, 1); }
        put(konst ? 0 : NA, K, 1); put(1, 0, 2);
      } else {
        put((ssreg / K) / (ssres / df), 0, 3);
        const rmse = Math.sqrt(ssres / df); put(rmse, 1, 2);
        const si = new LSum(0);
        for (let col = 0; col < K; col++) {
          for (let i = 0; i < K; i++) { Z.si(0, i); }
          Z.si(1, col);
          solveLower(X, R, Z, K, tr); solveUpper(X, R, Z, K, tr);
          put(rmse * Math.sqrt(Z.gi(col)), K - 1 - col, 1);
          if (konst) { si.add(sumProd(means, Z, K) * means.gi(col)); }
        }
        put(konst ? rmse * Math.sqrt(new LSum(si.get()).add(1 / N).get()) : NA, K, 1);
        put(ssreg / (ssreg + ssres), 0, 2);
      }
    }
    return new ArrayVal(res);
  }
  /** Subtract the mean of each variable (column for case 2, row for case 3) from X. */
  function centre(X, means, K, N, tr) {
    if (!tr) {
      for (let i = 0; i < K; i++) { const s = new LSum(0); for (let k = 0; k < N; k++) { s.add(X.g(i, k)); } means.si(s.get() / N, i); }
      for (let i = 0; i < K; i++) { for (let k = 0; k < N; k++) { X.s(approxSub(X.g(i, k), means.gi(i)), i, k); } }
    } else {
      for (let k = 0; k < K; k++) { const s = new LSum(0); for (let i = 0; i < N; i++) { s.add(X.g(i, k)); } means.si(s.get() / N, k); }
      for (let k = 0; k < K; k++) { for (let i = 0; i < N; i++) { X.s(approxSub(X.g(i, k), means.gi(k)), i, k); } }
    }
  }
  fx('LINEST', 1, 4, 'data Y; data X; linear type; stats', 'The parameters of a linear trend (and its statistics), as an array.', (A) => linest(A, false));
  fx('LOGEST', 1, 4, 'data Y; data X; function type; stats', 'The parameters of an exponential trend (and its statistics), as an array.', (A) => linest(A, true));
  function trendGrowth(A, growth) {
    const konst = A.n === 4 ? A.bool(3) : true;
    const { X, Y, kase, K, N } = regressionData(A, growth, A.n >= 2 ? 1 : null);
    if ((konst && N < K + 1) || (!konst && N < K) || N < 1 || K < 1) { return fail(ERR.PARAM); }
    let NX;
    if (A.n >= 3 && A.has(2)) {
      NX = CM.of(A.matrix(2));
      if ((kase === 2 && K !== NX.c) || (kase === 3 && K !== NX.r)) { return fail(ERR.ARG); }
      for (let i = 0; i < NX.d.length; i++) { const v = NX.d[i]; if (isErr(v)) { throw v; } if (!isNumLike(v)) { return fail(ERR.ARG); } NX.d[i] = numOf(v); }
    } else { NX = X.clone(); }
    const res = kase === 1 ? new CM(NX.c, NX.r) : kase === 2 ? new CM(1, NX.r) : new CM(NX.c, 1);
    let meanY = 0;
    if (konst) { meanY = meanAll(Y, N); for (let i = 0; i < N; i++) { Y.si(approxSub(Y.gi(i), meanY), i); } }
    const ex = (v) => (growth ? xexp(v) : v);
    if (kase === 1) {
      let meanX = 0;
      if (konst) { meanX = meanAll(X, N); for (let i = 0; i < N; i++) { X.si(approxSub(X.gi(i), meanX), i); } }
      const sxy = sumProd(X, Y, N); const sx2 = sumProd(X, X, N);
      if (sx2 === 0) { return fail(ERR.VALUE); }
      const slope = sxy / sx2; const icpt = konst ? meanY - slope * meanX : 0;
      for (let i = 0; i < NX.d.length; i++) { res.si(ex(NX.gi(i) * slope + icpt), i); }
    } else {
      const tr = kase === 3;
      const R = new Array(N);
      const means = new CM(tr ? 1 : K, tr ? K : 1);
      const slopes = new CM(tr ? K : 1, tr ? 1 : K);
      if (konst) { centre(X, means, K, N, tr); }
      if (!(tr ? tqr(X, R, K, N) : qr(X, R, K, N))) { return fail(ERR.VALUE); }
      for (let i = 0; i < K; i++) { if (R[i] === 0) { return fail(ERR.VALUE); } }
      for (let i = 0; i < K; i++) { if (tr) { tHouseholder(X, i, Y, N); } else { householder(X, i, Y, N); } }
      for (let i = 0; i < K; i++) { slopes.si(Y.gi(i), i); }
      solveUpper(X, R, slopes, K, tr);
      if (!tr) { for (let row = 0; row < NX.r; row++) { const s = new LSum(0); for (let k = 0; k < K; k++) { s.add(NX.g(k, row) * slopes.g(0, k)); } res.s(s.get(), 0, row); } } else { for (let col = 0; col < NX.c; col++) { const s = new LSum(0); for (let k = 0; k < K; k++) { s.add(slopes.g(k, 0) * NX.g(col, k)); } res.s(s.get(), col, 0); } }
      const icpt = konst ? meanY - sumProd(means, slopes, K) : 0;
      for (let i = 0; i < res.d.length; i++) { res.si(ex(res.gi(i) + icpt), i); }
    }
    const out = []; for (let r = 0; r < res.r; r++) { const row = []; for (let c = 0; c < res.c; c++) { row.push(res.g(c, r)); } out.push(row); }
    return new ArrayVal(out);
  }
  fx('TREND', 1, 4, 'data Y; data X; new data X; linear type', 'Values on a linear trend.', (A) => trendGrowth(A, false));
  fx('GROWTH', 1, 4, 'data Y; data X; new data X; function type', 'Values on an exponential trend.', (A) => trendGrowth(A, true));

  // database functions: DSUM(database; field; criteria) and the rest
  GRP = 'Database';
  /**
   * The values of the field column in the records that meet the criteria, as
   * Calc's database functions find them: the criteria range's first row names
   * fields, a row's conditions all apply (AND), the rows are alternatives (OR),
   * an empty condition is none. Answers { values, records, col }.
   */
  function dbRecords(A, ctx, allowMissing) {
    const db = A.ref(0, ERR.PARAM);
    const crit = A.ref(2, ERR.PARAM);
    const sh = db.sheet;
    const header = (c) => { const v = ctx.cellValue(sh, db.r0, c); return v == null ? '' : typeof v === 'number' ? general(v) : String(v); };
    const findField = (name) => { const up = String(name).toUpperCase(); for (let c = db.c0; c <= db.c1; c++) { if (header(c).toUpperCase() === up) { return c; } } return -1; };
    let col; let missing = false;
    const fnode = A.nodes[1];
    if (fnode.k === 'empty') { if (!allowMissing) { return fail(ERR.PARAM); } missing = true; } else {
      const f = A.raw(1);
      let v = f;
      if (f instanceof RangeVal) { if (!f.single) { if (allowMissing && f.r0 === db.r0 && f.c0 === db.c0 && f.r1 === db.r1 && f.c1 === db.c1) { missing = true; } else { return fail(ERR.PARAM); } } else { v = ctx.cellValue(f.sheet, f.r0, f.c0); } }
      if (!missing) {
        if (isErr(v)) { throw v; }
        if (typeof v === 'number' || typeof v === 'boolean') { const n = approxFloor(numOf(v)); if (allowMissing && n === 0) { missing = true; } else { col = db.c0 + n - 1; } } else { col = findField(v == null ? '' : v); }
        if (!missing && (col < 0 || col >= MAXC || (col < db.c0 && typeof v === 'string'))) { return fail(ERR.PARAM); }
        if (!missing && (col < db.c0 || col > db.c1)) { return fail(col < db.c0 ? ERR.PARAM : ERR.VALUE); }
      }
    }
    // the criteria
    const fields = [];
    for (let c = crit.c0; c <= crit.c1; c++) { const v = ctx.cellValue(crit.sheet, crit.r0, c); const fc = findField(v == null ? '' : typeof v === 'number' ? general(v) : v); if (fc < 0) { return fail(ERR.PARAM); } fields.push(fc); }
    const groups = [];
    for (let r = crit.r0 + 1; r <= crit.r1; r++) {
      const conds = [];
      for (let c = crit.c0; c <= crit.c1; c++) {
        const v = ctx.cellValue(crit.sheet, r, c);
        if (v == null || v === '') { continue; }
        if (isErr(v)) { throw v; }
        conds.push({ col: fields[c - crit.c0], ok: criterion(v, ctx.L) });
      }
      if (conds.length) { groups.push(conds); }
    }
    if (missing) { col = groups.length ? groups[0][0].col : db.c0; }
    const values = []; let records = 0;
    for (let r = db.r0 + 1; r <= db.r1; r++) {
      if (groups.length && !groups.some((g) => g.every((k) => k.ok(ctx.cellValue(sh, r, k.col))))) { continue; }
      records++;
      values.push(ctx.cellValue(sh, r, col));
    }
    return { values, records, missing };
  }
  const dbNums = (A, ctx) => { const out = []; for (const v of dbRecords(A, ctx, false).values) { if (isErr(v)) { throw v; } if (isNumLike(v)) { out.push(numOf(v)); } } return out; };
  const dbSyntax = 'database; field; criteria';
  fx('DSUM', 3, 3, dbSyntax, 'The sum of a field over the records that meet the criteria.', (A, ctx) => { const s = new LSum(0); dbNums(A, ctx).forEach((x) => s.add(x)); return s.get(); });
  fx('DAVERAGE', 3, 3, dbSyntax, 'The average of a field over the records that meet the criteria.', (A, ctx) => { const v = dbNums(A, ctx); if (!v.length) { return fail(ERR.DIV0); } const s = new LSum(0); v.forEach((x) => s.add(x)); return s.get() / v.length; });
  fx('DMAX', 3, 3, dbSyntax, 'The largest value of a field over the records that meet the criteria.', (A, ctx) => { const v = dbNums(A, ctx); return v.length ? Math.max(...v) : 0; });
  fx('DMIN', 3, 3, dbSyntax, 'The smallest value of a field over the records that meet the criteria.', (A, ctx) => { const v = dbNums(A, ctx); return v.length ? Math.min(...v) : 0; });
  fx('DPRODUCT', 3, 3, dbSyntax, 'The product of a field over the records that meet the criteria.', (A, ctx) => { const v = dbNums(A, ctx); return v.length ? v.reduce((p, x) => p * x, 1) : 0; });
  fx('DCOUNT', 2, 3, dbSyntax, 'Counts the records that meet the criteria and hold a number in the field.', (A, ctx) => { const d = dbRecords(A, ctx, true); if (d.missing) { return d.records; } let n = 0; for (const v of d.values) { if (isErr(v)) { throw v; } if (isNumLike(v)) { n++; } } return n; });
  fx('DCOUNTA', 2, 3, dbSyntax, 'Counts the records that meet the criteria and are not empty in the field.', (A, ctx) => { const d = dbRecords(A, ctx, true); let n = 0; for (const v of d.values) { if (isErr(v)) { throw v; } if (v != null) { n++; } } return n; });
  fx('DGET', 3, 3, dbSyntax, 'The one value of a field in the single record that meets the criteria.', (A, ctx) => {
    const vals = dbRecords(A, ctx, false).values.filter((v) => v != null);
    if (!vals.length) { return fail(ERR.VALUE); }
    if (vals.length > 1) { return fail(ERR.ARG); }
    if (isErr(vals[0])) { throw vals[0]; }
    return vals[0];
  });
  const dbVar = (A, ctx) => { const v = dbNums(A, ctx); const s = new LSum(0); v.forEach((x) => s.add(x)); const m = s.get() / v.length; const q = new LSum(0); v.forEach((x) => q.add((x - m) * (x - m))); return { ss: q.get(), n: v.length }; };
  fx('DSTDEV', 3, 3, dbSyntax, 'The standard deviation of a sample, over the records that meet the criteria.', (A, ctx) => { const d = dbVar(A, ctx); return Math.sqrt(d.ss / (d.n - 1)); });
  fx('DSTDEVP', 3, 3, dbSyntax, 'The standard deviation of a population, over the records that meet the criteria.', (A, ctx) => { const d = dbVar(A, ctx); return Math.sqrt(d.ss / d.n); });
  fx('DVAR', 3, 3, dbSyntax, 'The variance of a sample, over the records that meet the criteria.', (A, ctx) => { const d = dbVar(A, ctx); return d.ss / (d.n - 1); });
  fx('DVARP', 3, 3, dbSyntax, 'The variance of a population, over the records that meet the criteria.', (A, ctx) => { const d = dbVar(A, ctx); return d.ss / d.n; });

  // dates and times
  GRP = 'Date & Time';
  const NULLDAYS = 693594; // the day number of 1899-12-30 counted from 0001-01-01 = 1, as the add-ins count
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  /** A date argument as an add-in takes it: a whole number, the date the serial falls on. */
  const dayArg = (A, i) => int32(A.num(i));
  fx('DAYS360', 2, 3, 'start; end; method', 'The days between two dates in a 360-day year.', (A) => {
    const eu = A.n === 3 && A.bool(2);
    let d1 = Math.floor(dateArg(A, 0)); let d2 = Math.floor(dateArg(A, 1)); let sign = 1;
    if (eu && d2 < d1) { [d1, d2] = [d2, d1]; sign = -1; }
    const a = serialToYmd(d1); const b = serialToYmd(d2);
    if (a.d === 31) { a.d -= 1; } else if (!eu && a.m === 2) { if (a.d === 28 && !isLeap(a.y)) { a.d = 30; } else if (a.d === 29) { a.d = 30; } }
    if (b.d === 31) { if (!eu) { if (a.d === 30) { b.d -= 1; } } else { b.d = 30; } }
    return sign * (b.d + b.m * 30 + b.y * 360 - a.d - a.m * 30 - a.y * 360);
  });
  // with a second argument it is the old ODF ISOWEEKNUM(date; mode), which Calc reads as WEEKNUM_OOO
  fx('ISOWEEKNUM', 1, 2, 'date', 'The ISO 8601 week number of a date.', (A, ctx) => (A.n > 1 ? FN.WEEKNUM_OOO(A, ctx) : weekNum(Math.floor(A.num(0)), 21)));
  fx('WEEKNUM_OOO', 2, 2, 'date; mode', 'The week number, weeks starting on Sunday (1) or Monday (other modes).', (A) => { const mode = Math.trunc(A.num(1)); const d = Math.floor(dateArg(A, 0)); return mode === 1 ? weekNumMin4(d, 0) : weekNumMin4(d, 1); });
  /** tools::Date::GetWeekOfYear with 4 days minimum in the first week (Calc's old WEEKNUM). */
  function weekNumMin4(d, start) {
    const wd = (dayOfWeek(d) - start + 7) % 7;
    const thursday = d - wd + 3;
    const y = serialToYmd(thursday).y;
    return Math.floor((thursday - ymdToSerial(y, 1, 1)) / 7) + 1;
  }
  fx('WEEKNUM_EXCEL2003', 2, 2, 'date; mode', 'The week number as Excel 2003 counts it.', (A) => { const d = dayArg(A, 0); const mode = int32(A.num(1)); const y = serialToYmd(d).y; const first = ymdToSerial(y, 1, 1); const fdw = (dayOfWeek(first) + 6) % 7; return Math.trunc((d - first + (mode === 1 ? (fdw + 1) % 7 : fdw)) / 7) + 1; });
  fx('EASTERSUNDAY', 1, 1, 'year', 'The date of Easter Sunday in a year.', (A) => {
    let y = Math.trunc(A.num(0)); if (y < 100) { y = fullYear(y); }
    if (y < 1583 || y > 9956) { return fail(ERR.ARG); }
    const N = y % 19; const B = Math.trunc(y / 100); const C = y % 100; const D = Math.trunc(B / 4); const E = B % 4; const F = Math.trunc((B + 8) / 25); const G = Math.trunc((B - F + 1) / 3);
    const H = (19 * N + B - D - G + 15) % 30; const I = Math.trunc(C / 4); const K = C % 4; const L = (32 + 2 * E + 2 * I - H - K) % 7; const M = Math.trunc((N + 11 * H + 22 * L) / 451); const O = H + L - 7 * M + 114;
    return ymdToSerial(y, Math.trunc(O / 31), O % 31 + 1);
  });
  /** The weekend of NETWORKDAYS.INTL and WORKDAY.INTL: 1–7, 11–17 or a string of seven 0/1 from Monday. Index 0 = Sunday. */
  function weekendMask(A, i, workday) {
    const mask = [true, false, false, false, false, false, true];
    if (!A.has(i)) { return mask; }
    const v = A.raw(i);
    if (v instanceof RangeVal && !v.single) { return fail(ERR.VALUE); }
    const x = deref(v, A.ctx);
    if (typeof x === 'number' || typeof x === 'boolean') {
      const n = numOf(x);
      if (n < 1 || n > 17) { return fail(ERR.VALUE); }
      const code = String(n);
      const m = [false, false, false, false, false, false, false];
      if (code.length === 1) { const k = Number(code); if (k > 7) { return fail(ERR.ARG); } const days = [[6, 0], [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]][k - 1]; days.forEach((d) => { m[d] = true; }); return m; }
      if (code.length === 2 && code[0] === '1' && /^[1-7]$/.test(code[1])) { m[[0, 1, 2, 3, 4, 5, 6][Number(code[1]) - 1]] = true; return m; }
      return fail(ERR.ARG);
    }
    const s = x == null ? '' : String(x);
    if (s.length !== 7 || (workday && s === '1111111')) { return fail(ERR.VALUE); }
    if (!/^[01]{7}$/.test(s)) { return fail(ERR.ARG); }
    return [s[6] === '1', s[0] === '1', s[1] === '1', s[2] === '1', s[3] === '1', s[4] === '1', s[5] === '1'];
  }
  function holidaySet(A, i) {
    const set = new Set();
    if (!A.has(i)) { return set; }
    for (const it of A.items(i, i + 1)) { const v = it.v; if (isErr(v)) { throw v; } if (v == null) { continue; } if (typeof v === 'string') { if (it.ref) { continue; } const p = parseInput(v, A.L.id); if (p.t !== 'n') { return fail(ERR.VALUE); } set.add(approxFloor(p.v)); continue; } set.add(approxFloor(numOf(v))); }
    return set;
  }
  fx('NETWORKDAYS.INTL', 2, 4, 'start; end; weekend; holidays', 'The working days between two dates, with a chosen weekend.', (A) => {
    const mask = weekendMask(A, 2, false); const hol = holidaySet(A, 3);
    let d1 = Math.floor(dateArg(A, 0)); let d2 = Math.floor(dateArg(A, 1));
    if (d1 + NULLDAYS < 0 || d2 + NULLDAYS < 0) { return fail(ERR.ARG); }
    const rev = d1 > d2; if (rev) { [d1, d2] = [d2, d1]; }
    let n = 0; for (let d = d1; d <= d2; d++) { if (!mask[dayOfWeek(d)] && !hol.has(d)) { n++; } }
    return rev ? -n : n;
  });
  fx('WORKDAY.INTL', 2, 4, 'start; days; weekend; holidays', 'The date some working days away, with a chosen weekend.', (A) => {
    const mask = weekendMask(A, 2, true); const hol = holidaySet(A, 3);
    let days = Math.floor(approxValue(A.num(1))); let d = Math.floor(dateArg(A, 0));
    if (d + NULLDAYS < 0) { return fail(ERR.ARG); }
    if (!days) { return d; }
    const step = days > 0 ? 1 : -1;
    while (days) { do { d += step; } while (mask[dayOfWeek(d)]); if (!hol.has(d)) { days -= step; } }
    return d;
  });
  fx('NETWORKDAYS_EXCEL2003', 2, 3, 'start; end; holidays', 'The working days between two dates (Excel 2003 rules).', (A) => {
    const hol = holidaySet(A, 2); const s = dayArg(A, 0); const e = dayArg(A, 1);
    let n = 0;
    if (s <= e) { for (let d = s; d <= e; d++) { const w = dayOfWeek(d); if (w !== 0 && w !== 6 && !hol.has(d)) { n++; } } } else { for (let d = s; d >= e; d--) { const w = dayOfWeek(d); if (w !== 0 && w !== 6 && !hol.has(d)) { n--; } } }
    return n;
  });
  const basisArg = (A, i) => { const b = A.has(i) ? int32(A.num(i)) : 0; if (b < 0 || b > 4) { return fail(ERR.ARG); } return b; };
  /** YEARFRAC as the Analysis add-in counts it (GetYearFrac). */
  function yearFrac(start, end, mode) {
    if (start === end) { return 0; }
    if (start > end) { [start, end] = [end, start]; }
    const a = serialToYmd(start); const b = serialToYmd(end);
    let d1 = a.d; let d2 = b.d; let diff;
    switch (mode) {
      case 0:
        if (d1 === 31) { d1--; }
        if (d1 === 30 && d2 === 31) { d2--; } else if (a.m === 2 && d1 === (isLeap(a.y) ? 29 : 28)) { d1 = 30; if (b.m === 2 && d2 === (isLeap(b.y) ? 29 : 28)) { d2 = 30; } }
        diff = (b.y - a.y) * 360 + (b.m - a.m) * 30 + (d2 - d1); break;
      case 1: case 2: case 3: diff = end - start; break;
      case 4: if (d1 === 31) { d1--; } if (d2 === 31) { d2--; } diff = (b.y - a.y) * 360 + (b.m - a.m) * 30 + (d2 - d1); break;
      default: return fail(ERR.ARG);
    }
    let diy;
    if (mode === 0 || mode === 2 || mode === 4) { diy = 360; } else if (mode === 3) { diy = 365; } else {
      const yd = a.y !== b.y;
      if (yd && (b.y !== a.y + 1 || a.m < b.m || (a.m === b.m && a.d < b.d))) { let cnt = 0; for (let y = a.y; y <= b.y; y++) { cnt += isLeap(y) ? 366 : 365; } diy = cnt / (b.y - a.y + 1); } else if (!yd && isLeap(a.y)) { diy = 366; } else if (yd && ((isLeap(a.y) && (a.m < 2 || (a.m === 2 && a.d <= 29))) || (isLeap(b.y) && (b.m > 2 || (b.m === 2 && b.d === 29))))) { diy = 366; } else { diy = 365; }
    }
    return diff / diy;
  }
  fx('YEARFRAC', 2, 3, 'start; end; basis', 'The fraction of a year between two dates.', (A) => yearFrac(dayArg(A, 0), dayArg(A, 1), basisArg(A, 2)));
  fx('DAYSINMONTH', 1, 1, 'date', 'The number of days in the month of a date.', (A) => { const p = serialToYmd(dayArg(A, 0)); return daysInMonth(p.y, p.m); });
  fx('DAYSINYEAR', 1, 1, 'date', 'The number of days in the year of a date.', (A) => (isLeap(serialToYmd(dayArg(A, 0)).y) ? 366 : 365));
  fx('ISLEAPYEAR', 1, 1, 'date', 'TRUE when the date falls in a leap year.', (A) => (isLeap(serialToYmd(dayArg(A, 0)).y) ? 1 : 0));
  fx('WEEKSINYEAR', 1, 1, 'date', 'The number of ISO weeks in the year of a date.', (A) => { const y = serialToYmd(dayArg(A, 0)).y; const w = (dayOfWeek(ymdToSerial(y, 1, 1)) + 6) % 7; return w === 3 ? 53 : w === 2 ? (isLeap(y) ? 53 : 52) : 52; });
  const diffMonths = (s, e, mode) => {
    if (mode !== 0 && mode !== 1) { return fail(ERR.ARG); }
    const a = serialToYmd(s); const b = serialToYmd(e);
    let r = b.m - a.m + (b.y - a.y) * 12;
    if (mode === 1 || s === e) { return r; }
    if (s < e) { if (a.d > b.d) { r -= 1; } } else if (a.d < b.d) { r += 1; }
    return r;
  };
  fx('MONTHS', 3, 3, 'start; end; type', 'The months between two dates (0 whole months, 1 calendar months).', (A) => diffMonths(dayArg(A, 0), dayArg(A, 1), int32(A.num(2))));
  fx('YEARS', 3, 3, 'start; end; type', 'The years between two dates (0 whole years, 1 calendar years).', (A) => { const s = dayArg(A, 0); const e = dayArg(A, 1); const mode = int32(A.num(2)); if (mode !== 0 && mode !== 1) { return fail(ERR.ARG); } if (mode !== 1) { return Math.trunc(diffMonths(s, e, mode) / 12); } return serialToYmd(e).y - serialToYmd(s).y; });
  fx('WEEKS', 3, 3, 'start; end; type', 'The weeks between two dates (0 whole weeks, 1 calendar weeks from Monday).', (A) => { const s = dayArg(A, 0); const e = dayArg(A, 1); const mode = int32(A.num(2)); if (mode === 0) { return Math.trunc((e - s) / 7); } if (mode === 1) { return Math.floor((e + NULLDAYS - 1) / 7) - Math.floor((s + NULLDAYS - 1) / 7); } return fail(ERR.ARG); });

  // financial functions
  GRP = 'Financial';
  const getPMT = (r, n, pv, fv, adv) => (r === 0 ? -((pv + fv) / n) : -(adv ? (fv + pv * xexp(n * Math.log1p(r))) * r / (Math.expm1((n + 1) * Math.log1p(r)) - r) : (fv + pv * xexp(n * Math.log1p(r))) * r / Math.expm1(n * Math.log1p(r))));
  const getFV = (r, n, pmt, pv, adv) => { if (r === 0) { return -(pv + pmt * n); } const t = xpow(1 + r, n); return -(adv ? pv * t + pmt * (1 + r) * (t - 1) / r : pv * t + pmt * (t - 1) / r); };
  fx('SLN', 3, 3, 'cost; salvage; life', 'Straight-line depreciation for one period.', (A) => { const life = A.num(2); if (life === 0) { return fail(ERR.DIV0); } return (A.num(0) - A.num(1)) / life; });
  fx('SYD', 4, 4, 'cost; salvage; life; period', 'Sum-of-years’ digits depreciation for a period.', (A) => { const c = A.num(0); const s = A.num(1); const l = A.num(2); const p = A.num(3); return ((c - s) * (l - p + 1)) / ((l * (l + 1)) / 2); });
  function ddb(cost, salvage, life, period, factor) {
    let rate = factor / life; let old;
    if (rate >= 1) { rate = 1; old = period === 1 ? cost : 0; } else { old = cost * xpow(1 - rate, period - 1); }
    const nw = cost * xpow(1 - rate, period);
    const d = nw < salvage ? old - salvage : old - nw;
    return d < 0 ? 0 : d;
  }
  fx('DDB', 4, 5, 'cost; salvage; life; period; factor', 'Declining-balance depreciation (double by default) for a period.', (A) => { const f = A.n === 5 ? A.num(4) : 2; const p = A.num(3); const l = A.num(2); const s = A.num(1); const c = A.num(0); if (c < 0 || s < 0 || f <= 0 || s > c || p < 1 || p > l) { return fail(ERR.ARG); } return ddb(c, s, l, p, f); });
  fx('DB', 4, 5, 'cost; salvage; life; period; months', 'Fixed-declining-balance depreciation for a period.', (A) => {
    const months = A.n === 4 ? 12 : approxFloor(A.num(4)); const p = A.num(3); const l = A.num(2); const s = A.num(1); const c = A.num(0);
    if (months < 1 || months > 12 || l > 1200 || s < 0 || p > l + 1 || s > c || c <= 0 || l <= 0 || p <= 0) { return fail(ERR.ARG); }
    let rate = 1 - xpow(s / c, 1 / l);
    rate = approxFloor((rate * 1000) + 0.5) / 1000;
    const first = c * rate * months / 12;
    if (approxFloor(p) === 1) { return first; }
    const sum = new LSum(first); let d = 0;
    const imax = Math.trunc(approxFloor(Math.min(l, p)));
    for (let i = 2; i <= imax; i++) { d = -new LSum(sum.get()).add(-c).get() * rate; sum.add(d); }
    if (p > l) { d = -new LSum(sum.get()).add(-c).get() * rate * (12 - months) / 12; }
    return d;
  });
  function interVDB(cost, salvage, life, life1, period, factor) {
    const v = new LSum(0); const intEnd = approxCeil(period); const loopEnd = intEnd;
    let sln = 0; let rest = cost - salvage; let nowSln = false;
    for (let i = 1; i <= loopEnd; i++) {
      let term;
      if (!nowSln) { const d = ddb(cost, salvage, life, i, factor); sln = rest / (life1 - (i - 1)); if (sln > d) { term = sln; nowSln = true; } else { term = d; rest -= d; } } else { term = sln; }
      if (i === loopEnd) { term *= (period + 1 - intEnd); }
      v.add(term);
    }
    return v.get();
  }
  fx('VDB', 5, 7, 'cost; salvage; life; start; end; factor; no switch', 'Variable declining-balance depreciation over a span of periods.', (A) => {
    const noSwitch = A.n === 7 && A.bool(6); const factor = A.n >= 6 ? A.num(5) : 2;
    const end = A.num(4); const start = A.num(3); const life = A.num(2); const salvage = A.num(1); let cost = A.num(0);
    if (start < 0 || end < start || end > life || cost < 0 || salvage > cost || factor <= 0) { return fail(ERR.ARG); }
    const is = approxFloor(start); const ie = approxCeil(end);
    if (noSwitch) {
      const v = new LSum(0);
      for (let i = is + 1; i <= ie; i++) { let t = ddb(cost, salvage, life, i, factor); if (i === is + 1) { t *= Math.min(end, is + 1) - start; } else if (i === ie) { t *= end + 1 - ie; } v.add(t); }
      return v.get();
    }
    let part = 0;
    if (!lApproxEq(start, is) || !lApproxEq(end, ie)) {
      if (!lApproxEq(start, is)) { const tv = cost - interVDB(cost, salvage, life, life, is, factor); part += (start - is) * interVDB(tv, salvage, life, life - is, 1, factor); }
      if (!lApproxEq(end, ie)) { const ts = ie - 1; const tv = cost - interVDB(cost, salvage, life, life, ts, factor); part += (ie - end) * interVDB(tv, salvage, life, life - ts, ie - ts, factor); }
    }
    cost -= interVDB(cost, salvage, life, life, is, factor);
    return new LSum(interVDB(cost, salvage, life, life - is, ie - is, factor)).add(-part).get();
  });
  fx('ISPMT', 4, 4, 'rate; period; periods; present value', 'The interest paid in a period of a loan with even principal payments.', (A) => { const r = A.num(0); const p = A.num(1); const t = A.num(2); const inv = A.num(3); return inv * r * (p / t - 1); });
  fx('PDURATION', 3, 3, 'rate; present value; future value', 'The periods an investment needs to reach a value.', (A) => { const r = A.num(0); const pv = A.num(1); const fv = A.num(2); if (fv <= 0 || pv <= 0 || r <= 0) { return fail(ERR.ARG); } return xlog(fv / pv) / Math.log1p(r); });
  fx('RRI', 3, 3, 'periods; present value; future value', 'The equivalent interest rate for the growth of an investment.', (A) => { const n = A.num(0); const pv = A.num(1); const fv = A.num(2); if (n <= 0 || pv === 0) { return fail(ERR.ARG); } return xpow(fv / pv, 1 / n) - 1; });
  fx('EFFECT', 2, 2, 'nominal rate; periods', 'The effective annual interest rate.', (A) => { const nom = A.num(0); let p = A.num(1); if (p < 1 || nom < 0) { return fail(ERR.ARG); } if (nom === 0) { return 0; } p = approxFloor(p); return xpow(1 + nom / p, p) - 1; });
  fx('NOMINAL', 2, 2, 'effective rate; periods', 'The nominal annual interest rate.', (A) => { const eff = A.num(0); let p = A.num(1); if (p < 1 || eff <= 0) { return fail(ERR.ARG); } p = approxFloor(p); return (xpow(eff + 1, 1 / p) - 1) * p; });
  fx('EFFECT_ADD', 2, 2, 'nominal rate; periods', 'The effective annual interest rate (Analysis add-in).', (A) => { const nom = A.num(0); const p = int32(A.num(1)); if (p < 1 || nom <= 0) { return fail(ERR.ARG); } return xpow(1 + nom / p, p) - 1; });
  fx('NOMINAL_ADD', 2, 2, 'effective rate; periods', 'The nominal annual interest rate (Analysis add-in).', (A) => { const eff = A.num(0); const p = int32(A.num(1)); if (eff <= 0 || p < 0) { return fail(ERR.ARG); } const v = (xpow(eff + 1, 1 / p) - 1) * p; return isFinite(v) ? v : fail(ERR.ARG); });
  function cumFn(A, principal) {
    const flag = A.has(5) ? A.num(5) : -1; const end = approxFloor(A.num(4)); const start = approxFloor(A.num(3)); const pv = A.num(2); const nper = A.num(1); const r = A.num(0);
    if (start < 1 || end < start || r <= 0 || end > nper || nper <= 0 || pv <= 0 || (flag !== 0 && flag !== 1)) { return fail(ERR.ARG); }
    const adv = !!flag; const pmt = getPMT(r, nper, pv, 0, adv);
    let s = start;
    if (principal) {
      const v = new LSum(0);
      if (s === 1) { v.add(adv ? pmt : pmt + pv * r); s++; }
      for (let i = s; i <= end; i++) { v.add(adv ? pmt - (getFV(r, i - 2, pmt, pv, true) - pmt) * r : pmt - getFV(r, i - 1, pmt, pv, false) * r); }
      return v.get();
    }
    let v = new LSum(0);
    if (s === 1) { if (!adv) { v = new LSum(-pv); } s++; }
    for (let i = s; i <= end; i++) { v.add(adv ? getFV(r, i - 2, pmt, pv, true) - pmt : getFV(r, i - 1, pmt, pv, false)); }
    return v.get() * r;
  }
  fx('CUMIPMT', 6, 6, 'rate; periods; present value; start; end; type', 'The interest paid between two periods.', (A) => cumFn(A, false));
  fx('CUMPRINC', 6, 6, 'rate; periods; present value; start; end; type', 'The principal paid between two periods.', (A) => cumFn(A, true));
  const addPmt = (r, n, pv, fv, type) => { let p; if (r === 0) { p = (pv + fv) / n; } else { const t = xpow(1 + r, n); p = type > 0 ? (fv * r / (t - 1) + pv * r / (1 - 1 / t)) / (1 + r) : fv * r / (t - 1) + pv * r / (1 - 1 / t); } return -p; };
  const addFv = (r, n, pmt, pv, type) => { let f; if (r === 0) { f = pv + pmt * n; } else { const t = xpow(1 + r, n); f = type > 0 ? pv * t + pmt * (1 + r) * (t - 1) / r : pv * t + pmt * (t - 1) / r; } return -f; };
  function cumAdd(A, principal) {
    const r = A.num(0); const n = int32(A.num(1)); const pv = A.num(2); const s0 = int32(A.num(3)); const e = int32(A.num(4)); const type = int32(A.num(5));
    if (s0 < 1 || e < s0 || r <= 0 || e > n || pv <= 0 || (type !== 0 && type !== 1)) { return fail(ERR.ARG); }
    const pmt = addPmt(r, n, pv, 0, type); let s = s0; let v = 0;
    if (principal) {
      if (s === 1) { v = type <= 0 ? pmt + pv * r : pmt; s++; }
      for (let i = s; i <= e; i++) { v += type > 0 ? pmt - (addFv(r, i - 2, pmt, pv, 1) - pmt) * r : pmt - addFv(r, i - 1, pmt, pv, 0) * r; }
      return v;
    }
    if (s === 1) { if (type <= 0) { v = -pv; } s++; }
    for (let i = s; i <= e; i++) { v += type > 0 ? addFv(r, i - 2, pmt, pv, 1) - pmt : addFv(r, i - 1, pmt, pv, 0); }
    return v * r;
  }
  fx('CUMIPMT_ADD', 6, 6, 'rate; periods; present value; start; end; type', 'The interest paid between two periods (Analysis add-in).', (A) => cumAdd(A, false));
  fx('CUMPRINC_ADD', 6, 6, 'rate; periods; present value; start; end; type', 'The principal paid between two periods (Analysis add-in).', (A) => cumAdd(A, true));
  fx('MIRR', 3, 3, 'values; investment rate; reinvestment rate', 'The modified internal rate of return.', (A) => {
    const rr = A.num(2) + 1; const ri = A.num(1) + 1;
    const v = A.raw(0);
    if (!(v instanceof RangeVal) && !(v instanceof ArrayVal)) { return fail(ERR.PARAM); }
    const nr = new LSum(0); const ni = new LSum(0); let pr = 1; let pi = 1; let n = 0; let pos = false; let neg = false;
    const take = (x) => { if (x > 0) { pos = true; nr.add(x * pr); } else if (x < 0) { neg = true; ni.add(x * pi); } pr /= rr; pi /= ri; n++; };
    if (v instanceof ArrayVal) { for (let c = 0; c < v.w; c++) { for (let r = 0; r < v.h; r++) { const x = v.rows[r][c]; if (isErr(x)) { throw x; } if (isNumLike(x)) { take(numOf(x)); } } } } else { A.items(0, 1).forEach(({ v: x }) => { if (isErr(x)) { throw x; } if (isNumLike(x)) { take(numOf(x)); } }); }
    if (!(pos && neg)) { return fail(ERR.ARG); }
    let r = -nr.get() / ni.get();
    r *= xpow(rr, n - 1);
    r = xpow(r, 1 / (n - 1));
    return r - 1;
  });
  fx('FVSCHEDULE', 2, 2, 'principal; schedule', 'The future value of a principal after a series of interest rates.', (A) => { let p = A.num(0); for (const x of addinList(A, 1, 2)) { p *= 1 + x; } return isFinite(p) ? p : fail(ERR.ARG); });
  /** XNPV and XIRR read values and dates as the add-in does: every cell, empty ones counted as 0. */
  function addinPairs(A, vi, di) {
    const vals = addinList(A, vi, vi + 1); const dates = addinList(A, di, di + 1).map((d) => Math.trunc(d));
    return { vals, dates };
  }
  fx('XNPV', 3, 3, 'rate; values; dates', 'The net present value of cash flows on given dates.', (A) => {
    let r = A.num(0); const { vals, dates } = addinPairs(A, 1, 2);
    if (vals.length !== dates.length || vals.length < 2) { return fail(ERR.ARG); }
    r++; let v = 0; const d0 = dates[0];
    for (let i = 0; i < vals.length; i++) { v += vals[i] / xpow(r, (dates[i] - d0) / 365); }
    return isFinite(v) ? v : fail(ERR.ARG);
  });
  fx('XIRR', 2, 3, 'values; dates; guess', 'The internal rate of return of cash flows on given dates.', (A) => {
    const { vals, dates } = addinPairs(A, 0, 1);
    if (vals.length < 2 || vals.length !== dates.length) { return fail(ERR.ARG); }
    let rate = A.has(2) ? A.num(2) : 0.1;
    if (rate <= -1) { return fail(ERR.ARG); }
    const f = (x) => { const r = x + 1; let s = vals[0]; for (let i = 1; i < vals.length; i++) { s += vals[i] / xpow(r, (dates[i] - dates[0]) / 365); } return s; };
    const df = (x) => { const r = x + 1; let s = 0; for (let i = 1; i < vals.length; i++) { const e = (dates[i] - dates[0]) / 365; s -= e * vals[i] / xpow(r, e + 1); } return s; };
    let scan = 0; let cont = false; let val;
    do {
      if (scan >= 1) { rate = -0.99 + (scan - 1) * 0.01; }
      let it = 0;
      do { val = f(rate); const nr = rate - val / df(rate); const eps = Math.abs(nr - rate); rate = nr; cont = eps > 1e-10 && Math.abs(val) > 1e-10; } while (cont && ++it < 50);
      if (!isFinite(rate) || !isFinite(val)) { cont = true; }
      ++scan;
    } while (cont && scan < 200);
    if (cont || !isFinite(rate)) { return fail(ERR.ARG); }
    return rate;
  });
  fx('DOLLARDE', 2, 2, 'fractional dollar; fraction', 'A price written as a fraction, as a decimal number.', (A) => { const v = A.num(0); const f = int32(A.num(1)); if (f <= 0) { return fail(ERR.ARG); } const i = Math.trunc(v); return (v - i) / f * xpow(10, Math.ceil(xlog10(f))) + i; });
  fx('DOLLARFR', 2, 2, 'decimal dollar; fraction', 'A decimal price, written as a fraction.', (A) => { const v = A.num(0); const f = int32(A.num(1)); if (f <= 0) { return fail(ERR.ARG); } const i = Math.trunc(v); return (v - i) * f * xpow(10, -Math.ceil(xlog10(f))) + i; });

  // securities (the Analysis add-in's bond functions)
  /** A date as the add-in's ScaDate keeps it: the original day, whether it was a month's last day, 30-day months. */
  class ScaDate {
    constructor(serial, base) {
      if (serial == null) { this.od = 1; this.d = 1; this.m = 1; this.y = 1900; this.ldMode = true; this.ld = false; this.b30 = false; this.us = false; return; }
      const p = serialToYmd(serial);
      this.od = p.d; this.m = p.m; this.y = p.y;
      this.ldMode = base !== 5; this.ld = p.d >= daysInMonth(p.y, p.m); this.b30 = base === 0 || base === 4; this.us = base === 0;
      this.setDay();
    }
    copy() { const c = new ScaDate(); Object.assign(c, this); return c; }
    setDay() { if (this.b30) { this.d = Math.min(this.od, 30); if (this.ld || this.d >= daysInMonth(this.y, this.m)) { this.d = 30; } } else { const last = daysInMonth(this.y, this.m); this.d = this.ld ? last : Math.min(this.od, last); } }
    dim(m) { return this.b30 ? 30 : daysInMonth(this.y, m == null ? this.m : m); }
    monthRange(a, b) { if (a > b) { return 0; } if (this.b30) { return (b - a + 1) * 30; } let r = 0; for (let m = a; m <= b; m++) { r += this.dim(m); } return r; }
    yearRange(a, b) { if (a > b) { return 0; } if (this.b30) { return (b - a + 1) * 360; } let leaps = 0; for (let y = a; y <= b; y++) { if (isLeap(y)) { leaps++; } } return (1 + b - a) * 365 + leaps; }
    doAddYears(n) { const ny = n + this.y; if (ny < 0 || ny > 0x7fff) { return fail(ERR.ARG); } this.y = ny; }
    addYears(n) { this.doAddYears(n); this.setDay(); }
    setYear(y) { this.y = y; this.setDay(); }
    addMonths(n) {
      let nm = n + this.m;
      if (nm > 12) { --nm; this.doAddYears(Math.trunc(nm / 12)); this.m = (nm % 12) + 1; } else if (nm < 1) { this.doAddYears(Math.trunc(nm / 12) - 1); this.m = nm % 12 + 12; } else { this.m = nm; }
      this.setDay();
    }
    serial() { const last = daysInMonth(this.y, this.m); const day = this.ldMode && this.ld ? last : Math.min(last, this.od); return ymdToSerial(this.y, this.m, day); }
    lt(o) { if (this.y !== o.y) { return this.y < o.y; } if (this.m !== o.m) { return this.m < o.m; } if (this.d !== o.d) { return this.d < o.d; } if (this.ld || o.ld) { return !this.ld && o.ld; } return this.od < o.od; }
    gt(o) { return o.lt(this); }
    static diff(from, to) {
      if (from.gt(to)) { return ScaDate.diff(to, from); }
      let n = 0; const a = from.copy(); const b = to.copy();
      if (to.b30) {
        if (to.us) { if ((from.m === 2 || from.d < 30) && b.od === 31) { b.d = 31; } else if (b.m === 2 && b.ld) { b.d = daysInMonth(b.y, 2); } } else { if (a.m === 2 && a.d === 30) { a.d = daysInMonth(a.y, 2); } if (b.m === 2 && b.d === 30) { b.d = daysInMonth(b.y, 2); } }
      }
      if (a.y < b.y || (a.y === b.y && a.m < b.m)) {
        n = a.dim() - a.d + 1;
        a.od = 1; a.d = 1; a.ld = false; a.addMonths(1);
        if (a.y < b.y) { n += a.monthRange(a.m, 12); a.addMonths(13 - a.m); n += a.yearRange(a.y, b.y - 1); a.addYears(b.y - a.y); }
        n += a.monthRange(a.m, b.m - 1); a.addMonths(b.m - a.m);
      }
      n += b.d - a.d;
      return Math.max(n, 0);
    }
  }
  const freqOk = (f) => f === 1 || f === 2 || f === 4;
  function couppcd(settle, mat, freq) { const d = mat.copy(); d.setYear(settle.y); if (d.lt(settle)) { d.addYears(1); } while (d.gt(settle)) { d.addMonths(-12 / freq); } return d; }
  function coupncd(settle, mat, freq) { const d = mat.copy(); d.setYear(settle.y); if (d.gt(settle)) { d.addYears(-1); } while (!d.gt(settle)) { d.addMonths(12 / freq); } return d; }
  const coupCheck = (s, m, f) => { if (s >= m || !freqOk(f)) { return fail(ERR.ARG); } };
  function coupdays(s, m, f, b) { coupCheck(s, m, f); if (b === 1) { const d = couppcd(new ScaDate(s, b), new ScaDate(m, b), f); const nx = d.copy(); nx.addMonths(12 / f); return ScaDate.diff(d, nx); } return (b === 3 ? 365 : b === 1 ? 365 : 360) / f; }
  function coupdaybs(s, m, f, b) { coupCheck(s, m, f); const st = new ScaDate(s, b); return ScaDate.diff(couppcd(st, new ScaDate(m, b), f), st); }
  function coupdaysnc(s, m, f, b) { coupCheck(s, m, f); if (b !== 0 && b !== 4) { const st = new ScaDate(s, b); return ScaDate.diff(st, coupncd(st, new ScaDate(m, b), f)); } return coupdays(s, m, f, b) - coupdaybs(s, m, f, b); }
  function coupnum(s, m, f, b) { coupCheck(s, m, f); const mt = new ScaDate(m, b); const d = couppcd(new ScaDate(s, b), mt, f); const months = (mt.y - d.y) * 12 + mt.m - d.m; return Math.trunc(months * f / 12); }
  /** The add-in's GetYearDiff: the day count over the days in the start's year for the basis. */
  function yearDiff(s, e, mode) {
    const neg = s > e; if (neg) { [s, e] = [e, s]; }
    let total; let first;
    if (mode === 0 || mode === 4) {
      const a = serialToYmd(s); const b = serialToYmd(e);
      total = ((b.m - a.m) + (b.y - a.y) * 12) * 30 + (b.d - a.d);
      if (mode === 0 && a.m === 2 && b.m !== 2 && a.y === b.y) { total -= isLeap(a.y) ? 1 : 2; }
      first = 360;
    } else if (mode === 1) { total = e - s; first = isLeap(serialToYmd(s).y) ? 366 : 365; } else if (mode === 2) { total = e - s; first = 360; } else if (mode === 3) { total = e - s; first = 365; } else { return fail(ERR.ARG); }
    return (neg ? -total : total) / first;
  }
  function price_(s, m, rate, yld, redemp, f, b) {
    const E = coupdays(s, m, f, b); const DSC_E = coupdaysnc(s, m, f, b) / E; const N = coupnum(s, m, f, b); const Ad = coupdaybs(s, m, f, b);
    let r = redemp / xpow(1 + yld / f, N - 1 + DSC_E);
    r -= 100 * rate / f * Ad / E;
    const t1 = 100 * rate / f; const t2 = 1 + yld / f;
    for (let k = 0; k < N; k++) { r += t1 / xpow(t2, k + DSC_E); }
    return r;
  }
  function yield_(s, m, coup, price, redemp, f, b) {
    let y1 = 0; let y2 = 1; let pN = 0;
    let p1 = price_(s, m, coup, y1, redemp, f, b); let p2 = price_(s, m, coup, y2, redemp, f, b);
    let yN = (y2 - y1) * 0.5;
    for (let it = 0; it < 100 && !lApproxEq(pN, price); it++) {
      pN = price_(s, m, coup, yN, redemp, f, b);
      if (lApproxEq(price, p1)) { return y1; }
      if (lApproxEq(price, p2)) { return y2; }
      if (lApproxEq(price, pN)) { return yN; }
      if (price < p2) { y2 *= 2; p2 = price_(s, m, coup, y2, redemp, f, b); yN = (y2 - y1) * 0.5; } else {
        if (price < pN) { y1 = yN; p1 = pN; } else { y2 = yN; p2 = pN; }
        yN = y2 - (y2 - y1) * ((price - p2) / (p1 - p2));
      }
    }
    if (Math.abs(price - pN) > price / 100) { return fail(ERR.ARG); }
    return yN;
  }
  function duration(s, m, coup, yld, f, b) {
    const yf = yearFrac(s, m, b); const N = coupnum(s, m, f, b);
    let dur = 0; coup *= 100 / f; yld /= f; yld += 1;
    const diff = yf * f - N;
    let t;
    for (t = 1; t < N; t++) { dur += (t + diff) * coup / xpow(yld, t + diff); }
    dur += (N + diff) * (coup + 100) / xpow(yld, N + diff);
    let p = 0;
    for (t = 1; t < N; t++) { p += coup / xpow(yld, t + diff); }
    p += (coup + 100) / xpow(yld, N + diff);
    return dur / p / f;
  }
  const fin = (v) => (isFinite(v) ? v : fail(ERR.ARG));
  const sec = 'settlement; maturity';
  fx('COUPDAYBS', 3, 4, sec + '; frequency; basis', 'The days from the last coupon date to the settlement.', (A) => coupdaybs(dayArg(A, 0), dayArg(A, 1), int32(A.num(2)), basisArg(A, 3)));
  fx('COUPDAYS', 3, 4, sec + '; frequency; basis', 'The days in the coupon period of the settlement.', (A) => coupdays(dayArg(A, 0), dayArg(A, 1), int32(A.num(2)), basisArg(A, 3)));
  fx('COUPDAYSNC', 3, 4, sec + '; frequency; basis', 'The days from the settlement to the next coupon date.', (A) => coupdaysnc(dayArg(A, 0), dayArg(A, 1), int32(A.num(2)), basisArg(A, 3)));
  fx('COUPNCD', 3, 4, sec + '; frequency; basis', 'The next coupon date after the settlement.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const f = int32(A.num(2)); const b = basisArg(A, 3); coupCheck(s, m, f); return coupncd(new ScaDate(s, b), new ScaDate(m, b), f).serial(); });
  fx('COUPPCD', 3, 4, sec + '; frequency; basis', 'The last coupon date before the settlement.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const f = int32(A.num(2)); const b = basisArg(A, 3); coupCheck(s, m, f); return couppcd(new ScaDate(s, b), new ScaDate(m, b), f).serial(); });
  fx('COUPNUM', 3, 4, sec + '; frequency; basis', 'The number of coupons between settlement and maturity.', (A) => coupnum(dayArg(A, 0), dayArg(A, 1), int32(A.num(2)), basisArg(A, 3)));
  fx('PRICE', 6, 7, sec + '; rate; yield; redemption; frequency; basis', 'The price per 100 of a security that pays periodic interest.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const r = A.num(2); const y = A.num(3); const rd = A.num(4); const f = int32(A.num(5)); const b = basisArg(A, 6); if (y < 0 || r < 0 || rd <= 0 || !freqOk(f) || s >= m) { return fail(ERR.ARG); } return fin(price_(s, m, r, y, rd, f, b)); });
  fx('YIELD', 6, 7, sec + '; rate; price; redemption; frequency; basis', 'The yield of a security that pays periodic interest.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const c = A.num(2); const p = A.num(3); const rd = A.num(4); const f = int32(A.num(5)); const b = basisArg(A, 6); if (c < 0 || p <= 0 || rd <= 0 || !freqOk(f) || s >= m) { return fail(ERR.ARG); } return fin(yield_(s, m, c, p, rd, f, b)); });
  fx('DURATION', 5, 6, sec + '; coupon; yield; frequency; basis', 'The Macaulay duration of a security.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const c = A.num(2); const y = A.num(3); const f = int32(A.num(4)); const b = basisArg(A, 5); if (c < 0 || y < 0 || !freqOk(f) || s >= m) { return fail(ERR.ARG); } return fin(duration(s, m, c, y, f, b)); });
  fx('MDURATION', 5, 6, sec + '; coupon; yield; frequency; basis', 'The modified duration of a security.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const c = A.num(2); const y = A.num(3); const f = int32(A.num(4)); const b = basisArg(A, 5); if (c < 0 || y < 0 || !freqOk(f)) { return fail(ERR.ARG); } return fin(duration(s, m, c, y, f, b) / (1 + y / f)); });
  fx('ACCRINT', 6, 8, 'issue; first interest; settlement; rate; par; frequency; basis; method', 'The accrued interest of a security that pays periodic interest.', (A) => { const iss = dayArg(A, 0); const s = dayArg(A, 2); const r = A.num(3); const par = A.has(4) ? A.num(4) : 1000; const f = int32(A.num(5)); const b = basisArg(A, 6); if (r <= 0 || par <= 0 || !freqOk(f) || iss >= s) { return fail(ERR.ARG); } return fin(par * r * yearDiff(iss, s, b)); });
  fx('ACCRINTM', 3, 5, 'issue; settlement; rate; par; basis', 'The accrued interest of a security paid at maturity.', (A) => { const iss = dayArg(A, 0); const s = dayArg(A, 1); const r = A.num(2); const par = A.has(3) ? A.num(3) : 1000; const b = basisArg(A, 4); if (r <= 0 || par <= 0 || iss >= s) { return fail(ERR.ARG); } return fin(par * r * yearDiff(iss, s, b)); });
  fx('RECEIVED', 4, 5, sec + '; investment; discount; basis', 'The amount received at maturity for a fully invested security.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const inv = A.num(2); const d = A.num(3); const b = basisArg(A, 4); if (inv <= 0 || d <= 0 || s >= m) { return fail(ERR.ARG); } return fin(inv / (1 - d * yearDiff(s, m, b))); });
  fx('DISC', 4, 5, sec + '; price; redemption; basis', 'The discount rate of a security.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const p = A.num(2); const rd = A.num(3); const b = basisArg(A, 4); if (p <= 0 || rd <= 0 || s >= m) { return fail(ERR.ARG); } return fin((1 - p / rd) / yearFrac(s, m, b)); });
  fx('INTRATE', 4, 5, sec + '; investment; redemption; basis', 'The interest rate of a fully invested security.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const inv = A.num(2); const rd = A.num(3); const b = basisArg(A, 4); if (inv <= 0 || rd <= 0 || s >= m) { return fail(ERR.ARG); } return fin((rd / inv - 1) / yearDiff(s, m, b)); });
  fx('PRICEDISC', 4, 5, sec + '; discount; redemption; basis', 'The price per 100 of a discounted security.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const d = A.num(2); const rd = A.num(3); const b = basisArg(A, 4); if (d <= 0 || rd <= 0 || s >= m) { return fail(ERR.ARG); } return fin(rd * (1 - d * yearDiff(s, m, b))); });
  fx('PRICEMAT', 5, 6, sec + '; issue; rate; yield; basis', 'The price per 100 of a security that pays interest at maturity.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const iss = dayArg(A, 2); const r = A.num(3); const y = A.num(4); const b = basisArg(A, 5); if (r < 0 || y < 0 || s >= m) { return fail(ERR.ARG); } const im = yearFrac(iss, m, b); const is = yearFrac(iss, s, b); const sm = yearFrac(s, m, b); let v = 1 + im * r; v /= 1 + sm * y; v -= is * r; return fin(v * 100); });
  fx('YIELDDISC', 4, 5, sec + '; price; redemption; basis', 'The annual yield of a discounted security.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const p = A.num(2); const rd = A.num(3); const b = basisArg(A, 4); if (p <= 0 || rd <= 0 || s >= m) { return fail(ERR.ARG); } return fin((rd / p - 1) / yearFrac(s, m, b)); });
  fx('YIELDMAT', 5, 6, sec + '; issue; rate; price; basis', 'The annual yield of a security that pays interest at maturity.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const iss = dayArg(A, 2); const r = A.num(3); const p = A.num(4); const b = basisArg(A, 5); if (p <= 0 || r < 0 || s >= m || s < iss) { return fail(ERR.ARG); } const im = yearFrac(iss, m, b); const is = yearFrac(iss, s, b); const sm = yearFrac(s, m, b); let y = 1 + im * r; y /= p / 100 + is * r; y--; y /= sm; return fin(y); });
  const diff360 = (s, e) => { const a = serialToYmd(s); const b = serialToYmd(e); let d1 = a.d; let d2 = b.d; let m2 = b.m; let y2 = b.y; if (d1 === 31) { d1--; } else if (a.m === 2 && (d1 === 29 || (d1 === 28 && !isLeap(a.y)))) { d1 = 30; } if (d2 === 31) { if (d1 !== 30) { d2 = 1; if (m2 === 12) { y2++; m2 = 1; } else { m2++; } } else { d2 = 30; } } return d2 + m2 * 30 + y2 * 360 - d1 - a.m * 30 - a.y * 360; };
  fx('TBILLEQ', 3, 3, sec + '; discount', 'The bond-equivalent yield of a Treasury bill.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1) + 1; const d = A.num(2); const n = diff360(s, m); if (d <= 0 || s >= m || n > 360) { return fail(ERR.ARG); } return fin((365 * d) / (360 - d * n)); });
  fx('TBILLPRICE', 3, 3, sec + '; discount', 'The price per 100 of a Treasury bill.', (A) => { const s = dayArg(A, 0); let m = dayArg(A, 1); const d = A.num(2); if (d <= 0 || s > m) { return fail(ERR.ARG); } m++; const f = yearFrac(s, m, 0); if (f % 1 === 0) { return fail(ERR.ARG); } return fin(100 * (1 - d * f)); });
  fx('TBILLYIELD', 3, 3, sec + '; price', 'The yield of a Treasury bill.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const p = A.num(2); const n = diff360(s, m) + 1; if (p <= 0 || s >= m || n > 360) { return fail(ERR.ARG); } return fin((100 / p - 1) / n * 360); });
  fx('ODDLPRICE', 7, 8, sec + '; last interest; rate; yield; redemption; frequency; basis', 'The price per 100 of a security with an odd last period.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const li = dayArg(A, 2); const r = A.num(3); const y = A.num(4); const rd = A.num(5); const f = int32(A.num(6)); const b = basisArg(A, 7); if (r <= 0 || y < 0 || rd <= 0 || !freqOk(f) || m <= s || s <= li) { return fail(ERR.ARG); } const dci = yearFrac(li, m, b) * f; const dsci = yearFrac(s, m, b) * f; const ai = yearFrac(li, s, b) * f; let p = rd + dci * 100 * r / f; p /= dsci * y / f + 1; p -= ai * 100 * r / f; return fin(p); });
  fx('ODDLYIELD', 7, 8, sec + '; last interest; rate; price; redemption; frequency; basis', 'The yield of a security with an odd last period.', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const li = dayArg(A, 2); const r = A.num(3); const p = A.num(4); const rd = A.num(5); const f = int32(A.num(6)); const b = basisArg(A, 7); if (r <= 0 || p <= 0 || rd <= 0 || !freqOk(f) || m <= s || s <= li) { return fail(ERR.ARG); } const dci = yearFrac(li, m, b) * f; const dsci = yearFrac(s, m, b) * f; const ai = yearFrac(li, s, b) * f; let y = rd + dci * 100 * r / f; y /= p + ai * 100 * r / f; y--; y *= f / dsci; return fin(y); });
  // LibreOffice 24.2's Analysis add-in has no algorithm for an odd first period: it always answers #VALUE!.
  fx('ODDFPRICE', 8, 9, sec + '; issue; first coupon; rate; yield; redemption; frequency; basis', 'The price per 100 of a security with an odd first period (not computed by LibreOffice 24.2: #VALUE!).', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const iss = dayArg(A, 2); const fc = dayArg(A, 3); const r = A.num(4); const y = A.num(5); const f = int32(A.num(7)); basisArg(A, 8); if (r < 0 || y < 0 || !freqOk(f) || m <= fc || fc <= s || s <= iss) { return fail(ERR.ARG); } return fail(ERR.VALUE); });
  fx('ODDFYIELD', 8, 9, sec + '; issue; first coupon; rate; price; redemption; frequency; basis', 'The yield of a security with an odd first period (not computed by LibreOffice 24.2: #VALUE!).', (A) => { const s = dayArg(A, 0); const m = dayArg(A, 1); const iss = dayArg(A, 2); const fc = dayArg(A, 3); const r = A.num(4); const p = A.num(5); const f = int32(A.num(7)); basisArg(A, 8); if (r < 0 || p <= 0 || !freqOk(f) || m <= fc || fc <= s || s <= iss) { return fail(ERR.ARG); } return fail(ERR.VALUE); });
  fx('AMORDEGRC', 6, 7, 'cost; purchase date; first period; salvage; period; rate; basis', 'Depreciation for a period, French degressive method.', (A) => {
    let cost = A.num(0); const date = dayArg(A, 1); const first = dayArg(A, 2); const rest = A.num(3); const per = A.num(4); let rate = A.num(5); const b = basisArg(A, 6);
    if (date > first || rate <= 0 || rest > cost || cost <= 0 || rest < 0 || per < 0) { return fail(ERR.ARG); }
    const nPer = Math.trunc(per); const use = 1 / rate;
    rate *= use < 3 ? 1 : use < 5 ? 1.5 : use <= 6 ? 2 : 2.5;
    let nr = rtlRound(yearFrac(date, first, b) * rate * cost, 0, 'corr');
    cost -= nr; let rs = cost - rest;
    for (let n = 0; n < nPer; n++) { nr = rtlRound(rate * cost, 0, 'corr'); rs -= nr; if (rs < 0) { return nPer - n <= 1 ? rtlRound(cost * 0.5, 0, 'corr') : 0; } cost -= nr; }
    return fin(nr);
  });
  fx('AMORLINC', 6, 7, 'cost; purchase date; first period; salvage; period; rate; basis', 'Depreciation for a period, French linear method.', (A) => {
    const cost = A.num(0); const date = dayArg(A, 1); const first = dayArg(A, 2); const rest = A.num(3); const per = A.num(4); const rate = A.num(5); const b = basisArg(A, 6);
    if (date > first || rate <= 0 || rest > cost || cost <= 0 || rest < 0 || per < 0) { return fail(ERR.ARG); }
    const nPer = Math.trunc(per); const one = cost * rate; const delta = cost - rest; const r0 = yearFrac(date, first, b) * rate * cost;
    const full = Math.trunc((cost - rest - r0) / one);
    let r = 0;
    if (nPer === 0) { r = r0; } else if (nPer <= full) { r = one; } else if (nPer === full + 1) { r = delta - one * full - r0; }
    return r > 0 ? r : 0;
  });

  // text
  GRP = 'Text';
  const DIGITS36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  fx('BASE', 2, 3, 'number; radix; minimum length', 'A whole number written in another base (2–36).', (A) => {
    let minLen = 1;
    if (A.n === 3) { const l = approxFloor(A.num(2)); minLen = l >= 1 && l < 65535 ? l : l === 0 ? 1 : 0; }
    const base = approxFloor(A.num(1)); let v = approxFloor(A.num(0));
    if (!minLen || base < 2 || base > 36 || v < 0) { return fail(ERR.ARG); }
    let s = '';
    if (v === 0) { s = ''; } else if (v <= Number.MAX_SAFE_INTEGER) { let n = BigInt(v); const b = BigInt(base); while (n > 0n) { s = DIGITS36[Number(n % b)] + s; n /= b; } } else {
      let dirt = false;
      while (v) { const fi = approxFloor(v / base); const fm = fi * base; let dg; if (v < fm) { dirt = true; dg = 0; } else { let fd = approxFloor(approxSub(v, fm)); if (dirt) { dirt = false; --fd; } dg = fd <= 0 ? 0 : fd >= base ? base - 1 : fd; } s = DIGITS36[dg] + s; v = fi; }
    }
    return s.padStart(minLen, '0');
  });
  fx('DECIMAL', 2, 2, 'text; radix', 'A number written in another base (2–36), as a decimal number.', (A) => {
    const base = approxFloor(A.num(1)); let s = A.str(0);
    if (base < 2 || base > 36) { return fail(ERR.ARG); }
    s = s.replace(/^[ \t]+/, '');
    if (base === 16) { if (/^[xX]/.test(s)) { s = s.slice(1); } else if (/^0[xX]/.test(s)) { s = s.slice(2); } }
    let v = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]; const u = ch.toUpperCase();
      const n = /[0-9]/.test(ch) ? ch.charCodeAt(0) - 48 : /[A-Z]/.test(u) && /[A-Za-z]/.test(ch) ? u.charCodeAt(0) - 55 : base;
      if (n >= base) { if (i === s.length - 1 && ((base === 2 && /[bB]/.test(ch)) || (base === 16 && /[hH]/.test(ch)))) { continue; } return fail(ERR.ARG); }
      v = v * base + n;
    }
    return v;
  });
  fx('ROMAN', 1, 2, 'number; mode', 'A number (0–3999) in Roman numerals; mode 0–4 makes it more concise.', (A) => {
    const mode = A.n === 2 ? approxFloor(A.num(1)) : 0; let v = approxFloor(A.num(0));
    if (!(mode >= 0 && mode < 5 && v >= 0 && v < 4000)) { return fail(ERR.ARG); }
    const ch = 'MDCLXVI'; const vals = [1000, 500, 100, 50, 10, 5, 1]; let out = '';
    for (let i = 0; i <= 3; i++) {
      let idx = 2 * i; const dig = Math.trunc(v / vals[idx]);
      if (dig % 5 === 4) {
        const idx2 = dig === 4 ? idx - 1 : idx - 2; let steps = 0;
        while (steps < mode && idx < 6) { steps++; if (vals[idx2] - vals[idx + 1] <= v) { idx++; } else { steps = mode; } }
        out += ch[idx] + ch[idx2]; v = v + vals[idx] - vals[idx2];
      } else { if (dig > 4) { out += ch[idx - 1]; } out += ch[idx].repeat(dig % 5); v %= vals[idx]; }
    }
    return out;
  });
  fx('ARABIC', 1, 1, 'text', 'A Roman numeral as a number.', (A) => {
    const s = A.str(0).toUpperCase(); const map = { M: [1000, 1], D: [500, 0], C: [100, 1], L: [50, 0], X: [10, 1], V: [5, 0], I: [1, 1] };
    let val = 0; let rest = 3999; let i = 0;
    while (i < s.length) {
      const a = map[s[i]]; if (!a) { return fail(ERR.ARG); }
      let b = [0, 0];
      if (i + 1 < s.length) { b = map[s[i + 1]]; if (!b) { return fail(ERR.ARG); } }
      if (a[0] >= b[0]) { val += a[0]; rest %= a[0] * (a[1] ? 5 : 2); if (rest < a[0]) { return fail(ERR.ARG); } rest -= a[0]; i++; } else if (a[0] * 2 !== b[0]) { const d = b[0] - a[0]; val += d; if (rest < d) { return fail(ERR.ARG); } rest = a[0] - 1; i += 2; } else { return fail(ERR.ARG); }
    }
    return val;
  });
  fx('NUMBERVALUE', 1, 3, 'text; decimal separator; group separator', 'Text as a number, with the separators given.', (A) => {
    const grp = A.n === 3 ? A.str(2) : '';
    let dec = '';
    if (A.n >= 2) { dec = A.str(1); if (dec.length !== 1) { return fail(ERR.ARG); } }
    if (dec && grp.indexOf(dec) >= 0) { return fail(ERR.ARG); }
    const v = A.val(0);
    if (typeof v === 'number') { return v; }
    let s = toText(v);
    if (s === '') { return fail(ERR.VALUE); }
    const ds = dec ? s.indexOf(dec) : -1;
    if (ds !== 0) { let head = ds >= 0 ? s.slice(0, ds) : s; for (const g of Array.from(grp)) { head = head.split(g).join(''); } s = ds >= 0 ? head + s.slice(ds) : head; }
    s = s.replace(/[ \t\n\r]/g, '');
    let pct = 0; while (s.endsWith('%')) { s = s.slice(0, -1); pct++; }
    const d = dec || '\u0000';
    const re = new RegExp('^[+-]?(\\d+(' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d*)?|' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d+)([eE][+-]?\\d+)?$');
    if (!re.test(s)) { return fail(ERR.VALUE); }
    const n = Number(dec ? s.replace(dec, '.') : s);
    if (!isFinite(n)) { return fail(ERR.VALUE); }
    return pct ? n * xpow(10, -(pct * 2)) : n;
  });
  /** Calc counts a character as two bytes when its Unicode block is East Asian (IsDBCS, by UTF-16 code unit). */
  const isDBCS = (u) => (u >= 0x1100 && u <= 0x11FF) || (u >= 0x2E80 && u <= 0x2FDF) || (u >= 0x2FF0 && u <= 0x31BF) || (u >= 0x31C0 && u <= 0x31EF) || (u >= 0x3200 && u <= 0x4DBF) || (u >= 0x4E00 && u <= 0xA4CF) || (u >= 0xAC00 && u <= 0xD7AF) || (u >= 0xD800 && u <= 0xFAFF) || (u >= 0xFE30 && u <= 0xFE4F) || (u >= 0xFF00 && u <= 0xFFEF);
  const lenB = (s, n) => { let l = 0; const e = n == null ? s.length : n; for (let i = 0; i < e; i++) { l += isDBCS(s.charCodeAt(i)) ? 2 : 1; } return l; };
  function leftB(s, n) {
    if (n >= lenB(s)) { return s; }
    let i = -1;
    while (i++ < s.length) { if (n === 0) { return s.slice(0, i); } if (n === -1) { return s.slice(0, i - 1) + ' '; } n -= isDBCS(s.charCodeAt(i)) ? 2 : 1; }
    return s;
  }
  function rightB(s, n) {
    if (n >= lenB(s)) { return s; }
    let i = s.length;
    while (i-- >= 0) { if (n === 0) { return s.slice(i + 1); } if (n === -1) { return ' ' + s.slice(i + 2); } n -= isDBCS(s.charCodeAt(i)) ? 2 : 1; }
    return s;
  }
  const posArg = (A, i) => { const v = A.num(i); return v < 0 ? -1 : Math.trunc(approxFloor(v)); };
  fx('LENB', 1, 1, 'text', 'The length of a text in bytes (East Asian characters count 2).', (A) => lenB(A.str(0)));
  fx('LEFTB', 1, 2, 'text; bytes', 'The first bytes of a text.', (A) => { const n = A.n === 2 ? posArg(A, 1) : 1; if (n < 0) { return fail(ERR.ARG); } return leftB(A.str(0), n); });
  fx('RIGHTB', 1, 2, 'text; bytes', 'The last bytes of a text.', (A) => { const n = A.n === 2 ? posArg(A, 1) : 1; if (n < 0) { return fail(ERR.ARG); } return rightB(A.str(0), n); });
  fx('MIDB', 3, 3, 'text; start; bytes', 'Bytes from the middle of a text.', (A) => { const cnt = posArg(A, 2); const st = posArg(A, 1); let s = A.str(0); if (st < 1 || cnt < 0) { return fail(ERR.ARG); } s = leftB(s, st + cnt - 1); return rightB(s, Math.max(lenB(s) - st + 1, 0)); });
  fx('REPLACEB', 4, 4, 'text; position; bytes; new text', 'Replaces bytes of a text.', (A) => { const nw = A.str(3); const cnt = posArg(A, 2); const pos = posArg(A, 1); const old = A.str(0); const len = lenB(old); if (pos < 1 || pos > len || cnt < 0 || pos + cnt - 1 > len) { return fail(ERR.ARG); } return leftB(old, pos - 1) + nw + rightB(old, len - pos - cnt + 1); });
  fx('FINDB', 2, 3, 'find; text; start', 'Where a text starts, counted in bytes.', (A) => {
    const st = A.n === 3 ? posArg(A, 2) : 1; const s = A.str(1); const what = A.str(0);
    const len = lenB(s); const wl = lenB(what);
    if (st < 1 || st > len - wl + 1) { return fail(ERR.ARG); }
    const sub = rightB(s, len - st + 1); const p = sub.indexOf(what);
    if (p < 0) { return fail(ERR.VALUE); }
    return lenB(sub, p) + st;
  });
  fx('SEARCHB', 2, 3, 'find; text; start', 'Where a text starts (wildcards allowed), counted in bytes.', (A) => {
    let st = 1; if (A.n === 3) { st = posArg(A, 2); if (st < 1) { return fail(ERR.ARG); } }
    const s = A.str(1); const what = A.str(0); const len = lenB(s);
    if (st - 1 >= len) { return fail(ERR.VALUE); }
    const sub = rightB(s, len - st + 1);
    let re = '';
    for (let i = 0; i < what.length; i++) { const ch = what[i]; if (ch === '~' && i + 1 < what.length) { re += what[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); } else if (ch === '*') { re += '[\\s\\S]*?'; } else if (ch === '?') { re += '[\\s\\S]'; } else { re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); } }
    const m = new RegExp(re, 'i').exec(sub);
    if (!m) { return fail(ERR.VALUE); }
    return lenB(sub, m.index) + st;
  });
  // JIS and ASC: half-width ↔ full-width ASCII and katakana, as LibreOffice's transliterations (…_LIKE_JIS / …_LIKE_ASC).
  const HALF_KANA = '｡｢｣､･ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ';
  const FULL_KANA = '。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン゛゜';
  const DAKU = 'カキクケコサシスセソタチツテトハヒフヘホウ'; const HANDAKU = 'ハヒフヘホ';
  const CH = String.fromCharCode;
  const JIS_SPECIAL = { [CH(0x22)]: CH(0x201D), [CH(0x27)]: CH(0x2019), [CH(0x5C)]: CH(0xFFE5), [CH(0x60)]: CH(0x2018), [CH(0x7E)]: CH(0xFF5E) };
  function toJis(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i]; const u = c.charCodeAt(0);
      const k = HALF_KANA.indexOf(c);
      if (k >= 0) {
        let f = FULL_KANA[k]; const nx = s[i + 1];
        if (nx === 'ﾞ' && DAKU.indexOf(f) >= 0 && f !== 'ウ') { f = String.fromCharCode(f.charCodeAt(0) + 1); i++; } else if (nx === 'ﾟ' && HANDAKU.indexOf(f) >= 0) { f = String.fromCharCode(f.charCodeAt(0) + 2); i++; }
        out += f; continue;
      }
      if (JIS_SPECIAL[c]) { out += JIS_SPECIAL[c]; continue; }
      if (u >= 0x21 && u <= 0x7E) { out += String.fromCharCode(u + 0xFEE0); continue; }
      out += c;
    }
    return out;
  }
  const ASC_SPECIAL = { [CH(0x201D)]: CH(0x22), [CH(0x201C)]: CH(0x22), [CH(0x2019)]: CH(0x27), [CH(0x2018)]: CH(0x60), [CH(0xFFE5)]: CH(0x5C) };
  function toAsc(s) {
    let out = '';
    for (const c of s) {
      const u = c.charCodeAt(0);
      if (u >= 0xFF01 && u <= 0xFF5E) { out += String.fromCharCode(u - 0xFEE0); continue; }
      if (ASC_SPECIAL[c]) { out += ASC_SPECIAL[c]; continue; }
      const k = FULL_KANA.indexOf(c);
      if (k >= 0) { out += HALF_KANA[k]; continue; }
      const d = DAKU.indexOf(String.fromCharCode(u - 1));
      if (d >= 0 && 'ガギグゲゴザジズゼゾダヂヅデドバビブベボ'.indexOf(c) >= 0) { out += HALF_KANA[FULL_KANA.indexOf(String.fromCharCode(u - 1))] + 'ﾞ'; continue; }
      if ('パピプペポ'.indexOf(c) >= 0) { out += HALF_KANA[FULL_KANA.indexOf(String.fromCharCode(u - 2))] + 'ﾟ'; continue; }
      if (c === 'ヴ') { out += 'ｳﾞ'; continue; }
      out += c;
    }
    return out;
  }
  fx('JIS', 1, 1, 'text', 'Half-width ASCII and katakana as full-width.', (A) => toJis(A.str(0)));
  fx('ASC', 1, 1, 'text', 'Full-width ASCII and katakana as half-width.', (A) => toAsc(A.str(0)));
  const TH = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  function thBlock(v) {
    let t = '';
    const pw = ['', '', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
    for (const p of [5, 4, 3, 2]) { const u = xpow(10, p); if (v >= u) { t += TH[Math.trunc(v / u)] + pw[p]; v %= u; } }
    if (v <= 0) { return t; }
    const ten = Math.trunc(v / 10); const one = v % 10;
    if (ten >= 1) { if (ten >= 3) { t += TH[ten]; } else if (ten === 2) { t += 'ยี่'; } t += 'สิบ'; }
    if (ten > 0 && one === 1) { t += 'เอ็ด'; } else if (one > 0) { t += TH[one]; }
    return t;
  }
  fx('BAHTTEXT', 1, 1, 'number', 'A number as Thai text with “baht” and “satang”.', (A) => {
    let v = A.num(0); const minus = v < 0; v = approxFloor(Math.abs(v) * 100 + 0.5);
    const split = (val, size) => { const q = (val + 0.1) / size; const i = Math.trunc(q); return [i, Math.trunc((q - i) * size + 0.1)]; };
    let [baht, satang] = split(v, 100);
    let text = '';
    if (baht === 0) { if (satang === 0) { text = TH[0]; } } else {
      while (baht > 0) { const [rest, blk] = split(baht, 1e6); baht = rest; let b = blk > 0 ? thBlock(blk) : ''; if (baht > 0) { b = 'ล้าน' + b; } text = b + text; }
    }
    if (text) { text += 'บาท'; }
    text += satang === 0 ? 'ถ้วน' : thBlock(satang) + 'สตางค์';
    return minus ? 'ลบ' + text : text;
  });
  fx('ENCODEURL', 1, 1, 'text', 'The text encoded for use in a URL.', (A) => { const s = A.str(0); if (!s) { return fail(ERR.VALUE); } let out = ''; for (const b of new TextEncoder().encode(s)) { const c = String.fromCharCode(b); out += /[A-Za-z0-9_-]/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0'); } return out; });
  fx('ROT13', 1, 1, 'text', 'The text with Latin letters rotated by 13 places.', (A) => A.str(0).replace(/[A-Za-z]/g, (c) => { const b = c <= 'Z' ? 65 : 97; return String.fromCharCode((c.charCodeAt(0) - b + 13) % 26 + b); }));
  fx('REGEX', 2, 4, 'text; expression; replacement; flags or occurrence', 'Finds or replaces text with a regular expression.', (A) => {
    let global = false; let occ = 1;
    if (A.n === 4) {
      if (A.has(3)) { const f = A.val(3); if (typeof f === 'number' || typeof f === 'boolean') { const n = numOf(f); if (n < 0) { return fail(ERR.ARG); } occ = Math.trunc(approxFloor(n)); } else { const fl = toText(f); if (fl.length > 1 || (fl.length === 1 && fl !== 'g')) { return fail(ERR.ARG); } global = fl === 'g'; } }
    }
    let repl = null;
    if (A.n >= 3 && A.has(2) && occ !== 0) { repl = A.str(2); }
    const expr = A.str(1); const text = A.str(0);
    if (occ === 0) { return text; }
    let re;
    let body = expr; let flags = 'gu';
    const fm = /^\(\?([imsx]+)\)/.exec(body);
    if (fm) { body = body.slice(fm[0].length); flags += fm[1].replace(/x/g, ''); }
    try { re = new RegExp(body, flags); } catch (e) { return fail(ERR.ARG); }
    if (repl === null) {
      let m; let n = 0;
      while ((m = re.exec(text)) !== null) { n++; if (n === occ) { return m[0]; } if (m[0] === '') { re.lastIndex++; } }
      return fail(ERR.NA);
    }
    const r = repl.replace(/\\(\d)/g, '$$$1');
    if (global) { return text.replace(re, r); }
    let n = 0;
    return text.replace(re, (...m) => { n++; if (n !== occ) { return m[0]; } return m[0].replace(new RegExp(body, flags.replace('g', '')), r); });
  });

  // information
  GRP = 'Information';
  function isEvenOf(A) {
    const v = A.val(0);
    if (typeof v !== 'number' && typeof v !== 'boolean') { return fail(ERR.PARAM); }
    return approxFloor(Math.abs(numOf(v))) % 2 < 0.5;
  }
  fx('ISEVEN', 1, 1, 'value', 'TRUE when the whole part of a number is even.', (A) => isEvenOf(A));
  fx('ISODD', 1, 1, 'value', 'TRUE when the whole part of a number is odd.', (A) => !isEvenOf(A));
  fx('ISEVEN_ADD', 1, 1, 'number', '1 when the number is even, otherwise 0 (Analysis add-in).', (A) => ((int32(A.num(0)) & 1) === 0 ? 1 : 0));
  fx('ISODD_ADD', 1, 1, 'number', '1 when the number is odd, otherwise 0 (Analysis add-in).', (A) => ((int32(A.num(0)) & 1) === 1 ? 1 : 0));
  fx('ISNONTEXT', 1, 1, 'value', 'TRUE when the value is not text.', (A) => catchErr(() => typeof A.val(0) !== 'string', () => true));
  fx('ISREF', 1, 1, 'value', 'TRUE when the argument is a reference.', (A) => catchErr(() => A.raw(0) instanceof RangeVal, () => false));
  fx('FORMULA', 1, 1, 'reference', 'The formula of a cell as text.', (A) => {
    const rv = A.ref(0, ERR.NA);
    const cell = rv.sheet.cells.get(rv.r0 * MAXC + rv.c0);
    if (!cell) { return fail(ERR.NA); }
    if (cell.arr) { return '{' + uiFormula(cell.f) + '}'; }
    if (cell.of) { return '{' + uiFormula(cell.of.f) + '}'; }
    return cell.f ? uiFormula(cell.f) : fail(ERR.NA);
  });
  /** A formula as Calc (ja-JP) shows it in a cell: , between the arguments (measured: =IF(C1,"a;b",1)); texts, sheet names and inline arrays as written. */
  function uiFormula(f) {
    let out = ''; let braces = 0;
    for (let i = 0; i < f.length; i++) {
      const ch = f[i];
      if (ch === '"' || ch === "'") { const j = f.indexOf(ch, i + 1); const end = j < 0 ? f.length : j; out += f.slice(i, end + 1); i = end; continue; }
      if (ch === '{') { braces++; } else if (ch === '}') { braces = Math.max(0, braces - 1); }
      out += ch === ';' && !braces ? ',' : ch;
    }
    return out;
  }
  const ERR_CODES = { '#NULL!': 521, '#DIV/0!': 532, '#VALUE!': 519, '#REF!': 524, '#NAME?': 525, '#NUM!': 503, '#N/A': 32767 };
  const errorOf = (A) => catchErr(() => { A.val(0); return null; }, (e) => e.code);
  fx('ERROR.TYPE', 1, 1, 'value', 'The number of an error: 1 #NULL!, 2 #DIV/0!, 3 #VALUE!, 4 #REF!, 5 #NAME?, 6 #NUM!, 7 #N/A.', (A) => { const e = errorOf(A); const n = { '#NULL!': 1, '#DIV/0!': 2, '#VALUE!': 3, '#REF!': 4, '#NAME?': 5, '#NUM!': 6, '#N/A': 7 }[e]; return n || fail(ERR.NA); });
  fx('INFO', 1, 1, 'type', 'Information about the environment: "system", "release", "numfile", "recalc".', (A) => {
    const t = A.str(0).toUpperCase();
    if (t === 'SYSTEM') { return 'LINUX'; }
    if (t === 'OSVERSION') { return 'Linux'; }
    if (t === 'RELEASE') { return 'CalcBase'; }
    if (t === 'NUMFILE') { return 1; }
    if (t === 'RECALC') { return 'Automatic'; }
    if (['DIRECTORY', 'MEMAVAIL', 'MEMUSED', 'ORIGIN', 'TOTMEM'].indexOf(t) >= 0) { return fail(ERR.NA); }
    return fail(ERR.ARG);
  });
  /** CELL("FORMAT"): the format code as Calc's GetCalcCellReturn names it (G, F2, ,0, C2, P0, S2, D1–D9, "-" for coloured negatives). */
  function cellFormatCode(code) {
    if (!code || code === 'General') { return 'F0'; }
    const sec = parseFormat(String(code)).sections[0];
    let out;
    if (sec.type === 'num') {
      const kind = fmtKind(code);
      out = (kind === 'currency' ? 'C' : sec.pct ? 'P' : sec.exp ? 'S' : sec.group ? ',' : 'F') + sec.decs.length;
    } else if (sec.type === 'date') {
      const k = fmtKind(code);
      const has = (re) => sec.toks.some((t) => t.k === 'dt' && re.test(t.v));
      if (k === 'time') { out = sec.ampm ? (has(/^s/) ? 'D6' : 'D7') : (has(/^s/) ? 'D8' : 'D9'); } else if (k === 'datetime') { out = 'D4'; } else if (!has(/^y/)) { out = has(/^d/) ? 'D2' : 'D5'; } else if (!has(/^d/)) { out = 'D3'; } else { out = 'D1'; }
    } else { out = 'G'; }
    if (parseFormat(String(code)).sections.length > 1 && parseFormat(String(code)).sections[1].color) { out += '-'; }
    if (String(code).indexOf('(') >= 0) { out += '()'; }
    return out;
  }
  GRP = 'Information';
  fx('CELL', 1, 2, 'type; reference', 'Information about a cell: "col", "row", "sheet", "address", "contents", "type", "format", "prefix", "protect", "coord" …', (A, ctx) => {
    let sh = ctx.sheet; let r = ctx.at.r; let c = ctx.at.c;
    if (A.n === 2) { const rv = A.raw(1); if (!(rv instanceof RangeVal)) { return fail(ERR.REF); } sh = rv.sheet; r = rv.r0; c = rv.c0; }
    const type = A.str(0).toUpperCase();
    const cell = sh.cells.get(r * MAXC + c);
    const val = ctx.cellValue(sh, r, c);
    switch (type) {
      case 'COL': return c + 1;
      case 'ROW': return r + 1;
      case 'SHEET': return ctx.wb.sheets.indexOf(sh) + 1;
      case 'ADDRESS': return (sh === ctx.sheet ? '' : '$' + quoteSheet(sh.name) + '.') + '$' + colName(c) + '$' + (r + 1);
      case 'COORD': return '$' + colName(ctx.wb.sheets.indexOf(sh)) + ':$' + colName(c) + '$' + (r + 1);
      case 'CONTENTS': if (isErr(val)) { throw val; } return val == null ? 0 : typeof val === 'boolean' ? (val ? 1 : 0) : val;
      case 'TYPE': return typeof val === 'string' ? 'l' : val == null ? 'b' : 'v';
      case 'PREFIX': { if (typeof val !== 'string') { return ''; } const ha = cell && cell.s && cell.s.ha; return ha === 'center' ? '^' : ha === 'right' ? '"' : "'"; }
      case 'PROTECT': return 1;
      case 'FORMAT': return cellFormatCode(cell && cell.fmt);
      case 'COLOR': { const code = cell && cell.fmt; return code && parseFormat(String(code)).sections.length > 1 && parseFormat(String(code)).sections[1].color ? 1 : 0; }
      case 'PARENTHESES': return cell && cell.fmt && String(cell.fmt).indexOf('(') >= 0 ? 1 : 0;
      case 'WIDTH': { const cols = sh.extra && sh.extra.cols; const px = cols && cols[colName(c)] != null ? Number(cols[colName(c)]) : 64; return Math.floor(px / 7); }
      case 'FILENAME': return '';
      default: return fail(ERR.ARG);
    }
  });

  // the spreadsheet
  GRP = 'Lookup';
  fx('ERRORTYPE', 1, 1, 'value', 'The number LibreOffice gives an error (Err:502 → 502; #DIV/0! → 532 …).', (A) => { const e = errorOf(A); if (!e) { return fail(ERR.NA); } if (ERR_CODES[e]) { return ERR_CODES[e]; } const m = /^Err:(\d+)$/.exec(e); return m ? Number(m[1]) : fail(ERR.NA); });
  fx('SHEET', 0, 1, 'reference or name', 'The number of a sheet.', (A, ctx) => {
    if (!A.n) { return ctx.wb.sheets.indexOf(ctx.sheet) + 1; }
    const v = A.raw(0);
    if (v instanceof RangeVal) { return ctx.wb.sheets.indexOf(v.sheet) + 1; }
    const sh = ctx.wb.sheetByName(toText(deref(v, ctx)));
    return sh ? ctx.wb.sheets.indexOf(sh) + 1 : fail(ERR.ARG);
  });
  fx('SHEETS', 0, -1, 'reference', 'The number of sheets in the book or in a reference.', (A, ctx) => {
    if (!A.n) { return ctx.wb.sheets.length; }
    const seen = new Set();
    for (let i = 0; i < A.n; i++) { const v = A.raw(i); if (v instanceof RangeVal) { seen.add(v.sheet); } else if (v instanceof RefList) { v.areas.forEach((x) => seen.add(x.sheet)); } else { if (isErr(v)) { throw v; } return fail(ERR.PARAM); } }
    return seen.size;
  });
  fx('CURRENT', 0, 0, '', 'The value of the formula worked out so far (=1+2+CURRENT() is 6).', (A, ctx) => { const v = ctx.cur; if (v == null) { return 0; } if (isErr(v)) { throw v; } return v; });
  fx('AREAS', 1, 1, 'reference', 'The number of areas in a reference.', (A) => { const v = A.raw(0); if (v instanceof RefList) { return v.areas.length; } if (!(v instanceof RangeVal)) { if (isErr(v)) { throw v; } return fail(ERR.PARAM); } return 1; });
  fx('STYLE', 1, 3, 'style; time; style 2', 'Applies a cell style (in CalcBase: answers 0, the style is set with the toolbar).', () => 0);
  fx('HYPERLINK', 1, 2, 'URL; cell text', 'A link: the cell shows the text (or the URL).', (A) => (A.n === 2 && A.has(1) ? A.val(1) : A.str(0)));

  // engineering (LibreOffice's Analysis add-in)
  GRP = 'Engineering';
  /** A number in base 2/8/16 as the add-in reads it: up to 10 digits, ten digits starting high is negative (two's complement). */
  function fromBase(s, base) {
    s = String(s);
    if (s.length > 10) { return fail(ERR.ARG); }
    if (!s.length) { return 0; }
    let v = 0; let first = -1;
    for (const ch of s) { const u = ch.toUpperCase(); const n = /[0-9]/.test(ch) ? ch.charCodeAt(0) - 48 : /[A-Za-z]/.test(ch) ? u.charCodeAt(0) - 55 : base; if (n >= base) { return fail(ERR.ARG); } if (first < 0) { first = n; } v = v * base + n; }
    if (s.length === 10 && first >= base / 2) { v = -(xpow(base, 10) - v); }
    return v;
  }
  const LIMITS = { 2: [-512, 511], 8: [-536870912, 536870911], 16: [-549755813888, 549755813887] };
  function toBase(num, base, A, pi) {
    let places = 0; let use = false;
    if (A.has(pi)) { places = int32(A.num(pi)); use = true; }
    num = approxFloor(num);
    const [lo, hi] = LIMITS[base];
    if (num < lo || num > hi || (use && (places <= 0 || places > 10))) { return fail(ERR.ARG); }
    const neg = num < 0;
    let n = neg ? xpow(base, 10) + num : num;
    let s = n.toString(base).toUpperCase();
    if (use) {
      if (!neg && s.length > places) { return fail(ERR.ARG); }
      if ((neg && s.length < 10) || (!neg && s.length < places)) { s = (neg ? '-123456789ABCDEF'[base - 1] : '0').repeat(places - s.length) + s; }
    }
    void n;
    return s;
  }
  const baseStr = (A, i) => { const v = A.val(i); if (isErr(v)) { throw v; } return typeof v === 'number' ? general(v) : toText(v); };
  const conv = (from, to) => (A) => (to === 10 ? fromBase(baseStr(A, 0), from) : toBase(from === 10 ? A.num(0) : fromBase(baseStr(A, 0), from), to, A, 1));
  [['BIN2DEC', 2, 10], ['BIN2OCT', 2, 8], ['BIN2HEX', 2, 16], ['OCT2DEC', 8, 10], ['OCT2BIN', 8, 2], ['OCT2HEX', 8, 16], ['HEX2DEC', 16, 10], ['HEX2BIN', 16, 2], ['HEX2OCT', 16, 8], ['DEC2BIN', 10, 2], ['DEC2OCT', 10, 8], ['DEC2HEX', 10, 16]].forEach(([name, from, to]) => {
    const nm = { 2: 'binary', 8: 'octal', 10: 'decimal', 16: 'hexadecimal' };
    fx(name, 1, to === 10 ? 1 : 2, (from === 10 ? 'number' : nm[from] + ' number') + (to === 10 ? '' : '; places'), 'A ' + nm[from] + ' number as a ' + nm[to] + ' number.', name === 'DEC2BIN' || name === 'DEC2OCT' ? (A) => toBase(int32(A.num(0)), to, A, 1) : conv(from, to));
  });
  fx('DELTA', 1, 2, 'number 1; number 2', '1 when two numbers are equal, otherwise 0.', (A) => (A.num(0) === (A.has(1) ? A.num(1) : 0) ? 1 : 0));
  fx('GESTEP', 1, 2, 'number; step', '1 when the number is at least the step, otherwise 0.', (A) => (A.num(0) >= (A.has(1) ? A.num(1) : 0) ? 1 : 0));
  fx('ERF', 1, 2, 'lower limit; upper limit', 'The error function (from 0, or between two limits).', (A) => { const ll = A.num(0); const v = A.has(1) ? erf(A.num(1)) - erf(ll) : erf(ll); return isFinite(v) ? v : fail(ERR.ARG); });
  fx('ERFC', 1, 1, 'lower limit', 'The complementary error function.', (A) => erfc(A.num(0)));
  // Bessel functions (Deuflhard and Hohmann's adjoint summation for J and Y, the series for I, polynomials for K)
  function besselJ(x, N) {
    if (N < 0) { return fail(ERR.ARG); }
    if (x === 0) { return N === 0 ? 1 : 0; }
    const sign = N % 2 === 1 && x < 0 ? -1 : 1; const X = Math.abs(x);
    const maxIt = 9000000; const est = X * 1.5 + N; const asym = xpow(X, 0.4) > N;
    if (est > maxIt) { if (!asym) { return fail(ERR.CONV); } return sign * Math.sqrt(2 / Math.PI / X) * Math.cos(X - N * Math.PI / 2 - Math.PI / 4); }
    const eps = 1e-15; let found = false; let k = 0; let u; let mBar; let gBar; let gdu; let g = 0; let du = 0; let fBar = -1;
    if (N === 0) { u = 1; gdu = 0; gBar = -2 / X; du = gdu / gBar; u = u + du; g = -1 / gBar; fBar = fBar * g; k = 2; } else {
      u = 0;
      for (k = 1; k <= N - 1; k = k + 1) { mBar = 2 * ((k - 1) % 2) * fBar; gdu = -g * du - mBar * u; gBar = mBar - 2 * k / X + g; du = gdu / gBar; u = u + du; g = -1 / gBar; fBar = fBar * g; }
      mBar = 2 * ((k - 1) % 2) * fBar; gdu = fBar - g * du - mBar * u; gBar = mBar - 2 * k / X + g; du = gdu / gBar; u = u + du; g = -1 / gBar; fBar = fBar * g; k = k + 1;
    }
    do { mBar = 2 * ((k - 1) % 2) * fBar; gdu = -g * du - mBar * u; gBar = mBar - 2 * k / X + g; du = gdu / gBar; u = u + du; g = -1 / gBar; fBar = fBar * g; found = Math.abs(du) <= Math.abs(u) * eps; k = k + 1; } while (!found && k <= maxIt);
    if (!found) { return fail(ERR.CONV); }
    return u * sign;
  }
  function besselI(x, n) {
    if (n < 0) { return fail(ERR.ARG); }
    const xh = x / 2; let t = 1;
    for (let k = 1; k <= n; ++k) { t = t / k * xh; }
    let r = t;
    if (t !== 0) { let k = 1; do { t = t * xh / k * xh / (k + n); r += t; k++; } while (Math.abs(t) > Math.abs(r) * 1e-15 && k < 2000); }
    return r;
  }
  function besselK0(x) { if (x <= 2) { const h = x * 0.5; const y = h * h; return -xlog(h) * besselI(x, 0) + (-0.57721566 + y * (0.42278420 + y * (0.23069756 + y * (0.3488590e-1 + y * (0.262698e-2 + y * (0.10750e-3 + y * 0.74e-5)))))); } const y = 2 / x; return xexp(-x) / Math.sqrt(x) * (1.25331414 + y * (-0.7832358e-1 + y * (0.2189568e-1 + y * (-0.1062446e-1 + y * (0.587872e-2 + y * (-0.251540e-2 + y * 0.53208e-3)))))); }
  function besselK1(x) { if (x <= 2) { const h = x * 0.5; const y = h * h; return xlog(h) * besselI(x, 1) + (1 + y * (0.15443144 + y * (-0.67278579 + y * (-0.18156897 + y * (-0.1919402e-1 + y * (-0.110404e-2 + y * -0.4686e-4)))))) / x; } const y = 2 / x; return xexp(-x) / Math.sqrt(x) * (1.25331414 + y * (0.23498619 + y * (-0.3655620e-1 + y * (0.1504268e-1 + y * (-0.780353e-2 + y * (0.325614e-2 + y * -0.68245e-3)))))); }
  function besselK(x, n) { if (n === 0) { return besselK0(x); } if (n === 1) { return besselK1(x); } const tox = 2 / x; let km = besselK0(x); let k = besselK1(x); for (let i = 1; i < n; i++) { const kp = km + i * tox * k; km = k; k = kp; } return k; }
  function besselY0(x) {
    if (x <= 0 || Math.abs(x) > 9223372036854775808 * 4) { return fail(ERR.ARG); }
    if (x > 5.0e+6) { return Math.sqrt(1 / Math.PI / x) * (Math.sin(x) - Math.cos(x)); }
    const eps = 1e-15; const EG = 0.57721566490153286060;
    let alpha = xlog(x / 2) + EG; let u = alpha; let k = 1; let gdu = 0; let gBar = -2 / x; let du = gdu / gBar; let g = -1 / gBar; let fBar = -1 * g; let sa = 1; let found = false;
    k = k + 1;
    do { const km = (k - 1) % 2; const mBar = (2 * km) * fBar; if (km === 0) { alpha = 0; } else { alpha = sa * (4 / k); sa = -sa; } gdu = fBar * alpha - g * du - mBar * u; gBar = mBar - (2 * k) / x + g; du = gdu / gBar; u = u + du; g = -1 / gBar; fBar = fBar * g; found = Math.abs(du) <= Math.abs(u) * eps; k = k + 1; } while (!found && k < 9000000);
    if (!found) { return fail(ERR.CONV); }
    return u * (2 / Math.PI);
  }
  function besselY1(x) {
    if (x <= 0 || Math.abs(x) > 9223372036854775808 * 4) { return fail(ERR.ARG); }
    if (x > 5.0e+6) { return -Math.sqrt(1 / Math.PI / x) * (Math.sin(x) + Math.cos(x)); }
    const eps = 1e-15; const EG = 0.57721566490153286060;
    let alpha = 1 / x; let fBar = -1; let u = alpha; let k = 1;
    alpha = 1 - EG - xlog(x / 2);
    let gdu = -alpha; let gBar = -2 / x; let du = gdu / gBar; u = u + du; let g = -1 / gBar; fBar = fBar * g; let sa = -1; let found = false;
    k = k + 1;
    do { const km = (k - 1) % 2; const mBar = (2 * km) * fBar; const q = (k - 1) / 2; if (km === 0) { alpha = sa * (1 / q + 1 / (q + 1)); sa = -sa; } else { alpha = 0; } gdu = fBar * alpha - g * du - mBar * u; gBar = mBar - (2 * k) / x + g; du = gdu / gBar; u = u + du; g = -1 / gBar; fBar = fBar * g; found = Math.abs(du) <= Math.abs(u) * eps; k = k + 1; } while (!found && k < 9000000);
    if (!found) { return fail(ERR.CONV); }
    return -u * 2 / Math.PI;
  }
  function besselY(x, n) { if (n === 0) { return besselY0(x); } if (n === 1) { return besselY1(x); } const tox = 2 / x; let ym = besselY0(x); let y = besselY1(x); for (let i = 1; i < n; i++) { const yp = i * tox * y - ym; ym = y; y = yp; } return y; }
  fx('BESSELJ', 2, 2, 'x; order', 'The Bessel function of the first kind J.', (A) => fin(besselJ(A.num(0), int32(A.num(1)))));
  fx('BESSELI', 2, 2, 'x; order', 'The modified Bessel function I.', (A) => fin(besselI(A.num(0), int32(A.num(1)))));
  fx('BESSELK', 2, 2, 'x; order', 'The modified Bessel function K.', (A) => { const x = A.num(0); const n = int32(A.num(1)); if (n < 0 || x <= 0) { return fail(ERR.ARG); } return fin(besselK(x, n)); });
  fx('BESSELY', 2, 2, 'x; order', 'The Bessel function of the second kind Y.', (A) => { const x = A.num(0); const n = int32(A.num(1)); if (n < 0 || x <= 0) { return fail(ERR.ARG); } return fin(besselY(x, n)); });
  // complex numbers written as text: "3+4i", "-2j", "i"
  /** printf("%.15g") (the add-in writes the parts of a complex number with it). */
  function fmtG(f, sign) {
    if (f === 0) { return sign ? '+0' : '0'; }
    const e = Math.floor(xlog10(Math.abs(Number(f.toPrecision(15)))));
    let s;
    if (e < -4 || e >= 15) { s = f.toExponential(14).replace(/\.?0+e/, 'e').replace(/e([+-])(\d)$/, 'e$10$2'); } else { s = f.toFixed(Math.max(0, 14 - e)); if (s.indexOf('.') >= 0) { s = s.replace(/0+$/, '').replace(/\.$/, ''); } }
    return sign && f > 0 ? '+' + s : s;
  }
  /** The add-in's ParseDouble: digits with . or , as the point, an exponent; answers [value, rest] or null. */
  function parseCxNum(s) {
    const m = /^([+-]?)(?:(\d+)(?:[.,](\d*))?|[.,](\d+))(?:[eE]([+-]?\d*))?/.exec(s);
    if (!m) {
      const m2 = /^([+-])(?=[ij])/.exec(s);
      if (m2) { return [0, s.slice(1), true]; }
      return null;
    }
    const txt = (m[1] || '') + (m[2] || '0') + '.' + (m[3] || m[4] || '0') + (m[5] && /\d/.test(m[5]) ? 'e' + m[5] : '');
    return [Number(txt), s.slice(m[0].length - (m[5] != null && !/\d/.test(m[5]) ? m[5].length + 1 : 0)), false];
  }
  function parseComplex(str) {
    str = String(str);
    if ((str === 'i' || str === 'j')) { return { r: 0, i: 1, c: str }; }
    if (/^[+-][ij]$/.test(str)) { return { r: 0, i: str[0] === '-' ? -1 : 1, c: str[1] }; }
    const a = parseCxNum(str);
    if (!a) { return fail(ERR.ARG); }
    let [f, rest] = a;
    if (a[2]) { return fail(ERR.ARG); }
    if (rest === '') { return { r: f, i: 0, c: '' }; }
    const ch = rest[0];
    if ((ch === 'i' || ch === 'j') && rest.length === 1) { return { r: 0, i: f, c: ch }; }
    if (ch === '+' || ch === '-') {
      if ((rest[1] === 'i' || rest[1] === 'j') && rest.length === 2) { return { r: f, i: ch === '+' ? 1 : -1, c: rest[1] }; }
      const b = parseCxNum(rest);
      if (b && !b[2] && (b[1] === 'i' || b[1] === 'j')) { return { r: f, i: b[0], c: b[1] }; }
    }
    return fail(ERR.ARG);
  }
  function cxText(z) {
    if (!isFinite(z.r) || !isFinite(z.i)) { return fail(ERR.ARG); }
    const hasI = z.i !== 0; const hasR = !hasI || z.r !== 0;
    let s = hasR ? fmtG(z.r, false) : '';
    if (hasI) { if (z.i === 1) { if (hasR) { s += '+'; } } else if (z.i === -1) { s += '-'; } else { s += fmtG(z.i, hasR); } s += z.c !== 'j' ? 'i' : 'j'; }
    return s;
  }
  const cxArg = (A, i) => { const v = A.val(i); if (isErr(v)) { throw v; } return parseComplex(typeof v === 'number' ? general(v) : toText(v)); };
  const cxAbs = (z) => Math.hypot(z.r, z.i);
  const cxPhase = (z) => { if (z.r === 0 && z.i === 0) { return fail(ERR.ARG); } const p = Math.acos(z.r / cxAbs(z)); return z.i < 0 ? -p : p; };
  const arcOkC = (x) => Math.abs(x) <= 9223372036854775808 * 4 || fail(ERR.ARG);
  const CX = {
    sqrt: (z) => { const p = cxAbs(z); const ii = Math.sqrt(p - z.r) * Math.SQRT1_2; return { r: Math.sqrt(p + z.r) * Math.SQRT1_2, i: z.i < 0 ? -ii : ii, c: z.c }; },
    sin: (z) => { arcOkC(z.r); return z.i ? { r: Math.sin(z.r) * Math.cosh(z.i), i: Math.cos(z.r) * Math.sinh(z.i), c: z.c } : { r: Math.sin(z.r), i: 0, c: z.c }; },
    cos: (z) => { arcOkC(z.r); return z.i ? { r: Math.cos(z.r) * Math.cosh(z.i), i: -(Math.sin(z.r) * Math.sinh(z.i)), c: z.c } : { r: Math.cos(z.r), i: 0, c: z.c }; },
    exp: (z) => { const e = xexp(z.r); return { r: e * Math.cos(z.i), i: e * Math.sin(z.i), c: z.c }; },
    ln: (z) => { if (z.r === 0 && z.i === 0) { return fail(ERR.ARG); } const a = cxAbs(z); let i = Math.acos(z.r / a); if (z.i < 0) { i = -i; } return { r: xlog(a), i, c: z.c }; },
    tan: (z) => { if (z.i) { arcOkC(2 * z.r); const s = 1 / (Math.cos(2 * z.r) + Math.cosh(2 * z.i)); return { r: Math.sin(2 * z.r) * s, i: Math.sinh(2 * z.i) * s, c: z.c }; } arcOkC(z.r); return { r: Math.tan(z.r), i: 0, c: z.c }; },
    sec: (z) => { if (z.i) { arcOkC(2 * z.r); const s = 1 / (Math.cosh(2 * z.i) + Math.cos(2 * z.r)); return { r: 2 * Math.cos(z.r) * Math.cosh(z.i) * s, i: 2 * Math.sin(z.r) * Math.sinh(z.i) * s, c: z.c }; } arcOkC(z.r); return { r: 1 / Math.cos(z.r), i: 0, c: z.c }; },
    csc: (z) => { if (z.i) { arcOkC(2 * z.r); const s = 1 / (Math.cosh(2 * z.i) - Math.cos(2 * z.r)); return { r: 2 * Math.sin(z.r) * Math.cosh(z.i) * s, i: -2 * Math.cos(z.r) * Math.sinh(z.i) * s, c: z.c }; } arcOkC(z.r); return { r: 1 / Math.sin(z.r), i: 0, c: z.c }; },
    cot: (z) => { if (z.i) { arcOkC(2 * z.r); const s = 1 / (Math.cosh(2 * z.i) - Math.cos(2 * z.r)); return { r: Math.sin(2 * z.r) * s, i: -(Math.sinh(2 * z.i) * s), c: z.c }; } arcOkC(z.r); return { r: 1 / Math.tan(z.r), i: 0, c: z.c }; },
    sinh: (z) => { arcOkC(z.r); return z.i ? { r: Math.sinh(z.r) * Math.cos(z.i), i: Math.cosh(z.r) * Math.sin(z.i), c: z.c } : { r: Math.sinh(z.r), i: 0, c: z.c }; },
    cosh: (z) => { arcOkC(z.r); return z.i ? { r: Math.cosh(z.r) * Math.cos(z.i), i: Math.sinh(z.r) * Math.sin(z.i), c: z.c } : { r: Math.cosh(z.r), i: 0, c: z.c }; },
    sech: (z) => { if (z.i) { arcOkC(2 * z.r); const s = 1 / (Math.cosh(2 * z.r) + Math.cos(2 * z.i)); return { r: 2 * Math.cosh(z.r) * Math.cos(z.i) * s, i: -(2 * Math.sinh(z.r) * Math.sin(z.i) * s), c: z.c }; } arcOkC(z.r); return { r: 1 / Math.cosh(z.r), i: 0, c: z.c }; },
    csch: (z) => { if (z.i) { arcOkC(2 * z.r); const s = 1 / (Math.cosh(2 * z.r) - Math.cos(2 * z.i)); return { r: 2 * Math.sinh(z.r) * Math.cos(z.i) * s, i: -(2 * Math.cosh(z.r) * Math.sin(z.i) * s), c: z.c }; } arcOkC(z.r); return { r: 1 / Math.sinh(z.r), i: 0, c: z.c }; },
  };
  fx('COMPLEX', 2, 3, 'real part; imaginary part; suffix', 'A complex number as text from its parts.', (A) => { const r = A.num(0); const i = A.num(1); let c = 'i'; if (A.has(2)) { const s = A.str(2); if (s !== 'i' && s !== '' && s !== 'j') { return fail(ERR.ARG); } c = s === 'j' ? 'j' : 'i'; } return cxText({ r, i, c }); });
  fx('IMREAL', 1, 1, 'complex number', 'The real part of a complex number.', (A) => cxArg(A, 0).r);
  fx('IMAGINARY', 1, 1, 'complex number', 'The imaginary part of a complex number.', (A) => cxArg(A, 0).i);
  fx('IMABS', 1, 1, 'complex number', 'The absolute value of a complex number.', (A) => cxAbs(cxArg(A, 0)));
  fx('IMARGUMENT', 1, 1, 'complex number', 'The argument (angle) of a complex number.', (A) => cxPhase(cxArg(A, 0)));
  fx('IMCONJUGATE', 1, 1, 'complex number', 'The complex conjugate.', (A) => { const z = cxArg(A, 0); return cxText({ r: z.r, i: -z.i, c: z.c }); });
  fx('IMPOWER', 2, 2, 'complex number; power', 'A complex number raised to a power.', (A) => {
    const z = cxArg(A, 0); const f = A.num(1);
    if (z.r === 0 && z.i === 0) { if (f <= 0) { return fail(ERR.ARG); } return cxText({ r: 0, i: 0, c: z.c }); }
    let p = cxAbs(z); let phi = Math.acos(z.r / p); if (z.i < 0) { phi = -phi; }
    p = xpow(p, f); phi *= f;
    return cxText({ r: Math.cos(phi) * p, i: Math.sin(phi) * p, c: z.c });
  });
  fx('IMDIV', 2, 2, 'dividend; divisor', 'The quotient of two complex numbers.', (A) => { const a = cxArg(A, 0); const b = cxArg(A, 1); if (b.r === 0 && b.i === 0) { return fail(ERR.ARG); } const f = 1 / (b.r * b.r + b.i * b.i); return cxText({ r: (a.r * b.r + a.i * b.i) * f, i: (b.r * a.i - a.r * b.i) * f, c: a.c || b.c }); });
  fx('IMSUB', 2, 2, 'complex number 1; complex number 2', 'The difference of two complex numbers.', (A) => { const a = cxArg(A, 0); const b = cxArg(A, 1); return cxText({ r: a.r - b.r, i: a.i - b.i, c: a.c || b.c }); });
  function cxList(A) { const out = []; for (const it of A.items()) { const v = it.v; if (isErr(v)) { throw v; } if (v == null || v === '') { continue; } out.push(parseComplex(typeof v === 'number' ? general(v) : toText(v))); } return out; }
  fx('IMSUM', 1, -1, 'complex number 1; complex number 2; …', 'The sum of complex numbers.', (A) => { const l = cxList(A); const z = { r: 0, i: 0, c: '' }; l.forEach((x) => { z.r += x.r; z.i += x.i; if (!z.c) { z.c = x.c; } }); return cxText(z); });
  fx('IMPRODUCT', 1, -1, 'complex number 1; complex number 2; …', 'The product of complex numbers.', (A) => { const l = cxList(A); if (!l.length) { return cxText({ r: 0, i: 0, c: '' }); } const z = { ...l[0] }; for (let k = 1; k < l.length; k++) { const r = z.r; const i = z.i; z.r = r * l[k].r - i * l[k].i; z.i = r * l[k].i + i * l[k].r; if (!z.c) { z.c = l[k].c; } } return cxText(z); });
  fx('IMSQRT', 1, 1, 'complex number', 'The square root of a complex number.', (A) => cxText(CX.sqrt(cxArg(A, 0))));
  fx('IMEXP', 1, 1, 'complex number', 'e raised to a complex number.', (A) => cxText(CX.exp(cxArg(A, 0))));
  fx('IMLN', 1, 1, 'complex number', 'The natural logarithm of a complex number.', (A) => cxText(CX.ln(cxArg(A, 0))));
  fx('IMLOG10', 1, 1, 'complex number', 'The base-10 logarithm of a complex number.', (A) => { const z = CX.ln(cxArg(A, 0)); return cxText({ r: z.r * Math.LOG10E, i: z.i * Math.LOG10E, c: z.c }); });
  fx('IMLOG2', 1, 1, 'complex number', 'The base-2 logarithm of a complex number.', (A) => { const z = CX.ln(cxArg(A, 0)); return cxText({ r: z.r * Math.LOG2E, i: z.i * Math.LOG2E, c: z.c }); });
  [['IMSIN', 'sin', 'sine'], ['IMCOS', 'cos', 'cosine'], ['IMTAN', 'tan', 'tangent'], ['IMSEC', 'sec', 'secant'], ['IMCSC', 'csc', 'cosecant'], ['IMCOT', 'cot', 'cotangent'], ['IMSINH', 'sinh', 'hyperbolic sine'], ['IMCOSH', 'cosh', 'hyperbolic cosine'], ['IMSECH', 'sech', 'hyperbolic secant'], ['IMCSCH', 'csch', 'hyperbolic cosecant']].forEach(([name, f, what]) => fx(name, 1, 1, 'complex number', 'The ' + what + ' of a complex number.', (A) => cxText(CX[f](cxArg(A, 0)))));
  // CONVERT: LibreOffice's table of units (name, factor to the class's base, class, prefixes allowed, offset for temperatures)
  const UNITS = [["g",1.0000000000000000E00,0,1],["sg",6.8522050005347800E-05,0,0],["lbm",2.2046229146913400E-03,0,0],["u",6.0221370000000000E23,0,1],["ozm",3.5273971800362700E-02,0,0],["stone",1.574730e-04,0,0],["ton",1.102311e-06,0,0],["grain",1.543236E01,0,0],["pweight",7.054792E-01,0,0],["hweight",1.968413E-05,0,0],["shweight",2.204623E-05,0,0],["brton",9.842065E-07,0,0],["cwt",2.2046226218487758E-05,0,0],["shweight",2.2046226218487758E-05,0,0],["uk_cwt",1.9684130552221213E-05,0,0],["lcwt",1.9684130552221213E-05,0,0],["hweight",1.9684130552221213E-05,0,0],["uk_ton",9.8420652761106063E-07,0,0],["LTON",9.8420652761106063E-07,0,0],["m",1.0000000000000000E00,1,1],["mi",6.2137119223733397E-04,1,0],["Nmi",5.3995680345572354E-04,1,0],["in",3.9370078740157480E01,1,0],["ft",3.2808398950131234E00,1,0],["yd",1.0936132983377078E00,1,0],["ang",1.0000000000000000E10,1,1],["Pica",2.8346456692913386E03,1,0],["picapt",2.8346456692913386E03,1,0],["pica",2.36220472441E02,1,0],["ell",8.748906E-01,1,0],["parsec",3.240779E-17,1,1],["pc",3.240779E-17,1,1],["lightyear",1.0570234557732930E-16,1,1],["ly",1.0570234557732930E-16,1,1],["survey_mi",6.2136994949494949E-04,1,0],["yr",3.1688087814028950E-08,2,0],["day",1.1574074074074074E-05,2,0],["d",1.1574074074074074E-05,2,0],["hr",2.7777777777777778E-04,2,0],["mn",1.6666666666666667E-02,2,0],["min",1.6666666666666667E-02,2,0],["sec",1.0000000000000000E00,2,1],["s",1.0000000000000000E00,2,1],["Pa",1.0000000000000000E00,3,1],["atm",9.8692329999819300E-06,3,1],["at",9.8692329999819300E-06,3,1],["mmHg",7.5006170799862700E-03,3,1],["Torr",7.5006380000000000E-03,3,0],["psi",1.4503770000000000E-04,3,0],["N",1.0000000000000000E00,4,1],["dyn",1.0000000000000000E05,4,1],["dy",1.0000000000000000E05,4,1],["lbf",2.24808923655339E-01,4,0],["pond",1.019716E02,4,1],["J",1.0000000000000000E00,5,1],["e",1.0000000000000000E07,5,1],["c",2.3900624947346700E-01,5,1],["cal",2.3884619064201700E-01,5,1],["eV",6.2414570000000000E18,5,1],["ev",6.2414570000000000E18,5,1],["HPh",3.7250611111111111E-07,5,0],["hh",3.7250611111111111E-07,5,0],["Wh",2.7777777777777778E-04,5,1],["wh",2.7777777777777778E-04,5,1],["flb",2.37304222192651E01,5,0],["BTU",9.4781506734901500E-04,5,0],["btu",9.4781506734901500E-04,5,0],["W",1.0000000000000000E00,6,1],["w",1.0000000000000000E00,6,1],["HP",1.341022E-03,6,0],["h",1.341022E-03,6,0],["PS",1.359622E-03,6,0],["T",1.0000000000000000E00,7,1],["ga",1.0000000000000000E04,7,1],["C",1.0000000000000000E00,8,0,-2.7315000000000000E02],["cel",1.0000000000000000E00,8,0,-2.7315000000000000E02],["F",1.8000000000000000E00,8,0,-2.5537222222222222E02],["fah",1.8000000000000000E00,8,0,-2.5537222222222222E02],["K",1.0000000000000000E00,8,1,+0.0000000000000000E00],["kel",1.0000000000000000E00,8,1,+0.0000000000000000E00],["Reau",8.0000000000000000E-01,8,0,-2.7315000000000000E02],["Rank",1.8000000000000000E00,8,0,+0.0000000000000000E00],["tsp",2.0288413621105798E02,9,0],["tbs",6.7628045403685994E01,9,0],["oz",3.3814022701842997E01,9,0],["cup",4.2267528377303746E00,9,0],["pt",2.1133764188651873E00,9,0],["us_pt",2.1133764188651873E00,9,0],["uk_pt",1.7597539863927023E00,9,0],["qt",1.0566882094325937E00,9,0],["gal",2.6417205235814842E-01,9,0],["l",1.0000000000000000E00,9,1],["L",1.0000000000000000E00,9,1],["lt",1.0000000000000000E00,9,1],["m3",1.0000000000000000E-03,9,1],["mi3",2.3991275857892772E-13,9,0],["Nmi3",1.5742621468581148E-13,9,0],["in3",6.1023744094732284E01,9,0],["ft3",3.5314666721488590E-02,9,0],["yd3",1.3079506193143922E-03,9,0],["ang3",1.0000000000000000E27,9,1],["Pica3",2.2776990435870636E07,9,0],["picapt3",2.2776990435870636E07,9,0],["pica3",1.31811287245E04,9,0],["barrel",6.2898107704321051E-03,9,0],["bushel",2.837759E-02,9,0],["regton",3.531467E-04,9,0],["GRT",3.531467E-04,9,0],["Schooner",2.3529411764705882E00,9,0],["Middy",3.5087719298245614E00,9,0],["Glass",5.0000000000000000E00,9,0],["Sixpack",0.5,9,0],["Humpen",2.0,9,0],["ly3",1.1810108125623799E-51,9,0],["MTON",1.4125866688595436E00,9,0],["tspm",2.0000000000000000E02,9,0],["uk_gal",2.1996924829908779E-01,9,0],["uk_qt",8.7987699319635115E-01,9,0],["m2",1.0000000000000000E00,10,1],["mi2",3.8610215854244585E-07,10,0],["Nmi2",2.9155334959812286E-07,10,0],["in2",1.5500031000062000E03,10,0],["ft2",1.0763910416709722E01,10,0],["yd2",1.1959900463010803E00,10,0],["ang2",1.0000000000000000E20,10,1],["Pica2",8.0352160704321409E06,10,0],["picapt2",8.0352160704321409E06,10,0],["pica2",5.58001116002232E04,10,0],["Morgen",4.0000000000000000E-04,10,0],["ar",1.000000E-02,10,1],["acre",2.471053815E-04,10,0],["uk_acre",2.4710538146716534E-04,10,0],["us_acre",2.4710439304662790E-04,10,0],["ly2",1.1172985860549147E-32,10,0],["ha",1.000000E-04,10,0],["m/s",1.0000000000000000E00,11,1],["m/sec",1.0000000000000000E00,11,1],["m/h",3.6000000000000000E03,11,1],["m/hr",3.6000000000000000E03,11,1],["mph",2.2369362920544023E00,11,0],["kn",1.9438444924406048E00,11,0],["admkn",1.9438446603753486E00,11,0],["ludicrous speed",2.0494886343432328E-14,11,0],["ridiculous speed",4.0156958471424288E-06,11,0],["bit",1.00E00,12,1],["byte",1.25E-01,12,1]];
  /** How a unit name matches a table entry: 0 exactly, a power of ten with an SI prefix (squared/cubed for areas and volumes), binary prefixes for information, or null. */
  function unitLevel(u, ref) {
    let s = ref;
    const ci = ref.lastIndexOf('^');
    if (ci > 0 && ci === ref.length - 2) { s = ref.slice(0, ref.length - 2) + ref[ref.length - 1]; }
    if (u[0] === s) { return 0; }
    const pref = !!u[3];
    const one = pref && s.length > 1 && u[0] === s.slice(1);
    if (one || (pref && s.length > 2 && u[0] === s.slice(2) && s[0] === 'd' && s[1] === 'a')) {
      const p = s[0];
      const map = { y: -24, z: -21, a: -18, f: -15, p: -12, n: -9, u: -6, m: -3, c: -2, e: 1, h: 2, k: 3, M: 6, G: 9, T: 12, P: 15, E: 18, Z: 21, Y: 24 };
      let n = p === 'd' ? (one ? -1 : 1) : map[p];
      if (n === undefined) { return null; }
      const last = s[s.length - 1];
      if (last === '2') { n *= 2; } else if (last === '3') { n *= 3; }
      return n;
    }
    if (s.length > 2 && u[0] === s.slice(2) && u[2] === 12) {
      if (s[1] !== 'i') { return null; }
      const n = { k: 10, M: 20, G: 30, T: 40, P: 50, E: 60, Z: 70, Y: 80 }[s[0]];
      return n === undefined ? null : n;
    }
    return null;
  }
  const pow10Exp = (f, n) => (n ? f * xpow(10, n) : f);
  GRP = 'Engineering';
  fx('CONVERT', 3, 3, 'number; from unit; to unit', 'A measurement in another unit ("m", "ft", "kg", "C", "F", "mi", "km", "l" …).', (A) => {
    const f = A.num(0); const from = A.str(1); const to = A.str(2);
    let pf = null; let pt = null; let lf = 0; let lt = 0; let sf = true; let st = true;
    for (const u of UNITS) {
      if (sf) { const n = unitLevel(u, from); if (n !== null) { pf = u; lf = n; if (!n) { sf = false; } } }
      if (st) { const n = unitLevel(u, to); if (n !== null) { pt = u; lt = n; if (!n) { st = false; } } }
      if (!sf && !st) { break; }
    }
    if (!pf || !pt || pf[2] !== pt[2]) { return fail(ERR.ARG); }
    let v;
    if (pf.length === 5) {
      let x = lf ? pow10Exp(f, lf) : f; x /= pf[1]; x -= pf[4];
      x += pt[4]; x *= pt[1]; v = lt ? pow10Exp(x, -lt) : x;
    } else {
      const binF = lf > 0 && lf % 10 === 0; const binT = lt > 0 && lt % 10 === 0;
      if (pf[2] === 12 && (binF || binT)) {
        if (binF && binT) { v = f * (pt[1] / pf[1]); const d = lf - lt; if (d) { v *= xpow(2, d); } } else if (binF) { v = f * ((pt[1] / pf[1]) * (xpow(2, lf) / xpow(10, lt))); } else { v = f * ((pt[1] / pf[1]) * (xpow(10, lf) / xpow(2, lt))); }
      } else { v = f * (pt[1] / pf[1]); const d = lf - lt; if (d) { v = pow10Exp(v, d); } }
    }
    return fin(v);
  });


  // ---- conditional formatting and validity, judged as Calc judges them ---
  // No DOM here: the page asks cfMatch / validate and paints or warns.
  //
  // A conditional format rule (the items of LibreOffice's Format ▸ Conditional dialog):
  //   { type: 'cell', op, value1?, value2? }          "Cell value is" — op: equal, notEqual, less, greater,
  //       lessEqual, greaterEqual, between, notBetween, duplicate, notDuplicate, top, bottom, topPercent,
  //       bottomPercent, aboveAverage, belowAverage, aboveEqualAverage, belowEqualAverage, error, noError,
  //       beginsWith, endsWith, contains, notContains; value1/value2 as typed ("10", "abc", "=B1*2").
  //   { type: 'formula', formula: '=…' }                "Formula is" (references relative to the range's top-left cell)
  //   { type: 'date', op }                              "Date is" — today, yesterday, tomorrow, last7Days, thisWeek,
  //       lastWeek, nextWeek, thisMonth, lastMonth, nextMonth, thisYear, lastYear, nextYear (weeks Sunday–Saturday)
  //   { type: 'colorScale', entries: [{ kind, value?, color }, …] }   2 or 3 entries; kind: min, max, value,
  //       percent, percentile, formula
  //   { type: 'dataBar', min: { kind, value? }, max: { kind, value? }, axis: 'automatic'|'middle'|'none',
  //       color, negativeColor, minLength: 0, maxLength: 100 }       kind adds 'auto'
  //   { type: 'iconSet', set: '3Arrows'…, entries: [{ kind, value? }, …], reverse: false, showValue: true }
  // Every rule may carry what the page needs to paint (style, …); cfMatch ignores it.

  const toCellValue = (x) => {
    if (x && typeof x === 'object' && !(x instanceof CalcError) && 't' in x) { return x.t === 'e' ? new CalcError(x.v) : x.t === '' ? null : x.v; }
    return x === undefined ? null : x;
  };
  /** An operand as the dialog holds it: a number, or text as typed ("=…" is a formula worked out for the cell). */
  function cfOperand(v, ctx) {
    if (v == null || v === '') { return { num: 0, str: '', isStr: false, missing: true }; }
    if (typeof v === 'number') { return { num: v, str: '', isStr: false }; }
    if (typeof v === 'boolean') { return { num: v ? 1 : 0, str: '', isStr: false }; }
    const s = String(v);
    let x;
    if (s.charAt(0) === '=' && s.length > 1) { x = ctx && ctx.evaluate ? toCellValue(ctx.evaluate(s)) : null; } else {
      const quoted = /^"(.*)"$/s.exec(s);
      if (quoted) { x = quoted[1].replace(/""/g, '"'); } else { const p = parseInput(s, (ctx && ctx.locale) || 'en'); x = p.t === 's' ? String(p.v) : p.v; }
    }
    if (isErr(x)) { return { num: 0, str: '', isStr: false, error: true }; }
    if (typeof x === 'string') { return { num: 0, str: x, isStr: true }; }
    return { num: x == null ? 0 : numOf(x), str: '', isStr: false };
  }
  /** What the formatted range holds, for the rules that look at all of it (duplicate, top, average, scales). */
  function cfStats(values) {
    const nums = []; const counts = new Map(); const strs = new Map();
    for (const raw of values || []) {
      const v = toCellValue(raw);
      if (v == null || isErr(v)) { continue; }
      if (typeof v === 'string') { strs.set(v, (strs.get(v) || 0) + 1); continue; }
      const n = numOf(v); nums.push(n); counts.set(n, (counts.get(n) || 0) + 1);
    }
    nums.sort((a, b) => a - b);
    const distinct = Array.from(counts.keys()).sort((a, b) => a - b);
    return { nums, counts, strs, distinct };
  }
  const statsOf = (ctx) => { if (!ctx) { return cfStats([]); } if (!ctx.stats) { ctx.stats = cfStats(ctx.values); } return ctx.stats; };
  function topN(st, arg, n, bottom) {
    if (st.nums.length <= n) { return true; }
    let cells = 0;
    const list = bottom ? st.distinct : st.distinct.slice().reverse();
    for (const v of list) { if (cells >= n) { return false; } if (bottom ? v >= arg : v <= arg) { return true; } cells += st.counts.get(v); }
    return true;
  }
  function topPercent(st, arg, p, bottom) {
    let cells = 0; const limit = Math.trunc(st.nums.length * p / 100);
    const list = bottom ? st.distinct : st.distinct.slice().reverse();
    for (const v of list) { if (cells >= limit) { return false; } if (bottom ? v >= arg : v <= arg) { return true; } cells += st.counts.get(v); }
    return true;
  }
  const average = (st) => st.nums.reduce((a, b) => a + b, 0) / st.nums.length;
  const ciEq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  /** The comparison operators of Calc's ScConditionEntry::IsValid (numbers, with approxEqual). */
  function cmpNum(op, x, a, b) {
    switch (op) {
      case 'equal': return lApproxEq(x, a);
      case 'notEqual': return !lApproxEq(x, a);
      case 'greater': return x > a && !lApproxEq(x, a);
      case 'greaterEqual': return x >= a || lApproxEq(x, a);
      case 'less': return x < a && !lApproxEq(x, a);
      case 'lessEqual': return x <= a || lApproxEq(x, a);
      case 'between': { const lo = Math.min(a, b); const hi = Math.max(a, b); return (x >= lo && x <= hi) || lApproxEq(x, lo) || lApproxEq(x, hi); }
      case 'notBetween': { const lo = Math.min(a, b); const hi = Math.max(a, b); return (x < lo || x > hi) && !lApproxEq(x, lo) && !lApproxEq(x, hi); }
      default: return false;
    }
  }
  /** The same operators for text (case-insensitive, Calc's collation for order). */
  function cmpStr(op, x, a, b, L) {
    const c = (p, q) => compare(p, q, L);
    switch (op) {
      case 'equal': return ciEq(x, a);
      case 'notEqual': return !ciEq(x, a);
      case 'greater': return c(x, a) > 0 && !ciEq(x, a);
      case 'greaterEqual': return c(x, a) >= 0 || ciEq(x, a);
      case 'less': return c(x, a) < 0 && !ciEq(x, a);
      case 'lessEqual': return c(x, a) <= 0 || ciEq(x, a);
      case 'between': { let lo = a; let hi = b; if (c(lo, hi) > 0) { [lo, hi] = [hi, lo]; } return c(x, lo) >= 0 && c(x, hi) <= 0; }
      case 'notBetween': { let lo = a; let hi = b; if (c(lo, hi) > 0) { [lo, hi] = [hi, lo]; } return c(x, lo) < 0 || c(x, hi) > 0; }
      default: return false;
    }
  }
  /** "Cell value is …" for one cell (Calc's IsCellValid). */
  function cellRuleMatches(rule, v, ctx) {
    const op = rule.op || 'equal';
    if (op === 'error') { return isErr(v); }
    if (op === 'noError') { return !isErr(v); }
    if (isErr(v)) { return false; }
    const L = locOf(ctx && ctx.locale);
    const o1 = cfOperand(rule.value1, ctx); const o2 = cfOperand(rule.value2, ctx);
    if (o1.error || ((op === 'between' || op === 'notBetween') && o2.error)) { return false; }
    const st = () => statsOf(ctx);
    // an empty cell is 0 against a number, "" against text
    const isNumCell = v == null ? !o1.isStr : typeof v !== 'string';
    if (isNumCell) {
      const x = v == null ? 0 : numOf(v);
      if (o1.isStr) {
        const sx = general(x);
        switch (op) {
          case 'beginsWith': return sx.startsWith(o1.str);
          case 'endsWith': return sx.endsWith(o1.str);
          case 'contains': return sx.indexOf(o1.str) >= 0;
          case 'notContains': return sx.indexOf(o1.str) < 0;
          case 'notEqual': return true;
          case 'duplicate': case 'notDuplicate': case 'top': case 'bottom': case 'topPercent': case 'bottomPercent': case 'aboveAverage': case 'belowAverage': case 'aboveEqualAverage': case 'belowEqualAverage': break;
          default: return false;
        }
      }
      if ((op === 'between' || op === 'notBetween') && o2.isStr) { return false; }
      switch (op) {
        case 'duplicate': case 'notDuplicate': { const d = (st().counts.get(x) || 0) > 1; return op === 'duplicate' ? d : !d; }
        case 'top': return topN(st(), x, o1.num, false);
        case 'bottom': return topN(st(), x, o1.num, true);
        case 'topPercent': return topPercent(st(), x, o1.num, false);
        case 'bottomPercent': return topPercent(st(), x, o1.num, true);
        case 'aboveAverage': return x > average(st());
        case 'aboveEqualAverage': return x >= average(st());
        case 'belowAverage': return x < average(st());
        case 'belowEqualAverage': return x <= average(st());
        case 'beginsWith': return general(x).startsWith(general(o1.num));
        case 'endsWith': return general(x).endsWith(general(o1.num));
        case 'contains': return general(x).indexOf(general(o1.num)) >= 0;
        case 'notContains': return general(x).indexOf(general(o1.num)) < 0;
        default: return cmpNum(op, x, o1.num, o2.num);
      }
    }
    const sx = v == null ? '' : String(v);
    if (op === 'duplicate' || op === 'notDuplicate') { if (sx !== '') { const d = (st().strs.get(sx) || 0) > 1; return op === 'duplicate' ? d : !d; } }
    if (!o1.isStr) { return op === 'notEqual'; }
    if ((op === 'between' || op === 'notBetween') && !o2.isStr) { return false; }
    const low = sx.toLowerCase(); const a = o1.str.toLowerCase();
    switch (op) {
      case 'top': case 'bottom': case 'topPercent': case 'bottomPercent': case 'aboveAverage': case 'belowAverage': case 'aboveEqualAverage': case 'belowEqualAverage': return false;
      case 'beginsWith': return low.startsWith(a);
      case 'endsWith': return low.endsWith(a);
      case 'contains': return low.indexOf(a) >= 0;
      case 'notContains': return low.indexOf(a) < 0;
      default: return cmpStr(op, sx, o1.str, o2.str, L);
    }
  }
  /** "Date is …" (Calc's ScCondDateFormatEntry: weeks run Sunday to Saturday). */
  function dateRuleMatches(op, v, today) {
    if (typeof v !== 'number' && typeof v !== 'boolean') { return false; }
    const d = approxFloor(numOf(v)); const t = Math.floor(today);
    const cd = serialToYmd(d); const td = serialToYmd(t);
    const wd = (dayOfWeek(t) + 6) % 7; // Monday 0 … Sunday 6, as tools::Date
    switch (op) {
      case 'today': return d === t;
      case 'tomorrow': return d === t + 1;
      case 'yesterday': return d === t - 1;
      case 'last7Days': return t >= d && t - 7 < d;
      case 'thisWeek': return wd !== 6 ? d >= t - (1 + wd) && d <= t + (5 - wd) : d >= t && d <= t + 6;
      case 'lastWeek': return wd !== 6 ? d >= t - (8 + wd) && d <= t - (2 + wd) : d >= t - 8 && d <= t - 1;
      case 'nextWeek': return wd !== 6 ? d >= t + (6 - wd) && d <= t + (12 - wd) : d >= t + 7 && d <= t + 13;
      case 'thisMonth': return cd.y === td.y && cd.m === td.m;
      case 'lastMonth': return td.m === 1 ? cd.m === 12 && cd.y === td.y - 1 : cd.y === td.y && cd.m === td.m - 1;
      case 'nextMonth': return td.m === 12 ? cd.m === 1 && cd.y === td.y + 1 : cd.y === td.y && cd.m === td.m + 1;
      case 'thisYear': return cd.y === td.y;
      case 'lastYear': return cd.y === td.y - 1;
      case 'nextYear': return cd.y === td.y + 1;
      default: return false;
    }
  }
  /** Calc's GetPercentile of the colour scales (on the sorted values). */
  function scalePercentile(a, p) { if (p < 0) { return a[0]; } const fl = approxFloor(p * (a.length - 1)); const diff = p * (a.length - 1) - fl; return diff === 0 ? a[fl] : a[fl] + diff * (a[fl + 1] - a[fl]); }
  function entryValue(e, mn, mx, st, ctx) {
    const v = e && e.value != null ? cfOperand(e.value, ctx).num : 0;
    switch (e && e.kind) {
      case 'percent': return mn + (mx - mn) * (v / 100);
      case 'min': return mn;
      case 'max': return mx;
      case 'percentile': return st.nums.length === 1 ? st.nums[0] : scalePercentile(st.nums, v / 100);
      default: return v;
    }
  }
  const hexRgb = (c) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '')); const n = m ? parseInt(m[1], 16) : 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgbHex = (r, g, b) => '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  function colorValue(v, v1, c1, v2, c2) { if (v <= v1) { return c1; } if (v >= v2) { return c2; } return (Math.trunc((v - v1) / (v2 - v1) * (c2 - c1)) + c1) & 255; }
  function scaleColor(rule, x, ctx) {
    const es = rule.entries || [];
    const st = statsOf(ctx);
    if (es.length < 2 || !st.nums.length) { return null; }
    const firstFixed = es[0].kind === 'value' || es[0].kind === 'formula'; const lastFixed = es[es.length - 1].kind === 'value' || es[es.length - 1].kind === 'formula';
    const mn = firstFixed ? cfOperand(es[0].value, ctx).num : st.nums[0];
    const mx = lastFixed ? cfOperand(es[es.length - 1].value, ctx).num : st.nums[st.nums.length - 1];
    if (mn > mx) { return null; }
    let i = 0;
    let vMin = entryValue(es[i], mn, mx, st, ctx); let cMin = es[i].color; i++;
    let vMax = entryValue(es[i], mn, mx, st, ctx); let cMax = es[i].color; i++;
    const eq = es[i - 1].kind === 'percentile' && x === mx && x === vMax;
    while (i < es.length && (x > vMax || eq)) { cMin = cMax; vMin = !eq ? vMax : vMax - 1; cMax = es[i].color; vMax = entryValue(es[i], mn, mx, st, ctx); i++; }
    const a = hexRgb(cMin); const b = hexRgb(cMax);
    return rgbHex(colorValue(x, vMin, a[0], vMax, b[0]), colorValue(x, vMin, a[1], vMax, b[1]), colorValue(x, vMin, a[2], vMax, b[2]));
  }
  function dataBar(rule, x, ctx) {
    const st = statsOf(ctx);
    if (!st.nums.length) { return null; }
    const vmin = st.nums[0]; const vmax = st.nums[st.nums.length - 1];
    const lo = rule.min || { kind: 'auto' }; const hi = rule.max || { kind: 'auto' };
    const limit = (e, isMin) => {
      const v = e.value != null ? cfOperand(e.value, ctx).num : 0;
      switch (e.kind) {
        case 'min': return vmin;
        case 'max': return vmax;
        case 'auto': return isMin ? Math.min(0, vmin) : Math.max(0, vmax);
        case 'percent': return vmin + (vmax - vmin) / 100 * v;
        case 'percentile': return scalePercentile(st.nums, v / 100);
        default: return v;
      }
    };
    let mn = limit(lo, true); let mx = limit(hi, false);
    const minLen = rule.minLength != null ? rule.minLength : 0; const maxLen = rule.maxLength != null ? rule.maxLength : 100;
    const axis = rule.axis || 'automatic';
    let length; let zero;
    if (axis === 'none') {
      length = x <= mn ? minLen : x >= mx ? maxLen : minLen + (x - mn) / (mx - mn) * (maxLen - minLen); zero = 0;
    } else if (axis === 'automatic') {
      if (lo.kind === 'auto' && mn > 0) { mn = 0; }
      if (hi.kind === 'max' && mx < 0) { mx = 0; }
      zero = mn < 0 ? (mx < 0 ? 100 : -100 * mn / (mx - mn)) : 0;
      const nn = Math.max(0, mn); const np = Math.min(0, mx);
      if (x < 0 && mn < 0) { length = x < mn ? -100 : -100 * (x - np) / (mn - np); } else { length = x > mx ? 100 : x <= mn ? 0 : 100 * (x - nn) / (mx - nn); }
    } else {
      zero = 50; const am = Math.max(Math.abs(mn), Math.abs(mx));
      if (x < 0 && mn < 0) { length = x < mn ? maxLen * (mn / am) : maxLen * (x / am); } else { length = x > mx ? maxLen * (mx / am) : maxLen * (Math.max(x, mn) / am); }
    }
    const negative = x < 0;
    return { length, zero, negative, color: negative ? (rule.negativeColor || '#ff0000') : (rule.color || '#2a6099') };
  }
  const ICON_SETS = { '3Arrows': 3, '3ArrowsGray': 3, '3Flags': 3, '3TrafficLights1': 3, '3TrafficLights2': 3, '3Signs': 3, '3Symbols': 3, '3Symbols2': 3, '3Smilies': 3, '3ColorSmilies': 3, '3Stars': 3, '3Triangles': 3, '4Arrows': 4, '4ArrowsGray': 4, '4RedToBlack': 4, '4Rating': 4, '4TrafficLights': 4, '5Arrows': 5, '5ArrowsGray': 5, '5Rating': 5, '5Quarters': 5, '5Boxes': 5 };
  function iconIndex(rule, x, ctx) {
    const es = rule.entries || [];
    const st = statsOf(ctx);
    if (es.length < 2) { return null; }
    const firstFixed = es[0].kind === 'value' || es[0].kind === 'formula'; const lastFixed = es[es.length - 1].kind === 'value' || es[es.length - 1].kind === 'formula';
    const mn = firstFixed ? cfOperand(es[0].value, ctx).num : st.nums[0];
    const mx = lastFixed ? cfOperand(es[es.length - 1].value, ctx).num : st.nums[st.nums.length - 1];
    let idx = 0; let i = 1;
    let vMax = entryValue(es[i], mn, mx, st, ctx); i++;
    while (i < es.length && x >= vMax) { ++idx; vMax = entryValue(es[i], mn, mx, st, ctx); i++; }
    if (x >= vMax) { ++idx; }
    if (rule.reverse) { idx = es.length - 1 - idx; }
    return idx;
  }
  /**
   * cfMatch(rule, value, ctx) → { match, color?, bar?, icon? } for one cell.
   * value: the cell's value (number, text, boolean, null for empty, or wb.get's { v, t }).
   * ctx: { values: the values of every cell the format covers (duplicate, top/bottom, average,
   *   scales, bars, icons), evaluate(text): a formula worked out for this cell (wb.cfContext
   *   makes one), today: a date serial (defaults to today), locale }.
   */
  function cfMatch(rule, value, ctx) {
    const v = toCellValue(value);
    const r = rule || {};
    switch (r.type || 'cell') {
      case 'cell': return { match: cellRuleMatches(r, v, ctx) };
      case 'formula': {
        if (!ctx || !ctx.evaluate) { return { match: false }; }
        const x = toCellValue(ctx.evaluate(r.formula || r.value1 || ''));
        return { match: !isErr(x) && (typeof x === 'number' || typeof x === 'boolean') && numOf(x) !== 0 };
      }
      case 'date': return { match: dateRuleMatches(r.op, v, ctx && ctx.today != null ? ctx.today : Math.floor(serialNow())) };
      case 'colorScale': { if (typeof v !== 'number' && typeof v !== 'boolean') { return { match: false }; } const c = scaleColor(r, numOf(v), ctx); return c ? { match: true, color: c } : { match: false }; }
      case 'dataBar': { if (typeof v !== 'number' && typeof v !== 'boolean') { return { match: false }; } const b = dataBar(r, numOf(v), ctx); return b ? { match: true, bar: b } : { match: false }; }
      case 'iconSet': { if (typeof v !== 'number' && typeof v !== 'boolean') { return { match: false }; } const i = iconIndex(r, numOf(v), ctx); return i === null ? { match: false } : { match: true, icon: { set: r.set || '3Arrows', index: i, count: ICON_SETS[r.set] || (r.entries || []).length, showValue: r.showValue !== false } }; }
      default: return { match: false };
    }
  }

  // A validity rule (LibreOffice's Data ▸ Validity dialog):
  //   { allow: 'any'|'whole'|'decimal'|'date'|'time'|'textLength'|'list'|'range'|'custom',
  //     op: 'equal'|'notEqual'|'less'|'greater'|'lessEqual'|'greaterEqual'|'between'|'notBetween',
  //     value1, value2,                      as typed ("10", "2026-04-01", "=B1")
  //     list: ['A', 'B', 3],                 allow 'list'
  //     source: 'Sheet1.A1:A10',             allow 'range' (ctx.list gives its values)
  //     formula: '=…',                       allow 'custom' (TRUE to accept)
  //     allowEmpty: true, showList: true, sort: 'none'|'ascending',
  //     input: { show, title, message }, error: { show, action: 'stop'|'warning'|'information', title, message } }
  /**
   * validate(rule, input, ctx) → { valid, v, t, fmt?, error? } for text as typed into a cell
   * (or a value). error is the rule's alert when the input is refused (action 'stop' must
   * not be stored; 'warning' asks; 'information' tells). ctx: { evaluate(text) for formulas
   * and custom rules, list: the values of a 'range' source, locale } — wb.validateCell builds it.
   */
  function validate(rule, input, ctx) {
    const r = rule || {};
    const L = locOf(ctx && ctx.locale);
    let v; let t; let fmt;
    if (typeof input === 'string' || input == null) {
      const p = parseInput(input == null ? '' : input, L.id);
      if (p.t === 'f') { const x = ctx && ctx.evaluate ? toCellValue(ctx.evaluate(p.v)) : null; v = x; t = typeOf(x); } else { v = p.v; t = p.t; fmt = p.fmt; }
    } else { v = toCellValue(input); t = typeOf(v); }
    const out = (ok) => { const o = { valid: ok, v, t }; if (fmt) { o.fmt = fmt; } if (!ok) { o.error = Object.assign({ show: true, action: 'stop', title: '', message: '' }, r.error || {}); } return o; };
    const allow = r.allow || 'any';
    if (allow === 'any') { return out(true); }
    if (v == null || v === '') { return out(r.allowEmpty !== false); }
    if (isErr(v)) { return out(false); }
    const op = r.op || 'between';
    const o1 = cfOperand(r.value1, ctx); const o2 = cfOperand(r.value2, ctx);
    switch (allow) {
      case 'whole': case 'decimal': case 'date': case 'time': {
        if (typeof v !== 'number' && typeof v !== 'boolean') { return out(false); }
        const x = numOf(v);
        if (allow === 'whole' && !lApproxEq(x, Math.floor(x + 0.5))) { return out(false); }
        if (o1.error || o2.error) { return out(false); }
        return out(cmpNum(op, x, o1.num, o2.num));
      }
      case 'textLength': {
        const len = typeof v === 'string' ? v.length : typeof v === 'boolean' ? (v ? 4 : 5) : (fmt ? format(v, 'n', fmt, L.id) : general(v)).length;
        return out(cmpNum(op, len, o1.num, o2.num));
      }
      case 'list': case 'range': {
        const entries = allow === 'list' ? (r.list || []) : (ctx && ctx.list) || [];
        for (const e0 of entries) {
          const e = toCellValue(e0);
          if (e == null || isErr(e)) { continue; }
          let en = e;
          if (typeof e === 'string' && allow === 'list') { const p = parseInput(e, L.id); if (p.t === 'n' || p.t === 'b') { en = p.v; } }
          if ((typeof en === 'number' || typeof en === 'boolean') && (typeof v === 'number' || typeof v === 'boolean')) { if (lApproxEq(numOf(en), numOf(v)) || numOf(en) === numOf(v)) { return out(true); } continue; }
          if (typeof en === 'string' && typeof v === 'string' && en.toLowerCase() === v.toLowerCase()) { return out(true); }
        }
        return out(false);
      }
      case 'custom': {
        if (!ctx || !ctx.evaluate) { return out(true); }
        const x = toCellValue(ctx.evaluate(r.formula || r.value1 || '', v));
        return out(!isErr(x) && (typeof x === 'number' || typeof x === 'boolean') && numOf(x) !== 0);
      }
      default: return out(true);
    }
  }

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
      this.hidden = null;         // rows hidden by hand (Set), for SUBTOTAL 101–111 and AGGREGATE
      this.filtered = null;       // rows hidden by a filter (Set), for SUBTOTAL and AGGREGATE
      this.names = new Map();     // the sheet's own defined names: lower case → { name, def }
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
      this.version = 0;            // goes up whenever values may have changed (caches of conditional formats)
      this.cfCache = new Map();
      this.exprCache = new Map();
      this.names = new Map();      // the book's defined names: lower case → { name, def }
      this.calc = null;            // a document's own calculation settings (regex, caseSensitive) when not Calc's new-document ones
    }
    // -- calculation settings
    /**
     * The settings of Tools ▸ Options ▸ Calc ▸ Calculate a document carries, measured in Calc 24.2:
     * { regex: true } — criteria, lookups and SEARCH read regular expressions instead of wildcards
     * (an ODS file that does not say otherwise is so); { caseSensitive: false } — "a"="A" is TRUE
     * (an XLSX file is so). Criteria and lookups ignore case either way. null is a new document's.
     */
    setCalc(c) {
      const regex = !!(c && c.regex); const caseless = !!(c && c.caseSensitive === false);
      const dec = c && Number.isInteger(c.decimals) && c.decimals >= 0 && c.decimals <= 20 ? c.decimals : null;
      this.calc = regex || caseless || dec != null ? Object.assign({}, regex ? { regex: true } : {}, caseless ? { caseSensitive: false } : {}, dec != null ? { decimals: dec } : {}) : null;
      const base = locOf(this.locale);
      this.L = this.calc ? Object.assign(Object.create(base), { regex, caseless, coll: base.id + (caseless ? '/ci' : '') }) : base;
    }
    // -- defined names
    /** The name a formula on sheet sh means: the sheet's own, else the book's; null when there is none. */
    nameEntry(sh, name) {
      const k = String(name).toLowerCase();
      return (sh && sh.names.get(k)) || this.names.get(k) || null;
    }
    /** What a name stands for, read as a formula; one that moves with the cell is read for (r, c). */
    nameAst(e, r, c) {
      if (e.ast === undefined) {
        e.err = null; e.rel = false;
        try {
          e.ast = parse(String(e.def).replace(/^=/, ''));
          e.rel = e.ast.info.refs.some((t) => [t.a, t.b].some((p) => p && ((p.r >= 0 && !p.rAbs) || (p.c >= 0 && !p.cAbs))));
        } catch (x) { if (isErr(x)) { e.ast = null; e.err = x.code; } else { throw x; } }
        e.at = null;
      }
      if (!e.ast || !e.rel) { return e.ast; }
      // relative parts are written for A1 (as an XLSX file keeps them): they move with the cell
      if (!e.at) { e.at = new Map(); }
      const key = r * MAXC + c;
      let a = e.at.get(key);
      if (a === undefined) {
        try { a = parse(shiftFormula('=' + String(e.def).replace(/^=/, ''), r, c).slice(1)); } catch (x) { if (isErr(x)) { a = null; } else { throw x; } }
        if (e.at.size > 5000) { e.at.clear(); }
        e.at.set(key, a);
      }
      return a;
    }
    /** The references a name reaches (through the names it uses too), for the dependency graph. */
    nameRefs(sh, name, r, c, depth, out) {
      const e = this.nameEntry(sh, name);
      if (!e || depth > 16) { return out; }
      const ast = this.nameAst(e, r, c);
      if (!ast) { return out; }
      for (const t of ast.info.refs) { out.push(t); }
      for (const nm of ast.info.names) { this.nameRefs(sh, nm, r, c, depth + 1, out); }
      return out;
    }
    /** Define (or change) a name: the book's, or with sheet the sheet's own. def is a reference or a formula ('$Sheet1.$A$1:$B$5'). */
    defineName(name, def, sheet) {
      if (!validName(name)) { throw new Error('CalcBaseCalc: not a name ' + name); }
      const map = sheet == null ? this.names : this.sheet(sheet).names;
      map.set(String(name).toLowerCase(), { name: String(name), def: String(def == null ? '' : def).replace(/^=/, '') });
      return this.rebuild();
    }
    removeName(name, sheet) {
      const map = sheet == null ? this.names : this.sheet(sheet).names;
      if (!map.delete(String(name).toLowerCase())) { return []; }
      return this.rebuild();
    }
    /** All the book's names (or a sheet's own) at once, as { name: def }; the others go. */
    setNames(obj, sheet) {
      const map = sheet == null ? this.names : this.sheet(sheet).names;
      map.clear();
      for (const k of Object.keys(obj || {})) { if (validName(k) && obj[k] != null) { map.set(k.toLowerCase(), { name: k, def: String(obj[k]).replace(/^=/, '') }); } }
      return this.rebuild();
    }
    /** { name: def } of the book's names, or with sheet of that sheet's own. */
    getNames(sheet) {
      const map = sheet == null ? this.names : this.sheet(sheet).names;
      const out = {};
      for (const e of map.values()) { out[e.name] = e.def; }
      return out;
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
      if (cell.f) { out.f = cell.f; out.fmtHint = cell.hint || ''; if (cell.hintCode) { out.fmtHintCode = cell.hintCode; } }
      if (cell.arr) { out.a = rangeText(cell.arr); } else if (cell.of) { out.a = rangeText(cell.of.arr); }
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
      const cur = sh.cell(r, c);
      if (cur && (cur.arr || cur.of)) { throw partOfArray(); }
      const changed = [];
      this.put(sh, r, c, spec || {}, changed, true);
      return changed.concat(this.flush());
    }
    /**
     * Which rows are hidden ({ hidden: [rows] }) and which a filter hides
     * ({ filtered: [rows] }), 0-based: SUBTOTAL leaves out filtered rows (and
     * hidden ones with 101–111), AGGREGATE as its option says. The sheet's
     * SUBTOTAL and AGGREGATE formulas are worked out again; answers changed.
     */
    setRowState(s, state) {
      const sh = this.sheet(s);
      if (state && 'hidden' in state) { sh.hidden = state.hidden && state.hidden.length ? new Set(state.hidden) : null; }
      if (state && 'filtered' in state) { sh.filtered = state.filtered && state.filtered.length ? new Set(state.filtered) : null; }
      for (const other of this.sheets) { for (const cell of other.cells.values()) { if (cell.ast && cell.ast.info.sub) { this.markDirty(cell); } } }
      return this.flush();
    }
    // -- formulas that are not stored: conditional formats, validity
    /**
     * Work out a formula ('=…') or a value as typed for cell (r, c) without storing
     * anything: { v, t }. With over = { value }, the cell itself reads as that value
     * (a validity rule judging what is being typed).
     */
    evaluate(s, r, c, text, over) {
      const sh = this.sheet(s);
      const src = String(text == null ? '' : text);
      if (src.charAt(0) !== '=' || src.length < 2) { const p = parseInput(src, this.locale); return { v: p.t === 'f' ? null : p.v, t: p.t === 'f' ? '' : p.t }; }
      let ast = this.exprCache.get(src);
      if (!ast) {
        try { ast = parse(src.slice(1)); } catch (e) { if (isErr(e)) { return { v: e.code, t: 'e' }; } throw e; }
        if (this.exprCache.size > 500) { this.exprCache.clear(); }
        this.exprCache.set(src, ast);
      }
      const ctx = this.context(sh, { r, c, arr: null }, [], null, 0);
      if (over) { const base = ctx.cellValue; const ov = toCellValue(over.value); ctx.cellValue = (target, rr, cc) => (target === sh && rr === r && cc === c ? ov : base(target, rr, cc)); }
      try {
        let v = ev(ast, ctx);
        if (v instanceof RangeVal || v instanceof ArrayVal) { v = deref(v, ctx); }
        if (v == null) { v = 0; }
        if (typeof v === 'number' && !isFinite(v)) { v = new CalcError(ERR.NUM); }
        if (v === EMPTY_PATH) { v = false; }
        return isErr(v) ? { v: v.code, t: 'e' } : { v, t: typeOf(v) };
      } catch (e) { if (isErr(e)) { return { v: e.code, t: 'e' }; } throw e; }
    }
    /** The values a reference written as text holds ('A1:A10', 'Sheet2.B1:B5', '$Lists.$A$1:$A$9'), read from cell (r, c). */
    referenceValues(s, r, c, text) {
      const sh = this.sheet(s);
      let ast;
      try { ast = parse(String(text).replace(/^=/, '')); } catch (e) { return []; }
      const ctx = this.context(sh, { r, c, arr: null }, [], null, 0);
      try { const v = evArray(ast, ctx); const a = v instanceof ArrayVal ? v : new ArrayVal([[v]]); const out = []; a.rows.forEach((row) => row.forEach((x) => out.push(x))); return out; } catch (e) { if (isErr(e)) { return []; } throw e; }
    }
    /**
     * What cfMatch needs for cell (r, c) of a conditional format over `range`
     * ('B2:D20'): the values of the range (kept until the book changes) and
     * evaluate(), which works out a formula for this cell — its references are
     * written for the range's top-left cell and move with the cell, as in Calc.
     */
    cfContext(s, range, r, c) {
      const sh = this.sheet(s);
      const g = rangeOf(range);
      if (!g) { throw new Error('CalcBaseCalc: bad range ' + range); }
      const key = sh.id + '|' + rangeText(g);
      let cached = this.cfCache.get(key);
      if (!cached || cached.version !== this.version) {
        const values = [];
        const r1 = Math.min(g.r1, sh.maxR); const c1 = Math.min(g.c1, sh.maxC);
        for (let rr = g.r0; rr <= r1; rr++) { for (let cc = g.c0; cc <= c1; cc++) { const cell = sh.cells.get(rr * MAXC + cc); if (cell) { values.push(cell.t === 'e' ? new CalcError(cell.v) : cell.v); } } }
        cached = { version: this.version, values, stats: null };
        if (this.cfCache.size > 200) { this.cfCache.clear(); }
        this.cfCache.set(key, cached);
      }
      const wb = this;
      return {
        values: cached.values, locale: this.locale,
        get stats() { return cached.stats; }, set stats(v) { cached.stats = v; },
        evaluate: (text) => wb.evaluate(sh, r, c, shiftFormula(String(text), r - g.r0, c - g.c0)),
      };
    }
    /** cfMatch for cell (r, c) of a format over `range`, with the context made here. */
    cfMatchCell(s, range, rule, r, c) { return cfMatch(rule, this.get(s, r, c), this.cfContext(s, range, r, c)); }
    /** validate() for text typed into cell (r, c): formulas and custom rules see the typed value in the cell; a 'range' rule reads its source. */
    validateCell(s, r, c, rule, input) {
      const sh = this.sheet(s);
      const wb = this;
      const ctx = { locale: this.locale, evaluate(text, value) { return arguments.length > 1 ? wb.evaluate(sh, r, c, text, { value }) : wb.evaluate(sh, r, c, text); } };
      if (rule && rule.allow === 'range' && rule.source) { ctx.list = this.referenceValues(sh, r, c, rule.source); }
      return validate(rule, input, ctx);
    }
    /** The choices of a list or range rule for the cell's drop-down: text as it shows, without repeats, sorted when the rule asks. */
    validationList(s, r, c, rule) {
      const sh = this.sheet(s);
      const raw = rule && rule.allow === 'range' ? this.referenceValues(sh, r, c, rule.source || '') : (rule && rule.list) || [];
      const seen = new Set(); const out = [];
      for (const x of raw) { if (x == null || isErr(x) || x === '') { continue; } const text = typeof x === 'number' ? general(x) : typeof x === 'boolean' ? (x ? 'TRUE' : 'FALSE') : String(x); if (!seen.has(text)) { seen.add(text); out.push(text); } }
      if (rule && rule.sort === 'ascending') { out.sort((a, b) => compare(parseInput(a, this.locale).t === 'n' ? parseInput(a, this.locale).v : a, parseInput(b, this.locale).t === 'n' ? parseInput(b, this.locale).v : b, this.L)); }
      return out;
    }
    // -- array formulas (Ctrl+Shift+Enter): one formula over a range, its result spread over the cells
    /** The array formula covering a cell: { range: 'B2:C4', f, r0, c0, r1, c1 }, or null. */
    arrayAt(s, r, c) {
      const sh = this.sheet(s);
      const cell = sh.cell(r, c);
      const a = cell ? (cell.arr ? cell : cell.of) : null;
      if (!a) { return null; }
      return { range: rangeText(a.arr), f: a.f, r0: a.arr.r0, c0: a.arr.c0, r1: a.arr.r1, c1: a.arr.c1 };
    }
    /** The anchors of the array formulas of a sheet that touch a block. */
    arraysTouching(sh, g) {
      const out = new Set();
      for (const cell of sh.cells.values()) {
        const a = cell.arr ? cell : cell.of;
        if (a && a.arr.r0 <= g.r1 && a.arr.r1 >= g.r0 && a.arr.c0 <= g.c1 && a.arr.c1 >= g.c0) { out.add(a); }
      }
      return Array.from(out);
    }
    /**
     * Enter an array formula over a range ('B2:D4' or {r0, c0, r1, c1}), as
     * Ctrl+Shift+Enter does: the formula is worked out as an array and its
     * elements fill the range. An array formula that lies inside the range is
     * replaced; one that is only partly inside refuses (part of an array). An
     * empty text removes the arrays inside the range.
     */
    setArrayFormula(s, range, text) {
      const sh = this.sheet(s);
      const g = typeof range === 'string' ? rangeOf(range) : range;
      if (!g || g.r0 < 0 || g.c0 < 0 || g.r1 >= MAXR || g.c1 >= MAXC) { throw new Error('CalcBaseCalc: bad range ' + range); }
      const touching = this.arraysTouching(sh, g);
      for (const a of touching) { if (a.arr.r0 < g.r0 || a.arr.r1 > g.r1 || a.arr.c0 < g.c0 || a.arr.c1 > g.c1) { throw partOfArray(); } }
      const changed = [];
      for (const a of touching) { this.unlinkArray(a); }
      for (let r = g.r0; r <= g.r1; r++) { for (let c = g.c0; c <= g.c1; c++) { if (sh.cell(r, c)) { this.put(sh, r, c, { v: null }, changed, false); } } }
      const f = text == null ? '' : String(text).replace(/^\{(=.*)\}$/s, '$1');
      if (f.charAt(0) !== '=' || f.length < 2) {
        for (let r = g.r0; r <= g.r1; r++) { for (let c = g.c0; c <= g.c1; c++) { this.propagate(sh, r, c); } }
        return dedupe(changed.concat(this.flush()));
      }
      this.put(sh, g.r0, g.c0, { f }, changed, false);
      const anchor = sh.cell(g.r0, g.c0);
      anchor.arr = { r0: g.r0, c0: g.c0, r1: g.r1, c1: g.c1 };
      this.linkMembers(sh, anchor);
      this.dirty.delete(anchor); anchor.dirty = false;
      this.markDirty(anchor);
      return dedupe(changed.concat(this.flush()));
    }
    /** Remove the array formula covering a cell (all of its cells are cleared). */
    removeArray(s, r, c) {
      const info = this.arrayAt(s, r, c);
      if (!info) { return []; }
      return this.setArrayFormula(s, info, '');
    }
    linkMembers(sh, anchor) {
      const g = anchor.arr;
      for (let r = g.r0; r <= g.r1; r++) {
        for (let c = g.c0; c <= g.c1; c++) {
          if (r === g.r0 && c === g.c0) { continue; }
          let m = sh.cell(r, c);
          if (!m) { m = newCell(sh, r, c); sh.cells.set(sh.key(r, c), m); sh.touch(r, c); }
          m.of = anchor;
        }
      }
    }
    /** Forget that cells form an array (their values stay until they are overwritten). */
    unlinkArray(anchor) {
      const g = anchor.arr; const sh = this.sheetOfCell(anchor);
      if (!g || !sh) { return; }
      for (let r = g.r0; r <= g.r1; r++) { for (let c = g.c0; c <= g.c1; c++) { const m = sh.cell(r, c); if (m && m.of === anchor) { m.of = null; } } }
      anchor.arr = null;
    }
    /** Refuse a row/column change that would cut through an array formula, as Calc does. */
    checkArraysAxis(sh, axis, at, n) {
      for (const cell of sh.cells.values()) {
        if (!cell.arr) { continue; }
        const lo = axis === 'r' ? cell.arr.r0 : cell.arr.c0; const hi = axis === 'r' ? cell.arr.r1 : cell.arr.c1;
        if (n > 0) { if (lo < at && at <= hi) { throw partOfArray(); } } else {
          const end = at - n - 1;
          const meets = lo <= end && hi >= at; const inside = lo >= at && hi <= end;
          if (meets && !inside) { throw partOfArray(); }
        }
      }
    }
    /** After cells moved: each array keeps its size from where its anchor now is. */
    refitArrays(sh) {
      for (const cell of sh.cells.values()) {
        if (cell.of && (!cell.of.arr || sh.cells.get(sh.key(cell.of.r, cell.of.c)) !== cell.of)) { cell.of = null; }
      }
      for (const cell of sh.cells.values()) {
        if (!cell.arr) { continue; }
        const h = cell.arr.r1 - cell.arr.r0; const w = cell.arr.c1 - cell.arr.c0;
        cell.arr = { r0: cell.r, c0: cell.c, r1: cell.r + h, c1: cell.c + w };
        this.linkMembers(sh, cell);
      }
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
      if (!cell) { cell = newCell(sh, r, c); sh.cells.set(key, cell); sh.touch(r, c); }
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
        const refs = cell.ast.info.names.length ? cell.ast.info.refs.concat(this.namesReached(cell, sh)) : cell.ast.info.refs;
        for (const t of refs) {
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
    /** The references of the names a formula uses, read for its cell. */
    namesReached(cell, sh) {
      const out = [];
      for (const nm of cell.ast.info.names) { this.nameRefs(sh, nm, cell.r, cell.c, 0, out); }
      return out;
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
        this.dependents(sh, x.r, x.c, stack);
        if (x.arr) { const g = x.arr; for (let r = g.r0; r <= g.r1; r++) { for (let c = g.c0; c <= g.c1; c++) { if (r !== x.r || c !== x.c) { this.dependents(sh, r, c, stack); } } } }
      }
    }
    /** Push the formulas that read cell (r, c) and are not dirty yet. */
    dependents(sh, r, c, stack) {
      const set = this.rev.get(this.cellId(sh, r, c));
      if (set) { for (const dep of set) { if (!dep.dirty) { stack.push(dep); } } }
      const col = sh.rdepCols.get(c);
      if (col) { for (const d of col) { if (r >= d.r0 && r <= d.r1 && !d.cell.dirty) { stack.push(d.cell); } } }
      for (const d of sh.rdepWide) { if (r >= d.r0 && r <= d.r1 && c >= d.c0 && c <= d.c1 && !d.cell.dirty) { stack.push(d.cell); } }
    }
    sheetOfCell(cell) { if (cell.sheet) { return cell.sheet; } for (const sh of this.sheets) { if (sh.cells.get(sh.key(cell.r, cell.c)) === cell) { cell.sheet = sh; return sh; } } return null; }
    // -- recalculation
    /** Work out every dirty formula (volatile ones too); answers which cells changed value. */
    flush() {
      this.version++;
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
      const forget = (e) => { e.ast = undefined; e.at = null; };
      this.names.forEach(forget); for (const sh of this.sheets) { sh.names.forEach(forget); }
      for (const sh of this.sheets) { sh.rdepCols = new Map(); sh.rdepWide = new Set(); }
      for (const sh of this.sheets) { for (const cell of sh.cells.values()) { cell.sheet = sh; if (cell.f) { cell.pre = null; cell.busy = false; if (!cell.ast && !cell.err) { try { cell.ast = parse(cell.f.slice(1)); } catch (e) { if (isErr(e)) { cell.err = e.code; } else { throw e; } } } this.register(cell, sh); } } }
      return this.recalc();
    }
    /**
     * Evaluate a formula cell, working out first, as it reads them, the dirty
     * cells it needs — depth first, as Calc's interpreter does, so a range's
     * first error stops the reading before later cells are touched (=SUM(1:1)
     * in a row with #REF! before it is #REF!). A cell read while it is itself
     * being worked out gives Err:522 as a value: what swallows errors
     * (IFERROR, COUNT, ISERROR) swallows that too, as in Calc. Past NEST
     * levels of that recursion the reads are queued and the formula is
     * worked out again once they are done.
     */
    ensure(root, changed, level = 0) {
      const stack = [root];
      while (stack.length) {
        const cell = stack[stack.length - 1];
        if (!cell.dirty) { cell.busy = false; stack.pop(); continue; }
        cell.busy = true;
        const sh = this.sheetOfCell(cell);
        const pending = [];
        const ctx = this.context(sh, cell, pending, changed, level);
        let v; let hint = ''; let hintCode = ''; let mat = null;
        if (cell.err) { v = new CalcError(cell.err); } else {
          try {
            v = ev(cell.ast, ctx);
            if (!pending.length && cell.arr) {
              mat = v instanceof ArrayVal ? v : v instanceof RangeVal ? toArray(v, ctx) : new ArrayVal([[v === EMPTY_PATH ? null : v]]);
              v = arrayShown(mat, mat.h && mat.w ? mat.rows[0][0] : null, 0, 0);
              if (typeof v === 'number' && !isFinite(v)) { v = new CalcError(ERR.NUM); }
            } else if (!pending.length) {
              // an empty cell is 0, but the lookups (and an array's element) show it empty, as Calc does
              const showEmpty = (v instanceof RangeVal && v.showEmpty) || (v instanceof ArrayVal && cell.ast.k === 'fn');
              v = deref(v, ctx);
              if (v == null) { v = showEmpty ? '' : 0; }
              if (typeof v === 'number' && !isFinite(v)) { v = new CalcError(ERR.NUM); }
              hint = this.inferHint(cell.ast, ctx);
              hintCode = this.lastHintCode;
            }
          } catch (e) { if (isErr(e)) { v = e; } else { throw e; } }
        }
        if (pending.length) {
          const fresh = pending.filter((p) => p.dirty && !p.busy);
          if (fresh.length) { for (const p of fresh) { stack.push(p); } continue; }
          v = new CalcError(ERR.CIRC);
        }
        const oldV = cell.v; const oldT = cell.t;
        if (isErr(v)) { cell.v = v.code; cell.t = 'e'; } else { cell.v = v; cell.t = typeOf(v); }
        cell.hint = hint; cell.hintCode = hintCode;
        cell.dirty = false; cell.busy = false;
        this.dirty.delete(cell);
        stack.pop();
        if (cell.v !== oldV || cell.t !== oldT) { changed.push({ sheet: sh.name, r: cell.r, c: cell.c }); }
        if (cell.arr) { this.spread(sh, cell, mat, isErr(v) && !mat ? v : null, changed); }
      }
    }
    /**
     * The elements of an array formula's result over its range, as Calc fills
     * it: a single value or a single row/column is repeated, the rest of a
     * range larger than the result is #N/A.
     */
    spread(sh, anchor, mat, err, changed) {
      const g = anchor.arr;
      for (let r = g.r0; r <= g.r1; r++) {
        for (let c = g.c0; c <= g.c1; c++) {
          if (r === g.r0 && c === g.c0) { continue; }
          const m = sh.cell(r, c);
          if (!m || m.of !== anchor) { continue; }
          let x = err || (mat ? elemAt(mat, r - g.r0, c - g.c0) : new CalcError(ERR.NA));
          x = arrayShown(mat, x, r - g.r0, c - g.c0);
          if (typeof x === 'number' && !isFinite(x)) { x = new CalcError(ERR.NUM); }
          const oldV = m.v; const oldT = m.t;
          if (isErr(x)) { m.v = x.code; m.t = 'e'; } else { m.v = x; m.t = typeOf(x); }
          if (m.v !== oldV || m.t !== oldT) { changed.push({ sheet: sh.name, r, c }); }
        }
      }
    }
    /** What a formula reads cells through; changed (with level) lets it work out a dirty cell on the spot. */
    context(sh, cell, pending, changed, level) {
      const wb = this;
      return {
        wb, sheet: sh, at: { r: cell.r, c: cell.c }, L: this.L, arr: !!cell.arr, over: null, cell,
        cellValue(target, r, c) {
          const x = target.cells.get(r * MAXC + c);
          if (!x) { return null; }
          const owner = x.of && x.of.dirty ? x.of : x.f && x.dirty ? x : null;
          if (owner) {
            if (owner.busy || owner === cell) { return new CalcError(ERR.CIRC); }
            if (!changed || level >= NEST) { pending.push(owner); return null; }
            wb.ensure(owner, changed, level + 1);
          }
          if (x.t === 'e') { return new CalcError(x.v); }
          return x.v;
        },
        cellType(node) { return ''; },
      };
    }
    /** What a formula probably shows: a date, a time, a percentage, money — from the functions and cells it uses. */
    inferHint(ast, ctx) {
      // What Calc (ja-JP) gives a formula's cell when its format is General, measured in 24.2 by
      // typing each formula (tests/calc/run.mjs "format hint"): a reference keeps its cell's own
      // format (code), DATE/TODAY a date, NOW a date and time, TIME a time, DATEVALUE and
      // TIMEVALUE nothing, a date ± a number a date, two dates subtracted nothing, a date + a time
      // a date and time, two times a duration, a currency times a number its currency, minus a
      // reference nothing. { k: kind, code } with code the format of a referenced cell when it is kept.
      const isDt = (k) => k === 'date' || k === 'datetime' || k === 'time' || k === 'duration';
      const kindOfCell = (tok) => {
        const sh = tok.sheet ? this.sheetByName(tok.sheet.name) : ctx.sheet;
        if (!sh || tok.kind !== 'cell') { return {}; }
        const cell = sh.cells.get(tok.a.r * MAXC + tok.a.c);
        if (!cell) { return {}; }
        if (cell.fmt) { const k = fmtKind(cell.fmt); return k ? { k, code: cell.fmt } : {}; }
        return cell.hint ? { k: cell.hint, code: cell.hintCode || '' } : {};
      };
      const walk = (n) => {
        switch (n.k) {
          case 'ref': return kindOfCell(n.tok);
          case 'pct': return { k: 'percent' };
          case 'neg': return n.a.k === 'ref' ? {} : walk(n.a);
          case 'fn': {
            if (n.name === 'DATE' || n.name === 'TODAY') { return { k: 'date' }; }
            if (n.name === 'NOW') { return { k: 'datetime' }; }
            if (n.name === 'TIME') { return { k: 'time' }; }
            if (['PMT', 'FV', 'PV', 'NPV', 'IPMT', 'PPMT'].indexOf(n.name) >= 0) { return { k: 'currency' }; }
            if (n.name === 'IRR' || n.name === 'RATE') { return { k: 'percent' }; }
            if (n.name === 'IF' && n.args[1]) { return walk(n.args[1]); }
            if ((n.name === 'SUM' || n.name === 'MIN' || n.name === 'MAX' || n.name === 'IFERROR') && n.args[0]) { return walk(n.args[0]); }
            return {};
          }
          case 'bin': {
            if (n.op === '+' || n.op === '-') {
              const a = walk(n.a); const b = walk(n.b);
              if (isDt(a.k) && isDt(b.k)) {
                if (a.k === 'time' && b.k === 'time') { return { k: 'duration' }; }
                if (a.k === 'date' && b.k === 'date') { return n.op === '-' ? {} : { k: 'date' }; }
                return { k: 'datetime' };
              }
              const x = a.k ? a : b;
              // a currency keeps its own; a date, time or percentage becomes the standard one of its kind
              return x.k === 'currency' ? x : x.k ? { k: x.k } : {};
            }
            if (n.op === '*' || n.op === '/') { const a = walk(n.a); const b = walk(n.b); return a.k === 'currency' ? a : b.k === 'currency' ? b : {}; }
            return {};
          }
          default: return {};
        }
      };
      const h = walk(ast);
      this.lastHintCode = h.code || '';
      return h.k || '';
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
      // the names follow as the formulas do: a sheet's own on that sheet, the book's with no sheet of their own
      const names = (map, sh) => { for (const e of map.values()) { const nf = rewrite('=' + e.def, (t) => fn(t, sh)).slice(1); if (nf !== e.def) { e.def = nf; e.ast = undefined; e.at = null; } } };
      names(this.names, null);
      for (const sh of this.sheets) { if (sh !== skipSheet) { names(sh.names, sh); } }
    }
    /** Insert (n > 0) or delete (n < 0) rows (axis 'r') or columns (axis 'c') of a sheet at `at`. */
    shiftAxis(s, axis, at, n) {
      const sh = this.sheet(s);
      this.checkArraysAxis(sh, axis, at, n);
      const other = axis === 'r' ? 'c' : 'r';
      this.rewriteAll((t, formulaSheet) => {
        const target = t.sheet ? this.sheetByName(t.sheet.name) : formulaSheet;
        if (!target || target !== sh) { return null; }
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
      this.refitArrays(sh);
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
      const dstG = { r0: src.r0 + dr, c0: src.c0 + dc, r1: src.r1 + dr, c1: src.c1 + dc };
      const within = (a, g) => a.arr.r0 >= g.r0 && a.arr.r1 <= g.r1 && a.arr.c0 >= g.c0 && a.arr.c1 <= g.c1;
      const inSrcArrays = this.arraysTouching(sh, src);
      for (const a of inSrcArrays) { if (!within(a, src)) { throw partOfArray(); } }
      for (const a of this.arraysTouching(sh, dstG)) { if (inSrcArrays.indexOf(a) < 0 && !within(a, dstG)) { throw partOfArray(); } if (inSrcArrays.indexOf(a) < 0) { this.unlinkArray(a); } }
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
      this.refitArrays(sh);
      return this.rebuild();
    }
    // -- the model (§3)
    load(model) {
      this.sheets = []; this.byName = new Map(); this.rev = new Map(); this.volatile = new Set(); this.dirty = new Set();
      const m = model || {};
      this.extraModel = {};
      for (const k of Object.keys(m)) { if (k !== 'sheets' && k !== 'active' && k !== 'names' && k !== 'calc') { this.extraModel[k] = m[k]; } }
      this.setCalc(m.calc);
      this.names = new Map();
      const takeNames = (obj, map) => { for (const k of Object.keys(obj && typeof obj === 'object' ? obj : {})) { if (validName(k) && typeof obj[k] === 'string') { map.set(k.toLowerCase(), { name: k, def: obj[k].replace(/^=/, '') }); } } };
      takeNames(m.names, this.names);
      const arrays = [];
      (m.sheets && m.sheets.length ? m.sheets : [{ name: 'Sheet1', cells: {} }]).forEach((ms, i) => {
        const nm = ms.name || 'Sheet' + (i + 1);
        const sh = new Sheet(this, nm, this.nextId++);
        this.sheets.push(sh); this.byName.set(nm.toLowerCase(), sh);
        for (const k of Object.keys(ms)) { if (k !== 'name' && k !== 'cells' && k !== 'names') { sh.extra[k] = ms[k]; } }
        takeNames(ms.names, sh.names);
        const cells = ms.cells || {};
        for (const addr of Object.keys(cells)) {
          const ref = parseRef(addr);
          if (!ref) { continue; }
          const c = cells[addr] || {};
          this.put(sh, ref.r, ref.c, { f: c.f, v: c.v, t: c.t, fmt: c.fmt, s: c.s }, [], false);
          if (c.f && c.a) { const g = rangeOf(c.a); if (g && g.r0 === ref.r && g.c0 === ref.c) { arrays.push({ sh, g }); } }
        }
      });
      for (const { sh, g } of arrays) { const anchor = sh.cell(g.r0, g.c0); if (anchor && anchor.f) { anchor.arr = g; this.linkMembers(sh, anchor); } }
      this.active = m.active || 0;
      for (const sh of this.sheets) { for (const cell of sh.cells.values()) { if (cell.f) { cell.sheet = sh; if (cell.v === undefined) { cell.dirty = true; this.dirty.add(cell); } } } }
      return this.flush();
    }
    toModel() {
      const out = { ...this.extraModel, sheets: [], active: this.active };
      if (this.names.size) { out.names = this.getNames(); }
      if (this.calc) { out.calc = Object.assign({}, this.calc); }
      for (const sh of this.sheets) {
        const ms = { name: sh.name, cells: {} };
        if (sh.names.size) { ms.names = this.getNames(sh); }
        const keys = Array.from(sh.cells.values()).sort((a, b) => a.r - b.r || a.c - b.c);
        for (const cell of keys) {
          const o = {};
          if (cell.f) { o.f = cell.f; }
          if (cell.arr) { o.a = rangeText(cell.arr); }
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
  /** A cell of an array formula holds numbers where the array held booleans, and 0 for IF's empty path (as Calc shows them). */
  function arrayShown(mat, x, i, j) {
    if (x == null) { return mat && mat.ep && mat.ep.has((mat.h === 1 ? 0 : i) * 65536 + (mat.w === 1 ? 0 : j)) ? 0 : ''; }
    if (typeof x === 'boolean') { return x ? 1 : 0; }
    return x;
  }
  const newCell = (sh, r, c) => ({ r, c, sheet: sh, f: null, ast: null, v: null, t: '', fmt: undefined, s: undefined, hint: '', vol: false, dirty: false, pre: null, busy: false, arr: null, of: null });
  const rangeText = (g) => refName(g.r0, g.c0) + ':' + refName(g.r1, g.c1);
  /** Calc's refusal to change a part of an array formula ("You cannot change only part of an array."). */
  function partOfArray() { const e = new Error('CalcBaseCalc: you cannot change only part of an array'); e.code = 'partOfArray'; return e; }
  function dedupe(list) { const seen = new Set(); return list.filter((x) => { const k = x.sheet + '\u0001' + x.r + '\u0001' + x.c; if (seen.has(k)) { return false; } seen.add(k); return true; }); }
  /** 'B2:D4' or 'B2' → { r0, c0, r1, c1 }. */
  function rangeOf(text) {
    if (text && typeof text === 'object') { return text.r0 != null ? { r0: Math.min(text.r0, text.r1), c0: Math.min(text.c0, text.c1), r1: Math.max(text.r0, text.r1), c1: Math.max(text.c0, text.c1) } : null; }
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

  // ---- the fill handle, as Calc's ScTable::FillAuto ------------------------
  // Measured in Calc 24.2 ja-JP (tests/calc/lo-input.json): the lists are the
  // locale's (ja: 日 月 … / 日曜日 … / 1月 … / 一月 … / 睦月 …; Mon and January
  // are copied there), a number at the start of a text grows when a space,
  // the end or text ending in a non-digit follows (1-A → 2-A), one at the end
  // grows (Item 1 → Item 2, A-1 → A-2), one in the middle is copied (第1回);
  // seeds that are not a straight series repeat, each one step further per
  // round (1,2,4 → 2,3,5,3,4); month ends step by month ends.

  const FILL_LISTS = {
    ja: [LOC.ja.daysShort, LOC.ja.days, LOC.ja.monthsShort, LOC.ja.months,
      ['睦月', '如月', '弥生', '卯月', '皐月', '水無月', '文月', '葉月', '長月', '神無月', '霜月', '師走']],
    en: [LOC.en.daysShort, LOC.en.days, LOC.en.monthsShort, LOC.en.months],
  };
  function fillList(text, L) {
    const low = String(text).toLowerCase();
    for (const list of FILL_LISTS[L.id] || FILL_LISTS.en) { const i = list.findIndex((x) => x.toLowerCase() === low); if (i >= 0) { return { list, i }; } }
    return null;
  }
  const isAsciiDigit = (ch) => ch >= '0' && ch <= '9';
  /** table4's lcl_DecompValueString: { flag: -1 number first, 1 last, 2 last with its sign; val; rest; digits (leading zeros) } or null. */
  function decompValue(s) {
    if (s === '') { return null; }
    let sign = 0; let n = 0;
    if (s[0] === '-' || s[0] === '+') { n = sign = 1; }
    while (n < s.length && isAsciiDigit(s[n])) { n++; }
    const next = s[n]; const last = s[s.length - 1];
    if (n > sign && (next === undefined || next === ' ' || !isAsciiDigit(last))) {
      return { flag: -1, val: toInt32(s.slice(0, n)) | 0, rest: s.slice(n), digits: s[sign] === '0' ? n - sign : 0 };
    }
    const end = s.length - 1; n = end; sign = 0;
    while (n && isAsciiDigit(s[n])) { n--; }
    if (s[n] === '-' || s[n] === '+') { n--; sign = 1; }
    if (n < end - sign) {
      return { flag: sign ? 2 : 1, val: toInt32(s.slice(n + 1)) | 0, rest: s.slice(0, n + 1), digits: s[n + 1 + sign] === '0' ? end - n - sign : 0 };
    }
    return null;
  }
  /** table4's lcl_ValueString: at least digits digits, the sign outside the zeros. */
  function valueString(v, digits) {
    if (digits <= 1) { return String(v); }
    const a = String(Math.abs(v)).padStart(digits, '0');
    return v < 0 ? '-' + a : a;
  }
  const withValue = (d, v, digits) => (d.flag < 0 ? valueString(v, digits) + d.rest : d.rest + (d.flag === 2 && v >= 0 ? '+' : '') + valueString(v, digits));
  /** table4's approxDiff: a - b without the noise of 0.11 - 0.12. */
  function approxDiff(a, b) {
    if (a === b) { return 0; }
    if (a === 0) { return -b; }
    if (b === 0) { return a; }
    const c = a - b; const aa = Math.abs(a); const ab = Math.abs(b);
    if (aa < 1e-16 || aa > 1e16 || ab < 1e-16 || ab > 1e16) { return c; }
    const q = aa < ab ? b / a : a / b;
    const d = (a * q - b * q) / q;
    if (d === c) { return c; }
    const e = Math.abs(d - c);
    const nExp = Math.floor(xlog10(e)) + 1;
    const nExpArg = Math.floor(xlog10(Math.max(aa, ab))) - 15;
    return rtlRound(c, -Math.max(nExp, nExpArg), 'corr');
  }
  /** rtl::math::approxEqual with 13 bits of slack (FillAnalyse). */
  const approxEq13 = (a, b) => a === b || Math.abs(a - b) < Math.abs(a) * 3.552713678800501e-15 * 8192;
  const isEndOfMonth = (p) => p.d === daysInMonth(p.y, p.m);
  /** The next value of a date series (table4's IncDate). */
  function incDate(v, st, step, cmd) {
    if (cmd === 'day') { return v + step; }
    const p = serialToYmd(v);
    if (!st.dom) { st.dom = p.d; }
    let y = p.y; let m = p.m;
    if (cmd === 'year') { y += step; } else {
      m += step;
      if (step >= 0) { if (m > 12) { const add = Math.floor((m - 1) / 12); m -= add * 12; y += add; } } else if (m < 1) { const add = 1 - Math.trunc(m / 12); m += add * 12; y -= add; }
    }
    if (y < 1583) { return ymdToSerial(1583, 1, 1); }
    if (y > 9956) { return ymdToSerial(9956, 12, 31); }
    const dim = daysInMonth(y, m);
    const d = cmd === 'eom' ? dim : cmd === 'year' ? Math.min(p.d, dim) : Math.min(dim, st.dom);
    return ymdToSerial(y, m, d);
  }
  /** What a seed is: typed text is read as Calc reads typing; numbers and { v, t, fmt } as they are. */
  function fillItem(x, L) {
    if (x !== null && typeof x === 'object') { return { v: x.v, t: x.t || typeOf(x.v), fmt: x.fmt }; }
    if (typeof x === 'number') { return { v: x, t: 'n' }; }
    if (typeof x === 'boolean') { return { v: x, t: 'b' }; }
    if (x == null || x === '') { return { v: null, t: '' }; }
    const p = parseInput(String(x), L.id);
    return p.t === 'f' ? { v: String(x), t: 's' } : { v: p.v, t: p.t, fmt: p.fmt };
  }
  /** The text Calc's GetString gives a seed (for the lists and the numbers in text). */
  const seedText = (o) => (o.t === 's' ? String(o.v) : o.t === 'n' ? general(o.v) : o.t === 'b' ? (o.v ? 'TRUE' : 'FALSE') : '');
  /** What the fill makes from the seeds: FillAnalyse, then the list, the series or the repeated pattern. */
  function fillAuto(items, n, L) {
    const N = items.length;
    const out = [];
    if (!N) { for (let i = 0; i < n; i++) { out.push({ v: null, t: '' }); } return out; }
    const first = items[0];
    const fmtAt = (k) => items[(k - 1) % N].fmt;
    let cmd = 'simple'; let inc = 0; let dateCmd = 'day'; let list = null; let listIdx = 0; let minDigits = 0;
    const kind = first.t === 'n' && first.fmt ? fmtKind(first.fmt) : '';
    if (first.t === 'n' && kind === 'date') {
      if (N > 1) {
        const v2 = items[1].t === 'n' ? items[1].v : 0;
        if (Math.floor(first.v) !== Math.floor(v2)) {
          let d1 = serialToYmd(first.v); let d2 = serialToYmd(v2);
          let ddiff = d2.d - d1.d; let mdiff = d2.m - d1.m; let ydiff = d2.y - d1.y;
          let cmp;
          if (mdiff && isEndOfMonth(d1) && isEndOfMonth(d2)) { dateCmd = 'eom'; cmp = mdiff + 12 * ydiff; } else if (ddiff) { dateCmd = 'day'; cmp = Math.floor(v2) - Math.floor(first.v); } else { dateCmd = 'month'; cmp = mdiff + 12 * ydiff; }
          let ok = true;
          let prev = Math.floor(first.v);
          for (let i = 1; i < N && ok; i++) {
            if (items[i].t !== 'n') { ok = false; break; }
            const cur = Math.floor(items[i].v);
            if (dateCmd === 'day') { if (cur - prev !== cmp) { ok = false; } } else {
              d1 = serialToYmd(prev); d2 = serialToYmd(cur);
              ddiff = d2.d - d1.d; mdiff = d2.m - d1.m; ydiff = d2.y - d1.y;
              if ((ddiff && !isEndOfMonth(d1) && !isEndOfMonth(d2)) || mdiff + 12 * ydiff !== cmp) { ok = false; }
            }
            prev = cur;
          }
          if (ok) {
            if ((dateCmd === 'month' || dateCmd === 'eom') && cmp % 12 === 0) { dateCmd = 'year'; cmp /= 12; }
            cmd = 'date'; inc = cmp;
          }
        } else { cmd = 'date'; dateCmd = 'day'; inc = 0; }
      } else { cmd = 'date'; dateCmd = 'day'; inc = 1; }
    } else if (first.t === 'n') {
      const time = kind === 'time' || kind === 'datetime';
      const diff = (a, b) => (time ? Math.round((a - b) * 864e11) / 864e11 : approxDiff(a, b));
      if (N > 1) {
        let ok = items.every((o) => o.t === 'n');
        if (ok) {
          inc = diff(items[1].v, first.v);
          for (let i = 1; i < N && ok; i++) { if (!approxEq13(diff(items[i].v, items[i - 1].v), inc)) { ok = false; } }
        }
        if (ok) { cmd = 'linear'; }
      }
    } else if (first.t === 's') {
      const hit = fillList(first.v, L);
      if (hit) {
        list = hit.list; listIdx = hit.i; let step = 1;
        for (let i = 1; i < N && list; i++) {
          const prev = listIdx;
          const low = seedText(items[i]).toLowerCase();
          const j = list.findIndex((x) => x.toLowerCase() === low);
          if (j < 0) { list = null; break; }
          listIdx = j;
          let d = j - prev; if (d < 0) { d += list.length; }
          if (i === 1) { step = d; } else if (step !== d) { list = null; }
        }
        if (list) { inc = step; }
      } else if (N > 1) {
        const d1 = decompValue(String(first.v));
        if (d1) {
          minDigits = Math.max(minDigits, d1.digits);
          const d2 = decompValue(seedText(items[1]));
          if (d2 && d2.flag === d1.flag) {
            inc = approxDiff(d2.val, d1.val);
            let ok = true; let prev = d1.val;
            for (let i = 1; i < N && ok; i++) {
              if (items[i].t !== 's') { ok = false; break; }
              const d = decompValue(String(items[i].v));
              if (!d || d.flag !== d1.flag) { ok = false; break; }
              minDigits = Math.max(minDigits, d.digits);
              if (!approxEq13(approxDiff(d.val, prev), inc)) { ok = false; }
              prev = d.val;
            }
            if (ok) { cmd = 'linear'; }
          }
        }
      }
    }
    const last = items[N - 1];
    if (list) {
      for (let k = 1; k <= n; k++) { out.push({ v: list[((listIdx + inc * k) % list.length + list.length) % list.length], t: 's' }); }
      return out;
    }
    if (cmd === 'date') {
      const st = { dom: 0 }; let v = Math.floor(last.v);
      for (let k = 1; k <= n; k++) { v = incDate(v, st, inc, dateCmd); out.push(fmtAt(k) ? { v, t: 'n', fmt: fmtAt(k) } : { v, t: 'n' }); }
      return out;
    }
    if (cmd === 'linear' && last.t === 'n') {
      for (let k = 1; k <= n; k++) { const v = last.v + inc * k; out.push(fmtAt(k) ? { v, t: 'n', fmt: fmtAt(k) } : { v, t: 'n' }); }
      return out;
    }
    if (cmd === 'linear') {
      const d = decompValue(String(last.v));
      const digits = Math.max(minDigits, d.digits);
      for (let k = 1; k <= n; k++) { out.push({ v: withValue(d, Math.trunc(d.val + inc * k), digits), t: 's' }); }
      return out;
    }
    // the pattern again, each seed one step further per round
    for (let i = 0; i < n; i++) {
      const src = items[i % N]; const delta = Math.floor(i / N) + 1;
      if (src.t === 's') {
        const d = decompValue(String(src.v));
        if (d) { out.push({ v: withValue(d, d.val < 0 ? d.val - delta : d.val + delta, d.digits), t: 's' }); } else { out.push({ v: src.v, t: 's' }); }
      } else if (src.t === 'n') {
        const k = src.fmt ? fmtKind(src.fmt) : '';
        const v = k === 'percent' ? src.v + delta * 0.01 : src.v + delta;
        out.push(src.fmt ? { v, t: 'n', fmt: src.fmt } : { v, t: 'n' });
      } else { out.push(src.fmt ? { v: src.v, t: src.t, fmt: src.fmt } : { v: src.v, t: src.t }); }
    }
    return out;
  }
  /** A value as text that, typed again, gives the same value (the old text-in, text-out form of fillSeries). */
  function retypeable(o, L) {
    if (o.t === 's') { return String(o.v); }
    if (o.t === 'b') { return o.v ? 'TRUE' : 'FALSE'; }
    if (o.t !== 'n') { return ''; }
    const k = o.fmt ? fmtKind(o.fmt) : '';
    if (k === 'date') { return format(Math.floor(o.v), 'n', L.id === 'ja' ? 'yyyy/m/d' : 'yyyy-mm-dd', L.id); }
    if (k === 'datetime') { return format(o.v, 'n', L.id === 'ja' ? 'yyyy/m/d hh:mm:ss' : 'yyyy-mm-dd hh:mm:ss', L.id); }
    if (k === 'time') { return format(o.v, 'n', '[hh]:mm:ss', L.id); }
    if (k === 'percent') { return general(rtlRound(o.v * 100, 13, 'corr')) + '%'; }
    return general(o.v);
  }
  /**
   * The next n values after the seeds, as Calc's fill handle makes them
   * (locale 'ja' unless given). Seeds are { v, t, fmt } (as get() gives
   * them — the format tells a date, so month ends step as month ends), plain
   * numbers, or typed text; the answer is { v, t, fmt } for objects, and
   * otherwise text that types back to the value.
   */
  function fillSeries(values, n, locale) {
    const L = locOf(locale == null ? 'ja' : locale);
    const items = values.map((x) => fillItem(x, L));
    const res = fillAuto(items, n, L);
    const asText = !values.some((x) => x !== null && typeof x === 'object');
    if (asText) { return res.map((o) => retypeable(o, L)); }
    return res.map((o) => (o.fmt ? { v: o.v, t: o.t, fmt: o.fmt } : { v: o.v, t: o.t }));
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

  const FUNCS0 = [
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
  ];
  const FUNCS = FUNCS0.concat(MORE.map(([name, group, syntax, about]) => {
    if (syntax.charAt(0) !== '@') { return [name, group, syntax, about]; }
    const of = syntax.slice(1);
    const m = FUNCS0.concat(MORE).find((x) => x[0] === of && x[2].charAt(0) !== '@');
    return [name, group, m ? m[2].replace(/^[^(]+/, name) : name + '()', about || (m ? m[3] : '')];
  })).filter((f, i, all) => all.findIndex((g) => g[0] === f[0]) === i).map(([name, group, syntax, about]) => ({ name, group, syntax, about }));
  /** For the formula bar's hints: name, the arguments, a short English description. */
  const functions = () => FUNCS.map((f) => ({ name: f.name, args: f.syntax.replace(/^[A-Z0-9.]+\((.*)\)$/, '$1'), description: f.about, group: f.group }));

  const api = {
    workbook, shiftFormula, parseInput, format, formatInfo, colName, parseRef, refName, functions, fillSeries, cfMatch, validate,
    compute, formatAs, literal, ERR, FUNCS, general,
    MAXR, MAXC,
    /** The book being shown limits General to so many decimals (its calc.decimals), or not (null). */
    standardDecimals(n) { STD_DEC = Number.isInteger(n) && n >= 0 && n <= 20 ? n : null; },
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (root) { root.CalcBaseCalc = api; }
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null)));
