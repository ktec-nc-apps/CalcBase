<?php
/**
 * Categories: the folders inside the save folder that books are kept in
 * (BookService, as EditBase's DocumentService has them).
 *
 *   - the list names each category with its id and the ids of the books in it,
 *     nested ones by their path, empty ones included;
 *   - a category is made by path, nested ones all the way down; the path is
 *     cleaned (no climbing out, no empty parts);
 *   - only an empty category may be deleted;
 *   - the save folder itself is not a category: no id, no deleting;
 *   - a book can be made in a category somebody else shared, by its id; not in
 *     one that is read only;
 *   - a file where the category should be is said plainly.
 *
 * Run: php tests/folders_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/files_fixture.php';

/** @return array{0: mixed, 1: ?Throwable} */
function tryIt(callable $fn): array {
	try {
		return [$fn(), null];
	} catch (\Throwable $e) {
		return [null, $e];
	}
}

$log = (object)['moved' => [], 'created' => [], 'contents' => [], 'deleted' => []];
$budget = fileStub(['id' => 11, 'name' => 'Budget.html', 'path' => '/bob/files/CalcBase/Work/Budget.html']);
$sales = fileStub(['id' => 12, 'name' => 'Sales.html', 'path' => '/bob/files/CalcBase/Work/2026/Sales.html']);
$readme = fileStub(['id' => 13, 'name' => 'readme.txt', 'path' => '/bob/files/CalcBase/Work/readme.txt', 'mime' => 'text/plain']);
$year = folderStub(['id' => 302, 'name' => '2026', 'path' => '/bob/files/CalcBase/Work/2026', 'children' => ['Sales.html' => $sales]]);
$work = folderStub(['id' => 301, 'name' => 'Work', 'path' => '/bob/files/CalcBase/Work', 'children' => ['Budget.html' => $budget, 'readme.txt' => $readme, '2026' => $year]]);
$deleted = false;
$empty = stub(OCP\Files\Folder::class, [
	'getId' => static fn () => 303, 'getName' => static fn () => 'Empty', 'getPath' => static fn () => '/bob/files/CalcBase/Empty',
	'getDirectoryListing' => static fn () => [], 'delete' => static function () use (&$deleted) { $deleted = true; },
]);
$save = folderStub(['id' => 200, 'name' => 'CalcBase', 'path' => '/bob/files/CalcBase', 'children' => ['Work' => $work, 'Empty' => $empty, 'note.txt' => $readme], 'log' => $log]);
$teamShared = folderStub(['id' => 900, 'name' => 'Team', 'path' => '/bob/files/Team', 'log' => $log]);
$readOnly = folderStub(['id' => 901, 'name' => 'Archive', 'path' => '/bob/files/Archive', 'creatable' => false]);
$home = folderStub(['id' => 1, 'name' => 'files', 'path' => '/bob/files', 'children' => ['CalcBase' => $save], 'byId' => [900 => [$teamShared], 901 => [$readOnly]]]);
$books = books($home);

echo "--- the list ---\n";
$folders = attempt('folders', static fn () => $books->folders('bob')) ?? [];
check('every category, nested ones by path, empty ones too', array_column($folders, 'path') === ['Empty', 'Work', 'Work/2026'], json_encode(array_column($folders, 'path')));
$byPath = array_column($folders, null, 'path');
check('each with its id and the ids of the books in it (not other files)', ($byPath['Work']['id'] ?? 0) === 301 && ($byPath['Work']['books'] ?? null) === [11] && ($byPath['Work/2026']['books'] ?? null) === [12] && ($byPath['Empty']['books'] ?? null) === [], json_encode($folders));
check('each with its own name', ($byPath['Work/2026']['name'] ?? '') === '2026');

echo "--- making one ---\n";
[$made, $e] = tryIt(static fn () => $books->makeFolder('bob', ' /Projects/ 2027 / '));
check('a path is cleaned and the folders made all the way down', $e === null && $made === 'Projects/2027', $e ? $e->getMessage() : (string)$made);
[, $e] = tryIt(static fn () => $books->makeFolder('bob', '../Secret'));
check('climbing out is refused', $e instanceof InvalidArgumentException, $e ? $e->getMessage() : 'made');
[, $e] = tryIt(static fn () => $books->makeFolder('bob', ''));
check('a category needs a name', $e instanceof InvalidArgumentException);
[, $e] = tryIt(static fn () => $books->makeFolder('bob', 'note.txt/Inside'));
check('a file in the way is said plainly', $e instanceof InvalidArgumentException && str_contains($e->getMessage(), 'file called'), $e ? $e->getMessage() : 'made');

echo "--- its id ---\n";
check('a category\'s id', attempt('id', static fn () => $books->folderId('bob', 'Work/2026')) === 302);
[, $e] = tryIt(static fn () => $books->folderId('bob', ''));
check('the save folder itself has no id as a category', $e instanceof InvalidArgumentException);
[, $e] = tryIt(static fn () => $books->folderId('bob', 'note.txt'));
check('a file is not a category', $e instanceof InvalidArgumentException);

echo "--- deleting one ---\n";
[, $e] = tryIt(static fn () => $books->deleteFolder('bob', 'Work'));
check('a category with anything in it is refused', $e instanceof InvalidArgumentException && $e->getMessage() === 'not empty', $e ? $e->getMessage() : 'deleted');
[, $e] = tryIt(static fn () => $books->deleteFolder('bob', 'Empty'));
check('an empty one is deleted', $e === null && $deleted, $e ? $e->getMessage() : 'not deleted');
[, $e] = tryIt(static fn () => $books->deleteFolder('bob', ''));
check('the save folder itself is not deleted', $e instanceof InvalidArgumentException);

echo "--- a book in a shared category ---\n";
[$got, $e] = tryIt(static fn () => $books->create('bob', 'Plan', '', '', 900));
check('made in the shared category, by its id', $e === null && ($got['folder'] ?? '') === 'Team' && $log->created === ['Plan.html'], $e ? $e->getMessage() : json_encode($got));
check('... as a blank book with one sheet', str_contains($log->contents['Plan.html'] ?? '', 'class="cb-sheet"') && str_contains($log->contents['Plan.html'] ?? '', '<title>Plan</title>'));
[, $e] = tryIt(static fn () => $books->create('bob', 'Plan', '', '', 901));
check('not in a read-only one', $e instanceof OCP\Files\NotPermittedException, $e ? get_class($e) : 'made');
[, $e] = tryIt(static fn () => $books->create('bob', 'Plan', '', '', 902));
check('a category that is not there is said so', $e instanceof OCP\Files\NotFoundException, $e ? get_class($e) : 'made');

finish();
