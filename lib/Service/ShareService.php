<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

use OCP\Collaboration\Collaborators\ISearch;
use OCP\Constants;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\Node;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\IUserManager;
use OCP\Share\IManager;
use OCP\Share\IShare;

/**
 * Sharing a book with someone else on this server.
 *
 * A book is a file, so this is Nextcloud's own sharing and nothing else: the
 * share made here is the share the Files app shows, it can be taken back from
 * either place, and a book shared with you arrives in your own Files where
 * the rest of the app already knows how to open it. Only accounts on this server
 * — no links, no e-mail, nothing that leaves.
 */
class ShareService {
	public function __construct(
		private IManager $shares,
		private IRootFolder $rootFolder,
		private IUserManager $users,
		private ISearch $collaborators,
		private SharingPolicy $policy,
	) {
	}

	/**
	 * The thing being shared, resolved inside the asking user's own storage. It is
	 * a document or a category, and a category is a folder: sharing one hands over
	 * everything filed in it, and everything filed in it later.
	 */
	private function node(string $userId, int $id): Node {
		foreach ($this->rootFolder->getUserFolder($userId)->getById($id) as $node) {
			if ($node instanceof File || $node instanceof Folder) {
				return $node;
			}
		}
		throw new NotFoundException('book ' . $id . ' not found');
	}

	/**
	 * Who this book is shared with, and whether each of them may write in it.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function listShares(string $userId, int $id): array {
		$node = $this->node($userId, $id);
		$out = [];
		foreach ([IShare::TYPE_USER, IShare::TYPE_GROUP] as $type) {
			foreach ($this->shares->getSharesBy($userId, $type, $node, false, 50) as $share) {
				$with = $share->getSharedWith();
				$out[] = [
					'id' => $share->getFullId(),
					'with' => $with,
					'name' => $this->displayName($with, $type),
					'group' => $type === IShare::TYPE_GROUP,
					'canEdit' => ($share->getPermissions() & Constants::PERMISSION_UPDATE) !== 0,
				];
			}
		}
		return $out;
	}

	/** Share it with one account on this server, to read or to write in. */
	public function share(string $userId, int $id, string $with, bool $canEdit): array {
		$with = trim($with);
		if ($with === '' || $with === $userId) {
			throw new \InvalidArgumentException('nobody to share with');
		}
		// The administrator's sharing settings apply here as they do in Files (S5).
		if (!$this->policy->mayShare($userId)) {
			throw new NotPermittedException('sharing is not allowed for your account');
		}
		// Somebody outside the groups this user may share with gets the same answer
		// as somebody who does not exist: which accounts exist is not for them to learn.
		if (!$this->users->userExists($with) || !$this->policy->mayShareWith($userId, $with)) {
			throw new \InvalidArgumentException('no such account: ' . $with);
		}
		$node = $this->node($userId, $id);
		if (!$node->isShareable()) {
			throw new NotPermittedException('this may not be shared on');
		}
		// Already shared with them: change what they may do rather than making a second one.
		foreach ($this->shares->getSharesBy($userId, IShare::TYPE_USER, $node, false, 50) as $existing) {
			if ($existing->getSharedWith() === $with) {
				$existing->setPermissions($this->permissions($canEdit, $node instanceof Folder));
				$this->shares->updateShare($existing);
				return $this->listShares($userId, $id);
			}
		}
		$share = $this->shares->newShare();
		$share->setNode($node);
		$share->setShareType(IShare::TYPE_USER);
		$share->setSharedWith($with);
		$share->setSharedBy($userId);
		$share->setPermissions($this->permissions($canEdit, $node instanceof Folder));
		$this->shares->createShare($share);
		return $this->listShares($userId, $id);
	}

	/** Take a share back. Only the person who made it may. */
	public function unshare(string $userId, int $id, string $shareId): array {
		$share = $this->shares->getShareById($shareId);
		if ($share->getSharedBy() !== $userId && $share->getShareOwner() !== $userId) {
			throw new NotPermittedException('that share is not yours to undo');
		}
		$this->shares->deleteShare($share);
		return $this->listShares($userId, $id);
	}

	/**
	 * Accounts on this server that match this, for the picker. Never the asker
	 * themselves, and never more than a screenful.
	 *
	 * The search is Nextcloud's own, the one its sharing dialog uses (review S5):
	 * whether accounts may be listed at all, whether only the asker's groups or
	 * phone book are, whether an exact id or address still finds somebody, and
	 * "share only with group members" are all the administrator's to say, and are
	 * said in one place.
	 *
	 * @return array<int, array<string, string>>
	 */
	public function findUsers(string $userId, string $term): array {
		if (!$this->policy->mayShare($userId)) {
			return [];
		}
		[$found] = $this->collaborators->search(trim($term), [IShare::TYPE_USER], false, 25, 0);
		$out = [];
		$seen = [];
		foreach (array_merge($found['exact']['users'] ?? [], $found['users'] ?? []) as $row) {
			$uid = (string)($row['value']['shareWith'] ?? '');
			if ($uid === '' || $uid === $userId || isset($seen[$uid])) {
				continue;
			}
			$seen[$uid] = true;
			$out[] = ['id' => $uid, 'name' => (string)($row['label'] ?? $uid)];
		}
		usort($out, static fn ($a, $b) => strcasecmp($a['name'], $b['name']));
		return array_slice($out, 0, 25);
	}

	/**
	 * What the other person may do. A category is a folder, and writing in one
	 * means making and deleting books in it as well as changing them.
	 */
	private function permissions(bool $canEdit, bool $folder = false): int {
		if (!$canEdit) {
			return Constants::PERMISSION_READ;
		}
		$out = Constants::PERMISSION_READ | Constants::PERMISSION_UPDATE | Constants::PERMISSION_SHARE;
		return $folder ? $out | Constants::PERMISSION_CREATE | Constants::PERMISSION_DELETE : $out;
	}

	private function displayName(string $with, int $type): string {
		if ($type === IShare::TYPE_GROUP) {
			return $with;
		}
		$user = $this->users->get($with);
		return $user === null ? $with : $user->getDisplayName();
	}
}
