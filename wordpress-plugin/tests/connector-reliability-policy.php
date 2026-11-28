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
same( 120, POS_Connector_Health::stale_after_seconds(), 'stale after two one-minute pulls' );

$fresh = POS_Connector_Health::cron_status( array_merge( $base, array( 'last_run_at' => $ago( 40 ) ) ), $now );
check( $fresh['configured'] && ! $fresh['stale'], 'a run forty seconds ago is not stale' );

$edge = POS_Connector_Health::cron_status( array_merge( $base, array( 'last_run_at' => $ago( 120 ) ) ), $now );
check( ! $edge['stale'], 'exactly at the threshold is not yet stale' );

$stale = POS_Connector_Health::cron_status( array_merge( $base, array( 'last_run_at' => $ago( 121 ) ) ), $now );
check( $stale['stale'], 'one second past the threshold is stale' );
same( 121, $stale['age'], 'age is measured from the last run' );

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
same( '* * * * * wp --path=/var/www/site cron event run --due-now > /dev/null 2>&1', POS_Connector_Health::system_cron_line( '/var/www/site/' ), 'the recommended line is the due-now runner' );
// The line used to ask for every five minutes while the fast lane runs every
// sixty seconds, so the recommended setup could never satisfy the «delayed»
// threshold (three missed fast intervals). The cadence is derived, not typed.
same( '* * * * *', POS_Connector_Health::system_cron_schedule(), 'the recommended cadence is one tick a minute, the fast lane interval itself' );
$schedule_minutes = '* * * * *' === POS_Connector_Health::system_cron_schedule()
	? 1
	: (int) trim( str_replace( array( '*/', ' ' ), '', POS_Connector_Health::system_cron_schedule() ) );
check( $schedule_minutes * 60 <= POS_Connector_Health::FAST_INTERVAL_SECONDS, 'the recommended cron never ticks less often than the fast lane is scheduled' );
check( false !== strpos( POS_Connector_Health::system_cron_line_open_basedir( '/var/www/site' ), '* * * * * php -d open_basedir= /usr/bin/wp' ), 'the open_basedir form keeps the same cadence' );
check( false !== strpos( POS_Connector_Health::system_cron_line_open_basedir( '/var/www/site' ), 'php -d open_basedir= /usr/bin/wp' ), 'the open_basedir form is available' );
$main = file_get_contents( dirname( __DIR__ ) . '/pos-accounting-connector/pos-accounting-connector.php' );
check( false === strpos( $main, 'pos-connector sync > /dev/null' ), 'the second, overlapping crontab line is gone from the plugin' );

// --- every hook we schedule is a hook we unschedule on uninstall ---------------
//
// Deactivating keeps the queue and the log on purpose; deleting the plugin is an
// explicit "I am done", and a single event left behind fires against a callback
// nothing registers any more, for the life of the site. The list of hooks is
// read from the plugin's own definitions, so a hook added later cannot be
// forgotten here.

$plugin_dir = dirname( __DIR__ ) . '/pos-accounting-connector/';
$sources    = array_merge( glob( $plugin_dir . 'includes/*.php' ), array( $plugin_dir . 'pos-accounting-connector.php' ) );
$hooks      = array();
foreach ( $sources as $file ) {
	$source = file_get_contents( $file );
	// Every hook the plugin defines a constant for is a hook it schedules.
	preg_match_all( "/define\( '(POS_CONNECTOR_CRON_[A-Z_]+)', '([a-z_]+)'/", $source, $defined, PREG_SET_ORDER );
	foreach ( $defined as $one ) {
		$hooks[ $one[1] ] = $one[2];
	}
	// And a hook scheduled by a local variable is not a constant.
	preg_match_all( '/\$hook\s*=\s*\'(pos_connector_[a-z_]+)\'/', $source, $assigned, PREG_SET_ORDER );
	foreach ( $assigned as $one ) {
		$hooks[ $one[1] ] = $one[1];
	}
}

