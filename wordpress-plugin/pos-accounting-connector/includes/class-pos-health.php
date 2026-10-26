<?php
/**
 * Decisions about the plugin's own health, kept free of WordPress calls so
 * they can be tested without WordPress (wordpress-plugin/tests/connector-
 * reliability-policy.php runs them under plain `php`).
 *
 * Three things live here, and each one is the answer to a way this plugin
 * once failed without anybody being told:
 *
 *   - **Is the cron actually running?** WP-Cron only fires on traffic, and a
 *     system crontab that cannot execute its command (an `open_basedir` that
 *     blocks /usr/bin/wp, a missing PATH) still "succeeds" from the
 *     scheduler's point of view. The only honest evidence is that
 *     `POS_Connector_Sync::run()` stopped starting, so staleness is measured
 *     from the last time it started — not from the last time somebody pressed
 *     «آزمایش اتصال», which proves the address and token and nothing about the
 *     schedule.
 *   - **When does a queue row give up?** After exactly MAX_ATTEMPTS attempts.
 *   - **Which two runs may not overlap?** `wp pos-connector sync` and
 *     `wp cron event run --due-now` are both documented, and both end up in
 *     `run()`; a short lock keeps them from leasing the same jobs twice.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Health {

	/** The fast lane's nominal cadence (pos_connector_five_minutes). */
	const FAST_INTERVAL_SECONDS = 300;

	/** The cron counts as stopped after this many fast intervals without a run. */
	const STALE_AFTER_INTERVALS = 3;

	/** How long a crashed run can hold the lock before the next one takes over. */
	const RUN_LOCK_TTL_SECONDS = 300;

	public static function stale_after_seconds() {
		return self::FAST_INTERVAL_SECONDS * self::STALE_AFTER_INTERVALS;
	}

	/** A UTC `Y-m-d H:i:s` string (what current_time('mysql', true) writes) as a timestamp; 0 when empty or unreadable. */
	public static function parse_utc( $value ) {
		if ( ! is_string( $value ) || '' === trim( $value ) ) {
			return 0;
		}
		$ts = strtotime( trim( $value ) . ' UTC' );
		return false === $ts ? 0 : (int) $ts;
	}

	/**
	 * Is the fast lane overdue?
	 *
	 * Measured from the last time `run()` started; a store that was enabled but
	 * has never run is measured from the moment it was armed, so a cron that
	 * never worked is reported too — that is the case this exists for.
	 *
	 * @param array $settings pos_connector_settings().
	 * @param int   $now      Unix timestamp.
	 * @return array{configured:bool,stale:bool,reference_ts:int,age:int,last_run_ts:int}
	 */
	public static function cron_status( array $settings, $now ) {
		$configured = ! empty( $settings['enabled'] ) && ! empty( $settings['base_url'] ) && ! empty( $settings['token'] );
		$last_run   = self::parse_utc( isset( $settings['last_run_at'] ) ? $settings['last_run_at'] : '' );
		$armed      = self::parse_utc( isset( $settings['armed_at'] ) ? $settings['armed_at'] : '' );
		$reference  = $last_run > 0 ? $last_run : $armed;
		$age        = $reference > 0 ? max( 0, (int) $now - $reference ) : 0;
		return array(
			'configured'   => $configured,
			'stale'        => $configured && $reference > 0 && $age > self::stale_after_seconds(),
			'reference_ts' => $reference,
			'age'          => $age,
			'last_run_ts'  => $last_run,
		);
	}

	/**
	 * What a failed delivery attempt does to a queue row.
	 *
	 * @param int $attempts_before Attempts already recorded.
	 * @param int $max_attempts    The queue's give-up point.
	 * @return array{attempts:int,status:string}
	 */
	public static function queue_failure_state( $attempts_before, $max_attempts ) {
		$attempts = max( 0, (int) $attempts_before ) + 1;
		return array(
			'attempts' => $attempts,
			'status'   => $attempts >= (int) $max_attempts ? 'failed' : 'pending',
		);
	}

	/**
	 * Which admin screen a handler should send the user back to: the one the
	 * form was on (its referer's `page`), when that is one of ours.
	 *
	 * @param string|false $referer  wp_get_referer().
	 * @param string[]     $allowed  Our screens' page slugs.
	 * @param string       $fallback The dashboard slug.
	 */
	public static function page_from_referer( $referer, array $allowed, $fallback ) {
		if ( ! is_string( $referer ) || '' === $referer ) {
			return $fallback;
		}
		$query = parse_url( $referer, PHP_URL_QUERY );
		if ( ! is_string( $query ) || '' === $query ) {
			return $fallback;
		}
		parse_str( $query, $args );
		$page = isset( $args['page'] ) && is_string( $args['page'] ) ? $args['page'] : '';
		return in_array( $page, $allowed, true ) ? $page : $fallback;
	}

	/**
	 * Read the answer to the «آزمایش اتصال» ping.
	 *
	 * @param array $response POS_Connector_Client::post()'s return value.
	 * @param int   $local_ts This server's clock, Unix seconds.
	 * @return array{notice:string,detail:string,skew:?int}
	 */
	public static function interpret_ping( array $response, $local_ts ) {
		$data      = isset( $response['data'] ) && is_array( $response['data'] ) ? $response['data'] : array();
		$server_ts = isset( $data['serverTime'] ) && is_string( $data['serverTime'] ) ? strtotime( $data['serverTime'] ) : false;
		$skew      = false === $server_ts ? null : (int) $local_ts - (int) $server_ts;

		if ( ! empty( $response['ok'] ) ) {
			$paused = ( isset( $data['status'] ) && 'paused' === $data['status'] )
				|| ( isset( $data['serverStatus'] ) && 'paused' === $data['serverStatus'] );
			if ( $paused ) {
				return array( 'notice' => 'test_paused', 'detail' => '', 'skew' => $skew );
			}
			// The window is five minutes; a clock that is already two minutes
			// out is the one that fails the next time the traffic is heavy.
			if ( null !== $skew && abs( $skew ) >= 120 ) {
				return array( 'notice' => 'test_clock_skew', 'detail' => (string) abs( $skew ), 'skew' => $skew );
			}
			return array( 'notice' => 'test_ok', 'detail' => '', 'skew' => $skew );
		}

		$error = isset( $response['error'] ) ? (string) $response['error'] : '';
		if ( 'site_mismatch' === $error ) {
			return array(
				'notice' => 'test_site_mismatch',
				'detail' => isset( $data['expectedSiteUrl'] ) && is_string( $data['expectedSiteUrl'] ) ? $data['expectedSiteUrl'] : '',
				'skew'   => $skew,
			);
		}
		if ( 'stale_timestamp' === $error ) {
			return array( 'notice' => 'test_stale_timestamp', 'detail' => null === $skew ? '' : (string) abs( $skew ), 'skew' => $skew );
		}
		return array( 'notice' => 'test_failed', 'detail' => $error, 'skew' => $skew );
	}

	/**
	 * The kinds of button-press jobs still waiting for cron, from WordPress's
	 * cron array (`_get_cron_array()`: timestamp => hook => key => event).
	 *
	 * @param mixed  $cron_array _get_cron_array().
	 * @param string $hook       POS_CONNECTOR_CRON_MANUAL_JOB.
	 * @return string[]
	 */
	public static function queued_manual_jobs( $cron_array, $hook ) {
		$kinds = array();
		if ( ! is_array( $cron_array ) ) {
			return $kinds;
		}
		foreach ( $cron_array as $hooks ) {
			if ( ! is_array( $hooks ) || empty( $hooks[ $hook ] ) || ! is_array( $hooks[ $hook ] ) ) {
				continue;
			}
			foreach ( $hooks[ $hook ] as $event ) {
				if ( isset( $event['args'][0] ) && is_string( $event['args'][0] ) ) {
					$kinds[] = $event['args'][0];
				}
			}
		}
		return array_values( array_unique( $kinds ) );
	}

	/** A recommended crontab line — one line, and the invocation that survives a container's `open_basedir`. */
	public static function system_cron_line( $wp_path ) {
		$path = rtrim( str_replace( '\\', '/', (string) $wp_path ), '/' );
		return '*/5 * * * * wp --path=' . $path . ' cron event run --due-now > /dev/null 2>&1';
	}

	/** The same line for hosts where PHP's open_basedir blocks the `wp` binary (run as root: add --allow-root). */
	public static function system_cron_line_open_basedir( $wp_path ) {
		$path = rtrim( str_replace( '\\', '/', (string) $wp_path ), '/' );
		return '*/5 * * * * php -d open_basedir= /usr/bin/wp --path=' . $path . ' cron event run --due-now > /dev/null 2>&1';
	}
}

