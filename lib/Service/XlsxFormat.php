<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * Excel workbooks (.xlsx) in and out of the workbook model.
 *
 * In: the workbook's sheet list, the shared strings, the styles (number formats,
 * fonts, fills, borders, alignment) and each sheet read row by row with
 * XMLReader; formulas as written (SUM(B2:B5), Sheet2!A1 -- already what a
 * person types), shared formulas unfolded to each cell, merged cells, column
 * widths, row heights set by hand, frozen panes.
 *
 * Out: see XlsxWriter.
 */
final class XlsxFormat {
	public const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
	public const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
	public const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
	public const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
	/**
	 * A column width in an XLSX file is a count of characters: of the widest digit
	 * of the workbook's default font (the font of its "Normal" style). Calc turns
	 * it into a length with that digit's width as its own fonts draw it --
	 * oox/source/xls/unitconverter.cxx: the widest of 0-9, in whole twips -- and
	 * CalcBase does the same, so that a column is as wide here as in Calc.
	 *
	 * The digit's width as a fraction of the font size, for the font LibreOffice
	 * 24.2 on this server draws in place of each name (measured 2026-10-05: an
	 * XLSX with one font, columns of 1, 10 and 50 characters, at 10, 11 and 14 pt,
	 * opened by soffice; every one came out as round(em * pt * 20) twips a
	 * character). A name not listed is drawn in Noto Sans, as Calibri, Verdana,
	 * MS P Gothic, Yu Gothic, Meiryo and the like all were.
	 */
	private const DIGIT_EM = [
		'liberation sans' => 0.5562, 'arial' => 0.5562, 'helvetica' => 0.5562, 'arimo' => 0.5562, 'century' => 0.5562,
		'liberation serif' => 0.5, 'times new roman' => 0.5, 'tinos' => 0.5, 'ipagothic' => 0.5, 'ipaゴシック' => 0.5, 'ipapgothic' => 0.5,
		'liberation mono' => 0.6001, 'courier new' => 0.6001, 'courier' => 0.6001, 'cousine' => 0.6001, 'consolas' => 0.6001, 'terminal' => 0.6001,
		'dejavu sans' => 0.6362,
		'ms 明朝' => 0.5586, 'ms mincho' => 0.5586, 'cambria' => 0.5586, 'georgia' => 0.5586,
	];
	private const DIGIT_EM_OTHER = 0.572;
	/** What Calc adds to the base width (in digits) of a sheet with no default width of its own: five pixels. */
	private const BASE_WIDTH_PADDING_PX = 5;
	/** The font CalcBase's own XLSX files say is the default, as Calc's do: its digit is the same everywhere (Arial or its twin Liberation Sans). */
	public const WRITE_FONT = 'Arial';
	public const WRITE_SIZE = 10;

	/** Excel's indexed colours 0..63, for files that still use them. */
	private const INDEXED = ['000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff', '000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff',
		'800000', '008000', '000080', '808000', '800080', '008080', 'c0c0c0', '808080', '9999ff', '993366', 'ffffcc', 'ccffff', '660066', 'ff8080', '0066cc', 'ccccff',
		'000080', 'ff00ff', 'ffff00', '00ffff', '800080', '800000', '008080', '0000ff', '00ccff', 'ccffff', 'ccffcc', 'ffff99', '99ccff', 'ff99cc', 'cc99ff', 'ffcc99',
		'3366ff', '33cccc', '99cc00', 'ffcc00', 'ff9900', 'ff6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'];

