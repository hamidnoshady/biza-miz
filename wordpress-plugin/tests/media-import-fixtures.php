<?php
/**
 * Importer fetch-loop fixtures, no WordPress and no network:
 *   php wordpress-plugin/tests/media-import-fixtures.php
 *
 * The cURL transport is replaced by a scripted one, so every redirect, size,
 * type and timeout rule of POS_Connector_Media_Import::create() runs for real
 * while the address policy (which refuses 127.0.0.1) stays in force.
 */
define( 'ABSPATH', '/tmp/' );

// Minimal WordPress surface the importer touches.
$GLOBALS['sideloaded'] = array();
$GLOBALS['actual_mime'] = 'image/jpeg';
function wp_tempnam( $prefix ) { return tempnam( sys_get_temp_dir(), $prefix ); }
function wp_generate_uuid4() { return '00000000-0000-4000-8000-000000000000'; }
function wp_get_image_mime( $file ) { return $GLOBALS['actual_mime']; }
function media_handle_sideload( $file_array, $post_id, $title ) {
	$GLOBALS['sideloaded'][] = array( 'name' => $file_array['name'], 'bytes' => filesize( $file_array['tmp_name'] ), 'title' => $title );
	return 4242;
}
class WP_Http {
	public static function make_absolute_url( $maybe_relative, $base ) {
		return preg_match( '~^[a-z][a-z0-9+.-]*:~i', $maybe_relative ) ? $maybe_relative : rtrim( $base, '/' ) . '/' . ltrim( $maybe_relative, '/' );
	}
}
require dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-media-import.php';

$cases = 0;
function expect_error( $code, callable $run, $label ) {
	global $cases;
	try { $run(); } catch ( Exception $e ) {
		if ( $e->getMessage() !== $code ) throw new RuntimeException( "FAILED: $label (got {$e->getMessage()}, wanted $code)" );
		++$cases; return;
	}
	throw new RuntimeException( "FAILED: $label (no error, wanted $code)" );
}
function expect_true( $ok, $label ) {
	global $cases;
	if ( ! $ok ) throw new RuntimeException( "FAILED: $label" );
	++$cases;
}
/** A transport that plays back one scripted response per hop and records what it was asked to fetch. */
function scripted( array $responses, array &$seen ) {
	return static function ( $url, $host, $port, $ip, $seconds, $on_header, $write ) use ( &$responses, &$seen ) {
		$seen[] = array( 'url' => $url, 'host' => $host, 'port' => $port, 'ip' => $ip );
		$r = array_shift( $responses );
		foreach ( $r['headers'] as $h ) call_user_func( $on_header, $h . "\r\n" );
		foreach ( $r['chunks'] as $chunk ) {
			if ( call_user_func( $write, $chunk ) < strlen( $chunk ) ) return false; // cURL aborts when the sink short-writes.
		}
		return $r['status'];
	};
}
$public = static function () { return array( '8.8.8.8' ); };
$ok_image = array( 'status' => 200, 'headers' => array( 'Content-Type: image/jpeg; charset=binary' ), 'chunks' => array( 'abc', 'def' ) );
$redirect = static function ( $to, $status = 302 ) { return array( 'status' => $status, 'headers' => array( 'Location: ' . $to ), 'chunks' => array() ); };
$tmp_before = count( glob( sys_get_temp_dir() . '/pos-image*' ) );

// 1. Happy path: pinned to the resolved address, safe generated filename, title passed through.
$seen = array();
$id = POS_Connector_Media_Import::create( 'https://images.example.org/p/a.jpg?X-Amz-Signature=secret', 'Cover', array( 'transport' => scripted( array( $ok_image ), $seen ), 'resolve' => $public ) );
expect_true( 4242 === $id, 'sideload id returned' );
expect_true( 'image-00000000-0000-4000-8000-000000000000.jpg' === $GLOBALS['sideloaded'][0]['name'], 'filename never derived from the URL' );
expect_true( 6 === $GLOBALS['sideloaded'][0]['bytes'], 'whole body stored' );
expect_true( array( 'images.example.org', 443, '8.8.8.8' ) === array( $seen[0]['host'], $seen[0]['port'], $seen[0]['ip'] ), 'connection pinned to the validated address' );

