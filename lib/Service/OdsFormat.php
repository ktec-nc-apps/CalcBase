<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * OpenDocument spreadsheets (.ods) in and out of the workbook model.
 *
 * In: content.xml is read row by row with XMLReader -- a sheet of a hundred
 * thousand rows is never a tree in memory -- and its automatic styles once as
 * a tree. Values, formulas (of:=SUM([.B2:.B5]) → =SUM(B2:B5)), the styles the
 * contract names, number formats where readable, column widths, row heights
 * set by hand, merged cells, several sheets. The number styles LibreOffice
 * keeps in styles.xml are read from there.
 *
 * Out: the same, written back as the smallest package LibreOffice opens as its
 * own -- mimetype first and uncompressed, manifest, content, styles, meta, and
 * the settings that carry frozen panes.
 */
final class OdsFormat {
	public const MIME = 'application/vnd.oasis.opendocument.spreadsheet';
	private const NS_OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
	private const NS_STYLE = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
	private const NS_TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
	private const NS_TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
	private const NS_FO = 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0';
	private const NS_SVG = 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0';
	private const NS_CALCEXT = 'urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0';
	/** A row with something in it repeated more often than this is written out this many times only. */
	private const MAX_REPEAT = 10000;

	// ================================================================ import

	/**
	 * @return array{sheets: list<array<string, mixed>>, active: int}
	 */
	public static function import(ZipReader $zip): array {
		if ($zip->has('mimetype') && !str_contains($zip->read('mimetype'), 'spreadsheet')) {
			throw new \InvalidArgumentException('that OpenDocument file is not a spreadsheet');
		}
		$formats = [];
		if ($zip->has('styles.xml')) {
			$formats = NumberFormats::fromOdsDocument(ZipReader::parse($zip->read('styles.xml'), 'styles.xml'));
		}
		$content = $zip->read('content.xml');
		$reader = new \XMLReader();
		if (!$reader->XML($content, 'UTF-8', LIBXML_NONET)) {
			throw new \InvalidArgumentException('content.xml cannot be read');
		}
		$styles = ['cell' => [], 'col' => [], 'row' => []];
		$fonts = [];
		$sheets = [];
		$count = 0;
		$sheet = null;
		$doc = new \DOMDocument();
		$more = $reader->read();
		while ($more) {
			if ($reader->nodeType === \XMLReader::ELEMENT) {
				$name = $reader->name;
				if ($name === 'office:font-face-decls') {
					$fonts = self::fontFaces(self::expand($reader, $doc));
					$more = $reader->next();
					continue;
				}
				if ($name === 'office:automatic-styles') {
					$el = self::expand($reader, $doc);
					$auto = new \DOMDocument();
					$auto->appendChild($auto->importNode($el, true));
					$formats = NumberFormats::fromOdsDocument($auto) + $formats;
					$styles = self::styles($el, $formats, $fonts);
					$more = $reader->next();
					continue;
				}
				if ($name === 'table:table' && $sheet === null) {
					if (count($sheets) >= Model::MAX_SHEETS) {
						throw new \InvalidArgumentException('that file has more than ' . Model::MAX_SHEETS . ' sheets');
					}
					$sheet = [
						'name' => $reader->getAttributeNs('name', self::NS_TABLE) ?: ('Sheet' . (count($sheets) + 1)),
						'cells' => [], 'cols' => [], 'rows' => [], 'merges' => [],
						'r' => 0, 'c' => 0, 'colStyles' => [], 'colDefaults' => [], 'maxc' => 0,
					];
				} elseif ($sheet !== null && $name === 'table:table-column') {
					$rep = max(1, (int)($reader->getAttributeNs('number-columns-repeated', self::NS_TABLE) ?: 1));
					$st = (string)$reader->getAttributeNs('style-name', self::NS_TABLE);
					$def = (string)$reader->getAttributeNs('default-cell-style-name', self::NS_TABLE);
					for ($i = 0; $i < $rep && $sheet['c'] < Cells::MAX_COLS; $i++, $sheet['c']++) {
						if ($st !== '' && isset($styles['col'][$st])) {
							$sheet['colStyles'][$sheet['c']] = $styles['col'][$st];
						}
						if ($def !== '' && $def !== 'Default' && isset($styles['cell'][$def])) {
							$sheet['colDefaults'][$sheet['c']] = $def;
						}
					}
				} elseif ($sheet !== null && $name === 'table:table-row') {
					self::row(self::expand($reader, $doc), $sheet, $styles, $count);
					$more = $reader->next();
					continue;
				} elseif ($sheet !== null && ($name === 'table:shapes' || $name === 'office:forms' || $name === 'table:named-expressions')) {
					$more = $reader->next();
					continue;
				}
			} elseif ($reader->nodeType === \XMLReader::END_ELEMENT && $reader->name === 'table:table' && $sheet !== null) {
				$sheets[] = self::finish($sheet);
				$sheet = null;
			}
			$more = $reader->read();
		}
		$reader->close();
		if ($sheets === []) {
			throw new \InvalidArgumentException('that file has no sheets');
		}
		$model = ['sheets' => $sheets, 'active' => 0];
		if ($zip->has('settings.xml')) {
			self::readSettings($zip->read('settings.xml'), $model);
		}
		return $model;
	}

