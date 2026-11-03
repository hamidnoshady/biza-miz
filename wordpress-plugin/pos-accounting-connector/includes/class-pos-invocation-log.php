<?php
/**
 * Bounded, truthful record of the last few scheduler invocations (#1206 P0).
 *
 * `last_run_at` says when a cycle *started*; `last_sync_ok_at` says when one was
 * last verified. Neither can answer the question an owner actually asks when
 * data has stopped moving: «آخرین بارها چه شد؟». A store whose cron ran, failed
 * and was retried four times in a row shows a fresh `last_run_at` and looks
 * perfectly healthy.
 *
 * So every invocation leaves one line: when it started, how long it took, what
 * the verdict was, the exit code a monitoring crontab would have seen, and how
 * much moved. The list is fixed at RECENT_LIMIT entries, stored in a single
 * non-autoloaded option, so this is one row — never a table that grows with the
 * scheduler's cadence.
 *
 * A run that dies mid-flight (fatal error, timeout, killed process) never
 * reaches `finish()`. Its entry stays `running`, and after the lock TTL it is
 * reported as `interrupted` — computed at read time, never rewritten, so the
 * record of what the scheduler did cannot be cleaned up by a later run.
 *
 * @package pos-accounting-connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The last N scheduler invocations, and the verdict/exit-code mapping.
 */
class POS_Connector_Invocation_Log {

	/** Where the ring lives. Not autoloaded: nothing on a front-end request reads it. */
	const OPTION = 'pos_connector_invocations';

	/** How many invocations are kept. */
	const RECENT_LIMIT = 20;

	/** No run legitimately outlives the lock; past this a `running` entry is dead. */
	const STALE_AFTER_SECONDS = 300;

	/** Per-phase detail kept for one invocation before it stops being useful. */
	const MAX_ERRORS = 5;

	/**
	 * Start times of runs this request opened, keyed by invocation id.
	 *
	 * Kept in memory rather than in the option: a millisecond epoch does not fit
	 * a 32-bit integer, and a plugin that silently writes a garbage runtime on a
	 * 32-bit host is worse than one that reports whole seconds there.
	 *
	 * @var array<string,float>
	 */
	private static $started_at = array();

	/**
	 * The exit code a monitoring crontab would see for a verdict.
	 *
	 * `paused` is 0 on purpose: an owner who paused the connector has not had a
	 * failure, and a crontab that alarms on it every minute trains people to
	 * ignore alarms. `partial` is nonzero because a phase did not finish.
	 *
	 * @param string $verdict One of the POS_Connector_Health::PHASE_* values.
	 * @return int
	 */
	public static function exit_code( $verdict ) {
		switch ( (string) $verdict ) {
			case POS_Connector_Health::PHASE_PARTIAL:
				return 1;
			case POS_Connector_Health::PHASE_FAILED:
				return 2;
			case POS_Connector_Health::PHASE_OK:
			case POS_Connector_Health::PHASE_EMPTY:
			case POS_Connector_Health::PHASE_SKIPPED:
			case POS_Connector_Health::PHASE_PAUSED:
				return 0;
			default:
				// An unknown verdict is not a success. Guessing `0` here is how
				// a monitor goes quiet on exactly the run nobody understands.
				return 2;
		}
	}

	/**
	 * How this invocation was started, in the plugin's own vocabulary.
	 *
	 * @return string `wp_cli`, `system_cron` or `wp_cron`.
	 */
	public static function driver() {
		if ( defined( 'WP_CLI' ) && WP_CLI ) {
			return 'wp_cli';
		}
		return pos_connector_uses_system_cron() ? 'system_cron' : 'wp_cron';
	}