// 2. A redirect is revalidated: a public host may not bounce us to a private address.
$seen = array();
$resolver = static function ( $host ) { return 'internal.example.org' === $host ? array( '10.0.0.5' ) : array( '8.8.8.8' ); };
expect_error( 'media_address_disallowed', static function () use ( $redirect, &$seen, $resolver ) {
	POS_Connector_Media_Import::create( 'https://images.example.org/a.jpg', 't', array( 'transport' => scripted( array( $redirect( 'https://internal.example.org/x.jpg' ) ), $seen ), 'resolve' => $resolver ) );
}, 'redirect to a private address' );
expect_true( 1 === count( $seen ), 'the private hop is never requested' );

// 3. Redirect to a literal metadata address, a credentialed URL, or a non-default port.
foreach ( array(
	'http://169.254.169.254/latest/meta-data' => 'media_address_disallowed',
	'https://user:pass@images.example.org/a.jpg' => 'media_url_invalid',
	'https://images.example.org:8443/a.jpg' => 'media_url_invalid',
	'file:///etc/passwd' => 'media_url_invalid',
) as $to => $code ) {
	$seen = array();
	// Start from the same scheme as the target so the downgrade rule (case 4) cannot mask the address/URL rule under test.
	$start = 0 === strpos( $to, 'https://' ) ? 'https://images.example.org/a.jpg' : 'http://images.example.org/a.jpg';
	expect_error( $code, static function () use ( $redirect, &$seen, $public, $to, $start ) {
		POS_Connector_Media_Import::create( $start, 't', array( 'transport' => scripted( array( $redirect( $to ) ), $seen ), 'resolve' => $public ) );
	}, "redirect to $to" );
}

// 4. HTTPS may not be downgraded by a redirect.
$seen = array();
expect_error( 'media_redirect_downgrade', static function () use ( $redirect, &$seen, $public ) {
	POS_Connector_Media_Import::create( 'https://images.example.org/a.jpg', 't', array( 'transport' => scripted( array( $redirect( 'http://images.example.org/a.jpg' ) ), $seen ), 'resolve' => $public ) );
}, 'https to http downgrade' );

// 5. At most three redirects, and a redirect with no Location is a failure, not a loop.
$seen = array();
expect_error( 'media_redirect_limit', static function () use ( $redirect, &$seen, $public ) {
	$hops = array_fill( 0, 4, $redirect( 'https://images.example.org/next.jpg' ) );
	POS_Connector_Media_Import::create( 'https://images.example.org/a.jpg', 't', array( 'transport' => scripted( $hops, $seen ), 'resolve' => $public ) );
}, 'redirect chain longer than three hops' );
expect_true( 4 === count( $seen ), 'exactly four requests were made' );
expect_error( 'media_redirect_limit', static function () use ( &$seen, $public ) {
	$none = array( 'status' => 302, 'headers' => array(), 'chunks' => array() );
	POS_Connector_Media_Import::create( 'https://images.example.org/a.jpg', 't', array( 'transport' => scripted( array( $none ), $seen ), 'resolve' => $public ) );
}, 'redirect without Location' );

// 6. Size: the sink refuses the byte after the limit, the transfer aborts, nothing is sideloaded.
$sideloaded_before = count( $GLOBALS['sideloaded'] );
$seen = array();
expect_error( 'media_too_large', static function () use ( &$seen, $public ) {
	$big = array( 'status' => 200, 'headers' => array( 'Content-Type: image/jpeg' ), 'chunks' => array( str_repeat( 'x', POS_Connector_Media_Import::MAX_BYTES ), 'y' ) );
	POS_Connector_Media_Import::create( 'https://images.example.org/a.jpg', 't', array( 'transport' => scripted( array( $big ), $seen ), 'resolve' => $public ) );
}, 'body one byte over the limit' );
expect_true( count( $GLOBALS['sideloaded'] ) === $sideloaded_before, 'oversized body not sideloaded' );
$seen = array();
POS_Connector_Media_Import::create( 'https://images.example.org/a.jpg', 't', array( 'transport' => scripted( array( array( 'status' => 200, 'headers' => array( 'Content-Type: image/jpeg' ), 'chunks' => array( str_repeat( 'x', POS_Connector_Media_Import::MAX_BYTES ) ) ) ), $seen ), 'resolve' => $public ) );
expect_true( POS_Connector_Media_Import::MAX_BYTES === end( $GLOBALS['sideloaded'] )['bytes'], 'a body exactly at the limit is accepted' );

