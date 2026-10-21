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
		$download = static function () {
			return static function ( $url, $title ) {
				$tmp = wp_tempnam( 'pos-fixture.jpg' );
				copy( DIR_TESTDATA . '/images/canola.jpg', $tmp );
				return media_handle_sideload( array( 'name' => 'pos-fixture.jpg', 'tmp_name' => $tmp ), 0, $title );
			};
		};
		add_action( 'add_attachment', $observe, 20 );
		add_filter( 'pos_media_import_callback', $download );
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
			remove_filter( 'pos_media_import_callback', $download );
			if ( $attachment_id ) {
				wp_delete_attachment( $attachment_id, true );
				$wpdb->delete( $table, array( 'remote_id' => 'attachment:' . $attachment_id ) );
			}
		}
	}
	public function test_failure_between_import_and_meta_rolls_back_attachment_and_event() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';
		POS_Connector_Queue::maybe_install();
		$operation = 'wp-media:crash:' . wp_generate_uuid4();
		$created = array();
		$import = static function () use ( &$created ) {
			return static function () use ( &$created ) {
				$tmp = wp_tempnam( 'rollback.jpg' );
				copy( DIR_TESTDATA . '/images/canola.jpg', $tmp );
				$id = media_handle_sideload( array( 'name' => 'rollback.jpg', 'tmp_name' => $tmp ), 0 );
				$created[] = $id;
				return $id;
			};
		};
		$crash = static function () { throw new RuntimeException( 'simulated_crash_before_meta' ); };
		add_filter( 'pos_media_import_callback', $import );
		add_action( 'pos_media_after_import', $crash );
		$apply = new ReflectionMethod( POS_Connector_Sync::class, 'apply_media_create' );
		$apply->setAccessible( true );
		$payload = array( 'url' => 'https://example.org/rollback.jpg', '__operationId' => $operation );
		try {
			try { $apply->invoke( null, 'crash', $payload ); $this->fail( 'Expected injected crash' ); }
			catch ( RuntimeException $error ) { $this->assertSame( 'simulated_crash_before_meta', $error->getMessage() ); }
			$this->assertNull( $wpdb->get_var( $wpdb->prepare( "SELECT ID FROM {$wpdb->posts} WHERE ID = %d", $created[0] ) ) );
			remove_action( 'pos_media_after_import', $crash );
			$apply->invoke( null, 'crash', $payload );
			$apply->invoke( null, 'crash', $payload );
			$this->assertCount( 2, $created ); // one rolled back, one committed; retry imports nothing.
			$this->assertSame( $operation, get_post_meta( $created[1], '_pos_operation_id', true ) );
		} finally {
			remove_action( 'pos_media_after_import', $crash );
			remove_filter( 'pos_media_import_callback', $import );
			foreach ( $created as $id ) { clean_post_cache( $id ); wp_delete_attachment( $id, true ); }
		}
	}

	public function test_metadata_usage_guard_trash_restore_and_idempotent_retry() {
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';
		$id = self::factory()->attachment->create_upload_object( DIR_TESTDATA . '/images/canola.jpg' );
		$parent = self::factory()->post->create();
		update_post_meta( $parent, '_thumbnail_id', $id );
		$apply = new ReflectionMethod( POS_Connector_Sync::class, 'apply_media_update' );
		$apply->setAccessible( true );
		$revision = POS_Connector_Sync::content_payload( get_post( $id ) )['revision'];
		$command = array( 'attachment_id' => $id, '__operationId' => 'edit:' . wp_generate_uuid4(), 'action' => 'update', 'expected_revision' => $revision, 'fields' => array( 'title' => 'Edited title', 'alt_text' => 'Accessible image', 'caption' => 'Edited caption' ) );
		try {
			$apply->invoke( null, $command );
			$this->assertSame( 'Edited title', get_post( $id )->post_title );
			$this->assertSame( 'Accessible image', get_post_meta( $id, '_wp_attachment_image_alt', true ) );
			$this->assertSame( 'Edited caption', get_post( $id )->post_excerpt );
			// Identical operation retries succeed even with the original revision.
			$apply->invoke( null, $command );
			$command['__operationId'] = 'stale:' . wp_generate_uuid4();
			try { $apply->invoke( null, $command ); $this->fail( 'Stale edit accepted' ); }
			catch ( Exception $error ) { $this->assertSame( 'media_revision_conflict', $error->getMessage() ); }
			$command['expected_revision'] = get_post_meta( $id, '_pos_content_revision', true );
			$command['action'] = 'trash';
			$command['__operationId'] = 'trash:' . wp_generate_uuid4();
			try { $apply->invoke( null, $command ); $this->fail( 'In-use image trashed without acknowledgment' ); }
			catch ( Exception $error ) { $this->assertSame( 'media_in_use', $error->getMessage() ); }
			$command['acknowledge_usage'] = true;
			$apply->invoke( null, $command );
			$this->assertSame( 'trash', get_post_status( $id ) );
			$this->assertFileExists( get_attached_file( $id ) );
			$command['action'] = 'restore';
			$command['__operationId'] = 'restore:' . wp_generate_uuid4();
			$command['expected_revision'] = get_post_meta( $id, '_pos_content_revision', true );
			$apply->invoke( null, $command );
			$this->assertNotSame( 'trash', get_post_status( $id ) );
			$this->assertFileExists( get_attached_file( $id ) );
		} finally { wp_delete_attachment( $id, true ); wp_delete_post( $parent, true ); }
	}

	public function test_snapshot_reads_fresh_locked_rows_not_stale_cached_posts() {
		global $wpdb;
		$id = self::factory()->attachment->create( array( 'post_title' => 'Old cached title', 'post_status' => 'inherit' ) );
		get_post( $id ); // Prime the stale object another request cannot invalidate locally.
		$wpdb->update( $wpdb->posts, array( 'post_title' => 'Concurrently committed title' ), array( 'ID' => $id ) );
		$export = new ReflectionMethod( POS_Connector_Sync::class, 'export_media_snapshot' );
		$export->setAccessible( true );
		try {
			$export->invoke( null );
			$table = POS_Connector_Queue::table_name();
			$json = $wpdb->get_var( $wpdb->prepare( "SELECT payload FROM {$table} WHERE remote_id LIKE %s ORDER BY id DESC LIMIT 1", 'snapshot:%:' . $id ) );
			$payload = json_decode( $json, true );
			$this->assertSame( 'Concurrently committed title', $payload['title']['raw'] );
			$this->assertGreaterThan( (int) $payload['snapshot']['boundary'], (int) $payload['revision'] );
		} finally { clean_post_cache( $id ); wp_delete_attachment( $id, true ); }
	}

}
