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
	/**
	 * Empty cells that only carry a fill or a border, repeated more often than
	 * this (down or across), are the rest of the sheet painted, not part of the
	 * table: LibreOffice stops its used area at the same count (SC_VISATTR_STOP
	 * in sc/inc/attarray.hxx, "if more than this many identical visible
	 * attribute rows follow, they are not counted"). LibreOffice writes such
	 * runs to the last row (number-rows-repeated="1048534"), and taking them in
	 * cell by cell turned a 36 KB file into "more than a million cells".
	 */
	private const VISIBLE_RUN_STOP = 84;

	// ================================================================ import

	/**
	 * @return array{sheets: list<array<string, mixed>>, active: int}
	 */
	public static function import(ZipReader $zip): array {
		if ($zip->has('mimetype') && !str_contains($zip->read('mimetype'), 'spreadsheet')) {
			throw new \InvalidArgumentException('that OpenDocument file is not a spreadsheet');
		}
		$formats = [];
		$named = [];
		$decimals = null;
		if ($zip->has('styles.xml')) {
			$stylesDoc = ZipReader::parse($zip->read('styles.xml'), 'styles.xml');
			$formats = NumberFormats::fromOdsDocument($stylesDoc);
			// "Limit decimals for general number format" (an older OpenOffice file's default: 2): the
			// default cell style's decimal-places (Calc measured: 12.0775862068966 shows 12.08)
			foreach ($stylesDoc->getElementsByTagNameNS(self::NS_STYLE, 'default-style') as $ds) {
				if ($ds->getAttributeNS(self::NS_STYLE, 'family') !== 'table-cell') {
					continue;
				}
				foreach ($ds->getElementsByTagNameNS(self::NS_STYLE, 'table-cell-properties') as $tp) {
					$dp = $tp->getAttributeNS(self::NS_STYLE, 'decimal-places');
					if ($dp !== '' && ctype_digit($dp) && (int)$dp <= 20) {
						$decimals = (int)$dp;
					}
				}
			}
			// The named cell styles ("Pivot Table Result", "Heading", ...): an automatic
			// style takes what its parent has and changes some of it.
			foreach ($stylesDoc->getElementsByTagNameNS(self::NS_OFFICE, 'styles') as $common) {
				foreach ($common->childNodes as $st) {
					if ($st instanceof \DOMElement && $st->localName === 'style' && $st->getAttributeNS(self::NS_STYLE, 'family') === 'table-cell') {
						$named[$st->getAttributeNS(self::NS_STYLE, 'name')] = $st;
					}
				}
			}
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
		$names = [];
		$dbRanges = [];
		// Calc's settings of the document (Tools ▸ Options ▸ Calc ▸ Calculate); a file without them has
		// ODF's defaults, regular expressions and case-sensitive (Calc 24.2 measured: such a file finds
		// "testing" with MATCH("testi..";…;0) and COUNTIF(…;"a*") finds nothing)
		$calc = ['regex' => true, 'caseSensitive' => true];
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
					$styles = self::styles($el, $formats, $fonts, $named);
					$more = $reader->next();
					continue;
				}
				if ($name === 'table:table' && $sheet === null) {
					if (count($sheets) >= Model::MAX_SHEETS) {
						throw new \InvalidArgumentException(Model::TOO_MANY_SHEETS);
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
				} elseif ($name === 'table:named-expressions') {
					// a sheet's own names inside its table, the book's after the tables
					$found = self::namedExpressions(self::expand($reader, $doc));
					if ($sheet !== null) {
						$sheet['names'] = $found + ($sheet['names'] ?? []);
					} else {
						$names = $found + $names;
					}
					$more = $reader->next();
					continue;
				} elseif ($sheet === null && $name === 'table:database-ranges') {
					$dbRanges = self::databaseRanges(self::expand($reader, $doc));
					$more = $reader->next();
					continue;
				} elseif ($sheet === null && $name === 'table:calculation-settings') {
					$cs = $reader->getAttributeNs('case-sensitive', self::NS_TABLE);
					$rx = $reader->getAttributeNs('use-regular-expressions', self::NS_TABLE);
					$wild = $reader->getAttributeNs('use-wildcards', self::NS_TABLE);
					$calc = ['regex' => $wild !== 'true' && $rx !== 'false', 'caseSensitive' => $cs !== 'false'];
				} elseif ($sheet !== null && ($name === 'table:shapes' || $name === 'office:forms')) {
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
		// a database range is used in formulas by its name too (=VLOOKUP("b";VlookupTable;2)); a name of the same name wins
		$taken = array_change_key_case($names, CASE_LOWER);
		foreach ($dbRanges as $n => $def) {
			if (!isset($taken[strtolower($n)])) {
				$names[$n] = $def;
			}
		}
		if ($names !== []) {
			$model['names'] = $names;
		}
		$own = array_filter(['regex' => $calc['regex'] ?: null, 'caseSensitive' => $calc['caseSensitive'] ? null : false, 'decimals' => $decimals], static fn ($v) => $v !== null);
		if ($own !== []) {
			$model['calc'] = $own;
		}
		if ($zip->has('settings.xml')) {
			self::readSettings($zip->read('settings.xml'), $model);
		}
		return $model;
	}

	/**
	 * The names of a <table:named-expressions>, as a person types them: a named range
	 * ($Sheet1.$A$1:$B$5) or a named expression (a formula). A relative reference in one is
	 * relative to its base cell; the book keeps it relative to A1, as an XLSX file does.
	 *
	 * @return array<string, string> name => definition
	 */
	private static function namedExpressions(\DOMElement $el): array {
		$out = [];
		foreach ($el->childNodes as $n) {
			if (!($n instanceof \DOMElement) || $n->namespaceURI !== self::NS_TABLE) {
				continue;
			}
			$name = $n->getAttributeNS(self::NS_TABLE, 'name');
			if (!Model::validName($name)) {
				continue;
			}
			if ($n->localName === 'named-range') {
				$def = substr(FormulaSyntax::fromOds('of:=[' . $n->getAttributeNS(self::NS_TABLE, 'cell-range-address') . ']'), 1);
			} elseif ($n->localName === 'named-expression') {
				$def = substr(FormulaSyntax::fromOds($n->getAttributeNS(self::NS_TABLE, 'expression')), 1);
			} else {
				continue;
			}
			$base = self::baseCell($n->getAttributeNS(self::NS_TABLE, 'base-cell-address'));
			// (an absolute reference does not move)
			if ($base !== null && ($base[0] !== 0 || $base[1] !== 0)) {
				$def = substr(FormulaSyntax::shift('=' . $def, -$base[0], -$base[1]), 1);
			}
			if ($def !== '' && strlen($def) <= Model::MAX_FORMULA) {
				$out[$name] = $def;
			}
		}
		return $out;
	}

	/** [row, col] of a base-cell-address ($Sheet1.$B$3), or null. */
	private static function baseCell(string $addr): ?array {
		if (!preg_match('/\.\$?([A-Za-z]{1,3})\$?(\d{1,7})$/', trim($addr), $m)) {
			return null;
		}
		return [(int)$m[2] - 1, Cells::colIndex($m[1])];
	}

	/**
	 * The database ranges (Data ▸ Define Range), each as an absolute reference under its name.
	 * The unnamed ones Calc keeps for a sheet's filter (__Anonymous_Sheet_DB__0) are not names.
	 *
	 * @return array<string, string>
	 */
	private static function databaseRanges(\DOMElement $el): array {
		$out = [];
		foreach ($el->getElementsByTagNameNS(self::NS_TABLE, 'database-range') as $db) {
			$name = $db->getAttributeNS(self::NS_TABLE, 'name');
			if (!Model::validName($name) || str_starts_with($name, '__Anonymous_Sheet_DB__')) {
				continue;
			}
			// Sheet1.A1:Sheet1.B5 ('My sheet'.A1:… quoted)
			if (!preg_match('/^\$?(\'(?:[^\']|\'\')+\'|[^.]+)\.\$?([A-Za-z]{1,3})\$?(\d{1,7}):(?:\$?(?:\'(?:[^\']|\'\')+\'|[^.]+)\.)?\$?([A-Za-z]{1,3})\$?(\d{1,7})$/', trim($db->getAttributeNS(self::NS_TABLE, 'target-range-address')), $m)) {
				continue;
			}
			$sheet = $m[1][0] === "'" ? $m[1] : (preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $m[1]) ? $m[1] : "'" . str_replace("'", "''", $m[1]) . "'");
			$out[$name] = '$' . $sheet . '.$' . strtoupper($m[2]) . '$' . $m[3] . ':$' . strtoupper($m[4]) . '$' . $m[5];
		}
		return $out;
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
	private static function styles(\DOMElement $auto, array $formats, array $fonts, array $named = []): array {
		$out = ['cell' => [], 'col' => [], 'row' => []];
		// A cell may name a named style itself, not only through an automatic one.
		foreach ($named as $name => $st) {
			if ($name !== 'Default') {
				$out['cell'][$name] = self::inherited($st, $formats, $fonts, $named);
			}
		}
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
				$out['cell'][$name] = self::inherited($st, $formats, $fonts, $named);
			}
		}
		return $out;
	}

	/**
	 * A cell style with what it takes from its parents (named styles, up to
	 * "Default", which is the sheet's own look and not read): the parents' first,
	 * each child's over them. LibreOffice's pivot tables are bold so: an automatic
	 * style whose parent is "Pivot Table Result", bold.
	 *
	 * @return array{s: array<string, mixed>, fmt: ?string}
	 */
	private static function inherited(\DOMElement $st, array $formats, array $fonts, array $named): array {
		$chain = [$st];
		$seen = [];
		for ($p = $st->getAttributeNS(self::NS_STYLE, 'parent-style-name'); $p !== '' && $p !== 'Default' && isset($named[$p]) && !isset($seen[$p]); $p = $named[$p]->getAttributeNS(self::NS_STYLE, 'parent-style-name')) {
			$seen[$p] = true;
			array_unshift($chain, $named[$p]);
		}
		$out = ['s' => [], 'fmt' => null];
		foreach ($chain as $el) {
			$one = self::cellStyle($el, $formats, $fonts);
			if ($one['auto']) {
				unset($out['s']['ha']);
			}
			$out['s'] = array_merge($out['s'], $one['s']);
			$out['fmt'] = $one['fmt'] ?? $out['fmt'];
		}
		$out['s'] = Model::style($out['s']);
		return $out;
	}

	/** @return array{s: array<string, mixed>, fmt: ?string, auto: bool} auto: the alignment follows the value */
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
			$ha = match ($ha) { 'start', 'left' => 'left', 'center' => 'center', 'end', 'right' => 'right', 'justify' => 'justify', default => '' };
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
		return ['s' => Model::style($s), 'fmt' => $fmt, 'auto' => !$alignFixed];
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
		$filled = false;
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
			// an array formula (Ctrl+Shift+Enter): the range it fills, on the cell that holds it
			$mc = (int)$node->getAttributeNS(self::NS_TABLE, 'number-matrix-columns-spanned');
			$mr = (int)$node->getAttributeNS(self::NS_TABLE, 'number-matrix-rows-spanned');
			if ($cell !== null && isset($cell['f']) && ($mc > 0 || $mr > 0)) {
				$cell['a'] = [max(1, $mr), max(1, $mc)];
			}
			$blank = $cell !== null && !isset($cell['t']) && !isset($cell['f']);
			if ($cell !== null && !($blank && $crep > self::VISIBLE_RUN_STOP)) {
				// A cell repeated across a few columns (a filled band) is written where it is.
				for ($i = 0; $i < min($crep, Cells::MAX_COLS - $c); $i++) {
					$cells[$c + $i] = $cell;
				}
				$filled = $filled || !$blank;
			}
			if ($cs > 1 || $rs > 1) {
				$merges[] = [$c, max(1, $cs), max(1, $rs)];
			}
			$c += $crep;
		}
		if (($cells === [] && $merges === []) || (!$filled && $merges === [] && $rep > self::VISIBLE_RUN_STOP)) {
			// An empty row, however often repeated, is only a count; so are rows of
			// painted empty cells repeated past the point where Calc stops counting.
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
					throw new \InvalidArgumentException(Model::TOO_MANY_CELLS);
				}
				if (isset($cell['a']) && is_array($cell['a'])) {
					$cell['a'] = Cells::rangeName($r, $col, min(Cells::MAX_ROWS - 1, $r + $cell['a'][0] - 1), min(Cells::MAX_COLS - 1, $col + $cell['a'][1] - 1));
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
		// A painted empty cell is kept: its fill and borders are part of the sheet.
		// One whose style shows nothing while it is empty -- a font, an alignment,
		// a number format -- is not: Calc leaves such attributes out of the used
		// area too (ScAttrArray::GetLastVisibleAttr), and a column's default style
		// of that kind otherwise made every empty cell down to row 1048576 a cell.
		if (!isset($out['t']) && !isset($out['f']) && !self::visible($out['s'] ?? [])) {
			return null;
		}
		return $out === [] ? null : $out;
	}

	/** Whether a style shows on an empty cell: a fill or a border. */
	private static function visible(array $s): bool {
		return isset($s['bg']) || isset($s['bt']) || isset($s['br']) || isset($s['bb']) || isset($s['bl']);
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
		if (!empty($sheet['names'])) {
			$out['names'] = $sheet['names'];
		}
		// Widths for the columns in use (and the ones set by hand just beyond them are nobody's loss).
		$upto = max($sheet['maxc'], 1);
		foreach ($sheet['colStyles'] as $c => $px) {
			// the screen's own default is no width of its own (see Model::DEFAULT_COL_PX)
			if ($c < $upto && $px !== Model::DEFAULT_COL_PX) {
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
