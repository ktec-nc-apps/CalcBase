<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * CSV and TSV in and out of the workbook model.
 *
 * In: whatever the file was written in (UTF-8, Shift_JIS, EUC-JP -- see
 * TextEncoding), with the delimiter worked out from the text (tab, comma or
 * semicolon), quoted fields and line breaks inside them as RFC 4180 has them.
 * Numbers become numbers, TRUE and FALSE booleans, everything else text -- a
 * field beginning with = stays text, as Calc has it: a CSV file is data, and a
 * formula in it is somebody else's instruction.
 *
 * Out: one sheet, UTF-8 with a byte-order mark (so Excel on a Japanese Windows
 * reads it as UTF-8), CRLF line ends, fields quoted when they need it. The
 * shown text is written when the browser sent it (the cell's "d"), the raw
 * value otherwise -- the server has no engine to format a number by its code.
 */
final class CsvFormat {
	/**
	 * @return array{sheets: list<array<string, mixed>>, active: int}
	 */
	public static function import(string $bytes, string $name): array {
		$read = TextEncoding::toUtf8($bytes);
		$text = $read['text'];
		$sep = str_ends_with(strtolower($name), '.tsv') ? "\t" : self::delimiter($text);
		$cells = [];
		$count = 0;
		$r = 0;
		$cols = 0;
		foreach (self::rows($text, $sep) as $row) {
			$c = 0;
			foreach ($row as $field) {
				if ($field !== '') {
					if (++$count > Model::MAX_CELLS) {
						throw new \InvalidArgumentException('that file has more than ' . Model::MAX_CELLS . ' cells');
					}
					$cells[Cells::ref($r, $c)] = self::cell($field);
				}
				$c++;
			}
			$cols = max($cols, $c);
			$r++;
			if ($r > Cells::MAX_ROWS) {
				throw new \InvalidArgumentException('that file has more rows than a sheet can hold');
			}
		}
		if ($cols > Cells::MAX_COLS) {
			throw new \InvalidArgumentException('that file has more columns than a sheet can hold');
		}
		$stem = preg_replace('/\.(csv|tsv|txt)$/i', '', $name) ?? $name;
		return [
			'sheets' => [['name' => $stem === '' ? 'Sheet1' : mb_substr($stem, 0, 64), 'cells' => $cells]],
			'active' => 0,
			'encoding' => ['read' => $read['encoding'], 'lossy' => $read['lossy']],
		];
	}

	/** The character between fields: the one that appears most, outside quotes, on the first lines. */
	public static function delimiter(string $text): string {
		$head = substr($text, 0, 65536);
		$counts = ["\t" => 0, ',' => 0, ';' => 0];
		$q = false;
		$lines = 0;
		for ($i = 0, $n = strlen($head); $i < $n && $lines < 50; $i++) {
			$ch = $head[$i];
			if ($ch === '"') {
				$q = !$q;
			} elseif (!$q && isset($counts[$ch])) {
				$counts[$ch]++;
			} elseif (!$q && $ch === "\n") {
				$lines++;
			}
		}
		arsort($counts);
		$best = array_key_first($counts);
		return $counts[$best] === 0 ? ',' : $best;
	}

	/**
	 * The rows of a CSV text, each a list of fields; a quoted field may hold the
	 * delimiter, quotes ("" for one) and line breaks.
	 *
	 * @return \Generator<int, list<string>>
	 */
	public static function rows(string $text, string $sep): \Generator {
		if (str_starts_with($text, "\xEF\xBB\xBF")) {
			$text = substr($text, 3);
		}
		$n = strlen($text);
		$i = 0;
		$row = [];
		$field = '';
		$q = false;
		$any = false;
		while ($i < $n) {
			$ch = $text[$i];
			if ($q) {
				if ($ch === '"') {
					if ($i + 1 < $n && $text[$i + 1] === '"') {
						$field .= '"';
						$i += 2;
						continue;
					}
					$q = false;
					$i++;
					continue;
				}
				$field .= $ch;
				$i++;
				continue;
			}
			if ($ch === '"' && $field === '') {
				$q = true;
				$any = true;
				$i++;
				continue;
			}
			if ($ch === $sep) {
				$row[] = $field;
				$field = '';
				$any = true;
				$i++;
				continue;
			}
			if ($ch === "\r" || $ch === "\n") {
				if ($ch === "\r" && $i + 1 < $n && $text[$i + 1] === "\n") {
					$i++;
				}
				$row[] = $field;
				yield $row;
				$row = [];
				$field = '';
				$any = false;
				$i++;
				continue;
			}
			$field .= $ch;
			$any = true;
			$i++;
		}
		if ($any || $row !== []) {
			$row[] = $field;
			yield $row;
		}
	}

	/** @return array<string, mixed> */
	private static function cell(string $field): array {
		$t = trim($field);
		if (preg_match('/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/', $t) && strlen($t) < 40) {
			$v = (float)$t;
			return ['v' => floor($v) == $v && abs($v) < PHP_INT_MAX && !str_contains($t, '.') && !str_contains(strtolower($t), 'e') ? (int)$v : $v, 't' => 'n'];
		}
		if (strcasecmp($t, 'TRUE') === 0 || strcasecmp($t, 'FALSE') === 0) {
			return ['v' => strcasecmp($t, 'TRUE') === 0, 't' => 'b'];
		}
		return ['v' => mb_substr($field, 0, Model::MAX_TEXT), 't' => 's'];
	}

	/**
	 * One sheet as CSV bytes.
	 *
	 * @param array<string, mixed> $sheet a cleaned sheet of the model
	 */
	public static function export(array $sheet, string $sep = ','): string {
		[$rows, $cols] = Cells::extent($sheet['cells'], $sheet['merges'] ?? []);
		$out = "\xEF\xBB\xBF";
		for ($r = 0; $r < $rows; $r++) {
			$line = [];
			for ($c = 0; $c < $cols; $c++) {
				$cell = $sheet['cells'][Cells::ref($r, $c)] ?? null;
				$line[] = $cell === null ? '' : self::field(self::shown($cell), $sep);
			}
			$out .= implode($sep, $line) . "\r\n";
		}
		return $out;
	}

	/** What a cell shows: the browser's text when it sent it, the raw value otherwise. */
	public static function shown(array $cell): string {
		if (isset($cell['d'])) {
			return (string)$cell['d'];
		}
		if (!array_key_exists('v', $cell)) {
			return '';
		}
		return match ($cell['t'] ?? 's') {
			'n' => Cells::number($cell['v']),
			'b' => $cell['v'] ? 'TRUE' : 'FALSE',
			default => (string)$cell['v'],
		};
	}

	private static function field(string $s, string $sep): string {
		if ($s === '' || (!str_contains($s, $sep) && !str_contains($s, '"') && !str_contains($s, "\n") && !str_contains($s, "\r") && $s[0] !== ' ' && $s[-1] !== ' ')) {
			return $s;
		}
		return '"' . str_replace('"', '""', $s) . '"';
	}
}
