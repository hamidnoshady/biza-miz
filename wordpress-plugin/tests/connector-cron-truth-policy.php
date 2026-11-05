<?php
/**
 * Deterministic checks of the issue #1206 cron/sync truth model
 * (includes/class-pos-health.php), run under plain `php` — no WordPress, no
 * database, like connector-reliability-policy.php.
 *
 *   php wordpress-plugin/tests/connector-cron-truth-policy.php
 *
 * The whole point of #1206 is that four things which used to be one number
 * are four different facts:
 *
 *   P0-1  the scheduler's current state, and why (`cron_state`)
 *   P0-2  whether a cycle actually worked (`phase`, `cycle_verdict`)
 *   P0-3  the interruption that ended, as history with a resolution time
 *         (`note_attempt`, `note_cycle`) — never as the current warning
 *   P0-4  a run lock that died mid-flight, readable without taking it
 *         (`POS_Connector_Lock::peek`)
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

$now     = strtotime( '2026-11-01 12:00:00 UTC' );
$ago     = static function ( $seconds ) use ( $now ) {
	return gmdate( 'Y-m-d H:i:s', $now - $seconds );
};
$base    = array(
	'enabled'   => true,
	'base_url'  => 'https://pos.example',
	'token'     => 'wplink_x',
	'last_run_at' => '',
	'armed_at'  => '',
	'last_ping_ok_at' => '',
	'last_sync_ok_at' => '',
	'last_run_stats'  => array(),
);

// --- P0-1: the scheduler's current state, and why ------------------------------

same( 180, POS_Connector_Health::delayed_after_seconds(), 'delayed after three one-minute intervals' );
same( 600, POS_Connector_Health::CRITICAL_AFTER_SECONDS, 'failed after ten minutes whatever the cadence' );

$states = static function ( array $overrides ) use ( $base, $now ) {
	return POS_Connector_Health::cron_state( array_merge( $base, $overrides ), $now );
};

$healthy = $states( array( 'last_run_at' => $ago( 40 ) ) );
same( 'healthy', $healthy['state'], 'a start forty seconds ago is healthy' );
same( 'recent_start', $healthy['reason'], 'and says why' );
check( ! $healthy['stale'], 'legacy stale stays false at forty seconds' );

// Two intervals: #1149 called this stale and that regression is preserved —
// but it is not yet «کند», because a shared host really does start 100s late.
$two = $states( array( 'last_run_at' => $ago( 121 ) ) );
check( $two['stale'], 'legacy stale still flips at 121s (#1149 regression)' );
same( 'healthy', $two['state'], 'two missed intervals is not yet «کند»' );
same( 2, $two['missedIntervals'], 'two missed intervals are counted' );

$delayed = $states( array( 'last_run_at' => $ago( 181 ) ) );
same( 'delayed', $delayed['state'], 'three missed intervals is «کند»' );
same( 'missed_starts', $delayed['reason'], 'with its own reason' );
check( ! $delayed['failed'], 'and it is not yet a failure' );

$failed = $states( array( 'last_run_at' => $ago( 601 ) ) );
same( 'failed', $failed['state'], 'ten minutes without a start is a failure' );
same( 'no_start_since', $failed['reason'], 'a run that happened but stopped says so' );
check( $failed['failed'], 'and the boolean agrees' );

// Configured, armed, never run: the case #1149 was opened for.
$never = $states( array( 'armed_at' => $ago( 3600 ) ) );
same( 'failed', $never['state'], 'armed an hour ago and never run is a failure' );
same( 'never_ran', $never['reason'], 'reported as never having run' );

// Armed a moment ago: grace, not a false alarm.
$armed_now = $states( array( 'armed_at' => $ago( 30 ) ) );
same( 'healthy', $armed_now['state'], 'just-armed is not a failure yet' );
same( 'awaiting_first_run', $armed_now['reason'], 'and says it is waiting for the first run' );

// «آزمایش اتصال» proves the token, not the schedule.
$test_only = $states( array( 'last_ping_ok_at' => $ago( 30 ) ) );
same( 'test_only', $test_only['state'], 'a ping without any cron evidence is test-only' );
same( 'ping_without_cron', $test_only['reason'], 'and says exactly that' );

// A recent ping must not hide a stopped cron either.
$ping_and_dead = $states( array( 'last_run_at' => $ago( 2 * 86400 ), 'last_ping_ok_at' => $ago( 10 ) ) );
same( 'failed', $ping_and_dead['state'], 'a fresh ping does not make a dead cron healthy' );

// The app's pause is its own state, not a scheduler failure.
$paused = $states( array( 'last_run_at' => $ago( 30 ), 'last_run_stats' => array( 'paused' => true, 'at' => $ago( 30 ) ) ) );
same( 'paused', $paused['state'], 'a run the app paused is paused, not failing' );
same( 'paused_by_app', $paused['reason'], 'with the app as the reason' );

// Not configured at all: unknown, and honestly so.
$unknown = POS_Connector_Health::cron_state( array_merge( $base, array( 'enabled' => false, 'last_run_at' => $ago( 3600 ) ) ), $now );
same( 'unknown', $unknown['state'], 'a disabled connection is unknown, never healthy or failed' );
same( 'not_configured', $unknown['reason'], 'and says it is not configured' );

// The legacy view must not disagree with the new one.
$legacy = POS_Connector_Health::cron_status( array_merge( $base, array( 'last_run_at' => $ago( 601 ) ) ), $now );
same( true, $legacy['stale'], 'cron_status still reports stale for a stopped cron' );
same( $failed['age'], $legacy['age'], 'cron_status and cron_state measure the same age' );

// --- P0-2: structured phases and the cycle verdict ----------------------------

$phase = POS_Connector_Health::phase( 'push', POS_Connector_Health::PHASE_OK, 1234, array( 'sent' => 7, 'failed' => 0 ), '' );
same( 'push', $phase['phase'], 'a phase keeps its name' );
same( 7, $phase['counts']['sent'], 'and its counters' );
same( 1234, $phase['durationMs'], 'and its duration' );
same( POS_Connector_Health::PHASE_FAILED, POS_Connector_Health::phase( 'push', 'nonsense', 0 )['status'], 'an unknown status is a failure, never a success' );

// The failure that used to be written as a success (#1206 P0-2).
$push_failed = POS_Connector_Health::cycle_verdict(
	array(
		POS_Connector_Health::phase( 'push', POS_Connector_Health::PHASE_FAILED, 500, array( 'sent' => 0, 'failed' => 50 ), 'http_500' ),
		POS_Connector_Health::phase( 'pull', POS_Connector_Health::PHASE_EMPTY, 200, array( 'applied' => 0, 'jobs' => 0 ) ),
	)
);
same( 'failed', $push_failed['status'], 'a failed push fails the cycle' );
check( ! $push_failed['verified'], 'and a failed cycle may not move last_sync_ok_at' );
check( in_array( 'http_500', $push_failed['errors'], true ), 'the sanitized error is carried' );
same( 0, $push_failed['dataMoved'], 'and nothing is claimed as moved' );

// Empty work is a success, but only because it was verified empty.
$empty = POS_Connector_Health::cycle_verdict(
	array(
		POS_Connector_Health::phase( 'push', POS_Connector_Health::PHASE_EMPTY, 10, array( 'sent' => 0, 'failed' => 0 ) ),
		POS_Connector_Health::phase( 'pull', POS_Connector_Health::PHASE_EMPTY, 10, array( 'applied' => 0, 'jobs' => 0 ) ),
	)
);
same( 'empty', $empty['status'], 'an idle queue is a verified empty cycle' );
check( $empty['verified'], 'which is healthy' );
same( 0, $empty['dataMoved'], 'but it moved nothing — «صف خالی» is not proof of transfer' );

// Applied but unacknowledged is partial: the app will lease the job again.
$partial = POS_Connector_Health::cycle_verdict(
	array(
		POS_Connector_Health::phase( 'push', POS_Connector_Health::PHASE_EMPTY, 10, array( 'sent' => 0, 'failed' => 0 ) ),
		POS_Connector_Health::phase( 'pull', POS_Connector_Health::PHASE_PARTIAL, 900, array( 'applied' => 3, 'failed' => 0, 'jobs' => 3 ), 'ack_timeout' ),
	)
);
same( 'partial', $partial['status'], 'an unacknowledged apply is partial' );
check( ! $partial['verified'], 'and is not a verified cycle' );
same( 3, $partial['dataMoved'], 'the applied count is still reported' );

// A deliberately skipped phase is a decision, not a failure.
$skipped = POS_Connector_Health::cycle_verdict(
	array(
		POS_Connector_Health::phase( 'push', POS_Connector_Health::PHASE_OK, 900, array( 'sent' => 12, 'failed' => 0 ) ),
		POS_Connector_Health::phase( 'pull', POS_Connector_Health::PHASE_SKIPPED, 0, array( 'applied' => 0 ), 'local_queue_not_drained' ),
	)
);
same( 'ok', $skipped['status'], 'a skipped pull behind a drained queue is still a working cycle' );
check( $skipped['verified'], 'and is verified' );
same( 12, $skipped['dataMoved'], 'with the push count' );

$paused_cycle = POS_Connector_Health::cycle_verdict(
	array( POS_Connector_Health::phase( 'run', POS_Connector_Health::PHASE_PAUSED, 0 ) )
);
same( 'paused', $paused_cycle['status'], 'a paused run is its own verdict' );
check( ! $paused_cycle['verified'], 'and proves nothing about the pipeline' );

$none = POS_Connector_Health::cycle_verdict( array() );
same( 'failed', $none['status'], 'no phases at all is a failure, never a silent success' );
check( ! $none['verified'], 'and cannot verify anything' );

// --- P0-3: history, not a live warning ---------------------------------------

$healthy_settings = array_merge( $base, array( 'incident_open' => false, 'incident_at' => '', 'incident_gap_seconds' => 0, 'incident_previous_state' => '', 'incident_recovered_at' => '' ) );

same( array(), POS_Connector_Health::note_attempt( $healthy_settings, $healthy, $now ), 'a healthy store records no incident' );

$opened = POS_Connector_Health::note_attempt( $healthy_settings, $failed, $now );
same( true, $opened['incident_open'], 'a failed start opens an incident' );
same( gmdate( 'Y-m-d H:i:s', $now ), $opened['incident_at'], 'stamped with the time it was noticed' );
same( 601, $opened['incident_gap_seconds'], 'with the gap it ended' );
same( '', $opened['incident_recovered_at'], 'and no resolution yet' );

$open_settings = array_merge( $healthy_settings, $opened );
same( array(), POS_Connector_Health::note_attempt( $open_settings, $failed, $now + 60 ), 'a second start inside the same outage does not restamp it' );

$recovered = POS_Connector_Health::note_cycle( $open_settings, $skipped, '2026-11-01 12:02:00' );
same( false, $recovered['incident_open'], 'a verified cycle closes the incident' );
same( '2026-11-01 12:02:00', $recovered['incident_recovered_at'], 'with a resolution time' );

same( array(), POS_Connector_Health::note_cycle( $open_settings, $push_failed, '2026-11-01 12:02:00' ), 'a failing cycle leaves the incident open' );
same( array(), POS_Connector_Health::note_cycle( $healthy_settings, $skipped, '2026-11-01 12:02:00' ), 'and a store with no incident records none' );

// `delayed` is an interruption too: three missed starts is the pattern the
// owner is told about.
$delayed_incident = POS_Connector_Health::note_attempt( $healthy_settings, $delayed, $now );
same( true, $delayed_incident['incident_open'], 'a delayed start opens an incident' );
same( 'delayed', $delayed_incident['incident_previous_state'], 'recording the state it was in' );

// --- P0-4: the run lock, read without taking it ------------------------------

/** In-memory lock store, the same contract as POS_Connector_Option_Lock_Store. */
class POS_Test_Lock_Store {
	private $rows = array();
	public function add( $key, $value ) {
		if ( array_key_exists( $key, $this->rows ) ) {
			return false;
		}
		$this->rows[ $key ] = $value;
		return true;
	}
	public function get( $key ) {
		return array_key_exists( $key, $this->rows ) ? $this->rows[ $key ] : null;
	}
	public function delete_if( $key, $value ) {
		if ( isset( $this->rows[ $key ] ) && $this->rows[ $key ] === $value ) {
			unset( $this->rows[ $key ] );
			return true;
		}
		return false;
	}
}

