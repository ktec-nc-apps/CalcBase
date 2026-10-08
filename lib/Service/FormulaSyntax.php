<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * One formula in the three ways it is written.
 *
 * In a book (design contract §2) a formula is as the person typed it, in Calc
 * or Excel A1 syntax: =SUM(B2:B5), =Sheet2.A1, =$Sheet2.A1, =Sheet2!A1,
 * ='My sheet'!A1, with , or ; between arguments. An ODS file writes
 * of:=SUM([.B2:.B5]) and [$Sheet2.A1] with ; between arguments; an XLSX file
 * writes SUM(B2:B5) and Sheet2!A1 with , between them. The conversion is a
 * walk over tokens -- string literals are left alone, references are rewritten,
 * separators swapped -- not a parse of the formula: the engine in the browser
 * does that, and the server has no say in what a formula means.
 */
final class FormulaSyntax {
	/** A formula written as the person types it, as an ODS table:formula attribute. */
	public static function toOds(string $formula): string {
		$body = self::body($formula);
		return 'of:=' . self::walk($body, ';', static fn (array $ref): string => self::odsRef($ref), false, static function (string $name): string {
			$name = self::native(strtoupper($name));
			return FunctionNames::NATIVE_TO_ODF[$name] ?? $name;
		}, 'calc');
	}

	/**
	 * A function's name as the book means it: as typed in Calc (FunctionNames' NATIVE). A book
	 * made before the names were read from the file may still say COM.MICROSOFT.FLOOR or
	 * LEGACY.FDIST, which are Calc's FLOOR.XCL and FDIST; a name a person types is left as it is.
	 */
	private static function native(string $name): string {
		if (preg_match('/^(?:COM\.MICROSOFT\.|LEGACY\.|ORG\.OPENOFFICE\.|ORG\.LIBREOFFICE\.|COM\.SUN\.STAR\.)/', $name)) {
			return FunctionNames::ODF_TO_NATIVE[$name] ?? $name;
		}
		return $name;
	}

	/** An ODS table:formula attribute as a person would type it (Calc style: $Sheet2.A1, ; kept). */
	public static function fromOds(string $attr): string {
		$body = trim($attr);
		// of:= or oooc:= (older files), or a plain = from a hand-written file.
		if (preg_match('/^[A-Za-z]+:=/', $body)) {
			$body = substr($body, strpos($body, ':=') + 2);
		} elseif (str_starts_with($body, '=')) {
			$body = substr($body, 1);
		}
		$out = '';
		$n = strlen($body);
		$i = 0;
		while ($i < $n) {
			$ch = $body[$i];
			if ($ch === '"') {
				$end = self::stringEnd($body, $i);
				$out .= substr($body, $i, $end - $i);
				$i = $end;
				continue;
			}
			if ($ch === '[') {
				$close = strpos($body, ']', $i);
				if ($close === false) {
					$out .= substr($body, $i);
					break;
				}
				$out .= self::odsRefToTyped(substr($body, $i + 1, $close - $i - 1));
				$i = $close + 1;
				continue;
			}
			// A function's name, as Calc names it when it shows the formula (of:=FDIST(…) is F.DIST,
			// LEGACY.FDIST is FDIST, COM.MICROSOFT.FLOOR is FLOOR.XCL: FunctionNames, measured).
			if ((ctype_alpha($ch) || $ch === '_') && ($i === 0 || !preg_match('/[A-Za-z0-9_.$]/', $body[$i - 1]))
				&& preg_match('/\G([A-Za-z_][A-Za-z0-9_.]*)(\s*\()/', $body, $m, 0, $i)) {
				$name = strtoupper($m[1]);
				if ($name === 'ISOWEEKNUM') {
					$iso = self::isoWeeknum($body, $i + strlen($m[0]));
					if ($iso !== null) {
						$out .= $iso[0];
						$i = $iso[1];
						continue;
					}
				}
				$out .= (FunctionNames::ODF_TO_NATIVE[$name] ?? $m[1]) . $m[2];
				$i += strlen($m[0]);
				continue;
			}
			$out .= $ch;
			$i++;
		}
		return '=' . $out;
	}

