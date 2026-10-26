<?php
/**
 * Every admin-post action of the plugin, driven with a minimal stand-in for the
 * handful of WordPress functions the handlers touch (issue #1149, B6). Plain
 * `php`, no WordPress and no database — the same family as
 * media-import-policy.php and connector-reliability-policy.php:
 *
 *   php wordpress-plugin/tests/connector-admin-actions.php
 *
 * For each action it proves the three things a handler must always do —
 * refuse a user without the capability, refuse a request without a valid
 * nonce, and, when allowed, redirect (to the tab the form was on) with the
 * notice that describes what happened — and then the action-specific
 * behaviour: the buttons only schedule cron events, the Test button names
 * what is wrong, and the update check falls back to GitHub.
 */
define( 'ABSPATH', '/tmp/' );
define( 'MINUTE_IN_SECONDS', 60 );
define( 'HOUR_IN_SECONDS', 3600 );
define( 'DAY_IN_SECONDS', 86400 );
define( 'POS_CONNECTOR_VERSION', '1.6.19' );
define( 'POS_CONNECTOR_FILE', '/tmp/pos-accounting-connector/pos-accounting-connector.php' );
define( 'POS_CONNECTOR_UPDATE_REPO', 'hamidnoshady/biza-miz' );
define( 'POS_CONNECTOR_UPDATE_URL', 'https://updates.example.test/wordpress/pos-accounting-connector/update.json' );
define( 'POS_CONNECTOR_CRON_MANUAL_JOB', 'pos_connector_manual_job' );
define( 'POS_CONNECTOR_CRON_RESYNC_ORDERS', 'pos_connector_resync_orders' );
define( 'POS_CONNECTOR_CRON_RESYNC_PRODUCTS', 'pos_connector_resync_products' );
define( 'POS_CONNECTOR_CRON_RESYNC_CUSTOMERS', 'pos_connector_resync_customers' );
define( 'POS_CONNECTOR_CRON_RESYNC_CONTENT', 'pos_connector_resync_content' );

class Redirect_Exception extends Exception {}
class Die_Exception extends Exception {}
class Nonce_Exception extends Exception {}
class WP_Error {
	public $code;
	public $message;
	public function __construct( $code = '', $message = '' ) {
		$this->code    = $code;
		$this->message = $message;
	}
	public function get_error_code() {
		return $this->code;
	}
	public function get_error_message() {
		return $this->message;
	}
}

/** Everything the stubs record or answer, in one place. */
$GLOBALS['t'] = array();
function t_reset() {
	$GLOBALS['t'] = array(
		'can'       => true,
		'nonce_ok'  => true,
		'woo'       => true,
		'referer'   => 'https://s.example/wp-admin/admin.php?page=pos-connector-synchronization',
		'options'   => array(),
		'scheduled' => array(),
		'schedule_ok' => true,
		'transients'  => array(),
		'retry_count' => 0,
		'http'        => array(),
		'http_calls'  => array(),
		'nonces_checked' => array(),
	);
}
t_reset();

