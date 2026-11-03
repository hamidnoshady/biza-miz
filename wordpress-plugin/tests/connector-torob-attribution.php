<?php
/**
 * Deterministic checks of Torob attribution (#894 Wave 6), under plain `php`.
 *
 *   php wordpress-plugin/tests/connector-torob-attribution.php
 *
 * No WordPress, no WooCommerce, no database. What is pinned here is everything that
 * decides whether a store hands over data it did not agree to hand over:
 *
 *   - the two switches default to off and only an explicit `1` turns them on, so a
 *     stale option can never be read as consent;
 *   - the 403 is produced by the switch, before any query, as the documents require;
 *   - a token is accepted only for EdDSA, only inside `exp`/`nbf`, and only when
 *     `aud` names this store;
 *   - `limit` is required and bounded at 1000 instead of silently trimmed;
 *   - a record without a click id, with an unknown status, or before the watermark
 *     is dropped rather than sent — these records are billed against.
 */
define( 'ABSPATH', '/tmp/' );

$GLOBALS['pos_test_options'] = array();
$GLOBALS['pos_test_filters'] = array();

function get_option( $name, $default = false ) {
	return array_key_exists( $name, $GLOBALS['pos_test_options'] ) ? $GLOBALS['pos_test_options'][ $name ] : $default;
}
function update_option( $name, $value, $autoload = null ) {
	$GLOBALS['pos_test_options'][ $name ] = $value;
	return true;
}
function apply_filters( $tag, $value ) {
	return array_key_exists( $tag, $GLOBALS['pos_test_filters'] ) ? $GLOBALS['pos_test_filters'][ $tag ] : $value;
}
function add_action() {}
function sanitize_text_field( $value ) {
	return trim( (string) $value );
}

require dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-torob.php';

$assertions = 0;
function check( $condition, $label ) {
	global $assertions;
	++$assertions;
	if ( ! $condition ) {
		fwrite( STDERR, "FAILED: $label\n" );
		exit( 1 );
	}
}
function same( $expected, $actual, $label ) {
	check(
		$expected === $actual,
		$label . ' (expected ' . var_export( $expected, true ) . ', got ' . var_export( $actual, true ) . ')'
	);
}
function is_null_value( $value, $label ) {
	check( null === $value, $label . ' (expected null, got ' . var_export( $value, true ) . ')' );
}

if ( ! function_exists( 'sodium_crypto_sign_detached' ) ) {
	fwrite( STDERR, "FAILED: the sodium extension is required to verify Torob's Ed25519 tokens\n" );
	exit( 1 );
}

// --- a keypair standing in for Torob's -----------------------------------------

$keypair   = sodium_crypto_sign_keypair();
$secret    = sodium_crypto_sign_secretkey( $keypair );
$public    = sodium_crypto_sign_publickey( $keypair );
$spki_der  = hex2bin( '302a300506032b6570032100' ) . $public;
$spki_pem  = "-----BEGIN PUBLIC KEY-----\n" . chunk_split( base64_encode( $spki_der ), 64, "\n" ) . "-----END PUBLIC KEY-----\n";
$GLOBALS['pos_test_filters']['pos_connector_torob_public_key'] = $spki_pem;

function b64url( $value ) {
	return rtrim( strtr( base64_encode( $value ), '+/', '-_' ), '=' );
}

function make_token( $claims, $secret, $header = null ) {
	$header    = null === $header ? array( 'alg' => 'EdDSA', 'typ' => 'JWT', 'v' => 1 ) : $header;
	$encoded   = b64url( json_encode( $header ) ) . '.' . b64url( json_encode( $claims ) );
	$signature = sodium_crypto_sign_detached( $encoded, $secret );
	return $encoded . '.' . b64url( $signature );
}

function torob_headers( $token, $version = '1' ) {
	return array(
		'x-torob-token'         => $token,
		'x-torob-token-version' => $version,
	);
}

