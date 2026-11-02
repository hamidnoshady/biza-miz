<?php
/**
 * Deterministic checks of the issue #1206 P0 invocation record
 * (includes/class-pos-invocation-log.php), run under plain `php` — no
 * WordPress, no database, like connector-cron-truth-policy.php.
 *
 *   php wordpress-plugin/tests/connector-invocation-log.php
 *
 * The point of the record is that «آخرین اجرا» and «آخرین اجرای موفق» cannot
 * answer «چه شد؟». Four properties are load-bearing:
 *
 *   - a killed run leaves a trace (`interrupted`), and it is not rewritten
 *   - the ring is bounded, so a one-minute cadence cannot grow a table
 *   - the exit code mirrors what a monitoring crontab would see
 *   - an unknown verdict is a failure, never a quiet zero
 */
define( 'ABSPATH', '/tmp/' );

$GLOBALS['pos_test_options'] = array();

function get_option( $name, $default = false ) {
	return array_key_exists( $name, $GLOBALS['pos_test_options'] ) ? $GLOBALS['pos_test_options'][ $name ] : $default;
}
function update_option( $name, $value, $autoload = null ) {
	$GLOBALS['pos_test_options'][ $name ] = $value;
	$GLOBALS['pos_test_autoload'][ $name ] = $autoload;
	return true;
}
function delete_option( $name ) {
	unset( $GLOBALS['pos_test_options'][ $name ] );
	return true;
}
function wp_rand( $min, $max ) {
	return mt_rand( $min, $max );
}
/** Mirrors the plugin's real helper: system cron means WP-Cron is switched off. */
function pos_connector_uses_system_cron() {
	return defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON;
}

require dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-health.php';
require dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-invocation-log.php';

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

// --- exit codes: the number a monitoring crontab reads ------------------------

same( 0, POS_Connector_Invocation_Log::exit_code( POS_Connector_Health::PHASE_OK ), 'ok exits 0' );
same( 0, POS_Connector_Invocation_Log::exit_code( POS_Connector_Health::PHASE_EMPTY ), 'empty exits 0 — zero work is success when verified empty' );
same( 0, POS_Connector_Invocation_Log::exit_code( POS_Connector_Health::PHASE_SKIPPED ), 'skipped exits 0' );
same( 0, POS_Connector_Invocation_Log::exit_code( POS_Connector_Health::PHASE_PAUSED ), 'paused exits 0 — a decision is not a failure' );
same( 1, POS_Connector_Invocation_Log::exit_code( POS_Connector_Health::PHASE_PARTIAL ), 'partial exits 1' );
same( 2, POS_Connector_Invocation_Log::exit_code( POS_Connector_Health::PHASE_FAILED ), 'failed exits 2' );
same( 2, POS_Connector_Invocation_Log::exit_code( 'something_new' ), 'an unknown verdict exits 2, never 0' );
same( 2, POS_Connector_Invocation_Log::exit_code( '' ), 'an absent verdict exits 2' );

// --- a completed invocation ---------------------------------------------------

POS_Connector_Invocation_Log::clear();
$id = POS_Connector_Invocation_Log::start( array( 'trigger' => 'cron' ) );
check( '' !== $id, 'start returns an id' );
$during = POS_Connector_Invocation_Log::recent();
same( 1, count( $during ), 'the start is recorded before the run does anything' );
same( 'running', $during[0]['outcome'], 'a started invocation is running until it finishes' );
same( 'cron', $during[0]['trigger'], 'the trigger is recorded' );
check( isset( $during[0]['startedAt'] ) && '' !== $during[0]['startedAt'], 'the start has a UTC timestamp' );

POS_Connector_Invocation_Log::finish(
	$id,
	array(
		'verdict' => POS_Connector_Health::PHASE_FAILED,
		'pushed'  => 3,
		'applied' => 0,
		'phases'  => array(
			array( 'phase' => 'push', 'status' => POS_Connector_Health::PHASE_FAILED, 'counts' => array( 'sent' => 3 ) ),
			array( 'phase' => 'pull', 'status' => POS_Connector_Health::PHASE_FAILED ),
		),
		'errors'  => array( 'http_500' ),
	)
);
$done = POS_Connector_Invocation_Log::recent()[0];
same( 'completed', $done['outcome'], 'a finished invocation is completed' );
same( 2, $done['exitCode'], 'the failed run records exit code 2' );
same( 3, $done['pushed'], 'what moved is recorded' );
same( array( 'push' => 'failed', 'pull' => 'failed' ), $done['phases'], 'phase verdicts are kept as a map' );
check( in_array( 'http_500', $done['errors'], true ), 'the error survives' );
check( isset( $done['runtimeMs'] ) && is_int( $done['runtimeMs'] ) && $done['runtimeMs'] >= 0, 'runtime is measured in milliseconds' );
check( isset( $done['startedAtUnix'] ), 'the start is stored as whole seconds, which fits a 32-bit host' );

// A start that belongs to a previous request still closes, in whole seconds.
$GLOBALS['pos_test_options']['pos_connector_invocations'][] = array(
	'id'            => 'inv_previous_request',
	'startedAt'     => gmdate( 'Y-m-d H:i:s', time() - 7 ),
	'startedAtUnix' => time() - 7,
	'driver'        => 'system_cron',
	'trigger'       => 'cron',
	'outcome'       => 'running',
);
POS_Connector_Invocation_Log::finish( 'inv_previous_request', array( 'verdict' => POS_Connector_Health::PHASE_OK ) );
$from_previous = POS_Connector_Invocation_Log::recent()[0];
same( 0, $from_previous['exitCode'], 'a run closed from a later request records its verdict' );
check(
	isset( $from_previous['runtimeMs'] ) && is_int( $from_previous['runtimeMs'] ) && $from_previous['runtimeMs'] >= 6000,
	'the runtime falls back to whole seconds rather than inventing precision'
);

