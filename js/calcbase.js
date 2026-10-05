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
  const TEMPLATE = `
<div class="cb-shell" :class="{ narrow: narrow }" @contextmenu="onContextMenu($event)">
  <div v-if="narrow && sideOpen" class="cb-backdrop" @click="sideOpen = false"></div>
  <aside class="cb-side" :class="{ hidden: !sideOpen }">
    <div class="brand">
      <span class="logo" v-html="logo"></span>
      <span class="name">CalcBase</span>
      <span class="ver" v-if="!narrow">{{ version }}</span>
      <button v-if="narrow" class="cb-tb side-close" @click="sideOpen = false" :title="t('Close')"><span v-html="icons.close"></span></button>
    </div>
    <div class="side-actions">
      <button class="cb-btn primary wide" @click="newBook">＋ {{ t('New book') }}</button>
      <button class="cb-btn ghost wide" @click="importBook"><span v-html="icons.import"></span> {{ t('Import…') }}</button>
    </div>
    <div class="cb-booklist">
      <p class="hint" v-if="!books.length">{{ t('No books yet. Everything you make here is saved to {folder} in your Files as a plain .html file.', { folder: settings.folder }) }}</p>
      <button v-for="b in books" :key="b.id" class="cb-bookitem" :class="{ active: b.id === book.id }"
        @click="openBook(b.id)" @contextmenu.prevent.stop="bookCtx($event, b)">
        <span class="t">{{ b.title || b.name }}</span>
        <span class="m">{{ when(b.mtime) }} · {{ size(b.size) }}<span v-if="b.shared"> · {{ b.owner }}</span></span>
      </button>
    </div>
    <div class="side-foot">
      <button class="cb-btn ghost wide" @click="openSettings()">⚙ {{ t('Settings') }}</button>
    </div>
  </aside>

  <section class="cb-main">
    <div class="cb-topbar">
      <button class="cb-tb menu-btn" @touchend.prevent="sideOpen = !sideOpen" @click="sideOpen = !sideOpen" :title="t('Books')"><span v-html="icons.menu"></span></button>
      <input class="title-input" v-model="book.name" :placeholder="t('Untitled book')" @change="applyTitle" :disabled="!book.id || book.readOnly">
      <span class="state" :class="{ dirty: dirty, ro: book.readOnly }">{{ stateText }}</span>
      <button class="cb-btn" @click="save(true)" :disabled="!book.id || saving || book.readOnly" :title="t('Save') + ' (Ctrl+S)'"><span v-html="icons.save"></span> <span class="lbl">{{ t('Save') }}</span></button>
      <button class="cb-btn" @click="openPrint" :disabled="!book.id" :title="t('Print / PDF')"><span v-html="icons.print"></span> <span class="lbl">{{ t('Print / PDF') }}</span></button>
      <span class="cb-pop">
        <button class="cb-btn ghost" @click="toggleMenu('more')" :title="t('More')">⋯</button>
        <div class="cb-menu" v-if="menu === 'more'" @mousedown.prevent>
          <button class="cb-menu-item" :disabled="!book.id" @click="menu = ''; openExport()"><span v-html="icons.export"></span>{{ t('Export as CSV / ODS / XLSX…') }}</button>
          <button class="cb-menu-item" :disabled="!book.id" @click="menu = ''; downloadBook(book)"><span v-html="icons.doc"></span>{{ t('Download the .html') }}</button>
          <button class="cb-menu-item" :disabled="!book.id" @click="menu = ''; openVersions(book)">{{ t('Versions…') }}</button>
          <div class="cb-menu-sep"></div>
          <button class="cb-menu-item" :disabled="!book.id" @click="menu = ''; showSource">&lt;/&gt; {{ t('View the HTML') }}</button>
          <button class="cb-menu-item" :disabled="!book.id" @click="menu = ''; toggleFind()"><span v-html="icons.search"></span>{{ t('Find and replace') }}<span class="k">Ctrl+F</span></button>
        </div>
      </span>
      <span class="grow"></span>
      <span class="hist">
      <button class="cb-tb" @mousedown.prevent @click="undo" :disabled="!canUndo" :title="t('Undo') + ' (Ctrl+Z)'"><span v-html="icons.undo"></span></button>
      <button class="cb-tb" @mousedown.prevent @click="redo" :disabled="!canRedo" :title="t('Redo') + ' (Ctrl+Y)'"><span v-html="icons.redo"></span></button>
      </span>
      <span class="cb-num" :title="t('Zoom')">
        <button class="cb-tb" @mousedown.prevent @click="stepZoom(-10)" v-html="icons.minus"></button>
        <button class="cb-tb text zoomv" @mousedown.prevent @click="setZoom(100)">{{ zoom }}%</button>
        <button class="cb-tb" @mousedown.prevent @click="stepZoom(10)" v-html="icons.plus"></button>
      </span>

      <span class="fmttools" v-if="book.id">
        <button class="cb-tb" @mousedown.prevent @click="clipCut()" :disabled="book.readOnly" :title="t('Cut') + ' (Ctrl+X)'"><span v-html="icons.cut"></span></button>
        <button class="cb-tb" @mousedown.prevent @click="clipCopy()" :title="t('Copy') + ' (Ctrl+C)'"><span v-html="icons.copy"></span></button>
        <button class="cb-tb" @mousedown.prevent @click="clipPasteButton()" :disabled="book.readOnly" :title="t('Paste') + ' (Ctrl+V)'"><span v-html="icons.paste"></span></button>
        <span class="sep"></span>
        <select class="tb-select tb-font" :value="fmtNow.font || ''" @change="setStyle('font', $event.target.value)" :title="t('Font')" :disabled="book.readOnly">
          <option value="">{{ t('Default font') }}</option>
          <option v-for="f in fontChoices" :key="f" :value="f" :style="{ fontFamily: f }">{{ f }}</option>
        </select>
        <select class="tb-select tb-size" :value="fmtNow.size || ''" @change="setStyle('size', $event.target.value ? Number($event.target.value) : '')" :title="t('Size (pt)')" :disabled="book.readOnly">
          <option value="">{{ settings.fontSize }}</option>
          <option v-for="n in fontSizes" :key="n" :value="n">{{ n }}</option>
        </select>
        <span class="sep"></span>
        <button class="cb-tb" :class="{ on: fmtNow.b }" @mousedown.prevent @click="toggleStyle('b')" :disabled="book.readOnly" :title="t('Bold') + ' (Ctrl+B)'"><span class="b">B</span></button>
        <button class="cb-tb" :class="{ on: fmtNow.i }" @mousedown.prevent @click="toggleStyle('i')" :disabled="book.readOnly" :title="t('Italic') + ' (Ctrl+I)'"><span class="i">I</span></button>
        <button class="cb-tb" :class="{ on: fmtNow.u }" @mousedown.prevent @click="toggleStyle('u')" :disabled="book.readOnly" :title="t('Underline') + ' (Ctrl+U)'"><span class="u">U</span></button>
        <button class="cb-tb" :class="{ on: fmtNow.strike }" @mousedown.prevent @click="toggleStyle('strike')" :disabled="book.readOnly" :title="t('Strikethrough')"><span class="s">S</span></button>
        <span class="cb-pop">
          <label class="cb-tb" :title="t('Text colour')">
            <span v-html="icons.colour"></span>
            <span class="colour-bar" :style="{ background: fmtNow.color || 'var(--sheet-ink)' }"></span>
            <input type="color" :value="fmtNow.color || '#000000'" @input="setStyle('color', $event.target.value)" :disabled="book.readOnly">
          </label>
          <button class="cb-tb caret" :class="{ on: menu === 'color' }" @mousedown.prevent @click="toggleMenu('color')" v-html="icons.down" :title="t('Text colour')"></button>
          <div class="cb-menu" v-if="menu === 'color'" @mousedown.prevent>
            <button class="cb-menu-item" @click="setStyle('color', ''); menu = ''"><span class="cb-swatch none"></span>{{ t('Automatic') }}</button>
            <div class="cb-swatches"><button v-for="c in palette" :key="c" class="sw" :class="{ on: fmtNow.color === c }" :style="{ background: c }" :title="c" @click="setStyle('color', c); menu = ''"></button></div>
          </div>
        </span>
        <span class="cb-pop">
          <label class="cb-tb" :title="t('Fill colour')">
            <span v-html="icons.fill"></span>
            <span class="colour-bar" :style="{ background: fmtNow.bg || 'transparent', border: fmtNow.bg ? 'none' : '1px dashed var(--muted)' }"></span>
            <input type="color" :value="fmtNow.bg || '#ffff00'" @input="setStyle('bg', $event.target.value)" :disabled="book.readOnly">
          </label>
          <button class="cb-tb caret" :class="{ on: menu === 'bg' }" @mousedown.prevent @click="toggleMenu('bg')" v-html="icons.down" :title="t('Fill colour')"></button>
          <div class="cb-menu" v-if="menu === 'bg'" @mousedown.prevent>
            <button class="cb-menu-item" @click="setStyle('bg', ''); menu = ''"><span class="cb-swatch none"></span>{{ t('No fill') }}</button>
            <div class="cb-swatches"><button v-for="c in palette" :key="c" class="sw" :class="{ on: fmtNow.bg === c }" :style="{ background: c }" :title="c" @click="setStyle('bg', c); menu = ''"></button></div>
          </div>
        </span>
        <span class="cb-pop">
          <button class="cb-tb" :class="{ on: menu === 'borders' }" @mousedown.prevent @click="toggleMenu('borders')" :disabled="book.readOnly" :title="t('Borders')"><span v-html="icons.borders"></span><span class="caret" v-html="icons.down"></span></button>
          <div class="cb-menu" v-if="menu === 'borders'" @mousedown.prevent>
            <div class="bgrid">
              <button v-for="p in borderPresets" :key="p.key" class="bp" @click="applyBorderPreset(p.key); menu = ''" :title="p.label"><span class="pic" :class="p.key"></span>{{ p.label }}</button>
            </div>
            <div class="cb-menu-sep"></div>
            <button class="cb-menu-item" @click="menu = ''; openCellProps('border')">{{ t('More borders…') }}</button>
          </div>
        </span>
        <span class="sep"></span>
        <button class="cb-tb" :class="{ on: fmtNow.ha === 'left' }" @mousedown.prevent @click="setStyle('ha', fmtNow.ha === 'left' ? '' : 'left')" :disabled="book.readOnly" :title="t('Align left')" v-html="icons.alignL"></button>
        <button class="cb-tb" :class="{ on: fmtNow.ha === 'center' }" @mousedown.prevent @click="setStyle('ha', fmtNow.ha === 'center' ? '' : 'center')" :disabled="book.readOnly" :title="t('Centre')" v-html="icons.alignC"></button>
        <button class="cb-tb" :class="{ on: fmtNow.ha === 'right' }" @mousedown.prevent @click="setStyle('ha', fmtNow.ha === 'right' ? '' : 'right')" :disabled="book.readOnly" :title="t('Align right')" v-html="icons.alignR"></button>
        <button class="cb-tb" :class="{ on: fmtNow.va === 'top' }" @mousedown.prevent @click="setStyle('va', fmtNow.va === 'top' ? '' : 'top')" :disabled="book.readOnly" :title="t('Align top')" v-html="icons.vTop"></button>
        <button class="cb-tb" :class="{ on: fmtNow.va === 'middle' }" @mousedown.prevent @click="setStyle('va', fmtNow.va === 'middle' ? '' : 'middle')" :disabled="book.readOnly" :title="t('Centre vertically')" v-html="icons.vMid"></button>
        <button class="cb-tb" :class="{ on: fmtNow.va === 'bottom' }" @mousedown.prevent @click="setStyle('va', '')" :disabled="book.readOnly" :title="t('Align bottom')" v-html="icons.vBot"></button>
        <button class="cb-tb" :class="{ on: fmtNow.wrap }" @mousedown.prevent @click="toggleStyle('wrap')" :disabled="book.readOnly" :title="t('Wrap text')" v-html="icons.wrap"></button>
        <button class="cb-tb" :class="{ on: selIsMerged }" @mousedown.prevent @click="toggleMerge" :disabled="book.readOnly" :title="selIsMerged ? t('Unmerge cells') : t('Merge cells')" v-html="icons.merge"></button>
        <span class="sep"></span>
        <span class="cb-pop">
          <button class="cb-tb text" :class="{ on: menu === 'numfmt' }" @mousedown.prevent @click="toggleMenu('numfmt')" :disabled="book.readOnly" :title="t('Number format')"><span class="fname">{{ numFmtLabel }}</span><span class="caret" v-html="icons.down"></span></button>
          <div class="cb-menu wide" v-if="menu === 'numfmt'" @mousedown.prevent>
            <button v-for="nf in numFormats" :key="nf.code" class="cb-menu-item" :class="{ on: (fmtNow.fmt || 'General') === nf.code }" @click="setFmt(nf.code); menu = ''"><span>{{ nf.label }}</span><span class="ex">{{ nf.sample }}</span></button>
            <div class="cb-menu-sep"></div>
            <button class="cb-menu-item" @click="menu = ''; openCellProps('number')">{{ t('More formats…') }}</button>
          </div>
        </span>
        <button class="cb-tb" @mousedown.prevent @click="setFmt('0%')" :disabled="book.readOnly" :title="t('Percent')" v-html="icons.percent"></button>
        <button class="cb-tb" @mousedown.prevent @click="stepDec(1)" :disabled="book.readOnly" :title="t('Add a decimal place')" v-html="icons.dec0"></button>
        <button class="cb-tb" @mousedown.prevent @click="stepDec(-1)" :disabled="book.readOnly" :title="t('Remove a decimal place')" v-html="icons.dec1"></button>
        <span class="sep"></span>
        <span class="cb-pop">
          <button class="cb-tb" :class="{ on: menu === 'rows' }" @mousedown.prevent @click="toggleMenu('rows')" :disabled="book.readOnly" :title="t('Rows and columns')"><span v-html="icons.rows"></span><span class="caret" v-html="icons.down"></span></button>
          <div class="cb-menu wide" v-if="menu === 'rows'" @mousedown.prevent>
            <button class="cb-menu-item" @click="insertRows(0); menu = ''">{{ t('Insert rows above') }}</button>
            <button class="cb-menu-item" @click="insertRows(1); menu = ''">{{ t('Insert rows below') }}</button>
            <button class="cb-menu-item" @click="deleteRows(); menu = ''">{{ t('Delete rows') }}</button>
            <div class="cb-menu-sep"></div>
            <button class="cb-menu-item" @click="insertCols(0); menu = ''">{{ t('Insert columns before') }}</button>
            <button class="cb-menu-item" @click="insertCols(1); menu = ''">{{ t('Insert columns after') }}</button>
            <button class="cb-menu-item" @click="deleteCols(); menu = ''">{{ t('Delete columns') }}</button>
            <div class="cb-menu-sep"></div>
            <button class="cb-menu-item" @click="askRowHeight(); menu = ''">{{ t('Row height…') }}</button>
            <button class="cb-menu-item" @click="askColWidth(); menu = ''">{{ t('Column width…') }}</button>
          </div>
        </span>
        <button class="cb-tb" @mousedown.prevent @click="sortSel(1)" :disabled="book.readOnly" :title="t('Sort ascending')" v-html="icons.sortAZ"></button>
        <button class="cb-tb" @mousedown.prevent @click="sortSel(-1)" :disabled="book.readOnly" :title="t('Sort descending')" v-html="icons.sortZA"></button>
        <button class="cb-tb" :class="{ on: hasFilter }" @mousedown.prevent @click="toggleFilter" :disabled="book.readOnly" :title="t('AutoFilter')" v-html="icons.filter"></button>
        <button class="cb-tb" :class="{ on: hasFreeze }" @mousedown.prevent @click="toggleFreeze" :disabled="book.readOnly" :title="hasFreeze ? t('Unfreeze rows and columns') : t('Freeze rows and columns at the cursor')" v-html="icons.freeze"></button>
        <button class="cb-tb" :class="{ on: !gridOn }" @mousedown.prevent @click="toggleGrid" :disabled="book.readOnly" :title="gridOn ? t('Hide gridlines') : t('Show gridlines')" v-html="icons.table"></button>
        <span class="sep"></span>
        <button class="cb-tb" @mousedown.prevent @click="openFx" :disabled="book.readOnly" :title="t('Insert function…')" v-html="icons.fx"></button>
        <button class="cb-tb" :class="{ on: find.open }" @mousedown.prevent @click="toggleFind()" :title="t('Find and replace') + ' (Ctrl+F)'" v-html="icons.search"></button>
        <button class="cb-tb" @mousedown.prevent @click="openCellProps('number')" :disabled="book.readOnly" :title="t('Cell properties…')" v-html="icons.settings"></button>
      </span>
    </div>

    <div class="cb-work" v-if="book.id">
    <div class="cb-sheetcol">
    <!-- the formula bar -->
    <div class="cb-fbar">
      <input class="namebox" :value="nameBoxText" @keydown.enter.prevent="goToName($event.target.value); $event.target.blur()" @keydown.esc.prevent="$event.target.value = nameBoxText; $event.target.blur()" @focus="$event.target.select()" :title="t('Name box: the cell or range, or type an address to go there')" spellcheck="false">
      <button class="cb-tb fx" @mousedown.prevent @click="openFx" :title="t('Insert function…')" :disabled="book.readOnly">fx</button>
      <template v-if="edit.on">
        <button class="cb-tb no" @mousedown.prevent @click="cancelEdit" :title="t('Cancel')">✕</button>
        <button class="cb-tb ok" @mousedown.prevent @click="commitEdit()" :title="t('Accept')">✓</button>
      </template>
      <textarea class="finput" :class="{ tall: fbarFocused }" ref="finput" rows="1" :value="fbarText" :disabled="book.readOnly" spellcheck="false" autocomplete="off"
        @focus="fbarFocus" @blur="fbarFocused = false" @input="fbarInput($event)" @keydown="fbarKey($event)" @click="caretMoved($event.target)" @keyup="caretMoved($event.target)"
        :placeholder="t('Type here, or in the cell')"></textarea>
    </div>
    <!-- find and replace -->
    <div class="cb-find" v-if="find.open">
      <span class="ic" v-html="icons.search"></span>
      <input ref="findInput" type="text" v-model="find.query" :placeholder="t('Find')" @input="runFind()" @keydown.enter.prevent="findNext($event.shiftKey ? -1 : 1)" @keydown.esc.prevent="toggleFind(false)">
      <span class="count">{{ find.hits.length ? (find.index + 1) + ' / ' + find.hits.length : t('none') }}</span>
      <button class="cb-tb" @mousedown.prevent @click="findNext(-1)" :title="t('Previous')">↑</button>
      <button class="cb-tb" @mousedown.prevent @click="findNext(1)" :title="t('Next')">↓</button>
      <label class="opt"><input type="checkbox" v-model="find.caseSensitive" @change="runFind()"> {{ t('Match case') }}</label>
      <label class="opt"><input type="checkbox" v-model="find.formulas" @change="runFind()"> {{ t('In formulas') }}</label>
      <span class="sep"></span>
      <input type="text" v-model="find.replace" :placeholder="t('Replace with')" @keydown.enter.prevent="replaceOne" :disabled="book.readOnly">
      <button class="cb-btn" @mousedown.prevent @click="replaceOne" :disabled="!find.hits.length || book.readOnly">{{ t('Replace') }}</button>
      <button class="cb-btn" @mousedown.prevent @click="replaceAll" :disabled="!find.hits.length || book.readOnly">{{ t('Replace all') }}</button>
      <button class="cb-tb" @click="toggleFind(false)" :title="t('Close')"><span v-html="icons.close"></span></button>
    </div>

    <!-- the grid: drawn by hand into .cb-layers (see paint()) -->
    <div class="cb-gridwrap" ref="gridwrap" :class="{ nogrid: !gridOn }" tabindex="-1"
      @mousedown="gridMouseDown($event)" @dblclick="gridDblClick($event)" @wheel="gridWheel($event)"
      @touchstart.passive="gridTouchStart($event)" @touchend="gridTouchEnd($event)" @touchmove.passive="gridTouchMove($event)">
      <div class="cb-scroller" ref="scroller" @scroll.passive="onScroll">
        <div class="cb-view" ref="view">
          <div class="cb-layers" ref="layers"></div>
          <textarea ref="editor" class="cb-editor" :class="{ wrap: edit.wrap, idle: !edit.on }" :style="edit.style" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="cell"
            @input="editorInput($event)" @keydown="gridKey($event)" @click="caretMoved($event.target)" @keyup="caretMoved($event.target)" @blur="editorBlur($event)"
            @paste="onPaste($event)" @copy="onCopy($event)" @cut="onCut($event)"
            @compositionstart="composing = true" @compositionend="composing = false; editorInput($event)"></textarea>
        </div>
        <div class="cb-spacer" ref="spacer"></div>
      </div>
      <div class="cb-hints" v-if="edit.on && (edit.hints.length || edit.sig)" :style="hintsStyle">
        <template v-if="edit.hints.length">
          <button v-for="(h, i) in edit.hints" :key="h.name" class="hint-item" :class="{ on: i === edit.hintIdx }" @mousedown.prevent @click="takeHint(h)"><b>{{ h.name }}({{ h.args }})</b><span class="d">{{ t(h.description) }}</span></button>
        </template>
        <div class="sig" v-else-if="edit.sig" v-html="sigHtml"></div>
      </div>
    </div>

    <!-- sheet tabs -->
    <div class="cb-sheets">
      <button class="cb-tb add" @click="addSheet()" :disabled="book.readOnly" :title="t('Insert sheet')"><span v-html="icons.plus"></span></button>
      <template v-for="(name, i) in sheetNames" :key="i + ':' + name">
        <input v-if="renameSheet.idx === i" class="rename-input" ref="renameInput" v-model="renameSheet.text" @keydown.enter.prevent="finishRenameSheet" @keydown.esc.prevent="renameSheet.idx = -1" @blur="finishRenameSheet" maxlength="60">
        <button v-else class="tab" :class="{ active: i === active }" @click="switchSheet(i)" @dblclick="startRenameSheet(i)" @contextmenu.prevent.stop="sheetCtx($event, i)">{{ name }}</button>
      </template>
    </div>
    <!-- status bar -->
    <div class="cb-status">
      <span class="grow">{{ t('Sheet {n} of {total}', { n: active + 1, total: sheetNames.length }) }}<span v-if="selCount > 1"> · {{ t('{n} cells selected', { n: selCount }) }}</span></span>
      <span class="stat" v-if="stats.count"><b>{{ t('Sum') }}:</b> {{ stats.sum }}</span>
      <span class="stat avg" v-if="stats.count"><b>{{ t('Average') }}:</b> {{ stats.avg }}</span>
      <span class="stat cnt" v-if="stats.count"><b>{{ t('Count') }}:</b> {{ stats.count }}</span>
    </div>
    </div>

    <!-- the AI assistant (through AI-Hub) -- the same column as the other Base apps -->
    <aside class="ai-col" v-if="ai.show && ai.open" :style="{ flex: '0 0 ' + aiWidth(), width: aiWidth() }">
      <div class="ai-head">
        <span class="ai-title">{{ t('AI assistant') }}</span>
        <span class="ai-sub">{{ t('CalcBase only') }}</span>
        <span class="grow"></span>
        <span class="ai-model" v-if="ai.model" :title="ai.model">{{ ai.model }}</span>
        <button type="button" class="cb-btn xs" :disabled="ai.busy" :title="t('New conversation')" @click="aiClear">＋ {{ t('New conversation') }}</button>
        <button type="button" class="hnd" :title="t('Hide') + ' — ' + t('AI assistant')" :aria-label="t('Hide') + ' — ' + t('AI assistant')" @click="aiToggle">{{ narrow ? '▼' : '▶' }}</button>
      </div>
      <div class="ai-msgs" ref="aiMsgs">
        <p class="ai-hint" v-if="!ai.msgs.length">{{ t('Ask how to do something in CalcBase, or say what to change in this book: the assistant can write into cells.') }}</p>
        <div class="ai-msg" :class="m.role" v-for="(m, i) in ai.msgs" :key="i">
          <div class="ai-bubble" v-html="aiHtml(m)"></div>
          <div class="did" v-if="m.did">{{ m.did }}</div>
        </div>
        <div class="ai-msg assistant" v-if="ai.busy"><div class="ai-bubble busy">{{ t('Thinking…') }}</div></div>
        <p class="ai-err" v-if="ai.error">{{ ai.error }}</p>
      </div>
      <div class="ai-foot">
        <textarea v-model="ai.input" rows="2" :placeholder="ai.ready ? t('Message to the assistant…') : aiNotReady()" :disabled="!ai.ready"
          @keydown="aiKey($event)" @compositionstart="ai.composing = true" @compositionend="ai.composing = false"></textarea>
        <button class="cb-btn primary" @click="aiSend" :disabled="ai.busy || !ai.ready || !ai.input.trim()">{{ t('Send') }}</button>
      </div>
    </aside>
    <div class="ai-bar" v-if="ai.show && !ai.open">
      <button type="button" class="hnd" :title="t('Show') + ' — ' + t('AI assistant')" :aria-label="t('Show') + ' — ' + t('AI assistant')" @click="aiToggle">{{ narrow ? '▲' : '◀' }}</button>
      <span class="ai-lb">{{ t('AI assistant') }}</span>
    </div>
    </div>

    <div class="cb-empty" v-else>
      <span class="mark" v-html="logo"></span>
      <p>{{ books.length ? t('Choose a book on the left, or make a new one.') : t('Make your first book with “New book”.') }}</p>
      <button class="cb-btn primary" @click="newBook">＋ {{ t('New book') }}</button>
    </div>
  </section>

  <!-- ===== dialogs ===== -->
  <div v-if="settingsOpen" class="cb-modal-back">
    <div class="cb-modal cb-settings" @click.stop>
      <div class="set-head">
        <span class="ic big">⚙</span>
        <div><strong>{{ t('Settings') }}</strong><div class="dim">{{ t('Applies to CalcBase only, for your account.') }}</div></div>
        <button type="button" class="set-close" :title="t('Close')" :aria-label="t('Close')" @click="cancelSettings()"><svg viewBox="0 0 24 24"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg></button>
      </div>
      <div class="body">
        <div class="set-tabs" role="tablist">
          <button v-for="tb in settingTabs" :key="tb.key" type="button" class="set-tab" :class="{ active: setTab === tb.key }" role="tab" :aria-selected="setTab === tb.key ? 'true' : 'false'" :title="tb.label" @click="setTab = tb.key"><span class="ic">{{ tb.icon }}</span>{{ tb.label }}</button>
        </div>
        <section class="set-group" v-show="setTab === 'view'">
          <h3><span class="ic">🎨</span>{{ t('Appearance and language') }}</h3>
          <div class="theme-picks">
            <button v-for="opt in themeOptions" :key="opt.id" type="button" class="theme-pick" :class="{ active: settings.theme === opt.id }" @click="pickTheme(opt.id)">
              <span class="swatch" :class="opt.id"><i class="bar"></i><i class="line"></i><i class="line short"></i></span>
              <strong>{{ t(opt.label) }}</strong>
              <span class="dim">{{ t(opt.hint) }}</span>
              <span class="tick" v-if="settings.theme === opt.id">✓</span>
            </button>
          </div>
          <p class="dim tiny">{{ t('Saved to your account, so it follows you to every browser you sign in from.') }}</p>
          <h4>{{ t('Language') }}</h4>
          <label class="fl">
            <select v-model="settings.language">
              <option value="auto">{{ t('Follow Nextcloud') }}</option>
              <option v-for="l in settings.languages" :key="l.code" :value="l.code">{{ l.name }}</option>
            </select>
          </label>
          <p class="dim tiny">{{ t('CalcBase can speak a different language from the rest of Nextcloud.') }}</p>
          <template v-if="ai.show">
            <h4>🤖 {{ t('Width of the AI assistant') }}</h4>
            <div class="fl">
              <span class="ai-widthbox">
                <input type="number" step="1" :min="settings.aiU === '%' ? 15 : 240" :max="settings.aiU === '%' ? 60 : 1200" v-model.number="settings.aiW" :aria-label="t('Width of the AI assistant')" @change="aiWidthChanged">
                <select v-model="settings.aiU" :aria-label="t('Width of the AI assistant')" @change="aiWidthChanged"><option value="px">px</option><option value="%">%</option></select>
              </span>
            </div>
            <p class="dim tiny">{{ t('In pixels (240 to 1200), or as a percentage of the width of the window (15 to 60).') }}</p>
          </template>
        </section>
        <section class="set-group" v-show="setTab === 'edit'">
          <h3><span class="ic">✏️</span>{{ t('Editing') }}</h3>
          <h4>{{ t('The Enter key') }}</h4>
          <label class="fl">
            <select v-model="settings.enterMoves">
              <option value="down">{{ t('Moves down, to the next row') }}</option>
              <option value="right">{{ t('Moves right, to the next column') }}</option>
            </select>
          </label>
          <p class="dim tiny">{{ t('Shift+Enter goes the other way. Tab always moves right.') }}</p>
          <h4>{{ t('New sheets') }}</h4>
          <label class="opt"><input type="checkbox" v-model="settings.showGrid"> {{ t('Show gridlines on a new sheet') }}</label>
          <h4>{{ t('Default font') }}</h4>
          <div class="fl-row">
            <label class="fl">
              <span class="fl-label">{{ t('Font') }}</span>
              <select v-model="settings.font">
                <option v-for="f in fontChoices" :key="f" :value="f">{{ f }}</option>
              </select>
            </label>
            <label class="fl short">
              <span class="fl-label">{{ t('Size (pt)') }}</span>
              <input type="number" min="6" max="48" step="1" v-model.number="settings.fontSize">
            </label>
          </div>
          <p class="dim tiny">{{ t('Cells with no font of their own are shown in this. The file itself names a font only where you set one.') }}</p>
        </section>
        <section class="set-group" v-show="setTab === 'save'">
          <h3><span class="ic">💾</span>{{ t('Saving') }}</h3>
          <label class="opt"><input type="checkbox" v-model="settings.autosave"> {{ t('Save automatically while typing') }}</label>
          <h4>{{ t('Save books in') }}</h4>
          <label class="fl"><input type="text" v-model="settings.folder" :aria-label="t('Save books in')"></label>
          <p class="dim tiny">{{ t('A folder in your own Files. Books already saved elsewhere stay where they are.') }}</p>
          <h4>{{ t('Versions') }}</h4>
          <div class="fl-row">
            <label class="fl short">
              <span class="fl-label">{{ t('Versions kept') }}</span>
              <input type="number" min="0" max="99" step="1" v-model.number="settings.versionKeep">
            </label>
            <label class="fl">
              <span class="fl-label">{{ t('A version is kept') }}</span>
              <select v-model="settings.versionWhen">
                <option value="manual">{{ t('When you save') }}</option>
                <option value="auto">{{ t('Every time it is saved, autosave and all') }}</option>
              </select>
            </label>
          </div>
          <p class="dim tiny">{{ t('The version before each save is kept beside the book, named after it: 売上.html keeps 売上.#01, and the older ones shift down to #99. They are plain HTML and open in any browser. Nought keeps none.') }}</p>
        </section>
      </div>
      <div class="foot">
        <button class="cb-btn ghost" @click="cancelSettings()">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="saveSettings">{{ t('Save') }}</button>
      </div>
    </div>
  </div>

  <!-- the cell properties -->
  <div v-if="cellPropsOpen" class="cb-modal-back">
    <div class="cb-modal cb-cellprops" style="width:min(640px,100%)" @click.stop>
      <h3>{{ t('Cell properties') }} <span class="cb-tip" style="font-weight:400">{{ selText }}</span></h3>
      <div class="cb-fp-tabs" role="tablist">
        <button v-for="tb in cellTabs" :key="tb.key" class="cb-fp-tab" :class="{ on: cellTab === tb.key }" role="tab" @click="cellTab = tb.key">{{ tb.label }}</button>
      </div>
      <div class="body">
        <div v-if="cellTab === 'number'" class="cb-nf">
          <div class="cb-nf-cats">
            <button v-for="c in numCats" :key="c.key" class="cb-nf-cat" :class="{ on: numUi.cat === c.key }" @click="numUi.cat = c.key; numBuild()">{{ c.label }}</button>
          </div>
          <div class="cb-nf-main">
            <div class="cb-nf-sample"><span class="k">{{ t('Sample') }}</span><span class="v">{{ numPreview }}</span></div>
            <p class="cb-tip">{{ numCatAbout }}</p>
            <div class="cb-row" v-if="['number', 'percent', 'currency', 'sci'].indexOf(numUi.cat) >= 0">
              <div class="cb-field"><label>{{ t('Decimal places') }}</label><input type="number" min="0" max="10" step="1" v-model.number="numUi.dec" @input="numBuild"></div>
              <div class="cb-field" v-if="numUi.cat === 'number' || numUi.cat === 'currency'"><label>&nbsp;</label>
                <label class="opt"><input type="checkbox" v-model="numUi.sep" @change="numBuild"> {{ t('Thousands separator') }}</label></div>
              <div class="cb-field" v-if="numUi.cat === 'currency'"><label>{{ t('Currency symbol') }}</label>
                <select v-model="numUi.cur" @change="numBuild"><option>¥</option><option>$</option><option>€</option><option>£</option></select></div>
              <div class="cb-field" v-if="numUi.cat === 'number' || numUi.cat === 'currency'"><label>&nbsp;</label>
                <label class="opt"><input type="checkbox" v-model="numUi.red" @change="numBuild"> {{ t('Negative numbers in red') }}</label></div>
            </div>
            <div class="cb-field" v-if="numUi.cat === 'date'"><label>{{ t('Date style') }}</label>
              <select v-model="numUi.date" @change="numBuild">
                <option value="yyyy/mm/dd">2026/10/05</option>
                <option value="yyyy-mm-dd">2026-10-05</option>
                <option value="yyyy年m月d日">2026年10月5日</option>
                <option value="ggge年m月d日">令和8年10月5日</option>
                <option value="m/d">10/5</option>
                <option value="yyyy/mm/dd h:mm">2026/10/05 9:30</option>
              </select></div>
            <div class="cb-field" v-if="numUi.cat === 'time'"><label>{{ t('Time style') }}</label>
              <select v-model="numUi.time" @change="numBuild">
                <option value="h:mm">9:30</option>
                <option value="h:mm:ss">9:30:15</option>
              </select></div>
            <template v-if="numUi.cat === 'custom'">
              <div class="cb-field"><label>{{ t('Format code') }}</label><input type="text" v-model="cellProps.fmt" spellcheck="false"></div>
              <div class="cb-nf-examples">
                <button v-for="x in numExamples" :key="x.code" class="cb-nf-ex" :class="{ on: cellProps.fmt === x.code }" @click="cellProps.fmt = x.code">
                  <code>{{ x.code }}</code><span class="s">{{ numSampleOf(x.code) }}</span>
                </button>
              </div>
            </template>
          </div>
        </div>
        <div v-if="cellTab === 'align'" class="cb-row" style="margin-top:10px">
          <div class="cb-field"><label>{{ t('Across the cell') }}</label>
            <select v-model="cellProps.ha">
              <option value="">{{ t('Default (numbers right, text left)') }}</option>
              <option value="left">{{ t('Left') }}</option>
              <option value="center">{{ t('Centre') }}</option>
              <option value="right">{{ t('Right') }}</option>
            </select></div>
          <div class="cb-field"><label>{{ t('Up and down in the cell') }}</label>
            <select v-model="cellProps.va">
              <option value="">{{ t('At the bottom') }}</option>
              <option value="top">{{ t('At the top') }}</option>
              <option value="middle">{{ t('In the middle') }}</option>
            </select></div>
          <div class="cb-field" style="flex-basis:100%"><label>&nbsp;</label>
            <label class="opt"><input type="checkbox" v-model="cellProps.wrap"> {{ t('Wrap text automatically') }}</label></div>
        </div>
        <div v-if="cellTab === 'font'" class="cb-fontpick">
          <div class="col fam">
            <label>{{ t('Font') }}</label>
            <input type="text" v-model="cellProps.font" :placeholder="t('Default font')">
            <div class="list">
              <button class="it" :class="{ on: !cellProps.font }" @click="cellProps.font = ''">{{ t('Default font') }}</button>
              <button v-for="f in fontChoices" :key="f" class="it" :class="{ on: cellProps.font === f }" :style="{ fontFamily: f }" @click="cellProps.font = f">{{ f }}</button>
            </div>
          </div>
          <div class="col sty">
            <label>{{ t('Font style') }}</label>
            <input type="text" readonly :value="cellStyleName">
            <div class="list">
              <button class="it" :class="{ on: !cellProps.b && !cellProps.i }" @click="cellProps.b = false; cellProps.i = false">{{ t('Regular') }}</button>
              <button class="it" :class="{ on: !cellProps.b && cellProps.i }" style="font-style:italic" @click="cellProps.b = false; cellProps.i = true">{{ t('Italic') }}</button>
              <button class="it" :class="{ on: cellProps.b && !cellProps.i }" style="font-weight:700" @click="cellProps.b = true; cellProps.i = false">{{ t('Bold') }}</button>
              <button class="it" :class="{ on: cellProps.b && cellProps.i }" style="font-weight:700;font-style:italic" @click="cellProps.b = true; cellProps.i = true">{{ t('Bold italic') }}</button>
            </div>
          </div>
          <div class="col siz">
            <label>{{ t('Size (pt)') }}</label>
            <input type="number" min="4" max="200" step="0.5" v-model="cellProps.size" :placeholder="String(settings.fontSize)">
            <div class="list">
              <button v-for="n in fontSizes" :key="n" class="it" :class="{ on: Number(cellProps.size) === n }" @click="cellProps.size = n">{{ n }}</button>
            </div>
          </div>
          <div class="row2">
            <label>{{ t('Text colour') }}</label>
            <input type="color" :value="cellProps.color || '#000000'" @input="cellProps.color = $event.target.value">
            <button class="cb-btn ghost" @click="cellProps.color = ''">{{ t('Automatic') }}</button>
            <label class="opt"><input type="checkbox" v-model="cellProps.u"> {{ t('Underline') }}</label>
            <label class="opt"><input type="checkbox" v-model="cellProps.strike"> {{ t('Strikethrough') }}</label>
          </div>
          <div class="preview">
            <span :style="{ fontFamily: cellProps.font || null, fontSize: cellProps.size ? cellProps.size + 'pt' : null, fontWeight: cellProps.b ? 700 : null, fontStyle: cellProps.i ? 'italic' : null, textDecoration: [cellProps.u ? 'underline' : '', cellProps.strike ? 'line-through' : ''].join(' ').trim() || null, color: cellProps.color || null }">{{ t('Aa あア亜 123') }}</span>
          </div>
        </div>
        <div v-if="cellTab === 'border'" class="cb-bd">
          <div class="cb-bd-line">
            <label>{{ t('Line style') }}</label>
            <button v-for="st in borderStyles" :key="st.key" class="cb-bd-st" :class="{ on: bord.style === st.key }" @click="bord.style = st.key">
              <span class="ln" :style="{ borderTop: st.key === 'none' ? '0' : (st.w + 'px ' + st.key + ' currentColor') }"></span><span class="nm">{{ st.label }}</span></button>
            <div class="cb-field"><label>{{ t('Thickness (px)') }}</label><input type="number" min="1" max="6" step="1" v-model.number="bord.width"></div>
            <div class="cb-field"><label>{{ t('Line colour') }}</label><input type="color" v-model="bord.colour"></div>
          </div>
          <div class="cb-bd-main">
            <div class="cb-bd-presets">
              <button class="cb-btn" @click="bordPreset('none')">{{ t('No borders') }}</button>
              <button class="cb-btn" @click="bordPreset('outline')">{{ t('Outline') }}</button>
              <button class="cb-btn" v-if="selSpan.rows > 1 || selSpan.cols > 1" @click="bordPreset('inside')">{{ t('Inside') }}</button>
              <button class="cb-btn" @click="bordPreset('all')">{{ t('All borders') }}</button>
            </div>
            <div class="cb-bd-pic" :style="{ display: 'grid', gridTemplateColumns: 'repeat(' + (selSpan.cols > 1 ? 2 : 1) + ', 1fr)', gridTemplateRows: 'repeat(' + (selSpan.rows > 1 ? 2 : 1) + ', 1fr)' }">
              <span v-for="n in (selSpan.cols > 1 ? 2 : 1) * (selSpan.rows > 1 ? 2 : 1)" :key="'w' + n" class="txt">{{ t('Words') }}</span>
              <button v-for="e in bordEdges" :key="e" v-show="(e !== 'insideH' || selSpan.rows > 1) && (e !== 'insideV' || selSpan.cols > 1)"
                class="edge" :class="[e, bord.edges[e]]" @click="bordToggle(e)" :title="edgeLabel(e)"></button>
            </div>
            <p class="cb-tip">{{ t('Choose a line, then press a preset or an edge of the picture. Edges left grey are not changed.') }}</p>
          </div>
        </div>
        <div v-if="cellTab === 'fill'" class="cb-fillpick">
          <button class="cb-btn" :class="{ primary: !cellProps.bg }" @click="cellProps.bg = ''">{{ t('No fill') }}</button>
          <div class="cb-swatches">
            <button v-for="c in palette" :key="c" class="sw" :class="{ on: cellProps.bg === c }" :style="{ background: c }" @click="cellProps.bg = c" :title="c"></button>
          </div>
          <label>{{ t('Other colour') }} <input type="color" :value="cellProps.bg || '#ffffff'" @input="cellProps.bg = $event.target.value"></label>
        </div>
        <p class="cb-tip" style="margin-top:12px">{{ t('This is put on every cell of the selection.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn" @click="cellPropsOpen = false">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="applyCellProps">{{ t('Apply') }}</button>
      </div>
    </div>
  </div>

  <!-- the functions -->
  <div v-if="fxOpen" class="cb-modal-back" @click="fxOpen = false">
    <div class="cb-modal" @click.stop>
      <h3>fx {{ t('Insert function') }}</h3>
      <div class="body">
        <div class="cb-row">
          <div class="cb-field"><label>{{ t('Category') }}</label>
            <select v-model="fxGroup"><option value="">{{ t('All categories') }}</option><option v-for="g in fxGroups" :key="g" :value="g">{{ t(g) }}</option></select></div>
          <div class="cb-field"><label>{{ t('Search') }}</label><input type="text" ref="fxSearch" v-model="fxQuery" :placeholder="t('Search by name or purpose')" @keydown.enter.prevent="fxInsert()"></div>
        </div>
        <div class="cb-fxlist">
          <button v-for="f in fxList" :key="f.name" class="it" :class="{ on: fxSel === f.name }" @click="fxSel = f.name" @dblclick="fxInsert()"><b>{{ f.name }}</b><span class="d">{{ t(f.description) }}</span><span class="g">{{ t(f.group) }}</span></button>
          <p class="cb-tip" v-if="!fxList.length" style="padding:10px">{{ t('No function matches.') }}</p>
        </div>
        <div class="cb-fxabout" v-if="fxCurrent"><code>{{ fxCurrent.name }}({{ fxCurrent.args }})</code> <span class="cb-tip">{{ t(fxCurrent.group) }}</span><br>{{ t(fxCurrent.description) }}</div>
      </div>
      <div class="foot">
        <button class="cb-btn" @click="fxOpen = false">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" :disabled="!fxCurrent" @click="fxInsert()">{{ t('Insert') }}</button>
      </div>
    </div>
  </div>

  <!-- printing -->
  <div v-if="printOpen" class="cb-modal-back" @click="printOpen = false">
    <div class="cb-modal" @click.stop>
      <h3>{{ t('Print / PDF') }}</h3>
      <div class="body">
        <div class="cb-row">
          <div class="cb-field"><label>{{ t('What to print') }}</label>
            <select v-model="print.range"><option value="sheet">{{ t('The sheet (used range)') }}</option><option value="selection">{{ t('The selection') }}</option><option value="book">{{ t('Every sheet') }}</option></select></div>
          <div class="cb-field"><label>{{ t('Paper') }}</label>
            <select v-model="print.paper"><option v-for="p in paperNames" :key="p" :value="p">{{ p }}</option></select></div>
          <div class="cb-field"><label>{{ t('Orientation') }}</label>
            <select v-model="print.orientation"><option value="portrait">{{ t('Portrait') }}</option><option value="landscape">{{ t('Landscape') }}</option></select></div>
        </div>
        <div class="cb-row">
          <div class="cb-field"><label>{{ t('Margin top (mm)') }}</label><input type="number" min="0" max="50" v-model.number="print.margins.t"></div>
          <div class="cb-field"><label>{{ t('Margin right (mm)') }}</label><input type="number" min="0" max="50" v-model.number="print.margins.r"></div>
          <div class="cb-field"><label>{{ t('Margin bottom (mm)') }}</label><input type="number" min="0" max="50" v-model.number="print.margins.b"></div>
          <div class="cb-field"><label>{{ t('Margin left (mm)') }}</label><input type="number" min="0" max="50" v-model.number="print.margins.l"></div>
        </div>
        <label class="opt"><input type="checkbox" v-model="print.grid"> {{ t('Print the gridlines') }}</label>
        <label class="opt"><input type="checkbox" v-model="print.header"> {{ t('Repeat the first row on every page') }}</label>
        <label class="opt"><input type="checkbox" v-model="print.fit"> {{ t('Fit the columns to the width of the page') }}</label>
        <label class="opt"><input type="checkbox" v-model="print.headings"> {{ t('Print the row numbers and column letters') }}</label>
        <p class="cb-tip">{{ t('The browser’s print dialogue opens next; choose “Save as PDF” there for a PDF.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn" @click="printOpen = false">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="doPrint">{{ t('Print') }}</button>
      </div>
    </div>
  </div>

  <!-- the versions kept beside a book -->
  <div v-if="vers.open" class="cb-modal-back" @click="vers.open = false">
    <div class="cb-modal" style="width:min(560px,100%)" @click.stop>
      <h3>{{ t('Versions of “{name}”', { name: vers.title }) }}</h3>
      <div class="body">
        <p class="cb-tip" v-if="!vers.list.length">{{ t('None yet. One is kept each time the book is saved, if versions are switched on in the settings.') }}</p>
        <ol class="cb-versions" v-else>
          <li v-for="v in vers.list" :key="v.number">
            <span class="no">#{{ String(v.number).padStart(2, '0') }}</span>
            <span class="when">{{ when(v.mtime) }}</span>
            <span class="sz">{{ size(v.size) }}</span>
            <button class="cb-btn ghost" @click="previewVersion(v.number)">{{ t('Look') }}</button>
            <button class="cb-btn ghost" @click="restoreVersion(v.number)" :disabled="book.readOnly">{{ t('Put this one back') }}</button>
          </li>
        </ol>
        <div class="cb-verview" v-if="vers.preview" v-html="vers.preview"></div>
        <p class="cb-tip">{{ t('Putting a version back keeps what is there now as #01 first, so it can be undone the same way. The version files sit beside the book in your Files and can be opened there like any other page.') }}</p>
      </div>
      <div class="foot"><button class="cb-btn primary" @click="vers.open = false">{{ t('Done') }}</button></div>
    </div>
  </div>

  <!-- the file itself -->
  <div v-if="htmlOpen" class="cb-modal-back" @click="htmlOpen = false">
    <div class="cb-modal" style="width:min(860px,100%)" @click.stop>
      <h3>&lt;/&gt; {{ t('View the HTML') }}</h3>
      <div class="body">
        <p class="cb-tip">{{ t('This is exactly what is stored in Files — one file, styles included, nothing else needed to open it.') }}</p>
        <textarea rows="18" spellcheck="false" readonly :value="htmlText" style="width:100%;font-family:monospace;font-size:12px"></textarea>
      </div>
      <div class="foot"><button class="cb-btn primary" @click="htmlOpen = false">{{ t('Close') }}</button></div>
    </div>
  </div>

  <!-- a question with one answer: a name, a number -->
  <div v-if="ask.open" class="cb-modal-back" @click="askAnswer(null)">
    <div class="cb-modal" style="width:min(420px,100%)" @click.stop>
      <h3>{{ ask.title }}</h3>
      <div class="body">
        <div class="cb-field"><label v-if="ask.label">{{ ask.label }}</label>
          <input ref="askInput" :type="ask.number ? 'number' : 'text'" v-model="ask.value" :min="ask.min" :max="ask.max" @keydown.enter.prevent="askAnswer(ask.value)" @keydown.esc.prevent="askAnswer(null)"></div>
        <p class="cb-tip" v-if="ask.tip">{{ ask.tip }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn" @click="askAnswer(null)">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="askAnswer(ask.value)">{{ t('OK') }}</button>
      </div>
    </div>
  </div>

  <!-- the Files picker: a folder to move to, or a file to import -->
  <div v-if="picker.open" class="cb-modal-back" @click="pickerAnswer(null)">
    <div class="cb-modal" @click.stop>
      <h3>{{ picker.mode === 'import' ? t('Import a CSV, ODS or XLSX file') : t('Choose a folder') }}</h3>
      <div class="body">
        <div class="fp-path">
          <button class="cb-tb" @click="pickerUp" :disabled="!picker.path" :title="t('Up')"><span v-html="icons.up"></span></button>
          <span class="crumbs">{{ picker.path || '/' }}</span>
        </div>
        <div class="fp-list">
          <p class="cb-tip" v-if="picker.busy" style="padding:10px">{{ t('Loading…') }}</p>
          <template v-else>
            <button v-for="it in picker.items" :key="it.path" class="fp-item" :class="{ on: picker.chosen === it.path, dim: picker.mode === 'import' && !it.dir && !it.ok }"
              @click="pickerClick(it)" @dblclick="pickerOpen(it)">
              <span class="ic" v-html="it.dir ? icons.folder : icons.doc"></span>
              <span class="nm">{{ it.name }}</span>
              <span class="meta" v-if="!it.dir">{{ size(it.size) }}</span>
            </button>
            <p class="cb-tip" v-if="!picker.items.length" style="padding:10px">{{ t('Nothing here.') }}</p>
          </template>
        </div>
        <p class="cb-tip" v-if="picker.mode === 'import'">{{ t('The file is only read. A new book is made from it in your save folder, and the file itself stays as it was.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn" @click="pickerAnswer(null)">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="pickerAnswer(picker.mode === 'import' ? picker.chosen : (picker.chosen || picker.path))" :disabled="picker.mode === 'import' && !picker.chosen">{{ picker.mode === 'import' ? t('Import') : t('Choose this folder') }}</button>
      </div>
    </div>
  </div>

  <!-- export -->
  <div v-if="exportOpen" class="cb-modal-back" @click="exportOpen = false">
    <div class="cb-modal" style="width:min(460px,100%)" @click.stop>
      <h3>{{ t('Export') }}</h3>
      <div class="body">
        <div class="cb-field"><label>{{ t('Format') }}</label>
          <select v-model="exportFmt"><option value="xlsx">Excel (.xlsx)</option><option value="ods">LibreOffice Calc (.ods)</option><option value="csv">CSV ({{ t('the active sheet') }})</option></select></div>
        <p class="cb-tip">{{ t('The file is written next to the book in your Files, under the book’s name. Formulas, values, number formats, the styles above, widths and merges are kept in ODS and XLSX.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn" @click="exportOpen = false">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="doExport" :disabled="exporting">{{ exporting ? t('Writing…') : t('Export') }}</button>
      </div>
    </div>
  </div>

  <!-- the autofilter's list of values -->
  <div v-if="filterPop.open" class="cb-ctx-back" @mousedown="filterPop.open = false"></div>
  <div v-if="filterPop.open" class="cb-filterpop" :style="{ left: filterPop.x + 'px', top: filterPop.y + 'px' }">
    <label class="opt" style="margin:0"><input type="checkbox" :checked="filterAllChecked" @change="filterCheckAll($event.target.checked)"> <b>{{ t('Select all') }}</b></label>
    <div class="list">
      <label v-for="v in filterPop.values" :key="v" class="it"><input type="checkbox" :checked="filterPop.checked.has(v)" @change="filterCheck(v, $event.target.checked)"> {{ v === '' ? t('(empty)') : v }}</label>
    </div>
    <div class="acts">
      <button class="cb-btn ghost" @click="filterPop.open = false">{{ t('Cancel') }}</button>
      <button class="cb-btn primary" @click="applyFilterPop">{{ t('OK') }}</button>
    </div>
  </div>

  <!-- the right button: the app's own menu, never the browser's -->
  <div v-if="ctx.open" class="cb-ctx-back" @mousedown.prevent @click="closeCtxIfSettled" @touchend.prevent="closeCtxIfSettled" @contextmenu.prevent="closeCtx"></div>
  <div v-if="ctx.open" class="cb-ctxmenu" :class="{ flip: ctx.flip, tall: ctx.tall }" :style="{ left: ctx.x + 'px', top: ctx.y + 'px', maxHeight: ctx.tall ? ctx.tall + 'px' : null }" @mousedown.prevent @contextmenu.prevent>
    <template v-if="ctx.kind === 'book'">
      <div class="hd">{{ ctx.book.title || ctx.book.name }}</div>
      <button class="ci" @click="closeCtx(); openBook(ctx.book.id)">{{ t('Open') }}</button>
      <div class="sep"></div>
      <button class="ci" @click="renameBook(ctx.book)">{{ t('Rename…') }}</button>
      <button class="ci" v-if="ctx.book.download !== false" @click="duplicateBook(ctx.book.id)">{{ t('Duplicate') }}</button>
      <button class="ci" v-if="!ctx.book.shared" @click="moveBook(ctx.book)">{{ t('Move to…') }}</button>
      <button class="ci" v-if="ctx.book.download !== false" @click="downloadBook(ctx.book)">{{ t('Download') }}</button>
      <button class="ci" @click="openVersions(ctx.book)">{{ t('Versions…') }}</button>
      <div class="sep"></div>
      <button class="ci danger" @click="deleteBook(ctx.book)">{{ t('Delete') }}</button>
    </template>
    <template v-else-if="ctx.kind === 'sheet'">
      <div class="hd">{{ sheetNames[ctx.sheet] }}</div>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); addSheet(ctx.sheet)">{{ t('Insert sheet before') }}</button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); addSheet(ctx.sheet + 1)">{{ t('Insert sheet after') }}</button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); startRenameSheet(ctx.sheet)">{{ t('Rename…') }}</button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); duplicateSheet(ctx.sheet)">{{ t('Duplicate') }}</button>
      <div class="sep"></div>
      <button class="ci" :disabled="book.readOnly || ctx.sheet === 0" @click="closeCtx(); moveSheet(ctx.sheet, -1)">{{ t('Move left') }}</button>
      <button class="ci" :disabled="book.readOnly || ctx.sheet >= sheetNames.length - 1" @click="closeCtx(); moveSheet(ctx.sheet, 1)">{{ t('Move right') }}</button>
      <div class="sep"></div>
      <button class="ci danger" :disabled="book.readOnly || sheetNames.length < 2" @click="closeCtx(); deleteSheet(ctx.sheet)">{{ t('Delete sheet') }}</button>
    </template>
    <template v-else-if="ctx.kind === 'col' || ctx.kind === 'row'">
      <div class="hd">{{ ctx.kind === 'col' ? t('Column {n}', { n: colLetter(ctx.col) }) : t('Row {n}', { n: ctx.row + 1 }) }}</div>
      <template v-if="ctx.kind === 'col'">
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); insertCols(0)">{{ t('Insert columns before') }}</button>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); insertCols(1)">{{ t('Insert columns after') }}</button>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); deleteCols()">{{ t('Delete columns') }}</button>
        <div class="sep"></div>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); askColWidth()">{{ t('Column width…') }}</button>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); fitCols()">{{ t('Optimal width') }}</button>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); hideCols(true)">{{ t('Hide these columns') }}</button>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); hideCols(false)">{{ t('Show hidden columns') }}</button>
      </template>
      <template v-else>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); insertRows(0)">{{ t('Insert rows above') }}</button>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); insertRows(1)">{{ t('Insert rows below') }}</button>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); deleteRows()">{{ t('Delete rows') }}</button>
        <div class="sep"></div>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); askRowHeight()">{{ t('Row height…') }}</button>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); fitRows()">{{ t('Optimal height') }}</button>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); hideRows(true)">{{ t('Hide these rows') }}</button>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); hideRows(false)">{{ t('Show hidden rows') }}</button>
      </template>
      <div class="sep"></div>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); clearCells('all')">{{ t('Clear contents') }}</button>
    </template>
    <template v-else-if="ctx.kind === 'field'">
      <button class="ci" @click="fieldCmd('cut')"><span>{{ t('Cut') }}</span><span class="s k">Ctrl+X</span></button>
      <button class="ci" @click="fieldCmd('copy')"><span>{{ t('Copy') }}</span><span class="s k">Ctrl+C</span></button>
      <button class="ci" @click="fieldCmd('paste')"><span>{{ t('Paste') }}</span><span class="s k">Ctrl+V</span></button>
    </template>
    <template v-else>
      <div class="hd">{{ selText }}</div>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); clipCut()"><span>{{ t('Cut') }}</span><span class="s k">Ctrl+X</span></button>
      <button class="ci" @click="closeCtx(); clipCopy()"><span>{{ t('Copy') }}</span><span class="s k">Ctrl+C</span></button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); clipPasteButton()"><span>{{ t('Paste') }}</span><span class="s k">Ctrl+V</span></button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); clipPasteButton('values')"><span>{{ t('Paste values only') }}</span><span class="s k">Ctrl+Shift+V</span></button>
      <div class="sep"></div>
      <div class="ci has-sub" @mouseenter="placeFly" @click="toggleFly">
        <span>{{ t('Insert') }}</span><span class="s">›</span>
        <div class="fly">
          <button class="ci" :disabled="book.readOnly" @click="closeCtx(); insertRows(0)">{{ t('Rows above') }}</button>
          <button class="ci" :disabled="book.readOnly" @click="closeCtx(); insertRows(1)">{{ t('Rows below') }}</button>
          <button class="ci" :disabled="book.readOnly" @click="closeCtx(); insertCols(0)">{{ t('Columns before') }}</button>
          <button class="ci" :disabled="book.readOnly" @click="closeCtx(); insertCols(1)">{{ t('Columns after') }}</button>
        </div>
      </div>
      <div class="ci has-sub" @mouseenter="placeFly" @click="toggleFly">
        <span>{{ t('Delete') }}</span><span class="s">›</span>
        <div class="fly">
          <button class="ci" :disabled="book.readOnly" @click="closeCtx(); deleteRows()">{{ t('Rows') }}</button>
          <button class="ci" :disabled="book.readOnly" @click="closeCtx(); deleteCols()">{{ t('Columns') }}</button>
        </div>
      </div>
      <div class="ci has-sub" @mouseenter="placeFly" @click="toggleFly">
        <span>{{ t('Clear') }}</span><span class="s">›</span>
        <div class="fly">
          <button class="ci" :disabled="book.readOnly" @click="closeCtx(); clearCells('contents')"><span>{{ t('Contents') }}</span><span class="s k">Delete</span></button>
          <button class="ci" :disabled="book.readOnly" @click="closeCtx(); clearCells('formats')">{{ t('Formats') }}</button>
          <button class="ci" :disabled="book.readOnly" @click="closeCtx(); clearCells('all')">{{ t('Everything') }}</button>
        </div>
      </div>
      <div class="sep"></div>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); sortSel(1)">{{ t('Sort ascending') }}</button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); sortSel(-1)">{{ t('Sort descending') }}</button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); toggleMerge()">{{ selIsMerged ? t('Unmerge cells') : t('Merge cells') }}</button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); openCellProps('number')"><span>{{ t('Cell properties…') }}</span><span class="s k">Ctrl+1</span></button>
      <template v-if="ai.show">
        <div class="sep"></div>
        <button class="ci" @click="closeCtx(); aiAskAboutCell()">🤖 {{ t('Ask the assistant about this cell') }}</button>
      </template>
    </template>
  </div>

  <div class="cb-toast" v-if="toast">{{ toast }}</div>
</div>
`;

  const PALETTE = ['#000000', '#444444', '#777777', '#aaaaaa', '#dddddd', '#ffffff', '#ffff00', '#ffd966',
    '#f4b183', '#ff0000', '#c00000', '#7030a0', '#0070c0', '#00b0f0', '#00b050', '#92d050',
    '#fff2cc', '#fce4d6', '#ffc7ce', '#e2efda', '#ddebf7', '#ede7f6', '#d9d9d9', '#bdd7ee'];
  const FONTS = ['Noto Sans JP', 'Noto Serif JP', 'Hiragino Sans', 'Meiryo', 'Yu Gothic', 'MS PGothic', 'MS PMincho', 'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New', 'Roboto', 'Segoe UI'];
  const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];

  const app = createApp({
    template: TEMPLATE,
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
