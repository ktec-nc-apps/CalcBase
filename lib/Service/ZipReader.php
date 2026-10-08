<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/**
 * An ODS or XLSX file opened for reading, with its size held in check.
 *
 * Both formats are ZIP files, and a ZIP file says how big each entry is only
 * in its own directory -- which a crafted file can fill with a few kilobytes
 * that unpack to gigabytes. So every entry's declared size is checked before
 * anything is read, the sum of them too, and what is read is read through a
 * stream that stops at the limit however big the entry really is. Over the
 * limit, the import is refused with a sentence that says why, not with the
 * server running out of memory.
 */
final class ZipReader {
	/**
	 * The most one entry may unpack to. The sentences that say so are written out
	 * with the numbers in them (32 MB, 96 MB), so that the screen can find them
	 * in its translations: change both together.
	 */
	public const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
	/** The most the whole file may unpack to. */
	public const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
	/** More entries than a workbook could need. */
	public const MAX_ENTRIES = 4096;

	private \ZipArchive $zip;
	private string $path;
	/** @var array<string, int> entry name => declared size */
	private array $sizes = [];

	/** @throws \InvalidArgumentException when the bytes are not a ZIP a workbook could be, or too big. */
	public function __construct(string $bytes) {
		$this->path = tempnam(sys_get_temp_dir(), 'cbzip');
		if ($this->path === false || file_put_contents($this->path, $bytes) === false) {
			throw new \RuntimeException('could not write a temporary file');
		}
		$this->zip = new \ZipArchive();
		$rc = $this->zip->open($this->path, \ZipArchive::RDONLY);
		if ($rc !== true) {
			@unlink($this->path);
			throw new \InvalidArgumentException('that file is not a ZIP archive, so not an ODS or XLSX file');
		}
		if ($this->zip->numFiles > self::MAX_ENTRIES) {
			$this->close();
			throw new \InvalidArgumentException('that file has too many parts to be a workbook');
		}
		$total = 0;
		for ($i = 0; $i < $this->zip->numFiles; $i++) {
			$stat = $this->zip->statIndex($i);
			if ($stat === false) {
				continue;
			}
			$size = (int)$stat['size'];
			if ($size > self::MAX_ENTRY_BYTES) {
				$this->close();
				throw new \InvalidArgumentException('a part of that file is larger than 32 MB when unpacked');
			}
			$total += $size;
			if ($total > self::MAX_TOTAL_BYTES) {
				$this->close();
				throw new \InvalidArgumentException('that file is larger than 96 MB when unpacked');
			}
			$this->sizes[(string)$stat['name']] = $size;
		}
	}

	public function has(string $name): bool {
		return isset($this->sizes[$name]);
	}

	/** @return list<string> */
	public function names(): array {
		return array_keys($this->sizes);
	}

	/**
	 * One entry's bytes, read through a stream capped at the limit: a directory
	 * that lies about the size does not get past it.
	 *
	 * @throws \InvalidArgumentException when the entry is missing or bigger than it said
	 */
	public function read(string $name): string {
		$name = ltrim($name, '/');
		if (!isset($this->sizes[$name])) {
			throw new \InvalidArgumentException('that file has no ' . $name . ', so it is not the kind of workbook it says');
		}
		$stream = $this->zip->getStream($name);
		if ($stream === false) {
			throw new \InvalidArgumentException('a part of that file (' . $name . ') cannot be read');
		}
		$data = stream_get_contents($stream, self::MAX_ENTRY_BYTES + 1);
		fclose($stream);
		if ($data === false || strlen($data) > self::MAX_ENTRY_BYTES) {
			throw new \InvalidArgumentException('a part of that file is larger than it says it is');
		}
		return $data;
	}

	/** The entry as a DOM document; the XML is parsed with no external entities and no network. */
	public function dom(string $name): \DOMDocument {
		return self::parse($this->read($name), $name);
	}

	/** @throws \InvalidArgumentException when it is not well-formed XML */
	public static function parse(string $xml, string $what): \DOMDocument {
		$doc = new \DOMDocument();
		$prev = libxml_use_internal_errors(true);
		// LIBXML_NONET: a crafted file may point at the network; LIBXML_PARSEHUGE is
		// deliberately not set, so libxml's own depth and size limits stand too.
		$ok = $doc->loadXML($xml, LIBXML_NONET);
		libxml_clear_errors();
		libxml_use_internal_errors($prev);
		if (!$ok) {
			throw new \InvalidArgumentException('a part of that file (' . $what . ') is not well-formed XML');
		}
		return $doc;
	}

	public function close(): void {
		try {
			$this->zip->close();
		} catch (\Throwable) {
			// already closed
		}
		@unlink($this->path);
	}

	public function __destruct() {
		$this->close();
	}
}
