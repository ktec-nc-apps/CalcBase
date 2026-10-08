<?php
/**
 * ODS files LibreOffice wrote are taken in, however far their empty cells are
 * said to repeat (CalcBase BUGS #3).
 *
 * LibreOffice writes the rest of a sheet as a run to the last row and column --
 * number-rows-repeated="1048534" of number-columns-repeated="1024" -- and a
 * column's default style rides on every empty cell of it. Each such empty cell
 * was taken in as a cell, and files of 15-36 KB were refused as having "more
 * than 1000000 cells", in English.
 *
 *   - an empty cell whose style shows nothing while it is empty (a font, an
 *     alignment) is not a cell, from its own style or its column's;
 *   - an empty cell with a fill or a border is kept where it is, unless it runs
 *     on for more than 84 rows or columns -- the count at which Calc stops its
 *     used area (SC_VISATTR_STOP);
 *   - cells with something in them are kept however they repeat, and merges too;
 *   - the two LibreOffice test files the gate found (fixtures/lo_functions.ods and
 *     fixtures/lo_formula-across-sheets.ods: LibreOffice core,
 *     sc/qa/unit/data/ods/, MPL-2.0) come in, with the cells Calc shows;
 *   - every reason an import is refused for is a sentence with a Japanese
 *     translation in calcbase-l10n-ja-server.json (the screen looks it up as it
 *     stands, so a sentence put together from numbers is never translated).
 *
 * Run: php tests/ods_repeat_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';

use OCA\CalcBase\Service\Model;
use OCA\CalcBase\Service\OdsFormat;
use OCA\CalcBase\Service\ZipReader;
use OCA\CalcBase\Service\ZipWriter;

/** An .ods package around one table, with the automatic styles given. */
function ods(string $styles, string $table): string {
	$ns = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" office:version="1.3"';
	$content = '<?xml version="1.0" encoding="UTF-8"?><office:document-content ' . $ns . '><office:automatic-styles>' . $styles . '</office:automatic-styles>'
		. '<office:body><office:spreadsheet><table:table table:name="S">' . $table . '</table:table></office:spreadsheet></office:body></office:document-content>';
	return ZipWriter::build(['mimetype' => OdsFormat::MIME, 'content.xml' => $content], 'mimetype');
}

$styles = '<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="2.258cm"/></style:style>'
	. '<style:style style:name="font" style:family="table-cell"><style:text-properties style:font-name="Liberation Sans" fo:font-size="10pt"/></style:style>'
	. '<style:style style:name="mid" style:family="table-cell"><style:table-cell-properties style:vertical-align="middle"/></style:style>'
	. '<style:style style:name="fill" style:family="table-cell"><style:table-cell-properties fo:background-color="#ffff00"/></style:style>'
	. '<style:style style:name="box" style:family="table-cell"><style:table-cell-properties fo:border="0.74pt solid #000000"/></style:style>';
$table = '<table:table-column table:style-name="co1" table:number-columns-repeated="1024" table:default-cell-style-name="font"/>'
	// 1: a value, a yellow band of two, then yellow to the last column
	. '<table:table-row><table:table-cell office:value-type="string"><text:p>x</text:p></table:table-cell>'
	. '<table:table-cell table:style-name="fill" table:number-columns-repeated="2"/><table:table-cell table:style-name="fill" table:number-columns-repeated="1021"/></table:table-row>'
	// 2: a number, a boxed empty cell, a merge over empty cells
	. '<table:table-row><table:table-cell office:value-type="float" office:value="5"><text:p>5</text:p></table:table-cell><table:table-cell table:style-name="box"/>'
	. '<table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="1"/><table:covered-table-cell/><table:table-cell table:number-columns-repeated="1020"/></table:table-row>'
	// 3-65517: empty cells centred vertically -- nothing to see
	. '<table:table-row table:number-rows-repeated="65515"><table:table-cell table:style-name="mid" table:number-columns-repeated="246"/></table:table-row>'
	// three rows of a yellow band of two
	. '<table:table-row table:number-rows-repeated="3"><table:table-cell table:style-name="fill" table:number-columns-repeated="2"/><table:table-cell table:number-columns-repeated="1022"/></table:table-row>'
	// two rows with a number in them, repeated
	. '<table:table-row table:number-rows-repeated="2"><table:table-cell office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1023"/></table:table-row>'
	// yellow to the last row
	. '<table:table-row table:number-rows-repeated="983033"><table:table-cell table:style-name="fill" table:number-columns-repeated="5"/><table:table-cell table:number-columns-repeated="1019"/></table:table-row>';

