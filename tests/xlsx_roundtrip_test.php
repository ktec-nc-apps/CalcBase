<?php
/**
 * XLSX in and out (XlsxFormat): the fixture LibreOffice wrote from
 * fixtures/src/roundtrip.fods is read -- values, formulas, number formats,
 * styles, widths, heights, merges, three sheets -- written out again, read
 * back the same, a model read from the ODS fixture is written as XLSX, and
 * the written file is opened by LibreOffice, which recalculates every
 * formula and shows the same values and formats.
 *
 * Run: php tests/xlsx_roundtrip_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/lo_helper.php';

use OCA\CalcBase\Service\Model;
use OCA\CalcBase\Service\OdsFormat;
use OCA\CalcBase\Service\XlsxFormat;
use OCA\CalcBase\Service\ZipReader;

echo "--- reading what LibreOffice wrote ---\n";
$m = XlsxFormat::import(new ZipReader(file_get_contents(__DIR__ . '/fixtures/roundtrip.xlsx')));
check('three sheets, in order', array_map(static fn ($s) => $s['name'], $m['sheets']) === ['Sales', 'Other', 'My sheet'], json_encode(array_map(static fn ($s) => $s['name'], $m['sheets'])));
$c = $m['sheets'][0]['cells'];
check('a shared string', ($c['A1']['v'] ?? '') === '売上表' && ($c['A1']['t'] ?? '') === 's');
$s = $c['A1']['s'] ?? [];
check('colour, fill, centre, middle, borders (the font is whatever LibreOffice substituted)', ($s['color'] ?? '') === '#c00000' && ($s['bg'] ?? '') === '#fff2cc' && ($s['ha'] ?? '') === 'center' && ($s['va'] ?? '') === 'middle' && ($s['bt'] ?? '') === '1px solid #000000' && ($s['bl'] ?? '') === '1px solid #000000', json_encode($s));
check('strikethrough', ($c['D1']['s'] ?? null) === ['strike' => 1], json_encode($c['D1'] ?? null));
check('a number with #,##0.00 and right alignment', ($c['B3'] ?? null) === ['t' => 'n', 'v' => 1234.5, 'fmt' => '#,##0.00', 's' => ['ha' => 'right']], json_encode($c['B3'] ?? null));
check('a percentage, italic and underlined', ($c['C3'] ?? null) === ['t' => 'n', 'v' => 0.125, 'fmt' => '0.0%', 's' => ['i' => 1, 'u' => 1]], json_encode($c['C3'] ?? null));
check('a date serial with yyyy/mm/dd', ($c['D3'] ?? null) === ['t' => 'n', 'v' => 46300, 'fmt' => 'yyyy/mm/dd'], json_encode($c['D3'] ?? null));
check('a time with h:mm', ($c['C4'] ?? null) === ['t' => 'n', 'v' => 0.4375, 'fmt' => 'h:mm'], json_encode($c['C4'] ?? null));
check('a boolean without LibreOffice\'s boolean format', ($c['D4'] ?? null) === ['t' => 'b', 'v' => true], json_encode($c['D4'] ?? null));
check('SUM with its value and [$¥-411]#,##0 read as ¥#,##0', ($c['B5']['f'] ?? '') === '=SUM(B3:B4)' && ($c['B5']['v'] ?? 0) === 1334.5 && ($c['B5']['fmt'] ?? '') === '¥#,##0' && ($c['B5']['s']['wrap'] ?? 0) === 1, json_encode($c['B5'] ?? null, JSON_UNESCAPED_UNICODE));
check('IF with , and a string holding ;', ($c['C5'] ?? null) === ['f' => '=IF(B3>1000,"big;yes","small")', 't' => 's', 'v' => 'big;yes'], json_encode($c['C5'] ?? null));
check('an error result', ($c['D5'] ?? null) === ['f' => '=B4/0', 't' => 'e', 'v' => '#DIV/0!'], json_encode($c['D5'] ?? null));
check('Other!B2*2 as typed', ($c['B6'] ?? null) === ['f' => '=Other!B2*2', 't' => 'n', 'v' => 84], json_encode($c['B6'] ?? null));
check("'My sheet'!A1 as typed", ($c['C6'] ?? null) === ['f' => "='My sheet'!A1", 't' => 's', 'v' => 'hello'], json_encode($c['C6'] ?? null));
check('a line break in a string', ($c['D6']['v'] ?? '') === "line one\nline two" && ($c['D6']['s']['wrap'] ?? 0) === 1, json_encode($c['D6'] ?? null));
check('the merge, and no cell for the covered one', $m['sheets'][0]['merges'] === ['A1:B1'] && !isset($c['B1']), json_encode($m['sheets'][0]['merges']));
check('the custom column width (17.88 chars → 130px)', ($m['sheets'][0]['cols']['A'] ?? 0) === 130 && !isset($m['sheets'][0]['cols']['B']), json_encode($m['sheets'][0]['cols']));
check('a row height set by hand (25.5pt → 34px), not the others', $m['sheets'][0]['rows'] === ['1' => 34], json_encode($m['sheets'][0]['rows']));

echo "--- written out and read back ---\n";
$clean = Model::clean($m);
$clean['sheets'][0]['freeze'] = 'B3';
$clean['sheets'][1]['grid'] = false;
$bytes = XlsxFormat::export($clean);
$again = XlsxFormat::import(new ZipReader($bytes));
$same = static fn (array $a, array $b, string $k): bool => json_encode($a[$k] ?? null) === json_encode($b[$k] ?? null);
foreach ($clean['sheets'] as $i => $sheet) {
	foreach (['name', 'cells', 'cols', 'rows', 'merges'] as $k) {
		check("sheet $i: $k reads back the same", $same($sheet, $again['sheets'][$i], $k), json_encode($again['sheets'][$i][$k] ?? null, JSON_UNESCAPED_UNICODE));
	}
}
check('frozen panes come back', ($again['sheets'][0]['freeze'] ?? '') === 'B3', json_encode($again['sheets'][0]['freeze'] ?? null));
check('hidden gridlines come back', ($again['sheets'][1]['grid'] ?? true) === false);

echo "--- shared formulas ---\n";
// A sheet written the way Excel writes a filled-down formula: once, with a range.
$sheetXml = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
	. '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c></row>'
	. '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>4</v></c></row>'
	. '<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>6</v></c></row></sheetData></worksheet>';
$rc = new ReflectionClass(XlsxFormat::class);
$sheetFn = $rc->getMethod('sheet');
$count = 0;
$shared = $sheetFn->invokeArgs(null, [$sheetXml, 'S', [], [], false, &$count]);
check('a shared formula is unfolded to each cell', ($shared['cells']['B2']['f'] ?? '') === '=A2*2' && ($shared['cells']['B3']['f'] ?? '') === '=A3*2', json_encode($shared['cells']));

echo "--- the ODS fixture written as XLSX ---\n";
$fromOds = Model::clean(OdsFormat::import(new ZipReader(file_get_contents(__DIR__ . '/fixtures/roundtrip.ods'))));
$x = XlsxFormat::import(new ZipReader(XlsxFormat::export($fromOds)));
check('formulas are rewritten to Excel syntax', ($x['sheets'][0]['cells']['C5']['f'] ?? '') === '=IF(B3>1000,"big;yes","small")' && ($x['sheets'][0]['cells']['B6']['f'] ?? '') === '=Other!B2*2' && ($x['sheets'][0]['cells']['C6']['f'] ?? '') === "='My sheet'!A1", json_encode([$x['sheets'][0]['cells']['C5'] ?? null, $x['sheets'][0]['cells']['B6'] ?? null, $x['sheets'][0]['cells']['C6'] ?? null]));
check('values and formats survive', ($x['sheets'][0]['cells']['B5']['fmt'] ?? '') === '¥#,##0' && ($x['sheets'][0]['cells']['D3']['fmt'] ?? '') === 'yyyy/mm/dd', json_encode($x['sheets'][0]['cells']['B5'] ?? null, JSON_UNESCAPED_UNICODE));

echo "--- opened by LibreOffice ---\n";
if (!sofficeAvailable()) {
	echo "SKIP  soffice is not installed here\n";
} else {
	$tmp = sys_get_temp_dir() . '/calcbase-test-out.xlsx';
	file_put_contents($tmp, $bytes);
	$raw = loSheets($tmp, false);
	$shown = loSheets($tmp, true);
	unlink($tmp);
	check('LibreOffice opens it and finds the three sheets', isset($raw['Sales'], $raw['Other'], $raw['My sheet']), json_encode(array_keys($raw)));
	$s = $raw['Sales'] ?? [];
	check('SUM(B3:B4) recalculates to 1334.5', ($s[4][1] ?? '') === '1334.5', json_encode($s[4] ?? null));
	check('IF(...) recalculates to big;yes', ($s[4][2] ?? '') === 'big;yes', json_encode($s[4] ?? null));
	check('B4/0 is #DIV/0!', ($s[4][3] ?? '') === '#DIV/0!', json_encode($s[4] ?? null));
	check('Other!B2*2 is 84 and \'My sheet\'!A1 is hello', ($s[5][1] ?? '') === '84' && ($s[5][2] ?? '') === 'hello', json_encode($s[5] ?? null));
	$v = $shown['Sales'] ?? [];
	check('shown as 1,234.50 (#,##0.00)', ($v[2][1] ?? '') === '1,234.50', json_encode($v[2] ?? null));
	check('shown as 12.5% (0.0%)', ($v[2][2] ?? '') === '12.5%', json_encode($v[2] ?? null));
	check('shown as 2026/10/05 (yyyy/mm/dd)', ($v[2][3] ?? '') === '2026/10/05', json_encode($v[2] ?? null));
	check('shown as 10:30 (h:mm)', ($v[3][2] ?? '') === '10:30', json_encode($v[3] ?? null));
	check('shown as ¥1,335 (¥#,##0)', ($v[4][1] ?? '') === '¥1,335', json_encode($v[4] ?? null, JSON_UNESCAPED_UNICODE));
}

finish();
