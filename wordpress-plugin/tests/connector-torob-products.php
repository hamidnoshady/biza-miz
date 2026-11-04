<?php
/**
 * Deterministic checks of the store-side Product API v3 (#894 Wave 3), under plain
 * `php` — no WordPress, no WooCommerce, no database.
 *
 *   php wordpress-plugin/tests/connector-torob-products.php
 *
 * The endpoint has to answer **exactly** what the platform-hosted one answers, or a
 * shop served from its own origin fails differently from a hosted one for reasons
 * nobody can see in Torob's logs. So what is pinned here is the contract's own edge
 * cases: the four modes and their refusals, the free-price trap, the required
 * dictionary, an absent product in a lookup, 100 per page, and the gate order.
 */
define( 'ABSPATH', '/tmp/' );

$GLOBALS['pos_test_filters'] = array();
$GLOBALS['pos_test_currency'] = 'IRT';
$GLOBALS['pos_fake_products'] = array();
$GLOBALS['pos_fake_attachments'] = array();

function wp_get_attachment_image_url( $id, $size ) {
	return isset( $GLOBALS['pos_fake_attachments'][ $id ]['url'] ) ? $GLOBALS['pos_fake_attachments'][ $id ]['url'] : false;
}
function wp_get_attachment_metadata( $id ) {
	return isset( $GLOBALS['pos_fake_attachments'][ $id ]['metadata'] ) ? $GLOBALS['pos_fake_attachments'][ $id ]['metadata'] : false;
}

function wc_get_product( $id ) {
	return isset( $GLOBALS['pos_fake_products'][ $id ] ) ? $GLOBALS['pos_fake_products'][ $id ] : null;
}

function apply_filters( $tag, $value ) {
	return array_key_exists( $tag, $GLOBALS['pos_test_filters'] ) ? $GLOBALS['pos_test_filters'][ $tag ] : $value;
}
function add_action() {}
function sanitize_text_field( $value ) {
	return trim( (string) $value );
}
function wp_strip_all_tags( $value ) {
	return strip_tags( (string) $value );
}
function wp_parse_url( $url ) {
	return parse_url( $url );
}
function get_woocommerce_currency() {
	return $GLOBALS['pos_test_currency'];
}

class Fake_Torob_Product {
	public $id;
	public $type;
	public $parent_id;
	public $children;
	public $price;
	public $regular;
	public $created;
	public $modified;
	public $name;
	public $attributes;
	public $image_id = 0;
	public $gallery_ids = array();

	public function __construct( $id, $type = 'simple', $parent_id = 0, $children = array(), $price = '2500000', $regular = '3000000', $created = '2025-01-01 12:00:00+00:00', $name = 'Fake product', $attributes = array() ) {
		$this->id         = $id;
		$this->type       = $type;
		$this->parent_id  = $parent_id;
		$this->children   = $children;
		$this->price      = $price;
		$this->regular    = $regular;
		$this->created    = null === $created ? null : new DateTimeImmutable( $created );
		$this->modified   = $this->created;
		$this->name       = $name;
		$this->attributes = $attributes;
	}
	public function get_id() { return $this->id; }
	public function get_type() { return $this->type; }
	public function get_parent_id() { return $this->parent_id; }
	public function get_children() { return $this->children; }
	public function get_permalink() { return 'https://shop.example/product/' . $this->id; }
	public function get_date_created() { return $this->created; }
	public function get_date_modified() { return $this->modified; }
	public function get_image_id() { return $this->image_id; }
	public function get_gallery_image_ids() { return $this->gallery_ids; }
	public function get_price() { return $this->price; }
	public function get_regular_price() { return $this->regular; }
	public function get_attributes() { return $this->attributes; }
	public function is_in_stock() { return true; }
	public function is_purchasable() { return true; }
	public function get_short_description() { return ''; }
	public function get_name() { return $this->name; }
}

require dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-torob.php';
require dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-torob-products.php';

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
function null_value( $value, $label ) {
	check( null === $value, $label . ' (expected null, got ' . var_export( $value, true ) . ')' );
}

$P = 'POS_Connector_Torob_Products';

// --- one good product, as a row -------------------------------------------------

