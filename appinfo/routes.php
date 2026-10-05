<?php

declare(strict_types=1);

return [
	'routes' => [
		['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],

		// the AI assistant (through AI-Hub)
		['name' => 'ai#status', 'url' => '/api/ai/status', 'verb' => 'GET'],
		['name' => 'ai#ask', 'url' => '/api/ai/ask', 'verb' => 'POST'],
		['name' => 'ai#result', 'url' => '/api/ai/result/{id}', 'verb' => 'GET'],
		['name' => 'ai#saveAdmin', 'url' => '/api/ai/admin', 'verb' => 'POST'],

		// settings & translations
		['name' => 'api#getSettings', 'url' => '/api/settings', 'verb' => 'GET'],
		['name' => 'api#saveSettings', 'url' => '/api/settings', 'verb' => 'POST'],
		['name' => 'api#getI18n', 'url' => '/api/i18n/{lang}', 'verb' => 'GET'],

		// books (plain .html files in the user's own Files)
		['name' => 'api#books', 'url' => '/api/books', 'verb' => 'GET'],
		['name' => 'api#createBook', 'url' => '/api/books', 'verb' => 'POST'],
		['name' => 'api#getBook', 'url' => '/api/books/{id}', 'verb' => 'GET'],
		['name' => 'api#saveBook', 'url' => '/api/books/{id}', 'verb' => 'PUT'],
		['name' => 'api#deleteBook', 'url' => '/api/books/{id}', 'verb' => 'DELETE'],
		['name' => 'api#renameBook', 'url' => '/api/books/{id}/rename', 'verb' => 'POST'],
		['name' => 'api#duplicateBook', 'url' => '/api/books/{id}/duplicate', 'verb' => 'POST'],
		['name' => 'api#moveBook', 'url' => '/api/books/{id}/move', 'verb' => 'POST'],
		['name' => 'api#bookVersions', 'url' => '/api/books/{id}/versions', 'verb' => 'GET'],
		['name' => 'api#readVersion', 'url' => '/api/books/{id}/versions/{number}', 'verb' => 'GET'],
		['name' => 'api#restoreVersion', 'url' => '/api/books/{id}/versions/restore', 'verb' => 'POST'],

		// the user's Files: a folder and file picker, and other formats in and out
		['name' => 'api#browseFiles', 'url' => '/api/files/browse', 'verb' => 'GET'],
		['name' => 'api#import', 'url' => '/api/import', 'verb' => 'POST'],
		['name' => 'api#export', 'url' => '/api/export', 'verb' => 'POST'],
	],
];
