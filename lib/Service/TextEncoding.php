<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * Turning the bytes of a file into UTF-8 text, whatever they were written in.
 *
 * Every way text comes into CalcBase goes through here: a book opened from
 * Files, an old version of one, a CSV file made into a book. Copied from
 * EditBase, where each way used to do it on its own and each got a different
 * case wrong:
 *
 *  - a file from elsewhere was handed on as it was; a Shift_JIS file could
 *    not even be opened, because the bytes were not valid for the JSON carrying
 *    them to the browser;
 *  - a file that says Shift_JIS (or ISO-8859-1, which is what a web server
 *    says when nobody told it otherwise) while being written in UTF-8 came out
 *    as garbage when the declaration was believed;
 *  - a text file took ISO-2022-JP for UTF-8 (it is seven-bit, so it is
 *    "valid"), and could take EUC-JP for Shift_JIS (the bytes of the one are
 *    often legal in the other).
 *
 * The rule, in the order it is applied:
 *
 *  1. A byte-order mark says what the file is, and nothing overrules it.
 *  2. ISO-2022-JP switches character sets with escape sequences; if it has them,
 *     it is that. This has to come before UTF-8, which it would otherwise pass.
 *  3. If the bytes are valid UTF-8, the text is UTF-8 -- whatever the file or the
 *     server says about itself. Japanese text written in anything else is almost
 *     never valid UTF-8 by accident, so this is the strongest evidence there is,
 *     and a declaration that contradicts it is the thing that is wrong.
 *  4. Otherwise each candidate is tried, and the one that reads most like text
 *     is taken. Reading EUC-JP as Shift_JIS, or the other way round, gives a
 *     spray of half-width katakana and characters nobody uses; the right reading
 *     gives hiragana and ordinary kanji. What the file declares is only the tie
 *     breaker between readings that are equally good.
 *  5. If nothing reads it, the parts that cannot be read are replaced with
 *     U+FFFD and the caller is told, so the writer can be told.
 */
final class TextEncoding {
	/** The encodings a Japanese office is likely to have files in, most likely first. */
	private const CANDIDATES = ['CP932', 'eucJP-win', 'Windows-1252'];

	/**
	 * @param string $bytes what is in the file
	 * @param string $declared what the file or the server says it is ('' if nothing)
	 * @return array{text: string, encoding: string, declared: string, mismatch: bool, lossy: bool}
	 */
	public static function toUtf8(string $bytes, string $declared = ''): array {
		$said = self::canonical($declared);
		$done = static function (string $text, string $enc, bool $lossy = false) use ($said): array {
			return [
				'text' => $text,
				'encoding' => $enc,
				'declared' => $said,
				// Only a declaration that names something else is a mismatch. Saying
				// nothing is not; and plain ASCII reads the same in all of them.
				'mismatch' => $said !== '' && $said !== $enc && !self::sameForAscii($said, $enc, $text),
				'lossy' => $lossy,
			];
		};

		// 1) byte-order marks. UTF-32 before UTF-16: FF FE 00 00 also starts FF FE.
		if (strncmp($bytes, "\xEF\xBB\xBF", 3) === 0) {
			$rest = substr($bytes, 3);
			if (mb_check_encoding($rest, 'UTF-8')) {
				return $done($rest, 'UTF-8');
			}
			return $done(self::scrub($rest), 'UTF-8', true);
		}
		foreach ([["\xFF\xFE\x00\x00", 'UTF-32LE'], ["\x00\x00\xFE\xFF", 'UTF-32BE'],
			["\xFF\xFE", 'UTF-16LE'], ["\xFE\xFF", 'UTF-16BE']] as [$mark, $enc]) {
			if (strncmp($bytes, $mark, strlen($mark)) === 0) {
				$rest = substr($bytes, strlen($mark));
				if (mb_check_encoding($rest, $enc)) {
					return $done((string)mb_convert_encoding($rest, 'UTF-8', $enc), $enc);
				}
			}
		}

		// 2) ISO-2022-JP: seven-bit, with escape sequences to change the character set.
		if (!preg_match('/[\x80-\xFF]/', $bytes) && preg_match('/\x1B(\$[@B]|\$\(D|\([BJI])/', $bytes)) {
			$text = (string)mb_convert_encoding($bytes, 'UTF-8', 'ISO-2022-JP-MS');
			if (mb_check_encoding($text, 'UTF-8') && strpos($text, "\x1B") === false) {
				return $done($text, 'ISO-2022-JP');
			}
		}

		// 3) valid UTF-8 is UTF-8.
		if (mb_check_encoding($bytes, 'UTF-8')) {
			return $done($bytes, 'UTF-8');
		}
		// UTF-8 cut off in the middle of its last character -- a file cut at a size
		// limit, wherever that falls. Only the last one to
		// three bytes are wrong, and they are wrong only because the rest is missing.
		// Without this, one broken character at the very end made the whole page
		// "not UTF-8", and it was read as Shift_JIS from the first line.
		$cut = self::cutUtf8($bytes);
		if ($cut !== null) {
			return $done($cut, 'UTF-8', true);
		}

		// 4) try each reading, keep the one that reads most like text.
		//
		// First, whether the bytes are Western at all. In Windows-1252 an accented
		// letter is one byte standing alone between ASCII letters (caf[é]); in
		// Shift_JIS and EUC-JP every character above ASCII is two bytes side by side.
		// That shows in a string of any length, which the characters themselves do
		// not: 東京 in EUC-JP, read as Windows-1252, is four accented letters, and
		// four accented letters outscored two kanji.
		$western = self::looksWestern($bytes);
		$best = null;
		$order = $western ? ['Windows-1252', 'CP932', 'eucJP-win'] : ['CP932', 'eucJP-win'];
		// Some other encoding the file names for itself is tried too. Not Windows-1252
		// when the bytes are not Western: "ISO-8859-1" is what a web server says when
		// nobody told it anything, and believing it turned Japanese into accents.
		if ($said !== '' && $said !== 'UTF-8' && $said !== 'Windows-1252' && !in_array($said, $order, true)) {
			array_unshift($order, $said);
		}
		foreach ($order as $enc) {
			if (!self::known($enc) || !mb_check_encoding($bytes, $enc)) {
				continue;
			}
			$text = (string)mb_convert_encoding($bytes, 'UTF-8', $enc);
			$score = self::score($text, $enc === 'Windows-1252');
			// The declaration breaks ties, and only ties.
			if ($enc === $said) {
				$score += 0.5;
			}
			if ($best === null || $score > $best[2]) {
				$best = [$text, $enc, $score];
			}
		}
		// Two accented letters side by side (Größe) look paired, like Japanese; when
		// no Japanese reading will take the bytes, they are Western after all.
		if ($best === null && !$western && mb_check_encoding($bytes, 'Windows-1252')) {
			$best = [(string)mb_convert_encoding($bytes, 'UTF-8', 'Windows-1252'), 'Windows-1252', 0.0];
		}
		if ($best !== null) {
			return $done($best[0], $best[1]);
		}

		// 5) nothing reads it: keep what can be read, mark what cannot.
		return $done(self::scrub($bytes), 'UTF-8', true);
	}