$store = new POS_Test_Lock_Store();
$free  = POS_Connector_Lock::peek( 'run', $store, $now );
check( ! $free['held'], 'an unused lock is not held' );
same( null, $free['expires_ts'], 'and has no expiry' );

$token = POS_Connector_Lock::acquire( 'run', 300, $now, $store );
check( false !== $token, 'the lock can be taken' );
$held = POS_Connector_Lock::peek( 'run', $store, $now + 60 );
check( $held['held'], 'peek sees the holder' );
same( 240, $held['seconds_left'], 'and how long is left' );
check( ! $held['expired'], 'and it is not expired' );

$expired = POS_Connector_Lock::peek( 'run', $store, $now + 400 );
check( $expired['expired'], 'a run that died past its lease is visible as expired' );
check( false !== POS_Connector_Lock::acquire( 'run', 300, $now + 400, $store ), 'and the next run may take it over' );

// --- P0-5: the probe, staged ---------------------------------------------------

same( 'none', POS_Connector_Health::probe_state( array(), $now )['state'], 'no probe is «none», not «ok»' );
same( 'none', POS_Connector_Health::probe_state( null, $now )['state'], 'and a null probe too' );

$queued_probe = array( 'id' => str_repeat( 'a', 32 ), 'queued_at' => $ago( 5 ), 'executed_at' => '', 'reported_at' => '', 'error' => '' );
$queued_state = POS_Connector_Health::probe_state( $queued_probe, $now );
same( 'queued', $queued_state['state'], 'a queued event is «queued» — a scheduled event proves nothing' );
same( 'awaiting_scheduler', $queued_state['reason'], 'and says it is waiting for the scheduler' );
same( 595, $queued_state['expiresIn'], 'with a visible expiry' );

