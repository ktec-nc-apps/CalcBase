<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

use OCP\Files\NotPermittedException;

/**
 * Other formats in and out of the user's Files.
 *
 * In: a CSV, ODS or XLSX file the user picked, read into the workbook model
 * for the browser to make a book of. The file itself is only read.
 *
 * Out: the model the browser sent, written as CSV, ODS or XLSX into a folder
 * of the user's Files, under a name that is free there.
 */
class ImportExport {
	public function __construct(
		private FileBrowser $files,
		private BookService $books,
	) {
	}

	/**
	 * @return array{model: array, name: string, format: string}
	 */
	public function import(string $userId, int $fileId): array {
		$limits = $this->books->limits($userId);
		$file = $this->files->importable($userId, $fileId, $limits['bytes'] ?: FileBrowser::MAX_IMPORT_BYTES);
		$format = FileBrowser::importFormat($file->getName());
		$bytes = (string)$file->getContent();
		$model = match ($format) {
			'csv' => CsvFormat::import($bytes, $file->getName()),
			'ods' => OdsFormat::import(new ZipReader($bytes)),
			'xlsx' => XlsxFormat::import(new ZipReader($bytes)),
			'md' => self::markdown($bytes),
			default => throw new \InvalidArgumentException('not a CSV, ODS, XLSX or Markdown file'),
		};
		$encoding = $model['encoding'] ?? null;
		unset($model['encoding']);
		$out = [
			'model' => Model::forJson(Model::clean($model, $limits['cells'], $limits['rows'])),
			'name' => preg_replace('/\.[A-Za-z0-9]+$/', '', $file->getName()) ?? $file->getName(),
			'format' => $format,
		];
		if ($encoding !== null) {
			$out['encoding'] = $encoding;
		}
		return $out;
	}

	/** A Markdown file's pipe tables as a workbook, one sheet per table. */
	private static function markdown(string $bytes): array {
		$read = TextEncoding::toUtf8($bytes);
		$sheets = MarkdownTables::fromText($read['text']);
		if ($sheets === []) {
			throw new \InvalidArgumentException('that file has no table in it');
		}
		return ['sheets' => $sheets, 'active' => 0, 'encoding' => ['read' => $read['encoding'], 'lossy' => $read['lossy']]];
	}

	/**
	 * @param mixed $model what the browser sent (design contract §3)
	 * @param string $folder where to write: the folder the book is in, as Nextcloud
	 *               names it ("/bob/files/CalcBase/Work" -- the book's path less its
	 *               name), or a category of the save folder ("Work"; "" for the
	 *               save folder itself)
	 * @param string $sheet for CSV: the name or 0-based index of the sheet, '' for the active one
	 * @return array{id: int, path: string, name: string, where: string}
	 *         path as Nextcloud names it; where the same from the top of the
	 *         user's Files ("CalcBase/Work/Book.ods"), for saying where it went
	 */
	public function export(string $userId, string $format, mixed $model, string $folder, string $name, string $sheet = ''): array {
		$limits = $this->books->limits($userId);
		$model = Model::clean($model, $limits['cells'], $limits['rows']);
		$format = strtolower(trim($format));
		if (!in_array($format, ['csv', 'ods', 'xlsx'], true)) {
			throw new \InvalidArgumentException('the format must be csv, ods or xlsx');
		}
		$bytes = match ($format) {
			'csv' => CsvFormat::export($this->pick($model, $sheet)),
			'ods' => OdsFormat::export($model),
			default => XlsxFormat::export($model),
		};
		// The book's own folder, named from the top of the server's tree, was taken
		// for a category name and made again inside the save folder -- every export
		// went to CalcBase/bob/files/CalcBase/ (CalcBase BUGS #2).
		$home = '/' . $userId . '/files';
		$folder = trim($folder);
		$target = ($folder === $home || str_starts_with($folder, $home . '/'))
			? $this->books->homeFolderAt($userId, substr($folder, strlen($home)))
			: $this->books->folderAt($userId, $folder);
		if (!$target->isCreatable()) {
			throw new NotPermittedException('that folder is read only');
		}
		$stem = FileNames::clean($name);
		if ($stem === '') {
			$stem = 'Book';
		}
		$file = $target->newFile(FileNames::free($target, $stem, '.' . $format), $bytes);
		$path = $file->getPath();
		$where = str_starts_with($path, $home . '/') ? substr($path, strlen($home) + 1) : $file->getName();
		return ['id' => $file->getId(), 'path' => $path, 'name' => $file->getName(), 'where' => $where];
	}

	/** @return array<string, mixed> the sheet CSV writes */
	private function pick(array $model, string $which): array {
		if ($which === '') {
			return $model['sheets'][$model['active']];
		}
		if (preg_match('/^\d+$/', $which) && isset($model['sheets'][(int)$which])) {
			return $model['sheets'][(int)$which];
		}
		foreach ($model['sheets'] as $sheet) {
			if ($sheet['name'] === $which) {
				return $sheet;
			}
		}
		throw new \InvalidArgumentException('there is no sheet called ' . $which);
	}
}
