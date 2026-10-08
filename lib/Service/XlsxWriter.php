<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * The model written as an .xlsx package (see XlsxFormat): the parts Excel and
 * LibreOffice need and no more -- content types, relationships, the workbook,
 * one worksheet per sheet, shared strings and a style sheet made of the unique
 * (format, style) pairs the cells use. Formulas go in as Excel writes them
 * (Sheet2!A1, commas) with their last value beside them.
 */
final class XlsxWriter {
	/** @var list<string> */
	private array $strings = [];
	/** @var array<string, int> */
	private array $stringIndex = [];
	/** @var array<string, int> json(fmt, s) => cellXfs index */
	private array $xfs = ['' => 0];
	/** @var list<string> xf xml */
	private array $xfXml = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
	/** @var array<string, int> */
	private array $fonts = [];
	/**
	 * The default font, as Calc writes its own XLSX files: Arial 10. Column widths
	 * are counted in its digit, which is the same in Excel and in every
	 * LibreOffice (Arial, or Liberation Sans drawn in its place).
	 */
	private array $fontXml = ['<font><sz val="' . XlsxFormat::WRITE_SIZE . '"/><name val="' . XlsxFormat::WRITE_FONT . '"/><family val="2"/></font>'];
	/** @var array<string, int> */
	private array $fills = [];
	private array $fillXml = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
	/** @var array<string, int> */
	private array $borders = [];
	private array $borderXml = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
	/** @var array<string, int> code => numFmtId */
	private array $numFmts = [];

	public function __construct(private array $model) {
	}

	public function bytes(): string {
		$names = $this->sheetNames();
		$sheets = [];
		foreach ($this->model['sheets'] as $i => $sheet) {
			$sheets[] = $this->worksheet($sheet, $i === $this->model['active']);
		}
		$parts = [
			'[Content_Types].xml' => $this->contentTypes(count($sheets)),
			'_rels/.rels' => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n"
				. '<Relationships xmlns="' . XlsxFormat::NS_PKG_REL . '">'
				. '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
				. '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
				. '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
				. '</Relationships>',
			'docProps/app.xml' => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n"
				. '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>CalcBase/0.0.1</Application></Properties>',
			'docProps/core.xml' => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n"
				. '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
				. '<dcterms:created xsi:type="dcterms:W3CDTF">' . gmdate('Y-m-d\TH:i:s\Z') . '</dcterms:created></cp:coreProperties>',
			'xl/workbook.xml' => $this->workbook($names),
			'xl/_rels/workbook.xml.rels' => $this->workbookRels(count($sheets)),
			'xl/styles.xml' => $this->styles(),
			'xl/sharedStrings.xml' => $this->sharedStrings(),
		];
		foreach ($sheets as $i => $xml) {
			$parts['xl/worksheets/sheet' . ($i + 1) . '.xml'] = $xml;
		}
		return ZipWriter::build($parts);
	}

	/** Sheet names as Excel allows them: no []:*?/\, 31 characters, each one different. */
	private function sheetNames(): array {
		$out = [];
		$seen = [];
		foreach ($this->model['sheets'] as $i => $sheet) {
			$name = trim(preg_replace('/[\[\]:*?\/\\\\]/u', '_', $sheet['name']) ?? '', "' ");
			$name = mb_substr($name === '' ? 'Sheet' . ($i + 1) : $name, 0, 31);
			$base = $name;
			for ($k = 2; isset($seen[mb_strtolower($name)]); $k++) {
				$name = mb_substr($base, 0, 31 - strlen(' (' . $k . ')')) . ' (' . $k . ')';
			}
			$seen[mb_strtolower($name)] = true;
			$out[] = $name;
		}
		return $out;
	}

	private function contentTypes(int $n): string {
		$out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n"
			. '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
			. '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
			. '<Default Extension="xml" ContentType="application/xml"/>'
			. '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
			. '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
			. '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
			. '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
			. '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>';
		for ($i = 1; $i <= $n; $i++) {
			$out .= '<Override PartName="/xl/worksheets/sheet' . $i . '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
		}
		return $out . '</Types>';
	}

