<?php
/**
 * Stand-ins for Nextcloud file nodes, shared by the tests about moving, copying
 * and listing books. Only what the services under test ask of a node is
 * answered; everything else is an empty default. (EditBase's, with books.)
 */
declare(strict_types=1);

/** A mount point, as $node->getMountPoint() hands one out. */
function mountAt(string $point): object {
	return stub(OCP\Files\Mount\IMountPoint::class, ['getMountPoint' => static fn () => $point]);
}

/**
 * The storage of a received share. $download false is "hide download" (the
 * share attribute permissions.download); null leaves the attribute unset.
 */
function sharedStorage(?bool $download): object {
	$attributes = $download === null ? null : stub(OCP\Share\IAttributes::class, [
		'getAttribute' => static fn ($scope, $key) => ($scope === 'permissions' && $key === 'download') ? $download : null,
	]);
	$share = stub(OCP\Share\IShare::class, ['getAttributes' => static fn () => $attributes]);
	return stub(OCP\Files\Storage\ISharedStorage::class, [
		'instanceOfStorage' => static fn ($class) => is_a(OCP\Files\Storage\ISharedStorage::class, $class, true),
		'getShare' => static fn () => $share,
	]);
}

/** The storage of one's own files. */
function homeStorage(): object {
	return stub(OCP\Files\Storage\IStorage::class, ['instanceOfStorage' => static fn ($class) => false]);
}

/**
 * A file. $o: id, name, path, content, parent, storage, mount, deletable,
 * updateable, mime, and 'moved' / 'log' to record what was done to it.
 */
function fileStub(array $o): object {
	$o += ['id' => 42, 'name' => 'Book.html', 'content' => '<p>hello</p>', 'deletable' => true, 'updateable' => true, 'mime' => 'text/html'];
	$o['path'] ??= '/bob/files/' . $o['name'];
	return stub(OCP\Files\File::class, [
		'getId' => static fn () => $o['id'],
		'getName' => static fn () => $o['name'],
		'getPath' => static fn () => $o['path'],
		'getContent' => static fn () => $o['content'],
		'getSize' => static fn () => strlen($o['content']),
		'getMTime' => static fn () => 0,
		'getEtag' => static fn () => 'E' . $o['id'],
		'getMimeType' => static fn () => $o['mime'],
		'isDeletable' => static fn () => $o['deletable'],
		'isUpdateable' => static fn () => $o['updateable'],
		'getParent' => static fn () => $o['parent'] ?? folderStub(['id' => 1]),
		'getStorage' => static fn () => $o['storage'] ?? homeStorage(),
		'getMountPoint' => static fn () => $o['mount'] ?? mountAt('/bob/'),
		'move' => static function ($to) use ($o) {
			if (isset($o['log'])) {
				$o['log']->moved[] = $to;
			}
			return fileStub(['path' => $to, 'name' => basename($to)] + $o);
		},
	]);
}

/** A folder. $o: id, name, path, children (name => node), creatable, mount, storage, log. */
function folderStub(array $o): object {
	$o += ['id' => 1, 'name' => 'Folder', 'children' => [], 'creatable' => true];
	$o['path'] ??= '/bob/files/' . $o['name'];
	return stub(OCP\Files\Folder::class, [
		'getId' => static fn () => $o['id'],
		'getName' => static fn () => $o['name'],
		'getPath' => static fn () => $o['path'],
		'isCreatable' => static fn () => $o['creatable'],
		'getMountPoint' => static fn () => $o['mount'] ?? mountAt('/bob/'),
		'getStorage' => static fn () => $o['storage'] ?? homeStorage(),
		'nodeExists' => static fn ($name) => isset($o['children'][$name]),
		'get' => static function ($name) use ($o) {
			if (!isset($o['children'][$name])) {
				throw new OCP\Files\NotFoundException($name);
			}
			return $o['children'][$name];
		},
		'getDirectoryListing' => static fn () => array_values($o['children']),
		'newFile' => static function ($name, $content = null) use ($o) {
			if (isset($o['log'])) {
				$o['log']->created[] = $name;
				$o['log']->contents[$name] = (string)$content;
			}
			return fileStub(['id' => 999, 'name' => $name, 'path' => $o['path'] . '/' . $name, 'content' => (string)$content]);
		},
		'newFolder' => static fn ($name) => folderStub(['name' => $name, 'path' => $o['path'] . '/' . $name]),
		'getById' => static fn ($id) => $o['byId'][$id] ?? [],
	]);
}

/** A BookService over one user's folder, with versions that do nothing. */
function books(object $userFolder, array $extra = []): OCA\CalcBase\Service\BookService {
	$versions = new class extends OCA\CalcBase\Service\VersionService {
		public function __construct() {
		}
		public function follow(OCP\Files\Folder $wasIn, string $wasCalled, OCP\Files\File $file): void {
		}
		public function drop(OCP\Files\File $file): void {
		}
	};
	return build(OCA\CalcBase\Service\BookService::class, $extra + [
		'rootFolder' => stub(OCP\Files\IRootFolder::class, ['getUserFolder' => static fn ($u) => $userFolder]),
		'config' => stub(OCP\IConfig::class, ['getUserValue' => static fn ($u, $a, $k, $d = '') => $d]),
		'shares' => stub(OCP\Share\IManager::class),
		'users' => stub(OCP\IUserManager::class),
		'versions' => $versions,
		'locking' => stub(OCP\Lock\ILockingProvider::class),
	]);
}