	private static function expand(\XMLReader $reader, \DOMDocument $doc): \DOMElement {
		$node = $reader->expand($doc);
		if (!($node instanceof \DOMElement)) {
			throw new \InvalidArgumentException('content.xml cannot be read');
		}
		return $node;
	}

	/** @return array<string, string> font style name => family */
	private static function fontFaces(\DOMElement $decls): array {
		$out = [];
		foreach ($decls->getElementsByTagNameNS(self::NS_STYLE, 'font-face') as $f) {
			$name = $f->getAttributeNS(self::NS_STYLE, 'name');
			$family = trim($f->getAttributeNS(self::NS_SVG, 'font-family'), " '\"");
			$out[$name] = $family !== '' ? $family : $name;
		}
		return $out;
	}

	/**
	 * The automatic styles: cells (style and number format), column widths, row heights.
	 *
	 * @return array{cell: array<string, array{s: array, fmt: ?string}>, col: array<string, int>, row: array<string, ?int>}
	 */
	private static function styles(\DOMElement $auto, array $formats, array $fonts): array {
		$out = ['cell' => [], 'col' => [], 'row' => []];
		foreach ($auto->getElementsByTagNameNS(self::NS_STYLE, 'style') as $st) {
			$name = $st->getAttributeNS(self::NS_STYLE, 'name');
			$family = $st->getAttributeNS(self::NS_STYLE, 'family');
			if ($family === 'table-column') {
				foreach ($st->getElementsByTagNameNS(self::NS_STYLE, 'table-column-properties') as $p) {
					$px = Cells::pxOfLength($p->getAttributeNS(self::NS_STYLE, 'column-width'));
					if ($px !== null && $px > 0) {
						$out['col'][$name] = (int)round($px);
					}
				}
			} elseif ($family === 'table-row') {
				foreach ($st->getElementsByTagNameNS(self::NS_STYLE, 'table-row-properties') as $p) {
					// A height the file says is optimal is the program's, not the person's: left to the browser.
					if ($p->getAttributeNS(self::NS_STYLE, 'use-optimal-row-height') === 'true') {
						$out['row'][$name] = null;
						continue;
					}
					$px = Cells::pxOfLength($p->getAttributeNS(self::NS_STYLE, 'row-height'));
					$out['row'][$name] = $px !== null && $px > 0 ? (int)round($px) : null;
				}
			} elseif ($family === 'table-cell') {
				$out['cell'][$name] = self::cellStyle($st, $formats, $fonts);
			}
		}
		return $out;
	}

