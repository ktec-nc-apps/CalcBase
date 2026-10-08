<?php
/**
 * #39 (CalcBase BUGS): the typefaces work as EditBase's. The Google Fonts
 * catalogue ships with the app and is answered at /api/fonts, and the page lets
 * the browser fetch Google's stylesheet and font files -- without that the
 * picker has nothing to list and a chosen family never reaches the screen.
 *
 * Run: php tests/fonts_test.php   (CALCBASE_LIB=<an older lib/> to see it fail there)
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';

use OCA\CalcBase\Controller\ApiController;
use OCA\CalcBase\Controller\PageController;

$root = dirname(CB_LIB);

// the catalogue: the same file as EditBase's, with the families the screen knows without it
$file = $root . '/data/google-fonts.json';
check('data/google-fonts.json is there', is_file($file));
$data = is_file($file) ? json_decode((string)file_get_contents($file), true) : null;
$families = is_array($data) && isset($data['families']) && is_array($data['families']) ? $data['families'] : [];
check('it lists over a thousand families', count($families) > 1000, (string)count($families));
$names = array_column($families, 'f');
foreach (['Noto Sans JP', 'BIZ UDPGothic', 'Source Sans 3', 'Noto Serif JP'] as $f) {
	check('the catalogue has ' . $f, in_array($f, $names, true));
}
$jp = $families[array_search('Noto Sans JP', $names, true)] ?? [];
check('a family says its category, scripts and weights', ($jp['c'] ?? '') === 'sans' && in_array('japanese', $jp['s'] ?? [], true) && in_array(700, $jp['w'] ?? [], true), json_encode($jp));
check('the scripts are listed for the picker', in_array('japanese', $data['scripts'] ?? [], true));

// the route and the controller's answer
$routes = require $root . '/appinfo/routes.php';
$hit = array_values(array_filter($routes['routes'], static fn ($r) => ($r['url'] ?? '') === '/api/fonts'));
check('GET /api/fonts is a route to api#fonts', $hit !== [] && $hit[0]['name'] === 'api#fonts' && $hit[0]['verb'] === 'GET', json_encode($hit));
$api = attempt('ApiController can be built', static fn () => (new ReflectionClass(ApiController::class))->newInstanceWithoutConstructor());
if ($api !== null) {
	$ok = method_exists($api, 'fonts');
	check('ApiController has fonts()', $ok);
	if ($ok) {
		$attrs = array_map(static fn ($a) => $a->getName(), (new ReflectionMethod($api, 'fonts'))->getAttributes());
		check('fonts() is open to every account (NoAdminRequired)', in_array('OCP\\AppFramework\\Http\\Attribute\\NoAdminRequired', $attrs, true), implode(',', $attrs));
		$resp = attempt('fonts() answers', static function () use ($api) {
			// run() reads nothing of the request or the session for this one
			$m = new ReflectionMethod($api, 'fonts');
			return $m->invoke($api);
		});
		$json = $resp ? $resp->getData() : null;
		check('fonts() answers the catalogue', is_array($json) && count($json['families'] ?? []) === count($families), is_array($json) ? (string)count($json['families'] ?? []) : 'null');
	}
}

// the page's policy: Google's stylesheet and its font files, and nothing else added
$ok = method_exists(PageController::class, 'policy');
check('PageController sets a policy of its own', $ok);
if ($ok) {
	$csp = PageController::policy();
	$header = $csp->buildPolicy();
	check('the stylesheet of Google Fonts may be loaded', str_contains($header, 'https://fonts.googleapis.com') && preg_match('/style-src[^;]*fonts\.googleapis\.com/', $header) === 1, $header);
	check('the font files of Google Fonts may be loaded', preg_match('/font-src[^;]*fonts\.gstatic\.com/', $header) === 1, $header);
	check('no script source is added', preg_match('/script-src[^;]*(googleapis|gstatic)/', $header) !== 1, $header);
	$src = (string)file_get_contents(CB_LIB . '/Controller/PageController.php');
	check('index() puts the policy on the page', str_contains($src, 'setContentSecurityPolicy($this->policy())') || str_contains($src, 'setContentSecurityPolicy(self::policy())'));
}

finish();