function row( $overrides = array() ) {
	return array_merge(
		array(
			'id'              => '1201',
			'url'             => 'https://shop.example/product/watch',
			'title'           => 'ساعت مچی',
			'subtitle'        => 'بند چرمی',
			'price_toman'     => 2500000,
			'old_price_toman' => 3000000,
			'available'       => true,
			'images'          => array( 'https://shop.example/w.jpg' ),
			'category'        => 'ساعت',
			'short_desc'      => 'ضمانت ۱۸ ماهه',
			'spec'            => array( 'بند' => 'چرم', 'قطر' => 40 ),
			'date_added'      => '2025-09-21 10:00:00',
			'date_updated'    => '2025-10-01 09:30:00',
			'group_id'        => '',
		),
		$overrides
	);
}

// --- the four modes -------------------------------------------------------------

$parsed = $P::parse_request( '{"page":2,"sort":"date_added_desc"}' );
same( true, $parsed['ok'], 'a page request' );
same( 2, $parsed['request']['page'], 'carries its page' );
same( 'date_added_desc', $parsed['request']['sort'], 'and its sort' );

$parsed = $P::parse_request( array( 'cursor' => null, 'sort' => 'product_id_desc' ) );
same( 'cursor', $parsed['request']['mode'], 'a null cursor is the first cursor page' );
null_value( $parsed['request']['cursor'], 'and it is null, not the string "null"' );

$parsed = $P::parse_request( array( 'page_uniques' => array( ' 1201 ', '1202' ) ) );
same( 'page_uniques', $parsed['request']['mode'], 'a lookup by unique' );
same( array( '1201', '1202' ), $parsed['request']['page_uniques'], 'with each unique trimmed' );

$parsed = $P::parse_request( array( 'page_urls' => array( 'https://shop.example/p/1' ) ) );
same( 'page_urls', $parsed['request']['mode'], 'a lookup by URL' );

// --- every refusal, with Torob's own sentence ----------------------------------

same( 'body_not_object', $P::parse_request( '"nope"' )['error'], 'a string body is not an object' );
same( 'body_not_object', $P::parse_request( '{"page":1' )['error'], 'broken JSON is not an object' );
same( 'body_not_object', $P::parse_request( '[]' )['error'], 'a JSON array is not an object' );
same( 'empty_request', $P::parse_request( '{}' )['error'], 'an empty object names no mode' );
same(
	'multiple_modes',
	$P::parse_request( array( 'page' => 1, 'sort' => 'date_added_desc', 'page_uniques' => array( '1' ) ) )['error'],
	'two modes in one body'
);
same( 'sort_required', $P::parse_request( array( 'page' => 1 ) )['error'], 'page without sort' );
same( 'sort_invalid', $P::parse_request( array( 'page' => 1, 'sort' => 'price_desc' ) )['error'], 'an unknown sort' );
same( 'page_invalid', $P::parse_request( array( 'page' => 0, 'sort' => 'date_added_desc' ) )['error'], 'page 0' );
same( 'page_invalid', $P::parse_request( array( 'page' => 1.5, 'sort' => 'date_added_desc' ) )['error'], 'a fractional page' );
same( 'page_invalid', $P::parse_request( array( 'page' => '1', 'sort' => 'date_added_desc' ) )['error'], 'a page as a string' );
same( 'page_urls_invalid', $P::parse_request( array( 'page_urls' => array() ) )['error'], 'an empty URL list' );
same(
	'page_urls_invalid',
	$P::parse_request( array( 'page_urls' => array( '/relative/only' ) ) )['error'],
	'a relative URL is not a page URL'
);
same(
	'page_urls_invalid',
	$P::parse_request( array( 'page_urls' => array( 'ftp://shop.example/p' ) ) )['error'],
	'and neither is another scheme'
);
same( 'page_uniques_invalid', $P::parse_request( array( 'page_uniques' => array( '  ' ) ) )['error'], 'a blank unique' );
same(
	'cursor_invalid',
	$P::parse_request( array( 'cursor' => '', 'sort' => 'product_id_desc' ) )['error'],
	'an empty cursor is not the first page'
);
same(
	'cursor_requires_product_id_desc',
	$P::parse_request( array( 'cursor' => null, 'sort' => 'date_added_desc' ) )['error'],
	'cursor pagination is defined only over product_id_desc'
);

