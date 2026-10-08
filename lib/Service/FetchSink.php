<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

use Psr\Http\Message\StreamInterface;

/**
 * Where the body of a fetched page or picture is written as it arrives, and
 * where it stops (review S7). curl hands the body over a piece at a time; once
 * the limit is reached this takes nothing more, and curl ends the transfer
 * there instead of reading the rest of whatever the other side cares to send.
 *
 * The parameters carry no types so this fits both versions of the PSR-7
 * interface a Nextcloud may ship; the return types are those of the newer one.
 */
class FetchSink implements StreamInterface {
	private string $data = '';
	private int $pos = 0;
	private bool $over = false;

	public function __construct(
		private int $limit,
	) {
	}

	/** Whether more was offered than the limit allows. */
	public function overflowed(): bool {
		return $this->over;
	}

	/** Everything taken, never more than the limit. */
	public function contents(): string {
		return $this->data;
	}

	public function write($string): int {
		$string = (string)$string;
		$room = $this->limit - strlen($this->data);
		if (strlen($string) > $room) {
			$this->data .= substr($string, 0, max(0, $room));
			$this->over = true;
			// Fewer bytes taken than given: curl stops the transfer.
			return 0;
		}
		$this->data .= $string;
		return strlen($string);
	}

	public function __toString(): string {
		return $this->data;
	}

	public function close(): void {
	}

	public function detach() {
		return null;
	}

	public function getSize(): ?int {
		return strlen($this->data);
	}

	public function tell(): int {
		return $this->pos;
	}

	public function eof(): bool {
		return $this->pos >= strlen($this->data);
	}

	public function isSeekable(): bool {
		return true;
	}

	public function seek($offset, $whence = SEEK_SET): void {
		$offset = (int)$offset;
		$to = match ((int)$whence) {
			SEEK_CUR => $this->pos + $offset,
			SEEK_END => strlen($this->data) + $offset,
			default => $offset,
		};
		$this->pos = max(0, min(strlen($this->data), $to));
	}

	public function rewind(): void {
		$this->pos = 0;
	}

	public function isWritable(): bool {
		return true;
	}

	public function isReadable(): bool {
		return true;
	}

	public function read($length): string {
		$out = (string)substr($this->data, $this->pos, max(0, (int)$length));
		$this->pos += strlen($out);
		return $out;
	}

	public function getContents(): string {
		return $this->read(strlen($this->data) - $this->pos);
	}

	public function getMetadata($key = null) {
		return $key === null ? [] : null;
	}
}