	/**
	 * @return array{sheets: list<array<string, mixed>>, active: int}
	 */
	public static function import(ZipReader $zip): array {
		$wb = $zip->dom('xl/workbook.xml');
		$date1904 = false;
		foreach ($wb->getElementsByTagNameNS(self::NS_MAIN, 'workbookPr') as $pr) {
			$date1904 = in_array($pr->getAttribute('date1904'), ['1', 'true'], true);
		}
		$active = 0;
		foreach ($wb->getElementsByTagNameNS(self::NS_MAIN, 'workbookView') as $view) {
			$active = (int)$view->getAttribute('activeTab');
		}
		$rels = self::rels($zip, 'xl/_rels/workbook.xml.rels', 'xl/');
		$sheetsMeta = [];
		foreach ($wb->getElementsByTagNameNS(self::NS_MAIN, 'sheet') as $index => $sh) {
			$rid = $sh->getAttributeNS(self::NS_REL, 'id');
			if (!isset($rels[$rid])) {
				continue;
			}
			$sheetsMeta[] = ['name' => $sh->getAttribute('name') ?: ('Sheet' . (count($sheetsMeta) + 1)), 'part' => $rels[$rid], 'index' => $index];
		}
		if ($sheetsMeta === []) {
			throw new \InvalidArgumentException('that file has no sheets');
		}
		if (count($sheetsMeta) > Model::MAX_SHEETS) {
			throw new \InvalidArgumentException(Model::TOO_MANY_SHEETS);
		}
		$strings = [];
		if ($zip->has('xl/sharedStrings.xml')) {
			$strings = self::sharedStrings($zip->read('xl/sharedStrings.xml'));
		}
		$stylesDoc = $zip->has('xl/styles.xml') ? $zip->dom('xl/styles.xml') : null;
		[$fontName, $fontSize] = $stylesDoc !== null ? self::defaultFont($stylesDoc) : ['Calibri', 11.0];
		$xfs = $stylesDoc !== null ? self::styles($stylesDoc, ['font' => $fontName, 'size' => $fontSize]) : [];
		$digitMm = self::digitMm($fontName, $fontSize);
		$count = 0;
		$sheets = [];
		foreach ($sheetsMeta as $meta) {
			$sheets[] = self::sheet($zip->read($meta['part']), $meta['name'], $strings, $xfs, $date1904, $count, $digitMm);
		}
		// Defined names (Formulas ▸ Name Manager): the book's, and a sheet's own (localSheetId, the
		// sheet's place in <sheets>). Excel's own (_xlnm.Print_Area, _xlnm._FilterDatabase) are not names one uses.
		$names = [];
		$byIndex = [];
		foreach ($sheetsMeta as $i => $meta) {
			$byIndex[$meta['index']] = $i;
		}
		foreach ($wb->getElementsByTagNameNS(self::NS_MAIN, 'definedName') as $dn) {
			$name = $dn->getAttribute('name');
			$text = trim($dn->textContent);
			if (str_starts_with(strtolower($name), '_xlnm.') || !Model::validName($name) || $text === '' || strlen($text) > Model::MAX_FORMULA) {
				continue;
			}
			$def = substr(FormulaSyntax::fromXlsx($text), 1);
			if ($dn->hasAttribute('localSheetId')) {
				$i = $byIndex[(int)$dn->getAttribute('localSheetId')] ?? null;
				if ($i !== null) {
					$sheets[$i]['names'][$name] = $def;
				}
			} else {
				$names[$name] = $def;
			}
		}
		$model = ['sheets' => $sheets, 'active' => max(0, min(count($sheets) - 1, $active))];
		if ($names !== []) {
			$model['names'] = $names;
		}
		// Calc reads an XLSX file as not case-sensitive, as Excel is ("a"="A" is TRUE; measured)
		$model['calc'] = ['caseSensitive' => false];
		return $model;
	}

	/**
	 * The workbook's default font, name and size: the font of the cell style the
	 * "Normal" style (builtinId 0) names, as Calc takes it
	 * (StylesBuffer::getDefaultFont); the first font when there is no such style.
	 *
	 * @return array{0: string, 1: float}
	 */
	private static function defaultFont(\DOMDocument $doc): array {
		$fonts = self::children($doc, 'fonts', 'font');
		$styleXfs = self::children($doc, 'cellStyleXfs', 'xf');
		$fontId = 0;
		foreach (self::children($doc, 'cellStyles', 'cellStyle') as $cs) {
			if ($cs->getAttribute('builtinId') === '0') {
				$xf = $styleXfs[(int)$cs->getAttribute('xfId')] ?? null;
				if ($xf !== null) {
					$fontId = (int)$xf->getAttribute('fontId');
				}
				break;
			}
		}
		$font = $fonts[$fontId] ?? $fonts[0] ?? null;
		$name = 'Calibri';
		$size = 11.0;
		if ($font !== null) {
			foreach ($font->childNodes as $p) {
				if ($p instanceof \DOMElement && $p->localName === 'name' && $p->getAttribute('val') !== '') {
					$name = $p->getAttribute('val');
				} elseif ($p instanceof \DOMElement && $p->localName === 'sz' && is_numeric($p->getAttribute('val')) && (float)$p->getAttribute('val') > 0) {
					$size = (float)$p->getAttribute('val');
				}
			}
		}
		return [$name, $size];
	}

