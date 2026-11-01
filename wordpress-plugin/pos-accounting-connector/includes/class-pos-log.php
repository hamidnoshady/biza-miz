<?php
/**
 * The sync log.
 *
 * Separate from the queue on purpose: the queue is *work*, this is *history*.
 * When a shop owner says "the stock is wrong", the question is what this
 * plugin did and when — including the runs where it did nothing, which a
 * work queue by definition does not record.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Log {

	const TABLE = 'pos_connector_log';

	/** Bumped when the log schema changes; with the queue's, it gates `dbDelta()`. */
	const DB_VERSION = 1;

	/** Kept small: this is a diagnostic tail, not an archive. */
	const KEEP_ROWS = 500;

	public static function table_name() {
		global $wpdb;
		return $wpdb->prefix . self::TABLE;
	}

	public static function install_table() {
		global $wpdb;
		$table   = self::table_name();
		$charset = $wpdb->get_charset_collate();

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		dbDelta(
			"CREATE TABLE {$table} (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				level VARCHAR(16) NOT NULL DEFAULT 'info',
				action VARCHAR(64) NOT NULL,
				message TEXT NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY created_at (created_at)
			) {$charset};"
		);
	}

	/**
	 * Mask whatever authorises a request inside a URL that appears in text: the
	 * userinfo and the values of signature/token-like query parameters. A
	 * download URL the app hands this plugin is a credential until it expires,
	 * and an error message ("cURL error 28 … for https://…") echoes it back.
	 * Mirrors src/lib/integrations/url-redact.ts.
	 */
	public static function scrub_urls( $text ) {
		$text = (string) $text;
		if ( false === stripos( $text, 'http' ) ) {
			return $text;
		}
		return preg_replace_callback(
			'~https?://[^\s"\'<>\\^`{|}]+~i',
			static function ( $m ) {
				$url  = $m[0];
				$tail = '';
				if ( preg_match( '~[.,;:!?)\]]+$~', $url, $t ) ) {
					$tail = $t[0];
					$url  = substr( $url, 0, -strlen( $tail ) );
				}
				$url      = preg_replace( '~^(https?://)[^/?#@]*@~i', '$1•••@', $url );
				$fragment = '';
				$hash     = strpos( $url, '#' );
				if ( false !== $hash ) {
					$fragment = substr( $url, $hash );
					$url      = substr( $url, 0, $hash );
				}
				$q = strpos( $url, '?' );
				if ( false !== $q ) {
					$pairs = array();
					foreach ( explode( '&', substr( $url, $q + 1 ) ) as $pair ) {
						$eq   = strpos( $pair, '=' );
						$name = false === $eq ? '' : rawurldecode( substr( $pair, 0, $eq ) );
						if ( false !== $eq && preg_match( '~^(x-amz-.*|x-goog-.*|signature|sig|se|sp|sv|token|access[-_]?token|id[-_]?token|refresh[-_]?token|api[-_]?key|key|secret|credential|password|passwd|auth|authorization|policy|expires)$~i', $name ) ) {
							$pair = substr( $pair, 0, $eq ) . '=•••';
						}
						$pairs[] = $pair;
					}
					$url = substr( $url, 0, $q ) . '?' . implode( '&', $pairs );
				}
				return $url . $fragment . $tail;
			},
			$text
		);
	}

	public static function write( $level, $action, $message = '' ) {
		global $wpdb;
		$wpdb->insert(
			self::table_name(),
			array(
				'level'      => (string) $level,
				'action'     => (string) $action,
				'message'    => self::scrub_urls( is_scalar( $message ) ? (string) $message : wp_json_encode( $message ) ),
				'created_at' => current_time( 'mysql', true ),
			),
			array( '%s', '%s', '%s', '%s' )
		);
	}

	public static function info( $action, $message = '' ) {
		self::write( 'info', $action, $message );
	}

	public static function error( $action, $message = '' ) {
		self::write( 'error', $action, $message );
	}

	public static function recent( $limit = 50 ) {
		global $wpdb;
		$table = self::table_name();
		return $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$table} ORDER BY id DESC LIMIT %d", $limit ),
			ARRAY_A
		);
	}

	/** Trim to the newest KEEP_ROWS. Called from the cron run, so it costs nothing on a page view. */
	public static function prune() {
		global $wpdb;
		$table  = self::table_name();
		$cutoff = $wpdb->get_var(
			$wpdb->prepare( "SELECT id FROM {$table} ORDER BY id DESC LIMIT 1 OFFSET %d", self::KEEP_ROWS )
		);
		if ( $cutoff ) {
			$wpdb->query( $wpdb->prepare( "DELETE FROM {$table} WHERE id <= %d", (int) $cutoff ) );
		}
	}
}
