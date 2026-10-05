<?php

declare(strict_types=1);

namespace OCA\CalcBase\Controller;

use OCA\CalcBase\AppInfo\Application;
use OCA\CalcBase\Service\BookService;
use OCA\CalcBase\Service\FileBrowser;
use OCA\CalcBase\Service\ImportExport;
use OCA\CalcBase\Service\VersionService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\JSONResponse;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUserSession;
use Psr\Log\LoggerInterface;

class ApiController extends Controller {
	private const ALLOWED_THEMES = ['auto', 'dark', 'light'];

	public function __construct(
		IRequest $request,
		private BookService $books,
		private FileBrowser $files,
		private ImportExport $formats,
		private VersionService $versions,
		private IUserSession $userSession,
		private IConfig $config,
		private LoggerInterface $logger,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	private function uid(): string {
		$user = $this->userSession->getUser();
		if ($user === null) {
			throw new NotPermittedException('not logged in');
		}
		return $user->getUID();
	}

	/** One place to turn the service's exceptions into honest status codes. */
	private function run(callable $fn): JSONResponse {
		try {
			return new JSONResponse($fn());
		} catch (NotFoundException $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		} catch (NotPermittedException $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_FORBIDDEN);
		} catch (\InvalidArgumentException $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		} catch (\Throwable $e) {
			// The app's own sentences (a plain RuntimeException: "somebody else is
			// saving this book…") are for the screen. Anything else -- a database
			// error, a library's -- is for the log: its words can carry paths and
			// queries, and must not be handed to the browser (EditBase review 2026-10-04, 低7).
			if ($e::class === \RuntimeException::class) {
				return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_INTERNAL_SERVER_ERROR);
			}
			$this->logger->error('CalcBase: ' . $e->getMessage(), ['app' => Application::APP_ID, 'exception' => $e]);
			return new JSONResponse(['error' => 'something went wrong on the server; the log says what'], Http::STATUS_INTERNAL_SERVER_ERROR);
		}
	}

	#[NoAdminRequired]
	public function getSettings(): JSONResponse {
		return $this->run(function () {
			$uid = $this->uid();
			$get = fn (string $k, string $d): string => $this->config->getUserValue($uid, Application::APP_ID, $k, $d);
			return [
				'folder' => $this->books->folderName($uid),
				'theme' => $get('theme', 'auto'),
				'language' => $get('language', 'auto'),
				// Whether the book is saved as it is edited (on unless chosen otherwise).
				'autosave' => $get('autosave', '1'),
				// How many versions of a book are kept beside it, and when one is
				// taken: every save, or only the ones the writer asks for.
				'versionKeep' => $this->versions->keep($uid),
				'versionWhen' => $this->versions->when($uid),
				// Where Enter takes the cursor after a cell is entered.
				'enterMoves' => $get('enterMoves', 'down'),
				// The width of the AI panel: pixels, or a percentage of the window.
				'aiWidth' => $get('aiWidth', '500px'),
				// Gridlines on a new sheet; the typeface and size a new book starts with.
				'gridDefault' => $get('gridDefault', '1'),
				'font' => $get('font', ''),
				'fontSize' => $get('fontSize', '11'),
				'languages' => $this->availableLanguages(),
				// What the browser has loaded is not always what is on the server: a
				// page left open goes on running the code it started with. This is
				// how the app can tell, and say so.
				'build' => $this->buildStamp(),
			];
		});
	}

	/** The build the server is serving: the app's own script, by size and time. */
	private function buildStamp(): string {
		$file = __DIR__ . '/../../js/calcbase.dist.js';
		if (!is_readable($file)) {
			return '';
		}
		return substr(md5((string)filemtime($file) . ':' . (string)filesize($file)), 0, 12);
	}

	#[NoAdminRequired]
	public function saveSettings(): JSONResponse {
		return $this->run(function () {
			$uid = $this->uid();
			$set = fn (string $k, string $v) => $this->config->setUserValue($uid, Application::APP_ID, $k, $v);
			$folder = $this->request->getParam('folder');
			if (is_string($folder) && $folder !== '') {
				$this->books->setFolderName($uid, $folder);
			}
			$theme = $this->request->getParam('theme');
			if (is_string($theme) && in_array($theme, self::ALLOWED_THEMES, true)) {
				$set('theme', $theme);
			}
			$language = $this->request->getParam('language');
			if (is_string($language) && $language !== '' && preg_match('/^[a-z]{2}(_[A-Za-z]{2,4})?$|^auto$/', $language)) {
				$set('language', $language);
			}
			$keep = $this->request->getParam('versionKeep');
			if ($keep !== null && $keep !== '') {
				$this->versions->setKeep($uid, (int)$keep);
			}
			$when = $this->request->getParam('versionWhen');
			if (is_string($when) && $when !== '') {
				$this->versions->setWhen($uid, $when);
			}
			foreach (['autosave', 'gridDefault'] as $flag) {
				$v = $this->request->getParam($flag);
				if ($v === '1' || $v === '0' || is_bool($v)) {
					$set($flag, $v === '1' || $v === true ? '1' : '0');
				}
			}
			$enter = $this->request->getParam('enterMoves');
			if ($enter === 'down' || $enter === 'right') {
				$set('enterMoves', $enter);
			}
			$w = $this->request->getParam('aiWidth');
			if (is_string($w) && preg_match('/^(\d{1,4}(?:\.\d{1,2})?)(px|%)$/', $w, $m)) {
				$n = (float)$m[1];
				if (($m[2] === 'px' && $n >= 240 && $n <= 1200) || ($m[2] === '%' && $n >= 15 && $n <= 60)) {
					$set('aiWidth', $w);
				}
			}
			$font = $this->request->getParam('font');
			if (is_string($font) && preg_match('/^[^<>"\'\\\\;{}]{0,100}$/u', $font)) {
				$set('font', trim($font));
			}
			$size = $this->request->getParam('fontSize');
			if (is_numeric($size) && (float)$size >= 6 && (float)$size <= 72) {
				$set('fontSize', (string)(float)$size);
			}
			return ['ok' => true];
		});
	}

	/**
	 * Translations for a language other than Nextcloud's own, so the app can be
	 * read in one language while the rest of the server stays in another.
	 */
	#[NoAdminRequired]
	public function getI18n(string $lang): JSONResponse {
		return $this->run(function () use ($lang) {
			if (!in_array($lang, $this->languageCodes(), true)) {
				throw new NotFoundException('unknown language');
			}
			$file = __DIR__ . '/../../l10n/' . $lang . '.json';
			if (!is_file($file)) {
				return ['translations' => new \stdClass()];
			}
			$data = json_decode((string)file_get_contents($file), true);
			return ['translations' => $data['translations'] ?? new \stdClass()];
		});
	}

	// ---- books ----

	#[NoAdminRequired]
	public function books(): JSONResponse {
		return $this->run(fn () => ['books' => $this->books->list($this->uid())]);
	}

	#[NoAdminRequired]
	public function createBook(): JSONResponse {
		return $this->run(function () {
			$name = (string)($this->request->getParam('name') ?? 'Book');
			$content = $this->request->getParam('content');
			$folder = (string)($this->request->getParam('folder') ?? '');
			return $this->books->create($this->uid(), $name, is_string($content) ? $content : '', $folder);
		});
	}

	#[NoAdminRequired]
	public function getBook(int $id): JSONResponse {
		return $this->run(fn () => $this->books->get($this->uid(), $id));
	}

	/**
	 * Write a book back. When the file has moved on since the browser read it
	 * (another save, from another window or person), nothing is written: the
	 * answer is 409 with what is there now, for the browser to take in.
	 */
	#[NoAdminRequired]
	public function saveBook(int $id): JSONResponse {
		$response = $this->run(function () use ($id) {
			$content = $this->request->getParam('content');
			if (!is_string($content)) {
				throw new \InvalidArgumentException('content missing');
			}
			$etag = (string)($this->request->getParam('etag') ?? '');
			$manual = (bool)($this->request->getParam('manual') ?? false);
			return $this->books->save($this->uid(), $id, $content, $etag, $manual);
		});
		$data = $response->getData();
		if (is_array($data) && !empty($data['stale'])) {
			$response->setStatus(Http::STATUS_CONFLICT);
		}
		return $response;
	}

	#[NoAdminRequired]
	public function deleteBook(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$this->books->delete($this->uid(), $id);
			return ['ok' => true];
		});
	}

	#[NoAdminRequired]
	public function renameBook(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$name = (string)($this->request->getParam('name') ?? '');
			if (trim($name) === '') {
				throw new \InvalidArgumentException('name missing');
			}
			return $this->books->rename($this->uid(), $id, $name);
		});
	}

	#[NoAdminRequired]
	public function duplicateBook(int $id): JSONResponse {
		return $this->run(fn () => $this->books->duplicate($this->uid(), $id));
	}

	#[NoAdminRequired]
	public function moveBook(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$path = (string)($this->request->getParam('folder') ?? '');
			return $this->books->move($this->uid(), $id, $path);
		});
	}

	#[NoAdminRequired]
	public function bookVersions(int $id): JSONResponse {
		return $this->run(fn () => ['versions' => $this->books->versions($this->uid(), $id)]);
	}

	#[NoAdminRequired]
	public function readVersion(int $id, int $number): JSONResponse {
		return $this->run(fn () => ['content' => $this->books->readVersion($this->uid(), $id, $number)]);
	}

	#[NoAdminRequired]
	public function restoreVersion(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$number = (int)($this->request->getParam('number') ?? 0);
			return $this->books->restoreVersion($this->uid(), $id, $number);
		});
	}

	// ---- the user's Files ----

	#[NoAdminRequired]
	public function browseFiles(): JSONResponse {
		return $this->run(fn () => $this->files->browse($this->uid(), (string)($this->request->getParam('path') ?? '')));
	}

	#[NoAdminRequired]
	public function import(): JSONResponse {
		return $this->run(function () {
			$fileId = (int)($this->request->getParam('fileId') ?? 0);
			if ($fileId <= 0) {
				throw new \InvalidArgumentException('fileId missing');
			}
			return $this->formats->import($this->uid(), $fileId);
		});
	}

	#[NoAdminRequired]
	public function export(): JSONResponse {
		return $this->run(function () {
			$model = $this->request->getParam('model');
			if (is_string($model)) {
				$model = json_decode($model, true);
			}
			return $this->formats->export(
				$this->uid(),
				(string)($this->request->getParam('format') ?? ''),
				$model,
				(string)($this->request->getParam('folder') ?? ''),
				(string)($this->request->getParam('name') ?? 'Book'),
				(string)($this->request->getParam('sheet') ?? ''),
			);
		});
	}

	/** @return array<int, array<string, string>> */
	private function availableLanguages(): array {
		$names = [
			'ja' => '日本語', 'en' => 'English', 'zh' => '简体中文', 'es' => 'Español',
			'fr' => 'Français', 'de' => 'Deutsch', 'ru' => 'Русский', 'pt' => 'Português',
			'ar' => 'العربية', 'hi' => 'हिन्दी', 'ko' => '한국어', 'it' => 'Italiano',
		];
		$out = [];
		foreach (glob(__DIR__ . '/../../l10n/*.json') ?: [] as $path) {
			$code = basename($path, '.json');
			$out[] = ['code' => $code, 'name' => $names[$code] ?? $code];
		}
		return $out;
	}

	/** @return array<int, string> */
	private function languageCodes(): array {
		return array_map(static fn (array $l): string => $l['code'], $this->availableLanguages());
	}
}