	/** The width of the widest digit of a font, in millimetres, as Calc measures it: whole twips. */
	public static function digitMm(string $font, float $size): float {
		$key = mb_strtolower(trim(mb_convert_kana($font, 'as', 'UTF-8')), 'UTF-8');
		$em = self::DIGIT_EM[$key] ?? self::DIGIT_EM_OTHER;
		$twips = max(1, (int)round($em * $size * 20));
		return $twips / 20 / 72 * 25.4;
	}

	/** A width in characters of that digit as CSS pixels (96 an inch). */
	public static function pxOfChars(float $chars, float $digitMm): int {
		return max(1, (int)round($chars * $digitMm / 25.4 * 96));
	}

	/** CSS pixels as a width in characters of the digit of the font CalcBase's own files name (WRITE_FONT). */
	public static function charsOfPx(float $px): float {
		return $px * 25.4 / 96 / self::digitMm(self::WRITE_FONT, self::WRITE_SIZE);
	}

	/** @return array<string, string> rId => part name */
	private static function rels(ZipReader $zip, string $part, string $base): array {
		$out = [];
		if (!$zip->has($part)) {
			return $out;
		}
		foreach ($zip->dom($part)->getElementsByTagNameNS(self::NS_PKG_REL, 'Relationship') as $rel) {
			$target = $rel->getAttribute('Target');
			$out[$rel->getAttribute('Id')] = str_starts_with($target, '/') ? ltrim($target, '/') : $base . $target;
		}
		return $out;
	}

	/** @return list<string> */
	private static function sharedStrings(string $xml): array {
		$out = [];
		$reader = new \XMLReader();
		if (!$reader->XML($xml, 'UTF-8', LIBXML_NONET)) {
			throw new \InvalidArgumentException('sharedStrings.xml cannot be read');
		}
		$doc = new \DOMDocument();
		$more = $reader->read();
		while ($more) {
			if ($reader->nodeType === \XMLReader::ELEMENT && $reader->localName === 'si') {
				$si = $reader->expand($doc);
				$out[] = $si instanceof \DOMElement ? self::richText($si) : '';
				$more = $reader->next();
				continue;
			}
			$more = $reader->read();
		}
		$reader->close();
		return $out;
	}

	/** The text of an si or is element: every t, the phonetic guides left out. */
	private static function richText(\DOMElement $el): string {
		$out = '';
		foreach ($el->childNodes as $node) {
			if (!($node instanceof \DOMElement)) {
				continue;
			}
			if ($node->localName === 't') {
				$out .= $node->textContent;
			} elseif ($node->localName === 'r') {
				foreach ($node->getElementsByTagNameNS(self::NS_MAIN, 't') as $t) {
					$out .= $t->textContent;
				}
			}
		}
		return $out;
	}

