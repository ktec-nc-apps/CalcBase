<?php
/**
 * What the server says when something goes wrong (EditBase review 2026-10-04,
 * 低7 and 低9, carried into CalcBase).
 *
 *   - an exception that is not the app's own is logged and answered with one
 *     plain sentence, not with its own words (which can carry paths and queries);
 *   - the app's own sentences (a plain RuntimeException) still reach the screen;
 *   - a bad request is a 400 with its reason; not found 404; not permitted 403;
 *   - a stale save is a 409 carrying what is there now;
 *   - the save folder cannot be set to the name of a file, nor to a path through
 *     one; and a file put there afterwards is said plainly;
 *   - a new book is the workbook file of the contract, with one empty sheet.
 *
 * Run: php tests/server_errors_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/files_fixture.php';

use OCA\CalcBase\Service\BookService;

class Throwing extends BookService {
	public function __construct(private \Throwable $e) {
	}
	public function versions(string $userId, int $id): array {
		throw $this->e;
	}
	public function save(string $userId, int $id, string $content, string $etag = '', bool $manual = false): array {
		return ['id' => $id, 'etag' => 'E2', 'content' => '<p>theirs</p>', 'stale' => true];
	}
}

echo "--- exceptions on the way out ---\n";
$logged = [];
$logger = stub(Psr\Log\LoggerInterface::class, ['error' => static function ($msg, $ctx = []) use (&$logged) { $logged[] = $msg; }]);
$api = apiController('bob', ['books' => new Throwing(new \Exception('SQLSTATE[42S22]: /var/www/nextcloud/lib/private/DB/x.php')), 'logger' => $logger]);
$r = $api->bookVersions(1);
check('a foreign exception is a 500', $r->getStatus() === 500);
check('... whose own words do not reach the browser', !str_contains(json_encode($r->getData()), 'SQLSTATE') && !str_contains(json_encode($r->getData()), '/var/www'), json_encode($r->getData()));
check('... and is logged', count($logged) === 1 && str_contains($logged[0], 'SQLSTATE'), json_encode($logged));
$logged = [];
$api = apiController('bob', ['books' => new Throwing(new \RuntimeException('somebody else is saving this book; try again in a moment')), 'logger' => $logger]);
$r = $api->bookVersions(1);
check('the app\'s own sentence still reaches the screen', $r->getStatus() === 500 && ($r->getData()['error'] ?? '') === 'somebody else is saving this book; try again in a moment', json_encode($r->getData()));
check('... and is not logged as an error', $logged === []);
$api = apiController('bob', ['books' => new Throwing(new \InvalidArgumentException('that file is not a ZIP archive')), 'logger' => $logger]);
check('a bad request is a 400 with its reason', $api->bookVersions(1)->getStatus() === 400 && str_contains(json_encode($api->bookVersions(1)->getData()), 'ZIP'));
$api = apiController('bob', ['books' => new Throwing(new OCP\Files\NotFoundException('book 1 not found')), 'logger' => $logger]);
check('not found is a 404', $api->bookVersions(1)->getStatus() === 404);
$api = apiController('bob', ['books' => new Throwing(new OCP\Files\NotPermittedException('read only')), 'logger' => $logger]);
check('not permitted is a 403', $api->bookVersions(1)->getStatus() === 403);

echo "--- a stale save ---\n";
$api = apiController('bob', ['books' => new Throwing(new \Exception('unused')), 'logger' => $logger], ['content' => '<p>mine</p>', 'etag' => 'E1']);
$r = $api->saveBook(1);
check('is a 409 carrying what is there now', $r->getStatus() === 409 && ($r->getData()['etag'] ?? '') === 'E2' && ($r->getData()['content'] ?? '') === '<p>theirs</p>', $r->getStatus() . ' ' . json_encode($r->getData()));
$api = apiController('bob', ['books' => new Throwing(new \Exception('unused')), 'logger' => $logger], ['etag' => 'E1']);
check('a save without content is a 400', $api->saveBook(1)->getStatus() === 400);

echo "--- the save folder's name ---\n";
$note = fileStub(['id' => 7, 'name' => 'Notes.html', 'path' => '/bob/files/Notes.html']);
$save = folderStub(['id' => 200, 'name' => 'CalcBase', 'path' => '/bob/files/CalcBase']);
$files = folderStub(['id' => 1, 'name' => 'files', 'path' => '/bob/files', 'children' => ['Notes.html' => $note, 'CalcBase' => $save]]);
$books = books($files);
$refused = static function (callable $fn): ?string {
	try {
		$fn();
		return null;
	} catch (\InvalidArgumentException $e) {
		return $e->getMessage();
	}
};
check('the name of a file is refused', $refused(static fn () => $books->setFolderName('bob', 'Notes.html')) === 'there is a file called Notes.html there already');
check('a path through a file is refused', $refused(static fn () => $books->setFolderName('bob', 'Notes.html/Sub')) === 'there is a file called Notes.html there already');
check('climbing out is refused', $refused(static fn () => $books->setFolderName('bob', '../other')) === 'invalid folder name');
check('a folder is accepted', $refused(static fn () => $books->setFolderName('bob', 'CalcBase')) === null);
check('a folder yet to be made is accepted', $refused(static fn () => $books->setFolderName('bob', 'CalcBase/Budgets')) === null);
$books = books($files, ['config' => stub(OCP\IConfig::class, ['getUserValue' => static fn ($u, $a, $k, $d = '') => $k === 'folder' ? 'Notes.html' : $d])]);
check('a file put where the folder was is said plainly', $refused(static fn () => $books->folder('bob')) === 'there is a file called Notes.html there already');

echo "--- a new book ---\n";
$log = (object)['created' => [], 'contents' => [], 'moved' => []];
$save = folderStub(['id' => 200, 'name' => 'CalcBase', 'path' => '/bob/files/CalcBase', 'log' => $log, 'children' => ['Budget.html' => fileStub(['id' => 5, 'name' => 'Budget.html'])]]);
$files = folderStub(['id' => 1, 'name' => 'files', 'path' => '/bob/files', 'children' => ['CalcBase' => $save]]);
$books = books($files);
$made = attempt('create', static fn () => $books->create('bob', 'Budget', ''));
check('a name already there gets a number', $log->created === ['Budget (2).html'], json_encode($log->created));
$html = $log->contents['Budget (2).html'] ?? '';
check('the file is the workbook of the contract: one empty sheet', str_contains($html, '<body class="cb-book" data-active="0">') && str_contains($html, '<section class="cb-sheet" data-name="Sheet1"') && str_contains($html, '<meta name="generator" content="CalcBase') && str_contains($html, '<title>Budget (2)</title>') === false && str_contains($html, '<title>Budget</title>'), substr($html, 0, 400));
check('the answer names it, with readOnly and canDownload', is_array($made) && $made['name'] === 'Budget (2).html' && $made['readOnly'] === false && $made['canDownload'] === true, json_encode($made));
$log = (object)['created' => [], 'contents' => [], 'moved' => []];
$save = folderStub(['id' => 200, 'name' => 'CalcBase', 'path' => '/bob/files/CalcBase', 'log' => $log]);
$books = books(folderStub(['id' => 1, 'name' => 'files', 'path' => '/bob/files', 'children' => ['CalcBase' => $save]]));
attempt('create with a tricky name', static fn () => $books->create('bob', '../.hidden/<x>&"y".htm', ''));
check('the name is made safe and ends in .html', $log->created === ['hidden&quot;&lt;x&gt;&amp;&quot;y&quot;.html'] || $log->created === ['hidden<x>&"y".html'], json_encode($log->created));
check('the title is escaped in the page', str_contains($log->contents[$log->created[0]] ?? '', '<title>hidden&lt;x&gt;&amp;&quot;y&quot;</title>'), substr($log->contents[$log->created[0]] ?? '', 0, 300));

finish();
