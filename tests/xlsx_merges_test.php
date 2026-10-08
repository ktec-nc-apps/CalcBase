<?php
/**
 * "Centre across selection" and justified cells, as Calc takes them in
 * (CalcBase BUGS #30).
 *
 * Calc has no "centre across selection": reading an XLSX file, it makes a cell
 * so aligned with something in it, and the empty cells so aligned right after
 * it on the same row, one merged cell (oox SheetDataBuffer: setCellFormat,
 * MergedRange::tryExpand; "fill" alike). The Statistics Bureau's table 1 has
 * its heading AI5 so over AJ5; CalcBase lost that merge. And Calc reads both
 * "justify" and "distributed" as justified, which CalcBase made centred (or
 * nothing, from an ODS file).
 *
 *   - a run of centre-across cells is one merge; a run broken by a filled
 *     cell, an other alignment or a gap is not longer; a lone one is none;
 *   - "fill" runs the same; a run over a merge of the file's own undoes it, as in Calc;
 *   - justify and distributed are justify; ODS fo:text-align="justify" too;
 *   - written as ODS and XLSX and opened by LibreOffice: the merge, and the
 *     cell justified.
 *
 * Run: php tests/xlsx_merges_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/lo_helper.php';

use OCA\CalcBase\Service\Model;
use OCA\CalcBase\Service\OdsFormat;
use OCA\CalcBase\Service\XlsxFormat;
use OCA\CalcBase\Service\ZipReader;
use OCA\CalcBase\Service\ZipWriter;

/** A one-sheet XLSX: cellXfs 1 centre-across, 2 justify, 3 distributed, 4 fill, 5 left. */
function xlsxWith(string $rows, string $merges = ''): string {
	$main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
	$xf = static fn (string $h): string => '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="' . $h . '"/></xf>';
	return ZipWriter::build([
		'[Content_Types].xml' => '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
		'_rels/.rels' => '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
		'xl/workbook.xml' => '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="' . $main . '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
		'xl/_rels/workbook.xml.rels' => '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
		'xl/styles.xml' => '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="' . $main . '"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
			. '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
			. $xf('centerContinuous') . $xf('justify') . $xf('distributed') . $xf('fill') . $xf('left') . '</cellXfs></styleSheet>',
		'xl/sharedStrings.xml' => '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="' . $main . '"><si><t>Heading</t></si><si><t>x</t></si></sst>',
		'xl/worksheets/sheet1.xml' => '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="' . $main . '"><sheetData>' . $rows . '</sheetData>' . $merges . '</worksheet>',
	]);
}
$s = static fn (string $ref, int $xf, bool $text = false): string => '<c r="' . $ref . '" s="' . $xf . '"' . ($text ? ' t="s"><v>0</v></c>' : '/>');

echo "--- centre across selection ---\n";
$rows = '<row r="2">' . $s('B2', 1, true) . $s('C2', 1) . $s('D2', 1) . $s('E2', 5) . $s('F2', 1) . '</row>'   // B2:D2; F2 alone is nothing
	. '<row r="3">' . $s('B3', 1, true) . $s('C3', 1, true) . $s('D3', 1) . '</row>'                       // B3 alone, C3:D3
	. '<row r="4">' . $s('B4', 1, true) . $s('D4', 1) . '</row>'                                          // a gap: nothing
	. '<row r="5">' . $s('B5', 4, true) . $s('C5', 4) . $s('D5', 1) . '</row>'                            // fill B5:C5; D5 is another alignment
	. '<row r="6">' . $s('B6', 1, true) . $s('C6', 1) . $s('D6', 1) . '</row>'                            // over a merge of the file's own: the run wins
	. '<row r="7">' . $s('A7', 2, true) . $s('B7', 3, true) . $s('C7', 5, true) . '</row>';
$m = attempt('read', static fn () => XlsxFormat::import(new ZipReader(xlsxWith($rows, '<mergeCells count="1"><mergeCell ref="C6:C7"/></mergeCells>'))));
$merges = $m['sheets'][0]['merges'] ?? [];
sort($merges);
// LibreOffice 24.2 made of this very file B2:D2, B5:C5, B6:D6, C3:D3 (its own C6:C7 undone by the run B6:D6)
check('the runs are merged as Calc merges them: B2:D2, B5:C5, B6:D6, C3:D3', $merges === ['B2:D2', 'B5:C5', 'B6:D6', 'C3:D3'], json_encode($merges));
$cells = $m['sheets'][0]['cells'] ?? [];
check('the heading is centred', ($cells['B2']['s']['ha'] ?? '') === 'center', json_encode($cells['B2'] ?? null));

echo "--- justified ---\n";
check('"justify" is justify', ($cells['A7']['s']['ha'] ?? '') === 'justify', json_encode($cells['A7'] ?? null));
check('"distributed" is justify, as Calc reads it', ($cells['B7']['s']['ha'] ?? '') === 'justify', json_encode($cells['B7'] ?? null));
check('a book may say so', (Model::style(['ha' => 'justify'])['ha'] ?? '') === 'justify');
$book = Model::clean(['sheets' => [['name' => 'S', 'cells' => ['A1' => ['v' => 'Heading', 't' => 's', 's' => ['ha' => 'center']], 'A2' => ['v' => 'text', 't' => 's', 's' => ['ha' => 'justify']]], 'merges' => ['A1:C1']]], 'active' => 0]);
$ods = OdsFormat::export($book);
$xlsx = XlsxFormat::export($book);
check('ODS: written fo:text-align="justify", and read back', (OdsFormat::import(new ZipReader($ods))['sheets'][0]['cells']['A2']['s']['ha'] ?? '') === 'justify');
check('XLSX: written horizontal="justify", and read back', (XlsxFormat::import(new ZipReader($xlsx))['sheets'][0]['cells']['A2']['s']['ha'] ?? '') === 'justify');

echo "--- opened by LibreOffice ---\n";
if (!sofficeAvailable()) {
	echo "SKIP  soffice is not installed here\n";
} else {
	foreach (['ods' => $ods, 'xlsx' => $xlsx] as $ext => $bytes) {
		$dir = sys_get_temp_dir() . '/calcbase-merge-' . getmypid();
		@mkdir($dir, 0700, true);
		file_put_contents("$dir/m.$ext", $bytes);
		shell_exec('timeout 180 soffice --headless -env:UserInstallation=file://' . loProfile() . ' --convert-to fods --outdir ' . escapeshellarg($dir) . ' ' . escapeshellarg("$dir/m.$ext") . ' 2>&1');
		$fods = (string)@file_get_contents("$dir/m.fods");
		array_map('unlink', glob("$dir/*") ?: []);
		@rmdir($dir);
		check("$ext: the heading spans three columns in Calc", (bool)preg_match('/<table:table-cell[^>]*table:number-columns-spanned="3"[^>]*>\s*<text:p>Heading/', $fods), substr($fods, 0, 0));
		// the cell "text" has a style whose paragraph is justified
		$styleOk = false;
		if (preg_match('/<table:table-cell table:style-name="([^"]+)"[^>]*>\s*<text:p>text</', $fods, $mm)) {
			$styleOk = (bool)preg_match('/<style:style style:name="' . preg_quote($mm[1], '/') . '"[^>]*>(?:(?!<\/style:style>).)*fo:text-align="justify"/s', $fods);
		}
		check("$ext: the cell is justified in Calc", $styleOk);
	}
}

finish();
