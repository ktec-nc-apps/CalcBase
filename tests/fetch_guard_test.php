<?php
/**
 * Regression test: what the web import (api/import/web) will connect to, and what
 * it says when something goes wrong (EditBase review S1, S8, S13, carried into
 * CalcBase: the same WebFetch, now bringing in the tables of a page).
 *
 * Nextcloud's own HTTP client is used as it is, with allow_local_remote_servers
 * on -- as on this server, where it switches Nextcloud's guard off entirely -- and
 * only the network itself replaced: a fake transport that answers like curl would
 * (headers first, then the body a piece at a time into the sink) and records every
 * request that reached it. Names resolve from a table.
 *
 *   - this server itself (127/8, ::1, 0.0.0.0, its own interface addresses) and
 *     link-local addresses (169.254/16 incl. the metadata address, fe80::/10) are
 *     refused before anything is sent: as numbers, as IPv4-in-IPv6, in hex, behind
 *     a name, behind a name with one good address among bad ones, behind a redirect;
 *   - the connection is held to the address that was checked (CURLOPT_RESOLVE);
 *   - an administrator can allow them; the local network is allowed anyway;
 *   - errors say a few plain words: no upstream text, no internal address;
 *   - addresses with Japanese in them are read (IDN host, percent-encoded path);
 *   - redirects: at most five, relative ones resolved, final address handed back.
 *
 * Run: php tests/fetch_guard_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';

use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Exception\RequestException;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Promise\Create;
use GuzzleHttp\Psr7\Response as GResponse;
use GuzzleHttp\Psr7\Utils;
use OCA\CalcBase\Service\WebFetch;
use Psr\Http\Message\RequestInterface;

if (class_exists(WebFetch::class)) {
	/** Names resolve from a table; this server's addresses are given. */
	class TestFetch extends WebFetch {
		public array $zone = [];
		public array $ownList = ['127.0.0.1', '10.0.0.1', '172.18.0.1'];
		protected function addressesOf(string $host): array {
			return $this->zone[$host] ?? [];
		}
		protected function ownAddresses(): array {
			return $this->ownList;
		}
	}
}

/** The answers the fake network gives, by host+path or host. */
$table = '<table><tr><th>Item</th><th>Qty</th></tr><tr><td>new</td><td>3</td></tr></table>';
$routes = [
	'public.example/redirect-to-metadata' => [302, ['Location' => 'http://169.254.169.254/latest/meta-data/'], ''],
	'public.example/old' => [301, ['Location' => '/new?x=1'], ''],
	'public.example/new' => [200, ['Content-Type' => 'text/html'], '<html><title>new</title>' . $table . '</html>'],
	'public.example/plain' => [200, ['Content-Type' => 'text/html'], '<html><title>plain</title><p>no table</p></html>'],
	'loop.example' => [302, ['Location' => 'http://loop.example/again'], ''],
	'lan.example/admin' => [401, ['Content-Type' => 'application/json'], '{"error":"unauthorized","internal_token":"abcd1234-internal","server":"backend-01.lan"}'],
	'lan.example/page.html' => [200, ['Content-Type' => 'text/plain'], 'not html'],
	'down.example' => 'connect-error',
	'example.jp' => [200, ['Content-Type' => 'text/html; charset=Shift_JIS'], mb_convert_encoding('<html><title>日本</title><table><tr><td>りんご</td><td>120</td></tr></table></html>', 'SJIS', 'UTF-8')],
	'192.168.1.1' => [200, ['Content-Type' => 'text/html'], '<html><title>nas</title>' . $table . '</html>'],
	'*' => [200, ['Content-Type' => 'text/html'], '<html><title>internal admin</title><table><tr><td>SECRET</td></tr></table></html>'],
];

$zone = [
	'public.example' => ['93.184.216.34'],
	'evil.example' => ['127.0.0.1'],
	'dual.example' => ['93.184.216.40', '127.0.0.1'],
	'self.example' => ['10.0.0.1'],
	'meta.example' => ['169.254.169.254'],
	'loop.example' => ['93.184.216.36'],
	'lan.example' => ['192.168.1.20'],
	'down.example' => ['192.168.1.30'],
	'example.jp' => ['93.184.216.35'],
	'xn--wgv71a119e.jp' => ['93.184.216.37'],
	'ja.wikipedia.org' => ['93.184.216.38'],
];

