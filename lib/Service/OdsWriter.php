<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * The model written as an .ods package (see OdsFormat). One instance per file:
 * it collects the styles the cells use while the tables are written, then puts
 * them at the top of content.xml where the format wants them.
 */
final class OdsWriter {
	private const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" xmlns:ooo="http://openoffice.org/2004/office" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3"';

	/** @var array<string, string> style key (json) => cell style name */
	private array $cellStyles = [];
	/** @var array<string, string> format code => number style name ('' when the code cannot be written) */
	private array $numberStyles = [];
	private string $numberXml = '';
	/** @var array<int, string> px => column style name */
	private array $colStyles = [];
	/** @var array<int, string> px => row style name */
	private array $rowStyles = [];
	/** @var array<string, true> */
	private array $fonts = [];

	public function __construct(private array $model) {
	}

	public function bytes(): string {
		$tables = '';
		foreach ($this->model['sheets'] as $sheet) {
			$tables .= $this->table($sheet);
		}
		// The book's settings, said: a file without them is case-sensitive and reads regular expressions in
		// Calc (ODF's defaults), and LibreOffice opened CalcBase's ODS so -- COUNTIF(…;"a*") found nothing.
		// As Calc writes a new document's: wildcards; case-sensitive is the default and not written.
		$calc = $this->model['calc'] ?? [];
		$settings = '<table:calculation-settings'
			. (($calc['caseSensitive'] ?? true) === false ? ' table:case-sensitive="false"' : '')
			. ' table:automatic-find-labels="false"'
			. (($calc['regex'] ?? false) === true ? ' table:use-regular-expressions="true" table:use-wildcards="false"' : ' table:use-regular-expressions="false" table:use-wildcards="true"')
			. '/>';
		$tables = $settings . $tables . $this->namedExpressions($this->model['names'] ?? []);
		$content = '<?xml version="1.0" encoding="UTF-8"?>' . "\n"
			. '<office:document-content ' . self::NS . '>'
			. $this->fontDecls()
			. '<office:automatic-styles>' . $this->automaticStyles() . '</office:automatic-styles>'
			. '<office:body><office:spreadsheet>' . $tables . '</office:spreadsheet></office:body>'
			. '</office:document-content>';
		return self::package([
			'content.xml' => $content,
			'styles.xml' => $this->stylesXml(),
			'meta.xml' => self::metaXml(),
			'settings.xml' => $this->settingsXml(),
		]);
	}

	// ---- the tables ----

	private function table(array $sheet): string {
		$esc = self::esc(...);
		[$rows, $cols] = Cells::extent($sheet['cells'], $sheet['merges']);
		$rows = max($rows, 1);
		$cols = max($cols, 1);
		$covered = [];
		$spans = [];
		foreach ($sheet['merges'] as $m) {
			[$r1, $c1, $r2, $c2] = Cells::parseRange($m);
			$spans[Cells::ref($r1, $c1)] = [$c2 - $c1 + 1, $r2 - $r1 + 1];
			for ($r = $r1; $r <= $r2; $r++) {
				for ($c = $c1; $c <= $c2; $c++) {
					if ($r !== $r1 || $c !== $c1) {
						$covered[Cells::ref($r, $c)] = true;
					}
				}
			}
		}
		$out = '<table:table table:name="' . $esc($sheet['name']) . '" table:style-name="ta1">';
		// Columns, equal neighbours folded into one with a repeat count.
		$run = null;
		$runN = 0;
		$flush = static function () use (&$out, &$run, &$runN): void {
			if ($runN > 0) {
				$out .= '<table:table-column' . ($run !== '' ? ' table:style-name="' . $run . '"' : '')
					. ($runN > 1 ? ' table:number-columns-repeated="' . $runN . '"' : '') . ' table:default-cell-style-name="Default"/>';
			}
		};
		for ($c = 0; $c < $cols; $c++) {
			// A column the book has no width for is as wide as the screen shows it, not Calc's 2.258 cm.
			$st = $this->colStyle((int)($sheet['cols'][Cells::colName($c)] ?? Model::DEFAULT_COL_PX));
			if ($st === $run) {
				$runN++;
			} else {
				$flush();
				$run = $st;
				$runN = 1;
			}
		}
		$flush();
		for ($r = 0; $r < $rows; $r++) {
			$height = $sheet['rows'][(string)($r + 1)] ?? null;
			$out .= '<table:table-row' . ($height === null ? '' : ' table:style-name="' . $this->rowStyle($height) . '"') . '>';
			$empty = 0;
			for ($c = 0; $c < $cols; $c++) {
				$ref = Cells::ref($r, $c);
				if (isset($covered[$ref])) {
					$out .= self::emptyRun($empty) . '<table:covered-table-cell/>';
					$empty = 0;
					continue;
				}
				$cell = $sheet['cells'][$ref] ?? null;
				if ($cell === null && !isset($spans[$ref])) {
					$empty++;
					continue;
				}
				$out .= self::emptyRun($empty) . $this->cell($cell ?? [], $spans[$ref] ?? null);
				$empty = 0;
			}
			$out .= self::emptyRun($empty) . '</table:table-row>';
		}
		return $out . $this->namedExpressions($sheet['names'] ?? []) . '</table:table>';
	}

