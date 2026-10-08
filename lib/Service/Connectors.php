<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

use OCP\App\IAppManager;
use OCP\Calendar\IManager as ICalendarManager;
use OCP\Contacts\IManager as IContactsManager;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\IConfig;
use OCP\Server;
use OCP\Share\IManager as IShareManager;

/**
 * Everything CalcBase reads out of the other apps on this server (EditBase's
 * Connectors, with what a spreadsheet needs: the type of each value, not only
 * its text).
 *
 * Each one is optional: the app may not be installed, and its classes may not
 * exist, so every call is guarded and every failure degrades to "this source is
 * not available" rather than breaking the sheet. Calls go through the other
 * app's own service layer in-process -- no HTTP, no tokens, and the other app's
 * permission checks still apply because the user id is passed to them (or, for
 * NetBase, because its own permission service judges the session).
 */
class Connectors {
	public const ROW_LIMIT = 2000;
	/** How many tables are taken out of one document. */
	public const TABLE_LIMIT = 50;
	/** A document larger than this is not read for its tables. */
	public const DOCUMENT_BYTES = 16 * 1024 * 1024;
	public const SOURCES = ['regibase', 'formulabase', 'editbase', 'netbase', 'tables', 'contacts', 'calendar'];

	public function __construct(
		private IAppManager $appManager,
		private IContactsManager $contacts,
		private SharingPolicy $policy,
		private IShareManager $shares,
		private IRootFolder $rootFolder,
		private IConfig $config,
	) {
	}

	/** @return array<string, bool> */
	public function available(string $userId): array {
		return [
			'regibase' => $this->enabled('regibase', $userId) && class_exists('\OCA\RegiBase\Service\RegiBaseService'),
			'formulabase' => $this->enabled('formulabase', $userId) && class_exists('\OCA\FormulaBase\Db\CollectionMapper'),
			// A document's tables are read from the file itself, so EditBase's classes
			// are not needed; only the app has to be there for the person to have documents.
			'editbase' => $this->enabled('editbase', $userId),
			// The device list is NetBase's inventory of a private network: NetBase's own
			// rule says who may read it (administrators, unless its settings say more).
			'netbase' => $this->enabled('netbase', $userId) && class_exists('\OCA\NetBase\Db\DeviceMapper') && $this->netbaseAllowed(),
			'tables' => $this->enabled('tables', $userId) && class_exists('\OCA\Tables\Service\TableService'),
			'contacts' => $this->enabled('contacts', $userId) && $this->contacts->isEnabled(),
			// Reading events needs the CalDAV backend, not the Calendar app's interface:
			// a server without the Calendar app still has the user's calendars.
			'calendar' => $this->enabled('dav', $userId),
		];
	}

	/** Another app's service, by its class name. Tests put stand-ins here. */
	protected function get(string $class): object {
		return Server::get(ltrim($class, '\\'));
	}

	private function enabled(string $app, string $userId): bool {
		try {
			$user = $this->get(\OCP\IUserManager::class)->get($userId);
			if ($user === null || !$this->appManager->isEnabledForUser($app, $user)) {
				return false;
			}
			// An enabled app's classes are not autoloadable until the app is loaded,
			// so class_exists() would say no for an app that is right there.
			\OC_App::loadApp($app);
			return true;
		} catch (\Throwable $e) {
			return false;
		}
	}

	private function need(string $source, string $userId): void {
		if (empty($this->available($userId)[$source])) {
			throw new \InvalidArgumentException($source . ' is not available');
		}
	}

	// ---- Tables -----------------------------------------------------------------

	/** @return array<int, array<string, mixed>> */
	public function tables(string $userId): array {
		$this->need('tables', $userId);
		$service = $this->get(\OCA\Tables\Service\TableService::class);
		$out = [];
		foreach ($service->findAll($userId) as $table) {
			$out[] = [
				'id' => (int)$table->getId(),
				'title' => (string)$table->getTitle(),
				'emoji' => method_exists($table, 'getEmoji') ? (string)$table->getEmoji() : '',
			];
		}
		return $out;
	}

