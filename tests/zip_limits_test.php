<?php
/**
 * A crafted ODS or XLSX cannot make the server unpack without end (ZipReader)
 * or build a model without end (Model): each is refused with a sentence.
 *
 *   - a ZIP whose directory declares an entry bigger than the limit;
 *   - a ZIP whose entries together are bigger than the limit;
 *   - a ZIP with more entries than a workbook could need;
 *   - bytes that are not a ZIP at all;
 *   - an ODS with more sheets than allowed, and one with more cells than allowed
 *     (a row with something in it repeated a million times);
 *   - a model from the browser with too many sheets or cells, or no sheets.
 *
 * Run: php tests/zip_limits_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';

use OCA\CalcBase\Service\Model;
use OCA\CalcBase\Service\OdsFormat;
use OCA\CalcBase\Service\ZipReader;
use OCA\CalcBase\Service\ZipWriter;

/** @return array{0: mixed, 1: ?Throwable} */
function tryIt(callable $fn): array {
	try {
		return [$fn(), null];
	} catch (\Throwable $e) {
		return [null, $e];
	}
}
$refused = static fn (?Throwable $e, string $words): bool => $e instanceof \InvalidArgumentException && str_contains($e->getMessage(), $words);

echo "--- the ZIP itself ---\n";
$bomb = ZipWriter::build(['mimetype' => OdsFormat::MIME, 'content.xml' => str_repeat('0', ZipReader::MAX_ENTRY_BYTES + 1)]);
check('a bomb is a small file', strlen($bomb) < 200000, strlen($bomb) . ' bytes');
[, $e] = tryIt(static fn () => new ZipReader($bomb));
check('an entry bigger than the limit is refused', $refused($e, 'larger than'), $e ? $e->getMessage() : 'no refusal');

$parts = ['mimetype' => OdsFormat::MIME];
for ($i = 0; $i < 4; $i++) {
	$parts['p' . $i] = str_repeat('0', (int)(ZipReader::MAX_TOTAL_BYTES / 4) + 1024);
}
[, $e] = tryIt(static fn () => new ZipReader(ZipWriter::build($parts)));
check('entries that together pass the limit are refused', $refused($e, 'larger than'), $e ? $e->getMessage() : 'no refusal');

$many = [];
for ($i = 0; $i <= ZipReader::MAX_ENTRIES; $i++) {
	$many['e' . $i] = 'x';
}
[, $e] = tryIt(static fn () => new ZipReader(ZipWriter::build($many)));
check('too many entries are refused', $refused($e, 'too many parts'), $e ? $e->getMessage() : 'no refusal');

[, $e] = tryIt(static fn () => new ZipReader('<html>not a zip</html>'));
check('not a ZIP is said plainly', $refused($e, 'not a ZIP'), $e ? $e->getMessage() : 'no refusal');

[, $e] = tryIt(static fn () => OdsFormat::import(new ZipReader(ZipWriter::build(['mimetype' => OdsFormat::MIME, 'styles.xml' => '<x/>']))));
check('a package without content.xml is refused by name', $refused($e, 'content.xml'), $e ? $e->getMessage() : 'no refusal');

echo "--- what is inside ---\n";
$ns = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"';
$tables = '';
for ($i = 0; $i <= Model::MAX_SHEETS; $i++) {
	$tables .= '<table:table table:name="S' . $i . '"><table:table-column/><table:table-row><table:table-cell/></table:table-row></table:table>';
}
$xml = '<?xml version="1.0"?><office:document-content ' . $ns . '><office:body><office:spreadsheet>' . $tables . '</office:spreadsheet></office:body></office:document-content>';
[, $e] = tryIt(static fn () => OdsFormat::import(new ZipReader(ZipWriter::build(['mimetype' => OdsFormat::MIME, 'content.xml' => $xml]))));
check('more sheets than allowed are refused', $refused($e, 'sheets'), $e ? $e->getMessage() : 'no refusal');

