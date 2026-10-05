<?php

declare(strict_types=1);

namespace OCA\CalcBase\Settings;

use OCA\CalcBase\Service\AiService;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IGroupManager;
use OCP\Settings\ISettings;
use OCP\Util;

/**
 * The AI assistant's settings: on or off, who may use it and whether it may
 * search the web. Without AI-Hub it is all shown greyed out. First in the
 * CalcBase section, as in every app of the Base series.
 */
class AiAdmin implements ISettings {
	public function __construct(
		private AiService $ai,
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
		return new TemplateResponse('calcbase', 'admin-ai', [
			'hub' => $this->ai->hubStatus(),
			'settings' => $this->ai->settings(),
			'groups' => $groups,
		], '');
	}

	public function getSection(): string {
		return 'calcbase';
	}

	public function getPriority(): int {
		return 10;
	}
}