// The locked path: a skipped run that must not look like a healthy tick.
$locked_id = POS_Connector_Invocation_Log::start();
POS_Connector_Invocation_Log::finish( $locked_id, array( 'locked' => true, 'verdict' => POS_Connector_Health::PHASE_SKIPPED ) );
$locked = POS_Connector_Invocation_Log::recent()[0];
same( 0, $locked['exitCode'], 'a locked run exits 0 — another run is doing the work' );
check( in_array( 'run_locked', $locked['errors'], true ), 'but it is recorded as locked, not as an ordinary success' );

// --- the driver matches the deployment ---------------------------------------

same( 'wp_cron', POS_Connector_Invocation_Log::driver(), 'default driver is WP-Cron' );
define( 'DISABLE_WP_CRON', true );
same( 'system_cron', POS_Connector_Invocation_Log::driver(), 'with WP-Cron disabled the driver is the system crontab' );

// --- a run that died ----------------------------------------------------------

POS_Connector_Invocation_Log::clear();
$dangling = 'inv_dead';
$GLOBALS['pos_test_options']['pos_connector_invocations'] = array(
	array(
		'id'          => $dangling,
		'startedAt'   => gmdate( 'Y-m-d H:i:s', time() - 900 ),
		'startedAtUnix' => time() - 900,
		'driver'      => 'system_cron',
		'trigger'     => 'cron',
		'outcome'     => 'running',
	),
);
$interrupted = POS_Connector_Invocation_Log::recent()[0];
same( 'interrupted', $interrupted['outcome'], 'a running entry past the lock TTL is reported as interrupted' );
same( 2, $interrupted['exitCode'], 'an interrupted run did not succeed' );
same(
	'running',
	$GLOBALS['pos_test_options']['pos_connector_invocations'][0]['outcome'],
	'the stored entry is never rewritten — the record of a killed run stays'
);

// A run still inside its TTL is not called dead.
$GLOBALS['pos_test_options']['pos_connector_invocations'] = array(
	array(
		'id'          => 'inv_live',
		'startedAt'   => gmdate( 'Y-m-d H:i:s', time() - 30 ),
		'startedAtUnix' => time() - 30,
		'driver'      => 'wp_cron',
		'trigger'     => 'cron',
		'outcome'     => 'running',
	),
);
same( 'running', POS_Connector_Invocation_Log::recent()[0]['outcome'], 'a run inside the lock TTL is still running' );

// --- the ring stays bounded ---------------------------------------------------

POS_Connector_Invocation_Log::clear();
for ( $i = 0; $i < 25; $i++ ) {
	$run = POS_Connector_Invocation_Log::start();
	POS_Connector_Invocation_Log::finish( $run, array( 'verdict' => POS_Connector_Health::PHASE_OK, 'pushed' => $i ) );
}
$recent = POS_Connector_Invocation_Log::recent();
same( POS_Connector_Invocation_Log::RECENT_LIMIT, count( $recent ), 'the record is bounded at twenty entries' );
same( 24, $recent[0]['pushed'], 'newest first' );
same( 5, $recent[19]['pushed'], 'the oldest kept entry is the twentyth from the end' );
same( 20, count( $GLOBALS['pos_test_options']['pos_connector_invocations'] ), 'nothing older than the limit is stored' );
same( false, $GLOBALS['pos_test_autoload']['pos_connector_invocations'], 'the option is never autoloaded' );
same( 5, count( POS_Connector_Invocation_Log::recent( 5 ) ), 'the reader can ask for fewer' );
same( 20, count( POS_Connector_Invocation_Log::recent( 500 ) ), 'and cannot ask for more than the limit' );

// --- failure counting ---------------------------------------------------------

POS_Connector_Invocation_Log::clear();
$ok_run = POS_Connector_Invocation_Log::start();
POS_Connector_Invocation_Log::finish( $ok_run, array( 'verdict' => POS_Connector_Health::PHASE_EMPTY ) );
for ( $i = 0; $i < 2; $i++ ) {
	$bad_run = POS_Connector_Invocation_Log::start();
	POS_Connector_Invocation_Log::finish( $bad_run, array( 'verdict' => POS_Connector_Health::PHASE_FAILED ) );
}
same( 2, POS_Connector_Invocation_Log::failures_since( 3600 ), 'two failed ticks inside the window are counted' );
// An old failure is history, not a count that keeps climbing forever.
$GLOBALS['pos_test_options']['pos_connector_invocations'][] = array(
	'id'            => 'inv_yesterday',
	'startedAt'     => gmdate( 'Y-m-d H:i:s', time() - 7200 ),
	'startedAtUnix' => time() - 7200,
	'driver'        => 'wp_cron',
	'trigger'       => 'cron',
	'outcome'       => 'completed',
	'verdict'       => POS_Connector_Health::PHASE_FAILED,
	'exitCode'      => 2,
);
same( 2, POS_Connector_Invocation_Log::failures_since( 3600 ), 'a failure outside the window is not counted' );
same( 3, POS_Connector_Invocation_Log::failures_since( 7200 ), 'a wider window includes it' );

// --- a corrupt option must not break the doctor -------------------------------

$GLOBALS['pos_test_options']['pos_connector_invocations'] = 'not-an-array';
same( array(), POS_Connector_Invocation_Log::recent(), 'a corrupt option reads as empty, not as a fatal' );
$GLOBALS['pos_test_options']['pos_connector_invocations'] = array( 'junk', array( 'no_id' => true ) );
same( array(), POS_Connector_Invocation_Log::recent(), 'entries without an id and a start are dropped' );

echo "$assertions invocation-log assertions passed\n";
