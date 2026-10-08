<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * What a piece of text means as a cell: the server's small reading of what the
 * engine's parseInput does in the browser, for values that arrive as text --
 * the cells of an HTML or Markdown table, a RegiBase field, a contact's line.
 *
 * "1,234.5" is a number shown with thousands; "12%" is 0.12 shown as a percent;
 * "¥1,200" is 1200 in yen; "2026/10/5" and "2026-10-05" are a date (a serial
 * day, 1899-12-30 = 0, as Calc counts them) shown as yyyy/mm/dd; "10:30" is a
 * fraction of a day shown as h:mm; TRUE and FALSE are booleans; #DIV/0! and its
 * kind are errors; everything else is text. A number too long to be one, or a
 * text beginning with = (somebody else's instruction), stays text.
 */
final class TextValues {
	private const ERRORS = ['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A', '#NUM!', '#NULL!'];

	/**
	 * @return array{v: mixed, t: string, fmt?: string}
	 */
	public static function cell(string $text): array {
		$t = trim(preg_replace('/\s+/u', ' ', $text) ?? $text);
		if ($t === '') {
			return ['v' => '', 't' => 's'];
		}
		if (strcasecmp($t, 'TRUE') === 0 || strcasecmp($t, 'FALSE') === 0) {
			return ['v' => strcasecmp($t, 'TRUE') === 0, 't' => 'b'];
		}
		if (in_array($t, self::ERRORS, true) || preg_match('/^Err:\d{3}$/', $t)) {
			return ['v' => $t, 't' => 'e'];
		}
		if (strlen($t) < 40) {
			// A plain number, with or without thousands separators.
			if (preg_match('/^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/', $t, $m)) {
				$v = (float)($m[1] . str_replace(',', '', $m[2]) . ($m[3] ?? ''));
				$out = ['v' => self::whole($v, $t), 't' => 'n'];
				if (str_contains($m[2], ',')) {
					$out['fmt'] = isset($m[3]) ? '#,##0.' . str_repeat('0', strlen($m[3]) - 1) : '#,##0';
				}
				return $out;
			}
			if (preg_match('/^[+-]?(?:\d+\.?\d*|\.\d+)[eE][+-]?\d+$/', $t)) {
				return ['v' => (float)$t, 't' => 'n'];
			}
			// Yen and dollars, as a Japanese or an American table writes them.
			if (preg_match('/^(-?)([¥￥$])\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/u', $t, $m)) {
				$v = (float)($m[1] . str_replace(',', '', $m[3]) . ($m[4] ?? ''));
				return ['v' => self::whole($v, $t), 't' => 'n', 'fmt' => $m[2] === '$' ? '$#,##0.00' : '¥#,##0'];
			}
			if (preg_match('/^([+-]?\d+(?:\.\d+)?)\s?%$/', $t, $m)) {
				$v = (float)$m[1] / 100;
				return ['v' => $v, 't' => 'n', 'fmt' => str_contains($m[1], '.') ? '0.00%' : '0%'];
			}
			// A date, with a time of day or without.
			if (preg_match('/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/', $t, $m)) {
				$serial = Cells::serialOfIso(sprintf('%04d-%02d-%02d', (int)$m[1], (int)$m[2], (int)$m[3]));
				if ($serial !== null && checkdate((int)$m[2], (int)$m[3], (int)$m[1])) {
					if (isset($m[4])) {
						$serial += ((int)$m[4] * 3600 + (int)$m[5] * 60 + (int)($m[6] ?? 0)) / 86400;
						return ['v' => $serial, 't' => 'n', 'fmt' => 'yyyy/mm/dd h:mm'];
					}
					return ['v' => (int)$serial, 't' => 'n', 'fmt' => str_contains($t, '-') ? 'yyyy-mm-dd' : 'yyyy/mm/dd'];
				}
			}
			if (preg_match('/^(\d{4})年(\d{1,2})月(\d{1,2})日$/u', $t, $m)) {
				$serial = Cells::serialOfIso(sprintf('%04d-%02d-%02d', (int)$m[1], (int)$m[2], (int)$m[3]));
				if ($serial !== null && checkdate((int)$m[2], (int)$m[3], (int)$m[1])) {
					return ['v' => (int)$serial, 't' => 'n', 'fmt' => 'yyyy年m月d日'];
				}
			}
			if (preg_match('/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/', $t, $m) && (int)$m[1] < 24 && (int)$m[2] < 60) {
				return ['v' => ((int)$m[1] * 3600 + (int)$m[2] * 60 + (int)($m[3] ?? 0)) / 86400, 't' => 'n', 'fmt' => isset($m[3]) ? 'h:mm:ss' : 'h:mm'];
			}
		}
		return ['v' => mb_substr(trim($text), 0, Model::MAX_TEXT), 't' => 's'];
	}

	/** A whole number as an int, so it is written without a decimal point. */
	private static function whole(float $v, string $text): int|float {
		return floor($v) == $v && abs($v) < PHP_INT_MAX && !str_contains($text, '.') ? (int)$v : $v;
	}

	/** A date or date-time from an ISO string (what Contacts, Calendar, RegiBase and Tables hand over) as a cell. */
	public static function date(string $iso, bool $withTime = false): array {
		$iso = trim($iso);
		if ($iso === '') {
			return ['v' => '', 't' => 's'];
		}
		if (preg_match('/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/', $iso, $m)) {
			$serial = Cells::serialOfIso($m[1] . 'T' . (strlen($m[2]) === 5 ? $m[2] . ':00' : $m[2]));
			return $serial === null ? ['v' => $iso, 't' => 's'] : ['v' => $serial, 't' => 'n', 'fmt' => $withTime || $serial != floor($serial) ? 'yyyy/mm/dd h:mm' : 'yyyy/mm/dd'];
		}
		if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $iso)) {
			$serial = Cells::serialOfIso($iso);
			return $serial === null ? ['v' => $iso, 't' => 's'] : ['v' => (int)$serial, 't' => 'n', 'fmt' => 'yyyy/mm/dd'];
		}
		return self::cell($iso);
	}

	/** A Unix time as a date-time cell. */
	public static function unix(int $time): array {
		return ['v' => $time / 86400 + 25569, 't' => 'n', 'fmt' => 'yyyy/mm/dd h:mm'];
	}

	/** A text cell, never read as anything else (a name, a note). */
	public static function text(string $text): array {
		return ['v' => mb_substr($text, 0, Model::MAX_TEXT), 't' => 's'];
	}
}