// --- WordPress stand-ins ---------------------------------------------------------
function __( $text ) { return $text; }
function esc_html__( $text ) { return $text; }
function esc_html_e( $text ) { echo $text; }
function esc_attr__( $text ) { return $text; }
function current_user_can( $cap ) { return $GLOBALS['t']['can']; }
function get_current_user_id() { return 7; }
function wp_die( $message = '' ) { throw new Die_Exception( (string) $message ); }
function check_admin_referer( $action ) {
	$GLOBALS['t']['nonces_checked'][] = $action;
	if ( ! $GLOBALS['t']['nonce_ok'] ) {
		throw new Nonce_Exception( $action );
	}
	return 1;
}
function wp_unslash( $v ) { return $v; }
function esc_url_raw( $v ) { return (string) $v; }
function sanitize_text_field( $v ) { return trim( (string) $v ); }
function sanitize_key( $v ) { return strtolower( preg_replace( '/[^a-z0-9_\-]/i', '', (string) $v ) ); }
function untrailingslashit( $v ) { return rtrim( (string) $v, '/' ); }
function current_time( $type, $gmt = 0 ) { return gmdate( 'Y-m-d H:i:s' ); }
function home_url() { return 'https://shop.example'; }
function wp_json_encode( $v ) { return json_encode( $v ); }
function is_wp_error( $v ) { return $v instanceof WP_Error; }
function wp_list_pluck( $list, $field ) { return array_map( static function ( $row ) use ( $field ) { return $row[ $field ]; }, $list ); }
function wp_get_referer() { return $GLOBALS['t']['referer']; }
function admin_url( $path = '' ) { return 'https://s.example/wp-admin/' . $path; }
function add_query_arg( array $args, $url ) { return $url . ( false === strpos( $url, '?' ) ? '?' : '&' ) . http_build_query( $args ); }
function wp_safe_redirect( $url ) { throw new Redirect_Exception( $url ); }
function get_option( $name, $default = false ) { return array_key_exists( $name, $GLOBALS['t']['options'] ) ? $GLOBALS['t']['options'][ $name ] : $default; }
function update_option( $name, $value, $autoload = null ) { $GLOBALS['t']['options'][ $name ] = $value; return true; }
function delete_option( $name ) { unset( $GLOBALS['t']['options'][ $name ] ); return true; }
function set_transient( $key, $value, $ttl = 0 ) { $GLOBALS['t']['transients'][ $key ] = $value; return true; }
function wp_next_scheduled( $hook, $args = array() ) {
	foreach ( $GLOBALS['t']['scheduled'] as $event ) {
		if ( $event['hook'] === $hook && $event['args'] === $args ) {
			return $event['time'];
		}
	}
	return false;
}
function wp_schedule_single_event( $time, $hook, $args = array() ) {
	if ( ! $GLOBALS['t']['schedule_ok'] ) {
		return false;
	}
	$GLOBALS['t']['scheduled'][] = array( 'time' => $time, 'hook' => $hook, 'args' => $args );
	return true;
}
function wp_parse_args( $args, $defaults = array() ) { return array_merge( $defaults, (array) $args ); }
function plugin_basename( $f ) { return 'pos-accounting-connector/pos-accounting-connector.php'; }
function trailingslashit( $v ) { return rtrim( (string) $v, '/' ) . '/'; }
function wp_kses_post( $v ) { return (string) $v; }
function wp_update_plugins() {}
function apply_filters( $hook, $value ) { return $value; }
function wp_parse_url( $url, $component = -1 ) { return parse_url( $url, $component ); }
function wp_remote_retrieve_response_code( $r ) { return $r['code']; }
function wp_remote_retrieve_body( $r ) { return $r['body']; }
function wp_remote_post( $url, $args = array() ) { return t_http( 'POST', $url, $args ); }
function wp_remote_get( $url, $args = array() ) { return t_http( 'GET', $url, $args ); }
/** Answer by the longest registered URL prefix; an unregistered URL is a transport error. */
function t_http( $method, $url, $args ) {
	$GLOBALS['t']['http_calls'][] = array( 'method' => $method, 'url' => $url, 'body' => isset( $args['body'] ) ? $args['body'] : null );
	foreach ( $GLOBALS['t']['http'] as $prefix => $answer ) {
		if ( 0 === strpos( $url, $prefix ) ) {
			return is_array( $answer ) && isset( $answer['error'] ) ? new WP_Error( 'request_failed', $answer['error'] ) : $answer;
		}
	}
	return new WP_Error( 'request_failed', 'could not resolve host' );
}
function t_json( $code, array $data ) { return array( 'code' => $code, 'body' => json_encode( $data ) ); }