echo "--- the rest of the sheet, as LibreOffice writes it ---\n";
$m = attempt('a sheet painted to its last row and column is taken in', static fn () => OdsFormat::import(new ZipReader(ods($styles, $table))));
$cells = $m['sheets'][0]['cells'] ?? [];
check('the cells with something in them', ($cells['A1']['v'] ?? null) === 'x' && ($cells['A2']['v'] ?? null) === 5 && ($cells['A65521']['v'] ?? null) === 7 && ($cells['A65522']['v'] ?? null) === 7, json_encode(array_slice($cells, 0, 8)));
check('the column\'s font is not a cell anywhere', !isset($cells['B2']['s']['font']) && !isset($cells['E2']) && !isset($cells['A3']), json_encode([$cells['E2'] ?? null, $cells['A3'] ?? null]));
check('empty cells centred vertically are not cells', !isset($cells['B3']) && !isset($cells['IL65517']), json_encode($cells['B3'] ?? null));
check('a yellow band of two is kept where it is', ($cells['B1']['s']['bg'] ?? '') === '#ffff00' && ($cells['C1']['s']['bg'] ?? '') === '#ffff00' && ($cells['A65518']['s']['bg'] ?? '') === '#ffff00' && ($cells['B65520']['s']['bg'] ?? '') === '#ffff00', json_encode([$cells['B1'] ?? null, $cells['A65518'] ?? null]));
check('a boxed empty cell is kept', ($cells['B2']['s']['bt'] ?? '') === '1px solid #000000', json_encode($cells['B2'] ?? null));
check('yellow running on past 84 columns is not', !isset($cells['D1']) && !isset($cells['AMJ1']), json_encode($cells['D1'] ?? null));
check('yellow running on past 84 rows is not', !isset($cells['A65523']) && !isset($cells['E1048576']), json_encode($cells['A65523'] ?? null));
check('the merge over empty cells is kept', ($m['sheets'][0]['merges'] ?? []) === ['C2:D2'], json_encode($m['sheets'][0]['merges'] ?? null));
check('thirteen cells, not a million', count($cells) === 13, (string)count($cells));

echo "--- the two files the gate found ---\n";
foreach (['lo_functions.ods', 'lo_formula-across-sheets.ods'] as $file) {
	$m = attempt($file . ' is taken in', static fn () => OdsFormat::import(new ZipReader((string)file_get_contents(__DIR__ . '/fixtures/' . $file))));
	if ($m === null) {
		continue;
	}
	$n = 0;
	foreach ($m['sheets'] as $s) {
		$n += count($s['cells']);
	}
	check($file . ': ' . count($m['sheets']) . ' sheets, ' . $n . ' cells', $n > 0 && $n < 5000, (string)$n);
}
$m = attempt('lo_functions.ods', static fn () => OdsFormat::import(new ZipReader((string)file_get_contents(__DIR__ . '/fixtures/lo_functions.ods'))));
$names = array_map(static fn ($s) => $s['name'], $m['sheets'] ?? []);
check('lo_functions.ods: its seven sheets, in order', $names === ['Logical', 'Spreadsheet', 'Mathematical', 'Information', 'Text', 'Statistical', 'Financial'], json_encode($names));
$logical = $m['sheets'][0]['cells'] ?? [];
// Calc (24.2) shows Logical!A1 as the boolean FALSE of of:=AND(0;0)
check('lo_functions.ods: Logical!A1 is what Calc has there', ($logical['A1'] ?? null) === ['f' => '=AND(0;0)', 't' => 'b', 'v' => false], json_encode($logical['A1'] ?? null));
$m = attempt('lo_formula-across-sheets.ods', static fn () => OdsFormat::import(new ZipReader((string)file_get_contents(__DIR__ . '/fixtures/lo_formula-across-sheets.ods'))));
$names = array_map(static fn ($s) => $s['name'], $m['sheets'] ?? []);
check('lo_formula-across-sheets.ods: its three sheets', count($names) === 3, json_encode($names));

echo "--- the reasons, in Japanese ---\n";
$ja = json_decode((string)file_get_contents('/root/regibase-build/calcbase-l10n-ja-server.json'), true) ?: [];
check('"more than a million cells" is a sentence of its own', Model::TOO_MANY_CELLS === 'that file has more than 1,000,000 cells' && Model::MAX_CELLS === 1000000);
$said = [];
foreach (['OdsFormat', 'XlsxFormat', 'CsvFormat', 'ZipReader', 'ImportExport', 'FileBrowser', 'Model'] as $class) {
	$src = (string)file_get_contents(CB_LIB . '/Service/' . $class . '.php');
	// every refusal of the import and export: a quoted sentence, never one put together
	preg_match_all('/throw new \\\\?(?:InvalidArgumentException|NotPermittedException)\((.*?)\);/s', $src, $mm);
	foreach ($mm[1] as $arg) {
		if (preg_match('/^Model::(TOO_MANY_\w+)$/', trim($arg), $c)) {
			$said[] = constant(Model::class . '::' . $c[1]);
		} elseif (preg_match("/^'((?:[^'\\\\]|\\\\.)*)'$/", trim($arg), $c)) {
			$said[] = stripslashes($c[1]);
		} elseif (!in_array($class, ['FileBrowser', 'Model', 'ImportExport'], true) && !preg_match('/\$(name|what)\b/', $arg)) {
			// FileBrowser's "file 12 not found" and "file is larger than 64 MB" are read by the
			// screen's own patterns; a broken file's sentences that name the part (content.xml)
			// keep the name (zip_limits_test) and are left to such a pattern too.
			$said[] = 'put together: ' . trim($arg);
		}
	}
}
$missing = array_values(array_filter(array_unique($said), static fn ($s) => !isset($ja[$s]) && !preg_match('/^(that is not a workbook|a workbook needs at least one sheet|a workbook may have|sheet .* is not a sheet|there is no sheet called|that is not a folder name|not a folder|fileId missing)/', $s)));
check('every reason an import is refused for has its Japanese (' . count(array_unique($said)) . ' sentences)', $missing === [], json_encode($missing, JSON_UNESCAPED_UNICODE));
check('"more than a million cells" in Japanese', ($ja[Model::TOO_MANY_CELLS] ?? '') !== '', json_encode($ja[Model::TOO_MANY_CELLS] ?? null, JSON_UNESCAPED_UNICODE));

finish();
