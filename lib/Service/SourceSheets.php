<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * What the other apps hold, laid out as sheets: the answer of every import route
 * is one model fragment,
 *
 *   {sheets: [{name, cells, cols, merges}], source: {app, id, name, at}}
 *
 * (design contract §3; SPEC2 §B), which the browser puts in as new sheets, or
 * into the selection, as one step the person can undo. The Connectors read the
 * apps; this class decides what goes in which cell: field labels as a bold
 * header row, one row per record, numbers as numbers, dates as serials with a
 * date format, booleans as booleans, addresses as links, and FormulaBase's
 * expressions as live formulas where a spreadsheet can hold them.
 */
class SourceSheets {
	/** The functions the engine has (SPEC §4); a converted formula naming another is written as its value. */
	public const FUNCTIONS = ['SUM', 'SUMIF', 'SUMIFS', 'SUMPRODUCT', 'PRODUCT', 'AVERAGE', 'AVERAGEIF', 'AVERAGEIFS', 'MIN', 'MAX', 'MINIFS', 'MAXIFS', 'MEDIAN', 'MODE', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'COUNTIFS', 'LARGE', 'SMALL', 'RANK', 'STDEV', 'STDEVP', 'VAR', 'VARP', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'INT', 'TRUNC', 'MOD', 'ABS', 'SIGN', 'SQRT', 'POWER', 'EXP', 'LN', 'LOG', 'LOG10', 'PI', 'CEILING', 'FLOOR', 'MROUND', 'QUOTIENT', 'GCD', 'LCM', 'FACT', 'RAND', 'RANDBETWEEN', 'IF', 'IFS', 'IFERROR', 'IFNA', 'AND', 'OR', 'NOT', 'XOR', 'SWITCH', 'CHOOSE', 'TRUE', 'FALSE', 'CONCATENATE', 'CONCAT', 'TEXTJOIN', 'LEFT', 'RIGHT', 'MID', 'LEN', 'UPPER', 'LOWER', 'PROPER', 'TRIM', 'CLEAN', 'SUBSTITUTE', 'REPLACE', 'FIND', 'SEARCH', 'TEXT', 'VALUE', 'REPT', 'EXACT', 'CHAR', 'CODE', 'UNICHAR', 'UNICODE', 'FIXED', 'DOLLAR', 'VLOOKUP', 'HLOOKUP', 'LOOKUP', 'XLOOKUP', 'INDEX', 'MATCH', 'XMATCH', 'OFFSET', 'INDIRECT', 'ROW', 'ROWS', 'COLUMN', 'COLUMNS', 'ADDRESS', 'DATE', 'DATEVALUE', 'TIME', 'TIMEVALUE', 'TODAY', 'NOW', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'WEEKDAY', 'WEEKNUM', 'DATEDIF', 'DAYS', 'EDATE', 'EOMONTH', 'NETWORKDAYS', 'WORKDAY', 'ISBLANK', 'ISNUMBER', 'ISTEXT', 'ISLOGICAL', 'ISERROR', 'ISERR', 'ISNA', 'ISFORMULA', 'NA', 'N', 'T', 'TYPE', 'PMT', 'FV', 'PV', 'NPV', 'IRR', 'RATE', 'NPER', 'IPMT', 'PPMT'];

	public function __construct(
		private Connectors $connectors,
	) {
	}

	// ---- the fragment -------------------------------------------------------------

	/**
	 * The fragment as the browser takes it, cleaned as every model is (Model::clean:
	 * sheet names made unique, addresses checked, limits held).
	 *
	 * @param list<array<string, mixed>> $sheets
	 * @return array{sheets: list<array<string, mixed>>, source: array<string, mixed>}
	 */
	public static function fragment(array $sheets, string $app, int|string $id, string $name): array {
		if ($sheets === []) {
			throw new \InvalidArgumentException('nothing there to make a sheet of');
		}
		$clean = Model::forJson(Model::clean(['sheets' => $sheets, 'active' => 0]));
		return [
			'sheets' => $clean['sheets'],
			'source' => ['app' => $app, 'id' => $id, 'name' => mb_substr($name, 0, 200), 'at' => date('c')],
		];
	}