$now   = 1760000000;
$hosts = array( 'shop.example', 'www.shop.example' );

// --- the switches ---------------------------------------------------------------

same( false, POS_Connector_Torob::is_enabled( 'orders' ), 'orders default to off' );
same( false, POS_Connector_Torob::is_enabled( 'actions' ), 'actions default to off' );

$gate = POS_Connector_Torob::guard( 'orders' );
same( 403, $gate['status'], 'a store that never opted in answers 403' );
same( false, $gate['body']['success'], 'and the body says so' );
same( 'access_disabled', $gate['body']['error'], 'with a reason a merchant can look up' );

POS_Connector_Torob::set_enabled( 'orders', true );
same( true, POS_Connector_Torob::is_enabled( 'orders' ), 'an explicit switch turns it on' );
same( null, POS_Connector_Torob::guard( 'orders' ), 'and then the channel opens' );
same( 403, POS_Connector_Torob::guard( 'actions' )['status'], 'each channel is independent' );

// A truthy-looking leftover is not consent.
$GLOBALS['pos_test_options'][ POS_Connector_Torob::OPTION_ORDERS ] = 'on';
same( false, POS_Connector_Torob::is_enabled( 'orders' ), 'only an exact 1 counts as consent' );
POS_Connector_Torob::set_enabled( 'orders', false );
same( false, POS_Connector_Torob::is_enabled( 'orders' ), 'and it can be switched off again' );
same( false, POS_Connector_Torob::set_enabled( 'customers', true ), 'an unknown channel is refused' );

// --- tokens --------------------------------------------------------------------

$claims = array( 'aud' => 'shop.example', 'exp' => $now + 600, 'nbf' => $now - 600 );
$token  = make_token( $claims, $secret );

$verified = POS_Connector_Torob::verify_token( torob_headers( $token ), $hosts, $now );
same( true, $verified['ok'], 'a correct token is accepted' );
same( 'shop.example', $verified['claims']['aud'], 'and its claims are available' );

same( 'missing_token', POS_Connector_Torob::verify_token( array(), $hosts, $now )['reason'], 'no token' );
same(
	'missing_token_version',
	POS_Connector_Torob::verify_token( array( 'x-torob-token' => $token ), $hosts, $now )['reason'],
	'no version header'
);
same(
	'unsupported_token_version',
	POS_Connector_Torob::verify_token( torob_headers( $token, '2' ), $hosts, $now )['reason'],
	'an unknown version'
);
same(
	'wrong_algorithm',
	POS_Connector_Torob::verify_token( torob_headers( make_token( $claims, $secret, array( 'alg' => 'none' ) ) ), $hosts, $now )['reason'],
	'alg:none is refused before the signature is even considered'
);
same( 'invalid_token', POS_Connector_Torob::verify_token( torob_headers( 'not-a-jwt' ), $hosts, $now )['reason'], 'malformed' );

$tampered = $token;
$tampered[ strlen( $tampered ) - 2 ] = 'A' === $tampered[ strlen( $tampered ) - 2 ] ? 'B' : 'A';
same( 'invalid_token', POS_Connector_Torob::verify_token( torob_headers( $tampered ), $hosts, $now )['reason'], 'a flipped signature byte' );