	/**
	 * ODF's ISOWEEKNUM(date; mode), as LibreOffice 24.2 reads it (measured): a mode of 1 is
	 * WEEKNUM_OOO(date; 1), any other number is ISOWEEKNUM(date), and a mode that is not a
	 * number written out (a reference, a formula) is WEEKNUM_OOO(date; mode). With one argument
	 * it stays ISOWEEKNUM. $at is just past the opening parenthesis; null when there is no
	 * second argument. Returns the text up to and including the closing parenthesis and where
	 * the walk goes on.
	 *
	 * @return array{0: string, 1: int}|null
	 */
	private static function isoWeeknum(string $body, int $at): ?array {
		$args = self::topArgs($body, $at);
		if ($args === null || count($args[0]) !== 2) {
			return null;
		}
		[$date, $mode] = $args[0];
		$date = substr(self::fromOds('of:=' . $date), 1);
		$modeText = trim($mode);
		if (preg_match('/^[+-]?\d+(?:\.\d*)?$/', $modeText)) {
			$text = (float)$modeText == 1.0 ? 'WEEKNUM_OOO(' . $date . ';' . $modeText . ')' : 'ISOWEEKNUM(' . $date . ')';
		} else {
			$text = 'WEEKNUM_OOO(' . $date . ';' . substr(self::fromOds('of:=' . $mode), 1) . ')';
		}
		return [$text, $args[1]];
	}

	/**
	 * The arguments of a call whose opening parenthesis is just before $at, split at the
	 * separators (, or ;) that are not inside strings, brackets, braces or parentheses.
	 *
	 * @return array{0: list<string>, 1: int}|null the arguments, and the index past the closing parenthesis
	 */
	private static function topArgs(string $s, int $at): ?array {
		$n = strlen($s);
		$depth = 0;
		$args = [];
		$from = $at;
		for ($i = $at; $i < $n; $i++) {
			$ch = $s[$i];
			if ($ch === '"') {
				$i = self::stringEnd($s, $i) - 1;
			} elseif ($ch === '(' || $ch === '[' || $ch === '{') {
				$depth++;
			} elseif ($ch === ')' || $ch === ']' || $ch === '}') {
				if ($depth === 0) {
					$args[] = substr($s, $from, $i - $from);
					return [$args, $i + 1];
				}
				$depth--;
			} elseif (($ch === ';' || $ch === ',') && $depth === 0) {
				$args[] = substr($s, $from, $i - $from);
				$from = $i + 1;
			}
		}
		return null;
	}

	/**
	 * The functions an XLSX file names with the _xlfn. prefix: the ones newer
	 * than Excel 2007, and Calc's own that Excel does not have, as LibreOffice
	 * 24.2 writes them (its OOXML function table). Without the prefix Calc and
	 * Excel do not know them: =DAYS(…) came back as =days(…) and #NAME?.
	 */
	private const XLFN = ['ACOT', 'ACOTH', 'AGGREGATE', 'ARABIC', 'BAHTTEXT', 'BASE', 'BETA.DIST', 'BETA.INV', 'BINOM.DIST', 'BINOM.DIST.RANGE', 'BINOM.INV',
		'BITAND', 'BITLSHIFT', 'BITOR', 'BITRSHIFT', 'BITXOR', 'CEILING.MATH', 'CEILING.PRECISE', 'CHISQ.DIST', 'CHISQ.DIST.RT', 'CHISQ.INV', 'CHISQ.INV.RT',
		'CHISQ.TEST', 'COMBINA', 'CONCAT', 'CONFIDENCE.NORM', 'CONFIDENCE.T', 'COT', 'COTH', 'COVARIANCE.P', 'COVARIANCE.S', 'CSC', 'CSCH', 'DAYS', 'DECIMAL',
		'ENCODEURL', 'ERF.PRECISE', 'ERFC.PRECISE', 'EXPON.DIST', 'F.DIST', 'F.DIST.RT', 'F.INV', 'F.INV.RT', 'F.TEST', 'FILTERXML', 'FLOOR.MATH',
		'FLOOR.PRECISE', 'FORECAST.ETS', 'FORECAST.ETS.CONFINT', 'FORECAST.ETS.SEASONALITY', 'FORECAST.ETS.STAT', 'FORECAST.LINEAR', 'FORMULATEXT', 'GAMMA',
		'GAMMA.DIST', 'GAMMA.INV', 'GAMMALN.PRECISE', 'GAUSS', 'HYPGEOM.DIST', 'IFNA', 'IFS', 'IMCOSH', 'IMCOT', 'IMCSC', 'IMCSCH', 'IMSEC', 'IMSECH',
		'IMSINH', 'IMTAN', 'ISFORMULA', 'ISO.CEILING', 'ISOWEEKNUM', 'LOGNORM.DIST', 'LOGNORM.INV', 'MAXIFS', 'MINIFS', 'MODE.MULT', 'MODE.SNGL', 'MUNIT',
		'NEGBINOM.DIST', 'NETWORKDAYS.INTL', 'NORM.DIST', 'NORM.INV', 'NORM.S.DIST', 'NORM.S.INV', 'NUMBERVALUE', 'PDURATION', 'PERCENTILE.EXC',
		'PERCENTILE.INC', 'PERCENTRANK.EXC', 'PERCENTRANK.INC', 'PERMUTATIONA', 'PHI', 'POISSON.DIST', 'QUARTILE.EXC', 'QUARTILE.INC', 'RANK.AVG', 'RANK.EQ',
		'RRI', 'SEC', 'SECH', 'SHEET', 'SHEETS', 'SKEW.P', 'STDEV.P', 'STDEV.S', 'SWITCH', 'T.DIST', 'T.DIST.2T', 'T.DIST.RT', 'T.INV', 'T.INV.2T', 'T.TEST',
		'TEXTJOIN', 'UNICHAR', 'UNICODE', 'VAR.P', 'VAR.S', 'WEBSERVICE', 'WEIBULL.DIST', 'WORKDAY.INTL', 'XOR', 'Z.TEST',
		// Excel 365's, which Excel itself writes so
		'XLOOKUP', 'XMATCH', 'SEQUENCE', 'RANDARRAY', 'LET', 'LAMBDA', 'TEXTBEFORE', 'TEXTAFTER', 'TEXTSPLIT', 'VSTACK', 'HSTACK', 'TAKE', 'DROP',
		'CHOOSECOLS', 'CHOOSEROWS', 'TOCOL', 'TOROW', 'WRAPCOLS', 'WRAPROWS', 'EXPAND', 'ARRAYTOTEXT', 'VALUETOTEXT',
		// Calc's own (ORG.LIBREOFFICE.* all of them, ORG.OPENOFFICE.* these)
		'ORG.OPENOFFICE.CONVERT', 'ORG.OPENOFFICE.CURRENT', 'ORG.OPENOFFICE.EASTERSUNDAY', 'ORG.OPENOFFICE.ERRORTYPE', 'ORG.OPENOFFICE.GOALSEEK',
		'ORG.OPENOFFICE.MULTIRANGE', 'ORG.OPENOFFICE.STYLE'];
	/** Excel 365's that go under a second prefix, _xlfn._xlws. */
	private const XLWS = ['FILTER', 'SORT', 'SORTBY', 'UNIQUE'];

