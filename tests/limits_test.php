<?php
declare(strict_types=1);
/**
 * CalcBase's limits (owner, 2026-10-06): "large amounts of data are not what
 * CalcBase is for". A book holds 100,000 cells unless its writer chooses more
 * in the settings, at their own risk; while there is a limit a sheet stops at
 * row 30,000 and a file at 24 MB. "No limit" lifts all three.
 *
 * Run: php tests/limits_test.php
 */
require __DIR__ . '/boot.php';

use OCA\CalcBase\Service\BookService;
use OCA\CalcBase\Service\Cells;
use OCA\CalcBase\Service\Model;

$book = static fn (array $at): array => ['sheets' => [['name' => 'S', 'cells' => array_fill_keys($at, ['v' => 'x', 't' => 's'])]], 'active' => 0];
$refused = static function (callable $fn): string {
	try {
		$fn();
		return '';
	} catch (\InvalidArgumentException $e) {
		return $e->getMessage();
	}
};
// A BookService whose writer chose $choice in the settings ('' = never chose).
$books = static function (string $choice): BookService {
	$b = (new ReflectionClass(BookService::class))->newInstanceWithoutConstructor();
	$config = stub(OCP\IConfig::class, ['getUserValue' => static fn ($u, $app, $key, $default = '') => $key === 'cellLimit' && $choice !== '' ? $choice : $default]);
	$p = new ReflectionProperty(BookService::class, 'config');
	$p->setAccessible(true);
	$p->setValue($b, $config);
	return $b;
};

echo "--- the setting ---\n";
check('never chosen: 100,000 cells, 30,000 rows, 24 MB', $books('')->limits('bob') === ['cells' => 100000, 'rows' => 30000, 'bytes' => 24 * 1024 * 1024]);
check('600,000 chosen: kept, with the rows and the size', $books('600000')->limits('bob') === ['cells' => 600000, 'rows' => 30000, 'bytes' => 24 * 1024 * 1024]);
check('no limit: only the server\'s own ceilings', $books('0')->limits('bob') === ['cells' => Model::MAX_CELLS, 'rows' => Cells::MAX_ROWS, 'bytes' => 0]);
check('a value that is not a choice: the default', $books('5')->limits('bob')['cells'] === 100000);

echo "--- what a model may hold ---\n";
check('row 30,000 is kept', $refused(fn () => Model::clean($book(['A30000']), 100000, 30000)) === '');
$said = $refused(fn () => Model::clean($book(['ZZ30001']), 100000, 30000));
check('row 30,001 is refused, in words the page translates', $said === 'a sheet may have at most 30000 rows', $said);
$said = $refused(fn () => Model::clean($book(['A1', 'A2', 'A3']), 2, 30000));
check('one cell more than the limit is refused', $said === 'a workbook may have at most 2 cells', $said);
check('with no limit, row 30,001 is kept', $refused(fn () => Model::clean($book(['A30001']))) === '');

echo "--- size ---\n";
$within = static function (BookService $b, int $bytes) use ($refused): string {
	$m = new ReflectionMethod(BookService::class, 'withinSize');
	$m->setAccessible(true);
	return $refused(fn () => $m->invoke($b, 'bob', $bytes));
};
check('a book over 24 MB is refused', $within($books(''), 24 * 1024 * 1024 + 1) === 'file is larger than 24 MB');
check('... and through save itself', $refused(fn () => $books('')->save('bob', 1, str_repeat('x', 24 * 1024 * 1024 + 1))) === 'file is larger than 24 MB');
check('with no limit, a 30 MB book is not refused', $within($books('0'), 30 * 1024 * 1024) === '');

echo "--- the page says the same ---\n";
$js = (string)file_get_contents(__DIR__ . '/../js/calcbase.js');
check('the page\'s choices are Model::CELL_LIMITS', str_contains($js, 'const CELL_LIMITS = [' . implode(', ', Model::CELL_LIMITS) . '];'));
check('the page\'s rows and size while limited are the server\'s', str_contains($js, 'LIMIT_ROWS = n ? ' . Model::MAX_ROWS . ' : MAX_ROWS;') && str_contains($js, 'LIMIT_BYTES = n ? ' . (Model::MAX_FILE_BYTES / 1024 / 1024) . ' * 1024 * 1024 : Infinity;'));
check('the server\'s two messages are translated in the page', str_contains($js, '/^a sheet may have at most (\\d+) rows$/') && str_contains($js, '/^a workbook may have at most (\\d+) cells$/'));

finish();