	/** @return array{s: array<string, mixed>, fmt: ?string} */
	private static function cellStyle(\DOMElement $st, array $formats, array $fonts): array {
		$s = [];
		$data = $st->getAttributeNS(self::NS_STYLE, 'data-style-name');
		$fmt = $data !== '' && isset($formats[$data]) && $formats[$data] !== 'General' ? $formats[$data] : null;
		$alignFixed = true;
		foreach ($st->getElementsByTagNameNS(self::NS_STYLE, 'table-cell-properties') as $p) {
			$bg = $p->getAttributeNS(self::NS_FO, 'background-color');
			if ($bg !== '' && $bg !== 'transparent' && ($c = Model::colour($bg)) !== null) {
				$s['bg'] = $c;
			}
			$va = $p->getAttributeNS(self::NS_STYLE, 'vertical-align');
			if (in_array($va, ['top', 'middle', 'bottom'], true)) {
				$s['va'] = $va;
			}
			if ($p->getAttributeNS(self::NS_FO, 'wrap-option') === 'wrap') {
				$s['wrap'] = 1;
			}
			if ($p->getAttributeNS(self::NS_STYLE, 'text-align-source') === 'value-type') {
				$alignFixed = false;
			}
			$all = self::border($p->getAttributeNS(self::NS_FO, 'border'));
			foreach (['top' => 'bt', 'right' => 'br', 'bottom' => 'bb', 'left' => 'bl'] as $side => $key) {
				$one = $p->hasAttributeNS(self::NS_FO, 'border-' . $side) ? self::border($p->getAttributeNS(self::NS_FO, 'border-' . $side)) : $all;
				if ($one !== null) {
					$s[$key] = $one;
				}
			}
		}
		foreach ($st->getElementsByTagNameNS(self::NS_STYLE, 'paragraph-properties') as $p) {
			if ($p->getAttributeNS(self::NS_STYLE, 'text-align-source') === 'value-type') {
				$alignFixed = false;
			}
			$ha = $p->getAttributeNS(self::NS_FO, 'text-align');
			$ha = match ($ha) { 'start', 'left' => 'left', 'center' => 'center', 'end', 'right' => 'right', default => '' };
			if ($ha !== '' && $alignFixed) {
				$s['ha'] = $ha;
			}
		}
		foreach ($st->getElementsByTagNameNS(self::NS_STYLE, 'text-properties') as $p) {
			if ($p->getAttributeNS(self::NS_FO, 'font-weight') === 'bold') {
				$s['b'] = 1;
			}
			if ($p->getAttributeNS(self::NS_FO, 'font-style') === 'italic') {
				$s['i'] = 1;
			}
			$u = $p->getAttributeNS(self::NS_STYLE, 'text-underline-style');
			if ($u !== '' && $u !== 'none') {
				$s['u'] = 1;
			}
			$lt = $p->getAttributeNS(self::NS_STYLE, 'text-line-through-style');
			if ($lt !== '' && $lt !== 'none') {
				$s['strike'] = 1;
			}
			$colour = $p->getAttributeNS(self::NS_FO, 'color');
			if ($colour !== '' && ($c = Model::colour($colour)) !== null) {
				$s['color'] = $c;
			}
			$size = $p->getAttributeNS(self::NS_FO, 'font-size');
			if (preg_match('/^(\d+(?:\.\d+)?)pt$/', $size, $m)) {
				$s['size'] = (float)$m[1];
			}
			$font = $p->getAttributeNS(self::NS_STYLE, 'font-name');
			if ($font !== '') {
				$s['font'] = $fonts[$font] ?? $font;
			}
		}
		return ['s' => Model::style($s), 'fmt' => $fmt];
	}