	/**
	 * The charset an HTML file declares for itself, from the first few kilobytes:
	 * <meta charset="…"> or <meta http-equiv="Content-Type" content="…; charset=…">.
	 */
	public static function declaredInHtml(string $bytes): string {
		$head = substr($bytes, 0, 4096);
		if (preg_match('/<meta\b[^>]*?\bcharset\s*=\s*["\']?\s*([A-Za-z0-9_.:-]+)/i', $head, $m)) {
			return $m[1];
		}
		return '';
	}

	/** The charset named in an HTTP Content-Type header, or ''. */
	public static function declaredInContentType(string $type): string {
		if (preg_match('/charset\s*=\s*["\']?\s*([A-Za-z0-9_.:-]+)/i', $type, $m)) {
			return $m[1];
		}
		return '';
	}

	/**
	 * An HTML file's text in UTF-8, with its own declaration made to say so. Left
	 * saying Shift_JIS, the text would carry a label that no longer describes it.
	 *
	 * @return array{text: string, encoding: string, declared: string, mismatch: bool, lossy: bool}
	 */
	public static function htmlToUtf8(string $bytes, string $declared = ''): array {
		$said = $declared !== '' ? $declared : self::declaredInHtml($bytes);
		$r = self::toUtf8($bytes, $said);
		$r['text'] = self::relabel($r['text']);
		return $r;
	}

	/** Make every charset declaration in an HTML text say UTF-8. */
	public static function relabel(string $html): string {
		$html = preg_replace('/(<meta\b[^>]*?\bcharset\s*=\s*["\']?\s*)[A-Za-z0-9_.:-]+/i', '${1}utf-8', $html, 1) ?? $html;
		return $html;
	}

