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
	/** Pixels per character of column width: Calibri 11, the format's yardstick. */
	public const PX_PER_CHAR = 7;
	public const COL_PADDING = 5;

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
		foreach ($wb->getElementsByTagNameNS(self::NS_MAIN, 'sheet') as $sh) {
			$rid = $sh->getAttributeNS(self::NS_REL, 'id');
			if (!isset($rels[$rid])) {
				continue;
			}
			$sheetsMeta[] = ['name' => $sh->getAttribute('name') ?: ('Sheet' . (count($sheetsMeta) + 1)), 'part' => $rels[$rid]];
		}
		if ($sheetsMeta === []) {
			throw new \InvalidArgumentException('that file has no sheets');
		}
		if (count($sheetsMeta) > Model::MAX_SHEETS) {
			throw new \InvalidArgumentException('that file has more than ' . Model::MAX_SHEETS . ' sheets');
		}
		$strings = [];
		if ($zip->has('xl/sharedStrings.xml')) {
			$strings = self::sharedStrings($zip->read('xl/sharedStrings.xml'));
		}
		$xfs = $zip->has('xl/styles.xml') ? self::styles($zip->dom('xl/styles.xml')) : [];
		$count = 0;
		$sheets = [];
		foreach ($sheetsMeta as $meta) {
			$sheets[] = self::sheet($zip->read($meta['part']), $meta['name'], $strings, $xfs, $date1904, $count);
		}
		return ['sheets' => $sheets, 'active' => max(0, min(count($sheets) - 1, $active))];
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
	private static function styles(\DOMDocument $doc): array {
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
		$base = $fonts[0] ?? [];
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
			if (isset($font['size']) && $font['size'] !== ($base['size'] ?? null)) {
				$s['size'] = $font['size'];
			}
			if (isset($font['font']) && $font['font'] !== ($base['font'] ?? null)) {
				$s['font'] = $font['font'];
			}
			$bg = $fills[(int)$xf->getAttribute('fillId')] ?? null;
			if ($bg !== null) {
				$s['bg'] = $bg;
			}
			$s += $borders[(int)$xf->getAttribute('borderId')] ?? [];
			foreach ($xf->getElementsByTagNameNS(self::NS_MAIN, 'alignment') as $al) {
				$ha = match ($al->getAttribute('horizontal')) { 'left' => 'left', 'center', 'centerContinuous', 'distributed' => 'center', 'right' => 'right', default => null };
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
	private static function sheet(string $xml, string $name, array $strings, array $xfs, bool $date1904, int &$count): array {
		$reader = new \XMLReader();
		if (!$reader->XML($xml, 'UTF-8', LIBXML_NONET)) {
			throw new \InvalidArgumentException('a worksheet cannot be read');
		}
		$sheet = ['name' => mb_substr($name, 0, 64), 'cells' => [], 'cols' => [], 'rows' => [], 'merges' => []];
		$shared = [];
		$doc = new \DOMDocument();
		$more = $reader->read();
		while ($more) {
			if ($reader->nodeType === \XMLReader::ELEMENT) {
				switch ($reader->localName) {
					case 'col':
						$min = (int)$reader->getAttribute('min');
						$max = min((int)$reader->getAttribute('max'), $min + 64);
						$width = $reader->getAttribute('width');
						$hidden = in_array($reader->getAttribute('hidden'), ['1', 'true'], true);
						if (is_numeric($width) && !$hidden) {
							$px = (int)round((float)$width * self::PX_PER_CHAR + self::COL_PADDING);
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
							self::row($row, $sheet, $strings, $xfs, $date1904, $shared, $count);
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
		return Model::tidy($sheet);
	}

	private static function row(\DOMElement $row, array &$sheet, array $strings, array $xfs, bool $date1904, array &$shared, int &$count): void {
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
					throw new \InvalidArgumentException('that file has more than ' . Model::MAX_CELLS . ' cells');
				}
				$sheet['cells'][Cells::ref($r, $c)] = $cell;
			}
			$c++;
		}
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
