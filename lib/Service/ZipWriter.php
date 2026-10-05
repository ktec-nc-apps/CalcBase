<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

/** A ZIP package built in a temporary file and handed back as bytes. */
final class ZipWriter {
	/**
	 * @param array<string, string> $entries name => content, in the order they are to be stored
	 * @param string $stored an entry to leave uncompressed (ODS wants its mimetype so, and first)
	 */
	public static function build(array $entries, string $stored = ''): string {
		$path = tempnam(sys_get_temp_dir(), 'cbout');
		if ($path === false) {
			throw new \RuntimeException('could not write a temporary file');
		}
		try {
			$zip = new \ZipArchive();
			if ($zip->open($path, \ZipArchive::OVERWRITE) !== true) {
				throw new \RuntimeException('could not write a ZIP file');
			}
			foreach ($entries as $name => $content) {
				$zip->addFromString($name, $content);
				if ($name === $stored) {
					$zip->setCompressionName($name, \ZipArchive::CM_STORE);
				}
			}
			$zip->close();
			$bytes = file_get_contents($path);
			if ($bytes === false) {
				throw new \RuntimeException('could not read the ZIP file back');
			}
			return $bytes;
		} finally {
			@unlink($path);
		}
	}
}
