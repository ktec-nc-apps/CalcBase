<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * Number format codes -- "#,##0.00", "0.0%", "yyyy/mm/dd", "¥#,##0" -- as the
 * model keeps them (design contract §3: the codes Calc and Excel share), read
 * from and written to the ways the two file formats keep them: ODS as a tree of
 * number:* elements, XLSX as the code itself (with a table of built-in ids).
 *
 * Only the common shapes are read: numbers with decimals and grouping,
 * percentages, currency with its symbol, dates and times from their parts,
 * text, a [Red] negative section. Anything else comes back as General, which
 * is what the contract says an absent format means.
 */
final class NumberFormats {
	private const NS_NUMBER = 'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0';
	private const NS_STYLE = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
	private const NS_FO = 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0';

	/** The format codes Excel keeps under a number, which an XLSX file names by id alone. */
	public const XLSX_BUILTIN = [
		0 => 'General', 1 => '0', 2 => '0.00', 3 => '#,##0', 4 => '#,##0.00',
		9 => '0%', 10 => '0.00%', 11 => '0.00E+00', 12 => '# ?/?', 13 => '# ??/??',
		14 => 'yyyy/mm/dd', 15 => 'd-mmm-yy', 16 => 'd-mmm', 17 => 'mmm-yy',
		18 => 'h:mm AM/PM', 19 => 'h:mm:ss AM/PM', 20 => 'h:mm', 21 => 'h:mm:ss', 22 => 'yyyy/mm/dd h:mm',
		37 => '#,##0;-#,##0', 38 => '#,##0;[Red]-#,##0', 39 => '#,##0.00;-#,##0.00', 40 => '#,##0.00;[Red]-#,##0.00',
		45 => 'mm:ss', 46 => '[h]:mm:ss', 47 => 'mm:ss.0', 48 => '##0.0E+0', 49 => '@',
	];

	// ---- ODS: number styles into codes ----

	/**
	 * Every number style in a document (content.xml's automatic styles or
	 * styles.xml's common styles): style name => format code.
	 *
	 * @return array<string, string>
	 */
	public static function fromOdsDocument(\DOMDocument $doc): array {
		$out = [];
		$kinds = ['number-style', 'percentage-style', 'currency-style', 'date-style', 'time-style', 'boolean-style', 'text-style'];
		$byName = [];
		foreach ($kinds as $kind) {
			foreach ($doc->getElementsByTagNameNS(self::NS_NUMBER, $kind) as $el) {
				$name = $el->getAttributeNS(self::NS_STYLE, 'name');
				if ($name !== '') {
					$byName[$name] = $el;
				}
			}
		}
		foreach ($byName as $name => $el) {
			$code = self::odsStyleCode($el);
			// A style with a map ("value()>=0" → another style) is the branch for the
			// rest: the mapped style is the positive section, this one the negative.
			foreach ($el->getElementsByTagNameNS(self::NS_STYLE, 'map') as $map) {
				$cond = $map->getAttributeNS(self::NS_STYLE, 'condition');
				$to = $map->getAttributeNS(self::NS_STYLE, 'apply-style-name');
				if (preg_match('/value\(\)\s*>=?\s*0/', $cond) && isset($byName[$to])) {
					$pos = self::odsStyleCode($byName[$to]);
					if ($pos !== '' && $code !== '') {
						$code = $pos . ';' . $code;
					}
					break;
				}
			}
			$out[$name] = $code === '' ? 'General' : $code;
		}
		return $out;
	}

