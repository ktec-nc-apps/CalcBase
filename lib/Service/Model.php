<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * The workbook model of the design contract (§3), as the server checks it.
 *
 * The import writes one; the export reads one the browser sent. A model from
 * the browser is only taken in the shape the contract gives it: known keys,
 * A1 addresses, scalar values, so many sheets and cells and no more. What does
 * not fit is dropped or refused, never passed on into a file.
 */
final class Model {
	/** More sheets than a workbook could need. */
	public const MAX_SHEETS = 256;
	/** Cells in all sheets together: a hundred thousand rows of ten columns. */
	public const MAX_CELLS = 1000000;
	/**
	 * CalcBase is for the tables people keep by hand, not for bulk data (owner,
	 * 2026-10-06). A book holds 100,000 cells unless its writer chooses more in
	 * the settings, at their own risk; while there is a limit, a sheet also stops
	 * at row 30,000 and a file at 24 MB, as EditBase's. "No limit" lifts all three.
	 * The page enforces the same (applyLimits in calcbase.js); BookService::limits
	 * reads the writer's choice.
	 */
	public const CELL_LIMITS = [100000, 300000, 600000, 0];
	public const DEFAULT_CELL_LIMIT = 100000;
	public const MAX_ROWS = 30000;
	public const MAX_FILE_BYTES = 24 * 1024 * 1024;
	/**
	 * What an importer says when a file is over those limits. Written out, not
	 * put together from the numbers: the screen shows the server's sentence in
	 * the person's language by looking it up as it stands (calcbase-l10n.py
	 * picks up a translated sentence only where it stands quoted in the source).
	 */
	public const TOO_MANY_CELLS = 'that file has more than 1,000,000 cells';
	public const TOO_MANY_SHEETS = 'that file has more than 256 sheets';
	/**
	 * The width the screen gives a column the book has no width for (DEF_COL_W
	 * in js/calcbase.js), in CSS pixels. A file is written with it for such a
	 * column, so that it is as wide in Calc as on the screen, and a width of
	 * exactly this is read as none.
	 */
	public const DEFAULT_COL_PX = 80;
	/** The most a formula or a text may be, in characters. */
	public const MAX_TEXT = 32767;
	public const MAX_FORMULA = 8192;

	/** Defined names a book may have, the book's and each sheet's together. */
	public const MAX_NAMES = 10000;

	/** The style keys of §3 and what each may hold. */
	private const STYLE = ['b', 'i', 'u', 'strike', 'color', 'bg', 'ha', 'va', 'wrap', 'font', 'size', 'bt', 'br', 'bb', 'bl'];

