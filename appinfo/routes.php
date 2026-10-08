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
		// the Google Fonts catalogue that ships with the app (data/google-fonts.json), as EditBase's
		['name' => 'api#fonts', 'url' => '/api/fonts', 'verb' => 'GET'],

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

		// categories (folders inside the save folder) and sharing with other accounts here
		['name' => 'api#folders', 'url' => '/api/folders', 'verb' => 'GET'],
		['name' => 'api#makeFolder', 'url' => '/api/folders', 'verb' => 'POST'],
		['name' => 'api#deleteFolder', 'url' => '/api/folders', 'verb' => 'DELETE'],
		['name' => 'api#folderId', 'url' => '/api/folders/id', 'verb' => 'GET'],
		['name' => 'api#bookShares', 'url' => '/api/books/{id}/shares', 'verb' => 'GET'],
		['name' => 'api#shareBook', 'url' => '/api/books/{id}/shares', 'verb' => 'POST'],
		['name' => 'api#unshareBook', 'url' => '/api/books/{id}/shares/remove', 'verb' => 'POST'],
		['name' => 'api#findUsers', 'url' => '/api/users', 'verb' => 'GET'],

		// the sample books that come with the app
		['name' => 'api#samples', 'url' => '/api/samples', 'verb' => 'GET'],
		['name' => 'api#giveSamples', 'url' => '/api/samples', 'verb' => 'POST'],

		// the user's Files: a folder and file picker, and other formats in and out
		['name' => 'api#browseFiles', 'url' => '/api/files/browse', 'verb' => 'GET'],
		['name' => 'api#import', 'url' => '/api/import', 'verb' => 'POST'],
		['name' => 'api#export', 'url' => '/api/export', 'verb' => 'POST'],

		// the other apps on this server, each as sheets
		['name' => 'api#sources', 'url' => '/api/sources', 'verb' => 'GET'],
		['name' => 'api#regibaseCollections', 'url' => '/api/import/regibase', 'verb' => 'GET'],
		['name' => 'api#regibase', 'url' => '/api/import/regibase/{id}', 'verb' => 'GET'],
		['name' => 'api#formulaCollections', 'url' => '/api/import/formulabase', 'verb' => 'GET'],
		['name' => 'api#formulabase', 'url' => '/api/import/formulabase/{id}', 'verb' => 'GET'],
		['name' => 'api#editbaseDocuments', 'url' => '/api/import/editbase', 'verb' => 'GET'],
		['name' => 'api#editbase', 'url' => '/api/import/editbase/{id}', 'verb' => 'GET'],
		['name' => 'api#netbase', 'url' => '/api/import/netbase', 'verb' => 'GET'],
		['name' => 'api#tables', 'url' => '/api/import/tables', 'verb' => 'GET'],
		['name' => 'api#table', 'url' => '/api/import/tables/{id}', 'verb' => 'GET'],
		['name' => 'api#contacts', 'url' => '/api/import/contacts', 'verb' => 'GET'],
		['name' => 'api#calendars', 'url' => '/api/import/calendars', 'verb' => 'GET'],
		['name' => 'api#events', 'url' => '/api/import/calendar', 'verb' => 'GET'],
		['name' => 'api#importWeb', 'url' => '/api/import/web', 'verb' => 'GET'],
		['name' => 'api#importMarkdown', 'url' => '/api/import/markdown', 'verb' => 'POST'],
	],
];
