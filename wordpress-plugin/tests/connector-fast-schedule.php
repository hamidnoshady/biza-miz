<?php
// Run actual schedule and refund payload methods with a minimal WordPress host.
define( 'ABSPATH', __DIR__ );
define( 'MINUTE_IN_SECONDS', 60 );
define( 'HOUR_IN_SECONDS', 3600 );
define( 'DAY_IN_SECONDS', 86400 );
function add_action( ...$args ) {}
function add_filter( ...$args ) {}
function register_activation_hook( ...$args ) {}
function register_deactivation_hook( ...$args ) {}
function plugin_dir_path( $file ) { return dirname( $file ) . '/'; }
function __( $text, ...$args ) { return $text; }
function wp_parse_args( $args, $defaults ) { return array_merge( $defaults, (array) $args ); }
function get_option( $key, $default = false ) { return $default; }
function update_option( ...$args ) { return true; }
function current_time( ...$args ) { return gmdate( 'Y-m-d H:i:s' ); }
$events = array();
$cleared = array();
function wp_get_schedule( $hook ) { global $events; return $events[ $hook ] ?? false; }
function wp_next_scheduled( $hook ) { return wp_get_schedule( $hook ) ? time() + 60 : false; }
function wp_clear_scheduled_hook( $hook ) { global $events, $cleared; unset( $events[ $hook ] ); $cleared[] = $hook; }
function wp_schedule_event( $at, $schedule, $hook ) { global $events; $events[ $hook ] = $schedule; }
require dirname( __DIR__ ) . '/pos-accounting-connector/pos-accounting-connector.php';
function check( $condition, $message ) { if ( ! $condition ) { fwrite( STDERR, $message . "\n" ); exit( 1 ); } }
$events[ POS_CONNECTOR_CRON_HOOK ] = 'pos_connector_five_minutes';
pos_connector_ensure_schedules();
check( 'pos_connector_one_minute' === wp_get_schedule( POS_CONNECTOR_CRON_HOOK ), 'Existing installs must upgrade their fast schedule' );
check( 60 === pos_connector_cron_schedules( array() )['pos_connector_one_minute']['interval'], 'New fast cadence must be one minute' );
$before = count( $cleared );
pos_connector_ensure_schedules();
check( $before === count( $cleared ), 'A current schedule must not be cleared each request' );
check( 120 === POS_Connector_Health::stale_after_seconds(), 'Stale after two missed pulls' );
class RefundFixture {
    private $meta = array();
    function update_meta_data( $key, $value ) { $this->meta[ $key ] = $value; }
    function get_meta( $key, $single ) { return $this->meta[ $key ] ?? ''; }
    function get_items() { return array(); }
    function get_id() { return 91; }
    function get_amount() { return '10'; }
    function get_reason() { return 'test'; }
    function get_date_created() { return null; }
}
$refund = new RefundFixture();
check( null === POS_Connector_Sync::refund_payload( $refund, 90 )['restock_items'], 'Old refunds remain explicitly unknown' );
POS_Connector_Sync::record_refund_restock_intent( $refund, array( 'restock_items' => false ) );
check( false === POS_Connector_Sync::refund_payload( $refund, 90 )['restock_items'], 'Money-only refund never implies restock' );
POS_Connector_Sync::record_refund_restock_intent( $refund, array( 'restock_items' => true ) );
check( true === POS_Connector_Sync::refund_payload( $refund, 90 )['restock_items'], 'Explicit restock survives transport' );
echo "Passed schedule upgrade and refund transport checks\n";
class PublicationDbFixture {
    function prepare( $sql, ...$args ) { return $sql; }
    function get_var( $sql ) { return '1'; }
}
class PublicationProductFixture {
    public $type = 'external';
    function get_meta( ...$args ) { return 'op'; }
    function get_parent_id() { return 0; }
    function get_type() { return $this->type; }
}
$wpdb = new PublicationDbFixture();
$publication_product = new PublicationProductFixture();
function wc_get_product_id_by_sku( $sku ) { return 951; }
function wc_get_product( $id ) { global $publication_product; return $publication_product; }
$publish = new ReflectionMethod( 'POS_Connector_Sync', 'publish_product' );
$payload = array( '__operationId' => 'op', '__wooType' => 'simple', 'sku' => 'reviewed' );
$rejected = false;
try { $publish->invoke( null, $payload ); } catch ( Exception $e ) { $rejected = true; }
check( $rejected, 'Lost-ACK recovery must refuse a changed remote type' );
$publication_product->type = 'simple';
check( 951 === $publish->invoke( null, $payload )['remoteId'], 'Lost-ACK retry reuses the same acknowledged product' );
echo "Passed publication retry type checks\n";
