<?php
/**
 * Number formats read from ODS and written to ODS and XLSX as Calc has them
 * (CalcBase BUGS #27), and times written with their fraction of a second
 * (BUGS #32).
 *
 * Read: the codes CalcBase makes of LibreOffice's number styles are the ones
 * LibreOffice itself writes for them (measured 2026-10-05: soffice converted
 * fixtures/lo_formats.ods -- LibreOffice core sc/qa/unit/data/ods/formats.ods,
 * MPL-2.0 -- to XLSX, and its numFmts were read). Before, a fraction was
 * General (25 31/82 shown as 25.378), an engineering format lost its step of
 * three (258.9E3 → 2.59E+5), the "/" before a text or a number was dropped or
 * read as a fraction, a date "in the order of the locale" kept the file's
 * month/day/year (Calc in Japanese shows 14/11/01), and a style with no count
 * of decimals -- Calc's General -- was read as 0 (3.1415926536 shown as 3).
 *
 * Written: LibreOffice opens CalcBase's ODS and XLSX and shows each value as
 * Calc showed the original (the texts below are Calc's, from the same files).
 * Before, ODS lost the minus of a negative section (-$1,234.00 → $1,234.00),
 * turned 0.00E+000 into 258963.00E+000, wrote yy as a four-digit year
 * (06/11/24 → 2006/11/24), and rounded a time to whole seconds (0.233 of a
 * day came back as 0.23299768…).
 *
 * Run: php tests/number_formats_io_test.php
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

echo "--- read from LibreOffice's formats.ods: the codes LibreOffice writes for them ---\n";
$m = attempt('formats.ods', static fn () => OdsFormat::import(new ZipReader((string)file_get_contents(__DIR__ . '/fixtures/lo_formats.ods'))));
$c = $m['sheets'][0]['cells'] ?? [];
foreach ([
	'B3' => '$#,##0.00;[Red]-$#,##0.00', 'A4' => '0.00E+000', 'B4' => '0.00E+00', 'A5' => '# ??/??', 'B5' => '# ??/??',
	'A7' => '"/"@', 'A8' => '##0.0#E-0', 'B8' => '##0.##E-00', 'A9' => '0.???', 'B9' => '"/ "#,##0.00',
] as $ref => $want) {
	check("$ref: $want", ($c[$ref]['fmt'] ?? 'General') === $want, json_encode($c[$ref] ?? null, JSON_UNESCAPED_UNICODE));
}

/** A one-table .ods with the number styles given in styles.xml, the cell using style "ce1". */
function odsWith(string $numberStyle, string $cell): string {
	$ns = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" office:version="1.3"';
	return ZipWriter::build([
		'mimetype' => OdsFormat::MIME,
		'styles.xml' => '<?xml version="1.0" encoding="UTF-8"?><office:document-styles ' . $ns . '><office:styles>' . $numberStyle . '</office:styles></office:document-styles>',
		'content.xml' => '<?xml version="1.0" encoding="UTF-8"?><office:document-content ' . $ns . '><office:automatic-styles><style:style style:name="ce1" style:family="table-cell" style:data-style-name="N1"/></office:automatic-styles>'
			. '<office:body><office:spreadsheet><table:table table:name="S"><table:table-row>' . $cell . '</table:table-row></table:table></office:spreadsheet></office:body></office:document-content>',
	], 'mimetype');
}
$date = '<table:table-cell table:style-name="ce1" office:value-type="date" office:date-value="2014-11-01"><text:p>11/01/14</text:p></table:table-cell>';
$mdy = '<number:month number:style="long"/><number:text>/</number:text><number:day number:style="long"/><number:text>/</number:text><number:year/>';
$m = attempt('automatic order', static fn () => OdsFormat::import(new ZipReader(odsWith('<number:date-style style:name="N1" number:automatic-order="true">' . $mdy . '</number:date-style>', $date))));
check('a date in the order of the locale: year, month, day in Japanese (yy/mm/dd, shown 14/11/01)', ($m['sheets'][0]['cells']['A1']['fmt'] ?? '') === 'yy/mm/dd', json_encode($m['sheets'][0]['cells']['A1'] ?? null));
$m = attempt('fixed order', static fn () => OdsFormat::import(new ZipReader(odsWith('<number:date-style style:name="N1">' . $mdy . '</number:date-style>', $date))));
check('a date in a fixed order keeps it (mm/dd/yy)', ($m['sheets'][0]['cells']['A1']['fmt'] ?? '') === 'mm/dd/yy', json_encode($m['sheets'][0]['cells']['A1'] ?? null));
$pi = '<table:table-cell table:style-name="ce1" office:value-type="float" office:value="3.1415926536"><text:p>3.1415926536</text:p></table:table-cell>';
$m = attempt('General', static fn () => OdsFormat::import(new ZipReader(odsWith('<number:number-style style:name="N1"><number:number number:min-integer-digits="1"/></number:number-style>', $pi))));
check('a number style with no count of decimals is General, not 0', !isset($m['sheets'][0]['cells']['A1']['fmt']), json_encode($m['sheets'][0]['cells']['A1'] ?? null));
$m = attempt('0', static fn () => OdsFormat::import(new ZipReader(odsWith('<number:number-style style:name="N1"><number:number number:decimal-places="0" number:min-integer-digits="1"/></number:number-style>', $pi))));
check('... and one with none at all is 0', ($m['sheets'][0]['cells']['A1']['fmt'] ?? '') === '0', json_encode($m['sheets'][0]['cells']['A1'] ?? null));