	/**
	 * The cell formats (cellXfs), each resolved: ['fmt' => code|null, 's' => style, 'date' => bool].
	 *
	 * @return list<array{fmt: ?string, s: array<string, mixed>, date: bool}>
	 */
	private static function styles(\DOMDocument $doc, array $base): array {
		$custom = [];
		foreach ($doc->getElementsByTagNameNS(self::NS_MAIN, 'numFmt') as $nf) {
			$custom[(int)$nf->getAttribute('numFmtId')] = $nf->getAttribute('formatCode');
		}
		$fonts = [];
		foreach (self::children($doc, 'fonts', 'font') as $f) {
			$font = [];
			foreach ($f->childNodes as $p) {
				if (!($p instanceof \DOMElement)) {
					continue;
				}
				$val = $p->getAttribute('val');
				switch ($p->localName) {
					case 'b': $font['b'] = $val === '' || $val === '1' || $val === 'true'; break;
					case 'i': $font['i'] = $val === '' || $val === '1' || $val === 'true'; break;
					case 'u': $font['u'] = $val !== 'none'; break;
					case 'strike': $font['strike'] = $val === '' || $val === '1' || $val === 'true'; break;
					case 'sz': $font['size'] = (float)$val; break;
					case 'name': $font['font'] = $val; break;
					case 'color': $font['color'] = self::colour($p); break;
				}
			}
			$fonts[] = $font;
		}
		$fills = [];
		foreach (self::children($doc, 'fills', 'fill') as $f) {
			$bg = null;
			foreach ($f->getElementsByTagNameNS(self::NS_MAIN, 'patternFill') as $pf) {
				if ($pf->getAttribute('patternType') === 'solid') {
					foreach ($pf->getElementsByTagNameNS(self::NS_MAIN, 'fgColor') as $c) {
						$bg = self::colour($c);
					}
				}
			}
			$fills[] = $bg;
		}
		$borders = [];
		foreach (self::children($doc, 'borders', 'border') as $b) {
			$sides = [];
			foreach (['top' => 'bt', 'right' => 'br', 'bottom' => 'bb', 'left' => 'bl'] as $side => $key) {
				foreach ($b->getElementsByTagNameNS(self::NS_MAIN, $side) as $s) {
					$style = $s->getAttribute('style');
					if ($style === '' || $style === 'none') {
						continue;
					}
					$colour = '#000000';
					foreach ($s->getElementsByTagNameNS(self::NS_MAIN, 'color') as $c) {
						$colour = self::colour($c) ?? $colour;
					}
					$sides[$key] = self::borderOf($style) . ' ' . $colour;
				}
			}
			$borders[] = $sides;
		}
		$out = [];
		foreach (self::children($doc, 'cellXfs', 'xf') as $xf) {
			$s = [];
			$fontId = (int)$xf->getAttribute('fontId');
			$font = $fonts[$fontId] ?? [];
			foreach (['b', 'i', 'u', 'strike'] as $k) {
				if (!empty($font[$k])) {
					$s[$k] = 1;
				}
			}
			if (!empty($font['color']) && $font['color'] !== '#000000') {
				$s['color'] = $font['color'];
			}
			// The base font (the workbook's) is not written on every cell: only another one is.
			if (isset($font['size']) && $font['size'] !== $base['size']) {
				$s['size'] = $font['size'];
			}
			if (isset($font['font']) && $font['font'] !== $base['font']) {
				$s['font'] = $font['font'];
			}
			$bg = $fills[(int)$xf->getAttribute('fillId')] ?? null;
			if ($bg !== null) {
				$s['bg'] = $bg;
			}
			$s += $borders[(int)$xf->getAttribute('borderId')] ?? [];
			$span = null;
			foreach ($xf->getElementsByTagNameNS(self::NS_MAIN, 'alignment') as $al) {
				// As Calc reads them (oox/source/xls/stylesbuffer.cxx): "distributed" and
				// "justify" are both justified; "centerContinuous" is centred, and with
				// "fill" it makes the empty cells after it one with it (see row()).
				$horizontal = $al->getAttribute('horizontal');
				$ha = match ($horizontal) { 'left' => 'left', 'center', 'centerContinuous' => 'center', 'right' => 'right', 'justify', 'distributed' => 'justify', default => null };
				if ($horizontal === 'centerContinuous' || $horizontal === 'fill') {
					$span = $horizontal;
				}
				$va = match ($al->getAttribute('vertical')) { 'top' => 'top', 'center', 'distributed' => 'middle', 'bottom' => 'bottom', default => null };
				if ($ha !== null) {
					$s['ha'] = $ha;
				}
				if ($va !== null) {
					$s['va'] = $va;
				}
				if (in_array($al->getAttribute('wrapText'), ['1', 'true'], true)) {
					$s['wrap'] = 1;
				}
			}
			$fmt = NumberFormats::fromXlsxId((int)$xf->getAttribute('numFmtId'), $custom);
			$out[] = [
				'fmt' => $fmt === 'General' ? null : $fmt,
				's' => Model::style($s),
				'date' => $fmt !== 'General' && OdsWriter::kindOf($fmt) === 'date',
				'span' => $span,
			];
		}
		return $out;
	}