same( 'sort parameter is not provided', $P::error_body( 'sort_required' )['error'], 'the sentence is the contract\'s, not ours' );
same(
	'sort must be one of date_added_desc, date_updated_desc, product_id_desc',
	$P::error_body( 'sort_invalid' )['error'],
	'including the sort list it names'
);

// --- one record -----------------------------------------------------------------

$record = $P::record( row() );
same( '1201', $record['page_unique'], 'the page unique is the product id' );
same( 2500000, $record['current_price'], 'price in integer Toman' );
same( true, $record['availability'], 'availability from the product' );
same( 3000000, $record['old_price'], 'a higher regular price becomes old_price' );
same( array( 'بند' => 'چرم', 'قطر' => 40 ), $record['spec'], 'spec is a dictionary of strings and numbers' );
same( '2025-09-21T10:00:00.000Z', $record['date_added'], 'date_added in UTC with the documented shape' );
same( '2025-09-21T10:00:00.000Z', $P::iso_timestamp( '2025-09-21T10:00:00+00:00' ), 'the same instant, written another way' );
null_value( $P::iso_timestamp( 'not a date' ), 'an unparseable date is null' );

$GLOBALS['pos_test_currency'] = 'IRR';
same( 250000, $P::to_toman( '2500000' ), 'Rial converts to whole Toman exactly' );
null_value( $P::to_toman( '2500001' ), 'a Rial price not divisible by ten is refused, never rounded' );
$GLOBALS['pos_test_currency'] = 'IRT';
same( 2500000, $P::to_toman( '2500000.00' ), 'Toman stays Toman' );
null_value( $P::to_toman( '2500000.50' ), 'fractional Toman is refused' );
$GLOBALS['pos_test_currency'] = 'USD';
null_value( $P::to_toman( '2500000' ), 'unsupported currency is not guessed into Toman' );
$GLOBALS['pos_test_currency'] = 'IRT';
null_value( $P::record( row( array( 'price_toman' => null ) ) ), 'an unavailable amount never becomes free by a failed conversion' );

$free = $P::record( row( array( 'available' => false ) ) );
same( false, $free['availability'], 'an unavailable product' );
same( 0, $free['current_price'], 'never carries a price — true + 0 would read as free' );
check( ! isset( $free['old_price'] ), 'and never a struck-through one either' );

$cheap_old = $P::record( row( array( 'old_price_toman' => 1000000 ) ) );
check( ! isset( $cheap_old['old_price'] ), 'a "was" price below the current one is not a discount' );

null_value( $P::record( row( array( 'sellable' => false ) ) ), 'a withdrawn product is absent, not unavailable' );
null_value( $P::record( row( array( 'date_added' => '' ) ) ), 'a product with no date_added cannot be sent' );
null_value( $P::record( row( array( 'url' => 'javascript:alert(1)' ) ) ), 'nor one without a usable URL' );
null_value( $P::record( row( array( 'images' => array() ) ) ), 'nor one with no image' );
null_value( $P::record( row( array( 'title' => '   ' ) ) ), 'nor one with no title' );

$empty_spec = $P::record( row( array( 'spec' => array() ) ) );
same( array(), $empty_spec['spec'], 'an empty spec is {}, which the contract requires' );
$dirty_spec = $P::record(
	row(
		array(
			'spec' => array(
				''      => 'ignored',
				'ok'    => 'value',
				'list'  => array( 'a' ),
				'blank' => null,
			),
		)
	)
);
same( array( 'ok' => 'value' ), $dirty_spec['spec'], 'only name/value pairs survive' );

$long = $P::record( row( array( 'title' => str_repeat( 'x', 600 ) ) ) );
same( 500, strlen( $long['title'] ), 'a field longer than its cap is trimmed, not dropped' );

$grouped = $P::record( row( array( 'group_id' => '1200' ) ) );
same( '1200', $grouped['product_group_id'], 'a variation names its parent' );
check( ! isset( $P::record( row() )['product_group_id'] ), 'a simple product does not' );

// --- WooCommerce catalogue mapping ----------------------------------------------

