# Changelog

All notable changes to CalcBase are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