	/** A formula written as the person types it, as the text of an XLSX <f> element (no leading =). */
	public static function toXlsx(string $formula): string {
		return self::completeArgs(self::walk(self::body($formula), ',', static fn (array $ref): string => self::xlsxRef($ref), true, static function (string $name): string {
			$name = self::native(strtoupper(preg_replace('/^(?:_xlfn\.|_xlws\.)+/i', '', $name) ?? $name));
			// as LibreOffice 24.2 writes it (FunctionNames, measured): F.DIST is _xlfn.F.DIST,
			// Calc's FLOOR _xlfn.FLOOR.MATH, FLOOR.XCL plain FLOOR, B stays B
			if (isset(FunctionNames::NATIVE_TO_OOXML[$name])) {
				return FunctionNames::NATIVE_TO_OOXML[$name];
			}
			// Calc's names for Excel's functions, as an ODS file brings them, are Excel's
			// own in an XLSX file: COM.MICROSOFT.CHISQ.DIST is _xlfn.CHISQ.DIST,
			// LEGACY.CHIDIST is CHIDIST, FORMULA is _xlfn.FORMULATEXT (as LibreOffice
			// 24.2 writes them; left as they were, Calc read them back as #NAME?).
			$name = preg_replace('/^(?:COM\.MICROSOFT\.|LEGACY\.)/', '', $name) ?? $name;
			if ($name === 'FORMULA') {
				$name = 'FORMULATEXT';
			}
			if (in_array($name, self::XLWS, true)) {
				return '_xlfn._xlws.' . $name;
			}
			return in_array($name, self::XLFN, true) || str_starts_with($name, 'ORG.LIBREOFFICE.') ? '_xlfn.' . $name : $name;
		}, 'excel'));
	}

	/**
	 * The arguments Calc leaves out and Excel needs, as LibreOffice 24.2 writes them into an XLSX
	 * file (measured): IF(x) is IF(x,TRUE()), ROUND(x) ROUND(x,0), HYPGEOMDIST's four arguments
	 * HYPGEOM.DIST(…,0), NORMDIST(x,m,s) NORMDIST(x,m,s,1) … -- name => [arguments it has, what follows].
	 */
	private const XLSX_MORE_ARGS = [
		'IF' => [[1, 'TRUE()']], 'ROUND' => [[1, '0']], 'ROUNDUP' => [[1, '0']], 'ROUNDDOWN' => [[1, '0']],
		'_XLFN.HYPGEOM.DIST' => [[4, '0']], 'EUROCONVERT' => [[3, '0']], 'NORMDIST' => [[3, '1']], 'GAMMADIST' => [[3, '1']],
		'POISSON' => [[2, '1']], 'LOGNORMDIST' => [[1, '0'], [2, '1']], 'LOGINV' => [[1, '0'], [2, '1']],
	];