$row = '<table:table-row table:number-rows-repeated="1000000"><table:table-cell office:value-type="float" office:value="1" table:number-columns-repeated="200"><text:p>1</text:p></table:table-cell></table:table-row>';
$xml = '<?xml version="1.0"?><office:document-content ' . $ns . '><office:body><office:spreadsheet><table:table table:name="S"><table:table-column table:number-columns-repeated="200"/>' . $row . '</table:table></office:spreadsheet></office:body></office:document-content>';
$t0 = microtime(true);
[, $e] = tryIt(static fn () => OdsFormat::import(new ZipReader(ZipWriter::build(['mimetype' => OdsFormat::MIME, 'content.xml' => $xml]))));
check('a repeated row that would make a million cells is refused', $refused($e, 'cells'), $e ? $e->getMessage() : 'no refusal');
check('... quickly', microtime(true) - $t0 < 20, sprintf('%.1fs', microtime(true) - $t0));

$empty = '<table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="16000"/></table:table-row>';
$xml = '<?xml version="1.0"?><office:document-content ' . $ns . '><office:body><office:spreadsheet><table:table table:name="S"><table:table-column/><table:table-row><table:table-cell office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell></table:table-row>' . $empty . '</table:table></office:spreadsheet></office:body></office:document-content>';
$t0 = microtime(true);
[$m, $e] = tryIt(static fn () => OdsFormat::import(new ZipReader(ZipWriter::build(['mimetype' => OdsFormat::MIME, 'content.xml' => $xml]))));
check('a million empty rows (as LibreOffice writes the tail) cost nothing', $e === null && ($m['sheets'][0]['cells']['A1']['v'] ?? null) === 7 && count($m['sheets'][0]['cells']) === 1, $e ? $e->getMessage() : json_encode($m['sheets'][0]['cells'] ?? null));
check('... and are quick', microtime(true) - $t0 < 5, sprintf('%.1fs', microtime(true) - $t0));

echo "--- a model from the browser ---\n";
[, $e] = tryIt(static fn () => Model::clean(['sheets' => []]));
check('no sheets is refused', $refused($e, 'at least one sheet'), $e ? $e->getMessage() : 'no refusal');
[, $e] = tryIt(static fn () => Model::clean(['sheets' => array_fill(0, Model::MAX_SHEETS + 1, ['name' => 'S'])]));
check('too many sheets are refused', $refused($e, 'sheets'), $e ? $e->getMessage() : 'no refusal');
[, $e] = tryIt(static fn () => Model::clean('nonsense'));
check('not a model is refused', $refused($e, 'not a workbook'), $e ? $e->getMessage() : 'no refusal');
$cells = [];
for ($r = 0; $r < 1001; $r++) {
	for ($c = 0; $c < 1000; $c++) {
		$cells[OCA\CalcBase\Service\Cells::ref($r, $c)] = ['v' => 1, 't' => 'n'];
	}
}
[, $e] = tryIt(static fn () => Model::clean(['sheets' => [['name' => 'S', 'cells' => $cells]]]));
check('too many cells are refused', $refused($e, 'cells'), $e ? $e->getMessage() : 'no refusal');
$m = Model::clean(['sheets' => [['name' => 'S', 'cells' => ['a1' => ['v' => 1], 'ZZZZ1' => ['v' => 2], 'B2' => ['f' => 'SUM(A1)', 'v' => 'x', 't' => 'n'], 'C3' => ['v' => 'hi', 's' => ['color' => 'red', 'bg' => '#FFF', 'nonsense' => 1, 'bt' => '1px solid #000']]]]]]);
check('addresses are upper-cased, bad ones dropped', isset($m['sheets'][0]['cells']['A1']) && !isset($m['sheets'][0]['cells']['ZZZZ1']), json_encode(array_keys($m['sheets'][0]['cells'])));
check('a formula without = gets one; a value that is not a number is dropped', $m['sheets'][0]['cells']['B2'] === ['f' => '=SUM(A1)'], json_encode($m['sheets'][0]['cells']['B2']));
check('only the contract\'s style keys, colours as #rrggbb', $m['sheets'][0]['cells']['C3']['s'] === ['bg' => '#ffffff', 'bt' => '1px solid #000000'], json_encode($m['sheets'][0]['cells']['C3']['s']));

finish();