	/**
	 * One table as a header row and body rows. Numbers stay numbers, booleans
	 * booleans, dates ISO text (the sheet maker turns them into serials).
	 *
	 * @return array{title: string, columns: list<string>, types: list<string>, rows: list<list<mixed>>}
	 */
	public function table(string $userId, int $id): array {
		$this->need('tables', $userId);
		$tableService = $this->get(\OCA\Tables\Service\TableService::class);
		$columnService = $this->get(\OCA\Tables\Service\ColumnService::class);
		$rowService = $this->get(\OCA\Tables\Service\RowService::class);

		$table = $tableService->find($id, false, $userId);
		$columns = $columnService->findAllByTable($id, $userId);
		$titles = [];
		$types = [];
		$options = [];
		$order = [];
		foreach ($columns as $i => $col) {
			$colId = (int)$col->getId();
			$titles[] = (string)$col->getTitle();
			$type = (string)$col->getType();
			$sub = method_exists($col, 'getSubtype') ? (string)$col->getSubtype() : '';
			$types[] = $type === 'number' ? 'number' : ($type === 'datetime' ? ($sub === 'date' ? 'date' : 'datetime') : ($type === 'selection' && $sub === 'check' ? 'boolean' : 'text'));
			$order[$colId] = $i;
			$map = [];
			if ($type === 'selection') {
				try {
					foreach ($col->getSelectionOptionsArray() as $o) {
						if (isset($o['id'])) {
							$map[(string)$o['id']] = (string)($o['label'] ?? $o['id']);
						}
					}
				} catch (\Throwable $e) { /* an unlabelled option prints as its id */ }
			}
			$options[$colId] = $map;
		}
		$rows = [];
		foreach ($rowService->findAllByTable($id, $userId) as $row) {
			$cells = array_fill(0, count($titles), '');
			foreach (($row->getData() ?? []) as $cell) {
				$colId = (int)($cell['columnId'] ?? 0);
				if (!isset($order[$colId])) {
					continue;
				}
				$value = $cell['value'] ?? null;
				$type = $types[$order[$colId]];
				if ($type === 'number' && is_numeric($value)) {
					$cells[$order[$colId]] = (float)$value;
				} elseif ($type === 'boolean') {
					$cells[$order[$colId]] = $value === true || $value === 'true' || $value === 1 || $value === '1';
				} else {
					$cells[$order[$colId]] = $this->cellToString($value, $options[$colId] ?? []);
				}
			}
			$rows[] = $cells;
			if (count($rows) >= self::ROW_LIMIT) {
				break;
			}
		}
		return ['title' => (string)$table->getTitle(), 'columns' => $titles, 'types' => $types, 'rows' => $rows];
	}

	/** @param array<string, string> $options */
	private function cellToString(mixed $value, array $options): string {
		if ($value === null || $value === '') {
			return '';
		}
		if (is_bool($value)) {
			return $value ? '✓' : '';
		}
		if (is_scalar($value)) {
			$s = (string)$value;
			return $options[$s] ?? $s;
		}
		if (is_array($value)) {
			$parts = [];
			foreach ($value as $v) {
				if (is_array($v)) {
					$v = $v['label'] ?? ($v['value'] ?? ($v['title'] ?? json_encode($v, JSON_UNESCAPED_UNICODE)));
				}
				$s = (string)$v;
				$parts[] = $options[$s] ?? $s;
			}
			return implode(', ', array_filter($parts, static fn ($p) => $p !== ''));
		}
		return '';
	}

	// ---- Contacts ---------------------------------------------------------------