check( count( $hooks ) >= 8, 'the scan finds the plugin cron hooks (found ' . count( $hooks ) . ')' );
$uninstall  = file_get_contents( $plugin_dir . 'uninstall.php' );
$forgotten  = array();
foreach ( $hooks as $constant => $hook ) {
	if ( ! preg_match( "/wp_(?:clear_scheduled|unschedule)_hook\(\s*'" . preg_quote( $hook, '/' ) . "'/", $uninstall ) ) {
		$forgotten[] = $hook;
	}
}
same( array(), $forgotten, 'uninstall.php unschedules every hook the plugin schedules' );

// One clean-up line per hook: a duplicated call is dead code, and this file has
// been edited by hand more than once.
$repeated = array();
foreach ( $hooks as $constant => $hook ) {
	if ( preg_match_all( "/wp_(?:clear_scheduled|unschedule)_hook\(\s*'" . preg_quote( $hook, '/' ) . "'/", $uninstall ) > 1 ) {
		$repeated[] = $hook;
	}
}
same( array(), $repeated, 'and no hook is unscheduled twice' );

// The chunked exports keep progress in options; the clean-up matches each
// prefix exactly once.
$prefixes = array();
foreach ( $sources as $file ) {
	preg_match_all( '/\$prefix\s*=\s*\'(pos_connector_[a-z_]+)\'/', file_get_contents( $file ), $found, PREG_SET_ORDER );
	foreach ( $found as $one ) {
		$prefixes[ $one[1] ] = true;
	}
}
check( count( $prefixes ) >= 2, 'the scan finds the export progress prefixes' );
$uncovered = array();
foreach ( array_keys( $prefixes ) as $prefix ) {
	if ( 1 !== substr_count( $uninstall, "'" . $prefix . "'" ) ) {
		$uncovered[] = $prefix;
	}
}
same( array(), $uncovered, 'uninstall.php deletes each export progress prefix exactly once' );

// --- option keys outside the settings array -------------------------------------
//
// Written by literal name or through a constant, read by name in uninstall.php
// (which never loads the plugin). A key added later and not deleted here is a
// row left in every shop's options table forever.
$option_keys = array();
foreach ( $sources as $file ) {
	$source = file_get_contents( $file );
	preg_match_all( "/(?:update|add|get|delete)_option\(\s*'(pos_connector_[a-z0-9_]+)'/", $source, $named, PREG_SET_ORDER );
	foreach ( $named as $one ) {
		$option_keys[ $one[1] ] = true;
	}
}
// The settings array and the schema version are written through constants.
preg_match_all( "/define\(\s*'(POS_CONNECTOR_(?:OPTION|DB_VERSION_OPTION))',\s*'(pos_connector_[a-z0-9_]+)'/", implode( "\n", array_map( 'file_get_contents', $sources ) ), $constants_named, PREG_SET_ORDER );
foreach ( $constants_named as $one ) {
	$option_keys[ $one[2] ] = true;
}

check( count( $option_keys ) >= 5, 'the scan finds the plugin option keys (found ' . count( $option_keys ) . ')' );
$orphan_keys = array();
foreach ( array_keys( $option_keys ) as $key ) {
	if ( 1 !== substr_count( $uninstall, "'" . $key . "'" ) ) {
		$orphan_keys[] = $key;
	}
}
same( array(), $orphan_keys, 'uninstall.php deletes every option key the plugin writes, exactly once' );

// --- PERF-01/PERF-02: nothing per-request that can be per-update ---------------
//
// `maybe_upgrade_db()` is hooked on `plugins_loaded`, i.e. every request, and it
// used to run `dbDelta()` twice and a `SHOW TABLES` to answer a question whose
// answer changes only on update. The guard is a schema-version read.
$main_source = file_get_contents( $plugin_dir . 'pos-accounting-connector.php' );
check( false !== strpos( $main_source, 'function pos_connector_db_version()' ), 'the schema version is one value, in one place' );
check( 1 === preg_match( '/function pos_connector_maybe_upgrade_db\(\)\s*\{\s*\$installed = \(string\) get_option\( POS_CONNECTOR_DB_VERSION_OPTION/s', $main_source ), 'dbDelta is gated by a schema-version read before anything else' );
check( false !== strpos( $main_source, 'update_option( POS_CONNECTOR_DB_VERSION_OPTION, pos_connector_db_version(), true )' ), 'and the version is stored autoloaded, so the gate costs no query' );
check( false !== strpos( $main_source, 'POS_CONNECTOR_INSTALL_RETRY_SECONDS' ), 'a failed install is retried, but not on every request' );