	private static function odsStyleCode(\DOMElement $style): string {
		$kind = $style->localName;
		if ($kind === 'boolean-style') {
			return 'General';
		}
		if ($kind === 'text-style') {
			return '@';
		}
		$out = '';
		$colour = '';
		foreach ($style->childNodes as $node) {
			if (!($node instanceof \DOMElement)) {
				continue;
			}
			$ln = $node->localName;
			$long = $node->getAttributeNS(self::NS_NUMBER, 'style') === 'long';
			switch ($ln) {
				case 'text':
					$out .= self::literal($node->textContent);
					break;
				case 'number':
					$out .= self::numberPart($node);
					break;
				case 'scientific-number':
					$dec = (int)$node->getAttributeNS(self::NS_NUMBER, 'decimal-places');
					$exp = max(1, (int)($node->getAttributeNS(self::NS_NUMBER, 'min-exponent-digits') ?: 2));
					$out .= '0' . ($dec > 0 ? '.' . str_repeat('0', $dec) : '') . 'E+' . str_repeat('0', $exp);
					break;
				case 'fraction':
					return 'General';
				case 'currency-symbol':
					$out .= self::literal($node->textContent);
					break;
				case 'year':
					$out .= $node->getAttributeNS(self::NS_NUMBER, 'calendar') === 'gengou' ? ($long ? 'ee' : 'e') : ($long ? 'yyyy' : 'yy');
					break;
				case 'era':
					$out .= $long ? 'ggg' : 'g';
					break;
				case 'month':
					$textual = $node->getAttributeNS(self::NS_NUMBER, 'textual') === 'true';
					$out .= $textual ? ($long ? 'mmmm' : 'mmm') : ($long ? 'mm' : 'm');
					break;
				case 'day':
					$out .= $long ? 'dd' : 'd';
					break;
				case 'day-of-week':
					$out .= $long ? 'dddd' : 'ddd';
					break;
				case 'hours':
					$out .= ($style->getAttributeNS(self::NS_NUMBER, 'truncate-on-overflow') === 'false' ? '[h]' : ($long ? 'hh' : 'h'));
					break;
				case 'minutes':
					$out .= $long ? 'mm' : 'm';
					break;
				case 'seconds':
					$dec = (int)$node->getAttributeNS(self::NS_NUMBER, 'decimal-places');
					$out .= ($long ? 'ss' : 's') . ($dec > 0 ? '.' . str_repeat('0', $dec) : '');
					break;
				case 'am-pm':
					$out .= 'AM/PM';
					break;
				case 'text-properties':
					$c = strtolower($node->getAttributeNS(self::NS_FO, 'color'));
					if ($c === '#ff0000') {
						$colour = '[Red]';
					}
					break;
				default:
					// quarter, week-of-year, embedded-text, map, fill-character: not kept
			}
		}
		return $out === '' ? '' : $colour . $out;
	}

	private static function numberPart(\DOMElement $n): string {
		$dec = (int)$n->getAttributeNS(self::NS_NUMBER, 'decimal-places');
		$minDec = $n->hasAttributeNS(self::NS_NUMBER, 'min-decimal-places') ? (int)$n->getAttributeNS(self::NS_NUMBER, 'min-decimal-places') : $dec;
		$int = max(0, (int)$n->getAttributeNS(self::NS_NUMBER, 'min-integer-digits'));
		$grouping = $n->getAttributeNS(self::NS_NUMBER, 'grouping') === 'true';
		$ipart = $grouping ? '#,##' . str_repeat('0', max(1, $int)) : ($int > 0 ? str_repeat('0', $int) : '#');
		if ($grouping && $int === 0) {
			$ipart = '#,###';
		}
		$fpart = $dec > 0 ? '.' . str_repeat('0', $minDec) . str_repeat('#', $dec - $minDec) : '';
		return $ipart . $fpart;
	}

	/** A literal inside a code: letters that could be read as a format are quoted. */
	private static function literal(string $text): string {
		if ($text === '') {
			return '';
		}
		if (preg_match('/^[\s\/\-:.,%¥$€£()\x{FF04}\x{FFE5}\x{20AC}\x{00A3}\x{3000}-\x{30FF}\x{4E00}-\x{9FFF}]+$/u', $text)) {
			return $text;
		}
		return '"' . str_replace('"', '', $text) . '"';
	}

	// ---- ODS: codes into number styles ----

	/**
	 * A number style for a code, as XML with the given style name; null for a
	 * code this writer does not know (the cell is then written as General).
	 */
	public static function toOdsStyle(string $code, string $name): ?string {
		$sections = self::sections($code);
		$pos = $sections[0];
		$neg = $sections[1] ?? null;
		$red = $neg !== null && str_contains($neg, '[Red]');
		$neg = $neg === null ? null : str_replace('[Red]', '', $neg);
		if ($pos === '@') {
			return '<number:text-style style:name="' . $name . '"><number:text-content/></number:text-style>';
		}
		if ($pos === 'General' || $pos === '') {
			return null;
		}
		$esc = static fn (string $s): string => htmlspecialchars($s, ENT_XML1 | ENT_QUOTES, 'UTF-8');
		// A date or time: any of the date letters outside quotes.
		if (preg_match('/(?<!\[)(?:y|d|h|s|AM\/PM|g|e|m(?!\/))/i', preg_replace('/"[^"]*"/', '', $pos) ?? '')
			&& !preg_match('/[0#]/', preg_replace('/"[^"]*"/', '', $pos) ?? '')) {
			return self::odsDateStyle($pos, $name, $esc);
		}
		$body = self::odsNumberBody($pos, $esc);
		if ($body === null) {
			return null;
		}
		$kind = str_contains($pos, '%') ? 'percentage-style' : (preg_match('/[¥$€£\x{FFE5}]/u', $pos) ? 'currency-style' : 'number-style');
		if ($neg === null) {
			return '<number:' . $kind . ' style:name="' . $name . '">' . $body . '</number:' . $kind . '>';
		}
		$negBody = self::odsNumberBody($neg, $esc);
		if ($negBody === null) {
			return '<number:' . $kind . ' style:name="' . $name . '">' . $body . '</number:' . $kind . '>';
		}
		// Two styles: the positive one (named P0) that the negative one maps to.
		return '<number:' . $kind . ' style:name="' . $name . 'P0">' . $body . '</number:' . $kind . '>'
			. '<number:' . $kind . ' style:name="' . $name . '">'
			. ($red ? '<style:text-properties fo:color="#ff0000"/>' : '')
			. $negBody
			. '<style:map style:condition="value()&gt;=0" style:apply-style-name="' . $name . 'P0"/></number:' . $kind . '>';
	}