	private function workbook(array $names): string {
		$out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n"
			. '<workbook xmlns="' . XlsxFormat::NS_MAIN . '" xmlns:r="' . XlsxFormat::NS_REL . '">'
			. '<workbookPr date1904="false"/>'
			. '<bookViews><workbookView activeTab="' . $this->model['active'] . '"/></bookViews><sheets>';
		foreach ($names as $i => $name) {
			$out .= '<sheet name="' . self::esc($name) . '" sheetId="' . ($i + 1) . '" r:id="rId' . ($i + 1) . '"/>';
		}
		$out .= '</sheets>';
		// the defined names, as Calc writes them (<definedName>; a sheet's own with its localSheetId)
		$defined = '';
		foreach ($this->model['names'] ?? [] as $name => $def) {
			$defined .= '<definedName name="' . self::esc((string)$name) . '">' . self::esc(FormulaSyntax::toXlsx('=' . $def)) . '</definedName>';
		}
		foreach ($this->model['sheets'] as $i => $sheet) {
			foreach ($sheet['names'] ?? [] as $name => $def) {
				$defined .= '<definedName localSheetId="' . $i . '" name="' . self::esc((string)$name) . '">' . self::esc(FormulaSyntax::toXlsx('=' . $def)) . '</definedName>';
			}
		}
		if ($defined !== '') {
			$out .= '<definedNames>' . $defined . '</definedNames>';
		}
		return $out . '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
	}

	private function workbookRels(int $n): string {
		$out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n" . '<Relationships xmlns="' . XlsxFormat::NS_PKG_REL . '">';
		for ($i = 1; $i <= $n; $i++) {
			$out .= '<Relationship Id="rId' . $i . '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' . $i . '.xml"/>';
		}
		$out .= '<Relationship Id="rId' . ($n + 1) . '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
		$out .= '<Relationship Id="rId' . ($n + 2) . '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>';
		return $out . '</Relationships>';
	}

	// ---- one worksheet ----

	private function worksheet(array $sheet, bool $active): string {
		[$rows, $cols] = Cells::extent($sheet['cells'], $sheet['merges']);
		$out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n"
			. '<worksheet xmlns="' . XlsxFormat::NS_MAIN . '" xmlns:r="' . XlsxFormat::NS_REL . '">'
			. '<dimension ref="' . ($rows === 0 ? 'A1' : Cells::rangeName(0, 0, $rows - 1, $cols - 1)) . '"/>'
			. '<sheetViews><sheetView workbookViewId="0"' . ($active ? ' tabSelected="1"' : '') . (($sheet['grid'] ?? true) ? '' : ' showGridLines="0"');
		if (isset($sheet['freeze'])) {
			[$fr, $fc] = Cells::parseRef($sheet['freeze']);
			$out .= '><pane' . ($fc > 0 ? ' xSplit="' . $fc . '"' : '') . ($fr > 0 ? ' ySplit="' . $fr . '"' : '')
				. ' topLeftCell="' . $sheet['freeze'] . '" activePane="' . ($fr > 0 && $fc > 0 ? 'bottomRight' : ($fr > 0 ? 'bottomLeft' : 'topRight')) . '" state="frozen"/></sheetView>';
		} else {
			$out .= '/>';
		}
		// A column with no width of its own is as wide as the screen shows it.
		$out .= '</sheetViews><sheetFormatPr defaultColWidth="' . Cells::number(round(XlsxFormat::charsOfPx(Model::DEFAULT_COL_PX), 4)) . '" defaultRowHeight="18" customHeight="1"/>';
		if ($sheet['cols'] !== []) {
			$out .= '<cols>';
			$list = [];
			foreach ($sheet['cols'] as $col => $px) {
				$list[Cells::colIndex($col) + 1] = $px;
			}
			ksort($list);
			foreach ($list as $n => $px) {
				$out .= '<col min="' . $n . '" max="' . $n . '" width="' . Cells::number(round(XlsxFormat::charsOfPx((float)$px), 4)) . '" customWidth="1"/>';
			}
			$out .= '</cols>';
		}
		$out .= '<sheetData>';
		$covered = [];
		foreach ($sheet['merges'] as $m) {
			[$r1, $c1, $r2, $c2] = Cells::parseRange($m);
			for ($r = $r1; $r <= $r2; $r++) {
				for ($c = $c1; $c <= $c2; $c++) {
					if ($r !== $r1 || $c !== $c1) {
						$covered[Cells::ref($r, $c)] = true;
					}
				}
			}
		}
		for ($r = 0; $r < $rows; $r++) {
			$cells = '';
			for ($c = 0; $c < $cols; $c++) {
				$ref = Cells::ref($r, $c);
				$cell = $sheet['cells'][$ref] ?? null;
				if ($cell === null || isset($covered[$ref])) {
					continue;
				}
				$cells .= $this->cell($cell, $ref);
			}
			$height = $sheet['rows'][(string)($r + 1)] ?? null;
			if ($cells === '' && $height === null) {
				continue;
			}
			$out .= '<row r="' . ($r + 1) . '"' . ($height === null ? '' : ' ht="' . Cells::number(round($height * 72 / 96, 2)) . '" customHeight="1"') . '>' . $cells . '</row>';
		}
		$out .= '</sheetData>';
		if ($sheet['merges'] !== []) {
			$out .= '<mergeCells count="' . count($sheet['merges']) . '">';
			foreach ($sheet['merges'] as $m) {
				$out .= '<mergeCell ref="' . $m . '"/>';
			}
			$out .= '</mergeCells>';
		}
		return $out . '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
	}