$executed = POS_Connector_Health::probe_state( array_merge( $queued_probe, array( 'executed_at' => $ago( 3 ) ) ), $now );
same( 'executed', $executed['state'], 'a separate invocation running the event is the evidence' );
same( 'scheduler_ran_it', $executed['reason'], 'and says so' );

$reported = POS_Connector_Health::probe_state( array_merge( $queued_probe, array( 'executed_at' => $ago( 3 ), 'reported_at' => $ago( 2 ) ) ), $now );
same( 'reported', $reported['state'], 'signed telemetry arriving is the last stage' );

// The finding this control exists for: queued, never executed.
$expired = POS_Connector_Health::probe_state( array_merge( $queued_probe, array( 'queued_at' => $ago( 601 ) ) ), $now );
same( 'expired', $expired['state'], 'queued and never executed is «expired» — the scheduler is not running' );
same( 'queued_but_never_executed', $expired['reason'], 'with the reason stated plainly' );
same( 0, $expired['expiresIn'], 'and no grace left' );

// Executed but the report did not leave: a different diagnosis from expired.
$failed = POS_Connector_Health::probe_state( array_merge( $queued_probe, array( 'executed_at' => $ago( 4 ), 'error' => 'report_failed:http_500' ) ), $now );
same( 'failed', $failed['state'], 'executed but unreported is «failed», never «reported»' );
same( 'report_failed:http_500', $failed['reason'], 'carrying the sanitized reason' );
same( 600, POS_Connector_Health::PROBE_EXPIRY_SECONDS, 'ten minutes of grace' );

