<?php

declare(strict_types=1);

namespace OCA\CalcBase\Controller;

use OCA\CalcBase\AppInfo\Application;
use OCA\CalcBase\Service\AiService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUserSession;

/**
 * The AI assistant's three questions from the browser -- may I, ask this, is the
 * answer there yet -- and the administrator's settings.
 */
class AiController extends Controller {
	public function __construct(
		IRequest $request,
		private AiService $ai,
		private IUserSession $userSession,
		private IConfig $config,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	private function uid(): ?string {
		$user = $this->userSession->getUser();
		return $user === null ? null : $user->getUID();
	}

	#[NoAdminRequired]
	public function status(): JSONResponse {
		$uid = $this->uid();
		return new JSONResponse($uid === null ? ['show' => false] : $this->ai->status($uid));
	}

	#[NoAdminRequired]
	public function ask(): JSONResponse {
		$uid = $this->uid();
		if ($uid === null) {
			return new JSONResponse(['error' => 'not-allowed'], Http::STATUS_FORBIDDEN);
		}
		$history = $this->request->getParam('history', []);
		$context = $this->request->getParam('context', []);
		$message = $this->request->getParam('message', '');
		$images = $this->request->getParam('images', []);
		// The app's own language setting first, Nextcloud's when the app follows it.
		$lang = $this->config->getUserValue($uid, Application::APP_ID, 'language', 'auto');
		if (!is_string($lang) || $lang === 'auto' || $lang === '') {
			$lang = $this->config->getUserValue($uid, 'core', 'lang', $this->config->getSystemValueString('default_language', 'en'));
		}
		$out = $this->ai->ask(
			$uid,
			is_array($history) ? $history : [],
			is_string($message) ? mb_substr($message, 0, 20000) : '',
			is_array($context) ? $context : [],
			str_starts_with((string)$lang, 'ja') ? 'ja' : (string)$lang,
			is_array($images) ? $images : [],
		);
		$status = isset($out['error']) ? ($out['error'] === 'not-allowed' ? Http::STATUS_FORBIDDEN : Http::STATUS_SERVICE_UNAVAILABLE) : Http::STATUS_OK;
		return new JSONResponse($out, $status);
	}

	#[NoAdminRequired]
	public function result(string $id): JSONResponse {
		$uid = $this->uid();
		return new JSONResponse($uid === null ? ['state' => 'unknown'] : $this->ai->result($uid, $id));
	}

	/** Administrators only (no NoAdminRequired). */
	public function saveAdmin(): JSONResponse {
		if (!$this->ai->hubPresent()) {
			return new JSONResponse(['error' => 'AI-Hub is not installed'], Http::STATUS_CONFLICT);
		}
		return new JSONResponse($this->ai->saveSettings([
			'enabled' => $this->request->getParam('enabled'),
			'users' => $this->request->getParam('users'),
			'groups' => $this->request->getParam('groups', []),
			'read' => $this->request->getParam('read', []),
			'search' => $this->request->getParam('search'),
		]));
	}
}