	private function cell(array $cell, string $ref): string {
		$s = $this->xf($cell);
		$attrs = ' r="' . $ref . '"' . ($s > 0 ? ' s="' . $s . '"' : '');
		$t = $cell['t'] ?? null;
		$v = $cell['v'] ?? null;
		$f = '';
		if (isset($cell['f'])) {
			// an array formula says the range it fills (<f t="array" ref="C63:C63">)
			$box = isset($cell['a']) ? Cells::parseRange($cell['a']) : null;
			$f = ($box !== null ? '<f t="array" ref="' . Cells::rangeName(...$box) . '">' : '<f>') . self::esc(FormulaSyntax::toXlsx($cell['f'])) . '</f>';
		}
		if ($t === 'n' && is_numeric($v)) {
			return '<c' . $attrs . '>' . $f . '<v>' . Cells::number((float)$v) . '</v></c>';
		}
		if ($t === 'b') {
			return '<c' . $attrs . ' t="b">' . $f . '<v>' . ($v ? 1 : 0) . '</v></c>';
		}
		if ($t === 'e') {
			return '<c' . $attrs . ' t="e">' . $f . '<v>' . self::esc((string)$v) . '</v></c>';
		}
		if ($t === 's' && is_string($v)) {
			if ($f !== '') {
				return '<c' . $attrs . ' t="str">' . $f . '<v>' . self::esc($v) . '</v></c>';
			}
			return '<c' . $attrs . ' t="s"><v>' . $this->string($v) . '</v></c>';
		}
		return '<c' . $attrs . '>' . $f . '</c>';
	}

	private function string(string $s): int {
		if (!isset($this->stringIndex[$s])) {
			$this->stringIndex[$s] = count($this->strings);
			$this->strings[] = $s;
		}
		return $this->stringIndex[$s];
	}

	private function sharedStrings(): string {
		$out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n"
			. '<sst xmlns="' . XlsxFormat::NS_MAIN . '" count="' . count($this->strings) . '" uniqueCount="' . count($this->strings) . '">';
		foreach ($this->strings as $s) {
			$out .= '<si><t xml:space="preserve">' . self::esc(str_replace("\r\n", "\n", $s)) . '</t></si>';
		}
		return $out . '</sst>';
	}

	// ---- styles ----

	private function xf(array $cell): int {
		$s = $cell['s'] ?? [];
		$fmt = $cell['fmt'] ?? '';
		if ($s === [] && $fmt === '') {
			return 0;
		}
		$key = json_encode([$s, $fmt]);
		if (isset($this->xfs[$key])) {
			return $this->xfs[$key];
		}
		$numFmtId = 0;
		if ($fmt !== '') {
			$numFmtId = NumberFormats::xlsxBuiltinId($fmt) ?? $this->numFmt($fmt);
		}
		$fontId = $this->font($s);
		$fillId = isset($s['bg']) ? $this->fill($s['bg']) : 0;
		$borderId = $this->border($s);
		$align = '';
		if (isset($s['ha'])) {
			$align .= ' horizontal="' . $s['ha'] . '"';
		}
		if (isset($s['va'])) {
			$align .= ' vertical="' . ($s['va'] === 'middle' ? 'center' : $s['va']) . '"';
		}
		if (!empty($s['wrap'])) {
			$align .= ' wrapText="1"';
		}
		$xml = '<xf numFmtId="' . $numFmtId . '" fontId="' . $fontId . '" fillId="' . $fillId . '" borderId="' . $borderId . '" xfId="0"'
			. ($numFmtId > 0 ? ' applyNumberFormat="1"' : '') . ($fontId > 0 ? ' applyFont="1"' : '') . ($fillId > 0 ? ' applyFill="1"' : '')
			. ($borderId > 0 ? ' applyBorder="1"' : '') . ($align !== '' ? ' applyAlignment="1"><alignment' . $align . '/></xf>' : '/>');
		$this->xfs[$key] = count($this->xfXml);
		$this->xfXml[] = $xml;
		return $this->xfs[$key];
	}