// --- the plugin's own functions the handlers lean on (pos-accounting-connector.php) ---
function pos_connector_admin_capability() { return 'manage_options'; }
function pos_connector_woocommerce_active() { return $GLOBALS['t']['woo']; }
function pos_connector_uses_system_cron() { return true; }
function pos_connector_settings() {
	$defaults = array(
		'base_url' => 'https://pos.example', 'token' => 'wplink_secret', 'enabled' => true,
		'sync_orders' => true, 'sync_products' => true, 'sync_customers' => true,
		'last_run_at' => '', 'last_sync_ok_at' => '', 'last_ping_ok_at' => '', 'armed_at' => '',
		'last_error' => '', 'resync_orders_schedule' => 'hourly', 'resync_products_schedule' => 'hourly',
		'resync_orders_days' => 7, 'last_run_stats' => array(),
	);
	$stored = get_option( 'pos_connector_settings', array() );
	return array_merge( $defaults, is_array( $stored ) ? $stored : array() );
}
function pos_connector_update_settings( array $changes ) {
	update_option( 'pos_connector_settings', array_merge( pos_connector_settings(), $changes ) );
}
function pos_connector_resync_schedules() { return array( '' => 'off', 'hourly' => 'hourly', 'daily' => 'daily' ); }
function pos_connector_order_resync_schedules() { return array( '' => 'off', 'hourly' => 'hourly', 'daily' => 'daily' ); }
function pos_connector_schedule_event( $hook, $schedule ) { $GLOBALS['t']['rescheduled'][ $hook ] = $schedule; }

class POS_Connector_Log {
	public static $lines = array();
	public static function info( $a, $m ) { self::$lines[] = array( 'info', $a, $m ); }
	public static function error( $a, $m ) { self::$lines[] = array( 'error', $a, $m ); }
}
class POS_Connector_Queue {
	public static function retry_failed() { return $GLOBALS['t']['retry_count']; }
}

$includes = dirname( __DIR__ ) . '/pos-accounting-connector/includes/';
require $includes . 'class-pos-health.php';
require $includes . 'class-pos-client.php';
require $includes . 'class-pos-admin.php';
require $includes . 'class-pos-settings.php';
require $includes . 'class-pos-updater.php';

// --- harness ---------------------------------------------------------------------------
$assertions = 0;
function check( $condition, $label ) {
	global $assertions;
	++$assertions;
	if ( ! $condition ) {
		fwrite( STDERR, "FAILED: $label\n" );
		exit( 1 );
	}
}

/** Run one handler; report what it did: 'redirect' (with parsed query), 'die' or 'nonce'. */
function run_handler( $callable, array $post = array() ) {
	$_POST = $post;
	try {
		call_user_func( $callable );
		return array( 'result' => 'returned' );
	} catch ( Redirect_Exception $e ) {
		$parts = parse_url( $e->getMessage() );
		parse_str( isset( $parts['query'] ) ? $parts['query'] : '', $query );
		return array( 'result' => 'redirect', 'query' => $query, 'url' => $e->getMessage() );
	} catch ( Die_Exception $e ) {
		return array( 'result' => 'die' );
	} catch ( Nonce_Exception $e ) {
		return array( 'result' => 'nonce', 'action' => $e->getMessage() );
	}
}

