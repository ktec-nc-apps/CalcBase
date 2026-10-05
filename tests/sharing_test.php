<?php
/**
 * Books from other people's shares (EditBase reviews S3 and S6, carried into
 * CalcBase).
 *
 *   - a share that does not allow downloading ("hide download"): the book still
 *     opens and says so; it is not copied into the reader's own folder, not
 *     moved out of the share, and a CSV/ODS/XLSX from it is not imported;
 *   - moving asks for both halves: out of a folder one may not delete from, or
 *     into one that may not be written in, nothing moves;
 *   - where both are allowed, it moves and the versions follow;
 *   - an export into a read-only folder is refused.
 *
 * Run: php tests/sharing_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/files_fixture.php';

use OCA\CalcBase\Service\FileBrowser;
use OCA\CalcBase\Service\ImportExport;

/** @return array{0: mixed, 1: ?Throwable} */
function tryIt(callable $fn): array {
	try {
		return [$fn(), null];
	} catch (\Throwable $e) {
		return [null, $e];
	}
}
$refused = static fn (?Throwable $e): bool => $e instanceof OCP\Files\NotPermittedException;

/** Bob's Files, with a folder Alice shared; $download is that share's download permission. */
function bobsFiles(?bool $download, object $log, bool $deletable = true, bool $creatable = true): object {
	$mine = folderStub(['id' => 300, 'name' => 'Mine', 'path' => '/bob/files/CalcBase/Mine', 'log' => $log, 'creatable' => $creatable]);
	$save = folderStub(['id' => 200, 'name' => 'CalcBase', 'path' => '/bob/files/CalcBase', 'children' => ['Mine' => $mine], 'log' => $log]);
	$storage = sharedStorage($download);
	$team = folderStub(['id' => 100, 'name' => 'Team', 'path' => '/bob/files/Team', 'mount' => mountAt('/bob/files/Team/'), 'storage' => $storage]);
	$in = ['parent' => $team, 'mount' => mountAt('/bob/files/Team/'), 'storage' => $storage, 'log' => $log, 'deletable' => $deletable];
	$book = fileStub(['id' => 42, 'name' => 'Salaries.html', 'path' => '/bob/files/Team/Salaries.html', 'content' => '<table><tr><td>confidential</td></tr></table>'] + $in);
	$csv = fileStub(['id' => 77, 'name' => 'pay.csv', 'path' => '/bob/files/Team/pay.csv', 'content' => "a,b\n1,2\n", 'mime' => 'text/csv'] + $in);
	return folderStub(['id' => 1, 'name' => 'files', 'path' => '/bob/files', 'children' => ['CalcBase' => $save], 'byId' => [42 => [$book], 77 => [$csv]]]);
}

echo "--- a share that does not allow downloading ---\n";
$log = (object)['moved' => [], 'created' => [], 'contents' => []];
$files = bobsFiles(false, $log);
$books = books($files);
$browser = build(FileBrowser::class, ['rootFolder' => stub(OCP\Files\IRootFolder::class, ['getUserFolder' => static fn ($u) => $files])]);
$formats = new ImportExport($browser, $books);

[$got, $e] = tryIt(static fn () => $books->get('bob', 42));
check('the book still opens', $e === null && str_contains((string)($got['content'] ?? ''), 'confidential'), $e ? $e->getMessage() : '');
check('... and says it may not be downloaded', is_array($got) && ($got['canDownload'] ?? null) === false, json_encode($got['canDownload'] ?? 'missing'));
[, $e] = tryIt(static fn () => $books->duplicate('bob', 42));
check('it is not copied into the reader\'s own folder', $refused($e) && $log->created === [], ($e ? $e->getMessage() : 'no refusal') . ' created: ' . json_encode($log->created));
[, $e] = tryIt(static fn () => $books->move('bob', 42, 'Mine'));
check('it is not moved out of the share', $refused($e) && $log->moved === [], ($e ? $e->getMessage() : 'no refusal') . ' moved: ' . json_encode($log->moved));
[$got, $e] = tryIt(static fn () => $formats->import('bob', 77));
check('a CSV from it is not made into a book', $refused($e) && !isset($got['model']), $e ? $e->getMessage() : 'handed over');

