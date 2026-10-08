<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

use OCA\CalcBase\AppInfo\Application;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\IConfig;
use OCP\IUserManager;
use OCP\Lock\ILockingProvider;
use OCP\Lock\LockedException;
use OCP\Share\IManager as IShareManager;
use OCP\Share\IShare;

/**
 * Books are not rows in a table: they are ordinary .html files in the user's
 * own Files. That is the whole point of the app -- what CalcBase saves is the
 * finished artefact, so sharing, versioning, search and sync all come from
 * Nextcloud itself and nothing has to be exported to leave.
 *
 * This service therefore does no HTML parsing. The browser builds the file and
 * the browser takes it apart again. It is EditBase's DocumentService with the
 * document-only parts taken out (categories as an API of their own, the
 * co-writing state, the check over the document).
 */
class BookService {
	public const EXT = '.html';
	private const DEFAULT_FOLDER = 'CalcBase';

	/** How long a save waits for another save of the same book to finish, in seconds. */
	private float $lockWait = 10.0;

	public function __construct(
		private IRootFolder $rootFolder,
		private IConfig $config,
		private IShareManager $shares,
		private IUserManager $users,
		private VersionService $versions,
		private ILockingProvider $locking,
	) {
	}

	public function folderName(string $userId): string {
		$name = $this->config->getUserValue($userId, Application::APP_ID, 'folder', self::DEFAULT_FOLDER);
		$name = trim($name, "/ \t\n\r\0\x0B");
		return $name === '' ? self::DEFAULT_FOLDER : $name;
	}

	public function setFolderName(string $userId, string $name): string {
		$name = trim($name, "/ \t\n\r\0\x0B");
		if ($name === '' || !$this->isSafePath($name)) {
			throw new \InvalidArgumentException('invalid folder name');
		}
		// The name must be a folder's, or a place where one can be made. The name
		// of a file was accepted, and every listing after it failed with "not
		// permitted" until the setting was changed back (review 2026-10-04, 低9).
		$this->fileInTheWay($this->rootFolder->getUserFolder($userId), $name);
		$this->config->setUserValue($userId, Application::APP_ID, 'folder', $name);
		return $name;
	}

	/** The save folder, created on first use. */
	public function folder(string $userId): Folder {
		$userFolder = $this->rootFolder->getUserFolder($userId);
		$path = $this->folderName($userId);
		try {
			$node = $userFolder->get($path);
			if ($node instanceof Folder) {
				return $node;
			}
		} catch (NotFoundException) {
			// fall through and create it
		}
		// A file put there since the name was set: said plainly, not as "not permitted".
		$this->fileInTheWay($userFolder, $path);
		return $userFolder->newFolder($path);
	}

	/**
	 * A folder inside the save folder, made if it is not there; the save folder
	 * itself for an empty path. Used by move, create and export alike.
	 */
	public function folderAt(string $userId, string $path): Folder {
		$path = $this->cleanFolder($path);
		$folder = $this->folder($userId);
		if ($path === '') {
			return $folder;
		}
		$here = $folder;
		foreach (explode('/', $path) as $part) {
			$here = $here->nodeExists($part) ? $here->get($part) : $here->newFolder($part);
			if (!($here instanceof Folder)) {
				throw new \InvalidArgumentException('there is a file called ' . $part . ' there already');
			}
		}
		return $here;
	}

	/**
	 * A folder of the user's Files by its path from the top of them ("CalcBase/Work"),
	 * as it is: nothing is made. Where it is not there any more, or a file stands
	 * in its place, the save folder is the answer. The folder a book is in is
	 * named this way (what the book's path is, less its name), so that what is
	 * made from the book is put beside it.
	 */
	public function homeFolderAt(string $userId, string $path): Folder {
		$node = $this->rootFolder->getUserFolder($userId);
		foreach (explode('/', str_replace('\\', '/', $path)) as $part) {
			if ($part === '' || $part === '.') {
				continue;
			}
			if ($part === '..' || str_contains($part, "\0")) {
				throw new \InvalidArgumentException('that is not a folder name');
			}
			try {
				$node = $node instanceof Folder ? $node->get($part) : null;
			} catch (NotFoundException) {
				$node = null;
			}
			if (!($node instanceof Folder)) {
				return $this->folder($userId);
			}
		}
		return $node instanceof Folder ? $node : $this->folder($userId);
	}