// Every admin_post action, the nonce action it checks, and the notice a clean press ends with.
$actions = array(
	'pos_connector_save'             => array( array( 'POS_Connector_Settings', 'handle_save' ), array( 'base_url' => 'https://pos.example/', 'token' => '', 'enabled' => '1' ), 'saved' ),
	'pos_connector_test'             => array( array( 'POS_Connector_Settings', 'handle_test' ), array(), 'test_ok' ),
	'pos_connector_sync_now'         => array( array( 'POS_Connector_Settings', 'handle_sync_now' ), array(), 'sync_queued' ),
	'pos_connector_retry'            => array( array( 'POS_Connector_Settings', 'handle_retry' ), array(), 'nothing_to_retry' ),
	'pos_connector_resync_products'  => array( array( 'POS_Connector_Settings', 'handle_resync_products' ), array(), 'products_queued' ),
	'pos_connector_resync_orders'    => array( array( 'POS_Connector_Settings', 'handle_resync_orders' ), array(), 'orders_queued' ),
	'pos_connector_resync_customers' => array( array( 'POS_Connector_Settings', 'handle_resync_customers' ), array(), 'customers_queued' ),
	'pos_connector_resync_content'   => array( array( 'POS_Connector_Settings', 'handle_resync_content' ), array(), 'content_queued' ),
	'pos_connector_schedule'         => array( array( 'POS_Connector_Settings', 'handle_schedule' ), array( 'resync_products_schedule' => 'daily', 'resync_orders_schedule' => 'hourly', 'resync_orders_days' => '3' ), 'schedule_saved' ),
	'pos_connector_check_update'     => array( array( 'POS_Connector_Updater', 'handle_check_update' ), array(), null ),
);

// The registration list in init() and this table must name the same actions.
$settings_source = file_get_contents( $includes . 'class-pos-settings.php' );
$updater_source  = file_get_contents( $includes . 'class-pos-updater.php' );
preg_match_all( "/add_action\\( 'admin_post_(pos_connector_[a-z_]+)'/", $settings_source . $updater_source, $registered );
$registered = array_unique( $registered[1] );
sort( $registered );
$tested = array_keys( $actions );
sort( $tested );
check( $registered === $tested, 'the harness covers exactly the registered admin_post actions: ' . implode( ',', array_diff( $registered, $tested ) ) . ' / ' . implode( ',', array_diff( $tested, $registered ) ) );

foreach ( $actions as $action => $spec ) {
	list( $callable, $post, $notice ) = $spec;

	// 1. No capability: refused before anything else happens.
	t_reset();
	$GLOBALS['t']['can'] = false;
	$out = run_handler( $callable, $post );
	check( 'die' === $out['result'], "$action refuses a user without the capability" );
	check( array() === $GLOBALS['t']['nonces_checked'], "$action checks the capability before it looks at the nonce" );
	check( array() === $GLOBALS['t']['scheduled'] && array() === $GLOBALS['t']['http_calls'], "$action does nothing for a user without the capability" );

	// 2. Capability but no valid nonce.
	t_reset();
	$GLOBALS['t']['nonce_ok'] = false;
	$out = run_handler( $callable, $post );
	check( 'nonce' === $out['result'] && $action === $out['action'], "$action verifies the nonce named after itself" );
	check( array() === $GLOBALS['t']['scheduled'] && array() === $GLOBALS['t']['http_calls'] && array() === $GLOBALS['t']['options'], "$action changes nothing on a bad nonce" );
}

// 3. The clean path of each action — what it does, and where it sends the user.
t_reset();
$GLOBALS['t']['http']['https://pos.example/api/integrations/wordpress/ping'] = t_json( 200, array( 'ok' => true, 'status' => 'active', 'serverTime' => gmdate( 'c' ) ) );
$GLOBALS['t']['http']['https://updates.example.test/'] = array( 'error' => 'could not resolve host' );
$GLOBALS['t']['http']['https://api.github.com/repos/hamidnoshady/biza-miz/releases/latest'] = t_json( 200, array(
	'tag_name' => 'v1.7.0', 'html_url' => 'https://github.com/hamidnoshady/biza-miz/releases/tag/v1.7.0', 'body' => 'notes',
	'assets' => array( array( 'name' => 'pos-accounting-connector.zip', 'browser_download_url' => 'https://github.com/hamidnoshady/biza-miz/releases/download/v1.7.0/pos-accounting-connector.zip' ) ),
) );

