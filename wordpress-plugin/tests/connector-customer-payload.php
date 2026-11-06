<?php
/** Run with: php wordpress-plugin/tests/connector-customer-payload.php */
define( 'ABSPATH', __DIR__ );
function get_userdata( $id ) { return (object) array( 'roles' => array( 'customer' ) ); }
function get_user_meta( $id, $key, $single ) { return 0; }
require dirname( __DIR__ ) . '/pos-accounting-connector/includes/class-pos-sync.php';

$customer = new class {
	public function get_id() { return 812; }
	public function get_date_modified() { return null; }
	public function get_email() { return '09332443370@zaniziba.com'; }
	public function get_first_name() { return ''; }
	public function get_last_name() { return ''; }
	public function get_billing_first_name() { return 'سارا'; }
	public function get_billing_last_name() { return 'محمدی'; }
	public function get_billing_phone() { return '09332443370'; }
	public function get_billing_address_1() { return ''; }
	public function get_billing_city() { return ''; }
};
$payload = POS_Connector_Sync::customer_payload( $customer );
$expected = array( 'first_name' => 'سارا', 'last_name' => 'محمدی', 'phone' => '09332443370' );
foreach ( $expected as $key => $value ) {
	if ( ( $payload['billing'][ $key ] ?? null ) !== $value ) {
		fwrite( STDERR, "FAILED: customer billing $key was lost\n" );
		exit( 1 );
	}
}
if ( $payload['email'] !== '09332443370@zaniziba.com' || $payload['first_name'] !== '' ) {
	fwrite( STDERR, "FAILED: account contact/name fields changed\n" );
	exit( 1 );
}
echo "PASS: 4 customer payload checks\n";
