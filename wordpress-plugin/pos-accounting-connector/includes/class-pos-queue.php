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
	const DB_VERSION = 3;

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
				payload_fingerprint CHAR(64) NOT NULL DEFAULT '',
				sealed TINYINT UNSIGNED NOT NULL DEFAULT 0,
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
				KEY status_updated (status, updated_at),
				KEY topic_remote_id (topic, remote_id, id),
				KEY due_lookup (status, available_at)
			) {$charset};"
		);

		$install_error = (string) $wpdb->last_error;
		$columns = self::table_exists() ? $wpdb->get_col( "SHOW COLUMNS FROM {$table}" ) : array();
		if ( ! in_array( 'payload_fingerprint', $columns, true ) || ! in_array( 'sealed', $columns, true ) ) {
			self::$last_install_error = $install_error ?: ( $wpdb->last_error ?: 'queue_schema_upgrade_incomplete' );
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
	public static function enqueue( $topic, $remote_id, array $payload, $force = false ) {
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

		$encoded = wp_json_encode( $payload );
		if ( false === $encoded ) {
			return 0;
		}

		$fingerprint = '';
		$is_content_state = 'content.updated' === $topic && ! isset( $payload['_snapshot_id'] )
			&& ! isset( $payload['revision'] ) && ! isset( $payload['operation_id'] );
		$is_taxonomy_state = 'catalogue.taxonomy_terms' === $topic && ! isset( $payload['snapshot_id'] );
		if ( $is_content_state || $is_taxonomy_state || in_array( $topic, array( 'product.updated', 'customer.updated', 'order.updated' ), true ) ) {
			// WooCommerce can advance its save timestamp without changing any
			// catalogue data consumed by Bizamiz.
			if ( 'product.updated' === $topic || $is_content_state ) {
				unset( $payload['date_modified'] );
			}
			if ( $is_taxonomy_state ) {
				unset( $payload['generated_at'] );
			}
			$fingerprint = hash( 'sha256', wp_json_encode( $payload ) );
		}
 
		$encoded = self::pack_payload( $encoded );

		$existing = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT id, status, sealed, attempts, payload_fingerprint FROM {$table}
				 WHERE topic = %s AND remote_id = %s ORDER BY id DESC LIMIT 1",
				$topic,
				(string) $remote_id
			),
			ARRAY_A
		);

		$financial = in_array( $topic, array( 'order.created', 'order.updated', 'refund.created' ), true );
		if ( $existing && ! $force
			&& self::unchanged_state_already_queued( $existing, $fingerprint, $financial ) ) {
			return (int) $existing['id'];
		}

		if ( ! $financial && $existing && 'pending' === $existing['status'] && ! $existing['sealed'] && ! $existing['attempts'] ) {
			$updated = $wpdb->update(
				$table,
				array(
					'payload'             => $encoded,
					'payload_fingerprint' => $fingerprint,
					'updated_at'          => $now,
				),
				array( 'id' => $existing['id'], 'status' => 'pending', 'sealed' => 0, 'attempts' => 0 ),
				array( '%s', '%s', '%s' ),
				array( '%d', '%s', '%d', '%d' )
			);
			if ( false === $updated ) {
				return 0;
			}
			if ( $updated || $wpdb->get_var( $wpdb->prepare(
				"SELECT id FROM {$table} WHERE id = %d AND status = 'pending' AND BINARY payload = %s",
				$existing['id'],
				$encoded
			) ) ) {
				return (int) $existing['id'];
			}
		}

		$wpdb->insert(
			$table,
			array(
				'topic'       => $topic,
				'remote_id'   => (string) $remote_id,
				'delivery_id' => wp_generate_uuid4(),
				'payload'     => $encoded,
				'payload_fingerprint' => $fingerprint,
				'status'       => 'pending',
				'attempts'     => 0,
				'created_at'   => $now,
				'updated_at'   => $now,
				'available_at' => $now,
			),
			array( '%s', '%s', '%s', '%s', '%s', '%s', '%d', '%s', '%s', '%s' )
		);
		return (int) $wpdb->insert_id;
	}

	/**
	 * Whether the newest row for an entity already carries this exact state.
	 *
	 * A `pending` row will deliver that state anyway, and a `sent` row is the
	 * proof it was delivered — so neither needs another row. A `failed` or
	 * `dead` row proves the opposite: the state never arrived. Returning false
	 * there makes the producer queue it again, with a fresh delivery id, which
	 * is the retry the row itself can no longer perform. Financial topics are
	 * never collapsed once delivered: each transition keeps its own identity
	 * even when its snapshot happens to match an earlier one.
	 */
	public static function unchanged_state_already_queued( array $existing, $fingerprint, $financial ) {
		$stored = isset( $existing['payload_fingerprint'] ) ? (string) $existing['payload_fingerprint'] : '';
		if ( '' === (string) $fingerprint || (string) $fingerprint !== $stored ) {
			return false;
		}
		if ( 'pending' === $existing['status'] ) {
			return true;
		}
		return 'sent' === $existing['status'] && ! $financial;
	}

	/**
	 * Store compressible text compactly while it is waiting for delivery.
	 * A prefix outside JSON syntax makes the format backwards compatible.
	 */
	public static function pack_payload( $json ) {
		if ( strlen( $json ) < 512 || ! function_exists( 'gzencode' ) ) {
			return $json;
		}
		$compressed = gzencode( $json, 3 );
		if ( false === $compressed ) {
			return $json;
		}
		$packed = 'gzip:' . base64_encode( $compressed );
		return strlen( $packed ) < strlen( $json ) ? $packed : $json;
	}

	/** Old queue rows already contain the plain JSON ready for delivery. */
	public static function unpack_payload( $stored ) {
		if ( 0 !== strpos( $stored, 'gzip:' ) ) {
			return $stored;
		}
		if ( ! function_exists( 'gzdecode' ) ) {
			return false;
		}
		$compressed = base64_decode( substr( $stored, 5 ), true );
		return false === $compressed ? false : @gzdecode( $compressed );
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
				"SELECT candidate.* FROM {$table} candidate
					WHERE candidate.status = 'pending' AND candidate.available_at <= %s
						AND (candidate.topic NOT IN ('product.updated', 'customer.updated', 'order.created', 'order.updated', 'content.updated', 'catalogue.taxonomy_terms') OR NOT EXISTS (
							SELECT 1 FROM {$table} earlier
							WHERE earlier.remote_id = candidate.remote_id
								AND (earlier.topic = candidate.topic OR (
									earlier.topic IN ('order.created', 'order.updated')
									AND candidate.topic IN ('order.created', 'order.updated')
								))
								AND earlier.status = 'pending' AND earlier.id < candidate.id
						))
					ORDER BY candidate.id ASC LIMIT %d",
				$now,
				$limit
			),
			ARRAY_A
		);
	}

	/** Measure queued payloads without printing any customer data. */
	public static function payload_storage_by_topic() {
		if ( ! self::table_exists() ) {
			return array();
		}
		global $wpdb;
		$table = self::table_name();
		$rows = $wpdb->get_results(
			"SELECT status, topic, COUNT(*) AS row_count, SUM(OCTET_LENGTH(payload)) AS stored_bytes
			 FROM {$table} GROUP BY status, topic ORDER BY status, topic",
			ARRAY_A
		);
		if ( '' !== $wpdb->last_error ) {
			return null;
		}
		return array_map(
			static function ( $row ) {
				return array(
					'status'      => $row['status'],
					'topic'       => $row['topic'],
					'rows'        => (int) $row['row_count'],
					'storedBytes' => (int) $row['stored_bytes'],
				);
			},
			$rows
		);
	}

	/**
	 * The physical size InnoDB reports for the queue table (data + indexes).
	 *
	 * `payload_storage_by_topic()` measures the bytes the payload column still
	 * holds; after cleared bodies that can read near zero while the table file
	 * has not been rebuilt yet. This is the number an operator compares against
	 * the disk, and the one that shows a backlog is actually being reclaimed.
	 * Some managed hosts deny `information_schema`; that is `null`, never an
	 * error that breaks `doctor`.
	 */
	public static function table_storage_bytes() {
		if ( ! self::table_exists() ) {
			return null;
		}
		global $wpdb;
		$bytes = $wpdb->get_var(
			$wpdb->prepare(
				'SELECT data_length + index_length FROM information_schema.tables
				  WHERE table_schema = DATABASE() AND table_name = %s',
				self::table_name()
			)
		);
		return null === $bytes ? null : (int) $bytes;
	}

	/**
	 * Housekeeping for delivered and long-abandoned rows.
	 *
	 * Three jobs, each bounded to 1000 rows so one cron run is never held by a
	 * single large statement:
	 *
	 *  - a delivered row no longer needs its body. `mark_sent()` clears every
	 *    new delivery, but a store upgraded from the old schema still carries
	 *    the body in every historical `sent` row — that is where a multi-
	 *    gigabyte queue comes from. Clearing them keeps the delivery record
	 *    (id, delivery id, timestamps, status) and drops only the payload.
	 *  - delivered rows older than a month are deleted: they have served
	 *    their purpose once the app has them, and an e-commerce store
	 *    generates enough of them that keeping every one forever turns a
	 *    support table into the largest one in the database.
	 *  - failed rows older than the platform's 180-day unresolved-failure
	 *    retention are deleted, EXCEPT financial topics and deletion
	 *    tombstones. A permanently rejected catalogue/customer/content
	 *    snapshot is re-derivable by the next resync; a missed sale, or the
	 *    only record that something was deleted, is not.
	 */
	public static function prune() {
		global $wpdb;
		$table = self::table_name();
		// `updated_at < now - 1 day` keeps the scan on the (status, updated_at)
		// index and off the rows mark_sent() just emptied.
		$wpdb->query(
			$wpdb->prepare(
				"UPDATE {$table} SET payload = '' WHERE status = 'sent' AND payload <> '' AND updated_at < %s ORDER BY updated_at, id LIMIT 1000",
				gmdate( 'Y-m-d H:i:s', time() - DAY_IN_SECONDS )
			)
		);
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$table} WHERE status = 'sent' AND updated_at < %s ORDER BY updated_at, id LIMIT 1000",
				gmdate( 'Y-m-d H:i:s', time() - 30 * DAY_IN_SECONDS )
			)
		);
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$table}
				  WHERE status = 'failed'
				    AND topic NOT IN ('order.created', 'order.updated', 'refund.created', 'content.deleted', 'customer.deleted')
				    AND updated_at < %s
				  ORDER BY updated_at, id LIMIT 1000",
				gmdate( 'Y-m-d H:i:s', time() - 180 * DAY_IN_SECONDS )
			)
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

	/**
	 * Freeze a delivery ID before sending it. If checkout or a WooCommerce
	 * hook changed the selected snapshot, the worker reads it again later.
	 */
	public static function seal_for_delivery( array $row ) {
		if ( ! empty( $row['sealed'] ) ) {
			return true;
		}
		global $wpdb;
		$table = self::table_name();
		return 1 === $wpdb->query( $wpdb->prepare(
			"UPDATE {$table} SET sealed = 1
			 WHERE id = %d AND status = 'pending' AND sealed = 0 AND BINARY payload = %s",
			$row['id'],
			$row['payload']
		) );
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
				"UPDATE {$table} SET status = 'sent', payload = '', last_error = NULL, updated_at = %s WHERE status = 'pending' AND id IN ({$placeholders})",
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
					WHERE id = %d AND status = 'pending' AND attempts = %d",
				$next['attempts'],
				(string) $error,
				$next['status'],
				$available,
				current_time( 'mysql', true ),
				(int) $id,
				$before
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
			$out[] = self::format_problem_row( $row );
		}
		return $out;
	}

	/**
	 * One page of the same problem rows the strip shows (issue #1076).
	 *
	 * Keyset on the row id, deliberately NOT the strip's failure ordering: a
	 * page has to walk every row exactly once, and ordering by status would
	 * re-shuffle rows between pages the moment a retry flips one to `pending`.
	 * The id order is stable for the lifetime of a row.
	 *
	 * @param int $after Exclusive lower bound — the `next` of the previous page.
	 * @param int $limit Bounded page size; the app refuses more than 25 too.
	 * @return array{rows:array<int,array<string,mixed>>,next:int|null}
	 */
	public static function page( $after = 0, $limit = 10 ) {
		$empty = array( 'rows' => array(), 'next' => null );
		if ( ! self::table_exists() ) {
			return $empty;
		}
		global $wpdb;
		$table = self::table_name();
		$after = max( 0, (int) $after );
		$limit = max( 1, min( 25, (int) $limit ) );
		// One extra row proves a further page exists without a second query.
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT id, topic, remote_id, status, attempts, last_error, created_at
				   FROM {$table}
				  WHERE status IN ('pending', 'failed') AND id > %d
				  ORDER BY id ASC
				  LIMIT %d",
				$after,
				$limit + 1
			),
			ARRAY_A
		);
		$rows = (array) $rows;
		$has_more = count( $rows ) > $limit;
		if ( $has_more ) {
			$rows = array_slice( $rows, 0, $limit );
		}
		$out  = array();
		$next = null;
		foreach ( $rows as $row ) {
			$out[] = self::format_problem_row( $row );
			$next  = (int) $row['id'];
		}
		return array( 'rows' => $out, 'next' => $has_more ? $next : null );
	}

	/**
	 * The one row shape both the aggregate strip and a paged answer send:
	 * metadata only, never the event payload.
	 *
	 * @param array $row A queue row as ARRAY_A.
	 * @return array<string,mixed>
	 */
	private static function format_problem_row( array $row ) {
		$created = isset( $row['created_at'] ) ? strtotime( $row['created_at'] . ' UTC' ) : false;
		$error   = isset( $row['last_error'] ) ? trim( (string) $row['last_error'] ) : '';
		return array(
			'topic'     => (string) $row['topic'],
			'remoteId'  => (string) $row['remote_id'],
			'status'    => (string) $row['status'],
			'attempts'  => (int) $row['attempts'],
			'lastError' => '' !== $error ? mb_substr( $error, 0, 240, 'UTF-8' ) : null,
			'createdAt' => $created ? gmdate( 'c', $created ) : null,
		);
	}

	/**
	 * Measured delivery latency of this queue, enqueue → app accepted (#1206 P1).
	 *
	 * A `sent` row's `updated_at` is stamped by `mark_sent()` at the moment
	 * the status flips, and `mark_sent()` runs only for delivery IDs the app
	 * answered `processed`, `duplicate` or `deferred`. So the difference is
	 * the time a real event spent between a WooCommerce hook queueing it and
	 * the accounting system accepting it — exactly the «plugin enqueue →
	 * Biza receive → apply/ACK» leg the p95 ≤ 3-minute target is about, and
	 * the only honest way to talk about that target: percentiles over rows
	 * that travelled, with the sample count attached, instead of a promise
	 * derived from the 60s cadence. `deferred` counts as delivered here: the
	 * app has the event and has said so; what it does with it afterwards is
	 * the app's own queue's business (measured there, not guessed here).
	 *
	 * Read-only; cached for ten minutes because telemetry is built every
	 * cycle and a percentile does not move by the minute. `doctor` asks for
	 * a fresh read.
	 *
	 * @param int  $limit Most recent sent rows to measure.
	 * @param bool $fresh Skip the transient cache.
	 * @return array{samples:int,p50Seconds:int,p95Seconds:int,p99Seconds:int,maxSeconds:int}|null Null when nothing has been delivered yet.
	 */
	public static function delivery_latency( $limit = 500, $fresh = false ) {
		$cache_key = 'pos_connector_delivery_latency';
		if ( ! $fresh ) {
			$cached = get_transient( $cache_key );
			if ( is_array( $cached ) && isset( $cached['samples'] ) ) {
				return $cached;
			}
		}
		if ( ! self::table_exists() ) {
			return null;
		}
		global $wpdb;
		$table = self::table_name();
		$limit = max( 1, min( 2000, (int) $limit ) );
		$rows  = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT UNIX_TIMESTAMP(updated_at) - UNIX_TIMESTAMP(created_at)\n				   FROM {$table}\n				  WHERE status = 'sent'\n				  ORDER BY id DESC\n				  LIMIT %d",
				$limit
			)
		);
		$stats = POS_Connector_Health::percentiles( (array) $rows );
		if ( null === $stats ) {
			return null;
		}
		$out = array(
			'samples'    => (int) $stats['samples'],
			'p50Seconds' => (int) round( $stats['p50'] ),
			'p95Seconds' => (int) round( $stats['p95'] ),
			'p99Seconds' => (int) round( $stats['p99'] ),
			'maxSeconds' => (int) round( $stats['max'] ),
		);
		set_transient( $cache_key, $out, 10 * MINUTE_IN_SECONDS );
		return $out;
	}
}