	/**
	 * Record the start of an invocation.
	 *
	 * @param array $context Optional `trigger` label (`cron`, `sync`, `manual`).
	 * @return string Invocation id, to be handed back to `finish()`.
	 */
	public static function start( array $context = array() ) {
		$now = microtime( true );
		$id  = 'inv_' . str_replace( '.', '', sprintf( '%.6F', $now ) ) . '_' . wp_rand( 1000, 9999 );
		self::$started_at[ $id ] = $now;
		$entry = array(
			'id'            => $id,
			'startedAt'     => gmdate( 'Y-m-d H:i:s', (int) $now ),
			'startedAtUnix' => (int) $now,
			'driver'      => self::driver(),
			'trigger'     => isset( $context['trigger'] ) ? (string) $context['trigger'] : 'cron',
			'outcome'     => 'running',
		);
		self::push( $entry );
		return $id;
	}

	/**
	 * Close an invocation with what actually happened.
	 *
	 * @param string $id     Id from `start()`.
	 * @param array  $result Stats from the cycle, or a minimal synthetic array.
	 * @return void
	 */
	public static function finish( $id, array $result ) {
		$verdict = isset( $result['verdict'] ) ? (string) $result['verdict'] : '';
		$errors  = array();
		if ( ! empty( $result['locked'] ) ) {
			$errors[] = 'run_locked';
		}
		if ( isset( $result['errors'] ) && is_array( $result['errors'] ) ) {
			$errors = array_merge( $errors, array_map( 'strval', $result['errors'] ) );
		}
		$phases = array();
		if ( isset( $result['phases'] ) && is_array( $result['phases'] ) ) {
			foreach ( $result['phases'] as $phase ) {
				if ( is_array( $phase ) && isset( $phase['phase'], $phase['status'] ) ) {
					$phases[ (string) $phase['phase'] ] = (string) $phase['status'];
				}
			}
		}

		$now     = microtime( true );
		$entries = self::all();
		$found   = false;
		foreach ( $entries as $index => $entry ) {
			if ( ! isset( $entry['id'] ) || $id !== $entry['id'] ) {
				continue;
			}
			$entries[ $index ] = array_merge(
				$entry,
				array(
					'outcome'     => 'completed',
					'completedAt' => gmdate( 'Y-m-d H:i:s', (int) $now ),
					// Measured, not estimated: the number a hoster's slow-cron
					// complaint is actually about. Millisecond precision when
					// this request opened the run, whole seconds when the start
					// came from a previous one.
					'runtimeMs'   => self::runtime_ms( $id, $entry, $now ),
					'verdict'     => $verdict,
					'exitCode'    => self::exit_code( $verdict ),
					'pushed'      => isset( $result['pushed'] ) ? (int) $result['pushed'] : 0,
					'applied'     => isset( $result['applied'] ) ? (int) $result['applied'] : 0,
					'phases'      => $phases,
					'errors'      => array_slice( array_values( array_unique( $errors ) ), 0, self::MAX_ERRORS ),
				)
			);
			$found = true;
			break;
		}

		if ( ! $found ) {
			// Retention swept the start of a very slow run, or the option was
			// cleared mid-flight. Record the outcome anyway rather than lose it.
			$entries[] = array(
				'id'            => $id,
				'startedAt'     => gmdate( 'Y-m-d H:i:s', (int) $now ),
				'startedAtUnix' => (int) $now,
				'driver'      => self::driver(),
				'trigger'     => 'unknown',
				'outcome'     => 'completed',
				'completedAt' => gmdate( 'Y-m-d H:i:s', (int) $now ),
				'runtimeMs'   => null,
				'verdict'     => $verdict,
				'exitCode'    => self::exit_code( $verdict ),
				'pushed'      => isset( $result['pushed'] ) ? (int) $result['pushed'] : 0,
				'applied'     => isset( $result['applied'] ) ? (int) $result['applied'] : 0,
				'phases'      => $phases,
				'errors'      => array_slice( array_values( array_unique( $errors ) ), 0, self::MAX_ERRORS ),
			);
		}

		self::store( $entries );
	}