	/**
	 * The categories the books are kept in -- the folders inside the save folder,
	 * in order, including the empty ones (a folder made and not yet written in is
	 * still a place to put something) -- each with the ids of the books in it.
	 *
	 * @return list<array{path: string, name: string, id: int, books: list<int>}>
	 */
	public function folders(string $userId): array {
		$out = [];
		$this->gatherFolders($this->folder($userId), '', $out);
		usort($out, static fn (array $a, array $b): int => strnatcasecmp($a['path'], $b['path']));
		return $out;
	}

	/** @param list<array<string, mixed>> $out */
	private function gatherFolders(Folder $folder, string $path, array &$out, int $depth = 0): void {
		foreach ($folder->getDirectoryListing() as $node) {
			if (!($node instanceof Folder)) {
				continue;
			}
			$here = $path === '' ? $node->getName() : $path . '/' . $node->getName();
			$books = [];
			foreach ($node->getDirectoryListing() as $child) {
				if ($child instanceof File && $this->isHtml($child->getName())) {
					$books[] = $child->getId();
				}
			}
			$out[] = ['path' => $here, 'name' => $node->getName(), 'id' => $node->getId(), 'books' => $books];
			if ($depth < 4) {
				$this->gatherFolders($node, $here, $out, $depth + 1);
			}
		}
	}

	/** Make a category to keep books in, inside the save folder. */
	public function makeFolder(string $userId, string $path): string {
		$path = $this->cleanFolder($path);
		if ($path === '') {
			throw new \InvalidArgumentException('a folder needs a name');
		}
		$this->folderAt($userId, $path);
		return $path;
	}

	/**
	 * The id of a category, so that it can be shared like anything else. The save
	 * folder itself is not one: sharing that would hand over every book there is,
	 * which is not what anyone means by sharing a category.
	 */
	public function folderId(string $userId, string $path): int {
		$path = $this->cleanFolder($path);
		if ($path === '') {
			throw new \InvalidArgumentException('the whole of your own folder is not a category');
		}
		return $this->categoryAt($userId, $path)->getId();
	}

	/**
	 * Delete a category -- an empty one only (EditBase, owner 2026-09-29): a
	 * category with anything in it is refused, so no book goes with it. The folder
	 * goes to Nextcloud's trash like any deleted folder.
	 */
	public function deleteFolder(string $userId, string $path): void {
		$path = $this->cleanFolder($path);
		if ($path === '') {
			throw new \InvalidArgumentException('the whole of your own folder is not a category');
		}
		$node = $this->categoryAt($userId, $path);
		if (count($node->getDirectoryListing()) > 0) {
			throw new \InvalidArgumentException('not empty');
		}
		$node->delete();
	}

	/** A category that is there, by its cleaned path, one folder at a time. */
	private function categoryAt(string $userId, string $path): Folder {
		$node = $this->folder($userId);
		foreach (explode('/', $path) as $part) {
			$node = $node->get($part);
			if (!($node instanceof Folder)) {
				throw new \InvalidArgumentException('that is not a category');
			}
		}
		return $node;
	}

	/**
	 * Refuse a folder path that runs into a file: at the path itself, or at any
	 * folder on the way to it.
	 */
	private function fileInTheWay(Folder $userFolder, string $path): void {
		$walk = '';
		foreach (explode('/', $path) as $part) {
			$walk = $walk === '' ? $part : $walk . '/' . $part;
			try {
				$node = $userFolder->get($walk);
			} catch (NotFoundException) {
				return;
			}
			if (!($node instanceof Folder)) {
				throw new \InvalidArgumentException('there is a file called ' . $walk . ' there already');
			}
		}
	}