	/** @return list<\DOMElement> */
	private static function children(\DOMDocument $doc, string $parent, string $child): array {
		$out = [];
		foreach ($doc->getElementsByTagNameNS(self::NS_MAIN, $parent) as $p) {
			foreach ($p->childNodes as $c) {
				if ($c instanceof \DOMElement && $c->localName === $child) {
					$out[] = $c;
				}
			}
		}
		return $out;
	}

	private static function colour(\DOMElement $c): ?string {
		$rgb = $c->getAttribute('rgb');
		if (preg_match('/^(?:[0-9A-Fa-f]{2})?([0-9A-Fa-f]{6})$/', $rgb, $m)) {
			return '#' . strtolower($m[1]);
		}
		if ($c->hasAttribute('indexed')) {
			$i = (int)$c->getAttribute('indexed');
			return isset(self::INDEXED[$i]) ? '#' . self::INDEXED[$i] : null;
		}
		// theme colours need the theme part; not read
		return null;
	}

	private static function borderOf(string $style): string {
		return match ($style) {
			'thin', 'hair' => '1px solid',
			'medium' => '2px solid',
			'thick' => '3px solid',
			'dashed', 'dashDot', 'dashDotDot', 'slantDashDot' => '1px dashed',
			'mediumDashed', 'mediumDashDot', 'mediumDashDotDot' => '2px dashed',
			'dotted' => '1px dotted',
			'double' => '3px double',
			default => '1px solid',
		};
	}

	/** One worksheet part into a model sheet. */
	private static function sheet(string $xml, string $name, array $strings, array $xfs, bool $date1904, int &$count, float $digitMm): array {
		$reader = new \XMLReader();
		if (!$reader->XML($xml, 'UTF-8', LIBXML_NONET)) {
			throw new \InvalidArgumentException('a worksheet cannot be read');
		}
		$sheet = ['name' => mb_substr($name, 0, 64), 'cells' => [], 'cols' => [], 'rows' => [], 'merges' => []];
		$shared = [];
		$spans = [];
		$defaultChars = null;
		$baseChars = 8.0;
		$doc = new \DOMDocument();
		$more = $reader->read();
		while ($more) {
			if ($reader->nodeType === \XMLReader::ELEMENT) {
				switch ($reader->localName) {
					case 'sheetFormatPr':
						if (is_numeric($reader->getAttribute('defaultColWidth'))) {
							$defaultChars = (float)$reader->getAttribute('defaultColWidth');
						}
						if (is_numeric($reader->getAttribute('baseColWidth'))) {
							$baseChars = (float)$reader->getAttribute('baseColWidth');
						}
						break;
					case 'col':
						$min = (int)$reader->getAttribute('min');
						$max = min((int)$reader->getAttribute('max'), $min + 64);
						$width = $reader->getAttribute('width');
						// A hidden column keeps its width, as Calc keeps it (the model has no
						// "hidden" for a column yet; its width at least is not lost).
						if (is_numeric($width) && (float)$width > 0) {
							$px = self::pxOfChars((float)$width, $digitMm);
							for ($c = $min; $c >= 1 && $c <= $max && $c <= Cells::MAX_COLS; $c++) {
								$sheet['cols'][Cells::colName($c - 1)] = $px;
							}
						}
						break;
					case 'pane':
						if ($reader->getAttribute('state') === 'frozen') {
							$top = $reader->getAttribute('topLeftCell');
							if (Cells::parseRef($top) !== null) {
								$sheet['freeze'] = strtoupper($top);
							} else {
								$sheet['freeze'] = Cells::ref((int)$reader->getAttribute('ySplit'), (int)$reader->getAttribute('xSplit'));
							}
						}
						break;
					case 'sheetView':
						if (in_array($reader->getAttribute('showGridLines'), ['0', 'false'], true)) {
							$sheet['grid'] = false;
						}
						break;
					case 'row':
						$row = $reader->expand($doc);
						if ($row instanceof \DOMElement) {
							self::row($row, $sheet, $strings, $xfs, $date1904, $shared, $count, $spans);
						}
						$more = $reader->next();
						continue 2;
					case 'mergeCell':
						$box = Cells::parseRange($reader->getAttribute('ref'));
						if ($box !== null && ($box[0] !== $box[2] || $box[1] !== $box[3])) {
							$sheet['merges'][] = Cells::rangeName(...$box);
						}
						break;
					case 'drawing':
					case 'legacyDrawing':
					case 'extLst':
					case 'conditionalFormatting':
					case 'dataValidations':
						$more = $reader->next();
						continue 2;
				}
			}
			$more = $reader->read();
		}
		$reader->close();
		// Runs centred across, as merged cells. Calc makes them after the file's own
		// merges, and one in the way of a run is undone by it (measured: a run
		// B6:D6 over the file's C6:C7 leaves B6:D6 alone).
		foreach ($spans as [$r, $c1, $c2]) {
			if ($c2 > $c1) {
				$sheet['merges'] = array_values(array_filter($sheet['merges'], static fn (string $m): bool => !self::overlaps([$m], $r, $c1, $c2)));
				$sheet['merges'][] = Cells::rangeName($r, $c1, $r, $c2);
			}
		}
		// The columns in use that the file gives no width: the sheet's default, as
		// Calc reads it (WorksheetGlobals::setBaseColumnWidth / setDefaultColumnWidth):
		// defaultColWidth digits, or else baseColWidth digits and five pixels.
		$px = $defaultChars !== null
			? self::pxOfChars($defaultChars, $digitMm)
			: max(1, (int)round($baseChars * $digitMm / 25.4 * 96 + self::BASE_WIDTH_PADDING_PX));
		[, $used] = Cells::extent($sheet['cells'], $sheet['merges']);
		for ($c = 0; $c < $used; $c++) {
			$sheet['cols'][Cells::colName($c)] ??= $px;
		}
		uksort($sheet['cols'], static fn ($a, $b): int => Cells::colIndex((string)$a) <=> Cells::colIndex((string)$b));
		// the screen's own default is no width of its own (see Model::DEFAULT_COL_PX)
		$sheet['cols'] = array_filter($sheet['cols'], static fn ($px): bool => $px !== Model::DEFAULT_COL_PX);
		return Model::tidy($sheet);
	}

