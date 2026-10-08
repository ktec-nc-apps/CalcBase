<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;

/**
 * Browsing the user's own Files, so a folder can be chosen to keep books in,
 * and a spreadsheet or a CSV file can be picked to be made into a book.
 */
class FileBrowser {
	/** The most a file to be imported may weigh on disk (the ZIP's own size for ODS and XLSX). */
	/** The server's own ceiling for a file brought in; a writer's limit is usually lower (BookService::limits). */
	public const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

	/** Whether a file is one CalcBase can make a book from, by its name: the MIME type is not reliable for CSV. */
	public static function importFormat(string $name): string {
		if (preg_match('/\.(csv|tsv|txt|ods|xlsx|xlsm|md|markdown)$/i', $name, $m)) {
			$ext = strtolower($m[1]);
			return match ($ext) {
				'tsv', 'txt' => 'csv',
				'xlsm' => 'xlsx',
				'markdown' => 'md',
				default => $ext,
			};
		}
		return '';
	}

	/** Whether a file is a Markdown text, by its name. */
	public static function isMarkdown(string $name): bool {
		return (bool)preg_match('/\.(md|markdown)$/i', $name);
	}

	public function __construct(
		private IRootFolder $rootFolder,
	) {
	}

	/**
	 * One folder's contents: directories first, then files, both by name.
	 *
	 * @return array<string, mixed>
	 */
	public function browse(string $userId, string $path): array {
		$userFolder = $this->rootFolder->getUserFolder($userId);
		$path = trim($path, '/');
		$node = $path === '' ? $userFolder : $userFolder->get($path);
		if (!($node instanceof Folder)) {
			throw new \InvalidArgumentException('not a folder');
		}
		$dirs = [];
		$files = [];
		foreach ($node->getDirectoryListing() as $child) {
			$name = $child->getName();
			$rel = ltrim(substr($child->getPath(), strlen($userFolder->getPath())), '/');
			if ($child instanceof Folder) {
				$dirs[] = ['name' => $name, 'path' => $rel, 'is_dir' => true];
				continue;
			}
			$lower = strtolower($name);
			$files[] = [
				'name' => $name,
				'path' => $rel,
				'is_dir' => false,
				'id' => $child->getId(),
				'mime' => $child->getMimeType(),
				'size' => $child->getSize(),
				'is_book' => str_ends_with($lower, '.html') || str_ends_with($lower, '.htm'),
				'import' => self::importFormat($name),
			];
		}
		$byName = static fn (array $a, array $b): int => strnatcasecmp($a['name'], $b['name']);
		usort($dirs, $byName);
		usort($files, $byName);
		return [
			'path' => $path,
			'parent' => $this->parentOf($path),
			'entries' => array_merge($dirs, $files),
		];
	}

	/** The folder above this one, '' for the home folder, null when already there. */
	private function parentOf(string $path): ?string {
		if ($path === '') {
			return null;
		}
		$up = dirname($path);
		return ($up === '.' || $up === '/' || $up === '') ? '' : $up;
	}

	/**
	 * A file to be made into a book, by its id in this user's Files.
	 *
	 * The file itself is only read, never written: the book made from it is a
	 * new file, and the original stays as it was. Made into a book of one's own
	 * it is a copy, so a share that does not allow downloading refuses (review S3).
	 */
	public function importable(string $userId, int $id, int $maxBytes = self::MAX_IMPORT_BYTES): File {
		$userFolder = $this->rootFolder->getUserFolder($userId);
		$file = null;
		foreach ($userFolder->getById($id) as $node) {
			if ($node instanceof File) {
				$file = $node;
				break;
			}
		}
		if ($file === null) {
			throw new NotFoundException('file ' . $id . ' not found');
		}
		if (!Downloads::allowed($file)) {
			throw new NotPermittedException('whoever shared this file does not allow it to be downloaded');
		}
		if (self::importFormat($file->getName()) === '') {
			throw new \InvalidArgumentException('not a CSV, ODS, XLSX or Markdown file');
		}
		if ($file->getSize() > $maxBytes) {
			throw new \InvalidArgumentException('file is larger than ' . (int)($maxBytes / 1024 / 1024) . ' MB');
		}
		return $file;
	}

	/**
	 * A Markdown file's text, for the tables in it. The file itself is only read.
	 * Text written on a Japanese Windows machine is often Shift_JIS rather than
	 * UTF-8; TextEncoding works out what it is (as EditBase's FileBrowser does).
	 *
	 * @return array{id: int, name: string, content: string, encoding: array<string, mixed>}
	 */
	public function markdown(string $userId, int $id): array {
		$file = $this->importable($userId, $id);
		if (!self::isMarkdown($file->getName())) {
			throw new \InvalidArgumentException('not a Markdown file');
		}
		$read = TextEncoding::toUtf8((string)$file->getContent());
		return [
			'id' => $file->getId(),
			'name' => preg_replace('/\.(md|markdown)$/i', '', $file->getName()) ?? $file->getName(),
			'content' => $read['text'],
			'encoding' => ['read' => $read['encoding'], 'lossy' => $read['lossy']],
		];
	}
}
