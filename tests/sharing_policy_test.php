<?php
/**
 * Regression test: finding people and sharing with them follow the administrator's
 * sharing settings (EditBase review S5, carried into CalcBase).
 *
 * The people picker (ShareService::findUsers) is run over Nextcloud's own
 * collaborator search -- the real Search and UserPlugin classes, with the users,
 * groups and settings stood in -- and the contacts picker (Connectors::contacts)
 * over a stand-in address book holding two accounts from the system address book
 * and one of the user's own contacts. Alice and Bob are in "sales", Carol and
 * Dave in "support".
 *
 *   - with the list of accounts closed, a partial name finds nobody; the exact
 *     id still finds them where the administrator allows that;
 *   - with the list limited to one's own groups, only they are listed;
 *   - with "share only with group members", nobody outside is offered, and a
 *     share with them is refused as if they did not exist;
 *   - the system address book in the contacts picker is held to the same rules,
 *     while the user's own contacts are always theirs;
 *   - with the settings as Nextcloud ships them, everybody is found as before.
 *
 * Run: php tests/sharing_policy_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';

use OC\Collaboration\Collaborators\Search;
use OC\Collaboration\Collaborators\SearchResult;
use OC\Collaboration\Collaborators\UserPlugin;

$groups = ['alice' => ['sales'], 'bob' => ['sales'], 'carol' => ['support'], 'dave' => ['support']];
$people = [];
foreach ($groups as $uid => $_) {
	$people[$uid] = user($uid, ucfirst($uid), $uid . '@example.com');
}

/** Everything the picker and the share are made of, under these core settings. */
function world(array $core): array {
	global $groups, $people;
	// Matching an exact e-mail address is a database query in core; offline, it is left off.
	$core += ['shareapi_restrict_user_enumeration_full_match_email' => 'no'];
	$value = static fn ($k, $d) => $core[$k] ?? $d;
	$match = static fn (string $pattern) => array_values(array_filter($people, static fn ($u) => $pattern === ''
		|| str_contains(strtolower($u->getUID()), strtolower($pattern)) || str_contains(strtolower($u->getDisplayName()), strtolower($pattern))));
	$users = stub(OCP\IUserManager::class, [
		'get' => static fn ($uid) => $people[$uid] ?? null,
		'userExists' => static fn ($uid) => isset($people[$uid]),
		'search' => static fn ($p, $l = null, $o = null) => $match((string)$p),
		'searchDisplayName' => static fn ($p, $l = null, $o = null) => $match((string)$p),
		'searchKnownUsersByDisplayName' => static fn ($s, $p, $l = null, $o = null) => [],
	]);
	$groupManager = stub(OCP\IGroupManager::class, [
		'getUserGroupIds' => static fn ($u) => $groups[$u->getUID()] ?? [],
		'displayNamesInGroup' => static function ($gid, $search = '', $limit = -1, $offset = 0) use ($groups, $people) {
			$out = [];
			foreach ($groups as $uid => $in) {
				if (in_array($gid, $in, true) && ($search === '' || str_contains($uid, strtolower($search)))) {
					$out[$uid] = $people[$uid]->getDisplayName();
				}
			}
			return $out;
		},
	]);
	$appConfig = stub(OCP\IAppConfig::class, ['getValueString' => static fn ($app, $k, $d = '', $lazy = false) => $app === 'core' ? $value($k, $d) : $d]);
	$me = $people['alice'];
	$plugin = new UserPlugin($appConfig, $users, $groupManager, stub(OCP\Teams\ITeamManager::class),
		stub(OCP\IUserSession::class, ['getUser' => static fn () => $me]), stub(OCP\UserStatus\IManager::class), stub(OCP\IDBConnection::class));
	$search = new Search(stub(OCP\IContainer::class, ['resolve' => static fn ($name) => $name === UserPlugin::class ? $plugin : new SearchResult()]));
	$search->registerPlugin(['shareType' => 'SHARE_TYPE_USER', 'class' => UserPlugin::class]);

	$made = new ArrayObject();
	$shares = stub(OCP\Share\IManager::class, [
		'shareApiEnabled' => static fn () => $value('shareapi_enabled', 'yes') === 'yes',
		'sharingDisabledForUser' => static fn ($u) => false,
		'shareWithGroupMembersOnly' => static fn () => $value('shareapi_only_share_with_group_members', 'no') === 'yes',
		'shareWithGroupMembersOnlyExcludeGroupsList' => static fn () => [],
		'allowEnumeration' => static fn () => $value('shareapi_allow_share_dialog_user_enumeration', 'yes') === 'yes',
		'limitEnumerationToGroups' => static fn () => $value('shareapi_restrict_user_enumeration_to_group', 'no') === 'yes',
		'limitEnumerationToPhone' => static fn () => $value('shareapi_restrict_user_enumeration_to_phone', 'no') === 'yes',
		'allowEnumerationFullMatch' => static fn () => $value('shareapi_restrict_user_enumeration_full_match', 'yes') === 'yes',
		'getSharesBy' => static fn () => [],
		'newShare' => static function () use (&$made) {
			$share = stub(OCP\Share\IShare::class);
			$fields = new ArrayObject();
			$set = static function (string $k) use ($share, $fields) {
				return static function ($v) use ($k, $share, $fields) { $fields[$k] = $v; return $share; };
			};
			$share->__o = ['setNode' => $set('node'), 'setShareType' => $set('type'), 'setSharedWith' => $set('with'), 'setSharedBy' => $set('by'), 'setPermissions' => $set('perm'),
				'getSharedWith' => static fn () => $fields['with'] ?? ''];
			return $share;
		},
		'createShare' => static function ($share) use ($made) { $made[] = $share->getSharedWith(); return $share; },
	]);
	$doc = stub(OCP\Files\File::class, ['getId' => static fn () => 42, 'getName' => static fn () => 'Plan.html', 'isShareable' => static fn () => true]);
	$root = stub(OCP\Files\IRootFolder::class, ['getUserFolder' => static fn ($u) => stub(OCP\Files\Folder::class, ['getById' => static fn ($id) => [$doc]])]);
	$policy = class_exists(OCA\CalcBase\Service\SharingPolicy::class) ? new OCA\CalcBase\Service\SharingPolicy($shares, $groupManager, $users) : null;
	$sharing = build(OCA\CalcBase\Service\ShareService::class, ['shares' => $shares, 'rootFolder' => $root, 'users' => $users, 'collaborators' => $search, 'policy' => $policy]);

	$asked = new ArrayObject();
	$contactsManager = stub(OCP\Contacts\IManager::class, [
		'isEnabled' => static fn () => true,
		'search' => static function ($pattern, $props = [], $options = []) use ($asked) {
			$asked['options'] = $options;
			$out = [];
			foreach (['bob', 'carol'] as $uid) {
				if ($pattern === '' || str_contains($uid, strtolower((string)$pattern)) || $pattern === $uid . '@example.com') {
					$out[] = ['UID' => $uid, 'FN' => ucfirst($uid), 'EMAIL' => [$uid . '@example.com'], 'isLocalSystemBook' => true];
				}
			}
			if ($pattern === '' || str_contains('carol\'s plumber', strtolower((string)$pattern))) {
				$out[] = ['UID' => 'card-1', 'FN' => 'Carol\'s Plumber', 'EMAIL' => ['plumber@example.org']];
			}
			return $out;
		},
	]);
	$connectors = new class extends OCA\CalcBase\Service\Connectors {
		public function __construct() {
		}
		public function available(string $userId): array {
			return ['contacts' => true];
		}
	};
	poke($connectors, 'rootFolder', $root);
	poke($connectors, 'config', stub(OCP\IConfig::class));
	poke($connectors, 'contacts', $contactsManager);
	poke($connectors, 'policy', $policy);
	poke($connectors, 'shares', $shares);
	return ['sharing' => $sharing, 'made' => $made, 'connectors' => $connectors, 'asked' => $asked];
}

