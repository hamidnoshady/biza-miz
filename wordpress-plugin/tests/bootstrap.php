<?php
/** Uses an externally provisioned WordPress core test suite + disposable DB. */
$tests_dir = getenv( 'WP_TESTS_DIR' );
if ( ! $tests_dir || ! file_exists( $tests_dir . '/includes/functions.php' ) ) {
	throw new RuntimeException( 'Set WP_TESTS_DIR to the WordPress core PHPUnit test suite.' );
}
// Core reads a PHP constant, not the environment variable itself.
$polyfills = getenv( 'WP_TESTS_PHPUNIT_POLYFILLS_PATH' );
if ( $polyfills && ! defined( 'WP_TESTS_PHPUNIT_POLYFILLS_PATH' ) ) {
	define( 'WP_TESTS_PHPUNIT_POLYFILLS_PATH', $polyfills );
}
require_once $tests_dir . '/includes/functions.php';
if ( ! defined( 'MEDIA_TRASH' ) ) define( 'MEDIA_TRASH', true );
tests_add_filter( 'muplugins_loaded', static function () {
	$includes = dirname( __DIR__ ) . '/pos-accounting-connector/includes/';
	require_once $includes . 'class-pos-log.php';
	require_once $includes . 'class-pos-queue.php';
	// The media snapshot persists where it stopped through the export cursor
	// (#1206 PERF-05), and the plugin's own loader includes this before the
	// sync class. Without it the snapshot walk is a fatal, not a test failure.
	require_once $includes . 'class-pos-export-cursor.php';
	require_once $includes . 'class-pos-sync.php';
} );
require $tests_dir . '/includes/bootstrap.php';
