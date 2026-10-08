<?php
/**
 * What is read out of the other apps, and how it lands in a sheet (Connectors,
 * SourceSheets), with the other apps' services stood in.
 *
 *   - RegiBase: secret fields and password fields are never in the sheet, nor a
 *     value that arrives encrypted; numbers are numbers, dates serials with a
 *     date format, URLs and e-mails links, attachments their file names; the
 *     field labels are the bold header row; the row limit holds;
 *   - FormulaBase: an expression over number variables becomes a live formula
 *     over the variables' cells, with the value FormulaBase works out; one that
 *     needs a function the engine does not have is written as its value only;
 *   - NetBase: nothing unless NetBase's own permission says yes; then the device
 *     list, never the notes;
 *   - EditBase: a document's tables with their formulas; a document from a share
 *     that forbids downloading is refused; not an HTML file is refused;
 *   - every fragment has the shape {sheets, source:{app, id, name, at}} and
 *     passes the model's own check.
 *
 * Run: php tests/connectors_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/files_fixture.php';

use OCA\CalcBase\Service\Connectors;
use OCA\CalcBase\Service\SourceSheets;

/** Connectors whose other-app services are the stand-ins given, and whose apps are all there. */
final class TestConnectors extends Connectors {
	public array $services = [];
	public array $there = ['regibase' => true, 'formulabase' => true, 'editbase' => true, 'netbase' => true, 'tables' => false, 'contacts' => false, 'calendar' => false];
	public function __construct(array $services, ?object $root = null) {
		$this->services = $services;
		poke($this, 'rootFolder', $root ?? stub(OCP\Files\IRootFolder::class));
		poke($this, 'config', stub(OCP\IConfig::class, ['getUserValue' => static fn ($u, $a, $k, $d = '') => $d]));
	}
	public function available(string $userId): array {
		$out = $this->there;
		if ($out['netbase'] && isset($this->services['netbase.perm'])) {
			$out['netbase'] = $this->services['netbase.perm']->can('devices');
		}
		return $out;
	}
	protected function get(string $class): object {
		$short = substr($class, (int)strrpos($class, '\\') + 1);
		if (!isset($this->services[$short])) {
			throw new LogicException('no stand-in for ' . $class);
		}
		return $this->services[$short];
	}
}

/** An object answering the methods given. */
function obj(array $methods): object {
	return new class($methods) {
		public function __construct(private array $m) {
		}
		public function __call(string $name, array $args): mixed {
			if (!isset($this->m[$name])) {
				throw new LogicException('stand-in has no ' . $name);
			}
			return ($this->m[$name])(...$args);
		}
	};
}

$fragmentOk = static function (string $label, ?array $f, string $app): void {
	check($label . ': the fragment has sheets and a source', is_array($f) && is_array($f['sheets'] ?? null) && ($f['source']['app'] ?? '') === $app && isset($f['source']['id'], $f['source']['name'], $f['source']['at']), json_encode($f['source'] ?? null));
	check($label . ': the cells are a JSON object even when empty', is_array($f) && ($f['sheets'][0]['cells'] ?? null) instanceof stdClass);
};

