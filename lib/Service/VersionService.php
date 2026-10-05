<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

use OCA\CalcBase\AppInfo\Application;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\FilesMetadata\IFilesMetadataManager;
use OCP\IConfig;

/**
 * Keeping the last few versions of a book beside it.
 *
 * A version is an ordinary file in the same folder, named after the book
 * with its extension replaced by a number: 売上.html keeps 売上.#01, which is
 * always the most recent, and the older ones shift down as new ones are made.
 * They are plain HTML like everything else here, so a version can be opened,
 * printed or picked apart with nothing but a browser -- and Nextcloud's own
 * versions, trash and sync still apply to them as they do to any file. The
 * whole of this is EditBase's VersionService under another app id.
 *
 * The name alone does not say whose a version is: Budget.html and Budget.htm in
 * one folder both come to Budget.#01, and a book deleted in Files leaves its
 * versions behind for the next one of the same name. So each version is also
 * marked, out of sight in the file's metadata, with the id of the book it
 * was taken from (review S10), and a book only ever sees, restores, moves or
 * deletes its own. A version made before the marks were -- it has none -- is
 * taken by its name, as it always was. The names themselves are unchanged.
 */
class VersionService {
	public const MAX = 99;
	private const DEFAULT_KEEP = 10;
	/** The metadata key a version carries: the file id of its book. */
	private const MARK = 'calcbase-version-of';

	public function __construct(
		private IRootFolder $rootFolder,
		private IConfig $config,
		private IFilesMetadataManager $metadata,
	) {
	}

	/** How many versions this user keeps; nought means the feature is off. */
	public function keep(string $userId): int {
		$n = (int)$this->config->getUserValue($userId, Application::APP_ID, 'versionKeep', (string)self::DEFAULT_KEEP);
		return max(0, min(self::MAX, $n));
	}

	public function setKeep(string $userId, int $n): int {
		$n = max(0, min(self::MAX, $n));
		$this->config->setUserValue($userId, Application::APP_ID, 'versionKeep', (string)$n);
		return $n;
	}

	/** When a version is taken: every save, or only the ones the writer asks for. */
	public function when(string $userId): string {
		$when = $this->config->getUserValue($userId, Application::APP_ID, 'versionWhen', 'manual');
		return $when === 'auto' ? 'auto' : 'manual';
	}

	public function setWhen(string $userId, string $when): string {
		$when = $when === 'auto' ? 'auto' : 'manual';
		$this->config->setUserValue($userId, Application::APP_ID, 'versionWhen', $when);
		return $when;
	}

	/**
	 * Put the book as it stands now into #01, shifting what was there down.
	 * Called before the new content is written, so #01 is always the version
	 * before the save that has just happened.
	 *
	 * Says whether a version was taken. None is when versions are off, when the
	 * row holds another book's, and for a book that is not this account's
	 * to copy (review 2026-10-04, 中2): one shared without the right to download
	 * (review S3 -- a version is a copy), and one shared on its own, whose parent
	 * here is the reader's own home folder, so the version would stand there as a
	 * copy the owner never sees.
	 */
	public function take(File $file, int $keep): bool {
		if ($keep < 1) {
			return false;
		}
		$folder = $file->getParent();
		if (!Downloads::allowed($file) || $this->standsAlone($file)) {
			return false;
		}
		$stem = $this->stem($file->getName());
		$of = $file->getId();
		// A place in the row held by another book's version is not this one's
		// to shift or to drop: then no version is taken this time, rather than one
		// book's history being pushed into another's.
		for ($i = 1; $i <= $keep; $i++) {
			$node = $this->slot($folder, $stem, $i);
			if ($node !== null && !$this->belongs($node, $of)) {
				return false;
			}
		}
		// The last one falls off the end.
		$oldest = $this->slot($folder, $stem, $keep);
		if ($oldest !== null) {
			$oldest->delete();
		}
		for ($i = $keep - 1; $i >= 1; $i--) {
			$node = $this->slot($folder, $stem, $i);
			if ($node === null) {
				continue;
			}
			$node->move($folder->getPath() . '/' . $this->name($stem, $i + 1));
		}
		$this->mark($folder->newFile($this->name($stem, 1), $file->getContent()), $of);
		return true;
	}

	/**
	 * Whether the book is a mount point of its own: a single file shared with
	 * this account, which Nextcloud mounts at a path in their home folder. Its
	 * parent is then not the folder it lives in.
	 */
	private function standsAlone(File $file): bool {
		try {
			$mount = rtrim($file->getMountPoint()->getMountPoint(), '/');
			return $mount !== '' && $mount === rtrim($file->getPath(), '/');
		} catch (\Throwable) {
			// A node that cannot say where it is mounted is taken as an ordinary file.
			return false;
		}
	}