	/**
	 * Contacts the user can read, flattened into the fields a list needs.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function contacts(string $userId, string $query = '', int $limit = 200): array {
		$this->need('contacts', $userId);
		// The user's own address books are theirs to read. The system address book is
		// every account on the server, and the administrator decides how much of it a
		// search may show, as core's contacts menu does (EditBase review S5).
		$found = $this->contacts->search($query, ['FN', 'N', 'ORG', 'EMAIL', 'NICKNAME'], [
			'types' => true,
			'limit' => $limit,
			'enumeration' => $this->shares->allowEnumeration(),
			'fullmatch' => $this->shares->allowEnumerationFullMatch(),
		]);
		$out = [];
		foreach ($found as $card) {
			if (!empty($card['isLocalSystemBook'])
				&& !$this->policy->mayListAccount($userId, (string)($card['UID'] ?? ''), $this->emailsOf($card), $query)) {
				continue;
			}
			$fields = $this->contactFields($card);
			$fields['system'] = !empty($card['isLocalSystemBook']);
			$out[] = $fields;
			if (count($out) >= $limit) {
				break;
			}
		}
		usort($out, static fn (array $a, array $b): int => strnatcasecmp((string)$a['name'], (string)$b['name']));
		return $out;
	}

	/**
	 * @param array<string, mixed> $card
	 * @return list<string>
	 */
	private function emailsOf(array $card): array {
		$out = [];
		foreach ((array)($card['EMAIL'] ?? []) as $value) {
			$value = is_array($value) ? ($value['value'] ?? '') : $value;
			if (is_string($value) && $value !== '') {
				$out[] = $value;
			}
		}
		return $out;
	}

	/**
	 * @param array<string, mixed> $card
	 * @return array<string, mixed>
	 */
	private function contactFields(array $card): array {
		$first = static function (mixed $v): string {
			// vCard values arrive as a string, a list, or a list of ['type'=>…,'value'=>…]
			if (is_string($v)) {
				return $v;
			}
			if (is_array($v)) {
				$head = reset($v);
				if (is_array($head)) {
					return (string)($head['value'] ?? '');
				}
				return (string)$head;
			}
			return '';
		};
		$name = (string)($card['FN'] ?? '');
		$org = $card['ORG'] ?? '';
		$org = is_array($org) ? implode(' ', array_map('strval', $org)) : (string)$org;
		// ADR is ;-separated: po box; extended; street; locality; region; postcode; country
		$adrRaw = $card['ADR'] ?? '';
		$adr = is_array($adrRaw) ? ($adrRaw[0] ?? '') : $adrRaw;
		if (is_array($adr)) {
			$adr = $adr['value'] ?? '';
		}
		$parts = is_string($adr) ? explode(';', $adr) : [];
		$parts = array_map(static fn ($p) => trim((string)$p), array_pad($parts, 7, ''));
		$nameParts = $card['N'] ?? '';
		$nameParts = is_array($nameParts) ? ($nameParts[0] ?? '') : $nameParts;
		$n = is_string($nameParts) ? array_map('trim', array_pad(explode(';', $nameParts), 5, '')) : ['', '', '', '', ''];
		return [
			'id' => (string)($card['UID'] ?? ''),
			'name' => $name,
			'family' => $n[0] ?? '',
			'given' => $n[1] ?? '',
			'org' => $org,
			'title' => $first($card['TITLE'] ?? ''),
			'email' => $first($card['EMAIL'] ?? ''),
			'tel' => $first($card['TEL'] ?? ''),
			'postcode' => $parts[6] === '' ? ($parts[5] ?? '') : $parts[5],
			'street' => trim(($parts[2] ?? '') . ' ' . ($parts[1] ?? '')),
			'locality' => $parts[3] ?? '',
			'region' => $parts[4] ?? '',
			'country' => $parts[6] ?? '',
			'note' => $first($card['NOTE'] ?? ''),
		];
	}

	// ---- Calendar ---------------------------------------------------------------

