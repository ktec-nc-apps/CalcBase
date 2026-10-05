<?php
/**
 * The formula written three ways (FormulaSyntax): as typed, as ODS writes it,
 * as XLSX writes it -- and back; and a formula moved for a shared XLSX formula.
 *
 * Run: php tests/formula_syntax_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';

use OCA\CalcBase\Service\FormulaSyntax as F;

echo "--- to ODS ---\n";
$ods = [
	'=SUM(B2:B5)' => 'of:=SUM([.B2:.B5])',
	'=Sheet2!A1' => 'of:=[$Sheet2.A1]',
	'=Sheet2.A1' => 'of:=[$Sheet2.A1]',
	'=$Sheet2.A1' => 'of:=[$Sheet2.A1]',
	"='My sheet'!A1:B2" => "of:=[\$'My sheet'.A1:.B2]",
	'=IF(A1>1,"a,b;c",LOG10(A1))' => 'of:=IF([.A1]>1;"a,b;c";LOG10([.A1]))',
	'=$A$1+A$1+$A1' => 'of:=[.$A$1]+[.A$1]+[.$A1]',
	'=SUM(A:A)' => 'of:=SUM([.A1:.A1048576])',
	'=SUM(1:1)' => 'of:=SUM([.A1:.XFD1])',
	'=ATAN2(1;2)' => 'of:=ATAN2(1;2)',
	'=1.5E-3*A1&"x"' => 'of:=1.5E-3*[.A1]&"x"',
	'=#REF!+1' => 'of:=#REF!+1',
	'=COUNTIF(A1:A10;">5")' => 'of:=COUNTIF([.A1:.A10];">5")',
];
foreach ($ods as $in => $want) {
	$got = F::toOds($in);
	check("$in → $want", $got === $want, $got);
}

echo "--- from ODS ---\n";
$back = [
	'of:=SUM([.B2:.B5])' => '=SUM(B2:B5)',
	'of:=[$Sheet2.A1]*2' => '=$Sheet2.A1*2',
	"of:=[\$'My sheet'.A1]" => "=\$'My sheet'.A1",
	'of:=[$Sheet2.A1:.B2]' => '=$Sheet2.A1:B2',
	'of:=[.A1:.A1048576]' => '=A:A',
	'of:=[.A1:.XFD1]' => '=1:1',
	'of:=IF([.B3]>1000;"big;yes";"small")' => '=IF(B3>1000;"big;yes";"small")',
	'oooc:=[.A1]' => '=A1',
	'=[.A1]' => '=A1',
];
foreach ($back as $in => $want) {
	$got = F::fromOds($in);
	check("$in → $want", $got === $want, $got);
}

echo "--- to and from XLSX ---\n";
$xlsx = [
	'=SUM(B2:B5)' => 'SUM(B2:B5)',
	'=$Sheet2.A1' => 'Sheet2!A1',
	"=\$'My sheet'.A1:B2" => "'My sheet'!A1:B2",
	'=IF(A1>1;"a;b";2)' => 'IF(A1>1,"a;b",2)',
	'=SUM(A:A)' => 'SUM(A:A)',
	'=Sheet2!A1' => 'Sheet2!A1',
];
foreach ($xlsx as $in => $want) {
	$got = F::toXlsx($in);
	check("$in → $want", $got === $want, $got);
}
check('_xlfn. is taken off', F::fromXlsx('_xlfn.XLOOKUP(A1,B:B,C:C)') === '=XLOOKUP(A1,B:B,C:C)', F::fromXlsx('_xlfn.XLOOKUP(A1,B:B,C:C)'));
check('an XLSX formula is already as typed', F::fromXlsx("'My sheet'!A1+Other!B2") === "='My sheet'!A1+Other!B2");

echo "--- round trips ---\n";
foreach (array_keys($ods) as $f) {
	$viaOds = F::fromOds(F::toOds($f));
	check("$f survives ODS", F::toOds($viaOds) === F::toOds($f), $viaOds);
	$viaXlsx = F::fromXlsx(F::toXlsx($f));
	check("$f survives XLSX", F::toXlsx($viaXlsx) === F::toXlsx($f), $viaXlsx);
}

echo "--- shifting (shared formulas) ---\n";
check('relative moves, absolute stays, sheets kept', F::shift('=A1+$B$2+Sheet2!C3+SUM(A:A)', 1, 2) === '=C2+$B$2+Sheet2!E4+SUM(C:C)', F::shift('=A1+$B$2+Sheet2!C3+SUM(A:A)', 1, 2));
check('off the sheet is #REF!', F::shift('=A1', -1, 0) === '=#REF!', F::shift('=A1', -1, 0));
check('a string is left alone', F::shift('="A1"&A1', 0, 1) === '="A1"&B1', F::shift('="A1"&A1', 0, 1));

finish();
