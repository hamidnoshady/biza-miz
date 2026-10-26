<?php
/**
 * Deterministic checks of the plugin's health policy (includes/class-pos-health.php),
 * run under plain `php` — no WordPress, no database, like media-import-policy.php.
 *
 *   php wordpress-plugin/tests/connector-reliability-policy.php
 *
 * Covers the issue #1149 items that are pure decisions:
 *   A1  the stale-cron verdict and the fields that feed it
 *   A5  the queue's give-up point (eight attempts, not seven)
 *   A6  the run lock: exclusion, release, expiry takeover
 *   B1  what the «آزمایش اتصال» answer means
 *   B4  which screen a handler returns to
 */
define( 'ABSPATH', '/tmp/' );
require dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-health.php';

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
	check( $expected === $actual, $label . ' (expected ' . var_export( $expected, true ) . ', got ' . var_export( $actual, true ) . ')' );
}

// --- A1: the stale-cron verdict -------------------------------------------------
$now      = strtotime( '2026-10-26 12:00:00 UTC' );
$ago      = static function ( $seconds ) use ( $now ) {
	return gmdate( 'Y-m-d H:i:s', $now - $seconds );
};
$base     = array( 'enabled' => true, 'base_url' => 'https://pos.example', 'token' => 'wplink_x', 'last_run_at' => '', 'armed_at' => '' );
same( 900, POS_Connector_Health::stale_after_seconds(), 'stale after three fast intervals' );

$fresh = POS_Connector_Health::cron_status( array_merge( $base, array( 'last_run_at' => $ago( 400 ) ) ), $now );
check( $fresh['configured'] && ! $fresh['stale'], 'a run six minutes ago is not stale' );

$edge = POS_Connector_Health::cron_status( array_merge( $base, array( 'last_run_at' => $ago( 900 ) ) ), $now );
check( ! $edge['stale'], 'exactly at the threshold is not yet stale' );

$stale = POS_Connector_Health::cron_status( array_merge( $base, array( 'last_run_at' => $ago( 901 ) ) ), $now );
check( $stale['stale'], 'one second past the threshold is stale' );
same( 901, $stale['age'], 'age is measured from the last run' );

// The case that hid two days of dead cron: a Test-button success is a
// different field and must not make a dead cron look alive.
$ping_only = POS_Connector_Health::cron_status(
	array_merge( $base, array( 'last_run_at' => $ago( 2 * 86400 ), 'last_ping_ok_at' => $ago( 10 ) ) ),
	$now
);
check( $ping_only['stale'], 'a recent test ping does not hide a stopped cron' );

// A cron that never worked: measured from when the connection was armed.
$never = POS_Connector_Health::cron_status( array_merge( $base, array( 'armed_at' => $ago( 3600 ) ) ), $now );
check( $never['stale'], 'enabled, armed an hour ago, never run: stale' );
$just_armed = POS_Connector_Health::cron_status( array_merge( $base, array( 'armed_at' => $ago( 60 ) ) ), $now );
check( ! $just_armed['stale'], 'armed a minute ago, never run: still within grace' );
$unknown = POS_Connector_Health::cron_status( $base, $now );
check( ! $unknown['stale'], 'no run and no armed time: nothing to measure from, so not stale' );

// Not configured or switched off: there is no cron to complain about.
$off = POS_Connector_Health::cron_status( array_merge( $base, array( 'enabled' => false, 'last_run_at' => $ago( 99999 ) ) ), $now );
check( ! $off['stale'] && ! $off['configured'], 'a disabled connection is never stale' );
$no_token = POS_Connector_Health::cron_status( array_merge( $base, array( 'token' => '', 'last_run_at' => $ago( 99999 ) ) ), $now );
check( ! $no_token['stale'], 'a connection without a token is never stale' );

same( 0, POS_Connector_Health::parse_utc( '' ), 'empty date parses to 0' );
same( $now, POS_Connector_Health::parse_utc( gmdate( 'Y-m-d H:i:s', $now ) ), 'a mysql UTC date round-trips' );

// --- A5: the queue gives up after exactly MAX_ATTEMPTS ---------------------------
$max = 8; // POS_Connector_Queue::MAX_ATTEMPTS
for ( $before = 0; $before <= 5; $before++ ) {
	same( 'pending', POS_Connector_Health::queue_failure_state( $before, $max )['status'], "after attempt " . ( $before + 1 ) . " the row is still pending" );
}
same( 'pending', POS_Connector_Health::queue_failure_state( 6, $max )['status'], 'the seventh failure does NOT give up (the off-by-one this guards)' );
same( 7, POS_Connector_Health::queue_failure_state( 6, $max )['attempts'], 'seventh failure counts 7' );
same( 'failed', POS_Connector_Health::queue_failure_state( 7, $max )['status'], 'the eighth failure gives up' );
same( 8, POS_Connector_Health::queue_failure_state( 7, $max )['attempts'], 'eighth failure counts 8' );
same( 1, POS_Connector_Health::queue_failure_state( -3, $max )['attempts'], 'a nonsense count starts over' );