	/** XLSX formula text with XLSX_MORE_ARGS added where they are left out (calls inside calls too). */
	private static function completeArgs(string $x): string {
		$out = '';
		$n = strlen($x);
		$i = 0;
		while ($i < $n) {
			$ch = $x[$i];
			if ($ch === '"') {
				$end = self::stringEnd($x, $i);
				$out .= substr($x, $i, $end - $i);
				$i = $end;
				continue;
			}
			if (($i === 0 || !preg_match('/[A-Za-z0-9_.$!\']/', $x[$i - 1])) && preg_match('/\G([A-Za-z_][A-Za-z0-9_.]*)\(/', $x, $m, 0, $i)) {
				$more = self::XLSX_MORE_ARGS[strtoupper($m[1])] ?? null;
				$args = self::topArgs($x, $i + strlen($m[0]));
				if ($args !== null) {
					$list = array_map(static fn (string $a): string => self::completeArgs($a), $args[0]);
					$count = count($list) === 1 && trim($list[0]) === '' ? 0 : count($list);
					foreach ($more ?? [] as [$has, $add]) {
						if ($count === $has) {
							$list[] = $add;
							$count++;
						}
					}
					$out .= $m[1] . '(' . implode(',', $list) . ')';
					$i = $args[1];
					continue;
				}
			}
			$out .= $ch;
			$i++;
		}
		return $out;
	}

	/** The text of an XLSX <f> element as a person would type it: already A1 syntax, Excel's own prefixes taken off. */
	public static function fromXlsx(string $text): string {
		$body = trim($text);
		if (str_starts_with($body, '=')) {
			$body = substr($body, 1);
		}
		return '=' . self::walk($body, ',', static fn (array $ref): string => self::xlsxRef($ref), true, static function (string $name): string {
			// as LibreOffice 24.2 reads it (FunctionNames, measured): FLOOR is FLOOR.XCL, _xlfn.F.DIST is F.DIST
			$up = strtoupper($name);
			if (isset(FunctionNames::OOXML_TO_NATIVE[$up])) {
				return FunctionNames::OOXML_TO_NATIVE[$up];
			}
			return preg_replace('/^(?:_xlfn\.|_xlws\.)+/i', '', $name) ?? $name;
		}, 'fromExcel');
	}

	/**
	 * The same formula moved by $dr rows and $dc columns, for a shared formula
	 * in an XLSX file written once for a block of cells: relative references
	 * move with it, $-absolute ones stay, and a reference pushed off the sheet
	 * becomes #REF!. Sheet names and the separator are kept as written.
	 */
	public static function shift(string $formula, int $dr, int $dc): string {
		$body = self::body($formula);
		$moved = self::walk($body, null, static function (array $ref) use ($dr, $dc): string {
			$a = self::shiftEnd($ref['a'], $dr, $dc);
			$b = $ref['b'] === null ? null : self::shiftEnd($ref['b'], $dr, $dc);
			if ($a === null || ($ref['b'] !== null && $b === null)) {
				return '#REF!';
			}
			$text = self::sheetPrefix($ref, $ref['style']) . $a;
			if ($b !== null) {
				$text .= ':' . ($ref['bsheet'] !== null ? self::sheetPrefix(['sheet' => $ref['bsheet'], 'dollar' => $ref['bdollar'], 'quoted' => $ref['bquoted']], $ref['style']) : '') . $b;
			}
			return $text;
		}, false);
		return '=' . $moved;
	}

	// ---- the walk over tokens ----

	/** The formula without its leading =. */
	private static function body(string $formula): string {
		$f = trim($formula);
		return str_starts_with($f, '=') ? substr($f, 1) : $f;
	}