$queue_source = file_get_contents( $plugin_dir . 'includes/class-pos-queue.php' );
check( 1 === preg_match( '/private static \$table_present = null;/', $queue_source ), 'the queue asks whether its table exists once per request' );
check( 1 === substr_count( $queue_source, "SHOW TABLES LIKE" ), 'and keeps only one SHOW TABLES call in the class' );
check( false !== strpos( $queue_source, 'KEY topic_remote_status (topic, remote_id, status)' ), 'the de-duplication read has an index of its own columns, in its own order' );
check( false === strpos( $queue_source, 'UNIQUE KEY topic_remote_status' ), 'and it is not unique: a product legitimately has a sent row and a pending one' );
check( false !== strpos( $queue_source, 'KEY topic_remote_id (topic, remote_id, id)' ), 'latest-version lookup has a matching index' );
check( false !== strpos( $queue_source, 'WHERE topic = %s AND remote_id = %s ORDER BY id DESC LIMIT 1' ), 'duplicate detection checks the newest version of the entity' );
check( false !== strpos( $queue_source, 'earlier.id < candidate.id' ), 'an older pending product version precedes a later one' );
check( false !== strpos( $queue_source, "SET status = 'sent', payload = ''" ), 'successful acknowledgement clears the stored body' );
check( false !== strpos( $queue_source, "AND sealed = 0 AND BINARY payload = %s" ), 'delivery freezes the exact snapshot selected by the worker' );

// `ensure_schedules()` on `init` is the other per-request question.
check( false !== strpos( $main_source, 'function pos_connector_schedules_due_for_check()' ), 'the schedule check is throttled' );
check( 1 === preg_match( '/function pos_connector_ensure_schedules\( \$force = false \)\s*\{\s*if \( ! \$force && ! pos_connector_schedules_due_for_check\(\) \)/s', $main_source ), 'and ensure_schedules consults the throttle first' );
check( false !== strpos( $main_source, 'pos_connector_ensure_schedules( true );' ), 'activation forces it, so a fresh install is armed immediately' );

require dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-queue.php';
$legacy = '{"id":42}';
check( $legacy === POS_Connector_Queue::unpack_payload( $legacy ), 'legacy pending JSON remains deliverable' );
$json = json_encode( array( 'description' => str_repeat( 'WooCommerce product description. ', 400 ) ) );
$packed = POS_Connector_Queue::pack_payload( $json );
if ( function_exists( 'gzencode' ) && function_exists( 'gzdecode' ) ) {
	check( strlen( $packed ) < strlen( $json ) / 4, 'compressible queued text uses less than a quarter of its original storage' );
	check( false === POS_Connector_Queue::unpack_payload( 'gzip:invalid!' ), 'invalid stored data cannot be delivered' );
}
check( $json === POS_Connector_Queue::unpack_payload( $packed ), 'packed delivery restores the exact original JSON' );

