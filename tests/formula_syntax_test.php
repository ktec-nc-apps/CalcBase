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
	// relative, as Calc keeps a sheet typed without $ (measured: =Sheet2.A1 is saved [Sheet2.A1])
	'=Sheet2.A1' => 'of:=[Sheet2.A1]',
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

// Function names as LibreOffice 24.2 writes and reads them (FunctionNames, measured; CalcBase BUGS #38):
// of:=FDIST(…) is Calc's F.DIST, LEGACY.FDIST its FDIST, COM.MICROSOFT.FLOOR is FLOOR.XCL, an XLSX
// FLOOR is FLOOR.XCL and Calc's FLOOR is _xlfn.FLOOR.MATH there. Before, the names went through as
// they were: of:=FDIST(0.8;8;12;0) was Err:508 on the screen, Calc's FLOOR came back as Excel's (-10, not -12).
echo "--- function names (ODS, XLSX) ---\n";
foreach ([
	['ods in', F::fromOds('of:=FDIST(0.8;8;12;0)'), '=F.DIST(0.8;8;12;0)'],
	['ods in', F::fromOds('of:=LEGACY.FDIST(0.8;8;12)'), '=FDIST(0.8;8;12)'],
	['ods in', F::fromOds('of:=COM.MICROSOFT.FLOOR(-11;-2)+FLOOR(-11;-2)'), '=FLOOR.XCL(-11;-2)+FLOOR(-11;-2)'],
	['ods in', F::fromOds('of:=ROUND(ORG.OPENOFFICE.CONVERT(100;"ATS";"EUR");10)'), '=ROUND(CONVERT_OOO(100;"ATS";"EUR");10)'],
	['ods in', F::fromOds('of:=BINOM.DIST.RANGE(10;1/6;2)'), '=B(10;1/6;2)'],
	['ods in', F::fromOds('of:=COM.MICROSOFT.F.DIST.RT([.A1];2;3)'), '=F.DIST.RT(A1;2;3)'],
	['ods in', F::fromOds('of:="FDIST(1)"&MYNAME'), '="FDIST(1)"&MYNAME'],
	// ODF's ISOWEEKNUM(date; mode), as LibreOffice reads it (measured)
	['ods in', F::fromOds('of:=ISOWEEKNUM("1995-01-01";1)'), '=WEEKNUM_OOO("1995-01-01";1)'],
	['ods in', F::fromOds('of:=ISOWEEKNUM("1995-01-01";2)'), '=ISOWEEKNUM("1995-01-01")'],
	['ods in', F::fromOds('of:=ISOWEEKNUM("1995-01-01";[.B1])'), '=WEEKNUM_OOO("1995-01-01";B1)'],
	['ods in', F::fromOds('of:=ISOWEEKNUM([.A1])'), '=ISOWEEKNUM(A1)'],
	['ods out', F::toOds('=F.DIST(0.8;8;12;0)+FDIST(1;2;3)'), 'of:=FDIST(0.8;8;12;0)+LEGACY.FDIST(1;2;3)'],
	['ods out', F::toOds('=FLOOR.XCL(-11;-2)'), 'of:=COM.MICROSOFT.FLOOR(-11;-2)'],
	['ods out', F::toOds('=B(10;0.1;2)'), 'of:=BINOM.DIST.RANGE(10;0.1;2)'],
	['ods out', F::toOds('=WEEKNUM_OOO(A1;1)'), 'of:=ORG.LIBREOFFICE.WEEKNUM_OOO([.A1];1)'],
	['xlsx out', F::toXlsx('=F.DIST(0.8;8;12;0)'), '_xlfn.F.DIST(0.8,8,12,0)'],
	['xlsx out', F::toXlsx('=FDIST(0.8;8;12)'), 'FDIST(0.8,8,12)'],
	['xlsx out', F::toXlsx('=FLOOR(-11;-2)+CEILING(-11;-2)'), '_xlfn.FLOOR.MATH(-11,-2)+_xlfn.CEILING.MATH(-11,-2)'],
	['xlsx out', F::toXlsx('=FLOOR.XCL(-11;-2)'), 'FLOOR(-11,-2)'],
	['xlsx out', F::toXlsx('=ISO.CEILING(-11;-2)'), 'ISO.CEILING(-11,-2)'],
	['xlsx out', F::toXlsx('=B(10;1/6;2)'), 'B(10,1/6,2)'],
	['xlsx out', F::toXlsx('=CONVERT_OOO(100;"ATS";"EUR")'), '_xlfn.ORG.OPENOFFICE.CONVERT(100,"ATS","EUR")'],
	['xlsx out', F::toXlsx('=WEEKNUM_OOO("1995-01-01";1)'), '_xlfn.ORG.LIBREOFFICE.WEEKNUM_OOO("1995-01-01",1)'],
	['xlsx out (an older book\'s ODF name)', F::toXlsx('=COM.MICROSOFT.FLOOR(-11;-2)'), 'FLOOR(-11,-2)'],
	// the arguments Calc leaves out and LibreOffice adds in XLSX (measured: HYPGEOMDIST(2;2;90;100) is
	// _xlfn.HYPGEOM.DIST(2,2,90,100,0) there, which LibreOffice reads back; without the 0 it did not)
	['xlsx out', F::toXlsx('=HYPGEOMDIST(2;2;90;100)'), '_xlfn.HYPGEOM.DIST(2,2,90,100,0)'],
	['xlsx out', F::toXlsx('=IF(A1;"x,y";ROUND(2.5))+IF(B1)'), 'IF(A1,"x,y",ROUND(2.5,0))+IF(B1,TRUE())'],
	['xlsx out', F::toXlsx('=NORMDIST(1;0;1)+LOGNORMDIST(1)+POISSON(1;2)'), 'NORMDIST(1,0,1,1)+LOGNORMDIST(1,0,1)+POISSON(1,2,1)'],
	['xlsx in', F::fromXlsx('FLOOR(-11,-2)+_xlfn.FLOOR.MATH(-11,-2)'), '=FLOOR.XCL(-11,-2)+FLOOR.MATH(-11,-2)'],
	['xlsx in', F::fromXlsx('_xlfn.F.DIST(0.8,8,12,0)+FDIST(1,2,3)'), '=F.DIST(0.8,8,12,0)+FDIST(1,2,3)'],
	['xlsx in', F::fromXlsx('_xlfn.FORMULATEXT(A1)&TABLE(A1,B1)'), '=FORMULA(A1)&MULTIPLE.OPERATIONS(A1,B1)'],
] as [$what, $got, $want]) {
	check("$what: $want", $got === $want, $got);
}
// Inline arrays: Calc writes {1;2|3;4} (; between columns, | between rows), Excel {1,2;3,4}. An XLSX
// {1;2} is a column -- the book writes it {1|2}; the book's {1;2} (a row) is {1,2} in XLSX. Before,
// TYPE({1;2}) went into XLSX as it was and LibreOffice read it back as {1|2} (measured: LO writes {1,2}).
echo "--- inline arrays ---\n";
foreach ([
	[F::toXlsx('=TYPE({1;2})'), 'TYPE({1,2})'],
	[F::toXlsx('=SUM({1;2|3;4})'), 'SUM({1,2;3,4})'],
	[F::toXlsx('=SUM({1,2;3,4})'), 'SUM({1,2;3,4})'],
	[F::toXlsx('=FVSCHEDULE(1000;{0.03;0.04;0.05})'), 'FVSCHEDULE(1000,{0.03,0.04,0.05})'],
	[F::toXlsx('=COUNTIF({"a;b";"c"};"c")'), 'COUNTIF({"a;b","c"},"c")'],
	[F::fromXlsx('TYPE({1;2})'), '=TYPE({1|2})'],
	[F::fromXlsx('SUM({1,2;3,4})'), '=SUM({1;2|3;4})'],
	[F::fromXlsx('SUM({1,2})'), '=SUM({1;2})'],
	[F::toOds('=SUM({1,2;3,4})'), 'of:=SUM({1;2|3;4})'],
	[F::toOds('=SUM({1;2|3;4})'), 'of:=SUM({1;2|3;4})'],
	[F::toOds('=SUM({1,2})'), 'of:=SUM({1;2})'],
	[F::fromOds('of:=SUM({1;2|3;4})'), '=SUM({1;2|3;4})'],
] as [$got, $want]) {
	check("→ $want", $got === $want, $got);
}

echo "--- shifting (shared formulas) ---\n";
check('relative moves, absolute stays, sheets kept', F::shift('=A1+$B$2+Sheet2!C3+SUM(A:A)', 1, 2) === '=C2+$B$2+Sheet2!E4+SUM(C:C)', F::shift('=A1+$B$2+Sheet2!C3+SUM(A:A)', 1, 2));
check('off the sheet is #REF!', F::shift('=A1', -1, 0) === '=#REF!', F::shift('=A1', -1, 0));
check('a string is left alone', F::shift('="A1"&A1', 0, 1) === '="A1"&B1', F::shift('="A1"&A1', 0, 1));

finish();