// 7. Type: the header and the bytes must agree and must be an allowed image type.
$GLOBALS['actual_mime'] = 'image/png';
$seen = array();
expect_error( 'media_mime_mismatch', static function () use ( $ok_image, &$seen, $public ) {
	POS_Connector_Media_Import::create( 'https://images.example.org/a.jpg', 't', array( 'transport' => scripted( array( $ok_image ), $seen ), 'resolve' => $public ) );
}, 'Content-Type disagrees with the bytes' );
foreach ( array( 'image/svg+xml', 'video/mp4', 'application/pdf', false ) as $actual ) {
	$GLOBALS['actual_mime'] = $actual;
	$resp = array( 'status' => 200, 'headers' => array( 'Content-Type: ' . ( $actual ?: 'application/octet-stream' ) ), 'chunks' => array( 'abc' ) );
	$seen = array();
	expect_error( 'media_mime_mismatch', static function () use ( $resp, &$seen, $public ) {
		POS_Connector_Media_Import::create( 'https://images.example.org/a', 't', array( 'transport' => scripted( array( $resp ), $seen ), 'resolve' => $public ) );
	}, 'unsupported type ' . var_export( $actual, true ) );
}
$GLOBALS['actual_mime'] = 'image/jpeg';

// 8. HTTP errors and empty bodies.
foreach ( array( 404, 403, 500 ) as $status ) {
	$seen = array();
	expect_error( 'media_download_http_error', static function () use ( $status, &$seen, $public ) {
		POS_Connector_Media_Import::create( 'https://images.example.org/a.jpg', 't', array( 'transport' => scripted( array( array( 'status' => $status, 'headers' => array(), 'chunks' => array( 'nope' ) ) ), $seen ), 'resolve' => $public ) );
	}, "HTTP $status" );
}
$seen = array();
expect_error( 'media_download_http_error', static function () use ( &$seen, $public ) {
	POS_Connector_Media_Import::create( 'https://images.example.org/a.jpg', 't', array( 'transport' => scripted( array( array( 'status' => 200, 'headers' => array( 'Content-Type: image/jpeg' ), 'chunks' => array() ) ), $seen ), 'resolve' => $public ) );
}, '200 with an empty body' );

// 9. Transport failure (connect/TLS/timeout inside cURL) surfaces as a download failure.
expect_error( 'media_download_failed', static function () use ( $public ) {
	POS_Connector_Media_Import::create( 'https://images.example.org/a.jpg', 't', array( 'transport' => static function () { return false; }, 'resolve' => $public ) );
}, 'transport failure' );

// 10. The overall deadline: a lookup that eats it means no connection is opened.
$opened = 0;
expect_error( 'media_timeout', static function () use ( &$opened ) {
	POS_Connector_Media_Import::create( 'https://images.example.org/a.jpg', 't', array(
		'timeout' => 0.05,
		'resolve' => static function () { usleep( 120000 ); return array( '8.8.8.8' ); },
		'transport' => static function () use ( &$opened ) { ++$opened; return 200; },
	) );
}, 'slow DNS exhausts the deadline' );
expect_true( 0 === $opened, 'no connection after the deadline' );
// The remaining budget shrinks across hops: the transport is told how long it has left.
$budgets = array();
$seen = array();
POS_Connector_Media_Import::create( 'https://images.example.org/a.jpg', 't', array(
	'timeout' => 10,
	'resolve' => $public,
	'transport' => static function ( $url, $host, $port, $ip, $seconds, $on_header, $write ) use ( &$budgets, $redirect, $ok_image ) {
		$budgets[] = $seconds;
		usleep( 60000 );
		$r = count( $budgets ) === 1 ? $redirect( 'https://images.example.org/b.jpg' ) : $ok_image;
		foreach ( $r['headers'] as $h ) call_user_func( $on_header, $h . "\r\n" );
		foreach ( $r['chunks'] as $c ) call_user_func( $write, $c );
		return $r['status'];
	},
) );
expect_true( 2 === count( $budgets ) && $budgets[1] < $budgets[0] && $budgets[0] <= 10, 'time budget shrinks across hops' );

// 11. Temp files are always removed, on success and on every failure above.
expect_true( count( glob( sys_get_temp_dir() . '/pos-image*' ) ) === $tmp_before, 'no temp file left behind' );

echo "$cases importer fixture assertions passed\n";