/** Nextcloud's client over the fake network. */
function client(array $routes, array &$log, bool $allowLocalSystem = true, ?callable $middleware = null): OCP\Http\Client\IClient {
	$sys = ['allow_local_remote_servers' => $allowLocalSystem, 'installed' => false, 'dns_pinning' => true];
	$config = stub(OCP\IConfig::class, [
		'getSystemValueBool' => static fn ($k, $d = false) => $sys[$k] ?? $d,
		'getSystemValueString' => static fn ($k, $d = '') => $d,
		'getSystemValue' => static fn ($k, $d = '') => $d,
	]);
	$logger = new Psr\Log\NullLogger();
	$handler = static function (RequestInterface $request, array $options) use ($routes, &$log) {
		$uri = $request->getUri();
		$log[] = ['url' => (string)$uri, 'resolve' => $options['curl'][CURLOPT_RESOLVE] ?? null];
		$route = $routes[$uri->getHost() . $uri->getPath()] ?? $routes[$uri->getHost()] ?? $routes['*'];
		if ($route === 'connect-error') {
			return Create::rejectionFor(new ConnectException('cURL error 7: Failed to connect to ' . $uri->getHost() . ' port 8080 after 1 ms: Couldn\'t connect to server (see https://curl.se/libcurl/c/libcurl-errors.html) for ' . $uri, $request));
		}
		[$status, $headers, $body] = $route;
		$response = new GResponse($status, $headers);
		// As curl does it: the headers first ...
		if (isset($options['on_headers'])) {
			try {
				($options['on_headers'])($response);
			} catch (\Throwable $e) {
				return Create::rejectionFor(new RequestException('An error was encountered during the on_headers event', $request, $response, $e));
			}
		}
		// ... then the body, a piece at a time, into the sink.
		$sink = Utils::streamFor($options['sink'] ?? fopen('php://temp', 'w+'));
		foreach (str_split($body, 4096) as $chunk) {
			if ($sink->write($chunk) !== strlen($chunk)) {
				return Create::rejectionFor(new RequestException('cURL error 23: Failure writing output to destination', $request, $response));
			}
		}
		$sink->rewind();
		return Create::promiseFor($response->withBody($sink));
	};
	$stack = HandlerStack::create($handler);
	if ($middleware !== null) {
		$stack->push($middleware);
	}
	return new OC\Http\Client\Client($config, stub(OCP\ICertificateManager::class, [
		'getDefaultCertificatesBundlePath' => static fn () => CB_NC . '/resources/config/ca-bundle.crt',
	]), new GuzzleHttp\Client(['handler' => $stack]), new OC\Security\RemoteHostValidator($config, new OC\Net\HostnameClassifier(), new OC\Net\IpAddressClassifier(), $logger), $logger, new OCP\ServerVersion());
}

/** The controller as it is built from its parts, before and after. */
function api(array $routes, array $zone, array &$log, array $app = [], bool $allowLocalSystem = true, ?callable $middleware = null): OCA\CalcBase\Controller\ApiController {
	$client = client($routes, $log, $allowLocalSystem, $middleware);
	$service = stub(OCP\Http\Client\IClientService::class, ['newClient' => static fn () => $client]);
	$props = ['clientService' => $service];
	if (class_exists(WebFetch::class)) {
		$config = stub(OCP\IConfig::class, ['getAppValue' => static fn ($a, $k, $d = '') => $app[$k] ?? $d]);
		$web = new TestFetch($service, $config, new Psr\Log\NullLogger());
		$web->zone = $zone;
		$props['web'] = $web;
	}
	return apiController('alice', $props, ['url' => $GLOBALS['cb_url'] ?? '']);
}

/** @return array{0: int, 1: array} */
function call(string $what, string $url, array $routes, array $zone, array &$log, array $app = []): array {
	$GLOBALS['cb_url'] = $url;
	$api = api($routes, $zone, $log, $app);
	$r = $api->importWeb();
	return [$r->getStatus(), $r->getData()];
}