$GLOBALS['pos_test_currency'] = 'IRR';
$simple = new Fake_Torob_Product(
	101,
	'simple',
	0,
	array(),
	'2500000',
	'3000000',
	'2025-01-01 12:00:00+01:00',
	'Simple watch'
);
$simple_rows = $P::rows_from_product( $simple );
same( 1, count( $simple_rows ), 'a simple product maps to one row' );
same( 250000, $simple_rows[0]['price_toman'], 'WooCommerce IRR is divided exactly by ten' );
same( 300000, $simple_rows[0]['old_price_toman'], 'and the regular price uses the same currency rule' );
same( '2025-01-01T11:00:00.000Z', $simple_rows[0]['date_added'], 'the store-local timezone becomes the correct UTC instant' );

$parent = new Fake_Torob_Product( 201, 'variable', 0, array( 202 ), '0', '0', '2025-02-01 00:00:00+00:00', 'Shirt' );
$variation = new Fake_Torob_Product( 202, 'variation', 201, array(), '1200000', '1200000', null, 'Shirt — blue', array( 'color' => 'blue' ) );
$GLOBALS['pos_fake_products'] = array( 201 => $parent, 202 => $variation );
$variant_rows = $P::rows_from_product( $parent );
same( 1, count( $variant_rows ), 'a variable product maps each child variation separately' );
same( '202', $variant_rows[0]['id'], 'the variation owns its stable page identity' );
same( '201', $variant_rows[0]['group_id'], 'the parent groups the variation' );
same( '2025-02-01T00:00:00.000Z', $variant_rows[0]['date_added'], "a variation without a creation date inherits its parent's" );
$GLOBALS['pos_fake_products'] = array();
$GLOBALS['pos_test_currency'] = 'IRT';

// --- Torob image requirements ----------------------------------------------------

same( 'https://cdn.example.com/full.jpg', $P::valid_image_url( 'https://cdn.example.com/full.jpg', array( 'width' => 900, 'height' => 900 ) ), 'a full-sized public HTTPS image is accepted' );
null_value( $P::valid_image_url( '/uploads/product.jpg', array( 'width' => 1200, 'height' => 1200 ) ), 'a relative image URL is refused' );
null_value( $P::valid_image_url( 'ftp://cdn.example.com/product.jpg', array( 'width' => 1200, 'height' => 1200 ) ), 'a non-HTTP image URL is refused' );
null_value( $P::valid_image_url( 'http://localhost/product.jpg', array( 'width' => 1200, 'height' => 1200 ) ), 'localhost is not publicly reachable' );
null_value( $P::valid_image_url( 'http://192.168.1.20/product.jpg', array( 'width' => 1200, 'height' => 1200 ) ), 'private IPs are not public image hosts' );
null_value( $P::valid_image_url( 'https://user:pass@cdn.example.com/product.jpg', array( 'width' => 1200, 'height' => 1200 ) ), 'an image URL with embedded credentials is refused' );
null_value( $P::valid_image_url( 'https://cdn.example.com/small.jpg', array( 'width' => 599, 'height' => 1200 ) ), "an image below Torob's 600px hard floor is refused" );
null_value( $P::valid_image_url( 'https://cdn.example.com/unknown.jpg', array() ), 'an image with unknown dimensions is refused' );
null_value( $P::valid_image_url( 'https://cdn.example.com/' . str_repeat( 'x', 1100 ), array( 'width' => 1200, 'height' => 1200 ) ), "a URL above Torob's image field cap is refused, not truncated" );

$GLOBALS['pos_fake_attachments'][55] = array(
	'url'      => 'https://cdn.example.com/product-full.jpg',
	'metadata' => array( 'width' => 1600, 'height' => 1200 ),
);
$image_product = new Fake_Torob_Product( 301 );
$image_product->image_id = 55;
$image_rows = $P::rows_from_product( $image_product );
same( array( 'https://cdn.example.com/product-full.jpg' ), $image_rows[0]['images'], 'the Woo adapter requests and returns the full validated image' );
$GLOBALS['pos_fake_attachments'] = array();

// --- envelopes ------------------------------------------------------------------