// The production queue must use that helper, and carry the same limit.
$queue = file_get_contents( dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-queue.php' );
check( 1 === preg_match( '/const MAX_ATTEMPTS = 8;/', $queue ), 'queue MAX_ATTEMPTS is the 8 this test assumes' );
check( false !== strpos( $queue, 'POS_Connector_Health::queue_failure_state( $before, self::MAX_ATTEMPTS )' ), 'mark_failed decides the verdict through the helper' );
check( false === strpos( $queue, 'CASE WHEN attempts + 1' ), 'mark_failed no longer tests attempts+1 after incrementing attempts in one UPDATE' );

// --- A6: the run lock ------------------------------------------------------------
class Memory_Lock_Store {
	public $rows = array();
	public function add( $key, $value ) {
		if ( isset( $this->rows[ $key ] ) ) {
			return false;
		}
		$this->rows[ $key ] = $value;
		return true;
	}
	public function get( $key ) {
		return isset( $this->rows[ $key ] ) ? $this->rows[ $key ] : null;
	}
	public function delete_if( $key, $value ) {
		if ( isset( $this->rows[ $key ] ) && $this->rows[ $key ] === $value ) {
			unset( $this->rows[ $key ] );
			return true;
		}
		return false;
	}
}
$store = new Memory_Lock_Store();
$first = POS_Connector_Lock::acquire( 'run', 300, $now, $store );
check( is_string( $first ) && '' !== $first, 'the first run takes the lock' );
same( false, POS_Connector_Lock::acquire( 'run', 300, $now + 10, $store ), 'a second run while the first holds it is refused (wp pos-connector sync vs cron event run)' );
same( false, POS_Connector_Lock::acquire( 'run', 300, $now + 299, $store ), 'still held just before the TTL' );
same( false, POS_Connector_Lock::release( 'run', 'not-the-token', $store ), 'a stranger cannot release the lock' );
check( null !== $store->get( 'run' ), 'the lock survived the stranger' );
check( POS_Connector_Lock::release( 'run', $first, $store ), 'the holder releases its own lock' );
check( is_string( POS_Connector_Lock::acquire( 'run', 300, $now + 20, $store ) ), 'after release the next run can start' );

$crashed = new Memory_Lock_Store();
$dead    = POS_Connector_Lock::acquire( 'run', 300, $now, $crashed );
check( is_string( $dead ), 'a run that will crash takes the lock' );
$taker = POS_Connector_Lock::acquire( 'run', 300, $now + 301, $crashed );
check( is_string( $taker ) && $taker !== $dead, 'once the TTL has passed the next run takes the lock over' );
same( false, POS_Connector_Lock::release( 'run', $dead, $crashed ), 'the crashed holder, waking up late, cannot release the new holder\'s lock' );
same( false, POS_Connector_Lock::acquire( 'run', 300, $now + 302, $crashed ), 'the taker now holds it' );
check( is_string( POS_Connector_Lock::acquire( 'other', 300, $now, $crashed ) ), 'locks are independent per name' );

// And the production run() takes it.
$sync = file_get_contents( dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-sync.php' );
check( false !== strpos( $sync, "POS_Connector_Lock::acquire( 'run'" ), 'run() acquires the run lock' );
check( false !== strpos( $sync, "POS_Connector_Lock::release( 'run'" ), 'run() releases it in a finally block' );

// --- B1: what the Test button reports ---------------------------------------------
$iso = static function ( $ts ) {
	return gmdate( 'c', $ts );
};
$ok = array( 'ok' => true, 'status' => 200, 'error' => '', 'data' => array( 'status' => 'active', 'serverTime' => $iso( $now ) ) );
same( 'test_ok', POS_Connector_Health::interpret_ping( $ok, $now )['notice'], 'healthy ping' );
same( 'test_ok', POS_Connector_Health::interpret_ping( $ok, $now + 90 )['notice'], 'ninety seconds of skew is tolerated' );

$skewed = POS_Connector_Health::interpret_ping( $ok, $now + 200 );
same( 'test_clock_skew', $skewed['notice'], 'two minutes of skew warns even though the ping worked' );
same( '200', $skewed['detail'], 'the skew is reported in seconds' );
same( 'test_clock_skew', POS_Connector_Health::interpret_ping( $ok, $now - 200 )['notice'], 'a clock that is behind warns too' );
same( '200', POS_Connector_Health::interpret_ping( $ok, $now - 200 )['detail'], 'the skew is unsigned' );

$paused = array( 'ok' => true, 'status' => 200, 'error' => '', 'data' => array( 'status' => 'paused', 'serverTime' => $iso( $now ) ) );
same( 'test_paused', POS_Connector_Health::interpret_ping( $paused, $now )['notice'], 'a paused connection is named, not called healthy' );
$paused2 = array( 'ok' => true, 'status' => 200, 'error' => '', 'data' => array( 'serverStatus' => 'paused' ) );
same( 'test_paused', POS_Connector_Health::interpret_ping( $paused2, $now )['notice'], 'serverStatus=paused is read too' );

$mismatch = array( 'ok' => false, 'status' => 409, 'error' => 'site_mismatch', 'data' => array( 'expectedSiteUrl' => 'https://old.example' ) );
$result   = POS_Connector_Health::interpret_ping( $mismatch, $now );
same( 'test_site_mismatch', $result['notice'], 'a 409 site_mismatch is its own outcome' );
same( 'https://old.example', $result['detail'], 'the expected address is shown' );

$stale_ts = array( 'ok' => false, 'status' => 401, 'error' => 'stale_timestamp', 'data' => array( 'serverTime' => $iso( $now ) ) );
$result   = POS_Connector_Health::interpret_ping( $stale_ts, $now + 7200 );
same( 'test_stale_timestamp', $result['notice'], 'stale_timestamp is its own outcome' );
same( '7200', $result['detail'], 'the skew in seconds is shown' );
same( 'test_stale_timestamp', POS_Connector_Health::interpret_ping( array( 'ok' => false, 'status' => 401, 'error' => 'stale_timestamp', 'data' => array() ), $now )['notice'], 'stale_timestamp without a server clock still names itself' );

foreach ( array( 'unauthorized', 'bad_signature', 'feature_disabled', 'missing_token', 'replayed_nonce', 'http_502' ) as $code ) {
	$result = POS_Connector_Health::interpret_ping( array( 'ok' => false, 'status' => 401, 'error' => $code, 'data' => array() ), $now );
	same( 'test_failed', $result['notice'], "$code is a failure" );
	same( $code, $result['detail'], "$code carries its code" );
}

// The client must have an explanation for every code the Test button can meet.
$client = file_get_contents( dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-client.php' );
foreach ( array( 'unauthorized', 'bad_signature', 'stale_timestamp', 'site_mismatch', 'feature_disabled', 'missing_token', 'replayed_nonce' ) as $code ) {
	check( 1 === preg_match( "/'" . $code . "'\\s*=>/", $client ), "POS_Connector_Client::explain() has an entry for $code" );
}

// --- B4: which screen a handler returns to ----------------------------------------
$slugs = array( 'pos-connector', 'pos-connector-connection', 'pos-connector-synchronization', 'pos-connector-updates' );
same( 'pos-connector-synchronization', POS_Connector_Health::page_from_referer( 'https://s.example/wp-admin/admin.php?page=pos-connector-synchronization&pos_notice=saved', $slugs, 'pos-connector' ), 'back to the tab the form was on' );
same( 'pos-connector', POS_Connector_Health::page_from_referer( 'https://s.example/wp-admin/admin.php?page=evil-plugin', $slugs, 'pos-connector' ), 'a page that is not ours falls back to the dashboard' );
same( 'pos-connector', POS_Connector_Health::page_from_referer( false, $slugs, 'pos-connector' ), 'no referer falls back' );
same( 'pos-connector', POS_Connector_Health::page_from_referer( 'https://s.example/wp-admin/', $slugs, 'pos-connector' ), 'a referer without a page falls back' );
same( 'pos-connector', POS_Connector_Health::page_from_referer( 'https://s.example/wp-admin/admin.php?page[]=pos-connector-updates', $slugs, 'pos-connector' ), 'an array-valued page is ignored' );

// --- queued button presses -----------------------------------------------------------
$cron = array(
	1000 => array( 'pos_connector_manual_job' => array( 'k1' => array( 'args' => array( 'products' ) ) ), 'other' => array( 'k' => array( 'args' => array() ) ) ),
	2000 => array( 'pos_connector_manual_job' => array( 'k2' => array( 'args' => array( 'sync' ) ), 'k3' => array( 'args' => array( 'products' ) ) ) ),
	'version' => 2,
);
same( array( 'products', 'sync' ), POS_Connector_Health::queued_manual_jobs( $cron, 'pos_connector_manual_job' ), 'queued presses are listed once each' );
same( array(), POS_Connector_Health::queued_manual_jobs( false, 'pos_connector_manual_job' ), 'no cron array, no jobs' );

// --- one crontab line ---------------------------------------------------------------
same( '*/5 * * * * wp --path=/var/www/site cron event run --due-now > /dev/null 2>&1', POS_Connector_Health::system_cron_line( '/var/www/site/' ), 'the recommended line is the due-now runner' );
check( false !== strpos( POS_Connector_Health::system_cron_line_open_basedir( '/var/www/site' ), 'php -d open_basedir= /usr/bin/wp' ), 'the open_basedir form is available' );
$main = file_get_contents( dirname( __DIR__ ) . '/pos-accounting-connector/pos-accounting-connector.php' );
check( false === strpos( $main, 'pos-connector sync > /dev/null' ), 'the second, overlapping crontab line is gone from the plugin' );

echo $assertions . " reliability-policy assertions passed\n";
