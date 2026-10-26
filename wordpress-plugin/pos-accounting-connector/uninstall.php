<?php
/**
 * Uninstall — the only place this plugin actually destroys anything.
 *
 * Deactivation deliberately keeps the queue and the log (see the deactivation
 * hook), because deactivating to investigate a problem should not delete the
 * evidence. Deleting the plugin is an explicit "I am done with this", so the
 * credential goes first and the tables follow.
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

delete_option( 'pos_connector_settings' );

// The self-updater's cached check (class-pos-updater.php). Deleted by name
// rather than read: uninstall runs without the includes ever loading.
delete_option( 'pos_connector_update' );

global $wpdb;
// phpcs:disable WordPress.DB.DirectDatabaseQuery -- schema teardown has no API.
$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}pos_connector_queue" );
$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}pos_connector_log" );

// Every hook the plugin ever schedules, including the two daily backfills
// added in 1.2.0 — one left behind is an orphaned WP-Cron entry that fires
// against a callback nothing registers any more, forever.
wp_clear_scheduled_hook( 'pos_connector_sync' );
wp_clear_scheduled_hook( 'pos_connector_resync_orders' );
wp_clear_scheduled_hook( 'pos_connector_resync_products' );
wp_clear_scheduled_hook( 'pos_connector_resync_customers' );
wp_clear_scheduled_hook( 'pos_connector_resync_content' );

// The queued button presses and the chunked catalogue export's continuation
// carry arguments, which wp_clear_scheduled_hook() above would not match.
wp_unschedule_hook( 'pos_connector_manual_job' );
wp_unschedule_hook( 'pos_connector_product_export_continue' );
// Export progress and run locks live in options under these prefixes.
$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s", $wpdb->esc_like( 'pos_connector_product_export_' ) . '%', $wpdb->esc_like( 'pos_connector_lock_' ) . '%' ) );
