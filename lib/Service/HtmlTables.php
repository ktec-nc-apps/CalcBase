<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * The <table>s of an HTML page as sheets of the workbook model (design contract
 * §3), read with PHP's DOM: an EditBase document's tables, a web page's.
 *
 * EditBase's calculating tables keep each formula on the cell (data-eb-formula,
 * the same Calc syntax CalcBase writes; data-eb-value the raw result, data-eb-numfmt
 * the number format) and show the answer as the cell's text. Both are kept: the
 * formula as the cell's f, the shown text read for its value. A CalcBase book's
 * own cells (data-f, data-v, data-t, data-fmt) read the same way, so a book saved
 * as a web page comes back as it was. Any other table is text, each cell read for
 * what it means (TextValues): a number is a number, a date a date.
 *
 * Header cells (<th>) are bold; colspan and rowspan become merges; a cell's
 * text-align (EditBase's eb-al-r/-c classes or an inline style) its alignment;
 * a link in a cell its link. Nothing from the page is ever inserted as HTML:
 * only text and attributes are read.
 */
final class HtmlTables {
	/** Elements whose text is not the cell's text. */
	private const SKIP = ['script', 'style', 'template', 'noscript', 'svg', 'math'];
	private const BLOCK = ['p', 'div', 'li', 'table', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'ul', 'ol', 'blockquote', 'pre'];

	/**
	 * Every table of the page, in order, as sheets. A table inside a table's cell
	 * is a table of its own as well (web pages still lay pages out in tables).
	 *
	 * @return list<array{name: string, cells: array<string, array<string, mixed>>, cols: array<string, int>, merges: list<string>}>
	 */
	public static function fromHtml(string $html, int $limit = Connectors::TABLE_LIMIT): array {
		$doc = self::parse($html);
		if ($doc === null) {
			return [];
		}
		$out = [];
		$n = 0;
		$cells = 0;
		foreach ($doc->getElementsByTagName('table') as $table) {
			if (++$n > $limit) {
				break;
			}
			$sheet = self::sheet($table, $n);
			if ($sheet === null) {
				$n--;
				continue;
			}
			$cells += count($sheet['cells']);
			if ($cells > Model::MAX_CELLS) {
				throw new \InvalidArgumentException('the tables have more than ' . Model::MAX_CELLS . ' cells together');
			}
			$out[] = $sheet;
		}
		return $out;
	}

	/** The page's <title>, for naming what was brought in. */
	public static function title(string $html): string {
		$doc = self::parse($html);
		if ($doc === null) {
			return '';
		}
		$titles = $doc->getElementsByTagName('title');
		return $titles->length > 0 ? trim(preg_replace('/\s+/u', ' ', $titles->item(0)->textContent) ?? '') : '';
	}

	private static function parse(string $html): ?\DOMDocument {
		if (trim($html) === '') {
			return null;
		}
		$doc = new \DOMDocument();
		$was = libxml_use_internal_errors(true);
		try {
			// Every character above ASCII as an entity: libxml otherwise guesses the
			// encoding from the page's own <meta>, and a page read as UTF-8 and
			// relabelled would come out as mojibake.
			$ascii = mb_encode_numericentity($html, [0x80, 0x10FFFF, 0, 0x1FFFFF], 'UTF-8');
			if (!$doc->loadHTML($ascii, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING | LIBXML_HTML_NODEFDTD | LIBXML_COMPACT)) {
				return null;
			}
		} catch (\Throwable) {
			return null;
		} finally {
			libxml_clear_errors();
			libxml_use_internal_errors($was);
		}
		return $doc;
	}

	/** @return array{name: string, cells: array, cols: array, merges: list<string>}|null */
	private static function sheet(\DOMElement $table, int $n): ?array {
		$cells = [];
		$merges = [];
		$taken = [];   // "r,c" => true for cells a merge covers
		$r = 0;
		$maxCols = 0;
		$widths = [];
		foreach (self::rows($table) as $tr) {
			$c = 0;
			$any = false;
			foreach (self::children($tr, ['td', 'th']) as $td) {
				while (isset($taken["$r,$c"])) {
					$c++;
				}
				if ($c >= Cells::MAX_COLS || $r >= Cells::MAX_ROWS) {
					break;
				}
				$any = true;
				$colspan = max(1, min(1000, (int)$td->getAttribute('colspan')));
				$rowspan = max(1, min(10000, (int)$td->getAttribute('rowspan')));
				$cell = self::cell($td);
				if ($cell !== null) {
					$cells[Cells::ref($r, $c)] = $cell;
					$widths[$c] = max($widths[$c] ?? 0, self::width(is_string($cell['v'] ?? null) ? $cell['v'] : ($cell['d'] ?? '')));
				}
				if ($colspan > 1 || $rowspan > 1) {
					$merges[] = Cells::rangeName($r, $c, $r + $rowspan - 1, $c + $colspan - 1);
					for ($i = 0; $i < $rowspan; $i++) {
						for ($j = 0; $j < $colspan; $j++) {
							if ($i > 0 || $j > 0) {
								$taken[($r + $i) . ',' . ($c + $j)] = true;
							}
						}
					}
				}
				$c += $colspan;
			}
			$maxCols = max($maxCols, $c);
			if ($any || $r > 0) {
				$r++;
			}
		}
		if ($cells === []) {
			return null;
		}
		$cols = [];
		foreach (self::children($table, ['colgroup']) as $group) {
			$i = 0;
			foreach (self::children($group, ['col']) as $col) {
				$span = max(1, min(1000, (int)$col->getAttribute('span')));
				if (preg_match('/width\s*:\s*([\d.]+)(px|pt|mm|cm|em)?/i', $col->getAttribute('style'), $m)) {
					$px = Cells::pxOfLength($m[1] . ($m[2] ?? 'px'));
					if ($px === null && strtolower($m[2] ?? '') === 'em') {
						$px = (float)$m[1] * 16;
					}
					if ($px !== null) {
						for ($k = 0; $k < $span; $k++) {
							$cols[Cells::colName($i + $k)] = (int)round(max(8, min(4000, $px)));
						}
					}
				}
				$i += $span;
			}
		}
		if ($cols === []) {
			// No widths given: as wide as the longest text in each column asks, within reason.
			foreach ($widths as $c => $w) {
				if ($w > 8) {
					$cols[Cells::colName($c)] = (int)min(400, max(64, $w * 7 + 14));
				}
			}
		}
		return ['name' => self::nameOf($table, $n), 'cells' => $cells, 'cols' => $cols, 'merges' => $merges];
	}

	/** The rows of a table in the order the page has them: thead, then tbody and loose rows, then tfoot. */
	private static function rows(\DOMElement $table): array {
		$head = [];
		$body = [];
		$foot = [];
		foreach ($table->childNodes as $child) {
			if (!($child instanceof \DOMElement)) {
				continue;
			}
			$tag = strtolower($child->tagName);
			if ($tag === 'tr') {
				$body[] = $child;
			} elseif ($tag === 'thead' || $tag === 'tbody' || $tag === 'tfoot') {
				foreach (self::children($child, ['tr']) as $tr) {
					if ($tag === 'thead') {
						$head[] = $tr;
					} elseif ($tag === 'tfoot') {
						$foot[] = $tr;
					} else {
						$body[] = $tr;
					}
				}
			}
		}
		return array_merge($head, $body, $foot);
	}

	/** @return list<\DOMElement> */
	private static function children(\DOMElement $el, array $tags): array {
		$out = [];
		foreach ($el->childNodes as $child) {
			if ($child instanceof \DOMElement && in_array(strtolower($child->tagName), $tags, true)) {
				$out[] = $child;
			}
		}
		return $out;
	}

	/** @return array<string, mixed>|null the cell of the model, null for an empty cell */
	private static function cell(\DOMElement $td): ?array {
		$link = '';
		$text = self::textOf($td, $link);
		$formula = trim($td->getAttribute('data-eb-formula') ?: $td->getAttribute('data-f'));
		$raw = $td->hasAttribute('data-eb-value') ? $td->getAttribute('data-eb-value') : ($td->hasAttribute('data-v') ? $td->getAttribute('data-v') : null);
		$type = $td->getAttribute('data-t');
		$fmt = trim($td->getAttribute('data-eb-numfmt') ?: $td->getAttribute('data-fmt'));
		if ($type === 's') {
			$cell = TextValues::text($raw ?? $text);
		} elseif ($raw !== null && $raw !== '') {
			// The raw value as the file wrote it: a number, TRUE/FALSE, or an error;
			// the shown text is read when the raw value is not one of those.
			$read = TextValues::cell($raw);
			$cell = $read['t'] === 's' ? TextValues::cell($text) : ['v' => $read['v'], 't' => $read['t']];
		} else {
			$cell = TextValues::cell($text);
		}
		if ($type === 'e' && $text !== '') {
			$cell = ['v' => $text, 't' => 'e'];
		}
		if ($formula !== '') {
			$cell['f'] = mb_substr(str_starts_with($formula, '=') ? $formula : '=' . $formula, 0, Model::MAX_FORMULA);
		}
		if ($fmt !== '' && $fmt !== 'General') {
			$cell['fmt'] = $fmt;
		}
		if ($text !== '' && $text !== CsvFormat::shown($cell)) {
			// What the page showed, when it is not what the value prints as: a formatted number, a date.
			$cell['d'] = mb_substr($text, 0, Model::MAX_TEXT);
		}
		$style = self::styleOf($td);
		if ($style !== []) {
			$cell['s'] = $style;
		}
		if ($link !== '' && preg_match('#^(https?://|mailto:)#i', $link)) {
			$cell['link'] = mb_substr($link, 0, 2048);
		}
		if (($cell['v'] ?? '') === '' && !isset($cell['f']) && $style === [] && $link === '') {
			return null;
		}
		return $cell;
	}

	/** The cell's text as a person reads it: lines kept, spaces folded. */
	private static function textOf(\DOMElement $td, string &$link): string {
		$parts = [];
		$walk = static function (\DOMNode $node) use (&$walk, &$parts, &$link): void {
			foreach ($node->childNodes as $child) {
				if ($child instanceof \DOMText) {
					$parts[] = $child->data;
				} elseif ($child instanceof \DOMElement) {
					$tag = strtolower($child->tagName);
					if (in_array($tag, self::SKIP, true)) {
						continue;
					}
					if ($tag === 'br') {
						$parts[] = "\n";
						continue;
					}
					if ($tag === 'a' && $link === '' && $child->hasAttribute('href')) {
						$link = trim($child->getAttribute('href'));
					}
					if ($tag === 'img' && $child->hasAttribute('alt')) {
						$parts[] = $child->getAttribute('alt');
					}
					$block = in_array($tag, self::BLOCK, true);
					if ($block) {
						$parts[] = "\n";
					}
					$walk($child);
					if ($block) {
						$parts[] = "\n";
					}
				}
			}
		};
		$walk($td);
		$text = implode('', $parts);
		$text = preg_replace('/[ \t\x{00A0}]+/u', ' ', $text) ?? $text;
		$text = preg_replace('/ *\n */', "\n", $text) ?? $text;
		$text = preg_replace('/\n{2,}/', "\n", $text) ?? $text;
		return trim($text);
	}

	/** @return array<string, mixed> the cell's style, as the model's s */
	private static function styleOf(\DOMElement $td): array {
		$s = [];
		if (strtolower($td->tagName) === 'th') {
			$s['b'] = 1;
		}
		$classes = ' ' . $td->getAttribute('class') . ' ';
		foreach (['eb-al-r' => 'right', 'eb-al-c' => 'center', 'eb-al-l' => 'left'] as $class => $align) {
			if (str_contains($classes, ' ' . $class . ' ')) {
				$s['ha'] = $align;
			}
		}
		if (in_array(strtolower($td->getAttribute('align')), ['left', 'center', 'right'], true)) {
			$s['ha'] = strtolower($td->getAttribute('align'));
		}
		foreach (self::declarations($td->getAttribute('style')) as $prop => $value) {
			switch ($prop) {
				case 'font-weight':
					if ($value === 'bold' || (is_numeric($value) && (int)$value >= 600)) {
						$s['b'] = 1;
					}
					break;
				case 'font-style':
					if ($value === 'italic') {
						$s['i'] = 1;
					}
					break;
				case 'text-decoration':
				case 'text-decoration-line':
					if (str_contains($value, 'underline')) {
						$s['u'] = 1;
					}
					if (str_contains($value, 'line-through')) {
						$s['strike'] = 1;
					}
					break;
				case 'text-align':
					if (in_array($value, ['left', 'center', 'right'], true)) {
						$s['ha'] = $value;
					}
					break;
				case 'vertical-align':
					if (in_array($value, ['top', 'middle', 'bottom'], true)) {
						$s['va'] = $value;
					}
					break;
				case 'color':
					$s['color'] = $value;
					break;
				case 'background-color':
				case 'background':
					$s['bg'] = $value;
					break;
				case 'white-space':
					if ($value === 'normal' || $value === 'pre-wrap') {
						$s['wrap'] = 1;
					}
					break;
				case 'font-family':
					$s['font'] = trim(explode(',', $value)[0], " \"'");
					break;
				case 'font-size':
					if (preg_match('/^([\d.]+)(pt|px)$/', $value, $m)) {
						$s['size'] = $m[2] === 'px' ? round((float)$m[1] * 0.75, 2) : (float)$m[1];
					}
					break;
				case 'border-top': case 'border-right': case 'border-bottom': case 'border-left':
					$s['b' . $prop[7]] = self::borderOf($value);
					break;
				case 'border':
					foreach (['bt', 'br', 'bb', 'bl'] as $k) {
						$s[$k] = self::borderOf($value);
					}
					break;
			}
		}
		// A cell that is one bold or italic run is a bold or italic cell.
		$only = self::onlyChild($td);
		if ($only !== null) {
			$tag = strtolower($only->tagName);
			if ($tag === 'b' || $tag === 'strong') {
				$s['b'] = 1;
			} elseif ($tag === 'i' || $tag === 'em') {
				$s['i'] = 1;
			}
		}
		return Model::style($s);
	}

	/** A CSS border, in the order the model writes it. */
	private static function borderOf(string $value): string {
		if (preg_match('/(\d+(?:\.\d+)?)px/', $value, $w) && preg_match('/\b(solid|dashed|dotted|double)\b/', $value, $st) && preg_match('/(#[0-9a-fA-F]{3,6}|rgba?\([^)]*\))/', $value, $c)) {
			return $w[1] . 'px ' . $st[1] . ' ' . $c[1];
		}
		return '';
	}

	/** @return array<string, string> lower-case property => trimmed value */
	private static function declarations(string $style): array {
		$out = [];
		foreach (explode(';', $style) as $decl) {
			$pair = explode(':', $decl, 2);
			if (count($pair) === 2) {
				$out[strtolower(trim($pair[0]))] = strtolower(trim($pair[1]));
			}
		}
		return $out;
	}

	private static function onlyChild(\DOMElement $el): ?\DOMElement {
		$found = null;
		foreach ($el->childNodes as $child) {
			if ($child instanceof \DOMText) {
				if (trim($child->data) !== '') {
					return null;
				}
				continue;
			}
			if ($child instanceof \DOMElement) {
				if ($found !== null) {
					return null;
				}
				$found = $child;
			}
		}
		return $found;
	}

	/** The table's caption, its EditBase name, the heading just above it, or "Table n". */
	private static function nameOf(\DOMElement $table, int $n): string {
		$clean = static fn (string $s): string => mb_substr(trim(preg_replace('/\s+/u', ' ', $s) ?? ''), 0, 64);
		foreach (self::children($table, ['caption']) as $caption) {
			$name = $clean($caption->textContent);
			if ($name !== '') {
				return $name;
			}
		}
		foreach (['data-eb-name', 'data-name', 'aria-label', 'summary'] as $attr) {
			if ($table->hasAttribute($attr) && $clean($table->getAttribute($attr)) !== '') {
				return $clean($table->getAttribute($attr));
			}
		}
		// The nearest heading before the table, within a few elements.
		for ($node = $table->previousSibling, $steps = 0; $node !== null && $steps < 6; $node = $node->previousSibling) {
			if (!($node instanceof \DOMElement)) {
				continue;
			}
			$steps++;
			$tag = strtolower($node->tagName);
			if (preg_match('/^h[1-6]$/', $tag) || $tag === 'p') {
				$name = $clean($node->textContent);
				if ($name !== '' && mb_strlen($name) <= 40) {
					return $name;
				}
				if (preg_match('/^h[1-6]$/', $tag)) {
					break;
				}
			}
			if (strtolower($tag) === 'table') {
				break;
			}
		}
		return 'Table ' . $n;
	}

	/** How many columns of text a cell asks for (a CJK character counts for two). */
	private static function width(string $text): int {
		$longest = 0;
		foreach (explode("\n", $text) as $line) {
			$w = 0;
			foreach (preg_split('//u', $line, -1, PREG_SPLIT_NO_EMPTY) ?: [] as $ch) {
				$w += mb_strwidth($ch) >= 2 ? 2 : 1;
			}
			$longest = max($longest, $w);
		}
		return $longest;
	}
}