same(
	'expired',
	POS_Connector_Torob::verify_token( torob_headers( $token ), $hosts, $now + 601 )['reason'],
	'a token past its exp'
);
same(
	'not_yet_valid',
	POS_Connector_Torob::verify_token( torob_headers( $token ), $hosts, $now - 601 )['reason'],
	'a token before its nbf'
);
same(
	'audience_mismatch',
	POS_Connector_Torob::verify_token( torob_headers( make_token( array( 'aud' => 'other.example', 'exp' => $now + 60 ), $secret ) ), $hosts, $now )['reason'],
	'a token minted for another partner'
);
same(
	true,
	POS_Connector_Torob::verify_token( torob_headers( make_token( array( 'aud' => 'SHOP.example.', 'exp' => $now + 60 ), $secret ) ), $hosts, $now )['ok'],
	'case and a trailing dot are the same host'
);
same(
	true,
	POS_Connector_Torob::verify_token( torob_headers( make_token( array( 'aud' => 'shop.example:8443', 'exp' => $now + 60 ), $secret ) ), $hosts, $now )['ok'],
	'the documented port spelling is tolerated'
);
same(
	true,
	POS_Connector_Torob::verify_token( torob_headers( make_token( array( 'aud' => array( 'other.example', 'www.shop.example' ), 'exp' => $now + 60 ), $secret ) ), $hosts, $now )['ok'],
	'an aud array may name this host among others'
);

// --- parameters ----------------------------------------------------------------

same(
	'missing_purchase_timestamp_gt',
	POS_Connector_Torob::parse_params( array( 'limit' => '10' ), 'orders' )['error'],
	'orders require purchase_timestamp_gt'
);
same(
	'missing_timestamp_gt',
	POS_Connector_Torob::parse_params( array( 'limit' => '10' ), 'actions' )['error'],
	'actions require timestamp_gt'
);
same(
	'invalid_purchase_timestamp_gt',
	POS_Connector_Torob::parse_params( array( 'purchase_timestamp_gt' => '2025-09-21 10:00:00', 'limit' => '10' ), 'orders' )['error'],
	'a timestamp without the Z suffix is not ISO 8601 UTC'
);
same(
	'missing_limit',
	POS_Connector_Torob::parse_params( array( 'purchase_timestamp_gt' => '2025-09-21T10:00:00Z' ), 'orders' )['error'],
	'limit is required'
);
same(
	'invalid_limit',
	POS_Connector_Torob::parse_params( array( 'purchase_timestamp_gt' => '2025-09-21T10:00:00Z', 'limit' => '1001' ), 'orders' )['error'],
	'limit above the documented ceiling is refused, not trimmed'
);
same(
	'invalid_limit',
	POS_Connector_Torob::parse_params( array( 'purchase_timestamp_gt' => '2025-09-21T10:00:00Z', 'limit' => '0' ), 'orders' )['error'],
	'zero is not a limit'
);
same(
	'invalid_limit',
	POS_Connector_Torob::parse_params( array( 'purchase_timestamp_gt' => '2025-09-21T10:00:00Z', 'limit' => '10.5' ), 'orders' )['error'],
	'a fraction is not a limit'
);

$params = POS_Connector_Torob::parse_params(
	array(
		'purchase_timestamp_gt' => '2025-09-21T10:00:00.000000Z',
		'limit'                 => '1000',
	),
	'orders'
);
same( true, $params['ok'], 'a well-formed poll is accepted' );
same( 1000, $params['limit'], 'and the limit survives as a number' );

// --- records -------------------------------------------------------------------

$since = '2025-09-21T10:00:00.000000Z';

$valid = array(
	'purchase_timestamp'     => '2025-09-21T10:20:30.456789Z',
	'last_updated_timestamp' => '2025-09-21T10:20:30.456789Z',
	'torob_clid'             => 'a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8',
	'status'                 => 'completed',
	'psp'                    => 'zarinpal',
	'order_value'            => '500000',
	'shipping_amount'        => '90000',
	'phone_number'           => '+989123456789',
	'products'               => array(
		array(
			'product_url'   => 'https://shop.example/product/789',
			'product_price' => '100000',
			'quantity'      => '1',
		),
	),
);

$record = POS_Connector_Torob::order_record( $valid, $since );
same( 'completed', $record['status'], 'a completed order keeps its status' );
same( 500000, $record['order_value'], 'money is an integer in Toman' );
same( 1, $record['products'][0]['quantity'], 'quantity is an integer' );

