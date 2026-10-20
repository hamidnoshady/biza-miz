<?php
/** Uses an externally provisioned WordPress core test suite + disposable DB. */
$tests_dir = getenv( 'WP_TESTS_DIR' );
if ( ! $tests_dir || ! file_exists( $tests_dir . '/includes/functions.php' ) ) {
	throw new RuntimeException( 'Set WP_TESTS_DIR to the WordPress core PHPUnit test suite.' );
}
require_once $tests_dir . '/includes/functions.php';
tests_add_filter( 'muplugins_loaded', static function () {
	$includes = dirname( __DIR__ ) . '/pos-accounting-connector/includes/';
	require_once $includes . 'class-pos-log.php';
	require_once $includes . 'class-pos-queue.php';
	require_once $includes . 'class-pos-sync.php';
} );
require $tests_dir . '/includes/bootstrap.php';
