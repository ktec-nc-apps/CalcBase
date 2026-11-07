<?php
/**
 * Excel 365's dynamic array functions and the others CalcBase took up in 2026-11 (FILTER,
 * SORT, LET, TEXTSPLIT, REGEXTEST …) in and out of ODS and XLSX.
 *
 * In an XLSX file Excel writes them with its prefixes (_xlfn., _xlfn._xlws. for FILTER, SORT,
 * SORTBY and UNIQUE, _xlpm. for LET's names) and marks a formula that spills with cell metadata
 * (cm="1" and xl/metadata.xml); without that Excel reads it as an old fixed-size array formula.
 * In an ODS file LibreOffice from 24.8 on names them COM.MICROSOFT.… (of:=XMATCH(…) is #NAME?
 * there) and writes LET's names with _xlpm. too (measured in Collabora Office 26). LibreOffice
 * 24.2 has none of them: it shows the values the file keeps.
 *
 * Run: php tests/dynamic_arrays_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/lo_helper.php';

use OCA\CalcBase\Service\FormulaSyntax as F;
use OCA\CalcBase\Service\Model;
use OCA\CalcBase\Service\OdsFormat;
use OCA\CalcBase\Service\XlsxFormat;
use OCA\CalcBase\Service\ZipReader;

echo "--- the names in the files ---\n";
foreach ([
	[F::toOds('=FILTER(A1:A3;B1:B3>1)'), 'of:=COM.MICROSOFT.FILTER([.A1:.A3];[.B1:.B3]>1)'],
	[F::toXlsx('=FILTER(A1:A3;B1:B3>1)'), '_xlfn._xlws.FILTER(A1:A3,B1:B3>1)'],
	[F::toXlsx('=SORT(A1:B3;2;-1)'), '_xlfn._xlws.SORT(A1:B3,2,-1)'],
	[F::toXlsx('=SEQUENCE(3)+RANDARRAY(3)'), '_xlfn.SEQUENCE(3)+_xlfn.RANDARRAY(3)'],
	[F::toXlsx('=REGEXTEST(A1;"a")+PERCENTOF(1;2)'), '_xlfn.REGEXTEST(A1,"a")+_xlfn.PERCENTOF(1,2)'],
	[F::toOds('=XLOOKUP(1;A:A;B:B)'), 'of:=COM.MICROSOFT.XLOOKUP(1;[.A1:.A1048576];[.B1:.B1048576])'],
	[F::toOds('=LET(x;2;y;x*3;x+y)'), 'of:=COM.MICROSOFT.LET(_xlpm.x;2;_xlpm.y;_xlpm.x*3;_xlpm.x+_xlpm.y)'],
	[F::toXlsx('=LET(x;2;y;x*3;x+y)'), '_xlfn.LET(_xlpm.x,2,_xlpm.y,_xlpm.x*3,_xlpm.x+_xlpm.y)'],
	[F::toXlsx('=LET(x;LET(y;1;y+1);x&"x y")'), '_xlfn.LET(_xlpm.x,_xlfn.LET(_xlpm.y,1,_xlpm.y+1),_xlpm.x&"x y")'],
	[F::toXlsx('=LET(a;Sheet2.A1;a+A1)'), '_xlfn.LET(_xlpm.a,Sheet2!A1,_xlpm.a+A1)'],
	[F::fromOds('of:=COM.MICROSOFT.LET(_xlpm.x;2;_xlpm.x*3)'), '=LET(x;2;x*3)'],
	[F::fromOds('of:=COM.MICROSOFT.TEXTSPLIT([.A1];",")'), '=TEXTSPLIT(A1;",")'],
	[F::fromXlsx('_xlfn.LET(_xlpm.x,2,_xlpm.x*3)'), '=LET(x,2,x*3)'],
	[F::fromXlsx('_xlfn._xlws.SORT(A1:B3,2,-1)'), '=SORT(A1:B3,2,-1)'],
] as [$got, $want]) {
	check("→ $want", $got === $want, $got);
}

echo "--- a formula that spills ---\n";
$book = Model::clean([
	'sheets' => [['name' => 'S', 'cells' => [
		'A1' => ['f' => '=SEQUENCE(3)', 'a' => 'A1:A3', 'sp' => 1, 'v' => 1, 't' => 'n'], 'A2' => ['v' => 2, 't' => 'n'], 'A3' => ['v' => 3, 't' => 'n'],
		'B1' => ['f' => '=SUM(A1:A3)', 'v' => 6, 't' => 'n'],
		'C1' => ['f' => '=SUM(A1:A3*2)', 'v' => 12, 't' => 'n', 'a' => 'C1:C1'],
	]]],
	'active' => 0,
]);
check('the model keeps the spill (a, sp) and an array formula as it was', ($book['sheets'][0]['cells']['A1']['sp'] ?? 0) === 1 && !isset($book['sheets'][0]['cells']['C1']['sp']), json_encode($book['sheets'][0]['cells']));
$xlsx = XlsxFormat::export($book);
$zip = new ZipReader($xlsx);
$sheet = (string)$zip->read('xl/worksheets/sheet1.xml');
check('xlsx: the spill is marked cm="1", the array formula is not', str_contains($sheet, '<c r="A1" cm="1"><f t="array" ref="A1:A3">_xlfn.SEQUENCE(3)</f>') && str_contains($sheet, '<c r="C1"><f t="array" ref="C1:C1">'), $sheet);
check('xlsx: the metadata part, its type and its relationship', str_contains((string)$zip->read('xl/metadata.xml'), 'fDynamic="1"') && str_contains((string)$zip->read('[Content_Types].xml'), 'sheetMetadata+xml') && str_contains((string)$zip->read('xl/_rels/workbook.xml.rels'), 'Target="metadata.xml"'));
$plain = new ZipReader(XlsxFormat::export(Model::clean(['sheets' => [['name' => 'S', 'cells' => ['A1' => ['v' => 1, 't' => 'n']]]], 'active' => 0])));
check('xlsx: no metadata without a spill', !$plain->has('xl/metadata.xml') && !str_contains((string)$plain->read('[Content_Types].xml'), 'sheetMetadata'));
$again = Model::clean(XlsxFormat::import(new ZipReader($xlsx)));
check('xlsx in: the spill comes back a spill', ($again['sheets'][0]['cells']['A1']['a'] ?? '') === 'A1:A3' && ($again['sheets'][0]['cells']['A1']['sp'] ?? 0) === 1 && !isset($again['sheets'][0]['cells']['C1']['sp']), json_encode($again['sheets'][0]['cells']));
$ods = OdsFormat::export($book);
check('ods: written as an array formula of the size it spilled to', str_contains((string)(new ZipReader($ods))->read('content.xml'), 'table:formula="of:=COM.MICROSOFT.SEQUENCE(3)" table:number-matrix-columns-spanned="1" table:number-matrix-rows-spanned="3"'));
if (!sofficeAvailable()) {
	echo "SKIP  soffice is not installed here\n";
} else {
	// LibreOffice 24.2 does not have these functions. Opened as it opens any file (its own profile, no
	// forced recalculation): a formula that is not an array keeps the value the file holds; an array
	// formula is worked out again and is #NAME?, and so is what reads it. (LibreOffice 24.8 and later
	// read COM.MICROSOFT.SEQUENCE.)
	$book['sheets'][0]['cells']['D1'] = ['f' => '=TEXTBEFORE("a-b";"-")', 'v' => 'a', 't' => 's'];
	$dir = sys_get_temp_dir() . '/calcbase-dyn-' . getmypid();
	@mkdir($dir . '/out', 0700, true);
	file_put_contents($dir . '/dyn.ods', OdsFormat::export(Model::clean($book)));
	shell_exec('timeout 180 soffice --headless -env:UserInstallation=file://' . $dir . '/profile --convert-to csv --outdir ' . escapeshellarg($dir . '/out') . ' ' . escapeshellarg($dir . '/dyn.ods') . ' 2>&1');
	$rows = array_map(static fn (string $l): array => str_getcsv($l, ',', '"', ''), file($dir . '/out/dyn.csv', FILE_IGNORE_NEW_LINES) ?: []);
	shell_exec('rm -rf ' . escapeshellarg($dir));
	check('LibreOffice 24.2: TEXTBEFORE keeps its value, the spilled SEQUENCE and the SUM of it are #NAME?', ($rows[0][3] ?? '') === 'a' && ($rows[0][0] ?? '') === '#NAME?' && ($rows[0][1] ?? '') === '#NAME?', json_encode($rows));
}

finish();