// One id per probe, whichever side minted it: the app sends 32 lowercase hex,
// the plugin mints the same shape, and anything else is refused rather than
// stored as a correlation id that will never match.
check( POS_Connector_Health::probe_id_is_valid( str_repeat( 'a', 32 ) ), 'thirty-two lowercase hex is a probe id' );
check( POS_Connector_Health::probe_id_is_valid( bin2hex( random_bytes( 16 ) ) ), 'and so is what the plugin mints' );
check( ! POS_Connector_Health::probe_id_is_valid( str_repeat( 'A', 32 ) ), 'uppercase is a different string, so it is refused' );
check( ! POS_Connector_Health::probe_id_is_valid( str_repeat( 'a', 31 ) ), 'a short id is refused' );
check( ! POS_Connector_Health::probe_id_is_valid( str_repeat( 'a', 32 ) . "\n" ), 'and nothing may end with a newline' );
check( ! POS_Connector_Health::probe_id_is_valid( '' ), 'an empty id is refused' );
check( ! POS_Connector_Health::probe_id_is_valid( null ), 'and so is a non-string' );

// --- P1: measured latency percentiles --------------------------------------
//
// The p95 ≤ 3-minute target is only ever *reported* from samples like these
// (`POS_Connector_Queue::delivery_latency()` feeds them enqueue → accepted
// lags). Nearest-rank, no interpolation: a percentile the operator reads is
// a duration some real event actually experienced.