$ids = static fn (array $rows) => array_map(static fn ($r) => $r['id'], $rows);
$names = static fn (array $rows) => array_map(static fn ($r) => $r['name'], $rows);

echo "--- the list of accounts closed ---\n";
$w = world(['shareapi_allow_share_dialog_user_enumeration' => 'no']);
$found = attempt('picker', static fn () => $w['sharing']->findUsers('alice', 'c')) ?? [];
check('a partial name finds nobody', $found === [], json_encode($ids($found)));
$found = attempt('picker', static fn () => $w['sharing']->findUsers('alice', 'carol')) ?? [];
check('the exact id still finds them', $ids($found) === ['carol'], json_encode($ids($found)));
$c = attempt('contacts', static fn () => $w['connectors']->contacts('alice', 'c')) ?? [];
check('the contacts picker shows no account for a partial name', $names($c) === ['Carol\'s Plumber'], json_encode($names($c)));
check('... and asks the address books not to list them', ($w['asked']['options']['enumeration'] ?? null) === false, json_encode($w['asked']['options'] ?? null));

echo "--- the list limited to one's own groups ---\n";
$w = world(['shareapi_restrict_user_enumeration_to_group' => 'yes']);
$found = attempt('picker', static fn () => $w['sharing']->findUsers('alice', '')) ?? [];
check('only the people in one\'s groups are listed', $ids($found) === ['bob'], json_encode($ids($found)));
$c = attempt('contacts', static fn () => $w['connectors']->contacts('alice', '')) ?? [];
check('the contacts picker lists the same accounts, and one\'s own contacts', $names($c) === ['Bob', 'Carol\'s Plumber'], json_encode($names($c)));

