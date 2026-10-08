<?php

declare(strict_types=1);

namespace OCA\CalcBase\Controller;

use OCA\CalcBase\AppInfo\Application;
use OCA\CalcBase\Service\BookService;
use OCA\CalcBase\Service\Connectors;
use OCA\CalcBase\Service\FetchRefused;
use OCA\CalcBase\Service\FileBrowser;
use OCA\CalcBase\Service\ImportExport;
use OCA\CalcBase\Service\Model;
use OCA\CalcBase\Service\SampleService;
use OCA\CalcBase\Service\ShareService;
use OCA\CalcBase\Service\SourceSheets;
use OCA\CalcBase\Service\TextEncoding;
use OCA\CalcBase\Service\VersionService;
use OCA\CalcBase\Service\WebFetch;
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
		private Connectors $connectors,
		private SourceSheets $sources,
		private ShareService $sharing,
		private SampleService $samples,
		private WebFetch $web,
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
		} catch (FetchRefused $e) {
			return new JSONResponse(['error' => $e->getMessage()], $e->status());
		} catch (\OCP\AppFramework\Db\DoesNotExistException $e) {
			// Another app's record that is not there, or not this person's: the same
			// answer for both, so asking does not tell whose ids exist.
			return new JSONResponse(['error' => 'not found'], Http::STATUS_NOT_FOUND);
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

	/** A request parameter as a string, '' when it is not there. */
	private function str(string $name): string {
		$v = $this->request->getParam($name);
		return is_scalar($v) ? (string)$v : '';
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
				// The width of the sheet bar at the right (EditBase's preview bar).
				'sheetsWidth' => $get('sheetsWidth', '132px'),
				// Gridlines on a new sheet; the typeface and size a new book starts with.
				'gridDefault' => $get('gridDefault', '1'),
				// The tabs under the sheet: off unless asked for -- the sheet bar shows the sheets (the owner, 2026-10-06).
				'sheetTabs' => $get('sheetTabs', '0'),
				// How big a book may be, in cells; 0 = no limit, at the writer's own risk (Model::CELL_LIMITS).
				'cellLimit' => (static fn (array $l): int => $l['bytes'] === 0 ? 0 : $l['cells'])($this->books->limits($uid)),
				'font' => $get('font', ''),
				'fontSize' => $get('fontSize', '11'),
				// The unit the column width and row height are asked in (EditBase's unit for the ruler; Calc's measurement unit).
				'unit' => $get('unit', 'px'),
				// The paper setup a new book starts from (JSON, produced by the screen).
				'paper' => $get('paper', ''),
				// What colour each category is drawn in, and the order of the books in each, as the writer chose.
				'folderColours' => $get('folderColours', ''),
				'bookOrder' => $get('bookOrder', ''),
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
			foreach (['autosave', 'gridDefault', 'sheetTabs'] as $flag) {
				$v = $this->request->getParam($flag);
				if ($v === '1' || $v === '0' || is_bool($v)) {
					$set($flag, $v === '1' || $v === true ? '1' : '0');
				}
			}
			$cellLimit = $this->request->getParam('cellLimit');
			if (is_numeric($cellLimit) && in_array((int)$cellLimit, Model::CELL_LIMITS, true)) {
				$set('cellLimit', (string)(int)$cellLimit);
			}
			$enter = $this->request->getParam('enterMoves');
			if ($enter === 'down' || $enter === 'right') {
				$set('enterMoves', $enter);
			}
			// The widths of the AI panel and the sheet bar: pixels, or a percentage of the window.
			foreach (['aiWidth' => [240, 15], 'sheetsWidth' => [60, 3]] as $key => [$minPx, $minPct]) {
				$w = $this->request->getParam($key);
				if (is_string($w) && preg_match('/^(\d{1,4}(?:\.\d{1,2})?)(px|%)$/', $w, $m)) {
					$n = (float)$m[1];
					if (($m[2] === 'px' && $n >= $minPx && $n <= 1200) || ($m[2] === '%' && $n >= $minPct && $n <= 60)) {
						$set($key, $w);
					}
				}
			}
			$font = $this->request->getParam('font');
			if (is_string($font) && preg_match('/^[^<>"\'\\\\;{}]{0,100}$/u', $font)) {
				$set('font', trim($font));
			}
			$unit = $this->request->getParam('unit');
			if (is_string($unit) && in_array($unit, ['px', 'pt', 'mm', 'cm', 'in'], true)) {
				$set('unit', $unit);
			}
			$size = $this->request->getParam('fontSize');
			if (is_numeric($size) && (float)$size >= 6 && (float)$size <= 72) {
				$set('fontSize', (string)(float)$size);
			}
			$paper = $this->request->getParam('paper');
			if (is_string($paper) && strlen($paper) < 4000) {
				$set('paper', $paper);
			}
			$colours = $this->request->getParam('folderColours');
			if (is_string($colours) && strlen($colours) < 4000) {
				$set('folderColours', $colours);
			}
			// The order of the books in each category (the ids), kept only when the writer sorted them by hand.
			$order = $this->request->getParam('bookOrder');
			if (is_string($order) && strlen($order) < 200000) {
				$parsed = json_decode($order, true);
				if (is_array($parsed)) {
					$clean = [];
					foreach ($parsed as $cat => $ids) {
						// The key is "c:<category>", so a category whose name is a number does not become a list.
						if (is_string($cat) && strncmp($cat, 'c:', 2) === 0 && strlen($cat) < 300 && is_array($ids)) {
							$clean[$cat] = array_values(array_map('intval', array_filter($ids, 'is_numeric')));
						}
					}
					$set('bookOrder', $clean ? json_encode($clean, JSON_UNESCAPED_UNICODE) : '{}');
				}
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
		// A freshly installed or upgraded app gives the sample books once (SampleService).
		return $this->run(function () {
			$uid = $this->uid();
			$this->samples->ensure($uid);
			return ['books' => $this->books->list($uid)];
		});
	}

	#[NoAdminRequired]
	public function createBook(): JSONResponse {
		return $this->run(function () {
			$name = (string)($this->request->getParam('name') ?? 'Book');
			$content = $this->request->getParam('content');
			$folder = $this->str('folder');
			$folderId = (int)($this->request->getParam('folderId') ?? 0);
			return $this->books->create($this->uid(), $name, is_string($content) ? $content : '', $folder, $folderId);
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
			$etag = $this->str('etag');
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
			$name = $this->str('name');
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
		return $this->run(fn () => $this->books->move($this->uid(), $id, $this->str('folder')));
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

	// ---- categories ----

	#[NoAdminRequired]
	public function folders(): JSONResponse {
		return $this->run(fn () => ['folders' => $this->books->folders($this->uid())]);
	}

	/** A category's own id, so it can be shared the way a book is. */
	#[NoAdminRequired]
	public function folderId(): JSONResponse {
		return $this->run(fn () => ['id' => $this->books->folderId($this->uid(), $this->str('path'))]);
	}

	#[NoAdminRequired]
	public function makeFolder(): JSONResponse {
		return $this->run(fn () => ['folder' => $this->books->makeFolder($this->uid(), $this->str('path'))]);
	}

	#[NoAdminRequired]
	public function deleteFolder(): JSONResponse {
		return $this->run(function () {
			$path = $this->str('path');
			$this->books->deleteFolder($this->uid(), $path);
			return ['deleted' => $path];
		});
	}

	// ---- sharing ----

	#[NoAdminRequired]
	public function bookShares(int $id): JSONResponse {
		return $this->run(fn () => ['shares' => $this->sharing->listShares($this->uid(), $id)]);
	}

	#[NoAdminRequired]
	public function shareBook(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$with = $this->str('with');
			$canEdit = (bool)($this->request->getParam('canEdit') ?? false);
			return ['shares' => $this->sharing->share($this->uid(), $id, $with, $canEdit)];
		});
	}

	#[NoAdminRequired]
	public function unshareBook(int $id): JSONResponse {
		return $this->run(fn () => ['shares' => $this->sharing->unshare($this->uid(), $id, $this->str('share'))]);
	}

	#[NoAdminRequired]
	public function findUsers(): JSONResponse {
		return $this->run(function () {
			// ?search= (SPEC2) or ?term= (EditBase's screen): the same question.
			$term = $this->str('search') !== '' ? $this->str('search') : $this->str('term');
			return ['users' => $this->sharing->findUsers($this->uid(), $term)];
		});
	}

	// ---- the sample books ----

	#[NoAdminRequired]
	public function samples(): JSONResponse {
		return $this->run(fn () => $this->samples->status($this->uid()));
	}

	/** Put the sample books into the writer's folder again (the ones they deleted too). */
	#[NoAdminRequired]
	public function giveSamples(): JSONResponse {
		return $this->run(fn () => $this->samples->give($this->uid(), true));
	}

	// ---- typefaces ----

	/**
	 * The Google Fonts catalogue that ships with the app (data/google-fonts.json),
	 * as EditBase's: the picker works without calling Google at all, and the font
	 * files themselves are fetched by the browser only once a family is in use.
	 */
	#[NoAdminRequired]
	public function fonts(): JSONResponse {
		return $this->run(function () {
			$file = __DIR__ . '/../../data/google-fonts.json';
			if (!is_file($file)) {
				return ['families' => [], 'count' => 0];
			}
			$data = json_decode((string)file_get_contents($file), true);
			return is_array($data) ? $data : ['families' => [], 'count' => 0];
		});
	}

	// ---- the user's Files ----

	#[NoAdminRequired]
	public function browseFiles(): JSONResponse {
		return $this->run(fn () => $this->files->browse($this->uid(), $this->str('path')));
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
				$this->str('format'),
				$model,
				$this->str('folder'),
				(string)($this->request->getParam('name') ?? 'Book'),
				$this->str('sheet'),
			);
		});
	}

	// ---- the other apps on this server, each as sheets (SPEC2 §B) ----

	#[NoAdminRequired]
	public function sources(): JSONResponse {
		return $this->run(fn () => ['sources' => $this->connectors->available($this->uid())]);
	}

	#[NoAdminRequired]
	public function regibaseCollections(): JSONResponse {
		return $this->run(fn () => $this->sources->regibaseCollections($this->uid()));
	}

	#[NoAdminRequired]
	public function regibase(int $id): JSONResponse {
		return $this->run(fn () => $this->sources->regibase($this->uid(), $id));
	}

	#[NoAdminRequired]
	public function formulaCollections(): JSONResponse {
		return $this->run(fn () => $this->sources->formulaCollections($this->uid()));
	}

	#[NoAdminRequired]
	public function formulabase(int $id): JSONResponse {
		return $this->run(fn () => $this->sources->formulabase($this->uid(), $id));
	}

	#[NoAdminRequired]
	public function editbaseDocuments(): JSONResponse {
		return $this->run(fn () => $this->sources->editbaseDocuments($this->uid()));
	}

	#[NoAdminRequired]
	public function editbase(int $id): JSONResponse {
		return $this->run(fn () => $this->sources->editbase($this->uid(), $id));
	}

	#[NoAdminRequired]
	public function netbase(): JSONResponse {
		return $this->run(fn () => $this->sources->netbase($this->uid()));
	}

	#[NoAdminRequired]
	public function tables(): JSONResponse {
		return $this->run(fn () => $this->sources->tables($this->uid()));
	}

	#[NoAdminRequired]
	public function table(int $id): JSONResponse {
		return $this->run(fn () => $this->sources->table($this->uid(), $id));
	}

	#[NoAdminRequired]
	public function contacts(): JSONResponse {
		return $this->run(fn () => $this->sources->contacts($this->uid(), $this->str('q')));
	}

	#[NoAdminRequired]
	public function calendars(): JSONResponse {
		return $this->run(fn () => $this->sources->calendars($this->uid()));
	}

	#[NoAdminRequired]
	public function events(): JSONResponse {
		return $this->run(function () {
			$from = $this->str('from');
			$to = $this->str('to');
			if ($from === '' || $to === '') {
				throw new \InvalidArgumentException('a date range is required');
			}
			return $this->sources->events($this->uid(), $from, $to, $this->str('cal') !== '' ? $this->str('cal') : $this->str('calendar'));
		});
	}

	/**
	 * The tables of a web page. The browser cannot read another site's page
	 * itself, so the server asks for it -- only http and https, never this server
	 * itself or a link-local address unless an administrator allows it (WebFetch),
	 * and only what the page shows as tables is handed back, as cells.
	 */
	#[NoAdminRequired]
	public function importWeb(): JSONResponse {
		return $this->run(function () {
			$url = $this->str('url');
			if ($url === '') {
				throw new \InvalidArgumentException('a web address is required');
			}
			$got = $this->web->get(
				$url,
				'text/html,application/xhtml+xml',
				WebFetch::PAGE_BYTES,
				true,
				// No Content-Type at all is taken for a page, as it always was.
				static fn (string $type): bool => $type === '' || stripos($type, 'html') !== false,
				'that address is not a web page',
				'that page is too large',
			);
			// Half the Japanese web is still Shift_JIS: the bytes are read for what
			// they are before anything is made of them (TextEncoding).
			$said = TextEncoding::declaredInContentType($got['type']);
			if ($said === '') {
				$said = TextEncoding::declaredInHtml($got['body']);
			}
			$read = TextEncoding::htmlToUtf8($got['body'], $said);
			$out = SourceSheets::web($got['url'], $read['text']);
			$out['truncated'] = $got['truncated'];
			return $out;
		});
	}

	/** The pipe tables of a Markdown file in the writer's Files. */
	#[NoAdminRequired]
	public function importMarkdown(): JSONResponse {
		return $this->run(function () {
			$fileId = (int)($this->request->getParam('fileId') ?? 0);
			if ($fileId <= 0) {
				throw new \InvalidArgumentException('fileId missing');
			}
			$file = $this->files->markdown($this->uid(), $fileId);
			return SourceSheets::markdown($file['content'], $fileId, $file['name']);
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