	/** @return array<int, array<string, string>> */
	public function calendars(string $userId): array {
		$this->need('calendar', $userId);
		$manager = $this->get(ICalendarManager::class);
		$out = [];
		foreach ($manager->getCalendarsForPrincipal('principals/users/' . $userId) as $calendar) {
			$out[] = [
				'key' => (string)$calendar->getKey(),
				'uri' => method_exists($calendar, 'getUri') ? (string)$calendar->getUri() : '',
				'name' => (string)$calendar->getDisplayName(),
				'colour' => (string)($calendar->getDisplayColor() ?? ''),
			];
		}
		return $out;
	}

	/**
	 * Events in a range, flattened and sorted, ready to become rows.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function events(string $userId, string $from, string $to, string $calendarKey = ''): array {
		// A date that cannot be read is the request's fault, not the server's.
		try {
			$start = new \DateTimeImmutable($from);
			$end = new \DateTimeImmutable($to);
		} catch (\Throwable) {
			throw new \InvalidArgumentException('the date range could not be read');
		}
		$this->need('calendar', $userId);
		$manager = $this->get(ICalendarManager::class);
		$out = [];
		foreach ($manager->getCalendarsForPrincipal('principals/users/' . $userId) as $calendar) {
			if ($calendarKey !== '' && (string)$calendar->getKey() !== $calendarKey) {
				continue;
			}
			$found = [];
			try {
				$found = $calendar->search('', [], ['timerange' => ['start' => $start, 'end' => $end]], 500);
			} catch (\Throwable $e) {
				continue;
			}
			foreach ($found as $item) {
				foreach (($item['objects'] ?? []) as $object) {
					$event = $this->eventFields($object, (string)$calendar->getDisplayName());
					if ($event !== null) {
						$out[] = $event;
					}
				}
			}
		}
		usort($out, static fn (array $a, array $b): int => strcmp((string)$a['start'], (string)$b['start']));
		return $out;
	}

	/**
	 * @param array<string, mixed> $object
	 * @return array<string, mixed>|null
	 */
	private function eventFields(array $object, string $calendarName): ?array {
		$value = static function (mixed $v): mixed {
			if (is_array($v)) {
				return reset($v);
			}
			return $v;
		};
		$startRaw = $value($object['DTSTART'] ?? null);
		if (!($startRaw instanceof \DateTimeInterface)) {
			return null;
		}
		$endRaw = $value($object['DTEND'] ?? null);
		// An all-day event carries a date with no time part; Nextcloud marks it in the
		// property parameters, and a midnight-to-midnight span means the same thing.
		$allDay = $startRaw->format('His') === '000000'
			&& (!($endRaw instanceof \DateTimeInterface) || $endRaw->format('His') === '000000');
		return [
			'summary' => (string)$value($object['SUMMARY'] ?? ''),
			'location' => (string)$value($object['LOCATION'] ?? ''),
			'description' => (string)$value($object['DESCRIPTION'] ?? ''),
			'start' => $startRaw->format('c'),
			'end' => $endRaw instanceof \DateTimeInterface ? $endRaw->format('c') : '',
			'allDay' => $allDay,
			'calendar' => $calendarName,
		];
	}

	// ---- RegiBase ---------------------------------------------------------------

	/** @return array<int, array<string, mixed>> */
	public function regibaseCollections(string $userId): array {
		$this->need('regibase', $userId);
		$service = $this->get(\OCA\RegiBase\Service\RegiBaseService::class);
		$out = [];
		foreach ($service->listCollections($userId) as $collection) {
			$out[] = [
				'id' => (int)($collection['id'] ?? 0),
				'name' => (string)($collection['name'] ?? ''),
				'icon' => (string)($collection['icon'] ?? ''),
				'count' => (int)($collection['record_count'] ?? $collection['count'] ?? 0),
			];
		}
		return $out;
	}