$records = array();
for ( $i = 1; $i <= 100; $i++ ) {
	$records[] = array( 'page_unique' => (string) $i );
}
$page = $P::page_response( $records, 1, 250 );
same( 'torob_api_v3', $page['api_version'], 'the contract version' );
same( 1, $page['current_page'], 'the page number' );
same( 3, $page['max_pages'], 'max_pages is ceil(total / 100)' );
null_value( $page['next_cursor'], 'a page response has no cursor' );
same( 1, $P::max_pages( 100 ), 'exactly 100 is one page' );
same( 2, $P::max_pages( 101 ), '101 is two' );
same( 1, $P::max_pages( 0 ), 'and an empty catalogue is still one page' );

$cursor = $P::cursor_response( $records, true );
same( $P::encode_cursor( '100' ), $cursor['next_cursor'], 'a cursor page hands back the last id it sent' );
check( ! array_key_exists( 'current_page', $cursor ), 'a cursor envelope has no current_page, unlike a numbered page' );
null_value( $P::cursor_response( $records, false )['next_cursor'], 'and nothing when there is no more' );
same( '100', $P::decode_cursor( $cursor['next_cursor'] ), 'the cursor decodes to that id' );
same( '', $P::decode_cursor( '!!!not base64!!!' ), 'a cursor this shop never issued decodes to nothing' );

$lookup = $P::lookup_response( array( $P::record( row() ) ) );
same( 1, $lookup['total'], 'a lookup reports what it found' );
same( 0, $P::lookup_response( array() )['total'], 'and an absent product is total: 0 with an empty list' );
same( array(), $P::lookup_response( array() )['products'], 'never a stub' );


// --- the gate -------------------------------------------------------------------

$now    = 1760000000;
$hosts  = array( 'shop.example' );
$claims = array( 'aud' => 'shop.example', 'exp' => $now + 600, 'nbf' => $now - 600 );

if ( function_exists( 'sodium_crypto_sign_detached' ) ) {
	$keypair  = sodium_crypto_sign_keypair();
	$secret   = sodium_crypto_sign_secretkey( $keypair );
	$public   = sodium_crypto_sign_publickey( $keypair );
	$der      = hex2bin( '302a300506032b6570032100' ) . $public;
	$GLOBALS['pos_test_filters']['pos_connector_torob_public_key'] =
		"-----BEGIN PUBLIC KEY-----\n" . chunk_split( base64_encode( $der ), 64, "\n" ) . "-----END PUBLIC KEY-----\n";

	$encode = static function ( $value ) {
		return rtrim( strtr( base64_encode( $value ), '+/', '-_' ), '=' );
	};
	$signed = $encode( json_encode( array( 'alg' => 'EdDSA', 'typ' => 'JWT' ) ) ) . '.' . $encode( json_encode( $claims ) );
	$token  = $signed . '.' . $encode( sodium_crypto_sign_detached( $signed, $secret ) );
	$headers = array(
		'x-torob-token'         => $token,
		'x-torob-token-version' => '1',
	);

	null_value( $P::gate( $headers, $hosts, true, $now ), 'a valid token opens the channel' );

	$refused = $P::gate( array(), $hosts, true, $now );
	same( 401, $refused['status'], 'no token is 401' );
	same( 'unauthorized: missing_token', $refused['body']['error'], 'and says which claim failed' );

	// The order that matters: an unauthenticated caller learns nothing about whether
	// this store is connected.
	$refused = $P::gate( array(), $hosts, false, $now );
	same( 401, $refused['status'], 'the token is checked before the connection' );

	$refused = $P::gate( $headers, $hosts, false, $now );
	same( 403, $refused['status'], 'a store that was never connected answers 403' );
	same( 'not_connected', $refused['body']['error'], 'with its own reason' );

	$wrong_host = $P::gate( $headers, array( 'other.example' ), true, $now );
	same( 'unauthorized: audience_mismatch', $wrong_host['body']['error'], 'a token for another store is refused' );
	$stale = $P::gate( $headers, $hosts, true, $now + 601 );
	same( 'unauthorized: expired', $stale['body']['error'], 'and so is an expired one' );
}

fwrite( STDOUT, 'Torob products policy: ' . $assertions . " checks passed\n" );
