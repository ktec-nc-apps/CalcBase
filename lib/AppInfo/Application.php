<?php

declare(strict_types=1);

namespace OCA\CalcBase\AppInfo;

use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCA\CalcBase\Service\AiService;

class Application extends App implements IBootstrap {
	public const APP_ID = 'calcbase';

	public function __construct() {
		parent::__construct(self::APP_ID);
	}

	public function register(IRegistrationContext $context): void {
	}

	public function boot(IBootContext $context): void {
		// AI-Hub, when it is installed, is told what CalcBase's assistant is -- in
		// every request, since the hub keeps scenarios in memory only and the
		// request that works out an answer is not the one that asked.
		if (class_exists('\\OCA\\AIHub\\Service\\HubService')) {
			$context->injectFn(static function (AiService $ai): void {
				$ai->registerScenario();
			});
		}
	}
}
