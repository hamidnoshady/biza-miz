<?php
/**
 * Deterministic checks of the resumable export cursor (#1206), run under plain
 * `php` — no WordPress, no database.
 *
 *   php wordpress-plugin/tests/connector-export-cursor.php
 *
 * The bug this exists for is a silent one: content and order exports walked a
 * bounded slice, then threw the walk away. On a store with more rows than one
 * run the ceiling covers, every run re-read the same head and the tail was never
 * exported — the exact "the timestamp is fresh, the data is not there" symptom
 * issue #1206 was opened for. The cursor is only worth having if it is honest,
 * so what is pinned here is when it must refuse to be used:
 *
 *   - a cursor from a different window (or a different walk) is not resumed;
 *   - an expired cursor is not resumed;
 *   - a corrupt option reads as "no cursor", never as a fatal.
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

require dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-export-cursor.php';

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

// --- nothing stored means nothing to resume ----------------------------------

same( null, POS_Connector_Export_Cursor::resume( 'orders', array() ), 'an absent cursor is not resumed' );
same( null, POS_Connector_Export_Cursor::get( 'orders' ), 'and it reads as null, not as an empty array' );

// --- set / resume / clear -----------------------------------------------------

POS_Connector_Export_Cursor::set(
	'orders',
	array(
		'days'  => 7,
		'after' => '2026-10-26 12:00:00',
		'ts'    => 1793620800,
		'seen'  => array( 41, 42 ),
	)
);
$stored = POS_Connector_Export_Cursor::get( 'orders' );
check( isset( $stored['updated_at'] ) && $stored['updated_at'] > 0, 'set stamps when it was written' );
same( false, $GLOBALS['pos_test_autoload']['pos_connector_export_cursor_orders'], 'the cursor is never autoloaded' );

$resumed = POS_Connector_Export_Cursor::resume( 'orders', array( 'days' => 7, 'after' => '2026-10-26 12:00:00' ) );
same( 1793620800, $resumed['ts'], 'a fresh cursor for the same window is resumed' );
same( array( 41, 42 ), $resumed['seen'], 'the boundary second comes back with it' );

// --- a different walk must not inherit it ------------------------------------

same( null, POS_Connector_Export_Cursor::resume( 'orders', array( 'days' => 30, 'after' => '2026-10-26 12:00:00' ) ), 'a different window is not resumed' );
same( null, POS_Connector_Export_Cursor::get( 'orders' ), 'and the unusable cursor is discarded rather than left to be found again' );

POS_Connector_Export_Cursor::set( 'content', array( 'kind' => 'content', 'sync_id' => 'abc', 'type' => 'page', 'cursor' => 900 ) );
same( null, POS_Connector_Export_Cursor::resume( 'content', array( 'kind' => 'media' ) ), 'a different kind of walk is not resumed' );

// --- expiry ------------------------------------------------------------------

POS_Connector_Export_Cursor::set( 'orders', array( 'days' => 7, 'ts' => 1 ) );
$GLOBALS['pos_test_options']['pos_connector_export_cursor_orders']['updated_at'] = time() - POS_Connector_Export_Cursor::MAX_AGE_SECONDS - 5;
same( null, POS_Connector_Export_Cursor::resume( 'orders', array( 'days' => 7 ) ), 'a cursor older than the age limit is not resumed' );
same( null, POS_Connector_Export_Cursor::get( 'orders' ), 'an expired cursor is swept, not carried forward' );

// --- corrupt or foreign values ------------------------------------------------

$GLOBALS['pos_test_options']['pos_connector_export_cursor_content'] = 'not-an-array';
same( null, POS_Connector_Export_Cursor::get( 'content' ), 'a corrupt value reads as no cursor' );
$GLOBALS['pos_test_options']['pos_connector_export_cursor_content'] = array( 'sync_id' => 'x' );
same( null, POS_Connector_Export_Cursor::get( 'content' ), 'a value without a write time is not a cursor' );

// --- kinds are independent ----------------------------------------------------

POS_Connector_Export_Cursor::set( 'orders', array( 'ts' => 5 ) );
POS_Connector_Export_Cursor::set( 'content', array( 'cursor' => 900 ) );
same( 5, POS_Connector_Export_Cursor::get( 'orders' )['ts'], 'orders keeps its own cursor' );
same( 900, POS_Connector_Export_Cursor::get( 'content' )['cursor'], 'and content keeps its own' );
POS_Connector_Export_Cursor::clear( 'orders' );
same( null, POS_Connector_Export_Cursor::get( 'orders' ), 'clearing one leaves the other alone' );
same( 900, POS_Connector_Export_Cursor::get( 'content' )['cursor'], 'content survives it' );

// --- boundary-second ids ------------------------------------------------------

same( array( 1, 2, 3 ), POS_Connector_Export_Cursor::seen_ids( array( '1', '2', 3 ) ), 'ids come back as integers' );
same( 500, count( POS_Connector_Export_Cursor::seen_ids( range( 1, 2000 ) ) ), 'a pathological boundary second is capped' );

// --- an option name never grows out of the caller's string ---------------------

POS_Connector_Export_Cursor::set( '../../evil', array( 'ts' => 1 ) );
check( isset( $GLOBALS['pos_test_options']['pos_connector_export_cursor_evil'] ), 'the option name is sanitised, not interpolated raw' );

echo "$assertions export-cursor assertions passed\n";
