<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

use OCA\CalcBase\AppInfo\Application;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\NotFoundException;
use OCP\IConfig;
use Psr\Log\LoggerInterface;

/**
 * The sample books that come with the app (samples/*.html, written by the
 * screen's maker): a book on how CalcBase is used, in Japanese and in English.
 * Each person is given them once, the first time they open the book list after
 * the app was installed or upgraded to a version with new samples, in a
 * category of their own -- EditBase's SampleService, with books.
 *
 * A person's own work is never touched. A sample that is still exactly as it
 * was shipped is replaced by the new one; one that has been edited is left
 * alone, and one that has been deleted is not put back until there are new
 * samples (or the person asks for them again).
 */
class SampleService {
	/** Raise this whenever a file in samples/ changes. */
	public const VERSION = '1';
	/** The category the samples go in: the same name in every language (owner 2026-10-02). */
	public const CATEGORY = 'Sample';

	public function __construct(
		private BookService $books,
		private IConfig $config,
		private LoggerInterface $logger,
	) {
	}

	/** The sample files shipped with the app, by name. @return list<string> */
	public static function files(): array {
		$dir = dirname(__DIR__, 2) . '/samples';
		$out = [];
		foreach (glob($dir . '/*.html') ?: [] as $path) {
			if (is_readable($path)) {
				$out[] = basename($path);
			}
		}
		sort($out, SORT_NATURAL | SORT_FLAG_CASE);
		return $out;
	}

	/**
	 * What tells a sample that has been written in from one that has not: the words
	 * in its cells, not the bytes of the file. The file is rewritten by the app as
	 * soon as it is opened and saved -- the stylesheet of the version that saved it --
	 * and compared byte by byte, a sample nobody had touched would count as edited
	 * and never be replaced (EditBase, 2026-10-03, #424).
	 */
	public static function fingerprint(string $html): string {
		$body = preg_replace('/<(script|style)\b[^>]*>.*?<\/\1>/si', ' ', $html) ?? $html;
		if (preg_match('/<body\b[^>]*>(.*)<\/body>/si', $body, $m)) {
			$body = $m[1];
		}
		$text = html_entity_decode(strip_tags($body), ENT_QUOTES | ENT_HTML5, 'UTF-8');
		$text = preg_replace('/\s+/u', ' ', $text) ?? $text;
		return hash('sha256', trim($text));
	}

	/** What the person has been given, for the screen. */
	public function status(string $userId): array {
		return [
			'version' => self::VERSION,
			'files' => self::files(),
			'category' => self::CATEGORY,
			'given' => $this->config->getUserValue($userId, Application::APP_ID, 'sampleVersion', '') === self::VERSION,
		];
	}

	/** Give the person the samples if they have not had this version of them. Never throws. */
	public function ensure(string $userId): void {
		if ($this->config->getUserValue($userId, Application::APP_ID, 'sampleVersion', '') === self::VERSION) {
			return;
		}
		try {
			$this->give($userId, false);
		} catch (\Throwable $e) {
			$this->logger->warning('CalcBase could not give the sample books: ' . $e->getMessage(), ['app' => Application::APP_ID]);
		}
	}

	/**
	 * Put the samples into the person's folder: the ones they have not got, and the
	 * ones still exactly as shipped (replaced). With $again, a deleted one is put
	 * back too -- the person asked for them.
	 */
	public function give(string $userId, bool $again): array {
		$files = self::files();
		// Without the samples there is nothing to give; the mark is not set, so they
		// arrive once the files are there.
		if ($files === []) {
			return $this->status($userId);
		}
		$hashes = json_decode($this->config->getUserValue($userId, Application::APP_ID, 'sampleHashes', '{}'), true);
		if (!is_array($hashes)) {
			$hashes = [];
		}
		$category = $this->category($this->books->folder($userId), self::CATEGORY);
		foreach ($files as $name) {
			$content = @file_get_contents(dirname(__DIR__, 2) . '/samples/' . $name);
			if ($content === false) {
				continue;
			}
			if ($category->nodeExists($name)) {
				$node = $category->get($name);
				// Only a sample nobody has written in (still as it was sent) is replaced.
				if (!($node instanceof File) || !isset($hashes[$name]) || self::fingerprint($node->getContent()) !== $hashes[$name]) {
					continue;
				}
				$node->putContent($content);
			} elseif ($again || !isset($hashes[$name])) {
				$category->newFile($name, $content);
			} else {
				// Deleted on purpose: not put back for a new version of the same sample.
				continue;
			}
			$hashes[$name] = self::fingerprint($content);
		}
		$this->config->setUserValue($userId, Application::APP_ID, 'sampleHashes', json_encode($hashes));
		$this->config->setUserValue($userId, Application::APP_ID, 'sampleVersion', self::VERSION);
		return $this->status($userId);
	}

	private function category(Folder $base, string $name): Folder {
		try {
			$node = $base->get($name);
			if ($node instanceof Folder) {
				return $node;
			}
		} catch (NotFoundException) {
			// fall through and create it
		}
		return $base->newFolder($name);
	}
}