	/**
	 * A header row and rows of cells as one sheet.
	 *
	 * @param list<string> $header
	 * @param list<list<array<string, mixed>|null>> $rows each cell as TextValues gives it, or null for an empty one
	 */
	public static function grid(string $name, array $header, array $rows): array {
		$cells = [];
		$widths = [];
		foreach ($header as $c => $label) {
			$cells[Cells::ref(0, $c)] = ['v' => $label, 't' => 's', 's' => ['b' => 1]];
			$widths[$c] = mb_strwidth($label);
		}
		foreach ($rows as $r => $row) {
			foreach ($row as $c => $cell) {
				if ($cell === null || (($cell['v'] ?? '') === '' && !isset($cell['f']))) {
					continue;
				}
				$cells[Cells::ref($r + 1, $c)] = $cell;
				$shown = isset($cell['d']) ? (string)$cell['d'] : (is_string($cell['v'] ?? null) ? $cell['v'] : CsvFormat::shown($cell));
				$widths[$c] = max($widths[$c] ?? 0, min(60, mb_strwidth(strtok($shown, "\n") ?: '')));
			}
		}
		$cols = [];
		foreach ($widths as $c => $w) {
			if ($w > 8) {
				$cols[Cells::colName($c)] = (int)min(400, max(64, $w * 7 + 14));
			}
		}
		return ['name' => mb_substr($name, 0, 64), 'cells' => $cells, 'cols' => $cols, 'merges' => []];
	}

	// ---- RegiBase -----------------------------------------------------------------

	/** The collections, for the picker. */
	public function regibaseCollections(string $userId): array {
		return ['collections' => $this->connectors->regibaseCollections($userId)];
	}

	/** One collection as a sheet: labels as the header, a row per record, typed. */
	public function regibase(string $userId, int $collectionId): array {
		$got = $this->connectors->regibaseRecords($userId, $collectionId);
		$header = array_map(static fn (array $f): string => $f['label'], $got['fields']);
		$rows = [];
		foreach ($got['records'] as $record) {
			$row = [];
			foreach ($got['fields'] as $field) {
				$row[] = self::regibaseCell($field['type'], $record['data'][$field['key']] ?? null);
			}
			$rows[] = $row;
		}
		return self::fragment([self::grid($got['name'] !== '' ? $got['name'] : 'RegiBase', $header, $rows)], 'regibase', $collectionId, $got['name']);
	}

	/** @return array<string, mixed>|null */
	private static function regibaseCell(string $type, mixed $value): ?array {
		if ($value === null || $value === '') {
			return null;
		}
		if (is_bool($value)) {
			return ['v' => $value, 't' => 'b'];
		}
		$value = (string)$value;
		switch ($type) {
			case 'number':
				$read = TextValues::cell($value);
				return $read['t'] === 'n' ? $read : TextValues::text($value);
			case 'date':
				return TextValues::date($value);
			case 'datetime':
				return TextValues::date($value, true);
			case 'url':
				$cell = TextValues::text($value);
				if (preg_match('#^https?://#i', $value)) {
					$cell['link'] = mb_substr($value, 0, 2048);
				}
				return $cell;
			case 'email':
				$cell = TextValues::text($value);
				if (filter_var($value, FILTER_VALIDATE_EMAIL) !== false) {
					$cell['link'] = 'mailto:' . $value;
				}
				return $cell;
			case 'checkbox':
			case 'boolean':
				return ['v' => in_array(strtolower($value), ['1', 'true', 'yes', 'on'], true), 't' => 'b'];
			default:
				// Text stays text, whatever it looks like: a phone number keeps its leading zero.
				return TextValues::text($value);
		}
	}

	// ---- FormulaBase --------------------------------------------------------------

	public function formulaCollections(string $userId): array {
		return ['collections' => $this->connectors->formulaCollections($userId)];
	}

