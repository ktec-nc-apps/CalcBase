<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

use OCP\IGroupManager;
use OCP\IUserManager;
use OCP\Share\IManager as IShareManager;

/**
 * The administrator's sharing settings, as they bear on CalcBase (review S5).
 *
 * Nextcloud holds its own sharing dialog to these; an app that finds people and
 * makes shares through the APIs underneath has to hold itself to them. They are
 * read the way core reads them: sharing may be off (for everybody, or for the
 * asker's groups), sharing may be limited to people the asker shares a group
 * with, and the list of accounts may be closed, or limited to the asker's groups
 * or to the people in their phone book -- in which case only an exact id or
 * address finds somebody, if the administrator allows even that.
 */
class SharingPolicy {
	/** @var array<string, true>|null the accounts this user knows by phone number */
	private ?array $known = null;

	public function __construct(
		private IShareManager $shares,
		private IGroupManager $groups,
		private IUserManager $users,
	) {
	}

	/** Whether this user may share anything at all. */
	public function mayShare(string $userId): bool {
		return $this->shares->shareApiEnabled() && !$this->shares->sharingDisabledForUser($userId);
	}

	/** Whether this user may share with that one, by the "only with group members" rule. */
	public function mayShareWith(string $userId, string $with): bool {
		if (!$this->mayShare($userId)) {
			return false;
		}
		return !$this->shares->shareWithGroupMembersOnly() || $this->shareAGroup($userId, $with);
	}

	/**
	 * Whether an account from the system address book may be shown to this user in
	 * a search for $query: the rules core's contacts menu applies to the same
	 * entries (ContactsStore::filterContacts).
	 *
	 * @param list<string> $emails the addresses on the entry
	 */
	public function mayListAccount(string $userId, string $other, array $emails, string $query): bool {
		if ($this->shares->sharingDisabledForUser($userId)) {
			return false;
		}
		$groupChecked = false;
		if (!$this->shares->allowEnumeration()) {
			if (!$this->shares->allowEnumerationFullMatch()) {
				return false;
			}
			if ($other !== $query && !in_array($query, $emails, true)) {
				return false;
			}
		} elseif ($this->shares->limitEnumerationToPhone() || $this->shares->limitEnumerationToGroups()) {
			$ok = $this->shares->limitEnumerationToPhone() && $this->knows($userId, $other);
			if (!$ok && $this->shares->limitEnumerationToGroups()) {
				$ok = $this->shareAGroup($userId, $other);
				$groupChecked = true;
			}
			if (!$ok) {
				return false;
			}
		}
		if ($this->shares->shareWithGroupMembersOnly() && !$groupChecked) {
			return $this->shareAGroup($userId, $other);
		}
		return true;
	}

	/** Whether the two have a group in common, not counting the groups the administrator set aside. */
	private function shareAGroup(string $userId, string $other): bool {
		$mine = $this->groupIds($userId);
		if ($this->shares->shareWithGroupMembersOnly()) {
			$mine = array_diff($mine, $this->shares->shareWithGroupMembersOnlyExcludeGroupsList());
		}
		return array_intersect($mine, $this->groupIds($other)) !== [];
	}

	/** @return list<string> */
	private function groupIds(string $userId): array {
		$user = $this->users->get($userId);
		return $user === null ? [] : array_values(array_map('strval', $this->groups->getUserGroupIds($user)));
	}

	private function knows(string $userId, string $other): bool {
		if ($this->known === null) {
			$this->known = [];
			try {
				foreach ($this->users->searchKnownUsersByDisplayName($userId, '', 1000) as $user) {
					$this->known[$user->getUID()] = true;
				}
			} catch (\Throwable) {
				// nobody known, then
			}
		}
		return isset($this->known[$other]);
	}
}