	/**
	 * A collection's fields and records, each value with the kind of field it came
	 * from so the sheet can hold a number as a number and a date as a date.
	 *
	 * Secret fields are never returned: they are encrypted for the browser that
	 * holds the key, and a sheet is not that place. A value that arrives encrypted
	 * anyway (rbenc1:…) is left out too.
	 *
	 * @return array{name: string, fields: list<array{key: string, label: string, type: string}>, records: list<array{id: int, data: array<string, mixed>}>}
	 */
	public function regibaseRecords(string $userId, int $collectionId): array {
		$this->need('regibase', $userId);
		$service = $this->get(\OCA\RegiBase\Service\RegiBaseService::class);
		$collection = $service->getCollection($userId, $collectionId);
		$fields = [];
		$skip = [];
		$attach = [];
		foreach (($collection['fields'] ?? []) as $field) {
			$key = (string)($field['key'] ?? '');
			$type = (string)($field['type'] ?? 'text');
			$secret = !empty($field['secret']) || $type === 'password' || $type === 'secret';
			if ($key === '' || $secret) {
				if ($key !== '') {
					$skip[$key] = true;
				}
				continue;
			}
			if (in_array($type, ['image', 'image_crop', 'file'], true)) {
				$attach[$key] = true;
			}
			$fields[] = ['key' => $key, 'label' => (string)($field['label'] ?? $key), 'type' => $type];
		}
		$records = [];
		$reader = null;
		foreach ($service->listRecords($userId, $collectionId, null, null) as $record) {
			$data = [];
			foreach (($record['data'] ?? []) as $key => $value) {
				if (isset($skip[$key]) || !is_scalar($value)) {
					continue;
				}
				$value = is_bool($value) ? $value : (string)$value;
				if (is_string($value) && str_starts_with($value, 'rbenc1:')) {
					continue;
				}
				if (isset($attach[$key]) && is_string($value) && $value !== '') {
					// An attachment is a file id; the sheet shows the file's name. Whose
					// Files it is in -- the owner's, for a collection shared with this
					// person -- RegiBase itself says, once per collection.
					$reader ??= (string)$service->attachmentReader($userId, $collectionId, $value);
					$value = $this->attachmentName($reader, $value);
				}
				$data[(string)$key] = $value;
			}
			$records[] = ['id' => (int)($record['id'] ?? 0), 'data' => $data];
			if (count($records) >= self::ROW_LIMIT) {
				break;
			}
		}
		return ['name' => (string)($collection['name'] ?? ''), 'fields' => $fields, 'records' => $records];
	}

	/** The name of an attached file, or its id when it cannot be found. */
	private function attachmentName(string $uid, string $fileId): string {
		if (!preg_match('/^\d+$/', $fileId)) {
			return $fileId;
		}
		try {
			foreach ($this->rootFolder->getUserFolder($uid)->getById((int)$fileId) as $node) {
				return $node->getName();
			}
		} catch (\Throwable) {
			// not this person's to see: the id says as much as may be said
		}
		return $fileId;
	}

	// ---- FormulaBase ------------------------------------------------------------

	/** @return array<int, array<string, mixed>> */
	public function formulaCollections(string $userId): array {
		$this->need('formulabase', $userId);
		$mapper = $this->get(\OCA\FormulaBase\Db\CollectionMapper::class);
		$out = [];
		foreach ($mapper->findAllForUser($userId) as $collection) {
			$out[] = [
				'id' => (int)$collection->getId(),
				'name' => (string)$collection->getName(),
				'icon' => method_exists($collection, 'getIcon') ? (string)$collection->getIcon() : '',
				'description' => method_exists($collection, 'getDescription') ? (string)$collection->getDescription() : '',
			];
		}
		return $out;
	}