	/**
	 * A model as the browser sent it, cleaned; throws when it is not a model or too big.
	 *
	 * @param mixed $in
	 * @return array{sheets: list<array<string, mixed>>, active: int}
	 */
	public static function clean(mixed $in, int $maxCells = self::MAX_CELLS, int $maxRows = Cells::MAX_ROWS): array {
		if (!is_array($in) || !is_array($in['sheets'] ?? null) || !array_is_list($in['sheets'])) {
			throw new \InvalidArgumentException('that is not a workbook');
		}
		if (count($in['sheets']) === 0) {
			throw new \InvalidArgumentException('a workbook needs at least one sheet');
		}
		if (count($in['sheets']) > self::MAX_SHEETS) {
			throw new \InvalidArgumentException('a workbook may have at most ' . self::MAX_SHEETS . ' sheets');
		}
		$sheets = [];
		$cells = 0;
		$names = [];
		$nameCount = 0;
		foreach ($in['sheets'] as $i => $sheet) {
			if (!is_array($sheet)) {
				throw new \InvalidArgumentException('sheet ' . ($i + 1) . ' is not a sheet');
			}
			$name = is_string($sheet['name'] ?? null) ? trim($sheet['name']) : '';
			$name = $name === '' ? 'Sheet' . ($i + 1) : mb_substr($name, 0, 64);
			$base = $name;
			for ($k = 2; isset($names[mb_strtolower($name)]); $k++) {
				$name = $base . ' (' . $k . ')';
			}
			$names[mb_strtolower($name)] = true;
			$out = ['name' => $name, 'cells' => [], 'cols' => [], 'rows' => [], 'merges' => []];
			foreach (is_array($sheet['cells'] ?? null) ? $sheet['cells'] : [] as $key => $cell) {
				$at = Cells::parseRef((string)$key);
				if ($at === null || !is_array($cell)) {
					continue;
				}
				$clean = self::cell($cell);
				if ($clean === null) {
					continue;
				}
				if ($at[0] >= $maxRows) {
					throw new \InvalidArgumentException('a sheet may have at most ' . $maxRows . ' rows');
				}
				if (++$cells > $maxCells) {
					throw new \InvalidArgumentException('a workbook may have at most ' . $maxCells . ' cells');
				}
				$out['cells'][Cells::ref($at[0], $at[1])] = $clean;
			}
			foreach (is_array($sheet['cols'] ?? null) ? $sheet['cols'] : [] as $col => $px) {
				if (Cells::colIndex((string)$col) >= 0 && is_numeric($px) && (float)$px >= 1 && (float)$px <= 4000) {
					$out['cols'][strtoupper((string)$col)] = (int)round((float)$px);
				}
			}
			foreach (is_array($sheet['rows'] ?? null) ? $sheet['rows'] : [] as $row => $px) {
				if (preg_match('/^[1-9]\d{0,6}$/', (string)$row) && is_numeric($px) && (float)$px >= 1 && (float)$px <= 2000) {
					$out['rows'][(string)$row] = (int)round((float)$px);
				}
			}
			foreach (is_array($sheet['merges'] ?? null) ? $sheet['merges'] : [] as $m) {
				$box = is_string($m) ? Cells::parseRange($m) : null;
				if ($box !== null && ($box[0] !== $box[2] || $box[1] !== $box[3])) {
					$out['merges'][] = Cells::rangeName(...$box);
				}
			}
			if (is_string($sheet['freeze'] ?? null) && Cells::parseRef($sheet['freeze']) !== null) {
				$out['freeze'] = strtoupper($sheet['freeze']);
			}
			if (array_key_exists('grid', $sheet)) {
				$out['grid'] = (bool)$sheet['grid'];
			}
			$own = self::names($sheet['names'] ?? null, $nameCount);
			if ($own !== []) {
				$out['names'] = $own;
			}
			$sheets[] = $out;
		}
		$active = (int)($in['active'] ?? 0);
		$model = ['sheets' => $sheets, 'active' => max(0, min(count($sheets) - 1, $active))];
		$bookNames = self::names($in['names'] ?? null, $nameCount);
		if ($bookNames !== []) {
			$model['names'] = $bookNames;
		}
		// the document's calculation settings, where they are not a new document's (see OdsFormat)
		if (is_array($in['calc'] ?? null)) {
			$calc = [];
			if (($in['calc']['regex'] ?? false) === true) {
				$calc['regex'] = true;
			}
			if (($in['calc']['caseSensitive'] ?? true) === false) {
				$calc['caseSensitive'] = false;
			}
			if (is_int($in['calc']['decimals'] ?? null) && $in['calc']['decimals'] >= 0 && $in['calc']['decimals'] <= 20) {
				$calc['decimals'] = $in['calc']['decimals'];
			}
			if ($calc !== []) {
				$model['calc'] = $calc;
			}
		}
		return $model;
	}

	/**
	 * Whether a text may be a defined name, as Calc allows one: a letter or _ first, then
	 * letters, digits, _ and .; not a cell address (A1, XFD12), not R1C1, not TRUE or FALSE.
	 */
	public static function validName(string $name): bool {
		return preg_match('/^[\p{L}_][\p{L}\p{N}_.]{0,254}$/u', $name) === 1
			&& !preg_match('/^[A-Za-z]{1,3}\d+$/', $name) && !preg_match('/^R\d*C\d*$/i', $name)
			&& !preg_match('/^(TRUE|FALSE)$/i', $name);
	}

