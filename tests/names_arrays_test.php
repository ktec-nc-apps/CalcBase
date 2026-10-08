<?php
/**
 * Defined names, array formulas and a document's calculation settings, in and out of ODS and XLSX
 * (CalcBase BUGS #38).
 *
 * Before: an ODS or XLSX file's names were not read (=L_nb/(1+Xnb) was #NAME?, and in the
 * files CalcBase wrote LibreOffice lowercased the unknown names: =l_nb/(1+xnb)); an array formula
 * ({=PRODUCT(1+M60:M63)-1}) came in as an ordinary one (0.4 for 1.4024); and the ODS CalcBase
 * wrote said nothing of its settings, so LibreOffice read it with ODF's defaults -- regular
 * expressions, not wildcards: COUNTIF(…;"a*") found nothing.
 *
 * Run: php tests/names_arrays_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/lo_helper.php';

use OCA\CalcBase\Service\Model;
use OCA\CalcBase\Service\OdsFormat;
use OCA\CalcBase\Service\XlsxFormat;
use OCA\CalcBase\Service\ZipReader;

echo "--- an ODS file's names are read ---\n";
$m = Model::clean(OdsFormat::import(new ZipReader((string)file_get_contents(__DIR__ . '/fixtures/lo_formula-across-sheets.ods'))));
check('the book\'s names: L_nb is $Calculation.$E$7', ($m['names']['L_nb'] ?? '') === '$Calculation.$E$7', json_encode($m['names'] ?? null));
check('… and Xnb $Calculation.$E$6', ($m['names']['Xnb'] ?? '') === '$Calculation.$E$6', json_encode($m['names']['Xnb'] ?? null));
check('a named expression that is #REF! stays one', ($m['names']['B_a'] ?? '') === '#REF!', json_encode($m['names']['B_a'] ?? null));
$calc = null;
foreach ($m['sheets'] as $s) {
	if ($s['name'] === 'Calculation') {
		$calc = $s;
	}
}
check('the formula keeps the names as written', ($calc['cells']['B9']['f'] ?? '') === '=L_nb/(1+Xnb)', json_encode($calc['cells']['B9'] ?? null));

$f = Model::clean(OdsFormat::import(new ZipReader((string)file_get_contents(__DIR__ . '/fixtures/lo_functions.ods'))));
$byName = [];
foreach ($f['sheets'] as $s) {
	$byName[$s['name']] = $s;
}
check('the book\'s names (rangeX)', ($f['names']['rangeX'] ?? '') === '$Spreadsheet.$O$2:$O$6', json_encode($f['names'] ?? null));
check('a database range is a name too (VlookupTable)', ($f['names']['VlookupTable'] ?? '') === '$Mathematical.$Q$54:$R$56', json_encode($f['names']['VlookupTable'] ?? null));
check('a filter\'s unnamed range is not', !isset($f['names']['__Anonymous_Sheet_DB__4']), implode(',', array_keys($f['names'] ?? [])));
check('a sheet\'s own names stay with it (local1 on Spreadsheet)', ($byName['Spreadsheet']['names']['local1'] ?? '') === '$Spreadsheet.$O$8', json_encode($byName['Spreadsheet']['names'] ?? null));
check('… (range1 on Statistical)', ($byName['Statistical']['names']['range1'] ?? '') === '$Statistical.$O$1:$O$7', json_encode($byName['Statistical']['names'] ?? null));
check('… and not the book\'s', !isset($f['names']['local1']), json_encode(array_keys($f['names'] ?? [])));
check('a file with no calculation settings reads regular expressions (ODF)', ($f['calc'] ?? null) === ['regex' => true], json_encode($f['calc'] ?? null));
check('an array formula keeps its range', ($byName['Mathematical']['cells']['C63']['a'] ?? '') === 'C63:C63' && ($byName['Mathematical']['cells']['C63']['f'] ?? '') === '=PRODUCT(1+M60:M63)-1', json_encode($byName['Mathematical']['cells']['C63'] ?? null));

echo "--- written out, LibreOffice uses them ---\n";
$book = Model::clean([
	'sheets' => [
		['name' => 'Data', 'cells' => [
			'A1' => ['v' => 2, 't' => 'n'], 'A2' => ['v' => 3, 't' => 'n'], 'A3' => ['v' => 5, 't' => 'n'],
			'B1' => ['v' => 'apple', 't' => 's'], 'B2' => ['v' => 'Apple', 't' => 's'], 'B3' => ['v' => 'ab', 't' => 's'],
			'C1' => ['f' => '=SUM(Vals)', 'v' => 10, 't' => 'n'],
			'C2' => ['f' => '=Own*2', 'v' => 4, 't' => 'n'],
			'C3' => ['f' => '=COUNTIF(B1:B3;"a*")', 'v' => 3, 't' => 'n'],
			'C4' => ['f' => '=SUM(A1:A3*2)', 'v' => 20, 't' => 'n', 'a' => 'C4:C4'],
			'C5' => ['f' => '=Twice', 'v' => 20, 't' => 'n'],
		], 'names' => ['Own' => '$Data.$A$1']],
	],
	'names' => ['Vals' => '$Data.$A$1:$A$3', 'Twice' => 'SUM($Data.$A$1:$A$3)*2'],
	'active' => 0,
]);
check('the model keeps names, a sheet\'s own names and the array formula', isset($book['names']['Vals'], $book['sheets'][0]['names']['Own']) && ($book['sheets'][0]['cells']['C4']['a'] ?? '') === 'C4:C4', json_encode($book));
if (!sofficeAvailable()) {
	echo "SKIP  soffice is not installed here\n";
} else {
	foreach (['ods' => OdsFormat::export($book), 'xlsx' => XlsxFormat::export($book)] as $ext => $bytes) {
		$tmp = sys_get_temp_dir() . '/calcbase-names-test.' . $ext;
		file_put_contents($tmp, $bytes);
		$rows = loSheets($tmp, false)['Data'] ?? [];
		unlink($tmp);
		check("$ext: =SUM(Vals) with the book's name is 10", ($rows[0][2] ?? '') === '10', json_encode($rows[0] ?? null));
		check("$ext: =Own*2 with the sheet's own name is 4", ($rows[1][2] ?? '') === '4', json_encode($rows[1] ?? null));
		check("$ext: COUNTIF(…;\"a*\") reads wildcards: 3", ($rows[2][2] ?? '') === '3', json_encode($rows[2] ?? null));
		check("$ext: the array formula {=SUM(A1:A3*2)} is 20", ($rows[3][2] ?? '') === '20', json_encode($rows[3] ?? null));
		check("$ext: a named expression =Twice is 20", ($rows[4][2] ?? '') === '20', json_encode($rows[4] ?? null));
	}
	// read back: the names come in again
	$again = Model::clean(XlsxFormat::import(new ZipReader(XlsxFormat::export($book))));
	check('xlsx in: the book\'s names', ($again['names']['Vals'] ?? '') === 'Data!$A$1:$A$3', json_encode($again['names'] ?? null));
	check('xlsx in: the sheet\'s own', ($again['sheets'][0]['names']['Own'] ?? '') === 'Data!$A$1', json_encode($again['sheets'][0]['names'] ?? null));
	check('xlsx in: the array formula', ($again['sheets'][0]['cells']['C4']['a'] ?? '') === 'C4:C4', json_encode($again['sheets'][0]['cells']['C4'] ?? null));
	check('xlsx in: not case-sensitive, as Calc reads XLSX', ($again['calc'] ?? null) === ['caseSensitive' => false], json_encode($again['calc'] ?? null));
	$again = Model::clean(OdsFormat::import(new ZipReader(OdsFormat::export($book))));
	check('ods in: the book\'s names', ($again['names']['Vals'] ?? '') === '$Data.$A$1:$A$3' && ($again['names']['Twice'] ?? '') === 'SUM($Data.$A$1:$A$3)*2', json_encode($again['names'] ?? null));
	check('ods in: a book of wildcards stays one', !isset($again['calc']), json_encode($again['calc'] ?? null));
}

finish();
