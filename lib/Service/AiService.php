<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

use OCA\CalcBase\AppInfo\Application;
use OCP\App\IAppManager;
use OCP\IConfig;
use OCP\IGroupManager;
use OCP\IUserManager;

/**
 * The AI assistant of CalcBase, made the way EditBase's and FormulaBase's are.
 *
 * CalcBase has no AI of its own: it asks AI-Hub (ai_hub), the AI gateway whose
 * key, model and limits are set once in AI-Hub's admin settings. Without AI-Hub
 * the assistant is not offered at all, and its admin settings are shown greyed out.
 *
 * What the assistant may do is set by the administrator: whether it is on, who
 * may use it, and whether it may search the web. It reads only what the browser
 * sends with a question -- the open book's sheet, as text -- and changes nothing
 * itself: the cells it proposes come back in the answer's shape (see AiScenario)
 * for the browser to apply as one step the person can undo.
 */
class AiService {
	public const KEY_ENABLED = 'ai_enabled';
	public const KEY_USERS = 'ai_users';
	public const KEY_GROUPS = 'ai_groups';
	public const KEY_SEARCH = 'ai_search';
	/** The name CalcBase's assistant is registered under at AI-Hub. */
	public const SCENARIO = 'assistant';
	/** The most one turn of the conversation may carry to AI-Hub (characters). */
	private const MAX_TURN_CHARS = 16000;
	/** The most cell changes one answer may propose. */
	public const MAX_EDITS = 500;
	private const HUB = 'ai_hub';
	private const HUB_SERVICE = '\\OCA\\AIHub\\Service\\HubService';

	public function __construct(
		private IConfig $config,
		private IAppManager $apps,
		private IGroupManager $groups,
		private IUserManager $users,
	) {
	}

	/** AI-Hub is installed and switched on. */
	public function hubPresent(): bool {
		return $this->apps->isEnabledForUser(self::HUB) && class_exists(self::HUB_SERVICE);
	}

	/** @return object|null AI-Hub's HubService */
	private function hub(): ?object {
		return $this->hubPresent() ? \OCP\Server::get(ltrim(self::HUB_SERVICE, '\\')) : null;
	}

	/**
	 * Tell AI-Hub what CalcBase's assistant is. Called when the app boots, in every
	 * request: the hub keeps scenarios in memory only, and the request that works
	 * out an answer is not the one that asked.
	 */
	public function registerScenario(): void {
		$hub = $this->hub();
		if ($hub === null || $hub->hasScenario(Application::APP_ID, self::SCENARIO)) {
			return;
		}
		$hub->registerScenario(Application::APP_ID, self::SCENARIO, [
			'system' => AiScenario::base(),
			// The answer is words for the person and a list of cells to change, which the
			// hub checks against this shape before it is handed back.
			'answer' => AiScenario::answerShape(),
			// Whether a question may search is decided per question, from the
			// administrator's CalcBase settings; the language is in the prompt itself.
			'search' => true,
			'language' => false,
			// Who may ask is the administrator's CalcBase setting, and the hub holds
			// to it on every way in -- not only through CalcBase's own controller.
			'allow' => fn (string $uid): bool => $this->allowed($uid),
		]);
	}

	/**
	 * What AI-Hub can offer now.
	 *
	 * @return array{present: bool, ready: bool, reason: string, provider: string, mode: string, model: string, search: bool}
	 */
	public function hubStatus(): array {
		$hub = $this->hub();
		if ($hub === null) {
			return ['present' => false, 'ready' => false, 'reason' => 'absent', 'provider' => '', 'mode' => '', 'model' => '', 'search' => false];
		}
		return ['present' => true] + $hub->status(Application::APP_ID);
	}

	/** @return array{enabled: bool, users: string, groups: list<string>, search: bool} */
	public function settings(): array {
		$get = fn (string $k, string $d) => $this->config->getAppValue(Application::APP_ID, $k, $d);
		$groups = json_decode($get(self::KEY_GROUPS, '[]'), true);
		return [
			'enabled' => $get(self::KEY_ENABLED, 'no') === 'yes',
			'users' => $get(self::KEY_USERS, 'all') === 'groups' ? 'groups' : 'all',
			'groups' => is_array($groups) ? array_values(array_filter($groups, 'is_string')) : [],
			'search' => $get(self::KEY_SEARCH, 'no') === 'yes',
		];
	}

	/** @param array{enabled?: mixed, users?: mixed, groups?: mixed, search?: mixed} $in */
	public function saveSettings(array $in): array {
		$set = fn (string $k, string $v) => $this->config->setAppValue(Application::APP_ID, $k, $v);
		$set(self::KEY_ENABLED, !empty($in['enabled']) ? 'yes' : 'no');
		$set(self::KEY_USERS, ($in['users'] ?? '') === 'groups' ? 'groups' : 'all');
		$groups = is_array($in['groups'] ?? null) ? $in['groups'] : [];
		$groups = array_values(array_filter($groups, fn ($g) => is_string($g) && $this->groups->groupExists($g)));
		$set(self::KEY_GROUPS, json_encode($groups));
		$set(self::KEY_SEARCH, !empty($in['search']) ? 'yes' : 'no');
		return $this->settings();
	}