	/**
	 * One row's cells into the sheet. A cell aligned "centre across selection"
	 * (or "fill") with something in it starts a run, and each empty cell aligned
	 * the same right after it makes the run longer; Calc has no such alignment
	 * and makes each run of more than one cell a merged cell
	 * (SheetDataBuffer::setCellFormat / MergedRange::tryExpand), and so does
	 * CalcBase: the Statistics Bureau's table 1 has its heading AI5 so over AJ5.
	 *
	 * @param list<array{0: int, 1: int, 2: int, 3: string}> $spans the runs: row, first and last column, alignment
	 */
	private static function row(\DOMElement $row, array &$sheet, array $strings, array $xfs, bool $date1904, array &$shared, int &$count, array &$spans = []): void {
		$r = (int)$row->getAttribute('r') - 1;
		if ($r < 0 || $r >= Cells::MAX_ROWS) {
			return;
		}
		if (in_array($row->getAttribute('customHeight'), ['1', 'true'], true) && is_numeric($row->getAttribute('ht'))) {
			$sheet['rows'][(string)($r + 1)] = (int)round((float)$row->getAttribute('ht') * 96 / 72);
		}
		$c = 0;
		foreach ($row->childNodes as $node) {
			if (!($node instanceof \DOMElement) || $node->localName !== 'c') {
				continue;
			}
			$at = Cells::parseRef($node->getAttribute('r'));
			if ($at !== null) {
				$c = $at[1];
			}
			if ($c >= Cells::MAX_COLS) {
				break;
			}
			$cell = self::cell($node, $r, $c, $strings, $xfs, $date1904, $shared);
			if ($cell !== null) {
				if (++$count > Model::MAX_CELLS) {
					throw new \InvalidArgumentException(Model::TOO_MANY_CELLS);
				}
				$sheet['cells'][Cells::ref($r, $c)] = $cell;
			}
			$span = $node->hasAttribute('s') ? ($xfs[(int)$node->getAttribute('s')]['span'] ?? null) : null;
			if ($span !== null) {
				if (isset($cell['t']) || isset($cell['f'])) {
					$spans[] = [$r, $c, $c, $span];
				} elseif ($spans !== []) {
					$last = &$spans[count($spans) - 1];
					if ($last[3] === $span && $last[0] === $r && $last[2] + 1 === $c) {
						$last[2] = $c;
					}
					unset($last);
				}
			}
			$c++;
		}
	}