	/**
	 * Defined names as the book keeps them: name => what it stands for, a reference or a formula
	 * without its = ("$Sheet1.$A$1:$B$5"). What is not a name, or too long, is left out.
	 *
	 * @return array<string, string>
	 */
	private static function names(mixed $in, ?int &$count): array {
		$out = [];
		if (!is_array($in)) {
			return $out;
		}
		foreach ($in as $name => $def) {
			$name = (string)$name;
			if (!is_string($def) || !self::validName($name)) {
				continue;
			}
			$def = trim($def);
			$def = str_starts_with($def, '=') ? substr($def, 1) : $def;
			if ($def === '' || mb_strlen($def) > self::MAX_FORMULA) {
				continue;
			}
			if (++$count > self::MAX_NAMES) {
				throw new \InvalidArgumentException('a workbook may have at most ' . self::MAX_NAMES . ' names');
			}
			$out[$name] = $def;
		}
		return $out;
	}

	/** @return array<string, mixed>|null */
	private static function cell(array $cell): ?array {
		$out = [];
		$t = is_string($cell['t'] ?? null) && in_array($cell['t'], ['n', 's', 'b', 'e'], true) ? $cell['t'] : null;
		$v = $cell['v'] ?? null;
		if ($t === null) {
			$t = match (true) {
				is_bool($v) => 'b',
				is_int($v) || is_float($v) => 'n',
				is_string($v) => 's',
				default => null,
			};
		}
		if (is_string($cell['f'] ?? null) && trim($cell['f']) !== '') {
			$f = trim($cell['f']);
			$out['f'] = mb_substr(str_starts_with($f, '=') ? $f : '=' . $f, 0, self::MAX_FORMULA);
			// an array formula (Ctrl+Shift+Enter): the range it fills, on the cell that holds it (§2 data-a)
			if (is_string($cell['a'] ?? null) && ($box = Cells::parseRange(str_replace('$', '', $cell['a']))) !== null) {
				$out['a'] = Cells::rangeName(...$box);
			}
		}
		if ($t !== null && $v !== null && !is_array($v)) {
			$out['t'] = $t;
			$out['v'] = match ($t) {
				'n' => is_numeric($v) ? (is_int($v) ? $v : (float)$v) : null,
				'b' => is_bool($v) ? $v : (is_string($v) ? strtoupper($v) === 'TRUE' : (bool)$v),
				default => mb_substr(is_bool($v) ? ($v ? 'TRUE' : 'FALSE') : (string)$v, 0, self::MAX_TEXT),
			};
			if ($out['v'] === null) {
				unset($out['v'], $out['t']);
			}
		}
		// The shown text, when the browser sends it: CSV export writes it in place of the raw value.
		if (is_string($cell['d'] ?? null)) {
			$out['d'] = mb_substr($cell['d'], 0, self::MAX_TEXT);
		}
		if (is_string($cell['fmt'] ?? null) && $cell['fmt'] !== '' && $cell['fmt'] !== 'General') {
			$out['fmt'] = mb_substr($cell['fmt'], 0, 255);
		}
		// A link on the cell (a URL from RegiBase, a web table's anchor): http(s) or mailto only.
		if (is_string($cell['link'] ?? null) && preg_match('#^(https?://|mailto:)\S{1,2040}$#i', trim($cell['link']))) {
			$out['link'] = trim($cell['link']);
		}
		$style = self::style(is_array($cell['s'] ?? null) ? $cell['s'] : []);
		if ($style !== []) {
			$out['s'] = $style;
		}
		return $out === [] ? null : $out;
	}

	/**
	 * A sheet as an importer read it, tidied: the cells a merge covers are not
	 * cells of their own (the workbook file omits them, as HTML requires), and a
	 * vertical alignment of "bottom" is the default and so not written.
	 *
	 * @param array<string, mixed> $sheet
	 * @return array<string, mixed>
	 */
	public static function tidy(array $sheet): array {
		foreach ($sheet['merges'] ?? [] as $m) {
			$box = Cells::parseRange($m);
			if ($box === null) {
				continue;
			}
			for ($r = $box[0]; $r <= $box[2]; $r++) {
				for ($c = $box[1]; $c <= $box[3]; $c++) {
					if ($r !== $box[0] || $c !== $box[1]) {
						unset($sheet['cells'][Cells::ref($r, $c)]);
					}
				}
			}
		}
		foreach ($sheet['cells'] as $key => $cell) {
			if (($cell['s']['va'] ?? '') === 'bottom') {
				unset($cell['s']['va']);
				if ($cell['s'] === []) {
					unset($cell['s']);
				}
			}
			// A boolean shows as TRUE/FALSE whatever its format; LibreOffice's own code for that is noise here.
			if (($cell['t'] ?? '') === 'b' && isset($cell['fmt']) && preg_match('/TRUE|FALSE|BOOLEAN/i', $cell['fmt'])) {
				unset($cell['fmt']);
			}
			if ($cell === []) {
				unset($sheet['cells'][$key]);
			} else {
				$sheet['cells'][$key] = $cell;
			}
		}
		return $sheet;
	}

