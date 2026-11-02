<?php
/**
 * The plugin's outbound queue.
 *
 * Nothing is sent from inside a WooCommerce hook. A hook fires during
 * checkout, in the customer's request, and an HTTP call to another host there
 * would put that host's latency — and its outages — directly into the
 * checkout. So a hook writes one row here and returns; the cron run sends it.
 *
 * That also gives the retry story for free: an order that could not be
 * delivered while the accounting system was down is still in this table when
 * it comes back, which is the difference between "the sale is recorded late"
 * and "the sale is lost".
 *
 * Each row carries a `delivery_id` generated once, at enqueue time, and reused
 * on every retry — that is the idempotency key the app dedups on, so a
 * re-send after a timeout can never double-post a sale.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Queue {

	const TABLE = 'pos_connector_queue';

	/**
	 * Bumped when the queue schema changes; stored in `pos_connector_db_version`
	 * together with the log's, and the pair is what gates `dbDelta()`.
	 *
	 * 2 added `topic_remote_status`: the enqueue de-duplication reads
	 * `(topic, remote_id, status)`, which the existing keys could not serve. Not
	 * unique — the same product legitimately has a `sent` row from yesterday and
	 * a `pending` one from today, and two `sent` rows once it is sent twice.
	 */
	const DB_VERSION = 2;

	/** Set when `install_table()` fails so admin notices can surface `$wpdb->last_error`. */
	private static $last_install_error = '';

	/** Give up after this many tries and leave the row for an operator to see. */
	const MAX_ATTEMPTS = 8;

	/**
	 * Exponential backoff between attempts: 1, 2, 4, 8 … minutes, capped.
	 *
	 * Without it a row that cannot be delivered is retried on every single
	 * cron run — eight attempts inside forty minutes, each one spending a
	 * slot in the batch on a row that has already failed seven times, while
	 * the events behind it wait their turn.
	 */
	const BACKOFF_BASE_SECONDS = 60;
	const BACKOFF_MAX_SECONDS  = 3600;

	public static function table_name() {
		global $wpdb;
		return $wpdb->prefix . self::TABLE;
	}

	public static function last_install_error() {
		return self::$last_install_error;
	}

	/** Per-request memo of the `SHOW TABLES` answer; `null` until it has been asked. */
	private static $table_present = null;

	/**
	 * Whether the queue table exists.
	 *
	 * Asked once per request, not once per call: a catalogue import enqueues
	 * hundreds of rows through the same request, and `SHOW TABLES` is a query
	 * each time. `install_table()` clears the memo, so a table created inside
	 * this request is visible to the next call.
	 */
	public static function table_exists() {
		if ( null !== self::$table_present ) {
			return self::$table_present;
		}
		global $wpdb;
		$table = self::table_name();
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		self::$table_present = ( $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $table ) ) ) === $table );
		return self::$table_present;
	}

	/**
	 * Create the queue table when missing (activation, upgrade, or first enqueue).
	 *
	 * @return bool True when the table is present after this call.
	 */
	public static function maybe_install() {
		if ( self::table_exists() ) {
			self::$last_install_error = '';
			return true;
		}
		return self::install_table();
	}

	public static function install_table() {
		global $wpdb;
		self::$table_present = null;
		$table   = self::table_name();
		$charset = $wpdb->get_charset_collate();

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		self::$last_install_error = '';
		// dbDelta() cannot parse SQL line comments; they break CREATE TABLE on some hosts.
		dbDelta(
			"CREATE TABLE {$table} (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				topic VARCHAR(64) NOT NULL,
				remote_id VARCHAR(64) NOT NULL DEFAULT '',
				delivery_id VARCHAR(64) NOT NULL,
				payload LONGTEXT NOT NULL,
				status VARCHAR(16) NOT NULL DEFAULT 'pending',
				attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
				last_error TEXT NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				available_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY delivery_id (delivery_id),
				KEY topic_remote_status (topic, remote_id, status),
				KEY status_created (status, created_at),
				KEY due_lookup (status, available_at)
			) {$charset};"
		);

		if ( ! self::table_exists() ) {
			self::$last_install_error = $wpdb->last_error ? (string) $wpdb->last_error : __( 'جدول صف ساخته نشد.', 'pos-accounting-connector' );
			return false;
		}
		return true;
	}

	/**
	 * Queue one event.
	 *
	 * Keyed on (topic, remote_id) while still pending: a product saved five
	 * times in a minute is one pending row carrying the latest state, not five
	 * that each cost a round trip to say the same thing. An already-sent row is
	 * never touched — it is the record that the earlier state *was* delivered.
	 */
	public static function enqueue( $topic, $remote_id, array $payload ) {
		if ( ! self::table_exists() && ! self::maybe_install() ) {
			POS_Connector_Log::error(
				'queue',
				sprintf(
					'صف در دسترس نیست؛ رویداد %s:%s ذخیره نشد. %s',
					(string) $topic,
					(string) $remote_id,
					self::$last_install_error
				)
			);
			return 0;
		}

		global $wpdb;
		$table = self::table_name();
		$now   = current_time( 'mysql', true );

		$existing = $wpdb->get_var(
			$wpdb->prepare(
				"SELECT id FROM {$table} WHERE topic = %s AND remote_id = %s AND status = 'pending' LIMIT 1",
				$topic,
				(string) $remote_id
			)
		);

		if ( $existing ) {
			$wpdb->update(
				$table,
				array(
					'payload'    => wp_json_encode( $payload ),
					'updated_at' => $now,
				),
				array( 'id' => $existing ),
				array( '%s', '%s' ),
				array( '%d' )
			);
			return (int) $existing;
		}

		$wpdb->insert(
			$table,
			array(
				'topic'       => $topic,
				'remote_id'   => (string) $remote_id,
				'delivery_id' => wp_generate_uuid4(),
				'payload'     => wp_json_encode( $payload ),
				'status'       => 'pending',
				'attempts'     => 0,
				'created_at'   => $now,
				'updated_at'   => $now,
				'available_at' => $now,
			),
			array( '%s', '%s', '%s', '%s', '%s', '%d', '%s', '%s', '%s' )
		);
		return (int) $wpdb->insert_id;
	}

	/**
	 * The next batch to send: pending rows whose backoff has expired, oldest
	 * first, so events reach the app in the order they happened.
	 */
	public static function due( $limit = 50 ) {
		if ( ! self::table_exists() ) {
			return array();
		}
		global $wpdb;
		$table = self::table_name();
		$now   = current_time( 'mysql', true );
		return $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$table}
					WHERE status = 'pending' AND available_at <= %s
					ORDER BY id ASC LIMIT %d",
				$now,
				$limit
			),
			ARRAY_A
		);
	}

	/** How many rows are waiting their turn, for the admin screen's summary. */
	public static function deferred_count() {
		if ( ! self::table_exists() ) {
			return 0;
		}
		global $wpdb;
		$table = self::table_name();
		$now   = current_time( 'mysql', true );
		return (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$table} WHERE status = 'pending' AND available_at > %s",
				$now
			)
		);
	}

	public static function mark_sent( array $ids ) {
		if ( empty( $ids ) ) {
			return;
		}
		global $wpdb;
		$table        = self::table_name();
		$placeholders = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$params       = array_merge( array( current_time( 'mysql', true ) ), array_map( 'intval', $ids ) );
		$wpdb->query(
			$wpdb->prepare(
				"UPDATE {$table} SET status = 'sent', last_error = NULL, updated_at = %s WHERE id IN ({$placeholders})",
				$params
			)
		);
	}

	/**
	 * Record a failed attempt, giving up after MAX_ATTEMPTS.
	 *
	 * A failed row is left in the table rather than deleted: "this order never
	 * reached the accounting system, and here is why" is exactly what someone
	 * reconciling a missing sale needs to find.
	 *
	 * The backoff is the bug fix behind this method's shape: 1.1.x flipped the
	 * status back to 'pending' but never moved `available_at`, so a row the
	 * app rejected (a malformed order, an unresolved variation) was due again
	 * on the very next sweep, sat at the head of `due()` — which is ordered by
	 * id ASC — and failed again every five minutes for up to eight attempts.
	 * Every event queued behind it waited while the same bad row consumed the
	 * batch slot. The exponential backoff (the same constants the comment on
	 * BACKOFF_BASE_SECONDS describes) moves the bad row out of the way, so the
	 * hundreds of good events behind it flow; `due()` already refuses rows
	 * whose time has not come.
	 */
	public static function mark_failed( $id, $error ) {
		global $wpdb;
		$table    = self::table_name();
		$before   = self::attempts_of( $id );
		$delay    = min(
			self::BACKOFF_MAX_SECONDS,
			self::BACKOFF_BASE_SECONDS * pow( 2, $before )
		);
		$available = gmdate( 'Y-m-d H:i:s', time() + $delay );
		// The attempt count and the verdict are decided together, in PHP. The
		// single UPDATE this replaces assigned `attempts = attempts + 1` and
		// then tested `attempts + 1 >= MAX` in the same statement; MySQL
		// evaluates SET assignments left to right, so the test saw the new
		// count and a row gave up one attempt early (seven, not eight).
		$next = POS_Connector_Health::queue_failure_state( $before, self::MAX_ATTEMPTS );
		$wpdb->query(
			$wpdb->prepare(
				"UPDATE {$table}
					SET attempts = %d,
						last_error = %s,
						status = %s,
						available_at = %s,
						updated_at = %s
					WHERE id = %d",
				$next['attempts'],
				(string) $error,
				$next['status'],
				$available,
				current_time( 'mysql', true ),
				(int) $id
			)
		);
	}

	/** A queue row's current attempt count, so the backoff can grow per row. */
	private static function attempts_of( $id ) {
		global $wpdb;
		$table = self::table_name();
		$attempts = $wpdb->get_var(
			$wpdb->prepare( "SELECT attempts FROM {$table} WHERE id = %d", (int) $id )
		);
		return max( 0, (int) $attempts );
	}

	/** Put a permanently-failed row back in line — the "retry" button on the admin screen. */
	public static function retry_failed() {
		global $wpdb;
		$table = self::table_name();
		$now   = current_time( 'mysql', true );
		return (int) $wpdb->query(
			$wpdb->prepare(
				"UPDATE {$table} SET status = 'pending', attempts = 0, last_error = NULL, available_at = %s, updated_at = %s WHERE status = 'failed'",
				$now,
				$now
			)
		);
	}

	/**
	 * The oldest still-unsent row, for the backlog age in `doctor` and telemetry.
	 *
	 * Age is the whole point: a queue of five rows from ten minutes ago is an
	 * outage, a queue of five hundred from ten seconds ago is a catalogue
	 * export in progress. Read-only.
	 *
	 * @return string|null UTC `Y-m-d H:i:s`, or null when nothing is waiting.
	 */
	public static function oldest_pending_at() {
		if ( ! self::table_exists() ) {
			return null;
		}
		global $wpdb;
		$table = self::table_name();
		$value = $wpdb->get_var( "SELECT MIN(created_at) FROM {$table} WHERE status IN ('pending', 'failed')" );
		return null === $value ? null : (string) $value;
	}

	/** Counts by status, for the admin screen's summary line. */
	public static function counts() {
		if ( ! self::table_exists() ) {
			return array(
				'pending' => 0,
				'sent'    => 0,
				'failed'  => 0,
			);
		}
		global $wpdb;
		$table = self::table_name();
		$rows  = $wpdb->get_results( "SELECT status, COUNT(*) AS total FROM {$table} GROUP BY status", ARRAY_A );
		$out   = array(
			'pending' => 0,
			'sent'    => 0,
			'failed'  => 0,
		);
		foreach ( (array) $rows as $row ) {
			$out[ $row['status'] ] = (int) $row['total'];
		}
		return $out;
	}

	/**
	 * The per-event problem list behind the app's queue screen (issue #942, F12).
	 *
	 * Aggregate counts alone cannot answer "why did THIS order never arrive?",
	 * so the heartbeat carries the failed rows and the oldest pending ones —
	 * topic, remote id, attempts and the last error. Metadata only, never
	 * payloads: enough to identify the stuck event without shipping customer
	 * data through a health ping.
	 */
	public static function recent_problems( $limit = 10 ) {
		if ( ! self::table_exists() ) {
			return array();
		}
		global $wpdb;
		$table = self::table_name();
		$limit = max( 1, min( 25, (int) $limit ) );
		$rows  = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT topic, remote_id, status, attempts, last_error, created_at
				   FROM {$table}
				  WHERE status IN ('pending', 'failed')
				  ORDER BY FIELD(status, 'failed', 'pending'), created_at ASC, id ASC
				  LIMIT %d",
				$limit
			),
			ARRAY_A
		);
		$out = array();
		foreach ( (array) $rows as $row ) {
			$created = strtotime( $row['created_at'] . ' UTC' );
			$error   = isset( $row['last_error'] ) ? trim( (string) $row['last_error'] ) : '';
			$out[] = array(
				'topic'     => (string) $row['topic'],
				'remoteId'  => (string) $row['remote_id'],
				'status'    => (string) $row['status'],
				'attempts'  => (int) $row['attempts'],
				'lastError' => '' !== $error ? mb_substr( $error, 0, 240, 'UTF-8' ) : null,
				'createdAt' => $created ? gmdate( 'c', $created ) : null,
			);
		}
		return $out;
	}

	/**
	 * Drop delivered rows older than a month.
	 *
	 * They have served their purpose once the app has them, and an e-commerce
	 * store generates enough of them that keeping every one forever turns a
	 * support table into the largest one in the database.
	 */
	public static function prune() {
		global $wpdb;
		$table = self::table_name();
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$table} WHERE status = 'sent' AND updated_at < %s",
				gmdate( 'Y-m-d H:i:s', time() - 30 * DAY_IN_SECONDS )
			)
		);
	}
}