// --- #1550: unchanged state is skipped only when it is already queued or sent ---
//
// A failed or dead row proves the state never arrived. Skipping it there would
// leave a catalogue/customer/content change undelivered until an operator
// pressed "retry", which is the durability bug this guards.
$row = static function ( $status, $fingerprint ) {
	return array( 'status' => $status, 'payload_fingerprint' => $fingerprint );
};
check( POS_Connector_Queue::unchanged_state_already_queued( $row( 'pending', 'abc' ), 'abc', false ), 'a pending row already carries the newest state' );
check( POS_Connector_Queue::unchanged_state_already_queued( $row( 'sent', 'abc' ), 'abc', false ), 'a delivered non-financial state is skipped' );
check( ! POS_Connector_Queue::unchanged_state_already_queued( $row( 'sent', 'abc' ), 'abc', true ), 'a delivered financial state keeps its own identity' );
check( ! POS_Connector_Queue::unchanged_state_already_queued( $row( 'failed', 'abc' ), 'abc', false ), 'a failed row is queued again instead of skipped' );
check( ! POS_Connector_Queue::unchanged_state_already_queued( $row( 'dead', 'abc' ), 'abc', false ), 'a dead row is queued again instead of skipped' );
check( ! POS_Connector_Queue::unchanged_state_already_queued( $row( 'sent', 'abc' ), 'def', false ), 'a changed state is never skipped' );
check( ! POS_Connector_Queue::unchanged_state_already_queued( $row( 'sent', '' ), '', false ), 'a topic without a fingerprint is never skipped' );
check( false !== strpos( $queue, 'self::unchanged_state_already_queued( $existing, $fingerprint, $financial )' ), 'enqueue decides the skip through the tested helper' );

// --- #1550 follow-up: a sweep re-reading an unchanged state is not a new event ---
//
// The producer used to write a fresh `order.updated` row every five minutes for
// every order in the lookback window, even when the app had already accepted the
// identical snapshot: 100 orders produced 435 identical rows each in 40 hours.
// The sweep now reconciles against the newest row instead.
if ( ! function_exists( 'wp_json_encode' ) ) {
	function wp_json_encode( $value ) { return json_encode( $value ); }
}
$order_payload = array( 'id' => 7, 'status' => 'completed', 'date_modified' => '2026-11-27T10:00:00+00:00', 'total' => '1000' );
$order_fp      = POS_Connector_Queue::fingerprint_for( 'order.updated', $order_payload );
same( $order_fp, POS_Connector_Queue::fingerprint_for( 'order.updated', $order_payload ), 'the same order state has the same fingerprint' );
check( $order_fp !== POS_Connector_Queue::fingerprint_for( 'order.updated', array_merge( $order_payload, array( 'status' => 'cancelled' ) ) ), 'a changed order state has a different fingerprint' );
$product_payload = array( 'id' => 7, 'name' => 'A', 'date_modified' => '2026-11-27T10:00:00+00:00' );
same(
	POS_Connector_Queue::fingerprint_for( 'product.updated', $product_payload ),
	POS_Connector_Queue::fingerprint_for( 'product.updated', array_merge( $product_payload, array( 'date_modified' => '2026-11-27T11:00:00+00:00' ) ) ),
	'a product save timestamp alone does not change the fingerprint'
);
same( '', POS_Connector_Queue::fingerprint_for( 'order.created', $order_payload ), 'topics without state identity are never swept-deduplicated' );

