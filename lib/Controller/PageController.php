<?php

declare(strict_types=1);

namespace OCA\CalcBase\Controller;

use OCA\CalcBase\AppInfo\Application;
use OCP\App\IAppManager;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUserSession;
use OCP\L10N\IFactory;
use OCP\Util;

class PageController extends Controller {
	public function __construct(
		IRequest $request,
		private IAppManager $appManager,
		private IConfig $config,
		private IUserSession $userSession,
		private IFactory $l10nFactory,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function index(): TemplateResponse {
		$root = dirname(__DIR__, 2);
		// The page and its script are the frontend's; until they are in place the
		// app still loads, with a page that says so, so that the API can be used.
		$ready = is_file($root . '/templates/main.php') && is_file($root . '/js/calcbase.dist.js');
		if (is_file($root . '/css/calcbase.css')) {
			Util::addStyle(Application::APP_ID, 'calcbase');
		}
		if ($ready) {
			// Runtime-only Vue + precompiled render function (no template compiler → no eval).
			Util::addScript(Application::APP_ID, 'vue.runtime.global.prod');
			Util::addScript(Application::APP_ID, 'vue-private');
			Util::addScript(Application::APP_ID, 'calcbase.dist');
		}

		$user = $this->userSession->getUser();
		$uid = $user?->getUID() ?? '';
		$lang = $uid !== '' ? $this->config->getUserValue($uid, Application::APP_ID, 'language', 'auto') : 'auto';
		$l = $this->l10nFactory->get(Application::APP_ID, $lang === 'auto' ? null : $lang);

		// Resolve the theme here rather than in JS, so a reload paints the right
		// background immediately instead of flashing white on the way to dark.
		$pref = $uid !== '' ? $this->config->getUserValue($uid, Application::APP_ID, 'theme', 'auto') : 'auto';
		if (!in_array($pref, ['auto', 'light', 'dark'], true)) {
			$pref = 'auto';
		}
		$resolved = $pref === 'auto' ? $this->nextcloudTheme($uid) : $pref;

		$response = new TemplateResponse(Application::APP_ID, $ready ? 'main' : 'placeholder', [
			'version' => $this->appManager->getAppVersion(Application::APP_ID),
			'loading' => $l->t('Loading…'),
			'notReady' => $l->t('CalcBase is installed, but its screen is not built yet.'),
			'theme' => $pref,
			// '' = Nextcloud is following the OS, so leave it to the CSS media query.
			'cbtheme' => $resolved,
			'fileId' => (int)($this->request->getParam('fileId', 0)),
		]);
		$response->setContentSecurityPolicy($this->policy());
		return $response;
	}

	/**
	 * A book may set its typeface to any Google Fonts family, and the sheet has to
	 * show the same face the printed and saved file will use -- so the stylesheet
	 * and the font files themselves have to be reachable from this page (as
	 * EditBase's). The print frame is written into this page (srcdoc) and so is
	 * held to the same policy. Nothing else is added: scripts, frames and
	 * connections stay on Nextcloud's own default policy.
	 */
	public static function policy(): ContentSecurityPolicy {
		$csp = new ContentSecurityPolicy();
		$csp->addAllowedStyleDomain('https://fonts.googleapis.com');
		$csp->addAllowedFontDomain('https://fonts.gstatic.com');
		return $csp;
	}

	/**
	 * Which theme Nextcloud itself is set to, when the user has chosen one.
	 * Nextcloud's dark mode is a theme app, not a media query, so this is a
	 * config lookup — and an empty list means "follow the device", which only
	 * the browser can answer.
	 */
	private function nextcloudTheme(string $uid): string {
		if ($uid === '') {
			return '';
		}
		$enabled = json_decode($this->config->getUserValue($uid, 'theming', 'enabled-themes', '[]'), true);
		if (!is_array($enabled)) {
			return '';
		}
		if (in_array('dark', $enabled, true) || in_array('dark-highcontrast', $enabled, true)) {
			return 'dark';
		}
		if (in_array('light', $enabled, true) || in_array('light-highcontrast', $enabled, true)) {
			return 'light';
		}
		return '';
	}
}