	/**
	 * Every book the user can open: the .html files in the save folder and in
	 * the folders inside it, and the ones other people have shared with them.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function list(string $userId): array {
		$out = [];
		$seen = [];
		$this->gather($this->folder($userId), '', $out, $seen);
		foreach ($this->sharedWithMe($userId) as $item) {
			if (isset($seen[$item['id']])) {
				continue;
			}
			$seen[$item['id']] = true;
			$out[] = $item;
		}
		usort($out, static fn ($a, $b) => $b['mtime'] <=> $a['mtime']);
		return $out;
	}

	/** Put a book in another folder, or back at the top with an empty path. */
	public function move(string $userId, int $id, string $path): array {
		$file = $this->file($userId, $id);
		$path = $this->cleanFolder($path);
		$target = $this->folderAt($userId, $path);
		if ($file->getParent()->getId() === $target->getId()) {
			return $this->describe($file, false, $path);
		}
		// Moving is taking it out of one folder and putting it in another, and each
		// half needs its own permission -- which is what Files asks for too (review
		// S6). The move itself would only look at the second.
		if (!$file->isDeletable()) {
			throw new NotPermittedException('this book may not be taken out of the folder it is in');
		}
		if (!$target->isCreatable()) {
			throw new NotPermittedException('that folder is read only');
		}
		// Out of a share that does not allow downloading is out of the share (S3).
		if ($file->getMountPoint()->getMountPoint() !== $target->getMountPoint()->getMountPoint() && !Downloads::allowed($file)) {
			throw new NotPermittedException('whoever shared this book does not allow it to be downloaded');
		}
		$was = $file->getParent();
		$wasCalled = $file->getName();
		$moved = $file->move($target->getPath() . '/' . FileNames::free($target, $this->stripExt($file->getName()), self::EXT));
		$file = $moved instanceof File ? $moved : $this->file($userId, $id);
		// The versions go with it, into the same folder.
		$this->versions->follow($was, $wasCalled, $file);
		return $this->describe($file, false, $path);
	}

	/**
	 * Every book under a folder, with the folder it is in written on it. Only
	 * so deep: a folder inside a folder inside a folder is somebody's file tree,
	 * not a list of books, and walking all of it would read the whole account.
	 *
	 * @param array<int, array<string, mixed>> $out
	 * @param array<int, bool> $seen
	 */
	private function gather(Folder $folder, string $path, array &$out, array &$seen, int $depth = 0): void {
		foreach ($folder->getDirectoryListing() as $node) {
			if ($node instanceof Folder) {
				if ($depth < 4) {
					$this->gather($node, $path === '' ? $node->getName() : $path . '/' . $node->getName(), $out, $seen, $depth + 1);
				}
				continue;
			}
			if (!($node instanceof File) || !$this->isHtml($node->getName()) || isset($seen[$node->getId()])) {
				continue;
			}
			$seen[$node->getId()] = true;
			$out[] = $this->describe($node, false, $path);
		}
	}

	/**
	 * The books other people on this server have shared with this user, whether
	 * they shared one book or a whole folder of them. They are listed under the
	 * name of whoever shared them, because that is how a person looks for them.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function sharedWithMe(string $userId): array {
		$out = [];
		$seen = [];
		$mine = $this->rootFolder->getUserFolder($userId);
		foreach ([IShare::TYPE_USER, IShare::TYPE_GROUP] as $type) {
			foreach ($this->shares->getSharedWith($userId, $type, null, 200) as $share) {
				// The share as this user has it -- where it is in their own Files, and
				// what they may do with it -- not as its owner has it (review S11): the
				// owner's own folders are not this user's to see, and the owner may
				// write in what this user may only read. A share this user declined, or
				// has not yet accepted, is not in their Files, and is not listed.
				$node = null;
				try {
					foreach ($mine->getById($share->getNodeId()) as $candidate) {
						if ($candidate instanceof File || $candidate instanceof Folder) {
							$node = $candidate;
							break;
						}
					}
				} catch (\Throwable) {
					$node = null;
				}
				if ($node === null) {
					continue;
				}
				$owner = $this->nameOf($share->getShareOwner());
				if ($node instanceof Folder) {
					$inside = [];
					$this->gather($node, $node->getName(), $inside, $seen);
					foreach ($inside as $item) {
						$item['owner'] = $owner;
						$item['shared'] = true;
						$out[] = $item;
					}
					continue;
				}
				if (!($node instanceof File) || !$this->isHtml($node->getName()) || isset($seen[$node->getId()])) {
					continue;
				}
				$seen[$node->getId()] = true;
				$item = $this->describe($node, false, '');
				// A book shared on its own keeps the number of the folder it is in on
				// its owner's side (as EditBase): the list files it under "Shared with
				// me" by it, and it is not a folder this user can see.
				try {
					$item['folderId'] = $share->getNode()->getParent()->getId();
				} catch (\Throwable) {
					// kept as this user sees it
				}
				$item['owner'] = $owner;
				$item['shared'] = true;
				$out[] = $item;
			}
		}
		return $out;
	}

	private function nameOf(string $uid): string {
		$user = $this->users->get($uid);
		return $user === null ? $uid : $user->getDisplayName();
	}

	/** A folder path a user typed: no climbing out, no empty parts, not too deep. */
	public function cleanFolder(string $path): string {
		$parts = [];
		foreach (explode('/', str_replace('\\', '/', trim($path))) as $part) {
			$part = trim($part);
			if ($part === '' || $part === '.') {
				continue;
			}
			if ($part === '..' || str_contains($part, "\0")) {
				throw new \InvalidArgumentException('that is not a folder name');
			}
			$parts[] = mb_substr($part, 0, 100);
		}
		return implode('/', array_slice($parts, 0, 5));
	}