echo "--- this server itself and link-local addresses are refused, and nothing is sent ---\n";
$refused = [
	['page', 'http://127.0.0.1:9980/hosting/discovery', 'loopback address'],
	['page', 'http://[::ffff:7f00:1]/', 'IPv4 loopback written as IPv6'],
	['page', 'http://[::1]:8080/', 'IPv6 loopback'],
	['page', 'http://0x7f.1/', 'loopback written in hex'],
	['page', 'http://2130706433/', 'loopback written as one number'],
	['page', 'http://0.0.0.0:8080/', '0.0.0.0'],
	['page', 'http://evil.example/', 'a name that resolves to 127.0.0.1'],
	['page', 'http://dual.example/', 'a name with a public and a loopback address'],
	['page', 'http://169.254.169.254/latest/meta-data/', 'the cloud metadata address'],
	['page', 'http://meta.example/', 'a name that resolves to the metadata address'],
	['page', 'http://[fe80::1]/', 'IPv6 link-local'],
	['page', 'http://10.0.0.1/secret.html', 'this server\'s own LAN address'],
	['page', 'http://self.example/cam.html', 'a name for this server\'s own LAN address'],
];
foreach ($refused as [$what, $url, $label]) {
	$log = [];
	[$status, $data] = call($what, $url, $routes, $zone, $log);
	check("refused: $label ($url)", $status >= 400 && $log === [], 'HTTP ' . $status . ' ' . json_encode($data) . ' requests sent: ' . count($log));
}

$log = [];
[$status, $data] = call('page', 'http://public.example/redirect-to-metadata', $routes, $zone, $log);
check('a redirect to the metadata address is refused', $status >= 400 && !isset($data['sheets']), 'HTTP ' . $status . ' ' . json_encode($data));
check('... and the redirect target is never asked for', count($log) === 1, json_encode(array_column($log, 'url')));

echo "--- the connection is held to the address that was checked ---\n";
$log = [];
[$status] = call('page', 'http://public.example/new', $routes, $zone, $log);
check('a public name is read', $status === 200, 'HTTP ' . $status);
check('curl is told to use exactly the checked address', ($log[0]['resolve'] ?? null) === ['public.example:80:93.184.216.34'], json_encode($log[0]['resolve'] ?? null));
$log = [];
call('page', 'https://public.example:8443/new', $routes, $zone, $log);
check('... on the port asked for', ($log[0]['resolve'] ?? null) === ['public.example:8443:93.184.216.34'], json_encode($log[0]['resolve'] ?? null));

echo "--- what stays allowed ---\n";
$log = [];
[$status, $data] = call('page', 'http://192.168.1.1/index.html', $routes, $zone, $log);
check('a machine on the local network is read', $status === 200 && count($data['sheets'] ?? []) === 1, 'HTTP ' . $status . ' ' . json_encode($data));
$log = [];
[$status] = call('page', 'http://127.0.0.1:9980/hosting/discovery', $routes, $zone, $log, ['allow_self_targets' => 'yes']);
check('an administrator can allow this server itself', $status === 200 && count($log) === 1, 'HTTP ' . $status);
$log = [];
[$status] = call('page', 'http://public.example/redirect-to-metadata', $routes, $zone, $log, ['allow_self_targets' => 'yes']);
check('... and link-local addresses', $status === 200 && count($log) === 2, 'HTTP ' . $status);

echo "--- errors say a few plain words ---\n";
$log = [];
[$status, $data] = call('page', 'http://lan.example/admin', $routes, $zone, $log);
$said = json_encode($data);
check('an error answer is reported by its status only', ($data['error'] ?? '') === 'the site answered with an error (401)', $said);
check('... without the other side\'s own words', !str_contains($said, 'internal_token') && !str_contains($said, 'backend-01'), $said);
$log = [];
[$status, $data] = call('page', 'http://down.example/x.html', $routes, $zone, $log);
$said = json_encode($data);
check('a connection that fails says so plainly', ($data['error'] ?? '') === 'that address could not be read', $said);
check('... without the address it tried or curl\'s words', !str_contains($said, '192.168') && !str_contains($said, 'cURL'), $said);
$log = [];
[$status, $data] = call('page', 'http://evil.example/', $routes, $zone, $log);
check('a refusal does not say where the name led', !str_contains(json_encode($data), '127.0.0.1'), json_encode($data));
$log = [];
[$status, $data] = call('page', 'http://lan.example/page.html', $routes, $zone, $log);
check('a page that is not a page is still refused as before', $status === 400 && ($data['error'] ?? '') === 'that address is not a web page', json_encode($data));
$log = [];
[$status, $data] = call('page', 'http://public.example/plain', $routes, $zone, $log);
check('a page without a table says so', $status === 400 && ($data['error'] ?? '') === 'that page has no table in it', json_encode($data));

