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
  const tCache = new Map();
  function T(text, vars) {
    if (i18nOverride) {
      return subst(i18nOverride[text] != null ? i18nOverride[text] : text, vars);
    }
    if (vars == null) { const hit = tCache.get(text); if (hit !== undefined) { return hit; } }
    try {
      if (typeof window.t === 'function') {
        const out = window.t('calcbase', text, vars, undefined, { escape: false });
        // kept only once the app's words are there (or the page is in English, where a word is itself)
        if (vars == null && (out !== text || (window._oc_l10n_registry_translations && window._oc_l10n_registry_translations.calcbase) || /^en\b/i.test(document.documentElement.lang || ''))) { tCache.set(text, out); }
        return out;
      }
    } catch (e) { /* fall through to the raw key */ }
    return subst(text, vars);
  }
  function uiLang() {
    if (i18nOverride && i18nOverride.__lang) { return i18nOverride.__lang; }
    try { if (window.OC && OC.getLanguage) { return String(OC.getLanguage() || 'en').slice(0, 2); } } catch (e) { /* no OC */ }
    return String(document.documentElement.lang || navigator.language || 'en').slice(0, 2);
  }

  // ---- server ---------------------------------------------------------------
  async function api(path, opts, retried, attempt) {
    const method = (opts || {}).method || 'GET';
    // A reading (GET) the server could not answer for a moment -- 502/503/504, or the connection
    // dropped, as when the server's PHP is reloaded -- is asked again, twice at most: opening a book
    // otherwise stopped at "Could not open the book" until the page was reloaded by hand. A writing
    // is not repeated (it may have been done).
    const again = async () => { await new Promise((r) => setTimeout(r, 700 * ((attempt || 0) + 1))); return api(path, opts, retried, (attempt || 0) + 1); };
    let res;
    try {
      res = await fetch(BASE + 'api/' + path, {
        credentials: 'same-origin',
        headers: Object.assign({ 'Content-Type': 'application/json', requesttoken: requestToken() }, (opts || {}).headers || {}),
        method,
        body: (opts || {}).body != null ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      if (method === 'GET' && (attempt || 0) < 2) { return again(); }
      throw e;
    }
    if (method === 'GET' && (res.status === 502 || res.status === 503 || res.status === 504) && (attempt || 0) < 2) { return again(); }
    if (res.status === 412 && !retried) {
      let renewed = false;
      try { await renewToken(); renewed = true; } catch (e) { /* answered below as it was */ }
      if (renewed) { return api(path, opts, true, attempt); }
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
    [/^a sheet may have at most (\d+) rows$/, 'A sheet can have at most {n} rows. Large amounts of data belong in a database, not in a spreadsheet. The limit can be raised in the settings, at your own risk.'],
    [/^a workbook may have at most (\d+) cells$/, 'A book can hold at most {n} cells. Large amounts of data belong in a database, not in a spreadsheet. The limit can be raised in the settings, at your own risk.'],
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
  // CalcBase is for the tables people keep by hand, not for bulk data (owner, 2026-10-06). A book holds
  // 100,000 cells unless the writer chooses more in the settings, at their own risk; while there is a limit a
  // sheet also stops at row 30,000 and a file at 24 MB, as EditBase's. "No limit" (0) lifts all three. The
  // server keeps the same (Model::CELL_LIMITS, BookService::limits). A reference still reaches the whole sheet.
  const CELL_LIMITS = [100000, 300000, 600000, 0];
  let LIMIT_CELLS = 100000;
  let LIMIT_ROWS = 30000;
  let LIMIT_BYTES = 24 * 1024 * 1024;
  function applyLimits(cells) {
    const n = CELL_LIMITS.includes(Number(cells)) ? Number(cells) : 100000;
    LIMIT_CELLS = n || Infinity;
    LIMIT_ROWS = n ? 30000 : MAX_ROWS;
    LIMIT_BYTES = n ? 24 * 1024 * 1024 : Infinity;
  }
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
    return { name, cols: new Map(), rows: new Map(), meta: new Map(), merges: [], freeze: null, grid: true, maxR: 0, maxC: 0, filter: null, images: [] };
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
    // quoted, and with the generic family behind it: a name with a figure in it ("Source Sans 3") is
    // not valid CSS unquoted and the browser threw the whole declaration away, and a face that is not
    // there fell back to the browser's serif rather than to its own kind
    if (s.font && cleanFamily(s.font)) { out.push('font-family:"' + cleanFamily(s.font) + '", ' + genericOf(s.font)); }
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
      else if (k === 'text-align' && /^(left|center|right|justify)$/.test(v)) { s.ha = v; }
      else if (k === 'vertical-align' && /^(top|middle|bottom)$/.test(v)) { s.va = v; }
      else if (k === 'white-space' && v === 'normal') { s.wrap = 1; }
      else if (k === 'font-family') { const first = cleanFamily(v.split(',')[0]); if (first && !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|inherit|initial)$/i.test(first)) { s.font = first; } }
      else if (k === 'font-size') { const m = /^([\d.]+)pt$/.exec(v); if (m) { s.size = Number(m[1]); } else { const px = /^([\d.]+)px$/.exec(v); if (px) { s.size = Math.round(Number(px[1]) * 0.75 * 2) / 2; } } }
      else if (k === 'border-top') { s.bt = v; } else if (k === 'border-right') { s.br = v; } else if (k === 'border-bottom') { s.bb = v; } else if (k === 'border-left') { s.bl = v; }
      else if (k === 'border') { s.bt = s.br = s.bb = s.bl = v; }
    });
    return Object.keys(s).length ? s : null;
  }
  const isEmptyObj = (o) => !o || !Object.keys(o).length;
  // What a formula's result wants to look like, when the cell has no format of
  // its own (the engine's fmtHint): a date for DATE(), a time, a percentage.
  // Calc ja-JP's own for each kind (measured: =DATE(…) shows 1月2日, =NOW() 2026/10/6 19:18, =PMT(…) -￥89 in red,
  // two times added [HH]:MM:SS), the same codes the engine gives typed dates, times and amounts.
  const HINT_FMT = { date: 'm"月"d"日"', time: 'hh:mm:ss', datetime: 'yyyy/m/d h:mm', duration: '[hh]:mm:ss', percent: '0%', currency: '[$￥-411]#,##0;[RED]-[$￥-411]#,##0' };
  /** The format a cell is shown in: set by the person ('General' means none, on purpose), kept by the engine from the typed text, or hinted by the formula. */
  function fmtOf(meta, g) {
    const own = meta && meta.fmt;
    if (own === 'General') { return ''; }
    if (own) { return own; }
    if (g && g.fmt) { return g.fmt; }
    // a reference keeps the format of the cell it reads (Calc: =B1 shows B1 as B1 does)
    if (g && g.fmtHintCode) { return g.fmtHintCode; }
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
    '.cb-sheet td a{color:#1d4ed8}',
    // a comment: the red corner Calc and Excel draw, and the words as the cell's title
    '.cb-sheet td[data-note]{position:relative}',
    '.cb-sheet td[data-note]::after{content:"";position:absolute;right:0;top:0;border-style:solid;border-width:0 6px 6px 0;border-color:transparent #d32f2f transparent transparent}',
    // pictures stand over the table, where they were put
    '.cb-area{position:relative;width:max-content}',
    '.cb-pic{position:absolute;display:block}',
    '.cb-sheet tr[style*="height:0px"]{display:none}',
    '@media print{body.cb-book{margin:0}.cb-sheet{margin:0}h2.cb-sheet-name{display:none}.cb-sheet td[data-note]::after{display:none}}',
  ].join('\n');
  // most cells have nothing to escape: the test first keeps a 100,000-row save from making four copies of every string
  const esc = (s) => { const t = String(s == null ? '' : s); return /[&<>"]/.test(t) ? t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : t; };
  const VERSION_FOR_FILE = () => (document.getElementById('calcbase-root') || { dataset: {} }).dataset.version || '0.0.1';
  /** A link a cell may carry: the web, mail, the telephone. Anything else is not written or read. */
  const safeLink = (u) => (/^(https?:\/\/|mailto:|tel:)[^\s"<>]{1,2040}$/i.test(String(u || '').trim()) ? String(u).trim() : '');
  /** The link an address typed into a cell makes (Calc's URL recognition): the whole entry is the address, nothing else. */
  function autoLinkOf(text) {
    const t = String(text || '').trim();
    if (!t || t !== String(text) || /\s/.test(t) || t.charAt(0) === '=' || t.charAt(0) === "'") { return ''; }
    if (/^(https?:\/\/|mailto:)/i.test(t)) { return safeLink(t); }
    if (/^www\.[^.\s]+\.[^\s]+$/i.test(t)) { return safeLink('https://' + t); }
    if (/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(t)) { return safeLink('mailto:' + t); }
    return '';
  }
  // Cropping without cutting the picture (EditBase's): the frame is given a shape, the picture fills
  // it, and which part of it shows is a position. Nothing is lost -- the whole picture is still in the
  // file and the crop can be changed or undone at any time.
  const CROP_RATIOS = ['', '1 / 1', '4 / 3', '3 / 2', '16 / 9', '3 / 4', '2 / 3'];
  const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  /** A picture's crop, when it has one that can be trusted. */
  function cropOfImage(im) {
    const c = im && im.crop;
    if (!c || CROP_RATIOS.indexOf(c.ratio) <= 0) { return null; }
    return { ratio: c.ratio, x: clampPct(c.x == null ? 50 : c.x), y: clampPct(c.y == null ? 50 : c.y) };
  }
  /** The width over the height of a crop's shape ("4 / 3" → 1.333). */
  function ratioValue(r) { const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(r || '')); return m ? Number(m[1]) / Number(m[2]) : 0; }
  /** A picture may be drawn from a data: URL; it is read without hanging on one that will not decode (EditBase's). */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const timer = setTimeout(() => reject(new Error('image timed out')), 8000);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); reject(new Error('image could not be read')); };
      img.src = src;
    });
  }
  /** How much of a picture is see-through, as a share of it (EditBase's: counted, not merely spotted). */
  function transparentShare(ctx, w, h) {
    try {
      const data = ctx.getImageData(0, 0, w, h).data;
      let clear = 0; let seen = 0;
      for (let i = 3; i < data.length; i += 4) { seen += 1; if (data[i] < 250) { clear += 1; } }
      return seen ? clear / seen : 0;
    } catch (e) { return 1; }   // tainted or refused: assume it has, and keep PNG
  }
  function hasTransparency(ctx, w, h) { return transparentShare(ctx, w, h) > 0.005; }
  /** How many different colours a picture holds, sampled on a grid: a photograph has thousands, a drawing a few hundred. */
  function colourCount(ctx, w, h) {
    const seen = new Set();
    const step = Math.max(1, Math.round(Math.sqrt((w * h) / 4096)));
    let data;
    try { data = ctx.getImageData(0, 0, w, h).data; } catch (e) { return 0; }
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        if (seen.size > 20000) { return seen.size; }
      }
    }
    return seen.size;
  }
  /**
   * A picture made as light as it can be without being seen to change (EditBase's shrinkImage): brought
   * down to a size a printed page can use, and a photograph kept as a photograph (JPEG) -- a photograph
   * saved as PNG is ten times the weight. Line art and screenshots stay PNG unless JPEG is far smaller,
   * because JPEG smears writing. Answers the lighter of the two, or the picture as it came.
   */
  async function lightenImage(dataUrl, maxEdge) {
    const limit = maxEdge || 2200;
    const mime = (/^data:([^;,]+)/.exec(dataUrl) || [])[1] || '';
    if (!/^data:/.test(dataUrl) || mime === 'image/svg+xml' || mime === 'image/gif') { return dataUrl; }
    let img;
    try { img = await loadImage(dataUrl); } catch (e) { return dataUrl; }
    const w0 = img.naturalWidth || img.width; const h0 = img.naturalHeight || img.height;
    const scale = Math.max(w0, h0) > limit ? limit / Math.max(w0, h0) : 1;
    const cv = document.createElement('canvas');
    cv.width = Math.round(w0 * scale); cv.height = Math.round(h0 * scale);
    if (!cv.width || !cv.height) { return dataUrl; }
    const ctx = cv.getContext('2d');
    if (!ctx) { return dataUrl; }
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const png = scale < 1 ? cv.toDataURL('image/png') : dataUrl;
    let best = png.length < dataUrl.length ? png : dataUrl;
    if (!hasTransparency(ctx, cv.width, cv.height)) {
      const photo = colourCount(ctx, cv.width, cv.height) > 4000;
      const jpeg = cv.toDataURL('image/jpeg', photo ? 0.85 : 0.92);
      const allow = best.length * (photo ? 0.95 : 0.6);
      if (jpeg.length && jpeg.length < allow) { best = jpeg; }
    }
    return best;
  }
  /** A picture a book may carry: one embedded in it, or one on the web. */
  const safeImage = (u) => (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(String(u || '')) || /^https:\/\/[^\s"<>]+$/i.test(String(u || '')) ? String(u).replace(/\s+/g, '') : '');
  /** JSON put into an attribute, and read back without trusting it. */
  const readJson = (s, d) => { if (!s) { return d; } try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : d; } catch (e) { return d; } };

  // ---- the paper: kept in the book, so the file prints the same way anywhere ----
  const PAPERS = { A3: { w: 297, h: 420 }, A4: { w: 210, h: 297 }, A5: { w: 148, h: 210 }, B4: { w: 257, h: 364 }, B5: { w: 182, h: 257 }, Letter: { w: 215.9, h: 279.4 }, Legal: { w: 215.9, h: 355.6 } };
  const MM = 96 / 25.4;   // CSS pixels in a millimetre
  /** CSS pixels in one of each unit a width or a height can be asked in (EditBase's units for the ruler; Calc's measurement unit). */
  const UNITS = { px: 1, pt: 96 / 72, mm: MM, cm: MM * 10, in: 96 };
  const RUN_TOKENS = ['page', 'pages', 'sheet', 'title', 'name', 'date', 'time'];
  function defaultPaper() {
    return { size: 'A4', orientation: 'portrait', margin: { top: 15, bottom: 15, left: 15, right: 15 },
      header: { l: '', c: '', r: '' }, footer: { l: '', c: '{page} / {pages}', r: '' },
      scale: 'fit', wide: 1, tall: 1, grid: true, headings: false, repeat: 0 };
  }
  /** A paper setup with every field there and in range, whatever it was read from. */
  function normalisePaper(p) {
    const d = defaultPaper(); const o = p && typeof p === 'object' ? p : {};
    const num = (v, lo, hi, def) => { const n = Number(v); return v === '' || v == null || !isFinite(n) ? def : Math.max(lo, Math.min(hi, n)); };
    const slots = (x, def) => { const out = {}; ['l', 'c', 'r'].forEach((k) => { out[k] = x && typeof x === 'object' && typeof x[k] === 'string' ? x[k].slice(0, 120) : def[k]; }); return out; };
    const m = o.margin && typeof o.margin === 'object' ? o.margin : {};
    return {
      size: PAPERS[o.size] ? o.size : d.size,
      orientation: o.orientation === 'landscape' ? 'landscape' : 'portrait',
      margin: { top: num(m.top, 0, 100, d.margin.top), bottom: num(m.bottom, 0, 100, d.margin.bottom), left: num(m.left, 0, 100, d.margin.left), right: num(m.right, 0, 100, d.margin.right) },
      header: slots(o.header, d.header), footer: slots(o.footer, d.footer),
      scale: ['none', 'fit', 'pages'].indexOf(o.scale) >= 0 ? o.scale : d.scale,
      wide: Math.round(num(o.wide, 1, 50, 1)), tall: Math.round(num(o.tall, 1, 500, 1)),
      grid: o.grid == null ? d.grid : !!o.grid, headings: !!o.headings, repeat: Math.round(num(o.repeat, 0, 20, d.repeat)),
    };
  }
  /** The paper's printable width and height in millimetres. */
  function printable(p) {
    const n = normalisePaper(p); const paper = PAPERS[n.size];
    const w = n.orientation === 'landscape' ? paper.h : paper.w; const h = n.orientation === 'landscape' ? paper.w : paper.h;
    return { w: w - n.margin.left - n.margin.right, h: h - n.margin.top - n.margin.bottom, pw: w, ph: h };
  }
  /** The text of a header or footer slot with what is known before printing filled in ({page} and {pages} are the printer's). */
  function runText(tpl, vars) {
    return String(tpl || '').replace(/\{(sheet|title|name|date|time)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  }
  /** A running band's words as the content of a margin box: the page numbers are the printer's own counters (as EditBase). */
  function cssContent(text) {
    const bits = [];
    String(text).split(/(\{page\}|\{pages\})/).forEach((piece) => {
      if (!piece) { return; }
      if (piece === '{page}') { bits.push('counter(page)'); return; }
      if (piece === '{pages}') { bits.push('counter(pages)'); return; }
      // The words stand inside <style>: "<" is written as its CSS escape so they cannot close it.
      bits.push('"' + piece.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\3c ').replace(/\r?\n|\r/g, '\\a ') + '"');
    });
    return bits.length ? bits.join(' ') : '""';
  }
  /**
   * The @page rules: the paper and its margins, and the header and footer as the
   * page's margin boxes, one named page per sheet so that {sheet} is the sheet
   * the page belongs to. `sel` is the selector of the elements each sheet's
   * pages are made of (the sections of a saved book, the page tables of a printout).
   */
  function pageCss(p, about, sheets, sel) {
    const n = normalisePaper(p); const paper = PAPERS[n.size];
    const size = n.orientation === 'landscape' ? paper.h + 'mm ' + paper.w + 'mm' : paper.w + 'mm ' + paper.h + 'mm';
    const out = ['@page{size:' + size + ';margin:' + n.margin.top + 'mm ' + n.margin.right + 'mm ' + n.margin.bottom + 'mm ' + n.margin.left + 'mm}'];
    const zones = { l: 'left', c: 'center', r: 'right' };
    const boxes = (sheet) => {
      const rules = [];
      [['top', n.header], ['bottom', n.footer]].forEach(([side, slots]) => {
        Object.keys(zones).forEach((k) => {
          const text = runText(slots[k], Object.assign({}, about, { sheet }));
          if (!text) { return; }
          rules.push('@' + side + '-' + zones[k] + '{content:' + cssContent(text) + ';font-size:9pt;color:#444;vertical-align:' + (side === 'top' ? 'bottom' : 'top') + ';padding-' + (side === 'top' ? 'bottom' : 'top') + ':3mm}');
        });
      });
      return rules.join('');
    };
    (sheets || []).forEach((name, i) => {
      const b = boxes(name);
      if (!b) { return; }
      out.push(sel(i) + '{page:cbs' + i + '}');
      out.push('@page cbs' + i + '{' + b + '}');
    });
    return out.join('\n');
  }
  /**
   * Where the pages fall: the rows and columns of a range cut into pages by the
   * paper, the margins and the scaling -- down first, then across, as Calc
   * prints. Sizes in CSS pixels of the sheet at 100%.
   */
  function paginate(sh, g, p) {
    const n = normalisePaper(p); const room = printable(n);
    const headW = n.headings ? 34 : 0; const headH = n.headings ? 18 : 0;
    const repeat = Math.max(0, Math.min(n.repeat, g.r1 - g.r0));
    let repeatH = headH; for (let r = g.r0; r < g.r0 + repeat; r += 1) { repeatH += rowH(sh, r); }
    let totalW = headW; for (let c = g.c0; c <= g.c1; c += 1) { totalW += colW(sh, c); }
    let totalH = repeatH; for (let r = g.r0 + repeat; r <= g.r1; r += 1) { totalH += rowH(sh, r); }
    // Calc prints at 100 % and "fit to width" only ever shrinks a sheet wider than the paper; the scale is the
    // paper's own width over the sheet's (a hair under, for the browser's rounding), and a row that is a pixel
    // too tall must not push a page of its own
    const pageW = room.w * MM; const pageH = room.h * MM * 0.985;
    let scale = 1;
    if (n.scale === 'fit') { scale = Math.min(1, (pageW * 0.999) / Math.max(1, totalW)); }
    else if (n.scale === 'pages') { scale = Math.min(1, (pageW * 0.999 * n.wide) / Math.max(1, totalW), (pageH * n.tall) / Math.max(1, totalH)); }
    scale = Math.max(0.1, scale);
    const roomW = pageW / scale - headW; const roomH = pageH / scale - repeatH;
    const bands = []; let c0 = g.c0; let acc = 0;
    for (let c = g.c0; c <= g.c1; c += 1) {
      const w = colW(sh, c);
      if (acc + w > roomW + 0.01 && c > c0) { bands.push({ c0, c1: c - 1 }); c0 = c; acc = 0; }
      acc += w;
    }
    bands.push({ c0, c1: g.c1 });
    const strips = []; let r0 = g.r0 + repeat; acc = 0;
    for (let r = g.r0 + repeat; r <= g.r1; r += 1) {
      const h = rowH(sh, r);
      if (h > 0 && acc + h > roomH && r > r0) { strips.push({ r0, r1: r - 1 }); r0 = r; acc = 0; }
      acc += h;
    }
    if (r0 <= g.r1 || !strips.length) { strips.push({ r0, r1: g.r1 }); }
    const pages = [];
    bands.forEach((b) => { strips.forEach((s) => { pages.push({ c0: b.c0, c1: b.c1, r0: s.r0, r1: s.r1 }); }); });
    return { pages, bands, strips, scale, repeat, headW, headH };
  }

  // ---- the named cell styles (LibreOffice Calc's 「セルスタイル」) ---------------
  // A style is a set of formats with a name. The formats are written on the cell
  // itself (so any browser shows them), and the name beside them (data-style), so
  // that changing the style changes every cell that carries it.
  const NAMED_STYLES = [
    { key: 'Heading 1', s: { b: 1, size: 16 } },
    { key: 'Heading 2', s: { b: 1, size: 13 } },
    { key: 'Heading', s: { b: 1, bb: '2px solid #333333' } },
    { key: 'Total', s: { b: 1, bt: '1px solid #333333', bb: '3px double #333333' } },
    { key: 'Note', s: { bg: '#ffffcc', color: '#333333', bt: '1px solid #808080', br: '1px solid #808080', bb: '1px solid #808080', bl: '1px solid #808080' } },
    { key: 'Good', s: { bg: '#ccffcc', color: '#006600' } },
    { key: 'Neutral', s: { bg: '#ffffcc', color: '#996600' } },
    { key: 'Bad', s: { bg: '#ffcccc', color: '#cc0000' } },
    { key: 'Warning', s: { color: '#cc0000', b: 1 } },
    { key: 'Accent', s: { b: 1, bg: '#2563eb', color: '#ffffff' } },
  ];
  /** A named style's formats: the book's own version, or the one it is shipped with. */
  function styleDef(styles, key) {
    const own = styles && styles[key];
    if (own && typeof own === 'object') { return Object.assign({}, own); }
    const def = NAMED_STYLES.find((x) => x.key === key);
    return def ? Object.assign({}, def.s) : {};
  }

  /**
   * The whole book as the file: one <section> per sheet, a dense table over the
   * used range, each cell saying what it shows and (in attributes) what it is.
   * `read(sheetName, r, c)` is the engine's cell; `uis` the sheets as the page
   * keeps them; `book` what belongs to the book as a whole (paper, names, styles).
   */
  function buildHtml(title, uis, read, active, lang, book) {
    const bk = book || {};
    const paper = normalisePaper(bk.paper);
    const out = [];
    const about = { title, name: title + '.html', date: '', time: '' };
    // The book's typefaces, as EditBase writes a document's: the faces its cells are set in, by name, and
    // the one stylesheet of Google Fonts that brings them, so the file looks the same on any machine.
    const fonts = normaliseFonts(bk.fonts);
    const bodyFont = bk.bodyFont || fonts.body || defaultCellFont(lang);
    const headFont = bk.headingFont || fonts.heading || bodyFont;
    const fontCssText = 'body.cb-book{font-family:' + fontStack(bodyFont, 'sans') + '}' +
      (headFont !== bodyFont ? '\n' + HEADING_STYLES.map((k) => '.cb-sheet td[data-style="' + k + '"]').join(',') + '{font-family:' + fontStack(headFont, 'sans') + '}' : '');
    const head = headTags(bk.head);
    const links = fontLinksHtml(bk.fontUrl != null ? bk.fontUrl : fontsUrl([bodyFont, headFont]));
    out.push('<!DOCTYPE html>', '<html lang="' + esc(lang || 'ja') + '">', '<head>', '<meta charset="utf-8">',
      '<meta name="generator" content="CalcBase ' + esc(VERSION_FOR_FILE()) + '">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>' + esc(bk.title || title) + '</title>');
    if (head) { out.push(head); }
    if (links) { out.push(links); }
    out.push('<style id="cb-style">' + BOOK_CSS + '\n' + fontCssText + '</style>',
      '<style id="cb-page">' + pageCss(paper, about, uis.map((u) => u.name), (i) => 'section.cb-sheet:nth-of-type(' + (i + 1) + ')') + '</style>', '</head>');
    const bodyAttrs = [' class="cb-book"', ' data-active="' + (active | 0) + '"', ' data-paper="' + esc(JSON.stringify(paper)) + '"'];
    if (fonts.body || fonts.heading) { bodyAttrs.push(' data-fonts="' + esc(JSON.stringify(fonts)) + '"'); }
    const names = bk.names && Object.keys(bk.names).length ? bk.names : null;
    if (names) { bodyAttrs.push(' data-names="' + esc(JSON.stringify(names)) + '"'); }
    const styles = bk.styles && Object.keys(bk.styles).length ? bk.styles : null;
    if (styles) { bodyAttrs.push(' data-styles="' + esc(JSON.stringify(styles)) + '"'); }
    // a document's own calculation settings (regular expressions, not case-sensitive) when not a new document's
    if (bk.calc && (bk.calc.regex || bk.calc.caseSensitive === false || Number.isInteger(bk.calc.decimals))) { bodyAttrs.push(' data-calc="' + esc(JSON.stringify(bk.calc)) + '"'); }
    out.push('<body' + bodyAttrs.join('') + '>');
    uis.forEach((sh) => {
      const used = usedRange(sh, read);
      const attrs = [' data-name="' + esc(sh.name) + '"'];
      if (sh.freeze && (sh.freeze.r || sh.freeze.c)) { attrs.push(' data-freeze="' + refName(sh.freeze.r, sh.freeze.c) + '"'); }
      attrs.push(' data-grid="' + (sh.grid === false ? 0 : 1) + '"');
      // the sheet's own names (a name an ODS or XLSX file gives one sheet only)
      const own = read.names ? read.names(sh.name) : null;
      if (own && Object.keys(own).length) { attrs.push(' data-names="' + esc(JSON.stringify(own)) + '"'); }
      const pics = (sh.images || []).filter((im) => safeImage(im.src));
      out.push('<section class="cb-sheet"' + attrs.join('') + '>', '<h2 class="cb-sheet-name">' + esc(sh.name) + '</h2>');
      if (pics.length) { out.push('<div class="cb-area">'); }
      out.push('<table>', '<colgroup>');
      for (let c = 0; c <= used.c1; c += 1) { out.push('<col style="width:' + colW(sh, c) + 'px">'); }
      out.push('</colgroup>', '<tbody>');
      // Cells hidden under a merge are left out, as HTML requires.
      const covered = new Set(); const anchors = new Map();
      sh.merges.forEach((m) => { anchors.set(K(m.r0, m.c0), m); for (let r = m.r0; r <= m.r1; r += 1) { for (let c = m.c0; c <= m.c1; c += 1) { if (r !== m.r0 || c !== m.c0) { covered.add(K(r, c)); } } } });
      for (let r = 0; r <= used.r1; r += 1) {
        const h = rowH(sh, r);
        const row = ['<tr' + (h !== DEF_ROW_H ? ' style="height:' + h + 'px"' : '') + '>'];
        for (let c = 0; c <= used.c1; c += 1) {
          const key = K(r, c);
          if (covered.has(key)) { continue; }
          const g = read(sh.name, r, c);
          const meta = sh.meta.get(key);
          const m = anchors.get(key);
          // an empty cell with nothing on it is the commonest of all in a big sheet
          if (!m && !meta && !(g && (g.t || g.f))) { row.push('<td></td>'); continue; }
          const a = [];
          if (m) {
            if (m.c1 > m.c0) { a.push(' colspan="' + (m.c1 - m.c0 + 1) + '"'); }
            if (m.r1 > m.r0) { a.push(' rowspan="' + (m.r1 - m.r0 + 1) + '"'); }
          }
          let text = '';
          const fmt = fmtOf(meta, g);
          if (g && g.t) {
            if (g.f) { a.push(' data-f="' + esc(g.f) + '"'); }
            // an array formula: its range on the cell that holds it (the others hold its values)
            if (g.f && g.a) { a.push(' data-a="' + esc(g.a) + '"'); }
            a.push(' data-t="' + g.t + '"');
            text = Calc.format(g.v, g.t, fmt, 'ja');
            if (g.t === 'n' && !fmt && read.font) {
              const cw = m ? colLeft(sh, m.c1 + 1) - colLeft(sh, m.c0) : colW(sh, c);
              text = fitNumber(text, g.v, cw - 2 * (CELL_MARGIN + NUM_GAP), read.font(meta));
            }
            if (g.t === 'n') { a.push(' data-v="' + esc(String(g.v)) + '"'); }
            else if (g.t === 'b') { a.push(' data-v="' + (g.v ? 'TRUE' : 'FALSE') + '"'); }
            else if (g.t === 's' && String(g.v) !== text) { a.push(' data-v="' + esc(g.v) + '"'); }
          }
          // General set on a formula's cell stays written: else the formula's own format (a date for
          // DATE()) would come back when the book is opened again (Calc keeps the cell's General)
          const fmtOut = fmt ? fmtForFile(fmt) : (meta && meta.fmt === 'General' && g && g.f && (g.fmtHint || g.fmtHintCode) ? 'General' : '');
          if (fmtOut) { a.push(' data-fmt="' + esc(fmtOut) + '"'); }
          if (meta && meta.style) { a.push(' data-style="' + esc(meta.style) + '"'); }
          if (meta && meta.note) { a.push(' data-note="' + esc(meta.note) + '" title="' + esc(meta.note) + '"'); }
          const css = meta ? styleToCss(meta.s) : '';
          if (css) { a.push(' style="' + esc(css) + '"'); }
          const link = meta && safeLink(meta.link);
          row.push('<td' + a.join('') + '>' + (link ? '<a href="' + esc(link) + '">' + esc(text) + '</a>' : esc(text)) + '</td>');
        }
        row.push('</tr>');
        out.push(row.join(''));
      }
      out.push('</tbody>', '</table>');
      if (pics.length) {
        pics.forEach((im) => {
          const left = colLeft(sh, im.c) + (im.dx | 0); const top = rowTop(sh, im.r) + (im.dy | 0);
          const cr = cropOfImage(im);
          out.push('<img class="cb-pic" src="' + esc(safeImage(im.src)) + '" alt="' + esc(im.alt || '') + '" data-cell="' + refName(im.r, im.c) + '" data-dx="' + (im.dx | 0) + '" data-dy="' + (im.dy | 0) +
            (cr ? '" data-crop="' + esc(cr.ratio) : '') +
            '" style="left:' + left + 'px;top:' + top + 'px;width:' + Math.round(im.w) + 'px;height:' + Math.round(im.h) + 'px' + (cr ? ';object-fit:cover;object-position:' + cr.x + '% ' + cr.y + '%' : '') + '">');
        });
        out.push('</div>');
      }
      out.push('</section>');
    });
    out.push('</body>', '</html>', '');
    return out.join('\n');
  }
  /** A1 to the last used row/column: the cells the engine holds, the styled cells, the merges. */
  function usedRange(sh, read) {
    let r1 = -1; let c1 = -1;
    const grow = (r, c) => { if (r > r1) { r1 = r; } if (c > c1) { c1 = c; } };
    if (read.used) { const u = read.used(sh.name); if (u) { grow(u.r1, u.c1); } }
    sh.meta.forEach((m, k) => { if (!isEmptyObj(m) && (m.fmt || !isEmptyObj(m.s) || m.note || m.link || m.style)) { grow(KR(k), KC(k)); } });
    sh.merges.forEach((m) => grow(m.r1, m.c1));
    if (r1 < 0) { r1 = 0; } if (c1 < 0) { c1 = 0; }
    return { r0: 0, c0: 0, r1, c1 };
  }
  /**
   * A file read back: attributes and text only, never inserted as HTML. Answers the
   * §3 model (for wb.load), the sheets as the page keeps them, and what belongs
   * to the book as a whole (its paper, names and cell styles).
   */
  function parseBook(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const uis = []; const model = { sheets: [], active: 0 };
    const body = doc.body;
    model.active = Number((body && body.getAttribute('data-active')) || 0) || 0;
    const title = doc.title || '';
    const book = {
      paper: normalisePaper(readJson(body && body.getAttribute('data-paper'), null)),
      hasPaper: !!(body && body.getAttribute('data-paper')),
      names: {}, styles: {},
      fonts: normaliseFonts(readJson(body && body.getAttribute('data-fonts'), null)),
      head: readHead(doc),
      lang: cleanLang(doc.documentElement && doc.documentElement.getAttribute('lang')),
      title: String(title || '').trim().slice(0, 300),
    };
    const names = readJson(body && body.getAttribute('data-names'), {});
    Object.keys(names).forEach((k) => { if (/^[A-Za-z_\u3040-\u30ff\u4e00-\u9fff][\w.\u3040-\u30ff\u4e00-\u9fff]{0,99}$/.test(k) && typeof names[k] === 'string') { book.names[k] = names[k].slice(0, 300); } });
    if (Object.keys(book.names).length) { model.names = Object.assign({}, book.names); }
    const calc = readJson(body && body.getAttribute('data-calc'), null);
    if (calc && typeof calc === 'object') {
      const dec = Number.isInteger(calc.decimals) && calc.decimals >= 0 && calc.decimals <= 20 ? calc.decimals : null;
      if (calc.regex === true || calc.caseSensitive === false || dec != null) { model.calc = Object.assign({}, calc.regex === true ? { regex: true } : {}, calc.caseSensitive === false ? { caseSensitive: false } : {}, dec != null ? { decimals: dec } : {}); }
    }
    const styles = readJson(body && body.getAttribute('data-styles'), {});
    Object.keys(styles).forEach((k) => { if (typeof k === 'string' && k.length <= 60 && styles[k] && typeof styles[k] === 'object') { const s = cssToStyle(styleToCss(styles[k])) || {}; if (styles[k].fmt && typeof styles[k].fmt === 'string') { s.fmt = styles[k].fmt.slice(0, 120); } book.styles[k] = s; } });
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
          const note = String(td.getAttribute('data-note') || '').slice(0, 5000);
          const anchor = td.querySelector('a[href]');
          const link = anchor ? safeLink(anchor.getAttribute('href')) : '';
          const style = String(td.getAttribute('data-style') || '').slice(0, 60);
          if (t || f) {
            const cell = {};
            if (f && f[0] === '=') { cell.f = f; const arr = td.getAttribute('data-a') || ''; if (/^\$?[A-Za-z]{1,3}\$?\d{1,7}(:\$?[A-Za-z]{1,3}\$?\d{1,7})?$/.test(arr)) { cell.a = arr.replace(/\$/g, '').toUpperCase(); } }
            if (t === 'n') { cell.v = Number(dv != null ? dv : text.replace(/[,¥$€£%\s]/g, '')); cell.t = 'n'; if (isNaN(cell.v)) { cell.v = 0; } }
            else if (t === 'b') { cell.v = String(dv != null ? dv : text).toUpperCase() === 'TRUE'; cell.t = 'b'; }
            else if (t === 'e') { cell.v = text; cell.t = 'e'; }
            else { cell.v = dv != null ? dv : text; cell.t = 's'; }
            if (fmt) { cell.fmt = fmt; }
            if (s) { cell.s = s; }
            cells[refName(r, c)] = cell;
            if (r > ui.maxR) { ui.maxR = r; } if (c > ui.maxC) { ui.maxC = c; }
          } else if (text && (td.children.length === 0 || (anchor && td.children.length === 1))) {
            // A table not made by CalcBase: the words as text, numbers as numbers.
            const p = Calc.parseInput(text, 'ja');
            if (p.t) { const cell = { v: p.v, t: p.t }; if (p.fmt) { cell.fmt = p.fmt; } if (s) { cell.s = s; } cells[refName(r, c)] = cell; if (r > ui.maxR) { ui.maxR = r; } if (c > ui.maxC) { ui.maxC = c; } }
          }
          if (fmt || s || note || link || style) {
            const meta = { fmt: fmt || '', s: s || null };
            if (note) { meta.note = note; } if (link) { meta.link = link; } if (style) { meta.style = style; }
            ui.meta.set(K(r, c), meta);
            if (r > ui.maxR) { ui.maxR = r; } if (c > ui.maxC) { ui.maxC = c; }
          }
          c += cs;
        });
      });
      // the pictures over the sheet, each tied to a cell
      Array.from(sec.querySelectorAll('img.cb-pic')).forEach((img, i) => {
        const src = safeImage(img.getAttribute('src'));
        const at = parseRef(img.getAttribute('data-cell') || '');
        if (!src || !at || ui.images.length >= 200) { return; }
        const st = img.getAttribute('style') || '';
        const px = (k) => { const m = new RegExp('(?:^|;)\\s*' + k + ':\\s*([\\d.]+)px').exec(st); return m ? Number(m[1]) : 0; };
        const pic = { id: 'img' + idx + '-' + i, r: at.r, c: at.c, dx: Number(img.getAttribute('data-dx')) || 0, dy: Number(img.getAttribute('data-dy')) || 0,
          w: Math.max(8, px('width') || 120), h: Math.max(8, px('height') || 90), src, alt: String(img.getAttribute('alt') || '').slice(0, 300) };
        const ratio = img.getAttribute('data-crop') || '';
        if (CROP_RATIOS.indexOf(ratio) > 0) {
          const pos = /object-position:\s*(-?[\d.]+)%\s+(-?[\d.]+)%/.exec(st);
          pic.crop = { ratio, x: pos ? clampPct(pos[1]) : 50, y: pos ? clampPct(pos[2]) : 50 };
        }
        ui.images.push(pic);
      });
      // A sheet of the book, even when it is empty; with its own names, if it has any.
      const ms = { name: ui.name, cells };
      const own = readJson(sec.getAttribute('data-names'), null);
      if (own && typeof own === 'object') { const nm = {}; Object.keys(own).forEach((k) => { if (/^[A-Za-z_\u3040-\u30ff\u4e00-\u9fff][\w.\u3040-\u30ff\u4e00-\u9fff]{0,99}$/.test(k) && typeof own[k] === 'string') { nm[k] = own[k].slice(0, 300); } }); if (Object.keys(nm).length) { ms.names = nm; } }
      model.sheets.push(ms);
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
    return { title, model, uis, book };
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
        if (isEmptyObj(meta) || (!meta.fmt && isEmptyObj(meta.s) && !meta.link)) { return; }
        const key = refName(KR(k), KC(k));
        const cell = s.cells[key] || (s.cells[key] = { v: '', t: '' });
        if (meta.fmt === 'General') { delete cell.fmt; } else if (meta.fmt) { cell.fmt = meta.fmt; }
        if (!isEmptyObj(meta.s)) { cell.s = Object.assign({}, meta.s); }
        if (meta.link && safeLink(meta.link)) { cell.link = meta.link; }
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
        const link = safeLink(cell.link);
        if (cell.fmt || !isEmptyObj(cell.s) || link) {
          const meta = { fmt: cell.fmt || '', s: isEmptyObj(cell.s) ? null : Object.assign({}, cell.s) };
          if (link) { meta.link = link; }
          ui.meta.set(K(p.r, p.c), meta);
        }
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
  /**
   * A format code as LibreOffice writes it in sdnum (upper-case keywords, [RED]) in
   * the form CalcBase keeps (yyyy/mm/dd, [Red]). Quoted text and [$-411] stay as they are.
   */
  function fromCalcCode(code) {
    const s = String(code || '');
    if (!s || /^(General|Standard)$/i.test(s)) { return ''; }
    let out = ''; let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') { const j = s.indexOf('"', i + 1); const end = j < 0 ? s.length : j + 1; out += s.slice(i, end); i = end; continue; }
      if (ch === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
      if (ch === '[') {
        const j = s.indexOf(']', i); const end = j < 0 ? s.length : j + 1; const inner = s.slice(i + 1, end - 1);
        if (/^(RED|BLUE|GREEN|BLACK|WHITE|YELLOW|MAGENTA|CYAN)$/i.test(inner)) { out += '[' + inner[0].toUpperCase() + inner.slice(1).toLowerCase() + ']'; }
        else if (/^(H+|M+|S+)$/i.test(inner)) { out += '[' + inner.toLowerCase() + ']'; }
        else { out += s.slice(i, end); }
        i = end; continue;
      }
      if (/^AM\/PM/i.test(s.slice(i, i + 5))) { out += 'AM/PM'; i += 5; continue; }
      if (/^A\/P/i.test(s.slice(i, i + 3))) { out += 'A/P'; i += 3; continue; }
      if (/[YMDHS]/.test(ch)) { out += ch.toLowerCase(); i += 1; continue; }
      out += ch; i += 1;
    }
    return out;
  }
  /**
   * The formats LibreOffice has built in (24.2, read from a new document): its HTML import keeps a cell's
   * format only when the code is one of these, in the language it is built in for -- a code of its own
   * comes back as General, or under 1041 as some other format (tried: "0.0%" became ##0.00E+00).
   */
  const CALC_BUILTIN = { ja: new Set(["# ?/2", "# ?/4", "# ?/8", "# ?/?", "# ??/10", "# ??/100", "# ??/16", "# ??/??", "# ???/???", "##0.00E+00", "#,###.00", "#,##0", "#,##0.00", "0", "0%", "0.00", "0.00%", "0.00E+00", "0.00E+000", "AM/PM H:MM", "AM/PM H:MM:SS", "H\"時\"MM\"分\"", "H\"時\"MM\"分\"SS\"秒\"", "H:MM", "HH:MM:SS", "M\"月\"", "M\"月\"D\"日\"", "MM.DD", "MM:SS.00", "YY\"年\"M\"月\"D\"日\"", "YY/M/D", "YY/MM", "YY/MM/DD", "YY/MM/DD HH:MM", "YYYY\"年\"M\"月\"D\"日\"", "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS", "YYYY-MM-DD HH:MM:SS.000", "YYYY-MM-DD\"T\"HH:MM:SS", "YYYY-MM-DD\"T\"HH:MM:SS.000", "YYYY/M/D H:MM", "YYYY/M/D H:MM:SS", "YYYY/MM/DD", "[HH]:MM:SS", "[HH]:MM:SS.00"]), en: new Set(["# ?/2", "# ?/4", "# ?/8", "# ?/?", "# ??/10", "# ??/100", "# ??/16", "# ??/??", "# ???/???", "##0.00E+00", "#,###.00", "#,##0", "#,##0.00", "#,##0.00_);(#,##0.00)", "#,##0_);(#,##0)", "0", "0%", "0.00", "0.00%", "0.00E+00", "0.00E+000", "D. MMM. YYYY", "D. MMMM YYYY", "HH:MM", "HH:MM AM/PM", "HH:MM:SS", "HH:MM:SS AM/PM", "M/D/YY", "MM-DD", "MM/DD/YY", "MM/DD/YY HH:MM AM/PM", "MM/DD/YYYY", "MM/DD/YYYY HH:MM AM/PM", "MM/DD/YYYY HH:MM:SS", "MM/YY", "MM:SS.00", "MMM D, YY", "MMM D, YYYY", "MMM DD", "MMMM", "MMMM D, YYYY", "YY-MM-DD", "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS", "YYYY-MM-DD HH:MM:SS.000", "YYYY-MM-DD\"T\"HH:MM:SS", "YYYY-MM-DD\"T\"HH:MM:SS.000", "[HH]:MM:SS", "[HH]:MM:SS.00"]) };
  /** CalcBase's format code as LibreOffice writes it: the date and time letters in capitals, [RED], other letters (月, 日) quoted. */
  function toCalcCode(code) {
    const s = String(code || '');
    if (!s || s === 'General') { return ''; }
    let out = ''; let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') { const j = s.indexOf('"', i + 1); const end = j < 0 ? s.length : j + 1; out += s.slice(i, end); i = end; continue; }
      if (ch === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
      if (ch === '[') { const j = s.indexOf(']', i); const end = j < 0 ? s.length : j + 1; const inner = s.slice(i + 1, end - 1); out += /^[a-z]+$/i.test(inner) ? '[' + inner.toUpperCase() + ']' : s.slice(i, end); i = end; continue; }
      if (/^AM\/PM/i.test(s.slice(i, i + 5))) { out += 'AM/PM'; i += 5; continue; }
      if (/[ymdhsa]/i.test(ch)) { out += ch.toUpperCase(); i += 1; continue; }
      if (/[^\x00-\x7f]/.test(ch)) { let j = i; while (j < s.length && /[^\x00-\x7f]/.test(s[j])) { j += 1; } out += '"' + s.slice(i, j) + '"'; i = j; continue; }
      out += ch; i += 1;
    }
    return out;
  }
  /** The sdnum of a number cell: "<language of the book>;<language of the code>;<code>", the code's language the one LibreOffice has it built in for. */
  function sdnumFor(code, lang) {
    const c = toCalcCode(code);
    if (!c) { return lang + ';'; }
    return lang + ';' + (CALC_BUILTIN.ja.has(c) && !CALC_BUILTIN.en.has(c) ? '1041' : '1033') + ';' + c;
  }
  /**
   * The writing of a pasted cell as a person sees it: the HTML's own spaces and
   * line breaks fold into one space, <br> is a new line inside the cell, and a
   * cell that is only a <br> (LibreOffice writes that for an empty cell) is empty.
   */
  function cellText(td) {
    const copy = td.cloneNode(true);
    copy.querySelectorAll('style, script').forEach((x) => x.remove());
    const walk = (n) => { n.childNodes.forEach((ch) => { if (ch.nodeType === 3) { ch.nodeValue = ch.nodeValue.replace(/[ \t\r\n]+/g, ' '); } else if (ch.nodeType === 1) { walk(ch); } }); };
    walk(copy);
    copy.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    copy.querySelectorAll('p, div').forEach((p) => { if (p.nextSibling) { p.after('\n'); } });
    return String(copy.textContent || '').replace(/ /g, ' ').replace(/ *\n */g, '\n').replace(/^ +| +$/g, '').replace(/\n+$/, '');
  }
  /** The table in pasted HTML: each cell's writing, what LibreOffice (sdval/sdnum) or Excel (x:num) say it is, its look, and the merges. */
  function tableFromHtml(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const table = doc.querySelector('table');
    if (!table) { return null; }
    const rows = []; const merges = []; const taken = new Set();
    const blank = () => ({ text: '', f: '', fmt: '', t: '', v: null, s: null, covered: true });
    let r = 0;
    Array.from(table.querySelectorAll('tr')).forEach((tr) => {
      // a table inside a cell is part of that cell's writing, not rows of this one
      if (tr.closest('table') !== table) { return; }
      const row = rows[r] || (rows[r] = []);
      let c = 0;
      Array.from(tr.children).forEach((td) => {
        if (td.tagName !== 'TD' && td.tagName !== 'TH') { return; }
        while (taken.has(r + ':' + c)) { c += 1; }
        const o = { text: cellText(td), f: td.getAttribute('data-f') || '', fmt: td.getAttribute('data-fmt') || '', t: td.getAttribute('data-t') || '', v: td.getAttribute('data-v'), s: cssToStyle(td.getAttribute('style')) };
        // LibreOffice: sdval is the value, sdnum "<language>;<language of the code>;<code>" its format
        const sdnum = td.getAttribute('sdnum'); const sdval = td.getAttribute('sdval');
        if (sdnum != null && !o.t) {
          const m = /^[^;]*;[^;]*;([\s\S]*)$/.exec(sdnum); const code = m ? m[1] : '';
          if (code === 'BOOLEAN') { o.bool = true; } else if (code === '@') { o.textOnly = true; o.fmt = '@'; } else if (code && !o.fmt) { o.fmt = fromCalcCode(code); }
        }
        if (sdval != null && sdval !== '' && !o.textOnly && !o.t && isFinite(Number(sdval))) { o.text = sdval; o.num = true; }
        // Excel: x:num is the value, x:str says text, x:fmla the formula
        const xn = td.getAttribute('x:num'); if (xn != null && xn !== '' && isFinite(Number(xn)) && !o.t) { o.text = xn; o.num = true; }
        if (td.hasAttribute('x:str')) { o.textOnly = true; }
        const xf = td.getAttribute('x:fmla'); if (xf) { o.f = xf[0] === '=' ? xf : '=' + xf; }
        // the look LibreOffice writes as old HTML: bgcolor, <font color>, <b> <i> <u>
        const s = o.s ? Object.assign({}, o.s) : {};
        const bg = td.getAttribute('bgcolor'); if (bg && !s.bg) { s.bg = /^#?[0-9a-f]{6}$/i.test(bg) ? '#' + bg.replace('#', '').toLowerCase() : bg; }
        // a tag that wraps the whole writing styles the cell (sdval has replaced o.text for a number: compare with the writing)
        const writing = cellText(td).replace(/\s+/g, '');
        const wholeOf = (sel) => { const el = td.querySelector(sel); return !!(el && writing && cellText(el).replace(/\s+/g, '') === writing); };
        if (!s.b && wholeOf('b, strong')) { s.b = 1; }
        if (!s.i && wholeOf('i, em')) { s.i = 1; }
        if (!s.u && wholeOf('u')) { s.u = 1; }
        if (!s.strike && wholeOf('s, strike, del')) { s.strike = 1; }
        const font = td.querySelector('font[color]'); if (!s.color && font && wholeOf('font[color]')) { s.color = font.getAttribute('color'); }
        o.s = Object.keys(s).length ? s : null;
        row[c] = o;
        const cs = Math.max(1, Math.min(1024, Number(td.getAttribute('colspan')) || 1));
        const rs = Math.max(1, Math.min(65536, Number(td.getAttribute('rowspan')) || 1));
        if (cs > 1 || rs > 1) {
          merges.push({ r0: r, c0: c, r1: r + rs - 1, c1: c + cs - 1 });
          for (let i = 0; i < rs; i += 1) { for (let j = 0; j < cs; j += 1) { if (i || j) { taken.add((r + i) + ':' + (c + j)); const rr = rows[r + i] || (rows[r + i] = []); rr[c + j] = blank(); } } }
        }
        c += cs;
      });
      r += 1;
    });
    // a short row is filled out with empty cells
    const width = rows.reduce((n, x) => Math.max(n, x ? x.length : 0), 0);
    for (let i = 0; i < rows.length; i += 1) { if (!rows[i]) { rows[i] = []; } for (let c = 0; c < width; c += 1) { if (!rows[i][c]) { rows[i][c] = blank(); } } }
    return { rows, merges, own: table.getAttribute('data-cb-clip') || '' };
  }
  /** What is typed into a cell for a pasted one: its formula, its value, TRUE/FALSE, or text kept as text (LibreOffice's "@"). */
  function pastedInput(o, valuesOnly) {
    if (o.f && !valuesOnly) { return o.f; }
    if (o.bool) { return Number(o.text) ? 'TRUE' : 'FALSE'; }
    let input = o.v != null && o.t === 'n' ? String(o.v) : o.text;
    if (o.t === 'b' && o.v != null) { return o.v === 'true' || o.v === '1' ? 'TRUE' : 'FALSE'; }
    // text stays text: "0123" in a text cell is not the number 123
    if ((o.textOnly || o.t === 's') && input !== '' && Calc.parseInput(input, 'ja').t !== 's') { input = "'" + input; }
    return input;
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
    // the icons of the phase-2 chrome, drawn in the same hand as EditBase's
    paper: I('<path d="M3.5 1.8h6l3 3v9.4a.6.6 0 0 1-.6.6H3.5a.6.6 0 0 1-.6-.6V2.4a.6.6 0 0 1 .6-.6z"/><path d="M9.3 1.8v3.3h3.2"/>'),
    props: I('<path d="M2.6 4.4h10.8M2.6 8h10.8M2.6 11.6h10.8"/><circle cx="5.6" cy="4.4" r="1.5" fill="currentColor" stroke="none"/><circle cx="10.4" cy="8" r="1.5" fill="currentColor" stroke="none"/><circle cx="6.6" cy="11.6" r="1.5" fill="currentColor" stroke="none"/>'),
    clear: I('<path d="M6 3h7M9.5 3 7 13M3 13h6"/><path d="M11 9.5 14.5 13M14.5 9.5 11 13"/>'),
    cells: I('<rect x="1.8" y="2.4" width="12.4" height="11.2" rx="1"/><path d="M1.8 8h12.4M8 2.4v11.2"/><path d="M10.2 10.2h2.4M11.4 9v2.4" stroke-width="1.3"/>'),
    image: I('<rect x="1.8" y="3" width="12.4" height="10" rx="1.2"/><circle cx="5.6" cy="6.6" r="1.1"/><path d="M2.2 11.4 6 8.2l2.6 2.2 2.3-1.8 2.9 2.6"/>'),
    link: I('<path d="M6.6 9.4a3 3 0 0 0 4.2 0l2.2-2.2a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M9.4 6.6a3 3 0 0 0-4.2 0L3 8.8a3 3 0 0 0 4.2 4.2l1-1"/>'),
    note: I('<path d="M2.6 2.6h10.8v8.2H8.4L5.2 13.6v-2.8H2.6z"/><path d="M5 5.6h6M5 8h4"/>'),
    text: I('<path d="M3 3.5h10M8 3.5V13M6 13h4"/>'),
    name: I('<path d="M2.4 5.2 8 2.2l5.6 3v5.6L8 13.8l-5.6-3z"/><path d="M5.6 9.6 8 5.6l2.4 4M6.4 8.4h3.2"/>'),
    bring: I('<path d="M2.4 2.6h6.2v4.2M2.4 2.6v10.8h11.2V8.2"/><path d="M14 2 9 7M9 3.8V7h3.2"/>'),
    data: I('<ellipse cx="8" cy="3.8" rx="5.4" ry="1.8"/><path d="M2.6 3.8v8.4c0 1 2.4 1.8 5.4 1.8s5.4-.8 5.4-1.8V3.8M2.6 8c0 1 2.4 1.8 5.4 1.8s5.4-.8 5.4-1.8"/>'),
    dedupe: I('<rect x="1.8" y="2.2" width="8.4" height="4.6" rx=".8"/><rect x="5.8" y="9.2" width="8.4" height="4.6" rx=".8" stroke-dasharray="1.6 1.4"/><path d="M11.6 3.2 14 5.6M14 3.2l-2.4 2.4"/>'),
    split: I('<rect x="1.8" y="3.4" width="12.4" height="9.2" rx="1"/><path d="M8 3.4v9.2" stroke-dasharray="1.6 1.4"/><path d="M4.4 8h2M9.6 8h2M5.6 6.8 6.8 8 5.6 9.2M10.4 6.8 9.2 8l1.2 1.2"/>'),
    headings: I('<rect x="1.8" y="1.8" width="12.4" height="12.4" rx="1"/><path d="M1.8 5h12.4M5 1.8v12.4"/><rect x="1.8" y="1.8" width="12.4" height="3.2" fill="currentColor" stroke="none" opacity=".3"/><rect x="1.8" y="5" width="3.2" height="9.2" fill="currentColor" stroke="none" opacity=".3"/>'),
    fbar: I('<rect x="1.4" y="4" width="13.2" height="8" rx="1.4"/><path d="M3.6 10V6.2h2.2M3.6 8.1h1.8M8 6.2l3.2 3.6M11.2 6.2 8 9.8"/>'),
    formulas: I('<path d="M6.2 13.2c1.8 0 1.6-2.2 2-5.4.4-3.2.2-5 2-5"/><path d="M5.2 7.4h5"/><path d="M11 9.8l2.6 3M13.6 9.8 11 12.8" stroke-width="1.3"/>'),
    zero: I('<ellipse cx="8" cy="8" rx="3.6" ry="5.4"/><path d="M3 13 13 3"/>'),
    breaks: I('<path d="M3 1.8h7l3 3v3.2M3 1.8v6.2"/><path d="M1.6 10h12.8" stroke-dasharray="1.8 1.4"/><path d="M3 12v2.2h10V12"/>'),
    pages: I('<rect x="2.4" y="1.8" width="7.6" height="9.6" rx=".6"/><rect x="5.4" y="4.4" width="7.6" height="9.6" rx=".6"/>'),
    fx: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><text x="8" y="12" text-anchor="middle" font-size="11.5" font-style="italic" font-weight="700" font-family="Georgia, \'Times New Roman\', serif" fill="currentColor">fx</text></svg>',
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
      // the book's faces of Google Fonts are fetched as the frame is laid out: they are waited for (at most a few seconds)
      const wait = /fonts\.googleapis\.com/.test(html) ? 6000 : 1500;
      if (faces && faces.ready) {
        let went = false; const fire = () => { if (!went) { went = true; go(); } };
        try {
          const fams = Array.from(new Set((html.match(/family=([^&:"]+)/g) || []).map((x) => decodeURIComponent(x.slice(7).replace(/\+/g, ' ')))));
          Promise.all(fams.map((f) => (faces.load ? faces.load('11pt "' + f + '"').catch(() => null) : null))).then(() => faces.ready).then(fire, fire);
        } catch (e) { fire(); }
        setTimeout(fire, wait);
      } else { go(); }
    };
    frame.srcdoc = html;
    return frame;
  }

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
  function fontCss(bold, px, fam) { return (bold ? '700 ' : '') + px + 'px ' + fontStack(fam || 'Noto Sans JP', 'sans'); }
  function fitNumber(text, v, avail, font) {
    if (!(avail > 0)) { return text; }
    // well inside the room by the sum of its characters' widths (2 % and half a pixel to spare for kerning): it fits
    if (quickWidth(text, font) * 1.02 + 0.5 <= avail || textWidth(text, font) <= avail) { return text; }
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
  let measureCtx = null; let measureFont = '';
  function textWidth(text, font) {
    if (!measureCtx) { measureCtx = document.createElement('canvas').getContext('2d'); }
    if (font !== measureFont) { measureCtx.font = font; measureFont = font; }
    return measureCtx.measureText(text).width;
  }
  /** The sum of the widths of a text's characters, each measured once per typeface (no kerning: a hair over the real width for figures). */
  const charWidths = new Map();
  function quickWidth(text, font) {
    let m = charWidths.get(font);
    if (!m) { m = new Map(); charWidths.set(font, m); if (charWidths.size > 50) { charWidths.delete(charWidths.keys().next().value); } }
    let w = 0;
    for (let i = 0; i < text.length; i += 1) { const ch = text[i]; let x = m.get(ch); if (x === undefined) { x = textWidth(ch, font); m.set(ch, x); } w += x; }
    return w;
  }
  /** A typeface has arrived (or a book's set of them changed): every width measured in the stand-in is wrong now. */
  function forgetWidths() { charWidths.clear(); measureFont = ''; }

  // ---- typefaces (EditBase's, as they are there) ------------------------------------
  // Any family on Google Fonts can be used. The catalogue ships with the app
  // (data/google-fonts.json), so the picker works without calling Google at all;
  // the font files themselves are fetched only once a family is actually in use,
  // and the same stylesheet URL is written into the saved book, which is what
  // makes the file look the same on a machine that has none of these fonts.
  const GF_CSS = 'https://fonts.googleapis.com/css2';
  const FALLBACK = {
    serif: '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Times New Roman", serif',
    sans: '"Hiragino Kaku Gothic ProN", "Yu Gothic", "YuGothic", "Noto Sans JP", "Helvetica Neue", Arial, sans-serif',
    mono: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    display: '"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", Arial, sans-serif',
    handwriting: '"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", cursive',
  };
  // A book reads best in a face cut for its own script, so the book's language
  // picks the starting typefaces -- not the server locale. EditBase's table; a
  // sheet's cells are set in the sans of it (Calc's default cell style is a sans),
  // and Japanese keeps the face CalcBase has always drawn cells in.
  const LATIN = { serif: 'Source Serif 4', sans: 'Source Sans 3', mono: 'Noto Sans Mono' };
  const LANG_FONTS = {
    ja: { serif: 'BIZ UDPMincho', sans: 'BIZ UDPGothic', mono: 'BIZ UDGothic' },
    zh: { serif: 'Noto Serif SC', sans: 'Noto Sans SC', mono: 'Noto Sans Mono' },
    zh_Hant: { serif: 'Noto Serif TC', sans: 'Noto Sans TC', mono: 'Noto Sans Mono' },
    ko: { serif: 'Noto Serif KR', sans: 'Noto Sans KR', mono: 'Noto Sans Mono' },
    ar: { serif: 'Noto Naskh Arabic', sans: 'Noto Kufi Arabic', mono: 'Noto Sans Mono' },
    fa: { serif: 'Noto Naskh Arabic', sans: 'Noto Kufi Arabic', mono: 'Noto Sans Mono' },
    he: { serif: 'Noto Serif Hebrew', sans: 'Noto Sans Hebrew', mono: 'Noto Sans Mono' },
    hi: { serif: 'Noto Serif Devanagari', sans: 'Noto Sans Devanagari', mono: 'Noto Sans Mono' },
    th: { serif: 'Noto Serif Thai', sans: 'Noto Sans Thai', mono: 'Noto Sans Mono' },
    ru: { serif: 'Noto Serif', sans: 'Noto Sans', mono: 'Noto Sans Mono' },
    uk: { serif: 'Noto Serif', sans: 'Noto Sans', mono: 'Noto Sans Mono' },
    en: LATIN, es: LATIN, fr: LATIN, de: LATIN, it: LATIN, pt: LATIN,
    vi: LATIN, tr: LATIN, pl: LATIN, cs: LATIN, id: LATIN,
  };
  /** The cells' own face per language where it is not the sans of the table above. */
  const CELL_FONTS = { ja: 'Noto Sans JP' };
  /** Which script a language is written in, for filtering the picker. */
  const LANG_SCRIPT = {
    ja: 'japanese', zh: 'chinese-simplified', zh_Hant: 'chinese-traditional', ko: 'korean',
    ar: 'arabic', fa: 'arabic', he: 'hebrew', hi: 'devanagari', th: 'thai',
    ru: 'cyrillic', uk: 'cyrillic', vi: 'vietnamese',
  };
  function langKey(lang) {
    const l = String(lang || 'en').replace('-', '_');
    if (LANG_FONTS[l]) { return l; }
    const base = l.split('_')[0];
    if (base === 'zh' && /(_TW|_HK|Hant)/i.test(l)) { return 'zh_Hant'; }
    return LANG_FONTS[base] ? base : 'en';
  }
  function defaultFonts(lang) { return LANG_FONTS[langKey(lang)] || LATIN; }
  function scriptFor(lang) { return LANG_SCRIPT[langKey(lang)] || 'latin'; }
  /** The face a book's cells are set in when nothing else has been said: its language's. */
  function defaultCellFont(lang) { return CELL_FONTS[langKey(lang)] || defaultFonts(lang).sans; }

  // The default families, known without the catalogue: a book must produce the
  // right stylesheet URL from the first keystroke, not only after the picker is opened.
  const BUILTIN_FONTS = {
    'Source Serif 4': { c: 'serif', w: [400, 700], i: true },
    'Source Sans 3': { c: 'sans', w: [400, 700], i: true },
    'Noto Sans Mono': { c: 'sans', w: [400, 700], i: false },
    'BIZ UDPMincho': { c: 'serif', w: [400, 700], i: false },
    'BIZ UDPGothic': { c: 'sans', w: [400, 700], i: false },
    'BIZ UDGothic': { c: 'sans', w: [400, 700], i: false },
    'BIZ UDMincho': { c: 'serif', w: [400, 700], i: false },
    'Noto Sans JP': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif JP': { c: 'serif', w: [400, 700], i: false },
    'Noto Serif SC': { c: 'serif', w: [400, 700], i: false },
    'Noto Sans SC': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif TC': { c: 'serif', w: [400, 700], i: false },
    'Noto Sans TC': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif KR': { c: 'serif', w: [400, 700], i: false },
    'Noto Sans KR': { c: 'sans', w: [400, 700], i: false },
    'Noto Naskh Arabic': { c: 'serif', w: [400, 700], i: false },
    'Noto Kufi Arabic': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif Hebrew': { c: 'serif', w: [400, 700], i: false },
    'Noto Sans Hebrew': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif Devanagari': { c: 'serif', w: [400, 700], i: false },
    'Noto Sans Devanagari': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif Thai': { c: 'serif', w: [400, 700], i: false },
    'Noto Sans Thai': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif': { c: 'serif', w: [400, 700], i: true },
    'Noto Sans': { c: 'sans', w: [400, 700], i: true },
  };
  // The catalogue, loaded once per session from the app itself.
  let fontCatalogue = null;
  let fontIndex = Object.assign({}, BUILTIN_FONTS);
  let fontAsking = null; let fontRefusedAt = 0;
  async function loadFonts() {
    if (fontCatalogue) { return fontCatalogue; }
    if (!fontAsking) {
      fontAsking = api('fonts').then((data) => {
        fontCatalogue = data && data.families ? data : { families: [], scripts: [] };
        fontIndex = Object.assign({}, BUILTIN_FONTS);
        fontCatalogue.families.forEach((f) => { fontIndex[f.f] = f; });
        return fontCatalogue;
      }, (e) => { fontAsking = null; fontRefusedAt = Date.now(); throw e; });
    }
    return fontAsking;
  }
  /** Whether asking for the catalogue now is worth it (not loaded, and not refused a moment ago). */
  const fontsWanted = () => !fontCatalogue && Date.now() - fontRefusedAt > 60000;
  function knownFont(family) { return family ? fontIndex[family] || null : null; }
  /** A family's name as the model keeps it: no quotes, nothing that could close a style. */
  function cleanFamily(f) { return String(f == null ? '' : f).replace(/["'<>\;{}]/g, '').trim().slice(0, 100); }
  /** font-family value: the chosen family first, then something to fall back on. */
  function fontStack(family, kind) {
    const meta = knownFont(family);
    const fb = FALLBACK[meta ? meta.c : kind] || FALLBACK[kind] || FALLBACK.sans;
    return family ? '"' + cleanFamily(family) + '", ' + fb : fb;
  }
  /** The generic family a cell's own face falls back on in the file (one word: the file keeps it short). */
  function genericOf(family) {
    const c = (knownFont(family) || {}).c;
    return c === 'serif' ? 'serif' : c === 'mono' ? 'monospace' : c === 'handwriting' ? 'cursive' : 'sans-serif';
  }
  /**
   * One Google Fonts stylesheet URL for a set of families. Weights are held to the
   * two a book needs (regular and bold, plus italics where the family has them)
   * so a book does not pull megabytes it will never draw. A family Google does not
   * have -- Calibri or MS PGothic from an XLSX, a face installed on the machine --
   * is left out: asked for, it makes Google refuse the whole stylesheet (400), and
   * the other faces with it. Until the catalogue is in, only the built-in families
   * are known, so the catalogue is asked for as a book is opened and saved.
   */
  function fontsUrl(families, sampleText) {
    const wanted = [];
    families.filter(Boolean).forEach((name) => {
      if (wanted.some((w) => w.name === name)) { return; }
      const meta = knownFont(name);
      if (!meta) { return; }
      wanted.push({ name, meta });
    });
    if (!wanted.length) { return ''; }
    const parts = wanted.map(({ name, meta }) => {
      const key = 'family=' + encodeURIComponent(name).replace(/%20/g, '+');
      const weights = [400, 700].filter((w) => meta.w.includes(w));
      const list = weights.length ? weights : [meta.w[0]];
      const spec = meta.i
        ? ':ital,wght@' + list.map((w) => '0,' + w).concat(list.map((w) => '1,' + w)).join(';')
        : ':wght@' + list.join(';');
      return key + spec;
    });
    let url = GF_CSS + '?' + parts.join('&') + '&display=swap';
    if (sampleText) { url += '&text=' + encodeURIComponent(sampleText); }
    return url;
  }
  /** Put (or replace) a stylesheet link in the page head, by id. */
  function linkStylesheet(id, url) {
    let link = document.getElementById(id);
    if (!url) { if (link) { link.remove(); } return; }
    if (!link) {
      link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    if (link.getAttribute('href') !== url) { link.setAttribute('href', url); }
  }
  /** The <link> tags that carry a book's typefaces into a file of its own (as EditBase's). */
  function fontLinksHtml(url) {
    return url ? '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="' + esc(url) + '">' : '';
  }
  /** The named cell styles whose cells take the book's heading face (Calc's Heading, Heading 1, Heading 2). */
  const HEADING_STYLES = ['Heading', 'Heading 1', 'Heading 2'];
  /** A book's own typefaces, read back without trusting them. */
  function normaliseFonts(f) {
    const o = f && typeof f === 'object' ? f : {};
    return { body: cleanFamily(o.body), heading: cleanFamily(o.heading) };
  }
  /**
   * What a book says about itself in the head of its file, for when it is put on
   * the web (EditBase's document settings): written only where something was
   * entered, and nothing in it is ever HTML.
   */
  const HEAD_FIELDS = ['description', 'keywords', 'author', 'robots', 'canonical',
    'ogTitle', 'ogDescription', 'ogImage', 'ogType', 'ogSiteName', 'twitterCard'];
  function normaliseHead(h) {
    const out = {};
    HEAD_FIELDS.forEach((k) => {
      const v = h && typeof h[k] === 'string' ? h[k].replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
      out[k] = v.slice(0, k === 'description' || k === 'ogDescription' ? 1000 : 500);
    });
    // addresses only when they are http(s): javascript: and the like are not written
    ['canonical', 'ogImage'].forEach((k) => { if (out[k] && !/^https?:\/\//i.test(out[k])) { out[k] = ''; } });
    if (['', 'noindex', 'nofollow', 'noindex, nofollow'].indexOf(out.robots) < 0) { out.robots = ''; }
    if (['', 'article', 'website'].indexOf(out.ogType) < 0) { out.ogType = ''; }
    if (['', 'summary', 'summary_large_image'].indexOf(out.twitterCard) < 0) { out.twitterCard = ''; }
    return out;
  }
  function headTags(h) {
    const v = normaliseHead(h);
    const name = (n, c) => (c ? '<meta name="' + n + '" content="' + esc(c) + '">\n' : '');
    const prop = (n, c) => (c ? '<meta property="' + n + '" content="' + esc(c) + '">\n' : '');
    return (name('description', v.description) + name('keywords', v.keywords) + name('author', v.author)
      + name('robots', v.robots)
      + (v.canonical ? '<link rel="canonical" href="' + esc(v.canonical) + '">\n' : '')
      + prop('og:title', v.ogTitle) + prop('og:description', v.ogDescription) + prop('og:image', v.ogImage)
      + prop('og:type', v.ogType) + prop('og:site_name', v.ogSiteName) + name('twitter:card', v.twitterCard)).replace(/\n$/, '');
  }
  function readHead(dom) {
    const meta = (sel) => { const m = dom.querySelector(sel); return m ? (m.getAttribute('content') || '') : ''; };
    const can = dom.querySelector('link[rel="canonical"]');
    return normaliseHead({
      description: meta('meta[name="description"]'), keywords: meta('meta[name="keywords"]'),
      author: meta('meta[name="author"]'), robots: meta('meta[name="robots"]'),
      canonical: can ? (can.getAttribute('href') || '') : '',
      ogTitle: meta('meta[property="og:title"]'), ogDescription: meta('meta[property="og:description"]'),
      ogImage: meta('meta[property="og:image"]'), ogType: meta('meta[property="og:type"]'),
      ogSiteName: meta('meta[property="og:site_name"]'), twitterCard: meta('meta[name="twitter:card"]'),
    });
  }
  /** A language tag as a book's file may carry it (ja, en, zh-CN …). */
  const cleanLang = (l) => (/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(String(l || '').trim()) ? String(l).trim().replace('_', '-') : '');
  /** The language the calculation reads dates, times and numbers in: the book's (the engine knows ja and en). */
  const calcLocaleOf = (lang) => (/^ja\b/i.test(lang || '') ? 'ja' : 'en');

  // ---- what each tool does, in one sentence (as EditBase's TIPS) ------------------
  // The owner, 2026-09-22: under each tool's name, a short description of what it
  // does. Keys are the English names of the buttons and menu items; both halves
  // are translated at run time.
  const TIPS = {
    "New book": "Makes an empty book and opens it.",
    "Make from a CSV or Markdown table file…": "Makes a new book from a CSV, ODS, XLSX or Markdown table file in your Files.",
    "New category": "Adds a drawer to file books in.",
    "Settings": "Where books are kept, versions, theme, language and the widths of the bars.",
    "Books": "Shows or hides the list of books.",
    "Save": "Saves the book now (Ctrl+S).",
    "Print / PDF": "Prints the sheet, or saves it as a PDF, with the paper setup of this book.",
    "Web preview": "Shows the book as it is saved, as a web page in a new tab.",
    "Paper setup": "Paper size and margins, header and footer, scaling, and what is printed besides the cells.",
    "View the HTML": "Shows the HTML the book is saved as.",
    "More": "Download, export, versions, check the book, share and more.",
    "Cell style": "Puts a named set of formats on the selected cells: a heading, a total, a note.",
    "Change a cell style everywhere…": "Changes how a cell style looks, in every cell that carries it.",
    "Typeface of the text": "Changes the typeface of the selected cells.",
    "The default font": "Takes the cells' own typeface off, so the default is used.",
    "Another typeface…": "Picks a typeface from the whole catalogue.",
    "The typefaces of the book…": "The typefaces used for the cells and the headings throughout the book.",
    "Size of the text (pt)": "Changes the size of the text in the selected cells.",
    "The default size": "Takes the cells' own size off, so the default is used.",
    "Undo": "Takes back the last change (Ctrl+Z).",
    "Redo": "Puts back what was undone (Ctrl+Y).",
    "Zoom": "Makes the sheet larger or smaller on the screen; the file is not changed.",
    "Bold": "Makes the selected cells bold (Ctrl+B).",
    "Italic": "Makes the selected cells italic (Ctrl+I).",
    "Underline": "Underlines the text of the selected cells (Ctrl+U).",
    "Strikethrough": "Draws a line through the text of the selected cells.",
    "Text colour": "Colours the text of the selected cells.",
    "Fill colour": "Colours the background of the selected cells.",
    "Borders": "Draws lines round or between the selected cells.",
    "More borders…": "The line, its thickness and colour, and each edge, in the cell properties.",
    "Align left": "Puts the text at the left of the cell.",
    "Centre": "Puts the text in the middle of the cell, across.",
    "Align right": "Puts the text at the right of the cell.",
    "Align top": "Puts the text at the top of the cell.",
    "Centre vertically": "Puts the text in the middle of the cell, up and down.",
    "Align bottom": "Puts the text at the bottom of the cell.",
    "Wrap text": "Breaks long text into lines inside the cell.",
    "Merge cells": "Makes the selected cells one; what is in the hidden cells is kept.",
    "Unmerge cells": "Splits a merged cell back into its cells.",
    "Number format": "How a number is shown: decimals, thousands, currency, percent, date, time.",
    "More formats…": "Every number format, and a format code of your own.",
    "Percent": "Shows the number times 100 with a % sign.",
    "Thousands separator": "Shows the number with a comma every three digits.",
    "Add a decimal place": "Shows one more decimal place.",
    "Remove a decimal place": "Shows one decimal place fewer.",
    "Clear formatting": "Takes the formats off the selected cells; what is in them stays.",
    "Cell properties…": "Number format, alignment, font, borders and background of the selected cells (Ctrl+1).",
    "Find and replace": "Finds words or numbers on the sheet and replaces them (Ctrl+F).",
    "Download a copy": "Saves a copy of the book, as its .html file, to your computer.",
    "Export as CSV / ODS / XLSX…": "Writes the book into your Files as a CSV, ODS or XLSX file.",
    "Versions…": "The earlier versions kept beside the book; one can be put back.",
    "Check the book": "Looks for error values, formulas pointing at empty cells, numbers kept as text and columns wider than the paper.",
    "Share…": "Lets other people on this server read it, or write in it.",
    "Properties…": "The file's name, place and size, and how many sheets, cells and formulas it holds.",
    "Book settings…": "The book's language, and the page's title, description and sharing information.",
    "Make the pictures lighter": "Makes large pictures smaller in file size without changing how they look.",
    "Crop…": "Chooses which part of the picture its frame shows. Nothing is cut away.",
    "Alternative text…": "What a screen reader says for the picture, written into the file as its alt.",
    "Keyboard shortcuts": "The keys that do things on the sheet.",
    "Insert": "Functions, rows, columns, cells, sheets, pictures, links, characters, emoji, comments and names.",
    "Function…": "Picks a function from the list and starts a formula with it.",
    "Insert function…": "Picks a function from the list and starts a formula with it.",
    "Insert rows above": "Adds as many rows above the selection as are selected.",
    "Insert rows below": "Adds as many rows below the selection as are selected.",
    "Insert columns before": "Adds as many columns to the left of the selection as are selected.",
    "Insert columns after": "Adds as many columns to the right of the selection as are selected.",
    "Insert cells…": "Adds empty cells at the selection, moving the others down or to the right.",
    "Cells…": "Adds empty cells at the selection, moving the others down or to the right.",
    "Insert sheet": "Adds a new sheet.",
    "Picture…": "Puts a picture from your Files over the sheet, tied to the selected cell.",
    "Hyperlink…": "Makes the selected cell a link to a web page or an e-mail address (Ctrl+K).",
    "Special character…": "Puts a symbol or other character that is awkward to type into the cell.",
    "Emoji…": "Puts an emoji into the cell.",
    "Comment…": "Attaches a note to the selected cell, shown when the pointer rests on it.",
    "Edit the comment…": "Changes the note attached to this cell.",
    "Delete the comment": "Takes the note off this cell.",
    "Define a name…": "Gives a cell or a range a name to go to from the name box.",
    "Bring in": "Brings sheets in from RegiBase, FormulaBase, EditBase, NetBase, Tables, Contacts, Calendar, a web page or a file.",
    "RegiBase": "One collection of RegiBase as a sheet: a row per record, the fields as columns. Secret fields never come in.",
    "FormulaBase": "One collection of FormulaBase as a sheet: each formula with its variables, the result as a live formula where it can be one.",
    "EditBase": "The tables of an EditBase document, one sheet each, their formulas kept.",
    "NetBase": "The devices NetBase has found on the network, as a sheet.",
    "Nextcloud Tables": "One of your Tables as a sheet.",
    "Contacts": "Your contacts as a sheet: names, addresses, telephone numbers.",
    "Calendar": "The events of a stretch of days as a sheet.",
    "The tables of a web page…": "Brings in every table of a web page, one sheet each.",
    "A CSV, ODS, XLSX or Markdown file…": "Brings the sheets of a file in your Files into this book as new sheets.",
    "Data": "Sorting, the autofilter, repeated rows and splitting text into columns.",
    "Sort…": "Sorts by up to three columns, with or without a header row.",
    "Sort ascending": "Sorts the rows of the block round the cursor by the cursor's column, smallest first.",
    "Sort descending": "Sorts the rows of the block round the cursor by the cursor's column, largest first.",
    "AutoFilter": "Puts a button on each heading of the block, to show only the rows with the values you choose.",
    "Remove duplicates": "Takes out the rows of the block that repeat an earlier row.",
    "Text to columns…": "Splits the text of the selected cells at a separator into the cells to the right.",
    "Show gridlines": "Draws the lines between the cells.",
    "Hide gridlines": "Hides the lines between the cells.",
    "Show the row numbers and column letters": "Shows the row numbers and column letters round the sheet.",
    "Hide the row numbers and column letters": "Hides the row numbers and column letters.",
    "Show the formula bar": "Shows the bar with the name box and the formula.",
    "Hide the formula bar": "Hides the bar with the name box and the formula.",
    "Freeze rows and columns at the cursor": "Keeps the rows above and the columns to the left of the cursor in sight while scrolling.",
    "Unfreeze rows and columns": "Lets every row and column scroll again.",
    "Show the formulas": "Shows the formulas in the cells instead of their results (Ctrl+`).",
    "Show the values again": "Shows the results in the cells again (Ctrl+`).",
    "Show zero values": "Shows a 0 in the cells whose value is nought.",
    "Hide zero values": "Leaves the cells whose value is nought blank.",
    "Show the page breaks": "Draws where the pages fall when the sheet is printed with its paper setup.",
    "Hide the page breaks": "Hides the lines where the pages fall.",
    "Sheet bar": "Shows or hides the sheets as small pictures down the right.",
    "AutoSum": "Puts a SUM of the numbers above or to the left into the cell (Alt+=).",
    "Open": "Opens this book.",
    "Rename…": "Gives it another name.",
    "Duplicate": "Makes a copy of it beside it.",
    "Move to…": "Files the book in another category.",
    "No category": "Takes the book out of its category.",
    "Another folder in Files…": "Moves the book into any folder of your Files.",
    "Download": "Saves a copy of the book to your computer.",
    "Delete the category": "Deletes the category; only an empty one can be deleted.",
    "Order by last change again": "Puts the books back in the order they were last changed in.",
    "Go to this sheet": "Shows this sheet.",
    "Insert sheet before": "Adds a new sheet to the left of this one.",
    "Insert sheet after": "Adds a new sheet to the right of this one.",
    "Move left": "Moves this sheet one place to the left.",
    "Move right": "Moves this sheet one place to the right.",
    "Delete sheet": "Removes this sheet and everything on it.",
    "Cut": "Moves the selected cells to the clipboard; they leave when pasted (Ctrl+X).",
    "Copy": "Copies the selected cells (Ctrl+C).",
    "Paste": "Puts in what was copied; formulas move along (Ctrl+V).",
    "Paste values only": "Puts in the values of what was copied, without formulas or formats (Ctrl+Shift+V).",
    "Open the link": "Opens the linked page in a new tab.",
    "Edit the link…": "Changes where the link goes.",
    "Remove the link": "Takes the link off; the words stay.",
    "Contents": "Empties the selected cells; their formats stay.",
    "Formats": "Takes the formats off the selected cells; what is in them stays.",
    "Everything": "Empties the selected cells and takes their formats off.",
    "Clear contents": "Empties the selected rows or columns and takes their formats off.",
    "Column width…": "Sets the width of the selected columns, in the unit chosen in the settings.",
    "Optimal width": "Makes the selected columns as wide as their widest text.",
    "Hide these columns": "Hides the selected columns.",
    "Show hidden columns": "Shows the hidden columns among the selected ones.",
    "Row height…": "Sets the height of the selected rows, in the unit chosen in the settings.",
    "Optimal height": "Makes the selected rows as tall as their text.",
    "Hide these rows": "Hides the selected rows.",
    "Show hidden rows": "Shows the hidden rows among the selected ones.",
    "Delete rows": "Removes the selected rows; what is below moves up.",
    "Delete columns": "Removes the selected columns; what is to the right moves left.",
    "Rows above": "Adds rows above the selected ones.",
    "Rows below": "Adds rows below the selected ones.",
    "Columns before": "Adds columns to the left of the selected ones.",
    "Columns after": "Adds columns to the right of the selected ones.",
    "Rows": "Removes the selected rows.",
    "Columns": "Removes the selected columns.",
    "Ask the assistant about this cell": "Asks the AI assistant what this cell holds and does.",
    "Fit to the cell": "Makes the picture as large as the cell it is tied to.",
    "Original size": "Shows the picture at the size it came in at.",
    "Delete the picture": "Removes the picture.",
    "New conversation": "Starts the assistant's conversation afresh.",
    "Look again": "Checks the book again.",
    "Use for new books": "New books will start with this paper setup and these typefaces.",
    "Reset this style": "Puts the style back as CalcBase ships it.",
    "Apply everywhere": "Changes every cell that carries this style.",
    "Put it at the cursor": "Writes the first sheet into this sheet, from the selected cell.",
    "Add as new sheets": "Adds what came in as new sheets after the last one.",
  };
  // characters that are awkward to type (as EditBase's)
  const CHAR_SETS = [
    { key: 'Punctuation', chars: '「」『』（）〔〕［］｛｝〈〉《》【】…‥—―‐・、。，．！？：；／＼〜※' },
    { key: 'Marks', chars: '§¶†‡°′″№℡㊤㊥㊦㊧㊨★☆●○◎■□▲△▼▽◆◇♪♭♯✓✕♂♀©®™' },
    { key: 'Currency', chars: '¥＄€£¢₩₽₹¤' },
    { key: 'Mathematics', chars: '±×÷≠≒≦≧＜＞≪≫∞∴∵∫∑√∂∇⊥∠∽≡⇒⇔∈∋⊂⊃∩∪¬∀∃' },
    { key: 'Arrows', chars: '←↑→↓↔↕⇐⇑⇒⇓⇔⇕↖↗↘↙⇄⇅' },
    { key: 'Greek', chars: 'αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ' },
    { key: 'Numbers', chars: '½⅓⅔¼¾⅛⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉①②③④⑤⑥⑦⑧⑨⑩ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ' },
  ];
  /** Lower case, and hiragana as katakana, so a search typed either way finds the same names (as EditBase). */
  function kana(s) {
    return String(s).toLowerCase().replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  }
  // The whole Unicode emoji set, with its CLDR names and keywords, is EditBase's
  // data (js/emoji-*.js, plain JSON): fetched the first time the picker opens.
  let EMOJI = null;
  let imageSerial = 0;

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
      <!-- 「新しいブック」の右に、CSV などの表のファイルから作るボタン（EditBase の ＋M↓ と同じ場所・同じ形）。 -->
      <div class="newrow">
        <button class="cb-btn primary wide" @click="newBook">＋ {{ t('New book') }}</button>
        <button class="cb-btn csv-new" @click="importBook()" :title="t('Make from a CSV or Markdown table file…')" :aria-label="t('Make from a CSV or Markdown table file…')">＋<span class="csvmark">CSV</span></button>
      </div>
      <button class="cb-btn ghost wide" v-if="!naming" @click="startCategory">＋ {{ t('New category') }}</button>
      <input v-else ref="catName" class="cb-catname" type="text" maxlength="100" v-model="catNew"
        :placeholder="t('Name of the category')" @keydown.enter.prevent="makeCategory" @keydown.esc.prevent="naming = false" @blur="makeCategory">
    </div>
    <div class="cb-booklist">
      <p class="hint" v-if="!books.length">{{ t('No books yet. Everything you make here is saved to {folder} in your Files as a plain .html file.', { folder: settings.folder }) }}</p>
      <!-- Nothing is filed anywhere yet: a plain list is plainer than one box. -->
      <template v-if="bookGroups.length === 1 && bookGroups[0].key === ''">
        <button v-for="b in bookGroups[0].books" :key="b.id" class="cb-bookitem" :class="{ active: b.id === book.id, lifted: dragBook === b.id, dropabove: dropBook && dropBook.id === b.id && !dropBook.after, dropbelow: dropBook && dropBook.id === b.id && dropBook.after }"
          :draggable="!b.shared" @dragstart="liftBook(b, $event)" @dragend="dragBook = 0; dropBook = null"
          @dragover.prevent="overBook(bookGroups[0], b, $event)" @drop.prevent.stop="dropOnBook(bookGroups[0], b)"
          @click="openBook(b.id)" @contextmenu.prevent.stop="bookCtx($event, b)">
          <span class="t">{{ b.title || b.name }}</span>
          <span class="m">{{ when(b.mtime) }} · {{ size(b.size) }}<span v-if="b.shared"> · {{ b.owner }}</span></span>
        </button>
      </template>
      <!-- Otherwise a box for each category, one open at a time. -->
      <div v-else class="cb-cat" v-for="g in bookGroups" :key="g.key"
        :class="{ open: openCat === g.key, holds: g.books.some((b) => b.id === book.id), over: dropCat === g.key }"
        :style="g.colour ? { '--cat': g.colour } : {}"
        @dragover.prevent="overCat(g)" @dragleave="dropCat = dropCat === g.key ? null : dropCat" @drop.prevent="dropOnCat(g)">
        <button class="cat-head" @click="toggleCat(g.key)" @contextmenu.prevent.stop="catCtx($event, g)">
          <span class="tw">{{ openCat === g.key ? '▾' : '▸' }}</span>
          <span class="nm">{{ g.label }}</span>
          <span class="n">{{ g.books.length }}</span>
        </button>
        <div class="cat-body" v-if="openCat === g.key">
          <button v-for="b in g.books" :key="b.id" class="cb-bookitem" :class="{ active: b.id === book.id, lifted: dragBook === b.id, dropabove: dropBook && dropBook.id === b.id && !dropBook.after, dropbelow: dropBook && dropBook.id === b.id && dropBook.after }"
            :draggable="!b.shared" @dragstart="liftBook(b, $event)" @dragend="dragBook = 0; dropBook = null"
            @dragover.prevent.stop="overBook(g, b, $event)" @drop.prevent.stop="dropOnBook(g, b)"
            @click="openBook(b.id)" @contextmenu.prevent.stop="bookCtx($event, b)">
            <span class="t">{{ b.title || b.name }}</span>
            <span class="m">{{ when(b.mtime) }} · {{ size(b.size) }}<span v-if="b.shared"> · {{ b.owner }}</span></span>
          </button>
          <p class="hint" v-if="!g.books.length">{{ t('Nothing in this category yet.') }}</p>
        </div>
      </div>
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
      <button class="cb-btn" @click="save(true)" :disabled="!book.id || saving || book.readOnly" :title="t('Save') + ' (Ctrl+S)'">💾 <span class="lbl">{{ t('Save') }}</span></button>
      <button class="cb-btn" @click="openPrint" :disabled="!book.id" :title="t('Print / PDF')">🖨 <span class="lbl">{{ t('Print / PDF') }}</span></button>
      <button class="cb-btn" @click="webPreview" :disabled="!book.id" :title="t('Web preview')">🌐 <span class="lbl">{{ t('Web preview') }}</span></button>
      <button class="cb-btn ghost" @click="openPaper()" :disabled="!book.id" :title="t('Paper setup')"><span v-html="icons.paper"></span> <span class="lbl">{{ t('Paper setup') }}</span></button>
      <button class="cb-btn ghost" @click="showSource" :disabled="!book.id" :title="t('View the HTML')">&lt;/&gt;</button>
      <button class="cb-btn ghost" @click="menuOpen = !menuOpen" :title="t('More')">⋯</button>
      <!-- The first row of tools, as EditBase keeps it: the named style, the
           typeface and the size, which need width; then undo, redo and the zoom. -->
      <span class="headtools" v-if="book.id">
      <select class="tb-style" :value="fmtNow.style || ''" @change="applyNamedStyle($event.target.value); $event.target.value = fmtNow.style || ''" :title="t('Cell style')" :disabled="book.readOnly">
        <option value="">{{ t('Default') }}</option>
        <option v-for="st in namedStyleList" :key="st.key" :value="st.key">{{ st.label }}</option>
      </select>
      <button class="cb-tb text style-btn" @mousedown.prevent @click="openStyles()" :disabled="book.readOnly" :title="t('Change a cell style everywhere…')"><span v-html="icons.props"></span><span class="lbl">{{ t('Styles') }}</span></button>
      <span class="cb-pop wide-ctl">
        <button class="cb-tb text font-btn" :class="{ on: menu === 'font' }" @mousedown.prevent @click="toggleMenu('font')" :title="t('Typeface of the text')" :disabled="book.readOnly">
          <span class="fname" :style="{ fontFamily: fontPreviewStack(fmtNow.font || fontsInUse.body) }">{{ fmtNow.font || fontsInUse.body }}</span>
          <span class="caret" v-html="icons.down"></span>
        </button>
        <!-- As EditBase's: the book's own faces, the faces used in it, then any face of Google Fonts. -->
        <div class="cb-menu wide" v-if="menu === 'font'" @mousedown.prevent>
          <button class="cb-menu-item" :class="{ on: !fmtNow.font }" @click="setStyle('font', ''); menu = ''">{{ t('The default font') }}<span class="k">{{ fontsInUse.body }}</span></button>
          <div class="cb-menu-sep"></div>
          <button v-for="r in fontRoles" :key="r.key" class="cb-menu-item" :class="{ on: fmtNow.font === fontsInUse[r.key] }" @click="setStyle('font', fontsInUse[r.key]); menu = ''">
            <span :style="{ fontFamily: fontPreviewStack(fontsInUse[r.key]) }">{{ fontsInUse[r.key] }}</span>
            <span class="k">{{ r.label }}</span>
          </button>
          <template v-if="usedFonts.length">
            <div class="cb-menu-sep"></div>
            <div class="cb-menu-head">{{ t('Used in this book') }}</div>
            <button v-for="f in usedFonts" :key="'u' + f" class="cb-menu-item" :class="{ on: fmtNow.font === f }" @click="setStyle('font', f); menu = ''"><span :style="{ fontFamily: fontPreviewStack(f) }">{{ f }}</span></button>
          </template>
          <div class="cb-menu-sep"></div>
          <button class="cb-menu-item" @click="openFonts('selection')">{{ t('Another typeface…') }}</button>
          <button class="cb-menu-item" @click="menu = ''; openPaper('text')">{{ t('The typefaces of the book…') }}</button>
        </div>
      </span>
      <span class="cb-pop wide-ctl">
        <span class="cb-num" :title="t('Size of the text (pt)')">
          <button class="cb-tb" @mousedown.prevent @click="stepSize(-1)" v-html="icons.minus" :disabled="book.readOnly"></button>
          <input type="number" min="4" max="200" step="0.5" :value="sizeTyping !== null ? sizeTyping : (fmtNow.size || settings.fontSize)"
            @input="sizeTyping = $event.target.value" @blur="sizeTyping = null"
            @change="sizeBox($event.target)" @keydown.enter.prevent="sizeBox($event.target)"
            @keydown.esc.prevent="sizeTyping = null; $event.target.value = fmtNow.size || settings.fontSize; $event.target.blur()" :disabled="book.readOnly">
          <button class="cb-tb" @mousedown.prevent @click="stepSize(1)" v-html="icons.plus" :disabled="book.readOnly"></button>
          <button class="cb-tb caret" :class="{ on: menu === 'size' }" @mousedown.prevent @click="toggleMenu('size')" v-html="icons.down" :disabled="book.readOnly"></button>
        </span>
        <div class="cb-menu sizes" v-if="menu === 'size'" @mousedown.prevent>
          <button v-for="n in fontSizes" :key="n" class="cb-menu-item" :class="{ on: Number(fmtNow.size || settings.fontSize) === n }" @click="setStyle('size', n); menu = ''">{{ n }}</button>
          <div class="cb-menu-sep"></div>
          <button class="cb-menu-item" @click="setStyle('size', ''); menu = ''">{{ t('The default size') }}</button>
        </div>
      </span>
      <span class="grow"></span>
      <span class="hist">
      <button class="cb-tb" @mousedown.prevent @click="undo" :disabled="!canUndo" :title="t('Undo') + ' (Ctrl+Z)'"><span v-html="icons.undo"></span></button>
      <button class="cb-tb" @mousedown.prevent @click="redo" :disabled="!canRedo" :title="t('Redo') + ' (Ctrl+Y)'"><span v-html="icons.redo"></span></button>
      </span>
      <span class="cb-num zoom" :title="t('Zoom')">
        <span class="cap">{{ t('Zoom') }}</span>
        <button class="cb-tb" @mousedown.prevent @click="stepZoom(-10)" v-html="icons.minus"></button>
        <button class="cb-tb text zoomv" @mousedown.prevent @click="setZoom(100)">{{ zoom }}%</button>
        <button class="cb-tb" @mousedown.prevent @click="stepZoom(10)" v-html="icons.plus"></button>
      </span>
      </span>
      <!-- The format of the cells: a row of its own under the first, as EditBase's
           formatting row stands under its row of styles (LibreOffice's Formatting bar). -->
      <span class="headtools fmttools" v-if="book.id">
        <button class="cb-tb" :class="{ on: fmtNow.b }" @mousedown.prevent @click="toggleStyle('b')" :disabled="book.readOnly" :title="t('Bold') + ' (Ctrl+B)'"><span class="b">B</span></button>
        <button class="cb-tb" :class="{ on: fmtNow.i }" @mousedown.prevent @click="toggleStyle('i')" :disabled="book.readOnly" :title="t('Italic') + ' (Ctrl+I)'"><span class="i">I</span></button>
        <button class="cb-tb" :class="{ on: fmtNow.u }" @mousedown.prevent @click="toggleStyle('u')" :disabled="book.readOnly" :title="t('Underline') + ' (Ctrl+U)'"><span class="u">U</span></button>
        <button class="cb-tb" :class="{ on: fmtNow.strike }" @mousedown.prevent @click="toggleStyle('strike')" :disabled="book.readOnly" :title="t('Strikethrough')"><span class="s">S</span></button>
        <span class="sep"></span>
        <span class="cb-pop">
          <label class="cb-tb" :title="t('Text colour')">
            <span v-html="icons.colour"></span>
            <span class="colour-bar" :style="{ background: fmtNow.color || 'var(--sheet-ink)' }"></span>
            <input type="color" :value="fmtNow.color || '#000000'" @input="setStyle('color', $event.target.value)" :disabled="book.readOnly">
          </label>
          <button class="cb-tb caret" :class="{ on: menu === 'color' }" @mousedown.prevent @click="toggleMenu('color')" v-html="icons.down" :title="t('Text colour')" :disabled="book.readOnly"></button>
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
          <button class="cb-tb caret" :class="{ on: menu === 'bg' }" @mousedown.prevent @click="toggleMenu('bg')" v-html="icons.down" :title="t('Fill colour')" :disabled="book.readOnly"></button>
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
        <button class="cb-tb" @mousedown.prevent @click="setFmt('#,##0')" :disabled="book.readOnly" :title="t('Thousands separator')"><span class="b">,</span></button>
        <button class="cb-tb" @mousedown.prevent @click="stepDec(1)" :disabled="book.readOnly" :title="t('Add a decimal place')" v-html="icons.dec0"></button>
        <button class="cb-tb" @mousedown.prevent @click="stepDec(-1)" :disabled="book.readOnly" :title="t('Remove a decimal place')" v-html="icons.dec1"></button>
        <span class="sep"></span>
        <button class="cb-tb" @mousedown.prevent @click="clearCells('formats')" :disabled="book.readOnly" :title="t('Clear formatting')"><span v-html="icons.clear"></span></button>
        <button class="cb-tb" @mousedown.prevent @click="openCellProps('number')" :disabled="book.readOnly" :title="t('Cell properties…') + ' (Ctrl+1)'" v-html="icons.settings"></button>
        <button class="cb-tb" :class="{ on: find.open }" @mousedown.prevent @click="toggleFind()" :title="t('Find and replace') + ' (Ctrl+F)'" v-html="icons.search"></button>
      </span>
      <!-- The "More" window, as EditBase's: what is done to the book as a whole. -->
      <div v-if="menuOpen" class="cb-modal-back" @click="menuOpen = false">
        <div class="cb-modal cb-more" style="width:min(360px,100%)" @click.stop>
          <h3>{{ book.name || t('Untitled book') }}</h3>
          <div class="body" style="display:flex;flex-direction:column;gap:6px;padding-bottom:16px">
            <button class="cb-btn wide primary" @click="menuOpen = false; newBook()">＋ {{ t('New book') }}</button>
            <template v-if="narrow && books.length">
              <div class="cb-menu-books">
                <button v-for="b in books" :key="b.id" class="cb-btn wide ghost" :class="{ on: b.id === book.id }" @click="menuOpen = false; openBook(b.id)">{{ b.title || b.name }}</button>
              </div>
            </template>
            <div class="cb-menu-sep"></div>
            <button class="cb-btn wide" v-if="book.id && book.download !== false" @click="menuOpen = false; downloadBook(book)">⬇ {{ t('Download a copy') }}</button>
            <button class="cb-btn wide" v-if="book.id" @click="menuOpen = false; openExport()">📤 {{ t('Export as CSV / ODS / XLSX…') }}</button>
            <button class="cb-btn wide" v-if="book.id" @click="menuOpen = false; openVersions(book)">🕘 {{ t('Versions…') }}</button>
            <button class="cb-btn wide" v-if="book.id" @click="menuOpen = false; runCheck()">🔍 {{ t('Check the book') }}</button>
            <button class="cb-btn wide" v-if="book.id && !book.shared" @click="menuOpen = false; openShare(book)">👥 {{ t('Share…') }}</button>
            <button class="cb-btn wide" v-if="book.id" @click="menuOpen = false; openBookProps(book)">ℹ {{ t('Properties…') }}</button>
            <button class="cb-btn wide" v-if="book.id" @click="menuOpen = false; openBookSettings(book)">⚙ {{ t('Book settings…') }}</button>
            <button class="cb-btn wide" v-if="book.id && !book.readOnly" @click="menuOpen = false; lightenPictures()">🗜 {{ t('Make the pictures lighter') }}</button>
            <button class="cb-btn wide" @click="menuOpen = false; keysOpen = true">⌨ {{ t('Keyboard shortcuts') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- The page is running code the server has since replaced. Saying so is the
         difference between "it is not fixed" and "reload and it is". -->
    <div class="cb-newbuild" v-if="newBuild">
      <span>{{ t('A newer CalcBase is on the server. This page is still running the old one.') }}</span>
      <button class="cb-btn primary" @click="reloadForNewBuild">{{ t('Save and reload') }}</button>
      <button class="cb-btn ghost" @click="newBuild = false">{{ t('Later') }}</button>
    </div>
    <!-- A book that may only be read says so where the eye is, not only in the status bar. -->
    <div class="cb-robanner" v-if="book.id && book.readOnly">
      <span>🔒 {{ t('This book is read only: it can be looked at, copied and printed, but not changed here.') }}</span>
    </div>

    <div class="cb-workarea" v-if="book.id" :class="{ aiopen: ai.show && ai.open }">
    <!-- Down the left, as EditBase's rail: what goes INTO the sheet, what is
         brought in from elsewhere, the data tools, and what is shown. -->
    <div class="cb-rail" ref="rail">
      <div class="rail-cap">{{ t('Insert') }}</div>
      <span class="cb-pop">
        <button class="cb-tb text" :class="{ on: menu === 'insert' }" @mousedown.prevent @click="toggleMenu('insert')" :title="t('Insert')" :disabled="book.readOnly">
          <span v-html="icons.plus"></span><span class="lbl">{{ t('Insert') }}</span><span class="caret" v-html="icons.down"></span>
        </button>
        <div class="cb-menu wide" v-if="menu === 'insert'" @mousedown.prevent>
          <button class="cb-menu-item" @click="menu = ''; openFx()"><span v-html="icons.fx"></span>{{ t('Function…') }}</button>
          <div class="cb-menu-sep"></div>
          <button class="cb-menu-item" @click="menu = ''; insertRows(0)"><span v-html="icons.rows"></span>{{ t('Insert rows above') }}</button>
          <button class="cb-menu-item" @click="menu = ''; insertRows(1)"><span v-html="icons.rows"></span>{{ t('Insert rows below') }}</button>
          <button class="cb-menu-item" @click="menu = ''; insertCols(0)"><span v-html="icons.cols"></span>{{ t('Insert columns before') }}</button>
          <button class="cb-menu-item" @click="menu = ''; insertCols(1)"><span v-html="icons.cols"></span>{{ t('Insert columns after') }}</button>
          <button class="cb-menu-item" @click="menu = ''; insertCells()"><span v-html="icons.cells"></span>{{ t('Insert cells…') }}</button>
          <button class="cb-menu-item" @click="menu = ''; addSheet()"><span v-html="icons.table"></span>{{ t('Insert sheet') }}</button>
          <div class="cb-menu-sep"></div>
          <button class="cb-menu-item" @click="menu = ''; openImagePicker()"><span v-html="icons.image"></span>{{ t('Picture…') }}</button>
          <button class="cb-menu-item" @click="menu = ''; openLink()"><span v-html="icons.link"></span>{{ t('Hyperlink…') }}</button>
          <button class="cb-menu-item" @click="menu = ''; openChars()"><span v-html="icons.text"></span>{{ t('Special character…') }}</button>
          <button class="cb-menu-item" @click="menu = ''; openEmoji()"><span class="cb-emoji-mark">😀</span>{{ t('Emoji…') }}</button>
          <button class="cb-menu-item" @click="menu = ''; openNote()"><span v-html="icons.note"></span>{{ t('Comment…') }}</button>
          <div class="cb-menu-sep"></div>
          <button class="cb-menu-item" @click="menu = ''; openNames()"><span v-html="icons.name"></span>{{ t('Define a name…') }}</button>
        </div>
      </span>
      <button class="cb-tb" @mousedown.prevent @click="openFx" :disabled="book.readOnly" :title="t('Insert function…')" v-html="icons.fx"></button>
      <button class="cb-tb" @mousedown.prevent @click="openImagePicker" :disabled="book.readOnly" :title="t('Picture…')" v-html="icons.image"></button>
      <button class="cb-tb" @mousedown.prevent @click="openNote" :disabled="book.readOnly" :title="t('Comment…')" v-html="icons.note"></button>
      <div class="rail-cap">{{ t('Bring in') }}</div>
      <span class="cb-pop">
        <button class="cb-tb text" :class="{ on: menu === 'bring' }" @mousedown.prevent @click="toggleMenu('bring')" :title="t('Bring in')" :disabled="book.readOnly">
          <span v-html="icons.bring"></span><span class="lbl">{{ t('Bring in') }}</span><span class="caret" v-html="icons.down"></span>
        </button>
        <div class="cb-menu wide" v-if="menu === 'bring'" @mousedown.prevent>
          <button v-for="key in sourceKeys" :key="key" class="cb-menu-item" @click="openSource(key)">
            <span class="cb-srcmark">{{ sourceMark(key) }}</span>{{ sourceLabel(key) }}
          </button>
          <div class="cb-menu-empty" v-if="!anySource">{{ t('No other app of ours is switched on for you.') }}</div>
          <div class="cb-menu-sep"></div>
          <button class="cb-menu-item" @click="menu = ''; webOpen = true"><span v-html="icons.link"></span>{{ t('The tables of a web page…') }}</button>
          <button class="cb-menu-item" @click="menu = ''; bringFile()"><span v-html="icons.import"></span>{{ t('A CSV, ODS, XLSX or Markdown file…') }}</button>
        </div>
      </span>
      <button class="cb-tb" @mousedown.prevent @click="bringFile" :disabled="book.readOnly" :title="t('A CSV, ODS, XLSX or Markdown file…')" v-html="icons.import"></button>
      <div class="rail-cap">{{ t('Data') }}</div>
      <span class="cb-pop">
        <button class="cb-tb text" :class="{ on: menu === 'data' }" @mousedown.prevent @click="toggleMenu('data')" :title="t('Data')" :disabled="book.readOnly">
          <span v-html="icons.data"></span><span class="lbl">{{ t('Data') }}</span><span class="caret" v-html="icons.down"></span>
        </button>
        <div class="cb-menu wide" v-if="menu === 'data'" @mousedown.prevent>
          <button class="cb-menu-item" @click="menu = ''; openSort()"><span v-html="icons.sortAZ"></span>{{ t('Sort…') }}</button>
          <button class="cb-menu-item" @click="menu = ''; sortSel(1)"><span v-html="icons.sortAZ"></span>{{ t('Sort ascending') }}</button>
          <button class="cb-menu-item" @click="menu = ''; sortSel(-1)"><span v-html="icons.sortZA"></span>{{ t('Sort descending') }}</button>
          <div class="cb-menu-sep"></div>
          <button class="cb-menu-item" :class="{ on: hasFilter }" @click="menu = ''; toggleFilter()"><span v-html="icons.filter"></span>{{ t('AutoFilter') }}</button>
          <button class="cb-menu-item" @click="menu = ''; removeDuplicates()"><span v-html="icons.dedupe"></span>{{ t('Remove duplicates') }}</button>
          <button class="cb-menu-item" @click="menu = ''; openSplit()"><span v-html="icons.split"></span>{{ t('Text to columns…') }}</button>
        </div>
      </span>
      <button class="cb-tb" @mousedown.prevent @click="sortSel(1)" :disabled="book.readOnly" :title="t('Sort ascending')" v-html="icons.sortAZ"></button>
      <button class="cb-tb" @mousedown.prevent @click="sortSel(-1)" :disabled="book.readOnly" :title="t('Sort descending')" v-html="icons.sortZA"></button>
      <button class="cb-tb" :class="{ on: hasFilter }" @mousedown.prevent @click="toggleFilter" :disabled="book.readOnly" :title="t('AutoFilter')" v-html="icons.filter"></button>
      <div class="rail-cap">{{ t('View') }}</div>
      <button class="cb-tb" :class="{ on: gridOn }" @mousedown.prevent @click="toggleGrid" :disabled="book.readOnly" :title="gridOn ? t('Hide gridlines') : t('Show gridlines')" v-html="icons.table"></button>
      <button class="cb-tb" :class="{ on: view.headings }" @mousedown.prevent @click="toggleView('headings')" :title="view.headings ? t('Hide the row numbers and column letters') : t('Show the row numbers and column letters')" v-html="icons.headings"></button>
      <button class="cb-tb" :class="{ on: view.fbar }" @mousedown.prevent @click="toggleView('fbar')" :title="view.fbar ? t('Hide the formula bar') : t('Show the formula bar')" v-html="icons.fbar"></button>
      <button class="cb-tb" :class="{ on: hasFreeze }" @mousedown.prevent @click="toggleFreeze" :disabled="book.readOnly" :title="hasFreeze ? t('Unfreeze rows and columns') : t('Freeze rows and columns at the cursor')" v-html="icons.freeze"></button>
      <button class="cb-tb" :class="{ on: view.formulas }" @mousedown.prevent @click="toggleView('formulas')" :title="view.formulas ? t('Show the values again') : t('Show the formulas') + ' (Ctrl+' + backtick + ')'" v-html="icons.formulas"></button>
      <button class="cb-tb" :class="{ on: view.zeros }" @mousedown.prevent @click="toggleView('zeros')" :title="view.zeros ? t('Hide zero values') : t('Show zero values')" v-html="icons.zero"></button>
      <button class="cb-tb" :class="{ on: view.breaks }" @mousedown.prevent @click="toggleView('breaks')" :title="view.breaks ? t('Hide the page breaks') : t('Show the page breaks')" v-html="icons.breaks"></button>
      <button class="cb-tb" :class="{ on: sheetBar.open }" v-if="!narrow" @mousedown.prevent @click="toggleSheetBar()" :title="t('Sheet bar')" v-html="icons.pages"></button>
    </div>

    <div class="cb-center">
    <!-- the formula bar -->
    <div class="cb-fbar" v-if="view.fbar">
      <input class="namebox" :value="nameBoxText" list="cb-names-list" @keydown.enter.prevent="goToName($event.target.value); $event.target.blur()" @keydown.esc.prevent="$event.target.value = nameBoxText; $event.target.blur()" @focus="$event.target.select()" :title="t('Name box: the cell or range, or type an address or a name to go there')" spellcheck="false">
      <datalist id="cb-names-list"><option v-for="n in nameList" :key="n.name" :value="n.name">{{ n.ref }}</option></datalist>
      <button class="cb-tb fx" @mousedown.prevent @click="openFx" :title="t('Insert function…')" :disabled="book.readOnly">fx</button>
      <button class="cb-tb sum" @mousedown.prevent @click="autoSum" :title="t('Sum') + ' (Alt+=)'" :disabled="book.readOnly">Σ</button>
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
      @mousedown="gridMouseDown($event)" @dblclick="gridDblClick($event)" @wheel="gridWheel($event)" @mousemove="gridHover($event)" @mouseleave="gridLeave"
      @touchstart.passive="gridTouchStart($event)" @touchend="gridTouchEnd($event)" @touchmove.passive="gridTouchMove($event)">
      <div class="cb-scroller" ref="scroller" @scroll.passive="onScroll">
        <div class="cb-view" ref="view">
          <div class="cb-layers" ref="layers"></div>
          <div class="cb-piclayer" ref="piclayer"></div>
          <textarea ref="editor" class="cb-editor" :class="{ wrap: edit.wrap, idle: !edit.on }" :style="edit.style" :spellcheck="settings.spellcheck && edit.on && edit.text.charAt(0) !== '=' ? 'true' : 'false'" autocomplete="off" autocapitalize="off" aria-label="cell"
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
      <!-- the comment of the cell under the pointer -->
      <div class="cb-notepop" v-if="notePop.text" :style="{ left: notePop.x + 'px', top: notePop.y + 'px' }">{{ notePop.text }}</div>
    </div>

    <!-- sheet tabs -->
    <div class="cb-sheets" v-if="settings.sheetTabs || narrow">
      <button class="cb-tb add" @click="addSheet()" :disabled="book.readOnly" :title="t('Insert sheet')"><span v-html="icons.plus"></span></button>
      <template v-for="(name, i) in sheetNames" :key="i + ':' + name">
        <input v-if="renameSheet.idx === i" class="rename-input" ref="renameInput" v-model="renameSheet.text" @keydown.enter.prevent="finishRenameSheet" @keydown.esc.prevent="renameSheet.idx = -1" @blur="finishRenameSheet" maxlength="60">
        <button v-else class="tab" :class="{ active: i === active }" @click="switchSheet(i)" @dblclick="startRenameSheet(i)" @contextmenu.prevent.stop="sheetCtx($event, i)">{{ name }}</button>
      </template>
    </div>
    </div>

    <!-- The handles for the bars on the right, at the height of the eye (as
         EditBase's): pointing left pulls a bar out, pointing right pushes it away. -->
    <div class="cb-tabs" v-if="(ai.show && !ai.open) || !narrow">
      <div class="tab ai ai-bar" v-if="ai.show && !ai.open">
        <button type="button" class="hnd" :title="t('Show') + ' — ' + t('AI assistant')" :aria-label="t('Show') + ' — ' + t('AI assistant')" @click="aiToggle">{{ narrow ? '▲' : '◀' }}</button>
        <span class="lb ai-lb">{{ t('AI assistant') }}</span>
      </div>
      <div class="tab sheets" v-if="!narrow">
        <span class="lb">{{ t('Sheet bar') }}</span>
        <button type="button" class="hnd" @click="toggleSheetBar()" :title="(sheetBar.open ? t('Hide') : t('Show')) + ' — ' + t('Sheet bar')">{{ sheetBar.open ? '▶' : '◀' }}</button>
      </div>
    </div>

    <!-- The sheets down the right, each a small picture of its top left corner, in
         the place of EditBase's page preview bar. -->
    <!-- its left-hand edge (the owner, 2026-10-06): the AI assistant's edge, the same strip and the same
         hand -- dragged, the bar takes the width there and then; let go, it is kept where the settings keep
         it; double-clicked, 132 px; the arrow keys, 10 px a press. Beside the bar, not in it: the bar scrolls. -->
    <div v-if="sheetBar.open && !narrow" class="cb-bar-split" :class="{ on: sheetSplitting }" role="separator" aria-orientation="vertical" tabindex="0"
      :aria-valuenow="sheetsWidthPx()" :aria-valuemin="sheetsWidthBounds().min" :aria-valuemax="sheetsWidthBounds().max"
      :title="t('Drag to change the width; double-click to reset')" :aria-label="t('Drag to change the width; double-click to reset')"
      @pointerdown.prevent="sheetSplitDown($event)" @dblclick.prevent="sheetSplitReset" @keydown="sheetSplitKey($event)"></div>
    <aside class="cb-sheetbar" v-if="sheetBar.open && !narrow" :style="{ width: sheetBarWidth(), flex: '0 0 ' + sheetBarWidth() }">
      <div class="head">
        <span>{{ t('Sheets') }}</span>
        <span class="grow"></span>
        <button class="cb-tb" @click="addSheet()" :disabled="book.readOnly" :title="t('Insert sheet')"><span v-html="icons.plus"></span></button>
        <button class="cb-tb" @click="toggleSheetBar(false)" :title="t('Close')"><span v-html="icons.close"></span></button>
      </div>
      <div class="pages" :ref="sheetPagesRef">
        <button v-for="(name, i) in sheetNames" :key="'th' + i + ':' + name" class="pg" :draggable="!book.readOnly"
          :class="{ on: i === active, over: dropSheet === i && dragSheet !== i, dragging: dragSheet === i }"
          @dragstart="sheetDragStart(i, $event)" @dragend="dragSheet = -1; dropSheet = -1"
          @dragover.prevent="dropSheet = i" @dragleave="dropSheet = dropSheet === i ? -1 : dropSheet" @drop.prevent="dropSheetAt(i)"
          @click="switchSheet(i)" @contextmenu.prevent.stop="sheetCtx($event, i)" :title="name">
          <span class="sheet"><canvas class="thumb" :data-sheet="i" width="240" height="168"></canvas></span>
          <span class="no">{{ name }}</span>
        </button>
      </div>
    </aside>

    <!-- the AI assistant (through AI-Hub) -- the same column as the other Base apps -->
    <aside class="ai-col" :class="{ 'is-drop': ai.drop }" v-if="ai.show && ai.open" :style="{ flex: '0 0 ' + aiWidth(), width: aiWidth() }"
      @dragover="aiDragOver" @dragleave="aiDragLeave" @drop="aiDrop">
      <!-- its edge: dragged, the column is as wide as it is left; double-clicked, 500 px; the arrow keys, 10 px a press (every Base app's) -->
      <div v-if="!narrow" class="ai-split" :class="{ on: aiSplitting }" role="separator" aria-orientation="vertical" tabindex="0"
        :aria-valuenow="aiWidthPx()" :aria-valuemin="aiWidthBounds().min" :aria-valuemax="aiWidthBounds().max"
        :title="t('Drag to change the width; double-click to reset')" :aria-label="t('Drag to change the width; double-click to reset')"
        @pointerdown.prevent="aiSplitDown($event)" @dblclick.prevent="aiSplitReset" @keydown="aiSplitKey($event)"></div>
      <div class="ai-head">
        <span class="ai-title">{{ t('AI assistant') }}</span>
        <span class="grow"></span>
        <span class="ai-model" v-if="ai.model" :title="ai.model">{{ ai.model }}</span>
        <button type="button" class="cb-btn xs" :disabled="ai.busy" :title="t('New conversation')" :aria-label="t('New conversation')" @click="aiClear">＋<span class="lbl"> {{ t('New conversation') }}</span></button>
        <button type="button" class="hnd" :title="t('Hide') + ' — ' + t('AI assistant')" :aria-label="t('Hide') + ' — ' + t('AI assistant')" @click="aiToggle">{{ narrow ? '▼' : '▶' }}</button>
      </div>
      <div class="ai-msgs" ref="aiMsgs">
        <p class="ai-hint" v-if="!ai.msgs.some((m) => !m.hidden)">{{ t('Ask how to do something in CalcBase, or say what to change in this book: the assistant can write into cells.') }}</p>
        <p class="ai-hint" v-if="!ai.msgs.some((m) => !m.hidden) && ai.imagesOk">{{ t('You can also paste (Ctrl+V) or drop images here.') }}</p>
        <!-- Each message can be copied as it stands (the owner, 2026-10-06): the button shows while
             the pointer is on the message; images sent with a question are shown small above its words. -->
        <template v-for="(m, i) in ai.msgs" :key="i">
          <div class="ai-msg" :class="m.role" v-if="!m.hidden">
            <div class="ai-imgs" v-if="m.images && m.images.length"><img v-for="(im, k) in m.images" :key="k" :src="im.url" :alt="im.name" :title="im.name"></div>
            <div class="ai-bubble" v-html="aiHtml(m)"></div>
            <div class="did" v-if="m.did">{{ m.did }}</div>
            <button type="button" class="ai-copy" v-if="aiHtml(m)" :class="{ done: m.copied }" :title="t('Copy')" :aria-label="t('Copy')" @click="aiCopy(m)">{{ m.copied ? '✓' : '📋' }}<span class="ai-copied" v-if="m.copied" role="status">{{ t('Copied') }}</span></button>
          </div>
        </template>
        <div class="ai-msg assistant" v-if="ai.busy"><div class="ai-bubble busy">{{ ai.busyText || t('Thinking…') }}</div></div>
        <p class="ai-err" v-if="ai.error">{{ ai.error }}</p>
      </div>
      <div class="ai-foot">
        <!-- Images pasted (Ctrl+V) or dropped go with the next question: shown small here, × takes one off. -->
        <div class="ai-att" v-if="ai.images.length || ai.attNote">
          <span class="ai-thumb" v-for="(im, k) in ai.images" :key="im.id"><img :src="im.url" :alt="im.name" :title="im.name"><button type="button" :title="t('Remove image')" :aria-label="t('Remove image')" @click="aiUnattach(k)">×</button></span>
          <p class="ai-attnote" v-if="ai.attNote" role="alert">{{ ai.attNote }}</p>
        </div>
        <textarea v-model="ai.input" rows="2" :placeholder="ai.ready ? t('Message to the assistant…') : aiNotReady()" :disabled="!ai.ready"
          @keydown="aiKey($event)" @paste="aiPaste" @compositionstart="ai.composing = true" @compositionend="ai.composing = false"></textarea>
        <button class="cb-btn primary" @click="aiSend" :disabled="ai.busy || !ai.ready || (!ai.input.trim() && !ai.images.length)">{{ t('Send') }}</button>
      </div>
    </aside>
    </div>

    <div class="cb-empty" v-else>
      <span class="mark" v-html="logo"></span>
      <p>{{ books.length ? t('Choose a book on the left, or make a new one.') : t('Make your first book with “New book”.') }}</p>
      <button class="cb-btn primary" @click="newBook">＋ {{ t('New book') }}</button>
    </div>

    <!-- the status bar, as EditBase's: the file, where the cursor is, what the selection adds up to, the paper -->
    <div class="cb-status" v-if="book.id" @contextmenu.prevent.stop="statusCtx($event)">
      <span class="grow fname">{{ (book.name || t('Untitled book')) + '.html' }}</span>
      <span class="cb-readonly" v-if="book.readOnly">{{ t('Read only') }}</span>
      <span class="where">{{ t('Sheet {n} of {total}', { n: active + 1, total: sheetNames.length }) }}</span>
      <span class="stat sel" v-if="selCount > 1">{{ t('{n} cells selected', { n: selCount }) }}</span>
      <span class="stat" v-if="statusBar.sum && stats.count"><b>{{ t('Sum') }}:</b> {{ stats.sum }}</span>
      <span class="stat avg" v-if="statusBar.avg && stats.count"><b>{{ t('Average') }}:</b> {{ stats.avg }}</span>
      <span class="stat cnt" v-if="statusBar.count && stats.count"><b>{{ t('Count') }}:</b> {{ stats.count }}</span>
      <span class="stat min" v-if="statusBar.min && stats.count"><b>{{ t('Minimum') }}:</b> {{ stats.min }}</span>
      <span class="stat max" v-if="statusBar.max && stats.count"><b>{{ t('Maximum') }}:</b> {{ stats.max }}</span>
      <span class="stat cnta" v-if="statusBar.counta && stats.counta"><b>{{ t('Not empty') }}:</b> {{ stats.counta }}</span>
      <span class="paper">{{ paperLabel }}</span>
      <span class="zoomv">{{ zoom }}%</span>
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
          <h4>{{ t('Unit for column widths and row heights') }}</h4>
          <label class="fl">
            <select v-model="settings.unit">
              <option value="px">px</option>
              <option value="pt">pt</option>
              <option value="mm">mm</option>
              <option value="cm">cm</option>
              <option value="in">{{ t('inches') }}</option>
            </select>
          </label>
          <p class="dim tiny">{{ t('Column width… and Row height… ask in this unit, as LibreOffice Calc asks in its measurement unit. The book itself keeps the sizes as it always has.') }}</p>
          <h4>{{ t('How big a book may be') }}</h4>
          <label class="fl">
            <select v-model.number="settings.cellLimit" :aria-label="t('How big a book may be')">
              <option :value="100000">{{ t('{n} cells (as set at first)', { n: (100000).toLocaleString() }) }}</option>
              <option :value="300000">{{ t('{n} cells', { n: (300000).toLocaleString() }) }}</option>
              <option :value="600000">{{ t('{n} cells', { n: (600000).toLocaleString() }) }}</option>
              <option :value="0">{{ t('No limit (at your own risk)') }}</option>
            </select>
          </label>
          <p class="dim tiny">{{ t('CalcBase is for the tables people keep by hand. Up to the limit a sheet also stops at row 30,000 and a book at 24 MB. A bigger book opens and saves more slowly, and a browser may stop responding; large amounts of data belong in a database.') }}</p>
          <h4>{{ t('Sheet tabs') }}</h4>
          <label class="opt"><input type="checkbox" v-model="settings.sheetTabs"> {{ t('Show the sheet tabs under the sheet') }}</label>
          <p class="dim tiny">{{ t('The sheet bar at the right shows every sheet with a picture of it, and adds, renames, moves and deletes them, so the tabs are off unless you want them. On a narrow screen, which has no sheet bar, they are always shown.') }}</p>
          <h4>{{ t('Width of the sheet bar') }}</h4>
          <div class="fl">
            <span class="widthbox sheetbar-widthbox">
              <input type="number" step="1" :min="settings.sheetsU === '%' ? 3 : 60" :max="settings.sheetsU === '%' ? 60 : 1200" v-model.number="settings.sheetsW" :aria-label="t('Width of the sheet bar')" @change="sheetsWidthValue()">
              <select v-model="settings.sheetsU" :aria-label="t('Width of the sheet bar')" @change="sheetsWidthValue()"><option value="px">px</option><option value="%">%</option></select>
            </span>
          </div>
          <p class="dim tiny">{{ t('In pixels (60 to 1200), or as a percentage of the width of the window (3 to 60).') }}</p>
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
          <h4>{{ t('While typing') }}</h4>
          <label class="opt"><input type="checkbox" v-model="settings.spellcheck"> {{ t('Check spelling while typing') }}</label>
          <label class="opt"><input type="checkbox" v-model="settings.autolink"> {{ t('Turn an address into a link as it is typed') }}</label>
          <p class="dim tiny">{{ t('Spelling is checked by the browser itself, in the language it is set to. Shift+right-click reaches its suggestions.') }}</p>
          <p class="dim tiny">{{ t('An address typed into a cell (https://…, www.…, or an e-mail address) becomes a link, as LibreOffice Calc’s URL recognition makes one. Ctrl+click the cell to open it.') }}</p>
          <h4>{{ t('Default font') }}</h4>
          <div class="fl-row">
            <div class="fl">
              <span class="fl-label">{{ t('Font') }}</span>
              <button type="button" class="font-row setfont" @click="openFonts('setting')">
                <span class="fam" :style="{ fontFamily: fontPreviewStack(settings.font || defaultCellFontName) }">{{ settings.font || defaultCellFontName }}</span>
                <span class="tag" v-if="!settings.font">{{ t('default') }}</span>
                <span class="caret" v-html="icons.down"></span>
              </button>
            </div>
            <label class="fl short">
              <span class="fl-label">{{ t('Size (pt)') }}</span>
              <input type="number" min="6" max="48" step="1" v-model.number="settings.fontSize">
            </label>
          </div>
          <p class="dim tiny">{{ t('Books that have not chosen typefaces of their own (Paper setup, Text and typefaces) set their cells in this. Saved, the book names it and carries it with it.') }}</p>
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

  <!-- typeface picker (EditBase's): any family of Google Fonts, by name, kind and script -->
  <div v-if="fontsOpen" class="cb-modal-back cb-fonts-back">
    <div class="cb-modal tall cb-fonts" @click.stop>
      <h3><span v-html="icons.text"></span> {{ t('Typeface') }} — {{ fontRoleLabel }}</h3>
      <div class="body">
        <div class="font-search">
          <span v-html="icons.search"></span>
          <input type="text" v-model="fontQuery" @input="fontPage = 1" :placeholder="t('Search Google Fonts…')">
        </div>
        <div class="chips">
          <button v-for="c in fontCats" :key="c.key" class="chip" :class="{ on: fontCat === c.key }" @click="fontCat = c.key; fontPage = 1">{{ c.label }}</button>
        </div>
        <div class="chips">
          <select v-model="fontScript" @change="fontPage = 1">
            <option value="auto">{{ t('Script of this book') }} — {{ scriptLabel(docScript) }}</option>
            <option value="all">{{ t('Every script') }}</option>
            <option v-for="sc in fontScripts" :key="sc" :value="sc">{{ scriptLabel(sc) }}</option>
          </select>
          <span class="count">{{ t('{n} families', { n: fontResults.length }) }}</span>
        </div>
        <div class="font-list">
          <button class="font-item" :class="{ on: !fontChosen }" @click="chooseFont('')">
            <span class="nm">{{ fontRole === 'body' || fontRole === 'heading' || fontRole === 'setting' ? t('Default for this language') : t('The default font') }}</span>
            <span class="meta">{{ defaultFontName }}</span>
          </button>
          <button v-for="f in fontPageItems" :key="f.f" class="font-item" :class="{ on: fontChosen === f.f }" @click="chooseFont(f.f)">
            <span class="nm" :style="{ fontFamily: fontPreviewStack(f.f) }">{{ f.f }}</span>
            <span class="meta">{{ catLabel(f.c) }} · {{ t('{n} weights', { n: f.w.length }) }}</span>
          </button>
          <p class="hint" v-if="!fontResults.length && fontsLoading">{{ t('Loading…') }}</p>
          <p class="hint" v-if="!fontResults.length && !fontsLoading">{{ t('No family matches that.') }}</p>
        </div>
        <button class="cb-btn wide" v-if="fontPageItems.length < fontResults.length" @click="fontPage++">{{ t('Show more') }}</button>
        <div class="cb-field">
          <label>{{ t('Preview') }}</label>
          <div class="font-sample" :style="{ fontFamily: fontPreviewStack(previewFamily) }">{{ sampleText }}</div>
        </div>
      </div>
      <div class="foot"><button class="cb-btn primary" @click="closeFonts">{{ t('Done') }}</button></div>
    </div>
  </div>

  <!-- The book's own settings (EditBase's document settings): what the file says about itself in its
       head when it is put on the web, and the language it is written and calculated in. What is set
       here is written into the file when it is next saved. Not shut by a click outside it: it is a form. -->
  <div v-if="bookSet.open && book.id" class="cb-modal-back">
    <div class="cb-modal cb-docset" style="width:min(620px,100%)" @click.stop>
      <h3>{{ t('Book settings') }}</h3>
      <div class="body">
        <p class="docname">{{ book.name }}</p>
        <section class="first">
          <h4>{{ t('The page') }}</h4>
          <div class="cb-field"><label>{{ t('Page title') }}</label>
            <input type="text" v-model="bookSet.title" :placeholder="t('Untitled book')" :disabled="book.readOnly"></div>
          <div class="cb-field"><label>{{ t('Description') }}</label>
            <textarea rows="3" v-model="bookSet.head.description" :disabled="book.readOnly"></textarea>
            <p class="cb-tip">{{ t('What search engines show under the title. {n} characters.', { n: bookSet.head.description.length }) }}</p></div>
          <div class="cb-row">
            <div class="cb-field"><label>{{ t('Keywords') }}</label>
              <input type="text" v-model="bookSet.head.keywords" :placeholder="t('Separated by commas')" :disabled="book.readOnly"></div>
            <div class="cb-field"><label>{{ t('Author') }}</label>
              <input type="text" v-model="bookSet.head.author" :disabled="book.readOnly"></div>
            <div class="cb-field"><label>{{ t('Language') }}</label>
              <select v-model="bookSet.lang" :disabled="book.readOnly">
                <option v-for="l in docLangs" :key="l.code" :value="l.code">{{ l.name }}</option>
              </select></div>
          </div>
          <p class="cb-tip">{{ t('The language is also the one the book calculates in: dates, times and numbers written as text are read as LibreOffice Calc reads them in that language (DATEVALUE, TIMEVALUE, VALUE), and the book’s default typeface is chosen for it.') }}</p>
        </section>
        <section>
          <h4>{{ t('Search engines') }}</h4>
          <div class="cb-field"><label>{{ t('Listing') }}</label>
            <select v-model="bookSet.head.robots" :disabled="book.readOnly">
              <option value="">{{ t('Listed, and its links followed') }}</option>
              <option value="nofollow">{{ t('Listed, but its links not followed') }}</option>
              <option value="noindex">{{ t('Not listed') }}</option>
              <option value="noindex, nofollow">{{ t('Not listed, and its links not followed') }}</option>
            </select></div>
          <div class="cb-field"><label>{{ t('Address of the page (canonical URL)') }}</label>
            <input type="text" v-model="bookSet.head.canonical" placeholder="https://" :disabled="book.readOnly">
            <p class="cb-tip">{{ t('Where the page is published. Only an address beginning with http:// or https:// is written.') }}</p></div>
        </section>
        <section>
          <h4>{{ t('When shared on social media') }}</h4>
          <div class="cb-row">
            <div class="cb-field"><label>{{ t('Title shown') }}</label>
              <input type="text" v-model="bookSet.head.ogTitle" :placeholder="bookSet.title" :disabled="book.readOnly"></div>
            <div class="cb-field"><label>{{ t('Site name') }}</label>
              <input type="text" v-model="bookSet.head.ogSiteName" :disabled="book.readOnly"></div>
          </div>
          <div class="cb-field"><label>{{ t('Description shown') }}</label>
            <textarea rows="2" v-model="bookSet.head.ogDescription" :placeholder="bookSet.head.description" :disabled="book.readOnly"></textarea></div>
          <div class="cb-field"><label>{{ t('Picture (address)') }}</label>
            <input type="text" v-model="bookSet.head.ogImage" placeholder="https://" :disabled="book.readOnly">
            <p class="cb-tip">{{ t('The picture shown with the link. It has to be on the web: a picture inside the book cannot be used.') }}</p></div>
          <div class="cb-row">
            <div class="cb-field"><label>{{ t('Kind of page') }}</label>
              <select v-model="bookSet.head.ogType" :disabled="book.readOnly">
                <option value="">{{ t('Not given') }}</option>
                <option value="article">{{ t('An article') }}</option>
                <option value="website">{{ t('A website') }}</option>
              </select></div>
            <div class="cb-field"><label>{{ t('Card') }}</label>
              <select v-model="bookSet.head.twitterCard" :disabled="book.readOnly">
                <option value="">{{ t('Not given') }}</option>
                <option value="summary">{{ t('Small picture') }}</option>
                <option value="summary_large_image">{{ t('Large picture') }}</option>
              </select></div>
          </div>
        </section>
      </div>
      <div class="foot">
        <button class="cb-btn ghost" @click="bookSet.open = false">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="applyBookSettings" :disabled="book.readOnly">{{ t('Apply') }}</button>
      </div>
    </div>
  </div>

  <!-- cropping a picture (EditBase's): a shape for the frame and a place to look at -->
  <div v-if="cropOpen" class="cb-modal-back">
    <div class="cb-modal cb-crop" style="width:min(520px,100%)" @click.stop>
      <h3>{{ t('Crop') }}</h3>
      <div class="body">
        <div class="cb-field">
          <label>{{ t('Shape') }}</label>
          <select v-model="crop.ratio">
            <option value="">{{ t('The whole picture') }}</option>
            <option value="1 / 1">{{ t('Square (1:1)') }}</option>
            <option value="4 / 3">4 : 3</option>
            <option value="3 / 2">3 : 2</option>
            <option value="16 / 9">16 : 9</option>
            <option value="3 / 4">3 : 4</option>
            <option value="2 / 3">2 : 3</option>
          </select>
        </div>
        <div class="cb-cropbox" v-if="crop.ratio" :style="{ aspectRatio: crop.ratio }" @pointerdown.prevent="cropGrab">
          <img :src="cropSrc" :style="{ objectPosition: crop.x + '% ' + crop.y + '%' }">
          <span class="hint">{{ t('Drag the picture to choose what shows.') }}</span>
        </div>
        <p class="cb-tip">{{ t('Nothing is cut away: the whole picture stays in the file and the frame simply shows part of it, so the crop can be changed or undone at any time.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn ghost" @click="crop.ratio = ''">{{ t('The whole picture') }}</button>
        <button class="cb-btn" @click="cropOpen = false">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="applyCrop">{{ t('Apply') }}</button>
      </div>
    </div>
  </div>
  <div v-if="altOpen" class="cb-modal-back">
    <div class="cb-modal" style="width:min(520px,100%)" @click.stop>
      <h3>{{ t('Alternative text…') }}</h3>
      <div class="body">
        <div class="cb-field"><label>{{ t('Alternative text') }}</label><input type="text" ref="altInput" v-model="altText" maxlength="300" @keydown.enter.prevent="applyAlt"></div>
        <p class="cb-tip">{{ t('This is what a screen reader says, and what shows if the picture cannot be loaded. It is written into the file as the alt attribute.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn ghost" @click="altOpen = false">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="applyAlt">{{ t('Apply') }}</button>
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
              <option value="justify">{{ t('Justified') }}</option>
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
              <button v-for="f in fontMenuList" :key="f" class="it" :class="{ on: cellProps.font === f }" :style="{ fontFamily: fontPreviewStack(f) }" @click="cellProps.font = f">{{ f }}</button>
              <button class="it more" @click="openFonts('cell')">{{ t('Another typeface…') }}</button>
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
            <span :style="{ fontFamily: fontPreviewStack(cellProps.font || fontsInUse.body), fontSize: cellProps.size ? cellProps.size + 'pt' : null, fontWeight: cellProps.b ? 700 : null, fontStyle: cellProps.i ? 'italic' : null, textDecoration: [cellProps.u ? 'underline' : '', cellProps.strike ? 'line-through' : ''].join(' ').trim() || null, color: cellProps.color || null }">{{ t('Aa あア亜 123') }}</span>
          </div>
        </div>
        <div v-if="cellTab === 'border'" class="cb-bd">
          <div class="cb-bd-line">
            <label>{{ t('Line style') }}</label>
            <button v-for="st in borderStyles" :key="st.key" class="cb-bd-st" :class="{ on: bord.style === st.key }" @click="bord.style = st.key">
              <span class="ln" :style="{ borderTop: st.key === 'none' ? '0' : (st.w + 'px ' + st.key + ' currentColor') }"></span><span class="nm">{{ st.label }}</span></button>
            <!-- the thickness as LibreOffice Calc names it (Format Cells, Borders), or a number of pixels -->
            <div class="cb-field"><label>{{ t('Thickness') }}</label>
              <select :value="bordWidthKey" @change="bordWidthPick($event.target.value)">
                <option v-for="w in borderWidths" :key="w.px" :value="String(w.px)">{{ w.label }}</option>
                <option value="custom">{{ t('Custom') }}</option>
              </select></div>
            <div class="cb-field" v-if="bordWidthKey === 'custom'"><label>{{ t('Thickness (px)') }}</label><input type="number" min="1" max="12" step="1" v-model.number="bord.width"></div>
            <div class="cb-field"><label>{{ t('Line colour') }}</label><input type="color" v-model="bord.colour"></div>
          </div>
          <div class="cb-bd-main">
            <!-- LibreOffice Calc's presets (Line arrangement): one cell has four, a range has the outer border with or without the lines inside -->
            <label class="cb-bd-cap">{{ t('Presets') }}</label>
            <div class="cb-bd-presets">
              <button v-for="p in bordPresetList" :key="p.key" class="cb-bd-pp" :class="'pp-' + p.key" @click="bordPreset(p.key)" :title="p.label" :aria-label="p.label"><span class="pp"></span></button>
            </div>
            <label class="cb-bd-cap">{{ t('User-defined') }}</label>
            <div class="cb-bd-pic" :style="{ display: 'grid', gridTemplateColumns: 'repeat(' + (selSpan.cols > 1 ? 2 : 1) + ', 1fr)', gridTemplateRows: 'repeat(' + (selSpan.rows > 1 ? 2 : 1) + ', 1fr)' }">
              <span v-for="n in (selSpan.cols > 1 ? 2 : 1) * (selSpan.rows > 1 ? 2 : 1)" :key="'w' + n" class="txt">{{ t('Words') }}</span>
              <button v-for="e in bordEdges" :key="e" v-show="(e !== 'insideH' || selSpan.rows > 1) && (e !== 'insideV' || selSpan.cols > 1)"
                class="edge" :class="[e, bord.edges[e]]" @click="bordToggle(e)" :title="edgeLabel(e)" :aria-label="edgeLabel(e)"><i class="ln" :style="edgeLineStyle(e)"></i></button>
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

  <!-- the named cell styles of this book (Calc's 「セルスタイル」) -->
  <div v-if="stylesOpen" class="cb-modal-back">
    <div class="cb-modal cb-styles" style="width:min(640px,100%)" @click.stop>
      <h3>{{ t('Cell styles of this book') }}</h3>
      <div class="body">
        <div class="cb-field">
          <label>{{ t('Which style') }}</label>
          <select v-model="styleKey" @change="loadStyleForm">
            <option v-for="st in namedStyleList" :key="st.key" :value="st.key">{{ st.label }}</option>
          </select>
        </div>
        <div class="cb-styleview">
          <span class="cap">{{ t('How it will look') }}</span>
          <div class="paper"><span class="cell" :style="styleSampleCss">{{ t('Sample') }} 1,234.5</span></div>
        </div>
        <div class="cb-row">
          <div class="cb-field"><label>{{ t('Font') }}</label>
            <select v-model="styleForm.font"><option value="">{{ t('Default font') }}</option><option v-for="f in styleFontList" :key="f" :value="f">{{ f }}</option></select></div>
          <div class="cb-field"><label>{{ t('Size (pt)') }}</label><input type="number" min="4" max="200" step="0.5" v-model="styleForm.size" :placeholder="String(settings.fontSize)"></div>
          <div class="cb-field"><label>{{ t('Number format') }}</label>
            <select v-model="styleForm.fmt"><option value="">{{ t('As the cell has it') }}</option><option v-for="nf in numFormats" :key="nf.code" :value="nf.code">{{ nf.label }}</option></select></div>
        </div>
        <div class="cb-inks">
          <button class="cb-tb" :class="{ on: styleForm.b }" @click="styleForm.b = !styleForm.b" :title="t('Bold')"><span class="b">B</span></button>
          <button class="cb-tb" :class="{ on: styleForm.i }" @click="styleForm.i = !styleForm.i" :title="t('Italic')"><span class="i">I</span></button>
          <button class="cb-tb" :class="{ on: styleForm.u }" @click="styleForm.u = !styleForm.u" :title="t('Underline')"><span class="u">U</span></button>
          <span class="sep"></span>
          <button class="cb-tb" :class="{ on: styleForm.ha === 'left' }" @click="styleForm.ha = styleForm.ha === 'left' ? '' : 'left'" :title="t('Align left')" v-html="icons.alignL"></button>
          <button class="cb-tb" :class="{ on: styleForm.ha === 'center' }" @click="styleForm.ha = styleForm.ha === 'center' ? '' : 'center'" :title="t('Centre')" v-html="icons.alignC"></button>
          <button class="cb-tb" :class="{ on: styleForm.ha === 'right' }" @click="styleForm.ha = styleForm.ha === 'right' ? '' : 'right'" :title="t('Align right')" v-html="icons.alignR"></button>
        </div>
        <div class="cb-row">
          <div class="cb-field"><label>{{ t('Text colour') }}</label>
            <div class="colour-pair"><input type="color" :value="styleForm.color || '#000000'" @input="styleForm.color = $event.target.value"><button class="cb-btn ghost" @click="styleForm.color = ''">{{ t('Automatic') }}</button></div></div>
          <div class="cb-field"><label>{{ t('Fill colour') }}</label>
            <div class="colour-pair"><input type="color" :value="styleForm.bg || '#ffffff'" @input="styleForm.bg = $event.target.value"><button class="cb-btn ghost" @click="styleForm.bg = ''">{{ t('No fill') }}</button></div></div>
        </div>
        <div class="cb-row">
          <div class="cb-field"><label>{{ t('Borders') }}</label>
            <select v-model="styleForm.border"><option value="">{{ t('None') }}</option><option value="all">{{ t('All borders') }}</option><option value="bottom">{{ t('Bottom') }}</option><option value="top">{{ t('Top') }}</option><option value="topbottom">{{ t('Top and bottom') }}</option><option value="total">{{ t('Top, and double underneath') }}</option></select></div>
          <div class="cb-field"><label>{{ t('Line colour') }}</label><input type="color" v-model="styleForm.borderColour"></div>
        </div>
        <p class="cb-tip">{{ t('A cell style is a set of formats with a name, kept in the book. Changing it here changes every cell that carries it. Formats put on a cell by hand afterwards go on top of it.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn ghost" @click="resetStyle">{{ t('Reset this style') }}</button>
        <span class="grow"></span>
        <button class="cb-btn" @click="stylesOpen = false">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="applyStyleForm">{{ t('Apply everywhere') }}</button>
      </div>
    </div>
  </div>

  <!-- paper setup: the paper, the header and footer, the scaling -- kept in the book -->
  <div v-if="paperOpen" class="cb-modal-back">
    <div class="cb-modal cb-tabbed" style="width:min(620px,100%)" @click.stop>
      <h3>🖹 {{ t('Paper setup') }}</h3>
      <div class="cb-fp-tabs" role="tablist">
        <button v-for="tb in paperTabs" :key="tb.key" class="cb-fp-tab" :class="{ on: paperTab === tb.key }" role="tab" @click="paperTab = tb.key">{{ tb.label }}</button>
      </div>
      <div class="body">
        <template v-if="paperTab === 'paper'">
        <div class="cb-row">
          <div class="cb-field"><label>{{ t('Paper size') }}</label>
            <select v-model="paper.size" @change="touchPaper"><option v-for="p in paperNames" :key="p" :value="p">{{ p }}</option></select></div>
          <div class="cb-field"><label>{{ t('Orientation') }}</label>
            <select v-model="paper.orientation" @change="touchPaper"><option value="portrait">{{ t('Portrait') }}</option><option value="landscape">{{ t('Landscape') }}</option></select></div>
        </div>
        <div class="cb-row">
          <div class="cb-field"><label>{{ t('Top margin (mm)') }}</label><input type="number" min="0" max="100" step="1" v-model.number="paper.margin.top" @change="touchPaper"></div>
          <div class="cb-field"><label>{{ t('Bottom margin (mm)') }}</label><input type="number" min="0" max="100" step="1" v-model.number="paper.margin.bottom" @change="touchPaper"></div>
          <div class="cb-field"><label>{{ t('Left margin (mm)') }}</label><input type="number" min="0" max="100" step="1" v-model.number="paper.margin.left" @change="touchPaper"></div>
          <div class="cb-field"><label>{{ t('Right margin (mm)') }}</label><input type="number" min="0" max="100" step="1" v-model.number="paper.margin.right" @change="touchPaper"></div>
        </div>
        </template>
        <template v-if="paperTab === 'run'">
        <h4 class="cb-sect">{{ t('Header') }}</h4>
        <div class="cb-row">
          <div class="cb-field"><label>{{ t('Left') }}</label><input type="text" maxlength="120" v-model="paper.header.l" @focus="runAt = ['header', 'l']" @change="touchPaper"></div>
          <div class="cb-field"><label>{{ t('Centre') }}</label><input type="text" maxlength="120" v-model="paper.header.c" @focus="runAt = ['header', 'c']" @change="touchPaper"></div>
          <div class="cb-field"><label>{{ t('Right') }}</label><input type="text" maxlength="120" v-model="paper.header.r" @focus="runAt = ['header', 'r']" @change="touchPaper"></div>
        </div>
        <h4 class="cb-sect">{{ t('Footer') }}</h4>
        <div class="cb-row">
          <div class="cb-field"><label>{{ t('Left') }}</label><input type="text" maxlength="120" v-model="paper.footer.l" @focus="runAt = ['footer', 'l']" @change="touchPaper"></div>
          <div class="cb-field"><label>{{ t('Centre') }}</label><input type="text" maxlength="120" v-model="paper.footer.c" @focus="runAt = ['footer', 'c']" @change="touchPaper"></div>
          <div class="cb-field"><label>{{ t('Right') }}</label><input type="text" maxlength="120" v-model="paper.footer.r" @focus="runAt = ['footer', 'r']" @change="touchPaper"></div>
        </div>
        <h4 class="cb-sect">{{ t('The parts that change') }}</h4>
        <div class="cb-chips">
          <button class="cb-btn ghost" v-for="k in runTokens" :key="k.tag" @click="putRunToken(k.tag)" :title="k.what">{{ k.tag }}</button>
        </div>
        <p class="cb-tip">{{ t('Anything in braces is filled in as the sheet is printed: {page} is the number of the page and {pages} how many there are (both counted by the printer), {sheet} the name of the sheet, {title} the name of the book, {name} its file name, and {date} and {time} the day and hour it was printed.') }}</p>
        </template>
        <template v-if="paperTab === 'scale'">
        <div class="cb-field"><label>{{ t('Scaling') }}</label>
          <select v-model="paper.scale" @change="touchPaper">
            <option value="none">{{ t('As it is (100%)') }}</option>
            <option value="fit">{{ t('Fit the columns to the width of the page') }}</option>
            <option value="pages">{{ t('Fit to a number of pages') }}</option>
          </select></div>
        <div class="cb-row" v-if="paper.scale === 'pages'">
          <div class="cb-field"><label>{{ t('Pages wide') }}</label><input type="number" min="1" max="50" step="1" v-model.number="paper.wide" @change="touchPaper"></div>
          <div class="cb-field"><label>{{ t('Pages tall') }}</label><input type="number" min="1" max="500" step="1" v-model.number="paper.tall" @change="touchPaper"></div>
        </div>
        <label class="opt"><input type="checkbox" v-model="paper.grid" @change="touchPaper"> {{ t('Print the gridlines') }}</label>
        <label class="opt"><input type="checkbox" v-model="paper.headings" @change="touchPaper"> {{ t('Print the row numbers and column letters') }}</label>
        <div class="cb-row">
          <div class="cb-field"><label>{{ t('Rows to repeat at the top of every page') }}</label><input type="number" min="0" max="20" step="1" v-model.number="paper.repeat" @change="touchPaper"></div>
        </div>
        <p class="cb-tip">{{ t('{n} pages', { n: printPageCount }) }} · {{ paperLabel }}</p>
        </template>
        <!-- The book's own typefaces (EditBase's "Text and typefaces"): the face of the cells and of the headings. -->
        <template v-if="paperTab === 'text'">
        <p class="cb-tip">{{ t('These are the book’s own defaults — what cells are set in when nothing else has been said about them. To change some cells, use the typeface box in the toolbar; it acts on the selected cells.') }}</p>
        <div class="cb-field">
          <label>{{ t('Default typefaces') }}</label>
          <div class="font-rows">
            <button v-for="r in fontRoles" :key="r.key" class="font-row" @click="openFonts(r.key)" :disabled="book.readOnly">
              <span class="role">{{ r.label }}</span>
              <span class="fam" :style="{ fontFamily: fontPreviewStack(fontsInUse[r.key]) }">{{ fontsInUse[r.key] }}</span>
              <span class="tag" v-if="!bookFonts[r.key]">{{ t('default') }}</span>
              <span class="caret" v-html="icons.down"></span>
            </button>
          </div>
          <p class="cb-tip">{{ t('Any family on Google Fonts can be used. The book carries its typefaces with it, so the file looks the same on a machine where they are not installed.') }}</p>
        </div>
        </template>
        <p class="cb-tip" v-if="paperTab !== 'text'">{{ t('The paper setup is written into the book, so the file prints the same way wherever it is opened. “Page breaks” under View draws where the pages fall.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn ghost" @click="saveDefaultPaper">{{ t('Use for new books') }}</button>
        <span class="grow"></span>
        <button class="cb-btn primary" @click="paperOpen = false">{{ t('Done') }}</button>
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
            <select v-model="paper.size" @change="touchPaper"><option v-for="p in paperNames" :key="p" :value="p">{{ p }}</option></select></div>
          <div class="cb-field"><label>{{ t('Orientation') }}</label>
            <select v-model="paper.orientation" @change="touchPaper"><option value="portrait">{{ t('Portrait') }}</option><option value="landscape">{{ t('Landscape') }}</option></select></div>
        </div>
        <label class="opt"><input type="checkbox" v-model="paper.grid" @change="touchPaper"> {{ t('Print the gridlines') }}</label>
        <label class="opt"><input type="checkbox" :checked="paper.repeat > 0" @change="paper.repeat = $event.target.checked ? Math.max(1, paper.repeat) : 0; touchPaper()"> {{ t('Repeat the first row on every page') }}</label>
        <label class="opt"><input type="checkbox" :checked="paper.scale === 'fit'" @change="paper.scale = $event.target.checked ? 'fit' : 'none'; touchPaper()"> {{ t('Fit the columns to the width of the page') }}</label>
        <label class="opt"><input type="checkbox" v-model="paper.headings" @change="touchPaper"> {{ t('Print the row numbers and column letters') }}</label>
        <p class="cb-tip">{{ t('{n} pages', { n: printPageCount }) }} · {{ paperLabel }}</p>
        <p class="cb-tip">{{ t('The browser’s print dialogue opens next; choose “Save as PDF” there for a PDF.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn ghost" @click="printOpen = false; openPaper()">{{ t('Paper setup') }}…</button>
        <span class="grow"></span>
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

  <!-- Who else on this server may read or write in this book. -->
  <div v-if="share.open" class="cb-modal-back">
    <div class="cb-modal" style="width:min(520px,100%)" @click.stop>
      <h3>{{ share.category ? t('Share the category “{name}”', { name: share.title }) : t('Share “{name}”', { name: share.title }) }}</h3>
      <div class="body">
        <div class="cb-field">
          <label>{{ t('Give it to someone on this server') }}</label>
          <input type="text" v-model="share.term" @input="findShareUsers" :placeholder="t('Name or account')" autocomplete="off">
        </div>
        <ol class="cb-people" v-if="share.found.length">
          <li v-for="u in share.found" :key="u.id">
            <span class="who"><span class="nm">{{ u.name }}</span><span class="id">{{ u.id }}</span></span>
            <button class="cb-btn ghost" @click="addShare(u.id, false)">{{ t('May read') }}</button>
            <button class="cb-btn ghost" @click="addShare(u.id, true)">{{ t('May write') }}</button>
          </li>
        </ol>
        <h4 class="cb-sect">{{ t('Shared with') }}</h4>
        <p class="cb-tip" v-if="share.busy">{{ t('Loading…') }}</p>
        <p class="cb-tip" v-else-if="!share.list.length">{{ t('Nobody yet. It is yours alone.') }}</p>
        <ol class="cb-people" v-else>
          <li v-for="p in share.list" :key="p.id">
            <span class="who"><span class="nm">{{ p.name }}</span><span class="id">{{ p.group ? t('Group') : p.with }}</span></span>
            <label class="opt"><input type="checkbox" :checked="p.canEdit" @change="addShare(p.with, $event.target.checked)"> {{ t('May write') }}</label>
            <button class="cb-btn ghost danger" @click="dropShare(p.id)">{{ t('Stop sharing') }}</button>
          </li>
        </ol>
        <p class="cb-tip" v-if="share.category">{{ t('A category is a folder, so every book filed in it is shared, and so is every book filed in it afterwards. Somebody who may write in it can add books to it as well.') }}</p>
        <p class="cb-tip">{{ t('This is Nextcloud’s own sharing: the same share shows in Files, and it can be taken back from either place. A book shared with you appears under “Shared with me” in the list.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn primary" @click="share.open = false">{{ t('Done') }}</button>
      </div>
    </div>
  </div>

  <!-- What is wrong with the book that cannot be seen by looking. -->
  <div v-if="checkOpen" class="cb-modal-back" @click="checkOpen = false">
    <div class="cb-modal" style="width:min(620px,100%)" @click.stop>
      <h3>{{ t('Check the book') }}</h3>
      <div class="body">
        <p class="cb-tip" v-if="!checks.length">{{ t('Nothing to report: no error values, no formula pointing only at empty cells, no numbers kept as text, and every column fits on the paper.') }}</p>
        <template v-else>
          <p class="cb-tip">{{ t('{n} things found. Press one to go to the cell.', { n: checks.length }) }}</p>
          <ol class="cb-checks">
            <li v-for="(c, i) in checks" :key="i">
              <span class="kind" :class="c.kind">{{ c.label }}</span>
              <span class="what">{{ c.what }}</span>
              <button class="cb-btn ghost" @click="showCheck(i)">{{ c.where }}</button>
            </li>
          </ol>
        </template>
      </div>
      <div class="foot">
        <button class="cb-btn ghost" @click="runCheck()">{{ t('Look again') }}</button>
        <button class="cb-btn primary" @click="checkOpen = false">{{ t('Done') }}</button>
      </div>
    </div>
  </div>

  <!-- What a book is: told from the file. -->
  <div v-if="props.open" class="cb-modal-back" @click="props.open = false">
    <div class="cb-modal" style="width:min(460px,100%)" @click.stop>
      <h3>{{ props.title }}</h3>
      <div class="body">
        <dl class="cb-props">
          <dt>{{ t('File name') }}</dt><dd>{{ props.name }}</dd>
          <dt>{{ t('Where it is') }}</dt><dd>{{ props.where }}</dd>
          <dt>{{ t('Size') }}</dt><dd>{{ size(props.size) }}</dd>
          <dt>{{ t('Last saved') }}</dt><dd>{{ when(props.mtime) }}</dd>
          <dt>{{ t('Sheets') }}</dt><dd>{{ props.sheets }}</dd>
          <dt>{{ t('Cells with something in them') }}</dt><dd>{{ props.cells }}</dd>
          <dt>{{ t('Formulas') }}</dt><dd>{{ props.formulas }}</dd>
          <dt>{{ t('Paper') }}</dt><dd>{{ props.paper }}</dd>
        </dl>
      </div>
      <div class="foot">
        <button class="cb-btn primary" @click="props.open = false">{{ t('Done') }}</button>
      </div>
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

  <!-- a question with one answer: a name, a number, a few lines, one of a list -->
  <div v-if="ask.open" class="cb-modal-back" @click="askAnswer(null)">
    <div class="cb-modal" style="width:min(440px,100%)" @click.stop>
      <h3>{{ ask.title }}</h3>
      <div class="body">
        <div class="cb-field"><label v-if="ask.label">{{ ask.label }}</label>
          <div class="cb-choices" v-if="ask.options">
            <label v-for="o in ask.options" :key="o.value" class="opt"><input type="radio" :value="o.value" v-model="ask.value"> {{ o.label }}</label>
          </div>
          <textarea v-else-if="ask.multiline" ref="askInput" rows="4" v-model="ask.value" @keydown.esc.prevent="askAnswer(null)"></textarea>
          <input v-else ref="askInput" :type="ask.number ? 'number' : 'text'" v-model="ask.value" :min="ask.min" :max="ask.max" :step="ask.step || null" @keydown.enter.prevent="askAnswer(ask.value)" @keydown.esc.prevent="askAnswer(null)"></div>
        <p class="cb-tip" v-if="ask.tip">{{ ask.tip }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn ghost danger" v-if="ask.removable" @click="askAnswer('')">{{ ask.removeLabel }}</button>
        <span class="grow" v-if="ask.removable"></span>
        <button class="cb-btn" @click="askAnswer(null)">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="askAnswer(ask.value)">{{ t('OK') }}</button>
      </div>
    </div>
  </div>

  <!-- the Files picker: a folder to move to, a file to make a book from or to bring in, a picture -->
  <div v-if="picker.open" class="cb-modal-back" @click="pickerAnswer(null)">
    <div class="cb-modal" @click.stop>
      <h3>{{ pickerTitle }}</h3>
      <div class="body">
        <div class="fp-path">
          <button class="cb-tb" @click="pickerUp" :disabled="!picker.path" :title="t('Up')"><span v-html="icons.up"></span></button>
          <span class="crumbs">{{ picker.path || '/' }}</span>
        </div>
        <div class="fp-list">
          <p class="cb-tip" v-if="picker.busy" style="padding:10px">{{ t('Loading…') }}</p>
          <template v-else>
            <button v-for="it in picker.items" :key="it.path" class="fp-item" :class="{ on: picker.chosen === it.path, dim: picker.mode !== 'folder' && !it.dir && !it.ok }"
              @click="pickerClick(it)" @dblclick="pickerOpen(it)">
              <span class="ic" v-html="it.dir ? icons.folder : (it.image ? icons.image : icons.doc)"></span>
              <span class="nm">{{ it.name }}</span>
              <span class="meta" v-if="!it.dir">{{ size(it.size) }}</span>
            </button>
            <p class="cb-tip" v-if="!picker.items.length" style="padding:10px">{{ t('Nothing here.') }}</p>
          </template>
        </div>
        <p class="cb-tip" v-if="picker.mode === 'import'">{{ t('The file is only read. A new book is made from it in your save folder, and the file itself stays as it was.') }}</p>
        <p class="cb-tip" v-else-if="picker.mode === 'bring'">{{ t('The file is only read. Its sheets are put into this book as new sheets, which Ctrl+Z takes out again.') }}</p>
        <p class="cb-tip" v-else-if="picker.mode === 'image'">{{ t('The picture is embedded in the book itself, so it travels with the file. Large photographs are scaled down on the way in.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn" @click="pickerAnswer(null)">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="pickerAnswer(picker.mode === 'folder' ? (picker.chosen || picker.path) : picker.chosen)" :disabled="picker.mode !== 'folder' && !picker.chosen">{{ pickerOk }}</button>
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

  <!-- the other apps on this server, a web page, a file: what comes in, before it comes in -->
  <div v-if="sourceOpen" class="cb-modal-back">
    <div class="cb-modal cb-source" style="width:min(640px,100%)" @click.stop>
      <h3><span class="cb-srcmark">{{ sourceMark(source) }}</span> {{ sourceLabel(source) }}</h3>
      <div class="body">
        <p class="cb-tip" v-if="src.loading">{{ t('Loading…') }}</p>
        <p class="cb-tip err" v-if="src.error">{{ src.error }}</p>
        <!-- contacts: a few words to look for, or everybody -->
        <div class="cb-srcsearch" v-if="source === 'contacts' && !src.fragment">
          <input type="text" v-model="src.query" @keydown.enter.prevent="loadContacts" :placeholder="t('Search contacts…')">
          <button class="cb-btn" @click="loadContacts">{{ t('Search') }}</button>
        </div>
        <!-- the calendar asks for a range -->
        <div class="cb-row" v-if="source === 'calendar' && !src.fragment">
          <div class="cb-field"><label>{{ t('From') }}</label><input type="date" v-model="src.from"></div>
          <div class="cb-field"><label>{{ t('To') }}</label><input type="date" v-model="src.to"></div>
          <div class="cb-field"><label>{{ t('Calendar') }}</label>
            <select v-model="src.calendar"><option value="">{{ t('All calendars') }}</option><option v-for="c in src.calendars" :key="c.key" :value="c.key">{{ c.name }}</option></select></div>
        </div>
        <!-- a list to choose from: collections, documents, tables -->
        <div class="fp-list" v-if="src.items.length && !src.fragment">
          <button v-for="x in src.items" :key="x.id" class="fp-item" @click="openSourceItem(x)">
            <span class="ic">{{ x.icon || x.emoji || sourceMark(source) }}</span><span class="nm">{{ x.name || x.title }}</span><span class="meta">{{ itemMeta(x) }}</span>
          </button>
        </div>
        <p class="cb-tip" v-if="src.listed && !src.items.length && !src.fragment && !src.loading && !src.error">{{ t('There is nothing here yet.') }}</p>
        <!-- what will come in: the sheets, and the first rows of the first -->
        <template v-if="src.fragment">
          <p class="cb-tip">{{ fragmentSummary(src.fragment) }}</p>
          <div class="cb-srcsheets" v-if="src.fragment.sheets.length > 1">
            <button v-for="(s, i) in src.fragment.sheets" :key="i" class="cb-btn ghost xs" :class="{ on: src.shown === i }" @click="src.shown = i">{{ s.name }}</button>
          </div>
          <div class="src-preview">
            <table class="cb-table"><tr v-for="(row, i) in fragmentPreview(src.fragment, src.shown)" :key="i"><td v-for="(cell, j) in row" :key="j">{{ cell }}</td></tr></table>
          </div>
          <p class="cb-tip">{{ t('“Add as new sheets” puts each sheet after the last one; “Put it at the cursor” writes the first sheet into this one from the selected cell. Either way one Ctrl+Z takes it out again.') }}</p>
        </template>
      </div>
      <div class="foot">
        <button class="cb-btn ghost" v-if="src.fragment && (src.items.length || source === 'calendar' || source === 'contacts')" @click="src.fragment = null">{{ t('Back') }}</button>
        <span class="grow"></span>
        <button class="cb-btn" v-if="source === 'calendar' && !src.fragment" @click="loadCalendarFragment" :disabled="src.loading">{{ t('Show the events') }}</button>
        <button class="cb-btn" v-if="src.fragment" @click="insertFragment(src.fragment, 'here')">{{ t('Put it at the cursor') }}</button>
        <button class="cb-btn primary" v-if="src.fragment" @click="insertFragment(src.fragment, 'sheets')">{{ t('Add as new sheets') }}</button>
        <button class="cb-btn ghost" @click="sourceOpen = false">{{ t('Close') }}</button>
      </div>
    </div>
  </div>

  <!-- the tables of a web page -->
  <div v-if="webOpen" class="cb-modal-back">
    <div class="cb-modal" style="width:min(560px,100%)" @click.stop>
      <h3>{{ t('The tables of a web page') }}</h3>
      <div class="body">
        <div class="cb-field"><label>{{ t('Web address') }}</label>
          <input type="text" ref="webInput" v-model="webUrl" placeholder="https://example.org/page" @keydown.enter.prevent="fetchWebTables"></div>
        <p class="cb-tip">{{ t('Every table on the page comes in, one sheet each. The page is fetched by this server, which never reaches into the local network unless the administrator allows it.') }}</p>
        <p class="cb-tip" v-if="webBusy">{{ t('Fetching…') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn ghost" @click="webOpen = false">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" :disabled="webBusy || !webUrl" @click="fetchWebTables">{{ t('Read the page') }}</button>
      </div>
    </div>
  </div>

  <!-- sorting by up to three columns -->
  <div v-if="sortOpen" class="cb-modal-back">
    <div class="cb-modal" style="width:min(520px,100%)" @click.stop>
      <h3>{{ t('Sort') }} <span class="cb-tip" style="font-weight:400">{{ sortUi.range }}</span></h3>
      <div class="body">
        <label class="opt"><input type="checkbox" v-model="sortUi.header" @change="sortCols()"> {{ t('The first row is a header and stays') }}</label>
        <div class="cb-row" v-for="(k, i) in sortUi.keys" :key="i">
          <div class="cb-field"><label>{{ i === 0 ? t('Sort by') : t('Then by') }}</label>
            <select v-model="k.col"><option value="">{{ t('(none)') }}</option><option v-for="c in sortUi.cols" :key="c.c" :value="c.c">{{ c.label }}</option></select></div>
          <div class="cb-field"><label>{{ t('Order') }}</label>
            <select v-model.number="k.dir"><option :value="1">{{ t('Ascending') }}</option><option :value="-1">{{ t('Descending') }}</option></select></div>
        </div>
        <p class="cb-tip">{{ t('Numbers come before text and empty cells go last, as in LibreOffice Calc. Formulas move with their rows.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn" @click="sortOpen = false">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="applySort">{{ t('Sort') }}</button>
      </div>
    </div>
  </div>

  <!-- text to columns -->
  <div v-if="splitOpen" class="cb-modal-back">
    <div class="cb-modal" style="width:min(520px,100%)" @click.stop>
      <h3>{{ t('Text to columns') }} <span class="cb-tip" style="font-weight:400">{{ selText }}</span></h3>
      <div class="body">
        <div class="cb-field"><label>{{ t('Separator') }}</label>
          <select v-model="splitUi.sep"><option value=",">{{ t('Comma') }}</option><option value="tab">{{ t('Tab') }}</option><option value=";">{{ t('Semicolon') }}</option><option value=" ">{{ t('Space') }}</option><option value="、">{{ t('Japanese comma (、)') }}</option><option value="other">{{ t('Other') }}</option></select></div>
        <div class="cb-field" v-if="splitUi.sep === 'other'"><label>{{ t('Other separator') }}</label><input type="text" v-model="splitUi.other" maxlength="5"></div>
        <label class="opt"><input type="checkbox" v-model="splitUi.trim"> {{ t('Trim spaces round each part') }}</label>
        <p class="cb-tip">{{ t('The text of each cell in the first selected column is split and written into the cells to its right. Numbers and dates are read as such.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn" @click="splitOpen = false">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" @click="applySplit">{{ t('Split') }}</button>
      </div>
    </div>
  </div>

  <!-- defined names -->
  <div v-if="namesOpen" class="cb-modal-back">
    <div class="cb-modal" style="width:min(540px,100%)" @click.stop>
      <h3>{{ t('Define a name') }}</h3>
      <div class="body">
        <div class="cb-row">
          <div class="cb-field"><label>{{ t('Name') }}</label><input type="text" ref="nameInput" v-model="nameForm.name" :placeholder="t('Total')" @keydown.enter.prevent="addName"></div>
          <div class="cb-field"><label>{{ t('Range') }}</label><input type="text" v-model="nameForm.range" placeholder="$Sheet1.$A$1:$B$5" @keydown.enter.prevent="addName"></div>
        </div>
        <button class="cb-btn" @click="addName" :disabled="book.readOnly">{{ t('Add') }}</button>
        <h4 class="cb-sect">{{ t('Names in this book') }}</h4>
        <p class="cb-tip" v-if="!nameList.length">{{ t('None yet.') }}</p>
        <ol class="cb-people" v-else>
          <li v-for="n in nameList" :key="n.name">
            <span class="who"><span class="nm">{{ n.name }}</span><span class="id">{{ n.ref }}</span></span>
            <button class="cb-btn ghost" @click="namesOpen = false; goToName(n.name)">{{ t('Go there') }}</button>
            <button class="cb-btn ghost danger" @click="removeName(n.name)" :disabled="book.readOnly">{{ t('Delete') }}</button>
          </li>
        </ol>
        <p class="cb-tip">{{ t('A name stands for a cell or a range. Type it in the name box to go there and select it. The names are kept in the book.') }}</p>
        <p class="cb-tip" v-if="!namesInFormulas">{{ t('Formulas cannot use the names yet: a name typed in a formula shows #NAME?.') }}</p>
      </div>
      <div class="foot">
        <button class="cb-btn primary" @click="namesOpen = false">{{ t('Done') }}</button>
      </div>
    </div>
  </div>

  <!-- characters that are awkward to type -->
  <div v-if="charsOpen" class="cb-modal-back" @click="charsOpen = false">
    <div class="cb-modal" style="width:min(620px,100%)" @click.stop>
      <h3>{{ t('Special character…') }}</h3>
      <div class="body">
        <div class="cb-chips">
          <button v-for="c in charSets" :key="c.key" class="cb-btn ghost xs" :class="{ on: charSet === c.key }" @click="charSet = c.key">{{ t(c.key) }}</button>
        </div>
        <div class="cb-chargrid">
          <button v-for="(ch, i) in charsOf(charSet)" :key="i" class="cb-charcell" @mousedown.prevent @click="pickChar(ch)">{{ ch }}</button>
        </div>
        <p class="cb-tip">{{ t('The character goes into the cell being edited. The dialog stays open so several can be picked.') }}</p>
      </div>
      <div class="foot"><button class="cb-btn primary" @click="charsOpen = false; finishPicked()">{{ t('Close') }}</button></div>
    </div>
  </div>

  <!-- emoji -->
  <div v-if="emojiOpen" class="cb-modal-back" @click="emojiOpen = false">
    <div class="cb-modal" style="width:min(620px,100%)" @click.stop>
      <h3>{{ t('Emoji…') }}</h3>
      <div class="body">
        <input class="cb-emoji-search" type="text" v-model="emojiQuery" :placeholder="t('Search emoji')">
        <div class="cb-emoji-tabs" v-if="!emojiQuery">
          <button v-for="g in emojiGroups" :key="g.key" class="cb-emoji-tab" :class="{ on: emojiTab === g.key }"
            @click="emojiTab = g.key" :title="t(g.key)">{{ g.tab }}</button>
        </div>
        <div class="cb-emoji-cat">{{ emojiQuery ? t('{n} found', { n: emojiShown.length }) : t(emojiTab) }}</div>
        <div class="cb-emoji-grid">
          <button v-for="em in emojiShown" :key="em" class="cb-emoji-btn" @mousedown.prevent @click="pickEmoji(em)" :title="emojiName(em)">{{ em }}</button>
        </div>
        <p class="cb-tip">{{ t('The emoji goes into the cell being edited. The dialog stays open so several can be picked.') }}</p>
      </div>
      <div class="foot"><button class="cb-btn primary" @click="emojiOpen = false; finishPicked()">{{ t('Close') }}</button></div>
    </div>
  </div>

  <!-- keyboard shortcuts -->
  <div v-if="keysOpen" class="cb-modal-back" @click="keysOpen = false">
    <div class="cb-modal" style="width:min(640px,100%)" @click.stop>
      <h3>⌨ {{ t('Keyboard shortcuts') }}</h3>
      <div class="body">
        <dl class="cb-keys">
          <template v-for="(k, i) in keyHelp" :key="i"><dt>{{ k[0] }}</dt><dd>{{ k[1] }}</dd></template>
        </dl>
      </div>
      <div class="foot"><button class="cb-btn primary" @click="keysOpen = false">{{ t('Close') }}</button></div>
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

  <!-- Backspace: Calc's Delete Contents -->
  <div v-if="delc.open" class="cb-modal-back" @click="closeDeleteContents">
    <div class="cb-modal cb-delc" style="width:min(400px,100%)" @click.stop @keydown.enter.prevent="$event.target.tagName === 'BUTTON' ? $event.target.click() : applyDeleteContents()" @keydown.esc.prevent.stop="closeDeleteContents">
      <h3>{{ t('Delete Contents') }}</h3>
      <div class="body">
        <div class="cb-sect">{{ t('Selection') }}</div>
        <label class="opt"><input type="checkbox" v-model="delc.all"> {{ t('Delete all') }}</label>
        <div class="cb-delc-kinds" :class="{ dim: delc.all }">
          <label class="opt"><input type="checkbox" v-model="delc.text" :disabled="delc.all"> {{ t('Text') }}</label>
          <label class="opt"><input type="checkbox" v-model="delc.numbers" :disabled="delc.all"> {{ t('Values') }}</label>
          <label class="opt"><input type="checkbox" v-model="delc.dates" :disabled="delc.all"> {{ t('Date and time') }}</label>
          <label class="opt"><input type="checkbox" v-model="delc.formulas" :disabled="delc.all"> {{ t('Formulas') }}</label>
          <label class="opt"><input type="checkbox" v-model="delc.notes" :disabled="delc.all"> {{ t('Comments') }}</label>
          <label class="opt"><input type="checkbox" v-model="delc.formats" :disabled="delc.all"> {{ t('Formats') }}</label>
          <label class="opt"><input type="checkbox" v-model="delc.objects" :disabled="delc.all"> {{ t('Pictures') }}</label>
        </div>
      </div>
      <div class="foot">
        <button class="cb-btn" @click="closeDeleteContents">{{ t('Cancel') }}</button>
        <button class="cb-btn primary" ref="delcOk" @click="applyDeleteContents">{{ t('OK') }}</button>
      </div>
    </div>
  </div>

  <!-- the right button: the app's own menu, never the browser's -->
  <div v-if="ctx.open" class="cb-ctx-back" @mousedown.prevent @click="closeCtxIfSettled" @touchend.prevent="closeCtxIfSettled" @contextmenu.prevent="closeCtx"></div>
  <div v-if="ctx.open" class="cb-ctxmenu" :class="{ flip: ctx.flip, tall: ctx.tall }" :style="{ left: ctx.x + 'px', top: ctx.y + 'px', maxHeight: ctx.tall ? ctx.tall + 'px' : null }" @mousedown.prevent @contextmenu.prevent>
    <!-- The right button on a category in the list down the left. -->
    <template v-if="ctx.kind === 'cat'">
      <div class="hd">{{ ctx.cat.label }}</div>
      <button class="ci" v-if="ctx.cat.key && !ctx.cat.theirs" @click="shareCategory(ctx.cat)">{{ t('Share…') }}</button>
      <div class="sep" v-if="ctx.cat.key && !ctx.cat.theirs"></div>
      <div class="cb-swatches cat">
        <button v-for="c in catColourChoices" :key="c.value || 'none'" class="sw" :class="{ on: (ctx.cat.colour || '') === c.value }"
          :style="c.value ? { background: c.value } : {}" :title="c.label" @click="setCatColour(ctx.cat.key, c.value)"></button>
      </div>
      <template v-if="bookOrder['c:' + ctx.cat.key]">
        <div class="sep"></div>
        <button class="ci" @click="saveBookOrder(ctx.cat.key, null); closeCtx()">{{ t('Order by last change again') }}</button>
      </template>
      <template v-if="ctx.cat.key && !ctx.cat.theirs">
        <div class="sep"></div>
        <button class="ci danger" @click="deleteCategory(ctx.cat)">{{ t('Delete the category') }}</button>
      </template>
    </template>
    <!-- The right button on a book in the list. -->
    <template v-else-if="ctx.kind === 'book'">
      <div class="hd">{{ ctx.book.title || ctx.book.name }}</div>
      <button class="ci" @click="closeCtx(); openBook(ctx.book.id)">{{ t('Open') }}</button>
      <div class="sep"></div>
      <button class="ci" v-if="!ctx.book.readOnly" @click="renameBook(ctx.book)">{{ t('Rename…') }}</button>
      <button class="ci" v-if="ctx.book.canDownload !== false" @click="duplicateBook(ctx.book.id)">{{ t('Duplicate') }}</button>
      <div class="ci has-sub" v-if="!ctx.book.shared" @mouseenter="placeFly" @click="toggleFly">
        <span>{{ t('Move to…') }}</span><span class="s">›</span>
        <div class="fly">
          <button class="ci" :class="{ on: !bookFolder(ctx.book) }" @click="moveBook(ctx.book, '')">{{ t('No category') }}</button>
          <button class="ci" v-for="f in folders" :key="f" :class="{ on: bookFolder(ctx.book) === f }" @click="moveBook(ctx.book, f)">{{ f }}</button>
          <div class="sep"></div>
          <button class="ci" @click="moveBookToFolder(ctx.book)">{{ t('Another folder in Files…') }}</button>
        </div>
      </div>
      <button class="ci" v-if="ctx.book.canDownload !== false" @click="downloadBook(ctx.book)">{{ t('Download') }}</button>
      <button class="ci" @click="openVersions(ctx.book)">{{ t('Versions…') }}</button>
      <button class="ci" v-if="!ctx.book.shared" @click="openShare(ctx.book)">{{ t('Share…') }}</button>
      <button class="ci" @click="openBookProps(ctx.book)">{{ t('Properties…') }}</button>
      <button class="ci" @click="openBookSettings(ctx.book)">{{ t('Book settings…') }}</button>
      <div class="sep"></div>
      <button class="ci danger" @click="deleteBook(ctx.book)">{{ t('Delete') }}</button>
    </template>
    <!-- a sheet: its tab at the foot, or its picture in the sheet bar -->
    <template v-else-if="ctx.kind === 'sheet'">
      <div class="hd">{{ sheetNames[ctx.sheet] }}</div>
      <button class="ci" @click="closeCtx(); switchSheet(ctx.sheet)">{{ t('Go to this sheet') }}</button>
      <div class="sep"></div>
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
    <!-- the status bar: what it adds up, as Calc's -->
    <template v-else-if="ctx.kind === 'status'">
      <div class="hd">{{ t('Shown in the status bar') }}</div>
      <button class="ci" :class="{ on: statusBar.sum }" @click="toggleStat('sum')">{{ t('Sum') }}</button>
      <button class="ci" :class="{ on: statusBar.avg }" @click="toggleStat('avg')">{{ t('Average') }}</button>
      <button class="ci" :class="{ on: statusBar.count }" @click="toggleStat('count')">{{ t('Count') }}</button>
      <button class="ci" :class="{ on: statusBar.counta }" @click="toggleStat('counta')">{{ t('Not empty') }}</button>
      <button class="ci" :class="{ on: statusBar.min }" @click="toggleStat('min')">{{ t('Minimum') }}</button>
      <button class="ci" :class="{ on: statusBar.max }" @click="toggleStat('max')">{{ t('Maximum') }}</button>
    </template>
    <!-- a picture over the sheet -->
    <template v-else-if="ctx.kind === 'image'">
      <div class="hd">{{ t('Picture') }}</div>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); imageCmd('fit')">{{ t('Fit to the cell') }}</button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); imageCmd('original')">{{ t('Original size') }}</button>
      <div class="sep"></div>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); openCrop()">{{ t('Crop…') }}</button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); openAlt()">{{ t('Alternative text…') }}</button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); lightenPictures()">{{ t('Make the pictures lighter') }}</button>
      <div class="sep"></div>
      <button class="ci danger" :disabled="book.readOnly" @click="closeCtx(); imageCmd('delete')"><span>{{ t('Delete the picture') }}</span><span class="s k">Delete</span></button>
    </template>
    <template v-else-if="ctx.kind === 'col' || ctx.kind === 'row'">
      <div class="hd">{{ ctx.kind === 'col' ? t('Column {n}', { n: colLetter(ctx.col) }) : t('Row {n}', { n: ctx.row + 1 }) }}</div>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); clipCut()"><span>{{ t('Cut') }}</span><span class="s k">Ctrl+X</span></button>
      <button class="ci" @click="closeCtx(); clipCopy()"><span>{{ t('Copy') }}</span><span class="s k">Ctrl+C</span></button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); clipPasteButton()"><span>{{ t('Paste') }}</span><span class="s k">Ctrl+V</span></button>
      <div class="sep"></div>
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
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); openCellProps('number')"><span>{{ t('Cell properties…') }}</span><span class="s k">Ctrl+1</span></button>
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
          <button class="ci" :disabled="book.readOnly" @click="closeCtx(); insertCells()">{{ t('Cells…') }}</button>
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
      <template v-if="curLink">
        <button class="ci" @click="closeCtx(); openCurLink()"><span>{{ t('Open the link') }}</span><span class="s k">Ctrl+click</span></button>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); openLink()">{{ t('Edit the link…') }}</button>
        <button class="ci" :disabled="book.readOnly" @click="closeCtx(); setLink('')">{{ t('Remove the link') }}</button>
      </template>
      <button v-else class="ci" :disabled="book.readOnly" @click="closeCtx(); openLink()"><span>{{ t('Hyperlink…') }}</span><span class="s k">Ctrl+K</span></button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); openNote()">{{ curNote ? t('Edit the comment…') : t('Comment…') }}</button>
      <button class="ci" v-if="curNote" :disabled="book.readOnly" @click="closeCtx(); setNote('')">{{ t('Delete the comment') }}</button>
      <div class="sep"></div>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); sortSel(1)">{{ t('Sort ascending') }}</button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); sortSel(-1)">{{ t('Sort descending') }}</button>
      <button class="ci" :disabled="book.readOnly" @click="closeCtx(); toggleMerge()">{{ selIsMerged ? t('Unmerge cells') : t('Merge cells') }}</button>
      <div class="sep"></div>
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
  const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];

  const app = createApp({
    template: TEMPLATE,
    data() {
      return {
        version: '',
        logo: LOGO,
        icons: ICONS,
        palette: PALETTE,
        fontSizes: FONT_SIZES,
        // the typeface picker (EditBase's): who it is choosing for, and what is shown of the catalogue
        fontsOpen: false, fontRole: 'selection', fontQuery: '', fontPage: 1, fontCat: 'all', fontScript: 'auto',
        fontList: [], fontScripts: [], fontsLoading: false, usedFonts: [],
        // what belongs to the book as a whole besides its paper: its typefaces, its language, its head (Book settings)
        bookFonts: { body: '', heading: '' }, bookLang: 'ja', bookHead: normaliseHead({}), defaultBookFonts: { body: '', heading: '' },
        bookSet: { open: false, title: '', lang: 'ja', head: normaliseHead({}) },
        // a picture: the part of it the frame shows, and what it says to a screen reader (EditBase's)
        cropOpen: false, cropSrc: '', crop: { ratio: '', x: 50, y: 50 }, cropId: '',
        altOpen: false, altText: '', altId: '', lightening: false,
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
          enterMoves: 'down', aiW: 500, aiU: 'px', showGrid: true, sheetTabs: false, cellLimit: 100000, font: '', fontSize: 11, sheetsW: 132, sheetsU: 'px',
          unit: 'px', spellcheck: false, autolink: true },
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
        stats: { sum: '', avg: '', count: 0, counta: 0, min: '', max: '' },
        fmtNow: { b: 0, i: 0, u: 0, strike: 0, color: '', bg: '', ha: '', va: '', wrap: 0, font: '', size: '', fmt: '', style: '' },
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
        // what to print; the paper itself is the book's (paper)
        print: { range: 'sheet' },
        ask: { open: false, title: '', label: '', value: '', tip: '', number: false, min: null, max: null, resolve: null },
        picker: { open: false, mode: 'folder', path: '', items: [], busy: false, chosen: '', resolve: null },
        exportOpen: false, exportFmt: 'xlsx', exporting: false,
        filterPop: { open: false, x: 0, y: 0, col: -1, values: [], checked: new Set() },
        // The AI assistant: shown only when AI-Hub is there and the administrator allows this person.
        ai: { show: false, ready: false, reason: '', model: '', open: false, msgs: [], input: '', busy: false, error: '', composing: false, ask: 0, read: [], busyText: '',
          // images waiting to go with the next question; whether this AI connection takes images
          images: [], attNote: '', drop: false, imagesOk: false },
        // ---- phase 2: the chrome as EditBase's ----
        // the categories (folders inside the save folder) and how the list is laid out
        folders: [], openCat: '', catColours: {}, bookOrder: {}, naming: false, catNew: '',
        dragBook: 0, dropBook: null, dropCat: null,
        menuOpen: false, build: '', newBuild: false,
        // the other apps on this server, and what is being brought in from one
        sources: {}, sourceOpen: false, source: '',
        src: { loading: false, error: '', items: [], listed: false, fragment: null, shown: 0, calendars: [], from: '', to: '', calendar: '', query: '' },
        webOpen: false, webUrl: '', webBusy: false,
        // what belongs to the book as a whole: its paper, its names, its cell styles
        paper: defaultPaper(), paperOpen: false, paperTab: 'paper', runAt: ['footer', 'c'],
        names: {}, namesOpen: false, nameForm: { name: '', range: '' }, namesInFormulas: false,
        bookStyles: {}, stylesOpen: false, styleKey: 'Heading 1',
        styleForm: { font: '', size: '', fmt: '', b: false, i: false, u: false, ha: '', color: '', bg: '', border: '', borderColour: '#333333' },
        sizeTyping: null,
        // what the screen shows (not saved in the book)
        view: { headings: true, fbar: true, formulas: false, zeros: true, breaks: false },
        sheetBar: { open: false }, dragSheet: -1, dropSheet: -1,
        statusBar: { sum: true, avg: true, count: true, counta: false, min: false, max: false },
        share: { open: false, id: 0, title: '', term: '', found: [], list: [], category: false, busy: false },
        checkOpen: false, checks: [],
        props: { open: false, title: '', name: '', where: '', size: 0, mtime: 0, sheets: '', cells: '', formulas: '', paper: '' },
        sortOpen: false, sortUi: { range: '', g: null, header: false, cols: [], keys: [] },
        splitOpen: false, splitUi: { sep: ',', other: '', trim: true },
        charsOpen: false, charSet: 'Punctuation',
        emojiOpen: false, emojiQuery: '', emojiTab: '', emojiLoading: false, emojiTick: 0,
        keysOpen: false,
        notePop: { text: '', x: 0, y: 0 },
        imgSel: null, aiSplitting: false, sheetSplitting: false,
        // the key that shows the formulas (Ctrl+`), written here: the template is itself a template literal
        backtick: String.fromCharCode(96),
        // Backspace's "Delete Contents": the boxes ticked as Calc ticks them at first, then as last left
        delc: { open: false, all: false, text: true, numbers: true, dates: true, formulas: true, notes: true, formats: false, objects: false },
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
      /** LibreOffice Calc's thicknesses (Format Cells, Borders), each the nearest whole pixel the book keeps. */
      borderWidths() {
        this.i18nTick;
        return [{ px: 1, label: this.t('Thin (0.75 pt)') }, { px: 2, label: this.t('Medium (1.5 pt)') }, { px: 3, label: this.t('Thick (2.25 pt)') }, { px: 6, label: this.t('Extra thick (4.5 pt)') }];
      },
      bordWidthKey() { return !this.bord.custom && this.borderWidths.some((w) => w.px === this.bord.width) ? String(this.bord.width) : 'custom'; },
      /** LibreOffice Calc's presets: for one cell, and for a range (with the lines inside it). */
      bordPresetList() {
        this.i18nTick;
        const rows = this.selSpan.rows > 1; const cols = this.selSpan.cols > 1;
        if (!rows && !cols) {
          return [{ key: 'none', label: this.t('Remove Borders') }, { key: 'box', label: this.t('All Four Borders') },
            { key: 'lr', label: this.t('Left and Right Borders') }, { key: 'tb', label: this.t('Top and Bottom Borders') }];
        }
        const list = [{ key: 'none', label: this.t('Remove Borders') }, { key: 'outerOnly', label: this.t('Outer Border Only') }];
        if (rows) { list.push({ key: 'outerH', label: this.t('Outer Border and Horizontal Lines') }); }
        if (cols) { list.push({ key: 'outerV', label: this.t('Outer Border and Vertical Lines') }); }
        list.push({ key: 'all', label: this.t('Outer Border and All Inner Lines') }, { key: 'outline', label: this.t('Outer Border Without Changing Inner Lines') },
          { key: 'inside', label: this.t('Inside') });
        return list;
      },
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
      // the selection is kept outside Vue: what the name box shows is read, so that a new selection is a new answer
      selSpan() { this.selText; this.tick; const g = this.selRange(); return { rows: g.r1 - g.r0 + 1, cols: g.c1 - g.c0 + 1 }; },
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
      // ---- phase 2 ----
      /** The books by category, as EditBase's docGroups: uncategorised first, then each folder, then what others shared. */
      bookGroups() {
        this.i18nTick;
        const groups = new Map();
        const put = (key, label, b) => {
          if (!groups.has(key)) { groups.set(key, { key, label, books: [], colour: this.catColours[key] || '', theirs: key.charAt(0) === '~' }); }
          if (b) { groups.get(key).books.push(b); }
        };
        put('', this.t('Not in a category'), null);
        this.folders.forEach((f) => put(f, f, null));
        this.books.forEach((b) => {
          if (b.shared) {
            const f = this.bookFolder(b);
            put(f ? '~shared/' + f : '~shared', f ? this.t('{folder} — from {who}', { folder: f, who: b.owner }) : this.t('Shared with me'), b);
            return;
          }
          const f = this.bookFolder(b);
          put(f, f || this.t('Not in a category'), b);
        });
        const out = Array.from(groups.values());
        // a category sorted by hand keeps that order; books not in it (new ones) go on top, as they were
        out.forEach((g) => {
          const ord = this.bookOrder['c:' + g.key];
          if (!ord || !ord.length) { return; }
          const pos = new Map(ord.map((id, i) => [id, i]));
          const at = (b) => (pos.has(b.id) ? pos.get(b.id) : -1);
          g.books = g.books.map((b, i) => ({ b, i })).sort((a, c) => (at(a.b) - at(c.b)) || (a.i - c.i)).map((x) => x.b);
        });
        return out.filter((g) => g.books.length || (g.key !== '' && g.key !== '~shared'));
      },
      catColourChoices() {
        this.i18nTick;
        return [{ value: '', label: this.t('None') }, { value: '#e8eefc', label: this.t('Blue') }, { value: '#e6f6ec', label: this.t('Green') }, { value: '#fdf3e0', label: this.t('Yellow') },
          { value: '#fbe9e9', label: this.t('Red') }, { value: '#f0eafc', label: this.t('Purple') }, { value: '#e6f5f7', label: this.t('Teal') }, { value: '#efefef', label: this.t('Grey') }];
      },
      namedStyleList() {
        this.i18nTick;
        const keys = NAMED_STYLES.map((x) => x.key);
        Object.keys(this.bookStyles).forEach((k) => { if (!keys.includes(k)) { keys.push(k); } });
        return keys.map((key) => ({ key, label: this.t(key) }));
      },
      styleSampleCss() {
        const s = this.styleFormToProps();
        const css = { fontWeight: s.b ? 700 : 400, fontStyle: s.i ? 'italic' : 'normal', textDecoration: s.u ? 'underline' : 'none', color: s.color || (s.bg ? inkFor(s.bg) : '#111111'), background: s.bg || '#ffffff', textAlign: s.ha || 'left' };
        css.fontFamily = fontStack(s.font || (HEADING_STYLES.indexOf(this.styleKey) >= 0 ? this.fontsInUse.heading : this.fontsInUse.body), 'sans'); if (s.size) { css.fontSize = s.size + 'pt'; }
        ['bt', 'br', 'bb', 'bl'].forEach((k, i) => { if (s[k]) { css[['borderTop', 'borderRight', 'borderBottom', 'borderLeft'][i]] = s[k]; } });
        return css;
      },
      // ---- typefaces (EditBase's) ----
      /** The faces the book's cells and headings are set in: the book's own, else the person's default, else the language's. */
      fontsInUse() {
        const body = this.bookFonts.body || this.settings.font || defaultCellFont(this.bookLang);
        return { body, heading: this.bookFonts.heading || body };
      },
      fontRoles() {
        this.i18nTick;
        return [{ key: 'body', label: this.t('Cells') }, { key: 'heading', label: this.t('Headings') }];
      },
      fontRoleLabel() {
        this.i18nTick;
        if (this.fontRole === 'selection') { return this.t('The cells you have chosen'); }
        if (this.fontRole === 'cell') { return this.t('Cell properties'); }
        if (this.fontRole === 'setting') { return this.t('Default font'); }
        const r = this.fontRoles.find((x) => x.key === this.fontRole);
        return r ? r.label : '';
      },
      fontCats() {
        this.i18nTick;
        return [
          { key: 'all', label: this.t('All') },
          { key: 'serif', label: this.t('Serif') },
          { key: 'sans', label: this.t('Sans serif') },
          { key: 'display', label: this.t('Display') },
          { key: 'handwriting', label: this.t('Handwriting') },
          { key: 'mono', label: this.t('Monospace') },
        ];
      },
      docScript() { return scriptFor(this.bookLang); },
      /** The language's own face for cells (what "default" means when nothing is chosen). */
      defaultCellFontName() { return defaultCellFont(this.bookLang); },
      /** What "default" is for the face being chosen. */
      defaultFontName() {
        if (this.fontRole === 'heading') { return this.fontsInUse.body; }
        if (this.fontRole === 'body') { return this.settings.font || defaultCellFont(this.bookLang); }
        if (this.fontRole === 'setting') { return defaultCellFont(this.bookLang); }
        return this.fontsInUse.body;
      },
      /** The face the open picker has chosen now ('' = the default). */
      fontChosen() {
        if (this.fontRole === 'selection') { return this.fmtNow.font || ''; }
        if (this.fontRole === 'cell') { return this.cellProps.font || ''; }
        if (this.fontRole === 'setting') { return this.settings.font || ''; }
        return this.bookFonts[this.fontRole] || '';
      },
      fontResults() {
        const q = this.fontQuery.trim().toLowerCase();
        const script = this.fontScript === 'auto' ? this.docScript : this.fontScript;
        return this.fontList.filter((f) => {
          if (q && f.f.toLowerCase().indexOf(q) < 0) { return false; }
          if (this.fontCat !== 'all' && f.c !== this.fontCat) { return false; }
          if (this.fontScript !== 'all' && script && f.s.indexOf(script) < 0) { return false; }
          return true;
        });
      },
      fontPageItems() { return this.fontResults.slice(0, this.fontPage * 24); },
      previewFamily() { return this.fontChosen || this.defaultFontName; },
      sampleText() {
        const samples = {
          japanese: 'あの日見た花の名前を僕達はまだ知らない。永字八法 1234567890',
          'chinese-simplified': '天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。1234567890',
          'chinese-traditional': '天地玄黃，宇宙洪荒。日月盈昃，辰宿列張。1234567890',
          korean: '다람쥐 헌 쳇바퀴에 타고파. 1234567890',
          arabic: 'نص حكيم له سر قاطع وذو شأن عظيم ١٢٣٤٥٦٧٨٩٠',
          hebrew: 'דג סקרן שט בים מאוכזב ולפתע מצא חברה 1234567890',
          devanagari: 'ऋषियों को सताने वाले दुष्ट राक्षसों के राजा रावण का 1234567890',
          thai: 'เป็นมนุษย์สุดประเสริฐเลิศคุณค่า ๑๒๓๔๕๖๗๘๙๐',
          cyrillic: 'Съешь же ещё этих мягких французских булок 1234567890',
          vietnamese: 'Do bạch kim rất quý nên sẽ dùng để lắp vô xe. 1234567890',
        };
        return samples[this.docScript] || 'The quick brown fox jumps over the lazy dog. 1234567890';
      },
      /** The faces offered by name (the cell properties, a cell style): the book's own, then the ones used in it. */
      /** The languages a book can say it is in (EditBase's list), with the book's own if it is another. */
      docLangs() {
        const list = [['ja', '日本語'], ['en', 'English'], ['zh-CN', '中文（简体）'], ['zh-TW', '中文（繁體）'],
          ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['it', 'Italiano'],
          ['pt', 'Português'], ['ru', 'Русский']].map(([code, name]) => ({ code, name }));
        const now = this.bookSet.lang;
        if (now && !list.some((l) => l.code === now)) { list.unshift({ code: now, name: now }); }
        return list;
      },
      fontMenuList() {
        return [this.fontsInUse.body, this.fontsInUse.heading].concat(this.usedFonts).filter((f, i, all) => f && all.indexOf(f) === i);
      },
      styleFontList() {
        const list = this.fontMenuList.slice();
        if (this.styleForm.font && list.indexOf(this.styleForm.font) < 0) { list.push(this.styleForm.font); }
        return list;
      },
      sourceKeys() { return ['regibase', 'formulabase', 'editbase', 'netbase', 'tables', 'contacts', 'calendar'].filter((k) => this.sources[k]); },
      anySource() { return this.sourceKeys.length > 0; },
      paperTabs() { this.i18nTick; return [{ key: 'paper', label: this.t('Paper') }, { key: 'text', label: this.t('Text and typefaces') }, { key: 'run', label: this.t('Header and footer') }, { key: 'scale', label: this.t('Scaling and what is printed') }]; },
      runTokens() {
        this.i18nTick;
        const what = { page: this.t('The number of the page'), pages: this.t('How many pages there are'), sheet: this.t('The name of the sheet'), title: this.t('The name of the book'),
          name: this.t('The name of the file'), date: this.t('The day it was printed'), time: this.t('The time it was printed') };
        return RUN_TOKENS.map((k) => ({ tag: '{' + k + '}', what: what[k] }));
      },
      paperLabel() { this.i18nTick; return this.paperLabelOf(this.paper); },
      /** How many pages the active sheet prints on, with the book's paper setup. */
      printPageCount() {
        this.tick;
        const sh = this.sheet(); if (!sh || !wb) { return 0; }
        this.refreshUsed();
        const g = this.print.range === 'selection' ? (() => { const s = this.selRange(); return { r0: s.r0, c0: s.c0, r1: Math.min(s.r1, Math.max(sh.maxR, s.r0)), c1: Math.min(s.c1, Math.max(sh.maxC, s.c0)) }; })() : null;
        if (this.print.range === 'book') { return UIS.reduce((n, u) => n + this.pagesOf(u).pages.length, 0); }
        return this.pagesOf(sh, g).pages.length;
      },
      nameList() { return Object.keys(this.names).sort((a, b) => a.localeCompare(b)).map((name) => ({ name, ref: this.names[name] })); },
      curLink() { this.tick; this.selText; const sh = this.sheet(); if (!sh) { return ''; } const m = sh.meta.get(K(this.sel.cur.r, this.sel.cur.c)); return (m && m.link) || ''; },
      curNote() { this.tick; this.selText; const sh = this.sheet(); if (!sh) { return ''; } const m = sh.meta.get(K(this.sel.cur.r, this.sel.cur.c)); return (m && m.note) || ''; },
      charSets() { return CHAR_SETS; },
      emojiGroups() { this.emojiTick; return EMOJI ? EMOJI.groups : []; },
      emojiShown() {
        this.emojiTick;
        if (!EMOJI) { return []; }
        const q = kana(String(this.emojiQuery || '').trim());
        if (!q) { const g = EMOJI.groups.find((x) => x.key === this.emojiTab) || EMOJI.groups[0]; return g ? g.e : []; }
        const out = [];
        EMOJI.groups.forEach((g) => { g.e.forEach((em) => { if (out.length < 400 && kana(EMOJI.names[em] || '').includes(q)) { out.push(em); } }); });
        return out;
      },
      pickerTitle() {
        this.i18nTick;
        return { import: this.t('Make a book from a CSV, ODS, XLSX or Markdown file'), bring: this.t('Bring in a CSV, ODS, XLSX or Markdown file'), image: this.t('Insert picture') }[this.picker.mode] || this.t('Choose a folder');
      },
      pickerOk() {
        this.i18nTick;
        return { import: this.t('Make the book'), bring: this.t('Bring it in'), image: this.t('Insert') }[this.picker.mode] || this.t('Choose this folder');
      },
      keyHelp() {
        this.i18nTick;
        return [
          ['Enter / Shift+Enter', this.t('Enter what was typed and move down (or right, as the settings say) / back')],
          ['Tab / Shift+Tab', this.t('Enter and move right / left')],
          ['F2', this.t('Edit the cell, the caret at the end')],
          ['Esc', this.t('Leave the cell as it was')],
          ['Ctrl+Enter / Alt+Enter', this.t('A new line inside the cell')],
          ['F4', this.t('Cycle the $ of the reference at the caret')],
          ['Ctrl+Z / Ctrl+Y', this.t('Undo / redo')],
          ['Ctrl+C / Ctrl+X / Ctrl+V', this.t('Copy / cut / paste (formulas move along)')],
          ['Ctrl+Shift+V', this.t('Paste values only')],
          ['Ctrl+D', this.t('Fill down')],
          ['Ctrl+L / Ctrl+E / Ctrl+R', this.t('Align left / centre / right')],
          ['Ctrl+B / Ctrl+I / Ctrl+U', this.t('Bold / italic / underline')],
          ['Ctrl+1', this.t('Cell properties')],
          ['Ctrl+K', this.t('Hyperlink')],
          ['Ctrl+; / Ctrl+Shift+;', this.t('Today’s date / the time now')],
          ['Ctrl+Shift+L', this.t('AutoFilter')],
          ['Ctrl++ / Ctrl+-', this.t('Insert cells / delete cells')],
          ['Alt+=', this.t('AutoSum')],
          ['Ctrl+`', this.t('Show the formulas, or the values again')],
          ['Ctrl+F', this.t('Find and replace')],
          ['Ctrl+S', this.t('Save')],
          ['Ctrl+A', this.t('Select the whole sheet')],
          ['Ctrl+Arrow', this.t('To the edge of the block of data, or of the sheet')],
          ['End', this.t('To the last column in use')],
          ['Ctrl+* (' + this.t('keypad') + ')', this.t('Select the block of data round the cursor')],
          ['Ctrl+Home / Ctrl+End', this.t('To A1 / to the last cell used')],
          ['Ctrl+PageUp / Ctrl+PageDown', this.t('The sheet before / after')],
          ['Ctrl+Space / Shift+Space', this.t('Select the column / the row')],
          ['Delete / Backspace', this.t('Empty the cells, keeping their formats / choose what to delete')],
        ];
      },
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
          this.ask = Object.assign({ open: true, title: '', label: '', value: '', tip: '', number: false, min: null, max: null, step: null }, opts, { resolve });
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
        await this.loadFolders();
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
          // A new book goes into the category that is open, as in EditBase.
          const drawer = this.bookGroups.find((g) => g.key === this.openCat);
          const where = drawer && !drawer.theirs ? drawer.key : '';
          const title = name.trim() || this.t('Untitled book');
          // written here, as EditBase writes a new document: in the person's language (which the book then calculates in)
          const created = await api('books', { method: 'POST', body: { name: title, folder: where, content: this.blankBookHtml(title) } });
          await this.loadBooks();
          await this.openBook(created.id);
          this.notify(this.t('Created {name}', { name: created.title || String(created.name || '').replace(/\.html?$/i, '') }));
        } catch (e) { this.notify(this.t('Could not create the book: {msg}', { msg: e.message })); }
      },
      /** A new book's file: one empty sheet, the person's language and paper, written as every save writes it. */
      blankBookHtml(title) {
        const ui = newSheetUI('Sheet1'); ui.grid = this.settings.showGrid !== false;
        const lang = uiLang();
        // the typefaces kept with the default paper ("Use for new books", as EditBase keeps them in its paper)
        const fonts = normaliseFonts(this.defaultBookFonts);
        const body = fonts.body || this.settings.font || defaultCellFont(lang); const head = fonts.heading || body;
        return buildHtml(title, [ui], () => ({}), 0, lang, { paper: normalisePaper(this.defaultPaperSetting), fonts, bodyFont: body, headingFont: head, fontUrl: fontsUrl([body, head]) });
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
          const listed = this.books.find((b) => b.id === d.id) || {};
          this.book = { id: d.id, name: d.title || String(d.name || '').replace(/\.html?$/i, ''), path: d.path || '', folder: listed.folder || d.folder || '', etag: d.etag || '', readOnly: !!d.readOnly, download: d.canDownload !== false, shared: !!listed.shared };
          this.dirty = false; this.saveError = ''; this.savedAt = 0;
          this.history = []; this.redoStack = []; this.canUndo = false; this.canRedo = false;
          // a book made before the limit, or elsewhere, is shown as it is but not changed: nothing in it is lost
          const over = this.overLimit();
          if (over) { this.book.readOnly = true; this.notify(over + ' ' + this.t('This book is shown read-only.'), 12000); }
          try { window.localStorage.setItem('cb-last-book', String(d.id)); } catch (e) { /* not kept */ }
          if (listed.folder != null && this.bookGroups.some((g) => g.key === (listed.shared ? (listed.folder ? '~shared/' + listed.folder : '~shared') : listed.folder))) { this.openCat = listed.shared ? (listed.folder ? '~shared/' + listed.folder : '~shared') : listed.folder; }
          this.$nextTick(() => { this.layout(); this.focusGrid(); this.scheduleThumbs(); });
        } catch (e) { this.notify(this.t('Could not open the book: {msg}', { msg: e.message })); }
        finally { if (ticket === this._openTicket) { this.opening = false; } }
      },
      /** The file's text becomes the engine's workbook and the page's sheets. */
      loadContent(html, name) {
        const parsed = parseBook(html);
        // what belongs to the book as a whole: its typefaces, its language (which the calculation reads in), its head
        this.bookFonts = normaliseFonts(parsed.book.fonts);
        this.bookLang = parsed.book.lang || uiLang();
        this.bookHead = normaliseHead(parsed.book.head);
        wb = Calc.workbook({ locale: calcLocaleOf(this.bookLang) });
        wb.load(parsed.model);
        // General limited to the book's own number of decimals, if it has one (an older ODS file)
        if (Calc.standardDecimals) { Calc.standardDecimals(wb.calc ? wb.calc.decimals : null); }
        if (wb.recalc) { try { wb.recalc(); } catch (e) { /* the engine already recalculated on load */ } }
        UIS = parsed.uis;
        UIS.forEach((u) => { if (!u.grid && this.settings.showGrid === false) { u.grid = false; } });
        // what belongs to the book as a whole: a book that has no paper of its own starts from the person's default
        this.paper = parsed.book.hasPaper ? parsed.book.paper : normalisePaper(this.defaultPaperSetting);
        // a book with no paper of its own (made by the server) starts from the person's default typefaces too
        if (!parsed.book.hasPaper && !this.bookFonts.body && !this.bookFonts.heading) { this.bookFonts = normaliseFonts(this.defaultBookFonts); }
        this.names = parsed.book.names; this.bookStyles = parsed.book.styles;
        // the names came in with the model (wb.load): formulas use them
        this.namesInFormulas = !!(wb && typeof wb.defineName === 'function');
        this.imgSel = null; this._pbCache = null;
        this.syncRowState();
        this.active = parsed.model.active || 0;
        this.sel = { ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], cur: { r: 0, c: 0 }, anchor: { r: 0, c: 0 } };
        this.tick += 1;
        this.syncSel();
        if (this.$refs.scroller) { this.$refs.scroller.scrollTop = 0; this.$refs.scroller.scrollLeft = 0; }
        this.refreshUsedFonts();
        this.$nextTick(() => this.applyBookFonts());
      },
      currentHtml() {
        const sheets = new Map();
        const read = (name, r, c) => { let s = sheets.get(name); if (s === undefined) { try { s = wb.sheet(name); } catch (e) { s = name; } sheets.set(name, s); } return wb.get(s, r, c); };
        read.used = (name) => { const u = UIS.find((x) => x.name === name); return u ? { r1: u.maxR, c1: u.maxC } : null; };
        const fonts = new Map();
        read.font = (meta) => {
          const st = (meta && meta.s) || {}; const key = (st.b ? 'b' : '') + '|' + (st.size || '') + '|' + (st.font || '') + '|' + ((meta && meta.style) || '');
          let f = fonts.get(key); if (f === undefined) { const cf = this.cellFont(meta, 1); f = fontCss(st.b, cf.px, cf.family); fonts.set(key, f); }
          return f;
        };
        // the names as the engine keeps them: they follow inserted rows and renamed sheets
        if (typeof wb.getNames === 'function') {
          const now = wb.getNames();
          if (JSON.stringify(now) !== JSON.stringify(this.names)) { this.names = now; }
          read.names = (name) => { try { return wb.getNames(name); } catch (e) { return null; } };
        }
        this.refreshUsed();
        return buildHtml(this.book.name || this.t('Untitled book'), UIS, read, this.active, this.bookLang || uiLang(), {
          paper: this.paper, names: this.names, styles: this.bookStyles, calc: wb.calc || null,
          fonts: this.bookFonts, bodyFont: this.fontsInUse.body, headingFont: this.fontsInUse.heading, fontUrl: fontsUrl(this.bookFamilies()),
          head: this.bookHead,
        });
      },
      /** How far each sheet is used, from the engine's cells (the page's own note grows as cells are typed, and this trims it). */
      refreshUsed() {
        // straight from the engine's map of cells when it has one: building the whole model took most of a second on 100,000 rows
        if (typeof wb.sheet === 'function' && wb.sheets && wb.sheets.every((s) => s.cells instanceof Map)) {
          UIS.forEach((u) => {
            let es = null; try { es = wb.sheet(u.name); } catch (e) { es = null; }
            if (!es) { return; }
            let r1 = 0; let c1 = 0;
            for (const cell of es.cells.values()) { if (!cell.t && !cell.f) { continue; } if (cell.r > r1) { r1 = cell.r; } if (cell.c > c1) { c1 = cell.c; } }
            u.maxR = r1; u.maxC = c1;
          });
          return;
        }
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
          const items = (r.entries || r.items || []).map((it) => ({ name: it.name, path: it.path || (path + '/' + it.name).replace(/\/+/g, '/'), dir: !!(it.is_dir || it.dir || it.type === 'dir' || it.type === 'folder'), size: it.size || 0, ok: this.picker.mode === 'image' ? /\.(png|jpe?g|gif|webp)$/i.test(it.name || '') : /\.(csv|tsv|txt|ods|xlsx|md|markdown)$/i.test(it.name || ''), image: /\.(png|jpe?g|gif|webp)$/i.test(it.name || ''), id: it.id || it.fileId || 0 }));
          items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
          this.picker.items = this.picker.mode === 'folder' ? items.filter((it) => it.dir) : items;
        } catch (e) { this.picker.items = []; this.notify(this.t('Could not read the folder: {msg}', { msg: e.message })); }
        this.picker.busy = false;
      },
      pickerUp() { const s = this.picker.path.replace(/\/+$/, ''); const i = s.lastIndexOf('/'); this.pickerLoad(i > 0 ? s.slice(0, i) : ''); },
      pickerClick(it) { if (it.dir && this.picker.mode === 'folder') { this.picker.chosen = it.path; } else if (!it.dir && it.ok) { this.picker.chosen = it.path; this.picker.chosenItem = it; } },
      pickerOpen(it) { if (it.dir) { this.pickerLoad(it.path); } else if (it.ok) { this.picker.chosen = it.path; this.picker.chosenItem = it; this.pickerAnswer(it.path); } },
      pickerAnswer(v) {
        const res = this.picker.resolve;
        this.picker.open = false; this.picker.resolve = null;
        if (res) { res(v == null ? null : (this.picker.mode !== 'folder' ? (this.picker.chosenItem || { path: v }) : v)); }
      },
      // ---- import / export ----
      async importBook() {
        const it = await this.openPicker('import');
        if (!it) { return; }
        try {
          // A Markdown file's pipe tables come in through their own route, as sheets.
          const md = /\.(md|markdown|mdown|mkd)$/i.test(it.name || it.path || '');
          const r = await api(md ? 'import/markdown' : 'import', { method: 'POST', body: { fileId: it.id, path: it.path } });
          const model = r.model || r;
          if (!model || !Array.isArray(model.sheets) || !model.sheets.length) { throw new Error(this.t('Nothing came back that could be put on a sheet.')); }
          const name = String((!md && r.name) || it.name || 'Imported').replace(/\.(csv|tsv|txt|ods|xlsx|md|markdown|html?)$/i, '');
          const drawer = this.bookGroups.find((g) => g.key === this.openCat);
          const created = await api('books', { method: 'POST', body: { name, folder: drawer && !drawer.theirs ? drawer.key : '' } });
          await this.loadBooks();
          await this.openBook(created.id);
          // the imported model replaces the empty book
          wb = Calc.workbook({ locale: calcLocaleOf(this.bookLang) }); wb.load(model); if (wb.recalc) { wb.recalc(); }
          if (Calc.standardDecimals) { Calc.standardDecimals(wb.calc ? wb.calc.decimals : null); }
          UIS = uisFromModel(model); this.active = Math.min(model.active || 0, UIS.length - 1);
          this.names = typeof wb.getNames === 'function' ? wb.getNames() : (model.names || {});
          // A formula's cell keeps the file's General: Calc shows =DATE(…) of a file as the number the file
          // says, and gives a formula a format of its own only when it is typed (CalcBase BUGS #31)
          (model.sheets || []).forEach((ms, i) => {
            const ui = UIS[i]; if (!ui) { return; }
            Object.keys(ms.cells || {}).forEach((key) => {
              const cell = ms.cells[key]; if (!cell || !cell.f || cell.fmt) { return; }
              const p = parseRef(key); if (!p) { return; }
              const g = wb.get(ms.name, p.r, p.c);
              if (g.fmtHint || g.fmtHintCode) { const meta = ui.meta.get(K(p.r, p.c)); ui.meta.set(K(p.r, p.c), Object.assign({ fmt: '', s: null }, meta || {}, { fmt: 'General' })); }
            });
          });
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
          const model = this.withBookFonts(toFullModel(wb, UIS, this.active, true));
          const r = await api('export', { method: 'POST', body: { format: this.exportFmt, model, folder: this.book.folder || this.book.path.replace(/\/[^/]*$/, ''), name: this.book.name, sheet: this.exportFmt === 'csv' ? this.sheetName() : undefined } });
          this.exportOpen = false;
          this.notify(this.t('Written to {path}', { path: r.where || r.name || r.path || '' }), 5000);
        } catch (e) { this.notify(this.t('Could not export: {msg}', { msg: e.message }), 6000); }
        this.exporting = false;
      },

      /**
       * The book's own typefaces named on its cells, for a file that has no book of its own to name them
       * (ODS, XLSX): a cell set in the book's face says so, as a cell with a face of its own does, so
       * LibreOffice and Excel show it in the same face. A book that has not chosen faces names none.
       */
      withBookFonts(model) {
        const own = this.bookFonts;
        if (!own.body && !own.heading) { return model; }
        (model.sheets || []).forEach((ms) => {
          const ui = UIS.find((u) => u.name === ms.name); if (!ui) { return; }
          Object.keys(ms.cells || {}).forEach((key) => {
            const cell = ms.cells[key]; if (!cell || (cell.s && cell.s.font)) { return; }
            const p = parseRef(key); if (!p) { return; }
            const meta = ui.meta.get(K(p.r, p.c));
            const heading = meta && meta.style && HEADING_STYLES.indexOf(meta.style) >= 0;
            const fam = (heading && own.heading) || own.body;
            if (fam && (cell.t || !isEmptyObj(cell.s))) { cell.s = Object.assign({}, cell.s || {}, { font: fam }); }
          });
        });
        return model;
      },

      // ---- saving ----
      touch() {
        if (this.opening) { return; }
        this._edits = (this._edits || 0) + 1;
        this._pbCache = null;
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
            // the stylesheet of the book's faces names only families the catalogue knows: it is asked for first if it is not in yet
            if (fontsWanted()) { await this.ensureFontCatalogue(); }
            const over = this.overLimit();
            if (over) { throw new Error(over); }
            const content = this.currentHtml();
            if (new Blob([content]).size > LIMIT_BYTES) { throw new Error(this.sizeLimitText()); }
            try {
              saved = await api('books/' + book.id, { method: 'PUT', body: { content, etag: book.etag || '', manual: !!asked } });
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
          const tmp = Calc.workbook({ locale: calcLocaleOf(this.bookLang) }); tmp.load(parsed.model); if (tmp.recalc) { tmp.recalc(); }
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
        // a share of the window keeps a tenth (the edge's arrow keys move it by 10 px, under one per cent)
        n = u === '%' ? Math.round(n * 10) / 10 : Math.round(n);
        if (this.settings.aiW !== n) { this.settings.aiW = n; }
        if (this.settings.aiU !== u) { this.settings.aiU = u; }
        return n + u;
      },
      aiWidth() { return this.aiWidthValue().replace(/%$/, 'vw'); },
      aiWidthChanged() { this.aiWidthValue(); },
      // ---- the edge of the AI assistant: dragged to set its width (every Base app's) ----
      /** The column's width in pixels now, and the bounds the settings allow, in pixels. */
      aiWidthPx() { const n = Number(this.settings.aiW) || 500; return Math.round(this.settings.aiU === '%' ? n * window.innerWidth / 100 : n); },
      aiWidthBounds() { const W = window.innerWidth || 1200; return this.settings.aiU === '%' ? { min: Math.round(W * 0.15), max: Math.round(W * 0.6) } : { min: 240, max: 1200 }; },
      /** A width in pixels put into the settings in their own unit (a percentage stays a share of the window), held to their bounds. */
      aiSetPx(px) {
        if (this.settings.aiU === '%') { const pct = px / Math.max(1, window.innerWidth) * 100; this.settings.aiW = Math.round(Math.min(60, Math.max(15, pct)) * 10) / 10; }
        else { this.settings.aiW = Math.round(Math.min(1200, Math.max(240, px))); }
      },
      /** Kept where the settings are kept, so the settings show the same number and the next visit opens at it. */
      async aiSaveWidth() {
        const value = (this.settings.aiU === '%' ? Number(this.settings.aiW) : Math.round(Number(this.settings.aiW))) + (this.settings.aiU === '%' ? '%' : 'px');
        if (this.settingsSaved) { try { const was = JSON.parse(this.settingsSaved); was.aiW = this.settings.aiW; was.aiU = this.settings.aiU; this.settingsSaved = JSON.stringify(was); } catch (e) { /* the dialog keeps its own */ } }
        try { await api('settings', { method: 'POST', body: { aiWidth: value } }); } catch (e) { this.notify(this.t('Could not save the settings: {msg}', { msg: e.message })); }
        this.$nextTick(() => this.layout());
      },
      aiSplitDown(e) {
        const col = e.currentTarget.parentElement; if (!col) { return; }
        const x0 = e.clientX; const w0 = col.getBoundingClientRect().width; const before = this.settings.aiW;
        this.aiSplitting = true; document.body.classList.add('cb-splitting');
        const move = (ev) => { this.aiSetPx(w0 + (x0 - ev.clientX)); this.layout(); };
        const up = () => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
          this.aiSplitting = false; document.body.classList.remove('cb-splitting');
          if (this.settings.aiW !== before) { this.aiSaveWidth(); }
        };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      },
      aiSplitReset() { this.settings.aiU = 'px'; this.settings.aiW = 500; this.aiSaveWidth(); },
      // ---- the left-hand edge of the sheet bar (the owner, 2026-10-06): worked as the assistant's edge ----
      sheetsWidthPx() { const n = Number(this.settings.sheetsW) || 132; return Math.round(this.settings.sheetsU === '%' ? n * window.innerWidth / 100 : n); },
      sheetsWidthBounds() { const W = window.innerWidth || 1200; return this.settings.sheetsU === '%' ? { min: Math.round(W * 0.03), max: Math.round(W * 0.6) } : { min: 60, max: 1200 }; },
      /** A width in pixels put into the settings in their own unit (a percentage stays a share of the window), held to their bounds. */
      sheetsSetPx(px) {
        // never past 70% of the window together with the assistant beside it (EditBase's right-hand column), so the sheet keeps its room
        const ai = this.$el && this.$el.querySelector && this.$el.querySelector('.ai-col');
        px = Math.min(px, Math.max(60, window.innerWidth * 0.7 - (ai ? ai.getBoundingClientRect().width : 0)));
        if (this.settings.sheetsU === '%') { const pct = px / Math.max(1, window.innerWidth) * 100; this.settings.sheetsW = Math.round(Math.min(60, Math.max(3, pct)) * 10) / 10; }
        else { this.settings.sheetsW = Math.round(Math.min(1200, Math.max(60, px))); }
      },
      async sheetsSaveWidth() {
        clearTimeout(this._sheetKeySave);
        const value = this.sheetsWidthValue();
        if (this.settingsSaved) { try { const was = JSON.parse(this.settingsSaved); was.sheetsW = this.settings.sheetsW; was.sheetsU = this.settings.sheetsU; this.settingsSaved = JSON.stringify(was); } catch (e) { /* the dialog keeps its own */ } }
        try { await api('settings', { method: 'POST', body: { sheetsWidth: value } }); } catch (e) { this.notify(this.t('Could not save the settings: {msg}', { msg: e.message })); }
        this.$nextTick(() => this.layout());
      },
      sheetSplitDown(e) {
        const bar = e.currentTarget.nextElementSibling; if (!bar) { return; }
        const x0 = e.clientX; const w0 = bar.getBoundingClientRect().width; const before = this.sheetsWidthValue();
        this.sheetSplitting = true; document.body.classList.add('cb-splitting');
        const move = (ev) => { this.sheetsSetPx(w0 + (x0 - ev.clientX)); this.layout(); };
        const up = () => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
          this.sheetSplitting = false; document.body.classList.remove('cb-splitting');
          if (this.sheetsWidthValue() !== before) { this.sheetsSaveWidth(); }
        };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      },
      sheetSplitReset() { this.settings.sheetsU = 'px'; this.settings.sheetsW = 132; this.sheetsSaveWidth(); },
      sheetSplitKey(e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') { return; }
        e.preventDefault();
        // the edge moves with the arrow: to the left the bar grows
        const bar = e.currentTarget.nextElementSibling;
        this.sheetsSetPx((bar ? bar.getBoundingClientRect().width : this.sheetsWidthPx()) + (e.key === 'ArrowLeft' ? 10 : -10));
        this.layout();
        clearTimeout(this._sheetKeySave); this._sheetKeySave = setTimeout(() => this.sheetsSaveWidth(), 400);
      },
      /** The little sheets follow the bar's width: one down the bar, as wide as it (as Impress's slides), drawn again at that size. */
      sheetPagesRef(el) {
        if (el === this._spEl) { return; }
        if (this._spRO && this._spEl) { this._spRO.unobserve(this._spEl); }
        this._spEl = el || null; this._spW = 0;
        if (!el || typeof ResizeObserver !== 'function') { return; }
        if (!this._spRO) {
          this._spRO = new ResizeObserver(() => {
            const w = this._spEl ? this._spEl.clientWidth : 0;
            if (!w || w === this._spW) { return; }
            this._spW = w;
            this.scheduleThumbs();
          });
        }
        this._spRO.observe(el);
      },
      aiSplitKey(e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') { return; }
        e.preventDefault();
        // the edge moves with the arrow: to the left the column grows
        this.aiSetPx(this.aiWidthPx() + (e.key === 'ArrowLeft' ? 10 : -10));
        this.layout();
        clearTimeout(this._aiKeySave); this._aiKeySave = setTimeout(() => this.aiSaveWidth(), 400);
      },
      async saveSettings() {
        try {
          await api('settings', { method: 'POST', body: {
            folder: this.settings.folder, theme: this.settings.theme, language: this.settings.language,
            autosave: this.settings.autosave ? '1' : '0',
            versionKeep: this.settings.versionKeep, versionWhen: this.settings.versionWhen,
            enterMoves: this.settings.enterMoves, aiWidth: this.aiWidthValue(), sheetsWidth: this.sheetsWidthValue(),
            gridDefault: this.settings.showGrid ? '1' : '0', sheetTabs: this.settings.sheetTabs ? '1' : '0', cellLimit: String(this.settings.cellLimit), font: this.settings.font, fontSize: this.settings.fontSize, unit: this.settings.unit,
          } });
          window.localStorage.setItem('cb-local', JSON.stringify({ showGrid: this.settings.showGrid, font: this.settings.font, fontSize: this.settings.fontSize, autosave: this.settings.autosave, unit: this.settings.unit }));
          window.localStorage.setItem('cb-spellcheck', this.settings.spellcheck ? '1' : '0');
          window.localStorage.setItem('cb-autolink', this.settings.autolink ? '1' : '0');
          this.applyTheme(this.settings.theme);
          await this.applyLanguage(this.settings.language);
          applyLimits(this.settings.cellLimit);
          this.settingsSaved = null;
          this.settingsOpen = false;
          this.layout();
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
          Object.assign(this.ai, { show: !!st.show, ready: !!st.ready, reason: st.reason || '', model: st.model || '', read: Array.isArray(st.read) ? st.read : [], imagesOk: !!st.images });
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
      // ---- copying a message, and images with a question (the owner, 2026-10-06) ----
      /**
       * Copy one message as it stands on the screen: the person's own words, or the answer's
       * words as shown (without the list of cell changes; Markdown marks and all). The clipboard API where the browser offers it,
       * otherwise a hidden text box and the copy command.
       */
      async aiCopy(m) {
        const text = m && m.role === 'assistant' ? String((m.reply != null ? m.reply : m.text) || '') : String((m && m.text) || '');
        let ok = false;
        try {
          if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; }
        } catch (e) { ok = false; }
        if (!ok) {
          const prev = document.activeElement;
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
          document.body.appendChild(ta);
          ta.select();
          try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
          document.body.removeChild(ta);
          if (prev && prev.focus) { try { prev.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        }
        if (!ok) { return; }
        m.copied = (m.copied || 0) + 1;
        const mark = m.copied;
        setTimeout(() => { if (m.copied === mark) { m.copied = 0; } }, 1500);
      },
      /** A pasted image goes with the question; pasted words are pasted as ever (text from Word or Excel brings a picture of itself too). */
      aiPaste(e) {
        const cd = e.clipboardData;
        const files = Array.from((cd && cd.files) || []);
        if (!files.length) { return; }
        let text = '';
        try { text = cd.getData('text/plain') || ''; } catch (err) { text = ''; }
        if (text.trim()) { return; }
        e.preventDefault();
        this.aiAddFiles(files);
      },
      aiHasFiles(e) {
        const types = e.dataTransfer && e.dataTransfer.types;
        return !!types && Array.from(types).includes('Files');
      },
      aiDragOver(e) {
        if (!this.aiHasFiles(e)) { return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        this.ai.drop = true;
      },
      aiDragLeave(e) {
        if (!e.currentTarget || !e.currentTarget.contains(e.relatedTarget)) { this.ai.drop = false; }
      },
      aiDrop(e) {
        this.ai.drop = false;
        if (!this.aiHasFiles(e)) { return; }
        e.preventDefault();
        this.aiAddFiles(Array.from(e.dataTransfer.files || []));
      },
      /**
       * Add images to the question: PNG, JPEG, GIF or WebP, up to 4, at most 5 MB each. A photo
       * longer than 2000px is made smaller here first; anything refused says why under the
       * thumbnails. AI-Hub checks all of it again on the server.
       */
      async aiAddFiles(files) {
        const MAX_N = 4;
        const MAX_BYTES = 5 * 1024 * 1024;
        const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
        this.ai.attNote = '';
        if (!this.ai.ready) { return; }
        if (!this.ai.imagesOk) { this.ai.attNote = this.t('This AI connection cannot send images.'); return; }
        for (const f of files) {
          if (!TYPES.includes(f.type)) { this.ai.attNote = this.t('Only PNG, JPEG, GIF and WebP images can be sent.'); continue; }
          if (this.ai.images.length >= MAX_N) { this.ai.attNote = this.t('Up to 4 images can be sent at once.'); break; }
          let img = null;
          try { img = await this.aiPrepImage(f, MAX_BYTES); } catch (e) { this.ai.attNote = this.t('The image could not be read.'); continue; }
          if (!img) { this.ai.attNote = this.t('An image can be at most 5 MB.'); continue; }
          if (this.ai.images.length >= MAX_N) { this.ai.attNote = this.t('Up to 4 images can be sent at once.'); break; }
          this.ai.images.push(img);
        }
        this.aiScroll();
      },
      /** One image, ready to send: made smaller if its long side is over 2000px; null when it is still over the size limit. */
      async aiPrepImage(file, maxBytes) {
        const LONG = 2000;
        let blob = file;
        const src = URL.createObjectURL(file);
        try {
          const im = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
          const w = im.naturalWidth; const h = im.naturalHeight;
          if (!w || !h) { throw new Error('unreadable'); }
          if (Math.max(w, h) > LONG) {
            const k = LONG / Math.max(w, h);
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
            const g = c.getContext('2d');
            const encode = (type) => new Promise((resolve) => c.toBlob(resolve, type, 0.9));
            g.drawImage(im, 0, 0, c.width, c.height);
            blob = await encode(file.type === 'image/jpeg' || file.type === 'image/webp' ? file.type : 'image/png');
            if (blob && blob.size > maxBytes && blob.type !== 'image/jpeg') {
              // A photo kept as PNG can still be too large: as JPEG, on white (JPEG has no transparency).
              g.globalCompositeOperation = 'destination-over';
              g.fillStyle = '#fff';
              g.fillRect(0, 0, c.width, c.height);
              blob = await encode('image/jpeg');
            }
            if (!blob) { throw new Error('unreadable'); }
          }
        } finally { URL.revokeObjectURL(src); }
        if (blob.size > maxBytes) { return null; }
        const url = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(blob); });
        const comma = url.indexOf(',');
        return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), name: file.name || '', type: blob.type || file.type, size: blob.size, url, data: url.slice(comma + 1) };
      },
      aiUnattach(k) {
        this.ai.images.splice(k, 1);
        this.ai.attNote = '';
      },
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
        if (m === 'no-images') { return this.t('This AI connection cannot send images.'); }
        if (m === 'too-many-images') { return this.t('Up to 4 images can be sent at once.'); }
        if (m === 'image-too-large') { return this.t('An image can be at most 5 MB.'); }
        if (m === 'image-type') { return this.t('Only PNG, JPEG, GIF and WebP images can be sent.'); }
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
        return { px: pt * 4 / 3 * z, family: this.familyOf(meta) };
      },
      /** The face a cell is drawn in: its own, else the book's heading face for a heading style, else the book's. */
      familyOf(meta) {
        if (meta && meta.s && meta.s.font) { return meta.s.font; }
        const f = this.fontsInUse;
        return meta && meta.style && f.heading !== f.body && HEADING_STYLES.indexOf(meta.style) >= 0 ? f.heading : f.body;
      },
      headWidth(z) {
        const digits = String(Math.max(1, Math.min(LIMIT_ROWS, (this.extentR || 100)))).length;
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
        er = Math.min(LIMIT_ROWS, er, Math.floor(30000000 / (DEF_ROW_H * z)));
        ec = Math.min(MAX_COLS, ec, Math.floor(30000000 / (DEF_COL_W * z)));
        sh.extentR = er; sh.extentC = ec;
        this.extentR = er;
        const headW = this.view.headings ? this.headWidth(z) : 0; const headH = this.view.headings ? HEAD_H * z : 0;
        const sp = this.$refs.spacer;
        if (sp) { sp.style.width = Math.round(headW + colLeft(sh, ec) * z) + 'px'; sp.style.height = Math.round(headH + rowTop(sh, er) * z) + 'px'; }
        this.paint();
      },
      /** Grows the sheet's scroll range so that a cell can be scrolled to. */
      growTo(r, c) {
        const sh = this.sheet(); if (!sh) { return; }
        let grew = false;
        if (r + 20 > (sh.extentR || 0)) { sh.extentR = Math.min(LIMIT_ROWS, r + 60); grew = true; }
        if (c + 3 > (sh.extentC || 0)) { sh.extentC = Math.min(MAX_COLS, c + 10); grew = true; }
        if (grew) { this.layout(); }
      },
      onScroll() {
        const sh = this.sheet(); const vp = this.$refs.scroller;
        if (!sh || !vp) { return; }
        // Near the end of the range: more room, as Calc's scrollbar grows.
        if (vp.scrollTop + vp.clientHeight * 2 > vp.scrollHeight && (sh.extentR || 0) < LIMIT_ROWS) { sh.extentR = Math.min(LIMIT_ROWS, Math.floor((sh.extentR || 100) * 1.5)); this.layout(); return; }
        if (vp.scrollLeft + vp.clientWidth * 2 > vp.scrollWidth && (sh.extentC || 0) < MAX_COLS) { sh.extentC = Math.min(MAX_COLS, Math.floor((sh.extentC || 20) * 1.5)); this.layout(); return; }
        this.paint();
      },
      /** Where things are, this frame: the frozen split, the visible rows and columns of each quadrant. */
      frame() {
        const sh = this.sheet(); const vp = this.$refs.scroller;
        if (!sh || !vp) { return null; }
        const z = this.z();
        const W = vp.clientWidth; const H = vp.clientHeight; const sx = vp.scrollLeft; const sy = vp.scrollTop;
        const headW = this.view.headings ? this.headWidth(z) : 0; const headH = this.view.headings ? HEAD_H * z : 0;
        const fr = sh.freeze ? Math.min(sh.freeze.r, 200) : 0; const fc = sh.freeze ? Math.min(sh.freeze.c, 50) : 0;
        const fh = fr ? rowTop(sh, fr) * z : 0; const fw = fc ? colLeft(sh, fc) * z : 0;
        const mainW = Math.max(0, W - headW - fw); const mainH = Math.max(0, H - headH - fh);
        const r0 = rowAtY(sh, (sy + fh) / z); const r1 = Math.min(LIMIT_ROWS - 1, rowAtY(sh, (sy + fh + mainH) / z) + 1);
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
        if (this._holdPaint) { this._paintHeld = true; return; }
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
        this.paintImages(f);
        this.placeEditor(f);
        this.lastPaintMs = performance.now() - t0;
        this.paintCount = (this.paintCount || 0) + 1;
      },
      paintQuadrant(q, f) {
        const { sh, z } = f;
        const out = ['<div class="cb-q ' + q.cls + '" data-q="' + q.cls + '" style="left:' + q.left + 'px;top:' + q.top + 'px;width:' + q.w + 'px;height:' + q.h + 'px">'];
        const name = sh.name;
        const stacks = new Map();
        const stackOf = (fam) => { let v = stacks.get(fam); if (v === undefined) { v = fontStack(fam, 'sans').replace(/"/g, "'"); stacks.set(fam, v); } return v; };
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
          const note = meta && meta.note; const link = meta && meta.link;
          if (!g.t && !s && !note) { return; }
          const css = ['left:' + x + 'px', 'top:' + y + 'px', 'width:' + w + 'px', 'height:' + h + 'px'];
          const px = s && s.size ? s.size * 4 / 3 * z : defPx;
          const fam = this.familyOf(meta);
          css.push('font-size:' + px + 'px', 'font-family:' + stackOf(fam));
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
          // View: the formulas instead of their results (Ctrl+`), and zeros left blank
          const asFormula = this.view.formulas && !!g.f;
          if (asFormula) { text = g.f; fmtColor = ''; }
          else if (!this.view.zeros && g.t === 'n' && g.v === 0) { text = ''; }
          if (fmtColor && !(s && s.color)) { css.push('color:' + fmtColor); }
          if (link) { cls += ' link'; }
          const isNum = (g.t === 'n' || g.t === 'b') && !asFormula;
          const ha = (s && s.ha) || (asFormula ? 'left' : isNum ? 'right' : g.t === 'e' ? 'center' : 'left');
          if (g.t === 'e') { cls += ' err'; }
          cls += ha === 'right' ? ' rgt' : ha === 'center' ? ' ctr' : ' lft';
          // justified: the lines of wrapped text reach both edges (one line stays at the left, as in Calc)
          if (ha === 'justify') { css.push('text-align:justify'); }
          let width = w;
          if (text && !(s && s.wrap)) {
            const fontStr = fontCss(s && s.b, px, fam);
            const tx = textWidth(text, fontStr);
            const tw = tx + 8 * z;
            if (tw > w) {
              const room = w - 2 * CELL_MARGIN * z;
              if (g.t === 'n' && !asFormula) {
                if (fmtOf(meta, g)) { if (tx > room) { text = '###'; cls += ' hash'; } }
                else { text = fitNumber(text, g.v, room - 2 * NUM_GAP * z, fontStr); if (text === '###') { cls += ' hash'; } }
              }
              else if (g.t === 'b' && !asFormula) { if (tx > room) { text = '###'; cls += ' hash'; } }
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
          // a comment: the red corner Calc draws
          if (note) { out.push('<div class="cb-notemark" style="left:' + (x + w - 7 * z) + 'px;top:' + y + 'px;border-width:0 ' + (7 * z) + 'px ' + (7 * z) + 'px 0"></div>'); }
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
        // where the pages fall, with the book's paper setup (View > Page breaks)
        if (this.view.breaks) {
          const pb = this.pageBreaks(sh);
          pb.cols.forEach((c) => { const x = colLeft(sh, c) * z - q.ox; if (x > 0 && x < q.w) { out.push('<div class="cb-pbreak v" style="left:' + (x - 1) + 'px"></div>'); } });
          pb.rows.forEach((r) => { const y = rowTop(sh, r) * z - q.oy; if (y > 0 && y < q.h) { out.push('<div class="cb-pbreak h" style="top:' + (y - 1) + 'px"></div>'); } });
        }
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
        this.edit.style = { left: (rc.left - 1) + 'px', top: (rc.top - 1) + 'px', width: (w + 2) + 'px', height: (h + 2) + 'px', fontSize: font.px + 'px', fontFamily: fontStack(font.family, 'sans'),
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
        let sum = 0; let n = 0; let seen = 0; let filled = 0; let lo = Infinity; let hi = -Infinity;
        outer: for (const x of this.sel.ranges) {
          const r1 = Math.min(x.r1, sh.maxR); const c1 = Math.min(x.c1, sh.maxC);
          for (let r = x.r0; r <= r1; r += 1) { for (let c = x.c0; c <= c1; c += 1) { seen += 1; if (seen > 200000) { break outer; } const v = wb.get(sh.name, r, c); if (v.t) { filled += 1; } if (v.t === 'n') { sum += v.v; n += 1; if (v.v < lo) { lo = v.v; } if (v.v > hi) { hi = v.v; } } } }
        }
        const fmtN = (x) => Calc.format(Math.round(x * 1e10) / 1e10, 'n', 'General', 'ja');
        this.stats = n ? { sum: fmtN(sum), avg: fmtN(sum / n), count: n, counta: filled, min: fmtN(lo), max: fmtN(hi) } : { sum: '', avg: '', count: 0, counta: filled, min: '', max: '' };
        const meta = sh.meta.get(K(this.sel.cur.r, this.sel.cur.c)) || {};
        const s = meta.s || {};
        this.fmtNow = { b: s.b || 0, i: s.i || 0, u: s.u || 0, strike: s.strike || 0, color: s.color || '', bg: s.bg || '', ha: s.ha || '', va: s.va || '', wrap: s.wrap || 0, font: s.font || '', size: s.size || '', fmt: fmtOf(meta, wb.get(sh.name, this.sel.cur.r, this.sel.cur.c)), style: meta.style || '' };
        this.tick += 1;
      },
      setCur(r, c, keepRanges) {
        r = clamp(r, 0, LIMIT_ROWS - 1); c = clamp(c, 0, MAX_COLS - 1);
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
        r = clamp(r, 0, LIMIT_ROWS - 1); c = clamp(c, 0, MAX_COLS - 1);
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
        const named = this.resolveName(String(text || '').trim());
        if (named) {
          const idx = UIS.findIndex((u) => u.name.toLowerCase() === String(named.sheet).toLowerCase());
          if (idx >= 0 && idx !== this.active) { this.switchSheet(idx); }
          this.$nextTick(() => { this.sel.ranges = [named.g]; this.sel.cur = { r: named.g.r0, c: named.g.c0 }; this.sel.anchor = { r: named.g.r0, c: named.g.c0 }; this.ensureVisible(named.g.r0, named.g.c0); this.syncSel(); this.paint(); this.focusGrid(); });
          return;
        }
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
        // a picture over the sheet: pressed, it is chosen and can be dragged; its corner sizes it
        const pic = target && target.closest ? target.closest('.cb-pic, .cb-pic-h') : null;
        if (pic) { e.preventDefault(); if (this.edit.on) { this.commitEdit(); } this.focusGrid(); this.startImageDrag(e, pic.dataset.img, pic.classList.contains('cb-pic-h')); return; }
        if (this.imgSel) { this.imgSel = null; this.paintImages(); }
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
        // a cell; Ctrl+click on a link opens it, as Calc does
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
          const lm = this.sheet().meta.get(K(hit.r, hit.c));
          if (lm && safeLink(lm.link)) { this.setCur(hit.r, hit.c); window.open(safeLink(lm.link), '_blank', 'noopener'); return; }
        }
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
        const apply = (pairs) => { pairs.forEach(([i, v]) => { if (v == null || v === def) { map.delete(i); } else { map.set(i, v); } }); if (kind === 'row') { this.syncRowState(); } this.layout(); this.touch(); };
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
        this._holdPaint = (this._holdPaint || 0) + 1;
        try { return this.gridKeyNow(e); } finally {
          this._holdPaint -= 1;
          if (!this._holdPaint && this._paintHeld) { this._paintHeld = false; this.paint(); }
        }
      },
      gridKeyNow(e) {
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
          r = clamp(r, 0, LIMIT_ROWS - 1); c = clamp(c, 0, MAX_COLS - 1);
          if (e.shiftKey) { this.sel.cur = { r, c }; this.extendTo(r, c); } else { this.setCur(r, c); }
        };
        if (k === 'ArrowDown') { return move(1, 0); } if (k === 'ArrowUp') { return move(-1, 0); }
        if (k === 'ArrowRight') { return move(0, 1); } if (k === 'ArrowLeft') { return move(0, -1); }
        if (k === 'Tab') { e.preventDefault(); if (!e.shiftKey && this.tabStart == null) { this.tabStart = this.sel.cur.c; } const m = mergeAt(this.sheet(), this.sel.cur.r, this.sel.cur.c); this.setCur(this.sel.cur.r, e.shiftKey ? this.sel.cur.c - 1 : (m ? m.c1 + 1 : this.sel.cur.c + 1)); return undefined; }
        if (k === 'Enter') { e.preventDefault(); this.enterMove(e.shiftKey); return undefined; }
        // Home / End, as Calc: column A, or the last column of the range in use (not of this row's data); with Shift they select
        const goTo = (r, c) => { if (e.shiftKey) { this.sel.cur = { r, c }; this.extendTo(r, c); } else { this.setCur(r, c); } };
        if (k === 'Home') { e.preventDefault(); if (ctrl) { goTo(0, 0); } else { goTo(this.sel.cur.r, 0); } return undefined; }
        if (k === 'End') { e.preventDefault(); const sh = this.sheet(); this.refreshUsed(); if (ctrl) { goTo(sh.maxR, sh.maxC); } else { goTo(this.sel.cur.r, sh.maxC); } return undefined; }
        if (k === 'PageDown' || k === 'PageUp') {
          e.preventDefault();
          if (ctrl) { this.switchSheet(clamp(this.active + (k === 'PageDown' ? 1 : -1), 0, UIS.length - 1)); return undefined; }
          const f = this.frame(); const n = Math.max(1, f.r1 - f.r0 - 1);
          const r = clamp(this.sel.cur.r + (k === 'PageDown' ? n : -n), 0, LIMIT_ROWS - 1);
          if (e.shiftKey) { this.sel.cur = { r, c: this.sel.cur.c }; this.extendTo(r, this.sel.cur.c); } else { this.setCur(r, this.sel.cur.c); }
          return undefined;
        }
        if (k === 'Delete' && this.imgSel) { e.preventDefault(); if (!ro) { this.imageCmd('delete'); } return undefined; }
        if (k === 'Delete') { e.preventDefault(); if (!ro) { this.clearCells('contents'); } return undefined; }
        if (e.altKey && !ctrl && (k === '=' || e.code === 'Equal' || e.code === 'Minus' && k === '=')) { e.preventDefault(); if (!ro) { this.autoSum(); } return undefined; }
        if (k === 'Backspace') { e.preventDefault(); if (!ro) { this.openDeleteContents(); } return undefined; }
        if (k === 'F2') { e.preventDefault(); if (!ro) { this.startEdit('full'); } return undefined; }
        if (k === 'Escape' && this.imgSel) { this.imgSel = null; this.paintImages(); return undefined; }
        if (k === 'Escape') { if (this.cutMark) { this.cutMark = null; if (CLIP) { CLIP.cut = false; } this.paint(); } else if (this.find.open) { this.toggleFind(false); } return undefined; }
        if (k === ' ' && (ctrl || e.shiftKey)) { e.preventDefault(); if (ctrl) { this.selectCols(this.sel.cur.c, this.sel.cur.c); } else { this.selectRows(this.sel.cur.r, this.sel.cur.r); } return undefined; }
        if (ctrl) {
          const lk = k.toLowerCase();
          // Calc's own keys (LibreOffice 24.2's accelerator table, tried there): the block of data,
          // today and now as values, the autofilter, and inserting or deleting cells
          if (k === '*' || e.code === 'NumpadMultiply') { e.preventDefault(); this.selectDataRegion(); return undefined; }
          if (k === ';' && !e.shiftKey) { e.preventDefault(); if (!ro) { this.insertNow('date'); } return undefined; }
          if (k === ':' || (e.code === 'Semicolon' && e.shiftKey && k !== '+')) { e.preventDefault(); if (!ro) { this.insertNow('time'); } return undefined; }
          if (k === '+' || e.code === 'NumpadAdd') { e.preventDefault(); if (!ro) { this.insertCells(); } return undefined; }
          if (k === '-' || e.code === 'NumpadSubtract') { e.preventDefault(); if (!ro) { this.deleteCells(); } return undefined; }
          if (lk === 'l' && e.shiftKey) { e.preventDefault(); if (!ro) { this.toggleFilter(); } return undefined; }
          // Ctrl+L / Ctrl+E / Ctrl+R align left, centre, right (Calc; Excel's "fill right" is not Calc's)
          if ((lk === 'l' || lk === 'e' || lk === 'r') && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            if (!ro) { const ha = lk === 'l' ? 'left' : lk === 'e' ? 'center' : 'right'; this.setStyle('ha', this.fmtNow.ha === ha ? '' : ha); }
            return undefined;
          }
          if (lk === 'a') { e.preventDefault(); this.selectAll(); return undefined; }
          if (lk === 'z') { e.preventDefault(); if (e.shiftKey) { this.redo(); } else { this.undo(); } return undefined; }
          if (lk === 'y') { e.preventDefault(); this.redo(); return undefined; }
          if (lk === 's') { e.preventDefault(); this.save(true); return undefined; }
          if (lk === 'f' || lk === 'h') { e.preventDefault(); e.stopPropagation(); this.toggleFind(true); return undefined; }
          if (lk === 'b' && !ro) { e.preventDefault(); this.toggleStyle('b'); return undefined; }
          if (lk === 'i' && !ro) { e.preventDefault(); this.toggleStyle('i'); return undefined; }
          if (lk === 'u' && !ro) { e.preventDefault(); this.toggleStyle('u'); return undefined; }
          if (lk === 'd' && !ro) { e.preventDefault(); this.fillSelection('down'); return undefined; }
          if (k === '1' && !ro) { e.preventDefault(); this.openCellProps('number'); return undefined; }
          if (k === '`' || e.code === 'Backquote') { e.preventDefault(); this.toggleView('formulas'); return undefined; }
          if (lk === 'k' && !ro) { e.preventDefault(); this.openLink(); return undefined; }
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
      /**
       * Ctrl+arrow, as Calc: inside a block, to its last cell; otherwise to the next
       * cell with something in it -- and where nothing follows, to the sheet's edge
       * (LibreOffice 24.2: H1 -> XFD1, A8 -> A1048576).
       */
      dataEdge(r, c, dr, dc) {
        const sh = this.sheet(); const es = wb.sheet ? wb.sheet(sh.name) : null;
        // read through the engine's own map: a column of 100,000 rows is walked in a few ms
        const has = es && es.cells instanceof Map ? (rr, cc) => { const x = es.cells.get(rr * MAX_COLS + cc); return !!(x && (x.t || x.f)); } : (rr, cc) => !!wb.get(sh.name, rr, cc).t;
        const inside = (rr, cc) => rr >= 0 && cc >= 0 && rr < LIMIT_ROWS && cc < MAX_COLS;
        const edge = { r: dr > 0 ? LIMIT_ROWS - 1 : dr < 0 ? 0 : r, c: dc > 0 ? MAX_COLS - 1 : dc < 0 ? 0 : c };
        if (!inside(r + dr, c + dc)) { return { r, c }; }
        let rr = r; let cc = c;
        if (has(rr, cc) && has(rr + dr, cc + dc)) {
          while (inside(rr + dr, cc + dc) && has(rr + dr, cc + dc)) { rr += dr; cc += dc; }
          return { r: rr, c: cc };
        }
        this.refreshUsed();
        const lastR = sh.maxR; const lastC = sh.maxC;
        rr += dr; cc += dc;
        while (inside(rr, cc)) {
          if (has(rr, cc)) { return { r: rr, c: cc }; }
          // past the last row or column used there is nothing more to find
          if ((dr > 0 && rr >= lastR) || (dc > 0 && cc >= lastC)) { break; }
          rr += dr; cc += dc;
        }
        return edge;
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
        // a formula typed into a General cell gets the format of what it answers, as in Calc (the General
        // an imported cell keeps is not the person's choice of one: Calc does not tell them apart either)
        if (text[0] === '=' && meta && meta.fmt === 'General' && (after.fmtHint || after.fmtHintCode)) { this.setMeta(sh, r, c, { fmt: '' }); }
        if (after.t) { if (r > sh.maxR) { sh.maxR = r; } if (c > sh.maxC) { sh.maxC = c; } }
      },
      setMeta(sh, r, c, patch) {
        const k = K(r, c);
        const meta = Object.assign({ fmt: '', s: null }, sh.meta.get(k) || {});
        if (patch.fmt !== undefined) { meta.fmt = patch.fmt || ''; }
        if (patch.s !== undefined) { meta.s = isEmptyObj(patch.s) ? null : Object.assign({}, patch.s); }
        ['note', 'link', 'style'].forEach((key) => { if (patch[key] !== undefined) { if (patch[key]) { meta[key] = String(patch[key]); } else { delete meta[key]; } } });
        if (!meta.fmt && !meta.s && !meta.note && !meta.link && !meta.style) { sh.meta.delete(k); } else { sh.meta.set(k, meta); if (r > sh.maxR) { sh.maxR = r; } if (c > sh.maxC) { sh.maxC = c; } }
      },
      /** A cell's whole state, for the undo stack. */
      cellState(sh, r, c) {
        const g = wb.get(sh.name, r, c); const meta = sh.meta.get(K(r, c));
        return { input: this.inputOf(g, fmtOf(meta, g)), fmt: (meta && meta.fmt) || '', s: meta && meta.s ? Object.assign({}, meta.s) : null, note: (meta && meta.note) || '', link: (meta && meta.link) || '', style: (meta && meta.style) || '' };
      },
      applyCellState(sh, r, c, st) {
        // a cell inside an array formula is the array's, not its own: it is left to the array
        try { wb.setInput(sh.name, r, c, st.input); } catch (e) { if (!(e && e.code === 'partOfArray')) { throw e; } }
        this.setMeta(sh, r, c, { fmt: st.fmt, s: st.s, note: st.note || '', link: st.link || '', style: st.style || '' });
        if (st.input !== '') { if (r > sh.maxR) { sh.maxR = r; } if (c > sh.maxC) { sh.maxC = c; } }
      },
      // ---- undo ----
      /** A step records the cells it is about to change; endStep records what they became. */
      beginStep() { return { sheet: this.sheet(), before: new Map() }; },
      endStep(step) {
        const items = [];
        step.before.forEach((b) => { items.push({ sh: b.sh, r: b.r, c: b.c, was: b.st, now: this.cellState(b.sh, b.r, b.c) }); });
        const extra = step.extra || null;
        if (!items.length && !extra) { return; }
        const sel = JSON.stringify(this.sel); const active = this.active;
        this.pushStep({
          undo: () => { items.forEach((it) => this.applyCellState(it.sh, it.r, it.c, it.was)); if (extra) { extra.undo(); } this.restoreSel(sel, active); },
          redo: () => { items.forEach((it) => this.applyCellState(it.sh, it.r, it.c, it.now)); if (extra) { extra.redo(); } this.restoreSel(sel, active); },
        });
      },
      restoreSel(json, active) { if (this.active !== active && UIS[active]) { this.active = active; } try { this.sel = JSON.parse(json); } catch (e) { /* keep */ } this.afterChange(); },
      pushStep(step) { this.history.push(step); if (this.history.length > 200) { this.history.shift(); } this.redoStack = []; this.canUndo = true; this.canRedo = false; },
      undo() { if (this.edit.on) { this.cancelEdit(); return; } const s = this.history.pop(); if (!s) { return; } s.undo(); this.redoStack.push(s); this.canUndo = this.history.length > 0; this.canRedo = true; this.touch(); this.afterChange(); },
      redo() { const s = this.redoStack.pop(); if (!s) { return; } s.redo(); this.history.push(s); this.canUndo = true; this.canRedo = this.redoStack.length > 0; this.touch(); this.afterChange(); },
      /** After the sheets changed under the chrome: repaint, recount, re-read the formula bar. */
      afterChange() { this.syncRowState(); this.tick += 1; this._pbCache = null; this.syncSel(); this.layout(); this.scheduleThumbs(); },
      /** Runs fn with a step open: fn(step) calls step.before(sh, r, c) before touching a cell. */
      withStep(fn) {
        const step = this.beginStep(); this.curStep = step; step.before = new Map();
        const rec = (sh, r, c) => { const k = sh.name + '!' + K(r, c); if (!step.before.has(k)) { step.before.set(k, { sh, r, c, st: this.cellState(sh, r, c) }); } };
        let res;
        try { res = fn(rec); } catch (e) {
          if (!(e && e.code === 'partOfArray')) { this.endStep(step); this.curStep = null; this.touch(); this.afterChange(); throw e; }
          this.notify(this.t('You cannot change only part of an array.'));
        }
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
          // A selection of empty cells is formatted too, as in Calc (a border round B2:D4 of an empty sheet went
          // only onto B2, the used range): only a selection larger than the cap (whole columns and rows) is
          // held to the used range, so that a million empty cells are not visited one by one.
          const whole = (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1) <= max;
          const r1 = whole ? g.r1 : Math.min(g.r1, Math.max(sh.maxR, g.r0)); const c1 = whole ? g.c1 : Math.min(g.c1, Math.max(sh.maxC, g.c0));
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
          if (e.altKey || e.ctrlKey || e.metaKey) { e.preventDefault(); const t = this.edit.text; const c = this.edit.caret; this.setEditText(t.slice(0, c) + '\n' + t.slice(c), c + 1); return; }
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
        if ((e.ctrlKey || e.metaKey) && (k.toLowerCase() === 'f' || k.toLowerCase() === 'h')) { e.preventDefault(); e.stopPropagation(); if (this.commitEdit()) { this.toggleFind(true); } return; }
        if ((e.ctrlKey || e.metaKey) && (k === ';' || k === ':' || (e.code === 'Semicolon' && e.shiftKey && k !== '+'))) {
          e.preventDefault();
          const now = this.nowValue(k === ';' && !e.shiftKey ? 'date' : 'time');
          const t = this.edit.text; const c = this.edit.caret; const txt = Calc.format(now.v, 'n', now.fmt, uiLang());
          this.setEditText(t.slice(0, c) + txt + t.slice(c), c + txt.length);
          return;
        }
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
          if (was !== text) {
            // An address typed into a cell becomes a link, as Calc's URL recognition makes one (Settings, While typing).
            const auto = this.settings.autolink ? autoLinkOf(text) : '';
            this.withStep((rec) => {
              rec(sh, r, c); this.setInputRaw(sh, r, c, text);
              if (auto && !(sh.meta.get(K(r, c)) || {}).link) { this.setMeta(sh, r, c, { link: auto }); }
            });
          }
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
        if (e.key === 'Enter' && !e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); if (this.commitEdit()) { this.enterMove(false); } return; }
        if (e.key === 'Enter' && (e.altKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); const t = this.edit.text; const c = this.edit.caret; this.setEditText(t.slice(0, c) + '\n' + t.slice(c), c + 1); return; }
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
        // the merges wholly inside what is copied travel with it (as colspan/rowspan for other programs)
        const merges = sh.merges.filter((m) => m.r0 >= g.r0 && m.c0 >= g.c0 && m.r1 <= r1 && m.c1 <= c1).map((m) => ({ r0: m.r0 - g.r0, c0: m.c0 - g.c0, r1: m.r1 - g.r0, c1: m.c1 - g.c0 }));
        const spanAt = new Map(); const covered = new Set();
        merges.forEach((m) => { spanAt.set(K(m.r0 + g.r0, m.c0 + g.c0), m); for (let r = m.r0; r <= m.r1; r += 1) { for (let c = m.c0; c <= m.c1; c += 1) { if (r !== m.r0 || c !== m.c0) { covered.add(K(r + g.r0, c + g.c0)); } } } });
        // LibreOffice's own attributes: the language of the book, and of the codes (English, as CalcBase writes them)
        const lang = uiLang() === 'ja' ? '1041' : '1033';
        for (let r = g.r0; r <= r1; r += 1) {
          const row = []; const trow = []; const hrow = [];
          for (let c = g.c0; c <= c1; c += 1) {
            const st = this.cellState(sh, r, c); const gg = wb.get(sh.name, r, c);
            const fmt = fmtOf(sh.meta.get(K(r, c)), gg);
            const shown = gg.t ? Calc.format(gg.v, gg.t, fmt, 'ja') : '';
            row.push(st); trow.push(tsvCell(shown));
            if (covered.has(K(r, c))) { continue; }
            const a = []; const sp = spanAt.get(K(r, c));
            if (sp) { if (sp.c1 > sp.c0) { a.push(' colspan="' + (sp.c1 - sp.c0 + 1) + '"'); } if (sp.r1 > sp.r0) { a.push(' rowspan="' + (sp.r1 - sp.r0 + 1) + '"'); } }
            if (gg.f) { a.push(' data-f="' + esc(gg.f) + '"'); } if (gg.t) { a.push(' data-t="' + gg.t + '"'); if (gg.t === 'n' || gg.t === 'b') { a.push(' data-v="' + esc(String(gg.v)) + '"'); } }
            const fo = fmtForFile(fmt); if (fo) { a.push(' data-fmt="' + esc(fo) + '"'); } const css = styleToCss(st.s); if (css) { a.push(' style="' + esc(css) + '"'); }
            // what Calc reads: the value unrounded (sdval) and its format (sdnum); TRUE/FALSE as BOOLEAN; text that would read as a number as "@"
            if (gg.t === 'n') { a.push(' sdval="' + esc(String(gg.v)) + '" sdnum="' + esc(sdnumFor(fmt, lang)) + '"'); }
            else if (gg.t === 'b') { a.push(' sdval="' + (gg.v ? 1 : 0) + '" sdnum="' + lang + ';0;BOOLEAN"'); }
            else if (gg.t === 's' && Calc.parseInput(String(gg.v), 'ja').t !== 's') { a.push(' sdnum="' + lang + ';0;@"'); }
            const s = st.s || {};
            if (s.bg && /^#[0-9a-f]{6}$/i.test(s.bg)) { a.push(' bgcolor="' + s.bg + '"'); }
            if (s.ha) { a.push(' align="' + s.ha + '"'); }
            // the look again as old HTML, which Calc reads where it ignores the style attribute
            let inner = esc(shown).replace(/\n/g, '<br>');
            if (s.color && /^#[0-9a-f]{3,6}$/i.test(s.color)) { inner = '<font color="' + s.color + '">' + inner + '</font>'; }
            if (s.strike) { inner = '<s>' + inner + '</s>'; }
            if (s.u) { inner = '<u>' + inner + '</u>'; }
            if (s.i) { inner = '<i>' + inner + '</i>'; }
            if (s.b) { inner = '<b>' + inner + '</b>'; }
            hrow.push('<td' + a.join('') + '>' + inner + '</td>');
          }
          cells.push(row); tsv.push(trow.join('\t')); html.push('<tr>' + hrow.join('') + '</tr>');
        }
        return { id, sheet: sh.name, range: { r0: g.r0, c0: g.c0, r1, c1 }, cells, merges, tsv: tsv.join('\n'), html: '<table data-cb-clip="' + id + '"><tbody>' + html.join('') + '</tbody></table>' };
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
          if (table && table.rows.length) { grid = table.rows.map((row) => row.map((o) => ({ input: pastedInput(o, valuesOnly), fmt: valuesOnly ? '' : o.fmt, s: valuesOnly ? null : o.s }))); }
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
        if (r1 >= LIMIT_ROWS) { this.notify(this.rowLimitText()); return; }
        if (c1 >= MAX_COLS) { this.notify(this.t('That does not fit on the sheet.')); return; }
        this.withStep((rec) => {
          if (own && own.cut && UIS.find((u) => u.name === own.sheet)) {
            // cut-and-paste: the cells leave where they were only now, and every
            // formula that pointed at them is recorded too, so one Ctrl+Z puts the
            // whole move back
            const src = UIS.find((u) => u.name === own.sheet);
            for (let r = own.range.r0; r <= own.range.r1; r += 1) { for (let c = own.range.c0; c <= own.range.c1; c += 1) { rec(src, r, c); } }
            let n = 0;
            wb.toModel().sheets.forEach((ms) => { const u = UIS.find((x) => x.name === ms.name); if (!u) { return; } Object.keys(ms.cells).forEach((key) => { if (!ms.cells[key].f || n > 50000) { return; } const pp = parseRef(key); if (pp) { rec(u, pp.r, pp.c); n += 1; } }); });
            for (let r = own.range.r0; r <= own.range.r1; r += 1) { for (let c = own.range.c0; c <= own.range.c1; c += 1) { wb.setInput(src.name, r, c, ''); this.setMeta(src, r, c, { fmt: '', s: null, note: '', link: '', style: '' }); } }
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
              if (!valuesOnly) { this.setMeta(sh, r, c, own ? { fmt: cell.fmt || implied, s: cell.s || null, note: cell.note || '', link: cell.link || '', style: cell.style || '' } : { fmt: cell.fmt || implied, s: cell.s || null }); } else { this.setMeta(sh, r, c, { fmt: cell.fmt || implied }); }
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
          // merged cells come along (Calc's colspan/rowspan, or CalcBase's own copy); the paste's area loses its own
          const pm = valuesOnly ? [] : (own ? (own.merges || []) : (table ? table.merges || [] : []));
          if (pm.length || (!valuesOnly && sh.merges.some((m) => m.r1 >= g.r0 && m.r0 <= r1 && m.c1 >= g.c0 && m.c0 <= c1))) {
            const src = own && own.cut ? UIS.find((u) => u.name === own.sheet) : null;
            const sheets = Array.from(new Set([sh].concat(src ? [src] : [])));
            const was = sheets.map((u) => u.merges.map((m) => Object.assign({}, m)));
            if (src) { src.merges = src.merges.filter((m) => !(m.r0 >= own.range.r0 && m.r1 <= own.range.r1 && m.c0 >= own.range.c0 && m.c1 <= own.range.c1)); }
            const kept = sh.merges.filter((m) => !(m.r1 >= g.r0 && m.r0 <= r1 && m.c1 >= g.c0 && m.c0 <= c1));
            const added = [];
            for (let tr = 0; tr < tileR; tr += 1) { for (let tc = 0; tc < tileC; tc += 1) { pm.forEach((m) => { const o = { r0: g.r0 + tr * srcRows + m.r0, c0: g.c0 + tc * srcCols + m.c0, r1: g.r0 + tr * srcRows + m.r1, c1: g.c0 + tc * srcCols + m.c1 }; if (o.r1 < MAX_ROWS && o.c1 < MAX_COLS) { added.push(o); } }); } }
            sh.merges = kept.concat(added);
            const now = sheets.map((u) => u.merges.map((m) => Object.assign({}, m)));
            const put = (list) => sheets.forEach((u, i) => { u.merges = list[i].map((m) => Object.assign({}, m)); });
            if (this.curStep) { this.curStep.extra = { undo: () => put(was), redo: () => put(now) }; }
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
        const up = (ev) => {
          document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); clearInterval(this._autoScroll); this._autoScroll = 0;
          this.fillPrev = null;
          // Calc: with Ctrl held as the button is let go, the cells are copied, not counted on (1 -> 1, 1, 1)
          const copy = !!(ev && (ev.ctrlKey || ev.metaKey));
          if (target) { this.fillRange(src, target, copy); } else { this.paint(); }
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
              const states = []; for (let r = src.r0; r <= src.r1; r += 1) { states.push(this.cellState(sh, r, c)); states[states.length - 1].seed = this.seedOf(sh, r, c); }
              const rows = []; if (target.dir === 'down') { for (let r = src.r1 + 1; r <= target.r1; r += 1) { rows.push(r); } } else { for (let r = src.r0 - 1; r >= target.r0; r -= 1) { rows.push(r); } }
              this.fillLine(sh, states, rows.map((r) => ({ r, c })), src.r0, src.c0, rec, target.dir === 'up', copyOnly);
            }
          } else {
            for (let r = src.r0; r <= src.r1; r += 1) {
              const states = []; for (let c = src.c0; c <= src.c1; c += 1) { states.push(this.cellState(sh, r, c)); states[states.length - 1].seed = this.seedOf(sh, r, c); }
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
          const seeds = states.map((s) => s.seed);
          const ordered = backwards ? seeds.slice().reverse() : seeds;
          // a single number drawn up or left counts down (as Calc)
          if (backwards && ordered.length === 1 && ordered[0].t === 'n') { series = Calc.fillSeries([Object.assign({}, ordered[0], { v: ordered[0].v + 1 }), ordered[0]], targets.length, uiLang()); }
          else { series = Calc.fillSeries(ordered, targets.length, uiLang()); }
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
            const o = series[i];
            if (o && typeof o === 'object') {
              input = o.t === 'n' ? String(o.v) : o.t === 'b' ? (o.v ? 'TRUE' : 'FALSE') : String(o.v == null ? '' : o.v);
              if (o.t === 's' && input !== '' && Calc.parseInput(input, uiLang()).t !== 's') { input = "'" + input; }
              this.setInputRaw(sh, tg.r, tg.c, input);
              // the value's own format (a date's) when the seed had none of its own on the cell
              this.setMeta(sh, tg.r, tg.c, { fmt: st.fmt || (o.t === 'n' && o.fmt ? o.fmt : ''), s: st.s });
              return;
            }
            input = String(o);
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
            if (what === 'formats' || what === 'all') { this.setMeta(sh, r, c, { fmt: '', s: null, style: '' }); }
            if (what === 'all') { this.setMeta(sh, r, c, { note: '', link: '' }); }
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
        (sh.images || []).forEach((im) => { if (n < 0 && im.r >= at && im.r < at - n) { im.r = at; im.dy = 0; } else if (im.r >= at) { im.r += n; } });
        if (sh.filter) { if (sh.filter.r0 >= at) { sh.filter.r0 += n; } sh.filter.r1 += n; }
        sh.maxR = Math.max(0, sh.maxR + n);
      },
      shiftMetaCols(sh, at, n) {
        const next = new Map(); sh.meta.forEach((m, k) => { const r = KR(k); const c = KC(k); if (n < 0 && c >= at && c < at - n) { return; } next.set(K(r, c >= at ? c + n : c), m); }); sh.meta = next;
        const cols = new Map(); sh.cols.forEach((w, c) => { if (n < 0 && c >= at && c < at - n) { return; } cols.set(c >= at ? c + n : c, w); }); sh.cols = cols;
        sh.merges = sh.merges.map((m) => { const mm = Object.assign({}, m); if (n < 0) { const d0 = at; const d1 = at - n - 1; if (m.c0 >= d0 && m.c1 <= d1) { return null; } if (m.c0 > d1) { mm.c0 += n; mm.c1 += n; } else if (m.c1 >= d0) { mm.c1 = Math.max(m.c0, m.c1 - Math.min(m.c1, d1) + Math.max(m.c0, d0) - 1); } } else if (m.c0 >= at) { mm.c0 += n; mm.c1 += n; } else if (m.c1 >= at) { mm.c1 += n; } return mm; }).filter((m) => m && (m.r1 > m.r0 || m.c1 > m.c0));
        if (sh.freeze && sh.freeze.c > at) { sh.freeze.c = Math.max(at, sh.freeze.c + n); }
        (sh.images || []).forEach((im) => { if (n < 0 && im.c >= at && im.c < at - n) { im.c = at; im.dx = 0; } else if (im.c >= at) { im.c += n; } });
        if (sh.filter) { if (sh.filter.c0 >= at) { sh.filter.c0 += n; } sh.filter.c1 += n; }
        sh.maxC = Math.max(0, sh.maxC + n);
      },
      /** A snapshot of the whole book's cells and page facts, for the undo of a structural change (rows and columns move, every formula may change). */
      snapshotBook() {
        const model = toFullModel(wb, UIS, this.active);
        const uis = UIS.map((u) => ({ name: u.name, cols: new Map(u.cols), rows: new Map(u.rows), meta: new Map(Array.from(u.meta.entries()).map(([k, m]) => [k, Object.assign({}, m)])), merges: u.merges.map((m) => Object.assign({}, m)), freeze: u.freeze ? Object.assign({}, u.freeze) : null, grid: u.grid, maxR: u.maxR, maxC: u.maxC, filter: u.filter ? JSON.parse(JSON.stringify(u.filter)) : null, extentR: u.extentR, extentC: u.extentC, images: (u.images || []).map((x) => Object.assign({}, x)) }));
        const sel = JSON.stringify(this.sel); const active = this.active;
        return () => { wb = Calc.workbook({ locale: calcLocaleOf(this.bookLang) }); wb.load(model); if (wb.recalc) { wb.recalc(); } UIS = uis.map((u) => Object.assign(newSheetUI(u.name), u, { cols: new Map(u.cols), rows: new Map(u.rows), meta: new Map(Array.from(u.meta.entries()).map(([k, m]) => [k, Object.assign({}, m)])), merges: u.merges.map((m) => Object.assign({}, m)), freeze: u.freeze ? Object.assign({}, u.freeze) : null, images: (u.images || []).map((x) => Object.assign({}, x)) })); this.restoreSel(sel, active); };
      },
      /** A structural change: done through fn, undone by putting the snapshot back. */
      structural(fn) {
        const before = this.snapshotBook();
        fn();
        this.touch(); this.afterChange();
        const after = this.snapshotBook();
        this.pushStep({ undo: before, redo: after });
      },
      /** CalcBase's limits, said the same way everywhere they are met. */
      rowLimitText() {
        return this.t('A sheet can have at most {n} rows. Large amounts of data belong in a database, not in a spreadsheet. The limit can be raised in the settings, at your own risk.', { n: LIMIT_ROWS.toLocaleString(uiLang()) });
      },
      sizeLimitText() {
        return this.t('A book can be at most {n} MB. Make the pictures lighter or split the book; the limit can also be raised in the settings, at your own risk.', { n: String(LIMIT_BYTES / 1024 / 1024) });
      },
      /** What of the writer's limit the open book is past, said for the screen; '' when it is within it. */
      overLimit() {
        if (!wb || !wb.sheet) { return ''; }
        let cells = 0;
        for (const u of UIS) {
          const es = wb.sheet(u.name);
          if (!es) { continue; }
          if (es.maxR >= LIMIT_ROWS) { return this.rowLimitText(); }
          cells += es.cells instanceof Map ? es.cells.size : 0;
        }
        return cells > LIMIT_CELLS ? this.t('A book can hold at most {n} cells. Large amounts of data belong in a database, not in a spreadsheet. The limit can be raised in the settings, at your own risk.', { n: LIMIT_CELLS.toLocaleString(uiLang()) }) : '';
      },
      insertRows(below) {
        if (this.book.readOnly) { return; }
        const sh = this.sheet(); const { at, n } = this.selRows(); const where = below ? at + n : at;
        if (n > 10000) { this.notify(this.t('Too many rows at once.')); return; }
        const es = wb.sheet ? wb.sheet(sh.name) : null;
        if (es && es.maxR >= where && es.maxR + n >= LIMIT_ROWS) { this.notify(this.rowLimitText()); return; }
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
      /** A length in the unit of the settings (Calc's measurement unit), and back: the sheet keeps CSS pixels. */
      unitNow() { return UNITS[this.settings.unit] ? this.settings.unit : 'px'; },
      pxToUnit(px) { const u = this.unitNow(); return u === 'px' ? Math.round(px) : Math.round(px / UNITS[u] * 100) / 100; },
      unitToPx(v) { return Number(v) * UNITS[this.unitNow()]; },
      async askRowHeight() {
        const sh = this.sheet(); const { at, n } = this.selRows(); const u = this.unitNow();
        const v = await this.askFor({ title: this.t('Row height'), label: this.t('Height ({unit})', { unit: u }), value: this.pxToUnit(rowH(sh, at)), number: true, min: 0, max: this.pxToUnit(600), step: u === 'px' ? 1 : 0.01 });
        if (v == null || isNaN(v)) { return; }
        const rows = []; for (let r = at; r < at + Math.min(n, 10000); r += 1) { rows.push(r); }
        this.sizeLines('row', rows, clamp(Math.round(this.unitToPx(v)), 0, 600));
      },
      async askColWidth() {
        const sh = this.sheet(); const { at, n } = this.selCols(); const u = this.unitNow();
        const v = await this.askFor({ title: this.t('Column width'), label: this.t('Width ({unit})', { unit: u }), value: this.pxToUnit(colW(sh, at)), number: true, min: 0, max: this.pxToUnit(2000), step: u === 'px' ? 1 : 0.01 });
        if (v == null || isNaN(v)) { return; }
        const cols = []; for (let c = at; c < at + Math.min(n, 1000); c += 1) { cols.push(c); }
        this.sizeLines('col', cols, clamp(Math.round(this.unitToPx(v)), 0, 2000));
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
            row.forEach((st, j) => { const c = g.c0 + j; const input = st.input[0] === '=' ? Calc.shiftFormula(st.input, dstR - srcR, 0) : st.input; this.setInputRaw(sh, dstR, c, input); this.setMeta(sh, dstR, c, { fmt: st.fmt, s: st.s, note: st.note, link: st.link, style: st.style }); });
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
        this.imgSel = null; this._pbCache = null;
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
          imageSerial += 1; u.images = (src.images || []).map((x, k) => Object.assign({}, x, { id: 'img' + Date.now().toString(36) + imageSerial + '-' + k }));
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
        this.refreshUsedFonts();
        this.bord = this.readBorders();
        this._bordOpenLine = (this.bord.style === 'double' ? Math.max(3, this.bord.width) : this.bord.width) + 'px ' + this.bord.style + ' ' + this.bord.colour;
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
      /** A preset of LibreOffice Calc's Borders tab: which edges get the line, which lose theirs, which are left as they are. */
      bordPreset(kind) {
        const e = this.bord.edges;
        const put = (keys, v) => keys.forEach((k) => { e[k] = v; });
        const outer = ['top', 'bottom', 'left', 'right'];
        if (kind === 'none') { put(outer.concat(['insideH', 'insideV']), 'none'); }
        else if (kind === 'box') { put(outer, 'set'); }
        else if (kind === 'lr') { put(['left', 'right'], 'set'); put(['top', 'bottom'], 'none'); }
        else if (kind === 'tb') { put(['top', 'bottom'], 'set'); put(['left', 'right'], 'none'); }
        else if (kind === 'outerOnly') { put(outer, 'set'); put(['insideH', 'insideV'], 'none'); }
        else if (kind === 'outerH') { put(outer.concat(['insideH']), 'set'); put(['insideV'], 'none'); }
        else if (kind === 'outerV') { put(outer.concat(['insideV']), 'set'); put(['insideH'], 'none'); }
        else if (kind === 'all') { put(outer.concat(['insideH', 'insideV']), 'set'); }
        else if (kind === 'outline') { put(outer, 'set'); }
        else if (kind === 'inside') { put(['insideH', 'insideV'], 'set'); }
      },
      /** An edge of the picture pressed: on, then off (as Calc's user-defined area); one that was mixed comes on first. */
      bordToggle(e) { const now = this.bord.edges[e]; this.bord.edges[e] = now === 'set' ? 'none' : 'set'; },
      bordWidthPick(v) { if (v !== 'custom') { this.bord.width = Number(v) || 1; this.bord.custom = false; } else { this.bord.custom = true; } },
      /** The line an edge of the picture is drawn with: the one it will get, nothing, or grey for "not changed". */
      edgeLineStyle(e) {
        const st = this.bord.edges[e]; const across = e === 'top' || e === 'bottom' || e === 'insideH';
        const side = across ? 'borderTop' : 'borderLeft';
        if (st === 'set' && this.bord.style !== 'none') { const w = this.bord.style === 'double' ? Math.max(3, this.bord.width) : this.bord.width; return { [side]: w + 'px ' + this.bord.style + ' ' + this.bord.colour, background: 'transparent' }; }
        if (st === 'none' || (st === 'set' && this.bord.style === 'none')) { return { [side]: '1px dashed var(--border)', background: 'transparent' }; }
        return {};
      },
      /** What the selection's edges have now, so the picture starts from it (as Calc's): the same line all along → on, none → off, mixed → not changed. */
      readBorders() {
        const sh = this.sheet(); const g = this.selRange();
        const sideOf = (r, c, k) => { const m = sh.meta.get(K(r, c)); return (m && m.s && m.s[k]) || ''; };
        const cap = (n) => Math.min(n, 400);
        const along = (cells) => { const vals = new Set(cells); return vals.size === 1 ? Array.from(vals)[0] : null; };
        const row = (r, k) => { const out = []; for (let c = g.c0; c <= g.c0 + cap(g.c1 - g.c0); c += 1) { out.push(sideOf(r, c, k)); } return out; };
        const col = (c, k) => { const out = []; for (let r = g.r0; r <= g.r0 + cap(g.r1 - g.r0); r += 1) { out.push(sideOf(r, c, k)); } return out; };
        const lines = {
          top: along(row(g.r0, 'bt')), bottom: along(row(g.r1, 'bb')), left: along(col(g.c0, 'bl')), right: along(col(g.c1, 'br')),
          insideH: null, insideV: null,
        };
        if (g.r1 > g.r0) { let all = []; for (let r = g.r0; r < Math.min(g.r1, g.r0 + 50); r += 1) { all = all.concat(row(r, 'bb')); } lines.insideH = along(all); }
        if (g.c1 > g.c0) { let all = []; for (let c = g.c0; c < Math.min(g.c1, g.c0 + 50); c += 1) { all = all.concat(col(c, 'br')); } lines.insideV = along(all); }
        const edges = {}; const orig = {}; let first = '';
        Object.keys(lines).forEach((k) => {
          const v = lines[k];
          edges[k] = v == null ? 'keep' : v ? 'set' : 'none';
          if (v) { orig[k] = v; if (!first) { first = v; } }
        });
        const m = /^(\d+)px (solid|dashed|dotted|double) (#[0-9a-f]{3,6})$/i.exec(first || '');
        return { style: m ? m[2] : 'solid', width: m ? Number(m[1]) : 1, colour: m ? m[3] : '#000000', edges, orig, custom: false };
      },
      edgeLabel(e) { return { top: this.t('Top'), bottom: this.t('Bottom'), left: this.t('Left'), right: this.t('Right'), insideH: this.t('Inside, horizontal'), insideV: this.t('Inside, vertical') }[e]; },
      applyCellProps() {
        const p = this.cellProps; const g = this.selRange(); const b = this.bord;
        const line = b.style === 'none' ? '' : (b.style === 'double' ? Math.max(3, b.width) : b.width) + 'px ' + b.style + ' ' + b.colour;
        // the line the dialog opened with: an edge that kept it is not rewritten with it
        const lineAtOpen = this._bordOpenLine;
        this.withStep((rec) => {
          this.eachSelCell((sh, r, c) => {
            rec(sh, r, c);
            const meta = sh.meta.get(K(r, c)) || {}; const s = Object.assign({}, meta.s || {});
            const put = (k, v) => { if (v === '' || v === false || v == null) { delete s[k]; } else { s[k] = v; } };
            put('ha', p.ha); put('va', p.va); put('wrap', p.wrap ? 1 : ''); put('font', p.font); put('size', p.size ? Number(p.size) : ''); put('b', p.b ? 1 : ''); put('i', p.i ? 1 : ''); put('u', p.u ? 1 : ''); put('strike', p.strike ? 1 : ''); put('color', p.color); put('bg', p.bg);
            const top = r === g.r0; const bottom = r === g.r1; const left = c === g.c0; const right = c === g.c1;
            // an edge that is on and still has the line it came with is left as it is (another edge's line may be the one shown)
            const edge = (key, which) => { const st = b.edges[which]; if (st === 'keep') { return; } if (st === 'none') { delete s[key]; } else if (line && !(b.orig && b.orig[which] && b.orig[which] === s[key] && line === lineAtOpen)) { s[key] = line; } };
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
      /**
       * The sheet as pages, in an isolated frame: the used range (or the selection,
       * or every sheet) cut into pages by the book's paper setup -- down first,
       * then across, as Calc prints -- each page a table of its own, scaled as the
       * setup says, with the repeated rows on top, and the header and footer in the
       * page's margins where the printer counts the pages.
       */
      doPrint() {
        const p = normalisePaper(this.paper);
        this.refreshUsed();
        const sheets = this.print.range === 'book' ? UIS.slice() : [this.sheet()];
        const now = new Date();
        const about = { title: this.book.name || this.t('Untitled book'), name: (this.book.name || this.t('Untitled book')) + '.html', date: now.toLocaleDateString(), time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
        const parts = []; const names = [];
        const defFont = this.fontsInUse.body; const defPx = (this.settings.fontSize || 11) * 4 / 3;
        sheets.forEach((sh, si) => {
          names.push(sh.name);
          let g = { r0: 0, c0: 0, r1: Math.max(0, sh.maxR), c1: Math.max(0, sh.maxC) };
          if (this.print.range === 'selection' && sh === this.sheet()) { const s = this.selRange(); g = { r0: s.r0, c0: s.c0, r1: Math.min(s.r1, Math.max(sh.maxR, s.r0)), c1: Math.min(s.c1, Math.max(sh.maxC, s.c0)) }; }
          (sh.images || []).forEach((im) => { if (this.print.range !== 'selection') { g.r1 = Math.max(g.r1, im.r); g.c1 = Math.max(g.c1, im.c); } });
          const pg = paginate(sh, g, p);
          const repeatRows = []; for (let r = g.r0; r < g.r0 + pg.repeat; r += 1) { repeatRows.push(r); }
          pg.pages.forEach((page) => {
            const rows = []; for (let r = page.r0; r <= page.r1; r += 1) { rows.push(r); }
            const cols = []; for (let c = page.c0; c <= page.c1; c += 1) { cols.push(c); }
            const shownRows = repeatRows.concat(rows);
            const rowSet = new Set(shownRows); const colSet = new Set(cols);
            // a merge is drawn from its first cell on the page, clipped to the page
            const spans = new Map(); const hidden = new Set();
            sh.merges.forEach((m) => {
              const mr = shownRows.filter((r) => r >= m.r0 && r <= m.r1); const mc = cols.filter((c) => c >= m.c0 && c <= m.c1);
              if (!mr.length || !mc.length || (mr.length === 1 && mc.length === 1 && m.r0 === m.r1 && m.c0 === m.c1)) { return; }
              spans.set(K(mr[0], mc[0]), { rs: mr.length, cs: mc.length, own: mr[0] === m.r0 && mc[0] === m.c0 });
              mr.forEach((r) => mc.forEach((c) => { if (r !== mr[0] || c !== mc[0]) { hidden.add(K(r, c)); } }));
            });
            // where each column and row of this page is on the paper, for what is drawn beside the table
            const colX = new Map(); let tableW = p.headings ? 34 : 0; cols.forEach((c) => { colX.set(c, tableW); tableW += colW(sh, c); });
            const rowY = new Map(); { let y = p.headings ? 18 : 0; repeatRows.concat(rows).forEach((r) => { rowY.set(r, y); y += rowH(sh, r); }); }
            /*
             * Writing that does not fit its cell is drawn as the screen draws it, but under the table
             * (z-index -1): the cells it runs over let it show (class cl, their fill drawn beneath it),
             * and every other cell is white and covers it. So the paper looks cut where the screen is cut,
             * and yet every word is in the PDF, as in LibreOffice's (a browser leaves out what it clips).
             */
            const under = []; const clear = new Set();
            const fillUnder = (r, c, w, h, bg) => { under.push('<div class="ul" style="left:' + colX.get(c) + 'px;top:' + rowY.get(r) + 'px;width:' + w + 'px;height:' + h + 'px;background-color:' + esc(bg) + ';z-index:-2"></div>'); };
            const cellHtml = (r, c) => {
              if (hidden.has(K(r, c))) { return ''; }
              const gg = wb.get(sh.name, r, c); const meta = sh.meta.get(K(r, c)); const sp = spans.get(K(r, c));
              const s = (meta && meta.s) || null;
              const cls = []; const a = [];
              if (sp) { if (sp.cs > 1) { a.push(' colspan="' + sp.cs + '"'); } if (sp.rs > 1) { a.push(' rowspan="' + sp.rs + '"'); } }
              if (gg.t === 'n' || gg.t === 'b') { cls.push('n'); } else if (gg.t === 'e') { cls.push('e'); }
              let text = ''; let fmtColor = '';
              if (gg.t) { const info = Calc.formatInfo ? Calc.formatInfo(gg.v, gg.t, fmtOf(meta, gg), 'ja') : { text: Calc.format(gg.v, gg.t, fmtOf(meta, gg), 'ja') }; text = info.text; fmtColor = info.color || ''; }
              if (!this.view.zeros && gg.t === 'n' && gg.v === 0) { text = ''; }
              let css = meta ? styleToCss(s) : '';
              // a heading style's cell is in the book's heading face, as on the screen
              if (meta && !(s && s.font) && this.familyOf(meta) !== defFont) { css += (css ? ';' : '') + 'font-family:' + fontStack(this.familyOf(meta), 'sans'); }
              // the colour of the writing as the screen picks it: the format's ([Red]), or one that reads on the fill
              if (s && !s.color && (fmtColor || s.bg)) { css += (css ? ';' : '') + 'color:' + (fmtColor || inkFor(s.bg)); } else if (!s && fmtColor) { css = 'color:' + fmtColor; }
              if (css) { a.push(' style="' + esc(css) + '"'); }
              let w = 0; for (let cc = c; cc < c + (sp ? sp.cs : 1) && cc <= page.c1; cc += 1) { w += colW(sh, cc); }
              let h = 0; for (let rr = r; rr < r + (sp ? sp.rs : 1); rr += 1) { h += rowH(sh, rr); }
              // a cell the writing of another runs over: see-through, its fill beneath the writing
              const open = () => { cls.push('cl'); if (s && s.bg) { fillUnder(r, c, w, h, s.bg); } };
              const td = (inner) => '<td' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + a.join('') + '>' + inner + '</td>';
              if (clear.has(K(r, c))) { open(); }
              if (!text) { return td(''); }
              const isNum = gg.t === 'n' || gg.t === 'b';
              const ha = (s && s.ha) || (isNum ? 'right' : gg.t === 'e' ? 'center' : 'left');
              const px = s && s.size ? s.size * 4 / 3 : defPx; const fam = this.familyOf(meta);
              const lines = text.indexOf('\n') >= 0;
              // writing taller than its row (wrapped, several lines, or a large size) keeps the row's height and is cut by the cells above, as on screen
              if ((s && s.wrap) || lines || px * 1.25 > h - 1) {
                const va = s && s.va === 'top' ? 'flex-start' : s && s.va === 'middle' ? 'center' : 'flex-end';
                if (!clear.has(K(r, c))) { open(); }
                return td('<div class="wr' + (s && s.wrap ? ' ww' : '') + '" style="height:' + Math.max(1, h - 1) + 'px;justify-content:' + va + '">' + esc(text) + '</div>');
              }
              const font = fontCss(s && s.b, px, fam);
              let tx = textWidth(text, font);
              if (tx + 8 <= w) { return td(esc(text)); }
              const room = w - 2 * CELL_MARGIN;
              if (gg.t === 'n') {
                text = fmtOf(meta, gg) ? (tx > room ? '###' : text) : fitNumber(text, gg.v, room - 2 * NUM_GAP, font);
                tx = textWidth(text, font);
                if (tx + 8 <= w || text === '###') { return td(esc(text)); }
              } else if (gg.t === 'b' && tx > room) { return td('###'); }
              // left-aligned writing runs on over the empty cells to its right on this page (as the screen)
              if (ha === 'left' && !sp && !mergeAt(sh, r, c)) {
                let cc = c + 1; let ext = w;
                while (cc <= page.c1 && ext < tx + 8) { if (wb.get(sh.name, r, cc).t || hidden.has(K(r, cc))) { break; } if (colW(sh, cc) > 0) { clear.add(K(r, cc)); } ext += colW(sh, cc); cc += 1; }
              }
              if (!clear.has(K(r, c))) { open(); }
              const full = Math.ceil(tx + 8);
              const left = ha === 'right' ? colX.get(c) + w - full : ha === 'center' ? colX.get(c) + (w - full) / 2 : colX.get(c);
              const deco = s && (s.u || s.strike) ? ';text-decoration:' + [s.u ? 'underline' : '', s.strike ? 'line-through' : ''].join(' ').trim() : '';
              // beyond the table there is no cell to cover it: white there
              const top = rowY.get(r);
              if (left < 0) { under.push('<div class="ul" style="left:' + left + 'px;top:' + top + 'px;width:' + (-left) + 'px;height:' + h + 'px;background:#fff;z-index:-1"></div>'); }
              const html = td('<span class="ov" style="left:' + left + 'px;width:' + full + 'px;text-align:' + ha + deco + '">' + esc(text) + '</span><i class="st"></i>');
              if (left + full > tableW) { under.push('<div class="ul" style="left:' + tableW + 'px;top:' + top + 'px;width:' + (left + full - tableW) + 'px;height:' + h + 'px;background:#fff;z-index:-1"></div>'); }
              return html;
            };
            const rowHtml = (r) => {
              const h = rowH(sh, r); if (h === 0) { return ''; }
              const tds = []; if (p.headings) { tds.push('<th class="rh">' + (r + 1) + '</th>'); }
              cols.forEach((c) => { if (colW(sh, c) > 0) { tds.push(cellHtml(r, c)); } });
              return '<tr style="height:' + h + 'px">' + tds.join('') + '</tr>';
            };
            const colsHtml = []; let width = 0;
            if (p.headings) { colsHtml.push('<col style="width:34px">'); width += 34; }
            cols.forEach((c) => { const w = colW(sh, c); if (w > 0) { colsHtml.push('<col style="width:' + w + 'px">'); width += w; } });
            let head = '';
            if (p.headings) { const ths = ['<th class="rh"></th>']; cols.forEach((c) => { if (colW(sh, c) > 0) { ths.push('<th>' + colName(c) + '</th>'); } }); head = '<tr class="ch" style="height:18px">' + ths.join('') + '</tr>'; }
            repeatRows.forEach((r) => { head += rowHtml(r); });
            const body = rows.map(rowHtml).join('');
            // the pictures tied to cells on this page
            const pics = [];
            const repeatH = (p.headings ? 18 : 0) + repeatRows.reduce((n, r) => n + rowH(sh, r), 0);
            (sh.images || []).forEach((im) => {
              if (!rowSet.has(im.r) || !colSet.has(im.c) || repeatRows.includes(im.r) || !safeImage(im.src)) { return; }
              const left = (p.headings ? 34 : 0) + colLeft(sh, im.c) - colLeft(sh, page.c0) + (im.dx | 0);
              const top = repeatH + rowTop(sh, im.r) - rowTop(sh, page.r0) + (im.dy | 0);
              const cr = cropOfImage(im);
              pics.push('<img src="' + esc(safeImage(im.src)) + '" alt="' + esc(im.alt || '') + '" style="position:absolute;left:' + left + 'px;top:' + top + 'px;width:' + Math.round(im.w) + 'px;height:' + Math.round(im.h) + 'px' + (cr ? ';object-fit:cover;object-position:' + cr.x + '% ' + cr.y + '%' : '') + '">');
            });
            parts.push('<section class="pg s' + si + '"><div class="pgw" style="zoom:' + (Math.round(pg.scale * 1000) / 1000) + '"><table style="width:' + width + 'px"><colgroup>' + colsHtml.join('') + '</colgroup>' +
              (head ? '<thead>' + head + '</thead>' : '') + '<tbody>' + body + '</tbody></table>' + under.join('') + pics.join('') + '</div></section>');
          });
        });
        const css = pageCss(p, about, names, (i) => '.pg.s' + i) + '\n' +
          'body{margin:0;font-family:' + fontStack(defFont, 'sans') + ';font-size:' + (this.settings.fontSize || 11) + 'pt;color:#111;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
          '.pg{break-after:page;page-break-after:always}.pg:last-child{break-after:auto;page-break-after:auto}.pgw{position:relative;z-index:0;width:max-content}' +
          'table{border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}' +
          // 3.5 px and the half of the 1 px border the collapsed table gives each cell: the writing starts 4 px in, and wraps
          // in the same width, as on the screen (with 4 px a line of Noto Sans JP that just fitted on the screen broke a character early on paper)
          'td,th{padding:0 3.5px;overflow:hidden;white-space:nowrap;vertical-align:bottom;line-height:1.25;' + (p.grid ? 'border:1px solid #999;' : 'border:1px solid transparent;') + '}' +
          'td.n{text-align:right}td.e{color:#c62828;font-weight:600;text-align:center}' +
          'td{background:#fff}td.cl{background:transparent!important;overflow:visible}.ul{position:absolute}' +
          '.ov{position:absolute;z-index:-1;white-space:pre;box-sizing:border-box;padding:0 4px;line-height:1.25}.st{display:inline-block;width:0;height:0}' +
          '.wr{position:relative;z-index:-1;display:flex;flex-direction:column;white-space:pre}.wr.ww{white-space:pre-wrap;overflow-wrap:anywhere}' +
          'th{background:#eee;font-weight:400;color:#555;font-size:9pt;text-align:center}th.rh{width:34px}tr{page-break-inside:avoid;break-inside:avoid}';
        // the book's faces come with it, as they do in the saved file (EditBase's print does the same)
        const html = '<!DOCTYPE html><html lang="' + esc(this.bookLang || uiLang()) + '"><head><meta charset="utf-8"><title>' + esc(this.book.name) + '</title>' + fontLinksHtml(fontsUrl(this.bookFamilies())) + '<style>' + css + '</style></head><body>' + parts.join('') + '</body></html>';
        this.printOpen = false;
        this.lastPrintHtml = html;
        printHtml(html);
      },

      // ---- the AI assistant: one question, and a reading goes round again with what was read (as EditBase) ----
      async aiSend() {
        const text = this.ai.input.trim();
        const images = this.ai.images.slice();
        if ((!text && !images.length) || this.ai.busy || !this.ai.ready) { return; }
        this.ai.input = ''; this.ai.error = ''; this.ai.images = []; this.ai.attNote = '';
        this.ai.msgs.push({ role: 'user', text, images: images.map((im) => ({ url: im.url, name: im.name })) });
        this.aiScroll();
        await this.aiRound(text, 0, images);
      },
      /** Images go with the first round only; a turn that had images says how many. */
      async aiRound(message, round, images = []) {
        const ticket = this.ai.ask;
        const history = this.ai.msgs.slice(0, -1).map((m) => (m.images && m.images.length ? { role: m.role, text: m.text, images: m.images.length } : { role: m.role, text: m.text }));
        this.ai.busy = true;
        if (!round) { this.ai.busyText = ''; }
        this.aiScroll();
        let answer = null;
        try {
          const r = await api('ai/ask', { method: 'POST', body: { history, message, context: this.aiContext(), images: images.map((im) => ({ type: im.type, data: im.data })) } });
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
          if (ticket === this.ai.ask) { this.ai.busy = false; this.ai.busyText = ''; this.ai.error = this.aiError(e); this.aiScroll(); }
          return;
        }
        if (ticket !== this.ai.ask) { return; }
        const parsed = (answer && typeof answer === 'object' && (typeof answer.reply === 'string' || Array.isArray(answer.edits))) ? { reply: String(answer.reply || answer.text || ''), edits: Array.isArray(answer.edits) ? answer.edits : null, bad: false } : aiAnswer(answer && typeof answer === 'object' ? answer.text : answer);
        const msg = { role: 'assistant', text: parsed.reply || String((answer && answer.text) || ''), reply: parsed.reply, did: '' };
        this.ai.msgs.push(msg);
        const read = answer && typeof answer === 'object' && answer.read && typeof answer.read === 'object' ? answer.read : null;
        if (read && round < 6) {
          this.ai.busyText = this.aiReadLabel(read);
          const found = await this.aiRead(read);
          if (ticket !== this.ai.ask) { return; }
          msg.did = this.aiReadDone(read);
          const follow = 'What CalcBase read for ' + JSON.stringify(read) + ':\n' + found;
          this.ai.msgs.push({ role: 'user', text: follow, hidden: true });
          return this.aiRound(follow, round + 1);
        }
        if (parsed.edits && parsed.edits.length) { msg.did = this.aiApply(parsed.edits); }
        else if (parsed.bad) { msg.did = this.t('The assistant\'s list of changes could not be read, so nothing was changed.'); }
        this.ai.busy = false; this.ai.busyText = '';
        this.aiScroll();
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
        const pic = tgt.closest('.cb-pic, .cb-pic-h');
        if (pic) { this.imgSel = pic.dataset.img; this.paintImages(); this.ctx.kind = 'image'; this.placeCtx(e.clientX, e.clientY); return; }
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
      toggleMenu(k) {
        this.menu = this.menu === k ? '' : k;
        // the faces used in the book are worked out as the list of faces opens (as EditBase's)
        if (this.menu === 'font') { this.refreshUsedFonts(); }
        if (this.menu) { this.$nextTick(() => this.fitMenu()); }
      },

      // ---- categories: the folders inside the save folder, as EditBase keeps them ----
      async loadFolders() {
        try {
          const f = await api('folders');
          const list = (f && f.folders) || (Array.isArray(f) ? f : []);
          this.folders = list.map((x) => (typeof x === 'string' ? x : String(x.path || x.name || ''))).filter(Boolean);
        } catch (e) { this.folders = []; }
      },
      /** The category a book is filed in ('' for none), as the list says it. */
      bookFolder(b) { return String((b && b.folder) || '').replace(/^\/+|\/+$/g, ''); },
      /**
       * A book dragged from one category to another: the same move the Files app
       * would make -- the file goes into the other folder.
       */
      liftBook(b, e) {
        this.dragBook = b.id; this.dropCat = null;
        if (e && e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'calcbase-book'); }
      },
      overCat(g) { if (!this.dragBook) { return; } this.dropCat = g.theirs ? null : g.key; },
      async dropOnCat(g) {
        const id = this.dragBook; this.dragBook = 0; this.dropCat = null; this.dropBook = null;
        if (!id || !g || g.theirs) { return; }
        const b = this.books.find((x) => x.id === id);
        if (!b || b.shared || this.bookFolder(b) === g.key) { return; }
        await this.moveBook(b, g.key);
      },
      overBook(g, b, e) {
        if (!this.dragBook) { return; }
        const r = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        if (!this.dropBook || this.dropBook.id !== b.id || this.dropBook.after !== after) { this.dropBook = { id: b.id, after }; }
        this.dropCat = g.theirs ? null : g.key;
      },
      /** A book dropped before or after another: the order inside the category changes (kept in the settings), as EditBase. */
      async dropOnBook(g, b) {
        const id = this.dragBook; const after = !!(this.dropBook && this.dropBook.after);
        this.dragBook = 0; this.dropCat = null; this.dropBook = null;
        if (!id || !g || !b || id === b.id) { return; }
        const src = this.books.find((x) => x.id === id);
        if (!src) { return; }
        if (!g.books.some((x) => x.id === id)) { if (src.shared || g.theirs) { return; } await this.moveBook(src, g.key); }
        const ids = g.books.map((x) => x.id).filter((x) => x !== id);
        const at = ids.indexOf(b.id);
        ids.splice(at < 0 ? ids.length : at + (after ? 1 : 0), 0, id);
        await this.saveBookOrder(g.key, ids);
      },
      async saveBookOrder(key, ids) {
        const next = Object.assign({}, this.bookOrder);
        if (ids && ids.length) { next['c:' + key] = ids; } else { delete next['c:' + key]; }
        this.bookOrder = next;
        try { await api('settings', { method: 'POST', body: { bookOrder: JSON.stringify(next) } }); }
        catch (e) { this.notify(this.t('Could not save the settings: {msg}', { msg: e.message })); }
      },
      /** One category open at a time, the way a drawer is. */
      toggleCat(key) { this.openCat = this.openCat === key ? '' : key; try { window.localStorage.setItem('cb-cat', this.openCat); } catch (e) { /* not kept */ } },
      catCtx(e, g) { this.ctx.kind = 'cat'; this.ctx.cat = g; this.placeCtx(e.clientX, e.clientY); },
      /** The colour a category is drawn in, kept with the person's own settings. */
      async setCatColour(key, colour) {
        this.closeCtx();
        const next = Object.assign({}, this.catColours);
        if (colour) { next[key] = colour; } else { delete next[key]; }
        this.catColours = next;
        try { await api('settings', { method: 'POST', body: { folderColours: JSON.stringify(next) } }); }
        catch (e) { this.notify(this.t('Could not save the settings: {msg}', { msg: e.message })); }
      },
      startCategory() { this.catNew = ''; this.naming = true; this.$nextTick(() => { if (this.$refs.catName) { this.$refs.catName.focus(); } }); },
      async makeCategory() {
        if (!this.naming) { return; }
        const name = String(this.catNew || '').trim();
        this.naming = false; this.catNew = '';
        if (!name) { return; }
        try {
          const made = await api('folders', { method: 'POST', body: { path: name } });
          await this.loadBooks();
          this.openCat = (made && made.folder) || name;
        } catch (e) { this.notify(this.t('Could not make the category: {msg}', { msg: e.message })); }
      },
      /** Deleting a category: an empty one only, so no book goes with it (as EditBase). */
      async deleteCategory(g) {
        this.closeCtx();
        if (!g || !g.key) { return; }
        const inside = this.books.filter((b) => { const f = this.bookFolder(b); return !b.shared && (f === g.key || f.indexOf(g.key + '/') === 0); }).length;
        if (inside) { this.notify(this.t('The category "{name}" still has {n} books in it. Move or delete them first.', { name: g.label, n: inside }), 6000); return; }
        if (!window.confirm(this.t('Delete the category "{name}"?', { name: g.label }))) { return; }
        try {
          await api('folders?path=' + encodeURIComponent(g.key), { method: 'DELETE' });
          await this.loadBooks();
          if (this.openCat === g.key) { this.openCat = ''; }
        } catch (e) {
          this.notify(/not empty/.test(e.message) ? this.t('The category "{name}" still has files in it. Move or delete them first.', { name: g.label }) : this.t('Could not delete the category: {msg}', { msg: e.message }), 6000);
        }
      },
      /** Put a book in another category. In Files it is the same move. */
      async moveBook(b, folder) {
        this.closeCtx();
        if (!b || !b.id) { return; }
        try {
          if (b.id === this.book.id) { await this.saveNow(); }
          const moved = await api('books/' + b.id + '/move', { method: 'POST', body: { folder: folder || '' } });
          if (b.id === this.book.id && moved) { if (moved.path) { this.book.path = moved.path; } this.book.folder = folder || ''; }
          await this.loadBooks();
          this.openCat = folder || '';
        } catch (e) { this.notify(this.t('Could not move it: {msg}', { msg: e.message })); }
      },
      /** Any folder in Files, through the picker (the way 0.0.1 moved a book). */
      async moveBookToFolder(b) {
        this.closeCtx();
        const folder = await this.pickFolder();
        if (folder == null) { return; }
        try {
          if (b.id === this.book.id) { await this.saveNow(); }
          await api('books/' + b.id + '/move', { method: 'POST', body: { folder } });
          await this.loadBooks();
        } catch (e) { this.notify(this.t('Could not move it: {msg}', { msg: e.message })); }
      },

      // ---- sharing: Nextcloud's own, as EditBase ----
      async shareCategory(g) {
        this.closeCtx();
        if (!g || !g.key || g.theirs) { return; }
        try {
          const r = await api('folders/id?path=' + encodeURIComponent(g.key));
          this.share = { open: true, id: r.id, title: g.label, term: '', found: [], list: [], category: true, busy: true };
          await this.reloadShares();
        } catch (e) { this.notify(this.t('Could not share it: {msg}', { msg: e.message })); }
      },
      async openShare(b) {
        this.closeCtx(); this.menuOpen = false;
        if (!b || !b.id) { return; }
        this.share = { open: true, id: b.id, title: b.title || String(b.name || '').replace(/\.html?$/i, ''), term: '', found: [], list: [], category: false, busy: true };
        await this.reloadShares();
      },
      async reloadShares() {
        try { const r = await api('books/' + this.share.id + '/shares'); this.share.list = (r && r.shares) || []; }
        catch (e) { this.notify(this.t('Could not read who it is shared with: {msg}', { msg: e.message })); }
        this.share.busy = false;
      },
      findShareUsers() {
        clearTimeout(this._shareTimer);
        const term = String(this.share.term || '').trim();
        if (!term) { this.share.found = []; return; }
        this._shareTimer = setTimeout(async () => {
          try {
            const r = await api('users?search=' + encodeURIComponent(term));
            const already = new Set((this.share.list || []).map((p) => p.with));
            this.share.found = ((r && r.users) || []).filter((u) => !already.has(u.id)).slice(0, 8);
          } catch (e) { this.share.found = []; }
        }, 250);
      },
      async addShare(who, canEdit) {
        try {
          const r = await api('books/' + this.share.id + '/shares', { method: 'POST', body: { with: who, canEdit: !!canEdit } });
          this.share.list = (r && r.shares) || []; this.share.term = ''; this.share.found = [];
        } catch (e) { this.notify(this.t('Could not share it: {msg}', { msg: e.message })); }
      },
      async dropShare(id) {
        try {
          const r = await api('books/' + this.share.id + '/shares/remove', { method: 'POST', body: { share: id } });
          this.share.list = (r && r.shares) || [];
        } catch (e) { this.notify(this.t('Could not stop sharing it: {msg}', { msg: e.message })); }
      },

      // ---- what a book is, told from the file ----
      // ---- the book's own settings (EditBase's document settings) ----
      /** Open the book's settings -- opening the book first if it is not the one open. */
      async openBookSettings(b) {
        this.closeCtx();
        if (!b) { return; }
        if (this.book.id !== b.id) { await this.openBook(b.id); if (this.book.id !== b.id) { return; } }
        this.bookSet = { open: true, title: this.book.name || '', lang: this.bookLang || uiLang(), head: normaliseHead(this.bookHead) };
      },
      /** Apply in the book's settings: what changed is put on the book (one step to undo), and saved with it. */
      applyBookSettings() {
        if (this.book.readOnly) { this.bookSet.open = false; return; }
        const head = normaliseHead(this.bookSet.head);
        const title = String(this.bookSet.title || '').trim();
        const lang = cleanLang(this.bookSet.lang) || this.bookLang || 'ja';
        this.bookSet.open = false;
        const was = { head: normaliseHead(this.bookHead), lang: this.bookLang };
        const now = { head, lang };
        if (JSON.stringify(was) !== JSON.stringify(now)) {
          const apply = (v) => {
            const relocale = calcLocaleOf(v.lang) !== calcLocaleOf(this.bookLang);
            this.bookHead = normaliseHead(v.head); this.bookLang = v.lang;
            if (relocale) { this.relocale(); }
            this.applyBookFonts(); this.touch(); this.paint();
          };
          apply(now);
          this.pushStep({ undo: () => apply(was), redo: () => apply(now) });
        }
        // the page's title is the book's name, as EditBase's is the document's: changing it renames the file
        if (title && title !== this.book.name) { this.book.name = title; this.applyTitle(); }
      },
      /** The calculation taken again in the book's language: what was typed as text is read in it (DATEVALUE, TIMEVALUE, VALUE). */
      relocale() {
        const model = toFullModel(wb, UIS, this.active);
        wb = Calc.workbook({ locale: calcLocaleOf(this.bookLang) });
        wb.load(model);
        this.syncRowState();
        if (wb.recalc) { try { wb.recalc(); } catch (e) { /* recalculated on load */ } }
        this._pbCache = null; this.tick += 1; this.syncSel();
      },
      async openBookProps(b) {
        this.closeCtx(); this.menuOpen = false;
        if (!b || !b.id) { return; }
        const folder = this.bookFolder(b);
        this.props = { open: true, title: b.title || String(b.name || '').replace(/\.html?$/i, ''), name: /\.html?$/i.test(b.name || '') ? b.name : (b.name || b.title || '') + '.html',
          where: b.shared ? this.t('{folder} — from {who}', { folder: folder || this.t('Shared with me'), who: b.owner || '' }) : (this.settings.folder + (folder ? '/' + folder : '')),
          size: b.size || 0, mtime: b.mtime || 0, sheets: '…', cells: '…', formulas: '…', paper: '…' };
        try {
          let model; let count; let paper;
          if (b.id === this.book.id) { model = wb.toModel(); count = UIS.length; paper = this.paper; }
          else { const d = await api('books/' + b.id); const parsed = parseBook(d.content || ''); model = parsed.model; count = parsed.uis.length; paper = parsed.book.paper; }
          let cells = 0; let formulas = 0;
          model.sheets.forEach((s) => { Object.keys(s.cells || {}).forEach((k) => { const c = s.cells[k]; if (c.t || c.f) { cells += 1; } if (c.f) { formulas += 1; } }); });
          Object.assign(this.props, { sheets: count, cells, formulas, paper: this.paperLabelOf(paper) });
        } catch (e) { this.props.paper = e.message; }
      },
      paperLabelOf(p) {
        const n = normalisePaper(p);
        return n.size + ' ' + (n.orientation === 'landscape' ? this.t('Landscape') : this.t('Portrait')) + ' · ' + n.margin.top + '/' + n.margin.right + '/' + n.margin.bottom + '/' + n.margin.left + ' mm';
      },

      // ---- the check: what is wrong with the book that cannot be seen by looking ----
      runCheck() {
        this.menuOpen = false; this.checks = []; this.checkOpen = true;
        if (!wb) { return; }
        this.refreshUsed();
        const found = [];
        const kinds = { error: this.t('Error'), empty: this.t('Empty reference'), text: this.t('Number as text'), wide: this.t('Too wide') };
        const add = (kind, what, sheet, r, c) => { if (found.length < 500) { found.push({ kind, label: kinds[kind], what, sheet, r, c, where: (UIS.length > 1 ? sheet + '.' : '') + refName(r, c) }); } };
        const room = printable(this.paper).w * MM;
        const m = wb.toModel();
        m.sheets.forEach((s) => {
          const u = UIS.find((x) => x.name === s.name); if (!u) { return; }
          const keys = Object.keys(s.cells).map((k) => ({ k, p: parseRef(k) })).filter((x) => x.p).sort((a, b) => a.p.r - b.p.r || a.p.c - b.p.c);
          keys.forEach(({ p }) => {
            const g = wb.get(s.name, p.r, p.c);
            if (g.t === 'e') {
              const v = String(g.v);
              const why = v === '#REF!' ? this.t('it points at cells that are no longer there') : v === '#DIV/0!' ? this.t('it divides by nought or by an empty cell')
                : v === '#NAME?' ? this.t('it names a function or a name the book does not know') : v === '#N/A' ? this.t('a lookup found nothing')
                  : v === 'Err:522' ? this.t('the formula refers to itself, round a circle') : v === '#VALUE!' ? this.t('a value is of the wrong kind') : this.t('the formula cannot be worked out');
              add('error', this.t('{v}: {why}.', { v, why }), s.name, p.r, p.c);
              return;
            }
            if (g.f) {
              const refs = refsInFormula(g.f);
              if (!refs.length) { return; }
              let any = false; let looked = 0;
              refs.forEach((ref) => {
                if (any) { return; }
                const target = ref.sheet == null ? s.name : ref.sheet; const tu = UIS.find((x) => x.name === target);
                if (!tu) { any = true; return; }
                const rg = ref.range;
                for (let r = rg.r0; r <= Math.min(rg.r1, tu.maxR) && !any; r += 1) {
                  for (let c = rg.c0; c <= Math.min(rg.c1, tu.maxC); c += 1) { looked += 1; if (looked > 20000 || wb.get(target, r, c).t) { any = true; break; } }
                }
              });
              if (!any) { add('empty', this.t('{f} points only at empty cells.', { f: g.f }), s.name, p.r, p.c); }
              return;
            }
            if (g.t === 's') {
              const v = String(g.v).trim();
              if (/^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(v)) { add('text', this.t('“{v}” is a number kept as text, so sums leave it out.', { v }), s.name, p.r, p.c); }
            }
          });
          // a column wider than the paper cannot be printed whole on one page
          const cols = Array.from(u.cols.entries()).sort((a, b) => a[0] - b[0]);
          cols.forEach(([c, w]) => { if (w > room) { add('wide', this.t('Column {col} is {w} px wide and the paper has room for {room} px.', { col: colName(c), w, room: Math.round(room) }), s.name, 0, c); } });
        });
        this.checks = found;
      },
      showCheck(i) {
        const one = this.checks[i]; if (!one) { return; }
        this.checkOpen = false;
        const idx = UIS.findIndex((x) => x.name === one.sheet);
        if (idx >= 0 && idx !== this.active) { this.switchSheet(idx); }
        this.$nextTick(() => { this.setCur(one.r, one.c); this.focusGrid(); });
      },

      // ---- the book as a web page, in a new tab ----
      webPreview() {
        if (!this.book.id) { return; }
        // What is on the screen, written as the file is saved; nothing is written to Files.
        const html = this.currentHtml();
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
        // Not "noopener": with it the browser answers null whether or not the tab opened, and a blocked tab could not be told.
        const win = window.open(url, '_blank');
        if (win) { try { win.opener = null; } catch (e) { /* the page has no script anyway */ } }
        else { this.notify(this.t('The browser blocked the new tab. Allow pop-ups for this site to see the page.'), 6000); }
        this.lastPreviewHtml = html;
        setTimeout(() => URL.revokeObjectURL(url), 120000);
      },
      /**
       * A page left open goes on running the code it was loaded with. The app asks
       * the server what it is serving whenever the window is looked at again, and
       * says so (as EditBase).
       */
      watchForNewBuild() {
        const check = async () => {
          if (!this.build || this.newBuild) { return; }
          try { const s = await api('settings'); if (s && s.build && s.build !== this.build) { this.newBuild = true; } } catch (e) { /* offline: ask again later */ }
        };
        document.addEventListener('visibilitychange', () => { if (!document.hidden) { check(); } });
        window.addEventListener('focus', check);
        window.setInterval(check, 5 * 60 * 1000);
      },
      async reloadForNewBuild() {
        try { await this.saveNow(); } catch (e) { /* reload anyway */ }
        window.location.reload();
      },

      // ---- the paper setup: kept in the book ----
      openPaper(tab) { this.menu = ''; this.printOpen = false; this.paperTab = tab === 'text' ? 'text' : 'paper'; this.paperOpen = true; },
      touchPaper() {
        this.paper = normalisePaper(this.paper);
        this._pbCache = null;
        if (!this.book.id || this.book.readOnly) { return; }
        this.touch(); this.paint();
      },
      async saveDefaultPaper() {
        try {
          // the book's own typefaces go with it, as EditBase's paper carries its fonts
          await api('settings', { method: 'POST', body: { paper: JSON.stringify(Object.assign({}, normalisePaper(this.paper), { fonts: normaliseFonts(this.bookFonts) })) } });
          this.defaultPaperSetting = normalisePaper(this.paper);
          this.defaultBookFonts = normaliseFonts(this.bookFonts);
          this.notify(this.t('New books will start with this paper setup and these typefaces.'));
        } catch (e) { this.notify(this.t('Could not save the settings: {msg}', { msg: e.message })); }
      },
      putRunToken(tag) {
        const which = this.runAt[0] === 'header' ? 'header' : 'footer'; const slot = ['l', 'c', 'r'].indexOf(this.runAt[1]) >= 0 ? this.runAt[1] : 'c';
        this.paper[which][slot] = (this.paper[which][slot] || '') + tag;
        this.touchPaper();
      },
      /** Where the pages of a sheet fall, for the lines on the screen and the count in the dialogs. */
      pagesOf(sh, range) {
        const g = range || { r0: 0, c0: 0, r1: Math.max(0, sh.maxR), c1: Math.max(0, sh.maxC) };
        return paginate(sh, g, this.paper);
      },

      // ---- the view: what is shown, not what is saved ----
      toggleView(key) {
        this.view[key] = !this.view[key];
        try { window.localStorage.setItem('cb-view', JSON.stringify(this.view)); } catch (e) { /* not kept */ }
        this._pbCache = null;
        this.$nextTick(() => { this.layout(); this.focusGrid(); });
      },
      toggleSheetBar(on) {
        this.sheetBar.open = on == null ? !this.sheetBar.open : !!on;
        try { window.localStorage.setItem('cb-sheetbar', this.sheetBar.open ? '1' : '0'); } catch (e) { /* not kept */ }
        this.$nextTick(() => { this.layout(); this.scheduleThumbs(); });
      },
      sheetsWidthValue() {
        const u = this.settings.sheetsU === '%' ? '%' : 'px';
        let n = Number(this.settings.sheetsW);
        if (!(n > 0)) { n = u === '%' ? 10 : 132; }
        n = u === '%' ? Math.min(60, Math.max(3, n)) : Math.min(1200, Math.max(60, n));
        // a share of the window keeps a tenth, as the assistant's (the edge's arrow keys move it by 10 px)
        n = u === '%' ? Math.round(n * 10) / 10 : Math.round(n);
        if (this.settings.sheetsW !== n) { this.settings.sheetsW = n; }
        if (this.settings.sheetsU !== u) { this.settings.sheetsU = u; }
        return n + u;
      },
      sheetBarWidth() { return this.sheetsWidthValue().replace(/%$/, 'vw'); },
      sheetDragStart(i, e) {
        if (this.book.readOnly) { return; }
        this.dragSheet = i;
        if (e && e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'calcbase-sheet'); }
      },
      dropSheetAt(i) {
        const from = this.dragSheet; this.dragSheet = -1; this.dropSheet = -1;
        if (from < 0 || from === i || i < 0 || i >= UIS.length) { return; }
        this.moveSheet(from, i - from);
        this.$nextTick(() => this.focusGrid());
      },
      scheduleThumbs() {
        if (!this.sheetBar.open || this.narrow) { return; }
        clearTimeout(this._thumbTimer);
        this._thumbTimer = setTimeout(() => this.paintThumbs(), 200);
      },
      /** Each sheet's top left corner, small: the cells' colours, their words as strokes, the gridlines. */
      paintThumbs() {
        if (!wb || !this.$el) { return; }
        const canvases = this.$el.querySelectorAll('.cb-sheetbar canvas.thumb');
        const cs = getComputedStyle(document.getElementById('calcbase-root') || document.body);
        const paper = (cs.getPropertyValue('--sheet') || '#ffffff').trim(); const ink = (cs.getPropertyValue('--sheet-ink') || '#111111').trim();
        const line = (cs.getPropertyValue('--gridline') || '#d4dae3').trim(); const muted = (cs.getPropertyValue('--muted') || '#64748b').trim();
        const dpr = window.devicePixelRatio || 1;
        canvases.forEach((cv) => {
          const sh = UIS[Number(cv.dataset.sheet)]; if (!sh) { return; }
          // Drawn at the size it is shown, in the screen's own pixels, so a wider bar is a bigger picture
          // of the same corner and not a blurred one; 240 x 168 is the picture at the scale it was made at.
          const cssW = cv.getBoundingClientRect().width || 240;
          const dw = Math.max(1, Math.round(cssW * dpr)); const dh = Math.max(1, Math.round(cssW * dpr * 168 / 240));
          if (cv.width !== dw) { cv.width = dw; }
          if (cv.height !== dh) { cv.height = dh; }
          const k = dw / 240; const z = cssW / 240;
          const ctx = cv.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); const W = cv.width; const H = cv.height; const s = 0.6 * k;
          ctx.fillStyle = paper; ctx.fillRect(0, 0, W, H);
          const cols = []; let x = 0; for (let c = 0; x < W / s && c < 60; c += 1) { const w = colW(sh, c); cols.push({ c, x, w }); x += w; }
          const rows = []; let y = 0; for (let r = 0; y < H / s && r < 200; r += 1) { const h = rowH(sh, r); rows.push({ r, y, h }); y += h; }
          if (sh.grid !== false) {
            ctx.strokeStyle = line; ctx.lineWidth = Math.min(1, z) * dpr; ctx.beginPath();
            cols.forEach((cc) => { if (!cc.w) { return; } const px = Math.round((cc.x + cc.w) * s) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, H); });
            rows.forEach((rr) => { if (!rr.h) { return; } const py = Math.round((rr.y + rr.h) * s) + 0.5; ctx.moveTo(0, py); ctx.lineTo(W, py); });
            ctx.stroke();
          }
          rows.forEach((rr) => {
            if (!rr.h) { return; }
            cols.forEach((cc) => {
              if (!cc.w) { return; }
              const meta = sh.meta.get(K(rr.r, cc.c)); const st = (meta && meta.s) || null; const g = wb.get(sh.name, rr.r, cc.c);
              if (st && st.bg) { ctx.fillStyle = st.bg; ctx.fillRect(cc.x * s, rr.y * s, cc.w * s, rr.h * s); }
              if (!g.t) { return; }
              const text = Calc.format(g.v, g.t, this.fmtAt(sh, rr.r, cc.c, g), 'ja');
              const tw = Math.min(cc.w * s - 2 * k, Math.max(2 * k, textWidth(text, '11px sans-serif') * s));
              ctx.fillStyle = g.t === 'e' ? '#c62828' : (st && st.color) ? st.color : (st && st.b ? ink : muted);
              const num = g.t === 'n' || g.t === 'b';
              ctx.fillRect(num ? cc.x * s + cc.w * s - tw - k : cc.x * s + k, rr.y * s + rr.h * s * 0.55, tw, (st && st.b ? 2.2 : 1.6) * k);
            });
          });
          (sh.images || []).forEach((im) => { ctx.fillStyle = 'rgba(37,99,235,.25)'; ctx.fillRect((colLeft(sh, im.c) + im.dx) * s, (rowTop(sh, im.r) + im.dy) * s, im.w * s, im.h * s); });
        });
      },

      // ---- the status bar ----
      statusCtx(e) { this.ctx.kind = 'status'; this.placeCtx(e.clientX, e.clientY); },
      toggleStat(k) {
        this.statusBar[k] = !this.statusBar[k];
        try { window.localStorage.setItem('cb-statusbar', JSON.stringify(this.statusBar)); } catch (e) { /* not kept */ }
        this.closeCtx();
        this.syncSel();
      },

      // ---- the named cell styles of the book ----
      styleProps(key) { return styleDef(this.bookStyles, key); },
      /** A named style on every cell of the selection: its formats written on the cells, its name beside them. */
      applyNamedStyle(key) {
        if (this.book.readOnly) { return; }
        this.focusGrid();
        const props = key ? this.styleProps(key) : null;
        this.withStep((rec) => {
          this.eachSelCell((sh, r, c) => {
            const meta = sh.meta.get(K(r, c)) || {};
            if (!key && !meta.style) { return; }
            rec(sh, r, c);
            if (!key) { this.setMeta(sh, r, c, { style: '', s: null }); return; }
            const s = Object.assign({}, props); delete s.fmt;
            const patch = { style: key, s };
            if (props.fmt) { patch.fmt = props.fmt; }
            this.setMeta(sh, r, c, patch);
          }, 20000);
        });
      },
      openStyles() {
        this.refreshUsedFonts();
        this.menu = '';
        const cur = this.fmtNow.style;
        this.styleKey = cur && this.namedStyleList.some((x) => x.key === cur) ? cur : (this.namedStyleList[0] || {}).key || 'Heading 1';
        this.loadStyleForm();
        this.stylesOpen = true;
      },
      loadStyleForm() {
        const s = this.styleProps(this.styleKey);
        let border = '';
        if (s.bt && s.bb && s.bl && s.br) { border = 'all'; }
        else if (s.bt && /double/.test(s.bb || '')) { border = 'total'; }
        else if (s.bt && s.bb) { border = 'topbottom'; } else if (s.bb) { border = 'bottom'; } else if (s.bt) { border = 'top'; }
        const colour = /#[0-9a-f]{6}/i.exec(s.bt || s.bb || s.bl || s.br || '');
        this.styleForm = { font: s.font || '', size: s.size || '', fmt: s.fmt || '', b: !!s.b, i: !!s.i, u: !!s.u, ha: s.ha || '', color: s.color || '', bg: s.bg || '', border, borderColour: colour ? colour[0] : '#333333' };
      },
      styleFormToProps() {
        const f = this.styleForm; const s = {};
        if (f.font) { s.font = f.font; } if (f.size) { s.size = Number(f.size); } if (f.fmt) { s.fmt = f.fmt; }
        if (f.b) { s.b = 1; } if (f.i) { s.i = 1; } if (f.u) { s.u = 1; } if (f.ha) { s.ha = f.ha; }
        if (f.color) { s.color = f.color; } if (f.bg) { s.bg = f.bg; }
        const line = '1px solid ' + (f.borderColour || '#333333');
        if (f.border === 'all') { s.bt = s.bb = s.bl = s.br = line; }
        if (f.border === 'topbottom') { s.bt = s.bb = line; }
        if (f.border === 'total') { s.bt = line; s.bb = '3px double ' + (f.borderColour || '#333333'); }
        if (f.border === 'bottom') { s.bb = line; } if (f.border === 'top') { s.bt = line; }
        return s;
      },
      /** Changing a style changes every cell that carries it, on every sheet, as one undoable step. */
      applyStyleForm() {
        if (this.book.readOnly) { return; }
        const key = this.styleKey; const props = this.styleFormToProps();
        const was = Object.assign({}, this.bookStyles);
        const next = Object.assign({}, this.bookStyles); next[key] = props;
        this.bookStyles = next;
        this.withStep((rec) => {
          UIS.forEach((sh) => {
            const keys = []; sh.meta.forEach((m, k) => { if (m.style === key) { keys.push(k); } });
            keys.forEach((k) => {
              const r = KR(k); const c = KC(k); rec(sh, r, c);
              const s = Object.assign({}, props); delete s.fmt;
              const patch = { style: key, s }; if (props.fmt) { patch.fmt = props.fmt; }
              this.setMeta(sh, r, c, patch);
            });
          });
        });
        // the definition goes back and forth with the cells
        const step = this.history[this.history.length - 1];
        if (step) { const u = step.undo; const rd = step.redo; step.undo = () => { this.bookStyles = was; u(); }; step.redo = () => { this.bookStyles = next; rd(); }; }
        else { this.pushStep({ undo: () => { this.bookStyles = was; this.touch(); }, redo: () => { this.bookStyles = next; this.touch(); } }); }
        this.touch();
        this.stylesOpen = false;
      },
      resetStyle() {
        const next = Object.assign({}, this.bookStyles); delete next[this.styleKey]; this.bookStyles = next;
        this.loadStyleForm();
      },

      // ---- typefaces (EditBase's) ----
      fontPreviewStack(family) { return fontStack(family, 'sans'); },
      catLabel(c) {
        const m = this.fontCats.find((x) => x.key === c);
        return m ? m.label : c;
      },
      scriptLabel(code) {
        const names = {
          latin: this.t('Latin'), 'latin-ext': this.t('Latin (extended)'), cyrillic: this.t('Cyrillic'),
          'cyrillic-ext': this.t('Cyrillic (extended)'), greek: this.t('Greek'), 'greek-ext': this.t('Greek (extended)'),
          vietnamese: this.t('Vietnamese'), japanese: this.t('Japanese'), korean: this.t('Korean'),
          'chinese-simplified': this.t('Chinese (simplified)'), 'chinese-traditional': this.t('Chinese (traditional)'),
          'chinese-hongkong': this.t('Chinese (Hong Kong)'), arabic: this.t('Arabic'), hebrew: this.t('Hebrew'),
          devanagari: this.t('Devanagari'), bengali: this.t('Bengali'), tamil: this.t('Tamil'), telugu: this.t('Telugu'),
          thai: this.t('Thai'), khmer: this.t('Khmer'), myanmar: this.t('Burmese'), sinhala: this.t('Sinhala'),
          gujarati: this.t('Gujarati'), kannada: this.t('Kannada'), malayalam: this.t('Malayalam'),
          oriya: this.t('Odia'), gurmukhi: this.t('Gurmukhi'), armenian: this.t('Armenian'),
          georgian: this.t('Georgian'), ethiopic: this.t('Ethiopic'), math: this.t('Mathematics'), symbols: this.t('Symbols'),
        };
        return names[code] || code;
      },
      /** Every face the book names: its own two, the cells' own, the cell styles'. */
      bookFamilies() {
        const out = [this.fontsInUse.body, this.fontsInUse.heading];
        const add = (f) => { if (f && out.indexOf(f) < 0) { out.push(f); } };
        UIS.forEach((u) => { let n = 0; for (const m of u.meta.values()) { n += 1; if (n > 300000) { break; } if (m && m.s && m.s.font) { add(m.s.font); } } });
        Object.keys(this.bookStyles || {}).forEach((k) => { const st = this.bookStyles[k]; if (st && st.font) { add(st.font); } });
        return out;
      },
      /** The faces used in the book besides its own two, for the lists of faces (EditBase's "used in this document"). */
      refreshUsedFonts() {
        const roles = [this.fontsInUse.body, this.fontsInUse.heading];
        this.usedFonts = this.bookFamilies().filter((f) => roles.indexOf(f) < 0).slice(0, 40);
      },
      /** The faces of the book, linked into this page so the sheet is drawn in them, and drawn again as they arrive. */
      applyBookFonts() {
        const fams = this.book.id ? this.bookFamilies() : [];
        linkStylesheet('cb-book-fonts', fontsUrl(fams));
        const load = () => {
          if (!document.fonts || !document.fonts.load) { return; }
          Promise.all(fams.map((f) => document.fonts.load('11pt "' + cleanFamily(f) + '"').catch(() => null))).then(() => this.fontsArrived()).catch(() => { /* drawn as it is */ });
        };
        const link = document.getElementById('cb-book-fonts');
        if (link && !link._cbWatched) { link._cbWatched = true; link.addEventListener('load', () => load()); }
        load();
        if (document.fonts && document.fonts.addEventListener && !this._fontsWatched) {
          this._fontsWatched = true;
          document.fonts.addEventListener('loadingdone', () => { clearTimeout(this._fontTimer); this._fontTimer = setTimeout(() => this.fontsArrived(), 60); });
        }
      },
      /** A face has arrived: what was measured in the stand-in (the ### of a number, a column fitted) is measured again. */
      fontsArrived() { forgetWidths(); this._pbCache = null; if (this.book.id) { this.paint(); } },
      async ensureFontCatalogue() {
        if (!fontsWanted()) { return; }
        try { await loadFonts(); this.applyBookFonts(); } catch (e) { /* the built-in faces still work */ }
      },
      async openFonts(role) {
        this.fontRole = role;
        this.fontsOpen = true;
        this.menu = '';
        this.fontQuery = '';
        this.fontPage = 1;
        this.fontCat = 'all';
        if (!this.fontList.length) {
          this.fontsLoading = true;
          try {
            const cat = await loadFonts();
            this.fontList = cat.families || [];
            this.fontScripts = cat.scripts || [];
            this.applyBookFonts();
          } catch (e) {
            this.notify(this.t('Could not load the font list: {msg}', { msg: e.message }));
          } finally { this.fontsLoading = false; }
        }
      },
      closeFonts() {
        this.fontsOpen = false;
        linkStylesheet('cb-font-preview', '');
        if (this.fontRole === 'selection') { this.focusGrid(); }
      },
      chooseFont(family) {
        const f = cleanFamily(family);
        if (this.fontRole === 'selection') { this.setStyle('font', f); }
        else if (this.fontRole === 'cell') { this.cellProps.font = f; }
        else if (this.fontRole === 'setting') { this.settings.font = f; }
        else if (this.fontRole === 'body' || this.fontRole === 'heading') {
          if (this.book.readOnly || !this.book.id) { return; }
          const was = Object.assign({}, this.bookFonts);
          const now = Object.assign({}, this.bookFonts, { [this.fontRole]: f });
          if (was[this.fontRole] === now[this.fontRole]) { return; }
          const apply = (v) => { this.bookFonts = Object.assign({}, v); this.applyBookFonts(); this.touch(); this.paint(); };
          apply(now);
          this.pushStep({ undo: () => apply(was), redo: () => apply(now) });
        }
        this.refreshUsedFonts();
        this.applyBookFonts();
      },
      /** Just enough of each listed family to draw its own name (EditBase's). */
      loadPreviewFonts() {
        if (!this.fontsOpen) { return; }
        const names = this.fontPageItems.map((f) => f.f).slice(0, 24);
        if (!names.length) { linkStylesheet('cb-font-preview', ''); return; }
        const text = names.join('') + this.sampleText;
        linkStylesheet('cb-font-preview', fontsUrl(names, text.slice(0, 1200)));
      },

      // ---- the typeface and the size (the boxes along the top) ----
      stepSize(d) {
        const now = Number(this.fmtNow.size || this.settings.fontSize || 11);
        this.setStyle('size', clamp(Math.round(now + d), 4, 200));
      },
      sizeBox(el) {
        const v = Number(el.value); this.sizeTyping = null;
        if (!(v >= 4 && v <= 200)) { el.value = this.fmtNow.size || this.settings.fontSize; return; }
        this.setStyle('size', Math.round(v * 2) / 2);
        el.blur();
      },

      // ---- pictures over the sheet, tied to a cell ----
      openImagePicker() {
        this.menu = '';
        if (this.book.readOnly) { return; }
        this.openPicker('image').then((it) => { if (it) { this.insertImageFile(it); } });
      },
      async insertImageFile(it) {
        try {
          const uid = (window.OC && OC.getCurrentUser && OC.getCurrentUser() && OC.getCurrentUser().uid) || '';
          const url = (window.OC && OC.linkToRemote ? OC.linkToRemote('dav') : '/remote.php/dav') + '/files/' + encodeURIComponent(uid) + String(it.path).split('/').map(encodeURIComponent).join('/');
          const res = await fetch(url, { credentials: 'same-origin', headers: { requesttoken: requestToken() } });
          if (!res.ok) { throw new Error('HTTP ' + res.status); }
          const src = await this.shrinkImage(await res.blob());
          await this.addImageFromSrc(src, it.name);
          this.notify(this.t('The picture is tied to {cell}. Drag it to move it, and its corner to size it.', { cell: refName(this.sel.cur.r, this.sel.cur.c) }), 5000);
        } catch (e) { this.notify(this.t('Could not read the picture: {msg}', { msg: e.message })); }
      },
      /** A large photograph is scaled down on the way in (as EditBase): 1600 px on its long side, JPEG unless it was a PNG. */
      shrinkImage(blob) {
        return new Promise((resolve, reject) => {
          if (!/^image\/(png|jpeg|gif|webp)$/.test(blob.type || '')) { reject(new Error(this.t('That is not a picture CalcBase can hold (PNG, JPEG, GIF or WebP).'))); return; }
          const img = new Image(); const u = URL.createObjectURL(blob);
          img.onload = () => {
            URL.revokeObjectURL(u);
            const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
            if (k >= 1 && blob.size < 600 * 1024) { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject(new Error('read')); fr.readAsDataURL(blob); return; }
            const cv = document.createElement('canvas'); cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            resolve(/png|gif/.test(blob.type) ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.85));
          };
          img.onerror = () => { URL.revokeObjectURL(u); reject(new Error(this.t('That is not a picture CalcBase can hold (PNG, JPEG, GIF or WebP).'))); };
          img.src = u;
        });
      },
      addImageFromSrc(src, name) {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const k = Math.min(1, 480 / Math.max(1, img.naturalWidth), 360 / Math.max(1, img.naturalHeight));
            this.addImage(src, Math.max(16, Math.round(img.naturalWidth * k)), Math.max(16, Math.round(img.naturalHeight * k)), img.naturalWidth, img.naturalHeight, name);
            resolve();
          };
          img.onerror = () => { this.addImage(src, 160, 120, 160, 120, name); resolve(); };
          img.src = src;
        });
      },
      addImage(src, w, h, nw, nh, name) {
        const sh = this.sheet(); if (!sh || this.book.readOnly || !safeImage(src)) { return; }
        const cur = this.sel.cur;
        imageSerial += 1;
        const img = { id: 'img' + Date.now().toString(36) + imageSerial, r: cur.r, c: cur.c, dx: 2, dy: 2, w, h, nw: nw || w, nh: nh || h, src, alt: String(name || '').replace(/\.[a-z0-9]+$/i, '').slice(0, 200) };
        this.imagesStep(sh, (list) => list.concat([img]));
        this.imgSel = img.id;
        this.paint();
      },
      /** A change to a sheet's pictures, as one undoable step. */
      imagesStep(sh, fn) {
        const was = (sh.images || []).map((x) => Object.assign({}, x));
        const now = fn(was.map((x) => Object.assign({}, x)));
        const apply = (list) => { sh.images = list.map((x) => Object.assign({}, x)); this.touch(); this.paint(); this.scheduleThumbs(); };
        apply(now);
        this.pushStep({ undo: () => apply(was), redo: () => apply(now) });
      },
      imageById(id) { const sh = this.sheet(); return (sh && (sh.images || []).find((x) => x.id === id)) || null; },
      imageCmd(kind) {
        const sh = this.sheet(); const img = this.imageById(this.imgSel); if (!sh || !img || this.book.readOnly) { return; }
        if (kind === 'delete') { this.imagesStep(sh, (list) => list.filter((x) => x.id !== img.id)); this.imgSel = null; return; }
        if (kind === 'fit') {
          const m = mergeAt(sh, img.r, img.c);
          const w = m ? colLeft(sh, m.c1 + 1) - colLeft(sh, m.c0) : colW(sh, img.c); const h = m ? rowTop(sh, m.r1 + 1) - rowTop(sh, m.r0) : rowH(sh, img.r);
          this.imagesStep(sh, (list) => list.map((x) => (x.id === img.id ? Object.assign(x, { dx: 0, dy: 0, w: Math.max(8, w), h: Math.max(8, h) }) : x)));
          return;
        }
        if (kind === 'original') { this.imagesStep(sh, (list) => list.map((x) => (x.id === img.id ? Object.assign(x, { w: x.nw || x.w, h: x.nh || x.h }) : x))); }
      },
      // ---- a picture's crop, its alternative text, and its weight (EditBase's) ----
      openCrop() {
        const img = this.imageById(this.imgSel);
        if (!img || this.book.readOnly) { this.notify(this.t('Choose a picture first.')); return; }
        this.cropId = img.id;
        this.cropSrc = safeImage(img.src);
        this.crop = Object.assign({ ratio: '', x: 50, y: 50 }, cropOfImage(img) || {});
        this.cropOpen = true;
      },
      /** Drag inside the preview to say which part of the picture shows. */
      cropGrab(e) {
        const r = e.currentTarget.getBoundingClientRect();
        const start = { x: e.clientX, y: e.clientY, cx: this.crop.x, cy: this.crop.y };
        const move = (ev) => {
          this.crop.x = Math.max(0, Math.min(100, start.cx - (ev.clientX - start.x) / Math.max(1, r.width) * 100));
          this.crop.y = Math.max(0, Math.min(100, start.cy - (ev.clientY - start.y) / Math.max(1, r.height) * 100));
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      },
      /** The frame takes the shape (its width kept, its height worked out), and shows the part chosen; the whole picture is the frame of its own shape again. */
      async applyCrop() {
        const v = { ratio: CROP_RATIOS.indexOf(this.crop.ratio) > 0 ? this.crop.ratio : '', x: clampPct(this.crop.x), y: clampPct(this.crop.y) };
        this.cropOpen = false;
        const sh = this.sheet(); const img = (sh && (sh.images || []).find((x) => x.id === this.cropId)) || null;
        if (!sh || !img || this.book.readOnly) { return; }
        if (!v.ratio && !cropOfImage(img)) { return; }
        // the picture's own shape, for the frame of the whole picture (a book read back does not keep it)
        let nat = img.nw && img.nh ? img.nh / img.nw : 0;
        if (!v.ratio && !nat) { try { const p = await loadImage(safeImage(img.src)); nat = p.naturalWidth ? p.naturalHeight / p.naturalWidth : 0; } catch (e) { nat = 0; } }
        this.imagesStep(sh, (list) => list.map((x) => {
          if (x.id !== img.id) { return x; }
          if (v.ratio) { return Object.assign(x, { crop: v, h: Math.max(8, Math.round(x.w / ratioValue(v.ratio))) }); }
          const out = Object.assign(x, { h: nat ? Math.max(8, Math.round(x.w * nat)) : x.h });
          delete out.crop;
          return out;
        }));
        this.imgSel = img.id; this.paint();
      },
      openAlt() {
        const img = this.imageById(this.imgSel);
        if (!img || this.book.readOnly) { this.notify(this.t('Choose a picture first.')); return; }
        this.altId = img.id;
        this.altText = img.alt || '';
        this.altOpen = true;
        this.$nextTick(() => { const el = this.$refs.altInput; if (el) { el.focus(); el.select(); } });
      },
      applyAlt() {
        const text = String(this.altText || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300);
        this.altOpen = false;
        const sh = this.sheet(); const img = (sh && (sh.images || []).find((x) => x.id === this.altId)) || null;
        if (!sh || !img || this.book.readOnly || (img.alt || '') === text) { return; }
        this.imagesStep(sh, (list) => list.map((x) => (x.id === img.id ? Object.assign(x, { alt: text }) : x)));
      },
      /** Every picture in the book made as light as it can be without being seen to change (one step to undo). */
      async lightenPictures(quiet) {
        if (this.book.readOnly || !this.book.id || this.lightening) { return; }
        this.lightening = true;
        try {
          let saved = 0; const changes = [];
          for (const sh of UIS) {
            const now = [];
            for (const im of (sh.images || [])) {
              const src = safeImage(im.src);
              if (!/^data:image\//.test(src) || src.length < 120000) { continue; }
              try { const url = await lightenImage(src); if (url && url.length < src.length && safeImage(url)) { saved += src.length - url.length; now.push([im.id, url]); } } catch (e) { /* the picture stays as it came */ }
            }
            if (now.length) { changes.push([sh, now]); }
          }
          if (!saved) { if (!quiet) { this.notify(this.t('The pictures are already as light as they go.')); } return; }
          const before = changes.map(([sh]) => [sh, (sh.images || []).map((x) => Object.assign({}, x))]);
          const after = changes.map(([sh, now]) => [sh, (sh.images || []).map((x) => { const hit = now.find((n) => n[0] === x.id); return hit ? Object.assign({}, x, { src: hit[1] }) : Object.assign({}, x); })]);
          const apply = (sets) => { sets.forEach(([sh, list]) => { sh.images = list.map((x) => Object.assign({}, x)); }); this.touch(); this.paint(); this.scheduleThumbs(); };
          apply(after);
          this.pushStep({ undo: () => apply(before), redo: () => apply(after) });
          // Three quarters of the characters is about the weight of the file.
          const kb = Math.round((saved * 3) / 4 / 1024);
          if (!quiet || kb >= 100) { this.notify(this.t('The pictures are {kb}KB lighter.', { kb: String(kb) })); }
        } finally { this.lightening = false; }
      },
      /** Dragging a picture moves it (the cell it is tied to follows); its corner sizes it. */
      startImageDrag(e, id, resize) {
        const sh = this.sheet(); const img = (sh.images || []).find((x) => x.id === id); if (!img) { return; }
        this.imgSel = id; this.paint();
        if (this.book.readOnly) { return; }
        const z = this.z(); const x0 = e.clientX; const y0 = e.clientY;
        const was = Object.assign({}, img);
        const move = (ev) => {
          const dx = (ev.clientX - x0) / z; const dy = (ev.clientY - y0) / z;
          if (resize) { img.w = Math.max(12, Math.round(was.w + dx)); img.h = Math.max(12, Math.round(ev.shiftKey ? was.h * img.w / was.w : was.h + dy)); }
          else {
            const left = Math.max(0, colLeft(sh, was.c) + was.dx + dx); const top = Math.max(0, rowTop(sh, was.r) + was.dy + dy);
            const c = colAtX(sh, left); const r = rowAtY(sh, top);
            img.c = c; img.r = r; img.dx = Math.round(left - colLeft(sh, c)); img.dy = Math.round(top - rowTop(sh, r));
          }
          this.paint();
        };
        const up = () => {
          document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
          const now = Object.assign({}, img);
          if (['r', 'c', 'dx', 'dy', 'w', 'h'].every((k) => now[k] === was[k])) { return; }
          Object.assign(img, was);
          this.imagesStep(sh, (list) => list.map((x) => (x.id === id ? Object.assign(x, now) : x)));
        };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      },

      // ---- links and comments on cells ----
      async openLink() {
        this.menu = '';
        if (this.book.readOnly || !this.book.id) { return; }
        const was = this.curLink || '';
        const url = await this.askFor({ title: was ? this.t('Edit the link…') : this.t('Hyperlink…'), label: this.t('Address'), value: was,
          tip: this.t('A bare address becomes https://, and an e-mail address a mailto: link. Ctrl+click the cell to open it.'), removable: !!was, removeLabel: this.t('Remove the link') });
        if (url == null) { return; }
        this.setLink(url);
      },
      setLink(url) {
        let u = String(url || '').trim();
        if (u && !/^(https?:|mailto:|tel:)/i.test(u)) { u = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u) ? 'mailto:' + u : 'https://' + u; }
        if (u && !safeLink(u)) { this.notify(this.t('That address cannot be linked to.')); return; }
        const sh = this.sheet(); const cur = this.sel.cur;
        this.withStep((rec) => {
          rec(sh, cur.r, cur.c);
          this.setMeta(sh, cur.r, cur.c, { link: u });
          // an empty cell shows the address itself, as Calc does
          if (u && !wb.get(sh.name, cur.r, cur.c).t) { this.setInputRaw(sh, cur.r, cur.c, "'" + u.replace(/^mailto:/i, '')); }
        });
      },
      openCurLink() { const u = safeLink(this.curLink); if (u) { window.open(u, '_blank', 'noopener'); } },
      async openNote() {
        this.menu = '';
        if (this.book.readOnly || !this.book.id) { return; }
        const was = this.curNote || '';
        const text = await this.askFor({ title: was ? this.t('Edit the comment…') : this.t('Comment…'), label: this.t('Comment on {cell}', { cell: refName(this.sel.cur.r, this.sel.cur.c) }), value: was, multiline: true,
          tip: this.t('Shown when the pointer rests on the cell, which a red corner marks. The file keeps it on the cell, so a browser shows it the same way.'), removable: !!was, removeLabel: this.t('Delete the comment') });
        if (text == null) { return; }
        this.setNote(text);
      },
      setNote(text) {
        const sh = this.sheet(); const cur = this.sel.cur;
        this.withStep((rec) => { rec(sh, cur.r, cur.c); this.setMeta(sh, cur.r, cur.c, { note: String(text || '').trim().slice(0, 5000) }); });
      },
      /** The pointer over the sheet: a comment shows itself, a link gets the pointing hand. */
      gridHover(e) {
        if (!this.book.id || this.dragSel || e.buttons) { return; }
        const hit = this.hitTest(e.clientX, e.clientY);
        const sh = this.sheet();
        let note = ''; let link = '';
        if (hit.kind === 'cell' && sh) { const m = sh.meta.get(K(hit.r, hit.c)); note = (m && m.note) || ''; link = (m && m.link) || ''; }
        const key = hit.kind === 'cell' ? K(hit.r, hit.c) : -1;
        if (key === this._hoverKey) { return; }
        this._hoverKey = key;
        const wrap = this.$refs.gridwrap;
        if (note && wrap) {
          const rc = this.cellRect(hit.r, hit.c); const view = this.$refs.view.getBoundingClientRect(); const box = wrap.getBoundingClientRect();
          const x = view.left - box.left + (rc ? rc.left + rc.w + 6 : 0); const y = view.top - box.top + (rc ? rc.top : 0);
          this.notePop = { text: note, x: Math.max(4, Math.min(x, box.width - 270)), y: Math.max(4, Math.min(y, box.height - 90)) };
        } else if (this.notePop.text) { this.notePop = { text: '', x: 0, y: 0 }; }
        if (wrap) { wrap.classList.toggle('on-link', !!link); }
      },
      gridLeave() { this._hoverKey = -2; if (this.notePop.text) { this.notePop = { text: '', x: 0, y: 0 }; } },

      // ---- names for cells and ranges ----
      openNames() {
        this.menu = '';
        const sn = this.sheetName();
        const g = this.selRange();
        const abs = (r, c) => '$' + colName(c) + '$' + (r + 1);
        const range = abs(g.r0, g.c0) + (g.r1 > g.r0 || g.c1 > g.c0 ? ':' + abs(Math.min(g.r1, MAX_ROWS - 1), Math.min(g.c1, MAX_COLS - 1)) : '');
        this.nameForm = { name: '', range: '$' + (/[^\w]/.test(sn) ? "'" + sn.replace(/'/g, "''") + "'" : sn) + '.' + range };
        this.namesOpen = true;
        this.$nextTick(() => { if (this.$refs.nameInput) { this.$refs.nameInput.focus(); } });
      },
      /** A name and the range it stands for, as Calc writes it ($Sheet1.$A$1:$B$5), or null. */
      resolveName(text) {
        const ref = this.names[text] || this.names[Object.keys(this.names).find((k) => k.toLowerCase() === String(text).toLowerCase()) || ''];
        if (!ref) { return null; }
        const sm = /^\$?(?:'((?:[^']|'')+)'|([^.!]+))[.!](.+)$/.exec(String(ref).trim());
        const sheet = sm ? (sm[1] != null ? sm[1].replace(/''/g, "'") : sm[2]) : this.sheetName();
        const g = parseRange((sm ? sm[3] : ref).replace(/\$/g, ''));
        return g ? { sheet, g } : null;
      },
      addName() {
        if (this.book.readOnly) { return; }
        const name = String(this.nameForm.name || '').trim(); const range = String(this.nameForm.range || '').trim();
        if (!/^[A-Za-z_\u3040-\u30ff\u4e00-\u9fff][\w.\u3040-\u30ff\u4e00-\u9fff]{0,99}$/.test(name) || parseRef(name) || /^[A-Za-z]{1,3}\d+$/.test(name)) { this.notify(this.t('A name begins with a letter, holds letters, digits and _, and is not a cell address.'), 5000); return; }
        const was = this.names;
        const next = Object.assign({}, this.names); next[name] = range;
        this.names = next;
        if (!this.resolveName(name)) { this.names = was; this.notify(this.t('“{name}” is not a cell or a range.', { name: range })); return; }
        this.nameForm.name = '';
        this.namesToEngine();
        this.pushStep({ undo: () => { this.names = was; this.namesToEngine(); this.touch(); }, redo: () => { this.names = next; this.namesToEngine(); this.touch(); } });
        this.touch();
      },
      removeName(k) {
        const was = this.names; const next = Object.assign({}, this.names); delete next[k]; this.names = next;
        this.namesToEngine();
        this.pushStep({ undo: () => { this.names = was; this.namesToEngine(); this.touch(); }, redo: () => { this.names = next; this.namesToEngine(); this.touch(); } });
        this.touch();
      },
      /** The book's names into the engine, and the formulas that use them worked out again. */
      namesToEngine() {
        if (!wb || typeof wb.setNames !== 'function') { return; }
        try { wb.setNames(this.names); } catch (e) { /* a name the engine refuses stays out of the formulas */ }
        this._pbCache = null; this.tick += 1;
      },

      // ---- special characters and emoji, into the cell being edited ----
      insertIntoCell(text) {
        if (this.book.readOnly) { return; }
        if (!this.edit.on) { this.startEdit('full'); }
        const t = this.edit.text; const c = this.edit.caret;
        this.setEditText(t.slice(0, c) + text + t.slice(c), c + text.length);
      },
      /** Closing the picker leaves the cell being edited with its caret, ready for more typing. */
      finishPicked() { if (this.edit.on) { this.$nextTick(() => { const ed = this.$refs.editor; if (ed) { ed.focus(); ed.setSelectionRange(this.edit.caret, this.edit.caret); } }); } },
      openChars() { this.menu = ''; if (this.book.readOnly) { return; } this.charsOpen = true; },
      pickChar(ch) { this.insertIntoCell(ch); },
      charsOf(key) { const set = CHAR_SETS.find((c) => c.key === key); return set ? Array.from(set.chars) : []; },
      openEmoji() { this.menu = ''; if (this.book.readOnly) { return; } this.emojiQuery = ''; this.emojiOpen = true; this.loadEmoji(); },
      /** EditBase's emoji data, fetched once: the groups, and the names and keywords in the screen's language. */
      async loadEmoji() {
        if (EMOJI) { if (!this.emojiTab && EMOJI.groups.length) { this.emojiTab = EMOJI.groups[0].key; } return; }
        if (this.emojiLoading) { return; }
        this.emojiLoading = true;
        try {
          const dir = (window.OC && OC.linkTo) ? OC.linkTo('calcbase', 'js/') : '/apps/calcbase/js/';
          const get = async (file) => { const r = await fetch(dir + file, { credentials: 'same-origin' }); if (!r.ok) { throw new Error('HTTP ' + r.status); } return JSON.parse(await r.text()); };
          const list = await get('emoji-list.js');
          let names = {};
          try { names = await get('emoji-' + (uiLang() === 'ja' ? 'ja' : 'en') + '.js'); } catch (e) { names = {}; }
          EMOJI = { groups: (list && list.groups) || [], names: names || {} };
          this.emojiTick += 1;
          if (!this.emojiTab && EMOJI.groups.length) { this.emojiTab = EMOJI.groups[0].key; }
        } catch (e) { this.notify(this.t('The emoji could not be fetched.')); }
        this.emojiLoading = false;
      },
      pickEmoji(em) { this.insertIntoCell(em); },
      /** The CLDR short name, for the tooltip: the value is "name|keyword keyword". */
      emojiName(em) { const n = EMOJI && EMOJI.names[em]; return n ? String(n).split('|')[0] : em; },

      // ---- bringing in: the other apps, a file, a web page ----
      async loadSources() {
        try { const r = await api('sources'); const s = (r && r.sources) || {}; this.sources = typeof s === 'object' && !Array.isArray(s) ? s : {}; }
        catch (e) { this.sources = {}; }
      },
      sourceLabel(key) {
        return { regibase: 'RegiBase', formulabase: 'FormulaBase', editbase: 'EditBase', netbase: 'NetBase', tables: this.t('Nextcloud Tables'), contacts: this.t('Contacts'),
          calendar: this.t('Calendar'), web: this.t('Web page'), file: this.t('File') }[key] || key;
      },
      sourceMark(key) { return { regibase: '🗄', formulabase: '∑', editbase: '📝', netbase: '🖧', tables: '▦', contacts: '👤', calendar: '📅', web: '🌐', file: '📄' }[key] || '•'; },
      itemMeta(x) {
        if (x.count != null) { return this.t('{n} records', { n: x.count }); }
        if (x.folder) { return x.folder; }
        if (x.mtime) { return this.when(x.mtime); }
        return x.description ? String(x.description).slice(0, 60) : '';
      },
      isFragment(r) { return !!(r && typeof r === 'object' && Array.isArray(r.sheets) && r.sheets.length); },
      async openSource(key) {
        this.menu = ''; this.source = key; this.sourceOpen = true;
        const today = new Date(); const first = new Date(today.getFullYear(), today.getMonth(), 1); const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        this.src = { loading: true, error: '', items: [], listed: false, fragment: null, shown: 0, calendars: [], from: iso(first), to: iso(last), calendar: '', query: '' };
        try {
          if (key === 'calendar') { const r = await api('import/calendars'); this.src.calendars = (r && r.calendars) || []; }
          else if (key === 'contacts') { await this.loadContacts(); return; }
          else if (key === 'netbase') { const r = await api('import/netbase'); if (!this.isFragment(r)) { throw new Error(this.t('Nothing came back that could be put on a sheet.')); } this.src.fragment = r; }
          else {
            const r = await api('import/' + key);
            this.src.items = (r && (r.collections || r.documents || r.tables)) || [];
            this.src.listed = true;
          }
        } catch (e) { this.src.error = e.message; } finally { this.src.loading = false; }
      },
      async loadContacts() {
        this.src.loading = true; this.src.error = '';
        try {
          const r = await api('import/contacts' + (this.src.query ? '?q=' + encodeURIComponent(this.src.query) : ''));
          if (!this.isFragment(r)) { throw new Error(this.t('No contact matches that.')); }
          this.src.fragment = r; this.src.shown = 0;
        } catch (e) { this.src.error = e.message; } finally { this.src.loading = false; }
      },
      async openSourceItem(x) {
        this.src.loading = true; this.src.error = '';
        try {
          const r = await api('import/' + this.source + '/' + encodeURIComponent(x.id));
          if (!this.isFragment(r)) { throw new Error(this.t('Nothing came back that could be put on a sheet.')); }
          this.src.fragment = r; this.src.shown = 0;
        } catch (e) { this.src.error = e.message; } finally { this.src.loading = false; }
      },
      async loadCalendarFragment() {
        this.src.loading = true; this.src.error = '';
        try {
          const q = 'from=' + encodeURIComponent(this.src.from) + '&to=' + encodeURIComponent(this.src.to) + (this.src.calendar ? '&cal=' + encodeURIComponent(this.src.calendar) : '');
          const r = await api('import/calendar?' + q);
          if (!this.isFragment(r)) { throw new Error(this.t('No events in that range.')); }
          this.src.fragment = r; this.src.shown = 0;
        } catch (e) { this.src.error = e.message; } finally { this.src.loading = false; }
      },
      fragmentSummary(f) {
        const sheets = (f && f.sheets) || [];
        const cells = sheets.reduce((n, s) => n + Object.keys(s.cells || {}).length, 0);
        const from = f && f.source && f.source.name ? ' — ' + f.source.name : '';
        return (sheets.length === 1 ? this.t('One sheet, {c} cells', { c: cells }) : this.t('{n} sheets, {c} cells', { n: sheets.length, c: cells })) + from;
      },
      /** The first rows of one sheet of what will come in, as words. */
      fragmentPreview(f, which) {
        const s = f && f.sheets && f.sheets[which || 0]; if (!s) { return []; }
        let r1 = 0; let c1 = 0;
        Object.keys(s.cells || {}).forEach((k) => { const p = parseRef(k); if (p) { r1 = Math.max(r1, p.r); c1 = Math.max(c1, p.c); } });
        const out = [];
        for (let r = 0; r <= Math.min(r1, 7); r += 1) {
          const row = [];
          for (let c = 0; c <= Math.min(c1, 7); c += 1) {
            const cell = s.cells[refName(r, c)];
            row.push(!cell ? '' : cell.t === 'n' || cell.t === 'b' ? Calc.format(cell.v, cell.t, cell.fmt || '', 'ja') : String(cell.v == null ? '' : cell.v));
          }
          out.push(row);
        }
        return out;
      },
      /**
       * What came in, put into the book: as new sheets after the last one, or into
       * the active sheet at the cursor (formulas moved along). One step that Ctrl+Z
       * takes out again.
       */
      insertFragment(frag, how) {
        if (!this.isFragment(frag) || this.book.readOnly) { return; }
        this.sourceOpen = false;
        const sheets = frag.sheets;
        if (this.edit.on) { this.commitEdit(); }
        if (how === 'here') {
          const sh = this.sheet(); const s = sheets[this.src && this.src.fragment === frag ? (this.src.shown || 0) : 0] || sheets[0]; const cur = this.sel.cur;
          let r1 = cur.r; let c1 = cur.c;
          this.withStep((rec) => {
            Object.keys(s.cells || {}).forEach((k) => {
              const p = parseRef(k); if (!p) { return; }
              const r = cur.r + p.r; const c = cur.c + p.c; if (r >= MAX_ROWS || c >= MAX_COLS) { return; }
              const cell = s.cells[k];
              rec(sh, r, c);
              const input = cell.f ? Calc.shiftFormula(cell.f, cur.r, cur.c) : this.inputOf({ t: cell.t, v: cell.v }, cell.fmt || '');
              this.setInputRaw(sh, r, c, input);
              const patch = { fmt: cell.fmt || '', s: isEmptyObj(cell.s) ? null : Object.assign({}, cell.s) };
              const link = safeLink(cell.link); if (link) { patch.link = link; }
              this.setMeta(sh, r, c, patch);
              r1 = Math.max(r1, r); c1 = Math.max(c1, c);
            });
            this.sel.ranges = [{ r0: cur.r, c0: cur.c, r1, c1 }];
          });
          this.notify(this.t('Put in at {cell}. Ctrl+Z takes it out again.', { cell: refName(cur.r, cur.c) }));
          this.$nextTick(() => this.focusGrid());
          return;
        }
        const names = [];
        this.structural(() => {
          let first = -1;
          sheets.forEach((s) => {
            let name = String(s.name || '').replace(/[[\]*?:/\\']/g, ' ').trim().slice(0, 60) || this.freshSheetName();
            const base = name; let n = 2;
            while (UIS.some((u) => u.name.toLowerCase() === name.toLowerCase())) { name = base + ' (' + n + ')'; n += 1; }
            wb.addSheet(name, UIS.length);
            Object.keys(s.cells || {}).forEach((k) => {
              const p = parseRef(k); const cell = s.cells[k]; if (!p || !cell) { return; }
              const spec = { t: cell.t, v: cell.v }; if (cell.f) { spec.f = cell.f; }
              wb.setCell(name, p.r, p.c, spec);
            });
            const u = uisFromModel({ sheets: [Object.assign({}, s, { name })] })[0];
            u.grid = this.settings.showGrid !== false;
            UIS.push(u); names.push(name);
            if (first < 0) { first = UIS.length - 1; }
          });
          if (wb.recalc) { wb.recalc(); }
          this.refreshUsed();
          this.active = first;
          this.sel = { ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], cur: { r: 0, c: 0 }, anchor: { r: 0, c: 0 } };
        });
        this.$nextTick(() => { const vp = this.$refs.scroller; if (vp) { vp.scrollTop = 0; vp.scrollLeft = 0; } this.layout(); this.scheduleThumbs(); this.focusGrid(); });
        this.notify(names.length === 1 ? this.t('Added the sheet {name}. Ctrl+Z takes it out again.', { name: names[0] }) : this.t('Added {n} sheets. Ctrl+Z takes them out again.', { n: names.length }), 5000);
      },
      async fetchWebTables() {
        const url = String(this.webUrl || '').trim(); if (!url || this.webBusy) { return; }
        this.webBusy = true;
        try {
          const r = await api('import/web?url=' + encodeURIComponent(/^https?:\/\//i.test(url) ? url : 'https://' + url));
          if (!this.isFragment(r)) { throw new Error(this.t('No table was found on that page.')); }
          this.webOpen = false;
          this.source = 'web'; this.sourceOpen = true;
          this.src = { loading: false, error: '', items: [], listed: false, fragment: r, shown: 0, calendars: [], from: '', to: '', calendar: '', query: '' };
          if (r.truncated) { this.notify(this.t('The page was larger than the server reads, so only its beginning came in.'), 6000); }
        } catch (e) { this.notify(this.t('Could not read that page: {msg}', { msg: e.message }), 6000); }
        this.webBusy = false;
      },
      /** A file in Files brought into this book as new sheets: CSV, ODS, XLSX, or the tables of a Markdown file. */
      async bringFile() {
        this.menu = '';
        if (this.book.readOnly) { return; }
        const it = await this.openPicker('bring');
        if (!it) { return; }
        try {
          const md = /\.(md|markdown|mdown|mkd)$/i.test(it.name || it.path || '');
          const r = await api(md ? 'import/markdown' : 'import', { method: 'POST', body: { fileId: it.id, path: it.path } });
          const frag = this.isFragment(r) ? r : (r && r.model && this.isFragment(r.model) ? r.model : null);
          if (!frag) { throw new Error(this.t('Nothing came back that could be put on a sheet.')); }
          this.source = 'file'; this.sourceOpen = true;
          this.src = { loading: false, error: '', items: [], listed: false, fragment: frag, shown: 0, calendars: [], from: '', to: '', calendar: '', query: '' };
        } catch (e) { this.notify(this.t('Could not import: {msg}', { msg: e.message }), 6000); }
      },

      // ---- the data tools ----
      openSort() {
        this.menu = '';
        if (this.book.readOnly) { return; }
        const g = this.currentRegion();
        this.sortUi = { range: rangeName(g), g, header: this.hasHeader(g), cols: [], keys: [{ col: clamp(this.sel.cur.c, g.c0, g.c1), dir: 1 }, { col: '', dir: 1 }, { col: '', dir: 1 }] };
        this.sortCols();
        this.sortOpen = true;
      },
      sortCols() {
        const sh = this.sheet(); const u = this.sortUi; const g = u.g; const cols = [];
        for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 200); c += 1) { const hg = wb.get(sh.name, g.r0, c); cols.push({ c, label: this.t('Column {n}', { n: colName(c) }) + (u.header && hg.t ? ' — ' + Calc.format(hg.v, hg.t, '', 'ja') : '') }); }
        u.cols = cols;
      },
      applySort() {
        const u = this.sortUi; const keys = u.keys.filter((k) => k.col !== '' && k.col != null).map((k) => ({ col: Number(k.col), dir: Number(k.dir) || 1 }));
        this.sortOpen = false;
        if (!keys.length) { return; }
        this.sortRows(u.g, keys, u.header ? u.g.r0 + 1 : u.g.r0);
      },
      /** The rows of a block in the order the keys say (numbers before text, empty last, as Calc). */
      sortRows(g, keys, start) {
        if (this.book.readOnly) { return; }
        const sh = this.sheet();
        if (g.r1 <= start) { return; }
        const rows = []; for (let r = start; r <= g.r1; r += 1) { rows.push(r); }
        const rank = (v) => (!v.t ? 3 : v.t === 'n' || v.t === 'b' ? 0 : v.t === 's' ? 1 : 2);
        const cmp = (a, b) => {
          for (let i = 0; i < keys.length; i += 1) {
            const x = wb.get(sh.name, a, keys[i].col); const y = wb.get(sh.name, b, keys[i].col); const dir = keys[i].dir;
            if (rank(x) !== rank(y)) { return rank(x) - rank(y); }
            let d = 0;
            if (x.t === 'n' || x.t === 'b') { d = (Number(x.v) - Number(y.v)) * dir; }
            else if (x.t) { d = String(x.v).localeCompare(String(y.v), 'ja', { numeric: true, sensitivity: 'base' }) * dir; }
            if (d) { return d; }
          }
          return a - b;
        };
        const order = rows.slice().sort(cmp);
        if (order.every((r, i) => r === rows[i])) { return; }
        this.withStep((rec) => {
          const states = new Map();
          order.forEach((src) => { const row = []; for (let c = g.c0; c <= g.c1; c += 1) { row.push(this.cellState(sh, src, c)); } states.set(src, row); });
          rows.forEach((r) => { for (let c = g.c0; c <= g.c1; c += 1) { rec(sh, r, c); } });
          rows.forEach((dstR, i) => {
            const srcR = order[i]; const row = states.get(srcR);
            row.forEach((st, j) => { const c = g.c0 + j; const input = st.input[0] === '=' ? Calc.shiftFormula(st.input, dstR - srcR, 0) : st.input; this.setInputRaw(sh, dstR, c, input); this.setMeta(sh, dstR, c, { fmt: st.fmt, s: st.s, note: st.note, link: st.link, style: st.style }); });
          });
          this.sel.ranges = [g];
        });
      },
      /** Rows of the block that repeat an earlier row are taken out; the rows below close up (as Calc's "Remove duplicates"). */
      removeDuplicates() {
        this.menu = '';
        if (this.book.readOnly) { return; }
        const sh = this.sheet(); const g = this.currentRegion();
        const start = this.hasHeader(g) ? g.r0 + 1 : g.r0;
        const seen = new Set(); const keep = []; let dropped = 0;
        for (let r = start; r <= g.r1; r += 1) {
          const sig = []; for (let c = g.c0; c <= g.c1; c += 1) { const v = wb.get(sh.name, r, c); sig.push(v.t ? v.t + ':' + String(v.v) : ''); }
          const key = sig.join('\u0001');
          if (seen.has(key)) { dropped += 1; } else { seen.add(key); keep.push(r); }
        }
        if (!dropped) { this.notify(this.t('No row of {range} repeats another.', { range: rangeName(g) })); return; }
        this.withStep((rec) => {
          const states = keep.map((r) => { const row = []; for (let c = g.c0; c <= g.c1; c += 1) { row.push(this.cellState(sh, r, c)); } return row; });
          for (let r = start; r <= g.r1; r += 1) { for (let c = g.c0; c <= g.c1; c += 1) { rec(sh, r, c); } }
          for (let i = 0; i < g.r1 - start + 1; i += 1) {
            const dstR = start + i; const row = states[i];
            for (let j = 0; j <= g.c1 - g.c0; j += 1) {
              const c = g.c0 + j;
              if (row) { const st = row[j]; const srcR = keep[i]; this.setInputRaw(sh, dstR, c, st.input[0] === '=' ? Calc.shiftFormula(st.input, dstR - srcR, 0) : st.input); this.setMeta(sh, dstR, c, { fmt: st.fmt, s: st.s, note: st.note, link: st.link, style: st.style }); }
              else { wb.setInput(sh.name, dstR, c, ''); this.setMeta(sh, dstR, c, { fmt: '', s: null, note: '', link: '', style: '' }); }
            }
          }
          this.sel.ranges = [{ r0: g.r0, c0: g.c0, r1: start + keep.length - 1, c1: g.c1 }];
        });
        this.notify(this.t('{n} repeated rows were taken out. Ctrl+Z puts them back.', { n: dropped }));
      },
      openSplit() { this.menu = ''; if (this.book.readOnly) { return; } this.splitOpen = true; },
      applySplit() {
        this.splitOpen = false;
        if (this.book.readOnly) { return; }
        const sep = this.splitUi.sep === 'other' ? String(this.splitUi.other || '') : this.splitUi.sep === 'tab' ? '\t' : this.splitUi.sep;
        if (!sep) { return; }
        const sh = this.sheet(); const g = this.selRange(); const c0 = g.c0;
        let maxParts = 1; let split = 0;
        this.withStep((rec) => {
          for (let r = g.r0; r <= Math.min(g.r1, Math.max(sh.maxR, g.r0)); r += 1) {
            const gg = wb.get(sh.name, r, c0); if (!gg.t || gg.f) { continue; }
            const text = gg.t === 's' ? String(gg.v) : Calc.format(gg.v, gg.t, this.fmtAt(sh, r, c0, gg), 'ja');
            const parts = text.split(sep).map((p) => (this.splitUi.trim ? p.trim() : p));
            if (parts.length < 2) { continue; }
            split += 1;
            maxParts = Math.max(maxParts, parts.length);
            parts.forEach((p, i) => { const c = c0 + i; if (c >= MAX_COLS) { return; } rec(sh, r, c); this.setInputRaw(sh, r, c, p); });
          }
          this.sel.ranges = [{ r0: g.r0, c0, r1: g.r1, c1: Math.min(MAX_COLS - 1, c0 + maxParts - 1) }];
        });
        if (!split) { this.notify(this.t('The separator was not found in the selected cells.')); }
      },
      /** Empty cells at the selection, the others moved down or right through the engine's move, so references follow. */
      async insertCells() {
        this.menu = '';
        if (this.book.readOnly) { return; }
        const how = await this.askFor({ title: this.t('Insert Cells'), label: this.t('What moves to make room'), value: 'down',
          options: [{ value: 'down', label: this.t('Shift cells down') }, { value: 'right', label: this.t('Shift cells right') }, { value: 'rows', label: this.t('Insert entire rows') }, { value: 'cols', label: this.t('Insert entire columns') }] });
        if (how == null) { this.focusGrid(); return; }
        if (how === 'rows') { this.insertRows(0); return; } if (how === 'cols') { this.insertCols(0); return; }
        const sh = this.sheet(); const g = this.selRange(); this.refreshUsed();
        const r1 = Math.min(g.r1, MAX_ROWS - 1); const c1 = Math.min(g.c1, MAX_COLS - 1);
        const n = how === 'down' ? r1 - g.r0 + 1 : c1 - g.c0 + 1;
        if (n > 1000) { this.notify(this.t('Too many rows at once.')); return; }
        this.structural(() => {
          if (how === 'down' && sh.maxR >= g.r0) {
            if (sh.maxR + n >= MAX_ROWS) { return; }
            wb.moveRange(sh.name, rangeName({ r0: g.r0, c0: g.c0, r1: sh.maxR, c1 }), refName(g.r0 + n, g.c0));
            const moved = []; sh.meta.forEach((m, k) => { const r = KR(k); const c = KC(k); if (r >= g.r0 && c >= g.c0 && c <= c1) { moved.push([r, c, m]); } });
            moved.forEach(([r, c]) => sh.meta.delete(K(r, c))); moved.forEach(([r, c, m]) => sh.meta.set(K(r + n, c), m));
            sh.maxR += n;
          } else if (how === 'right' && sh.maxC >= g.c0) {
            if (sh.maxC + n >= MAX_COLS) { return; }
            wb.moveRange(sh.name, rangeName({ r0: g.r0, c0: g.c0, r1, c1: sh.maxC }), refName(g.r0, g.c0 + n));
            const moved = []; sh.meta.forEach((m, k) => { const r = KR(k); const c = KC(k); if (c >= g.c0 && r >= g.r0 && r <= r1) { moved.push([r, c, m]); } });
            moved.forEach(([r, c]) => sh.meta.delete(K(r, c))); moved.forEach(([r, c, m]) => sh.meta.set(K(r, c + n), m));
            sh.maxC += n;
          }
        });
        this.focusGrid();
      },
      /** Σ: a SUM over the numbers above the cell, or to its left when there are none above (as Calc's AutoSum). */
      autoSum() {
        if (this.book.readOnly || !this.book.id) { return; }
        if (this.edit.on) { this.commitEdit(); }
        const sh = this.sheet(); const cur = this.sel.cur; const g = this.selRange();
        const isNum = (r, c) => { const v = wb.get(sh.name, r, c); return v.t === 'n'; };
        if (g.r1 > g.r0 && g.r1 < MAX_ROWS - 1 && g.c1 - g.c0 < 200) {
          // a block: one sum under each column of it
          const r = Math.min(g.r1, Math.max(sh.maxR, g.r0)) + 1;
          this.withStep((rec) => { for (let c = g.c0; c <= Math.min(g.c1, Math.max(sh.maxC, g.c0)); c += 1) { rec(sh, r, c); this.setInputRaw(sh, r, c, '=SUM(' + refName(g.r0, c) + ':' + refName(r - 1, c) + ')'); } this.sel.ranges = [{ r0: r, c0: g.c0, r1: r, c1: g.c1 }]; this.sel.cur = { r, c: g.c0 }; });
          return;
        }
        let top = cur.r - 1; while (top >= 0 && isNum(top, cur.c)) { top -= 1; }
        let left = cur.c - 1; while (left >= 0 && isNum(cur.r, left)) { left -= 1; }
        let f = '=SUM()';
        if (top + 1 <= cur.r - 1) { f = '=SUM(' + refName(top + 1, cur.c) + ':' + refName(cur.r - 1, cur.c) + ')'; }
        else if (left + 1 <= cur.c - 1) { f = '=SUM(' + refName(cur.r, left + 1) + ':' + refName(cur.r, cur.c - 1) + ')'; }
        // Calc puts the formula in the cell and leaves it there to be checked
        this.startEdit('full', f);
        if (f === '=SUM()') { this.$nextTick(() => { const ed = this.$refs.editor; if (ed) { ed.setSelectionRange(5, 5); } this.edit.caret = 5; this.updateHints(); }); }
      },

      // ---- the rail's menus: beside the rail and inside the window (as EditBase's fitMenu) ----
      fitMenu() {
        const el = this.$el && this.$el.querySelector('.cb-rail .cb-menu');
        if (!el) { return; }
        const pop = el.closest('.cb-pop'); const rail = el.closest('.cb-rail');
        if (!pop || !rail) { return; }
        const btn = (pop.querySelector('button') || pop).getBoundingClientRect();
        const railBox = rail.getBoundingClientRect(); const margin = 8;
        el.style.maxHeight = Math.max(160, window.innerHeight - margin * 2) + 'px';
        const box = el.getBoundingClientRect();
        let left = railBox.right + 4;
        if (left + box.width > window.innerWidth - margin) { left = Math.max(margin, window.innerWidth - box.width - margin); }
        let top = btn.top;
        if (top + box.height > window.innerHeight - margin) { top = window.innerHeight - box.height - margin; }
        el.style.left = Math.round(Math.max(margin, left)) + 'px';
        el.style.top = Math.round(Math.max(margin, top)) + 'px';
      },

      // ---- the AI assistant reads the other apps, when the administrator allows it (EditBase's mechanism) ----
      aiReadLabel(q) {
        const s = String((q && q.source) || '');
        return { regibase: this.t('Reading RegiBase…'), formulabase: this.t('Reading FormulaBase…'), editbase: this.t('Reading EditBase…'), netbase: this.t('Reading NetBase…'),
          tables: this.t('Reading Tables…'), contacts: this.t('Reading the contacts…'), calendar: this.t('Reading the calendar…') }[s] || this.t('Reading…');
      },
      aiReadDone(q) {
        const s = String((q && q.source) || '');
        return { regibase: this.t('Read RegiBase.'), formulabase: this.t('Read FormulaBase.'), editbase: this.t('Read EditBase.'), netbase: this.t('Read NetBase.'),
          tables: this.t('Read Tables.'), contacts: this.t('Read the contacts.'), calendar: this.t('Read the calendar.') }[s] || this.t('Read.');
      },
      /** A fragment's first sheet as tab-separated rows, for the assistant. */
      fragmentText(frag, maxRows) {
        const lines = [];
        ((frag && frag.sheets) || []).forEach((s, si) => {
          if (si > 4) { return; }
          let r1 = -1; let c1 = -1;
          Object.keys(s.cells || {}).forEach((k) => { const p = parseRef(k); if (p) { r1 = Math.max(r1, p.r); c1 = Math.max(c1, p.c); } });
          lines.push('Sheet "' + s.name + '":');
          for (let r = 0; r <= Math.min(r1, maxRows || 200); r += 1) {
            const row = [];
            for (let c = 0; c <= Math.min(c1, 40); c += 1) { const cell = s.cells[refName(r, c)]; row.push(!cell ? '' : String(cell.f ? cell.f + ' → ' : '') + (cell.t === 'n' || cell.t === 'b' ? Calc.format(cell.v, cell.t, cell.fmt || '', 'ja') : String(cell.v == null ? '' : cell.v)).replace(/[\t\n]/g, ' ')); }
            lines.push(row.join('\t'));
          }
        });
        return lines.join('\n').slice(0, 20000);
      },
      /** Read what the assistant asked for, if the administrator allows it. Never writes. */
      async aiRead(q) {
        const s = String((q && q.source) || '');
        if (!this.ai.read.includes(s)) { return 'Not allowed: the administrator has not let the assistant read ' + (s || 'that') + '.'; }
        const lines = [];
        try {
          if ((s === 'regibase' || s === 'formulabase') && q.collection == null) {
            ((await api('import/' + s)).collections || []).forEach((x) => lines.push('- id ' + x.id + ': ' + x.name + (x.count != null ? ' (' + x.count + ' records)' : '')));
          } else if (s === 'regibase' || s === 'formulabase') {
            return this.fragmentText(await api('import/' + s + '/' + Number(q.collection)), 300);
          } else if (s === 'editbase' && q.document == null) {
            ((await api('import/editbase')).documents || []).slice(0, 300).forEach((x) => lines.push('- id ' + x.id + ': ' + x.name + (x.folder ? ' (category ' + x.folder + ')' : '')));
          } else if (s === 'editbase') {
            return this.fragmentText(await api('import/editbase/' + Number(q.document)), 200);
          } else if (s === 'tables' && q.table == null) {
            ((await api('import/tables')).tables || []).forEach((x) => lines.push('- id ' + x.id + ': ' + x.title));
          } else if (s === 'tables') {
            return this.fragmentText(await api('import/tables/' + Number(q.table)), 300);
          } else if (s === 'netbase') {
            return this.fragmentText(await api('import/netbase'), 300);
          } else if (s === 'contacts') {
            return this.fragmentText(await api('import/contacts' + (q.query ? '?q=' + encodeURIComponent(String(q.query)) : '')), 300);
          } else if (s === 'calendar' && !q.from) {
            ((await api('import/calendars')).calendars || []).forEach((x) => lines.push('- key ' + x.key + ': ' + x.name));
          } else if (s === 'calendar') {
            return this.fragmentText(await api('import/calendar?from=' + encodeURIComponent(String(q.from)) + '&to=' + encodeURIComponent(String(q.to || q.from)) + (q.calendar ? '&cal=' + encodeURIComponent(String(q.calendar)) : '')), 300);
          } else {
            return 'Unknown source.';
          }
        } catch (e) {
          return 'The reading failed: ' + String((e && e.message) || e);
        }
        return lines.length ? lines.join('\n') : '(nothing)';
      },
      /**
       * The pictures over the sheet. They are kept as elements of their own rather
       * than drawn with the cells: a picture is a long data: address, and writing it
       * into the page on every scroll would cost more than the whole grid.
       */
      paintImages(F) {
        const layer = this.$refs.piclayer; if (!layer) { return; }
        const f = F || this.frame();
        if (!this._picEls) { this._picEls = new Map(); }
        const seen = new Set();
        let handle = null;
        if (f) {
          const sh = f.sh; const z = f.z;
          const left = f.headW + f.fw; const top = f.headH + f.fh;
          layer.style.left = left + 'px'; layer.style.top = top + 'px';
          layer.style.width = Math.max(0, f.W - left) + 'px'; layer.style.height = Math.max(0, f.H - top) + 'px';
          (sh.images || []).forEach((im) => {
            const src = safeImage(im.src); if (!src) { return; }
            const x = (colLeft(sh, im.c) + (im.dx || 0)) * z - f.sx - f.fw; const y = (rowTop(sh, im.r) + (im.dy || 0)) * z - f.sy - f.fh;
            const w = im.w * z; const h = im.h * z;
            const key = sh.name + '\u0001' + im.id;
            seen.add(key);
            let el = this._picEls.get(key);
            if (!el) { el = document.createElement('img'); el.className = 'cb-pic'; el.draggable = false; layer.appendChild(el); this._picEls.set(key, el); }
            if (el.getAttribute('src') !== src) { el.setAttribute('src', src); }
            el.dataset.img = im.id; el.alt = im.alt || '';
            el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.width = w + 'px'; el.style.height = h + 'px';
            // cropped (EditBase's crop): the frame shows the part of the picture chosen, the picture itself is whole
            const cr = cropOfImage(im);
            el.style.objectFit = cr ? 'cover' : ''; el.style.objectPosition = cr ? cr.x + '% ' + cr.y + '%' : '';
            const on = this.imgSel === im.id;
            el.classList.toggle('on', on);
            if (on && !this.book.readOnly) { handle = { id: im.id, x: x + w - 5, y: y + h - 5 }; }
          });
        }
        this._picEls.forEach((el, key) => { if (!seen.has(key)) { el.remove(); this._picEls.delete(key); } });
        let hd = layer.querySelector('.cb-pic-h');
        if (handle) {
          if (!hd) { hd = document.createElement('div'); hd.className = 'cb-pic-h'; layer.appendChild(hd); }
          hd.dataset.img = handle.id; hd.style.left = handle.x + 'px'; hd.style.top = handle.y + 'px';
        } else if (hd) { hd.remove(); }
      },
      /** Where the pages of a sheet fall, kept until something changes. */
      pageBreaks(sh) {
        const key = sh.name + '|' + sh.maxR + '|' + sh.maxC + '|' + JSON.stringify(this.paper);
        if (this._pbCache && this._pbCache.key === key) { return this._pbCache; }
        const pg = paginate(sh, { r0: 0, c0: 0, r1: Math.max(0, sh.maxR), c1: Math.max(0, sh.maxC) }, this.paper);
        const out = { key, cols: pg.bands.slice(1).map((b) => b.c0).concat([sh.maxC + 1]), rows: pg.strips.slice(1).map((s) => s.r0).concat([sh.maxR + 1]) };
        this._pbCache = out;
        return out;
      },

      // ---- Calc's keys that open or do something of their own ----
      /** Ctrl+* (keypad): the block of data round the cursor, as Calc's SelectData (B2 -> A1:C5). */
      selectDataRegion() {
        const cur = this.sel.cur;
        this.refreshUsed();
        this.sel.ranges = [{ r0: cur.r, c0: cur.c, r1: cur.r, c1: cur.c }];
        const g = this.currentRegion();
        this.sel.ranges = [g]; this.sel.anchor = { r: g.r0, c: g.c0 };
        this.syncSel(); this.paint();
      },
      /** Today, or the time now, as Calc's Ctrl+; and Ctrl+Shift+; put it in: a value, with a date or time format. */
      nowValue(kind) {
        const d = new Date();
        if (kind === 'date') {
          const days = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);
          // what LibreOffice (ja-JP) shows for it: 10月5日; in English, 10/05/26
          return { v: days, fmt: uiLang() === 'ja' ? 'm"月"d"日"' : 'mm/dd/yy' };
        }
        return { v: (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000) / 86400, fmt: 'hh:mm:ss' };
      },
      insertNow(kind) {
        if (this.book.readOnly || !this.book.id) { return; }
        const sh = this.sheet(); const { r, c } = this.sel.cur; const now = this.nowValue(kind);
        this.withStep((rec) => { rec(sh, r, c); this.setInputRaw(sh, r, c, String(now.v)); this.setMeta(sh, r, c, { fmt: now.fmt }); });
      },
      /** Backspace: Calc's "Delete Contents" -- what to take out of the selected cells (the last choice is kept). */
      openDeleteContents() {
        if (this.book.readOnly || !this.book.id) { return; }
        this.delc.open = true;
        this.$nextTick(() => { const b = this.$refs.delcOk; if (b) { b.focus(); } });
      },
      closeDeleteContents() { this.delc.open = false; this.focusGrid(); },
      applyDeleteContents() {
        const o = Object.assign({}, this.delc);
        this.delc.open = false;
        if (this.book.readOnly) { this.focusGrid(); return; }
        const all = o.all;
        const g = this.selRange();
        this.withStep((rec) => {
          this.eachSelCell((sh, r, c) => {
            const gg = wb.get(sh.name, r, c); const meta = sh.meta.get(K(r, c));
            if (!gg.t && !gg.f && !meta) { return; }
            const fmt = fmtOf(meta, gg);
            const isDate = gg.t === 'n' && !gg.f && !!fmt && (isDateFmt(fmt) || isTimeFmt(fmt));
            let drop = false;
            if (all) { drop = !!gg.t || !!gg.f; }
            else if (gg.f) { drop = o.formulas; }
            else if (gg.t === 's') { drop = o.text; }
            else if (gg.t === 'n' || gg.t === 'b') { drop = isDate ? o.dates : o.numbers; }
            else if (gg.t === 'e') { drop = o.numbers; }
            const notes = (all || o.notes) && meta && (meta.note || meta.link);
            const formats = (all || o.formats) && meta && (meta.fmt || meta.s || meta.style);
            if (!drop && !notes && !formats) { return; }
            rec(sh, r, c);
            if (drop) { wb.setInput(sh.name, r, c, ''); }
            if (notes) { this.setMeta(sh, r, c, { note: '', link: '' }); }
            if (formats) { this.setMeta(sh, r, c, { fmt: '', s: null, style: '' }); }
          });
          // the pictures tied to the selected cells go too when objects are ticked
          const sh = this.sheet();
          if ((all || o.objects) && (sh.images || []).some((im) => im.r >= g.r0 && im.r <= g.r1 && im.c >= g.c0 && im.c <= g.c1)) {
            const was = sh.images.map((x) => Object.assign({}, x));
            sh.images = sh.images.filter((im) => !(im.r >= g.r0 && im.r <= g.r1 && im.c >= g.c0 && im.c <= g.c1));
            const now = sh.images.map((x) => Object.assign({}, x));
            if (this.curStep) { this.curStep.extra = { undo: () => { sh.images = was.map((x) => Object.assign({}, x)); this.imgSel = null; this.paintImages(); }, redo: () => { sh.images = now.map((x) => Object.assign({}, x)); this.imgSel = null; this.paintImages(); } }; }
            this.imgSel = null; this.paintImages();
          }
        });
        this.focusGrid();
      },
      /** Ctrl+- : Calc's "Delete Cells" -- the cells go and the others close the gap (or whole rows / columns go). */
      async deleteCells() {
        this.menu = '';
        if (this.book.readOnly) { return; }
        const how = await this.askFor({ title: this.t('Delete Cells'), label: this.t('What closes the gap'), value: 'up',
          options: [{ value: 'up', label: this.t('Shift cells up') }, { value: 'left', label: this.t('Shift cells left') }, { value: 'rows', label: this.t('Delete entire rows') }, { value: 'cols', label: this.t('Delete entire columns') }] });
        if (how == null) { this.focusGrid(); return; }
        if (how === 'rows') { this.deleteRows(); return; } if (how === 'cols') { this.deleteCols(); return; }
        const sh = this.sheet(); const g = this.selRange(); this.refreshUsed();
        const r1 = Math.min(g.r1, MAX_ROWS - 1); const c1 = Math.min(g.c1, MAX_COLS - 1);
        const n = how === 'up' ? r1 - g.r0 + 1 : c1 - g.c0 + 1;
        this.structural(() => {
          // the cells themselves, then what was below (or right of) them moves into the gap through the engine, so references follow
          for (let r = g.r0; r <= Math.min(r1, sh.maxR); r += 1) { for (let c = g.c0; c <= Math.min(c1, sh.maxC); c += 1) { wb.setInput(sh.name, r, c, ''); } }
          const gone = []; sh.meta.forEach((m, k) => { const r = KR(k); const c = KC(k); if (r >= g.r0 && r <= r1 && c >= g.c0 && c <= c1) { gone.push(k); } }); gone.forEach((k) => sh.meta.delete(k));
          if (how === 'up' && sh.maxR > r1) {
            wb.moveRange(sh.name, rangeName({ r0: r1 + 1, c0: g.c0, r1: sh.maxR, c1: Math.min(c1, Math.max(sh.maxC, g.c0)) }), refName(g.r0, g.c0));
            const moved = []; sh.meta.forEach((m, k) => { const r = KR(k); const c = KC(k); if (r > r1 && c >= g.c0 && c <= c1) { moved.push([r, c, m]); } });
            moved.forEach(([r, c]) => sh.meta.delete(K(r, c))); moved.forEach(([r, c, m]) => sh.meta.set(K(r - n, c), m));
          } else if (how === 'left' && sh.maxC > c1) {
            wb.moveRange(sh.name, rangeName({ r0: g.r0, c0: c1 + 1, r1: Math.min(r1, Math.max(sh.maxR, g.r0)), c1: sh.maxC }), refName(g.r0, g.c0));
            const moved = []; sh.meta.forEach((m, k) => { const r = KR(k); const c = KC(k); if (c > c1 && r >= g.r0 && r <= r1) { moved.push([r, c, m]); } });
            moved.forEach(([r, c]) => sh.meta.delete(K(r, c))); moved.forEach(([r, c, m]) => sh.meta.set(K(r, c - n), m));
          }
          this.refreshUsed();
        });
        this.focusGrid();
      },
      /** A fill seed as the engine's fillSeries reads it: the value, its type, and the format it is shown in (a date's tells it to step as a date). */
      seedOf(sh, r, c) {
        const g = wb.get(sh.name, r, c); const fmt = fmtOf(sh.meta.get(K(r, c)), g);
        return fmt ? { v: g.v, t: g.t, fmt } : { v: g.v, t: g.t };
      },
      /**
       * Tells the engine which rows are hidden by hand and which by the filter, so that SUBTOTAL 101–111
       * and AGGREGATE leave them out as Calc does -- only when that changed, and again for a new engine.
       */
      syncRowState() {
        if (!wb || typeof wb.setRowState !== 'function') { return; }
        const known = wb.__cbRowState || (wb.__cbRowState = new Map());
        UIS.forEach((sh) => {
          const filtered = sh.filter && Array.isArray(sh.filter.hidden) ? sh.filter.hidden.slice().sort((a, b) => a - b) : [];
          const byFilter = new Set(filtered);
          const hidden = []; sh.rows.forEach((h, r) => { if (h === 0 && !byFilter.has(r)) { hidden.push(r); } });
          hidden.sort((a, b) => a - b);
          const key = hidden.join(',') + '|' + filtered.join(',');
          if ((known.get(sh.name) || '|') === key) { return; }
          known.set(sh.name, key);
          try { wb.setRowState(sh.name, { hidden, filtered }); } catch (e) { /* a sheet the engine does not hold */ }
        });
      },

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
          if (UNITS[local.unit]) { this.settings.unit = local.unit; }
          // kept in this browser, as EditBase keeps them: the browser's own spelling check, and links made as they are typed
          this.settings.spellcheck = window.localStorage.getItem('cb-spellcheck') === '1';
          this.settings.autolink = window.localStorage.getItem('cb-autolink') !== '0';
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
          if (s.sheetTabs != null) { this.settings.sheetTabs = s.sheetTabs === '1' || s.sheetTabs === true; }
          if (s.cellLimit != null && CELL_LIMITS.includes(Number(s.cellLimit))) { this.settings.cellLimit = Number(s.cellLimit); }
          applyLimits(this.settings.cellLimit);
          if (s.font) { this.settings.font = s.font; }
          if (s.fontSize) { this.settings.fontSize = Number(s.fontSize) || 11; }
          if (UNITS[s.unit]) { this.settings.unit = s.unit; }
          const m = /^(\d+(?:\.\d+)?)(px|%)$/.exec(String(s.aiWidth || ''));
          if (m) { this.settings.aiW = Number(m[1]); this.settings.aiU = m[2]; this._aiWidthFromSettings = true; }
          const sw = /^(\d+(?:\.\d+)?)(px|%)$/.exec(String(s.sheetsWidth || ''));
          if (sw) { this.settings.sheetsW = Number(sw[1]); this.settings.sheetsU = sw[2]; }
          this.catColours = readJson(s.folderColours, {});
          this.bookOrder = readJson(s.bookOrder, {});
          const dp = readJson(s.paper, null);
          this.defaultPaperSetting = s.paper ? normalisePaper(dp) : null;
          this.defaultBookFonts = normaliseFonts(dp && dp.fonts);
          this.build = s.build || '';
        } catch (e) { /* the app still works with the defaults */ }
        try {
          const v = JSON.parse(window.localStorage.getItem('cb-view') || 'null');
          if (v && typeof v === 'object') { Object.keys(this.view).forEach((k) => { if (typeof v[k] === 'boolean') { this.view[k] = v[k]; } }); }
          const sb = JSON.parse(window.localStorage.getItem('cb-statusbar') || 'null');
          if (sb && typeof sb === 'object') { Object.keys(this.statusBar).forEach((k) => { if (typeof sb[k] === 'boolean') { this.statusBar[k] = sb[k]; } }); }
          this.sheetBar.open = window.localStorage.getItem('cb-sheetbar') === '1';
          this.openCat = window.localStorage.getItem('cb-cat') || '';
        } catch (e) { /* nothing remembered */ }
        this.watchForNewBuild();
        this.loadSources();
        this.applyTheme(this.settings.theme);
        if (this.settings.language && this.settings.language !== 'auto') { await this.applyLanguage(this.settings.language); }
        let z = 0; try { z = Number(window.localStorage.getItem('cb-zoom') || 0); } catch (e) { z = 0; }
        if (z >= 50 && z <= 200) { this.zoom = z; }
        if (window.localStorage.getItem('cb-ai-open') === '1') { this.ai.open = true; }
        await this.loadBooks();
        this.aiLoad();
        // the catalogue of Google Fonts, so that the faces a book names are known by the time it is drawn and saved
        this.ensureFontCatalogue();
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
      fontPageItems() { this.loadPreviewFonts(); },
      fontsOpen(on) { if (on) { this.$nextTick(() => this.loadPreviewFonts()); } },
      // the person's default face shows on every book that has none of its own
      'settings.font'() { if (this.book.id) { this.applyBookFonts(); this.paint(); } },
    },
    created() {
      // Not in data(): Vue must not wrap the selection and the undo stack, which change on every keystroke.
      this.sel = { ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], cur: { r: 0, c: 0 }, anchor: { r: 0, c: 0 } };
      this.history = []; this.redoStack = [];
      this.tabStart = null; this.fillPrev = null; this.movePrev = null; this.dragSel = null;
    },
    mounted() {
      this.measureWidth();
      window.addEventListener('resize', () => { this.measureWidth(); if (this.menu) { this.fitMenu(); } this.scheduleThumbs(); });
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
        if (this.share.open) { this.share.open = false; e.preventDefault(); return; }
        if (this.props.open) { this.props.open = false; e.preventDefault(); return; }
        if (this.delc.open) { this.closeDeleteContents(); e.preventDefault(); return; }
        const modals = ['cellPropsOpen', 'fxOpen', 'printOpen', 'htmlOpen', 'exportOpen', 'settingsOpen', 'stylesOpen', 'paperOpen', 'sortOpen', 'splitOpen', 'namesOpen', 'charsOpen', 'emojiOpen', 'keysOpen', 'checkOpen', 'sourceOpen', 'webOpen', 'menuOpen'];
        for (const key of modals) { if (this[key]) { if (key === 'settingsOpen') { this.cancelSettings(); } else { this[key] = false; } e.preventDefault(); return; } }
        if (this.narrow && this.sideOpen) { this.sideOpen = false; e.preventDefault(); }
      });
      // Unsaved work is not lost to a closed tab without a word.
      window.addEventListener('beforeunload', (e) => { if (this.dirty && this.book.id && !this.book.readOnly) { e.preventDefault(); e.returnValue = ''; } });
      // The tooltip of a button, drawn by the app under the button and clear of the pointer (as EditBase).
      const tipRoot = this.$el;
      // The name of the button or menu item looked up in TIPS, and the sentence put under the name (as EditBase).
      let tipLang = null; let tipIndex = null;
      const tipFor = (label) => {
        if (!tipIndex || tipLang !== this.i18nTick) { tipIndex = new Map(); Object.keys(TIPS).forEach((k) => { tipIndex.set(this.t(k), this.t(TIPS[k])); }); tipLang = this.i18nTick; }
        return tipIndex.get(label) || '';
      };
      tipRoot.addEventListener('mouseover', (e) => {
        const el = e.target && e.target.closest ? e.target.closest('button, .ci, .cb-menu-item, label.cb-tb') : null;
        if (!el || !tipRoot.contains(el) || el.closest('.cb-layers')) { return; }
        const title = el.getAttribute('title') || '';
        const base = title ? title.split('\n')[0] : '';
        if (el.dataset.tipFor === (base || el.textContent)) { return; }
        let name = base.replace(/\s*\((Ctrl|Shift|Alt|Tab|F\d)[^)]*\)\s*$/, '').trim();
        if (!name) {
          const copy = el.cloneNode(true);
          copy.querySelectorAll('.k, .s, .fly').forEach((k) => k.remove());
          name = String(copy.textContent || '').replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+/u, '').trim();
        }
        const tip = tipFor(name);
        if (!tip) { return; }
        // lent while the pointer is there and given back after: things are looked up by their title
        el.dataset.tipOrig = title;
        el.setAttribute('title', (base || name) + '\n' + tip);
        el.dataset.tipFor = base || el.textContent;
      });
      tipRoot.addEventListener('mouseout', (e) => {
        const el = e.target && e.target.closest ? e.target.closest('[data-tip-for]') : null;
        if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) { return; }
        if (el.dataset.tipOrig) { el.setAttribute('title', el.dataset.tipOrig); } else { el.removeAttribute('title'); }
        delete el.dataset.tipOrig; delete el.dataset.tipFor;
      });
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
        if (title) { if (el.dataset.cbTipOrig === undefined) { el.dataset.cbTipOrig = el.dataset.tipOrig !== undefined ? el.dataset.tipOrig : title; } el.dataset.cbTip = title; el.removeAttribute('title'); }
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
  window.__cbtest = { parseBook, buildHtml, refsInFormula, cycleAbs, refSlot, parseTsv, tableFromHtml, paginate, normalisePaper, uis: () => UIS, wb: () => wb };

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
