<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

use OCA\CalcBase\AppInfo\Application;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\IL10N;
use OCP\L10N\IFactory;

/**
 * What the assistant can do with the writer's books by itself (the owner, 2026-11-07:
 * "RegiBase の中は自由に AI が操作できるようにしろ" -- and the same for the other apps).
 *
 * The open book is changed as before: the cells the assistant proposes come back in the
 * answer and the page applies them as one step the writer can undo. These tools reach the
 * other books: list them, read them, make a new one, write cells into one that is not open,
 * rename one, put one in the trash, and look at and put back their versions. They run with
 * the rights of the person asking, through BookService: a book shared read-only cannot be
 * written, and every write keeps a version of what was there first (as a manual save does),
 * so "Versions…" can put it back. A deleted book goes to the trash bin with its versions.
 *
 * The book open in the asking page is never written, renamed or deleted from here: the page
 * holds it and would save over it. Which one is open is noted when the question is asked
 * (noteOpen()), since AI-Hub answers in a request of its own.
 */
class AiTools {
	private const OPEN_TTL = 3600;
	private const OUT_MAX = 60000;
	/** The most rows and columns read from one sheet at once. */
	private const READ_ROWS = 500;
	private const READ_COLS = 60;
	private const MAX_WRITES = 2000;
	private const DEF_COL_W = 80;

	public function __construct(
		private BookService $books,
		private IConfig $config,
		private ICacheFactory $cacheFactory,
		private IFactory $l10nFactory,
	) {
	}

	/**
	 * The asking person's language: AI-Hub answers in a request of its own, where the page's
	 * language is not known, so it is looked up for them.
	 */
	private function l(string $uid = ''): IL10N {
		$lang = $uid !== '' ? $this->config->getUserValue($uid, 'core', 'lang', '') : '';
		return $this->l10nFactory->get(Application::APP_ID, $lang !== '' ? $lang : null);
	}

	// ---- the book open in the asking page ----

	private function cache(): ?\OCP\ICache {
		return $this->cacheFactory->isAvailable() ? $this->cacheFactory->createDistributed(Application::APP_ID . '_ai_open') : null;
	}

	public function noteOpen(string $uid, int $bookId): void {
		$cache = $this->cache();
		if ($cache !== null) {
			$cache->set('open_' . $uid, $bookId, self::OPEN_TTL);
		} else {
			$this->config->setUserValue($uid, Application::APP_ID, 'ai_open_book', $bookId . ':' . (time() + self::OPEN_TTL));
		}
	}

	private function openBook(string $uid): int {
		$cache = $this->cache();
		if ($cache !== null) {
			return (int)($cache->get('open_' . $uid) ?? 0);
		}
		[$id, $until] = array_pad(explode(':', $this->config->getUserValue($uid, Application::APP_ID, 'ai_open_book', '')), 2, '0');
		return (int)$until >= time() ? (int)$id : 0;
	}

	private function notOpen(string $uid, int $id): void {
		if ($id > 0 && $id === $this->openBook($uid)) {
			throw new \InvalidArgumentException('That is the book open in front of the writer: change its cells with "edits" in your answer, not with this tool. Renaming or deleting it is done by the writer.');
		}
	}

	// ---- the tools ----