echo "--- RegiBase ---\n";
$fields = [
	['key' => 'name', 'label' => 'Name', 'type' => 'text', 'secret' => false],
	['key' => 'price', 'label' => 'Price', 'type' => 'number', 'secret' => false],
	['key' => 'since', 'label' => 'Since', 'type' => 'date', 'secret' => false],
	['key' => 'site', 'label' => 'Site', 'type' => 'url', 'secret' => false],
	['key' => 'mail', 'label' => 'Mail', 'type' => 'email', 'secret' => false],
	['key' => 'tel', 'label' => 'Tel', 'type' => 'tel', 'secret' => false],
	['key' => 'memo', 'label' => 'Memo', 'type' => 'text', 'secret' => true],
	['key' => 'pw', 'label' => 'Password', 'type' => 'password', 'secret' => false],
	['key' => 'photo', 'label' => 'Photo', 'type' => 'file', 'secret' => false],
];
$records = [
	['id' => 1, 'data' => ['name' => 'Yamada', 'price' => '1200', 'since' => '2026-10-05', 'site' => 'https://example.com', 'mail' => 'y@example.com', 'tel' => '0982-00-0000', 'memo' => 'TOP SECRET MEMO', 'pw' => 'hunter2', 'photo' => '77']],
	['id' => 2, 'data' => ['name' => 'Sato', 'price' => 'n/a', 'since' => '', 'site' => 'not a url', 'memo' => 'rbenc1:AAAA', 'pw' => 'rbenc1:BBBB', 'photo' => '']],
];
for ($i = 3; $i <= 2500; $i++) {
	$records[] = ['id' => $i, 'data' => ['name' => 'Person ' . $i]];
}
$regibase = obj([
	'listCollections' => static fn ($uid) => [['id' => 9, 'name' => 'Customers', 'icon' => '👤', 'record_count' => 2500]],
	'getCollection' => static function ($uid, $id) use ($fields) {
		if ($id !== 9) {
			throw new OCA\CalcBase\Service\FetchRefused('no');
		}
		return ['id' => 9, 'name' => 'Customers', 'fields' => $fields];
	},
	'listRecords' => static fn ($uid, $id, $q, $sort) => $records,
	'attachmentReader' => static fn ($uid, $cid, $fileId) => 'alice',
]);
$photo = fileStub(['id' => 77, 'name' => 'photo.jpg', 'path' => '/alice/files/RegiBase/photo.jpg']);
$root = stub(OCP\Files\IRootFolder::class, ['getUserFolder' => static fn ($u) => folderStub(['id' => 1, 'name' => 'files', 'path' => '/' . $u . '/files', 'byId' => [77 => [$photo]]])]);
$c = new TestConnectors(['RegiBaseService' => $regibase], $root);
$sources = new SourceSheets($c);
$list = attempt('collections', static fn () => $sources->regibaseCollections('alice'));
check('the collections are listed', ($list['collections'][0]['name'] ?? '') === 'Customers' && ($list['collections'][0]['count'] ?? 0) === 2500, json_encode($list));
$f = attempt('records', static fn () => $sources->regibase('alice', 9));
$fragmentOk('RegiBase', $f, 'regibase');
$cells = (array)($f['sheets'][0]['cells'] ?? []);
$json = json_encode($f);
check('the sheet is named after the collection', ($f['sheets'][0]['name'] ?? '') === 'Customers' && ($f['source']['name'] ?? '') === 'Customers');
check('the header is the labels of the readable fields, bold', ($cells['A1']['v'] ?? '') === 'Name' && ($cells['A1']['s']['b'] ?? 0) === 1 && ($cells['G1']['v'] ?? '') === 'Photo' && !isset($cells['H1']), json_encode(array_map(static fn ($k) => $cells[$k]['v'] ?? null, ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1'])));
check('the secret field and the password field are not in the sheet at all', !str_contains($json, 'TOP SECRET') && !str_contains($json, 'hunter2') && !str_contains($json, 'Memo') && !str_contains($json, 'Password'), $json);
check('an encrypted value is not in it either', !str_contains($json, 'rbenc1'));
check('a number field is a number', ($cells['B2'] ?? null) == ['v' => 1200, 't' => 'n'], json_encode($cells['B2'] ?? null));
check('... and its unreadable value stays text', ($cells['B3'] ?? null) == ['v' => 'n/a', 't' => 's'], json_encode($cells['B3'] ?? null));
check('a date field is a serial with a date format', ($cells['C2'] ?? null) == ['v' => 46300, 't' => 'n', 'fmt' => 'yyyy/mm/dd'], json_encode($cells['C2'] ?? null));
check('a URL is a link', ($cells['D2']['link'] ?? '') === 'https://example.com' && !isset($cells['D3']['link']), json_encode([$cells['D2'] ?? null, $cells['D3'] ?? null]));
check('an e-mail is a mailto link', ($cells['E2']['link'] ?? '') === 'mailto:y@example.com', json_encode($cells['E2'] ?? null));
check('a phone number stays text with its leading zero', ($cells['F2'] ?? null) == ['v' => '0982-00-0000', 't' => 's'], json_encode($cells['F2'] ?? null));
check('an attachment is its file name', ($cells['G2']['v'] ?? '') === 'photo.jpg', json_encode($cells['G2'] ?? null));
check('no more than the row limit of records', isset($cells['A' . (Connectors::ROW_LIMIT + 1)]) && !isset($cells['A' . (Connectors::ROW_LIMIT + 2)]));
$e = null;
try {
	$sources->regibase('alice', 10);
} catch (Throwable $e) {
}
check('a collection RegiBase refuses is refused here too', $e !== null, $e ? get_class($e) : 'handed over');

echo "--- FormulaBase ---\n";
// FormulaBase's own compiler, when it can be read from disk: its output is what is converted.
$fbLib = is_dir('/var/www/nextcloud/apps/formulabase/lib') ? '/var/www/nextcloud/apps/formulabase/lib' : (is_dir('/root/dev/formulabase/lib') ? '/root/dev/formulabase/lib' : '');
if ($fbLib !== '') {
	spl_autoload_register(static function (string $class) use ($fbLib): void {
		if (str_starts_with($class, 'OCA\\FormulaBase\\')) {
			$file = $fbLib . '/' . str_replace('\\', '/', substr($class, strlen('OCA\\FormulaBase\\'))) . '.php';
			if (is_file($file)) {
				require $file;
			}
		}
	});
}
if ($fbLib !== '' && class_exists(OCA\FormulaBase\Service\FormulaCompiler::class)) {
	$compiler = (new ReflectionClass(OCA\FormulaBase\Service\FormulaCompiler::class))->newInstanceWithoutConstructor();
	$formula = static fn (int $id, string $name, string $expr, array $vars, string $unit = '', int $decimals = 2) => obj([
		'getId' => static fn () => $id, 'getName' => static fn () => $name, 'getExpression' => static fn () => $expr,
		'getDescription' => static fn () => 'about ' . $name, 'getResultUnit' => static fn () => $unit, 'getDecimals' => static fn () => $decimals,
		'getVariables' => static fn () => json_encode($vars),
	]);
	$formulas = [
		$formula(1, 'Area', 'w * h', [['key' => 'w', 'label' => 'Width', 'default' => '3', 'unit' => 'm'], ['key' => 'h', 'label' => 'Height', 'default' => '4', 'unit' => 'm']], 'm²'),
		$formula(2, 'Hypotenuse', 'sqrt(a^2 + b^2)', [['key' => 'a', 'default' => '3'], ['key' => 'b', 'default' => '4']]),
		$formula(3, 'Gamma', 'gamma(x)', [['key' => 'x', 'label' => 'x', 'default' => '5']]),
	];
	$c = new TestConnectors([
		'CollectionMapper' => obj(['findAllForUser' => static fn ($uid) => [obj(['getId' => static fn () => 3, 'getName' => static fn () => 'Geometry', 'getIcon' => static fn () => '📐', 'getDescription' => static fn () => ''])],
			'findForUser' => static function ($id, $uid) {
				if ($id !== 3 || $uid !== 'alice') {
					throw new OCP\AppFramework\Db\DoesNotExistException('not yours');
				}
				return obj(['getId' => static fn () => 3, 'getName' => static fn () => 'Geometry']);
			}]),
		'FormulaMapper' => obj(['findForCollection' => static fn ($id) => $formulas]),
		'FormulaCompiler' => $compiler,
	]);
	$sources = new SourceSheets($c);
	$f = attempt('formulas', static fn () => $sources->formulabase('alice', 3));
	$fragmentOk('FormulaBase', $f, 'formulabase');
	$cells = (array)($f['sheets'][0]['cells'] ?? []);
	check('the formula\'s name is bold, its description beside it', ($cells['A1']['s']['b'] ?? 0) === 1 && ($cells['A1']['v'] ?? '') === 'Area' && ($cells['B1']['v'] ?? '') === 'about Area', json_encode([$cells['A1'] ?? null, $cells['B1'] ?? null]));
	check('the expression is written as text', ($cells['B2'] ?? null) == ['v' => 'w * h', 't' => 's'], json_encode($cells['B2'] ?? null));
	check('each variable has a row: label, value, unit', ($cells['A3']['v'] ?? '') === 'Width' && ($cells['B3'] ?? null) == ['v' => 3.0, 't' => 'n'] && ($cells['C3']['v'] ?? '') === 'm' && ($cells['A4']['v'] ?? '') === 'Height', json_encode([$cells['A3'] ?? null, $cells['B3'] ?? null, $cells['C3'] ?? null]));
	check('the result is a live formula over the variables\' cells, with the value worked out', ($cells['B5']['f'] ?? '') === '=B3*B4' && ($cells['B5']['v'] ?? null) == 12 && ($cells['C5']['v'] ?? '') === 'm²', json_encode($cells['B5'] ?? null));
	// The second formula starts after a blank row: row 7 (1-based).
	check('a function the engine has is converted (sqrt, ^)', ($cells['B11']['f'] ?? '') === '=SQRT(POWER(B9;2)+POWER(B10;2))' && ($cells['B11']['v'] ?? null) == 5, json_encode($cells['B11'] ?? null));
	check('a function the engine does not have is written as the value only', !isset($cells['B16']['f']) && is_numeric($cells['B16']['v'] ?? null) && abs(($cells['B16']['v'] ?? 0) - 24) < 1e-9, json_encode($cells['B16'] ?? null));
	$e = null;
	try {
		$sources->formulabase('bob', 3);
	} catch (Throwable $e) {
	}
	check('somebody else\'s collection is refused', $e !== null, $e ? get_class($e) : 'handed over');
} else {
	echo "SKIP  FormulaBase's compiler is not on this machine\n";
}
check('a formula naming an unknown function is known as such', SourceSheets::functionsKnown('=SUM(A1:A3)+IF(B1>0;1;0)') && !SourceSheets::functionsKnown('=GAMMA(B3)') && SourceSheets::functionsKnown('="GAMMA(" & A1'));

echo "--- NetBase ---\n";
$device = static fn (array $j) => obj(['jsonSerialize' => static fn () => $j + ['id' => 1, 'key' => 'k', 'hostname' => '', 'label' => '', 'mac' => '', 'ip' => '', 'vendor' => '', 'type' => '', 'location' => '', 'room' => '', 'firstSeen' => null, 'lastSeen' => null, 'online' => false, 'notes' => 'router password: hunter2']]);
$mapper = obj(['findAll' => static fn ($limit = 5000) => [
	$device(['name' => 'printer', 'ip' => '192.168.0.9', 'mac' => 'AA:BB:CC:DD:EE:FF', 'vendor' => 'RICOH', 'type' => 'printer', 'location' => 'Office', 'room' => '2F', 'firstSeen' => 1791100000, 'lastSeen' => 1791170400, 'online' => true]),
	$device(['name' => 'nas', 'ip' => '192.168.0.10']),
]]);
$allowed = false;
$perm = obj(['can' => static function ($tool) use (&$allowed) { return $tool === 'devices' && $allowed; }]);
$c = new TestConnectors(['DeviceMapper' => $mapper, 'netbase.perm' => $perm]);
$sources = new SourceSheets($c);
check('without NetBase\'s permission the source is not available', $c->available('alice')['netbase'] === false);
$e = null;
try {
	$sources->netbase('alice');
} catch (Throwable $e) {
}
check('... and the device list is refused', $e instanceof InvalidArgumentException, $e ? get_class($e) : 'handed over');
$allowed = true;
$f = attempt('devices', static fn () => $sources->netbase('alice'));
$fragmentOk('NetBase', $f, 'netbase');
$cells = (array)($f['sheets'][0]['cells'] ?? []);
check('the header', ($cells['A1']['v'] ?? '') === 'Name' && ($cells['I1']['v'] ?? '') === 'Online', json_encode($cells['A1'] ?? null));
check('a device row: name, address, vendor, kind, place, when seen, online', ($cells['A2']['v'] ?? '') === 'printer' && ($cells['B2']['v'] ?? '') === '192.168.0.9' && ($cells['D2']['v'] ?? '') === 'RICOH' && ($cells['F2']['v'] ?? '') === 'Office 2F' && ($cells['H2']['fmt'] ?? '') === 'yyyy/mm/dd h:mm' && ($cells['I2'] ?? null) == ['v' => true, 't' => 'b'], json_encode([$cells['F2'] ?? null, $cells['H2'] ?? null, $cells['I2'] ?? null]));
check('the notes are never in the sheet', !str_contains(json_encode($f), 'hunter2'));
check('a device never seen has no dates', !isset($cells['G3']) && !isset($cells['H3']) && ($cells['I3'] ?? null) == ['v' => false, 't' => 'b'], json_encode($cells['I3'] ?? null));

echo "--- EditBase ---\n";
$html = '<html><body><h2>Costs</h2><table><tr><th>Item</th><th>Amount</th></tr><tr><td>Paper</td><td class="eb-al-r">650</td></tr><tr><td>Total</td><td data-eb-formula="=SUM(B2:B2)">650</td></tr></table></body></html>';
$doc = fileStub(['id' => 5, 'name' => 'Costs.html', 'path' => '/alice/files/EditBase/Costs.html', 'content' => $html]);
$noTable = fileStub(['id' => 6, 'name' => 'Letter.html', 'path' => '/alice/files/EditBase/Letter.html', 'content' => '<p>Dear all</p>']);
$notHtml = fileStub(['id' => 7, 'name' => 'notes.txt', 'path' => '/alice/files/notes.txt', 'content' => 'x']);
$hidden = fileStub(['id' => 8, 'name' => 'Shared.html', 'path' => '/alice/files/Team/Shared.html', 'content' => $html, 'storage' => sharedStorage(false), 'mount' => mountAt('/alice/files/Team/')]);
$ebFolder = folderStub(['id' => 20, 'name' => 'EditBase', 'path' => '/alice/files/EditBase', 'children' => ['Costs.html' => $doc, 'Letter.html' => $noTable]]);
$home = folderStub(['id' => 1, 'name' => 'files', 'path' => '/alice/files', 'children' => ['EditBase' => $ebFolder], 'byId' => [5 => [$doc], 6 => [$noTable], 7 => [$notHtml], 8 => [$hidden]]]);
$c = new TestConnectors([], stub(OCP\Files\IRootFolder::class, ['getUserFolder' => static fn ($u) => $home]));
$sources = new SourceSheets($c);
$list = attempt('documents', static fn () => $sources->editbaseDocuments('alice'));
check('the documents are listed from the EditBase folder when EditBase\'s classes are not there', count($list['documents'] ?? []) === 2 && in_array('Costs', array_column($list['documents'], 'name'), true), json_encode($list));
$f = attempt('tables', static fn () => $sources->editbase('alice', 5));
$fragmentOk('EditBase', $f, 'editbase');
$cells = (array)($f['sheets'][0]['cells'] ?? []);
check('the table is a sheet named after its heading, formulas kept', ($f['sheets'][0]['name'] ?? '') === 'Costs' && ($cells['B3']['f'] ?? '') === '=SUM(B2:B2)' && ($cells['B2'] ?? null) == ['v' => 650, 't' => 'n', 's' => ['ha' => 'right']], json_encode($f['sheets'][0] ?? null));
check('the source names the document', ($f['source']['name'] ?? '') === 'Costs' && ($f['source']['id'] ?? 0) === 5);
foreach ([[6, InvalidArgumentException::class, 'a document without a table'], [7, InvalidArgumentException::class, 'a file that is not HTML'], [8, OCP\Files\NotPermittedException::class, 'a document from a share that forbids downloading'], [9, OCP\Files\NotFoundException::class, 'a document that is not there']] as [$id, $class, $label]) {
	$e = null;
	try {
		$sources->editbase('alice', $id);
	} catch (Throwable $e) {
	}
	check($label . ' is refused', $e instanceof $class, $e ? get_class($e) . ': ' . $e->getMessage() : 'handed over');
}

finish();