	/**
	 * Walk the body: strings are copied, references handed to $ref, argument
	 * separators (, or ;) swapped for $sep when one is given, Excel's _xlfn.
	 * prefixes taken off when $stripXl. Everything else is copied as it is.
	 *
	 * @param callable(array): string $ref
	 */
	private static function walk(string $body, ?string $sep, callable $ref, bool $stripXl, ?callable $function = null, ?string $arrays = null): string {
		$out = '';
		$n = strlen($body);
		$i = 0;
		$braces = 0;
		while ($i < $n) {
			$ch = $body[$i];
			if ($ch === '"') {
				$end = self::stringEnd($body, $i);
				$out .= substr($body, $i, $end - $i);
				$i = $end;
				continue;
			}
			// An inline array, its separators as the target writes them ({1;2|3;4} in Calc and ODS,
			// {1,2;3,4} in Excel): an XLSX {1;2} is a column, which the book writes {1|2}.
			if ($ch === '{' && $arrays !== null && $braces === 0) {
				$close = self::arrayEnd($body, $i);
				if ($close !== null) {
					$out .= self::arrayText(substr($body, $i + 1, $close - $i - 1), $arrays);
					$i = $close + 1;
					continue;
				}
			}
			if ($ch === '{') {
				$braces++;
			} elseif ($ch === '}') {
				$braces = max(0, $braces - 1);
			}
			// An inline array {1;2|3;4} has separators of its own; left as written.
			if (($ch === ',' || $ch === ';') && $sep !== null && $braces === 0) {
				$out .= $sep;
				$i++;
				continue;
			}
			// An error literal is not a reference: #REF! must not be read as REF + !.
			if ($ch === '#' && preg_match('/\G#(?:DIV\/0!|N\/A|REF!|NAME\?|NUM!|VALUE!|NULL!)/', $body, $m, 0, $i)) {
				$out .= $m[0];
				$i += strlen($m[0]);
				continue;
			}
			if ($ch === "'" || $ch === '$' || ctype_alpha($ch) || $ch === '_' || ctype_digit($ch)) {
				$tok = self::reference($body, $i);
				if ($tok !== null) {
					$out .= $ref($tok['ref']);
					$i = $tok['end'];
					continue;
				}
				if (preg_match('/\G[A-Za-z_][A-Za-z0-9_.]*/', $body, $m, 0, $i)) {
					$word = $m[0];
					// A function's name, as the file format writes it (a name followed by "("):
					// the callback sees Excel's prefixes, which tell one function from another.
					if ($function !== null && preg_match('/\G\s*\(/', $body, $paren, 0, $i + strlen($m[0]))) {
						$word = $function($word);
					} elseif ($stripXl) {
						$word = preg_replace('/^(?:_xlfn\.|_xlws\.|_xlpm\.)+/i', '', $word) ?? $word;
					}
					$out .= $word;
					$i += strlen($m[0]);
					continue;
				}
				if (preg_match('/\G\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/', $body, $m, 0, $i)) {
					$out .= $m[0];
					$i += strlen($m[0]);
					continue;
				}
			}
			$out .= $ch;
			$i++;
		}
		return $out;
	}

	/** The index just past the string literal starting at $i (its closing quote included; "" inside is one quote). */
	private static function stringEnd(string $s, int $i): int {
		$n = strlen($s);
		$j = $i + 1;
		while ($j < $n) {
			if ($s[$j] === '"') {
				if ($j + 1 < $n && $s[$j + 1] === '"') {
					$j += 2;
					continue;
				}
				return $j + 1;
			}
			$j++;
		}
		return $n;
	}

	/** A sheet name: quoted 'My sheet' ('' for one quote) or a bare identifier; with the optional $ before it. */
	private const SHEET = '(?:(\$?)(?:\'((?:[^\']|\'\')+)\'|([A-Za-z_][A-Za-z0-9_]*))\s*([!.]))?';
	/** A cell: $A$1. */
	private const CELL = '(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})';

