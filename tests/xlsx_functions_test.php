<?php
/**
 * Function names in CalcBase's XLSX files (CalcBase BUGS #28).
 *
 * An XLSX file names the functions newer than Excel 2007, and Calc's own, with
 * the prefix _xlfn. (_xlfn._xlws. for FILTER and SORT); a reader that does not
 * find it takes the name for an unknown one. CalcBase wrote =DAYS(…) as it was
 * typed, and LibreOffice opened it as =days(…) and #NAME?. Calc writes these
 * names so (its OOXML function table, LibreOffice 24.2), and so does CalcBase
 * now; function names are written in capitals, whatever case they were typed in.
 *
 *   - the prefixes, and capitals, on the way out; Calc's names for Excel's functions
 *     (COM.MICROSOFT.…, LEGACY.…, FORMULA) as Excel's; text in quotes and references untouched;
 *   - taken off again on the way in;
 *   - LibreOffice opens the file and works the functions out (3652, 52, 41749);
 *   - the ODS formula has its function names in capitals too.
 *
 * Run: php tests/xlsx_functions_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/lo_helper.php';

use OCA\CalcBase\Service\FormulaSyntax;
use OCA\CalcBase\Service\Model;
use OCA\CalcBase\Service\XlsxFormat;

echo "--- written into an XLSX file ---\n";
foreach ([
	['=DAYS("1990-10-10";"1980-10-10")', '_xlfn.DAYS("1990-10-10","1980-10-10")'],
	['=ISOWEEKNUM("1995-01-01")', '_xlfn.ISOWEEKNUM("1995-01-01")'],
	['=TEXT(ORG.OPENOFFICE.EASTERSUNDAY(2014);"###.##")', 'TEXT(_xlfn.ORG.OPENOFFICE.EASTERSUNDAY(2014),"###.##")'],
	['=days(A1;B1)+sum(a1:b2)', '_xlfn.DAYS(A1,B1)+SUM(A1:B2)'],
	['=IF(A1;"days(x)";IFS(A2>1;1;TRUE;2))', 'IF(A1,"days(x)",_xlfn.IFS(A2>1,1,TRUE,2))'],
	['=CONCAT(Sheet2!A1;"x")&TEXTJOIN(",";TRUE;A1:A3)', '_xlfn.CONCAT(Sheet2!A1,"x")&_xlfn.TEXTJOIN(",",TRUE,A1:A3)'],
	['=SUM(FILTER(A1:A9;B1:B9>0))', 'SUM(_xlfn._xlws.FILTER(A1:A9,B1:B9>0))'],
	['=XLOOKUP(1;A:A;B:B)', '_xlfn.XLOOKUP(1,A:A,B:B)'],
	['=ORG.LIBREOFFICE.WEEKNUM_OOO(A1;1)', '_xlfn.ORG.LIBREOFFICE.WEEKNUM_OOO(A1,1)'],
	['=VLOOKUP(A1;B:C;2;0)+SUMIFS(C:C;A:A;"x")', 'VLOOKUP(A1,B:C,2,0)+SUMIFS(C:C,A:A,"x")'],
	// Calc's names for Excel's own functions (an ODS file's), as LibreOffice writes them in XLSX
	['=COM.MICROSOFT.CHISQ.DIST(3;2;0)', '_xlfn.CHISQ.DIST(3,2,0)'],
	['=LEGACY.CHIDIST(13.27;5)', 'CHIDIST(13.27,5)'],
	['=FORMULA(B1)', '_xlfn.FORMULATEXT(B1)'],
	// across sheets, as Excel (and LibreOffice) write it
	['=SHEETS(Logical.A1:Mathematical.G12)', '_xlfn.SHEETS(Logical:Mathematical!A1:G12)'],
	["=SUM('My sheet'.A1:Sheet3.B2)", "SUM('My sheet:Sheet3'!A1:B2)"],
] as [$typed, $want]) {
	$got = FormulaSyntax::toXlsx($typed);
	check($typed . ' → ' . $want, $got === $want, $got);
	$back = FormulaSyntax::fromXlsx($got);
	check('   and read back without the prefix', !str_contains($back, '_xl'), $back);
}
check('ODS: function names in capitals, references as ODS writes them', FormulaSyntax::toOds('=days(a1;b1)+Sum(a1:b2)') === 'of:=DAYS([.A1];[.B1])+SUM([.A1:.B2])', FormulaSyntax::toOds('=days(a1;b1)+Sum(a1:b2)'));
// a range across sheets kept its first sheet only ([Logical.A1:.G12]); LibreOffice's functions.ods has SHEETS of one
$across = FormulaSyntax::fromOds('of:=SHEETS([Logical.A1:Mathematical.G12])');
check('ODS: a range across sheets keeps both sheets', FormulaSyntax::toOds($across) === 'of:=SHEETS([Logical.A1:Mathematical.G12])', FormulaSyntax::toOds($across));

echo "--- opened by LibreOffice ---\n";
if (!sofficeAvailable()) {
	echo "SKIP  soffice is not installed here\n";
} else {
	$book = Model::clean(['sheets' => [['name' => 'F', 'cells' => [
		'A1' => ['f' => '=DAYS("1990-10-10";"1980-10-10")', 'v' => 3652, 't' => 'n'],
		'A2' => ['f' => '=ISOWEEKNUM(DATE(1995;1;1))', 'v' => 52, 't' => 'n'],
		'A3' => ['f' => '=days("1990-10-10";"1980-10-10")', 'v' => 3652, 't' => 'n'],
		'A4' => ['f' => '=TEXT(ORG.OPENOFFICE.EASTERSUNDAY(2014);"###.##")', 'v' => '41749', 't' => 's'],
		'A5' => ['f' => '=IFS(1>2;"a";TRUE;"b")', 'v' => 'b', 't' => 's'],
		'A6' => ['f' => '=COM.MICROSOFT.CHISQ.DIST(3;2;0)', 'v' => 0.111565080074215, 't' => 'n'],
		'A7' => ['f' => '=LEGACY.CHIDIST(13.27;5)', 'v' => 0.0209757694030221, 't' => 'n'],
	]]], 'active' => 0]);
	$tmp = sys_get_temp_dir() . '/calcbase-fn-test.xlsx';
	file_put_contents($tmp, XlsxFormat::export($book));
	$rows = loSheets($tmp, false)['F'] ?? [];
	unlink($tmp);
	$col = array_map(static fn ($r) => $r[0] ?? '', $rows);
	check('DAYS is worked out: 3652', ($col[0] ?? '') === '3652', json_encode($col));
	check('ISOWEEKNUM is worked out: 52', ($col[1] ?? '') === '52', json_encode($col));
	check('days typed in small letters too: 3652', ($col[2] ?? '') === '3652', json_encode($col));
	check('ORG.OPENOFFICE.EASTERSUNDAY is worked out: 41749', ($col[3] ?? '') === '41749', json_encode($col));
	check('IFS is worked out: b', ($col[4] ?? '') === 'b', json_encode($col));
	// Calc's own values for these, from LibreOffice's functions.ods
	check('COM.MICROSOFT.CHISQ.DIST is worked out: 0.111565…', abs((float)($col[5] ?? 0) - 0.111565080074215) < 1e-9, json_encode($col));
	check('LEGACY.CHIDIST is worked out: 0.020975…', abs((float)($col[6] ?? 0) - 0.0209757694030221) < 1e-9, json_encode($col));
}

finish();
