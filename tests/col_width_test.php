<?php
/**
 * Column widths as Calc has them (CalcBase BUGS #26).
 *
 * An XLSX width is a count of characters -- of the widest digit of the
 * workbook's default font -- and Calc makes a length of it with that digit as
 * its fonts draw it. CalcBase took every character as 7 pixels and added 5,
 * whatever the font: a Japanese government table in Terminal 14 came in at
 * three quarters of its width, a sheet with no widths of its own at Calc's ODS
 * default instead of its own, a hidden column lost its width, and CalcBase's
 * own XLSX came out 12% wider than the book.
 *
 * The lengths below are what LibreOffice 24.2 on this server showed for the
 * same files (measured 2026-10-05, soffice --convert-to fods), in millimetres;
 * a pixel here is 1/96 inch, so ±0.2 mm is the rounding to whole pixels.
 *
 *   - reading: 10 characters in each of six default fonts; the default width
 *     of a sheet (none given, baseColWidth, defaultColWidth); a hidden column;
 *   - writing: a book's widths written as XLSX and as ODS and opened by
 *     LibreOffice come out as the book has them; a column the book gives no
 *     width comes out as wide as the screen shows it (80 px), in both.
 *
 * Run: php tests/col_width_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/lo_helper.php';

use OCA\CalcBase\Service\Cells;
use OCA\CalcBase\Service\Model;
use OCA\CalcBase\Service\OdsFormat;
use OCA\CalcBase\Service\XlsxFormat;
use OCA\CalcBase\Service\ZipReader;
use OCA\CalcBase\Service\ZipWriter;

/** A one-sheet XLSX whose default font is $font $size, with the <sheetFormatPr> and <cols> given. */
function xlsx(string $font, float $size, string $formatPr, string $cols): string {
	$main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
	return ZipWriter::build([
		'[Content_Types].xml' => '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
		'_rels/.rels' => '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
		'xl/workbook.xml' => '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="' . $main . '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
		'xl/_rels/workbook.xml.rels' => '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
		// a second font first in the list, to show the "Normal" style's font is the one that counts
		'xl/styles.xml' => '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="' . $main . '"><fonts count="2"><font><sz val="20"/><name val="DejaVu Sans"/></font><font><sz val="' . $size . '"/><name val="' . htmlspecialchars($font) . '"/></font></fonts>'
			. '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
			. '<cellStyleXfs count="1"><xf numFmtId="0" fontId="1" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs>'
			. '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
		'xl/worksheets/sheet1.xml' => '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="' . $main . '">' . $formatPr . $cols
			. '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>1</v></c><c r="C1"><v>1</v></c><c r="D1"><v>1</v></c></row></sheetData></worksheet>',
	]);
}

$mm = static fn (int $px): float => $px * 25.4 / 96;
$near = static fn (int $px, float $want): bool => abs($px * 25.4 / 96 - $want) <= 0.2;

echo "--- 10 characters of the default font ---\n";
// LibreOffice's lengths for a column 10 wide (1 wide for B) in each font.
foreach ([
	['Calibri', 11, 22.23, 2.22], ['Arial', 10, 19.58, 1.96], ['Terminal', 14, 29.63, 2.96],
	['ＭＳ 明朝', 11, 21.70, 2.17], ['Times New Roman', 11, 19.40, 1.94], ['DejaVu Sans', 10, 22.40, 2.24],
	['ＭＳ Ｐゴシック', 11, 22.23, 2.22], ['游ゴシック', 11, 22.23, 2.22],
] as [$font, $size, $ten, $one]) {
	$m = attempt($font, static fn () => XlsxFormat::import(new ZipReader(xlsx($font, $size, '<sheetFormatPr defaultRowHeight="15"/>', '<cols><col min="1" max="1" width="10" customWidth="1"/><col min="2" max="2" width="1" customWidth="1"/></cols>'))));
	$cols = $m['sheets'][0]['cols'] ?? [];
	check("$font $size: 10 characters are $ten mm, 1 is $one mm", $near($cols['A'] ?? 0, $ten) && $near($cols['B'] ?? 0, $one), sprintf('%.2f / %.2f mm', $mm($cols['A'] ?? 0), $mm($cols['B'] ?? 0)));
}

echo "--- the sheet's default width, for the columns in use the file gives none ---\n";
foreach ([
	['no default given (8 digits and 5 pixels)', '<sheetFormatPr defaultRowHeight="15"/>', 19.10],
	['baseColWidth="10"', '<sheetFormatPr baseColWidth="10" defaultRowHeight="15"/>', 23.55],
	['defaultColWidth="10.625"', '<sheetFormatPr defaultColWidth="10.625" defaultRowHeight="15"/>', 23.62],
] as [$label, $pr, $want]) {
	$m = attempt($label, static fn () => XlsxFormat::import(new ZipReader(xlsx('Calibri', 11, $pr, ''))));
	$cols = $m['sheets'][0]['cols'] ?? [];
	check("Calibri 11, $label: $want mm, A to D", count($cols) === 4 && $near($cols['A'] ?? 0, $want) && $near($cols['D'] ?? 0, $want), json_encode($cols) . sprintf(' = %.2f mm', $mm($cols['A'] ?? 0)));
}
$m = attempt('hidden', static fn () => XlsxFormat::import(new ZipReader(xlsx('Terminal', 14, '<sheetFormatPr defaultColWidth="10.625" defaultRowHeight="12"/>', '<cols><col min="1" max="1" width="3.5" hidden="1" customWidth="1"/></cols>'))));
// Calc keeps a hidden column's width (10.4 mm for the Statistics Bureau's table 1, column A)
check('a hidden column keeps its width (3.5 of Terminal 14: 10.37 mm)', $near($m['sheets'][0]['cols']['A'] ?? 0, 10.37), json_encode($m['sheets'][0]['cols'] ?? null));