	/**
	 * A collection's formulas, each with its variables (key, label, default, unit)
	 * and, where FormulaBase's expression can be written for a spreadsheet, the
	 * OpenFormula body with the variables as cells of the caller's choosing:
	 * $cells(variableKeys) gives the address of each variable.
	 *
	 * @param callable(list<string>): array<string, string> $cells
	 * @return array{name: string, formulas: list<array<string, mixed>>}
	 */
	public function formulas(string $userId, int $collectionId, callable $cells): array {
		$this->need('formulabase', $userId);
		// findForUser throws if the collection is not this user's.
		$collection = $this->get(\OCA\FormulaBase\Db\CollectionMapper::class)->findForUser($collectionId, $userId);
		$mapper = $this->get(\OCA\FormulaBase\Db\FormulaMapper::class);
		$compiler = $this->get(\OCA\FormulaBase\Service\FormulaCompiler::class);
		$out = [];
		foreach ($mapper->findForCollection($collectionId) as $formula) {
			$vars = json_decode((string)$formula->getVariables(), true);
			$vars = is_array($vars) ? array_values(array_filter($vars, 'is_array')) : [];
			$variables = [];
			$scope = [];
			foreach ($vars as $v) {
				$key = trim((string)($v['key'] ?? ''));
				if ($key === '') {
					continue;
				}
				$kind = method_exists($compiler, 'variableKind') ? (string)$compiler::variableKind($v) : 'number';
				$default = $v['default'] ?? null;
				$value = $kind === 'number'
					? (is_numeric($default) ? (float)$default : 0.0)
					: $compiler->parseValue(is_string($default) ? $default : '');
				$scope[$key] = $value;
				$variables[] = [
					'key' => $key,
					'label' => (string)($v['label'] ?? $key),
					'unit' => (string)($v['unit'] ?? ''),
					'value' => $kind === 'number' ? $value : (is_string($default) ? $default : ''),
					'kind' => $kind,
				];
			}
			$expression = (string)$formula->getExpression();
			$odf = '';
			$value = null;
			// Asked once for every formula, whether or not it parses, so the caller can
			// count its way down the sheet and give each formula's variables their own rows.
			$map = $cells(array_keys($scope));
			try {
				$ast = $compiler->parse($expression);
				$odf = (string)$compiler->toOdf($ast, $map, $scope);
				$result = $compiler->evaluate($ast, $scope);
				$value = (is_float($result) || is_int($result)) && is_finite((float)$result) ? (float)$result : (is_scalar($result) ? (string)$result : (string)$compiler->formatValue($result));
			} catch (\Throwable $e) {
				// Not a formula a spreadsheet can hold: the value alone is given, when there is one.
				$odf = '';
			}
			$out[] = [
				'id' => (int)$formula->getId(),
				'name' => (string)$formula->getName(),
				'expression' => $expression,
				'description' => (string)$formula->getDescription(),
				'unit' => (string)$formula->getResultUnit(),
				'decimals' => (int)$formula->getDecimals(),
				'variables' => $variables,
				'odf' => $odf,
				'value' => $value,
			];
		}
		return ['name' => (string)$collection->getName(), 'formulas' => $out];
	}

	// ---- EditBase ---------------------------------------------------------------

	/**
	 * The person's EditBase documents: through EditBase's own listing when its
	 * classes are there, else the .html files in their EditBase folder.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function editbaseDocuments(string $userId): array {
		$this->need('editbase', $userId);
		$out = [];
		if (class_exists('\OCA\EditBase\Service\DocumentService')) {
			try {
				foreach ($this->get(\OCA\EditBase\Service\DocumentService::class)->list($userId) as $row) {
					$out[] = [
						'id' => (int)($row['id'] ?? 0),
						'name' => (string)($row['title'] ?? preg_replace('/\.html?$/i', '', (string)($row['name'] ?? ''))),
						'folder' => (string)($row['folder'] ?? ''),
						'mtime' => (int)($row['mtime'] ?? 0),
						'shared' => !empty($row['shared']),
						'owner' => (string)($row['owner'] ?? ''),
					];
				}
				return $out;
			} catch (\Throwable $e) {
				// fall back to the folder itself
			}
		}
		$name = trim($this->config->getUserValue($userId, 'editbase', 'folder', 'EditBase'), "/ \t\n\r\0\x0B");
		try {
			$folder = $this->rootFolder->getUserFolder($userId)->get($name === '' ? 'EditBase' : $name);
		} catch (NotFoundException) {
			return [];
		}
		if ($folder instanceof Folder) {
			$this->gatherHtml($folder, '', $out);
		}
		usort($out, static fn ($a, $b) => $b['mtime'] <=> $a['mtime']);
		return $out;
	}

	/** @param array<int, array<string, mixed>> $out */
	private function gatherHtml(Folder $folder, string $path, array &$out, int $depth = 0): void {
		foreach ($folder->getDirectoryListing() as $node) {
			if ($node instanceof Folder) {
				if ($depth < 4) {
					$this->gatherHtml($node, $path === '' ? $node->getName() : $path . '/' . $node->getName(), $out, $depth + 1);
				}
				continue;
			}
			if ($node instanceof File && preg_match('/\.html?$/i', $node->getName())) {
				$out[] = [
					'id' => $node->getId(),
					'name' => preg_replace('/\.html?$/i', '', $node->getName()) ?? $node->getName(),
					'folder' => $path,
					'mtime' => $node->getMTime(),
					'shared' => false,
					'owner' => '',
				];
			}
		}
	}