/**
 * A lock with an expiry, over a store that can add a key atomically.
 *
 * The store is injectable so the logic is testable without a database; the
 * production store is POS_Connector_Option_Lock_Store (an `INSERT IGNORE` on
 * the options table, which is atomic where `add_option()` is not).
 */
class POS_Connector_Lock {

	/**
	 * @param string $name  Lock key.
	 * @param int    $ttl   Seconds until a crashed holder's lock may be taken over.
	 * @param int    $now   Unix time.
	 * @param object $store add( $key, $value ): bool, get( $key ): ?string, delete_if( $key, $value ): bool.
	 * @return string|false The holder's token, or false while somebody else holds the lock.
	 */
	public static function acquire( $name, $ttl, $now, $store ) {
		$token = bin2hex( random_bytes( 8 ) );
		$value = ( (int) $now + (int) $ttl ) . ':' . $token;
		if ( $store->add( $name, $value ) ) {
			return $token;
		}
		$current = $store->get( $name );
		if ( null !== $current && (int) strtok( $current, ':' ) < (int) $now ) {
			// Only the exact stale value is removed, so a lock somebody took
			// over a moment ago is never deleted by a second taker.
			$store->delete_if( $name, $current );
			if ( $store->add( $name, $value ) ) {
				return $token;
			}
		}
		return false;
	}

	public static function release( $name, $token, $store ) {
		$current = $store->get( $name );
		if ( null !== $current && substr( $current, -strlen( (string) $token ) ) === (string) $token ) {
			return $store->delete_if( $name, $current );
		}
		return false;
	}
}

/** The production lock store: one row in wp_options, created with INSERT IGNORE. */
class POS_Connector_Option_Lock_Store {

	private static function key( $key ) {
		return 'pos_connector_lock_' . sanitize_key( $key );
	}

	public function add( $key, $value ) {
		global $wpdb;
		$inserted = $wpdb->query(
			$wpdb->prepare(
				"INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')",
				self::key( $key ),
				$value
			)
		);
		return 1 === (int) $inserted;
	}

	public function get( $key ) {
		global $wpdb;
		$value = $wpdb->get_var(
			$wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", self::key( $key ) )
		);
		return null === $value ? null : (string) $value;
	}

	public function delete_if( $key, $value ) {
		global $wpdb;
		return 1 === (int) $wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$wpdb->options} WHERE option_name = %s AND option_value = %s",
				self::key( $key ),
				$value
			)
		);
	}
}
