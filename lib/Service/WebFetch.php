<?php

declare(strict_types=1);

namespace OCA\CalcBase\Service;

use OCA\CalcBase\AppInfo\Application;
use OCP\Http\Client\IClientService;
use OCP\IConfig;
use Psr\Http\Message\ResponseInterface;
use Psr\Log\LoggerInterface;

/**
 * Reading a page or a picture from another site, for a book.
 *
 * The server does this on the browser's behalf, which makes the server the one
 * that connects -- from inside the network, where the services on this machine
 * and a cloud's metadata address answer anyone who asks. Nextcloud's own client
 * guards against that only while the instance-wide allow_local_remote_servers is
 * off, and a server that runs Talk or Office beside Nextcloud turns it on. So
 * CalcBase keeps its own rule, whatever that setting says (review S1; the rule
 * the owner chose for NetBase, 2026-09-25):
 *
 * - this server itself (127.0.0.0/8, ::1, 0.0.0.0 and every address on its own
 *   network interfaces) and link-local addresses (169.254.0.0/16, where a cloud
 *   keeps its metadata service, and fe80::/10) are refused unless an
 *   administrator has allowed them;
 * - every address a name resolves to is checked, and the connection is held to
 *   exactly those addresses, so a name that answers differently a moment later
 *   cannot lead it anywhere else;
 * - redirects are followed here, one at a time, and each one is checked again;
 * - only so much is read, and only for so long (S7), and what went wrong is said
 *   in a few plain words rather than handed back as the other side wrote it (S8).
 *
 * Other machines on the local network are not refused: a picture on the office
 * NAS is a perfectly good thing to bring into a book.
 */
class WebFetch {
	/** App setting: 'yes' lets a fetch reach this server itself and link-local addresses. */
	public const ALLOW_SELF = 'allow_self_targets';
	/** A page is cut here; it used to be read whole and cut here afterwards. */
	public const PAGE_BYTES = 4 * 1024 * 1024;
	/** A picture larger than this is refused. */
	public const IMAGE_BYTES = 10 * 1024 * 1024;
	private const REDIRECTS = 5;

	/** The whole of one fetch, redirects included, in seconds. */
	protected float $seconds = 20.0;

	/** @var array<string, bool>|null this server's own addresses, packed */
	private ?array $own = null;