	/**
	 * The HTML of one document in the person's Files -- an EditBase document or
	 * any other .html file they can open -- for its tables.
	 *
	 * @return array{name: string, html: string}
	 */
	public function editbaseDocument(string $userId, int $fileId): array {
		$this->need('editbase', $userId);
		$file = null;
		foreach ($this->rootFolder->getUserFolder($userId)->getById($fileId) as $node) {
			if ($node instanceof File) {
				$file = $node;
				break;
			}
		}
		if ($file === null) {
			throw new NotFoundException('document ' . $fileId . ' not found');
		}
		if (!preg_match('/\.html?$/i', $file->getName())) {
			throw new \InvalidArgumentException('not an HTML document');
		}
		// Its tables, put into a book of one's own, are a copy of them (EditBase review S3).
		if (!Downloads::allowed($file)) {
			throw new \OCP\Files\NotPermittedException('whoever shared this document does not allow it to be downloaded');
		}
		if ($file->getSize() > self::DOCUMENT_BYTES) {
			throw new \InvalidArgumentException('that document is too large to read');
		}
		$read = TextEncoding::htmlToUtf8((string)$file->getContent());
		return ['name' => preg_replace('/\.html?$/i', '', $file->getName()) ?? $file->getName(), 'html' => $read['text']];
	}

	// ---- NetBase ----------------------------------------------------------------

	/** Whether NetBase's own rule lets the person in this session read the device list. */
	private function netbaseAllowed(): bool {
		try {
			return (bool)$this->get(\OCA\NetBase\Service\PermissionService::class)->can('devices');
		} catch (\Throwable $e) {
			return false;
		}
	}

	/**
	 * NetBase's device inventory, as NetBase's own assistant may see it: what a
	 * device is and where, never the notes (they are where people write passwords),
	 * nothing from the saved connections.
	 *
	 * @return list<array<string, mixed>>
	 */
	public function netbaseDevices(string $userId): array {
		$this->need('netbase', $userId);
		$mapper = $this->get(\OCA\NetBase\Db\DeviceMapper::class);
		$out = [];
		foreach ($mapper->findAll(self::ROW_LIMIT) as $device) {
			$j = $device->jsonSerialize();
			$out[] = [
				'name' => (string)($j['name'] ?? ''),
				'hostname' => (string)($j['hostname'] ?? ''),
				'ip' => (string)($j['ip'] ?? ''),
				'mac' => (string)($j['mac'] ?? ''),
				'vendor' => (string)($j['vendor'] ?? ''),
				'type' => (string)($j['type'] ?? ''),
				'location' => (string)($j['location'] ?? ''),
				'room' => (string)($j['room'] ?? ''),
				'firstSeen' => is_int($j['firstSeen'] ?? null) ? $j['firstSeen'] : null,
				'lastSeen' => is_int($j['lastSeen'] ?? null) ? $j['lastSeen'] : null,
				'online' => !empty($j['online']),
			];
		}
		return $out;
	}
}