	/** @return list<string> the ; sections of a code, quotes respected */
	private static function sections(string $code): array {
		$out = [];
		$cur = '';
		$q = false;
		for ($i = 0, $n = strlen($code); $i < $n; $i++) {
			$ch = $code[$i];
			if ($ch === '"') {
				$q = !$q;
			}
			if ($ch === ';' && !$q) {
				$out[] = $cur;
				$cur = '';
				continue;
			}
			$cur .= $ch;
		}
		$out[] = $cur;
		return $out;
	}

	/** The number:* elements of a numeric code (text before, number, text after); null when unreadable. */
	private static function odsNumberBody(string $code, callable $esc): ?string {
		if (!preg_match('/^(.*?)(#,##0(?:\.0*#*)?|#,###(?:\.0*#*)?|0+(?:\.0*#*)?|#(?:\.0*#*)?|0(?:\.0+)?E\+0+)(.*)$/su', $code, $m)) {
			return null;
		}
		[, $before, $num, $after] = $m;
		$out = '';
		$unquote = static fn (string $s): string => str_replace('"', '', $s);
		$sym = static function (string $s) use ($esc): string {
			return preg_match('/^[¥$€£\x{FFE5}]+$/u', $s) ? '<number:currency-symbol>' . $esc($s) . '</number:currency-symbol>' : ($s === '' ? '' : '<number:text>' . $esc($s) . '</number:text>');
		};
		$before = $unquote($before);
		$after = $unquote($after);
		$percent = str_contains($after, '%');
		if ($before !== '') {
			$out .= $sym(ltrim($before, '-'));
		}
		if (str_contains($num, 'E')) {
			$dec = strlen(explode('.', explode('E', $num)[0])[1] ?? '');
			$exp = strlen(explode('+', $num)[1] ?? '00');
			$out .= '<number:scientific-number number:decimal-places="' . $dec . '" number:min-integer-digits="1" number:min-exponent-digits="' . $exp . '"/>';
		} else {
			$parts = explode('.', $num, 2);
			$grouping = str_contains($parts[0], ',');
			$int = substr_count($parts[0], '0');
			$dec = isset($parts[1]) ? strlen($parts[1]) : 0;
			$minDec = isset($parts[1]) ? substr_count($parts[1], '0') : 0;
			$out .= '<number:number number:decimal-places="' . $dec . '" number:min-decimal-places="' . $minDec . '" number:min-integer-digits="' . $int . '"' . ($grouping ? ' number:grouping="true"' : '') . '/>';
		}
		if ($after !== '') {
			$out .= $percent ? '<number:text>' . $esc($after) . '</number:text>' : $sym($after);
		}
		return $out;
	}