	/** "0.74pt solid #000000" → "1px solid #000000"; none → null. */
	private static function border(string $spec): ?string {
		$spec = trim($spec);
		if ($spec === '' || $spec === 'none' || $spec === 'hidden') {
			return null;
		}
		$width = 1;
		$style = 'solid';
		$colour = '#000000';
		foreach (preg_split('/\s+/', $spec) ?: [] as $part) {
			if (($px = Cells::pxOfLength($part)) !== null) {
				$width = $px < 1.9 ? 1 : ($px < 3.2 ? 2 : 3);
			} elseif (in_array($part, ['solid', 'dashed', 'dotted', 'double'], true)) {
				$style = $part;
			} elseif (in_array($part, ['dash-dot', 'dash-dot-dot', 'fine-dashed', 'double-thin'], true)) {
				$style = $part === 'fine-dashed' ? 'dotted' : ($part === 'double-thin' ? 'double' : 'dashed');
			} elseif (($c = Model::colour($part)) !== null) {
				$colour = $c;
			} elseif (in_array($part, ['thin', 'medium', 'thick'], true)) {
				$width = $part === 'thin' ? 1 : ($part === 'medium' ? 2 : 3);
			}
		}
		return $width . 'px ' . $style . ' ' . $colour;
	}

	/** One table:table-row (and its repeats) into the sheet's cells. */
	private static function row(\DOMElement $row, array &$sheet, array $styles, int &$count): void {
		$rep = max(1, (int)($row->getAttributeNS(self::NS_TABLE, 'number-rows-repeated') ?: 1));
		$cells = [];
		$merges = [];
		$c = 0;
		foreach ($row->childNodes as $node) {
			if (!($node instanceof \DOMElement) || $node->namespaceURI !== self::NS_TABLE) {
				continue;
			}
			$crep = max(1, (int)($node->getAttributeNS(self::NS_TABLE, 'number-columns-repeated') ?: 1));
			if ($node->localName === 'covered-table-cell') {
				$c += $crep;
				continue;
			}
			if ($node->localName !== 'table-cell') {
				continue;
			}
			$cell = self::cell($node, $styles, $sheet['colDefaults'][$c] ?? null);
			$cs = (int)$node->getAttributeNS(self::NS_TABLE, 'number-columns-spanned');
			$rs = (int)$node->getAttributeNS(self::NS_TABLE, 'number-rows-spanned');
			if ($cell !== null) {
				// A cell repeated across many columns (a filled background) is written where it is.
				for ($i = 0; $i < min($crep, Cells::MAX_COLS - $c); $i++) {
					$cells[$c + $i] = $cell;
				}
			}
			if ($cs > 1 || $rs > 1) {
				$merges[] = [$c, max(1, $cs), max(1, $rs)];
			}
			$c += $crep;
		}
		if ($cells === [] && $merges === []) {
			// An empty row, however often repeated, is only a count.
			$sheet['r'] = min(Cells::MAX_ROWS, $sheet['r'] + $rep);
			return;
		}
		$height = null;
		$st = $row->getAttributeNS(self::NS_TABLE, 'style-name');
		if ($st !== '' && isset($styles['row'][$st])) {
			$height = $styles['row'][$st];
		}
		$times = min($rep, self::MAX_REPEAT, Cells::MAX_ROWS - $sheet['r']);
		for ($k = 0; $k < $times; $k++) {
			$r = $sheet['r'];
			foreach ($cells as $col => $cell) {
				if (++$count > Model::MAX_CELLS) {
					throw new \InvalidArgumentException('that file has more than ' . Model::MAX_CELLS . ' cells');
				}
				$sheet['cells'][Cells::ref($r, $col)] = $cell;
				$sheet['maxc'] = max($sheet['maxc'], $col + 1);
			}
			foreach ($merges as [$col, $cs, $rs]) {
				$sheet['merges'][] = Cells::rangeName($r, $col, min(Cells::MAX_ROWS - 1, $r + $rs - 1), min(Cells::MAX_COLS - 1, $col + $cs - 1));
				$sheet['maxc'] = max($sheet['maxc'], $col + $cs);
			}
			if ($height !== null) {
				$sheet['rows'][(string)($r + 1)] = $height;
			}
			$sheet['r']++;
		}
		$sheet['r'] = min(Cells::MAX_ROWS, $sheet['r'] + ($rep - $times));
	}