	private function numFmt(string $code): int {
		if (!isset($this->numFmts[$code])) {
			$this->numFmts[$code] = 164 + count($this->numFmts);
		}
		return $this->numFmts[$code];
	}

	private function font(array $s): int {
		$keys = array_intersect_key($s, array_flip(['b', 'i', 'u', 'strike', 'color', 'font', 'size']));
		if ($keys === []) {
			return 0;
		}
		$key = json_encode($keys);
		if (!isset($this->fonts[$key])) {
			$xml = '<font>' . (!empty($s['b']) ? '<b/>' : '') . (!empty($s['i']) ? '<i/>' : '') . (!empty($s['u']) ? '<u/>' : '') . (!empty($s['strike']) ? '<strike/>' : '')
				. '<sz val="' . Cells::number($s['size'] ?? XlsxFormat::WRITE_SIZE) . '"/>'
				. (isset($s['color']) ? '<color rgb="FF' . strtoupper(substr($s['color'], 1)) . '"/>' : '')
				. '<name val="' . self::esc($s['font'] ?? XlsxFormat::WRITE_FONT) . '"/><family val="2"/></font>';
			$this->fonts[$key] = count($this->fontXml);
			$this->fontXml[] = $xml;
		}
		return $this->fonts[$key];
	}

	private function fill(string $bg): int {
		if (!isset($this->fills[$bg])) {
			$this->fills[$bg] = count($this->fillXml);
			$this->fillXml[] = '<fill><patternFill patternType="solid"><fgColor rgb="FF' . strtoupper(substr($bg, 1)) . '"/><bgColor indexed="64"/></patternFill></fill>';
		}
		return $this->fills[$bg];
	}

	private function border(array $s): int {
		$sides = array_intersect_key($s, array_flip(['bl', 'br', 'bt', 'bb']));
		if ($sides === []) {
			return 0;
		}
		$key = json_encode($sides);
		if (!isset($this->borders[$key])) {
			$xml = '<border>';
			foreach (['bl' => 'left', 'br' => 'right', 'bt' => 'top', 'bb' => 'bottom'] as $k => $side) {
				$parts = isset($s[$k]) ? Model::borderParts($s[$k]) : null;
				if ($parts === null) {
					$xml .= '<' . $side . '/>';
					continue;
				}
				[$w, $style, $colour] = $parts;
				$name = match ($style) {
					'dashed' => $w >= 2 ? 'mediumDashed' : 'dashed',
					'dotted' => 'dotted',
					'double' => 'double',
					default => $w >= 3 ? 'thick' : ($w === 2 ? 'medium' : 'thin'),
				};
				$xml .= '<' . $side . ' style="' . $name . '"><color rgb="FF' . strtoupper(substr($colour, 1)) . '"/></' . $side . '>';
			}
			$this->borders[$key] = count($this->borderXml);
			$this->borderXml[] = $xml . '<diagonal/></border>';
		}
		return $this->borders[$key];
	}

	private function styles(): string {
		$out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n" . '<styleSheet xmlns="' . XlsxFormat::NS_MAIN . '">';
		if ($this->numFmts !== []) {
			$out .= '<numFmts count="' . count($this->numFmts) . '">';
			foreach ($this->numFmts as $code => $id) {
				$out .= '<numFmt numFmtId="' . $id . '" formatCode="' . self::esc($code) . '"/>';
			}
			$out .= '</numFmts>';
		}
		$out .= '<fonts count="' . count($this->fontXml) . '">' . implode('', $this->fontXml) . '</fonts>';
		$out .= '<fills count="' . count($this->fillXml) . '">' . implode('', $this->fillXml) . '</fills>';
		$out .= '<borders count="' . count($this->borderXml) . '">' . implode('', $this->borderXml) . '</borders>';
		$out .= '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>';
		$out .= '<cellXfs count="' . count($this->xfXml) . '">' . implode('', $this->xfXml) . '</cellXfs>';
		$out .= '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>';
		return $out . '</styleSheet>';
	}

	public static function esc(string $s): string {
		return htmlspecialchars($s, ENT_XML1 | ENT_QUOTES, 'UTF-8');
	}
}
