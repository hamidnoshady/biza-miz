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

// The self-updater's cached check and its last-check log (class-pos-updater.php).
// Deleted by name rather than read: uninstall runs without the includes ever
// loading, so no constant from the plugin can be used here.
delete_option( 'pos_connector_update' );
delete_option( 'pos_connector_update_last_log' );

// Keys written outside the settings array, by literal name:
// the schema version that gates `dbDelta()`, when the schedules were last
// checked, and a failed install's details. The guard in
// connector-reliability-policy.php keeps this list honest.
delete_option( 'pos_connector_db_version' );
delete_option( 'pos_connector_schedules_checked_at' );
delete_option( 'pos_connector_queue_install_failed' );

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
// Found by the guard in connector-reliability-policy.php: the customer export's
// continuation was scheduled but never unscheduled, so deleting the plugin left
// an event firing against an unregistered callback for the life of the site.
wp_unschedule_hook( 'pos_connector_customer_export_continue' );
// The scheduler probe's single event carries its correlation id for the same
// reason — and a probe left behind would report on a site that no longer has the
// plugin to report to.
wp_unschedule_hook( 'pos_connector_cron_probe' );
// The content export's continuation (#1206) has no arguments — the cursor names
// the snapshot — but it is still a single event that must not outlive the site's
// copy of the plugin.
wp_unschedule_hook( 'pos_connector_content_export_continue' );
// The Torob attribution switches (issue #894). Left behind, a reinstall would
// arrive with consent already granted — the one thing the documents say must be
// a deliberate act per install.
delete_option( 'pos_connector_torob_orders' );
delete_option( 'pos_connector_torob_actions' );
// Export progress and run locks live in options under these prefixes.
$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s OR option_name LIKE %s OR option_name LIKE %s OR option_name LIKE %s", $wpdb->esc_like( 'pos_connector_product_export_' ) . '%', $wpdb->esc_like( 'pos_connector_customer_export_' ) . '%', $wpdb->esc_like( 'pos_connector_export_cursor_' ) . '%', $wpdb->esc_like( 'pos_connector_lock_' ) . '%', $wpdb->esc_like( 'pos_connector_invocations' ) . '%' ) );
