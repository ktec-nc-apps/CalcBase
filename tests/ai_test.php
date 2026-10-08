<?php
/**
 * The AI assistant's rules on the server (AiService, AiScenario):
 *
 *   - off unless the administrator switched it on; off without AI-Hub;
 *   - groups: only their members, when so set;
 *   - the answer shape AI-Hub checks, and the edits cleaned to what the browser
 *     applies: valid A1 addresses, strings, at most 500;
 *   - the prompt carries what the browser sent about the book, cut at its limit,
 *     and never a reading from anywhere else;
 *   - the admin settings are saved as sent, unknown groups dropped.
 *
 * Run: php tests/ai_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';

use OCA\CalcBase\Service\AiScenario;
use OCA\CalcBase\Service\AiService;

$appValues = [];
$config = stub(OCP\IConfig::class, [
	'getAppValue' => static function ($app, $k, $d = '') use (&$appValues) { return $appValues[$k] ?? $d; },
	'setAppValue' => static function ($app, $k, $v) use (&$appValues) { $appValues[$k] = $v; },
]);
$hubThere = true;
$apps = stub(OCP\App\IAppManager::class, ['isEnabledForUser' => static function ($app) use (&$hubThere) { return $app === 'ai_hub' && $hubThere; }]);
$groups = stub(OCP\IGroupManager::class, [
	'groupExists' => static fn ($g) => in_array($g, ['staff', 'admin'], true),
	'getUserGroupIds' => static fn ($user) => $user->getUID() === 'alice' ? ['staff'] : ['guests'],
]);
$users = stub(OCP\IUserManager::class, ['get' => static fn ($uid) => user($uid)]);
$ai = new AiService($config, $apps, $groups, $users);
// AI-Hub's class is not autoloaded here; where the app is installed it is read in,
// so that hubPresent() can say yes and the rules that need the hub can be tried.
$hubFile = '/var/www/nextcloud/apps/ai_hub/lib/Service/HubService.php';
if (is_file($hubFile)) {
	require_once $hubFile;
}
$classThere = class_exists('\\OCA\\AIHub\\Service\\HubService');

echo "--- off by default ---\n";
check('the assistant is off until switched on', $ai->settings()['enabled'] === false && $ai->allowed('bob') === false);
check('status says do not show', $ai->status('bob') === ['show' => false]);
check('a question is refused', $ai->ask('bob', [], 'hello', [], 'ja') === ['error' => 'not-allowed']);

echo "--- the administrator's settings ---\n";
$saved = $ai->saveSettings(['enabled' => true, 'users' => 'groups', 'groups' => ['staff', 'nobody', 42], 'search' => '1']);
check('saved as sent, unknown groups dropped', $saved === ['enabled' => true, 'users' => 'groups', 'groups' => ['staff'], 'read' => [], 'search' => true], json_encode($saved));
$saved = $ai->saveSettings(['enabled' => true, 'users' => 'all', 'read' => ['regibase', 'nonsense', 'netbase', 42]]);
check('what it may read: known apps only, in the fixed order', $saved['read'] === ['regibase', 'netbase'], json_encode($saved['read']));
$ai->saveSettings(['enabled' => true, 'users' => 'groups', 'groups' => ['staff'], 'search' => '1']);
if ($classThere) {
	check('a member of the group may ask', $ai->allowed('alice') === true);
	check('somebody outside it may not', $ai->allowed('bob') === false);
	$hubThere = false;
	check('without AI-Hub nobody may, whatever the settings', $ai->allowed('alice') === false);
	$hubThere = true;
	$ai->saveSettings(['enabled' => true, 'users' => 'all']);
	check('everyone, when so set', $ai->allowed('bob') === true);
} else {
	echo "SKIP  AI-Hub is not installed on this server, so allowed() is false for everyone here\n";
	check('without AI-Hub nobody may, whatever the settings', $ai->allowed('alice') === false);
}

echo "--- the answer's edits ---\n";
$edits = AiService::cleanEdits([
	['cell' => 'b2', 'input' => '=SUM(A1:A3)'],
	['sheet' => 'Other', 'cell' => 'A1', 'input' => 42],
	['cell' => 'C3', 'input' => true],
	['cell' => 'nonsense', 'input' => 'x'],
	['cell' => 'D4'],
	'not an edit',
	['cell' => 'E5', 'input' => ['no' => 'arrays']],
]);
check('addresses upper-cased, numbers and booleans as typed, the rest dropped', $edits === [
	['sheet' => null, 'cell' => 'B2', 'input' => '=SUM(A1:A3)'],
	['sheet' => 'Other', 'cell' => 'A1', 'input' => '42'],
	['sheet' => null, 'cell' => 'C3', 'input' => 'TRUE'],
	['sheet' => null, 'cell' => 'D4', 'input' => ''],
], json_encode($edits));
$many = [];
for ($i = 0; $i < 600; $i++) {
	$many[] = ['cell' => 'A' . ($i + 1), 'input' => (string)$i];
}
check('at most 500 edits', count(AiService::cleanEdits($many)) === 500);

if ($classThere) {
	$shape = AiScenario::answerShape();
	check('a good answer fits the shape AI-Hub checks', \OCA\AIHub\Service\HubService::validate(['reply' => 'ok', 'edits' => [['cell' => 'B2', 'input' => '=1']]], $shape) === '');
	check('an answer without edits does not', \OCA\AIHub\Service\HubService::validate(['reply' => 'ok'], $shape) !== '');
	check('an edit without a cell does not', \OCA\AIHub\Service\HubService::validate(['reply' => 'ok', 'edits' => [['input' => '1']]], $shape) !== '');
} else {
	echo "SKIP  AI-Hub is not installed, so its validator cannot be run against the shape\n";
}

echo "--- the prompt ---\n";
$tsv = "Item\tQty\nApples\t3\nTotal\t=SUM(B2:B2) → 3";
$p = AiScenario::perQuestion([], false, ['book' => 'Sales', 'sheets' => ['S1', 'S2'], 'active' => 'S1', 'range' => 'A1:B3', 'tsv' => $tsv, 'selection' => ['range' => 'B3', 'tsv' => '=SUM(B2:B2) → 3']], 'ja');
check('the book, its sheets and the active sheet are named', str_contains($p, 'The open book "Sales", sheets: S1, S2.') && str_contains($p, 'The active sheet "S1", used range A1:B3'), $p);
check('the sheet is there as sent', str_contains($p, $tsv));
check('the selection is there', str_contains($p, 'The writer has selected B3:'));
check('no web search, Japanese', str_contains($p, 'web search is not allowed') && str_contains($p, 'Answer in Japanese'));
check('nothing outside the question may be read', str_contains($p, 'You may read nothing outside this question'));
$long = str_repeat("a\tb\tc\n", 20000);
$p = AiScenario::perQuestion([], true, ['tsv' => $long], 'en');
check('a long sheet is cut at the limit, and said so', strlen($p) < 26000 && str_contains($p, 'the rest of the sheet is not shown'), strlen($p) . ' chars');
$p = AiScenario::perQuestion([], true, [], 'en');
check('an empty sheet is said', str_contains($p, 'is empty') && str_contains($p, 'You may search the web'));
check('the scenario names every function the engine has', str_contains(AiScenario::base(), 'XLOOKUP') && str_contains(AiScenario::base(), 'NETWORKDAYS') && str_contains(AiScenario::base(), '"edits"'));
$p = AiScenario::perQuestion(['regibase', 'netbase'], false, [], 'en');
check('with apps allowed, the prompt says how to read them, and only them', str_contains($p, '{"source":"regibase"') && str_contains($p, '{"source":"netbase"}') && !str_contains($p, '{"source":"editbase"') && !str_contains($p, 'read nothing outside'), $p);
$shapeRead = AiScenario::answerShape();
check('the answer shape has an optional read', isset($shapeRead['properties']['read']) && !in_array('read', $shapeRead['required'], true));
check('a reading is cleaned to a known source and plain parameters', AiService::cleanRead(['source' => 'RegiBase', 'collection' => 9, 'nested' => ['x' => 1]]) === ['source' => 'regibase', 'collection' => 9] && AiService::cleanRead(['source' => 'files']) === null && AiService::cleanRead('nope') === null);

finish();