echo "--- written out, opened by LibreOffice: shown as Calc showed the originals ---\n";
$cells = [];
$shown = [];
foreach ([
	[-1234, '$#,##0.00;[Red]-$#,##0.00', '-$1,234.00'], [258963, '0.00E+000', '2.59E+005'], [-2354, '0.00E+00', '-2.35E+03'],
	[25.378, '# ??/??', '25 31/82'], [0.389, '# ??/??', '7/18'], ['>', '"/"@', '/>'], [258900, '##0.0#E-0', '258.9E3'],
	[-0.000953, '##0.##E-00', '-953E-06'], [123.456, '"/ "#,##0.00', '/ 123.46'], [0.5, '0.???', '0.5'],
	[39045, 'yy/mm/dd', '06/11/24'], [39045, 'dd/mm/yy', '24/11/06'], [39045, 'dd-mm-yy', '24-11-06'], [0.233, 'h:mm:ss', '5:35:31'],
] as $i => [$v, $fmt, $want]) {
	$cells['A' . ($i + 1)] = ['v' => $v, 't' => is_string($v) ? 's' : 'n', 'fmt' => $fmt];
	$shown[$i] = [$fmt, $want];
}
$book = Model::clean(['sheets' => [['name' => 'F', 'cells' => $cells]], 'active' => 0]);
$ods = OdsFormat::export($book);
$xlsx = XlsxFormat::export($book);
if (!sofficeAvailable()) {
	echo "SKIP  soffice is not installed here\n";
} else {
	foreach (['ods' => $ods, 'xlsx' => $xlsx] as $ext => $bytes) {
		$tmp = sys_get_temp_dir() . '/calcbase-fmt-test.' . $ext;
		file_put_contents($tmp, $bytes);
		$rows = loSheets($tmp, true)['F'] ?? [];
		unlink($tmp);
		foreach ($shown as $i => [$fmt, $want]) {
			$got = trim((string)($rows[$i][0] ?? ''));
			check("$ext: $fmt shows $want", $got === $want, $got);
		}
	}
}

echo "--- a time keeps its fraction of a second ---\n";
check('0.233 of a day is PT05H35M31.2S, as Calc writes it', Cells::durationOfSerial(0.233) === 'PT05H35M31.2S', Cells::durationOfSerial(0.233));
check('a whole time is as before (PT10H30M00S)', Cells::durationOfSerial(0.4375) === 'PT10H30M00S', Cells::durationOfSerial(0.4375));
check('a date with a time keeps the fraction too', Cells::isoOfSerial(45000.5 + 0.2 / 86400) === '2023-03-15T12:00:00.2', Cells::isoOfSerial(45000.5 + 0.2 / 86400));
check('a time a hair short of midnight is the next day, not 24:00:00', Cells::isoOfSerial(1.9999999999999) === '1900-01-01', Cells::isoOfSerial(1.9999999999999));
$again = OdsFormat::import(new ZipReader($ods));
check('read back, 0.233 is 0.233', abs(($again['sheets'][0]['cells']['A14']['v'] ?? 0) - 0.233) < 1e-12, json_encode($again['sheets'][0]['cells']['A14'] ?? null));

finish();