echo "--- a book's widths written out, opened by LibreOffice ---\n";
/** @return list<float> the first sheet's column widths in mm, as LibreOffice reads the file */
function loWidths(string $bytes, string $ext): array {
	$dir = sys_get_temp_dir() . '/calcbase-colw-' . getmypid();
	@mkdir($dir, 0700, true);
	file_put_contents("$dir/w.$ext", $bytes);
	shell_exec('timeout 180 soffice --headless -env:UserInstallation=file://' . loProfile() . ' --convert-to fods --outdir ' . escapeshellarg($dir) . ' ' . escapeshellarg("$dir/w.$ext") . ' 2>&1');
	$doc = new DOMDocument();
	$ok = @$doc->load("$dir/w.fods");
	array_map('unlink', glob("$dir/*") ?: []);
	@rmdir($dir);
	if (!$ok) {
		return [];
	}
	$x = new DOMXPath($doc);
	$x->registerNamespace('style', 'urn:oasis:names:tc:opendocument:xmlns:style:1.0');
	$x->registerNamespace('table', 'urn:oasis:names:tc:opendocument:xmlns:table:1.0');
	$width = [];
	foreach ($x->query('//style:style[@style:family="table-column"]') as $st) {
		$p = $x->query('style:table-column-properties', $st)->item(0);
		// in whatever unit the profile writes (cm, or in for an English one)
		$width[$st->getAttributeNS('urn:oasis:names:tc:opendocument:xmlns:style:1.0', 'name')] = (Cells::pxOfLength($p->getAttributeNS('urn:oasis:names:tc:opendocument:xmlns:style:1.0', 'column-width')) ?? 0.0) * 25.4 / 96;
	}
	$out = [];
	foreach ($x->query('(//table:table)[1]/table:table-column') as $col) {
		$n = max(1, (int)($col->getAttributeNS('urn:oasis:names:tc:opendocument:xmlns:table:1.0', 'number-columns-repeated') ?: 1));
		for ($i = 0; $i < $n && count($out) < 8; $i++) {
			$out[] = $width[$col->getAttributeNS('urn:oasis:names:tc:opendocument:xmlns:table:1.0', 'style-name')] ?? 0.0;
		}
	}
	return $out;
}
if (!sofficeAvailable()) {
	echo "SKIP  soffice is not installed here\n";
} else {
	$cells = ['A1' => ['v' => 1, 't' => 'n'], 'E1' => ['v' => 'x', 't' => 's', 's' => ['b' => 1]]];
	$book = Model::clean(['sheets' => [['name' => 'S', 'cells' => $cells, 'cols' => ['A' => 85, 'B' => 182, 'C' => 30, 'D' => 400]]], 'active' => 0]);
	foreach (['xlsx' => XlsxFormat::export($book), 'ods' => OdsFormat::export($book)] as $ext => $bytes) {
		$w = loWidths($bytes, $ext);
		$got = implode(' ', array_map(static fn ($v) => sprintf('%.2f', $v), $w));
		check("$ext: 85, 182, 30 and 400 pixels are 22.49, 48.15, 7.94 and 105.83 mm in Calc", count($w) >= 5 && abs($w[0] - 22.49) <= 0.3 && abs($w[1] - 48.15) <= 0.3 && abs($w[2] - 7.94) <= 0.3 && abs($w[3] - 105.83) <= 0.3, $got);
		// as wide as the screen shows it (80 px, DEF_COL_W): the gate found the Statistics Bureau's
		// columns of exactly 80 px come out 22.6 mm in Calc, as the screen leaves them unset
		check("$ext: a column the book gives no width is as wide as on the screen, 80 px = 21.17 mm", count($w) >= 5 && abs($w[4] - 21.17) <= 0.3, $got);
	}
	// and read back by CalcBase, the same pixels
	$again = XlsxFormat::import(new ZipReader(XlsxFormat::export($book)));
	check('xlsx read back by CalcBase: the same pixels, and none for the column that had none', ($again['sheets'][0]['cols'] ?? null) === ['A' => 85, 'B' => 182, 'C' => 30, 'D' => 400], json_encode($again['sheets'][0]['cols'] ?? null));
	$again = OdsFormat::import(new ZipReader(OdsFormat::export($book)));
	check('ods read back by CalcBase: the same', ($again['sheets'][0]['cols'] ?? null) === ['A' => 85, 'B' => 182, 'C' => 30, 'D' => 400], json_encode($again['sheets'][0]['cols'] ?? null));
}

finish();
