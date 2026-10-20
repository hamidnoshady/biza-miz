<?php
/**
 * Run under the WordPress core PHPUnit test bootstrap (WP_UnitTestCase),
 * with this plugin's queue/sync classes loaded. No live network is needed.
 * This exercises the real core importer and add_attachment hook, not PHP stubs.
 */
class POS_Media_Create_Test extends WP_UnitTestCase {
	public function test_hook_payload_precedes_meta_but_fresh_confirmation_and_retry_include_it() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';
		$this->assertTrue( POS_Connector_Queue::maybe_install() );
		$table = POS_Connector_Queue::table_name();
		$operation = 'wp-media:test:' . wp_generate_uuid4();
		$hook_payload = null;
		$attachment_id = 0;
		$observe = static function ( $id ) use ( &$hook_payload, &$attachment_id ) {
			$attachment_id = $id;
			$hook_payload = POS_Connector_Sync::content_payload( get_post( $id ) );
			POS_Connector_Sync::on_attachment_changed( $id );
		};
		$download = static function ( $pre, $args, $url ) {
			if ( 'https://example.org/pos-fixture.jpg' !== $url ) {
				return $pre;
			}
			copy( DIR_TESTDATA . '/images/canola.jpg', $args['filename'] );
			return array( 'headers' => array( 'content-type' => 'image/jpeg' ), 'body' => '', 'response' => array( 'code' => 200, 'message' => 'OK' ) );
		};
		add_action( 'add_attachment', $observe, 20 );
		add_filter( 'pre_http_request', $download, 10, 3 );
		$apply = new ReflectionMethod( POS_Connector_Sync::class, 'apply_media_create' );
		$apply->setAccessible( true );
		try {
			$payload = array( 'url' => 'https://example.org/pos-fixture.jpg', '__operationId' => $operation );
			$apply->invoke( null, 'new-test', $payload );
			$this->assertArrayNotHasKey( 'operation_id', $hook_payload );
			$this->assertGreaterThan( 0, $attachment_id );
			$read = static function () use ( $wpdb, $table, $attachment_id ) {
				return json_decode( $wpdb->get_var( $wpdb->prepare( "SELECT payload FROM {$table} WHERE topic = 'content.updated' AND remote_id = %s AND status = 'pending' ORDER BY id DESC LIMIT 1", 'attachment:' . $attachment_id ) ), true );
			};
			$this->assertSame( $operation, $read()['operation_id'] );
			$this->assertSame( $attachment_id, (int) $read()['id'] );
			// Simulate loss of the entire confirmation and a process restart.
			$wpdb->delete( $table, array( 'remote_id' => 'attachment:' . $attachment_id ) );
			$seen = new ReflectionProperty( POS_Connector_Sync::class, 'seen' );
			$seen->setAccessible( true );
			$seen->setValue( null, array() );
			$apply->invoke( null, 'new-test', $payload );
			$this->assertSame( $operation, $read()['operation_id'] );
			$this->assertCount( 1, get_posts( array( 'post_type' => 'attachment', 'post_status' => 'inherit', 'meta_key' => '_pos_operation_id', 'meta_value' => $operation ) ) );
		} finally {
			remove_action( 'add_attachment', $observe, 20 );
			remove_filter( 'pre_http_request', $download, 10 );
			if ( $attachment_id ) {
				wp_delete_attachment( $attachment_id, true );
				$wpdb->delete( $table, array( 'remote_id' => 'attachment:' . $attachment_id ) );
			}
		}
	}
}
