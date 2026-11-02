<?php
/** WordPress is the only URL-fetching boundary. Every redirect is revalidated
 * and DNS answers are pinned into cURL, not re-resolved at connect time.
 */
defined( 'ABSPATH' ) || exit;
class POS_Connector_Media_Import {
	const MAX_BYTES = 26214400;
	const TIMEOUT = 30;
	const MIMES = array( 'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp' );

	public static function target( $url, $resolve = null ) {
		$parts = parse_url( $url );
		if ( ! is_array( $parts ) || ! isset( $parts['scheme'], $parts['host'] ) || isset( $parts['user'] ) || isset( $parts['pass'] ) || strlen( $url ) > 4096 ) {
			throw new Exception( 'media_url_invalid' );
		}
		$scheme = strtolower( $parts['scheme'] );
		$host = strtolower( trim( $parts['host'], '[]' ) );
		$port = isset( $parts['port'] ) ? (int) $parts['port'] : ( 'https' === $scheme ? 443 : 80 );
		if ( ! in_array( $scheme, array( 'http', 'https' ), true ) || ( 'https' === $scheme ? 443 : 80 ) !== $port || ! $host || preg_match( '/[\\x00-\\x20\\\\]/', $url ) ) {
			throw new Exception( 'media_url_invalid' );
		}
		if ( filter_var( $host, FILTER_VALIDATE_IP ) ) {
			$ips = array( $host );
		} else {
			if ( ! preg_match( '/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,63}$/', $host ) || preg_match( '/(?:^|\\.)(localhost|local|internal|test|invalid|onion)$/', $host ) ) {
				throw new Exception( 'media_host_disallowed' );
			}
			$ips = $resolve ? call_user_func( $resolve, $host ) : self::resolve( $host );
		}
		if ( ! $ips ) throw new Exception( 'media_dns_failed' );
		foreach ( $ips as $ip ) {
			if ( ! filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE ) ) throw new Exception( 'media_address_disallowed' );
			if ( strpos( $ip, ':' ) !== false ) {
				$binary = inet_pton( $ip );
				// Only global unicast; exclude transition, documentation and
				// protocol-assignment blocks (including IPv4 embedding).
				if ( ! $binary || ( ord( $binary[0] ) & 0xe0 ) !== 0x20 ||
					( ord( $binary[0] ) === 0x20 && ord( $binary[1] ) === 0x01 && ord( $binary[2] ) < 2 ) ||
					preg_match( '/^(?:2001:db8:|2002:|3fff:)/i', $ip ) ) throw new Exception( 'media_address_disallowed' );
			} elseif ( preg_match( '/^(?:0\.|100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|169\.254\.|192\.(?:0\.(?:0|2)|88\.99)\.|198\.(?:18|19|51\.100)\.|203\.0\.113\.|(?:22[4-9]|23[0-9]|24[0-9]|25[0-5])\.)/', $ip ) ) {
				throw new Exception( 'media_address_disallowed' );
			}
		}
		return array( $host, $port, $ips[0] );
	}

	/**
	 * A/AAAA answers for a host.
	 *
	 * PHP has no per-call timeout for the system resolver, so a dead nameserver
	 * can stall a cron run for as long as resolv.conf allows. glibc re-reads
	 * RES_OPTIONS whenever the resolver initialises, so a tighter timeout is set
	 * for this one lookup and then restored. That bounds the worst case on glibc;
	 * musl and Windows ignore it, so the caller still checks the overall
	 * deadline as soon as the lookup returns and refuses to start a fetch past it.
	 */
	private static function resolve( $host ) {
		$previous = getenv( 'RES_OPTIONS' );
		putenv( 'RES_OPTIONS=timeout:2 attempts:2' );
		try {
			$records = dns_get_record( $host, DNS_A | DNS_AAAA );
		} finally {
			putenv( false === $previous ? 'RES_OPTIONS' : 'RES_OPTIONS=' . $previous );
		}
		$ips = array();
		foreach ( $records ?: array() as $record ) {
			if ( isset( $record['ip'] ) ) $ips[] = $record['ip'];
			if ( isset( $record['ipv6'] ) ) $ips[] = $record['ipv6'];
		}
		return $ips;
	}

	/** One bounded HTTP GET with redirects off, DNS pinned to $ip, the body streamed through $write.
	 * Returns the HTTP status, or false when the transfer itself failed or was aborted by $write.
	 */
	private static function curl_get( $url, $host, $port, $ip, $seconds, $on_header, $write ) {
		$curl = curl_init( $url );
		curl_setopt_array( $curl, array(
			CURLOPT_FOLLOWLOCATION => false,
			CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
			CURLOPT_PROXY => '',
			CURLOPT_RESOLVE => array( $host . ':' . $port . ':' . ( strpos( $ip, ':' ) !== false ? '[' . $ip . ']' : $ip ) ),
			CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_SSL_VERIFYPEER => true,
			CURLOPT_CONNECTTIMEOUT_MS => min( 5000, (int) ( $seconds * 1000 ) ),
			CURLOPT_TIMEOUT_MS => (int) ( $seconds * 1000 ),
			CURLOPT_HEADERFUNCTION => static function ( $ch, $header ) use ( $on_header ) {
				call_user_func( $on_header, $header );
				return strlen( $header );
			},
			CURLOPT_WRITEFUNCTION => static function ( $ch, $data ) use ( $write ) {
				return call_user_func( $write, $data );
			},
		) );
		try {
			$ok = curl_exec( $curl );
			return false === $ok ? false : (int) curl_getinfo( $curl, CURLINFO_HTTP_CODE );
		} finally {
			curl_close( $curl );
		}
	}

	/**
	 * @param array $options Test seams only; production passes none.
	 *   'transport' => callable( $url, $host, $port, $ip, $seconds, $on_header, $write ): int|false
	 *   'resolve'   => callable( $host ): string[]
	 *   'timeout'   => float seconds for the whole import (default TIMEOUT)
	 */
	public static function create( $url, $title, array $options = array() ) {
		$transport = isset( $options['transport'] ) ? $options['transport'] : array( __CLASS__, 'curl_get' );
		$resolve   = isset( $options['resolve'] ) ? $options['resolve'] : null;
		$timeout   = isset( $options['timeout'] ) ? (float) $options['timeout'] : self::TIMEOUT;
		if ( ! isset( $options['transport'] ) && ! function_exists( 'curl_init' ) ) throw new Exception( 'media_curl_required' );
		$tmp = wp_tempnam( 'pos-image' );
		if ( ! $tmp ) throw new Exception( 'media_temp_failed' );
		$started = microtime( true );
		try {
			for ( $hop = 0; $hop <= 3; ++$hop ) {
				// Every hop is validated and pinned again, and the deadline is checked
				// once the lookup has returned, before any connection is opened.
				list( $host, $port, $ip ) = self::target( $url, $resolve );
				$remaining = $timeout - ( microtime( true ) - $started );
				if ( $remaining <= 0 ) throw new Exception( 'media_timeout' );
				$file = fopen( $tmp, 'wb' );
				if ( ! $file ) throw new Exception( 'media_temp_failed' );
				$bytes = 0; $location = ''; $mime = '';
				try {
					$status = call_user_func(
						$transport, $url, $host, $port, $ip, $remaining,
						static function ( $header ) use ( &$location, &$mime ) {
							if ( stripos( $header, 'Location:' ) === 0 ) $location = trim( substr( $header, 9 ) );
							if ( stripos( $header, 'Content-Type:' ) === 0 ) $mime = strtolower( trim( explode( ';', substr( $header, 13 ) )[0] ) );
						},
						static function ( $data ) use ( $file, &$bytes ) {
							$bytes += strlen( $data );
							return $bytes > self::MAX_BYTES ? 0 : fwrite( $file, $data );
						}
					);
				} finally { fclose( $file ); }
				if ( false === $status ) throw new Exception( $bytes > self::MAX_BYTES ? 'media_too_large' : 'media_download_failed' );
				if ( in_array( $status, array( 301, 302, 303, 307, 308 ), true ) ) {
					if ( ! $location || $hop === 3 ) throw new Exception( 'media_redirect_limit' );
					$next = WP_Http::make_absolute_url( $location, $url );
					if ( 'https' === parse_url( $url, PHP_URL_SCHEME ) && 'https' !== parse_url( $next, PHP_URL_SCHEME ) ) throw new Exception( 'media_redirect_downgrade' );
					$url = $next;
					continue;
				}
				if ( 200 !== $status || ! $bytes ) throw new Exception( 'media_download_http_error' );
				$actual = wp_get_image_mime( $tmp );
				if ( ! isset( self::MIMES[ $actual ] ) || $mime !== $actual ) throw new Exception( 'media_mime_mismatch' );
				// Use a safe filename, not Content-Disposition or a signed URL.
				return media_handle_sideload( array( 'name' => 'image-' . wp_generate_uuid4() . '.' . self::MIMES[ $actual ], 'tmp_name' => $tmp ), 0, $title );
			}
			throw new Exception( 'media_redirect_limit' );
		} finally { if ( file_exists( $tmp ) ) unlink( $tmp ); }
	}
}