	/**
	 * The recent invocations, newest first.
	 *
	 * `running` entries older than the lock TTL are reported as `interrupted`
	 * here rather than rewritten: the fact that a run was killed stays in the
	 * record, and the reader decides what it means.
	 *
	 * @param int $limit How many to return (max RECENT_LIMIT).
	 * @return array
	 */
	public static function recent( $limit = self::RECENT_LIMIT ) {
		$limit   = max( 1, min( self::RECENT_LIMIT, (int) $limit ) );
		$entries = self::all();
		$now     = time();
		$out     = array();
		foreach ( array_reverse( $entries ) as $entry ) {
			if ( isset( $entry['outcome'] ) && 'running' === $entry['outcome'] ) {
				$started = isset( $entry['startedAtUnix'] ) ? (int) $entry['startedAtUnix'] : 0;
				if ( $started > 0 && ( $now - $started ) > self::STALE_AFTER_SECONDS ) {
					$entry['outcome']  = 'interrupted';
					$entry['exitCode'] = self::exit_code( POS_Connector_Health::PHASE_FAILED );
				}
			}
			$out[] = $entry;
			if ( count( $out ) >= $limit ) {
				break;
			}
		}
		return $out;
	}

	/**
	 * Count the invocations in the last window that did not exit 0.
	 *
	 * Cheap enough to call from a health summary: bounded array, no queries
	 * beyond the single option read this class already does.
	 *
	 * @param int $seconds Window to look back over.
	 * @return int
	 */
	public static function failures_since( $seconds ) {
		$threshold = time() - max( 0, (int) $seconds );
		$failures  = 0;
		foreach ( self::recent() as $entry ) {
			$started = isset( $entry['startedAtUnix'] ) ? (int) $entry['startedAtUnix'] : 0;
			if ( $started > 0 && $started < $threshold ) {
				continue;
			}
			if ( isset( $entry['exitCode'] ) && 0 !== (int) $entry['exitCode'] ) {
				$failures++;
			}
		}
		return $failures;
	}

	/** Forget the record — used by tests and by an explicit reset. */
	public static function clear() {
		delete_option( self::OPTION );
	}

	/**
	 * How long the invocation took, in milliseconds.
	 *
	 * @param string $id    Invocation id.
	 * @param array  $entry The stored entry.
	 * @param float  $now   Current microtime.
	 * @return int|null Null when the start time is unknown.
	 */
	private static function runtime_ms( $id, array $entry, $now ) {
		if ( isset( self::$started_at[ $id ] ) ) {
			return max( 0, (int) round( ( $now - self::$started_at[ $id ] ) * 1000 ) );
		}
		$started = isset( $entry['startedAtUnix'] ) ? (int) $entry['startedAtUnix'] : 0;
		if ( $started <= 0 ) {
			return null;
		}
		// Whole seconds: the start belonged to a request this one cannot see.
		return max( 0, (int) round( $now ) - $started ) * 1000;
	}

	/**
	 * Read the ring, tolerating a corrupt or foreign value.
	 *
	 * @return array Oldest first.
	 */
	private static function all() {
		$stored = get_option( self::OPTION, array() );
		if ( ! is_array( $stored ) ) {
			return array();
		}
		$entries = array();
		foreach ( $stored as $entry ) {
			if ( is_array( $entry ) && isset( $entry['id'], $entry['startedAt'] ) ) {
				$entries[] = $entry;
			}
		}
		return array_slice( $entries, -self::RECENT_LIMIT );
	}

	/**
	 * Append one entry and trim the ring.
	 *
	 * @param array $entry Entry to add.
	 * @return void
	 */
	private static function push( array $entry ) {
		$entries   = self::all();
		$entries[] = $entry;
		self::store( $entries );
	}

	/**
	 * Persist the ring, oldest first, never autoloaded.
	 *
	 * @param array $entries Entries to keep.
	 * @return void
	 */
	private static function store( array $entries ) {
		$entries = array_slice( array_values( $entries ), -self::RECENT_LIMIT );
		// `false` for autoload: this option is read by the doctor screen and by
		// nothing on a front-end request (#1206 PERF).
		update_option( self::OPTION, $entries, false );
	}
}