echo "--- share only with group members ---\n";
$w = world(['shareapi_only_share_with_group_members' => 'yes']);
$found = attempt('picker', static fn () => $w['sharing']->findUsers('alice', 'carol')) ?? [];
check('somebody outside one\'s groups is not offered', $found === [], json_encode($ids($found)));
$error = null;
try {
	$w['sharing']->share('alice', 42, 'carol', false);
} catch (\Throwable $e) {
	$error = $e;
}
check('a share with them is refused', $error !== null && (array)$w['made'] === [], ($error ? $error->getMessage() : 'shared') . ' made: ' . json_encode((array)$w['made']));
check('... as if they did not exist', $error !== null && $error->getMessage() === 'no such account: carol', $error ? $error->getMessage() : '');
attempt('share with bob', static fn () => $w['sharing']->share('alice', 42, 'bob', false));
check('a share within the group is made', (array)$w['made'] === ['bob'], json_encode((array)$w['made']));
$c = attempt('contacts', static fn () => $w['connectors']->contacts('alice', '')) ?? [];
check('the contacts picker leaves out accounts outside one\'s groups', $names($c) === ['Bob', 'Carol\'s Plumber'], json_encode($names($c)));

echo "--- settings as Nextcloud ships them ---\n";
$w = world([]);
$found = attempt('picker', static fn () => $w['sharing']->findUsers('alice', 'o')) ?? [];
check('everybody matching is found, as before', $ids($found) === ['bob', 'carol'], json_encode($ids($found)));
attempt('share with carol', static fn () => $w['sharing']->share('alice', 42, 'carol', true));
check('a share with anybody is made, as before', (array)$w['made'] === ['carol'], json_encode((array)$w['made']));
$c = attempt('contacts', static fn () => $w['connectors']->contacts('alice', '')) ?? [];
check('the contacts picker lists every account and contact, as before', $names($c) === ['Bob', 'Carol', 'Carol\'s Plumber'], json_encode($names($c)));

finish();