	/**
	 * One collection as a sheet: for each formula its name and description, the
	 * expression, a row per variable (label, value, unit) and the result -- a live
	 * CalcBase formula over the variables' cells where FormulaBase's expression
	 * can be written in Calc syntax, else the value FormulaBase works out.
	 */
	public function formulabase(string $userId, int $collectionId): array {
		$row = 0;
		$cells = [];
		$bold = static fn (string $v): array => ['v' => $v, 't' => 's', 's' => ['b' => 1]];
		// The connector asks for every formula's map before any row is written, so the
		// rows are counted here as they will be laid out below: the name, the expression,
		// one row per variable, the result and a blank row. Counting with $row itself gave
		// every formula the first formula's cells.
		$next = 0;
		$got = $this->connectors->formulas($userId, $collectionId, static function (array $keys) use (&$next): array {
			// The variables' cells: column B of the rows after the name and the expression.
			$map = [];
			foreach (array_values($keys) as $i => $key) {
				$map[$key] = 'B' . ($next + 3 + $i);
			}
			$next += count($keys) + 4;
			return $map;
		});
		foreach ($got['formulas'] as $formula) {
			$cells[Cells::ref($row, 0)] = $bold($formula['name']);
			if ($formula['description'] !== '') {
				$cells[Cells::ref($row, 1)] = TextValues::text($formula['description']);
			}
			$cells[Cells::ref($row + 1, 0)] = TextValues::text('Expression');
			$cells[Cells::ref($row + 1, 1)] = TextValues::text($formula['expression']);
			$r = $row + 2;
			foreach ($formula['variables'] as $v) {
				$cells[Cells::ref($r, 0)] = TextValues::text($v['label']);
				$cells[Cells::ref($r, 1)] = is_float($v['value']) || is_int($v['value']) ? ['v' => $v['value'], 't' => 'n'] : TextValues::text((string)$v['value']);
				if ($v['unit'] !== '') {
					$cells[Cells::ref($r, 2)] = TextValues::text($v['unit']);
				}
				$r++;
			}
			$cells[Cells::ref($r, 0)] = $bold('Result');
			$result = self::resultCell($formula);
			if ($result !== null) {
				$cells[Cells::ref($r, 1)] = $result;
			}
			if ($formula['unit'] !== '') {
				$cells[Cells::ref($r, 2)] = TextValues::text($formula['unit']);
			}
			// A blank row between formulas.
			$row = $r + 2;
		}
		$sheet = ['name' => $got['name'] !== '' ? $got['name'] : 'FormulaBase', 'cells' => $cells, 'cols' => ['A' => 160, 'B' => 160], 'merges' => []];
		return self::fragment([$sheet], 'formulabase', $collectionId, $got['name']);
	}

	/**
	 * The result cell: the formula in Calc syntax when every function in it is one
	 * the engine has, with the value FormulaBase worked out as its cached value;
	 * otherwise the value alone.
	 *
	 * @param array<string, mixed> $formula
	 */
	public static function resultCell(array $formula): ?array {
		$value = $formula['value'] ?? null;
		$cell = null;
		if (is_float($value) || is_int($value)) {
			$cell = ['v' => $value, 't' => 'n'];
			if (($formula['decimals'] ?? -1) >= 0 && ($formula['decimals'] ?? 0) <= 10 && $value != floor($value)) {
				$cell['fmt'] = (int)$formula['decimals'] === 0 ? '0' : '0.' . str_repeat('0', (int)$formula['decimals']);
			}
		} elseif (is_string($value) && $value !== '') {
			$cell = TextValues::text($value);
		}
		$odf = (string)($formula['odf'] ?? '');
		if ($odf !== '') {
			$typed = FormulaSyntax::fromOds('of:=' . $odf);
			if (self::functionsKnown($typed)) {
				$cell ??= ['v' => 0, 't' => 'n'];
				$cell['f'] = $typed;
			}
		}
		return $cell;
	}

	/** Whether every function named in a formula is one the engine has. */
	public static function functionsKnown(string $formula): bool {
		$body = preg_replace('/"(?:[^"]|"")*"/', '""', $formula) ?? $formula;
		if (!preg_match_all('/([A-Za-z][A-Za-z0-9_.]*)\s*\(/', $body, $m)) {
			return true;
		}
		foreach ($m[1] as $name) {
			if (!in_array(strtoupper($name), self::FUNCTIONS, true)) {
				return false;
			}
		}
		return true;
	}

	// ---- EditBase -----------------------------------------------------------------

	public function editbaseDocuments(string $userId): array {
		return ['documents' => $this->connectors->editbaseDocuments($userId)];
	}

	/** The tables of one document, each a sheet, formulas kept. */
	public function editbase(string $userId, int $fileId): array {
		$doc = $this->connectors->editbaseDocument($userId, $fileId);
		$sheets = HtmlTables::fromHtml($doc['html']);
		if ($sheets === []) {
			throw new \InvalidArgumentException('that document has no table in it');
		}
		return self::fragment($sheets, 'editbase', $fileId, $doc['name']);
	}

	// ---- NetBase ------------------------------------------------------------------