	/** @return array<string, mixed> */
	public function get(string $userId, int $id): array {
		$file = $this->file($userId, $id);
		$this->withinSize($userId, $file->getSize());
		return $this->describe($file, true);
	}

	/**
	 * What this writer's books may hold, from the setting "how big a book may be"
	 * (Model::CELL_LIMITS): cells, rows of a sheet, bytes of a file (0: no limit).
	 * "No limit" leaves only the server's own ceilings for what passes through it.
	 *
	 * @return array{cells: int, rows: int, bytes: int}
	 */
	public function limits(string $userId): array {
		$cells = (int)$this->config->getUserValue($userId, Application::APP_ID, 'cellLimit', (string)Model::DEFAULT_CELL_LIMIT);
		if (!in_array($cells, Model::CELL_LIMITS, true)) {
			$cells = Model::DEFAULT_CELL_LIMIT;
		}
		return $cells === 0
			? ['cells' => Model::MAX_CELLS, 'rows' => Cells::MAX_ROWS, 'bytes' => 0]
			: ['cells' => $cells, 'rows' => Model::MAX_ROWS, 'bytes' => Model::MAX_FILE_BYTES];
	}

	/** A book larger than its writer's limit is neither read nor written. */
	private function withinSize(string $userId, int|float|false $bytes): void {
		$max = $this->limits($userId)['bytes'];
		if ($max > 0 && $bytes !== false && $bytes > $max) {
			throw new \InvalidArgumentException('file is larger than ' . (int)($max / 1024 / 1024) . ' MB');
		}
	}

	/**
	 * A new book: an empty one with one sheet unless the browser sends the page
	 * itself (a book made from an import).
	 *
	 * @return array<string, mixed>
	 */
	public function create(string $userId, string $name, string $content, string $path = '', int $folderId = 0): array {
		$this->withinSize($userId, strlen($content));
		$where = '';
		if ($folderId > 0) {
			// A category somebody else shared: it is not inside this user's own save
			// folder, so it is found by its id rather than by a path from there.
			$folder = null;
			foreach ($this->rootFolder->getUserFolder($userId)->getById($folderId) as $node) {
				if ($node instanceof Folder) {
					$folder = $node;
					break;
				}
			}
			if ($folder === null) {
				throw new NotFoundException('that category is not there');
			}
			$where = $folder->getName();
		} else {
			$folder = $this->folderAt($userId, $path);
			$where = $this->cleanFolder($path);
		}
		if (!$folder->isCreatable()) {
			throw new NotPermittedException('that folder is read only');
		}
		$stem = $this->stripExt($this->normaliseName($name));
		if ($content === '') {
			$content = self::blankBook($stem);
		}
		$file = $folder->newFile(FileNames::free($folder, $stem, self::EXT), $content);
		return $this->describe($file, false, $where);
	}

	/**
	 * The page a new book starts as: the workbook file of the design contract (§2),
	 * with one empty sheet. The browser reads attributes and text only, so a
	 * small fixed stylesheet is all that is needed for a browser to show it.
	 */
	public static function blankBook(string $title, string $sheet = 'Sheet1'): string {
		$esc = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
		return "<!DOCTYPE html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">\n"
			. "<meta name=\"generator\" content=\"CalcBase 0.0.1\">\n"
			. "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
			. '<title>' . $esc($title) . "</title>\n"
			. '<style id="cb-style">' . self::BOOK_CSS . "</style>\n</head>\n"
			. "<body class=\"cb-book\" data-active=\"0\">\n"
			. '<section class="cb-sheet" data-name="' . $esc($sheet) . "\" data-grid=\"1\">\n"
			. '<h2 class="cb-sheet-name">' . $esc($sheet) . "</h2>\n"
			. "<table>\n<colgroup></colgroup>\n<tbody>\n</tbody>\n</table>\n</section>\n</body>\n</html>\n";
	}