	/**
	 * Defined names as Calc writes them: a reference as a named range ($Sheet1.$A$1:.$B$5), anything
	 * else as a named expression; the base cell is A1 of the first sheet (the book keeps a relative
	 * reference relative to A1). '' when there are none.
	 *
	 * @param array<string, string> $names
	 */
	private function namedExpressions(array $names): string {
		if ($names === []) {
			return '';
		}
		$esc = self::esc(...);
		$first = $this->model['sheets'][0]['name'] ?? 'Sheet1';
		$base = '$' . (preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $first) ? $first : "'" . str_replace("'", "''", $first) . "'") . '.$A$1';
		$out = '<table:named-expressions>';
		foreach ($names as $name => $def) {
			$of = FormulaSyntax::toOds('=' . $def);
			// a single reference with its sheet: of:=[$Sheet1.$A$1:.$B$5]
			if (preg_match('/^of:=\[([^\[\]]+\.[^\[\]]+)\]$/', $of, $m) && !str_starts_with($m[1], '.')) {
				$out .= '<table:named-range table:name="' . $esc((string)$name) . '" table:base-cell-address="' . $esc($base) . '" table:cell-range-address="' . $esc($m[1]) . '"/>';
			} else {
				$out .= '<table:named-expression table:name="' . $esc((string)$name) . '" table:base-cell-address="' . $esc($base) . '" table:expression="' . $esc($of) . '"/>';
			}
		}
		return $out . '</table:named-expressions>';
	}

	private static function emptyRun(int $n): string {
		return $n === 0 ? '' : '<table:table-cell' . ($n > 1 ? ' table:number-columns-repeated="' . $n . '"' : '') . '/>';
	}

	private function cell(array $cell, ?array $span): string {
		$esc = self::esc(...);
		$attrs = '';
		$style = $this->cellStyle($cell);
		if ($style !== '') {
			$attrs .= ' table:style-name="' . $style . '"';
		}
		if (isset($cell['f'])) {
			$attrs .= ' table:formula="' . $esc(FormulaSyntax::toOds($cell['f'])) . '"';
			// an array formula: the range it fills, from this cell (Calc's number-matrix-*-spanned)
			if (isset($cell['a']) && ($box = Cells::parseRange($cell['a'])) !== null) {
				$attrs .= ' table:number-matrix-columns-spanned="' . ($box[3] - $box[1] + 1) . '" table:number-matrix-rows-spanned="' . ($box[2] - $box[0] + 1) . '"';
			}
		}
		$fmt = $cell['fmt'] ?? '';
		$t = $cell['t'] ?? null;
		$v = $cell['v'] ?? null;
		$paras = [];
		if ($t === 'n' && is_numeric($v)) {
			$v = (float)$v;
			$kind = self::kindOf($fmt);
			$attrs .= match ($kind) {
				'percentage' => ' office:value-type="percentage" office:value="' . Cells::number($v) . '" calcext:value-type="percentage"',
				'currency' => ' office:value-type="currency" office:currency="' . $esc(self::currencyOf($fmt)) . '" office:value="' . Cells::number($v) . '" calcext:value-type="currency"',
				'date' => ' office:value-type="date" office:date-value="' . Cells::isoOfSerial($v, str_contains(strtolower($fmt), 'h')) . '" calcext:value-type="date"',
				'time' => ' office:value-type="time" office:time-value="' . Cells::durationOfSerial($v) . '" calcext:value-type="time"',
				default => ' office:value-type="float" office:value="' . Cells::number($v) . '" calcext:value-type="float"',
			};
			$paras = [$cell['d'] ?? Cells::number($v)];
		} elseif ($t === 'b') {
			$attrs .= ' office:value-type="boolean" office:boolean-value="' . ($v ? 'true' : 'false') . '" calcext:value-type="boolean"';
			$paras = [$cell['d'] ?? ($v ? 'TRUE' : 'FALSE')];
		} elseif ($t === 'e') {
			// An error is what a formula came to; LibreOffice writes it as an empty string marked error.
			$attrs .= ' office:value-type="string" office:string-value="" calcext:value-type="error"';
			$paras = [(string)$v];
		} elseif ($t === 's' && is_string($v)) {
			$attrs .= ' office:value-type="string" calcext:value-type="string"';
			if (isset($cell['f'])) {
				$attrs .= ' office:string-value="' . $esc($v) . '"';
			}
			$paras = explode("\n", str_replace("\r\n", "\n", $v));
		}
		if ($span !== null) {
			$attrs .= ' table:number-columns-spanned="' . $span[0] . '" table:number-rows-spanned="' . $span[1] . '"';
		}
		$body = '';
		foreach ($paras as $p) {
			$body .= '<text:p>' . self::inline($p) . '</text:p>';
		}
		return '<table:table-cell' . $attrs . ($body === '' ? '/>' : '>' . $body . '</table:table-cell>');
	}

	/** Text with its spaces kept: runs of spaces and tabs as the format writes them. */
	private static function inline(string $text): string {
		$out = '';
		$parts = preg_split('/( {2,}|\t|^ )/', $text, -1, PREG_SPLIT_DELIM_CAPTURE | PREG_SPLIT_NO_EMPTY) ?: [];
		foreach ($parts as $p) {
			if ($p === "\t") {
				$out .= '<text:tab/>';
			} elseif (preg_match('/^ +$/', $p)) {
				$n = strlen($p);
				$out .= $n === 1 ? '<text:s/>' : ' <text:s text:c="' . ($n - 1) . '"/>';
			} else {
				$out .= self::esc($p);
			}
		}
		return $out;
	}

	/** What a format code makes of a number: percentage, currency, date, time or a plain float. */
	public static function kindOf(string $fmt): string {
		if ($fmt === '') {
			return 'float';
		}
		$bare = preg_replace('/"[^"]*"|\[[^\]]*\]/', '', $fmt) ?? $fmt;
		if (str_contains($bare, '%')) {
			return 'percentage';
		}
		if (preg_match('/[¥$€£\x{FFE5}]/u', $bare)) {
			return 'currency';
		}
		if (preg_match('/[0#]/', $bare)) {
			return 'float';
		}
		if (preg_match('/[ydg]|mmm/i', $bare) || preg_match('/m\/|\/m|年|月|日/iu', $bare)) {
			return 'date';
		}
		if (preg_match('/[hs]|\[h\]/i', $bare)) {
			return 'time';
		}
		return 'float';
	}

	private static function currencyOf(string $fmt): string {
		if (preg_match('/([¥$€£\x{FFE5}])/u', $fmt, $m)) {
			return match ($m[1]) { '¥', '￥' => 'JPY', '$' => 'USD', '€' => 'EUR', default => 'GBP' };
		}
		return '';
	}

	// ---- the styles ----

	private function cellStyle(array $cell): string {
		$s = $cell['s'] ?? [];
		$fmt = $cell['fmt'] ?? '';
		if ($s === [] && $fmt === '') {
			return '';
		}
		$key = json_encode([$s, $fmt]);
		if (!isset($this->cellStyles[$key])) {
			$this->cellStyles[$key] = 'ce' . (count($this->cellStyles) + 1);
			if (isset($s['font'])) {
				$this->fonts[$s['font']] = true;
			}
			if ($fmt !== '') {
				$this->numberStyle($fmt);
			}
		}
		return $this->cellStyles[$key];
	}

	private function numberStyle(string $fmt): string {
		if (!isset($this->numberStyles[$fmt])) {
			$name = 'N' . (count($this->numberStyles) + 1);
			$xml = NumberFormats::toOdsStyle($fmt, $name);
			$this->numberStyles[$fmt] = $xml === null ? '' : $name;
			$this->numberXml .= $xml ?? '';
		}
		return $this->numberStyles[$fmt];
	}

	private function colStyle(int $px): string {
		if (!isset($this->colStyles[$px])) {
			$this->colStyles[$px] = 'co' . (count($this->colStyles) + 1);
		}
		return $this->colStyles[$px];
	}

	private function rowStyle(int $px): string {
		if (!isset($this->rowStyles[$px])) {
			$this->rowStyles[$px] = 'ro' . (count($this->rowStyles) + 1);
		}
		return $this->rowStyles[$px];
	}

	private function automaticStyles(): string {
		$esc = self::esc(...);
		$out = '';
		foreach ($this->colStyles as $px => $name) {
			$out .= '<style:style style:name="' . $name . '" style:family="table-column"><style:table-column-properties fo:break-before="auto" style:column-width="' . Cells::cmOfPx((float)$px) . '"/></style:style>';
		}
		foreach ($this->rowStyles as $px => $name) {
			$out .= '<style:style style:name="' . $name . '" style:family="table-row"><style:table-row-properties style:row-height="' . Cells::cmOfPx((float)$px) . '" fo:break-before="auto" style:use-optimal-row-height="false"/></style:style>';
		}
		$out .= '<style:style style:name="ta1" style:family="table" style:master-page-name="Default"><style:table-properties table:display="true" style:writing-mode="lr-tb"/></style:style>';
		$out .= $this->numberXml;
		foreach ($this->cellStyles as $key => $name) {
			[$s, $fmt] = json_decode($key, true);
			$data = $fmt !== '' && ($this->numberStyles[$fmt] ?? '') !== '' ? ' style:data-style-name="' . $this->numberStyles[$fmt] . '"' : '';
			$out .= '<style:style style:name="' . $name . '" style:family="table-cell" style:parent-style-name="Default"' . $data . '>';
			$cellProps = '';
			if (isset($s['bg'])) {
				$cellProps .= ' fo:background-color="' . $s['bg'] . '"';
			}
			if (isset($s['va'])) {
				$cellProps .= ' style:vertical-align="' . $s['va'] . '"';
			}
			if (!empty($s['wrap'])) {
				$cellProps .= ' fo:wrap-option="wrap"';
			}
			if (isset($s['ha'])) {
				$cellProps .= ' style:text-align-source="fix" style:repeat-content="false"';
			}
			foreach (['bt' => 'top', 'br' => 'right', 'bb' => 'bottom', 'bl' => 'left'] as $key2 => $side) {
				if (isset($s[$key2]) && ($parts = Model::borderParts($s[$key2])) !== null) {
					[$w, $style, $colour] = $parts;
					$pt = match ($w) { 1 => '0.74pt', 2 => '1.5pt', default => '2.5pt' };
					$cellProps .= ' fo:border-' . $side . '="' . $pt . ' ' . ($style === 'dotted' ? 'dotted' : $style) . ' ' . $colour . '"';
				}
			}
			if ($cellProps !== '') {
				$out .= '<style:table-cell-properties' . $cellProps . '/>';
			}
			if (isset($s['ha'])) {
				$out .= '<style:paragraph-properties fo:text-align="' . match ($s['ha']) { 'left' => 'start', 'right' => 'end', 'justify' => 'justify', default => 'center' } . '"/>';
			}
			$text = '';
			if (!empty($s['b'])) {
				$text .= ' fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"';
			}
			if (!empty($s['i'])) {
				$text .= ' fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"';
			}
			if (!empty($s['u'])) {
				$text .= ' style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"';
			}
			if (!empty($s['strike'])) {
				$text .= ' style:text-line-through-style="solid" style:text-line-through-type="single"';
			}
			if (isset($s['color'])) {
				$text .= ' fo:color="' . $s['color'] . '"';
			}
			if (isset($s['size'])) {
				$pt = Cells::number($s['size']) . 'pt';
				$text .= ' fo:font-size="' . $pt . '" style:font-size-asian="' . $pt . '" style:font-size-complex="' . $pt . '"';
			}
			if (isset($s['font'])) {
				$text .= ' style:font-name="' . $esc($s['font']) . '" style:font-name-asian="' . $esc($s['font']) . '"';
			}
			if ($text !== '') {
				$out .= '<style:text-properties' . $text . '/>';
			}
			$out .= '</style:style>';
		}
		return $out;
	}

	private function fontDecls(): string {
		if ($this->fonts === []) {
			return '<office:font-face-decls/>';
		}
		$out = '<office:font-face-decls>';
		foreach (array_keys($this->fonts) as $font) {
			$out .= '<style:font-face style:name="' . self::esc($font) . '" svg:font-family="' . self::esc(str_contains($font, ' ') ? "'" . $font . "'" : $font) . '"/>';
		}
		return $out . '</office:font-face-decls>';
	}

	private function stylesXml(): string {
		return '<?xml version="1.0" encoding="UTF-8"?>' . "\n"
			. '<office:document-styles ' . self::NS . '>'
			. $this->fontDecls()
			// a book that limits General to so many decimals says so as Calc does (the default cell style's decimal-places)
			. '<office:styles><style:default-style style:family="table-cell">'
			. (isset($this->model['calc']['decimals']) ? '<style:table-cell-properties style:decimal-places="' . (int)$this->model['calc']['decimals'] . '"/>' : '')
			. '<style:paragraph-properties style:tab-stop-distance="1.25cm"/><style:text-properties fo:font-size="10pt"/></style:default-style>'
			. '<style:style style:name="Default" style:family="table-cell"/></office:styles>'
			. '<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties style:writing-mode="lr-tb"/></style:page-layout></office:automatic-styles>'
			. '<office:master-styles><style:master-page style:name="Default" style:page-layout-name="pm1"/></office:master-styles>'
			. '</office:document-styles>';
	}

	private static function metaXml(): string {
		return '<?xml version="1.0" encoding="UTF-8"?>' . "\n"
			. '<office:document-meta ' . self::NS . '><office:meta>'
			. '<meta:generator>CalcBase/0.0.1</meta:generator>'
			. '<meta:creation-date>' . gmdate('Y-m-d\TH:i:s') . '</meta:creation-date>'
			. '</office:meta></office:document-meta>';
	}

	/** Frozen panes and the active sheet, the way LibreOffice keeps them. */
	private function settingsXml(): string {
		$esc = self::esc(...);
		$active = $this->model['sheets'][$this->model['active']]['name'] ?? $this->model['sheets'][0]['name'];
		$tables = '';
		foreach ($this->model['sheets'] as $sheet) {
			if (!isset($sheet['freeze'])) {
				continue;
			}
			[$r, $c] = Cells::parseRef($sheet['freeze']);
			$tables .= '<config:config-item-map-entry config:name="' . $esc($sheet['name']) . '">'
				. '<config:config-item config:name="HorizontalSplitMode" config:type="short">' . ($c > 0 ? 2 : 0) . '</config:config-item>'
				. '<config:config-item config:name="VerticalSplitMode" config:type="short">' . ($r > 0 ? 2 : 0) . '</config:config-item>'
				. '<config:config-item config:name="HorizontalSplitPosition" config:type="int">' . $c . '</config:config-item>'
				. '<config:config-item config:name="VerticalSplitPosition" config:type="int">' . $r . '</config:config-item>'
				. '<config:config-item config:name="ActiveSplitRange" config:type="short">2</config:config-item>'
				. '<config:config-item config:name="PositionLeft" config:type="int">0</config:config-item>'
				. '<config:config-item config:name="PositionRight" config:type="int">' . $c . '</config:config-item>'
				. '<config:config-item config:name="PositionTop" config:type="int">0</config:config-item>'
				. '<config:config-item config:name="PositionBottom" config:type="int">' . $r . '</config:config-item>'
				. '</config:config-item-map-entry>';
		}
		return '<?xml version="1.0" encoding="UTF-8"?>' . "\n"
			. '<office:document-settings ' . self::NS . '><office:settings>'
			. '<config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry>'
			. '<config:config-item config:name="ViewId" config:type="string">view1</config:config-item>'
			. '<config:config-item-map-named config:name="Tables">' . $tables . '</config:config-item-map-named>'
			. '<config:config-item config:name="ActiveTable" config:type="string">' . $esc($active) . '</config:config-item>'
			. '</config:config-item-map-entry></config:config-item-map-indexed></config:config-item-set>'
			. '</office:settings></office:document-settings>';
	}

	// ---- the package ----

	/** @param array<string, string> $parts name => xml */
	private static function package(array $parts): string {
		$manifest = '<?xml version="1.0" encoding="UTF-8"?>' . "\n"
			. '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">'
			. '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="' . OdsFormat::MIME . '"/>';
		foreach (array_keys($parts) as $name) {
			$manifest .= '<manifest:file-entry manifest:full-path="' . $name . '" manifest:media-type="text/xml"/>';
		}
		$manifest .= '</manifest:manifest>';
		return ZipWriter::build(['mimetype' => OdsFormat::MIME] + $parts + ['META-INF/manifest.xml' => $manifest], 'mimetype');
	}

	public static function esc(string $s): string {
		return htmlspecialchars($s, ENT_XML1 | ENT_QUOTES, 'UTF-8');
	}
}
