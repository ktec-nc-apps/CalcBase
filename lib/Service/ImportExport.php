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
		$file = $this->files->importable($userId, $fileId);
		$format = FileBrowser::importFormat($file->getName());
		$bytes = (string)$file->getContent();
		$model = match ($format) {
			'csv' => CsvFormat::import($bytes, $file->getName()),
			'ods' => OdsFormat::import(new ZipReader($bytes)),
			'xlsx' => XlsxFormat::import(new ZipReader($bytes)),
			default => throw new \InvalidArgumentException('not a CSV, ODS or XLSX file'),
		};
		$encoding = $model['encoding'] ?? null;
		unset($model['encoding']);
		$out = [
			'model' => Model::forJson(Model::clean($model)),
			'name' => preg_replace('/\.[A-Za-z0-9]+$/', '', $file->getName()) ?? $file->getName(),
			'format' => $format,
		];
		if ($encoding !== null) {
			$out['encoding'] = $encoding;
		}
		return $out;
	}

	/**
	 * @param mixed $model what the browser sent (design contract §3)
	 * @param string $sheet for CSV: the name or 0-based index of the sheet, '' for the active one
	 * @return array{id: int, path: string, name: string}
	 */
	public function export(string $userId, string $format, mixed $model, string $folder, string $name, string $sheet = ''): array {
		$model = Model::clean($model);
		$format = strtolower(trim($format));
		if (!in_array($format, ['csv', 'ods', 'xlsx'], true)) {
			throw new \InvalidArgumentException('the format must be csv, ods or xlsx');
		}
		$bytes = match ($format) {
			'csv' => CsvFormat::export($this->pick($model, $sheet)),
			'ods' => OdsFormat::export($model),
			default => XlsxFormat::export($model),
		};
		$target = $this->books->folderAt($userId, $folder);
		if (!$target->isCreatable()) {
			throw new NotPermittedException('that folder is read only');
		}
		$stem = FileNames::clean($name);
		if ($stem === '') {
			$stem = 'Book';
		}
		$file = $target->newFile(FileNames::free($target, $stem, '.' . $format), $bytes);
		return ['id' => $file->getId(), 'path' => $file->getPath(), 'name' => $file->getName()];
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