	/** @return array<string, mixed>|null the model cell, or null for an empty one */
	private static function cell(\DOMElement $el, array $styles, ?string $columnStyle): ?array {
		$out = [];
		$type = $el->getAttributeNS(self::NS_OFFICE, 'value-type');
		$ext = $el->getAttributeNS(self::NS_CALCEXT, 'value-type');
		$text = self::text($el);
		$stName = $el->getAttributeNS(self::NS_TABLE, 'style-name');
		$style = $stName !== '' ? ($styles['cell'][$stName] ?? null) : ($columnStyle !== null ? $styles['cell'][$columnStyle] ?? null : null);
		$fmt = $style['fmt'] ?? null;
		$formula = $el->getAttributeNS(self::NS_TABLE, 'formula');
		if ($formula !== '') {
			$out['f'] = mb_substr(FormulaSyntax::fromOds($formula), 0, Model::MAX_FORMULA);
		}
		if ($ext === 'error') {
			$out['t'] = 'e';
			$out['v'] = $text !== '' ? $text : '#VALUE!';
		} else {
			switch ($type) {
				case 'float':
				case 'percentage':
				case 'currency':
					$v = $el->getAttributeNS(self::NS_OFFICE, 'value');
					if (is_numeric($v)) {
						$out['t'] = 'n';
						$out['v'] = self::num((float)$v);
					}
					if ($type === 'percentage' && $fmt === null) {
						$fmt = '0.00%';
					}
					if ($type === 'currency' && $fmt === null) {
						$fmt = self::currencyFormat($el->getAttributeNS(self::NS_OFFICE, 'currency'));
					}
					break;
				case 'date':
					$v = Cells::serialOfIso($el->getAttributeNS(self::NS_OFFICE, 'date-value'));
					if ($v !== null) {
						$out['t'] = 'n';
						$out['v'] = self::num($v);
						$fmt ??= str_contains($el->getAttributeNS(self::NS_OFFICE, 'date-value'), 'T') ? 'yyyy/mm/dd h:mm' : 'yyyy/mm/dd';
					}
					break;
				case 'time':
					$v = Cells::serialOfDuration($el->getAttributeNS(self::NS_OFFICE, 'time-value'));
					if ($v !== null) {
						$out['t'] = 'n';
						$out['v'] = self::num($v);
						$fmt ??= 'h:mm:ss';
					}
					break;
				case 'boolean':
					$out['t'] = 'b';
					$out['v'] = $el->getAttributeNS(self::NS_OFFICE, 'boolean-value') === 'true';
					break;
				case 'string':
					$sv = $el->hasAttributeNS(self::NS_OFFICE, 'string-value') ? $el->getAttributeNS(self::NS_OFFICE, 'string-value') : $text;
					if ($sv !== '' || $formula !== '') {
						$out['t'] = 's';
						$out['v'] = mb_substr($sv !== '' ? $sv : $text, 0, Model::MAX_TEXT);
					}
					break;
				default:
					if ($text !== '') {
						$out['t'] = 's';
						$out['v'] = mb_substr($text, 0, Model::MAX_TEXT);
					}
			}
		}
		if ($fmt !== null) {
			$out['fmt'] = $fmt;
		}
		if (!empty($style['s'])) {
			$out['s'] = $style['s'];
		}
		// A styled empty cell is kept (its fill and borders are part of the sheet); a bare one is not.
		return $out === [] ? null : $out;
	}

	private static function num(float $v): int|float {
		return floor($v) == $v && abs($v) < 1e15 ? (int)$v : $v;
	}

	private static function currencyFormat(string $symbol): string {
		return match (strtoupper($symbol)) {
			'JPY', '¥', '￥' => '¥#,##0',
			'USD', '$' => '$#,##0.00',
			'EUR', '€' => '€#,##0.00',
			'GBP', '£' => '£#,##0.00',
			'' => '#,##0.00',
			default => '"' . $symbol . '"#,##0.00',
		};
	}

