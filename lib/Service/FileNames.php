<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

use OCP\Files\Folder;

/**
 * File names a person typed, made safe, and names that are free in a folder.
 * Books (.html) and the files written by export (.csv, .ods, .xlsx) share
 * these, so a save never overwrites a stranger whatever the extension.
 */
final class FileNames {
	/** One safe name without its extension: no path parts, no hidden-file dots, not too long. */
	public static function clean(string $stem): string {
		$stem = trim(str_replace(['/', '\\', "\0"], '', $stem));
		// Leading dots would make a hidden file (and "..name" reads like a path trick
		// even though the slashes are already gone), so they go.
		$stem = ltrim($stem, ". \t");
		return mb_substr(trim($stem), 0, 200);
	}

	/** `Report.html`, then `Report (2).html`, … so a save never overwrites a stranger. */
	public static function free(Folder $folder, string $stem, string $ext): string {
		$stem = self::clean($stem);
		if ($stem === '') {
			$stem = 'Book';
		}
		$name = $stem . $ext;
		if (!$folder->nodeExists($name)) {
			return $name;
		}
		for ($i = 2; $i < 1000; $i++) {
			$candidate = $stem . ' (' . $i . ')' . $ext;
			if (!$folder->nodeExists($candidate)) {
				return $candidate;
			}
		}
		return $stem . ' (' . time() . ')' . $ext;
	}
}
