<?php
/**
 * CSV and TSV in and out (CsvFormat): a Shift_JIS file from a Japanese Windows
 * is read as what it is, the delimiter is worked out, quoted fields and line
 * breaks inside them survive, numbers and booleans are typed, a formula in a
 * CSV stays text, and what is exported is read back the same.
 *
 * Run: php tests/csv_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';

use OCA\CalcBase\Service\CsvFormat;
use OCA\CalcBase\Service\Model;

echo "--- Shift_JIS ---\n";
$m = CsvFormat::import(file_get_contents(__DIR__ . '/fixtures/sjis.csv'), 'sjis.csv');
$cells = $m['sheets'][0]['cells'];
check('read as Shift_JIS', ($m['encoding']['read'] ?? '') === 'CP932', json_encode($m['encoding'] ?? null));
check('Japanese comes out right', ($cells['A1']['v'] ?? '') === '商品' && ($cells['A2']['v'] ?? '') === 'りんご', json_encode($cells['A1'] ?? null, JSON_UNESCAPED_UNICODE));
check('a number is a number', ($cells['B2'] ?? null) === ['v' => 3, 't' => 'n'], json_encode($cells['B2'] ?? null));
check('a quoted field with the delimiter inside', ($cells['D2']['v'] ?? '') === '甘い,赤い', json_encode($cells['D2'] ?? null, JSON_UNESCAPED_UNICODE));
check('a formula in a CSV is text', ($cells['B4'] ?? null) === ['v' => '=SUM(B2:B3)', 't' => 's'], json_encode($cells['B4'] ?? null));
check('TRUE is a boolean', ($cells['D4'] ?? null) === ['v' => true, 't' => 'b'], json_encode($cells['D4'] ?? null));
check('an empty field is no cell', !isset($cells['D3']) && !isset($cells['C4']));
check('the sheet is named after the file', $m['sheets'][0]['name'] === 'sjis');

echo "--- TSV and quoting ---\n";
$m = CsvFormat::import(file_get_contents(__DIR__ . '/fixtures/tabs.tsv'), 'tabs.tsv');
$cells = $m['sheets'][0]['cells'];
check('tabs separate', ($cells['C1']['v'] ?? '') === 'c' && ($cells['B2'] ?? null) === ['v' => 2.5, 't' => 'n'], json_encode($cells));
check('a quoted tab stays in the field', ($cells['C2']['v'] ?? '') === "x\ty", json_encode($cells['C2'] ?? null));
check('the delimiter of a semicolon file', CsvFormat::delimiter("a;b;c\n1;2;3\n") === ';');
check('the delimiter of a comma file with semicolons in quotes', CsvFormat::delimiter("a,\"x;y;z\",c\n1,2,3\n") === ',');
$m = CsvFormat::import("\xEF\xBB\xBFname,note\r\n\"Smith, J\",\"line1\r\nline2\"\r\n\"say \"\"hi\"\"\",\r\n", 'q.csv');
$cells = $m['sheets'][0]['cells'];
check('the byte-order mark is not part of the first field', ($cells['A1']['v'] ?? '') === 'name');
check('a line break inside quotes stays in the field', ($cells['B2']['v'] ?? '') === "line1\r\nline2", json_encode($cells['B2'] ?? null));
check('"" is one quote', ($cells['A3']['v'] ?? '') === 'say "hi"', json_encode($cells['A3'] ?? null));

echo "--- export and back ---\n";
$model = Model::clean(['sheets' => [['name' => 'S', 'cells' => [
	'A1' => ['v' => 'Item', 't' => 's'], 'B1' => ['v' => 'Qty, pcs', 't' => 's'],
	'A2' => ['v' => 'りんご', 't' => 's'], 'B2' => ['v' => 3, 't' => 'n'],
	'A3' => ['v' => "two\nlines", 't' => 's'], 'B3' => ['v' => 0.125, 't' => 'n', 'fmt' => '0.0%', 'd' => '12.5%'],
	'A4' => ['v' => 'He said "hi"', 't' => 's'], 'B4' => ['v' => true, 't' => 'b'],
	'A5' => ['f' => '=SUM(B2:B3)', 'v' => 3.125, 't' => 'n'],
]]], 'active' => 0]);
$csv = CsvFormat::export($model['sheets'][0]);
check('UTF-8 with a byte-order mark, CRLF', str_starts_with($csv, "\xEF\xBB\xBF") && str_contains($csv, "\r\n"));
$lines = explode("\r\n", substr($csv, 3));
check('fields that need quotes are quoted', $lines[0] === 'Item,"Qty, pcs"' && $lines[3] === '"He said ""hi""",TRUE', json_encode($lines));
check('the shown text is written when the browser sent it', $lines[2] === "\"two\nlines\",12.5%", json_encode($lines[2]));
check('a formula cell writes its value', $lines[4] === '3.125,', json_encode($lines[4]));
$back = CsvFormat::import($csv, 'back.csv');
$cells = $back['sheets'][0]['cells'];
check('what was exported reads back', ($cells['B1']['v'] ?? '') === 'Qty, pcs' && ($cells['A3']['v'] ?? '') === "two\nlines" && ($cells['B2'] ?? null) === ['v' => 3, 't' => 'n'] && ($cells['B4'] ?? null) === ['v' => true, 't' => 'b'], json_encode($cells, JSON_UNESCAPED_UNICODE));

echo "--- limits ---\n";
$big = str_repeat("1,2,3,4,5,6,7,8,9,10\n", 100001);   // 1,000,010 cells
[, $e] = tryIt(static fn () => CsvFormat::import($big, 'big.csv'));
check('more cells than allowed is refused with a sentence', $e instanceof \InvalidArgumentException && str_contains($e->getMessage(), 'cells'), $e ? $e->getMessage() : 'no refusal');

function tryIt(callable $fn): array {
	try {
		return [$fn(), null];
	} catch (\Throwable $e) {
		return [null, $e];
	}
}

finish();
