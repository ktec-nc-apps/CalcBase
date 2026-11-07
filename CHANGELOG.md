# Changelog

All notable changes to CalcBase are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.2] — 2026-11-08

The AI assistant can now work with all of the writer's books; Excel 365's dynamic array functions; the screen in twenty-one languages.
（AI アシスタントが、開いているブックだけでなく、利用者のすべてのブックを扱えるようになりました。Excel 365 の動的配列の関数に対応しました。画面が 21 言語になりました。）

### Added
- **The AI assistant can work with the writer's other books** (with AI-Hub). Besides changing the cells of the open book, as before, it can list the writer's books (their own and those shared with them), read them, make a new book with its sheets and cells, write cells into a book that is not open, rename a book, put one in the trash bin, and list and put back a book's versions. It acts with the rights of the person asking: a book shared read-only is not written. Before every write, a version of the book as it was is kept, so "Versions…" can put it back; a deleted book goes to the Files trash bin with its versions. The book open in front of the writer is still changed only through the assistant's proposed cells, applied as one step that Ctrl+Z undoes. The book list is read again as soon as the answer comes, and what was actually done is listed under the answer, apart from the assistant's words (a failure as a failure). In the administration settings, "The writer's own books" has two new choices, off until the administrator turns them on: reading the other books, and making, changing and deleting books.
  （**AI アシスタントが、AI-Hub を通して、利用者のほかのブックも扱えるようになりました。** 開いているブックのセルを変えることに加えて、利用者のブック（自分のブックと共有されたブック）の一覧と中身を読み、シートとセルを入れた新しいブックを作り、開いていないブックにセルを書き込み、ブックの名前を変え、ごみ箱に移し、バージョンの一覧を見て元に戻します。操作は質問した人の権限で行い、読み取り専用で共有されたブックには書き込みません。書き込む前には必ずその時点のバージョンを残すので、「バージョン…」から元に戻せます。削除したブックは、バージョンと一緒に Files のごみ箱に入ります。開いているブックは、これまでどおり AI が示したセルを 1 つの操作として反映し、Ctrl+Z で取り消せます。AI が答えると、ブックの一覧もすぐ新しい内容に変わり、実際に行った操作が AI の文章とは別に答えの下に並びます（失敗したものは失敗と表示します）。管理設定の「利用者自身のブック」に、「ほかのブックを読む」と「ブックの作成・変更・削除」の 2 つの選択肢を足しました。管理者がオンにするまではオフです。）
- **Excel 365's dynamic arrays**: FILTER, SORT, SORTBY, UNIQUE, SEQUENCE, RANDARRAY, VSTACK, HSTACK, TOCOL, TOROW, WRAPROWS, WRAPCOLS, TAKE, DROP, CHOOSEROWS, CHOOSECOLS, EXPAND and LET. A formula that returns an array spills into the cells beside it, as in Excel: #SPILL! when something is in the way (a value, or merged cells), #CALC! for an empty result; typing into a cell it spilled into gives #SPILL!.
  （**Excel 365 の動的配列に対応しました。** FILTER・SORT・SORTBY・UNIQUE・SEQUENCE・RANDARRAY・VSTACK・HSTACK・TOCOL・TOROW・WRAPROWS・WRAPCOLS・TAKE・DROP・CHOOSEROWS・CHOOSECOLS・EXPAND・LET です。配列を返す式は、Excel と同じように隣のセルへ広がります（スピル）。広がる先に値や結合セルがあると #SPILL!、結果が空だと #CALC! になります。広がった先のセルに入力すると #SPILL! になります。）
- Text and regular expressions from Excel 365: TEXTSPLIT, TEXTBEFORE, TEXTAFTER, ARRAYTOTEXT, VALUETOTEXT, REGEXTEST, REGEXEXTRACT, REGEXREPLACE, and PERCENTOF and ERROR.TYPE. A regular expression is read as Excel reads it (PCRE2); what JavaScript cannot match the same way gives #VALUE!, never a different match.
  （Excel 365 の文字列と正規表現の関数 TEXTSPLIT・TEXTBEFORE・TEXTAFTER・ARRAYTOTEXT・VALUETOTEXT・REGEXTEST・REGEXEXTRACT・REGEXREPLACE と、PERCENTOF・ERROR.TYPE に対応しました。正規表現は Excel と同じ規則（PCRE2）で読みます。同じ結果を出せない書き方は、違う結果を出さずに #VALUE! にします。）
- LibreOffice Calc's FOURIER and MULTIPLE.OPERATIONS, the last of its functions CalcBase had left out. The engine now has 523 functions (494 before).
  （LibreOffice Calc の関数のうち、残っていた FOURIER と MULTIPLE.OPERATIONS に対応しました。関数は 494 から 523 になりました。）