	/** The device inventory as one sheet. */
	public function netbase(string $userId): array {
		$devices = $this->connectors->netbaseDevices($userId);
		$header = ['Name', 'IP address', 'MAC address', 'Vendor', 'Kind', 'Place', 'First seen', 'Last seen', 'Online'];
		$rows = [];
		foreach ($devices as $d) {
			$rows[] = [
				TextValues::text($d['name']),
				TextValues::text($d['ip']),
				TextValues::text($d['mac']),
				TextValues::text($d['vendor']),
				TextValues::text($d['type']),
				TextValues::text(trim($d['location'] . ' ' . $d['room'])),
				$d['firstSeen'] !== null ? TextValues::unix($d['firstSeen']) : null,
				$d['lastSeen'] !== null ? TextValues::unix($d['lastSeen']) : null,
				['v' => $d['online'], 't' => 'b'],
			];
		}
		return self::fragment([self::grid('Devices', $header, $rows)], 'netbase', 'devices', 'NetBase');
	}

	// ---- Tables, Contacts, Calendar ---------------------------------------------

	public function tables(string $userId): array {
		return ['tables' => $this->connectors->tables($userId)];
	}

	public function table(string $userId, int $id): array {
		$got = $this->connectors->table($userId, $id);
		$rows = [];
		foreach ($got['rows'] as $row) {
			$cells = [];
			foreach ($row as $c => $value) {
				$type = $got['types'][$c] ?? 'text';
				$cells[] = match (true) {
					is_bool($value) => ['v' => $value, 't' => 'b'],
					is_float($value) || is_int($value) => ['v' => $value, 't' => 'n'],
					$type === 'date' || $type === 'datetime' => TextValues::date((string)$value, $type === 'datetime'),
					default => TextValues::text((string)$value),
				};
			}
			$rows[] = $cells;
		}
		return self::fragment([self::grid($got['title'] !== '' ? $got['title'] : 'Table', $got['columns'], $rows)], 'tables', $id, $got['title']);
	}

	public function contacts(string $userId, string $query = ''): array {
		$found = $this->connectors->contacts($userId, $query);
		$header = ['Name', 'Family name', 'Given name', 'Organisation', 'Title', 'E-mail', 'Telephone', 'Postcode', 'Street', 'Locality', 'Region', 'Country', 'Note'];
		$keys = ['name', 'family', 'given', 'org', 'title', 'email', 'tel', 'postcode', 'street', 'locality', 'region', 'country', 'note'];
		$rows = [];
		foreach ($found as $card) {
			$row = [];
			foreach ($keys as $key) {
				$cell = TextValues::text((string)($card[$key] ?? ''));
				if ($key === 'email' && $cell['v'] !== '' && filter_var($cell['v'], FILTER_VALIDATE_EMAIL) !== false) {
					$cell['link'] = 'mailto:' . $cell['v'];
				}
				$row[] = $cell;
			}
			$rows[] = $row;
		}
		return self::fragment([self::grid('Contacts', $header, $rows)], 'contacts', $query, 'Contacts');
	}

	public function calendars(string $userId): array {
		return ['calendars' => $this->connectors->calendars($userId)];
	}

	public function events(string $userId, string $from, string $to, string $calendar = ''): array {
		$events = $this->connectors->events($userId, $from, $to, $calendar);
		$header = ['Start', 'End', 'All day', 'Summary', 'Location', 'Calendar', 'Description'];
		$rows = [];
		foreach ($events as $e) {
			$rows[] = [
				TextValues::date(substr((string)$e['start'], 0, 19), !$e['allDay']),
				$e['end'] !== '' ? TextValues::date(substr((string)$e['end'], 0, 19), !$e['allDay']) : null,
				['v' => (bool)$e['allDay'], 't' => 'b'],
				TextValues::text((string)$e['summary']),
				TextValues::text((string)$e['location']),
				TextValues::text((string)$e['calendar']),
				TextValues::text((string)$e['description']),
			];
		}
		return self::fragment([self::grid('Events', $header, $rows)], 'calendar', $from . '..' . $to, 'Calendar');
	}

	// ---- the web and Markdown ------------------------------------------------------

	/** The tables of a web page, already fetched and in UTF-8. */
	public static function web(string $url, string $html): array {
		$sheets = HtmlTables::fromHtml($html);
		if ($sheets === []) {
			throw new \InvalidArgumentException('that page has no table in it');
		}
		$title = HtmlTables::title($html);
		return self::fragment($sheets, 'web', $url, $title !== '' ? $title : $url);
	}

	/** The pipe tables of a Markdown text. */
	public static function markdown(string $text, int $fileId, string $name): array {
		$sheets = MarkdownTables::fromText($text);
		if ($sheets === []) {
			throw new \InvalidArgumentException('that file has no table in it');
		}
		return self::fragment($sheets, 'markdown', $fileId, $name);
	}
}
