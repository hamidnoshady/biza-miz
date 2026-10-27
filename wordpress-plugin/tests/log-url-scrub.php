<?php
// Standalone (no WordPress): `php wordpress-plugin/tests/log-url-scrub.php`.
define( 'ABSPATH', '/tmp/' );
require dirname( __DIR__ ) . '/tests/../pos-accounting-connector/includes/class-pos-log.php';

$signed = 'https://bucket.example.com/biz/a.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F2026%2Fs3&X-Amz-Expires=300&X-Amz-Signature=deadbeefcafe';
$cases  = 0;
$check  = static function ( $ok, $label ) use ( &$cases ) {
	if ( ! $ok ) {
		throw new RuntimeException( 'FAILED: ' . $label );
	}
	++$cases;
};

$out = POS_Connector_Log::scrub_urls( "cURL error 28: timed out for $signed, retrying" );
$check( false === strpos( $out, 'deadbeefcafe' ), 'signature removed' );
$check( false === strpos( $out, 'AKIA' ), 'credential removed' );
$check( false !== strpos( $out, 'https://bucket.example.com/biz/a.jpg?' ), 'object path kept' );
$check( '•••, retrying' === substr( $out, -strlen( '•••, retrying' ) ), 'sentence punctuation kept outside the URL' );
$check( 'https://cdn.example.com/p.png?w=300&token=•••&v=2' === POS_Connector_Log::scrub_urls( 'https://cdn.example.com/p.png?w=300&token=abc&v=2' ), 'harmless params kept' );
$check( 'https://•••@host.example/a.jpg#top' === POS_Connector_Log::scrub_urls( 'https://user:hunter2@host.example/a.jpg#top' ), 'userinfo removed' );
$check( 'plain text' === POS_Connector_Log::scrub_urls( 'plain text' ), 'text without URL untouched' );
$check( 'https://host.example/a.jpg' === POS_Connector_Log::scrub_urls( 'https://host.example/a.jpg' ), 'URL without query untouched' );
echo $cases . " log URL scrub assertions passed\n";