$now = 1_800_000_000;
same( 'enqueue', POS_Connector_Queue::swept_state_decision( 'sent', 'old', 'new', $now, $now ), 'a changed state is enqueued by a sweep' );
same( 'skip', POS_Connector_Queue::swept_state_decision( 'pending', 'abc', 'abc', $now, $now ), 'a pending identical state is not written twice' );
same( 'skip', POS_Connector_Queue::swept_state_decision( 'sent', 'abc', 'abc', $now, $now ), 'a delivered identical financial state is not re-created by a sweep' );
same( 'skip', POS_Connector_Queue::swept_state_decision( 'failed', 'abc', 'abc', $now - 60, $now ), 'a recently failed identical state waits for its cooldown' );
same( 'requeue', POS_Connector_Queue::swept_state_decision( 'failed', 'abc', 'abc', $now - POS_Connector_Queue::SWEEP_FAILED_RETRY_SECONDS, $now ), 'a failed identical state is retried in place after the cooldown' );
same( 'enqueue', POS_Connector_Queue::swept_state_decision( 'failed', 'old', 'new', $now - 3600, $now ), 'a changed failed state is enqueued normally' );
check( false !== strpos( $queue, 'self::reconcile_swept_state(' ) || false !== strpos( $queue, 'function reconcile_swept_state(' ), 'the sweep reconciles against the newest queued state' );
check( false !== strpos( $queue, "WHERE id = %d AND status = 'failed'" ), 'a swept failed row is requeued in place, keeping its delivery id' );
$sync = file_get_contents( dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-sync.php' );
check( 2 === substr_count( $sync, 'reconcile_swept_state(' ), 'both order-sweep walks reconcile before enqueueing' );
check( 2 === substr_count( $sync, "'type'          => 'shop_order'," ), 'both order-sweep walks exclude refund rows from wc_get_orders' );
check( false !== strpos( $sync, "'shop_order' !== \$order->get_type()" ), 'a refund never enters the order enqueue path' );
check( false !== strpos( $sync, 'public static function export_orders( $days = 7, $force = false )' ), 'an explicit export can still force a re-send' );
check( false !== strpos( $queue, "SET payload = '' WHERE status = 'sent'" ), 'housekeeping clears delivered bodies left by the old schema' );
check( false !== strpos( $queue, "topic NOT IN ('order.created', 'order.updated', 'refund.created', 'content.deleted', 'customer.deleted')" ), 'non-financial, non-tombstone failed rows expire; financial rows and deletions do not' );
$cli = file_get_contents( dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-cli.php' );
check( false !== strpos( $cli, "'tableStorageBytes'" ), 'doctor reports the physical queue-table size, not only live payload bytes' );
// WP-CLI rewrites `--json` to `--format=json` before dispatch; a command that
// only declares `--json` fails with "unknown --format parameter".
check( false !== strpos( $cli, '[--format=<format>]' ), 'doctor declares the format WP-CLI rewrites --json into' );
check( false !== strpos( $cli, "\$json   = 'json' === \$format" ), 'doctor accepts both --json and --format=json' );
check( false !== strpos( $queue, 'information_schema.tables' ), 'and that measurement reads the table size from information_schema' );

// --- #1206 UX-04: the queue screen is bounded, filtered and payload-free ---------
//
// The WordPress «صف و خطاها» screen used to render a count card and nothing
// else. It now asks for one bounded page; these pins keep that page from
// becoming an unbounded scan or a payload/PII leak, and keep the notice detail
// that handlers store from being dropped again.
$admin_source = file_get_contents( $plugin_dir . 'includes/class-pos-admin.php' );
same( 'open', POS_Connector_Queue::normalize_page_filters( 'DROP TABLE', '' )['status'], 'an unknown queue filter falls back to the open rows' );
same( 'failed', POS_Connector_Queue::normalize_page_filters( 'failed', '' )['status'], 'a known queue filter survives' );
same( 'searched', POS_Connector_Queue::normalize_page_filters( 'all', '  searched  ' )['search'], 'the queue search is trimmed' );
same( 80, mb_strlen( POS_Connector_Queue::normalize_page_filters( 'all', str_repeat( 'x', 200 ) )['search'], 'UTF-8' ), 'the queue search is bounded to eighty characters' );
check( false !== strpos( $queue_source, '$wpdb->esc_like( $search )' ), 'the queue search is escaped for LIKE' );
check( false !== strpos( $queue_source, "implode( ' AND ', \$where )" ), 'the queue page composes only validated clauses' );
check( false === strpos( $queue_source, 'payload LIKE' ), 'the queue search never reads the payload' );
check( false !== strpos( $queue_source, 'LIMIT %d' ), 'a queue page is always limited' );
check( false !== strpos( $admin_source, 'POS_Connector_Queue::page( $after, 20, $status, $search )' ), 'the screen asks for one bounded server-side page' );
check( false !== strpos( $admin_source, 'aria-current="page"' ), 'the active tab is announced as the current page' );
check( 1 === preg_match( '/\$detail\s*=\s*\$notice \? self::take_notice_detail\(\)/', $admin_source ), 'a notice detail is assigned before it is printed' );
check( false !== strpos( $admin_source, 'pos-queue-scroll' ), 'the queue table has an explicit narrow-screen scroll affordance' );

echo $assertions . " reliability-policy assertions passed\n";