	/**
	 * A reference starting at $i -- a cell, a range, a whole column or row,
	 * sheet-qualified or not -- or null when what starts there is not one.
	 *
	 * @return array{ref: array<string, mixed>, end: int}|null
	 */
	private static function reference(string $s, int $i): ?array {
		// A cell or a range of cells.
		$re = '/\G' . self::SHEET . self::CELL . '(?::' . self::SHEET . self::CELL . ')?/';
		if (preg_match($re, $s, $m, PREG_UNMATCHED_AS_NULL, $i)) {
			$end = $i + strlen($m[0]);
			if (self::continues($s, $end)) {
				// LOG10( or A1B: letters and digits that go on are a name, not a cell.
			} else {
				$ref = self::sheetPart($m[1], $m[2], $m[3], $m[4]) + [
					'a' => ['cd' => $m[5] === '$', 'col' => strtoupper($m[6]), 'rd' => $m[7] === '$', 'row' => (int)$m[8], 'kind' => 'cell'],
					'b' => null, 'bsheet' => null, 'bdollar' => false, 'bquoted' => false,
				];
				if ($m[10] !== null || $m[11] !== null) {
					// a range across sheets: Sheet1.A1:Sheet3.B2 (the second sheet was dropped when bare)
					$b = self::sheetPart($m[9], $m[10], $m[11], $m[12]);
					$ref['bsheet'] = $b['sheet'];
					$ref['bdollar'] = $b['dollar'];
					$ref['bquoted'] = $b['quoted'];
					$ref['b'] = ['cd' => $m[13] === '$', 'col' => strtoupper($m[14]), 'rd' => $m[15] === '$', 'row' => (int)$m[16], 'kind' => 'cell'];
				} elseif ($m[13] !== null) {
					$ref['b'] = ['cd' => $m[13] === '$', 'col' => strtoupper($m[14]), 'rd' => $m[15] === '$', 'row' => (int)$m[16], 'kind' => 'cell'];
				}
				if (Cells::colIndex($ref['a']['col']) >= 0 && ($ref['b'] === null || Cells::colIndex($ref['b']['col']) >= 0)) {
					return ['ref' => $ref, 'end' => $end];
				}
			}
		}
		// Whole columns A:A, $A:$C.
		$re = '/\G' . self::SHEET . '(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(])/';
		if (preg_match($re, $s, $m, PREG_UNMATCHED_AS_NULL, $i) && Cells::colIndex($m[6]) >= 0 && Cells::colIndex($m[8]) >= 0) {
			$ref = self::sheetPart($m[1], $m[2], $m[3], $m[4]) + [
				'a' => ['cd' => $m[5] === '$', 'col' => strtoupper($m[6]), 'kind' => 'col'],
				'b' => ['cd' => $m[7] === '$', 'col' => strtoupper($m[8]), 'kind' => 'col'],
				'bsheet' => null, 'bdollar' => false, 'bquoted' => false,
			];
			return ['ref' => $ref, 'end' => $i + strlen($m[0])];
		}
		// Whole rows 1:1, $2:$5 -- only where a number could not be meant (a colon follows digits).
		$re = '/\G' . self::SHEET . '(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![0-9.(])/';
		if (preg_match($re, $s, $m, PREG_UNMATCHED_AS_NULL, $i) && ($i === 0 || !preg_match('/[A-Za-z0-9_.$]/', $s[$i - 1]))) {
			$ref = self::sheetPart($m[1], $m[2], $m[3], $m[4]) + [
				'a' => ['rd' => $m[5] === '$', 'row' => (int)$m[6], 'kind' => 'row'],
				'b' => ['rd' => $m[7] === '$', 'row' => (int)$m[8], 'kind' => 'row'],
				'bsheet' => null, 'bdollar' => false, 'bquoted' => false,
			];
			return ['ref' => $ref, 'end' => $i + strlen($m[0])];
		}
		return null;
	}

	/** Whether an identifier goes on after $end (so what was matched is part of a name or a function). */
	private static function continues(string $s, int $end): bool {
		if ($end >= strlen($s)) {
			return false;
		}
		$c = $s[$end];
		return ctype_alnum($c) || $c === '_' || $c === '(' || $c === '.';
	}

	/** @return array{sheet: ?string, dollar: bool, quoted: bool, style: string} */
	private static function sheetPart(?string $dollar, ?string $quoted, ?string $bare, ?string $mark): array {
		if ($quoted === null && $bare === null) {
			return ['sheet' => null, 'dollar' => false, 'quoted' => false, 'style' => ''];
		}
		return [
			'sheet' => $quoted !== null ? str_replace("''", "'", $quoted) : $bare,
			'dollar' => $dollar === '$',
			'quoted' => $quoted !== null,
			'style' => $mark === '!' ? '!' : '.',
		];
	}

	/** One end of a reference written out again, as typed. */
	private static function endText(array $end): string {
		return match ($end['kind']) {
			'cell' => ($end['cd'] ? '$' : '') . $end['col'] . ($end['rd'] ? '$' : '') . $end['row'],
			'col' => ($end['cd'] ? '$' : '') . $end['col'],
			default => ($end['rd'] ? '$' : '') . $end['row'],
		};
	}

	private static function sheetPrefix(array $ref, string $style): string {
		if (($ref['sheet'] ?? null) === null) {
			return '';
		}
		$name = $ref['quoted'] ? "'" . str_replace("'", "''", $ref['sheet']) . "'" : $ref['sheet'];
		return ($ref['dollar'] ? '$' : '') . $name . ($style === '!' ? '!' : '.');
	}

