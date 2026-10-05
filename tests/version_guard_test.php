<?php
/**
 * Regression test: a version is a copy, and it is only taken where a copy may be
 * kept -- and putting a version back never writes over a book whose present
 * state could not be kept (review 2026-10-04, 中2 and 中3).
 *
 *   - a book from a share that does not allow downloading: no version;
 *   - a book shared on its own (its own mount point, parent = the reader's
 *     home folder): no version in the reader's home;
 *   - versions switched off (keep 0): putting one back is refused, the book
 *     is unchanged;
 *   - the row held by another book's version: refused, unchanged;
 *   - an ordinary book: taken and put back as before.
 *
 * Run: php tests/version_guard_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/files_fixture.php';

use OC\FilesMetadata\Model\FilesMetadata;
use OCA\CalcBase\Service\VersionService;
use OCP\Files\NotPermittedException;

/** An in-memory folder whose files can say where they are mounted and on what storage. */
final class GuardFolder {
	public array $files = [];   // name => ['id' => int, 'content' => string, 'storage' => ?object, 'mount' => ?object]
	private static int $next = 500;
	public object $node;

	public function __construct(public string $path, public int $id, ?object $storage = null) {
		$self = $this;
		$this->node = stub(OCP\Files\Folder::class, [
			'getId' => static fn () => $self->id,
			'getPath' => static fn () => $self->path,
			'getStorage' => static fn () => $storage ?? homeStorage(),
			'nodeExists' => static fn ($name) => isset($self->files[$name]),
			'get' => static function ($name) use ($self) {
				if (!isset($self->files[$name])) {
					throw new OCP\Files\NotFoundException($name);
				}
				return $self->file($name);
			},
			'newFile' => static function ($name, $content = null) use ($self) {
				if (isset($self->files[$name])) {
					throw new NotPermittedException('exists: ' . $name);
				}
				$self->files[$name] = ['id' => self::$next++, 'content' => (string)$content];
				return $self->file($name);
			},
		]);
	}

	public function add(string $name, string $content, ?int $id = null, ?object $storage = null, ?object $mount = null): object {
		$this->files[$name] = ['id' => $id ?? self::$next++, 'content' => $content, 'storage' => $storage, 'mount' => $mount];
		return $this->file($name);
	}

	public function file(string $name): object {
		$self = $this;
		$id = $this->files[$name]['id'];
		$here = static function () use ($self, $id): ?string {
			foreach ($self->files as $n => $f) {
				if ($f['id'] === $id) {
					return $n;
				}
			}
			return null;
		};
		return stub(OCP\Files\File::class, [
			'getId' => static fn () => $id,
			'getName' => static fn () => $here() ?? $name,
			'getPath' => static fn () => $self->path . '/' . ($here() ?? $name),
			'getParent' => static fn () => $self->node,
			'getStorage' => static fn () => $self->files[$here()]['storage'] ?? homeStorage(),
			'getMountPoint' => static fn () => $self->files[$here()]['mount'] ?? mountAt('/bob/'),
			'getContent' => static fn () => $self->files[$here()]['content'] ?? '',
			'getSize' => static fn () => strlen($self->files[$here()]['content'] ?? ''),
			'getMTime' => static fn () => 0,
			'putContent' => static function ($c) use ($self, $here) { $self->files[$here()]['content'] = (string)$c; },
			'delete' => static function () use ($self, $here) { unset($self->files[$here()]); },
			'move' => static function ($to) use ($self, $here) {
				$from = $here();
				$name = basename($to);
				$self->files[$name] = $self->files[$from];
				unset($self->files[$from]);
				return $self->file($name);
			},
		]);
	}

	/** @return list<string> */
	public function versions(): array {
		$out = array_values(array_filter(array_keys($this->files), static fn ($n) => str_contains($n, '.#')));
		sort($out);
		return $out;
	}
}

$meta = [];
$metadata = stub(OCP\FilesMetadata\IFilesMetadataManager::class, [
	'getMetadata' => static function (int $id, bool $generate = false) use (&$meta) {
		if (isset($meta[$id])) {
			return $meta[$id];
		}
		if ($generate) {
			return new FilesMetadata($id);
		}
		throw new OCP\FilesMetadata\Exceptions\FilesMetadataNotFoundException();
	},
	'saveMetadata' => static function ($m) use (&$meta) { $meta[$m->getFileId()] = $m; },
]);
$mark = static function (int $versionId, int $of) use (&$meta): void {
	$m = new FilesMetadata($versionId);
	$m->setInt('calcbase-version-of', $of);
	$meta[$versionId] = $m;
};
$versions = build(VersionService::class, ['rootFolder' => stub(OCP\Files\IRootFolder::class), 'config' => stub(OCP\IConfig::class), 'metadata' => $metadata]);

