<?php

declare(strict_types=1);

namespace OCA\CalcBase\Settings;

use OCA\CalcBase\Service\AiService;
use OCP\App\IAppManager;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IGroupManager;
use OCP\Settings\ISettings;
use OCP\Util;

/**
 * The AI assistant's settings: on or off, who may use it, what it may read and
 * whether it may search the web. Without AI-Hub it is all shown greyed out.
 * First in the CalcBase section, as in every app of the Base series.
 */
class AiAdmin implements ISettings {
	public function __construct(
		private AiService $ai,
		private IAppManager $apps,
		private IGroupManager $groups,
	) {
	}

	public function getForm(): TemplateResponse {
		Util::addScript('calcbase', 'admin-ai');
		Util::addStyle('calcbase', 'admin-ai');
		$groups = [];
		foreach ($this->groups->search('') as $g) {
			$groups[] = ['id' => $g->getGID(), 'name' => $g->getDisplayName()];
		}
		$apps = [];
		foreach (AiService::SOURCES as $app) {
			// Calendars are read through the CalDAV backend, there with or without the Calendar app.
			$apps[$app] = $this->apps->isEnabledForUser($app === 'calendar' ? 'dav' : $app);
		}
		return new TemplateResponse('calcbase', 'admin-ai', [
			'hub' => $this->ai->hubStatus(),
			'settings' => $this->ai->settings(),
			'groups' => $groups,
			'apps' => $apps,
		], '');
	}

	public function getSection(): string {
		return 'calcbase';
	}

	public function getPriority(): int {
		return 10;
	}
}