	/** One end moved by (dr, dc), as text; null when it leaves the sheet. */
	private static function shiftEnd(array $end, int $dr, int $dc): ?string {
		if ($end['kind'] !== 'row' && !$end['cd']) {
			$c = Cells::colIndex($end['col']) + $dc;
			if ($c < 0 || $c >= Cells::MAX_COLS) {
				return null;
			}
			$end['col'] = Cells::colName($c);
		}
		if ($end['kind'] !== 'col' && !$end['rd']) {
			$r = $end['row'] + $dr;
			if ($r < 1 || $r > Cells::MAX_ROWS) {
				return null;
			}
			$end['row'] = $r;
		}
		return self::endText($end);
	}

	/** The index of the } that closes the inline array opened at $i (strings inside skipped), or null. */
	private static function arrayEnd(string $s, int $i): ?int {
		$n = strlen($s);
		for ($j = $i + 1; $j < $n; $j++) {
			if ($s[$j] === '"') {
				$j = self::stringEnd($s, $j) - 1;
			} elseif ($s[$j] === '}') {
				return $j;
			} elseif ($s[$j] === '{') {
				return null;
			}
		}
		return null;
	}

	/**
	 * The inside of an inline array written again for $to: 'calc' ({1;2|3;4}: ODS and the book),
	 * 'excel' ({1,2;3,4}: XLSX). The book's own text is read as the engine reads it: with | it
	 * is Calc's, with both , and ; Excel's, otherwise one row. 'fromExcel' reads it as Excel
	 * does (; between rows) and writes it as Calc does.
	 */
	private static function arrayText(string $inner, string $to): string {
		$items = [];
		$seps = [];
		$n = strlen($inner);
		$from = 0;
		for ($j = 0; $j < $n; $j++) {
			$ch = $inner[$j];
			if ($ch === '"') {
				$j = self::stringEnd($inner, $j) - 1;
			} elseif ($ch === ';' || $ch === ',' || $ch === '|') {
				$items[] = substr($inner, $from, $j - $from);
				$seps[] = $ch;
				$from = $j + 1;
			}
		}
		$items[] = substr($inner, $from);
		if ($to === 'fromExcel') {
			$row = ';';
		} elseif (in_array('|', $seps, true)) {
			$row = '|';
		} elseif (in_array(',', $seps, true) && in_array(';', $seps, true)) {
			$row = ';';
		} else {
			$row = null;
		}
		[$col, $rowOut] = $to === 'excel' ? [',', ';'] : [';', '|'];
		$out = $items[0];
		foreach ($seps as $k => $sep) {
			$out .= ($sep === $row ? $rowOut : $col) . $items[$k + 1];
		}
		return '{' . $out . '}';
	}

	// ---- ODS ----

	/** [.B2], [.B2:.B5], [$Sheet2.A1], [$'My sheet'.A1:.B2]; whole columns and rows as the cells they cover. */
	private static function odsRef(array $ref): string {
		// The sheet is absolute ($Sheet2) when it was typed so, or written the Excel
		// way (Sheet2!A1: Excel's sheet references are all absolute, and Calc reads an
		// XLSX file's so); Sheet2.A1 is relative, as Calc keeps it (typed in Calc
		// 24.2: =Sheet2.A1 is saved [Sheet2.A1], =$Sheet2.A1 [$Sheet2.A1]).
		$abs = static fn (bool $dollar): string => $dollar || $ref['style'] === '!' ? '$' : '';
		$sheet = $ref['sheet'] === null ? '' : $abs($ref['dollar']) . self::odsSheetName($ref['sheet']);
		$a = $ref['a'];
		$b = $ref['b'];
		if ($a['kind'] === 'col') {
			// As Calc writes A:A -- the first and last row, without $ (Calc knows the pair as a whole column).
			$a = ['cd' => $a['cd'], 'col' => $a['col'], 'rd' => false, 'row' => 1, 'kind' => 'cell'];
			$b = ['cd' => $b['cd'], 'col' => $b['col'], 'rd' => false, 'row' => Cells::MAX_ROWS, 'kind' => 'cell'];
		} elseif ($a['kind'] === 'row') {
			$a = ['cd' => false, 'col' => 'A', 'rd' => $a['rd'], 'row' => $a['row'], 'kind' => 'cell'];
			$b = ['cd' => false, 'col' => Cells::LAST_COL, 'rd' => $b['rd'], 'row' => $b['row'], 'kind' => 'cell'];
		}
		$out = '[' . $sheet . '.' . self::endText($a);
		if ($b !== null) {
			$bsheet = $ref['bsheet'] === null ? '' : $abs($ref['bdollar']) . self::odsSheetName($ref['bsheet']);
			$out .= ':' . $bsheet . '.' . self::endText($b);
		}
		return $out . ']';
	}