echo "--- a share that allows downloading ---\n";
$log = (object)['moved' => [], 'created' => [], 'contents' => []];
$files = bobsFiles(null, $log);
$books = books($files);
$browser = build(FileBrowser::class, ['rootFolder' => stub(OCP\Files\IRootFolder::class, ['getUserFolder' => static fn ($u) => $files])]);
$formats = new ImportExport($browser, $books);
[$got, $e] = tryIt(static fn () => $books->duplicate('bob', 42));
check('it is copied as before', $e === null && $log->created === ['Salaries (2).html'], $e ? $e->getMessage() : json_encode($log->created));
[$got, $e] = tryIt(static fn () => $books->move('bob', 42, 'Mine'));
check('it is moved as before', $e === null && $log->moved === ['/bob/files/CalcBase/Mine/Salaries.html'], $e ? $e->getMessage() : json_encode($log->moved));
[$got, $e] = tryIt(static fn () => $formats->import('bob', 77));
check('a CSV from it is made into a book', $e === null && ($got['model']['sheets'][0]['cells']->B2['v'] ?? null) === 2 && ($got['name'] ?? '') === 'pay' && ($got['format'] ?? '') === 'csv', $e ? $e->getMessage() : json_encode($got));

echo "--- both halves of a move ---\n";
$cases = [
	['a book that may not be deleted from its shared folder is not moved', false, true, false],
	['a book is not moved into a folder that may not be written in', true, false, false],
	['a book that may be moved is moved', true, true, true],
];
foreach ($cases as [$name, $deletable, $creatable, $shouldMove]) {
	$log = (object)['moved' => [], 'created' => [], 'contents' => []];
	$svc = books(bobsFiles(null, $log, $deletable, $creatable));
	[, $e] = tryIt(static fn () => $svc->move('bob', 42, 'Mine'));
	if ($shouldMove) {
		check($name, $e === null && $log->moved === ['/bob/files/CalcBase/Mine/Salaries.html'], ($e ? get_class($e) . ': ' . $e->getMessage() : '') . ' moved: ' . json_encode($log->moved));
	} else {
		check($name, $log->moved === [] && $refused($e), ($e ? get_class($e) . ': ' . $e->getMessage() : 'no refusal') . ' moved: ' . json_encode($log->moved));
	}
}

echo "--- export ---\n";
$log = (object)['moved' => [], 'created' => [], 'contents' => []];
$files = bobsFiles(null, $log, true, false);
$books = books($files);
$formats = new ImportExport(build(FileBrowser::class, ['rootFolder' => stub(OCP\Files\IRootFolder::class, ['getUserFolder' => static fn ($u) => $files])]), $books);
$model = ['sheets' => [['name' => 'S', 'cells' => ['A1' => ['v' => 1, 't' => 'n']]]], 'active' => 0];
[, $e] = tryIt(static fn () => $formats->export('bob', 'csv', $model, 'Mine', 'out'));
check('into a read-only folder is refused', $refused($e) && $log->created === [], $e ? $e->getMessage() : 'no refusal');
[$got, $e] = tryIt(static fn () => $formats->export('bob', 'xlsx', $model, '', 'out'));
check('into the save folder it is written, named after the format', $e === null && $log->created === ['out.xlsx'] && ($got['name'] ?? '') === 'out.xlsx', $e ? $e->getMessage() : json_encode($log->created));
[, $e] = tryIt(static fn () => $formats->export('bob', 'pdf', $model, '', 'out'));
check('an unknown format is a bad request', $e instanceof \InvalidArgumentException, $e ? get_class($e) : 'no refusal');

finish();
