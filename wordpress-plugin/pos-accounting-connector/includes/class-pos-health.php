<?php
/**
 * Decisions about the plugin's own health, kept free of WordPress calls so
 * they can be tested without WordPress (wordpress-plugin/tests/connector-
 * reliability-policy.php runs them under plain `php`).
 *
 * Three things live here, and each one is the answer to a way this plugin
 * once failed without anybody being told:
 *
 *   - **Is the cron actually running, and did the cycle work?** WP-Cron only
 *     fires on traffic, and a system crontab that cannot execute its command
 *     (an `open_basedir` that blocks /usr/bin/wp, a missing PATH) still
 *     "succeeds" from the scheduler's point of view. The only honest evidence
 *     that the scheduler runs is that `POS_Connector_Sync::run()` started, and
 *     the only honest evidence that the *sync* worked is a cycle in which
 *     every phase reported success (#1206). Those are two different facts and
 *     this file keeps them apart: `cron_state()` grades the scheduler from the
 *     last start, `cycle_verdict()` grades the work from structured phase
 *     results. Neither is ever inferred from «آزمایش اتصال», which proves the
 *     address and token and nothing about the schedule.
 *   - **When does a queue row give up?** After exactly MAX_ATTEMPTS attempts.
 *   - **Which two runs may not overlap?** `wp pos-connector sync` and
 *     `wp cron event run --due-now` are both documented, and both end up in
 *     `run()`; a short lock keeps them from leasing the same jobs twice.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Health {

	/** The fast lane's nominal cadence (pos_connector_one_minute). */
	const FAST_INTERVAL_SECONDS = 60;

	/** The cron counts as stopped after this many fast intervals without a run. */
	const STALE_AFTER_INTERVALS = 2;

	/**
	 * «کند» — a scheduler we still believe in, but which dropped some ticks.
	 *
	 * Three intervals, not two: a shared host serving a queued crontab that
	 * starts 100–170s apart is ordinary, and #1149's two-interval threshold
	 * called that an outage. Three missed starts is a pattern, not a hiccup.
	 */
	const DELAYED_AFTER_INTERVALS = 3;

	/**
	 * «اجرا نمی‌شود» — no start for ten minutes is a failure at any cadence.
	 *
	 * This is the alerting floor (#1206 P1): the grace above only *warns*.
	 */
	const CRITICAL_AFTER_SECONDS = 600;

	/** How long a crashed run can hold the lock before the next one takes over. */
	const RUN_LOCK_TTL_SECONDS = 300;

	/** Structured phase outcomes (#1206 P0) — never collapse two of these into `0`. */
	const PHASE_OK      = 'ok';
	const PHASE_EMPTY   = 'empty';
	const PHASE_PARTIAL = 'partial';
	const PHASE_FAILED  = 'failed';
	const PHASE_SKIPPED = 'skipped';
	const PHASE_PAUSED  = 'paused';

	public static function stale_after_seconds() {
		return self::FAST_INTERVAL_SECONDS * self::STALE_AFTER_INTERVALS;
	}

	/** Past this age the scheduler is «کند» but not yet failed. */
	public static function delayed_after_seconds() {
		return self::FAST_INTERVAL_SECONDS * self::DELAYED_AFTER_INTERVALS;
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
	 * The scheduler's *current* state, as one word plus the reason for it.
	 *
	 * `stale` (2 intervals) is kept exactly as #1149 defined it, because the
	 * admin screen, `wp pos-connector status` and the monitoring crontab all
	 * regress against it. On top of it sit the two verdicts #1206 asked for:
	 * «کند» after DELAYED_AFTER_INTERVALS missed starts, «اجرا نمی‌شود» after
	 * CRITICAL_AFTER_SECONDS. `test_only` is the honest answer for a store
	 * whose only evidence is a button press: a ping proves the token, not the
	 * schedule.
	 *
	 * @param array $settings pos_connector_settings().
	 * @param int   $now      Unix timestamp.
	 * @return array{configured:bool,state:string,reason:string,stale:bool,delayed:bool,failed:bool,missedIntervals:int,reference_ts:int,age:int,last_run_ts:int,last_verified_ts:int,last_ping_ts:int}
	 */
	public static function cron_state( array $settings, $now ) {
		$now        = (int) $now;
		$configured = ! empty( $settings['enabled'] ) && ! empty( $settings['base_url'] ) && ! empty( $settings['token'] );
		$last_run   = self::parse_utc( isset( $settings['last_run_at'] ) ? $settings['last_run_at'] : '' );
		$armed      = self::parse_utc( isset( $settings['armed_at'] ) ? $settings['armed_at'] : '' );
		$verified   = self::parse_utc( isset( $settings['last_sync_ok_at'] ) ? $settings['last_sync_ok_at'] : '' );
		$ping       = self::parse_utc( isset( $settings['last_ping_ok_at'] ) ? $settings['last_ping_ok_at'] : '' );
		$reference  = $last_run > 0 ? $last_run : $armed;
		$age        = $reference > 0 ? max( 0, $now - $reference ) : 0;
		$missed     = $reference > 0 ? (int) floor( $age / self::FAST_INTERVAL_SECONDS ) : 0;
		// A run that the app paused writes `last_run_stats['paused']`; any
		// later real cycle overwrites it. So this is the *last* cycle's say.
		$paused     = ! empty( $settings['last_run_stats']['paused'] );

		$state  = 'unknown';
		$reason = 'not_configured';
		if ( $configured ) {
			if ( $paused ) {
				$state  = 'paused';
				$reason = 'paused_by_app';
			} elseif ( $reference > 0 ) {
				if ( $age > self::CRITICAL_AFTER_SECONDS ) {
					$state  = 'failed';
					$reason = $last_run > 0 ? 'no_start_since' : 'never_ran';
				} elseif ( $age > self::delayed_after_seconds() ) {
					$state  = 'delayed';
					$reason = 'missed_starts';
				} else {
					$state  = 'healthy';
					$reason = $last_run > 0 ? 'recent_start' : 'awaiting_first_run';
				}
			} elseif ( $ping > 0 && ( $now - $ping ) <= self::delayed_after_seconds() ) {
				// Configured, never armed and never run, but somebody pressed
				// «آزمایش اتصال» a moment ago: the link works, the cron is
				// unproven. Calling that healthy is the bug this exists for.
				$state  = 'test_only';
				$reason = 'ping_without_cron';
			} else {
				$state  = 'failed';
				$reason = 'never_ran';
			}
		}

		return array(
			'configured'        => $configured,
			'state'             => $state,
			'reason'            => $reason,
			'stale'             => $configured && $reference > 0 && $age > self::stale_after_seconds(),
			'delayed'           => 'delayed' === $state,
			'failed'            => 'failed' === $state,
			'missedIntervals'   => $missed,
			'reference_ts'      => $reference,
			'age'               => $age,
			'last_run_ts'       => $last_run,
			'last_verified_ts'  => $verified,
			'last_ping_ts'      => $ping,
		);
	}

	/**
	 * Is the fast lane overdue? (#1149's contract, unchanged.)
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
		$state = self::cron_state( $settings, $now );
		return array(
			'configured'   => $state['configured'],
			'stale'        => $state['stale'],
			'reference_ts' => $state['reference_ts'],
			'age'          => $state['age'],
			'last_run_ts'  => $state['last_run_ts'],
		);
	}

	/**
	 * One phase's outcome, structured (#1206 P0).
	 *
	 * `push_queue()` used to return `0` for "nothing to send" *and* for "the
	 * app did not answer", so `run_locked()` could not tell an idle queue from
	 * a dead link and wrote a success timestamp for both. This is the shape
	 * that makes them different.
	 *
	 * @param string $name        push|pull|ack …
	 * @param string $status      One of the PHASE_* constants.
	 * @param int    $duration_ms Wall time spent in the phase.
	 * @param array  $counts      Named counters (sent, applied, failed, jobs, rounds…).
	 * @param string $error       Sanitized reason; empty on success.
	 * @return array{phase:string,status:string,durationMs:int,counts:array<string,int>,error:string}
	 */
	public static function phase( $name, $status, $duration_ms, array $counts = array(), $error = '' ) {
		$allowed = array( self::PHASE_OK, self::PHASE_EMPTY, self::PHASE_PARTIAL, self::PHASE_FAILED, self::PHASE_SKIPPED, self::PHASE_PAUSED );
		$clean   = array();
		foreach ( $counts as $key => $value ) {
			$clean[ substr( (string) $key, 0, 20 ) ] = (int) $value;
		}
		return array(
			'phase'      => substr( (string) $name, 0, 20 ),
			'status'     => in_array( $status, $allowed, true ) ? $status : self::PHASE_FAILED,
			'durationMs' => max( 0, (int) $duration_ms ),
			'counts'     => $clean,
			'error'      => substr( (string) $error, 0, 200 ),
		);
	}

	/**
	 * What all of one run's phases add up to.
	 *
	 * `verified` is the only thing allowed to move `last_sync_ok_at`: no phase
	 * failed or half-applied. A phase that was deliberately skipped (the app
	 * paused, or absolute stock writes held back behind a local backlog) does
	 * not fail the cycle — it is an explicit decision, recorded in the phase
	 * list so the screen can say so.
	 *
	 * @param array $phases List of `phase()` results.
	 * @return array{status:string,verified:bool,dataMoved:int,errors:string[]}
	 */
	public static function cycle_verdict( array $phases ) {
		$rank     = array(
			self::PHASE_EMPTY   => 0,
			self::PHASE_OK      => 1,
			self::PHASE_SKIPPED => 1,
			self::PHASE_PARTIAL => 2,
			self::PHASE_FAILED  => 3,
			self::PHASE_PAUSED  => 1,
		);
		$worst    = null;
		$statuses = array();
		$data     = 0;
		$errors   = array();
		foreach ( $phases as $phase ) {
			if ( ! is_array( $phase ) || empty( $phase['status'] ) ) {
				continue;
			}
			$status     = (string) $phase['status'];
			$statuses[] = $status;
			if ( ! empty( $phase['error'] ) ) {
				$errors[] = (string) $phase['error'];
			}
			if ( isset( $rank[ $status ] ) && ( null === $worst || $rank[ $status ] > $rank[ $worst ] ) ) {
				$worst = $status;
			}
			// Only `sent` and `applied` are movement: a batch count, a job count
			// or an attempt count is not data reaching the other side.
			if ( is_array( $phase['counts'] ) ) {
				foreach ( array( 'sent', 'applied' ) as $key ) {
					if ( isset( $phase['counts'][ $key ] ) ) {
						$data += max( 0, (int) $phase['counts'][ $key ] );
					}
				}
			}
		}

		if ( null === $worst ) {
			$status = self::PHASE_FAILED;
			$errors = array( 'no_phases' );
		} elseif ( 1 === count( array_unique( $statuses ) ) && self::PHASE_PAUSED === $statuses[0] ) {
			$status = self::PHASE_PAUSED;
		} else {
			$status = $worst;
		}

		return array(
			'status'    => $status,
			'verified'  => in_array( $status, array( self::PHASE_OK, self::PHASE_EMPTY, self::PHASE_SKIPPED ), true ),
			'dataMoved' => $data,
			'errors'    => array_slice( array_values( array_unique( $errors ) ), 0, 5 ),
		);
	}

	/**
	 * Start-of-run bookkeeping for the *historical* record (#1206 P0-3).
	 *
	 * The run that ends a silence is the one that knows about it, and it must
	 * not advertise that silence as the current state — the old code did, so a
	 * recovered store showed «زمان‌بند مدتی اجرا نشده بود» until some later
	 * report. Instead the gap becomes an incident with a start time, closed by
	 * `note_cycle()` once a cycle is actually verified.
	 *
	 * @param array $settings Settings as they were before this run started.
	 * @param array $state    `cron_state()` of those settings.
	 * @param int   $now      Unix timestamp.
	 * @return array Settings changes, possibly empty.
	 */
	public static function note_attempt( array $settings, array $state, $now ) {
		if ( ! in_array( $state['state'], array( 'failed', 'delayed' ), true ) ) {
			return array();
		}
		if ( ! empty( $settings['incident_open'] ) ) {
			// Already recorded; a second start inside the same outage must not
			// restamp it, or the incident would look ongoing forever.
			return array();
		}
		return array(
			'incident_open'            => true,
			'incident_at'              => gmdate( 'Y-m-d H:i:s', (int) $now ),
			'incident_gap_seconds'     => (int) $state['age'],
			'incident_previous_state'  => (string) $state['state'],
			'incident_recovered_at'    => '',
		);
	}

	/**
	 * End-of-run bookkeeping: close an open incident only on a verified cycle.
	 *
	 * @param array  $settings Settings as they are now.
	 * @param array  $verdict  `cycle_verdict()` of this run.
	 * @param string $now_iso  This run's completion stamp (UTC `Y-m-d H:i:s`).
	 * @return array Settings changes, possibly empty.
	 */
	public static function note_cycle( array $settings, array $verdict, $now_iso ) {
		if ( empty( $settings['incident_open'] ) || empty( $verdict['verified'] ) ) {
			return array();
		}
		return array(
			'incident_open'         => false,
			'incident_recovered_at' => (string) $now_iso,
		);
	}

	/**
	 * How long a queued probe may sit before «کرون این را اجرا نکرد» is the
	 * answer (#1206 P0). Ten minutes is generous on any host and still short
	 * enough that the person who pressed the button sees the verdict.
	 */
	const PROBE_EXPIRY_SECONDS = 600;

	/**
	 * What the cron probe has actually proven so far.
	 *
	 * The button's whole point is that queuing proves nothing: `wp_schedule_
	 * single_event()` returning true only means WordPress recorded an event.
	 * Evidence appears in order —
	 *
	 *   queued   → WordPress accepted the event, nothing has run;
	 *   executed → a *separate* scheduler invocation entered the callback;
	 *   reported → that invocation's signed telemetry reached the app;
	 *   expired  → the event was queued and never ran: the scheduler is not
	 *              executing due events, which is the finding, not a failure
	 *              of the probe;
	 *   failed   → the event ran but the report did not leave (network,
	 *              token, clock).
	 *
	 * @param array $probe The stored `cron_probe` record.
	 * @param int   $now   Unix timestamp.
	 * @return array{state:string,reason:string,age:int,expiresIn:int}
	 */
	public static function probe_state( $probe, $now ) {
		$empty = array( 'state' => 'none', 'reason' => 'no_probe', 'age' => 0, 'expiresIn' => 0 );
		if ( ! is_array( $probe ) || empty( $probe['id'] ) ) {
			return $empty;
		}
		$now      = (int) $now;
		$queued   = self::parse_utc( isset( $probe['queued_at'] ) ? $probe['queued_at'] : '' );
		$executed = self::parse_utc( isset( $probe['executed_at'] ) ? $probe['executed_at'] : '' );
		$reported = self::parse_utc( isset( $probe['reported_at'] ) ? $probe['reported_at'] : '' );
		$age      = $queued > 0 ? max( 0, $now - $queued ) : 0;
		$left     = max( 0, self::PROBE_EXPIRY_SECONDS - $age );
		$found    = array( 'age' => $age, 'expiresIn' => $left );

		if ( $reported > 0 ) {
			return array( 'state' => 'reported', 'reason' => 'telemetry_sent' ) + $found;
		}
		if ( ! empty( $probe['error'] ) ) {
			return array( 'state' => 'failed', 'reason' => (string) $probe['error'] ) + $found;
		}
		if ( $executed > 0 ) {
			return array( 'state' => 'executed', 'reason' => 'scheduler_ran_it' ) + $found;
		}
		if ( $queued > 0 && $age > self::PROBE_EXPIRY_SECONDS ) {
			return array( 'state' => 'expired', 'reason' => 'queued_but_never_executed' ) + $found;
		}
		return array( 'state' => 'queued', 'reason' => 'awaiting_scheduler' ) + $found;
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

	/**
	 * Look at a lock without taking it — `wp pos-connector doctor` (#1206 P0).
	 *
	 * A lock held far past its lease is the signature of a run that died
	 * mid-flight (fatal, timeout, container restart), and that is exactly the
	 * case where «صف خالی است» and «کرون اجرا نمی‌شود» look identical from
	 * outside. Reading it must not acquire, renew or release anything.
	 *
	 * @param string $name  Lock key.
	 * @param object $store The same store contract as `acquire()`.
	 * @param int    $now   Unix time.
	 * @return array{held:bool,expires_ts:int|null,seconds_left:int|null,expired:bool}
	 */
	public static function peek( $name, $store, $now ) {
		$current = $store->get( $name );
		if ( null === $current || '' === $current ) {
			return array( 'held' => false, 'expires_ts' => null, 'seconds_left' => null, 'expired' => false );
		}
		$expires = (int) strtok( $current, ':' );
		return array(
			'held'         => true,
			'expires_ts'   => $expires,
			'seconds_left' => $expires - (int) $now,
			'expired'      => $expires < (int) $now,
		);
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
