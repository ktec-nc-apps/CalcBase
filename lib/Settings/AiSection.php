<?php

declare(strict_types=1);

namespace OCA\CalcBase\Settings;

use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\Settings\IIconSection;

/** "CalcBase" in the administration settings, for its AI assistant. */
class AiSection implements IIconSection {
	public function __construct(
		private IL10N $l,
		private IURLGenerator $url,
	) {
	}

	public function getID(): string {
		return 'calcbase';
	}

	public function getName(): string {
		return $this->l->t('CalcBase');
	}

	public function getPriority(): int {
		return 76;
	}

	public function getIcon(): string {
		// The app's own icon is the frontend's to draw; until it is there, a plain one.
		if (is_file(dirname(__DIR__, 2) . '/img/app-dark.svg')) {
			return $this->url->imagePath('calcbase', 'app-dark.svg');
		}
		return $this->url->imagePath('core', 'actions/settings-dark.svg');
	}
}