foreach ( $actions as $action => $spec ) {
	list( $callable, $post, $notice ) = $spec;
	$GLOBALS['t']['scheduled']  = array();
	$GLOBALS['t']['nonces_checked'] = array();
	$out = run_handler( $callable, $post );
	check( 'redirect' === $out['result'], "$action redirects when it succeeds" );
	check( array( $action ) === $GLOBALS['t']['nonces_checked'], "$action checked its own nonce" );
	if ( null !== $notice ) {
		check( $notice === $out['query']['pos_notice'], "$action ends with the '$notice' notice (got " . $out['query']['pos_notice'] . ')' );
	}
	if ( 'pos_connector_check_update' === $action ) {
		check( 'pos-connector-updates' === $out['query']['page'], 'the update check returns to the updates tab' );
		check( 'update_available' === $out['query']['pos_notice'], 'with the manifest host down, the check falls back to GitHub and reports the real result (got ' . $out['query']['pos_notice'] . ')' );
	} else {
		// B4: back to the tab the form was on, not always the dashboard.
		check( 'pos-connector-synchronization' === $out['query']['page'], "$action returns to the tab it came from" );
	}
}

// --- the buttons only schedule ---------------------------------------------------------------
foreach ( array(
	'handle_sync_now'         => 'sync',
	'handle_resync_products'  => 'products',
	'handle_resync_orders'    => 'orders',
	'handle_resync_customers' => 'customers',
	'handle_resync_content'   => 'content',
) as $method => $kind ) {
	t_reset();
	$out = run_handler( array( 'POS_Connector_Settings', $method ) );
	check( array() === $GLOBALS['t']['http_calls'], "$method makes no network call inside the web request" );
	check( 1 === count( $GLOBALS['t']['scheduled'] ) && POS_CONNECTOR_CRON_MANUAL_JOB === $GLOBALS['t']['scheduled'][0]['hook'] && array( $kind ) === $GLOBALS['t']['scheduled'][0]['args'], "$method schedules one '$kind' job and nothing else" );
	// Pressing it twice before cron runs does not stack a second job.
	run_handler( array( 'POS_Connector_Settings', $method ) );
	check( 1 === count( $GLOBALS['t']['scheduled'] ), "$method pressed twice still leaves one queued job" );

	t_reset();
	$GLOBALS['t']['schedule_ok'] = false;
	$out = run_handler( array( 'POS_Connector_Settings', $method ) );
	check( 'queue_failed' === $out['query']['pos_notice'], "$method says so when WordPress refuses to schedule" );
}

// --- B5: one set of guards for every data-moving button ---------------------------------------
$guards = array(
	'test_not_configured' => array( 'base_url' => '' ),
	'disabled'            => array( 'enabled' => false ),
);
foreach ( array( 'handle_sync_now' => null, 'handle_resync_products' => 'sync_products', 'handle_resync_orders' => 'sync_orders', 'handle_resync_customers' => 'sync_customers', 'handle_resync_content' => null ) as $method => $toggle ) {
	foreach ( $guards as $expected => $settings ) {
		t_reset();
		update_option( 'pos_connector_settings', $settings );
		$out = run_handler( array( 'POS_Connector_Settings', $method ) );
		check( $expected === $out['query']['pos_notice'] && array() === $GLOBALS['t']['scheduled'], "$method refuses with '$expected'" );
	}
	t_reset();
	$GLOBALS['t']['woo'] = false;
	$out = run_handler( array( 'POS_Connector_Settings', $method ) );
	check( 'woo_missing' === $out['query']['pos_notice'], "$method refuses without WooCommerce — content included" );
	if ( $toggle ) {
		t_reset();
		update_option( 'pos_connector_settings', array( $toggle => false ) );
		$out = run_handler( array( 'POS_Connector_Settings', $method ) );
		check( preg_match( '/_disabled$/', $out['query']['pos_notice'] ) && array() === $GLOBALS['t']['scheduled'], "$method respects the app's $toggle switch" );
	}
	if ( 'handle_sync_now' !== $method ) {
		t_reset();
		update_option( 'pos_connector_settings', array( 'last_run_stats' => array( 'paused' => true ) ) );
		$out = run_handler( array( 'POS_Connector_Settings', $method ) );
		check( 'paused' === $out['query']['pos_notice'] && array() === $GLOBALS['t']['scheduled'], "$method does not queue while the app has paused the connection" );
	}
}
t_reset();
update_option( 'pos_connector_settings', array( 'last_run_stats' => array( 'paused' => true ) ) );
$out = run_handler( array( 'POS_Connector_Settings', 'handle_sync_now' ) );
check( 'sync_queued' === $out['query']['pos_notice'], '«اجرای سریع» still runs while paused: it is how a lifted pause is noticed' );

