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
	private const NS_LOEXT = 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0';

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
		$isDate = $kind === 'date-style' || $kind === 'time-style';
		/** @var list<array{0: string, 1: string}> $parts [what it is (y, mon, d, or ''), its code] */
		$parts = [];
		$colour = '';
		foreach ($style->childNodes as $node) {
			if (!($node instanceof \DOMElement)) {
				continue;
			}
			$ln = $node->localName;
			$long = $node->getAttributeNS(self::NS_NUMBER, 'style') === 'long';
			switch ($ln) {
				case 'text':
					$parts[] = ['', self::literal($node->textContent, $isDate)];
					break;
				case 'text-content':
					$parts[] = ['', '@'];
					break;
				case 'number':
					$parts[] = ['', self::numberPart($node)];
					break;
				case 'scientific-number':
					$parts[] = ['', self::scientificPart($node)];
					break;
				case 'fraction':
					$parts[] = ['', self::fractionPart($node)];
					break;
				case 'currency-symbol':
					$parts[] = ['', self::literal($node->textContent, false)];
					break;
				case 'year':
					$parts[] = ['y', $node->getAttributeNS(self::NS_NUMBER, 'calendar') === 'gengou' ? ($long ? 'ee' : 'e') : ($long ? 'yyyy' : 'yy')];
					break;
				case 'era':
					$parts[] = ['', $long ? 'ggg' : 'g'];
					break;
				case 'month':
					$textual = $node->getAttributeNS(self::NS_NUMBER, 'textual') === 'true';
					$parts[] = ['mon', $textual ? ($long ? 'mmmm' : 'mmm') : ($long ? 'mm' : 'm')];
					break;
				case 'day':
					$parts[] = ['d', $long ? 'dd' : 'd'];
					break;
				case 'day-of-week':
					$parts[] = ['', $long ? 'dddd' : 'ddd'];
					break;
				case 'hours':
					$parts[] = ['', $style->getAttributeNS(self::NS_NUMBER, 'truncate-on-overflow') === 'false' ? '[h]' : ($long ? 'hh' : 'h')];
					break;
				case 'minutes':
					$parts[] = ['', $long ? 'mm' : 'm'];
					break;
				case 'seconds':
					$dec = (int)$node->getAttributeNS(self::NS_NUMBER, 'decimal-places');
					$parts[] = ['', ($long ? 'ss' : 's') . ($dec > 0 ? '.' . str_repeat('0', $dec) : '')];
					break;
				case 'am-pm':
					$parts[] = ['', 'AM/PM'];
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
		// A date style "in the order of the locale" (number:automatic-order) is shown
		// by Calc with its year, month and day in the order of the language it runs
		// in, whatever order the file lists them in: year, month, day in Japanese
		// (lo_date-time-functions.ods: month/day/year written, 14/11/01 shown).
		if ($kind === 'date-style' && $style->getAttributeNS(self::NS_NUMBER, 'automatic-order') === 'true') {
			$slots = [];
			$byKind = [];
			foreach ($parts as $i => [$what, $code]) {
				if ($what !== '') {
					$slots[] = $i;
					$byKind[$what] = $code;
				}
			}
			$order = array_values(array_filter(['y', 'mon', 'd'], static fn ($k) => isset($byKind[$k])));
			if (count($order) === count($slots)) {
				foreach ($slots as $n => $i) {
					$parts[$i] = [$order[$n], $byKind[$order[$n]]];
				}
			}
		}
		$out = implode('', array_column($parts, 1));
		if ($kind === 'text-style' && !str_contains($out, '@')) {
			$out .= '@';
		}
		return $out === '' ? '' : $colour . $out;
	}

	private static function numberPart(\DOMElement $n): string {
		// No count of decimals at all is Calc's "General" (Standard): as many as
		// the number needs. Calc writes General so; read as "0" it rounded 3.14159 to 3.
		if (!$n->hasAttributeNS(self::NS_NUMBER, 'decimal-places') && $n->getAttributeNS(self::NS_NUMBER, 'grouping') !== 'true') {
			return 'General';
		}
		$dec = (int)$n->getAttributeNS(self::NS_NUMBER, 'decimal-places');
		$minDec = $n->hasAttributeNS(self::NS_NUMBER, 'min-decimal-places') ? (int)$n->getAttributeNS(self::NS_NUMBER, 'min-decimal-places') : $dec;
		$int = max(0, (int)$n->getAttributeNS(self::NS_NUMBER, 'min-integer-digits'));
		$grouping = $n->getAttributeNS(self::NS_NUMBER, 'grouping') === 'true';
		$ipart = $grouping ? '#,##' . str_repeat('0', max(1, $int)) : ($int > 0 ? str_repeat('0', $int) : '#');
		if ($grouping && $int === 0) {
			$ipart = '#,###';
		}
		// Decimals that may be left out are # -- or ?, a space each, where Calc
		// writes the space as their replacement (0.??? → decimal-replacement=" ").
		$optional = trim($n->getAttributeNS(self::NS_NUMBER, 'decimal-replacement')) === '' && $n->hasAttributeNS(self::NS_NUMBER, 'decimal-replacement') ? '?' : '#';
		$fpart = $dec > 0 ? '.' . str_repeat('0', min($minDec, $dec)) . str_repeat($optional, max(0, $dec - $minDec)) : '';
		return $ipart . $fpart;
	}

	/**
	 * 0.00E+00, and the engineering ##0.0#E-0 (exponent in steps of three, the
	 * sign only when it is negative) as Calc writes them.
	 */
	private static function scientificPart(\DOMElement $n): string {
		$dec = (int)$n->getAttributeNS(self::NS_NUMBER, 'decimal-places');
		$minDec = $n->hasAttributeNS(self::NS_NUMBER, 'min-decimal-places') ? (int)$n->getAttributeNS(self::NS_NUMBER, 'min-decimal-places') : $dec;
		$int = max(1, (int)($n->getAttributeNS(self::NS_NUMBER, 'min-integer-digits') ?: 1));
		$interval = (int)($n->getAttributeNS(self::NS_NUMBER, 'exponent-interval') ?: $n->getAttributeNS(self::NS_LOEXT, 'exponent-interval') ?: 1);
		$exp = max(1, (int)($n->getAttributeNS(self::NS_NUMBER, 'min-exponent-digits') ?: 2));
		$forced = ($n->getAttributeNS(self::NS_NUMBER, 'forced-exponent-sign') ?: $n->getAttributeNS(self::NS_LOEXT, 'forced-exponent-sign')) !== 'false';
		$ipart = str_repeat('#', max(0, $interval - $int)) . str_repeat('0', $int);
		$fpart = $dec > 0 ? '.' . str_repeat('0', min($minDec, $dec)) . str_repeat('#', max(0, $dec - $minDec)) : '';
		return $ipart . $fpart . 'E' . ($forced ? '+' : '-') . str_repeat('0', $exp);
	}

	/** # ??/?? and its kin: an integer part or none, the numerator's and the denominator's digits, or a fixed denominator. */
	private static function fractionPart(\DOMElement $n): string {
		$ipart = '';
		if ($n->hasAttributeNS(self::NS_NUMBER, 'min-integer-digits')) {
			$int = (int)$n->getAttributeNS(self::NS_NUMBER, 'min-integer-digits');
			$ipart = ($int > 0 ? str_repeat('0', $int) : '#') . ' ';
		}
		$num = max(1, (int)$n->getAttributeNS(self::NS_NUMBER, 'min-numerator-digits'), (int)$n->getAttributeNS(self::NS_LOEXT, 'max-numerator-digits'));
		$fixed = (int)$n->getAttributeNS(self::NS_NUMBER, 'denominator-value');
		if ($fixed > 0) {
			$den = (string)$fixed;
		} else {
			$maxValue = $n->getAttributeNS(self::NS_NUMBER, 'max-denominator-value');
			$den = str_repeat('?', max(1, (int)$n->getAttributeNS(self::NS_NUMBER, 'min-denominator-digits'), (int)$n->getAttributeNS(self::NS_LOEXT, 'max-denominator-digits'), ctype_digit($maxValue) ? strlen($maxValue) : 0));
		}
		return $ipart . str_repeat('?', $num) . '/' . $den;
	}

	/**
	 * A literal inside a code. In a date, the separators people type (/ - : . ,
	 * spaces, Japanese) stay as they are; in a number, / is a fraction and most
	 * letters mean something, so anything but spaces, signs, brackets and
	 * currency symbols is quoted, as Calc quotes it ("/ "#,##0.00).
	 */
	private static function literal(string $text, bool $inDate = true): string {
		if ($text === '') {
			return '';
		}
		$plain = $inDate
			? '/^[\s\/\-:.,%¥$€£()\x{FF04}\x{FFE5}\x{20AC}\x{00A3}\x{3000}-\x{30FF}\x{4E00}-\x{9FFF}]+$/u'
			: '/^[\s\-()%¥$€£\x{FF04}\x{FFE5}\x{20AC}\x{00A3}]+$/u';
		if (preg_match($plain, $text)) {
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
		$esc = static fn (string $s): string => htmlspecialchars($s, ENT_XML1 | ENT_QUOTES, 'UTF-8');
		$bare = preg_replace('/"[^"]*"/', '', $pos) ?? '';
		// Text: @ with what is written around it ("/"@ shows ">" as "/>").
		if (str_contains($bare, '@')) {
			return '<number:text-style style:name="' . $name . '">' . self::odsTextBody($pos, $esc) . '</number:text-style>';
		}
		if ($pos === 'General' || $pos === '') {
			return null;
		}
		// A date or time: any of the date letters outside quotes (General, Calc's
		// "as many decimals as it needs", is a number with words around it).
		if (!str_contains($bare, 'General') && preg_match('/(?<!\[)(?:y|d|h|s|AM\/PM|g|e|m(?!\/))/i', $bare)
			&& !preg_match('/[0#?]/', preg_replace('/s\.0+/i', 's', $bare) ?? $bare)) {
			return self::odsDateStyle($pos, $name, $esc);
		}
		$body = self::odsNumberBody($pos, $esc);
		if ($body === null) {
			return null;
		}
		$kind = str_contains($bare, '%') ? 'percentage-style' : (preg_match('/[¥$€£\x{FFE5}]/u', $bare) ? 'currency-style' : 'number-style');
		if ($neg === null) {
			return '<number:' . $kind . ' style:name="' . $name . '">' . $body . '</number:' . $kind . '>';
		}
		$negBody = self::odsNumberBody($neg, $esc);
		if ($negBody === null) {
			return '<number:' . $kind . ' style:name="' . $name . '">' . $body . '</number:' . $kind . '>';
		}
		// Two styles: the positive one (named P0) that the negative one maps to. The
		// negative one shows the number without its sign, as Calc does: the minus
		// is the "-" written in the section, and must be written out as text.
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

	/**
	 * A code taken apart into its quoted texts and the rest: the rest with each
	 * quoted text replaced by \x01, as many \x03 as its number and one, and \x02
	 * (no digit in it, for a digit would be taken for part of the number).
	 *
	 * @return array{0: string, 1: list<string>}
	 */
	private static function protect(string $code): array {
		$texts = [];
		$out = preg_replace_callback('/"([^"]*)"|\\\\(.)/u', static function (array $m) use (&$texts): string {
			$texts[] = $m[1] !== '' ? $m[1] : ($m[2] ?? '');
			return "\x01" . str_repeat("\x03", count($texts)) . "\x02";
		}, $code) ?? $code;
		return [$out, $texts];
	}

	/** Text around a number, as number:text and number:currency-symbol elements; quoted text as it was written. */
	private static function odsTextRun(string $run, array $texts, callable $esc): string {
		$out = '';
		$text = '';
		$flush = static function () use (&$out, &$text, $esc): void {
			if ($text !== '') {
				$out .= '<number:text>' . $esc($text) . '</number:text>';
				$text = '';
			}
		};
		foreach (preg_split('/(\x01\x03+\x02|[¥$€£\x{FFE5}])/u', $run, -1, PREG_SPLIT_DELIM_CAPTURE | PREG_SPLIT_NO_EMPTY) ?: [] as $piece) {
			if (preg_match('/^\x01(\x03+)\x02$/', $piece, $m)) {
				$text .= $texts[strlen($m[1]) - 1];
			} elseif (preg_match('/^[¥$€£\x{FFE5}]$/u', $piece)) {
				$flush();
				$out .= '<number:currency-symbol>' . $esc($piece) . '</number:currency-symbol>';
			} else {
				$text .= $piece;
			}
		}
		$flush();
		return $out;
	}

	/** The body of a text style: what is written before and after @. */
	private static function odsTextBody(string $code, callable $esc): string {
		[$plain, $texts] = self::protect(str_replace('[Red]', '', $code));
		$at = strpos($plain, '@');
		return self::odsTextRun(substr($plain, 0, (int)$at), $texts, $esc) . '<number:text-content/>' . self::odsTextRun(substr($plain, (int)$at + 1), $texts, $esc);
	}

	/**
	 * The number:* elements of a numeric code -- the text before, the number
	 * (plain, scientific or a fraction), the text after; null when there is no
	 * number in it.
	 */
	private static function odsNumberBody(string $code, callable $esc): ?string {
		[$plain, $texts] = self::protect(preg_replace('/\[[^\]]*\]/', '', $code) ?? $code);
		$core = '/(?<gen>General)|(?<frac>(?:[#0?,]+ +)?[#0?]+\/(?:[#0?]+|[1-9]\d*))|(?<sci>[#0,]*[0#](?:\.[0#]*)?[Ee][+-]0+)|(?<num>[#0?,]*[0#?](?:\.[0#?]*)?|\.[0#?]+)/';
		if (!preg_match($core, $plain, $m, PREG_OFFSET_CAPTURE | PREG_UNMATCHED_AS_NULL)) {
			return null;
		}
		[$num, $at] = $m[0];
		$before = substr($plain, 0, $at);
		$after = substr($plain, $at + strlen($num));
		if (($m['gen'][0] ?? null) !== null) {
			// As Calc writes General: a number with no count of decimals.
			$el = '<number:number number:min-integer-digits="1"/>';
		} elseif (($m['frac'][0] ?? null) !== null) {
			preg_match('/^(?:([#0?,]+) +)?([#0?]+)\/([#0?]+|\d+)$/', $num, $f);
			$el = '<number:fraction';
			if (($f[1] ?? '') !== '') {
				$el .= ' number:min-integer-digits="' . substr_count($f[1], '0') . '"' . (str_contains($f[1], ',') ? ' number:grouping="true"' : '');
			}
			$el .= ' number:min-numerator-digits="' . strlen($f[2]) . '"';
			if (ctype_digit($f[3])) {
				$el .= ' number:denominator-value="' . (int)$f[3] . '"';
			} else {
				$el .= ' number:min-denominator-digits="' . strlen($f[3]) . '" number:max-denominator-value="' . str_repeat('9', strlen($f[3])) . '"';
			}
			$el .= '/>';
		} elseif (($m['sci'][0] ?? null) !== null) {
			preg_match('/^([#0,]*[0#])(?:\.([0#]*))?[Ee]([+-])(0+)$/', $num, $f);
			$int = str_replace(',', '', $f[1]);
			$dec = $f[2] ?? '';
			$el = '<number:scientific-number number:decimal-places="' . strlen($dec) . '" number:min-decimal-places="' . substr_count($dec, '0') . '"'
				. ' number:min-integer-digits="' . max(1, substr_count($int, '0')) . '" number:min-exponent-digits="' . strlen($f[4]) . '"'
				. (strlen($int) > 1 && str_contains($int, '#') ? ' number:exponent-interval="' . strlen($int) . '"' : '')
				. ' number:forced-exponent-sign="' . ($f[3] === '+' ? 'true' : 'false') . '"/>';
		} else {
			$parts = explode('.', $num, 2);
			$dec = $parts[1] ?? '';
			$el = '<number:number number:decimal-places="' . strlen($dec) . '" number:min-decimal-places="' . substr_count($dec, '0') . '"'
				. (str_contains($dec, '?') ? ' number:decimal-replacement=" "' : '')
				. ' number:min-integer-digits="' . substr_count($parts[0], '0') . '"' . (str_contains($parts[0], ',') ? ' number:grouping="true"' : '') . '/>';
		}
		return self::odsTextRun($before, $texts, $esc) . $el . self::odsTextRun($after, $texts, $esc);
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
						// yy is the two-digit year (06/11/24), yyyy the four-digit one
						$out .= '<number:year' . ($lower === 'yyyy' ? ' number:style="long"' : '') . '/>';
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