	/**
	 * The model with its maps as JSON objects even when empty: an empty PHP array
	 * would come out as [] and the browser expects {}.
	 */
	public static function forJson(array $model): array {
		foreach ($model['sheets'] as &$sheet) {
			foreach (['cells', 'cols', 'rows'] as $k) {
				$sheet[$k] = (object)($sheet[$k] ?? []);
			}
			$sheet['merges'] = array_values($sheet['merges'] ?? []);
		}
		unset($sheet);
		return $model;
	}

	/** @return array<string, mixed> */
	public static function style(array $s): array {
		$out = [];
		foreach (self::STYLE as $k) {
			if (!array_key_exists($k, $s) || $s[$k] === null || $s[$k] === '' || $s[$k] === false) {
				continue;
			}
			$v = $s[$k];
			switch ($k) {
				case 'b': case 'i': case 'u': case 'strike': case 'wrap':
					if ($v) {
						$out[$k] = 1;
					}
					break;
				case 'color': case 'bg':
					$c = self::colour((string)$v);
					if ($c !== null) {
						$out[$k] = $c;
					}
					break;
				case 'ha':
					// justify: Calc's "Justified" (and what Excel's "distributed" is in Calc)
					if (in_array($v, ['left', 'center', 'right', 'justify'], true)) {
						$out[$k] = $v;
					}
					break;
				case 'va':
					if (in_array($v, ['top', 'middle', 'bottom'], true)) {
						$out[$k] = $v;
					}
					break;
				case 'font':
					if (is_string($v) && preg_match('/^[^<>"\'\\\\;{}]{1,100}$/u', $v)) {
						$out[$k] = $v;
					}
					break;
				case 'size':
					if (is_numeric($v) && (float)$v >= 1 && (float)$v <= 409) {
						$out[$k] = round((float)$v, 2);
					}
					break;
				default: // borders
					$b = self::border((string)$v);
					if ($b !== null) {
						$out[$k] = $b;
					}
			}
		}
		return $out;
	}

	/** A colour as #rrggbb; names and rgb() are not taken, a file wants hex. */
	public static function colour(string $c): ?string {
		$c = trim($c);
		if (preg_match('/^#([0-9A-Fa-f]{6})$/', $c, $m)) {
			return '#' . strtolower($m[1]);
		}
		if (preg_match('/^#([0-9A-Fa-f])([0-9A-Fa-f])([0-9A-Fa-f])$/', $c, $m)) {
			return '#' . strtolower($m[1] . $m[1] . $m[2] . $m[2] . $m[3] . $m[3]);
		}
		if (preg_match('/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/', $c, $m)) {
			return sprintf('#%02x%02x%02x', min(255, (int)$m[1]), min(255, (int)$m[2]), min(255, (int)$m[3]));
		}
		return null;
	}

	/** A border "<w>px <solid|dashed|dotted|double> <colour>", normalised. */
	public static function border(string $b): ?string {
		if (!preg_match('/^\s*(\d{1,2}(?:\.\d+)?)px\s+(solid|dashed|dotted|double)\s+(\S+)\s*$/', $b, $m)) {
			return null;
		}
		$colour = self::colour($m[3]);
		$w = max(1, (int)round((float)$m[1]));
		return $colour === null ? null : $w . 'px ' . $m[2] . ' ' . $colour;
	}

	/** A border taken apart: [width px, style, colour]; null when it is not one. */
	public static function borderParts(string $b): ?array {
		if (!preg_match('/^(\d+)px (solid|dashed|dotted|double) (#[0-9a-f]{6})$/', $b, $m)) {
			return null;
		}
		return [(int)$m[1], $m[2], $m[3]];
	}
}
