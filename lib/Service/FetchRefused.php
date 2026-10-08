<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * Why a page or a picture from the web was not brought in, in a few plain words
 * the person can be shown. What the other side actually answered, and where the
 * address really led, go to the log and never to the browser (review S8).
 */
class FetchRefused extends \InvalidArgumentException {
	public function __construct(string $message, private int $status = 400) {
		parent::__construct($message);
	}

	/** The HTTP status the answer to the browser carries. */
	public function status(): int {
		return $this->status;
	}
}
