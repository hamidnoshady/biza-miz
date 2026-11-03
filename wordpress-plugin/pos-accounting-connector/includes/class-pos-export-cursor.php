<?php
/**
 * Where a long export stopped, so the next run continues instead of starting over.
 *
 * Products and customers already work this way (`export_products()` persists a
 * keyset state and schedules its own continuation). Content and orders did not:
 * both walked a bounded slice and then *abandoned* the walk, so a store with a
 * backlog larger than one run re-walked the same head every time and never
 * reached the tail.
 *
 * For orders that was worse than slow — it was a silent starvation. The sweep
 * covered the last N days, one run queued the first 20k orders in that window,
 * logged «باقی‌مانده در اجرای بعدی», and the next run started again at the same
 * `date_modified` boundary. Orders past the ceiling stayed unexported until
 * they aged out of the window, which is precisely the "zero pending jobs, no
 * data" symptom issue #1206 was opened for.
 *
 * The cursor is one non-autoloaded option per kind, and it expires: a walk
 * resumed an hour later would enqueue rows the sweeps since then have already
 * covered, and a stale window is not worth finishing.
 *
 * @package pos-accounting-connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * A bounded, expiring "where was I" record for the content and order exports.
 */
class POS_Connector_Export_Cursor {

	/** Older than this, a cursor describes a walk nobody wants to finish. */
	const MAX_AGE_SECONDS = 3600;

	/** A boundary second with more orders than this is a pathological store. */
	const MAX_SEEN_IDS = 500;

	/**
	 * The stored cursor, if it is fresh and belongs to the same kind of run.
	 *
	 * `$expected` is the list of parameters that define the walk: an order
	 * sweep over a different window, or a content export of a different type,
	 * must not inherit a cursor that means something else. Any mismatch — or an
	 * expired record — restarts the walk, which is always safe.
	 *
	 * @param string $kind     `orders` or `content`.
	 * @param array  $expected Parameters the resumed run must match.
	 * @return array|null
	 */
	public static function resume( $kind, array $expected ) {
		$stored = self::get( $kind );
		if ( null === $stored ) {
			return null;
		}
		if ( time() - (int) $stored['updated_at'] > self::MAX_AGE_SECONDS ) {
			self::clear( $kind );
			return null;
		}
		foreach ( $expected as $key => $value ) {
			if ( ! array_key_exists( $key, $stored ) || (string) $stored[ $key ] !== (string) $value ) {
				self::clear( $kind );
				return null;
			}
		}
		return $stored;
	}

	/**
	 * Read one cursor, tolerating a foreign or corrupt value.
	 *
	 * @param string $kind Cursor kind.
	 * @return array|null
	 */
	public static function get( $kind ) {
		$stored = get_option( self::key( $kind ), false );
		if ( ! is_array( $stored ) || ! isset( $stored['updated_at'] ) ) {
			return null;
		}
		return $stored;
	}

	/**
	 * Record where this run stopped.
	 *
	 * @param string $kind   Cursor kind.
	 * @param array  $cursor Values to remember.
	 * @return void
	 */
	public static function set( $kind, array $cursor ) {
		$cursor['updated_at'] = time();
		// Autoload false: a cursor is read by the scheduled sweep and by nothing
		// else (#1206 PERF, the same rule every other queue option follows).
		update_option( self::key( $kind ), $cursor, false );
	}

	/**
	 * Forget the cursor — the walk finished, or was abandoned.
	 *
	 * @param string $kind Cursor kind.
	 * @return void
	 */
	public static function clear( $kind ) {
		delete_option( self::key( $kind ) );
	}

	/**
	 * Trim the ids of one boundary second to what one option row can hold.
	 *
	 * @param array $ids Order ids.
	 * @return int[]
	 */
	public static function seen_ids( array $ids ) {
		return array_slice( array_values( array_map( 'intval', $ids ) ), 0, self::MAX_SEEN_IDS );
	}

	/**
	 * Option name for a kind.
	 *
	 * @param string $kind Cursor kind.
	 * @return string
	 */
	private static function key( $kind ) {
		return 'pos_connector_export_cursor_' . preg_replace( '/[^a-z_]/', '', strtolower( (string) $kind ) );
	}
}