/** @return array{0: mixed, 1: ?Throwable} */
function tryIt(callable $fn): array {
	try {
		return [$fn(), null];
	} catch (\Throwable $e) {
		return [null, $e];
	}
}

echo "--- a share that does not allow downloading ---\n";
$shared = sharedStorage(false);
$team = new GuardFolder('/bob/files/Team', 100, $shared);
$doc = $team->add('Salaries.html', '<p>now</p>', 42, $shared, mountAt('/bob/files/Team/'));
$team->add('Salaries.#01', '<p>before</p>', 43, $shared, mountAt('/bob/files/Team/'));
$taken = attempt('take', static fn () => $versions->take($doc, 10));
check('no version is taken', $taken === false && $team->versions() === ['Salaries.#01'], json_encode($team->versions()));
[, $e] = tryIt(static fn () => $versions->restore($doc, 1, 10));
check('putting one back is refused', $e instanceof NotPermittedException, $e ? get_class($e) . ': ' . $e->getMessage() : 'no refusal');
check('... and the book is unchanged', $team->files['Salaries.html']['content'] === '<p>now</p>', $team->files['Salaries.html']['content']);

echo "--- a book shared on its own ---\n";
$home = new GuardFolder('/bob/files', 1);
$alone = $home->add('Report.html', '<p>theirs</p>', 44, sharedStorage(null), mountAt('/bob/files/Report.html/'));
$taken = attempt('take', static fn () => $versions->take($alone, 10));
check('no version lands in the reader\'s home folder', $taken === false && $home->versions() === [], json_encode($home->versions()));

echo "--- versions switched off ---\n";
$mine = new GuardFolder('/bob/files/CalcBase', 200);
$memo = $mine->add('Memo.html', '<p>now</p>', 45);
$mine->add('Memo.#01', '<p>before</p>', 46);
check('take() says no', $versions->take($memo, 0) === false);
[, $e] = tryIt(static fn () => $versions->restore($memo, 1, 0));
check('putting one back is refused, saying why', $e instanceof NotPermittedException && str_contains($e->getMessage(), 'switched off'), $e ? $e->getMessage() : 'no refusal');
check('... and the book is unchanged', $mine->files['Memo.html']['content'] === '<p>now</p>');

echo "--- the row held by another book's version ---\n";
$row = new GuardFolder('/bob/files/CalcBase/Row', 300);
$rep = $row->add('Report.html', '<p>now</p>', 47);
$row->add('Report.#01', '<p>before</p>', 48);
$mark(48, 47);
$row->add('Report.#02', '<p>somebody else\'s</p>', 49);
$mark(49, 77);
check('take() says no', $versions->take($rep, 10) === false && $row->files['Report.#01']['content'] === '<p>before</p>');
[, $e] = tryIt(static fn () => $versions->restore($rep, 1, 10));
check('putting one back is refused', $e instanceof NotPermittedException, $e ? get_class($e) . ': ' . $e->getMessage() : 'no refusal');
check('... and the book is unchanged', $row->files['Report.html']['content'] === '<p>now</p>');

echo "--- an ordinary book ---\n";
$ok = new GuardFolder('/bob/files/CalcBase/Ok', 400);
$plain = $ok->add('Plain.html', '<p>now</p>', 50);
check('take() says yes and writes #01', $versions->take($plain, 10) === true && ($ok->files['Plain.#01']['content'] ?? '') === '<p>now</p>');
$plain->putContent('<p>later</p>');
[$back, $e] = tryIt(static fn () => $versions->restore($plain, 1, 10));
check('a version is put back', $e === null && $back === '<p>now</p>' && $ok->files['Plain.html']['content'] === '<p>now</p>', $e ? $e->getMessage() : '');
check('... and what was there is kept as #01', ($ok->files['Plain.#01']['content'] ?? '') === '<p>later</p>' && ($ok->files['Plain.#02']['content'] ?? '') === '<p>now</p>', json_encode($ok->versions()));

finish();
