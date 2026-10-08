<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * The pipe tables of a Markdown text as sheets of the workbook model.
 *
 *   | Item   | Qty | Price |
 *   |:-------|----:|------:|
 *   | Apples |   3 |   120 |
 *
 * A table is a run of lines with | in them whose second line is the separator
 * (dashes, with : for the alignment). The header row is bold; the alignment of
 * each column is the separator's; cells are read for what they mean (a number is
 * a number). Inline marks are taken off: **bold**, *italic*, `code`, and a link
 * [text](url) is its text with the link kept on the cell. The heading nearest
 * above the table names the sheet.
 */
final class MarkdownTables {
	/**
	 * @return list<array{name: string, cells: array<string, array<string, mixed>>, cols: array<string, int>, merges: list<string>}>
	 */
	public static function fromText(string $text, int $limit = Connectors::TABLE_LIMIT): array {
		$lines = preg_split('/\r\n|\r|\n/', str_starts_with($text, "\xEF\xBB\xBF") ? substr($text, 3) : $text) ?: [];
		$out = [];
		$heading = '';
		$n = 0;
		$cells = 0;
		for ($i = 0, $count = count($lines); $i < $count; $i++) {
			$line = $lines[$i];
			if (preg_match('/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/', $line, $m)) {
				$heading = trim($m[1]);
				continue;
			}
			if (!self::isRow($line) || !isset($lines[$i + 1]) || !self::isSeparator($lines[$i + 1])) {
				continue;
			}
			$aligns = array_map(static fn (string $s): string => self::alignOf($s), self::split($lines[$i + 1]));
			$rows = [self::split($line)];
			for ($j = $i + 2; $j < $count && self::isRow($lines[$j]); $j++) {
				$rows[] = self::split($lines[$j]);
			}
			$i = $j - 1;
			if (++$n > $limit) {
				break;
			}
			$sheet = self::sheet($rows, $aligns, $heading !== '' ? mb_substr($heading, 0, 64) : 'Table ' . $n);
			$cells += count($sheet['cells']);
			if ($cells > Model::MAX_CELLS) {
				throw new \InvalidArgumentException('the tables have more than ' . Model::MAX_CELLS . ' cells together');
			}
			$out[] = $sheet;
			$heading = '';
		}
		return $out;
	}

	private static function isRow(string $line): bool {
		return str_contains($line, '|') && trim($line) !== '' && !preg_match('/^\s*```/', $line);
	}

	private static function isSeparator(string $line): bool {
		$cells = self::split($line);
		if ($cells === []) {
			return false;
		}
		foreach ($cells as $cell) {
			if (!preg_match('/^:?-{1,}:?$/', trim($cell))) {
				return false;
			}
		}
		return true;
	}

	private static function alignOf(string $sep): string {
		$sep = trim($sep);
		$left = str_starts_with($sep, ':');
		$right = str_ends_with($sep, ':');
		return $left && $right ? 'center' : ($right ? 'right' : ($left ? 'left' : ''));
	}

	/** The cells of one row: the outer pipes dropped, an escaped \| kept as a pipe. */
	private static function split(string $line): array {
		$line = trim($line);
		$line = preg_replace('/^\|/', '', $line) ?? $line;
		$line = preg_replace('/\|$/', '', $line) ?? $line;
		$parts = preg_split('/(?<!\\\\)\|/', $line) ?: [];
		return array_map(static fn (string $s): string => str_replace('\\|', '|', trim($s)), $parts);
	}

	/**
	 * @param list<list<string>> $rows
	 * @param list<string> $aligns
	 */
	private static function sheet(array $rows, array $aligns, string $name): array {
		$cells = [];
		$widths = [];
		foreach ($rows as $r => $row) {
			foreach ($row as $c => $raw) {
				if ($c >= Cells::MAX_COLS) {
					break;
				}
				$link = '';
				$text = self::plain($raw, $link);
				if ($text === '') {
					continue;
				}
				$cell = TextValues::cell($text);
				if ($text !== CsvFormat::shown($cell)) {
					$cell['d'] = $text;
				}
				$s = [];
				if ($r === 0) {
					$s['b'] = 1;
				}
				if (($aligns[$c] ?? '') !== '') {
					$s['ha'] = $aligns[$c];
				}
				if (preg_match('/^\*\*.+\*\*$/', trim($raw)) || preg_match('/^__.+__$/', trim($raw))) {
					$s['b'] = 1;
				}
				if ($s !== []) {
					$cell['s'] = $s;
				}
				if ($link !== '' && preg_match('#^(https?://|mailto:)#i', $link)) {
					$cell['link'] = mb_substr($link, 0, 2048);
				}
				$cells[Cells::ref($r, $c)] = $cell;
				$widths[$c] = max($widths[$c] ?? 0, mb_strwidth($text));
			}
		}
		$cols = [];
		foreach ($widths as $c => $w) {
			if ($w > 8) {
				$cols[Cells::colName($c)] = (int)min(400, max(64, $w * 7 + 14));
			}
		}
		return ['name' => $name, 'cells' => $cells, 'cols' => $cols, 'merges' => []];
	}

	/** The words of a cell without their marks; the first link kept. */
	private static function plain(string $raw, string &$link): string {
		$s = trim($raw);
		$s = preg_replace_callback('/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/', static function (array $m) use (&$link): string {
			if ($link === '') {
				$link = $m[2];
			}
			return $m[1];
		}, $s) ?? $s;
		$s = preg_replace('/<br\s*\/?>/i', "\n", $s) ?? $s;
		$s = preg_replace('/(\*\*|__)(.+?)\1/', '$2', $s) ?? $s;
		$s = preg_replace('/(?<![*\w])(\*|_)(?!\s)(.+?)(?<!\s)\1(?![*\w])/', '$2', $s) ?? $s;
		$s = preg_replace('/`([^`]*)`/', '$1', $s) ?? $s;
		$s = preg_replace('/~~(.+?)~~/', '$1', $s) ?? $s;
		$s = str_replace(['\\*', '\\_', '\\`', '\\\\'], ['*', '_', '`', '\\'], $s);
		return trim($s);
	}
}