same( null, POS_Connector_Health::percentiles( array() ), 'no samples is «no data», never zeros' );
same( null, POS_Connector_Health::percentiles( array( -5, 'junk', null ) ), 'samples that cannot be ordered do not become evidence' );

$one = POS_Connector_Health::percentiles( array( 42 ) );
same( 1, $one['samples'], 'one sample is counted as one' );
same( 42.0, $one['p95'], 'and is its own p95' );

$hundred = POS_Connector_Health::percentiles( range( 100, 1 ) );
same( 100, $hundred['samples'], 'unsorted input is sorted before ranking' );
same( 50.0, $hundred['p50'], 'p50 of 1..100 is 50 (nearest rank)' );
same( 95.0, $hundred['p95'], 'p95 of 1..100 is a real sample: 95' );
same( 99.0, $hundred['p99'], 'p99 of 1..100 is 99' );
same( 100.0, $hundred['max'], 'and the max is the slowest event, kept visible' );

$skewed = POS_Connector_Health::percentiles( array_merge( array_fill( 0, 19, 30 ), array( 900 ) ) );
same( 20, $skewed['samples'], 'a healthy store with one bad quarter-hour' );
same( 30.0, $skewed['p50'], 'median stays where most events were' );
same( 30.0, $skewed['p95'], 'p95 of 20 ranks the 19th — the outlier does not poison it' );
same( 900.0, $skewed['max'], 'but the outlier is still reported as the max' );

$mixed = POS_Connector_Health::percentiles( array( -10, 0, '15', 15.4, 'x' ) );
same( 3, $mixed['samples'], 'negative (clock-skew) and non-numeric samples are dropped, zero is kept' );
same( 15.0, $mixed['p50'], 'and numeric strings from the database rank normally' );

// --- UX-02: Jalali-facing timestamps ---------------------------------------
//
// Vectors are cross-checked against ICU's astronomical Persian calendar
// (`Intl.DateTimeFormat('fa-IR-u-ca-persian')`), including both kinds of
// year boundary and a Gregorian leap day. If the arithmetic converter ever
// disagrees with ICU inside a store's plausible date range, that is a bug
// to surface here, not a label to shrug at.

$vectors = array(
	array( 2026, 10, 31, 1405, 8, 9 ),
	array( 2026, 11, 2, 1405, 8, 11 ),
	array( 2026, 11, 3, 1405, 8, 12 ),
	array( 2024, 2, 29, 1402, 12, 10 ),
	array( 2024, 3, 19, 1402, 12, 29 ),
	array( 2024, 3, 20, 1403, 1, 1 ),
	array( 2025, 3, 21, 1404, 1, 1 ),
	array( 2000, 3, 20, 1379, 1, 1 ),
	array( 2000, 1, 1, 1378, 10, 11 ),
	array( 1979, 2, 11, 1357, 11, 22 ),
	array( 2030, 1, 1, 1408, 10, 12 ),
	array( 2023, 12, 31, 1402, 10, 10 ),
	array( 2026, 3, 20, 1404, 12, 29 ),
	array( 2026, 3, 21, 1405, 1, 1 ),
);
foreach ( $vectors as $v ) {
	same(
		array( $v[3], $v[4], $v[5] ),
		POS_Connector_Health::gregorian_to_jalali( $v[0], $v[1], $v[2] ),
		sprintf( 'gregorian %04d-%02d-%02d is jalali %d-%02d-%02d', $v[0], $v[1], $v[2], $v[3], $v[4], $v[5] )
	);
}

same( '۱۱ آبان ۱۴۰۵', POS_Connector_Health::jalali_date_label( 2026, 11, 2 ), 'the label a Persian operator reads: day, month name, year, Persian digits' );
same( '۱ فروردین ۱۴۰۳', POS_Connector_Health::jalali_date_label( 2024, 3, 20 ), 'nowruz formats as the first of farvardin, not a zero-padded triple' );
same( '۱۴۰۵-۰۸-۱۱ ۱۷:۴۵', POS_Connector_Health::persian_digits( '1405-08-11 17:45' ), 'digits convert, punctuation does not move' );
same( 'abc', POS_Connector_Health::persian_digits( 'abc' ), 'text without digits is untouched' );

printf( "%d cron-truth-policy assertions passed\n", $assertions );
