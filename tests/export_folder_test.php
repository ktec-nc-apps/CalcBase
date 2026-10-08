<?php
/**
 * Where an export goes (CalcBase BUGS #2): beside the book it was made from.
 *
 * The screen names the book's folder as Nextcloud does -- the book's path less
 * its name, "/bob/files/CalcBase/Work" -- and that was taken for a category
 * name: every CSV/ODS/XLSX went into a folder made for it inside the save
 * folder, CalcBase/bob/files/CalcBase/Work/, and the answer named the file by
 * the server's inner path.
 *
 *   - a book in the save folder, in a category, in a folder somebody shared:
 *     the export is beside it, and nothing is made on the way;
 *   - a category of the save folder ("Work", "") still works as before;
 *   - a folder that has gone since the book was opened: the save folder;
 *   - the answer says where it went from the top of the person's Files
 *     ("CalcBase/Work/Budget.ods"), not as /bob/files/…
 *
 * Run: php tests/export_folder_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/files_fixture.php';

use OCA\CalcBase\Service\FileBrowser;
use OCA\CalcBase\Service\ImportExport;

$made = [];
/** A folder that records what is made in it, and every folder made anywhere. */
function place(string $path, array $children = [], bool $creatable = true): object {
	global $made;
	$name = basename($path);
	return stub(OCP\Files\Folder::class, [
		'getId' => static fn () => crc32($path),
		'getName' => static fn () => $name,
		'getPath' => static fn () => $path,
		'isCreatable' => static fn () => $creatable,
		'nodeExists' => static fn ($n) => isset($children[$n]),
		'get' => static function ($n) use ($children) {
			if (!isset($children[$n])) {
				throw new OCP\Files\NotFoundException($n);
			}
			return $children[$n];
		},
		'getDirectoryListing' => static fn () => array_values($children),
		'newFile' => static fn ($n, $content = null) => fileStub(['id' => 999, 'name' => $n, 'path' => $path . '/' . $n, 'content' => (string)$content]),
		'newFolder' => static function ($n) use ($path) {
			global $made;
			$made[] = $path . '/' . $n;
			return place($path . '/' . $n);
		},
	]);
}

$work = place('/bob/files/CalcBase/Work');
$save = place('/bob/files/CalcBase', ['Work' => $work]);
$team = place('/bob/files/Team');
$archive = place('/bob/files/Archive', [], false);
$home = place('/bob/files', ['CalcBase' => $save, 'Team' => $team, 'Archive' => $archive]);
$books = books($home);
$formats = new ImportExport(build(FileBrowser::class, ['rootFolder' => stub(OCP\Files\IRootFolder::class, ['getUserFolder' => static fn ($u) => $home])]), $books);
$model = ['sheets' => [['name' => 'S', 'cells' => ['A1' => ['v' => 1, 't' => 'n']]]], 'active' => 0];

/** @return array{0: mixed, 1: ?Throwable} */
function tryIt(callable $fn): array {
	try {
		return [$fn(), null];
	} catch (\Throwable $e) {
		return [null, $e];
	}
}

echo "--- the book's own folder, as the screen names it ---\n";
foreach ([
	['a book in the save folder', '/bob/files/CalcBase', 'ods', 'CalcBase/Budget.ods'],
	['a book in a category', '/bob/files/CalcBase/Work', 'xlsx', 'CalcBase/Work/Budget.xlsx'],
	['a book in a folder somebody shared, outside the save folder', '/bob/files/Team', 'csv', 'Team/Budget.csv'],
	['a book at the top of the Files', '/bob/files', 'ods', 'Budget.ods'],
] as [$label, $folder, $fmt, $where]) {
	$made = [];
	[$got, $e] = tryIt(static fn () => $formats->export('bob', $fmt, $model, $folder, 'Budget'));
	check($label . ': written beside it', $e === null && ($got['path'] ?? '') === '/bob/files/' . $where, $e ? get_class($e) . ': ' . $e->getMessage() : (string)($got['path'] ?? ''));
	check($label . ': no folder made on the way', $made === [], json_encode($made));
	check($label . ': the answer says ' . $where, ($got['where'] ?? '') === $where, json_encode($got['where'] ?? null));
}

echo "--- a category of the save folder, as before ---\n";
$made = [];
[$got, $e] = tryIt(static fn () => $formats->export('bob', 'ods', $model, 'Work', 'Plan'));
check('"Work" is the category Work', $e === null && ($got['path'] ?? '') === '/bob/files/CalcBase/Work/Plan.ods' && $made === [], $e ? $e->getMessage() : json_encode([$got['path'] ?? null, $made]));
[$got, $e] = tryIt(static fn () => $formats->export('bob', 'ods', $model, '', 'Plan'));
check('"" is the save folder', $e === null && ($got['path'] ?? '') === '/bob/files/CalcBase/Plan.ods', $e ? $e->getMessage() : (string)($got['path'] ?? ''));

echo "--- what is not there, or may not be written in ---\n";
$made = [];
[$got, $e] = tryIt(static fn () => $formats->export('bob', 'ods', $model, '/bob/files/CalcBase/Gone', 'Plan'));
check('a folder gone since: the save folder, nothing made', $e === null && ($got['path'] ?? '') === '/bob/files/CalcBase/Plan.ods' && $made === [], $e ? $e->getMessage() : json_encode([$got['path'] ?? null, $made]));
[, $e] = tryIt(static fn () => $formats->export('bob', 'ods', $model, '/bob/files/Archive', 'Plan'));
check('a read-only folder is refused, not written round', $e instanceof OCP\Files\NotPermittedException, $e ? get_class($e) : 'written');
[, $e] = tryIt(static fn () => $formats->export('bob', 'ods', $model, '/bob/files/../alice/files', 'Plan'));
check('climbing out is refused', $e instanceof InvalidArgumentException, $e ? get_class($e) : 'written');

finish();