	/** @param callable(): list<string> $allowed what the administrator allows (AiService::EXTRA among it) */
	public function tools(callable $allowed): array {
		$l = $this->l();
		$wrap = function (string $need, callable $fn) use ($allowed): callable {
			return function (string $uid, array $args) use ($need, $fn, $allowed) {
				if (!in_array($need, $allowed(), true)) {
					return json_encode(['error' => $need === 'write'
						? 'The administrator has not allowed the assistant to make or change books.'
						: 'The administrator has not allowed the assistant to read the other books.']);
				}
				try {
					$out = $fn($uid, $args);
				} catch (\OCP\Files\NotFoundException $e) {
					$out = ['error' => 'Not found: no such book, or not one this person can open.'];
				} catch (\OCP\Files\NotPermittedException $e) {
					$out = ['error' => 'Not permitted: the book is shared read-only, or the folder cannot be written.'];
				} catch (\InvalidArgumentException|\RuntimeException $e) {
					$out = ['error' => $e->getMessage()];
				}
				$json = json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
				return mb_strlen($json) > self::OUT_MAX ? mb_substr($json, 0, self::OUT_MAX) . ' …(cut: read a smaller range)' : $json;
			};
		};
		$id = ['type' => 'integer'];
		return [
			'list_books' => [
				'kind' => 'read',
				'label' => $l->t('List the books'),
				'description' => 'The writer\'s books (their own, in their categories, and those shared with them): id, name, category, last changed, read-only or not, and which one is open now.',
				'input' => ['type' => 'object', 'properties' => new \stdClass()],
				'run' => $wrap('books', fn ($uid) => $this->listBooks($uid)),
			],
			'read_book' => [
				'kind' => 'read',
				'label' => $l->t('Read a book'),
				'description' => 'A book\'s sheets as tab-separated rows from A1 (a formula is written as the formula, then " → " and the value it showed when saved). sheet: one sheet by name (all when left out); range: e.g. "A1:F50". At most 500 rows and 60 columns of a sheet.',
				'input' => ['type' => 'object', 'properties' => ['id' => $id, 'sheet' => ['type' => 'string'], 'range' => ['type' => 'string']], 'required' => ['id']],
				'run' => $wrap('books', fn ($uid, $a) => $this->readBook($uid, (int)$a['id'], (string)($a['sheet'] ?? ''), (string)($a['range'] ?? ''))),
			],
			'create_book' => [
				'kind' => 'create',
				'label' => $l->t('Make a book'),
				'description' => 'Make a new book: name, category (a folder in the CalcBase folder; "" = the top), and sheets: a list of {"name": "<sheet name>", "rows": [[cell, …], …]} from A1, each cell what one would type (a formula starting with =, a number, a date as 2026/10/5, text, TRUE/FALSE). Returns its id; it opens from the book list.',
				'input' => ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'category' => ['type' => 'string'],
					'sheets' => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'rows' => ['type' => 'array']], 'required' => ['rows']]]], 'required' => ['name', 'sheets']],
				'run' => $wrap('write', fn ($uid, $a) => $this->createBook($uid, $a)),
			],
			'write_cells' => [
				'kind' => 'update',
				'label' => $l->t('Write cells into a book'),
				'description' => 'Write cells into a book that is NOT the open one: edits is a list of {sheet (omit for the first), cell: "B2", input: what one would type, "" clears}. A version of the book as it was is kept first, so "Versions…" can put it back. Not for the open book: change that with "edits" in your answer.',
				'input' => ['type' => 'object', 'properties' => ['id' => $id, 'edits' => ['type' => 'array', 'items' => ['type' => 'object']]], 'required' => ['id', 'edits']],
				'run' => $wrap('write', fn ($uid, $a) => $this->writeCells($uid, (int)$a['id'], (array)$a['edits'])),
			],
			'rename_book' => [
				'kind' => 'update',
				'label' => $l->t('Rename a book'),
				'description' => 'Rename a book (not the open one).',
				'input' => ['type' => 'object', 'properties' => ['id' => $id, 'name' => ['type' => 'string']], 'required' => ['id', 'name']],
				'run' => $wrap('write', fn ($uid, $a) => $this->renameBook($uid, (int)$a['id'], (string)$a['name'])),
			],
			'delete_book' => [
				'kind' => 'delete',
				'label' => $l->t('Put a book in the trash bin'),
				'description' => 'Put a book (not the open one) in the trash bin, with its versions; it can be restored from the Files trash bin.',
				'input' => ['type' => 'object', 'properties' => ['id' => $id], 'required' => ['id']],
				'run' => $wrap('write', fn ($uid, $a) => $this->deleteBook($uid, (int)$a['id'])),
			],
			'book_versions' => [
				'kind' => 'read',
				'label' => $l->t('List a book\'s versions'),
				'description' => 'The versions kept of a book, newest first (number, when, size).',
				'input' => ['type' => 'object', 'properties' => ['id' => $id], 'required' => ['id']],
				'run' => $wrap('books', fn ($uid, $a) => ['versions' => $this->books->versions($uid, (int)$a['id'])]),
			],
			'restore_version' => [
				'kind' => 'update',
				'label' => $l->t('Put a version back'),
				'description' => 'Put a version of a book (not the open one) back, by its number from book_versions; what is there now is kept as a version first.',
				'input' => ['type' => 'object', 'properties' => ['id' => $id, 'number' => ['type' => 'integer']], 'required' => ['id', 'number']],
				'run' => $wrap('write', fn ($uid, $a) => $this->restoreVersion($uid, (int)$a['id'], (int)$a['number'])),
			],
		];
	}

	// ---- reading ----

	private function listBooks(string $uid): array {
		$open = $this->openBook($uid);
		$out = [];
		foreach ($this->books->list($uid) as $b) {
			$row = ['id' => (int)$b['id'], 'name' => (string)$b['title'], 'category' => (string)($b['folder'] ?? ''),
				'changed' => date('Y-m-d H:i', (int)$b['mtime'])];
			if (!empty($b['readOnly'])) {
				$row['read_only'] = true;
			}
			if (!empty($b['owner'])) {
				$row['shared_by'] = (string)$b['owner'];
			}
			if ((int)$b['id'] === $open) {
				$row['open_now'] = true;
			}
			$out[] = $row;
		}
		return ['books' => $out];
	}

	private static function parse(string $html): \DOMDocument {
		$doc = new \DOMDocument();
		$was = libxml_use_internal_errors(true);
		$doc->loadHTML('<?xml encoding="utf-8"?>' . $html, LIBXML_NONET | LIBXML_COMPACT | LIBXML_HTML_NODEFDTD);
		libxml_clear_errors();
		libxml_use_internal_errors($was);
		foreach ($doc->childNodes as $n) {
			if ($n->nodeType === XML_PI_NODE) {
				$doc->removeChild($n);
				break;
			}
		}
		// written back as UTF-8 text, not as character references
		$doc->encoding = 'UTF-8';
		return $doc;
	}

	/** @return list<\DOMElement> the sheets (section.cb-sheet) */
	private static function sheets(\DOMDocument $doc): array {
		$out = [];
		foreach ($doc->getElementsByTagName('section') as $s) {
			if (preg_match('/(^|\s)cb-sheet(\s|$)/', $s->getAttribute('class'))) {
				$out[] = $s;
			}
		}
		return $out;
	}

	private static function table(\DOMElement $sheet): ?\DOMElement {
		foreach ($sheet->getElementsByTagName('table') as $t) {
			return $t;
		}
		return null;
	}

	private static function tbody(\DOMElement $table): \DOMElement {
		foreach ($table->childNodes as $n) {
			if ($n instanceof \DOMElement && $n->tagName === 'tbody') {
				return $n;
			}
		}
		$tb = $table->ownerDocument->createElement('tbody');
		$table->appendChild($tb);
		return $tb;
	}

	/**
	 * The grid of a sheet's table: [r][c] => the <td> that holds that cell (a merged cell's
	 * anchor holds all of it, marked 'covered' for the others), and the <tr>s.
	 *
	 * @return array{0: array<int, array<int, array{td: \DOMElement, covered: bool}>>, 1: list<\DOMElement>, 2: int}
	 */
	private static function grid(\DOMElement $tbody): array {
		$grid = [];
		$rows = [];
		$width = 0;
		$r = 0;
		foreach ($tbody->childNodes as $tr) {
			if (!($tr instanceof \DOMElement) || $tr->tagName !== 'tr') {
				continue;
			}
			$rows[] = $tr;
			$c = 0;
			foreach ($tr->childNodes as $td) {
				if (!($td instanceof \DOMElement) || ($td->tagName !== 'td' && $td->tagName !== 'th')) {
					continue;
				}
				while (isset($grid[$r][$c])) {
					$c++;
				}
				$cs = max(1, (int)($td->getAttribute('colspan') ?: 1));
				$rs = max(1, (int)($td->getAttribute('rowspan') ?: 1));
				for ($i = 0; $i < $rs; $i++) {
					for ($j = 0; $j < $cs; $j++) {
						$grid[$r + $i][$c + $j] = ['td' => $td, 'covered' => $i > 0 || $j > 0];
					}
				}
				$c += $cs;
				$width = max($width, $c);
			}
			$r++;
		}
		return [$grid, $rows, $width];
	}

	private static function cellText(\DOMElement $td): string {
		$f = $td->getAttribute('data-f');
		$shown = trim((string)preg_replace('/\s+/u', ' ', $td->textContent));
		if ($f !== '') {
			return $f . ' → ' . $shown;
		}
		return $shown;
	}

	private function readBook(string $uid, int $id, string $sheet, string $range): array {
		$book = $this->books->get($uid, $id);
		$doc = self::parse((string)$book['content']);
		$box = $range !== '' ? Cells::parseRange(str_replace('$', '', $range)) : null;
		if ($range !== '' && $box === null) {
			throw new \InvalidArgumentException('range must be like A1:F50');
		}
		$out = [];
		$names = [];
		foreach (self::sheets($doc) as $s) {
			$name = $s->getAttribute('data-name');
			$names[] = $name;
			if ($sheet !== '' && $name !== $sheet) {
				continue;
			}
			$t = self::table($s);
			$lines = [];
			$rows = 0;
			$cols = 0;
			if ($t !== null) {
				[$grid, , $width] = self::grid(self::tbody($t));
				$rows = count($grid);
				$cols = $width;
				[$r0, $c0, $r1, $c1] = $box ?? [0, 0, $rows - 1, $width - 1];
				$r1 = min($r1, $rows - 1, $r0 + self::READ_ROWS - 1);
				$c1 = min($c1, $width - 1, $c0 + self::READ_COLS - 1);
				for ($r = $r0; $r <= $r1; $r++) {
					$line = [];
					for ($c = $c0; $c <= $c1; $c++) {
						$g = $grid[$r][$c] ?? null;
						$line[] = $g === null || $g['covered'] ? '' : str_replace("\t", ' ', self::cellText($g['td']));
					}
					$lines[] = rtrim(implode("\t", $line), "\t");
				}
				while ($lines !== [] && end($lines) === '') {
					array_pop($lines);
				}
			}
			$out[] = ['sheet' => $name, 'used' => $rows > 0 && $cols > 0 ? Cells::rangeName(0, 0, $rows - 1, $cols - 1) : '',
				'from' => $box !== null ? Cells::ref($box[0], $box[1]) : 'A1', 'rows' => implode("\n", $lines)];
		}
		if ($sheet !== '' && $out === []) {
			throw new \InvalidArgumentException('no sheet "' . $sheet . '"; the sheets are: ' . implode(', ', $names));
		}
		return ['book' => $book['title'], 'sheets' => $out];
	}

	// ---- writing ----

	/** Put what one would type into a cell, keeping its format, style and note. */
	private static function setCell(\DOMElement $td, string $input): void {
		foreach (['data-f', 'data-a', 'data-sp', 'data-t', 'data-v'] as $a) {
			$td->removeAttribute($a);
		}
		while ($td->firstChild) {
			$td->removeChild($td->firstChild);
		}
		$input = (string)preg_replace('/\r\n?/', "\n", $input);
		if ($input === '') {
			return;
		}
		if ($input[0] === '=' && strlen($input) > 1) {
			// worked out by the page when the book is opened
			$td->setAttribute('data-f', mb_substr($input, 0, Model::MAX_FORMULA));
			return;
		}
		$text = $input;
		if (preg_match('/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/', $input)) {
			$td->setAttribute('data-t', 'n');
			$td->setAttribute('data-v', Cells::number((float)$input));
			$text = Cells::number((float)$input);
		} elseif (preg_match('/^(TRUE|FALSE)$/i', $input)) {
			$td->setAttribute('data-t', 'b');
			$td->setAttribute('data-v', strtoupper($input));
			$text = strtoupper($input);
		} elseif (preg_match('#^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$#', $input, $m) && checkdate((int)$m[2], (int)$m[3], (int)$m[1])) {
			$serial = Cells::serialOfIso(sprintf('%04d-%02d-%02d', $m[1], $m[2], $m[3]));
			if ($serial !== null) {
				$td->setAttribute('data-t', 'n');
				$td->setAttribute('data-v', Cells::number($serial));
				if ($td->getAttribute('data-fmt') === '') {
					$td->setAttribute('data-fmt', 'yyyy/mm/dd');
				}
				$text = sprintf('%04d/%02d/%02d', $m[1], $m[2], $m[3]);
			}
		} else {
			if ($input[0] === "'") {
				$text = substr($input, 1);
			}
			$td->setAttribute('data-t', 's');
			if (str_contains($text, "\n")) {
				$td->setAttribute('data-v', $text);
			}
		}
		$td->appendChild($td->ownerDocument->createTextNode(str_replace("\n", ' ', $text)));
	}

	/** Make the table at least $rows × $cols, the way the page writes it (every cell a <td>). */
	private static function grow(\DOMElement $table, int $rows, int $cols): void {
		$doc = $table->ownerDocument;
		$tbody = self::tbody($table);
		[, $trs, $width] = self::grid($tbody);
		$cols = max($cols, $width);
		foreach ($trs as $i => $tr) {
			[$grid] = self::grid($tbody);
			$have = 0;
			foreach ($grid[$i] ?? [] as $c => $_) {
				$have = max($have, $c + 1);
			}
			for ($c = $have; $c < $cols; $c++) {
				$tr->appendChild($doc->createElement('td'));
			}
		}
		for ($r = count($trs); $r < $rows; $r++) {
			$tr = $doc->createElement('tr');
			for ($c = 0; $c < $cols; $c++) {
				$tr->appendChild($doc->createElement('td'));
			}
			$tbody->appendChild($tr);
		}
		$cg = null;
		foreach ($table->childNodes as $n) {
			if ($n instanceof \DOMElement && $n->tagName === 'colgroup') {
				$cg = $n;
			}
		}
		if ($cg === null) {
			$cg = $doc->createElement('colgroup');
			$table->insertBefore($cg, $tbody);
		}
		$n = 0;
		foreach ($cg->childNodes as $col) {
			if ($col instanceof \DOMElement && $col->tagName === 'col') {
				$n++;
			}
		}
		for (; $n < $cols; $n++) {
			$col = $doc->createElement('col');
			$col->setAttribute('style', 'width:' . self::DEF_COL_W . 'px');
			$cg->appendChild($col);
		}
	}

	/**
	 * @param list<mixed> $edits
	 * @return array{0: int, 1: list<string>} how many were written, and why the others were not
	 */
	private static function apply(\DOMDocument $doc, array $edits): array {
		if (count($edits) > self::MAX_WRITES) {
			throw new \InvalidArgumentException('At most ' . self::MAX_WRITES . ' cells at once.');
		}
		$sheets = self::sheets($doc);
		if ($sheets === []) {
			throw new \InvalidArgumentException('this file has no sheets: it is not a CalcBase book');
		}
		$byName = [];
		foreach ($sheets as $s) {
			$byName[$s->getAttribute('data-name')] = $s;
		}
		$done = 0;
		$skipped = [];
		// grow each sheet once, to the furthest cell written in it
		$want = [];
		$todo = [];
		foreach ($edits as $e) {
			if (!is_array($e) || !is_string($e['cell'] ?? null) || ($rc = Cells::parseRef($e['cell'])) === null) {
				$skipped[] = json_encode($e, JSON_UNESCAPED_UNICODE) . ': not a cell address';
				continue;
			}
			$name = is_string($e['sheet'] ?? null) && $e['sheet'] !== '' ? $e['sheet'] : $sheets[0]->getAttribute('data-name');
			if (!isset($byName[$name])) {
				$skipped[] = $name . '!' . $e['cell'] . ': no such sheet';
				continue;
			}
			$input = $e['input'] ?? '';
			$input = is_bool($input) ? ($input ? 'TRUE' : 'FALSE') : (is_int($input) || is_float($input) ? Cells::number($input) : (is_string($input) ? $input : null));
			if ($input === null) {
				$skipped[] = $name . '!' . $e['cell'] . ': input must be text';
				continue;
			}
			$want[$name] = [max($want[$name][0] ?? 0, $rc[0] + 1), max($want[$name][1] ?? 0, $rc[1] + 1)];
			$todo[] = [$name, $rc, $input, strtoupper($e['cell'])];
		}
		foreach ($want as $name => [$rows, $cols]) {
			$t = self::table($byName[$name]);
			if ($t === null) {
				$t = $doc->createElement('table');
				$t->appendChild($doc->createElement('colgroup'));
				$t->appendChild($doc->createElement('tbody'));
				$byName[$name]->appendChild($t);
			}
			self::grow($t, $rows, $cols);
		}
		$grids = [];
		foreach ($todo as [$name, $rc, $input, $ref]) {
			$grids[$name] ??= self::grid(self::tbody(self::table($byName[$name])))[0];
			$g = $grids[$name][$rc[0]][$rc[1]] ?? null;
			if ($g === null || $g['covered']) {
				$skipped[] = $name . '!' . $ref . ': inside a merged cell';
				continue;
			}
			self::setCell($g['td'], $input);
			$done++;
		}
		return [$done, $skipped];
	}

	private static function html(\DOMDocument $doc): string {
		$out = (string)$doc->saveHTML();
		// libxml writes every character past ASCII as a reference (&#22770;): written back as
		// the UTF-8 text it is, as the page writes it (only those, so < & " stay escaped)
		$out = (string)preg_replace_callback('/&#(\d+);|&#x([0-9a-fA-F]+);/', static function (array $m): string {
			$cp = $m[1] !== '' ? (int)$m[1] : (int)hexdec($m[2]);
			return $cp > 127 && $cp <= 0x10FFFF && ($cp < 0xD800 || $cp > 0xDFFF) ? mb_chr($cp, 'UTF-8') : $m[0];
		}, $out);
		return "<!DOCTYPE html>\n" . preg_replace('/^<!DOCTYPE[^>]*>\s*/i', '', $out);
	}

	private function writeCells(string $uid, int $id, array $edits): array {
		$this->notOpen($uid, $id);
		$book = $this->books->get($uid, $id);
		if (!empty($book['readOnly'])) {
			throw new \OCP\Files\NotPermittedException('read only');
		}
		$doc = self::parse((string)$book['content']);
		[$done, $skipped] = self::apply($doc, $edits);
		if ($done > 0) {
			// manual = true: a version of what was there is kept first, whatever the writer's setting
			$res = $this->books->save($uid, $id, self::html($doc), (string)$book['etag'], true);
			if (!empty($res['stale'])) {
				throw new \RuntimeException('Somebody saved this book just now; read it again and try once more.');
			}
		}
		return ['written' => $done, 'not_written' => $skipped, 'note' => 'Formulas are worked out when the book is opened.',
			'_report' => $this->l($uid)->t('Wrote %1$s cells in “%2$s” (a version of it was kept first)', [$done, (string)$book['title']])
				. ($skipped !== [] ? ' ' . $this->l($uid)->t('%s not written', [count($skipped)]) : '')];
	}

	private function createBook(string $uid, array $a): array {
		$sheets = array_values(array_filter((array)($a['sheets'] ?? []), 'is_array'));
		if ($sheets === []) {
			$sheets = [['name' => 'Sheet1', 'rows' => []]];
		}
		$names = [];
		foreach ($sheets as $i => $s) {
			// a sheet name as Calc allows one: none of []*?:/\ and no ' at either end
			$n = mb_substr(trim((string)preg_replace('#[\[\]*?:/\\\\]#u', '', (string)($s['name'] ?? $s['sheet'] ?? $s['title'] ?? '')), " '"), 0, 64);
			$n = $n === '' ? 'Sheet' . ($i + 1) : $n;
			while (in_array($n, $names, true)) {
				$n .= '_';
			}
			$names[] = $n;
		}
		$title = trim((string)$a['name']) !== '' ? trim((string)$a['name']) : 'Book';
		$doc = self::parse(BookService::blankBook($title, $names[0]));
		$first = self::sheets($doc)[0];
		for ($i = 1; $i < count($names); $i++) {
			$copy = $first->cloneNode(true);
			$copy->setAttribute('data-name', $names[$i]);
			foreach ($copy->getElementsByTagName('h2') as $h) {
				$h->textContent = $names[$i];
			}
			$first->parentNode->appendChild($doc->createTextNode("\n"));
			$first->parentNode->appendChild($copy);
		}
		$edits = [];
		foreach ($sheets as $i => $s) {
			foreach (array_values((array)($s['rows'] ?? $s['cells'] ?? $s['data'] ?? [])) as $r => $row) {
				foreach (array_values(is_array($row) ? $row : [$row]) as $c => $v) {
					if ($v === null || $v === '') {
						continue;
					}
					$edits[] = ['sheet' => $names[$i], 'cell' => Cells::ref($r, $c), 'input' => $v];
				}
			}
		}
		[$done, $skipped] = self::apply($doc, $edits);
		$made = $this->books->create($uid, $title, self::html($doc), trim((string)($a['category'] ?? '')));
		return ['created' => (int)$made['id'], 'name' => $made['title'], 'category' => $made['folder'] ?? '', 'cells' => $done, 'not_written' => $skipped,
			'_report' => $this->l($uid)->t('Made the book “%1$s” (%2$s sheets, %3$s cells)', [(string)$made['title'], count($names), $done])];
	}

	private function renameBook(string $uid, int $id, string $name): array {
		$this->notOpen($uid, $id);
		$was = (string)$this->books->get($uid, $id)['title'];
		$b = $this->books->rename($uid, $id, $name);
		return ['renamed' => $id, 'name' => $b['title'], '_report' => $this->l($uid)->t('Renamed “%1$s” to “%2$s”', [$was, (string)$b['title']])];
	}

	private function deleteBook(string $uid, int $id): array {
		$this->notOpen($uid, $id);
		$title = $this->books->get($uid, $id)['title'];
		$this->books->delete($uid, $id);
		return ['deleted' => $id, 'name' => $title, 'note' => 'In the Files trash bin, with its versions.',
			'_report' => $this->l($uid)->t('Put “%s” in the trash bin', [(string)$title])];
	}

	private function restoreVersion(string $uid, int $id, int $number): array {
		$this->notOpen($uid, $id);
		$this->books->restoreVersion($uid, $id, $number);
		return ['restored' => $id, 'version' => $number,
			'_report' => $this->l($uid)->t('Put version %1$s of “%2$s” back', [$number, (string)$this->books->get($uid, $id)['title']])];
	}
}
