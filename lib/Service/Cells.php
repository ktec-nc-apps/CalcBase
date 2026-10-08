<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * Cell addresses, dates and sizes as the file formats and the workbook model
 * (design contract §3) write them. Rows and columns are counted from 0 here;
 * the A1 address is what goes into the model.
 */
final class Cells {
	/** As many as LibreOffice Calc addresses. */
	public const MAX_ROWS = 1048576;
	public const MAX_COLS = 16384;
	/** The last column's letters, for whole-row ranges written out as cells. */
	public const LAST_COL = 'XFD';

	/** Column letters for a 0-based index: 0 = A, 25 = Z, 26 = AA. */
	public static function colName(int $c): string {
		$name = '';
		$c++;
		while ($c > 0) {
			$c--;
			$name = chr(65 + $c % 26) . $name;
			$c = intdiv($c, 26);
		}
		return $name;
	}

	/** The 0-based index of column letters, case blind; -1 for letters that are not a column. */
	public static function colIndex(string $letters): int {
		$letters = strtoupper($letters);
		if (!preg_match('/^[A-Z]{1,3}$/', $letters)) {
			return -1;
		}
		$n = 0;
		for ($i = 0, $len = strlen($letters); $i < $len; $i++) {
			$n = $n * 26 + (ord($letters[$i]) - 64);
		}
		return $n - 1;
	}

	/** An A1 address for 0-based row and column. */
	public static function ref(int $r, int $c): string {
		return self::colName($c) . ($r + 1);
	}

	/** 0-based [row, col] of an A1 address ($ signs allowed), or null. */
	public static function parseRef(string $ref): ?array {
		if (!preg_match('/^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/', trim($ref), $m)) {
			return null;
		}
		$c = self::colIndex($m[1]);
		$r = (int)$m[2] - 1;
		if ($c < 0 || $c >= self::MAX_COLS || $r < 0 || $r >= self::MAX_ROWS) {
			return null;
		}
		return [$r, $c];
	}

	/** 0-based [r1, c1, r2, c2] of a range "A1:B2" (or one cell), ordered; null if it is not one. */
	public static function parseRange(string $range): ?array {
		$parts = explode(':', trim($range), 2);
		$a = self::parseRef($parts[0]);
		$b = isset($parts[1]) ? self::parseRef($parts[1]) : $a;
		if ($a === null || $b === null) {
			return null;
		}
		return [min($a[0], $b[0]), min($a[1], $b[1]), max($a[0], $b[0]), max($a[1], $b[1])];
	}

	public static function rangeName(int $r1, int $c1, int $r2, int $c2): string {
		return self::ref($r1, $c1) . ':' . self::ref($r2, $c2);
	}

	/**
	 * The used range of a sheet's cells (model keys), merges included: 0-based
	 * [rows, cols] counts, both 0 for an empty sheet.
	 *
	 * @param array<string, mixed> $cells
	 * @param list<string> $merges
	 * @return array{0: int, 1: int}
	 */
	public static function extent(array $cells, array $merges = []): array {
		$rows = 0;
		$cols = 0;
		foreach ($cells as $key => $_) {
			$at = self::parseRef((string)$key);
			if ($at === null) {
				continue;
			}
			$rows = max($rows, $at[0] + 1);
			$cols = max($cols, $at[1] + 1);
		}
		foreach ($merges as $m) {
			$box = self::parseRange($m);
			if ($box !== null) {
				$rows = max($rows, $box[2] + 1);
				$cols = max($cols, $box[3] + 1);
			}
		}
		return [$rows, $cols];
	}

	// ---- dates: serial days as Calc counts them (1899-12-30 = 0) ----

	private const EPOCH = '1899-12-30';

	/** Days since 1899-12-30 for an ISO date or date-time ("2026-10-05", "2026-10-05T10:30:00"); null if unreadable. */
	public static function serialOfIso(string $iso): ?float {
		if (!preg_match('/^(-?\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/', trim($iso), $m)) {
			return null;
		}
		$days = self::daysFromCivil((int)$m[1], (int)$m[2], (int)$m[3]) - self::daysFromCivil(1899, 12, 30);
		$frac = 0.0;
		if (isset($m[4])) {
			$frac = ((int)$m[4] * 3600 + (int)$m[5] * 60 + (float)($m[6] ?? 0)) / 86400;
		}
		return $days + $frac;
	}

	/** The fraction of a day in an ISO 8601 duration "PT10H30M00S" (hours may exceed 24); null if unreadable. */
	public static function serialOfDuration(string $duration): ?float {
		if (!preg_match('/^(-)?P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/', trim($duration), $m)) {
			return null;
		}
		$seconds = (int)($m[2] ?? 0) * 86400 + (int)($m[3] ?? 0) * 3600 + (int)($m[4] ?? 0) * 60 + (float)($m[5] ?? 0);
		return ($m[1] === '-' ? -1 : 1) * $seconds / 86400;
	}