	/** A sheet name as ODS quotes it: bare when it could be an identifier, 'quoted' otherwise. */
	private static function odsSheetName(string $name): string {
		return preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name) ? $name : "'" . str_replace("'", "''", $name) . "'";
	}

	/** What is inside [ ] in an ODS formula, as a person types it ($Sheet2.A1, A1:B2). */
	private static function odsRefToTyped(string $inside): string {
		$parts = explode(':', $inside, 2);
		$a = self::odsEnd($parts[0]);
		if ($a === null) {
			return $inside;
		}
		$out = $a['sheet'] . $a['cell'];
		if (isset($parts[1])) {
			$b = self::odsEnd($parts[1]);
			if ($b === null) {
				return $inside;
			}
			// [.A1:.A1048576] is a whole column, [.A1:.XFD1] a whole row: typed as A:A and 1:1.
			$whole = self::wholeOf($a['cell'], $b['cell']);
			if ($whole !== null && $b['sheet'] === '') {
				return $a['sheet'] . $whole;
			}
			$out .= ':' . $b['sheet'] . $b['cell'];
		}
		return $out;
	}

	/** @return array{sheet: string, cell: string}|null */
	private static function odsEnd(string $end): ?array {
		// $'My sheet'.A1 | $Sheet2.A1 | Sheet2.A1 | .A1 | #REF!
		if (preg_match('/^(\$?)(?:\'((?:[^\']|\'\')*)\'|([^.\'\s]*))\.(\$?[A-Za-z]{1,3}\$?\d{1,7})$/', trim($end), $m)) {
			if ($m[2] === '' && $m[3] === '') {
				return ['sheet' => '', 'cell' => $m[4]];
			}
			$name = $m[2] !== '' ? "'" . $m[2] . "'" : $m[3];
			return ['sheet' => ($m[1] === '$' ? '$' : '') . $name . '.', 'cell' => $m[4]];
		}
		if (preg_match('/^\.?#REF!$/', trim($end))) {
			return ['sheet' => '', 'cell' => '#REF!'];
		}
		return null;
	}

	/** "A:A" for A1:A1048576, "1:1" for A1:XFD1, null for anything else. */
	private static function wholeOf(string $a, string $b): ?string {
		$pa = Cells::parseRef($a);
		$pb = Cells::parseRef($b);
		if ($pa === null || $pb === null) {
			return null;
		}
		if ($pa[0] === 0 && $pb[0] === Cells::MAX_ROWS - 1) {
			return preg_replace('/\$?\d+$/', '', $a) . ':' . preg_replace('/\$?\d+$/', '', $b);
		}
		if ($pa[1] === 0 && $pb[1] === Cells::MAX_COLS - 1) {
			return preg_replace('/^\$?[A-Za-z]+/', '', $a) . ':' . preg_replace('/^\$?[A-Za-z]+/', '', $b);
		}
		return null;
	}

	// ---- XLSX ----

	/** Sheet2!A1, 'My sheet'!A1:B2; the $ before a sheet (Calc's) has no place in Excel. */
	private static function xlsxRef(array $ref): string {
		if ($ref['b'] !== null && $ref['sheet'] !== null && $ref['bsheet'] !== null && $ref['bsheet'] !== $ref['sheet']) {
			// across sheets, as Excel writes it: Sheet1:Sheet3!A1:B2, quoted as one ('My sheet:Sheet3'!A1)
			$pair = $ref['sheet'] . ':' . $ref['bsheet'];
			$plain = self::xlsxSheetName($ref['sheet']) === $ref['sheet'] && self::xlsxSheetName($ref['bsheet']) === $ref['bsheet'];
			return ($plain ? $pair : "'" . str_replace("'", "''", $pair) . "'") . '!' . self::endText($ref['a']) . ':' . self::endText($ref['b']);
		}
		$out = ($ref['sheet'] === null ? '' : self::xlsxSheetName($ref['sheet']) . '!') . self::endText($ref['a']);
		if ($ref['b'] !== null) {
			$out .= ':' . ($ref['bsheet'] === null || $ref['bsheet'] === $ref['sheet'] ? '' : self::xlsxSheetName($ref['bsheet']) . '!') . self::endText($ref['b']);
		}
		return $out;
	}

	private static function xlsxSheetName(string $name): string {
		return preg_match('/^[A-Za-z_][A-Za-z0-9_.]*$/', $name) && !preg_match('/^[A-Za-z]{1,3}\d+$/', $name)
			? $name : "'" . str_replace("'", "''", $name) . "'";
	}
}