	/** Whether this person may use the assistant, as the administrator has set it. */
	public function allowed(string $uid): bool {
		$s = $this->settings();
		if (!$s['enabled'] || !$this->hubPresent()) {
			return false;
		}
		if ($s['users'] === 'all') {
			return true;
		}
		$user = $this->users->get($uid);
		if ($user === null) {
			return false;
		}
		foreach ($this->groups->getUserGroupIds($user) as $g) {
			if (in_array($g, $s['groups'], true)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * What the browser needs to know: whether to show the handle at all, whether a
	 * question can be asked now, and the model that answers.
	 */
	public function status(string $uid): array {
		if (!$this->allowed($uid)) {
			return ['show' => false];
		}
		$hub = $this->hubStatus();
		$s = $this->settings();
		return [
			'show' => true,
			'ready' => $hub['ready'],
			'reason' => $hub['reason'],
			'model' => $hub['model'],
			'search' => $s['search'] && $hub['search'],
		];
	}

	/**
	 * Ask the assistant. What the administrator allows and what is on the screen
	 * are put into the prompt here, on the server; the browser sends only the
	 * conversation and the open sheet.
	 *
	 * @param list<array{role: string, text: string}> $history
	 * @param array<string, mixed> $context
	 * @return array{id?: string, error?: string}
	 */
	public function ask(string $uid, array $history, string $message, array $context, string $lang): array {
		if (!$this->allowed($uid)) {
			return ['error' => 'not-allowed'];
		}
		$st = $this->status($uid);
		// The browser keeps the conversation; the last 30 turns go to the hub, each cut
		// to a length a person could have typed.
		$messages = array_slice(array_values(array_filter($history, static fn ($t) => is_array($t)
			&& in_array($t['role'] ?? '', ['user', 'assistant'], true) && is_string($t['text'] ?? null))), -30);
		$messages = array_map(static fn (array $t) => ['role' => $t['role'], 'text' => mb_substr($t['text'], 0, self::MAX_TURN_CHARS)], $messages);
		$messages[] = ['role' => 'user', 'text' => mb_substr($message, 0, self::MAX_TURN_CHARS)];
		$this->registerScenario();
		return $this->hub()->ask($uid, Application::APP_ID, self::SCENARIO, $messages, [
			'context' => AiScenario::perQuestion($st['search'], $context, $lang),
			'search' => $st['search'],
		]);
	}

	/**
	 * The answer, with the cell changes it proposes cleaned to what the browser
	 * applies: a sheet name, an A1 address and the text to type, at most MAX_EDITS.
	 *
	 * @return array{state: string, text?: string, reply?: string, edits?: list<array{sheet: ?string, cell: string, input: string}>, error?: string}
	 */
	public function result(string $uid, string $id): array {
		$hub = $this->hub();
		if ($hub === null) {
			return ['state' => 'unknown'];
		}
		$out = $hub->result($uid, $id);
		if (($out['state'] ?? '') !== 'done') {
			return $out;
		}
		$answer = is_array($out['answer'] ?? null) ? $out['answer'] : [];
		$reply = is_string($answer['reply'] ?? null) ? $answer['reply'] : (string)($out['text'] ?? '');
		return [
			'state' => 'done',
			'text' => (string)($out['text'] ?? ''),
			'reply' => $reply,
			'edits' => self::cleanEdits(is_array($answer['edits'] ?? null) ? $answer['edits'] : []),
		];
	}

	/**
	 * @param list<mixed> $edits
	 * @return list<array{sheet: ?string, cell: string, input: string}>
	 */
	public static function cleanEdits(array $edits): array {
		$out = [];
		foreach ($edits as $e) {
			if (!is_array($e) || !is_string($e['cell'] ?? null) || Cells::parseRef($e['cell']) === null) {
				continue;
			}
			$input = $e['input'] ?? '';
			if (is_bool($input)) {
				$input = $input ? 'TRUE' : 'FALSE';
			} elseif (is_int($input) || is_float($input)) {
				$input = Cells::number($input);
			} elseif (!is_string($input)) {
				continue;
			}
			$out[] = [
				'sheet' => is_string($e['sheet'] ?? null) && $e['sheet'] !== '' ? mb_substr($e['sheet'], 0, 64) : null,
				'cell' => strtoupper($e['cell']),
				'input' => mb_substr($input, 0, Model::MAX_FORMULA),
			];
			if (count($out) >= self::MAX_EDITS) {
				break;
			}
		}
		return $out;
	}
}