// --- B4: no referer, or a foreign one, lands on the dashboard ----------------------------------
t_reset();
$GLOBALS['t']['referer'] = false;
$out = run_handler( array( 'POS_Connector_Settings', 'handle_retry' ) );
check( 'pos-connector' === $out['query']['page'], 'without a referer the dashboard is the fallback' );
t_reset();
$GLOBALS['t']['referer'] = 'https://elsewhere.example/?page=pos-connector-queue';
// A referer is only trusted for its `page` value when that page is ours.
$out = run_handler( array( 'POS_Connector_Settings', 'handle_retry' ) );
check( 'pos-connector-queue' === $out['query']['page'], 'the page slug, not the host, decides' );
t_reset();
$GLOBALS['t']['referer'] = 'https://s.example/wp-admin/admin.php?page=some-other-plugin';
$out = run_handler( array( 'POS_Connector_Settings', 'handle_retry' ) );
check( 'pos-connector' === $out['query']['page'], 'a foreign page falls back to the dashboard' );

// --- B1: «آزمایش اتصال» names what is wrong ---------------------------------------------------
function test_press( array $answer, array $settings = array() ) {
	t_reset();
	if ( $settings ) {
		update_option( 'pos_connector_settings', $settings );
	}
	$GLOBALS['t']['http']['https://pos.example/api/integrations/wordpress/ping'] = $answer;
	$out = run_handler( array( 'POS_Connector_Settings', 'handle_test' ) );
	$out['detail']   = isset( $GLOBALS['t']['transients']['pos_connector_notice_detail_7'] ) ? $GLOBALS['t']['transients']['pos_connector_notice_detail_7'] : '';
	$out['settings'] = pos_connector_settings();
	$out['sent']     = isset( $GLOBALS['t']['http_calls'][0] ) ? json_decode( $GLOBALS['t']['http_calls'][0]['body'], true ) : array();
	return $out;
}
$now = time();

$out = test_press( t_json( 200, array( 'ok' => true, 'status' => 'active', 'serverTime' => gmdate( 'c', $now ) ) ) );
check( 'test_ok' === $out['query']['pos_notice'], 'test: healthy' );
check( '' !== $out['settings']['last_ping_ok_at'], 'test: records the ping time in its own field' );
check( '' === $out['settings']['last_sync_ok_at'] && '' === $out['settings']['last_run_at'], 'test: never touches the last-sync / last-run times (A1)' );
check( 'https://shop.example' === $out['sent']['siteUrl'] && '1.6.19' === $out['sent']['pluginVersion'], 'test: tells the app which site and version is asking' );

$out = test_press( t_json( 200, array( 'ok' => true, 'status' => 'paused', 'serverTime' => gmdate( 'c', $now ) ) ) );
check( 'test_paused' === $out['query']['pos_notice'], 'test: a paused connection is named' );

$out = test_press( t_json( 409, array( 'ok' => false, 'error' => 'site_mismatch', 'expectedSiteUrl' => 'https://old-shop.example' ) ) );
check( 'test_site_mismatch' === $out['query']['pos_notice'] && 'https://old-shop.example' === $out['detail'], 'test: site_mismatch (409) shows the address the app expected' );
check( '' === $out['settings']['last_ping_ok_at'], 'test: a failed ping is not recorded as OK' );