	public function __construct(
		private IClientService $clients,
		private IConfig $config,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * One page or picture.
	 *
	 * $accepts is asked about the Content-Type of the final answer before its body
	 * is read. An answer longer than $limit is cut there when $truncate is set (a
	 * page) and refused with $tooLarge when it is not (a picture).
	 *
	 * @param callable(string): bool $accepts
	 * @return array{url: string, type: string, body: string, truncated: bool}
	 * @throws FetchRefused
	 */
	public function get(string $url, string $accept, int $limit, bool $truncate, callable $accepts, string $notThat, string $tooLarge): array {
		$current = self::normalise($url);
		$deadline = microtime(true) + $this->seconds;
		for ($hop = 0; ; $hop++) {
			$pins = $this->vet($current);
			$left = $deadline - microtime(true);
			if ($left <= 0) {
				throw new FetchRefused('that address took too long to answer', 504);
			}
			$sink = new FetchSink($limit);
			$seen = null;
			// What the answer is, judged from its headers alone: before the body is
			// read when curl is doing the reading, and again once it is in.
			$judge = static function (int $status, string $type, string $length) use ($accepts, $notThat, $tooLarge, $limit, $truncate): void {
				if ($status >= 300 && $status < 400) {
					return;
				}
				if ($status < 200 || $status >= 300) {
					throw new FetchRefused('the site answered with an error (' . $status . ')', 502);
				}
				if (!$accepts($type)) {
					throw new FetchRefused($notThat);
				}
				if (!$truncate && ctype_digit($length) && (int)$length > $limit) {
					throw new FetchRefused($tooLarge);
				}
			};
			try {
				$response = $this->clients->newClient()->get($current, [
					'timeout' => $left,
					'connect_timeout' => min(10.0, $left),
					// Followed below, each one checked before it is asked for.
					'allow_redirects' => false,
					'http_errors' => false,
					'headers' => ['Accept' => $accept],
					'sink' => $sink,
					'on_headers' => static function (ResponseInterface $response) use (&$seen, $judge): void {
						$seen = $response;
						$judge($response->getStatusCode(), $response->getHeaderLine('Content-Type'), $response->getHeaderLine('Content-Length'));
					},
					// These replace Nextcloud's own curl options, so its one default is kept.
					'curl' => [CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_2TLS] + ($pins === [] ? [] : [CURLOPT_RESOLVE => $pins]),
					// Nextcloud's own rule still applies on top, where the instance keeps it.
					'nextcloud' => ['allow_local_address' => false],
				]);
				$status = $seen !== null ? $seen->getStatusCode() : $response->getStatusCode();
				$type = $seen !== null ? $seen->getHeaderLine('Content-Type') : $response->getHeader('Content-Type');
				$location = $seen !== null ? $seen->getHeaderLine('Location') : $response->getHeader('Location');
				$length = $seen !== null ? $seen->getHeaderLine('Content-Length') : $response->getHeader('Content-Length');
			} catch (\Throwable $e) {
				$refused = self::refusalIn($e);
				if ($refused !== null) {
					throw $refused;
				}
				if (!$sink->overflowed() || $seen === null) {
					$this->logger->info('CalcBase could not fetch {url}: {error}', ['app' => Application::APP_ID, 'url' => $current, 'error' => $e->getMessage()]);
					throw new FetchRefused('that address could not be read', 502);
				}
				// Stopped at the limit: a picture is refused below, a page is kept as far as it went.
				$status = $seen->getStatusCode();
				$type = $seen->getHeaderLine('Content-Type');
				$location = $seen->getHeaderLine('Location');
				$length = $seen->getHeaderLine('Content-Length');
			}
			if ($status >= 300 && $status < 400) {
				if ($location === '') {
					throw new FetchRefused('the site answered with an error (' . $status . ')', 502);
				}
				if ($hop >= self::REDIRECTS) {
					throw new FetchRefused('that address redirects too many times', 502);
				}
				$current = self::normalise(self::resolve($current, $location));
				continue;
			}
			$judge($status, $type, $length);
			if ($sink->overflowed() && !$truncate) {
				throw new FetchRefused($tooLarge);
			}
			return ['url' => $current, 'type' => $type, 'body' => $sink->contents(), 'truncated' => $sink->overflowed()];
		}
	}

	/** One of our own refusals, when it comes back wrapped in the HTTP client's exception. */
	private static function refusalIn(\Throwable $e): ?FetchRefused {
		for ($at = $e; $at !== null; $at = $at->getPrevious()) {
			if ($at instanceof FetchRefused) {
				return $at;
			}
		}
		return null;
	}

	/**
	 * Whether this address may be connected to, and, for a name, the addresses curl
	 * is to use for it: the ones that were checked, and no others.
	 *
	 * @return list<string> CURLOPT_RESOLVE entries (none for an address written as a number)
	 */
	private function vet(string $url): array {
		$parts = parse_url($url);
		$host = trim((string)($parts['host'] ?? ''), '[]');
		$port = (int)($parts['port'] ?? (strtolower((string)($parts['scheme'] ?? '')) === 'https' ? 443 : 80));
		$literal = filter_var($host, FILTER_VALIDATE_IP) !== false;
		$ips = $literal ? [$host] : $this->addressesOf($host);
		if ($ips === []) {
			throw new FetchRefused('that address could not be read', 502);
		}
		if (!$this->allowsSelf()) {
			foreach ($ips as $ip) {
				if ($this->isSelf($ip)) {
					throw new FetchRefused('CalcBase does not read from this server itself or from link-local addresses. An administrator can allow it.', 403);
				}
			}
		}
		if ($literal) {
			return [];
		}
		$list = array_map(static fn (string $ip): string => str_contains($ip, ':') ? '[' . $ip . ']' : $ip, $ips);
		return [$host . ':' . $port . ':' . implode(',', $list)];
	}

	/** Whether an administrator has let fetches reach this server itself and link-local addresses. */
	private function allowsSelf(): bool {
		return $this->config->getAppValue(Application::APP_ID, self::ALLOW_SELF, 'no') === 'yes';
	}

	/**
	 * Every address a host name resolves to: DNS, and the resolver's own files
	 * (/etc/hosts), which is where "localhost" and its friends live.
	 *
	 * @return list<string>
	 */
	protected function addressesOf(string $host): array {
		$out = [];
		foreach ((array)@gethostbynamel($host) as $ip) {
			if (is_string($ip) && filter_var($ip, FILTER_VALIDATE_IP) !== false) {
				$out[] = $ip;
			}
		}
		foreach ((array)@dns_get_record($host, DNS_AAAA) as $record) {
			if (is_array($record) && !empty($record['ipv6']) && filter_var($record['ipv6'], FILTER_VALIDATE_IP) !== false) {
				$out[] = (string)$record['ipv6'];
			}
		}
		return array_values(array_unique($out));
	}

	/**
	 * The addresses on this server's own network interfaces.
	 *
	 * @return list<string>
	 */
	protected function ownAddresses(): array {
		$out = [];
		foreach ((function_exists('net_get_interfaces') ? (net_get_interfaces() ?: []) : []) as $interface) {
			foreach ($interface['unicast'] ?? [] as $address) {
				if (!empty($address['address'])) {
					$out[] = (string)$address['address'];
				}
			}
		}
		return $out;
	}

	/** This server itself, or a link-local address. */
	public function isSelf(string $ip): bool {
		$bin = self::packed($ip);
		if ($bin === null) {
			// Not an address at all: nothing that can be vouched for.
			return true;
		}
		if (strlen($bin) === 4) {
			$a = ord($bin[0]);
			if ($a === 127 || $a === 0 || ($a === 169 && ord($bin[1]) === 254)) {
				return true;
			}
		} elseif ($bin === str_repeat("\0", 15) . "\1" || $bin === str_repeat("\0", 16)
			|| (ord($bin[0]) === 0xfe && (ord($bin[1]) & 0xc0) === 0x80)) {
			return true;
		}
		if ($this->own === null) {
			$this->own = [];
			foreach ($this->ownAddresses() as $own) {
				$packed = self::packed($own);
				if ($packed !== null) {
					$this->own[$packed] = true;
				}
			}
		}
		return isset($this->own[$bin]);
	}

	/**
	 * An address as its 4 or 16 bytes, with an IPv4 address written the IPv6 way
	 * (::ffff:127.0.0.1, ::127.0.0.1, 64:ff9b::127.0.0.1, 2002:7f00:1::) reduced to
	 * the IPv4 address it carries, so it is judged as that.
	 */
	private static function packed(string $ip): ?string {
		$ip = preg_replace('/%.*$/', '', trim($ip, '[] ')) ?? '';
		$bin = @inet_pton($ip);
		if ($bin === false) {
			return null;
		}
		if (strlen($bin) !== 16) {
			return $bin;
		}
		$head = substr($bin, 0, 12);
		$tail = substr($bin, 12);
		if ($head === str_repeat("\0", 10) . "\xff\xff" || $head === "\x00\x64\xff\x9b" . str_repeat("\0", 8)) {
			return $tail;
		}
		if ($head === str_repeat("\0", 12) && $tail !== "\0\0\0\0" && $tail !== "\0\0\0\1") {
			return $tail;
		}
		if (substr($bin, 0, 2) === "\x20\x02") {
			return substr($bin, 2, 4);
		}
		return $bin;
	}

	/**
	 * The address as it is to be asked for: http or https only, the host name in
	 * its ASCII form (日本語.jp becomes xn--wgv71a119e.jp) and anything in the path
	 * and the query that is not plain ASCII percent-encoded, the way a browser
	 * sends it (review S13). What still does not read as a web address is refused.
	 */
	public static function normalise(string $url): string {
		$bad = static fn () => new FetchRefused('that is not a web address');
		// A browser drops tabs and line breaks anywhere in an address; so does this.
		$url = str_replace(["\t", "\n", "\r"], '', trim($url));
		if (!preg_match('#^(https?)://([^/?\#\\\\]*)([^\#]*)#i', $url, $m)) {
			throw $bad();
		}
		$scheme = strtolower($m[1]);
		$authority = $m[2];
		$rest = $m[3];
		$user = '';
		$at = strrpos($authority, '@');
		if ($at !== false) {
			$user = (string)preg_replace_callback('/[^A-Za-z0-9\-._~!$&\'()*+,;=:%]/', static fn ($c) => rawurlencode($c[0]), substr($authority, 0, $at)) . '@';
			$authority = substr($authority, $at + 1);
		}
		if (!preg_match('/^(\[[^\]]*\]|[^:\[\]]+)(?::(\d{0,5}))?$/', $authority, $h)) {
			throw $bad();
		}
		$host = $h[1];
		$port = $h[2] ?? '';
		if ($port !== '' && ((int)$port < 1 || (int)$port > 65535)) {
			throw $bad();
		}
		if ($host[0] === '[') {
			$ip = substr($host, 1, -1);
			if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
				throw $bad();
			}
			$host = '[' . strtolower($ip) . ']';
		} else {
			$host = self::asciiHost($host);
		}
		// Encoded the way a browser encodes it; and a path always begins with a
		// slash, so nothing in it can be read as part of the host.
		$rest = (string)preg_replace_callback('/[^\x21-\x7e]|["<>\\\\^`{|}]/', static fn ($c) => rawurlencode($c[0]), $rest);
		if ($rest === '' || ($rest[0] !== '/' && $rest[0] !== '?')) {
			$rest = '/' . ltrim($rest, '/');
		} elseif ($rest[0] === '?') {
			$rest = '/' . $rest;
		}
		$out = $scheme . '://' . $user . $host . ($port !== '' ? ':' . $port : '') . $rest;
		// What is checked has to be what is connected to: read back, it must say the same host.
		if (strtolower((string)parse_url($out, PHP_URL_HOST)) !== $host) {
			throw $bad();
		}
		return $out;
	}