echo "--- addresses with Japanese in them (S13), and a Shift_JIS page ---\n";
$log = [];
[$status, $data] = call('page', 'https://example.jp/画像/表.html', $routes, $zone, $log);
check('a page whose path is Japanese is read', $status === 200, 'HTTP ' . $status . ' ' . json_encode($data));
check('... asked for percent-encoded', ($log[0]['url'] ?? '') === 'https://example.jp/%E7%94%BB%E5%83%8F/%E8%A1%A8.html', $log[0]['url'] ?? 'nothing sent');
$cells = (array)($data['sheets'][0]['cells'] ?? []);
check('... and a Shift_JIS page is read as the Japanese it is', ($cells['A1']['v'] ?? '') === 'りんご' && ($cells['B1']['v'] ?? null) === 120 && ($data['source']['name'] ?? '') === '日本', json_encode($data['sheets'] ?? null));
$log = [];
[$status] = call('page', 'https://日本語.jp/', $routes, $zone, $log);
check('a Japanese domain name is read', $status === 200, 'HTTP ' . $status);
check('... asked for in its ASCII form', ($log[0]['url'] ?? '') === 'https://xn--wgv71a119e.jp/', $log[0]['url'] ?? 'nothing sent');
$log = [];
[$status] = call('page', 'https://ja.wikipedia.org/wiki/日本', $routes, $zone, $log);
check('a page whose path is Japanese is read', $status === 200 && ($log[0]['url'] ?? '') === 'https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC', 'HTTP ' . $status . ' ' . ($log[0]['url'] ?? ''));

echo "--- redirects ---\n";
$log = [];
[$status, $data] = call('page', 'http://public.example/old', $routes, $zone, $log);
check('a relative redirect is followed', $status === 200 && (((array)($data['sheets'][0]['cells'] ?? []))['A2']['v'] ?? '') === 'new', 'HTTP ' . $status . ' ' . json_encode($data));
check('... and the page is handed back with the address it was found at', ($data['source']['id'] ?? '') === 'http://public.example/new?x=1', json_encode($data['source'] ?? null));
check('... its tables as sheets with a header row in bold and a number read', (((array)($data['sheets'][0]['cells'] ?? []))['A1']['s']['b'] ?? 0) === 1 && (((array)($data['sheets'][0]['cells'] ?? []))['B2']['v'] ?? null) === 3, json_encode($data['sheets'] ?? null));
$log = [];
[$status, $data] = call('page', 'http://loop.example/', $routes, $zone, $log);
check('no more than five redirects are followed', $status >= 400 && count($log) === 6, 'HTTP ' . $status . ', ' . count($log) . ' requests');

echo "--- with Nextcloud's own guard on as well (allow_local_remote_servers off) ---\n";
class FakeDns extends OC\Http\Client\DnsPinMiddleware {
	protected function dnsGetRecord(string $hostname, int $type): array|false {
		return $type === DNS_A && $hostname === 'public.example.' ? [['ip' => '93.184.216.34']] : [];
	}
}
$cacheFactory = stub(OCP\ICacheFactory::class, ['createLocal' => static fn () => stub(OCP\ICache::class)]);
$dns = new FakeDns(new OC\Http\Client\NegativeDnsCache($cacheFactory), new OC\Net\IpAddressClassifier(), new Psr\Log\NullLogger());
$log = [];
$GLOBALS['cb_url'] = 'http://public.example/new';
$r = api($routes, $zone, $log, [], false, $dns->addDnsPinning())->importWeb();
check('a public page is still read', $r->getStatus() === 200, 'HTTP ' . $r->getStatus() . ' ' . json_encode($r->getData()));
$log = [];
$GLOBALS['cb_url'] = 'http://127.0.0.1/';
$r = api($routes, $zone, $log, [], false, $dns->addDnsPinning())->importWeb();
check('this server itself is still refused', $r->getStatus() >= 400 && $log === [], 'HTTP ' . $r->getStatus());

finish();
