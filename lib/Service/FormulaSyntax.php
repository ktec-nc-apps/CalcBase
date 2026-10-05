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
		return 'of:=' . self::walk($body, ';', static fn (array $ref): string => self::odsRef($ref), false);
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
			$out .= $ch;
			$i++;
		}
		return '=' . $out;
	}

	/** A formula written as the person types it, as the text of an XLSX <f> element (no leading =). */
	public static function toXlsx(string $formula): string {
		return self::walk(self::body($formula), ',', static fn (array $ref): string => self::xlsxRef($ref), true);
	}

	/** The text of an XLSX <f> element as a person would type it: already A1 syntax, Excel's own prefixes taken off. */
	public static function fromXlsx(string $text): string {
		$body = trim($text);
		if (str_starts_with($body, '=')) {
			$body = substr($body, 1);
		}
		return '=' . self::walk($body, ',', static fn (array $ref): string => self::xlsxRef($ref), true);
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
	private static function walk(string $body, ?string $sep, callable $ref, bool $stripXl): string {
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
					if ($stripXl) {
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
				if ($m[10] !== null) {
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

	// ---- ODS ----

	/** [.B2], [.B2:.B5], [$Sheet2.A1], [$'My sheet'.A1:.B2]; whole columns and rows as the cells they cover. */
	private static function odsRef(array $ref): string {
		$sheet = $ref['sheet'] === null ? '' : '$' . self::odsSheetName($ref['sheet']);
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
			$bsheet = $ref['bsheet'] === null ? '' : '$' . self::odsSheetName($ref['bsheet']);
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