	/** A host name, in ASCII, and only a host name. */
	private static function asciiHost(string $host): string {
		$bad = new FetchRefused('that is not a web address');
		if (preg_match('/[^\x21-\x7e]/', $host)) {
			$ascii = function_exists('idn_to_ascii') ? idn_to_ascii($host, IDNA_NONTRANSITIONAL_TO_ASCII, INTL_IDNA_VARIANT_UTS46) : false;
			if (!is_string($ascii) || $ascii === '') {
				throw $bad;
			}
			$host = $ascii;
		}
		$host = strtolower($host);
		if (str_ends_with($host, '.')) {
			$host = substr($host, 0, -1);
		}
		if (!preg_match('/^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/', $host)) {
			throw $bad;
		}
		// A name whose last part is a number is an IPv4 address to a browser and to
		// curl, in forms such as 0x7f.1 or 2130706433 that both read as 127.0.0.1.
		// Only the ordinary dotted form is taken.
		$labels = explode('.', $host);
		if (preg_match('/^(0x[0-9a-f]*|[0-9]+)$/', (string)end($labels)) && filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false) {
			throw $bad;
		}
		return $host;
	}

	/** Where a redirect points, when it gives only part of an address (RFC 3986, 5.2). */
	public static function resolve(string $base, string $ref): string {
		$ref = (string)preg_replace('/#.*$/s', '', str_replace(["\t", "\n", "\r"], '', trim($ref)));
		if (preg_match('#^[a-z][a-z0-9+.\-]*:#i', $ref)) {
			return $ref;
		}
		$b = parse_url($base);
		if (!is_array($b) || !isset($b['scheme'], $b['host'])) {
			throw new FetchRefused('that is not a web address');
		}
		if (str_starts_with($ref, '//')) {
			return $b['scheme'] . ':' . $ref;
		}
		$origin = $b['scheme'] . '://'
			. (isset($b['user']) ? $b['user'] . (isset($b['pass']) ? ':' . $b['pass'] : '') . '@' : '')
			. $b['host'] . (isset($b['port']) ? ':' . $b['port'] : '');
		$path = $b['path'] ?? '/';
		if ($ref === '') {
			return $origin . $path . (isset($b['query']) ? '?' . $b['query'] : '');
		}
		if ($ref[0] === '?') {
			return $origin . $path . $ref;
		}
		$parts = explode('?', $ref, 2);
		$merged = $parts[0] !== '' && $parts[0][0] === '/' ? $parts[0] : preg_replace('#[^/]*$#', '', $path) . $parts[0];
		return $origin . self::withoutDots((string)$merged) . (isset($parts[1]) ? '?' . $parts[1] : '');
	}

	/** "/a/b/../c/./d" is "/a/c/d". */
	private static function withoutDots(string $path): string {
		$out = [];
		foreach (explode('/', $path) as $segment) {
			if ($segment === '..') {
				if (count($out) > 1) {
					array_pop($out);
				}
			} elseif ($segment !== '.') {
				$out[] = $segment;
			}
		}
		$joined = implode('/', $out);
		if (preg_match('#/\.\.?$#', $path) && !str_ends_with($joined, '/')) {
			$joined .= '/';
		}
		return $joined === '' ? '/' : ($joined[0] === '/' ? $joined : '/' . $joined);
	}
}