	/** Whether any of the merges takes in a cell of row $r between columns $c1 and $c2. */
	private static function overlaps(array $merges, int $r, int $c1, int $c2): bool {
		foreach ($merges as $m) {
			$box = Cells::parseRange($m);
			if ($box !== null && $box[0] <= $r && $r <= $box[2] && $box[1] <= $c2 && $c1 <= $box[3]) {
				return true;
			}
		}
		return false;
	}

	/** @return array<string, mixed>|null */
	private static function cell(\DOMElement $el, int $r, int $c, array $strings, array $xfs, bool $date1904, array &$shared): ?array {
		$out = [];
		$type = $el->getAttribute('t') ?: 'n';
		$xf = $el->hasAttribute('s') ? ($xfs[(int)$el->getAttribute('s')] ?? null) : null;
		$v = null;
		$f = null;
		$is = null;
		foreach ($el->childNodes as $child) {
			if (!($child instanceof \DOMElement)) {
				continue;
			}
			if ($child->localName === 'v') {
				$v = $child->textContent;
			} elseif ($child->localName === 'f') {
				$f = $child;
			} elseif ($child->localName === 'is') {
				$is = self::richText($child);
			}
		}
		if ($f !== null) {
			$text = trim($f->textContent);
			if ($f->getAttribute('t') === 'shared') {
				$si = $f->getAttribute('si');
				if ($text !== '') {
					$shared[$si] = ['f' => $text, 'r' => $r, 'c' => $c];
				} elseif (isset($shared[$si])) {
					$m = $shared[$si];
					$text = substr(FormulaSyntax::shift('=' . $m['f'], $r - $m['r'], $c - $m['c']), 1);
				}
			}
			if ($text !== '') {
				$out['f'] = mb_substr(FormulaSyntax::fromXlsx($text), 0, Model::MAX_FORMULA);
				// an array formula: the range it fills (<f t="array" ref="C63:C63">)
				if ($f->getAttribute('t') === 'array' && ($box = Cells::parseRange(str_replace('$', '', $f->getAttribute('ref')))) !== null) {
					$out['a'] = Cells::rangeName(...$box);
				}
			}
		}
		switch ($type) {
			case 's':
				if ($v !== null && isset($strings[(int)$v])) {
					$out['t'] = 's';
					$out['v'] = mb_substr($strings[(int)$v], 0, Model::MAX_TEXT);
				}
				break;
			case 'str':
				if ($v !== null) {
					$out['t'] = 's';
					$out['v'] = mb_substr($v, 0, Model::MAX_TEXT);
				}
				break;
			case 'inlineStr':
				if ($is !== null) {
					$out['t'] = 's';
					$out['v'] = mb_substr($is, 0, Model::MAX_TEXT);
				}
				break;
			case 'b':
				if ($v !== null) {
					$out['t'] = 'b';
					$out['v'] = $v === '1' || $v === 'true';
				}
				break;
			case 'e':
				if ($v !== null) {
					$out['t'] = 'e';
					$out['v'] = $v;
				}
				break;
			case 'd':
				$serial = $v === null ? null : Cells::serialOfIso($v);
				if ($serial !== null) {
					$out['t'] = 'n';
					$out['v'] = $serial;
				}
				break;
			default:
				if ($v !== null && is_numeric($v)) {
					$n = (float)$v;
					if ($date1904 && ($xf['date'] ?? false)) {
						$n += 1462;
					}
					$out['t'] = 'n';
					$out['v'] = floor($n) == $n && abs($n) < 1e15 ? (int)$n : $n;
				}
		}
		if ($xf !== null) {
			if ($xf['fmt'] !== null) {
				$out['fmt'] = $xf['fmt'];
			}
			if ($xf['s'] !== []) {
				$out['s'] = $xf['s'];
			}
		}
		return $out === [] ? null : $out;
	}

	/** @param array{sheets: list<array<string, mixed>>, active: int} $model a cleaned model */
	public static function export(array $model): string {
		return (new XlsxWriter($model))->bytes();
	}
}