$without_clid = $valid;
unset( $without_clid['torob_clid'] );
is_null_value( POS_Connector_Torob::order_record( $without_clid, $since ), 'an order with no click id is never sent' );

$bad_clid = $valid;
$bad_clid['torob_clid'] = '<script>alert(1)</script>';
is_null_value( POS_Connector_Torob::order_record( $bad_clid, $since ), 'so is one whose click id is not an id' );

$unknown_status = $valid;
$unknown_status['status'] = 'shipped';
is_null_value( POS_Connector_Torob::order_record( $unknown_status, $since ), 'an unknown status is dropped, not guessed' );

$before = $valid;
$before['purchase_timestamp'] = '2025-09-21T09:59:59.999999Z';
is_null_value( POS_Connector_Torob::order_record( $before, $since ), 'a record at or before the watermark is not repeated' );

$partial = $valid;
$partial['products'] = array(
	array( 'product_url' => 'ftp://shop.example/p', 'product_price' => '1', 'quantity' => '1' ),
	array( 'product_url' => 'https://shop.example/p2', 'quantity' => '1' ),
	array( 'product_url' => 'https://shop.example/p3', 'product_price' => '5', 'quantity' => '2' ),
);
$record = POS_Connector_Torob::order_record( $partial, $since );
same( 1, count( $record['products'] ), 'a product line is all-or-nothing' );
same( 'https://shop.example/p3', $record['products'][0]['product_url'], 'and the usable one survives' );

$action = POS_Connector_Torob::action_record(
	array(
		'timestamp'  => '2025-09-21T10:20:30.456789Z',
		'torob_clid' => 'abc-123',
		'status'     => 'completed',
		'action_type' => 'signup',
	),
	$since
);
same( 'signup', $action['action_type'], 'an action keeps its type' );
is_null_value(
	POS_Connector_Torob::action_record(
		array(
			'timestamp'  => '2025-09-21T10:20:30.456789Z',
			'torob_clid' => 'abc-123',
			'status'     => 'completed',
			'action_type' => '',
		),
		$since
	),
	'an action without a type is required to have one, so it is dropped'
);

// --- batches -------------------------------------------------------------------

$late  = $valid;
$late['purchase_timestamp']     = '2025-09-21T12:00:00.000000Z';
$late['last_updated_timestamp'] = '2025-09-21T12:00:00.000000Z';
$late['torob_clid']             = 'second';
$early = $valid;
$early['purchase_timestamp']     = '2025-09-21T11:00:00.000000Z';
$early['last_updated_timestamp'] = '2025-09-21T11:00:00.000000Z';
$early['torob_clid']             = 'first';

$batch = POS_Connector_Torob::collect( array( $late, $early, $without_clid ), $since, 10, 'orders' );
same( array( 'first', 'second' ), array_column( $batch, 'torob_clid' ), 'records are ascending by their own timestamp' );
same( 1, count( POS_Connector_Torob::collect( array( $late, $early ), $since, 1, 'orders' ) ), 'the limit trims the tail' );

$body = POS_Connector_Torob::response( $batch );
same( true, $body['success'], 'the response carries success' );
same( 2, count( $body['data'] ), 'and the records' );
same( array(), POS_Connector_Torob::response( array() )['data'], 'an empty answer is an empty list, not an error' );

// --- click ids -----------------------------------------------------------------

same( true, POS_Connector_Torob::clid_is_valid( 'a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8' ), 'a uuid-shaped id' );
same( false, POS_Connector_Torob::clid_is_valid( '' ), 'empty' );
same( false, POS_Connector_Torob::clid_is_valid( str_repeat( 'a', 129 ) ), 'over 128 characters' );
same( false, POS_Connector_Torob::clid_is_valid( 'a b' ), 'whitespace' );
same( false, POS_Connector_Torob::clid_is_valid( 'a/b?c=d' ), 'url punctuation' );

fwrite( STDOUT, 'Torob attribution policy: ' . $assertions . " checks passed\n" );