	/** The fixed stylesheet of a workbook file: sheets as tables, one sheet per printed page group. */
	private const BOOK_CSS = 'body.cb-book{font-family:sans-serif;font-size:11pt;margin:16px}'
		. '.cb-sheet{break-after:page;margin-bottom:24px}.cb-sheet-name{font-size:1.1em;margin:0 0 6px}'
		. '.cb-sheet table{border-collapse:collapse;table-layout:fixed}'
		. '.cb-sheet[data-grid="1"] td{border:1px solid #d0d0d0}'
		. '.cb-sheet td{padding:1px 4px;height:24px;overflow:hidden;white-space:nowrap;vertical-align:bottom}'
		. '.cb-sheet td[data-t="n"]{text-align:right}';

	/**
	 * Write a book back.
	 *
	 * If the writer says which version they started from, and the file has moved
	 * on since -- somebody else writing in the same book -- nothing is written
	 * and the version that is there is handed back instead (stale = true, which
	 * the controller answers with 409), for the browser to take in and try again.
	 * Without that check the last save would quietly throw the other person's
	 * work away.
	 *
	 * @return array<string, mixed>
	 */
	public function save(string $userId, int $id, string $content, string $etag = '', bool $manual = false): array {
		$this->withinSize($userId, strlen($content));
		// The check and the write are one step (review S4). A second save of the
		// same book waits for the first to finish, then looks again at what is
		// there: two writers who both started from the same version used to both
		// pass the check, and the one who wrote last threw the other's work away
		// while both were told their save had gone in.
		return $this->oneAtATime($this->file($userId, $id), function () use ($userId, $id, $content, $etag, $manual): array {
			// Looked up again inside: what was there before the wait may not be there now.
			$file = $this->file($userId, $id);
			if ($etag !== '' && $file->getEtag() !== $etag) {
				$out = $this->describe($file, true);
				$out['stale'] = true;
				return $out;
			}
			// The version is of what is there now, taken before it is written over --
			// on every save, or only on the ones the writer asked for, as they choose.
			$keep = $this->versions->keep($userId);
			if ($keep > 0 && ($manual || $this->versions->when($userId) === 'auto') && $file->getSize() > 0) {
				try {
					$this->versions->take($file, $keep);
				} catch (\Throwable) {
					// A version that cannot be taken must not cost the writer their save.
				}
			}
			$file->putContent($content);
			return $this->describe($file, false);
		});
	}

	/**
	 * Run $write while holding this book against every other write through
	 * CalcBase. Nextcloud's own locking does the holding, under a name of the
	 * app's own, so the file's own locks -- which the write takes -- are left alone.
	 *
	 * @template T
	 * @param callable(): T $write
	 * @return T
	 */
	private function oneAtATime(File $file, callable $write): mixed {
		$key = 'calcbase/save/' . $file->getId();
		$until = microtime(true) + $this->lockWait;
		while (true) {
			try {
				$this->locking->acquireLock($key, ILockingProvider::LOCK_EXCLUSIVE, $file->getName());
				break;
			} catch (LockedException) {
				if (microtime(true) >= $until) {
					throw new \RuntimeException('somebody else is saving this book; try again in a moment');
				}
				usleep(50000);
			}
		}
		try {
			return $write();
		} finally {
			$this->locking->releaseLock($key, ILockingProvider::LOCK_EXCLUSIVE);
		}
	}

	/** The versions kept beside a book, newest first. */
	public function versions(string $userId, int $id): array {
		return $this->versions->list($this->file($userId, $id));
	}

	public function readVersion(string $userId, int $id, int $number): string {
		return $this->versions->read($this->file($userId, $id), $number);
	}

	/** @return array<string, mixed> */
	public function restoreVersion(string $userId, int $id, int $number): array {
		// Putting a version back writes the book, so it waits its turn like a save.
		return $this->oneAtATime($this->file($userId, $id), function () use ($userId, $id, $number): array {
			$this->versions->restore($this->file($userId, $id), $number, $this->versions->keep($userId));
			return $this->describe($this->file($userId, $id), true);
		});
	}