$out = test_press( t_json( 401, array( 'error' => 'stale_timestamp', 'serverTime' => gmdate( 'c', $now - 4000 ) ) ) );
check( 'test_stale_timestamp' === $out['query']['pos_notice'] && abs( (int) $out['detail'] - 4000 ) <= 2, 'test: stale_timestamp shows the skew in seconds (got ' . $out['detail'] . ')' );

$out = test_press( t_json( 401, array( 'error' => 'unauthorized' ) ) );
check( 'test_failed' === $out['query']['pos_notice'] && false !== strpos( $out['detail'], 'توکن' ), 'test: unauthorized is explained in words' );
$out = test_press( t_json( 403, array( 'error' => 'feature_disabled' ) ) );
check( 'test_failed' === $out['query']['pos_notice'] && false !== strpos( $out['detail'], 'فعال نیست' ), 'test: feature_disabled is explained' );
$out = test_press( array( 'error' => 'cURL error 6: could not resolve host' ) );
check( 'test_failed' === $out['query']['pos_notice'] && false !== strpos( $out['detail'], 'could not resolve' ), 'test: a transport failure shows the transport error' );
$out = test_press( t_json( 200, array( 'ok' => true, 'status' => 'active' ) ), array( 'token' => '' ) );
check( 'test_not_configured' === $out['query']['pos_notice'], 'test: no token is its own message' );

// --- B2: the update check falls back to GitHub, and says so ---------------------------------------
t_reset();
$GLOBALS['t']['http']['https://updates.example.test/'] = array( 'error' => 'could not resolve host' );
$GLOBALS['t']['http']['https://api.github.com/repos/hamidnoshady/biza-miz/releases/latest'] = t_json( 200, array(
	'tag_name' => 'v1.7.0', 'html_url' => 'https://github.com/hamidnoshady/biza-miz/releases/tag/v1.7.0', 'body' => '',
	'assets' => array( array( 'name' => 'pos-accounting-connector.zip', 'browser_download_url' => 'https://github.com/hamidnoshady/biza-miz/releases/download/v1.7.0/pos-accounting-connector.zip' ) ),
) );
$latest = POS_Connector_Updater::check();
check( '' === $latest['error'] && '1.7.0' === $latest['version'] && 'github' === $latest['source'], 'update: an unreachable manifest falls back to GitHub releases' );
check( 'manifest_unreachable' === $latest['fallback_from'], 'update: the cache still records why the preferred source failed' );
check( 0 === strpos( $latest['download_url'], 'https://github.com/hamidnoshady/biza-miz/' ), 'update: the package comes from this repository' );

t_reset();
$GLOBALS['t']['http']['https://updates.example.test/'] = array( 'error' => 'could not resolve host' );
$GLOBALS['t']['http']['https://api.github.com/'] = t_json( 403, array( 'message' => 'rate limited' ) );
$out = run_handler( array( 'POS_Connector_Updater', 'handle_check_update' ) );
check( 'update_check_failed' === $out['query']['pos_notice'], 'update: both sources down is a failure' );
$detail = $GLOBALS['t']['transients']['pos_connector_notice_detail_7'];
check( false !== strpos( $detail, 'manifest_unreachable' ) && false !== strpos( $detail, 'http_403' ), 'update: the notice carries the specific error codes of both sources (got ' . $detail . ')' );

t_reset();
$GLOBALS['t']['http']['https://updates.example.test/'] = t_json( 200, array( 'version' => '1.8.0', 'download_url' => 'https://updates.example.test/pos-accounting-connector.zip', 'checksum' => str_repeat( 'a', 64 ) ) );
$latest = POS_Connector_Updater::check();
check( 'self_host' === $latest['source'] && '1.8.0' === $latest['version'] && '' === $latest['fallback_from'], 'update: a working manifest is used as before, no fallback' );
check( 1 === count( $GLOBALS['t']['http_calls'] ), 'update: GitHub is not called when the manifest answers' );

echo $assertions . " admin-action assertions passed\n";
