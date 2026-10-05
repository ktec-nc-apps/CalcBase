# Changelog

All notable changes to CalcBase are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.0.1] — unreleased

First shape.

### Added
- Workbooks saved as self-contained `.html` files in the user's Files (folder `CalcBase` by
  default): one HTML table per sheet, each cell carrying what it shows with its formula, exact
  value and number format beside it; versions kept beside the file; autosave; a conflict with a
  newer copy on the server is caught.
- A calculation engine compatible with LibreOffice Calc: 143 functions, references across
  sheets, dependency-ordered recalculation, Calc's error values, number formats including
  Japanese era dates, input recognised as numbers, percentages, currency, dates and times;
  checked against LibreOffice 24.2 on some 1,250 formulas.
- A virtualised grid with Calc's keyboard and mouse handling, the formula bar with function
  hints, copy and paste with other spreadsheet programs, the fill handle, insert and delete
  rows and columns, merged cells, freeze panes, sort, an autofilter, find and replace, cell
  properties (number format, alignment, font, borders, fill) and printing with a page setup.
- Import of CSV/TSV (UTF-8, Shift_JIS), ODS and XLSX; export to CSV, ODS and XLSX.
- An AI assistant through the AI-Hub app, off until the administrator turns it on.
- Settings in the look shared by the Base-series apps; light and dark themes; Japanese and
  English; a layout for phones.