	/**
	 * The versions of a book, newest first.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function list(File $file): array {
		$folder = $file->getParent();
		$stem = $this->stem($file->getName());
		$out = [];
		for ($i = 1; $i <= self::MAX; $i++) {
			$node = $this->slot($folder, $stem, $i);
			if ($node === null || !$this->belongs($node, $file->getId())) {
				continue;
			}
			$out[] = [
				'number' => $i,
				'name' => $node->getName(),
				'size' => $node->getSize(),
				'mtime' => $node->getMTime(),
			];
		}
		return $out;
	}

	/** What one version holds. */
	public function read(File $file, int $number): string {
		$node = $this->slot($file->getParent(), $this->stem($file->getName()), $number);
		if ($node === null || !$this->belongs($node, $file->getId())) {
			throw new NotFoundException('there is no version ' . $number);
		}
		// An old version may predate the book being saved by CalcBase, and so
		// still be in whatever it was written in.
		return TextEncoding::htmlToUtf8((string)$node->getContent())['text'];
	}

	/**
	 * Put a version back. What is there now becomes #01 first, so that going back
	 * can itself be gone back on -- and when it cannot be kept, nothing is put
	 * back: the screen promises that what is there now is kept, and it used to be
	 * written over all the same when versions were off or the row was another
	 * book's (review 2026-10-04, 中3).
	 */
	public function restore(File $file, int $number, int $keep): string {
		$content = $this->read($file, $number);
		if ($keep < 1) {
			throw new NotPermittedException('versions are switched off, so what is in the book now cannot be kept; nothing was put back');
		}
		if (!$this->take($file, $keep)) {
			throw new NotPermittedException('what is in the book now could not be kept as a version, so nothing was put back');
		}
		$file->putContent($content);
		return $content;
	}

	/**
	 * The versions of a book, wherever they are. Given by the folder and the
	 * name the book had, because they are looked for both before and after
	 * the book itself has moved -- and by its id, which does not change.
	 *
	 * @return array<int, File>
	 */
	public function slotsOf(Folder $folder, string $name, int $of): array {
		$stem = $this->stem($name);
		$out = [];
		for ($i = 1; $i <= self::MAX; $i++) {
			$node = $this->slot($folder, $stem, $i);
			if ($node !== null && $this->belongs($node, $of)) {
				$out[$i] = $node;
			}
		}
		return $out;
	}

	/**
	 * The versions follow the book: renamed with it, and moved with it. A
	 * backup that no longer answers to the name of the thing it is a backup of is
	 * no use to anybody, and would be picked up by the next book to take that
	 * name.
	 */
	public function follow(Folder $wasIn, string $wasCalled, File $file): void {
		$stem = $this->stem($file->getName());
		$folder = $file->getParent();
		if ($wasIn->getId() === $folder->getId() && $this->stem($wasCalled) === $stem) {
			return;
		}
		foreach ($this->slotsOf($wasIn, $wasCalled, $file->getId()) as $number => $node) {
			$target = $folder->getPath() . '/' . $this->name($stem, $number);
			try {
				$node->move($target);
			} catch (\Throwable) {
				// One that will not move is left where it is rather than lost.
			}
		}
	}

	/** The versions go with the book when it goes. */
	public function drop(File $file): void {
		foreach ($this->slotsOf($file->getParent(), $file->getName(), $file->getId()) as $node) {
			try {
				$node->delete();
			} catch (\Throwable) {
				// Nothing to be done about one that will not go.
			}
		}
	}

	/** Whether a version is this book's: marked with its id, or not marked at all. */
	private function belongs(File $version, int $of): bool {
		try {
			$metadata = $this->metadata->getMetadata($version->getId());
			return !$metadata->hasKey(self::MARK) || $metadata->getInt(self::MARK) === $of;
		} catch (\Throwable) {
			// No metadata: a version from before the marks, or a server without them.
			return true;
		}
	}

	private function mark(File $version, int $of): void {
		try {
			$metadata = $this->metadata->getMetadata($version->getId(), true);
			$metadata->setInt(self::MARK, $of);
			$this->metadata->saveMetadata($metadata);
		} catch (\Throwable) {
			// Unmarked, it is found by its name, as versions always were.
		}
	}

	private function slot(Folder $folder, string $stem, int $number): ?File {
		$name = $this->name($stem, $number);
		if (!$folder->nodeExists($name)) {
			return null;
		}
		$node = $folder->get($name);
		return $node instanceof File ? $node : null;
	}

	private function name(string $stem, int $number): string {
		return $stem . '.#' . str_pad((string)$number, 2, '0', STR_PAD_LEFT);
	}

	private function stem(string $name): string {
		return preg_replace('/\.html?$/i', '', $name) ?? $name;
	}
}