	private static function odsDateStyle(string $code, string $name, callable $esc): ?string {
		$isTime = (bool)preg_match('/^[\[\]hms:.0\s"AMP\/]+$/i', $code) && !preg_match('/[yd]/i', $code);
		$out = '';
		$i = 0;
		$n = strlen($code);
		$text = '';
		$flush = static function () use (&$text, &$out, $esc): void {
			if ($text !== '') {
				$out .= '<number:text>' . $esc($text) . '</number:text>';
				$text = '';
			}
		};
		$truncate = true;
		$afterHour = false;
		while ($i < $n) {
			$ch = $code[$i];
			if ($ch === '"') {
				$end = strpos($code, '"', $i + 1);
				$end = $end === false ? $n : $end;
				$text .= substr($code, $i + 1, $end - $i - 1);
				$i = $end + 1;
				continue;
			}
			if ($ch === '[') {
				$end = strpos($code, ']', $i);
				$end = $end === false ? $n : $end;
				$inside = strtolower(substr($code, $i + 1, $end - $i - 1));
				if ($inside === 'h') {
					$truncate = false;
					$flush();
					$out .= '<number:hours number:style="long"/>';
					$afterHour = true;
				}
				$i = $end + 1;
				continue;
			}
			if (preg_match('/\G(yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|ggg|gg|g|ee|e|AM\/PM|am\/pm)/i', $code, $m, 0, $i)) {
				$tok = $m[1];
				$lower = strtolower($tok);
				$flush();
				$long = strlen($tok) >= 2 ? ' number:style="long"' : '';
				switch ($lower) {
					case 'yyyy': case 'yy':
						$out .= '<number:year' . $long . '/>';
						break;
					case 'ee': case 'e':
						$out .= '<number:year' . $long . ' number:calendar="gengou"/>';
						break;
					case 'ggg': case 'gg': case 'g':
						$out .= '<number:era' . ($lower === 'ggg' ? ' number:style="long"' : '') . ' number:calendar="gengou"/>';
						break;
					case 'mmmm': case 'mmm':
						$out .= '<number:month number:textual="true"' . ($lower === 'mmmm' ? ' number:style="long"' : '') . '/>';
						break;
					case 'mm': case 'm':
						// Minutes after an hour (h:mm) or before seconds (mm:ss); months otherwise.
						$next = substr($code, $i + strlen($tok), 2);
						if ($afterHour || $isTime || preg_match('/^:s/i', $next)) {
							$out .= '<number:minutes' . $long . '/>';
							$afterHour = false;
						} else {
							$out .= '<number:month' . $long . '/>';
						}
						break;
					case 'dddd': case 'ddd':
						$out .= '<number:day-of-week' . ($lower === 'dddd' ? ' number:style="long"' : '') . '/>';
						break;
					case 'dd': case 'd':
						$out .= '<number:day' . $long . '/>';
						break;
					case 'hh': case 'h':
						$out .= '<number:hours' . $long . '/>';
						$afterHour = true;
						break;
					case 'ss': case 's':
						$dec = 0;
						if (preg_match('/\G\.(0+)/', $code, $d, 0, $i + strlen($tok))) {
							$dec = strlen($d[1]);
							$i += strlen($d[0]);
						}
						$out .= '<number:seconds' . $long . ($dec > 0 ? ' number:decimal-places="' . $dec . '"' : '') . '/>';
						break;
					default:
						$out .= '<number:am-pm/>';
				}
				$i += strlen($tok);
				continue;
			}
			$text .= $ch;
			$i++;
		}
		$flush();
		if ($out === '') {
			return null;
		}
		$kind = $isTime ? 'time-style' : 'date-style';
		return '<number:' . $kind . ' style:name="' . $name . '"' . ($truncate ? '' : ' number:truncate-on-overflow="false"') . '>' . $out . '</number:' . $kind . '>';
	}

	// ---- XLSX ----

	/** The code for a numFmtId: a built-in, or one of the file's own (numFmts). */
	public static function fromXlsxId(int $id, array $custom): string {
		if (isset($custom[$id])) {
			return self::cleanXlsxCode($custom[$id]);
		}
		return self::XLSX_BUILTIN[$id] ?? 'General';
	}

	/** Excel's own dressing taken off a code: [$¥-411] → ¥, [$-409] → nothing, _( and * padding dropped. */
	public static function cleanXlsxCode(string $code): string {
		$code = preg_replace('/\[\$([^\]-]*)(?:-[0-9A-Fa-f]+)?\]/u', '$1', $code) ?? $code;
		$code = preg_replace('/_.|\*./u', '', $code) ?? $code;
		$code = str_replace('\\', '', $code);
		return trim($code) === '' ? 'General' : $code;
	}

	/**
	 * The numFmtId of a code: a built-in id, or null when the file must declare it.
	 * The built-in dates and times (14-22, 45-47) are shown by each reader in its
	 * own locale -- 14 is 10/5/2026 in an English LibreOffice -- so a date code
	 * is always declared, and shows as written.
	 */
	public static function xlsxBuiltinId(string $code): ?int {
		static $byCode = null;
		if ($byCode === null) {
			$byCode = array_flip(self::XLSX_BUILTIN);
		}
		$id = $byCode[$code] ?? null;
		return $id === null || ($id >= 14 && $id <= 22) || ($id >= 45 && $id <= 47) ? null : $id;
	}
}