	/** @return array<string, mixed> */
	public function duplicate(string $userId, int $id): array {
		$file = $this->file($userId, $id);
		// A copy in one's own folder is a download by another name (review S3).
		if (!Downloads::allowed($file)) {
			throw new NotPermittedException('whoever shared this book does not allow it to be downloaded');
		}
		$folder = $this->folder($userId);
		$base = $this->stripExt($file->getName());
		$copy = $folder->newFile(FileNames::free($folder, $base . ' (2)', self::EXT), $file->getContent());
		return $this->describe($copy, false);
	}

	/** @return array<string, mixed> */
	public function rename(string $userId, int $id, string $name): array {
		$file = $this->file($userId, $id);
		$target = $this->normaliseName($name);
		if ($target !== $file->getName()) {
			$folder = $file->getParent();
			$was = $file->getName();
			// move() returns the node at its new home; the old handle keeps the old path.
			$moved = $file->move($folder->getPath() . '/' . FileNames::free($folder, $this->stripExt($target), self::EXT));
			if ($moved instanceof File) {
				$file = $moved;
			} else {
				$file = $this->file($userId, $file->getId());
			}
			$this->versions->follow($folder, $was, $file);
		}
		return $this->describe($file, false);
	}

	public function delete(string $userId, int $id): void {
		$file = $this->file($userId, $id);
		// The versions of a book are of that book: they go with it, into the
		// same trash, where they can be fetched back together.
		$this->versions->drop($file);
		$file->delete();
	}

	/**
	 * Resolve a file id inside the user's own storage. Going through the user
	 * folder is what keeps one user's id out of another user's book, and it
	 * also lets a book be opened from anywhere in Files, not just the save
	 * folder -- the folder setting decides where new books are created, not
	 * which ones may be opened.
	 */
	private function file(string $userId, int $id): File {
		$nodes = $this->rootFolder->getUserFolder($userId)->getById($id);
		foreach ($nodes as $node) {
			if ($node instanceof File) {
				if (!$this->isHtml($node->getName())) {
					throw new \InvalidArgumentException('not an HTML book');
				}
				return $node;
			}
		}
		throw new NotFoundException('book ' . $id . ' not found');
	}

	/** @return array<string, mixed> */
	private function describe(File $file, bool $withContent, ?string $folder = null): array {
		$content = $withContent ? $file->getContent() : null;
		$out = [
			'id' => $file->getId(),
			'name' => $file->getName(),
			'title' => $this->stripExt($file->getName()),
			'path' => $file->getPath(),
			'folder' => $folder ?? '',
			'folderId' => $file->getParent()->getId(),
			'size' => $file->getSize(),
			'mtime' => $file->getMTime(),
			'etag' => $file->getEtag(),
			'readOnly' => !$file->isUpdateable(),
			// False for a book whose share does not allow downloading: it can be
			// read and written in, not copied away (S3), and the browser can say so.
			'canDownload' => Downloads::allowed($file),
			'shared' => false,
			'owner' => '',
		];
		if ($withContent) {
			// Whatever the file was written in, the browser is handed UTF-8, and told
			// what it was read as (see TextEncoding).
			$read = TextEncoding::htmlToUtf8((string)$content);
			$out['content'] = $read['text'];
			$out['encoding'] = [
				'read' => $read['encoding'],
				'declared' => $read['declared'],
				'mismatch' => $read['mismatch'],
				'lossy' => $read['lossy'],
			];
		}
		return $out;
	}

	private function isHtml(string $name): bool {
		$lower = strtolower($name);
		return str_ends_with($lower, '.html') || str_ends_with($lower, '.htm');
	}

	private function stripExt(string $name): string {
		return preg_replace('/\.html?$/i', '', $name) ?? $name;
	}

	/** Turn whatever the user typed into one safe file name ending in .html. */
	private function normaliseName(string $name): string {
		$name = FileNames::clean($this->stripExt(trim($name)));
		if ($name === '') {
			$name = 'Book';
		}
		return $name . self::EXT;
	}

	/** A folder setting may nest, but it may not climb out of the user's home. */
	private function isSafePath(string $path): bool {
		foreach (explode('/', $path) as $part) {
			if ($part === '' || $part === '.' || $part === '..' || str_contains($part, "\0")) {
				return false;
			}
		}
		return true;
	}
}
