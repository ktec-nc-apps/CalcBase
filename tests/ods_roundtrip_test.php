<?php
/**
 * ODS in and out (OdsFormat): the fixture LibreOffice wrote from
 * fixtures/src/roundtrip.fods is read -- values, formulas, number formats,
 * styles, widths, heights, merges, three sheets -- written out again, read
 * back the same, and the written file is opened by LibreOffice itself, which
 * recalculates every formula and shows the same values and formats.
 *
 * Run: php tests/ods_roundtrip_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/lo_helper.php';

use OCA\CalcBase\Service\Model;
use OCA\CalcBase\Service\OdsFormat;
use OCA\CalcBase\Service\ZipReader;

echo "--- reading what LibreOffice wrote ---\n";
$m = OdsFormat::import(new ZipReader(file_get_contents(__DIR__ . '/fixtures/roundtrip.ods')));
check('three sheets, in order', array_map(static fn ($s) => $s['name'], $m['sheets']) === ['Sales', 'Other', 'My sheet'], json_encode(array_map(static fn ($s) => $s['name'], $m['sheets'])));
$c = $m['sheets'][0]['cells'];
check('a text cell', ($c['A1']['v'] ?? '') === '売上表' && ($c['A1']['t'] ?? '') === 's');
check('bold, colour, fill, centre, middle, 14pt, borders', ($c['A1']['s'] ?? []) === ['b' => 1, 'color' => '#c00000', 'bg' => '#fff2cc', 'ha' => 'center', 'va' => 'middle', 'font' => 'Noto Sans JP', 'size' => 14.0, 'bt' => '1px solid #000000', 'br' => '1px solid #000000', 'bb' => '1px solid #000000', 'bl' => '1px solid #000000'], json_encode($c['A1']['s'] ?? null));
check('strikethrough', ($c['D1']['s'] ?? null) === ['strike' => 1], json_encode($c['D1'] ?? null));
check('a number with #,##0.00 and right alignment', ($c['B3'] ?? null) === ['t' => 'n', 'v' => 1234.5, 'fmt' => '#,##0.00', 's' => ['ha' => 'right']], json_encode($c['B3'] ?? null));
check('a percentage, italic and underlined', ($c['C3'] ?? null) === ['t' => 'n', 'v' => 0.125, 'fmt' => '0.0%', 's' => ['i' => 1, 'u' => 1]], json_encode($c['C3'] ?? null));
check('a date as a serial with yyyy/mm/dd', ($c['D3'] ?? null) === ['t' => 'n', 'v' => 46300, 'fmt' => 'yyyy/mm/dd'], json_encode($c['D3'] ?? null));
check('a time as a fraction with h:mm', ($c['C4'] ?? null) === ['t' => 'n', 'v' => 0.4375, 'fmt' => 'h:mm'], json_encode($c['C4'] ?? null));
check('a boolean', ($c['D4'] ?? null) === ['t' => 'b', 'v' => true], json_encode($c['D4'] ?? null));
check('SUM with its value, currency ¥#,##0, wrap and a double border below', ($c['B5'] ?? null) === ['f' => '=SUM(B3:B4)', 't' => 'n', 'v' => 1334.5, 'fmt' => '¥#,##0', 's' => ['wrap' => 1, 'bb' => '2px double #0000ff']], json_encode($c['B5'] ?? null, JSON_UNESCAPED_UNICODE));
check('IF with ; and a string holding ;', ($c['C5'] ?? null) === ['f' => '=IF(B3>1000;"big;yes";"small")', 't' => 's', 'v' => 'big;yes'], json_encode($c['C5'] ?? null));
check('an error result', ($c['D5'] ?? null) === ['f' => '=B4/0', 't' => 'e', 'v' => '#DIV/0!'], json_encode($c['D5'] ?? null));
check('a reference to another sheet', ($c['B6'] ?? null) === ['f' => '=$Other.B2*2', 't' => 'n', 'v' => 84], json_encode($c['B6'] ?? null));
check('a reference to a sheet with a space in its name', ($c['C6'] ?? null) === ['f' => "=\$'My sheet'.A1", 't' => 's', 'v' => 'hello'], json_encode($c['C6'] ?? null));
check('two paragraphs are two lines', ($c['D6']['v'] ?? '') === "line one\nline two", json_encode($c['D6'] ?? null));
check('the merge, and no cell for the covered one', $m['sheets'][0]['merges'] === ['A1:B1'] && !isset($c['B1']), json_encode($m['sheets'][0]['merges']));
check('column widths in pixels (3.5cm, 2.258cm)', ($m['sheets'][0]['cols']['A'] ?? 0) === 132 && ($m['sheets'][0]['cols']['B'] ?? 0) === 85, json_encode($m['sheets'][0]['cols']));
check('a row height set by hand (0.9cm), not the optimal ones', $m['sheets'][0]['rows'] === ['1' => 34], json_encode($m['sheets'][0]['rows']));
check('the other sheets', ($m['sheets'][1]['cells']['B2']['v'] ?? null) === 42 && ($m['sheets'][2]['cells']['A1']['v'] ?? null) === 'hello');

echo "--- written out and read back ---\n";
$clean = Model::clean($m);
$clean['sheets'][0]['freeze'] = 'B3';
$bytes = OdsFormat::export($clean);
check('mimetype is the first entry and stored', substr($bytes, 30, 8) === 'mimetype' && substr($bytes, 38, strlen(OdsFormat::MIME)) === OdsFormat::MIME && ord($bytes[8]) === 0, bin2hex(substr($bytes, 8, 2)) . ' ' . substr($bytes, 30, 47));
$again = OdsFormat::import(new ZipReader($bytes));
$same = static fn (array $a, array $b, string $k): bool => json_encode($a[$k] ?? null) === json_encode($b[$k] ?? null);
foreach ($clean['sheets'] as $i => $sheet) {
	foreach (['name', 'cells', 'cols', 'rows', 'merges'] as $k) {
		check("sheet $i: $k reads back the same", $same($sheet, $again['sheets'][$i], $k), json_encode($again['sheets'][$i][$k] ?? null, JSON_UNESCAPED_UNICODE));
	}
}
check('the frozen panes come back through settings.xml', ($again['sheets'][0]['freeze'] ?? '') === 'B3', json_encode($again['sheets'][0]['freeze'] ?? null));

echo "--- opened by LibreOffice ---\n";
if (!sofficeAvailable()) {
	echo "SKIP  soffice is not installed here\n";
} else {
	$tmp = sys_get_temp_dir() . '/calcbase-test-out.ods';
	file_put_contents($tmp, $bytes);
	$raw = loSheets($tmp, false);
	$shown = loSheets($tmp, true);
	unlink($tmp);
	check('LibreOffice opens it and finds the three sheets', isset($raw['Sales'], $raw['Other'], $raw['My sheet']), json_encode(array_keys($raw)));
	$s = $raw['Sales'] ?? [];
	check('SUM(B3:B4) recalculates to 1334.5', ($s[4][1] ?? '') === '1334.5', json_encode($s[4] ?? null));
	check('IF(...) recalculates to big;yes', ($s[4][2] ?? '') === 'big;yes', json_encode($s[4] ?? null));
	check('B4/0 is #DIV/0!', ($s[4][3] ?? '') === '#DIV/0!', json_encode($s[4] ?? null));
	check('$Other.B2*2 is 84 and $\'My sheet\'.A1 is hello', ($s[5][1] ?? '') === '84' && ($s[5][2] ?? '') === 'hello', json_encode($s[5] ?? null));
	check('a boolean is TRUE', ($s[3][3] ?? '') === 'TRUE', json_encode($s[3] ?? null));
	$v = $shown['Sales'] ?? [];
	check('shown as 1,234.50 (#,##0.00)', ($v[2][1] ?? '') === '1,234.50', json_encode($v[2] ?? null));
	check('shown as 12.5% (0.0%)', ($v[2][2] ?? '') === '12.5%', json_encode($v[2] ?? null));
	check('shown as 2026/10/05 (yyyy/mm/dd)', ($v[2][3] ?? '') === '2026/10/05', json_encode($v[2] ?? null));
	check('shown as 10:30 (h:mm)', ($v[3][2] ?? '') === '10:30', json_encode($v[3] ?? null));
	check('shown as ¥1,335 (¥#,##0)', ($v[4][1] ?? '') === '¥1,335', json_encode($v[4] ?? null, JSON_UNESCAPED_UNICODE));
}

finish();
