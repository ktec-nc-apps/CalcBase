<?php

declare(strict_types=1);

namespace OCA\CalcBase\Settings;

use OCA\CalcBase\Service\WebFetch;
use OCP\IL10N;
use OCP\Settings\DeclarativeSettingsTypes;
use OCP\Settings\IDeclarativeSettingsForm;

/**
 * The one thing an administrator decides about CalcBase: whether a picture or a
 * page brought in from the web may come from this server itself or from a
 * link-local address (review S1). Off unless turned on, and independent of
 * Nextcloud's own allow_local_remote_servers.
 *
 * A declared form: Nextcloud draws it under Administration settings, Security,
 * and keeps the answer in the app's own configuration, where WebFetch reads it.
 * It can also be set with occ config:app:set calcbase allow_self_targets --value=yes.
 */
class FetchSettings implements IDeclarativeSettingsForm {
	public function __construct(
		private IL10N $l,
	) {
	}

	public function getSchema(): array {
		return [
			'id' => 'calcbase-fetch',
			'priority' => 50,
			'section_type' => DeclarativeSettingsTypes::SECTION_TYPE_ADMIN,
			'section_id' => 'security',
			'storage_type' => DeclarativeSettingsTypes::STORAGE_TYPE_INTERNAL,
			'title' => $this->l->t('CalcBase'),
			'description' => $this->l->t('CalcBase reads pages from the web on the writer\'s behalf, so it is this server that connects to them. Machines on the local network may always be read from.'),
			'fields' => [
				[
					'id' => WebFetch::ALLOW_SELF,
					'title' => $this->l->t('This server itself and link-local addresses'),
					'description' => $this->l->t('127.0.0.1, ::1, this server\'s own addresses, 169.254.x.x (where a cloud server keeps its metadata service) and fe80::. Allow them only to bring in something served by this server itself.'),
					'type' => DeclarativeSettingsTypes::RADIO,
					'default' => 'no',
					'options' => [
						['name' => $this->l->t('Refuse (default)'), 'value' => 'no'],
						['name' => $this->l->t('Allow'), 'value' => 'yes'],
					],
				],
			],
		];
	}
}
