<?php
/**
 * Regression test: two saves of one book at the same moment (review S4).
 *
 * The real BookService::save(). The file is a stand-in that behaves as a
 * Nextcloud file node does -- its etag is what the database said when it was
 * looked up, and writing it moves the etag on -- and Nextcloud's locking is an
 * in-memory stand-in with the same rule: a name held exclusively cannot be taken
 * again until it is let go. Bob's save arrives while Alice's is in the middle of
 * hers (shifting the versions, which is what made the window wide).
 *
 *   - Bob is never told his save went in while his words are not in the file;
 *   - trying again, he is told the book has moved on, and handed Alice's;
 *   - Alice's save goes in;
 *   - nothing is left locked afterwards.
 *
 * Run: php tests/save_race_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';

$disk = (object)['content' => '<table><tr><td>v0</td></tr></table>', 'etag' => 'E0', 'n' => 0];
$parent = stub(OCP\Files\Folder::class, ['getId' => static fn () => 1, 'getPath' => static fn () => '/u/files/CalcBase']);

/** A file node as Nextcloud hands one out. */
function fileNode(object $disk, object $parent): object {
	$seenEtag = $disk->etag;
	return stub(OCP\Files\File::class, [
		'getEtag' => static function () use (&$seenEtag) { return $seenEtag; },
		'putContent' => static function ($c) use (&$seenEtag, $disk) {
			$disk->content = $c;
			$disk->etag = 'E' . (++$disk->n);
			$seenEtag = $disk->etag;
		},
		'getContent' => static fn () => $disk->content,
		'getSize' => static fn () => strlen($disk->content),
		'getName' => static fn () => 'Minutes.html',
		'getId' => static fn () => 42,
		'getPath' => static fn () => '/u/files/CalcBase/Minutes.html',
		'getParent' => static fn () => $parent,
		'getMTime' => static fn () => 0,
		'isUpdateable' => static fn () => true,
	]);
}

class SlowVersions extends OCA\CalcBase\Service\VersionService {
	public $during = null;
	public function __construct() {
	}
	public function keep(string $userId): int {
		return 10;
	}
	public function when(string $userId): string {
		return 'auto';
	}
	public function take(OCP\Files\File $file, int $keep): bool {
		// While this save is shifting #01..#10, another save arrives.
		if ($this->during) {
			$cb = $this->during;
			$this->during = null;
			$cb();
		}
		return true;
	}
}

$held = [];
$locking = stub(OCP\Lock\ILockingProvider::class, [
	'acquireLock' => static function ($path, $type, $readable = null) use (&$held) {
		if (isset($held[$path])) {
			throw new OCP\Lock\LockedException($path);
		}
		$held[$path] = $type;
	},
	'releaseLock' => static function ($path, $type) use (&$held) {
		unset($held[$path]);
	},
	'isLocked' => static fn ($path, $type) => isset($held[$path]),
]);
$versions = new SlowVersions();
$root = stub(OCP\Files\IRootFolder::class, ['getUserFolder' => static fn ($u) => stub(OCP\Files\Folder::class, [
	'getById' => static fn ($id) => [fileNode($GLOBALS['disk'], $GLOBALS['parent'])],
])]);
$svc = build(OCA\CalcBase\Service\BookService::class, [
	'rootFolder' => $root,
	'config' => stub(OCP\IConfig::class),
	'shares' => stub(OCP\Share\IManager::class),
	'users' => stub(OCP\IUserManager::class),
	'versions' => $versions,
	
	'locking' => $locking,
]);
poke($svc, 'lockWait', 0.1);

$bob = null;
$versions->during = static function () use ($svc, &$bob) {
	try {
		$bob = $svc->save('bob', 42, '<table><tr><td>v0</td></tr></table><p>BOB: decision recorded</p>', 'E0');
	} catch (\Throwable $e) {
		$bob = ['error' => $e->getMessage()];
	}
};
$alice = attempt('alice saves', static fn () => $svc->save('alice', 42, '<table><tr><td>v0</td></tr></table><p>ALICE: attendees</p>', 'E0'));
$bobIn = str_contains($disk->content, 'BOB');
$bobToldSaved = is_array($bob) && !isset($bob['error']) && empty($bob['stale']);
check('Bob is not told his save went in while his words are not in the file', !$bobToldSaved || $bobIn, 'Bob was answered ' . json_encode($bob) . '; the file holds ' . $disk->content);
check('Alice\'s save goes in', is_array($alice) && empty($alice['stale']) && str_contains($disk->content, 'ALICE'), $disk->content);
if (!$bobToldSaved) {
	$retry = attempt('bob tries again', static fn () => $svc->save('bob', 42, '<table><tr><td>v0</td></tr></table><p>BOB: decision recorded</p>', 'E0'));
	check('trying again, Bob is told the book has moved on', is_array($retry) && !empty($retry['stale']), json_encode($retry));
	check('... and handed what Alice wrote, to take into his copy', is_array($retry) && str_contains((string)($retry['content'] ?? ''), 'ALICE'), json_encode($retry));
}
check('nothing is left locked', $held === [], json_encode($held));
$later = attempt('a later save', static fn () => $svc->save('bob', 42, '<table><tr><td>v0</td></tr></table><p>ALICE: attendees</p><p>BOB: decision recorded</p>', $disk->etag));
check('a later save from the current version goes in', is_array($later) && empty($later['stale']) && str_contains($disk->content, 'BOB'), $disk->content);

finish();