- The screen in twenty-one languages: Chinese (Simplified), Korean, German, French, Spanish, Italian, Portuguese (Brazil and Portugal), Russian, Ukrainian, Polish, Czech, Turkish, Arabic, Persian, Hindi, Indonesian, Vietnamese and Thai, besides Japanese and English. All of them can be chosen in the settings.
  （画面が 21 言語になりました。日本語と英語に加えて、中国語（簡体字）・韓国語・ドイツ語・フランス語・スペイン語・イタリア語・ポルトガル語（ブラジル・ポルトガル）・ロシア語・ウクライナ語・ポーランド語・チェコ語・トルコ語・アラビア語・ペルシャ語・ヒンディー語・インドネシア語・ベトナム語・タイ語です。どの言語も設定で選べます。）

### Fixed
- The new functions are written to ODS and XLSX as LibreOffice and Excel write them (COM.MICROSOFT.… in ODS, _xlfn. and LET's _xlpm. names in XLSX), so a book exported from CalcBase calculates the same in LibreOffice and Excel. A spilling formula keeps Excel's dynamic-array mark in XLSX, both ways.
  （新しい関数を、LibreOffice や Excel と同じ書き方で ODS と XLSX に書き出すようにしました（ODS では COM.MICROSOFT.…、XLSX では _xlfn. と LET の _xlpm.）。CalcBase から書き出したブックは、LibreOffice や Excel でも同じ結果になります。スピルする式は、XLSX の読み書きで Excel の動的配列の印を保ちます。）
- The language list in the settings showed only some of the languages the screen is translated into.
  （設定の言語の一覧に、翻訳のある言語の一部しか出ていなかった問題を直しました。）
- **Translations reviewed in every language.** The cell styles Neutral and Note and the special-character groups Numbers and Punctuation showed one another's names in every language but Japanese (Neutral read "Numbers", for example). Japanese was gone through in full — the date format "Date (Japanese)", which is year-month-day in the Western calendar, no longer says it is the Japanese era — and every other language line by line for wrong meanings, literal phrasing and terms used two ways.
  （**すべての言語の訳を見直しました。** 日本語以外のすべての言語で、セルのスタイルの Neutral と Note、特殊文字の分類の Numbers と Punctuation の名前が、たがいに入れ違って表示されていました（たとえば Neutral が「数字」）。日本語は全体を点検し、西暦の年月日の書式なのに「和暦風」と表示していた「日付（年月日）」などを直しました。ほかの言語も、1 行ずつ、意味の誤り・直訳・用語の揺れを点検しました。）

## [0.1.1] — 2026-10-11

Only the Japanese text was rewritten — the README, the App Store description and the changelog — to read naturally. No feature was added or changed.
（README・App Store の説明・変更履歴の日本語の文章を、自然な日本語に差し替えただけです。機能の追加や変更はありません。）

## [0.1.0] — 2026-10-09

The first public release.

### Added
- Workbooks saved as self-contained `.html` files in the user's Files (folder `CalcBase` by default): one HTML table per sheet, each cell carrying what it shows with its formula, exact value and number format beside it; versions kept beside the file; autosave; a conflict with a newer copy on the server is caught.
- A calculation engine compatible with LibreOffice Calc: 494 functions, references across sheets, dependency-ordered recalculation, Calc's error values, number formats including Japanese era dates, input recognised as numbers, percentages, currency, dates and times. Its test suite (3,563 checks, many of them LibreOffice 24.2's own answers) passes.
- A grid with Calc's keyboard and mouse handling, the formula bar with function hints, copy and paste with other spreadsheet programs, the fill handle, insert and delete rows and columns, merged cells, freeze panes, sort, an autofilter, find and replace, cell properties (number format, alignment, font, borders, fill), images with cropping, alternative text and compression, and printing with a page setup.
- The screen of EditBase: categories and books in the sidebar, the tool rows, the rail for insert, import and data, the sheet bar at the right (its width can be dragged, and the pictures grow with it), tooltips, a status bar. Sheet tabs under the sheet are off by default and can be switched on in the settings.
- Fonts: the fonts of the book, with Google Fonts to choose from; paper and page settings kept in the book.
- Import of CSV/TSV (UTF-8, Shift_JIS), ODS and XLSX; export to CSV, ODS and XLSX. Import also from the other apps of the series and from Nextcloud: RegiBase, FormulaBase, EditBase, NetBase, Tables, Contacts, Calendar, a web page and a Markdown file.
- An AI assistant through the AI-Hub app, off until the administrator turns it on; the width of its panel can be dragged.
- Settings in the look shared by the Base-series apps; light and dark themes; Japanese and English; a layout for phones.

### Limits
- CalcBase is for tables kept by hand, not for bulk data. A book holds 100,000 cells by default, a sheet 30,000 rows and a file 24 MB. The limit can be raised in the settings, or removed, at the user's own risk. A book over the limit opens read-only; nothing in it is lost.

### Not yet
- Charts, pivot tables, conditional formatting, data validation, array formulas (Ctrl+Shift+Enter), macros, and several people editing one workbook at once.