	/**
	 * An ISO date ("2026-10-05") for a whole serial, with the time ("T10:30:00",
	 * "T05:35:31.2") when there is a fraction. Seconds keep their fraction, to the
	 * microsecond: rounded to whole seconds, 0.233 of a day came back 0.2 s out.
	 */
	public static function isoOfSerial(float $serial, bool $withTime = false): string {
		$days = (int)floor($serial);
		$us = (int)round(($serial - $days) * 86400e6);
		if ($us >= 86400000000) {
			$days++;
			$us -= 86400000000;
		}
		[$y, $mo, $d] = self::civilFromDays($days + self::daysFromCivil(1899, 12, 30));
		$out = sprintf('%04d-%02d-%02d', $y, $mo, $d);
		if ($withTime || $us > 0) {
			$out .= 'T' . self::clock($us, ':');
		}
		return $out;
	}

	/** An ISO duration ("PT10H30M00S", "PT05H35M31.2S" as Calc writes it) for a fraction of a day. */
	public static function durationOfSerial(float $serial): string {
		$us = (int)round(abs($serial) * 86400e6);
		return ($serial < 0 ? '-' : '') . 'PT' . self::clock($us, '');
	}

	/** Microseconds as 10:30:00.25 (with $sep ':') or 10H30M00.25S (with ''). */
	private static function clock(int $us, string $sep): string {
		$s = intdiv($us, 1000000);
		$frac = $us % 1000000;
		$sec = sprintf('%02d', $s % 60) . ($frac > 0 ? '.' . rtrim(sprintf('%06d', $frac), '0') : '');
		return $sep === ''
			? sprintf('%02dH%02dM', intdiv($s, 3600), intdiv($s % 3600, 60)) . $sec . 'S'
			: sprintf('%02d:%02d:', intdiv($s, 3600), intdiv($s % 3600, 60)) . $sec;
	}

	/** Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm). */
	private static function daysFromCivil(int $y, int $m, int $d): int {
		$y -= $m <= 2 ? 1 : 0;
		$era = intdiv($y >= 0 ? $y : $y - 399, 400);
		$yoe = $y - $era * 400;
		$doy = intdiv(153 * ($m + ($m > 2 ? -3 : 9)) + 2, 5) + $d - 1;
		$doe = $yoe * 365 + intdiv($yoe, 4) - intdiv($yoe, 100) + $doy;
		return $era * 146097 + $doe - 719468;
	}

	/** @return array{0: int, 1: int, 2: int} */
	private static function civilFromDays(int $z): array {
		$z += 719468;
		$era = intdiv($z >= 0 ? $z : $z - 146096, 146097);
		$doe = $z - $era * 146097;
		$yoe = intdiv($doe - intdiv($doe, 1460) + intdiv($doe, 36524) - intdiv($doe, 146096), 365);
		$y = $yoe + $era * 400;
		$doy = $doe - (365 * $yoe + intdiv($yoe, 4) - intdiv($yoe, 100));
		$mp = intdiv(5 * $doy + 2, 153);
		$d = $doy - intdiv(153 * $mp + 2, 5) + 1;
		$m = $mp + ($mp < 10 ? 3 : -9);
		return [$y + ($m <= 2 ? 1 : 0), $m, $d];
	}

	// ---- sizes ----

	/** A CSS/ODF length ("2.258cm", "0.889in", "12pt", "17px") in CSS pixels, at 96 per inch; null if unreadable. */
	public static function pxOfLength(string $length): ?float {
		if (!preg_match('/^\s*(-?\d+(?:\.\d+)?)\s*(cm|mm|in|pt|pc|px)?\s*$/', $length, $m)) {
			return null;
		}
		$n = (float)$m[1];
		return match ($m[2] ?? 'px') {
			'cm' => $n * 96 / 2.54,
			'mm' => $n * 96 / 25.4,
			'in' => $n * 96,
			'pt' => $n * 96 / 72,
			'pc' => $n * 16,
			default => $n,
		};
	}

	/** Pixels as an ODF length in centimetres. */
	public static function cmOfPx(float $px): string {
		return rtrim(rtrim(sprintf('%.4f', $px * 2.54 / 96), '0'), '.') . 'cm';
	}

	/** A number for XML attributes and formula literals: no exponent for ordinary sizes, no locale. */
	public static function number(float|int $v): string {
		if (is_int($v) || floor($v) == $v && abs($v) < 1e15) {
			return (string)(int)$v;
		}
		$s = sprintf('%.15G', $v);
		if (str_contains($s, 'E')) {
			// 1.5E-7 -> 0.00000015: a formula or a value file wants digits, not an exponent.
			$s = rtrim(rtrim(sprintf('%.20f', $v), '0'), '.');
		}
		return $s;
	}
}