	/** The text of a cell: its paragraphs joined with line breaks, spaces and tabs as written. */
	private static function text(\DOMElement $cell): string {
		$paras = [];
		foreach ($cell->childNodes as $node) {
			if ($node instanceof \DOMElement && $node->namespaceURI === self::NS_TEXT && $node->localName === 'p') {
				$paras[] = self::inline($node);
			}
		}
		return implode("\n", $paras);
	}

	private static function inline(\DOMNode $node): string {
		$out = '';
		foreach ($node->childNodes as $child) {
			if ($child instanceof \DOMText) {
				$out .= $child->data;
			} elseif ($child instanceof \DOMElement) {
				if ($child->namespaceURI === self::NS_TEXT) {
					switch ($child->localName) {
						case 's':
							$out .= str_repeat(' ', max(1, (int)($child->getAttributeNS(self::NS_TEXT, 'c') ?: 1)));
							continue 2;
						case 'tab':
							$out .= "\t";
							continue 2;
						case 'line-break':
							$out .= "\n";
							continue 2;
						case 'note':
						case 'annotation':
							continue 2;
					}
				} elseif ($child->namespaceURI === self::NS_OFFICE && $child->localName === 'annotation') {
					continue;
				}
				$out .= self::inline($child);
			}
		}
		return $out;
	}

	/** @return array<string, mixed> the sheet as the model has it */
	private static function finish(array $sheet): array {
		$out = Model::tidy(['name' => mb_substr($sheet['name'], 0, 64), 'cells' => $sheet['cells'], 'cols' => [], 'rows' => $sheet['rows'], 'merges' => $sheet['merges']]);
		// Widths for the columns in use (and the ones set by hand just beyond them are nobody's loss).
		$upto = max($sheet['maxc'], 1);
		foreach ($sheet['colStyles'] as $c => $px) {
			if ($c < $upto) {
				$out['cols'][Cells::colName($c)] = $px;
			}
		}
		return $out;
	}

	/** Frozen panes and the active sheet, from settings.xml. */
	private static function readSettings(string $xml, array &$model): void {
		try {
			$doc = ZipReader::parse($xml, 'settings.xml');
		} catch (\InvalidArgumentException) {
			return;
		}
		$ns = 'urn:oasis:names:tc:opendocument:xmlns:config:1.0';
		$xpath = new \DOMXPath($doc);
		$xpath->registerNamespace('config', $ns);
		$byName = [];
		foreach ($model['sheets'] as $i => $s) {
			$byName[$s['name']] = $i;
		}
		$active = $xpath->query('//config:config-item[@config:name="ActiveTable"]')->item(0);
		if ($active !== null && isset($byName[$active->textContent])) {
			$model['active'] = $byName[$active->textContent];
		}
		foreach ($xpath->query('//config:config-item-map-named[@config:name="Tables"]/config:config-item-map-entry') as $entry) {
			$name = $entry->getAttributeNS($ns, 'name');
			if (!isset($byName[$name])) {
				continue;
			}
			$get = static function (string $key) use ($xpath, $entry): string {
				$n = $xpath->query('config:config-item[@config:name="' . $key . '"]', $entry)->item(0);
				return $n === null ? '' : trim($n->textContent);
			};
			$h = $get('HorizontalSplitMode') === '2' ? (int)$get('HorizontalSplitPosition') : 0;
			$v = $get('VerticalSplitMode') === '2' ? (int)$get('VerticalSplitPosition') : 0;
			if ($h > 0 || $v > 0) {
				$model['sheets'][$byName[$name]]['freeze'] = Cells::ref($v, $h);
			}
		}
	}

	// ================================================================ export

	/** @param array{sheets: list<array<string, mixed>>, active: int} $model a cleaned model */
	public static function export(array $model): string {
		$w = new OdsWriter($model);
		return $w->bytes();
	}
}