	/**
	 * How much a reading looks like text.
	 *
	 * Real Japanese is full of hiragana -- the particles alone see to that -- and a
	 * wrong reading of the bytes almost never produces any. So hiragana counts
	 * most. Half-width katakana is not held against a reading: it is a wrong
	 * reading's typical debris, but old business systems write whole headings in
	 * it, and marking it down read ｱｲｳｴｵ 半角カナの見出し as Windows-1252 garbage.
	 * A reading that is nothing but kanji, with no kana at all, is what Western
	 * text read as Shift_JIS looks like, and is trusted less.
	 *
	 * Private-use characters, C1 control characters and U+FFFD are what no text
	 * contains, and count heavily against.
	 */
	private static function score(string $text, bool $western): float {
		$bad = (float)preg_match_all('/[\x{E000}-\x{F8FF}\x{FFFD}\x{0080}-\x{009F}]/u', $text);
		if ($western) {
			$latin = (float)preg_match_all('/[\x{00C0}-\x{00FF}]/u', $text);
			return $latin - 5.0 * $bad;
		}
		$hira = (float)preg_match_all('/[\x{3040}-\x{309F}]/u', $text);
		$kata = (float)preg_match_all('/[\x{30A0}-\x{30FF}]/u', $text);
		$half = (float)preg_match_all('/[\x{FF61}-\x{FF9F}]/u', $text);
		$kanji = (float)preg_match_all('/[\x{4E00}-\x{9FFF}]/u', $text);
		$marks = (float)preg_match_all('/[\x{3000}-\x{303F}\x{FF01}-\x{FF5E}\x{2460}-\x{24FF}\x{3200}-\x{33FF}\x{2200}-\x{22FF}]/u', $text);
		$jp = 3.0 * $hira + $kata + $kanji + $marks + 0.5 * $half;
		// No kana at all: random kanji or a run of half-width katakana is what the
		// wrong one of Shift_JIS and EUC-JP makes of the other's bytes.
		if ($hira + $kata === 0.0) {
			$jp *= 0.5;
		}
		return $jp - 5.0 * $bad;
	}

	/**
	 * Whether the bytes above ASCII stand alone, as accented letters in Western
	 * text do, rather than in pairs, as every Japanese character does.
	 */
	private static function looksWestern(string $bytes): bool {
		$n = strlen($bytes);
		$high = 0;
		$paired = 0;
		for ($i = 0; $i < $n; $i++) {
			if (ord($bytes[$i]) < 0x80) {
				continue;
			}
			$high++;
			$prev = $i > 0 && ord($bytes[$i - 1]) >= 0x80;
			$next = $i + 1 < $n && ord($bytes[$i + 1]) >= 0x80;
			if ($prev || $next) {
				$paired++;
			}
		}
		return $high > 0 && $paired / $high < 0.5;
	}

	/** UTF-8 whose only fault is a last character cut short: the rest of it, or null. */
	private static function cutUtf8(string $bytes): ?string {
		$n = strlen($bytes);
		for ($k = 1; $k <= 3 && $k < $n; $k++) {
			$head = substr($bytes, 0, $n - $k);
			$tail = substr($bytes, $n - $k);
			// The tail must be the start of a character: a lead byte and continuation bytes.
			if (!preg_match('/^[\xC2-\xF4][\x80-\xBF]*$/', $tail)) {
				continue;
			}
			if (mb_check_encoding($head, 'UTF-8') && preg_match('/[\x80-\xFF]/', $head)) {
				return $head;
			}
		}
		return null;
	}

	/** What the invalid parts become: U+FFFD, the character that says "unreadable". */
	private static function scrub(string $bytes): string {
		$was = mb_substitute_character();
		mb_substitute_character(0xFFFD);
		$text = (string)mb_convert_encoding($bytes, 'UTF-8', 'UTF-8');
		mb_substitute_character($was);
		return $text;
	}

	private static function known(string $enc): bool {
		return in_array(strtolower($enc), array_map('strtolower', mb_list_encodings()), true);
	}

	/** Plain ASCII reads the same in every one of these: saying either is not wrong. */
	private static function sameForAscii(string $a, string $b, string $text): bool {
		return !preg_match('/[\x80-\xFF]/', $text) && $a !== 'UTF-16LE' && $a !== 'UTF-16BE';
	}

	/** The names people use for an encoding, turned into the one mbstring knows. */
	public static function canonical(string $name): string {
		$n = strtoupper(trim($name, " \t\"'"));
		if ($n === '') {
			return '';
		}
		$map = [
			'UTF8' => 'UTF-8', 'UTF-8' => 'UTF-8',
			'SHIFT_JIS' => 'CP932', 'SHIFT-JIS' => 'CP932', 'SJIS' => 'CP932', 'X-SJIS' => 'CP932',
			'MS_KANJI' => 'CP932', 'WINDOWS-31J' => 'CP932', 'CP932' => 'CP932', 'SJIS-WIN' => 'CP932', 'MS932' => 'CP932',
			'EUC-JP' => 'eucJP-win', 'EUCJP' => 'eucJP-win', 'X-EUC-JP' => 'eucJP-win', 'EUCJP-WIN' => 'eucJP-win',
			'ISO-2022-JP' => 'ISO-2022-JP', 'CSISO2022JP' => 'ISO-2022-JP',
			'ISO-8859-1' => 'Windows-1252', 'LATIN1' => 'Windows-1252', 'US-ASCII' => 'Windows-1252',
			'ASCII' => 'Windows-1252', 'WINDOWS-1252' => 'Windows-1252', 'CP1252' => 'Windows-1252',
			'UTF-16' => 'UTF-16LE', 'UTF-16LE' => 'UTF-16LE', 'UTF-16BE' => 'UTF-16BE',
		];
		return $map[$n] ?? $n;
	}
}
